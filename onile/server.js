'use strict';
// Onile HTTP service. A separate process from the Kolopoly game.
// Payments, bank checks, transfers and refunds go through the same
// Paystack module and payout queue the game uses. This file does not
// import the game server. Secrets stay in the environment.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createPaystack, createPaymentStore } = require('../paystack');
const { createPayouts } = require('../payouts');
const { createAuth } = require('../auth');
const { createMailer } = require('../mailer');
const { createEscrow, clampPercent, normCode } = require('./escrow');
const { createOnileMail } = require('./mail');
const { createWinnerMail } = require('./winner-mail');

const PUBLIC = path.join(__dirname, 'public');
const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');
const DATA_DIR = process.env.ONILE_DATA_DIR || path.join(__dirname, '..', 'data', 'onile');
const PORT = Number(process.env.PORT) || 4180;
const HOST = process.env.ONILE_HOST || '0.0.0.0';
const PUBLIC_URL = String(process.env.ONILE_PUBLIC_URL || 'https://onile.kolopoly.fun').replace(/\/+$/, '');
const JOIN_MS = (Number(process.env.ONILE_JOIN_HOURS) || 24) * 60 * 60 * 1000;
const REPORT_MS = (Number(process.env.ONILE_REPORT_HOURS) || 24) * 60 * 60 * 1000;
const HOUSE = clampPercent(process.env.ONILE_HOUSE_PERCENT == null || process.env.ONILE_HOUSE_PERCENT === '' ? 10 : process.env.ONILE_HOUSE_PERCENT);

const TEST = process.env.KP_TEST === '1';
const auth = createAuth({});
const mailer = createMailer({});
if (auth.ephemeral) console.log('Onile sign-in uses a boot secret. Set KP_AUTH_SECRET so a Kolopoly account is the same person here.');
if (mailer.testMode) console.log('Sign-in mail uses the test transport. Set RESEND_API_KEY to send real codes.');
const pendingNames = new Map();

const paystack = createPaystack({});
const payments = createPaymentStore({ file: path.join(DATA_DIR, 'payments.json') });
const payouts = createPayouts({
  file: path.join(DATA_DIR, 'payouts.json'),
  paystack,
  payments,
  mode: process.env.KP_PAYOUT_MODE || 'manual'
});
const escrow = createEscrow({
  file: path.join(DATA_DIR, 'escrow.json'),
  housePercent: HOUSE,
  joinWindowMs: JOIN_MS,
  reportWindowMs: REPORT_MS
});
const onileMail = createOnileMail({});
if (onileMail.testMode) console.log('Winner mail uses the test transport. Set RESEND_API_KEY to email the house.');
const winnerMail = createWinnerMail({ mailer: onileMail, escrow, payouts, publicUrl: PUBLIC_URL });

const ADMIN_FAILS = new Map();
const LIMITS = new Map();
const BANK_TRIES = new Map();

function allow(key, max, windowMs) {
  const t = Date.now();
  const prev = (LIMITS.get(key) || []).filter((x) => t - x < windowMs);
  if (prev.length >= max) { LIMITS.set(key, prev); return false; }
  prev.push(t);
  LIMITS.set(key, prev);
  return true;
}
function clientIp(req) {
  const sock = req.socket && req.socket.remoteAddress || '';
  return String(sock).replace(/^::ffff:/, '').slice(0, 64) || 'unknown';
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('too-big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readRaw(req, 32 * 1024);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}
function json(res, status, body, extra) {
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extra || {});
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}
function cookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function displayName(v) {
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 40 || /[\u0000-\u001f]/.test(t)) return null;
  return t;
}
function bearerOf(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : '';
}
function sessionCookie(token) {
  const secure = PUBLIC_URL.startsWith('https://') ? '; Secure' : '';
  return 'onile_session=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000' + secure;
}
function currentPlayer(req) {
  const acct = auth.verifyToken(bearerOf(req) || cookies(req).onile_session || '');
  if (!acct) return null;
  const known = escrow.player(acct.accountId);
  return { id: acct.accountId, email: acct.email, name: known ? known.name : '' };
}
function adminToken() {
  const token = String(process.env.KP_ADMIN_TOKEN || '').trim();
  return token || null;
}
function tokenMatches(given) {
  const secret = adminToken() || '';
  const a = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(given == null ? '' : given), 'utf8').digest();
  return !!secret && crypto.timingSafeEqual(a, b);
}
function adminKey() {
  return crypto.createHash('sha256').update(adminToken() || '', 'utf8').digest();
}
function adminCookie() {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + 4 * 60 * 60 * 1000, v: 1 })).toString('base64url');
  const sig = crypto.createHmac('sha256', adminKey()).update(body).digest('base64url');
  return body + '.' + sig;
}
function adminOk(req) {
  if (!adminToken()) return false;
  const raw = cookies(req).onile_admin;
  if (!raw || !raw.includes('.')) return false;
  const i = raw.indexOf('.');
  const body = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = crypto.createHmac('sha256', adminKey()).update(body).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now();
  } catch (e) { return false; }
}
function adminSetCookie() {
  return 'onile_admin=' + adminCookie() + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400';
}
function queryHasSecret(url) {
  const keys = ['token', 'key', 'password', 'secret', 'kp_admin_token'];
  for (const key of keys) if (url.searchParams.has(key)) return true;
  return false;
}
function publish(ch, viewerId) {
  if (!ch) return null;
  const view = escrow.publicView(ch, viewerId);
  if (viewerId) {
    const mine = payouts.mine(viewerId);
    view.bank = mine.bank;
    view.payout = (mine.payouts || []).find((p) => p.roomCode === ch.code) || null;
  } else {
    view.bank = null;
    view.payout = null;
  }
  view.paymentsReady = !!paystack.enabled;
  return view;
}
function afterMoney(code, viewerId) {
  try { escrow.drain(code, payouts); } catch (e) { console.log('Onile payout queue could not take a row.'); }
  return publish(escrow.get(code), viewerId);
}
function applyOutcome(rec, outcome, via) {
  const result = escrow.recordPayment({
    code: rec.roomCode,
    playerId: rec.accountId,
    reference: rec.reference,
    amountKobo: Number(outcome.amountKobo) || 0,
    currency: outcome.currency || 'NGN',
    status: outcome.status
  });
  if (result.paid || result.queue) {
    payments.update(rec.reference, { status: 'paid', seat: result.paid ? 'held' : 'refund-due' }, { kind: result.paid ? 'settled' : 'refund', via });
    escrow.drain(rec.roomCode, payouts);
  }
  return result;
}
async function confirmReference(reference, via) {
  const rec = payments.get(reference);
  if (!rec) return { ok: false, error: 'unknown' };
  if (rec.status === 'paid') {
    escrow.drain(rec.roomCode, payouts);
    return { ok: true, duplicate: true, challenge: escrow.get(rec.roomCode) };
  }
  if (!paystack.enabled) return { ok: false, error: 'not-set-up' };
  payments.touch(reference);
  const v = await paystack.verify(reference);
  if (!v.ok) return { ok: false, error: 'verify' };
  return applyOutcome(rec, v, via);
}

function contentType(file) {
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.woff2')) return 'font/woff2';
  if (file.endsWith('.woff')) return 'font/woff';
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}
function sendFile(res, file, cache) {
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': contentType(file),
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (queryHasSecret(url)) { json(res, 400, { ok: false, error: 'query', message: 'Put the desk key in the form, not the address.' }); return; }
  const pathname = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;

  if (pathname === '/api/health' && req.method === 'GET') {
    json(res, 200, { ok: true, service: 'onile', payments: !!paystack.enabled, payoutMode: process.env.KP_PAYOUT_MODE === 'auto' ? 'auto' : 'manual', housePercent: HOUSE });
    return;
  }
  if (pathname === '/api/config' && req.method === 'GET') {
    json(res, 200, { ok: true, housePercent: HOUSE, payments: !!paystack.enabled, payouts: !!paystack.enabled, payoutMode: process.env.KP_PAYOUT_MODE === 'auto' ? 'auto' : 'manual' });
    return;
  }
  if (pathname === '/api/me' && req.method === 'GET') {
    const player = currentPlayer(req);
    json(res, player ? 200 : 401, player ? { ok: true, player } : { ok: false, error: 'auth', message: 'Sign in with your email first.' });
    return;
  }
  if (pathname === '/api/auth/request' && req.method === 'POST') {
    (async () => {
      if (mailer.testMode && !TEST) {
        json(res, 503, { ok: false, error: 'mail', message: 'Sign-in mail never set up yet. Nothing was sent. Try again.' });
        return;
      }
      if (!allow('auth:' + clientIp(req), 30, 60 * 60 * 1000)) {
        json(res, 429, { ok: false, error: 'rate', message: 'Too many sign-in codes from this network. Wait small, then try again.' });
        return;
      }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body', message: 'That request was not valid.' }); return; }
      const name = displayName(body && body.name);
      if (!name) { json(res, 400, { ok: false, error: 'name', message: 'Enter a display name (2 to 40 characters).' }); return; }
      const out = auth.requestCode(body && body.email);
      if (!out.ok) { json(res, out.error === 'rate' ? 429 : 400, { ok: false, error: out.error, message: out.message }); return; }
      pendingNames.set(out.email, { name, at: Date.now() });
      const sent = await mailer.sendCode(out.email, out.code, { product: 'Onile' });
      if (!sent.ok) { json(res, mailer.testMode ? 503 : 502, { ok: false, error: 'mail', message: (sent && sent.message) || 'The code no send. Nothing was sent. Try again.' }); return; }
      const reply = { ok: true };
      if (TEST && mailer.testMode) reply.devCode = out.code;
      json(res, 200, reply);
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/auth/verify' && req.method === 'POST') {
    (async () => {
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body', message: 'That request was not valid.' }); return; }
      const email = auth.cleanEmail(body && body.email);
      const pending = email && pendingNames.get(email);
      const name = displayName(body && body.name) || (pending && Date.now() - pending.at < 10 * 60 * 1000 ? pending.name : null);
      if (!name) { json(res, 400, { ok: false, error: 'name', message: 'Enter a display name (2 to 40 characters).' }); return; }
      const out = auth.verifyCode(body && body.email, body && body.code);
      if (!out.ok) { json(res, 400, { ok: false, error: out.error, message: out.message }); return; }
      const who = escrow.upsertPlayer({ accountId: out.accountId, email: out.email, name });
      if (!who.ok) { json(res, 400, who); return; }
      if (email) pendingNames.delete(email);
      json(res, 200, { ok: true, token: out.token, player: who.player }, { 'Set-Cookie': sessionCookie(out.token) });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/challenges' && req.method === 'POST') {
    (async () => {
      if (!allow('create:' + clientIp(req), 20, 60 * 60 * 1000)) { json(res, 429, { ok: false, error: 'rate', message: 'Too many challenges from here. Wait a bit.' }); return; }
      const player = currentPlayer(req);
      if (!player) { json(res, 401, { ok: false, error: 'auth', message: 'Sign in with your email first.' }); return; }
      if (!player.name) { json(res, 409, { ok: false, error: 'name', message: 'Add a display name, then open the challenge.' }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body', message: 'That request was not valid.' }); return; }
      const made = escrow.create({
        playerId: player.id,
        title: body.title,
        activity: body.activity,
        rules: body.rules,
        stakeNaira: body.stakeNaira,
        deadline: body.deadline,
        maxPlayers: body.maxPlayers
      });
      if (!made.ok) { json(res, 400, made); return; }
      json(res, 200, { ok: true, challenge: publish(made.challenge, player.id) });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/challenges/join' && req.method === 'POST') {
    (async () => {
      const player = currentPlayer(req);
      if (!player) { json(res, 401, { ok: false, error: 'auth', message: 'Sign in with your email first.' }); return; }
      if (!player.name) { json(res, 409, { ok: false, error: 'name', message: 'Add a display name, then join.' }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body', message: 'That request was not valid.' }); return; }
      const joined = escrow.join({ code: body.code, playerId: player.id });
      if (!joined.ok) { json(res, joined.error === 'unknown' ? 404 : 400, joined); return; }
      json(res, 200, { ok: true, challenge: publish(joined.challenge, player.id) });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  const startRoute = pathname.match(/^\/api\/challenges\/([A-Za-z0-9]+)\/start$/);
  if (startRoute && req.method === 'POST') {
    const player = currentPlayer(req);
    if (!player) { json(res, 401, { ok: false, error: 'auth', message: 'Sign in first.' }); return; }
    const result = escrow.start({ code: startRoute[1], playerId: player.id });
    if (!result.ok) { json(res, result.error === 'unknown' ? 404 : 400, { ok: false, error: result.error, message: result.message }); return; }
    json(res, 200, { ok: true, challenge: afterMoney(normCode(startRoute[1]), player.id) });
    return;
  }
  const cancelRoute = pathname.match(/^\/api\/challenges\/([A-Za-z0-9]+)\/cancel$/);
  if (cancelRoute && req.method === 'POST') {
    const player = currentPlayer(req);
    if (!player) { json(res, 401, { ok: false, error: 'auth', message: 'Sign in first.' }); return; }
    const result = escrow.cancel({ code: cancelRoute[1], playerId: player.id });
    if (!result.ok) { json(res, result.error === 'unknown' ? 404 : 400, { ok: false, error: result.error, message: result.message }); return; }
    json(res, 200, { ok: true, challenge: afterMoney(normCode(cancelRoute[1]), player.id) });
    return;
  }
  if (pathname === '/api/challenges/mine' && req.method === 'GET') {
    const player = currentPlayer(req);
    if (!player) { json(res, 401, { ok: false, error: 'auth', message: 'Sign in first.' }); return; }
    const rows = escrow.mine(player.id);
    for (const code of rows.map((r) => r.code)) escrow.drain(code, payouts);
    json(res, 200, { ok: true, challenges: escrow.mine(player.id) });
    return;
  }
  const one = pathname.match(/^\/api\/challenges\/([A-Za-z0-9]+)$/);
  if (one && req.method === 'GET') {
    const ch = escrow.get(one[1]);
    if (!ch) { json(res, 404, { ok: false, error: 'unknown', message: 'No challenge with that code.' }); return; }
    const player = currentPlayer(req);
    json(res, 200, { ok: true, challenge: afterMoney(ch.code, player && player.id) });
    return;
  }
  const payRoute = pathname.match(/^\/api\/challenges\/([A-Za-z0-9]+)\/pay$/);
  if (payRoute && req.method === 'POST') {
    (async () => {
      const player = currentPlayer(req);
      if (!player) { json(res, 401, { ok: false, error: 'auth', message: 'Sign in first.' }); return; }
      if (!allow('pay:' + player.id, 12, 60 * 60 * 1000)) { json(res, 429, { ok: false, error: 'rate', message: 'Too many payment attempts. Wait a bit.' }); return; }
      const ch = escrow.get(payRoute[1]);
      if (!ch) { json(res, 404, { ok: false, error: 'unknown', message: 'No challenge with that code.' }); return; }
      const seat = (ch.players || []).find((p) => p.id === player.id);
      if (!seat) { json(res, 403, { ok: false, error: 'player', message: 'You are not in this challenge.' }); return; }
      if (seat.paid) { json(res, 200, { ok: true, alreadyPaid: true, challenge: publish(ch, player.id) }); return; }
      if (ch.status !== 'open' && ch.status !== 'joined') { json(res, 400, { ok: false, error: 'state', message: 'This challenge is not taking payments.' }); return; }
      if (!paystack.enabled) { json(res, 503, { ok: false, error: 'not-set-up', message: 'Payments are not set up on this host yet.' }); return; }
      const existing = payments.findPending(ch.code, player.id);
      if (existing && existing.authorizationUrl) {
        if (Date.now() - existing.createdAt > 20000) {
          const looked = await confirmReference(existing.reference, 'reopen');
          const fresh = payments.get(existing.reference);
          if (fresh && fresh.status === 'paid') { json(res, 200, { ok: true, alreadyPaid: true, challenge: publish(escrow.get(ch.code), player.id) }); return; }
          if (fresh && fresh.status === 'pending' && Date.now() - existing.createdAt < 20 * 60 * 1000) {
            json(res, 200, { ok: true, reference: existing.reference, authorizationUrl: existing.authorizationUrl });
            return;
          }
          if (fresh && fresh.status === 'pending') payments.update(existing.reference, { status: 'failed' }, { kind: 'replaced', via: 'reopen' });
        } else {
          json(res, 200, { ok: true, reference: existing.reference, authorizationUrl: existing.authorizationUrl });
          return;
        }
      }
      const reference = 'onile' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
      const init = await paystack.initialize({
        email: player.email,
        amountKobo: ch.stakeKobo,
        reference,
        callbackUrl: PUBLIC_URL + '/c/' + ch.code,
        metadata: { product: 'onile', code: ch.code, playerId: player.id }
      });
      if (!init.ok) { json(res, 502, { ok: false, error: 'initialize', message: init.message || 'Paystack could not open the payment.' }); return; }
      payments.create({
        reference,
        roomCode: ch.code,
        playerId: 1,
        accountId: player.id,
        email: player.email,
        amountKobo: ch.stakeKobo,
        authorizationUrl: init.authorizationUrl
      });
      json(res, 200, { ok: true, reference, authorizationUrl: init.authorizationUrl });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  const reportRoute = pathname.match(/^\/api\/challenges\/([A-Za-z0-9]+)\/report$/);
  if (reportRoute && req.method === 'POST') {
    (async () => {
      const player = currentPlayer(req);
      if (!player) { json(res, 401, { ok: false, error: 'auth', message: 'Sign in first.' }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body', message: 'That request was not valid.' }); return; }
      const result = escrow.report({ code: reportRoute[1], playerId: player.id, winnerId: body.winnerId, winnerRole: body.winnerRole });
      if (!result.ok && !result.challenge) { json(res, result.error === 'unknown' ? 404 : 400, result); return; }
      if (!result.ok) { json(res, 400, { ok: false, error: result.error, message: result.message }); return; }
      if (result.queue) winnerMail.kick();
      json(res, 200, { ok: true, challenge: afterMoney(normCode(reportRoute[1]), player.id) });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/payments/status' && req.method === 'GET') {
    (async () => {
      const reference = url.searchParams.get('reference') || '';
      const rec = payments.get(reference);
      if (!rec) { json(res, 404, { ok: false, error: 'unknown', message: 'That payment is not one of ours.' }); return; }
      if (rec.status === 'pending') await confirmReference(reference, 'verify');
      const fresh = payments.get(reference);
      const player = currentPlayer(req);
      json(res, 200, {
        ok: true,
        reference,
        status: fresh.status,
        challenge: publish(escrow.get(fresh.roomCode), player && player.id)
      });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/banks' && req.method === 'GET') {
    (async () => {
      const player = currentPlayer(req);
      if (!player) { json(res, 401, { ok: false, error: 'auth', message: 'Sign in first.' }); return; }
      if (!paystack.enabled) { json(res, 503, { ok: false, error: 'not-set-up', message: 'Payouts are not set up on this host yet.' }); return; }
      const out = await paystack.listBanks();
      if (!out.ok) { json(res, 502, { ok: false, error: 'banks', message: 'The bank list did not load. Try again.' }); return; }
      json(res, 200, { ok: true, banks: out.banks });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/bank' && req.method === 'POST') {
    (async () => {
      const player = currentPlayer(req);
      if (!player) { json(res, 401, { ok: false, error: 'auth', message: 'Sign in first.' }); return; }
      const t = BANK_TRIES.get(player.id) || { n: 0, until: Date.now() + 10 * 60 * 1000 };
      if (Date.now() > t.until) { t.n = 0; t.until = Date.now() + 10 * 60 * 1000; }
      t.n += 1;
      BANK_TRIES.set(player.id, t);
      if (t.n > 6) { json(res, 429, { ok: false, error: 'rate', message: 'Too many tries. Wait, then try again.' }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body', message: 'That request was not valid.' }); return; }
      const out = await payouts.setBank({ accountId: player.id }, body || {});
      json(res, out.ok ? 200 : (out.status || 400), out.ok ? { ok: true, bank: out.bank } : { ok: false, error: out.error, message: out.message });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/payouts/collect' && req.method === 'POST') {
    (async () => {
      const player = currentPlayer(req);
      if (!player) { json(res, 401, { ok: false, error: 'auth', message: 'Sign in first.' }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body', message: 'That request was not valid.' }); return; }
      const out = await payouts.collect(player.id, body || {});
      json(res, out.ok ? 200 : (out.status || 400), out);
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/paystack/webhook' && req.method === 'POST') {
    readRaw(req, 256 * 1024).then(async (raw) => {
      if (!paystack.verifySignature(raw, req.headers['x-paystack-signature'])) {
        json(res, 401, { ok: false, error: 'signature' });
        return;
      }
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch (e) { json(res, 400, { ok: false, error: 'body' }); return; }
      const event = String((body && body.event) || '');
      if (event === 'charge.success' && body.data && body.data.reference) {
        const reference = String(body.data.reference);
        const rec = payments.get(reference);
        if (rec && rec.status !== 'paid') {
          let outcome = { status: body.data.status, amountKobo: Number(body.data.amount) || 0, currency: body.data.currency };
          if (paystack.enabled) {
            const v = await paystack.verify(reference);
            if (v.ok) outcome = { status: v.status, amountKobo: v.amountKobo, currency: v.currency };
          }
          applyOutcome(rec, outcome, 'webhook');
        }
      } else if (/^(transfer|refund)\./.test(event)) {
        payouts.onWebhook(event, body.data || {});
      }
      if (!res.headersSent) json(res, 200, { ok: true });
    }).catch(() => { if (!res.headersSent) json(res, 400, { ok: false }); });
    return;
  }

  if (pathname === '/api/admin/unlock' && req.method === 'POST') {
    (async () => {
      if (!adminToken()) { json(res, 503, { ok: false, error: 'locked', message: 'Admin locked until KP_ADMIN_TOKEN is set' }); return; }
      const ip = clientIp(req);
      const fail = ADMIN_FAILS.get(ip) || { n: 0, until: Date.now() + 15 * 60 * 1000 };
      if (Date.now() > fail.until) { fail.n = 0; fail.until = Date.now() + 15 * 60 * 1000; }
      if (fail.n >= 5) { json(res, 429, { ok: false, error: 'rate', message: 'Too many tries. Wait, then try again.' }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body' }); return; }
      if (!tokenMatches(body && body.token)) {
        fail.n += 1;
        ADMIN_FAILS.set(ip, fail);
        json(res, 401, { ok: false, error: 'auth', message: 'That key does not open the desk.' });
        return;
      }
      ADMIN_FAILS.delete(ip);
      json(res, 200, { ok: true }, { 'Set-Cookie': adminSetCookie() });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/admin/lock' && req.method === 'POST') {
    json(res, 200, { ok: true }, { 'Set-Cookie': 'onile_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return;
  }
  function payoutCard(p) {
    return {
      id: p.id, kind: p.kind, roomCode: p.roomCode, amountKobo: p.amountKobo,
      status: p.status, name: p.name, note: p.note || null, bank: p.bank || null,
      updatedAt: p.updatedAt, createdAt: p.createdAt
    };
  }
  function paymentCard(rec) {
    return {
      reference: rec.reference, code: rec.roomCode, amountKobo: rec.amountKobo,
      status: rec.status, createdAt: rec.createdAt, email: rec.email || null, accountId: rec.accountId || null
    };
  }
  const PAYOUT_DONE = new Set(['paid', 'paid-manual', 'refunded', 'refunded-manual']);
  if (pathname === '/api/admin/queue' && req.method === 'GET') {
    if (!adminToken()) { json(res, 503, { ok: false, error: 'locked', message: 'Admin locked until KP_ADMIN_TOKEN is set' }); return; }
    if (!adminOk(req)) { json(res, 401, { ok: false, error: 'auth', message: 'Open the desk first.' }); return; }
    const overview = escrow.overview();
    for (const row of overview.challenges) {
      if (row.bucket === 'disputes' || row.bucket === 'settled') escrow.drain(row.code, payouts);
    }
    const fresh = escrow.overview();
    const money = payouts.view();
    const payoutRows = money.payouts.map(payoutCard);
    let payoutsPending = 0;
    let payoutsPendingKobo = 0;
    let payoutsPaidKobo = 0;
    for (const row of payoutRows) {
      if (PAYOUT_DONE.has(row.status) || row.status === 'test') {
        if (row.status !== 'test') payoutsPaidKobo += row.amountKobo || 0;
      } else {
        payoutsPending += 1;
        payoutsPendingKobo += row.amountKobo || 0;
      }
    }
    json(res, 200, {
      ok: true,
      housePercent: HOUSE,
      payoutMode: money.mode,
      stats: Object.assign({}, fresh.stats, { payoutsPending, payoutsPendingKobo, payoutsPaidKobo }),
      challenges: fresh.challenges,
      users: fresh.users,
      payments: payments.list().map(paymentCard).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      payouts: payoutRows
    });
    return;
  }
  if (pathname === '/api/admin/cancel' && req.method === 'POST') {
    (async () => {
      if (!adminOk(req)) { json(res, 401, { ok: false, error: 'auth', message: 'Open the desk first.' }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body' }); return; }
      const result = escrow.cancel({ code: body.code, admin: true, playerId: 'admin' });
      if (!result.ok) { json(res, result.error === 'unknown' ? 404 : 400, { ok: false, error: result.error, message: result.message }); return; }
      escrow.drain(normCode(body.code), payouts);
      json(res, 200, { ok: true, challenge: escrow.adminView(escrow.get(body.code)) });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/admin/decide' && req.method === 'POST') {
    (async () => {
      if (!adminOk(req)) { json(res, 401, { ok: false, error: 'auth', message: 'Open the desk first.' }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body' }); return; }
      const result = escrow.decide({ code: body.code, winnerId: body.winnerId, note: body.note, actor: 'admin' });
      if (!result.ok) { json(res, result.error === 'unknown' ? 404 : 400, { ok: false, error: result.error, message: result.message }); return; }
      escrow.drain(normCode(body.code), payouts);
      if (result.queue) winnerMail.kick();
      json(res, 200, { ok: true, challenge: escrow.adminView(escrow.get(body.code)) });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/admin/resolve' && req.method === 'POST') {
    (async () => {
      if (!adminOk(req)) { json(res, 401, { ok: false, error: 'auth', message: 'Open the desk first.' }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body' }); return; }
      const result = escrow.resolve({
        code: body.code,
        action: body.action,
        winnerId: body.winnerId,
        winnerRole: body.winnerRole,
        note: body.note,
        actor: 'admin'
      });
      if (!result.ok) { json(res, result.error === 'unknown' ? 404 : 400, { ok: false, error: result.error, message: result.message }); return; }
      const view = afterMoney(normCode(body.code), null);
      if (result.queue && body.action === 'winner') winnerMail.kick();
      json(res, 200, { ok: true, challenge: escrow.adminView(escrow.get(body.code)) , public: view });
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/admin/payouts/send' && req.method === 'POST') {
    (async () => {
      if (!adminOk(req)) { json(res, 401, { ok: false, error: 'auth', message: 'Open the desk first.' }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body' }); return; }
      const out = await payouts.send(String(body.id || ''), 'desk');
      json(res, out.ok ? 200 : 400, out);
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }
  if (pathname === '/api/admin/payouts/manual' && req.method === 'POST') {
    (async () => {
      if (!adminOk(req)) { json(res, 401, { ok: false, error: 'auth', message: 'Open the desk first.' }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { ok: false, error: 'body' }); return; }
      const out = payouts.markManual(String(body.id || ''), body.note || 'paid by hand');
      json(res, out.ok ? 200 : 400, out);
    })().catch(() => { if (!res.headersSent) json(res, 500, { ok: false }); });
    return;
  }

  if (pathname.startsWith('/fonts/')) {
    const base = path.basename(pathname);
    if (!/^[\w.-]+$/.test(base)) { res.writeHead(404); res.end(); return; }
    sendFile(res, path.join(FONT_DIR, base), 'public, max-age=604800');
    return;
  }
  if (pathname === '/style.css' || pathname === '/app.js') {
    sendFile(res, path.join(PUBLIC, pathname.slice(1)), 'no-cache');
    return;
  }
  if (pathname.startsWith('/api/')) { json(res, 404, { ok: false, error: 'unknown' }); return; }
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  if (pathname === '/admin') headers['X-Robots-Tag'] = 'noindex';
  res.writeHead(200, headers);
  res.end(fs.readFileSync(path.join(PUBLIC, 'index.html')));
});

function sweep() {
  try {
    for (const code of escrow.tickAll()) escrow.drain(code, payouts);
    winnerMail.kick();
  } catch (e) { /* next sweep */ }
  if (!paystack.enabled) return;
  payments.pendingOlderThan(Number(process.env.KP_SWEEP_AGE_MS) || 60000).slice(0, 5).forEach((rec) => {
    confirmReference(rec.reference, 'sweep').catch(() => {});
  });
  payouts.sweep(Number(process.env.KP_SWEEP_AGE_MS) || 60000).catch(() => {});
}
const timer = setInterval(sweep, Number(process.env.KP_SWEEP_INTERVAL_MS) || 30000);
if (timer.unref) timer.unref();

server.listen(PORT, HOST, () => {
  winnerMail.kick();
  console.log('Onile listening on ' + HOST + ':' + PORT + ' (house ' + HOUSE + '%, payouts ' + (process.env.KP_PAYOUT_MODE === 'auto' ? 'auto' : 'manual') + ').');
  console.log(paystack.enabled
    ? 'Paystack is set up. Payments settle from the signed webhook, verify calls, and the reconcile sweep.'
    : 'Paystack is not set up on this host (no secret key). Challenges can be opened; payments cannot be collected.');
});
