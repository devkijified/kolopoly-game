// Lobby and match-HUD cleanup tests (browser, Chromium):
// - The lobby is a Players list: the host sees who joined, live, as
//   seats fill and empty; guests see "Waiting for host" in place of
//   the Start button; the settings live behind one Settings row.
// - The match HUD has no waiting card under the board in any state
//   and no "?" button; the Deals tray button carries its full label;
//   the dock's bottom padding is max(10px, safe-area + 6px).
// Run: node test-lobby-hud.mjs   (spawns its own KP_TEST server)
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright-core';

const PORT = 4241;
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, extra) {
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (extra ? '  [' + extra + ']' : ''));
  if (!ok) failures++;
}

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
async function openPhone(name, w, h) {
  const ctx = await mkCtx(w || 390, h || 844);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.getElementById('nameIn'), undefined, { timeout: 20000, polling: 150 });
  await typeName(page, name);
  return { ctx, page };
}
async function openGuest(name, code, w, h) {
  const ctx = await mkCtx(w || 390, h || 844);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(BASE + '/?join=' + code, { waitUntil: 'commit', timeout: 90000 });
  await typeName(page, name);
  await page.waitForFunction(() => { const b = document.getElementById('joinBtn'); return b && b.offsetParent !== null; }, undefined, { timeout: 45000, polling: 150 });
  await clickEl(page, '#joinBtn');
  return { ctx, page };
}
async function until(page, fn, label, ms) {
  // Evaluate polling, not waitForFunction: on this rig a backgrounded
  // page's rAF can stall for many seconds while evaluate still lands.
  const end = Date.now() + (ms || 45000);
  while (Date.now() < end) {
    if (await page.evaluate(fn)) return;
    await sleep(400);
  }
  throw new Error('until timeout: ' + label);
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

try {
  // ------------------------------------------------------------ lobby
  const host = await openPhone('HostNgozi');
  await clickEl(host.page, '#gameModeRow [data-gmode="classic"]');
  await clickEl(host.page, '#createBtn');
  await passLearnGate(host.page);
  await waitState(host.page, (s) => s.status === 'lobby', 'host lobby');
  const code = (await S(host.page)).code;

  const lobbyShape = await host.page.evaluate(() => {
    const slots = [...document.querySelectorAll('#slotBoard .slot')];
    return {
      slots: slots.length,
      firstText: slots[0] ? slots[0].textContent.replace(/\s+/g, ' ').trim() : '',
      empties: slots.filter((s) => s.classList.contains('empty')).length,
      emptyInvite: slots.filter((s) => s.querySelector('[data-invite]')).length,
      emptyWaiting: slots.filter((s) => /Waiting…/.test(s.textContent)).length,
      count: (document.getElementById('lobbyPlayerCount') || {}).textContent || '',
      stage: !!document.getElementById('lobbyStage'),
      qr: !!document.getElementById('inviteQr'),
      stickers: document.querySelectorAll('#view-lobby .train-sticker').length,
      settingsBtn: !!document.getElementById('lobbySettingsBtn'),
      codeText: (document.getElementById('lobbyCode') || {}).textContent || ''
    };
  });
  check('lobby renders six seat cards', lobbyShape.slots === 6, JSON.stringify(lobbyShape));
  check('host seat card names the host and carries the Host tag', /HostNgozi/.test(lobbyShape.firstText) && /Host/.test(lobbyShape.firstText), lobbyShape.firstText);
  check('five empty seats wait with an Invite button each', lobbyShape.empties === 5 && lobbyShape.emptyInvite === 5 && lobbyShape.emptyWaiting === 5);
  check('player count reads 1 of 6', lobbyShape.count.trim() === '1 of 6', lobbyShape.count);
  check('room code shows at the top', lobbyShape.codeText.trim() === code, lobbyShape.codeText);
  check('no 3D stage, no QR box, no promo stickers on the lobby page', !lobbyShape.stage && !lobbyShape.qr && lobbyShape.stickers === 0);
  check('one Settings row is present', lobbyShape.settingsBtn);
  check('lobby has no horizontal overflow at 390px', await noOverflow(host.page));

  // Settings sheet opens with the room rows and closes.
  await clickEl(host.page, '#lobbySettingsBtn');
  const sheetText = await host.page.evaluate(() => {
    const scrim = document.getElementById('lobbySettingsScrim');
    const sheet = document.getElementById('lobbySettingsSheet');
    return { shown: scrim.classList.contains('show'), text: sheet.textContent.replace(/\s+/g, ' ') };
  });
  check('Settings sheet opens with the room settings rows', sheetText.shown && /Turn timer/.test(sheetText.text) && /Room settings/.test(sheetText.text), sheetText.text.slice(0, 120));
  await host.page.evaluate(() => { document.querySelector('#lobbySettingsSheet [data-close]').click(); });
  check('Settings sheet closes', await host.page.evaluate(() => !document.getElementById('lobbySettingsScrim').classList.contains('show')));

  // The same lobby squeezed to 360px: nothing may stick out.
  await host.page.setViewportSize({ width: 360, height: 780 });
  await sleep(500);
  const lobby360 = await host.page.evaluate(() => {
    const iw = window.innerWidth;
    let widest = 0;
    document.querySelectorAll('#view-lobby *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width) widest = Math.max(widest, r.right);
    });
    const share = document.getElementById('shareInviteBtn').getBoundingClientRect();
    return { widest: Math.round(widest), iw, shareRight: Math.round(share.right) };
  });
  check('lobby fits 360px with nothing sticking out', lobby360.widest <= lobby360.iw + 1 && lobby360.shareRight <= lobby360.iw, JSON.stringify(lobby360));
  await host.page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);

  // ------------------------------------------------------- join/leave
  const guest = await openGuest('GuestAda', code);
  await waitState(guest.page, (s) => s.status === 'lobby' && s.players.length === 2, 'guest seated');

  const guestView = await guest.page.evaluate(() => {
    const w = document.getElementById('lobbyWaitHost');
    const sb = document.getElementById('startBtn');
    return {
      waitShown: !!w && !w.classList.contains('hidden') && w.offsetParent !== null,
      waitText: w ? w.textContent.trim() : '',
      startShown: !!sb && sb.style.display !== 'none' && sb.offsetParent !== null
    };
  });
  check('guest sees "Waiting for host" where the Start button sits', guestView.waitShown && guestView.waitText === 'Waiting for host', JSON.stringify(guestView));
  check('guest does not see the Start button', !guestView.startShown);

  // The host's list updates live, and the new seat carries the join pop.
  await host.page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('#slotBoard .slot')];
    return cards.some((c) => /GuestAda/.test(c.textContent));
  }, undefined, { timeout: 10000, polling: 100 });
  check('host lobby updates live when a guest joins', true);
  const joinPop = await host.page.evaluate(() => {
    const cards = [...document.querySelectorAll('#slotBoard .slot')];
    const g = cards.find((c) => /GuestAda/.test(c.textContent));
    return { pop: !!g && g.classList.contains('seat-join'), count: (document.getElementById('lobbyPlayerCount') || {}).textContent || '' };
  });
  check('the joined seat carries the join animation class', joinPop.pop);
  check('player count updates to 2 of 6', joinPop.count.trim() === '2 of 6', joinPop.count);

  await clickEl(guest.page, '#leaveLobbyBtn');
  await host.page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('#slotBoard .slot')];
    return !cards.some((c) => /GuestAda/.test(c.textContent)) &&
      cards.filter((c) => c.querySelector('[data-invite]')).length === 5;
  }, undefined, { timeout: 15000, polling: 150 });
  check('host lobby updates live when the guest leaves (seat waits again)', true);
  await guest.ctx.close();

  // ------------------------------------------------------------ match
  const guest2 = await openGuest('GuestBola', code);
  await waitState(guest2.page, (s) => s.status === 'lobby' && s.players.length === 2, 'second guest seated');
  await clickEl(host.page, '#startBtn');
  const st = await waitState(host.page, (s) => s.status === 'playing', 'game playing');
  await waitState(guest2.page, (s) => s.status === 'playing', 'guest game playing');
  const turnPage = st.turnPlayerId === (await S(host.page)).players[0].id ? host.page : guest2.page;
  const otherPage = turnPage === host.page ? guest2.page : host.page;

  for (const [label, pg] of [['turn phone', turnPage], ['waiting phone', otherPage]]) {
    const hud = await pg.evaluate(() => ({
      waitHints: document.querySelectorAll('.wait-hint').length,
      helpBtn: !!document.getElementById('hudHelp'),
      actionText: (document.getElementById('actionBar') || {}).textContent || ''
    }));
    check(label + ': no waiting card element under the board', hud.waitHints === 0);
    check(label + ': no "?" button in the HUD', !hud.helpBtn);
    check(label + ': action bar carries no "Wait for" card text', !/Wait for/.test(hud.actionText), hud.actionText.slice(0, 60));
  }
  const dock = await turnPage.evaluate(() => {
    const wb = document.querySelector('.walletbar');
    const deals = document.getElementById('hudDeals');
    const lb = deals ? deals.querySelector('.hud-deals-lb') : null;
    const dr = deals ? deals.getBoundingClientRect() : null;
    const lr = lb ? lb.getBoundingClientRect() : null;
    return {
      padBottom: getComputedStyle(wb).paddingBottom,
      dealsText: deals ? deals.textContent.replace(/\s+/g, ' ').trim() : '',
      dealsH: dr ? dr.height : 0,
      dealsInView: dr ? dr.left >= 0 && dr.right <= window.innerWidth + 1 : false,
      labelWhole: !!(lb && lr && lr.right <= dr.right + 1 && lb.scrollWidth <= lb.clientWidth + 1)
    };
  });
  check('dock bottom padding is max(10px, safe-area + 6px) = 10px on this rig', dock.padBottom === '10px', dock.padBottom);
  check('Deals button shows its full label', dock.dealsText === 'Deals', dock.dealsText);
  check('Deals button is at least 44px tall and fully on screen', dock.dealsH >= 44 && dock.dealsInView, JSON.stringify(dock));
  check('Deals label is not wrapped or truncated', dock.labelWhole);
  check('match screen has no horizontal overflow at 390px', await noOverflow(turnPage));

  // Same checks squeezed to 360x780.
  await turnPage.setViewportSize({ width: 360, height: 780 });
  await sleep(600);
  const dock360 = await turnPage.evaluate(() => {
    const deals = document.getElementById('hudDeals');
    const lb = deals ? deals.querySelector('.hud-deals-lb') : null;
    const dr = deals ? deals.getBoundingClientRect() : null;
    const lr = lb ? lb.getBoundingClientRect() : null;
    return {
      dealsH: dr ? dr.height : 0,
      dealsInView: dr ? dr.left >= 0 && dr.right <= window.innerWidth + 1 : false,
      labelWhole: !!(lb && lr && lr.right <= dr.right + 1 && lb.scrollWidth <= lb.clientWidth + 1),
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
    };
  });
  check('at 360px the Deals label stays whole and on screen', dock360.dealsH >= 44 && dock360.dealsInView && dock360.labelWhole, JSON.stringify(dock360));
  check('match screen has no horizontal overflow at 360px', dock360.overflow);

  // ------------------------------------------------- agreed pause (UI)
  await turnPage.setViewportSize({ width: 390, height: 844 });
  await clickEl(host.page, '#hudPause');
  await until(guest2.page, () => {
    const scrim = document.getElementById('pauseVoteScrim');
    return scrim && scrim.classList.contains('show') && /Pause the game\?/.test(scrim.textContent);
  }, 'guest vote prompt');
  check('the guest gets the in-page pause vote prompt', true);
  const voteBtns = await guest2.page.evaluate(() => {
    const a = document.querySelector('#pauseVoteSheet [data-pv="agree"]');
    const d = document.querySelector('#pauseVoteSheet [data-pv="decline"]');
    return { a: a ? a.getBoundingClientRect().height : 0, d: d ? d.getBoundingClientRect().height : 0 };
  });
  check('vote buttons are at least 44px tall', voteBtns.a >= 44 && voteBtns.d >= 44, JSON.stringify(voteBtns));
  await clickEl(guest2.page, '#pauseVoteSheet [data-pv="agree"]');
  await until(host.page, () => {
    const o = document.getElementById('pauseOverlay');
    return o && o.classList.contains('show') && /Game don pause/.test(o.textContent);
  }, 'host paused card');
  const pausedCard = await host.page.evaluate(() => document.getElementById('pauseOverlay').textContent.replace(/\s+/g, ' ').trim());
  check('the paused card shows and names the proposer', /HostNgozi/.test(pausedCard), pausedCard.slice(0, 110));
  check('the guest sees the paused state too', await guest2.page.evaluate(() => {
    const o = document.getElementById('pauseOverlay');
    return o && o.classList.contains('show') && /Game don pause/.test(o.textContent);
  }));
  await clickEl(host.page, '#pauseResumeBtn');
  await until(guest2.page, () => {
    const scrim = document.getElementById('pauseVoteScrim');
    return scrim && scrim.classList.contains('show') && /Play back\?/.test(scrim.textContent);
  }, 'guest resume prompt');
  await clickEl(guest2.page, '#pauseVoteSheet [data-pv="agree"]');
  await until(host.page, () => {
    const o = document.getElementById('pauseOverlay');
    return o && !o.classList.contains('show');
  }, 'paused card lifts');
  check('an agreed resume lifts the paused card and play continues', true);
  await host.ctx.close();
  await guest2.ctx.close();
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
console.log(failures ? ('\n' + failures + ' FAILURES') : '\nall lobby/hud checks passed');
process.exit(failures ? 1 : 0);
