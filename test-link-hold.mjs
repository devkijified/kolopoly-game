// Link drops: a free table never freezes (the seat converts to an
// AFK bot at once, the table gets one small toast, no linkWait, no
// pause), a paid table holds with a linkWait countdown and clears
// its waiting line when the seat returns, and a backgrounded client
// that comes back to a dead socket rejoins the same seat.
import WebSocket from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 4231;
const BASE = 'ws://127.0.0.1:' + PORT;
let n = 0, fail = 0;
function check(name, cond, extra) {
  n += 1;
  if (cond) console.log('  ok ' + n + ' - ' + name);
  else { fail += 1; console.log('  FAIL ' + n + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.playerId = null;
    this.token = null;
    this.toasts = [];
    this.sawLinkWait = false;
    this.rejoinFailed = false;
    this.spectator = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'joined') {
          this.playerId = msg.playerId;
          this.code = msg.code;
          this.spectator = !!msg.spectator;
          if (msg.token) this.token = msg.token;
        }
        if (msg.type === 'state') {
          this.state = msg.room;
          if (msg.room && msg.room.linkWait) this.sawLinkWait = true;
        }
        if (msg.type === 'toast') this.toasts.push(msg);
        if (msg.type === 'rejoin_failed') this.rejoinFailed = true;
      });
    });
  }
  send(type, obj) { this.ws.send(JSON.stringify(Object.assign({ type }, obj || {}))); }
  async waitFor(pred, label, ms) {
    const end = Date.now() + (ms || 8000);
    while (Date.now() < end) {
      if (pred()) return;
      await sleep(40);
    }
    throw new Error('timeout: ' + label);
  }
}

function bootServer(port) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: new URL('.', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), KP_TEST: '1', KP_ADMIN_TOKEN: '', KP_PERSIST_ROOMS: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (d) => { if (String(d).includes('Kolopoly listening')) { clearTimeout(timer); resolve(server); } });
  });
}

const server = await bootServer(PORT);

try {
  // ------------------------------------------------------------ (a) free
  console.log('LH-A: a free room drop converts to a bot at once, no pause, one toast');
  const ada = new Client('Ada');
  const tobi = new Client('Tobi');
  await ada.connect();
  await tobi.connect();
  ada.send('create_room', { name: 'Ada', token: 'danfo', mode: 'online', clientId: 'lh-ada-device-11', settings: { gameMode: 'classic' } });
  await ada.waitFor(() => ada.state && ada.state.status === 'lobby', 'free lobby');
  const freeCode = ada.state.code;
  const adaId = ada.playerId;
  const adaToken = ada.token;
  tobi.send('join_room', { code: freeCode, name: 'Tobi', token: 'keke', clientId: 'lh-tobi-device-22' });
  await tobi.waitFor(() => tobi.state && tobi.state.players.length === 2, 'free joined');
  ada.send('start_game', {});
  await ada.waitFor(() => ada.state && ada.state.status === 'playing', 'free playing');
  tobi.sawLinkWait = false; // only states from the drop onward count
  ada.ws.close();
  await tobi.waitFor(() => {
    const p = tobi.state && tobi.state.players.find((x) => x.id === adaId);
    return p && p.bot && p.afkTaken;
  }, 'dropped seat is an AFK bot', 6000);
  check('the dropped free seat is an AFK bot within seconds', true);
  check('the free room is not paused', tobi.state.paused === false, 'paused=' + tobi.state.paused);
  check('the free room carries no linkWait', !tobi.state.linkWait);
  check('no state ever showed a linkWait for the free drop', tobi.sawLinkWait === false);
  await tobi.waitFor(() => tobi.toasts.some((t) => t.text === 'Ada network blink. Bot dey hold their seat.'), 'drop toast', 4000);
  check('the other player got the small drop toast', true);

  const adaBack = new Client('Ada back');
  await adaBack.connect();
  adaBack.send('rejoin', { code: freeCode, playerId: adaId, token: adaToken });
  await adaBack.waitFor(() => adaBack.playerId === adaId, 'free reclaim joined');
  await tobi.waitFor(() => {
    const p = tobi.state.players.find((x) => x.id === adaId);
    return p && !p.bot && !p.afkTaken;
  }, 'free seat human again');
  check('the returning player reclaims the seat from the bot', true);
  adaBack.ws.close();
  tobi.ws.close();

  // ------------------------------------------------------------ (b) paid
  console.log('LH-B: a paid room holds with a countdown and clears its waiting line on return');
  const host = new Client('Host');
  const bola = new Client('Bola');
  await host.connect();
  await bola.connect();
  host.send('create_room', { name: 'Host', token: 'danfo', mode: 'online', clientId: 'lh-host-device-33', settings: { gameMode: 'classic' } });
  await host.waitFor(() => host.state && host.state.status === 'lobby', 'paid lobby');
  const paidCode = host.state.code;
  bola.send('join_room', { code: paidCode, name: 'Bola', token: 'keke', clientId: 'lh-bola-device-44' });
  await bola.waitFor(() => bola.state && bola.state.players.length === 2, 'paid joined');
  const bolaId = bola.playerId;
  const bolaToken = bola.token;
  host.send('start_game', {});
  await host.waitFor(() => host.state && host.state.status === 'playing', 'paid playing');
  host.send('test_set_paid', { playerId: bolaId, fee: 200 });
  await host.waitFor(() => host.state && host.state.paid && host.state.paid.fee === 200, 'paid flag set');
  const dropAt = Date.now();
  bola.ws.close();
  await host.waitFor(() => host.state && host.state.linkWait && host.state.linkWait.playerId === bolaId, 'paid linkWait', 6000);
  check('the paid room sets linkWait for the dropped seat', true);
  check('the paid room pauses for the hold', host.state.paused === true);
  const until = host.state.linkWait.until;
  check('linkWait.until is about now + 150s', Math.abs(until - (dropAt + 150000)) < 10000, 'until-dropAt=' + (until - dropAt));
  check('the room message is the waiting line', host.state.message === 'Waiting for Bola to reconnect.', JSON.stringify(host.state.message));

  const bolaBack = new Client('Bola back');
  await bolaBack.connect();
  bolaBack.send('rejoin', { code: paidCode, playerId: bolaId, token: bolaToken });
  await bolaBack.waitFor(() => bolaBack.playerId === bolaId, 'paid rejoin joined');
  await host.waitFor(() => host.state && !host.state.linkWait, 'paid linkWait cleared', 6000);
  check('reconnect clears linkWait', true);
  await host.waitFor(() => host.state && host.state.message === 'Bola don come back.', 'return line', 6000);
  check('the stale waiting line is replaced by the return line', true, JSON.stringify(host.state && host.state.message));
  check('the paid room unpauses after the return', host.state.paused === false);
  bolaBack.ws.close();
  host.ws.close();
} catch (e) {
  fail += 1;
  console.log('  FAIL runner :: ' + (e && e.stack || e));
} finally {
  server.kill();
}

// ------------------------------------------------------------ (c) browser
// A backgrounded page whose socket died must rejoin the same seat
// when the foreground returns. Uses the Playwright chromium in the
// local cache; skipped (not failed) where that tooling is absent.
console.log('LH-C: a hidden page with a dead socket rejoins the same seat on return');
let chromium = null;
try { chromium = (await import('playwright-core')).chromium; } catch (e) { chromium = null; }
const chromePath = (() => {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!/^chromium-\d+$/.test(dir)) continue;
      const p = path.join(base, dir, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { }
  return null;
})();
if (!chromium || !chromePath) {
  console.log('  skip - playwright-core or the cached chromium is not available in this environment');
} else {
  const BPORT = 4232;
  const bserver = await bootServer(BPORT);
  let browser = null;
  try {
    browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
    const mkCtx = () => browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    });
    const B = 'http://127.0.0.1:' + BPORT;
    const S = (page) => page.evaluate(() => window.__kolopolyState());
    const waitState = async (page, pred, label, ms) => {
      const end = Date.now() + (ms || 15000);
      while (Date.now() < end) { const s = await S(page); if (s && pred(s)) return s; await sleep(200); }
      throw new Error('waitState timeout: ' + label);
    };
    const typeName = async (page, name) => {
      await page.evaluate(() => {
        const el = document.getElementById('nameIn');
        if (el && el.offsetParent === null) {
          const cand = [document.getElementById('inviteChangeBtn'), document.getElementById('welcomeChange')];
          const t = cand.find((b) => b && b.offsetParent !== null);
          if (t) t.click();
        }
      });
      await page.fill('#nameIn', name);
    };
    const clickEl = (page, sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) throw new Error('missing ' + s);
      el.click();
    }, sel);
    // A fresh profile meets the learn offer on its first entry tap:
    // the gate holds the entry until "I know how to play" is tapped.
    const passLearnGate = async (page) => {
      for (let i = 0; i < 10; i++) {
        const hit = await page.evaluate(() => {
          const b = document.getElementById('trainOfferNo');
          if (b && b.offsetParent !== null) { b.click(); return true; }
          return false;
        });
        if (hit) return;
        await sleep(300);
      }
    };
    const hCtx = await mkCtx();
    const gCtx = await mkCtx();
    const hp = await hCtx.newPage();
    const gp = await gCtx.newPage();
    await hp.goto(B, { waitUntil: 'networkidle' });
    await typeName(hp, 'Hassan');
    await clickEl(hp, '#gameModeRow [data-gmode="classic"]');
    await clickEl(hp, '#createBtn');
    await passLearnGate(hp);
    await waitState(hp, (s) => s.status === 'lobby', 'browser host lobby');
    const bcode = (await S(hp)).code;
    await gp.goto(B + '/?join=' + bcode, { waitUntil: 'networkidle' });
    await typeName(gp, 'Goke');
    await clickEl(gp, '#joinBtn');
    await passLearnGate(gp);
    await waitState(gp, (s) => s.status === 'lobby' && s.players.length === 2, 'browser guest joined');
    await waitState(hp, (s) => s.players.length === 2, 'browser host sees two');
    await clickEl(hp, '#startBtn');
    await waitState(hp, (s) => s.status === 'playing', 'browser game playing');
    await waitState(gp, (s) => s.status === 'playing', 'browser game playing on guest');
    const gId = await gp.evaluate(() => window.__kolopolySession().id);
    check('browser guest holds a seat', !!gId);

    // Background the guest page and kill its socket while hidden,
    // the iOS home-screen shape: no close handler gets to run its
    // reconnect in a frozen page, so the return must do the work.
    // Attribution is the proof: a probe wraps the socket constructor
    // and stamps page-side when the next socket is born. The drop
    // timer cannot speak before drop+1800ms (show+1400ms here), so a
    // socket born within a second of the return events was built by
    // the resume path itself. End-to-end join time is not asserted:
    // on a software-GL rig the page's main thread can hold a landed
    // reply for seconds, which is the rig, not the resume.
    await gp.evaluate(() => {
      window.__socketBornAt = -1;
      const Orig = window.WebSocket;
      window.WebSocket = function (...args) {
        window.__socketBornAt = performance.now();
        return new Orig(...args);
      };
    });
    await gp.evaluate(() => new Promise((resolve) => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.__kolopolyDrop();
      setTimeout(() => {
        window.__resumeWasLive = window.__kolopolySession().live;
        window.__showStamp = performance.now();
        window.__resumeMs = -1;
        const t0 = performance.now();
        const iv = setInterval(() => {
          if (window.__kolopolySession().live) {
            window.__resumeMs = Math.round(performance.now() - t0);
            clearInterval(iv);
            resolve();
          }
        }, 25);
        setTimeout(() => { clearInterval(iv); resolve(); }, 15000);
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('pageshow'));
        window.dispatchEvent(new Event('focus'));
      }, 400);
    }));
    const resumeInfo = await gp.evaluate(() => ({
      ms: window.__resumeMs,
      wasLive: window.__resumeWasLive,
      bornDelta: window.__socketBornAt >= 0 && window.__showStamp ? Math.round(window.__socketBornAt - window.__showStamp) : -1
    }));
    check('the returned page is live again', resumeInfo.ms >= 0);
    check('the session was still down when the return began', resumeInfo.wasLive === false);
    check('the return itself built a fresh socket (not the 1800ms drop timer)', resumeInfo.bornDelta >= 0 && resumeInfo.bornDelta < 1000, 'bornDelta=' + resumeInfo.bornDelta);
    check('the rejoined seat is the same player', (await gp.evaluate(() => window.__kolopolySession().id)) === gId);
    await waitState(hp, (s) => {
      const p = s.players.find((x) => x.id === gId);
      return p && p.connected && !p.bot;
    }, 'host sees the guest back', 8000);
    check('the table sees the same human seat back, not a bot', true);
    await hCtx.close();
    await gCtx.close();
  } catch (e) {
    fail += 1;
    console.log('  FAIL browser runner :: ' + (e && e.stack || e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    bserver.kill();
  }
}

console.log(fail ? fail + ' failed' : 'all ' + n + ' passed');
process.exit(fail ? 1 : 0);
