import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createEscrow, moneyOf } = require('../escrow');

function harness(opts) {
  opts = opts || {};
  let t = 1_700_000_000_000;
  const escrow = createEscrow({
    memory: true,
    now: () => t,
    joinWindowMs: 60 * 1000,
    reportWindowMs: 60 * 1000,
    housePercent: opts.housePercent
  });
  return {
    escrow,
    advance(ms) { t += ms; },
    player(name, email) {
      const r = escrow.upsertPlayer({ name, email });
      assert.equal(r.ok, true);
      return r.player;
    }
  };
}

function pay(escrow, code, player) {
  const ch = escrow.get(code);
  return escrow.recordPayment({
    code, playerId: player.id, reference: 'pay_' + code + '_' + player.id,
    amountKobo: ch.stakeKobo, currency: 'NGN', status: 'success'
  });
}

function table(count, max) {
  const h = harness();
  const people = [];
  for (let i = 0; i < count; i++) people.push(h.player('P' + i, 'p' + i + '@example.com'));
  const made = h.escrow.create({
    playerId: people[0].id, title: 'Table ' + count, activity: 'FIFA', stakeNaira: 1000, maxPlayers: max || count
  });
  assert.equal(made.ok, true, made.message);
  const code = made.challenge.code;
  for (let i = 1; i < count; i++) {
    const joined = h.escrow.join({ code, playerId: people[i].id });
    assert.equal(joined.ok, true, joined.message);
  }
  return { h, people, code };
}

test('house cut gives leftover kobo to the house and balances', () => {
  const odd = moneyOf({ stakeKobo: 1, housePercent: 10, maxPlayers: 3, status: 'open', players: [] });
  assert.equal(odd.pot, 3);
  assert.equal(odd.prize, 2);
  assert.equal(odd.house, 1);
  assert.equal(odd.prize + odd.house, odd.pot);
  const held = moneyOf({
    stakeKobo: 10001, housePercent: 10, status: 'held',
    players: [{ paid: true }, { paid: true }, { paid: true }]
  });
  assert.equal(held.pot, 30003);
  assert.equal(held.prize, Math.floor(30003 * 90 / 100));
  assert.equal(held.house, held.pot - held.prize);
  assert.equal(held.prize + held.house, held.pot);
});

test('2, 3 and 8 players agree and the winner is paid once', () => {
  for (const n of [2, 3, 8]) {
    const { h, people, code } = table(n);
    for (const p of people) {
      const paid = pay(h.escrow, code, p);
      assert.equal(paid.ok, true);
    }
    const held = h.escrow.get(code);
    assert.equal(held.status, 'held');
    assert.equal(held.players.length, n);
    const m = h.escrow.moneyOf(held);
    assert.equal(m.pot, 1000 * 100 * n);
    assert.equal(m.prize + m.house, m.pot);
    assert.equal(m.house, m.pot - m.prize);
    for (const p of people) h.escrow.report({ code, playerId: p.id, winnerId: people[0].id });
    const done = h.escrow.get(code);
    assert.equal(done.status, 'agreed');
    assert.equal(done.winnerId, people[0].id);
    assert.equal(done.settlement.lines.length, 1);
    assert.equal(done.settlement.lines[0].amountKobo, m.prize);
    assert.equal(h.escrow.ledger().filter((l) => l.code === code && l.type === 'prize').length, 1);
    h.escrow.report({ code, playerId: people[0].id, winnerId: people[0].id });
    assert.equal(h.escrow.ledger().filter((l) => l.code === code && l.type === 'prize').length, 1);
  }
});

test('a disagreeing report opens a dispute and lists every statement', () => {
  const { h, people, code } = table(3);
  for (const p of people) pay(h.escrow, code, p);
  h.escrow.report({ code, playerId: people[0].id, winnerId: people[0].id });
  h.escrow.report({ code, playerId: people[1].id, winnerId: people[0].id });
  assert.equal(h.escrow.get(code).status, 'reported');
  h.escrow.report({ code, playerId: people[2].id, winnerId: people[2].id });
  const ch = h.escrow.get(code);
  assert.equal(ch.status, 'disputed');
  assert.equal(ch.disputeReason, 'disagree');
  assert.equal(ch.settlement, null);
  const desk = h.escrow.disputes().find((row) => row.code === code);
  assert.equal(desk.statements.length, 3);
  const names = desk.statements.map((s) => s.name + '->' + s.winner).sort();
  assert.deepEqual(names, ['P0->P0', 'P1->P0', 'P2->P2']);
});

test('missing reports after the deadline become a dispute', () => {
  const { h, people, code } = table(3);
  for (const p of people) pay(h.escrow, code, p);
  h.escrow.report({ code, playerId: people[0].id, winnerId: people[1].id });
  h.advance(60 * 1000);
  const ch = h.escrow.get(code);
  assert.equal(ch.status, 'disputed');
  assert.equal(ch.disputeReason, 'timeout');
});

test('cancel before the start refunds every paid seat once', () => {
  const { h, people, code } = table(4);
  pay(h.escrow, code, people[0]);
  pay(h.escrow, code, people[2]);
  assert.equal(h.escrow.get(code).status, 'joined');
  const cancelled = h.escrow.cancel({ code, playerId: people[0].id });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.challenge.status, 'refunded');
  assert.equal(cancelled.challenge.settlement.lines.length, 2);
  const refs = cancelled.challenge.settlement.lines.map((l) => l.entry.reference).sort();
  assert.deepEqual(refs, ['pay_' + code + '_' + people[0].id, 'pay_' + code + '_' + people[2].id].sort());
  h.escrow.cancel({ code, playerId: people[0].id });
  assert.equal(h.escrow.ledger().filter((l) => l.code === code && l.type === 'refund').length, 2);
});

test('the creator can start once two have paid and unpaid seats are dropped', () => {
  const { h, people, code } = table(4);
  pay(h.escrow, code, people[0]);
  const early = h.escrow.start({ code, playerId: people[0].id });
  assert.equal(early.ok, false);
  pay(h.escrow, code, people[1]);
  pay(h.escrow, code, people[3]);
  const started = h.escrow.start({ code, playerId: people[0].id });
  assert.equal(started.ok, true);
  assert.equal(started.challenge.status, 'held');
  assert.equal(started.challenge.players.length, 3);
  assert.equal(started.challenge.players.some((p) => p.id === people[2].id), false);
  assert.equal(h.escrow.moneyOf(started.challenge).pot, 1000 * 100 * 3);
});

test('a full table starts on its own when the paid seats are enough', () => {
  const { h, people, code } = table(3, 3);
  pay(h.escrow, code, people[0]);
  pay(h.escrow, code, people[1]);
  assert.equal(h.escrow.get(code).status, 'joined');
  pay(h.escrow, code, people[2]);
  assert.equal(h.escrow.get(code).status, 'held');
});

test('a legacy creator and opponent row keeps both paid seats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onile-legacy-'));
  const file = path.join(dir, 'escrow.json');
  const legacy = {
    players: [],
    ledger: [],
    challenges: [{
      id: 'ch_old',
      code: 'LEGACY01',
      title: 'Old match',
      activity: 'Chess',
      rules: '',
      stakeKobo: 250000,
      housePercent: 10,
      status: 'joined',
      creator: { id: 'a_ada', name: 'Ada', email: 'ada@example.com', paid: true, paymentRef: 'ref_ada', paidAt: 10, report: null },
      opponent: { id: 'a_bola', name: 'Bola', email: 'bola@example.com', paid: true, paymentRef: 'ref_bola', paidAt: 11, report: 'creator' },
      createdAt: 1,
      joinBy: 9_000_000_000_000,
      deadline: null,
      reportBy: null,
      heldAt: null,
      winnerRole: null,
      disputeReason: null,
      resolution: null,
      settlement: null,
      extraRefunds: [],
      extraQueued: 0,
      audit: []
    }]
  };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const escrow = createEscrow({ file, now: () => 20 });
  const ch = escrow.get('LEGACY01');
  assert.equal(ch.players.length, 2);
  assert.equal(ch.players[0].paymentRef, 'ref_ada');
  assert.equal(ch.players[1].paymentRef, 'ref_bola');
  assert.equal(ch.players[0].paid, true);
  assert.equal(ch.players[1].paid, true);
  assert.equal(ch.players[1].report, 'a_ada');
  assert.equal(ch.maxPlayers, 2);
  const again = JSON.parse(fs.readFileSync(file, 'utf8')).challenges[0];
  assert.equal(again.players[0].paymentRef, 'ref_ada');
  assert.equal(again.players[1].paid, true);
});
