@echo off
rem Doppelklick-Start für Windows – für Abende, an denen nicht alle im selben
rem WLAN sitzen.
rem
rem Gleicher Server, gleiches Spiel; davor legt sich nur ein Tunnel mit einer
rem öffentlichen https-Adresse. Der QR-Code in der Lobby zeigt dann von selbst
rem dorthin und trägt den Schlüssel für die Runde schon bei sich.
rem
rem Zu Hause im WLAN reicht weiterhin "Start-Quizduell.bat"; dieses hier braucht
rem zusätzlich cloudflared (kostenlos, kein Konto):
rem https://github.com/cloudflare/cloudflared/releases

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js fehlt noch.
  echo.
  echo   Einmal installieren, dann laeuft alles Weitere von allein:
  echo   https://nodejs.org  ^(die linke Schaltflaeche, "LTS"^)
  echo.
  pause
  exit /b 1
)

echo.
echo   Quizduell startet - diesmal mit Tunnel nach draussen.
echo   Der Host-Screen geht gleich im Browser auf; die Tunneladresse steht
echo   ein paar Sekunden spaeter im QR-Code der Lobby.
echo.
echo   Zum Beenden dieses Fenster schliessen oder Strg+C druecken.
echo.

set QUIZDUELL_BROWSER=1
set QUIZDUELL_ONLINE=1
node server\index.js

rem Stürzt der Server ab, soll die Meldung lesbar bleiben, statt dass sich das
rem Fenster sofort schließt.
if errorlevel 1 pause
