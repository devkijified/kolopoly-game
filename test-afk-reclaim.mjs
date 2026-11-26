// A free-table AFK bot gives the seat back to the same client.
// A stranger cannot take it. A paid table never grows a bot.
import WebSocket from 'ws';
import { spawn } from 'child_process';

const PORT = 4219;
const BASE = 'ws://127.0.0.1:' + PORT;
let n = 0, fail = 0;
function check(name, cond, extra) {
  n += 1;
  if (cond) console.log('  ok ' + n + ' - ' + name);
  else { fail += 1; console.log('  FAIL ' + n + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.playerId = null;
    this.token = null;
    this.notices = [];
    this.closed = false;
    this.rejoinFailed = false;
    this.spectator = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('close', () => { this.closed = true; });
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'joined') {
          this.playerId = msg.playerId;
          this.code = msg.code;
          this.spectator = !!msg.spectator;
          if (msg.token) this.token = msg.token;
        }
        if (msg.type === 'state') this.state = msg.room;
        if (msg.type === 'notice') this.notices.push(msg);
        if (msg.type === 'rejoin_failed') this.rejoinFailed = true;
        if (msg.type === 'test_take_afk') this.take = msg;
      });
    });
  }
  send(type, obj) { this.ws.send(JSON.stringify(Object.assign({ type }, obj || {}))); }
  async waitFor(pred, label, ms) {
    const end = Date.now() + (ms || 8000);
    while (Date.now() < end) {
      if (pred()) return;
      await sleep(40);
    }
    throw new Error('timeout: ' + label);
  }
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), KP_TEST: '1', KP_ADMIN_TOKEN: '', KP_PERSIST_ROOMS: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
  server.stdout.on('data', (d) => { if (String(d).includes('Kolopoly listening')) { clearTimeout(timer); resolve(); } });
});

try {
  const ada = new Client('Ada');
  const tobi = new Client('Tobi');
  await ada.connect();
  await tobi.connect();
  ada.send('create_room', { name: 'Ada', token: 'danfo', mode: 'online', clientId: 'ada-device-1111', settings: { gameMode: 'classic' } });
  await ada.waitFor(() => ada.state && ada.state.status === 'lobby', 'lobby');
  const code = ada.state.code;
  const adaId = ada.playerId;
  const token = ada.token;
  tobi.send('join_room', { code, name: 'Tobi', token: 'keke', clientId: 'tobi-device-2222' });
  await tobi.waitFor(() => tobi.state && tobi.state.players.length === 2, 'joined');
  ada.send('start_game', {});
  await ada.waitFor(() => ada.state && ada.state.status === 'playing', 'playing');
  ada.send('test_set_cash', { playerId: adaId, amount: 880000 });
  ada.send('test_set_position', { playerId: adaId, space: 6 });
  ada.send('test_give', { playerId: adaId, space: 4 });
  await ada.waitFor(() => {
    const p = ada.state.players.find((x) => x.id === adaId);
    return p && p.cash === 880000 && p.position === 6;
  }, 'state planted');
  const before = ada.state.players.find((p) => p.id === adaId);
  tobi.send('test_take_afk', { playerId: adaId });
  await tobi.waitFor(() => tobi.take && tobi.take.ok === true, 'bot took the seat');
  await tobi.waitFor(() => {
    const p = tobi.state.players.find((x) => x.id === adaId);
    return p && p.bot && p.afkTaken;
  }, 'seat is a bot');
  check('the AFK bot keeps the cash and the space', (() => {
    const p = tobi.state.players.find((x) => x.id === adaId);
    return p.cash === 880000 && p.position === 6;
  })());
  check('the human name is still the seat name', tobi.state.players.find((x) => x.id === adaId).name.indexOf('Ada') === 0);

  const stranger = new Client('stranger');
  await stranger.connect();
  stranger.send('rejoin', { code, playerId: adaId, token: 'wrong-token-value' });
  await stranger.waitFor(() => stranger.rejoinFailed, 'bad token');
  check('a wrong token cannot reclaim the seat', stranger.rejoinFailed === true);
  stranger.send('join_room', { code, name: 'Stranger', token: 'okada', clientId: 'stranger-device-9' });
  await stranger.waitFor(() => stranger.spectator === true || (stranger.state && stranger.playerId == null), 'stranger watches');
  check('a stranger joins as a spectator', stranger.spectator === true && stranger.playerId == null);
  await sleep(200);
  check('the stranger did not take Ada\'s seat', tobi.state.players.find((x) => x.id === adaId).bot === true);

  const back = new Client('Ada');
  await back.connect();
  back.send('join_room', { code, name: 'Ada', token: 'danfo', clientId: 'ada-device-1111' });
  await back.waitFor(() => back.playerId === adaId, 'reclaimed');
  await back.waitFor(() => back.notices.some((m) => m.action === 'back'), 'toast');
  await tobi.waitFor(() => {
    const p = tobi.state.players.find((x) => x.id === adaId);
    return p && !p.bot && !p.afkTaken && (tobi.state.message || '').indexOf('Ada is back') >= 0;
  }, 'opponent sees the return');
  const seat = back.state.players.find((x) => x.id === adaId);
  check('Ada gets the same seat back', back.playerId === adaId && seat && !seat.bot && !seat.afkTaken);
  check('cash, space and the deed are unchanged', seat.cash === before.cash && seat.position === 6 && back.state.props[4].o === adaId, JSON.stringify({ cash: seat.cash, pos: seat.position, owner: back.state.props[4] && back.state.props[4].o }));
  check('the name has no BOT tag', seat.name === 'Ada' && seat.bot === false);
  check('the returning player is told the seat is theirs', back.notices.some((m) => m.action === 'back' && m.message === "You're back. Your seat is yours."));
  check('the other player sees Ada is back', (tobi.state.feed || []).some((e) => e.text === 'Ada is back') && tobi.state.message === 'Ada is back');

  const again = new Client('other tab');
  await again.connect();
  again.send('rejoin', { code, playerId: adaId, token });
  await again.waitFor(() => again.playerId === adaId, 'same token, other tab');
  check('the same token on another tab gets the seat, not a new one', again.playerId === adaId && again.state.players.length === 2);

  // Paid tables do not convert a seat into a bot.
  const paid = new Client('Paid');
  const other = new Client('Other');
  await paid.connect();
  await other.connect();
  paid.send('create_room', { name: 'Paid', token: 'danfo', mode: 'online', clientId: 'paid-device-1111', settings: { gameMode: 'classic' } });
  await paid.waitFor(() => paid.state && paid.state.status === 'lobby', 'paid lobby');
  other.send('join_room', { code: paid.state.code, name: 'Other', token: 'keke', clientId: 'paid-other-2222' });
  await other.waitFor(() => other.state && other.state.players.length === 2, 'paid joined');
  paid.send('start_game', {});
  await paid.waitFor(() => paid.state && paid.state.status === 'playing', 'paid playing');
  paid.send('test_set_paid', { playerId: paid.playerId, fee: 200 });
  await paid.waitFor(() => paid.state.paid && paid.state.paid.fee === 200, 'paid flag');
  other.send('test_take_afk', { playerId: paid.playerId });
  await other.waitFor(() => other.take && other.take.ok === false, 'paid refuses the bot');
  check('a paid seat is not handed to a bot', other.take.ok === false && other.state.players.find((p) => p.id === paid.playerId).bot === false);
} catch (e) {
  fail += 1;
  console.log('  FAIL runner :: ' + (e && e.stack || e));
} finally {
  server.kill();
}

console.log(fail ? fail + ' failed' : 'all ' + n + ' passed');
process.exit(fail ? 1 : 0);
