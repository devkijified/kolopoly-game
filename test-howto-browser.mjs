// How to play: open, swipe, close on iPhone WebKit and Android Chromium.
// First-time tips show once and do not block a tap. The sheet must not
// overflow a 360px-wide phone.
import { spawn } from 'child_process';
import { webkit, chromium } from 'playwright';
import fs from 'fs';

const PORT = 4594;
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: Object.assign({}, process.env, { PORT: String(PORT), KP_TEST: '1', KP_PERSIST_ROOMS: '', RESEND_API_KEY: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', KP_AUTH_SECRET: 'learn' }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40 && !log.includes('listening'); i++) await sleep(150);
if (!log.includes('listening')) { console.error(log); process.exit(1); }

let failed = 0;
function fail(msg) { console.error(msg); failed += 1; }
fs.mkdirSync('/tmp/pw-video', { recursive: true });
fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });

async function openHome(page) {
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
}

const iphone = await webkit.launch();
const ctx = await iphone.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  recordVideo: { dir: '/tmp/pw-video', size: { width: 393, height: 852 } }
});
const page = await ctx.newPage();
page.on('pageerror', (err) => console.log('PAGE', err.message));
try {
  await openHome(page);
  await page.waitForSelector('#trainOfferYes');
  await page.screenshot({ path: '/opt/cursor/artifacts/learn-offer-iphone.png' });
  await page.click('#trainOfferNo');
  await page.click('#howBtn');
  await page.waitForSelector('#howTrack .how-card');
  const count = await page.locator('#howTrack .how-card').count();
  if (count !== 9) fail('expected 9 cards, got ' + count);
  for (let i = 0; i < 9; i++) {
    await page.evaluate((n) => {
      const track = document.getElementById('howTrack');
      track.scrollLeft = n * track.clientWidth;
    }, i);
    await page.waitForTimeout(200);
    await page.screenshot({ path: '/opt/cursor/artifacts/how-card-' + (i + 1) + '-iphone.png' });
  }
  const salary = await page.locator('#howTrack .how-card').nth(7).innerText();
  if (!/₦200,000|₦200000|200,000/.test(salary)) fail('START pay missing from the guide: ' + salary);
  const bail = await page.locator('#howTrack .how-card').nth(6).innerText();
  if (!/50,000/.test(bail)) fail('bail missing from the guide: ' + bail);
  if (/monopoly/i.test(await page.locator('#howScrim').innerText())) fail('guide says Monopoly');
  await page.click('#howClose');
  if (await page.locator('#howScrim').isVisible()) fail('guide did not close');

  await page.setViewportSize({ width: 360, height: 780 });
  await page.click('#howBtn');
  await page.waitForSelector('#howTrack');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= 364);
  if (!overflow) fail('guide overflows at 360px');
  await page.click('#howClose');

  const leaked = await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<button id="abRoll">Roll</button>');
    const room = { phase: 'roll', turnPlayerId: 1, status: 'playing', players: [{ id: 1, cash: 1500000, accountId: 'acct-1' }], props: [], feed: [] };
    const shown = window.KPLearn.show('roll', 'acct-1');
    window.KPLearn.onRoom(room, 1);
    return { shown: shown, node: !!document.getElementById('learnTip'), inGame: document.body.classList.contains('in-game') };
  });
  if (leaked.shown || leaked.node || leaked.inGame) fail('tip leaked onto the landing page ' + JSON.stringify(leaked));
  const outside = await page.evaluate(() => {
    const view = document.getElementById('view-game');
    view.classList.add('active');
    document.body.classList.add('in-game');
    const btn = document.createElement('button');
    btn.id = 'abRollTest';
    btn.style.cssText = 'width:140px;height:48px';
    view.appendChild(btn);
    const plain = { status: 'playing', phase: 'roll', turnPlayerId: 1, players: [{ id: 1, cash: 1500000, accountId: 'acct-1' }], props: [], feed: [] };
    window.__kolopolyState = () => plain;
    const shown = window.KPLearn.show('roll', 'acct-1');
    window.KPLearn.onRoom(plain, 1);
    const node = document.getElementById('learnTip');
    view.classList.remove('active');
    document.body.classList.remove('in-game');
    btn.remove();
    return { shown: !!shown, node: !!(node && !node.hidden) };
  });
  if (outside.shown || outside.node) fail('tip showed in a non-training game ' + JSON.stringify(outside));
  console.log('iphone guide ok, no landing or match tip', leaked, outside);
} catch (e) {
  console.error(e);
  failed += 1;
}
const video = page.video();
await ctx.close();
if (video) fs.copyFileSync(await video.path(), '/opt/cursor/artifacts/howto-iphone.webm');
await iphone.close();

const android = await chromium.launch();
const actx = await android.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
});
const ap = await actx.newPage();
ap.on('pageerror', (err) => console.log('PAGE', err.message));
try {
  await openHome(ap);
  await ap.click('#trainOfferNo');
  await ap.click('#howBtn');
  await ap.waitForSelector('#howTrack .how-card');
  await ap.evaluate(() => {
    const track = document.getElementById('howTrack');
    track.scrollLeft = track.clientWidth * 3;
  });
  await ap.waitForTimeout(200);
  const left = await ap.evaluate(() => document.getElementById('howTrack').scrollLeft);
  if (left < 50) fail('android swipe did not move');
  await ap.click('#howClose');
  if (await ap.locator('#howScrim').isVisible()) fail('android guide stayed open');
  console.log('android guide ok', left);
} catch (e) {
  console.error(e);
  failed += 1;
}
await actx.close();
await android.close();
server.kill();
console.log(failed ? 'HOWTO FAIL ' + failed : 'howto passed');
process.exit(failed ? 1 : 0);
