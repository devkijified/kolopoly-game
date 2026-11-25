// Training Ground: the intro waits for a tap, scripted dice teach one
// idea at a time, and free practice is an unpaid table with friendly bots.
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
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

const appSrc = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const realClick = appSrc.match(/dataset\.act === 'real'[\s\S]{0,90}/);
const endReal = appSrc.match(/const real = \$\('endReal'\);[\s\S]{0,140}/);
check('the coach Play-real button leaves training', !!(realClick && realClick[0].includes('exitTrainingHome') && !realClick[0].includes('KPStartPractice')));
check('the final-table Play-real button leaves training', !!(endReal && endReal[0].includes('exitTrainingHome') && !endReal[0].includes("KPStartPractice('free')")));
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
    if (msg.type === 'state') {
      box.state = msg.room;
      const prac = msg.room && msg.room.practice;
      const line = prac && prac.line;
      const id = prac && prac.step;
      if (line && id && prac.kind === 'intro' && !box.seenLines) box.seenLines = {};
      if (line && id && prac.kind === 'intro' && !box.seenLines[id]) {
        box.seenLines[id] = line;
        const n = line.trim().split(/\s+/).filter(Boolean).length;
        if (n > 8 || /monopoly/i.test(line)) check('lesson line stays short', false, id + ' ' + line);
      }
    }
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
  check('Ada is seated and the lesson names the aim', me.state.players.some((p) => p.name === 'Ada' && p.bot) && /wins/.test(me.state.practice.line));
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
  send(me, 'practice_ack', { what: 'back' });
  await sleep(150);
  check('back from the landing stays put because the roll already happened', me.state.practice.step === 'walked');
  send(me, 'practice_ack', { what: 'next' });
  await waitFor(me, (s) => s.practice.step === 'buy' && s.phase === 'buy' && s.practice.target === '#abBuy', 'buy');
  send(me, 'practice_ack', { what: 'back' });
  await waitFor(me, (s) => s.practice.step === 'walked', 'back to landing');
  send(me, 'practice_ack', { what: 'next' });
  await waitFor(me, (s) => s.practice.step === 'buy', 'buy again');
  send(me, 'buy', {});
  await waitFor(me, (s) => s.practice.step === 'bought', 'bought');
  const mine = me.state.players.find((p) => p.name === 'Kiji');
  const cashAfterBuy = mine.cash;
  check('buying pauses to show the cash and the deed', me.state.practice.step === 'bought' && /Cash dropped/.test(me.state.practice.line) && me.state.props[4] && me.state.props[4].o === mine.id);
  const tap = async (id) => {
    send(me, 'practice_ack', { what: 'next' });
    await waitFor(me, (s) => s.practice.step === id, id);
  };
  await tap('endturn');
  send(me, 'end_turn', {});
  let afterAda = 0;
  await waitFor(me, (s) => {
    const kiji = s.players.find((p) => p.name === 'Kiji');
    const ada = s.players.find((p) => p.name === 'Ada');
    if (s.practice.step === 'adacheer' && ada && ada.position === 4 && kiji.cash > cashAfterBuy) {
      afterAda = kiji.cash;
      return true;
    }
    return false;
  }, 'ada paid');
  check('Ada lands on Ajegunle and the lesson pauses on the rent', afterAda > cashAfterBuy);
  await tap('payroll');
  send(me, 'roll', {});
  await waitFor(me, (s) => {
    const meP = s.players.find((p) => p.name === 'Kiji');
    return s.practice.step === 'paidcheer' && meP.position === 8 && meP.cash < afterAda;
  }, 'paid ada');
  const paidCash = me.state.players.find((p) => p.name === 'Kiji').cash;
  const adaOwns = me.state.props[8] && me.state.props[8].o;
  check('landing on Ada’s place pauses before the next lesson', me.state.practice.step === 'paidcheer' && paidCash < afterAda, 'cash ' + afterAda + ' -> ' + paidCash + ' owner ' + adaOwns + ' phase ' + me.state.phase);
  await tap('cardroll');
  send(me, 'roll', {});
  await waitFor(me, (s) => s.practice.step === 'cardcheer' && s.lastCard && s.lastCard.id === 'w09', 'card');
  check('the card is NEPA and the lesson waits on it', me.state.practice.step === 'cardcheer' && me.state.practice.sheet === 'card');
  const afterCard = me.state.players.find((p) => p.name === 'Kiji').cash;
  await tap('jailroll');
  send(me, 'roll', {});
  await waitFor(me, (s) => s.practice.step === 'jail' && s.phase === 'jail', 'jail');
  check('jail offers bail as the glowing action', me.state.practice.target === '#abJailPay' && me.state.players.find((p) => p.name === 'Kiji').position === 7);
  send(me, 'jail_pay', {});
  await waitFor(me, (s) => s.practice.step === 'walk1' && s.phase === 'roll', 'out of jail');
  send(me, 'roll', {});
  await waitFor(me, (s) => s.practice.step === 'salary' && s.players.find((p) => p.name === 'Kiji').position === 18, 'near start');
  check('an unowned square on the way does not open a buy prompt', me.state.phase === 'roll' && me.state.practice.step === 'salary');
  send(me, 'roll', {});
  await waitFor(me, (s) => s.practice.step === 'salarycheer' && s.players.find((p) => p.name === 'Kiji').position === 0, 'salary');
  check('passing START pays salary', me.state.players.find((p) => p.name === 'Kiji').cash > afterCard);
  await tap('buildtalk');
  await waitFor(me, (s) => s.props[2] && s.props[2].o && s.props[6] && s.props[6].o, 'set granted');
  await tap('build');
  send(me, 'build', { space: 4, kind: 'duplex' });
  await waitFor(me, (s) => s.practice.step === 'built' && s.props[4] && s.props[4].b >= 1, 'built');
  check('building a duplex finishes that beat', me.state.practice.step === 'built');
  await tap('deals');
  send(me, 'practice_ack', { what: 'deals' });
  await waitFor(me, (s) => s.practice.step === 'dealseen', 'deals');
  await tap('win');
  await tap('ready');
  check('the lesson ends on Trained', me.state.practice.step === 'ready' && /Trained/.test(me.state.practice.title));
  check('a finished lesson leaves no target behind', me.state.practice.action === 'stay' && !me.state.practice.target);

  const late = await socket(port);
  send(late, 'create_room', { name: 'Late', token: 'gele', mode: 'online', practice: true, clientId: 'train-device-3333', settings: { gameMode: 'classic' } });
  await waitFor(late, (s) => s.practice && s.practice.step === 'hello', 'late hello');
  send(late, 'test_delay_buy', {});
  send(late, 'practice_ack', { what: 'next' });
  await waitFor(late, (s) => s.practice.step === 'cash', 'late cash');
  send(late, 'practice_ack', { what: 'next' });
  await waitFor(late, (s) => s.practice.step === 'roll', 'late roll');
  send(late, 'roll', {});
  await waitFor(late, (s) => s.practice.step === 'walked', 'late landed');
  send(late, 'practice_ack', { what: 'next' });
  await waitFor(late, (s) => s.practice.step === 'buy' && s.phase !== 'buy', 'buy withheld');
  send(late, 'practice_recover', {});
  await sleep(200);
  check('a held buy prompt stays hidden until the test releases it', late.state.practice.step === 'buy' && late.state.phase !== 'buy');
  send(late, 'test_release_buy', {});
  await waitFor(late, (s) => s.phase === 'buy' && s.buySpace === 4, 'buy released');
  check('releasing the buy prompt puts Buy back on the table', late.state.phase === 'buy' && late.state.practice.target === '#abBuy');

  const free = await socket(port);
  send(free, 'create_room', { name: 'Adaeze', token: 'gele', mode: 'online', practice: 'free', clientId: 'train-device-2222', settings: { gameMode: 'classic' } });
  await waitFor(free, (s) => s.practice && s.practice.kind === 'free', 'free');
  check('free practice is unpaid and seats two friendly bots', !free.state.paid && free.state.players.filter((p) => p.bot).length === 2 && free.state.players.some((p) => p.name === 'Tunde'), JSON.stringify(free.state.players.map((p) => p.name)));
  const resign = await socket(port);
  send(resign, 'create_room', { name: 'Kiji', token: 'big-man', mode: 'online', practice: true, clientId: 'train-device-resign', settings: { gameMode: 'classic' } });
  await waitFor(resign, (s) => s.practice && s.practice.step === 'hello' && s.status === 'playing', 'resign hello');
  send(resign, 'resign', {});
  await waitFor(resign, (s) => s.status === 'ended' && s.practice && s.practice.step === 'ready', 'resign ended');
  check('resign stops the lesson', resign.state.practice.action === 'stay' && !resign.state.practice.target && resign.state.practice.ended === true);
  check('resign makes Ada the winner', resign.state.endReason === 'resignation' && resign.state.winner && resign.state.winner.name === 'Ada');
  check('resign does not carry the wrong-tap line', !/No be that one/.test(resign.state.practice.line || ''));
  send(resign, 'practice_recover', {});
  await sleep(200);
  check('a recover after the game ended does not bring the lesson back', resign.state.status === 'ended' && resign.state.practice.step === 'ready' && !resign.state.practice.target);

  const botWin = await socket(port);
  send(botWin, 'create_room', { name: 'Kiji', token: 'big-man', mode: 'online', practice: true, clientId: 'train-device-bot', settings: { gameMode: 'classic' } });
  await waitFor(botWin, (s) => s.practice && s.practice.step === 'hello', 'bot hello');
  send(botWin, 'test_bot_win', {});
  await waitFor(botWin, (s) => s.status === 'ended' && s.practice && s.practice.step === 'ready', 'bot ended');
  check('a bot win stops the lesson', botWin.state.practice.action === 'stay' && !botWin.state.practice.target);
  check('a bot win names the bot', botWin.state.winner && botWin.state.winner.name === 'Ada' && botWin.state.endTable.some((r) => r.name === 'Kiji' && r.bankrupt));

  me.ws.close();
  late.ws.close();
  free.ws.close();
  resign.ws.close();
  botWin.ws.close();
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
