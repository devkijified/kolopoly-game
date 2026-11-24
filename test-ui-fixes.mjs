// Lobby and board polish: the inflation chip matches the seven-phase
// salaries, a 390px bar keeps its icons, "Awaiting payment" fits the
// seat, the home icon finds your token without moving the camera, and
// the Owambe pot shows its real amount at once (and reads as empty at
// zero). Run: node test-ui-fixes.mjs
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; } catch (e) { console.log('SKIP: puppeteer-core missing'); process.exit(0); }
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: Chrome missing'); process.exit(0); }

const PORT = 4272;
const BASE = 'http://127.0.0.1:' + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-ui-'));
let checks = 0, failures = 0;
const check = (name, cond, extra) => {
  checks++;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures++; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), KP_TEST: '1', KP_DATA_DIR: dir, KP_PERSIST_ROOMS: '',
    RESEND_API_KEY: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
    KP_AUTH_SECRET: 'ui-fixes-secret'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--no-proxy-server'] });
try {
  for (let i = 0; i < 80 && !log.includes('listening'); i++) await sleep(50);
  const email = 'ui@example.com';
  const req = await (await fetch(BASE + '/api/auth/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })).json();
  const session = await (await fetch(BASE + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: req.devCode }) })).json();

  async function phone() {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page.on('pageerror', (e) => page.__errs = (page.__errs || []).concat(e.message));
    return page;
  }

  const page = await phone();
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__kolopolySend === 'function', { timeout: 8000 });
  await page.evaluate(() => window.__kolopolySend('create_room', { name: 'Ada', token: 'danfo', mode: 'online', settings: { gameMode: 'inflation' } }));
  await page.waitForFunction(() => {
    const s = window.__kolopolyState && window.__kolopolyState();
    return s && s.status === 'lobby' && s.settings && s.settings.gameMode === 'inflation';
  }, { timeout: 8000 });
  const chip = await page.evaluate(() => {
    const box = document.getElementById('lobbySettings');
    return box ? box.textContent : '';
  });
  check('the lobby salary chip is the seven-phase ladder',
    chip.includes('200,000') && chip.includes('140,000') && chip.includes('100,000') && chip.includes('70,000') && chip.includes('40,000') && chip.includes('20,000') && chip.includes('10,000') && !chip.includes('25,000'),
    chip);
  const bar = await page.evaluate(() => {
    const mute = document.getElementById('muteBtn').getBoundingClientRect();
    const share = document.getElementById('shareBtn').getBoundingClientRect();
    return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, mute: mute.right, share: share.right };
  });
  check('the 390px lobby bar keeps every icon on screen', bar.sw <= bar.iw + 1 && bar.mute <= bar.iw + 1 && bar.share <= bar.iw + 1, JSON.stringify(bar));

  await page.evaluate(() => window.__kolopolySend('add_bot', {}));
  await page.waitForFunction(() => window.__kolopolyState().players.length === 2, { timeout: 8000 });
  await page.evaluate(() => window.__kolopolySend('start_game', {}));
  await page.waitForFunction(() => window.__kolopolyState().status === 'playing', { timeout: 8000 });
  await sleep(600);
  const emptyPot = await page.evaluate(() => {
    const d = window.KP3D && KP3D.potReadout && KP3D.potReadout();
    const el = document.getElementById('centerPot');
    return { d, html: el ? el.textContent : '' };
  });
  const emptyText = (emptyPot.d && emptyPot.d.text) || emptyPot.html;
  check('an empty pot reads as empty, not N0', /empty/i.test(emptyText) && !/₦0|N0/.test(emptyText), JSON.stringify(emptyPot));

  await page.evaluate(() => window.__kolopolySend('test_set_pot', { amount: 250000 }));
  await page.waitForFunction(() => window.__kolopolyState().pot === 250000, { timeout: 4000 });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => {
    const s = window.__kolopolyState && window.__kolopolyState();
    return s && s.status === 'playing' && s.pot === 250000;
  }, { timeout: 10000 });
  await sleep(400);
  const livePot = await page.evaluate(() => {
    const d = window.KP3D && KP3D.potReadout && KP3D.potReadout();
    const el = document.getElementById('centerPot');
    return { d, html: el ? el.textContent : '' };
  });
  const snapped = livePot.d ? Math.abs(livePot.d.count - 250000) < 1 && /250,000/.test(livePot.d.text) : /250,000/.test(livePot.html);
  check('after a reload the pot shows ₦250,000 immediately', snapped, JSON.stringify(livePot));

  const before = await page.evaluate(() => window.KP3D && KP3D.camInfo ? KP3D.camInfo() : null);
  await page.click('#viewToggle');
  await sleep(250);
  const after = await page.evaluate(() => ({
    cam: window.KP3D && KP3D.camInfo ? KP3D.camInfo() : null,
    label: document.getElementById('viewToggle').getAttribute('aria-label'),
    toast: (document.querySelector('.toast') || {}).textContent || ''
  }));
  check('the home icon names a real job and does not move the camera',
    /token/i.test(after.label || '') && /flash|token/i.test(after.toast) && (!before || !after.cam || JSON.stringify(before.pos) === JSON.stringify(after.cam.pos)),
    JSON.stringify({ label: after.label, toast: after.toast, before: before && before.pos, after: after.cam && after.cam.pos }));

  const paid = await phone();
  await paid.evaluateOnNewDocument((t, e) => {
    localStorage.setItem('kolopolyAuthToken', t);
    localStorage.setItem('kolopolyAuthEmail', e);
    localStorage.setItem('kolopolyName', 'Payer');
  }, session.token, email);
  await paid.goto(BASE + '/', { waitUntil: 'load' });
  await paid.waitForFunction(() => typeof window.__kolopolySend === 'function', { timeout: 8000 });
  await paid.evaluate((t) => window.__kolopolySend('create_room', { name: 'Payer', token: 'danfo', mode: 'online', cityId: 'lagos', authToken: t, settings: { gameMode: 'inflation' } }), session.token);
  await paid.waitForSelector('.slot .meta', { visible: true, timeout: 8000 });
  const seat = await paid.evaluate(() => {
    const meta = document.querySelector('.slot .meta');
    const r = meta.getBoundingClientRect();
    const slot = meta.closest('.slot').getBoundingClientRect();
    return { text: meta.textContent, metaRight: r.right, slotRight: slot.right, sw: document.documentElement.scrollWidth, iw: window.innerWidth };
  });
  check('Awaiting payment is fully inside the seat', /Awaiting payment/.test(seat.text) && seat.metaRight <= seat.slotRight + 1, JSON.stringify(seat));
  check('the paid lobby bar does not overflow at 390px', seat.sw <= seat.iw + 1, JSON.stringify(seat));
  const errs = await page.evaluate(() => window.__pageErrors || []);
  check('no page errors on the free table', !(page.__errs && page.__errs.length), JSON.stringify(page.__errs || []));
  void errs;
} catch (e) {
  failures++;
  console.log('SUITE ERROR: ' + (e && e.stack || e));
  if (log) console.log(log.slice(-400));
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
}
console.log('---\nchecks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
