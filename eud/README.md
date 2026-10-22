# LPU5 EUD – taktischer Feldclient (Android · iOS · PWA)

Der EUD (End User Device) ist der neue mobile Client von LPU5 – eine Codebasis
für **Android-APK**, **iOS-App** und **PWA** (Browser / Home-Bildschirm).
Er ersetzt die alten Projekte `android/` (nicht baubar) und `ionic/`.

Grundprinzip wie bei ATAK: **Das Gerät arbeitet immer aus seinem lokalen
Speicher.** Der Server füttert ihn nur. Fällt die Verbindung weg, bleiben
Karte, eigener Standort, Lagebild und Overlays stehen und funktionieren
weiter; Meldungen werden gepuffert und nach Wiederverbindung gesendet.

## Funktionen

| Bereich | Funktion |
|---|---|
| **Karte** | OSM, OpenTopoMap, Esri-Satellit, eigener XYZ-Kartenserver, importierte **MBTiles** |
| **Offline-Karten** | Angesehene Kacheln werden automatisch gespeichert; Ausschnitt mit Zoombereich vorab laden; fehlende Kacheln werden aus gröberen Zoomstufen hochskaliert (keine grauen Flächen) |
| **Offline-Betrieb** | Kartenausschnitt, Basiskarte, letzter eigener Standort, Marker, Overlays, Zeichnungen, Chatverlauf und Spur liegen in IndexedDB; dauerhafter Speicher wird angefordert |
| **Eigener Standort (PLI)** | GPS mit Genauigkeitskreis und Blickrichtung; in der App auch **bei gesperrtem Bildschirm** (Vordergrunddienst); letzter Fix bleibt nach Neustart sichtbar (grau = veraltet) |
| **Lagebild** | MIL-STD-2525C-Symbole (Freund/Feind/Neutral/Unbekannt × Einheit, Infanterie, Panzer, Aufklärung, Artillerie, Pioniere, Sanität, Gefechtsstand, Fahrzeug, Sensor, Hubschrauber, Drohne); veraltete Kontakte werden ausgegraut |
| **Marker** | Setzen per Langdruck oder Fadenkreuz, bearbeiten, löschen – auch offline (Outbox) |
| **Overlays** | Import von **KML, KMZ, GPX, GeoJSON** auf dem Gerät; Bild-Overlays und Zeichnungen vom Server werden offline mitgespeichert |
| **Werkzeuge** | MGRS/UTMREF, Dezimalgrad, GMS; Entfernung + Azimut (Grad und Strich/mil); Messen von Strecken; Navigation zu Marker; Kontaktliste nach Entfernung |
| **Chat** | Server-Chat (Kanal „Alle“, auch ATAK GeoChat über den Server) und **Mesh-Chat über LoRa** |
| **Meshtastic (BLE)** | Direkte Verbindung zum Funkgerät per Bluetooth – **ohne Server/Internet**: Knoten, Positionen, Textnachrichten, ATAK-Plugin-PLI und GeoChat; eigene Position wird als ATAK-PLI gesendet |
| **Video** | Server-Streams mit KI-Analyse (YOLOv8) ansehen, Erkennungen live, Erkennungen als Lagemarker |
| **Kamera teilen** | Rück- oder **externe USB-Kamera** an den Server senden – dort sieht die Zentrale das Bild und die KI analysiert es |

## Installation auf dem Gerät

### Android (APK)
1. APK aus GitHub Actions laden: *Actions → „EUD apps“ → Artefakt `lpu5-eud-android`*
   (bei Tags `v*` hängt `LPU5-EUD.apk` am Release).
2. Auf dem Handy „Installation aus unbekannten Quellen“ erlauben und APK öffnen.
3. Beim ersten Start Standort (**„Immer“** bzw. Benachrichtigung erlauben),
   Bluetooth („Geräte in der Nähe“) und Kamera erlauben.

Eigene Signatur: Repository-Secrets `LPU5_KEYSTORE_BASE64`, `LPU5_KEYSTORE_PASSWORD`,
`LPU5_KEY_ALIAS`, `LPU5_KEY_PASSWORD` setzen. Ohne diese wird das Release-APK mit
dem Debug-Schlüssel signiert (funktioniert, aber Updates nur mit gleichem Schlüssel).

```bash
# Keystore einmalig erzeugen und als Secret hinterlegen
keytool -genkey -v -keystore lpu5.jks -alias lpu5 -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 lpu5.jks   # Ausgabe -> Secret LPU5_KEYSTORE_BASE64
```

### iOS
* **App (empfohlen, nötig für Bluetooth/Meshtastic):** CI baut `LPU5-EUD-unsigned.ipa`.
  Apple verlangt eine Signatur: mit eigenem Apple-Developer-Konto in Xcode
  (`npx cap open ios`, Team wählen, auf Gerät installieren), oder die unsigned IPA
  mit AltStore/Sideloadly signieren. Für Verteilung an viele Geräte: TestFlight/MDM.
* **PWA:** In Safari `https://<server>:8101/eud/` öffnen → Teilen → „Zum
  Home-Bildschirm“. Funktioniert offline (Karte, Lagebild, Standort, Kamera).
  **Kein Bluetooth:** iOS Safari unterstützt kein Web Bluetooth – Meshtastic
  auf dem iPhone nur mit der App.

### PWA auf Android
Chrome: `https://<server>:8101/eud/` → Menü → „App installieren“. In Chrome
funktioniert auch **Web Bluetooth (Meshtastic)** und die Kamera.

## Warum Kamera und Bluetooth bisher nicht gingen – HTTPS-Zertifikat

Browser geben Kamera, Bluetooth, Standort und Offline-Speicher (Service Worker)
**nur für vertrauenswürdige HTTPS-Seiten** frei. Ein einfaches selbstsigniertes
Zertifikat reicht dafür nicht.

Der Server erzeugt jetzt beim Start eine **eigene LPU5-Root-CA** und damit ein
Serverzertifikat für alle seine IP-Adressen. Die CA einmal auf jedem Gerät
installieren:

* Download: `https://<server>:8101/lpu5-ca.crt` (Zertifikatswarnung einmalig bestätigen)
* **Android:** Einstellungen → Sicherheit → Verschlüsselung & Anmeldedaten →
  Zertifikat installieren → **CA-Zertifikat** → Datei wählen.
* **iOS:** Datei in Safari öffnen → Einstellungen → „Profil geladen“ → installieren,
  danach Allgemein → Info → **Zertifikatsvertrauenseinstellungen** → LPU5 CA aktivieren.

Danach gelten alle späteren Serverzertifikate automatisch als vertrauenswürdig,
auch wenn sich die Server-IP ändert. Alte Zertifikate (`cert.pem` aus dem
früheren Generator) werden beim Start automatisch ersetzt.
Die native Android-App vertraut zusätzlich vom Nutzer installierten CAs und
erlaubt HTTP im Feldnetz.

## Offline-Karten vorbereiten

* **Vor dem Einsatz:** Gebiet auf der Karte einstellen → ⬇ → Zoombereich → Herunterladen.
  Öffentliche Kartendienste (OSM) erlauben keinen Massendownload – für große
  Gebiete MBTiles verwenden.
* **MBTiles:** z. B. mit QGIS („XYZ-Kacheln generieren (MBTiles)“) oder
  MOBAC erzeugen, auf das Handy kopieren, ▤ → „Datei importieren“.
* **Eigener Kartenserver:** ⚙ → URL-Vorlage `https://server/tiles/{z}/{x}/{y}.png`.

## Entwicklung

```bash
cd eud
npm install
npm run dev          # Entwicklungsserver http://localhost:5173
npm test             # Unit-Tests (Koordinaten, Meshtastic-Protobufs)
npm run build        # erzeugt dist/ (wird vom LPU5-Server unter /eud/ ausgeliefert)
npx cap sync         # Web-Build in Android/iOS-Projekt kopieren
npm run android:apk  # Debug-APK lokal bauen (Android SDK nötig)
npx cap open ios     # Xcode (macOS)

# End-to-End-Test gegen laufenden Server (Login, Marker, Offline/Reconnect, Kamera)
EUD_URL=http://127.0.0.1:8101/eud/ LPU5_SERVER=http://127.0.0.1:8101 node test/e2e.mjs
```

Nach Änderungen an `src/` bitte `npm run build` ausführen und `dist/` mit
einchecken, damit der Server ohne Node.js die aktuelle PWA ausliefert.

### Aufbau

| Datei | Aufgabe |
|---|---|
| `src/main.js` | Start, Karte, Lagebild-Rendering, eigener Standort, Messen, Navigation |
| `src/panels.js` | Bedienfelder (Marker, Karten, Offline, Kontakte, Chat, Mesh, Video, Einstellungen) |
| `src/store.js` | IndexedDB (Kacheln, Marker, Overlays, Outbox, Spur, Einstellungen) |
| `src/sync.js` | Login, REST, WebSocket, Outbox mit Wiederholung |
| `src/tiles.js` | Offline-Kachel-Layer, Gebietsdownload, MBTiles-Import |
| `src/geo.js` | GPS (nativ im Hintergrund / Browser), Kompass |
| `src/mesh.js` | Meshtastic über BLE (nativ oder Web Bluetooth) |
| `src/camera.js` | Kamera teilen → Server-Videoanalyse |
| `src/symbols.js` | MIL-STD-2525C-Symbole (milsymbol) |
| `src/overlays.js` | KML/KMZ/GPX/GeoJSON, Bild-Overlays, Zeichnungen |
