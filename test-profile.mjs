// An AFK-taken human is still a human: the match records a win and a loss
// under their real name, and the pay-them-back banner reads the live score.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function liveScore(view) {
  const row = view && view.rematch;
  const live = ((view && view.rivalries) || []).find((r) => r && row && r.id === row.to);
  return {
    wins: live ? (live.wins || 0) : ((row && row.wins) || 0),
    losses: live ? (live.losses || 0) : ((row && row.losses) || 0)
  };
}
const stale = liveScore({
  rematch: { to: 'acct:kiji', name: 'Mobolaji', wins: 0, losses: 0 },
  rivalries: [{ id: 'acct:kiji', name: 'Kiji', wins: 0, losses: 1 }]
});
check('the banner uses the live rivalry, not the old 0-0 snapshot', stale.wins === 0 && stale.losses === 1);

function whisperOn(s) {
  if (!s.browser || s.denied) return false;
  if (s.subscribed && !s.serverMuted) return true;
  if (s.localMuted || s.serverMuted) return false;
  return s.permission === 'granted' && s.subscribed;
}
check('a turned-on subscription stays on even if the phone still has a mute bit and sound is off', whisperOn({
  browser: true, denied: false, subscribed: true, serverMuted: false, localMuted: true, soundOff: true, permission: 'granted'
}));
check('an explicit mute still reads as off', !whisperOn({
  browser: true, denied: false, subscribed: true, serverMuted: true, localMuted: true, permission: 'granted'
}));

function spawnServer(port, file) {
  const env = {
    ...process.env, PORT: String(port), KP_TEST: '1', KP_PERSIST_ROOMS: '',
    KP_RETENTION_FILE: file, KP_AUTH_SECRET: 'profile', RESEND_API_KEY: '',
    SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: ''
  };
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('boot\n' + logs)), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('Kolopoly listening')) { clearTimeout(timer); resolve(); } });
  });
  return { child, ready, logs: () => logs };
}
function socket(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  const box = { ws, state: null };
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolopoly-profile-'));
const file = path.join(dir, 'retention.json');
const port = 4577;
const server = spawnServer(port, file);
await server.ready;
try {
  const kiji = await socket(port);
  send(kiji, 'create_room', { name: 'Kiji', token: 'big-man', mode: 'online', clientId: 'profile-kiji-1111', settings: { gameMode: 'classic', timed: false, turnTimerSec: 0 } });
  await waitFor(kiji, (s) => s.status === 'lobby', 'lobby');
  const mobo = await socket(port);
  send(mobo, 'join_room', { code: kiji.state.code, name: 'Mobolaji', token: 'suya', clientId: 'profile-mobo-2222' });
  await waitFor(kiji, (s) => s.players.length === 2, 'joined');
  send(kiji, 'start_game', {});
  await waitFor(kiji, (s) => s.status === 'playing', 'playing');
  const moboId = kiji.state.players.find((p) => p.name === 'Mobolaji').id;
  const kijiId = kiji.state.players.find((p) => p.name === 'Kiji').id;
  send(kiji, 'test_afk_human', { playerId: moboId, humanName: 'Mobolaji', displayName: 'Mobolaji BOT' });
  await waitFor(kiji, (s) => s.players.find((p) => p.id === moboId).afkTaken, 'afk');
  send(kiji, 'test_end_game', { winnerId: kijiId });
  await waitFor(kiji, (s) => s.status === 'ended', 'ended');
  const table = kiji.state.endTable.find((r) => r.playerId === moboId);
  check('the final table uses the human name, not the bot label', table && table.name === 'Mobolaji' && table.afkTaken, JSON.stringify(table && { name: table.name, bot: table.bot, afk: table.afkTaken }));
  await sleep(200);
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const shelves = db.players || {};
  const kijiShelf = shelves['profile-kiji-1111'];
  const moboShelf = shelves['profile-mobo-2222'];
  const kijiRow = kijiShelf && kijiShelf.rivalries && kijiShelf.rivalries['profile-mobo-2222'];
  const moboRow = moboShelf && moboShelf.rivalries && moboShelf.rivalries['profile-kiji-1111'];
  check('Kiji is recorded as the winner against Mobolaji', kijiRow && kijiRow.wins === 1 && kijiRow.name === 'Mobolaji', JSON.stringify(kijiRow));
  check('the AFK human is recorded as the loser under their real name', moboRow && moboRow.losses === 1 && moboRow.name === 'Kiji', JSON.stringify(moboRow));
  check('both humans are marked as having played', !!(kijiShelf && kijiShelf.playedDays) && !!(moboShelf && moboShelf.playedDays));
  check('the profile stats use that same result', kijiShelf.stats && kijiShelf.stats.wins === 1 && moboShelf.stats && moboShelf.stats.losses === 1);
  kiji.ws.close();
  mobo.ws.close();
} catch (e) {
  console.error(e);
  console.error(server.logs());
  failures += 1;
} finally {
  server.child.kill();
}
console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
