// Socket and sign-in caps. A 64 KB payload ceiling, 40 sockets per
// address, a message budget, and a per-network cap on sign-in codes
// beside the per-email one. A normal seat still opens a room.
// Run: node test-limits.mjs
import WebSocket from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 4268;
const HTTP = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-limits-'));
let checks = 0, failures = 0;
const check = (name, cond, extra) => {
  checks++;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures++; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function once(em, ev) {
  return new Promise((resolve) => em.once(ev, (...args) => resolve(args)));
}
function track(ws) {
  sockets.push(ws);
  ws.on('error', () => {});
  return ws;
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), KP_TEST: '1', KP_DATA_DIR: dir, KP_PERSIST_ROOMS: '',
    RESEND_API_KEY: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
    KP_AUTH_SECRET: 'limits-secret'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const sockets = [];
try {
  for (let i = 0; i < 80 && !log.includes('listening'); i++) await sleep(50);
  check('host booted', log.includes('listening'));

  const seat = track(new WebSocket(WS));
  await once(seat, 'open');
  const got = new Promise((resolve) => seat.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'state') resolve(msg.room);
  }));
  seat.send(JSON.stringify({ type: 'create_room', name: 'Ada', token: 'danfo', mode: 'online', settings: { gameMode: 'classic' } }));
  const room = await Promise.race([got, sleep(4000).then(() => null)]);
  check('a normal seat still creates a room under the caps', !!room && room.status === 'lobby', room && room.status);

  let limited = null;
  for (let i = 0; i < 31; i++) {
    const res = await fetch(HTTP + '/api/auth/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'p' + i + '@limits.example' })
    });
    const body = await res.json();
    if (i < 30) {
      if (res.status !== 200 || !body.devCode) { limited = 'early ' + i + ' ' + res.status; break; }
    } else {
      limited = res.status === 429 && body.ok === false && /network/.test(body.message || '') ? 'ok' : (res.status + ' ' + JSON.stringify(body));
    }
  }
  check('the 31st sign-in code from one address is refused', limited === 'ok', String(limited));
  const sameEmail = await fetch(HTTP + '/api/auth/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'fresh@limits.example' })
  });
  check('a new email on that address is still refused', sameEmail.status === 429);

  const big = track(new WebSocket(WS));
  await once(big, 'open');
  const bigClose = once(big, 'close');
  big.send(Buffer.alloc(70 * 1024, 0x61));
  const bigArgs = await Promise.race([bigClose, sleep(3000).then(() => null)]);
  check('a payload over 64 KB is dropped', !!bigArgs && (bigArgs[0] === 1009 || bigArgs[0] === 1006), JSON.stringify(bigArgs && bigArgs[0]));
  const afterBig = track(new WebSocket(WS));
  const afterOpen = await Promise.race([once(afterBig, 'open').then(() => true), sleep(2000).then(() => false)]);
  check('an oversized frame does not take the server down', afterOpen);
  try { afterBig.close(); } catch (e) { /* done */ }

  const flood = track(new WebSocket(WS));
  await once(flood, 'open');
  const floodClose = once(flood, 'close');
  for (let i = 0; i < 2200; i++) flood.send(JSON.stringify({ type: 'heartbeat' }));
  const floodArgs = await Promise.race([floodClose, sleep(4000).then(() => null)]);
  check('a message flood closes the socket', !!floodArgs && floodArgs[0] === 1008, JSON.stringify(floodArgs && floodArgs[0]));

  for (const ws of [seat, big, flood]) { try { ws.close(); } catch (e) { /* done */ } }
  await sleep(200);
  const held = [];
  for (let i = 0; i < 40; i++) {
    const ws = track(new WebSocket(WS));
    held.push(ws);
    const opened = await Promise.race([once(ws, 'open').then(() => true), sleep(2000).then(() => false)]);
    if (!opened) throw new Error('socket ' + i + ' did not open');
  }
  const extra = track(new WebSocket(WS));
  const extraEnd = Promise.race([
    once(extra, 'close').then((args) => args[0]),
    once(extra, 'error').then(() => 'error'),
    sleep(3000).then(() => 'open')
  ]);
  const extraCode = await extraEnd;
  check('the 41st socket from one address is refused', extraCode === 1008 || extraCode === 'error', String(extraCode));
  for (const ws of held) { try { ws.close(); } catch (e) { /* done */ } }
} catch (e) {
  failures++;
  console.log('SUITE ERROR: ' + (e && e.stack || e));
} finally {
  for (const ws of sockets) { try { ws.close(); } catch (e) { /* done */ } }
  server.kill('SIGTERM');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
}
console.log('---\nchecks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
