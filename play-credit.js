'use strict';
// Play credit: a paid-entry balance on an account. It is spent instead of
// a Paystack charge when that account joins a paid table. It is not a bank
// balance and it is never transferred out.
//
// Hand edit (on the host, file KP_PLAY_CREDIT_FILE or
// <KP_DATA_DIR>/play-credits.json). The account id is
// "a_" plus the first 20 hex characters of sha256(lowercase email).
// Use one grant id per credit. Writing the same id again does not add twice.
//
// {
//   "accounts": {
//     "a_0123456789abcdef0123": {
//       "balanceKobo": 20000,
//       "entries": [
//         {
//           "id": "credit:RFFU:a_0123456789abcdef0123",
//           "kobo": 20000,
//           "reason": "unfair AFK takeover before pause rule",
//           "roomCode": "RFFU",
//           "at": 1730000000000,
//           "by": "owner"
//         }
//       ]
//     }
//   }
// }
//
// balanceKobo is naira times 100. A ₦200 seat is 20000 kobo. A spend
// appends an entry with negative kobo and lowers balanceKobo.
const fs = require('fs');
const path = require('path');

function createPlayCredit(opts) {
  opts = opts || {};
  const memory = !!opts.memory;
  const file = memory ? null : (opts.file || path.join(__dirname, 'data', 'play-credits.json'));
  let doc = { accounts: {} };

  function load() {
    if (memory || !file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.accounts && typeof parsed.accounts === 'object') doc = { accounts: parsed.accounts };
    } catch (e) { /* a missing file is an empty book */ }
  }
  function save() {
    if (memory || !file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, file);
    } catch (e) { /* the desk still answers */ }
  }
  load();

  function bucket(accountId) {
    const id = String(accountId || '');
    if (!doc.accounts[id]) doc.accounts[id] = { balanceKobo: 0, entries: [] };
    const row = doc.accounts[id];
    if (!Array.isArray(row.entries)) row.entries = [];
    if (typeof row.balanceKobo !== 'number') row.balanceKobo = 0;
    return row;
  }
  function findEntry(id) {
    for (const row of Object.values(doc.accounts)) {
      const hit = (row.entries || []).find((e) => e.id === id);
      if (hit) return hit;
    }
    return null;
  }
  function grant(input) {
    const accountId = String((input && input.accountId) || '');
    const id = String((input && input.id) || '');
    const kobo = Math.round(Number(input && input.kobo) || 0);
    if (!accountId || !id) return { ok: false, error: 'bad', message: 'Account and a credit id are required.' };
    if (kobo <= 0) return { ok: false, error: 'amount', message: 'Credit must be a positive number of kobo.' };
    const prior = findEntry(id);
    if (prior) {
      const row = bucket(accountId);
      return { ok: true, already: true, balanceKobo: row.balanceKobo, id };
    }
    const row = bucket(accountId);
    row.balanceKobo += kobo;
    row.entries.push({
      id, kobo, reason: String((input && input.reason) || '').slice(0, 180),
      roomCode: String((input && input.roomCode) || '').slice(0, 12),
      at: Date.now(), by: String((input && input.by) || 'owner').slice(0, 24)
    });
    if (row.entries.length > 40) row.entries = row.entries.slice(-40);
    save();
    return { ok: true, already: false, balanceKobo: row.balanceKobo, id };
  }
  function spend(accountId, kobo, reason, roomCode) {
    const need = Math.round(Number(kobo) || 0);
    const row = doc.accounts[String(accountId || '')];
    if (!row || row.balanceKobo < need || need <= 0) return { ok: false, error: 'short', balanceKobo: row ? row.balanceKobo : 0 };
    const id = 'spend:' + String(roomCode || '') + ':' + accountId + ':' + Date.now();
    row.balanceKobo -= need;
    row.entries.push({ id, kobo: -need, reason: String(reason || 'paid seat').slice(0, 180), roomCode: String(roomCode || ''), at: Date.now(), by: 'seat' });
    save();
    return { ok: true, balanceKobo: row.balanceKobo, spendId: id };
  }
  function balance(accountId) {
    const row = doc.accounts[String(accountId || '')];
    return row ? row.balanceKobo : 0;
  }
  function view(accountId) {
    if (accountId) {
      const row = doc.accounts[String(accountId)];
      return { ok: true, accountId, balanceKobo: row ? row.balanceKobo : 0, entries: row ? row.entries.slice() : [] };
    }
    const accounts = Object.keys(doc.accounts).map((id) => ({ accountId: id, balanceKobo: doc.accounts[id].balanceKobo }));
    return { ok: true, accounts };
  }
  return { grant, spend, balance, view };
}

module.exports = { createPlayCredit };
