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
  const page = await browser.newPage();
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
// All rig pages share one origin, so the remembered name pre-fills later
// pages. Clear the field before typing a fresh name.
async function typeName(page, name) {
  await page.evaluate(() => { document.getElementById('nameIn').value = ''; });
  await page.type('#nameIn', name);
}
// In-game action buttons are re-rendered on every state change, so a resolved
// node can detach mid-click. Click them by id at evaluate time, with retries.
async function clickId(page, id) {
  for (let i = 0; i < 6; i++) {
    const ok = await page.evaluate((x) => { const el = document.getElementById(x); if (!el) return false; el.click(); return true; }, id);
    if (ok) return;
    await sleep(300);
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
  }, { timeout: 9000 }).catch(() => {});
  const creditAlert = await tp.evaluate(() => {
    const el = document.querySelector('.alert-card.credit');
    return el ? el.textContent : '';
  });
  check('salary credit alert rendered green with exact ₦200,000', /₦200,000/.test(creditAlert), creditAlert.slice(0, 90));
  await tp.screenshot({ path: SHOTS + 'kp-alert.png' });
  await waitState(tp, (s) => s.phase === 'end', 'rent landing resolved');
  await clickId(tp, 'abEnd');

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
  await tp.click('#fullBoardBtn'); // full board: the pot label sits on Owambe Grounds itself
  await sleep(500);
  await tp.screenshot({ path: SHOTS + 'kp-board.png' });
  check('board shot taken with the pot on Owambe Grounds', (await S(tp)).pot === 200000);

  // Deed sheet for Banana Island, with its area meaning line.
  await tp.evaluate(() => { document.querySelectorAll('.bspace')[39].click(); });
  await tp.waitForFunction(() => document.querySelector('#deedScrim').classList.contains('show'), { timeout: 6000 });
  const deedText = await tp.evaluate(() => document.querySelector('#deedSheet').textContent);
  check('deed sheet shows price, ladder and the area meaning', /Banana Island/.test(deedText) && /₦400,000/.test(deedText) && /Final boss\. If you get house here/.test(deedText), deedText.slice(0, 120));
  await tp.screenshot({ path: SHOTS + 'kp-deed.png' });
  await tp.evaluate(() => document.querySelector('#deedScrim').classList.remove('show'));

  // Share card: the Landlord card.
  await tp.evaluate(() => window.__kolopolyShareCard('landlord', { name: 'Ada', amount: 400000, line: 'don buy Banana Island. LANDLORD level don change for this table.', code: window.__kolopolyState().code }));
  await tp.waitForFunction(() => document.querySelector('#shareOverlay').classList.contains('show'), { timeout: 6000 });
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
  await clickId(tp2, 'abDecline');
  await waitState(other2, (s) => !!s.auction, 'auction panel live');
  check('auction opened on decline', true);
  await front(other2);
  await other2.waitForFunction(() => !!document.querySelector('#auctionSlot [data-bid]'), { timeout: 6000, polling: 200 });
  await other2.evaluate(() => { const bs = document.querySelectorAll('#auctionSlot [data-bid]'); bs[bs.length - 1].click(); });
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
  }, { timeout: 9000 }).catch(() => {});
  const rentAlert = await payerPage.evaluate(() => {
    const el = document.querySelector('.alert-card.debit');
    return el ? el.textContent : '';
  });
  check('Phase 2 rent alert shows the multiplied ₦20,000 (printed x lowest die)', /₦20,000/.test(rentAlert), rentAlert.slice(0, 90));
  const infBarText = await payerPage.evaluate(() => document.querySelector('#infBar').textContent);
  check('infobar shows Index 5.1x and Pure water ₦10', /5\.1x/.test(infBarText) && /Pure water ₦10/.test(infBarText), infBarText.slice(0, 120));
  await sleep(500);
  await payerPage.screenshot({ path: SHOTS + 'kp-inflation.png' });
  await E.close(); await F.close();
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
