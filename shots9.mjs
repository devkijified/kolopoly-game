// Kolopoly KP9 frames: full-bleed board in a taller stage, no rotate
// hint, no Classic bar (match clock in the header chip), slim plinth
// instead of the table disc, IconSax utility bar. 390 + 360 portrait and
// 844x390 landscape. Measurements print alongside the frames.
import { spawn } from 'child_process';
import { createRequire } from 'module';
const require = createRequire('/home/hatch/workspace/mobile-rig/package.json');
const puppeteer = require('puppeteer-core');

const CHROME = '/home/hatch/workspace/mobile-rig/browsers/chrome/linux-155.0.8059.84/chrome-linux64/chrome';
const PORT = 4219;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = '/home/hatch/workspace/kolopoly-game/shots/';
const UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_AND = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('node', ['server.js'], {
  cwd: '/home/hatch/workspace/kolopoly-game',
  env: { ...process.env, PORT: String(PORT), KP_TEST: '1' },
  stdio: 'pipe'
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
await sleep(900);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
});
async function newPage(tag, viewport, ua) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.emulate({ viewport, userAgent: ua || UA_IOS });
  page.on('pageerror', (e) => console.log('[' + tag + ' pageerror]', e.message));
  return page;
}
const S = (p) => p.evaluate(() => window.__kolopolyState());
async function clickId(page, id) {
  for (let i = 0; i < 30; i++) {
    const ok = await page.evaluate((x) => { const el = document.getElementById(x); if (!el) return false; el.click(); return true; }, id);
    if (ok) return;
    await sleep(400);
  }
  throw new Error('clickId: #' + id + ' never appeared');
}
async function waitState(page, pred, label) {
  const end = Date.now() + 25000;
  while (Date.now() < end) { const s = await S(page); if (s && pred(s)) return s; await sleep(200); }
  throw new Error('waitState timeout: ' + label);
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
  await page.type('#nameIn', name);
}
async function startBotGame(page, name) {
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(page, name);
  await page.click('#createBtn');
  await waitState(page, (s) => s.status === 'lobby', name + ' lobby');
  await clickId(page, 'botAdd1');
  await waitState(page, (s) => s.players.length === 2, name + ' bot seated');
  await page.click('#startBtn');
  await waitState(page, (s) => s.status === 'playing', name + ' playing');
  await sleep(4500); // countdown, opening camera, first banner
}
async function measure(page, tag) {
  const m = await page.evaluate(() => {
    const stage = document.querySelector('.game-stage');
    const dock = document.querySelector('.walletbar');
    const chip = document.getElementById('roomChip');
    return {
      stageH: stage.clientHeight, ih: window.innerHeight, share: +(stage.clientHeight / window.innerHeight).toFixed(3),
      dockH: Math.round(dock.getBoundingClientRect().height),
      chip: chip.textContent.replace(/\s+/g, ' ').trim(),
      hint: !!document.getElementById('rotateHint'), classic: !!document.getElementById('classicBar'),
      sw: document.documentElement.scrollWidth, iw: window.innerWidth
    };
  });
  console.log(tag + ' measure: ' + JSON.stringify(m));
  return m;
}

// 390 portrait: follow, then full.
const P = await newPage('P390', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await startBotGame(P, 'Adaeze');
await measure(P, '390-follow');
await P.screenshot({ path: SHOTS + 'kp9-m390-game.png' });
await P.click('#fullBoardBtn');
// Poll until the camera glide settles (rim width stable): the rig's
// software GL damps the camera in capped steps, so a fixed sleep shoots
// the board still cropped mid-glide.
{
  let prevW = -1;
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const pr = await P.evaluate(() => window.KP3D.boardProbePx());
    if (pr && pr.full && Math.abs(pr.rimWidthPx - prevW) <= 3) { console.log('390 probe (settled): ' + JSON.stringify(pr)); break; }
    if (pr) prevW = pr.rimWidthPx;
    await sleep(700);
  }
}
await P.screenshot({ path: SHOTS + 'kp9-m390-full.png' });
await P.close();

// 360 portrait: follow.
const Q = await newPage('Q360', { width: 360, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, UA_AND);
await startBotGame(Q, 'Adaeze');
await measure(Q, '360-follow');
await Q.screenshot({ path: SHOTS + 'kp9-m360-game.png' });
await Q.click('#fullBoardBtn');
{
  let prevW = -1;
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const pr = await Q.evaluate(() => window.KP3D.boardProbePx());
    if (pr && pr.full && Math.abs(pr.rimWidthPx - prevW) <= 3) { console.log('360 probe (settled): ' + JSON.stringify(pr)); break; }
    if (pr) prevW = pr.rimWidthPx;
    await sleep(700);
  }
}
await Q.close();

// Landscape sanity at 844x390.
const L = await newPage('L844', { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, UA_AND);
await startBotGame(L, 'Adaeze');
await measure(L, 'land');
await L.screenshot({ path: SHOTS + 'kp9-land-game.png' });
await L.close();

await browser.close();
server.kill();
console.log('shots9 done');
