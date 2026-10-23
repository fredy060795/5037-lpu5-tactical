#!/usr/bin/env python3
"""
tak_integration.py - Two-way ATAK / WinTAK / iTAK integration for LPU5

LPU5 already exchanges unit markers (a-*), GeoChat (b-t-f) and PLI with TAK
clients. This module covers everything else a TAK user expects to work in
both directions:

    TAK type        LPU5 object                      direction
    u-d-f           drawing polyline / polygon        <->
    u-d-r           drawing rectangle                 <->
    u-d-c-c/-e      drawing circle                    <->
    b-m-r           route with waypoints              <->
    b-a-o-*         emergency alert (911, in contact,  <->
                    ring the bell, cancel)
    b-r-f-h-c       CASEVAC / 9-line MEDEVAC report   <->
    b-i-v           video feed (__video)              <->  video analytics
    b-f-t-r         data package file transfer        <->  Marti API
    t-x-d-d         delete                            <->

It also provides
* a minimal Marti (TAK server) data package API so ATAK's "send to server",
  "server data packages" and file transfers work against LPU5, and
* connection data packages: a zip that ATAK/iTAK imports to connect to LPU5.

The CoT <-> dict conversion functions are pure and unit-tested; the
TakBridge class wires them to the LPU5 database and transports via
callbacks so it does not import api.py.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import logging
import os
import re
import threading
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile
from typing import Any, Callable, Dict, List, Optional, Tuple
from xml.sax.saxutils import escape, quoteattr

# Module-level imports: with `from __future__ import annotations` FastAPI
# resolves endpoint annotations from module globals.
from fastapi import APIRouter, Body, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse, Response

logger = logging.getLogger("lpu5-tak")

LPU5_PREFIX = "LPU5-"
SHAPE_TYPES = ("u-d-f", "u-d-r", "u-d-c-c", "u-d-c-e")
ALERT_TYPES = {
    "b-a-o-tbl": "911",
    "b-a-o-opn": "in_contact",
    "b-a-o-pan": "ring_the_bell",
    "b-a-g": "geofence_breached",
    "b-a-o-can": "cancel",
}
ALERT_LABELS = {
    "911": "911-Notruf",
    "in_contact": "Feindkontakt (Troops in Contact)",
    "ring_the_bell": "Ring the Bell",
    "geofence_breached": "Geofence verletzt",
    "cancel": "Alarm aufgehoben",
}
ALERT_TO_TYPE = {v: k for k, v in ALERT_TYPES.items()}
ALERT_DETAIL_NAMES = {"911": "911 Alert", "in_contact": "In Contact", "ring_the_bell": "Ring The Bell",
                      "geofence_breached": "Geo-fence Breached", "cancel": "Cancel"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def now_iso(offset_s: float = 0) -> str:
    t = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=offset_s)
    return t.strftime("%Y-%m-%dT%H:%M:%S.%fZ")[:-4] + "Z"


def argb_to_hex(value: Optional[str]) -> Tuple[Optional[str], float]:
    """ATAK colours are signed 32-bit ARGB ints -> ('#rrggbb', alpha 0..1)."""
    if value in (None, ""):
        return None, 1.0
    try:
        v = int(float(value)) & 0xFFFFFFFF
    except ValueError:
        return None, 1.0
    return f"#{(v >> 16) & 0xFF:02x}{(v >> 8) & 0xFF:02x}{v & 0xFF:02x}", ((v >> 24) & 0xFF) / 255.0


def hex_to_argb(color: Optional[str], alpha: float = 1.0) -> int:
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", (color or "").strip())
    rgb = int(m.group(1), 16) if m else 0x3388FF
    v = (int(round(max(0.0, min(1.0, alpha)) * 255)) << 24) | rgb
    return v - (1 << 32) if v >= (1 << 31) else v


def _parse_point_attr(s: str) -> Optional[List[float]]:
    try:
        parts = [float(x) for x in s.split(",")]
        return [parts[0], parts[1]]
    except (ValueError, IndexError):
        return None


def _attr(parent, tag: str, attr: str = "value") -> Optional[str]:
    # Note: an Element without children is falsy, so never use `find(...) or default`.
    el = parent.find(tag) if parent is not None else None
    return el.get(attr) if el is not None else None


def _point(root) -> Tuple[float, float]:
    p = root.find("point")
    return float(p.get("lat", 0)), float(p.get("lon", 0))


def _callsign(detail) -> str:
    if detail is None:
        return ""
    c = detail.find("contact")
    return (c.get("callsign") if c is not None else "") or ""


def _remarks(detail) -> str:
    if detail is None:
        return ""
    r = detail.find("remarks")
    return (r.text or "").strip() if r is not None else ""


def destination(lat: float, lng: float, bearing: float, dist: float) -> List[float]:
    import math
    r = 6371008.8
    b, p1, l1, d = math.radians(bearing), math.radians(lat), math.radians(lng), dist / r
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return [math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180]


# ---------------------------------------------------------------------------
# CoT -> LPU5
# ---------------------------------------------------------------------------

def parse_event(xml: str):
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    return root if root.tag == "event" else None


def classify(root) -> Optional[str]:
    t = root.get("type", "")
    if t.startswith("u-d-") and t.startswith(SHAPE_TYPES):
        return "shape"
    if t == "b-m-r":
        return "route"
    if t in ALERT_TYPES or t.startswith("b-a-o-"):
        return "alert"
    if t == "b-r-f-h-c":
        return "casevac"
    if t == "b-i-v":
        return "video"
    if t == "b-f-t-r":
        return "file"
    if t == "t-x-d-d":
        return "delete"
    return None


def cot_to_drawing(root) -> Optional[Dict[str, Any]]:
    """u-d-f / u-d-r / u-d-c-* / b-m-r -> LPU5 drawing dict."""
    t = root.get("type", "")
    uid = root.get("uid")
    detail = root.find("detail")
    if not uid or detail is None:
        return None
    stroke, alpha = argb_to_hex(_attr(detail, "strokeColor"))
    fill, fill_alpha = argb_to_hex(_attr(detail, "fillColor"))
    weight_el = detail.find("strokeWeight")
    weight = int(round(float(weight_el.get("value", 3)))) if weight_el is not None else 3
    name = _callsign(detail) or t
    data: Dict[str, Any] = {"source": "tak", "cot_type": t, "remarks": _remarks(detail)}
    if fill:
        data.update(fill_color=fill, fill_opacity=round(fill_alpha, 2))

    if t.startswith("u-d-c"):
        lat, lng = _point(root)
        ell = detail.find("shape/ellipse")
        if ell is None:
            return None
        radius = float(ell.get("major", 0) or 0)
        data["radius"] = radius
        if t == "u-d-c-e":
            data.update(minor=float(ell.get("minor", radius) or radius), angle=float(ell.get("angle", 0) or 0))
        return {"id": uid, "name": name, "type": "circle", "coordinates": [[lat, lng]],
                "color": stroke or "#ff0000", "weight": weight, "data": data}

    links = [l for l in detail.findall("link") if l.get("point")]
    coords = [p for p in (_parse_point_attr(l.get("point")) for l in links) if p]
    if t == "b-m-r":
        data["waypoints"] = [{"name": l.get("callsign") or "", "type": l.get("type") or "",
                              "uid": l.get("uid") or ""} for l in links]
        la = detail.find("link_attr")
        if la is not None:
            data["route"] = {k: la.get(k) for k in ("method", "direction", "prefix", "type", "order") if la.get(k)}
        if len(coords) < 2:
            return None
        return {"id": uid, "name": name, "type": "route", "coordinates": coords,
                "color": stroke or "#ffffff", "weight": weight, "data": data}

    if len(coords) < 2:
        return None
    closed = t == "u-d-r" or (len(coords) > 3 and coords[0] == coords[-1]) \
        or (detail.find("closed") is not None and detail.find("closed").get("value") == "true")
    if closed and coords[0] == coords[-1]:
        coords = coords[:-1]
    kind = "rectangle" if t == "u-d-r" else ("polygon" if closed else "polyline")
    return {"id": uid, "name": name, "type": kind, "coordinates": coords,
            "color": stroke or "#ff0000", "weight": weight, "data": data}


def cot_to_alert(root) -> Dict[str, Any]:
    t = root.get("type", "")
    detail = root.find("detail")
    lat, lng = _point(root)
    em = detail.find("emergency") if detail is not None else None
    kind = ALERT_TYPES.get(t, "911")
    if em is not None and (em.get("cancel") == "true" or t == "b-a-o-can"):
        kind = "cancel"
    sender = ""
    if detail is not None:
        for l in detail.findall("link"):
            if l.get("relation") == "p-p" and l.get("uid"):
                sender = l.get("uid")
    who = (em.text or "").strip() if em is not None and em.text else _callsign(detail).replace("-Alert", "")
    return {"id": root.get("uid"), "kind": kind, "label": ALERT_LABELS.get(kind, kind), "callsign": who,
            "sender_uid": sender, "lat": lat, "lng": lng, "source": "tak", "timestamp": root.get("time") or now_iso()}


CASEVAC_FIELDS = ("title", "freq", "urgent", "priority", "routine", "hoist", "extraction_equipment",
                  "ventilator", "equipment_other", "equipment_detail", "litter", "ambulatory", "security",
                  "hlz_marking", "us_military", "us_civilian", "nonus_military", "nonus_civilian", "epw", "child",
                  "terrain_slope", "terrain_rough", "terrain_loose", "obstacles", "winds_are_from", "friendlies",
                  "enemy", "hlz_remarks", "medline_remarks", "zone_prot_marker")


def cot_to_casevac(root) -> Dict[str, Any]:
    detail = root.find("detail")
    lat, lng = _point(root)
    med = detail.find("_medevac_") if detail is not None else None
    fields = {k: med.get(k) for k in CASEVAC_FIELDS if med is not None and med.get(k) not in (None, "")}
    return {"id": root.get("uid"), "kind": "medevac", "callsign": _callsign(detail), "lat": lat, "lng": lng,
            "fields": fields, "remarks": _remarks(detail), "source": "tak", "timestamp": root.get("time") or now_iso()}


def cot_to_video(root) -> Optional[Dict[str, Any]]:
    detail = root.find("detail")
    v = detail.find("__video") if detail is not None else None
    if v is None:
        return None
    ce = v.find("ConnectionEntry")
    url = v.get("url")
    alias = _callsign(detail)
    if ce is not None:
        alias = ce.get("alias") or alias
        if not url and ce.get("address"):
            proto = ce.get("protocol") or "rtsp"
            port = ce.get("port")
            path = ce.get("path") or ""
            url = f"{proto}://{ce.get('address')}{':' + port if port and port not in ('-1', '0') else ''}{path if path.startswith('/') or not path else '/' + path}"
    if not url:
        return None
    return {"uid": root.get("uid"), "alias": alias or url, "url": url}


def cot_to_fileshare(root) -> Optional[Dict[str, Any]]:
    detail = root.find("detail")
    fs = detail.find("fileshare") if detail is not None else None
    if fs is None:
        return None
    return {"uid": root.get("uid"), "filename": fs.get("filename"), "url": fs.get("senderUrl"),
            "sha256": (fs.get("sha256") or "").lower(), "size": int(fs.get("sizeInBytes") or 0),
            "sender": fs.get("senderCallsign") or "", "name": fs.get("name") or fs.get("filename")}


def cot_delete_target(root) -> Optional[str]:
    detail = root.find("detail")
    if detail is None:
        return None
    link = detail.find("link")
    return link.get("uid") if link is not None else None


# ---------------------------------------------------------------------------
# LPU5 -> CoT
# ---------------------------------------------------------------------------

def _event(uid: str, cot_type: str, lat: float, lng: float, detail: str, stale_s: float = 86400,
           how: str = "h-e") -> str:
    t = now_iso()
    return (f'<event version="2.0" uid={quoteattr(uid)} type={quoteattr(cot_type)} time="{t}" start="{t}" '
            f'stale="{now_iso(stale_s)}" how="{how}"><point lat="{lat:.7f}" lon="{lng:.7f}" hae="9999999.0" '
            f'ce="9999999.0" le="9999999.0"/><detail>{detail}</detail></event>')


def drawing_uid(drawing: Dict[str, Any]) -> str:
    did = str(drawing["id"])
    if (drawing.get("data") or {}).get("source") == "tak":
        return did  # keep the TAK originator's UID
    return did if did.startswith(LPU5_PREFIX) else f"{LPU5_PREFIX}D-{did}"


def drawing_to_cot(d: Dict[str, Any], sender_uid: str = "LPU5-GW") -> Optional[str]:
    coords = [c if isinstance(c, (list, tuple)) else [c["lat"], c["lng"]] for c in (d.get("coordinates") or [])]
    if not coords:
        return None
    data = d.get("data") or {}
    kind = (d.get("type") or "polyline").lower()
    uid = drawing_uid(d)
    stroke = hex_to_argb(d.get("color") or "#3388ff")
    common = (f'<contact callsign={quoteattr(d.get("name") or "LPU5")}/>'
              f'<strokeColor value="{stroke}"/><strokeWeight value="{float(d.get("weight") or 3):.1f}"/>'
              f'<link uid={quoteattr(sender_uid)} relation="p-p" type="a-f-G-U-C"/>'
              f'<remarks>{escape(data.get("remarks") or "")}</remarks><archive/><labels_on value="false"/>')
    if data.get("fill_color") or kind in ("polygon", "rectangle", "circle"):
        common += f'<fillColor value="{hex_to_argb(data.get("fill_color") or d.get("color"), data.get("fill_opacity", 0.15))}"/>'

    if kind == "circle":
        r = float(data.get("radius") or d.get("radius") or 100)
        lat, lng = coords[0]
        return _event(uid, "u-d-c-c", lat, lng,
                      f'<shape><ellipse major="{r:.2f}" minor="{r:.2f}" angle="360"/></shape>{common}')
    if kind == "route":
        wps = data.get("waypoints") or []
        prefix = (data.get("route") or {}).get("prefix", "CP")
        links = "".join(
            f'<link uid={quoteattr((wps[i].get("uid") if i < len(wps) else "") or f"{uid}-wp{i}")} '
            f'callsign={quoteattr((wps[i].get("name") if i < len(wps) else "") or f"{prefix}{i + 1}")} '
            f'type="b-m-p-w" point="{c[0]:.7f},{c[1]:.7f}" remarks="" relation="c"/>'
            for i, c in enumerate(coords))
        r = data.get("route") or {}
        attr = (f'<link_attr color="{stroke}" method={quoteattr(r.get("method", "Walking"))} '
                f'direction={quoteattr(r.get("direction", "Infil"))} routetype="Primary" '
                f'order={quoteattr(r.get("order", "Ascending Check Points"))} prefix={quoteattr(prefix)} '
                f'type={quoteattr(r.get("type", "On Foot"))}/>')
        lat, lng = coords[0]
        return _event(uid, "b-m-r", lat, lng, links + attr + common)
    pts = list(coords)
    cot_type = "u-d-r" if kind == "rectangle" and len(pts) == 4 else "u-d-f"
    if kind in ("polygon", "rectangle") and cot_type == "u-d-f":
        pts = pts + [pts[0]]  # ATAK closes a freehand shape by repeating the first point
    links = "".join(f'<link point="{c[0]:.7f},{c[1]:.7f}"/>' for c in pts)
    lat = sum(c[0] for c in coords) / len(coords)
    lng = sum(c[1] for c in coords) / len(coords)
    return _event(uid, cot_type, lat, lng, links + common)


def delete_to_cot(target_uid: str, lat: float = 0.0, lng: float = 0.0) -> str:
    return _event(f"{target_uid}-del-{uuid.uuid4().hex[:6]}", "t-x-d-d", lat, lng,
                  f'<link uid={quoteattr(target_uid)} relation="none" type="none"/><__forcedelete/>', stale_s=60)


def alert_to_cot(alert: Dict[str, Any]) -> str:
    kind = alert.get("kind", "911")
    who = alert.get("callsign") or "LPU5"
    sender = alert.get("sender_uid") or f"GPS-{who}"
    uid = alert.get("id") or f"{sender}-9-1-1"
    if kind == "cancel":
        detail = (f'<link uid={quoteattr(sender)} type="a-f-G-U-C" relation="p-p"/>'
                  f'<contact callsign={quoteattr(who + "-Alert")}/><emergency cancel="true">{escape(who)}</emergency>')
        return _event(uid, "b-a-o-can", alert.get("lat", 0), alert.get("lng", 0), detail, stale_s=10, how="m-g")
    detail = (f'<link uid={quoteattr(sender)} type="a-f-G-U-C" relation="p-p"/>'
              f'<contact callsign={quoteattr(who + "-Alert")}/>'
              f'<emergency type={quoteattr(ALERT_DETAIL_NAMES.get(kind, "911 Alert"))}>{escape(who)}</emergency>')
    return _event(uid, ALERT_TO_TYPE.get(kind, "b-a-o-tbl"), alert.get("lat", 0), alert.get("lng", 0), detail,
                  stale_s=3600, how="m-g")


def casevac_to_cot(report: Dict[str, Any]) -> str:
    f = dict(report.get("fields") or {})
    f.setdefault("title", report.get("callsign") or "MEDEVAC")
    attrs = " ".join(f'{k}={quoteattr(str(v))}' for k, v in f.items() if k in CASEVAC_FIELDS)
    detail = (f'<contact callsign={quoteattr(f["title"])}/><_medevac_ casevac="true" {attrs}/>'
              f'<remarks>{escape(report.get("remarks") or "")}</remarks><archive/>')
    return _event(report.get("id") or f"LPU5-MEDEVAC-{uuid.uuid4().hex[:8]}", "b-r-f-h-c",
                  report.get("lat", 0), report.get("lng", 0), detail, stale_s=86400)


def video_to_cot(stream: Dict[str, Any], host: str) -> Optional[str]:
    """Advertise an LPU5 video stream to TAK clients (b-i-v)."""
    url = stream.get("tak_url") or stream.get("source") or ""
    if not re.match(r"^(rtsp|rtmp|udp|srt|https?)://", url):
        return None
    m = re.match(r"^(\w+)://(?:[^@/]+@)?([^/:]+)(?::(\d+))?(/.*)?$", url)
    proto, addr, port, path = (m.group(1), m.group(2), m.group(3) or "-1", m.group(4) or "") if m else ("rtsp", host, "-1", "")
    uid = f"{LPU5_PREFIX}V-{stream['id']}"
    alias = stream.get("name") or stream["id"]
    detail = (f'<__video url={quoteattr(url)}><ConnectionEntry networkTimeout="12000" uid={quoteattr(uid)} '
              f'path={quoteattr(path)} protocol={quoteattr(proto)} bufferTime="-1" address={quoteattr(addr)} '
              f'port="{port}" roverPort="-1" rtspReliable="1" ignoreEmbeddedKLV="false" alias={quoteattr(alias)}/>'
              f'</__video><contact callsign={quoteattr(alias)}/>')
    lat, lng = stream.get("lat") or 0.0, stream.get("lng") or 0.0
    return _event(uid, "b-i-v", lat, lng, detail, stale_s=3600)


def fileshare_to_cot(pkg: Dict[str, Any], base_url: str, sender_uid: str = "LPU5-GW",
                     sender_callsign: str = "LPU5") -> str:
    url = f"{base_url.rstrip('/')}/Marti/sync/content?hash={pkg['hash']}"
    detail = (f'<fileshare filename={quoteattr(pkg["filename"])} senderUrl={quoteattr(url)} '
              f'sizeInBytes="{pkg["size"]}" sha256="{pkg["hash"]}" senderUid={quoteattr(sender_uid)} '
              f'senderCallsign={quoteattr(sender_callsign)} name={quoteattr(pkg.get("name") or pkg["filename"])}/>'
              f'<ackrequest uid="{uuid.uuid4()}" ackrequested="false" tag={quoteattr(pkg["filename"])}/>')
    return _event(f"{LPU5_PREFIX}FT-{pkg['hash'][:16]}", "b-f-t-r", 0.0, 0.0, detail, stale_s=600)


# ---------------------------------------------------------------------------
# Data packages (ATAK mission packages)
# ---------------------------------------------------------------------------

class DataPackageStore:
    """Files exchanged with TAK clients, addressed by SHA-256 like a TAK server."""

    def __init__(self, directory: str):
        self.dir = directory
        os.makedirs(directory, exist_ok=True)
        self.index_path = os.path.join(directory, "index.json")
        self.lock = threading.Lock()
        try:
            with open(self.index_path, "r", encoding="utf-8") as f:
                self.index: Dict[str, Dict[str, Any]] = json.load(f)
        except Exception:
            self.index = {}

    def _save(self):
        tmp = self.index_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.index, f, indent=1)
        os.replace(tmp, self.index_path)

    def add(self, data: bytes, filename: str, creator: str = "", name: str = "", keywords=None,
            mime: str = "application/zip") -> Dict[str, Any]:
        h = hashlib.sha256(data).hexdigest()
        safe = re.sub(r"[^\w.\- ]", "_", os.path.basename(filename or "package.zip"))[:120] or "package.zip"
        with self.lock:
            with open(os.path.join(self.dir, h), "wb") as f:
                f.write(data)
            entry = self.index.get(h) or {}
            entry.update({
                "hash": h, "filename": safe, "name": name or entry.get("name") or safe, "size": len(data),
                "creator": creator or entry.get("creator", ""), "mime": mime,
                "keywords": sorted(set((entry.get("keywords") or []) + list(keywords or ["missionpackage"]))),
                "tool": entry.get("tool", "public"),
                "submitted": entry.get("submitted") or now_iso(),
            })
            self.index[h] = entry
            self._save()
        return entry

    def get(self, h: str) -> Optional[Dict[str, Any]]:
        return self.index.get((h or "").lower())

    def path(self, h: str) -> Optional[str]:
        e = self.get(h)
        p = os.path.join(self.dir, e["hash"]) if e else None
        return p if p and os.path.isfile(p) else None

    def list(self) -> List[Dict[str, Any]]:
        return sorted(self.index.values(), key=lambda e: e.get("submitted", ""), reverse=True)

    def delete(self, h: str) -> bool:
        with self.lock:
            e = self.index.pop((h or "").lower(), None)
            if not e:
                return False
            try:
                os.remove(os.path.join(self.dir, e["hash"]))
            except OSError:
                pass
            self._save()
        return True

    def set_tool(self, h: str, tool: str):
        with self.lock:
            if h in self.index:
                self.index[h]["tool"] = tool
                self._save()


def mission_package(name: str, files: Dict[str, bytes], on_receive_import: bool = True) -> bytes:
    """Build an ATAK mission package (zip with MANIFEST/manifest.xml)."""
    uid = str(uuid.uuid4())
    contents = "".join(f'<Content ignore="false" zipEntry={quoteattr(path)}/>' for path in files)
    manifest = (f'<MissionPackageManifest version="2"><Configuration>'
                f'<Parameter name="uid" value="{uid}"/><Parameter name="name" value={quoteattr(name)}/>'
                f'<Parameter name="onReceiveImport" value="{str(on_receive_import).lower()}"/>'
                f'<Parameter name="onReceiveDelete" value="false"/>'
                f'</Configuration><Contents>{contents}</Contents></MissionPackageManifest>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("MANIFEST/manifest.xml", manifest)
        for path, data in files.items():
            z.writestr(path, data)
    return buf.getvalue()


def connection_package(host: str, port: int, protocol: str = "tcp", description: str = "LPU5 Tactical",
                       truststore_p12: Optional[bytes] = None, truststore_password: str = "atakatak",
                       callsign: Optional[str] = None) -> bytes:
    """Data package that configures ATAK/iTAK/WinTAK to stream CoT with LPU5."""
    entries = [
        ("count", "Integer", "1"),
        ("description0", "String", description),
        ("enabled0", "Boolean", "true"),
        ("connectString0", "String", f"{host}:{port}:{protocol}"),
    ]
    files: Dict[str, bytes] = {}
    if protocol == "ssl" and truststore_p12:
        entries += [("caLocation0", "String", "cert/lpu5-truststore.p12"),
                    ("caPassword0", "String", truststore_password),
                    ("enrollForCertificateWithTrust0", "Boolean", "false"),
                    ("useAuth0", "Boolean", "false")]
        files["cert/lpu5-truststore.p12"] = truststore_p12
    stream = "".join(f'<entry key="{k}" class="class java.lang.{c}">{escape(v)}</entry>' for k, c, v in entries)
    app_prefs = ""
    if callsign:
        app_prefs = (f'<preference version="1" name="com.atakmap.app_preferences">'
                     f'<entry key="locationCallsign" class="class java.lang.String">{escape(callsign)}</entry></preference>')
    if protocol == "ssl" and truststore_p12:
        app_prefs += ('<preference version="1" name="com.atakmap.app.civ_preferences">'
                      '<entry key="caLocation" class="class java.lang.String">cert/lpu5-truststore.p12</entry>'
                      f'<entry key="caPassword" class="class java.lang.String">{escape(truststore_password)}</entry>'
                      '</preference>')
    pref = (f"<?xml version='1.0' standalone='yes'?><preferences>"
            f'<preference version="1" name="cot_streams">{stream}</preference>{app_prefs}</preferences>')
    files = {"lpu5/lpu5.pref": pref.encode(), **files}
    return mission_package(f"LPU5 Verbindung {host}", files, on_receive_import=True)


def ca_truststore_p12(ca_pem: bytes, password: str = "atakatak") -> bytes:
    from cryptography import x509
    from cryptography.hazmat.primitives.serialization import pkcs12, BestAvailableEncryption
    ca = x509.load_pem_x509_certificate(ca_pem)
    return pkcs12.serialize_key_and_certificates(b"lpu5-ca", None, None, [ca], BestAvailableEncryption(password.encode()))


def export_package(name: str, markers: List[Dict[str, Any]], drawings: List[Dict[str, Any]],
                   marker_to_cot: Callable[[Dict[str, Any]], Optional[str]]) -> bytes:
    """LPU5 situation (markers + drawings) as ATAK mission package of .cot files."""
    files: Dict[str, bytes] = {}
    for m in markers:
        xml = marker_to_cot(m)
        if xml:
            files[f"{m['id']}/{m['id']}.cot"] = xml.encode()
    for d in drawings:
        xml = drawing_to_cot(d)
        if xml:
            uid = drawing_uid(d)
            files[f"{uid}/{uid}.cot"] = xml.encode()
    return mission_package(name, files)


def extract_package(data: bytes) -> Dict[str, Any]:
    """Split an ATAK data package into CoT events and map overlay files."""
    out: Dict[str, Any] = {"cot": [], "overlays": [], "other": []}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            if info.is_dir() or info.file_size > 50 * 1024 * 1024:
                continue
            name = info.filename
            low = name.lower()
            if low.startswith("manifest/"):
                continue
            if low.endswith(".cot") or low.endswith(".xml"):
                text = z.read(info).decode("utf-8", "replace")
                if "<event" in text:
                    out["cot"].append(text)
                    continue
            if low.endswith((".kml", ".kmz", ".gpx", ".geojson", ".json")):
                out["overlays"].append({"name": os.path.basename(name), "data": z.read(info)})
            else:
                out["other"].append(name)
    return out


# ---------------------------------------------------------------------------
# Bridge: wires the conversions to LPU5
# ---------------------------------------------------------------------------

class TakBridge:
    """Glue between TAK CoT traffic and LPU5 state.

    Callbacks (all optional):
      upsert_drawing(dict) -> bool changed     delete_drawing(id) -> Optional[dict]
      broadcast(channel, event, data)          send_cot(xml)
      add_video(dict)                          on_alert(dict) / on_report(dict)
      marker_to_cot(dict) -> xml               fetch(url) -> bytes
    """

    def __init__(self, base_path: str, **callbacks):
        self.cb = callbacks
        self.packages = DataPackageStore(os.path.join(base_path, "data_packages"))
        self.alerts: Dict[str, Dict[str, Any]] = {}
        self.reports: List[Dict[str, Any]] = []
        self.video_uids: Dict[str, str] = {}
        self._seen: Dict[str, float] = {}
        self._sent_uids: Dict[str, float] = {}
        self._seen_lock = threading.Lock()

    def _call(self, name, *args):
        fn = self.cb.get(name)
        if fn:
            try:
                return fn(*args)
            except Exception as e:
                logger.warning("tak bridge callback %s failed: %s", name, e)
        return None

    def send(self, xml: Optional[str]):
        if xml:
            root = parse_event(xml)
            if root is not None:
                # Remember own events: multicast/TAK-server echoes of them are ignored.
                with self._seen_lock:
                    self._seen[f"{root.get('uid', '')}|{root.get('time', '')}|{root.get('type', '')}"] = time.time()
                    self._sent_uids[root.get("uid", "")] = time.time()
            self._call("send_cot", xml)

    # -- inbound --

    def handle_inbound(self, xml: str) -> bool:
        """Process TAK traffic this module owns. Returns True when handled."""
        root = parse_event(xml)
        if root is None:
            return False
        kind = classify(root)
        if kind is None:
            return False
        uid = root.get("uid", "")
        # The same event arrives via several paths (multicast, TCP, TAK server
        # echo). Process and relay each version once to avoid relay loops.
        key = f"{uid}|{root.get('time', '')}|{root.get('type', '')}"
        now = time.time()
        with self._seen_lock:
            if key in self._seen:
                return True
            self._seen[key] = now
            echo = now - self._sent_uids.get(uid, 0) < 120 and kind in ("alert", "casevac", "file")
        if echo:
            return True  # our own alert/report/file share coming back
            if len(self._seen) > 5000:
                for k in [k for k, t in self._seen.items() if now - t > 600]:
                    del self._seen[k]
        if not uid.startswith(LPU5_PREFIX):
            self._call("relay", xml)
        if kind in ("shape", "route"):
            if uid.startswith(LPU5_PREFIX + "D-"):
                return True  # echo of our own drawing
            d = cot_to_drawing(root)
            if d:
                d["created_by"] = d["name"] or "ATAK"
                self._call("upsert_drawing", d)
            return True
        if kind == "delete":
            target = cot_delete_target(root)
            if target:
                self._call("delete_drawing", target)
                self._call("delete_marker", target)
            return True
        if kind == "alert":
            a = cot_to_alert(root)
            self._apply_alert(a, forward=False)
            return True
        if kind == "casevac":
            r = cot_to_casevac(root)
            self._store_report(r)
            return True
        if kind == "video":
            if uid.startswith(LPU5_PREFIX + "V-"):
                return True
            v = cot_to_video(root)
            if v:
                self._call("add_video", v)
            return True
        if kind == "file":
            fs = cot_to_fileshare(root)
            if fs and fs["url"] and fs["sha256"] and not self.packages.get(fs["sha256"]):
                threading.Thread(target=self._fetch_package, args=(fs,), daemon=True).start()
            return True
        return False

    def _fetch_package(self, fs: Dict[str, Any]):
        data = self._call("fetch", fs["url"])
        if not data:
            return
        if hashlib.sha256(data).hexdigest() != fs["sha256"]:
            logger.warning("TAK file share %s: hash mismatch – discarded", fs["filename"])
            return
        e = self.packages.add(data, fs["filename"], creator=fs["sender"], name=fs["name"])
        self._call("broadcast", "packages", "package_added", e)

    # -- alerts --

    def _apply_alert(self, a: Dict[str, Any], forward: bool):
        key = a.get("sender_uid") or a.get("callsign") or a["id"]
        if a["kind"] == "cancel":
            self.alerts.pop(key, None)
        else:
            self.alerts[key] = a
        self._call("broadcast", "alerts", "alert", a)
        self._call("on_alert", a)
        if forward:
            self.send(alert_to_cot(a))

    def raise_alert(self, kind: str, callsign: str, lat: float, lng: float, sender_uid: str = "",
                    text: str = "") -> Dict[str, Any]:
        if kind not in ALERT_LABELS:
            raise ValueError("unbekannter Alarmtyp")
        sender = sender_uid or f"GPS-{re.sub(r'[^a-zA-Z0-9_-]', '_', callsign)}"
        a = {"id": f"{sender}-9-1-1", "kind": kind, "label": ALERT_LABELS[kind], "callsign": callsign,
             "sender_uid": sender, "lat": lat, "lng": lng, "text": text, "source": "lpu5", "timestamp": now_iso()}
        self._apply_alert(a, forward=True)
        return a

    def active_alerts(self) -> List[Dict[str, Any]]:
        return list(self.alerts.values())

    # -- reports --

    def _store_report(self, r: Dict[str, Any]):
        self.reports.insert(0, r)
        del self.reports[200:]
        self._call("broadcast", "reports", "report", r)
        self._call("on_report", r)

    def submit_report(self, report: Dict[str, Any]) -> Dict[str, Any]:
        r = dict(report)
        r.setdefault("id", f"LPU5-{r.get('kind', 'report').upper()}-{uuid.uuid4().hex[:8]}")
        r.setdefault("timestamp", now_iso())
        r["source"] = "lpu5"
        self._store_report(r)
        if r.get("kind") == "medevac":
            self.send(casevac_to_cot(r))
        return r

    # -- outbound objects --

    def drawing_changed(self, d: Dict[str, Any]):
        if (d.get("data") or {}).get("source") == "tak" and d.get("_from_tak"):
            return
        self.send(drawing_to_cot(d))

    def drawing_deleted(self, d: Dict[str, Any]):
        coords = d.get("coordinates") or [[0, 0]]
        c = coords[0] if isinstance(coords[0], (list, tuple)) else [coords[0]["lat"], coords[0]["lng"]]
        self.send(delete_to_cot(drawing_uid(d), c[0], c[1]))

    def video_published(self, stream: Dict[str, Any], host: str):
        self.send(video_to_cot(stream, host))

    def package_shared(self, pkg: Dict[str, Any], base_url: str, callsign: str = "LPU5"):
        self.send(fileshare_to_cot(pkg, base_url, sender_callsign=callsign))


# ---------------------------------------------------------------------------
# FastAPI routers
# ---------------------------------------------------------------------------

def create_router(bridge: TakBridge, current_user: Callable[[Optional[str]], Dict[str, Any]],
                  marti_base_url: Callable[[], str], server_host: Callable[[], str],
                  ca_pem: Callable[[], Optional[bytes]], export_situation: Callable[[], bytes],
                  ingest_cot: Callable[[str], None], create_overlay_file: Callable[[str, bytes, str], None]):
    """LPU5-side API: alerts, reports, data packages, connection packages."""
    router = APIRouter(prefix="/api/tak", tags=["tak-integration"])

    def user(authorization):
        u = current_user(authorization)
        if not u:
            raise HTTPException(status_code=401, detail="Nicht angemeldet")
        return u

    @router.get("/alerts")
    def list_alerts(authorization: Optional[str] = Header(None)):
        user(authorization)
        return {"alerts": bridge.active_alerts()}

    @router.post("/alerts")
    def post_alert(data: Dict[str, Any] = Body(...), authorization: Optional[str] = Header(None)):
        u = user(authorization)
        try:
            a = bridge.raise_alert(data.get("kind", "911"), u.get("callsign") or u.get("username"),
                                   float(data.get("lat") or 0), float(data.get("lng") or 0),
                                   text=str(data.get("text") or "")[:500])
        except (ValueError, TypeError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"status": "success", "alert": a}

    @router.get("/reports")
    def list_reports(authorization: Optional[str] = Header(None)):
        user(authorization)
        return {"reports": bridge.reports}

    @router.post("/reports")
    def post_report(data: Dict[str, Any] = Body(...), authorization: Optional[str] = Header(None)):
        u = user(authorization)
        kind = data.get("kind")
        if kind not in ("medevac", "salute", "sitrep", "spot"):
            raise HTTPException(status_code=400, detail="kind muss medevac, salute, sitrep oder spot sein")
        fields = {str(k)[:40]: str(v)[:500] for k, v in (data.get("fields") or {}).items()}
        r = bridge.submit_report({"kind": kind, "fields": fields, "remarks": str(data.get("remarks") or "")[:2000],
                                  "lat": float(data.get("lat") or 0), "lng": float(data.get("lng") or 0),
                                  "callsign": u.get("callsign") or u.get("username"), "author": u.get("username")})
        return {"status": "success", "report": r}

    @router.get("/packages")
    def list_packages(authorization: Optional[str] = Header(None)):
        user(authorization)
        return {"packages": bridge.packages.list()}

    @router.post("/packages")
    async def upload_package(file: UploadFile = File(...), authorization: Optional[str] = Header(None)):
        u = user(authorization)
        data = await file.read()
        if len(data) > 200 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Paket größer als 200 MB")
        e = bridge.packages.add(data, file.filename or "paket.zip", creator=u.get("callsign") or u.get("username"))
        bridge._call("broadcast", "packages", "package_added", e)
        return {"status": "success", "package": e}

    @router.get("/packages/{h}")
    def download_package(h: str, authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
        user(authorization or (f"Bearer {token}" if token else None))
        e, path = bridge.packages.get(h), bridge.packages.path(h)
        if not path:
            raise HTTPException(status_code=404, detail="Paket nicht gefunden")
        with open(path, "rb") as f:
            return Response(f.read(), media_type=e.get("mime") or "application/zip",
                            headers={"Content-Disposition": f'attachment; filename="{e["filename"]}"'})

    @router.delete("/packages/{h}")
    def delete_package(h: str, authorization: Optional[str] = Header(None)):
        user(authorization)
        if not bridge.packages.delete(h):
            raise HTTPException(status_code=404, detail="Paket nicht gefunden")
        return {"status": "success"}

    @router.post("/packages/{h}/share")
    def share_package(h: str, authorization: Optional[str] = Header(None)):
        u = user(authorization)
        e = bridge.packages.get(h)
        if not e:
            raise HTTPException(status_code=404, detail="Paket nicht gefunden")
        bridge.package_shared(e, marti_base_url(), u.get("callsign") or u.get("username"))
        return {"status": "success"}

    @router.post("/packages/{h}/import")
    def import_package(h: str, authorization: Optional[str] = Header(None)):
        u = user(authorization)
        path = bridge.packages.path(h)
        if not path:
            raise HTTPException(status_code=404, detail="Paket nicht gefunden")
        with open(path, "rb") as f:
            try:
                content = extract_package(f.read())
            except zipfile.BadZipFile:
                raise HTTPException(status_code=400, detail="Keine gültige ZIP-Datei")
        for xml in content["cot"]:
            ingest_cot(xml)
        for ov in content["overlays"]:
            create_overlay_file(ov["name"], ov["data"], u.get("username"))
        return {"status": "success", "cot": len(content["cot"]), "overlays": len(content["overlays"]),
                "skipped": content["other"]}

    @router.get("/export.zip")
    def export_zip(authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
        user(authorization or (f"Bearer {token}" if token else None))
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
        return Response(export_situation(), media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="LPU5-Lage-{stamp}.zip"'})

    @router.get("/connection-package")
    def get_connection_package(protocol: str = "tcp", host: Optional[str] = None, callsign: Optional[str] = None,
                               authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
        u = user(authorization or (f"Bearer {token}" if token else None))
        h = host or server_host()
        if protocol == "ssl":
            pem = ca_pem()
            if not pem:
                raise HTTPException(status_code=400, detail="Keine LPU5-CA vorhanden – Server mit HTTPS starten")
            data = connection_package(h, 8089, "ssl", truststore_p12=ca_truststore_p12(pem),
                                      callsign=callsign or u.get("callsign"))
        else:
            data = connection_package(h, 8088, "tcp", callsign=callsign or u.get("callsign"))
        return Response(data, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="LPU5-ATAK-{protocol}.zip"'})

    return router


def create_marti_router(bridge: TakBridge, marti_base_url: Callable[[], str]):
    """Subset of the TAK server Marti API used by ATAK/WinTAK/iTAK for data packages."""
    router = APIRouter(prefix="/Marti", tags=["marti"])

    @router.get("/api/version")
    def version():
        return PlainTextResponse("LPU5-Tactical-Marti-1.0")

    @router.get("/api/version/config")
    def version_config():
        return {"version": "3", "type": "ServerConfig",
                "data": {"version": "LPU5-1.0", "api": "3", "hostname": "lpu5"}, "nodeId": "lpu5"}

    @router.get("/api/clientEndPoints")
    def client_endpoints():
        return {"version": "3", "type": "com.bbn.marti.remote.ClientEndpoint", "data": []}

    @router.post("/sync/missionupload")
    async def mission_upload(request: Request, hash: str = Query(""), filename: str = Query("paket.zip"),
                             creatorUid: str = Query("")):
        form = await request.form()
        upload = form.get("assetfile") or next((v for v in form.values() if hasattr(v, "read")), None)
        if upload is None:
            data = await request.body()
        else:
            data = await upload.read()
        if not data:
            return PlainTextResponse("empty upload", status_code=400)
        e = bridge.packages.add(data, filename, creator=creatorUid)
        if hash and hash.lower() != e["hash"]:
            logger.warning("Marti upload %s: hash mismatch (given %s)", filename, hash)
        bridge._call("broadcast", "packages", "package_added", e)
        return PlainTextResponse(f"{marti_base_url()}/Marti/sync/content?hash={e['hash']}")

    @router.get("/sync/missionquery")
    def mission_query(hash: str = Query("")):
        if not bridge.packages.get(hash):
            return PlainTextResponse("not found", status_code=404)
        return PlainTextResponse(f"{marti_base_url()}/Marti/sync/content?hash={hash.lower()}")

    @router.get("/sync/content")
    def content(hash: str = Query("")):
        e, path = bridge.packages.get(hash), bridge.packages.path(hash)
        if not path:
            return PlainTextResponse("not found", status_code=404)
        with open(path, "rb") as f:
            return Response(f.read(), media_type=e.get("mime") or "application/zip",
                            headers={"Content-Disposition": f'attachment; filename="{e["filename"]}"'})

    @router.get("/sync/search")
    def search(keywords: str = Query(""), tool: str = Query("")):
        data = [{
            "UID": e["hash"], "Name": e["name"], "Hash": e["hash"], "PrimaryKey": i + 1,
            "SubmissionDateTime": e["submitted"], "SubmissionUser": e.get("creator", ""),
            "CreatorUid": e.get("creator", ""), "Keywords": e.get("keywords", []), "MIMEType": e.get("mime"),
            "Size": e["size"], "Tool": e.get("tool", "public"), "Expiration": -1,
        } for i, e in enumerate(bridge.packages.list())
            if (not tool or e.get("tool", "public") == tool)]
        return JSONResponse({"resultCount": len(data), "results": data})

    @router.put("/api/sync/metadata/{h}/tool")
    async def set_tool(h: str, request: Request):
        bridge.packages.set_tool(h.lower(), (await request.body()).decode() or "public")
        return PlainTextResponse("ok")

    @router.get("/api/sync/metadata/{h}/tool")
    def get_tool(h: str):
        e = bridge.packages.get(h)
        return PlainTextResponse(e.get("tool", "public") if e else "", status_code=200 if e else 404)

    return router
