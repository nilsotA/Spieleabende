/*
 * Einstieg für Vercel: eine Funktion für alle Adressen unter /api/.
 *
 * vercel.json schreibt /api/<name> auf diese Datei um (und /bilder/<datei>
 * ebenso), die Seiten selbst liefert Vercel aus `public/` aus. Was hier
 * ankommt, beantwortet server/online.js – dieselbe Funktion, die
 * `npm run online` am eigenen Rechner benutzt und gegen die die Tests laufen.
 *
 * Der Speicher wird einmal je Funktionsinstanz gebaut. Fehlen die
 * Upstash-Zugangsdaten, sagt die Antwort das im Klartext, statt mit einem
 * nackten 500 zu enden – das ist der eine Fehler, den man beim ersten
 * Veröffentlichen wirklich macht.
 */
import { erzeugeOnline } from '../server/online.js';
import { speicherAusUmgebung } from '../server/speicher.js';

let behandle = null;

export default async function handler(req, res) {
  if (!behandle) {
    try {
      behandle = erzeugeOnline({
        speicher: speicherAusUmgebung(),
        bau: (process.env.VERCEL_GIT_COMMIT_SHA || 'online').slice(0, 7),
        // Die Adresse, die ohne Anmeldung bei Vercel erreichbar ist – auf sie
        // zeigen QR-Code und Fernbedienungs-Link, egal worüber der Host kam.
        oeffentlich: process.env.VERCEL_ENV === 'production' && process.env.VERCEL_PROJECT_PRODUCTION_URL
          ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '',
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }
  return behandle(req, res);
}
