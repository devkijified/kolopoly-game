'use strict';
// Kolopoly ops desk. View only.
// The house key is KP_ADMIN_TOKEN from the environment. It is compared
// with a hash so the check does not leak the length, then traded for a
// short-lived signed cookie. The key never goes in a query string, a
// log line, localStorage, or the page source.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCKED_MESSAGE = 'Ops locked until KP_ADMIN_TOKEN is set';
const SESSION_MS = 4 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 5;
const GLOBAL_LIMIT = 20;
const OPS_DIR = path.join(__dirname, 'ops');
const DESK_HTML = fs.readFileSync(path.join(OPS_DIR, 'desk.html'), 'utf8');
const DESK_CSS = fs.readFileSync(path.join(OPS_DIR, 'desk.css'));
const DESK_JS = fs.readFileSync(path.join(OPS_DIR, 'desk.js'));
const ROUTES = new Set(['/ops', '/ops/desk.css', '/ops/desk.js', '/ops/snapshot', '/ops/unlock', '/ops/lock']);
const QUERY_KEYS = ['token', 'key', 'password', 'secret', 'kp_admin_token'];
const STRIP_KEYS = new Set([
  'clientId', 'reconnectToken', 'reconnect', 'privateKey', 'publicKey',
  'endpoint', 'p256dh', 'auth', 'token', 'ws', 'subscription', 'keys'
]);

function currentToken() {
  const token = String(process.env.KP_ADMIN_TOKEN || '').trim();
  return token || null;
}
function sessionKey() {
  return crypto.createHmac('sha256', 'kolopoly.ops.session.v1').update(currentToken() || '').digest();
}
function tokenMatches(given) {
  const secret = currentToken() || '';
  const a = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(given == null ? '' : given), 'utf8').digest();
  return !!secret && crypto.timingSafeEqual(a, b);
}
function escapeAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function createOps(opts) {
  opts = opts || {};
  const rooms = opts.rooms;
  const retention = opts.retention;
  const bootAt = Date.now();
  const buckets = new Map();
  const globalBucket = { n: 0, windowEnd: 0, lockedUntil: 0 };
  let sessionGen = 0;

  function routeOf(req) {
    const clean = String((req.url || '').split('?')[0] || '');
    if (clean.includes('..') || clean.includes('\\')) return null;
    const pathOnly = clean.length > 1 && clean.endsWith('/') ? clean.slice(0, -1) : clean;
    return ROUTES.has(pathOnly) ? pathOnly : null;
  }
  function accepts(req) {
    return !!routeOf(req);
  }

  function clientKey(req) {
    const sock = (req.socket && req.socket.remoteAddress) || '';
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64);
    return sock + '|' + xff;
  }
  function sweepBuckets(now) {
    if (globalBucket.windowEnd && now > globalBucket.windowEnd && !globalBucket.lockedUntil) {
      globalBucket.n = 0;
      globalBucket.windowEnd = 0;
    }
    if (globalBucket.lockedUntil && now > globalBucket.lockedUntil) {
      globalBucket.n = 0;
      globalBucket.windowEnd = 0;
      globalBucket.lockedUntil = 0;
    }
    for (const [key, bucket] of buckets) {
      const ended = bucket.lockedUntil ? now > bucket.lockedUntil : now > bucket.windowEnd;
      if (ended) buckets.delete(key);
    }
    if (buckets.size > 200) buckets.clear();
  }
  function rateLimited(key) {
    const now = Date.now();
    sweepBuckets(now);
    if (globalBucket.lockedUntil && now < globalBucket.lockedUntil) return true;
    const bucket = buckets.get(key);
    return !!(bucket && bucket.lockedUntil && now < bucket.lockedUntil);
  }
  function recordFail(key) {
    const now = Date.now();
    sweepBuckets(now);
    let bucket = buckets.get(key);
    if (!bucket) bucket = { n: 0, windowEnd: now + FAIL_WINDOW_MS, lockedUntil: 0 };
    bucket.n += 1;
    if (bucket.n >= FAIL_LIMIT) bucket.lockedUntil = bucket.lockedUntil || (now + FAIL_WINDOW_MS);
    buckets.set(key, bucket);
    if (!globalBucket.windowEnd || now > globalBucket.windowEnd) {
      globalBucket.n = 0;
      globalBucket.windowEnd = now + FAIL_WINDOW_MS;
      globalBucket.lockedUntil = 0;
    }
    globalBucket.n += 1;
    if (globalBucket.n >= GLOBAL_LIMIT) globalBucket.lockedUntil = globalBucket.lockedUntil || (now + FAIL_WINDOW_MS);
  }
  function clearFails(key) {
    buckets.delete(key);
  }

  function leakedQuery(req) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      for (const key of QUERY_KEYS) if (params.has(key)) return true;
      return false;
    } catch (e) {
      return true;
    }
  }
  function originOk(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (origin === 'null') return false;
    let host;
    try { host = new URL(origin).host; } catch (e) { return false; }
    const expected = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return host.toLowerCase() === expected.toLowerCase();
  }
  function bearerValue(req) {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match ? match[1] : '';
  }
  function readCookie(req, name) {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
  }
  function sessionValid(raw) {
    const parts = String(raw || '').split('.');
    const body = parts[0] || '';
    const sig = parts[1] || '';
    const mac = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(sig);
    const compared = b.length === a.length ? b : Buffer.alloc(a.length);
    const equal = crypto.timingSafeEqual(a, compared) && b.length === a.length && parts.length === 2;
    if (!equal) return false;
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch (e) { return false; }
    return !!(payload && payload.g === sessionGen && typeof payload.e === 'number' && Number.isFinite(payload.e) && payload.e > Date.now());
  }
  function issueSession() {
    const body = Buffer.from(JSON.stringify({
      e: Date.now() + SESSION_MS,
      g: sessionGen,
      n: crypto.randomBytes(8).toString('hex')
    })).toString('base64url');
    const mac = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
    return body + '.' + mac;
  }
  function secureCookie(req) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto === 'https') return true;
    if (req.socket && req.socket.encrypted) return true;
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    return true;
  }
  function cookieHeader(value, req, clear) {
    const bits = [
      'kp_ops=' + (clear ? '' : value),
      'HttpOnly',
      'SameSite=Strict',
      'Path=/ops',
      'Max-Age=' + (clear ? '0' : String(Math.floor(SESSION_MS / 1000)))
    ];
    if (secureCookie(req)) bits.push('Secure');
    return bits.join('; ');
  }
  function wantsJson(req) {
    const ctype = String(req.headers['content-type'] || '');
    const accept = String(req.headers.accept || '');
    if (ctype.includes('application/json')) return true;
    if (accept.includes('application/json') && !accept.includes('text/html')) return true;
    return false;
  }

  function baseHeaders(extra) {
    return Object.assign({
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Cache-Control': 'private, no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    }, extra || {});
  }
  function send(res, status, body, contentType, extra) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, baseHeaders(Object.assign({
      'Content-Type': contentType,
      'Content-Length': buf.length
    }, extra || {})));
    res.end(buf);
  }
  function sendJson(res, status, obj, extra) {
    send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
  }
  function pageHtml(errorText) {
    return DESK_HTML.replace('data-error=""', 'data-error="' + escapeAttr(errorText || '') + '"');
  }
  function lockedHtml() {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<meta name="robots" content="noindex, nofollow, noarchive">'
      + '<title>Kolopoly ops</title><style>'
      + 'body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#140e0a;color:#f4ecde;font:16px/1.45 system-ui,sans-serif;padding:24px}'
      + 'article{max-width:440px;background:#fffaf1;color:#1c140e;border-radius:22px;padding:28px 24px;box-shadow:0 24px 60px rgba(0,0,0,.35)}'
      + 'p{margin:0} .k{letter-spacing:.16em;text-transform:uppercase;font-size:12px;font-weight:700;color:#8a6a35}'
      + 'h1{font-size:28px;line-height:1.1;margin:10px 0} .stamp{display:inline-block;margin-top:16px;border:2px solid #9d2c2c;color:#9d2c2c;font-weight:800;letter-spacing:.14em;padding:4px 8px;border-radius:6px}'
      + '</style></head><body><article><p class="k">Kolopoly</p><h1>Ops desk</h1>'
      + '<p id="locked">' + LOCKED_MESSAGE + '</p>'
      + '<p class="stamp">CLOSED</p></article></body></html>';
  }

  function authenticate(req) {
    const bearer = bearerValue(req);
    const cookie = readCookie(req, 'kp_ops');
    if (!bearer && !cookie) return { ok: false, status: 401, guess: false };
    if (bearer && (sessionValid(bearer) || tokenMatches(bearer))) return { ok: true };
    if (cookie && sessionValid(cookie)) return { ok: true };
    return { ok: false, status: 401, guess: true };
  }

  function scrub(value, secret) {
    if (Array.isArray(value)) return value.map((item) => scrub(item, secret));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, child] of Object.entries(value)) {
        if (STRIP_KEYS.has(key)) continue;
        out[key] = scrub(child, secret);
      }
      return out;
    }
    if (typeof value === 'string' && secret && value === secret) return '••••';
    return value;
  }

  function snapshotBody() {
    const list = [];
    let humans = 0;
    let humansHere = 0;
    let bots = 0;
    let watching = 0;
    const byStatus = { lobby: 0, playing: 0, ended: 0 };
    const devices = new Set();
    for (const room of rooms.values()) {
      const status = room.status === 'playing' || room.status === 'ended' ? room.status : 'lobby';
      byStatus[status] += 1;
      let roomHumans = 0;
      let roomHere = 0;
      let roomBots = 0;
      const names = [];
      for (const player of room.players) {
        const isBot = !!player.bot;
        if (isBot) roomBots += 1;
        else {
          roomHumans += 1;
          if (player.connected) roomHere += 1;
        }
        if (player.clientId) devices.add(player.clientId);
        if (names.length < 8) {
          names.push({
            name: String(player.name || '').slice(0, 20),
            bot: isBot,
            here: !!player.connected && !isBot,
            afk: !!player.afkTaken
          });
        }
      }
      humans += roomHumans;
      humansHere += roomHere;
      bots += roomBots;
      watching += room.spectators ? room.spectators.size : 0;
      const settings = room.settings || {};
      const anchor = status !== 'lobby' && room.startedAt ? room.startedAt : (room.createdAt || room.startedAt || Date.now());
      list.push({
        code: room.code,
        mode: room.mode === 'pass' ? 'pass' : 'online',
        rules: settings.gameMode === 'inflation' ? 'inflation' : 'classic',
        preset: settings.gameMode === 'inflation' ? (settings.preset || 'standard') : null,
        isPublic: !!room.isPublic,
        status,
        phase: status === 'playing' ? (room.phase || 'roll') : status,
        paused: !!room.paused,
        infPhase: room.inf ? room.inf.phase : null,
        humans: roomHumans,
        humansHere: roomHere,
        bots: roomBots,
        seats: room.players.length,
        watching: room.spectators ? room.spectators.size : 0,
        ageSec: Math.max(0, Math.round((Date.now() - anchor) / 1000)),
        names
      });
    }
    const rank = { playing: 0, lobby: 1, ended: 2 };
    list.sort((a, b) => (rank[a.status] - rank[b.status]) || (a.ageSec - b.ageSec) || String(a.code).localeCompare(String(b.code)));
    let shelf = null;
    try { shelf = retention && retention.opsSummary ? retention.opsSummary() : null; }
    catch (e) { shelf = null; }
    const today = shelf ? shelf.today : { claims: 0, tablesStarted: 0, tablesFinished: 0, afkTakeovers: 0 };
    const rolling = shelf ? shelf.rolling : { window: 'two Lagos days', claims: 0, tablesStarted: 0, tablesFinished: 0, afkTakeovers: 0 };
    return {
      ok: true,
      now: Date.now(),
      lagosDay: shelf ? shelf.day : null,
      uptimeSec: Math.max(0, Math.round((Date.now() - bootAt) / 1000)),
      live: {
        rooms: list.length,
        humans,
        humansHere,
        bots,
        watching,
        devices: devices.size,
        byStatus
      },
      today: {
        tablesStarted: today.tablesStarted,
        tablesFinished: today.tablesFinished,
        claims: today.claims,
        afkTakeovers: today.afkTakeovers,
        claimedShelves: shelf ? shelf.claimedToday : 0,
        uniqueShelves: shelf ? shelf.shelves : 0
      },
      rolling,
      push: shelf ? shelf.push : { enabled: false, source: 'off', subscribers: 0, muted: 0, denied: 0 },
      retention: shelf ? shelf.file : { present: false, writable: false, bytes: 0, override: false, label: 'retention.json' },
      rooms: list.slice(0, 40),
      roomsTruncated: list.length > 40
    };
  }

  function readRaw(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4096) {
          reject(Object.assign(new Error('too big'), { code: 'too big' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  async function readTokenBody(req) {
    let raw = '';
    try { raw = await readRaw(req); }
    catch (e) { return { error: 'bad' }; }
    const ctype = String(req.headers['content-type'] || '');
    if (ctype.includes('application/json')) {
      if (!raw) return { error: 'bad' };
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return { error: 'bad' }; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'bad' };
      if (typeof parsed.token !== 'string') return { error: 'bad' };
      return { token: parsed.token };
    }
    if (ctype.includes('application/x-www-form-urlencoded')) {
      const token = new URLSearchParams(raw).get('token');
      if (token == null) return { error: 'bad' };
      return { token };
    }
    return { error: 'bad' };
  }

  function failAuth(req, res, status, error, message) {
    const body = { ok: false, error, message };
    if (wantsJson(req) || status === 429 || status === 400 || status === 403) {
      sendJson(res, status, body);
      return;
    }
    send(res, status, pageHtml(message), 'text/html; charset=utf-8');
  }

  async function unlock(req, res) {
    if (!originOk(req)) {
      failAuth(req, res, 403, 'origin', 'That request did not come from this desk.');
      return;
    }
    const parsed = await readTokenBody(req);
    if (parsed.error) {
      failAuth(req, res, 400, 'bad', 'The desk could not read that key.');
      return;
    }
    const key = clientKey(req);
    if (String(parsed.token).length > 500) {
      recordFail(key);
      failAuth(req, res, 401, 'unauthorized', 'That key no open this desk.');
      return;
    }
    if (rateLimited(key)) {
      tokenMatches(parsed.token);
      failAuth(req, res, 429, 'locked', 'Too many tries. The desk is quiet for a while.');
      return;
    }
    if (!tokenMatches(parsed.token)) {
      recordFail(key);
      failAuth(req, res, 401, 'unauthorized', 'That key no open this desk.');
      return;
    }
    clearFails(key);
    const session = issueSession();
    const extra = { 'Set-Cookie': cookieHeader(session, req, false) };
    if (wantsJson(req)) {
      sendJson(res, 200, { ok: true }, extra);
      return;
    }
    send(res, 303, '', 'text/plain; charset=utf-8', Object.assign({ Location: '/ops' }, extra));
  }

  function lock(req, res) {
    if (!originOk(req)) {
      sendJson(res, 403, { ok: false, error: 'origin' });
      return;
    }
    if (authenticate(req).ok) sessionGen += 1;
    const extra = { 'Set-Cookie': cookieHeader('', req, true) };
    if (wantsJson(req)) {
      sendJson(res, 200, { ok: true }, extra);
      return;
    }
    send(res, 303, '', 'text/plain; charset=utf-8', Object.assign({ Location: '/ops' }, extra));
  }

  function snapshot(req, res) {
    const key = clientKey(req);
    if (rateLimited(key) && bearerValue(req) && !sessionValid(bearerValue(req)) && !readCookie(req, 'kp_ops')) {
      tokenMatches(bearerValue(req));
      sendJson(res, 429, { ok: false, error: 'locked', message: 'Too many tries. The desk is quiet for a while.' });
      return;
    }
    const auth = authenticate(req);
    if (!auth.ok) {
      if (auth.guess) recordFail(key);
      const status = rateLimited(key) && auth.guess ? 429 : 401;
      const message = status === 429
        ? 'Too many tries. The desk is quiet for a while.'
        : 'That key no open this desk.';
      sendJson(res, status, { ok: false, error: status === 429 ? 'locked' : 'unauthorized', message });
      return;
    }
    sendJson(res, 200, scrub(snapshotBody(), currentToken()));
  }

  async function dispatch(req, res, route) {
    if (leakedQuery(req)) {
      const message = 'The key does not travel in the address.';
      if (req.method === 'GET' && route === '/ops' && !wantsJson(req)) {
        send(res, 400, pageHtml(message), 'text/html; charset=utf-8');
        return;
      }
      sendJson(res, 400, { ok: false, error: 'query', message });
      return;
    }
    if (!currentToken()) {
      if (req.method === 'GET' && route === '/ops') {
        send(res, 503, lockedHtml(), 'text/html; charset=utf-8', {
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'"
        });
        return;
      }
      sendJson(res, 503, { ok: false, error: 'locked', message: LOCKED_MESSAGE });
      return;
    }
    if (req.method === 'GET' && route === '/ops/desk.css') {
      send(res, 200, DESK_CSS, 'text/css; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && route === '/ops/desk.js') {
      send(res, 200, DESK_JS, 'text/javascript; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && route === '/ops') {
      send(res, 200, pageHtml(''), 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && route === '/ops/snapshot') {
      snapshot(req, res);
      return;
    }
    if (req.method === 'POST' && route === '/ops/unlock') {
      await unlock(req, res);
      return;
    }
    if (req.method === 'POST' && route === '/ops/lock') {
      lock(req, res);
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method' });
  }

  function handle(req, res) {
    const route = routeOf(req);
    if (!route) {
      send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      return;
    }
    Promise.resolve().then(() => dispatch(req, res, route)).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: 'bad request' });
    });
  }

  return { accepts, handle, lockedMessage: LOCKED_MESSAGE };
}

module.exports = { createOps, LOCKED_MESSAGE };
