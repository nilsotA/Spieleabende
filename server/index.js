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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Ein selbst gesetzter Port gilt genau so. Ohne Angabe darf der Server sich
// den nächsten freien suchen: Wer das Startskript zweimal doppelklickt, soll
// nicht vor „Port belegt" und einer Kommandozeile stehen.
const PORT_GESETZT = !!process.env.PORT;
let PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MIX = '__mix'; // Kennung für das gewürfelte Board

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

function connectionsOf(clientId) {
  return [...connections.values()].filter((c) => c.clientId === clientId);
}

function isHostClient(clientId) {
  return connectionsOf(clientId).some((c) => c.isHost);
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
  return offen.size;
}

function sendState(conn) {
  const sicht = G.viewFor(state, { isHost: conn.isHost, clientId: conn.clientId });
  // Nur der Host kann zurücknehmen, also erfährt auch nur er davon.
  if (conn.isHost) {
    sicht.rueckgaengig = rueckWeg.at(-1)?.was ?? null;
    // Wie viele Schritte noch gehen – der Knopf sagt es, sonst tippt der Host
    // ins Leere und weiß nicht, ob er am Ende des Weges ist.
    sicht.rueckwegTiefe = rueckWeg.length;
    sicht.wiederhergestellt = wiederhergestelltAm;
    sicht.wartende = warteschlange();
  }
  write(conn, 'state', sicht);
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
  const bekannt = new Set(alt.teams.map((t) => t.id));
  for (const team of jetztStand.teams) {
    if (!bekannt.has(team.id)) alt.teams.push(team);
  }
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
      G.startStechen(state, await stechenFrage([...gespielt, ...(state.stechenTexte || [])]));
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

  try {
    if (pathname === '/api/events') return sseHandler(req, res, url);
    if (pathname.startsWith('/api/')) return await apiHandler(req, res, url, pathname);

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

function sseHandler(req, res, url) {
  const clientId = url.searchParams.get('clientId') || `c_${randomUUID()}`;
  const isHost = url.searchParams.get('role') === 'host';
  const connId = randomUUID();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1000\n\n');

  const conn = { id: connId, res, clientId, isHost };
  connections.set(connId, conn);
  G.setMemberOnline(state, clientId, true);

  write(conn, 'hello', { clientId, isHost });
  sendState(conn);
  broadcast(); // die anderen sehen sofort, dass jemand wieder online ist

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 20000);

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

async function apiHandler(req, res, url, pathname) {
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
    return sendJson(res, 200, { urls: localUrls(), port: PORT });
  }
  if (pathname === '/api/action' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
    }
    const clientId = String(body.clientId || '');
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
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(`http://${net.address}:${PORT}`);
    }
  }
  return out.length ? out : [`http://localhost:${PORT}`];
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

server.listen(PORT, () => {
  console.log('\n  🎉  Quizduell für Spieleabende läuft!\n');
  if (wiederhergestellt) {
    const teams = state.teams.map((t) => `${t.name} ${t.score}`).join(' · ');
    console.log(`  Letzter Spielstand wiederhergestellt: ${teams || 'Lobby'}`);
    console.log('  „Spiel beenden" im Host-Menü verwirft ihn.\n');
  }
  console.log(`  Host-Screen (Beamer/TV):  http://localhost:${PORT}/host`);
  for (const u of localUrls()) {
    console.log(`  Handys der Mitspieler:    ${u}`);
  }
  console.log(`  Fragen-Editor:            http://localhost:${PORT}/editor\n`);
  if (!PORT_GESETZT && portVersuche > 0) {
    console.log(`  (Port ${PORT - portVersuche} war belegt – daher ${PORT}.)\n`);
  }
  if (process.env.QUIZDUELL_BROWSER === '1') {
    oeffneImBrowser(`http://localhost:${PORT}/host`);
  }
});
