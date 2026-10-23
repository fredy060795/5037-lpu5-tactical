"""Tests for security.py."""

import hashlib

import security as sec


def test_pbkdf2_and_legacy_hashes():
    h = sec.hash_password("Geheim123!")
    assert h.startswith("pbkdf2_sha256$") and h != sec.hash_password("Geheim123!")  # salted
    assert sec.verify_password("Geheim123!", h) and not sec.verify_password("geheim123!", h)
    legacy = hashlib.sha256(b"password").hexdigest()
    assert sec.verify_password("password", legacy) and sec.needs_rehash(legacy) and not sec.needs_rehash(h)


def test_password_rules():
    assert sec.password_problem("kurz")
    assert sec.password_problem("password")
    assert sec.password_problem("alpha123", "alpha123")
    assert sec.password_problem("Lage-Nord-2026") is None


def test_secret_is_created_once(tmp_path, monkeypatch):
    monkeypatch.delenv("LPU5_JWT_SECRET", raising=False)
    a = sec.load_or_create_secret(str(tmp_path))
    assert len(a) >= 32 and sec.load_or_create_secret(str(tmp_path)) == a
    monkeypatch.setenv("LPU5_JWT_SECRET", "x" * 40)
    assert sec.load_or_create_secret(str(tmp_path)) == "x" * 40


def test_login_limiter():
    lim = sec.LoginLimiter(limit=3, window=60)
    for _ in range(3):
        assert lim.blocked("1.2.3.4", "alpha") is None
        lim.failed("1.2.3.4", "alpha")
    assert lim.blocked("1.2.3.4", "Alpha") > 0
    assert lim.blocked("1.2.3.5", "alpha") is None
    lim.succeeded("1.2.3.4", "alpha")
    assert lim.blocked("1.2.3.4", "alpha") is None


def policy(users, settings=None):
    tokens = {"admin": {"username": "admin"}, "user": {"username": "user"}, "media": {"username": "user", "scope": "media"},
              "flagged": {"username": "flagged"}}
    return sec.SecurityPolicy(decode=tokens.get, lookup_user=users.get, settings=lambda: settings or {})


USERS = {"admin": {"role": "admin", "is_active": True}, "user": {"role": "user", "is_active": True},
         "flagged": {"role": "user", "is_active": True, "must_change_password": True}}


def test_writes_need_token_except_public():
    p = policy(USERS)
    ext = "10.0.0.9"
    assert p.check("POST", "/api/drawings", ext, None, "")[0] == 401
    assert p.check("POST", "/api/drawings", ext, "user", "header") is None
    assert p.check("POST", "/api/login_user", ext, None, "") is None
    assert p.check("POST", "/api/federation/handshake/init", ext, None, "") is None
    assert p.check("POST", "/api/drawings", "127.0.0.1", None, "") is None  # local services
    assert p.check("GET", "/api/map_markers", ext, None, "") is None
    assert policy(USERS, {"require_auth_for_reads": True}).check("GET", "/api/map_markers", ext, None, "")[0] == 401
    assert p.check("GET", "/static/x.js", ext, None, "") is None


def test_admin_areas_and_flags():
    p = policy(USERS)
    ext = "10.0.0.9"
    assert p.check("PUT", "/api/users/42/change-password", ext, "user", "header")[0] == 403
    assert p.check("PUT", "/api/users/42/change-password", ext, "admin", "header") is None
    assert p.check("POST", "/api/drawings", ext, "flagged", "header") == (403, "PASSWORD_CHANGE_REQUIRED")
    assert p.check("POST", "/api/change_password", ext, "flagged", "header") is None
    assert p.check("POST", "/api/eud/wipe", ext, "user", "header")[0] == 403
    assert p.check("POST", "/api/eud/wipe/confirm", ext, "user", "header") is None


def test_media_tokens_limited_to_media_paths():
    p = policy(USERS)
    ext = "10.0.0.9"
    assert p.check("POST", "/api/drawings", ext, "media", "header")[0] == 401
    assert p.check("GET", "/api/video/streams/vs-1/mjpeg", ext, "media", "query") is None
    # a session token in the URL is not accepted for normal API writes
    assert p.check("POST", "/api/drawings?token=user", ext, "user", "query")[0] == 401


def test_static_files_allow_list(tmp_path):
    base = tmp_path / "lpu5"
    (base / "vendor" / "leaflet").mkdir(parents=True)
    (base / "radio_log").mkdir()
    for f in ["index.html", "config.json", "secret.key", "api.py", "tactical.db", "manifest.json",
              "vendor/leaflet/leaflet.js", "radio_log/funklog.sqlite3", "lpu5-ca-key.pem", "users_db.json"]:
        (base / f).write_text("x")
    (tmp_path / "outside.html").write_text("x")
    ok = lambda p: sec.static_path_allowed(str(base), p) is not None
    assert ok("index.html") and ok("manifest.json") and ok("vendor/leaflet/leaflet.js")
    for bad in ["config.json", "secret.key", "api.py", "tactical.db", "radio_log/funklog.sqlite3",
                "lpu5-ca-key.pem", "users_db.json", "../outside.html", "vendor/../../outside.html", ".git/config"]:
        assert not ok(bad), bad
