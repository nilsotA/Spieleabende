import test from 'node:test';
import assert from 'node:assert/strict';

import { starteOnlineLokal } from '../server/online-lokal.js';
import { speicherImArbeitsspeicher } from '../server/speicher.js';

/*
 * Das Spiel im Netz: Räume statt eines Laptops.
 *
 * Geprüft wird über echte HTTP-Anfragen gegen denselben Code, der auf Vercel
 * läuft – nur mit dem Speicher im Arbeitsspeicher. Jede Anfrage steht für
 * sich; zwischen zweien bleibt nichts im Prozess stehen außer dem Speicher.
 */

async function umgebung(t, { uhr } = {}) {
  const jetzt = uhr ? () => uhr.zeit : undefined;
  const speicher = speicherImArbeitsspeicher({ jetzt });
  const server = await starteOnlineLokal({ port: 0, speicher, jetzt });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://localhost:${server.address().port}`;

  const holeJson = async (pfad, opt) => {
    const res = await fetch(base + pfad, opt);
    return { status: res.status, daten: await res.json().catch(() => null) };
  };
  const neuerRaum = async () => (await holeJson('/api/raum', { method: 'POST' })).daten;

  /** Ein Gerät: merkt sich Kennung, Geheimnis und letzten Stand wie der Browser. */
  function geraet(id, { k, h } = {}) {
    const rolle = h ? 'host' : 'player';
    const g = { id, geheim: undefined, nummer: null };
    g.stand = async ({ puls = false, seit = false } = {}) => {
      const q = new URLSearchParams({ clientId: id, role: rolle });
      if (h) q.set('h', h);
      if (k) q.set('k', k);
      if (puls) q.set('puls', '1');
      if (seit && g.nummer != null) q.set('seit', String(g.nummer));
      const { status, daten } = await holeJson(`/api/state?${q}`);
      if (daten?.geheim) g.geheim = daten.geheim;
      if (typeof daten?.nummer === 'number') g.nummer = daten.nummer;
      return { status, ...daten };
    };
    g.tu = async (type, mehr = {}) => (await holeJson('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...mehr, type, role: rolle, clientId: id, geheim: g.geheim, h, k }),
    })).daten;
    return g;
  }
  return { base, holeJson, neuerRaum, geraet, speicher };
}

test('ein Raum entsteht, und nur sein Host-Schlüssel führt ihn', async (t) => {
  const { holeJson, neuerRaum, geraet } = await umgebung(t);
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

test('zwei Räume wissen nichts voneinander', async (t) => {
  const { neuerRaum, geraet } = await umgebung(t);
  const a = await neuerRaum();
  const b = await neuerRaum();
  assert.notEqual(a.k, b.k);
  const hostA = geraet('c_a', { h: a.h });
  const hostB = geraet('c_b', { h: b.h });
  await hostA.tu('addTeam', { name: 'Nur in A' });
  assert.equal((await hostA.stand()).teams.length, 1);
  assert.equal((await hostB.stand()).teams.length, 0);
});

test('nachfragen kostet nichts, solange sich nichts tut', async (t) => {
  const { neuerRaum, geraet } = await umgebung(t);
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

test('ein ganzer Spielzug im Raum: aufrufen, buzzern, werten, zurücknehmen', async (t) => {
  const { neuerRaum, geraet } = await umgebung(t);
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

test('zwei Handys buzzern im selben Augenblick – genau eines gewinnt', async (t) => {
  const { neuerRaum, geraet } = await umgebung(t);
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

test('niemand handelt für ein fremdes Handy', async (t) => {
  const { neuerRaum, geraet } = await umgebung(t);
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

test('wer sich nicht mehr meldet, gilt als weg – und ist wieder da, wenn er sich meldet', async (t) => {
  const uhr = { zeit: Date.now() };
  const { neuerRaum, geraet } = await umgebung(t, { uhr });
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

test('nach zwölf stillen Stunden fängt der Raum leer an, das Gedächtnis bleibt', async (t) => {
  const uhr = { zeit: Date.now() };
  const { neuerRaum, geraet } = await umgebung(t, { uhr });
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

test('Fragensätze und Bilddateien kommen auch im Netz', async (t) => {
  const { base, holeJson } = await umgebung(t);
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
