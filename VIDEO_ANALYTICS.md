# Videoanalyse (YOLOv8) – `video_analytics.py`

Bringt die Erkennung aus YOLO_V8 / ARGUS in den LPU5-Server. Verwaltung im
Browser: **`https://<server>:8101/video_analytics.html`** (nach Anmeldung in LPU5).

## Installation

```bash
pip install opencv-python-headless numpy   # Video-Ein-/Ausgabe
pip install ultralytics                    # YOLOv8 (lädt PyTorch, ~1–2 GB)
```

Ohne `ultralytics` laufen Streams ohne KI weiter; die Seite zeigt fehlende Pakete an.
Eigene Modelle (z. B. das Drohnenmodell `best.pt` aus YOLO_V8) in das LPU5-Verzeichnis
oder nach `models/` kopieren – sie erscheinen in der Modellauswahl.
`yolov8n.pt` wird beim ersten Gebrauch automatisch geladen (Internet nötig) oder
aus dem YOLO_V8-Repo kopiert.

## Quellen

| Quelle | Beispiel |
|---|---|
| IP-Kamera / Drohne (RTSP) | `rtsp://user:pass@10.0.0.5:554/stream1` |
| HTTP/MJPEG | `http://10.0.0.6:8080/video` |
| Lokale/USB-Kamera am Server | `0`, `1`, … |
| Videodatei (Endlosschleife) | `C:\Videos\flug.mp4` |
| **Handy-Kamera (EUD)** | automatisch: EUD → Video → „Kamera teilen“ → erscheint als `relay-eud-<benutzer>` |
| Stream-Seite (`stream.html`) | automatisch als `relay-camera_main` |

## Was passiert mit Erkennungen

* Kasten + Label im Videobild (Alarmklassen rot), MJPEG für Browser und EUD.
* Ereignis `video_detection` über WebSocket-Kanal `video_analytics` (max. alle 5 s pro Klasse) –
  EUDs zeigen Alarme als Hinweis und auf der Karte.
* Optional **Lagemarker** (`VA-<stream>-<klasse>`, alle 15 s aktualisiert), die wie normale
  Marker per CoT an ATAK/WinTAK/iTAK gehen.
* Position: Ist Kamerastandort, Blickrichtung und Bildwinkel gesetzt, wird aus der
  horizontalen Bildposition die **Peilung** berechnet; mit „geschätzter Distanz“ wird der
  Marker auf dieser Peilung platziert (als „Position geschätzt“ gekennzeichnet). Bei
  geteilten Handy-Kameras werden GPS und Kompass des Handys verwendet.

## API (Bearer-Token oder `?token=`)

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/video/status` | OpenCV/YOLO verfügbar, Modelle |
| GET/POST | `/api/video/streams` | Liste / anlegen |
| PUT/DELETE | `/api/video/streams/{id}` | ändern / löschen |
| POST | `/api/video/streams/{id}/start` · `/stop` | steuern |
| GET | `/api/video/streams/{id}/mjpeg` | Live-Bild (annotiert) |
| GET | `/api/video/streams/{id}/snapshot.jpg` | Einzelbild |
| GET | `/api/video/streams/{id}/detections` | letzte Erkennungen |
| POST | `/api/video/analyze` | Einzelbild hochladen und analysieren |

Konfiguration liegt in `video_streams.json` (nicht im Git, kann Kamera-Passwörter enthalten).
Tests: `python -m pytest test_video_analytics.py`.
