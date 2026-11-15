/*
 * Baut public/Fragen-Vorlage.xlsx – die Tabelle, die ein Fragemeister ohne
 * Editor ausfüllen kann (Excel, Numbers, Google Tabellen, LibreOffice).
 *
 *   node werkzeug/fragen-vorlage.js
 *
 * Ohne Zusatzpakete: Eine .xlsx-Datei ist ein ZIP-Archiv mit ein paar
 * XML-Dateien, und beides lässt sich mit Node-Bordmitteln schreiben. Die
 * Tabelle liest public/tabelle.js wieder ein (Lobby „Datei laden …“, Editor
 * „Datei öffnen“).
 */
import { deflateRawSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZIEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'Fragen-Vorlage.xlsx');

/* ------------------------------------------------------------------ ZIP */

const CRC_TAFEL = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TAFEL[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(dateien) {
  const teile = [];
  const verzeichnis = [];
  let versatz = 0;
  for (const [name, inhalt] of dateien) {
    const roh = Buffer.from(inhalt, 'utf8');
    const gepackt = deflateRawSync(roh);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(roh);
    const kopf = Buffer.alloc(30);
    kopf.writeUInt32LE(0x04034b50, 0);
    kopf.writeUInt16LE(20, 4);
    kopf.writeUInt16LE(0x0800, 6); // UTF-8-Namen
    kopf.writeUInt16LE(8, 8); // deflate
    kopf.writeUInt32LE(0, 10); // Zeit/Datum
    kopf.writeUInt32LE(crc, 14);
    kopf.writeUInt32LE(gepackt.length, 18);
    kopf.writeUInt32LE(roh.length, 22);
    kopf.writeUInt16LE(nameBuf.length, 26);
    kopf.writeUInt16LE(0, 28);
    teile.push(kopf, nameBuf, gepackt);
    const zentral = Buffer.alloc(46);
    zentral.writeUInt32LE(0x02014b50, 0);
    zentral.writeUInt16LE(20, 4);
    zentral.writeUInt16LE(20, 6);
    zentral.writeUInt16LE(0x0800, 8);
    zentral.writeUInt16LE(8, 10);
    zentral.writeUInt32LE(0, 12);
    zentral.writeUInt32LE(crc, 16);
    zentral.writeUInt32LE(gepackt.length, 20);
    zentral.writeUInt32LE(roh.length, 24);
    zentral.writeUInt16LE(nameBuf.length, 28);
    zentral.writeUInt32LE(versatz, 42);
    verzeichnis.push(zentral, nameBuf);
    versatz += kopf.length + nameBuf.length + gepackt.length;
  }
  const zentralBuf = Buffer.concat(verzeichnis);
  const ende = Buffer.alloc(22);
  ende.writeUInt32LE(0x06054b50, 0);
  ende.writeUInt16LE(dateien.length, 8);
  ende.writeUInt16LE(dateien.length, 10);
  ende.writeUInt32LE(zentralBuf.length, 12);
  ende.writeUInt32LE(versatz, 16);
  return Buffer.concat([...teile, zentralBuf, ende]);
}

/* ---------------------------------------------------------------- Tabelle */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SPALTEN = 'ABCDEF';

/* Stile (Index in cellXfs):
   0 normal · 1 Titel · 2 Eingabe für den Namen · 3 Anleitung · 4 Kopfzeile
   5/6 Textzelle Block A/B · 7/8 Zahl Block A/B · 9/10 Kategoriezelle Block A/B */
const STILE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="5">
<font><sz val="12"/><name val="Arial"/></font>
<font><b/><sz val="16"/><color rgb="FF0B1F3A"/><name val="Arial"/></font>
<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
<font><i/><sz val="11"/><color rgb="FF4A5568"/><name val="Arial"/></font>
<font><b/><sz val="12"/><name val="Arial"/></font>
</fonts>
<fills count="7">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1C4F8F"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEAF2FD"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF6D6"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDE3E8"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFC9D6E8"/></left><right style="thin"><color rgb="FFC9D6E8"/></right><top style="thin"><color rgb="FFC9D6E8"/></top><bottom style="thin"><color rgb="FFC9D6E8"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="4" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="4" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function zelle(spalte, zeile, wert, stil) {
  const ref = `${spalte}${zeile}`;
  if (wert === '' || wert == null) return `<c r="${ref}" s="${stil}"/>`;
  if (typeof wert === 'number') return `<c r="${ref}" s="${stil}"><v>${wert}</v></c>`;
  return `<c r="${ref}" s="${stil}" t="inlineStr"><is><t xml:space="preserve">${esc(wert)}</t></is></c>`;
}

function blatt() {
  const zeilen = [];
  zeilen.push(`<row r="1" ht="26" customHeight="1">${zelle('A', 1, 'Quizduell – Fragen-Vorlage', 1)}</row>`);
  zeilen.push(`<row r="2" ht="24" customHeight="1">${zelle('A', 2, 'Name:', 2)}${zelle('B', 2, '', 2)}${zelle('C', 2, '', 2)}${zelle('D', 2, '', 2)}</row>`);
  zeilen.push(`<row r="3" ht="64" customHeight="1">${zelle('A', 3,
    'So geht’s: Oben den Namen des Fragensatzes eintragen. In jedes rosa Feld den Namen einer Kategorie, '
    + 'dann in jede Zeile eine Frage und ihre Antwort – von leicht (oben) nach schwer (unten). '
    + '„Zusatz“ ist freiwillig: ein Satz, der nach der Auflösung auf dem Bildschirm steht. '
    + 'Runde 2 zählt im Spiel doppelt. Fertig? Datei speichern und dem Gastgeber schicken – '
    + 'er wählt sie in der Lobby über „Datei laden …“.', 3)}</row>`);
  const KOPF = ['Runde', 'Kategorie', 'Punkte', 'Frage', 'Antwort', 'Zusatz (freiwillig)'];
  zeilen.push(`<row r="5" ht="22" customHeight="1">${KOPF.map((k, i) => zelle(SPALTEN[i], 5, k, 4)).join('')}</row>`);
  let r = 6;
  for (const runde of [1, 2]) {
    for (let kat = 0; kat < 6; kat++) {
      const a = kat % 2 === 0;
      for (const [i, punkte] of [100, 200, 300, 500].entries()) {
        const text = a ? 5 : 6;
        const zahl = a ? 7 : 8;
        const kategorie = i === 0 ? (a ? 9 : 10) : text;
        zeilen.push(`<row r="${r}" ht="34" customHeight="1">${[
          zelle('A', r, runde, zahl),
          zelle('B', r, '', kategorie),
          zelle('C', r, punkte * runde, zahl),
          zelle('D', r, '', text),
          zelle('E', r, '', text),
          zelle('F', r, '', text),
        ].join('')}</row>`);
        r += 1;
      }
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0" zoomScale="110"><pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
<cols>
<col min="1" max="1" width="9" customWidth="1"/>
<col min="2" max="2" width="24" customWidth="1"/>
<col min="3" max="3" width="9" customWidth="1"/>
<col min="4" max="4" width="54" customWidth="1"/>
<col min="5" max="5" width="30" customWidth="1"/>
<col min="6" max="6" width="44" customWidth="1"/>
</cols>
<sheetData>${zeilen.join('')}</sheetData>
<mergeCells count="2"><mergeCell ref="A3:F3"/><mergeCell ref="B2:D2"/></mergeCells>
</worksheet>`;
}

const DATEIEN = [
  ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`],
  ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
  ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Fragen" sheetId="1" r:id="rId1"/></sheets>
</workbook>`],
  ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
  ['xl/styles.xml', STILE],
  ['xl/worksheets/sheet1.xml', blatt()],
];

export function baueVorlage() {
  return zip(DATEIEN);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  writeFileSync(ZIEL, baueVorlage());
  console.log(`Geschrieben: ${ZIEL}`);
}
