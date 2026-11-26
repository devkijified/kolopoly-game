// Link hold screenshots at 390px (deviceScaleFactor 2):
// 1. paid-hold.png: a paid room mid-hold. The dropped seat is driven
//    by a raw socket client; the phone on screen is the other seat,
//    and it must show the compact banner with a live countdown, not
//    the full-screen pause card.
// 2. free-drop.png: a free room right after a drop. The phone on
//    screen is the other seat: the seat is already a bot, play is
//    live, and the small drop toast is on screen.
// Run: node shots-link-hold.mjs   (spawns its own KP_TEST server)
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';

const PORT = 4235;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = new URL('./shots-link-hold/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), KP_TEST: '1', KP_ADMIN_TOKEN: '', KP_PERSIST_ROOMS: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('Kolopoly listening')) res(); }));

const chromePath = (() => {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  for (const dir of fs.readdirSync(base)) {
    if (!/^chromium-\d+$/.test(dir)) continue;
    const p = path.join(base, dir, 'chrome-linux64', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('no cached chromium');
})();
const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
const mkCtx = () => browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
});
const S = (page) => page.evaluate(() => window.__kolopolyState());
async function waitState(page, pred, label, ms) {
  const end = Date.now() + (ms || 25000);
  while (Date.now() < end) { const s = await S(page); if (s && pred(s)) return s; await sleep(200); }
  throw new Error('waitState timeout: ' + label);
}
async function typeName(page, name) {
  await page.evaluate(() => {
    const el = document.getElementById('nameIn');
    if (el && el.offsetParent === null) {
      const cand = [document.getElementById('inviteChangeBtn'), document.getElementById('welcomeChange')];
      const t = cand.find((b) => b && b.offsetParent !== null);
      if (t) t.click();
    }
  });
  await page.fill('#nameIn', name);
}
const clickEl = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) throw new Error('missing ' + s);
  el.click();
}, sel);
async function passLearnGate(page) {
  for (let i = 0; i < 12; i++) {
    const hit = await page.evaluate(() => {
      const b = document.getElementById('trainOfferNo');
      if (b && b.offsetParent !== null) { b.click(); return true; }
      return false;
    });
    if (hit) return;
    await sleep(300);
  }
}
async function openPhone(name) {
  const ctx = await mkCtx();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await typeName(page, name);
  return { ctx, page };
}

// A raw socket player: the seat that will drop. It never renders, so
// its drop is a pure network event on the server.
class Raw {
  constructor() { this.state = null; this.playerId = null; this.token = null; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('ws://127.0.0.1:' + PORT);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'joined') { this.playerId = msg.playerId; if (msg.token) this.token = msg.token; }
        if (msg.type === 'state') this.state = msg.room;
      });
    });
  }
  send(type, obj) { this.ws.send(JSON.stringify(Object.assign({ type }, obj || {}))); }
  async waitFor(pred, label, ms) {
    const end = Date.now() + (ms || 10000);
    while (Date.now() < end) { if (this.state && pred(this.state)) return; await sleep(40); }
    throw new Error('raw timeout: ' + label);
  }
}

try {
  // ---------------------------------------------------------- paid hold
  const host = await openPhone('Hassan');
  await clickEl(host.page, '#gameModeRow [data-gmode="classic"]');
  await clickEl(host.page, '#createBtn');
  await passLearnGate(host.page);
  await waitState(host.page, (s) => s.status === 'lobby', 'paid host lobby');
  const paidCode = (await S(host.page)).code;
  const dropper = new Raw();
  await dropper.connect();
  dropper.send('join_room', { code: paidCode, name: 'Bola', token: 'keke', clientId: 'shot-bola-device-1' });
  await dropper.waitFor((s) => s.players.length === 2, 'paid guest seated');
  const bolaId = dropper.playerId;
  await waitState(host.page, (s) => s.players.length === 2, 'paid host sees two');
  await clickEl(host.page, '#startBtn');
  await waitState(host.page, (s) => s.status === 'playing', 'paid playing');
  // Mark the room paid from the host phone, as the test hooks allow.
  await host.page.evaluate((pid) => window.__kolopolySend('test_set_paid', { playerId: pid, fee: 200 }), bolaId);
  await waitState(host.page, (s) => s.paid && s.paid.fee === 200, 'paid flag');
  dropper.ws.close();
  await waitState(host.page, (s) => !!s.linkWait, 'paid hold armed');
  // Let the banner settle and the countdown tick off the top seconds.
  await host.page.waitForFunction(() => {
    const b = document.getElementById('linkHoldBanner');
    const c = b && b.querySelector('.lhb-clock');
    return b && !b.hidden && c && /^\d+:\d{2}$/.test(c.textContent) && c.textContent !== '2:30';
  }, undefined, { timeout: 20000, polling: 200 });
  const paidInfo = await host.page.evaluate(() => {
    const b = document.getElementById('linkHoldBanner');
    const r = b.getBoundingClientRect();
    const o = document.getElementById('pauseOverlay');
    return {
      text: b.textContent.replace(/\s+/g, ' ').trim(),
      rect: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width) },
      iw: window.innerWidth,
      overlayShown: o.classList.contains('show')
    };
  });
  console.log('paid banner:', JSON.stringify(paidInfo));
  await host.page.screenshot({ path: OUT + 'paid-hold.png' });
  await host.ctx.close();

  // ---------------------------------------------------------- free drop
  const stayer = await openPhone('Tobi');
  await clickEl(stayer.page, '#gameModeRow [data-gmode="classic"]');
  await clickEl(stayer.page, '#createBtn');
  await passLearnGate(stayer.page);
  await waitState(stayer.page, (s) => s.status === 'lobby', 'free host lobby');
  const freeCode = (await S(stayer.page)).code;
  const leaver = new Raw();
  await leaver.connect();
  leaver.send('join_room', { code: freeCode, name: 'Learner', token: 'keke', clientId: 'shot-learner-device-2' });
  await leaver.waitFor((s) => s.players.length === 2, 'free guest seated');
  const leaverId = leaver.playerId;
  await waitState(stayer.page, (s) => s.players.length === 2, 'free host sees two');
  await clickEl(stayer.page, '#startBtn');
  await waitState(stayer.page, (s) => s.status === 'playing', 'free playing');
  leaver.ws.close();
  // The seat converts at once and the toast starts its 4.2s clock.
  // The shutter on a software-GL rig is slower than that clock, so
  // the moment the real toast is up, its dismiss timer is cleared
  // page-side and the toast is held exactly as the player saw it
  // while the screenshot lands. Nothing about the toast is faked:
  // same element, same words, just held still for the camera.
  await stayer.page.waitForFunction((pid) => {
    const st = window.__kolopolyState();
    const p = st && st.players.find((x) => x.id === pid);
    const t = document.getElementById('toast');
    return p && p.bot && t && t.classList.contains('show') && /network blink/.test(t.textContent);
  }, leaverId, { timeout: 45000, polling: 100 });
  await stayer.page.evaluate(() => { try { clearTimeout(toastTimer); } catch (e) { } });
  await stayer.page.screenshot({ path: OUT + 'free-drop.png' });
  const freeInfo = await stayer.page.evaluate(() => {
    const t = document.getElementById('toast');
    const o = document.getElementById('pauseOverlay');
    const b = document.getElementById('linkHoldBanner');
    return {
      toast: t.textContent.replace(/\s+/g, ' ').trim(),
      showing: t.classList.contains('show'),
      overlayShown: o.classList.contains('show'),
      bannerHidden: b.hidden
    };
  });
  console.log('free toast:', JSON.stringify(freeInfo));
  if (!freeInfo.showing || !/network blink/.test(freeInfo.toast)) throw new Error('the drop toast was not up for the shot');
  await stayer.ctx.close();
  console.log('shots done ->', OUT);
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
