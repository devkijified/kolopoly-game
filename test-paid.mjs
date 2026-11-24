// KOLOPOLY paid tables tests (phase 1). Spawns the server with KP_TEST=1
// and plays the paid flow over WebSocket: the Lagos ₦200 table is the
// only open rung, the winner share is 90 percent at every table size,
// seats pay through the test provider, and the prize ledger remembers
// prizes, house shares and refunds. Run: node test-paid.mjs
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { defaultSettings, validateCompetition, competitionTable } = require('./competition.js');

const PORT = 4231;
const BASE = 'ws://127.0.0.1:' + PORT;
const HTTP = 'http://127.0.0.1:' + PORT;
const TOKEN = 'paid-test-token';
const FILES = {
  retention: '/tmp/kolopoly-retention-' + PORT + '.json',
  competition: '/tmp/kolopoly-competition-' + PORT + '.json',
  prizes: '/tmp/kolopoly-prizes-' + PORT + '.json'
};
for (const f of Object.values(FILES)) { try { fs.unlinkSync(f); } catch (e) { /* first run */ } }

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The ladder itself: 90 percent winner share, Lagos ₦200 the open rung.
// ---------------------------------------------------------------------------
console.log('P0: the ladder');
{
  const s = defaultSettings();
  check('default winner share is 90 at every table size', [2, 3, 4, 5, 6].every((n) => s.splits[n] === 90), JSON.stringify(s.splits));
  const table = competitionTable(s);
  const lagos = table.find((r) => r.id === 'lagos');
  check('Lagos is on the ladder', !!lagos);
  check('Lagos is the open rung at ₦200', lagos.open === true && lagos.fee === 200, JSON.stringify({ open: lagos.open, fee: lagos.fee }));
  check('every other rung is closed', table.filter((r) => r.id !== 'lagos').every((r) => r.open === false));
  const want = { 2: [400, 360, 40], 3: [600, 540, 60], 4: [800, 720, 80], 5: [1000, 900, 100], 6: [1200, 1080, 120] };
  for (const size of lagos.sizes) {
    const w = want[size.players];
    check('Lagos ' + size.players + ' players: pot ' + w[0] + ', winner ' + w[1] + ', house ' + w[2],
      size.pot === w[0] && size.winner === w[1] && size.house === w[2], JSON.stringify(size));
    check('Lagos ' + size.players + ' players: winner + house = pot', size.winner + size.house === size.pot);
  }
  const round = validateCompetition(JSON.parse(JSON.stringify(s)));
  check('validation keeps the open flags', round.ok && round.settings.cities.find((c) => c.id === 'lagos').open === true && round.settings.cities.filter((c) => c.open).length === 1);
}

// ---------------------------------------------------------------------------
// Server flow.
// ---------------------------------------------------------------------------
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: {
    ...process.env, PORT: String(PORT), KP_TEST: '1', KP_ADMIN_TOKEN: TOKEN,
    KP_RETENTION_FILE: FILES.retention, KP_COMPETITION_FILE: FILES.competition, KP_PRIZES_FILE: FILES.prizes
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));

class Client {
  constructor(name, base) { this.name = name; this.base = base || BASE; this.state = null; this.playerId = null; this.errors = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.base);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'joined') { this.playerId = msg.playerId; this.code = msg.code; }
        if (msg.type === 'state') this.state = msg.room;
        if (msg.type === 'error') this.errors.push(msg.message);
      });
    });
  }
  send(type, obj) { this.ws.send(JSON.stringify(Object.assign({ type }, obj || {}))); }
  async waitFor(pred, label, ms) {
    const end = Date.now() + (ms || 9000);
    while (Date.now() < end) {
      if (this.state && pred(this.state)) return this.state;
      await sleep(60);
    }
    throw new Error('timeout waiting for: ' + label + ' (client ' + this.name + ')');
  }
  async waitError(substr, label, ms) {
    const end = Date.now() + (ms || 6000);
    while (Date.now() < end) {
      if (this.errors.some((e) => e.includes(substr))) return true;
      await sleep(60);
    }
    throw new Error('timeout waiting for error "' + substr + '": ' + label + ' (got: ' + this.errors.join(' | ') + ')');
  }
  close() { try { this.ws.close(); } catch (e) { /* gone */ } }
}

async function prizes() {
  const res = await fetch(HTTP + '/ops/prizes', { headers: { Authorization: 'Bearer ' + TOKEN } });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// Server B: the real money shape. Paystack keys exist (a fixture secret
// that belongs to this suite, not to any account), the API base points
// at a stub Paystack below, and the provider runs in redirect mode.
// Webhooks are signed with the fixture secret exactly as Paystack signs.
// ---------------------------------------------------------------------------
import http from 'http';
import crypto from 'crypto';
const PORT2 = 4232;
const BASE2 = 'ws://127.0.0.1:' + PORT2;
const HTTP2 = 'http://127.0.0.1:' + PORT2;
const STUB_PORT = 4240;
const STUB_SECRET = 'sk_test_paid_suite_fixture';
const FILES2 = {
  retention: '/tmp/kolopoly-retention-' + PORT2 + '.json',
  competition: '/tmp/kolopoly-competition-' + PORT2 + '.json',
  prizes: '/tmp/kolopoly-prizes-' + PORT2 + '.json',
  payments: '/tmp/kolopoly-payments-' + PORT2 + '.json'
};
for (const f of Object.values(FILES2)) { try { fs.unlinkSync(f); } catch (e) { /* first run */ } }
const stubPaid = new Set();
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/transaction/initialize') {
      const b = JSON.parse(body || '{}');
      res.end(JSON.stringify({ status: true, data: { authorization_url: 'http://127.0.0.1:' + STUB_PORT + '/pay/' + b.reference, access_code: 'stub', reference: b.reference } }));
      return;
    }
    const m = /^\/transaction\/verify\/(.+)$/.exec(req.url || '');
    if (req.method === 'GET' && m) {
      const ref = decodeURIComponent(m[1]);
      res.end(JSON.stringify({ status: true, data: { status: stubPaid.has(ref) ? 'success' : 'pending', amount: 20000, reference: ref } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
const server2 = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: {
    ...process.env, PORT: String(PORT2), KP_TEST: '1', KP_ADMIN_TOKEN: TOKEN, KP_PAYMENTS: 'paystack',
    PAYSTACK_SECRET_KEY: STUB_SECRET, PAYSTACK_API_BASE: 'http://127.0.0.1:' + STUB_PORT,
    KP_AUTH_SECRET: 'paid-suite-auth-secret', KP_SWEEP_INTERVAL_MS: '400', KP_SWEEP_AGE_MS: '800',
    KP_RETENTION_FILE: FILES2.retention, KP_COMPETITION_FILE: FILES2.competition,
    KP_PRIZES_FILE: FILES2.prizes, KP_PAYMENTS_FILE: FILES2.payments
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let server2Log = '';
server2.stdout.on('data', (d) => { server2Log += d; });
server2.stderr.on('data', (d) => { server2Log += d; });
await new Promise((res) => server2.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));

async function requestCode(email) {
  const res = await fetch(HTTP2 + '/api/auth/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  return { status: res.status, body: await res.json() };
}
async function verifyCode(email, code) {
  const res = await fetch(HTTP2 + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code }) });
  return { status: res.status, body: await res.json() };
}
async function signIn(email) {
  const r = await requestCode(email);
  const v = await verifyCode(email, r.body.devCode);
  return v.body;
}
async function prizes2() {
  const res = await fetch(HTTP2 + '/ops/prizes', { headers: { Authorization: 'Bearer ' + TOKEN } });
  return { status: res.status, body: await res.json() };
}
async function initializePayment(token, roomCode) {
  const res = await fetch(HTTP2 + '/api/payments/initialize', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ roomCode }) });
  return { status: res.status, body: await res.json() };
}
async function paymentStatus(reference) {
  const res = await fetch(HTTP2 + '/api/payments/status?reference=' + encodeURIComponent(reference));
  return { status: res.status, body: await res.json() };
}
async function sendWebhook(reference, opts) {
  const payload = JSON.stringify({ event: 'charge.success', data: { reference, status: 'success', amount: 20000 } });
  const headers = { 'Content-Type': 'application/json' };
  if (!opts || !opts.noSig) headers['x-paystack-signature'] = crypto.createHmac('sha512', (opts && opts.secret) || STUB_SECRET).update(payload).digest('hex');
  const res = await fetch(HTTP2 + '/api/paystack/webhook', { method: 'POST', headers, body: payload });
  return res.status;
}

try {
  console.log('P1: a closed city and an unknown city are refused');
  {
    const c = new Client('Closed');
    await c.connect();
    c.send('create_room', { name: 'Closed', token: 'danfo', mode: 'online', cityId: 'ibadan', settings: { gameMode: 'classic' } });
    await c.waitError('never open yet', 'closed city refusal');
    check('paid room for a closed city is refused', true);
    check('the refused client never entered a room', c.state === null && c.playerId == null);
    const c2 = new Client('Unknown');
    await c2.connect();
    c2.send('create_room', { name: 'Unknown', token: 'danfo', mode: 'online', cityId: 'atlantis', settings: { gameMode: 'classic' } });
    await c2.waitError('no dey the ladder', 'unknown city refusal');
    check('paid room for an unknown city is refused', true);
    c.close(); c2.close();
  }

  console.log('P2: the Lagos ₦200 table, two players, end to end');
  {
    const host = new Client('Ada');
    await host.connect();
    host.send('create_room', { name: 'Ada', token: 'danfo', mode: 'online', cityId: 'lagos', settings: { gameMode: 'classic' } });
    await host.waitFor((s) => s.status === 'lobby' && s.players.length === 1, 'paid lobby');
    check('the room is a paid Lagos room', !!host.state.paid && host.state.paid.cityId === 'lagos' && host.state.paid.city === 'Lagos');
    check('the fee is ₦200 and test mode is marked', host.state.paid.fee === 200 && host.state.paid.testMode === true, JSON.stringify(host.state.paid));
    check('the host seat starts unpaid', host.state.players[0].paidSeat === false && host.state.paid.allPaid === false);
    const code = host.state.code;

    const guest = new Client('Bola');
    await guest.connect();
    guest.send('join_room', { code, name: 'Bola', token: 'keke' });
    await guest.waitFor((s) => s.status === 'lobby' && s.players.length === 2, 'guest joined paid room');
    check('the guest seat starts unpaid too', guest.state.players.find((p) => p.id === guest.playerId).paidSeat === false);

    host.send('add_bot', {});
    await host.waitError('Bots no dey sit for paid table', 'bot refusal');
    check('bots are refused at a paid table', host.state.players.length === 2);

    host.send('start_game', {});
    await host.waitError('never pay', 'start blocked with nobody paid');
    check('start is refused while seats are unpaid', host.state.status === 'lobby');

    host.send('pay_seat', {});
    await host.waitFor((s) => s.players.find((p) => p.id === host.playerId).paidSeat === true, 'host seat paid');
    check('the test provider pays the host seat', true);

    host.send('start_game', {});
    await host.waitError('never pay', 'start blocked with one unpaid seat');
    check('start is still refused while the guest is unpaid', host.state.status === 'lobby');

    guest.send('pay_seat', {});
    await guest.waitFor((s) => s.paid && s.paid.allPaid === true, 'all seats paid');
    check('once every seat has paid, the table reads all paid', true);

    host.send('start_game', {});
    await host.waitFor((s) => s.status === 'playing', 'paid game started');
    check('the paid game starts once every seat has paid', true);

    host.send('end_room', {});
    await host.waitError('no fit end early', 'paid early end refused');
    host.send('test_clock', { secondsLeft: 0 });
    await host.waitFor((s) => s.status === 'ended' && !!s.prize, 'paid game settled');
    const prize = host.state.prize;
    check('the prize is priced on 2 seats: pot ₦400, winner ₦360, house ₦40',
      prize.pot === 400 && prize.winner === 360 && prize.house === 40 && prize.players === 2, JSON.stringify(prize));

    const led = await prizes();
    check('the ops prize route answers behind auth', led.status === 200 && led.body.ok === true);
    const prizeEntry = led.body.entries.find((e) => e.kind === 'prize' && e.roomCode === code);
    const houseEntry = led.body.entries.find((e) => e.kind === 'house' && e.roomCode === code);
    check('the ledger holds the winner prize of ₦360', !!prizeEntry && prizeEntry.amount === 360 && prizeEntry.playerId === prize.winnerId && prizeEntry.cityId === 'lagos' && prizeEntry.testMode === true, JSON.stringify(prizeEntry));
    check('the ledger holds the house share of ₦40', !!houseEntry && houseEntry.amount === 40, JSON.stringify(houseEntry));
    host.close(); guest.close();
  }

  console.log('P3: an abandoned paid room writes refund-due entries');
  {
    const host = new Client('Chidi');
    await host.connect();
    host.send('create_room', { name: 'Chidi', token: 'danfo', mode: 'online', cityId: 'lagos', settings: { gameMode: 'classic' } });
    await host.waitFor((s) => s.status === 'lobby', 'refund lobby');
    const code = host.state.code;
    const guest = new Client('Dara');
    await guest.connect();
    guest.send('join_room', { code, name: 'Dara', token: 'keke' });
    await guest.waitFor((s) => s.players.length === 2, 'refund guest joined');
    host.send('pay_seat', {});
    guest.send('pay_seat', {});
    await host.waitFor((s) => s.paid && s.paid.allPaid === true, 'refund seats paid');
    host.send('leave', {});
    await sleep(300);
    guest.send('leave', {});
    await sleep(600);
    const led = await prizes();
    const refunds = led.body.entries.filter((e) => e.kind === 'refund-due' && e.roomCode === code);
    check('two refund-due entries of ₦200 each', refunds.length === 2 && refunds.every((e) => e.amount === 200), JSON.stringify(refunds));
    check('no prize was written for the abandoned room', !led.body.entries.some((e) => e.kind === 'prize' && e.roomCode === code));
    host.close(); guest.close();
  }

  console.log('P4: a four player Lagos table prices on four seats');
  {
    const names = ['Efe', 'Funmi', 'Gbenga', 'Halima'];
    const clients = [];
    const host = new Client(names[0]);
    await host.connect();
    host.send('create_room', { name: names[0], token: 'danfo', mode: 'online', cityId: 'lagos', settings: { gameMode: 'classic' } });
    await host.waitFor((s) => s.status === 'lobby', 'four player lobby');
    const code = host.state.code;
    clients.push(host);
    for (let k = 1; k < names.length; k++) {
      const c = new Client(names[k]);
      await c.connect();
      c.send('join_room', { code, name: names[k], token: ['keke', 'okada', 'generator'][k - 1] });
      clients.push(c);
    }
    await host.waitFor((s) => s.players.length === 4, 'four seated');
    for (const c of clients) c.send('pay_seat', {});
    await host.waitFor((s) => s.paid && s.paid.allPaid === true, 'four seats paid');
    host.send('start_game', {});
    await host.waitFor((s) => s.status === 'playing', 'four player game started');
    host.send('end_room', {});
    await host.waitError('no fit end early', 'paid early end refused');
    host.send('test_clock', { secondsLeft: 0 });
    await host.waitFor((s) => s.status === 'ended' && !!s.prize, 'four player game settled');
    const prize = host.state.prize;
    check('four seats: pot ₦800, winner ₦720, house ₦80', prize.pot === 800 && prize.winner === 720 && prize.house === 80 && prize.players === 4, JSON.stringify(prize));
    const led = await prizes();
    const prizeEntry = led.body.entries.find((e) => e.kind === 'prize' && e.roomCode === code);
    check('the ledger prize matches the room prize', !!prizeEntry && prizeEntry.amount === 720 && prizeEntry.playerId === prize.winnerId, JSON.stringify(prizeEntry));
    for (const c of clients) c.close();
  }

  console.log('P5: free rooms behave exactly as before');
  {
    const host = new Client('Ife');
    await host.connect();
    host.send('create_room', { name: 'Ife', token: 'danfo', mode: 'online', settings: { gameMode: 'classic' } });
    await host.waitFor((s) => s.status === 'lobby', 'free lobby');
    check('a free room carries no paid block', host.state.paid === null);
    host.send('add_bot', {});
    await host.waitFor((s) => s.players.length === 2 && s.players.some((p) => p.bot), 'bot seated in free room');
    check('bots still join free rooms', true);
    host.send('start_game', {});
    await host.waitFor((s) => s.status === 'playing', 'free game started with no payment');
    check('a free game starts with no payment at all', true);
    host.close();
  }

  console.log('P6: the public ladder route and the locked desk');
  {
    const res = await fetch(HTTP + '/api/competition');
    const body = await res.json();
    const lagos = (body.table || []).find((r) => r.id === 'lagos');
    check('GET /api/competition serves the ladder', res.status === 200 && body.ok === true && !!lagos);
    check('the served ladder marks Lagos open at ₦200 and the rest closed',
      !!lagos && lagos.open === true && lagos.fee === 200 && body.table.filter((r) => r.id !== 'lagos').every((r) => r.open === false));
    const locked = await fetch(HTTP + '/ops/prizes');
    check('GET /ops/prizes refuses without the ops key', locked.status === 401, 'status ' + locked.status);
  }

  console.log('P7: email sign-in on the Paystack host');
  let acctA; let acctB;
  {
    const bad = await requestCode('not-an-email');
    check('a bad email is refused', bad.status === 400, 'status ' + bad.status);
    const rA = await requestCode('ada@example.com');
    check('the code request answers on the test mailer', rA.status === 200 && rA.body.ok === true && /^\d{6}$/.test(rA.body.devCode || ''), JSON.stringify(rA.body));
    const wrong = await verifyCode('ada@example.com', rA.body.devCode === '000000' ? '111111' : '000000');
    check('a wrong code is refused', wrong.status === 400 && wrong.body.ok === false, 'status ' + wrong.status);
    const again = await requestCode('ada@example.com');
    check('asking again too fast is rate limited', again.status === 429, 'status ' + again.status);
    const vA = await verifyCode('ada@example.com', rA.body.devCode);
    check('the right code issues a session token', vA.status === 200 && !!vA.body.token && vA.body.email === 'ada@example.com', JSON.stringify(vA.body));
    acctA = vA.body;
    const meRes = await fetch(HTTP2 + '/api/auth/me', { headers: { Authorization: 'Bearer ' + acctA.token } });
    const meBody = await meRes.json();
    check('the token reads back the account', meRes.status === 200 && meBody.accountId === acctA.accountId && meBody.email === 'ada@example.com');
    const noTok = await fetch(HTTP2 + '/api/auth/me');
    check('no token, no account', noTok.status === 401, 'status ' + noTok.status);
    acctB = await signIn('bola@example.com');
    check('a second player signs in with their own email', !!acctB.token && acctB.accountId !== acctA.accountId);
  }

  console.log('P8: paid create, join and pay all require the account');
  let payHost; let payGuest; let payCode;
  {
    const anon = new Client('Anon', BASE2);
    await anon.connect();
    anon.send('create_room', { name: 'Anon', token: 'danfo', mode: 'online', cityId: 'lagos', settings: { gameMode: 'classic' } });
    await anon.waitError('Sign in with your email first', 'anonymous paid create refusal');
    check('paid room creation without a token is refused', anon.state === null);
    anon.close();

    payHost = new Client('Ada', BASE2);
    await payHost.connect();
    payHost.send('create_room', { name: 'Ada', token: 'danfo', mode: 'online', cityId: 'lagos', authToken: acctA.token, settings: { gameMode: 'classic' } });
    await payHost.waitFor((s) => s.status === 'lobby' && s.players.length === 1, 'paystack paid lobby');
    payCode = payHost.state.code;
    check('a signed-in player creates the Lagos room', payHost.state.paid.cityId === 'lagos' && payHost.state.paid.mode === 'redirect', JSON.stringify(payHost.state.paid));

    const anonJoin = new Client('AnonJoin', BASE2);
    await anonJoin.connect();
    anonJoin.send('join_room', { code: payCode, name: 'AnonJoin', token: 'keke' });
    await anonJoin.waitError('Sign in with your email first', 'anonymous paid join refusal');
    check('joining a paid room without a token is refused', anonJoin.state === null || anonJoin.state.players.length === 1);
    anonJoin.close();

    payGuest = new Client('Bola', BASE2);
    await payGuest.connect();
    payGuest.send('join_room', { code: payCode, name: 'Bola', token: 'keke', authToken: acctB.token });
    await payGuest.waitFor((s) => s.status === 'lobby' && s.players.length === 2, 'signed-in guest joined');
    check('a signed-in player joins the paid room', true);

    payHost.send('pay_seat', {});
    await payHost.waitError('Paystack page', 'socket pay refused in redirect mode');
    check('a seat never pays through the socket when Paystack is live', payHost.state.players.find((p) => p.id === payHost.playerId).paidSeat === false);
  }

  console.log('P9: webhook, verify and the prize identity');
  {
    const initA = await initializePayment(acctA.token, payCode);
    check('initialize opens a Paystack transaction for the seat', initA.status === 200 && !!initA.body.authorizationUrl && String(initA.body.reference || '').startsWith('kp'), JSON.stringify(initA.body));
    const refA = initA.body.reference;
    const early = await paymentStatus(refA);
    check('before Paystack confirms, the payment reads pending', early.body.status === 'pending', JSON.stringify(early.body));
    check('the seat is still unpaid before confirmation', payHost.state.players.find((p) => p.id === payHost.playerId).paidSeat === false);

    const badSig = await sendWebhook(refA, { secret: 'sk_test_wrong_fixture' });
    check('a wrongly signed webhook is rejected', badSig === 401, 'status ' + badSig);
    const noSig = await sendWebhook(refA, { noSig: true });
    check('an unsigned webhook is rejected', noSig === 401, 'status ' + noSig);
    check('the rejected webhooks settled nothing', payHost.state.players.find((p) => p.id === payHost.playerId).paidSeat === false);

    const good = await sendWebhook(refA);
    check('a correctly signed charge.success is accepted', good === 200, 'status ' + good);
    await payHost.waitFor((s) => s.players.find((p) => p.id === payHost.playerId).paidSeat === true, 'seat settled by webhook');
    check('the webhook settles the seat', true);
    const dup = await sendWebhook(refA);
    check('the same webhook delivered twice is still accepted', dup === 200, 'status ' + dup);
    await sleep(200);
    const stored = JSON.parse(fs.readFileSync(FILES2.payments, 'utf8'));
    const recA = stored.find((r) => r.reference === refA);
    check('the duplicate settled exactly once', !!recA && recA.status === 'paid' && recA.events.filter((e) => e.kind === 'settled').length === 1, JSON.stringify(recA && recA.events));
    check('the payment record carries the account', !!recA && recA.accountId === acctA.accountId && recA.email === 'ada@example.com' && recA.amountKobo === 20000, JSON.stringify(recA));

    const initB = await initializePayment(acctB.token, payCode);
    const refB = initB.body.reference;
    check('the second seat initializes its own payment', initB.status === 200 && !!refB && refB !== refA, JSON.stringify(initB.body));
    stubPaid.add(refB);
    const settledB = await paymentStatus(refB);
    check('verify on return settles when the webhook never arrives', settledB.body.status === 'paid', JSON.stringify(settledB.body));
    await payGuest.waitFor((s) => s.players.find((p) => p.id === payGuest.playerId).paidSeat === true, 'seat settled by verify');
    check('the verify route settles the second seat', true);

    await payHost.waitFor((s) => s.paid && s.paid.allPaid === true, 'paystack table all paid');
    payHost.send('start_game', {});
    await payHost.waitFor((s) => s.status === 'playing', 'paystack game started');
    payHost.send('end_room', {});
    await payHost.waitError('no fit end early', 'paid early end refused');
    payHost.send('test_clock', { secondsLeft: 0 });
    await payHost.waitFor((s) => s.status === 'ended' && !!s.prize, 'paystack game settled');
    check('the Paystack game prices the same: pot ₦400, winner ₦360, house ₦40',
      payHost.state.prize.pot === 400 && payHost.state.prize.winner === 360 && payHost.state.prize.house === 40, JSON.stringify(payHost.state.prize));
    const led = await prizes2();
    const prizeEntry = led.body.entries.find((e) => e.kind === 'prize' && e.roomCode === payCode);
    const houseEntry = led.body.entries.find((e) => e.kind === 'house' && e.roomCode === payCode);
    const winnerIsA = prizeEntry && prizeEntry.playerId === payHost.playerId;
    check('the ledger prize carries the winner account email', !!prizeEntry && prizeEntry.email === (winnerIsA ? 'ada@example.com' : 'bola@example.com') && prizeEntry.accountId === (winnerIsA ? acctA.accountId : acctB.accountId), JSON.stringify(prizeEntry));
    check('the ledger house entry stands beside it at ₦40', !!houseEntry && houseEntry.amount === 40 && houseEntry.cityId === 'lagos', JSON.stringify(houseEntry));
    payHost.close(); payGuest.close();
  }

  console.log('P10: the reconcile sweep settles a stranded payment');
  {
    const host = new Client('Ada', BASE2);
    await host.connect();
    host.send('create_room', { name: 'Ada', token: 'danfo', mode: 'online', cityId: 'lagos', authToken: acctA.token, settings: { gameMode: 'classic' } });
    await host.waitFor((s) => s.status === 'lobby', 'sweep lobby');
    const code = host.state.code;
    const guest = new Client('Bola', BASE2);
    await guest.connect();
    guest.send('join_room', { code, name: 'Bola', token: 'keke', authToken: acctB.token });
    await guest.waitFor((s) => s.players.length === 2, 'sweep guest joined');
    const init = await initializePayment(acctB.token, code);
    stubPaid.add(init.body.reference);
    // No webhook, no status poll: only the sweep can land this one.
    await guest.waitFor((s) => s.players.find((p) => p.id === guest.playerId).paidSeat === true, 'seat settled by sweep', 9000);
    check('the sweep settles a payment nobody came back for', true);
    const stored = JSON.parse(fs.readFileSync(FILES2.payments, 'utf8'));
    const rec = stored.find((r) => r.reference === init.body.reference);
    check('the sweep settle is on the record', !!rec && rec.status === 'paid' && rec.events.some((e) => e.kind === 'settled' && e.via === 'sweep'), JSON.stringify(rec && rec.events));
    host.close(); guest.close();
  }
} finally {
  server.kill();
  server2.kill();
  stub.close();
}

console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
if (failures) { console.log(serverLog.slice(-1500)); process.exit(1); }
