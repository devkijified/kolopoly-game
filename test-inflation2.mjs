// KOLOPOLY Inflation upgrade tests: the seven global phases, Lifeline and
// Hustle, per docs/INFLATION-7.md. Spawns the server with KP_TEST=1 on its
// own port and plays scripted games over WebSocket, mirroring
// test-engine.mjs. Run: node test-inflation2.mjs
// Exit code 0 means every check passed.
import WebSocket from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = 4211;
const RETENTION_FILE = '/tmp/kolopoly-retention-' + PORT + '.json';
try { fs.unlinkSync(RETENTION_FILE); } catch (e) { /* first run */ }
const BASE = 'ws://127.0.0.1:' + PORT;
let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.playerId = null;
    this.code = null;
    this.errors = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'joined') { this.playerId = msg.playerId; this.code = msg.code; if (msg.token) this.token = msg.token; }
        if (msg.type === 'state') this.state = msg.room;
        if (msg.type === 'error') this.errors.push(msg.message);
        if (msg.type === 'test_bot_stats') this.botStats = msg.bots;
      });
    });
  }
  send(type, obj) { this.ws.send(JSON.stringify(Object.assign({ type }, obj || {}))); }
  async waitFor(pred, label, ms) {
    const end = Date.now() + (ms || 9000);
    while (Date.now() < end) {
      if (this.state && pred(this.state)) return this.state;
      await sleep(80);
    }
    throw new Error('timeout waiting for: ' + label + ' (client ' + this.name + ', phase=' + (this.state && this.state.phase) + ', status=' + (this.state && this.state.status) + ')');
  }
}

async function makeGame(settings, names) {
  const clients = [];
  const host = new Client(names[0]);
  await host.connect();
  host.send('create_room', { name: names[0], token: 'danfo', mode: 'online', settings });
  await host.waitFor((s) => s.status === 'lobby' && s.players.length === 1, 'host lobby');
  const code = host.state.code;
  for (let k = 1; k < names.length; k++) {
    const c = new Client(names[k]);
    await c.connect();
    c.send('join_room', { code, name: names[k], token: ['keke', 'okada', 'generator', 'boot', 'fila'][k - 1] });
    clients.push(c);
  }
  const all = [host, ...clients];
  await host.waitFor((s) => s.players.length === names.length, 'all joined');
  host.send('start_game', {});
  await host.waitFor((s) => s.status === 'playing', 'game started');
  const g = { clients: all, host, code };
  g.S = () => host.state;
  g.byId = (id) => all.find((c) => c.playerId === id);
  g.turn = () => g.byId(g.S().turnPlayerId);
  g.player = (id) => g.S().players.find((p) => p.id === id);
  g.hook = (type, obj) => host.send(type, obj);
  return g;
}
const INF = { gameMode: 'inflation', preset: 'standard', timed: false, turnTimerSec: 0 };

// A turn that changes nothing: stand on 17, roll 3, land on Owambe Grounds, end.
async function nullTurn(g) {
  await g.host.waitFor((s) => s.status === 'playing' && (s.phase === 'roll' || s.phase === 'jail'), 'an actionable turn state');
  const before = g.S().turnPlayerId;
  if (g.player(before).inJail) throw new Error('nullTurn called for a jailed player');
  const t = g.turn();
  g.hook('test_set_position', { playerId: before, space: 17 });
  g.hook('test_dice', { rolls: [[1, 2]] });
  t.send('roll', {});
  await t.waitFor((s) => s.phase === 'end' && s.turnPlayerId === before, 'null turn resolves');
  t.send('end_turn', {});
  await g.host.waitFor((s) => s.turnPlayerId !== before || s.status !== 'playing', 'turn passes');
}
async function passAuction(g) {
  for (let round = 0; round < 3 && g.S().auction; round++) {
    for (const c of g.clients) c.send('pass_bid', {});
    await sleep(250);
  }
  await g.host.waitFor((s) => !s.auction, 'auction closed', 9000);
}
// Walk turns until the given client holds a fresh roll phase.
async function ensureRollTurn(g, client, label) {
  let guard = 0;
  while (guard++ < 8) {
    const s = g.S();
    if (s.turnPlayerId === client.playerId && s.phase === 'roll') return;
    await nullTurn(g);
  }
  throw new Error('ensureRollTurn failed: ' + (label || client.name));
}

// ---- Bot helpers (mirrored from test-engine.mjs) ---------------------------
async function botRoom(settings, botCount) {
  const host = new Client('BotHost');
  await host.connect();
  host.send('create_room', { name: 'BotHost', token: 'danfo', mode: 'online', settings });
  await host.waitFor((s) => s.status === 'lobby' && s.players.length === 1, 'bot room lobby');
  for (let i = 0; i < botCount; i++) host.send('add_bot', {});
  await host.waitFor((s) => s.players.length === 1 + botCount, 'bots seated');
  const g = { host, code: host.state.code };
  g.S = () => host.state;
  g.bots = () => host.state.players.filter((p) => p.bot);
  g.botRow = (id) => host.state.players.find((p) => p.id === id);
  g.hook = (type, obj) => host.send(type, obj);
  g.hold = (id, h) => host.send('test_bot_hold', { playerId: id, hold: h });
  return g;
}
async function driveUntil(g, pred, label, ms) {
  const host = g.host;
  const end = Date.now() + (ms || 25000);
  while (Date.now() < end) {
    const s = host.state;
    if (s && pred(s)) return s;
    if (s && s.status === 'playing') {
      if (s.auction) { if (s.auction.highBidder !== host.playerId) host.send('pass_bid', {}); }
      else if (s.turnPlayerId === host.playerId) {
        const me = s.players.find((p) => p.id === host.playerId);
        if (me && me.inJail) host.send('jail_roll', {});
        else if (s.phase === 'roll') {
          host.send('test_set_position', { playerId: host.playerId, space: 17 });
          host.send('test_dice', { rolls: [[1, 2]] });
          host.send('roll', {});
        }
        else if (s.phase === 'buy') host.send('decline', {});
        else if (s.phase === 'tax') host.send('tax_choice', { choice: 'flat' });
        else if (s.phase === 'end') host.send('end_turn', {});
      }
    }
    await sleep(130);
  }
  throw new Error('driveUntil timeout: ' + label);
}

// One scripted rent landing in a fresh Inflation room. The owner holds the
// space, the turn player lands on it with the given dice in the given phase,
// and any Lifeline bill is skipped so the full multiplied rent moves.
async function rentCase(label, phase, rolls, expected, opts) {
  const o = opts || {};
  const space = o.space != null ? o.space : 13;      // Yaba, printed rent 10000
  const printed = o.printed != null ? o.printed : 10000;
  const from = o.from;
  const g = await makeGame(INF, ['Tenant', 'Owner']);
  const t = g.turn();
  const owner = g.clients.find((c) => c !== t);
  g.hook('test_give', { playerId: owner.playerId, space });
  if (phase > 1) {
    g.hook('test_phase', { phase });
    await g.host.waitFor((s) => s.inf.phase === phase, label + ': phase set');
  }
  const t0 = g.player(t.playerId).cash;
  const o0 = g.player(owner.playerId).cash;
  g.hook('test_set_position', { playerId: t.playerId, space: from });
  g.hook('test_dice', { rolls: [rolls] });
  t.send('roll', {});
  let billSeen = false;
  if (expected > printed) {
    await t.waitFor((s) => !!s.pendingBill && s.pendingBill.playerId === t.playerId, label + ': lifeline bill');
    billSeen = true;
    const pb = t.state.pendingBill;
    t.send('lifeline_skip', { billId: pb.id, id: pb.id });
  }
  await t.waitFor((s) => {
    if (s.pendingBill && s.pendingBill.playerId === t.playerId) billSeen = true;
    return s.players.find((p) => p.id === owner.playerId).cash === o0 + expected;
  }, label + ': rent moved', 12000);
  check(label, g.player(t.playerId).cash === t0 - expected && g.player(owner.playerId).cash === o0 + expected,
    'tenant=' + g.player(t.playerId).cash + ' (want ' + (t0 - expected) + ') owner=' + g.player(owner.playerId).cash + ' (want ' + (o0 + expected) + ')');
  if (expected === printed) check(label + ': no Lifeline bill opens at x1', billSeen === false);
  for (const c of g.clients) c.ws.close();
}

// One staged Hustle that resolves: cash set, roll queued, target answers.
async function hustleResolve(g, atk, tgt, roll, defend) {
  g.hook('test_set_cash', { playerId: atk.playerId, amount: 500000 });
  g.hook('test_set_cash', { playerId: tgt.playerId, amount: 1000000 });
  g.hook('test_set_pot', { amount: 0 });
  await sleep(200);
  g.hook('test_hustle_rolls', { rolls: [roll] });
  atk.send('hustle_start', { targetId: tgt.playerId });
  await atk.waitFor((s) => !!s.hustle, 'hustle opens');
  const hid = atk.state.hustle.id;
  tgt.send('hustle_defend', { hustleId: hid, id: hid, defend });
  await atk.waitFor((s) => !s.hustle, 'hustle resolves', 15000);
}

const serverEnv = { ...process.env, PORT: String(PORT), KP_TEST: '1', KP_RETENTION_FILE: RETENTION_FILE };
delete serverEnv.KP_ADMIN_TOKEN;
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('Kolopoly listening')) resolve(); }));
console.log('server up on ' + PORT);

try {
  // ------------------------------------------------------------- X1 PHASES ---
  console.log('X1: the seven phase schedule: names, salaries and the next phase line');
  {
    const g = await makeGame(INF, ['Ada', 'Bola']);
    const NAMES = ['Standard', 'Squeeze', 'Heat', 'Crunch', 'Crisis', 'Meltdown', 'Final Reckoning'];
    const SALARIES = [200000, 140000, 100000, 70000, 40000, 20000, 10000];
    check('an Inflation game opens at phase 1 Standard with salary 200000',
      g.S().inf && g.S().inf.phase === 1 && g.S().inf.phaseName === 'Standard' && g.S().inf.salary === 200000,
      JSON.stringify(g.S().inf));
    check('the match deadline is set from the start', Number.isFinite(g.S().inf.deadlineAt) && g.S().inf.deadlineAt > Date.now());
    for (let ph = 1; ph <= 7; ph++) {
      if (ph > 1) {
        g.hook('test_phase', { phase: ph });
        await g.host.waitFor((s) => s.inf.phase === ph, 'phase ' + ph);
      }
      check('phase ' + ph + ' is ' + NAMES[ph - 1] + ' with salary ' + SALARIES[ph - 1],
        g.S().inf.phaseName === NAMES[ph - 1] && g.S().inf.salary === SALARIES[ph - 1],
        'name=' + g.S().inf.phaseName + ' salary=' + g.S().inf.salary);
      check('phase ' + ph + ' names the next phase as ' + (ph < 7 ? NAMES[ph] : 'none'),
        g.S().inf.nextPhaseName === (ph < 7 ? NAMES[ph] : null), 'next=' + g.S().inf.nextPhaseName);
    }
    for (const c of g.clients) c.ws.close();
  }

  // ------------------------------------------------------ X2 RENT MATRIX ---
  console.log('X2: rent multipliers off the actual landing dice (Yaba printed rent 10000)');
  await rentCase('Standard rent stays printed x1', 1, [2, 5], 10000, { from: 6 });
  await rentCase('Squeeze rent = printed x lower die 2', 2, [2, 5], 20000, { from: 6 });
  await rentCase('Squeeze rent ignores dice order: [5,2] is still x2', 2, [5, 2], 20000, { from: 6 });
  await rentCase('Heat rent = printed x higher die 5', 3, [2, 5], 50000, { from: 6 });
  await rentCase('Crunch rent = printed x dice sum 7', 4, [2, 5], 70000, { from: 6 });
  await rentCase('Crisis rent = printed x sum x lower die (7 x 2 = 14)', 5, [2, 5], 140000, { from: 6 });
  await rentCase('Meltdown rent = printed x sum x higher die (7 x 5 = 35)', 6, [2, 5], 350000, { from: 6 });
  await rentCase('Final Reckoning rent = printed x sum squared (7 x 7 = 49)', 7, [2, 5], 490000, { from: 6 });
  await rentCase('Squeeze doubles [3,3] still use both faces: x3', 2, [3, 3], 30000, { from: 7 });
  await rentCase('Crunch doubles [3,3]: x6', 4, [3, 3], 60000, { from: 7 });
  await rentCase('Final Reckoning doubles [3,3]: x36', 7, [3, 3], 360000, { from: 7 });
  await rentCase('station rent multiplies too: MMIA in Heat x5', 3, [2, 5], 125000, { space: 15, printed: 25000, from: 8 });

  // ------------------------------------------------- X3 MULTIPLIER SCOPE ---
  console.log('X3: the multiplier touches property rent only: utilities and taxes stay printed');
  {
    const g = await makeGame(INF, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_give', { playerId: o.playerId, space: 12 }); // NEPA
    g.hook('test_phase', { phase: 7 });
    await g.host.waitFor((s) => s.inf.phase === 7, 'final reckoning');
    const t0 = g.player(t.playerId).cash;
    const o0 = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: t.playerId, space: 9 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    t.send('roll', {});
    await t.waitFor((s) => s.players.find((p) => p.id === o.playerId).cash === o0 + 12000, 'utility rent moved', 12000);
    check('utility rent in Final Reckoning is the plain dice sum rent: 3 x 1000 x 4 = 12000, unmultiplied',
      g.player(t.playerId).cash === t0 - 12000 && g.player(o.playerId).cash === o0 + 12000,
      'tenant=' + g.player(t.playerId).cash + ' owner=' + g.player(o.playerId).cash);
    check('a utility landing opens no Lifeline bill', !g.S().pendingBill);
    for (const c of g.clients) c.ws.close();
  }
  {
    const g = await makeGame(INF, ['Ada', 'Bola']);
    const t = g.turn();
    g.hook('test_set_pot', { amount: 0 });
    g.hook('test_phase', { phase: 7 });
    await g.host.waitFor((s) => s.inf.phase === 7, 'final reckoning');
    const t0 = g.player(t.playerId).cash;
    g.hook('test_set_position', { playerId: t.playerId, space: 35 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    t.send('roll', {});
    await t.waitFor((s) => s.players.find((p) => p.id === t.playerId).cash === t0 - 100000, 'tax paid', 12000);
    check('Lagos tax in Final Reckoning is the printed 100000, unmultiplied, and feeds the pot',
      g.player(t.playerId).cash === t0 - 100000 && g.S().pot === 100000, 'pot=' + g.S().pot);
    for (const c of g.clients) c.ws.close();
  }

  // ------------------------------------------------------------ X4 SALARY ---
  console.log('X4: salary is paid at the rate of the phase in force at the START pass');
  {
    const g = await makeGame(INF, ['Ada', 'Bola']);
    g.hook('test_phase', { phase: 2 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'squeeze');
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    const t0 = g.player(t.playerId).cash;
    g.hook('test_set_position', { playerId: t.playerId, space: 38 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'buy' && s.buySpace === 1, 'wrapped to Makoko');
    check('a START pass in Squeeze credits exactly 140000', g.player(t.playerId).cash === t0 + 140000,
      'cash=' + g.player(t.playerId).cash);
    t.send('decline', {});
    await t.waitFor((s) => !!s.auction, 'auction');
    await passAuction(g);
    await t.waitFor((s) => s.phase === 'end', 'turn done');
    t.send('end_turn', {});
    await g.host.waitFor((s) => s.turnPlayerId === o.playerId, 'other turn');
    g.hook('test_phase', { phase: 7 });
    await g.host.waitFor((s) => s.inf.phase === 7, 'final reckoning');
    const o0 = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: o.playerId, space: 38 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    o.send('roll', {});
    await o.waitFor((s) => s.phase === 'buy' && s.buySpace === 1, 'wrapped to Makoko in phase 7');
    check('a START pass in Final Reckoning credits exactly 10000', g.player(o.playerId).cash === o0 + 10000,
      'cash=' + g.player(o.playerId).cash);
    for (const c of g.clients) c.ws.close();
  }

  // -------------------------------------------------------- X5 FROZEN BILL ---
  console.log('X5: a bill is frozen at landing: a later phase never reprices it');
  {
    const g = await makeGame(INF, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_give', { playerId: o.playerId, space: 13 }); // Yaba
    g.hook('test_give', { playerId: t.playerId, space: 6 });  // Mushin: the raise asset
    g.hook('test_phase', { phase: 2 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'squeeze');
    g.hook('test_set_cash', { playerId: t.playerId, amount: 5000 });
    await sleep(200);
    const o0 = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: t.playerId, space: 6 });
    g.hook('test_dice', { rolls: [[2, 5]] });
    t.send('roll', {});
    await t.waitFor((s) => !!s.pendingBill && s.pendingBill.playerId === t.playerId, 'bill opens');
    check('the Squeeze bill is frozen at 20000 (printed 10000 x lower die 2)', g.S().pendingBill.amount === 20000,
      JSON.stringify(g.S().pendingBill));
    t.send('lifeline_skip', { billId: g.S().pendingBill.id, id: g.S().pendingBill.id });
    await t.waitFor((s) => !!s.debt && s.debt.playerId === t.playerId, 'debt opens for the unpaid bill', 12000);
    check('an unpayable skipped bill becomes a debt at the frozen amount', g.S().debt.amount === 20000,
      'debt=' + JSON.stringify(g.S().debt));
    g.hook('test_phase', { phase: 3 });
    await g.host.waitFor((s) => s.inf.phase === 3, 'heat begins');
    await sleep(300);
    check('in Heat the debt is still the frozen Squeeze 20000, not a Heat recalculation', g.S().debt && g.S().debt.amount === 20000,
      'debt=' + JSON.stringify(g.S().debt));
    t.send('mortgage', { space: 6 });
    await t.waitFor((s) => !s.debt, 'mortgage settles the debt', 12000);
    check('settling charges the frozen 20000: landlord gains 20000, tenant keeps 35000 of the raise',
      g.player(o.playerId).cash === o0 + 20000 && g.player(t.playerId).cash === 35000,
      'tenant=' + g.player(t.playerId).cash + ' owner=' + g.player(o.playerId).cash);
    for (const c of g.clients) c.ws.close();
  }

  // ---------------------------------------------------------- X6 LIFELINE ---
  console.log('X6a: the Lifeline bill shows its maths and lifeline_use pays the printed rent');
  {
    const g = await makeGame(INF, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_give', { playerId: o.playerId, space: 13 });
    g.hook('test_phase', { phase: 2 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'squeeze');
    const t0 = g.player(t.playerId).cash;
    const o0 = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: t.playerId, space: 6 });
    g.hook('test_dice', { rolls: [[2, 5]] });
    t.send('roll', {});
    await t.waitFor((s) => !!s.pendingBill && s.pendingBill.playerId === t.playerId, 'bill opens');
    const pb = g.S().pendingBill;
    check('the bill carries printed, multiplier, amount and the landing dice',
      pb.printed === 10000 && pb.mult === 2 && pb.amount === 20000 && Array.isArray(pb.dice) && pb.dice[0] === 2 && pb.dice[1] === 5,
      JSON.stringify(pb));
    check('no money moves while the bill is open', g.player(t.playerId).cash === t0 && g.player(o.playerId).cash === o0);
    t.send('lifeline_use', { billId: pb.id, id: pb.id });
    await t.waitFor((s) => !s.pendingBill && s.players.find((p) => p.id === o.playerId).cash === o0 + 10000, 'lifeline settles', 12000);
    check('lifeline_use pays exactly the printed 10000 and spends the Lifeline',
      g.player(t.playerId).cash === t0 - 10000 && g.player(o.playerId).cash === o0 + 10000 && g.player(t.playerId).lifelineUsed === true,
      'tenant=' + g.player(t.playerId).cash + ' used=' + g.player(t.playerId).lifelineUsed);

    console.log('X6b: a spent Lifeline never offers a second bill');
    await t.waitFor((s) => s.phase === 'end', 'turn ends after the lifeline rent');
    t.send('end_turn', {});
    await nullTurn(g); // the owner takes a quiet turn
    await ensureRollTurn(g, t, 'tenant rolls again');
    const t1 = g.player(t.playerId).cash;
    const o1 = g.player(o.playerId).cash;
    let billSeen = false;
    g.hook('test_set_position', { playerId: t.playerId, space: 6 });
    g.hook('test_dice', { rolls: [[2, 5]] });
    t.send('roll', {});
    await t.waitFor((s) => {
      if (s.pendingBill) billSeen = true;
      return s.players.find((p) => p.id === o.playerId).cash === o1 + 20000;
    }, 'second multiplied rent moves at once', 12000);
    check('the second multiplied landing charges the full 20000 with no bill offered',
      billSeen === false && g.player(t.playerId).cash === t1 - 20000 && g.player(t.playerId).lifelineUsed === true,
      'tenant=' + g.player(t.playerId).cash + ' billSeen=' + billSeen);
    for (const c of g.clients) c.ws.close();
  }

  console.log('X6c: lifeline_skip pays the full multiplied rent and keeps the Lifeline');
  {
    const g = await makeGame(INF, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_give', { playerId: o.playerId, space: 13 });
    g.hook('test_phase', { phase: 2 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'squeeze');
    const t0 = g.player(t.playerId).cash;
    const o0 = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: t.playerId, space: 6 });
    g.hook('test_dice', { rolls: [[2, 5]] });
    t.send('roll', {});
    await t.waitFor((s) => !!s.pendingBill, 'bill opens');
    const skipBill = g.S().pendingBill;
    t.send('lifeline_skip', { billId: skipBill.id, id: skipBill.id });
    await t.waitFor((s) => !s.pendingBill && s.players.find((p) => p.id === o.playerId).cash === o0 + 20000, 'skip settles', 12000);
    check('skip pays the full 20000 and the Lifeline stays unspent',
      g.player(t.playerId).cash === t0 - 20000 && g.player(t.playerId).lifelineUsed === false,
      'tenant=' + g.player(t.playerId).cash + ' used=' + g.player(t.playerId).lifelineUsed);
    for (const c of g.clients) c.ws.close();
  }

  console.log('X6d: silence on the bill pays full rent and keeps the Lifeline');
  {
    const g = await makeGame(INF, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_give', { playerId: o.playerId, space: 13 });
    g.hook('test_phase', { phase: 2 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'squeeze');
    const t0 = g.player(t.playerId).cash;
    const o0 = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: t.playerId, space: 6 });
    g.hook('test_dice', { rolls: [[2, 5]] });
    t.send('roll', {});
    await t.waitFor((s) => !!s.pendingBill, 'bill opens');
    // Nobody answers. The test build runs a 4 second bill window.
    await t.waitFor((s) => !s.pendingBill && s.players.find((p) => p.id === o.playerId).cash === o0 + 20000, 'bill times out at full rent', 20000);
    check('the timed out bill charged the full 20000 and the Lifeline is still unspent',
      g.player(t.playerId).cash === t0 - 20000 && g.player(t.playerId).lifelineUsed === false,
      'tenant=' + g.player(t.playerId).cash + ' used=' + g.player(t.playerId).lifelineUsed);
    for (const c of g.clients) c.ws.close();
  }

  console.log('X6e: a bot spends its Lifeline at once when the saving clears 100000');
  {
    const g = await botRoom(INF, 1);
    const botId = g.bots()[0].id;
    g.hold(botId, true); // frozen before the game starts: no first tick race
    g.host.send('start_game', {});
    await g.host.waitFor((s) => s.status === 'playing', 'bot inflation game started');
    g.hook('test_give', { playerId: g.host.playerId, space: 39 }); // Banana Island, printed rent 50000
    g.hook('test_phase', { phase: 2 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'squeeze');
    // Keep the host under the 50000 Hustle target floor so the bot turn is rent only.
    g.hook('test_set_cash', { playerId: g.host.playerId, amount: 40000 });
    await sleep(200);
    await driveUntil(g, (s) => s.turnPlayerId === g.host.playerId && s.phase === 'end', 'host end phase', 30000);
    g.hook('test_set_position', { playerId: botId, space: 28 });
    g.hook('test_dice', { rolls: [[5, 6]] }); // Squeeze: 50000 x lower die 5 = 250000, saving 200000
    g.hold(botId, false);
    g.host.send('end_turn', {});
    await g.host.waitFor((s) => {
      const b = s.players.find((p) => p.id === botId);
      return b && b.lifelineUsed === true && b.cash === 1450000;
    }, 'bot lifeline resolves instantly', 15000);
    check('the bot paid the printed 50000 at once, Lifeline spent, no bill ever waited',
      g.botRow(botId).lifelineUsed === true && g.botRow(botId).cash === 1450000 && !g.S().pendingBill,
      'bot cash=' + g.botRow(botId).cash + ' used=' + g.botRow(botId).lifelineUsed);
    g.host.ws.close();
  }

  // ------------------------------------------------------------ X7 HUSTLE ---
  console.log('X7a: a successful Hustle moves exactly 10 percent, once, and lands in the audit feed');
  {
    const g = await makeGame(INF, ['Ash', 'Bisi']);
    const atk = g.turn();
    const tgt = g.clients.find((c) => c !== atk);
    g.hook('test_set_cash', { playerId: atk.playerId, amount: 500000 });
    g.hook('test_set_cash', { playerId: tgt.playerId, amount: 1000000 });
    g.hook('test_set_pot', { amount: 0 });
    await sleep(200);
    g.hook('test_hustle_rolls', { rolls: [0.10] });
    atk.send('hustle_start', { targetId: tgt.playerId });
    await atk.waitFor((s) => !!s.hustle, 'hustle opens');
    const openHustle = g.S().hustle;
    check('the open Hustle shows the amount (10 percent of 1000000) and the fine (half, floor 10000)',
      openHustle.amount === 100000 && openHustle.fine === 50000, JSON.stringify(openHustle));
    atk.send('hustle_start', { targetId: tgt.playerId }); // repeated click while open
    await sleep(400);
    check('a repeated hustle_start click opens no second Hustle', !!g.S().hustle && g.S().hustle.id === openHustle.id,
      JSON.stringify(g.S().hustle));
    tgt.send('hustle_defend', { hustleId: openHustle.id, id: openHustle.id, defend: false });
    tgt.send('hustle_defend', { hustleId: openHustle.id, id: openHustle.id, defend: false }); // double answer
    await atk.waitFor((s) => !s.hustle && s.players.find((p) => p.id === tgt.playerId).cash === 900000, 'hustle settles', 15000);
    check('success at an undefended 45 percent chance: exactly 100000 moved, exactly once',
      g.player(atk.playerId).cash === 600000 && g.player(tgt.playerId).cash === 900000,
      'atk=' + g.player(atk.playerId).cash + ' tgt=' + g.player(tgt.playerId).cash);
    check('the settled Hustle is written to the match audit (feed or stamps)',
      g.S().feed.some((e) => e.kind === 'hustle' || /hustle/i.test(e.text || '')) ||
      (g.S().stamps || []).some((st) => st.kind === 'hustle'));
    for (const c of g.clients) c.ws.close();
  }

  console.log('X7b: a caught Hustle against an undefended target pays the whole fine to the pot');
  {
    const g = await makeGame(INF, ['Ash', 'Bisi']);
    const atk = g.turn();
    const tgt = g.clients.find((c) => c !== atk);
    await hustleResolve(g, atk, tgt, 0.99, false);
    check('roll 0.99 fails the 45 percent chance: attacker pays the 50000 fine, target untouched',
      g.player(atk.playerId).cash === 450000 && g.player(tgt.playerId).cash === 1000000,
      'atk=' + g.player(atk.playerId).cash + ' tgt=' + g.player(tgt.playerId).cash);
    check('the whole fine entered the Owambe pot', g.S().pot === 50000, 'pot=' + g.S().pot);
    for (const c of g.clients) c.ws.close();
  }

  console.log('X7c: a defended target drops the chance to 15 percent and splits a caught fine');
  {
    const g = await makeGame(INF, ['Ash', 'Bisi']);
    const atk = g.turn();
    const tgt = g.clients.find((c) => c !== atk);
    // 0.20 beats the undefended 45 percent line but fails the defended 15 percent line.
    await hustleResolve(g, atk, tgt, 0.20, true);
    check('roll 0.20 is caught against a defended target: attacker pays the 50000 fine',
      g.player(atk.playerId).cash === 450000, 'atk=' + g.player(atk.playerId).cash);
    check('the fine splits: half to the defending target, half to the pot',
      g.player(tgt.playerId).cash === 1025000 && g.S().pot === 25000,
      'tgt=' + g.player(tgt.playerId).cash + ' pot=' + g.S().pot);
    for (const c of g.clients) c.ws.close();
  }

  console.log('X7d: no answer in the window resolves at 30 percent, fine wholly to the pot');
  {
    const g = await makeGame(INF, ['Ash', 'Bisi']);
    const atk = g.turn();
    const tgt = g.clients.find((c) => c !== atk);
    g.hook('test_set_cash', { playerId: atk.playerId, amount: 500000 });
    g.hook('test_set_cash', { playerId: tgt.playerId, amount: 1000000 });
    g.hook('test_set_pot', { amount: 0 });
    await sleep(200);
    // 0.35 would pass an answered Leave am (45 percent) but fails the silent 30 percent.
    g.hook('test_hustle_rolls', { rolls: [0.35] });
    atk.send('hustle_start', { targetId: tgt.playerId });
    await atk.waitFor((s) => !!s.hustle, 'hustle opens');
    await atk.waitFor((s) => !s.hustle, 'hustle times out and resolves', 25000);
    check('the silent target default caught the attacker: fine paid, target untouched',
      g.player(atk.playerId).cash === 450000 && g.player(tgt.playerId).cash === 1000000,
      'atk=' + g.player(atk.playerId).cash + ' tgt=' + g.player(tgt.playerId).cash);
    check('the whole fine entered the pot on a timeout catch', g.S().pot === 50000, 'pot=' + g.S().pot);
    for (const c of g.clients) c.ws.close();
  }

  console.log('X7e: protections: the fine must be covered, the target must hold 50000 and be out of Kirikiri');
  {
    const g = await makeGame(INF, ['Ash', 'Bisi']);
    const atk = g.turn();
    const tgt = g.clients.find((c) => c !== atk);
    g.hook('test_set_cash', { playerId: atk.playerId, amount: 40000 });
    g.hook('test_set_cash', { playerId: tgt.playerId, amount: 1000000 });
    await sleep(200);
    let errBefore = atk.errors.length;
    atk.send('hustle_start', { targetId: tgt.playerId });
    await sleep(500);
    check('an attacker holding 40000 cannot start: the fine on a 100000 grab is 50000',
      atk.errors.length > errBefore && !g.S().hustle, 'err=' + atk.errors.slice(-1));
    g.hook('test_set_cash', { playerId: atk.playerId, amount: 500000 });
    g.hook('test_set_cash', { playerId: tgt.playerId, amount: 40000 });
    await sleep(200);
    errBefore = atk.errors.length;
    atk.send('hustle_start', { targetId: tgt.playerId });
    await sleep(500);
    check('a target holding under 50000 cannot be hustled', atk.errors.length > errBefore && !g.S().hustle,
      'err=' + atk.errors.slice(-1));
    for (const c of g.clients) c.ws.close();
  }
  {
    const g = await makeGame(INF, ['Ash', 'Bisi']);
    const atk = g.turn();
    const tgt = g.clients.find((c) => c !== atk);
    await ensureRollTurn(g, tgt, 'target to move');
    g.hook('test_set_position', { playerId: tgt.playerId, space: 28 });
    g.hook('test_dice', { rolls: [[1, 1]] });
    tgt.send('roll', {});
    await tgt.waitFor((s) => s.players.find((p) => p.id === tgt.playerId).inJail, 'target sent to Kirikiri');
    tgt.send('end_turn', {});
    await g.host.waitFor((s) => s.turnPlayerId === atk.playerId, 'turn reaches the attacker');
    await ensureRollTurn(g, atk, 'attacker to move');
    const errBefore = atk.errors.length;
    atk.send('hustle_start', { targetId: tgt.playerId });
    await sleep(500);
    check('a target inside Kirikiri cannot be hustled', atk.errors.length > errBefore && !g.S().hustle,
      'err=' + atk.errors.slice(-1));
    for (const c of g.clients) c.ws.close();
  }

  console.log('X7f: attempt caps: one hustle per target per phase, three attempts per match');
  {
    const g = await makeGame(INF, ['Ash', 'Bisi', 'Chidi']);
    const atk = g.turn();
    const [tgtB, tgtC] = g.clients.filter((c) => c !== atk);
    g.hook('test_phase', { phase: 2 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'squeeze');
    await hustleResolve(g, atk, tgtB, 0.10, false);
    check('attempt 1 lands: 100000 moved in Squeeze', g.player(atk.playerId).cash === 600000 && g.player(tgtB.playerId).cash === 900000,
      'atk=' + g.player(atk.playerId).cash + ' tgt=' + g.player(tgtB.playerId).cash);
    // Same phase, same target, on a later turn: refused.
    await nullTurn(g); await nullTurn(g); await nullTurn(g);
    await ensureRollTurn(g, atk, 'attacker second turn');
    const errBefore = atk.errors.length;
    atk.send('hustle_start', { targetId: tgtB.playerId });
    await sleep(500);
    check('the same target cannot be hustled twice in one phase', atk.errors.length > errBefore && !g.S().hustle,
      'err=' + atk.errors.slice(-1));
    await nullTurn(g); await nullTurn(g); await nullTurn(g);
    await ensureRollTurn(g, atk, 'attacker third turn');
    g.hook('test_phase', { phase: 3 });
    await g.host.waitFor((s) => s.inf.phase === 3, 'heat');
    await hustleResolve(g, atk, tgtC, 0.10, false);
    check('attempt 2 lands on the other target in Heat', g.player(tgtC.playerId).cash === 900000,
      'tgtC=' + g.player(tgtC.playerId).cash);
    await nullTurn(g); await nullTurn(g); await nullTurn(g);
    await ensureRollTurn(g, atk, 'attacker fourth turn');
    g.hook('test_phase', { phase: 4 });
    await g.host.waitFor((s) => s.inf.phase === 4, 'crunch');
    await hustleResolve(g, atk, tgtB, 0.10, false);
    check('attempt 3 lands back on the first target in Crunch (pair count two is allowed)',
      g.player(tgtB.playerId).cash === 900000, 'tgtB=' + g.player(tgtB.playerId).cash);
    await nullTurn(g); await nullTurn(g); await nullTurn(g);
    await ensureRollTurn(g, atk, 'attacker fifth turn');
    g.hook('test_phase', { phase: 5 });
    await g.host.waitFor((s) => s.inf.phase === 5, 'crisis');
    const err4 = atk.errors.length;
    atk.send('hustle_start', { targetId: tgtC.playerId });
    await sleep(500);
    check('a fourth attempt in one match is refused', atk.errors.length > err4 && !g.S().hustle,
      'err=' + atk.errors.slice(-1));
    for (const c of g.clients) c.ws.close();
  }

  console.log('X7g: the same attacker can hustle the same target at most twice per match');
  {
    const g = await makeGame(INF, ['Ash', 'Bisi', 'Chidi']);
    const atk = g.turn();
    const tgt = g.clients.find((c) => c !== atk);
    g.hook('test_phase', { phase: 2 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'squeeze');
    await hustleResolve(g, atk, tgt, 0.10, false);
    await nullTurn(g); await nullTurn(g); await nullTurn(g);
    await ensureRollTurn(g, atk, 'attacker second turn');
    g.hook('test_phase', { phase: 3 });
    await g.host.waitFor((s) => s.inf.phase === 3, 'heat');
    await hustleResolve(g, atk, tgt, 0.10, false);
    check('two hustles on one target across two phases both land', g.player(tgt.playerId).cash === 900000,
      'tgt=' + g.player(tgt.playerId).cash);
    await nullTurn(g); await nullTurn(g); await nullTurn(g);
    await ensureRollTurn(g, atk, 'attacker third turn');
    g.hook('test_phase', { phase: 4 });
    await g.host.waitFor((s) => s.inf.phase === 4, 'crunch');
    const errBefore = atk.errors.length;
    atk.send('hustle_start', { targetId: tgt.playerId });
    await sleep(500);
    check('a third hustle on the same target is refused even with attempts to spare',
      atk.errors.length > errBefore && !g.S().hustle && g.player(atk.playerId).hustleAttempts === 2,
      'err=' + atk.errors.slice(-1) + ' attempts=' + g.player(atk.playerId).hustleAttempts);
    for (const c of g.clients) c.ws.close();
  }

  // ---------------------------------------------------------- X8 DEADLINE ---
  console.log('X8: the deadline ranks by net worth, then cash, with debts deducted');
  {
    const g = await makeGame(INF, ['Ada', 'Bola']);
    const [pa, pb] = g.S().players;
    g.hook('test_give', { playerId: pa.id, space: 39 }); // Banana Island, 400000 of deeds
    g.hook('test_horn_in', { seconds: 2 });
    await g.host.waitFor((s) => s.status === 'ended', 'deadline ended the game', 12000);
    check('the higher net worth wins at the deadline', g.S().winner && g.S().winner.playerId === pa.id,
      'winner=' + JSON.stringify(g.S().winner));
    check('the end table is sorted by the same ranking', g.S().endTable && g.S().endTable[0].playerId === pa.id);
    for (const c of g.clients) c.ws.close();
  }
  {
    const g = await makeGame(INF, ['Ada', 'Bola']);
    const [pa, pb] = g.S().players;
    g.hook('test_set_cash', { playerId: pa.id, amount: 560000 });
    g.hook('test_set_cash', { playerId: pb.id, amount: 300000 });
    g.hook('test_give', { playerId: pb.id, space: 27 }); // Victoria Island, 260000 of deeds
    await sleep(200);
    g.hook('test_horn_in', { seconds: 2 });
    await g.host.waitFor((s) => s.status === 'ended', 'deadline ended the tied game', 12000);
    check('equal net worth (560000 each) breaks to the higher cash: the cash holder wins',
      g.S().winner && g.S().winner.playerId === pa.id, 'winner=' + JSON.stringify(g.S().winner));
    for (const c of g.clients) c.ws.close();
  }
  {
    const g = await makeGame(INF, ['Ada', 'Bola']);
    const [creditor, debtor] = g.S().players;
    const cCli = g.byId(creditor.id);
    const dCli = g.byId(debtor.id);
    g.hook('test_give', { playerId: creditor.id, space: 13 }); // Yaba, 140000 of deeds
    g.hook('test_give', { playerId: debtor.id, space: 39 });   // Banana Island, 400000 of deeds
    g.hook('test_phase', { phase: 2 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'squeeze');
    await ensureRollTurn(g, dCli, 'debtor to move');
    g.hook('test_set_cash', { playerId: debtor.id, amount: 5000 });
    await sleep(200);
    g.hook('test_set_position', { playerId: debtor.id, space: 6 });
    g.hook('test_dice', { rolls: [[2, 5]] });
    dCli.send('roll', {});
    await dCli.waitFor((s) => !!s.pendingBill && s.pendingBill.playerId === debtor.id, 'debtor bill opens');
    dCli.send('lifeline_skip', { billId: g.S().pendingBill.id, id: g.S().pendingBill.id });
    await dCli.waitFor((s) => !!s.debt && s.debt.playerId === debtor.id, 'debtor debt opens', 12000);
    g.hook('test_set_cash', { playerId: creditor.id, amount: 250000 });
    await sleep(200);
    // Debtor worth before deduction: 5000 + 400000 = 405000, ahead of the
    // creditor at 250000 + 140000 = 390000. The frozen 20000 debt flips it.
    g.hook('test_horn_in', { seconds: 2 });
    await g.host.waitFor((s) => s.status === 'ended', 'deadline ended the debt game', 12000);
    check('an outstanding frozen debt is deducted before ranking: the creditor wins',
      g.S().winner && g.S().winner.playerId === creditor.id, 'winner=' + JSON.stringify(g.S().winner));
    check('the end table puts the creditor first', g.S().endTable && g.S().endTable[0].playerId === creditor.id);
    for (const c of g.clients) c.ws.close();
  }

  // ------------------------------------------------------ X9 SNAPSHOT NOTE ---
  console.log('X9: old snapshot compatibility lives in test/worker/game.test.mjs (the Worker Durable Object owns importState; the Node host keeps rooms in memory only)');

  // ---------------------------------------------------------- X10 CLASSIC ---
  console.log('X10: Classic regression: no Inflation state, no bills, no Hustle');
  {
    const g = await makeGame({ gameMode: 'classic', timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    check('a Classic room carries no Inflation state', g.S().inf == null);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    const errBefore = t.errors.length;
    t.send('hustle_start', { targetId: o.playerId });
    await sleep(500);
    check('hustle_start is refused in Classic', t.errors.length > errBefore && !g.S().hustle,
      'err=' + t.errors.slice(-1));
    g.hook('test_give', { playerId: o.playerId, space: 13 });
    const t0 = g.player(t.playerId).cash;
    const o0 = g.player(o.playerId).cash;
    let billSeen = false;
    g.hook('test_set_position', { playerId: t.playerId, space: 6 });
    g.hook('test_dice', { rolls: [[2, 5]] });
    t.send('roll', {});
    await t.waitFor((s) => {
      if (s.pendingBill) billSeen = true;
      return s.players.find((p) => p.id === o.playerId).cash === o0 + 10000;
    }, 'classic rent moved', 12000);
    check('Classic rent is the printed 10000 with no Lifeline bill',
      g.player(t.playerId).cash === t0 - 10000 && billSeen === false,
      'tenant=' + g.player(t.playerId).cash + ' billSeen=' + billSeen);
    for (const c of g.clients) c.ws.close();
  }
} catch (err) {
  failures += 1;
  console.log('SUITE ERROR: ' + err.message);
} finally {
  server.kill();
}
console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
