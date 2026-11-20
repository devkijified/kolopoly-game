'use strict';
// Paystack, server side only. The secret key comes from the
// environment (PAYSTACK_SECRET_KEY) and never appears in code, in a
// response, or in a log. Without it the module reports enabled: false
// and the host keeps paid payments in their not-set-up state.
// Money settles from exactly three witnesses, all verified here or by
// signature: the webhook (HMAC SHA512 over the raw body), a verify
// call after the player returns, and the reconcile sweep for payments
// that stayed pending. All three feed one settle function in the
// server; this module only talks to Paystack and keeps the records.
// The API base can be overridden with PAYSTACK_API_BASE, which is how
// the test suite stands a stub Paystack in front of the real code.
const crypto = require('crypto');
const path = require('path');
function nodeFs() { return require('fs'); }

function createPaystack(opts) {
  opts = opts || {};
  const secret = opts.secretKey != null ? String(opts.secretKey).trim() : String(process.env.PAYSTACK_SECRET_KEY || '').trim();
  const base = String(opts.apiBase || process.env.PAYSTACK_API_BASE || 'https://api.paystack.co').replace(/\/+$/, '');
  const enabled = !!secret;

  async function call(method, route, body) {
    const res = await fetch(base + route, {
      method,
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { httpOk: !!res.ok, data };
  }

  // Open a transaction for one seat. Amount is kobo, always computed
  // server-side from the ladder fee, never taken from the client.
  async function initialize(info) {
    if (!enabled) return { ok: false, error: 'not-set-up', message: 'Payments never set up yet.' };
    try {
      const out = await call('POST', '/transaction/initialize', {
        email: info.email,
        amount: info.amountKobo,
        reference: info.reference,
        metadata: info.metadata || {},
        callback_url: info.callbackUrl
      });
      const d = out.data && out.data.data;
      if (!out.httpOk || !out.data || out.data.status !== true || !d || !d.authorization_url) {
        return { ok: false, error: 'initialize', message: 'Paystack no open the payment. Try again.' };
      }
      return { ok: true, authorizationUrl: d.authorization_url, reference: d.reference || info.reference };
    } catch (e) {
      return { ok: false, error: 'initialize', message: 'Paystack no answer. Try again.' };
    }
  }

  // Ask Paystack directly what a transaction did. This is the witness
  // behind verify-on-return and the reconcile sweep.
  async function verify(reference) {
    if (!enabled) return { ok: false, error: 'not-set-up' };
    try {
      const out = await call('GET', '/transaction/verify/' + encodeURIComponent(reference));
      const d = out.data && out.data.data;
      if (!out.httpOk || !d) return { ok: false, error: 'verify' };
      return { ok: true, status: String(d.status || ''), amountKobo: Number(d.amount) || 0, reference: d.reference || reference };
    } catch (e) {
      return { ok: false, error: 'verify' };
    }
  }

  // The webhook signature: HMAC SHA512 of the exact raw body, hex,
  // compared in constant time. Anything else is not from Paystack.
  function verifySignature(rawBody, signature) {
    if (!enabled || !signature) return false;
    const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  return { enabled, initialize, verify, verifySignature };
}

// The payment records: one row per seat payment attempt, keyed by the
// Paystack reference. Status moves pending -> paid | failed (and a
// refund would mark refunded from the desk side later). Every settle
// witness appends an event, so the record shows how a payment landed.
// Same JSON file pattern as the competition settings; memory mode
// serves tests and hosts that keep their own copy.
function createPaymentStore(opts) {
  opts = opts || {};
  const memory = !!opts.memory;
  const file = memory ? null : (opts.file || path.join(__dirname, 'data', 'payments.json'));
  let records = new Map();
  let saveWarned = false;

  function load() {
    if (memory) return;
    const fs = nodeFs();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) for (const r of parsed) if (r && r.reference) records.set(r.reference, r);
    } catch (e) {
      if (e.code !== 'ENOENT') console.log('Payment store started empty.');
    }
  }
  function save() {
    if (memory) return;
    const fs = nodeFs();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...records.values()]));
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!saveWarned) {
        saveWarned = true;
        console.log('Payment store could not be saved.');
      }
    }
  }
  load();

  function create(info) {
    const rec = {
      reference: String(info.reference),
      roomCode: String(info.roomCode || ''),
      playerId: info.playerId == null ? null : Number(info.playerId),
      accountId: info.accountId || null,
      email: info.email || null,
      cityId: info.cityId || null,
      amountKobo: Number(info.amountKobo) || 0,
      status: 'pending',
      authorizationUrl: info.authorizationUrl || null,
      events: [{ at: Date.now(), kind: 'created', via: info.via || 'initialize' }],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    records.set(rec.reference, rec);
    save();
    return rec;
  }
  function get(reference) {
    return records.get(String(reference)) || null;
  }
  function findPending(roomCode, accountId) {
    for (const r of records.values()) {
      if (r.status === 'pending' && r.roomCode === roomCode && r.accountId === accountId) return r;
    }
    return null;
  }
  function update(reference, patch, event) {
    const rec = get(reference);
    if (!rec) return null;
    Object.assign(rec, patch || {});
    rec.updatedAt = Date.now();
    if (event) rec.events.push(Object.assign({ at: Date.now() }, event));
    save();
    return rec;
  }
  function pendingOlderThan(ms) {
    const cut = Date.now() - ms;
    return [...records.values()].filter((r) => r.status === 'pending' && r.createdAt <= cut);
  }
  function list() {
    return [...records.values()];
  }
  return { create, get, findPending, update, pendingOlderThan, list };
}

module.exports = { createPaystack, createPaymentStore };
