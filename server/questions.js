import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');

/** Anzahl Fragen je Kategorie – entspricht den Punktereihen 100/200/300/500. */
export const QUESTIONS_PER_CATEGORY = 4;
const MAX_TEXT = 2000;

/**
 * Validiert und normalisiert einen Fragensatz.
 * Erwartet: { name, rounds: [ { categories: [ { name, questions: [ {text, answer, image?, note?} ] } ] } ] }
 *
 * Wirft bei allem, was das Board verziehen oder Inhalte verlieren würde – lieber eine
 * klare Meldung im Fragensatz-Menü als ein verrutschtes Board am Beamer.
 */
export function normalizeSet(raw, fallbackName = 'Fragensatz') {
  if (!raw || typeof raw !== 'object') throw new Error('Fragensatz ist kein Objekt.');
  const rounds = Array.isArray(raw.rounds) ? raw.rounds : null;
  if (!rounds || rounds.length === 0) throw new Error('Fragensatz enthält keine Runden.');

  const normRounds = rounds.map((round, ri) => {
    const cats = Array.isArray(round.categories) ? round.categories : [];
    if (cats.length === 0) throw new Error(`Runde ${ri + 1} hat keine Kategorien.`);
    if (cats.length > 8) throw new Error(`Runde ${ri + 1} hat ${cats.length} Kategorien – höchstens 8 passen aufs Board.`);
    return {
      categories: cats.map((cat, ci) => {
        const label = `„${cat?.name || ci + 1}" in Runde ${ri + 1}`;
        const qs = Array.isArray(cat?.questions) ? cat.questions : [];
        if (qs.length !== QUESTIONS_PER_CATEGORY) {
          throw new Error(
            `Kategorie ${label} hat ${qs.length} Fragen – es müssen genau ${QUESTIONS_PER_CATEGORY} sein.`,
          );
        }
        return {
          name: String(cat.name || `Kategorie ${ci + 1}`).slice(0, 40),
          questions: qs.map((q, qi) => {
            const text = String(q?.text ?? '');
            const answer = String(q?.answer ?? '');
            if (!text.trim()) throw new Error(`Frage ${qi + 1} in Kategorie ${label} hat keinen Text.`);
            if (!answer.trim()) throw new Error(`Frage ${qi + 1} in Kategorie ${label} hat keine Antwort.`);
            if (text.length > MAX_TEXT || answer.length > MAX_TEXT) {
              throw new Error(`Frage ${qi + 1} in Kategorie ${label} ist länger als ${MAX_TEXT} Zeichen.`);
            }
            return {
              text,
              answer,
              image: q.image ? String(q.image) : null,
              note: q.note ? String(q.note).slice(0, MAX_TEXT) : null,
            };
          }),
        };
      }),
    };
  });

  return {
    name: String(raw.name || fallbackName).slice(0, 80),
    description: raw.description ? String(raw.description).slice(0, 300) : '',
    rounds: normRounds,
  };
}

/* --------------------------------------------------------------- Dateien */

// Fragensätze mit eingebetteten Fotos sind schnell mehrere MB groß. Ohne Cache
// würde jedes Öffnen der Liste sie alle neu parsen und dabei den Server blockieren.
const cache = new Map(); // datei -> { mtimeMs, size, info }

export async function listSets() {
  let files = [];
  try {
    files = await readdir(DATA_DIR);
  } catch {
    return [];
  }
  const out = [];
  // Punktdateien überspringen: der gesicherte Spielstand ist kein Fragensatz.
  for (const file of files.filter((f) => f.endsWith('.json') && !f.startsWith('.'))) {
    const full = path.join(DATA_DIR, file);
    try {
      const info = await stat(full);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
        out.push(hit.info);
        continue;
      }
      const set = normalizeSet(JSON.parse(await readFile(full, 'utf8')), file.replace(/\.json$/, ''));
      await pruefeBilder(set, file);
      const entry = {
        file,
        name: set.name,
        description: set.description,
        rounds: set.rounds.length,
        questions: set.rounds.reduce(
          (sum, r) => sum + r.categories.reduce((s, c) => s + c.questions.length, 0),
          0,
        ),
      };
      cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, info: entry });
      out.push(entry);
    } catch (err) {
      const entry = { file, name: file, error: err.message };
      cache.delete(file);
      out.push(entry);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/**
 * Prüft, ob alle Bilder aus data/bilder wirklich da sind. Ohne das startet das
 * Spiel klaglos und die Frage ist mit einem leeren Kasten verbrannt – etwa wenn
 * jemand nur die JSON-Datei weitergegeben hat.
 */
async function pruefeBilder(set, quelle) {
  const fehlend = new Set();
  for (const round of set.rounds) {
    for (const cat of round.categories) {
      for (const q of cat.questions) {
        if (!q.image || !q.image.startsWith('/bilder/')) continue;
        const datei = path.basename(q.image);
        try {
          await stat(path.join(DATA_DIR, 'bilder', datei));
        } catch {
          fehlend.add(datei);
        }
      }
    }
  }
  if (fehlend.size) {
    throw new Error(
      `${quelle}: ${fehlend.size === 1 ? 'Das Bild fehlt' : 'Diese Bilder fehlen'} in data/bilder – `
      + [...fehlend].join(', '),
    );
  }
}

export async function loadSet(file) {
  const safe = path.basename(String(file || ''));
  if (!safe.endsWith('.json')) throw new Error('Ungültige Datei.');
  // Fehlt die Datei, kam bisher die Meldung des Betriebssystems durch – auf
  // Englisch und samt vollständigem Pfad („ENOENT … open '/home/…/data/x.json'").
  // Das half niemandem und verriet die Ordnerstruktur an jedes Gerät im WLAN.
  const roh = await readFile(path.join(DATA_DIR, safe), 'utf8').catch(() => {
    throw new Error(`Den Fragensatz „${safe}“ gibt es nicht (mehr).`);
  });
  const raw = JSON.parse(roh);
  const set = normalizeSet(raw, safe.replace(/\.json$/, ''));
  await pruefeBilder(set, safe);
  return set;
}

/**
 * Eingebettete Bilder (data:-URIs) aus dem Fragensatz herauslösen.
 *
 * Sonst würde jedes Foto bei jedem einzelnen Zustandsupdate erneut an alle
 * Handys gehen – und die Buzzer-Freigabe je nach Gerät unterschiedlich stark
 * verzögern. Als eigene Adresse kann der Browser sie stattdessen cachen.
 */
export function externalizeImages(set) {
  const images = new Map(); // id -> { type, buffer }
  for (const round of set.rounds) {
    for (const cat of round.categories) {
      for (const q of cat.questions) {
        if (!q.image || !q.image.startsWith('data:')) continue;
        const match = /^data:([^;,]+);base64,(.*)$/s.exec(q.image);
        if (!match) continue;
        const buffer = Buffer.from(match[2], 'base64');
        // Kennung aus dem Bildinhalt, nicht aus der Reihenfolge: sonst zeigt
        // „/api/bild/b1“ im nächsten Spiel etwas anderes, und der Browser
        // liefert wegen des Caches eine Stunde lang das Bild von vorhin.
        const id = `b${createHash('sha1').update(buffer).digest('hex').slice(0, 16)}`;
        images.set(id, { type: match[1], buffer });
        q.image = `/api/bild/${id}`;
      }
    }
  }
  return { set, images };
}

/**
 * Der Vorrat, aus dem das Stechen seine Entscheidungsfrage zieht: alle Fragen
 * aller Sätze, abzüglich derer, die an diesem Abend schon dran waren.
 *
 * Bilderfragen bleiben draußen. Ihre Dateien liegen nur für den gespielten Satz
 * bereit – eine Flagge aus einem anderen Satz käme als leerer Kasten auf die
 * Leinwand, und das ausgerechnet in der Frage, die den Abend entscheidet.
 */
export function stechenVorrat(saetze, schonGestellt = []) {
  const raus = new Set(schonGestellt.map((t) => String(t).trim().toLowerCase()));
  const topf = [];
  for (const set of saetze) {
    for (const round of set.rounds || []) {
      for (const cat of round.categories) {
        for (const q of cat.questions) {
          if (q.image) continue;
          if (!q.text || !q.answer) continue;
          if (raus.has(q.text.trim().toLowerCase())) continue;
          topf.push({ text: q.text, answer: q.answer, note: q.note || null, category: cat.name });
        }
      }
    }
  }
  return topf;
}

/** Lädt alle Sätze und zieht eine Frage fürs Stechen. */
export async function stechenFrage(schonGestellt = []) {
  const saetze = [];
  for (const eintrag of (await listSets()).filter((s) => !s.error)) {
    try {
      saetze.push(await loadSet(eintrag.file));
    } catch {
      /* Ein kaputter Satz darf das Stechen nicht verhindern. */
    }
  }
  const topf = stechenVorrat(saetze, schonGestellt);
  if (!topf.length) return null;
  return topf[Math.floor(Math.random() * topf.length)];
}

export async function setExists(file) {
  try {
    await stat(path.join(DATA_DIR, path.basename(String(file || ''))));
    return true;
  } catch {
    return false;
  }
}

/**
 * Würfelt ein Board aus den Kategorien aller vorhandenen Sätze zusammen.
 * Damit ist kein Abend wie der andere, ohne dass jemand neue Fragen schreiben muss.
 * Kategorienamen werden entdoppelt – „Was ist die Frage?" gibt es in fast jedem Satz.
 */
export async function mixSet() {
  const dateien = (await listSets()).filter((s) => !s.error);
  // Nach Ursprungsrunde getrennt sammeln: Runde 2 zählt doppelt, dort gehören
  // die schwereren Kategorien hin. Ein gemeinsamer Topf würde „Flaggen für
  // Fortgeschrittene“ für halbe und die leichten „Flaggen“ für doppelte Punkte
  // spielen lassen.
  const toepfe = [new Map(), new Map()];
  for (const eintrag of dateien) {
    const set = await loadSet(eintrag.file);
    set.rounds.forEach((round, ri) => {
      const topf = toepfe[Math.min(ri, toepfe.length - 1)];
      for (const cat of round.categories) {
        if (!topf.has(cat.name)) topf.set(cat.name, []);
        // Woher die Kategorie stammt, wird mitgeführt: Der Mix zieht reihum
        // über die Sätze, und dafür muss er sie auseinanderhalten können.
        topf.get(cat.name).push({ cat, satz: eintrag.file });
      }
    });
  }

  const mischen = (liste) => {
    for (let i = liste.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [liste[i], liste[j]] = [liste[j], liste[i]];
    }
    return liste;
  };

  const gezogen = [];
  const vergeben = new Set();
  for (const topf of toepfe) {
    // Reihum über die Sätze statt blind aus einem Topf.
    //
    // Vorher wurden sechs Kategorien aus allen zusammengeworfenen gezogen. Bei
    // acht Sätzen kamen dabei typisch drei bis vier aus derselben Quelle, in
    // etwa jedem 150. Mix aber sechs von zwölf – dann heißt das Brett zwar
    // „Zufallsmix aus allen Sätzen", spielt sich aber wie ein Satz. Jetzt kommt
    // je Runde höchstens eine Kategorie pro Satz, solange genug Sätze da sind;
    // erst wenn die ausgehen, wird nachgelegt.
    // Jeder Kategoriename tritt genau einmal an, egal in wie vielen Sätzen es
    // ihn gibt. Vorher zog jedes Vorkommen mit: „Was ist die Frage?" steht in
    // acht der vierzehn Sätze und hatte damit achtmal so viele Lose wie eine
    // Kategorie, die es nur einmal gibt. Über 4000 gewürfelte Bretter gemessen
    // stand sie auf 45,4 Prozent aller Boards, die seltenste Kategorie auf
    // 6,4 – Faktor 7,1. Für ein Brett, dessen ganzer Zweck „kein Abend ist wie
    // der andere" ist, ist das zu schief. Mit einem Los je Name sind es 14,8
    // gegen 6,2 Prozent, Faktor 2,4; der Rest ist die unterschiedliche Größe
    // der Runden-Töpfe. Aus welchem Satz die Fragen kommen, wird ausgelost –
    // die Kategorie heißt gleich, die vier Fragen dahinter sind es nicht.
    const nachSatz = new Map();
    for (const [name, eintraege] of topf) {
      if (vergeben.has(name)) continue;
      const e = eintraege[Math.floor(Math.random() * eintraege.length)];
      if (!nachSatz.has(e.satz)) nachSatz.set(e.satz, []);
      nachSatz.get(e.satz).push({ name, cat: e.cat });
    }
    const reihen = mischen([...nachSatz.values()].map((l) => mischen(l)));

    const sechs = [];
    const genommen = new Set();
    // Mehrere Umläufe: Beim ersten bekommt jeder Satz eine Kategorie, beim
    // zweiten die nächste – so verteilt es sich auch, wenn es weniger als sechs
    // Sätze gibt.
    while (sechs.length < 6 && reihen.some((l) => l.length)) {
      for (const liste of reihen) {
        if (sechs.length >= 6) break;
        let k = liste.pop();
        // Denselben Kategorienamen nicht zweimal – auch nicht aus zwei Sätzen.
        while (k && (vergeben.has(k.name) || genommen.has(k.name))) k = liste.pop();
        if (!k) continue;
        genommen.add(k.name);
        sechs.push(k);
      }
    }
    for (const k of sechs) vergeben.add(k.name);
    gezogen.push(sechs.map((k) => k.cat));
  }

  if (gezogen.some((runde) => runde.length < 6)) {
    throw new Error(
      'Für einen Zufallsmix braucht es je Runde mindestens 6 verschiedene Kategorien. '
      + `Gefunden: ${gezogen.map((r) => r.length).join(' und ')}.`,
    );
  }
  const auswahl = gezogen.flat();

  return {
    name: 'Zufallsmix',
    description: `Zwölf Kategorien, gewürfelt aus ${dateien.length} Fragensätzen.`,
    rounds: [
      { categories: auswahl.slice(0, 6) },
      { categories: auswahl.slice(6, 12) },
    ],
  };
}
