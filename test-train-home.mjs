// Play your first real game must leave the Training Ground for the home screen.
import { spawn } from 'child_process';
import { webkit } from 'playwright';
import fs from 'fs';

const PORT = 4596;
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

function wireSockets() {
  const Orig = WebSocket;
  window.__kpsockets = [];
  function Wrapped(url, protocols) {
    const ws = protocols ? new Orig(url, protocols) : new Orig(url);
    window.__kpsockets.push(ws);
    return ws;
  }
  Wrapped.prototype = Orig.prototype;
  window.WebSocket = Wrapped;
}

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok', name);
  else { failed += 1; console.log('  FAIL', name, extra || ''); }
}

const browser = await webkit.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true
});
const page = await ctx.newPage();
page.on('pageerror', (err) => { if (!/audio device/i.test(err.message)) console.log('PAGE', err.message); });
try {
  await page.addInitScript(wireSockets);
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
    return s && s.practice && s.practice.step === 'hello' && s.status === 'playing';
  });
  await page.evaluate(() => {
    const ws = window.__kpsockets[window.__kpsockets.length - 1];
    ws.send(JSON.stringify({ type: 'resign' }));
  });
  await page.waitForSelector('#endReal', { timeout: 8000 });
  await page.waitForTimeout(400);
  const endText = await page.locator('#endReal').innerText();
  check('the final table offers a real game', /real game/i.test(endText), endText);
  await page.screenshot({ path: OUT + '/train-exit-end-390.png' });
  await page.click('#endReal');
  await page.waitForFunction(() => {
    const landing = document.getElementById('view-landing');
    const game = document.getElementById('view-game');
    return landing && landing.classList.contains('active') && game && !game.classList.contains('active');
  }, null, { timeout: 8000 });
  await page.waitForTimeout(2200);
  const after = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const landing = document.getElementById('view-landing');
    const welcome = document.getElementById('welcomeCard');
    const join = document.getElementById('joinCard');
    const home = (welcome && !welcome.classList.contains('hidden') ? welcome : join);
    return {
      landing: !!(landing && landing.classList.contains('active')),
      game: document.getElementById('view-game').classList.contains('active'),
      state: window.__kolopolyState(),
      coach: !!(document.getElementById('coachPop') && !document.getElementById('coachPop').hidden),
      end: document.getElementById('endOverlay').classList.contains('show'),
      gone: /room don close/i.test(text),
      toast: (document.getElementById('toast') && document.getElementById('toast').classList.contains('show')) ? document.getElementById('toast').innerText : '',
      homeText: home ? home.innerText.replace(/\s+/g, ' ').slice(0, 240) : '',
      canPlay: !!(document.getElementById('welcomeQuick') || document.getElementById('quickBtn'))
    };
  });
  await page.screenshot({ path: OUT + '/train-exit-home-390.png' });
  check('the landing is the active view', after.landing && !after.game, JSON.stringify(after));
  check('no training room is still open', !after.state, JSON.stringify(after.state && after.state.practice));
  check('the lesson card and final table are gone', !after.coach && !after.end);
  check('no room-closed toast', !after.gone && !/room don close/i.test(after.toast), after.toast);
  check('home can start a real game', /Quick play|Create room|Join/i.test(after.homeText), after.homeText);

  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  const skip2 = page.locator('#trainOfferNo');
  if (await skip2.count() && await skip2.isVisible().catch(() => false)) await skip2.click();
  await page.evaluate(() => { const name = document.getElementById('nameIn'); if (name) name.value = 'Kiji'; });
  await page.locator('#trainBtn').scrollIntoViewIfNeeded();
  await page.click('#trainBtn');
  await page.click('#trainIntro');
  await page.waitForFunction(() => {
    const s = window.__kolopolyState && window.__kolopolyState();
    return s && s.practice && s.practice.step === 'hello';
  });
  await page.click('#coachPop [data-act="skip"]');
  await page.waitForFunction(() => window.__kolopolyState().practice.step === 'ready');
  await page.click('#coachPop [data-act="real"]');
  await page.waitForFunction(() => document.getElementById('view-landing').classList.contains('active'));
  await page.waitForTimeout(800);
  const readyExit = await page.evaluate(() => ({
    landing: document.getElementById('view-landing').classList.contains('active'),
    state: window.__kolopolyState(),
    gone: /room don close/i.test(document.body.innerText || '')
  }));
  check('the trained-card button also returns home', readyExit.landing && !readyExit.state && !readyExit.gone, JSON.stringify(readyExit));
} catch (e) {
  console.error(e);
  failed += 1;
  try { await page.screenshot({ path: OUT + '/train-exit-fail-390.png' }); } catch (err) { /* no page */ }
}
await ctx.close();
await browser.close();
server.kill();
console.log(failed ? 'FAILED ' + failed : 'train-home ok');
process.exit(failed ? 1 : 0);
