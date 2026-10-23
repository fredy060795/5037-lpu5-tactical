# Funk-Mitschrift (Whisper) – `radio_transcribe.py`

Die Logik aus **FunkLog_USB_Whisper** ist in den LPU5-Server eingebaut. Funkgespräche
werden mitgehört, in Sprechabschnitte zerlegt, mit Whisper in Text umgewandelt und
**sofort dauerhaft protokolliert** – was angezeigt wird, steht im Protokoll.

Bedienung: LPU5 → **SDR / Funk** → Panel „Funk-Mitschrift (Whisper)“.
Mitlesen unterwegs: EUD → ✉ Chat → Reiter **🎙 Funk** (offline zwischengespeichert).

## Installation

```bash
pip install numpy scipy faster-whisper   # Pflicht
pip install sounddevice                   # nur für Funkgerät an USB-Soundkarte
```

Das Whisper-Modell wird beim ersten Start einmalig heruntergeladen (Internet nötig)
und liegt dann in `radio_log/modelle/`. Danach läuft alles offline.
NVIDIA-GPU wird automatisch genutzt, wenn CUDA/cuDNN vorhanden sind
(siehe FunkLog `NVIDIA_GPU_Installieren.bat`), sonst CPU (int8).
Empfehlung CPU: `small`; mit GPU: `medium`.

## Quellen

| Quelle | Anschluss |
|---|---|
| **RTL-SDR** | Frequenz + Modulation (FM/AM/USB/LSB/WBFM), `rtl_fm` muss installiert sein. „SDR-Frequenz übernehmen“ holt die Werte aus dem SDR-Bereich. Während die Mitschrift läuft, hört „Enable Audio“ denselben Kanal mit (ein SDR-Stick kann nur einmal geöffnet werden). |
| **Funkgerät über USB-Soundkarte** | Audioausgang des Funkgeräts → Mikrofoneingang der USB-Soundkarte (wie bei FunkLog, Pegel niedrig beginnen, Boost aus). |
| **WAV-Aufnahme** | Datei hochladen, wird in Abschnitten transkribiert. |

## Einstellungen (wie FunkLog 1.1)

* **Schwelle** −38 dB: Aufnahme beginnt über diesem Pegel. Leise/abgeschnitten → −45 dB, Rauschen wird aufgenommen → −30 dB. Der Pegelbalken zeigt den aktuellen Wert.
* **Sprechpause** 1,0 s: Abschnitt endet nach dieser Ruhe. 400 ms Vorlauf schonen Wortanfänge, lange Aussendungen werden nach 15 s geteilt.
* **Erkennung** Schnell (ein Durchlauf) bzw. Genauer (beam 5), Sprache Deutsch/Englisch/Automatisch.
* **Audio behalten**: Aufnahme zu jedem Eintrag speichern und im Protokoll abspielen.

## Daten

`radio_log/` (nicht im Git):

| Datei | Inhalt |
|---|---|
| `funklog.sqlite3` | Alle Einträge (Zeit, Quelle, Frequenz, Text, Sprache, Dauer) |
| `Funkprotokoll.txt` | Fortlaufendes Textprotokoll |
| `warteschlange/` | Abschnitte werden **vor** der Transkription gespeichert – bei Absturz/Neustart werden offene Abschnitte beim nächsten Start verarbeitet |
| `audio/` | Behaltene Aufnahmen |
| `einstellungen.json` | Letzte Einstellungen |

Export: Button „Textprotokoll“ bzw. `GET /api/radio/export.txt`.

## API (Bearer-Token)

`GET /api/radio/status` · `PUT /api/radio/settings` · `POST /api/radio/start|stop` ·
`GET /api/radio/devices` · `GET /api/radio/transcripts?after_id=&q=` ·
`GET /api/radio/export.txt` · `GET /api/radio/audio/{id}` · `POST /api/radio/transcribe` (WAV) ·
WebSocket-Kanal `radio`: `radio_transcript`, `radio_status`.

## Grenzen

Whisper liefert keine garantiert wortgetreue Mitschrift: Rufzeichen, Zahlen und
schwache Signale können falsch erkannt werden. Keine Sprechererkennung. Ist der
Rechner langsamer als Echtzeit, wächst die Warteschlange (Faktor wird angezeigt).
Tests: `python -m pytest test_radio_transcribe.py`.
