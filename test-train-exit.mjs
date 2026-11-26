// The Training Ground Exit control leaves for home, and asks first mid-lesson.
import { spawn } from 'child_process';
import { webkit } from 'playwright';
import fs from 'fs';

const PORT = 4598;
const OUT = '/opt/cursor/artifacts';
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
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok', name);
  else { failed += 1; console.log('  FAIL', name, extra || ''); }
}

async function boot(page) {
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  const skip = page.locator('#trainOfferNo');
  if (await skip.count() && await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(() => {
    const name = document.getElementById('nameIn');
    if (name) name.value = 'Kiji';
    try { localStorage.setItem('kolopolyName', 'Kiji'); } catch (e) { /* private */ }
  });
  await page.locator('#trainBtn').scrollIntoViewIfNeeded();
  await page.click('#trainBtn');
  await page.click('#trainIntro');
  await page.waitForFunction(() => {
    const s = window.__kolopolyState && window.__kolopolyState();
    return s && s.practice && s.practice.step === 'hello';
  });
  await sleep(400);
}

async function layout(page) {
  return page.evaluate(() => {
    const box = (el) => {
      if (!el || el.hidden) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
    };
    const hit = (a, b) => a && b && a.l < b.r - 1 && a.r > b.l + 1 && a.t < b.b - 1 && a.b > b.t + 1;
    const exit = box(document.getElementById('trainExit'));
    const mute = box(document.getElementById('muteBtn'));
    const share = box(document.getElementById('shareBtn'));
    const coach = box(document.getElementById('coachPop'));
    const room = document.getElementById('roomChip');
    const roomShown = !!(room && getComputedStyle(room).display !== 'none' && !room.classList.contains('hidden'));
    const finger = box(document.getElementById('coachFinger'));
    const deals = box(document.getElementById('hudDeals'));
    return {
      exit, mute, share, coach, roomShown, finger, deals,
      exitHitsMute: hit(exit, mute),
      exitHitsShare: hit(exit, share),
      exitHitsCoach: hit(exit, coach),
      fingerHitsDeals: hit(finger, deals),
      step: (window.__kolopolyState() && window.__kolopolyState().practice.step) || ''
    };
  });
}

const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (err) => { if (!/audio device/i.test(err.message)) console.log('PAGE', err.message); });
try {
  await boot(page);
  const hello = await layout(page);
  check('Exit is on the first step and at least 44px', hello.exit && hello.exit.h >= 44 && hello.exit.w >= 44 && hello.exit.t < 70, JSON.stringify(hello.exit));
  check('Exit does not cover mute, share, or the lesson card', !hello.exitHitsMute && !hello.exitHitsShare && !hello.exitHitsCoach, JSON.stringify(hello));
  await page.screenshot({ path: OUT + '/train-exit-hello-390.png' });

  await page.click('#coachPop [data-act="next"]');
  await page.waitForFunction(() => window.__kolopolyState().practice.step === 'cash');
  await page.click('#hudCashBtn');
  await page.waitForFunction(() => window.__kolopolyState().practice.step === 'roll');
  await page.click('#abRoll');
  await page.waitForFunction(() => window.__kolopolyState().practice.step === 'walked');
  await sleep(700);
  const mid = await layout(page);
  check('Exit stays clear once the dice are on the board', mid.exit && mid.exit.h >= 44 && !mid.exitHitsMute && !mid.exitHitsShare && !mid.exitHitsCoach && !mid.roomShown, JSON.stringify(mid));
  check('the pointer does not cover the deals button', !mid.fingerHitsDeals, JSON.stringify({ finger: mid.finger, deals: mid.deals }));
  await page.screenshot({ path: OUT + '/train-exit-mid-390.png' });

  await page.click('#trainExit');
  await page.waitForSelector('#trainLeaveSheet:not([hidden])');
  await sleep(200);
  const ask = await page.evaluate(() => {
    const sheet = document.getElementById('trainLeaveSheet');
    const r = sheet.getBoundingClientRect();
    const text = sheet.innerText || '';
    return { w: r.width, h: r.height, t: r.top, text, step: window.__kolopolyState().practice.step };
  });
  check('mid-lesson Exit asks before leaving', /leave training/i.test(ask.text) && /leave/i.test(ask.text) && /stay/i.test(ask.text) && ask.step === 'walked', ask.text);
  await page.screenshot({ path: OUT + '/train-exit-ask-390.png' });
  await page.click('#trainLeaveSheet [data-act="stay"]');
  await sleep(200);
  const stayed = await page.evaluate(() => ({
    hidden: document.getElementById('trainLeaveSheet').hidden,
    step: window.__kolopolyState().practice.step
  }));
  check('Stay keeps the lesson', stayed.hidden && stayed.step === 'walked', JSON.stringify(stayed));

  await page.click('#trainExit');
  await page.click('#trainLeaveSheet [data-act="leave"]');
  await page.waitForFunction(() => document.getElementById('view-landing').classList.contains('active'));
  await sleep(800);
  const home = await page.evaluate(() => ({
    landing: document.getElementById('view-landing').classList.contains('active'),
    game: document.getElementById('view-game').classList.contains('active'),
    state: window.__kolopolyState(),
    exit: !document.getElementById('trainExit').hidden,
    gone: /room don close/i.test(document.body.innerText || ''),
    toast: document.getElementById('toast').classList.contains('show') ? document.getElementById('toast').innerText : ''
  }));
  check('Leave returns to the home screen', home.landing && !home.game && !home.state && home.exit === false && !home.gone && !/room don close/i.test(home.toast), JSON.stringify(home));
  await page.screenshot({ path: OUT + '/train-exit-home-390.png' });
} catch (e) {
  console.error(e);
  failed += 1;
  try { await page.screenshot({ path: OUT + '/train-exit-fail-390.png' }); } catch (err) { /* page gone */ }
}
await ctx.close();
await browser.close();
server.kill();
console.log(failed ? 'FAILED ' + failed : 'train-exit ok');
process.exit(failed ? 1 : 0);
