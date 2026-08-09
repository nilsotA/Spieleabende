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

test('keine Frage ist eine umformulierte Fassung einer anderen', async () => {
  // Der Test darüber vergleicht Wortlaute. Der eigentliche Ärger sind aber
  // gleiche Fragen in anderen Worten: „Wie viele Tasten hat ein Klavier?" gegen
  // „Wie viele Tasten hat ein Klavier üblicherweise?". Der Zufallsmix zieht
  // Kategorien aus allen Sätzen – dieselbe Frage käme sonst zweimal am Abend.
  //
  // Gesucht wird nach gleicher Antwort UND deutlich überlappendem Fragetext.
  // Gleiche Antwort allein sagt nichts: „Sechs" ist die Lösung für Gitarrensaiten,
  // Volleyballspieler und die Nullen einer Million, und das sind drei Fragen.
  const kern = (a) => a.toLowerCase()
    .replace(/^(der|die|das|ein|eine|rund|aus|im|in|nach)\s+/, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  const worte = (t) => new Set((t.toLowerCase().match(/[\p{L}]{4,}/gu) || []));

  const nachAntwort = new Map();
  for (const datei of DATEIEN) {
    const set = normalizeSet(JSON.parse(await readFile(new URL(datei, DATEN), 'utf8')));
    for (const round of set.rounds) {
      for (const cat of round.categories) {
        for (const q of cat.questions) {
          const k = kern(q.answer);
          if (!nachAntwort.has(k)) nachAntwort.set(k, []);
          nachAntwort.get(k).push({ datei, text: q.text });
        }
      }
    }
  }

  const umformuliert = [];
  for (const liste of nachAntwort.values()) {
    for (let i = 0; i < liste.length; i++) {
      for (let j = i + 1; j < liste.length; j++) {
        if (liste[i].datei === liste[j].datei) continue;
        const a = worte(liste[i].text);
        const b = worte(liste[j].text);
        const gemeinsam = [...a].filter((w) => b.has(w)).length;
        const anteil = gemeinsam / Math.max(1, Math.min(a.size, b.size));
        if (anteil >= 0.6) {
          umformuliert.push(`„${liste[i].text}" (${liste[i].datei}) ≈ „${liste[j].text}" (${liste[j].datei})`);
        }
      }
    }
  }
  assert.deepEqual(umformuliert, [], 'dieselbe Frage in anderen Worten');
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

test('Bildkennungen hängen am Inhalt, nicht an der Reihenfolge', async () => {
  const { externalizeImages } = await import('../server/questions.js');
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bau = (reihenfolge) => ({
    name: 'x',
    rounds: [{
      categories: [{
        name: 'K',
        questions: reihenfolge.map((mitBild) => ({
          text: 't', answer: 'a', image: mitBild ? pixel : null, note: null,
        })),
      }],
    }],
  });

  const a = externalizeImages(bau([true, false, false, false]));
  const b = externalizeImages(bau([false, false, true, false]));

  const urlA = a.set.rounds[0].categories[0].questions[0].image;
  const urlB = b.set.rounds[0].categories[0].questions[2].image;
  assert.equal(urlA, urlB, 'dasselbe Bild muss dieselbe Adresse bekommen');
  assert.match(urlA, /^\/api\/bild\/b[0-9a-f]{16}$/);

  // Sonst zeigte der Browser im nächsten Spiel wegen des Caches das alte Bild.
  assert.ok(a.images.has(urlA.split('/').pop()));
});

test('der Zufallsmix zieht Runde 2 aus den Runde-2-Kategorien', async () => {
  const { mixSet } = await import('../server/questions.js');
  const { readdir, readFile: lies } = await import('node:fs/promises');

  // Welche Kategorienamen stehen in welcher Ursprungsrunde?
  const ursprung = [new Set(), new Set()];
  for (const datei of (await readdir(DATEN)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))) {
    const set = normalizeSet(JSON.parse(await lies(new URL(datei, DATEN), 'utf8')));
    set.rounds.forEach((round, ri) => {
      for (const cat of round.categories) ursprung[Math.min(ri, 1)].add(cat.name);
    });
  }

  for (let versuch = 0; versuch < 5; versuch++) {
    const mix = normalizeSet(await mixSet());
    for (const cat of mix.rounds[1].categories) {
      assert.ok(
        ursprung[1].has(cat.name),
        `„${cat.name}“ stammt aus Runde 1, steht im Mix aber in Runde 2 – dort zählt doppelt`,
      );
    }
  }
});

test('ein Satz mit fehlender Bilddatei wird gemeldet statt still gespielt', async () => {
  const { loadSet, DATA_DIR } = await import('../server/questions.js');
  const { writeFile, unlink } = await import('node:fs/promises');
  const path = await import('node:path');

  const datei = path.join(DATA_DIR, '.test-bildsatz.json');
  const satz = {
    name: 'Bildtest',
    description: 'x',
    rounds: [{
      categories: [{
        name: 'K',
        questions: Array.from({ length: 4 }, (_, i) => ({
          text: `Frage ${i}`,
          answer: `Antwort ${i}`,
          image: i === 0 ? '/bilder/gibt-es-nicht.svg' : null,
        })),
      }],
    }],
  };
  await writeFile(datei, JSON.stringify(satz), 'utf8');
  try {
    await assert.rejects(
      () => loadSet('.test-bildsatz.json'),
      /gibt-es-nicht\.svg/,
      'sonst startet das Spiel und die Frage ist mit leerem Kasten verbrannt',
    );
  } finally {
    await unlink(datei).catch(() => {});
  }
});
