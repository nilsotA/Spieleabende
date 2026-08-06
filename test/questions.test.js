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

test('der mitgelieferte Beispielsatz ist gültig', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(new URL('../data/beispiel-spieleabend.json', import.meta.url), 'utf8'));
  const set = normalizeSet(raw);
  assert.equal(set.rounds.length, 2);
  for (const round of set.rounds) {
    assert.equal(round.categories.length, 6);
    for (const cat of round.categories) assert.equal(cat.questions.length, 4);
  }
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
