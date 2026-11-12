/*
 * Testwerkzeug: die Upstash-REST-Schnittstelle vor einem echten, lokalen Redis.
 *
 * So läuft die Speicherschicht, die auf Vercel benutzt wird (speicherUpstash
 * samt Lua-Skript), in den Tests über denselben Weg wie in der Produktion –
 * ohne Upstash-Konto und ohne ein zusätzliches Paket: Das Redis-Protokoll ist
 * klein genug, um es hier von Hand zu sprechen.
 *
 * `starteRedisShim()` startet `redis-server` auf einem freien Port, hängt den
 * Übersetzer davor und gibt dessen Adresse zurück. Gibt es kein redis-server
 * auf dem Rechner, kommt `null` – die Tests überspringen den Lauf dann.
 */
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const CRLF = '\r\n';

function freierPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Ein Befehl im Redis-Protokoll: Feld aus Zeichenketten. */
function kodiere(teile) {
  const stuecke = [Buffer.from(`*${teile.length}${CRLF}`)];
  for (const t of teile) {
    const b = Buffer.from(String(t), 'utf8');
    stuecke.push(Buffer.from(`\$${b.length}${CRLF}`), b, Buffer.from(CRLF));
  }
  return Buffer.concat(stuecke);
}

/** Liest eine Antwort ab `pos`; gibt [wert, neuePos] oder null, wenn noch etwas fehlt. */
function lies(buf, pos) {
  const ende = buf.indexOf(CRLF, pos);
  if (ende < 0) return null;
  const zeile = buf.toString('utf8', pos + 1, ende);
  const danach = ende + 2;
  switch (String.fromCharCode(buf[pos])) {
    case '+': return [zeile, danach];
    case '-': return [{ fehler: zeile }, danach];
    case ':': return [Number(zeile), danach];
    case '$': {
      const n = Number(zeile);
      if (n < 0) return [null, danach];
      if (buf.length < danach + n + 2) return null;
      return [buf.toString('utf8', danach, danach + n), danach + n + 2];
    }
    case '*': {
      const n = Number(zeile);
      if (n < 0) return [null, danach];
      const out = [];
      let p = danach;
      for (let i = 0; i < n; i++) {
        const r = lies(buf, p);
        if (!r) return null;
        out.push(r[0]);
        p = r[1];
      }
      return [out, p];
    }
    default: throw new Error('Unbekannte Redis-Antwort');
  }
}

function verbinde(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let puffer = Buffer.alloc(0);
    const wartende = [];
    sock.on('data', (teil) => {
      puffer = Buffer.concat([puffer, teil]);
      for (;;) {
        const r = lies(puffer, 0);
        if (!r) break;
        puffer = puffer.subarray(r[1]);
        wartende.shift()?.(r[0]);
      }
    });
    sock.once('error', reject);
    sock.once('connect', () => resolve({
      befehl: (teile) => new Promise((fertig) => {
        wartende.push(fertig);
        sock.write(kodiere(teile));
      }),
      zu: () => sock.destroy(),
    }));
  });
}

export async function starteRedisShim() {
  if (spawnSync('redis-server', ['--version']).status !== 0) return null;
  const redisPort = await freierPort();
  const redis = spawn(
    'redis-server',
    ['--port', String(redisPort), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'],
    { stdio: 'ignore' },
  );
  let client = null;
  for (let i = 0; i < 50 && !client; i++) {
    await new Promise((r) => setTimeout(r, 100));
    client = await verbinde(redisPort).catch(() => null);
  }
  if (!client) {
    redis.kill('SIGKILL');
    return null;
  }
  const laufe = async (teile) => {
    const r = await client.befehl(teile);
    return r && typeof r === 'object' && !Array.isArray(r) && r.fehler ? { error: r.fehler } : { result: r };
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const teil of req) body += teil;
    res.setHeader('content-type', 'application/json');
    try {
      const inhalt = JSON.parse(body || '[]');
      if (req.url.startsWith('/pipeline')) {
        const out = [];
        for (const b of inhalt) out.push(await laufe(b));
        return res.end(JSON.stringify(out));
      }
      const r = await laufe(inhalt);
      res.statusCode = r.error ? 400 : 200;
      return res.end(JSON.stringify(r));
    } catch (err) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: String(err.message || err) }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token: 'test',
    async zu() {
      client.zu();
      redis.kill('SIGKILL');
      await new Promise((r) => server.close(r));
    },
  };
}
