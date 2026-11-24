// Sign-in mail must never pretend it sent. A host with no Resend key,
// and a Resend call that errors, both tell the player and leave a log.
// The sign-in scene shows a game-style error and a live Try again.
// Run: node test-mail-fail.mjs
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { createMailer } = require('./mailer.js');

let checks = 0, failures = 0;
const check = (name, cond, extra) => {
  checks++;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures++; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{
  const logs = [];
  const mailer = createMailer({
    apiKey: 're_test_fixture',
    log: (line) => logs.push(line),
    fetch: async () => ({ ok: false, status: 422, text: async () => '{"message":"domain not verified"}' })
  });
  const refused = await mailer.sendCode('ada@example.com', '123456');
  check('a Resend refusal is not a success', refused.ok === false && /Try again/.test(refused.message));
  check('the Resend status and body are logged', logs.some((l) => l.includes('422') && l.includes('domain not verified')), logs.join(' | '));
  const down = createMailer({
    apiKey: 're_test_fixture',
    log: (line) => logs.push(line),
    fetch: async () => { throw new Error('connect ECONNREFUSED'); }
  });
  const net = await down.sendCode('ada@example.com', '123456');
  check('a Resend network error is not a success and is logged', net.ok === false && logs.some((l) => l.includes('ECONNREFUSED')));
  const off = createMailer({ apiKey: '', pretend: false, log: () => {} });
  const silent = await off.sendCode('ada@example.com', '123456');
  check('no mail key does not report the code as sent', silent.ok === false && /Nothing was sent/.test(silent.message));
  const test = createMailer({ apiKey: '', pretend: true, log: () => {} });
  const ok = await test.sendCode('ada@example.com', '123456');
  check('the test transport still delivers a code for the suite', ok.ok === true && test.outbox.length === 1);
}

const PORT = 4266;
const BASE = 'http://127.0.0.1:' + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-mail-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), KP_TEST: '', KP_DATA_DIR: dir, RESEND_API_KEY: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
    KP_AUTH_SECRET: 'mail-fail-secret'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; } catch (e) { puppeteer = null; }
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find((p) => fs.existsSync(p));
try {
  for (let i = 0; i < 100 && !log.includes('listening'); i++) await sleep(50);
  check('the host booted', log.includes('listening'), log.slice(-200));
  const res = await fetch(BASE + '/api/auth/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com' }) });
  const body = await res.json();
  check('a real host with no mail key answers 503, not sent', res.status === 503 && body.ok === false && /Nothing was sent/.test(body.message), res.status + ' ' + JSON.stringify(body));
  const again = await fetch(BASE + '/api/auth/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com' }) });
  const againBody = await again.json();
  check('Try again is not eaten by the email rate limit when nothing was sent', again.status === 503 && againBody.ok === false, again.status + ' ' + JSON.stringify(againBody));
  if (!puppeteer || !CHROME) {
    check('browser check skipped, puppeteer or Chrome missing', false);
  } else {
    const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await page.waitForSelector('#view-signin.active #gateEmailIn', { visible: true, timeout: 8000 });
      await page.type('#gateEmailIn', 'ada@example.com');
      await page.click('#gateSendBtn');
      await page.waitForSelector('#gateMsg.auth-error', { visible: true, timeout: 8000 });
      const ui = await page.evaluate(() => {
        const msg = document.getElementById('gateMsg');
        const btn = document.getElementById('gateSendBtn');
        const cs = getComputedStyle(msg);
        return { text: msg.textContent, btn: btn.textContent, disabled: btn.disabled, color: cs.color, bg: cs.backgroundColor };
      });
      check('the sign-in scene shows a light-on-dark error and Try again',
        /Nothing was sent/.test(ui.text) && /Try again/.test(ui.btn) && ui.disabled === false && /rgb\(255, 217, 217\)/.test(ui.color),
        JSON.stringify(ui));
      await page.click('#gateSendBtn');
      await sleep(400);
      const second = await page.evaluate(() => document.getElementById('gateMsg').textContent);
      check('the second tap still shows the error, not Code sent', /Nothing was sent/.test(second) && !/Code sent/.test(second), second);
    } finally {
      await browser.close();
    }
  }
} catch (e) {
  failures++;
  console.log('SUITE ERROR: ' + e.message);
} finally {
  server.kill('SIGTERM');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
}
console.log('---\nchecks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
