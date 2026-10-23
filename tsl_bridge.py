#!/usr/bin/env python3
"""
tsl_bridge.py - Feed the TSL situation log (Lagetagebuch) from LPU5

Radio transcripts, emergency alerts (LPU5 and ATAK), reports (MEDEVAC,
SALUTE, SITREP, spot) and AI video alarms are appended to the TSL log of the
TOC automatically (POST /api/log on the TSL server, flagged as external
entries so TSL clients keep them).

config.json:
    "tsl_url":     "http://127.0.0.1:5008"   (empty = off)
    "tsl_api_key": ""                         (TSL env TSL_API_KEY, optional)
    "tsl_forward": {"radio": true, "alerts": true, "reports": true, "video_alerts": true}

Entries are queued and sent by a background thread, so a TSL server that is
down never slows LPU5 down; they are retried for a while.
"""

from __future__ import annotations

import datetime as dt
import logging
import queue
import threading
import time
from typing import Any, Callable, Dict, Optional

import requests

logger = logging.getLogger("lpu5-tsl")

REPORT_ART = {"medevac": "Anforderung", "salute": "Feindmeldung", "spot": "Feindmeldung", "sitrep": "Truppenmeldung"}
REPORT_TITLE = {"medevac": "MEDEVAC 9-Liner", "salute": "SALUTE", "spot": "Spot-Meldung", "sitrep": "Lagemeldung"}
ALERT_ART = {"911": "Anforderung", "in_contact": "Feindmeldung", "ring_the_bell": "Meldung",
             "geofence_breached": "Meldung", "cancel": "Meldung"}


def _hhmm(ts: Optional[str] = None) -> str:
    if ts:
        try:
            t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return t.astimezone().strftime("%H:%M")
        except ValueError:
            pass
    return dt.datetime.now().strftime("%H:%M")


def radio_entry(e: Dict[str, Any]) -> Dict[str, Any]:
    freq = f" ({e['frequency']:.5f} MHz)" if e.get("frequency") else ""
    return {"zeit": _hhmm(e.get("started")), "von": f"Funk{freq}", "an": "", "art": "Meldung",
            "inhalt": f"[{e.get('source', 'Funk')}] {e.get('text', '')}"}


def alert_entry(a: Dict[str, Any], mgrs: Callable[[float, float], str]) -> Dict[str, Any]:
    where = mgrs(a.get("lat") or 0, a.get("lng") or 0) if a.get("lat") else ""
    src = "ATAK" if a.get("source") == "tak" else "LPU5"
    text = f"⚠ {a.get('label', a.get('kind'))} – {a.get('callsign', '')}" + (f" bei {where}" if where else "")
    if a.get("text"):
        text += f": {a['text']}"
    return {"zeit": _hhmm(a.get("timestamp")), "von": a.get("callsign") or src, "an": "TOC",
            "art": ALERT_ART.get(a.get("kind"), "Meldung"), "inhalt": f"{text} ({src})"}


def report_entry(r: Dict[str, Any], mgrs: Callable[[float, float], str]) -> Dict[str, Any]:
    kind = r.get("kind", "report")
    f = r.get("fields") or {}
    where = f.get("mgrs") or (mgrs(r.get("lat") or 0, r.get("lng") or 0) if r.get("lat") else "")
    body = "; ".join(f"{k}: {v}" for k, v in f.items() if v not in ("", None, "false") and k != "mgrs")
    text = f"{REPORT_TITLE.get(kind, kind)}" + (f" – Ort {where}" if where else "") + (f" – {body}" if body else "")
    if r.get("remarks"):
        text += f" – {r['remarks']}"
    return {"zeit": _hhmm(r.get("timestamp")), "von": r.get("callsign") or "?", "an": "TOC",
            "art": REPORT_ART.get(kind, "Meldung"), "inhalt": text}


def video_entry(ev: Dict[str, Any]) -> Dict[str, Any]:
    where = f", Peilung {ev['bearing']:.0f}°" if ev.get("bearing") is not None else ""
    return {"zeit": _hhmm(ev.get("timestamp")), "von": f"Video: {ev.get('stream_name', '')}", "an": "TOC",
            "art": "Feindmeldung",
            "inhalt": f"KI-Alarm: {ev.get('label')} ×{ev.get('count', 1)} ({ev.get('confidence', 0):.0%}){where}"}


class TslBridge:
    def __init__(self, settings: Callable[[], Dict[str, Any]], mgrs: Callable[[float, float], str]):
        self.settings = settings
        self.mgrs = mgrs
        self.q: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=2000)
        self.stats = {"sent": 0, "failed": 0, "last_error": ""}
        threading.Thread(target=self._run, name="tsl-bridge", daemon=True).start()

    def _cfg(self):
        cfg = self.settings() or {}
        fwd = {"radio": True, "alerts": True, "reports": True, "video_alerts": True}
        fwd.update(cfg.get("tsl_forward") or {})
        return (cfg.get("tsl_url") or "").rstrip("/"), cfg.get("tsl_api_key") or "", fwd

    def _put(self, kind: str, entry: Dict[str, Any]):
        url, _, fwd = self._cfg()
        if not url or not fwd.get(kind, True):
            return
        entry["ext"] = True
        try:
            self.q.put_nowait({"entry": entry, "tries": 0})
        except queue.Full:
            self.stats["failed"] += 1

    def radio(self, e):
        self._put("radio", radio_entry(e))

    def alert(self, a):
        self._put("alerts", alert_entry(a, self.mgrs))

    def report(self, r):
        self._put("reports", report_entry(r, self.mgrs))

    def video(self, ev):
        if ev.get("alert"):
            self._put("video_alerts", video_entry(ev))

    def _run(self):
        session = requests.Session()
        while True:
            item = self.q.get()
            url, key, _ = self._cfg()
            if not url:
                continue
            try:
                r = session.post(f"{url}/api/log", json=item["entry"], timeout=5,
                                 headers={"X-API-Key": key} if key else {})
                r.raise_for_status()
                self.stats["sent"] += 1
            except Exception as e:
                self.stats["last_error"] = str(e)
                item["tries"] += 1
                if item["tries"] < 30:  # ~15 minutes
                    time.sleep(min(30, 2 * item["tries"]))
                    try:
                        self.q.put_nowait(item)
                    except queue.Full:
                        pass
                else:
                    self.stats["failed"] += 1
                    logger.warning("TSL entry dropped after retries: %s", e)
