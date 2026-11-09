// Kolopoly ops desk. Auth is enforced on the server: closed when the
// house key is unset, 401 on a bad key, and a signed cookie after a good one.
import { spawn } from 'child_process';
import WebSocket from 'ws';
import fs from 'fs';

const TOKEN = 'kp-test-sentinel-token-9f3a';
const CLIENT_ID = 'ops-device-abc12345';
const GUEST_ID = 'ops-device-tunde999';
let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnServer(port, token) {
  const file = '/tmp/kolopoly-ops-' + port + '.json';
  const compFile = '/tmp/kolopoly-ops-' + port + '-competition.json';
  try { fs.unlinkSync(file); } catch (e) { /* fresh */ }
  try { fs.unlinkSync(compFile); } catch (e) { /* fresh */ }
  const env = { ...process.env, PORT: String(port), KP_TEST: '1', KP_RETENTION_FILE: file, KP_COMPETITION_FILE: compFile };
  delete env.KP_ADMIN_TOKEN;
  if (token) env.KP_ADMIN_TOKEN = token;
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('.', import.meta.url).pathname,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not boot on ' + port + '\n' + logs)), 8000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('Kolopoly listening')) { clearTimeout(timer); resolve(); }
    });
  });
  return { child, ready, logs: () => logs, file, compFile };
}

async function request(base, method, urlPath, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  let body;
  if (opts.json) {
    headers['Content-Type'] = 'application/json';
    headers.Accept = headers.Accept || 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(base + urlPath, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, text, json, headers: res.headers, setCookie };
}
function cookieLine(res) {
  return (res.setCookie || []).find((line) => line.startsWith('kp_ops=')) || '';
}
function cookieValue(res) {
  const line = cookieLine(res);
  if (!line) return '';
  return line.split(';')[0].slice('kp_ops='.length);
}
function bannedKey(value) {
  const banned = new Set(['clientId', 'reconnectToken', 'privateKey', 'publicKey', 'endpoint', 'p256dh', 'auth', 'token', 'subscription', 'keys']);
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk).find(Boolean) || null;
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (banned.has(key)) return key;
        const hit = walk(child);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(value);
}

async function closedDoor() {
  console.log('OPS closed: no KP_ADMIN_TOKEN');
  const port = 4277;
  const server = spawnServer(port, null);
  await server.ready;
  const base = 'http://127.0.0.1:' + port;
  try {
    const page = await request(base, 'GET', '/ops');
    check('unset key returns 503', page.status === 503);
    check('503 page says the desk is locked', page.text.includes('Ops locked until KP_ADMIN_TOKEN is set'));
    check('503 page is noindex', String(page.headers.get('x-robots-tag') || '').includes('noindex'));
    const snap = await request(base, 'GET', '/ops/snapshot');
    check('snapshot is 503 json while locked', snap.status === 503 && snap.json && snap.json.message === 'Ops locked until KP_ADMIN_TOKEN is set');
    const unlock = await request(base, 'POST', '/ops/unlock', { json: { token: TOKEN } });
    check('unlock is refused while the key is unset', unlock.status === 503 && !cookieLine(unlock));
    check('closed door does not echo a submitted key', !unlock.text.includes(TOKEN));
  } finally {
    server.child.kill();
  }
}

async function openDoor() {
  console.log('OPS open: house key, cookie, snapshot shape');
  const port = 4278;
  const server = spawnServer(port, TOKEN);
  await server.ready;
  const base = 'http://127.0.0.1:' + port;
  const httpBase = base;
  try {
    const home = await request(base, 'GET', '/');
    check('landing still serves', home.status === 200 && home.text.includes('KOLO'));
    check('landing does not link the desk', !home.text.includes('href="/ops"') && !home.text.includes("href='/ops'"));
    const robots = await request(base, 'GET', '/robots.txt');
    check('robots.txt hides /ops', robots.status === 200 && /Disallow:\s*\/ops/.test(robots.text));

    const page = await request(base, 'GET', '/ops');
    check('the gate is served when the key is set', page.status === 200 && page.text.includes('House key'));
    check('the gate is noindex and does not contain the key', page.text.includes('noindex') && !page.text.includes(TOKEN));
    check('gate response carries X-Robots-Tag', String(page.headers.get('x-robots-tag') || '').includes('noindex'));
    const script = await request(base, 'GET', '/ops/desk.js');
    check('desk script does not embed the key', script.status === 200 && !script.text.includes(TOKEN));

    const bare = await request(base, 'GET', '/ops/snapshot');
    check('snapshot without a session is 401', bare.status === 401 && bare.json && bare.json.ok === false);

    const wrong = await request(base, 'POST', '/ops/unlock', {
      json: { token: 'not-the-house-key' },
      headers: { 'X-Forwarded-For': '203.0.113.10' }
    });
    check('wrong key is 401 and sets no cookie', wrong.status === 401 && !cookieLine(wrong) && !wrong.text.includes(TOKEN));

    const leaked = await request(base, 'POST', '/ops/unlock?token=' + encodeURIComponent(TOKEN), {
      json: { token: TOKEN }
    });
    check('a key in the query string is refused', leaked.status === 400 && leaked.json && leaked.json.error === 'query' && !cookieLine(leaked));

    const badJson = await request(base, 'POST', '/ops/unlock', {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      json: { token: 12 }
    });
    // request() JSON.stringifies, so token:12 is valid JSON of the wrong type
    check('a non-string key is refused', badJson.status === 400);

    const opened = await request(base, 'POST', '/ops/unlock', { json: { token: TOKEN } });
    const line = cookieLine(opened);
    const session = cookieValue(opened);
    check('right key opens the desk', opened.status === 200 && opened.json && opened.json.ok === true && !!session);
    check('session cookie is HttpOnly, Strict, and path-scoped', /HttpOnly/.test(line) && /SameSite=Strict/.test(line) && /Path=\/ops/.test(line));
    check('localhost session cookie is not marked Secure', !/;\s*Secure/i.test(line));
    check('unlock body does not return the key or the cookie', opened.text !== '' && !opened.text.includes(TOKEN) && !opened.text.includes(session));

    const secure = await request(base, 'POST', '/ops/unlock', {
      json: { token: TOKEN },
      headers: { 'X-Forwarded-Proto': 'https' }
    });
    check('https behind the proxy sets Secure', /;\s*Secure/i.test(cookieLine(secure)));

    const authed = await request(base, 'GET', '/ops/snapshot', { headers: { Cookie: 'kp_ops=' + session } });
    check('cookie session can read the snapshot', authed.status === 200 && authed.json && authed.json.ok === true);
    const shape = authed.json;
    check('live block has rooms, humans, bots, and phases', shape.live && typeof shape.live.rooms === 'number'
      && typeof shape.live.humans === 'number' && typeof shape.live.bots === 'number'
      && shape.live.byStatus && ['lobby', 'playing', 'ended'].every((k) => typeof shape.live.byStatus[k] === 'number'));
    check('today block has tables, claims, and AFK', shape.today && ['tablesStarted', 'tablesFinished', 'claims', 'afkTakeovers', 'uniqueShelves'].every((k) => typeof shape.today[k] === 'number'));
    check('push status has no key material', shape.push && typeof shape.push.enabled === 'boolean' && typeof shape.push.subscribers === 'number'
      && shape.push.publicKey == null && shape.push.privateKey == null);
    check('retention health is a status, not a raw dump', shape.retention && typeof shape.retention.present === 'boolean' && typeof shape.retention.writable === 'boolean');
    check('uptime is present', typeof shape.uptimeSec === 'number');

    const bearer = await request(base, 'GET', '/ops/snapshot', { headers: { Authorization: 'Bearer ' + TOKEN } });
    check('bearer house key can read the snapshot', bearer.status === 200 && bearer.json && bearer.json.ok === true);
    const bearerBad = await request(base, 'GET', '/ops/snapshot', {
      headers: { Authorization: 'Bearer not-the-house-key', 'X-Forwarded-For': '203.0.113.11' }
    });
    check('wrong bearer is 401', bearerBad.status === 401);

    const claim = await request(base, 'POST', '/api/retention/claim', { json: { clientId: CLIENT_ID, name: 'Ngozi' } });
    check('a shelf claim still works', claim.status === 200 && claim.json && claim.json.ok === true);

    const host = await openSocket(base.replace('http', 'ws'));
    send(host, 'create_room', { name: 'Ngozi', token: 'danfo', mode: 'online', clientId: CLIENT_ID, settings: { gameMode: 'classic', timed: false, turnTimerSec: 0 } });
    await waitState(host, (s) => s.status === 'lobby' && s.players.length === 1, 'host lobby');
    const code = host.state.code;
    const reconnect = host.joined && host.joined.token;
    const guest = await openSocket(base.replace('http', 'ws'));
    send(guest, 'join_room', { code, name: 'Tunde', token: 'keke', clientId: GUEST_ID });
    await waitState(host, (s) => s.players.length === 2, 'guest joined');
    send(host, 'start_game', {});
    await waitState(host, (s) => s.status === 'playing', 'game started');

    const live = await request(base, 'GET', '/ops/snapshot', { headers: { Cookie: 'kp_ops=' + session } });
    const body = JSON.stringify(live.json);
    const room = (live.json.rooms || []).find((r) => r.code === code);
    check('a started table shows on the desk', !!room && room.status === 'playing' && room.rules === 'classic' && room.humans === 2);
    check('today counted the table and the claim', live.json.today.tablesStarted >= 1 && live.json.today.claims >= 1 && live.json.today.uniqueShelves >= 1);
    check('live phase counts include the playing table', live.json.live.byStatus.playing >= 1 && live.json.live.rooms >= 1 && live.json.live.humans >= 2);
    check('room dump keeps display names and drops secrets', !!room && room.names.some((p) => p.name === 'Ngozi')
      && !body.includes(CLIENT_ID) && !body.includes(GUEST_ID) && (!reconnect || !body.includes(reconnect)));
    check('snapshot keys do not carry tokens or push secrets', bannedKey(live.json) == null, bannedKey(live.json));
    const vapid = await request(base, 'GET', '/api/push/vapid');
    check('snapshot does not echo the VAPID public key', vapid.json && vapid.json.publicKey && !body.includes(vapid.json.publicKey));
    check('snapshot text has no privateKey field', !body.includes('privateKey'));
    const roomApi = await request(base, 'GET', '/api/room/' + code);
    check('public room lookup still works', roomApi.status === 200 && roomApi.json && roomApi.json.exists === true);
    host.ws.close();
    guest.ws.close();

    const flipped = session.slice(0, -1) + (session.slice(-1) === 'a' ? 'b' : 'a');
    const tamper = await request(base, 'GET', '/ops/snapshot', {
      headers: { Cookie: 'kp_ops=' + flipped, 'X-Forwarded-For': '203.0.113.12' }
    });
    check('a tampered cookie is 401', tamper.status === 401);

    const locked = await request(base, 'POST', '/ops/lock', {
      json: {},
      headers: { Cookie: 'kp_ops=' + session }
    });
    check('lock clears the cookie', locked.status === 200 && /Max-Age=0/.test(cookieLine(locked)));
    const after = await request(base, 'GET', '/ops/snapshot', { headers: { Cookie: 'kp_ops=' + session } });
    check('a locked session cannot read the snapshot', after.status === 401);

    for (let i = 0; i < 5; i++) {
      const attempt = await request(base, 'POST', '/ops/unlock', {
        json: { token: 'wrong-' + i },
        headers: { 'X-Forwarded-For': '203.0.113.20' }
      });
      check('failed unlock ' + (i + 1) + ' stays 401', attempt.status === 401 && !cookieLine(attempt));
    }
    const cooled = await request(base, 'POST', '/ops/unlock', {
      json: { token: TOKEN },
      headers: { 'X-Forwarded-For': '203.0.113.20' }
    });
    check('the next try from that address is rate limited', cooled.status === 429 && !cookieLine(cooled));
    const other = await request(base, 'POST', '/ops/unlock', {
      json: { token: TOKEN },
      headers: { 'X-Forwarded-For': '203.0.113.30' }
    });
    check('a different address can still open the desk', other.status === 200 && !!cookieValue(other));
    check('server logs never print the house key', !server.logs().includes(TOKEN));
    void httpBase;
  } finally {
    server.child.kill();
  }
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const bag = { ws, state: null, joined: null };
    ws.on('open', () => resolve(bag));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'joined') bag.joined = msg;
      if (msg.type === 'state') bag.state = msg.room;
    });
  });
}
function send(bag, type, obj) {
  bag.ws.send(JSON.stringify(Object.assign({ type }, obj || {})));
}
async function waitState(bag, pred, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (bag.state && pred(bag.state)) return bag.state;
    await sleep(40);
  }
  throw new Error('timeout: ' + label);
}

async function competitionDesk() {
  console.log('OPS competition: the paid city ladder');
  const port = 4279;
  const server = spawnServer(port, TOKEN);
  await server.ready;
  const base = 'http://127.0.0.1:' + port;
  const bearer = { Authorization: 'Bearer ' + TOKEN };
  const cityOf = (view, id) => (view.table || []).find((row) => row.id === id);
  const sizeOf = (view, id, players) => {
    const row = cityOf(view, id);
    return row ? row.sizes.find((s) => s.players === players) : null;
  };
  try {
    const bare = await request(base, 'GET', '/ops/competition');
    check('competition without a session is 401', bare.status === 401 && bare.json && bare.json.ok === false);
    const leaked = await request(base, 'GET', '/ops/competition?token=' + encodeURIComponent(TOKEN), { headers: bearer });
    check('competition refuses a key in the query string', leaked.status === 400 && leaked.json && leaked.json.error === 'query');

    const first = await request(base, 'GET', '/ops/competition', { headers: bearer });
    check('competition opens with the house key', first.status === 200 && first.json && first.json.ok === true);
    check('the seeded ladder is served before any save', first.json.saved === false && first.json.settings.cities.length === 6);
    const ibadan = first.json.settings.cities.find((c) => c.id === 'ibadan');
    const summit = first.json.settings.cities.find((c) => c.flagship);
    check('seeded fees match the settled ladder', ibadan && ibadan.fee === 200 && ibadan.venue === 'The Brown Roof'
      && summit && summit.city === 'Aso Rock, Abuja' && summit.fee === 25000 && summit.venue === 'The Summit');
    check('seeded shares step down by table size', first.json.settings.splits['2'] === 80 && first.json.settings.splits['3'] === 75
      && first.json.settings.splits['4'] === 70 && first.json.settings.splits['5'] === 65 && first.json.settings.splits['6'] === 60);
    const lagos6 = sizeOf(first.json, 'lagos', 6);
    check('money table: Lagos at 6 players', !!lagos6 && lagos6.pot === 30000 && lagos6.winner === 18000 && lagos6.house === 12000, JSON.stringify(lagos6));
    const ibadan2 = sizeOf(first.json, 'ibadan', 2);
    check('money table: Ibadan at 2 players', !!ibadan2 && ibadan2.pot === 400 && ibadan2.winner === 320 && ibadan2.house === 80, JSON.stringify(ibadan2));

    const defaults = JSON.parse(JSON.stringify(first.json.settings));
    const noAuth = await request(base, 'POST', '/ops/competition', { json: defaults });
    check('a save without a session is 401', noAuth.status === 401 && noAuth.json && noAuth.json.ok === false);
    const foreign = await request(base, 'POST', '/ops/competition', { json: defaults, headers: { ...bearer, Origin: 'http://evil.example' } });
    check('a save from a foreign origin is refused', foreign.status === 403 && foreign.json && foreign.json.error === 'origin');

    const badFee = JSON.parse(JSON.stringify(defaults));
    badFee.cities.find((c) => c.id === 'lagos').fee = 0;
    const badFeeRes = await request(base, 'POST', '/ops/competition', { json: badFee, headers: bearer });
    check('a zero entry fee is refused with a reason', badFeeRes.status === 400 && badFeeRes.json && !!badFeeRes.json.message);
    const fracFee = JSON.parse(JSON.stringify(defaults));
    fracFee.cities.find((c) => c.id === 'kano').fee = 1000.5;
    const fracFeeRes = await request(base, 'POST', '/ops/competition', { json: fracFee, headers: bearer });
    check('a fractional entry fee is refused', fracFeeRes.status === 400);
    const badShare = JSON.parse(JSON.stringify(defaults));
    badShare.splits['2'] = 101;
    const badShareRes = await request(base, 'POST', '/ops/competition', { json: badShare, headers: bearer });
    check('a winner share above 100 is refused', badShareRes.status === 400);
    const zeroShare = JSON.parse(JSON.stringify(defaults));
    zeroShare.splits['6'] = 0;
    const zeroShareRes = await request(base, 'POST', '/ops/competition', { json: zeroShare, headers: bearer });
    check('a winner share of zero is refused', zeroShareRes.status === 400);
    const rising = JSON.parse(JSON.stringify(defaults));
    rising.splits['2'] = 60;
    const risingRes = await request(base, 'POST', '/ops/competition', { json: rising, headers: bearer });
    check('a winner share that grows with table size is refused', risingRes.status === 400);
    const blankCity = JSON.parse(JSON.stringify(defaults));
    blankCity.cities[0].city = '   ';
    const blankRes = await request(base, 'POST', '/ops/competition', { json: blankCity, headers: bearer });
    check('a blank city name is refused', blankRes.status === 400);

    const afterBad = await request(base, 'GET', '/ops/competition', { headers: bearer });
    check('refused saves leave the ladder untouched', afterBad.json.saved === false
      && afterBad.json.settings.cities.find((c) => c.id === 'lagos').fee === 5000);

    const edited = JSON.parse(JSON.stringify(defaults));
    edited.cities.find((c) => c.id === 'lagos').fee = 6000;
    edited.splits['6'] = 55;
    const saved = await request(base, 'POST', '/ops/competition', { json: edited, headers: bearer });
    check('a clean save lands', saved.status === 200 && saved.json && saved.json.ok === true && saved.json.saved === true);
    const editedLagos6 = sizeOf(saved.json, 'lagos', 6);
    check('money table follows the saved numbers', !!editedLagos6 && editedLagos6.pot === 36000 && editedLagos6.winner === 19800 && editedLagos6.house === 16200, JSON.stringify(editedLagos6));
    const reread = await request(base, 'GET', '/ops/competition', { headers: bearer });
    check('the saved ladder reads back', reread.json.saved === true
      && reread.json.settings.cities.find((c) => c.id === 'lagos').fee === 6000
      && reread.json.settings.splits['6'] === 55);
    let onDisk = null;
    try { onDisk = JSON.parse(fs.readFileSync(server.compFile, 'utf8')); } catch (e) { onDisk = null; }
    check('the saved ladder is on disk beside the shelf', !!onDisk && onDisk.cities.find((c) => c.id === 'lagos').fee === 6000);
    check('competition answers carry no house key', !JSON.stringify(reread.json).includes(TOKEN));
  } finally {
    server.child.kill();
  }
}

try {
  await closedDoor();
  await openDoor();
  await competitionDesk();
} catch (err) {
  failures += 1;
  console.log('SUITE ERROR: ' + (err && err.stack || err));
}
console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
