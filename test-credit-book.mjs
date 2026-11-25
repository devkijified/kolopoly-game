// One play-credit book. A desk grant, a paid-seat spend, and a no-show
// refund all write the same file, and a grant that was already on disk
// is still there after boot and after those writes.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';

const TOKEN = 'kp-credit-book-sentinel';
const PROD_ID = 'a_b4a538773fa892c22875';
const PROD_GRANT = 'credit:RFFU:' + PROD_ID;
const HAND_GRANT = 'credit:hand:' + PROD_ID;
let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBook(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function spawnServer(port, dir) {
  const env = {
    ...process.env,
    PORT: String(port),
    KP_TEST: '1',
    KP_DATA_DIR: dir,
    KP_AUTH_SECRET: 'credit-book',
    KP_ADMIN_TOKEN: TOKEN,
    KP_PERSIST_ROOMS: '',
    RESEND_API_KEY: '',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: ''
  };
  delete env.KP_PLAY_CREDIT_FILE;
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('.', import.meta.url).pathname,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('boot\n' + logs)), 8000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('Kolopoly listening')) { clearTimeout(timer); resolve(); }
    });
  });
  return { child, ready, logs: () => logs };
}
async function request(base, method, urlPath, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  let body;
  if (opts.json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(base + urlPath, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, text, json, setCookie };
}
function cookieValue(res) {
  const line = (res.setCookie || []).find((item) => item.startsWith('kp_ops=')) || '';
  return line ? line.split(';')[0].slice('kp_ops='.length) : '';
}
async function signIn(base, email) {
  const asked = await request(base, 'POST', '/api/auth/request', { json: { email } });
  const code = asked.json && asked.json.devCode;
  const verified = await request(base, 'POST', '/api/auth/verify', { json: { email, code } });
  return verified.json || {};
}
function socket(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  const box = { ws, state: null, joined: null, error: null };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'state') box.state = msg.room;
    if (msg.type === 'joined') box.joined = msg;
    if (msg.type === 'error') box.error = msg;
  });
  return new Promise((resolve) => ws.on('open', () => resolve(box)));
}
function send(box, type, payload) { box.ws.send(JSON.stringify(Object.assign({ type }, payload || {}))); }
async function waitFor(box, pred, label) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (box.state && pred(box.state)) return;
    await sleep(40);
  }
  throw new Error(label + ' ' + JSON.stringify(box.error || (box.state && box.state.message)));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolopoly-credit-'));
const file = path.join(dir, 'play-credits.json');
const seeded = {
  accounts: {
    [PROD_ID]: {
      balanceKobo: 20000,
      entries: [{ id: PROD_GRANT, kobo: 20000, reason: 'unfair AFK takeover before pause rule', roomCode: 'RFFU', at: 1730000000000, by: 'owner' }]
    }
  }
};
fs.writeFileSync(file, JSON.stringify(seeded));
const before = fs.readFileSync(file, 'utf8');

const port = 4544;
const server = spawnServer(port, dir);
await server.ready;
const base = 'http://127.0.0.1:' + port;
try {
  await sleep(300);
  check('boot loads the credit file and does not rewrite it', fs.readFileSync(file, 'utf8') === before);

  const hand = JSON.parse(before);
  hand.accounts[PROD_ID].balanceKobo = 25000;
  hand.accounts[PROD_ID].entries.push({ id: HAND_GRANT, kobo: 5000, reason: 'hand edit while the server is up', roomCode: 'RFFU', at: 1730000001000, by: 'owner' });
  fs.writeFileSync(file, JSON.stringify(hand));
  const ahead = new Date(Date.now() + 5000);
  fs.utimesSync(file, ahead, ahead);

  const opened = await request(base, 'POST', '/ops/unlock', { json: { token: TOKEN } });
  const session = cookieValue(opened);
  check('ops unlocks', opened.status === 200 && !!session);
  const hostAuth = await signIn(base, 'host-credit@example.com');
  const guestAuth = await signIn(base, 'guest-credit@example.com');
  check('sign-in returns both accounts', !!(hostAuth.token && guestAuth.accountId));

  const granted = await request(base, 'POST', '/ops/live/act', {
    headers: { Cookie: 'kp_ops=' + session },
    json: { action: 'grant_credit', confirm: true, id: 'credit:desk:' + hostAuth.accountId, accountId: hostAuth.accountId, kobo: 20000, reason: 'desk', roomCode: 'TEST' }
  });
  check('grant_credit through /ops/live/act succeeds', granted.status === 200 && granted.json && granted.json.ok && granted.json.balanceKobo === 20000, JSON.stringify(granted.json));
  const guestGrant = await request(base, 'POST', '/ops/live/act', {
    headers: { Cookie: 'kp_ops=' + session },
    json: { action: 'grant_credit', confirm: true, id: 'credit:desk:' + guestAuth.accountId, accountId: guestAuth.accountId, kobo: 20000, reason: 'desk', roomCode: 'TEST' }
  });
  check('a second desk grant uses the same book', guestGrant.status === 200 && guestGrant.json && guestGrant.json.ok);

  let book = readBook(file);
  check('the prod grant is still in the file after a desk grant', book.accounts[PROD_ID] && book.accounts[PROD_ID].entries.some((e) => e.id === PROD_GRANT) && book.accounts[PROD_ID].balanceKobo === 25000, JSON.stringify(book.accounts[PROD_ID]));
  check('a hand edit made while the server was up was folded in', book.accounts[PROD_ID].entries.some((e) => e.id === HAND_GRANT));

  const host = await socket(port);
  send(host, 'create_room', { name: 'Kiji', token: 'big-man', mode: 'online', cityId: 'lagos', authToken: hostAuth.token, clientId: 'credit-host-1111', settings: { gameMode: 'classic' } });
  await waitFor(host, (s) => s.paid && s.paid.fee === 200, 'paid lobby');
  const code = host.state.code;
  const spent = await request(base, 'POST', '/api/payments/initialize', {
    headers: { Authorization: 'Bearer ' + hostAuth.token },
    json: { roomCode: code }
  });
  check('paid join spends the desk grant from the same book', spent.status === 200 && spent.json && spent.json.credited === true && spent.json.balanceKobo === 0, JSON.stringify(spent.json));

  const guest = await socket(port);
  send(guest, 'join_room', { code, name: 'Ada', token: 'gele', authToken: guestAuth.token, clientId: 'credit-guest-2222' });
  await waitFor(guest, (s) => s.players.length === 2, 'guest seated');
  const guestSpent = await request(base, 'POST', '/api/payments/initialize', {
    headers: { Authorization: 'Bearer ' + guestAuth.token },
    json: { roomCode: code }
  });
  check('the second seat spends the same book', guestSpent.status === 200 && guestSpent.json && guestSpent.json.credited === true, JSON.stringify(guestSpent.json));
  await waitFor(host, (s) => s.players.every((p) => p.paidSeat), 'both paid');
  send(host, 'start_game', {});
  await waitFor(host, (s) => s.status === 'playing', 'started');
  const hostId = host.joined.playerId;
  host.ws.close();
  await waitFor(guest, (s) => s.paused && s.linkWait && s.linkWait.playerId === hostId, 'paused');
  send(guest, 'test_expire_link', { playerId: hostId });
  await sleep(1200);
  book = readBook(file);
  const hostRow = book.accounts[hostAuth.accountId];
  const dropId = 'drop:' + code + ':' + hostAuth.accountId;
  check('the no-show refund lands in the same book', hostRow && hostRow.entries.some((e) => e.id === dropId) && hostRow.balanceKobo === 20000, JSON.stringify(hostRow && { balance: hostRow.balanceKobo, ids: hostRow.entries.map((e) => e.id) }));
  check('the prod grant survives the spend and the refund', book.accounts[PROD_ID].balanceKobo === 25000 && book.accounts[PROD_ID].entries.some((e) => e.id === PROD_GRANT) && book.accounts[PROD_ID].entries.some((e) => e.id === HAND_GRANT));
  guest.ws.close();
} catch (e) {
  console.error(e);
  console.error(server.logs());
  failures += 1;
} finally {
  server.child.kill();
}

const again = spawnServer(port, dir);
await again.ready;
try {
  const opened = await request(base, 'POST', '/ops/unlock', { json: { token: TOKEN } });
  const session = cookieValue(opened);
  const hostAuth = await signIn(base, 'host-credit@example.com');
  const replay = await request(base, 'POST', '/ops/live/act', {
    headers: { Cookie: 'kp_ops=' + session },
    json: { action: 'grant_credit', confirm: true, id: 'credit:desk:' + hostAuth.accountId, accountId: hostAuth.accountId, kobo: 20000, reason: 'again', roomCode: 'TEST' }
  });
  const book = readBook(file);
  check('a restart loads the same file and does not grant the desk id twice', replay.json && replay.json.already === true && book.accounts[PROD_ID].balanceKobo === 25000, JSON.stringify(replay.json));
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  again.child.kill();
}

console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
