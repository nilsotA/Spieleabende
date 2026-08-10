#!/bin/bash
# Start für Linux – per Doppelklick (in den meisten Dateimanagern nach einem
# Rechtsklick → „Ausführen") oder im Terminal mit ./start-quizduell.sh
#
# Falls der Doppelklick nichts tut:
#   chmod +x start-quizduell.sh

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
echo "  Quizduell startet … Der Host-Screen geht gleich im Browser auf."
echo "  Zum Beenden Strg+C drücken."
echo ""

QUIZDUELL_BROWSER=1 node server/index.js
