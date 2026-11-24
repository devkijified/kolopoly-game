// Live tables survive a restart. The Node host snapshots rooms to
// KP_DATA_DIR on change and on SIGTERM, then restores them before it
// listens. A player reconnects with the same seat token and finds the
// same cash, deed, position and match clock. Nothing here talks to
// Paystack. Run: node test-rooms-persist.mjs
import WebSocket from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 4255;
const BASE = 'ws://127.0.0.1:' + PORT;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-rooms-'));
const ROOMS = path.join(DIR, 'rooms.json');
let checks = 0, failures = 0;
const check = (name, cond, extra) => {
  checks++;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures++; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('.', import.meta.url).pathname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), KP_TEST: '1', KP_PERSIST_ROOMS: '1', KP_DATA_DIR: DIR,
      KP_ROOMS_FILE: ROOMS, KP_AUTH_SECRET: 'rooms-persist-secret',
      RESEND_API_KEY: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const ready = (async () => {
    for (let i = 0; i < 100 && !log.includes('listening'); i++) await sleep(50);
    if (!log.includes('listening')) throw new Error('server did not listen: ' + log.slice(-500));
    return log;
  })();
  return { child, ready, logRef: () => log };
}

class Client {
  constructor(name) {
    this.name = name; this.state = null; this.playerId = null; this.token = null; this.errors = []; this.botStats = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (msg.type === 'joined') { this.playerId = msg.playerId; this.token = msg.token || this.token; }
        else if (msg.type === 'state') this.state = msg.room;
        else if (msg.type === 'error') this.errors.push(msg.message);
        else if (msg.type === 'test_bot_stats') this.botStats = msg.bots;
        else if (msg.type === 'rejoin_failed') this.failed = true;
      });
    });
  }
  send(type, obj) { this.ws.send(JSON.stringify(Object.assign({ type }, obj || {}))); }
  waitFor(pred, label, ms) {
    const limit = ms || 4000;
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (pred(this)) return resolve();
        if (Date.now() - t0 > limit) return reject(new Error(label || 'timeout'));
        setTimeout(tick, 30);
      };
      tick();
    });
  }
}

let server = null;
try {
  server = startServer();
  await server.ready;
  const ada = new Client('Ada');
  const bola = new Client('Bola');
  await ada.connect();
  await bola.connect();
  ada.send('create_room', { name: 'Ada', token: 'danfo', mode: 'online', settings: { gameMode: 'classic', timed: true, turnTimerSec: 60 } });
  await ada.waitFor((c) => c.state && c.state.players.length === 1, 'room created');
  const code = ada.state.code;
  bola.send('join_room', { code, name: 'Bola', token: 'keke' });
  await ada.waitFor((c) => c.state.players.length === 2, 'bola joined');
  ada.send('add_bot', {});
  await ada.waitFor((c) => c.state.players.some((p) => p.bot), 'bot seated');
  ada.send('start_game', {});
  await ada.waitFor((c) => c.state.status === 'playing', 'game started');
  const adaId = ada.playerId;
  ada.send('test_set_cash', { playerId: adaId, amount: 777777 });
  ada.send('test_set_position', { playerId: adaId, space: 12 });
  ada.send('test_give', { playerId: adaId, space: 16 });
  ada.send('test_clock', { secondsLeft: 2400 });
  await ada.waitFor((c) => {
    const me = c.state.players.find((p) => p.id === adaId);
    return me && me.cash === 777777 && me.position === 12 && c.state.props[16] && c.state.props[16].o === adaId;
  }, 'markers applied');
  const bot = ada.state.players.find((p) => p.bot);
  ada.send('test_bot_hold', { playerId: bot.id, hold: true });
  await sleep(50);
  // Debounced snapshot, then a hard shutdown that must flush too.
  await sleep(400);
  const mid = JSON.parse(fs.readFileSync(ROOMS, 'utf8'));
  const midRoom = mid.rooms[code];
  const midAda = midRoom.players.find((p) => p.id === adaId);
  check('a change writes the table to disk within the debounce', !!midAda && midAda.cash === 777777 && midAda.position === 12 && midRoom.props[16].owner === adaId, JSON.stringify(midAda && { cash: midAda.cash, pos: midAda.position }));
  check('the snapshot keeps the seat token and drops sockets', !!midAda.reconnectToken && !midAda.ws && !midAda.botBrain);
  ada.ws.close();
  bola.ws.close();
  server.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((r) => server.child.on('exit', r)),
    sleep(5000).then(() => 'hung')
  ]);
  check('SIGTERM stops the process', exited !== 'hung', String(exited));
  const dumped = JSON.parse(fs.readFileSync(ROOMS, 'utf8'));
  check('shutdown flush keeps the same table', dumped.rooms[code] && dumped.rooms[code].players.find((p) => p.id === adaId).cash === 777777);
  // A real deploy is not instant. The gap has to be long enough that a
  // missing clock hold would show up, and short enough to stay inside
  // the two minute cap.
  await sleep(1500);

  server = startServer();
  const bootLog = await server.ready;
  check('boot restores the live table', /Restored 1 live table/.test(bootLog), bootLog.split('\n').filter((l) => /Restored|listening|snapshot/.test(l)).join(' | '));
  const back = new Client('Ada');
  await back.connect();
  const seat = dumped.rooms[code].players.find((p) => p.id === adaId);
  const t0 = Date.now();
  back.send('rejoin', { code, playerId: adaId, token: seat.reconnectToken });
  await back.waitFor((c) => c.state && c.state.status === 'playing' && c.playerId === adaId, 'rejoined');
  const me = back.state.players.find((p) => p.id === adaId);
  check('the same seat is back with its cash, place and deed', me.cash === 777777 && me.position === 12 && back.state.props[16].o === adaId && back.state.code === code,
    JSON.stringify({ cash: me.cash, pos: me.position, deed: back.state.props[16] && back.state.props[16].o }));
  const gap = Math.max(0, t0 - dumped.savedAt);
  const shifted = back.state.gameEndsAt - dumped.rooms[code].gameEndsAt;
  check('the match clock moves forward by the downtime, not by zero and not without a cap',
    shifted > 1000 && Math.abs(shifted - Math.min(gap, 120000)) < 2000,
    'shifted ' + shifted + ' gap ' + gap);
  back.send('test_bot_stats', {});
  await back.waitFor((c) => c.botStats, 'bot stats');
  check('the bot brain is alive again and still held', back.botStats.length === 1 && back.botStats[0].errors.indexOf('no brain') === -1, JSON.stringify(back.botStats));
  back.send('test_set_cash', { playerId: adaId, amount: 888888 });
  await back.waitFor((c) => c.state.players.find((p) => p.id === adaId).cash === 888888, 'play continues');
  check('the restored table still accepts a move', back.state.players.find((p) => p.id === adaId).cash === 888888);
  check('rejoin was not refused', !back.failed);
} catch (e) {
  failures++;
  console.log('SUITE ERROR: ' + e.message);
} finally {
  if (server && server.child && server.child.exitCode == null) server.child.kill('SIGTERM');
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* temp */ }
}
console.log('---\nchecks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
