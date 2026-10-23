#!/usr/bin/env python3
"""
tile_server.py - Map tiles for the whole TOC network, also without internet

All LPU5 pages and EUDs load map tiles from the LPU5 server instead of the
internet:

    /tiles/{source}/{z}/{x}/{y}

* Online sources (OSM, OpenTopoMap, Esri imagery, dark) are fetched once and
  cached on disk (tile_cache/). Every later request – from any device in the
  WLAN – is served from the cache, also when the internet link is gone.
* MBTiles files placed in maps/ are served directly as source
  "<filename without .mbtiles>" (e.g. maps/einsatzraum.mbtiles ->
  /tiles/einsatzraum/{z}/{x}/{y}).
* Areas can be pre-loaded before a mission (POST /api/tiles/prefetch).
* A missing tile falls back to the nearest cached parent tile (cropped and
  scaled), so zooming in past the cached levels never shows grey.
"""

from __future__ import annotations

import io
import math
import os
import re
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import APIRouter, Body, Header, HTTPException
from fastapi.responses import Response

import logging
logger = logging.getLogger("lpu5-tiles")

SOURCES: Dict[str, Dict[str, Any]] = {
    "osm": {"name": "OpenStreetMap", "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png", "max": 19, "ext": "png"},
    "topo": {"name": "OpenTopoMap", "url": "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", "max": 17, "ext": "png",
             "sub": "abc"},
    "sat": {"name": "Satellit (Esri)",
            "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            "max": 19, "ext": "jpg"},
    "dark": {"name": "Dunkel (Carto)", "url": "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", "max": 19,
             "ext": "png", "sub": "abcd"},
}
USER_AGENT = "LPU5-Tactical-TileCache/1.0 (+offline TOC map cache)"
MAX_PREFETCH_TILES = 60000


def lon2tile(lon: float, z: int) -> int:
    return int((lon + 180.0) / 360.0 * (1 << z))


def lat2tile(lat: float, z: int) -> int:
    r = math.radians(max(-85.0511, min(85.0511, lat)))
    return int((1.0 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2.0 * (1 << z))


def tiles_in_bounds(south: float, west: float, north: float, east: float, minz: int, maxz: int):
    for z in range(minz, maxz + 1):
        x0, x1 = lon2tile(west, z), lon2tile(east, z)
        y0, y1 = lat2tile(north, z), lat2tile(south, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                yield z, x, y


def count_tiles(south, west, north, east, minz, maxz) -> int:
    n = 0
    for z in range(minz, maxz + 1):
        n += (lon2tile(east, z) - lon2tile(west, z) + 1) * (lat2tile(south, z) - lat2tile(north, z) + 1)
    return n


class TileServer:
    def __init__(self, base_path: str):
        self.cache_dir = os.path.join(base_path, "tile_cache")
        self.maps_dir = os.path.join(base_path, "maps")
        os.makedirs(self.cache_dir, exist_ok=True)
        os.makedirs(self.maps_dir, exist_ok=True)
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.online_fail_until = 0.0
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self._mb_lock = threading.Lock()
        self._mb_conns: Dict[str, sqlite3.Connection] = {}

    # -- sources --

    def mbtiles_sources(self) -> Dict[str, Dict[str, Any]]:
        out = {}
        for f in sorted(os.listdir(self.maps_dir)):
            if f.lower().endswith(".mbtiles"):
                sid = re.sub(r"[^a-zA-Z0-9_-]", "_", f[:-8])
                out[sid] = {"name": f[:-8], "file": os.path.join(self.maps_dir, f), "mbtiles": True}
        return out

    def list_sources(self) -> List[Dict[str, Any]]:
        res = [{"id": k, "name": v["name"], "max_zoom": v["max"], "kind": "online-cache",
                "url": f"/tiles/{k}/{{z}}/{{x}}/{{y}}"} for k, v in SOURCES.items()]
        for k, v in self.mbtiles_sources().items():
            meta = self._mb_meta(v["file"])
            res.append({"id": k, "name": meta.get("name") or v["name"], "kind": "mbtiles",
                        "max_zoom": int(meta.get("maxzoom") or 18), "min_zoom": int(meta.get("minzoom") or 0),
                        "bounds": meta.get("bounds"), "url": f"/tiles/{k}/{{z}}/{{x}}/{{y}}"})
        return res

    # -- MBTiles --

    def _mb(self, path: str) -> sqlite3.Connection:
        with self._mb_lock:
            c = self._mb_conns.get(path)
            if c is None:
                c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
                self._mb_conns[path] = c
            return c

    def _mb_meta(self, path: str) -> Dict[str, str]:
        try:
            with self._mb_lock:
                rows = self._mb(path).execute("SELECT name, value FROM metadata").fetchall() if path in self._mb_conns \
                    else None
            if rows is None:
                rows = self._mb(path).execute("SELECT name, value FROM metadata").fetchall()
            return {k: v for k, v in rows}
        except Exception:
            return {}

    def _mb_tile(self, path: str, z: int, x: int, y: int) -> Optional[bytes]:
        tms_y = (1 << z) - 1 - y
        try:
            conn = self._mb(path)
            with self._mb_lock:
                row = conn.execute("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                                   (z, x, tms_y)).fetchone()
            return bytes(row[0]) if row else None
        except Exception as e:
            logger.debug("mbtiles read %s: %s", path, e)
            return None

    # -- cache --

    def _path(self, source: str, z: int, x: int, y: int) -> str:
        ext = SOURCES.get(source, {}).get("ext", "png")
        return os.path.join(self.cache_dir, source, str(z), str(x), f"{y}.{ext}")

    def _fetch(self, source: str, z: int, x: int, y: int, timeout: float = 8.0) -> Optional[bytes]:
        if time.time() < self.online_fail_until:
            return None  # internet recently unreachable – don't stall every request
        src = SOURCES[source]
        url = src["url"].replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
        if "{s}" in url:
            url = url.replace("{s}", src.get("sub", "a")[(x + y) % len(src.get("sub", "a"))])
        try:
            r = self.session.get(url, timeout=timeout)
            if r.status_code == 200 and r.content:
                return r.content
            return None
        except requests.RequestException:
            self.online_fail_until = time.time() + 30
            return None

    def get_tile(self, source: str, z: int, x: int, y: int) -> Tuple[Optional[bytes], str, str]:
        """Return (data, media_type, origin) where origin is cache|online|mbtiles|fallback."""
        if z < 0 or z > 22 or x < 0 or y < 0 or x >= (1 << z) or y >= (1 << z):
            return None, "", ""
        mb = self.mbtiles_sources().get(source)
        if mb:
            data = self._mb_tile(mb["file"], z, x, y)
            if data:
                return data, _sniff(data), "mbtiles"
            return self._fallback(lambda zz, xx, yy: self._mb_tile(mb["file"], zz, xx, yy), z, x, y)
        if source not in SOURCES:
            return None, "", ""
        path = self._path(source, z, x, y)
        if os.path.isfile(path):
            with open(path, "rb") as f:
                data = f.read()
            return data, _sniff(data), "cache"
        data = self._fetch(source, z, x, y)
        if data:
            self._store(path, data)
            return data, _sniff(data), "online"

        def cached(zz, xx, yy):
            p = self._path(source, zz, xx, yy)
            if os.path.isfile(p):
                with open(p, "rb") as f:
                    return f.read()
            return None
        return self._fallback(cached, z, x, y)

    def _store(self, path: str, data: bytes):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)

    def _fallback(self, loader, z, x, y):
        """Upscale the closest available parent tile (needs Pillow)."""
        for d in range(1, 7):
            if z - d < 0:
                break
            pz, px, py = z - d, x >> d, y >> d
            data = loader(pz, px, py)
            if not data:
                continue
            try:
                from PIL import Image
                img = Image.open(io.BytesIO(data)).convert("RGB")
                n = 1 << d
                size = img.width / n
                box = (int((x - px * n) * size), int((y - py * n) * size),
                       int((x - px * n + 1) * size), int((y - py * n + 1) * size))
                out = img.crop(box).resize((256, 256), Image.BILINEAR if d <= 2 else Image.NEAREST)
                buf = io.BytesIO()
                out.save(buf, "PNG")
                return buf.getvalue(), "image/png", "fallback"
            except Exception:
                return None, "", ""
        return None, "", ""

    # -- prefetch --

    def prefetch(self, source: str, bounds: Dict[str, float], minz: int, maxz: int) -> Dict[str, Any]:
        if source not in SOURCES:
            raise ValueError("Unbekannte Quelle")
        maxz = min(maxz, SOURCES[source]["max"])
        s, w, n, e = (float(bounds[k]) for k in ("south", "west", "north", "east"))
        total = count_tiles(s, w, n, e, minz, maxz)
        if total > MAX_PREFETCH_TILES:
            raise ValueError(f"{total} Kacheln – maximal {MAX_PREFETCH_TILES} pro Auftrag (Gebiet/Zoom verkleinern)")
        job_id = f"job-{int(time.time() * 1000)}"
        job = {"id": job_id, "source": source, "total": total, "done": 0, "failed": 0, "cached": 0,
               "status": "running", "bounds": bounds, "minz": minz, "maxz": maxz, "started": time.time()}
        self.jobs[job_id] = job

        def run():
            self.online_fail_until = 0
            for z, x, y in tiles_in_bounds(s, w, n, e, minz, maxz):
                if job["status"] == "cancelled":
                    return
                path = self._path(source, z, x, y)
                if os.path.isfile(path):
                    job["cached"] += 1
                else:
                    data = self._fetch(source, z, x, y, timeout=15)
                    if data:
                        self._store(path, data)
                    else:
                        job["failed"] += 1
                        self.online_fail_until = 0
                    time.sleep(0.05)  # be polite to public tile servers
                job["done"] += 1
            job["status"] = "done"
            job["finished"] = time.time()

        threading.Thread(target=run, name=f"tile-prefetch-{job_id}", daemon=True).start()
        return job

    def cache_stats(self) -> Dict[str, Any]:
        stats = {}
        for src in os.listdir(self.cache_dir):
            p = os.path.join(self.cache_dir, src)
            if not os.path.isdir(p):
                continue
            n = size = 0
            for root, _, files in os.walk(p):
                for f in files:
                    n += 1
                    size += os.path.getsize(os.path.join(root, f))
            stats[src] = {"tiles": n, "mb": round(size / 1048576, 1)}
        return stats


def _sniff(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


def create_router(ts: TileServer, is_admin):
    router = APIRouter(tags=["tiles"])

    @router.get("/tiles/{source}/{z}/{x}/{y}")
    def tile(source: str, z: int, x: int, y: str):
        y_int = int(re.sub(r"\.\w+$", "", y))
        data, media, origin = ts.get_tile(source, z, x, y_int)
        if not data:
            raise HTTPException(status_code=404, detail="Kachel nicht verfügbar")
        return Response(data, media_type=media, headers={
            "Cache-Control": "public, max-age=604800" if origin != "fallback" else "no-store",
            "X-LPU5-Tile": origin, "Access-Control-Allow-Origin": "*"})

    @router.get("/api/tiles/sources")
    def sources():
        return {"sources": ts.list_sources(), "cache": ts.cache_stats()}

    @router.post("/api/tiles/prefetch")
    def prefetch(data: Dict[str, Any] = Body(...), authorization: Optional[str] = Header(None)):
        if not is_admin(authorization):
            raise HTTPException(status_code=403, detail="Nur für Administratoren")
        try:
            return ts.prefetch(data.get("source", "osm"), data["bounds"], int(data.get("minz", 1)), int(data.get("maxz", 15)))
        except (KeyError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.get("/api/tiles/jobs")
    def jobs():
        return {"jobs": sorted(ts.jobs.values(), key=lambda j: j["started"], reverse=True)[:20]}

    @router.delete("/api/tiles/jobs/{job_id}")
    def cancel(job_id: str, authorization: Optional[str] = Header(None)):
        if not is_admin(authorization):
            raise HTTPException(status_code=403, detail="Nur für Administratoren")
        if job_id in ts.jobs:
            ts.jobs[job_id]["status"] = "cancelled"
        return {"status": "success"}

    return router
