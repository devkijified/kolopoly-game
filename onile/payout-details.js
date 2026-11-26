'use strict';
// Full account numbers for the house desk only. The shared payout queue
// keeps the bank name, the Paystack account name and the last four
// digits. Onile keeps the full number beside that, in its own data
// directory, and the admin API is the only reader. Nothing here is logged.
const path = require('path');
function nodeFs() { return require('fs'); }

function createPayoutDetails(opts) {
  opts = opts || {};
  const memory = !!opts.memory;
  const file = memory ? null : (opts.file || path.join(__dirname, '..', 'data', 'onile', 'payout-details.json'));
  let doc = { accounts: {} };
  let saveWarned = false;

  function load() {
    if (memory) return;
    try {
      const parsed = JSON.parse(nodeFs().readFileSync(file, 'utf8'));
      if (parsed && parsed.accounts && typeof parsed.accounts === 'object') doc = { accounts: parsed.accounts };
    } catch (e) {
      if (e.code !== 'ENOENT') console.log('Onile payout details started empty.');
    }
  }
  function save() {
    if (memory) return;
    const fs = nodeFs();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!saveWarned) { saveWarned = true; console.log('Onile payout details could not be saved.'); }
    }
  }
  load();

  function remember(accountId, bank) {
    const id = String(accountId || '');
    const accountNumber = String(bank && bank.accountNumber || '').replace(/\s+/g, '');
    if (!id || !/^\d{10}$/.test(accountNumber)) return { ok: false };
    doc.accounts[id] = {
      bankName: String(bank.bankName || '').slice(0, 80),
      accountName: String(bank.accountName || '').slice(0, 80),
      accountNumber,
      at: Date.now()
    };
    save();
    return { ok: true };
  }
  function forAccount(accountId) {
    const row = doc.accounts[String(accountId || '')];
    if (!row || !/^\d{10}$/.test(row.accountNumber || '')) return null;
    return { bankName: row.bankName, accountName: row.accountName, accountNumber: row.accountNumber };
  }
  return { remember, forAccount };
}

module.exports = { createPayoutDetails };
