'use strict';
// Onile challenge escrow. Two people each pay the same amount. Onile
// holds the pot until they name the same winner, the house resolves a
// dispute, or the challenge expires and the money goes back.
// Amounts are kobo, computed here. A settlement is written once; a
// second call returns the same lines and does not add ledger rows.
const crypto = require('crypto');
const path = require('path');
function nodeFs() { return require('fs'); }

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_HOUSE_PERCENT = 10;
const MIN_NAIRA = 100;
const MAX_NAIRA = 1000000;
const MIN_LEAD_MS = 15 * 60 * 1000;
const MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;

function clampPercent(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return DEFAULT_HOUSE_PERCENT;
  return Math.min(50, Math.max(0, Math.round(x)));
}
function moneyOf(ch) {
  const pot = ch.stakeKobo * 2;
  const house = Math.floor(pot * ch.housePercent / 100);
  return { pot, house, prize: pot - house };
}
function cleanText(s, min, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length < min || t.length > max) return null;
  if (/[\u0000-\u001f]/.test(t)) return null;
  return t;
}
function cleanEmail(s) {
  const t = String(s == null ? '' : s).trim().toLowerCase();
  if (!t || t.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return null;
  return t;
}
function parseNaira(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}
function normCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function createEscrow(opts) {
  opts = opts || {};
  const memory = !!opts.memory;
  const file = memory ? null : (opts.file || path.join(__dirname, '..', 'data', 'onile', 'escrow.json'));
  const housePercent = clampPercent(opts.housePercent == null ? DEFAULT_HOUSE_PERCENT : opts.housePercent);
  const joinWindowMs = Number(opts.joinWindowMs) || 24 * 60 * 60 * 1000;
  const reportWindowMs = Number(opts.reportWindowMs) || 24 * 60 * 60 * 1000;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  let state = { players: [], challenges: [], ledger: [] };
  let saveWarned = false;

  function load() {
    if (memory) return;
    try {
      const parsed = JSON.parse(nodeFs().readFileSync(file, 'utf8'));
      if (parsed && Array.isArray(parsed.challenges) && Array.isArray(parsed.players)) {
        state = {
          players: parsed.players,
          challenges: parsed.challenges,
          ledger: Array.isArray(parsed.ledger) ? parsed.ledger : []
        };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.log('Onile escrow started empty.');
    }
  }
  function save() {
    if (memory) return;
    const fs = nodeFs();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!saveWarned) { saveWarned = true; console.log('Onile escrow could not be saved.'); }
    }
  }
  load();

  function nid(prefix) {
    return prefix + crypto.randomBytes(9).toString('hex');
  }
  function makeCode() {
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
    return s;
  }
  function byCode(code) {
    const c = normCode(code);
    return state.challenges.find((ch) => ch.code === c) || null;
  }
  function playerById(id) {
    return state.players.find((p) => p.id === id) || null;
  }
  function audit(ch, type, actor, detail) {
    ch.audit.push({ at: now(), type, actor: actor || null, detail: detail || null });
    if (ch.audit.length > 80) ch.audit = ch.audit.slice(-80);
  }
  function ledgerPush(ch, type, accountId, amountKobo, ref, note) {
    state.ledger.push({
      id: 'led_' + crypto.randomBytes(8).toString('hex'),
      at: now(),
      challengeId: ch.id,
      code: ch.code,
      type,
      accountId: accountId || null,
      amountKobo,
      ref: ref || null,
      note: note || null
    });
  }
  function seat(person) {
    return {
      id: person.id,
      name: person.name,
      email: person.email,
      paid: false,
      paymentRef: null,
      paidAt: null,
      report: null
    };
  }
  function people(ch) {
    return [ch.creator, ch.opponent].filter(Boolean);
  }
  function findSeat(ch, playerId) {
    if (ch.creator && ch.creator.id === playerId) return ch.creator;
    if (ch.opponent && ch.opponent.id === playerId) return ch.opponent;
    return null;
  }
  function roleOf(ch, playerId) {
    if (ch.creator && ch.creator.id === playerId) return 'creator';
    if (ch.opponent && ch.opponent.id === playerId) return 'opponent';
    return null;
  }
  function personByRole(ch, role) {
    if (role === 'creator') return ch.creator;
    if (role === 'opponent') return ch.opponent;
    return null;
  }
  function knownRef(ch, reference) {
    if (!reference) return false;
    if ((ch.extraRefunds || []).some((r) => r.paymentRef === reference)) return true;
    if (ch.settlement && ch.settlement.lines.some((l) => l.entry && l.entry.reference === reference)) return true;
    return people(ch).some((p) => p.paymentRef === reference);
  }
  function refundEntry(ch, person, amountKobo, why) {
    return {
      kind: 'refund-due',
      reference: person.paymentRef,
      roomCode: ch.code,
      playerId: 1,
      name: person.name,
      accountId: person.id,
      email: person.email,
      amountKobo,
      amount: Math.max(1, Math.round(amountKobo / 100)),
      why,
      at: ch.createdAt,
      testMode: false
    };
  }
  function refundLines(ch, why) {
    return people(ch).filter((p) => p.paid && p.paymentRef).map((p) => ({
      accountId: p.id,
      amountKobo: ch.stakeKobo,
      entry: refundEntry(ch, p, ch.stakeKobo, why)
    }));
  }
  function winnerLine(ch, role) {
    const winner = personByRole(ch, role);
    const m = moneyOf(ch);
    const gameKey = 'onile:' + ch.id;
    return {
      accountId: winner.id,
      amountKobo: m.prize,
      entry: {
        kind: 'prize',
        gameKey,
        roomCode: ch.code,
        playerId: 1,
        name: winner.name,
        accountId: winner.id,
        email: winner.email,
        amountKobo: m.prize,
        amount: Math.max(0, Math.round(m.prize / 100)),
        why: 'agreed winner',
        at: ch.createdAt,
        testMode: false
      }
    };
  }
  // One settlement per challenge. The second call is a no-op.
  function plan(ch, kind, lines, winnerRole) {
    if (ch.settlement) return { duplicate: true, settlement: ch.settlement };
    if (!lines.length) return { ok: false, error: 'empty' };
    ch.settlement = { kind, lines, at: now(), dispatched: false };
    if (kind === 'winner') {
      const m = moneyOf(ch);
      ledgerPush(ch, 'house', null, m.house, null, 'house cut');
      ledgerPush(ch, 'prize', lines[0].accountId, lines[0].amountKobo, lines[0].entry.gameKey, 'winner');
      ch.status = 'agreed';
      ch.winnerRole = winnerRole;
    } else if (kind === 'split') {
      for (const line of lines) ledgerPush(ch, 'split', line.accountId, line.amountKobo, line.entry.reference, 'split');
      ch.status = 'resolved';
      ch.resolution = ch.resolution || { action: 'split', at: now() };
    } else {
      for (const line of lines) ledgerPush(ch, 'refund', line.accountId, line.amountKobo, line.entry.reference, 'refund');
      ch.status = 'refunded';
    }
    audit(ch, 'settled', null, kind);
    return { duplicate: false, settlement: ch.settlement, queue: true };
  }
  function queueExtra(ch, reference, person, amountKobo, why) {
    if (knownRef(ch, reference)) return { ok: true, duplicate: true, queue: false };
    const entry = {
      kind: 'refund-due',
      reference,
      roomCode: ch.code,
      playerId: 1,
      name: person ? person.name : 'Player',
      accountId: person ? person.id : null,
      email: person ? person.email : null,
      amountKobo,
      amount: Math.max(1, Math.round(amountKobo / 100)),
      why,
      at: ch.createdAt,
      testMode: false
    };
    ch.extraRefunds = ch.extraRefunds || [];
    ch.extraRefunds.push({ paymentRef: reference, entry });
    ledgerPush(ch, 'refund', person && person.id, amountKobo, reference, why);
    audit(ch, 'refund-queued', person && person.id, why);
    return { ok: true, duplicate: false, queue: true, error: why === 'wrong-amount' || why === 'wrong-currency' ? 'amount' : 'closed' };
  }
  function tick(ch) {
    const t = now();
    if ((ch.status === 'open' || ch.status === 'joined') && t >= ch.joinBy) {
      const lines = refundLines(ch, 'expired');
      if (lines.length) {
        plan(ch, 'refund', lines);
        ch.disputeReason = null;
        audit(ch, 'expired', null, 'the other player did not join and pay in time');
      } else {
        ch.status = 'expired';
        audit(ch, 'expired', null, 'nobody paid');
      }
      return true;
    }
    if ((ch.status === 'held' || ch.status === 'reported') && ch.reportBy && t >= ch.reportBy) {
      ch.status = 'disputed';
      ch.disputeReason = 'timeout';
      audit(ch, 'disputed', null, 'no agreement by the deadline');
      return true;
    }
    return false;
  }
  function commit() { save(); }

  function upsertPlayer(input) {
    const email = cleanEmail(input && input.email);
    const name = cleanText(input && input.name, 2, 40);
    if (!email) return { ok: false, error: 'email', message: 'Enter a real email address.' };
    if (!name) return { ok: false, error: 'name', message: 'Enter your name (2 to 40 characters).' };
    let p = state.players.find((x) => x.email === email);
    if (!p) {
      p = { id: nid('p_'), name, email, createdAt: now() };
      state.players.push(p);
    } else if (p.name !== name) {
      p.name = name;
    }
    commit();
    return { ok: true, player: { id: p.id, name: p.name, email: p.email } };
  }

  function create(input) {
    const player = playerById(input && input.playerId);
    if (!player) return { ok: false, error: 'player', message: 'Tell us who you are first.' };
    const title = cleanText(input.title, 3, 80);
    const activity = cleanText(input.activity, 2, 60);
    const rules = cleanText(input.rules || '', 0, 500);
    if (!title) return { ok: false, error: 'title', message: 'Give the challenge a title.' };
    if (!activity) return { ok: false, error: 'activity', message: 'Say what you are playing.' };
    if (rules == null) return { ok: false, error: 'rules', message: 'Keep the rules under 500 characters.' };
    const naira = parseNaira(input.stakeNaira);
    if (naira == null || naira < MIN_NAIRA || naira > MAX_NAIRA) {
      return { ok: false, error: 'amount', message: 'The amount each person pays is between ₦100 and ₦1,000,000.' };
    }
    let deadline = null;
    if (input.deadline) {
      const d = typeof input.deadline === 'number' ? input.deadline : Date.parse(input.deadline);
      if (!Number.isFinite(d)) return { ok: false, error: 'deadline', message: 'That deadline is not a date.' };
      if (d < now() + MIN_LEAD_MS || d > now() + MAX_LEAD_MS) {
        return { ok: false, error: 'deadline', message: 'Pick a deadline between 15 minutes and 30 days from now.' };
      }
      deadline = d;
    }
    let code = '';
    for (let i = 0; i < 6; i++) {
      const next = makeCode();
      if (!byCode(next)) { code = next; break; }
    }
    if (!code) return { ok: false, error: 'code', message: 'Could not open a challenge. Try again.' };
    const ch = {
      id: nid('ch_'),
      code,
      title,
      activity,
      rules: rules || '',
      stakeKobo: naira * 100,
      housePercent,
      status: 'open',
      creator: seat(player),
      opponent: null,
      createdAt: now(),
      joinBy: deadline || (now() + joinWindowMs),
      deadline,
      reportBy: null,
      heldAt: null,
      winnerRole: null,
      disputeReason: null,
      resolution: null,
      settlement: null,
      extraRefunds: [],
      extraQueued: 0,
      audit: []
    };
    audit(ch, 'created', player.id, title);
    state.challenges.push(ch);
    commit();
    return { ok: true, challenge: ch };
  }

  function join(input) {
    const ch = byCode(input && input.code);
    if (!ch) return { ok: false, error: 'unknown', message: 'No challenge with that code.' };
    tick(ch);
    const player = playerById(input.playerId);
    if (!player) { commit(); return { ok: false, error: 'player', message: 'Tell us who you are first.' }; }
    if (ch.creator.id === player.id) { commit(); return { ok: false, error: 'self', message: 'You opened this one. Share the code with the other player.' }; }
    if (ch.opponent && ch.opponent.id === player.id) { commit(); return { ok: true, duplicate: true, challenge: ch }; }
    if (ch.status !== 'open' || ch.opponent) { commit(); return { ok: false, error: 'closed', message: 'This challenge is not open to join.' }; }
    ch.opponent = seat(player);
    ch.status = 'joined';
    audit(ch, 'joined', player.id, player.name);
    commit();
    return { ok: true, challenge: ch };
  }

  function recordPayment(input) {
    const ch = byCode(input && input.code);
    if (!ch) return { ok: false, error: 'unknown', message: 'No challenge with that code.' };
    tick(ch);
    const reference = String((input && input.reference) || '');
    const player = findSeat(ch, input && input.playerId);
    if (!reference) { commit(); return { ok: false, error: 'reference', message: 'Missing payment reference.' }; }
    if (!player) { commit(); return { ok: false, error: 'player', message: 'You are not in this challenge.' }; }
    if (player.paid && player.paymentRef === reference) { commit(); return { ok: true, duplicate: true, challenge: ch }; }
    if (knownRef(ch, reference) && !player.paid) { commit(); return { ok: true, duplicate: true, queue: false, challenge: ch }; }
    const status = String((input && input.status) || '');
    if (status !== 'success') {
      commit();
      return { ok: false, error: status === 'failed' || status === 'reversed' ? 'failed' : 'pending', challenge: ch };
    }
    const amountKobo = Number(input.amountKobo) || 0;
    const currency = String(input.currency || 'NGN').toUpperCase();
    if (currency !== 'NGN' || amountKobo !== ch.stakeKobo) {
      const why = currency !== 'NGN' ? 'wrong-currency' : 'wrong-amount';
      const queued = queueExtra(ch, reference, player, amountKobo || ch.stakeKobo, why);
      commit();
      return Object.assign({ challenge: ch, message: 'That payment does not match this challenge. It goes back.' }, queued, { ok: false, error: 'amount' });
    }
    if (player.paid) { commit(); return { ok: false, error: 'already-paid', challenge: ch }; }
    if (ch.status !== 'open' && ch.status !== 'joined') {
      const queued = queueExtra(ch, reference, player, amountKobo, 'closed');
      commit();
      return Object.assign({ challenge: ch, message: 'This challenge is closed. The payment goes back.' }, queued);
    }
    player.paid = true;
    player.paymentRef = reference;
    player.paidAt = now();
    ledgerPush(ch, 'stake-in', player.id, ch.stakeKobo, reference, 'paid in');
    audit(ch, 'paid', player.id, reference);
    if (ch.creator.paid && ch.opponent && ch.opponent.paid) {
      ch.status = 'held';
      ch.heldAt = now();
      const longEnough = ch.deadline && ch.deadline >= ch.heldAt + 60 * 60 * 1000;
      ch.reportBy = longEnough ? ch.deadline : ch.heldAt + reportWindowMs;
      audit(ch, 'held', null, 'both paid, funds held');
    }
    commit();
    return { ok: true, paid: true, challenge: ch };
  }

  function report(input) {
    const ch = byCode(input && input.code);
    if (!ch) return { ok: false, error: 'unknown', message: 'No challenge with that code.' };
    tick(ch);
    const player = findSeat(ch, input && input.playerId);
    if (!player) { commit(); return { ok: false, error: 'player', message: 'You are not in this challenge.' }; }
    if (player.report) { commit(); return { ok: true, duplicate: true, challenge: ch }; }
    if (ch.status !== 'held' && ch.status !== 'reported') {
      commit();
      return { ok: false, error: 'state', message: 'You can name a winner only while Onile is holding the pot.' };
    }
    const winnerRole = input.winnerRole === 'creator' || input.winnerRole === 'opponent' ? input.winnerRole : null;
    if (!winnerRole || (winnerRole === 'opponent' && !ch.opponent)) {
      commit();
      return { ok: false, error: 'winner', message: 'Name one of the two players.' };
    }
    player.report = winnerRole;
    audit(ch, 'reported', player.id, winnerRole);
    const other = player === ch.creator ? ch.opponent : ch.creator;
    if (!other || !other.report) {
      ch.status = 'reported';
      commit();
      return { ok: true, challenge: ch };
    }
    if (other.report === winnerRole) {
      const planned = plan(ch, 'winner', [winnerLine(ch, winnerRole)], winnerRole);
      commit();
      return { ok: true, queue: !!planned.queue, duplicate: !!planned.duplicate, challenge: ch };
    }
    ch.status = 'disputed';
    ch.disputeReason = 'disagree';
    audit(ch, 'disputed', null, 'the two reports do not match');
    commit();
    return { ok: true, challenge: ch };
  }

  function resolve(input) {
    const ch = byCode(input && input.code);
    if (!ch) return { ok: false, error: 'unknown', message: 'No challenge with that code.' };
    tick(ch);
    if (ch.status !== 'disputed') { commit(); return { ok: false, error: 'state', message: 'Only a dispute can be resolved.' }; }
    if (ch.settlement) { commit(); return { ok: true, duplicate: true, challenge: ch }; }
    const action = String((input && input.action) || '');
    const note = cleanText((input && input.note) || '', 0, 200) || '';
    if (action === 'winner') {
      const winnerRole = input.winnerRole === 'creator' || input.winnerRole === 'opponent' ? input.winnerRole : null;
      if (!winnerRole || !personByRole(ch, winnerRole)) {
        commit();
        return { ok: false, error: 'winner', message: 'Pick which player is paid.' };
      }
      ch.resolution = { action, winnerRole, note, at: now(), actor: input.actor || 'admin' };
      const planned = plan(ch, 'winner', [winnerLine(ch, winnerRole)], winnerRole);
      audit(ch, 'resolved', 'admin', 'winner');
      commit();
      return { ok: true, queue: !!planned.queue, challenge: ch };
    }
    if (action === 'split' || action === 'refund') {
      const lines = refundLines(ch, action);
      if (!lines.length) { commit(); return { ok: false, error: 'empty', message: 'Nothing was paid in to send back.' }; }
      ch.resolution = { action, winnerRole: null, note, at: now(), actor: input.actor || 'admin' };
      const planned = plan(ch, action === 'split' ? 'split' : 'refund', lines);
      audit(ch, 'resolved', 'admin', action);
      commit();
      return { ok: true, queue: !!planned.queue, challenge: ch };
    }
    commit();
    return { ok: false, error: 'action', message: 'Choose a winner, a split, or a refund.' };
  }

  function get(code) {
    const ch = byCode(code);
    if (!ch) return null;
    tick(ch);
    commit();
    return ch;
  }
  function tickAll() {
    const codes = [];
    for (const ch of state.challenges) {
      if (tick(ch)) codes.push(ch.code);
    }
    if (codes.length) commit();
    return codes;
  }
  function pendingEntries(ch) {
    const entries = [];
    if (ch.settlement && !ch.settlement.dispatched) {
      for (const line of ch.settlement.lines) entries.push(line.entry);
    }
    const extras = ch.extraRefunds || [];
    const from = ch.extraQueued || 0;
    for (let i = from; i < extras.length; i++) entries.push(extras[i].entry);
    return entries;
  }
  // Hand each planned line to the payout queue once. fromLedger is
  // idempotent by reference, and dispatched makes the second pass empty.
  function drain(code, payouts) {
    const ch = byCode(code);
    if (!ch || !payouts) return { ok: false, error: 'unknown' };
    const changed = tick(ch);
    const entries = pendingEntries(ch);
    if (!entries.length) {
      if (changed) commit();
      return { ok: true, duplicate: true, ids: [] };
    }
    const ids = [];
    for (const entry of entries) {
      const row = payouts.fromLedger(entry);
      if (!row) { if (changed) commit(); return { ok: false, error: 'queue' }; }
      ids.push(row.id);
    }
    if (ch.settlement) ch.settlement.dispatched = true;
    ch.extraQueued = (ch.extraRefunds || []).length;
    commit();
    return { ok: true, duplicate: false, ids };
  }
  function list() { return state.challenges.slice(); }
  function ledger() { return state.ledger.slice(); }
  function player(id) {
    const p = playerById(id);
    return p ? { id: p.id, name: p.name, email: p.email } : null;
  }
  function playerByEmail(email) {
    const em = cleanEmail(email);
    const p = em ? state.players.find((x) => x.email === em) : null;
    return p ? { id: p.id, name: p.name, email: p.email } : null;
  }

  function statement(ch, person) {
    if (!person || !person.report) return null;
    const winner = personByRole(ch, person.report);
    return { name: person.name, winner: winner ? winner.name : null, role: person.report };
  }
  function publicView(ch, viewerId) {
    const m = moneyOf(ch);
    const you = roleOf(ch, viewerId);
    const bothReported = !!(ch.creator.report && ch.opponent && ch.opponent.report);
    const showBoth = bothReported || ch.status === 'disputed' || ch.status === 'agreed' || ch.status === 'resolved';
    let statements = [];
    if (showBoth) statements = [statement(ch, ch.creator), statement(ch, ch.opponent)].filter(Boolean);
    else if (you === 'creator') statements = [statement(ch, ch.creator)].filter(Boolean);
    else if (you === 'opponent') statements = [statement(ch, ch.opponent)].filter(Boolean);
    const seatView = (p) => (p ? { name: p.name, paid: !!p.paid } : null);
    return {
      code: ch.code,
      title: ch.title,
      activity: ch.activity,
      rules: ch.rules,
      status: ch.status,
      stakeKobo: ch.stakeKobo,
      housePercent: ch.housePercent,
      potKobo: m.pot,
      houseKobo: m.house,
      prizeKobo: m.prize,
      joinBy: ch.joinBy,
      reportBy: ch.reportBy,
      createdAt: ch.createdAt,
      you,
      creator: seatView(ch.creator),
      opponent: seatView(ch.opponent),
      yourReport: you ? (you === 'creator' ? ch.creator.report : ch.opponent.report) : null,
      winnerRole: ch.winnerRole,
      winnerName: ch.winnerRole ? (personByRole(ch, ch.winnerRole) || {}).name || null : null,
      disputeReason: ch.disputeReason,
      resolution: ch.resolution ? { action: ch.resolution.action, winnerRole: ch.resolution.winnerRole || null, note: ch.resolution.note || '' } : null,
      statements
    };
  }
  function adminView(ch) {
    const base = publicView(ch, null);
    base.creator = ch.creator ? { name: ch.creator.name, email: ch.creator.email, paid: !!ch.creator.paid, report: ch.creator.report } : null;
    base.opponent = ch.opponent ? { name: ch.opponent.name, email: ch.opponent.email, paid: !!ch.opponent.paid, report: ch.opponent.report } : null;
    base.statements = [statement(ch, ch.creator), statement(ch, ch.opponent)].filter(Boolean);
    base.audit = ch.audit.slice();
    base.ledger = state.ledger.filter((l) => l.challengeId === ch.id);
    base.settlement = ch.settlement ? {
      kind: ch.settlement.kind,
      dispatched: !!ch.settlement.dispatched,
      lines: ch.settlement.lines.map((l) => ({ kind: l.entry.kind, amountKobo: l.amountKobo, accountId: l.accountId }))
    } : null;
    return base;
  }
  function mine(playerId) {
    const rows = [];
    for (const ch of state.challenges) {
      if (ch.creator.id !== playerId && (!ch.opponent || ch.opponent.id !== playerId)) continue;
      tick(ch);
      rows.push(publicView(ch, playerId));
    }
    commit();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return rows;
  }
  function disputes() {
    const rows = [];
    for (const ch of state.challenges) {
      tick(ch);
      if (ch.status === 'disputed') rows.push(adminView(ch));
    }
    commit();
    rows.sort((a, b) => a.createdAt - b.createdAt);
    return rows;
  }

  return {
    upsertPlayer, create, join, recordPayment, report, resolve, get, tickAll, drain,
    list, ledger, player, playerByEmail, publicView, adminView, mine, disputes, moneyOf
  };
}

module.exports = { createEscrow, clampPercent, moneyOf, normCode, DEFAULT_HOUSE_PERCENT };
