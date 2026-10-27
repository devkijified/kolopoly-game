// Kolopoly KP12 frames: bolder tile faces (names, prices, bands,
// glyphs), compact one-line player pills, and the floating glass dock
// (cash badge, gradient pill, depleting timer ring, ghost utilities).
// 390 + 360 portrait (mid-game dressed), a 2x centre crop of the 390
// near row for text legibility, and 844x390 landscape. Stack metrics
// (msgbar, chips, dock, total) print alongside for the KP11 comparison.
import { spawn } from 'child_process';
import { createRequire } from 'module';
const require = createRequire('/home/hatch/workspace/mobile-rig/package.json');
const puppeteer = require('puppeteer-core');

const CHROME = '/home/hatch/workspace/mobile-rig/browsers/chrome/linux-155.0.8059.84/chrome-linux64/chrome';
const PORT = 4229;
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
const send = (page, type, obj) => page.evaluate((t, o) => window.__kolopolySend(t, o), type, obj || {});
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
  await sleep(4500); // countdown zoom, glide out to the fitted board, first banner
}
// Poll the ring probe until the camera settle lands (two reads within
// 3px on both axes): software GL damps the camera in capped steps.
async function settleProbe(page, tag) {
  let prevW = -1, prevH = -1, pr = null;
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    pr = await page.evaluate(() => window.KP3D.boardProbePx());
    if (pr && Math.abs(pr.rimWidthPx - prevW) <= 3 && Math.abs(pr.rimHeightPx - prevH) <= 3) break;
    if (pr) { prevW = pr.rimWidthPx; prevH = pr.rimHeightPx; }
    await sleep(700);
  }
  console.log(tag + ' probe (settled): ' + JSON.stringify(pr) +
    (pr ? ' => ring spans ' + pr.rimWPct.toFixed(1) + '% W x ' + pr.rimHPct.toFixed(1) + '% H of the box' : ''));
  return pr;
}
async function measure(page, tag) {
  const m = await page.evaluate(() => {
    const R = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
    const stage = document.querySelector('.game-stage');
    const dockEl = document.querySelector('.walletbar');
    const msg = R('.msgbar'), strip = R('#playersStrip'), dock = R('.walletbar');
    const chipEl = document.querySelector('#playersStrip .pchip');
    const cs = getComputedStyle(dockEl);
    const ring = document.querySelector('.timer-ring');
    const dbg = window.KP3D.debug ? window.KP3D.debug() : {};
    return {
      stageW: stage.clientWidth, stageH: stage.clientHeight, ih: window.innerHeight,
      stageShare: Math.round(stage.clientHeight / window.innerHeight * 1000) / 10,
      msgbar: msg, strip: strip, chipH: chipEl ? Math.round(chipEl.getBoundingClientRect().height) : null,
      dock: dock, stackTotal: msg && dock ? Math.round(dock.bottom - msg.top) : null,
      dockGlass: { bf: cs.backdropFilter, radius: cs.borderTopLeftRadius, borderW: cs.borderTopWidth },
      timerRing: ring ? { num: ring.querySelector('.ring-num').textContent, off: ring.querySelector('.ring-fg').style.strokeDashoffset } : null,
      clockChipGone: !document.querySelector('.clock-chip'),
      chip: document.getElementById('roomChip').textContent.replace(/\s+/g, ' ').trim(),
      frameMeshes: dbg.frameMeshes, layout: dbg.layout,
      sw: document.documentElement.scrollWidth, iw: window.innerWidth
    };
  });
  console.log(tag + ' measure: ' + JSON.stringify(m));
  return m;
}
// Mid-game dressing via the KP_TEST hooks (same as KP11): deeds for
// both players, tokens scattered, a duplex on each of the brown pair.
async function dressMidGame(page) {
  const st = await S(page);
  const me = st.players.find((p) => !p.bot);
  const bot = st.players.find((p) => p.bot);
  await send(page, 'test_give', { playerId: me.id, space: 1 });
  await send(page, 'test_give', { playerId: me.id, space: 3 });
  await send(page, 'test_give', { playerId: bot.id, space: 39 });
  await send(page, 'test_set_position', { playerId: me.id, space: 24 });
  await send(page, 'test_set_position', { playerId: bot.id, space: 11 });
  await sleep(600);
  await send(page, 'build', { space: 1, kind: 'duplex' });
  await sleep(900);
  await send(page, 'build', { space: 3, kind: 'duplex' });
  await sleep(1200);
  const st2 = await S(page);
  console.log('mid-game: positions ' + st2.players.map((p) => p.name + '@' + p.position).join(', ') +
    '; props 1/3/39 owners ' + [1, 3, 39].map((i) => st2.props[i].o).join('/') +
    '; buildings on 1/3: ' + st2.props[1].b + '/' + st2.props[3].b);
}

// 390 portrait: mid-game, the new dock in a live turn state.
const P = await newPage('P390', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await startBotGame(P, 'Adaeze');
await dressMidGame(P);
await settleProbe(P, '390-mid');
await measure(P, '390');
await P.screenshot({ path: SHOTS + 'kp12-m390-game.png' });
// 2x centre crop of the near (bottom) row: clip in CSS px, dsf 2 does
// the doubling. Centred 74% of the board width, bottom 30% of its height.
{
  const wrap = await P.evaluate(() => {
    const r = document.getElementById('boardWrap').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cw = Math.round(wrap.w * 0.74), ch = Math.round(wrap.h * 0.30);
  await P.screenshot({
    path: SHOTS + 'kp12-m390-crop.png',
    clip: { x: Math.round(wrap.x + (wrap.w - cw) / 2), y: Math.round(wrap.y + wrap.h - ch), width: cw, height: ch }
  });
  console.log('crop: ' + JSON.stringify({ cw, ch }));
}
await P.close();

// 360 portrait: same mid-game state at the smaller width.
const Q = await newPage('Q360', { width: 360, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, UA_AND);
await startBotGame(Q, 'Adaeze');
await dressMidGame(Q);
await settleProbe(Q, '360-mid');
await measure(Q, '360');
await Q.screenshot({ path: SHOTS + 'kp12-m360-game.png' });
await Q.close();

// Landscape sanity at 844x390: same dock language inside the rail.
const L = await newPage('L844', { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, UA_AND);
await startBotGame(L, 'Adaeze');
await settleProbe(L, 'land');
await measure(L, 'land');
await L.screenshot({ path: SHOTS + 'kp12-land-game.png' });
await L.close();

await browser.close();
server.kill();
console.log('shots12 done');
