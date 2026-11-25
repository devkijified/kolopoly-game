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

  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<button id="abRoll" style="position:fixed;left:16px;bottom:24px;width:160px;height:48px;z-index:1">Roll</button>');
    window.__clicks = 0;
    document.getElementById('abRoll').addEventListener('click', () => { window.__clicks += 1; });
    const room = { phase: 'roll', turnPlayerId: 1, status: 'playing', players: [{ id: 1, cash: 1500000, accountId: 'acct-1' }], props: [], feed: [] };
    window.KPLearn.onRoom(room, 1);
  });
  await page.screenshot({ path: '/opt/cursor/artifacts/tip-roll-iphone.png' });
  await page.click('#abRoll');
  const clicks = await page.evaluate(() => window.__clicks);
  if (clicks !== 1) fail('tip blocked the roll click: ' + clicks);
  await page.evaluate(() => {
    window.KPLearn.hide();
    const room = { phase: 'roll', turnPlayerId: 1, status: 'playing', players: [{ id: 1, cash: 1500000, accountId: 'acct-1' }], props: [], feed: [] };
    window.KPLearn.onRoom(room, 1);
  });
  const hidden = await page.evaluate(() => document.getElementById('learnTip').hidden);
  if (!hidden) fail('roll tip showed a second time');

  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<button id="abBuy" style="position:fixed;left:16px;bottom:80px">Buy</button><button id="hudCashBtn" style="position:fixed;right:16px;top:80px">Cash</button>');
    const buy = { phase: 'buy', turnPlayerId: 1, status: 'playing', players: [{ id: 1, cash: 1500000, accountId: 'acct-1' }], props: [], feed: [] };
    window.KPLearn.onRoom(buy, 1);
  });
  await page.screenshot({ path: '/opt/cursor/artifacts/tip-buy-iphone.png' });
  await page.evaluate(() => {
    window.KPLearn.hide();
    const prev = { phase: 'roll', turnPlayerId: 1, status: 'playing', players: [{ id: 1, cash: 200000, accountId: 'acct-1' }], props: [], feed: [{ seq: 1, kind: 'info' }] };
    window.KPLearn.onRoom(prev, 1);
    const now = { phase: 'end', turnPlayerId: 1, status: 'playing', players: [{ id: 1, cash: 186000, accountId: 'acct-1' }], props: [], feed: [{ seq: 1, kind: 'info' }, { seq: 2, kind: 'debit', playerId: 1, spaceName: 'Ajegunle' }] };
    window.KPLearn.onRoom(now, 1);
  });
  await page.screenshot({ path: '/opt/cursor/artifacts/tip-rent-iphone.png' });
  console.log('iphone guide and tips ok');
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
