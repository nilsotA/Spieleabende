import test from 'node:test';
import assert from 'node:assert/strict';

import { starteOnlineLokal } from '../server/online-lokal.js';
import { speicherImArbeitsspeicher, speicherUpstash } from '../server/speicher.js';
import { starteRedisShim } from './hilfen/redis-shim.js';

/*
 * Das Spiel im Netz: Räume statt eines Laptops.
 *
 * Geprüft wird über echte HTTP-Anfragen gegen denselben Code, der auf Vercel
 * läuft – nur mit dem Speicher im Arbeitsspeicher. Jede Anfrage steht für
 * sich; zwischen zweien bleibt nichts im Prozess stehen außer dem Speicher.
 *
 * Jeder Test läuft zweimal: einmal mit dem Speicher im Arbeitsspeicher und –
 * wenn auf dem Rechner ein redis-server liegt – einmal über die
 * Upstash-Schnittstelle gegen echtes Redis, samt Lua-Skript. Das ist der Weg,
 * den die veröffentlichte Fassung nimmt.
 */

const shim = await starteRedisShim();
test.after(() => shim?.zu());

const ARTEN = [
  ['Arbeitsspeicher', (jetzt) => speicherImArbeitsspeicher({ jetzt })],
  ...(shim ? [['Redis', (jetzt) => speicherUpstash({ url: shim.url, token: shim.token, jetzt })]] : []),
];
/** Meldet einen Test für jede Speicherart an. */
function pruefe(name, fn) {
  for (const [art, baue] of ARTEN) test(`${name} [${art}]`, (t) => fn(t, baue));
}

async function umgebung(t, baue, { uhr } = {}) {
  const jetzt = uhr ? () => uhr.zeit : undefined;
  const speicher = baue(jetzt);
  const starte = async () => {
    const server = await starteOnlineLokal({ port: 0, speicher, jetzt });
    t.after(() => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    }));
    return `http://localhost:${server.address().port}`;
  };
  const base = await starte();
  // Eine zweite Funktionsinstanz über demselben Speicher – auf Vercel kann
  // jede Anfrage auf einer anderen Maschine landen.
  let zweite = null;
  const andereInstanz = async () => (zweite ??= await starte());

  const holeJson = async (pfad, opt, wo = base) => {
    const res = await fetch(wo + pfad, opt);
    return { status: res.status, daten: await res.json().catch(() => null) };
  };
  const neuerRaum = async () => (await holeJson('/api/raum', { method: 'POST' })).daten;

  /** Ein Gerät: merkt sich Kennung, Geheimnis und letzten Stand wie der Browser. */
  function geraet(id, { k, h, wo = base } = {}) {
    const rolle = h ? 'host' : 'player';
    const g = { id, geheim: undefined, nummer: null };
    g.stand = async ({ puls = false, seit = false, warte = 0, takt = 0 } = {}) => {
      const q = new URLSearchParams({ clientId: id, role: rolle });
      if (h) q.set('h', h);
      if (k) q.set('k', k);
      if (puls) q.set('puls', '1');
      if ((seit || warte) && g.nummer != null) q.set('seit', String(g.nummer));
      if (warte) q.set('warte', String(warte));
      if (takt) q.set('takt', String(takt));
      const { status, daten } = await holeJson(`/api/state?${q}`, undefined, wo);
      if (daten?.geheim) g.geheim = daten.geheim;
      if (typeof daten?.nummer === 'number') g.nummer = daten.nummer;
      return { status, ...daten };
    };
    g.tu = async (type, mehr = {}) => (await holeJson('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...mehr, type, role: rolle, clientId: id, geheim: g.geheim, h, k }),
    }, wo)).daten;
    return g;
  }
  return { base, holeJson, neuerRaum, geraet, speicher, andereInstanz };
}

pruefe('ein Raum entsteht, und nur sein Host-Schlüssel führt ihn', async (t, baue) => {
  const { holeJson, neuerRaum, geraet } = await umgebung(t, baue);
  const raum = await neuerRaum();
  assert.match(raum.k, /^[A-HJ-NP-Z]{4}$/, 'vier Buchstaben, ohne I und O');
  assert.ok(raum.h.startsWith(`${raum.k}.`), 'der Host-Schlüssel nennt seinen Raum');

  const host = geraet('c_host', { h: raum.h });
  const erste = await host.stand({ puls: true });
  assert.equal(erste.status, 200);
  assert.equal(erste.phase, 'lobby');
  assert.equal(erste.raum, raum.k);
  assert.equal(erste.rueckwegTiefe, 0, 'der Host bekommt die Host-Sicht');
  assert.equal((await host.tu('addTeam', { name: 'Rot' })).ok, true);

  // Ein Gast mit dem Raumcode sieht das Spiel, darf es aber nicht führen.
  const gast = geraet('c_gast', { k: raum.k });
  const sicht = await gast.stand({ puls: true });
  assert.equal(sicht.teams.length, 1);
  assert.equal(sicht.rueckwegTiefe, undefined, 'keine Host-Sicht für Gäste');
  const frech = await gast.tu('addTeam', { name: 'Gelb' });
  assert.equal(frech.ok, false);
  assert.match(frech.error, /Nur der Host/);

  // Ein erfundener Host-Schlüssel für denselben Raum hilft nicht.
  const falsch = geraet('c_falsch', { h: `${raum.k}.gibtsnicht` });
  assert.equal((await falsch.tu('addTeam', { name: 'Gelb' })).ok, false);
  assert.equal((await falsch.stand()).rueckwegTiefe, undefined);

  // Und einen Raum, den es nicht gibt, gibt es nicht.
  const fremd = geraet('c_fremd', { k: 'ZZZZ' });
  const nichts = await fremd.stand();
  assert.equal(nichts.status, 404);
  assert.equal(nichts.keinRaum, true);
  assert.equal((await holeJson('/api/info')).daten.raeume, true);
});

pruefe('zwei Räume wissen nichts voneinander', async (t, baue) => {
  const { neuerRaum, geraet } = await umgebung(t, baue);
  const a = await neuerRaum();
  const b = await neuerRaum();
  assert.notEqual(a.k, b.k);
  const hostA = geraet('c_a', { h: a.h });
  const hostB = geraet('c_b', { h: b.h });
  await hostA.tu('addTeam', { name: 'Nur in A' });
  assert.equal((await hostA.stand()).teams.length, 1);
  assert.equal((await hostB.stand()).teams.length, 0);
});

pruefe('nachfragen kostet nichts, solange sich nichts tut', async (t, baue) => {
  const { neuerRaum, geraet } = await umgebung(t, baue);
  const raum = await neuerRaum();
  const host = geraet('c_host', { h: raum.h });
  const gast = geraet('c_gast', { k: raum.k });
  await gast.stand({ puls: true });
  await gast.stand(); // holt das Geheimnis ab, falls die erste Antwort es anlegte

  const still = await gast.stand({ seit: true });
  assert.equal(still.unveraendert, true, 'nichts Neues – nur die Nummer kommt zurück');
  assert.equal(still.teams, undefined);

  await host.stand({ puls: true });
  await host.tu('addTeam', { name: 'Rot' });
  const neu = await gast.stand({ seit: true });
  assert.equal(neu.unveraendert, undefined);
  assert.equal(neu.teams.length, 1, 'nach einer Änderung kommt der ganze Stand');
});

pruefe('ein ganzer Spielzug im Raum: aufrufen, buzzern, werten, zurücknehmen', async (t, baue) => {
  const { neuerRaum, geraet } = await umgebung(t, baue);
  const raum = await neuerRaum();
  const host = geraet('c_host', { h: raum.h });
  await host.stand({ puls: true });
  for (const name of ['Rot', 'Blau']) await host.tu('addTeam', { name });
  const teams = (await host.stand()).teams;

  const anna = geraet('c_anna', { k: raum.k });
  const bert = geraet('c_bert', { k: raum.k });
  for (const [g, team, name] of [[anna, teams[0], 'Anna'], [bert, teams[1], 'Bert']]) {
    await g.stand({ puls: true });
    await g.stand();
    assert.equal((await g.tu('joinTeam', { teamId: team.id, name })).ok, true);
  }

  assert.equal((await host.tu('startGame', { file: 'beispiel-spieleabend.json' })).ok, true);
  assert.equal((await host.tu('pick', { catIdx: 0, rowIdx: 0 })).ok, true);
  let stand = await host.stand();
  assert.equal(stand.current.step, 'primary');
  assert.ok(stand.current.answer, 'der Host sieht die Lösung');
  assert.equal((await anna.stand()).current.answer, null, 'das Handy nicht');
  assert.equal(stand.rueckgaengig, 'Feldwahl');

  // Zugteam weiß es nicht → Buzzer frei → Bert drückt.
  await host.tu('pass');
  assert.equal((await bert.tu('buzz')).ok, true);
  stand = await host.stand();
  assert.equal(stand.current.buzzedTeamId, teams[1].id);
  const buzzSignal = stand.signale.find((s) => s.name === 'buzz');
  assert.equal(buzzSignal.daten.teamId, teams[1].id, 'der Buzz kommt als Signal mit – für den Ton auf der Leinwand');

  await host.tu('judge', { correct: true });
  stand = await host.stand();
  assert.equal(stand.teams[1].score, 50, 'gebuzzert und richtig: die Hälfte');
  assert.equal(stand.teams[0].score, -50, '„weiß nicht" kostet das Zugteam die Hälfte');

  // Der Rückweg liegt getrennt vom Raum und übersteht die einzelnen Anfragen.
  assert.ok(stand.rueckwegTiefe >= 4);
  assert.equal((await host.tu('undo')).ok, true);
  assert.equal((await host.stand()).teams[1].score, 0, 'die Wertung ist zurückgenommen');
  await host.tu('undo'); // der Buzz
  await host.tu('undo'); // „weiß nicht"
  stand = await host.stand();
  assert.equal(stand.current.step, 'primary');
  assert.equal(stand.teams[0].score, 0);
});

pruefe('zwei Handys buzzern im selben Augenblick – genau eines gewinnt', async (t, baue) => {
  const { neuerRaum, geraet } = await umgebung(t, baue);
  const raum = await neuerRaum();
  const host = geraet('c_host', { h: raum.h });
  await host.stand({ puls: true });
  for (const name of ['Rot', 'Blau', 'Gelb']) await host.tu('addTeam', { name });
  const teams = (await host.stand()).teams;
  const handys = [];
  for (const [i, name] of ['Anna', 'Bert', 'Cora'].entries()) {
    const g = geraet(`c_${name}`, { k: raum.k });
    await g.stand({ puls: true });
    await g.stand();
    await g.tu('joinTeam', { teamId: teams[i].id, name });
    handys.push(g);
  }
  await host.tu('startGame', { file: 'beispiel-spieleabend.json' });
  await host.tu('pick', { catIdx: 0, rowIdx: 0 });
  await host.tu('pass');

  const antworten = await Promise.all([handys[1].tu('buzz', { quiet: true }), handys[2].tu('buzz', { quiet: true })]);
  assert.equal(antworten.filter((a) => a.ok).length, 1, `genau ein Buzz geht durch: ${JSON.stringify(antworten)}`);
  const stand = await host.stand();
  assert.ok([teams[1].id, teams[2].id].includes(stand.current.buzzedTeamId));
});

pruefe('niemand handelt für ein fremdes Handy', async (t, baue) => {
  const { neuerRaum, geraet } = await umgebung(t, baue);
  const raum = await neuerRaum();
  const host = geraet('c_host', { h: raum.h });
  await host.stand({ puls: true });
  await host.tu('addTeam', { name: 'Rot' });
  const team = (await host.stand()).teams[0];
  const anna = geraet('c_anna', { k: raum.k });
  await anna.stand({ puls: true });
  await anna.stand();
  assert.ok(anna.geheim, 'Anna hat ihr Geheimnis bekommen');
  await anna.tu('joinTeam', { teamId: team.id, name: 'Anna' });

  // Bert kennt Annas Kennung aus dem Spielstand – ihr Geheimnis bekommt er nicht.
  const dieb = geraet('c_anna', { k: raum.k });
  const sicht = await dieb.stand();
  assert.equal(sicht.geheim, undefined, 'vorgezeigte Geheimnisse gibt der Server nicht mehr heraus');
  const raus = await dieb.tu('leaveTeam');
  assert.equal(raus.ok, false);
  assert.match(raus.error, /gehört jemand anderem/);
  assert.equal((await host.stand()).teams[0].members.length, 1);
});

pruefe('wer sich nicht mehr meldet, gilt als weg – und ist wieder da, wenn er sich meldet', async (t, baue) => {
  const uhr = { zeit: Date.now() };
  const { neuerRaum, geraet } = await umgebung(t, baue, { uhr });
  const raum = await neuerRaum();
  const host = geraet('c_host', { h: raum.h });
  await host.stand({ puls: true });
  await host.tu('addTeam', { name: 'Rot' });
  const team = (await host.stand()).teams[0];

  const anna = geraet('c_anna', { k: raum.k });
  await anna.stand({ puls: true });
  assert.equal((await host.stand({ puls: true })).wartende, 1, 'ein Handy wartet noch ohne Team');
  await anna.stand();
  await anna.tu('joinTeam', { teamId: team.id, name: 'Anna' });
  let stand = await host.stand({ puls: true });
  assert.equal(stand.wartende, 0);
  assert.equal(stand.teams[0].members[0].online, true);

  // Annas Handy schläft ein; der Host meldet sich weiter.
  uhr.zeit += 40000;
  stand = await host.stand({ puls: true });
  assert.equal(stand.teams[0].members[0].online, false, 'nach 40 stillen Sekunden gilt Anna als weg');

  uhr.zeit += 5000;
  await anna.stand({ puls: true });
  stand = await host.stand({ puls: true });
  assert.equal(stand.teams[0].members[0].online, true, 'und mit der nächsten Meldung ist sie wieder da');
});

pruefe('nach zwölf stillen Stunden fängt der Raum leer an, das Gedächtnis bleibt', async (t, baue) => {
  const uhr = { zeit: Date.now() };
  const { neuerRaum, geraet } = await umgebung(t, baue, { uhr });
  const raum = await neuerRaum();
  const host = geraet('c_host', { h: raum.h });
  await host.stand({ puls: true });
  for (const name of ['Rot', 'Blau']) await host.tu('addTeam', { name });
  await host.tu('startGame', { file: 'beispiel-spieleabend.json' });
  await host.tu('pick', { catIdx: 0, rowIdx: 0 });
  assert.equal((await host.stand()).gemerkt, 1, 'die angespielte Kategorie ist gemerkt');

  uhr.zeit += 13 * 60 * 60 * 1000;
  const morgen = await host.stand({ puls: true });
  assert.equal(morgen.phase, 'lobby');
  assert.equal(morgen.teams.length, 0);
  assert.equal(morgen.rueckwegTiefe, 0);
  assert.equal(morgen.gemerkt, 1, 'was gespielt wurde, weiß der Raum noch');
  assert.equal((await host.tu('addTeam', { name: 'Neu' })).ok, true, 'derselbe Host-Schlüssel gilt weiter');
});

pruefe('Fragensätze und Bilddateien kommen auch im Netz', async (t, baue) => {
  const { base, holeJson } = await umgebung(t, baue);
  const saetze = (await holeJson('/api/sets')).daten;
  assert.ok(saetze.length >= 20);
  const satz = (await holeJson('/api/set?file=laender-flaggen.json')).daten;
  const bildfrage = satz.rounds.flatMap((r) => r.categories).flatMap((c) => c.questions).find((q) => q.image);
  assert.match(bildfrage.image, /^\/bilder\//);
  const bild = await fetch(base + bildfrage.image);
  assert.equal(bild.status, 200);
  assert.match(bild.headers.get('content-type'), /^image\//);
  // Dieselbe Datei über die Adresse, die Vercel nach der Umschreibung ruft.
  const name = bildfrage.image.slice('/bilder/'.length);
  assert.equal((await fetch(`${base}/api/datei?name=${encodeURIComponent(name)}`)).status, 200);
  assert.equal((await fetch(`${base}/api/datei?name=..%2Fanpfiff.json`)).status, 404, 'kein Weg aus dem Bilderordner');

  const speichern = await holeJson('/api/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(speichern.daten.ok, false);
  assert.match(speichern.daten.error, /Datei/);
});

pruefe('ein selbst geladener Satz bringt seine eingebetteten Bilder mit', async (t, baue) => {
  // Am Laptop liegen sie im Arbeitsspeicher des Servers. Im Netz gibt es den
  // nicht – sie wandern in den Speicher und kommen unter einer eigenen Adresse
  // zurück, die jedes Gerät des Raums abrufen kann.
  const { base, neuerRaum, geraet } = await umgebung(t, baue);
  const raum = await neuerRaum();
  const host = geraet('c_host', { h: raum.h });
  await host.stand({ puls: true });
  for (const name of ['Rot', 'Blau']) await host.tu('addTeam', { name });

  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const satz = {
    name: 'Mit Bild',
    rounds: [{
      categories: Array.from({ length: 2 }, (_, c) => ({
        name: `K${c}`,
        questions: Array.from({ length: 4 }, (_, i) => ({
          text: `Frage ${c}-${i}`, answer: `Antwort ${c}-${i}`, image: c === 0 && i === 0 ? pixel : null,
        })),
      })),
    }],
  };
  assert.equal((await host.tu('startGame', { set: satz })).ok, true);
  await host.tu('pick', { catIdx: 0, rowIdx: 0 });
  const bildAdresse = (await host.stand()).current.image;
  assert.match(bildAdresse, /^\/api\/bild\?id=b[0-9a-f]+$/, 'die Adresse kommt ohne Unterpfad – so ruft Vercel sie auf');

  const bild = await fetch(`${base}${bildAdresse}&k=${raum.k}`);
  assert.equal(bild.status, 200);
  assert.equal(bild.headers.get('content-type'), 'image/png');
  assert.ok((await bild.arrayBuffer()).byteLength > 20);
  // In einem anderen Raum gibt es dieses Bild nicht.
  const fremd = await neuerRaum();
  assert.equal((await fetch(`${base}${bildAdresse}&k=${fremd.k}`)).status, 404);
});

/* ------------------------------------------------- Ohne spürbare Verzögerung */

const SATZ = {
  name: 'Klein',
  rounds: [{
    categories: Array.from({ length: 2 }, (_, c) => ({
      name: `K${c}`,
      questions: Array.from({ length: 4 }, (_, i) => ({ text: `Frage ${c}-${i}`, answer: `Antwort ${c}-${i}` })),
    })),
  }],
};

/** Raum mit zwei Teams, je einem Handy, und laufendem Spiel. */
async function spielbereit(u, { woGaeste } = {}) {
  const raum = await u.neuerRaum();
  const host = u.geraet('c_host', { h: raum.h });
  await host.stand({ puls: true });
  const teams = [];
  for (const name of ['Rot', 'Blau']) {
    await host.tu('addTeam', { name });
  }
  const sicht = await host.stand();
  const handys = [];
  for (const [i, name] of ['Anna', 'Bert'].entries()) {
    const handy = u.geraet(`c_${name}`, { k: raum.k, wo: woGaeste });
    await handy.stand({ puls: true });
    await handy.stand();
    assert.equal((await handy.tu('joinTeam', { name, teamId: sicht.teams[i].id })).ok, true);
    await handy.stand();
    handys.push(handy);
    teams.push(sicht.teams[i].id);
  }
  assert.equal((await host.tu('startGame', { set: SATZ })).ok, true);
  await host.stand();
  for (const handy of handys) await handy.stand();
  return { raum, host, handys, teams };
}

pruefe('eine Nachfrage bleibt liegen und kommt in dem Augenblick zurück, in dem sich etwas tut', async (t, baue) => {
  const u = await umgebung(t, baue);
  const { host, handys: [anna] } = await spielbereit(u);

  // Nichts geschieht: Die Antwort kommt erst nach der erbetenen Wartezeit.
  let los = Date.now();
  const still = await anna.stand({ warte: 400 });
  assert.equal(still.unveraendert, true);
  assert.ok(Date.now() - los >= 350, `blieb ${Date.now() - los} ms liegen`);

  // Jemand handelt: Die liegende Frage wird sofort beantwortet – lange bevor
  // sie selbst im Speicher nachgesehen hätte (takt) oder abgelaufen wäre.
  los = Date.now();
  const offen = anna.stand({ warte: 8000, takt: 5000 });
  await new Promise((r) => setTimeout(r, 100));
  const vorZug = Date.now();
  assert.equal((await host.tu('pick', { catIdx: 0, rowIdx: 0 })).ok, true);
  const neu = await offen;
  assert.equal(neu.phase, 'question', 'der neue Stand kommt mit');
  assert.ok(Date.now() - vorZug < 1500, `kam ${Date.now() - vorZug} ms nach dem Zug`);

  // Wer mit einem veralteten Stand fragt, wartet gar nicht.
  anna.nummer -= 1;
  los = Date.now();
  assert.equal((await anna.stand({ warte: 8000 })).phase, 'question');
  assert.ok(Date.now() - los < 1500);
});

pruefe('die Antwort auf einen Zug bringt den neuen Stand gleich mit', async (t, baue) => {
  const u = await umgebung(t, baue);
  const { host, handys: [, bert] } = await spielbereit(u);
  const zug = await host.tu('pick', { catIdx: 0, rowIdx: 0 });
  assert.equal(zug.ok, true);
  assert.equal(zug.sicht.phase, 'question');
  assert.equal(zug.sicht.nummer, zug.nummer);
  assert.equal(zug.sicht.current.answer, 'Antwort 0-0', 'der Host bekommt die Host-Sicht');

  // Ein Handy bekommt seine eigene Sicht – ohne Lösung.
  await host.tu('pass');
  const buzz = await bert.tu('buzz');
  assert.equal(buzz.ok, true, buzz.error);
  assert.equal(buzz.sicht.current.answer, null, 'keine Lösung fürs Handy');
  assert.equal(buzz.sicht.rueckwegTiefe, undefined);
  // Ein abgelehnter Zug bringt nichts mit.
  const frech = await bert.tu('addTeam', { name: 'Gelb' });
  assert.equal(frech.ok, false);
  assert.equal(frech.sicht, undefined);
});

pruefe('zwei Instanzen: Züge von nebenan werden bemerkt, und ein alter Stand im Kopf schadet nicht', async (t, baue) => {
  const u = await umgebung(t, baue);
  const nebenan = await u.andereInstanz();
  // Der Bildschirm landet auf der einen Maschine, die Handys auf der anderen.
  const { raum, host, handys: [anna, bert] } = await spielbereit(u, { woGaeste: nebenan });

  // Die liegende Frage des Handys erfährt vom Zug nebenan beim nächsten Blick
  // in den Speicher.
  const offen = anna.stand({ warte: 8000, takt: 400 });
  await new Promise((r) => setTimeout(r, 100));
  const vorZug = Date.now();
  assert.equal((await host.tu('pick', { catIdx: 0, rowIdx: 0 })).ok, true);
  assert.equal((await offen).phase, 'question');
  assert.ok(Date.now() - vorZug < 2500, `kam ${Date.now() - vorZug} ms nach dem Zug`);

  // Hin und her über beide Maschinen: Jede hat zwischendurch einen veralteten
  // Stand im Kopf. Gültig wird trotzdem nur, was zum echten Stand passt.
  assert.equal((await host.tu('pass')).ok, true);                          // Maschine 1
  assert.equal((await bert.tu('buzz')).ok, true);                          // Maschine 2
  const doppelt = await anna.tu('buzz');                                   // Maschine 2
  assert.equal(doppelt.ok, false, 'Bert war schneller');
  const wertung = await host.tu('judge', { correct: true });             // Maschine 1 – kennt den Buzz nur aus dem Speicher
  assert.equal(wertung.ok, true, wertung.error);
  assert.equal(wertung.sicht.current.step, 'result');
  const punkte = Object.fromEntries(wertung.sicht.teams.map((tm) => [tm.name, tm.score]));
  assert.ok(punkte.Blau > 0, 'Berts Team bekommt die Punkte');

  // Ein Fehler, der nur am alten Stand läge, wird nicht gemeldet: Maschine 2
  // hat noch die offene Frage im Kopf, in Wahrheit ist das Feld wieder frei.
  const zu = await host.tu('close');
  assert.equal(zu.ok, true, zu.error);
  assert.equal(zu.sicht.phase, 'board');
  const hostNebenan = u.geraet('c_host', { h: raum.h, wo: nebenan });
  hostNebenan.geheim = host.geheim;
  const naechste = await hostNebenan.tu('pick', { catIdx: 1, rowIdx: 0 });
  assert.equal(naechste.ok, true, naechste.error);
  // Und zurücknehmen über die andere Maschine nimmt genau diesen Zug zurück.
  const zurueck = await host.tu('undo');
  assert.equal(zurueck.ok, true, zurueck.error);
  assert.equal(zurueck.sicht.phase, 'board');
  assert.equal(zurueck.sicht.rueckgaengig, 'Frage abschließen', 'der Rückweg von nebenan ist angekommen');
  assert.equal(zurueck.sicht.teams.find((tm) => tm.name === 'Blau').score, punkte.Blau);
});

pruefe('QR-Code und Fernbedienung zeigen auf die öffentliche Adresse, egal worüber der Host kam', async (t, baue) => {
  // Auf Vercel sind die Nebenadressen eines Projekts nur mit Anmeldung
  // erreichbar. Der Host ist angemeldet und merkt nichts – seine Gäste schon.
  const server = await starteOnlineLokal({ port: 0, speicher: baue(), oeffentlich: 'https://spiel.example' });
  t.after(() => new Promise((r) => server.close(r)));
  const info = await (await fetch(`http://localhost:${server.address().port}/api/info`, {
    headers: { 'x-forwarded-host': 'spiel-nebenadresse.example', 'x-forwarded-proto': 'https' },
  })).json();
  assert.deepEqual(info.urls, ['https://spiel.example']);
});
