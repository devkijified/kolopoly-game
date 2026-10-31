'use strict';
// KOLOPOLY server. Server authoritative: clients send intents only.
// This file owns dice, money, deeds, auctions, trades and timers.
// Design sources: ~/workspace/research_notes/kolopoly-design-brief-20261026.md
// as amended by ~/workspace/research_notes/kolopoly-nostalgia-research-20261026.md
const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const D = require('./public/game-data.js');
const { BotBrain, BOT_NAMES } = require('./bot.js');
const { createRetention } = require('./retention');
const { createOps } = require('./ops');
const records = require('./server-records.js');

const PORT = process.env.PORT || 4173;
const TEST = process.env.KP_TEST === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
// The open home-screen tab only notices a deploy when this id moves.
// It is a hash of the game files, stamped into the page and appended
// to the service worker so the worker script bytes change with them.
const BUILD_FILES = [
  'public/index.html',
  'public/app.js',
  'public/style.css',
  'public/sw.js',
  'public/retention.js',
  'public/update.js',
  'public/game-data.js',
  'public/board.js',
  'public/board3d.js',
  'public/manifest.webmanifest'
];
function computeBuild() {
  const hash = crypto.createHash('sha256');
  for (const rel of BUILD_FILES) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(__dirname, rel)));
  }
  return hash.digest('hex').slice(0, 12);
}
const BUILD = computeBuild();
function stampAsset(cleanUrl, data) {
  if (cleanUrl === '/' || cleanUrl === '/index.html') {
    return Buffer.from(String(data).split('__KOLOPOLY_BUILD__').join(BUILD));
  }
  if (cleanUrl === '/sw.js') {
    return Buffer.concat([data, Buffer.from('\n// kolopoly-build ' + BUILD + '\n')]);
  }
  return data;
}
const retention = createRetention({
  test: TEST,
  env: process.env,
  file: process.env.KP_RETENTION_FILE || path.join(__dirname, 'data', 'retention.json')
});
if (!retention.vapid.enabled) {
  console.log('Web Push is off until VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are set.');
}
if (!String(process.env.KP_ADMIN_TOKEN || '').trim()) {
  console.log('Ops locked until KP_ADMIN_TOKEN is set.');
} else {
  console.log('Ops desk is on /ops.');
}
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg'
};
const AUCTION_MS = TEST ? 4000 : 20000;
const MAX_PLAYERS = 6;
// Lesson 1: a room with nobody connected is not deleted on the spot. It
// survives a grace window (the host closed a tab, a train entered a tunnel)
// and only dies when the window passes with nobody back.
const ROOM_GRACE_MS = TEST ? 3000 : 600000;
// AFK: warn, then bot-takeover (capped), before the seat stalls the table.
// KP_TEST keeps the same windows as a real table. The old 8s test clock
// stole a quiet second phone in the middle of a scripted turn (the seat
// came back as "bot don comot"). Set KP_AFK_FAST=1 to use the short clock.
const AFK_FAST = TEST && process.env.KP_AFK_FAST === '1';
const AFK_WARN1_MS = AFK_FAST ? 2500 : 45000;
const AFK_WARN2_MS = AFK_FAST ? 5000 : 90000;
const AFK_TAKEOVER_MS = AFK_FAST ? 8000 : 150000;
const AFK_MAX_TAKEOVERS = 2;

const rooms = new Map();
let nextPlayerId = 1;
let tradeCounter = 0;

function makeCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  } while (rooms.has(code));
  return code;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const now = () => Date.now();

// ---------------------------------------------------------------------------
// Feed and money. Every money movement goes through moveMoney so the Alert
// (the client's phone style credit and debit cards) never misses one.
// ---------------------------------------------------------------------------
function pushFeed(room, kind, text, extra) {
  room.feedSeq += 1;
  const entry = Object.assign({ seq: room.feedSeq, kind, text }, extra || {});
  room.feed.push(entry);
  if (room.feed.length > 40) room.feed.splice(0, room.feed.length - 40);
  return entry;
}
function setMessage(room, text) { room.message = text; room.messageSeq += 1; room.banner = null; }
// KP13 WS4: addressee-directed lines (turn prompts and the like) are no
// longer one shared string. The server records a structured banner
// (key + actor + params) beside the shared fallback text, and each
// client renders the line from its own seat: second person for the
// actor, a third person report for everyone else. setMessage clears
// the banner, so any factual line replaces it wholesale.
function setBanner(room, key, actor, params, fallback) {
  setMessage(room, fallback);
  room.banner = Object.assign({ key, actorId: actor ? actor.id : null, name: actor ? actor.name : '' }, params || {});
}

function trackMin(player) { if (player.cash < player.minCash) player.minCash = player.cash; }

// from / to: a player object, or null for the bank.
// opts: { toPot, stat: 'rent'|'fine'|'salary'|'purchase'|'other', spaceName }
function moveMoney(room, from, to, amount, text, opts) {
  opts = opts || {};
  amount = Math.round(amount);
  if (amount <= 0) return;
  if (from) { from.cash -= amount; trackMin(from); }
  if (to) { to.cash += amount; if (to.cash > (to.peakCash || 0)) to.peakCash = to.cash; }
  if (!to && opts.toPot) {
    room.pot += amount;
    try { retention.onPot(room); } catch (e) { /* a whisper never blocks a payment */ }
  }
  if (from && opts.stat === 'fine') from.finesPaid.push(amount);
  if (to && opts.stat === 'rent') { to.lastRentReceived = amount; to.rentsReceived += amount; }
  if (from && opts.stat === 'rent') from.rentsPaid += amount;
  if (to) pushFeed(room, 'credit', text, { playerId: to.id, amount, otherId: from ? from.id : null, spaceName: opts.spaceName || null });
  if (from) pushFeed(room, 'debit', text, { playerId: from.id, amount, otherId: to ? to.id : null, spaceName: opts.spaceName || null });
}

// ---------------------------------------------------------------------------
// Property helpers
// ---------------------------------------------------------------------------
function prop(room, i) { return room.props[i]; }
function ownerOf(room, i) { const p = room.props[i]; return p && p.owner != null ? room.players.find((x) => x.id === p.owner) : null; }
function ownsSet(room, playerId, group) {
  return D.GROUP_SPACES[group].every((i) => room.props[i] && room.props[i].owner === playerId);
}
function setMortgaged(room, group) {
  return D.GROUP_SPACES[group].some((i) => room.props[i] && room.props[i].mortgaged);
}
function groupBuildings(room, group) {
  return D.GROUP_SPACES[group].reduce((s, i) => s + (room.props[i] ? room.props[i].buildings : 0), 0);
}
function buildingsValue(room, playerId) {
  let v = 0;
  for (const i of D.OWNABLE) {
    const p = room.props[i];
    if (p && p.owner === playerId && p.buildings > 0) v += (p.buildings >= 5 ? 5 : p.buildings) * D.SPACES[i].duplex;
  }
  return v;
}
function netWorth(room, player) {
  let w = player.cash;
  for (const i of D.OWNABLE) {
    const p = room.props[i];
    if (p && p.owner === player.id) w += p.mortgaged ? D.mortgageOf(D.SPACES[i].price) : D.SPACES[i].price;
  }
  return w + buildingsValue(room, player.id);
}
function rentFor(room, i, diceSum, rentMult) {
  const sp = D.SPACES[i];
  const p = room.props[i];
  if (!p || p.owner == null || p.mortgaged) return 0;
  const owner = room.players.find((x) => x.id === p.owner);
  if (!owner || owner.bankrupt) return 0;
  if (sp.type === 'station') {
    const count = D.STATIONS.filter((s) => room.props[s] && room.props[s].owner === p.owner).length;
    return 25000 * Math.pow(2, count - 1) * (rentMult || 1);
  }
  if (sp.type === 'utility') {
    const both = D.UTILITIES.every((s) => room.props[s] && room.props[s].owner === p.owner);
    return (diceSum || 0) * 1000 * (both ? 10 : 4);
  }
  if (p.buildings >= 5) return sp.rent[6];
  if (p.buildings > 0) return sp.rent[p.buildings + 1];
  if (ownsSet(room, p.owner, sp.group) && !setMortgaged(room, sp.group)) return sp.rent[1];
  return sp.rent[0];
}
function canBuildOn(room, playerId, i, kind) {
  // kind: 'duplex' or 'mansion'. Returns true if placing one is legal.
  const sp = D.SPACES[i];
  const p = room.props[i];
  if (!sp || sp.type !== 'street' || !p || p.owner !== playerId || p.mortgaged) return false;
  if (!ownsSet(room, playerId, sp.group) || setMortgaged(room, sp.group)) return false;
  if (D.GROUP_SPACES[sp.group].some((g) => room.props[g].pledged)) return false; // pledged set is frozen (spec 4.4)
  const bs = D.GROUP_SPACES[sp.group].map((g) => room.props[g].buildings);
  if (kind === 'duplex') {
    if (p.buildings >= 4) return false;
    return (p.buildings + 1) - Math.min(...bs) <= 1;
  }
  // mansion: target holds 4 duplexes and every other in the set holds 4 or a mansion
  if (p.buildings !== 4) return false;
  return bs.every((b) => b >= 4);
}
function eligibleForBuild(room, playerId, kind) {
  return D.OWNABLE.some((i) => canBuildOn(room, playerId, i, kind));
}

// ---------------------------------------------------------------------------
// Inflation Mode (spec: kolopoly-inflation-mode-spec-20261026.md).
// Phases squeeze salary down while street and station rent multiplies off the
// landing dice. Deals exist only as registered contracts. Classic rooms never
// touch any of this: every helper is gated on room.inf.
// ---------------------------------------------------------------------------
const INF_PRESETS = {
  quick: { durations: [480, 360, 600], horn: 300, p4Two: 600 },
  standard: { durations: [900, 720, 1200], horn: 600, p4Two: 600 },
  fullnight: { durations: [2700, 1800, Infinity], horn: 600, p4Two: 900, p4TotalAt: 9000 }
};
const INF_SALARIES = [200000, 100000, 50000, 25000];
const INF_INDEX = [1.0, 5.1, 17.9, 35.8];
const INF_PHASE_NAMES = ['Settling', 'Inflation', 'Sapa', 'Sudden Death'];
function isInf(room) { return room.settings && room.settings.gameMode === 'inflation'; }
function infPhase(room) { return room.inf ? room.inf.phase : 1; }
function stamp(room, kind, text, value, playerId) {
  room.stamps.push({ kind, text, value: value || 0, playerId: playerId || null, at: now(), phase: infPhase(room) });
  if (room.stamps.length > 120) room.stamps.splice(0, room.stamps.length - 120);
}
function activePassFor(room, buyerId, street, ownerId) {
  return room.contracts.find((c) => c.type === 'pass' && c.status === 'active' &&
    c.buyer === buyerId && c.street === street && c.seller === ownerId && c.chipsLeft > 0) || null;
}
function settlePassesAfterTransfer(room, street, newOwnerId, honour) {
  for (const c of room.contracts) {
    if (c.type !== 'pass' || c.status !== 'active' || c.street !== street) continue;
    if (honour) {
      c.seller = newOwnerId;
      pushFeed(room, 'contract', 'New owner don honour the Pass for ' + D.SPACES[street].name + '. Chips still dey.', { space: street });
    } else {
      c.status = 'expired'; c.chipsLeft = 0;
      pushFeed(room, 'contract', 'Pass for ' + D.SPACES[street].name + ' don die: the street don change owner.', { space: street });
    }
  }
}
// The bid cap of spec Section 3: liquid cash plus mortgage value of
// unmortgaged, unimproved deeds. Building sales are deliberately excluded.
function raiseCap(room, player) {
  let cap = player.cash;
  for (const i of D.OWNABLE) {
    const p = room.props[i];
    if (!p || p.owner !== player.id || p.mortgaged) continue;
    const sp = D.SPACES[i];
    if (sp.type === 'street' && groupBuildings(room, sp.group) > 0) continue;
    cap += D.mortgageOf(sp.price);
  }
  return cap;
}
function contractWindowOpen(room, player) {
  // Lesson 5 (players in parallel): the deal window is no longer tied to
  // whose turn it is. Deals may be proposed at any time the table is not
  // mid-resolution: no auction running, no other player's debt hanging, no
  // pause, and no mortgaged deed choice waiting on the proposer. The server
  // revalidates the terms against live state when the other side accepts.
  if (!isInf(room) || room.status !== 'playing' || player.bankrupt) return false;
  if (room.mode !== 'pass' && room.paused) return false;
  if (room.auction) return false; // G8: no deals while a payment is unresolved
  if (room.debt) {
    // Rescue exception (spec 4.5): the winning bidder inside their Rescue
    // Window may broadcast a loan request. Nothing else opens mid debt.
    return !!(room.debt.rescue && room.debt.playerId === player.id);
  }
  if ((room.pendingChoices[player.id] || []).length) return false;
  return true;
}
// Sapa Meter (Extension 3): worst rent the player could owe on their next roll.
function sapaFor(room, player) {
  if (!room.inf || player.bankrupt) return null;
  let exposure = 0;
  for (const i of D.OWNABLE) {
    const sp = D.SPACES[i];
    if (sp.type !== 'street' && sp.type !== 'station') continue;
    const p = room.props[i];
    if (!p || p.owner == null || p.owner === player.id || p.mortgaged) continue;
    const owner = room.players.find((x) => x.id === p.owner);
    if (!owner || owner.bankrupt) continue;
    const printed = rentFor(room, i, 0, 1);
    if (printed <= 0) continue;
    const covered = !!activePassFor(room, player.id, i, p.owner);
    const mult = covered ? 1 : (room.inf.phase === 1 ? 1 : 6);
    exposure = Math.max(exposure, printed * mult);
  }
  return { exposure, warn: player.cash < exposure };
}
function noteLap(room, player) {
  player.lastStartPassAt = now();
  if (!isInf(room)) return;
  for (const c of room.contracts) {
    if (c.type === 'loan' && c.status === 'active' && c.borrower === player.id) {
      c.lapsElapsed += 1;
      if (c.lapsElapsed >= c.termLaps) queueLoanDecision(room, c);
    }
  }
}

// ---------------------------------------------------------------------------
// Room and player construction
// ---------------------------------------------------------------------------
function sanitizeSettings(raw, isPublic) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const turn = [0, 30, 60, 120].includes(Number(s.turnTimerSec)) ? Number(s.turnTimerSec) : 60;
  const gameMode = s.gameMode === 'inflation' ? 'inflation' : 'classic';
  return {
    gameMode,
    preset: ['quick', 'standard', 'fullnight'].includes(s.preset) ? s.preset : 'standard',
    doubleStart: gameMode === 'inflation' ? false : !!s.doubleStart, // no double START pay in Inflation (spec 2.2)
    noRentInJail: !!s.noRentInJail,
    firstLapNoBuy: !!s.firstLapNoBuy,
    chaos: isPublic ? false : !!s.chaos, // chaos is refused in quick play
    timed: gameMode === 'inflation' ? false : (isPublic ? true : (s.timed === undefined ? true : !!s.timed)),
    turnTimerSec: turn,
    // Lesson 9: spoken payment announcements, host toggle, default on.
    // Every player can still mute or switch voice off on their own phone.
    voiceAlerts: s.voiceAlerts === undefined ? true : !!s.voiceAlerts
  };
}
function newPlayer(name, token, colorIdx) {
  return {
    id: nextPlayerId++, name, token: token || 'danfo',
    color: D.PLAYER_COLORS[colorIdx % D.PLAYER_COLORS.length],
    connected: true, ws: null, spectator: false,
    reconnectToken: crypto.randomBytes(12).toString('hex'), clientId: null,
    cash: D.START_CASH, position: 0, inJail: false, jailTurns: 0, bankrupt: false,
    goojf: [], doublesCount: 0, lap: 0, minCash: D.START_CASH,
    everMortgaged: false, kirikiriTrips: 0, lastRentReceived: 0,
    rentsReceived: 0, rentsPaid: 0, finesPaid: [], shield: false,
    shelfRent: false, shelfFee: false,
    chaosRole: null, firstRentForgiven: false, local: false,
    bot: false, botBrain: null,
    lastStartPassAt: 0, dealBreakLap: -1, sapaWindowUsed: false,
    peakCash: D.START_CASH, purchases: [], salaryNote2: false,
    resigned: false,
    lastActive: 0, afkWarn: 0, afkTaken: false, humanName: null
  };
}
// A persistent per-device id (localStorage UUID on the client). It lets a
// returning player reclaim their seat in a room instead of duplicating.
function cleanClientId(v) {
  const s = String(v || '');
  return /^[a-zA-Z0-9-]{8,64}$/.test(s) ? s : null;
}
// Bind a socket to an existing seat (reconnect resume and join reclaim share
// this): the newest socket wins, host falls back to the seat if the recorded
// host is gone, and the room unpauses if it was waiting on this player.
function bindSeat(ctx, ws, room, player, send) {
  // Close code 4001 tells the old client its seat was taken on purpose, so
  // it must not auto-reconnect and start a tab war over the seat.
  if (player.ws && player.ws !== ws && player.ws.readyState === 1) { try { player.ws.close(4001, 'seat taken'); } catch (e) { } }
  if (player.afkTaken && player.bot) reclaimAfkBot(room, player, ws);
  player.ws = ws;
  player.connected = true;
  touchActive(player);
  ctx.room = room; ctx.player = player; ctx.spectator = false;
  room.emptyAt = null;
  // Lesson 1: while the room is still a lobby, the host seat is held in
  // grace. A guest reconnecting must not inherit the host crown; the host
  // reclaims the lobby as host when they return. Mid game, host migration
  // to a connected player still applies.
  const hostP = room.players.find((p) => p.id === room.hostId);
  if (room.status !== 'lobby' && (!hostP || !hostP.connected)) room.hostId = player.id;
  updatePause(room);
  noteIdentity(player);
  send({ type: 'joined', playerId: player.id, code: room.code, token: player.reconnectToken, rejoined: true });
  broadcast(room);
}
// The shelf key is the device clientId, with the seat reconnect token
// as the second handle once this room has seen both.
function noteIdentity(player) {
  if (!player || player.bot) return;
  try { retention.link({ clientId: player.clientId, token: player.reconnectToken, name: player.name }); }
  catch (e) { /* the shelf never blocks a seat */ }
}
function newRoom(code, isPublic, mode, settings) {
  const props = {};
  for (const i of D.OWNABLE) props[i] = { owner: null, mortgaged: false, buildings: 0, mansionLap: -1, pledged: null };
  return {
    code, isPublic: !!isPublic, mode: mode || 'online', settings,
    players: [], spectators: new Set(), hostId: null,
    status: 'lobby', paused: false,
    props, duplexSupply: 32, mansionSupply: 12, pot: 0,
    decks: { wahala: shuffle(D.WAHALA.map((c) => c.id)), family: shuffle(D.FAMILY.map((c) => c.id)) },
    discard: { wahala: [], family: [] },
    turnOrder: [], turnIdx: 0, turnPlayerId: null,
    phase: 'roll', dice: null, buySpace: null, buyPrice: null,
    auction: null, bankAuctionQueue: [], debt: null,
    // Inflation Mode state (null in Classic): phase engine, contracts, stamps.
    inf: null, activePhase: 1, lastDice: null,
    contracts: [], contractProposal: null, dealBreak: null,
    loanDecision: null, loanDecisionQueue: [], stamps: [],
    contractCounter: 0, firstBankruptId: null,
    lastCard: null, pendingChoices: {}, // playerId -> [spaceIdx,...]
    trade: null, turnDeadline: null, gameEndsAt: null,
    bankInterest: 0, interestLine: null, dealOfGame: null, lastBuilderRoll: null,
    diceQueue: [], forcedCards: { wahala: null, family: null },
    feed: [], feedSeq: 0, message: '', messageSeq: 0, banner: null,
    winner: null, endTable: null, recordSaved: false, startedAt: null, createdAt: now(),
    endReason: null, emptyAt: null, pauseSince: null, pauseClockMs: null,
    afkTakeovers: 0
  };
}
function connectedSolvent(room) {
  return room.players.filter((p) => p.connected && !p.bankrupt);
}
function solventPlayers(room) { return room.players.filter((p) => !p.bankrupt); }
function curPlayer(room) { return room.players.find((p) => p.id === room.turnPlayerId) || null; }

function publicRoom(room) {
  const propsArr = [];
  for (let i = 0; i < 40; i++) {
    const p = room.props[i];
    propsArr.push(p ? { o: p.owner, m: p.mortgaged ? 1 : 0, b: p.buildings, pl: p.pledged ? 1 : 0 } : null);
  }
  const hostP = room.players.find((p) => p.id === room.hostId);
  return {
    code: room.code, isPublic: room.isPublic, mode: room.mode,
    status: room.status, paused: room.paused, hostId: room.hostId,
    hostAway: room.status === 'lobby' && !!hostP && !hostP.connected,
    pausedSince: room.pauseSince || null,
    pauseClockMs: room.pauseClockMs != null ? room.pauseClockMs : null,
    endReason: room.endReason || null,
    settings: room.settings,
    turnPlayerId: room.turnPlayerId, phase: room.phase,
    dice: room.dice, doublesCount: room.phase ? (curPlayer(room) ? curPlayer(room).doublesCount : 0) : 0,
    buySpace: room.buySpace, buyPrice: room.buyPrice, pot: room.pot,
    duplexSupply: room.duplexSupply, mansionSupply: room.mansionSupply,
    auction: room.auction ? {
      kind: room.auction.kind, space: room.auction.space,
      highBid: room.auction.highBid, highBidder: room.auction.highBidder,
      endsAt: room.auction.endsAt, passed: room.auction.passed,
      eligible: room.auction.eligible, minNext: room.auction.highBid > 0 ? room.auction.highBid + 1000 : 1000
    } : null,
    debt: room.debt ? { playerId: room.debt.playerId, to: room.debt.to, amount: room.debt.amount, reason: room.debt.reason, rescue: !!room.debt.rescue, rescueEndsAt: room.debt.rescueEndsAt || null } : null,
    buildPlace: room.buildPlace ? { playerId: room.buildPlace.playerId, kind: room.buildPlace.kind } : null,
    lastCard: room.lastCard,
    trade: room.trade ? {
      id: room.trade.id, from: room.trade.from, to: room.trade.to,
      offer: room.trade.offer, request: room.trade.request,
      expiresAt: room.trade.expiresAt || null, honourPass: room.trade.honourPass || []
    } : null,
    turnDeadline: room.turnDeadline, gameEndsAt: room.gameEndsAt,
    startedKey: room.startedKey || null,
    message: room.message, messageSeq: room.messageSeq,
    banner: room.banner || null,
    winner: room.winner, endTable: room.endTable,
    dealOfGame: room.dealOfGame || null,
    interestLine: room.interestLine || null,
    lastBuilderRoll: room.lastBuilderRoll || null,
    bankerGhost: room.firstBankruptId ? (room.players.find((p) => p.id === room.firstBankruptId) || {}).name || null : null,
    inf: room.inf ? {
      phase: room.inf.phase, phaseName: INF_PHASE_NAMES[room.inf.phase - 1],
      phaseEndsAt: room.inf.phaseEndsAt, hornAt: room.inf.hornAt,
      salary: INF_SALARIES[room.inf.phase - 1], index: INF_INDEX[room.inf.phase - 1],
      preset: room.inf.preset,
      dealBreakEndsAt: room.dealBreak ? room.dealBreak.endsAt : null,
      proposal: room.contractProposal ? {
        id: room.contractProposal.id, kind: room.contractProposal.kind,
        from: room.contractProposal.from, to: room.contractProposal.to,
        terms: room.contractProposal.terms, endsAt: room.contractProposal.endsAt
      } : null,
      loanDecision: room.loanDecision ? { contractId: room.loanDecision.contractId, endsAt: room.loanDecision.endsAt } : null,
      contracts: room.contracts.filter((c) => c.status === 'active').map((c) => c.type === 'pass'
        ? { id: c.id, type: 'pass', buyer: c.buyer, seller: c.seller, street: c.street, chipsLeft: c.chipsLeft, price: c.price, phaseCreated: c.phaseCreated }
        : { id: c.id, type: 'loan', borrower: c.borrower, lender: c.lender, pledgedSpace: c.pledgedSpace, amount: c.amount, interestPct: c.interestPct, dueTotal: c.amount + Math.floor(c.amount * c.interestPct / 100) + (c.dueExtra || 0), lapsElapsed: c.lapsElapsed, termLaps: c.termLaps, extended: !!c.extended })
    } : null,
    feed: room.feed.slice(-14),
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, token: p.token, connected: p.connected,
      isHost: p.id === room.hostId, bot: !!p.bot, afkTaken: !!p.afkTaken, cash: p.cash, position: p.position,
      inJail: p.inJail, bankrupt: p.bankrupt, resigned: !!p.resigned, goojf: p.goojf.length,
      chaosRole: p.chaosRole, kirikiriTrips: p.kirikiriTrips,
      shelfRent: !!p.shelfRent, shelfFee: !!p.shelfFee,
      sapa: room.inf ? sapaFor(room, p) : null,
      pendingChoice: (room.pendingChoices[p.id] || [])[0] !== undefined ? room.pendingChoices[p.id][0] : null,
      deeds: D.OWNABLE.filter((i) => room.props[i].owner === p.id).length,
      netWorth: room.status === 'playing' || room.status === 'ended' ? netWorth(room, p) : p.cash
    })),
    props: propsArr
  };
}
function broadcast(room) {
  const payload = JSON.stringify({ type: 'state', room: publicRoom(room) });
  const sent = new Set();
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1 && !sent.has(p.ws)) { p.ws.send(payload); sent.add(p.ws); }
  }
  for (const ws of room.spectators) {
    if (ws.readyState === 1 && !sent.has(ws)) { ws.send(payload); sent.add(ws); }
  }
}

// ---------------------------------------------------------------------------
// Dice and movement
// ---------------------------------------------------------------------------
function rollDice(room) {
  if (room.diceQueue.length) return room.diceQueue.shift();
  return [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
}
function salary(room, player, exactLanding) {
  let amount = D.START_PAY;
  if (isInf(room)) amount = INF_SALARIES[(room.activePhase || 1) - 1];
  else if (exactLanding && room.settings.doubleStart) amount = D.START_PAY * 2;
  let text = 'Salary alert don enter: ' + D.fmtN(amount) + ' for ' + player.name + '.';
  if (isInf(room) && room.activePhase === 2 && !player.salaryNote2) {
    // Lesson 2, named once, on the first Phase 2 salary (lessons doc Section 4).
    player.salaryNote2 = true;
    text += ' Your salary no reduce for real life o. Na price dey run, salary dey stand.';
  }
  moveMoney(room, null, player, amount, text, { stat: 'salary' });
}
// Move forward n spaces. Passing START pays salary. Returns true if wrapped.
function moveForward(room, player, n, opts) {
  opts = opts || {};
  const from = player.position;
  const raw = from + n;
  const wrapped = raw >= 40;
  player.position = raw % 40;
  if (wrapped) {
    player.lap += 1;
    noteLap(room, player);
    if (!opts.noSalary) salary(room, player, player.position === 0);
  }
  return wrapped;
}
function sendToKirikiri(room, player, reason) {
  player.position = 10;
  player.inJail = true;
  player.jailTurns = 0;
  player.doublesCount = 0;
  player.kirikiriTrips += 1;
  pushFeed(room, 'kirikiri', player.name + ' don land for Kirikiri. ' + (reason || ''), { playerId: player.id, trips: player.kirikiriTrips });
  setMessage(room, player.name + ' don land for Kirikiri. Bail na ' + D.fmtN(D.JAIL_FINE) + ', or roll double make you free.');
}

// Charge a player; if they cannot cover it from cash, the game enters the
// debt phase and waits for them to raise funds, trade, or go bankrupt.
// resume: tag handled by settleDebt. Returns true if paid at once.
function coverFineWithYam(room, player, amount, reason, opts) {
  // One yam covers the next bank fee or tax, up to ₦200,000. The market
  // pays the pot. Anything above the cap still comes out of the hand.
  if (!player || !player.shelfFee || !opts || opts.stat !== 'fine' || amount <= 0) return amount;
  const cover = Math.min(200000, amount);
  player.shelfFee = false;
  if (opts.toPot && cover > 0) {
    room.pot += cover;
    try { retention.onPot(room); } catch (e) { /* a whisper never blocks a fee */ }
  }
  pushFeed(room, 'info', player.name + ' yam cover ' + D.fmtN(cover) + ' of ' + reason + '. Market pay am.', { playerId: player.id, amount: cover });
  setMessage(room, 'Yam cover: ' + player.name + ' no pay ' + D.fmtN(cover) + ' (' + reason + ').');
  return amount - cover;
}
function charge(room, player, amount, to, reason, resume, opts) {
  opts = opts || {};
  amount = coverFineWithYam(room, player, amount, reason, opts);
  if (amount <= 0) { afterCharge(room, resume, player); return true; }
  if (player.cash >= amount) {
    payNow(room, player, amount, to, reason, opts);
    afterCharge(room, resume, player);
    return true;
  }
  room.debt = { playerId: player.id, to: to ? to.id : null, amount, reason, resume, opts };
  room.phase = 'debt';
  room.turnDeadline = room.settings.turnTimerSec ? now() + room.settings.turnTimerSec * 1000 : null;
  if (opts && opts.auctionWin) {
    // The owner's Phase 3 set piece (spec 4.5): 45 seconds to sell, mortgage or borrow.
    room.debt.rescue = true;
    room.debt.rescueEndsAt = now() + (TEST ? 8000 : 45000);
    setBanner(room, 'rescue', player, {}, player.name + ' win the auction but the money never complete. Rescue Window: sell buildings, mortgage deeds, or broadcast a loan request. 45 seconds.');
  } else {
    if (isInf(room) && room.activePhase === 3 && opts.stat === 'rent' && !player.sapaWindowUsed) {
      // One automatic 60 second Sapa Window for the first big Phase 3 rent (spec 4.5).
      player.sapaWindowUsed = true;
      room.turnDeadline = now() + 60000;
      pushFeed(room, 'info', 'Sapa Window: ' + player.name + ' get 60 seconds to raise ' + D.fmtN(amount) + ' for rent wey pass their cash.', { playerId: player.id, amount });
    }
    setBanner(room, 'debt', player, { amount: D.fmtN(amount), reason }, player.name + ' owes ' + D.fmtN(amount) + ' (' + reason + '). Sell duplexes, mortgage a deed, trade, or declare bankruptcy.');
  }
  checkAutoBankrupt(room);
  return false;
}
function payNow(room, player, amount, to, reason, opts) {
  opts = opts || {};
  moveMoney(room, player, to || null, amount,
    (to ? player.name + ' paid ' + D.fmtN(amount) + ' to ' + to.name + ': ' + reason
        : player.name + ' paid ' + D.fmtN(amount) + ': ' + reason),
    { toPot: !to && !!opts.toPot, stat: opts.stat || 'other', spaceName: opts.spaceName || null });
}
function afterCharge(room, resume, player) {
  if (!resume) return;
  if (resume === 'endPhase') { room.phase = 'end'; setDeadline(room); }
  else if (resume === 'rollAgain') { room.phase = 'roll'; setDeadline(room); setBanner(room, 'doubles', player, {}, player.name + ' rolled double. Roll again.'); }
  else if (resume === 'jailMove') {
    const sum = room.pendingJailMove || 0;
    room.pendingJailMove = null;
    moveForward(room, player, sum);
    resolveLanding(room, player, { diceSum: sum });
  } else if (resume === 'stay') { if (room.buildPlace) { room.phase = 'buildPlace'; setDeadline(room); } }
  else if (resume === 'backToRoll') { room.phase = 'roll'; setDeadline(room); }
  else if (resume === 'backToJail') { room.phase = 'jail'; setDeadline(room); }
}
function settleDebtIfPossible(room) {
  const d = room.debt;
  if (!d) return false;
  const player = room.players.find((p) => p.id === d.playerId);
  if (!player || player.bankrupt) { room.debt = null; return false; }
  if (player.cash < d.amount) { checkAutoBankrupt(room); return false; }
  const to = d.to != null ? room.players.find((p) => p.id === d.to) : null;
  room.debt = null;
  payNow(room, player, d.amount, to, d.reason, d.opts);
  setMessage(room, player.name + ' don settle the ' + D.fmtN(d.amount) + ' debt.');
  afterCharge(room, d.resume, player);
  return true;
}
function maxRaise(room, player) {
  let v = player.cash;
  for (const i of D.OWNABLE) {
    const p = room.props[i];
    if (p && p.owner === player.id) {
      if (p.buildings > 0) v += Math.floor(((p.buildings >= 5 ? 5 : p.buildings) * D.SPACES[i].duplex) / 2);
      else if (!p.mortgaged) v += D.mortgageOf(D.SPACES[i].price);
    }
  }
  return v;
}
function checkAutoBankrupt(room) {
  const d = room.debt;
  if (!d) return;
  const player = room.players.find((p) => p.id === d.playerId);
  if (player && !player.bankrupt && maxRaise(room, player) < d.amount) {
    // Lesson 13: this bankruptcy is a server auto action; the feed says so.
    declareBankruptcy(room, player, { auto: true });
  }
}

// ---------------------------------------------------------------------------
// Landing resolution. diceSum feeds utility rent; rentMult feeds card moves.
// ---------------------------------------------------------------------------
function resolveLanding(room, player, opts) {
  opts = opts || {};
  if (room.status !== 'playing' || player.bankrupt) return;
  if (opts.after) room.afterLanding = opts.after;
  const i = player.position;
  const sp = D.SPACES[i];
  room.buySpace = null;

  if (sp.type === 'street' || sp.type === 'station' || sp.type === 'utility') {
    const p = room.props[i];
    if (p.owner == null) {
      const firstLapBlock = room.settings.firstLapNoBuy && player.lap === 0;
      if (firstLapBlock) {
        setMessage(room, player.name + ' landed on ' + sp.name + ', but first lap no buying (house rule).');
        afterCharge(room, opts.after || 'endPhase', player);
        return;
      }
      room.buySpace = i;
      room.buyPrice = sp.price;
      if (isInf(room) && room.activePhase >= 3 && room.lastDice) {
        // Phase 3 lander price: bigger die x printed price (Ruling 2).
        room.buyPrice = Math.max(room.lastDice[0], room.lastDice[1]) * sp.price;
      }
      room.phase = 'buy';
      setDeadline(room);
      setMessage(room, player.name + ' landed on ' + sp.name + '. Buy am for ' + D.fmtN(room.buyPrice) + ', or send am to auction?');
      return;
    }
    if (p.owner !== player.id && !p.mortgaged) {
      const owner = room.players.find((x) => x.id === p.owner);
      const jailShelter = room.settings.noRentInJail && owner && owner.inJail;
      if (owner && !owner.bankrupt && !jailShelter) {
        let rent = rentFor(room, i, opts.diceSum, opts.rentMult);
        // Inflation multiplier: streets and stations only, dice arrivals only.
        // Card arrivals stay x1 (spec 2.2); utilities are never multiplied.
        let phaseMult = 1;
        if (isInf(room) && (sp.type === 'street' || sp.type === 'station') && !opts.cardMove && room.lastDice) {
          if (room.activePhase === 2) phaseMult = Math.min(room.lastDice[0], room.lastDice[1]);
          else if (room.activePhase >= 3) phaseMult = Math.max(room.lastDice[0], room.lastDice[1]);
        }
        const printedRent = rent;
        rent = rent * phaseMult;
        let forgiven = false;
        if (player.shield && rent > 0) {
          rent = Math.floor(rent / 2);
          player.shield = false;
          setMessage(room, 'Network wahala don cut the rent in half for ' + player.name + '.');
        }
        if (room.settings.chaos && player.chaosRole === 'lapo' && player.firstRentForgiven && rent > 0) {
          player.firstRentForgiven = false;
          forgiven = true;
          pushFeed(room, 'info', player.name + ' first rent don forgive (Lapo grace). Rent for ' + sp.name + ' na free.', { playerId: player.id, amount: rent });
        }
        if (rent > 0 && !forgiven) {
          // Passage chip fires before any money moves (spec 4.3).
          const pass = isInf(room) ? activePassFor(room, player.id, i, owner.id) : null;
          if (pass) {
            pass.chipsLeft -= 1;
            if (pass.chipsLeft <= 0) pass.status = 'consumed';
            pushFeed(room, 'contract', 'Pass used: ' + player.name + ' land for ' + sp.name + ' and pay ₦0. Rent wey cancel na ' + D.fmtN(rent) + '.', { playerId: player.id, amount: rent, space: i });
            stamp(room, 'passSave', player.name + ' use Pass for ' + sp.name + ' and save ' + D.fmtN(rent) + '.', rent, player.id);
            setMessage(room, 'Pass don cover am. ' + player.name + ' pay ₦0 rent for ' + sp.name + ' (printed ' + D.fmtN(printedRent) + (phaseMult > 1 ? ' x ' + phaseMult : '') + ').');
            afterCharge(room, opts.after || 'endPhase', player);
            return;
          }
          // One kola covers the next rent, up to ₦100,000. The market pays
          // the landlord, so the tenant feels the save and the owner still collects.
          const fullRent = rent;
          if (player.shelfRent && rent > 0) {
            player.shelfRent = false;
            const cover = Math.min(100000, rent);
            moveMoney(room, null, owner, cover,
              'Kola cover: market pay ' + owner.name + ' ' + D.fmtN(cover) + ' rent for ' + sp.name + '. ' + player.name + ' no pay that part.',
              { stat: 'rent', spaceName: sp.name });
            if (cover >= rent) {
              setMessage(room, 'Kola cover don pay the rent for ' + sp.name + '. ' + player.name + ' pay ₦0.');
              afterCharge(room, opts.after || 'endPhase', player);
              return;
            }
            rent -= cover;
          }
          const rentReason = phaseMult > 1
            ? 'Rent for ' + sp.name + ': ' + D.fmtN(printedRent) + ' x ' + phaseMult + ' (your roll) = ' + D.fmtN(fullRent) + (rent < fullRent ? '. You pay ' + D.fmtN(rent) + ' after kola' : '')
            : ('Rent for ' + sp.name + (rent < fullRent ? ' after kola cover' : ''));
          if (phaseMult > 1) stamp(room, 'rent', rentReason + ', paid by ' + player.name + ' to ' + owner.name + '.', rent, player.id);
          charge(room, player, rent, owner, rentReason, opts.after || 'endPhase',
            { stat: 'rent', spaceName: sp.name });
          return;
        }
      }
    }
    afterCharge(room, opts.after || 'endPhase', player);
    return;
  }

  if (sp.type === 'tax') {
    if (i === 4) {
      room.phase = 'tax';
      room.taxPlayer = player.id;
      room.taxAfter = opts.after || 'endPhase';
      setDeadline(room);
      setMessage(room, player.name + ' landed on FIRS Income Tax. Pay ' + D.fmtN(sp.amount) + ' flat, or 10 percent of total worth (' + D.fmtN(Math.floor(netWorth(room, player) * 0.10)) + ').');
      return;
    }
    charge(room, player, sp.amount, null, sp.name, opts.after || 'endPhase', { toPot: true, stat: 'fine' });
    return;
  }
  if (sp.type === 'card') { drawCard(room, player, sp.deck, opts); return; }
  if (sp.type === 'gotojail') {
    sendToKirikiri(room, player, 'Officers don bundle am.');
    afterCharge(room, 'endPhase', player);
    return;
  }
  if (sp.type === 'freeparking') {
    if (room.pot > 0) {
      const amount = room.pot;
      room.pot = 0;
      moveMoney(room, null, player, amount,
        'Owambe Grounds! ' + player.name + ' don collect the full pot, ' + D.fmtN(amount) + '. Spray am for everybody.',
        {});
      pushFeed(room, 'jackpot', player.name + ' collected the Owambe pot: ' + D.fmtN(amount) + '.', { playerId: player.id, amount });
    } else {
      setMessage(room, player.name + ' landed on Owambe Grounds. The pot empty. Nothing spray today.');
    }
    afterCharge(room, opts.after || 'endPhase', player);
    return;
  }
  // start, jail (just visiting): nothing happens.
  afterCharge(room, opts.after || 'endPhase', player);
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
function drawCard(room, player, deckName, opts) {
  opts = opts || {};
  let cardId;
  if (room.forcedCards[deckName]) { cardId = room.forcedCards[deckName]; room.forcedCards[deckName] = null; }
  else {
    if (!room.decks[deckName].length) {
      room.decks[deckName] = shuffle(room.discard[deckName]);
      room.discard[deckName] = [];
    }
    cardId = room.decks[deckName].shift();
  }
  const list = deckName === 'wahala' ? D.WAHALA : D.FAMILY;
  const card = list.find((c) => c.id === cardId) || list[0];
  // Held cards (Get Out of Kirikiri Free) stay with the player; all others cycle to the discard pile.
  if (card.fx.type !== 'goojf') room.discard[deckName].push(card.id);
  room.lastCard = { deck: deckName, id: card.id, text: card.text, playerId: player.id, seq: room.messageSeq + 1 };
  pushFeed(room, 'card', player.name + ' drew ' + (deckName === 'wahala' ? 'Wahala' : 'Family Meeting') + ': ' + card.text, { playerId: player.id });
  setMessage(room, (deckName === 'wahala' ? 'Wahala card: ' : 'Family Meeting card: ') + card.text);
  applyCard(room, player, card, opts);
}
function cardDone(room, player, opts) { afterCharge(room, (opts && opts.after) || 'endPhase', player); }

function applyCard(room, player, card, opts) {
  const fx = card.fx;
  const after = (opts && opts.after) || 'endPhase';
  switch (fx.type) {
    case 'goojf': {
      player.goojf.push(card.id);
      cardDone(room, player, opts);
      return;
    }
    case 'jail': {
      sendToKirikiri(room, player, 'Card talk am.');
      room.phase = 'end';
      setDeadline(room);
      return;
    }
    case 'bankPays': {
      moveMoney(room, null, player, fx.amount, 'Bank don pay ' + player.name + ' ' + D.fmtN(fx.amount) + '.', {});
      cardDone(room, player, opts);
      return;
    }
    case 'payBank': {
      charge(room, player, fx.amount, null, 'Card payment', after, { toPot: true, stat: 'fine' });
      return;
    }
    case 'collectEach': {
      let total = 0;
      for (const other of room.players) {
        if (other.id === player.id || other.bankrupt) continue;
        const amt = Math.min(fx.amount, other.cash);
        if (amt > 0) { moveMoney(room, other, player, amt, other.name + ' dropped ' + D.fmtN(amt) + ' for ' + player.name + '.', {}); total += amt; }
        // A player who cannot cover their share at all hands over what they
        // have; the birthday does not bankrupt anybody (house simplification).
        if (other.cash === 0 && fx.amount > 0 && amt === 0) { /* nothing to give */ }
      }
      setMessage(room, player.name + ' collected ' + D.fmtN(total) + ' from the table.');
      cardDone(room, player, opts);
      return;
    }
    case 'repairs': {
      let dup = 0, man = 0;
      for (const i of D.OWNABLE) {
        const p = room.props[i];
        if (p && p.owner === player.id) { if (p.buildings >= 5) man++; else dup += p.buildings; }
      }
      const amount = dup * fx.perDuplex + man * fx.perMansion;
      if (amount <= 0) { setMessage(room, player.name + ' get no buildings, so the omo onile bill na zero.'); cardDone(room, player, opts); return; }
      charge(room, player, amount, null, 'Repairs and settlement', after, { toPot: true, stat: 'fine' });
      return;
    }
    case 'moveTo': {
      const target = fx.space;
      if (target <= player.position && !(target === 0 && player.position === 0)) {
        player.lap += 1;
        noteLap(room, player);
        salary(room, player, target === 0);
      }
      player.position = target;
      resolveLanding(room, player, { after, cardMove: true });
      return;
    }
    case 'moveBack': {
      player.position = (player.position - fx.n + 40) % 40;
      resolveLanding(room, player, { after, cardMove: true });
      return;
    }
    case 'moveNearest': {
      const targets = fx.kind === 'station' ? D.STATIONS : D.UTILITIES;
      let target = targets.find((t) => t > player.position);
      if (target === undefined) { target = targets[0]; player.lap += 1; noteLap(room, player); salary(room, player, false); }
      player.position = target;
      resolveLanding(room, player, { after, rentMult: fx.rentMult || 1, diceSum: 7, cardMove: true });
      return;
    }
    case 'nepaLight': {
      if (room.props[12].owner === player.id) {
        moveMoney(room, null, player, fx.amount, 'NEPA na your own. The street don pay you ' + D.fmtN(fx.amount) + ' for darkness.', {});
        cardDone(room, player, opts);
      } else {
        charge(room, player, fx.amount, null, 'Generator money for NEPA darkness', after, { toPot: true, stat: 'fine' });
      }
      return;
    }
    case 'upNepa': {
      const amt = room.props[12].owner === player.id ? fx.ownerAmount : fx.amount;
      moveMoney(room, null, player, amt, 'Up NEPA! ' + player.name + ' collect ' + D.fmtN(amt) + '.', {});
      cardDone(room, player, opts);
      return;
    }
    case 'fakeAlert': {
      const amount = Math.min(fx.cap, player.lastRentReceived || 0, player.cash);
      if (amount <= 0) { setMessage(room, 'Fake alert card, but ' + player.name + ' never collect rent yet. Nothing to lose.'); cardDone(room, player, opts); return; }
      player.lastRentReceived = 0;
      charge(room, player, amount, null, 'Fake alert loss', after, { toPot: false, stat: 'other' });
      return;
    }
    case 'shield': {
      player.shield = true;
      setMessage(room, player.name + ' hold transfer shield: next rent go half.');
      cardDone(room, player, opts);
      return;
    }
    case 'lekkiRain': {
      const reds = D.GROUP_SPACES.red.filter((i) => room.props[i].owner === player.id);
      if (!reds.length) {
        moveMoney(room, null, player, fx.noneAmount, 'Mainland dryness bonus for ' + player.name + ': ' + D.fmtN(fx.noneAmount) + '.', {});
        cardDone(room, player, opts);
      } else {
        charge(room, player, fx.perProp * reds.length, null, 'Pumping water for Lekki flood', after, { toPot: true, stat: 'fine' });
      }
      return;
    }
    case 'fineRefund': {
      const last = player.finesPaid.pop();
      if (!last) { setMessage(room, 'No fine to refund for ' + player.name + ' yet.'); cardDone(room, player, opts); return; }
      const amount = Math.min(fx.cap, last);
      moveMoney(room, null, player, amount, 'Tales by Moonlight refund: ' + D.fmtN(amount) + ' back to ' + player.name + '.', {});
      cardDone(room, player, opts);
      return;
    }
    case 'sapa': {
      for (const p of room.players) {
        if (p.bankrupt) continue;
        if (p.cash > 1000000) { moveMoney(room, p, null, 20000, 'Sapa levy: ' + p.name + ' dropped ' + D.fmtN(20000) + ' into the Owambe pot.', { toPot: true }); }
        else if (p.cash < 200000) { moveMoney(room, null, p, 10000, 'Sapa relief: ' + D.fmtN(10000) + ' for ' + p.name + '.', {}); }
      }
      cardDone(room, player, opts);
      return;
    }
    case 'freeUnmortgage': {
      const mine = D.OWNABLE.filter((i) => room.props[i].owner === player.id && room.props[i].mortgaged);
      if (!mine.length) {
        moveMoney(room, null, player, 1000, 'No mortgage to lift, so the C of O joy na ' + D.fmtN(1000) + ' gist money for ' + player.name + '.', {});
      } else {
        const i = mine[0];
        room.props[i].mortgaged = false;
        pushFeed(room, 'info', player.name + ' lifted the mortgage on ' + D.SPACES[i].name + ' free, C of O don ready.', { playerId: player.id });
        setMessage(room, player.name + ' lifted the mortgage on ' + D.SPACES[i].name + ' free.');
      }
      cardDone(room, player, opts);
      return;
    }
    default: cardDone(room, player, opts); return;
  }
}

// ---------------------------------------------------------------------------
// Turn machinery
// ---------------------------------------------------------------------------
function setDeadline(room) {
  room.turnDeadline = room.settings.turnTimerSec ? now() + room.settings.turnTimerSec * 1000 : null;
}
function doRoll(room, player) {
  const [d1, d2] = rollDice(room);
  room.dice = [d1, d2];
  room.lastDice = [d1, d2];
  room.activePhase = infPhase(room);
  const isDouble = d1 === d2;
  if (isDouble) {
    player.doublesCount += 1;
    pushFeed(room, 'info', player.name + ' rolled ' + d1 + ' and ' + d2 + '. Double! Danfo horn don blow.', { playerId: player.id });
    if (player.doublesCount >= 3) {
      player.doublesCount = 0;
      sendToKirikiri(room, player, 'Three doubles in a row. Too much speed.');
      room.phase = 'end';
      setDeadline(room);
      broadcast(room);
      return;
    }
  } else {
    player.doublesCount = 0;
  }
  const after = isDouble ? 'rollAgain' : 'endPhase';
  moveForward(room, player, d1 + d2);
  resolveLanding(room, player, { diceSum: d1 + d2, after });
}
function endTurn(room) {
  room.buySpace = null;
  room.buyPrice = null;
  room.dice = null;
  room.lastCard = null;
  if (room.status !== 'playing') return;
  // Inflation: a fully claimed board ends Settling at this turn boundary,
  // with the normal phase ceremony (the owner's parlour rule).
  if (room.inf && room.inf.phase === 1 && D.OWNABLE.every((i) => room.props[i] && room.props[i].owner != null)) {
    advancePhase(room);
    setMessage(room, 'Every street, station and utility don get owner, so Settling don finish early. ' + room.message);
  }
  const alive = room.turnOrder.filter((id) => {
    const p = room.players.find((x) => x.id === id);
    return p && !p.bankrupt;
  });
  if (!alive.length) return;
  let idx = alive.indexOf(room.turnPlayerId);
  for (let step = 0; step < alive.length; step++) {
    idx = (idx + 1) % alive.length;
    const cand = room.players.find((x) => x.id === alive[idx]);
    if (cand && !cand.bankrupt) { room.turnPlayerId = cand.id; break; }
  }
  const next = curPlayer(room);
  if (next) {
    next.doublesCount = 0;
    room.phase = next.inJail ? 'jail' : 'roll';
    setDeadline(room);
    setBanner(room, next.inJail ? 'turn_jail' : 'turn', next, {}, 'Na your turn, ' + next.name + (next.inJail ? '. You dey Kirikiri.' : '. Roll the dice.'));
  }
  updatePause(room);
}
function updatePause(room) {
  if (room.mode === 'pass') { room.paused = false; room.pauseSince = null; room.pauseClockMs = null; return; }
  const was = room.paused;
  // Bots wait like everyone else: a table whose humans have all stepped
  // away pauses even when two bot seats are still "connected".
  const noHumanSeated = room.players.some((p) => p.bot)
    && !room.players.some((p) => !p.bot && p.connected && !p.bankrupt);
  room.paused = room.status === 'playing' && (connectedSolvent(room).length < 2 || noHumanSeated);
  if (room.paused && !was) {
    // Lesson 14: the pause speaks. Record when it started and the frozen
    // turn clock value so the waiting card can show both honestly.
    room.pauseSince = now();
    room.pauseClockMs = room.turnDeadline ? Math.max(0, room.turnDeadline - now()) : null;
  } else if (!room.paused && was) {
    // The turn clock was frozen for the whole pause: shift the deadline by
    // the paused stretch so nobody returns to an already fired timeout.
    if (room.turnDeadline && room.pauseSince) room.turnDeadline += now() - room.pauseSince;
    room.pauseSince = null;
    room.pauseClockMs = null;
  }
}

// ---------------------------------------------------------------------------
// Auctions (deed auctions and contested last building auctions)
// ---------------------------------------------------------------------------
function startAuction(room, a) {
  a.passed = [];
  a.eligible = solventPlayers(room).map((p) => p.id);
  a.highBid = 0;
  a.highBidder = null;
  a.endsAt = now() + AUCTION_MS;
  room.auction = a;
  room.phase = 'auction';
  room.turnDeadline = null;
  const label = a.kind === 'deed' ? D.SPACES[a.space].name : (a.kind === 'duplex' ? 'the last duplex' : 'the last mansion');
  setMessage(room, 'Auction don start for ' + label + '. Highest bidder carry am. No story.');
  pushFeed(room, 'auction', 'Auction open: ' + label + '.', {});
}
// A contested building auction that resolves with resume 'stay' must hand
// the turn back to the phase the builder was in when they built: startAuction
// clobbers room.phase, so the phase travels with the auction (resumePhase).
function stayPhaseOf(a) { return ['roll', 'jail', 'end', 'tax'].includes(a && a.resumePhase) ? a.resumePhase : 'roll'; }
function finishAuction(room) {
  const a = room.auction;
  if (!a) return;
  room.auction = null;
  const winner = a.highBidder != null ? room.players.find((p) => p.id === a.highBidder) : null;
  if (a.kind === 'deed') {
    if (winner && a.highBid > 0) {
      room.props[a.space].owner = winner.id;
      winner.purchases.push({ space: a.space, price: a.highBid, phase: infPhase(room) });
      pushFeed(room, 'deed', winner.name + ' won ' + D.SPACES[a.space].name + ' for ' + D.fmtN(a.highBid) + ' at auction.', { playerId: winner.id, amount: a.highBid });
      setMessage(room, winner.name + ' won the auction for ' + D.SPACES[a.space].name + ' at ' + D.fmtN(a.highBid) + '.');
      charge(room, winner, a.highBid, null, 'Auction price for ' + D.SPACES[a.space].name, a.resume || 'endPhase', { stat: 'purchase', spaceName: D.SPACES[a.space].name, auctionWin: isInf(room), auctionSpace: a.space, wasReAuction: !!a.reAuction });
    } else {
      setMessage(room, 'Nobody bid. ' + D.SPACES[a.space].name + ' stays with the bank.');
      afterCharge(room, a.resume || 'endPhase', curPlayer(room));
    }
  } else {
    // Building auction: winner pays the bid, then places the building.
    if (winner && a.highBid > 0) {
      const label = a.kind === 'duplex' ? 'duplex' : 'mansion';
      if (a.kind === 'duplex') room.duplexSupply -= 1; else room.mansionSupply -= 1;
      room.buildPlace = { playerId: winner.id, kind: a.kind, resume: a.resume || 'endPhase', resumePhase: a.resumePhase || null };
      room.phase = 'buildPlace';
      room.turnDeadline = room.settings.turnTimerSec ? now() + room.settings.turnTimerSec * 1000 : null;
      setMessage(room, winner.name + ' won the last ' + label + ' for ' + D.fmtN(a.highBid) + '. Choose where e go land.');
      charge(room, winner, a.highBid, null, 'Auction price for the last ' + label, 'stay', { stat: 'purchase' });
      if (room.debt) { /* debt flow takes over; placement waits in buildPlace */ }
    } else {
      setMessage(room, 'Nobody bid for the last building. E return to bank shelf.');
      if ((a.resume || 'endPhase') === 'stay') { room.phase = stayPhaseOf(a); setDeadline(room); }
      else afterCharge(room, a.resume || 'endPhase', curPlayer(room));
    }
  }
  broadcast(room);
}

// ---------------------------------------------------------------------------
// Bankruptcy and game end
// ---------------------------------------------------------------------------
function titlesFor(room, player, winner) {
  if (winner && player.id === winner.id) {
    if (!player.everMortgaged) return 'Certified Nepo Landlord';
    const lowest = Math.min(...room.players.map((p) => p.minCash));
    if (player.minCash <= lowest) return 'Lapo wey don blow';
    return 'Real Landlord of Lagos';
  }
  if (player.resigned) return 'Landlord wey resign';
  if (player.bankrupt) return 'Lapo (funds don finish)';
  if (player.kirikiriTrips >= 2) return 'Kirikiri Regular';
  const mostDeeds = Math.max(...room.players.map((p) => D.OWNABLE.filter((i) => room.props[i].owner === p.id).length));
  if (D.OWNABLE.filter((i) => room.props[i].owner === player.id).length >= mostDeeds && mostDeeds >= 4) return 'Estate Collector';
  return 'Tenant wey dey try';
}
function endGame(room, winner, why) {
  const finishing = room.status === 'playing';
  room.status = 'ended';
  room.winner = { playerId: winner.id, name: winner.name };
  room.endTable = room.players.map((p) => ({
    playerId: p.id, name: p.name, token: p.token, color: p.color, bot: !!p.bot,
    netWorth: netWorth(room, p), cash: p.cash, bankrupt: p.bankrupt, resigned: !!p.resigned,
    title: titlesFor(room, p, winner)
  })).sort((a, b) => b.netWorth - a.netWorth);
  room.phase = 'end';
  room.turnDeadline = null;
  room.gameEndsAt = null;
  room.dealOfGame = isInf(room) ? pickDealOfGame(room) : null;
  if (isInf(room)) {
    // Upgrade 2: lesson lines per player + the Real Table (cash restated at
    // Phase 1 purchasing power, deflated by the Inflation Index).
    const indexAtEnd = INF_INDEX[infPhase(room) - 1];
    for (const row of room.endTable) {
      const p = room.players.find((x) => x.id === row.playerId);
      row.realNetWorth = (row.netWorth - row.cash) + Math.round(row.cash / indexAtEnd);
      row.realCash = Math.round(row.cash / indexAtEnd);
      row.lessons = p ? playerLessons(room, p, winner, indexAtEnd) : [];
    }
    const toPlayers = room.contracts
      .filter((c) => c.type === 'loan' && c.status === 'repaid')
      .reduce((s, c) => s + Math.floor(c.amount * c.interestPct / 100) + (c.dueExtra || 0), 0);
    room.interestLine = 'Interest gist: players collect ' + D.fmtN(toPlayers) + ' interest from each other this game. The bank collect ' + D.fmtN(room.bankInterest || 0) + ' for mortgage interest.';
  }
  setMessage(room, 'Game don finish. ' + winner.name + ' na the real landlord. Net worth: ' + D.fmtN(netWorth(room, winner)) + '. ' + (why || ''));
  pushFeed(room, 'gameEnd', winner.name + ' wins Kolopoly with net worth ' + D.fmtN(netWorth(room, winner)) + '.', { playerId: winner.id, amount: netWorth(room, winner) });
  if (finishing) {
    try { retention.noteDay('tablesFinished'); } catch (e) { /* the ledger never blocks the close */ }
    // Save the finished game to the records store, exactly once per game.
    // Fire and forget: the write never delays or breaks the close, and
    // the guard keeps a re-ended room from writing the same game twice.
    if (!room.recordSaved) {
      room.recordSaved = true;
      try { records.recordMatch(room); } catch (e) { /* records never block the close */ }
    }
  }
}
function checkWinBySolvency(room) {
  const alive = solventPlayers(room);
  if (room.status === 'playing' && alive.length === 1) {
    endGame(room, alive[0], 'Everybody else don bankrupt.');
    return true;
  }
  return false;
}
function declareBankruptcy(room, player, opts) {
  opts = opts || {};
  if (player.bankrupt) return;
  const debt = room.debt && room.debt.playerId === player.id ? room.debt : null;
  const creditor = debt && debt.to != null ? room.players.find((p) => p.id === debt.to) : null;
  room.debt = null;
  // Inflation loans settle before the general asset handover (spec 4.4):
  // a bankrupt borrower's pledged deed is seized by the lender, non recourse.
  if (isInf(room)) {
    for (const c of room.contracts) {
      if (c.type === 'loan' && c.status === 'active' && c.borrower === player.id) {
        seizeLoan(room, c, 'The borrower don bankrupt.');
      } else if (c.type === 'loan' && c.status === 'active' && c.lender === player.id) {
        if (creditor) {
          c.lender = creditor.id;
          pushFeed(room, 'contract', 'The loan against ' + D.SPACES[c.pledgedSpace].name + ' don transfer to ' + creditor.name + ' with the bankruptcy.', { playerId: creditor.id });
        } else {
          c.status = 'cancelled';
          if (room.props[c.pledgedSpace]) room.props[c.pledgedSpace].pledged = null;
          pushFeed(room, 'contract', 'Loan against ' + D.SPACES[c.pledgedSpace].name + ' don cancel: the lender bankrupt to the bank.', {});
        }
      }
      if (c.type === 'pass' && c.status === 'active' && c.buyer === player.id) { c.status = 'expired'; c.chipsLeft = 0; }
    }
  }
  if (room.buildPlace && room.buildPlace.playerId === player.id) {
    if (room.buildPlace.kind === 'duplex') room.duplexSupply += 1; else room.mansionSupply += 1;
    room.buildPlace = null;
  }
  // Buildings sell back at half first; the cash joins what is handed over.
  for (const i of D.OWNABLE) {
    const p = room.props[i];
    if (p && p.owner === player.id && p.buildings > 0) {
      const val = Math.floor(((p.buildings >= 5 ? 5 : p.buildings) * D.SPACES[i].duplex) / 2);
      if (p.buildings >= 5) room.mansionSupply += 1; else room.duplexSupply += p.buildings;
      p.buildings = 0;
      player.cash += val;
    }
  }
  const myDeeds = D.OWNABLE.filter((i) => room.props[i].owner === player.id);
  if (creditor) {
    if (player.cash > 0) moveMoney(room, player, creditor, player.cash, player.name + ' don bankrupt. Everything go to ' + creditor.name + '.', {});
    for (const i of myDeeds) {
      room.props[i].owner = creditor.id;
      if (room.props[i].mortgaged) queueChoice(room, creditor, i);
      if (isInf(room)) settlePassesAfterTransfer(room, i, creditor.id, false);
    }
    for (const cid of player.goojf) creditor.goojf.push(cid);
    setMessage(room, player.name + ' don bankrupt. ' + creditor.name + ' collect everything.');
  } else {
    player.cash = 0;
    for (const cid of player.goojf) room.discard[cid.startsWith('w') ? 'wahala' : 'family'].push(cid);
    for (const i of myDeeds) {
      room.props[i].owner = null;
      room.props[i].mortgaged = false;
      room.props[i].buildings = 0;
      room.bankAuctionQueue.push(i);
      if (isInf(room)) settlePassesAfterTransfer(room, i, null, false);
    }
    setMessage(room, player.name + ' don bankrupt to the bank. Their deeds go auction one by one.');
  }
  player.goojf = [];
  player.bankrupt = true;
  player.inJail = false;
  if (!room.firstBankruptId) room.firstBankruptId = player.id;
  if (opts.resign) {
    pushFeed(room, 'bankrupt', player.name + ' don resign. Everything return to the bank.', { playerId: player.id });
  } else if (opts.auto) {
    // Lesson 13: forced by the server because nothing was left to raise.
    pushFeed(room, 'bankrupt', player.name + ' don bankrupt: nothing remain to raise for the debt.', { playerId: player.id, auto: true, reason: 'nothing left to raise' });
  } else {
    pushFeed(room, 'bankrupt', player.name + ' don bankrupt.' + (myDeeds.length > 0 ? ' No be say you no get property. Na cash finish you.' : ''), { playerId: player.id });
  }
  if (checkWinBySolvency(room)) { broadcast(room); return; }
  if (room.turnPlayerId === player.id) endTurn(room);
  else { room.phase = room.phase === 'debt' ? 'end' : room.phase; setDeadline(room); }
  updatePause(room);
}
// Lesson 11: leaving a running game is a resignation, never a ghost seat.
// Two solvent players left: the resignation is a concession and the other
// player wins at once. Three or more: the bank liquidation path runs
// (buildings cleared at half value into the handover, cash to the bank,
// deeds return unowned to the bank auction queue) and the game continues.
function doResign(room, player) {
  player.resigned = true;
  // KP13 WS2: a resignation is a confirmed leave, a decision, not a
  // dropped connection. The close handler reads this marker and never
  // parks the seat in the away/pause path.
  player.leftConfirmed = true;
  if (room.trade && (room.trade.from === player.id || room.trade.to === player.id)) {
    room.trade = null;
    pushFeed(room, 'info', player.name + ' don resign: the open trade don cancel.', { playerId: player.id });
  }
  if (room.contractProposal && (room.contractProposal.from === player.id || room.contractProposal.to === player.id)) {
    room.contractProposal = null;
    pushFeed(room, 'info', player.name + ' don resign: the open contract proposal don cancel.', { playerId: player.id });
  }
  const others = solventPlayers(room).filter((p) => p.id !== player.id);
  if (others.length <= 1) {
    const winner = others[0] || null;
    player.bankrupt = true;
    player.inJail = false;
    pushFeed(room, 'info', player.name + ' don resign.', { playerId: player.id });
    room.endReason = 'resignation';
    if (winner) endGame(room, winner, player.name + ' don resign. ' + winner.name + ' win by resignation.');
    updatePause(room);
    return;
  }
  declareBankruptcy(room, player, { resign: true });
}
function queueChoice(room, player, spaceIdx) {
  if (!room.pendingChoices[player.id]) room.pendingChoices[player.id] = [];
  room.pendingChoices[player.id].push(spaceIdx);
}

// ---------------------------------------------------------------------------
// Start of game
// ---------------------------------------------------------------------------
function startGame(room) {
  // a fresh key per start (including play-again rematches) so the
  // client's countdown ceremony runs for every game, not just the first
  room.startedKey = room.code + ':' + now();
  for (const i of D.OWNABLE) room.props[i] = { owner: null, mortgaged: false, buildings: 0, mansionLap: -1, pledged: null };
  room.duplexSupply = 32; room.mansionSupply = 12; room.pot = 0;
  room.decks = { wahala: shuffle(D.WAHALA.map((c) => c.id)), family: shuffle(D.FAMILY.map((c) => c.id)) };
  room.discard = { wahala: [], family: [] };
  room.bankAuctionQueue = [];
  room.auction = null; room.debt = null; room.trade = null; room.lastCard = null;
  room.pendingChoices = {};
  room.buildPlace = null; room.afterLanding = null;
  room.winner = null; room.endTable = null; room.recordSaved = false;
  for (const p of room.players) {
    p.cash = D.START_CASH; p.position = 0; p.inJail = false; p.jailTurns = 0;
    p.bankrupt = false; p.goojf = []; p.doublesCount = 0; p.lap = 0;
    p.minCash = D.START_CASH; p.everMortgaged = false; p.kirikiriTrips = 0;
    p.lastRentReceived = 0; p.rentsReceived = 0; p.rentsPaid = 0; p.finesPaid = [];
    p.shield = false; p.shelfRent = false; p.shelfFee = false; p.chaosRole = null; p.firstRentForgiven = false; p.resigned = false;
    p.lastStartPassAt = 0; p.dealBreakLap = -1; p.sapaWindowUsed = false;
    p.peakCash = D.START_CASH; p.purchases = []; p.salaryNote2 = false;
  }
  room.bankInterest = 0; room.interestLine = null;
  room.contracts = []; room.contractProposal = null; room.dealBreak = null;
  room.loanDecision = null; room.loanDecisionQueue = []; room.stamps = [];
  room.firstBankruptId = null; room.activePhase = 1; room.lastDice = null;
  room.inf = null;
  if (room.settings.gameMode === 'inflation') {
    const preset = INF_PRESETS[room.settings.preset] || INF_PRESETS.standard;
    room.inf = {
      preset: room.settings.preset, phase: 1,
      startedAt: now(), phaseEndsAt: now() + preset.durations[0] * 1000,
      hornAt: null, announced60: false, announced10: false,
      twoSolventSince: null
    };
  }
  // Chaos seats: one Nepo, one Lapo, clearly labelled in the lobby already.
  if (room.settings.chaos && room.players.length >= 2) {
    const idxs = shuffle(room.players.map((_, i) => i));
    const nepo = room.players[idxs[0]];
    const lapo = room.players[idxs[1]];
    nepo.chaosRole = 'nepo';
    nepo.cash += 500000;
    const freePool = [...D.GROUP_SPACES.brown, ...D.GROUP_SPACES.lightblue];
    const freeDeed = freePool[Math.floor(Math.random() * freePool.length)];
    room.props[freeDeed].owner = nepo.id;
    pushFeed(room, 'info', 'Chaos mode: ' + nepo.name + ' na Nepo. Extra ' + D.fmtN(500000) + ' and free deed for ' + D.SPACES[freeDeed].name + '.', { playerId: nepo.id });
    lapo.chaosRole = 'lapo';
    lapo.cash = 1000000;
    lapo.firstRentForgiven = true;
    pushFeed(room, 'info', 'Chaos mode: ' + lapo.name + ' na Lapo. Start na ' + D.fmtN(1000000) + ', first rent forgiven.', { playerId: lapo.id });
  }
  // Roll for first turn: highest roller opens.
  const rolls = room.players.map((p) => ({ id: p.id, r: Math.floor(Math.random() * 6) + Math.floor(Math.random() * 6) }));
  rolls.sort((a, b) => b.r - a.r);
  room.turnOrder = room.players.map((p) => p.id);
  // Rotate the join order so the highest roller starts.
  const startId = rolls[0].id;
  const k = room.turnOrder.indexOf(startId);
  room.turnOrder = room.turnOrder.slice(k).concat(room.turnOrder.slice(0, k));
  room.turnPlayerId = startId;
  room.status = 'playing';
  room.startedAt = now();
  for (const p of room.players) { if (!p.bot) { p.lastActive = room.startedAt; p.afkWarn = 0; p.afkTaken = false; } }
  room.afkTakeovers = 0;
  room.gameEndsAt = room.settings.timed ? now() + 3600 * 1000 : null;  const first = curPlayer(room);
  room.phase = 'roll';
  setDeadline(room);
  setBanner(room, 'opener', first, {}, 'Game don start. ' + first.name + ' rolled highest and opens. Na your turn, ' + first.name + '. Roll the dice.');
  updatePause(room);
  try { retention.noteDay('tablesStarted'); } catch (e) { /* the ledger never blocks a table */ }
}

// ---------------------------------------------------------------------------
// Inflation contracts and the phase clock (spec Sections 2, 4).
// ---------------------------------------------------------------------------
function queueLoanDecision(room, contract) {
  if (contract.status !== 'active' || contract.decisionOpen) return;
  contract.decisionOpen = true;
  if (room.loanDecision) { room.loanDecisionQueue.push(contract.id); return; }
  room.loanDecision = { contractId: contract.id, endsAt: now() + 30000 };
  const lender = room.players.find((p) => p.id === contract.lender);
  pushFeed(room, 'contract', 'Loan don due: ' + (lender ? lender.name : 'Lender') + ', choose: seize ' + D.SPACES[contract.pledgedSpace].name + ' or extend am once. 30 seconds.', { playerId: contract.lender });
  setMessage(room, 'Loan don due. The lender get 30 seconds to seize the pledged deed or extend the loan.');
}
function openNextLoanDecision(room) {
  room.loanDecision = null;
  while (room.loanDecisionQueue.length) {
    const id = room.loanDecisionQueue.shift();
    const c = room.contracts.find((x) => x.id === id);
    if (c && c.status === 'active' && c.decisionOpen) {
      room.loanDecision = { contractId: c.id, endsAt: now() + 30000 };
      return;
    }
  }
}
function seizeLoan(room, contract, reason, auto) {
  const lender = room.players.find((p) => p.id === contract.lender);
  const borrower = room.players.find((p) => p.id === contract.borrower);
  const i = contract.pledgedSpace;
  contract.status = 'seized';
  contract.decisionOpen = false;
  if (room.props[i]) { room.props[i].pledged = null; room.props[i].owner = contract.lender; }
  settlePassesAfterTransfer(room, i, contract.lender, false);
  pushFeed(room, 'contract', 'Loan seized: ' + (lender ? lender.name : 'The lender') + ' don collect ' + D.SPACES[i].name + ' from ' + (borrower ? borrower.name : 'the borrower') + '. The debt don finish, non recourse. ' + (reason || ''), { playerId: contract.lender, space: i, auto: !!auto, reason: auto ? 'loan decision timeout' : undefined });
  setMessage(room, 'Loan default: ' + D.SPACES[i].name + ' don move to the lender. Debt cancelled in full.');
  if (room.loanDecision && room.loanDecision.contractId === contract.id) openNextLoanDecision(room);
}
function resolveLoanDefault(room, contractId, choice, auto) {
  const c = room.contracts.find((x) => x.id === contractId);
  if (!c || c.status !== 'active') { if (room.loanDecision && room.loanDecision.contractId === contractId) openNextLoanDecision(room); return; }
  if (choice === 'extend' && !c.extended) {
    c.extended = true;
    c.decisionOpen = false;
    c.dueExtra = Math.floor(c.amount * 0.10);
    c.lapsElapsed = 0;
    c.termLaps = 1;
    c.phaseCreated = infPhase(room);
    pushFeed(room, 'contract', 'Loan extended: one more lap for extra ' + D.fmtN(c.dueExtra) + ' interest. Total interest no fit pass 40 percent.', { playerId: c.lender, auto: !!auto, reason: auto ? 'loan decision timeout' : undefined });
    setMessage(room, 'The lender don extend the loan by one lap.');
    if (room.loanDecision && room.loanDecision.contractId === c.id) openNextLoanDecision(room);
    return;
  }
  seizeLoan(room, c, choice === 'extend' ? 'Extension don already use.' : '', auto);
}
function advancePhase(room) {
  const inf = room.inf;
  if (!inf || inf.phase >= 4) return;
  inf.phase += 1;
  inf.announced60 = false;
  inf.announced10 = false;
  const preset = INF_PRESETS[inf.preset] || INF_PRESETS.standard;
  if (inf.phase < 4) {
    inf.phaseEndsAt = now() + preset.durations[inf.phase - 1] * 1000;
    inf.hornAt = null;
  } else {
    inf.phaseEndsAt = null;
    inf.hornAt = now() + preset.horn * 1000;
  }
  // Chips die at the end of the phase they were bought in (spec 4.3).
  for (const c of room.contracts) {
    if (c.type === 'pass' && c.status === 'active' && c.phaseCreated < inf.phase) {
      c.status = 'expired'; c.chipsLeft = 0;
      pushFeed(room, 'contract', 'Pass for ' + D.SPACES[c.street].name + ' don expire with the phase.', { space: c.street });
    }
    // Loans fall due at the end of the phase they were created in (spec 4.4 term cap).
    if (c.type === 'loan' && c.status === 'active' && c.phaseCreated < inf.phase) queueLoanDecision(room, c);
  }
  const salaryNow = INF_SALARIES[inf.phase - 1];
  pushFeed(room, 'phase', 'Phase ' + inf.phase + ': ' + INF_PHASE_NAMES[inf.phase - 1] + ' don land. Salary na ' + D.fmtN(salaryNow) + ' now. Inflation Index: ' + INF_INDEX[inf.phase - 1] + 'x.', {});
  if (inf.phase === 4) {
    const alive = solventPlayers(room);
    const leader = alive.slice().sort((a, b) => netWorth(room, b) - netWorth(room, a))[0];
    setMessage(room, 'Sudden Death don start. No new contracts. Salary na ' + D.fmtN(salaryNow) + '. Horn go blow in ' + Math.round(preset.horn / 60) + ' minutes. Current leader: ' + (leader ? leader.name : '') + ' with net worth ' + (leader ? D.fmtN(netWorth(room, leader)) : '') + '.');
  } else {
    setMessage(room, 'Inflation don land: Phase ' + inf.phase + ' (' + INF_PHASE_NAMES[inf.phase - 1] + '). Salary na ' + D.fmtN(salaryNow) + ' now. Rent don carry dice.');
  }
}
function infTick(room) {
  const inf = room.inf;
  if (!inf) return false;
  let changed = false;
  const t = now();
  // Deal Break expiry restores the paused turn timer (the game clock never pauses).
  if (room.dealBreak && t >= room.dealBreak.endsAt) {
    room.turnDeadline = room.dealBreak.savedDeadline ? t + Math.max(0, room.dealBreak.savedDeadline - room.dealBreak.startedAt) : null;
    room.dealBreak = null;
    setMessage(room, 'Deal Break don close. Back to the game.');
    changed = true;
  }
  if (room.contractProposal && t >= room.contractProposal.endsAt) {
    pushFeed(room, 'contract', 'One contract proposal don expire without answer. E don decline by time.', { auto: true, reason: 'proposal timeout' });
    room.contractProposal = null;
    changed = true;
  }
  if (room.trade && room.trade.expiresAt && t >= room.trade.expiresAt) {
    room.trade = null;
    pushFeed(room, 'timeout', 'Trade proposal don expire by time. For Inflation Mode, deals get 30 seconds.', { auto: true, reason: 'trade timeout' });
    setMessage(room, 'Trade proposal don expire. For Inflation Mode, deals get 30 seconds.');
    changed = true;
  }
  if (room.loanDecision && t >= room.loanDecision.endsAt) {
    const c = room.contracts.find((x) => x.id === room.loanDecision.contractId);
    // Auto rule (spec 4.4): extend once if never extended, otherwise seize. The server never leaves a loan in limbo.
    pushFeed(room, 'timeout', 'Loan decision time don finish: the server apply the auto rule (extend once, after that seize).', { playerId: c ? c.lender : null, auto: true, reason: 'loan decision timeout' });
    resolveLoanDefault(room, room.loanDecision.contractId, c && !c.extended ? 'extend' : 'seize', true);
    changed = true;
  }
  // Rescue Window timeout: the bid voids, fee to the pot, one barred re auction (spec 4.5).
  if (room.debt && room.debt.rescue && t >= room.debt.rescueEndsAt) {
    const d = room.debt;
    const debtor = room.players.find((p) => p.id === d.playerId);
    const space = d.opts ? d.opts.auctionSpace : null;
    room.debt = null;
    if (debtor && debtor.cash >= 50000) payNow(room, debtor, 50000, null, 'Failed bid fee', { toPot: true, stat: 'fine' });
    pushFeed(room, 'info', 'Rescue Window don close. The winning bid don void' + (debtor && debtor.cash >= 50000 ? ' and failed bid fee ' + D.fmtN(50000) + ' don enter the Owambe pot' : '') + '.', { playerId: d.playerId, auto: true, reason: 'rescue window timeout' });
    if (space != null && room.props[space]) {
      room.props[space].owner = null;
      if (!d.opts.wasReAuction && room.status === 'playing') {
        startAuction(room, { kind: 'deed', space, resume: d.resume || 'endPhase', reAuction: true, barred: d.playerId });
      } else {
        afterCharge(room, d.resume || 'endPhase', curPlayer(room));
      }
    } else {
      afterCharge(room, d.resume || 'endPhase', curPlayer(room));
    }
    changed = true;
  }
  if (inf.phase < 4 && inf.phaseEndsAt) {
    const remain = inf.phaseEndsAt - t;
    if (remain <= 60000 && remain > 10000 && !inf.announced60) {
      inf.announced60 = true;
      pushFeed(room, 'phase', 'Inflation dey come: 60 seconds to Phase ' + (inf.phase + 1) + '. Salary go drop to ' + D.fmtN(INF_SALARIES[inf.phase]) + ', rent go carry dice.', {});
      setMessage(room, 'Inflation dey come: 60 seconds to Phase ' + (inf.phase + 1) + '.');
      changed = true;
    }
    if (remain <= 10000 && remain > 0 && !inf.announced10) {
      inf.announced10 = true;
      setMessage(room, '10 seconds to Phase ' + (inf.phase + 1) + '. Hold your cash well.');
      changed = true;
    }
    if (remain <= 0) {
      // Phase 3 can end early: two survivors solvent together for a stretch move to Sudden Death (spec 2.3).
      advancePhase(room);
      changed = true;
    } else if (inf.phase === 3) {
      const alive = solventPlayers(room);
      if (alive.length === 2) {
        if (!inf.twoSolventSince) inf.twoSolventSince = t;
        const preset = INF_PRESETS[inf.preset] || INF_PRESETS.standard;
        if (t - inf.twoSolventSince >= preset.p4Two * 1000) { advancePhase(room); changed = true; }
        else if (preset.p4TotalAt && t - inf.startedAt >= preset.p4TotalAt * 1000) { advancePhase(room); changed = true; }
      } else {
        inf.twoSolventSince = null;
      }
    }
  }
  if (inf.phase === 4 && inf.hornAt && t >= inf.hornAt && room.status === 'playing') {
    const alive = solventPlayers(room);
    if (alive.length >= 2) {
      const mortgagesOf = (p) => D.OWNABLE.filter((i) => room.props[i].owner === p.id && room.props[i].mortgaged).length;
      const winner = alive.slice().sort((a, b) =>
        netWorth(room, b) - netWorth(room, a) || b.cash - a.cash ||
        mortgagesOf(a) - mortgagesOf(b) || (a.lastStartPassAt || 0) - (b.lastStartPassAt || 0))[0];
      endGame(room, winner, 'Phase 4 horn don blow. Richest landlord by net worth carry the game.');
      changed = true;
    }
  }
  return changed;
}
function playerLessons(room, player, winner, indexAtEnd) {
  // End screen lesson lines, generated from the player's own ledger
  // (lessons doc, Upgrade 2). No generic tips, no moralising: their numbers.
  const L = [];
  if (player.peakCash > player.cash * 1.25 && player.peakCash >= 500000) {
    L.push('You touch ' + D.fmtN(player.peakCash) + ' for this game, but you finish with ' + D.fmtN(player.cash) + '. At Phase 1 purchasing power, that ' + D.fmtN(player.cash) + ' na like ' + D.fmtN(Math.round(player.cash / indexAtEnd)) + '. Na so inflation chop cash wey siddon.');
  }
  const buys = (player.purchases || []).slice().sort((a, b) => a.phase - b.phase || a.price - b.price);
  if (buys.length) {
    const b0 = buys[0];
    if (room.props[b0.space] && room.props[b0.space].owner === player.id && D.SPACES[b0.space].type !== 'utility') {
      const r = rentFor(room, b0.space, 7, 1);
      if (r > 0) L.push('You buy ' + D.SPACES[b0.space].name + ' for ' + D.fmtN(b0.price) + ' for Phase ' + b0.phase + '. By the end, printed rent for am na ' + D.fmtN(r) + ' before dice even talk. Land no dey depreciate for this table.');
    }
  }
  for (const c of room.contracts) {
    if (c.type !== 'loan') continue;
    if (c.borrower === player.id && c.status === 'repaid') {
      const due = c.amount + Math.floor(c.amount * c.interestPct / 100) + (c.dueExtra || 0);
      L.push('You borrow ' + D.fmtN(c.amount) + ' against ' + D.SPACES[c.pledgedSpace].name + ' and pay back ' + D.fmtN(due) + '. The table lend you; the bank for worry you pass that one.');
    }
    if (c.borrower === player.id && c.status === 'seized') {
      L.push('You borrow ' + D.fmtN(c.amount) + ' against ' + D.SPACES[c.pledgedSpace].name + ' and the deed go for default. Non recourse save you: nobody fit chase you for balance.');
    }
  }
  if (winner && player.id === winner.id) {
    const stations = D.STATIONS.filter((i) => room.props[i].owner === player.id).length;
    const sets = Object.keys(D.GROUP_SPACES).filter((g) => ownsSet(room, player.id, g)).length;
    if (stations + sets >= 3) {
      L.push(player.name + ' survive on spread: ' + stations + ' station(s), ' + sets + ' full set(s), plenty income lines. Na so dem dey survive Sapa.');
    }
  }
  return L.slice(0, 3);
}
function pickDealOfGame(room) {
  // Extension 4: one line, chosen from the contract and price logs by value.
  let best = null;
  for (const s of room.stamps) {
    if (!['passSave'].includes(s.kind)) continue;
    if (!best || s.value > best.value) best = { text: s.text, value: s.value };
  }
  for (const c of room.contracts) {
    if (c.type === 'loan' && c.status === 'repaid') {
      const interest = Math.floor(c.amount * c.interestPct / 100) + (c.dueExtra || 0);
      const lender = room.players.find((p) => p.id === c.lender);
      const borrower = room.players.find((p) => p.id === c.borrower);
      const text = (borrower ? borrower.name : 'A borrower') + ' borrow ' + D.fmtN(c.amount) + ' from ' + (lender ? lender.name : 'a lender') + ' against ' + D.SPACES[c.pledgedSpace].name + ' and pay back with ' + D.fmtN(interest) + ' interest.';
      if (!best || interest > best.value) best = { text, value: interest };
    }
    if (c.type === 'loan' && c.status === 'seized') {
      const lender = room.players.find((p) => p.id === c.lender);
      const text = (lender ? lender.name : 'A lender') + ' seize ' + D.SPACES[c.pledgedSpace].name + ' on a defaulted ' + D.fmtN(c.amount) + ' loan. Non recourse, no story.';
      if (!best || c.amount > best.value) best = { text, value: c.amount };
    }
  }
  return best ? best.text : null;
}

// ---------------------------------------------------------------------------
// Manage actions: build, sell, mortgage, unmortgage (shared by intents)
// ---------------------------------------------------------------------------
function failFactory(send) { return (t) => send({ type: 'error', message: t }); }

function doBuild(room, player, i, kind, fail) {
  const sp = D.SPACES[i];
  if (!canBuildOn(room, player.id, i, kind)) { fail('You cannot build a ' + kind + ' on ' + (sp ? sp.name : 'that space') + ' now. You need the full set, even building, and no mortgage in the set.'); return false; }
  const cost0 = sp.duplex;
  if (kind === 'duplex') {
    if (room.duplexSupply <= 0) { fail('The bank don run out of duplexes. None left to build.'); return false; }
    if (room.duplexSupply === 1) {
      const rivals = solventPlayers(room).filter((p) => p.id !== player.id && eligibleForBuild(room, p.id, 'duplex'));
      if (rivals.length) {
        // Lesson 5 collision: a contested last building opens an auction,
        // and auctions stay serial to the turn. A parallel builder is told
        // plainly instead of hijacking the turn flow mid landing.
        if (room.turnPlayerId !== player.id) { fail('Na the last duplex be this and other landlords fit contest am. Only the turn player fit open the auction for am.'); return false; }
        if (player.cash < cost0) { fail('You no get the cash for this duplex.'); return false; }
        startAuction(room, { kind: 'duplex', space: i, resume: room.phase === 'buy' ? room.afterLanding || 'endPhase' : 'stay', resumePhase: room.phase });
        broadcast(room);
        return true;
      }
    }
  } else {
    if (room.mansionSupply <= 0) { fail('The bank don run out of mansions.'); return false; }
    if (room.mansionSupply === 1) {
      const rivals = solventPlayers(room).filter((p) => p.id !== player.id && eligibleForBuild(room, p.id, 'mansion'));
      if (rivals.length) {
        if (room.turnPlayerId !== player.id) { fail('Na the last mansion be this and other landlords fit contest am. Only the turn player fit open the auction for am.'); return false; }
        if (player.cash < cost0) { fail('You no get the cash for this mansion.'); return false; }
        startAuction(room, { kind: 'mansion', space: i, resume: room.phase === 'buy' ? room.afterLanding || 'endPhase' : 'stay', resumePhase: room.phase });
        broadcast(room);
        return true;
      }
    }
  }
  let cost = cost0;
  if (isInf(room) && room.inf && room.inf.phase >= 2) {
    // Build pricing (owner correction, overrides original Ruling 1): printed
    // build cost x the die, lowest die in Phase 2, bigger die from Phase 3,
    // exactly like rent. Builds are priced by a fresh public Builder's Roll
    // because building is a separate action from the move; the roll and the
    // maths are announced to the whole table.
    const [b1, b2] = rollDice(room);
    const die = room.inf.phase === 2 ? Math.min(b1, b2) : Math.max(b1, b2);
    cost = cost0 * die;
    room.lastBuilderRoll = { dice: [b1, b2], die, cost, printed: cost0, space: i, kind, playerId: player.id };
    pushFeed(room, 'info', 'Builder\'s Roll: ' + b1 + ' and ' + b2 + '. ' + (kind === 'mansion' ? 'Mansion fee' : 'Duplex') + ' for ' + sp.name + ' na printed ' + D.fmtN(cost0) + ' x ' + die + ' = ' + D.fmtN(cost) + '.', { playerId: player.id, amount: cost });
    stamp(room, 'build', player.name + ' build for ' + sp.name + ': printed ' + D.fmtN(cost0) + ' x ' + die + ' = ' + D.fmtN(cost) + '.', cost, player.id);
  }
  if (player.cash < cost) { fail('You need ' + D.fmtN(cost) + ' to build here.'); return false; }
  placeBuilding(room, player, i, kind);
  payNow(room, player, cost, null, (kind === 'duplex' ? 'Duplex' : 'Mansion') + ' for ' + sp.name, { stat: 'purchase', spaceName: sp.name });
  settleDebtIfPossible(room);
  return true;
}
function placeBuilding(room, player, i, kind) {
  const p = room.props[i];
  if (kind === 'duplex') { p.buildings += 1; room.duplexSupply -= 1; }
  else { p.buildings = 5; room.duplexSupply += 4; room.mansionSupply -= 1; p.mansionLap = player.lap; }
  if (kind === 'mansion') {
    pushFeed(room, 'deed', player.name + ' don build a MANSION for ' + D.SPACES[i].name + '. Landlord levels don change.', { playerId: player.id, space: i });
  }
  setMessage(room, player.name + ' built a ' + kind + ' on ' + D.SPACES[i].name + '.');
}
function doSellBuilding(room, player, i, fail) {
  const sp = D.SPACES[i];
  const p = room.props[i];
  if (!p || p.owner !== player.id || p.buildings <= 0) { fail('No building to sell on ' + (sp ? sp.name : 'that space') + '.'); return false; }
  if (sp.type === 'street' && D.GROUP_SPACES[sp.group].some((g) => room.props[g].pledged)) { fail('This set get a pledged deed. Buildings for the set don freeze.'); return false; }
  const bs = D.GROUP_SPACES[sp.group].map((g) => room.props[g].buildings);
  if (p.buildings < Math.max(...bs)) { fail('Sell evenly: sell from the fullest property in the set first.'); return false; }
  let value;
  if (p.buildings >= 5) {
    value = Math.floor((5 * sp.duplex) / 2);
    if (room.duplexSupply >= 4) { p.buildings = 4; room.duplexSupply -= 4; }
    else { p.buildings = 0; }
    room.mansionSupply += 1;
  } else {
    value = Math.floor(sp.duplex / 2);
    p.buildings -= 1;
    room.duplexSupply += 1;
  }
  moveMoney(room, null, player, value, 'Bank buy back building for ' + sp.name + ': ' + D.fmtN(value) + ' to ' + player.name + '.', {});
  setMessage(room, player.name + ' sold a building on ' + sp.name + ' for ' + D.fmtN(value) + '.');
  settleDebtIfPossible(room);
  return true;
}
function doMortgage(room, player, i, fail) {
  const sp = D.SPACES[i];
  const p = room.props[i];
  if (!p || p.owner !== player.id) { fail('That deed no be your own.'); return false; }
  if (p.mortgaged) { fail(sp.name + ' don already mortgage.'); return false; }
  if (p.pledged) { fail(sp.name + ' dey pledged as loan security. E no fit mortgage until the loan clear.'); return false; }
  if (sp.type === 'street' && groupBuildings(room, sp.group) > 0) {
    fail('Sell every building in the ' + D.GROUPS[sp.group].name + ' set first, then mortgage.');
    return false;
  }
  p.mortgaged = true;
  player.everMortgaged = true;
  const val = D.mortgageOf(sp.price);
  moveMoney(room, null, player, val, 'C of O don enter bank hand. ' + player.name + ' collect ' + D.fmtN(val) + ' for ' + sp.name + '.', {});
  setMessage(room, player.name + ' mortgaged ' + sp.name + ' for ' + D.fmtN(val) + '. Lift am back for ' + D.fmtN(D.unmortgageCost(sp.price)) + '.');
  settleDebtIfPossible(room);
  return true;
}
function doUnmortgage(room, player, i, fail) {
  const sp = D.SPACES[i];
  const p = room.props[i];
  if (!p || p.owner !== player.id || !p.mortgaged) { fail('That deed no dey mortgaged by you.'); return false; }
  const cost = D.unmortgageCost(sp.price);
  if (player.cash < cost) { fail('You need ' + D.fmtN(cost) + ' to lift this mortgage.'); return false; }
  p.mortgaged = false;
  room.bankInterest = (room.bankInterest || 0) + (cost - D.mortgageOf(sp.price));
  payNow(room, player, cost, null, 'Lift mortgage for ' + sp.name, { stat: 'other' });
  setMessage(room, player.name + ' lifted the mortgage on ' + sp.name + ' for ' + D.fmtN(cost) + '.');
  settleDebtIfPossible(room);
  return true;
}
function manageAllowed(room, player) {
  // Lesson 5 (players in parallel): management is not turn locked. Any
  // solvent player may build, sell, mortgage or unmortgage at any time,
  // validated against live state at execution. The blocks that remain are
  // the collision guards: an auction is resolving, a building placement is
  // pending, the game is paused waiting for a player, or another player's
  // debt is hanging (the debtor manages freely: raising money is the point).
  if (room.status !== 'playing' || player.bankrupt) return false;
  if (room.mode !== 'pass' && room.paused) return false;
  if (room.auction) return false;
  if (room.buildPlace) return false;
  if (room.debt) return room.debt.playerId === player.id;
  return true;
}

// ---------------------------------------------------------------------------
// Timers: auction clock, turn decision timer, game clock, bank auctions.
// ---------------------------------------------------------------------------
setInterval(() => {
  // Room hygiene (Lesson 1): a room with no connected player survives the
  // grace window, then dies. Any connection clears the clock (bindSeat and
  // the entry paths also clear it directly). Bots are permanently connected
  // but they are not people: only HUMANS hold a room open. When every human
  // has left a started game past the grace window, the game ends on the
  // spot (richest seat wins) and the room closes: bots never play alone.
  for (const room of [...rooms.values()]) {
    if (room.mode === 'pass') continue;
    if (room.players.some((p) => p.connected && !p.bot)) { room.emptyAt = null; continue; }
    if (room.emptyAt == null) room.emptyAt = now();
    if (now() - room.emptyAt >= ROOM_GRACE_MS) {
      if (room.status === 'playing' && room.players.some((p) => p.bot)) {
        const alive = solventPlayers(room);
        if (alive.length) {
          const winner = alive.slice().sort((a, b) => netWorth(room, b) - netWorth(room, a) || b.cash - a.cash)[0];
          room.endReason = 'abandoned';
          endGame(room, winner, 'Everybody don leave the table. The room don close.');
          broadcast(room);
        }
      }
      for (const p of room.players) if (p.botBrain) p.botBrain.kill();
      rooms.delete(room.code);
    }
  }
  for (const room of rooms.values()) {
    if (room.status !== 'playing' || room.paused) continue;
    let changed = false;
    if (room.inf) { if (infTick(room)) changed = true; if (room.status !== 'playing') { broadcast(room); continue; } }
    if (room.auction && now() >= room.auction.endsAt) { finishAuction(room); changed = true; }
    if (!room.auction && room.bankAuctionQueue.length && ['roll', 'end', 'jail'].includes(room.phase) && !room.debt) {
      // Deeds from a bank bankruptcy auction between decisions.
      const space = room.bankAuctionQueue.shift();
      startAuction(room, { kind: 'deed', space, resume: room.phase === 'roll' ? 'backToRoll' : room.phase === 'jail' ? 'backToJail' : 'endPhase' });
      changed = true;
    }
    if (room.gameEndsAt && now() >= room.gameEndsAt) {
      const alive = solventPlayers(room);
      if (alive.length) {
        const winner = alive.slice().sort((a, b) => netWorth(room, b) - netWorth(room, a) || b.cash - a.cash)[0];
        endGame(room, winner, 'Time don finish. Richest landlord carry the game.');
        changed = true;
      }
    }
    if (!changed && room.turnDeadline && now() >= room.turnDeadline && !room.auction && !room.debt) {
      const player = curPlayer(room);
      if (player && !player.bankrupt) {
        // Lesson 13: every one of these is a server auto action, and the
        // feed confesses it with the (auto) tag and its reason.
        const autoTag = { auto: true, reason: 'turn timer' };
        if ((room.pendingChoices[player.id] || []).length) {
          if (resolveMortgageChoice(room, player, 'interest')) { pushFeed(room, 'timeout', player.name + ' time don finish: the server pay the mortgage interest by itself.', Object.assign({ playerId: player.id }, autoTag)); changed = true; }
          else room.turnDeadline = now() + 30000;
        } else if (room.phase === 'roll') { pushFeed(room, 'timeout', player.name + ' time don finish: the dice roll by itself.', Object.assign({ playerId: player.id }, autoTag)); doRoll(room, player); changed = true; }
        else if (room.phase === 'jail') { pushFeed(room, 'timeout', player.name + ' time don finish: the Kirikiri dice roll by itself.', Object.assign({ playerId: player.id }, autoTag)); jailRoll(room, player); changed = true; }
        else if (room.phase === 'buy') { pushFeed(room, 'timeout', player.name + ' time don finish with no answer: the deed go auction.', Object.assign({ playerId: player.id }, autoTag)); declineBuy(room, player); changed = true; }
        else if (room.phase === 'tax') { pushFeed(room, 'timeout', player.name + ' time don finish: FIRS collect the smaller charge.', Object.assign({ playerId: player.id }, autoTag)); taxChoose(room, player, null); changed = true; }
        else if (room.phase === 'end') { pushFeed(room, 'timeout', player.name + ' time don finish: turn don pass.', Object.assign({ playerId: player.id }, autoTag)); endTurn(room); changed = true; }
        else if (room.phase === 'buildPlace') { room.turnDeadline = now() + 30000; }
      }
    } else if (!changed && room.debt && room.turnDeadline && now() >= room.turnDeadline) {
      // Debt waits for the player to raise funds; the clock just nudges.
      room.turnDeadline = now() + 30000;
      setMessage(room, 'Still waiting: ' + room.debt.reason + ' needs ' + D.fmtN(room.debt.amount) + '. Sell, mortgage, trade, or declare bankruptcy.');
      changed = true;
    }
    // AFK grace: warn twice, then bot-takeover (capped) so one phone-down seat cannot hang the table.
    if (room.status === 'playing' && !room.paused) {
      for (const p of room.players) {
        if (p.bot || p.bankrupt || p.resigned || !p.connected) continue;
        if (!p.lastActive) p.lastActive = room.startedAt || now();
        const idle = now() - p.lastActive;
        if (idle >= AFK_TAKEOVER_MS) {
          if (room.afkTakeovers < AFK_MAX_TAKEOVERS && convertHumanToAfkBot(room, p)) { changed = true; }
          else if (room.afkTakeovers >= AFK_MAX_TAKEOVERS && p.afkWarn < 3) {
            p.afkWarn = 3;
            try { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'notice', action: 'here', title: 'Seat dey idle', message: 'You don quiet too long. Tap I dey here, or the table go move without you.' })); } catch (e) { }
          }
        } else if (idle >= AFK_WARN2_MS && p.afkWarn < 2) {
          p.afkWarn = 2;
          try { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'notice', action: 'here', title: 'Still dey there?', message: 'One more quiet stretch and a bot go hold this seat. Tap I dey here.' })); } catch (e) { }
        } else if (idle >= AFK_WARN1_MS && p.afkWarn < 1) {
          p.afkWarn = 1;
          try { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'notice', action: 'here', title: 'You dey quiet', message: 'Tap I dey here so your seat no turn bot.' })); } catch (e) { }
        }
      }
    }
    if (changed) broadcast(room);
  }
}, 500);

function declineBuy(room, player) {
  const i = room.buySpace;
  room.buySpace = null;
  room.buyPrice = null;
  if (i == null) { room.phase = 'end'; return; }
  setMessage(room, player.name + ' decline ' + D.SPACES[i].name + '. Auction must follow, na the rule.');
  startAuction(room, { kind: 'deed', space: i, resume: room.afterLanding || 'endPhase' });
}
function taxChoose(room, player, choice) {
  const worth = netWorth(room, player);
  const flat = D.SPACES[4].amount;
  const pct = Math.floor(worth * 0.10);
  const amount = choice === 'flat' ? flat : choice === 'percent' ? pct : Math.min(flat, pct);
  room.taxPlayer = null;
  charge(room, player, amount, null, 'FIRS Income Tax', room.taxAfter || 'endPhase', { toPot: true, stat: 'fine' });
}
function jailRoll(room, player) {
  const [d1, d2] = rollDice(room);
  room.dice = [d1, d2];
  room.lastDice = [d1, d2];
  room.activePhase = infPhase(room);
  if (d1 === d2) {
    player.inJail = false;
    player.jailTurns = 0;
    setMessage(room, player.name + ' rolled double ' + d1 + '. Kirikiri don free am. Move ' + (d1 + d2) + '.');
    pushFeed(room, 'info', player.name + ' don comot for Kirikiri with double ' + d1 + '.', { playerId: player.id });
    moveForward(room, player, d1 + d2);
    resolveLanding(room, player, { diceSum: d1 + d2, after: 'endPhase' });
  } else {
    player.jailTurns += 1;
    if (player.jailTurns >= 3) {
      setMessage(room, player.name + ' no roll double three times. Bail na ' + D.fmtN(D.JAIL_FINE) + ' by force.');
      room.pendingJailMove = d1 + d2;
      charge(room, player, D.JAIL_FINE, null, 'Kirikiri bail', 'jailMove', { toPot: true, stat: 'fine' });
      if (!room.debt) player.inJail = false;
      else { /* freed when the bail settles: handled in settleDebtIfPossible via afterCharge jailMove */ player.inJail = false; }
    } else {
      setMessage(room, player.name + ' rolled ' + d1 + ' and ' + d2 + ', no double. Kirikiri continues. Attempt ' + player.jailTurns + ' of 3.');
      room.phase = 'end';
      setDeadline(room);
    }
  }
}
function resolveMortgageChoice(room, player, choice) {
  const q = room.pendingChoices[player.id];
  if (!q || !q.length) return false;
  const i = q[0];
  const sp = D.SPACES[i];
  const m = D.mortgageOf(sp.price);
  const interest = Math.round(m * 0.10);
  if (choice === 'lift') {
    const cost = m + interest;
    if (player.cash < cost) return false;
    q.shift();
    room.props[i].mortgaged = false;
    room.bankInterest = (room.bankInterest || 0) + interest;
    payNow(room, player, cost, null, 'Lift mortgage for ' + sp.name + ' (from trade)', {});
    setMessage(room, player.name + ' lifted ' + sp.name + ' straight for ' + D.fmtN(cost) + '.');
  } else {
    if (player.cash < interest) return false;
    q.shift();
    room.bankInterest = (room.bankInterest || 0) + interest;
    payNow(room, player, interest, null, 'Interest on mortgaged ' + sp.name + ' (deed stays mortgaged)', {});
    setMessage(room, player.name + ' paid ' + D.fmtN(interest) + ' interest on ' + sp.name + '. Deed still dey mortgaged.');
  }
  settleDebtIfPossible(room);
  return true;
}

// ---------------------------------------------------------------------------
// HTTP static + WebSocket intents
// ---------------------------------------------------------------------------
const ops = createOps({ rooms, retention });
const server = http.createServer((req, res) => {
  if (ops.accepts(req)) { ops.handle(req, res); return; }
  if (retention.accepts(req)) { retention.handle(req, res); return; }
  const cleanUrl = req.url.split('?')[0];
  if (cleanUrl === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, build: BUILD }));
    return;
  }
  // Finished-game records: served by this server only, so the store keys
  // stay server side and never reach the browser. Answers enabled: false
  // when the store keys are absent, and never crashes either way.
  if (cleanUrl === '/api/records') {
    records.getRecords().then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    }).catch(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ enabled: records.enabled(), matches: [], landlords: [] }));
    });
    return;
  }
  // Invite landing support: whose room is this, before you join it.
  if (cleanUrl.startsWith('/api/room/')) {
    const code = cleanUrl.slice('/api/room/'.length).trim().toUpperCase();
    const room = rooms.get(code);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    if (!room || room.mode === 'pass') { res.end(JSON.stringify({ exists: false })); return; }
    const host = room.players.find((p) => p.id === room.hostId);
    // Lesson 3: a device that already holds a seat in this room is told so,
    // with the seat's own name and token, before it joins under a second
    // identity. A grace lobby (Lesson 1) answers here exactly like a live one.
    let yourSeat = null;
    try {
      const cid = cleanClientId(new URL(req.url, 'http://localhost').searchParams.get('clientId'));
      if (cid) {
        const mine = room.players.find((p) => p.clientId && p.clientId === cid);
        if (mine) yourSeat = { name: mine.name, token: mine.token };
      }
    } catch (e) { yourSeat = null; }
    res.end(JSON.stringify({
      exists: true, code: room.code, status: room.status,
      hostName: host ? host.name : null,
      players: room.players.length, full: room.players.length >= MAX_PLAYERS,
      yourSeat
    }));
    return;
  }
  let filePath = cleanUrl === '/' ? '/index.html' : cleanUrl;
  filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    if (cleanUrl === '/' || cleanUrl === '/index.html' || cleanUrl === '/sw.js') data = stampAsset(cleanUrl, data);
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    const headers = { 'Content-Type': type };
    // Vendor libraries and fonts change rarely: cache them hard. App files
    // stay no-cache so a fresh deploy always lands on phones immediately.
    // The worker script is no-store so update() sees a new build at once.
    const cacheable = cleanUrl.startsWith('/vendor/') || cleanUrl.startsWith('/fonts/');
    headers['Cache-Control'] = cleanUrl === '/sw.js' ? 'no-store' : (cacheable ? 'public, max-age=604800' : 'no-cache');
    const compressible = /^(text\/|application\/json|image\/svg)/.test(type);
    if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(200, headers);
      res.end(zlib.gzipSync(data));
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function pickToken(room, wanted) {
  const taken = new Set(room.players.map((p) => p.token));
  if (wanted && !taken.has(wanted) && D.TOKENS.some((t) => t.id === wanted)) return wanted;
  for (const t of D.TOKENS) if (!taken.has(t.id)) return t.id;
  return 'danfo';
}
function cleanName(v) { return String(v || '').trim().slice(0, 20); }

// Bots (the owner's ask): a bot is a real seat driven by a BotBrain through
// a fake socket, playing the same intents a human client sends. Bots fill a
// room to at most BOT_SEAT_CAP seats so a table always stays human led.
const BOT_SEAT_CAP = 4;

function touchActive(player) {
  if (!player || player.bot) return;
  player.lastActive = now();
  player.afkWarn = 0;
}

function convertHumanToAfkBot(room, player) {
  if (!player || player.bot || player.bankrupt || player.resigned) return false;
  if (room.afkTakeovers >= AFK_MAX_TAKEOVERS) return false;
  const others = room.players.filter((p) => p.id !== player.id && !p.bankrupt);
  if (!others.length) return false;
  if (player.ws && !player.ws.__bot) {
    const oldWs = player.ws;
    try { oldWs.__detached = true; } catch (e) { }
    player.ws = null;
    try { oldWs.close(4002, 'afk bot'); } catch (e) { }
  }
  try { retention.onSeatWaiting(player); } catch (e) { /* whisper is optional */ }
  player.humanName = player.humanName || player.name;
  player.afkTaken = true;
  player.bot = true;
  room.afkTakeovers = (room.afkTakeovers || 0) + 1;
  const fake = new EventEmitter();
  fake.readyState = 1;
  fake.__bot = true;
  fake.__botPlayer = player;
  const brain = new BotBrain({
    playerId: player.id,
    test: TEST,
    send: (obj) => { if (fake.readyState === 1) fake.emit('message', Buffer.from(JSON.stringify(obj))); }
  });
  player.botBrain = brain;
  fake.send = (data) => brain.handleRaw(data);
  fake.close = () => {
    if (fake.readyState === 3) return;
    fake.readyState = 3;
    brain.kill();
    fake.emit('close');
  };
  handleConnection(fake);
  fake.emit('message', Buffer.from(JSON.stringify({ type: 'bot_claim', code: room.code })));
  setMessage(room, player.name + ' don go AFK. A bot dey hold the seat till dem return.');
  pushFeed(room, 'timeout', player.name + ' seat don convert to bot (AFK).', { playerId: player.id, auto: true, reason: 'afk' });
  updatePause(room);
  try { retention.noteDay('afk'); } catch (e) { /* the ledger never blocks a takeover */ }
  return true;
}

function reclaimAfkBot(room, player, ws) {
  if (!player || !player.afkTaken) return;
  if (player.botBrain) { try { player.botBrain.kill(); } catch (e) { } player.botBrain = null; }
  if (player.ws && player.ws.__bot) {
    try { player.ws.__detached = true; player.ws.readyState = 3; } catch (e) { }
  }
  player.bot = false;
  player.afkTaken = false;
  player.ws = ws;
  player.connected = true;
  touchActive(player);
  setMessage(room, player.name + ' don return. Bot don comot for the seat.');
}

function spawnBot(room) {
  const usedNames = new Set(room.players.map((p) => p.name));
  const name = BOT_NAMES.find((n) => !usedNames.has(n)) || ('BOT ' + room.players.length);
  const player = newPlayer(name, pickToken(room, null), room.players.length);
  player.bot = true;
  player.connected = true;
  const fake = new EventEmitter();
  fake.readyState = 1;
  fake.__bot = true;
  fake.__botPlayer = player;
  const brain = new BotBrain({
    playerId: player.id,
    test: TEST,
    send: (obj) => { if (fake.readyState === 1) fake.emit('message', Buffer.from(JSON.stringify(obj))); }
  });
  player.botBrain = brain;
  fake.send = (data) => brain.handleRaw(data);
  fake.close = () => {
    if (fake.readyState === 3) return;
    fake.readyState = 3;
    brain.kill();
    fake.emit('close');
  };
  handleConnection(fake);
  fake.emit('message', Buffer.from(JSON.stringify({ type: 'bot_attach', code: room.code })));
  return room.players.some((p) => p.id === player.id) ? player : null;
}

function handleConnection(ws) {
  const ctx = { player: null, room: null, spectator: false };
  function send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function fail(t) { send({ type: 'error', message: t }); }

  function actorOf(msg) {
    if (!ctx.room || !ctx.player) return null;
    if (ctx.room.mode === 'pass' && msg && msg.as) {
      return ctx.room.players.find((p) => p.id === Number(msg.as)) || ctx.player;
    }
    return ctx.player;
  }
  function needTurn(msg) {
    const a = actorOf(msg);
    if (!a) { fail('Join a room first.'); return null; }
    if (ctx.room.status !== 'playing') { fail('The game is not in play right now.'); return null; }
    if (ctx.room.paused) { fail('The game is paused, waiting for players.'); return null; }
    if (a.id !== ctx.room.turnPlayerId) { fail('Na ' + (curPlayer(ctx.room) || {}).name + ' turn be this.'); return null; }
    if (a.bankrupt) { fail('You don bankrupt. Watch the landlords play.'); return null; }
    return a;
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'heartbeat' || msg.type === 'presence') {
      if (ctx.player && !ctx.spectator) { touchActive(ctx.player); send({ type: 'pong', t: now() }); }
      return;
    }
    if (ctx.player && !ctx.spectator && !ctx.player.bot) touchActive(ctx.player);

    // ---- Test hooks (KP_TEST=1 only; used by test-engine.mjs) -------------
    if (TEST && msg.type.startsWith('test_') && ctx.room) {
      const room = ctx.room;
      if (msg.type === 'test_dice') { room.diceQueue = (msg.rolls || []).map((r) => [Number(r[0]), Number(r[1])]); }
      if (msg.type === 'test_card') { room.forcedCards[msg.deck] = msg.cardId; }
      if (msg.type === 'test_set_cash') { const p = room.players.find((x) => x.id === Number(msg.playerId)) || ctx.player; if (p) { p.cash = Number(msg.amount); p.minCash = Math.min(p.minCash, p.cash); } }
      if (msg.type === 'test_set_position') { const p = room.players.find((x) => x.id === Number(msg.playerId)); if (p) p.position = Number(msg.space) % 40; }
      if (msg.type === 'test_give') { const p = room.players.find((x) => x.id === Number(msg.playerId)); if (p && room.props[msg.space]) room.props[msg.space].owner = p.id; }
      if (msg.type === 'test_clock') { room.gameEndsAt = now() + Number(msg.secondsLeft) * 1000; }
      if (msg.type === 'test_set_pot') { room.pot = Number(msg.amount); }
      if (msg.type === 'test_phase') {
        if (room.inf) {
          const ph = Math.min(4, Math.max(1, Number(msg.phase) || 1));
          room.inf.phase = ph; room.activePhase = ph;
          const preset = INF_PRESETS[room.inf.preset] || INF_PRESETS.standard;
          room.inf.phaseEndsAt = ph < 4 ? now() + preset.durations[ph - 1] * 1000 : null;
          room.inf.hornAt = ph === 4 ? now() + preset.horn * 1000 : null;
        }
      }
      if (msg.type === 'test_phase_ends_in') { if (room.inf && room.inf.phase < 4) room.inf.phaseEndsAt = now() + Number(msg.seconds) * 1000; }
      if (msg.type === 'test_horn_in') { if (room.inf) room.inf.hornAt = now() + Number(msg.seconds) * 1000; }
      if (msg.type === 'test_deadline_in') { room.turnDeadline = now() + Number(msg.seconds) * 1000; }
      if (msg.type === 'test_set_supply') { if (msg.duplex != null) room.duplexSupply = Number(msg.duplex); if (msg.mansion != null) room.mansionSupply = Number(msg.mansion); }
      if (msg.type === 'test_bot_stats') {
        send({ type: 'test_bot_stats', bots: room.players.filter((p) => p.bot).map((p) => ({ id: p.id, name: p.name, actions: p.botBrain ? p.botBrain.actions : 0, errors: p.botBrain ? p.botBrain.errors.slice() : ['no brain'] })) });
        return;
      }
      if (msg.type === 'test_bot_hold') { const p = room.players.find((x) => x.id === Number(msg.playerId)); if (p && p.botBrain) p.botBrain.hold = !!msg.hold; broadcast(room); return; }
      broadcast(room);
      return;
    }

    // Mid-game AFK claim: fake socket takes over an existing human seat.
    if (msg.type === 'bot_claim') {
      if (!ws.__bot || !ws.__botPlayer) return fail('Bots only enter when the server sends them.');
      const target = rooms.get(String(msg.code || '').trim().toUpperCase());
      const player = ws.__botPlayer;
      if (!target || !player || target.players.indexOf(player) < 0) {
        send({ type: 'rejoin_failed' });
        return;
      }
      player.ws = ws;
      player.connected = true;
      player.bot = true;
      ctx.room = target; ctx.player = player; ctx.spectator = false;
      target.emptyAt = null;
      updatePause(target);
      broadcast(target);
      return;
    }

    // ---- Bot attach (server spawned sockets only) -------------------------
    // A real client can never set ws.__bot: that flag lives on the fake
    // socket object the server itself created in spawnBot.
    if (msg.type === 'bot_attach') {
      if (!ws.__bot || !ws.__botPlayer) return fail('Bots only enter when the server sends them.');
      const target = rooms.get(String(msg.code || '').trim().toUpperCase());
      const player = ws.__botPlayer;
      if (!target || target.mode === 'pass' || target.status !== 'lobby' || target.players.some((p) => p.id === player.id)) {
        send({ type: 'rejoin_failed' });
        return;
      }
      target.players.push(player);
      player.ws = ws;
      ctx.room = target; ctx.player = player; ctx.spectator = false;
      setMessage(target, player.name + ' don join the room.');
      send({ type: 'joined', playerId: player.id, code: target.code, token: player.reconnectToken });
      broadcast(target);
      return;
    }

    // ---- Entry paths -------------------------------------------------------
    if (msg.type === 'create_room') {
      const name = cleanName(msg.name);
      if (!name) return fail('Type your display name first.');
      const mode = msg.mode === 'pass' ? 'pass' : 'online';
      const room = newRoom(makeCode(), false, mode, sanitizeSettings(msg.settings, false));
      const player = newPlayer(name, pickToken(room, msg.token), 0);
      player.clientId = cleanClientId(msg.clientId);
      player.ws = ws; player.local = mode === 'pass';
      room.players.push(player);
      room.hostId = player.id;
      rooms.set(room.code, room);
      ctx.room = room; ctx.player = player; ctx.spectator = false;
      setMessage(room, name + ' created the room. Share the code and wait for friends.');
      noteIdentity(player);
      send({ type: 'joined', playerId: player.id, code: room.code, token: player.reconnectToken });
      broadcast(room);
      return;
    }
    if (msg.type === 'quick_join') {
      const name = cleanName(msg.name);
      if (!name) return fail('Type your display name first.');
      // Quick play only sits in a waiting public lobby of the mode the
      // player picked. An explicit Classic pick is Classic. Everything
      // else, including a missing pick, is Inflation, the default table.
      // A waiting Classic room must not swallow an Inflation quick play.
      const wantMode = msg.gameMode === 'classic' ? 'classic' : 'inflation';
      let target = null;
      for (const r of rooms.values()) {
        if (!r.isPublic || r.mode !== 'online' || r.status !== 'lobby') continue;
        if (!r.settings || r.settings.gameMode !== wantMode) continue;
        const conn = r.players.filter((p) => p.connected).length;
        if (conn >= 1 && r.players.length < MAX_PLAYERS) { target = r; break; }
      }
      if (!target) {
        // A fresh public room takes that same mode. sanitizeSettings
        // refuses chaos in public rooms and forces the timed clock for Classic.
        target = newRoom(makeCode(), true, 'online', sanitizeSettings({ gameMode: wantMode }, true));
        rooms.set(target.code, target);
      }
      const quickClientId = cleanClientId(msg.clientId);
      if (quickClientId) {
        const prior = target.players.find((p) => p.clientId && p.clientId === quickClientId);
        if (prior) { bindSeat(ctx, ws, target, prior, send); return; }
      }
      const player = newPlayer(name, pickToken(target, msg.token), target.players.length);
      player.clientId = quickClientId;
      player.ws = ws;
      target.players.push(player);
      if (!target.hostId) target.hostId = player.id;
      ctx.room = target; ctx.player = player; ctx.spectator = false;
      setMessage(target, name + ' joined the room.');
      noteIdentity(player);
      send({ type: 'joined', playerId: player.id, code: target.code, token: player.reconnectToken });
      broadcast(target);
      return;
    }
    if (msg.type === 'join_room') {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return fail('No room with that code. Check the code and try again.');
      if (room.mode === 'pass') return fail('That room dey play for one phone. You no fit join from another phone.');
      // A returning device reclaims its seat (same deeds, cash, turn state)
      // instead of duplicating in the lobby or spectating its own game.
      const joinClientId = cleanClientId(msg.clientId);
      if (joinClientId) {
        const prior = room.players.find((p) => p.clientId && p.clientId === joinClientId);
        if (prior) { bindSeat(ctx, ws, room, prior, send); return; }
      }
      if (room.status === 'lobby') {
        const name = cleanName(msg.name);
        if (!name) return fail('Type your display name first.');
        if (room.players.length >= MAX_PLAYERS) return fail('That room is full. Rooms hold 6 players.');
        const player = newPlayer(name, pickToken(room, msg.token), room.players.length);
        player.clientId = joinClientId;
        player.ws = ws;
        room.players.push(player);
        ctx.room = room; ctx.player = player; ctx.spectator = false;
        setMessage(room, name + ' joined the room.');
        noteIdentity(player);
        send({ type: 'joined', playerId: player.id, code: room.code, token: player.reconnectToken });
        broadcast(room);
      } else {
        // Game already running: come in as a spectator through the link.
        ctx.room = room; ctx.player = null; ctx.spectator = true;
        room.spectators.add(ws);
        send({ type: 'joined', playerId: null, code: room.code, spectator: true });
        send({ type: 'state', room: publicRoom(room) });
      }
      return;
    }

    // Reconnect resume: a dropped socket rebinds to its seat with the token
    // issued at join time. Without this, every reconnected socket was a
    // stranger and the next intent falsely failed with "Join a room first."
    if (msg.type === 'rejoin') {
      const code = String(msg.code || '').trim().toUpperCase();
      const target = rooms.get(code);
      if (!target || target.mode === 'pass') { send({ type: 'rejoin_failed' }); return; }
      if (msg.spectator) {
        ctx.room = target; ctx.player = null; ctx.spectator = true;
        target.spectators.add(ws);
        send({ type: 'joined', playerId: null, code: target.code, spectator: true });
        send({ type: 'state', room: publicRoom(target) });
        return;
      }
      const player = target.players.find((p) => p.id === Number(msg.playerId));
      if (!player || !msg.token || msg.token !== player.reconnectToken) { send({ type: 'rejoin_failed' }); return; }
      if (player.afkTaken) reclaimAfkBot(target, player, ws);
      bindSeat(ctx, ws, target, player, send);
      touchActive(player);
      return;
    }

    if (!ctx.room) return fail('Join a room first.');
    const room = ctx.room;

    if (msg.type === 'add_local_player') {
      if (room.mode !== 'pass' || room.status !== 'lobby') return fail('Local players only fit for This phone rooms before the game starts.');
      if (ctx.player.id !== room.hostId) return fail('Only the host adds players on this phone.');
      const name = cleanName(msg.name);
      if (!name) return fail('Type a name for the next player.');
      if (room.players.length >= MAX_PLAYERS) return fail('This phone don full. 6 players max.');
      const player = newPlayer(name, pickToken(room, msg.token), room.players.length);
      player.ws = ws; player.local = true;
      room.players.push(player);
      setMessage(room, name + ' don join for this phone.');
      broadcast(room);
      return;
    }
    if (msg.type === 'remove_local_player') {
      if (room.mode !== 'pass' || room.status !== 'lobby') return fail('You fit only remove local players before the game starts.');
      room.players = room.players.filter((p) => p.id !== Number(msg.playerId) || p.id === room.hostId);
      broadcast(room);
      return;
    }
    if (msg.type === 'add_bot') {
      if (!ctx.player || ctx.player.id !== room.hostId) return fail('Only the host fit add a bot.');
      if (room.mode === 'pass') return fail('Pass and play no dey use bot. Na una dey the same phone.');
      if (room.status !== 'lobby') return fail('Bots fit only join before the game starts.');
      if (room.players.length >= BOT_SEAT_CAP) return fail('Bots fit only fill the room reach ' + BOT_SEAT_CAP + ' seats.');
      const bot = spawnBot(room);
      if (!bot) return fail('The bot no fit enter this room.');
      return; // bot_attach already broadcast the new seat
    }
    if (msg.type === 'remove_bot') {
      if (!ctx.player || ctx.player.id !== room.hostId) return fail('Only the host fit remove a bot.');
      if (room.status !== 'lobby') return fail('Bots fit only comot before the game starts.');
      const target = room.players.find((p) => p.id === Number(msg.playerId));
      if (!target || !target.bot) return fail('That seat no be bot.');
      const sock = target.ws;
      if (sock) sock.__detached = true; // its close handler stays out of this
      if (target.botBrain) target.botBrain.kill();
      room.players = room.players.filter((p) => p.id !== target.id);
      if (sock) { try { sock.close(); } catch (e) { /* already gone */ } }
      setMessage(room, target.name + ' don comot for the room.');
      broadcast(room);
      return;
    }
    if (msg.type === 'start_game') {
      if (!ctx.player || ctx.player.id !== room.hostId) return fail('Only the host can start the game.');
      if (room.status !== 'lobby') return fail('The game don already start.');
      if (room.players.length < 2) return fail('You need at least 2 players to start.');
      startGame(room);
      broadcast(room);
      return;
    }
    if (msg.type === 'play_again') {
      // KP14 audit: this handler sat outside the spectator guard, so a
      // watch-only seat could bounce the whole room back to the lobby.
      if (!ctx.player || ctx.spectator) return fail('Spectators fit only watch.');
      if (room.status !== 'ended') return fail('The game never finish yet.');
      room.status = 'lobby';
      room.phase = 'roll'; room.winner = null; room.endTable = null; room.endReason = null;
      room.auction = null; room.debt = null; room.trade = null; room.lastCard = null;
      // KP14 audit: the reset used to leave the finished game behind in
      // the lobby: its feed (the next game's Gist opened on the old
      // game's events), its inflation state (a stale "Inflation ·
      // Phase N" pill), open contracts and loan queues, the match
      // clock and the frozen-game pause state. Clear the full
      // transient set; startGame re-deals the rest.
      room.feed = [];
      room.inf = null;
      room.contracts = []; room.contractProposal = null; room.dealBreak = null;
      room.loanDecision = null; room.loanDecisionQueue = [];
      room.turnDeadline = null; room.gameEndsAt = null;
      room.paused = false; room.pauseSince = null; room.pauseClockMs = null;
      room.dealOfGame = null; room.interestLine = null; room.firstBankruptId = null;
      room.dice = null;
      setMessage(room, 'Back to the lobby. The host fit start a new game with the same players.');
      broadcast(room);
      return;
    }
    // KP13 WS2: 'leave' is the confirmed leave intent (lobby Leave, end
    // screen Leave). It resolves HERE, finally, before the socket
    // closes: a lobby seat is freed at once (never parked as away), and
    // in a running game it takes the resign path so the result is final
    // before anyone's disconnect logic could see the closing socket.
    if (msg.type === 'leave') {
      const lr = ctx.room, lp = ctx.player;
      if (lr && lp && !ctx.spectator) {
        lp.leftConfirmed = true;
        if (lr.mode === 'pass') {
          rooms.delete(lr.code);
        } else if (lr.status === 'lobby') {
          const ix = lr.players.indexOf(lp);
          if (ix >= 0) lr.players.splice(ix, 1);
          if (!lr.players.some((p) => !p.bot)) {
            for (const p of lr.players) { if (p.botBrain) p.botBrain.kill(); }
            rooms.delete(lr.code);
          } else {
            if (lr.hostId === lp.id) lr.hostId = (lr.players.find((p) => !p.bot) || lr.players[0]).id;
            setMessage(lr, lp.name + ' don leave the room.');
            broadcast(lr);
          }
        } else if (lr.status === 'playing' && !lp.bankrupt) {
          const blocked = lr.auction || (lr.buildPlace && lr.buildPlace.playerId !== lp.id) || (lr.debt && lr.debt.playerId !== lp.id);
          if (!blocked) { doResign(lr, lp); broadcast(lr); }
        } else if (lr.status === 'ended') {
          // End-screen Leave must free the seat so a refresh cannot hang on the result card.
          const ix = lr.players.indexOf(lp);
          if (ix >= 0) lr.players.splice(ix, 1);
          if (!lr.players.some((p) => !p.bot)) {
            for (const p of lr.players) { if (p.botBrain) try { p.botBrain.kill(); } catch (e) { } }
            rooms.delete(lr.code);
          } else {
            if (lr.hostId === lp.id) {
              const next = lr.players.find((p) => !p.bot) || lr.players[0];
              if (next) lr.hostId = next.id;
            }
            broadcast(lr);
          }
        }
      }
      ws.close();
      return;
    }
    if (ctx.spectator || !ctx.player) return fail('Spectators fit only watch.');

    const me = actorOf(msg);

    // Shelf spend. Goods stay on the phone until this moment. Cowries and
    // cloth become cash. Kola arms the next rent. Yam arms the next fee.
    // The auction clock is not touched.
    if (msg.type === 'use_shelf') {
      if (!me || me.bankrupt || me.bot) return fail('You no fit spend the shelf now.');
      if (room.status !== 'playing') return fail('Spend the shelf when the table dey play.');
      if (room.paused) return fail('The game is paused, waiting for players.');
      const good = String(msg.good || '');
      const shelfId = room.mode === 'pass' ? (ctx.player && ctx.player.clientId) : me.clientId;
      if (!shelfId) return fail('This phone no get a market shelf yet. Claim the drop first.');
      if (good === 'kola' && me.shelfRent) return fail('You already hold a kola rent cover. Land on a rent first.');
      if (good === 'yams' && me.shelfFee) return fail('You already hold a yam fee cover. Let the next fee land first.');
      const taken = retention.take(shelfId, good);
      if (!taken.ok) return fail(taken.error === 'short' ? 'Your shelf no get enough for that.' : 'That good no dey for the shelf.');
      let line = '';
      if (taken.kind === 'cash') {
        const word = good === 'cloth' ? 'Aso-ebi cloth' : 'Cowries';
        line = word + ' don turn ' + D.fmtN(taken.amount) + ' for your hand.';
        moveMoney(room, null, me, taken.amount, me.name + ' spend ' + good + '. ' + line, { stat: 'other' });
        settleDebtIfPossible(room);
      } else if (taken.kind === 'rent') {
        me.shelfRent = true;
        line = 'Kola cover dey on you. Next rent, up to ₦100,000, the market go pay.';
        pushFeed(room, 'info', me.name + ' crack kola. ' + line, { playerId: me.id });
        setMessage(room, me.name + ' hold kola rent cover.');
      } else if (taken.kind === 'fee') {
        me.shelfFee = true;
        line = 'Yam cover dey on you. Next fee or tax, up to ₦200,000, the market go pay.';
        pushFeed(room, 'info', me.name + ' set yam down. ' + line, { playerId: me.id });
        setMessage(room, me.name + ' hold yam fee cover.');
      }
      send({ type: 'shelf', inventory: taken.inventory, line: taken.kind === 'cash' ? '' : line, good });
      broadcast(room);
      return;
    }

    // ---- Auction intents (any solvent player) ------------------------------
    if (msg.type === 'bid') {
      const a = room.auction;
      if (!a) return fail('No auction dey run.');
      if (!me || me.bankrupt) return fail('You no fit bid.');
      if (!a.eligible.includes(me.id) || a.passed.includes(me.id)) return fail('You don comot for this auction.');
      if (a.barred && a.barred === me.id) return fail('You dey barred from this re auction after your failed bid.');
      const amount = Math.floor(Number(msg.amount));
      if (isInf(room)) {
        // Bid cap (spec Section 3): no bid above cash plus mortgage value of clean deeds.
        const cap = raiseCap(room, me);
        if (Number.isFinite(amount) && amount > cap) return fail('That bid don pass all you fit raise: ' + D.fmtN(cap) + ' (cash plus mortgage value of your clean deeds).');
      }
      const minNext = a.highBid > 0 ? a.highBid + 1000 : 1000;
      if (!Number.isFinite(amount) || amount < minNext) return fail('Bid must be at least ' + D.fmtN(minNext) + '.');
      a.highBid = amount;
      a.highBidder = me.id;
      // The auction clock is fixed at open. A bid or a pass never
      // extends it, resets it, or adds time. It only runs down.
      setMessage(room, me.name + ' bid ' + D.fmtN(amount) + '.');
      broadcast(room);
      return;
    }
    if (msg.type === 'pass_bid') {
      const a = room.auction;
      if (!a || !me) return fail('No auction dey run.');
      if (!a.passed.includes(me.id)) a.passed.push(me.id);
      const stillIn = a.eligible.filter((id) => !a.passed.includes(id));
      if (stillIn.length === 0 || (stillIn.length === 1 && a.highBidder === stillIn[0])) {
        finishAuction(room);
      }
      broadcast(room);
      return;
    }

    // ---- Build placement after a building auction ---------------------------
    if (msg.type === 'build_place') {
      if (!room.buildPlace || room.buildPlace.playerId !== me.id) return fail('No building dey wait for placement by you.');
      const i = Number(msg.space);
      if (!canBuildOn(room, me.id, i, room.buildPlace.kind)) return fail('That building no fit land there. Pick a legal space in the set.');
      const kind = room.buildPlace.kind;
      const resume = room.buildPlace.resume;
      const resumePhase = room.buildPlace.resumePhase;
      room.buildPlace = null;
      placeBuilding(room, me, i, kind);
      if (resume === 'stay') { room.phase = ['roll', 'jail', 'end', 'tax'].includes(resumePhase) ? resumePhase : 'roll'; setDeadline(room); }
      else afterCharge(room, resume, me);
      broadcast(room);
      return;
    }

    // ---- Mortgaged deed choice (after trades and bankruptcy) ----------------
    if (msg.type === 'mortgage_choice') {
      if (!me) return fail('Join a room first.');
      const ok = resolveMortgageChoice(room, me, msg.choice === 'lift' ? 'lift' : 'interest');
      if (!ok) return fail('You no get the cash for that choice yet. Sell or mortgage something first.');
      broadcast(room);
      return;
    }

    // ---- Inflation contracts (spec Section 4) -------------------------------
    if (msg.type === 'call_deal_break') {
      if (!isInf(room)) return fail('Deal Breaks only exist for Inflation Mode.');
      if (room.status !== 'playing' || me.bankrupt) return fail('You no fit call Deal Break now.');
      if (room.dealBreak) return fail('One Deal Break don already open.');
      if (room.debt || room.auction) return fail('Settle the payment wey dey ground first. Deal Break no dey open mid payment.');
      if (me.dealBreakLap === me.lap) return fail('You don use your Deal Break for this lap. One per lap.');
      me.dealBreakLap = me.lap;
      room.dealBreak = { endsAt: now() + 20000, startedAt: now(), savedDeadline: room.turnDeadline, by: me.id };
      room.turnDeadline = null;
      pushFeed(room, 'contract', me.name + ' don call Deal Break. 20 seconds: contract window open for the whole table. The game clock no pause o.', { playerId: me.id });
      setMessage(room, 'Deal Break: ' + me.name + ' open the contract window for 20 seconds.');
      broadcast(room);
      return;
    }
    if (msg.type === 'contract_propose') {
      if (!isInf(room)) return fail('Contracts only exist for Inflation Mode.');
      if (room.contractProposal) return fail('One contract proposal dey wait already. Finish that one first.');
      if (!contractWindowOpen(room, me)) return fail('Contract window no open right now: auctions, another player debt and pauses close am. Otherwise deals fit fly anytime. If e no dey for contract board, e no happen.');
      if (room.debt && msg.kind !== 'loan') return fail('Inside the Rescue Window na only loan requests fit fly.');
      const phase = infPhase(room);
      const solventCount = solventPlayers(room).length;
      if (msg.kind === 'pass') {
        if (phase >= 4) return fail('Phase 4 don freeze new contracts. Existing chips still work.');
        if (solventCount <= 2) return fail('Two player endgame: no new Passes (guardrail G7).');
        const street = Number(msg.street);
        const sp = D.SPACES[street];
        if (!sp || sp.type !== 'street') return fail('Pass na for one named street.');
        const owner = room.props[street] && room.props[street].owner != null ? room.players.find((p) => p.id === room.props[street].owner) : null;
        if (!owner || owner.id === me.id || owner.bankrupt) return fail('That street no get another living owner to sell you a Pass.');
        const chips = msg.chips === 2 ? 2 : 1;
        const price = Math.floor(Number(msg.price));
        if (!Number.isFinite(price) || price < 5000) return fail('Pass price minimum na ₦5,000. A contract with no consideration na partnership, and this mode no sell that one.');
        if (price > me.cash) return fail('Your cash no reach that Pass price.');
        const myChips = room.contracts.filter((c) => c.type === 'pass' && c.status === 'active' && c.buyer === me.id).reduce((s, c) => s + c.chipsLeft, 0);
        if (myChips + chips > 4) return fail('Cap reach: you fit hold at most 4 active Pass chips.');
        const sameStreet = room.contracts.filter((c) => c.type === 'pass' && c.status === 'active' && c.buyer === me.id && c.street === street).reduce((s, c) => s + c.chipsLeft, 0);
        if (sameStreet + chips > 2) return fail('Cap reach: at most 2 chips per street for one buyer.');
        const soldOnStreet = room.contracts.filter((c) => c.type === 'pass' && c.status === 'active' && c.street === street).reduce((s, c) => s + c.chipsLeft, 0);
        if (soldOnStreet + chips > 4) return fail('That street don sell 4 chips already. E no fit disarm pass that.');
        room.contractProposal = { id: ++room.contractCounter, kind: 'pass', from: me.id, to: owner.id, terms: { street, chips, price }, endsAt: now() + 30000 };
        setMessage(room, me.name + ' propose Pass: ' + chips + ' chip(s) for ' + sp.name + ' at ' + D.fmtN(price) + '. ' + owner.name + ' get 30 seconds.');
      } else if (msg.kind === 'loan') {
        if (phase < 2) return fail('Loans never open for Phase 1. Bank mortgage na the only credit for Settling phase.');
        if (phase >= 4) return fail('Phase 4 don freeze new loans.');
        if (solventCount <= 2) return fail('Two player endgame: no new loans (guardrail G7).');
        const lender = room.players.find((p) => p.id === Number(msg.to));
        if (!lender || lender.id === me.id || lender.bankrupt) return fail('Pick a living lender.');
        const space = Number(msg.pledgedSpace);
        const sp = D.SPACES[space];
        const prop = room.props[space];
        if (!sp || !sp.price || !prop || prop.owner !== me.id) return fail('The pledged deed must be your own.');
        if (prop.mortgaged) return fail('A mortgaged deed no fit pledge.');
        if (prop.pledged) return fail('That deed don already pledge for another loan.');
        if (sp.type === 'street' && groupBuildings(room, sp.group) > 0) return fail('The pledged deed set must be clear of buildings, same as mortgage rules.');
        const amount = Math.floor(Number(msg.amount));
        const maxLtv = Math.floor(sp.price * 0.8);
        if (!Number.isFinite(amount) || amount <= 0) return fail('Loan amount must be real money.');
        if (amount > maxLtv) return fail('Loan cap: 80 percent of ' + sp.name + ' printed price na ' + D.fmtN(maxLtv) + '.');
        if (amount > lender.cash) return fail(lender.name + ' no get that cash to lend.');
        const interestPct = [0, 10, 20, 30].includes(Number(msg.interestPct)) ? Number(msg.interestPct) : -1;
        if (interestPct < 0) return fail('Interest must be one flat pick: 0, 10, 20 or 30 percent.');
        const termLaps = [1, 2, 3].includes(Number(msg.termLaps)) ? Number(msg.termLaps) : -1;
        if (termLaps < 0) return fail('Term must be 1, 2 or 3 of your laps.');
        if (room.contracts.some((c) => c.type === 'loan' && c.status === 'active' && c.borrower === me.id)) return fail('You get one active loan already. One per borrower.');
        if (room.contracts.filter((c) => c.type === 'loan' && c.status === 'active' && c.lender === lender.id).length >= 2) return fail(lender.name + ' don hold 2 active loans already. Lender cap reach.');
        room.contractProposal = { id: ++room.contractCounter, kind: 'loan', from: me.id, to: lender.id, terms: { pledgedSpace: space, amount, interestPct, termLaps }, endsAt: now() + 30000 };
        setMessage(room, me.name + ' propose loan: borrow ' + D.fmtN(amount) + ' from ' + lender.name + ' against ' + sp.name + '. ' + lender.name + ' get 30 seconds.');
      } else {
        return fail('Unknown contract kind.');
      }
      broadcast(room);
      return;
    }
    if (msg.type === 'contract_respond') {
      const pr = room.contractProposal;
      if (!pr || pr.to !== me.id) return fail('No contract proposal dey wait for your answer.');
      const from = room.players.find((p) => p.id === pr.from);
      room.contractProposal = null;
      if (!msg.accept) {
        if (from && from.ws && from.ws.readyState === 1) from.ws.send(JSON.stringify({ type: 'notice', message: me.name + ' decline your contract proposal.' }));
        setMessage(room, me.name + ' decline the contract proposal.');
        broadcast(room);
        return;
      }
      if (!from || from.bankrupt || me.bankrupt) return fail('That contract don spoil. One side no fit again.');
      if (pr.kind === 'pass') {
        const t = pr.terms;
        if (room.props[t.street].owner !== me.id) return fail('The street don change owner. Contract cancelled.');
        if (from.cash < t.price) return fail('The buyer cash don change. Contract cancelled.');
        moveMoney(room, from, me, t.price, 'Pass payment: ' + from.name + ' buy ' + t.chips + ' chip(s) for ' + D.SPACES[t.street].name + '.', {});
        const c = { id: pr.id, type: 'pass', buyer: from.id, seller: me.id, street: t.street, chips: t.chips, chipsLeft: t.chips, price: t.price, phaseCreated: infPhase(room), status: 'active' };
        room.contracts.push(c);
        pushFeed(room, 'contract', 'Contract don seal: ' + from.name + ' buy ' + t.chips + ' Pass chip(s) for ' + D.SPACES[t.street].name + ' at ' + D.fmtN(t.price) + '. E go die at this phase end.', { playerId: from.id, space: t.street });
        setMessage(room, 'Contract don seal. Pass registered for ' + D.SPACES[t.street].name + '.');
      } else {
        const t = pr.terms;
        const prop = room.props[t.pledgedSpace];
        if (!prop || prop.owner !== from.id || prop.mortgaged || prop.pledged) return fail('The pledged deed don change. Contract cancelled.');
        if (me.cash < t.amount) return fail('Your cash as lender don change. Contract cancelled.');
        const c = { id: pr.id, type: 'loan', borrower: from.id, lender: me.id, pledgedSpace: t.pledgedSpace, amount: t.amount, interestPct: t.interestPct, termLaps: t.termLaps, lapsElapsed: 0, phaseCreated: infPhase(room), extended: false, dueExtra: 0, decisionOpen: false, status: 'active' };
        room.contracts.push(c);
        prop.pledged = c.id;
        moveMoney(room, me, from, t.amount, 'Loan: ' + me.name + ' lend ' + from.name + ' ' + D.fmtN(t.amount) + ' against ' + D.SPACES[t.pledgedSpace].name + '.', {});
        pushFeed(room, 'contract', 'Contract don seal: loan of ' + D.fmtN(t.amount) + ' to ' + from.name + ', security na ' + D.SPACES[t.pledgedSpace].name + '. Pay back ' + D.fmtN(t.amount + Math.floor(t.amount * t.interestPct / 100)) + ' before ' + t.termLaps + ' lap(s) finish or phase end.', { playerId: from.id, space: t.pledgedSpace });
        setMessage(room, 'Contract don seal. Loan registered against ' + D.SPACES[t.pledgedSpace].name + '.');
      }
      broadcast(room);
      return;
    }
    if (msg.type === 'repay_loan') {
      const c = room.contracts.find((x) => x.id === Number(msg.contractId));
      if (!c || c.type !== 'loan' || c.status !== 'active' || c.borrower !== me.id) return fail('No active loan of yours matches that.');
      // Lesson 5: repayment is management, not a turn action. It stays
      // blocked only while an auction runs, the game is paused, or another
      // player's debt is being settled.
      if (room.status !== 'playing' || room.auction) return fail('You no fit repay while an auction dey run.');
      if (room.mode !== 'pass' && room.paused) return fail('The game dey paused, waiting for players.');
      if (room.debt && room.debt.playerId !== me.id) return fail('Another player debt dey settle first.');
      const due = c.amount + Math.floor(c.amount * c.interestPct / 100) + (c.dueExtra || 0);
      const lender = room.players.find((p) => p.id === c.lender);
      if (!lender) return fail('The lender don vanish.');
      if (me.cash < due) return fail('You need ' + D.fmtN(due) + ' to clear this loan.');
      payNow(room, me, due, lender, 'Loan repayment for ' + D.SPACES[c.pledgedSpace].name, {});
      if (room.props[c.pledgedSpace]) room.props[c.pledgedSpace].pledged = null;
      c.status = 'repaid';
      if (c.decisionOpen) { c.decisionOpen = false; if (room.loanDecision && room.loanDecision.contractId === c.id) openNextLoanDecision(room); }
      pushFeed(room, 'contract', me.name + ' don repay the loan: ' + D.fmtN(due) + ' to ' + lender.name + '. ' + D.SPACES[c.pledgedSpace].name + ' don free.', { playerId: me.id, space: c.pledgedSpace });
      setMessage(room, me.name + ' don clear the loan on ' + D.SPACES[c.pledgedSpace].name + '.');
      broadcast(room);
      return;
    }
    if (msg.type === 'loan_decide') {
      const ld = room.loanDecision;
      if (!ld || ld.contractId !== Number(msg.contractId)) return fail('No loan decision dey wait on that contract.');
      const c = room.contracts.find((x) => x.id === ld.contractId);
      if (!c || c.lender !== me.id) return fail('Na the lender dey choose for a due loan.');
      resolveLoanDefault(room, c.id, msg.choice === 'extend' ? 'extend' : 'seize');
      broadcast(room);
      return;
    }

    // ---- Resign / end room (Lesson 11) --------------------------------------
    if (msg.type === 'resign') {
      if (room.status !== 'playing') return fail('No game dey run to leave.');
      if (!me || me.bankrupt) return fail('You don already comot for this game.');
      if (room.auction) return fail('Auction dey run. Wait make e finish before you leave.');
      if (room.buildPlace && room.buildPlace.playerId !== me.id) return fail('One building dey wait for placement. Wait small.');
      if (room.debt && room.debt.playerId !== me.id) return fail('Another player debt dey settle. Wait small.');
      doResign(room, me);
      broadcast(room);
      return;
    }
    if (msg.type === 'end_room') {
      if (!ctx.player || ctx.player.id !== room.hostId) return fail('Only the host fit end the room.');
      if (room.status !== 'playing') return fail('No game dey run.');
      const alive = solventPlayers(room);
      if (!alive.length) return fail('No players remain.');
      const winner = alive.slice().sort((a, b) => netWorth(room, b) - netWorth(room, a) || b.cash - a.cash)[0];
      room.endReason = 'host';
      pushFeed(room, 'info', 'Host don end the room.', { playerId: ctx.player.id });
      endGame(room, winner, 'Host don end the room.');
      broadcast(room);
      return;
    }

    // ---- Debt: declare bankruptcy -------------------------------------------
    if (msg.type === 'declare_bankruptcy') {
      if (!room.debt || room.debt.playerId !== me.id) return fail('Bankruptcy only opens when a debt dey hang for your neck.');
      declareBankruptcy(room, me);
      broadcast(room);
      return;
    }

    // ---- Manage intents -------------------------------------------------------
    if (['build', 'sell_building', 'mortgage', 'unmortgage'].includes(msg.type)) {
      if (!manageAllowed(room, me)) return fail('Managing dey blocked right now: an auction dey run, a building dey wait for placement, the game dey paused, or another player debt dey settle. Otherwise you fit manage anytime.');
      const i = Number(msg.space);
      if (!Number.isInteger(i) || !D.SPACES[i] || !D.SPACES[i].price) return fail('That space get no deed.');
      let ok = false;
      if (msg.type === 'build') ok = doBuild(room, me, i, msg.kind === 'mansion' ? 'mansion' : 'duplex', fail);
      if (msg.type === 'sell_building') ok = doSellBuilding(room, me, i, fail);
      if (msg.type === 'mortgage') ok = doMortgage(room, me, i, fail);
      if (msg.type === 'unmortgage') ok = doUnmortgage(room, me, i, fail);
      if (ok) broadcast(room);
      return;
    }

    // ---- Trades ---------------------------------------------------------------
    if (msg.type === 'trade_propose') {
      if (room.status !== 'playing') return fail('Trades open when the game starts.');
      if (room.trade) return fail('One trade dey table already. Finish that one first.');
      if (isInf(room) && !contractWindowOpen(room, me)) return fail('For Inflation Mode, swaps na contracts: the window close only during auctions, another player debt, or a pause. Otherwise propose anytime. If e no dey for contract board, e no happen.');
      const to = room.players.find((p) => p.id === Number(msg.to));
      if (!to || to.id === me.id || to.bankrupt || me.bankrupt) return fail('Pick a living player to trade with.');
      const clean = (side) => ({
        cash: Math.max(0, Math.floor(Number(side && side.cash) || 0)),
        spaces: Array.isArray(side && side.spaces) ? side.spaces.map(Number).filter((i) => D.SPACES[i] && D.SPACES[i].price) : [],
        goojf: Math.max(0, Math.floor(Number(side && side.goojf) || 0))
      });
      const offer = clean(msg.offer);
      const request = clean(msg.request);
      for (const i of offer.spaces) if (!room.props[i] || room.props[i].owner !== me.id) return fail('You no own ' + D.SPACES[i].name + '.');
      for (const i of request.spaces) if (!room.props[i] || room.props[i].owner !== to.id) return fail(to.name + ' no own ' + D.SPACES[i].name + '.');
      for (const i of [...offer.spaces, ...request.spaces]) if (room.props[i].pledged) return fail(D.SPACES[i].name + ' dey pledged as loan security. E no fit trade until the loan clear.');
      for (const i of [...offer.spaces, ...request.spaces]) {
        const sp = D.SPACES[i];
        if (sp.type === 'street' && groupBuildings(room, sp.group) > 0) return fail('Sell the buildings for ' + sp.name + ' set first. Deeds with duplexes no dey trade.');
      }
      if (offer.cash > me.cash) return fail('You no get that cash to offer.');
      if (offer.goojf > me.goojf.length) return fail('You no hold that many Get Out cards.');
      room.trade = { id: ++tradeCounter, from: me.id, to: to.id, offer, request,
        expiresAt: isInf(room) ? now() + 30000 : null,
        honourPass: Array.isArray(msg.honourPass) ? msg.honourPass.map(Number).filter((i) => D.SPACES[i]) : [] };
      setMessage(room, me.name + ' don propose trade to ' + to.name + '.');
      broadcast(room);
      return;
    }
    if (msg.type === 'trade_cancel') {
      if (room.trade && (room.trade.from === me.id || room.trade.to === me.id)) {
        room.trade = null;
        setMessage(room, 'Trade don cancel.');
        broadcast(room);
      }
      return;
    }
    if (msg.type === 'trade_respond') {
      const t = room.trade;
      if (!t || t.to !== me.id) return fail('No trade dey wait for your answer.');
      if (!msg.accept) {
        room.trade = null;
        setMessage(room, me.name + ' reject the trade.');
        broadcast(room);
        return;
      }
      const from = room.players.find((p) => p.id === t.from);
      const to = me;
      // Revalidate everything at execution time.
      if (!from || from.bankrupt || to.bankrupt) { room.trade = null; return fail('That trade don spoil. One side no fit again.'); }
      if (t.offer.cash > from.cash || t.request.cash > to.cash) { room.trade = null; return fail('Cash don change. That trade no balance again.'); }
      for (const i of t.offer.spaces) if (room.props[i].owner !== from.id) { room.trade = null; return fail('Deeds don change hands. Trade cancelled.'); }
      for (const i of t.request.spaces) if (room.props[i].owner !== to.id) { room.trade = null; return fail('Deeds don change hands. Trade cancelled.'); }
      if (t.offer.goojf > from.goojf.length || t.request.goojf > to.goojf.length) { room.trade = null; return fail('Get Out cards don change. Trade cancelled.'); }
      const honourSet = new Set([...(t.honourPass || []), ...(Array.isArray(msg.honourPass) ? msg.honourPass.map(Number) : [])]);
      room.trade = null;
      if (t.offer.cash > 0) moveMoney(room, from, to, t.offer.cash, 'Trade cash: ' + from.name + ' to ' + to.name + '.', {});
      if (t.request.cash > 0) moveMoney(room, to, from, t.request.cash, 'Trade cash: ' + to.name + ' to ' + from.name + '.', {});
      for (const i of t.offer.spaces) { room.props[i].owner = to.id; if (room.props[i].mortgaged) queueChoice(room, to, i); if (isInf(room)) settlePassesAfterTransfer(room, i, to.id, honourSet.has(i)); }
      for (const i of t.request.spaces) { room.props[i].owner = from.id; if (room.props[i].mortgaged) queueChoice(room, from, i); if (isInf(room)) settlePassesAfterTransfer(room, i, from.id, honourSet.has(i)); }
      for (let k = 0; k < t.offer.goojf; k++) to.goojf.push(from.goojf.pop());
      for (let k = 0; k < t.request.goojf; k++) from.goojf.push(to.goojf.pop());
      pushFeed(room, 'trade', from.name + ' and ' + to.name + ' don seal a trade.', {});
      setMessage(room, 'Trade sealed between ' + from.name + ' and ' + to.name + '.');
      settleDebtIfPossible(room);
      broadcast(room);
      return;
    }

    // ---- Turn intents ---------------------------------------------------------
    if (msg.type === 'roll') {
      const a = needTurn(msg);
      if (!a) return;
      if ((room.pendingChoices[a.id] || []).length) return fail('You carry a mortgaged deed choice. Settle am first.');
      if (room.phase !== 'roll') return fail('Dice no be next. Finish the current step first.');
      if (room.debt) return fail('Settle the debt first.');
      doRoll(room, a);
      broadcast(room);
      return;
    }
    if (msg.type === 'buy') {
      const a = needTurn(msg);
      if (!a) return;
      if (room.phase !== 'buy' || room.buySpace == null) return fail('Nothing dey for sale to you right now.');
      const i = room.buySpace;
      const sp = D.SPACES[i];
      const price = room.buyPrice != null ? room.buyPrice : sp.price;
      if (a.cash < price) return fail('Your cash no reach ' + D.fmtN(price) + '. Mortgage or sell something, or send am to auction.');
      room.buySpace = null;
      room.buyPrice = null;
      room.props[i].owner = a.id;
      a.purchases.push({ space: i, price, phase: infPhase(room) });
      settlePassesAfterTransfer(room, i, a.id, false);
      payNow(room, a, price, null, 'Buy ' + sp.name, { stat: 'purchase', spaceName: sp.name });
      if (price !== sp.price) stamp(room, 'buy', a.name + ' buy ' + sp.name + ' at dice price: ' + D.fmtN(price) + ' (printed ' + D.fmtN(sp.price) + ').', price, a.id);
      pushFeed(room, i === 39 ? 'deedBig' : 'deed', a.name + ' don buy ' + sp.name + ' for ' + D.fmtN(price) + '. Landlord don land.', { playerId: a.id, amount: price, space: i });
      setMessage(room, a.name + ' don buy ' + sp.name + ' for ' + D.fmtN(price) + '.');
      afterCharge(room, room.afterLanding || 'endPhase', a);
      broadcast(room);
      return;
    }
    if (msg.type === 'decline') {
      const a = needTurn(msg);
      if (!a) return;
      if (room.phase !== 'buy') return fail('Nothing to decline right now.');
      declineBuy(room, a);
      broadcast(room);
      return;
    }
    if (msg.type === 'end_turn') {
      const a = needTurn(msg);
      if (!a) return;
      if ((room.pendingChoices[a.id] || []).length) return fail('Settle your mortgaged deed choice before you end turn.');
      if (room.debt) return fail('Debt still dey hang. Settle am or declare bankruptcy.');
      if (room.phase !== 'end') return fail('Finish the current step before you end turn.');
      endTurn(room);
      broadcast(room);
      return;
    }
    if (msg.type === 'jail_pay') {
      const a = needTurn(msg);
      if (!a) return;
      if (room.phase !== 'jail' || !a.inJail) return fail('You no dey Kirikiri.');
      if (a.cash < D.JAIL_FINE) return fail('Bail na ' + D.fmtN(D.JAIL_FINE) + '. Raise the money first (mortgage or trade).');
      payNow(room, a, D.JAIL_FINE, null, 'Kirikiri bail', { toPot: true, stat: 'fine' });
      a.inJail = false;
      a.jailTurns = 0;
      room.phase = 'roll';
      setDeadline(room);
      setBanner(room, 'roll_now', a, {}, a.name + ' don pay bail. Roll the dice.');
      broadcast(room);
      return;
    }
    if (msg.type === 'jail_card') {
      const a = needTurn(msg);
      if (!a) return;
      if (room.phase !== 'jail' || !a.inJail) return fail('You no dey Kirikiri.');
      if (!a.goojf.length) return fail('You no hold any Get Out of Kirikiri Free card.');
      const cid = a.goojf.pop();
      room.discard[cid.startsWith('w') ? 'wahala' : 'family'].push(cid);
      a.inJail = false;
      a.jailTurns = 0;
      room.phase = 'roll';
      setDeadline(room);
      setBanner(room, 'roll_now', a, {}, a.name + ' flash the senior officer card. Kirikiri don free am. Roll the dice.');
      broadcast(room);
      return;
    }
    if (msg.type === 'jail_roll') {
      const a = needTurn(msg);
      if (!a) return;
      if (room.phase !== 'jail' || !a.inJail) return fail('You no dey Kirikiri.');
      jailRoll(room, a);
      broadcast(room);
      return;
    }
    if (msg.type === 'tax_choice') {
      const a = needTurn(msg);
      if (!a) return;
      if (room.phase !== 'tax') return fail('No tax choice dey wait.');
      taxChoose(room, a, msg.choice === 'percent' ? 'percent' : 'flat');
      broadcast(room);
      return;
    }
    return fail('Unknown action.');
  });

  ws.on('close', () => {
    if (ws.__detached) return; // a bot seat the host removed on purpose
    const room = ctx.room;
    if (!room) return;
    if (ctx.spectator) { room.spectators.delete(ws); return; }
    if (room.mode === 'pass') { rooms.delete(room.code); return; }
    const me = ctx.player;
    if (!me) return;
    if (me.ws && me.ws !== ws) return; // a rejoined socket owns this seat now
    me.connected = false;
    me.ws = null;
    // KP13 WS2: a seat resolved by a confirmed leave (resignation, or the
    // lobby seat already freed in the leave handler) never enters the
    // away/pause path and is never re-labelled a disconnect when the
    // leaver's app closes afterwards. Housekeeping still runs: host
    // crown, pause truth for any genuine drops, and the empty-room
    // grace clock.
    if (me.resigned || me.leftConfirmed) {
      if (room.status !== 'lobby' && room.hostId === me.id) {
        const next = room.players.find((p) => p.connected && !p.bot && !p.bankrupt)
          || room.players.find((p) => p.connected && !p.bankrupt)
          || room.players.find((p) => p.connected);
        if (next) room.hostId = next.id;
      }
      updatePause(room);
      if (!room.players.some((p) => p.connected && !p.bot)) room.emptyAt = now();
      broadcast(room);
      return;
    }
    setMessage(room, me.name + ' dey away. Seat dey held.');
    // Lesson 1: in the lobby the host seat is held, not migrated: the room
    // is waiting for its host, and guests see the hostAway state.
    if (room.status !== 'lobby' && room.hostId === me.id) {
      const next = room.players.find((p) => p.connected && !p.bot && !p.bankrupt)
        || room.players.find((p) => p.connected && !p.bankrupt)
        || room.players.find((p) => p.connected);
      if (next) room.hostId = next.id;
    }
    updatePause(room);
    if (!room.players.some((p) => p.connected && !p.bot)) {
      // No human is here: start the grace clock instead of deleting. The
      // interval reaps the room when the window passes (ROOM_GRACE_MS).
      room.emptyAt = now();
    }
    try { retention.onSeatWaiting(me); } catch (e) { /* whisper is optional */ }
    broadcast(room);
  });
}
wss.on('connection', handleConnection);

if (!TEST) {
  // Lagos dawn is not a cron job here. A quiet sweep tells subscribers
  // whose shelf is still empty for today. One whisper per player per day.
  setInterval(() => { retention.sweepDrops().catch(() => {}); }, 15 * 60 * 1000);
  setTimeout(() => { retention.sweepDrops().catch(() => {}); }, 20000);
}
server.listen(PORT, () => {
  console.log('Kolopoly listening on port ' + PORT);
});
