// board28 screenshot proof at phone sizes (390x844 and 360x740), 3D and 2D.
// Run: node shots-board28.mjs   (spawns its own KP_TEST server on 4232)
// Needs puppeteer-core and Chrome (CHROME_PATH). Writes shots/board28/.
import { spawn } from 'child_process';
import fs from 'fs';

const puppeteer = (await import('puppeteer-core')).default;
const PORT = 4232;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const OUT = new URL('./shots/board28/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), KP_TEST: '1', KP_RETENTION_FILE: '/tmp/kp-ret-' + PORT + '.json' },
  stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));

const S = (page) => page.evaluate(() => window.__kolopolyState());
const send = (page, type, obj) => page.evaluate((t, o) => window.__kolopolySend(t, o), type, obj || {});
async function waitState(page, pred, label, ms) {
  const src = pred.toString();
  await page.waitForFunction((s) => { const st = window.__kolopolyState(); return !!st && eval(s)(st); }, { timeout: ms || 15000, polling: 200 }, src)
    .catch(() => { throw new Error('waitState timeout: ' + label); });
}
async function clickId(page, id) {
  for (let i = 0; i < 20; i++) {
    const ok = await page.evaluate((x) => { const el = document.getElementById(x); if (!el || el.disabled) return false; el.click(); return true; }, id);
    if (ok) return;
    await sleep(300);
  }
  throw new Error('clickId: #' + id);
}
async function typeName(page, name) {
  await page.evaluate(() => {
    const n = document.getElementById('nameIn');
    if (n && n.offsetParent === null) {
      const t = [document.getElementById('inviteChangeBtn'), document.getElementById('welcomeChange')].find((b) => b && b.offsetParent !== null);
      if (t) t.click();
    }
    document.getElementById('nameIn').value = '';
  });
  await page.type('#nameIn', name);
}

async function run(label, W, H, gl) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'].concat(gl ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--disable-webgl', '--disable-3d-apis'])
  });
  const newPage = async (tag) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    p.on('pageerror', (e) => errors.push(label + ' ' + tag + ': ' + e.message));
    return p;
  };
  const shot = async (p, name) => { await sleep(gl ? 1200 : 500); await p.screenshot({ path: OUT + label + '-' + name + '.png' }); console.log('  shot ' + label + '-' + name); };
  try {
    // Inflation room: board, YOU tag, dice, Hustle sheet, Owambe Rush.
    const A = await newPage('A');
    await A.goto(BASE, { waitUntil: 'networkidle0' });
    await typeName(A, 'Ada');
    await A.click('#gameModeRow [data-gmode="inflation"]');
    await A.click('#createBtn');
    await waitState(A, (s) => s.status === 'lobby', 'lobby');
    const code = (await S(A)).code;
    const B = await newPage('B');
    await B.goto(BASE + '/?join=' + code, { waitUntil: 'networkidle0' });
    await typeName(B, 'Bola');
    await B.click('#joinBtn');
    await waitState(A, (s) => s.players.length === 2, 'joined');
    await A.click('#startBtn');
    await waitState(A, (s) => s.status === 'playing', 'playing', 20000);
    await sleep(gl ? 4000 : 1500);
    const st = await S(A);
    const ids = st.players.map((p) => p.id);
    const tp = [A, B][ids.indexOf(st.turnPlayerId)];
    const op = tp === A ? B : A;
    await tp.bringToFront();
    await shot(tp, 'board');
    await send(tp, 'test_phase', { phase: 2 });
    await waitState(tp, (s) => s.inf && s.inf.phase === 2, 'phase 2');
    await sleep(1500);
    await clickId(tp, 'abHustle');
    await tp.waitForFunction(() => document.querySelector('#listScrim').classList.contains('show'), { timeout: 8000 });
    await shot(tp, 'hustle-sheet');
    await tp.evaluate(() => document.querySelector('#listScrim').classList.remove('show'));
    await send(tp, 'test_dice', { rolls: [[3, 4]] });
    await clickId(tp, 'abRoll');
    await sleep(gl ? 900 : 400);
    await tp.screenshot({ path: OUT + label + '-dice.png' }); console.log('  shot ' + label + '-dice');
    await waitState(tp, (s) => s.phase !== 'roll', 'rolled', 20000);
    await sleep(2500);
    await shot(tp, 'after-move');
    await send(tp, 'test_set_pot', { amount: 350000 });
    await send(tp, 'test_owambe_rush', {});
    await waitState(op, (s) => s.owambe && s.owambe.state === 'coming', 'coming');
    await op.bringToFront();
    await op.screenshot({ path: OUT + label + '-owambe-coming.png' }); console.log('  shot ' + label + '-owambe-coming');
    await waitState(op, (s) => s.owambe && s.owambe.state === 'open', 'open');
    await sleep(300);
    await op.screenshot({ path: OUT + label + '-owambe-grab.png' }); console.log('  shot ' + label + '-owambe-grab');
    await op.evaluate(() => { const b = document.querySelector('#owambeRush [data-rush-as]'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    await waitState(op, (s) => s.owambeResult && s.owambeResult.winnerId != null, 'won');
    await sleep(600);
    await op.screenshot({ path: OUT + label + '-owambe-won.png' }); console.log('  shot ' + label + '-owambe-won');
    await A.close(); await B.close();

    // Classic room: Sapa Deal offer and answer.
    const C = await newPage('C');
    await C.goto(BASE, { waitUntil: 'networkidle0' });
    await typeName(C, 'Chidi');
    await C.click('#gameModeRow [data-gmode="classic"]');
    await C.click('#createBtn');
    await waitState(C, (s) => s.status === 'lobby', 'lobby2');
    const code2 = (await S(C)).code;
    const Dp = await newPage('D');
    await Dp.goto(BASE + '/?join=' + code2, { waitUntil: 'networkidle0' });
    await typeName(Dp, 'Dayo');
    await Dp.click('#joinBtn');
    await waitState(C, (s) => s.players.length === 2, 'joined2');
    await C.click('#startBtn');
    await waitState(C, (s) => s.status === 'playing', 'playing2', 20000);
    await sleep(gl ? 3000 : 1000);
    const st2 = await S(C);
    const ids2 = st2.players.map((p) => p.id);
    const debtorPage = [C, Dp][ids2.indexOf(st2.turnPlayerId)];
    const buyerPage = debtorPage === C ? Dp : C;
    const debtorId = st2.turnPlayerId, buyerId = ids2.find((x) => x !== debtorId);
    await send(C, 'test_give', { playerId: buyerId, space: 27 });
    await send(C, 'test_give', { playerId: debtorId, space: 1 });
    await send(C, 'test_give', { playerId: debtorId, space: 3 });
    await send(C, 'test_set_cash', { playerId: debtorId, amount: 10000 });
    await send(C, 'test_set_position', { playerId: debtorId, space: 24 });
    await send(C, 'test_dice', { rolls: [[1, 2]] });
    await sleep(300);
    await clickId(debtorPage, 'abRoll');
    await waitState(buyerPage, (s) => !!s.debt, 'debt');
    await buyerPage.bringToFront();
    await sleep(2500);
    await shot(buyerPage, 'sapa-vulnerable');
    await clickId(buyerPage, 'abSapa');
    await buyerPage.waitForFunction(() => document.querySelector('#listScrim').classList.contains('show'), { timeout: 8000 });
    await buyerPage.evaluate(() => document.querySelectorAll('[data-sapa-deed]').forEach((b) => b.click()));
    await sleep(300);
    await shot(buyerPage, 'sapa-offer-sheet');
    await clickId(buyerPage, 'sapaSend');
    await waitState(debtorPage, (s) => !!s.sapaOffer, 'offer');
    await debtorPage.bringToFront();
    await sleep(500);
    await debtorPage.screenshot({ path: OUT + label + '-sapa-answer.png' }); console.log('  shot ' + label + '-sapa-answer');
    await C.close(); await Dp.close();
  } catch (e) {
    errors.push(label + ' FLOW: ' + e.message);
  } finally {
    await browser.close();
  }
}

try {
  await run('m390-3d', 390, 844, true);
  await run('m360-2d', 360, 740, false);
  await run('m430-2d', 430, 932, false);
} finally {
  server.kill();
}
console.log(errors.length ? 'errors:\n' + errors.join('\n') : 'no page errors');
process.exit(errors.length ? 1 : 0);
