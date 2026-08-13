/*
 * Wachhunde für die Seiten selbst.
 *
 * Anlass: Beim Spiel über den Tunnel blieb auf dem Handy eines Gastes eine
 * vollkommen leere dunkle Seite stehen. Ursache war ein `localStorage`-Zugriff
 * beim Laden des Moduls – in einem privaten Fenster wirft der, das Skript
 * stirbt, und weil alle Ansichten erst per JavaScript sichtbar geschaltet
 * werden, bleibt buchstäblich nichts übrig.
 *
 * Ein Browser lässt sich hier nicht starten. Diese Tests lesen deshalb die
 * Dateien: Sie halten die beiden Regeln fest, die den Fall unmöglich machen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const lies = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');

// Kommentare zählen nicht mit: In ihnen steht der Name absichtlich.
function ohneKommentare(quelle) {
  return quelle
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SEITEN = ['player.js', 'host.js', 'remote.js', 'common.js'];

test('kein ungeschützter Zugriff auf localStorage', () => {
  for (const datei of SEITEN) {
    const zeilen = ohneKommentare(lies(datei)).split('\n');
    const treffer = zeilen
      .map((z, i) => [i + 1, z])
      .filter(([, z]) => /localStorage/.test(z));
    // In common.js gehören genau die beiden Zeilen in lies()/merke() dazu –
    // die stehen dort in try/catch. Überall sonst läuft der Zugriff über
    // diese beiden Funktionen.
    const erlaubt = datei === 'common.js' ? 2 : 0;
    assert.equal(
      treffer.length,
      erlaubt,
      `${datei}: localStorage steht in Zeile(n) ${treffer.map(([n]) => n).join(', ')} `
      + '– im privaten Modus wirft schon der Zugriff, und das Modul stirbt beim Laden. '
      + 'Bitte lies()/merke() aus common.js benutzen.',
    );
  }
});

test('jede Seite hat die Startwache und gibt ein Lebenszeichen', () => {
  for (const [seite, skript] of [
    ['player.html', 'player.js'],
    ['host.html', 'host.js'],
    ['remote.html', 'remote.js'],
  ]) {
    const html = lies(seite);
    assert.match(
      html,
      /<script src="\/start-wache\.js"><\/script>/,
      `${seite} lädt die Startwache nicht – ein Absturz beim Laden bliebe eine leere Seite`,
    );
    // Die Wache muss vor dem Modul stehen, sonst verpasst sie dessen Fehler.
    assert.ok(
      html.indexOf('/start-wache.js') < html.indexOf(`/${skript}`),
      `${seite}: die Startwache muss vor ${skript} geladen werden`,
    );
    assert.match(
      ohneKommentare(lies(skript)),
      /window\.quizduellLaeuft = true;/,
      `${skript} meldet der Startwache nicht, dass die Seite steht – sie würde grundlos anschlagen`,
    );
  }
});

test('die Startwache selbst ist kein Modul und hat keine Importe', () => {
  const quelle = lies('start-wache.js');
  assert.doesNotMatch(quelle, /\bimport\b|\bexport\b/, 'sonst stirbt sie an demselben Problem wie das Modul');
  assert.match(quelle, /window\.quizduellLaeuft/, 'sie muss das Lebenszeichen abfragen');
});

test('die Spieleransicht zeigt die Anmeldung schon vor dem ersten Spielstand', () => {
  assert.match(
    ohneKommentare(lies('player.js')),
    /\$\('#view-join'\)\.classList\.add\('active'\)/,
    'ohne diese Zeile bleibt das Handy leer, solange die Verbindung hakt',
  );
});

/*
 * Der Notweg und der Meldeweg.
 *
 * Anlass: Beim Spiel über den Tunnel bekam ein iPhone nie einen Spielstand –
 * die Anmeldung stand da, aber ohne ein einziges Team und ohne ein Wort dazu.
 * Ein Ereignisstrom ist eine Antwort, die nie endet; wird sie unterwegs
 * gepuffert oder abgewiesen, passiert auf dem Handy gar nichts. Seitdem holt
 * sich die Seite den Zustand notfalls selbst ab und sagt, woran es hängt.
 */

test('bleibt der Ereignisstrom stumm, holt die Seite den Zustand selbst', () => {
  const quelle = ohneKommentare(lies('common.js'));
  assert.match(quelle, /\/api\/state\?clientId=/, 'ohne diesen Notweg hängt der Abend am Ereignisstrom allein');
  assert.match(quelle, /setTimeout\(\s*\(\)\s*=>\s*notwegAuf\(/, 'der Notweg muss von selbst aufmachen, nicht erst auf einen Fehler warten');
  assert.match(quelle, /addEventListener\('error'[\s\S]{0,400}notwegAuf\(/, 'und auch dann, wenn der Strom abgewiesen wird');
  assert.match(quelle, /stromKam = true;[\s\S]{0,120}notwegZu\(\)/, 'sobald der Strom liefert, muss der Notweg wieder zumachen');
});

test('ein Fehler beim Zeichnen verschwindet nicht mehr lautlos', () => {
  const quelle = ohneKommentare(lies('common.js'));
  assert.match(
    quelle,
    /try \{\s*onState\(sicht\);\s*\} catch \(err\) \{\s*panne\(err/,
    'wirft das Zeichnen, fror die Seite bisher ein und behauptete dabei, alles sei in Ordnung',
  );
  assert.match(quelle, /window\.quizduellPanne\?\.\(/, 'der Meldeweg führt zur Startwache');
  assert.match(ohneKommentare(lies('start-wache.js')), /window\.quizduellPanne = function/, 'und die muss ihn bereitstellen');
});

test('die Handys sagen, woran es hängt, solange kein Spielstand da ist', () => {
  for (const datei of ['player.js', 'remote.js']) {
    assert.match(
      ohneKommentare(lies(datei)),
      /onStatus:\s*\(text\)\s*=>/,
      `${datei}: ohne diese Zeile steht auf dem Handy eine leere Anmeldung ohne Erklärung`,
    );
  }
});
