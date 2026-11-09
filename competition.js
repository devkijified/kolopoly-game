'use strict';
// Paid competitions: the city ladder settings.
// One row per city (name, venue, entry fee, flagship) and one winner
// share per table size. Every money number in the paid game reads from
// here at use time; nothing about fees or shares is hardcoded anywhere
// else. This module is settings plumbing only: no live game reads it
// yet, and it never moves money.
// The Node host keeps the settings in a JSON file beside the retention
// shelf. The Worker host keeps the same shape in the Lobby Durable
// Object and shares the defaults, validation and money table below.
const path = require('path');
function nodeFs() { return require('fs'); }

const TABLE_SIZES = [2, 3, 4, 5, 6];
const MAX_FEE = 100000000;
const MAX_CITIES = 12;

const DEFAULT_CITIES = [
  { id: 'ibadan', city: 'Ibadan', venue: 'The Brown Roof', fee: 200, flagship: false },
  { id: 'enugu', city: 'Enugu', venue: 'Coal City Hall', fee: 500, flagship: false },
  { id: 'kano', city: 'Kano', venue: 'Ancient City Walls', fee: 1000, flagship: false },
  { id: 'port-harcourt', city: 'Port Harcourt', venue: 'The Creek', fee: 2500, flagship: false },
  { id: 'lagos', city: 'Lagos', venue: 'Eko Atlantic Towers', fee: 5000, flagship: false },
  { id: 'aso-rock', city: 'Aso Rock, Abuja', venue: 'The Summit', fee: 25000, flagship: true }
];
const DEFAULT_SPLITS = { 2: 80, 3: 75, 4: 70, 5: 65, 6: 60 };

function defaultSettings() {
  return {
    cities: DEFAULT_CITIES.map((row) => Object.assign({}, row)),
    splits: Object.assign({}, DEFAULT_SPLITS)
  };
}

function cleanText(v, max) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ');
  return s.length <= max ? s : null;
}
function slugOf(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 32);
}
function cleanFee(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 1 || n > MAX_FEE) return null;
  return n;
}
function cleanShare(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 1 || n > 100) return null;
  return n;
}

// Validate an admin submitted ladder. Returns the canonical settings on
// success, or a plain language reason the save was refused. A refused
// save changes nothing: the caller keeps the settings it already had.
function validateCompetition(input) {
  const bad = (message) => ({ ok: false, error: 'competition', message });
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return bad('The ladder did not arrive in one piece. Nothing was saved.');
  }
  if (!Array.isArray(input.cities) || !input.cities.length) {
    return bad('The ladder needs at least one city row. Nothing was saved.');
  }
  if (input.cities.length > MAX_CITIES) {
    return bad('The ladder holds at most ' + MAX_CITIES + ' cities. Nothing was saved.');
  }
  const cities = [];
  const ids = new Set();
  let flagships = 0;
  for (const row of input.cities) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return bad('One city row is not readable. Nothing was saved.');
    }
    const city = cleanText(row.city, 40);
    if (!city) return bad('Every city needs a name. Nothing was saved.');
    const venue = cleanText(row.venue, 60);
    if (!venue) return bad(city + ' needs a venue name. Nothing was saved.');
    const fee = cleanFee(row.fee);
    if (fee == null) return bad('The entry fee for ' + city + ' must be a whole number of naira, at least 1. Nothing was saved.');
    let id = row.id != null && String(row.id).trim() !== '' ? slugOf(row.id) : slugOf(city);
    if (!id) return bad('The row for ' + city + ' needs a short name the system can keep. Nothing was saved.');
    if (ids.has(id)) return bad('Two rows answer to ' + id + '. Give each city its own name. Nothing was saved.');
    ids.add(id);
    const flagship = row.flagship === true;
    if (flagship) flagships += 1;
    cities.push({ id, city, venue, fee, flagship });
  }
  if (flagships > 1) {
    return bad('Only one table can be the flagship. Nothing was saved.');
  }
  const rawSplits = input.splits;
  if (!rawSplits || typeof rawSplits !== 'object' || Array.isArray(rawSplits)) {
    return bad('The winner shares did not arrive. Nothing was saved.');
  }
  const splits = {};
  for (const size of TABLE_SIZES) {
    const share = cleanShare(rawSplits[size] != null ? rawSplits[size] : rawSplits[String(size)]);
    if (share == null) {
      return bad('The winner share for ' + size + ' players must be a whole percent between 1 and 100. Nothing was saved.');
    }
    splits[size] = share;
  }
  for (let i = 1; i < TABLE_SIZES.length; i++) {
    if (splits[TABLE_SIZES[i]] > splits[TABLE_SIZES[i - 1]]) {
      return bad('The winner share cannot grow as the table gets bigger. Check the shares. Nothing was saved.');
    }
  }
  return { ok: true, settings: { cities, splits } };
}

// Stored data is trusted only after it passes the same validation a
// fresh save would. Anything else falls back to the seeded ladder.
function normalizeCompetition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = validateCompetition(raw);
  return out.ok ? out.settings : null;
}

// The money table the desk shows and the paid game will read: for every
// city and table size, the pot the players put in, what the winner
// takes, and what the house keeps. Winner and house always add back up
// to the pot exactly.
function competitionTable(settings) {
  const s = normalizeCompetition(settings) || defaultSettings();
  return s.cities.map((row) => ({
    id: row.id,
    city: row.city,
    venue: row.venue,
    fee: row.fee,
    flagship: row.flagship,
    sizes: TABLE_SIZES.map((players) => {
      const pot = row.fee * players;
      const winner = Math.round(pot * s.splits[players] / 100);
      return { players, pot, winner, house: pot - winner };
    })
  }));
}

// The Node store: one JSON file beside the retention shelf, written the
// same tmp-then-rename way. Memory mode serves the Worker tests and any
// host that injects its own saved copy.
function createCompetition(opts) {
  opts = opts || {};
  const memory = !!opts.memory;
  const file = memory ? null : (opts.file || path.join(__dirname, 'data', 'competition.json'));
  let current = normalizeCompetition(opts.db) || null;
  let saveWarned = false;

  function load() {
    if (memory || current) return;
    const fs = nodeFs();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      current = normalizeCompetition(parsed);
    } catch (e) {
      if (e.code !== 'ENOENT') console.log('Competition settings started empty.');
    }
  }
  function save() {
    if (memory || !current) return;
    const fs = nodeFs();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(current));
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!saveWarned) {
        saveWarned = true;
        console.log('Competition settings could not be saved.');
      }
    }
  }
  load();

  function settings() {
    return current || defaultSettings();
  }
  // Validate first, swap second, persist third. A bad save leaves the
  // live settings exactly as they were.
  function replace(input) {
    const out = validateCompetition(input);
    if (!out.ok) return { status: 400, body: { ok: false, error: out.error, message: out.message } };
    current = out.settings;
    save();
    return { status: 200, body: view() };
  }
  function view() {
    const s = settings();
    return { ok: true, saved: !!current, settings: s, table: competitionTable(s) };
  }
  function exportSettings() {
    return current;
  }
  return { settings, replace, view, exportSettings };
}

module.exports = {
  TABLE_SIZES,
  DEFAULT_CITIES,
  DEFAULT_SPLITS,
  defaultSettings,
  validateCompetition,
  normalizeCompetition,
  competitionTable,
  createCompetition
};
