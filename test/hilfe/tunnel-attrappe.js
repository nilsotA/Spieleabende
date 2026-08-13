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
 *   'stumm'  – meldet nie eine Adresse (Tunnel kommt nicht hoch)
 *   'stderr' – schreibt sie nach stderr statt stdout (macht cloudflared auch)
 *   'langsam'– lässt sich zwei Sekunden Zeit (der echte braucht auch welche)
 */

const art = process.env.QUIZDUELL_TUNNEL_ATTRAPPE || '';
const adresse = 'https://leise-nacht-quiz.trycloudflare.com';

// Am Leben bleiben, sonst zählt der Server den Tunnel als abgestürzt.
setInterval(() => {}, 60000);

if (art !== 'stumm') {
  setTimeout(() => {
    const zeile = `2024-01-01T00:00:00Z INF |  ${adresse}  |\n`;
    if (art === 'stderr') process.stderr.write(zeile);
    else process.stdout.write(zeile);
  }, art === 'langsam' ? 2000 : 50);
}
