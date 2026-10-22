#!/usr/bin/env python3
"""
video_analytics.py - Live video ingest and YOLOv8 analysis for LPU5 Tactical

Brings the YOLO_V8 / ARGUS detection pipeline into the LPU5 server:

* Video sources: RTSP / HTTP(S) / MJPEG URLs, local cameras (index), video
  files, and camera frames that EUDs or the stream page relay over the LPU5
  WebSocket (``camera_frame`` messages, source ``relay:<streamId>``).
* Per-stream worker thread: grabs frames, runs YOLO (ultralytics) when
  analytics are enabled, draws boxes, keeps the latest JPEG in memory.
* Outputs: annotated MJPEG stream and snapshots for browsers / EUDs,
  detection events over the WebSocket channel ``video_analytics`` and,
  optionally, map markers (forwarded as CoT to ATAK/WinTAK by the server).
* Geo-referencing: if a stream has a camera position, heading and
  horizontal field of view, each detection gets a bearing from the camera
  and an approximate position at the configured range.

OpenCV, numpy and ultralytics are optional: without them the API still
works, relay streams are passed through and the status endpoint reports
what is missing.
"""

from __future__ import annotations

import base64
import json
import logging
import math
import os
import threading
import time
import uuid
from collections import deque
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Body, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import Response, StreamingResponse

logger = logging.getLogger("lpu5-video")

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    CV2_AVAILABLE = True
except Exception:  # pragma: no cover - depends on host
    cv2 = None
    np = None
    CV2_AVAILABLE = False

try:
    from ultralytics import YOLO  # type: ignore
    YOLO_AVAILABLE = True
except Exception:  # pragma: no cover - depends on host
    YOLO = None
    YOLO_AVAILABLE = False

DEFAULT_MODEL = "yolov8n.pt"
DETECTION_EVENT_INTERVAL = 5.0   # seconds between events per stream+class
MARKER_UPDATE_INTERVAL = 15.0    # seconds between marker updates per stream+class
RELAY_STALE_SECONDS = 10.0


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

def destination_point(lat: float, lng: float, bearing_deg: float, distance_m: float) -> tuple:
    """Great-circle destination from a start point, bearing and distance."""
    r = 6371008.8
    br = math.radians(bearing_deg)
    p1 = math.radians(lat)
    l1 = math.radians(lng)
    d = distance_m / r
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(br))
    l2 = l1 + math.atan2(math.sin(br) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


def detection_bearing(cfg: Dict[str, Any], cx_norm: float) -> Optional[float]:
    """Bearing of a detection from the camera, from its horizontal image position (0..1)."""
    heading = cfg.get("heading")
    hfov = cfg.get("hfov") or 60.0
    if heading is None:
        return None
    return (float(heading) + (cx_norm - 0.5) * float(hfov)) % 360


def geolocate(cfg: Dict[str, Any], cx_norm: float) -> Optional[Dict[str, float]]:
    lat, lng = cfg.get("lat"), cfg.get("lng")
    if lat is None or lng is None:
        return None
    brg = detection_bearing(cfg, cx_norm)
    rng = cfg.get("range_m")
    if brg is None or not rng:
        return {"lat": float(lat), "lng": float(lng), "bearing": brg, "approx": True, "at_camera": True}
    plat, plng = destination_point(float(lat), float(lng), brg, float(rng))
    return {"lat": plat, "lng": plng, "bearing": brg, "approx": True, "at_camera": False}


# ---------------------------------------------------------------------------
# Model cache
# ---------------------------------------------------------------------------

class ModelCache:
    def __init__(self, base_path: str):
        self.base_path = base_path
        self._models: Dict[str, Any] = {}
        self._locks: Dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def resolve(self, name: Optional[str]) -> str:
        name = name or DEFAULT_MODEL
        for candidate in (name, os.path.join(self.base_path, name), os.path.join(self.base_path, "models", name)):
            if os.path.isfile(candidate):
                return candidate
        return name  # ultralytics downloads official weights (yolov8n.pt …) on first use

    def get(self, name: Optional[str]):
        if not YOLO_AVAILABLE:
            raise RuntimeError("ultralytics ist nicht installiert (pip install ultralytics)")
        path = self.resolve(name)
        with self._guard:
            if path not in self._models:
                logger.info("Loading YOLO model %s", path)
                self._models[path] = YOLO(path)
                self._locks[path] = threading.Lock()
            return self._models[path], self._locks[path]

    def available(self) -> List[str]:
        found = set()
        for d in (self.base_path, os.path.join(self.base_path, "models")):
            if os.path.isdir(d):
                for f in os.listdir(d):
                    if f.endswith(".pt") or f.endswith(".onnx"):
                        found.add(f)
        found.add(DEFAULT_MODEL)
        return sorted(found)


# ---------------------------------------------------------------------------
# Stream worker
# ---------------------------------------------------------------------------

class VideoStream:
    """One configured video source with its capture/analysis thread."""

    def __init__(self, cfg: Dict[str, Any], manager: "VideoAnalyticsManager"):
        self.cfg = cfg
        self.manager = manager
        self.thread: Optional[threading.Thread] = None
        self.stop_event = threading.Event()
        self.frame_cond = threading.Condition()
        self.jpeg: Optional[bytes] = None
        self.frame_seq = 0
        self.status = "stopped"
        self.error = ""
        self.fps = 0.0
        self.last_frame_at = 0.0
        self.detections: deque = deque(maxlen=200)
        self.last_event: Dict[str, float] = {}
        self.last_marker: Dict[str, float] = {}
        # relay input (frames pushed via WebSocket)
        self._relay_frame: Optional[bytes] = None
        self._relay_seq = 0
        self._relay_cond = threading.Condition()

    @property
    def id(self) -> str:
        return self.cfg["id"]

    @property
    def is_relay(self) -> bool:
        return str(self.cfg.get("source", "")).startswith("relay:")

    def info(self) -> Dict[str, Any]:
        c = self.cfg
        return {
            "id": c["id"],
            "name": c.get("name") or c["id"],
            "source": c.get("source", "") if not c.get("hide_source") else "",
            "source_type": self.source_type(),
            "analytics": bool(c.get("analytics")),
            "model": c.get("model") or DEFAULT_MODEL,
            "confidence": c.get("confidence", 0.4),
            "classes": c.get("classes") or [],
            "alert_classes": c.get("alert_classes") or [],
            "create_markers": bool(c.get("create_markers")),
            "marker_type": c.get("marker_type", "unknown"),
            "lat": c.get("lat"), "lng": c.get("lng"), "heading": c.get("heading"),
            "hfov": c.get("hfov"), "range_m": c.get("range_m"),
            "autostart": bool(c.get("autostart", True)),
            "running": self.status in ("running", "connecting", "waiting"),
            "status": self.status,
            "error": self.error,
            "fps": round(self.fps, 1),
            "last_frame_age": round(time.time() - self.last_frame_at, 1) if self.last_frame_at else None,
        }

    def source_type(self) -> str:
        s = str(self.cfg.get("source", ""))
        if s.startswith("relay:"):
            return "relay"
        if s.isdigit():
            return "camera"
        if s.startswith("rtsp"):
            return "rtsp"
        if s.startswith("http"):
            return "http"
        return "file"

    # -- lifecycle --

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.error = ""
        self.status = "connecting"
        self.thread = threading.Thread(target=self._run, name=f"video-{self.id}", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        with self._relay_cond:
            self._relay_cond.notify_all()
        if self.thread:
            self.thread.join(timeout=5)
        self.status = "stopped"

    def push_relay_frame(self, jpeg: bytes):
        with self._relay_cond:
            self._relay_frame = jpeg
            self._relay_seq += 1
            self._relay_cond.notify_all()

    # -- frame sources --

    def _frames(self):
        """Yield BGR frames (numpy) or raw JPEG bytes when OpenCV is missing."""
        if self.is_relay:
            seen = 0
            while not self.stop_event.is_set():
                with self._relay_cond:
                    if self._relay_seq == seen:
                        self._relay_cond.wait(timeout=1.0)
                    if self._relay_seq == seen:
                        if self.last_frame_at and time.time() - self.last_frame_at > RELAY_STALE_SECONDS:
                            self.status = "waiting"
                        elif not self.last_frame_at:
                            self.status = "waiting"
                        continue
                    seen = self._relay_seq
                    data = self._relay_frame
                if not CV2_AVAILABLE:
                    yield data
                    continue
                frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is not None:
                    yield frame
            return

        if not CV2_AVAILABLE:
            raise RuntimeError("OpenCV ist nicht installiert (pip install opencv-python-headless)")
        src = str(self.cfg.get("source", ""))
        cap_src: Any = int(src) if src.isdigit() else src
        backoff = 2.0
        while not self.stop_event.is_set():
            self.status = "connecting"
            if isinstance(cap_src, str) and cap_src.startswith("rtsp"):
                os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
            cap = cv2.VideoCapture(cap_src)
            if not cap.isOpened():
                self.error = f"Quelle nicht erreichbar: {src}"
                self.status = "error"
                self.stop_event.wait(backoff)
                backoff = min(backoff * 2, 30)
                continue
            backoff = 2.0
            self.error = ""
            is_file = self.source_type() == "file"
            src_fps = cap.get(cv2.CAP_PROP_FPS) or 25
            try:
                while not self.stop_event.is_set():
                    ok, frame = cap.read()
                    if not ok:
                        if is_file and self.cfg.get("loop", True):
                            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                            continue
                        self.error = "Stream unterbrochen – verbinde neu"
                        break
                    if is_file:
                        time.sleep(1.0 / src_fps)
                    yield frame
            finally:
                cap.release()
            if not self.stop_event.is_set():
                self.status = "connecting"
                self.stop_event.wait(2)

    # -- main loop --

    def _run(self):
        max_fps = float(self.cfg.get("max_fps") or 8)
        min_dt = 1.0 / max(0.5, max_fps)
        last_proc = 0.0
        fps_window: deque = deque(maxlen=20)
        try:
            for frame in self._frames():
                if self.stop_event.is_set():
                    break
                now = time.time()
                if now - last_proc < min_dt:
                    continue  # drop frames to keep latency low
                last_proc = now
                self.status = "running"
                try:
                    jpeg = self._process(frame)
                except Exception as e:  # keep the stream alive on analysis errors
                    logger.warning("video %s: analysis error: %s", self.id, e)
                    self.error = f"Analysefehler: {e}"
                    jpeg = frame if isinstance(frame, (bytes, bytearray)) else self._encode(frame)
                fps_window.append(now)
                if len(fps_window) > 1:
                    self.fps = (len(fps_window) - 1) / max(1e-6, fps_window[-1] - fps_window[0])
                self.last_frame_at = now
                with self.frame_cond:
                    self.jpeg = jpeg
                    self.frame_seq += 1
                    self.frame_cond.notify_all()
        except Exception as e:
            logger.error("video %s stopped: %s", self.id, e)
            self.error = str(e)
            self.status = "error"
            return
        if self.status != "error":
            self.status = "stopped"

    def _encode(self, frame) -> bytes:
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
        return buf.tobytes() if ok else b""

    def _process(self, frame) -> bytes:
        if isinstance(frame, (bytes, bytearray)):  # no OpenCV: pass-through relay
            return bytes(frame)
        if not self.cfg.get("analytics") or not YOLO_AVAILABLE:
            return self._encode(frame)
        model, lock = self.manager.models.get(self.cfg.get("model"))
        conf = float(self.cfg.get("confidence", 0.4))
        with lock:
            results = model.predict(frame, conf=conf, imgsz=int(self.cfg.get("imgsz", 640)), verbose=False)
        res = results[0]
        names = res.names
        wanted = set(self.cfg.get("classes") or [])
        h, w = frame.shape[:2]
        found = []
        for box in res.boxes:
            label = names.get(int(box.cls[0]), str(int(box.cls[0]))) if isinstance(names, dict) else names[int(box.cls[0])]
            if wanted and label not in wanted:
                continue
            x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]
            found.append({
                "label": label,
                "confidence": float(box.conf[0]),
                "box": [x1 / w, y1 / h, x2 / w, y2 / h],
            })
        annotated = self._draw(frame, found)
        if found:
            self._report(found)
        return self._encode(annotated)

    def _draw(self, frame, found):
        alert = set(self.cfg.get("alert_classes") or [])
        h, w = frame.shape[:2]
        for d in found:
            x1, y1, x2, y2 = d["box"]
            p1, p2 = (int(x1 * w), int(y1 * h)), (int(x2 * w), int(y2 * h))
            color = (0, 0, 255) if d["label"] in alert else (0, 220, 255)
            cv2.rectangle(frame, p1, p2, color, 2)
            txt = f"{d['label']} {d['confidence']:.0%}"
            (tw, th), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
            cv2.rectangle(frame, (p1[0], p1[1] - th - 6), (p1[0] + tw + 4, p1[1]), color, -1)
            cv2.putText(frame, txt, (p1[0] + 2, p1[1] - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S") + f"  {self.cfg.get('name', self.id)}"
        cv2.putText(frame, stamp, (8, h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        return frame

    def _report(self, found: List[Dict[str, Any]]):
        """Record detections; emit throttled events and markers per class."""
        now = time.time()
        alert = set(self.cfg.get("alert_classes") or [])
        best: Dict[str, Dict[str, Any]] = {}
        for d in found:
            if d["label"] not in best or d["confidence"] > best[d["label"]]["confidence"]:
                best[d["label"]] = d
        for label, d in best.items():
            cx = (d["box"][0] + d["box"][2]) / 2
            event = {
                "id": str(uuid.uuid4()),
                "stream_id": self.id,
                "stream_name": self.cfg.get("name") or self.id,
                "label": label,
                "confidence": round(d["confidence"], 3),
                "count": sum(1 for x in found if x["label"] == label),
                "box": [round(v, 4) for v in d["box"]],
                "alert": label in alert,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            }
            geo = geolocate(self.cfg, cx)
            if geo:
                event.update(geo)
            self.detections.appendleft(event)
            if now - self.last_event.get(label, 0) >= DETECTION_EVENT_INTERVAL:
                self.last_event[label] = now
                self.manager.emit_detection(event)
            if self.cfg.get("create_markers") and geo and now - self.last_marker.get(label, 0) >= MARKER_UPDATE_INTERVAL:
                self.last_marker[label] = now
                self.manager.emit_marker(self, event)

    # -- outputs --

    def wait_frame(self, last_seq: int, timeout: float = 5.0):
        with self.frame_cond:
            if self.frame_seq == last_seq:
                self.frame_cond.wait(timeout=timeout)
            return self.frame_seq, self.jpeg


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------

class VideoAnalyticsManager:
    def __init__(self, base_path: str,
                 broadcast: Optional[Callable[[str, str, Dict[str, Any]], None]] = None,
                 marker_sink: Optional[Callable[[Dict[str, Any]], None]] = None):
        self.base_path = base_path
        self.config_path = os.path.join(base_path, "video_streams.json")
        self.models = ModelCache(base_path)
        self.broadcast = broadcast
        self.marker_sink = marker_sink
        self.streams: Dict[str, VideoStream] = {}
        self.lock = threading.Lock()
        # Relay streams that were not configured explicitly are created on the
        # fly when an EUD shares its camera (setting auto_relay).
        self.settings: Dict[str, Any] = {"auto_relay": True, "auto_relay_analytics": True}
        self._load()

    # -- persistence --

    def _load(self):
        if not os.path.isfile(self.config_path):
            return
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            logger.error("Cannot read %s: %s", self.config_path, e)
            return
        self.settings.update(data.get("settings") or {})
        for cfg in data.get("streams", []):
            if cfg.get("id"):
                self.streams[cfg["id"]] = VideoStream(cfg, self)

    def _save(self):
        data = {
            "settings": self.settings,
            "streams": [s.cfg for s in self.streams.values() if not s.cfg.get("ephemeral")],
        }
        tmp = self.config_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, self.config_path)

    def start_autostart(self):
        for s in self.streams.values():
            if s.cfg.get("autostart", True) and not s.is_relay:
                s.start()

    def shutdown(self):
        for s in list(self.streams.values()):
            s.stop()

    # -- CRUD --

    ALLOWED_KEYS = {
        "name", "source", "analytics", "model", "confidence", "classes", "alert_classes",
        "create_markers", "marker_type", "lat", "lng", "heading", "hfov", "range_m",
        "max_fps", "imgsz", "autostart", "loop", "hide_source",
    }

    def _clean(self, data: Dict[str, Any]) -> Dict[str, Any]:
        cfg = {k: v for k, v in data.items() if k in self.ALLOWED_KEYS}
        for k in ("classes", "alert_classes"):
            if isinstance(cfg.get(k), str):
                cfg[k] = [c.strip() for c in cfg[k].split(",") if c.strip()]
        for k in ("lat", "lng", "heading", "hfov", "range_m", "confidence", "max_fps"):
            if k in cfg:
                cfg[k] = None if cfg[k] in ("", None) else float(cfg[k])
        if "imgsz" in cfg and cfg["imgsz"] not in ("", None):
            cfg["imgsz"] = int(cfg["imgsz"])
        return cfg

    def create(self, data: Dict[str, Any]) -> VideoStream:
        cfg = self._clean(data)
        if not cfg.get("source"):
            raise ValueError("source ist erforderlich")
        cfg["id"] = data.get("id") or f"vs-{uuid.uuid4().hex[:8]}"
        cfg.setdefault("name", cfg["id"])
        with self.lock:
            if cfg["id"] in self.streams:
                raise ValueError("Stream-ID existiert bereits")
            s = VideoStream(cfg, self)
            self.streams[cfg["id"]] = s
            self._save()
        if cfg.get("autostart", True):
            s.start()
        return s

    def update(self, stream_id: str, data: Dict[str, Any]) -> VideoStream:
        s = self.get(stream_id)
        was_running = s.status != "stopped"
        restart = any(k in data for k in ("source",)) and was_running
        if restart:
            s.stop()
        s.cfg.update(self._clean(data))
        s.cfg.pop("ephemeral", None)  # editing a relay stream makes it permanent
        with self.lock:
            self._save()
        if restart:
            s.start()
        return s

    def delete(self, stream_id: str):
        s = self.get(stream_id)
        s.stop()
        with self.lock:
            self.streams.pop(stream_id, None)
            self._save()

    def get(self, stream_id: str) -> VideoStream:
        s = self.streams.get(stream_id)
        if not s:
            raise KeyError(stream_id)
        return s

    # -- relay ingest (WebSocket camera_frame) --

    def feed_frame(self, relay_id: str, frame: str, meta: Optional[Dict[str, Any]] = None):
        """Accept a base64/data-URL JPEG relayed over the LPU5 WebSocket."""
        if not frame:
            return
        sid = f"relay-{relay_id}"
        s = self.streams.get(sid)
        if s is None:
            if not self.settings.get("auto_relay", True):
                return
            meta = meta or {}
            cfg = {
                "id": sid,
                "name": meta.get("name") or f"Kamera {relay_id}",
                "source": f"relay:{relay_id}",
                "analytics": bool(self.settings.get("auto_relay_analytics", True)) and YOLO_AVAILABLE,
                "confidence": 0.4,
                "ephemeral": True,
                "autostart": True,
            }
            with self.lock:
                s = self.streams.setdefault(sid, VideoStream(cfg, self))
        if s.status == "stopped" and s.cfg.get("autostart", True):
            s.start()
        if meta:
            for k in ("lat", "lng", "heading"):
                if meta.get(k) is not None:
                    s.cfg[k] = float(meta[k])
        if "," in frame[:64]:
            frame = frame.split(",", 1)[1]
        try:
            s.push_relay_frame(base64.b64decode(frame))
        except Exception:
            pass

    # -- events --

    def emit_detection(self, event: Dict[str, Any]):
        if self.broadcast:
            try:
                self.broadcast("video_analytics", "video_detection", event)
            except Exception as e:
                logger.debug("detection broadcast failed: %s", e)

    def emit_marker(self, stream: VideoStream, event: Dict[str, Any]):
        if not self.marker_sink:
            return
        cfg = stream.cfg
        marker = {
            "id": f"VA-{stream.id}-{event['label']}".replace(" ", "_"),
            "lat": event["lat"],
            "lng": event["lng"],
            "name": f"{event['label']} ({cfg.get('name') or stream.id})",
            "type": cfg.get("marker_type") or "unknown",
            "description": (
                f"KI-Erkennung {event['label']} {event['confidence']:.0%}, Anzahl {event['count']}"
                + (f", Peilung {event['bearing']:.0f}°" if event.get("bearing") is not None else "")
                + (" – Position geschätzt" if event.get("approx") else "")
            ),
            "data": {
                "source": "video_analytics",
                "stream_id": stream.id,
                "label": event["label"],
                "confidence": event["confidence"],
                "bearing": event.get("bearing"),
                "approx": event.get("approx", True),
                "timestamp": event["timestamp"],
            },
        }
        try:
            self.marker_sink(marker)
        except Exception as e:
            logger.warning("marker sink failed: %s", e)

    # -- one-shot analysis --

    def analyze_image(self, data: bytes, model: Optional[str], conf: float) -> List[Dict[str, Any]]:
        if not (CV2_AVAILABLE and YOLO_AVAILABLE):
            raise RuntimeError("OpenCV und ultralytics werden für die Analyse benötigt")
        frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("Bild konnte nicht gelesen werden")
        m, lock = self.models.get(model)
        with lock:
            res = m.predict(frame, conf=conf, verbose=False)[0]
        h, w = frame.shape[:2]
        out = []
        for box in res.boxes:
            x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]
            out.append({
                "label": res.names[int(box.cls[0])],
                "confidence": round(float(box.conf[0]), 3),
                "box": [x1 / w, y1 / h, x2 / w, y2 / h],
            })
        return out

    def status(self) -> Dict[str, Any]:
        return {
            "opencv": CV2_AVAILABLE,
            "yolo": YOLO_AVAILABLE,
            "models": self.models.available(),
            "settings": self.settings,
            "streams": len(self.streams),
            "running": sum(1 for s in self.streams.values() if s.status == "running"),
        }


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------

def create_router(manager: VideoAnalyticsManager,
                  verify_token: Callable[[str], Optional[Dict[str, Any]]]) -> APIRouter:
    router = APIRouter(prefix="/api/video", tags=["video-analytics"])

    def auth(authorization: Optional[str], token: Optional[str]) -> Dict[str, Any]:
        raw = token
        if not raw and authorization:
            raw = authorization[7:].strip() if authorization.lower().startswith("bearer ") else authorization.strip()
        payload = verify_token(raw) if raw else None
        if not payload:
            raise HTTPException(status_code=401, detail="Nicht angemeldet")
        return payload

    def stream_or_404(stream_id: str) -> VideoStream:
        try:
            return manager.get(stream_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Stream nicht gefunden")

    @router.get("/status")
    def video_status(authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
        auth(authorization, token)
        return manager.status()

    @router.put("/settings")
    def video_settings(data: Dict[str, Any] = Body(...), authorization: Optional[str] = Header(None)):
        auth(authorization, None)
        for k in ("auto_relay", "auto_relay_analytics"):
            if k in data:
                manager.settings[k] = bool(data[k])
        with manager.lock:
            manager._save()
        return manager.status()

    @router.get("/streams")
    def list_streams(authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
        auth(authorization, token)
        return {"streams": [s.info() for s in manager.streams.values()]}

    @router.post("/streams")
    def create_stream(data: Dict[str, Any] = Body(...), authorization: Optional[str] = Header(None)):
        auth(authorization, None)
        try:
            s = manager.create(data)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"status": "success", "stream": s.info()}

    @router.put("/streams/{stream_id}")
    def update_stream(stream_id: str, data: Dict[str, Any] = Body(...), authorization: Optional[str] = Header(None)):
        auth(authorization, None)
        stream_or_404(stream_id)
        return {"status": "success", "stream": manager.update(stream_id, data).info()}

    @router.delete("/streams/{stream_id}")
    def delete_stream(stream_id: str, authorization: Optional[str] = Header(None)):
        auth(authorization, None)
        stream_or_404(stream_id)
        manager.delete(stream_id)
        return {"status": "success"}

    @router.post("/streams/{stream_id}/start")
    def start_stream(stream_id: str, authorization: Optional[str] = Header(None)):
        auth(authorization, None)
        s = stream_or_404(stream_id)
        s.start()
        return {"status": "success", "stream": s.info()}

    @router.post("/streams/{stream_id}/stop")
    def stop_stream(stream_id: str, authorization: Optional[str] = Header(None)):
        auth(authorization, None)
        s = stream_or_404(stream_id)
        s.stop()
        return {"status": "success", "stream": s.info()}

    @router.get("/streams/{stream_id}/detections")
    def stream_detections(stream_id: str, limit: int = 50, authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
        auth(authorization, token)
        s = stream_or_404(stream_id)
        return {"detections": list(s.detections)[: max(1, min(limit, 200))]}

    @router.get("/streams/{stream_id}/snapshot.jpg")
    def snapshot(stream_id: str, authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
        auth(authorization, token)
        s = stream_or_404(stream_id)
        if not s.jpeg:
            raise HTTPException(status_code=503, detail="Noch kein Bild")
        return Response(content=s.jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @router.get("/streams/{stream_id}/mjpeg")
    def mjpeg(stream_id: str, authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
        # <img src> cannot send headers, so the token is also accepted as query parameter.
        auth(authorization, token)
        s = stream_or_404(stream_id)
        if s.status == "stopped" and s.cfg.get("autostart", True) and not s.is_relay:
            s.start()

        def gen():
            seq = -1
            idle_since = time.time()
            while True:
                new_seq, jpeg = s.wait_frame(seq, timeout=5.0)
                if new_seq == seq or not jpeg:
                    if time.time() - idle_since > 120:
                        return  # source dead for 2 min – let the client reconnect
                    continue
                idle_since = time.time()
                seq = new_seq
                yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                       + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")

        return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    @router.post("/analyze")
    async def analyze(file: UploadFile = File(...), model: Optional[str] = Query(None), confidence: float = Query(0.4),
                      authorization: Optional[str] = Header(None)):
        auth(authorization, None)
        data = await file.read()
        try:
            return {"detections": manager.analyze_image(data, model, confidence)}
        except (RuntimeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e))

    return router
