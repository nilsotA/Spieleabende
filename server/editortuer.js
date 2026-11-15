/*
 * Die Tür vor dem Fragen-Editor.
 *
 * Im Editor stehen alle Fragen mit allen Antworten. Wer am Spieleabend die
 * Adresse kennt, könnte sonst vor der Runde nachlesen. Deshalb fragt der
 * Editor nach einem Passwort – geprüft auf dem Server, nicht im Browser: Eine
 * Abfrage in der Seite selbst wäre mit einem Blick in den Quelltext umgangen.
 *
 * Das Passwort steht nicht im Code (das Repository ist öffentlich lesbar),
 * sondern in der Umgebungsvariable EDITOR_PASSWORT – auf Vercel unter
 * „Settings → Environment Variables“. Ist sie leer, bleibt der Editor offen
 * wie bisher.
 *
 * Nach der richtigen Eingabe bekommt der Browser einen Keks, der 30 Tage
 * gilt. Sein Inhalt ist aus dem Passwort abgeleitet (HMAC), nicht das Passwort
 * selbst; wird es geändert, verlieren alle alten Kekse ihre Gültigkeit.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { leseCookie } from './zugang.js';

export const EDITOR_KEKS = 'qd_editor';
const GUELTIG_SEK = 30 * 24 * 60 * 60;
/* Ein falsches Passwort kostet einen Moment – das bremst aber nur, wer
   nacheinander probiert. Gegen viele Versuche gleichzeitig zählt ein
   gemeinsamer Zähler: Nach 20 Fehlversuchen in 10 Minuten nimmt die Tür
   gar nichts mehr an, auch das richtige Passwort nicht. Gezählt wird für
   alle zusammen, nicht je Gerät – Adressen lassen sich leicht wechseln, und
   der Gastgeber meldet sich ohnehin selten an. Schlimmstenfalls wartet er
   zehn Minuten. */
const STRAFE_MS = 700;
const FEHL_MAX = 20;
const FEHL_FENSTER_SEK = 10 * 60;

/** Zähler im Arbeitsspeicher – am Laptop reicht der eine Prozess. */
function speicherZaehler() {
  let stand = { n: 0, bis: 0 };
  return {
    async stand() { return stand.bis > Date.now() ? stand.n : 0; },
    async fehler() {
      stand = stand.bis > Date.now() ? { n: stand.n + 1, bis: stand.bis } : { n: 1, bis: Date.now() + FEHL_FENSTER_SEK * 1000 };
    },
  };
}
const ZAEHLER_LOKAL = speicherZaehler();

/** Zähler im gemeinsamen Speicher (Upstash) – im Netz laufen viele Instanzen. */
export function zaehlerAus(speicher) {
  return {
    stand: () => speicher.zaehlerStand('editor-fehl'),
    fehler: () => speicher.zaehle('editor-fehl', FEHL_FENSTER_SEK),
  };
}

/** Das eingestellte Passwort, oder null, wenn der Editor offen sein soll. */
export function editorPasswort(env = process.env) {
  const p = String(env.EDITOR_PASSWORT ?? '').trim();
  return p || null;
}

function marke(passwort) {
  return createHmac('sha256', passwort).update('quizduell-editor-v1').digest('base64url');
}

function gleich(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Darf diese Anfrage in den Editor? Ohne eingestelltes Passwort immer. */
export function editorFrei(req, passwort) {
  if (!passwort) return true;
  const keks = leseCookie(req, EDITOR_KEKS);
  return !!keks && gleich(keks, marke(passwort));
}

function ueberHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || !!req.socket?.encrypted;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Die kleine Anmeldeseite – im Stil des Spiels, ohne eigenes Skript. */
export function anmeldeSeite(fehler = '') {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Fragen-Editor – Quizduell</title>
<link rel="icon" href="/icons/favicon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/style.css">
<style>
  body { min-height: 100vh; display: grid; place-items: center; margin: 0; padding: 1rem; box-sizing: border-box; }
  .tuer { width: min(100%, 360px); display: grid; gap: 0.8rem; text-align: center; }
  .tuer img { width: 72px; height: 72px; border-radius: 16px; margin: 0 auto; }
  .tuer h1 { margin: 0; font-size: 1.3rem; }
  .tuer p { margin: 0; }
  .tuer input { width: 100%; box-sizing: border-box; font-size: 1.05rem; min-height: 44px; text-align: center; }
  .tuer .btn { width: 100%; min-height: 44px; font-size: 1rem; }
  .tuer .fehler { color: #ff9aac; font-weight: 700; }
</style>
</head>
<body>
<form class="card tuer" method="post" action="/api/editor-login">
  <img src="/apple-touch-icon.png" alt="">
  <h1>Fragen-Editor</h1>
  <p class="muted small">Hier stehen alle Antworten – deshalb mit Passwort.</p>
  <label for="passwort" class="muted small" style="margin:0">Passwort</label>
  <input id="passwort" name="passwort" type="password" autocomplete="current-password" autofocus required>
  ${fehler ? `<p class="fehler" role="alert">${esc(fehler)}</p>` : ''}
  <button class="btn btn-primary" type="submit">Öffnen</button>
  <a class="muted small" href="/host">← zurück zum Spiel</a>
</form>
</body>
</html>`;
}

async function liesFormular(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return new URLSearchParams(req.body);
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return new URLSearchParams(req.body);
    return new URLSearchParams(String(req.body || ''));
  }
  const teile = [];
  let groesse = 0;
  for await (const teil of req) {
    groesse += teil.length;
    if (groesse > 4096) break;
    teile.push(teil);
  }
  return new URLSearchParams(Buffer.concat(teile).toString('utf8'));
}

function seite(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/** GET /editor: die Anmeldung oder – mit gültigem Keks – der Editor selbst. */
export async function editorSeite(req, res, passwort, liesEditorHtml) {
  if (!editorFrei(req, passwort)) return seite(res, 200, anmeldeSeite());
  return seite(res, 200, await liesEditorHtml());
}

/** POST /api/editor-login: Passwort prüfen, Keks setzen, zum Editor. */
export async function editorAnmelden(req, res, passwort, zaehler = ZAEHLER_LOKAL) {
  if (!passwort) {
    res.writeHead(303, { Location: '/editor', 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (await zaehler.stand() >= FEHL_MAX) {
    return seite(res, 429, anmeldeSeite('Zu viele falsche Versuche – bitte in zehn Minuten noch einmal.'));
  }
  const form = await liesFormular(req);
  const eingabe = String(form.get('passwort') || '');
  if (!gleich(eingabe, passwort)) {
    await zaehler.fehler();
    await new Promise((r) => setTimeout(r, STRAFE_MS));
    return seite(res, 401, anmeldeSeite('Das Passwort stimmt nicht.'));
  }
  const sicher = ueberHttps(req) ? '; Secure' : '';
  res.writeHead(303, {
    Location: '/editor',
    'Cache-Control': 'no-store',
    'Set-Cookie': `${EDITOR_KEKS}=${marke(passwort)}; Path=/; Max-Age=${GUELTIG_SEK}; HttpOnly; SameSite=Lax${sicher}`,
  });
  return res.end();
}
