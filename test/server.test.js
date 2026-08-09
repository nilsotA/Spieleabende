import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Integrationstests gegen den laufenden Server: Sie decken ab, was reine
// Logiktests nicht können – Verbindungen, Rollen, Abstürze und Neustarts.

const SERVER = fileURLToPath(new URL('../server/index.js', import.meta.url));
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

/** Startet einen Server auf eigenem Port mit eigenem Spielstand-Pfad. */
async function starteServer(port, stateFile) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), QUIZDUELL_STATE_FILE: stateFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/api/info`);
      if (res.ok) return { proc, base };
    } catch {
      /* noch nicht oben */
    }
    await warte(50);
  }
  proc.kill('SIGKILL');
  throw new Error('Server startet nicht');
}

/** Öffnet eine Host-Verbindung und liefert eine Funktion zum Absenden von Aktionen. */
async function alsHost(base, id) {
  const res = await fetch(`${base}/api/events?clientId=${id}&role=host`);
  res.body.getReader().read();
  await warte(200);
  return (body) =>
    fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: id, ...body }),
    }).then((r) => r.json());
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
  const res = await fetch(`${base}/api/events?clientId=g2&role=player`);
  res.body.getReader().read();
  await warte(200);
  const gebuzzert = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'g2', type: 'buzz' }),
  }).then((r) => r.json());

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
  const spieler = await fetch(`${base}/api/events?clientId=irgendein-handy&role=player`);
  spieler.body.getReader().read();
  await warte(200);

  const frech = await anmaßen('irgendein-handy');
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
  assert.equal(z.rueckgaengig, null, 'nur eine Stufe');

  // Und danach lässt sich normal weiterspielen: diesmal falsch.
  await host({ type: 'judge', correct: false });
  z = await zustand(base);
  assert.equal(z.teams[0].score, 0);
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
