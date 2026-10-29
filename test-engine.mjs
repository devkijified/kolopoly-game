// KOLOPOLY protocol-level engine tests. Spawns the server with KP_TEST=1 and
// plays scripted games over WebSocket. Run: node test-engine.mjs
// Exit code 0 means every check passed.
import WebSocket from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = 4199;
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

// ---- Bot helpers -----------------------------------------------------------
// A room whose only human is the host; bots fill the other seats.
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
// Play the host seat honestly (Owambe turns, pass auctions, pay tax flat)
// until pred(state) holds. Used to give bots room to act.
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
async function botStats(g) {
  g.host.botStats = null;
  g.host.send('test_bot_stats', {});
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (g.host.botStats) return g.host.botStats; await sleep(80); }
  throw new Error('bot stats timeout');
}
// Script one bot turn: drive to a host end phase, load the bot's position,
// cash and dice, pass the turn, then wait (sequence gated) for the outcome.
// A lagging client state can make one setup cycle miss its turn, so the
// whole setup retries until the gated outcome lands.
async function scriptBotTurn(g, setup, gate, label, tries) {
  if (gate(g.S())) return;
  let lastErr = null;
  for (let t = 0; t < (tries || 4); t++) {
    await driveUntil(g, (s) => s.turnPlayerId === g.host.playerId && s.phase === 'end', label + ' (host end, try ' + (t + 1) + ')', 30000);
    if (gate(g.S())) return;
    const mark = g.S().messageSeq;
    if (setup.pos != null) g.hook('test_set_position', { playerId: setup.botId, space: setup.pos });
    if (setup.cash != null) g.hook('test_set_cash', { playerId: setup.botId, amount: setup.cash });
    if (setup.dice) g.hook('test_dice', { rolls: setup.dice });
    if (setup.card) g.hook('test_card', setup.card);
    g.host.send('end_turn', {});
    try {
      await g.host.waitFor((s) => s.messageSeq > mark && gate(s), label, 4500);
      return;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('scriptBotTurn failed: ' + label);
}

// ---------------------------------------------------------------------------
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), KP_TEST: '1', KP_RETENTION_FILE: RETENTION_FILE },
  stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); }));
console.log('server up on ' + PORT);

const HTTP = 'http://127.0.0.1:' + PORT;
async function api(method, urlPath, body) {
  const res = await fetch(HTTP + urlPath, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, json };
}
function voiceOk(payload) {
  const blob = ((payload.title || '') + ' ' + (payload.body || '')).toLowerCase();
  if (blob.includes('come play') || blob.includes('monopoly') || blob.includes('hasbro')) return false;
  return /dey|don|fit|wey/.test(payload.body || '');
}

try {
  // ----------------------------------------------------- RETURN RETENTION ---
  console.log('R1: daily market drop, once per Lagos day, shelf goods only');
  {
    const id = 'retention-walker-1';
    const bad = await api('POST', '/api/retention/claim', { clientId: 'short' });
    check('a short client id is refused', bad.status === 400);
    const badDay = await api('POST', '/api/retention/claim', { clientId: id, day: '2026-02-31' });
    check('an impossible test day is refused', badDay.status === 400);
    const first = await api('POST', '/api/retention/claim', { clientId: id, day: '2026-10-28' });
    check('first claim of the day pays the base shelf', first.status === 200 && first.json.ok && first.json.already === false && first.json.first === true
      && first.json.granted.cowries === 6 && first.json.granted.kola === 2 && first.json.granted.yams === 1 && first.json.granted.cloth === 1,
      JSON.stringify(first.json && first.json.granted));
    check('the shelf is goods, not table cash', first.json.cash == null && first.json.inventory.naira == null && first.json.inventory.cowries === 6);
    const again = await api('POST', '/api/retention/claim', { clientId: id, day: '2026-10-28' });
    check('the same Lagos day does not pay twice', again.json.already === true && again.json.granted == null && again.json.inventory.cowries === 6);
    const skip = await api('POST', '/api/retention/claim', { clientId: id, day: '2026-10-30' });
    const skipText = JSON.stringify(skip.json).toLowerCase();
    check('a skipped day still pays the base drop', skip.json.warm === false && skip.json.granted.cowries === 6 && skip.json.inventory.cowries === 12);
    check('there is no streak meter and no scare copy', !('streak' in skip.json) && !skipText.includes('streak') && !skipText.includes('lost') && !skipText.includes('reset'));
    const warmId = 'retention-warm-0001';
    await api('POST', '/api/retention/claim', { clientId: warmId, day: '2026-10-27' });
    const warm = await api('POST', '/api/retention/claim', { clientId: warmId, day: '2026-10-28' });
    check('a next-day visit carries the soft extra, with no counter', warm.json.warm === true && warm.json.granted.cowries === 9 && warm.json.granted.kola === 3
      && warm.json.granted.yams === 1 && warm.json.granted.cloth === 1 && !('streak' in warm.json));
  }

  console.log('R2: reconnect token finds the same shelf; push subscribe is stored');
  {
    const host = new Client('Shelf');
    await host.connect();
    host.send('create_room', { name: 'Shelf', token: 'danfo', mode: 'online', clientId: 'retention-seat-01', settings: { timed: false, turnTimerSec: 0 } });
    await host.waitFor((s) => s.status === 'lobby', 'shelf lobby');
    check('the seat token is the reconnect handle', typeof host.token === 'string' && host.token.length === 24);
    const byToken = await api('POST', '/api/retention/claim', { token: host.token, day: '2026-04-01' });
    check('a claim by reconnect token lands on that device shelf', byToken.json.ok && byToken.json.inventory.cowries === 6);
    const viewed = await api('GET', '/api/retention?clientId=retention-seat-01&day=2026-04-01');
    check('client id and reconnect token are one shelf', viewed.json.inventory.cowries === 6 && viewed.json.canClaim === false);
    check('the claim did not move table cash', host.state.players[0].cash === 1500000);
    const clash = await api('POST', '/api/retention/claim', { clientId: 'retention-other-9', token: host.token, day: '2026-04-02' });
    check('a token cannot be used as someone else', clash.status === 400 && clash.json.error === 'mismatch');
    host.ws.close();

    const subId = 'retention-voice-01';
    const vapid = await api('GET', '/api/push/vapid');
    check('the server exposes a VAPID public key', vapid.json.enabled === true && typeof vapid.json.publicKey === 'string' && vapid.json.publicKey.length > 80);
    check('the private key stays off the wire', vapid.json.privateKey == null && !JSON.stringify(vapid.json).includes('BEGIN'));
    const round = await api('GET', '/api/test/push-roundtrip');
    check('vapid jwt and aes128gcm roundtrip', round.json && round.json.ok === true, JSON.stringify(round.json));
    const subscription = {
      endpoint: 'https://push.example.test/kolopoly/abc',
      keys: { p256dh: 'B' + 'A'.repeat(80), auth: 'a'.repeat(22) }
    };
    const saved = await api('POST', '/api/push/subscribe', { clientId: subId, subscription });
    check('subscribe stores the push endpoint', saved.json.ok === true && saved.json.subscribed === true);
    const shelf = await api('GET', '/api/retention?clientId=' + subId);
    check('the shelf reports subscribed without echoing the endpoint', shelf.json.push.subscribed === true && !JSON.stringify(shelf.json).includes('push.example.test'));
    const muted = await api('POST', '/api/push/mute', { clientId: subId, muted: true });
    const held = await api('POST', '/api/test/nudge', { clientId: subId, kind: 'waiting', force: true });
    check('mute stops a whisper', muted.json.muted === true && held.json.sent === false && held.json.reason === 'muted');
    await api('POST', '/api/push/mute', { clientId: subId, muted: false });
    for (const kind of ['drop', 'waiting', 'pot']) {
      const n = await api('POST', '/api/test/nudge', { clientId: subId, kind, force: true });
      check(kind + ' whisper is world voice', n.json.sent === true && voiceOk(n.json.payload), JSON.stringify(n.json.payload));
    }
    const deniedId = 'retention-denied-1';
    await api('POST', '/api/push/subscribe', { clientId: deniedId, subscription });
    await api('POST', '/api/push/denied', { clientId: deniedId });
    const blocked = await api('POST', '/api/test/nudge', { clientId: deniedId, kind: 'pot', force: true });
    check('a denied phone is not whispered', blocked.json.sent === false && blocked.json.reason === 'denied');

    const sweepId = 'retention-sweep-01';
    await api('POST', '/api/push/subscribe', { clientId: sweepId, subscription });
    await api('POST', '/api/retention/claim', { clientId: sweepId, day: '2026-05-01' });
    const dawn = await api('POST', '/api/test/sweep', { day: '2026-05-02' });
    const dawnHits = (dawn.json.nudges || []).filter((n) => n.clientId === sweepId && n.kind === 'drop');
    check('the next Lagos dawn whispers once that the drop is ready', dawnHits.length === 1, JSON.stringify(dawn.json && dawn.json.nudges));
    const dawnAgain = await api('POST', '/api/test/sweep', { day: '2026-05-02' });
    const dawnAgainHits = (dawnAgain.json.nudges || []).filter((n) => n.clientId === sweepId);
    check('the same dawn does not whisper twice', dawnAgainHits.length === 0);
    await api('POST', '/api/retention/claim', { clientId: sweepId, day: '2026-05-02' });
    const collected = await api('POST', '/api/test/sweep', { day: '2026-05-02' });
    const collectedHits = (collected.json.nudges || []).filter((n) => n.clientId === sweepId);
    check('a collected shelf is not whispered', collectedHits.length === 0);
  }

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

  console.log('C2b: auction clock is fixed at open; bids and passes never add time');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola', 'Chidi']);
    const t = g.turn();
    const others = g.clients.filter((c) => c !== t);
    g.hook('test_set_position', { playerId: t.playerId, space: 0 });
    g.hook('test_dice', { rolls: [[2, 3]] });
    t.send('roll', {});
    await t.waitFor((s) => s.phase === 'buy' && s.buySpace === 5, 'Iddo offered for the clock test');
    t.send('decline', {});
    await t.waitFor((s) => !!s.auction, 'auction opened for the clock test');
    const opened = g.S().auction.endsAt;
    check('auction opened with a deadline', typeof opened === 'number' && opened > Date.now());
    others[0].send('bid', { amount: 80000 });
    await others[0].waitFor((s) => s.auction && s.auction.highBid === 80000, 'first bid registered');
    check('a bid does not move the auction deadline', g.S().auction.endsAt === opened, 'endsAt ' + g.S().auction.endsAt + ' vs ' + opened);
    others[1].send('pass_bid', {});
    await others[1].waitFor((s) => s.auction && s.auction.passed && s.auction.passed.indexOf(others[1].playerId) >= 0, 'pass recorded');
    check('a pass does not move the auction deadline', g.S().auction && g.S().auction.endsAt === opened, 'endsAt ' + (g.S().auction && g.S().auction.endsAt));
    t.send('bid', { amount: 90000 });
    await t.waitFor((s) => s.auction && s.auction.highBid === 90000, 'second bid registered');
    check('a later bid still does not add time', g.S().auction.endsAt === opened);
    const left = g.S().auction.endsAt - Date.now();
    check('the original deadline is the one still counting down', left < 4000 && left > 0, 'left=' + left);
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

  console.log('I7: preset phase lengths (Quick 8, Standard 15, Full Night 45 for Phase 1) and a fully claimed board ends Settling at the turn boundary');
  {
    for (const [preset, p1] of [['quick', 480], ['standard', 900], ['fullnight', 2700]]) {
      const g = await makeGame({ gameMode: 'inflation', preset, timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
      const left = Math.round((g.S().inf.phaseEndsAt - Date.now()) / 1000);
      check(preset + ' Phase 1 runs about ' + p1 + 's', Math.abs(left - p1) < 6, 'left=' + left);
      for (const c of g.clients) c.ws.close();
    }
    const g = await makeGame({ gameMode: 'inflation', preset: 'standard', timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const ids = g.S().players.map((p) => p.id);
    const OWNABLE = g.S().props.map((p, i) => i).filter((i) => [1, 3, 5, 6, 8, 9, 11, 12, 13, 14, 15, 16, 18, 19, 21, 23, 24, 25, 26, 27, 28, 29, 31, 32, 34, 35, 37, 39].includes(i));
    OWNABLE.forEach((sp, i) => g.hook('test_give', { playerId: ids[i % 2], space: sp }));
    await sleep(300);
    check('every ownable space has an owner', g.S().props.every((p, i) => !OWNABLE.includes(i) || p.o != null));
    await nullTurn(g);
    check('Phase 1 ended early at the turn boundary once the board was fully claimed', g.S().inf.phase === 2);
    check('the early end still ran the phase ceremony feed', g.S().feed.some((e) => e.kind === 'phase'));
    for (const c of g.clients) c.ws.close();
  }

  console.log('R1: a returning device (same client id) reclaims its seat instead of duplicating or spectating');
  {
    const host = new Client('Host');
    await host.connect();
    host.send('create_room', { name: 'Host', token: 'danfo', mode: 'online', settings: { timed: false, turnTimerSec: 0 }, clientId: 'engine-host-1' });
    await host.waitFor((s) => s.status === 'lobby', 'host lobby');
    const code = host.state.code;
    const guest = new Client('Guest');
    await guest.connect();
    guest.send('join_room', { code, name: 'Guest', token: 'keke', clientId: 'engine-guest-1' });
    await guest.waitFor((s) => s.players.length === 2, 'guest joined');
    const guestId = guest.playerId;
    host.send('start_game', {});
    await host.waitFor((s) => s.status === 'playing', 'game playing');
    guest.ws.close();
    await sleep(400);
    const back = new Client('GuestBack');
    await back.connect();
    back.send('join_room', { code, name: 'Guest', token: 'keke', clientId: 'engine-guest-1' });
    await back.waitFor((s) => s.status === 'playing' && s.players.length === 2, 'reclaimed seat state');
    check('reclaim keeps the same player id and does not duplicate the seat', back.playerId === guestId && back.state.players.length === 2);
    check('reclaimed player is connected again', back.state.players.find((p) => p.id === guestId).connected === true);
    host.ws.close(); back.ws.close();
  }

  // ------------------------------------------------------ LESSONS ROUND ---
  console.log('P1: parallel management: a non-turn player builds and mortgages; a foreign debt blocks them, the debtor raises and settles');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola', 'Chidi']);
    const [pa, pb, pc] = g.S().players;
    const aCli = g.byId(pa.id);
    const bCli = g.byId(pb.id);
    for (const sp of [11, 13, 14]) g.hook('test_give', { playerId: pb.id, space: sp }); // Bola: pink set
    g.hook('test_give', { playerId: pb.id, space: 5 });   // Bola: Iddo
    g.hook('test_give', { playerId: pb.id, space: 25 });  // Bola: Apapa Port
    g.hook('test_give', { playerId: pc.id, space: 3 });   // Chidi: Ajegunle
    let guard = 0;
    while (g.S().turnPlayerId === pb.id && guard++ < 4) await nullTurn(g);
    check('setup: Bola is not the turn player', g.S().turnPlayerId !== pb.id);
    const bCash0 = g.player(pb.id).cash;
    bCli.send('build', { space: 11, kind: 'duplex' });
    await bCli.waitFor((s) => s.props[11].b === 1, 'non-turn build lands');
    check('non-turn player built a duplex during another turn at the printed ₦100,000', g.player(pb.id).cash === bCash0 - 100000, 'cash=' + g.player(pb.id).cash);
    bCli.send('mortgage', { space: 5 });
    await bCli.waitFor((s) => s.props[5].m === 1, 'non-turn mortgage lands');
    check('non-turn player mortgaged Iddo for ₦100,000', g.player(pb.id).cash === bCash0, 'cash=' + g.player(pb.id).cash);
    // Debt collision: Ada (turn player) lands on Chidi's Ajegunle owing ₦4,000 with ₦3,000 cash.
    guard = 0;
    while (g.S().turnPlayerId !== pa.id && guard++ < 4) await nullTurn(g);
    check('setup: the debtor to be holds the turn', g.S().turnPlayerId === pa.id);
    g.hook('test_set_cash', { playerId: pa.id, amount: 3000 });
    g.hook('test_give', { playerId: pa.id, space: 6 }); // Mushin: the debtor raise asset
    await sleep(200);
    g.hook('test_set_position', { playerId: pa.id, space: 0 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    aCli.send('roll', {});
    await aCli.waitFor((s) => !!s.debt && s.debt.playerId === pa.id, 'rent debt opens for the turn player');
    const bErr = bCli.errors.length;
    bCli.send('mortgage', { space: 25 });
    await sleep(400);
    check('a non-debtor cannot manage while another player debt hangs', g.S().props[25].m === 0 && bCli.errors.length > bErr, 'err=' + bCli.errors.slice(-1));
    const cCash0 = g.player(pc.id).cash;
    aCli.send('mortgage', { space: 6 });
    await aCli.waitFor((s) => !s.debt, 'debtor mortgage settles the debt');
    check('the debtor mortgaged Mushin (+₦50,000) and the ₦4,000 rent settled to Chidi', g.player(pc.id).cash === cCash0 + 4000, 'c=' + g.player(pc.id).cash);
    bCli.send('mortgage', { space: 25 });
    await bCli.waitFor((s) => s.props[25].m === 1, 'management reopens after the debt settles');
    check('parallel management reopens once the debt settles', g.S().props[25].m === 1);
    for (const c of g.clients) c.ws.close();
  }

  console.log('P2: the last duplex is contested: a parallel builder is refused, the turn player opens the auction, the flow resumes');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola', 'Chidi']);
    const [pa, pb, pc] = g.S().players;
    const aCli = g.byId(pa.id);
    const bCli = g.byId(pb.id);
    for (const sp of [11, 13, 14]) g.hook('test_give', { playerId: pb.id, space: sp }); // Bola pink
    for (const sp of [16, 18, 19]) g.hook('test_give', { playerId: pc.id, space: sp }); // Chidi orange (a rival)
    for (const sp of [1, 3]) g.hook('test_give', { playerId: pa.id, space: sp });       // Ada brown
    g.hook('test_set_supply', { duplex: 1 });
    await sleep(200);
    let guard = 0;
    while (g.S().turnPlayerId !== pa.id && guard++ < 4) await nullTurn(g);
    const bErr = bCli.errors.length;
    bCli.send('build', { space: 11, kind: 'duplex' });
    await sleep(400);
    check('parallel builder refused the contested last duplex with the reason stated', bCli.errors.length > bErr && /last duplex/.test(bCli.errors[bCli.errors.length - 1]) && !g.S().auction, 'err=' + bCli.errors.slice(-1));
    aCli.send('build', { space: 1, kind: 'duplex' });
    await aCli.waitFor((s) => !!s.auction && s.auction.kind === 'duplex', 'turn player build opens the last duplex auction');
    check('turn player build on the last duplex opened the contest auction', !!g.S().auction);
    await passAuction(g);
    check('a no bid building auction hands the turn back at the roll phase', g.S().phase === 'roll' && g.S().turnPlayerId === pa.id, 'phase=' + g.S().phase);
    aCli.send('build', { space: 1, kind: 'duplex' });
    await aCli.waitFor((s) => !!s.auction, 'contest reopens');
    aCli.send('bid', { amount: 5000 });
    await aCli.waitFor((s) => s.auction && s.auction.highBid === 5000, 'bid registered');
    for (const c of g.clients) if (c !== aCli) c.send('pass_bid', {});
    await g.host.waitFor((s) => !!s.buildPlace && s.buildPlace.playerId === pa.id, 'winner placement pending');
    aCli.send('build_place', { space: 1 });
    await aCli.waitFor((s) => s.props[1].b === 1, 'duplex placed');
    check('the auction winner placed the last duplex and the turn resumed at roll', g.S().props[1].b === 1 && g.S().phase === 'roll', 'phase=' + g.S().phase);
    for (const c of g.clients) c.ws.close();
  }

  console.log('R2: resign in a two player game is a concession: the other player wins by resignation');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const [pa, pb] = g.S().players;
    const loser = g.S().turnPlayerId === pa.id ? pb : pa;
    const winner = loser.id === pa.id ? pb : pa;
    g.byId(loser.id).send('resign', {});
    await g.host.waitFor((s) => s.status === 'ended', 'concession ends the game');
    check('the game ended on the resignation', g.S().status === 'ended');
    check('the other player won', g.S().winner && g.S().winner.playerId === winner.id);
    check('the end reason records the resignation', g.S().endReason === 'resignation', 'endReason=' + g.S().endReason);
    check('the final table flags the resigner', g.S().endTable.find((r) => r.playerId === loser.id).resigned === true);
    for (const c of g.clients) c.ws.close();
  }

  console.log('R3: resign in a four player game liquidates to the bank and the game continues');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola', 'Chidi', 'Dara']);
    const quitter = g.S().players[1];
    g.hook('test_give', { playerId: quitter.id, space: 5 });
    g.hook('test_give', { playerId: quitter.id, space: 13 });
    await sleep(200);
    g.byId(quitter.id).send('resign', {});
    await g.host.waitFor((s) => s.players.find((p) => p.id === quitter.id).bankrupt === true, 'resignation settles');
    check('the resigner is out, flagged resigned not just bankrupt', g.player(quitter.id).bankrupt === true && g.player(quitter.id).resigned === true);
    check('their deeds returned to the bank unowned', g.S().props[5].o === null && g.S().props[13].o === null);
    check('the game continues with three solvent players', g.S().status === 'playing' && g.S().players.filter((p) => !p.bankrupt).length === 3);
    check('the turn does not sit on the resigned seat', g.S().turnPlayerId !== quitter.id);
    for (const c of g.clients) c.ws.close();
  }

  console.log('KP13-WS2a: lobby confirmed leave frees the seat at once; a host confirmed leave migrates the crown with no hostAway');
  {
    const host = new Client('LeaveHost');
    await host.connect();
    host.send('create_room', { name: 'LeaveHost', token: 'danfo', mode: 'online', settings: { timed: false, turnTimerSec: 0 }, clientId: 'leave-host-1' });
    await host.waitFor((s) => s.status === 'lobby', 'leave host lobby');
    const code = host.state.code;
    const guest = new Client('LeaveGuest');
    await guest.connect();
    guest.send('join_room', { code, name: 'LeaveGuest', token: 'keke', clientId: 'leave-guest-1' });
    await host.waitFor((s) => s.players.length === 2, 'leave guest joined');
    guest.send('leave', {});
    await host.waitFor((s) => s.players.length === 1, 'guest seat freed at once');
    check('lobby confirmed leave frees the guest seat immediately', host.state.players.length === 1 && host.state.players[0].name === 'LeaveHost');
    const guest2 = new Client('LeaveGuest2');
    await guest2.connect();
    guest2.send('join_room', { code, name: 'LeaveGuest2', token: 'okada', clientId: 'leave-guest-2' });
    await host.waitFor((s) => s.players.length === 2, 'second guest joined');
    const g2id = guest2.playerId;
    host.send('leave', {});
    await guest2.waitFor((s) => s.players.length === 1 && s.hostId === g2id, 'crown migrated on confirmed leave');
    check('lobby host confirmed leave frees the seat and migrates the crown', guest2.state.players.length === 1 && guest2.state.hostId === g2id);
    check('no hostAway after a confirmed host leave', guest2.state.hostAway === false);
    check('the remaining player reads a leave line, never a disconnect', /don leave the room/.test(guest2.state.message) && !/disconnected/.test(guest2.state.message), guest2.state.message);
    guest.ws.close(); guest2.ws.close();
  }

  console.log('KP13-WS2b: 2P confirmed leave ends the game at once, never paused, and the leaver closing their app never re-labels it a disconnect');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const seen = [];
    g.host.ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'state') seen.push(m.room); } catch (e) { } });
    const [pa, pb] = g.S().players;
    const loser = g.S().turnPlayerId === pa.id ? pb : pa;
    const winner = loser.id === pa.id ? pb : pa;
    g.byId(loser.id).send('resign', {});
    await g.host.waitFor((s) => s.status === 'ended', 'confirmed leave ends the game at once');
    check('the game ended on the confirmed leave', g.S().status === 'ended' && g.S().endReason === 'resignation');
    check('the remaining player won by resignation', g.S().winner && g.S().winner.playerId === winner.id);
    check('the room never entered a paused state during the leave', seen.every((r) => r.paused !== true), 'states=' + seen.length);
    g.byId(loser.id).ws.close();
    await sleep(700);
    check('after the leaver closes their app, the winner still reads the finish line, not a disconnect', !/disconnected/.test(g.S().message || ''), g.S().message);
    check('the ended game is not paused after the leaver socket closes', g.S().paused === false);
    for (const c of g.clients) c.ws.close();
  }

  console.log('KP13-WS2c: 3P current player confirms leave mid-turn: liquidated at once, turn advances, no pause, next player rolls right away');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola', 'Chidi']);
    const seen = [];
    g.host.ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'state') seen.push(m.room); } catch (e) { } });
    const turnId = g.S().turnPlayerId;
    g.hook('test_give', { playerId: turnId, space: 5 });
    await sleep(200);
    g.byId(turnId).send('resign', {});
    await g.host.waitFor((s) => s.players.find((p) => p.id === turnId).bankrupt === true, 'leaver liquidated at once');
    check('the leaver seat is liquidated and flagged resigned', g.player(turnId).bankrupt === true && g.player(turnId).resigned === true);
    check('their deed returned to the bank unowned', g.S().props[5].o === null);
    check('the turn advanced off the leaver at once', g.S().turnPlayerId !== turnId);
    check('the game was never paused during the leave', seen.every((r) => r.paused !== true) && g.S().paused === false, 'states=' + seen.length);
    const nid = g.S().turnPlayerId;
    g.hook('test_set_position', { playerId: nid, space: 17 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    g.byId(nid).send('roll', {});
    await g.host.waitFor((s) => s.players.find((p) => p.id === nid).position === 20, 'next player rolled and moved');
    check('the next player rolled right away and moved', g.player(nid).position === 20);
    for (const c of g.clients) c.ws.close();
  }

  console.log('KP13-WS2d: a bare leave message mid-game takes the resign path too, never the disconnect path');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const [pa, pb] = g.S().players;
    const loser = g.S().turnPlayerId === pa.id ? pb : pa;
    const winner = loser.id === pa.id ? pb : pa;
    g.byId(loser.id).send('leave', {});
    await g.host.waitFor((s) => s.status === 'ended', 'bare leave ends the game');
    check('bare leave mid-game ends the game by resignation', g.S().status === 'ended' && g.S().endReason === 'resignation' && g.S().winner && g.S().winner.playerId === winner.id);
    check('no disconnect line survives a confirmed leave', !/disconnected/.test(g.S().message || ''), g.S().message);
    for (const c of g.clients) c.ws.close();
  }

  console.log('KP13-WS4e: the state carries a structured banner (key + actor) at game start and on turn advance');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const b0 = g.S().banner;
    check('the opener banner is structured', !!b0 && b0.key === 'opener' && b0.actorId === g.S().turnPlayerId && typeof b0.name === 'string' && b0.name.length > 0, JSON.stringify(b0));
    const before = g.S().turnPlayerId;
    g.hook('test_set_position', { playerId: before, space: 17 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    g.turn().send('roll', {});
    await g.host.waitFor((s) => s.phase === 'end' && s.turnPlayerId === before, 'first move settles on Owambe');
    g.turn().send('end_turn', {});
    await g.host.waitFor((s) => s.turnPlayerId !== before, 'turn advanced');
    const b1 = g.S().banner;
    check('the turn banner is structured for the new actor', !!b1 && (b1.key === 'turn' || b1.key === 'turn_jail') && b1.actorId === g.S().turnPlayerId, JSON.stringify(b1));
    for (const c of g.clients) c.ws.close();
  }

  console.log('KP14-WSC1: play-again: a spectator cannot bounce the room, and a seated rematch clears the finished game fully');
  {
    const g = await makeGame({ gameMode: 'inflation', preset: 'quick', timed: false, turnTimerSec: 0 }, ['Ada', 'Bola']);
    const key1 = g.S().startedKey;
    check('the start carries a per-game startedKey', typeof key1 === 'string' && key1.length > 0, String(key1));
    check('the inflation game carries its phase state', !!g.S().inf && g.S().inf.phase >= 1);
    const spec = new Client('Watcher');
    await spec.connect();
    spec.send('join_room', { code: g.code, name: 'Watcher', token: 'fila' });
    await spec.waitFor((s) => s.status === 'playing', 'spectator seated in the running game');
    check('the late joiner is a spectator (no seat)', spec.playerId == null);
    await nullTurn(g);
    const feedAtEnd0 = g.S().feed.length;
    const [pa, pb] = g.S().players;
    // The guest leaves, deterministically: picking the leaver by whose
    // turn it happened to be made the host the leaver on some runs, and
    // the leaver's closed socket can never observe the rematch lobby.
    const loser = pb;
    g.byId(loser.id).send('leave', {});
    await g.host.waitFor((s) => s.status === 'ended', 'game ended');
    check('the finished game had feed history worth clearing', g.S().feed.length >= feedAtEnd0 && g.S().feed.length > 0, 'feed=' + g.S().feed.length);
    spec.send('play_again', {});
    await sleep(450);
    check('a spectator play-again is refused and the room stays ended', g.S().status === 'ended' && spec.errors.some((e) => /Spectators/.test(e)), JSON.stringify(spec.errors));
    // The winner drives the rematch: the leaver's socket was closed by
    // the leave resolution itself, so their client is already gone.
    g.byId(g.S().winner.playerId).send('play_again', {});
    await g.host.waitFor((s) => s.status === 'lobby', 'seated play-again returns the room to the lobby');
    const s = g.S();
    check('the rematch lobby is clean: no old feed, no stale phase state, no clock, no dice, no end table', s.feed.length === 0 && s.inf === null && s.gameEndsAt == null && s.dice == null && s.endTable == null, JSON.stringify({ feed: s.feed.length, inf: !!s.inf, ends: s.gameEndsAt, dice: s.dice }));
    g.host.send('start_game', {});
    await g.host.waitFor((s2) => s2.status === 'playing', 'rematch started');
    check('the rematch gets a fresh startedKey (the countdown ceremony runs again)', typeof g.S().startedKey === 'string' && g.S().startedKey !== key1, String(g.S().startedKey));
    spec.ws.close();
    for (const c of g.clients) c.ws.close();
  }

  console.log('L1: lobby grace: the room survives the host tab closing, guests see hostAway, the host reclaims as host');
  {
    const host = new Client('GraceHost');
    await host.connect();
    host.send('create_room', { name: 'GraceHost', token: 'danfo', mode: 'online', settings: { timed: false, turnTimerSec: 0 }, clientId: 'grace-host-1' });
    await host.waitFor((s) => s.status === 'lobby', 'grace host lobby');
    const code = host.state.code;
    const hostId = host.playerId;
    const guest = new Client('GraceGuest');
    await guest.connect();
    guest.send('join_room', { code, name: 'GraceGuest', token: 'keke', clientId: 'grace-guest-1' });
    await guest.waitFor((s) => s.players.length === 2, 'grace guest joined');
    host.ws.close();
    await guest.waitFor((s) => s.hostAway === true, 'guest sees the host away state', 6000);
    check('the guest in the lobby sees hostAway while the host tab is closed', guest.state.hostAway === true);
    check('the lobby kept both seats during grace', guest.state.players.length === 2);
    const apiRes = await fetch('http://127.0.0.1:' + PORT + '/api/room/' + code + '?clientId=grace-guest-1');
    const api = await apiRes.json();
    check('/api/room treats the grace lobby as alive and names the guest seat', api.exists === true && !!api.yourSeat && api.yourSeat.name === 'GraceGuest', JSON.stringify(api));
    const back = new Client('GraceHostBack');
    await back.connect();
    back.send('join_room', { code, name: 'GraceHost', token: 'danfo', clientId: 'grace-host-1' });
    await back.waitFor((s) => s.status === 'lobby' && s.players.length === 2, 'host reclaimed the lobby');
    check('the returning host reclaims the same seat and the host crown', back.playerId === hostId && back.state.hostId === hostId);
    check('hostAway clears when the host returns', back.state.hostAway === false);
    guest.ws.close(); back.ws.close();
  }

  console.log('A1: server auto actions confess in the feed with the (auto) tag and a reason');
  {
    const g = await makeGame({ timed: false, turnTimerSec: 60 }, ['Ada', 'Bola']);
    g.hook('test_deadline_in', { seconds: 1 });
    await g.host.waitFor((s) => s.feed.some((e) => e.auto === true), 'an auto action lands in the feed', 9000);
    const e = g.S().feed.find((x) => x.auto === true);
    check('the timeout action carries the timeout kind', e.kind === 'timeout', 'kind=' + e.kind);
    check('the auto entry names its reason', e.reason === 'turn timer', 'reason=' + e.reason);
    for (const c of g.clients) c.ws.close();
  }

  console.log('BOT1: lobby plumbing: host only, seat cap of 4, remove, pass mode refusal');
  {
    const host = new Client('BotLobbyHost');
    await host.connect();
    host.send('create_room', { name: 'BotLobbyHost', token: 'danfo', mode: 'online', settings: { timed: false, turnTimerSec: 0 } });
    await host.waitFor((s) => s.status === 'lobby' && s.players.length === 1, 'bot lobby');
    const guest = new Client('BotLobbyGuest');
    await guest.connect();
    guest.send('join_room', { code: host.state.code, name: 'BotLobbyGuest', token: 'keke' });
    await host.waitFor((s) => s.players.length === 2, 'guest seated');
    guest.send('add_bot', {});
    await sleep(300);
    check('a guest cannot add a bot', guest.errors.some((e) => e.includes('Only the host fit add a bot')), guest.errors.join('|'));
    check('no bot appeared from the guest try', host.state.players.every((p) => !p.bot));
    host.send('remove_bot', { playerId: guest.playerId });
    await sleep(200);
    check('removing a human seat as a bot is refused', host.errors.some((e) => e.includes('That seat no be bot')), host.errors.join('|'));
    guest.ws.close();
    host.send('add_bot', {}); host.send('add_bot', {}); host.send('add_bot', {});
    await sleep(500);
    check('bots fill the room only reach 4 seats total', host.state.players.length === 4 && host.state.players.filter((p) => p.bot).length === 2, 'players=' + host.state.players.length);
    check('the cap refusal is explained', host.errors.some((e) => e.includes('Bots fit only fill the room reach 4 seats')), host.errors.join('|'));
    const botRow = host.state.players.find((p) => p.bot);
    check('bot seats carry the bot flag and a BOT pool name', !!botRow && /^BOT /.test(botRow.name), botRow && botRow.name);
    check('bot tokens are unique at the table', new Set(host.state.players.map((p) => p.token)).size === host.state.players.length);
    host.send('remove_bot', { playerId: botRow.id });
    await host.waitFor((s) => s.players.length === 3, 'bot removed');
    check('the host can remove a bot before start', host.state.players.every((p) => p.id !== botRow.id));
    host.send('add_bot', {});
    await host.waitFor((s) => s.players.length === 4, 'bot re-added');
    check('a removed bot seat can be filled again', host.state.players.filter((p) => p.bot).length === 2);
    host.ws.close();

    const passHost = new Client('PassHost');
    await passHost.connect();
    passHost.send('create_room', { name: 'PassHost', token: 'danfo', mode: 'pass', settings: { timed: false, turnTimerSec: 0 } });
    await passHost.waitFor((s) => s.status === 'lobby', 'pass lobby');
    passHost.send('add_bot', {});
    await sleep(300);
    check('pass and play rooms get no bots', passHost.errors.some((e) => e.includes('Pass and play no dey use bot')), passHost.errors.join('|'));
    passHost.ws.close();
  }

  console.log('BOT2: three bots and one host play a timed Classic game to a winner, zero illegal bot intents');
  {
    const g = await botRoom({ timed: true, turnTimerSec: 30 }, 3);
    check('host plus 1 bot is not the case here: 4 seats filled', g.S().players.length === 4);
    g.host.send('start_game', {});
    await g.host.waitFor((s) => s.status === 'playing', 'bot game started');
    g.hook('test_clock', { secondsLeft: 25 });
    const endState = await driveUntil(g, (s) => s.status === 'ended', 'bot game ends on the clock', 70000);
    check('the bot game ran to a declared winner', !!endState.winner && !!endState.endTable, 'winner=' + JSON.stringify(endState.winner));
    const botDeeds = g.S().players.filter((p) => p.bot).reduce((n, p) => n + p.deeds, 0);
    check('bots bought deeds between them', botDeeds >= 1, 'botDeeds=' + botDeeds);
    const stats = await botStats(g);
    check('every bot stayed active all game', stats.length === 3 && stats.every((b) => b.actions >= 8), JSON.stringify(stats.map((b) => b.actions)));
    check('zero illegal intents from any bot', stats.every((b) => b.errors.length === 0), JSON.stringify(stats.map((b) => b.errors)));
    g.host.ws.close();
  }

  console.log('BOT3: host plus bot: scripted purchase, parallel build, Kirikiri bail plan, auction discipline');
  {
    const g = await botRoom({ timed: false, turnTimerSec: 0 }, 1);
    const botId = g.bots()[0].id;
    g.host.send('start_game', {});
    await g.host.waitFor((s) => s.status === 'playing', 'host bot game started');
    if (g.S().turnPlayerId === botId) {
      await driveUntil(g, (s) => s.turnPlayerId === g.host.playerId, 'bot free first turn', 25000);
    }
    g.hold(botId, true);
    // Purchase: wrap START onto Makoko with the reserve comfortably intact.
    await driveUntil(g, (s) => s.turnPlayerId === g.host.playerId && s.phase === 'end', 'host end phase for purchase', 30000);
    g.hook('test_set_position', { playerId: botId, space: 38 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    g.host.send('end_turn', {});
    await g.host.waitFor((s) => s.turnPlayerId === botId && s.phase === 'roll', 'bot roll phase', 9000);
    g.hold(botId, false);
    await g.host.waitFor((s) => s.props[1] && s.props[1].o === botId, 'bot buys Makoko', 9000);
    check('bot buys an unowned landing when cash after keeps the reserve', g.S().props[1].o === botId);
    await driveUntil(g, (s) => s.turnPlayerId === g.host.playerId, 'turn returns to host', 25000);
    g.hold(botId, true);
    // Build: a completed pink set gets a duplex while the host is playing.
    g.hook('test_give', { playerId: botId, space: 11 });
    g.hook('test_give', { playerId: botId, space: 13 });
    g.hook('test_give', { playerId: botId, space: 14 });
    g.hold(botId, false);
    await driveUntil(g, (s) => [11, 13, 14].some((i) => s.props[i] && s.props[i].b >= 1), 'bot builds on the pink set', 30000);
    check('bot builds evenly on its completed set using parallel management', [11, 13, 14].some((i) => g.S().props[i].b >= 1));
    // Kirikiri: roll for doubles twice, pay bail on the third attempt.
    const inJail = (s) => { const b = s.players.find((p) => p.id === botId); return b && b.inJail; };
    await scriptBotTurn(g, { botId, pos: 28, dice: [[1, 1]] }, inJail, 'bot enters Kirikiri');
    check('bot is in Kirikiri after landing on Go To Kirikiri', g.botRow(botId).inJail === true);
    const jailDice = [[2, 3], [3, 4], [1, 2]];
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = jailDice[attempt];
      await scriptBotTurn(g, { botId, dice: [d] }, (s) => { const b = s.players.find((p) => p.id === botId); return s.turnPlayerId === g.host.playerId && b && b.inJail; }, 'jail attempt ' + (attempt + 1) + ' resolves', 5);
      check('bot rolls for doubles and stays in Kirikiri on attempt ' + (attempt + 1), g.botRow(botId).inJail === true);
    }
    await scriptBotTurn(g, { botId, dice: [jailDice[2]] }, (s) => { const b = s.players.find((p) => p.id === botId); return b && !b.inJail; }, 'bot pays bail and walks', 5);
    check('bot pays the Kirikiri bail on the third attempt', g.S().feed.some((e) => e.playerId === botId && e.text.includes('Kirikiri bail')), g.S().feed.map((f) => f.text).join(' | '));
    // Auction: bot owns Mushin and Bariga, so Agege completes its set (cap 1.2x of print).
    g.hook('test_give', { playerId: botId, space: 6 });
    g.hook('test_give', { playerId: botId, space: 8 });
    await driveUntil(g, (s) => s.turnPlayerId === g.host.playerId && s.phase === 'roll' && !s.auction, 'host roll phase for auction', 30000);
    g.hook('test_set_position', { playerId: g.host.playerId, space: 6 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    g.host.send('roll', {});
    await g.host.waitFor((s) => s.phase === 'buy' && s.turnPlayerId === g.host.playerId, 'host buy phase on Agege', 9000);
    g.host.send('decline', {});
    await g.host.waitFor((s) => s.auction && s.auction.highBidder === botId, 'bot leads the Agege auction', 9000);
    const leadBid = g.S().auction.highBid;
    check('bot bids for its set inside the 1.2x cap', leadBid >= 1000 && leadBid <= 144000, 'bid=' + leadBid);
    g.host.send('pass_bid', {});
    await g.host.waitFor((s) => !s.auction && s.props[9] && s.props[9].o === botId, 'bot wins Agege', 9000);
    check('bot wins the auction and completes the lightblue set', g.S().props[9].o === botId);
    const stats = await botStats(g);
    check('the whole scripted game cost the bot zero server errors', stats.length === 1 && stats[0].errors.length === 0, JSON.stringify(stats));
    g.host.ws.close();
  }

  console.log('BOT4: a Get Out of Kirikiri card is played instead of bail on the third attempt');
  {
    const g = await botRoom({ timed: false, turnTimerSec: 0 }, 1);
    const botId = g.bots()[0].id;
    g.host.send('start_game', {});
    await g.host.waitFor((s) => s.status === 'playing', 'card game started');
    if (g.S().turnPlayerId === botId) {
      await driveUntil(g, (s) => s.turnPlayerId === g.host.playerId, 'bot free first turn', 25000);
    }
    g.hold(botId, true);
    g.hook('test_give', { playerId: botId, space: 13 }); // Yaba: a cash neutral landing after jail
    // Draw the Wahala Get Out card: 34 plus [1,1] lands on 36, extra roll [1,2] to Banana Island.
    await driveUntil(g, (s) => s.turnPlayerId === g.host.playerId && s.phase === 'end', 'host end phase for card draw', 30000);
    g.hook('test_set_position', { playerId: botId, space: 34 });
    g.hook('test_dice', { rolls: [[1, 1], [1, 2]] });
    g.hook('test_card', { deck: 'wahala', cardId: 'w08' });
    g.host.send('end_turn', {});
    await g.host.waitFor((s) => s.turnPlayerId === botId && s.phase === 'roll', 'bot card roll phase', 9000);
    g.hold(botId, false);
    await g.host.waitFor((s) => { const b = s.players.find((p) => p.id === botId); return b && b.goojf === 1; }, 'bot holds the Get Out card', 12000);
    check('bot drew and kept the Get Out of Kirikiri card', g.botRow(botId).goojf === 1);
    await driveUntil(g, (s) => s.turnPlayerId === g.host.playerId, 'turn returns to host after card', 25000);
    g.hold(botId, true);
    // Into Kirikiri with the card in hand.
    g.hold(botId, false);
    const inJailB = (s) => { const b = s.players.find((p) => p.id === botId); return b && b.inJail; };
    await scriptBotTurn(g, { botId, pos: 28, dice: [[1, 1]] }, inJailB, 'bot enters Kirikiri holding the card');
    check('bot is in Kirikiri holding the card', g.botRow(botId).inJail === true && g.botRow(botId).goojf === 1);
    const jailDice = [[2, 3], [3, 4], [1, 2]];
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = jailDice[attempt];
      await scriptBotTurn(g, { botId, dice: [d] }, (s) => { const b = s.players.find((p) => p.id === botId); return s.turnPlayerId === g.host.playerId && b && b.inJail; }, 'card jail attempt ' + (attempt + 1) + ' resolves', 5);
    }
    const cashBefore = g.botRow(botId).cash;
    await scriptBotTurn(g, { botId, dice: [jailDice[2]] }, (s) => { const b = s.players.find((p) => p.id === botId); return b && !b.inJail && b.goojf === 0; }, 'bot plays the card and walks', 5);
    check('bot played the Get Out card on the third attempt', g.botRow(botId).goojf === 0 && g.botRow(botId).inJail === false);
    check('no bail was paid: the bot cash is untouched by Kirikiri', g.botRow(botId).cash === cashBefore, 'before=' + cashBefore + ' after=' + g.botRow(botId).cash);
    g.host.ws.close();
  }

  console.log('BOT5: Inflation Phase 2: the reserve scales with the phase multiplier');
  {
    const g = await botRoom({ gameMode: 'inflation', preset: 'quick', timed: false, turnTimerSec: 0 }, 2);
    const botIds = g.bots().map((p) => p.id);
    for (const id of botIds) g.hold(id, true); // frozen before the game even starts: no first-tick race
    g.host.send('start_game', {});
    await g.host.waitFor((s) => s.status === 'playing', 'inflation bot game started');
    g.hook('test_phase', { phase: 2 });
    // The first bot whose turn arrives is the subject; the other is a filler.
    await driveUntil(g, (s) => botIds.includes(s.turnPlayerId) && s.phase === 'roll', 'a bot roll phase arrives', 30000);
    const subject = g.S().turnPlayerId;
    const filler = botIds.find((id) => id !== subject);
    // Phase 2 reserve is 250000 x 2.53 = 632500. Cash 800000 buys a 100000 street.
    g.hook('test_set_cash', { playerId: subject, amount: 800000 });
    g.hook('test_set_position', { playerId: subject, space: 3 });
    g.hook('test_dice', { rolls: [[1, 2]] });
    g.hold(subject, false);
    await g.host.waitFor((s) => s.props[6] && s.props[6].o === subject, 'subject buys Mushin in Phase 2', 9000);
    check('Phase 2: bot buys when cash after keeps the phase scaled reserve', g.S().props[6].o === subject);
    // Let the subject finish, then walk turns until the subject rolls again.
    await g.host.waitFor((s) => s.turnPlayerId !== subject, 'subject turn done', 12000);
    g.hold(subject, true);
    {
      const end = Date.now() + 45000;
      let scripted = false;
      while (Date.now() < end && !scripted) {
        const s = g.S();
        if (s.turnPlayerId === subject && s.phase === 'roll') {
          // Pick an unowned street priced 100000 or more, no START wrap.
          const target = [8, 9, 11, 13, 14, 16, 18, 19].find((i) => { const pr = s.props[i]; return !pr || !pr.o; });
          if (target == null) throw new Error('no decline target street left');
          g.hook('test_set_cash', { playerId: subject, amount: 700000 });
          g.hook('test_set_position', { playerId: subject, space: target - 3 });
          g.hook('test_dice', { rolls: [[1, 2]] });
          g.hold(subject, false);
          g.declineTarget = target;
          scripted = true;
          break;
        }
        if (s.turnPlayerId === filler) g.hold(filler, false); else g.hold(filler, true);
        if (s.auction) { if (s.auction.highBidder !== g.host.playerId) g.host.send('pass_bid', {}); }
        else if (s.turnPlayerId === g.host.playerId) {
          if (s.phase === 'roll') {
            g.host.send('test_set_position', { playerId: g.host.playerId, space: 17 });
            g.host.send('test_dice', { rolls: [[1, 2]] });
            g.host.send('roll', {});
          }
          else if (s.phase === 'buy') g.host.send('decline', {});
          else if (s.phase === 'tax') g.host.send('tax_choice', { choice: 'flat' });
          else if (s.phase === 'end') g.host.send('end_turn', {});
        }
        await sleep(120);
      }
      if (!scripted) throw new Error('subject second turn never arrived');
    }
    const target = g.declineTarget;
    await g.host.waitFor((s) => s.auction && s.auction.space === target, 'subject declines and the street goes to auction', 12000);
    check('Phase 2: bot declines a buy that would break the scaled reserve (it would have bought at Classic reserve)', true);
    for (let r = 0; r < 30 && g.S().auction; r++) { g.host.send('pass_bid', {}); await sleep(250); }
    const stats = await botStats(g);
    check('inflation bots also finish with zero server errors', stats.every((b) => b.errors.length === 0), JSON.stringify(stats.map((b) => b.errors)));
    g.host.ws.close();
  }

  console.log('BOT6: when every human leaves a started bot game, the game ends and the room closes');
  {
    const g = await botRoom({ timed: false, turnTimerSec: 0 }, 1);
    g.host.send('start_game', {});
    await g.host.waitFor((s) => s.status === 'playing', 'leave game started');
    const code = g.code;
    g.host.ws.close();
    await sleep(1200);
    const mid = await (await fetch('http://127.0.0.1:' + PORT + '/api/room/' + code)).json();
    check('the room survives inside the grace window, pause behaviour intact', mid.exists === true, JSON.stringify(mid));
    const deadline = Date.now() + 10000;
    let gone = false;
    while (Date.now() < deadline) {
      const r = await (await fetch('http://127.0.0.1:' + PORT + '/api/room/' + code)).json();
      if (!r.exists) { gone = true; break; }
      await sleep(300);
    }
    check('after grace the room closes: bots never play alone', gone);
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
