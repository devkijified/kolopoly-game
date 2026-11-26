// Lobby and HUD cleanup screenshots at 390x844 and 360x780:
// 1. lobby-host-<size>.png: host lobby, host + 2 joined + empty seats.
// 2. lobby-guest-<size>.png: guest lobby, "Waiting for host".
// 3. hud-bottom-<size>.png: match screen bottom (dock padding, the
//    Deals pill with its whole label).
// 4. auction-<size>.png: the auction sheet, opaque, mid-auction.
// Run: node shots-lobby-hud.mjs   (spawns its own KP_TEST server)
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';

const PORT = 4242;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = new URL('./shots-lobby-hud/', import.meta.url).pathname;
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
const mkCtx = (w, h) => browser.newContext({
  viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
});
const S = (page) => page.evaluate(() => window.__kolopolyState());
async function waitState(page, pred, label, ms) {
  const end = Date.now() + (ms || 25000);
  while (Date.now() < end) { const s = await S(page); if (s && pred(s)) return s; await sleep(200); }
  throw new Error('waitState timeout: ' + label);
}
async function typeName(page, name) {
  // The landing swaps its welcome/invite layouts while async state
  // resolves, so the field flickers in and out of visibility and a
  // raw fill() can starve. Reveal the field when it sits behind the
  // Change button, then set the value the Join/Create handlers read,
  // and keep setting it until it sticks across two reads.
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const stuck = await page.evaluate((n) => {
      const el = document.getElementById('nameIn');
      if (!el) return false;
      if (el.offsetParent === null) {
        const cand = [document.getElementById('inviteChangeBtn'), document.getElementById('welcomeChange')];
        const t = cand.find((b) => b && b.offsetParent !== null);
        if (t) t.click();
      }
      if (el.value !== n) {
        el.value = n;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return false;
      }
      return true;
    }, name);
    if (stuck) {
      await sleep(600);
      const again = await page.evaluate((n) => { const el = document.getElementById('nameIn'); return !!el && el.value === n; }, name);
      if (again) return;
    }
    await sleep(300);
  }
  throw new Error('typeName: the name never stuck');
}
const clickEl = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) throw new Error('missing ' + s);
  el.click();
}, sel);
async function passLearnGate(page) {
  for (let i = 0; i < 30; i++) {
    const hit = await page.evaluate(() => {
      const b = document.getElementById('trainOfferNo');
      if (b && b.offsetParent !== null) { b.click(); return true; }
      return false;
    });
    if (hit) return;
    await sleep(400);
  }
}
async function openPhone(name, w, h) {
  const ctx = await mkCtx(w, h);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!document.getElementById('nameIn'), undefined, { timeout: 20000, polling: 150 });
  await typeName(page, name);
  return { ctx, page };
}
async function openGuest(name, code, w, h) {
  const ctx = await mkCtx(w, h);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(BASE + '/?join=' + code, { waitUntil: 'commit', timeout: 90000 });
  await typeName(page, name);
  await page.waitForFunction(() => { const b = document.getElementById('joinBtn'); return b && b.offsetParent !== null; }, undefined, { timeout: 45000, polling: 150 });
  await clickEl(page, '#joinBtn');
  return { ctx, page };
}
// A raw socket player: fills a seat without a second rendered phone.
class Raw {
  constructor() { this.state = null; this.playerId = null; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('ws://127.0.0.1:' + PORT);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'joined') this.playerId = msg.playerId;
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

async function snap(page, file) {
  // The 3D board on a software-GL rig can take far longer than the
  // default 30s to composite a frame; give the shutter room and one
  // retry before giving up on the shot.
  for (let i = 0; i < 2; i++) {
    try { await page.screenshot({ path: file, timeout: 120000 }); return; }
    catch (e) { if (i === 1) throw e; await sleep(1500); }
  }
}
async function snapFast(page, file) {
  // CDP capture: returns the current frame in well under a second, no
  // stability or font waits. For subjects with a live clock (the 4s
  // test auction, the 15s test vote) the slow shutter only ever
  // photographs the aftermath.
  const cdp = await page.context().newCDPSession(page);
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  } finally { await cdp.detach().catch(() => {}); }
}
async function untilDom(page, fn, label, ms) {
  const end = Date.now() + (ms || 45000);
  while (Date.now() < end) {
    if (await page.evaluate(fn)) return;
    await sleep(400);
  }
  throw new Error('untilDom timeout: ' + label);
}
async function shootSize(w, h) {
  const tag = w + 'x' + h;
  // ---- lobby: host + 2 joined (one rendered guest, one raw) + empties
  const host = await openPhone('Ngozi', w, h);
  await clickEl(host.page, '#gameModeRow [data-gmode="classic"]');
  await clickEl(host.page, '#createBtn');
  await passLearnGate(host.page);
  await waitState(host.page, (s) => s.status === 'lobby', 'host lobby ' + tag);
  const code = (await S(host.page)).code;
  const guest = await openGuest('Adaeze', code, w, h);
  await waitState(guest.page, (s) => s.status === 'lobby' && s.players.length === 2, 'guest lobby ' + tag);
  const raw = new Raw();
  await raw.connect();
  raw.send('join_room', { code, name: 'Tunde', token: 'keke', clientId: 'shot-raw-' + tag });
  await raw.waitFor((s) => s.players.length === 3, 'raw seated ' + tag);
  await host.page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('#slotBoard .slot')];
    return cards.filter((c) => !c.classList.contains('empty')).length === 3;
  }, undefined, { timeout: 15000, polling: 150 });
  await sleep(700); // let the join pop settle
  await snap(host.page, OUT + 'lobby-host-' + tag + '.png');
  console.log('shot lobby-host-' + tag);
  await passLearnGate(guest.page);
  await untilDom(guest.page, () => {
    const wEl = document.getElementById('lobbyWaitHost');
    return wEl && !wEl.classList.contains('hidden');
  }, 'guest waiting block ' + tag);
  await snap(guest.page, OUT + 'lobby-guest-' + tag + '.png');
  console.log('shot lobby-guest-' + tag);

  // ---- match: start, shoot the HUD bottom, then drive an auction
  await clickEl(host.page, '#startBtn');
  const st = await waitState(host.page, (s) => s.status === 'playing', 'playing ' + tag);
  await waitState(guest.page, (s) => s.status === 'playing', 'guest playing ' + tag);
  const turnId = st.turnPlayerId;
  const hostId = st.players[0].id;
  const turnPage = turnId === hostId ? host.page : guest.page;
  const otherPage = turnPage === host.page ? guest.page : host.page;
  await passLearnGate(host.page);
  await passLearnGate(guest.page);
  await sleep(900); // dice and tray settle
  await snap(turnPage, OUT + 'hud-bottom-' + tag + '.png');
  console.log('shot hud-bottom-' + tag);

  // Auction: park the turn player before a street, roll onto it, decline.
  // The shutter above can eat a whole turn clock on this rig, so the
  // turn is re-read fresh and pinned with a long deadline first. The
  // turn can also sit with the raw socket player: drive him over his
  // socket and shoot a phone as the bidder.
  let shotOk = false;
  for (let attempt = 0; attempt < 3 && !shotOk; attempt++) {
    const cur = await S(host.page);
    if (cur.status !== 'playing') break;
    const rawTurn = cur.turnPlayerId === raw.playerId;
    const tp = rawTurn ? null : (cur.turnPlayerId === hostId ? host.page : guest.page);
    const op = tp === host.page ? guest.page : host.page;
    if (tp) {
      await tp.evaluate(() => window.__kolopolySend('test_deadline_in', { seconds: 180 }));
      await tp.evaluate((pid) => window.__kolopolySend('test_set_position', { playerId: pid, space: 3 }), cur.turnPlayerId);
      await tp.evaluate(() => window.__kolopolySend('test_dice', { rolls: [[3, 4]] }));
      await clickEl(tp, '#abRoll');
    } else {
      raw.send('test_deadline_in', { seconds: 180 });
      raw.send('test_set_position', { playerId: cur.turnPlayerId, space: 3 });
      raw.send('test_dice', { rolls: [[3, 4]] });
      raw.send('roll', {});
    }
    await waitState(host.page, (s) => s.phase === 'buy' && s.buySpace === 10, 'buy offer ' + tag, 45000);
    if (tp) await clickEl(tp, '#abDecline'); else raw.send('decline', {});
    await untilDom(op, () => {
      const o = document.getElementById('auctionOverlay');
      return o && o.classList.contains('show');
    }, 'auction overlay ' + tag);
    await snapFast(op, OUT + 'auction-' + tag + '.png');
    shotOk = await op.evaluate(() => {
      const o = document.getElementById('auctionOverlay');
      return o && o.classList.contains('show');
    });
    console.log('shot auction-' + tag + ' attempt ' + (attempt + 1) + ' overlay still up: ' + shotOk);
    if (!shotOk) {
      // The 4s test clock beat the shutter; wait out the settle and retry.
      await waitState(host.page, (s) => !s.auction, 'auction settled ' + tag, 20000).catch(() => {});
    }
  }

  // ---- agreed pause (390 only): propose, agree, shoot the paused card
  if (w === 390) {
    // A phone left idle while the auction ran may hold the AFK card;
    // tap it away the way its owner would before proposing.
    await guest.page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && /I DEY HERE/i.test(x.textContent));
      if (b) b.click();
    });
    await clickEl(host.page, '#hudPause');
    await untilDom(guest.page, () => {
      const scrim = document.getElementById('pauseVoteScrim');
      return scrim && scrim.classList.contains('show') && !!scrim.querySelector('[data-pv="agree"]');
    }, 'pause vote prompt ' + tag);
    await snapFast(guest.page, OUT + 'pause-vote-' + tag + '.png');
    console.log('shot pause-vote-' + tag);
    // The shutter can still eat the 15s test vote window; if the pause
    // has not landed shortly after agreeing, propose and agree again.
    for (let i = 0; i < 3; i++) {
      const st = await S(host.page);
      if (st.agreedPause) break;
      if (!st.pauseVote) {
        await clickEl(host.page, '#hudPause');
        await untilDom(guest.page, () => {
          const scrim = document.getElementById('pauseVoteScrim');
          return scrim && scrim.classList.contains('show') && !!scrim.querySelector('[data-pv="agree"]');
        }, 'pause vote prompt again ' + tag);
      }
      await clickEl(guest.page, '#pauseVoteSheet [data-pv="agree"]');
      raw.send('pause_vote', { agree: true }); // the third human agrees from his socket
      await sleep(1200);
    }
    await untilDom(host.page, () => {
      const o = document.getElementById('pauseOverlay');
      return o && o.classList.contains('show') && /Game don pause/.test(o.textContent);
    }, 'paused card ' + tag);
    await sleep(600);
    await snap(host.page, OUT + 'paused-' + tag + '.png');
    console.log('shot paused-' + tag);
  }
  raw.ws.close();
  await host.ctx.close();
  await guest.ctx.close();
}

try {
  const SIZES = process.env.KP_SIZES
    ? process.env.KP_SIZES.split(',').map((x) => x.split('x').map(Number))
    : [[390, 844], [360, 780]];
  for (const [w, h] of SIZES) {
    await shootSize(w, h).catch((e) => console.log('size ' + w + ' failed:', e.message));
  }
  console.log('shots done ->', OUT);
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
