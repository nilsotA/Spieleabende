import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import * as G from './game.js';
import { handleAction as spielAktion, merkeBild } from './spiel.js';
import { listSets, loadSet, normalizeSet, setExists, mixSet, DATA_DIR } from './questions.js';
import { oeffne as oeffneImBrowser } from './browser.js';
import { starteTunnel, stoppeTunnel } from './tunnel.js';
import { neuerZugang, pruefeZugang, cookieKoepfe, ueberHttps, TUER_ZU } from './zugang.js';
import { nodeZuAlt } from './node-version.js';

/*
 * Vor allem anderen: Läuft das Spiel auf diesem Node überhaupt?
 *
 * Auf einem zu alten startet der Server, die Lobby geht auf, Teams legen sich
 * an – und beim ersten Feld, das jemand aufruft, ist Schluss (`structuredClone`
 * ab Node 17, `findLastIndex` ab 18, beide in `handleAction`). Lieber hier
 * aufhören, wo noch niemand im Raum sitzt.
 */
const zuAlt = nodeZuAlt(process.versions.node);
if (zuAlt) {
  console.error(zuAlt);
  process.exit(1);
}

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

/*
 * Welche Dateien aus data/bilder heute schon auf dem Brett lagen.
 *
 * Eingebettete Bilder sind nicht zu erraten: Ihre Adresse ist ein sha1-Abzug
 * des Inhalts (/api/bild/<id>, siehe questions.js). Dateien aus data/bilder
 * haben dagegen die Namen, die jemand ihnen gegeben hat – im mitgelieferten
 * Satz „Länder & Flaggen" sind das flagge-01.svg bis flagge-08.svg. Wer bei
 * der ersten Flaggenfrage in den Seitenquelltext schaut, kennt das Muster und
 * ruft die übrigen sieben einzeln auf. Damit fällt „Flaggen für
 * Fortgeschrittene" in Runde 2, wo alles doppelt zählt, ohne Nachdenken.
 *
 * Der Host bekommt weiterhin jede Datei – er baut ja das Brett. Ein Handy
 * bekommt, was schon einmal offen lag. Einmal gezeigt bleibt abrufbar: Sonst
 * verlöre ein Handy mit zäher Leitung das Bild mitten in der Frage, weil die
 * Anfrage eine Sekunde nach dem Weiterschalten ankommt.
 *
 * Greift naturgemäß nur beim Spiel über den Tunnel: Im Heimnetz ist `rolle`
 * immer 'host' (siehe die Tür weiter unten), und dort steht ohnehin jedem der
 * ganze Host-Screen samt Lösungen offen – das ist die bewusste Entscheidung,
 * kein Passwort im eigenen WLAN zu verlangen.
 */
let gezeigteBilder = new Set();


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
let sicherungFehler = null;

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow().then(() => meldeSicherung(null), (err) => meldeSicherung(err));
  }, 400);
}

/**
 * Wenn der Stand nicht auf die Platte kommt, muss es der Host erfahren.
 *
 * Der einzige Kanal war `console.error` – und das Terminal ist beim
 * Spieleabend minimiert oder steht auf einem anderen Rechner. Dass das kein
 * Kanal zum Host ist, hält dieselbe Datei achtzig Zeilen weiter oben selbst
 * fest, im Kommentar zum goldenen Balken.
 *
 * Der Fall ist keine Theorie: Gestartet wird per Doppelklick aus dem
 * entpackten Ordner – aus einem gemounteten Disk-Image, von einem
 * schreibgeschützten Stick oder bei vollgelaufener Platte ist genau dieser
 * Ordner nicht beschreibbar. Nachgestellt (EISDIR auf der Zwischendatei) lief
 * der Abend vollständig normal weiter: Teams traten bei, Fragen wurden
 * gewertet, Punkte standen auf der Leinwand – und gesichert wurde ab der
 * ersten Aktion nichts mehr. Genau dafür ist die Sicherung gebaut.
 *
 * Gemeldet wird beim Wechsel, nicht bei jedem Versuch: einmal, wenn es
 * anfängt, und einmal, wenn es wieder geht. Dazwischen steht es als roter
 * Balken auf der Leinwand – der geht nicht weg, solange es nicht geht.
 */
function meldeSicherung(err) {
  if (!err) {
    if (!sicherungFehler) return;
    sicherungFehler = null;
    hostToast('Der Spielstand wird wieder gesichert.');
    broadcast();
    return;
  }
  console.error('Spielstand konnte nicht gesichert werden:', err.message);
  const grund = err.code || err.message;
  if (sicherungFehler === grund) return;
  const erste = !sicherungFehler;
  sicherungFehler = grund;
  if (erste) {
    hostToast('Der Spielstand lässt sich nicht sichern – ein Absturz wäre jetzt das Ende des Abends.', 'error');
  }
  // Der Rundruf zeigt den Balken und stößt nebenbei den nächsten Versuch an.
  // Er läuft nicht im Kreis: Bleibt der Grund derselbe, ist oben Schluss.
  broadcast();
}

async function saveNow() {
  /*
   * Eine leere Lobby ist nichts, was man wiederherstellen möchte – und der
   * Stand soll dann auch weg sein, nicht bloß nicht überschrieben.
   *
   * Hier stand `return`. Das hielt die Datei fest: Der Host beendete das Spiel,
   * räumte die Teams weg, und auf der Platte lagen sie weiter. Gemessen –
   * Server-Lobby `[]`, Datei `[Rot, Blau]`. Über die Oberfläche gab es keinen
   * Weg mehr, den Stand loszuwerden; beim nächsten Start stand der goldene
   * Balken wieder da.
   *
   * „Spiel beenden" allein löscht ihn übrigens nicht, auch wenn es die Datei
   * kurz wegnimmt: Der Rundruf danach sichert die Lobby 400 ms später wieder,
   * diesmal mit den Teams. Das ist gewollt – wer am selben Abend einen zweiten
   * Satz spielt, soll die Namen nicht neu tippen –, und Handbuch und Terminal
   * sagen es jetzt auch so.
   */
  if (state.phase === 'lobby' && state.teams.length === 0) {
    await forgetSave();
    return;
  }
  const tmp = `${SAVE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ gespeichert: Date.now(), state }), 'utf8');
  await rename(tmp, SAVE_FILE);
}

/**
 * Eingebettete Bilder liegen sonst nur im Arbeitsspeicher – nach einem Neustart
 * wären in einem wiederhergestellten Spiel alle Bildfragen kaputt. Sie ändern
 * sich nur beim Spielstart und beim Kategorietausch, also genügt dort je ein
 * Schreibvorgang.
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
      // Stände von vor dem Einsatz kennen das Feld nicht. Ohne diesen Auffüller
      // wäre `einsatzOffen` undefined – und `!activeTeam.einsatzOffen` in
      // pickCell hieße dann „schon verbraucht": Nach einem Neustart mitten im
      // Abend wäre der Einsatz weg, ohne dass ihn jemand gesetzt hat.
      if (team.einsatzOffen === undefined) team.einsatzOffen = true;
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

/* Welche Kategorien an den letzten Abenden dran waren.
 *
 * Der Zufallsmix wusste nichts von letzter Woche und legte gern eine Kategorie
 * hin, die der ganze Tisch noch kennt – „Kategorie tauschen" half dann von
 * Hand. Jetzt merkt sich der Server jede Kategorie, aus der ein Feld gespielt
 * oder die vom Brett getauscht wurde, mit Zeitpunkt; Mix und Tausch nehmen
 * zuerst, was noch nicht dran war (siehe zuletztGespielt in questions.js).
 *
 * Anders als Spielstand und Schlüssel verfällt das nicht nach zwölf Stunden –
 * es geht ja gerade um die Abende davor. Löschen kann es der Host in der Lobby.
 */
const GESPIELT_FILE = `${SAVE_FILE.replace(/\.json$/, '')}-gespielt.json`;
let gespielt = {}; // Kategoriemarke → Zeitpunkt, zuletzt gespielt
// Was in diesem Spiel schon vermerkt ist – damit nicht jeder Zug schreibt.
let heuteGemerkt = new Set();

async function ladeGespielt() {
  try {
    const roh = JSON.parse(await readFile(GESPIELT_FILE, 'utf8'));
    if (roh && typeof roh === 'object' && !Array.isArray(roh)) {
      gespielt = Object.fromEntries(Object.entries(roh).filter(([, wann]) => Number.isFinite(wann)));
    }
  } catch {
    /* noch kein Gedächtnis, oder es ist unbrauchbar – dann fängt es neu an */
  }
}

let gespieltSichern = Promise.resolve();
function sichereGespielt() {
  // Hintereinander, nicht gleichzeitig: zwei Schreiber auf derselben
  // Zwischendatei könnten sich sonst gegenseitig das Umbenennen wegnehmen.
  gespieltSichern = gespieltSichern.then(async () => {
    const tmp = `${GESPIELT_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(gespielt), 'utf8');
    await rename(tmp, GESPIELT_FILE);
  }).catch((err) => console.error('Gespielte Kategorien nicht gesichert:', err.message));
  return gespieltSichern;
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
 * Deshalb bekommt jede Kennung beim ersten Ereignisstrom ein Geheimnis. Wer
 * eine Kennung benutzt, für die eines hinterlegt ist, muss es mitschicken.
 *
 * Herausgegeben wird es nur, solange die Kennung es noch nicht bewiesen hat –
 * siehe `geheimnisHeraus`. Solange der Server es jedem nannte, der die Kennung
 * bloß nannte, war der ganze Nachweis wirkungslos: Nachgestellt mit zwei Handys
 * am selben Server – Annas Sicht nennt ihr Berts Kennung, ein GET auf
 * /api/state?clientId=c_bert liefert Berts Geheimnis im Klartext, und damit
 * ging ein leaveTeam in Berts Namen glatt durch; Bert stand mitten im Spiel
 * ohne Team da.
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

/*
 * Kennungen, die ihr Geheimnis schon einmal vorgezeigt haben.
 *
 * Immer Teilmenge von `geheimnisse` – wer dort gelöscht wird, fliegt auch hier
 * raus, sonst bliebe ein Gerät mit einem Geheimnis zurück, das der Server nicht
 * mehr kennt und ihm auch nicht mehr sagen würde.
 */
const bewiesen = new Set();

/**
 * Das Geheimnis, das diese Anfrage mitbekommen darf – oder nichts.
 *
 * Die Gratwanderung hier hat zwei Kanten, und beide sind schon einmal
 * abgerutscht.
 *
 * Nach der einen Seite: Solange der Server es jedem nannte, der die Kennung
 * nannte, war er kein Türsteher, sondern ein Schlüsselautomat – Annas Handy
 * las Berts Kennung aus dem Spielstand ab, holte sich sein Geheimnis mit einem
 * GET und warf ihn aus seinem Team.
 *
 * Nach der anderen: Es einfach nur beim allerersten Mal herauszugeben, bricht
 * den Notweg (siehe den Test „der Notweg macht handlungsfähig"). Ein Handy,
 * dessen Ereignisstrom unterwegs hängen bleibt, hat den Server schon dazu
 * gebracht, ein Geheimnis anzulegen – gesagt bekommen hat es das nie. Genau
 * dafür gibt es die Abholung über /api/state, und die ginge dann leer aus.
 *
 * Dazwischen liegt: Wer sein Geheimnis schon einmal VORGEZEIGT hat, kennt es
 * und braucht es nie wieder gesagt zu bekommen. Wer es noch nie vorgezeigt hat,
 * hat auch noch nichts getan, das sich zu übernehmen lohnte – dieselbe
 * Nachsicht wie oben, nur an der richtigen Stelle.
 *
 * Was bleibt: Startet der Server mitten im Abend neu, sind beide Listen leer,
 * und das erste Gerät, das eine Kennung nennt, bekommt ein frisches Geheimnis
 * dafür. In den paar Sekunden, bis die echten Handys wieder da sind, ließe sich
 * eine fremde Kennung besetzen. Dafür muss man den Neustart abpassen; vorher
 * genügte ein GET zu jedem beliebigen Zeitpunkt.
 */
function geheimnisHeraus(clientId) {
  if (bewiesen.has(clientId)) return undefined;
  return geheimnisFuer(clientId);
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
    if (!gebraucht.has(id)) { geheimnisse.delete(id); bewiesen.delete(id); }
  }
  // Selbst wenn alle gebraucht werden: Der Deckel gilt trotzdem.
  for (const id of geheimnisse.keys()) {
    if (geheimnisse.size < GEHEIMNISSE_MAX) break;
    geheimnisse.delete(id);
    bewiesen.delete(id);
  }
}

/*
 * Der Vorspann des Ereignisstroms – acht Kilobyte, die sich nicht
 * zusammenfalten lassen.
 *
 * Vorher stand hier acht Kilobyte „x". Gegen einen Vermittler, der schlicht
 * Bytes zählt, hilft das; gegen einen, der unterwegs komprimiert, überhaupt
 * nicht: Achttausend gleiche Zeichen schrumpfen auf rund dreißig Byte, und die
 * Bremse löst nie. Zufällige Zeichen schrumpfen nicht. Einmal beim Start
 * gewürfelt, dann kostet er nichts mehr.
 */
const VORSPANN = randomBytes(6144).toString('base64');

function darfHandeln(clientId, mitgebracht) {
  const erwartet = geheimnisse.get(clientId);
  if (!erwartet) return true;
  if (erwartet !== mitgebracht) return false;
  // Vorgezeigt: Ab jetzt sagt der Server dieses Geheimnis niemandem mehr.
  bewiesen.add(clientId);
  return true;
}

function connectionsOf(clientId) {
  return [...connections.values()].filter((c) => c.clientId === clientId);
}

/* Geräte, die sich den Zustand einzeln abholen, statt am Strom zu hängen –
   siehe /api/state. Wer sich länger nicht meldet, gilt als weg; ohne offene
   Verbindung gibt es ja kein Auflegen, das man mitbekäme. */
const abfragen = new Map(); // clientId -> { zeit, isHost }

/** Steht dieses Gerät in einem Team und gilt dort gerade als weg? */
function giltAlsWeg(clientId) {
  return state.teams.some((t) => t.members.some(
    (m) => m.clientId === clientId && m.online === false));
}
/* Länger als der Warteraum hält (HALTE_ZEIT): Ein Handy, dessen Anfrage
   gerade offen liegt, meldet sich in dieser Zeit ja gerade nicht – es wartet.
   Dass jemand wirklich weg ist, merkt der Server schneller und genauer daran,
   dass seine wartende Anfrage auflegt. */
const ABFRAGE_FRIST = 40000;

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

/*
 * Der Warteraum – damit der Notweg sich nicht wie ein Notweg anfühlt.
 *
 * Alle anderthalb Sekunden nachzufragen ist ehrlich, aber am Spieltisch spürbar:
 * Die Frage steht auf der Leinwand, und auf dem Handy passiert eine Sekunde
 * lang nichts. Wer alle 200 ms fragt, belastet dafür Leitung und Akku, ohne das
 * Problem zu lösen – die Antwort kommt trotzdem im Schnitt eine halbe
 * Taktlänge zu spät.
 *
 * Also andersherum: Das Handy fragt und sagt dazu, welchen Stand es schon hat.
 * Ist nichts Neues da, bleibt die Anfrage einfach offen liegen – bis sich
 * wirklich etwas ändert. Dann geht sie in derselben Millisekunde hinaus, in der
 * auch die Live-Verbindung bedient wird. Aus „bis zu 1,5 Sekunden" wird „einmal
 * hin und zurück".
 *
 * Der Unterschied zum Ereignisstrom, an dem dieser ganze Abend hängt: Diese
 * Antwort endet. Ein Vermittler, der sammelt, gibt sie deshalb heraus – er
 * wartet ja nur darauf, dass sie fertig wird.
 */
let standNummer = 0;
const wartende = new Set();
/* Kürzer als jede übliche Geduld eines Vermittlers. Über die Umgebung
   verstellbar, weil ein Test sonst 25 Sekunden lang zusehen müsste – dieselbe
   Klappe wie beim Spielstandpfad und beim Tunnelprogramm. */
const HALTE_ZEIT = Number(process.env.QUIZDUELL_HALTE_MS) || 25000;

function weckeWartende() {
  if (!wartende.size) return;
  for (const w of [...wartende]) {
    wartende.delete(w);
    clearTimeout(w.timer);
    try {
      antworteMitStand(w.res, w);
    } catch {
      /* die Leitung ist weg – dann eben nicht */
    }
  }
}

function antworteMitStand(res, { isHost, clientId }) {
  const sicht = sichtFuer({ isHost, clientId });
  sicht.nummer = standNummer;
  if (clientId) {
    const geheim = geheimnisHeraus(clientId);
    if (geheim) sicht.geheim = geheim;
  }
  sendJson(res, 200, sicht);
}

function broadcast() {
  standNummer += 1;
  for (const conn of connections.values()) sendState(conn);
  weckeWartende();
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
    // Solange hier etwas steht, kommt der Spielstand nicht auf die Platte.
    sicht.sicherungFehler = sicherungFehler;
    // Wie viele Kategorien der Zufallsmix gerade meidet – steht in der Lobby.
    sicht.gemerkt = Object.keys(gespielt).length;
    sicht.wartende = warteschlange();
    // Ob der Tunnel noch steht. Der Host-Screen zeigt danach seine grüne Zeile
    // und wählt die Adresse für den QR-Code – und muss es deshalb erfahren,
    // wenn der Tunnel wegbricht. Über den Strom statt über Nachfragen: Der
    // Screen hört ohnehin zu, und Nachfragen stellt er nach einer Minute ein.
    sicht.tunnel = ONLINE ? !!tunnelAdresse : null;
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

/**
 * Dasselbe, aber nur an die Geräte des Hosts: Leinwand und Fernbedienung.
 *
 * Manches geht nur den Host etwas an – dass eine Frage ausgetauscht wurde etwa,
 * oder dass es keine Ersatzfrage mehr gab. Auf die Handys gehört das nicht:
 * Dort stünde mitten im Spiel eine Meldung über etwas, das die Mitspieler gar
 * nicht entschieden haben.
 */
function hostToast(text, level = 'ok') {
  for (const conn of connections.values()) if (conn.isHost) write(conn, 'toast', { level, text });
}

/* ---------------------------------------------------------------- Aktionen */

/*
 * Was eine Aktion bewirkt, steht in spiel.js – dort arbeitet alles auf einem
 * „Raum". Am Laptop gibt es genau einen, und er ist nichts Eigenes: nur die
 * Variablen dieser Datei, durchgereicht. So bleibt hier alles, wie es war, und
 * derselbe Code bedient im Netz viele Räume (siehe online.js).
 */
const raum = {
  get state() { return state; }, set state(v) { state = v; },
  get rueckWeg() { return rueckWeg; }, set rueckWeg(v) { rueckWeg = v; },
  get bilder() { return bilder; }, set bilder(v) { bilder = v; },
  get gezeigteBilder() { return gezeigteBilder; }, set gezeigteBilder(v) { gezeigteBilder = v; },
  get gespielt() { return gespielt; }, set gespielt(v) { gespielt = v; },
  get heuteGemerkt() { return heuteGemerkt; }, set heuteGemerkt(v) { heuteGemerkt = v; },
  get wiederhergestelltAm() { return wiederhergestelltAm; },
  set wiederhergestelltAm(v) { wiederhergestelltAm = v; },
  dienste: {
    hostToast: (text, level) => hostToast(text, level),
    ereignis: (name, daten) => broadcastEvent(name, daten),
    sichereBilder: () => saveImages(),
    vergissSicherung: () => forgetSave(),
    sichereGespielt: () => sichereGespielt(),
    geaendert: () => broadcast(),
    // Ein schlafendes Handy verliert seinen Ereignisstrom – siehe handleAction.
    hostOhneVerbindung: (clientId) => connectionsOf(clientId).length === 0,
  },
};

function handleAction(clientId, body) {
  return spielAktion(raum, clientId, body, isHostClient(clientId));
}

let rueckWeg = []; // [{ state, was, am }, …] – hinten liegt der nächste Rückschritt
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

/*
 * Seiten, hinter denen die Lösungen stehen. Bei den Schnittstellen ist die
 * Liste andersherum gedacht – alles ist Hostsache, außer den dreien, die ein
 * Handy wirklich braucht: die Live-Verbindung, sein Zug und die Adressen.
 * Ein Fragensatz (/api/set) enthält die Antworten und gehört ausdrücklich nicht
 * dazu.
 *
 * Die Dateinamen kommen aus ROUTES, nicht noch einmal von Hand: Hier standen
 * nur die Kurzadressen, und /host.html ging damit an der Tür vorbei. Gemessen
 * mit einem Spielschlüssel, wie ihn jeder Gast aus dem QR-Code hat:
 *
 *   /host         403      /host.html      200
 *   /remote       403      /remote.html    200
 *   /editor       403      /editor.html    200
 *
 * Herausgekommen ist dabei nichts – viewFor ist das eigentliche Tor, und der
 * Gast bekam dieselbe Sicht wie immer: Lösung null, Zusatz null, kein Rückweg,
 * werten abgewiesen. Es war die leere Hülle der Seite. Aber eine Tür, die nur
 * eine von zwei Schreibweisen kennt, ist keine, und wer als Nächstes eine Seite
 * dazunimmt, hätte dieselbe Lücke wieder.
 *
 * Die Skripte (/host.js und Freunde) stehen bewusst nicht in der Liste: In
 * ihnen steht keine einzige Antwort, die kommen alle über die Schnittstelle.
 */
const NUR_HOST_SEITEN = new Set(
  ['/host', '/remote', '/editor'].flatMap((kurz) => [kurz, `/${ROUTES[kurz]}`]),
);
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
    /*
     * Erst dekodieren, dann gerade ziehen – und zwar bevor irgendjemand
     * hinsieht.
     *
     * `url.pathname` ist schon aufgeräumt (`/a/../host` wird zu `/host`), aber
     * `decodeURIComponent` danach macht Zeichen wieder zu Trennern, die beim
     * Aufräumen noch keine waren. Gemessen: `/%2fhost.html` kommt als
     * `//host.html` heraus. Das steht in keiner Liste der Hostseiten, die Tür
     * winkt es mit dem Gästeschlüssel durch – und `path.join` weiter unten
     * zieht die doppelten Striche wieder zusammen und liefert host.html aus.
     * Dasselbe galt für `/%2feditor.html` und `/%2fremote.html`.
     *
     * Backslashes werden mitgeradezogen: Unter Windows ist auch `\` ein
     * Trenner für `path.join`, unter Linux nicht – sonst hängt es vom
     * Betriebssystem des Hosts ab, wer durch die Tür kommt.
     *
     * Was hier herauskommt, gilt für alles Weitere: Tür und Auslieferung
     * sehen denselben Weg. Auseinanderlaufen konnten sie genau deshalb.
     */
    pathname = decodeURIComponent(url.pathname).replace(/\\/g, '/');
    pathname = path.posix.normalize(pathname);
    if (!pathname.startsWith('/')) pathname = `/${pathname}`;
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
  /*
   * Eine Frage, die vor der Tür beantwortet wird: Läuft hier ein Quizduell?
   *
   * Gebraucht von einem zweiten Start, der sonst nicht unterscheiden kann, ob
   * auf dem Port unser eigenes Spiel sitzt oder ein fremdes Programm – und
   * der beim Raten einen zweiten Server daneben stellt, der in dieselbe Datei
   * schreibt. Verraten wird dabei nichts: Dass hier ein Quizduell läuft, sagt
   * die Fehlerseite hinter der Tür genauso. Kein Spielstand, keine Frage,
   * keine Adresse, kein Schlüssel.
   */
  if (pathname === '/api/laeuft') return sendJson(res, 200, { quizduell: true });

  let rolle;
  try {
    rolle = pruefeZugang(req, url, zugang);
    if (zugang) {
      const kekse = cookieKoepfe(url, zugang, ueberHttps(req));
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
      const datei = path.basename(pathname);
      // Siehe `gezeigteBilder`: Der Host baut das Brett und sieht alles, ein
      // Handy nur, was schon einmal offen lag.
      if (rolle !== 'host' && !gezeigteBilder.has(datei)) {
        return send(res, 404, 'text/plain; charset=utf-8', 'Nicht gefunden');
      }
      return serveFile(res, path.join(DATA_DIR, 'bilder', datei));
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
  res.write(`: ${VORSPANN}\n\n`);
  res.write('retry: 1000\n\n');

  const conn = { id: connId, res, clientId, isHost };
  connections.set(connId, conn);
  G.setMemberOnline(state, clientId, true);

  write(conn, 'hello', { clientId, isHost, geheim: geheimnisHeraus(clientId) });
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
    /*
     * Auch der Notweg ist ein Lebenszeichen – und zwar jedes Mal.
     *
     * „Erst beim Umschalten melden" war richtig gedacht und falsch geprüft:
     * Als Umschalter diente `!abfragen.has(clientId)`, und genau diesen
     * Eintrag frischt die vorletzte Zeile bei JEDER Abfrage wieder auf. Wer
     * durchgehend abfragt, kommt also nie wieder durch diese Bedingung.
     *
     * Das trifft ein Handy, das einmal über den Notweg kam, danach doch noch
     * einen Ereignisstrom bekam und den wieder verlor – der Normalfall hinter
     * einem Vermittler, der lange Antworten kappt. Der Strom meldet beim
     * Schließen offline und räumt `abfragen` nicht ab; die Abfragen danach
     * können es nicht zurücknehmen.
     *
     * Gemessen: 34 Abfragen über 51 Sekunden, also weit über der Frist von
     * 40 – durchgehend `online: false`. Hört dasselbe Gerät 45 Sekunden lang
     * auf zu fragen, räumt der Kehrbesen den Eintrag weg, und die nächste
     * Abfrage setzt es sofort wieder auf `true`. Bestraft wurde also genau
     * das Handy, das ununterbrochen erreichbar war.
     *
     * Am Tisch steht dann in der Teamzeile „Anna ⚪", im Host-Menü „Rot · 1
     * offline" und daneben der Knopf „Offline entfernen" – und der Host wirft
     * damit jemanden aus dem Team, der neben ihm sitzt und dessen Buzzer geht.
     *
     * Gefragt wird deshalb nach dem, was gemeint war: Gilt das Gerät gerade
     * als weg? Nur dann wird umgeschaltet, und nur dann geht ein Rundruf raus.
     */
    if (clientId && connectionsOf(clientId).length === 0 && giltAlsWeg(clientId)) {
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
    /*
     * Und die Wartefassung: `seit=<Nummer>` heißt „ich habe diesen Stand
     * schon". Ist nichts Neues da, bleibt die Anfrage offen liegen, bis sich
     * etwas ändert – siehe Warteraum weiter oben. Ohne `seit` antwortet der
     * Server sofort, so wie ein Handy es beim ersten Mal braucht.
     */
    const seit = Number(url.searchParams.get('seit'));
    if (Number.isFinite(seit) && seit >= standNummer) {
      const warte = { res, isHost, clientId };
      warte.timer = setTimeout(() => {
        wartende.delete(warte);
        antworteMitStand(res, warte);
      }, HALTE_ZEIT);
      req.on('close', () => {
        if (!wartende.delete(warte)) return;
        clearTimeout(warte.timer);
        // Legt ein wartendes Handy auf, ist es weg – das merkt man hier sofort
        // und muss nicht auf die Frist warten.
        if (clientId && connectionsOf(clientId).length === 0) {
          abfragen.delete(clientId);
          G.setMemberOnline(state, clientId, false);
          broadcast();
        }
      });
      wartende.add(warte);
      return undefined;
    }
    return antworteMitStand(res, { isHost, clientId });
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

/**
 * Steht auf diesem Port schon ein Quizduell – oder irgendetwas anderes?
 *
 * Das ist der ganze Unterschied zwischen „der Port ist belegt" und „das Spiel
 * läuft schon". Gefragt wird über /api/laeuft, das absichtlich vor der Tür
 * liegt: Es verrät nichts, was die Fehlerseite nicht auch verrät.
 */
async function schonEinQuizduell(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/laeuft`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    return (await res.json())?.quizduell === true;
  } catch {
    // Keine Antwort, kaputte Antwort, Zeitüberschreitung: dann eben nicht.
    return false;
  }
}

/*
 * Ein zweiter Doppelklick ist kein zweites Spiel.
 *
 * Gemessen: Wer die Startdatei zweimal anklickt – weil beim ersten Mal
 * scheinbar nichts passiert ist –, bekam einen ZWEITEN Server auf Port 3001.
 * Der Browser ging dort auf, die Lobby war leer, während die Handys der
 * Freunde am ersten Server auf 3000 hingen. Und beide schrieben in dieselbe
 * Datei auf der Platte: Die erste Aktion im zweiten Fenster ersetzte den
 * gespeicherten Stand des laufenden Abends (gemessen: aus „Rot, Blau" wurde
 * „Gruen"). Ein Absturz oder Neustart danach hätte den Abend gekostet.
 *
 * Das Weiterzählen des Ports bleibt – es ist für den Fall gedacht, dass ein
 * FREMDES Programm auf 3000 sitzt. Dann ist der nächste Port richtig. Sitzt
 * dort aber unser eigenes Spiel, ist der richtige Zug, nichts Neues
 * anzufangen und den Host dorthin zu schicken, wo sein Abend läuft.
 */
async function behandlePortBelegt() {
  if (await schonEinQuizduell(PORT)) {
    console.log('\n  Das Spiel läuft schon – in einem anderen Fenster.\n');
    console.log(`  Host-Screen (Beamer/TV):  ${hostAdresse()}`);
    console.log('\n  Dieses Fenster wird nicht gebraucht und geht gleich von selbst zu.');
    console.log(`  Wirklich ein zweites, eigenes Spiel? Dann:  PORT=${PORT + 1} npm start\n`);
    // Und der Host sieht, was er sehen wollte: den laufenden Abend.
    if (process.env.QUIZDUELL_BROWSER === '1') oeffneImBrowser(hostAdresse());
    // Kein Fehler: Der Host hat nichts falsch gemacht.
    process.exit(0);
  }

  if (!PORT_GESETZT && portVersuche < PORT_VERSUCHE) {
    portVersuche += 1;
    PORT += 1;
    server.listen(PORT);
    return;
  }
  console.error(`\n  Port ${PORT} ist schon belegt – von einem anderen Programm.`);
  console.error(`  Mit einem anderen Port starten:  PORT=${PORT + 1} npm start\n`);
  process.exit(1);
}

server.on('error', (err) => {
  // Alles außer einem belegten Port bleibt synchron: Ein Wurf in einem
  // async-Rückruf wäre eine abgelehnte Zusage ohne Fänger und käme ohne
  // brauchbare Spur heraus.
  if (err.code !== 'EADDRINUSE') throw err;
  behandlePortBelegt().catch((e) => {
    console.error(e);
    process.exit(1);
  });
});

await ladeGespielt();
const wiederhergestellt = await restore();
if (wiederhergestellt) {
  state = wiederhergestellt;
  // Stand beim Neustart eine Bildfrage offen, gehört ihr Bild sofort wieder
  // zu den gezeigten – sonst stünde auf den Handys ein leerer Rahmen.
  merkeBild(raum);
}
// Vor dem ersten Lauschen: Sonst käme die erste Anfrage an eine Tür ohne Schloss.
if (ONLINE) zugang = await ladeZugang();

server.listen(PORT, async () => {
  console.log('\n  🎉  Quizduell für Spieleabende läuft!\n');
  if (wiederhergestellt) {
    const teams = state.teams.map((t) => `${t.name} ${t.score}`).join(' · ');
    console.log(`  Letzter Spielstand wiederhergestellt: ${teams || 'Lobby'}`);
    console.log('  „Spiel beenden“ im Host-Menü macht daraus wieder eine Lobby.');
    console.log('  Wer auch die Teams entfernt, ist ihn ganz los.\n');
  }
  console.log(`  Host-Screen (Beamer/TV):  ${hostAdresse()}`);
  // Einmal fragen, zweimal verwenden: Die Liste steht unten noch einmal für die
  // Fernbedienung, und beide Male soll dieselbe Adresse dort stehen.
  const adressen = localUrls();
  for (const u of adressen) {
    console.log(`  Handys der Mitspieler:    ${u}`);
  }
  // Die Fernbedienung gehört auf das Handy des Hosts, nicht auf localhost: Dort
  // stehen Frage, Bild und Lösung, während die Leinwand die Lösung verdeckt
  // hält. Sie stand im Handbuch, aber nicht in dieser Liste – wer nur das
  // Terminal liest, hat sie schlicht nie gefunden und den Abend über die
  // unscharfe Lösung auf dem großen Screen aufgedeckt, die dann alle sahen.
  console.log(`  Fernbedienung für dich:   ${hostAdresse(adressen[0], '/remote')}`);
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
    tunnelAdresse = await starteTunnel(PORT, () => {
      // Der Tunnel ist nach dem Start weggebrochen. Die Adresse taugt ab jetzt
      // nichts mehr: Sie gehört aus /api/info heraus, damit der QR-Code wieder
      // auf das Heimnetz zeigt, und der Host gehört gewarnt.
      if (!tunnelAdresse) return;
      tunnelAdresse = null;
      console.error('\n  Der Tunnel ist weg. Gäste von außerhalb kommen nicht mehr durch;');
      console.error('  im Heimnetz läuft alles weiter. Zum Wiederaufbauen den Server neu starten.\n');
      hostToast('Der Tunnel ist weg – Gäste von außerhalb kommen nicht mehr durch. '
        + 'Im Heimnetz läuft alles weiter.', 'error');
      broadcast();
    });
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
