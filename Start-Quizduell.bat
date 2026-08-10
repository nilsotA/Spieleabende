@echo off
rem Doppelklick-Start für Windows.
rem
rem Der Explorer führt .bat-Dateien direkt aus. Nach dem Start geht der
rem Host-Screen von selbst im Browser auf; das Fenster bleibt offen, solange
rem gespielt wird.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js fehlt noch.
  echo.
  echo   Einmal installieren, dann laeuft alles Weitere von allein:
  echo   https://nodejs.org  ^(die linke Schaltflaeche, "LTS"^)
  echo.
  echo   Danach dieses Fenster schliessen und die Datei erneut doppelklicken.
  echo.
  pause
  exit /b 1
)

echo.
echo   Quizduell startet ... Der Host-Screen geht gleich im Browser auf.
echo   Zum Beenden dieses Fenster schliessen oder Strg+C druecken.
echo.

set QUIZDUELL_BROWSER=1
node server\index.js

rem Stürzt der Server ab, soll die Meldung lesbar bleiben, statt dass sich das
rem Fenster sofort schließt.
if errorlevel 1 pause
