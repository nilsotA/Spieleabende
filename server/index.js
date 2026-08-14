import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import * as G from './game.js';
import { listSets, loadSet, normalizeSet, setExists, externalizeImages, mixSet, stechenFrage, DATA_DIR } from './questions.js';
import { oeffne as oeffneImBrowser } from './browser.js';
import { starteTunnel, stoppeTunnel } from './tunnel.js';
import { neuerZugang, pruefeZugang, cookieKoepfe, TUER_ZU } from './zugang.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/*
 * Der Bauzeitpunkt: Wann wurde zuletzt an dieser Fassung geschraubt?
 *
 * Steht im Diagnosefeld auf dem Handy. Klingt nach Kleinigkeit, hat aber einen
 * ganzen Abend gekostet: Auf dem Handy lief eine ältere Fassung als die, gegen
 * die gemessen wurde, und niemand konnte es sehen. Zwei Dateien genügen als
 * Zeuge – die eine trägt den Server, die andere alles, was die Handys tun.
 */
const BAU = await (async () => {
  try {
    const zeiten = await Promise.all([
      stat(path.join(__dirname, 'index.js')),
      stat(path.join(PUBLIC_DIR, 'common.js')),
    ]);
    const neuste = Math.max(...zeiten.map((z) => z.mtimeMs));
    return new Date(neuste).toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return '?';
  }
})();
// Ein selbst gesetzter Port gilt genau so. Ohne Angabe darf der Server sich
// den nächsten freien suchen: Wer das Startskript zweimal doppelklickt, soll
// nicht vor „Port belegt" und einer Kommandozeile stehen.
const PORT_GESETZT = !!process.env.PORT;
let PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MIX = '__mix'; // Kennung für das gewürfelte Board

// Der Abend geht nach draußen: Tunnel auf, Tür zu. Ohne diese Umgebungsvariable
// ändert sich nichts – im Heimnetz bleibt das Spiel ohne Schlüssel und ohne
// Tunnel, so wie es gedacht ist.
const ONLINE = process.env.QUIZDUELL_ONLINE === '1';
let zugang = null; // wird unten aus der Sicherung geholt oder neu gewürfelt
let tunnelAdresse = null;

// Ein Spieleabend darf nicht daran scheitern, dass irgendein Randfall den Prozess
// beendet – mit dem Prozess wäre der komplette Punktestand weg.
process.on('uncaughtException', (err) => console.error('Unerwarteter Fehler:', err));
process.on('unhandledRejection', (err) => console.error('Unerwarteter Fehler:', err));

/* ------------------------------------------------------------ Spielzustand */

let state = G.createState();
let bilder = new Map(); // Bilder des laufenden Fragensatzes, siehe externalizeImages

/* ------------------------------------------------------ Spielstand sichern
 *
 * Ohne das wäre ein versehentlich geschlossenes Terminal das Ende des Abends:
 * Punkte, Teams und das halb gespielte Board sind weg. Deshalb liegt der Stand
 * auf der Platte und wird beim Start zurückgeholt.
 */

// Über QUIZDUELL_STATE_FILE umlenkbar, damit Tests nie einen echten
// Spielstand überschreiben.
const SAVE_FILE = process.env.QUIZDUELL_STATE_FILE || path.join(DATA_DIR, '.spielstand.json');
const SAVE_IMAGES = `${SAVE_FILE.replace(/\.json$/, '')}-bilder.json`;
const SAVE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
let saveTimer = null;

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow().catch((err) => console.error('Spielstand konnte nicht gesichert werden:', err.message));
  }, 400);
}

async function saveNow() {
  if (state.phase === 'lobby' && state.teams.length === 0) return;
  const tmp = `${SAVE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ gespeichert: Date.now(), state }), 'utf8');
  await rename(tmp, SAVE_FILE);
}

/**
 * Eingebettete Bilder liegen sonst nur im Arbeitsspeicher – nach einem Neustart
 * wären in einem wiederhergestellten Spiel alle Bildfragen kaputt. Sie ändern
 * sich nur beim Spielstart, also genügt ein Schreibvorgang je Spiel.
 */
async function saveImages() {
  if (!bilder.size) return unlink(SAVE_IMAGES).catch(() => {});
  const roh = {};
  for (const [id, bild] of bilder) roh[id] = { type: bild.type, data: bild.buffer.toString('base64') };
  const tmp = `${SAVE_IMAGES}.tmp`;
  await writeFile(tmp, JSON.stringify(roh), 'utf8');
  await rename(tmp, SAVE_IMAGES);
}

async function restoreImages() {
  try {
    const roh = JSON.parse(await readFile(SAVE_IMAGES, 'utf8'));
    const map = new Map();
    for (const [id, bild] of Object.entries(roh)) {
      map.set(id, { type: bild.type, buffer: Buffer.from(bild.data, 'base64') });
    }
    return map;
  } catch {
    return new Map();
  }
}

/* Wann der wiederhergestellte Stand gesichert wurde – bis der Host das erste
   Mal etwas tut. Der Hinweis stand bisher nur im Terminal, und das ist beim
   Spieleabend minimiert oder steht auf einem anderen Rechner: Wer den
   Host-Screen aufmachte, sah das Board vom letzten Mal samt Punkten und keine
   Erklärung dazu. */
let wiederhergestelltAm = null;

async function restore() {
  try {
    const roh = JSON.parse(await readFile(SAVE_FILE, 'utf8'));
    if (!roh?.state || Date.now() - (roh.gespeichert || 0) > SAVE_MAX_AGE_MS) return null;
    wiederhergestelltAm = roh.gespeichert || null;
    // Ein Stand von der Platte kann aus einer älteren Fassung stammen und neue
    // Felder gar nicht kennen. Deshalb gegen einen frischen Zustand auffüllen,
    // statt ihn ungeprüft zu übernehmen: Sonst stirbt der erste Buzz nach dem
    // Neustart an einem `state.rekorde`, das es damals noch nicht gab.
    const wieder = { ...G.createState(), ...roh.state };
    // Kein Gerät ist nach einem Neustart noch verbunden. Als Zeitpunkt gilt,
    // wann gespeichert wurde – die Uhr für die Karteileichen-Frist läuft also
    // ab dem letzten Zug weiter und nicht erst ab dem Neustart. Ohne das würde
    // ein Neustart jeden Gast von vor Stunden wieder frisch wirken lassen.
    for (const team of wieder.teams || []) {
      // Stände von vor den Wappen haben keins. Die Anzeige käme damit klar
      // (viewFor füllt auf), die Vergabe nicht: Ein leeres Feld kollidiert mit
      // nichts, und zwei Teams könnten sich dasselbe Wappen aussuchen.
      if (!team.wappen) {
        team.wappen = G.TEAM_WAPPEN.find((w) => !(wieder.teams || []).some((t) => t.wappen === w))
          || G.TEAM_WAPPEN[0];
      }
      for (const member of team.members || []) {
        member.online = false;
        member.wegSeit = member.wegSeit || roh.gespeichert || Date.now();
      }
    }
    bilder = await restoreImages();
    return wieder;
  } catch {
    return null; // kein Spielstand da, oder er ist unbrauchbar
  }
}

/* Die Schlüssel des Abends liegen neben dem Spielstand.
 *
 * Sonst wäre der Neustart, auf den dieses Spiel so stolz ist, ausgerechnet
 * online das Ende: Der Stand käme zurück, aber alle Schlüssel wären neu – und
 * damit jedes Handy im Raum ausgesperrt, mitten im Spiel, mit einem QR-Code auf
 * der Leinwand, den niemand mehr scannen kann. Nach zwölf Stunden gilt derselbe
 * Schnitt wie beim Spielstand: Dann ist der Abend vorbei. */
const ZUGANG_FILE = `${SAVE_FILE.replace(/\.json$/, '')}-zugang.json`;

async function ladeZugang() {
  try {
    const roh = JSON.parse(await readFile(ZUGANG_FILE, 'utf8'));
    if (roh?.spiel && roh?.host && Date.now() - (roh.gespeichert || 0) < SAVE_MAX_AGE_MS) {
      return { spiel: roh.spiel, host: roh.host };
    }
  } catch {
    /* keine Sicherung, oder sie ist unbrauchbar – dann eben neue */
  }
  const frisch = neuerZugang();
  try {
    await writeFile(ZUGANG_FILE, JSON.stringify({ gespeichert: Date.now(), ...frisch }), 'utf8');
  } catch (err) {
    // Schreiben ging schief: Das Spiel läuft trotzdem, nur ein Neustart würde
    // dann aussperren. Das ist keinen Abbruch wert, aber eine Meldung.
    console.error('Die Schlüssel ließen sich nicht sichern:', err.message);
  }
  return frisch;
}

async function forgetSave() {
  await Promise.all([
    unlink(SAVE_FILE).catch(() => {}),
    unlink(SAVE_IMAGES).catch(() => {}),
  ]);
}

/**
 * Verbindungen werden pro Tab geführt, nicht pro Gerät: derselbe Browser kann
 * Host-Screen und Spieleransicht offen haben, und ein Reload darf die frische
 * Verbindung nicht abräumen.
 */
const connections = new Map(); // connId -> { res, clientId, isHost }

/**
 * Ein Geheimnis je Gerätekennung – damit niemand für ein fremdes Handy handelt.
 *
 * Die Kennung steht im Anfragekörper, und sie ist kein Geheimnis: Die Sicht
 * nennt zu jedem Team seine Mitglieder samt Kennung, damit der Host eine
 * Karteileiche entfernen kann. Ohne Nachweis konnte damit jedes Handy für ein
 * anderes buzzern, es aus seinem Team werfen oder es woanders eintragen –
 * nachgestellt mit einem einzigen POST.
 *
 * Deshalb bekommt jede Kennung beim ersten Ereignisstrom ein Geheimnis, das
 * nur über diesen Strom herausgeht (`hello`). Wer eine Kennung benutzt, für die
 * eines hinterlegt ist, muss es mitschicken.
 *
 * Bewusst nachsichtig, wo nichts zu gewinnen ist: Für eine Kennung ohne
 * hinterlegtes Geheimnis geht der Zug durch. Sonst stünde nach einem
 * Serverneustart mitten im Spiel jedes Handy vor einer Absage, obwohl es nur
 * seine eigene Kennung benutzt – und ein Angreifer gewänne dadurch nichts, denn
 * eine frei erfundene Kennung gehört ohnehin niemandem.
 */
const geheimnisse = new Map(); // clientId -> Geheimnis

// So viele Kennungen merkt sich ein Abend. Acht Teams mit je vier Geräten sind
// 32, dazu Leinwand und Fernbedienung – 200 ist weit jenseits jedes
// Spieleabends und deckelt trotzdem, was sonst unbegrenzt wüchse: Jeder neue
// Ereignisstrom legt einen Eintrag an, und über den Tunnel kann den jeder
// öffnen, der den Spielschlüssel hat.
const GEHEIMNISSE_MAX = 200;

function geheimnisFuer(clientId) {
  if (!geheimnisse.has(clientId)) {
    if (geheimnisse.size >= GEHEIMNISSE_MAX) vergissAlteGeheimnisse();
    geheimnisse.set(clientId, randomUUID());
  }
  return geheimnisse.get(clientId);
}

/**
 * Platz schaffen – zuerst bei denen, die niemandem mehr gehören.
 *
 * Wer gerade verbunden ist oder in einem Team steht, behält sein Geheimnis;
 * alles andere fliegt in der Reihenfolge seines Eintreffens. Und selbst wenn
 * doch einmal ein Eintrag zu viel weggeht, sperrt das niemanden aus: Eine
 * Kennung ohne hinterlegtes Geheimnis kommt durch (siehe darfHandeln).
 */
function vergissAlteGeheimnisse() {
  const gebraucht = new Set([
    ...[...connections.values()].map((c) => c.clientId),
    ...state.teams.flatMap((t) => t.members.map((m) => m.clientId)),
  ]);
  for (const id of geheimnisse.keys()) {
    if (geheimnisse.size <= GEHEIMNISSE_MAX / 2) break;
    if (!gebraucht.has(id)) geheimnisse.delete(id);
  }
  // Selbst wenn alle gebraucht werden: Der Deckel gilt trotzdem.
  for (const id of geheimnisse.keys()) {
    if (geheimnisse.size < GEHEIMNISSE_MAX) break;
    geheimnisse.delete(id);
  }
}

function darfHandeln(clientId, mitgebracht) {
  const erwartet = geheimnisse.get(clientId);
  return !erwartet || erwartet === mitgebracht;
}

function connectionsOf(clientId) {
  return [...connections.values()].filter((c) => c.clientId === clientId);
}

/* Geräte, die sich den Zustand einzeln abholen, statt am Strom zu hängen –
   siehe /api/state. Wer sich länger nicht meldet, gilt als weg; ohne offene
   Verbindung gibt es ja kein Auflegen, das man mitbekäme. */
const abfragen = new Map(); // clientId -> { zeit, isHost }
const ABFRAGE_FRIST = 12000;

setInterval(() => {
  const jetzt = Date.now();
  let weg = false;
  for (const [id, eintrag] of abfragen) {
    if (jetzt - eintrag.zeit < ABFRAGE_FRIST) continue;
    abfragen.delete(id);
    if (connectionsOf(id).length === 0) {
      G.setMemberOnline(state, id, false);
      weg = true;
    }
  }
  if (weg) broadcast();
}, 5000).unref();

/**
 * Darf dieses Gerät den Abend führen?
 *
 * Die Rechte hängen nicht an einer Behauptung, sondern daran, dass der Server
 * das Gerät selbst als Host bedient – über den Ereignisstrom oder, wenn der
 * nicht durchkommt, über seine Abfragen. Beide Wege prüfen dieselbe Regel
 * (`role=host` UND ein gültiger Hostschlüssel), also verschiebt der zweite
 * nichts: Ohne Tunnel war ohnehin jeder im WLAN Host, mit Tunnel öffnet allein
 * der Schlüssel diese Tür.
 *
 * Ohne den zweiten Weg stünde die Fernbedienung am Tunnel hilflos da: Sie sähe
 * das Spiel, dürfte aber keinen einzigen Knopf drücken.
 */
function isHostClient(clientId) {
  if (connectionsOf(clientId).some((c) => c.isHost)) return true;
  const eintrag = abfragen.get(clientId);
  return !!eintrag?.isHost && Date.now() - eintrag.zeit < ABFRAGE_FRIST;
}

function broadcast() {
  for (const conn of connections.values()) sendState(conn);
  saveSoon();
}

/**
 * Wie viele Handys hängen dran, ohne in einem Team zu stehen?
 *
 * Der Zustand kennt nur Teams und ihre Mitglieder – ein Gast, der den QR-Code
 * gescannt hat und noch beim Namen tippt, kommt darin nicht vor. Genau der ist
 * aber der Grund, warum der Host noch nicht starten sollte. Diese Zahl weiß nur
 * der Server, weil nur er die offenen Verbindungen kennt.
 *
 * Host-Verbindungen (Leinwand, Fernbedienung) zählen nicht mit: Die warten auf
 * nichts.
 */
function warteschlange() {
  const imTeam = new Set(state.teams.flatMap((t) => t.members.map((m) => m.clientId)));
  const offen = new Set();
  for (const conn of connections.values()) {
    if (conn.isHost || imTeam.has(conn.clientId)) continue;
    offen.add(conn.clientId); // ein Gerät, nicht eine Verbindung
  }
  // Und die, die sich den Zustand selbst abholen – sonst zählte ausgerechnet
  // das Handy nicht mit, dem der Ereignisstrom nicht durchkommt.
  const jetzt = Date.now();
  for (const [id, eintrag] of abfragen) {
    if (eintrag.isHost || imTeam.has(id)) continue;
    if (jetzt - eintrag.zeit < ABFRAGE_FRIST) offen.add(id);
  }
  return offen.size;
}

/**
 * Die Sicht eines Geräts auf das Spiel – einmal gebaut, zweimal gebraucht.
 *
 * Über den Ereignisstrom geht sie bei jeder Änderung hinaus, über /api/state
 * holt sie sich ein Handy selbst ab, wenn der Strom nicht durchkommt.
 */
function sichtFuer({ isHost, clientId }) {
  const sicht = G.viewFor(state, { isHost, clientId });
  // Nur der Host kann zurücknehmen, also erfährt auch nur er davon.
  if (isHost) {
    sicht.rueckgaengig = rueckWeg.at(-1)?.was ?? null;
    // Wie viele Schritte noch gehen – der Knopf sagt es, sonst tippt der Host
    // ins Leere und weiß nicht, ob er am Ende des Weges ist.
    sicht.rueckwegTiefe = rueckWeg.length;
    sicht.wiederhergestellt = wiederhergestelltAm;
    sicht.wartende = warteschlange();
  }
  return sicht;
}

function sendState(conn) {
  write(conn, 'state', sichtFuer(conn));
}

function write(conn, event, payload) {
  try {
    conn.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    connections.delete(conn.id);
  }
}

/** Kleines Signal für alle – z.B. Buzzer-Sound auf dem Host-Screen. */
function broadcastEvent(name, payload) {
  for (const conn of connections.values()) write(conn, name, payload);
}

/* ---------------------------------------------------------------- Aktionen */

const HOST_ACTIONS = new Set([
  'addTeam', 'renameTeam', 'removeTeam', 'removeMember', 'adjustScore', 'setTurn',
  'startGame', 'judge', 'pass', 'openBuzz', 'reveal', 'endQuestion',
  'close', 'nextRound', 'backToLobby', 'settings', 'resetBuzz', 'buzzFor',
  'undo', 'stechen', 'discard', 'pause',
]);

/**
 * Zurücknehmen – mehrere Stufen.
 *
 * Am Spieleabend passiert genau ein Fehler zuverlässig: „Richtig“ statt
 * „Falsch“, und schon hat der falsche Tisch 500 Punkte. Über das Menü ließe
 * sich das in Hunderterschritten zurechtklopfen, aber Serie und Bilanz blieben
 * verkehrt – und der Tisch diskutiert derweil.
 *
 * Gesichert wird der ganze Zustand vor jedem Zug, der das Spiel verändert. Ein
 * Fragensatz misst rund 8 KB und Bilder liegen als Dateien daneben, das kostet
 * also nichts. Eine Stufe genügt: Wer zwei Züge zurück will, hat ein anderes
 * Problem, und mehr Stufen laden dazu ein, sich blind rückwärts zu klicken.
 */
/* Züge, die sich auf genau eine Situation der laufenden Frage beziehen.
   Punktekorrekturen und „dran" stehen bewusst nicht dabei: Die macht der Host
   absichtlich und oft, während sich nebenher etwas bewegt. */
const LAGEGEBUNDEN = new Set(['judge', 'pass', 'openBuzz', 'reveal', 'endQuestion', 'close', 'resetBuzz',
  'buzzFor', 'discard']);

const RUECKNEHMBAR = new Set([
  'pick', 'judge', 'pass', 'openBuzz', 'reveal', 'endQuestion', 'close',
  'nextRound', 'adjustScore', 'setTurn', 'resetBuzz', 'buzzFor', 'buzz',
  'stechen',
]);

/**
 * Der Rückweg ist ein Stapel, keine einzelne Schublade.
 *
 * Mit nur einem gemerkten Zug war jeder Fehler, der erst eine Frage später
 * auffällt, nicht mehr zurückzunehmen – und genau so fallen sie auf: „Moment,
 * das war doch gar nicht falsch." Übrig blieb die Punktekorrektur von Hand, und
 * damit stimmen Bilanz und Rekorde am Ende nicht mehr, weil die nicht an den
 * Punkten hängen, sondern an den Wertungen.
 *
 * Fünfundzwanzig Schritte reichen für jede Reue eines Abends und kosten nichts:
 * Ein Spielstand misst gemessen rund 10 kB, der ganze Stapel also 250 kB.
 * Er wird nicht mitgesichert – nach einem Neustart des Servers gibt es nichts
 * zurückzunehmen, das war auch vorher so.
 */
const RUECKWEG_TIEFE = 25;
let rueckWeg = []; // [{ state, was }, …] – hinten liegt der nächste Rückschritt

/**
 * Einen früheren Spielstand übernehmen, ohne den Raum mit zurückzudrehen.
 *
 * Wer inzwischen beigetreten oder rausgeflogen ist, bleibt es auch:
 * Zurückgenommen wird der Spielzug, nicht der Raum – sonst wirft ein
 * Rückschritt das Handy hinaus, das sich zwei Sekunden vorher verbunden hat.
 * Und Teams, die es im Schnappschuss noch gar nicht gab, bleiben ebenfalls.
 * Sonst warf ein „Zurücknehmen" genau das Team hinaus, das sich ein Handy
 * zwei Sekunden vorher selbst angelegt hat – samt Gerät: Der Host tippt in der
 * Lobby auf „dran", jemand legt sein Team an, der Host nimmt den Zugwechsel
 * zurück, und das Team ist weg. Nachgestellt.
 */
function uebernimm(alt, jetztStand) {
  for (const team of alt.teams) {
    const jetzt = jetztStand.teams.find((t) => t.id === team.id);
    if (jetzt) team.members = jetzt.members;
  }
  // Entfernte Teams bleiben entfernt.
  //
  // Bisher schützte nur die Gegenrichtung: Teams, die es im Schnappschuss noch
  // nicht gab, blieben. Ein Team, das der Host inzwischen weggeräumt hat, stand
  // nach einem „Zurücknehmen" dagegen wieder da – samt seiner damaligen
  // Mitglieder. Nachgestellt: Anna legt ihr eigenes Team an, wechselt dann zu
  // Bernd, der Host räumt Annas leeres Team weg und nimmt danach einen
  // Zugwechsel zurück. Danach gab es Annas Team wieder, und Annas Handy stand
  // in zwei Teams gleichzeitig. Teams anzulegen und zu entfernen geht nur in
  // der Lobby und steht in keinem Rückweg – der Raum gehört also dem Jetzt,
  // genau wie die Mitglieder und die Pause.
  const jetztIds = new Set(jetztStand.teams.map((t) => t.id));
  alt.teams = alt.teams.filter((t) => jetztIds.has(t.id));
  const bekannt = new Set(alt.teams.map((t) => t.id));
  for (const team of jetztStand.teams) {
    if (!bekannt.has(team.id)) alt.teams.push(team);
  }
  // Wie in removeTeam: Der Zeiger aufs Zugteam darf nicht hinter das Ende der
  // Liste zeigen – dort wäre der nächste Feldaufruf kein abgelehnter Zug,
  // sondern ein Absturz.
  if (alt.turnIndex >= alt.teams.length) alt.turnIndex = 0;
  // Die Pause gehört zum Raum, nicht zum Spielzug.
  //
  // Sie fuhr bisher aus dem Schnappschuss mit: Wer in der Pause eine
  // Fehlwertung zurücknahm – genau wozu die Pause da ist –, hob damit die
  // Pause auf. Auf der Leinwand stand wieder die offene Frage, Feldwahl und
  // Buzzer waren wieder scharf, während der halbe Tisch in der Küche stand.
  // In der Gegenrichtung noch unangenehmer: Ein Rückschritt auf einen
  // Schnappschuss aus einer früheren Pause fror das laufende Spiel wieder ein,
  // ohne dass jemand Pause gedrückt hätte.
  alt.pause = jetztStand.pause;
  alt.pauseSeit = jetztStand.pauseSeit;
  return alt;
}

/** Menschenlesbar, damit der Knopf sagt, was er zurücknimmt. */
function benenne(type, vorher) {
  const team = vorher.current?.onTheHook
    ? vorher.teams.find((t) => t.id === vorher.current.onTheHook)?.name
    : null;
  switch (type) {
    case 'judge': return team ? `Wertung für ${team}` : 'Wertung';
    case 'pass': return 'Weiß nicht';
    case 'pick': return 'Feldwahl';
    case 'close': return 'Frage abschließen';
    case 'endQuestion': return 'Auflösen';
    case 'nextRound': return 'Rundenwechsel';
    case 'adjustScore': return 'Punktekorrektur';
    case 'setTurn': return 'Zugwechsel';
    case 'buzz': case 'buzzFor': return 'Buzz';
    case 'resetBuzz': return 'Buzz zurücksetzen';
    case 'stechen': return 'Stechen starten';
    default: return 'letzte Aktion';
  }
}

async function handleAction(clientId, body) {
  const isHost = isHostClient(clientId);
  const type = String(body.type || '');

  if (HOST_ACTIONS.has(type) && !isHost) {
    // Ein schlafendes Handy verliert seinen Ereignisstrom. Tippt der Host gleich
    // nach dem Aufwecken, ist die Verbindung noch nicht wieder da – das ist kein
    // Rechteproblem, und „Nur der Host darf das“ wäre ein Schreck ohne Grund.
    // Die Rechte selbst hängen weiterhin allein an der offenen Verbindung; hier
    // steht nur, welche der beiden Lagen der Absender vor sich hat.
    if (body.role === 'host' && connectionsOf(clientId).length === 0) {
      throw new G.GameError('Verbindung wird gerade neu aufgebaut – gleich noch einmal tippen.');
    }
    throw new G.GameError('Nur der Host darf das.');
  }

  // Sobald der Host etwas tut, ist der Stand nicht mehr „von letztem Mal",
  // sondern der laufende Abend.
  wiederhergestelltAm = null;

  // Wertungen, die sich auf eine überholte Lage beziehen, prallen ab. Der
  // Client schickt die Kennung mit, die er auf dem Schirm hatte; passt sie
  // nicht mehr, war der Druck für die vorige Situation gedacht – typischerweise
  // „Richtig" für das Zugteam, während schon jemand gebuzzert hat. Ohne die
  // Angabe (ältere, im Browser hängengebliebene Seite) bleibt alles wie bisher.
  if (LAGEGEBUNDEN.has(type) && typeof body.lage === 'string'
      && body.lage !== G.lageSignatur(state)) {
    throw new G.GameError('Da hat sich gerade etwas geändert – schau kurz auf den Screen.');
  }

  // Erst sichern, dann handeln – aber übernommen wird der Schnappschuss erst,
  // wenn der Zug auch durchgegangen ist.
  //
  // Vorher stand er sofort im Rückweg, und ein abgelehnter Zug hat damit
  // den Rückweg überschrieben: Host wertet „Richtig" für Rot (100 Punkte,
  // Knopf sagt „Wertung für Rot"), tippt gleich darauf auf ein Feld, das
  // gerade nicht wählbar ist – der Knopf sagt danach „Feldwahl", und
  // Zurücknehmen ließ die 100 Punkte stehen. Gemessen und nachgestellt. Der
  // Kommentar an dieser Stelle beschrieb schon immer das gewünschte Verhalten;
  // der Code tat es nur nicht.
  const schnappschuss = RUECKNEHMBAR.has(type)
    ? { state: structuredClone(state), was: benenne(type, state) }
    : null;

  switch (type) {
    case 'undo': {
      if (!rueckWeg.length) throw new G.GameError('Es gibt nichts zurückzunehmen.');
      state = uebernimm(rueckWeg.pop().state, state);
      break;
    }

    /**
     * Eine Frage streichen: Sie zählt nicht, das Feld bleibt offen.
     *
     * Doppeldeutig gestellt, die Lösung war vorhin schon gefallen, im Fragensatz
     * steht ein Fehler – so etwas merkt man erst beim Vorlesen. Bisher blieb nur
     * die Wahl zwischen „irgendwie werten" und „Feld verbrannt": Das Feld war
     * belegt, sobald es aufgerufen war.
     *
     * Gestrichen wird nicht durch Rückrechnen von Punkten, Bilanz und Serie –
     * das wäre eine zweite Buchhaltung neben der ersten und ginge irgendwann
     * auseinander. Stattdessen geht es den Weg zurück bis zu dem Zustand, in dem
     * das Feld noch offen war. Damit stimmt alles wieder, was an dieser Frage
     * hing, ohne dass es einzeln aufgezählt werden muss.
     *
     * Das Verwerfen selbst ist zurücknehmbar: Ein Rückschritt holt die ganze
     * Frage samt Wertung wieder her.
     */
    case 'discard': {
      const q = state.current;
      if (!q) throw new G.GameError('Gerade läuft keine Frage.');
      if (q.stechen) throw new G.GameError('Eine Stechfrage hat kein Feld – lös sie auf und stell die nächste.');
      // Der Schnappschuss vor der Feldwahl ist der erste, in dem keine Frage
      // offen steht. Alles darüber gehört zu dieser Frage und fällt mit ihr.
      const bis = rueckWeg.findLastIndex((e) => !e.state.current);
      if (bis < 0) {
        throw new G.GameError('Der Weg zurück reicht nicht mehr bis zum Anfang dieser Frage.');
      }
      const vorher = { state: structuredClone(state), was: 'Frage verworfen' };
      // Der Ankerpunkt bleibt im Stapel stehen, und übernommen wird eine Kopie.
      //
      // Vorher wurde er verbraucht (`rueckWeg.length = bis`). Nahm der Host das
      // Streichen dann zurück, stand die Frage wieder da – aber ihr Anker war
      // weg. Ein zweites Streichen suchte den nächsten Zustand ohne offene
      // Frage und fand den Anfang der VORHERIGEN Frage: Nachgestellt wurde
      // damit eine längst abgeschlossene, fremde Frage stillschweigend
      // mitgelöscht, samt ihrer Punkte. Bleibt der Anker liegen, findet ihn
      // auch der zweite Versuch. Kopiert werden muss dabei, weil `uebernimm`
      // den übergebenen Zustand verändert – sonst stünde im Stapel danach ein
      // verbogener Schnappschuss.
      const ziel = structuredClone(rueckWeg[bis].state);
      rueckWeg.length = bis + 1;
      state = uebernimm(ziel, state);
      state.message = 'Frage gestrichen – das Feld ist wieder offen.';
      rueckWeg.push(vorher);
      // Auch hier den Deckel halten: Der Anker bleibt liegen, und ohne diese
      // Zeile stünde nach dem Streichen ein Schritt mehr im Stapel als erlaubt.
      if (rueckWeg.length > RUECKWEG_TIEFE) rueckWeg.shift();
      break;
    }
    case 'joinTeam':
      G.joinTeam(state, clientId, body.teamId, body.name);
      break;
    // Ein Handy legt sein eigenes Team an und tritt ihm bei. Bewusst nicht
    // host-only: Genau das ist der Punkt – niemand muss auf den Host warten,
    // der sonst vier Namen abtippt, bevor überhaupt jemand beitreten kann.
    // Die Grenzen dafür stehen ohnehin schon in addTeam: nur in der Lobby,
    // höchstens acht Teams. Entfernen kann sie weiterhin nur der Host.
    case 'eigenesTeam': {
      const wunsch = String(body.name || '').trim();
      G.addTeam(state, wunsch);
      const neu = state.teams[state.teams.length - 1];
      G.joinTeam(state, clientId, neu.id, wunsch);
      break;
    }
    // Wappen wechseln. Ohne `teamId` gilt es fürs eigene Team – so darf jedes
    // Handy sein Wappen aussuchen, aber keins das der anderen umstecken. Der
    // Host darf über die Fernbedienung jedes ändern, so wie er auch jeden
    // Namen ändern darf.
    case 'wappen': {
      const eigenes = G.teamOfClient(state, clientId);
      const ziel = isHost && body.teamId ? body.teamId : eigenes?.id;
      if (!ziel) throw new G.GameError('Such dir erst ein Team aus.');
      G.setTeamWappen(state, ziel, String(body.wappen || ''));
      break;
    }
    case 'leaveTeam':
      G.leaveTeams(state, clientId);
      break;
    case 'addTeam':
      G.addTeam(state, body.name);
      break;
    case 'renameTeam':
      G.renameTeam(state, body.teamId, body.name);
      break;
    case 'removeTeam':
      G.removeTeam(state, body.teamId);
      break;
    case 'removeMember':
      G.removeMember(state, body.teamId, body.clientId);
      break;
    case 'adjustScore':
      G.adjustScore(state, body.teamId, body.delta);
      break;
    case 'setTurn':
      // Während einer Frage ist der Zug bereits vergeben: Wer die Frage hat und
      // wer antworten muss, steht fest. Den Zeiger trotzdem zu verschieben,
      // wirkt für den Host wie ein Fehlgriff – lieber klar absagen.
      if (state.phase === 'question') {
        throw new G.GameError('Der Zug lässt sich erst wieder setzen, wenn die Frage durch ist.');
      }
      G.setTurn(state, body.teamId);
      break;
    case 'settings':
      Object.assign(state.settings, pickSettings(body.settings));
      break;
    case 'startGame': {
      const roh = body.set
        ? normalizeSet(body.set)
        : body.file === MIX
          ? normalizeSet(await mixSet())
          : await loadSet(body.file);
      const { set, images } = externalizeImages(roh);
      bilder = images;
      // Über einen Spielstart hinweg zurückzunehmen, hieße das alte Spiel
      // wiederauferstehen zu lassen – mitten in einem neuen.
      rueckWeg = [];
      G.startGame(state, set);
      await saveImages();
      break;
    }
    case 'pick': {
      // Auch das Team, das dran ist, darf vom Handy aus wählen.
      const team = G.teamOfClient(state, clientId);
      if (!isHost && !team) throw new G.GameError('Du gehörst zu keinem Team.');
      G.pickCell(state, Number(body.catIdx), Number(body.rowIdx), isHost ? null : team.id);
      break;
    }
    case 'buzz': {
      G.buzz(state, clientId);
      const team = G.teamOfClient(state, clientId);
      broadcastEvent('buzz', { teamId: team?.id, teamName: team?.name, by: state.current?.buzzedBy });
      break;
    }
    case 'buzzFor': {
      G.buzzFor(state, body.teamId);
      const team = G.findTeam(state, body.teamId);
      broadcastEvent('buzz', { teamId: team.id, teamName: team.name, by: team.name });
      break;
    }
    case 'judge':
      G.judge(state, !!body.correct);
      break;
    case 'endQuestion':
      G.endQuestion(state);
      break;
    case 'pass':
      G.passQuestion(state);
      break;
    case 'openBuzz':
      G.openBuzz(state);
      break;
    case 'resetBuzz':
      G.resetBuzz(state);
      break;
    case 'reveal':
      G.revealAnswer(state);
      break;
    case 'close':
      G.closeQuestion(state);
      break;
    case 'nextRound':
      G.nextRound(state);
      break;
    case 'pause':
      G.setPause(state, body.an);
      break;
    case 'stechen': {
      // Alles, was heute schon auf dem Brett stand, fällt raus – sonst kommt
      // als Entscheidungsfrage ausgerechnet die, die vorhin schon jemand
      // gehört hat.
      const gespielt = [];
      for (const runde of state.questionSet?.rounds || []) {
        for (const cat of runde.categories) for (const q of cat.questions) gespielt.push(q.text);
      }
      // Erst warten, dann `state` lesen.
      //
      // Stand das `await` in der Argumentliste, war `state` schon gelesen,
      // bevor gewartet wurde – und `undo`, `discard` und „Neues Spiel" weisen
      // diesen Modulwert neu zu. Trifft einer davon in den Millisekunden ein,
      // die das Einlesen der Fragensätze braucht, arbeitete das Stechen auf
      // einem abgehängten Zustand: Es verpuffte spurlos (mit `ok: true`), und
      // sein Schnappschuss landete trotzdem auf dem Rückweg – auch auf einem,
      // den „Neues Spiel" gerade geleert hatte. Ein `undo` darauf holte das
      // beendete Spiel zurück. Nachgestellt, dreimal von dreimal.
      // `startGame` macht es an derselben Stelle schon richtig.
      const frage = await stechenFrage([...gespielt, ...(state.stechenTexte || [])]);
      G.startStechen(state, frage);
      break;
    }
    case 'backToLobby':
      state = G.backToLobby(state);
      rueckWeg = [];
      bilder = new Map();
      await forgetSave();
      break;
    default:
      throw new G.GameError(`Unbekannte Aktion: ${type}`);
  }
  // Bis hierher kommt nur, was nicht geworfen hat. `undo` und `backToLobby`
  // räumen den Rückweg selbst ab und stehen nicht in RUECKNEHMBAR – ihr
  // Schnappschuss ist null und überschreibt deshalb nichts.
  if (schnappschuss) {
    rueckWeg.push(schnappschuss);
    if (rueckWeg.length > RUECKWEG_TIEFE) rueckWeg.shift();
  }
  broadcast();
}

function pickSettings(s = {}) {
  const out = {};
  if (['rotate', 'keepOnCorrect'].includes(s.turnMode)) out.turnMode = s.turnMode;
  if (['none', 'half', 'full'].includes(s.wrongPenalty)) out.wrongPenalty = s.wrongPenalty;
  if (typeof s.buzzAfterCorrect === 'boolean') out.buzzAfterCorrect = s.buzzAfterCorrect;
  if (['team', 'host'].includes(s.feldwahl)) out.feldwahl = s.feldwahl;
  // Nur die angebotenen Stufen – eine Uhr mit 0,5 Sekunden wäre kein Spiel mehr.
  // Und erst prüfen, ob überhaupt eine Zahl gemeint ist: `Number(null)` ist 0,
  // und 0 heißt „aus". Eine Einstellung mit `buzzUhr: null` hätte die Uhr damit
  // stillschweigend abgeschaltet, statt abgewiesen zu werden – dasselbe für
  // `false`, `''` und `[]`. Vom eigenen Test gefunden.
  const uhr = typeof s.buzzUhr === 'number'
    || (typeof s.buzzUhr === 'string' && s.buzzUhr.trim() !== '')
    ? Number(s.buzzUhr) : NaN;
  if ([0, 10, 15, 20, 30].includes(uhr)) out.buzzUhr = uhr;
  return out;
}

/* ------------------------------------------------------------------ Server */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

const ROUTES = {
  '/': 'index.html',
  '/host': 'host.html',
  '/play': 'player.html',
  '/remote': 'remote.html',
  '/editor': 'editor.html',
};

// Seiten, hinter denen die Lösungen stehen. Bei den Schnittstellen ist die
// Liste andersherum gedacht – alles ist Hostsache, außer den dreien, die ein
// Handy wirklich braucht: die Live-Verbindung, sein Zug und die Adressen.
// Ein Fragensatz (/api/set) enthält die Antworten und gehört ausdrücklich nicht
// dazu.
const NUR_HOST_SEITEN = new Set(['/host', '/remote', '/editor']);
const AUCH_FUER_HANDYS = new Set(['/api/events', '/api/state', '/api/action', '/api/info']);

function hostNoetig(pathname) {
  if (NUR_HOST_SEITEN.has(pathname)) return true;
  if (pathname.startsWith('/api/bild/')) return false; // Fragebilder sehen alle
  if (pathname.startsWith('/api/')) return !AUCH_FUER_HANDYS.has(pathname);
  return false;
}

const server = http.createServer(async (req, res) => {
  let pathname;
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // Eine einzige kaputt kodierte Adresse darf nicht den ganzen Abend beenden.
    return send(res, 400, 'text/plain; charset=utf-8', 'Ungültige Adresse');
  }

  // Tür: Ohne Tunnel steht sie offen (rolle ist dann immer 'host'), mit Tunnel
  // kommt nur herein, wer einen Schlüssel mitbringt – und der steckt im
  // QR-Code, den ohnehin jeder scannt.
  //
  // Bewusst innerhalb des try: Diese Prüfung läuft vor allem anderen, und ein
  // Wurf hier hätte keinen Fänger gehabt. Die Anfrage blieb dann offen liegen –
  // keine Antwort, keine Fehlerseite, nur eine hängende Verbindung.
  let rolle;
  try {
    rolle = pruefeZugang(req, url, zugang);
    if (zugang) {
      const kekse = cookieKoepfe(url, zugang);
      if (kekse.length) res.setHeader('Set-Cookie', kekse);
      if (!rolle || (hostNoetig(pathname) && rolle !== 'host')) {
        if (pathname.startsWith('/api/')) return sendJson(res, 403, { error: 'Kein Zugang.' });
        /*
         * Die Startwache kommt auch ohne Schlüssel durch.
         *
         * Der Schlüssel steckt nur in der Adresse der Seite; Stylesheet und
         * Skripte holt der Browser ohne Adresszusatz und damit allein über den
         * Keks. Legt ein Handy den nicht ab, bekommt es die Seite – und dann
         * für jede Datei danach eine Absage, auch für die Wache, die genau das
         * melden sollte. Diese eine Datei enthält nichts: keinen Spielstand,
         * keine Frage, keine Lösung, nur die Meldung selbst. Sie zu verstecken
         * schützt nichts und kostet die einzige Auskunft, die der Gast dann
         * noch bekommen kann.
         */
        if (pathname === '/start-wache.js') return serveFile(res, path.join(PUBLIC_DIR, 'start-wache.js'));
        /*
         * Eine Absage für eine Datei ist keine Seite.
         *
         * Bisher ging auch auf `.js` und `.css` die Tür-zu-Seite als HTML
         * hinaus. Ein Modul lehnt das schon wegen der Art ab, ein Stylesheet
         * verschluckt es still – in beiden Fällen steht im Browser eine
         * Fehlermeldung, die vom Falschen redet. Nackter Text mit `nosniff`
         * kommt als das an, was es ist: eine Datei, die nicht geladen werden
         * durfte.
         */
        if (/\.(js|css|mjs|map)$/.test(pathname)) {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          return send(res, 403, 'text/plain; charset=utf-8', 'Kein Zugang.');
        }
        return send(res, 403, 'text/html; charset=utf-8', TUER_ZU);
      }
    }
  } catch (err) {
    console.error('Türprüfung fehlgeschlagen:', err);
    return send(res, 400, 'text/plain; charset=utf-8', 'Ungültige Anfrage');
  }

  try {
    if (pathname === '/api/events') return sseHandler(req, res, url, rolle);
    if (pathname.startsWith('/api/')) return await apiHandler(req, res, url, pathname, rolle);

    if (pathname.startsWith('/bilder/')) {
      return serveFile(res, path.join(DATA_DIR, 'bilder', path.basename(pathname)));
    }
    const file = ROUTES[pathname] || pathname.replace(/^\//, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'text/plain', 'Verboten');
    return serveFile(res, full);
  } catch (err) {
    console.error(err);
    if (pathname.startsWith('/api/')) return sendJson(res, 500, { error: err.message });
    send(res, 500, 'text/plain; charset=utf-8', 'Serverfehler: ' + err.message);
  }
});

function sseHandler(req, res, url, rolle) {
  const clientId = url.searchParams.get('clientId') || `c_${randomUUID()}`;
  // Die Host-Rolle behauptet man nicht, man weist sie nach: Über sie laufen die
  // ungekürzten Zustände samt Lösung. Ohne Tunnel ist `rolle` immer 'host',
  // dann bleibt es beim alten Verhalten.
  const isHost = url.searchParams.get('role') === 'host' && rolle === 'host';
  const connId = randomUUID();

  // `Connection: keep-alive` stand hier früher ausdrücklich drin. Es ist weg,
  // weil es nichts tat: Node setzt die Kopfzeile für HTTP/1.1 ohnehin selbst
  // (gemessen), und was ein Vermittler daraus macht, entscheidet er allein.
  // Was hier wirklich zählt, steht in den drei Zeilen darunter und im Vorspann.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.(); // die Kopfzeilen sollen sofort raus, nicht erst mit Inhalt
  // Ein Vorspann aus Kommentarzeilen. Manche Vermittler halten eine Antwort
  // zurück, bis genug Bytes beisammen sind – ein Ereignisstrom kommt dann nie
  // an, weil er ja gerade nicht fertig wird. Acht Kilobyte Kommentar lösen die
  // Bremse, kosten einmalig nichts und werden von jedem Browser verworfen.
  //
  // Acht und nicht zwei: Der erste Schub misst mit Vorspann, Begrüßung und
  // Spielstand rund 3,5 kB. Eine Bremse, die bei vier Kilobyte löst, hätte er
  // damit knapp verfehlt – und knapp verfehlt ist hier dasselbe wie gar nicht.
  res.write(`: ${'x'.repeat(8192)}\n\n`);
  res.write('retry: 1000\n\n');

  const conn = { id: connId, res, clientId, isHost };
  connections.set(connId, conn);
  G.setMemberOnline(state, clientId, true);

  write(conn, 'hello', { clientId, isHost, geheim: geheimnisFuer(clientId) });
  sendState(conn);
  broadcast(); // die anderen sehen sofort, dass jemand wieder online ist

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
    // Alle zehn Sekunden statt alle zwanzig: Der Ping hält nicht nur die
    // Verbindung wach, er ist auch das einzige Lebenszeichen zwischen zwei
    // Zügen – und je öfter etwas fließt, desto weniger Gelegenheit hat ein
    // Vermittler, die Leitung für tot zu halten.
  }, 10000);

  const close = () => {
    clearInterval(ping);
    connections.delete(connId);
    // Nur offline melden, wenn das Gerät wirklich keine Verbindung mehr hat –
    // beim Neuladen einer Seite überlappen alte und neue Verbindung kurz.
    if (connectionsOf(clientId).length === 0) {
      G.setMemberOnline(state, clientId, false);
      broadcast();
    }
  };
  req.on('close', close);
  res.on('error', close);
}

async function apiHandler(req, res, url, pathname, rolle) {
  /*
   * Der Notweg zum Spielstand.
   *
   * Normalerweise kommt der Zustand von selbst über den Ereignisstrom. Der ist
   * aber das Zerbrechlichste am ganzen Aufbau: eine Antwort, die nie endet.
   * Firmen-WLAN, Virenscanner, ein sparsamer Mobilfunkvermittler oder der
   * Tunnel selbst können sie zurückhalten – und dann passiert auf dem Handy
   * genau nichts, ohne jede Fehlermeldung.
   *
   * Deshalb kann sich jedes Gerät den Zustand auch einzeln abholen. Der Client
   * schaltet von selbst um, wenn der Strom stumm bleibt (siehe connect() in
   * public/common.js). Das Spiel läuft dann etwas träger, aber es läuft.
   */
  if (pathname === '/api/state' && req.method === 'GET') {
    const clientId = url.searchParams.get('clientId') || '';
    const isHost = url.searchParams.get('role') === 'host' && rolle === 'host';
    if (clientId && !abfragen.has(clientId) && connectionsOf(clientId).length === 0) {
      // Erst beim Umschalten melden – nicht bei jeder Abfrage.
      G.setMemberOnline(state, clientId, true);
      broadcast();
    }
    if (clientId) abfragen.set(clientId, { zeit: Date.now(), isHost });
    /*
     * Der Nachweis muss denselben Weg nehmen können wie der Spielstand.
     *
     * Sonst wird der Notweg zur Falle, und zwar auf die gemeinste Art: Schon
     * das Öffnen des Ereignisstroms legt für diese Kennung ein Geheimnis an –
     * ausgeliefert wird es aber im `hello`, also über genau den Strom, der beim
     * Handy nicht ankommt. Das Handy sieht dann alles und darf nichts: Jeder
     * Zug prallt mit „Dieses Gerät gehört jemand anderem" ab. Am Tisch stand
     * damit ein Gast vor einer vollständigen Teamliste, tippte auf
     * „Mitspielen" und bekam einen roten Kasten.
     *
     * Neues verrät das nicht: Wer diese Abfrage stellen darf, dürfte auch den
     * Strom öffnen, und der gibt dasselbe Geheimnis für dieselbe Kennung
     * heraus. Beide Türen sind dieselbe Tür.
     */
    const sicht = sichtFuer({ isHost, clientId });
    if (clientId) sicht.geheim = geheimnisFuer(clientId);
    return sendJson(res, 200, sicht);
  }
  if (pathname === '/api/sets' && req.method === 'GET') {
    return sendJson(res, 200, await listSets());
  }
  if (pathname === '/api/mix' && req.method === 'GET') {
    try {
      return sendJson(res, 200, await mixSet());
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (pathname === '/api/set' && req.method === 'GET') {
    try {
      return sendJson(res, 200, await loadSet(url.searchParams.get('file')));
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (pathname === '/api/sets' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, err.statusCode || 400, { error: err.message });
    }
    try {
      const set = normalizeSet(body.set, 'Eigener Satz');
      const name = path.basename(String(body.file || 'eigener-satz.json'));
      // Kein Punkt am Anfang: Im selben Ordner liegt die laufende Sicherung
      // (.spielstand.json). Ein Fragensatz, der so heißt, hätte den Spielstand
      // des Abends überschrieben – gemessen ging das durch. basename() hält
      // Verzeichnisse schon draußen, aber einen Punkt nicht auf.
      if (name.startsWith('.')) throw new Error('Der Dateiname darf nicht mit einem Punkt beginnen.');
      const file = name.endsWith('.json') ? name : `${name}.json`;
      const overwrite = await setExists(file);
      if (overwrite && !body.overwrite) {
        return sendJson(res, 200, { ok: false, exists: true, file });
      }
      // Erst in eine Nebendatei schreiben, dann umbenennen: ein Absturz mittendrin
      // darf den vorhandenen Fragensatz nicht zerstören.
      const target = path.join(DATA_DIR, file);
      const tmp = `${target}.tmp`;
      await writeFile(tmp, JSON.stringify(set, null, 2), 'utf8');
      await rename(tmp, target);
      return sendJson(res, 200, { ok: true, file });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }
  if (pathname.startsWith('/api/bild/') && req.method === 'GET') {
    const bild = bilder.get(pathname.slice('/api/bild/'.length));
    if (!bild) return sendJson(res, 404, { error: 'Bild nicht gefunden' });
    res.writeHead(200, { 'Content-Type': bild.type, 'Cache-Control': 'max-age=3600' });
    return res.end(bild.buffer);
  }
  if (pathname === '/api/info' && req.method === 'GET') {
    // Die Schlüssel bekommt nur der Host-Screen: Er baut daraus die beiden
    // QR-Codes. Ein Handy braucht sie nicht – es ist ja schon drin.
    const geheim = zugang && rolle === 'host'
      ? { schluessel: zugang.spiel, hostSchluessel: zugang.host }
      : {};
    return sendJson(res, 200, { urls: localUrls(), port: PORT, bau: BAU, ...geheim });
  }
  if (pathname === '/api/action' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
    }
    const clientId = String(body.clientId || '');
    if (!darfHandeln(clientId, body.geheim)) {
      return sendJson(res, 200, { ok: false, error: 'Dieses Gerät gehört jemand anderem.' });
    }
    try {
      await handleAction(clientId, body);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      if (!(err instanceof G.GameError)) console.error(err);
      // Der Aufrufer zeigt den Fehler selbst an; zusätzlich alle Clients auf den
      // tatsächlichen Serverstand ziehen, falls die Aktion halb durchlief.
      broadcast();
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }
  return sendJson(res, 404, { error: 'Unbekannter Endpunkt' });
}

async function serveFile(res, full) {
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    const stream = createReadStream(full);
    // Ohne diesen Handler beendet ein Lesefehler nach gesendetem Header den Prozess.
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'Nicht gefunden');
  }
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    // Nicht destroy(): sonst stirbt die Verbindung, bevor die Fehlermeldung
    // beim Editor ankommt, und der Nutzer sieht nur „Speichern fehlgeschlagen".
    const stop = () => {
      req.pause();
      req.removeAllListeners('data');
      reject(tooLarge());
    };

    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) return stop();
    // Als Buffer sammeln: an einer Chunk-Grenze mitten in einem Umlaut würde
    // stückweises Dekodieren die Zeichen zerstören.
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return stop();
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const roh = text ? JSON.parse(text) : {};
        // `null`, `[1,2,3]` und `"hallo"` sind gültiges JSON, aber kein
        // Aufruf. Ohne diese Zeile lief `body.clientId` auf `null` in eine
        // Ausnahme, und der Server antwortete mit 500 und dem englischen
        // Wortlaut der JS-Fehlermeldung – als einzige Stelle, die keine
        // ordentliche Antwort gab. Jetzt landen sie beim üblichen
        // „Unbekannte Aktion".
        resolve(roh && typeof roh === 'object' && !Array.isArray(roh) ? roh : {});
      } catch {
        reject(new Error('Ungültiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tooLarge() {
  const err = new Error(
    `Zu groß (über ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB). Große Bilder besser in data/bilder ablegen und als "/bilder/name.jpg" eintragen.`,
  );
  err.statusCode = 413;
  return err;
}

function localUrls() {
  // Die Tunneladresse zuerst: Läuft ein Tunnel, ist sie die einzige, die auch
  // von außerhalb des WLANs trägt – und der QR-Code nimmt immer die erste.
  const out = tunnelAdresse ? [tunnelAdresse] : [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(`http://${net.address}:${PORT}`);
    }
  }
  return out.length ? out : [`http://localhost:${PORT}`];
}

/** Die Adresse des Host-Screens – mit Hostschlüssel, falls ein Tunnel läuft. */
function hostAdresse(basis = `http://localhost:${PORT}`, seite = '/host') {
  return zugang ? `${basis}${seite}?h=${zugang.host}` : `${basis}${seite}`;
}

// Ohne diese Werte baut jeder Buzz-POST in der Regel eine neue Verbindung auf.
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

/**
 * Ist der Port belegt, den nächsten nehmen – bis zu zehnmal.
 *
 * „Port 3000 ist schon belegt" und darunter eine Zeile, die man abtippen soll,
 * ist genau die Stelle, an der ein Spieleabend hängen bleibt: Wer das
 * Startskript doppelklickt, hat kein Terminal offen und will auch keins.
 * Ein selbst gesetzter Port bleibt unangetastet – wer PORT=8080 schreibt, meint
 * 8080, und Testläufe verlassen sich darauf.
 */
const PORT_VERSUCHE = 10;
let portVersuche = 0;

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;

  if (!PORT_GESETZT && portVersuche < PORT_VERSUCHE) {
    portVersuche += 1;
    PORT += 1;
    server.listen(PORT);
    return;
  }
  console.error(`\n  Port ${PORT} ist schon belegt.`);
  console.error('  Läuft der Server vielleicht bereits in einem anderen Fenster?');
  console.error(`  Sonst mit einem anderen Port starten:  PORT=${PORT + 1} npm start\n`);
  process.exit(1);
});

const wiederhergestellt = await restore();
if (wiederhergestellt) {
  state = wiederhergestellt;
}
// Vor dem ersten Lauschen: Sonst käme die erste Anfrage an eine Tür ohne Schloss.
if (ONLINE) zugang = await ladeZugang();

server.listen(PORT, async () => {
  console.log('\n  🎉  Quizduell für Spieleabende läuft!\n');
  if (wiederhergestellt) {
    const teams = state.teams.map((t) => `${t.name} ${t.score}`).join(' · ');
    console.log(`  Letzter Spielstand wiederhergestellt: ${teams || 'Lobby'}`);
    console.log('  „Spiel beenden" im Host-Menü verwirft ihn.\n');
  }
  console.log(`  Host-Screen (Beamer/TV):  ${hostAdresse()}`);
  for (const u of localUrls()) {
    console.log(`  Handys der Mitspieler:    ${u}`);
  }
  console.log(`  Fragen-Editor:            ${hostAdresse(`http://localhost:${PORT}`, '/editor')}\n`);
  if (!PORT_GESETZT && portVersuche > 0) {
    console.log(`  (Port ${PORT - portVersuche} war belegt – daher ${PORT}.)\n`);
  }
  // Der Bildschirm geht sofort auf, auch wenn der Tunnel noch braucht. Erst auf
  // den Tunnel zu warten hieße: ein leeres Browserfenster und ein Host, der
  // nicht weiß, ob noch etwas kommt. Die Lobby steht in der Zeit schon, Teams
  // können sich schon anlegen – und den QR-Code stellt sie selbst um, sobald
  // die Tunneladresse da ist (siehe zeigeTunnel() im Host-Screen).
  if (process.env.QUIZDUELL_BROWSER === '1') {
    oeffneImBrowser(hostAdresse());
  }
  if (ONLINE) {
    console.log('  Tunnel wird aufgebaut – das dauert ein paar Sekunden …\n');
    tunnelAdresse = await starteTunnel(PORT);
    if (tunnelAdresse) {
      console.log(`  Der Tunnel steht:         ${tunnelAdresse}`);
      console.log('  Die Mitspieler brauchen jetzt kein gemeinsames WLAN mehr – der QR-Code');
      console.log('  in der Lobby zeigt dorthin und trägt den Schlüssel schon bei sich.\n');
    }
  }
});

// Der Tunnel ist ein zweites Programm – es soll mit uns gehen, nicht ohne uns
// weiterlaufen.
for (const zeichen of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(zeichen, () => {
    stoppeTunnel();
    if (zeichen !== 'exit') process.exit(0);
  });
}
