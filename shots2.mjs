// KOLOPOLY graphics overhaul screenshot gate. Drives the KP_TEST server at
// landscape (844x390), portrait (390x844) and desktop (1280x800) sizes and
// saves kp2-*.png frames for human judgement. Not part of the test suites.
import { createRequire } from 'node:module';
const require2 = createRequire('/home/hatch/workspace/mobile-rig/package.json');
const puppeteer = require2('puppeteer-core');
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = 4212;
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
async function typeName(page, name) {
  await page.evaluate(() => { document.getElementById('nameIn').value = ''; });
  await page.type('#nameIn', name);
}
async function clickId(page, id) {
  for (let i = 0; i < 6; i++) {
    const ok = await page.evaluate((x) => { const el = document.getElementById(x); if (!el) return false; el.click(); return true; }, id);
    if (ok) return;
    await sleep(300);
  }
  throw new Error('clickId: #' + id + ' never appeared');
}
// Evaluate clicks only: puppeteer's own click scrolls the target into view,
// which pans the emulated visual viewport and shifts fixed elements in shots.
async function tap(page, sel) {
  const ok = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
  if (!ok) throw new Error('tap: ' + sel + ' not found');
}
async function snap(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(250);
  await page.screenshot({ path: SHOTS + name });
  console.log('shot: ' + name.replace('kp2-', '').replace('.png', ''));
}

try {
  // Landing, landscape
  const L = await newPage('L', 844, 390);
  await L.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(400);
  await snap(L, 'kp2-landing-landscape.png');
  await L.close();

  // Classic game staged rich: sets owned, duplexes, a mansion, a full pot
  const A = await newPage('A', 844, 390);
  await A.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(A, 'Ada');
  await A.select('#optTimer', '120');
  await tap(A, '#createBtn');
  await waitState(A, (s) => s.status === 'lobby', 'A lobby');
  const code = (await S(A)).code;
  const B = await newPage('B', 844, 390);
  await B.goto(BASE + '/?join=' + code, { waitUntil: 'networkidle0' });
  await typeName(B, 'Bola');
  await tap(B, '#joinBtn');
  await waitState(B, (s) => s.status === 'lobby' && s.players.length === 2, 'B joined');
  await A.bringToFront();
  await tap(A, '#startBtn');
  await waitState(A, (s) => s.status === 'playing', 'playing');
  const st = await S(A);
  const turnId = st.turnPlayerId;
  const turnPage = st.players[0].id === turnId ? A : B;
  const otherPage = turnPage === A ? B : A;
  for (const sp of [1, 3, 37, 39]) await send(A, 'test_give', { playerId: turnId, space: sp });
  await send(A, 'test_set_cash', { playerId: turnId, amount: 6000000 });
  await send(A, 'test_set_pot', { amount: 200000 });
  await sleep(300);
  async function build(space, kind, wantB) {
    // Poll from Node: a waitForFunction predicate cannot see closure vars.
    await send(turnPage, 'build', { space, kind });
    const end = Date.now() + 6000;
    while (Date.now() < end) { const s = await S(turnPage); if (s && s.props[space] && s.props[space].b === wantB) return; await sleep(200); }
    console.log('  build note: ' + space + ' -> ' + wantB + ' not confirmed');
  }
  await build(1, 'duplex', 1); await build(3, 'duplex', 1);
  await build(1, 'duplex', 2); await build(3, 'duplex', 2);
  await build(37, 'duplex', 1); await build(39, 'duplex', 1);
  await build(37, 'duplex', 2); await build(39, 'duplex', 2);
  await build(37, 'duplex', 3); await build(39, 'duplex', 3);
  await build(37, 'duplex', 4); await build(39, 'duplex', 4);
  await build(39, 'mansion', 5);
  const stB = await S(A);
  console.log('staged props: Makoko b=' + stB.props[1].b, 'Ajegunle b=' + stB.props[3].b, 'Parkview b=' + stB.props[37].b, 'Banana b=' + stB.props[39].b, 'pot=' + stB.pot);
  await sleep(1400); // let any share overlay appear, then dismiss it
  await otherPage.evaluate(() => { const o = document.querySelector('#shareOverlay'); if (o && o.classList.contains('show')) document.querySelector('#shareClose').click(); });
  await turnPage.evaluate(() => { const o = document.querySelector('#shareOverlay'); if (o && o.classList.contains('show')) document.querySelector('#shareClose').click(); });
  await sleep(500);
  await otherPage.bringToFront();
  await sleep(400);
  await snap(otherPage, 'kp2-board-landscape.png');

  // Deed sheet, landscape (Banana Island, owned, mansion)
  await otherPage.evaluate(() => { document.querySelectorAll('.bspace')[39].click(); });
  await otherPage.waitForFunction(() => document.querySelector('#deedScrim').classList.contains('show'), { timeout: 6000 });
  await sleep(450);
  await snap(otherPage, 'kp2-deed-landscape.png');
  await otherPage.evaluate(() => document.querySelector('#deedScrim').classList.remove('show'));

  await A.close(); await B.close();

  // Portrait board: a FRESH page born at 390x844 (morphing a landscape page
  // mid-session leaves the emulated layout taller than the capture, which
  // pushed the fixed wallet bar out of the earlier frame). Pass and play on
  // one page, staged rich, full board toggled on.
  const P = await newPage('P', 390, 844);
  await P.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(P, 'Ada');
  await tap(P, '#roomModeRow [data-rmode="pass"]');
  await tap(P, '#createBtn');
  await waitState(P, (s) => s.status === 'lobby', 'P lobby');
  await P.evaluate(() => { document.getElementById('localNameIn').value = ''; });
  await P.type('#localNameIn', 'Bola');
  await tap(P, '#addLocalBtn');
  await waitState(P, (s) => s.players.length === 2, 'P two players');
  await tap(P, '#startBtn');
  await waitState(P, (s) => s.status === 'playing', 'P playing');
  const pTurn = (await S(P)).turnPlayerId;
  for (const sp of [1, 3, 37, 39]) await send(P, 'test_give', { playerId: pTurn, space: sp });
  await send(P, 'test_set_cash', { playerId: pTurn, amount: 6000000 });
  await send(P, 'test_set_pot', { amount: 200000 });
  async function buildP(space, kind, wantB) {
    await send(P, 'build', { space, kind });
    const end = Date.now() + 6000;
    while (Date.now() < end) { const s = await S(P); if (s && s.props[space] && s.props[space].b === wantB) return; await sleep(200); }
    console.log('  buildP note: ' + space + ' -> ' + wantB + ' not confirmed');
  }
  await buildP(1, 'duplex', 1); await buildP(3, 'duplex', 1);
  await buildP(1, 'duplex', 2); await buildP(3, 'duplex', 2);
  await buildP(39, 'duplex', 1); await buildP(39, 'duplex', 2);
  await buildP(39, 'duplex', 3); await buildP(39, 'duplex', 4);
  await buildP(39, 'mansion', 5);
  await sleep(600);
  await clickId(P, 'fullBoardBtn');
  await sleep(700);
  await snap(P, 'kp2-board-portrait.png');
  await P.close();

  // Desktop check: a fresh page born at 1280x800 (morphing a mobile page's
  // viewport reloads it back to the landing), pass and play on one page.
  const Dp = await newPage('D', 1280, 800);
  await Dp.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(Dp, 'Dapo');
  await tap(Dp, '#roomModeRow [data-rmode="pass"]');
  await tap(Dp, '#createBtn');
  await waitState(Dp, (s) => s.status === 'lobby', 'D lobby');
  await Dp.evaluate(() => { document.getElementById('localNameIn').value = ''; });
  await Dp.type('#localNameIn', 'Second');
  await tap(Dp, '#addLocalBtn');
  await waitState(Dp, (s) => s.players.length === 2, 'D two players');
  await tap(Dp, '#startBtn');
  await waitState(Dp, (s) => s.status === 'playing', 'D playing');
  await sleep(900);
  await snap(Dp, 'kp2-board-desktop.png');
  await Dp.close();

  // Inflation, landscape: Phase 2 multiplied rent alert
  const E = await newPage('E', 844, 390);
  await E.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(E, 'Efe');
  await tap(E, '#gameModeRow [data-gmode="inflation"]');
  await tap(E, '#createBtn');
  await waitState(E, (s) => s.status === 'lobby' && s.settings.gameMode === 'inflation', 'E lobby');
  const code3 = (await S(E)).code;
  const F = await newPage('F', 844, 390);
  await F.goto(BASE + '/?join=' + code3, { waitUntil: 'networkidle0' });
  await typeName(F, 'Funmi');
  await tap(F, '#joinBtn');
  await waitState(F, (s) => s.players.length === 2, 'F joined');
  await E.bringToFront();
  await tap(E, '#startBtn');
  await waitState(E, (s) => s.status === 'playing' && !!s.inf, 'inflation playing');
  const ids3 = (await S(E)).players.map((p) => p.id);
  const st3 = await S(E);
  const payerPage = [E, F][ids3.indexOf(st3.turnPlayerId)];
  const ownerPage = payerPage === E ? F : E;
  const ownerId = ids3[[E, F].indexOf(ownerPage)];
  const payerId = st3.turnPlayerId;
  await send(E, 'test_give', { playerId: ownerId, space: 13 });
  await send(E, 'test_phase', { phase: 2 });
  await waitState(E, (s) => s.inf.phase === 2, 'phase 2');
  await send(payerPage, 'test_set_position', { playerId: payerId, space: 9 });
  await send(payerPage, 'test_dice', { rolls: [[2, 2], [1, 2]] });
  await payerPage.bringToFront();
  await clickId(payerPage, 'abRoll');
  await payerPage.waitForFunction(() => {
    const el = document.querySelector('.alert-card.debit');
    return el && /x 2/.test(el.textContent);
  }, { timeout: 9000 }).catch(() => console.log('  note: multiplied rent alert not seen in time'));
  await snap(payerPage, 'kp2-inflation-landscape.png');
  await E.close(); await F.close();
} catch (err) {
  console.log('SHOTS ERROR: ' + err.message);
} finally {
  await browser.close();
  server.kill();
}
console.log('pageErrors: ' + errors.length + (errors.length ? ' :: ' + errors.slice(0, 3).join(' | ') : ''));
