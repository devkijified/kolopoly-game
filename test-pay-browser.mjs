// KOLOPOLY paid lobby, browser level: the Pay button against a stub
// Paystack. Nothing talks to the real Paystack; no money can move.
// Regression for the "Opening Paystack…" hang (the client read an
// undeclared `room`, threw before the request left, and the button
// stayed busy forever). Covers: instant press feedback, the jump to the
// checkout page, a Paystack refusal, a dead network, recovery with Try
// again, and the dark paid panel.
// Run: node test-pay-browser.mjs   (needs puppeteer-core and Chrome)
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; } catch (e) { console.log('SKIP: puppeteer-core is not installed (npm i --no-save puppeteer-core)'); process.exit(0); }
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find((p) => fs.existsSync(p));
const PORT = 4231, STUB_PORT = 4232;
const BASE = 'http://127.0.0.1:' + PORT, STUB = 'http://127.0.0.1:' + STUB_PORT;
const SECRET = 'sk_test_pay_browser_fixture';
let checks = 0, failures = 0;
const check = (name, cond, extra) => { checks++; if (cond) console.log('  ok ' + checks + ' - ' + name); else { failures++; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let initMode = 'ok';
let inits = 0;
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url.startsWith('/checkout/')) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Stub Paystack checkout</title><h1>Stub checkout</h1>'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/transaction/initialize') {
      inits++;
      const b = JSON.parse(body || '{}');
      if (initMode === 'fail') { res.statusCode = 400; res.end(JSON.stringify({ status: false, message: 'Stub refused' })); return; }
      res.end(JSON.stringify({ status: true, data: { authorization_url: STUB + '/checkout/' + b.reference, access_code: 'stub', reference: b.reference } }));
      return;
    }
    if (req.url.startsWith('/transaction/verify/')) { res.end(JSON.stringify({ status: true, data: { status: 'abandoned', amount: 20000, currency: 'NGN' } })); return; }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
const tmp = '/tmp/kp-pay-browser-' + process.pid;
fs.mkdirSync(tmp, { recursive: true });
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), KP_TEST: '1', KP_PAYMENTS: 'paystack', PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_BASE: STUB,
    PAYSTACK_TIMEOUT_MS: '700', KP_AUTH_SECRET: 'pay-browser-secret', KP_DATA_DIR: tmp, RESEND_API_KEY: '',
    SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
    KP_RETENTION_FILE: tmp + '/retention.json', KP_COMPETITION_FILE: tmp + '/competition.json', KP_PRIZES_FILE: tmp + '/prizes.json',
    KP_PAYMENTS_FILE: tmp + '/payments.json', KP_PAYOUTS_FILE: tmp + '/payouts.json'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 100 && !log.includes('listening'); i++) await sleep(100);
const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
let exitCode = 1;
try {
  const email = 'payer@example.com';
  const r1 = await (await fetch(BASE + '/api/auth/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })).json();
  const v = await (await fetch(BASE + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: r1.devCode }) })).json();
  check('signed in through the test mail transport', !!v.token);
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  await page.evaluateOnNewDocument((t, e) => { try { localStorage.setItem('kolopolyAuthToken', t); localStorage.setItem('kolopolyAuthEmail', e); localStorage.setItem('kolopolyName', 'Payer'); } catch (err) {} }, v.token, email);
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__kolopolySend === 'function' && window.__kolopolyWsOpen !== false, { timeout: 10000 });
  await sleep(800);
  await page.evaluate((t) => window.__kolopolySend('create_room', { name: 'Payer', token: 'danfo', mode: 'online', cityId: 'lagos', authToken: t, settings: { gameMode: 'inflation' } }), v.token);
  await page.waitForSelector('#paySeatBtn', { visible: true, timeout: 10000 });
  const panel = await page.evaluate(() => { const p = document.querySelector('.paid-panel'); const cs = getComputedStyle(p); return { bg: cs.backgroundImage + ' ' + cs.backgroundColor, color: cs.color }; });
  check('paid panel is a dark game panel with light text', /rgb\(38, 43, 53\)|rgb\(23, 26, 33\)/.test(panel.bg) && /rgb\(244, 236, 220\)/.test(panel.color), JSON.stringify(panel));

  // 1. Paystack refuses: the button recovers with a clear error and Try again.
  initMode = 'fail';
  await page.click('#paySeatBtn');
  const busy = await page.evaluate(() => { const b = document.getElementById('paySeatBtn'); return b && b.disabled && /Opening Paystack/.test(b.textContent); });
  check('the press shows Opening Paystack at once and locks the button', busy);
  await page.waitForSelector('#payError', { visible: true, timeout: 8000 }).catch(() => {});
  const afterFail = await page.evaluate(() => ({ err: (document.getElementById('payError') || {}).textContent || '', btn: (document.getElementById('paySeatBtn') || {}).textContent || '', disabled: !!(document.getElementById('paySeatBtn') || {}).disabled }));
  check('a Paystack refusal shows a game-style error, never a stuck button', /Stub refused|Paystack/.test(afterFail.err) && !afterFail.disabled && /Try again/.test(afterFail.btn), JSON.stringify(afterFail));

  // 2. Dead network: the request fails, the button recovers.
  await page.setRequestInterception(true);
  const onReq = (rq) => { if (rq.url().includes('/api/payments/initialize')) rq.abort(); else rq.continue(); };
  page.on('request', onReq);
  await page.click('#paySeatBtn');
  await sleep(1500);
  const afterNet = await page.evaluate(() => ({ err: (document.getElementById('payError') || {}).textContent || '', disabled: !!(document.getElementById('paySeatBtn') || {}).disabled }));
  check('a dead network shows the connection error and re-arms the button', /connection/i.test(afterNet.err) && !afterNet.disabled, JSON.stringify(afterNet));
  page.off('request', onReq);
  await page.setRequestInterception(false);

  // 3. Paystack answers: the browser lands on the checkout page.
  initMode = 'ok';
  const nav = page.waitForNavigation({ timeout: 10000 }).catch(() => null);
  await page.click('#paySeatBtn');
  await nav;
  check('the checkout page opens on the first press', page.url().startsWith(STUB + '/checkout/kp'), page.url());
  check('the checkout page is the Paystack page the server opened', /Stub Paystack checkout/.test(await page.title()));
  check('no page errors on the paid lobby', pageErrors.length === 0, JSON.stringify(pageErrors));
  exitCode = failures ? 1 : 0;
} catch (e) {
  console.log('SUITE ERROR: ' + e.message);
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGTERM'); stub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('---\nchecks: ' + checks + ', failures: ' + failures);
process.exit(failures || exitCode ? 1 : 0);
