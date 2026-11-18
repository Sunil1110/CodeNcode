'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { GameError, applyAction, createGame, summary, view } = require('./lib/game');
const { Store } = require('./lib/store');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STREAM_ENTRIES = 50; // recent history sent with each live update
const MAX_BODY = 10_000;

const store = new Store(path.join(DATA_DIR, 'games'));

// ---- live updates (server-sent events) ----

const listClients = new Set();
const gameClients = new Map(); // game id -> Set of responses

const send = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

function listPayload() {
  const games = store
    .all()
    .map(summary)
    .sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt));
  return { games };
}

function broadcastList() {
  if (!listClients.size) return;
  const payload = listPayload();
  for (const res of listClients) send(res, payload);
}

function broadcastGame(game) {
  const clients = gameClients.get(game.id);
  if (clients && clients.size) {
    const payload = { game: view(game, { entryLimit: STREAM_ENTRIES }) };
    for (const res of clients) send(res, payload);
  }
  broadcastList();
}

function broadcastGone(id) {
  for (const res of gameClients.get(id) || []) send(res, { gone: true });
  broadcastList();
}

function openStream(req, res, gameId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  if (gameId) {
    const game = store.get(gameId);
    if (!game) {
      send(res, { gone: true });
    } else {
      send(res, { game: view(game, { entryLimit: STREAM_ENTRIES }) });
    }
    if (!gameClients.has(gameId)) gameClients.set(gameId, new Set());
    gameClients.get(gameId).add(res);
    req.on('close', () => {
      const set = gameClients.get(gameId);
      if (!set) return;
      set.delete(res);
      if (!set.size) gameClients.delete(gameId);
    });
  } else {
    send(res, listPayload());
    listClients.add(res);
    req.on('close', () => listClients.delete(res));
  }
}

// Keeps idle connections from being closed by proxies.
setInterval(() => {
  for (const res of listClients) res.write(': ping\n\n');
  for (const set of gameClients.values()) for (const res of set) res.write(': ping\n\n');
}, 20_000).unref();

// ---- helpers ----

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newId() {
  for (;;) {
    let id = '';
    for (let i = 0; i < 5; i += 1) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
    if (!store.get(id)) return id;
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new GameError('Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new GameError('Invalid request.'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    json(res, 404, { error: 'Not found.' });
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      json(res, 404, { error: 'Not found.' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---- routes ----

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'api') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return json(res, 404, { error: 'Not found.' });
    }
    return serveStatic(res, pathname);
  }

  // GET /api/stream            live list of games
  // GET /api/stream?game=ID    live state of one game
  if (req.method === 'GET' && parts[1] === 'stream' && parts.length === 2) {
    return openStream(req, res, (url.searchParams.get('game') || '').toUpperCase() || null);
  }

  if (parts[1] === 'games' && parts.length === 2) {
    if (req.method === 'GET') return json(res, 200, listPayload());
    if (req.method === 'POST') {
      const body = await readBody(req);
      const now = Date.now();
      const game = createGame({ id: newId(), title: body.title, buyIn: body.buyIn, now });
      applyAction(game, { type: 'join', name: body.name }, now);
      store.put(game);
      broadcastList();
      return json(res, 201, { game: view(game) });
    }
  }

  if (parts[1] === 'games' && parts.length >= 3) {
    const game = store.get(parts[2].toUpperCase());
    if (!game) return json(res, 404, { error: 'That game does not exist.' });

    if (req.method === 'GET' && parts.length === 3) return json(res, 200, { game: view(game) });

    if (req.method === 'POST' && parts[3] === 'action' && parts.length === 4) {
      const body = await readBody(req);
      const before = game.seq;
      const wasLobby = game.status === 'lobby';

      // A game that never started has nothing worth keeping: closing it, or
      // the last player walking out, just removes it.
      if (wasLobby && body.type === 'end') {
        store.remove(game.id);
        broadcastGone(game.id);
        return json(res, 200, { gone: true });
      }

      applyAction(game, body, Date.now(), () => crypto.randomInt(1_000_000) / 1_000_000);

      if (wasLobby && game.status === 'lobby' && !game.players.length) {
        store.remove(game.id);
        broadcastGone(game.id);
        return json(res, 200, { gone: true });
      }
      if (game.seq !== before) {
        store.put(game);
        broadcastGame(game);
      }
      return json(res, 200, { game: view(game, { entryLimit: STREAM_ENTRIES }) });
    }
  }

  return json(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof GameError) {
      json(res, 400, { error: err.message });
    } else {
      console.error(err);
      json(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  });
});

function shutdown() {
  store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`ChipBank is running on http://localhost:${PORT}`);
});
