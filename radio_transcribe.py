#!/usr/bin/env python3
"""
radio_transcribe.py - Radio traffic transcription (Whisper) for LPU5 Tactical

Port of the FunkLog_USB_Whisper logic into the LPU5 server:

* Audio sources: the RTL-SDR (rtl_fm, demodulated) or a USB sound card input
  connected to a radio's audio output (sounddevice/PortAudio), plus uploaded
  recordings.
* Segmentation into transmissions by level threshold and speech pause
  (20 ms frames, 400 ms pre-roll, maximum segment length).
* Durable queue: every segment is written as WAV + JSON before it is
  transcribed, so nothing is lost when the server stops; pending jobs are
  processed on the next start.
* faster-whisper with automatic NVIDIA GPU / CPU (int8) selection, model kept
  in memory.
* Every transcript is stored in SQLite (radio_log/funklog.sqlite3), appended
  to a text log and pushed live over the WebSocket channel ``radio`` – the
  log on screen is the same record that gets exported.

While transcription runs on the SDR, the SDR audio endpoint taps into the
same audio (one RTL-SDR stick can only be opened by one process).

All heavy dependencies (numpy, scipy, faster-whisper, sounddevice) are
optional; /api/radio/status reports what is missing.
"""

from __future__ import annotations

import datetime as dt
import gc
import json
import logging
import math
import os
import queue
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
import wave
from collections import deque
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Body, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse

logger = logging.getLogger("lpu5-radio")

try:
    import numpy as np  # type: ignore
    NUMPY_AVAILABLE = True
except Exception:  # pragma: no cover
    np = None
    NUMPY_AVAILABLE = False


def _has(module: str) -> bool:
    try:
        __import__(module)
        return True
    except Exception:
        return False


FRAME_SECONDS = 0.02
MODELS = ["tiny", "base", "small", "medium", "large-v3"]
DEFAULT_SETTINGS: Dict[str, Any] = {
    "source": "sdr",            # sdr | soundcard
    "frequency_mhz": 446.00625,  # PMR446 channel 1
    "mode": "fm",
    "gain": 30.0,
    "squelch": 0,
    "device": None,             # sound card index (None = default input)
    "channel_label": "",
    "language": "de",           # "" = automatic
    "model": "small",
    "processor": "Automatisch",  # Automatisch | CPU | NVIDIA-GPU
    "speed": "Schnell",         # Schnell | Genauer
    "threads": None,
    "threshold_db": -38.0,
    "pause_s": 1.0,
    "max_segment_s": 15.0,
    "keep_audio": False,
}


# ---------------------------------------------------------------------------
# Audio helpers (from FunkLog audio_core.py)
# ---------------------------------------------------------------------------

def level_db(samples) -> float:
    return float(20 * np.log10(max(1e-8, float(np.sqrt(np.mean(samples * samples))))))


class Segmenter:
    """Fixed 20 ms frames; 400 ms pre-roll, pause and hard duration limit."""

    def __init__(self, threshold=-38.0, pause=1.0, maximum=15.0):
        self.threshold = threshold
        self.pause_frames = max(1, round(pause / FRAME_SECONDS))
        self.maximum = max(1, round(maximum / FRAME_SECONDS))
        self.pre: deque = deque(maxlen=20)
        self.parts: list = []
        self.silent = 0
        self.voiced = 0
        self.start: Optional[float] = None

    def feed(self, frame, timestamp):
        active = level_db(frame) >= self.threshold
        if not self.parts:
            if not active:
                self.pre.append(frame)
                return None
            self.parts = list(self.pre)
            self.start = timestamp - len(self.pre) * FRAME_SECONDS
            self.pre.clear()
        self.parts.append(frame)
        self.voiced += int(active)
        self.silent = 0 if active else self.silent + 1
        if self.silent >= self.pause_frames or len(self.parts) >= self.maximum:
            return self.flush()
        return None

    def flush(self):
        result = None
        if self.parts and self.voiced >= 5:
            result = (self.start, np.concatenate(self.parts))
        self.parts, self.silent, self.voiced = [], 0, 0
        self.pre.clear()
        return result


def resample(samples, rate):
    if int(rate) == 16000:
        return samples.astype(np.float32)
    from scipy.signal import resample_poly
    divisor = math.gcd(int(rate), 16000)
    return resample_poly(samples, 16000 // divisor, int(rate) // divisor).astype(np.float32)


def write_wav(path, samples, rate):
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(int(rate))
        out.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())


def read_wav_16k(path):
    """Read a PCM16 WAV as mono float32 at 16 kHz (Whisper input)."""
    with wave.open(str(path), "rb") as source:
        if source.getsampwidth() != 2 or source.getcomptype() != "NONE":
            raise ValueError("WAV muss unkomprimiertes 16-Bit-PCM enthalten.")
        channels = source.getnchannels()
        rate = source.getframerate()
        raw = source.readframes(source.getnframes())
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != 16000 and samples.size:
        samples = resample(samples, rate)
    return np.ascontiguousarray(samples, dtype=np.float32)


# ---------------------------------------------------------------------------
# Journal (SQLite + text log)
# ---------------------------------------------------------------------------

class Journal:
    def __init__(self, directory: Path):
        self.directory = directory
        self.db = directory / "funklog.sqlite3"
        self.text_log = directory / "Funkprotokoll.txt"
        self.lock = threading.Lock()
        with self.connect() as con:
            con.execute("""CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY, started TEXT, source TEXT, frequency REAL,
                text TEXT, language TEXT, duration REAL, audio TEXT, job TEXT UNIQUE,
                created TEXT)""")

    def connect(self):
        return sqlite3.connect(self.db, timeout=30)

    def add(self, timestamp: float, source: str, frequency: Optional[float], text: str,
            language: str, duration: float, audio: str, job: str) -> Optional[Dict[str, Any]]:
        started = dt.datetime.fromtimestamp(timestamp).astimezone().isoformat(timespec="seconds")
        with self.lock, self.connect() as con:
            cur = con.execute(
                "INSERT OR IGNORE INTO entries(started,source,frequency,text,language,duration,audio,job,created)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (started, source, frequency, text, language, duration, audio, job,
                 dt.datetime.now().astimezone().isoformat(timespec="seconds")))
            if cur.rowcount == 0:
                return None
            entry_id = cur.lastrowid
        entry = {"id": entry_id, "started": started, "source": source, "frequency": frequency,
                 "text": text, "language": language, "duration": round(duration, 1), "has_audio": bool(audio)}
        try:
            with open(self.text_log, "a", encoding="utf-8") as f:
                f.write(f"[{started}] {source}\n{text}\n\n")
        except OSError as e:
            logger.warning("radio text log: %s", e)
        return entry

    def rows(self, limit: Optional[int] = 200, after_id: int = 0, query: str = "") -> List[Dict[str, Any]]:
        sql = "SELECT id,started,source,frequency,text,language,duration,audio FROM entries WHERE id > ?"
        args: list = [after_id]
        if query:
            sql += " AND text LIKE ?"
            args.append(f"%{query}%")
        sql += " ORDER BY id DESC"
        if limit:
            sql += " LIMIT ?"
            args.append(limit)
        with self.connect() as con:
            rows = con.execute(sql, args).fetchall()
        return [{"id": r[0], "started": r[1], "source": r[2], "frequency": r[3], "text": r[4],
                 "language": r[5], "duration": r[6], "has_audio": bool(r[7] and os.path.isfile(r[7]))}
                for r in reversed(rows)]

    def audio_path(self, entry_id: int) -> Optional[str]:
        with self.connect() as con:
            r = con.execute("SELECT audio FROM entries WHERE id=?", (entry_id,)).fetchone()
        return r[0] if r and r[0] and os.path.isfile(r[0]) else None

    def export_text(self) -> str:
        return "\n\n".join(
            f"[{e['started']}] {e['source']}" + (f" · {e['frequency']:.5f} MHz" if e["frequency"] else "") + f"\n{e['text']}"
            for e in self.rows(limit=None)) + "\n"


# ---------------------------------------------------------------------------
# Whisper model cache (from FunkLog whisper_backend.py)
# ---------------------------------------------------------------------------

def default_threads() -> int:
    return max(1, min(8, (os.cpu_count() or 2) - 1))


def decode_options(speed: str, language: str) -> Dict[str, Any]:
    opts: Dict[str, Any] = dict(task="transcribe", vad_filter=True,
                                vad_parameters=dict(min_silence_duration_ms=500),
                                condition_on_previous_text=False)
    if language:
        opts["language"] = language
    if speed == "Schnell":
        opts.update(beam_size=1, best_of=1, temperature=0.0)
    else:
        opts.update(beam_size=5)
    return opts


class ModelCache:
    def __init__(self, directory: Path, status: Callable[[str], None]):
        self.directory = directory
        self.status = status
        self.key = None
        self.model = None
        self.label = ""
        self.lock = threading.Lock()

    def get(self, settings: Dict[str, Any]):
        with self.lock:
            threads = int(settings.get("threads") or default_threads())
            preference = settings.get("processor", "Automatisch")
            key = (settings["model"], preference, threads)
            if self.key == key and self.model is not None:
                return self.model
            self.model, self.key = None, None
            gc.collect()
            from faster_whisper import WhisperModel  # type: ignore
            if preference != "CPU":
                try:
                    import ctranslate2  # type: ignore
                    if ctranslate2.get_cuda_device_count() < 1:
                        raise RuntimeError("Keine CUDA-fähige NVIDIA-Grafikkarte erkannt.")
                    supported = ctranslate2.get_supported_compute_types("cuda", 0)
                    compute = next((x for x in ("int8_float16", "float16", "int8_float32", "float32") if x in supported), None)
                    if compute is None:
                        raise RuntimeError("Keine passende CUDA-Rechenart verfügbar.")
                    self.status(f"Lade {settings['model']} auf NVIDIA-GPU ({compute}) …")
                    gpu = WhisperModel(settings["model"], device="cuda", compute_type=compute,
                                       cpu_threads=threads, download_root=str(self.directory))
                    segments, _ = gpu.transcribe(np.zeros(16000, dtype=np.float32), language="de",
                                                 vad_filter=False, beam_size=1, best_of=1, temperature=0.0)
                    list(segments)  # run lazy inference to catch missing CUDA libraries
                    self.model = gpu
                    self.label = f"NVIDIA-GPU · {compute} · {settings['model']}"
                except Exception as exc:
                    gc.collect()
                    if preference == "NVIDIA-GPU":
                        raise RuntimeError(f"GPU nicht einsatzbereit: {exc}") from exc
                    logger.info("radio: GPU not usable (%s), using CPU", exc)
            if self.model is None:
                self.status(f"Lade {settings['model']} auf CPU (int8, {threads} Threads) …")
                self.model = WhisperModel(settings["model"], device="cpu", compute_type="int8",
                                          cpu_threads=threads, download_root=str(self.directory))
                self.label = f"CPU · int8 · {threads} Threads · {settings['model']}"
            self.key = key
            return self.model


# ---------------------------------------------------------------------------
# SDR audio hub
# ---------------------------------------------------------------------------

class AudioTap:
    """Fan-out of raw PCM16 audio to listeners (e.g. the SDR audio endpoint)."""

    def __init__(self):
        self.listeners: List[queue.Queue] = []
        self.lock = threading.Lock()
        self.rate = 48000

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=200)
        with self.lock:
            self.listeners.append(q)
        return q

    def unsubscribe(self, q: queue.Queue):
        with self.lock:
            if q in self.listeners:
                self.listeners.remove(q)

    def publish(self, chunk: bytes):
        with self.lock:
            for q in self.listeners:
                try:
                    q.put_nowait(chunk)
                except queue.Full:
                    pass  # slow listener drops audio instead of blocking capture

    def close(self):
        with self.lock:
            for q in self.listeners:
                try:
                    q.put_nowait(b"")
                except queue.Full:
                    pass


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------

class RadioTranscriber:
    def __init__(self, base_path: str,
                 broadcast: Optional[Callable[[str, str, Dict[str, Any]], None]] = None,
                 rtl_fm_finder: Optional[Callable[[str], Optional[str]]] = None):
        self.dir = Path(base_path) / "radio_log"
        self.queue_dir = self.dir / "warteschlange"
        self.audio_dir = self.dir / "audio"
        self.models_dir = self.dir / "modelle"
        for d in (self.dir, self.queue_dir, self.audio_dir, self.models_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.settings_path = self.dir / "einstellungen.json"
        self.settings = dict(DEFAULT_SETTINGS)
        try:
            self.settings.update(json.loads(self.settings_path.read_text(encoding="utf-8")))
        except Exception:
            pass
        self.broadcast = broadcast
        self.rtl_fm_finder = rtl_fm_finder or (lambda name: shutil.which(name))
        self.journal = Journal(self.dir)
        self.models = ModelCache(self.models_dir, self._set_status)
        self.tap = AudioTap()
        self.jobs: queue.Queue = queue.Queue()
        self.stop_event = threading.Event()
        self.capture_thread: Optional[threading.Thread] = None
        self.worker_thread: Optional[threading.Thread] = None
        self.proc: Optional[subprocess.Popen] = None
        self.running = False
        self.status_text = "Bereit"
        self.error = ""
        self.level = -120.0
        self.dropouts = 0
        self.last_rtf: Optional[float] = None
        self.last_status_push = 0.0

    # -- capabilities --

    @staticmethod
    def capabilities() -> Dict[str, bool]:
        return {
            "numpy": NUMPY_AVAILABLE,
            "scipy": _has("scipy"),
            "faster_whisper": _has("faster_whisper"),
            "sounddevice": _has("sounddevice"),
        }

    def status(self) -> Dict[str, Any]:
        return {
            "running": self.running,
            "status": self.status_text,
            "error": self.error,
            "level_db": round(self.level, 1),
            "queue": self.jobs.qsize(),
            "dropouts": self.dropouts,
            "backend": self.models.label,
            "realtime_factor": self.last_rtf,
            "settings": self.settings,
            "capabilities": self.capabilities(),
            "rtl_fm": bool(self.rtl_fm_finder("rtl_fm")),
            "models": MODELS,
        }

    def _set_status(self, text: str, push: bool = True):
        self.status_text = text
        if push:
            self._push_status(force=True)

    def _push_status(self, force: bool = False):
        now = time.time()
        if not self.broadcast or (not force and now - self.last_status_push < 1.0):
            return
        self.last_status_push = now
        try:
            s = self.status()
            s.pop("settings", None)
            self.broadcast("radio", "radio_status", s)
        except Exception:
            pass

    # -- settings --

    NUMERIC = {"frequency_mhz", "gain", "threshold_db", "pause_s", "max_segment_s"}

    def update_settings(self, data: Dict[str, Any]) -> Dict[str, Any]:
        for k, v in data.items():
            if k not in DEFAULT_SETTINGS:
                continue
            if k in self.NUMERIC:
                v = float(v)
            elif k in ("squelch",):
                v = int(v)
            elif k == "threads":
                v = int(v) if v not in (None, "") else None
            elif k == "device":
                v = int(v) if v not in (None, "") else None
            elif k == "keep_audio":
                v = bool(v)
            elif k == "model" and v not in MODELS:
                raise ValueError(f"Unbekanntes Modell {v}")
            self.settings[k] = v
        tmp = self.settings_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.settings, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.settings_path)
        return self.settings

    def source_label(self) -> str:
        s = self.settings
        if s.get("channel_label"):
            return s["channel_label"]
        if s["source"] == "sdr":
            return f"SDR {float(s['frequency_mhz']):.5f} MHz {s['mode'].upper()}"
        return "Funkgerät (Soundkarte)"

    # -- lifecycle --

    def start(self):
        if self.running:
            return
        caps = self.capabilities()
        if not (caps["numpy"] and caps["scipy"]):
            raise RuntimeError("numpy und scipy fehlen (pip install numpy scipy)")
        if not caps["faster_whisper"]:
            raise RuntimeError("faster-whisper fehlt (pip install faster-whisper)")
        if self.settings["source"] == "sdr" and not self.rtl_fm_finder("rtl_fm"):
            raise RuntimeError("rtl_fm nicht gefunden – RTL-SDR-Tools installieren")
        if self.settings["source"] == "soundcard" and not caps["sounddevice"]:
            raise RuntimeError("sounddevice fehlt (pip install sounddevice)")
        self.stop_event.clear()
        self.error = ""
        self.dropouts = 0
        self.running = True
        self._requeue_pending()
        self._ensure_worker()
        self.capture_thread = threading.Thread(target=self._capture, name="radio-capture", daemon=True)
        self.capture_thread.start()
        self._set_status("Empfang läuft")

    def stop(self):
        if not self.running:
            return
        self.stop_event.set()
        if self.proc:
            try:
                self.proc.terminate()
            except Exception:
                pass
        if self.capture_thread:
            self.capture_thread.join(timeout=5)
        self.running = False
        self.tap.close()
        self._set_status("Gestoppt – Warteschlange wird abgearbeitet" if self.jobs.qsize() else "Gestoppt")

    def shutdown(self):
        self.stop()
        self.jobs.put(None)

    def sdr_active(self) -> bool:
        return self.running and self.settings["source"] == "sdr"

    # -- capture --

    def _capture(self):
        try:
            if self.settings["source"] == "sdr":
                self._capture_sdr()
            else:
                self._capture_soundcard()
        except Exception as e:
            logger.error("radio capture failed: %s", e)
            self.error = str(e)
            self.status_text = "Fehler beim Empfang"
        finally:
            self.running = False
            self._push_status(force=True)

    def _segmenter(self) -> Segmenter:
        s = self.settings
        return Segmenter(float(s["threshold_db"]), float(s["pause_s"]), float(s["max_segment_s"]))

    def _capture_sdr(self):
        s = self.settings
        rate = 48000
        self.tap.rate = rate
        cmd = [self.rtl_fm_finder("rtl_fm"), "-f", str(int(float(s["frequency_mhz"]) * 1e6)),
               "-M", {"wbfm": "wbfm", "am": "am", "usb": "usb", "lsb": "lsb"}.get(s["mode"], "fm"),
               "-s", "200000", "-r", str(rate), "-g", str(int(float(s["gain"])))]
        if int(s.get("squelch") or 0) > 0:
            cmd += ["-l", str(int(s["squelch"]))]
        cmd.append("-")
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        frame_bytes = int(rate * FRAME_SECONDS) * 2
        seg = self._segmenter()
        buf = b""
        t = time.time()
        try:
            while not self.stop_event.is_set():
                chunk = self.proc.stdout.read(4096)
                if not chunk:
                    if not self.stop_event.is_set():
                        raise RuntimeError("rtl_fm beendet – SDR-Stick belegt oder getrennt?")
                    break
                self.tap.publish(chunk)
                buf += chunk
                while len(buf) >= frame_bytes:
                    frame = np.frombuffer(buf[:frame_bytes], dtype="<i2").astype(np.float32) / 32768.0
                    buf = buf[frame_bytes:]
                    t += FRAME_SECONDS
                    self._feed(seg, frame, t, rate)
            self._finish(seg, rate)
        finally:
            try:
                self.proc.terminate()
            except Exception:
                pass
            self.proc = None

    def _capture_soundcard(self):
        import sounddevice as sd  # type: ignore
        device = self.settings.get("device")
        info = sd.query_devices(device, "input")
        rate = int(info["default_samplerate"]) or 48000
        blocksize = int(rate * FRAME_SECONDS)
        frames: queue.Queue = queue.Queue(maxsize=500)

        def callback(data, _frames, _timing, status):
            if status:
                self.dropouts += 1
            try:
                frames.put_nowait(data[:, 0].copy())
            except queue.Full:
                self.dropouts += 1

        seg = self._segmenter()
        with sd.InputStream(device=device, channels=1, samplerate=rate, blocksize=blocksize,
                            dtype="float32", callback=callback):
            while not self.stop_event.is_set():
                try:
                    frame = frames.get(timeout=0.5)
                except queue.Empty:
                    continue
                self._feed(seg, frame, time.time(), rate)
        self._finish(seg, rate)

    def _feed(self, seg: Segmenter, frame, timestamp: float, rate: int):
        self.level = 0.8 * self.level + 0.2 * level_db(frame)
        result = seg.feed(frame, timestamp)
        if result:
            self._enqueue(result[0], result[1], rate)
        self._push_status()

    def _finish(self, seg: Segmenter, rate: int):
        result = seg.flush()
        if result:
            self._enqueue(result[0], result[1], rate)

    # -- durable queue --

    def _enqueue(self, start: float, samples, rate: int, source: Optional[str] = None,
                 frequency: Optional[float] = None):
        job = uuid.uuid4().hex
        wav = self.queue_dir / f"{job}.wav"
        write_wav(wav, samples, rate)
        meta = {
            "job": job, "start": start, "rate": rate, "duration": len(samples) / rate,
            "source": source or self.source_label(),
            "frequency": frequency if frequency is not None else (
                float(self.settings["frequency_mhz"]) if self.settings["source"] == "sdr" else None),
        }
        (self.queue_dir / f"{job}.json").write_text(json.dumps(meta), encoding="utf-8")
        self.jobs.put(job)
        if self.jobs.qsize() > 500:
            self.error = "Warteschlange übervoll – Empfang gestoppt (Rechner zu langsam?)"
            self.stop_event.set()

    def _requeue_pending(self):
        pending = sorted(self.queue_dir.glob("*.json"), key=lambda p: p.stat().st_mtime)
        queued = set(list(self.jobs.queue))
        for p in pending:
            if p.stem not in queued and (self.queue_dir / f"{p.stem}.wav").exists():
                self.jobs.put(p.stem)

    def _worker(self):
        while True:
            job = self.jobs.get()
            if job is None:
                return
            try:
                self._transcribe(job)
            except Exception as e:
                logger.error("radio transcription failed: %s", e)
                self.error = f"Transkription fehlgeschlagen: {e} – Aufnahme bleibt erhalten"
                self._push_status(force=True)
                if not self.running:
                    return
                time.sleep(5)
            if not self.running and self.jobs.empty():
                self._set_status("Gestoppt")
                return

    def _transcribe(self, job: str):
        meta_path = self.queue_dir / f"{job}.json"
        wav_path = self.queue_dir / f"{job}.wav"
        if not meta_path.exists() or not wav_path.exists():
            return
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        model = self.models.get(self.settings)
        if self.running:
            self.status_text = "Empfang läuft"
        audio = read_wav_16k(wav_path)
        t0 = time.time()
        segments, info = model.transcribe(audio, **decode_options(self.settings["speed"], self.settings.get("language") or ""))
        text = " ".join(s.text.strip() for s in segments).strip()
        elapsed = max(1e-3, time.time() - t0)
        self.last_rtf = round(meta["duration"] / elapsed, 2)
        kept = ""
        if text and self.settings.get("keep_audio"):
            kept_path = self.audio_dir / f"{job}.wav"
            shutil.move(str(wav_path), kept_path)
            kept = str(kept_path)
        if text:
            entry = self.journal.add(meta["start"], meta["source"], meta.get("frequency"), text,
                                     getattr(info, "language", "") or "", meta["duration"], kept, job)
            if entry and self.broadcast:
                try:
                    self.broadcast("radio", "radio_transcript", entry)
                except Exception:
                    pass
        for p in (wav_path, meta_path):
            try:
                p.unlink()
            except FileNotFoundError:
                pass
        self._push_status(force=True)

    def transcribe_upload(self, data: bytes, filename: str, source: str) -> int:
        """Queue an uploaded WAV recording; returns the number of queued segments."""
        tmp = self.queue_dir / f"upload-{uuid.uuid4().hex}.tmp.wav"
        tmp.write_bytes(data)
        try:
            samples = read_wav_16k(tmp)
        finally:
            tmp.unlink(missing_ok=True)
        if not samples.size:
            raise ValueError("Leere Aufnahme")
        chunk = int(16000 * float(self.settings["max_segment_s"]))
        start = time.time()
        n = 0
        for i in range(0, len(samples), chunk):
            self._enqueue(start + i / 16000, samples[i:i + chunk], 16000, source=source or filename, frequency=None)
            n += 1
        self._ensure_worker()
        return n

    def _ensure_worker(self):
        # Exactly one transcription worker, so segments stay in order.
        if not (self.worker_thread and self.worker_thread.is_alive()):
            self.worker_thread = threading.Thread(target=self._worker, name="radio-whisper", daemon=True)
            self.worker_thread.start()


def list_soundcards() -> List[Dict[str, Any]]:
    try:
        import sounddevice as sd  # type: ignore
    except Exception:
        return []
    out = []
    try:
        hostapis = sd.query_hostapis()
        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] > 0:
                api = hostapis[d["hostapi"]]["name"]
                if "WDM-KS" in api:
                    continue
                out.append({"index": i, "name": d["name"], "api": api, "rate": d["default_samplerate"]})
    except Exception as e:
        logger.warning("sound card scan failed: %s", e)
    return out


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------

def create_router(manager: RadioTranscriber, verify_token: Callable[[str], Optional[Dict[str, Any]]]) -> APIRouter:
    router = APIRouter(prefix="/api/radio", tags=["radio-transcription"])

    def auth(authorization: Optional[str], token: Optional[str] = None):
        raw = token
        if not raw and authorization:
            raw = authorization[7:].strip() if authorization.lower().startswith("bearer ") else authorization.strip()
        if not raw or not verify_token(raw):
            raise HTTPException(status_code=401, detail="Nicht angemeldet")

    @router.get("/status")
    def radio_status(authorization: Optional[str] = Header(None)):
        auth(authorization)
        return manager.status()

    @router.get("/devices")
    def radio_devices(authorization: Optional[str] = Header(None)):
        auth(authorization)
        return {"soundcards": list_soundcards()}

    @router.put("/settings")
    def radio_settings(data: Dict[str, Any] = Body(...), authorization: Optional[str] = Header(None)):
        auth(authorization)
        if manager.running and any(k in data for k in ("source", "frequency_mhz", "mode", "gain", "squelch", "device")):
            raise HTTPException(status_code=409, detail="Empfang zuerst stoppen, um Quelle/Frequenz zu ändern")
        try:
            return {"settings": manager.update_settings(data)}
        except (ValueError, TypeError) as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.post("/start")
    def radio_start(authorization: Optional[str] = Header(None)):
        auth(authorization)
        try:
            manager.start()
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return manager.status()

    @router.post("/stop")
    def radio_stop(authorization: Optional[str] = Header(None)):
        auth(authorization)
        manager.stop()
        return manager.status()

    @router.get("/transcripts")
    def radio_transcripts(limit: int = 200, after_id: int = 0, q: str = "",
                          authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
        auth(authorization, token)
        return {"entries": manager.journal.rows(limit=max(1, min(limit, 2000)), after_id=after_id, query=q)}

    @router.get("/export.txt")
    def radio_export(authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
        auth(authorization, token)
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
        return PlainTextResponse(manager.journal.export_text(), media_type="text/plain; charset=utf-8",
                                 headers={"Content-Disposition": f'attachment; filename="Funkprotokoll-{stamp}.txt"'})

    @router.get("/audio/{entry_id}")
    def radio_audio(entry_id: int, authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
        auth(authorization, token)
        path = manager.journal.audio_path(entry_id)
        if not path:
            raise HTTPException(status_code=404, detail="Keine Aufnahme gespeichert")
        return FileResponse(path, media_type="audio/wav")

    @router.post("/transcribe")
    async def radio_upload(file: UploadFile = File(...), source: str = Form(""),
                           authorization: Optional[str] = Header(None)):
        auth(authorization)
        if not manager.capabilities()["faster_whisper"]:
            raise HTTPException(status_code=400, detail="faster-whisper fehlt (pip install faster-whisper)")
        try:
            n = manager.transcribe_upload(await file.read(), file.filename or "Aufnahme", source)
        except (ValueError, wave.Error) as e:
            raise HTTPException(status_code=400, detail=f"Nur unkomprimierte WAV-Dateien (16 Bit): {e}")
        return {"status": "queued", "segments": n}

    return router
