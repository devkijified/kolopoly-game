// Training Ground: the intro waits for a tap, scripted dice teach one
// idea at a time, and free practice is an unpaid table with friendly bots.
import { spawn } from 'child_process';
import { createRequire } from 'module';
import WebSocket from 'ws';
const require = createRequire(import.meta.url);
const gameData = require('./public/game-data.js');

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

check('a collect card is good news', gameData.cardMood('bankPays') === 'good' && /Collect/.test(gameData.cardCaption('bankPays')));
check('NEPA blackout is bad news', gameData.cardMood('nepaLight') === 'bad' && /NEPA/.test(gameData.cardCaption('nepaLight')));

function spawnServer(port) {
  const env = { ...process.env, PORT: String(port), KP_TEST: '1', KP_PERSIST_ROOMS: '', KP_AUTH_SECRET: 'train', RESEND_API_KEY: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' };
  delete env.KP_ADMIN_TOKEN;
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
  const box = { ws, state: null, error: null };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'state') box.state = msg.room;
    if (msg.type === 'error') box.error = msg;
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
  throw new Error(label + ' ' + JSON.stringify(box.error || (box.state && box.state.practice)));
}

const port = 4551;
const server = spawnServer(port);
await server.ready;
try {
  const me = await socket(port);
  send(me, 'create_room', { name: 'Kiji', token: 'big-man', mode: 'online', practice: true, clientId: 'train-device-1111', settings: { gameMode: 'classic' } });
  await waitFor(me, (s) => s.practice && s.practice.step === 'hello' && s.status === 'playing', 'hello');
  check('the intro starts unpaid on the real board', !me.state.paid && me.state.practice.kind === 'intro' && me.state.practice.wait === 'tap');
  check('Ada is seated and the lesson names the aim', me.state.players.some((p) => p.name === 'Ada' && p.bot) && /broke/.test(me.state.practice.line));
  send(me, 'practice_ack', { what: 'next' });
  await waitFor(me, (s) => s.practice.step === 'cash', 'cash');
  send(me, 'practice_ack', { what: 'next' });
  await waitFor(me, (s) => s.practice.step === 'tile', 'tile');
  send(me, 'practice_ack', { what: 'next' });
  await waitFor(me, (s) => s.practice.step === 'roll', 'roll');
  check('the roll lesson points at the dice', me.state.practice.target === '#abRoll');
  send(me, 'roll', {});
  await waitFor(me, (s) => s.practice.step === 'whybuy' && s.players.find((p) => p.name === 'Kiji').position === 4, 'landed');
  check('scripted dice land on Ajegunle and Big Daddy explains buying', me.state.practice.step === 'whybuy');
  send(me, 'practice_ack', { what: 'next' });
  await waitFor(me, (s) => s.practice.step === 'buy', 'buy prompt');
  send(me, 'buy', {});
  await waitFor(me, (s) => s.practice.step === 'cheerbuy', 'cheer');
  const mine = me.state.players.find((p) => p.name === 'Kiji');
  check('buying celebrates and the deed is yours', me.state.practice.title.indexOf('paper') >= 0 && me.state.props[4] && me.state.props[4].o === mine.id);

  const free = await socket(port);
  send(free, 'create_room', { name: 'Adaeze', token: 'gele', mode: 'online', practice: 'free', clientId: 'train-device-2222', settings: { gameMode: 'classic' } });
  await waitFor(free, (s) => s.practice && s.practice.kind === 'free', 'free');
  check('free practice is unpaid and seats two friendly bots', !free.state.paid && free.state.players.filter((p) => p.bot).length === 2 && free.state.players.some((p) => p.name === 'Tunde'), JSON.stringify(free.state.players.map((p) => p.name)));
  me.ws.close();
  free.ws.close();
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
