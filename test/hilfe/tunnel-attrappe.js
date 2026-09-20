#!/usr/bin/env node
/**
 * Eine Attrappe für cloudflared.
 *
 * Sie tut das Einzige, worauf sich der Server verlässt: Sie schreibt nach ein
 * paar Millisekunden eine trycloudflare-Adresse und bleibt dann am Leben. So
 * lässt sich der ganze Weg – Tunnel an, Adresse im QR-Code, Tür zu – testen,
 * ohne dass ein Testlauf ins Internet greift.
 *
 * Über QUIZDUELL_TUNNEL_ATTRAPPE steuerbar:
 *   'stumm'      – meldet nie eine Adresse (Tunnel kommt nicht hoch)
 *   'stderr'     – schreibt sie nach stderr statt stdout (macht cloudflared auch)
 *   'langsam'    – lässt sich zwei Sekunden Zeit (der echte braucht auch welche)
 *   'api-fehler' – scheitert und schreibt dabei Cloudflares eigene api-Adresse
 *   'erst-fehler'– dieselbe Fehlerzeile, danach doch noch die echte Adresse
 *
 * Und über QUIZDUELL_TUNNEL_PIDFILE legt sie ihre Prozessnummer ab – nur so
 * lässt sich von außen prüfen, ob der Server sie beim Aufgeben mitgenommen hat.
 */

import { writeFileSync } from 'node:fs';

const art = process.env.QUIZDUELL_TUNNEL_ATTRAPPE || '';
const adresse = 'https://leise-nacht-quiz.trycloudflare.com';
// So sieht es aus, wenn cloudflared den Quick Tunnel nicht anfordern kann: Die
// eigene api-Adresse steht mitten in der Go-Fehlermeldung.
const fehlzeile = '2024-01-01T00:00:00Z ERR Failed to request quick Tunnel'
  + ' error="Post \\"https://api.trycloudflare.com/tunnel\\": dial tcp: lookup failed"\n';

if (process.env.QUIZDUELL_TUNNEL_PIDFILE) {
  writeFileSync(process.env.QUIZDUELL_TUNNEL_PIDFILE, String(process.pid));
}

// Am Leben bleiben, sonst zählt der Server den Tunnel als abgestürzt.
setInterval(() => {}, 60000);

if (art === 'api-fehler' || art === 'erst-fehler') {
  setTimeout(() => process.stderr.write(fehlzeile), 50);
  // Der echte cloudflared versucht es weiter – manchmal klappt es beim
  // zweiten Anlauf. Dann steht die richtige Adresse hinter der Fehlerzeile.
  if (art === 'erst-fehler') {
    setTimeout(() => process.stdout.write(`2024-01-01T00:00:01Z INF |  ${adresse}  |\n`), 300);
  }
} else if (art !== 'stumm') {
  setTimeout(() => {
    const zeile = `2024-01-01T00:00:00Z INF |  ${adresse}  |\n`;
    if (art === 'stderr') process.stderr.write(zeile);
    else process.stdout.write(zeile);
  }, art === 'langsam' ? 2000 : 50);
}
