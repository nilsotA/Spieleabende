/**
 * Den Host-Screen im Standardbrowser aufmachen.
 *
 * Eigene Datei, damit die Plattformlogik geprüft werden kann, ohne beim
 * Importieren einen Server zu starten.
 *
 * Genutzt wird das nur von den Startskripten für den Doppelklick: Wer `npm
 * start` im Terminal tippt, hat den Browser meist schon offen und wird von
 * einem neuen Fenster eher gestört.
 */

/**
 * Welcher Befehl öffnet auf diesem System eine Adresse?
 *
 * Der leere String bei Windows ist kein Versehen: `start` deutet sein erstes
 * Argument in Anführungszeichen als Fenstertitel. Ohne den Platzhalter würde
 * die Adresse als Titel verstanden und es ginge nichts auf.
 */
export function browserBefehl(plattform) {
  if (plattform === 'darwin') return { befehl: 'open', args: [] };
  if (plattform === 'win32') return { befehl: 'cmd', args: ['/c', 'start', ''] };
  return { befehl: 'xdg-open', args: [] };
}

/**
 * Adresse öffnen – und dabei nichts kaputt machen dürfen.
 *
 * Auf einem Rechner ohne xdg-open (schlanke Linux-Installation, Server ohne
 * Oberfläche) schlägt der Aufruf fehl. Der Spieleabend hängt daran nicht: Die
 * Adresse steht ja im Fenster. Deshalb abgekoppelt, ohne Ausgabe und mit
 * abgefangenem Fehler.
 */
export async function oeffne(adresse) {
  const { spawn } = await import('node:child_process');
  const { befehl, args } = browserBefehl(process.platform);
  try {
    const kind = spawn(befehl, [...args, adresse], { detached: true, stdio: 'ignore' });
    kind.on('error', () => {});
    kind.unref();
    return true;
  } catch {
    return false;
  }
}
