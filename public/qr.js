// Minimaler QR-Encoder – nur so viel, wie zum Anzeigen einer WLAN-Adresse nötig ist:
// Byte-Modus, Versionen 1–10, Fehlerkorrektur L oder M. Bewusst ohne Abhängigkeit,
// damit die App weiter komplett offline läuft.
//
// Die Ausgabe ist bitgenau gegen eine etablierte Referenz-Implementierung getestet
// (siehe test/qr.test.js).

/* --------------------------------------------------------- Galois-Feld 256 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // Primitivpolynom aus der QR-Norm
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Generatorpolynom für n Fehlerkorrektur-Codewörter. */
function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** Reed-Solomon-Rest = die Fehlerkorrektur-Codewörter eines Blocks. */
function rsRemainder(data, n) {
  const g = rsGenerator(n);
  const buf = new Uint8Array(data.length + n);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (!factor) continue;
    for (let j = 0; j < g.length; j++) buf[i + j] ^= mul(g[j], factor);
  }
  return buf.subarray(data.length);
}

/* ------------------------------------------------------------- Kapazitäten */

// Gesamtzahl Codewörter je Version (1–10).
const TOTAL = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

// Je Version: [EC-Codewörter pro Block, Blöcke Gruppe 1, Daten je Block G1,
//              Blöcke Gruppe 2, Daten je Block G2]
const BLOCKS = {
  L: [
    [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
};

// Mittelpunkte der Ausrichtungsmuster je Version.
const ALIGN = [
  [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const ECL_BITS = { L: 0b01, M: 0b00 };

function dataCodewords(version, ecl) {
  const [, n1, d1, n2, d2] = BLOCKS[ecl][version - 1];
  return n1 * d1 + n2 * d2;
}

/* ------------------------------------------------------------- Bitfolge */

function buildData(text, version, ecl) {
  const bytes = new TextEncoder().encode(text);
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // Byte-Modus
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacity = dataCodewords(version, ecl) * 8;
  push(0, Math.min(4, capacity - bits.length)); // Abschlusszeichen
  while (bits.length % 8) bits.push(0);

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  // Auffüllen mit den in der Norm festgelegten Füllbytes.
  const pad = [0xec, 0x11];
  for (let i = 0; out.length < dataCodewords(version, ecl); i++) out.push(pad[i % 2]);
  return out;
}

/** Datenblöcke und EC-Blöcke verschachteln, wie die Norm es vorschreibt. */
function interleave(data, version, ecl) {
  const [ecLen, n1, d1, n2, d2] = BLOCKS[ecl][version - 1];
  const blocks = [];
  let pos = 0;
  for (let i = 0; i < n1; i++) { blocks.push(data.slice(pos, pos + d1)); pos += d1; }
  for (let i = 0; i < n2; i++) { blocks.push(data.slice(pos, pos + d2)); pos += d2; }
  const ec = blocks.map((b) => rsRemainder(Uint8Array.from(b), ecLen));

  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of ec) out.push(b[i]);
  }
  return out;
}

/* ---------------------------------------------------------------- Matrix */

const BCH_FORMAT = 0x537;
const BCH_VERSION = 0x1f25;

function bch(value, generator, bits) {
  let rest = value << bits;
  const top = 1 << (bits + Math.floor(Math.log2(generator)));
  void top;
  const genBits = Math.floor(Math.log2(generator)) + 1;
  for (let i = 31; i >= genBits - 1; i--) {
    if (rest & (1 << i)) rest ^= generator << (i - genBits + 1);
  }
  return rest;
}

function formatBits(ecl, mask) {
  const value = (ECL_BITS[ecl] << 3) | mask;
  return ((value << 10) | bch(value, BCH_FORMAT, 10)) ^ 0x5412;
}

function versionBits(version) {
  return (version << 12) | bch(version, BCH_VERSION, 12);
}

function emptyMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFunctionPatterns(m, version) {
  const size = m.length;
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inner = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        m[y][x] = inner !== 2 && inner <= 3;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Taktmuster
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0;
    m[i][6] = i % 2 === 0;
  }

  // Ausrichtungsmuster. Ausgelassen werden ausschließlich die drei Ecken, in
  // denen ein Suchmuster sitzt – auf der Taktlinie gehören sie dagegen hin.
  const centers = ALIGN[version - 1];
  const first = centers[0];
  const last = centers[centers.length - 1];
  for (const r of centers) {
    for (const c of centers) {
      const beiSuchmuster =
        (r === first && c === first) || (r === first && c === last) || (r === last && c === first);
      if (beiSuchmuster) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        }
      }
    }
  }

  // Plätze für Format- und Versionsinformation freihalten
  for (let i = 0; i <= 8; i++) {
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
  }
  m[size - 8][8] = true; // dunkles Modul

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      if (m[b][a] === null) m[b][a] = false;
      if (m[a][b] === null) m[a][b] = false;
    }
  }
}

function placeData(m, codewords) {
  const size = m.length;
  let bit = 0;
  const total = codewords.length * 8;
  const nextBit = () => {
    if (bit >= total) return false;
    const value = (codewords[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit++;
    return value === 1;
  };

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // Taktspalte überspringen
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (m[y][x] === null) m[y][x] = nextBit();
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Straftpunkte nach den vier Regeln der Norm – der kleinste Wert gewinnt. */
function penalty(m) {
  const size = m.length;
  let score = 0;

  const runs = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          run = 1;
        }
      }
    }
  };
  runs((a, b) => m[a][b]);
  runs((a, b) => m[b][a]);

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  const PATTERN = [true, false, true, true, true, false, true, false, false, false, false];
  const hasPattern = (get, a, b) => {
    for (let i = 0; i < 11; i++) if (get(a, b + i) !== PATTERN[i]) return false;
    return true;
  };
  const rev = [...PATTERN].reverse();
  const hasRev = (get, a, b) => {
    for (let i = 0; i < 11; i++) if (get(a, b + i) !== rev[i]) return false;
    return true;
  };
  for (let a = 0; a < size; a++) {
    for (let b = 0; b + 11 <= size; b++) {
      if (hasPattern((y, x) => m[y][x], a, b) || hasRev((y, x) => m[y][x], a, b)) score += 40;
      if (hasPattern((y, x) => m[x][y], a, b) || hasRev((y, x) => m[x][y], a, b)) score += 40;
    }
  }

  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

function applyFormat(m, ecl, mask) {
  const size = m.length;
  const bits = formatBits(ecl, mask);
  // Die Norm zählt die 15 Bits von links, also vom höchstwertigen aus.
  const get = (i) => ((bits >> (14 - i)) & 1) === 1;

  // Erste Kopie rund um das Suchmuster oben links
  for (let i = 0; i <= 5; i++) m[8][i] = get(i);
  m[8][7] = get(6);
  m[8][8] = get(7);
  m[7][8] = get(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = get(i);

  // Zweite Kopie: sieben Bits unten links, acht Bits oben rechts
  for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = get(i);
  for (let i = 7; i <= 14; i++) m[8][size - 15 + i] = get(i);

  m[size - 8][8] = true;
}

function applyVersion(m, version) {
  if (version < 7) return;
  const size = m.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const on = ((bits >> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + size - 11;
    m[b][a] = on;
    m[a][b] = on;
  }
}

/**
 * Erzeugt die QR-Matrix als Array von Boolean-Zeilen (true = dunkel).
 * Wirft, wenn der Text für Version 10 zu lang ist.
 */
export function qrMatrix(text, ecl = 'M', forceMask = null) {
  const bytes = new TextEncoder().encode(text).length;
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const bits = 4 + (v < 10 ? 8 : 16) + bytes * 8;
    if (bits <= dataCodewords(v, ecl) * 8) { version = v; break; }
  }
  if (!version) throw new Error('Text zu lang für einen QR-Code dieser Größe.');

  const codewords = interleave(buildData(text, version, ecl), version, ecl);
  const size = version * 4 + 17;

  const base = emptyMatrix(size);
  placeFunctionPatterns(base, version);
  const reserved = base.map((row) => row.map((v) => v !== null));
  placeData(base, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== null && mask !== forceMask) continue;
    const m = base.map((row) => [...row]);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && MASKS[mask](r, c)) m[r][c] = !m[r][c];
      }
    }
    applyFormat(m, ecl, mask);
    applyVersion(m, version);
    const score = penalty(m);
    if (!best || score < best.score) best = { score, m };
  }
  return best.m;
}

/** Fertiges SVG mit Rand, skaliert sich auf die Größe des Containers. */
export function qrSvg(text, { ecl = 'M', quiet = 2, dark = '#05070c', light = '#ffffff' } = {}) {
  const m = qrMatrix(text, ecl);
  const size = m.length + quiet * 2;
  let path = '';
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) {
      if (m[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR-Code zum Mitspielen">`
    + `<rect width="${size}" height="${size}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/></svg>`;
}
