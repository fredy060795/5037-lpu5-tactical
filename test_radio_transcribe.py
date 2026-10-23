"""Tests for radio_transcribe.py (run: python -m pytest test_radio_transcribe.py).

The real Whisper test only runs when RADIO_WHISPER_TEST_WAV points to a
spoken German recording (CI generates one with espeak-ng)."""

import io
import os
import time
import wave
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import radio_transcribe as rt


def tone(seconds, rate=48000, amp=0.3, freq=800):
    t = np.arange(int(seconds * rate)) / rate
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def frames(samples, rate=48000):
    n = int(rate * rt.FRAME_SECONDS)
    return [samples[i:i + n] for i in range(0, len(samples) - n + 1, n)]


def test_segmenter_splits_on_pause_with_preroll():
    seg = rt.Segmenter(threshold=-38, pause=1.0, maximum=15)
    audio = np.concatenate([np.zeros(48000, np.float32), tone(2.0), np.zeros(int(1.5 * 48000), np.float32)])
    out = [r for i, f in enumerate(frames(audio)) if (r := seg.feed(f, i * rt.FRAME_SECONDS))]
    assert len(out) == 1
    start, samples = out[0]
    assert abs(start - 0.6) < 0.05                   # 400 ms pre-roll before the tone at 1.0 s
    assert 2.9 < len(samples) / 48000 < 3.5          # pre-roll + tone + 1 s pause


def test_segmenter_hard_limit_and_noise_rejection():
    seg = rt.Segmenter(threshold=-38, pause=1.0, maximum=2.0)
    out = [r for i, f in enumerate(frames(tone(5.0))) if (r := seg.feed(f, i * rt.FRAME_SECONDS))]
    assert len(out) == 2 and all(abs(len(s) / 48000 - 2.0) < 0.05 for _, s in out)
    seg2 = rt.Segmenter(threshold=-38, pause=1.0, maximum=15)
    click = np.concatenate([tone(0.04), np.zeros(48000 * 2, np.float32)])  # 2 voiced frames only
    assert not [r for i, f in enumerate(frames(click)) if (r := seg2.feed(f, i * rt.FRAME_SECONDS))]


def test_wav_roundtrip_resamples_to_16k(tmp_path):
    p = tmp_path / "a.wav"
    rt.write_wav(p, tone(1.0), 48000)
    s = rt.read_wav_16k(p)
    assert s.dtype == np.float32 and len(s) == 16000


class FakeModel:
    def __init__(self):
        self.calls = 0

    def transcribe(self, audio, **opts):
        self.calls += 1
        assert audio.dtype == np.float32
        return iter([SimpleNamespace(text=f" Funkspruch {self.calls} ")]), SimpleNamespace(language=opts.get("language", "de"))


@pytest.fixture
def manager(tmp_path, monkeypatch):
    events = []
    m = rt.RadioTranscriber(str(tmp_path), broadcast=lambda c, t, d: events.append((c, t, d)))
    fake = FakeModel()
    monkeypatch.setattr(m.models, "get", lambda settings: fake)
    m._events = events
    yield m
    m.shutdown()


def wav_bytes(samples, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((samples * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def wait_for(cond, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def test_upload_is_transcribed_logged_and_broadcast(manager):
    manager.update_settings({"max_segment_s": 2})
    n = manager.transcribe_upload(wav_bytes(tone(5.0, rate=16000)), "Aufnahme.wav", "Funkgerät Zug 1")
    assert n == 3
    assert wait_for(lambda: len(manager.journal.rows()) == 3)
    rows = manager.journal.rows()
    assert [r["text"] for r in rows] == ["Funkspruch 1", "Funkspruch 2", "Funkspruch 3"]
    assert rows[0]["source"] == "Funkgerät Zug 1"
    transcripts = [d for c, t, d in manager._events if t == "radio_transcript"]
    assert len(transcripts) == 3 and transcripts[0]["text"] == "Funkspruch 1"
    assert "Funkspruch 3" in manager.journal.export_text()
    assert "Funkspruch 2" in (manager.dir / "Funkprotokoll.txt").read_text(encoding="utf-8")
    assert not list(manager.queue_dir.glob("*.wav"))  # processed jobs are removed


def test_pending_jobs_survive_restart(tmp_path, monkeypatch):
    m1 = rt.RadioTranscriber(str(tmp_path))
    m1._enqueue(time.time(), tone(1.0, rate=16000), 16000, source="X")
    assert len(list(m1.queue_dir.glob("*.json"))) == 1   # durable before transcription
    m2 = rt.RadioTranscriber(str(tmp_path))
    monkeypatch.setattr(m2.models, "get", lambda s: FakeModel())
    m2._requeue_pending()
    m2._ensure_worker()
    assert wait_for(lambda: len(m2.journal.rows()) == 1)


def test_api(manager):
    app = FastAPI()
    app.include_router(rt.create_router(manager, lambda t: {"u": 1} if t == "ok" else None))
    c = TestClient(app)
    h = {"Authorization": "Bearer ok"}
    assert c.get("/api/radio/status").status_code == 401
    st = c.get("/api/radio/status", headers=h).json()
    assert st["running"] is False and "faster_whisper" in st["capabilities"]
    r = c.put("/api/radio/settings", json={"frequency_mhz": "145.5", "model": "base", "language": ""}, headers=h)
    assert r.status_code == 200 and r.json()["settings"]["frequency_mhz"] == 145.5
    assert c.put("/api/radio/settings", json={"model": "gigantisch"}, headers=h).status_code == 400
    assert c.get("/api/radio/export.txt?token=ok").status_code == 200
    assert c.get("/api/radio/transcripts", headers=h).json()["entries"] == []


@pytest.mark.skipif(not os.environ.get("RADIO_WHISPER_TEST_WAV"), reason="no spoken test recording")
def test_real_whisper_transcribes_german_radio_call(tmp_path):
    m = rt.RadioTranscriber(str(tmp_path))
    m.update_settings({"model": os.environ.get("RADIO_WHISPER_MODEL", "base"), "processor": "CPU", "language": "de"})
    with open(os.environ["RADIO_WHISPER_TEST_WAV"], "rb") as f:
        m.transcribe_upload(f.read(), "test.wav", "CI")
    assert wait_for(lambda: m.journal.rows(), timeout=600)
    text = " ".join(r["text"] for r in m.journal.rows()).lower()
    print("Whisper:", text)
    assert any(w in text for w in ("kontakt", "nord", "kommen", "alpha"))
    m.shutdown()
