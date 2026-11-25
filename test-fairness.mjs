// KOL-17: play credit, paid seats are never bot seats, and a dropped
// socket pauses the table until the player reconnects.
import { spawn } from 'child_process';
import { createRequire } from 'module';
import WebSocket from 'ws';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { createPlayCredit } = require('./play-credit.js');
const gameData = require('./public/game-data.js');

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const book = createPlayCredit({ memory: true });
const first = book.grant({ id: 'credit:RFFU:a_test', accountId: 'a_test', kobo: 20000, reason: 'unfair AFK takeover before pause rule', roomCode: 'RFFU', by: 'owner' });
const again = book.grant({ id: 'credit:RFFU:a_test', accountId: 'a_test', kobo: 20000, reason: 'again', roomCode: 'RFFU', by: 'owner' });
check('a credit grant is idempotent by id', first.ok && first.balanceKobo === 20000 && again.already && again.balanceKobo === 20000);
const spent = book.spend('a_test', 20000, 'paid seat', 'NEXT');
check('a full seat fee spends the credit', spent.ok && spent.balanceKobo === 0 && book.balance('a_test') === 0);
check('a short balance does not spend', !book.spend('a_test', 20000, 'paid seat', 'NEXT').ok);

const party = gameData.SPACES.find((s) => s.name === 'Party Rentals');
check('Party Rentals rent ladder starts at 32000 and the perk is not rent', party && party.rent[0] === 32000 && party.rent[1] === 64000 && party.perk.kind === 'potCut' && party.perk.amount === 5000);

function spawnServer(port) {
  const credit = '/tmp/kolopoly-credit-' + port + '.json';
  try { fs.unlinkSync(credit); } catch (e) { /* fresh */ }
  const env = { ...process.env, PORT: String(port), KP_TEST: '1', KP_PERSIST_ROOMS: '1', KP_DATA_DIR: '/tmp/kolopoly-fair-' + port, KP_PLAY_CREDIT_FILE: credit, KP_AUTH_SECRET: 'fair' };
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('boot\n' + logs)), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('Kolopoly listening')) { clearTimeout(timer); resolve(); } });
  });
  return { child, ready };
}
function socket(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port);
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
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (box.state && pred(box.state)) return;
    await sleep(40);
  }
  throw new Error(label);
}

const port = 4515;
const server = spawnServer(port);
await server.ready;
try {
  const host = await socket(port);
  send(host, 'create_room', { name: 'Kiji', token: 'big-man', mode: 'online', settings: { gameMode: 'classic', timed: false, turnTimerSec: 0 } });
  await waitFor(host, (s) => s.status === 'lobby', 'lobby');
  const guest = await socket(port);
  send(guest, 'join_room', { code: host.state.code, name: 'Mobolaji', token: 'suya' });
  await waitFor(host, (s) => s.players.length === 2, 'joined');
  send(host, 'start_game', {});
  await waitFor(host, (s) => s.status === 'playing', 'playing');
  const code = host.state.code;
  const guestId = guest.joined.playerId;
  const token = guest.joined.token;
  guest.ws.close();
  await waitFor(host, (s) => s.paused && s.linkWait && s.linkWait.name === 'Mobolaji', 'paused for reconnect');
  check('a dropped seat pauses the table with their name', host.state.paused && host.state.linkWait.name === 'Mobolaji');
  const back = await socket(port);
  send(back, 'rejoin', { code, playerId: guestId, token });
  await waitFor(host, (s) => !s.paused && !s.linkWait, 'resumed');
  check('reconnect clears the pause', !host.state.paused && !host.state.linkWait);
  const still = host.state.players.find((p) => p.id === guestId);
  check('the returned seat is still human', still && !still.bot);

  send(host, 'test_set_paid', { playerId: guestId, fee: 200, accountId: 'a_mobo' });
  await waitFor(host, (s) => s.paid && s.paid.fee === 200, 'marked paid');
  send(host, 'test_idle_for', { playerId: guestId, ms: 200000 });
  await sleep(900);
  const after = host.state.players.find((p) => p.id === guestId);
  check('a paid seat is not taken by an AFK bot', after && !after.bot, JSON.stringify(after && { bot: after.bot, name: after.name }));
  host.ws.close();
  back.ws.close();
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  server.child.kill();
}
console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
