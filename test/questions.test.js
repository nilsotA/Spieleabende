import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSet, QUESTIONS_PER_CATEGORY } from '../server/questions.js';

const frage = (i) => ({ text: `Frage ${i}`, answer: `Antwort ${i}` });
const kategorie = (name, anzahl = QUESTIONS_PER_CATEGORY) => ({
  name,
  questions: Array.from({ length: anzahl }, (_, i) => frage(i)),
});
const satz = (kategorien) => ({ name: 'Test', rounds: [{ categories: kategorien }] });

test('gültiger Fragensatz kommt unverändert durch', () => {
  const set = normalizeSet(satz([kategorie('A'), kategorie('B')]));
  assert.equal(set.rounds[0].categories.length, 2);
  assert.equal(set.rounds[0].categories[0].questions.length, 4);
  assert.equal(set.rounds[0].categories[0].questions[0].text, 'Frage 0');
});

test('zu viele Fragen werden nicht stillschweigend abgeschnitten', () => {
  assert.throws(
    () => normalizeSet(satz([kategorie('Lang', 6)])),
    /6 Fragen/,
    'sonst verliert ein Roundtrip durch den Editor die Fragen 5 und 6',
  );
});

test('zu wenige Fragen werden abgelehnt statt das Board zu verziehen', () => {
  assert.throws(() => normalizeSet(satz([kategorie('Kurz', 2), kategorie('Voll')])), /2 Fragen/);
});

test('leere Frage oder Antwort wird gemeldet', () => {
  const kaputt = kategorie('A');
  kaputt.questions[2].answer = '   ';
  assert.throws(() => normalizeSet(satz([kaputt])), /keine Antwort/);

  const ohneText = kategorie('B');
  ohneText.questions[0].text = '';
  assert.throws(() => normalizeSet(satz([ohneText])), /keinen Text/);
});

test('Bild und Zusatzhinweis überleben die Prüfung', () => {
  const mitBild = kategorie('A');
  mitBild.questions[0].image = '/bilder/foto.jpg';
  mitBild.questions[0].note = 'Nicht Sydney!';
  const set = normalizeSet(satz([mitBild]));
  assert.equal(set.rounds[0].categories[0].questions[0].image, '/bilder/foto.jpg');
  assert.equal(set.rounds[0].categories[0].questions[0].note, 'Nicht Sydney!');
  assert.equal(set.rounds[0].categories[0].questions[1].image, null);
});

test('Fragensatz ohne Runden oder Kategorien wird abgelehnt', () => {
  assert.throws(() => normalizeSet({ name: 'X' }), /keine Runden/);
  assert.throws(() => normalizeSet({ rounds: [{ categories: [] }] }), /keine Kategorien/);
  assert.throws(() => normalizeSet(null), /kein Objekt/);
});

test('mehr als 8 Kategorien passen nicht aufs Board', () => {
  const viele = Array.from({ length: 9 }, (_, i) => kategorie(`K${i}`));
  assert.throws(() => normalizeSet(satz(viele)), /9 Kategorien/);
});

/* Jeder mitgelieferte Satz wird geprüft – ein kaputter Satz fiele sonst erst
   am Spieleabend auf, wenn das Menü ihn ausgegraut anzeigt. */

const { readdir, readFile } = await import('node:fs/promises');
const DATEN = new URL('../data/', import.meta.url);
const DATEIEN = (await readdir(DATEN))
  .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  .sort();

test('es sind mehrere Fragensätze dabei', () => {
  assert.ok(DATEIEN.length >= 4, `nur ${DATEIEN.length} Sätze gefunden`);
});

for (const datei of DATEIEN) {
  test(`Fragensatz ${datei} ist gültig`, async () => {
    const raw = JSON.parse(await readFile(new URL(datei, DATEN), 'utf8'));
    const set = normalizeSet(raw);
    assert.ok(set.name, 'Name fehlt');
    assert.ok(set.description, 'Beschreibung fehlt');
    assert.equal(set.rounds.length, 2, 'genau zwei Runden erwartet');
    for (const round of set.rounds) {
      assert.equal(round.categories.length, 6, 'sechs Kategorien pro Runde');
      const namen = round.categories.map((c) => c.name);
      assert.equal(new Set(namen).size, namen.length, 'Kategorienamen doppelt');
      for (const cat of round.categories) {
        assert.equal(cat.questions.length, 4);
        for (const q of cat.questions) {
          assert.ok(q.text.trim().length > 5, `zu kurze Frage in ${cat.name}`);
          assert.ok(q.answer.trim().length > 0);
        }
      }
    }
  });
}

test('keine Frage kommt in zwei Sätzen doppelt vor', async () => {
  const gesehen = new Map();
  const dopplungen = [];
  for (const datei of DATEIEN) {
    const set = normalizeSet(JSON.parse(await readFile(new URL(datei, DATEN), 'utf8')));
    for (const round of set.rounds) {
      for (const cat of round.categories) {
        for (const q of cat.questions) {
          const schluessel = `${q.text}|${q.answer}`.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
          if (gesehen.has(schluessel)) dopplungen.push(`${q.text} (${datei} und ${gesehen.get(schluessel)})`);
          gesehen.set(schluessel, datei);
        }
      }
    }
  }
  assert.deepEqual(dopplungen, [], 'gleiche Frage in mehreren Sätzen');
});

test('der gesicherte Spielstand taucht nicht als Fragensatz auf', async () => {
  const { listSets, DATA_DIR } = await import('../server/questions.js');
  const { writeFile, unlink } = await import('node:fs/promises');
  const path = await import('node:path');
  const spielstand = path.join(DATA_DIR, '.test-spielstand.json');
  await writeFile(spielstand, JSON.stringify({ state: { phase: 'board' } }), 'utf8');
  try {
    const sets = await listSets();
    assert.ok(
      !sets.some((s) => s.file.startsWith('.')),
      'Punktdateien gehören nicht in die Fragensatz-Auswahl',
    );
  } finally {
    await unlink(spielstand).catch(() => {});
  }
});

test('der Zufallsmix baut ein vollständiges Board aus allen Sätzen', async () => {
  const { mixSet } = await import('../server/questions.js');
  const mix = normalizeSet(await mixSet());

  assert.equal(mix.rounds.length, 2);
  const namen = mix.rounds.flatMap((r) => r.categories.map((c) => c.name));
  assert.equal(namen.length, 12);
  assert.equal(new Set(namen).size, 12, 'jede Kategorie darf nur einmal vorkommen');
  for (const round of mix.rounds) {
    for (const cat of round.categories) assert.equal(cat.questions.length, 4);
  }
});

test('zwei Mixe unterscheiden sich', async () => {
  const { mixSet } = await import('../server/questions.js');
  const alsText = async () =>
    (await mixSet()).rounds.flatMap((r) => r.categories.map((c) => c.name)).join('|');
  // Bei 40+ Kategorien wäre zweimal dieselbe Auswahl in dieser Reihenfolge
  // astronomisch unwahrscheinlich; zehn Versuche schließen einen festen Mix aus.
  const proben = new Set();
  for (let i = 0; i < 10; i++) proben.add(await alsText());
  assert.ok(proben.size > 1, 'der Mix würfelt nicht');
});

/**
 * Innerhalb einer Kategorie darf keine Frage die Lösung einer anderen verraten.
 * Genau das war passiert: Die 100er-Frage nannte den Mount Everest als Antwort,
 * die 500er fragte nach dessen Gebirge – damit war die teuerste Frage geschenkt.
 */
test('keine Frage verrät die Lösung einer anderen derselben Kategorie', async () => {
  const stoppwoerter = new Set([
    'der', 'die', 'das', 'des', 'dem', 'den', 'ein', 'eine', 'einer', 'eines',
    'und', 'oder', 'aus', 'von', 'für', 'mit', 'auf', 'ist', 'sind', 'was',
    'wer', 'wie', 'wo', 'welche', 'welcher', 'welches', 'welchem', 'welchen',
    'in', 'im', 'am', 'an', 'zu', 'zum', 'zur', 'es', 'man', 'sich', 'nicht',
    'heißt', 'nennt', 'gibt', 'hat', 'haben', 'seit', 'auch', 'noch', 'aber',
  ]);
  // Antwortformate, die in ihrer Kategorie naturgemäß mehrfach vorkommen.
  const formatantworten = /^(wahr|falsch|ja|nein)\b/i;

  const kernwoerter = (text) =>
    text.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !stoppwoerter.has(w));

  const verraeter = [];
  for (const datei of DATEIEN) {
    const set = normalizeSet(JSON.parse(await readFile(new URL(datei, DATEN), 'utf8')));
    set.rounds.forEach((round, ri) => {
      for (const cat of round.categories) {
        cat.questions.forEach((q, i) => {
          if (formatantworten.test(q.answer.trim())) return;
          const loesung = kernwoerter(q.answer);
          if (!loesung.length) return;
          cat.questions.forEach((andere, j) => {
            if (i === j) return;
            const anderswo = kernwoerter(`${andere.text} ${andere.answer}`);
            // Erst wenn die Lösung vollständig anderswo steht, ist sie verraten.
            // Ganze Wörter, damit „Spiel“ nicht in „Spieleabend“ anschlägt.
            const vollstaendig = loesung.every((w) => anderswo.includes(w));
            if (vollstaendig) {
              verraeter.push(
                `${datei} R${ri + 1} „${cat.name}“: Lösung von Frage ${i + 1} („${q.answer}“) `
                + `steht schon in Frage ${j + 1} („${andere.text}“)`,
              );
            }
          });
        });
      }
    });
  }
  assert.deepEqual(verraeter, []);
});
