import { spawn } from 'child_process';
import { webkit } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 4291;
const BASE = 'http://127.0.0.1:' + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-ovf-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: '/agent/repos/kolopoly-game',
  env: Object.assign({}, process.env, {
    PORT: String(PORT), KP_TEST: '1', KP_DATA_DIR: dir, KP_PERSIST_ROOMS: '',
    RESEND_API_KEY: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
    KP_AUTH_SECRET: 'overflow-secret'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

async function measure(page, label) {
  const r = await page.evaluate(() => {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const offenders = [];
    for (const el of document.body.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 && rect.height < 2) continue;
      if (rect.right > vw + 1 || rect.left < -1) {
        const cls = typeof el.className === 'string' ? el.className : '';
        offenders.push({
          id: el.id || '',
          cls: cls.slice(0, 70),
          w: Math.round(rect.width),
          l: Math.round(rect.left),
          r: Math.round(rect.right)
        });
      }
    }
    offenders.sort((a, b) => (b.r - Math.max(0, b.l)) - (a.r - Math.max(0, a.l)));
    function box(id) {
      const el = document.getElementById(id);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { l: Math.round(rect.left), r: Math.round(rect.right), w: Math.round(rect.width) };
    }
    return {
      scroll: de.scrollWidth,
      client: de.clientWidth,
      inner: window.innerWidth,
      body: document.body.scrollWidth,
      scrollX: window.scrollX,
      room: (document.getElementById('roomChip') || {}).textContent || '',
      roomBox: box('roomChip'),
      topbar: box(''),
      bars: {
        top: document.querySelector('.topbar') ? (function () { const r = document.querySelector('.topbar').getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width) }; })() : null,
        lobby: document.getElementById('view-lobby') ? (function () { const r = document.getElementById('view-lobby').getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width) }; })() : null,
        wrap: document.querySelector('.lobby-wrap') ? (function () { const r = document.querySelector('.lobby-wrap').getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width) }; })() : null,
        slots: document.getElementById('slotBoard') ? (function () { const r = document.getElementById('slotBoard').getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width), sl: document.getElementById('slotBoard').scrollLeft }; })() : null
      },
      salary: (document.querySelector('.chip-salary') || {}).textContent || '',
      head: (document.querySelector('.paid-panel-head') || {}).textContent || '',
      offenders: offenders.filter((o) => o.cls.indexOf('hs-') !== 0 && o.cls !== 'hero-scene').slice(0, 8)
    };
  });
  const ok = r.scroll === r.client && r.scrollX === 0;
  if (!ok) failures.push(label + ' scroll=' + r.scroll + ' client=' + r.client);
  console.log((ok ? 'OK ' : 'FAIL ') + label + ' scroll=' + r.scroll + ' client=' + r.client + ' inner=' + r.inner + ' x=' + r.scrollX);
  console.log(JSON.stringify({ room: r.room, roomBox: r.roomBox, bars: r.bars, salary: (r.salary || '').slice(0, 90), head: (r.head || '').slice(0, 80), offenders: r.offenders }, null, 2));
  return ok;
}

try {
  for (let i = 0; i < 80 && !log.includes('listening'); i++) await sleep(50);
  if (!log.includes('listening')) throw new Error('server: ' + log.slice(-400));
  const browser = await webkit.launch();
  const widths = [390, 430];
  for (const width of widths) {
    const ctx = await browser.newContext({
      viewport: { width, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2
    });
    const page = await ctx.newPage();
    const sign = await (await fetch(BASE + '/api/auth/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ovf-' + width + '@example.com' }) })).json();
    const session = await (await fetch(BASE + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ovf-' + width + '@example.com', code: sign.devCode }) })).json();
    await page.addInitScript((t) => {
      localStorage.setItem('kolopolyAuthToken', t.token);
      localStorage.setItem('kolopolyAuthEmail', t.email);
      localStorage.setItem('kolopolyName', 'Tife');
      localStorage.setItem('kolopolyGameMode', 'inflation');
    }, session);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => typeof window.__kolopolySend === 'function', { timeout: 8000 });
    await page.waitForTimeout(400);
    await measure(page, width + ' landing');

    await page.evaluate((t) => window.__kolopolySend('create_room', { name: 'Tife', token: 'danfo', mode: 'online', authToken: t, settings: { gameMode: 'classic', timed: false } }), session.token);
    await page.waitForSelector('#leaveLobbyBtn', { timeout: 8000 });
    await page.waitForTimeout(300);
    await measure(page, width + ' room');

    await page.evaluate(() => {
      localStorage.removeItem('kolopolySeatLS');
      sessionStorage.removeItem('kolopolySeat');
    });
    const paid = await ctx.newPage();
    await paid.addInitScript(() => {
      localStorage.removeItem('kolopolySeatLS');
      sessionStorage.removeItem('kolopolySeat');
    });
    await paid.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await paid.waitForFunction(() => typeof window.__kolopolySend === 'function', { timeout: 8000 });
    await paid.evaluate((t) => window.__kolopolySend('create_room', { name: 'Tife', token: 'danfo', mode: 'online', cityId: 'lagos', authToken: t, settings: { gameMode: 'inflation' } }), session.token);
    await paid.waitForSelector('.paid-panel-head', { timeout: 8000 });
    await paid.waitForSelector('.chip-salary', { timeout: 8000 });
    await paid.waitForTimeout(400);
    await measure(paid, width + ' paid room');
    const shot = width === 390 ? '/opt/cursor/artifacts/paid-room-390.png' : '/tmp/paid-room-430.png';
    fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
    await paid.screenshot({ path: shot, fullPage: false });

    await paid.goto(BASE + '/classic.html', { waitUntil: 'domcontentloaded' });
    await paid.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await paid.waitForTimeout(600);
    await measure(paid, width + ' paid room after return');

    await page.evaluate(() => window.__kolopolySend('add_bot', {}));
    await page.evaluate(() => window.__kolopolySend('start_game', {}));
    await page.waitForFunction(() => {
      const s = window.__kolopolyState && window.__kolopolyState();
      return s && (s.status === 'playing' || s.status === 'countdown');
    }, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    await measure(page, width + ' in-game');
    await ctx.close();
  }
  await browser.close();
  if (failures.length) {
    console.log('OVERFLOW ' + failures.join('; '));
    process.exitCode = 1;
  } else console.log('webkit overflow clean at 390 and 430');
} finally {
  server.kill();
}
