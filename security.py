#!/usr/bin/env python3
"""
security.py - Authentication hardening for LPU5 Tactical

* Per-installation JWT secret (secret.key or LPU5_JWT_SECRET) instead of a
  key hard-coded in the public source.
* Salted PBKDF2 password hashes; legacy unsalted SHA-256 hashes still verify
  and are upgraded on the next successful login.
* HTTP middleware:
    - every state-changing /api call needs a valid token (except onboarding,
      login and server-to-server endpoints, and calls from localhost)
    - admin-only areas (users, config, permissions, federation, ...)
    - accounts flagged "must change password" can only change the password
    - optional token requirement for reads
* Short-lived media tokens for URLs (<img>, <audio>, downloads), so the
  long-lived session token does not end up in URLs and server logs.
* Login rate limiting.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
import threading
import time
from typing import Any, Callable, Dict, Optional, Tuple

logger = logging.getLogger("lpu5-security")

PBKDF2_ITERATIONS = 310_000
DEFAULT_PASSWORDS = {"password", "admin", "administrator", "123456", "lpu5"}
MIN_PASSWORD_LENGTH = 8


# ---------------------------------------------------------------------------
# Secrets and passwords
# ---------------------------------------------------------------------------

def load_or_create_secret(base_path: str) -> str:
    env = os.environ.get("LPU5_JWT_SECRET")
    if env:
        return env
    path = os.path.join(base_path, "secret.key")
    try:
        with open(path, "r", encoding="utf-8") as f:
            value = f.read().strip()
            if len(value) >= 32:
                return value
    except FileNotFoundError:
        pass
    value = secrets.token_urlsafe(48)
    with open(path, "w", encoding="utf-8") as f:
        f.write(value)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    logger.info("Generated new JWT secret in %s (all previous sessions are invalid)", path)
    return value


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    if not stored or password is None:
        return False
    if stored.startswith("pbkdf2_sha256$"):
        try:
            _, iterations, salt_b64, hash_b64 = stored.split("$")
            dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), base64.b64decode(salt_b64), int(iterations))
            return hmac.compare_digest(dk, base64.b64decode(hash_b64))
        except (ValueError, TypeError):
            return False
    # Legacy: unsalted SHA-256 hex
    return hmac.compare_digest(hashlib.sha256(password.encode("utf-8")).hexdigest(), stored)


def needs_rehash(stored: str) -> bool:
    return not (stored or "").startswith(f"pbkdf2_sha256${PBKDF2_ITERATIONS}$")


USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$")


def username_problem(username: str) -> Optional[str]:
    """Usernames are also TAK/certificate names: 2–32 letters, digits, . _ -"""
    if not USERNAME_RE.match(username or ""):
        return "Benutzername: 2–32 Zeichen, nur Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich"
    return None


def password_problem(password: str, username: str = "") -> Optional[str]:
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        return f"Passwort muss mindestens {MIN_PASSWORD_LENGTH} Zeichen haben"
    if password.lower() in DEFAULT_PASSWORDS or (username and password.lower() == username.lower()):
        return "Dieses Passwort ist zu leicht zu erraten"
    return None


# ---------------------------------------------------------------------------
# Login rate limiting
# ---------------------------------------------------------------------------

class LoginLimiter:
    """Max `limit` failed logins per (ip, username) within `window` seconds."""

    def __init__(self, limit: int = 8, window: float = 300.0):
        self.limit, self.window = limit, window
        self.failures: Dict[Tuple[str, str], list] = {}
        self.lock = threading.Lock()

    def _recent(self, key) -> list:
        now = time.time()
        items = [t for t in self.failures.get(key, []) if now - t < self.window]
        self.failures[key] = items
        return items

    def blocked(self, ip: str, username: str) -> Optional[int]:
        with self.lock:
            items = self._recent((ip, username.lower()))
            if len(items) >= self.limit:
                return int(self.window - (time.time() - items[0])) + 1
        return None

    def failed(self, ip: str, username: str):
        with self.lock:
            self._recent((ip, username.lower())).append(time.time())

    def succeeded(self, ip: str, username: str):
        with self.lock:
            self.failures.pop((ip, username.lower()), None)


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# Endpoints that must work without a session (login, onboarding, server-to-
# server protocols with their own authentication).
PUBLIC_WRITE = [
    r"^/api/login_user$",
    r"^/api/logout$",
    r"^/api/register_user$",
    r"^/api/qr/join$",
    r"^/api/registration_qr/use$",
    r"^/api/tak_logins/(auth_claim|claim|trusted_register|generate_p12)$",  # own checks
    r"^/api/federation/(handshake/(init|respond|complete)|ingest|sync)$",
    r"^/api/change_password$",  # checks the old password itself
]

# Areas only admins/operators may change.
ADMIN_WRITE = [
    r"^/api/users(/|$)",
    r"^/api/groups(/|$)",
    r"^/api/permissions(/|$)",
    r"^/api/config(/|$)",
    r"^/api/tak_mgmt(/|$)",
    r"^/api/tak_login_settings$",
    r"^/api/tak_logins(/|$)",
    r"^/api/cleanup_mesh_databases$",
    r"^/api/federation/servers(/|$)",
    r"^/api/approve_registration$",
    r"^/api/reject_registration$",
    r"^/api/video/settings$",
    r"^/api/eud/wipe$",
]

# Reads only admins/operators may see (personal data of other people).
ADMIN_READ = [
    r"^/api/pending_registrations$",
]

# Paths where a short-lived media token is accepted.
MEDIA_PATHS = [
    r"^/api/video/streams/[^/]+/(mjpeg|snapshot\.jpg)$",
    r"^/api/radio/(audio/\d+|export\.txt)$",
    r"^/api/sdr/audio$",
    r"^/api/tak/(packages/[0-9a-fA-F]+|export\.zip|connection-package)$",
]

# Reads that stay public even when reads require a token.
PUBLIC_READ = [
    r"^/api/tls/info$",
    r"^/api/me$",
    r"^/api/websocket/status$",
]

ALLOWED_DURING_PASSWORD_CHANGE = [r"^/api/change_password$", r"^/api/logout$", r"^/api/me$"]


def _match(path: str, patterns) -> bool:
    return any(re.search(p, path) for p in patterns)


def extract_token(request) -> Tuple[Optional[str], str]:
    auth = request.headers.get("authorization") or ""
    if auth:
        return (auth[7:].strip() if auth.lower().startswith("bearer ") else auth.strip()), "header"
    q = request.query_params.get("token")
    return (q, "query") if q else (None, "")


class SecurityPolicy:
    def __init__(self, decode: Callable[[str], Optional[Dict[str, Any]]],
                 lookup_user: Callable[[str], Optional[Dict[str, Any]]],
                 settings: Callable[[], Dict[str, Any]]):
        self.decode = decode
        self.lookup_user = lookup_user
        self.settings = settings
        self._cache: Dict[str, Tuple[float, Optional[Dict[str, Any]]]] = {}

    def user(self, username: str) -> Optional[Dict[str, Any]]:
        hit = self._cache.get(username)
        if hit and time.time() - hit[0] < 30:
            return hit[1]
        u = self.lookup_user(username)
        self._cache[username] = (time.time(), u)
        return u

    def invalidate(self, username: str):
        self._cache.pop(username, None)

    def check(self, method: str, path: str, client_ip: str, token: Optional[str],
              token_source: str) -> Optional[Tuple[int, str]]:
        """Return (status, message) to reject the request, or None to allow it."""
        if not path.startswith("/api/"):
            return None
        cfg = self.settings() or {}
        write = method.upper() in WRITE_METHODS
        local = client_ip in ("127.0.0.1", "::1", "localhost")
        payload = self.decode(token) if token else None

        if payload and payload.get("scope") == "media" and not _match(path, MEDIA_PATHS):
            return 401, "Medien-Token gilt nur für Video/Audio/Downloads"
        if payload and token_source == "query" and payload.get("scope") != "media" \
                and not _match(path, MEDIA_PATHS) and not cfg.get("allow_session_token_in_url", False):
            payload = None  # full session tokens are not accepted in URLs for API calls

        if write:
            if _match(path, PUBLIC_WRITE) or (local and cfg.get("trust_localhost", True)):
                return None
            if path == "/api/cot/ingest" and cfg.get("allow_unauthenticated_cot_ingest", False):
                return None
            if not payload:
                return 401, "Anmeldung erforderlich"
        else:
            if not payload:
                if _match(path, ADMIN_READ) and not (local and cfg.get("trust_localhost", True)):
                    return 401, "Anmeldung erforderlich"
                if cfg.get("require_auth_for_reads", False) and not _match(path, PUBLIC_READ) and not local:
                    return 401, "Anmeldung erforderlich"
                return None

        u = self.user(payload.get("username", "")) if payload else None
        if payload and u is None:
            return 401, "Benutzer unbekannt"
        if u and not u.get("is_active", True):
            return 403, "Benutzerkonto deaktiviert"
        if u and u.get("must_change_password") and not _match(path, ALLOWED_DURING_PASSWORD_CHANGE):
            if write or path.startswith("/api/"):
                return 403, "PASSWORD_CHANGE_REQUIRED"
        if not write and _match(path, ADMIN_READ) and (u or {}).get("role") not in ("admin", "operator"):
            return 403, "Nur für Administratoren"
        if write and _match(path, ADMIN_WRITE) and (u or {}).get("role") not in ("admin", "operator"):
            # Users may still change their own profile and password via the self-service endpoints.
            if not re.search(r"^/api/users/(me|self)(/|$)", path):
                return 403, "Nur für Administratoren"
        return None


def install(app, policy: SecurityPolicy):
    """Register the HTTP middleware on a FastAPI app."""
    from fastapi.responses import JSONResponse

    @app.middleware("http")
    async def lpu5_security(request, call_next):
        token, source = extract_token(request)
        ip = request.client.host if request.client else ""
        verdict = policy.check(request.method, request.url.path, ip, token, source)
        if verdict:
            status, message = verdict
            return JSONResponse(status_code=status, content={"status": "error", "message": message,
                                                             "detail": message})
        return await call_next(request)


# ---------------------------------------------------------------------------
# Static file filter
# ---------------------------------------------------------------------------

STATIC_ALLOWED_EXT = {
    ".html", ".htm", ".js", ".mjs", ".css", ".map", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".webp", ".avif", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".webmanifest", ".wasm", ".mp3", ".wav",
    ".ogg", ".mp4", ".webm", ".pdf", ".txt", ".jfif", ".kml", ".kmz", ".gpx", ".geojson",
}
# JSON files the web UI may load directly; everything else (databases,
# config with TAK passwords, tokens) stays private.
STATIC_ALLOWED_JSON = {"manifest.json", "symbol_definitions.json", "example_geofences.json",
                       "example_autonomous_rules.json"}
STATIC_DENY_PARTS = {".git", ".github", ".venv", "venv", "__pycache__", "node_modules", "radio_log",
                     "data_packages", "warteschlange", "modelle", "models", "logs"}
STATIC_DENY_NAMES = {"secret.key", "key.pem", "cert.pem", "lpu5-ca-key.pem", "lpu5-ca.pem",
                     "install_log.txt", "requirements.txt"}


def static_path_allowed(base_path: str, rel_path: str) -> Optional[str]:
    """Return the absolute file path if `rel_path` may be served, else None."""
    if not rel_path or "\x00" in rel_path:
        return None
    base = os.path.realpath(base_path)
    full = os.path.realpath(os.path.join(base, rel_path.lstrip("/")))
    if not full.startswith(base + os.sep):
        return None  # path traversal
    parts = os.path.relpath(full, base).replace("\\", "/").split("/")
    if any(p in STATIC_DENY_PARTS or (p.startswith(".") and p not in (".well-known",)) for p in parts):
        return None
    name = parts[-1]
    if name.lower() in STATIC_DENY_NAMES:
        return None
    ext = os.path.splitext(name)[1].lower()
    if ext == ".json":
        return full if name in STATIC_ALLOWED_JSON or parts[0] in ("eud", "assets", "pwa", "vendor") else None
    if ext not in STATIC_ALLOWED_EXT:
        return None
    if name.lower().endswith(".txt") and parts[0] not in ("eud", "assets", "vendor"):
        return None
    return full
