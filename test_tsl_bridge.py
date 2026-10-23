"""Tests for tsl_bridge.py entry formatting and delivery."""

import http.server
import json
import threading
import time

import tsl_bridge as tb


def test_entries():
    mg = lambda lat, lng: "33U UU 91779 20072"
    r = tb.radio_entry({"started": "2026-10-23T10:05:00+02:00", "source": "Kanal Zug 1", "frequency": 446.00625, "text": "Hier Alpha"})
    assert r["art"] == "Meldung" and "Hier Alpha" in r["inhalt"] and "446.00625" in r["von"] and len(r["zeit"]) == 5
    a = tb.alert_entry({"kind": "911", "label": "911-Notruf", "callsign": "VIPER", "lat": 52.5, "lng": 13.4, "source": "tak"}, mg)
    assert a["art"] == "Anforderung" and "33U UU" in a["inhalt"] and "ATAK" in a["inhalt"]
    m = tb.report_entry({"kind": "medevac", "callsign": "MED1", "fields": {"urgent": "2", "hoist": "false", "mgrs": "32U"}, "remarks": "Bein"}, mg)
    assert m["art"] == "Anforderung" and "urgent: 2" in m["inhalt"] and "hoist" not in m["inhalt"] and "Ort 32U" in m["inhalt"]
    v = tb.video_entry({"stream_name": "Tor", "label": "person", "count": 2, "confidence": 0.9, "bearing": 45})
    assert v["art"] == "Feindmeldung" and "45°" in v["inhalt"]


def test_delivery_to_tsl():
    got = []

    class H(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            got.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"]))), self.headers.get("X-API-Key")))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    cfg = {"tsl_url": f"http://127.0.0.1:{srv.server_port}", "tsl_api_key": "k1", "tsl_forward": {"radio": False}}
    b = tb.TslBridge(lambda: cfg, lambda a, b: "MGRS")
    b.radio({"text": "nicht senden"})
    b.alert({"kind": "in_contact", "label": "TIC", "callsign": "A"})
    b.video({"alert": False, "label": "car"})
    for _ in range(50):
        if got:
            break
        time.sleep(0.05)
    time.sleep(0.2)
    srv.shutdown()
    assert len(got) == 1 and got[0][0] == "/api/log" and got[0][1]["ext"] is True and got[0][2] == "k1"
    assert got[0][1]["art"] == "Feindmeldung"
