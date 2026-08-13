#!/bin/bash
# Doppelklick-Start für macOS – für Abende, an denen nicht alle im selben WLAN
# sitzen.
#
# Gleicher Server, gleiches Spiel; davor legt sich nur ein Tunnel mit einer
# öffentlichen https-Adresse. Der QR-Code in der Lobby zeigt dann von selbst
# dorthin und trägt den Schlüssel für die Runde schon bei sich – zu tippen ist
# nichts, weder hier noch auf den Handys.
#
# Zu Hause im WLAN reicht weiterhin "Start-Quizduell.command"; dieses hier
# braucht zusätzlich cloudflared (kostenlos, kein Konto):  brew install cloudflared
#
# Einmalig nötig, falls der Doppelklick nichts tut:
#   chmod +x "Start-Quizduell-Online.command"

cd "$(dirname "$0")" || exit 1

if ! command -v node > /dev/null 2>&1; then
  echo ""
  echo "  Node.js fehlt noch."
  echo ""
  echo "  Einmal installieren, dann läuft alles Weitere von allein:"
  echo "  https://nodejs.org  (die linke Schaltfläche, „LTS\")"
  echo ""
  read -r -p "  Mit Eingabetaste schließen … " _
  exit 1
fi

echo ""
echo "  Quizduell startet – diesmal mit Tunnel nach draußen."
echo "  Der Host-Screen geht gleich im Browser auf; die Tunneladresse steht"
echo "  ein paar Sekunden später im QR-Code der Lobby."
echo ""
echo "  Zum Beenden dieses Fenster schließen oder Strg+C drücken."
echo ""

QUIZDUELL_BROWSER=1 QUIZDUELL_ONLINE=1 node server/index.js
