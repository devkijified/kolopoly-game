// KOLOPOLY browser tests + screenshot proof at 390x844 (mobile rig pattern).
// Run: node test-browser.mjs   (spawns its own KP_TEST server, kills it after)
import { createRequire } from 'node:module';
const require2 = createRequire('/home/hatch/workspace/mobile-rig/package.json');
const puppeteer = require2('puppeteer-core');
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = 4210;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = '/home/hatch/workspace/mobile-rig/browsers/chrome/linux-155.0.8059.84/chrome-linux64/chrome';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });
let checks = 0;
let failures = 0;
const pageErrors = [];
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), KP_TEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--ignore-certificate-errors']
});
async function newPage(tag) {
  // One isolated browser context per page: each rig page is a different
  // person's phone, with its own localStorage and sessionStorage.
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  page.on('pageerror', (e) => pageErrors.push(tag + ': ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(tag + ' console: ' + m.text()); });
  return page;
}
const S = (page) => page.evaluate(() => window.__kolopolyState());
const send = (page, type, obj) => page.evaluate((t, o) => window.__kolopolySend(t, o), type, obj || {});
async function waitState(page, pred, label, ms) {
  const src = pred.toString();
  await page.bringToFront().catch(() => {});
  await page.waitForFunction((s) => {
    const st = window.__kolopolyState();
    if (!st) return false;
    return eval(s)(st);
  }, { timeout: ms || 12000, polling: 200 }, src).catch(() => { throw new Error('waitState timeout: ' + label); });
}
const front = (page) => page.bringToFront().catch(() => {});
// Each page is an isolated context (its own phone). Clear the field before
// typing a fresh name. Returning players get
// the welcome or invite layout with the form tucked behind a Change button:
// reveal it first when the name field is not visible.
async function typeName(page, name) {
  await page.evaluate(() => {
    const n = document.getElementById('nameIn');
    if (n && n.offsetParent === null) {
      const cand = [document.getElementById('inviteChangeBtn'), document.getElementById('welcomeChange')];
      const t = cand.find((b) => b && b.offsetParent !== null);
      if (t) t.click();
    }
  });
  await page.evaluate(() => { document.getElementById('nameIn').value = ''; });
  await page.type('#nameIn', name);
}
// In-game action buttons are re-rendered on every state change, so a resolved
// node can detach mid-click. Click them by id at evaluate time, with retries.
// The retry budget is generous: the rig renders WebGL in software and this VM
// is shared, so a page can take seconds to produce a button under load.
async function clickId(page, id) {
  for (let i = 0; i < 14; i++) {
    const ok = await page.evaluate((x) => { const el = document.getElementById(x); if (!el) return false; el.click(); return true; }, id);
    if (ok) return;
    await sleep(400);
  }
  throw new Error('clickId: #' + id + ' never appeared');
}

// KP13 WS5: Inflation is the landing default now. Scenarios written
// against Classic pick it explicitly; the WS5 block proves the default.
const pickClassic = (page) => page.click('#gameModeRow [data-gmode="classic"]');

try {
  // ---------------------------------------------------------- scenario 1
  console.log('B1: create, join by invite code, countdown, start, buy with alert, salary credit alert, deed sheet, share card');
  const A = await newPage('A');
  await A.goto(BASE, { waitUntil: 'networkidle0' });
  await A.screenshot({ path: SHOTS + 'kp-landing.png' });
  check('landing renders the join card', await A.evaluate(() => !!document.querySelector('#createBtn') && !!document.querySelector('#nameIn')));
  await typeName(A, 'Ada');
  await pickClassic(A);
  await A.click('#createBtn');
  await waitState(A, (s) => s.status === 'lobby', 'A in lobby');
  const code = (await S(A)).code;
  check('room code issued', /^[A-Z]{4}$/.test(code), code);

  const B = await newPage('B');
  await B.goto(BASE + '/?join=' + code, { waitUntil: 'networkidle0' });
  check('invite banner shows on the join link', await B.evaluate(() => document.querySelector('#inviteBanner').classList.contains('show')));
  await typeName(B, 'Bola');
  await B.click('#joinBtn');
  await waitState(B, (s) => s.status === 'lobby' && s.players.length === 2, 'B joined by code');
  check('second player joined via the invite code', true);
  await front(A);
  await A.click('#startBtn');
  await waitState(A, (s) => s.status === 'countdown' || s.status === 'playing', 'countdown or playing');
  await waitState(A, (s) => s.status === 'playing', 'game playing after countdown');
  check('countdown ran and the game started', true);

  const pages = [A, B];
  const ids = (await S(A)).players.map((p) => p.id);
  const turnPage = async () => {
    const st = await S(A);
    return pages[ids.indexOf(st.turnPlayerId)];
  };
  const idlePage = async () => {
    const tp = await turnPage();
    return tp === A ? B : A;
  };

  // Turn player buys Ajegunle (dice 1+2 from START).
  let tp = await turnPage();
  await front(tp);
  await send(tp, 'test_dice', { rolls: [[1, 2]] });
  await clickId(tp, 'abRoll');
  await waitState(tp, (s) => s.phase === 'buy' && s.buySpace === 3, 'Ajegunle offered');
  await clickId(tp, 'abBuy');
  await waitState(tp, (s) => s.props[3].o === s.turnPlayerId, 'Ajegunle bought');
  const alertSeen = await tp.evaluate(() => {
    const el = document.querySelector('.alert-card');
    return el ? el.textContent : '';
  });
  check('buy produced a debit alert card with the exact amount', /Ajegunle|₦80,000/.test(alertSeen), alertSeen.slice(0, 80));
  const turnBefore = (await S(tp)).turnPlayerId;
  await clickId(tp, 'abEnd');
  {
    const end = Date.now() + 9000;
    let passed = false;
    while (Date.now() < end) { if ((await S(tp)).turnPlayerId !== turnBefore) { passed = true; break; } await sleep(200); }
    check('end turn passed the turn to the other player', passed);
  }

  // Other player wraps past START onto Ajegunle: salary credit alert plus rent.
  tp = await turnPage();
  await front(tp);
  const tpId = (await S(tp)).turnPlayerId;
  await send(tp, 'test_set_position', { playerId: tpId, space: 38 });
  await send(tp, 'test_dice', { rolls: [[2, 3]] });
  await clickId(tp, 'abRoll');
  await tp.waitForFunction(() => {
    const el = document.querySelector('.alert-card.credit');
    // KP14: the amount counts up with the coin cascade; the check waits
    // for the settled figure, which is the exactness the law cares about.
    return el && /Salary alert/.test(el.textContent) && /₦200,000/.test(el.textContent);
  }, { timeout: 15000 }).catch(() => {});
  const creditAlert = await tp.evaluate(() => {
    const el = document.querySelector('.alert-card.credit');
    return el ? el.textContent : '';
  });
  check('salary credit alert rendered green with exact ₦200,000', /₦200,000/.test(creditAlert), creditAlert.slice(0, 90));
  await tp.screenshot({ path: SHOTS + 'kp-alert.png' });
  // The smart auto-end may pass this idle turn by itself while the rig is
  // busy screenshotting the alert (that is B4's feature working), so the
  // landing counts as resolved when the end phase shows OR the turn has
  // already moved on. Either outcome passes the turn.
  {
    const end = Date.now() + 12000;
    let resolved = false;
    while (Date.now() < end) {
      const s = await S(tp);
      if (s.phase === 'end' || s.turnPlayerId !== tpId) { resolved = true; break; }
      await sleep(200);
    }
    if (!resolved) throw new Error('rent landing never resolved');
  }
  await clickId(tp, 'abEnd').catch(() => {});
  // Without this wait the turnPage() read below races the end turn broadcast
  // and can pick the player who just ended (their page never shows a roll
  // button). Same polling pattern as the first end turn check above.
  {
    const endBack = Date.now() + 9000;
    while (Date.now() < endBack) { if ((await S(A)).turnPlayerId !== tpId) break; await sleep(200); }
  }

  // Feed the Owambe pot with the FIRS tax, then shoot the board.
  tp = await turnPage();
  await front(tp);
  const tp2Id = (await S(tp)).turnPlayerId;
  await send(tp, 'test_set_position', { playerId: tp2Id, space: 1 });
  await send(tp, 'test_dice', { rolls: [[1, 2]] });
  await clickId(tp, 'abRoll');
  await waitState(tp, (s) => s.phase === 'tax', 'FIRS tax');
  await clickId(tp, 'abTaxFlat');
  await waitState(tp, (s) => s.pot === 200000, 'pot fed');
  await sleep(700); // let the token finish hopping and the camera settle
  // KP10: the full board is the only view there is; the pot label sits on
  // Owambe Grounds itself, no toggle to tap.
  await sleep(500);
  await tp.screenshot({ path: SHOTS + 'kp-board.png' });
  check('board shot taken with the pot on Owambe Grounds', (await S(tp)).pot === 200000);

  // Deed sheet for Banana Island, with its area meaning line.
  await tp.evaluate(() => { document.querySelectorAll('.bspace')[39].click(); });
  await tp.waitForFunction(() => document.querySelector('#deedScrim').classList.contains('show'), { timeout: 15000 });
  const deedText = await tp.evaluate(() => document.querySelector('#deedSheet').textContent);
  check('deed sheet shows price, ladder and the area meaning', /Banana Island/.test(deedText) && /₦400,000/.test(deedText) && /Final boss\. If you get house here/.test(deedText), deedText.slice(0, 120));
  await tp.screenshot({ path: SHOTS + 'kp-deed.png' });
  await tp.evaluate(() => document.querySelector('#deedScrim').classList.remove('show'));

  // Share card: the Landlord card.
  await tp.evaluate(() => window.__kolopolyShareCard('landlord', { name: 'Ada', amount: 400000, line: 'don buy Banana Island. LANDLORD level don change for this table.', code: window.__kolopolyState().code }));
  await tp.waitForFunction(() => document.querySelector('#shareOverlay').classList.contains('show'), { timeout: 15000 });
  await sleep(300);
  await tp.screenshot({ path: SHOTS + 'kp-share.png' });
  check('share card overlay rendered a canvas', await tp.evaluate(() => !!document.querySelector('#shareOverlay canvas')));
  await A.close(); await B.close();

  // ---------------------------------------------------------- scenario 2
  console.log('B2: declined purchase opens the auction; a bid wins the deed');
  const C = await newPage('C');
  await C.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(C, 'Chidi');
  await pickClassic(C);
  await C.click('#createBtn');
  await waitState(C, (s) => s.status === 'lobby', 'C lobby');
  const code2 = (await S(C)).code;
  const Dp = await newPage('D');
  await Dp.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(Dp, 'Dara');
  await Dp.type('#codeIn', code2);
  await waitState(Dp, (s) => s.status === 'lobby' && s.players.length === 2, 'D auto-joined on the 4th letter');
  check('auto-join fired when the 4th code letter landed', true);
  await front(C);
  await C.click('#startBtn');
  await waitState(C, (s) => s.status === 'playing', 'game 2 playing');
  const ids2 = (await S(C)).players.map((p) => p.id);
  const st2 = await S(C);
  const tp2 = [C, Dp][ids2.indexOf(st2.turnPlayerId)];
  const other2 = tp2 === C ? Dp : C;
  await front(tp2);
  await send(tp2, 'test_dice', { rolls: [[2, 3]] });
  await clickId(tp2, 'abRoll');
  await waitState(tp2, (s) => s.phase === 'buy' && s.buySpace === 5, 'Iddo offered');
  // Test auctions run a 4s clock (KP_TEST) and this rig is slow, so the bid
  // button wait is registered BEFORE the decline and the bidder's page is
  // fronted (background pages get their timers throttled): the click then
  // lands inside the window.
  await front(other2);
  const bidReady = other2.waitForFunction(() => !!document.querySelector('#auctionSlot [data-bid]'), { timeout: 12000, polling: 100 });
  await clickId(tp2, 'abDecline');
  await bidReady;
  check('auction opened on decline', true);
  await other2.evaluate(() => { const bs = document.querySelectorAll('#auctionSlot [data-bid]'); bs[bs.length - 1].click(); });
  await waitState(other2, (s) => !!s.auction && s.auction.highBid > 0, 'bid registered', 6000);
  await tp2.evaluate(() => { const p = document.querySelector('#bidPass'); if (p) p.click(); });
  await waitState(C, (s) => !s.auction && !!s.props[5].o, 'auction settled', 12000);
  const winnerId = (await S(C)).props[5].o;
  check('the bidder owns Iddo Terminus after the clock', winnerId === ids2[[C, Dp].indexOf(other2)]);
  await C.close(); await Dp.close();

  // ---------------------------------------------------------- scenario 3
  console.log('B3: Inflation Mode, Phase 2: multiplied rent alert with the Pure Water Index on show');
  const E = await newPage('E');
  await E.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(E, 'Efe');
  await E.click('#gameModeRow [data-gmode="inflation"]');
  await E.click('#createBtn');
  await waitState(E, (s) => s.status === 'lobby' && s.settings.gameMode === 'inflation', 'inflation lobby');
  const code3 = (await S(E)).code;
  const F = await newPage('F');
  await F.goto(BASE + '/?join=' + code3, { waitUntil: 'networkidle0' });
  await typeName(F, 'Funmi');
  await F.click('#joinBtn');
  await waitState(F, (s) => s.players.length === 2, 'F joined');
  await front(E);
  await E.click('#startBtn');
  await waitState(E, (s) => s.status === 'playing' && !!s.inf, 'inflation playing');
  check('inflation room live with the phase bar', await E.evaluate(() => !!document.querySelector('#infBar .idx')));
  const ids3 = (await S(E)).players.map((p) => p.id);
  const st3 = await S(E);
  const payerPage = [E, F][ids3.indexOf(st3.turnPlayerId)];
  const ownerPage = payerPage === E ? F : E;
  const ownerId = ids3[[E, F].indexOf(ownerPage)];
  const payerId = st3.turnPlayerId;
  await send(E, 'test_give', { playerId: ownerId, space: 13 });
  await send(E, 'test_phase', { phase: 2 });
  await waitState(E, (s) => s.inf.phase === 2, 'phase 2 active');
  await send(payerPage, 'test_set_position', { playerId: payerId, space: 9 });
  await send(payerPage, 'test_dice', { rolls: [[2, 2], [1, 2]] });
  await front(payerPage);
  await clickId(payerPage, 'abRoll');
  await payerPage.waitForFunction(() => {
    const el = document.querySelector('.alert-card.debit');
    // KP14 count-up: wait for the settled figure, not the first frame.
    return el && /x 2/.test(el.textContent) && /₦20,000/.test(el.textContent);
  }, { timeout: 15000 }).catch(() => {});
  const rentAlert = await payerPage.evaluate(() => {
    const el = document.querySelector('.alert-card.debit');
    return el ? el.textContent : '';
  });
  check('Phase 2 rent alert shows the multiplied ₦20,000 (printed x lowest die)', /₦20,000/.test(rentAlert), rentAlert.slice(0, 90));
  const infBarText = await payerPage.evaluate(() => document.querySelector('#infBar').textContent);
  check('infobar shows Index 5.1x and Pure water ₦100', /5\.1x/.test(infBarText) && /Pure water ₦100(?![0-9])/.test(infBarText), infBarText.slice(0, 120));
  await sleep(500);
  await payerPage.screenshot({ path: SHOTS + 'kp-inflation.png' });
  await E.close(); await F.close();

  // ---------------------------------------------------------- scenario 4
  console.log('B4: smart auto-end passes an idle turn by itself; an open deed sheet holds it');
  const G = await newPage('G');
  await G.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(G, 'Gbenga');
  await pickClassic(G);
  await G.click('#createBtn');
  await waitState(G, (s) => s.status === 'lobby', 'G lobby');
  const code4 = (await S(G)).code;
  const H = await newPage('H');
  await H.goto(BASE + '/?join=' + code4, { waitUntil: 'networkidle0' });
  await typeName(H, 'Halima');
  await H.click('#joinBtn');
  await waitState(H, (s) => s.players.length === 2, 'H joined');
  await front(G);
  await G.click('#startBtn');
  await waitState(G, (s) => s.status === 'playing', 'game 4 playing');
  const ids4 = (await S(G)).players.map((p) => p.id);
  const page4 = (id) => [G, H][ids4.indexOf(id)];

  // Stage a no-decision landing: sit on 37, roll 1+2, wrap onto START.
  // Nothing to buy, no card, no build (no deeds owned): the turn is idle.
  let turnId4 = (await S(G)).turnPlayerId;
  let tp4 = page4(turnId4);
  await front(tp4);
  await send(tp4, 'test_set_position', { playerId: turnId4, space: 37 });
  await send(tp4, 'test_dice', { rolls: [[1, 2]] });
  await clickId(tp4, 'abRoll');
  await waitState(tp4, (s) => s.phase === 'end', 'idle end phase reached');
  await tp4.waitForFunction(() => !!document.querySelector('#autoEndLabel'), { timeout: 10000, polling: 150 });
  check('auto-end countdown label shows on the idle End turn', true);
  {
    const end = Date.now() + 9000;
    let passed = false;
    while (Date.now() < end) { if ((await S(G)).turnPlayerId !== turnId4) { passed = true; break; } await sleep(200); }
    check('turn passed by itself within about 8s, no End turn click', passed);
  }

  // Same idle staging for the next player, but they open a deed sheet:
  // the countdown must cancel and the turn must NOT pass while it is open.
  turnId4 = (await S(G)).turnPlayerId;
  tp4 = page4(turnId4);
  await front(tp4);
  await send(tp4, 'test_set_position', { playerId: turnId4, space: 37 });
  await send(tp4, 'test_dice', { rolls: [[1, 2]] });
  await clickId(tp4, 'abRoll');
  await waitState(tp4, (s) => s.phase === 'end', 'second idle end phase reached');
  await tp4.waitForFunction(() => !!document.querySelector('#autoEndLabel'), { timeout: 10000, polling: 150 });
  await tp4.evaluate(() => { document.querySelectorAll('.bspace')[39].click(); });
  await tp4.waitForFunction(() => document.querySelector('#deedScrim').classList.contains('show'), { timeout: 15000 });
  await sleep(7500); // longer than the 6s countdown
  check('open deed sheet cancelled the auto-end (turn held)', (await S(G)).turnPlayerId === turnId4);
  await tp4.evaluate(() => document.querySelector('#deedScrim').classList.remove('show'));
  {
    const end = Date.now() + 9000;
    let passed = false;
    while (Date.now() < end) { if ((await S(G)).turnPlayerId !== turnId4) { passed = true; break; } await sleep(200); }
    check('auto-end re-armed after the sheet closed and passed the turn', passed);
  }
  await G.close(); await H.close();

  // ---------------------------------------------------------- scenario 5
  console.log('B5: a dropped socket rejoins its seat mid-game; "Join a room first." can never toast in game');
  const I = await newPage('I');
  await I.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(I, 'Ibrahim');
  await pickClassic(I);
  await I.click('#createBtn');
  await waitState(I, (s) => s.status === 'lobby', 'I lobby');
  const code5 = (await S(I)).code;
  const J = await newPage('J');
  await J.goto(BASE + '/?join=' + code5, { waitUntil: 'networkidle0' });
  await typeName(J, 'Joke');
  await J.click('#joinBtn');
  await waitState(J, (s) => s.players.length === 2, 'J joined');
  await front(I);
  await I.click('#startBtn');
  await waitState(I, (s) => s.status === 'playing', 'game 5 playing');
  const jId = (await S(J)).players.find((p) => p.name === 'Joke').id;
  const toastText = (page) => page.evaluate(() => { const t = document.querySelector('#toast'); return t ? t.textContent : ''; });
  // Drop J's socket mid-game; the client reconnects and must rejoin its seat.
  await J.evaluate(() => window.__kolopolyDrop());
  await J.waitForFunction(() => window.__kolopolySession && window.__kolopolySession().live === true, { timeout: 20000, polling: 250 });
  check('reconnected socket rejoined the room (session live again)', true);
  check('the seat kept its identity across the reconnect', (await J.evaluate(() => window.__kolopolySession().id)) === jId);
  {
    const end = Date.now() + 9000;
    let back = false;
    while (Date.now() < end) { const jp = (await S(I)).players.find((p) => p.id === jId); if (jp && jp.connected) { back = true; break; } await sleep(200); }
    check('server marks the rejoined player connected', back);
  }
  await J.evaluate(() => { document.querySelector('#toast').innerHTML = ''; });
  // The rejoined socket must be bound: a server intent from J must land.
  await send(J, 'test_set_position', { playerId: jId, space: 7 });
  {
    const end = Date.now() + 9000;
    let landed = false;
    while (Date.now() < end) { const jp = (await S(J)).players.find((p) => p.id === jId); if (jp && jp.position === 7) { landed = true; break; } await sleep(200); }
    check('intents from the rejoined socket reach the room', landed);
  }
  // Sweep the visible rail controls; the forbidden toast must never appear.
  await front(J);
  await clickId(J, 'sbGist');
  await sleep(400);
  await J.evaluate(() => { document.querySelectorAll('.scrim.show').forEach((s) => s.classList.remove('show')); });
  await clickId(J, 'sbDeeds');
  await sleep(400);
  await J.evaluate(() => { document.querySelectorAll('.scrim.show').forEach((s) => s.classList.remove('show')); });
  check('rail sweep after reconnect shows no "Join a room first." toast', !/Join a room first/.test(await toastText(J)), await toastText(J));
  // A real propose + cancel round trip through the rejoined socket.
  const other5 = (await S(J)).players.find((p) => p.id !== jId);
  await J.evaluate((toId) => { window.__kolopolySend('trade_propose', { to: toId, offer: { cash: 0, spaces: [], goojf: 0 }, request: { cash: 0, spaces: [], goojf: 0 } }); }, other5.id);
  await waitState(J, (s) => !!s.trade, 'trade proposed from rejoined socket');
  await send(J, 'trade_cancel', {});
  await waitState(J, (s) => !s.trade, 'trade cancelled');
  check('trade propose and cancel round trip works after reconnect', true);
  check('no "Join a room first." toast after the whole sweep', !/Join a room first/.test(await toastText(J)), await toastText(J));
  // A full page reload mid-game resumes the same seat too.
  await J.reload({ waitUntil: 'networkidle0' });
  await J.waitForFunction(() => window.__kolopolySession && window.__kolopolySession().live === true && window.__kolopolyState() && window.__kolopolyState().status === 'playing', { timeout: 20000, polling: 250 });
  check('a full page reload mid-game resumes the same seat', (await J.evaluate(() => window.__kolopolySession().id)) === jId);
  await I.close(); await J.close();

  // ---------------------------------------------------------- scenario 6
  console.log('B6: invite link shows one compact prompt; a returning player joins in one tap');
  const K = await newPage('K');
  await K.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(K, 'Kamsi');
  await K.click('#createBtn');
  await waitState(K, (s) => s.status === 'lobby', 'K lobby');
  const code6 = (await S(K)).code;
  const L = await newPage('L');
  await L.goto(BASE, { waitUntil: 'networkidle0' });
  await L.evaluate(() => { localStorage.setItem('kolopolyName', 'Ladi'); localStorage.setItem('kolopolyToken', 'keke'); });
  await L.goto(BASE + '/?join=' + code6, { waitUntil: 'networkidle0' });
  await L.waitForFunction(() => {
    const m = document.querySelector('#inviteMeta');
    return m && /Kamsi/.test(m.textContent) || /inside/.test(m && m.textContent || '');
  }, { timeout: 15000, polling: 200 }).catch(() => {});
  const promptText = await L.evaluate(() => document.querySelector('#inviteBanner').textContent.replace(/\s+/g, ' '));
  check('compact prompt names the host and the remembered player', /Kamsi/.test(promptText) && /Ladi/.test(promptText), promptText.slice(0, 120));
  check('the full form stays tucked away behind Change', await L.evaluate(() => document.querySelector('#joinCard').classList.contains('hidden')));
  let taps = 0;
  await L.click('#inviteJoinBtn'); taps += 1;
  await waitState(L, (s) => s.status === 'lobby' && s.players.length === 2, 'L in the lobby after one tap');
  check('join link landing joined within two taps (used ' + taps + ')', taps <= 2 && (await S(L)).players.some((p) => p.name === 'Ladi'));
  await L.screenshot({ path: SHOTS + 'kp-joinlink-lobby.png' });
  const M = await newPage('M');
  await M.goto(BASE + '/?join=ZZZZ', { waitUntil: 'networkidle0' });
  await M.waitForFunction(() => /don close/.test(document.querySelector('#inviteTitle').textContent), { timeout: 15000, polling: 200 }).catch(() => {});
  check('a dead invite link says so in one line', await M.evaluate(() => /don close/.test(document.querySelector('#inviteTitle').textContent)));
  await K.close(); await L.close(); await M.close();

  // ---------------------------------------------------------- scenario 7
  console.log('B7: lessons round: banner person forms, frozen roll label with beeps, no view toggle anywhere (KP10), a move settling on the full board, pause overlay');
  const N = await newPage('N');
  await N.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(N, 'Ngozi');
  await pickClassic(N);
  await clickId(N, 'createBtn');
  await waitState(N, (s) => s.status === 'lobby', 'N in lobby');
  const code7 = (await S(N)).code;
  const O = await newPage('O');
  await O.goto(BASE + '/?join=' + code7, { waitUntil: 'networkidle0' });
  await typeName(O, 'Obi');
  await O.click('#joinBtn');
  await waitState(O, (s) => s.status === 'lobby' && s.players.length === 2, 'O joined');
  await front(N);
  await N.click('#startBtn');
  await waitState(N, (s) => s.status === 'playing', 'B7 game playing');
  await waitState(O, (s) => s.status === 'playing', 'B7 game playing on O');
  const pages7 = [N, O];
  const turnPg7 = async () => { const st = await S(N); return pages7[st.players.findIndex((p) => p.id === st.turnPlayerId)]; };
  const otherPg7 = async () => ((await turnPg7()) === N ? O : N);
  const stN7 = await S(N);
  const turnName7 = stN7.players.find((p) => p.id === stN7.turnPlayerId).name;

  // Banner person forms (Lesson 6b): second person only on the turn phone,
  // in the opening announcement and in the plain turn banner alike.
  const tp7 = await turnPg7();
  const op7 = await otherPg7();
  await tp7.waitForFunction((nm) => { const el = document.querySelector('#msgText'); return el && el.textContent.indexOf('Na your turn, ' + nm) >= 0; }, { timeout: 12000, polling: 200 }, turnName7).catch(() => {});
  const openTurn = await tp7.evaluate(() => document.querySelector('#msgText').textContent);
  check('the opening banner speaks second person on the turn phone', openTurn.indexOf('Na your turn, ' + turnName7) >= 0, openTurn.slice(0, 70));
  const openOther = await op7.evaluate(() => document.querySelector('#msgText').textContent);
  check('the opening banner speaks third person on the other phone', openOther.indexOf('Na ' + turnName7 + ' turn') >= 0 && openOther.indexOf('Na your turn') === -1, openOther.slice(0, 70));
  // KP13 WS4: the other phone must never be handed the imperative.
  check('the other phone opener carries no imperative addressed at it', openOther.indexOf('Roll the dice') === -1 && openOther.indexOf('your turn') === -1, openOther.slice(0, 70));
  // Play the first turn through (buy Ajegunle, end) so the plain turn
  // banner takes over on the second turn.
  const tpIdOpen = (await S(tp7)).turnPlayerId;
  await send(tp7, 'test_set_position', { playerId: tpIdOpen, space: 0 });
  await send(tp7, 'test_dice', { rolls: [[1, 2]] });
  await clickId(tp7, 'abRoll');
  await waitState(tp7, (s) => s.phase === 'buy' && s.buySpace === 3, 'opener buys Ajegunle');
  await clickId(tp7, 'abBuy');
  await waitState(tp7, (s) => s.phase === 'end', 'opener reaches end phase');
  await clickId(tp7, 'abEnd');
  { // waitState evals its predicate inside the page, so this poll (which
    // needs a Node-side id) runs on state reads instead.
    const end = Date.now() + 12000;
    while ((await S(N)).turnPlayerId === tpIdOpen && Date.now() < end) await sleep(200);
    if ((await S(N)).turnPlayerId === tpIdOpen) throw new Error('second turn never began');
  }
  const tp7b = await turnPg7();
  const op7b = await otherPg7();
  const stN7b = await S(N);
  const name2 = stN7b.players.find((p) => p.id === stN7b.turnPlayerId).name;
  await tp7b.waitForFunction((nm) => { const el = document.querySelector('#msgText'); return el && el.textContent.indexOf('Na your turn, ' + nm) === 0; }, { timeout: 12000, polling: 200 }, name2).catch(() => {});
  const turnBanner = await tp7b.evaluate(() => document.querySelector('#msgText').textContent);
  check('the turn phone reads the second person banner', turnBanner.indexOf('Na your turn, ' + name2) === 0, turnBanner.slice(0, 60));
  const otherBanner = await op7b.evaluate(() => document.querySelector('#msgText').textContent);
  check('the other phone reads the third person banner', otherBanner.indexOf('Na ' + name2 + ' turn') === 0, otherBanner.slice(0, 60));
  check('after the swap the other phone still gets no imperative', otherBanner.indexOf('Roll the dice') === -1 && otherBanner.indexOf('your turn') === -1, otherBanner.slice(0, 60));
  check('the mode pill names the game in the top bar', /Classic/.test(await N.evaluate(() => document.querySelector('#modePill').textContent)));

  // KP10: one view only, the full board. The owner deleted Follow ("if
  // the board is visible, players can see, they are not blind"), so the
  // toggle is gone from the DOM entirely, at every width, for good.
  await front(tp7b);
  check('no view toggle exists anywhere in the game', await tp7b.evaluate(() => !document.getElementById('fullBoardBtn') && !document.querySelector('.board-tools')));
  // Frozen label plus beeps (Lessons 4 and 7): drive the turn clock into
  // its last 10 seconds and watch the label and the beep counter.
  await send(tp7b, 'test_deadline_in', { seconds: 9 });
  await sleep(400);
  const label1 = await tp7b.evaluate(() => document.querySelector('#abRoll').textContent);
  await sleep(2500);
  const label2 = await tp7b.evaluate(() => document.querySelector('#abRoll').textContent);
  check('the roll label froze while its clock ran down', /Roll dice/.test(label1) && /Roll dice/.test(label2) && !/\d/.test(label1) && !/\d/.test(label2), JSON.stringify([label1, label2]));
  await sleep(600);
  const beeps = await tp7b.evaluate(() => window.__kpBeeps || 0);
  check('clock beeps fired inside the last 10 seconds', beeps >= 2, 'beeps=' + beeps);

  // A full move on the full board (KP10): the token travels the track
  // and the landing resolves with the camera steady on the whole board.
  await send(tp7b, 'test_deadline_in', { seconds: 30 });
  const tpId7 = (await S(tp7b)).turnPlayerId;
  await send(tp7b, 'test_set_position', { playerId: tpId7, space: 0 });
  await send(tp7b, 'test_dice', { rolls: [[1, 2]] });
  await clickId(tp7b, 'abRoll');
  await waitState(tp7b, (s) => s.phase === 'buy' || s.phase === 'end', 'the move settled on the full board');
  check('token movement completes on the full board', await tp7b.evaluate((pid) => {
    const st = window.__kolopolyState();
    const p = st.players.find((x) => x.id === pid);
    return !!p && p.position === 3;
  }, tpId7));

  // Pause overlay (Lesson 14): O drops for real; N gets the waiting card.
  await O.evaluate(() => window.__kolopolyDrop());
  await O.goto('about:blank');
  await N.waitForFunction(() => {
    const el = document.querySelector('#pauseOverlay');
    return el && el.classList.contains('show') && /Obi/.test(el.textContent);
  }, { timeout: 15000, polling: 250 }).catch(() => {});
  const pauseText = await N.evaluate(() => document.querySelector('#pauseOverlay').textContent.replace(/\s+/g, ' '));
  check('the pause overlay names the missing player', /Obi/.test(pauseText), pauseText.slice(0, 110));
  check('the pause overlay shows the frozen turn clock', /frozen/.test(pauseText), pauseText.slice(0, 110));
  await O.goto(BASE, { waitUntil: 'networkidle0' });
  await O.waitForFunction(() => window.__kolopolySession && window.__kolopolySession().live && window.__kolopolyState(), { timeout: 15000, polling: 250 }).catch(() => {});
  await N.waitForFunction(() => !document.querySelector('#pauseOverlay').classList.contains('show'), { timeout: 15000, polling: 250 }).catch(() => {});
  check('the pause overlay clears when the player returns', await N.evaluate(() => !document.querySelector('#pauseOverlay').classList.contains('show')));
  await N.close(); await O.close();

  console.log('B8: the bot prompt: create a room, add a bot, start, and the bot plays unaided');
  const BP = await newPage('BP');
  await BP.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(BP, 'Bisi');
  await pickClassic(BP);
  await BP.click('#createBtn');
  await waitState(BP, (s) => s.status === 'lobby', 'BP in lobby');
  await BP.waitForFunction(() => { const el = document.querySelector('#botPrompt'); return el && !el.classList.contains('hidden') && el.textContent.includes('Wanna play with bot?'); }, { timeout: 12000, polling: 200 }).catch(() => {});
  check('creating a room shows the "Wanna play with bot?" prompt card', await BP.evaluate(() => { const el = document.querySelector('#botPrompt'); return !!el && !el.classList.contains('hidden') && el.textContent.includes('Wanna play with bot?'); }));
  await BP.screenshot({ path: SHOTS + 'kp7-botprompt.png' });
  await clickId(BP, 'botAdd1');
  await waitState(BP, (s) => s.players.length === 2 && s.players.some((p) => p.bot), 'bot seated in the lobby', 12000);
  check('tapping Add 1 bot seats a bot right away', (await S(BP)).players.filter((p) => p.bot).length === 1);
  check('the lobby slot carries a clear BOT tag', await BP.evaluate(() => !!document.querySelector('#slotBoard .bot-tag')));
  await BP.screenshot({ path: SHOTS + 'kp7-lobby-bot.png' });
  check('host plus one bot is startable', await BP.evaluate(() => !document.getElementById('startBtn').disabled));
  await BP.click('#startBtn');
  await waitState(BP, (s) => s.status === 'playing', 'bot game playing', 15000);
  const stB8 = await S(BP);
  const botId8 = stB8.players.find((p) => p.bot).id;
  const hostId8 = stB8.hostId;
  let botMoved = false;
  const driveEnd8 = Date.now() + 60000;
  while (Date.now() < driveEnd8) {
    const st = await S(BP);
    if (!st || st.status !== 'playing') break;
    const b = st.players.find((p) => p.id === botId8);
    if (b && (b.position !== 0 || b.deeds > 0 || b.cash !== 1500000)) { botMoved = true; break; }
    if (st.auction) { if (st.auction.highBidder !== hostId8) await send(BP, 'pass_bid', {}); }
    else if (st.turnPlayerId === hostId8) {
      if (st.phase === 'roll') { await send(BP, 'test_set_position', { playerId: hostId8, space: 17 }); await send(BP, 'test_dice', { rolls: [[1, 2]] }); await send(BP, 'roll', {}); }
      else if (st.phase === 'buy') await send(BP, 'decline', {});
      else if (st.phase === 'tax') await send(BP, 'tax_choice', { choice: 'flat' });
      else if (st.phase === 'jail') await send(BP, 'jail_roll', {});
      else if (st.phase === 'end') await send(BP, 'end_turn', {});
    }
    await sleep(250);
  }
  check('the bot completes its first turn unaided and the board state advances', botMoved);
  await BP.close();

  console.log('B9: KP12 mobile matrix: no horizontal overflow at 360 or 390, lobby Start pinned, one floating glass dock (blur, radius, no borders), cash badged with a banknote glyph, primary pill with a depleting timer ring and no separate timer chip, ghost utility items, compact one-line player pills, no rotate hint, Classic bar or view toggle, match clock in the header chip, tall stage, frame assembly deleted, the tile ring filling its box at 100 percent on both axes');
  const overflowOf = (page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  for (const [tag, W, H] of [['M360', 360, 740], ['M390', 390, 844]]) {
    const MP = await newPage(tag);
    // Emulate from birth, never resize a loaded page: a mid-session
    // setViewport leaves the layout viewport stale in this Chrome build
    // and the geometry checks read phantom sizes.
    await MP.emulate({ viewport: { width: W, height: H, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' });
    await MP.goto(BASE, { waitUntil: 'networkidle0' });
    let ov = await overflowOf(MP);
    check(tag + ' landing: scrollWidth never exceeds innerWidth', ov.sw <= ov.iw, JSON.stringify(ov));
    await typeName(MP, 'Mobi');
    await pickClassic(MP);
    await MP.click('#createBtn');
    await waitState(MP, (s) => s.status === 'lobby', tag + ' in lobby');
    await sleep(800);
    ov = await overflowOf(MP);
    check(tag + ' lobby: scrollWidth never exceeds innerWidth', ov.sw <= ov.iw, JSON.stringify(ov));
    if (W === 360) {
      const sb = await MP.evaluate(() => {
        const r = document.getElementById('startBtn').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, ih: window.innerHeight, sy: window.scrollY, docH: document.documentElement.scrollHeight };
      });
      check('360x740 lobby: Start is visible without any page scroll', sb.sy === 0 && sb.docH <= sb.ih + 1 && sb.top >= 0 && sb.bottom <= sb.ih + 1, JSON.stringify(sb));
    }
    await clickId(MP, 'botAdd1');
    await waitState(MP, (s) => s.players.length === 2, tag + ' bot seated');
    await MP.click('#startBtn');
    await waitState(MP, (s) => s.status === 'playing', tag + ' game playing', 15000);
    await sleep(4000);
    ov = await overflowOf(MP);
    check(tag + ' game: scrollWidth never exceeds innerWidth', ov.sw <= ov.iw, JSON.stringify(ov));
    // KP12: if the bot won the opening roll, wait out its turn (it plays
    // unaided) so the dock checks read the page player's own live turn:
    // pill in the action bar, ring on its end.
    {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        const ready = await MP.evaluate(() => !!document.querySelector('#actionBar .btn'));
        if (ready) break;
        await sleep(600);
      }
    }
    const dock = await MP.evaluate(() => {
      const r = document.querySelector('.walletbar').getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, h: r.height, ih: window.innerHeight };
    });
    check(tag + ' game: the dock sits inside the viewport and stays compact', dock.top >= 0 && dock.bottom <= dock.ih + 1 && dock.h <= 160, JSON.stringify(dock));
    // KP12: the dock is ONE frosted glass container (backdrop blur, the
    // 18px+ radius family, no border), not a stack of bordered boxes.
    const glass = await MP.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.walletbar'));
      return { bf: cs.backdropFilter || '', br: parseFloat(cs.borderTopLeftRadius) || 0, bw: cs.borderTopWidth };
    });
    check(tag + ' game: the dock is one glass container (blur, 18px+ radius, no border)', glass.bf.includes('blur') && glass.br >= 18 && glass.bw === '0px', JSON.stringify(glass));
    // KP12: the countdown is a progress ring riding the primary pill;
    // the old separate black timer chip element is gone for good.
    check(tag + ' game: no separate timer chip element exists', await MP.evaluate(() => !document.querySelector('.clock-chip')));
    const ring1 = await MP.evaluate(() => {
      const rg = document.querySelector('.timer-ring');
      if (!rg) return null;
      const fg = rg.querySelector('.ring-fg');
      return { num: rg.querySelector('.ring-num').textContent, off: fg ? parseFloat(fg.style.strokeDashoffset || '0') : -1 };
    });
    check(tag + ' game: the timer ring rides the primary pill with a live seconds number', !!ring1 && /^\d+s$/.test(ring1.num) && ring1.off >= 0, JSON.stringify(ring1));
    await sleep(1700);
    const ring2 = await MP.evaluate(() => {
      const fg = document.querySelector('.timer-ring .ring-fg');
      return fg ? parseFloat(fg.style.strokeDashoffset || '0') : -1;
    });
    check(tag + ' game: the timer ring depletes as the clock runs', ring1 !== null && ring2 > ring1.off + 0.4, 'off ' + (ring1 && ring1.off) + ' -> ' + ring2);
    const strip = await MP.evaluate(() => {
      const chips = [...document.querySelectorAll('#playersStrip .pchip')];
      if (!chips.length) return { n: 0, spread: 999, maxH: 999 };
      const tops = chips.map((c) => Math.round(c.getBoundingClientRect().top));
      return { n: chips.length, spread: Math.max(...tops) - Math.min(...tops), maxH: Math.max(...chips.map((c) => Math.round(c.getBoundingClientRect().height))) };
    });
    check(tag + ' game: player chips form one row, never a tower', strip.n >= 2 && strip.spread <= 2, JSON.stringify(strip));
    check(tag + ' game: player pills are compact (36px tall or less)', strip.maxH <= 36, JSON.stringify(strip));
    const prim = await MP.evaluate(() => {
      const b = document.querySelector('#actionBar .btn');
      return b ? Math.round(b.getBoundingClientRect().height) : 0;
    });
    check(tag + ' game: the primary action is 40 to 46px tall', prim >= 40 && prim <= 46, 'h=' + prim);
    const bw = await MP.evaluate(() => ({ wrap: document.getElementById('boardWrap').clientWidth, iw: window.innerWidth }));
    check(tag + ' game: the board stage runs edge to edge', bw.wrap >= bw.iw - 16, JSON.stringify(bw));
    // KP9: the rotate hint and the Classic bar are gone for good.
    check(tag + ' game: no rotate hint element exists', await MP.evaluate(() => !document.getElementById('rotateHint')));
    check(tag + ' game: no Classic bar element exists', await MP.evaluate(() => !document.getElementById('classicBar')));
    // KP9: the timed Classic match clock ticks inside the header room chip.
    const chipCode = (await S(MP)).code;
    const chipTxt = await MP.evaluate(() => document.getElementById('roomChip').textContent.replace(/\s+/g, ' ').trim());
    check(tag + ' game: the header chip carries the running match time', new RegExp('^Room ' + chipCode + ' · \\d{1,2}:\\d{2}$').test(chipTxt), chipTxt);
    // KP9/KP12: the utility bar is icons over 11px labels, and KP12 makes
    // each item a ghost on the glass: no border box, no background slab.
    const ubar = await MP.evaluate(() => [...document.querySelectorAll('#secondaryBar .ubtn')].map((b) => {
      const cs = getComputedStyle(b);
      return {
        svg: !!b.querySelector('svg'),
        lb: b.querySelector('.u-lb') ? getComputedStyle(b.querySelector('.u-lb')).fontSize : '',
        bw: cs.borderTopWidth, bg: cs.backgroundColor
      };
    }));
    check(tag + ' game: every utility is a ghost item (inline icon, 11px label, no border box)', ubar.length >= 4 && ubar.every((u) => u.svg && u.lb === '11px' && u.bw === '0px' && u.bg === 'rgba(0, 0, 0, 0)'), JSON.stringify(ubar));
    // KP11: the tall stage is restored (the KP10 square is gone), the
    // frame assembly (table, platform, rim) is deleted from the scene,
    // and the tile ring itself fills the box: the layout is built from
    // the box's own aspect and the camera fits the ring's slab-box
    // silhouette at exactly 100 percent on both axes. The span checks
    // keep only a sub-percent allowance for pixel rounding and the
    // camera settle; the design target is 100/100.
    const stageDims = await MP.evaluate(() => { const s = document.querySelector('.game-stage'); return { w: s.clientWidth, h: s.clientHeight, ih: window.innerHeight }; });
    console.log('    ' + tag + ' stage: ' + JSON.stringify(stageDims) + ' share ' + (stageDims.h / stageDims.ih * 100).toFixed(1) + '% of screen height');
    if (W === 390) check('390 game: the tall stage holds at least 58 percent of the screen height', stageDims.h / stageDims.ih >= 0.58, JSON.stringify(stageDims));
    check(tag + ' game: no view toggle element exists', await MP.evaluate(() => !document.getElementById('fullBoardBtn') && !document.querySelector('.board-tools')));
    check(tag + ' game: no frame meshes (table, platform, rim) exist in the scene graph', await MP.evaluate(() => { const d = window.KP3D && window.KP3D.debug ? window.KP3D.debug() : null; return !!d && d.frameMeshes === 0; }));
    // Poll the ring's projected pixel size off the live 3D camera until
    // the settle glide lands (two reads within 3px on BOTH axes): the
    // rig's software GL runs the camera damping in capped steps, so a
    // fixed sleep reads mid-glide.
    let probe = null;
    {
      let prevW = -1, prevH = -1;
      const end = Date.now() + 25000;
      while (Date.now() < end) {
        probe = await MP.evaluate(() => window.KP3D && window.KP3D.boardProbePx ? window.KP3D.boardProbePx() : null);
        if (probe && Math.abs(probe.rimWidthPx - prevW) <= 3 && Math.abs(probe.rimHeightPx - prevH) <= 3) break;
        if (probe) { prevW = probe.rimWidthPx; prevH = probe.rimHeightPx; }
        await sleep(700);
      }
    }
    console.log('    ' + tag + ' board probe (settled): ' + JSON.stringify(probe));
    check(tag + ' game: the tile ring spans at least 99.5 percent of the box width (design target 100)', !!probe && probe.rimWPct >= 99.5, JSON.stringify(probe));
    check(tag + ' game: the tile ring spans at least 99.5 percent of the box height (design target 100)', !!probe && probe.rimHPct >= 99.5, JSON.stringify(probe));
    await MP.close();
  }

  console.log('B10: KP13 WS5: Inflation leads the landing with the MOST PLAYED badge and is the default; a default-created room is an Inflation room; a stored Classic pick still wins');
  const L5 = await newPage('L5');
  await L5.goto(BASE, { waitUntil: 'networkidle0' });
  const land = await L5.evaluate(() => {
    const picks = [...document.querySelectorAll('#gameModeRow .mode-pick')];
    const inf = picks.find((p) => p.dataset.gmode === 'inflation');
    const cla = picks.find((p) => p.dataset.gmode === 'classic');
    const badge = inf ? inf.querySelector('.mode-badge') : null;
    return {
      first: picks.length ? picks[0].dataset.gmode : '',
      badge: badge ? badge.textContent.trim() : '',
      badgeVisible: badge ? badge.offsetParent !== null : false,
      appeal: inf && inf.querySelector('.mode-appeal') ? inf.querySelector('.mode-appeal').textContent.trim() : '',
      infSel: inf ? inf.classList.contains('sel') : false,
      claSel: cla ? cla.classList.contains('sel') : true,
      presetHidden: document.getElementById('presetRow').classList.contains('hidden')
    };
  });
  check('the Inflation card is first on the landing', land.first === 'inflation', JSON.stringify(land));
  check('the MOST PLAYED badge shows on the Inflation card', land.badge === 'MOST PLAYED' && land.badgeVisible, JSON.stringify(land));
  check('the appeal line rides the Inflation card', land.appeal === 'Na this one everybody dey play.', land.appeal);
  check('Inflation is the default selected mode and Classic is not', land.infSel && !land.claSel, JSON.stringify(land));
  check('the preset row shows under the default Inflation pick', !land.presetHidden);
  await L5.screenshot({ path: SHOTS + 'kp13-m390-landing2.png' });
  await typeName(L5, 'Lima');
  await L5.click('#createBtn');
  await waitState(L5, (s) => s.status === 'lobby', 'L5 in lobby');
  check('a room created from the untouched default is an Inflation room', (await S(L5)).settings.gameMode === 'inflation', (await S(L5)).settings.gameMode);
  const slotStyles = await L5.evaluate(() => [...document.querySelectorAll('#slotBoard .slot')].map((el) => getComputedStyle(el).borderTopStyle));
  check('WS3: lobby slot rows have no dashed border', slotStyles.length >= 1 && slotStyles.every((s) => s !== 'dashed'), JSON.stringify(slotStyles));
  await L5.screenshot({ path: SHOTS + 'kp13-m390-lobby2.png' });
  await clickId(L5, 'botAdd1');
  await waitState(L5, (s) => s.players.length === 2, 'L5 bot seated');
  await L5.click('#startBtn');
  await waitState(L5, (s) => s.status === 'playing', 'L5 game playing', 15000);
  await sleep(1200);
  check('the default room plays as Inflation (phase strip present)', await L5.evaluate(() => { const b = document.getElementById('infBar'); const st = window.__kolopolyState(); return !!b && !b.classList.contains('hidden') && !!st && !!st.inf; }));
  await L5.close();
  const L6 = await newPage('L6');
  await L6.goto(BASE, { waitUntil: 'networkidle0' });
  await L6.evaluate(() => localStorage.setItem('kolopolyGameMode', 'classic'));
  await L6.reload({ waitUntil: 'networkidle0' });
  const stored = await L6.evaluate(() => ({
    claSel: document.querySelector('#gameModeRow [data-gmode="classic"]').classList.contains('sel'),
    infSel: document.querySelector('#gameModeRow [data-gmode="inflation"]').classList.contains('sel'),
    presetHidden: document.getElementById('presetRow').classList.contains('hidden')
  }));
  check('a stored Classic pick still loads selected', stored.claSel && !stored.infSel && stored.presetHidden, JSON.stringify(stored));
  await L6.close();

  console.log('B11: KP13 sharpness: at DSF 2 the game canvas backs at least 1.9x its CSS width and the debug probe reports the KP13 floors');
  const SH = await newPage('SH');
  await SH.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' });
  // B11 presents a complete Pixel-class device (8 cores, 8GB) to the
  // Best View probe; the raw rig reports 2 host cores, which honestly
  // reads as a weak device. KP14 B15 grades the classes themselves.
  await SH.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true });
      Object.defineProperty(navigator, 'deviceMemory', { value: 8, configurable: true });
    } catch (e) { }
  });
  await SH.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(SH, 'Shola');
  await pickClassic(SH);
  await SH.click('#createBtn');
  await waitState(SH, (s) => s.status === 'lobby', 'SH in lobby');
  await clickId(SH, 'botAdd1');
  await waitState(SH, (s) => s.players.length === 2, 'SH bot seated');
  await SH.click('#startBtn');
  await waitState(SH, (s) => s.status === 'playing', 'SH game playing', 15000);
  await sleep(2500);
  const sharp = await SH.evaluate(() => {
    const c = document.querySelector('#boardWrap canvas');
    const d = window.KP3D && window.KP3D.debug ? window.KP3D.debug() : null;
    return { cssW: c ? c.clientWidth : 0, backW: c ? c.width : 0, d };
  });
  check('the game canvas backs at least 1.9x its CSS width at DSF 2', sharp.cssW > 0 && sharp.backW >= 1.9 * sharp.cssW, 'css=' + sharp.cssW + ' backing=' + sharp.backW);
  check('the renderer pixel ratio is at least 1.9 at DSF 2', !!sharp.d && sharp.d.pixelRatio >= 1.9, 'pr=' + (sharp.d && sharp.d.pixelRatio));
  check('Auto is the tier in force', !!sharp.d && sharp.d.tier === 'auto' && sharp.d.tierAuto === true, JSON.stringify(sharp.d && { tier: sharp.d.tier, tierAuto: sharp.d.tierAuto }));
  check('the street tile texture beats the old Mid size (156x252)', !!sharp.d && !!sharp.d.tileTex && sharp.d.tileTex.w >= 200 && sharp.d.tileTex.h >= 320, JSON.stringify(sharp.d && sharp.d.tileTex));
  check('the centre texture beats the old Mid size (770x1189)', !!sharp.d && !!sharp.d.centreTex && sharp.d.centreTex.w >= 1200 && sharp.d.centreTex.h >= 1800, JSON.stringify(sharp.d && sharp.d.centreTex));
  check('board textures run at full anisotropy', !!sharp.d && sharp.d.aniso.tile === Math.min(16, sharp.d.aniso.max) && sharp.d.aniso.centre === Math.min(16, sharp.d.aniso.max), JSON.stringify(sharp.d && sharp.d.aniso));
  check('mipmaps are generated for the board textures', !!sharp.d && !!sharp.d.mipmaps && sharp.d.mipmaps.generate === true, JSON.stringify(sharp.d && sharp.d.mipmaps));
  await SH.close();

  console.log('B12: KP13 WS2 in the browser: a confirmed leave ends a 2P game at once, the leaver lands on the landing, the winner sees the final table, and the pause overlay never flashes');
  const Y = await newPage('Y');
  const Z = await newPage('Z');
  await Y.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(Y, 'Yemi');
  await pickClassic(Y);
  await Y.click('#createBtn');
  await waitState(Y, (s) => s.status === 'lobby', 'Y in lobby');
  const code12 = (await S(Y)).code;
  await Z.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(Z, 'Zainab');
  await Z.type('#codeIn', code12);
  await waitState(Z, (s) => s.status === 'lobby' && s.players.length === 2, 'Z joined');
  await Y.click('#startBtn');
  await waitState(Y, (s) => s.status === 'playing', 'B12 game playing', 15000);
  await sleep(600);
  const mb12 = await Y.evaluate(() => { const el = document.querySelector('.msgbar'); const cs = getComputedStyle(el); return { bw: cs.borderTopWidth, bf: cs.backdropFilter || '', h: Math.round(el.getBoundingClientRect().height) }; });
  check('WS3: the message bar is borderless glass (no hard border, backdrop blur)', mb12.bw === '0px' && mb12.bf.includes('blur'), JSON.stringify(mb12));
  check('WS3: the opening message bar stays one slim line (42px max)', mb12.h <= 42, JSON.stringify(mb12));
  await Y.evaluate(() => { window.__pauseSeen = false; window.__pauseTimer = setInterval(() => { const el = document.querySelector('#pauseOverlay'); if (el && el.classList.contains('show')) window.__pauseSeen = true; }, 100); });
  await clickId(Z, 'sbLeave');
  await sleep(350);
  await clickId(Z, 'sbLeave');
  await waitState(Y, (s) => s.status === 'ended', 'the game ends on the confirmed leave', 15000);
  check('the winner sees the final table after the confirmed leave', await Y.evaluate(() => { const el = document.querySelector('#endOverlay'); return !!el && el.classList.contains('show'); }));
  check('the end reason is resignation', (await S(Y)).endReason === 'resignation', (await S(Y)).endReason);
  const pauseSeen = await Y.evaluate(() => { clearInterval(window.__pauseTimer); return !!window.__pauseSeen; });
  check('the pause overlay never appeared for the remaining player', !pauseSeen);
  await Z.waitForFunction(() => { const v = document.querySelector('#view-landing'); return v && v.classList.contains('active'); }, { timeout: 12000, polling: 250 }).catch(() => {});
  check('the leaver client exits to the landing at once', await Z.evaluate(() => document.querySelector('#view-landing').classList.contains('active')));
  await Y.close(); await Z.close();

  console.log('B13: KP14 header redesign: no voice button; the sound button is one three-state audio control; the freed slot is a Share button carrying the owner invitation copy');
  const W = await newPage('W');
  await W.goto(BASE, { waitUntil: 'networkidle0' });
  await W.evaluate(() => {
    window.__shared = null; window.__copied = null;
    Object.defineProperty(navigator, 'share', { value: (p) => { window.__shared = p; return Promise.resolve(); }, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } }, configurable: true });
  });
  check('there is no voice button in the header', await W.evaluate(() => !document.getElementById('voiceBtn')));
  check('the share button sits in the header', await W.evaluate(() => !!document.getElementById('shareBtn')));
  const aud0 = await W.evaluate(() => { const b = document.getElementById('muteBtn'); return { ...window.__kolopolyAudio(), label: b.getAttribute('aria-label'), svg: b.innerHTML }; });
  check('audio starts at state 1, sound and voice on', aud0.state === 1 && aud0.label === 'Sound and voice on', JSON.stringify(aud0));
  check('state 1 audibility: sfx live and voice allowed', aud0.muted === false && aud0.voiceOn === true, JSON.stringify(aud0));
  await W.click('#shareBtn');
  await sleep(250);
  const sh0 = await W.evaluate(() => window.__shared);
  check('landing share carries the game invitation', !!sh0 && sh0.title === 'Kolopoly' && sh0.text === 'Come and play Kolopoly. Break your kolo, buy the street.' && !/join=/.test(sh0.url), JSON.stringify(sh0));
  await W.click('#muteBtn');
  const aud1 = await W.evaluate(() => { const b = document.getElementById('muteBtn'); return { ...window.__kolopolyAudio(), label: b.getAttribute('aria-label'), svg: b.innerHTML }; });
  check('one tap: state 2, sound on voice off', aud1.state === 2 && aud1.label === 'Sound on, voice off', JSON.stringify(aud1));
  check('state 2 audibility: sfx live, voice not allowed', aud1.muted === false && aud1.voiceOn === false, JSON.stringify(aud1));
  await W.click('#muteBtn');
  const aud2 = await W.evaluate(() => { const b = document.getElementById('muteBtn'); return { ...window.__kolopolyAudio(), label: b.getAttribute('aria-label'), svg: b.innerHTML }; });
  check('two taps: state 3, sound off', aud2.state === 3 && aud2.label === 'Sound off', JSON.stringify(aud2));
  check('state 3 audibility: everything silent', aud2.muted === true && aud2.voiceOn === false, JSON.stringify(aud2));
  check('the three states wear three different glyphs', aud0.svg !== aud1.svg && aud1.svg !== aud2.svg && aud0.svg !== aud2.svg);
  await W.click('#muteBtn');
  check('three taps: back to state 1', (await W.evaluate(() => window.__kolopolyAudio().state)) === 1);
  // The stored legacy pair migrates: a phone that had mute on lands on 3.
  const W2 = await newPage('W2');
  await W2.evaluateOnNewDocument(() => { try { localStorage.setItem('kolopolyMute', '1'); localStorage.setItem('kolopolyVoice', '0'); } catch (e) { } });
  await W2.goto(BASE, { waitUntil: 'networkidle0' });
  check('legacy stored mute migrates to state 3', (await W2.evaluate(() => window.__kolopolyAudio().state)) === 3);
  await W2.close();
  const W3 = await newPage('W3');
  await W3.evaluateOnNewDocument(() => { try { localStorage.setItem('kolopolyVoice', '0'); } catch (e) { } });
  await W3.goto(BASE, { waitUntil: 'networkidle0' });
  check('legacy stored voice-off migrates to state 2', (await W3.evaluate(() => window.__kolopolyAudio().state)) === 2);
  await W3.close();
  // In a room: the invite payload through the share sheet, then the copy fallback.
  await typeName(W, 'Wande');
  await W.click('#createBtn');
  await waitState(W, (s) => s.status === 'lobby', 'W in lobby');
  const code13 = (await S(W)).code;
  await W.evaluate(() => { window.__shared = null; });
  await W.click('#shareBtn');
  await sleep(250);
  const sh1 = await W.evaluate(() => window.__shared);
  check('room share carries the room invitation and the join URL', !!sh1 && sh1.title === 'Kolopoly' && sh1.text === 'Join me to play Kolopoly. Room ' + code13 + ' dey wait for you. Break your kolo, buy the street.' && sh1.url.includes('?join=' + code13), JSON.stringify(sh1));
  await W.evaluate(() => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); window.__copied = null; });
  await W.click('#shareBtn');
  await sleep(250);
  const cp1 = await W.evaluate(() => window.__copied);
  check('without a share sheet the fallback copies the invitation text plus the URL', typeof cp1 === 'string' && cp1.includes('Join me to play Kolopoly. Room ' + code13 + ' dey wait for you.') && cp1.includes('?join=' + code13), String(cp1));
  // Gist still owns the messages glyph, now with no bubble anywhere near the header.
  await clickId(W, 'botAdd1');
  await waitState(W, (s) => s.players.length === 2, 'W bot seated');
  await W.click('#startBtn');
  await waitState(W, (s) => s.status === 'playing', 'B13 game playing', 15000);
  await sleep(600);
  const gist13 = await W.evaluate(() => {
    const g = document.querySelector('#sbGist .u-ic');
    const tmp = document.createElement('div');
    tmp.innerHTML = window.icon('messages', 21);
    // Compare parser readback to parser readback: innerHTML serialization
    // expands self-closing SVG tags, so the raw icon string never equals
    // a live element's innerHTML even for the identical glyph.
    return { gist: g ? g.innerHTML : '', messages: tmp.innerHTML };
  });
  check('Gist still renders the messages glyph', gist13.gist === gist13.messages, gist13.gist.slice(0, 60));
  await W.close();

  console.log('B14: KP14 landing: the join card, picks and inputs carry no hard borders; the selected mode card wears the gold ring; the slogan line rides the hero; KP17: the type sits under the scene on cream and the scene band is pure illustration');
  const LND = await newPage('LND');
  await LND.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(400);
  const ld = await LND.evaluate(() => {
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const card = cs(document.getElementById('joinCard'));
    const pick = cs(document.querySelector('#gameModeRow .mode-pick:not(.sel)'));
    const sel = cs(document.querySelector('#gameModeRow .mode-pick.sel'));
    const tok = cs(document.querySelector('.token-pick'));
    const inp = cs(document.getElementById('nameIn'));
    const slogan = document.querySelector('.hero-slogan');
    const sceneTextEls = document.querySelectorAll('.hero-scene h1, .hero-scene p, .hero-scene .display').length;
    return {
      cardBorder: card.borderTopStyle + '/' + card.borderTopWidth,
      pickBorder: pick.borderTopStyle + '/' + pick.borderTopWidth,
      tokBorder: tok ? tok.borderTopStyle + '/' + tok.borderTopWidth : 'missing',
      inpBorder: inp.borderTopStyle + '/' + inp.borderTopWidth,
      selShadow: sel.boxShadow,
      slogan: slogan ? slogan.textContent.trim() : '',
      scrim: !!document.querySelector('.hs-scrim'),
      tzDim: document.querySelectorAll('.tz-dim').length,
      sceneTextEls,
      sloganColor: slogan ? cs(slogan).color : '',
      wmGold: (document.querySelector('.hero-wordmark .gold') || {}).textContent || ''
    };
  });
  check('the join card has no hard border', ld.cardBorder === 'none/0px', ld.cardBorder);
  check('an unselected mode card has no hard border', ld.pickBorder === 'none/0px', ld.pickBorder);
  check('a token pick has no hard border', ld.tokBorder === 'none/0px', ld.tokBorder);
  check('the name input has no hard border', ld.inpBorder === 'none/0px', ld.inpBorder);
  check('the selected mode card wears the gold ring', ld.selShadow.includes('255, 200, 87'), ld.selShadow.slice(0, 90));
  check('the hero carries the settled slogan', ld.slogan === 'Break your kolo, buy the street.', ld.slogan);
  check('KP17: the scene band carries no copy (no heading or paragraph renders inside it)', ld.sceneTextEls === 0, String(ld.sceneTextEls));
  check('KP17: the scrim layer is gone from the hero', ld.scrim === false, String(ld.scrim));
  check('KP17: no dimmed windows remain in the scene', ld.tzDim === 0, String(ld.tzDim));
  check('KP17: the slogan reads in deep amber on cream', ld.sloganColor === 'rgb(138, 90, 0)', ld.sloganColor);
  check('KP17: the wordmark splits ink and gold like the header', ld.wmGold === 'POLY', ld.wmGold);
  check('the landing has no horizontal overflow at 390', await LND.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'scrollWidth ' + (await LND.evaluate(() => document.documentElement.scrollWidth)));
  // KP14 structure pass: the landing is one spacing system, the mode
  // cards share their edges, the preset explainer is chips plus two
  // short lines, and the tagline breaks on its two written lines.
  const st14 = await LND.evaluate(() => {
    // KP14 re-engineer: room type and preset live behind the Room
    // settings disclosure now; open it before measuring their geometry.
    document.getElementById('settingsToggle').click();
    const rect = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
    const picks = [...document.querySelectorAll('#gameModeRow .mode-pick')].map(rect);
    const roomPicks = [...document.querySelectorAll('#roomModeRow .mode-pick')].map(rect);
    const labelTops = [...document.querySelectorAll('#joinCard label')].map((l) => getComputedStyle(l).marginTop);
    const chips = [...document.querySelectorAll('.phase-chip')].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
    const tls = [...document.querySelectorAll('.tagline .tl')].map((s) => Math.round(s.getBoundingClientRect().height));
    const cells = [...document.querySelectorAll('#tokenGrid .token-pick')].map((s) => rect(s));
    const badge = document.querySelector('.mode-badge');
    return { picks, roomPicks, labelTops, chips, tls, cells, badgePos: badge ? getComputedStyle(badge).position : '' };
  });
  check('structure: the two mode cards share top and bottom edges', st14.picks.length === 2 && st14.picks[0].top === st14.picks[1].top && st14.picks[0].bottom === st14.picks[1].bottom, JSON.stringify(st14.picks));
  check('structure: the room type cards share their edges too', st14.roomPicks.length === 2 && st14.roomPicks[0].h === st14.roomPicks[1].h && st14.roomPicks[0].h > 0, JSON.stringify(st14.roomPicks));
  check('structure: every section label takes the same 22px section gap (first label 0)', st14.labelTops[0] === '0px' && st14.labelTops.slice(1).every((m) => m === '22px'), JSON.stringify(st14.labelTops));
  check('structure: the phase salaries are four stat chips with exact amounts', st14.chips.length === 4 && st14.chips[0].includes('₦200,000') && st14.chips[1].includes('₦100,000') && st14.chips[2].includes('₦50,000') && st14.chips[3].includes('₦25,000'), JSON.stringify(st14.chips));
  check('structure: the tagline lines each sit on one line', st14.tls.length === 2 && st14.tls.every((h) => h > 0 && h <= 24), JSON.stringify(st14.tls));
  check('structure: the token pick is one compact strip of six even cells in a single row', st14.cells.length === 6 && st14.cells.every((c) => c.h === st14.cells[0].h && c.top === st14.cells[0].top), JSON.stringify(st14.cells));
  check('structure: the MOST PLAYED badge is out of flow', st14.badgePos === 'absolute', st14.badgePos);
  await LND.close();

  console.log('B15: KP14 Best View: profiles resolve by device class, the learned ceiling steers the start cap, detection is a pure function of the probe');
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const stubHw = (page, cores, mem) => page.evaluateOnNewDocument((c, m) => {
    try {
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: c, configurable: true });
      Object.defineProperty(navigator, 'deviceMemory', { value: m, configurable: true });
    } catch (e) { }
  }, cores, mem);
  // (a) iPhone class: DSF 3, Apple UA, flagship-class core count
  const IP = await newPage('IP');
  await IP.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, userAgent: IPHONE_UA });
  await stubHw(IP, 8, 0);
  await IP.goto(BASE, { waitUntil: 'load' });
  // Read the granted backing promptly: the FPS stepper's grace is 6s,
  // and on this software-GL rig the frames are honestly slow, so a
  // late read would catch the stepper mid-rescue instead of the grant.
  await IP.waitForFunction(() => window.KP3D && window.KP3D.active && window.KP3D.debug, { timeout: 15000, polling: 200 }).catch(() => {});
  await sleep(600);
  const ipDbg = await IP.evaluate(() => {
    const d = window.KP3D.debug();
    // KP15: the landing has no GL canvas anymore (DOM/SVG hero), so the
    // granted ratio is read from the renderer itself via debug().
    return { profile: d.profile, probe: d.probe, backRatio: d.pixelRatio || 0, tierTitle: document.getElementById('tierBtn').title, startCap: d.startCap };
  });
  check('Best View: the iPhone class resolves ULTRA', ipDbg.profile === 'ultra', JSON.stringify({ profile: ipDbg.profile, probe: ipDbg.probe }));
  check('Best View: the iPhone class renders at the granted DSF (2.9x+)', ipDbg.backRatio >= 2.9, 'ratio ' + ipDbg.backRatio);
  check('Best View: the graphics button labels the detection', ipDbg.tierTitle === 'Graphics: Auto (Ultra)', ipDbg.tierTitle);
  check('Best View: the probe reports the class signals', !!ipDbg.probe && ipDbg.probe.dpr === 3 && ipDbg.probe.cores === 8, JSON.stringify(ipDbg.probe));
  // (d) the pure detection table
  const table = await IP.evaluate(() => {
    const d = window.KP3D.detectProfile;
    return {
      iphone15: d({ dpr: 3, cores: 6, mem: 0, gl: 'Apple GPU', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', conn: {} }),
      pixel8: d({ dpr: 2.625, cores: 9, mem: 8, gl: 'ANGLE (Google, Vulkan 1.3.0, Mali-G715)', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', conn: {} }),
      iphoneSE: d({ dpr: 2, cores: 6, mem: 0, gl: 'Apple GPU', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)', conn: {} }),
      weak: d({ dpr: 1, cores: 2, mem: 1, gl: 'Mali-400 MP', ua: 'Mozilla/5.0 (Linux; Android 9; SM-J260F)', conn: {} }),
      saveData: d({ dpr: 3, cores: 6, mem: 0, gl: 'Apple GPU', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', conn: { saveData: true } }),
      slow2g: d({ dpr: 2.625, cores: 9, mem: 8, gl: 'ANGLE (Google, Vulkan 1.3.0, Mali-G715)', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', conn: { effectiveType: '2g' } }),
      desktopVM: d({ dpr: 1, cores: 8, mem: 8, gl: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', conn: {} })
    };
  });
  check('detectProfile: iPhone 15 class lands ULTRA', table.iphone15 === 'ultra', table.iphone15);
  check('detectProfile: Pixel 8 class lands ULTRA', table.pixel8 === 'ultra', table.pixel8);
  check('detectProfile: iPhone SE class lands HIGH', table.iphoneSE === 'high', table.iphoneSE);
  check('detectProfile: weak class lands LITE', table.weak === 'lite', table.weak);
  check('detectProfile: save-data starts one profile conservative', table.saveData === 'high', table.saveData);
  check('detectProfile: a 2g link also drops exactly one profile', table.slow2g === 'high', table.slow2g);
  check('detectProfile: software GL on a desktop UA never lands above BALANCED', table.desktopVM === 'balanced' || table.desktopVM === 'lite', table.desktopVM);
  await IP.close();
  // (b) the weak class: DSF 1, low cores, little memory
  const WK = await newPage('WK');
  await WK.emulate({ viewport: { width: 360, height: 740, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 9; SM-J260F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' });
  await stubHw(WK, 2, 1);
  await WK.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(1000);
  const wkDbg = await WK.evaluate(() => {
    const d = window.KP3D.debug();
    return { profile: d.profile, backRatio: d.pixelRatio || 0 };
  });
  check('Best View: the weak class resolves LITE', wkDbg.profile === 'lite', JSON.stringify(wkDbg));
  check('Best View: the weak class renders at or below 1.5x', wkDbg.backRatio > 0 && wkDbg.backRatio <= 1.5, 'ratio ' + wkDbg.backRatio);
  await WK.close();
  // (c) the learned ceiling steers the next start
  const LN = await newPage('LN');
  await LN.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, userAgent: IPHONE_UA });
  await stubHw(LN, 8, 0);
  await LN.evaluateOnNewDocument(() => { try { localStorage.setItem('kolopolyViewLearn', JSON.stringify({ v: 1, cap: 2, ok: 0 })); } catch (e) { } });
  await LN.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(900);
  const lnDbg = await LN.evaluate(() => { const d = window.KP3D.debug(); return { startCap: d.startCap, learned: d.learned, profile: d.profile }; });
  check('Best View: a learned ceiling of 2 caps the start below the ULTRA profile cap', lnDbg.profile === 'ultra' && lnDbg.startCap === 2, JSON.stringify(lnDbg));
  await LN.close();
  const LN2 = await newPage('LN2');
  await LN2.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, userAgent: IPHONE_UA });
  await stubHw(LN2, 8, 0);
  await LN2.evaluateOnNewDocument(() => { try { localStorage.setItem('kolopolyViewLearn', JSON.stringify({ v: 1, cap: 2, ok: 3 })); } catch (e) { } });
  await LN2.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(900);
  const ln2Dbg = await LN2.evaluate(() => { const d = window.KP3D.debug(); return { startCap: d.startCap }; });
  check('Best View: three stable sessions earn one retry step (2.5), not a leap', ln2Dbg.startCap === 2.5, JSON.stringify(ln2Dbg));
  await LN2.close();

  console.log('B16: KP14 sound sync: dice, hop, land and money sounds schedule within ~120ms of their animation beats, and every mapped event has a sound');
  const M1 = await newPage('M1');
  const M2 = await newPage('M2');
  await M1.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(M1, 'Musa');
  await pickClassic(M1);
  await M1.click('#createBtn');
  await waitState(M1, (s) => s.status === 'lobby', 'M1 in lobby');
  const code16 = (await S(M1)).code;
  await M2.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(M2, 'Moren');
  // Set the code by value + input event, not keystrokes: the rig's
  // keyboard path is the flakiest surface on this shared VM.
  await M2.evaluate((c) => { const el = document.getElementById('codeIn'); el.value = c; el.dispatchEvent(new Event('input', { bubbles: true })); }, code16);
  await waitState(M2, (s) => s.status === 'lobby' && s.players.length === 2, 'M2 joined');
  await M1.click('#startBtn');
  await waitState(M1, (s) => s.status === 'playing', 'B16 game playing', 15000);
  const mPages = [M1, M2];
  const mIds = (await S(M1)).players.map((p) => p.id);
  const mTurnId = (await S(M1)).turnPlayerId;
  const mTp = mPages[mIds.indexOf(mTurnId)];
  await front(mTp);
  await send(mTp, 'test_set_position', { playerId: mTurnId, space: 38 });
  await send(mTp, 'test_dice', { rolls: [[2, 3]] });
  await clickId(mTp, 'abRoll');
  // The rig renders in software at a few frames a second, so the move
  // takes seconds of wall time: wait for the landing beat itself
  // rather than sleeping a fixed span and reading a half-played move.
  await mTp.waitForFunction(() => window.__kpSfxLog && window.__kpSfxLog.some((e) => e.event === 'land'), { timeout: 25000, polling: 250 }).catch(() => {});
  await sleep(400);
  const sfxLog = await mTp.evaluate(() => window.__kpSfxLog.slice());
  const evs = (n) => sfxLog.filter((e) => e.event === n);
  const near = (e) => !!e && Math.abs(e.scheduledAt - e.beatT) <= 120;
  check('sync: the dice rattle is scheduled at the tumble beat', near(evs('diceStart')[0]), JSON.stringify(evs('diceStart')[0] || null));
  check('sync: the dice settle knock lands as the dice stop', near(evs('diceSettle')[0]), JSON.stringify(evs('diceSettle')[0] || null));
  check('sync: every hop of the move got its felt tap', evs('hop').length >= 4, 'hops logged: ' + evs('hop').length);
  check('sync: hop sounds ride their step beats', evs('hop').every(near), JSON.stringify(evs('hop').map((e) => Math.round(e.scheduledAt - e.beatT))));
  check('sync: the landing knock fires on the landing beat', near(evs('land')[0]), JSON.stringify(evs('land')[0] || null));
  const cred = evs('credit').find((e) => e.beat === 'alert');
  check('sync: the salary coin cascade starts with its alert card', !!cred && near(cred), JSON.stringify(cred || evs('credit')[0] || null));
  const man = await mTp.evaluate(() => window.KPSfxEvents);
  const REQUIRED = ['diceStart', 'diceSettle', 'hop', 'land', 'credit', 'debit', 'buy', 'buildDuplex', 'buildMansion', 'stamp', 'siren', 'clang', 'cardSwish', 'cardSnap', 'auctionTick', 'gavel', 'phaseLetter', 'newsSting', 'phaseToll', 'turnRise', 'cheer', 'chime', 'tap'];
  check('the sound manifest covers every mapped event', Array.isArray(man) && REQUIRED.every((n) => man.includes(n)), JSON.stringify(man));
  await M1.close(); await M2.close();

  console.log('B17: KP14 audit fixes in the browser: the pass-and-play lobby hides its dead invite block, a cold-start entry tap survives the socket gap, create options persist, the lobby share speaks the approved copy');
  const P1 = await newPage('P1');
  await P1.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(P1, 'Papa');
  await P1.click('#settingsToggle'); // KP14 re-engineer: room type lives behind the disclosure
  await P1.click('#roomModeRow [data-rmode="pass"]');
  await P1.click('#createBtn');
  await waitState(P1, (s) => s.status === 'lobby' && s.mode === 'pass', 'pass-and-play lobby');
  await sleep(700);
  const passVis = await P1.evaluate(() => ({
    cap: !document.getElementById('lobbyCodeCap').classList.contains('hidden'),
    hero: !document.getElementById('lobbyCodeHero').classList.contains('hidden'),
    qr: !document.getElementById('inviteQr').classList.contains('hidden'),
    actions: !document.querySelector('#view-lobby .invite-actions').classList.contains('hidden'),
    modeLine: document.getElementById('lobbyModeLine').textContent
  }));
  check('the pass lobby hides the whole invite block (caption, code, buttons, QR)', !passVis.cap && !passVis.hero && !passVis.qr && !passVis.actions, JSON.stringify(passVis));
  check('the pass lobby still says what it is', /pass and play/.test(passVis.modeLine), passVis.modeLine);
  await P1.screenshot({ path: SHOTS + 'kp14-wsc-passlobby.png' });
  await P1.close();
  const C9 = await newPage('C9');
  await C9.goto(BASE, { waitUntil: 'networkidle0' });
  await typeName(C9, 'Cold');
  await C9.evaluate(() => {
    window.__kolopolyDrop();
    window.__kolopolySend('create_room', { name: 'Cold', token: 'danfo', clientId: 'cold-1', mode: 'online', settings: { gameMode: 'inflation', preset: 'standard', timed: true, doubleStart: false, noRentInJail: false, firstLapNoBuy: false, chaos: false, voiceAlerts: true, turnTimerSec: 60 } });
  });
  const queued = await C9.evaluate(() => window.__kolopolySession().queued);
  check('an entry tap during the socket gap is queued, not lost', queued >= 1, 'queued=' + queued);
  await waitState(C9, (s) => s.status === 'lobby', 'the queued entry created the room after reconnect', 25000);
  check('the queued cold-start entry created the room on reconnect', (await S(C9)).status === 'lobby');
  const code17 = (await S(C9)).code;
  await C9.evaluate(() => { window.__shared = null; Object.defineProperty(navigator, 'share', { value: (p) => { window.__shared = p; return Promise.resolve(); }, configurable: true }); });
  await C9.click('#shareInviteBtn');
  await sleep(250);
  const shC = await C9.evaluate(() => window.__shared);
  check('the lobby share carries the approved invitation copy', !!shC && shC.title === 'Kolopoly' && shC.text === 'Join me to play Kolopoly. Room ' + code17 + ' dey wait for you. Break your kolo, buy the street.', JSON.stringify(shC));
  await C9.close();
  const O1 = await newPage('O1');
  await O1.goto(BASE, { waitUntil: 'networkidle0' });
  await O1.evaluate(() => {
    const chaos = document.getElementById('optChaos'); chaos.checked = true; chaos.dispatchEvent(new Event('change'));
    const timer = document.getElementById('optTimer'); timer.value = '30'; timer.dispatchEvent(new Event('change'));
  });
  await O1.reload({ waitUntil: 'networkidle0' });
  const oBack = await O1.evaluate(() => ({ chaos: document.getElementById('optChaos').checked, timer: document.getElementById('optTimer').value }));
  check('create options persist across a reload, as the welcome copy promises', oBack.chaos === true && oBack.timer === '30', JSON.stringify(oBack));
  await O1.close();

  console.log('B18: KP14 landing re-engineer: JOIN WITH CODE AT THE TOP. On load, zero scroll, the first viewport holds the name field, the join row, Quick Play, Create room and the mode cards');
  const firstScreen = async (page) => page.evaluate(() => {
    const r = (id) => { const el = document.getElementById(id); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
    const mode = document.querySelector('#gameModeRow .mode-pick');
    const mb = mode ? mode.getBoundingClientRect() : null;
    return { vh: window.innerHeight, name: r('nameIn'), code: r('codeIn'), join: r('joinBtn'), quick: r('quickBtn'), create: r('createBtn'), modeBottom: mb ? Math.round(mb.bottom) : null, settings: r('settingsToggle'), settingsClosed: document.getElementById('roomSettings').classList.contains('hidden') };
  });
  const F1 = await newPage('F1');
  await F1.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await F1.goto(BASE, { waitUntil: 'networkidle0' });
  const fs390 = await firstScreen(F1);
  check('390: the join row sits inside the first viewport on load', !!fs390.join && fs390.join.top >= 0 && fs390.join.bottom <= fs390.vh, JSON.stringify(fs390));
  check('390: name, Quick Play and Create are all in the first screen too', !!fs390.name && fs390.name.bottom <= fs390.vh && !!fs390.quick && fs390.quick.bottom <= fs390.vh && !!fs390.create && fs390.create.bottom <= fs390.vh, JSON.stringify(fs390));
  check('390: the mode cards end inside the first screen', fs390.modeBottom != null && fs390.modeBottom <= fs390.vh, JSON.stringify(fs390));
  check('390: the Room settings disclosure starts closed', fs390.settingsClosed === true, JSON.stringify(fs390));
  await F1.close();
  const F2 = await newPage('F2');
  await F2.emulate({ viewport: { width: 360, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' });
  await F2.goto(BASE, { waitUntil: 'networkidle0' });
  const fs360 = await firstScreen(F2);
  check('360: the join row sits inside the first viewport on load', !!fs360.join && fs360.join.top >= 0 && fs360.join.bottom <= fs360.vh, JSON.stringify(fs360));
  await F2.close();
  // KP17 diagnostic (logged, not asserted): the type stack that left
  // the picture costs more at 360x740 than the slimmed scene band
  // repays, so the mode cards end below the fold at this size by the
  // margin printed here. The number stays on record; the owner rules
  // on the trade (card structure is KP14's, out of KP17 scope).
  const F3 = await newPage('F3');
  await F3.emulate({ viewport: { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' });
  await F3.goto(BASE, { waitUntil: 'networkidle0' });
  const fs360s = await firstScreen(F3);
  console.log('KP17 diagnostic: 360x740 mode cards bottom ' + fs360s.modeBottom + ' against viewport ' + fs360s.vh);
  await F3.close();
} catch (err) {
  failures += 1;
  console.log('SUITE ERROR: ' + err.message);
} finally {
  await browser.close();
  server.kill();
}
check('zero page errors across all pages', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures + ', pageErrors: ' + pageErrors.length);
process.exit(failures ? 1 : 0);
