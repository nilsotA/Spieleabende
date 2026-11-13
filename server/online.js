/*
 * Das Spiel im Netz: viele Räume, kein Laptop.
 *
 * Am Laptop (index.js) läuft ein Prozess den ganzen Abend, hält das Spiel im
 * Arbeitsspeicher und schiebt jede Änderung über eine offene Leitung auf die
 * Geräte. Im Netz – gedacht ist an Vercel – gibt es weder den Prozess noch
 * die Leitung: Jede Anfrage ist für sich, und zwischen zweien bleibt nichts
 * stehen. Deshalb:
 *
 *   - Jedes Spiel ist ein RAUM mit einem vierbuchstabigen Code. Der Bildschirm
 *     legt ihn an und bekommt dazu einen Host-Schlüssel; die Handys kommen mit
 *     dem Code hinein. In den Adressen heißen die beiden wie beim Tunnel-Spiel
 *     `k` (Spielschlüssel = Raumcode) und `h` (Host-Schlüssel, „CODE.geheim") –
 *     so kann die Oberfläche QR-Codes und Fernbedienungs-Link bauen wie bisher.
 *   - Der Raum liegt im Speicher (speicher.js). Jede Aktion holt ihn, wendet
 *     dieselben Regeln an wie am Laptop (spiel.js) und legt ihn zurück – aber
 *     nur, wenn inzwischen niemand anderes geschrieben hat.
 *   - Die Geräte fragen nach, statt zuzuhören: „Ich habe Stand 17, gibt es
 *     Neueres?" Die Frage bleibt bis zu neun Sekunden beim Server liegen und
 *     wird in dem Augenblick beantwortet, in dem sich etwas tut (`halte`).
 *     Landet der Zug in derselben Funktionsinstanz – auf Vercel der
 *     Normalfall –, weckt er die Wartenden direkt; sonst merkt es die
 *     wartende Anfrage beim nächsten kleinen Blick in den Speicher.
 *   - Wer selbst etwas tut, bekommt den neuen Stand gleich mit der Antwort
 *     und muss ihn nicht erst abholen.
 *
 * Diese Datei kennt weder Vercel noch einen bestimmten Speicher. `erzeugeOnline`
 * bekommt den Speicher gereicht und gibt eine Funktion zurück, die eine
 * gewöhnliche Node-Anfrage beantwortet – api/quizduell.js hängt sie an Vercel,
 * online-lokal.js an einen kleinen Server zum Ausprobieren und für die Tests.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import * as G from './game.js';
import { handleAction, neuerRaum, RUECKNEHMBAR } from './spiel.js';
import { listSets, loadSet, mixSet, DATA_DIR } from './questions.js';
import { leseCookie, COOKIE_SPIEL, COOKIE_HOST } from './zugang.js';

/* Ohne I und O: Die liest am Fernseher jeder Zweite als 1 und 0. */
const CODE_ZEICHEN = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LAENGE = 4;

/* So lange gilt ein Gerät als da, nachdem es sich zuletzt gemeldet hat. Die
   Geräte melden sich etwa alle acht Sekunden – drei verpasste Meldungen sind
   ein gesperrtes Handy und kein Funkloch mehr. */
const DA_FRIST_MS = 25000;
/* Was länger still war, fliegt aus der Geräteliste. */
const GERAET_VERGESSEN_MS = 6 * 60 * 60 * 1000;
/* Wie am Laptop: Nach zwölf Stunden ohne Zug ist der Abend vorbei, und der
   Raum fängt leer an – das Gedächtnis über gespielte Kategorien bleibt. */
const ABEND_VORBEI_MS = 12 * 60 * 60 * 1000;
/* Ein eingebettetes Bild muss als Ganzes in eine Anfrage an den Speicher
   passen. Upstash nimmt im freien Tarif ein Megabyte je Anfrage. */
const BILD_MAX_ZEICHEN = 900000;
const SIGNALE_MAX = 8;
const GEHEIMNISSE_MAX = 200;
const SCHREIB_VERSUCHE = 8;
/* So lange bleibt eine Nachfrage höchstens liegen. Unter der Laufzeitgrenze
   der Funktion (vercel.json) und über dem Abstand, in dem sich die Geräte
   ohnehin melden. */
const HALTE_MAX_MS = 9000;
/* In diesem Abstand sieht eine liegende Nachfrage selbst im Speicher nach –
   für den Fall, dass der Zug in einer anderen Instanz ankam. Das Gerät nennt
   seinen Wunsch (während einer Frage kürzer), der Server hält ihn in Grenzen. */
const NACHSEHEN_MIN_MS = 400;
const NACHSEHEN_MAX_MS = 5000;
/* Weckt diese Instanz ihre Wartenden nachweislich selbst, darf der Blick in
   den Speicher seltener werden – er ist dann nur noch das Netz unter dem Seil.
   Fällt doch einmal eine fremde Änderung auf, gilt zehn Minuten wieder der
   kurze Abstand. */
const NACHSEHEN_GELASSEN = 3;
const FREMD_FRIST_MS = 10 * 60 * 1000;
/* So viele Räume behält eine Instanz im Kopf (siehe `gedaechtnis`). */
const GEDAECHTNIS_MAX = 40;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const MIME_BILD = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

function neuerCode() {
  const roh = randomBytes(CODE_LAENGE);
  let out = '';
  for (let i = 0; i < CODE_LAENGE; i++) out += CODE_ZEICHEN[roh[i] % CODE_ZEICHEN.length];
  return out;
}

/** Vergleich ohne frühen Abbruch – die Dauer verrät nicht, wie viel stimmte. */
function gleich(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function codeAus(text) {
  const code = String(text || '').trim().toUpperCase();
  return /^[A-Z]{4}$/.test(code) ? code : null;
}

/*
 * Der Rückweg trägt in jedem Eintrag einen ganzen Spielstand – und in jedem
 * Spielstand den ganzen Fragensatz, zehn von sechzehn Kilobyte. Der ändert
 * sich aber fast nie (nur beim Kategorietausch). Gleicht er dem des laufenden
 * Stands, wird beim Ablegen nur ein Verweis geschrieben.
 */
function packeWeg(weg, state) {
  const jetzt = JSON.stringify(state.questionSet ?? null);
  return weg.map((e) => (JSON.stringify(e.state.questionSet ?? null) === jetzt
    ? { ...e, state: { ...e.state, questionSet: '=' } }
    : e));
}
function entpackeWeg(roh, state) {
  return roh.map((e) => (e.state.questionSet === '='
    ? { ...e, state: { ...e.state, questionSet: structuredClone(state.questionSet) } }
    : e));
}

function frischerRaum(code, jetzt) {
  return {
    code,
    hostGeheim: randomBytes(18).toString('base64url'),
    rev: 0,
    nummer: 1,
    geaendertAm: jetzt,
    state: G.createState(),
    gezeigteBilder: [],
    gespielt: {},
    heuteGemerkt: [],
    geheim: {},
    bewiesen: [],
    signale: [],
    signalNr: 0,
    wartende: 0,
    wegKopf: { tiefe: 0, was: null },
  };
}

export function erzeugeOnline({ speicher, jetzt = () => Date.now(), bau = 'online', oeffentlich = '' }) {
  const instanz = randomBytes(4).toString('hex');

  /* ----------------------------------------------- Was die Instanz behält
   *
   * Verlassen darf sich das Spiel auf nichts davon: Die nächste Anfrage kann
   * woanders landen. Aber solange sie hier landet, spart es Wege.
   *
   * `gedaechtnis`: der Raum, wie diese Instanz ihn zuletzt gelesen oder
   * geschrieben hat. Ein Zug rechnet zuerst damit und schreibt – das Schreiben
   * prüft ohnehin die Fassung. Stimmt sie, hat der Zug eine Reise zum Speicher
   * gebraucht statt zweier. Stimmt sie nicht (oder endet der Zug mit einem
   * Fehler, der an einem veralteten Stand liegen könnte), wird frisch gelesen
   * und noch einmal gerechnet. Gültig wird also nie etwas, das auf einem alten
   * Stand beruht.
   *
   * `wartende`: die liegenden Nachfragen je Raum.
   * `lage`: ob diese Instanz Züge des Raums selbst sieht und wann zuletzt eine
   * Änderung an ihr vorbeiging.
   */
  const gedaechtnis = new Map(); // code -> { rev, json, wegJson }
  const wartende = new Map(); // code -> Set<(daten) => void>
  const lage = new Map(); // code -> { eigene, fremdAm }

  function merke(code, daten, wegJson) {
    gedaechtnis.delete(code);
    gedaechtnis.set(code, { rev: daten.rev, json: JSON.stringify(daten), wegJson });
    if (gedaechtnis.size > GEDAECHTNIS_MAX) {
      const aeltester = gedaechtnis.keys().next().value;
      gedaechtnis.delete(aeltester);
      lage.delete(aeltester);
    }
  }
  /** Frisch gelesen. Der Rückweg im Kopf gilt weiter, wenn die Fassung dieselbe ist. */
  function merkeGelesen(code, daten, weg) {
    const alt = gedaechtnis.get(code);
    merke(code, daten, weg !== undefined
      ? JSON.stringify(weg)
      : (alt && alt.rev === daten.rev ? alt.wegJson : undefined));
  }
  /** Schreibt – und behält bei Erfolg, was jetzt im Speicher steht. */
  async function lege(code, erwartet, daten, weg) {
    if (!await speicher.schreibe(code, erwartet, daten, weg)) {
      gedaechtnis.delete(code);
      return false;
    }
    const alt = gedaechtnis.get(code);
    merke(code, daten, weg !== undefined
      ? JSON.stringify(weg)
      : (alt && alt.rev === erwartet ? alt.wegJson : undefined));
    return true;
  }

  const lageVon = (code) => {
    if (!lage.has(code)) lage.set(code, { eigene: false, fremdAm: -Infinity });
    return lage.get(code);
  };

  /** Der Raum hat einen neuen sichtbaren Stand – wer hier wartet, bekommt ihn. */
  function wecke(code, daten) {
    lageVon(code).eigene = true;
    const menge = wartende.get(code);
    if (menge) for (const fn of [...menge]) fn(daten);
  }

  /**
   * Lässt eine Nachfrage liegen, bis sich der Raum ändert.
   *
   * Ergebnis: `{ daten }` – hier geweckt, der neue Stand liegt bei;
   * `{ neu: true }` – der Blick in den Speicher zeigt eine andere Nummer;
   * `{}` – die Zeit ist um, nichts geschehen.
   */
  function halte(code, seit, dauer, takt, res) {
    return new Promise((fertig) => {
      let erledigt = false;
      let zeit = null;
      const menge = wartende.get(code) || new Set();
      wartende.set(code, menge);
      const ende = (was) => {
        if (erledigt) return;
        erledigt = true;
        clearTimeout(zeit);
        clearTimeout(frist);
        menge.delete(geweckt);
        if (!menge.size && wartende.get(code) === menge) wartende.delete(code);
        res.off?.('close', aufgelegt);
        fertig(was);
      };
      const geweckt = (daten) => ende({ daten });
      const aufgelegt = () => ende({});
      const abstand = () => {
        const l = lageVon(code);
        const gelassen = l.eigene && jetzt() - l.fremdAm > FREMD_FRIST_MS;
        return Math.min(NACHSEHEN_MAX_MS, takt * (gelassen ? NACHSEHEN_GELASSEN : 1));
      };
      const siehNach = async () => {
        try {
          const kopf = await speicher.kopf(code);
          if (erledigt) return;
          if (!kopf || kopf.nummer !== seit) {
            lageVon(code).fremdAm = jetzt();
            return ende({ neu: true });
          }
        } catch {
          /* der Speicher hakt – beim nächsten Blick noch einmal */
        }
        if (!erledigt) zeit = setTimeout(siehNach, abstand());
        return undefined;
      };
      menge.add(geweckt);
      res.on?.('close', aufgelegt);
      const frist = setTimeout(() => ende({}), dauer);
      zeit = setTimeout(siehNach, abstand());
    });
  }

  /* ------------------------------------------------------------ Antworten */

  function sende(res, code, type, body, kopf = {}) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...kopf });
    res.end(body);
  }
  const json = (res, code, obj) => sende(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

  async function liesJson(req) {
    // Vercel hat den Körper schon gelesen und hängt ihn als `req.body` an.
    if (req.body !== undefined) {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
      return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    }
    const teile = [];
    let groesse = 0;
    for await (const teil of req) {
      groesse += teil.length;
      if (groesse > MAX_BODY_BYTES) {
        const err = new Error('Zu groß für das Spiel im Netz (über 4 MB). Bilder besser verkleinern.');
        err.statusCode = 413;
        throw err;
      }
      teile.push(teil);
    }
    const text = Buffer.concat(teile).toString('utf8');
    const roh = text ? JSON.parse(text) : {};
    return roh && typeof roh === 'object' && !Array.isArray(roh) ? roh : {};
  }

  /* -------------------------------------------------------------- Ausweis */

  /**
   * In welchen Raum will diese Anfrage, und mit welchem Recht?
   *
   * Der Host-Schlüssel hat die Form „CODE.geheim" und nennt seinen Raum
   * selbst – die Fernbedienung bekommt nur ihn. Wer als Host auftritt, landet
   * deshalb im Raum seines Host-Schlüssels; alle anderen in dem des Codes.
   * Ob der Schlüssel stimmt, zeigt sich erst am geladenen Raum (`istHost`).
   */
  function ausweis(req, url, willHost, body = {}) {
    const h = String(url.searchParams.get('h') || body.h || leseCookie(req, COOKIE_HOST) || '');
    const k = url.searchParams.get('k') || body.k || leseCookie(req, COOKIE_SPIEL) || '';
    const punkt = h.indexOf('.');
    const hostCode = punkt > 0 ? codeAus(h.slice(0, punkt)) : null;
    const hostGeheim = punkt > 0 ? h.slice(punkt + 1) : '';
    if (willHost && hostCode) return { code: hostCode, hostGeheim, h };
    return { code: codeAus(k), hostGeheim: '', h: '' };
  }

  const keinRaum = (res, text = 'Diesen Raum gibt es nicht (mehr).') => json(res, 404, { error: text, keinRaum: true });

  /* --------------------------------------------------------------- Sichten */

  function sichtFuer(daten, { isHost, clientId }) {
    const sicht = G.viewFor(daten.state, { isHost, clientId });
    if (isHost) {
      sicht.rueckgaengig = daten.wegKopf?.was ?? null;
      sicht.rueckwegTiefe = daten.wegKopf?.tiefe ?? 0;
      sicht.wiederhergestellt = null;
      sicht.sicherungFehler = null;
      sicht.gemerkt = Object.keys(daten.gespielt || {}).length;
      sicht.wartende = daten.wartende || 0;
      // Der Host-Screen fragt hiermit, ob Gäste von außen hereinkommen.
      sicht.tunnel = true;
    }
    sicht.nummer = daten.nummer;
    sicht.raum = daten.code;
    sicht.signale = (daten.signale || []).filter((s) => isHost || !s.nurHost);
    if (clientId && !daten.bewiesen.includes(clientId) && daten.geheim[clientId]) {
      sicht.geheim = daten.geheim[clientId];
    }
    // Eingebettete Bilder liegen im Netz unter einer Adresse ohne Unterpfad.
    return JSON.stringify(sicht).replace(/"\/api\/bild\/([\w-]+)"/g, '"/api/bild?id=$1"');
  }

  /* ---------------------------------------------------------- Raumpflege */

  /** Nach zwölf stillen Stunden beginnt der Raum leer – wie am Laptop. */
  function abendVorbei(daten) {
    if (jetzt() - (daten.geaendertAm || 0) < ABEND_VORBEI_MS) return false;
    if (daten.state.phase === 'lobby' && !daten.state.teams.length) return false;
    daten.state = G.createState();
    daten.gezeigteBilder = [];
    daten.heuteGemerkt = [];
    daten.signale = [];
    daten.wartende = 0;
    daten.wegKopf = { tiefe: 0, was: null };
    return true;
  }

  /**
   * Wer ist da? Gleicht die Meldungen der Geräte mit dem Spielstand ab.
   *
   * Am Laptop merkt der Server am Auflegen der Leitung, dass ein Handy weg
   * ist. Hier gibt es keine Leitung – nur die Zeit seit der letzten Meldung.
   * Geändert wird der Raum nur, wenn sich wirklich etwas dreht; sonst würde
   * jede Meldung alle Geräte zum Neuladen bringen.
   */
  function gleicheAnwesenheitAb(daten, geraete) {
    const nun = jetzt();
    const da = (id) => !!geraete[id] && nun - geraete[id].zeit < DA_FRIST_MS;
    let neu = false;
    const imTeam = new Set();
    for (const team of daten.state.teams) {
      for (const m of team.members) {
        imTeam.add(m.clientId);
        const online = da(m.clientId);
        if ((m.online !== false) !== online) {
          G.setMemberOnline(daten.state, m.clientId, online);
          neu = true;
        }
      }
    }
    // Handys, die den Code schon gescannt haben, aber noch in keinem Team stehen.
    let wartende = 0;
    for (const [id, g] of Object.entries(geraete)) {
      if (!g.host && !imTeam.has(id) && da(id)) wartende += 1;
    }
    if (wartende !== (daten.wartende || 0)) {
      daten.wartende = wartende;
      neu = true;
    }
    return neu;
  }

  function vergissAlteGeheimnisse(daten) {
    const ids = Object.keys(daten.geheim);
    if (ids.length <= GEHEIMNISSE_MAX) return;
    const gebraucht = new Set(daten.state.teams.flatMap((t) => t.members.map((m) => m.clientId)));
    for (const id of ids) {
      if (Object.keys(daten.geheim).length <= GEHEIMNISSE_MAX / 2) break;
      if (gebraucht.has(id)) continue;
      delete daten.geheim[id];
      daten.bewiesen = daten.bewiesen.filter((b) => b !== id);
    }
  }

  /* ------------------------------------------------------------ Endpunkte */

  async function raumAnlegen(res) {
    for (let i = 0; i < 20; i++) {
      const daten = frischerRaum(neuerCode(), jetzt());
      if (await speicher.schreibe(daten.code, -1, daten, [])) {
        return json(res, 200, { ok: true, k: daten.code, h: `${daten.code}.${daten.hostGeheim}` });
      }
    }
    return json(res, 503, { ok: false, error: 'Gerade ließ sich kein Raum anlegen – bitte noch einmal versuchen.' });
  }

  async function info(req, res, url) {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    // Vercel gibt jedem Projekt mehrere Adressen, und nur die Hauptadresse ist
    // ohne Vercel-Anmeldung erreichbar. Öffnet der Host seinen Bildschirm über
    // eine der anderen (er selbst ist ja angemeldet), führte der QR-Code die
    // Gäste vor eine Anmeldeseite. Deshalb: die öffentliche, wenn bekannt.
    const out = { raeume: true, bau, urls: [oeffentlich || `${proto}://${host}`], port: null };
    const alsHost = ausweis(req, url, true);
    if (alsHost.hostGeheim) {
      const daten = await speicher.lade(alsHost.code);
      if (daten && gleich(alsHost.hostGeheim, daten.hostGeheim)) {
        out.schluessel = daten.code;
        out.hostSchluessel = alsHost.h;
        return json(res, 200, out);
      }
    }
    const alsGast = ausweis(req, url, false);
    if (alsGast.code && await speicher.kopf(alsGast.code)) out.schluessel = alsGast.code;
    return json(res, 200, out);
  }

  async function zustand(req, res, url) {
    const clientId = url.searchParams.get('clientId') || '';
    const willHost = url.searchParams.get('role') === 'host';
    const wer = ausweis(req, url, willHost);
    if (!wer.code) return keinRaum(res, 'Kein Raum gewählt.');
    // Mit Meldung genügt die Meldung selbst als Lebenszeichen des Raums: Sie
    // sagt auch, ob es ihn gibt. Das spart einen Lesezugriff je Meldung – im
    // Gratis-Kontingent von Upstash zählt jeder Befehl.
    const puls = !!clientId && url.searchParams.has('puls');
    const geraete = puls ? await speicher.puls(wer.code, clientId, willHost) : null;
    if (puls && !geraete) return keinRaum(res);
    const kopf = puls ? null : await speicher.kopf(wer.code);
    if (!puls && !kopf) return keinRaum(res);
    const seit = url.searchParams.has('seit') ? Number(url.searchParams.get('seit')) : NaN;
    const zahl = (name, vor) => {
      const n = Number(url.searchParams.get(name));
      return Number.isFinite(n) && n > 0 ? n : vor;
    };
    const warte = Number.isNaN(seit) ? 0 : Math.min(HALTE_MAX_MS, zahl('warte', 0));
    const takt = Math.max(NACHSEHEN_MIN_MS, Math.min(NACHSEHEN_MAX_MS, zahl('takt', 1000)));
    const nichtsNeues = () => json(res, 200, { unveraendert: true, nummer: seit });

    /**
     * Liest den Raum, bringt Anwesenheit und Geheimnis in Ordnung und
     * antwortet. Gibt true zurück, statt zu antworten, wenn das Gerät den
     * Stand schon hat und warten möchte.
     */
    async function frisch(gemeldet) {
      for (let versuch = 0; versuch < SCHREIB_VERSUCHE; versuch++) {
        const daten = await speicher.lade(wer.code);
        if (!daten) return keinRaum(res);
        const isHost = willHost && gleich(wer.hostGeheim, daten.hostGeheim);
        const rev = daten.rev;

        const vorbei = abendVorbei(daten);
        let sichtbar = vorbei;
        let still = false; // Änderungen, die niemand auf dem Bildschirm sieht
        if (gemeldet && gleicheAnwesenheitAb(daten, gemeldet)) sichtbar = true;
        if (clientId && !daten.geheim[clientId]) {
          daten.geheim[clientId] = randomUUID();
          vergissAlteGeheimnisse(daten);
          still = true;
        }
        if (sichtbar || still) {
          daten.rev = rev + 1;
          if (sichtbar) daten.nummer += 1;
          if (vorbei) daten.geaendertAm = jetzt();
          if (!await lege(wer.code, rev, daten, vorbei ? [] : undefined)) continue;
          if (sichtbar) wecke(wer.code, daten);
        } else {
          merkeGelesen(wer.code, daten);
        }
        if (gemeldet) {
          const alt = Object.entries(gemeldet)
            .filter(([, g]) => jetzt() - g.zeit > GERAET_VERGESSEN_MS).map(([id]) => id);
          if (alt.length) await speicher.vergissGeraete(wer.code, alt);
        }
        if (seit === daten.nummer) return warte ? true : nichtsNeues();
        return sende(res, 200, 'application/json; charset=utf-8', sichtFuer(daten, { isHost, clientId }));
      }
      return json(res, 503, { error: 'Gerade ist zu viel los – gleich noch einmal.' });
    }

    // Der billige Weg: nichts Neues, keine Meldung – ein einziger Lesezugriff.
    if (geraete || seit !== kopf.nummer) {
      if (await frisch(geraete) !== true) return undefined;
    } else if (!warte) {
      return nichtsNeues();
    }

    // Das Gerät hat den Stand schon. Die Frage bleibt liegen, bis sich etwas tut.
    const was = await halte(wer.code, seit, warte, takt, res);
    if (was.daten && was.daten.nummer !== seit && (!clientId || was.daten.geheim[clientId])) {
      const isHost = willHost && gleich(wer.hostGeheim, was.daten.hostGeheim);
      return sende(res, 200, 'application/json; charset=utf-8', sichtFuer(was.daten, { isHost, clientId }));
    }
    if (!was.daten && !was.neu) return nichtsNeues();
    if (await frisch(null) === true) return nichtsNeues();
    return undefined;
  }

  async function aktion(req, res, url) {
    let body;
    try {
      body = await liesJson(req);
    } catch (err) {
      return json(res, err.statusCode || 400, { ok: false, error: err.statusCode ? err.message : 'Ungültiges JSON' });
    }
    const clientId = String(body.clientId || '');
    const type = String(body.type || '');
    const willHost = body.role === 'host';
    const wer = ausweis(req, url, willHost, body);
    if (!wer.code) return keinRaum(res, 'Kein Raum gewählt.');

    const wegNoetig = RUECKNEHMBAR.has(type) || type === 'undo' || type === 'discard';
    for (let versuch = 0; versuch < SCHREIB_VERSUCHE; versuch++) {
      // Erst mit dem Stand rechnen, den diese Instanz im Kopf hat – siehe
      // `gedaechtnis`. Geht das schief, gleich noch einmal mit frisch gelesenem.
      const imKopf = versuch === 0 ? gedaechtnis.get(wer.code) : null;
      const vermutet = !!imKopf && (!wegNoetig || imKopf.wegJson !== undefined);
      let daten;
      let wegRoh;
      if (vermutet) {
        daten = JSON.parse(imKopf.json);
        wegRoh = imKopf.wegJson !== undefined ? JSON.parse(imKopf.wegJson) : undefined;
      } else if (wegNoetig) {
        ({ daten, weg: wegRoh } = await speicher.ladeMitWeg(wer.code));
        if (daten) merkeGelesen(wer.code, daten, wegRoh);
      } else {
        daten = await speicher.lade(wer.code);
        if (daten) merkeGelesen(wer.code, daten);
      }
      if (!daten) return keinRaum(res);
      const isHost = willHost && gleich(wer.hostGeheim, daten.hostGeheim);
      const rev = daten.rev;
      const veraltetVielleicht = () => {
        gedaechtnis.delete(wer.code);
        return vermutet;
      };

      // Niemand handelt für ein fremdes Handy – siehe `geheimnisse` in index.js.
      const erwartet = daten.geheim[clientId];
      if (erwartet && erwartet !== body.geheim) {
        if (veraltetVielleicht()) continue;
        return json(res, 200, { ok: false, error: 'Dieses Gerät gehört jemand anderem.' });
      }
      if (erwartet && !daten.bewiesen.includes(clientId)) daten.bewiesen.push(clientId);

      const vorbei = abendVorbei(daten);
      const brauchtWeg = !vorbei && wegNoetig;
      const platzhalter = [];
      const offen = []; // was nebenher noch in den Speicher soll
      const raum = neuerRaum({
        hostToast: (text, level = 'ok') => signal(daten, 'toast', { text, level }, true),
        ereignis: (name, payload) => signal(daten, name, payload, false),
        sichereBilder: () => {
          const lauf = (async () => {
            for (const [id, bild] of raum.bilder) {
              const data = bild.buffer.toString('base64');
              if (data.length > BILD_MAX_ZEICHEN) {
                throw new G.GameError('Ein Bild in diesem Satz ist zu groß für das Spiel im Netz (höchstens etwa 650 kB je Bild).');
              }
              await speicher.setzeBild(wer.code, id, { type: bild.type, data });
            }
          })();
          offen.push(lauf.catch(() => {}));
          return lauf;
        },
      });
      raum.state = daten.state;
      raum.rueckWeg = brauchtWeg ? entpackeWeg(wegRoh || [], daten.state) : platzhalter;
      raum.gezeigteBilder = new Set(daten.gezeigteBilder);
      raum.gespielt = daten.gespielt || {};
      raum.heuteGemerkt = new Set(daten.heuteGemerkt);

      try {
        await handleAction(raum, clientId, body, isHost);
        await Promise.all(offen);
      } catch (err) {
        // „Du bist nicht dran" kann am alten Stand liegen – frisch nachrechnen.
        if (veraltetVielleicht()) continue;
        if (!(err instanceof G.GameError)) {
          console.error(err);
          return json(res, 500, { ok: false, error: err.message });
        }
        return json(res, 200, { ok: false, error: err.message });
      }

      daten.state = raum.state;
      daten.gezeigteBilder = [...raum.gezeigteBilder];
      daten.gespielt = raum.gespielt;
      daten.heuteGemerkt = [...raum.heuteGemerkt];
      const wegNeu = vorbei || brauchtWeg || raum.rueckWeg !== platzhalter || platzhalter.length > 0;
      if (wegNeu) {
        daten.wegKopf = { tiefe: raum.rueckWeg.length, was: raum.rueckWeg.at(-1)?.was ?? null };
      }
      daten.rev = rev + 1;
      daten.nummer += 1;
      daten.geaendertAm = jetzt();
      const geschrieben = await lege(
        wer.code, rev, daten, wegNeu ? packeWeg(raum.rueckWeg, raum.state) : undefined,
      );
      if (geschrieben) {
        wecke(wer.code, daten);
        // Der neue Stand reist gleich mit zurück – das Gerät, das gehandelt
        // hat, muss ihn nicht erst abholen.
        return sende(res, 200, 'application/json; charset=utf-8',
          `{"ok":true,"nummer":${daten.nummer},"sicht":${sichtFuer(daten, { isHost, clientId })}}`);
      }
      // Jemand war schneller. Neu lesen und noch einmal – der zweite Buzz
      // sieht dann, dass schon einer dran ist.
    }
    return json(res, 200, { ok: false, error: 'Gerade ist zu viel los – bitte noch einmal tippen.' });
  }

  /** Kurzes Signal an die Geräte: Meldung an den Host oder der Buzz-Ton. */
  function signal(daten, name, payload, nurHost) {
    daten.signalNr = (daten.signalNr || 0) + 1;
    daten.signale = [...(daten.signale || []), { id: daten.signalNr, name, daten: payload, nurHost, am: jetzt() }]
      .slice(-SIGNALE_MAX);
  }

  async function bild(req, res, url) {
    const wer = ausweis(req, url, url.searchParams.get('role') === 'host');
    const alt = wer.code ? null : ausweis(req, url, true);
    const code = wer.code || alt?.code;
    const id = String(url.searchParams.get('id') || '');
    const eintrag = code && /^[\w-]+$/.test(id) ? await speicher.bild(code, id) : null;
    if (!eintrag) return json(res, 404, { error: 'Bild nicht gefunden' });
    return sende(res, 200, eintrag.type, Buffer.from(eintrag.data, 'base64'), { 'Cache-Control': 'max-age=3600' });
  }

  /** Bilddateien aus data/bilder – die Flaggen der mitgelieferten Sätze. */
  async function datei(res, name) {
    const sauber = path.basename(String(name || ''));
    const typ = MIME_BILD[path.extname(sauber).toLowerCase()];
    if (!sauber || !typ) return json(res, 404, { error: 'Nicht gefunden' });
    try {
      const inhalt = await readFile(path.join(DATA_DIR, 'bilder', sauber));
      return sende(res, 200, typ, inhalt, { 'Cache-Control': 'max-age=86400' });
    } catch {
      return json(res, 404, { error: 'Nicht gefunden' });
    }
  }

  /**
   * Beantwortet eine Anfrage. `pfad` ist der Teil hinter /api/ – auf Vercel
   * kommt er als Abfrageteil `pfad=…`, weil dort eine einzige Funktion alle
   * Adressen bedient.
   */
  return async function behandle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return json(res, 400, { error: 'Ungültige Adresse' });
    }
    // Vercel hängt die umgeschriebenen Angaben je nach Laufzeit an die Adresse
    // oder nur an `req.query` – beides gilt.
    const ausAnfrage = (name) => url.searchParams.get(name)
      ?? (typeof req.query?.[name] === 'string' ? req.query[name] : null);
    let pfad = ausAnfrage('pfad');
    if (pfad == null) {
      if (url.pathname.startsWith('/bilder/')) return datei(res, url.pathname.slice('/bilder/'.length));
      pfad = url.pathname.replace(/^\/api\//, '');
    }
    pfad = pfad.replace(/^\/+|\/+$/g, '');
    const m = req.method;
    try {
      if (pfad === 'laeuft') return json(res, 200, { quizduell: true, raeume: true, instanz });
      if (pfad === 'info' && m === 'GET') return await info(req, res, url);
      if (pfad === 'raum' && m === 'POST') return await raumAnlegen(res);
      if (pfad === 'state' && m === 'GET') return await zustand(req, res, url);
      if (pfad === 'action' && m === 'POST') return await aktion(req, res, url);
      if (pfad === 'bild' && m === 'GET') return await bild(req, res, url);
      if (pfad === 'datei' && m === 'GET') return await datei(res, ausAnfrage('name'));
      if (pfad === 'sets' && m === 'GET') return json(res, 200, await listSets());
      if (pfad === 'mix' && m === 'GET') return json(res, 200, await mixSet());
      if (pfad === 'set' && m === 'GET') {
        try {
          return json(res, 200, await loadSet(url.searchParams.get('file')));
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (pfad === 'sets' && m === 'POST') {
        // Im Netz gibt es keine Platte, auf der ein Satz liegen bleiben könnte.
        return json(res, 200, {
          ok: false,
          error: 'Im Netz-Spiel lassen sich Sätze nicht auf dem Server speichern. '
            + 'Lade den Satz als Datei herunter und wähle ihn in der Lobby über „Datei laden …“.',
        });
      }
      // Die offene Leitung des Laptop-Servers gibt es hier nicht. 204 heißt für
      // den Browser: nicht noch einmal versuchen.
      if (pfad === 'events') return sende(res, 204, 'text/plain', '');
      return json(res, 404, { error: 'Unbekannter Endpunkt' });
    } catch (err) {
      console.error(err);
      return json(res, 500, { error: err.message });
    }
  };
}
