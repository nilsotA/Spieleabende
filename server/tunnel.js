/**
 * Der Weg nach draußen – ein Tunnel für die Abende, an denen nicht alle im
 * selben WLAN sitzen.
 *
 * Das Spiel selbst bleibt, was es ist: ein Server im Heimnetz. Der Tunnel legt
 * nur eine öffentliche https-Adresse davor, die auf denselben Port zeigt. Das
 * kostet nichts und braucht kein Konto – aber es braucht `cloudflared` auf dem
 * Rechner. Fehlt es, sagt das Fenster, wo es herkommt, und der Abend läuft
 * einfach im Heimnetz weiter: Ein fehlendes Programm darf kein Grund sein,
 * dass gar nichts geht.
 *
 * Nebenbei bringt https zwei Dinge mit, die im Heimnetz fehlen: Die Handys
 * dürfen ihren Bildschirm wachhalten, und die Zusammenfassung landet per Knopf
 * in der Zwischenablage. Beides gibt der Browser nur im sicheren Kontext her.
 */

import { spawn } from 'node:child_process';

// Über die Umgebung umlenkbar – die Tests schicken hier ein Programm hin, das
// sich wie cloudflared verhält, ohne ins Internet zu gehen.
const PROGRAMM = process.env.QUIZDUELL_TUNNEL_BIN || 'cloudflared';
// So lange darf der Tunnel brauchen, bis er seine Adresse nennt. Danach spielen
// wir ohne ihn weiter, statt die Lobby warten zu lassen.
const GEDULD_MS = Number(process.env.QUIZDUELL_TUNNEL_TIMEOUT || 25000);
const ADRESSE = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi;
/*
 * Cloudflares eigene Adressen unter derselben Domain – sie sind nie der Tunnel.
 *
 * `api.trycloudflare.com` ist die Stelle, bei der cloudflared den Quick Tunnel
 * überhaupt erst anfordert. Geht das schief, steht sie samt `https://` mitten
 * in der Fehlermeldung, die cloudflared nach stderr schreibt – und ein Muster,
 * das jede trycloudflare-Adresse nimmt, hält genau diese für den Tunnel.
 * Im Fenster stünde dann „Der Tunnel steht: https://api.trycloudflare.com“,
 * der QR-Code in der Lobby zeigte dorthin, und jeder Gast, der scannt, landet
 * auf einer Cloudflare-Fehlerseite statt im Spiel.
 */
const NICHT_DER_TUNNEL = new Set(['api', 'update', 'www']);

/** Die erste Adresse in einem Ausgabestück, die wirklich ein Tunnel sein kann. */
function adresseAus(text) {
  ADRESSE.lastIndex = 0; // ein globales Muster merkt sich sonst die letzte Stelle
  let treffer;
  while ((treffer = ADRESSE.exec(text))) {
    if (!NICHT_DER_TUNNEL.has(treffer[1].toLowerCase())) return treffer[0];
  }
  return null;
}

let kind = null;

/**
 * Startet den Tunnel und liefert seine Adresse – oder null, wenn daraus nichts
 * wird. Wirft nie: Ein Spieleabend soll nicht an einem Tunnel scheitern.
 */
export function starteTunnel(port) {
  return new Promise((fertig) => {
    let erledigt = false;
    /*
     * `uhr` gehört vor `einmal`, nicht darunter.
     *
     * Die Konstante stand am Ende der Funktion, `einmal` räumt sie aber gleich
     * in der ersten Zeile weg. Auf dem gewöhnlichen Weg fällt das nie auf: Da
     * läuft `einmal` erst aus einem Ereignis heraus, lange nach der Zuweisung.
     * Der eine Weg, der sie davor nimmt, ist der Notausgang – `spawn` wirft
     * sofort, der Fang ruft `einmal(null)`. Dort war `uhr` noch gar nicht da,
     * und statt „läuft eben im Heimnetz weiter“ kam ein ReferenceError. Der
     * wiederum wird in `server/index.js` nicht gefangen: `starteTunnel` wird
     * im listen-Rückruf awaitet. Eine abgelehnte Zusage dort reißt den ganzen
     * Server mit – einen Server, dessen Lobby schon offen steht.
     */
    let uhr = null;
    const einmal = (wert) => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(uhr);
      fertig(wert);
    };

    try {
      kind = spawn(PROGRAMM, ['tunnel', '--url', `http://localhost:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      fehlt();
      return einmal(null);
    }

    kind.on('error', (err) => {
      if (err.code === 'ENOENT') fehlt();
      else console.error(`\n  Der Tunnel ließ sich nicht starten: ${err.message}\n`);
      kind = null;
      einmal(null);
    });

    // cloudflared schreibt seine Adresse mal nach stdout, mal nach stderr –
    // je nach Version. Deshalb hören wir auf beiden Leitungen.
    const lausche = (d) => {
      // Nichts Passendes dabei? Dann weiterhören – nicht auf einen Treffer
      // festnageln, der gar keiner ist.
      const adresse = adresseAus(String(d));
      if (adresse) einmal(adresse);
    };
    kind.stdout.on('data', lausche);
    kind.stderr.on('data', lausche);

    kind.on('exit', () => {
      kind = null;
      einmal(null);
    });

    uhr = setTimeout(() => {
      console.error('\n  Der Tunnel meldet sich nicht. Der Abend läuft im Heimnetz weiter.\n');
      /*
       * Und cloudflared geht mit.
       *
       * Hier stand nur `einmal(null)`. Der Kindprozess lief weiter, baute
       * seinen Tunnel in aller Ruhe fertig und veröffentlichte eine
       * https-Adresse auf denselben Port. Die kam zwar noch über `lausche`
       * herein, wurde aber von `if (erledigt) return` verworfen – das Spiel
       * stand also offen im Netz, während im Fenster geschrieben stand, der
       * Abend laufe im Heimnetz weiter. Wer aufhört zu warten, macht auch zu.
       */
      stoppeTunnel();
      einmal(null);
    }, GEDULD_MS);
    // Ein wartender Tunnel soll den Server nicht am Beenden hindern.
    uhr.unref?.();
  });
}

/** Beim Beenden mitnehmen – ein verwaister Tunnel hält den Port offen. */
export function stoppeTunnel() {
  if (!kind) return;
  try {
    kind.kill();
  } catch {
    /* dann eben nicht */
  }
  kind = null;
}

function fehlt() {
  console.error(`
  Für das Spiel über das Internet fehlt noch cloudflared.
  Es ist kostenlos, braucht kein Konto und wird einmal installiert:

    macOS    brew install cloudflared
    Windows  https://github.com/cloudflare/cloudflared/releases  (…-windows-amd64.exe)
    Linux    https://github.com/cloudflare/cloudflared/releases  (Paket der Distribution)

  Solange läuft der Abend ganz normal im Heimnetz weiter.
`);
}
