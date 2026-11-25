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
  let loadedMtime = 0;
  // A file we could not parse is left untouched. A later grant must not
  // replace a hand edit the process failed to read.
  let unreadable = false;

  function absorb(parsed) {
    if (!parsed || !parsed.accounts || typeof parsed.accounts !== 'object') return;
    for (const [id, row] of Object.entries(parsed.accounts)) {
      if (!row || typeof row !== 'object') continue;
      const entries = Array.isArray(row.entries) ? row.entries : [];
      if (!doc.accounts[id]) {
        const balance = typeof row.balanceKobo === 'number' ? row.balanceKobo : entries.reduce((s, e) => s + (Number(e && e.kobo) || 0), 0);
        doc.accounts[id] = { balanceKobo: balance, entries: entries.slice() };
        continue;
      }
      const mine = doc.accounts[id];
      if (!Array.isArray(mine.entries)) mine.entries = [];
      const seen = new Set(mine.entries.map((e) => e && e.id));
      for (const e of entries) {
        if (!e || !e.id || seen.has(e.id)) continue;
        mine.entries.push(e);
        mine.balanceKobo = (Number(mine.balanceKobo) || 0) + (Number(e.kobo) || 0);
        seen.add(e.id);
      }
    }
  }
  function load() {
    if (memory || !file) return;
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.accounts && typeof parsed.accounts === 'object') doc = { accounts: parsed.accounts };
      else unreadable = true;
      loadedMtime = fs.statSync(file).mtimeMs;
    } catch (e) { unreadable = true; }
  }
  // A hand edit written while this process is up has a newer mtime.
  // Fold those entries in before a grant or a spend saves, so the write
  // cannot replace the file with a stale copy.
  function refresh() {
    if (memory || !file || unreadable) return;
    let st;
    try { st = fs.statSync(file); } catch (e) { return; }
    if (st.mtimeMs <= loadedMtime + 0.5) return;
    try {
      absorb(JSON.parse(fs.readFileSync(file, 'utf8')));
      loadedMtime = st.mtimeMs;
    } catch (e) { unreadable = true; }
  }
  function save() {
    if (memory || !file || unreadable) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, file);
      loadedMtime = fs.statSync(file).mtimeMs;
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
    refresh();
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
    refresh();
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
