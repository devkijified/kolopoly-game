'use strict';
// KOLOPOLY server. Node fallback: built-in http + ws, rooms in memory.
// The rules live in game-host.js, which the Cloudflare Worker uses too.
const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createGameHost } = require('./game-host');
const { createRetention } = require('./retention');
const { createOps } = require('./ops');
const { createCompetition } = require('./competition');
const records = require('./server-records.js');

const PORT = process.env.PORT || 4173;
const TEST = process.env.KP_TEST === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const BUILD_FILES = [
  'public/index.html',
  'public/app.js',
  'public/style.css',
  'public/sw.js',
  'public/retention.js',
  'public/update.js',
  'public/game-data.js',
  'public/board.js',
  'public/board3d.js',
  'public/manifest.webmanifest'
];
function computeBuild() {
  const hash = crypto.createHash('sha256');
  for (const rel of BUILD_FILES) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(__dirname, rel)));
  }
  return hash.digest('hex').slice(0, 12);
}
const BUILD = computeBuild();
function stampAsset(cleanUrl, data) {
  if (cleanUrl === '/' || cleanUrl === '/index.html') {
    return Buffer.from(String(data).split('__KOLOPOLY_BUILD__').join(BUILD));
  }
  if (cleanUrl === '/sw.js') {
    return Buffer.concat([data, Buffer.from('\n// kolopoly-build ' + BUILD + '\n')]);
  }
  return data;
}
const retention = createRetention({
  test: TEST,
  env: process.env,
  file: process.env.KP_RETENTION_FILE || path.join(__dirname, 'data', 'retention.json')
});
if (!retention.vapid.enabled) {
  console.log('Web Push is off until VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are set.');
}
if (!String(process.env.KP_ADMIN_TOKEN || '').trim()) {
  console.log('Ops locked until KP_ADMIN_TOKEN is set.');
} else {
  console.log('Ops desk is on /ops.');
}
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg'
};
const MAX_PLAYERS = 6;
function cleanClientId(v) {
  const s = String(v || '');
  return /^[a-zA-Z0-9-]{8,64}$/.test(s) ? s : null;
}

const host = createGameHost({
  test: TEST,
  afkFast: TEST && process.env.KP_AFK_FAST === '1',
  retention,
  records
});
const rooms = host.rooms;

const competition = createCompetition({
  file: process.env.KP_COMPETITION_FILE || path.join(__dirname, 'data', 'competition.json')
});
const ops = createOps({ rooms, retention, competition });
const server = http.createServer((req, res) => {
  if (ops.accepts(req)) { ops.handle(req, res); return; }
  if (retention.accepts(req)) { retention.handle(req, res); return; }
  const cleanUrl = req.url.split('?')[0];
  if (cleanUrl === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, build: BUILD }));
    return;
  }
  if (cleanUrl === '/api/records') {
    records.getRecords().then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    }).catch(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ enabled: records.enabled(), matches: [], landlords: [] }));
    });
    return;
  }
  if (cleanUrl.startsWith('/api/room/')) {
    const code = cleanUrl.slice('/api/room/'.length).trim().toUpperCase();
    const room = rooms.get(code);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    if (!room || room.mode === 'pass') { res.end(JSON.stringify({ exists: false })); return; }
    const hostPlayer = room.players.find((p) => p.id === room.hostId);
    let yourSeat = null;
    try {
      const cid = cleanClientId(new URL(req.url, 'http://localhost').searchParams.get('clientId'));
      if (cid) {
        const mine = room.players.find((p) => p.clientId && p.clientId === cid);
        if (mine) yourSeat = { name: mine.name, token: mine.token };
      }
    } catch (e) { yourSeat = null; }
    res.end(JSON.stringify({
      exists: true, code: room.code, status: room.status,
      hostName: hostPlayer ? hostPlayer.name : null,
      players: room.players.length, full: room.players.length >= MAX_PLAYERS,
      yourSeat
    }));
    return;
  }
  let filePath = cleanUrl === '/' ? '/index.html' : cleanUrl;
  filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    if (cleanUrl === '/' || cleanUrl === '/index.html' || cleanUrl === '/sw.js') data = stampAsset(cleanUrl, data);
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    const headers = { 'Content-Type': type };
    const cacheable = cleanUrl.startsWith('/vendor/') || cleanUrl.startsWith('/fonts/');
    headers['Cache-Control'] = cleanUrl === '/sw.js' ? 'no-store' : (cacheable ? 'public, max-age=604800' : 'no-cache');
    const compressible = /^(text\/|application\/json|image\/svg)/.test(type);
    if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(200, headers);
      res.end(zlib.gzipSync(data));
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => host.handleConnection(ws));

setInterval(() => { host.tick(); }, 500);

if (!TEST) {
  setInterval(() => { retention.sweepDrops().catch(() => {}); }, 15 * 60 * 1000);
  setTimeout(() => { retention.sweepDrops().catch(() => {}); }, 20000);
}
server.listen(PORT, () => {
  console.log('Kolopoly listening on port ' + PORT);
});
