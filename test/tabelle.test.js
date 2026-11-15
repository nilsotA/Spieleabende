import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { satzAusDatei, satzAusZeilen, zeilenAusCsv, zeilenAusXlsx } from '../public/tabelle.js';
import { normalizeSet } from '../server/questions.js';
import { baueVorlage } from '../werkzeug/fragen-vorlage.js';

/*
 * Ein Fragemeister, der mit .json nichts anfangen kann, füllt eine Tabelle
 * aus. Geprüft wird über echte Dateien: eine mit LibreOffice gespeicherte
 * .xlsx (so, wie Excel sie schreibt – mit gemeinsamen Zeichenketten) und die
 * CSV, aus der sie entstand.
 */

const ordner = new URL('./hilfen/', import.meta.url);
const alsDatei = async (name) => {
  const daten = await readFile(new URL(name, ordner));
  return { name, arrayBuffer: async () => daten.buffer.slice(daten.byteOffset, daten.byteOffset + daten.byteLength), text: async () => daten.toString('utf8') };
};

for (const datei of ['tabelle-ausgefuellt.xlsx', 'tabelle-ausgefuellt.csv']) {
  test(`eine ausgefüllte Vorlage wird ein spielbarer Fragensatz (${datei.split('.').pop()})`, async () => {
    const satz = normalizeSet(await satzAusDatei(await alsDatei(datei)));
    assert.equal(satz.name, 'Tims Fragenabend');
    assert.equal(satz.rounds.length, 2);
    assert.equal(satz.rounds[0].categories.length, 6);
    assert.equal(satz.rounds[1].categories[5].name, 'R2 Kategorie 6', 'der Kategoriename gilt für den ganzen Block');
    const q = satz.rounds[0].categories[0].questions;
    assert.equal(q.length, 4);
    assert.equal(q[0].text, 'Frage 1-1-1: Wer sagt „Hallo; Welt“?', 'Semikolon und Anführungszeichen überstehen');
    assert.equal(q[0].answer, 'Antwort 1.1.1');
    assert.equal(q[3].note, 'Ein Zusatz');
    assert.equal(q[0].note, null);
  });
}

test('die leere Vorlage selbst lässt sich lesen und sagt, dass noch nichts drinsteht', async () => {
  const zeilen = await zeilenAusXlsx(baueVorlage());
  assert.ok(zeilen.some((z) => z.includes('Frage') && z.includes('Antwort')), 'die Kopfzeile ist da');
  assert.throws(() => satzAusZeilen(zeilen), /noch keine einzige Frage/);
});

test('Tabellen ohne Vorlage: Spalten nach Überschrift, Reihenfolge nach Punkten, Fehler auf Deutsch', () => {
  const zeilen = zeilenAusCsv([
    'Lösung,Frage,Punkte,Kategorie',
    'Schwer,Frage C,500,Tiere',
    'Leicht,Frage A,100,',
    'Mittel,Frage B,200,',
    'Auch,Frage D,300,',
  ].join('\n'));
  const satz = satzAusZeilen(zeilen, 'meine-fragen.csv');
  assert.equal(satz.name, 'meine fragen', 'ohne Namenszeile gilt der Dateiname');
  assert.deepEqual(satz.rounds[0].categories[0].questions.map((q) => q.answer), ['Leicht', 'Mittel', 'Auch', 'Schwer']);
  assert.throws(() => satzAusZeilen([['a', 'b'], ['c', 'd']]), /Kopfzeile mit „Frage“ und „Antwort“/);
  // Eine Kategorie mit drei Fragen lässt der Server mit klarer Meldung nicht durch.
  const drei = satzAusZeilen(zeilenAusCsv('Kategorie;Frage;Antwort\nX;1;a\n;2;b\n;3;c'));
  assert.throws(() => normalizeSet(drei), /hat 3 Fragen – es müssen genau 4 sein/);
});

test('die Vorlage im Ordner public ist die, die das Werkzeug baut', async () => {
  const imOrdner = await readFile(new URL('../public/Fragen-Vorlage.xlsx', import.meta.url));
  assert.ok(Buffer.compare(imOrdner, baueVorlage()) === 0, 'node werkzeug/fragen-vorlage.js laufen lassen');
});
