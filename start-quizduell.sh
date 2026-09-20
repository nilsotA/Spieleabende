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
  echo "  Gebraucht wird Node 18 oder neuer."
  echo ""
  echo "  Am sichersten von https://nodejs.org – die Fassung aus der"
  echo "  Paketverwaltung (sudo apt install nodejs) ist je nach System"
  echo "  noch älter und reicht dann nicht."
  echo ""
  read -r -p "  Mit Eingabetaste schließen … " _
  exit 1
fi

echo ""
echo "  Quizduell startet … Der Host-Screen geht gleich im Browser auf."
echo "  Zum Beenden Strg+C drücken."
echo ""

QUIZDUELL_BROWSER=1 node server/index.js

# Stürzt der Server ab oder startet er gar nicht erst, soll die Meldung lesbar
# bleiben. Ein Dateimanager schließt das Fenster sonst in derselben Sekunde,
# in der die Erklärung darin erscheint – und der Host steht ohne Auskunft da.
ende=$?
# 130 und 143 sind Strg+C und „Fenster zu“ – der ganz normale Feierabend.
if [ $ende -ne 0 ] && [ $ende -ne 130 ] && [ $ende -ne 143 ]; then
  echo ""
  read -r -p "  Mit Eingabetaste schließen … " _
fi
