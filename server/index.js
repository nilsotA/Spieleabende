import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import * as G from './game.js';
import { listSets, loadSet, normalizeSet, DATA_DIR } from './questions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

/* ------------------------------------------------------------ Spielzustand */

let state = G.createState();
const clients = new Map(); // clientId -> { res, isHost, name }

function broadcast() {
  for (const [clientId, client] of clients) {
    sendState(clientId, client);
  }
}

function sendState(clientId, client) {
  const view = G.viewFor(state, { isHost: client.isHost, clientId });
  try {
    client.res.write(`event: state\ndata: ${JSON.stringify(view)}\n\n`);
  } catch {
    clients.delete(clientId);
  }
}

function notify(clientId, level, text) {
  const client = clients.get(clientId);
  if (!client) return;
  try {
    client.res.write(`event: toast\ndata: ${JSON.stringify({ level, text })}\n\n`);
  } catch {
    clients.delete(clientId);
  }
}

/** Kleines Signal für alle – z.B. Buzzer-Sound auf dem Host-Screen. */
function broadcastEvent(name, payload) {
  for (const [clientId, client] of clients) {
    try {
      client.res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      clients.delete(clientId);
    }
  }
}

/* ---------------------------------------------------------------- Aktionen */

const HOST_ACTIONS = new Set([
  'addTeam', 'renameTeam', 'removeTeam', 'adjustScore', 'setTurn',
  'startGame', 'pick', 'judge', 'pass', 'openBuzz', 'reveal',
  'close', 'nextRound', 'backToLobby', 'settings', 'resetBuzz',
  'buzzFor', 'endQuestion',
]);

async function handleAction(clientId, body) {
  const client = clients.get(clientId);
  // Maßgeblich ist die Rolle der offenen Verbindung – ein Spielerhandy kann sich
  // also nicht per Rollenangabe im Request zum Host erklären.
  const isHost = client ? client.isHost : body.role === 'host';
  const type = String(body.type || '');

  if (HOST_ACTIONS.has(type) && !isHost && type !== 'pick') {
    throw new G.GameError('Nur der Host darf das.');
  }

  switch (type) {
    case 'joinTeam':
      G.joinTeam(state, clientId, body.teamId, body.name);
      break;
    case 'leaveTeam':
      G.leaveTeams(state, clientId);
      break;
    case 'addTeam':
      G.addTeam(state, body.name);
      break;
    case 'renameTeam':
      G.renameTeam(state, body.teamId, body.name);
      break;
    case 'removeTeam':
      G.removeTeam(state, body.teamId);
      break;
    case 'adjustScore':
      G.adjustScore(state, body.teamId, body.delta);
      break;
    case 'setTurn':
      G.setTurn(state, body.teamId);
      break;
    case 'settings':
      Object.assign(state.settings, pickSettings(body.settings));
      break;
    case 'startGame': {
      const set = body.set ? normalizeSet(body.set) : await loadSet(body.file);
      G.startGame(state, set);
      break;
    }
    case 'pick': {
      // Auch das Team, das dran ist, darf vom Handy aus wählen.
      const team = G.teamOfClient(state, clientId);
      G.pickCell(state, Number(body.catIdx), Number(body.rowIdx), isHost ? null : team?.id);
      break;
    }
    case 'buzz': {
      G.buzz(state, clientId);
      const team = G.teamOfClient(state, clientId);
      broadcastEvent('buzz', { teamId: team?.id, teamName: team?.name, by: state.current?.buzzedBy });
      break;
    }
    case 'buzzFor': {
      G.buzzFor(state, body.teamId);
      const team = G.findTeam(state, body.teamId);
      broadcastEvent('buzz', { teamId: team.id, teamName: team.name, by: team.name });
      break;
    }
    case 'judge':
      G.judge(state, !!body.correct);
      break;
    case 'endQuestion':
      G.endQuestion(state);
      break;
    case 'pass':
      G.passQuestion(state);
      break;
    case 'openBuzz':
      G.openBuzz(state);
      break;
    case 'resetBuzz':
      if (state.current) {
        state.current.buzzedTeamId = null;
        state.current.onTheHook = null;
        state.current.step = 'buzz';
      }
      break;
    case 'reveal':
      G.revealAnswer(state);
      break;
    case 'close':
      G.closeQuestion(state);
      break;
    case 'nextRound':
      G.nextRound(state);
      break;
    case 'backToLobby':
      state = G.backToLobby(state);
      break;
    default:
      throw new G.GameError(`Unbekannte Aktion: ${type}`);
  }
  broadcast();
}

function pickSettings(s = {}) {
  const out = {};
  if (['rotate', 'keepOnCorrect'].includes(s.turnMode)) out.turnMode = s.turnMode;
  if (['none', 'half', 'full'].includes(s.wrongPenalty)) out.wrongPenalty = s.wrongPenalty;
  if (typeof s.buzzAfterCorrect === 'boolean') out.buzzAfterCorrect = s.buzzAfterCorrect;
  return out;
}

/* ------------------------------------------------------------------ Server */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

const ROUTES = {
  '/': 'index.html',
  '/host': 'host.html',
  '/play': 'player.html',
  '/editor': 'editor.html',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === '/api/events') return sseHandler(req, res, url);
    if (pathname.startsWith('/api/')) return await apiHandler(req, res, url, pathname);

    if (pathname.startsWith('/bilder/')) {
      return serveFile(res, path.join(DATA_DIR, 'bilder', path.basename(pathname)));
    }
    const file = ROUTES[pathname] || pathname.replace(/^\//, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'text/plain', 'Verboten');
    return serveFile(res, full);
  } catch (err) {
    console.error(err);
    send(res, 500, 'text/plain; charset=utf-8', 'Serverfehler: ' + err.message);
  }
});

function sseHandler(req, res, url) {
  const clientId = url.searchParams.get('clientId') || `c_${Math.random().toString(36).slice(2)}`;
  const isHost = url.searchParams.get('role') === 'host';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 1000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ clientId, isHost })}\n\n`);

  const client = { res, isHost };
  clients.set(clientId, client);
  sendState(clientId, client);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(clientId);
  });
}

async function apiHandler(req, res, url, pathname) {
  if (pathname === '/api/sets' && req.method === 'GET') {
    return sendJson(res, 200, await listSets());
  }
  if (pathname === '/api/set' && req.method === 'GET') {
    return sendJson(res, 200, await loadSet(url.searchParams.get('file')));
  }
  if (pathname === '/api/sets' && req.method === 'POST') {
    const body = await readJson(req);
    const set = normalizeSet(body.set, 'Eigener Satz');
    const name = path.basename(String(body.file || 'eigener-satz.json'));
    const file = name.endsWith('.json') ? name : `${name}.json`;
    await writeFile(path.join(DATA_DIR, file), JSON.stringify(set, null, 2), 'utf8');
    return sendJson(res, 200, { ok: true, file });
  }
  if (pathname === '/api/info' && req.method === 'GET') {
    return sendJson(res, 200, { urls: localUrls(), port: PORT });
  }
  if (pathname === '/api/action' && req.method === 'POST') {
    const body = await readJson(req);
    const clientId = String(body.clientId || '');
    try {
      await handleAction(clientId, body);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      if (!(err instanceof G.GameError)) console.error(err);
      notify(clientId, 'error', err.message);
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }
  return sendJson(res, 404, { error: 'Unbekannter Endpunkt' });
}

async function serveFile(res, full) {
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    createReadStream(full).pipe(res);
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'Nicht gefunden');
  }
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 20e6) reject(new Error('Anfrage zu groß'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error('Ungültiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

function localUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(`http://${net.address}:${PORT}`);
    }
  }
  return out.length ? out : [`http://localhost:${PORT}`];
}

server.listen(PORT, () => {
  console.log('\n  🎉  Quizduell für Spieleabende läuft!\n');
  console.log(`  Host-Screen (Beamer/TV):  http://localhost:${PORT}/host`);
  for (const u of localUrls()) {
    console.log(`  Handys der Mitspieler:    ${u}`);
  }
  console.log(`  Fragen-Editor:            http://localhost:${PORT}/editor\n`);
});
