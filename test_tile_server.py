"""Tests for tile_server.py (no internet needed)."""

import io
import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

import tile_server as ts


def png(color):
    buf = io.BytesIO()
    Image.new("RGB", (256, 256), color).save(buf, "PNG")
    return buf.getvalue()


def make(tmp_path):
    t = ts.TileServer(str(tmp_path))
    t.online_fail_until = 1e18  # offline
    return t


def test_tile_math():
    assert ts.lon2tile(13.405, 10) == 550 and ts.lat2tile(52.52, 10) == 335
    assert ts.count_tiles(52.4, 13.2, 52.6, 13.6, 10, 10) == len(list(ts.tiles_in_bounds(52.4, 13.2, 52.6, 13.6, 10, 10)))


def test_cache_and_parent_fallback(tmp_path):
    t = make(tmp_path)
    t._store(t._path("osm", 5, 10, 12), png((255, 0, 0)))
    data, media, origin = t.get_tile("osm", 5, 10, 12)
    assert origin == "cache" and media == "image/png"
    # zoom 7 below the cached zoom-5 tile -> scaled fallback, never empty
    data, media, origin = t.get_tile("osm", 7, 41, 49)
    assert origin == "fallback" and Image.open(io.BytesIO(data)).size == (256, 256)
    assert t.get_tile("osm", 7, 0, 0)[0] is None
    assert t.get_tile("osm", 3, 99, 0)[0] is None  # outside the world
    assert t.get_tile("nope", 1, 0, 0)[0] is None


def test_mbtiles_source(tmp_path):
    t = make(tmp_path)
    db = sqlite3.connect(tmp_path / "maps" / "einsatz raum.mbtiles")
    db.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
    db.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
    db.executemany("INSERT INTO metadata VALUES (?,?)", [("name", "Einsatzraum"), ("maxzoom", "14"), ("format", "png")])
    db.execute("INSERT INTO tiles VALUES (2, 1, 2, ?)", (png((0, 255, 0)),))  # TMS row 2 at z2 == XYZ y 1
    db.commit()
    db.close()
    ids = {s["id"]: s for s in t.list_sources()}
    assert "einsatz_raum" in ids and ids["einsatz_raum"]["name"] == "Einsatzraum"
    assert t.get_tile("einsatz_raum", 2, 1, 1)[2] == "mbtiles"
    assert t.get_tile("einsatz_raum", 4, 4, 5)[2] == "fallback"


def test_http(tmp_path):
    t = make(tmp_path)
    t._store(t._path("topo", 3, 4, 2), png((0, 0, 255)))
    app = FastAPI()
    app.include_router(ts.create_router(t, lambda auth: auth == "Bearer admin"))
    c = TestClient(app)
    r = c.get("/tiles/topo/3/4/2.png")
    assert r.status_code == 200 and r.headers["x-lpu5-tile"] == "cache"
    assert c.get("/tiles/osm/3/4/2").status_code == 404
    body = {"source": "osm", "bounds": {"south": 52, "west": 13, "north": 52.1, "east": 13.1}, "minz": 1, "maxz": 3}
    assert c.post("/api/tiles/prefetch", json=body).status_code == 403
    huge = dict(body, bounds={"south": -60, "west": -170, "north": 70, "east": 170}, maxz=12)
    assert c.post("/api/tiles/prefetch", json=huge, headers={"Authorization": "Bearer admin"}).status_code == 400
    assert any(s["id"] == "osm" for s in c.get("/api/tiles/sources").json()["sources"])
