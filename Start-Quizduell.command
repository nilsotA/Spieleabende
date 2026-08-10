#!/bin/bash
# Doppelklick-Start für macOS.
#
# Der Finder öffnet .command-Dateien im Terminal und führt sie aus – das ist der
# kürzeste Weg von „Ordner heruntergeladen" zu „Spiel läuft", ohne dass jemand
# einen Befehl abtippen muss. Nach dem Start geht der Host-Screen von selbst auf.
#
# Einmalig nötig, falls der Doppelklick nichts tut:
#   chmod +x "Start-Quizduell.command"

cd "$(dirname "$0")" || exit 1

if ! command -v node > /dev/null 2>&1; then
  echo ""
  echo "  Node.js fehlt noch."
  echo ""
  echo "  Einmal installieren, dann läuft alles Weitere von allein:"
  echo "  https://nodejs.org  (die linke Schaltfläche, „LTS\")"
  echo ""
  echo "  Danach dieses Fenster schließen und die Datei erneut doppelklicken."
  echo ""
  read -r -p "  Mit Eingabetaste schließen … " _
  exit 1
fi

echo ""
echo "  Quizduell startet … Der Host-Screen geht gleich im Browser auf."
echo "  Zum Beenden dieses Fenster schließen oder Strg+C drücken."
echo ""

QUIZDUELL_BROWSER=1 node server/index.js
