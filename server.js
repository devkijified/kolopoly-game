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
const { createPrizeLedger } = require('./prize-ledger');
const { createTestProvider, createRedirectProvider, createOffProvider } = require('./pay-provider');
const { createMailer } = require('./mailer');
const { createAuth } = require('./auth');
const { createPaystack, createPaymentStore } = require('./paystack');
const records = require('./server-records.js');

const PORT = process.env.PORT || 4173;
const TEST = process.env.KP_TEST === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const BUILD_FILES = [
  'public/index.html',
  'public/app.js',
  'public/style.css',
  'public/premium.css',
  'public/game-feel.js',
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
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg'
};
const MAX_PLAYERS = 6;
function cleanClientId(v) {
  const s = String(v || '');
  return /^[a-zA-Z0-9-]{8,64}$/.test(s) ? s : null;
}

const competition = createCompetition({
  file: process.env.KP_COMPETITION_FILE || path.join(__dirname, 'data', 'competition.json')
});
const prizeLedger = createPrizeLedger({
  file: process.env.KP_PRIZES_FILE || path.join(__dirname, 'data', 'prizes.json')
});
// Paid play plumbing: email accounts, the mailer, Paystack and the
// payment records. The provider mode follows the environment: test
// builds run the test provider; a host with a Paystack secret key
// settles real payments from the webhook, verify and sweep; a host
// with no key keeps paid payments in the not-set-up state.
const mailer = createMailer({});
if (mailer.testMode) console.log('Mail runs on the test transport: sign-in codes are logged, not sent. Set RESEND_API_KEY to send real mail.');
const auth = createAuth({});
if (auth.ephemeral) console.log('Email sign-in uses a boot secret: sessions reset when the server restarts. Set KP_AUTH_SECRET to keep them.');
const paystack = createPaystack({});
const payments = createPaymentStore({
  file: process.env.KP_PAYMENTS_FILE || path.join(__dirname, 'data', 'payments.json')
});
const payProvider = paystack.enabled && (process.env.KP_PAYMENTS === 'paystack' || !TEST)
  ? createRedirectProvider()
  : TEST ? createTestProvider({ delayMs: 10 }) : createOffProvider();
if (payProvider.mode === 'test') {
  console.log('Paid tables run in test mode: seat payments confirm without moving real money.');
} else if (payProvider.mode === 'redirect') {
  console.log('Paid tables: Paystack is set up. Seats settle from the webhook, verify calls and the reconcile sweep.');
} else {
  console.log('Paid tables: payments are not set up yet (no Paystack key on this host). Paid seats cannot be paid here.');
}
const host = createGameHost({
  test: TEST,
  afkFast: TEST && process.env.KP_AFK_FAST === '1',
  retention,
  records,
  competition,
  prizeLedger,
  payProvider,
  auth
});
const rooms = host.rooms;

// The one settle funnel for real payments. The webhook, verify on
// return and the reconcile sweep all land here; a payment confirmed
// by any of them settles exactly once, because a record already paid
// answers duplicate and changes nothing. The amount must match the
// record to the kobo: a success for the wrong amount settles nothing.
function settlePayment(reference, via, outcome) {
  const rec = payments.get(reference);
  if (!rec) return { ok: false, reason: 'unknown' };
  if (rec.status === 'paid') return { ok: true, duplicate: true };
  if (rec.status !== 'pending') return { ok: false, reason: 'closed' };
  if (outcome && outcome.status === 'success' && Number(outcome.amountKobo) === rec.amountKobo) {
    payments.update(reference, { status: 'paid' }, { kind: 'settled', via });
    host.settlePaidSeat(rec.roomCode, { playerId: rec.playerId, accountId: rec.accountId }, { ref: reference });
    return { ok: true, settled: true };
  }
  if (outcome && (outcome.status === 'failed' || outcome.status === 'abandoned')) {
    payments.update(reference, { status: 'failed' }, { kind: 'failed', via });
    return { ok: true, failed: true };
  }
  return { ok: false, reason: 'not-success' };
}
// The reconcile sweep: a payment whose webhook never arrived and
// whose player never came back still settles, by asking Paystack
// directly about anything pending past the grace age.
const SWEEP_INTERVAL_MS = Number(process.env.KP_SWEEP_INTERVAL_MS) || 30000;
const SWEEP_AGE_MS = Number(process.env.KP_SWEEP_AGE_MS) || 60000;
if (paystack.enabled) {
  setInterval(async () => {
    try {
      const pending = payments.pendingOlderThan(SWEEP_AGE_MS).slice(0, 5);
      for (const rec of pending) {
        const v = await paystack.verify(rec.reference);
        if (v.ok) settlePayment(rec.reference, 'sweep', { status: v.status, amountKobo: v.amountKobo });
      }
    } catch (e) { /* the next sweep tries again */ }
  }, SWEEP_INTERVAL_MS);
}

const ops = createOps({ rooms, retention, competition, prizes: prizeLedger });
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req, limit) {
  const raw = await readRawBody(req, limit || 16384);
  return JSON.parse(raw.toString('utf8'));
}
function bearerOf(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : '';
}
const SIGNIN_HTTP_MESSAGE = 'Sign in with your email first. Paid tables need an account, so your money and your record stay yours.';

const server = http.createServer((req, res) => {
  if (ops.accepts(req)) { ops.handle(req, res); return; }
  if (retention.accepts(req)) { retention.handle(req, res); return; }
  const cleanUrl = req.url.split('?')[0];
  // Email sign-in for paid play. The code goes out through the mailer
  // seam; in test mode on the test transport the response also carries
  // the code, which is how the suite proves the flow without a mailbox.
  if (cleanUrl === '/api/auth/request' && req.method === 'POST') {
    (async () => {
      let body;
      try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { ok: false, error: 'body', message: 'That request no clear. Try again.' }); return; }
      const out = auth.requestCode(body && body.email);
      if (!out.ok) { sendJson(res, out.error === 'rate' ? 429 : 400, { ok: false, error: out.error, message: out.message }); return; }
      const sent = await mailer.sendCode(out.email, out.code);
      if (!sent.ok) { sendJson(res, 502, { ok: false, error: 'mail', message: 'The code no send. Try again.' }); return; }
      const reply = { ok: true };
      if (TEST && mailer.testMode) reply.devCode = out.code;
      sendJson(res, 200, reply);
    })().catch(() => { if (!res.headersSent) sendJson(res, 500, { ok: false }); });
    return;
  }
  if (cleanUrl === '/api/auth/verify' && req.method === 'POST') {
    (async () => {
      let body;
      try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { ok: false, error: 'body', message: 'That request no clear. Try again.' }); return; }
      const out = auth.verifyCode(body && body.email, body && body.code);
      if (!out.ok) { sendJson(res, 400, { ok: false, error: out.error, message: out.message }); return; }
      sendJson(res, 200, { ok: true, token: out.token, accountId: out.accountId, email: out.email });
    })().catch(() => { if (!res.headersSent) sendJson(res, 500, { ok: false }); });
    return;
  }
  if (cleanUrl === '/api/auth/me' && req.method === 'GET') {
    const acct = auth.verifyToken(bearerOf(req));
    if (!acct) { sendJson(res, 401, { ok: false, error: 'auth', message: SIGNIN_HTTP_MESSAGE }); return; }
    sendJson(res, 200, { ok: true, accountId: acct.accountId, email: acct.email });
    return;
  }
  // Open a Paystack transaction for the caller's own seat. The amount
  // comes from the room's snapshotted ladder fee, never the client.
  if (cleanUrl === '/api/payments/initialize' && req.method === 'POST') {
    (async () => {
      const acct = auth.verifyToken(bearerOf(req));
      if (!acct) { sendJson(res, 401, { ok: false, error: 'auth', message: SIGNIN_HTTP_MESSAGE }); return; }
      let body;
      try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { ok: false, error: 'body', message: 'That request no clear. Try again.' }); return; }
      const room = rooms.get(String((body && body.roomCode) || '').trim().toUpperCase());
      if (!room || !room.paid) { sendJson(res, 404, { ok: false, error: 'room', message: 'That paid room no dey again.' }); return; }
      if (room.status !== 'lobby') { sendJson(res, 400, { ok: false, error: 'room', message: 'Payment na for before the game start.' }); return; }
      const seat = room.players.find((p) => !p.bot && p.accountId === acct.accountId);
      if (!seat) { sendJson(res, 403, { ok: false, error: 'seat', message: 'You no get seat for that table.' }); return; }
      if (seat.paidSeat) { sendJson(res, 200, { ok: true, alreadyPaid: true }); return; }
      if (!paystack.enabled) { sendJson(res, 503, { ok: false, error: 'not-set-up', message: 'Payments never set up yet. The paid table dey wait for the house to finish the setup.' }); return; }
      const existing = payments.findPending(room.code, acct.accountId);
      if (existing && existing.authorizationUrl) { sendJson(res, 200, { ok: true, reference: existing.reference, authorizationUrl: existing.authorizationUrl }); return; }
      const reference = 'kp' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
      const amountKobo = room.paidFee * 100;
      const callbackUrl = (process.env.KP_PUBLIC_URL || 'https://kolopoly.fun') + '/';
      const init = await paystack.initialize({
        email: acct.email, amountKobo, reference, callbackUrl,
        metadata: { roomCode: room.code, playerId: seat.id, accountId: acct.accountId, cityId: room.cityId }
      });
      if (!init.ok) { sendJson(res, 502, { ok: false, error: 'initialize', message: init.message }); return; }
      payments.create({ reference, roomCode: room.code, playerId: seat.id, accountId: acct.accountId, email: acct.email, cityId: room.cityId, amountKobo, authorizationUrl: init.authorizationUrl });
      sendJson(res, 200, { ok: true, reference, authorizationUrl: init.authorizationUrl });
    })().catch(() => { if (!res.headersSent) sendJson(res, 500, { ok: false }); });
    return;
  }
  // Verify on return: the client polls with its reference; the server
  // asks Paystack and settles from the answer, so a payment lands
  // even when the webhook is slow or never arrives.
  if (cleanUrl === '/api/payments/status' && req.method === 'GET') {
    (async () => {
      const ref = new URL(req.url, 'http://localhost').searchParams.get('reference') || '';
      const rec = payments.get(ref);
      if (!rec) { sendJson(res, 404, { ok: false, error: 'unknown', message: 'That payment no dey.' }); return; }
      if (rec.status === 'pending' && paystack.enabled) {
        const v = await paystack.verify(ref);
        if (v.ok) settlePayment(ref, 'verify', { status: v.status, amountKobo: v.amountKobo });
      }
      const fresh = payments.get(ref);
      sendJson(res, 200, { ok: true, reference: ref, status: fresh.status, roomCode: fresh.roomCode });
    })().catch(() => { if (!res.headersSent) sendJson(res, 500, { ok: false }); });
    return;
  }
  // The Paystack webhook. The signature is checked over the raw body
  // before anything is parsed; unsigned or wrongly signed deliveries
  // are refused and settle nothing. Duplicates are safe: the funnel
  // settles a reference exactly once.
  if (cleanUrl === '/api/paystack/webhook' && req.method === 'POST') {
    readRawBody(req, 256 * 1024).then((raw) => {
      if (!paystack.verifySignature(raw, req.headers['x-paystack-signature'])) {
        sendJson(res, 401, { ok: false, error: 'signature' });
        return;
      }
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch (e) { sendJson(res, 400, { ok: false, error: 'body' }); return; }
      if (body && body.event === 'charge.success' && body.data) {
        settlePayment(String(body.data.reference || ''), 'webhook', { status: body.data.status, amountKobo: Number(body.data.amount) || 0 });
      }
      sendJson(res, 200, { ok: true });
    }).catch(() => { if (!res.headersSent) sendJson(res, 400, { ok: false }); });
    return;
  }
  if (cleanUrl === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, build: BUILD }));
    return;
  }
  if (cleanUrl === '/api/competition') {
    // Public by design: the ladder (cities, fees, winner and house
    // figures) is the price list on the landing page door. No keys, no
    // ledger, nothing private rides this route.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      ok: true,
      testMode: !!payProvider.testMode,
      provider: payProvider.name,
      mode: payProvider.mode,
      accountRequired: payProvider.mode !== 'test',
      settings: competition.settings(),
      table: competition.view().table
    }));
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
    const cacheable = cleanUrl.startsWith('/vendor/') || cleanUrl.startsWith('/fonts/') || cleanUrl.startsWith('/assets/');
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
