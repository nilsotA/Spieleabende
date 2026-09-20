/**
 * Läuft das Spiel auf diesem Node überhaupt?
 *
 * Die Startskripte fragten nur, OB Node da ist. Das genügt nicht: Der Server
 * startet auch auf einem älteren, die Lobby geht auf, Teams legen sich an – und
 * beim ersten Feld, das jemand aufruft, stirbt er. Denn `handleAction` legt für
 * jeden Zug eine Sicherung mit `structuredClone` an (gibt es erst ab Node 17),
 * und „Frage verworfen" sucht mit `findLastIndex` zurück (erst ab Node 18).
 * Beides fällt genau dann auf, wenn alle schon im Raum sitzen.
 *
 * Deshalb: einmal vorne prüfen, in ganzen Sätzen sagen, was fehlt, und gar
 * nicht erst anfangen. Ein Abend, der nicht startet, ist ärgerlich; einer, der
 * bei Frage eins abbricht, ist schlimmer.
 *
 * `sudo apt install nodejs` liefert je nach Distribution noch 12 oder 16 – die
 * Empfehlung in den Startskripten führte also selbst in die Falle. Die Meldung
 * nennt darum den Weg, der überall ein aktuelles Node bringt.
 */

/** Ab hier läuft das Spiel. Siehe "engines" in der package.json. */
export const MINDEST_NODE = 18;

/**
 * Liefert die Meldung, die der Host lesen soll – oder null, wenn alles passt.
 *
 * Nimmt die Version als Text entgegen (`process.versions.node`), damit sich
 * beide Fälle prüfen lassen, ohne ein zweites Node zu installieren.
 */
export function nodeZuAlt(version) {
  const gross = Number(String(version).split('.')[0]);
  // Unlesbare Angabe: nicht im Weg stehen. Lieber einmal zu viel starten als
  // einen Abend an einer Zahl scheitern lassen, die wir nicht verstanden haben.
  if (!Number.isFinite(gross) || gross <= 0) return null;
  if (gross >= MINDEST_NODE) return null;

  return `
  Dieses Node ist zu alt für das Spiel.

    installiert:  Node ${version}
    gebraucht:    Node ${MINDEST_NODE} oder neuer

  Der Server würde noch starten – aber beim ersten Feld, das jemand aufruft,
  stiege er aus. Deshalb hier und nicht mitten im Spiel.

  Ein aktuelles Node holen:

    macOS    brew install node
    Windows  https://nodejs.org  (die linke Schaltfläche, „LTS“)
    Linux    https://nodejs.org  – „sudo apt install nodejs“ bringt je nach
             System noch eine ältere Fassung als gebraucht wird.

  Danach dieses Fenster schließen und neu starten.
`;
}
