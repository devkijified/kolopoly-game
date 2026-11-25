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
function send(box, type, payload) { box.error = null; box.ws.send(JSON.stringify(Object.assign({ type }, payload || {}))); }
async function waitFor(box, pred, label) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (box.state && pred(box.state)) return;
    await sleep(40);
  }
  const snap = box.state ? { step: box.state.practice, phase: box.state.phase, turn: box.state.turnPlayerId, pos: (box.state.players || []).map((p) => p.name + '@' + p.position), err: box.error } : box.error;
  throw new Error(label + ' ' + JSON.stringify(snap));
}

const port = 4551;
const server = spawnServer(port);
await server.ready;
try {
  const me = await socket(port);
  send(me, 'create_room', { name: 'Kiji', token: 'big-man', mode: 'online', practice: true, clientId: 'train-device-1111', settings: { gameMode: 'classic' } });
  await waitFor(me, (s) => s.practice && s.practice.step === 'hello' && s.status === 'playing', 'hello');
  check('the intro starts unpaid on the real board', !me.state.paid && me.state.practice.kind === 'intro' && me.state.practice.n === 1 && me.state.practice.of === 12);
  check('Ada is seated and the lesson names the aim', me.state.players.some((p) => p.name === 'Ada' && p.bot) && /broke/.test(me.state.practice.line));
  send(me, 'roll', {});
  await sleep(300);
  check('a roll before the roll lesson does not move the token', me.state.practice.step === 'hello' && me.state.players.find((p) => p.name === 'Kiji').position === 0);
  send(me, 'practice_ack', { what: 'next' });
  await waitFor(me, (s) => s.practice.step === 'cash', 'cash');
  send(me, 'practice_ack', { what: 'next' });
  await waitFor(me, (s) => s.practice.step === 'roll', 'roll');
  check('the roll lesson spotlights the dice and is step 3', me.state.practice.target === '#abRoll' && me.state.practice.n === 3);
  send(me, 'roll', {});
  await waitFor(me, (s) => s.practice.step === 'walked' && s.players.find((p) => p.name === 'Kiji').position === 4, 'landed');
  check('the roll stops on the explanation instead of skipping ahead', me.state.practice.step === 'walked' && /Ajegunle/.test(me.state.practice.line));
  send(me, 'buy', {});
  await sleep(200);
  check('buying is refused until the deed lesson says buy', me.state.practice.step === 'walked' && !(me.state.props[4] && me.state.props[4].o));
  send(me, 'practice_ack', { what: 'next' });
  await waitFor(me, (s) => s.practice.step === 'deed', 'deed');
  send(me, 'practice_ack', { what: 'deed' });
  await waitFor(me, (s) => s.practice.step === 'deedread', 'read');
  send(me, 'practice_ack', { what: 'next' });
  await waitFor(me, (s) => s.practice.step === 'buy', 'buy');
  send(me, 'buy', {});
  await waitFor(me, (s) => s.practice.step === 'bought', 'bought');
  const mine = me.state.players.find((p) => p.name === 'Kiji');
  const cashAfterBuy = mine.cash;
  check('buying pauses to show the cash and the deed', me.state.practice.step === 'bought' && /cash went down/.test(me.state.practice.line) && me.state.props[4] && me.state.props[4].o === mine.id);
  const tap = async (id) => {
    send(me, 'practice_ack', { what: 'next' });
    await waitFor(me, (s) => s.practice.step === id, id);
  };
  await tap('endturn');
  send(me, 'end_turn', {});
  await waitFor(me, (s) => s.practice.step === 'adacheer', 'ada paid');
  const afterAda = me.state.players.find((p) => p.name === 'Kiji').cash;
  check('Ada lands on Ajegunle and the lesson pauses on the rent', me.state.players.find((p) => p.name === 'Ada').position === 4 && afterAda > cashAfterBuy);
  await tap('paytalk');
  await tap('payroll');
  send(me, 'roll', {});
  await waitFor(me, (s) => s.practice.step === 'paidcheer' && s.players.find((p) => p.name === 'Kiji').position === 8, 'paid ada');
  check('landing on Ada’s place pauses before the next lesson', me.state.practice.step === 'paidcheer' && me.state.players.find((p) => p.name === 'Kiji').cash < afterAda);
  await tap('badtalk');
  await tap('badroll');
  send(me, 'roll', {});
  await waitFor(me, (s) => s.practice.step === 'badcheer' && s.lastCard && s.lastCard.id === 'w09', 'bad card');
  check('the bad card is NEPA and the lesson does not skip it', me.state.practice.step === 'badcheer');
  await tap('gooddraw');
  send(me, 'practice_draw', {});
  await waitFor(me, (s) => s.practice.step === 'goodcheer' && s.lastCard && s.lastCard.id === 'w06', 'good card');
  const afterGood = me.state.players.find((p) => p.name === 'Kiji').cash;
  check('the good card pays the player and then waits', me.state.practice.step === 'goodcheer');
  await tap('timer');
  check('the turn clock is on for the timer lesson', me.state.turnDeadline > 0 && me.state.practice.target === '.timer-ring');
  await tap('timerroll');
  send(me, 'roll', {});
  await waitFor(me, (s) => s.practice.step === 'starttalk' && s.players.find((p) => p.name === 'Kiji').position === 27, 'marina');
  await tap('startroll');
  send(me, 'roll', {});
  await waitFor(me, (s) => s.practice.step === 'startcheer' && s.players.find((p) => p.name === 'Kiji').position === 5 && s.phase === 'tax', 'salary and bill');
  check('passing START pays salary before the bill', me.state.players.find((p) => p.name === 'Kiji').cash > afterGood && me.state.phase === 'tax');
  await tap('bill');
  send(me, 'tax_choice', { choice: 'flat' });
  await waitFor(me, (s) => s.practice.step === 'billcheer', 'bill paid');
  await tap('deals');
  send(me, 'practice_ack', { what: 'deals' });
  await waitFor(me, (s) => s.practice.step === 'dealcheer', 'deals');
  await tap('wintalk');
  await tap('freeplay');
  check('free play inside the lesson unlocks the dice', me.state.practice.action === 'free');
  send(me, 'roll', {});
  await sleep(200);
  check('a free-play roll does not skip to the badge', me.state.practice.step === 'freeplay');
  send(me, 'practice_ack', { what: 'trained' });
  await waitFor(me, (s) => s.practice.step === 'ready', 'badge');
  check('the lesson ends on the trained step', me.state.practice.step === 'ready' && /ready/.test(me.state.practice.title));

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
