// Full Training Ground run on an iPhone-sized WebKit window and an
// Android-sized Chromium window. A stray property sheet must not freeze
// the lesson, and a delayed Buy prompt must come back on its own.
import { spawn } from 'child_process';
import { webkit, chromium } from 'playwright';
import fs from 'fs';

const PORT = 4592;
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: Object.assign({}, process.env, { PORT: String(PORT), KP_TEST: '1', KP_PERSIST_ROOMS: '', RESEND_API_KEY: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', KP_AUTH_SECRET: 'lesson' }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40 && !log.includes('listening'); i++) await sleep(150);
if (!log.includes('listening')) { console.error(log); process.exit(1); }

function wireSockets() {
  const Orig = WebSocket;
  window.__kpsockets = [];
  function Wrapped(url, protocols) {
    const ws = protocols ? new Orig(url, protocols) : new Orig(url);
    window.__kpsockets.push(ws);
    return ws;
  }
  Wrapped.prototype = Orig.prototype;
  Wrapped.CONNECTING = Orig.CONNECTING;
  Wrapped.OPEN = Orig.OPEN;
  Wrapped.CLOSING = Orig.CLOSING;
  Wrapped.CLOSED = Orig.CLOSED;
  window.WebSocket = Wrapped;
}

async function boot(page) {
  await page.addInitScript(wireSockets);
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__sheetOpened = false;
    document.addEventListener('click', () => {
      const s = document.getElementById('deedScrim');
      if (s && s.classList.contains('show')) window.__sheetOpened = true;
    });
    const name = document.getElementById('nameIn');
    if (name) name.value = 'Kiji';
  });
  await page.click('#trainBtn');
  await page.click('#trainIntro');
  await page.waitForFunction(() => {
    const s = window.__kolopolyState && window.__kolopolyState();
    return s && s.practice && s.practice.step === 'hello';
  });
}

async function step(page) {
  return page.evaluate(() => (window.__kolopolyState() && window.__kolopolyState().practice && window.__kolopolyState().practice.step) || '');
}

async function act(page, id) {
  if (id === 'adaroll') {
    await page.waitForFunction(() => window.__kolopolyState().practice.step === 'adacheer');
    return;
  }
  const clickLive = async (sel) => {
    await page.waitForFunction((s) => {
      const el = document.querySelector(s);
      return !!(el && el.classList.contains('coach-live'));
    }, sel, { timeout: 6000 });
    await page.click(sel);
  };
  if (id === 'cash') return clickLive('#hudCashBtn');
  if (id === 'roll' || id === 'payroll' || id === 'cardroll' || id === 'jailroll' || id === 'walk1' || id === 'salary') return clickLive('#abRoll');
  if (id === 'buy') return clickLive('#abBuy');
  if (id === 'endturn') return clickLive('#abEnd');
  if (id === 'jail') return clickLive('#abJailPay');
  if (id === 'build') return clickLive('[data-act="build-duplex"]');
  if (id === 'deals') return clickLive('#hudDeals');
  await page.click('#coachPop [data-act="next"]');
}

const shots = {
  roll: 'lesson-roll-iphone.png',
  buy: 'lesson-buy-iphone.png',
  adacheer: 'lesson-rent-iphone.png',
  jail: 'lesson-jail-iphone.png',
  ready: 'lesson-trained-iphone.png'
};

async function play(page, opts) {
  const seen = [];
  let stray = false;
  for (let i = 0; i < 40; i++) {
    const id = await step(page);
    seen.push(id);
    console.log(opts.label, id);
    if (opts.record && shots[id]) await page.screenshot({ path: '/opt/cursor/artifacts/' + shots[id] });
    if (id === 'ready') break;
    if (opts.stray && id === 'walked') {
      const opened = await page.evaluate(() => {
        document.querySelector('.bspace[data-space="2"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return document.getElementById('deedScrim').classList.contains('show');
      });
      await page.mouse.click(24, 280);
      await page.waitForFunction(() => !document.getElementById('deedScrim').classList.contains('show'));
      const nudge = await page.locator('#coachNudge').innerText();
      stray = opened && /glowing one/.test(nudge);
      console.log(opts.label, 'stray sheet', opened, 'nudge', nudge);
    }
    const before = id;
    await act(page, id);
    await page.waitForFunction((prev) => {
      const s = window.__kolopolyState();
      return s && s.practice && s.practice.step !== prev;
    }, before, { timeout: 8000 });
  }
  return { seen, stray, final: await step(page) };
}

let failed = 0;
fs.mkdirSync('/tmp/pw-video', { recursive: true });
fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });

const iphone = await webkit.launch();
const iphoneCtx = await iphone.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  recordVideo: { dir: '/tmp/pw-video', size: { width: 393, height: 852 } }
});
const iphonePage = await iphoneCtx.newPage();
iphonePage.on('pageerror', (err) => console.log('PAGE', err.message));
try {
  await boot(iphonePage);
  const result = await play(iphonePage, { label: 'iphone', record: true, stray: true });
  console.log('iphone path', result.seen.join(' > '));
  if (result.final !== 'ready' || !result.stray) {
    console.error('iphone failed', result);
    failed += 1;
  }
} catch (e) {
  console.error(e);
  failed += 1;
}
const video = iphonePage.video();
await iphoneCtx.close();
if (video) fs.copyFileSync(await video.path(), '/opt/cursor/artifacts/lesson-iphone.webm');
await iphone.close();

const android = await chromium.launch();
const androidCtx = await android.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
});
const androidPage = await androidCtx.newPage();
androidPage.on('pageerror', (err) => console.log('PAGE', err.message));
try {
  await boot(androidPage);
  const result = await play(androidPage, { label: 'android', record: false, stray: true });
  console.log('android path', result.seen.join(' > '));
  if (result.final !== 'ready' || !result.stray) {
    console.error('android failed', result);
    failed += 1;
  }
} catch (e) {
  console.error(e);
  failed += 1;
}
await androidCtx.close();
await android.close();

const lateBrowser = await webkit.launch();
const lateCtx = await lateBrowser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
const latePage = await lateCtx.newPage();
try {
  await boot(latePage);
  await latePage.click('#coachPop [data-act="next"]');
  await latePage.waitForFunction(() => window.__kolopolyState().practice.step === 'cash');
  await latePage.waitForFunction(() => document.querySelector('#hudCashBtn').classList.contains('coach-live'));
  await latePage.click('#hudCashBtn');
  await latePage.waitForFunction(() => window.__kolopolyState().practice.step === 'roll');
  await latePage.evaluate(() => {
    const ws = window.__kpsockets[window.__kpsockets.length - 1];
    ws.send(JSON.stringify({ type: 'test_delay_buy' }));
  });
  await latePage.waitForTimeout(200);
  await latePage.waitForFunction(() => document.querySelector('#abRoll').classList.contains('coach-live'));
  await latePage.click('#abRoll');
  await latePage.waitForFunction(() => window.__kolopolyState().practice.step === 'walked');
  await latePage.click('#coachPop [data-act="next"]');
  await latePage.waitForFunction(() => {
    const s = window.__kolopolyState();
    return s.practice.step === 'buy' && s.phase !== 'buy';
  });
  const hidden = await latePage.locator('#abBuy').count();
  await latePage.waitForTimeout(1800);
  const stillHidden = await latePage.locator('#abBuy').count();
  await latePage.evaluate(() => {
    const ws = window.__kpsockets[window.__kpsockets.length - 1];
    ws.send(JSON.stringify({ type: 'test_release_buy' }));
  });
  await latePage.waitForSelector('#abBuy', { timeout: 4000 });
  console.log('delayed buy hidden', hidden, 'still', stillHidden, 'then shown');
  if (hidden !== 0 || stillHidden !== 0) failed += 1;
} catch (e) {
  console.error('delay', e);
  failed += 1;
}
await lateCtx.close();
await lateBrowser.close();
server.kill();
console.log(failed ? 'BROWSER FAIL ' + failed : 'browser lesson passed');
process.exit(failed ? 1 : 0);
