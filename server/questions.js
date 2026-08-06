import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');

/**
 * Validiert und normalisiert einen Fragensatz.
 * Erwartet: { name, rounds: [ { categories: [ { name, questions: [ {text, answer, image?, note?} ] } ] } ] }
 */
export function normalizeSet(raw, fallbackName = 'Fragensatz') {
  if (!raw || typeof raw !== 'object') throw new Error('Fragensatz ist kein Objekt.');
  const rounds = Array.isArray(raw.rounds) ? raw.rounds : null;
  if (!rounds || rounds.length === 0) throw new Error('Fragensatz enthält keine Runden.');

  const normRounds = rounds.map((round, ri) => {
    const cats = Array.isArray(round.categories) ? round.categories : [];
    if (cats.length === 0) throw new Error(`Runde ${ri + 1} hat keine Kategorien.`);
    if (cats.length > 8) throw new Error(`Runde ${ri + 1} hat mehr als 8 Kategorien.`);
    return {
      categories: cats.map((cat, ci) => {
        const qs = Array.isArray(cat.questions) ? cat.questions : [];
        if (qs.length === 0) {
          throw new Error(`Kategorie "${cat.name || ci + 1}" in Runde ${ri + 1} hat keine Fragen.`);
        }
        return {
          name: String(cat.name || `Kategorie ${ci + 1}`).slice(0, 40),
          questions: qs.slice(0, 4).map((q) => ({
            text: String(q.text || '').slice(0, 400),
            answer: String(q.answer || '').slice(0, 400),
            image: q.image ? String(q.image) : null,
            note: q.note ? String(q.note).slice(0, 400) : null,
          })),
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

export async function listSets() {
  let files = [];
  try {
    files = await readdir(DATA_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(await readFile(path.join(DATA_DIR, file), 'utf8'));
      const set = normalizeSet(raw, file.replace(/\.json$/, ''));
      out.push({
        file,
        name: set.name,
        description: set.description,
        rounds: set.rounds.length,
        questions: set.rounds.reduce(
          (sum, r) => sum + r.categories.reduce((s, c) => s + c.questions.length, 0),
          0,
        ),
      });
    } catch (err) {
      out.push({ file, name: file, error: err.message });
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
