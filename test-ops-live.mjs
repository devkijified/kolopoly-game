// LiveOps desk: every admin API refuses a stranger, and every mutating
// action needs a confirmed session and leaves an audit row.
import { spawn } from 'child_process';
import fs from 'fs';

const TOKEN = 'kp-test-sentinel-token-9f3a';
let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}

function spawnServer(port) {
  const audit = '/tmp/kolopoly-ops-audit-' + port + '.json';
  try { fs.unlinkSync(audit); } catch (e) { /* fresh */ }
  const env = { ...process.env, PORT: String(port), KP_TEST: '1', KP_ADMIN_TOKEN: TOKEN, KP_OPS_AUDIT_FILE: audit, KP_PERSIST_ROOMS: '' };
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not boot\n' + logs)), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('Kolopoly listening')) { clearTimeout(timer); resolve(); } });
  });
  return { child, ready };
}
async function request(base, method, urlPath, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  let body;
  if (opts.json) {
    headers['Content-Type'] = 'application/json';
    headers.Accept = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(base + urlPath, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, text, json, setCookie };
}
function cookie(res) {
  const line = (res.setCookie || []).find((item) => item.startsWith('kp_ops=')) || '';
  return line ? line.split(';')[0].slice('kp_ops='.length) : '';
}

const port = 4466;
const server = spawnServer(port);
await server.ready;
const base = 'http://127.0.0.1:' + port;
try {
  const page = await request(base, 'GET', '/ops');
  check('admin login page returns 200', page.status === 200 && page.text.includes('House key'));
  check('login page does not contain the house key', !page.text.includes(TOKEN));

  const apis = ['/ops/live', '/ops/live?part=rooms', '/ops/live?part=players', '/ops/live?part=economy', '/ops/live?part=payments', '/ops/live?part=moderation', '/ops/live?part=events', '/ops/live?part=audit'];
  for (const path of apis) {
    const res = await request(base, 'GET', path);
    check(path + ' is 401 without a session', res.status === 401, String(res.status));
  }
  const stray = await request(base, 'POST', '/ops/live/act', { json: { action: 'ban', confirm: true, playerId: 'seed-ada' } });
  check('a mutating call without a session is 401', stray.status === 401);

  const opened = await request(base, 'POST', '/ops/unlock', { json: { token: TOKEN } });
  const session = cookie(opened);
  check('the house key opens a session', opened.status === 200 && !!session);
  const auth = { Cookie: 'kp_ops=' + session };

  const overview = await request(base, 'GET', '/ops/live', { headers: auth });
  check('overview has health and live counts', overview.status === 200 && overview.json.health && typeof overview.json.health.build === 'string' && overview.json.live);
  check('overview has no secret key field', !JSON.stringify(overview.json).includes('secret') && !overview.text.includes(TOKEN));

  const rooms = await request(base, 'GET', '/ops/live?part=rooms', { headers: auth });
  check('seeded room is listed', (rooms.json.rooms || []).some((r) => r.code === 'SEED01'));
  const detail = await request(base, 'GET', '/ops/live?part=room&code=SEED01', { headers: auth });
  check('room detail has seats and a turn log', detail.json.room && detail.json.room.players.length === 2 && detail.json.room.feed.length >= 1);

  const found = await request(base, 'GET', '/ops/live?part=players&q=adaeze.seed', { headers: auth });
  check('player search matches the seed email', (found.json.players || []).some((p) => p.id === 'seed-ada'));
  const one = await request(base, 'GET', '/ops/live?part=player&id=seed-ada', { headers: auth });
  check('player detail has games, cosmetics and trades', one.json.player && one.json.player.games === 18 && one.json.player.cosmetics.length >= 1 && one.json.player.trades.length === 1);

  const econ = await request(base, 'GET', '/ops/live?part=economy&days=30', { headers: auth });
  check('economy chart has 30 days and the headlines', econ.json.series && econ.json.series.length === 30 && typeof econ.json.headlines.dau === 'number' && typeof econ.json.headlines.d7 === 'number');
  const pay = await request(base, 'GET', '/ops/live?part=payments', { headers: auth });
  check('payments list paid, failed and pending without a secret', pay.json.payments.length === 3 && !pay.text.includes('sk_') && !pay.text.includes('secret'));

  const noConfirm = await request(base, 'POST', '/ops/live/act', { headers: auth, json: { action: 'ban', playerId: 'seed-ada' } });
  check('ban without confirmation is refused', noConfirm.status === 400);

  const actions = [
    ['ban', { action: 'ban', playerId: 'seed-ada' }],
    ['unban', { action: 'unban', playerId: 'seed-ada' }],
    ['mute', { action: 'mute', playerId: 'seed-chi' }],
    ['unmute', { action: 'unmute', playerId: 'seed-chi' }],
    ['grant', { action: 'grant', playerId: 'seed-bim', kind: 'cosmetic', name: 'Gold Suya' }],
    ['revoke', { action: 'revoke', playerId: 'seed-bim', kind: 'cosmetic', name: 'Gold Suya' }],
    ['end', { action: 'end', code: 'SEED01' }],
    ['kick', { action: 'kick', code: 'SEED01', playerId: 2 }],
    ['nudge', { action: 'nudge', code: 'SEED01', playerId: 2 }],
    ['replace', { action: 'replace', code: 'SEED01', playerId: 1 }],
    ['close', { action: 'close', code: 'SEED01' }],
    ['event_stop', { action: 'event_stop' }],
    ['event_start', { action: 'event_start', name: 'Owambe Week' }],
    ['event_schedule', { action: 'event_schedule', name: 'Next week' }],
    ['broadcast', { action: 'broadcast', text: 'House announcement' }]
  ];
  for (const [name, body] of actions) {
    const res = await request(base, 'POST', '/ops/live/act', { headers: auth, json: Object.assign({ confirm: true }, body) });
    check(name + ' is accepted and confirmed', res.status === 200 && res.json && res.json.ok === true, JSON.stringify(res.json));
  }
  const pushNo = await request(base, 'POST', '/ops/live/act', { headers: auth, json: { confirm: true, action: 'broadcast_push' } });
  check('push without the typed phrase is refused', pushNo.status === 400);
  const pushYes = await request(base, 'POST', '/ops/live/act', { headers: auth, json: { confirm: true, action: 'broadcast_push', confirmText: 'SEND PUSH' } });
  check('typed push confirmation does not send a blast', pushYes.status === 200 && /No push was sent/.test(pushYes.json.message || ''));

  const audit = await request(base, 'GET', '/ops/live?part=audit', { headers: auth });
  const names = new Set((audit.json.audit || []).map((row) => row.action));
  check('audit names the owner and the actions', (audit.json.audit || []).every((row) => row.who === 'owner' && row.at) && ['ban', 'kick', 'broadcast', 'broadcast_push'].every((name) => names.has(name)));
  check('audit does not contain the house key', !audit.text.includes(TOKEN));

  const script = await request(base, 'GET', '/ops/live.js');
  check('desk script does not embed the house key', script.status === 200 && !script.text.includes(TOKEN));
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  server.child.kill();
}
console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
