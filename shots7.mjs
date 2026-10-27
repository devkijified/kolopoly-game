// Kolopoly lessons-round frames (read by the builder, not shipped):
// portrait full board fit + wordmark, portrait follow crop, the pause
// waiting card, and landscape follow with slimmed chrome.
import { spawn } from 'child_process';
import { createRequire } from 'module';
const require = createRequire('/home/hatch/workspace/mobile-rig/package.json');
const puppeteer = require('puppeteer-core');

const CHROME = '/home/hatch/workspace/mobile-rig/browsers/chrome/linux-155.0.8059.84/chrome-linux64/chrome';
const PORT = 4217;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = '/home/hatch/workspace/kolopoly-game/shots/';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
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
async function newPage(tag, viewport) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.emulate({ viewport: viewport || { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: UA });
  page.on('pageerror', (e) => console.log('[' + tag + ' pageerror]', e.message));
  return page;
}
const S = (p) => p.evaluate(() => window.__kolopolyState());
const send = (p, type, obj) => p.evaluate((t, o) => window.__kolopolySend(t, o), type, obj || {});
async function clickId(page, id) {
  for (let i = 0; i < 30; i++) {
    const ok = await page.evaluate((x) => { const el = document.getElementById(x); if (!el) return false; el.click(); return true; }, id);
    if (ok) return;
    await sleep(400);
  }
  throw new Error('clickId: #' + id + ' never appeared');
}
async function waitState(page, pred, label) {
  const end = Date.now() + 20000;
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

// --- Pass-and-play pair on one phone: full board, then follow crop.
{
  const P = await newPage('P');
  await P.goto(BASE, { waitUntil: 'networkidle0' });
  await P.click('[data-rmode="pass"]');
  await typeName(P, 'Sade');
  await clickId(P, 'createBtn');
  await waitState(P, (s) => s.status === 'lobby', 'pass lobby');
  await P.type('#localNameIn', 'Tayo');
  await clickId(P, 'addLocalBtn');
  await waitState(P, (s) => s.players.length === 2, 'two local players');
  await clickId(P, 'startBtn');
  await waitState(P, (s) => s.status === 'playing', 'pass game playing');
  await sleep(5200); // countdown fully done, follow camera settled
  await P.waitForSelector('#fullBoardBtn', { visible: true, timeout: 9000 });
  await P.click('#fullBoardBtn'); // real tap: the toggle listens on pointerdown
  await sleep(3400); // the glide settles even at sandbox frame rates
  console.log('full view state:', await P.evaluate(() => window.KPBoard.effectiveFull()));
  await P.screenshot({ path: SHOTS + 'kp6-portrait-full.png' });
  await P.click('#fullBoardBtn');
  await sleep(3400);
  console.log('follow view state:', await P.evaluate(() => window.KPBoard.effectiveFull()));
  await P.screenshot({ path: SHOTS + 'kp6-portrait-follow.png' });
  await P.close();
}

// --- Online pair: the pause waiting card on the staying phone.
{
  const P1 = await newPage('P1');
  await P1.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(P1, 'Funke');
  await clickId(P1, 'createBtn');
  await waitState(P1, (s) => s.status === 'lobby', 'host lobby');
  const code = (await S(P1)).code;
  const P2 = await newPage('P2');
  await P2.goto(BASE + '/?join=' + code, { waitUntil: 'networkidle0' });
  await typeName(P2, 'Yemi');
  await P2.click('#joinBtn');
  await waitState(P2, (s) => s.status === 'lobby' && s.players.length === 2, 'guest joined');
  await P1.bringToFront();
  await P1.click('#startBtn');
  await waitState(P1, (s) => s.status === 'playing', 'online game playing');
  await sleep(2600);
  await P2.evaluate(() => window.__kolopolyDrop());
  await P2.goto('about:blank');
  await P1.waitForFunction(() => {
    const el = document.querySelector('#pauseOverlay');
    return el && el.classList.contains('show');
  }, { timeout: 15000, polling: 250 }).catch(() => {});
  await sleep(2600); // let the elapsed wait show real seconds
  await P1.screenshot({ path: SHOTS + 'kp6-pause.png' });
  await P1.close(); await P2.close();
}

// --- Landscape: follow is the default here too, chrome slimmed.
{
  const L = await newPage('L', { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await L.goto(BASE, { waitUntil: 'networkidle0' });
  await L.click('[data-rmode="pass"]');
  await typeName(L, 'Sade');
  await clickId(L, 'createBtn');
  await waitState(L, (s) => s.status === 'lobby', 'landscape lobby');
  await L.type('#localNameIn', 'Tayo');
  await clickId(L, 'addLocalBtn');
  await waitState(L, (s) => s.players.length === 2, 'landscape two players');
  await clickId(L, 'startBtn');
  await waitState(L, (s) => s.status === 'playing', 'landscape game playing');
  await sleep(3000);
  console.log('landscape effectiveFull (want false):', await L.evaluate(() => window.KPBoard.effectiveFull()));
  // The form flow leaves the page scrolled; reset every scroller so the
  // frame shows the composed chrome from the top, as a player sees it.
  await L.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll('.view, .rail, .lobby-scroll').forEach((el) => { el.scrollTop = 0; });
  });
  await sleep(500);
  await L.screenshot({ path: SHOTS + 'kp6-landscape-follow.png' });
  await L.close();
}

await browser.close();
server.kill('SIGKILL');
console.log('frames done');
process.exit(0);
