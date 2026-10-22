"""Tests for video_analytics.py (run: python -m pytest test_video_analytics.py)."""

import base64
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import video_analytics as va


def test_destination_point_north_1km():
    lat, lng = va.destination_point(52.0, 13.0, 0, 1000)
    assert abs(lat - 52.008993) < 1e-4
    assert abs(lng - 13.0) < 1e-9


def test_detection_bearing_uses_hfov():
    cfg = {"heading": 90, "hfov": 60}
    assert va.detection_bearing(cfg, 0.5) == 90
    assert va.detection_bearing(cfg, 0.0) == 60
    assert va.detection_bearing(cfg, 1.0) == 120
    assert va.detection_bearing({"heading": 350, "hfov": 60}, 1.0) == 20


def test_geolocate_variants():
    assert va.geolocate({}, 0.5) is None
    at_cam = va.geolocate({"lat": 1.0, "lng": 2.0}, 0.5)
    assert at_cam["at_camera"] and at_cam["lat"] == 1.0
    projected = va.geolocate({"lat": 52.0, "lng": 13.0, "heading": 0, "hfov": 60, "range_m": 1000}, 0.5)
    assert not projected["at_camera"] and projected["lat"] > 52.0


@pytest.fixture
def manager(tmp_path):
    events, markers = [], []
    m = va.VideoAnalyticsManager(str(tmp_path), broadcast=lambda c, t, d: events.append((c, t, d)),
                                 marker_sink=markers.append)
    m._events, m._markers = events, markers
    yield m
    m.shutdown()


@pytest.fixture
def client(manager):
    app = FastAPI()
    app.include_router(va.create_router(manager, lambda t: {"username": "u"} if t == "good" else None))
    return TestClient(app)


def test_api_requires_token(client):
    assert client.get("/api/video/streams").status_code == 401
    assert client.get("/api/video/streams?token=bad").status_code == 401
    assert client.get("/api/video/streams", headers={"Authorization": "Bearer good"}).status_code == 200


def test_crud_and_persistence(client, manager, tmp_path):
    h = {"Authorization": "Bearer good"}
    r = client.post("/api/video/streams", json={"name": "Tor", "source": "rtsp://127.0.0.1:1/x", "autostart": False,
                                                 "classes": "person, car", "lat": "52.1", "heading": ""}, headers=h)
    assert r.status_code == 200, r.text
    s = r.json()["stream"]
    assert s["classes"] == ["person", "car"] and s["lat"] == 52.1 and s["heading"] is None
    assert client.post("/api/video/streams", json={"name": "x"}, headers=h).status_code == 400
    r = client.put(f"/api/video/streams/{s['id']}", json={"analytics": True}, headers=h)
    assert r.json()["stream"]["analytics"] is True
    # reload from disk
    m2 = va.VideoAnalyticsManager(str(tmp_path))
    assert s["id"] in m2.streams
    assert client.delete(f"/api/video/streams/{s['id']}", headers=h).status_code == 200
    assert client.get(f"/api/video/streams/{s['id']}/detections", headers=h).status_code == 404


@pytest.mark.skipif(not va.CV2_AVAILABLE, reason="OpenCV not installed")
def test_relay_frames_produce_snapshot(client, manager):
    import cv2
    import numpy as np
    img = np.zeros((120, 160, 3), dtype=np.uint8)
    img[:, :80] = (0, 0, 255)
    ok, buf = cv2.imencode(".jpg", img)
    data_url = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()
    manager.settings["auto_relay_analytics"] = False
    for _ in range(5):
        manager.feed_frame("eud-test", data_url, {"name": "Testkamera", "lat": 1.5, "lng": 2.5})
        time.sleep(0.2)
    s = manager.get("relay-eud-test")
    assert s.cfg["lat"] == 1.5 and s.status == "running"
    r = client.get("/api/video/streams/relay-eud-test/snapshot.jpg?token=good")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    # relay streams are not persisted
    manager._save()
    assert "relay-eud-test" not in open(manager.config_path).read()


def test_report_throttles_events_and_markers(manager):
    s = va.VideoStream({"id": "t", "name": "T", "source": "relay:t", "create_markers": True,
                        "lat": 52.0, "lng": 13.0, "heading": 0, "hfov": 60, "range_m": 500,
                        "alert_classes": ["person"]}, manager)
    found = [{"label": "person", "confidence": 0.9, "box": [0.4, 0.4, 0.6, 0.8]},
             {"label": "person", "confidence": 0.5, "box": [0.1, 0.1, 0.2, 0.2]}]
    s._report(found)
    s._report(found)  # within throttle window
    assert len(manager._events) == 1
    ch, typ, ev = manager._events[0]
    assert (ch, typ) == ("video_analytics", "video_detection")
    assert ev["count"] == 2 and ev["alert"] and ev["confidence"] == 0.9
    assert len(manager._markers) == 1
    mk = manager._markers[0]
    assert mk["id"] == "VA-t-person" and mk["lat"] > 52.0
    assert len(s.detections) == 2
