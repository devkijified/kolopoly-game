// KOLOPOLY full sign-in gate tests. Spawns the server in the real
// money shape (Paystack keys present as fixtures, a stub Paystack,
// redirect mode) with auth wired, and proves the owner ruling: no
// seat at any table without a verified email account, free tables,
// pass and play hosts, quick play and spectator joins included; the
// kolo shelf lives under the account and adopts a device shelf
// once, conservatively. A second server in test mode proves the
// gate stays open there. Run: node test-signin-gate.mjs
import WebSocket from 'ws';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';

const PORT = 4233;
const BASE = 'ws://127.0.0.1:' + PORT;
const HTTP = 'http://127.0.0.1:' + PORT;
const PORT_T = 4234;
const BASE_T = 'ws://127.0.0.1:' + PORT_T;
const HTTP_T = 'http://127.0.0.1:' + PORT_T;
const STUB_PORT = 4241;
const TOKEN = 'gate-test-token';
const GATE_PHRASE = 'Your games, streak, kolo shelf and prizes live under your account';
const FILES = {
  retention: '/tmp/kolopoly-retention-' + PORT + '.json',
  competition: '/tmp/kolopoly-competition-' + PORT + '.json',
  prizes: '/tmp/kolopoly-prizes-' + PORT + '.json',
  payments: '/tmp/kolopoly-payments-' + PORT + '.json'
};
const FILES_T = {
  retention: '/tmp/kolopoly-retention-' + PORT_T + '.json',
  competition: '/tmp/kolopoly-competition-' + PORT_T + '.json',
  prizes: '/tmp/kolopoly-prizes-' + PORT_T + '.json',
  payments: '/tmp/kolopoly-payments-' + PORT_T + '.json'
};
for (const f of Object.values(FILES).concat(Object.values(FILES_T))) { try { fs.unlinkSync(f); } catch (e) { /* first run */ } }

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stub Paystack, the same shape as the paid suite: the gate
// server only needs the provider to sit in redirect mode.
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
      res.end(JSON.stringify({ status: true, data: { status: 'pending', amount: 20000, reference: decodeURIComponent(m[1]) } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

function bootServer(port, files, extraEnv) {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: new URL('.', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(port), KP_TEST: '1', KP_ADMIN_TOKEN: TOKEN,
      RESEND_API_KEY: '',
      KP_RETENTION_FILE: files.retention, KP_COMPETITION_FILE: files.competition, KP_PRIZES_FILE: files.prizes,
      ...(files.payments ? { KP_PAYMENTS_FILE: files.payments } : {}),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.log = '';
  srv.stdout.on('data', (d) => { srv.log += d; });
  srv.stderr.on('data', (d) => { srv.log += d; });
  return new Promise((res) => srv.stdout.on('data', (d) => { if (String(d).includes('listening')) res(srv); }));
}
const server = await bootServer(PORT, FILES, {
  KP_PAYMENTS: 'paystack', PAYSTACK_SECRET_KEY: 'sk_test_gate_suite_fixture',
  PAYSTACK_API_BASE: 'http://127.0.0.1:' + STUB_PORT, KP_AUTH_SECRET: 'gate-suite-auth-secret'
});
const serverT = await bootServer(PORT_T, FILES_T, { KP_AUTH_SECRET: 'gate-suite-auth-secret' });

class Client {
  constructor(name, base) { this.name = name; this.base = base || BASE; this.state = null; this.playerId = null; this.errors = []; this.seatToken = null; this.rejoined = false; this.spectator = false; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.base);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'joined') { this.playerId = msg.playerId; this.code = msg.code; this.seatToken = msg.token || this.seatToken; this.rejoined = !!msg.rejoined; this.spectator = !!msg.spectator; }
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

async function signIn(httpBase, email) {
  const r = await fetch(httpBase + '/api/auth/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  const rb = await r.json();
  const v = await fetch(httpBase + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: rb.devCode }) });
  const vb = await v.json();
  if (!vb.token) throw new Error('sign-in failed for ' + email + ': ' + JSON.stringify(vb));
  return vb;
}
async function shelfView(httpBase, params) {
  const q = new URLSearchParams(params);
  const res = await fetch(httpBase + '/api/retention?' + q.toString());
  return { status: res.status, body: await res.json() };
}
async function shelfClaim(httpBase, body) {
  const res = await fetch(httpBase + '/api/retention/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

try {
  console.log('G0: the gate derivation rides the competition payload');
  {
    const res = await fetch(HTTP + '/api/competition');
    const body = await res.json();
    check('the redirect host reports signInRequired true', body.signInRequired === true && body.accountRequired === true && body.mode === 'redirect', JSON.stringify({ signInRequired: body.signInRequired, accountRequired: body.accountRequired, mode: body.mode }));
    const resT = await fetch(HTTP_T + '/api/competition');
    const bodyT = await resT.json();
    check('the test mode host reports signInRequired false', bodyT.signInRequired === false && bodyT.mode === 'test', JSON.stringify({ signInRequired: bodyT.signInRequired, mode: bodyT.mode }));
    const open = new Client('Open', BASE_T);
    await open.connect();
    open.send('create_room', { name: 'Open', token: 'danfo', mode: 'online', settings: { gameMode: 'classic' } });
    await open.waitFor((s) => s.status === 'lobby', 'test mode free lobby');
    check('test mode still seats a name-only free create', open.playerId != null);
    open.close();
  }

  console.log('G1: unsigned seats are refused at every door');
  {
    const cases = [
      ['free Classic create', (c) => c.send('create_room', { name: 'Anon', token: 'danfo', mode: 'online', settings: { gameMode: 'classic' } })],
      ['free Inflation create', (c) => c.send('create_room', { name: 'Anon', token: 'danfo', mode: 'online', settings: { gameMode: 'inflation' } })],
      ['pass and play create', (c) => c.send('create_room', { name: 'Anon', token: 'danfo', mode: 'pass', settings: { gameMode: 'classic' } })],
      ['quick join', (c) => c.send('quick_join', { name: 'Anon', token: 'danfo', gameMode: 'inflation' })]
    ];
    for (const [label, act] of cases) {
      const c = new Client(label);
      await c.connect();
      act(c);
      await c.waitError(GATE_PHRASE, label + ' refusal');
      check('unsigned ' + label + ' is refused with the gate message', c.playerId == null && c.state === null);
      c.close();
    }
    const junk = new Client('Junk');
    await junk.connect();
    junk.send('create_room', { name: 'Junk', token: 'danfo', mode: 'online', authToken: 'garbage.token.value', settings: { gameMode: 'classic' } });
    await junk.waitError(GATE_PHRASE, 'garbage token refusal');
    check('a garbage token is refused like no token', junk.playerId == null && junk.state === null);
    junk.close();
  }

  console.log('G2: sign-in, then every door opens');
  const acctA = await signIn(HTTP, 'ada@gate.example');
  const acctB = await signIn(HTTP, 'bola@gate.example');
  const acctC = await signIn(HTTP, 'caro@gate.example');
  check('three players sign in with email codes', !!acctA.token && !!acctB.token && !!acctC.token && acctA.accountId !== acctB.accountId);

  let roomCode;
  let hostSeatId;
  let guestSeatId;
  let guestSeatToken;
  {
    const host = new Client('Ada');
    await host.connect();
    host.send('create_room', { name: 'Ada', token: 'danfo', mode: 'online', clientId: 'gate-ws-a001', authToken: acctA.token, settings: { gameMode: 'classic' } });
    await host.waitFor((s) => s.status === 'lobby' && s.players.length === 1, 'signed free lobby');
    roomCode = host.state.code;
    hostSeatId = host.playerId;
    check('a signed-in player creates a free room', host.state.paid === null);
    const me = host.state.players.find((p) => p.id === hostSeatId);
    check('room state never carries an email or account field', !!me && !('email' in me) && !('accountEmail' in me) && !('accountId' in me), JSON.stringify(me));

    const anonJoin = new Client('AnonJoin');
    await anonJoin.connect();
    anonJoin.send('join_room', { code: roomCode, name: 'AnonJoin', token: 'keke' });
    await anonJoin.waitError(GATE_PHRASE, 'unsigned free join refusal');
    check('unsigned join of a free room is refused', anonJoin.playerId == null);
    anonJoin.close();

    // The same account on another device reclaims its seat: the
    // seat carries the account, so the player id survives the move.
    const host2 = new Client('AdaPhone2');
    await host2.connect();
    host2.send('join_room', { code: roomCode, name: 'Ada', token: 'danfo', clientId: 'gate-ws-a002', authToken: acctA.token });
    await host2.waitFor((s) => s.players.length === 1, 'account reclaim');
    check('the same email on a new device reclaims the seat', host2.playerId === hostSeatId && host2.rejoined === true, 'playerId ' + host2.playerId + ' vs ' + hostSeatId);
    host.close();

    const guest = new Client('Bola');
    await guest.connect();
    guest.send('join_room', { code: roomCode, name: 'Bola', token: 'keke', clientId: 'gate-ws-b001', authToken: acctB.token });
    await guest.waitFor((s) => s.players.length === 2, 'signed guest joined');
    guestSeatId = guest.playerId;
    guestSeatToken = guest.seatToken;
    check('a second signed-in player takes a fresh seat', guestSeatId !== hostSeatId);

    // Rejoin rides the seat token alone: the seat is already
    // account-bound, so no auth token is asked again.
    guest.close();
    await sleep(150);
    const guest2 = new Client('BolaBack');
    await guest2.connect();
    guest2.send('rejoin', { code: roomCode, playerId: guestSeatId, token: guestSeatToken });
    await guest2.waitFor((s) => s.players.length === 2, 'seat token rejoin');
    check('rejoin with the seat token alone works under the gate', guest2.playerId === guestSeatId && guest2.rejoined === true);
    guest.close();

    host2.send('start_game', {});
    await host2.waitFor((s) => s.status === 'playing', 'gated free game started');
    check('the gated free game starts', true);

    const anonSpec = new Client('AnonSpec');
    await anonSpec.connect();
    anonSpec.send('join_room', { code: roomCode, name: 'AnonSpec', token: 'okada' });
    await anonSpec.waitError(GATE_PHRASE, 'unsigned spectator refusal');
    check('unsigned spectator join of a running game is refused', anonSpec.playerId == null && anonSpec.spectator === false);
    anonSpec.close();

    const spec = new Client('Caro');
    await spec.connect();
    spec.send('join_room', { code: roomCode, name: 'Caro', token: 'okada', authToken: acctC.token });
    await spec.waitFor((s) => s.status === 'playing', 'signed spectator state');
    check('a signed-in player may spectate a running game', spec.spectator === true && spec.playerId == null);
    spec.close();
    guest2.close();
    host2.close();
  }

  console.log('G3: quick play and pass and play under the gate');
  {
    const q = new Client('AdaQuick');
    await q.connect();
    q.send('quick_join', { name: 'Ada', token: 'danfo', clientId: 'gate-ws-a001', authToken: acctA.token, gameMode: 'inflation' });
    await q.waitFor((s) => s.status === 'lobby' && s.isPublic === true, 'signed quick lobby');
    check('a signed-in player quick-joins a public lobby', q.playerId != null);
    q.close();

    const host = new Client('AdaPass');
    await host.connect();
    host.send('create_room', { name: 'Ada', token: 'danfo', mode: 'pass', clientId: 'gate-ws-a001', authToken: acctA.token, settings: { gameMode: 'classic' } });
    await host.waitFor((s) => s.status === 'lobby' && s.mode === 'pass', 'pass lobby');
    host.send('add_local_player', { name: 'Local Two', token: 'keke' });
    await host.waitFor((s) => s.players.length === 2, 'local player added');
    check('pass and play local players stay name-only under the host', host.state.players.length === 2);
    host.close();
  }

  console.log('G4: the shelf lives under the account');
  {
    // The account builds its own shelf first: five straight claim
    // days through its token, riding one device id.
    const daysA = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'];
    for (const day of daysA) {
      const out = await shelfClaim(HTTP, { clientId: 'gate-dev-a001', authToken: acctA.token, v: 2, day });
      if (!out.body.ok) throw new Error('account claim failed on ' + day + ': ' + JSON.stringify(out.body));
    }
    const acctView = await shelfView(HTTP, { v: '2', clientId: 'gate-dev-a001', authToken: acctA.token, day: '2026-11-20' });
    check('the account shelf holds five pieces and five total days',
      acctView.body.kolo.pieces === 5 && acctView.body.streak.totalDays === 5 && acctView.body.streak.week === 5,
      JSON.stringify({ kolo: acctView.body.kolo, streak: acctView.body.streak }));

    // A device with no account builds its own shelf: four days.
    const daysD = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'];
    for (const day of daysD) {
      const out = await shelfClaim(HTTP, { clientId: 'gate-dev-d001', v: 2, day });
      if (!out.body.ok) throw new Error('device claim failed on ' + day + ': ' + JSON.stringify(out.body));
    }
    const devView = await shelfView(HTTP, { v: '2', clientId: 'gate-dev-d001', day: '2026-11-20' });
    check('the device shelf holds four pieces and four total days',
      devView.body.kolo.pieces === 4 && devView.body.streak.totalDays === 4,
      JSON.stringify({ kolo: devView.body.kolo, streak: devView.body.streak }));
    const devCards = {};
    for (const c of devView.body.album.cards) if (c.count > 0) devCards[c.id] = c.count;
    check('the device shelf owns at least one postcard', Object.keys(devCards).length >= 1, JSON.stringify(devCards));

    // First contact between the account and that device: adoption.
    const merged = await shelfView(HTTP, { v: '2', clientId: 'gate-dev-d001', authToken: acctA.token, day: '2026-11-20' });
    check('adoption sums kolo pieces and caps them at a full kolo', merged.body.kolo.pieces === 7, JSON.stringify(merged.body.kolo));
    check('adoption takes the max streak and total days, never a sum',
      merged.body.streak.week === 5 && merged.body.streak.totalDays === 5,
      JSON.stringify(merged.body.streak));
    check('adoption caps the second-chance hand at two', merged.body.secondChance.length >= 1 && merged.body.secondChance.length <= 2, JSON.stringify(merged.body.secondChance));
    let cardsOk = true;
    for (const [id, n] of Object.entries(devCards)) {
      const got = merged.body.album.cards.find((c) => c.id === id);
      if (!got || got.count < n) cardsOk = false;
    }
    check('adoption keeps the fuller postcard page per card', cardsOk, JSON.stringify(devCards));

    // The account shelf reads back from a different device entirely.
    const otherPhone = await shelfView(HTTP, { v: '2', clientId: 'gate-dev-z999', authToken: acctA.token, day: '2026-11-20' });
    check('the account shelf reads back under a different clientId',
      otherPhone.body.kolo.pieces === 7 && otherPhone.body.streak.totalDays === 5,
      JSON.stringify({ kolo: otherPhone.body.kolo, streak: otherPhone.body.streak }));

    // The claimed device record now reads empty on its own.
    const devAfter = await shelfView(HTTP, { v: '2', clientId: 'gate-dev-d001', day: '2026-11-20' });
    check('a claimed device shelf reads empty without the account',
      devAfter.body.kolo.pieces === 0 && devAfter.body.streak.totalDays === 0,
      JSON.stringify({ kolo: devAfter.body.kolo, streak: devAfter.body.streak }));

    // A second account presenting the same device gets its own
    // empty shelf: the claim already happened, exactly once.
    const second = await shelfView(HTTP, { v: '2', clientId: 'gate-dev-d001', authToken: acctB.token, day: '2026-11-20' });
    check('a second account cannot claim the same device shelf',
      second.body.kolo.pieces === 0 && second.body.streak.totalDays === 0,
      JSON.stringify({ kolo: second.body.kolo, streak: second.body.streak }));
    const devFinal = await shelfView(HTTP, { v: '2', clientId: 'gate-dev-d001', day: '2026-11-20' });
    check('the device record stays claimed and empty', devFinal.body.kolo.pieces === 0 && devFinal.body.streak.totalDays === 0);
  }
} finally {
  server.kill();
  serverT.kill();
  stub.close();
}

console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
if (failures) { console.log(server.log.slice(-1500)); process.exit(1); }
