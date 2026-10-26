// KOLOPOLY protocol-level engine tests. Spawns the server with KP_TEST=1 and
// plays scripted games over WebSocket. Run: node test-engine.mjs
// Exit code 0 means every check passed.
import WebSocket from 'ws';
import { spawn } from 'child_process';

const PORT = 4199;
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
// A turn that changes nothing: stand on 17, roll 3, land on Owambe Grounds (pot usually 0), end.
// Hardened: first wait for a genuinely actionable turn state, so a stale
// pre-end_turn snapshot can never make us act for the wrong player.
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
  // Every client passes; finishes the auction whether or not there is a high bidder.
  for (let round = 0; round < 3 && g.S().auction; round++) {
    for (const c of g.clients) c.send('pass_bid', {});
    await sleep(250);
  }
  await g.host.waitFor((s) => !s.auction, 'auction closed', 9000);
}

// ---------------------------------------------------------------------------
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), KP_TEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); }));
console.log('server up on ' + PORT);

try {
  // ------------------------------------------------------------- CLASSIC ---
  console.log('C1: starting cash, Salary Alert on passing START, buy at list price');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    check('both players start with ₦1,500,000', g.S().players.every((p) => p.cash === 1500000));
    const t = g.turn();
    const tid = t.playerId;
    g.hook('test_set_position', { playerId: tid, space: 38 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'buy' && s.buySpace === 1, 'landed Makoko with buy offer');
    check('salary paid on the wrap: cash ₦1,700,000 before buying', g.player(tid).cash === 1700000, 'cash=' + g.player(tid).cash);
    check('feed carries a Salary Alert credit of ₦200,000', g.S().feed.some((e) => e.kind === 'credit' && e.amount === 200000 && e.text.includes('Salary alert')));
    t.send('buy', {});
    await t.waitFor((s) => s.props[1].o === tid, 'Makoko bought');
    check('buy at list price ₦60,000: cash ₦1,640,000', g.player(tid).cash === 1640000, 'cash=' + g.player(tid).cash);
    for (const c of g.clients) c.ws.close();
  }

  console.log('C2: declined purchase auctions to the highest bidder inside the clock');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_set_position', { playerId: t.playerId, space: 0 });
    g.hook('test_dice', { rolls: [[2, 3]] });
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'buy' && s.buySpace === 5, 'Iddo offered');
    t.send('decline', {});
    await t.waitFor((s) => !!s.auction, 'auction opened');
    o.send('bid', { amount: 80000 });
    await o.waitFor((s) => s.auction && s.auction.highBid === 80000, 'bid registered');
    t.send('pass_bid', {});
    await g.host.waitFor((s) => !s.auction && s.props[5].o === o.playerId, 'auction won by bidder');
    check('deed went to the highest bidder, not the lander', g.S().props[5].o === o.playerId);
    check('winner paid the bid ₦80,000, not the ₦200,000 list price', g.player(o.playerId).cash === 1420000, 'cash=' + g.player(o.playerId).cash);
    for (const c of g.clients) c.ws.close();
  }

  console.log('C3: set doubling, even building enforced, duplex ladder rent');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const first = g.turn();
    const other = g.clients.find((c) => c !== first);
    for (const sp of [11, 13, 14]) g.hook('test_give', { playerId: other.playerId, space: sp });
    await nullTurn(g); // first player passes the turn
    const b = g.turn();
    check('builder is the pink set owner', b.playerId === other.playerId);
    const cash0 = g.player(b.playerId).cash;
    b.send('build', { space: 11, kind: 'duplex' });
    await b.waitFor((s) => s.props[11].b === 1, 'first duplex built');
    check('duplex cost the printed ₦100,000', g.player(b.playerId).cash === cash0 - 100000);
    const errBefore = b.errors.length;
    b.send('build', { space: 11, kind: 'duplex' });
    await sleep(350);
    check('even building enforced: second duplex on the same street refused', g.S().props[11].b === 1 && b.errors.length > errBefore, 'errors=' + b.errors.slice(-1));
    b.send('build', { space: 13, kind: 'duplex' });
    await b.waitFor((s) => s.props[13].b === 1, 'Yaba duplex');
    b.send('build', { space: 14, kind: 'duplex' });
    await b.waitFor((s) => s.props[14].b === 1, 'Surulere duplex');
    // builder rolls a null turn away
    g.hook('test_set_position', { playerId: b.playerId, space: 17 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    b.send('roll', {});
    await b.waitFor((s) => s.phase === 'end', 'builder turn ends');
    b.send('end_turn', {});
    await g.host.waitFor((s) => s.turnPlayerId === first.playerId, 'turn back to first');
    const aCash = g.player(first.playerId).cash;
    const bCash = g.player(b.playerId).cash;
    g.hook('test_set_position', { playerId: first.playerId, space: 9 });
    g.hook('test_dice', { rolls: [[1, 1], [1, 2]] });
    first.send('roll', {});
    await first.waitFor((s) => s.players.find((p) => p.id === b.playerId).cash === bCash + 50000, 'duplex rent landed');
    check('1 duplex ladder rent ₦50,000 moved exactly', g.player(first.playerId).cash === aCash - 50000 && g.player(b.playerId).cash === bCash + 50000,
      'a=' + g.player(first.playerId).cash + ' b=' + g.player(b.playerId).cash);
    for (const c of g.clients) c.ws.close();
  }

  console.log('C4: mortgage halves, rent stops, unmortgage at +10 percent exact');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const first = g.turn();
    const other = g.clients.find((c) => c !== first);
    g.hook('test_give', { playerId: other.playerId, space: 13 }); // Yaba ₦140,000
    if (g.S().turnPlayerId !== other.playerId) await nullTurn(g);
    const b = g.turn();
    const cash0 = g.player(b.playerId).cash;
    b.send('mortgage', { space: 13 });
    await b.waitFor((s) => s.props[13].m === 1, 'Yaba mortgaged');
    check('mortgage paid half the price: +₦70,000', g.player(b.playerId).cash === cash0 + 70000);
    // renter lands on the mortgaged deed
    g.hook('test_set_position', { playerId: b.playerId, space: 17 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    b.send('roll', {});
    await b.waitFor((s) => s.phase === 'end', 'owner turn ends');
    b.send('end_turn', {});
    await g.host.waitFor((s) => s.turnPlayerId === first.playerId, 'renter turn');
    const rCash = g.player(first.playerId).cash;
    g.hook('test_set_position', { playerId: first.playerId, space: 10 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    first.send('roll', {});
    await first.waitFor((s) => s.phase === 'end', 'landed mortgaged Yaba');
    check('no rent on a mortgaged deed', g.player(first.playerId).cash === rCash);
    first.send('end_turn', {});
    await g.host.waitFor((s) => s.turnPlayerId === b.playerId, 'owner turn again');
    const cash1 = g.player(b.playerId).cash;
    b.send('unmortgage', { space: 13 });
    await b.waitFor((s) => s.props[13].m === 0, 'mortgage lifted');
    check('unmortgage cost exactly ₦77,000 (70,000 + 10 percent)', g.player(b.playerId).cash === cash1 - 77000, 'cash=' + g.player(b.playerId).cash);
    for (const c of g.clients) c.ws.close();
  }

  console.log('C5: Kirikiri flows: bail, doubles out, third fail pays and moves, three doubles in');
  {
    // (a) bail
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const t = g.turn();
    g.hook('test_set_position', { playerId: t.playerId, space: 28 });
    g.hook('test_dice', { rolls: [[1, 1]] });
    t.send('roll', {});
    await t.waitFor((s) => s.players.find((p) => p.id === t.playerId).inJail, 'sent to Kirikiri');
    check('go to Kirikiri lands the player inside at space 10', g.player(t.playerId).position === 10);
    t.send('end_turn', {});
    await nullTurn(g);
    const cash0 = g.player(t.playerId).cash;
    t.send('jail_pay', {});
    await t.waitFor((s) => !s.players.find((p) => p.id === t.playerId).inJail && s.phase === 'roll', 'bailed out');
    check('bail cost ₦50,000 and entered the Owambe pot', g.player(t.playerId).cash === cash0 - 50000 && g.S().pot === 50000, 'pot=' + g.S().pot);
    for (const c of g.clients) c.ws.close();
  }
  {
    // (b) doubles out
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const t = g.turn();
    g.hook('test_set_position', { playerId: t.playerId, space: 28 });
    g.hook('test_dice', { rolls: [[1, 1]] });
    t.send('roll', {});
    await t.waitFor((s) => s.players.find((p) => p.id === t.playerId).inJail, 'in Kirikiri');
    t.send('end_turn', {});
    await nullTurn(g);
    g.hook('test_dice', { rolls: [[3, 3]] });
    t.send('jail_roll', {});
    await t.waitFor((s) => !s.players.find((p) => p.id === t.playerId).inJail, 'doubles freed the player');
    check('doubles out of Kirikiri, moved 6 to Maryland', g.player(t.playerId).position === 16);
    for (const c of g.clients) c.ws.close();
  }
  {
    // (c) third failed roll pays and moves
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const t = g.turn();
    g.hook('test_set_position', { playerId: t.playerId, space: 28 });
    g.hook('test_dice', { rolls: [[1, 1]] });
    t.send('roll', {});
    await t.waitFor((s) => s.players.find((p) => p.id === t.playerId).inJail, 'in Kirikiri');
    t.send('end_turn', {});
    const cash0 = g.player(t.playerId).cash;
    for (const attempt of [[1, 2], [2, 3]]) {
      await nullTurn(g);
      g.hook('test_dice', { rolls: [attempt] });
      t.send('jail_roll', {});
      await t.waitFor((s) => s.phase === 'end', 'failed attempt ends turn');
      t.send('end_turn', {});
    }
    await nullTurn(g);
    g.hook('test_dice', { rolls: [[1, 3]] });
    t.send('jail_roll', {});
    await t.waitFor((s) => !s.players.find((p) => p.id === t.playerId).inJail, 'third fail forces bail and move');
    check('third fail paid ₦50,000 and moved the rolled 4 to Surulere', g.player(t.playerId).cash === cash0 - 50000 && g.player(t.playerId).position === 14,
      'cash=' + g.player(t.playerId).cash + ' pos=' + g.player(t.playerId).position);
    for (const c of g.clients) c.ws.close();
  }
  {
    // (d) three doubles in a row sends you in
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_set_position', { playerId: t.playerId, space: 0 });
    g.hook('test_dice', { rolls: [[6, 6]] });
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'buy' && s.buySpace === 12, 'NEPA offered');
    t.send('buy', {});
    await t.waitFor((s) => s.phase === 'roll', 'double: roll again');
    g.hook('test_dice', { rolls: [[6, 6]] });
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'buy' && s.buySpace === 24, 'GRA offered');
    t.send('decline', {});
    await t.waitFor((s) => !!s.auction, 'auction for GRA');
    await passAuction(g);
    await t.waitFor((s) => s.phase === 'roll' && s.turnPlayerId === t.playerId, 'second double: roll again');
    g.hook('test_dice', { rolls: [[1, 1]] });
    t.send('roll', {});
    await t.waitFor((s) => s.players.find((p) => p.id === t.playerId).inJail, 'three doubles: Kirikiri');
    check('three doubles in a row sends the player to Kirikiri', g.player(t.playerId).position === 10);
    for (const c of g.clients) c.ws.close();
  }

  console.log('C6: Owambe jackpot grows only from taxes, fines and fees; pays in full on landing');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_give', { playerId: o.playerId, space: 1 }); // Makoko to the other
    g.hook('test_set_position', { playerId: t.playerId, space: 39 });
    g.hook('test_dice', { rolls: [[1, 1], [1, 2]] });
    t.send('roll', {});
    await t.waitFor((s) => s.players.find((p) => p.id === o.playerId).cash === 1502000, 'rent paid on Makoko, doubles continue');
    check('rent does NOT feed the pot', g.S().pot === 0 && g.player(o.playerId).cash === 1502000, 'pot=' + g.S().pot);
    g.hook('test_set_position', { playerId: t.playerId, space: 1 });
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'tax', 'FIRS tax choice');
    t.send('tax_choice', { choice: 'flat' });
    await t.waitFor((s) => s.pot === 200000, 'tax fed the pot');
    check('FIRS flat tax ₦200,000 entered the pot in full', g.S().pot === 200000);
    t.send('end_turn', {});
    await g.host.waitFor((s) => s.turnPlayerId === o.playerId, 'collector turn');
    const cash0 = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: o.playerId, space: 17 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    o.send('roll', {});
    await o.waitFor((s) => s.pot === 0, 'pot collected');
    check('landing on Owambe Grounds paid the full pot', g.player(o.playerId).cash === cash0 + 200000);
    check('jackpot feed entry carries the ₦200,000', g.S().feed.some((e) => e.kind === 'jackpot' && e.amount === 200000));
    for (const c of g.clients) c.ws.close();
  }

  console.log('C7: bankruptcy hands everything to the creditor; last solvent wins the game');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    for (const sp of [5, 15, 25, 35]) g.hook('test_give', { playerId: o.playerId, space: sp });
    g.hook('test_give', { playerId: t.playerId, space: 3 });
    g.hook('test_set_cash', { playerId: t.playerId, amount: 10000 });
    await sleep(200);
    const oCash = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: t.playerId, space: 0 });
    g.hook('test_dice', { rolls: [[2, 3]] });
    t.send('roll', {});
    await g.host.waitFor((s) => s.status === 'ended', 'game ended by bankruptcy', 9000);
    check('bankrupt player flagged', g.player(t.playerId).bankrupt === true);
    check('creditor received the bankrupt deed (Ajegunle)', g.S().props[3].o === o.playerId);
    check('creditor received the bankrupt cash ₦10,000', g.player(o.playerId).cash === oCash + 10000, 'cash=' + g.player(o.playerId).cash);
    check('winner is the last solvent player', g.S().winner && g.S().winner.playerId === o.playerId);
    for (const c of g.clients) c.ws.close();
  }

  console.log('C8: timed mode ends at the horn, richest net worth wins');
  {
    const g = await makeGame({ timed: true, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_give', { playerId: o.playerId, space: 39 });
    g.hook('test_clock', { secondsLeft: 1 });
    await g.host.waitFor((s) => s.status === 'ended', 'horn ended the game', 9000);
    check('richest by net worth won at the horn (deed owner)', g.S().winner && g.S().winner.playerId === o.playerId);
    for (const c of g.clients) c.ws.close();
  }

  console.log('C9: utility rent is dice total x ₦1,000 x 4');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_give', { playerId: o.playerId, space: 12 });
    const tCash = g.player(t.playerId).cash;
    const oCash = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: t.playerId, space: 9 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'end', 'utility rent resolved');
    check('NEPA rent 3 x ₦1,000 x 4 = ₦12,000', g.player(t.playerId).cash === tCash - 12000 && g.player(o.playerId).cash === oCash + 12000);
    for (const c of g.clients) c.ws.close();
  }

  console.log('C10: set ownership doubles the site rent');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_give', { playerId: o.playerId, space: 1 });
    g.hook('test_give', { playerId: o.playerId, space: 3 }); // full brown set
    const oCash = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: t.playerId, space: 38 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    t.send('roll', {});
    await t.waitFor((s) => s.players.find((p) => p.id === o.playerId).cash === oCash + 4000, 'set rent landed');
    check('Makoko site rent ₦2,000 doubled to ₦4,000 with the full set', g.player(o.playerId).cash === oCash + 4000);
    for (const c of g.clients) c.ws.close();
  }

  // ----------------------------------------------------------- INFLATION ---
  console.log('I1: phase transition changes salary, rent formula and build cost (owner rule: printed x die)');
  {
    const g = await makeGame({ gameMode: 'inflation', preset: 'standard', timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    check('Inflation opens at Phase 1 with salary ₦200,000', g.S().inf && g.S().inf.phase === 1 && g.S().inf.salary === 200000);
    g.hook('test_phase', { phase: 2 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'phase 2 begins');
    check('Phase 2 salary decays to ₦100,000', g.S().inf.salary === 100000);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_give', { playerId: o.playerId, space: 13 }); // Yaba, site rent ₦10,000
    const tCash = g.player(t.playerId).cash;
    const oCash = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: t.playerId, space: 9 });
    g.hook('test_dice', { rolls: [[2, 2], [1, 2]] });
    t.send('roll', {});
    await t.waitFor((s) => s.players.find((p) => p.id === o.playerId).cash === oCash + 20000, 'Phase 2 rent landed');
    check('Phase 2 rent = printed ₦10,000 x lowest die 2 = ₦20,000', g.player(t.playerId).cash === tCash - 20000 && g.player(o.playerId).cash === oCash + 20000,
      't=' + g.player(t.playerId).cash + ' o=' + g.player(o.playerId).cash);
    check('rent alert names the multiplier', g.S().feed.some((e) => e.text.includes('x 2 (your roll)')));
    // finish the turn, then salary at Phase 2 for the other player
    g.hook('test_set_position', { playerId: t.playerId, space: 17 });
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'end', 'turn ends');
    t.send('end_turn', {});
    await g.host.waitFor((s) => s.turnPlayerId === o.playerId, 'other turn');
    const oCash2 = g.player(o.playerId).cash;
    g.hook('test_set_position', { playerId: o.playerId, space: 38 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    o.send('roll', {});
    await o.waitFor((s) => s.phase === 'buy' && s.buySpace === 1, 'wrapped to Makoko');
    check('Phase 2 salary is ₦100,000 exactly on the START pass', g.player(o.playerId).cash === oCash2 + 100000, 'cash=' + g.player(o.playerId).cash);
    o.send('decline', {});
    await o.waitFor((s) => !!s.auction, 'auction');
    await passAuction(g);
    await o.waitFor((s) => s.phase === 'end', 'turn done');
    o.send('end_turn', {});
    // build cost: give the owner the full pink set, wait for their turn, build with a queued Builder's Roll
    for (const sp of [11, 14]) g.hook('test_give', { playerId: o.playerId, space: sp });
    await nullTurn(g); // t's turn passes
    const b = g.turn();
    check('builder turn reached', b.playerId === o.playerId);
    const bCash = g.player(b.playerId).cash;
    g.hook('test_dice', { rolls: [[3, 5]] });
    b.send('build', { space: 11, kind: 'duplex' });
    await b.waitFor((s) => s.props[11].b === 1, 'duplex built at Phase 2 price');
    check("Builder's Roll: cost = printed ₦100,000 x lowest die 3 = ₦300,000", g.player(b.playerId).cash === bCash - 300000, 'cash=' + g.player(b.playerId).cash);
    check('build stamp states the roll maths in public', g.S().feed.some((e) => e.text.includes('x 3 = ₦300,000')));
    for (const c of g.clients) c.ws.close();
  }

  console.log('I2: Phase 3 lander buy price = printed x bigger die');
  {
    const g = await makeGame({ gameMode: 'inflation', preset: 'standard', timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    g.hook('test_phase', { phase: 3 });
    await g.host.waitFor((s) => s.inf.phase === 3, 'phase 3');
    const t = g.turn();
    g.hook('test_set_position', { playerId: t.playerId, space: 24 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'buy' && s.buySpace === 27, 'landed Victoria Island');
    check('buyPrice = printed ₦260,000 x bigger die 2 = ₦520,000', g.S().buyPrice === 520000, 'buyPrice=' + g.S().buyPrice);
    const cash0 = g.player(t.playerId).cash;
    t.send('buy', {});
    await t.waitFor((s) => s.props[27].o === t.playerId, 'bought');
    check('lander paid the multiplied price', g.player(t.playerId).cash === cash0 - 520000);
    for (const c of g.clients) c.ws.close();
  }

  console.log('I3: a Passage contract blocks rent once and consumes the chip');
  {
    const g = await makeGame({ gameMode: 'inflation', preset: 'standard', timed: false, turnTimerSec: 0 }, ['Ada', 'Bola', 'Chidi']);
    const [pa, pb] = g.S().players;
    g.hook('test_give', { playerId: pa.id, space: 13 }); // Yaba to the first player
    const bCli = g.byId(pb.id);
    const aCli = g.byId(pa.id);
    const aCash = g.player(pa.id).cash;
    const bCash = g.player(pb.id).cash;
    bCli.send('call_deal_break', {});
    await bCli.waitFor((s) => !!s.inf.dealBreakEndsAt, 'deal break open');
    bCli.send('contract_propose', { kind: 'pass', street: 13, chips: 1, price: 10000 });
    await aCli.waitFor((s) => !!s.inf.proposal && s.inf.proposal.kind === 'pass', 'pass offered');
    aCli.send('contract_respond', { accept: true });
    await g.host.waitFor((s) => s.inf.contracts.length === 1 && s.inf.contracts[0].chipsLeft === 1, 'pass registered');
    check('pass registered: buyer paid ₦10,000, seller received it', g.player(pb.id).cash === bCash - 10000 && g.player(pa.id).cash === aCash + 10000);
    // walk turns until the pass holder moves, then land them on Yaba
    let guard = 0;
    while (g.S().turnPlayerId !== pb.id && guard++ < 5) await nullTurn(g);
    const bCash2 = g.player(pb.id).cash;
    const aCash2 = g.player(pa.id).cash;
    g.hook('test_set_position', { playerId: pb.id, space: 10 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    bCli.send('roll', {});
    await bCli.waitFor((s) => s.phase === 'end', 'pass landing resolved');
    check('pass blocked the rent: no cash moved to the owner', g.player(pb.id).cash === bCash2 && g.player(pa.id).cash === aCash2);
    check('the chip was consumed (contract spent)', g.S().inf.contracts.length === 0);
    check('feed announced the Pass use', g.S().feed.some((e) => e.kind === 'contract' && e.text.includes('Pass used')));
    for (const c of g.clients) c.ws.close();
  }

  console.log('I4: a collateral loan default transfers the pledged deed to the lender');
  {
    const g = await makeGame({ gameMode: 'inflation', preset: 'standard', timed: false, turnTimerSec: 0 }, ['Ada', 'Bola', 'Chidi']);
    g.hook('test_phase', { phase: 2 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'phase 2: loans unlocked');
    const [pa, pb] = g.S().players;
    const aCli = g.byId(pa.id);
    const bCli = g.byId(pb.id);
    g.hook('test_give', { playerId: pb.id, space: 14 }); // Surulere pledged
    const bCash = g.player(pb.id).cash;
    bCli.send('call_deal_break', {});
    await bCli.waitFor((s) => !!s.inf.dealBreakEndsAt, 'deal break open');
    bCli.send('contract_propose', { kind: 'loan', to: pa.id, pledgedSpace: 14, amount: 90000, interestPct: 10, termLaps: 1 });
    await aCli.waitFor((s) => !!s.inf.proposal && s.inf.proposal.kind === 'loan', 'loan offered');
    aCli.send('contract_respond', { accept: true });
    try {
      await g.host.waitFor((s) => s.inf.contracts.some((c) => c.type === 'loan') && s.props[14].pl === 1, 'loan live, deed pledged');
    } catch (e) {
      console.log('I4 DIAG:', JSON.stringify({
        contracts: g.S().inf.contracts, proposal: g.S().inf.proposal, props14: g.S().props[14],
        aErr: aCli.errors, bErr: bCli.errors, phase: g.S().inf.phase, dealBreak: !!g.S().inf.dealBreakEndsAt,
        pbCash: g.player(pb.id).cash, paCash: g.player(pa.id).cash
      }));
      throw e;
    }
    check('loan paid out ₦90,000 (inside the 80 percent cap on the ₦160,000 deed) and flagged the deed pledged', g.player(pb.id).cash === bCash + 90000 && g.S().props[14].pl === 1);
    const contractId = g.S().inf.contracts.find((c) => c.type === 'loan').id;
    // borrower passes START once: the term falls due
    let guard = 0;
    while (g.S().turnPlayerId !== pb.id && guard++ < 5) await nullTurn(g);
    g.hook('test_set_position', { playerId: pb.id, space: 39 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    bCli.send('roll', {});
    await aCli.waitFor((s) => !!s.inf.loanDecision, 'lender decision opened at due');
    const bCashDue = g.player(pb.id).cash;
    aCli.send('loan_decide', { contractId, choice: 'seize' });
    await g.host.waitFor((s) => s.props[14].o === pa.id, 'deed seized by lender');
    check('seizure transferred the pledged deed to the lender', g.S().props[14].o === pa.id && g.S().props[14].pl === 0);
    check('seizure is non recourse: borrower cash untouched by the seize', g.player(pb.id).cash === bCashDue);
    for (const c of g.clients) c.ws.close();
  }

  console.log('I5: phase timing via the accelerated clock; Phase 4 horn ends on net worth with the Real Table');
  {
    const g = await makeGame({ gameMode: 'inflation', preset: 'standard', timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    g.hook('test_phase_ends_in', { seconds: 1 });
    await g.host.waitFor((s) => s.inf.phase === 2, 'clock advanced the phase', 9000);
    check('phase advanced on the accelerated clock', g.S().inf.phase === 2);
    check('phase change announced in the feed', g.S().feed.some((e) => e.kind === 'phase'));
    const richer = g.clients.find((c) => c !== g.turn());
    g.hook('test_give', { playerId: richer.playerId, space: 39 });
    g.hook('test_phase', { phase: 4 });
    await g.host.waitFor((s) => s.inf.phase === 4, 'phase 4');
    g.hook('test_horn_in', { seconds: 1 });
    await g.host.waitFor((s) => s.status === 'ended', 'sudden death horn', 9000);
    check('Phase 4 horn crowned the richest net worth', g.S().winner && g.S().winner.playerId === richer.playerId);
    check('end table carries the Real Table (Phase 1 purchasing power)', g.S().endTable.every((r) => typeof r.realNetWorth === 'number'));
    check('end table carries generated lesson lines per player', g.S().endTable.every((r) => Array.isArray(r.lessons)));
    for (const c of g.clients) c.ws.close();
  }

  console.log('I6: Inflation bid cap = cash plus mortgage value of clean deeds (buildings excluded)');
  {
    const g = await makeGame({ gameMode: 'inflation', preset: 'standard', timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const t = g.turn();
    const o = g.clients.find((c) => c !== t);
    g.hook('test_set_position', { playerId: t.playerId, space: 0 });
    g.hook('test_dice', { rolls: [[2, 3]] });
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'buy' && s.buySpace === 5, 'Iddo offered');
    g.hook('test_set_cash', { playerId: o.playerId, amount: 50000 });
    await sleep(200);
    t.send('decline', {});
    await t.waitFor((s) => !!s.auction, 'auction open');
    const errBefore = o.errors.length;
    o.send('bid', { amount: 60000 });
    await sleep(400);
    check('bid above the cap refused with the raise limit stated', o.errors.length > errBefore && /fit raise/.test(o.errors[o.errors.length - 1]), 'err=' + o.errors.slice(-1));
    o.send('bid', { amount: 50000 });
    await o.waitFor((s) => s.auction && s.auction.highBid === 50000, 'bid at the cap accepted');
    t.send('pass_bid', {});
    await g.host.waitFor((s) => !s.auction && s.props[5].o === o.playerId, 'won at the cap');
    check('winner paid exactly their cap and took the deed', g.player(o.playerId).cash === 0);
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
