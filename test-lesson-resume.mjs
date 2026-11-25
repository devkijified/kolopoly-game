// A saved Training Ground seat whose server room is gone must start a
// fresh lesson. It must not show the room-closed banner or toast.
import { spawn } from 'child_process';
import { webkit } from 'playwright';

const PORT = 4604;
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: Object.assign({}, process.env, { PORT: String(PORT), KP_TEST: '1', KP_PERSIST_ROOMS: '', RESEND_API_KEY: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', KP_AUTH_SECRET: 'resume' }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40 && !log.includes('listening'); i++) await sleep(150);
if (!log.includes('listening')) { console.error(log); process.exit(1); }

let failed = 0;
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (err) => console.log('PAGE', err.message));
try {
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.click('#trainOfferYes');
  await page.waitForFunction(() => {
    const s = window.__kolopolyState();
    return s && s.practice && s.practice.step === 'hello';
  });
  const first = await page.evaluate(() => window.__kolopolyState().code);
  await page.evaluate(() => window.__kolopolySend('test_drop_room', {}));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const s = window.__kolopolyState && window.__kolopolyState();
    return s && s.practice && s.practice.kind === 'intro' && s.practice.step === 'hello';
  }, { timeout: 10000 });
  const second = await page.evaluate(() => window.__kolopolyState().code);
  const text = await page.locator('body').innerText();
  const banner = await page.locator('#updateBanner').getAttribute('class');
  if (second === first) { console.error('same dead room came back'); failed += 1; }
  if (/room don close/i.test(text)) { console.error('room-closed copy is on screen'); failed += 1; }
  if (banner && !/hidden/.test(banner)) { console.error('update banner visible ' + banner); failed += 1; }
  console.log(failed ? 'resume failed' : 'fresh lesson after a gone room', first, '->', second);
} catch (e) {
  console.error(e);
  failed += 1;
}
await ctx.close();
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
