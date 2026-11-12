/*
 * Wo die Räume des Netz-Spiels liegen.
 *
 * Am Laptop lebt das Spiel im Arbeitsspeicher eines Prozesses, der den ganzen
 * Abend läuft. Im Netz (Vercel) gibt es diesen Prozess nicht: Jede Anfrage
 * kann auf einer anderen Maschine landen, und dazwischen bleibt nichts im
 * Speicher stehen. Der Raum muss also bei jeder Anfrage geholt und danach
 * wieder abgelegt werden.
 *
 * Zwei Ausführungen mit derselben Schnittstelle:
 *   - `speicherImArbeitsspeicher()` für Tests und den Probelauf am Laptop,
 *   - `speicherUpstash()` für Upstash Redis über dessen REST-Schnittstelle –
 *     ohne zusätzliches Paket, ein `fetch` genügt.
 *
 * Was abgelegt wird (je Raum):
 *   Raum       der Spielstand samt allem, was jede Sicht braucht (~20 kB)
 *   Kopf       „rev|nummer" – die billige Frage „hat sich etwas geändert?"
 *   Weg        der Rückweg; groß, und nur Aktionen brauchen ihn
 *   Geräte     wer sich zuletzt wann gemeldet hat
 *   Bilder     eingebettete Bilder eines hochgeladenen Fragensatzes
 *
 * Geschrieben wird nur, wenn der Raum noch die Fassung hat, die der Schreiber
 * gelesen hatte (`rev`). Zwei Handys, die im selben Augenblick buzzern, können
 * sich so nicht gegenseitig überschreiben: Das zweite bekommt „zu spät", liest
 * neu und versucht es noch einmal – und sieht dann, dass schon jemand dran ist.
 */

/** Räume bleiben 30 Tage nach der letzten Änderung liegen. */
export const RAUM_TTL_SEK = 30 * 24 * 60 * 60;

/* ------------------------------------------------------- Arbeitsspeicher */

export function speicherImArbeitsspeicher({ jetzt = () => Date.now() } = {}) {
  const raeume = new Map(); // code -> { json, rev, nummer, weg, geraete: Map, bilder: Map, bis }

  const hole = (code) => {
    const e = raeume.get(code);
    if (!e) return null;
    if (e.bis < jetzt()) {
      raeume.delete(code);
      return null;
    }
    return e;
  };

  return {
    art: 'arbeitsspeicher',

    async kopf(code) {
      const e = hole(code);
      return e ? { rev: e.rev, nummer: e.nummer } : null;
    },

    async lade(code) {
      const e = hole(code);
      return e ? JSON.parse(e.json) : null;
    },

    async ladeWeg(code) {
      const e = hole(code);
      return e?.weg ? JSON.parse(e.weg) : [];
    },

    /** `erwartet` −1 heißt: Den Raum darf es noch nicht geben. */
    async schreibe(code, erwartet, daten, weg) {
      const e = hole(code);
      if ((e ? e.rev : -1) !== erwartet) return false;
      raeume.set(code, {
        geraete: e?.geraete || new Map(),
        bilder: e?.bilder || new Map(),
        weg: weg === undefined ? e?.weg : JSON.stringify(weg),
        json: JSON.stringify(daten),
        rev: daten.rev,
        nummer: daten.nummer,
        bis: jetzt() + RAUM_TTL_SEK * 1000,
      });
      return true;
    },

    /** Vermerkt, dass sich ein Gerät gemeldet hat, und nennt alle bekannten. */
    async puls(code, clientId, isHost) {
      const e = hole(code);
      if (!e) return {};
      e.geraete.set(clientId, { zeit: jetzt(), host: !!isHost });
      return Object.fromEntries(e.geraete);
    },

    async vergissGeraete(code, ids) {
      const e = hole(code);
      for (const id of ids) e?.geraete.delete(id);
    },

    async setzeBild(code, id, bild) {
      hole(code)?.bilder.set(id, bild);
    },

    async bild(code, id) {
      return hole(code)?.bilder.get(id) || null;
    },
  };
}

/* ----------------------------------------------------------------- Upstash */

/*
 * Schreiben nur, wenn die Fassung noch stimmt – als ein einziger Befehl, damit
 * zwischen Prüfen und Schreiben niemand dazwischenkommt.
 *
 * KEYS: Raum, Kopf, Weg.  ARGV: erwartete rev, Raum, Kopf, Lebensdauer, Weg
 * (leer = Weg unverändert lassen).
 */
const SCHREIB_SKRIPT = `
local m = redis.call('GET', KEYS[2])
local cur = -1
if m then cur = tonumber(string.match(m, '^(%d+)')) end
if cur ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
if ARGV[5] ~= '' then redis.call('SET', KEYS[3], ARGV[5], 'EX', ARGV[4]) end
return 1
`;

export function speicherUpstash({ url, token, fetchen = fetch, jetzt = () => Date.now() }) {
  const basis = String(url).replace(/\/+$/, '');
  const kopfzeilen = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  async function sende(pfad, inhalt) {
    const res = await fetchen(`${basis}${pfad}`, {
      method: 'POST', headers: kopfzeilen, body: JSON.stringify(inhalt),
    });
    if (!res.ok) throw new Error(`Speicher antwortet mit ${res.status}`);
    return res.json();
  }
  /** Ein Befehl: ['GET', 'schluessel'] */
  async function befehl(teile) {
    const antwort = await sende('', teile);
    if (antwort.error) throw new Error(`Speicher: ${antwort.error}`);
    return antwort.result;
  }
  /** Mehrere Befehle in einem Rutsch – eine Reise statt mehrerer. */
  async function rutsch(befehle) {
    const antworten = await sende('/pipeline', befehle);
    return antworten.map((a) => {
      if (a.error) throw new Error(`Speicher: ${a.error}`);
      return a.result;
    });
  }

  const k = {
    raum: (c) => `qd:r:${c}`,
    kopf: (c) => `qd:v:${c}`,
    weg: (c) => `qd:w:${c}`,
    geraete: (c) => `qd:d:${c}`,
    bild: (c, id) => `qd:b:${c}:${id}`,
  };
  const ttl = String(RAUM_TTL_SEK);

  const leseKopf = (roh) => {
    if (!roh) return null;
    const [rev, nummer] = String(roh).split('|').map(Number);
    return { rev, nummer };
  };

  return {
    art: 'upstash',

    async kopf(code) {
      return leseKopf(await befehl(['GET', k.kopf(code)]));
    },

    async lade(code) {
      const roh = await befehl(['GET', k.raum(code)]);
      return roh ? JSON.parse(roh) : null;
    },

    async ladeWeg(code) {
      const roh = await befehl(['GET', k.weg(code)]);
      return roh ? JSON.parse(roh) : [];
    },

    async schreibe(code, erwartet, daten, weg) {
      const ergebnis = await befehl([
        'EVAL', SCHREIB_SKRIPT, '3', k.raum(code), k.kopf(code), k.weg(code),
        String(erwartet), JSON.stringify(daten), `${daten.rev}|${daten.nummer}`, ttl,
        weg === undefined ? '' : JSON.stringify(weg),
      ]);
      return Number(ergebnis) === 1;
    },

    async puls(code, clientId, isHost) {
      const [, , alle] = await rutsch([
        ['HSET', k.geraete(code), clientId, `${jetzt()}|${isHost ? 1 : 0}`],
        ['EXPIRE', k.geraete(code), ttl],
        ['HGETALL', k.geraete(code)],
      ]);
      // HGETALL kommt als flache Liste: [feld, wert, feld, wert, …]
      const out = {};
      for (let i = 0; i + 1 < (alle || []).length; i += 2) {
        const [zeit, host] = String(alle[i + 1]).split('|');
        out[alle[i]] = { zeit: Number(zeit), host: host === '1' };
      }
      return out;
    },

    async vergissGeraete(code, ids) {
      if (ids.length) await befehl(['HDEL', k.geraete(code), ...ids]);
    },

    async setzeBild(code, id, bild) {
      await befehl(['SET', k.bild(code, id), JSON.stringify(bild), 'EX', ttl]);
    },

    async bild(code, id) {
      const roh = await befehl(['GET', k.bild(code, id)]);
      return roh ? JSON.parse(roh) : null;
    },
  };
}

/**
 * Der Speicher, den die Umgebung hergibt.
 *
 * Vercel setzt die Zugangsdaten selbst, sobald Upstash Redis mit dem Projekt
 * verbunden ist – unter einem von zwei Namenspaaren, je nachdem, über welchen
 * Weg die Datenbank angelegt wurde. Fehlen sie in der Produktion, startet das
 * Spiel absichtlich nicht: Ein Raum im Arbeitsspeicher einer Funktion wäre
 * nach der nächsten Anfrage weg, und das sähe aus wie ein Spiel, das grundlos
 * alles vergisst.
 */
export function speicherAusUmgebung(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (url && token) return speicherUpstash({ url, token });
  if (env.VERCEL || env.NODE_ENV === 'production') {
    throw new Error(
      'Upstash Redis ist nicht eingerichtet (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN fehlen). '
      + 'Im Vercel-Dashboard unter „Storage“ Upstash Redis mit dem Projekt verbinden und neu deployen.',
    );
  }
  return speicherImArbeitsspeicher();
}
