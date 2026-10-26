// KOLOPOLY framing gate for the boxed-in fix (Fix 1). Two full-board frames:
// desktop 1280x800 (Inflation, like the owner's session) and landscape
// 844x390. Every tile name must read plainly in both. Not part of the suites.
import { createRequire } from 'node:module';
const require2 = createRequire('/home/hatch/workspace/mobile-rig/package.json');
const puppeteer = require2('puppeteer-core');
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = 4216;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = '/home/hatch/workspace/mobile-rig/browsers/chrome/linux-155.0.8059.84/chrome-linux64/chrome';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), KP_TEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--ignore-certificate-errors', '--force-device-scale-factor=1']
});
const errors = [];
async function newPage(tag, w, h) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  page.on('pageerror', (e) => errors.push(tag + ': ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(tag + ' console: ' + m.text().slice(0, 160)); });
  return page;
}
const S = (page) => page.evaluate(() => window.__kolopolyState());
const send = (page, type, obj) => page.evaluate((t, o) => window.__kolopolySend(t, o), type, obj || {});
async function waitState(page, pred, label, ms) {
  const src = pred.toString();
  await page.waitForFunction((s) => {
    const st = window.__kolopolyState();
    if (!st) return false;
    return eval(s)(st);
  }, { timeout: ms || 15000, polling: 200 }, src).catch(() => { throw new Error('waitState timeout: ' + label); });
}
async function waitGL(page, label) {
  await page.waitForFunction(() => document.body.classList.contains('gl-on') && !!document.querySelector('canvas.gl-canvas, canvas#glLandingCanvas'), { timeout: 20000, polling: 250 })
    .catch(() => { throw new Error('WebGL layer never activated: ' + label); });
  await sleep(900);
}
async function typeName(page, name) {
  await page.evaluate(() => { document.getElementById('nameIn').value = ''; });
  await page.type('#nameIn', name);
}
async function tap(page, sel) {
  const ok = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
  if (!ok) throw new Error('tap: ' + sel + ' not found');
}

async function stageBoard(page, inflation) {
  await waitGL(page, 'landing');
  await typeName(page, inflation ? 'Dapo' : 'Lara');
  if (inflation) await tap(page, '#gameModeRow [data-gmode="inflation"]');
  await tap(page, '#roomModeRow [data-rmode="pass"]');
  await tap(page, '#createBtn');
  await waitState(page, (s) => s.status === 'lobby', 'lobby');
  await page.evaluate(() => { document.getElementById('localNameIn').value = ''; });
  await page.type('#localNameIn', 'Second');
  await tap(page, '#addLocalBtn');
  await waitState(page, (s) => s.players.length === 2, 'two players');
  await tap(page, '#startBtn');
  await waitState(page, (s) => s.status === 'playing', 'playing');
  const st = await S(page);
  const turnId = st.turnPlayerId;
  const otherId = st.players.find((p) => p.id !== turnId).id;
  for (const sp of [1, 3, 37, 39]) await send(page, 'test_give', { playerId: turnId, space: sp });
  await send(page, 'test_set_cash', { playerId: turnId, amount: 6000000 });
  await send(page, 'test_set_pot', { amount: 200000 });
  async function build(space, wantB) {
    await send(page, 'build', { space, kind: 'duplex' });
    const end = Date.now() + 6000;
    while (Date.now() < end) { const s = await S(page); if (s && s.props[space] && s.props[space].b === wantB) return; await sleep(200); }
    console.log('  build note: ' + space + ' -> ' + wantB + ' not confirmed');
  }
  await build(37, 1); await build(39, 1); await build(37, 2); await build(39, 2);
  await send(page, 'test_set_position', { playerId: turnId, space: 24 });
  await send(page, 'test_set_position', { playerId: otherId, space: 15 });
  await sleep(1200); // buildings rise, tokens settle
  // Landscape IS the full board by default (effectiveFull). Do NOT tap
  // #fullBoardBtn here: toggleView would pin follow instead.
  const full = await page.evaluate(() => window.KPBoard.effectiveFull());
  console.log('  effectiveFull at shot time: ' + full);
  await sleep(4000); // camera holds the full framing; build alerts fade away
  const geo = await page.evaluate(() => {
    const wrap = document.querySelector('.board-wrap');
    const cvs = document.querySelector('canvas.gl-canvas');
    const rr = (el) => el ? (() => { const b = el.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); })() : 'none';
    return 'wrap ' + rr(wrap) + ', canvas ' + rr(cvs) + ', canvasAttr ' + (cvs ? cvs.width + 'x' + cvs.height : 'none');
  });
  console.log('  geometry: ' + geo);
}

try {
  const Dp = await newPage('D', 1280, 800);
  await Dp.goto(BASE, { waitUntil: 'networkidle0' });
  await stageBoard(Dp, true);
  await Dp.screenshot({ path: SHOTS + 'kp4-board-desktop.png' });
  console.log('shot: kp4-board-desktop.png');
  await Dp.close();

  const L = await newPage('L', 844, 390);
  await L.goto(BASE, { waitUntil: 'networkidle0' });
  await stageBoard(L, false);
  await L.screenshot({ path: SHOTS + 'kp4-board-landscape.png' });
  console.log('shot: kp4-board-landscape.png');
  await L.close();
} catch (err) {
  console.log('SHOTS ERROR: ' + err.message);
} finally {
  await browser.close();
  server.kill();
}
console.log('pageErrors: ' + errors.length + (errors.length ? ' :: ' + errors.slice(0, 4).join(' | ') : ''));
