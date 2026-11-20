'use strict';
// Email sign-in for paid play. Free play stays name-only and never
// touches this module; an account exists so a paying player's money,
// payments and prizes stay attached to them and reclaimable on any
// device with the same email.
// The flow is three steps: request a 6 digit code (sent by the mailer
// seam), verify the code, carry the signed session token the server
// issues. Codes live 10 minutes, allow 5 attempts, and are rate
// limited per email. The account id is derived from the email itself,
// so the same email always lands on the same account with no account
// store to lose.
// The session secret is KP_AUTH_SECRET from the environment. Without
// it, an ephemeral secret is generated at boot: sign-in still works,
// but every restart signs everybody out, which the boot log says.
const crypto = require('crypto');

const CODE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_GAP_MS = 30 * 1000;
const SENDS_PER_HOUR = 5;
const TOKEN_MS = 30 * 24 * 60 * 60 * 1000;

function cleanEmail(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s.length > 120) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}
function accountIdFor(email) {
  return 'a_' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 20);
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(s) {
  const b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64');
}

function createAuth(opts) {
  opts = opts || {};
  const secret = opts.secret || process.env.KP_AUTH_SECRET || crypto.randomBytes(32).toString('hex');
  const ephemeral = !opts.secret && !process.env.KP_AUTH_SECRET;
  const codes = new Map(); // email -> {hash, expiresAt, attempts, lastSentAt, sends: []}

  function mac(data) {
    return crypto.createHmac('sha256', secret).update(data).digest();
  }
  function issueToken(email) {
    const payload = { a: accountIdFor(email), e: email, exp: Date.now() + TOKEN_MS };
    const body = b64url(JSON.stringify(payload));
    return body + '.' + b64url(mac(body));
  }
  function verifyToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const expected = mac(parts[0]);
    let given;
    try { given = b64urlDecode(parts[1]); } catch (e) { return null; }
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let payload;
    try { payload = JSON.parse(b64urlDecode(parts[0]).toString('utf8')); } catch (e) { return null; }
    if (!payload || !payload.a || !payload.e || !payload.exp || payload.exp < Date.now()) return null;
    if (payload.a !== accountIdFor(payload.e)) return null;
    return { accountId: payload.a, email: payload.e };
  }

  // Generate and store a code for the email. The code itself returns
  // to the caller (the server) only so it can hand it to the mailer;
  // it never goes in an API response except the documented test hook.
  function requestCode(rawEmail) {
    const email = cleanEmail(rawEmail);
    if (!email) return { ok: false, error: 'email', message: 'That email no look right. Check am and try again.' };
    const now = Date.now();
    const prev = codes.get(email);
    if (prev && now - prev.lastSentAt < RESEND_GAP_MS) {
      return { ok: false, error: 'rate', message: 'Wait small before you ask for another code.' };
    }
    const sends = (prev ? prev.sends : []).filter((t) => now - t < 60 * 60 * 1000);
    if (sends.length >= SENDS_PER_HOUR) {
      return { ok: false, error: 'rate', message: 'Too many codes for this email. Wait an hour and try again.' };
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const hash = crypto.createHash('sha256').update(email + ':' + code).digest('hex');
    codes.set(email, { hash, expiresAt: now + CODE_MS, attempts: 0, lastSentAt: now, sends: sends.concat(now) });
    return { ok: true, email, code };
  }

  function verifyCode(rawEmail, rawCode) {
    const email = cleanEmail(rawEmail);
    if (!email) return { ok: false, error: 'email', message: 'That email no look right. Check am and try again.' };
    const rec = codes.get(email);
    if (!rec) return { ok: false, error: 'code', message: 'No code dey wait for this email. Ask for a new code.' };
    if (Date.now() > rec.expiresAt) {
      codes.delete(email);
      return { ok: false, error: 'code', message: 'That code don expire. Ask for a new code.' };
    }
    if (rec.attempts >= MAX_ATTEMPTS) {
      codes.delete(email);
      return { ok: false, error: 'code', message: 'Too many wrong tries. Ask for a new code.' };
    }
    const hash = crypto.createHash('sha256').update(email + ':' + String(rawCode || '').trim()).digest('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(rec.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      rec.attempts += 1;
      return { ok: false, error: 'code', message: 'That code no correct. Check am and try again.' };
    }
    codes.delete(email);
    return { ok: true, email, accountId: accountIdFor(email), token: issueToken(email) };
  }

  return { requestCode, verifyCode, verifyToken, accountIdFor, cleanEmail, ephemeral };
}

module.exports = { createAuth, cleanEmail, accountIdFor };
