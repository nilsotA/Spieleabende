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
      const res = await fetch(`${base}/api/events?clientId=${clientId}&role=player`);
      const reader = res.body.getReader();
      reader.read(); // Strom offen halten
      stroeme.push({ clientId, reader });
      geraete.push({ clientId, teamId: team.id });
    }
  }
  await warte(300);
  for (const g of geraete) {
    await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: g.clientId, role: 'player', type: 'joinTeam', teamId: g.teamId, name: g.clientId }),
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
  const gebuzzert = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'handy-3-1', role: 'player', type: 'buzz' }),
  }).then((r) => r.json());
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
      body: JSON.stringify({ clientId: 'abend', role: 'host', ...body }),
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
  const strom = await fetch(`${base}/api/events?clientId=mira&role=player`);
  const miraLiest = strom.body.getReader();
  miraLiest.read();
  await warte(200);
  const alsSpieler = (id, body) => fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: id, ...body }),
  }).then((r) => r.json());
  assert.equal((await alsSpieler('mira', { type: 'joinTeam', teamId: team.id, name: 'Mira' })).ok, true);

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
    const res = await fetch(`${base}/api/events?clientId=${id}&role=${rolle}`);
    const r = res.body.getReader();
    r.read();
    offen.push(r);
    await warte(150);
    return r;
  };

  const host = await alsHost(base, 'warte-host');
  await host({ type: 'addTeam', name: 'Rot' });
  await host({ type: 'addTeam', name: 'Blau' });
  assert.equal((await zustand(base)).wartende, 0, 'am Anfang wartet niemand');

  // Zwei Gäste haben gescannt, aber noch kein Team gewählt.
  await strom('gast1', 'player');
  await strom('gast2', 'player');
  assert.equal((await zustand(base)).wartende, 2);

  // Zwei Tabs auf demselben Handy sind ein Gerät, nicht zwei.
  await strom('gast2', 'player');
  assert.equal((await zustand(base)).wartende, 2, 'gezählt werden Geräte, nicht Verbindungen');

  // Die Fernbedienung des Hosts wartet auf nichts.
  await strom('host-handy', 'host');
  assert.equal((await zustand(base)).wartende, 2);

  // Einer tritt bei.
  const teams = (await zustand(base)).teams;
  await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'gast1', type: 'joinTeam', teamId: teams[0].id, name: 'Mira' }),
  });
  assert.equal((await zustand(base)).wartende, 1);

  // Spieler bekommen die Zahl nicht – sie ist eine Host-Angabe.
  assert.equal((await zustand(base, false)).wartende, undefined);
});
