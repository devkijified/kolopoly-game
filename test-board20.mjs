// KOLOPOLY board20 tests: the 20 space board, Owambe Rush, missed turn fee,
// Sapa Deals, reconnects and the old 40 space snapshot migration, per
// docs/BOARD28-HUSTLE-OWAMBE.md. Spawns the server with KP_TEST=1 on its
// own port and plays scripted games over WebSocket, mirroring
// test-inflation2.mjs. Run: node test-board20.mjs
// Exit code 0 means every check passed.
import WebSocket from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = 4231;
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

// A turn that changes nothing (board20): stand on Family Meeting (2), roll 3, land on Kirikiri just visiting (5), end.
async function nullTurn(g) {
  await g.host.waitFor((s) => s.status === 'playing' && (s.phase === 'roll' || s.phase === 'jail'), 'an actionable turn state');
  const before = g.S().turnPlayerId;
  if (g.player(before).inJail) throw new Error('nullTurn called for a jailed player');
  const t = g.turn();
  g.hook('test_set_position', { playerId: before, space: 2 });
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
          host.send('test_set_position', { playerId: host.playerId, space: 2 });
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

const require = (await import('module')).createRequire(import.meta.url);
const D = require('./public/game-data.js');
const { createGameHost } = require('./game-host.js');
const { EventEmitter } = await import('events');
const CLASSIC = { gameMode: 'classic', timed: false, turnTimerSec: 0 };

// Rejoin a seat on a fresh socket with its reconnect token.
async function reconnect(g, old) {
  const c = new Client(old.name);
  await c.connect();
  c.send('rejoin', { code: g.code, playerId: old.playerId, token: old.token });
  await c.waitFor((s) => s.code === g.code, 'rejoined ' + old.name);
  c.playerId = old.playerId; c.token = old.token;
  const k = g.clients.indexOf(old);
  if (k >= 0) g.clients[k] = c;
  if (old === g.host) { g.host = c; g.S = () => c.state; g.hook = (type, obj) => c.send(type, obj); }
  return c;
}
// Put a player into a debt: owner holds Banana Island (rent 100,000), the
// debtor stands on 16 holding the given cash and rolls 3.
async function makeDebt(g, debtor, owner, cash) {
  await g.host.waitFor((s) => s.turnPlayerId === debtor.playerId && s.phase === 'roll', 'debtor roll');
  g.hook('test_give', { playerId: owner.playerId, space: 19 });
  g.hook('test_give', { playerId: debtor.playerId, space: 1 });
  g.hook('test_give', { playerId: debtor.playerId, space: 3 });
  g.hook('test_set_cash', { playerId: debtor.playerId, amount: cash });
  g.hook('test_set_position', { playerId: debtor.playerId, space: 16 });
  g.hook('test_dice', { rolls: [[1, 2]] });
  await sleep(150);
  debtor.send('roll', {});
  await g.host.waitFor((s) => !!s.debt && s.debt.playerId === debtor.playerId, 'debt opened');
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
  // ---------------------------------------------------------------- B1 ---
  console.log('B1: the board is 20 spaces, 5 steps a side, with the Lagos landmarks and raised prices');
  {
    check('20 spaces, side 5', D.SPACES.length === 20 && D.BOARD_SIZE === 20 && D.SIDE === 5);
    check('corners: START 0, Kirikiri 5, Owambe 10, Go to Kirikiri 15',
      D.SPACES[0].type === 'start' && D.SPACES[5].type === 'jail' && D.SPACES[10].type === 'freeparking' && D.SPACES[15].type === 'gotojail' &&
      D.JAIL_INDEX === 5 && D.PARKING_INDEX === 10 && D.GOTOJAIL_INDEX === 15);
    check('Kirikiri is the jail name', /Kirikiri/.test(D.SPACES[5].name) && /Kirikiri/.test(D.SPACES[15].name));
    const names = D.SPACES.map((s) => s.name);
    for (const must of ['Quilox', 'Oriental Hotel', 'Eko Hotel', 'Lekki Tollgate']) check('board carries ' + must, names.includes(must));
    check('no product copy says Monopoly', !JSON.stringify(D).toLowerCase().includes('monopoly'));
    check('five colour sets of exactly two streets', Object.keys(D.GROUPS).length === 5 && Object.keys(D.GROUPS).every((g) => D.SPACES.filter((s) => s.group === g).length === 2));
    check('13 ownable spaces', D.OWNABLE.length === 13);
    check('stations at 7 and 14, the one utility at 9', JSON.stringify(D.STATIONS) === '[7,14]' && JSON.stringify(D.UTILITIES) === '[9]');
    check('prices rose again: Makoko 120,000, Banana Island 800,000, stations 400,000', D.SPACES[1].price === 120000 && D.SPACES[19].price === 800000 && D.SPACES[7].price === 400000 && D.SPACES[14].price === 400000);
    const streets = D.SPACES.filter((s) => s.type === 'street');
    check('street prices climb around the board', streets.every((s, k) => k === 0 || s.price >= streets[k - 1].price));
    check('every street has a seven step rent ladder that climbs', streets.every((s) => s.rent.length === 7 && s.rent.every((r, k) => k === 0 || r > s.rent[k - 1])));
    check('every non card space carries an art key', D.SPACES.every((s) => s.type === 'card' || (typeof s.art === 'string' && s.art.length > 0)));
    check('station ladder 75k/200k, utility 10k per pip', JSON.stringify(D.STATION_RENT) === '[75000,200000]' && JSON.stringify(D.UTILITY_PER_PIP) === '[10000,10000]');
    check('building stock scaled to ten streets', D.DUPLEX_SUPPLY === 16 && D.MANSION_SUPPLY === 6);
  }

  // ---------------------------------------------------------------- B2 ---
  console.log('B2: Owambe pot accrues from tax, landing with a big pot opens a Rush; first tap wins once');
  {
    const g = await makeGame(CLASSIC, ['Ada', 'Bola', 'Chidi']);
    const t = g.turn();
    g.hook('test_set_pot', { amount: 0 });
    g.hook('test_set_position', { playerId: t.playerId, space: 1 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    await sleep(150);
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'tax', 'tax choice');
    t.send('tax_choice', { choice: 'flat' });
    await g.host.waitFor((s) => s.pot === 200000, 'tax into the pot');
    check('FIRS flat tax lands in the Owambe pot', g.S().pot === 200000);
    t.send('end_turn', {});
    await g.host.waitFor((s) => s.turnPlayerId !== t.playerId, 'turn passes');
    const u = g.turn();
    g.hook('test_set_position', { playerId: u.playerId, space: 7 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    await sleep(150);
    u.send('roll', {});
    await g.host.waitFor((s) => s.owambe && s.owambe.state === 'coming', 'rush coming');
    check('landing on Owambe with the pot at 200k opens a Rush in COMING state', g.S().owambe.state === 'coming' && g.S().pot === 200000);
    const rushId = g.S().owambe.id;
    // A player drops and comes back during COMING: the rush is still there.
    const other = g.clients.find((c) => c.playerId !== u.playerId && c !== g.host) || g.clients[1];
    other.ws.close();
    await sleep(200);
    const back = await reconnect(g, other);
    check('a reconnecting player sees the live rush', back.state.owambe && back.state.owambe.id === rushId);
    back.send('owambe_grab', { rushId });
    await sleep(250);
    check('an early tap is refused and moves no money', back.errors.some((m) => /Wait for GRAB/i.test(m)) && g.S().pot === 200000);
    await g.host.waitFor((s) => s.owambe && s.owambe.state === 'open', 'rush open', 5000);
    const cash0 = {}; for (const p of g.S().players) cash0[p.id] = p.cash;
    for (const c of g.clients) c.send('owambe_grab', { rushId });
    await g.host.waitFor((s) => !s.owambe && s.owambeResult && s.owambeResult.id === rushId, 'rush settled');
    await sleep(300);
    const winners = g.S().players.filter((p) => p.cash === cash0[p.id] + 200000);
    const res = g.S().owambeResult;
    check('simultaneous taps: exactly one winner gets the whole pot', winners.length === 1 && res.winnerId === winners[0].id && res.amount === 200000);
    check('the pot is empty after the grab', g.S().pot === 0);
    check('nobody else gained or lost cash', g.S().players.every((p) => p.id === res.winnerId || p.cash === cash0[p.id]));
    check('the losing taps were told the rush closed', g.clients.filter((c) => c.playerId !== res.winnerId).every((c) => c.errors.some((m) => /close/i.test(m))));
    const n = g.S().feed.filter((e) => e.kind === 'jackpot' && e.rushId === rushId).length;
    check('one jackpot feed entry for the rush', n === 1, 'n=' + n);
    // A stale grab after reconnect never pays twice.
    const re = await reconnect(g, g.byId(res.winnerId));
    const before = g.player(res.winnerId).cash;
    re.send('owambe_grab', { rushId });
    await sleep(300);
    check('a replayed grab after reconnect pays nothing', g.player(res.winnerId).cash === before && re.errors.some((m) => /close/i.test(m)));
    check('the turn carried on after the rush', g.S().status === 'playing' && ['end', 'roll'].includes(g.S().phase));
    for (const c of g.clients) c.ws.close();
  }

  // ---------------------------------------------------------------- B3 ---
  console.log('B3: an unclaimed Rush rolls over; a pot past 500k opens a Rush by itself');
  {
    const g = await makeGame(CLASSIC, ['Ada', 'Bola', 'Chidi']);
    g.hook('test_set_pot', { amount: 120000 });
    g.hook('test_owambe_rush', {});
    await g.host.waitFor((s) => s.owambe && s.owambe.state === 'open', 'rush open', 5000);
    await g.host.waitFor((s) => !s.owambe, 'rush closes unclaimed', 6000);
    check('unclaimed rush: no winner, pot rolls over intact', g.S().owambeResult && g.S().owambeResult.winnerId === null && g.S().pot === 120000);
    g.hook('test_set_pot', { amount: 600000 });
    // the overflow trigger has a cooldown after an unclaimed rush in live
    // play; KP_TEST skips that wait so the auto path is visible here.
    await g.host.waitFor((s) => s.owambe && s.owambe.reason === 'overflow', 'auto rush', 70000);
    check('a pot past 500k opens an overflow Rush with no landing', g.S().owambe.reason === 'overflow');
    for (const c of g.clients) c.ws.close();
  }

  // ---------------------------------------------------------------- B4 ---
  console.log('B4: a missed turn charges 25,000 into the pot and skips; reconnect sees the toast data');
  {
    const g = await makeGame({ gameMode: 'classic', timed: false, turnTimerSec: 60 }, ['Ada', 'Bola', 'Chidi']);
    const t = g.turn();
    g.hook('test_set_pot', { amount: 0 });
    await sleep(100);
    const c0 = g.player(t.playerId).cash;
    const pos0 = g.player(t.playerId).position;
    g.hook('test_deadline_in', { seconds: 1 });
    await g.host.waitFor((s) => s.turnPlayerId !== t.playerId, 'turn skipped', 9000);
    const s = g.S();
    check('the stalled player paid the 25,000 missed turn fee', g.player(t.playerId).cash === c0 - 25000, 'cash=' + g.player(t.playerId).cash);
    check('the fee went into the Owambe pot', s.pot === 25000);
    check('the turn was skipped: no roll, no move', g.player(t.playerId).position === pos0);
    check('missedTurn names the player and the fee', s.missedTurn && s.missedTurn.playerId === t.playerId && s.missedTurn.fee === 25000 && s.missedTurnFee === 25000);
    check('the feed confesses the auto skip with the timer reason', s.feed.some((e) => e.kind === 'timeout' && e.auto && e.missed));
    check('the next player holds a live roll, no soft lock', s.phase === 'roll' && s.status === 'playing');
    const back = await reconnect(g, t);
    check('a reconnect after the skip sees the same missedTurn record', back.state.missedTurn && back.state.missedTurn.at === s.missedTurn.at);
    // A broke player is never pushed into debt by the fee.
    const n = g.turn();
    g.hook('test_set_cash', { playerId: n.playerId, amount: 10000 });
    await sleep(100);
    g.hook('test_deadline_in', { seconds: 1 });
    await g.host.waitFor((x) => x.turnPlayerId !== n.playerId, 'second skip', 9000);
    check('the fee caps at the cash in hand and never opens a debt', g.player(n.playerId).cash === 0 && !g.S().debt && g.S().missedTurn.fee === 10000);
    for (const c of g.clients) c.ws.close();
  }

  // ---------------------------------------------------------------- B5 ---
  console.log('B5: Sapa Deals while a player raises money: accept settles the debt, exactly once');
  {
    const g = await makeGame(CLASSIC, ['Ada', 'Bola', 'Chidi']);
    const debtor = g.turn();
    const owner = g.clients.find((c) => c.playerId !== debtor.playerId);
    const third = g.clients.find((c) => c !== debtor && c !== owner);
    await makeDebt(g, debtor, owner, 10000);
    check('the debtor is marked as raising money', g.S().debt.playerId === debtor.playerId && g.S().debt.amount > 0);
    debtor.send('sapa_offer', { to: debtor.playerId, spaces: [1], cash: 100000 });
    await sleep(200);
    check('the debtor cannot offer to themself', !g.S().sapaOffer);
    third.send('sapa_offer', { to: debtor.playerId, spaces: [7], cash: 100000 });
    await sleep(200);
    check('an offer for a deed the debtor does not own is refused', !g.S().sapaOffer && third.errors.length > 0);
    const tc0 = g.player(third.playerId).cash, dc0 = g.player(debtor.playerId).cash, oc0 = g.player(owner.playerId).cash;
    const owed = g.S().debt.amount;
    third.send('sapa_offer', { to: debtor.playerId, spaces: [1, 3], cash: 150000 });
    await g.host.waitFor((s) => !!s.sapaOffer, 'offer open');
    check('the offer is public with a short timer', g.S().sapaOffer.from === third.playerId && g.S().sapaOffer.endsAt - Date.now() <= 3500);
    owner.send('sapa_offer', { to: debtor.playerId, spaces: [1], cash: 50000 });
    await sleep(200);
    check('one Sapa Deal at a time', g.S().sapaOffer.from === third.playerId && owner.errors.some((m) => /already/i.test(m)));
    const oid = g.S().sapaOffer.id;
    owner.send('sapa_answer', { offerId: oid, accept: true });
    await sleep(150);
    check('only the debtor can answer', !!g.S().sapaOffer);
    debtor.send('sapa_answer', { offerId: oid, accept: true });
    debtor.send('sapa_answer', { offerId: oid, accept: true });
    await g.host.waitFor((s) => !s.sapaOffer && s.sapaResult && s.sapaResult.outcome === 'accepted', 'accepted');
    await g.host.waitFor((s) => !s.debt, 'debt settled');
    check('the deeds moved to the buyer', g.S().props[1].o === third.playerId && g.S().props[3].o === third.playerId);
    check('the buyer paid 150,000 exactly once', g.player(third.playerId).cash === tc0 - 150000);
    check('the debt was paid from the deal money', g.player(owner.playerId).cash === oc0 + owed && g.player(debtor.playerId).cash === dc0 + 150000 - owed);
    for (const c of g.clients) c.ws.close();
  }

  // ---------------------------------------------------------------- B6 ---
  console.log('B6: Sapa Deals decline and timeout leave the normal raise or bankrupt path');
  {
    const g = await makeGame(CLASSIC, ['Ada', 'Bola', 'Chidi']);
    const debtor = g.turn();
    const owner = g.clients.find((c) => c.playerId !== debtor.playerId);
    const third = g.clients.find((c) => c !== debtor && c !== owner);
    await makeDebt(g, debtor, owner, 10000);
    const tc0 = g.player(third.playerId).cash;
    third.send('sapa_offer', { to: debtor.playerId, spaces: [1], cash: 60000 });
    await g.host.waitFor((s) => !!s.sapaOffer, 'offer open');
    debtor.send('sapa_answer', { offerId: g.S().sapaOffer.id, accept: false });
    await g.host.waitFor((s) => !s.sapaOffer && s.sapaResult && s.sapaResult.outcome === 'declined', 'declined');
    check('decline: no money and no deed moved, the debt stays open', g.player(third.playerId).cash === tc0 && g.S().props[1].o === debtor.playerId && !!g.S().debt);
    third.send('sapa_offer', { to: debtor.playerId, spaces: [1], cash: 60000 });
    await g.host.waitFor((s) => !!s.sapaOffer, 'second offer open');
    // the debtor drops and returns while the offer runs
    debtor.ws.close();
    await sleep(200);
    const back = await reconnect(g, debtor);
    check('a reconnecting debtor sees the live offer', back.state.sapaOffer && back.state.sapaOffer.to === debtor.playerId);
    await g.host.waitFor((s) => !s.sapaOffer && s.sapaResult && s.sapaResult.outcome === 'timeout', 'timeout', 8000);
    check('timeout: the offer lapses with nothing moved, the debt remains', g.player(third.playerId).cash === tc0 && g.S().props[1].o === debtor.playerId && !!g.S().debt);
    third.send('sapa_offer', { to: debtor.playerId, spaces: [1], cash: 60000 });
    await g.host.waitFor((s) => !!s.sapaOffer, 'third offer open');
    await g.host.waitFor((s) => !s.sapaOffer, 'third lapses', 8000);
    third.send('sapa_offer', { to: debtor.playerId, spaces: [1], cash: 60000 });
    await sleep(250);
    check('an offerer gets at most 3 Sapa Deals per debt', !g.S().sapaOffer && third.errors.some((m) => /3 Sapa Deals/.test(m)));
    back.send('declare_bankruptcy', {});
    await g.host.waitFor((s) => !s.debt, 'bankruptcy path still works');
    check('the normal bankruptcy path still closes the debt', g.player(debtor.playerId).bankrupt === true);
    for (const c of g.clients) c.ws.close();
  }

  // ---------------------------------------------------------------- B7 ---
  console.log('B7: Hustle settles exactly once across a target reconnect');
  {
    const g = await makeGame({ gameMode: 'inflation', preset: 'standard', timed: false, turnTimerSec: 0 }, ['Ada', 'Bola', 'Chidi']);
    const atk = g.turn();
    const tgt = g.clients.find((c) => c.playerId !== atk.playerId);
    g.hook('test_set_cash', { playerId: atk.playerId, amount: 500000 });
    g.hook('test_set_cash', { playerId: tgt.playerId, amount: 1000000 });
    await sleep(150);
    g.hook('test_hustle_rolls', { rolls: [0.5] });
    atk.send('hustle_start', { targetId: tgt.playerId });
    await atk.waitFor((s) => !!s.hustle, 'hustle opens');
    const hid = g.S().hustle.id;
    tgt.ws.close();
    await sleep(200);
    const back = await reconnect(g, tgt);
    check('the target sees the open hustle after reconnect', back.state.hustle && back.state.hustle.id === hid);
    back.send('hustle_defend', { hustleId: hid, defend: false });
    back.send('hustle_defend', { hustleId: hid, defend: false });
    await g.host.waitFor((s) => !s.hustle && s.hustleResult && s.hustleResult.id === hid, 'hustle resolved');
    await sleep(300);
    check('one settlement: the attacker gained 120,000 once', g.player(atk.playerId).cash === 620000 && g.player(tgt.playerId).cash === 880000,
      'atk=' + g.player(atk.playerId).cash + ' tgt=' + g.player(tgt.playerId).cash);
    for (const c of g.clients) c.ws.close();
  }

  // ---------------------------------------------------------------- B8 ---
  console.log('B8: an old 40 space snapshot migrates onto the 20 space board');
  {
    const host = createGameHost({ test: true });
    const sent = [];
    const fake = new EventEmitter();
    fake.readyState = 1;
    fake.send = (d) => sent.push(JSON.parse(d));
    fake.close = () => { fake.readyState = 3; fake.emit('close'); };
    host.handleConnection(fake);
    const say = (o) => fake.emit('message', JSON.stringify(o));
    say({ type: 'create_room', name: 'Ada', token: 'danfo', mode: 'pass', settings: CLASSIC });
    say({ type: 'add_local_player', name: 'Bola', token: 'keke' });
    say({ type: 'start_game' });
    const snap = JSON.parse(JSON.stringify(host.exportState()));
    const code = Object.keys(snap.rooms)[0];
    const room = snap.rooms[code];
    room.status = 'playing';
    const [a, b] = room.players;
    delete room.boardSize;
    room.props = {};
    room.props[39] = { owner: a.id, mortgaged: false, buildings: 0, mansionLap: -1, pledged: null }; // Banana Island
    room.props[37] = { owner: a.id, mortgaged: false, buildings: 2, mansionLap: -1, pledged: null }; // Parkview: gone
    room.props[9] = { owner: b.id, mortgaged: true, buildings: 0, mansionLap: -1, pledged: null };   // Agege: gone
    room.props[27] = { owner: b.id, mortgaged: false, buildings: 0, mansionLap: -1, pledged: null }; // Victoria Island
    a.position = 39; b.position = 30;
    const ca = a.cash, cb = b.cash;
    host.importState(snap);
    const after = JSON.parse(JSON.stringify(host.exportState())).rooms[code];
    const A = after.players.find((p) => p.id === a.id), B = after.players.find((p) => p.id === b.id);
    check('Banana Island keeps its owner at its new index 19', after.props[19].owner === a.id);
    check('Victoria Island keeps its owner at its new index 16', after.props[16].owner === b.id);
    check('a vanished deed is refunded at the old price plus buildings', A.cash === ca + 350000 + 2 * 200000, 'cash=' + A.cash);
    check('a vanished mortgaged deed refunds half', B.cash === cb + 60000, 'cash=' + B.cash);
    check('positions map by name; a free player never rests on Go to Kirikiri', A.position === 19 && B.position === 16);
    check('the room is stamped as a 20 space board', after.boardSize === 20);
    check('no prop sits outside the board', Object.keys(after.props).every((k) => Number(k) < 20));
  }

  console.log('B9: a board28 snapshot (28 spaces) migrates onto the 20 space board');
  {
    const host = createGameHost({ test: true });
    const fake = new EventEmitter();
    fake.readyState = 1;
    fake.send = () => {};
    fake.close = () => { fake.readyState = 3; fake.emit('close'); };
    host.handleConnection(fake);
    const say = (o) => fake.emit('message', JSON.stringify(o));
    say({ type: 'create_room', name: 'Ada', token: 'danfo', mode: 'pass', settings: CLASSIC });
    say({ type: 'add_local_player', name: 'Bola', token: 'keke' });
    say({ type: 'start_game' });
    const snap = JSON.parse(JSON.stringify(host.exportState()));
    const code = Object.keys(snap.rooms)[0];
    const room = snap.rooms[code];
    room.status = 'playing';
    const [a, b] = room.players;
    room.boardSize = 28;
    room.props = {};
    room.props[27] = { owner: a.id, mortgaged: false, buildings: 0, mansionLap: -1, pledged: null }; // Banana Island
    room.props[24] = { owner: a.id, mortgaged: true, buildings: 0, mansionLap: -1, pledged: null };  // Ikoyi: gone
    room.props[22] = { owner: b.id, mortgaged: false, buildings: 0, mansionLap: -1, pledged: null }; // Eko Hotel
    room.props[13] = { owner: b.id, mortgaged: false, buildings: 0, mansionLap: -1, pledged: null }; // Allen Avenue: gone
    room.props[12] = { owner: b.id, mortgaged: false, buildings: 0, mansionLap: -1, pledged: null }; // Lekki Tollgate
    a.position = 24; b.position = 21; b.inJail = false;
    const ca = a.cash, cb = b.cash;
    host.importState(snap);
    const after = JSON.parse(JSON.stringify(host.exportState())).rooms[code];
    const A = after.players.find((p) => p.id === a.id), B = after.players.find((p) => p.id === b.id);
    check('board28 deeds move by name: Banana Island 19, Eko Hotel 17, Lekki Tollgate 7',
      after.props[19].owner === a.id && after.props[17].owner === b.id && after.props[7].owner === b.id);
    check('a vanished mortgaged board28 deed (Ikoyi) refunds half its old price', A.cash === ca + 230000, 'cash=' + A.cash);
    check('a vanished board28 deed (Allen Avenue) refunds its old price', B.cash === cb + 280000, 'cash=' + B.cash);
    check('positions: a vanished space maps proportionally, Go to Kirikiri steps off the corner', A.position === 17 && B.position === 16, 'A=' + A.position + ' B=' + B.position);
    check('the board28 room is stamped as a 20 space board', after.boardSize === 20 && Object.keys(after.props).every((k) => Number(k) < 20));
  }
} catch (err) {
  failures += 1;
  console.log('SUITE ERROR: ' + err.message + '\n' + err.stack);
} finally {
  server.kill();
}
console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
