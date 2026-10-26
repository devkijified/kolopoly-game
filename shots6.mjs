// KP5 tokens frame: all six modelled pieces clustered around START in a
// pass-and-play game, shot at follow zoom. Own server on 4216, killed after.
import { createRequire } from 'node:module';
const require2 = createRequire('/home/hatch/workspace/mobile-rig/package.json');
const puppeteer = require2('puppeteer-core');
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = 4216;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = '/home/hatch/workspace/mobile-rig/browsers/chrome/linux-155.0.8059.84/chrome-linux64/chrome';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });
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
let page = null;
async function freshPage() {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 560, height: 560, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  p.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message));
  return p;
}
const S = () => page.evaluate(() => window.__kolopolyState());
const send = (type, obj) => page.evaluate((t, o) => window.__kolopolySend(t, o), type, obj || {});
async function waitState(pred, label, ms) {
  const src = pred.toString();
  await page.waitForFunction((s) => {
    const st = window.__kolopolyState();
    if (!st) return false;
    return eval(s)(st);
  }, { timeout: ms || 15000, polling: 200 }, src).catch(() => { throw new Error('waitState timeout: ' + label); });
}

try {
  const TOKENS = ['danfo', 'keke', 'okada', 'generator', 'boot', 'fila'];
  const NAMES = ['Dan', 'Kek', 'Oka', 'Gen', 'Boo', 'Fil'];
  // Retry the setup until the random first turn belongs to a corner token,
  // so the follow camera centres the whole START cluster.
  const SPOT = { danfo: 39, keke: 0, boot: 1, okada: 2, generator: 3, fila: 37 };
  let st = null;
  for (let attempt = 0; attempt < 8 && !st; attempt++) {
    if (page) await page.close().catch(() => {});
    page = await freshPage();
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => { try { sessionStorage.clear(); localStorage.removeItem('kolopolySeatLS'); } catch (e) { } });
    await send('create_room', { name: NAMES[0], token: TOKENS[0], mode: 'pass', settings: {} });
    await waitState((s) => s.status === 'lobby', 'pass lobby');
    for (let k = 1; k < 6; k++) await send('add_local_player', { name: NAMES[k], token: TOKENS[k] });
    await waitState((s) => s.players.length === 6, 'six local players');
    await send('start_game', {});
    await waitState((s) => s.status === 'playing', 'game playing');
    const cur = await S();
    const turnTok = cur.players.find((p) => p.id === cur.turnPlayerId).token;
    if (turnTok === 'danfo' || turnTok === 'keke') { st = cur; console.log('turn token: ' + turnTok); }
  }
  if (!st) throw new Error('no corner turn player after retries');
  await sleep(1600); // countdown + settle
  st.players.forEach((p) => send('test_set_position', { playerId: p.id, space: SPOT[p.token] }));
  await sleep(1500); // hops/teleports settle, camera glides to the turn token
  const gl = await page.evaluate(() => ({ active: !!(window.KP3D && window.KP3D.active), tier: window.KP3D && window.KP3D.tier }));
  console.log('GL: ' + JSON.stringify(gl));
  await page.screenshot({ path: SHOTS + 'kp5-tokens.png' });
  console.log('kp5-tokens: shot taken');
} catch (err) {
  console.log('SHOTS6 ERROR: ' + err.message);
} finally {
  await browser.close();
  server.kill();
}
console.log('shots6 done');
