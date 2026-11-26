// A free drop never freezes the table. Coming back from a hidden app
// reconnects a closed socket and the seat syncs again.
import { spawn } from 'child_process';
import fs from 'fs';
import vm from 'vm';
import WebSocket from 'ws';

let n = 0, fail = 0;
function check(name, cond, extra) {
  n += 1;
  if (cond) console.log('  ok ' + n + ' - ' + name);
  else { fail += 1; console.log('  FAIL ' + n + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const src = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const start = src.indexOf('function resumeDecision');
const end = src.indexOf('window.KPResume');
const context = {};
vm.createContext(context);
vm.runInContext(src.slice(start, end), context);
const decide = context.resumeDecision;
check('a hidden app with a closed socket reconnects', decide({ hasSeat: true, readyState: 3, lastInbound: 1, now: 5000, hiddenFor: 2000 }) === 'reconnect');
check('a fresh open socket after a short hide stays', decide({ hasSeat: true, readyState: 1, lastInbound: 4900, now: 5000, hiddenFor: 200 }) === 'idle');
check('a socket that went quiet while hidden is stale', decide({ hasSeat: true, readyState: 1, lastInbound: 1, now: 20000, hiddenFor: 15000 }) === 'reconnect');
check('an open socket that still talks is only probed', decide({ hasSeat: true, readyState: 1, lastInbound: 18000, now: 20000, hiddenFor: 2000 }) === 'probe');
check('no seat means no reconnect', decide({ hasSeat: false, readyState: 3, now: 1, hiddenFor: 5000 }) === 'idle');

const PORT = 4662;
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), KP_TEST: '1', KP_ADMIN_TOKEN: '', KP_PERSIST_ROOMS: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('boot')), 8000);
  server.stdout.on('data', (d) => { if (String(d).includes('Kolopoly listening')) { clearTimeout(timer); resolve(); } });
});

function socket() {
  const ws = new WebSocket('ws://127.0.0.1:' + PORT);
  const box = { ws, state: null, joined: null };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'state') box.state = msg.room;
    if (msg.type === 'joined') box.joined = msg;
  });
  return new Promise((resolve) => ws.on('open', () => resolve(box)));
}
function send(box, type, payload) { box.ws.send(JSON.stringify(Object.assign({ type }, payload || {}))); }
async function waitFor(box, pred, label) {
  const startAt = Date.now();
  while (Date.now() - startAt < 8000) {
    if (box.state && pred(box.state)) return;
    await sleep(40);
  }
  throw new Error(label);
}

try {
  const host = await socket();
  send(host, 'create_room', { name: 'Ada', token: 'danfo', mode: 'online', clientId: 'ada-device-1111', settings: { gameMode: 'inflation' } });
  await waitFor(host, (s) => s.status === 'lobby', 'lobby');
  const code = host.state.code;
  const guest = await socket();
  send(guest, 'join_room', { code, name: 'Learner', token: 'keke', clientId: 'learner-device-2222' });
  await waitFor(host, (s) => s.players.length === 2, 'joined');
  send(host, 'start_game', {});
  await waitFor(host, (s) => s.status === 'playing', 'playing');
  const learnerId = guest.joined.playerId;
  const token = guest.joined.token;
  guest.ws.close();
  await waitFor(host, (s) => {
    const p = s.players.find((x) => x.id === learnerId);
    return p && p.bot && p.afkTaken && !s.paused && !s.linkWait;
  }, 'bot holds the seat');
  check('a free drop does not pause or open a hold', host.state.paused === false && !host.state.linkWait);
  check('the table hears a small blink line', (host.state.feed || []).some((e) => /network blink/.test(e.text || '')) || /network blink/.test(host.state.message || ''), JSON.stringify(host.state.feed));

  const back = await socket();
  send(back, 'rejoin', { code, playerId: learnerId, token });
  await waitFor(host, (s) => {
    const p = s.players.find((x) => x.id === learnerId);
    return p && !p.bot && (s.message || '').indexOf('Waiting for Learner') !== 0;
  }, 'back');
  check('coming back reclaims the seat and clears the waiting line', (() => {
    const p = host.state.players.find((x) => x.id === learnerId);
    return p && !p.bot && !host.state.linkWait && (host.state.message || '').indexOf('Waiting for Learner') !== 0;
  })(), host.state.message);

  const paidHost = await socket();
  send(paidHost, 'create_room', { name: 'Kiji', token: 'danfo', mode: 'online', settings: { gameMode: 'classic' } });
  await waitFor(paidHost, (s) => s.status === 'lobby', 'paid lobby');
  const paidGuest = await socket();
  send(paidGuest, 'join_room', { code: paidHost.state.code, name: 'Ada', token: 'gele' });
  await waitFor(paidHost, (s) => s.players.length === 2, 'paid joined');
  send(paidHost, 'start_game', {});
  await waitFor(paidHost, (s) => s.status === 'playing', 'paid playing');
  const kijiId = paidHost.joined.playerId;
  send(paidGuest, 'test_set_paid', { playerId: kijiId, fee: 200 });
  await waitFor(paidGuest, (s) => s.paid && s.paid.fee === 200, 'paid flag');
  paidHost.ws.close();
  await waitFor(paidGuest, (s) => s.paused && s.linkWait && s.linkWait.name === 'Kiji' && s.linkWait.until > Date.now(), 'paid hold');
  check('a paid drop still holds, with a countdown deadline', paidGuest.state.linkWait.until - Date.now() > 10000);
  const kijiBack = await socket();
  send(kijiBack, 'rejoin', { code: paidHost.state.code, playerId: kijiId, token: paidHost.joined.token });
  await waitFor(paidGuest, (s) => !s.linkWait && (s.message || '').indexOf('Waiting for Kiji') !== 0, 'kiji back');
  check('a reconnect clears Waiting for Kiji', (paidGuest.state.message || '').indexOf('Waiting for Kiji') !== 0, paidGuest.state.message);
} catch (e) {
  fail += 1;
  console.log('  FAIL runner :: ' + (e && e.stack || e));
} finally {
  server.kill();
}
console.log(fail ? fail + ' failed' : 'all ' + n + ' passed');
process.exit(fail ? 1 : 0);
