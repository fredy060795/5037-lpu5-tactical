@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM ======================================================================
REM  LPU5 Tactical – Web-Anwendung oeffnen
REM
REM  LPU5 laeuft als Web-Anwendung: EIN Rechner im TOC startet den Server
REM  (start_lpu5.bat), alle anderen Arbeitsplaetze, Tablets und Handys im
REM  selben WLAN oeffnen nur den Browser.
REM
REM  Dieses Skript:
REM   - startet den Server auf diesem PC, falls er noch nicht laeuft
REM   - oeffnet die Web-Oberflaeche im Standardbrowser
REM
REM  Fuer einen anderen Server im WLAN:  start_lpu5_client.bat 192.168.8.10
REM  (Der fruehere isolierte Desktop-Client LPU5.py ist weiterhin per
REM   "python LPU5.py" startbar, teilt aber KEINE Daten mit dem TOC.)
REM ======================================================================

set "HOST=%~1"
if not "%HOST%"=="" goto open_remote

netstat -an 2>nul | findstr "LISTENING" | findstr ":8101 " >nul 2>&1
if errorlevel 1 (
    echo [*] LPU5-Server laeuft noch nicht - wird gestartet ...
    start "LPU5 Tactical Server" cmd /k "%~dp0start_lpu5.bat"
    echo [*] Warte auf den Server ...
    for /l %%i in (1,1,60) do (
        timeout /t 2 /nobreak >nul
        netstat -an 2>nul | findstr "LISTENING" | findstr ":8101 " >nul 2>&1 && goto open_local
    )
    echo [WARN] Server antwortet noch nicht - Browser wird trotzdem geoeffnet.
)

:open_local
start "" "https://127.0.0.1:8101/"
exit /b 0

:open_remote
start "" "https://%HOST%:8101/"
exit /b 0
