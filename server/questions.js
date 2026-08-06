import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
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
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const full = path.join(DATA_DIR, file);
    try {
      const info = await stat(full);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
        out.push(hit.info);
        continue;
      }
      const set = normalizeSet(JSON.parse(await readFile(full, 'utf8')), file.replace(/\.json$/, ''));
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

export async function loadSet(file) {
  const safe = path.basename(String(file || ''));
  if (!safe.endsWith('.json')) throw new Error('Ungültige Datei.');
  const raw = JSON.parse(await readFile(path.join(DATA_DIR, safe), 'utf8'));
  return normalizeSet(raw, safe.replace(/\.json$/, ''));
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
  let n = 0;
  for (const round of set.rounds) {
    for (const cat of round.categories) {
      for (const q of cat.questions) {
        if (!q.image || !q.image.startsWith('data:')) continue;
        const match = /^data:([^;,]+);base64,(.*)$/s.exec(q.image);
        if (!match) continue;
        const id = `b${++n}`;
        images.set(id, { type: match[1], buffer: Buffer.from(match[2], 'base64') });
        q.image = `/api/bild/${id}`;
      }
    }
  }
  return { set, images };
}

export async function setExists(file) {
  try {
    await stat(path.join(DATA_DIR, path.basename(String(file || ''))));
    return true;
  } catch {
    return false;
  }
}
