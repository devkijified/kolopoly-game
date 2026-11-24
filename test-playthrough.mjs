// Paid tables and a live match, the way a phone plays them.
// Private Inflation and Classic, both seats pay, the game waits for
// every seat, Classic runs the hour clock, nobody gets an End button,
// a resignation pays the other seat, a drop reconnects, and an idle
// seat is taken over on the fast AFK clock. Quick play stays free.
// Run: node test-playthrough.mjs
import { spawn } from 'child_process';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';

let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; } catch (e) { console.log('SKIP: puppeteer-core missing'); process.exit(0); }
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: Chrome missing'); process.exit(0); }

const PORT = 4276;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-play-'));
let checks = 0, failures = 0;
const check = (name, cond, extra) => {
  checks++;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures++; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), KP_TEST: '1', KP_AFK_FAST: '1', KP_DATA_DIR: dir, KP_PERSIST_ROOMS: '',
    RESEND_API_KEY: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
    KP_AUTH_SECRET: 'playthrough-secret'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

function rawClient(name) {
  const c = { name, state: null, playerId: null, token: null, ws: null };
  c.connect = () => new Promise((resolve, reject) => {
    c.ws = new WebSocket(WS);
    c.ws.on('open', resolve);
    c.ws.on('error', reject);
    c.ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type === 'joined') { c.playerId = msg.playerId; c.token = msg.token || c.token; }
      if (msg.type === 'state') c.state = msg.room;
    });
  });
  c.send = (type, obj) => c.ws.send(JSON.stringify(Object.assign({ type }, obj || {})));
  c.wait = (pred, label, ms) => {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (c.state && pred(c.state)) return resolve(c.state);
        if (Date.now() - t0 > (ms || 8000)) return reject(new Error(label || 'timeout'));
        setTimeout(tick, 40);
      };
      tick();
    });
  };
  return c;
}

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
try {
  for (let i = 0; i < 80 && !log.includes('listening'); i++) await sleep(50);
  async function signIn(email) {
    const req = await (await fetch(BASE + '/api/auth/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })).json();
    return await (await fetch(BASE + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: req.devCode }) })).json();
  }
  const ada = await signIn('ada-play@example.com');
  const bola = await signIn('bola-play@example.com');

  async function phone(session, email, name) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument((t, e, n) => {
      localStorage.setItem('kolopolyAuthToken', t);
      localStorage.setItem('kolopolyAuthEmail', e);
      localStorage.setItem('kolopolyName', n);
    }, session.token, email, name);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => typeof window.__kolopolySend === 'function', { timeout: 8000 });
    return page;
  }
  async function state(page) {
    return page.evaluate(() => window.__kolopolyState());
  }

  const host = await phone(ada, 'ada-play@example.com', 'Ada');
  await host.evaluate((t) => window.__kolopolySend('create_room', { name: 'Ada', token: 'danfo', mode: 'online', cityId: 'lagos', authToken: t, settings: { gameMode: 'inflation' } }), ada.token);
  await host.waitForSelector('#paySeatBtn', { visible: true, timeout: 8000 });
  const infCopy = await host.evaluate(() => document.querySelector('.paid-panel .caption').textContent);
  check('a private Inflation table tells the seven phases, not a fake hour clock', /seven inflation phases/.test(infCopy) && !/60 minute/.test(infCopy), infCopy);
  const startLocked = await host.evaluate(() => document.getElementById('startBtn').disabled);
  check('start stays locked until every seat has paid', startLocked === true);
  const code = (await state(host)).code;

  const guest = rawClient('Bola');
  await guest.connect();
  guest.send('join_room', { code, name: 'Bola', token: 'keke', authToken: bola.token });
  await guest.wait((s) => s.players.length === 2, 'bola seated');
  await host.click('#paySeatBtn');
  guest.send('pay_seat', {});
  await host.waitForFunction(() => {
    const s = window.__kolopolyState();
    return s && s.paid && s.paid.allPaid && s.players.every((p) => p.paidSeat);
  }, { timeout: 8000 });
  await guest.wait((s) => s.paid && s.paid.allPaid && s.players.every((p) => p.paidSeat), 'bola sees paid');
  const hostPaidUi = await host.evaluate(() => !document.getElementById('paySeatBtn') && /don pay/.test(document.body.innerText));
  check('both seats see the table fully paid', hostPaidUi && guest.state.players.every((p) => p.paidSeat));
  const startOpen = await host.evaluate(() => document.getElementById('startBtn').disabled === false);
  check('start opens only when the table is fully paid', startOpen);
  await host.click('#startBtn');
  await host.waitForFunction(() => window.__kolopolyState().status === 'playing', { timeout: 8000 });
  await sleep(400);
  const playing = await host.evaluate(() => {
    const s = window.__kolopolyState();
    return { end: !!document.getElementById('sbEndRoom'), ends: s.gameEndsAt, inf: !!(s.inf) };
  });
  check('Inflation paid has no End button and runs on phases', playing.end === false && playing.ends == null && playing.inf, JSON.stringify(playing));
  guest.send('resign', {});
  await host.waitForFunction(() => {
    const s = window.__kolopolyState();
    return s && s.status === 'ended' && s.prize;
  }, { timeout: 8000 });
  const prize = await host.evaluate(() => {
    const s = window.__kolopolyState();
    const el = document.querySelector('#endOverlay .p2e-prize');
    return { pot: s.prize && s.prize.pot, winner: s.prize && s.prize.winner, house: s.prize && s.prize.house, text: el ? el.textContent : '' };
  });
  check('the winner phone shows ₦360 from a ₦400 pot', prize.pot === 400 && prize.winner === 360 && prize.house === 40 && /360/.test(prize.text), JSON.stringify(prize));

  const classicHost = await phone(ada, 'ada-play@example.com', 'Ada');
  await classicHost.evaluate((t) => window.__kolopolySend('create_room', { name: 'Ada', token: 'okada', mode: 'online', cityId: 'lagos', authToken: t, settings: { gameMode: 'classic' } }), ada.token);
  await classicHost.waitForSelector('#paySeatBtn', { timeout: 8000 });
  const classicCopy = await classicHost.evaluate(() => document.querySelector('.paid-panel .caption').textContent);
  check('a private Classic table names the 60 minute clock', /60 minute/.test(classicCopy), classicCopy);
  const classicCode = (await state(classicHost)).code;
  const classicGuest = rawClient('BolaClassic');
  await classicGuest.connect();
  classicGuest.send('join_room', { code: classicCode, name: 'Bola', token: 'generator', authToken: bola.token });
  await classicGuest.wait((s) => s.players.length === 2, 'classic guest seated');
  await classicHost.click('#paySeatBtn');
  classicGuest.send('pay_seat', {});
  await classicHost.waitForFunction(() => {
    const s = window.__kolopolyState();
    return s && s.paid && s.paid.allPaid;
  }, { timeout: 8000 });
  await classicHost.click('#startBtn');
  await classicHost.waitForFunction(() => window.__kolopolyState().status === 'playing', { timeout: 8000 });
  const clock = await classicHost.evaluate(() => {
    const s = window.__kolopolyState();
    return { left: s.gameEndsAt - Date.now(), endBtn: !!document.getElementById('sbEndRoom') };
  });
  check('Classic paid starts a one hour clock and hides End', clock.left > 59 * 60 * 1000 && clock.left < 61 * 60 * 1000 && clock.endBtn === false, JSON.stringify(clock));

  const cashBefore = (await state(classicHost)).players.find((p) => p.name === 'Ada').cash;
  await classicHost.evaluate(() => window.__kolopolyDrop());
  await classicHost.waitForFunction((before) => {
    const s = window.__kolopolyState();
    const me = s && s.players && s.players.find((p) => p.name === 'Ada');
    return s && s.status === 'playing' && me && me.cash === before && me.connected;
  }, { timeout: 10000 }, cashBefore);
  check('a dropped phone reconnects to the same cash', true);

  const q = rawClient('Quick');
  await q.connect();
  q.send('quick_join', { name: 'Quick', token: 'danfo', gameMode: 'classic' });
  await q.wait((s) => s.status === 'lobby');
  check('quick play stays a free public table', q.state.isPublic === true && q.state.paid == null);

  const h = rawClient('IdleHost');
  const g = rawClient('IdleGuest');
  await h.connect();
  await g.connect();
  h.send('create_room', { name: 'IdleHost', token: 'danfo', mode: 'online', settings: { gameMode: 'classic', timed: false, turnTimerSec: 0 } });
  await h.wait((s) => s.players.length === 1);
  g.send('join_room', { code: h.state.code, name: 'IdleGuest', token: 'keke' });
  await h.wait((s) => s.players.length === 2);
  h.send('start_game', {});
  await h.wait((s) => s.status === 'playing');
  const afkClose = new Promise((resolve) => {
    const note = (code) => { if (code === 4002) resolve(code); };
    h.ws.on('close', note);
    g.ws.on('close', note);
  });
  const afkCode = await Promise.race([afkClose, sleep(12000).then(() => 0)]);
  check('an idle phone is closed so a bot can hold the seat', afkCode === 4002, 'close ' + afkCode);
} catch (e) {
  failures++;
  console.log('SUITE ERROR: ' + (e && e.stack || e));
  if (log) console.log(log.slice(-500));
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
}
console.log('---\nchecks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
