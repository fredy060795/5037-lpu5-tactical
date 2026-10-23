@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM ======================================================================
REM  LPU5 Tactical – Server beim Windows-Start automatisch starten
REM  (fuer den TOC-Server-PC). Einmalig als Administrator ausfuehren.
REM  Entfernen:  install_autostart.bat remove
REM ======================================================================
set "TASK=LPU5 Tactical Server"
if /i "%~1"=="remove" (
    schtasks /delete /tn "%TASK%" /f
    exit /b %errorlevel%
)
schtasks /create /tn "%TASK%" /sc onlogon /rl highest /f ^
    /tr "cmd /c \"set LPU5_NO_BROWSER=1&& set SKIP_UPDATE=1&& cd /d \"%~dp0\" && start \"LPU5 Tactical Server\" /min cmd /k start_lpu5.bat\""
if errorlevel 1 (
    echo [FEHLER] Aufgabe konnte nicht angelegt werden - bitte als Administrator ausfuehren.
    pause
    exit /b 1
)
echo [OK] LPU5 startet ab jetzt bei der Anmeldung automatisch.
pause
