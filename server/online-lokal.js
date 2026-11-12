/*
 * Das Netz-Spiel am eigenen Rechner – zum Ausprobieren und für die Tests.
 *
 * Auf Vercel liefert die Plattform die Seiten aus `public/` selbst aus und ruft
 * für alles unter /api/ die Funktion in api/quizduell.js. Dieser kleine Server
 * tut beides in einem Prozess, damit sich die Raum-Variante ohne Vercel-Konto
 * durchspielen lässt:
 *
 *   npm run online            → http://localhost:3100/host
 *
 * Ohne Zugangsdaten liegen die Räume im Arbeitsspeicher und sind nach dem
 * Beenden weg. Mit UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in der
 * Umgebung spricht er mit demselben Speicher wie die veröffentlichte Fassung.
 *
 * Für den Spieleabend ohne Internet ist weiterhin `npm start` gedacht.
 */
import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { erzeugeOnline } from './online.js';
import { speicherAusUmgebung } from './speicher.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.gif': 'image/gif',
};
// Dieselben Kurzadressen wie in vercel.json und am Laptop-Server.
const ROUTES = { '/': 'index.html', '/host': 'host.html', '/play': 'player.html', '/remote': 'remote.html', '/editor': 'editor.html' };

export function starteOnlineLokal({ port = 3100, speicher = speicherAusUmgebung(), jetzt, oeffentlich } = {}) {
  const behandle = erzeugeOnline({ speicher, jetzt, bau: 'lokal', oeffentlich });
  const server = http.createServer(async (req, res) => {
    const pfad = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (pfad.startsWith('/api/') || pfad.startsWith('/bilder/')) return behandle(req, res);
    const datei = path.join(PUBLIC_DIR, ROUTES[pfad] || path.posix.normalize(pfad).replace(/^\/+/, ''));
    if (!datei.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end('Verboten');
    }
    try {
      if (!(await stat(datei)).isFile()) throw new Error('keine Datei');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(datei).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      createReadStream(datei).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Nicht gefunden');
    }
    return undefined;
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

// Direkt gestartet: `node server/online-lokal.js`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 3100;
  const speicher = speicherAusUmgebung();
  await starteOnlineLokal({ port, speicher });
  console.log(`Quizduell im Netz-Modus (Speicher: ${speicher.art}):  http://localhost:${port}/host`);
}
