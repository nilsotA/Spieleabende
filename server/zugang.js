/**
 * Zugang – nur für den Fall, dass der Abend nach draußen geht.
 *
 * Im Heimnetz hat dieses Spiel bewusst kein Passwort: Wer im WLAN ist, sitzt
 * mit am Tisch. Sobald aber ein Tunnel offen ist, reicht die Adresse allein
 * nicht mehr als Türsteher – und auf `/host` stünden die Lösungen.
 *
 * Deshalb gibt es zwei Schlüssel, aber keinen einzigen Tippvorgang:
 *
 *   Spielschlüssel  steckt im QR-Code der Lobby – die Mitspieler scannen ihn wie
 *                   immer und merken nichts davon.
 *   Hostschlüssel   steckt in der Adresse, die das Startskript selbst aufmacht,
 *                   und im QR-Code für die Fernbedienung.
 *
 * Wer einen Schlüssel mitbringt, bekommt ihn als Cookie zurück: Danach trägt
 * ihn jede weitere Anfrage von selbst, auch die neu geladene Seite und die
 * Bilder. Ohne Tunnel ist hier alles aus – dann kostet diese Datei nichts.
 */

import { randomBytes } from 'node:crypto';

// Ohne 0/o/1/l: Diese Schlüssel stehen im Zweifel in einer Adresszeile, und
// irgendwann liest sie doch jemand vor.
const ZEICHEN = 'abcdefghjkmnpqrstuvwxyz23456789';

export const COOKIE_SPIEL = 'qd_spiel';
export const COOKIE_HOST = 'qd_host';

/** Ein Schlüssel, kurz genug für eine Adresszeile, lang genug zum Nichterraten. */
export function neuerSchluessel(laenge = 12) {
  const roh = randomBytes(laenge);
  let out = '';
  for (let i = 0; i < laenge; i++) out += ZEICHEN[roh[i] % ZEICHEN.length];
  return out;
}

/** Beide Schlüssel eines Abends. Der Hostschlüssel öffnet auch die Spielertür. */
export function neuerZugang() {
  return { spiel: neuerSchluessel(), host: neuerSchluessel() };
}

/**
 * Einen einzelnen Cookie-Wert aus dem Kopf der Anfrage fischen.
 *
 * `decodeURIComponent` wirft bei kaputten Prozentzeichen („%E4", „abc%") –
 * und diese Prüfung läuft als Allererstes, vor jeder Adresse und ohne dass ein
 * Schlüssel nötig wäre. Der Wurf landete deshalb im Fänger für unbehandelte
 * Zusagen, die Antwort wurde nie geschrieben, und die Anfrage hing, bis Node
 * nach Minuten von selbst aufräumte. Gemessen: curl lief in seinen Zeitablauf,
 * ganz ohne Statuszeile.
 *
 * Im Zweifel gilt der Rohwert. Zu verlieren ist dabei nichts: Die Schlüssel
 * bestehen nur aus a–z und 2–9, da ist nie etwas zu entschlüsseln.
 */
export function leseCookie(req, name) {
  const roh = req.headers?.cookie;
  if (!roh) return null;
  for (const teil of roh.split(';')) {
    const i = teil.indexOf('=');
    if (i < 0) continue;
    if (teil.slice(0, i).trim() !== name) continue;
    const wert = teil.slice(i + 1).trim();
    try {
      return decodeURIComponent(wert);
    } catch {
      return wert;
    }
  }
  return null;
}

/**
 * Was darf diese Anfrage: 'host', 'spiel' oder nichts?
 *
 * `zugang` ist null, solange kein Tunnel läuft – dann darf alles, genau wie
 * bisher. Vergleich zeichenweise ohne Abkürzung wäre hier Zierde: Die
 * Schlüssel wechseln bei jedem Start und ein Abend dauert keine Milliarde
 * Versuche. Der Vergleich bleibt trotzdem konstant lang, weil es nichts
 * kostet.
 */
export function pruefeZugang(req, url, zugang) {
  if (!zugang) return 'host';
  const h = url?.searchParams?.get('h') || leseCookie(req, COOKIE_HOST);
  if (h && gleich(h, zugang.host)) return 'host';
  const k = url?.searchParams?.get('k') || leseCookie(req, COOKIE_SPIEL);
  if (k && gleich(k, zugang.spiel)) return 'spiel';
  return null;
}

/** Vergleich ohne frühen Ausstieg – die Länge verrät ohnehin nichts Neues. */
function gleich(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Die Cookies, die zu einer Anfrage mit Schlüssel in der Adresse gehören.
 *
 * `HttpOnly`, weil keine Seite die Schlüssel im Javascript braucht – der
 * Host-Screen bekommt seine über /api/info, und der bleibt hinter derselben
 * Tür. `SameSite=Lax`, damit der Klick aus einer Chat-App heraus noch
 * funktioniert.
 *
 * `Secure` hängt daran, wie die Anfrage hereinkam – nicht daran, ob ein Tunnel
 * läuft. Beides gleichzeitig ist der Normalfall: Die Gäste kommen über die
 * https-Adresse des Tunnels, der Host selbst hat die Fernbedienung per http
 * auf dem eigenen Handy (so steht sie im Fenster). Ein festes `Secure` würde
 * dem Host den Keks wegnehmen und die Fernbedienung nach der ersten Seite
 * zerlegen; gar keins gibt den Schlüssel über den Tunnel im Klartext heraus,
 * sobald irgendetwas das Handy zu einer http-Anfrage an dieselbe Adresse
 * bringt. Also: pro Anfrage entscheiden.
 */
export function cookieKoepfe(url, zugang, sicher = false) {
  if (!zugang || !url) return [];
  const out = [];
  const h = url.searchParams.get('h');
  const k = url.searchParams.get('k');
  if (h && gleich(h, zugang.host)) out.push(keks(COOKIE_HOST, h, sicher));
  if (k && gleich(k, zugang.spiel)) out.push(keks(COOKIE_SPIEL, k, sicher));
  return out;
}

/**
 * Kam diese Anfrage über https herein?
 *
 * Der Server selbst spricht immer http – das https liegt im Tunnel davor, und
 * cloudflared sagt im `X-Forwarded-Proto`, was es auf der anderen Seite war.
 * Der Kopf ist frei erfindbar, aber gefährlich ist das nicht: Wer ihn fälscht,
 * bekommt einen Keks, den sein eigener Browser über http wegwirft – mehr
 * Sicherheit für andere, weniger Bequemlichkeit für ihn.
 */
export function ueberHttps(req) {
  const kopf = req?.headers?.['x-forwarded-proto'];
  if (!kopf) return false;
  // Mehrere Zwischenstationen schreiben eine Liste: die erste ist der Anfang.
  return String(kopf).split(',')[0].trim().toLowerCase() === 'https';
}

function keks(name, wert, sicher) {
  // 12 Stunden: länger als jeder Spieleabend, kürzer als das Vergessen.
  return `${name}=${encodeURIComponent(wert)}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax`
    + (sicher ? '; Secure' : '');
}

/**
 * Die Seite für alle, die keinen Schlüssel haben.
 *
 * Bewusst ohne Stylesheet und ohne Skript: Beides liegt hinter derselben Tür,
 * eine Fehlerseite, die selbst nachlädt, stünde nackt da. Und bewusst ohne
 * Formular – es gibt nichts einzutippen, der QR-Code ist der Weg hinein.
 */
export const TUER_ZU = `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quizduell – privat</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#05070c;color:#eef2f8;font:1.1rem/1.6 system-ui,sans-serif;padding:2rem}
 div{max-width:24rem;text-align:center}
 b{display:block;font-size:1.6rem;margin-bottom:.8rem}
</style></head>
<body><div>
<b>Diese Runde ist privat.</b>
Scann den QR-Code, der auf der Leinwand steht – er bringt dich direkt hinein.
Eine Adresse zum Abtippen gibt es bewusst nicht.
</div></body></html>`;
