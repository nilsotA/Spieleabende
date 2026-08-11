import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSet, stechenVorrat, QUESTIONS_PER_CATEGORY } from '../server/questions.js';

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

/**
 * Zwei Fragen mit derselben Lösung sind meistens Zufall – „Italien" ist die
 * Antwort auf vieles, und „4" erst recht. Teilen sich die beiden Fragen aber
 * auch noch zwei Inhaltswörter, ist es keine Lösung, die zufällig doppelt
 * vorkommt, sondern zweimal dieselbe Frage.
 *
 * Genau so ist eine Dopplung durchgerutscht, die die Ähnlichkeitsprüfung
 * darüber nicht gefunden hat, weil sie auf Wortüberschneidung im Fragetext
 * allein schaut und „Fußball-Weltmeister" anders zerlegt als
 * „Fußballweltmeister":
 *
 *   „In welchem Jahr wurde Deutschland zuletzt Fußball-Weltmeister?"
 *   „In welchem Jahr wurde Deutschland zum bislang letzten Mal Fußballweltmeister?"
 *
 * Über die gemeinsame Lösung fällt das Paar sofort auf. Zwei gemeinsame Wörter
 * sind die Schwelle, bei der aus Zufall Absicht wird: Bei einem gemeinsamen
 * Wort stehen zwölf einwandfreie Paare in den Sätzen, bei zweien keines.
 */
test('gleiche Lösung heißt nicht zweimal dieselbe Frage', async () => {
  const stopp = new Set([
    'der', 'die', 'das', 'des', 'dem', 'den', 'ein', 'eine', 'einer', 'eines',
    'und', 'oder', 'aus', 'von', 'für', 'mit', 'auf', 'ist', 'sind', 'was',
    'wer', 'wie', 'wo', 'welche', 'welcher', 'welches', 'welchem', 'welchen',
    'in', 'im', 'am', 'an', 'zu', 'zum', 'zur', 'es', 'man', 'sich', 'nicht',
    'heißt', 'nennt', 'gibt', 'hat', 'haben', 'seit', 'auch', 'noch', 'aber',
    'viele', 'einem', 'einen', 'beim', 'bei', 'nach', 'vor', 'über', 'unter',
    'wurde', 'wird',
  ]);
  const glatt = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const woerter = (t) => glatt(t).split(' ').filter((w) => w.length >= 4 && !stopp.has(w));
  // „Wahr" und „falsch" sind Antwortformate, keine Lösungen – in einer
  // Kategorie „Wahr oder falsch" stehen sie zwangsläufig mehrfach.
  const formatantwort = (a) => /^(wahr|falsch|ja|nein)\b/.test(glatt(a));

  const alle = [];
  for (const datei of DATEIEN) {
    const set = normalizeSet(JSON.parse(await readFile(new URL(datei, DATEN), 'utf8')));
    for (const round of set.rounds) {
      for (const cat of round.categories) {
        for (const q of cat.questions) alle.push({ datei, text: q.text, answer: q.answer });
      }
    }
  }

  const paare = [];
  for (let i = 0; i < alle.length; i++) {
    for (let j = i + 1; j < alle.length; j++) {
      const a = alle[i]; const b = alle[j];
      if (a.datei === b.datei) continue;
      if (glatt(a.answer) !== glatt(b.answer)) continue;
      if (formatantwort(a.answer)) continue;
      const ausA = new Set(woerter(a.text));
      const gemeinsam = woerter(b.text).filter((w) => ausA.has(w));
      if (gemeinsam.length >= 2) {
        paare.push(`„${a.answer}" – ${a.datei} / ${b.datei}\n     ${a.text}\n     ${b.text}`);
      }
    }
  }
  assert.deepEqual(paare, []);
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
  // Die „Was ist die Frage?"-Kategorien drehen Frage und Antwort um, ihre
  // Lösungen heißen deshalb „Wer ist Marie Curie?" statt „Marie Curie". Ohne
  // das Abstreifen dieser Hülle sind zwei Fragen über dieselbe Person für den
  // Vergleich verschieden – und genau so stand Marie Curie zweimal im Bestand,
  // in „Kopfnuss" und in „Kurios & Wahr", mit derselben Tatsache.
  const kern = (a) => a.toLowerCase()
    .replace(/^(was|wer|welche[rsn]?)\s+(ist|sind|war|waren)\s+/, '')
    .replace(/^(der|die|das|ein|eine|rund|aus|im|in|nach)\s+/, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  // Fragegerüste zählen nicht mit. „Welches Land hat die Form eines Stiefels?"
  // und „Welches Land hat diese Flagge?" haben beide die Lösung „Italien" und
  // teilen sich das halbe Gerüst – ohne diese Liste wären sie ein Treffer, und
  // fünf weitere Paare dieser Art gleich mit. Übrig bleibt, worum es in der
  // Frage wirklich geht.
  const geruest = new Set([
    'welche', 'welcher', 'welches', 'welchem', 'welchen',
    'diese', 'dieser', 'dieses', 'diesem', 'viele', 'heißt', 'hieß', 'heißen',
    'wurde', 'wird', 'kommt', 'kommen', 'steht', 'stehen', 'gehört',
    'eine', 'einer', 'eines', 'einem', 'einen', 'hatte', 'haben',
    'dass', 'dann', 'auch', 'noch', 'sich', 'nicht', 'seine', 'seiner', 'ihre',
    'land', 'jahr',
  ]);
  const worte = (t) => new Set(
    (t.toLowerCase().match(/[\p{L}]{4,}/gu) || []).filter((w) => !geruest.has(w)),
  );

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
        if (!a.size || !b.size) continue;
        const gemeinsam = [...a].filter((w) => b.has(w)).length;
        const anteil = gemeinsam / Math.max(1, Math.min(a.size, b.size));
        // 0,5 statt 0,6: Ohne die Gerüstwörter reichte auch 0,4 noch ohne
        // Fehlalarm – die Hälfte lässt Luft für künftige Fragen.
        if (anteil >= 0.5) {
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
  // Die Regel selbst steht in public/fragenpruefung.js – derselbe Code, den der
  // Editor beim Tippen anwendet. Zwei Fassungen derselben Regel würden über
  // kurz oder lang auseinanderlaufen, und dann warnt der Editor vor etwas
  // anderem, als der Testlauf verlangt.
  const { verraeteneLoesungen } = await import('../public/fragenpruefung.js');
  const verraeter = [];
  for (const datei of DATEIEN) {
    const set = normalizeSet(JSON.parse(await readFile(new URL(datei, DATEN), 'utf8')));
    set.rounds.forEach((round, ri) => {
      for (const cat of round.categories) {
        for (const { i, j, answer } of verraeteneLoesungen(cat.questions)) {
          verraeter.push(
            `${datei} R${ri + 1} „${cat.name}“: Lösung von Frage ${i + 1} („${answer}“) `
            + `steht schon in Frage ${j + 1} („${cat.questions[j].text}“)`,
          );
        }
      }
    });
  }
  assert.deepEqual(verraeter, []);
});

test('keine Frage verrät ihre eigene Lösung', async () => {
  // Der Klassiker unter den geschenkten Punkten: „Wer stellt sich mit ‚Mein
  // Name ist Bond. James Bond‘ vor?" – die Lösung steht im Zitat. Auf 200
  // Punkte kann daran niemand scheitern.
  //
  // Entweder-oder-Fragen („Was war zuerst: A oder B?") und Wahr-oder-falsch
  // nennen die Lösung notwendigerweise im Text. Das ist ihre Form und kein
  // Fehler, deshalb bleiben sie draußen.
  const einfach = (s) => s.toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const geschenkt = [];
  for (const datei of DATEIEN) {
    const set = normalizeSet(JSON.parse(await readFile(new URL(datei, DATEN), 'utf8')));
    set.rounds.forEach((round, ri) => {
      for (const cat of round.categories) {
        for (const q of cat.questions) {
          if (/ oder /i.test(q.text)) continue;
          // Nur die erste Lesart prüfen: „Paris/Frankreich" meint eine Lösung
          // mit zwei zulässigen Antworten. Am Komma wird bewusst nicht
          // getrennt – in „Wer im Glashaus sitzt, soll nicht mit Steinen
          // werfen" ist es Satzzeichen, und der halbe Satz steht natürlich in
          // der verdrehten Fassung, nach der die Frage sucht.
          const loesung = einfach(q.answer.split(/\/| bzw\.? | oder /i)[0]);
          if (loesung.length < 4) continue;
          if (new RegExp(`\\b${loesung.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(einfach(q.text))) {
            geschenkt.push(`${datei} R${ri + 1} „${cat.name}“: „${q.text}" enthält die Lösung „${q.answer}"`);
          }
        }
      }
    });
  }
  assert.deepEqual(geschenkt, []);
});

test('die geteilte Prüfung erkennt einen verratenen Fall und lässt heile Sätze in Ruhe', async () => {
  const { verraeteneLoesungen } = await import('../public/fragenpruefung.js');

  // Der Klassiker: Die Lösung der einen Frage steht im Text der anderen.
  const verraten = verraeteneLoesungen([
    { text: 'Wie heißt die Hauptstadt von Frankreich?', answer: 'Paris' },
    { text: 'In welcher Stadt steht der Eiffelturm – in Paris oder in Lyon?', answer: 'In der ersten' },
  ]);
  assert.equal(verraten.length, 1);
  assert.equal(verraten[0].i, 0);
  assert.equal(verraten[0].j, 1);

  // „Wahr" und „falsch" stehen in ihrer Kategorie zwangsläufig mehrfach.
  assert.deepEqual(verraeteneLoesungen([
    { text: 'Bananen wachsen an Bäumen.', answer: 'Falsch' },
    { text: 'Ein Chamäleon tarnt sich mit Farbe.', answer: 'Falsch' },
  ]), []);

  // Halb getippte Zeilen sind keine Warnung wert.
  assert.deepEqual(verraeteneLoesungen([
    { text: '', answer: '' },
    { text: 'Wie heißt die Hauptstadt von Frankreich?', answer: 'Paris' },
  ]), []);

  // Kurze Lösungen fallen nicht durchs Raster.
  const kurz = verraeteneLoesungen([
    { text: 'Wie schickte man früher kurze Nachrichten?', answer: 'SMS' },
    { text: 'Wofür steht die Abkürzung SMS?', answer: 'Short Message Service' },
  ]);
  assert.equal(kurz.length, 1, 'die Abkürzung steht in der Nachbarfrage');
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

test('der Zufallsmix verteilt sich über die Sätze', async () => {
  // „Zufallsmix aus allen Sätzen" soll sich auch so anfühlen. Vorher wurden
  // sechs Kategorien je Runde blind aus einem gemeinsamen Topf gezogen; bei acht
  // Sätzen kamen dabei typisch drei bis vier aus derselben Quelle und in etwa
  // jedem 150. Mix sechs von zwölf. Jetzt wird reihum über die Sätze gezogen.
  const { mixSet } = await import('../server/questions.js');

  // Fragetexte sind eindeutig, Kategorienamen nicht: „Was ist die Frage?" gibt
  // es in fast jedem Satz.
  const ausSatz = new Map();
  for (const datei of DATEIEN) {
    const set = JSON.parse(await readFile(new URL(datei, DATEN), 'utf8'));
    for (const round of set.rounds) {
      for (const cat of round.categories) {
        for (const q of cat.questions) ausSatz.set(q.text, datei);
      }
    }
  }

  const gesehen = new Map();
  for (let i = 0; i < 40; i++) {
    const mix = normalizeSet(await mixSet());
    const proSatz = new Map();
    for (const round of mix.rounds) {
      const inDieserRunde = new Map();
      for (const cat of round.categories) {
        const satz = ausSatz.get(cat.questions[0].text);
        assert.ok(satz, `Kategorie „${cat.name}" stammt aus keinem bekannten Satz`);
        proSatz.set(satz, (proSatz.get(satz) || 0) + 1);
        inDieserRunde.set(satz, (inDieserRunde.get(satz) || 0) + 1);
        gesehen.set(satz, (gesehen.get(satz) || 0) + 1);
      }
      // Solange es mindestens sechs Sätze gibt, ist eine Runde sechsmal
      // verschiedene Herkunft.
      if (DATEIEN.length >= 6) {
        const meiste = Math.max(...inDieserRunde.values());
        assert.equal(meiste, 1,
          `eine Runde zieht ${meiste} Kategorien aus demselben Satz`);
      }
    }
    const proMix = Math.max(...proSatz.values());
    assert.ok(proMix <= 2, `ein Mix zieht ${proMix} Kategorien aus demselben Satz`);
  }

  // Und über viele Mixe kommt jeder Satz auch wirklich vor.
  for (const datei of DATEIEN) {
    assert.ok(gesehen.get(datei) > 0, `${datei} kam in 40 Mixen kein einziges Mal vor`);
  }
});

test('der Vorrat fürs Stechen lässt Gespieltes und Bilder draußen', () => {
  const saetze = [{
    rounds: [{
      categories: [{
        name: 'Tiere',
        questions: [
          { text: 'Wie viele Beine hat eine Spinne?', answer: '8', note: 'Nicht 6.' },
          { text: 'Schon gehabt', answer: 'ja' },
          { text: 'Welche Flagge ist das?', answer: 'Katar', image: '/api/bild/b1' },
          { text: 'Ohne Antwort', answer: '' },
        ],
      }],
    }],
  }];
  const topf = stechenVorrat(saetze, ['  schon GEHABT ']);
  assert.deepEqual(topf.map((q) => q.text), ['Wie viele Beine hat eine Spinne?'],
    'Bildfragen, leere Antworten und schon Gestelltes fallen raus');
  assert.equal(topf[0].category, 'Tiere', 'die Kategorie fährt mit – sie steht am Kopf der Frage');
  assert.equal(topf[0].note, 'Nicht 6.');
});

test('ohne Ausschlüsse ist der Vorrat der ganze Satz', async () => {
  const { default: fsp } = await import('node:fs/promises');
  const { DATA_DIR } = await import('../server/questions.js');
  const dateien = (await fsp.readdir(DATA_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  const saetze = [];
  for (const f of dateien) {
    saetze.push(normalizeSet(JSON.parse(await fsp.readFile(`${DATA_DIR}/${f}`, 'utf8')), f));
  }
  const topf = stechenVorrat(saetze, []);
  // Genug Auswahl, damit ein Stechen auch nach mehreren Fragen nicht ausgeht.
  assert.ok(topf.length > 400, `nur ${topf.length} Fragen im Topf`);
  assert.ok(topf.every((q) => q.text && q.answer));
});
