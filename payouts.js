'use strict';
// The payout queue: where owed money becomes moved money.
// The prize ledger says what is owed (a prize to the winner, a refund to
// a seat whose game never produced a winner). Every such ledger entry
// lands here as one payout row, keyed so the same debt can only ever be
// one row: a prize by its game, a refund by the Paystack reference it
// goes back through. Rows move:
//   prize:  awaiting-bank -> ready -> claimed -> paid-manual
//                          review (AFK-held winner, no account) -> ready
//                          (auto only) ready -> sending -> paid
//                          (auto only) sending -> failed (safe to send again) | otp
//   refund: ready -> sending -> refund-pending -> refunded | failed
//   any open row -> paid-manual / refunded-manual (the desk paid by hand)
//   test mode rows stay 'test': no real money exists behind them.
// In KP_PAYOUT_MODE=manual (the default), Collect never calls send() or
// Paystack. It records the winner's claim and saved bank, and the row
// sits in the desk queue as claimed until the house marks it paid by
// hand. send() and automatic Paystack transfers run only when
// KP_PAYOUT_MODE=auto. A row flips to sending and is saved BEFORE the
// Paystack call, and each prize transfer carries a reference derived
// from the row id, so a crash, a retry or a double tap can never pay a
// prize twice: Paystack refuses a second transfer with the same
// reference, and the sweep asks Paystack what happened to any row left
// in sending.
// Winners give their bank once per account: the account number is
// checked against the bank (Paystack resolve), saved as a Paystack
// transfer recipient, and only the bank name, the account name and the
// last four digits are kept here. The full number never stays.
const crypto = require('crypto');
const path = require('path');
function nodeFs() { return require('fs'); }

const OPEN = new Set(['awaiting-bank', 'ready', 'claimed', 'review', 'failed', 'otp']);
const DONE = new Set(['paid', 'paid-manual', 'refunded', 'refunded-manual']);

// House-side Paystack blocks: the winner's Collect must not keep calling
// send(), and the public card must not say the payout failed. The desk
// row stays failed and keeps the real lastError.
const HOUSE_HOLD_RE = /third party payouts as a starter business|cannot initiate (third party )?payouts?|transfers? (are )?(not |dis)?enabled|insufficient (balance|funds)/i;
const HOUSE_HOLD_MESSAGE = 'Queued — house sends it soon';
const CLAIMED_MESSAGE = 'Claimed — house sends it to your bank soon';
function isHouseHoldError(err) {
  return !!(err && HOUSE_HOLD_RE.test(String(err)));
}
function isHouseHold(p) {
  return !!(p && p.status === 'failed' && isHouseHoldError(p.lastError));
}

function createPayouts(opts) {
  opts = opts || {};
  const memory = !!opts.memory;
  const file = memory ? null : (opts.file || path.join(__dirname, 'data', 'payouts.json'));
  const mirror = opts.mirror || null;
  const paystack = opts.paystack || { enabled: false };
  const payments = opts.payments || null;
  const auto = (opts.mode || process.env.KP_PAYOUT_MODE || 'manual') === 'auto';
  let doc = { payouts: [], banks: {} };
  let saveWarned = false;

  function load() {
    if (memory) return;
    try {
      const parsed = JSON.parse(nodeFs().readFileSync(file, 'utf8'));
      if (parsed && Array.isArray(parsed.payouts)) doc = { payouts: parsed.payouts, banks: parsed.banks || {} };
    } catch (e) {
      if (e.code !== 'ENOENT') console.log('Payout queue started empty.');
    }
  }
  function save() {
    if (mirror) { try { mirror.push(doc); } catch (e) { /* best effort */ } }
    if (memory) return;
    const fs = nodeFs();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!saveWarned) { saveWarned = true; console.log('Payout queue could not be saved.'); }
    }
  }
  load();
  function hydrate(d) {
    if (doc.payouts.length || !d || !Array.isArray(d.payouts)) return false;
    doc = { payouts: d.payouts, banks: d.banks || {} };
    save();
    return true;
  }

  function get(id) { return doc.payouts.find((p) => p.id === id) || null; }
  function setStatus(p, status, event) {
    p.status = status;
    p.updatedAt = Date.now();
    p.events.push(Object.assign({ at: Date.now(), status }, event || {}));
    if (p.events.length > 40) p.events = p.events.slice(-40);
  }
  function log(line) { console.log('Payouts: ' + line); }

  // One ledger entry in, at most one payout row out.
  function fromLedger(entry) {
    if (!entry || (entry.kind !== 'prize' && entry.kind !== 'refund-due')) return null;
    const isPrize = entry.kind === 'prize';
    const id = isPrize
      ? 'prize:' + (entry.gameKey || (entry.roomCode + ':' + entry.at))
      : 'refund:' + (entry.reference || (entry.roomCode + ':' + entry.playerId + ':' + entry.at));
    const existing = get(id);
    if (existing) return existing;
    let status;
    let note = null;
    if (entry.testMode) { status = 'test'; note = 'Test mode: no real money behind this row.'; }
    else if (isPrize) {
      if (!entry.accountId) { status = 'review'; note = 'Winner seat has no account.'; }
      else if (entry.review) { status = 'review'; note = entry.review === 'afk' ? 'The winning seat was held by the AFK bot at the end.' : entry.review; }
      else status = doc.banks[entry.accountId] ? 'ready' : 'awaiting-bank';
    } else {
      const rec = entry.reference && payments ? payments.get(entry.reference) : null;
      if (rec && rec.status === 'paid') status = 'ready';
      else { status = 'review'; note = 'No Paystack payment found for this refund; pay it by hand.'; }
    }
    const row = {
      id, kind: isPrize ? 'prize' : 'refund',
      roomCode: entry.roomCode, gameKey: entry.gameKey || null, playerId: entry.playerId,
      name: entry.name, accountId: entry.accountId || null, email: entry.email || null,
      amountKobo: entry.amountKobo || entry.amount * 100, cityId: entry.cityId || null,
      paymentRef: isPrize ? null : (entry.reference || null),
      transferRef: isPrize ? 'kpw_' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 28) : null,
      why: entry.why || null, note, testMode: !!entry.testMode,
      status, attempts: 0, lastError: null,
      createdAt: Date.now(), updatedAt: Date.now(),
      events: [{ at: Date.now(), status, via: 'ledger' }]
    };
    doc.payouts.push(row);
    save();
    if (!isPrize && entry.reference && payments) {
      try { payments.update(entry.reference, { seat: 'refund-due' }, { kind: 'refund-due', why: entry.why || null }); } catch (e) { /* best effort */ }
    }
    log(row.kind + ' ' + row.id + ' queued at ' + (row.amountKobo / 100) + ' naira, ' + status + '.');
    if (auto && status === 'ready') send(id, 'auto').catch(() => {});
    return row;
  }

  function maskBank(b) {
    return b ? { bankName: b.bankName, accountName: b.accountName, last4: b.last4, at: b.at } : null;
  }
  async function setBank(acct, input) {
    if (!acct || !acct.accountId) return { ok: false, status: 401, error: 'auth', message: 'Sign in first.' };
    if (!paystack.enabled) return { ok: false, status: 503, error: 'not-set-up', message: 'Payouts never set up yet. The house go pay you by hand.' };
    const bankCode = String((input && input.bankCode) || '').trim();
    const accountNumber = String((input && input.accountNumber) || '').replace(/\s+/g, '');
    if (!/^[0-9A-Za-z-]{2,16}$/.test(bankCode)) return { ok: false, status: 400, error: 'bank', message: 'Pick your bank first.' };
    if (!/^\d{10}$/.test(accountNumber)) return { ok: false, status: 400, error: 'account', message: 'Account number na 10 digits.' };
    const banks = await paystack.listBanks();
    const bank = banks.ok ? banks.banks.find((b) => b.code === bankCode) : null;
    if (banks.ok && !bank) return { ok: false, status: 400, error: 'bank', message: 'That bank no dey the list.' };
    const resolved = await paystack.resolveAccount(accountNumber, bankCode);
    if (!resolved.ok) return { ok: false, status: 400, error: 'resolve', message: resolved.message };
    const rec = await paystack.createRecipient({ name: resolved.accountName, accountNumber, bankCode });
    if (!rec.ok) return { ok: false, status: 502, error: 'recipient', message: 'Paystack no save the bank. Try again.' };
    doc.banks[acct.accountId] = {
      bankCode, bankName: bank ? bank.name : bankCode, accountName: resolved.accountName,
      last4: accountNumber.slice(-4), recipientCode: rec.recipientCode, at: Date.now()
    };
    const promoted = [];
    for (const p of doc.payouts) {
      if (p.kind === 'prize' && p.accountId === acct.accountId && p.status === 'awaiting-bank') {
        setStatus(p, 'ready', { via: 'bank' });
        promoted.push(p.id);
      }
    }
    save();
    log('bank saved for an account; ' + promoted.length + ' prize row(s) ready.');
    if (auto) for (const id of promoted) send(id, 'auto').catch(() => {});
    return { ok: true, bank: maskBank(doc.banks[acct.accountId]) };
  }

  function publicRow(p) {
    return {
      id: p.id, kind: p.kind, roomCode: p.roomCode, gameKey: p.gameKey || null,
      amount: p.amountKobo / 100, amountKobo: p.amountKobo,
      status: p.status, testMode: p.testMode, createdAt: p.createdAt, updatedAt: p.updatedAt, why: p.why,
      houseHold: auto ? isHouseHold(p) : false,
      claimed: p.status === 'claimed'
    };
  }
  function mine(accountId) {
    return {
      ok: true,
      bank: maskBank(doc.banks[accountId]),
      payoutsReady: !!paystack.enabled,
      payoutMode: auto ? 'auto' : 'manual',
      payouts: doc.payouts.filter((p) => p.accountId && p.accountId === accountId).map(publicRow).reverse()
    };
  }

  async function send(id, by) {
    const p = get(id);
    if (!p) return { ok: false, error: 'unknown', message: 'That payout no dey.' };
    if (p.testMode) return { ok: false, error: 'test', message: 'Test mode row: no real money to send. Mark it settled instead.' };
    if (!['ready', 'failed'].includes(p.status)) return { ok: false, error: 'state', message: 'This payout is ' + p.status + '; it cannot be sent now.' };
    if (!paystack.enabled) return { ok: false, error: 'not-set-up', message: 'Paystack is not set up on this host.' };
    if (p.kind === 'prize') {
      const bank = doc.banks[p.accountId];
      if (!bank) { setStatus(p, 'awaiting-bank', { via: by }); save(); return { ok: false, error: 'bank', message: 'The winner never add a bank yet.' }; }
      p.attempts += 1;
      setStatus(p, 'sending', { via: by });
      save();
      const r = await paystack.transfer({
        amountKobo: p.amountKobo, recipientCode: bank.recipientCode, reference: p.transferRef,
        reason: 'Kolopoly prize, table ' + p.roomCode
      });
      if (r.ok) {
        const st = r.status;
        if (st === 'success') setStatus(p, 'paid', { via: 'transfer' });
        else if (st === 'otp') { p.lastError = 'Paystack is asking for an OTP on transfers. Turn off transfer OTP in the Paystack dashboard, or finish it there.'; setStatus(p, 'otp', { via: 'transfer' }); }
        else if (st === 'failed' || st === 'reversed') { p.lastError = 'Transfer ' + st + '.'; setStatus(p, 'failed', { via: 'transfer' }); }
        else { /* pending or processing: stays sending, the webhook or sweep finishes it */ p.events.push({ at: Date.now(), status: 'sending', via: 'transfer', detail: st }); }
      } else if (r.unsure) {
        p.lastError = r.message;
        p.events.push({ at: Date.now(), status: 'sending', via: 'transfer', detail: 'no answer' });
      } else {
        p.lastError = r.message;
        setStatus(p, 'failed', { via: 'transfer' });
      }
      p.transferCode = (r && r.transferCode) || p.transferCode || null;
      save();
      log('prize ' + p.id + ' send by ' + by + ': ' + p.status + (p.lastError && p.status !== 'paid' ? ' (' + p.lastError + ')' : '') + '.');
      return { ok: p.status !== 'failed', status: p.status, message: p.status === 'failed' ? p.lastError : null };
    }
    // Refund: back through the original Paystack transaction.
    p.attempts += 1;
    setStatus(p, 'sending', { via: by });
    save();
    const r = await paystack.refund({ reference: p.paymentRef });
    if (r.ok) {
      if (r.status === 'processed') refunded(p, 'refund');
      else setStatus(p, 'refund-pending', { via: 'refund', detail: r.status });
    } else if (/fully reversed|already been reversed|already refunded/i.test(r.message || '')) {
      refunded(p, 'refund');
    } else {
      p.lastError = r.message;
      setStatus(p, 'failed', { via: 'refund' });
    }
    save();
    log('refund ' + p.id + ' send by ' + by + ': ' + p.status + '.');
    return { ok: p.status !== 'failed', status: p.status, message: p.status === 'failed' ? p.lastError : null };
  }
  function refunded(p, via) {
    setStatus(p, 'refunded', { via });
    if (p.paymentRef && payments) { try { payments.update(p.paymentRef, { seat: 'refunded' }, { kind: 'refunded' }); } catch (e) { /* best effort */ } }
  }

  function approve(id) {
    const p = get(id);
    if (!p) return { ok: false, error: 'unknown', message: 'That payout no dey.' };
    if (p.status !== 'review') return { ok: false, error: 'state', message: 'Only a row in review can be approved.' };
    if (p.kind === 'refund' && !p.paymentRef) return { ok: false, error: 'state', message: 'No Paystack payment behind this refund; mark it refunded by hand once paid.' };
    if (p.kind === 'prize' && !p.accountId) return { ok: false, error: 'state', message: 'No account behind this prize; pay it by hand and mark it paid.' };
    setStatus(p, p.kind === 'prize' && !doc.banks[p.accountId] ? 'awaiting-bank' : 'ready', { via: 'desk-approve' });
    save();
    if (auto && p.status === 'ready') send(id, 'auto').catch(() => {});
    return { ok: true, status: p.status };
  }
  function markManual(id, note) {
    const p = get(id);
    if (!p) return { ok: false, error: 'unknown', message: 'That payout no dey.' };
    if (DONE.has(p.status)) return { ok: false, error: 'state', message: 'Already settled.' };
    if (p.status === 'sending' || p.status === 'refund-pending') return { ok: false, error: 'state', message: 'Paystack is still working on this one. Wait for it to finish.' };
    if (p.kind === 'prize' && !(p.accountId && doc.banks[p.accountId])) {
      return { ok: false, error: 'bank', message: 'Waiting for bank details' };
    }
    p.note = String(note || '').slice(0, 200) || p.note;
    if (p.kind === 'prize') setStatus(p, 'paid-manual', { via: 'desk' });
    else { setStatus(p, 'refunded-manual', { via: 'desk' }); if (p.paymentRef && payments) { try { payments.update(p.paymentRef, { seat: 'refunded' }, { kind: 'refunded-manual' }); } catch (e) { /* best effort */ } } }
    save();
    return { ok: true, status: p.status };
  }

  // Paystack webhooks for money going out.
  function onWebhook(event, data) {
    data = data || {};
    if (/^transfer\./.test(event)) {
      const p = doc.payouts.find((x) => x.transferRef && x.transferRef === String(data.reference || ''));
      if (!p || DONE.has(p.status)) return false;
      if (event === 'transfer.success') setStatus(p, 'paid', { via: 'webhook' });
      else if (event === 'transfer.failed' || event === 'transfer.reversed') { p.lastError = 'Transfer ' + event.split('.')[1] + ' by Paystack.'; setStatus(p, 'failed', { via: 'webhook' }); }
      else return false;
      save();
      log('prize ' + p.id + ' ' + p.status + ' by webhook.');
      return true;
    }
    if (/^refund\./.test(event)) {
      const ref = String(data.transaction_reference || (data.transaction && data.transaction.reference) || '');
      const p = doc.payouts.find((x) => x.kind === 'refund' && x.paymentRef && x.paymentRef === ref);
      if (!p || DONE.has(p.status)) return false;
      if (event === 'refund.processed') refunded(p, 'webhook');
      else if (event === 'refund.failed') { p.lastError = 'Refund failed at Paystack.'; setStatus(p, 'failed', { via: 'webhook' }); }
      else return false;
      save();
      return true;
    }
    return false;
  }

  // Any prize left in sending (a crash mid-call, a pending transfer, a
  // lost webhook) is settled by asking Paystack about its reference.
  async function sweep(ageMs) {
    if (!paystack.enabled) return;
    const cut = Date.now() - (ageMs || 30000);
    for (const p of doc.payouts.filter((x) => x.kind === 'prize' && x.status === 'sending' && x.updatedAt <= cut).slice(0, 5)) {
      const v = await paystack.verifyTransfer(p.transferRef);
      if (v.ok) {
        if (v.status === 'success') setStatus(p, 'paid', { via: 'sweep' });
        else if (v.status === 'failed' || v.status === 'reversed') { p.lastError = 'Transfer ' + v.status + '.'; setStatus(p, 'failed', { via: 'sweep' }); }
        else if (v.status === 'otp') setStatus(p, 'otp', { via: 'sweep' });
        else p.updatedAt = Date.now();
      } else if (v.notFound) {
        p.lastError = 'Paystack has no transfer with this reference; it is safe to send again.';
        setStatus(p, 'failed', { via: 'sweep' });
      } else p.updatedAt = Date.now();
      save();
    }
  }

  function view() {
    const totals = { prizeOwedKobo: 0, prizePaidKobo: 0, refundOwedKobo: 0, refundDoneKobo: 0, open: 0 };
    for (const p of doc.payouts) {
      if (p.testMode) continue;
      if (p.kind === 'prize') { if (DONE.has(p.status)) totals.prizePaidKobo += p.amountKobo; else totals.prizeOwedKobo += p.amountKobo; }
      else { if (DONE.has(p.status)) totals.refundDoneKobo += p.amountKobo; else totals.refundOwedKobo += p.amountKobo; }
      if (!DONE.has(p.status) && p.status !== 'test') totals.open += 1;
    }
    const rows = doc.payouts.slice().reverse().map((p) => Object.assign({}, p, {
      bank: p.accountId ? maskBank(doc.banks[p.accountId]) : null,
      events: p.events.slice(-6)
    }));
    return { ok: true, mode: auto ? 'auto' : 'manual', payoutsReady: !!paystack.enabled, totals, payouts: rows };
  }
  function list() { return doc.payouts.slice(); }
  const collecting = new Set();
  // The winner's own collect. In manual mode this only records the
  // claim and the saved bank; it never calls send() or Paystack. In
  // auto mode it pays through send(), once per row. A second tap
  // while it is claimed, sending, or already paid does not start
  // another transfer.
  function claim(p, accountId, already) {
    const bank = maskBank(doc.banks[accountId]);
    if (p.status !== 'claimed') {
      p.claimedAt = Date.now();
      p.claimedBank = bank;
      p.lastError = null;
      setStatus(p, 'claimed', { via: 'winner' });
      save();
      log('prize ' + p.id + ' claimed by winner; awaiting house.');
    }
    return {
      ok: true, already: !!already, status: p.status, claimed: true,
      payout: publicRow(p), message: CLAIMED_MESSAGE
    };
  }
  async function collect(accountId, body) {
    if (!accountId) return { ok: false, status: 401, error: 'auth', message: 'Sign in first.' };
    const roomCode = String((body && body.roomCode) || '').toUpperCase();
    const gameKey = String((body && body.gameKey) || '');
    const mineRows = doc.payouts.filter((p) => p.kind === 'prize' && p.accountId === accountId && (!roomCode || String(p.roomCode).toUpperCase() === roomCode) && (!gameKey || p.gameKey === gameKey));
    const open = mineRows.filter((p) => !DONE.has(p.status));
    const p = (open.length ? open : mineRows).slice(-1)[0];
    if (!p) return { ok: false, status: 404, error: 'missing', message: 'No prize is queued for this table.' };
    if (DONE.has(p.status) || p.status === 'sending' || p.status === 'otp') {
      return { ok: true, already: true, status: p.status, payout: publicRow(p), message: p.status === 'paid' || p.status === 'paid-manual' ? 'Already paid to your bank.' : 'Already on the way. It will not be sent twice.' };
    }
    if (p.testMode || p.status === 'test') return { ok: false, status: 400, error: 'test', message: 'Test mode: no real money to send.' };
    if (p.status === 'review') return { ok: false, status: 409, error: 'review', message: 'The house is checking this game before paying.' };
    if (p.status === 'claimed') return claim(p, accountId, true);
    if (auto && isHouseHold(p)) {
      return { ok: true, already: true, status: p.status, houseHold: true, payout: publicRow(p), message: HOUSE_HOLD_MESSAGE };
    }
    if (!doc.banks[accountId] || p.status === 'awaiting-bank') {
      if (p.status !== 'awaiting-bank') { setStatus(p, 'awaiting-bank', { via: 'collect' }); save(); }
      return { ok: false, status: 409, error: 'bank', message: 'Add your bank, then collect again. The prize stays queued.' };
    }
    if (!auto) return claim(p, accountId, false);
    if (collecting.has(p.id)) return { ok: true, already: true, status: 'sending', payout: publicRow(p), message: 'Already sending. It will not be sent twice.' };
    collecting.add(p.id);
    try {
      const out = await send(p.id, 'winner');
      const row = get(p.id);
      const paid = row && (row.status === 'paid' || row.status === 'paid-manual');
      const moving = row && (row.status === 'sending' || row.status === 'otp');
      if (row && isHouseHold(row)) {
        return { ok: true, already: false, status: row.status, houseHold: true, payout: publicRow(row), message: HOUSE_HOLD_MESSAGE };
      }
      return {
        ok: !!(out && out.ok) || paid || moving,
        already: false,
        status: row ? row.status : out.status,
        payout: row ? publicRow(row) : null,
        message: paid ? 'Paid to your bank.' : (out && out.message) || (moving ? 'On the way to your bank.' : 'The house could not send it.')
      };
    } finally {
      collecting.delete(p.id);
    }
  }
  function openRows() {
    return doc.payouts.filter((p) => !p.testMode && !DONE.has(p.status) && p.status !== 'test').map((p) => ({
      roomCode: p.roomCode, kind: p.kind, amount: p.amountKobo / 100, status: p.status
    }));
  }

  return { fromLedger, setBank, mine, collect, send, approve, markManual, onWebhook, sweep, view, list, openRows, hydrate, get, OPEN, DONE };
}

module.exports = { createPayouts, isHouseHoldError, HOUSE_HOLD_MESSAGE, CLAIMED_MESSAGE };
