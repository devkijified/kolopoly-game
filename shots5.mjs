// KP5 frame driver: button type on landing, OPay credit moment, and the
// in-game layout at 390x844 portrait and 844x390 landscape (one room, the
// second page rotates to landscape). Own server on 4214, killed after.
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
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--ignore-certificate-errors']
});
async function newPage(tag) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  page.on('pageerror', (e) => console.log('PAGEERROR ' + tag + ': ' + e.message));
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
  await page.evaluate(() => {
    const n = document.getElementById('nameIn');
    if (n && n.offsetParent === null) {
      const cand = [document.getElementById('inviteChangeBtn'), document.getElementById('welcomeChange')];
      const t = cand.find((b) => b && b.offsetParent !== null);
      if (t) t.click();
    }
  });
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

try {
  const A = await newPage('A');
  await A.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(600);
  await A.screenshot({ path: SHOTS + 'kp5-buttons.png' });
  console.log('kp5-buttons: landing shot taken');

  await typeName(A, 'Tife');
  await A.click('#gameModeRow [data-gmode="inflation"]');
  await A.click('#createBtn');
  await waitState(A, (s) => s.status === 'lobby' && s.settings.gameMode === 'inflation', 'inflation lobby');
  const code = (await S(A)).code;

  const B = await newPage('B');
  await B.goto(BASE + '/?join=' + code, { waitUntil: 'networkidle0' });
  await typeName(B, 'Moon');
  await B.click('#joinBtn');
  await waitState(B, (s) => s.players.length === 2, 'B joined');
  await A.bringToFront().catch(() => {});
  await A.click('#startBtn');
  await waitState(A, (s) => s.status === 'playing' && !!s.inf, 'inflation playing');
  await send(A, 'test_phase', { phase: 2 });
  await waitState(A, (s) => s.inf.phase === 2, 'phase 2 live');

  // Stage a salary credit on the turn player: sit on 37, roll 1+2, wrap START.
  const st = await S(A);
  const tp = [A, B][st.players.findIndex((p) => p.id === st.turnPlayerId)];
  await send(A, 'test_set_position', { playerId: st.turnPlayerId, space: 37 });
  await send(A, 'test_dice', { rolls: [[1, 2]] });
  await tp.bringToFront().catch(() => {});
  await clickId(tp, 'abRoll');
  await tp.waitForFunction(() => !!document.querySelector('.alert-card.credit'), { timeout: 9000, polling: 120 });
  await sleep(480); // check drawn, ripple mid-flight
  await tp.screenshot({ path: SHOTS + 'kp5-credit.png' });
  console.log('kp5-credit: salary credit alert caught');
  await sleep(2400); // let the alert finish and clear

  // Portrait in game: phase bar scrolled into view, wallet pinned below.
  await tp.evaluate(() => { const b = document.getElementById('infBar'); if (b) b.scrollIntoView({ block: 'start' }); });
  await sleep(500);
  await tp.screenshot({ path: SHOTS + 'kp5-mobile-portrait.png' });
  const pm = await tp.evaluate(() => ({
    walletH: document.querySelector('.walletbar').offsetHeight,
    walletBottom: Math.round(document.querySelector('.walletbar').getBoundingClientRect().bottom),
    secBottom: Math.round(document.getElementById('secondaryBar').getBoundingClientRect().bottom),
    innerH: window.innerHeight,
    csVar: getComputedStyle(document.documentElement).getPropertyValue('--wallet-h'),
    docW: document.documentElement.scrollWidth,
    infText: document.getElementById('infBar').textContent.replace(/\s+/g, ' ').slice(0, 140)
  }));
  console.log('portrait metrics: ' + JSON.stringify(pm));

  // Rotate the second page to landscape and shoot the same live game.
  await B.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await sleep(900);
  await B.screenshot({ path: SHOTS + 'kp5-mobile-landscape.png' });
  const lm = await B.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    stage: (() => { const el = document.querySelector('.game-stage'); const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
    rail: (() => { const el = document.querySelector('.game-rail'); const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
    railKids: [...document.querySelector('.rail-top').children].map((el) => el.id || el.className + ':' + Math.round(el.getBoundingClientRect().height) + '@' + Math.round(el.getBoundingClientRect().top)),
    railScroll: document.querySelector('.rail-top').scrollTop,
    msgVisible: !!document.getElementById('msgText').offsetParent,
    chips: document.getElementById('playersStrip').children.length
  }));
  console.log('landscape metrics: ' + JSON.stringify(lm));
  await A.close(); await B.close();

  // Join link prompt: a fresh host room, a returning player opens the link.
  const D = await newPage('D');
  await D.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(D, 'Hosty');
  await D.click('#createBtn');
  await waitState(D, (s) => s.status === 'lobby', 'D lobby');
  const code2 = (await S(D)).code;
  const C = await newPage('C');
  await C.goto(BASE, { waitUntil: 'networkidle0' });
  await C.evaluate(() => { localStorage.setItem('kolopolyName', 'Tife'); localStorage.setItem('kolopolyToken', 'keke'); });
  await C.goto(BASE + '/?join=' + code2, { waitUntil: 'networkidle0' });
  await C.waitForFunction(() => /inside/.test(document.querySelector('#inviteMeta').textContent), { timeout: 9000, polling: 200 }).catch(() => {});
  await sleep(400);
  await C.screenshot({ path: SHOTS + 'kp5-joinlink.png' });
  console.log('kp5-joinlink: prompt shot taken for room ' + code2);
  await C.close(); await D.close();
} catch (err) {
  console.log('SHOTS5 ERROR: ' + err.message);
} finally {
  await browser.close();
  server.kill();
}
console.log('shots5 done');
