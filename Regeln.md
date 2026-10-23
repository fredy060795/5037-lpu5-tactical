# Regeln für Agents

> **Pflichtlektüre zu Beginn jeder Agenten-Sitzung und vor jedem Push / Pull Request**

---

## 1. Pflichtlektüre

Der Agent **muss** diese Regeln und die Datei **`Funktzions.md`** zu Beginn jeder Sitzung lesen,
bevor er Code ändert. `Funktzions.md` listet alle Funktionen des Systems mit ihrem Status:

| Status | Bedeutung |
|---|---|
| `[#]` | **Geschützt** – funktioniert und ist vom Besitzer abgenommen |
| `[]` | Neu oder noch nicht abgenommen – darf weiterentwickelt werden |

Neue Funktionen trägt der Agent mit `[]` in `Funktzions.md` ein. **Nur der Besitzer** setzt `[#]`.

## 2. Geschützte Funktionen `[#]`

Das **Verhalten** einer `[#]`-Funktion – was der Benutzer sieht und wie er sie bedient – darf
**nicht ohne ausdrückliche Anweisung** verändert werden. Das heißt insbesondere:
keine Umgestaltung, kein Entfernen, kein anderer Ablauf, kein Umbau „weil es schöner ist“.

### 2.1 Erlaubte Eingriffe ohne Rückfrage

Ohne vorherige Rückfrage erlaubt sind nur diese Fälle:

1. **Fehlerbehebung**: Die Funktion arbeitet nachweislich nicht so, wie sie in `Funktzions.md` beschrieben
   ist (Absturz, Serverfehler, falsches Ergebnis).
2. **Sicherheitskorrektur**: Lücken wie fehlende Prüfung, Umgehung von Ablaufdaten, unsichere Speicherung.
3. **Mitbenutzter Code**: Eine neue Funktion braucht gemeinsamen Code (z. B. einen Server-Endpunkt);
   die `[#]`-Funktion muss sich danach für den Benutzer genauso verhalten wie vorher.

Für jeden dieser Eingriffe gilt:

- **Minimal**: nur das, was der Fehler erfordert; keine Nebenbei-Umbauten.
- **Vorher/nachher geprüft**: Fehler reproduzieren, nach der Korrektur erneut testen, bestehende Tests grün.
- **Offengelegt**: In der Commit-Nachricht steht `[#]-Eingriff: <Funktion> – <Grund>`, und der Agent meldet
  den Eingriff dem Besitzer in seiner Antwort.

### 2.2 Immer Rückfrage

Rückfrage beim Besitzer ist nötig, wenn die Korrektur das sichtbare Verhalten ändern würde
(z. B. andere Bedienung, neue Pflichtfelder, abgewiesene Eingaben, die vorher angenommen wurden,
ohne dass dies eine Sicherheitskorrektur ist) oder wenn unklar ist, ob ein Verhalten Absicht ist.

## 3. Verbot von Simulationen

Es ist **verboten**, Simulationen in das System einzubauen.
Alle Implementierungen müssen auf echten Daten und realen Systemkomponenten basieren. Simulierte Zustände,
Mock-Daten oder Dummy-Implementierungen dürfen nicht in den produktiven Code einfließen.

Testdaten sind nur in Testdateien erlaubt (`test_*.py`, `eud/test/`) und werden nie vom
produktiven System geladen.

## 4. Hardware-Abhängigkeiten prüfen und kommunizieren

Wenn eine Funktion Hardware-Abhängigkeiten benötigt (z. B. `rtl_tcp` für SDR, serielle Schnittstellen für
Meshtastic), **muss** das System:

1. **Beim Start prüfen**, ob die benötigten System-Tools und Python-Pakete installiert sind.
2. **Den Benutzer klar informieren**, wenn eine Abhängigkeit fehlt – mit dem genauen Namen und dem Installationsbefehl.
3. **Automatisch installieren**, was per `pip install` möglich ist (Python-Pakete werden über `requirements.txt` beim Start installiert).
4. **Auf fehlende System-Tools hinweisen**, die manuell installiert werden müssen (z. B. `sudo apt install rtl-sdr`), inklusive dem konkreten Installationsbefehl.
5. **Den API-Endpunkt `/api/dependencies/check`** aktuell halten, sodass zur Laufzeit der vollständige Status aller Abhängigkeiten abgefragt werden kann.

### Beispiele für Hardware-Abhängigkeiten

| Abhängigkeit | Typ | Funktion | Installationsbefehl |
|---|---|---|---|
| `rtl_tcp` | System-Tool | SDR TCP-Server | `sudo apt install rtl-sdr` |
| `rtl_power` | System-Tool | SDR Frequenzscan | `sudo apt install rtl-sdr` |
| `rtl_fm` | System-Tool | SDR FM-Demodulation | `sudo apt install rtl-sdr` |
| `pyrtlsdr` | Python-Paket | Direkte SDR-Hardware | `pip install pyrtlsdr` |
| `numpy` | Python-Paket | Schnelle FFT-Verarbeitung | `pip install numpy` |
| `pyserial` | Python-Paket | Serielle Ports | `pip install pyserial` |
| `meshtastic` | Python-Paket | Meshtastic-Geräte | `pip install meshtastic` |

## 5. Arbeitsweise

1. **Vor jedem Push prüfen**: Server-Tests (`python -m pytest -q test_*.py`), EUD-Tests und -Build
   (`cd eud && npm test && npm run build`), bei Oberflächenänderungen ein Test im Browser
   (Querformat und Hochformat).
2. **CI im Blick behalten**: Nach dem Push muss GitHub Actions (APK, iOS, PWA, Tests) grün werden;
   ein roter Lauf wird sofort behoben.
3. **Ehrlich berichten**: Was nicht getestet wurde (z. B. echtes Gerät), wird ausdrücklich gesagt.
   Gefundene Fehler werden gemeldet, auch wenn sie nicht behoben werden.
4. **Doku aktuell halten**: `HANDBUCH.md` und `Funktzions.md` werden mit jeder neuen oder geänderten
   Funktion nachgeführt.
5. **Keine Pull Requests ohne Auftrag** des Besitzers.

---

## ✅ Bestätigung durch den Agent

Der Agent befolgt diese Regeln bei allen Aktionen in diesem Repository:

- Regeln und `Funktzions.md` werden zu Beginn jeder Sitzung gelesen.
- `[#]`-Funktionen werden nur nach Abschnitt 2 angefasst; jeder Eingriff wird offengelegt.
- Es werden keine Simulationen, Mock-Daten oder Dummy-Implementierungen in den produktiven Code eingefügt.
- Fehlende Hardware-Abhängigkeiten werden beim Start geprüft, kommuniziert und – soweit möglich – automatisch installiert.
