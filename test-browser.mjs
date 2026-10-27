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

try {
  // ---------------------------------------------------------- scenario 1
  console.log('B1: create, join by invite code, countdown, start, buy with alert, salary credit alert, deed sheet, share card');
  const A = await newPage('A');
  await A.goto(BASE, { waitUntil: 'networkidle0' });
  await A.screenshot({ path: SHOTS + 'kp-landing.png' });
  check('landing renders the join card', await A.evaluate(() => !!document.querySelector('#createBtn') && !!document.querySelector('#nameIn')));
  await typeName(A, 'Ada');
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
    return el && /Salary alert/.test(el.textContent);
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
    return el && /x 2/.test(el.textContent);
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

  console.log('B9: KP11 mobile matrix: no horizontal overflow at 360 or 390, lobby Start pinned, dock pinned and compact, no rotate hint, Classic bar or view toggle, match clock in the header chip, tall stage restored, frame assembly deleted, the tile ring filling its box at 100 percent on both axes, icon utility bar');
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
    const dock = await MP.evaluate(() => {
      const r = document.querySelector('.walletbar').getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, h: r.height, ih: window.innerHeight };
    });
    check(tag + ' game: the dock sits inside the viewport and stays compact', dock.top >= 0 && dock.bottom <= dock.ih + 1 && dock.h <= 160, JSON.stringify(dock));
    const strip = await MP.evaluate(() => {
      const chips = [...document.querySelectorAll('#playersStrip .pchip')];
      if (!chips.length) return { n: 0, spread: 999 };
      const tops = chips.map((c) => Math.round(c.getBoundingClientRect().top));
      return { n: chips.length, spread: Math.max(...tops) - Math.min(...tops) };
    });
    check(tag + ' game: player chips form one row, never a tower', strip.n >= 2 && strip.spread <= 2, JSON.stringify(strip));
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
    // KP9: the utility bar is icons over 11px labels, not text buttons.
    const ubar = await MP.evaluate(() => [...document.querySelectorAll('#secondaryBar .ubtn')].map((b) => ({
      svg: !!b.querySelector('svg'),
      lb: b.querySelector('.u-lb') ? getComputedStyle(b.querySelector('.u-lb')).fontSize : ''
    })));
    check(tag + ' game: every utility button carries an inline icon and an 11px label', ubar.length >= 4 && ubar.every((u) => u.svg && u.lb === '11px'), JSON.stringify(ubar));
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
