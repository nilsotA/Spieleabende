#!/bin/bash
# Start für Linux – für Abende, an denen nicht alle im selben WLAN sitzen.
#
# Gleicher Server, gleiches Spiel; davor legt sich nur ein Tunnel mit einer
# öffentlichen https-Adresse. Der QR-Code in der Lobby zeigt dann von selbst
# dorthin und trägt den Schlüssel für die Runde schon bei sich.
#
# Zu Hause im WLAN reicht weiterhin ./start-quizduell.sh; dieses hier braucht
# zusätzlich cloudflared (kostenlos, kein Konto).
#
# Falls der Doppelklick nichts tut:
#   chmod +x start-quizduell-online.sh

cd "$(dirname "$0")" || exit 1

if ! command -v node > /dev/null 2>&1; then
  echo ""
  echo "  Node.js fehlt noch."
  echo ""
  echo "  Über die Paketverwaltung installieren, zum Beispiel:"
  echo "    sudo apt install nodejs      (Debian, Ubuntu, Mint)"
  echo "    sudo dnf install nodejs      (Fedora)"
  echo "  Oder von https://nodejs.org"
  echo ""
  read -r -p "  Mit Eingabetaste schließen … " _
  exit 1
fi

echo ""
echo "  Quizduell startet – diesmal mit Tunnel nach draußen."
echo "  Der Host-Screen geht gleich im Browser auf; die Tunneladresse steht"
echo "  ein paar Sekunden später im QR-Code der Lobby."
echo ""
echo "  Zum Beenden Strg+C drücken."
echo ""

QUIZDUELL_BROWSER=1 QUIZDUELL_ONLINE=1 node server/index.js
