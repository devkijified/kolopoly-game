'use strict';
// Return retention: a daily market shelf and Web Push whispers.
// The shelf is cowries, kola, yams and cloth. It is not table cash,
// not deeds, and it does not touch the board, the modes, or the economy.
// Identity is the same pair the table already uses: clientId, and the
// seat reconnect token once a room has linked them.
//
// Shelf v2 (the kolo shelf) lives in the same store, behind a v=2 ask
// on the same endpoints: daily pieces fill a kolo that breaks into a
// paid-table entry ticket, second-chance goods alternate by claim,
// Lagos Streets postcards fill a season album, cosmetic pieces build
// three permanent looks, and the streak runs the Royal Match shape
// (a weekly run with one grace day, total days that never reset).
// The v1 goods are retired for new accrual: a player's first v2
// contact converts their stored balance into pieces and postcards,
// once, at the generous rates in SHELF_V2. Clients that never ask
// for v2 keep the exact v1 answers below.
const path = require('path');
// Node crypto push stays behind a lazy require so a memory-backed shelf
// (the Durable Object) can inject a WebCrypto implementation instead.
function nodePush() { return require('./push-crypto'); }
function nodeFs() { return require('fs'); }

const GOODS = ['cowries', 'kola', 'yams', 'cloth'];
const BASE_DROP = { cowries: 6, kola: 2, yams: 1, cloth: 1 };
// Soft extra when yesterday (Lagos) was also claimed. Missing a day
// pays the base again. There is no streak counter to reset.
const WARM_EXTRA = { cowries: 3, kola: 1, yams: 0, cloth: 0 };
// What a good does at the table. Claim never pays table cash. The
// player spends the shelf during a match: cowries and cloth become
// cash, one kola covers the next rent, one yam covers the next fee.
const USES = {
  cowries: { cost: 3, kind: 'cash', amount: 50000 },
  kola: { cost: 1, kind: 'rent', amount: 100000 },
  yams: { cost: 1, kind: 'fee', amount: 200000 },
  cloth: { cost: 1, kind: 'cash', amount: 150000 }
};

// ---------------------------------------------------------------------
// Shelf v2 settings. One named block, so an admin surface can own
// these numbers later without a code hunt. Nothing here is cash: the
// ticket is entry into a paid table, never a payout, and no v2 good
// converts back to money anywhere.
// ---------------------------------------------------------------------
const SHELF_V2 = {
  // Daily pieces that fill the kolo. A full kolo breaks into one
  // entry ticket, on a day the player played a match.
  piecesNeeded: 7,
  // The ticket face: the table fee it covers and the entry credit it
  // carries, for the lowest paid table. The launch default is a full
  // ticket (credit equals the fee). A softer launch is the same shape
  // with credit below the fee, a voucher the player tops up.
  ticket: { tableFee: 200, credit: 200, table: 'Ibadan', venue: 'The Brown Roof' },
  // One ticket held at a time. A later kolo or album tickets wait
  // until the held ticket is used or lapses.
  ticketExpiryDays: 14,
  // Second-chance goods alternate by v2 claim count, cap the hand,
  // and lapse fast. They are free-table goods only (freeOnly).
  secondChanceKinds: ['rentShield', 'bailCard'],
  secondChanceCap: 2,
  secondChanceExpiryDays: 3,
  // The Lagos Streets album pays entry tickets and a token cosmetic
  // on completion, never cash.
  albumTicketReward: 2,
  albumTokenName: 'Real Landlord Token',
  // Cosmetic pieces complete in this rotation and never lapse.
  cosmeticItems: [
    { id: 'danfoLivery', name: 'Danfo Livery' },
    { id: 'kekeColour', name: 'Keke Colour' },
    { id: 'okadaOutfit', name: 'Okada Outfit' }
  ],
  cosmeticPiecesNeeded: 5,
  // One grace day per Lagos week covers a single missed day. Total
  // claim days never reset and pay these milestones.
  gracePerWeek: 1,
  milestones: [8, 15, 22, 30],
  milestonePieces: 2,
  // One-time conversion of the retired v1 goods, at first v2 contact.
  // The rates lean generous on purpose: nobody should feel robbed by
  // the move. Pieces stop one short of a free instant ticket.
  conversion: { goodsPerPiece: 2, maxPieces: 6, goodsPerPostcard: 5, maxPostcards: 3 }
};
// The album mirrors the board (public/game-data.js SPACES, in board
// order): the ten streets and the two stations, under the board's
// own family names.
const ALBUM = [
  { id: 'makoko', name: 'Makoko', family: 'The Trenches' },
  { id: 'ajegunle', name: 'Ajegunle', family: 'The Trenches' },
  { id: 'yaba', name: 'Yaba', family: 'Mainland Hustle Belt' },
  { id: 'surulere', name: 'Surulere', family: 'Mainland Hustle Belt' },
  { id: 'lekki-tollgate', name: 'Lekki Tollgate', family: 'Stations' },
  { id: 'oriental-hotel', name: 'Oriental Hotel', family: 'Hotels and Nightlife' },
  { id: 'quilox', name: 'Quilox', family: 'Hotels and Nightlife' },
  { id: 'mmia-airport', name: 'Murtala Muhammed Intl Airport', family: 'Stations' },
  { id: 'victoria-island', name: 'Victoria Island', family: 'Corporate and Capital' },
  { id: 'eko-hotel', name: 'Eko Hotel', family: 'Corporate and Capital' },
  { id: 'eko-atlantic', name: 'Eko Atlantic', family: 'The Final Boss' },
  { id: 'banana-island', name: 'Banana Island', family: 'The Final Boss' }
];
const SECOND_CHANCE = {
  rentShield: { label: 'Rent Shield' },
  bailCard: { label: 'Bail Card' }
};
const POT_MARKS = [200000, 500000, 1000000, 2000000];
const NUDGE_GAP_MS = 30 * 60 * 1000;

const NUDGES = {
  drop: {
    title: 'Market drop ready',
    body: "Today's market drop dey ready. Cowries, kola, yam and cloth don land for your shelf.",
    tag: 'kolopoly-drop',
    url: '/'
  },
  waiting: {
    title: 'Your seat is held',
    body: 'Your seat is held. The table dey wait for you, and this room still get your place.',
    tag: 'kolopoly-waiting',
    url: '/'
  },
  pot: {
    title: 'Owambe pot',
    body: 'The Owambe pot don swell. Land on the grounds and you fit collect every naira wey dey inside.',
    tag: 'kolopoly-pot',
    url: '/'
  }
};

function lagosDay(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}
function prevDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
function validDay(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function dayMs(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function weekKey(iso) {
  // ISO week of a Lagos day, for the one-grace-per-week rule.
  const ms = dayMs(iso);
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // Monday is 0
  const thu = ms + (3 - dow) * 86400000;
  const year = new Date(thu).getUTCFullYear();
  const week = Math.floor((thu - Date.UTC(year, 0, 1)) / (7 * 86400000)) + 1;
  return year + '-W' + String(week).padStart(2, '0');
}
function pickIndex(seed, n) {
  // FNV-1a over the seed, so a postcard pick is deterministic for a
  // player and a claim, with no RNG state to keep in sync.
  let h = 2166136261;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}
function cleanClientId(v) {
  const s = String(v || '');
  return /^[a-zA-Z0-9-]{8,64}$/.test(s) ? s : null;
}
function cleanToken(v) {
  const s = String(v || '');
  return /^[a-f0-9]{24}$/i.test(s) ? s.toLowerCase() : null;
}
function cleanName(v) {
  const s = String(v || '').trim().slice(0, 20);
  return s || '';
}

function createRetention(opts) {
  opts = opts || {};
  const test = !!opts.test;
  const memory = !!opts.memory;
  const file = memory ? null : (opts.file || path.join(__dirname, 'data', 'retention.json'));
  const pushLib = opts.push || nodePush();
  const loadVapid = pushLib.loadVapid;
  const sendWebPush = pushLib.sendWebPush;
  const roundtripSelfTest = pushLib.roundtripSelfTest;
  const env = opts.env || (typeof process !== 'undefined' ? process.env : {});
  const vapid = opts.vapid || loadVapid(env, test);
  const db = { players: {}, tokens: {}, stats: emptyStats() };
  let saveWarned = false;
  const testLog = [];

  function applyParsed(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    db.players = parsed.players && typeof parsed.players === 'object' ? parsed.players : {};
    db.tokens = parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {};
    db.stats = mergeStats(parsed.stats);
  }
  function load() {
    if (memory) { applyParsed(opts.db); return; }
    const fs = nodeFs();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      applyParsed(parsed);
    } catch (e) {
      if (e.code !== 'ENOENT') console.log('Retention shelf started empty.');
    }
  }
  function save() {
    if (memory) return;
    const fs = nodeFs();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!saveWarned) {
        saveWarned = true;
        console.log('Retention shelf could not be saved.');
      }
    }
  }
  function exportDb() {
    return { players: db.players, tokens: db.tokens, stats: db.stats };
  }
  load();

  function blank(id) {
    return {
      clientId: id,
      name: '',
      inventory: { cowries: 0, kola: 0, yams: 0, cloth: 0 },
      lastClaimDay: null,
      claimCount: 0,
      push: null,
      pushMuted: false,
      pushDenied: false,
      lastNudgeAt: {},
      lastDropNudgeDay: null,
      playedDays: {},
      v2: null
    };
  }
  function normalize(p) {
    p.inventory = p.inventory || {};
    for (const g of GOODS) {
      const n = Math.floor(Number(p.inventory[g]) || 0);
      p.inventory[g] = n > 0 ? n : 0;
    }
    p.lastNudgeAt = p.lastNudgeAt || {};
    p.claimCount = Math.max(0, Math.floor(Number(p.claimCount) || 0));
    if (!p.playedDays || typeof p.playedDays !== 'object') p.playedDays = {};
    if (p.v2 === undefined) p.v2 = null;
    return p;
  }

  function blankV2() {
    return {
      conversionDone: false,
      converted: false,
      conversion: null,
      kolo: { pieces: 0, completePending: false },
      ticket: null,
      pendingTickets: 0,
      secondChance: [],
      album: {},
      albumComplete: {},
      cosmetics: { pieces: { danfoLivery: 0, kekeColour: 0, okadaOutfit: 0 }, tokenSeasons: [] },
      streak: { lastDay: null, count: 0, graceWeek: null },
      totalDays: 0,
      claims: 0,
      milestonesPaid: []
    };
  }
  function normalizeV2(v) {
    const d = blankV2();
    if (!v || typeof v !== 'object') return d;
    const num = (x) => { const n = Math.floor(Number(x) || 0); return n > 0 ? n : 0; };
    d.conversionDone = !!v.conversionDone;
    d.converted = !!v.converted;
    d.conversion = v.conversion && typeof v.conversion === 'object' ? v.conversion : null;
    if (v.kolo && typeof v.kolo === 'object') {
      d.kolo.pieces = Math.min(SHELF_V2.piecesNeeded, num(v.kolo.pieces));
      d.kolo.completePending = !!v.kolo.completePending;
    }
    d.ticket = v.ticket && typeof v.ticket === 'object' ? v.ticket : null;
    d.pendingTickets = num(v.pendingTickets);
    if (Array.isArray(v.secondChance)) {
      d.secondChance = v.secondChance
        .filter((it) => it && SECOND_CHANCE[it.kind] && validDay(it.expiresDay))
        .map((it) => ({ kind: it.kind, expiresDay: String(it.expiresDay), freeOnly: true }));
    }
    if (v.album && typeof v.album === 'object') {
      for (const [season, page] of Object.entries(v.album)) {
        if (!page || typeof page !== 'object') continue;
        const clean = {};
        for (const card of ALBUM) {
          const n = num(page[card.id]);
          if (n > 0) clean[card.id] = n;
        }
        d.album[season] = clean;
      }
    }
    if (v.albumComplete && typeof v.albumComplete === 'object') {
      for (const [season, day] of Object.entries(v.albumComplete)) {
        if (validDay(day)) d.albumComplete[season] = String(day);
      }
    }
    if (v.cosmetics && typeof v.cosmetics === 'object') {
      if (v.cosmetics.pieces && typeof v.cosmetics.pieces === 'object') {
        for (const item of SHELF_V2.cosmeticItems) d.cosmetics.pieces[item.id] = num(v.cosmetics.pieces[item.id]);
      }
      if (Array.isArray(v.cosmetics.tokenSeasons)) {
        d.cosmetics.tokenSeasons = v.cosmetics.tokenSeasons.map(Number).filter((n) => n > 0);
      }
    }
    if (v.streak && typeof v.streak === 'object') {
      d.streak.lastDay = validDay(v.streak.lastDay) ? String(v.streak.lastDay) : null;
      d.streak.count = num(v.streak.count);
      d.streak.graceWeek = typeof v.streak.graceWeek === 'string' ? v.streak.graceWeek : null;
    }
    d.totalDays = num(v.totalDays);
    d.claims = num(v.claims);
    if (Array.isArray(v.milestonesPaid)) {
      d.milestonesPaid = v.milestonesPaid.map(Number).filter((n) => SHELF_V2.milestones.includes(n));
    }
    return d;
  }
  function v2Of(p) {
    // Normalize once per stored object, then keep the reference: many
    // helpers (issueTickets, settleKolo, the views) share this state
    // in one request, and a fresh copy each call would strand writes
    // on stale objects. The marker is not enumerable, so it never
    // reaches the store file; a reload simply normalizes again.
    if (!p.v2 || p.v2.__kolopolyV2 !== true) {
      p.v2 = normalizeV2(p.v2 || blankV2());
      Object.defineProperty(p.v2, '__kolopolyV2', { value: true, enumerable: false });
    }
    return p.v2;
  }
  // True once the player has had a real v2 contact that evaluated the
  // conversion. From that moment the v1 shelf stops accruing.
  function v2Active(p) {
    return !!(p.v2 && p.v2.conversionDone);
  }
  function activeSeason(v) {
    let s = 1;
    while (v.albumComplete[String(s)]) s += 1;
    return s;
  }
  // Grant one postcard into a season page. Completing a page pays the
  // album reward at once: entry tickets banked as pending (they fill
  // the held slot as it frees) and the token cosmetic for the season.
  // Never cash. Returns the completed season, or null.
  function grantCard(v, season, cardId, day) {
    const key = String(season);
    if (!v.album[key]) v.album[key] = {};
    v.album[key][cardId] = (v.album[key][cardId] || 0) + 1;
    if (v.albumComplete[key]) return null;
    const full = ALBUM.every((c) => (v.album[key][c.id] || 0) >= 1);
    if (!full) return null;
    v.albumComplete[key] = day;
    v.pendingTickets += SHELF_V2.albumTicketReward;
    if (!v.cosmetics.tokenSeasons.includes(season)) v.cosmetics.tokenSeasons.push(season);
    return season;
  }
  // First v2 contact converts the retired v1 goods, once. The goods
  // zero out; pieces and postcards land in the v2 state. A balance
  // with nothing in it converts silently (no record to show).
  function ensureV2(p, day) {
    const v = v2Of(p);
    if (v.conversionDone) return;
    v.conversionDone = true;
    const goods = {
      cowries: p.inventory.cowries, kola: p.inventory.kola,
      yams: p.inventory.yams, cloth: p.inventory.cloth
    };
    const total = goods.cowries + goods.kola + goods.yams + goods.cloth;
    if (total <= 0 && p.claimCount <= 0) return;
    const rate = SHELF_V2.conversion;
    const pieces = Math.min(rate.maxPieces, Math.ceil(total / rate.goodsPerPiece));
    const cardCount = Math.min(rate.maxPostcards, Math.floor(total / rate.goodsPerPostcard));
    const cards = [];
    for (let i = 0; i < cardCount; i++) {
      let idx = pickIndex(p.clientId + '|conversion|' + i, ALBUM.length);
      while (cards.includes(ALBUM[idx].id)) idx = (idx + 1) % ALBUM.length;
      cards.push(ALBUM[idx].id);
    }
    const season = activeSeason(v);
    for (const id of cards) grantCard(v, season, id, day);
    v.kolo.pieces = Math.min(SHELF_V2.piecesNeeded, v.kolo.pieces + pieces);
    p.inventory.cowries = 0;
    p.inventory.kola = 0;
    p.inventory.yams = 0;
    p.inventory.cloth = 0;
    v.converted = true;
    v.conversion = { goods, pieces, postcards: cards, day };
  }
  function liveTicket(v, day) {
    if (!v.ticket) return null;
    if (day && v.ticket.expiresDay && v.ticket.expiresDay < day) return null;
    return v.ticket;
  }
  function newTicket(day) {
    const t = SHELF_V2.ticket;
    return {
      kind: 'entry',
      table: t.table,
      venue: t.venue,
      tableFee: t.tableFee,
      credit: t.credit,
      issuedDay: day,
      expiresDay: addDays(day, SHELF_V2.ticketExpiryDays),
      transferable: false
    };
  }
  // Fill the one held-ticket slot from what is waiting: a completed
  // kolo first, then banked album tickets. A lapsed held ticket frees
  // the slot. Runs at every v2 contact (view or claim), so a waiting
  // kolo breaks the moment the slot clears.
  function issueTickets(p, day) {
    const v = v2Of(p);
    const live = liveTicket(v, day);
    if (live) { v.ticket = live; return; }
    v.ticket = null;
    if (v.kolo.completePending && v.kolo.pieces >= SHELF_V2.piecesNeeded) {
      v.kolo.pieces -= SHELF_V2.piecesNeeded;
      v.kolo.completePending = v.kolo.pieces >= SHELF_V2.piecesNeeded;
      v.ticket = newTicket(day);
      return;
    }
    if (v.pendingTickets > 0) {
      v.pendingTickets -= 1;
      v.ticket = newTicket(day);
    }
  }
  function pruneSecondChance(v, day) {
    v.secondChance = v.secondChance.filter((it) => it.expiresDay >= day);
  }
  function playedOn(p, day) {
    return !!(p.playedDays && p.playedDays[day]);
  }
  // The Day 7 chest: a full kolo breaks only on a day the player
  // played a match. Returns 'broke', 'waiting', 'blocked', or null.
  function settleKolo(p, day) {
    const v = v2Of(p);
    if (v.kolo.pieces < SHELF_V2.piecesNeeded) return null;
    if (!v.kolo.completePending) {
      if (!playedOn(p, day)) return 'blocked';
      v.kolo.completePending = true;
    }
    const before = v.ticket;
    issueTickets(p, day);
    return v.ticket && v.ticket !== before ? 'broke' : 'waiting';
  }
  function ensure(id) {
    if (!db.players[id]) db.players[id] = blank(id);
    return normalize(db.players[id]);
  }

  function resolve(body) {
    body = body || {};
    const sentId = body.clientId != null && String(body.clientId) !== '';
    const sentTok = body.token != null && String(body.token) !== '';
    const cid = cleanClientId(body.clientId);
    const tok = cleanToken(body.token);
    if (sentId && !cid) return { error: 'identity' };
    if (sentTok && !tok) return { error: 'identity' };
    if (!cid && !tok) return { error: 'identity' };
    if (cid && tok && db.tokens[tok] && db.tokens[tok] !== cid) return { error: 'mismatch' };
    if (cid) return { id: cid, token: tok };
    if (tok && db.tokens[tok]) return { id: db.tokens[tok], token: tok };
    return { error: 'identity' };
  }
  function bindToken(who) {
    if (who && who.token) db.tokens[who.token] = who.id;
  }

  function link(info) {
    info = info || {};
    const cid = cleanClientId(info.clientId);
    const tok = cleanToken(info.token);
    if (!cid) return null;
    const p = ensure(cid);
    const name = cleanName(info.name);
    if (name) p.name = name;
    if (tok) {
      db.tokens[tok] = cid;
      p.tokens = Array.isArray(p.tokens) ? p.tokens : [];
      if (!p.tokens.includes(tok)) {
        p.tokens.push(tok);
        if (p.tokens.length > 8) p.tokens.shift();
      }
    }
    save();
    return p;
  }

  function dayFrom(body, query) {
    const raw = body && body.day != null ? body.day : (query ? query.get('day') : null);
    if (raw == null || raw === '') return { day: lagosDay(new Date()) };
    if (!test) return { day: lagosDay(new Date()) };
    if (!validDay(raw)) return { error: 'day' };
    return { day: String(raw) };
  }

  function publicView(id, day) {
    const p = db.players[id] ? normalize(db.players[id]) : blank(id);
    const warmReady = !!p.lastClaimDay && p.lastClaimDay === prevDay(day);
    const view = {
      ok: true,
      day,
      canClaim: p.lastClaimDay !== day,
      warmReady,
      claimCount: p.claimCount,
      inventory: {
        cowries: p.inventory.cowries,
        kola: p.inventory.kola,
        yams: p.inventory.yams,
        cloth: p.inventory.cloth
      },
      push: {
        enabled: vapid.enabled,
        publicKey: vapid.publicKey,
        subscribed: !!(p.push && p.push.endpoint),
        muted: !!p.pushMuted,
        denied: !!p.pushDenied
      },
      nextDrop: p.lastClaimDay !== day ? {
        cowries: BASE_DROP.cowries + (warmReady ? WARM_EXTRA.cowries : 0),
        kola: BASE_DROP.kola + (warmReady ? WARM_EXTRA.kola : 0),
        yams: BASE_DROP.yams + (warmReady ? WARM_EXTRA.yams : 0),
        cloth: BASE_DROP.cloth + (warmReady ? WARM_EXTRA.cloth : 0)
      } : null,
      uses: {
        cowries: { cost: USES.cowries.cost, kind: USES.cowries.kind, amount: USES.cowries.amount },
        kola: { cost: USES.kola.cost, kind: USES.kola.kind, amount: USES.kola.amount },
        yams: { cost: USES.yams.cost, kind: USES.yams.kind, amount: USES.yams.amount },
        cloth: { cost: USES.cloth.cost, kind: USES.cloth.kind, amount: USES.cloth.amount }
      }
    };
    if (v2Active(p)) {
      // This shelf moved to the kolo shelf. The v1 fields keep their
      // shape and the stored goods stay readable, but the v1 drop is
      // closed: nothing new accrues here any more.
      view.canClaim = false;
      view.nextDrop = null;
    }
    return view;
  }

  function inventoryOf(p) {
    return {
      cowries: p.inventory.cowries,
      kola: p.inventory.kola,
      yams: p.inventory.yams,
      cloth: p.inventory.cloth
    };
  }
  // Debit the shelf. The table calls this when a seated player spends.
  // Claim stays goods-only. A short shelf does not go negative.
  function take(clientId, good) {
    const id = cleanClientId(clientId);
    const use = USES[good];
    if (!id || !use) return { ok: false, error: 'good' };
    if (!db.players[id]) return { ok: false, error: 'short' };
    const p = normalize(db.players[id]);
    if (p.inventory[good] < use.cost) return { ok: false, error: 'short' };
    p.inventory[good] -= use.cost;
    save();
    return {
      ok: true,
      good,
      cost: use.cost,
      kind: use.kind,
      amount: use.amount,
      inventory: inventoryOf(p)
    };
  }
  function restore(clientId, good, qty) {
    const id = cleanClientId(clientId);
    const use = USES[good];
    if (!id || !use || !db.players[id]) return;
    const p = normalize(db.players[id]);
    const n = Math.max(0, Math.floor(Number(qty) || use.cost));
    p.inventory[good] += n;
    save();
  }

  function claim(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const picked = dayFrom(body, null);
    if (picked.error) return { status: 400, body: { ok: false, error: picked.error } };
    const day = picked.day;
    const p = ensure(who.id);
    bindToken(who);
    const name = cleanName(body.name);
    if (name) p.name = name;
    if (p.lastClaimDay === day) {
      save();
      return {
        status: 200,
        body: Object.assign(publicView(who.id, day), {
          already: true,
          first: false,
          warm: false,
          granted: null,
          line: 'You don collect today market drop. The next one opens with Lagos dawn.'
        })
      };
    }
    if (v2Active(p)) {
      // Converted players claim on the kolo shelf only. The v1 claim
      // grants nothing, so no new v1 goods accrue after conversion.
      save();
      return {
        status: 200,
        body: Object.assign(publicView(who.id, day), {
          already: true,
          first: false,
          warm: false,
          granted: null,
          line: 'Your shelf don move to the kolo shelf. Open the new shelf to claim today drop.'
        })
      };
    }
    const warm = p.lastClaimDay === prevDay(day);
    const granted = {};
    for (const g of GOODS) {
      granted[g] = BASE_DROP[g] + (warm ? WARM_EXTRA[g] : 0);
      p.inventory[g] += granted[g];
    }
    const first = p.claimCount === 0;
    p.claimCount += 1;
    p.lastClaimDay = day;
    bumpStat('claims', day);
    save();
    return {
      status: 200,
      body: Object.assign(publicView(who.id, day), {
        already: false,
        first,
        warm,
        granted,
        line: warm
          ? 'Market remember you from yesterday. Extra cowries and kola dey your shelf. Spend them inside a match.'
          : 'Cowries, kola, yam and cloth don enter your shelf. Spend them inside a match.'
      })
    };
  }

  // The v2 view. Callers save after building it: a first view can
  // run the conversion, and any view can lapse a ticket and issue a
  // waiting one. The conversion record shows exactly once, in the
  // first v2 response that carries it.
  function publicViewV2(id, day) {
    const stored = !!db.players[id];
    const p = stored ? normalize(db.players[id]) : blank(id);
    if (stored) ensureV2(p, day);
    const v = v2Of(p);
    pruneSecondChance(v, day);
    issueTickets(p, day);
    const season = activeSeason(v);
    const page = v.album[String(season)] || {};
    const cards = ALBUM.map((c) => ({ id: c.id, name: c.name, family: c.family, count: page[c.id] || 0 }));
    const owned = cards.filter((c) => c.count > 0).length;
    const duplicates = cards.reduce((s, c) => s + Math.max(0, c.count - 1), 0);
    const ticket = liveTicket(v, day);
    const conv = v.conversion;
    v.conversion = null;
    return {
      ok: true,
      v: 2,
      day,
      canClaim: p.lastClaimDay !== day,
      claimCount: p.claimCount,
      kolo: {
        pieces: v.kolo.pieces,
        piecesNeeded: SHELF_V2.piecesNeeded,
        complete: v.kolo.completePending,
        full: v.kolo.pieces >= SHELF_V2.piecesNeeded,
        ticket: ticket ? {
          kind: ticket.kind,
          table: ticket.table,
          venue: ticket.venue,
          tableFee: ticket.tableFee,
          credit: ticket.credit,
          issuedDay: ticket.issuedDay,
          expiresDay: ticket.expiresDay,
          transferable: false
        } : null,
        pendingTickets: v.pendingTickets,
        target: {
          table: SHELF_V2.ticket.table,
          venue: SHELF_V2.ticket.venue,
          tableFee: SHELF_V2.ticket.tableFee,
          credit: SHELF_V2.ticket.credit
        }
      },
      secondChance: v.secondChance.map((it) => ({
        kind: it.kind,
        label: SECOND_CHANCE[it.kind].label,
        expiresDay: it.expiresDay,
        freeOnly: true,
        paidUsable: false
      })),
      album: {
        season,
        size: ALBUM.length,
        cards,
        owned,
        duplicates,
        completedSeasons: Object.keys(v.albumComplete).map(Number).sort((a, b) => a - b)
      },
      cosmetics: {
        items: SHELF_V2.cosmeticItems.map((it) => ({
          id: it.id,
          name: it.name,
          pieces: v.cosmetics.pieces[it.id] || 0,
          piecesNeeded: SHELF_V2.cosmeticPiecesNeeded,
          complete: (v.cosmetics.pieces[it.id] || 0) >= SHELF_V2.cosmeticPiecesNeeded
        })),
        token: v.cosmetics.tokenSeasons.length
          ? { name: SHELF_V2.albumTokenName, seasons: v.cosmetics.tokenSeasons.slice() }
          : null
      },
      streak: {
        week: v.streak.count,
        totalDays: v.totalDays,
        graceLeft: v.streak.graceWeek === weekKey(day) ? 0 : SHELF_V2.gracePerWeek,
        milestonesPaid: v.milestonesPaid.slice(),
        nextMilestone: SHELF_V2.milestones.find((m) => m > v.totalDays) || null
      },
      conversion: conv
        ? { goods: conv.goods, pieces: conv.pieces, postcards: conv.postcards.slice(), day: conv.day }
        : null,
      push: {
        enabled: vapid.enabled,
        publicKey: vapid.publicKey,
        subscribed: !!(p.push && p.push.endpoint),
        muted: !!p.pushMuted,
        denied: !!p.pushDenied
      }
    };
  }

  function claimV2(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const picked = dayFrom(body, null);
    if (picked.error) return { status: 400, body: { ok: false, error: picked.error } };
    const day = picked.day;
    const p = ensure(who.id);
    bindToken(who);
    const name = cleanName(body.name);
    if (name) p.name = name;
    ensureV2(p, day);
    if (p.lastClaimDay === day) {
      const view = publicViewV2(who.id, day);
      save();
      return {
        status: 200,
        body: Object.assign(view, {
          already: true,
          first: false,
          granted: null,
          chest: null,
          line: 'You don collect today kolo drop. The next one opens with Lagos dawn.'
        })
      };
    }
    const v = v2Of(p);
    const granted = { piece: 0, secondChance: null, postcard: null, cosmetic: null, milestone: null };
    // The run: consecutive Lagos days. One missed day is bridged by
    // the grace of the missed day's week, once per week, and the run
    // count only grows on claim days. An uncovered miss restarts the
    // run and empties the kolo with it. Total days never reset.
    let graced = false;
    let streakReset = false;
    const last = v.streak.lastDay;
    if (!last) {
      v.streak.count = 1;
    } else if (last === prevDay(day)) {
      v.streak.count += 1;
    } else if (last === addDays(day, -2) && v.streak.graceWeek !== weekKey(addDays(day, -1))) {
      v.streak.graceWeek = weekKey(addDays(day, -1));
      v.streak.count += 1;
      graced = true;
    } else {
      v.streak.count = 1;
      v.kolo.pieces = 0;
      v.kolo.completePending = false;
      streakReset = true;
    }
    v.streak.lastDay = day;
    v.totalDays += 1;
    // The day's kolo piece. A full kolo takes no more pieces.
    if (v.kolo.pieces < SHELF_V2.piecesNeeded) {
      v.kolo.pieces += 1;
      granted.piece = 1;
    }
    // Second chance, alternating by claim count, capped and expiring.
    pruneSecondChance(v, day);
    const kind = SHELF_V2.secondChanceKinds[v.claims % SHELF_V2.secondChanceKinds.length];
    v.claims += 1;
    if (v.secondChance.length < SHELF_V2.secondChanceCap) {
      v.secondChance.push({
        kind,
        expiresDay: addDays(day, SHELF_V2.secondChanceExpiryDays),
        freeOnly: true
      });
      granted.secondChance = kind;
    }
    // One postcard for the active album page.
    const card = ALBUM[pickIndex(who.id + '|' + day + '|' + v.claims, ALBUM.length)];
    granted.postcard = card.id;
    let albumCompleted = grantCard(v, activeSeason(v), card.id, day);
    // One cosmetic piece, in rotation. Permanent once it lands.
    const item = SHELF_V2.cosmeticItems.find(
      (it) => (v.cosmetics.pieces[it.id] || 0) < SHELF_V2.cosmeticPiecesNeeded
    );
    if (item) {
      v.cosmetics.pieces[item.id] += 1;
      granted.cosmetic = {
        item: item.id,
        pieces: v.cosmetics.pieces[item.id],
        complete: v.cosmetics.pieces[item.id] >= SHELF_V2.cosmeticPiecesNeeded
      };
    }
    // Total-day milestones: bonus pieces (never past a full kolo) and
    // a postcard that prefers a card the page still misses.
    for (const m of SHELF_V2.milestones) {
      if (v.totalDays !== m || v.milestonesPaid.includes(m)) continue;
      v.milestonesPaid.push(m);
      v.kolo.pieces = Math.min(SHELF_V2.piecesNeeded, v.kolo.pieces + SHELF_V2.milestonePieces);
      const seasonNow = activeSeason(v);
      const pageNow = v.album[String(seasonNow)] || {};
      let idx = pickIndex(who.id + '|milestone|' + m, ALBUM.length);
      for (let k = 0; k < ALBUM.length; k++) {
        if (!pageNow[ALBUM[(idx + k) % ALBUM.length].id]) { idx = (idx + k) % ALBUM.length; break; }
      }
      const mCard = ALBUM[idx];
      const done = grantCard(v, seasonNow, mCard.id, day);
      if (done) albumCompleted = done;
      granted.milestone = { totalDays: m, pieces: SHELF_V2.milestonePieces, postcard: mCard.id };
    }
    // The chest settles last, over the final piece count.
    const chest = settleKolo(p, day);
    const first = v.claims === 1;
    p.lastClaimDay = day;
    p.claimCount += 1;
    bumpStat('claims', day);
    const view = publicViewV2(who.id, day);
    save();
    let line;
    if (chest === 'broke') {
      line = 'The kolo don break! One ' + SHELF_V2.ticket.table + ' entry ticket dey your hand now.';
    } else if (chest === 'waiting') {
      line = 'Your kolo don full and ready. One ticket still dey your hand, so this one go break when that ticket clear.';
    } else if (chest === 'blocked') {
      line = 'Your kolo don full. Play one match today and the kolo go break into your entry ticket.';
    } else {
      line = 'One piece don enter your kolo. You don gather ' + view.kolo.pieces + ' of ' + SHELF_V2.piecesNeeded + '.';
    }
    if (albumCompleted) {
      line += ' Your Lagos Streets album page ' + albumCompleted + ' don complete: entry tickets and the '
        + SHELF_V2.albumTokenName + ' don land.';
    }
    if (granted.milestone) {
      line += ' Milestone: ' + granted.milestone.totalDays + ' total days. Extra pieces and one postcard don land.';
    }
    if (graced) line += ' One grace day cover the day wey you miss. Your run still dey alive.';
    if (streakReset) line += ' The run don restart, so the kolo start again.';
    return {
      status: 200,
      body: Object.assign(view, {
        already: false, first, granted, chest, graced, streakReset, albumCompleted, line
      })
    };
  }

  // Gift a duplicate postcard to another player's album. The sender
  // keeps at least one copy, so a gift can never uncomplete a page.
  // The receiver's page is opened if they have none; their own goods
  // still convert at their own first v2 contact.
  function gift(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const to = cleanClientId(body.toClientId);
    const card = ALBUM.find((c) => c.id === String(body.card || ''));
    if (!to || !card) return { status: 400, body: { ok: false, error: 'gift' } };
    if (to === who.id) return { status: 400, body: { ok: false, error: 'self' } };
    if (!db.players[who.id] || !db.players[to]) {
      return { status: 404, body: { ok: false, error: 'friend' } };
    }
    const picked = dayFrom(body, null);
    if (picked.error) return { status: 400, body: { ok: false, error: picked.error } };
    const day = picked.day;
    const from = normalize(db.players[who.id]);
    const fv = v2Of(from);
    const page = fv.album[String(activeSeason(fv))] || {};
    if ((page[card.id] || 0) < 2) {
      return {
        status: 200,
        body: { ok: false, error: 'nodupe', line: 'You need two of this postcard before you fit gift one.' }
      };
    }
    page[card.id] -= 1;
    const toPlayer = normalize(db.players[to]);
    if (!toPlayer.v2) toPlayer.v2 = blankV2();
    const tv = v2Of(toPlayer);
    const done = grantCard(tv, activeSeason(tv), card.id, day);
    issueTickets(toPlayer, day);
    save();
    return {
      status: 200,
      body: {
        ok: true,
        card: card.id,
        albumCompleted: done,
        line: 'You don send the ' + card.name + ' postcard. Your person go see am for their album.'
      }
    };
  }

  // The spend gate for v2 second-chance goods, the v2 twin of take().
  // The goods are free-table goods by shape (freeOnly on the item):
  // a spend from a paid room refuses. Paid rooms do not exist yet,
  // so no caller passes paid today; the condition is wired now, with
  // the item, so the rule predates the first paid table.
  function spendV2(clientId, kind, ctx) {
    const id = cleanClientId(clientId);
    if (!id || !SECOND_CHANCE[kind]) return { ok: false, error: 'good' };
    if (!db.players[id] || !db.players[id].v2) return { ok: false, error: 'short' };
    const p = db.players[id];
    const v = v2Of(p);
    const day = ctx && validDay(ctx.day) ? String(ctx.day) : lagosDay(new Date());
    pruneSecondChance(v, day);
    const idx = v.secondChance.findIndex((it) => it.kind === kind);
    if (idx < 0) return { ok: false, error: 'short' };
    const item = v.secondChance[idx];
    if (item.freeOnly && ctx && ctx.paid) return { ok: false, error: 'paid', freeOnly: true };
    v.secondChance.splice(idx, 1);
    save();
    return { ok: true, kind, expiresDay: item.expiresDay, held: v.secondChance.length };
  }

  // The room-finish path marks every seated human: that seat's Lagos
  // day counts as played, which is what the Day 7 chest checks. The
  // records store cannot answer per player and day, so the shelf
  // keeps this tiny honest mark itself, pruned to a three-day window.
  function markPlayed(clientIds, day) {
    const d = validDay(day) ? String(day) : lagosDay(new Date());
    let changed = false;
    for (const raw of clientIds || []) {
      const id = cleanClientId(raw);
      if (!id || !db.players[id]) continue;
      const p = db.players[id];
      if (!p.playedDays || typeof p.playedDays !== 'object') p.playedDays = {};
      if (!p.playedDays[d]) { p.playedDays[d] = true; changed = true; }
      for (const k of Object.keys(p.playedDays)) {
        if (k < addDays(d, -2)) delete p.playedDays[k];
      }
    }
    if (changed) save();
  }

  function normalizeSub(s) {
    if (!s || typeof s !== 'object') return null;
    const endpoint = String(s.endpoint || '');
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000) return null;
    const keys = s.keys || {};
    const p256dh = String(keys.p256dh || '');
    const auth = String(keys.auth || '');
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(p256dh)) return null;
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(auth)) return null;
    return { endpoint, keys: { p256dh, auth } };
  }

  function subscribe(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const sub = normalizeSub(body.subscription);
    if (!sub) return { status: 400, body: { ok: false, error: 'subscription' } };
    const p = ensure(who.id);
    bindToken(who);
    const name = cleanName(body.name);
    if (name) p.name = name;
    p.push = sub;
    p.pushMuted = false;
    p.pushDenied = false;
    save();
    return { status: 200, body: { ok: true, subscribed: true, muted: false } };
  }
  function mute(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const p = ensure(who.id);
    bindToken(who);
    p.pushMuted = !!body.muted;
    if (!body.muted) p.pushDenied = false;
    save();
    return { status: 200, body: { ok: true, muted: p.pushMuted } };
  }
  function denied(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const p = ensure(who.id);
    bindToken(who);
    p.pushDenied = true;
    p.pushMuted = true;
    save();
    return { status: 200, body: { ok: true, denied: true } };
  }
  function unsubscribe(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const p = ensure(who.id);
    bindToken(who);
    p.push = null;
    p.pushMuted = true;
    save();
    return { status: 200, body: { ok: true, subscribed: false } };
  }

  function nudgePayload(kind) {
    const src = NUDGES[kind] || NUDGES.drop;
    return { title: src.title, body: src.body, tag: src.tag, url: src.url };
  }

  async function deliver(id, kind, opts) {
    opts = opts || {};
    const p = db.players[id] ? normalize(db.players[id]) : null;
    if (!p) return { sent: false, reason: 'nosub' };
    if (p.pushDenied) return { sent: false, reason: 'denied' };
    if (p.pushMuted) return { sent: false, reason: 'muted' };
    if (!p.push || !p.push.endpoint) return { sent: false, reason: 'nosub' };
    const nowMs = Date.now();
    if (!opts.force && p.lastNudgeAt[kind] && nowMs - p.lastNudgeAt[kind] < (test ? 0 : NUDGE_GAP_MS)) {
      return { sent: false, reason: 'throttle' };
    }
    if (kind === 'drop' && !opts.force && p.lastDropNudgeDay && opts.day && p.lastDropNudgeDay === opts.day) {
      return { sent: false, reason: 'already' };
    }
    const payload = nudgePayload(kind);
    p.lastNudgeAt[kind] = nowMs;
    if (kind === 'drop' && opts.day) p.lastDropNudgeDay = opts.day;
    save();
    if (test) {
      testLog.push({ clientId: id, kind, payload });
      return { sent: true, reason: 'test', payload };
    }
    try {
      const result = await sendWebPush(p.push, payload, vapid);
      if (result.status === 404 || result.status === 410) {
        p.push = null;
        save();
      }
      return { sent: !!result.sent, reason: result.reason, payload };
    } catch (e) {
      return { sent: false, reason: 'delivery' };
    }
  }

  function onSeatWaiting(player) {
    if (!player || player.bot || player.resigned || player.leftConfirmed) return;
    const id = cleanClientId(player.clientId);
    if (!id) return;
    deliver(id, 'waiting', {}).catch(() => {});
  }
  function onPot(room) {
    if (!room || room.mode === 'pass' || !room.pot) return;
    room.potMarks = room.potMarks || {};
    const hit = POT_MARKS.filter((n) => room.pot >= n && !room.potMarks[n]);
    if (!hit.length) return;
    for (const n of hit) room.potMarks[n] = true;
    for (const p of room.players || []) {
      if (!p || p.bot || p.connected || p.resigned || !p.clientId) continue;
      deliver(p.clientId, 'pot', {}).catch(() => {});
    }
  }
  async function sweepDrops(day) {
    const today = day || lagosDay(new Date());
    let sent = 0;
    for (const p of Object.values(db.players)) {
      if (!p || !p.push || p.pushMuted || p.pushDenied) continue;
      if (p.lastClaimDay === today) continue;
      if (p.lastDropNudgeDay === today) continue;
      const result = await deliver(p.clientId, 'drop', { day: today });
      if (result.sent) sent += 1;
    }
    return sent;
  }

  function emptyStats() {
    return { claims: {}, tablesStarted: {}, tablesFinished: {}, afk: {} };
  }
  function mergeStats(src) {
    const stats = emptyStats();
    if (!src || typeof src !== 'object') return stats;
    for (const kind of Object.keys(stats)) {
      const bucket = src[kind];
      if (!bucket || typeof bucket !== 'object') continue;
      for (const [day, n] of Object.entries(bucket)) {
        if (!validDay(day)) continue;
        const v = Math.floor(Number(n) || 0);
        if (v > 0) stats[kind][day] = v;
      }
    }
    return stats;
  }
  function pruneStats() {
    const keep = new Set();
    let cursor = lagosDay(new Date());
    for (let i = 0; i < 21; i++) {
      keep.add(cursor);
      cursor = prevDay(cursor);
    }
    for (const bucket of Object.values(db.stats)) {
      for (const day of Object.keys(bucket)) {
        if (!keep.has(day)) delete bucket[day];
      }
    }
  }
  function bumpStat(kind, day) {
    if (!db.stats[kind]) db.stats[kind] = {};
    const d = validDay(day) ? String(day) : lagosDay(new Date());
    db.stats[kind][d] = Math.floor(Number(db.stats[kind][d]) || 0) + 1;
    pruneStats();
  }
  function dayCount(kind, day) {
    const bucket = db.stats[kind] || {};
    return Math.floor(Number(bucket[day]) || 0);
  }
  // House ledger only. Counts and health. No shelf names, client ids,
  // reconnect tokens, or push key material.
  function noteDay(kind, day) {
    if (kind !== 'tablesStarted' && kind !== 'tablesFinished' && kind !== 'afk') return;
    bumpStat(kind, day);
    save();
  }
  function fileStatus() {
    if (memory) {
      const bytes = JSON.stringify(db).length;
      return { present: true, writable: true, bytes, override: false, label: 'durable-object' };
    }
    const fs = nodeFs();
    const usingOverride = !!(opts.env && String(opts.env.KP_RETENTION_FILE || '').trim());
    let present = false;
    let bytes = 0;
    let writable = false;
    try {
      const st = fs.statSync(file);
      present = st.isFile();
      bytes = st.size;
    } catch (e) { present = false; }
    try {
      fs.accessSync(path.dirname(file), fs.constants.W_OK);
      writable = true;
    } catch (e) { writable = false; }
    return {
      present,
      writable,
      bytes,
      override: usingOverride,
      label: usingOverride ? 'custom' : 'retention.json'
    };
  }
  function opsSummary() {
    const day = lagosDay(new Date());
    const yesterday = prevDay(day);
    let shelves = 0;
    let claimedToday = 0;
    let subscribers = 0;
    let muted = 0;
    let denied = 0;
    for (const p of Object.values(db.players)) {
      if (!p || typeof p !== 'object') continue;
      shelves += 1;
      if (p.lastClaimDay === day) claimedToday += 1;
      if (p.push && p.push.endpoint) subscribers += 1;
      if (p.pushMuted) muted += 1;
      if (p.pushDenied) denied += 1;
    }
    const roll = (kind) => dayCount(kind, day) + dayCount(kind, yesterday);
    return {
      day,
      yesterday,
      shelves,
      claimedToday,
      today: {
        claims: dayCount('claims', day),
        tablesStarted: dayCount('tablesStarted', day),
        tablesFinished: dayCount('tablesFinished', day),
        afkTakeovers: dayCount('afk', day)
      },
      rolling: {
        window: 'two Lagos days',
        claims: roll('claims'),
        tablesStarted: roll('tablesStarted'),
        tablesFinished: roll('tablesFinished'),
        afkTakeovers: roll('afk')
      },
      push: {
        enabled: !!vapid.enabled,
        source: vapid.source || 'off',
        subscribers,
        muted,
        denied
      },
      file: fileStatus()
    };
  }

  function accepts(req) {
    const clean = (req.url || '').split('?')[0];
    return clean === '/api/retention'
      || clean === '/api/retention/claim'
      || clean === '/api/retention/gift'
      || clean === '/api/push/vapid'
      || clean === '/api/push/subscribe'
      || clean === '/api/push/mute'
      || clean === '/api/push/denied'
      || clean === '/api/push/unsubscribe'
      || (test && (clean === '/api/test/nudge' || clean === '/api/test/sweep' || clean === '/api/test/push-roundtrip'));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > 8192) { reject(new Error('too big')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }
  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  }

  const TEST_ROUTES = new Set(['/api/test/nudge', '/api/test/sweep', '/api/test/push-roundtrip']);

  function handle(req, res) {
    const clean = (req.url || '').split('?')[0];
    const query = (() => { try { return new URL(req.url, 'http://localhost').searchParams; } catch (e) { return new URLSearchParams(); } })();
    Promise.resolve().then(async () => {
      if (!test && TEST_ROUTES.has(clean)) {
        sendJson(res, 404, { ok: false, error: 'no route' });
        return;
      }
      if (req.method === 'GET' && clean === '/api/push/vapid') {
        sendJson(res, 200, { ok: true, enabled: vapid.enabled, publicKey: vapid.publicKey });
        return;
      }
      if (test && req.method === 'GET' && clean === '/api/test/push-roundtrip') {
        roundtripSelfTest();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && clean === '/api/retention') {
        const picked = dayFrom({ day: query.get('day') }, null);
        if (picked.error) { sendJson(res, 400, { ok: false, error: picked.error }); return; }
        const who = resolve({ clientId: query.get('clientId'), token: query.get('token') });
        if (who.error) { sendJson(res, 400, { ok: false, error: who.error }); return; }
        if (String(query.get('v') || '') === '2') {
          const view = publicViewV2(who.id, picked.day);
          save();
          sendJson(res, 200, view);
          return;
        }
        sendJson(res, 200, publicView(who.id, picked.day));
        return;
      }
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
      const body = await readBody(req);
      if (clean === '/api/retention/claim') { const out = String(body.v) === '2' ? claimV2(body) : claim(body); sendJson(res, out.status, out.body); return; }
      if (clean === '/api/retention/gift') { const out = gift(body); sendJson(res, out.status, out.body); return; }
      if (clean === '/api/push/subscribe') { const out = subscribe(body); sendJson(res, out.status, out.body); return; }
      if (clean === '/api/push/mute') { const out = mute(body); sendJson(res, out.status, out.body); return; }
      if (clean === '/api/push/denied') { const out = denied(body); sendJson(res, out.status, out.body); return; }
      if (clean === '/api/push/unsubscribe') { const out = unsubscribe(body); sendJson(res, out.status, out.body); return; }
      if (test && clean === '/api/test/nudge') {
        const who = resolve(body);
        if (who.error) { sendJson(res, 400, { ok: false, error: who.error }); return; }
        const kind = NUDGES[body.kind] ? body.kind : 'drop';
        const result = await deliver(who.id, kind, { force: !!body.force, day: validDay(body.day) ? body.day : lagosDay(new Date()) });
        sendJson(res, 200, result);
        return;
      }
      if (test && clean === '/api/test/sweep') {
        const picked = dayFrom(body, null);
        if (picked.error) { sendJson(res, 400, { ok: false, error: picked.error }); return; }
        const before = testLog.length;
        const sent = await sweepDrops(picked.day);
        sendJson(res, 200, { ok: true, sent, nudges: testLog.slice(before) });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'no route' });
    }).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: 'bad request' });
    });
  }

  // Room objects queue shelf ops and the retention Durable Object applies
  // them on the authoritative db. Marks for the Owambe pot stay on the
  // room; this only delivers.
  function applyOps(ops) {
    const jobs = [];
    for (const op of ops || []) {
      if (!op || !op.op) continue;
      if (op.op === 'link') link(op.info);
      else if (op.op === 'take') take(op.clientId, op.good);
      else if (op.op === 'played') markPlayed(op.clientIds, op.day);
      else if (op.op === 'note') noteDay(op.kind);
      else if (op.op === 'waiting') onSeatWaiting(op.player);
      else if (op.op === 'pot') {
        for (const id of op.players || []) jobs.push(deliver(id, 'pot', {}));
      }
    }
    return Promise.all(jobs.map((j) => Promise.resolve(j).catch(() => {})));
  }

  async function handleFetch(request) {
    const url = new URL(request.url);
    const clean = url.pathname;
    const query = url.searchParams;
    const json = (status, obj) => new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
    });
    try {
      if (!test && TEST_ROUTES.has(clean)) return json(404, { ok: false, error: 'no route' });
      if (request.method === 'GET' && clean === '/api/push/vapid') {
        return json(200, { ok: true, enabled: vapid.enabled, publicKey: vapid.publicKey });
      }
      if (test && request.method === 'GET' && clean === '/api/test/push-roundtrip') {
        await roundtripSelfTest();
        return json(200, { ok: true });
      }
      if (request.method === 'GET' && clean === '/api/retention') {
        const picked = dayFrom({ day: query.get('day') }, null);
        if (picked.error) return json(400, { ok: false, error: picked.error });
        const who = resolve({ clientId: query.get('clientId'), token: query.get('token') });
        if (who.error) return json(400, { ok: false, error: who.error });
        if (String(query.get('v') || '') === '2') {
          const view = publicViewV2(who.id, picked.day);
          save();
          return json(200, view);
        }
        return json(200, publicView(who.id, picked.day));
      }
      if (request.method !== 'POST') return json(405, { ok: false, error: 'method' });
      const raw = await request.text();
      const body = raw ? JSON.parse(raw) : {};
      if (clean === '/api/retention/claim') { const out = String(body.v) === '2' ? claimV2(body) : claim(body); return json(out.status, out.body); }
      if (clean === '/api/retention/gift') { const out = gift(body); return json(out.status, out.body); }
      if (clean === '/api/push/subscribe') { const out = subscribe(body); return json(out.status, out.body); }
      if (clean === '/api/push/mute') { const out = mute(body); return json(out.status, out.body); }
      if (clean === '/api/push/denied') { const out = denied(body); return json(out.status, out.body); }
      if (clean === '/api/push/unsubscribe') { const out = unsubscribe(body); return json(out.status, out.body); }
      if (test && clean === '/api/test/nudge') {
        const who = resolve(body);
        if (who.error) return json(400, { ok: false, error: who.error });
        const kind = NUDGES[body.kind] ? body.kind : 'drop';
        const result = await deliver(who.id, kind, { force: !!body.force, day: validDay(body.day) ? body.day : lagosDay(new Date()) });
        return json(200, result);
      }
      if (test && clean === '/api/test/sweep') {
        const picked = dayFrom(body, null);
        if (picked.error) return json(400, { ok: false, error: picked.error });
        const before = testLog.length;
        const sent = await sweepDrops(picked.day);
        return json(200, { ok: true, sent, nudges: testLog.slice(before) });
      }
      return json(404, { ok: false, error: 'no route' });
    } catch (e) {
      return json(400, { ok: false, error: 'bad request' });
    }
  }

  return {
    vapid,
    accepts,
    handle,
    handleFetch,
    link,
    take,
    restore,
    spendV2,
    markPlayed,
    gift,
    onSeatWaiting,
    onPot,
    sweepDrops,
    noteDay,
    opsSummary,
    testLog,
    exportDb,
    applyOps
  };
}

module.exports = { createRetention, GOODS, BASE_DROP, WARM_EXTRA, USES, NUDGES, lagosDay, SHELF_V2, ALBUM, SECOND_CHANCE };
