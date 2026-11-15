/*
 * Fragensätze aus einer Tabelle – für alle, die mit einer .json-Datei nichts
 * anfangen können.
 *
 * Die Vorlage (public/Fragen-Vorlage.xlsx, gebaut von
 * werkzeug/fragen-vorlage.js) hat eine Zeile je Frage:
 *
 *   Runde | Kategorie | Punkte | Frage | Antwort | Zusatz (freiwillig)
 *
 * Gelesen wird nicht starr nach Spaltennummer, sondern nach der Kopfzeile –
 * wer Spalten verschiebt oder eine eigene Tabelle mit diesen Überschriften
 * baut, kommt genauso durch. Der Kategoriename muss nur in der ersten Zeile
 * eines Blocks stehen; darunter gilt er weiter, ebenso die Runde. Der Name
 * des Satzes steht in einer Zeile, die mit „Name“ beginnt.
 *
 * Gelesen werden .xlsx (Excel, Numbers, Google Tabellen, LibreOffice), .csv
 * (Komma oder Semikolon) und natürlich weiterhin .json. Ohne Zusatzpakete:
 * Eine .xlsx-Datei ist ein ZIP-Archiv mit XML darin; entpackt wird mit der
 * DecompressionStream des Browsers (Safari ab 16.4).
 */

/* ------------------------------------------------------------- Einstieg */

/** Liest eine gewählte Datei und gibt einen (noch ungeprüften) Fragensatz zurück. */
export async function satzAusDatei(datei) {
  const name = String(datei?.name || '');
  const endung = name.toLowerCase().split('.').pop();
  if (endung === 'xlsx') return satzAusZeilen(await zeilenAusXlsx(await datei.arrayBuffer()), name);
  if (endung === 'csv' || endung === 'tsv' || endung === 'txt') return satzAusZeilen(zeilenAusCsv(await datei.text()), name);
  if (endung === 'xls' || endung === 'numbers' || endung === 'ods') {
    throw new Error('Bitte die Tabelle als .xlsx (Excel) oder .csv speichern – dieses Format kann das Spiel nicht lesen.');
  }
  let roh;
  try {
    roh = JSON.parse(await datei.text());
  } catch {
    throw new Error('Das ist weder ein Fragensatz (.json) noch eine Tabelle (.xlsx/.csv).');
  }
  if (!Array.isArray(roh?.rounds)) throw new Error('Das ist kein Fragensatz.');
  return roh;
}

/**
 * Was dem Satz noch fehlt – als Satz für den Gastgeber, oder null. Dieselben
 * Regeln wie auf dem Server (questions.js normalizeSet), damit der Fehler
 * schon beim Laden auffällt und nicht erst beim Spielstart.
 */
export function satzLuecke(satz) {
  for (const [ri, runde] of (satz?.rounds || []).entries()) {
    const kats = runde.categories || [];
    if (!kats.length) return `Runde ${ri + 1} hat keine Kategorien.`;
    if (kats.length > 8) return `Runde ${ri + 1} hat ${kats.length} Kategorien – höchstens 8 passen aufs Brett.`;
    for (const kat of kats) {
      const n = (kat.questions || []).length;
      if (n !== 4) {
        return `Kategorie „${kat.name}“ in Runde ${ri + 1} hat ${n === 1 ? 'eine Frage' : `${n} Fragen`} – es müssen genau 4 sein.`
          + ' Steht in jedem Viererblock ein Kategoriename?';
      }
      for (const [qi, q] of kat.questions.entries()) {
        if (!String(q.text || '').trim()) return `In „${kat.name}“ (Runde ${ri + 1}) fehlt bei Frage ${qi + 1} der Fragetext.`;
        if (!String(q.answer || '').trim()) return `In „${kat.name}“ (Runde ${ri + 1}) fehlt bei Frage ${qi + 1} die Antwort.`;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------- Zeilen → Satz */

const SPALTEN = {
  runde: /^runde/,
  kategorie: /^kategorie/,
  punkte: /^(punkte|wert|punktzahl)/,
  frage: /^frage/,
  antwort: /^(antwort|lösung|loesung)/,
  zusatz: /^(zusatz|hinweis|notiz|info|erklärung|erklaerung)/,
};

const sauber = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Aus Tabellenzeilen (Array von Arrays) einen Fragensatz bauen. */
export function satzAusZeilen(zeilen, dateiname = '') {
  let name = '';
  let kopfZeile = -1;
  let spalten = null;
  for (let i = 0; i < zeilen.length; i++) {
    const zellen = zeilen[i].map((z) => sauber(z).toLowerCase());
    if (!name && /^name/.test(zellen[0] || '')) {
      name = sauber(zeilen[i].slice(1).find((z) => sauber(z)) || '');
    }
    const finde = (muster) => zellen.findIndex((z) => muster.test(z));
    if (finde(SPALTEN.frage) >= 0 && finde(SPALTEN.antwort) >= 0) {
      kopfZeile = i;
      spalten = Object.fromEntries(Object.entries(SPALTEN).map(([k, m]) => [k, finde(m)]));
      break;
    }
  }
  if (!spalten) {
    throw new Error('In der Tabelle fehlt die Kopfzeile mit „Frage“ und „Antwort“ – am besten die Vorlage benutzen.');
  }

  const runden = new Map(); // nr -> Map(kategorie -> [{punkte, frage}])
  let runde = 1;
  let kategorie = '';
  let blockNr = 0;
  for (const zeile of zeilen.slice(kopfZeile + 1)) {
    const wert = (k) => (spalten[k] >= 0 ? sauber(zeile[spalten[k]]) : '');
    const text = wert('frage');
    const answer = wert('antwort');
    const neueKategorie = wert('kategorie');
    const neueRunde = Number.parseInt(wert('runde'), 10);
    if (Number.isFinite(neueRunde) && neueRunde > 0 && neueRunde !== runde) {
      runde = neueRunde;
      kategorie = '';
    }
    if (neueKategorie) kategorie = neueKategorie;
    if (!text && !answer) continue;
    // Ohne Namen trägt die Kategorie eine Nummer – lieber „Kategorie 3“ als
    // vier Fragen, die in der Kategorie davor landen.
    if (!kategorie) kategorie = `Kategorie ${++blockNr}`;
    if (!runden.has(runde)) runden.set(runde, new Map());
    const kats = runden.get(runde);
    if (!kats.has(kategorie)) kats.set(kategorie, []);
    kats.get(kategorie).push({
      punkte: Number.parseInt(wert('punkte'), 10),
      frage: { text, answer, image: null, note: wert('zusatz') || null },
    });
  }
  if (!runden.size) throw new Error('In der Tabelle steht noch keine einzige Frage.');

  const rounds = [...runden.entries()].sort((a, b) => a[0] - b[0]).map(([, kats]) => ({
    categories: [...kats.entries()].map(([katName, fragen]) => {
      // Nach Punkten sortieren, wenn alle eine Zahl tragen – wer die Zeilen
      // durcheinander ausgefüllt hat, bekommt trotzdem leicht vor schwer.
      const sortierbar = fragen.every((f) => Number.isFinite(f.punkte));
      const geordnet = sortierbar ? [...fragen].sort((a, b) => a.punkte - b.punkte) : fragen;
      return { name: katName, questions: geordnet.map((f) => f.frage) };
    }),
  }));
  const ausDatei = String(dateiname).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return { name: name || ausDatei || 'Fragen aus der Tabelle', description: '', rounds };
}

/* ------------------------------------------------------------------ CSV */

/** CSV mit Komma, Semikolon oder Tab; Anführungszeichen wie Excel sie schreibt. */
export function zeilenAusCsv(text) {
  const roh = String(text).replace(/^﻿/, '');
  const ersteZeile = roh.split(/\r?\n/, 1)[0] || '';
  const zaehle = (z) => (ersteZeile.match(new RegExp(`\\${z}`, 'g')) || []).length;
  // Die erste Zeile allein reicht nicht immer (Titelzeile ohne Trenner) –
  // also über den ganzen Text zählen, Semikolon gewinnt bei Gleichstand
  // (deutsches Excel).
  const alle = (z) => (roh.match(new RegExp(`\\${z}`, 'g')) || []).length;
  const trenner = ['\t', ';', ','].sort((a, b) => (alle(b) + zaehle(b)) - (alle(a) + zaehle(a)))[0];
  const zeilen = [];
  let zeile = [];
  let feld = '';
  let inZitat = false;
  for (let i = 0; i < roh.length; i++) {
    const c = roh[i];
    if (inZitat) {
      if (c === '"' && roh[i + 1] === '"') { feld += '"'; i++; } else if (c === '"') inZitat = false;
      else feld += c;
    } else if (c === '"') inZitat = true;
    else if (c === trenner) { zeile.push(feld); feld = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && roh[i + 1] === '\n') i++;
      zeile.push(feld);
      zeilen.push(zeile);
      zeile = [];
      feld = '';
    } else feld += c;
  }
  if (feld || zeile.length) { zeile.push(feld); zeilen.push(zeile); }
  return zeilen;
}

/* ----------------------------------------------------------------- XLSX */

const lies16 = (b, o) => b[o] | (b[o + 1] << 8);
const lies32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function entpacke(daten, methode) {
  if (methode === 0) return daten;
  if (methode !== 8) throw new Error('Diese Excel-Datei ist ungewöhnlich gepackt – bitte als .csv speichern.');
  if (typeof DecompressionStream !== 'function') {
    throw new Error('Dieser Browser kann .xlsx nicht entpacken – bitte die Tabelle als .csv speichern oder Safari/Chrome aktualisieren.');
  }
  const strom = new Blob([daten]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(strom).arrayBuffer());
}

/** Liest die Dateien eines ZIP-Archivs, deren Name `will` erfüllt. */
async function zipDateien(puffer, will) {
  const b = new Uint8Array(puffer);
  let ende = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (lies32(b, i) === 0x06054b50) { ende = i; break; }
  }
  if (ende < 0) throw new Error('Das ist keine gültige .xlsx-Datei.');
  const anzahl = lies16(b, ende + 10);
  let p = lies32(b, ende + 16);
  const text = new TextDecoder();
  const out = new Map();
  for (let n = 0; n < anzahl; n++) {
    if (lies32(b, p) !== 0x02014b50) break;
    const methode = lies16(b, p + 10);
    const groesse = lies32(b, p + 20);
    const nameLaenge = lies16(b, p + 28);
    const extraLaenge = lies16(b, p + 30);
    const kommentar = lies16(b, p + 32);
    const versatz = lies32(b, p + 42);
    const name = text.decode(b.subarray(p + 46, p + 46 + nameLaenge));
    p += 46 + nameLaenge + extraLaenge + kommentar;
    if (!will(name)) continue;
    const start = versatz + 30 + lies16(b, versatz + 26) + lies16(b, versatz + 28);
    out.set(name, text.decode(await entpacke(b.subarray(start, start + groesse), methode)));
  }
  return out;
}

const ENTITAETEN = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const dekodiere = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITAETEN[e] ?? m;
});
/** Der Text eines <si>- oder <is>-Elements, auch wenn er in Formatierungsläufe zerfällt. */
const textAus = (xml) => dekodiere([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

function spalteNr(ref) {
  let n = 0;
  for (const c of ref.replace(/\d+$/, '')) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** Die Zeilen des ersten Tabellenblatts als Array von Arrays aus Text. */
export async function zeilenAusXlsx(puffer) {
  const dateien = await zipDateien(puffer, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml'
    || n === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  // Das erste Blatt laut Arbeitsmappe – nicht einfach sheet1.xml: Wer Blätter
  // umsortiert, hat das erste womöglich unter anderem Namen.
  let blattPfad = null;
  const mappe = dateien.get('xl/workbook.xml') || '';
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(mappe)?.[1];
  const rels = dateien.get('xl/_rels/workbook.xml.rels') || '';
  if (rid) {
    const ziel = new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1]
      || new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${rid}"`).exec(rels)?.[1];
    if (ziel) blattPfad = ziel.startsWith('/') ? ziel.slice(1) : `xl/${ziel.replace(/^\.\//, '')}`;
  }
  const blatt = dateien.get(blattPfad) || dateien.get('xl/worksheets/sheet1.xml')
    || [...dateien.entries()].find(([n]) => n.startsWith('xl/worksheets/'))?.[1];
  if (!blatt) throw new Error('In der Excel-Datei ist kein Tabellenblatt.');
  const geteilt = [...(dateien.get('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textAus(m[1]));

  const zeilen = [];
  for (const [, zeileXml] of blatt.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const zeile = [];
    for (const m of zeileXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = m[1];
      const inhalt = m[2] || '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attr)?.[1];
      const typ = /\bt="([^"]+)"/.exec(attr)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inhalt)?.[1];
      let wert = '';
      if (typ === 's') wert = geteilt[Number(v)] ?? '';
      else if (typ === 'inlineStr') wert = textAus(inhalt);
      else if (v != null) wert = dekodiere(v);
      const nr = ref ? spalteNr(ref) : zeile.length;
      zeile[nr] = wert;
    }
    zeilen.push(Array.from(zeile, (z) => z ?? ''));
  }
  return zeilen;
}
