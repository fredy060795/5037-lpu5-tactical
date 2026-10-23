# LPU5 Tactical – Handbuch

LPU5 ist eine taktische Lagebild-Software für den Gefechtsstand (TOC) und Feldgeräte (EUD),
voll kompatibel mit ATAK / WinTAK / iTAK. Sie läuft als **Web-Anwendung**: Ein Rechner im
TOC startet den Server, alle anderen Arbeitsplätze, Tablets und Handys im selben WLAN
öffnen sie im Browser oder in der LPU5-App.

```
          TOC-WLAN
 ┌──────────────────────────────────────────────────────────┐
 │  LPU5-Server (ein PC)        Arbeitsplätze (Browser)      │
 │  https://<IP>:8101  ◄──────  Hauptansicht /index.html     │
 │   ├ Lagebild, Chat, Missionen                            │
 │   ├ Kartenkacheln /tiles  (offline-Cache, MBTiles)        │
 │   ├ Videoanalyse (YOLOv8)   EUDs (App / PWA /eud/)        │
 │   ├ Funk-Mitschrift (Whisper)  ◄── LoRa-Mesh (Meshtastic) │
 │   └ TAK: TCP 8088, TLS 8089, Marti 8080 ◄── ATAK/WinTAK   │
 │                         TSL-Lagetagebuch ◄── Einträge      │
 └──────────────────────────────────────────────────────────┘
```

## 1. Server starten (TOC)

| Schritt | |
|---|---|
| 1 | Python 3.10+ installieren, Ordner entpacken |
| 2 | **`start_lpu5.bat` einmalig als Administrator** ausführen (gibt die Ports in der Windows-Firewall frei, installiert Pakete) – danach normal starten |
| 3 | Das Fenster zeigt die Adresse für alle Geräte (`https://<IP>:8101/`) und einen QR-Code; der Browser öffnet sich |
| 4 | Erste Anmeldung `administrator` / `password` → **Passwortwechsel wird erzwungen** |
| 5 | Optional `install_autostart.bat` – Server startet bei der Anmeldung automatisch |

Linux / Raspberry Pi: `./start_lpu5.sh`. Weitere Arbeitsplätze: nur Browser öffnen, oder
`start_lpu5_client.bat <Server-IP>`.

Ports: 8101 (Web/API), 8088 TCP + 4242 UDP + 6969 Multicast (CoT/ATAK), 8089 (TLS-CoT),
8080 (Marti/Data Packages).

### Zertifikat (HTTPS)
Der Server erzeugt eine eigene **LPU5-Root-CA**. Browser geben Kamera, Bluetooth und
Offline-Modus nur für vertrauenswürdige HTTPS-Seiten frei.
- **LPU5-App:** übernimmt das Zertifikat beim ersten Verbinden automatisch (Fingerabdruck
  einmal bestätigen; der Fingerabdruck steht beim Serverstart in der Konsole).
- **Browser/PWA:** Zertifikat `https://<IP>:8101/lpu5-ca.crt` (iOS: `/lpu5-ca.mobileconfig`)
  installieren – die PWA lädt es beim ersten Verbinden selbst herunter und zeigt die Schritte.

## 2. Feldgerät (EUD)

App (Android-APK / iOS) aus GitHub Actions oder PWA unter `https://<IP>:8101/eud/`.
Details: [eud/README.md](eud/README.md).

**Bedienung** wie in der Feldansicht, ausgelegt für quer gehaltene Handys:
- Kopfleiste: Uhr, Akku, Verbindung, GPS, Rufname, Zoom −/+, SOS, Marker, Chat, Video, Sync, ☰.
- Kompass oben links: Antippen schaltet den Kompass ein oder aus.
- Rechts unten: Messen und eigener Standort/Folgen.
- ☰ öffnet das COMMAND MENU mit allen weiteren Funktionen als Kacheln. Admins/Operatoren
  finden dort „Hauptansicht“.
- Fenster öffnen sich im Querformat als Seitenleiste rechts, die Karte bleibt links bedienbar.
- Im Hochformat wird die Kopfleiste zweizeilig.

- **Offline:** Karte, eigene Position, Lagebild, Overlays, Chatverlauf bleiben bei
  Verbindungsabbruch; Meldungen/Marker werden gepuffert und später gesendet.
- **Karten:** über den LPU5-Kachelserver (auch ohne Internet), Gebiete vorab laden, MBTiles.
- **SOS:** 911, Feindkontakt, Ring the Bell – Knopf 1,5 s halten. Geht an LPU5, ATAK und
  ohne Server über das Mesh-Funkgerät.
- **Meldungen:** MEDEVAC 9-Liner, SALUTE, Lagemeldung, Spot-Meldung.
- **Zeichnen:** Routen, Linien, Flächen, Entfernungsringe – erscheinen auch in ATAK.
- **Meshtastic per Bluetooth:** Mesh-Chat, Knoten, ATAK-PLI – ohne Server und Internet
  (Browser: nur Chrome/Android; iOS nur in der App).
- **Kamera teilen** (auch USB-Kamera) → Videoanalyse im TOC.
- **Funk-Mitschrift lesen** (Chat → 🎙 Funk), **Geofence-Alarme** (lokal geprüft).
- **Sicherheit:** App-PIN, Sperre nach Hintergrund, Löschung nach 10 Fehlversuchen,
  Fernlöschung durch Admin (`POST /api/eud/wipe {"username": "..."}`).
- **Nachtmodus** (Rotlicht) und **große Bedienelemente** in den Einstellungen.

Die bisherige Feldansicht `overview.html` bleibt verfügbar; Admins/Operatoren kommen über
den Knopf 🖥 in der Kopfleiste (oder Alt+H) zurück zur Hauptansicht.

## 3. ATAK / WinTAK / iTAK

| Richtung | Inhalt |
|---|---|
| beide | Positionen, Marker (2525), GeoChat |
| beide | Zeichnungen (Linie, Fläche, Rechteck, Kreis), Routen, Löschen |
| beide | Notrufe (911, TIC, Ring the Bell, Aufheben), CASEVAC/9-Liner |
| beide | Video-Feeds (ATAK-Feeds → Videoanalyse; LPU5-RTSP-Streams → ATAK) |
| beide | Data Packages: ATAK „An Server senden“ / Server-Pakete (Marti, Port 8080), LPU5-Lage-Export |

**ATAK verbinden:** EUD → 📦 → „ATAK-Verbindungspaket“ (oder
`GET /api/tak/connection-package?protocol=tcp`) herunterladen und in ATAK importieren –
verbindet per TCP 8088. TLS: `protocol=ssl` und in `config.json` `"itak_bridge_bind": "0.0.0.0"`.

## 4. Videoanalyse
Siehe [VIDEO_ANALYTICS.md](VIDEO_ANALYTICS.md) – Verwaltung unter `/video_analytics.html`.

## 5. Funk-Mitschrift (Whisper)
Siehe [RADIO_TRANSCRIPTION.md](RADIO_TRANSCRIPTION.md) – Bedienung im SDR-/Funk-Bereich.

## 6. TSL-Lagetagebuch
In `config.json`: `"tsl_url": "http://<TSL-Rechner>:5008"`. Funk-Mitschriften, Notrufe,
Meldungen und KI-Alarme erscheinen automatisch im Lagetagebuch (`tsl_forward` steuert, was
übertragen wird).

## 7. Kartenmaterial
- Online-Karten (OSM, Topo, Satellit, Dunkel) werden beim Ansehen auf dem Server
  zwischengespeichert (`tile_cache/`) und stehen dann allen Geräten offline zur Verfügung.
- Vorab laden: `POST /api/tiles/prefetch` mit `{"source":"osm","bounds":{"south":..,"west":..,"north":..,"east":..},"minz":8,"maxz":15}` (Admin).
- Eigene Karten: MBTiles-Datei in `maps/` legen → erscheint als Quelle `/tiles/<name>/…`.

## 8. Sicherheit
- Passwörter gesalzen (PBKDF2), Login-Bremse, erzwungener Passwortwechsel bei
  Standard-/Admin-vergebenen Passwörtern.
- Schreibende API-Aufrufe nur mit gültiger Anmeldung, Admin-Bereiche nur für admin/operator.
- Zufälliger Signaturschlüssel pro Installation (`secret.key`), Medien-Tokens für Video/Audio-URLs.
- Der Server liefert nur Web-Dateien aus – keine Datenbank, Konfiguration oder Schlüssel.
- `config.json` → `"security"`: `require_auth_for_reads` (auch Lesen nur angemeldet),
  `trust_localhost` (Standard `true`; **hinter einem Reverse-Proxy auf `false` setzen**).

## 9. Abhängigkeiten
Status zur Laufzeit: `GET /api/dependencies/check`. Die Start-Skripte installieren alle
Python-Pakete automatisch (YOLO/PyTorch überspringen: `LPU5_SKIP_YOLO=1`). Manuell nötig:
RTL-SDR-Tools (`rtl_fm`, `rtl_tcp`) für SDR und Funk-Mitschrift über SDR.

## 10. Entwicklung & Tests
```
python -m pytest -q test_*.py      # Server
cd eud && npm test && npm run build # EUD
```
GitHub Actions baut bei jedem Push APK, iOS-IPA und PWA und testet Server und Whisper.
