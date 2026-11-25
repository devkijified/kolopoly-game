'use strict';
// KOLOPOLY server. Node host: built-in http + ws. Live tables are
// snapshotted to disk (KP_DATA_DIR/rooms.json) so a deploy or restart
// restores the same games and players rejoin their seats.
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
const { createPayouts } = require('./payouts');
const { createPlayCredit } = require('./play-credit');
const { createDurable } = require('./durable');
const records = require('./server-records.js');

const PORT = process.env.PORT || 4173;
const TEST = process.env.KP_TEST === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const BUILD_FILES = [
  'public/index.html',
  'public/classic.html',
  'public/app.js',
  'public/style.css',
  'public/premium.css',
  'public/game-feel.js',
  'public/sw.js',
  'public/retention.js',
  'public/update.js',
  'public/big-daddy.js',
  'public/tutorial.js',
  'public/big-daddy.css',
  'public/rewards-ui.js',
  'public/rewards-ui.css',
  'public/stickers/lekki-toll-gate.webp',
  'public/stickers/carter-bridge.webp',
  'public/stickers/third-mainland-bridge.webp',
  'public/stickers/balogun-market.webp',
  'public/stickers/suya-spot.webp',
  'public/stickers/computer-village.webp',
  'public/stickers/tafawa-balewa-square.webp',
  'public/stickers/national-theatre.webp',
  'public/stickers/eko-atlantic.webp',
  'public/stickers/danfo.webp',
  'public/stickers/molue.webp',
  'public/stickers/okada.webp',
  'public/stickers/kirikiri.webp',
  'public/stickers/owambe-hall.webp',
  'public/stickers/marina-lights.webp',
  'public/stickers/event-owambe.webp',
  'public/stickers/event-nepa.webp',
  'public/stickers/event-toll.webp',
  'public/stickers/event-marina.webp',
  'public/tokens/mama-put.webp',
  'public/tokens/big-man.webp',
  'public/tokens/conductor.webp',
  'public/tokens/area-father.webp',
  'public/tokens/suya.webp',
  'public/tokens/gele.webp',
  'public/tokens/jollof-pot.webp',
  'public/tokens/agege-bread.webp',
  'public/cards/bail.webp',
  'public/cards/shield.webp',
  'public/cards/double.webp',
  'public/cards/dash.webp',
  'public/mascot/daddy-money.webp',
  'public/mascot/daddy-deed.webp',
  'public/mascot/daddy-jail.webp',
  'public/mascot/daddy-clap.webp',
  'public/mascot/daddy-stand.webp',
  'public/game-data.js',
  'public/board.js',
  'public/board3d.js',
  'public/icons.js',
  'public/manifest.webmanifest',
  'public/vendor/three.module.js',
  'public/vendor/qrcode.js',
  'public/fonts/aeonik-pro-bold.woff2',
  'public/fonts/aeonik-pro-bold.woff',
  'public/fonts/figtree-variable.woff2',
  'public/tex/asphalt-col.webp',
  'public/tex/asphalt-nor.webp',
  'public/tex/concrete-col.webp',
  'public/tex/concrete-nor.webp',
  'public/sfx/ambient-highlife.mp3',
  'public/sfx/cash.mp3',
  'public/sfx/siren.mp3',
  'public/icons/icon-192.png',
  'public/icons/icon-512.png',
  'public/icons/icon-512-maskable.png',
  'public/icons/apple-touch-icon.png'
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
const STAMP_EXT = new Set(['.html', '.js', '.css', '.webmanifest', '.json', '.svg', '.txt', '.md']);
function stampAsset(cleanUrl, data) {
  const file = cleanUrl === '/' ? '/index.html' : cleanUrl;
  const ext = path.extname(file);
  let buf = data;
  if (STAMP_EXT.has(ext)) {
    const text = data.toString('utf8');
    if (text.includes('__KOLOPOLY_BUILD__')) buf = Buffer.from(text.split('__KOLOPOLY_BUILD__').join(BUILD));
  }
  if (cleanUrl === '/sw.js') buf = Buffer.concat([buf, Buffer.from('\n// kolopoly-build ' + BUILD + '\n')]);
  return buf;
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
  '.txt': 'text/plain', '.md': 'text/plain',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.wasm': 'application/wasm'
};
function typeWithCharset(type) {
  if (/^(text\/|application\/(javascript|json|manifest\+json))/.test(type) && !/charset=/i.test(type)) {
    return type + '; charset=utf-8';
  }
  return type;
}
function compressibleType(type) {
  return /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg)/.test(type);
}
function cacheControlFor(cleanUrl, version) {
  if (cleanUrl === '/sw.js') return 'no-store';
  if (cleanUrl === '/' || cleanUrl.endsWith('.html') || cleanUrl.startsWith('/api/')) return 'no-cache';
  if (version === BUILD) return 'public, max-age=31536000, immutable';
  if (cleanUrl.startsWith('/vendor/') || cleanUrl.startsWith('/fonts/')) return 'public, max-age=604800';
  return 'no-cache';
}
function walkPublic(dir, acc) {
  acc = acc || [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkPublic(abs, acc);
    else acc.push(abs);
  }
  return acc;
}
const staticCache = new Map();
function prepareStaticCache() {
  for (const abs of walkPublic(PUBLIC_DIR)) {
    const rel = '/' + path.relative(PUBLIC_DIR, abs).split(path.sep).join('/');
    const raw = stampAsset(rel, fs.readFileSync(abs));
    const type = MIME[path.extname(abs)] || 'application/octet-stream';
    const entry = {
      raw,
      type,
      etag: '"' + crypto.createHash('sha1').update(raw).digest('hex') + '"',
      gzip: null,
      br: null
    };
    if (compressibleType(type)) {
      entry.gzip = zlib.gzipSync(raw, { level: 9 });
      entry.br = zlib.brotliCompressSync(raw, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
        }
      });
    }
    staticCache.set(rel, entry);
  }
}
const MAX_PLAYERS = 6;
function cleanClientId(v) {
  const s = String(v || '');
  return /^[a-zA-Z0-9-]{8,64}$/.test(s) ? s : null;
}

// Where the JSON stores live. Point KP_DATA_DIR at a mounted disk on a
// host that has one; on a host without (Render free), the money stores
// also mirror into Supabase through durable.js.
const DATA_DIR = process.env.KP_DATA_DIR || path.join(__dirname, 'data');
const durable = createDurable(process.env);
if (durable.enabled) console.log('Money records mirror to Supabase (kolopoly_kv), so a restart or redeploy keeps them.');
else console.log('Money records live only in ' + DATA_DIR + '. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (and run migrations/002_kolopoly_kv.sql) or KP_DATA_DIR on a disk, or a redeploy loses them.');
const competition = createCompetition({
  file: process.env.KP_COMPETITION_FILE || path.join(DATA_DIR, 'competition.json')
});
const prizeLedger = createPrizeLedger({
  file: process.env.KP_PRIZES_FILE || path.join(DATA_DIR, 'prizes.json'),
  mirror: durable.mirror('prizes')
});
// Paid play plumbing: email accounts, the mailer, Paystack and the
// payment records. The provider mode follows the environment: test
// builds run the test provider; a host with a Paystack secret key
// settles real payments from the webhook, verify and sweep; a host
// with no key keeps paid payments in the not-set-up state.
const mailer = createMailer({});
if (mailer.testMode) console.log('Mail runs on the test transport: sign-in codes are logged, not sent. Set RESEND_API_KEY to send real mail.');
const auth = createAuth({});
const playCredit = createPlayCredit({ file: process.env.KP_PLAY_CREDIT_FILE || path.join(DATA_DIR, 'play-credits.json') });
if (auth.ephemeral) console.log('Email sign-in uses a boot secret: sessions reset when the server restarts. Set KP_AUTH_SECRET to keep them.');
// The shelf is created after auth on purpose: with accounts wired
// in, the shelf lives under the account, and a device shelf is
// adopted into the account shelf at first signed-in contact.
const retention = createRetention({
  test: TEST,
  env: process.env,
  auth,
  file: process.env.KP_RETENTION_FILE || path.join(DATA_DIR, 'retention.json')
});
if (!retention.vapid.enabled) {
  console.log('Web Push is off until VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are set.');
}
const paystack = createPaystack({});
const payments = createPaymentStore({
  file: process.env.KP_PAYMENTS_FILE || path.join(DATA_DIR, 'payments.json'),
  mirror: durable.mirror('payments')
});
// The payout queue: every prize and refund the ledger writes becomes
// one payout row; money moves from the desk (or by itself when
// KP_PAYOUT_MODE=auto) through Paystack transfers and refunds.
const payouts = createPayouts({
  file: process.env.KP_PAYOUTS_FILE || path.join(DATA_DIR, 'payouts.json'),
  mirror: durable.mirror('payouts'),
  paystack, payments
});
prizeLedger.setOnAdd((entry) => payouts.fromLedger(entry));
console.log('Payouts run in ' + (process.env.KP_PAYOUT_MODE === 'auto' ? 'auto' : 'manual') + ' mode' + (process.env.KP_PAYOUT_MODE === 'auto' ? ': ready prizes and refunds send by themselves.' : ': the ops desk sends each prize and refund.'));
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
// The full sign-in gate, same derivation as the game host: real
// payment modes plus wired auth means every table needs an account.
const signInRequired = payProvider.mode !== 'test' && !!auth;
// Live tables. Off during the test suite unless a test opts in, so
// suites that share a machine do not resurrect each other's rooms.
// Production (KP_TEST unset) always snapshots.
const PERSIST_ROOMS = !TEST || process.env.KP_PERSIST_ROOMS === '1';
const ROOMS_FILE = process.env.KP_ROOMS_FILE || path.join(DATA_DIR, 'rooms.json');
let roomSaveTimer = null;
function flushRoomsSync() {
  if (!PERSIST_ROOMS) return;
  if (roomSaveTimer) { clearTimeout(roomSaveTimer); roomSaveTimer = null; }
  try {
    fs.mkdirSync(path.dirname(ROOMS_FILE), { recursive: true });
    const doc = host.exportState();
    doc.savedAt = Date.now();
    const tmp = ROOMS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc));
    fs.renameSync(tmp, ROOMS_FILE);
  } catch (e) {
    console.log('Room snapshot could not be written (' + (e && e.message) + ').');
  }
}
function scheduleRoomSave() {
  if (!PERSIST_ROOMS || roomSaveTimer) return;
  roomSaveTimer = setTimeout(flushRoomsSync, 200);
  if (roomSaveTimer.unref) roomSaveTimer.unref();
}
const host = createGameHost({
  test: TEST,
  afkFast: TEST && process.env.KP_AFK_FAST === '1',
  retention,
  records,
  competition,
  prizeLedger,
  payProvider,
  auth,
  playCredit,
  onMutate() { scheduleRoomSave(); },
  leanWire: true,
  onDelete() { scheduleRoomSave(); },
  // The paid game tells the payment records where each entry's money
  // went: into a started game, then out as prize and house share.
  onPaidEvent(ev) {
    const seat = ev.type === 'start' ? 'in-game' : ev.type === 'settled' ? 'consumed' : null;
    if (!seat) return;
    for (const ref of ev.refs || []) {
      const rec = payments.get(ref);
      if (rec && rec.status === 'paid') payments.update(ref, { seat }, { kind: seat, gameKey: ev.gameKey || null });
    }
  }
});
const rooms = host.rooms;
function loadRooms() {
  if (!PERSIST_ROOMS) return;
  let raw;
  try { raw = fs.readFileSync(ROOMS_FILE, 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') console.log('Room snapshot could not be read (' + e.message + '). Starting with no live tables.');
    return;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || !data.rooms) return;
    host.importState(data);
    host.restoredFromDisk(data.savedAt);
    const n = host.rooms.size;
    if (n) console.log('Restored ' + n + ' live table' + (n === 1 ? '' : 's') + ' from disk. Players rejoin the same game.');
  } catch (e) {
    console.log('Room snapshot could not be read (' + (e && e.message) + '). Starting with no live tables.');
  }
}
if (PERSIST_ROOMS) console.log('Live tables snapshot to ' + ROOMS_FILE + ' on each change and on shutdown.');

// The one settle funnel for real payments. The webhook, verify on
// return and the reconcile sweep all land here; a payment confirmed
// by any of them settles exactly once, because a record already paid
// answers duplicate and changes nothing. The amount must match the
// record to the kobo: a success for the wrong amount settles nothing.
// How long an opened payment may stay unfinished before the sweep stops
// asking. Paystack reports an opened-but-unpaid transaction as
// "abandoned" from the first second, so abandoned alone never closes a
// payment; only this age does. A success that lands after the close
// still settles (late success always wins).
const PAY_EXPIRE_MS = Number(process.env.KP_PAY_EXPIRE_MS) || 45 * 60 * 1000;
function refundDueFor(rec, why, amountKobo) {
  const kobo = amountKobo || rec.amountKobo;
  prizeLedger.add({
    roomCode: rec.roomCode, playerId: rec.playerId, name: rec.email ? rec.email.split('@')[0] : 'Player',
    amount: Math.max(1, Math.round(kobo / 100)), amountKobo: kobo, kind: 'refund-due', cityId: rec.cityId,
    accountId: rec.accountId, email: rec.email, reference: rec.reference, why, at: Date.now(), testMode: false
  });
}
function settlePayment(reference, via, outcome) {
  const rec = payments.get(reference);
  if (!rec) return { ok: false, reason: 'unknown' };
  if (rec.status === 'paid') return { ok: true, duplicate: true };
  const success = outcome && outcome.status === 'success';
  if (success) {
    const late = rec.status !== 'pending';
    if (Number(outcome.amountKobo) !== rec.amountKobo || (outcome.currency && String(outcome.currency).toUpperCase() !== 'NGN')) {
      // Money arrived, but not the money this seat costs. It never seats
      // anybody; it goes straight back.
      payments.update(reference, { status: 'paid', seat: 'mismatch' }, { kind: 'mismatch', via, amountKobo: Number(outcome.amountKobo) || 0, currency: outcome.currency || null });
      console.log('Payment ' + reference + ' paid the wrong amount; queued for refund.');
      refundDueFor(rec, 'wrong-amount', Number(outcome.amountKobo) || rec.amountKobo);
      return { ok: true, mismatch: true };
    }
    payments.update(reference, { status: 'paid' }, { kind: 'settled', via, late: late || undefined });
    const seated = host.settlePaidSeat(rec.roomCode, { playerId: rec.playerId, accountId: rec.accountId }, { ref: reference });
    if (seated) {
      payments.update(reference, { seat: 'seated' }, { kind: 'seated' });
    } else {
      // Paid, but the seat is gone (the room closed, the game started,
      // the player left, or this seat was already paid another way).
      // The money is owed back, never kept.
      console.log('Payment ' + reference + ' confirmed with no seat to hold it; queued for refund.');
      refundDueFor(rec, 'no-seat');
    }
    return { ok: true, settled: true, seated };
  }
  if (rec.status !== 'pending') return { ok: false, reason: 'closed' };
  if (outcome && (outcome.status === 'failed' || outcome.status === 'reversed')) {
    payments.update(reference, { status: 'failed' }, { kind: 'failed', via });
    return { ok: true, failed: true };
  }
  if (Date.now() - rec.createdAt > PAY_EXPIRE_MS) {
    payments.update(reference, { status: 'failed' }, { kind: 'expired', via, last: outcome ? outcome.status : null });
    return { ok: true, failed: true, expired: true };
  }
  return { ok: false, reason: 'not-success' };
}
async function verifyAndSettle(reference, via) {
  payments.touch(reference);
  const v = await paystack.verify(reference);
  if (v.ok) {
    const settled = settlePayment(reference, via, { status: v.status, amountKobo: v.amountKobo, currency: v.currency });
    // gateway is Paystack's own word (abandoned, pending, success).
    // The record stays pending on abandoned so a late transfer webhook
    // can still seat the player. channel tells a bank transfer apart
    // from a checkout the player walked away from.
    return Object.assign({}, settled, { gateway: v.status || '', channel: v.channel || '' });
  }
  return { ok: false, reason: 'verify', gateway: '', channel: '' };
}
// The reconcile sweep: a payment whose webhook never arrived and
// whose player never came back still settles, by asking Paystack
// directly about anything pending past the grace age. The same beat
// finishes prize transfers left in flight.
const SWEEP_INTERVAL_MS = Number(process.env.KP_SWEEP_INTERVAL_MS) || 30000;
const SWEEP_AGE_MS = Number(process.env.KP_SWEEP_AGE_MS) || 60000;
function startSweeps() {
  if (!paystack.enabled) return;
  setInterval(async () => {
    try {
      const pending = payments.pendingOlderThan(SWEEP_AGE_MS).slice(0, 5);
      for (const rec of pending) await verifyAndSettle(rec.reference, 'sweep');
    } catch (e) { /* the next sweep tries again */ }
    try { await payouts.sweep(SWEEP_AGE_MS); } catch (e) { /* the next sweep tries again */ }
  }, SWEEP_INTERVAL_MS);
}
// Boot reconcile. Rooms live in memory on this host, so a restart ends
// every lobby and every running game. Any entry whose money was still
// held by a seat or a game when the process stopped is owed back: it
// becomes a refund, exactly once (the payment record moves to
// refund-due as the ledger writes it). Records from before the seat
// field existed are judged by the ledger: a prize written for the room
// after the payment means the money was consumed.
function bootReconcile() {
  const ledger = prizeLedger.list();
  // Ledger rows that predate the payout queue still get their row.
  for (const e of ledger) { try { payouts.fromLedger(e); } catch (err) { /* keep going */ } }
  let refunded = 0;
  for (const rec of payments.list()) {
    if (rec.status !== 'paid') continue;
    if (rec.seat === 'consumed' || rec.seat === 'refund-due' || rec.seat === 'refunded' || rec.seat === 'mismatch') continue;
    if (rec.seat === undefined) {
      const settledAt = rec.updatedAt || rec.createdAt;
      const consumed = ledger.some((e) => e.kind === 'prize' && e.roomCode === rec.roomCode && e.at >= settledAt);
      const owed = ledger.some((e) => e.kind === 'refund-due' && e.roomCode === rec.roomCode && (e.reference === rec.reference || (!e.reference && e.accountId === rec.accountId)));
      if (consumed) { payments.update(rec.reference, { seat: 'consumed' }, { kind: 'consumed', via: 'boot' }); continue; }
      if (owed) { payments.update(rec.reference, { seat: 'refund-due' }, { kind: 'refund-due', via: 'boot' }); continue; }
    }
    refundDueFor(rec, 'restart');
    refunded += 1;
  }
  if (refunded) console.log('Boot reconcile: ' + refunded + ' paid entr' + (refunded === 1 ? 'y' : 'ies') + ' held by a table that did not survive the restart, queued for refund.');
}
// The money view the ops desk reads: payments in, payouts out, house.
function moneyView() {
  const list = payments.list();
  const real = list.filter((r) => r.status === 'paid');
  const collectedKobo = real.reduce((t, r) => t + (r.amountKobo || 0), 0);
  const ledger = prizeLedger.list().filter((e) => !e.testMode);
  const houseKobo = ledger.filter((e) => e.kind === 'house').reduce((t, e) => t + (e.amountKobo || e.amount * 100), 0);
  const games = new Set(ledger.filter((e) => e.kind === 'prize').map((e) => e.gameKey || (e.roomCode + ':' + e.at))).size;
  const pv = payouts.view();
  return {
    ok: true,
    paystack: { enabled: paystack.enabled, mode: payProvider.mode },
    durable: durable.enabled,
    totals: Object.assign({ collectedKobo, houseKobo, paidGames: games, payments: list.length, paidPayments: real.length }, pv.totals),
    payoutMode: pv.mode,
    payouts: pv.payouts.slice(0, 200),
    payments: list.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200).map((r) => ({
      reference: r.reference, roomCode: r.roomCode, email: r.email, amountKobo: r.amountKobo,
      status: r.status, seat: r.seat || null, createdAt: r.createdAt, updatedAt: r.updatedAt,
      via: (r.events || []).filter((e) => e.kind === 'settled').map((e) => e.via)[0] || null
    }))
  };
}
async function moneyAction(body) {
  const id = String((body && body.id) || '');
  const action = String((body && body.action) || '');
  if (action === 'send') return payouts.send(id, 'desk');
  if (action === 'approve') return payouts.approve(id);
  if (action === 'mark') return payouts.markManual(id, body && body.note);
  if (action === 'recheck') {
    const r = await verifyAndSettle(id, 'desk');
    return { ok: !!r.ok, status: (payments.get(id) || {}).status || null };
  }
  return { ok: false, error: 'action', message: 'Unknown action.' };
}

let socketCount = () => 0;
const recentErrors = [];
function noteServerError() {
  recentErrors.push(Date.now());
  if (recentErrors.length > 40) recentErrors.shift();
}
function errorRate() {
  const cut = Date.now() - 60000;
  while (recentErrors.length && recentErrors[0] < cut) recentErrors.shift();
  return recentErrors.length;
}
const ops = createOps({
  rooms, retention, competition, prizes: prizeLedger,
  money: { view: moneyView, action: moneyAction },
  seed: TEST,
  build: BUILD,
  wsCount: () => socketCount(),
  errorRate,
  admin: (body) => host.adminAct(body),
  playCredit,
  auditFile: process.env.KP_OPS_AUDIT_FILE || path.join(DATA_DIR, 'ops-audit.json')
});
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
const bankTries = new Map();
const SIGNIN_HTTP_MESSAGE = 'Sign in with your email first. Paid tables need an account, so your money and your record stay yours.';

prepareStaticCache();

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
      // No mail key on a real host: say so before a code is stored, so
      // Try again is not blocked by the per-email gap.
      if (mailer.testMode && !TEST) {
        sendJson(res, 503, { ok: false, error: 'mail', message: 'Sign-in mail never set up yet. Nothing was sent. Try again.' });
        return;
      }
      if (!allowAuthIp(clientIp(req))) {
        sendJson(res, 429, { ok: false, error: 'rate', message: 'Too many sign-in codes from this network. Wait small, then try again.' });
        return;
      }
      const out = auth.requestCode(body && body.email);
      if (!out.ok) { sendJson(res, out.error === 'rate' ? 429 : 400, { ok: false, error: out.error, message: out.message }); return; }
      const sent = await mailer.sendCode(out.email, out.code);
      if (!sent.ok) {
        sendJson(res, mailer.testMode ? 503 : 502, { ok: false, error: 'mail', message: (sent && sent.message) || 'The code no send. Nothing was sent. Try again.' });
        return;
      }
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
  if (cleanUrl === '/api/tables' && req.method === 'GET') {
    const tables = [];
    for (const room of rooms.values()) {
      if (room.status !== 'lobby') continue;
      const humans = room.players.filter((p) => !p.bot).length;
      if (humans >= 6) continue;
      tables.push({
        code: room.code,
        paid: !!room.paid,
        city: room.paidCity || 'Free',
        mode: room.settings && room.settings.gameMode === 'inflation' ? 'Inflation' : 'Classic',
        fee: room.paid ? room.paidFee : 0,
        seats: room.players.length,
        humans,
        open: humans < 6
      });
    }
    sendJson(res, 200, { ok: true, tables });
    return;
  }
  if (cleanUrl === '/api/auth/me' && req.method === 'GET') {
    const acct = auth.verifyToken(bearerOf(req));
    if (!acct) { sendJson(res, 401, { ok: false, error: 'auth', message: SIGNIN_HTTP_MESSAGE }); return; }
    sendJson(res, 200, { ok: true, accountId: acct.accountId, email: acct.email, installed: retention.accountInstalled(acct.accountId) });
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
      const feeKobo = room.paidFee * 100;
      if (playCredit.balance(acct.accountId) >= feeKobo) {
        const spent = playCredit.spend(acct.accountId, feeKobo, 'paid seat', room.code);
        if (spent.ok) {
          host.settlePaidSeat(room.code, { accountId: acct.accountId }, { ref: spent.spendId });
          sendJson(res, 200, { ok: true, credited: true, balanceKobo: spent.balanceKobo });
          return;
        }
      }
      if (!paystack.enabled) { sendJson(res, 503, { ok: false, error: 'not-set-up', message: 'Payments never set up yet. The paid table dey wait for the house to finish the setup.' }); return; }
      // An earlier open payment for this seat is reused, after asking
      // Paystack about it: it may have been paid already (settle it now),
      // failed, or gone stale (open a fresh one).
      const existing = payments.findPending(room.code, acct.accountId);
      if (existing && existing.authorizationUrl) {
        if (Date.now() - existing.createdAt > 20000) {
          const r = await verifyAndSettle(existing.reference, 'reopen');
          const fresh = payments.get(existing.reference);
          if (fresh.status === 'paid') { sendJson(res, 200, { ok: true, alreadyPaid: true, reference: existing.reference }); return; }
          if (fresh.status === 'pending' && Date.now() - existing.createdAt < 20 * 60 * 1000) { sendJson(res, 200, { ok: true, reference: existing.reference, authorizationUrl: existing.authorizationUrl }); return; }
          if (fresh.status === 'pending') payments.update(existing.reference, { status: 'failed' }, { kind: 'replaced', via: 'reopen', last: r && r.reason });
        } else {
          sendJson(res, 200, { ok: true, reference: existing.reference, authorizationUrl: existing.authorizationUrl });
          return;
        }
      }
      const reference = 'kp' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
      const amountKobo = room.paidFee * 100;
      // Paystack sends the player back here with ?trxref=&reference=
      // appended; the room code lets the page rejoin the right table.
      const callbackUrl = (process.env.KP_PUBLIC_URL || 'https://kolopoly.fun').replace(/\/+$/, '') + '/?paid=' + encodeURIComponent(room.code);
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
      let gateway = '';
      let channel = '';
      if (rec.status === 'pending' && paystack.enabled) {
        const looked = await verifyAndSettle(ref, 'verify');
        gateway = looked.gateway || '';
        channel = looked.channel || '';
      }
      const fresh = payments.get(ref);
      sendJson(res, 200, {
        ok: true, reference: ref, status: fresh.status, seat: fresh.seat || null, roomCode: fresh.roomCode,
        gateway, channel, authorizationUrl: fresh.authorizationUrl || null
      });
    })().catch(() => { if (!res.headersSent) sendJson(res, 500, { ok: false }); });
    return;
  }
  // Winner payouts, player side: the bank list, saving a bank (checked
  // against the bank by Paystack, stored as a transfer recipient), and
  // my own prizes and refunds with their status.
  if (cleanUrl === '/api/payouts/banks' && req.method === 'GET') {
    (async () => {
      const acct = auth.verifyToken(bearerOf(req));
      if (!acct) { sendJson(res, 401, { ok: false, error: 'auth', message: SIGNIN_HTTP_MESSAGE }); return; }
      if (!paystack.enabled) { sendJson(res, 503, { ok: false, error: 'not-set-up', message: 'Payouts never set up yet.' }); return; }
      const out = await paystack.listBanks();
      if (!out.ok) { sendJson(res, 502, { ok: false, error: 'banks', message: 'The bank list no load. Try again.' }); return; }
      sendJson(res, 200, { ok: true, banks: out.banks });
    })().catch(() => { if (!res.headersSent) sendJson(res, 500, { ok: false }); });
    return;
  }
  if (cleanUrl === '/api/payouts/bank' && req.method === 'POST') {
    (async () => {
      const acct = auth.verifyToken(bearerOf(req));
      if (!acct) { sendJson(res, 401, { ok: false, error: 'auth', message: SIGNIN_HTTP_MESSAGE }); return; }
      const t = bankTries.get(acct.accountId) || { n: 0, until: Date.now() + 10 * 60 * 1000 };
      if (Date.now() > t.until) { t.n = 0; t.until = Date.now() + 10 * 60 * 1000; }
      t.n += 1; bankTries.set(acct.accountId, t);
      if (t.n > 6) { sendJson(res, 429, { ok: false, error: 'rate', message: 'Too many tries. Wait small, then try again.' }); return; }
      let body;
      try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { ok: false, error: 'body', message: 'That request no clear. Try again.' }); return; }
      const out = await payouts.setBank(acct, body);
      sendJson(res, out.ok ? 200 : (out.status || 400), out.ok ? { ok: true, bank: out.bank } : { ok: false, error: out.error, message: out.message });
    })().catch(() => { if (!res.headersSent) sendJson(res, 500, { ok: false }); });
    return;
  }
  if (cleanUrl === '/api/profile' && req.method === 'GET') {
    const acct = auth.verifyToken(bearerOf(req));
    if (!acct) { sendJson(res, 401, { ok: false, error: 'auth', message: SIGNIN_HTTP_MESSAGE }); return; }
    const credit = playCredit.view(acct.accountId);
    const wallet = payouts.mine(acct.accountId);
    const fees = payments.list().filter((r) => r.accountId === acct.accountId && (r.status === 'paid' || (r.seat && r.amountKobo))).map((r) => ({
      roomCode: r.roomCode, amount: (r.amountKobo || 0) / 100, status: r.status, at: r.createdAt
    }));
    sendJson(res, 200, {
      ok: true, email: acct.email,
      creditKobo: credit.balanceKobo || 0,
      credit: credit.entries || [],
      payouts: wallet.payouts || [],
      bank: wallet.bank || null,
      fees,
      stats: retention.profileOf(acct.accountId)
    });
    return;
  }
  if (cleanUrl === '/api/payouts/mine' && req.method === 'GET') {
    const acct = auth.verifyToken(bearerOf(req));
    if (!acct) { sendJson(res, 401, { ok: false, error: 'auth', message: SIGNIN_HTTP_MESSAGE }); return; }
    sendJson(res, 200, payouts.mine(acct.accountId));
    return;
  }
  if (cleanUrl === '/api/payouts/collect' && req.method === 'POST') {
    (async () => {
      const acct = auth.verifyToken(bearerOf(req));
      if (!acct) { sendJson(res, 401, { ok: false, error: 'auth', message: SIGNIN_HTTP_MESSAGE }); return; }
      let body;
      try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { ok: false, error: 'body', message: 'That request no clear. Try again.' }); return; }
      const out = await payouts.collect(acct.accountId, body || {});
      sendJson(res, out.ok ? 200 : (out.status || 400), out);
    })().catch(() => { if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'collect', message: 'The house could not send it. Try again.' }); });
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
      const event = String((body && body.event) || '');
      if (event === 'charge.success' && body.data) {
        settlePayment(String(body.data.reference || ''), 'webhook', { status: body.data.status, amountKobo: Number(body.data.amount) || 0, currency: body.data.currency });
      } else if (/^(transfer|refund)\./.test(event)) {
        payouts.onWebhook(event, body.data);
      }
      sendJson(res, 200, { ok: true });
    }).catch(() => { if (!res.headersSent) sendJson(res, 400, { ok: false }); });
    return;
  }
  if (cleanUrl === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, build: BUILD, playCredit: true }));
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
      signInRequired,
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
  const rel = cleanUrl === '/' ? '/index.html' : cleanUrl;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  const entry = staticCache.get(rel);
  if (!entry) { res.writeHead(404); res.end('Not found'); return; }
  let version = null;
  try { version = new URL(req.url, 'http://localhost').searchParams.get('v'); } catch (e) { version = null; }
  const headers = {
    'Content-Type': typeWithCharset(entry.type),
    'Cache-Control': cacheControlFor(cleanUrl, version)
  };
  const accept = req.headers['accept-encoding'] || '';
  let body = entry.raw;
  let etag = entry.etag;
  if (entry.br && /\bbr\b/.test(accept)) {
    headers['Content-Encoding'] = 'br';
    headers['Vary'] = 'Accept-Encoding';
    body = entry.br;
    etag = entry.etag.slice(0, -1) + '-br"';
  } else if (entry.gzip && /\bgzip\b/.test(accept)) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    body = entry.gzip;
    etag = entry.etag.slice(0, -1) + '-gzip"';
  } else if (entry.gzip || entry.br) {
    headers['Vary'] = 'Accept-Encoding';
  }
  headers['ETag'] = etag;
  headers['Content-Length'] = String(body.length);
  const inm = req.headers['if-none-match'];
  if (inm && inm === etag) {
    const notMod = { 'ETag': etag, 'Cache-Control': headers['Cache-Control'] };
    if (headers['Vary']) notMod['Vary'] = headers['Vary'];
    res.writeHead(304, notMod);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
});

// A phone plays at a few messages a second. These caps stop a single
// address from opening a pile of sockets, flooding the table, or
// asking for sign-in codes for every mailbox it can name. The email
// gap still applies on top of the network cap.
const WS_MAX_PAYLOAD = 64 * 1024;
const WS_MAX_CONN_PER_IP = 40;
const WS_MSG_WINDOW_MS = 10000;
// A full table behind one address, and the scripted suite, both send
// bursts. 200 a second still stops a flood and does not cut off a match.
const WS_MSG_MAX = 2000;
const AUTH_IP_WINDOW_MS = 60 * 60 * 1000;
const AUTH_IP_MAX = 30;
const connCount = new Map();
const msgTimes = new Map();
const authTimes = new Map();
function clientIp(req) {
  const sock = req && (req.socket || req.connection);
  let ip = (sock && sock.remoteAddress) || 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}
function noteWindow(map, ip, windowMs, max) {
  const now = Date.now();
  const prev = (map.get(ip) || []).filter((t) => now - t < windowMs);
  if (prev.length >= max) { map.set(ip, prev); return false; }
  prev.push(now);
  if (prev.length) map.set(ip, prev); else map.delete(ip);
  return true;
}
function allowAuthIp(ip) { return noteWindow(authTimes, ip, AUTH_IP_WINDOW_MS, AUTH_IP_MAX); }
function allowWsMessage(ip) { return noteWindow(msgTimes, ip, WS_MSG_WINDOW_MS, WS_MSG_MAX); }

const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: WS_MAX_PAYLOAD });
socketCount = () => wss.clients.size;
wss.on('connection', (ws, req) => {
  // An oversized frame is an 'error' on this socket. Without a listener
  // the whole process dies, which is the opposite of a payload cap.
  ws.on('error', () => {});
  const ip = clientIp(req);
  const open = (connCount.get(ip) || 0) + 1;
  if (open > WS_MAX_CONN_PER_IP) {
    try { ws.close(1008, 'too many connections'); } catch (e) { /* already gone */ }
    return;
  }
  connCount.set(ip, open);
  ws.on('close', () => {
    const left = (connCount.get(ip) || 1) - 1;
    if (left <= 0) connCount.delete(ip); else connCount.set(ip, left);
  });
  const origOn = ws.on.bind(ws);
  ws.on = function (ev, fn) {
    if (ev !== 'message') return origOn(ev, fn);
    return origOn('message', function (raw) {
      if (!allowWsMessage(ip)) {
        try { ws.close(1008, 'slow down'); } catch (e) { /* already gone */ }
        return;
      }
      return fn.apply(this, arguments);
    });
  };
  host.handleConnection(ws);
});

setInterval(() => { host.tick(); }, 500);

if (!TEST) {
  setInterval(() => { retention.sweepDrops().catch(() => {}); }, 15 * 60 * 1000);
  setTimeout(() => { retention.sweepDrops().catch(() => {}); }, 20000);
}
// Boot: hydrate any money store whose local file is gone from its
// durable copy, settle what the last process left behind, then listen.
(async () => {
  if (durable.enabled) {
    const [p1, p2, p3] = await Promise.all([durable.load('payments'), durable.load('prizes'), durable.load('payouts')]);
    const got = [payments.hydrate(p1) && 'payments', prizeLedger.hydrate(p2) && 'prize ledger', payouts.hydrate(p3) && 'payouts'].filter(Boolean);
    if (got.length) console.log('Restored from the durable copy: ' + got.join(', ') + '.');
  }
  try { bootReconcile(); } catch (e) { console.log('Boot reconcile skipped: ' + (e && e.message)); }
  try { loadRooms(); } catch (e) { console.log('Room restore skipped: ' + (e && e.message)); }
  startSweeps();
  server.listen(PORT, () => {
    console.log('Kolopoly listening on port ' + PORT);
  });
})();
// Flush money and the live tables on the way down. The room file is
// synchronous so a deploy cannot exit before the snapshot lands.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { flushRoomsSync(); } catch (e) { /* the log already said why */ }
    durable.flush().catch(() => {}).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
