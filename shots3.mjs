// KOLOPOLY 3D screenshot gate. Drives the KP_TEST server at landscape
// (844x390), portrait (390x844) and desktop (1280x800) and saves kp3-*.png
// frames for human judgement of the Three.js layer. Not part of the suites.
import { createRequire } from 'node:module';
const require2 = createRequire('/home/hatch/workspace/mobile-rig/package.json');
const puppeteer = require2('puppeteer-core');
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = 4214;
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
  await sleep(900); // a few rendered frames at rig speed
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
async function tap(page, sel) {
  const ok = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
  if (!ok) throw new Error('tap: ' + sel + ' not found');
}
async function snap(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(250);
  await page.screenshot({ path: SHOTS + name });
  console.log('shot: ' + name.replace('kp3-', '').replace('.png', ''));
}

try {
  // Landing, landscape: live 3D street behind the glass join card
  const L = await newPage('L', 844, 390);
  await L.goto(BASE, { waitUntil: 'networkidle0' });
  await waitGL(L, 'landing');
  await sleep(1200); // danfo mid-loop, clouds drifted
  await snap(L, 'kp3-landing-landscape.png');
  await L.close();

  // Classic game staged rich; lobby first for the gathering shot
  const A = await newPage('A', 844, 390);
  await A.goto(BASE, { waitUntil: 'networkidle0' });
  await waitGL(A, 'A landing');
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
  await sleep(1400); // lobby plaza settles, tokens + name sprites up
  await A.evaluate(() => { const el = document.getElementById('lobbyStage'); if (el) el.scrollIntoView({ block: 'center' }); });
  await sleep(900);
  await A.screenshot({ path: SHOTS + 'kp3-lobby.png' });
  console.log('shot: lobby');
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
  await sleep(1600); // buildings finish rising, share overlay may appear
  await otherPage.evaluate(() => { const o = document.querySelector('#shareOverlay'); if (o && o.classList.contains('show')) document.querySelector('#shareClose').click(); });
  await turnPage.evaluate(() => { const o = document.querySelector('#shareOverlay'); if (o && o.classList.contains('show')) document.querySelector('#shareClose').click(); });
  await sleep(500);
  await otherPage.bringToFront();
  await sleep(600);
  await snap(otherPage, 'kp3-board-landscape.png');

  // Deed sheet, landscape: the 3D deed card rises from Banana Island
  await otherPage.evaluate(() => { document.querySelectorAll('.bspace')[39].click(); });
  await otherPage.waitForFunction(() => document.querySelector('#deedScrim').classList.contains('show'), { timeout: 6000 });
  await sleep(900);
  await snap(otherPage, 'kp3-deed-landscape.png');
  await otherPage.evaluate(() => document.querySelector('#deedScrim').classList.remove('show'));
  await sleep(400);

  // Dice roll: from Owambe (20) with a 1+2, landing on a street so no card
  // modal covers the board; catch the dice mid-tumble over the centre
  await send(turnPage, 'test_set_position', { playerId: turnId, space: 20 });
  await send(turnPage, 'test_dice', { rolls: [[1, 2]] });
  await turnPage.bringToFront();
  await sleep(500);
  await clickId(turnPage, 'abRoll');
  await sleep(550);
  await snap(turnPage, 'kp3-roll.png');
  await sleep(1800);

  await A.close(); await B.close();

  // Portrait board, fresh page at 390x844, pass and play, follow view
  const P = await newPage('P', 390, 844);
  await P.goto(BASE, { waitUntil: 'networkidle0' });
  await waitGL(P, 'P landing');
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
  await sleep(900);
  await snap(P, 'kp3-board-portrait.png');
  await P.close();

  // Desktop, fresh page at 1280x800
  const Dp = await newPage('D', 1280, 800);
  await Dp.goto(BASE, { waitUntil: 'networkidle0' });
  await waitGL(Dp, 'D landing');
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
  await sleep(1200);
  await snap(Dp, 'kp3-board-desktop.png');
  await Dp.close();

  // Inflation Phase 2, landscape
  const E = await newPage('E', 844, 390);
  await E.goto(BASE, { waitUntil: 'networkidle0' });
  await waitGL(E, 'E landing');
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
  await sleep(700);
  await snap(payerPage, 'kp3-inflation-landscape.png');
  await E.close(); await F.close();
} catch (err) {
  console.log('SHOTS ERROR: ' + err.message);
} finally {
  await browser.close();
  server.kill();
}
console.log('pageErrors: ' + errors.length + (errors.length ? ' :: ' + errors.slice(0, 4).join(' | ') : ''));
