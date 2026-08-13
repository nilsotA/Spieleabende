import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { rm, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Integrationstests gegen den laufenden Server: Sie decken ab, was reine
// Logiktests nicht können – Verbindungen, Rollen, Abstürze und Neustarts.

const SERVER = fileURLToPath(new URL('../server/index.js', import.meta.url));
// Fragensätze liegen hier – Tests, die welche anlegen, räumen sie wieder weg.
const DATEN_URL = new URL('../data/', import.meta.url);
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Startet einen Server auf eigenem Port mit eigenem Spielstand-Pfad.
 *
 * Die Tests würfeln ihre Ports, und irgendwann treffen sich zwei. Vorher lief
 * das in die Zeitschranke und meldete „Server startet nicht" – eine Meldung,
 * die nach einem kaputten Server aussieht und in Wahrheit nur ein belegter Port
 * war. Solche Fehlschläge verdecken echte. Jetzt wird der Grund erkannt und mit
 * einem anderen Port weitergemacht.
 */
/**
 * Ports, die `fetch()` gar nicht erst anfasst.
 *
 * Die Fetch-Norm führt eine Liste gesperrter Ports (früher für die Abwehr von
 * Protokollschmuggel gedacht), und Node setzt sie in `fetch` um. Würfelt ein
 * Test so einen Port, startet der Server ganz normal und lauscht auch – aber
 * jeder Abruf wirft „bad port". Die Schleife unten lief dann ihre vollen fünf
 * Sekunden ab und meldete „Server startet nicht", also einen kaputten Server,
 * wo nur die Zahl nicht erlaubt war. Gemessen traf es zwei von sechs Läufen,
 * unter anderem 6697, 6667, 6000 und 5061.
 */
const GESPERRTE_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 4237, 4269, 4343,
  5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

async function starteServer(port, stateFile, versuche = 5, extraEnv = {}) {
  for (let versuch = 0; versuch < versuche; versuch++) {
    const dieserPort = port + versuch * 37;
    if (GESPERRTE_PORTS.has(dieserPort)) continue;
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(dieserPort), QUIZDUELL_STATE_FILE: stateFile, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let belegt = false;
    let beendet = false;
    let ausgabe = '';
    proc.on('exit', () => { beendet = true; });
    proc.stdout.on('data', (d) => { ausgabe += String(d); });
    const lauscher = (d) => { if (/EADDRINUSE/.test(String(d))) belegt = true; };
    proc.stderr.on('data', lauscher);
    const base = `http://127.0.0.1:${dieserPort}`;
    let oben = false;
    let schlechterPort = false;
    for (let i = 0; i < 100 && !belegt && !beendet; i++) {
      try {
        const res = await fetch(`${base}/api/info`);
        // 403 heißt: Der Server steht und hat die Tür zu – auch das ist „oben".
        if (res.ok || res.status === 403) { oben = true; break; }
      } catch (err) {
        // Den Grund nicht wegwerfen: Steckt „bad port" darin, ist der Server
        // längst oben und nur die Portnummer nicht erlaubt. Dann sofort
        // weiterziehen, statt fünf Sekunden auf etwas zu warten, das nie kommt.
        if (/bad port/i.test(String(err?.cause?.message || err?.message || ''))) {
          schlechterPort = true;
          break;
        }
      }
      await warte(50);
    }
    if (schlechterPort) {
      proc.kill('SIGKILL');
      continue;
    }
    if (oben) {
      proc.stderr.off('data', lauscher);
      return { proc, base, ausgabe: () => ausgabe };
    }
    proc.kill('SIGKILL');
    if (!belegt) throw new Error(`Server startet nicht (Port ${dieserPort})`);
  }
  throw new Error(`kein freier Port ab ${port} gefunden`);
}

/** Öffnet eine Host-Verbindung und liefert eine Funktion zum Absenden von Aktionen. */
/**
 * Öffnet einen Ereignisstrom und fischt den Nachweis für diese Gerätekennung
 * aus dem `hello` – genau das tut die Oberfläche auch. Ohne ihn lehnt der
 * Server jeden Zug ab, sobald die Kennung schon einmal einen Strom offen hatte.
 */
async function verbinde(base, id, rolle = 'host') {
  const res = await fetch(`${base}/api/events?clientId=${id}&role=${rolle}`);
  const reader = res.body.getReader();
  let geheim = null;
  let buf = '';
  for (let i = 0; i < 40 && !geheim; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const treffer = /event: hello\ndata: (.*)\n\n/.exec(buf);
    if (treffer) geheim = JSON.parse(treffer[1]).geheim || null;
  }
  reader.read(); // weiterlesen, damit die Verbindung offen bleibt
  const tu = (body) => fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: id, geheim, ...body }),
  }).then((r) => r.json());
  return { res, reader, geheim, tu };
}

async function alsHost(base, id) {
  const { tu } = await verbinde(base, id, 'host');
  await warte(200);
  return tu;
}

/** Liest den ersten State-Schnappschuss aus dem Ereignisstrom. */
async function zustand(base, alsHostRolle = true) {
  const res = await fetch(`${base}/api/events?clientId=peek_${Math.random()}&role=${alsHostRolle ? 'host' : 'player'}`);
  const reader = res.body.getReader();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const treffer = buf.match(/event: state\ndata: (.*)\n\n/);
    if (treffer) {
      reader.cancel();
      return JSON.parse(treffer[1]);
    }
  }
  throw new Error('kein Zustand empfangen');
}

const EIN_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SATZ = {
  name: 'Testsatz',
  rounds: [{
    categories: Array.from({ length: 2 }, (_, c) => ({
      name: `K${c}`,
      questions: Array.from({ length: 4 }, (_, i) => ({
        text: `Frage ${c}-${i}`,
        answer: `Antwort ${c}-${i}`,
        image: c === 0 && i === 0 ? EIN_PIXEL : null,
      })),
    })),
  }],
};

test('Server übersteht Absturz und Neustart mit vollem Spielstand', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const stateFile = path.join(dir, 'stand.json');
  const port = 3400 + Math.floor(Math.random() * 200);

  let { proc, base } = await starteServer(port, stateFile);
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'test-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', set: SATZ });
  await host({ type: 'pick', catIdx: 0, rowIdx: 3 });
  await host({ type: 'judge', correct: true });
  await host({ type: 'close' });
  await host({ type: 'pick', catIdx: 1, rowIdx: 0 }); // Frage offen stehen lassen
  await warte(700); // Sicherung ist entprellt

  const vorher = await zustand(base);
  assert.equal(vorher.teams[0].score, 500);

  // Wie ein zugeklapptes Notebook: kein sauberes Herunterfahren.
  proc.kill('SIGKILL');
  await warte(400);
  ({ proc, base } = await starteServer(port, stateFile));

  const nachher = await zustand(base);
  assert.equal(nachher.phase, 'question', 'die offene Frage läuft weiter');
  assert.equal(nachher.current.text, 'Frage 1-0');
  assert.deepEqual(nachher.teams.map((team) => team.score), [500, 0], 'Punkte sind erhalten');
  assert.deepEqual(
    nachher.board.categories[0].cells.map((c) => c.used),
    [false, false, false, true],
    'gespielte Felder bleiben gespielt',
  );

  // Eingebettete Bilder liegen sonst nur im Speicher und wären nach dem
  // Neustart kaputt. Die Kennung leitet sich aus dem Bildinhalt ab, damit
  // dieselbe URL nie ein anderes Bild meint.
  const { createHash } = await import('node:crypto');
  const rohbild = Buffer.from(EIN_PIXEL.split(',')[1], 'base64');
  const id = `b${createHash('sha1').update(rohbild).digest('hex').slice(0, 16)}`;
  const bild = await fetch(`${base}/api/bild/${id}`);
  assert.equal(bild.status, 200);
  assert.match(bild.headers.get('content-type'), /image\/png/);
});

test('Spielstand aus einer älteren Fassung bricht den ersten Buzz nicht', async (t) => {
  // Der Stand auf der Platte kann Felder nicht kennen, die es damals noch nicht
  // gab (state.rekorde, team.serie). Früher starb daran der erste Buzz nach dem
  // Neustart – mitten im Spiel, mit allen am Tisch.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const stateFile = path.join(dir, 'stand.json');
  const port = 4500 + Math.floor(Math.random() * 200);

  // Ein alter Stand: mitten in der Frage, Buzzer offen, ohne die neuen Felder.
  const alt = {
    gespeichert: Date.now(),
    state: {
      phase: 'question',
      round: 1,
      roundCount: 2,
      setName: 'Alt',
      turnIndex: 0,
      teams: [
        { id: 't1', name: 'Rot', color: '#f00', score: 300, members: [] },
        { id: 't2', name: 'Blau', color: '#00f', score: 100, members: [{ name: 'Bea', clientId: 'g2', online: true }] },
      ],
      board: { multiplier: 1, categories: [{ name: 'K', cells: [{ value: 100, used: true }] }] },
      current: {
        catIdx: 0, rowIdx: 0, category: 'K', value: 100, text: 'Frage', answer: 'Antwort',
        image: null, step: 'buzz', teamId: 't1', onTheHook: null, buzzedTeamId: null,
        lockedOut: [], revealed: false, log: [{ teamId: 't1', result: 'pass', delta: 0 }],
        buzzOpenedAt: Date.now(),
      },
      settings: { turnMode: 'rotate', wrongPenalty: 'none', buzzAfterCorrect: false },
      message: null,
      // state.rekorde fehlt hier bewusst.
    },
  };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(stateFile, JSON.stringify(alt));

  const { proc, base } = await starteServer(port, stateFile);
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  // Bea buzzert – genau hier lag der Absturz.
  const bea = await verbinde(base, 'g2', 'player');
  await warte(200);
  const gebuzzert = await bea.tu({ type: 'buzz' });

  assert.equal(gebuzzert.ok, true, gebuzzert.error || '');
  const stand = await zustand(base);
  assert.equal(stand.current.buzzedTeamId, 't2');
  assert.equal((await fetch(`${base}/api/info`)).status, 200, 'der Server lebt noch');
});

test('kaputt kodierte Adresse beendet den Server nicht', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const port = 3700 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const kaputt = await fetch(`${base}/%`);
  assert.equal(kaputt.status, 400);
  const danach = await fetch(`${base}/api/info`);
  assert.equal(danach.status, 200, 'der Server lebt noch');
});

test('Host-Rechte hängen an der Verbindung, nicht an der Behauptung im Request', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const port = 3900 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const anmaßen = (id) =>
    fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: id, role: 'host', type: 'addTeam', name: 'Eindringling' }),
    }).then((r) => r.json());

  // Ein Handy, das im Spiel sitzt, kann sich die Rechte nicht per Behauptung nehmen.
  const handy = await verbinde(base, 'irgendein-handy', 'player');
  await warte(200);

  const frech = await handy.tu({ role: 'host', type: 'addTeam', name: 'Eindringling' });
  assert.equal(frech.ok, false);
  assert.match(frech.error, /Host/);

  // Ohne offene Verbindung sieht es genauso aus wie ein Host, dessen Handy gerade
  // aufgewacht ist. Abgelehnt wird es trotzdem – nur eben mit der Erklärung, die
  // in diesem Moment stimmt.
  const schlafend = await anmaßen('nie-verbunden');
  assert.equal(schlafend.ok, false);
  assert.match(schlafend.error, /neu aufgebaut/);

  assert.deepEqual((await zustand(base)).teams, [], 'kein Weg führte zu Team-Rechten');
});

test('zu großer Upload wird als lesbare JSON-Meldung abgelehnt', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const port = 4100 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const res = await fetch(`${base}/api/sets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ set: { name: 'x'.repeat(40 * 1024 * 1024) } }),
  });
  assert.equal(res.status, 413);
  const daten = await res.json(); // darf nicht an einer abgerissenen Verbindung scheitern
  assert.match(daten.error, /Zu groß/);
});

test('krumme Anfragen bekommen eine Antwort statt eines Absturzes', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-krumm-'));
  const port = 4700 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const sende = (rumpf) => fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rumpf,
  });

  // `null`, ein Array und eine nackte Zeichenkette sind gültiges JSON, aber
  // kein Aufruf. Bei `null` lief der Server vorher in eine Ausnahme und
  // antwortete mit 500 und dem englischen Wortlaut der JS-Fehlermeldung.
  for (const rumpf of ['null', '[1,2,3]', '"hallo"', '']) {
    const res = await sende(rumpf);
    assert.equal(res.status, 200, `${rumpf || '(leer)'} sollte sauber beantwortet werden`);
    const daten = await res.json();
    assert.equal(daten.ok, false);
    assert.match(daten.error, /Unbekannte Aktion/);
  }

  const kaputt = await sende('{nicht json');
  assert.equal(kaputt.status, 400);
  assert.match((await kaputt.json()).error, /JSON/);

  // Und danach nimmt er ganz normal wieder Züge an.
  const host = await alsHost(base, 'krumm-host');
  assert.deepEqual(await host({ type: 'addTeam', name: 'Rot' }), { ok: true });
});

test('ein Fragensatz darf den Spielstand nicht überschreiben', async (t) => {
  // Die Sicherung des laufenden Abends liegt als .spielstand.json im selben
  // Ordner wie die Fragensätze. Ein Satz mit diesem Dateinamen hätte sie
  // ersetzt – gemessen ging das durch.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-name-'));
  const port = 4900 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const speichere = (file) => fetch(`${base}/api/sets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, set: SATZ, overwrite: true }),
  }).then((r) => r.json());

  for (const file of ['.spielstand.json', '.htaccess.json', '.json']) {
    const antwort = await speichere(file);
    assert.equal(antwort.ok, false, `${file} sollte abgelehnt werden`);
    assert.match(antwort.error, /Punkt/);
  }
});

test('eine fehlende Datei verrät den Pfad des Servers nicht', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-pfad-'));
  const port = 5100 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const res = await fetch(`${base}/api/set?file=gibtsnicht.json`);
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.match(error, /gibt es nicht/);
  assert.doesNotMatch(error, /ENOENT|\//, `kein Pfad in der Meldung: ${error}`);
});

test('ein abgelehnter Zug überschreibt den Rückweg nicht', async (t) => {
  // Der Rückweg ist das Sicherheitsnetz des Hosts – und genau dann gespannt,
  // wenn er sich vertippt hat. Vorher setzte jeder rücknehmbare Zug den
  // Schnappschuss, bevor er lief: Ein abgelehnter Griff daneben ersetzte damit
  // den Rückweg, und die falsche Wertung davor war nicht mehr zurückzuholen.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-rueck-'));
  const port = 5300 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'rueck-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', set: SATZ });
  await host({ type: 'pick', catIdx: 0, rowIdx: 3 });
  await host({ type: 'judge', correct: true });
  assert.equal((await zustand(base)).teams[0].score, 500);
  assert.match((await zustand(base)).rueckgaengig, /Wertung/);

  // Ein Feld wählen, während die Frage noch offen ist: prallt ab.
  const daneben = await host({ type: 'pick', catIdx: 1, rowIdx: 0 });
  assert.equal(daneben.ok, false);
  assert.match((await zustand(base)).rueckgaengig, /Wertung/, 'der Rückweg zeigt weiter auf die Wertung');

  await host({ type: 'undo' });
  const nachher = await zustand(base);
  assert.equal(nachher.teams[0].score, 0, 'die Wertung ist wirklich zurückgenommen');
  // Seit der Rückweg ein Stapel ist, liegt danach die Feldwahl obenauf – der
  // abgelehnte Griff daneben hat sie nicht verdrängt, und genau darum geht es.
  assert.equal(nachher.rueckgaengig, 'Feldwahl');
});

test('der Rückweg reicht über mehrere Züge', async (t) => {
  // Ein Fehler fällt selten sofort auf: „Moment, das war doch gar nicht falsch"
  // kommt eine Frage später. Mit nur einem gemerkten Zug war dann nichts mehr zu
  // machen – außer Punkte von Hand zu schieben, womit Bilanz und Rekorde
  // auseinanderlaufen, weil die an den Wertungen hängen und nicht am Punktestand.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-rueckweg-'));
  const port = 5900 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'rueckweg-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });

  // Drei Fragen hintereinander, alle richtig gewertet.
  for (let i = 0; i < 3; i += 1) {
    await host({ type: 'pick', catIdx: 0, rowIdx: i });
    await host({ type: 'judge', correct: true });
    await host({ type: 'endQuestion' });
    await host({ type: 'close' });
  }
  // Wer die Punkte bekommt, hängt am Zugwechsel – die Summe nicht.
  const summe = (st) => st.teams.reduce((n, t) => n + t.score, 0);
  assert.equal(summe(await zustand(base)), 600, '100 + 200 + 300');

  const stand = await zustand(base);
  assert.ok(stand.rueckwegTiefe >= 12, `der Stapel merkt sich mehrere Züge, hat aber ${stand.rueckwegTiefe}`);

  // Schrittweise zurück, bis nur noch die erste Wertung steht. Wie viele
  // Schritte das sind, wird nicht vorgerechnet – gezählt wird, dass es mehr als
  // einer ist, denn genau das konnte der Rückweg vorher nicht.
  let schritte = 0;
  while (summe(await zustand(base)) > 100 && schritte < 20) {
    const a = await host({ type: 'undo' });
    assert.equal(a.ok, true, `Rückschritt ${schritte + 1} ging nicht: ${JSON.stringify(a)}`);
    schritte += 1;
  }
  const vorWertung = await zustand(base);
  assert.equal(summe(vorWertung), 100, 'die Wertungen zwei und drei sind zurückgenommen');
  assert.ok(schritte > 1, `dafür brauchte es mehrere Schritte, gemessen ${schritte}`);
  assert.ok(vorWertung.rueckgaengig, 'und der Weg geht danach weiter');
});

test('der Rückweg wächst nicht unbegrenzt', async (t) => {
  // Ein Stapel ohne Deckel wäre ein Leck: Jeder Schritt hält einen vollständigen
  // Spielstand fest. Die Grenze soll greifen, ohne dass etwas kaputtgeht.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-rwtiefe-'));
  const port = 6100 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'rwtiefe-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  const rot = (await zustand(base)).teams[0].id;
  const antworten = [];
  for (let i = 0; i < 40; i += 1) antworten.push(await host({ type: 'adjustScore', teamId: rot, delta: 10 }));
  const abgelehnt = antworten.filter((a) => !a.ok);
  assert.equal(abgelehnt.length, 0, `abgelehnt: ${JSON.stringify(abgelehnt.slice(0, 3))}`);

  const stand = await zustand(base);
  assert.ok(stand.rueckwegTiefe <= 25, `der Stapel bleibt gedeckelt, hat aber ${stand.rueckwegTiefe}`);
  assert.equal(stand.teams[0].score, 400, `Teams: ${JSON.stringify(stand.teams.map((t) => [t.name, t.score]))}`);
  // Und der Weg zurück funktioniert bis zum letzten gemerkten Schritt.
  const rueck = [];
  for (let i = 0; i < 25; i += 1) rueck.push(await host({ type: 'undo' }));
  assert.equal(rueck.filter((a) => !a.ok).length, 0,
    `alle 25 Rückschritte gehen: ${JSON.stringify(rueck.filter((a) => !a.ok).slice(0, 2))}`);
  const leer = await zustand(base);
  assert.equal(leer.rueckwegTiefe, 0, 'der Stapel ist leer');
  assert.equal(leer.rueckgaengig, null, 'danach ist der Weg zu Ende');
  assert.equal(leer.teams[0].score, 150, 'zurück auf den Stand vor den letzten 25 Korrekturen');
  const weiter = await host({ type: 'undo' });
  assert.equal(weiter.ok, false, 'und ein weiterer Versuch sagt das auch');
  assert.match(weiter.error, /nichts zurückzunehmen/);
});

test('eine kaputte Frage lässt sich streichen – das Feld bleibt offen', async (t) => {
  // Doppeldeutig gestellt, Lösung war vorhin schon gefallen, Tippfehler im Satz:
  // Das merkt man erst beim Vorlesen. Vorher blieb nur „irgendwie werten" oder
  // ein verbranntes Feld.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-verwerf-'));
  const port = 6300 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'verwerf-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  const vorher = await zustand(base);
  const wessenZug = vorher.turnIndex;

  // Eine Frage aufrufen, falsch werten, Buzzer freigeben, jemand buzzert falsch.
  await host({ type: 'pick', catIdx: 0, rowIdx: 3 });   // 500 Punkte
  await host({ type: 'judge', correct: false });
  await host({ type: 'buzzFor', teamId: vorher.teams[1].id });
  await host({ type: 'judge', correct: false });
  const mittendrin = await zustand(base);
  assert.notEqual(mittendrin.teams[0].score, 0, 'es sind Punkte geflossen');
  assert.notEqual(mittendrin.teams[1].score, 0, 'bei beiden');

  // Und jetzt fällt auf, dass die Frage kaputt war.
  const weg = await host({ type: 'discard' });
  assert.equal(weg.ok, true, JSON.stringify(weg));
  const danach = await zustand(base);
  assert.equal(danach.current, null, 'die Frage ist weg');
  assert.equal(danach.phase, 'board', 'und das Brett steht wieder da');
  assert.equal(danach.board.categories[0].cells[3].used, false, 'das Feld ist wieder offen');
  assert.equal(danach.teams[0].score, 0, 'die Punkte sind zurück');
  assert.equal(danach.teams[1].score, 0);
  assert.equal(danach.teams[0].bilanz.falsch, 0, 'und die Bilanz auch');
  assert.equal(danach.teams[1].bilanz.falsch, 0);
  assert.equal(danach.turnIndex, wessenZug, 'dasselbe Team ist weiter dran');

  // Zurücknehmen holt die ganze Frage samt Wertung wieder her.
  assert.equal(danach.rueckgaengig, 'Frage verworfen');
  await host({ type: 'undo' });
  const zurueck = await zustand(base);
  assert.ok(zurueck.current, 'die Frage steht wieder');
  assert.equal(zurueck.teams[0].score, mittendrin.teams[0].score, 'mit ihren Punkten');
  assert.equal(zurueck.teams[1].score, mittendrin.teams[1].score);
});

test('Streichen, zurücknehmen, noch einmal streichen trifft nur die eigene Frage', async (t) => {
  // Der Ankerpunkt im Rückweg wurde beim Streichen verbraucht. Nahm der Host das
  // Streichen zurück, stand die Frage wieder da – aber ihr Anker war weg, und
  // ein zweites Streichen fand den Anfang der VORHERIGEN Frage. Nachgestellt
  // wurde damit eine längst abgeschlossene, fremde Frage mitgelöscht.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-verwerf4-'));
  const port = 7300 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'verwerf4-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });

  // Eine Frage ganz normal durchspielen – die geht niemanden mehr etwas an.
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'judge', correct: true });
  await host({ type: 'endQuestion' });
  await host({ type: 'close' });
  const nachErster = await zustand(base);
  const summe = (st) => st.teams.reduce((n, x) => n + x.score, 0);
  const gespielt = (st) => st.board.categories
    .flatMap((c, ci) => c.cells.map((x, ri) => (x.used ? `${ci}/${ri}` : null))).filter(Boolean).join(',');
  assert.equal(summe(nachErster), 100);
  assert.equal(gespielt(nachErster), '0/0');

  // Zweite Frage: streichen, zurücknehmen, noch einmal streichen.
  await host({ type: 'pick', catIdx: 1, rowIdx: 0 });
  await host({ type: 'judge', correct: true });
  assert.equal((await host({ type: 'discard' })).ok, true);
  assert.equal((await host({ type: 'undo' })).ok, true);
  assert.ok((await zustand(base)).current, 'die gestrichene Frage steht wieder da');
  const nochmal = await host({ type: 'discard' });
  assert.equal(nochmal.ok, true, `zweites Streichen: ${JSON.stringify(nochmal)}`);

  const danach = await zustand(base);
  assert.equal(summe(danach), 100, 'die Punkte der ersten Frage stehen noch');
  assert.equal(gespielt(danach), '0/0', 'und ihr Feld ist weiter verbraucht');
  assert.equal(danach.current, null);
});

test('in der Pause steht auch die Buzzer-Uhr still', async (t) => {
  // Die Uhr hängt daran, seit wann der Buzzer offen steht – und das lief in der
  // Pause weiter. Nach einer echten Küchenpause hätte sie beim Weiterspielen
  // sofort „Zeit ist um" gezeigt, obwohl niemand nachgedacht hatte.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-uhrpause-'));
  const port = 7500 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'uhrpause-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  await host({ type: 'settings', settings: { buzzUhr: 10 } });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'pass' });
  const vorher = (await zustand(base)).current.buzzOffenMs;

  await host({ type: 'pause', an: true });
  await warte(1200);
  await host({ type: 'pause', an: false });
  const nachher = (await zustand(base)).current.buzzOffenMs;

  assert.ok(nachher - vorher < 900,
    `die Pause darf nicht mitzählen – gemessen ${nachher - vorher} ms für 1,2 s Pause`);
  assert.ok(nachher >= vorher, 'rückwärts läuft sie aber auch nicht');
});

test('eine Stechfrage lässt sich nicht streichen', async (t) => {
  // Sie hat kein Feld, auf das etwas zurückfallen könnte – und der Weg dafür
  // steht schon da: auflösen und die nächste Frage stellen.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-verwerf2-'));
  const port = 6500 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'verwerf2-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  // Alle Felder beider Runden abräumen, ohne zu werten – dann steht es 0:0.
  for (let runde = 0; runde < 2; runde += 1) {
    for (let kat = 0; kat < 6; kat += 1) {
      for (let reihe = 0; reihe < 4; reihe += 1) {
        await host({ type: 'pick', catIdx: kat, rowIdx: reihe });
        await host({ type: 'endQuestion' });
        await host({ type: 'close' });
      }
    }
    if (runde === 0) await host({ type: 'nextRound' });
  }
  const ende = await zustand(base);
  assert.equal(ende.phase, 'gameOver');
  assert.equal(ende.teams[0].score, 0);
  await host({ type: 'stechen' });
  assert.ok((await zustand(base)).current?.stechen, 'das Stechen läuft');

  const weg = await host({ type: 'discard' });
  assert.equal(weg.ok, false);
  assert.match(weg.error, /Stechfrage/);
});

test('ohne Rückweg wird nichts gestrichen', async (t) => {
  // Nach einem Neustart des Servers ist der Rückweg leer – dann kann das
  // Streichen nicht wissen, wohin zurück. Es sagt das, statt zu raten.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-verwerf3-'));
  const port = 6700 + Math.floor(Math.random() * 200);
  const stand = path.join(dir, 'stand.json');
  const erst = await starteServer(port, stand);
  const host1 = await alsHost(erst.base, 'v3-host');
  for (const name of ['Rot', 'Blau']) await host1({ type: 'addTeam', name });
  await host1({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  await host1({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await warte(700); // der Spielstand wird verzögert gesichert
  erst.proc.kill('SIGKILL');

  const zweit = await starteServer(port + 1, stand);
  t.after(async () => {
    zweit.proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });
  const host2 = await alsHost(zweit.base, 'v3-host2');
  assert.ok((await zustand(zweit.base)).current, 'die Frage steht noch offen');
  const weg = await host2({ type: 'discard' });
  assert.equal(weg.ok, false);
  assert.match(weg.error, /reicht nicht/);
});

test('in der Pause ruft kein Handy ein Feld auf und niemand buzzert', async (t) => {
  // Zwei Stunden Spiel heißen mindestens einmal Küche. Blieb das Brett dabei
  // offen, rief ein Tipp im Vorbeigehen ein Feld auf, das niemand hörte – und
  // nach der Pause stand eine Frage da, die keiner gestellt hatte.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-pause-'));
  const port = 6900 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const alsHandy = (id, body) => fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: id, role: 'player', ...body }),
  }).then((r) => r.json());

  const host = await alsHost(base, 'pause-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  const teams = (await zustand(base)).teams;
  await alsHandy('handy-rot', { type: 'joinTeam', teamId: teams[0].id, name: 'Rosa' });
  await alsHandy('handy-blau', { type: 'joinTeam', teamId: teams[1].id, name: 'Ben' });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });

  // In der Lobby gibt es nichts zu pausieren.
  await host({ type: 'backToLobby' });
  const zuFrueh = await host({ type: 'pause', an: true });
  assert.equal(zuFrueh.ok, false);
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });

  assert.equal((await zustand(base)).pause, false, 'zu Beginn läuft keine Pause');
  await host({ type: 'pause', an: true });
  assert.equal((await zustand(base)).pause, true);

  // Das Zugteam tippt im Vorbeigehen ein Feld an.
  const wer = (await zustand(base)).teams[(await zustand(base)).turnIndex];
  const handy = wer.name === 'Rot' ? 'handy-rot' : 'handy-blau';
  const daneben = await alsHandy(handy, { type: 'pick', catIdx: 0, rowIdx: 0 });
  assert.equal(daneben.ok, false);
  assert.match(daneben.error, /Pause/);
  assert.equal((await zustand(base)).current, null, 'es steht keine Frage da');

  // Und der Buzzer bleibt still, auch wenn eine Frage offen ist.
  await host({ type: 'pause', an: false });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'pass' });
  await host({ type: 'pause', an: true });
  const andere = handy === 'handy-rot' ? 'handy-blau' : 'handy-rot';
  const buzz = await alsHandy(andere, { type: 'buzz' });
  assert.equal(buzz.ok, false);
  assert.match(buzz.error, /Pause/);

  // Der Host darf weiter alles – dafür ist so eine Pause oft da.
  const korrektur = await host({ type: 'adjustScore', teamId: teams[0].id, delta: 100 });
  assert.equal(korrektur.ok, true, 'Punkte korrigieren geht auch in der Pause');

  await host({ type: 'pause', an: false });
  const weiter = await zustand(base);
  assert.equal(weiter.pause, false);
  assert.ok(weiter.current, 'die Frage von vorher steht noch');

  // Ein neues Spiel fängt nicht in der Pause an.
  await host({ type: 'pause', an: true });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  assert.equal((await zustand(base)).pause, false, 'ein neues Spiel räumt die Pause ab');
});

test('die Buzzer-Uhr ist aus, bis jemand sie einschaltet', async (t) => {
  // Die Regeln des Spiels kennen keine Uhr. Wer sie nicht will, soll sie nicht
  // wegklicken müssen – und wer sie will, bekommt nur die angebotenen Stufen.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-uhr-'));
  const port = 7100 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'uhr-host');
  assert.equal((await zustand(base)).settings.buzzUhr, 0, 'ab Werk aus');

  await host({ type: 'settings', settings: { buzzUhr: 15 } });
  assert.equal((await zustand(base)).settings.buzzUhr, 15);

  // Krumme Werte fallen durch die Bereinigung, ohne den Spielstand zu vergiften.
  // `null`, `false`, `''` und `[]` stehen hier mit Absicht: Number() macht aus
  // allen vieren eine 0, und 0 heißt „aus" – sie hätten die Uhr stillschweigend
  // abgeschaltet, statt abgewiesen zu werden. Genau das ist einmal passiert.
  for (const krumm of [7, 0.5, -10, 'zehn', null, false, '', [], {}, Infinity]) {
    await host({ type: 'settings', settings: { buzzUhr: krumm } });
    assert.equal((await zustand(base)).settings.buzzUhr, 15,
      `${JSON.stringify(krumm)} hätte nicht durchgehen dürfen`);
  }
  await host({ type: 'settings', settings: { buzzUhr: 0 } });
  assert.equal((await zustand(base)).settings.buzzUhr, 0, 'ausschalten geht wieder');

  // Und die Uhr wertet nichts: Der Server schickt nur, wie lange der Buzzer
  // offen steht – gerechnet von ihm, nicht von der Uhr eines Handys.
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'pass' });
  const offen = await zustand(base);
  assert.equal(offen.current.step, 'buzz');
  assert.ok(offen.current.buzzOffenMs >= 0 && offen.current.buzzOffenMs < 5000,
    `plausible Laufzeit, gemessen ${offen.current.buzzOffenMs}`);
  await warte(600);
  const spaeter = await zustand(base);
  assert.ok(spaeter.current.buzzOffenMs > offen.current.buzzOffenMs, 'und sie läuft weiter');
  assert.equal(spaeter.current.step, 'buzz', 'ohne dass sich am Spiel etwas ändert');
});

test('Zurücknehmen wirft ein frisch angelegtes Team nicht hinaus', async (t) => {
  // „Eigenes Team" darf jedes Handy jederzeit in der Lobby. Der Host darf dort
  // ebenso „dran" setzen, und das ist rücknehmbar. Vorher verschwand das neue
  // Team beim Zurücknehmen mitsamt seinem Gerät, weil der alte Zustand die
  // Teamliste komplett ersetzte.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-neuteam-'));
  const port = 5500 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'neuteam-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  const teams = (await zustand(base)).teams;
  await host({ type: 'setTurn', teamId: teams[1].id });

  await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'handy-nils', role: 'player', type: 'eigenesTeam', name: 'Nils' }),
  });
  assert.equal((await zustand(base)).teams.length, 3);

  await host({ type: 'undo' });
  const nachher = await zustand(base);
  assert.deepEqual(nachher.teams.map((x) => x.name), ['Rot', 'Blau', 'Nils'], 'das neue Team bleibt');
  assert.equal(nachher.teams[2].members.length, 1, 'und sein Handy sitzt noch drin');
  assert.equal(nachher.turnIndex, 0, 'der Zugwechsel selbst ist zurückgenommen');
});

test('Spieler bekommen die Lösung nicht mitgeschickt', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const port = 4300 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'test-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', set: SATZ });
  await host({ type: 'pick', catIdx: 0, rowIdx: 1 });

  assert.equal((await zustand(base, false)).current.answer, null, 'Spieleransicht ohne Lösung');
  assert.equal((await zustand(base, true)).current.answer, 'Antwort 0-1', 'Host sieht sie');
});

test('Zurücknehmen macht die letzte Wertung rückgängig', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const port = 4600 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'undo-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', set: SATZ });

  // Vor dem ersten Zug gibt es nichts zurückzunehmen.
  assert.equal((await zustand(base)).rueckgaengig, null);
  assert.match((await host({ type: 'undo' })).error, /nichts zurückzunehmen/);

  await host({ type: 'pick', catIdx: 0, rowIdx: 3 }); // 500 Punkte
  await host({ type: 'judge', correct: true });

  let z = await zustand(base);
  assert.equal(z.teams[0].score, 500);
  assert.equal(z.teams[0].serie, 1);
  assert.equal(z.teams[0].bilanz.richtig, 1);
  assert.match(z.rueckgaengig, /Wertung für Rot/);

  await host({ type: 'undo' });
  z = await zustand(base);
  assert.equal(z.teams[0].score, 0, 'Punkte zurück');
  assert.equal(z.teams[0].serie, 0, 'Serie zurück');
  assert.equal(z.teams[0].bilanz.richtig, 0, 'Bilanz zurück');
  assert.equal(z.current.step, 'primary', 'die Frage steht wieder offen');
  // Der Rückweg ist ein Stapel: Danach liegt die Feldwahl obenauf, nicht nichts.
  assert.equal(z.rueckgaengig, 'Feldwahl');

  // Und danach lässt sich normal weiterspielen: diesmal falsch – das kostet
  // voreingestellt die Hälfte.
  await host({ type: 'judge', correct: false });
  z = await zustand(base);
  assert.equal(z.teams[0].score, -250);
  assert.equal(z.teams[0].bilanz.falsch, 1);
});

test('Zurücknehmen wirft kein Handy aus dem Team', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const port = 4800 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'undo-host2');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', set: SATZ });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'judge', correct: true });

  // Jetzt kommt jemand dazu – nach der Wertung, aber vor dem Zurücknehmen.
  // Der Schnappschuss kennt dieses Gerät nicht.
  await host({ type: 'close' });
  const teams = (await zustand(base)).teams;
  await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'spaetzuender', role: 'player', type: 'joinTeam', teamId: teams[1].id, name: 'Kim' }),
  });

  await host({ type: 'undo' }); // nimmt das Abschließen zurück
  const z = await zustand(base);
  assert.deepEqual(
    z.teams.map((t2) => t2.members.map((m) => m.name)),
    [[], ['Kim']],
    'Kim bleibt im Team, obwohl der Schnappschuss älter ist',
  );
});

test('Ein neues Spiel löscht den Rückweg', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const port = 5000 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'undo-host3');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', set: SATZ });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'judge', correct: true });
  assert.ok((await zustand(base)).rueckgaengig);

  await host({ type: 'startGame', set: SATZ });
  assert.equal((await zustand(base)).rueckgaengig, null, 'kein Rückweg ins alte Spiel');
  assert.match((await host({ type: 'undo' })).error, /nichts zurückzunehmen/);
});

test('Spieler dürfen nicht zurücknehmen', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const port = 5200 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'undo-host4');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', set: SATZ });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'judge', correct: true });

  const antwort = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'irgendwer', role: 'player', type: 'undo' }),
  }).then((r) => r.json());
  assert.match(antwort.error, /Nur der Host/);
  assert.equal((await zustand(base)).teams[0].score, 100, 'Punkte unangetastet');

  // Und die Spieleransicht erfährt gar nicht erst davon.
  assert.equal((await zustand(base, false)).rueckgaengig, undefined);
});

test('bei gleichzeitigem Buzz gewinnt genau einer', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const port = 5400 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'buzz-host');
  for (const name of ['Rot', 'Blau', 'Grün', 'Gelb']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', set: SATZ });

  const teams = (await zustand(base)).teams;
  // Je ein Handy in jedem Team, das nicht die Frage hat.
  const geraete = [];
  for (const [i, team] of teams.entries()) {
    const clientId = `handy${i}`;
    await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, role: 'player', type: 'joinTeam', teamId: team.id, name: `Spieler ${i}` }),
    });
    geraete.push(clientId);
  }

  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  const zugTeam = (await zustand(base)).current.teamId;
  await host({ type: 'pass' }); // Buzzer für alle anderen frei

  // Alle gleichzeitig losdrücken, ohne dazwischen zu warten.
  const drueckende = geraete.filter((_, i) => teams[i].id !== zugTeam);
  const antworten = await Promise.all(drueckende.map((clientId) =>
    fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, role: 'player', type: 'buzz' }),
    }).then((r) => r.json())));

  const durch = antworten.filter((a) => !a.error);
  const abgewiesen = antworten.filter((a) => a.error);
  assert.equal(durch.length, 1, `genau ein Buzz darf durchgehen, es waren ${durch.length}`);
  assert.equal(abgewiesen.length, drueckende.length - 1);
  for (const a of abgewiesen) {
    assert.match(a.error, /zu spät|schneller/i, `verständliche Absage statt „${a.error}"`);
  }

  const nachher = await zustand(base);
  assert.ok(nachher.current.buzzedTeamId, 'ein Team hat den Buzz');
  assert.notEqual(nachher.current.buzzedTeamId, zugTeam, 'nicht das Zugteam');
});

test('acht Teams mit je zwei Handys überstehen Abbruch und Rückkehr', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const port = 5600 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'party-host');
  const namen = ['Rot', 'Blau', 'Grün', 'Gelb', 'Lila', 'Türkis', 'Orange', 'Pink'];
  for (const name of namen) await host({ type: 'addTeam', name });
  const teams = (await zustand(base)).teams;

  // 16 Geräte, zwei je Team – jedes mit eigenem Ereignisstrom.
  const stroeme = [];
  const geraete = [];
  for (const [i, team] of teams.entries()) {
    for (const zweit of [0, 1]) {
      const clientId = `handy-${i}-${zweit}`;
      const v = await verbinde(base, clientId, 'player');
      stroeme.push({ clientId, reader: v.reader });
      geraete.push({ clientId, teamId: team.id, geheim: v.geheim, tu: v.tu });
    }
  }
  await warte(300);
  for (const g of geraete) {
    await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: g.clientId, geheim: g.geheim, role: 'player', type: 'joinTeam', teamId: g.teamId, name: g.clientId }),
    });
  }
  await warte(300);

  let z = await zustand(base);
  assert.deepEqual(z.teams.map((x) => x.members.length), new Array(8).fill(2), 'alle 16 sind drin');
  assert.ok(z.teams.every((x) => x.members.every((m) => m.online)), 'und alle online');

  await host({ type: 'startGame', set: SATZ });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'pass' });

  // Mitten im offenen Buzzer verliert ein Gerät die Verbindung.
  const opfer = stroeme.find((s) => s.clientId === 'handy-3-0');
  await opfer.reader.cancel();
  await warte(400);

  z = await zustand(base);
  const teamDesOpfers = z.teams.find((x) => x.members.some((m) => m.clientId === 'handy-3-0'));
  assert.ok(teamDesOpfers, 'das Gerät bleibt im Team stehen');
  assert.equal(teamDesOpfers.members.find((m) => m.clientId === 'handy-3-0').online, false, 'aber als offline');
  assert.equal(teamDesOpfers.members.find((m) => m.clientId === 'handy-3-1').online, true, 'das zweite Handy bleibt online');

  // Das zweite Handy desselben Teams kann weiter buzzern – der Ausfall des
  // ersten darf das Team nicht aus dem Rennen nehmen.
  const gebuzzert = await geraete.find((g) => g.clientId === 'handy-3-1')
    .tu({ role: 'player', type: 'buzz' });
  assert.ok(!gebuzzert.error, `Buzz sollte durchgehen, kam aber: ${gebuzzert.error}`);

  await host({ type: 'judge', correct: true });
  z = await zustand(base);
  assert.equal(z.teams.find((x) => x.id === teamDesOpfers.id).score, 50, 'halbe Punkte für den Buzz');

  // Und das abgestürzte Handy kommt zurück – mitten im Spiel, ohne neu beizutreten.
  const zurueck = await fetch(`${base}/api/events?clientId=handy-3-0&role=player`);
  zurueck.body.getReader().read();
  await warte(400);
  z = await zustand(base);
  const wieder = z.teams.find((x) => x.id === teamDesOpfers.id).members.find((m) => m.clientId === 'handy-3-0');
  assert.equal(wieder.online, true, 'wieder online, ohne erneut beizutreten');
  assert.equal(wieder.name, 'handy-3-0', 'und mit demselben Namen');
});

/**
 * Ein ganzer Abend am Stück – über die echte Schnittstelle, mit Prüfung nach
 * jeder einzelnen Aktion.
 *
 * Die übrigen Tests schauen sich einzelne Regeln an. Dieser spielt beide Runden
 * durch, mit allem, was an einem Abend vorkommt: richtig, falsch, „weiß nicht",
 * Buzzer, zurückgenommene Wertungen, Punktekorrekturen von Hand und einem
 * gesetzten Zug. Nach jedem Schritt wird geprüft, dass der Zustand überhaupt
 * noch Sinn ergibt – ein kaputter Punktestand oder eine hängende Phase fällt so
 * an der Stelle auf, an der sie entsteht, und nicht erst am Ende.
 */
/* Ein Satz in voller Größe: zwei Runden, sechs Kategorien, 48 Fragen – so wie
   die mitgelieferten. Der kleine SATZ oben genügt für einzelne Regeln, aber
   nicht, um einen Abend nachzuspielen. */
const VOLLER_SATZ = {
  name: 'Abendtest',
  rounds: Array.from({ length: 2 }, (_, r) => ({
    categories: Array.from({ length: 6 }, (_, c) => ({
      name: `R${r + 1}K${c + 1}`,
      questions: Array.from({ length: 4 }, (_, i) => ({
        text: `Frage ${r}-${c}-${i}`,
        answer: `Antwort ${r}-${c}-${i}`,
      })),
    })),
  })),
};

test('ein ganzer Abend läuft ohne kaputten Zustand durch', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const port = 5800 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  // Eine einzige offene Verbindung, die den Zustand mitschreibt: Für jeden
  // Schritt eine neue zu öffnen wären hunderte Verbindungen.
  let stand = null;
  let geheim = null;
  const res = await fetch(`${base}/api/events?clientId=abend&role=host`);
  const reader = res.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    let puffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      puffer += dec.decode(value, { stream: true });
      let i;
      while ((i = puffer.indexOf('\n\n')) >= 0) {
        const stueck = puffer.slice(0, i);
        puffer = puffer.slice(i + 2);
        const treffer = stueck.match(/^event: state\ndata: (.*)$/s);
        if (treffer) stand = JSON.parse(treffer[1]);
        // Der Nachweis für diese Gerätekennung – ohne ihn lehnt der Server ab.
        const hallo = stueck.match(/^event: hello\ndata: (.*)$/s);
        if (hallo) geheim = JSON.parse(hallo[1]).geheim || null;
      }
    }
  })();
  await warte(250);

  const PHASEN = new Set(['lobby', 'board', 'question', 'roundEnd', 'gameOver']);
  const SCHRITTE = new Set(['primary', 'buzz', 'result']);
  let schrittZaehler = 0;

  /** Führt eine Aktion aus und prüft danach, dass der Zustand heil ist. */
  async function tu(body, darfScheitern = false) {
    const antwort = await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'abend', geheim, role: 'host', ...body }),
    });
    assert.ok(antwort.status < 500, `Serverfehler bei ${body.type}: ${antwort.status}`);
    const daten = await antwort.json();
    if (!darfScheitern && daten.error) {
      throw new Error(`Schritt ${schrittZaehler} (${body.type}) abgelehnt: ${daten.error}`);
    }
    await warte(12);
    schrittZaehler++;

    const wo = `nach Schritt ${schrittZaehler} (${body.type})`;
    assert.ok(stand, `kein Zustand ${wo}`);
    assert.ok(PHASEN.has(stand.phase), `unbekannte Phase „${stand.phase}" ${wo}`);
    for (const team of stand.teams) {
      assert.ok(Number.isInteger(team.score), `Punktestand von ${team.name} ist ${team.score} ${wo}`);
      for (const [feld, wert] of Object.entries(team.bilanz || {})) {
        assert.ok(Number.isFinite(wert), `Bilanz ${feld} von ${team.name} ist ${wert} ${wo}`);
      }
    }
    if (stand.phase === 'question') {
      assert.ok(stand.current, `Phase „question" ohne Frage ${wo}`);
      assert.ok(SCHRITTE.has(stand.current.step), `unbekannter Schritt ${wo}`);
    } else {
      assert.equal(stand.current, null, `Frage hängt in Phase „${stand.phase}" ${wo}`);
    }
    if (['board', 'question'].includes(stand.phase)) {
      assert.ok(stand.turnIndex >= 0 && stand.turnIndex < stand.teams.length, `turnIndex daneben ${wo}`);
    }
    return daten;
  }

  const namen = ['Rot', 'Blau', 'Grün', 'Gelb', 'Lila'];
  for (const name of namen) await tu({ type: 'addTeam', name });
  await tu({ type: 'startGame', set: VOLLER_SATZ });

  const offen = () => stand.board.categories
    .flatMap((c, ci) => c.cells.map((z, ri) => (z.used ? null : [ci, ri])))
    .filter(Boolean);

  let gespielt = 0;
  for (let runde = 1; runde <= 1; runde++) {
    while (offen().length) {
      const [ci, ri] = offen()[0];
      await tu({ type: 'pick', catIdx: ci, rowIdx: ri });
      const zugTeam = stand.current.teamId;
      const muster = gespielt % 5;

      if (muster === 0) {
        await tu({ type: 'judge', correct: true });
      } else if (muster === 1) {
        // Falsch, dann holt sich ein anderes Team die halben Punkte.
        await tu({ type: 'judge', correct: false });
        const frei = stand.teams.find((x) => x.id !== zugTeam && !stand.current.lockedOut.includes(x.id));
        if (frei) {
          await tu({ type: 'buzzFor', teamId: frei.id });
          await tu({ type: 'judge', correct: true });
        }
      } else if (muster === 2) {
        // Weiß nicht, danebengebuzzert, dann aufgelöst.
        await tu({ type: 'pass' });
        const frei = stand.teams.find((x) => x.id !== zugTeam && !stand.current.lockedOut.includes(x.id));
        if (frei) {
          await tu({ type: 'buzzFor', teamId: frei.id });
          await tu({ type: 'judge', correct: false });
        }
      } else if (muster === 3) {
        // Verklickt: erst richtig, dann zurückgenommen und doch falsch.
        await tu({ type: 'judge', correct: true });
        const vorher = stand.teams.find((x) => x.id === zugTeam).score;
        await tu({ type: 'undo' });
        const nachher = stand.teams.find((x) => x.id === zugTeam).score;
        assert.ok(nachher < vorher, 'das Zurücknehmen muss die Punkte auch wirklich zurücknehmen');
        await tu({ type: 'judge', correct: false });
      } else {
        await tu({ type: 'judge', correct: false });
      }

      if (stand.current?.step !== 'result') await tu({ type: 'endQuestion' });
      await tu({ type: 'close' });
      gespielt++;

      // Zwischendurch das, was ein Host sonst noch tut.
      if (gespielt === 3) await tu({ type: 'adjustScore', teamId: stand.teams[2].id, delta: -100 });
      if (gespielt === 5) await tu({ type: 'setTurn', teamId: stand.teams[4].id });
    }
    assert.equal(stand.phase, 'roundEnd', 'nach 24 Feldern ist die Runde durch');
    await tu({ type: 'nextRound' });
  }

  assert.equal(stand.round, 2);
  assert.equal(stand.board.multiplier, 2, 'Runde 2 zählt doppelt');
  assert.equal(offen().length, 24, 'ein frisches Board');

  // Zweite Runde zügig abräumen – hier zählt, dass nichts hängen bleibt.
  while (offen().length) {
    const [ci, ri] = offen()[0];
    await tu({ type: 'pick', catIdx: ci, rowIdx: ri });
    await tu({ type: 'judge', correct: gespielt % 2 === 0 });
    if (stand.current?.step !== 'result') await tu({ type: 'endQuestion' });
    await tu({ type: 'close' });
    gespielt++;
  }

  assert.equal(gespielt, 48, 'beide Boards komplett gespielt');
  assert.equal(stand.phase, 'gameOver');
  assert.ok(stand.teams.every((x) => Number.isInteger(x.score)));
  // Die Buchhaltung muss zum Verlauf passen.
  const summeAntworten = stand.teams.reduce(
    (n, x) => n + x.bilanz.richtig + x.bilanz.falsch + x.bilanz.gepasst, 0);
  assert.ok(summeAntworten >= 48, `nur ${summeAntworten} verbuchte Antworten bei 48 Fragen`);
  reader.cancel();
});

test('die Pause zwischen zwei Sätzen kostet niemanden sein Team', async (t) => {
  // Nach dem ersten Fragensatz wird geredet und nachgeschenkt, die Handys
  // sperren. Startet der Host in dieser Pause den nächsten Satz, darf das
  // niemanden aus seinem Team werfen: Wer aufwacht, soll weiterspielen und
  // nicht erst wieder QR-Code, Team und Namen durchlaufen.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-pause-'));
  const port = 5900 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'pausen-host');
  await host({ type: 'addTeam', name: 'Die Grübelmeister' });
  const team = (await zustand(base)).teams[0];

  // Zwei Handys im selben Team – eines legt gleich das Display aus der Hand.
  const mira = await verbinde(base, 'mira', 'player');
  const miraLiest = mira.reader;
  await warte(200);
  assert.equal((await mira.tu({ type: 'joinTeam', teamId: team.id, name: 'Mira' })).ok, true);

  await host({ type: 'startGame', file: 'neunziger-nuller.json' });

  // Handy gesperrt: Der Ereignisstrom fällt, der Server bucht Mira offline.
  await miraLiest.cancel();
  await warte(500);
  const offline = (await zustand(base)).teams[0].members[0];
  assert.equal(offline.online, false, 'der Server merkt die Abmeldung');

  // Und jetzt der nächste Satz, während Mira noch nicht zurück ist.
  await host({ type: 'backToLobby' });
  const nachher = (await zustand(base)).teams[0];
  assert.deepEqual(nachher.members.map((m) => m.name), ['Mira'],
    'Mira steht nach dem Neustart noch in ihrem Team');

  // Aufwachen: gleiche clientId, und sie ist sofort wieder dabei.
  const zurueck = await fetch(`${base}/api/events?clientId=mira&role=player`);
  const wachLiest = zurueck.body.getReader();
  wachLiest.read();
  await warte(300);
  const wieder = (await zustand(base)).teams[0].members[0];
  assert.equal(wieder.online, true, 'wieder online');
  assert.equal(wieder.wegSeit, undefined, 'der Abwesenheitsvermerk ist weg');
  await wachLiest.cancel();
});

test('der Host sieht, wie viele Handys noch auf ein Team warten', async (t) => {
  // Die Teamliste kann das nicht zeigen: Wer den QR-Code gerade gescannt hat und
  // den Namen tippt, steht in keinem Team – ist aber genau der Grund, mit dem
  // Start noch zu warten. Nur der Server kennt diese Geräte.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-warte-'));
  const port = 6100 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  const offen = [];
  t.after(async () => {
    for (const r of offen) await r.cancel().catch(() => {});
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });
  const strom = async (id, rolle) => {
    const v = await verbinde(base, id, rolle);
    offen.push(v.reader);
    await warte(150);
    return v;
  };

  const host = await alsHost(base, 'warte-host');
  await host({ type: 'addTeam', name: 'Rot' });
  await host({ type: 'addTeam', name: 'Blau' });
  assert.equal((await zustand(base)).wartende, 0, 'am Anfang wartet niemand');

  // Zwei Gäste haben gescannt, aber noch kein Team gewählt.
  const gast1 = await strom('gast1', 'player');
  await strom('gast2', 'player');
  assert.equal((await zustand(base)).wartende, 2);

  // Zwei Tabs auf demselben Handy sind ein Gerät, nicht zwei.
  await strom('gast2', 'player');
  assert.equal((await zustand(base)).wartende, 2, 'gezählt werden Geräte, nicht Verbindungen');

  // Die Fernbedienung des Hosts wartet auf nichts.
  await strom('host-handy', 'host');
  assert.equal((await zustand(base)).wartende, 2);

  // Einer tritt bei – mit dem Nachweis seines Geräts, wie ein echtes Handy.
  const teams = (await zustand(base)).teams;
  await gast1.tu({ type: 'joinTeam', teamId: teams[0].id, name: 'Mira' });
  assert.equal((await zustand(base)).wartende, 1);

  // Spieler bekommen die Zahl nicht – sie ist eine Host-Angabe.
  assert.equal((await zustand(base, false)).wartende, undefined);
});

test('gleichzeitige Zugriffe von Host und Handys bringen den Server nicht aus dem Tritt', async (t) => {
  // Der Fuzzer in fuzz.test.js prüft die Regeln für sich. Hier kommt dazu, was
  // am Spieleabend wirklich passiert: sieben Geräte drücken gleichzeitig, und
  // zwar auch das Falsche zur falschen Zeit. Erlaubt ist alles, was mit einer
  // lesbaren Meldung abprallt – nicht erlaubt ist ein Serverfehler, ein
  // abgestürzter Prozess oder ein Zustand, der in sich nicht mehr stimmt.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-fuzz-'));
  const port = 6400 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  const offen = [];
  let gestorben = null;
  proc.on('exit', (code) => { gestorben = code; });
  t.after(async () => {
    for (const r of offen) await r.cancel().catch(() => {});
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const strom = async (id, rolle) => {
    const res = await fetch(`${base}/api/events?clientId=${id}&role=${rolle}`);
    const r = res.body.getReader();
    r.read();
    offen.push(r);
  };
  await strom('fuzz-host', 'host');
  const spieler = ['s1', 's2', 's3', 's4', 's5', 's6'];
  for (const id of spieler) await strom(id, 'player');
  await warte(300);

  const schick = (clientId, body) => fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, ...body }),
  }).then(async (res) => ({ status: res.status, daten: await res.json().catch(() => null) }));

  let x = 20240817; // feste Saat: ein Fehlschlag muss wiederholbar sein
  const r = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const zufall = (liste) => liste[Math.floor(r() * liste.length)];

  const host = await alsHost(base, 'fuzz-host');
  await host({ type: 'addTeam', name: 'Rot' });
  await host({ type: 'addTeam', name: 'Blau' });
  await host({ type: 'addTeam', name: 'Grün' });

  const bauZug = (teams) => {
    const team = teams.length ? zufall(teams) : null;
    const wer = zufall(['fuzz-host', ...spieler]);
    const typ = zufall([
      'addTeam', 'removeTeam', 'joinTeam', 'leaveTeam', 'adjustScore', 'setTurn',
      'startGame', 'pick', 'pass', 'judge', 'buzz', 'buzzFor', 'resetBuzz',
      'endQuestion', 'close', 'nextRound', 'undo', 'settings', 'backToLobby',
    ]);
    const gemein = { type: typ };
    if (typ === 'addTeam') gemein.name = zufall(['Gelb', '', 'Lila']);
    if (['removeTeam', 'setTurn', 'buzzFor', 'joinTeam'].includes(typ) && team) gemein.teamId = team.id;
    if (typ === 'joinTeam') gemein.name = 'Gast';
    if (typ === 'adjustScore') { gemein.teamId = team?.id; gemein.delta = zufall([-100, 100]); }
    if (typ === 'startGame') gemein.file = 'kueche-und-keller.json';
    if (typ === 'pick') { gemein.catIdx = Math.floor(r() * 7); gemein.rowIdx = Math.floor(r() * 5); }
    if (typ === 'judge') gemein.correct = r() < 0.5;
    if (typ === 'settings') gemein.settings = { wrongPenalty: zufall(['none', 'half', 'full']) };
    return { wer, gemein };
  };

  for (let runde = 0; runde < 90; runde++) {
    const teams = (await zustand(base)).teams;
    // Fünf Geräte drücken im selben Moment.
    const zuege = Array.from({ length: 5 }, () => bauZug(teams));
    const antworten = await Promise.all(zuege.map(({ wer, gemein }) => schick(wer, gemein)));
    antworten.forEach((a, i) => {
      assert.ok(a.status < 500,
        `Serverfehler ${a.status} bei ${zuege[i].gemein.type} (${zuege[i].wer})`);
      assert.ok(a.daten && (a.daten.ok === true || typeof a.daten.error === 'string'),
        `unbrauchbare Antwort auf ${zuege[i].gemein.type}: ${JSON.stringify(a.daten)}`);
      if (a.daten.ok !== true) {
        assert.ok(a.daten.error.length > 8, `zu knappe Meldung: „${a.daten.error}"`);
      }
    });
    assert.equal(gestorben, null, `Server gestorben (Code ${gestorben}) in Runde ${runde}`);

    const st = await zustand(base);
    assert.ok(['lobby', 'board', 'question', 'roundEnd', 'gameOver'].includes(st.phase), st.phase);
    assert.equal(st.phase === 'question', !!st.current, `Phase ${st.phase} passt nicht zu current`);
    for (const team of st.teams) {
      assert.ok(Number.isInteger(team.score), `Punktestand kaputt: ${team.score}`);
      for (const [feld, wert] of Object.entries(team.bilanz || {})) {
        assert.ok(Number.isFinite(wert) && wert >= 0, `Bilanz „${feld}" = ${wert}`);
      }
    }
    if (st.teams.length) {
      assert.ok(st.turnIndex >= 0 && st.turnIndex < st.teams.length,
        `turnIndex ${st.turnIndex} bei ${st.teams.length} Teams`);
    }
    // Ein Gerät steht in höchstens einem Team – auch wenn zwei Beitritte
    // gleichzeitig eintrudeln.
    const gesehen = new Set();
    for (const team of st.teams) {
      for (const m of team.members) {
        assert.ok(!gesehen.has(m.clientId), `Gerät ${m.clientId} steht in zwei Teams`);
        gesehen.add(m.clientId);
      }
    }
  }

  // Zum Schluss muss der Server noch normal antworten.
  assert.equal((await fetch(`${base}/api/info`)).ok, true, 'Server antwortet nicht mehr');
});

test('eine Wertung für die vorige Lage wird abgelehnt', async (t) => {
  // Der Host drückt „Richtig" fürs Zugteam – und in der Millisekunde davor hat
  // jemand gebuzzert. Ohne Schutz schriebe der Druck dem Buzzer die vollen
  // Punkte gut, die dem Zugteam gedacht waren. Die Entprellung im Browser deckt
  // den Zitterfinger auf einem Gerät ab, aber nicht zwei Host-Geräte und nicht
  // ein Nachtippen, wenn die Anzeige bei zäher Verbindung hinterherhinkt.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-lage-'));
  const port = 6700 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  const offen = [];
  t.after(async () => {
    for (const r of offen) await r.cancel().catch(() => {});
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });
  const geraete = new Map();
  const strom = async (id, rolle) => {
    const v = await verbinde(base, id, rolle);
    offen.push(v.reader);
    geraete.set(id, v);
    await warte(150);
  };
  const schick = (clientId, body) => (geraete.get(clientId)?.tu ?? ((b) => fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, ...b }),
  }).then((r) => r.json())))(body);

  // Der Host steht mit in der Geräteliste: `schick` benutzt ihn weiter unten
  // für den verspäteten Druck, und auch er muss sich ausweisen.
  const hostGeraet = await verbinde(base, 'lage-host', 'host');
  geraete.set('lage-host', hostGeraet);
  offen.push(hostGeraet.reader);
  await warte(200);
  const host = hostGeraet.tu;
  await host({ type: 'addTeam', name: 'Zugteam' });
  await host({ type: 'addTeam', name: 'Buzzteam' });
  await strom('handy', 'player');
  let st = await zustand(base);
  await schick('handy', { type: 'joinTeam', teamId: st.teams[1].id, name: 'Mira' });
  await host({ type: 'startGame', file: 'kueche-und-keller.json' });
  await host({ type: 'pick', catIdx: 0, rowIdx: 3 });

  st = await zustand(base);
  const alteLage = st.lage;
  assert.equal(st.current.step, 'primary');
  assert.ok(alteLage, 'die Ansicht bringt eine Lage mit');

  // Jetzt überholt die Wirklichkeit: passen, dann buzzert das Handy.
  await host({ type: 'pass' });
  await schick('handy', { type: 'buzz' });
  st = await zustand(base);
  assert.equal(st.current.buzzedTeamId, st.teams[1].id, 'das Handy hat gebuzzert');

  // Der verspätete Druck, der noch die alte Lage im Gepäck hat.
  const spaet = await schick('lage-host', { type: 'judge', correct: true, lage: alteLage });
  assert.equal(spaet.ok, false, 'die überholte Wertung greift nicht durch');
  assert.match(spaet.error, /geändert/);
  st = await zustand(base);
  // −250 steht schon da: „weiß nicht" kostet voreingestellt die Hälfte. Wichtig
  // ist, dass sich durch den überholten Druck nichts weiter bewegt hat.
  assert.deepEqual(st.teams.map((t) => t.score), [-250, 0], 'und hat keine Punkte verteilt');

  // Mit der aktuellen Lage geht es durch – und trifft das Buzzteam.
  const jetzt = await schick('lage-host', { type: 'judge', correct: true, lage: st.lage });
  assert.equal(jetzt.ok, true);
  st = await zustand(base);
  assert.deepEqual(st.teams.map((t) => t.score), [-250, 250], 'halbe Punkte fürs Buzzteam');

  // Ohne Angabe bleibt alles wie bisher – eine alte, im Browser hängende Seite
  // soll nicht plötzlich nichts mehr können.
  await host({ type: 'close' });
  await host({ type: 'pick', catIdx: 1, rowIdx: 0 });
  const ohne = await schick('lage-host', { type: 'judge', correct: true });
  assert.equal(ohne.ok, true, 'ohne Lage-Angabe wird nicht blockiert');
});

/* ------------------------------------------------------- Losspielen */

test('ein belegter Port hält den Start nicht auf', async (t) => {
  // Wer das Startskript doppelklickt, hat kein Terminal offen. „Port 3000 ist
  // belegt, nimm einen anderen" wäre dort eine Sackgasse – also sucht der
  // Server sich selbst den nächsten freien.
  //
  // Geprüft wird mit dem echten Standardport: Ein zweiter Startport nur für
  // Tests wäre Prüfgerüst im Produkt. Hat schon etwas anderes den Port, ist
  // die Ausgangslage nicht herstellbar – dann wird der Test übersprungen statt
  // aus einem fremden Grund rot.
  const blocker = createServer(() => {});
  const belegt = await new Promise((r) => {
    blocker.once('error', () => r(false));
    blocker.listen(3000, () => r(true));
  });
  if (!belegt) {
    t.skip('Port 3000 ist von etwas anderem belegt');
    return;
  }
  t.after(() => blocker.close());

  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-port-'));
  const proc = spawn(process.execPath, [SERVER], {
    // Kein PORT in der Umgebung – sonst gilt die Angabe, und das mit Recht.
    env: { ...process.env, PORT: '', QUIZDUELL_STATE_FILE: path.join(dir, 'stand.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  let ausgabe = '';
  proc.stdout.on('data', (d) => { ausgabe += d; });
  proc.stderr.on('data', (d) => { ausgabe += d; });
  // Großzügig warten: Hier startet ein echter Node-Prozess, der beim ersten
  // Versuch auf einen belegten Port läuft und es dann noch einmal probiert.
  // Auf einer beschäftigten Maschine dauert das länger als die sechs Sekunden,
  // die hier standen – dann wurde der Test rot, ohne dass etwas kaputt war.
  //
  // Gewartet wird auf die LETZTE Zeile, nicht auf die erste. „läuft!" ist die
  // Überschrift, der Hinweis auf den ausgewichenen Port kommt fünf Ausgaben
  // später – und stdout kommt häppchenweise an. Wer bei „läuft!" aufhört zu
  // warten, prüft mit etwa jedem siebten Lauf einen Text, der nur aus der
  // Überschrift besteht: gemessen 25 Läufe, einer rot, und im Fehlerbericht
  // stand als tatsächliche Ausgabe genau die eine Zeile. Das war kein Fehler
  // im Server, sondern ein Test, der zu früh hinsah.
  const fertig = () => /war belegt/.test(ausgabe) || proc.exitCode !== null;
  for (let i = 0; i < 400 && !fertig(); i++) await warte(50);

  assert.match(ausgabe, /läuft!/, `der Server ist gar nicht hochgekommen. Ausgabe:\n${ausgabe}`);
  assert.match(ausgabe, /war belegt/,
    `er hätte sagen müssen, warum es ein anderer Port ist. Ausgabe:\n${ausgabe}`);
  const treffer = ausgabe.match(/localhost:(\d+)\/host/);
  assert.ok(treffer, 'keine Adresse in der Ausgabe');
  const genutzt = Number(treffer[1]);
  assert.notEqual(genutzt, 3000, 'er sitzt auf dem belegten Port');

  // Und er ist wirklich ansprechbar, nicht nur laut.
  const res = await fetch(`http://localhost:${genutzt}/api/info`);
  assert.equal(res.ok, true);
});

test('ein selbst gesetzter Port wird nicht heimlich verschoben', async (t) => {
  // Wer PORT=8080 schreibt, meint 8080 – ein stilles Ausweichen würde
  // Anleitungen, Lesezeichen und Testläufe unter der Hand falsch machen.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-port2-'));
  const belegt = 7600 + Math.floor(Math.random() * 200);
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const blocker = createServer(() => {});
  await new Promise((r) => blocker.listen(belegt, r));
  t.after(() => blocker.close());

  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(belegt), QUIZDUELL_STATE_FILE: path.join(dir, 'stand.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ausgabe = '';
  proc.stdout.on('data', (d) => { ausgabe += d; });
  proc.stderr.on('data', (d) => { ausgabe += d; });
  const code = await new Promise((r) => proc.on('exit', r));

  assert.equal(code, 1, 'er hätte mit einer Meldung aufhören müssen');
  assert.match(ausgabe, /schon belegt/);
  assert.doesNotMatch(ausgabe, /läuft!/, 'und nicht auf einem anderen Port weiterlaufen');
});

test('der Browser wird je System richtig aufgerufen', async () => {
  // Der leere String bei Windows ist die Stelle, an der so etwas gern kaputt
  // geht: `start` deutet sein erstes Argument in Anführungszeichen als
  // Fenstertitel, und ohne Platzhalter ginge nichts auf.
  const { browserBefehl } = await import('../server/browser.js');
  assert.deepEqual(browserBefehl('darwin'), { befehl: 'open', args: [] });
  assert.deepEqual(browserBefehl('win32'), { befehl: 'cmd', args: ['/c', 'start', ''] });
  assert.deepEqual(browserBefehl('linux'), { befehl: 'xdg-open', args: [] });
  assert.deepEqual(browserBefehl('freebsd'), { befehl: 'xdg-open', args: [] },
    'unbekannte Systeme bekommen den verbreitetsten Weg');
});

test('ein Handy legt sein eigenes Team an – aber nur in der Lobby', async (t) => {
  // Der Weg, der einen Spieleabend eröffnet: Alle scannen den QR-Code, tippen
  // ihren Namen und legen los. Ohne das muss der Host erst vier Namen abtippen,
  // bevor überhaupt jemand beitreten kann.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-eigen-'));
  const stateFile = path.join(dir, 'stand.json');
  const port = 3700 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, stateFile);
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const spieler = async (id, name) => {
    const r = await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: id, role: 'player', type: 'eigenesTeam', name }),
    });
    return r.json();
  };

  assert.deepEqual((await spieler('h1', 'Nils')), { ok: true });
  await spieler('h2', 'Annemarie');
  const lobby = await zustand(base);
  assert.deepEqual(lobby.teams.map((t) => t.name), ['Nils', 'Annemarie'],
    'die Teams heißen wie die Leute, die sie angelegt haben');
  assert.deepEqual(lobby.teams.map((t) => t.members.map((m) => m.name)), [['Nils'], ['Annemarie']],
    'und jeder sitzt gleich in seinem');

  // Ohne Namen legt der Server trotzdem eins an – mit dem üblichen Ersatznamen.
  // Der Client bremst vorher, aber der Server darf daran nicht zerbrechen.
  await spieler('h3', '   ');
  const mitLeer = await zustand(base);
  assert.equal(mitLeer.teams.length, 3);
  assert.match(mitLeer.teams[2].name, /^Team \d+$/);

  // Läuft das Spiel, ist Schluss: Teams gibt es nur in der Lobby.
  const host = await alsHost(base, 'eigen-host');
  await host({ type: 'startGame', set: SATZ });
  const abgelehnt = await spieler('h4', 'Zuspät');
  assert.equal(abgelehnt.ok, false);
  assert.match(abgelehnt.error, /Lobby/);
  assert.equal((await zustand(base)).teams.length, 3, 'und es bleibt bei drei Teams');
});

test('jedes Handy sucht sich das Wappen seines Teams selbst aus', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-wappen-'));
  const stateFile = path.join(dir, 'stand.json');
  const port = 3900 + Math.floor(Math.random() * 90);
  const { proc, base } = await starteServer(port, stateFile);
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const tippe = async (id, body) => {
    const r = await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: id, role: 'player', ...body }),
    });
    return r.json();
  };

  await tippe('w1', { type: 'eigenesTeam', name: 'Nils' });
  await tippe('w2', { type: 'eigenesTeam', name: 'Annemarie' });
  const vorher = await zustand(base);
  const fremd = vorher.teams[1].wappen;
  const frei = vorher.wappenAuswahl.find((w) => !vorher.teams.some((t) => t.wappen === w));

  // Ohne teamId gilt es fürs eigene Team – niemand muss eine ID kennen.
  assert.deepEqual(await tippe('w1', { type: 'wappen', wappen: frei }), { ok: true });
  assert.equal((await zustand(base)).teams[0].wappen, frei);

  // Das Wappen der anderen bleibt deren Wappen.
  const belegt = await tippe('w1', { type: 'wappen', wappen: fremd });
  assert.equal(belegt.ok, false);
  assert.match(belegt.error, /anderes Team/);

  // Ein Handy ohne Team hat auch keins zu vergeben – und darf kein fremdes
  // umstecken, indem es einfach eine teamId mitschickt.
  const ohne = await tippe('w9', { type: 'wappen', wappen: fremd, teamId: vorher.teams[0].id });
  assert.equal(ohne.ok, false);
  assert.match(ohne.error, /Team/);
  assert.equal((await zustand(base)).teams[1].wappen, fremd);
});

/* ------------------------------------------------ Tunnel und Zugang
 *
 * Diese Tests beschreiben den Abend, an dem nicht alle im selben WLAN sitzen.
 * Der Tunnel ist dabei eine Attrappe – sie schreibt dieselbe Zeile wie
 * cloudflared und geht nirgends hin.
 */

const ATTRAPPE = fileURLToPath(new URL('./hilfe/tunnel-attrappe.js', import.meta.url));

/** Startet einen Server im Online-Modus und liest beide Schlüssel aus. */
async function starteOnline(port, stateFile, mehr = {}) {
  const s = await starteServer(port, stateFile, 5, {
    QUIZDUELL_ONLINE: '1',
    QUIZDUELL_TUNNEL_BIN: ATTRAPPE,
    QUIZDUELL_TUNNEL_TIMEOUT: '2000',
    ...mehr,
  });
  // Der Hostschlüssel steht in der Adresse, die das Fenster ausgibt – genau so
  // findet ihn auch der Host, dessen Browser sie aufmacht.
  let host = null;
  // Großzügig: Der Schlüssel steht erst im Fenster, wenn der Tunnel geantwortet
  // hat oder aufgegeben wurde – und mehrere Testdateien laufen gleichzeitig.
  for (let i = 0; i < 200 && !host; i++) {
    host = /\/host\?h=([a-z0-9]+)/.exec(s.ausgabe())?.[1] || null;
    if (!host) await warte(50);
  }
  // Ohne Schlüssel bricht der Test hier ab – dann ist der Server aber schon
  // gestartet und wird nirgends mehr aufgeräumt: Der Testlauf hing danach an
  // den offenen Leitungen des Kindprozesses, bis jemand ihn abschoss. Erst
  // abräumen, dann scheitern.
  if (!host) {
    s.proc.kill('SIGKILL');
    assert.fail('kein Hostschlüssel in der Ausgabe');
  }
  const info = await (await fetch(`${s.base}/api/info?h=${host}`)).json();
  return { ...s, host, spiel: info.schluessel, info };
}

test('ohne Tunnel bleibt das Spiel offen wie bisher', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const { proc, base } = await starteServer(3700 + Math.floor(Math.random() * 200), path.join(dir, 's.json'));
  t.after(async () => { proc.kill(); await rm(dir, { recursive: true, force: true }); });

  // Im Heimnetz ist bewusst nichts abgeschlossen – und das darf der Zugang
  // nicht versehentlich ändern.
  for (const weg of ['/host', '/play', '/remote', '/editor', '/api/info', '/api/sets']) {
    assert.equal((await fetch(base + weg)).status, 200, weg);
  }
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.equal(info.schluessel, undefined, 'ohne Tunnel gibt es keine Schlüssel');
});

test('mit Tunnel kommt nur herein, wer einen Schlüssel mitbringt', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const { proc, base, host, spiel } = await starteOnline(3900 + Math.floor(Math.random() * 200), path.join(dir, 's.json'));
  t.after(async () => { proc.kill(); await rm(dir, { recursive: true, force: true }); });

  assert.ok(spiel && host && spiel !== host);

  // Ohne alles: verschlossen – und zwar auch für die Bausteine der Seiten.
  for (const weg of ['/host', '/play', '/remote', '/editor', '/style.css', '/api/info']) {
    assert.equal((await fetch(base + weg)).status, 403, weg);
  }

  // Mit Spielschlüssel: die Mitspielerseite, sonst nichts.
  assert.equal((await fetch(`${base}/play?k=${spiel}`)).status, 200);
  assert.equal((await fetch(`${base}/style.css?k=${spiel}`)).status, 200);
  assert.equal((await fetch(`${base}/host?k=${spiel}`)).status, 403, 'Spielschlüssel öffnet keine Hosttür');
  assert.equal((await fetch(`${base}/remote?k=${spiel}`)).status, 403);
  // Ein Fragensatz enthält die Lösungen – der gehört hinter dieselbe Tür.
  assert.equal((await fetch(`${base}/api/sets?k=${spiel}`)).status, 403);
  assert.equal((await fetch(`${base}/api/mix?k=${spiel}`)).status, 403);

  // Mit Hostschlüssel: alles.
  for (const weg of ['/host', '/remote', '/editor', '/play', '/api/sets']) {
    assert.equal((await fetch(`${base}${weg}?h=${host}`)).status, 200, weg);
  }
});

test('der Schlüssel aus dem QR-Code bleibt als Cookie am Handy', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const { proc, base, spiel } = await starteOnline(4100 + Math.floor(Math.random() * 200), path.join(dir, 's.json'));
  t.after(async () => { proc.kill(); await rm(dir, { recursive: true, force: true }); });

  // Gescannt wird einmal. Alles danach – Stylesheet, Skript, Neuladen – trägt
  // keinen Schlüssel mehr in der Adresse.
  const erste = await fetch(`${base}/play?k=${spiel}`);
  const keks = erste.headers.get('set-cookie');
  assert.match(keks || '', /qd_spiel=/);
  assert.match(keks || '', /HttpOnly/);

  const wert = /qd_spiel=([^;]+)/.exec(keks)[1];
  const zweite = await fetch(`${base}/player.js`, { headers: { cookie: `qd_spiel=${wert}` } });
  assert.equal(zweite.status, 200, 'mit Cookie geht es ohne Schlüssel in der Adresse weiter');
  assert.equal((await fetch(`${base}/host`, { headers: { cookie: `qd_spiel=${wert}` } })).status, 403);
});

test('die Host-Rolle wird nachgewiesen, nicht behauptet', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const { proc, base, host, spiel } = await starteOnline(4300 + Math.floor(Math.random() * 200), path.join(dir, 's.json'));
  t.after(async () => { proc.kill(); await rm(dir, { recursive: true, force: true }); });

  const alsWer = async (schluessel, art) => {
    const res = await fetch(`${base}/api/events?clientId=x_${Math.random()}&role=host&${art}=${schluessel}`);
    const reader = res.body.getReader();
    let buf = '';
    for (let i = 0; i < 40; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const treffer = /event: hello\ndata: (.*)\n\n/.exec(buf);
      if (treffer) { reader.cancel(); return JSON.parse(treffer[1]); }
    }
    throw new Error('kein hello empfangen');
  };

  // Wer nur den Spielschlüssel hat, darf sich role=host in die Adresse
  // schreiben, so viel er will – die Lösungen bekommt er trotzdem nicht.
  assert.equal((await alsWer(spiel, 'k')).isHost, false);
  assert.equal((await alsWer(host, 'h')).isHost, true);
});

test('die Tunneladresse steht vorn – der QR-Code nimmt die erste', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const { proc, base, host } = await starteOnline(4500 + Math.floor(Math.random() * 200), path.join(dir, 's.json'));
  t.after(async () => { proc.kill(); await rm(dir, { recursive: true, force: true }); });

  let urls = [];
  for (let i = 0; i < 60; i++) {
    urls = (await (await fetch(`${base}/api/info?h=${host}`)).json()).urls;
    if (urls[0]?.startsWith('https://')) break;
    await warte(50);
  }
  assert.match(urls[0], /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
});

test('kommt der Tunnel nicht hoch, läuft der Abend im Heimnetz weiter', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const { proc, base, host } = await starteOnline(4700 + Math.floor(Math.random() * 200), path.join(dir, 's.json'), {
    QUIZDUELL_TUNNEL_ATTRAPPE: 'stumm',
    QUIZDUELL_TUNNEL_TIMEOUT: '400',
  });
  t.after(async () => { proc.kill(); await rm(dir, { recursive: true, force: true }); });

  // Kein Tunnel, aber ein laufendes Spiel: Ein fehlender Tunnel darf nie der
  // Grund sein, dass gar nichts geht.
  const info = await (await fetch(`${base}/api/info?h=${host}`)).json();
  assert.ok(info.urls.length > 0);
  assert.ok(!info.urls.some((u) => u.startsWith('https://')));
  assert.equal((await fetch(`${base}/host?h=${host}`)).status, 200);
});

test('cloudflared darf seine Adresse auch nach stderr schreiben', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const { proc, base, host } = await starteOnline(4900 + Math.floor(Math.random() * 200), path.join(dir, 's.json'), {
    QUIZDUELL_TUNNEL_ATTRAPPE: 'stderr',
  });
  t.after(async () => { proc.kill(); await rm(dir, { recursive: true, force: true }); });

  let urls = [];
  for (let i = 0; i < 60; i++) {
    urls = (await (await fetch(`${base}/api/info?h=${host}`)).json()).urls;
    if (urls[0]?.startsWith('https://')) break;
    await warte(50);
  }
  assert.match(urls[0], /trycloudflare\.com$/);
});

test('der Bildschirm geht auf, bevor der Tunnel antwortet', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const { proc, base, host, ausgabe } = await starteOnline(5100 + Math.floor(Math.random() * 200), path.join(dir, 's.json'), {
    QUIZDUELL_TUNNEL_ATTRAPPE: 'langsam',
    QUIZDUELL_TUNNEL_TIMEOUT: '10000',
  });
  t.after(async () => { proc.kill(); await rm(dir, { recursive: true, force: true }); });

  // Erst auf den Tunnel zu warten hieße: ein leeres Browserfenster und ein
  // Host, der nicht weiß, ob noch etwas kommt. Die Lobby steht vorher.
  assert.equal((await fetch(`${base}/host?h=${host}`)).status, 200);
  const jetzt = await (await fetch(`${base}/api/info?h=${host}`)).json();
  assert.ok(!jetzt.urls.some((u) => u.startsWith('https://')), 'Tunnel ist noch gar nicht da');
  assert.ok(!/trycloudflare/.test(ausgabe()), 'und steht folglich auch nicht im Fenster');

  // … und wenn er dann kommt, holt der Host-Screen ihn sich beim Nachfragen ab.
  let urls = [];
  for (let i = 0; i < 100; i++) {
    urls = (await (await fetch(`${base}/api/info?h=${host}`)).json()).urls;
    if (urls[0]?.startsWith('https://')) break;
    await warte(100);
  }
  assert.match(urls[0], /trycloudflare\.com$/);
  assert.match(ausgabe(), /Der Tunnel steht/);
});

test('ein Neustart sperrt die Handys nicht aus', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const stateFile = path.join(dir, 's.json');
  const port = 5300 + Math.floor(Math.random() * 200);
  const erst = await starteOnline(port, stateFile);
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  // Mitten im Spiel stirbt der Server. Der Stand kommt zurück – die Schlüssel
  // müssen es auch, sonst steht auf der Leinwand ein QR-Code, den niemand mehr
  // scannen kann, und jedes Handy im Raum ist draußen.
  erst.proc.kill('SIGKILL');
  await warte(300);
  const wieder = await starteOnline(port, stateFile);
  t.after(() => wieder.proc.kill());

  assert.equal(wieder.host, erst.host, 'derselbe Hostschlüssel');
  assert.equal(wieder.spiel, erst.spiel, 'derselbe Spielschlüssel');
  assert.equal((await fetch(`${wieder.base}/play?k=${erst.spiel}`)).status, 200);
});

test('am nächsten Abend sind die Schlüssel neu', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-'));
  const stateFile = path.join(dir, 's.json');
  const port = 5500 + Math.floor(Math.random() * 200);
  const erst = await starteOnline(port, stateFile);
  erst.proc.kill('SIGKILL');
  await warte(300);
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  // Dieselbe Frist wie beim Spielstand: Was älter als zwölf Stunden ist, gehört
  // zu einem anderen Abend – und ein Schlüssel, der ewig gilt, ist keiner.
  const datei = path.join(dir, 's-zugang.json');
  const alt = JSON.parse(await readFile(datei, 'utf8'));
  alt.gespeichert = Date.now() - 13 * 60 * 60 * 1000;
  await writeFile(datei, JSON.stringify(alt), 'utf8');

  const wieder = await starteOnline(port, stateFile);
  t.after(() => wieder.proc.kill());
  assert.notEqual(wieder.host, erst.host);
  assert.equal((await fetch(`${wieder.base}/play?k=${erst.spiel}`)).status, 403, 'der alte Schlüssel öffnet nichts mehr');
});

test('geht der Buzzer erst in der Pause auf, fängt die Uhr bei null an', async (t) => {
  // Der Host darf in der Pause weiter werten – „Weiß nicht → Buzzer frei" geht
  // also mitten in der Pause. Wurde dann die volle Pausendauer aufgeschlagen,
  // lag der Beginn hinterher in der Zukunft: Die Uhr stand still, und der erste
  // Buzz maß eine negative Zeit. Als „schnellster Buzz des Abends" wäre die von
  // keinem ehrlichen Druck mehr zu unterbieten gewesen.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-uhrspaet-'));
  const port = 7700 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'uhrspaet-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  await host({ type: 'settings', settings: { buzzUhr: 20 } });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });

  await host({ type: 'pause', an: true });
  await warte(1200);
  await host({ type: 'pass' });        // Buzzer geht mitten in der Pause auf
  await host({ type: 'pause', an: false });

  const sofort = (await zustand(base)).current.buzzOffenMs;
  assert.ok(sofort >= 0 && sofort < 400, `die Uhr fängt bei null an, gemessen ${sofort} ms`);
  await warte(400);
  const spaeter = (await zustand(base)).current.buzzOffenMs;
  assert.ok(spaeter - sofort > 250, `und sie läuft auch, gemessen ${spaeter - sofort} ms in 400 ms`);

  // Der Rekord des Abends darf davon nichts abbekommen.
  const zust = await zustand(base);
  const blau = zust.teams[1].id;
  await host({ type: 'buzzFor', teamId: blau });
  const rekord = (await zustand(base)).rekorde?.schnellsterBuzz;
  assert.ok(!rekord || rekord.ms > 0, `kein negativer Rekord, gemessen ${JSON.stringify(rekord)}`);
});

test('die Pause überlebt ein Zurücknehmen – und springt nicht von selbst an', async (t) => {
  // Die Pause gehört zum Raum, nicht zum Spielzug. Wer in der Pause eine
  // Fehlwertung zurücknimmt – genau wozu sie da ist –, hob sie damit auf:
  // Feldwahl und Buzzer waren wieder scharf, während der Tisch in der Küche
  // stand. Und andersherum fror ein Rückschritt auf einen Schnappschuss aus
  // einer früheren Pause das laufende Spiel wieder ein.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-pauseundo-'));
  const port = 7900 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'pauseundo-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'judge', correct: true });      // aus Versehen

  await host({ type: 'pause', an: true });
  assert.equal((await zustand(base)).pause, true);
  await host({ type: 'undo' });
  const nachUndo = await zustand(base);
  assert.equal(nachUndo.pause, true, 'die Pause bleibt, wenn der Host in ihr etwas zurücknimmt');
  assert.equal(nachUndo.teams[0].score, 0, 'zurückgenommen wurde trotzdem');

  // Weiterspielen, dann eine Wertung aus der Pausenzeit zurücknehmen: Das darf
  // das Spiel nicht wieder einfrieren.
  await host({ type: 'pause', an: false });
  await host({ type: 'judge', correct: true });
  await host({ type: 'undo' });
  assert.equal((await zustand(base)).pause, false, 'und ein Rückschritt legt keine Pause ein');
});

test('ein kaputtes Cookie bekommt eine Antwort statt einer hängenden Leitung', async (t) => {
  // Die Türprüfung läuft vor allem anderen. Ein Wurf beim Entschlüsseln des
  // Cookies landete deshalb im Fänger für unbehandelte Zusagen: keine Antwort,
  // keine Fehlerseite, nur eine offene Verbindung – von außen auslösbar, ohne
  // jeden Schlüssel.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-keks-'));
  const { proc, base, host } = await starteOnline(8100 + Math.floor(Math.random() * 200), path.join(dir, 's.json'));
  t.after(async () => { proc.kill(); await rm(dir, { recursive: true, force: true }); });

  for (const keks of ['qd_spiel=%E4', 'qd_host=abc%', 'qd_spiel=%%%', 'qd_host=%C3%28']) {
    const antwort = await fetch(`${base}/play`, {
      headers: { cookie: keks },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(antwort.status, 403, `${keks} führt zur Tür, nicht ins Leere`);
  }
  // Und der gültige Schlüssel kommt daran vorbei, auch neben einem kaputten Keks.
  const gut = await fetch(`${base}/host?h=${host}`, {
    headers: { cookie: 'qd_spiel=%E4' },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(gut.status, 200);
});

test('in der Pause meldet die Sicht keinem Handy mehr, es dürfe buzzern', async (t) => {
  // Der Knopf auf dem Handy sagte „PAUSE" und feuerte trotzdem: voller
  // Buzz-Klang, Vibration, ein Zug an den Server – und als Antwort ein roter
  // Fehlerkasten. Der Riegel lag allein beim Server.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-pausebuzz-'));
  const port = 8300 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'pb-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  const teams = (await zustand(base)).teams;
  await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'pb-handy', role: 'player', type: 'joinTeam', teamId: teams[1].id, name: 'Bo' }),
  });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'pass' });

  const sicht = async () => {
    const res = await fetch(`${base}/api/events?clientId=pb-handy&role=player`);
    const reader = res.body.getReader();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const treffer = buf.match(/event: state\ndata: (.*)\n\n/);
      if (treffer) { reader.cancel(); return JSON.parse(treffer[1]); }
    }
    throw new Error('kein Zustand');
  };

  assert.equal((await sicht()).you.canBuzz, true, 'vor der Pause darf das Handy');
  await host({ type: 'pause', an: true });
  assert.equal((await sicht()).you.canBuzz, false, 'in der Pause nicht mehr');
  await host({ type: 'pause', an: false });
  assert.equal((await sicht()).you.canBuzz, true, 'und danach wieder');
});

test('die Punkte der nächsten Runde kommen vom Server, nicht aus einer Hochrechnung', async (t) => {
  // Der Host-Screen rechnete die nächste Runde aus dem laufenden Brett hoch.
  // Das stimmt nur, solange beide Runden gleich viele Kategorien haben – der
  // Editor erlaubt aber je Runde unabhängig zwei bis acht.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-halbzeit-'));
  const port = 8500 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const kat = (n) => ({
    name: n,
    questions: Array.from({ length: 4 }, (_, i) => ({ text: `Frage ${n}${i}`, answer: `A${i}` })),
  });
  const host = await alsHost(base, 'halbzeit-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({
    type: 'startGame',
    set: {
      name: 'Ungleiche Runden',
      rounds: [
        { categories: Array.from({ length: 6 }, (_, i) => kat(`K${i}`)) },
        { categories: [kat('A'), kat('B')] },
      ],
    },
  });

  // Runde 2 hat zwei Kategorien: 2 × (100+200+300+500) × 2 = 4400.
  const jetzt = await zustand(base);
  assert.equal(jetzt.naechsteSumme, 4400, 'die Summe der nächsten Runde, nicht die hochgerechnete des Bretts');
  const hochgerechnet = jetzt.board.categories
    .reduce((n, c) => n + c.cells.reduce((m, z) => m + z.value, 0), 0) * 2;
  assert.equal(hochgerechnet, 13200, 'so falsch war die alte Rechnung');
});

test('ein Stechen, das ein „Neues Spiel“ überholt, hinterlässt keinen Geisterzustand', async (t) => {
  // `stechen` liest den Spielzustand und wartet dann darauf, dass die
  // Fragensätze von der Platte kommen. Stand das Warten in der Argumentliste,
  // war der Zustand schon gelesen – und ein gleichzeitiges „Neues Spiel“ oder
  // „Zurücknehmen“ ersetzt genau dieses Objekt. Das Stechen arbeitete dann auf
  // einem abgehängten Zustand, meldete trotzdem Erfolg, und sein Schnappschuss
  // landete auf einem Rückweg, den „Neues Spiel“ gerade geleert hatte: Ein
  // „Zurücknehmen“ holte danach das beendete Spiel zurück.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-stechrennen-'));
  const port = 8700 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'stechrennen-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });

  // Brett leerspielen, ohne zu werten: Am Ende steht es 0:0, also Gleichstand.
  const board = (await zustand(base)).board;
  for (let runde = 0; runde < 2; runde++) {
    for (let c = 0; c < board.categories.length; c++) {
      for (let r = 0; r < 4; r++) {
        await host({ type: 'pick', catIdx: c, rowIdx: r });
        await host({ type: 'endQuestion' });
        await host({ type: 'close' });
      }
    }
    if (runde === 0) await host({ type: 'nextRound' });
  }
  assert.equal((await zustand(base)).phase, 'gameOver');

  // Beide Züge in derselben Sekunde – der eine vom Host-Screen, der andere von
  // der Fernbedienung.
  await Promise.all([host({ type: 'stechen' }), host({ type: 'backToLobby' })]);
  const danach = await zustand(base);
  if (danach.phase === 'lobby') {
    assert.equal(danach.rueckwegTiefe, 0,
      `„Neues Spiel“ hat den Rückweg geleert – dort darf nichts mehr liegen (${danach.rueckgaengig})`);
  } else {
    assert.equal(danach.phase, 'question', 'sonst läuft das Stechen – aber dann richtig');
    assert.ok(danach.current?.stechen);
  }
});

test('kein Handy handelt für ein fremdes Gerät', async (t) => {
  // Die Gerätekennung steht in jeder Sicht neben dem Namen – der Host braucht
  // sie, um eine Karteileiche zu entfernen. Ohne Nachweis konnte damit jedes
  // Handy für ein anderes buzzern, es aus seinem Team werfen oder es woanders
  // eintragen: ein einziger POST mit fremder Kennung.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-fremd-'));
  const port = 8900 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'fremd-host');
  for (const name of ['Rot', 'Blau', 'Grün']) await host({ type: 'addTeam', name });
  const teams = (await zustand(base)).teams;

  const anna = await verbinde(base, 'handy-anna', 'player');
  const bea = await verbinde(base, 'handy-bea', 'player');
  await warte(150);
  await anna.tu({ type: 'joinTeam', teamId: teams[0].id, name: 'Anna' });
  await bea.tu({ type: 'joinTeam', teamId: teams[1].id, name: 'Bea' });

  // Die Kennung steht offen in der Sicht – genau daraus bestand der Angriff.
  const sicht = await zustand(base);
  assert.ok(sicht.teams[0].members.some((m) => m.clientId === 'handy-anna'),
    'die Kennung steht weiterhin in der Sicht');

  const alsWer = (clientId, geheim, body) => fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, geheim, role: 'player', ...body }),
  }).then((r) => r.json());

  // Bea versucht, Anna aus ihrem Team zu werfen – mit Annas Kennung.
  const rauswurf = await alsWer('handy-anna', bea.geheim, { type: 'leaveTeam' });
  assert.equal(rauswurf.ok, false);
  assert.match(rauswurf.error, /gehört jemand anderem/);
  assert.ok((await zustand(base)).teams[0].members.some((m) => m.clientId === 'handy-anna'),
    'Anna steht noch in ihrem Team');

  // Und ohne jeden Nachweis geht es genauso wenig.
  assert.equal((await alsWer('handy-anna', undefined, { type: 'leaveTeam' })).ok, false);

  // Der Buzz für ein fremdes Team ebenfalls nicht.
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'pass' });
  const fremderBuzz = await alsWer('handy-anna', bea.geheim, { type: 'buzz' });
  assert.equal(fremderBuzz.ok, false, 'ein Buzz im Namen eines anderen Geräts');

  // Mit dem eigenen Nachweis geht alles wie immer.
  const eigener = await bea.tu({ type: 'buzz' });
  assert.equal(eigener.ok, true, eigener.error || '');
  assert.equal((await zustand(base)).current.buzzedTeamId, teams[1].id);
});

test('eine Kennung, die der Server nicht kennt, wird nicht ausgesperrt', async (t) => {
  // Nachsicht mit Absicht: Nach einem Serverneustart mitten im Spiel hat der
  // Server keine Geheimnisse mehr. Stünde dann jedes Handy vor einer Absage,
  // wäre die Sicherung schlimmer als die Lücke – und zu gewinnen ist dabei
  // nichts, denn eine frei erfundene Kennung gehört ohnehin niemandem.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-neuling-'));
  const port = 9100 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'neuling-host');
  await host({ type: 'addTeam', name: 'Rot' });
  const team = (await zustand(base)).teams[0];

  // Ein Handy, das noch nie einen Ereignisstrom hatte – so wie jedes Handy in
  // der Sekunde, in der es beitritt.
  const ohneStrom = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'ganz-neu', role: 'player', type: 'joinTeam', teamId: team.id, name: 'Neu' }),
  }).then((r) => r.json());
  assert.equal(ohneStrom.ok, true, ohneStrom.error || '');
});

test('die Geheimnisse der Geräte wachsen nicht ins Unendliche', async (t) => {
  // Jeder neue Ereignisstrom legt eine Kennung an – über den Tunnel kann den
  // jeder öffnen, der den Spielschlüssel hat. Der Deckel darf dabei niemanden
  // aussperren, der wirklich mitspielt.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-geheimzahl-'));
  const port = 9300 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  t.after(async () => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const host = await alsHost(base, 'geheimzahl-host');
  for (const name of ['Rot', 'Blau']) await host({ type: 'addTeam', name });
  // Mira sitzt im zweiten Team – das erste ist am Zug, sie darf also buzzern.
  const team = (await zustand(base)).teams[1];
  const mira = await verbinde(base, 'mira', 'player');
  await warte(150);
  assert.equal((await mira.tu({ type: 'joinTeam', teamId: team.id, name: 'Mira' })).ok, true);

  // 400 Wegwerf-Kennungen, doppelt so viele wie der Deckel erlaubt.
  for (let i = 0; i < 400; i++) {
    const c = new AbortController();
    fetch(`${base}/api/events?clientId=wegwerf-${i}&role=player`, { signal: c.signal })
      .then((r) => r.body.getReader().read())
      .catch(() => {});
    await warte(1);
    c.abort();
  }
  await warte(400);

  // Mira spielt weiter: Sie ist verbunden und steht in einem Team.
  await host({ type: 'startGame', file: 'beispiel-spieleabend.json' });
  await host({ type: 'pick', catIdx: 0, rowIdx: 0 });
  await host({ type: 'pass' });

  // Das ist die eigentliche Probe. Wäre Miras Geheimnis beim Aufräumen
  // mitgegangen, würde ihre Kennung wieder als „unbekannt" durchgehen – und
  // ein fremdes Handy könnte für sie buzzern. Ein Aussperren wäre dagegen gar
  // nicht zu sehen, weil eine unbekannte Kennung absichtlich durchkommt.
  const fremd = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'mira', geheim: 'nicht-ihrs', role: 'player', type: 'buzz' }),
  }).then((r) => r.json());
  assert.equal(fremd.ok, false, 'Miras Kennung ist weiter geschützt');
  assert.match(fremd.error, /gehört jemand anderem/);

  // Und sie selbst kommt durch.
  const gebuzzert = await mira.tu({ type: 'buzz' });
  assert.equal(gebuzzert.ok, true, gebuzzert.error || '');

  // Der Server steht noch.
  assert.equal((await fetch(`${base}/api/info`)).status, 200);
});

test('ein umbenannter Satz überschreibt nicht den geladenen', async (t) => {
  // Der Editor merkt sich, aus welcher Datei ein Satz kam – sonst legte ein
  // Neuladen der Seite eine zweite Datei an. Wer einen Satz aber lädt,
  // umbenennt und speichert, will seine eigene Fassung: Dort muss der Name
  // gewinnen. Diese Regel steht im Editor; hier wird gehalten, dass der Server
  // beide Wege sauber trennt und nichts stillschweigend überschreibt.
  const dir = await mkdtemp(path.join(tmpdir(), 'quizduell-umbenannt-'));
  const port = 9500 + Math.floor(Math.random() * 200);
  const { proc, base } = await starteServer(port, path.join(dir, 'stand.json'));
  const angelegt = [];
  t.after(async () => {
    proc.kill('SIGKILL');
    const { unlink } = await import('node:fs/promises');
    for (const f of angelegt) await unlink(new URL(f, DATEN_URL)).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const speichere = (datei, name, overwrite = false) => fetch(`${base}/api/sets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: datei, overwrite, set: { name, rounds: SATZ.rounds } }),
  }).then((r) => r.json());

  // Neu anlegen geht ohne Rückfrage.
  const neu = await speichere('umbenannt-test.json', 'Umbenannt Test');
  assert.equal(neu.ok, true, neu.error || '');
  angelegt.push('umbenannt-test.json');

  // Dieselbe Datei ein zweites Mal: Der Server fragt zurück, statt einfach zu
  // überschreiben – darauf baut die Rückfrage im Editor.
  const nochmal = await speichere('umbenannt-test.json', 'Umbenannt Test');
  assert.equal(nochmal.ok, false);
  assert.equal(nochmal.exists, true, 'der Server meldet die vorhandene Datei');

  // Und mit ausdrücklichem Ja geht es durch.
  const mitJa = await speichere('umbenannt-test.json', 'Umbenannt Test', true);
  assert.equal(mitJa.ok, true, mitJa.error || '');
});
