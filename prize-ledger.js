'use strict';
// The prize ledger: the one record of real money the paid game owes.
// Every paid table writes here and nowhere else. A finished game writes
// one 'prize' entry for the winner and one 'house' entry for the house
// share. A paid room that dies before its game starts writes one
// 'refund-due' entry per paid seat, so nobody's entry fee vanishes into
// the dark. Entries are append only; nothing here moves money, it only
// remembers what is owed, to whom, and why.
// The Node host keeps the ledger in a JSON file beside the competition
// settings, written the same tmp-then-rename way. Memory mode serves
// tests and any host that keeps its own copy (the Worker queues entries
// and stores them in the Lobby Durable Object).
const path = require('path');
function nodeFs() { return require('fs'); }

const KINDS = new Set(['prize', 'house', 'refund-due']);
const MAX_ENTRIES = 5000;

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '');
  if (!KINDS.has(kind)) return null;
  const amount = Number(raw.amount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) return null;
  const name = String(raw.name == null ? '' : raw.name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
  return {
    roomCode: String(raw.roomCode || '').slice(0, 8),
    playerId: raw.playerId == null ? null : Number(raw.playerId),
    name,
    amount,
    kind,
    cityId: String(raw.cityId || '').slice(0, 32),
    accountId: raw.accountId ? String(raw.accountId).slice(0, 64) : null,
    email: raw.email ? String(raw.email).slice(0, 120) : null,
    at: Number(raw.at) || 0,
    testMode: !!raw.testMode
  };
}

function createPrizeLedger(opts) {
  opts = opts || {};
  const memory = !!opts.memory;
  const file = memory ? null : (opts.file || path.join(__dirname, 'data', 'prizes.json'));
  let entries = [];
  let saveWarned = false;

  function load() {
    if (memory) return;
    const fs = nodeFs();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) entries = parsed.map(cleanEntry).filter(Boolean).slice(-MAX_ENTRIES);
    } catch (e) {
      if (e.code !== 'ENOENT') console.log('Prize ledger started empty.');
    }
  }
  function save() {
    if (memory) return;
    const fs = nodeFs();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(entries));
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!saveWarned) {
        saveWarned = true;
        console.log('Prize ledger could not be saved.');
      }
    }
  }
  load();

  // Append one entry. Returns the stored entry, or null when the entry
  // is not readable (bad kind, bad amount): a refused write changes
  // nothing and never throws into the game.
  function add(raw) {
    const entry = cleanEntry(raw);
    if (!entry) return null;
    if (!entry.at) entry.at = Date.now();
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    save();
    return entry;
  }
  function list() {
    return entries.slice();
  }
  function view() {
    const totals = { prize: 0, house: 0, refundDue: 0, testMode: 0 };
    for (const e of entries) {
      if (e.kind === 'prize') totals.prize += e.amount;
      else if (e.kind === 'house') totals.house += e.amount;
      else if (e.kind === 'refund-due') totals.refundDue += e.amount;
      if (e.testMode) totals.testMode += 1;
    }
    return { ok: true, entries: list(), totals };
  }
  return { add, list, view };
}

module.exports = { createPrizeLedger, cleanEntry };
