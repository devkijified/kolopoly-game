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
  // Per attempt limit. 12 seconds in production; the suite shortens it
  // with PAYSTACK_TIMEOUT_MS to prove the timeout and retry quickly.
  const timeoutMs = Number(opts.timeoutMs || process.env.PAYSTACK_TIMEOUT_MS) || 12000;

  async function call(method, route, body) {
    // A stalled connection must never hold a player's tap hostage:
    // each attempt gets 12 seconds, and a network failure (no response
    // at all) earns exactly one retry. An HTTP response, good or bad,
    // is always final.
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(base + route, {
          method,
          headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs)
        });
        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        return { httpOk: !!res.ok, data };
      } catch (e) {
        lastErr = e;
        console.log('Paystack call failed (' + method + ' ' + route + ', attempt ' + (attempt + 1) + '): ' + (e && e.name ? e.name : 'error'));
      }
    }
    throw lastErr || new Error('paystack unreachable');
  }

  // Open a transaction for one seat. Amount is kobo, always computed
  // server-side from the ladder fee, never taken from the client.
  async function initialize(info) {
    if (!enabled) return { ok: false, error: 'not-set-up', message: 'Payments never set up yet.' };
    try {
      const out = await call('POST', '/transaction/initialize', {
        email: info.email,
        amount: info.amountKobo,
        currency: 'NGN',
        reference: info.reference,
        metadata: info.metadata || {},
        callback_url: info.callbackUrl
      });
      const d = out.data && out.data.data;
      if (!out.httpOk || !out.data || out.data.status !== true || !d || !d.authorization_url) {
        console.log('Paystack initialize refused: ' + (out.data && out.data.message ? out.data.message : 'no message'));
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
      return {
        ok: true,
        status: String(d.status || ''),
        channel: String(d.channel || ''),
        amountKobo: Number(d.amount) || 0,
        currency: String(d.currency || 'NGN').toUpperCase(),
        reference: d.reference || reference
      };
    } catch (e) {
      return { ok: false, error: 'verify' };
    }
  }

  // ---- Payouts: banks, recipients, transfers and refunds -------------
  // Transfers (prizes to the winner's bank) need a Paystack business
  // that is verified and has transfers switched on, plus a funded
  // balance. Refunds go back to the payer's card or bank and work on
  // any live business. Every call here is idempotent by reference on
  // Paystack's side, so the one network retry above can never send
  // the same money twice.
  let bankCache = { at: 0, banks: null };
  async function listBanks() {
    if (!enabled) return { ok: false, error: 'not-set-up' };
    if (bankCache.banks && Date.now() - bankCache.at < 6 * 3600 * 1000) return { ok: true, banks: bankCache.banks };
    try {
      const out = await call('GET', '/bank?country=nigeria&currency=NGN&perPage=100');
      const list = out.data && Array.isArray(out.data.data) ? out.data.data : null;
      if (!out.httpOk || !list) return { ok: false, error: 'banks' };
      const banks = list.filter((b) => b && b.code && b.name && b.active !== false && !b.is_deleted)
        .map((b) => ({ code: String(b.code), name: String(b.name) }));
      bankCache = { at: Date.now(), banks };
      return { ok: true, banks };
    } catch (e) {
      return { ok: false, error: 'banks' };
    }
  }
  async function resolveAccount(accountNumber, bankCode) {
    if (!enabled) return { ok: false, error: 'not-set-up' };
    try {
      const out = await call('GET', '/bank/resolve?account_number=' + encodeURIComponent(accountNumber) + '&bank_code=' + encodeURIComponent(bankCode));
      const d = out.data && out.data.data;
      if (!out.httpOk || !d || !d.account_name) return { ok: false, error: 'resolve', message: 'That account number no match the bank. Check am again.' };
      return { ok: true, accountName: String(d.account_name), accountNumber: String(d.account_number || accountNumber) };
    } catch (e) {
      return { ok: false, error: 'resolve', message: 'The bank check no answer. Try again.' };
    }
  }
  async function createRecipient(info) {
    if (!enabled) return { ok: false, error: 'not-set-up' };
    try {
      const out = await call('POST', '/transferrecipient', {
        type: 'nuban', name: info.name, account_number: info.accountNumber, bank_code: info.bankCode, currency: 'NGN'
      });
      const d = out.data && out.data.data;
      if (!out.httpOk || !d || !d.recipient_code) return { ok: false, error: 'recipient', message: (out.data && out.data.message) || 'Paystack no save the bank.' };
      return { ok: true, recipientCode: String(d.recipient_code) };
    } catch (e) {
      return { ok: false, error: 'recipient', message: 'Paystack no answer. Try again.' };
    }
  }
  // One transfer from the Paystack balance. Status comes back as
  // success, pending, otp (the dashboard still asks for an OTP on
  // every transfer) or failed; anything else reads as pending and the
  // sweep asks again by reference.
  async function transfer(info) {
    if (!enabled) return { ok: false, error: 'not-set-up', message: 'Payments never set up yet.' };
    try {
      const out = await call('POST', '/transfer', {
        source: 'balance', amount: info.amountKobo, recipient: info.recipientCode,
        reference: info.reference, reason: info.reason || 'Kolopoly prize', currency: 'NGN'
      });
      const d = out.data && out.data.data;
      if (!out.httpOk || !out.data || out.data.status !== true || !d) {
        return { ok: false, error: 'transfer', message: (out.data && out.data.message) || 'Paystack refuse the transfer.' };
      }
      return { ok: true, status: String(d.status || 'pending'), transferCode: d.transfer_code || null };
    } catch (e) {
      return { ok: false, error: 'transfer', unsure: true, message: 'Paystack no answer. The desk go check the transfer by reference.' };
    }
  }
  async function verifyTransfer(reference) {
    if (!enabled) return { ok: false, error: 'not-set-up' };
    try {
      const out = await call('GET', '/transfer/verify/' + encodeURIComponent(reference));
      const d = out.data && out.data.data;
      if (!out.httpOk || !d) return { ok: false, error: 'verify', notFound: !!(out.data && out.data.status === false) };
      return { ok: true, status: String(d.status || '') };
    } catch (e) {
      return { ok: false, error: 'verify' };
    }
  }
  async function refund(info) {
    if (!enabled) return { ok: false, error: 'not-set-up', message: 'Payments never set up yet.' };
    try {
      const body = { transaction: info.reference };
      if (info.amountKobo) body.amount = info.amountKobo;
      const out = await call('POST', '/refund', body);
      const d = out.data && out.data.data;
      if (!out.httpOk || !out.data || out.data.status !== true) {
        return { ok: false, error: 'refund', message: (out.data && out.data.message) || 'Paystack refuse the refund.' };
      }
      return { ok: true, status: String((d && d.status) || 'pending') };
    } catch (e) {
      return { ok: false, error: 'refund', unsure: true, message: 'Paystack no answer. Try the refund again.' };
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

  return { enabled, initialize, verify, verifySignature, listBanks, resolveAccount, createRecipient, transfer, verifyTransfer, refund };
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
  const mirror = opts.mirror || null;

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
    if (mirror) { try { mirror.push([...records.values()]); } catch (e) { /* best effort */ } }
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
      // Where the money sits once it is paid: seated (a lobby seat holds
      // it), in-game, consumed (a finished game paid it out as prize and
      // house share), refund-due, or refunded. Null while unpaid.
      seat: null,
      lastCheckedAt: 0,
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
  // Oldest-checked first, so a few never-finished payments can never
  // starve the sweep of the newer ones behind them.
  function pendingOlderThan(ms) {
    const cut = Date.now() - ms;
    return [...records.values()]
      .filter((r) => r.status === 'pending' && r.createdAt <= cut)
      .sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0));
  }
  function touch(reference) {
    const rec = get(reference);
    if (rec) rec.lastCheckedAt = Date.now();
  }
  function list() {
    return [...records.values()];
  }
  function hydrate(doc) {
    if (records.size || !Array.isArray(doc)) return false;
    for (const r of doc) if (r && r.reference) records.set(r.reference, r);
    save();
    return records.size > 0;
  }
  return { create, get, findPending, update, pendingOlderThan, touch, list, hydrate };
}

module.exports = { createPaystack, createPaymentStore };
