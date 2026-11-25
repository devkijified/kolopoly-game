import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createEscrow } = require('../escrow');
const { createPaystack, createPaymentStore } = require('../../paystack');
const { createPayouts } = require('../../payouts');

function harness(opts) {
  opts = opts || {};
  let t = 1_700_000_000_000;
  const config = {
    memory: true,
    now: () => t,
    joinWindowMs: 60 * 1000,
    reportWindowMs: 60 * 1000
  };
  if (opts.housePercent != null) config.housePercent = opts.housePercent;
  const escrow = createEscrow(config);
  return {
    escrow,
    advance(ms) { t += ms; },
    player(name, email) {
      const r = escrow.upsertPlayer({ name, email });
      assert.equal(r.ok, true, r.message || r.error);
      return r.player;
    }
  };
}

function pay(escrow, code, player, ref) {
  const ch = escrow.get(code);
  return escrow.recordPayment({
    code, playerId: player.id, reference: ref,
    amountKobo: ch.stakeKobo, currency: 'NGN', status: 'success'
  });
}

function openHeld() {
  const h = harness();
  const ada = h.player('Ada', 'ada@example.com');
  const bola = h.player('Bola', 'bola@example.com');
  const made = h.escrow.create({ playerId: ada.id, title: 'Friday FIFA', activity: 'FIFA', stakeNaira: 5000, rules: 'Best of three.' });
  assert.equal(made.ok, true);
  const code = made.challenge.code;
  assert.equal(made.challenge.status, 'open');
  const joined = h.escrow.join({ code, playerId: bola.id });
  assert.equal(joined.ok, true);
  assert.equal(joined.challenge.status, 'joined');
  const a = pay(h.escrow, code, ada, 'onile_ada');
  const b = pay(h.escrow, code, bola, 'onile_bola');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(h.escrow.get(code).status, 'held');
  return { h, ada, bola, code };
}

test('create, join, both paid, agree, one payout', () => {
  const { h, ada, bola, code } = openHeld();
  const ch = h.escrow.get(code);
  assert.equal(ch.stakeKobo, 500000);
  assert.equal(ch.housePercent, 10);
  const m = h.escrow.moneyOf(ch);
  assert.equal(m.pot, 1000000);
  assert.equal(m.house, 100000);
  assert.equal(m.prize, 900000);
  assert.equal(h.escrow.ledger().filter((l) => l.type === 'stake-in').length, 2);

  const first = h.escrow.report({ code, playerId: ada.id, winnerRole: 'creator' });
  assert.equal(first.challenge.status, 'reported');
  assert.equal(first.challenge.settlement, null);
  const again = h.escrow.report({ code, playerId: ada.id, winnerRole: 'opponent' });
  assert.equal(again.duplicate, true);
  assert.equal(h.escrow.get(code).creator.report, ada.id);

  const second = h.escrow.report({ code, playerId: bola.id, winnerRole: 'creator' });
  assert.equal(second.challenge.status, 'agreed');
  assert.equal(second.queue, true);
  const agreed = h.escrow.get(code);
  assert.equal(agreed.settlement.lines.length, 1);
  assert.equal(agreed.settlement.lines[0].entry.kind, 'prize');
  assert.equal(agreed.settlement.lines[0].entry.amountKobo, 900000);
  assert.equal(agreed.settlement.lines[0].entry.gameKey, 'onile:' + agreed.id);
  assert.equal(h.escrow.ledger().filter((l) => l.type === 'prize').length, 1);
  assert.equal(h.escrow.ledger().filter((l) => l.type === 'house').length, 1);
  assert.ok(agreed.audit.some((a) => a.type === 'created'));
  assert.ok(agreed.audit.some((a) => a.type === 'joined'));
  assert.ok(agreed.audit.some((a) => a.type === 'paid'));
  assert.ok(agreed.audit.some((a) => a.type === 'held'));
  assert.ok(agreed.audit.some((a) => a.type === 'settled'));

  const replay = h.escrow.report({ code, playerId: bola.id, winnerRole: 'creator' });
  assert.equal(replay.duplicate, true);
  assert.equal(h.escrow.ledger().filter((l) => l.type === 'prize').length, 1);
});

test('disagree opens a dispute and pays nobody', () => {
  const { h, ada, bola, code } = openHeld();
  h.escrow.report({ code, playerId: ada.id, winnerRole: 'creator' });
  const second = h.escrow.report({ code, playerId: bola.id, winnerRole: 'opponent' });
  assert.equal(second.challenge.status, 'disputed');
  assert.equal(second.challenge.disputeReason, 'disagree');
  assert.equal(second.challenge.settlement, null);
  assert.equal(h.escrow.ledger().some((l) => l.type === 'prize'), false);
  assert.equal(h.escrow.disputes().length, 1);
});

test('admin resolve winner, split, and refund are each once', () => {
  function disputed() {
    const opened = openHeld();
    opened.h.escrow.report({ code: opened.code, playerId: opened.ada.id, winnerRole: 'creator' });
    opened.h.escrow.report({ code: opened.code, playerId: opened.bola.id, winnerRole: 'opponent' });
    return opened;
  }
  {
    const { h, code } = disputed();
    const done = h.escrow.resolve({ code, action: 'winner', winnerRole: 'opponent' });
    assert.equal(done.ok, true);
    assert.equal(done.challenge.status, 'agreed');
    assert.equal(done.challenge.winnerRole, 'opponent');
    assert.equal(done.challenge.settlement.lines.length, 1);
    const second = h.escrow.resolve({ code, action: 'refund' });
    assert.equal(second.ok, false);
    assert.equal(h.escrow.ledger().filter((l) => l.type === 'prize').length, 1);
  }
  {
    const { h, code } = disputed();
    const done = h.escrow.resolve({ code, action: 'split', note: 'Share it back.' });
    assert.equal(done.challenge.status, 'resolved');
    assert.equal(done.challenge.settlement.kind, 'split');
    assert.equal(done.challenge.settlement.lines.length, 2);
    assert.equal(h.escrow.ledger().filter((l) => l.type === 'split').length, 2);
    assert.equal(h.escrow.ledger().some((l) => l.type === 'prize'), false);
    h.escrow.resolve({ code, action: 'split' });
    assert.equal(h.escrow.ledger().filter((l) => l.type === 'split').length, 2);
  }
  {
    const { h, code } = disputed();
    const done = h.escrow.resolve({ code, action: 'refund' });
    assert.equal(done.challenge.status, 'refunded');
    assert.equal(done.challenge.settlement.lines.length, 2);
    assert.equal(h.escrow.ledger().filter((l) => l.type === 'refund').length, 2);
    const second = h.escrow.resolve({ code, action: 'winner', winnerRole: 'creator' });
    assert.equal(second.ok, false);
    assert.equal(h.escrow.ledger().filter((l) => l.type === 'refund').length, 2);
  }
});

test('expiry refunds whoever paid and does it once', () => {
  const h = harness();
  const ada = h.player('Ada', 'ada@example.com');
  const bola = h.player('Bola', 'bola@example.com');
  const made = h.escrow.create({ playerId: ada.id, title: 'Quiet table', activity: 'Chess', stakeNaira: 2000 });
  const code = made.challenge.code;
  pay(h.escrow, code, ada, 'onile_only_ada');
  assert.equal(h.escrow.get(code).status, 'open');
  h.advance(60 * 1000);
  const expired = h.escrow.get(code);
  assert.equal(expired.status, 'refunded');
  assert.equal(expired.settlement.lines.length, 1);
  assert.equal(expired.settlement.lines[0].entry.reference, 'onile_only_ada');
  assert.equal(h.escrow.ledger().filter((l) => l.type === 'refund').length, 1);
  h.advance(60 * 1000);
  h.escrow.get(code);
  assert.equal(h.escrow.ledger().filter((l) => l.type === 'refund').length, 1);

  const bare = h.escrow.create({ playerId: bola.id, title: 'No show', activity: 'Race', stakeNaira: 1500 });
  h.advance(60 * 1000);
  assert.equal(h.escrow.get(bare.challenge.code).status, 'expired');
  assert.equal(h.escrow.get(bare.challenge.code).settlement, null);
});

test('join then one payment, expiry refunds only that payment', () => {
  const h = harness();
  const ada = h.player('Ada', 'ada@example.com');
  const bola = h.player('Bola', 'bola@example.com');
  const made = h.escrow.create({ playerId: ada.id, title: 'Late pot', activity: 'Whot', stakeNaira: 1000 });
  const code = made.challenge.code;
  h.escrow.join({ code, playerId: bola.id });
  pay(h.escrow, code, bola, 'onile_bola_only');
  h.advance(60 * 1000);
  const ch = h.escrow.get(code);
  assert.equal(ch.status, 'refunded');
  assert.equal(ch.settlement.lines.length, 1);
  assert.equal(ch.settlement.lines[0].accountId, bola.id);
});

test('silence past the report deadline becomes a dispute, not a payout', () => {
  const { h, ada, code } = openHeld();
  h.escrow.report({ code, playerId: ada.id, winnerRole: 'creator' });
  h.advance(60 * 1000);
  const ch = h.escrow.get(code);
  assert.equal(ch.status, 'disputed');
  assert.equal(ch.disputeReason, 'timeout');
  assert.equal(ch.settlement, null);
  assert.equal(h.escrow.ledger().some((l) => l.type === 'prize'), false);
});

test('a second payment notice does not take the amount twice', () => {
  const h = harness();
  const ada = h.player('Ada', 'ada@example.com');
  const made = h.escrow.create({ playerId: ada.id, title: 'Once', activity: 'Ayo', stakeNaira: 2500 });
  const code = made.challenge.code;
  const first = pay(h.escrow, code, ada, 'onile_once');
  const second = pay(h.escrow, code, ada, 'onile_once');
  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(h.escrow.ledger().filter((l) => l.type === 'stake-in').length, 1);
  const wrong = h.escrow.recordPayment({
    code, playerId: ada.id, reference: 'onile_wrong', amountKobo: 100, currency: 'NGN', status: 'success'
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'amount');
  assert.equal(h.escrow.get(code).creator.paid, true);
  assert.equal(h.escrow.get(code).creator.paymentRef, 'onile_once');
  assert.equal(h.escrow.ledger().filter((l) => l.type === 'refund' && l.ref === 'onile_wrong').length, 1);
  h.escrow.recordPayment({
    code, playerId: ada.id, reference: 'onile_wrong', amountKobo: 100, currency: 'NGN', status: 'success'
  });
  assert.equal(h.escrow.ledger().filter((l) => l.ref === 'onile_wrong').length, 1);
});

test('failed and pending notices do not hold funds', () => {
  const h = harness();
  const ada = h.player('Ada', 'ada@example.com');
  const made = h.escrow.create({ playerId: ada.id, title: 'Wait', activity: 'Drafts', stakeNaira: 500 });
  const code = made.challenge.code;
  const pending = h.escrow.recordPayment({
    code, playerId: ada.id, reference: 'onile_pending', amountKobo: 50000, currency: 'NGN', status: 'abandoned'
  });
  assert.equal(pending.error, 'pending');
  assert.equal(h.escrow.get(code).creator.paid, false);
  const failed = h.escrow.recordPayment({
    code, playerId: ada.id, reference: 'onile_failed', amountKobo: 50000, currency: 'USD', status: 'failed'
  });
  assert.equal(failed.error, 'failed');
  assert.equal(h.escrow.ledger().length, 0);
});

test('house percent is snapshotted, default 10', () => {
  const custom = harness({ housePercent: 5 });
  const ada = custom.player('Ada', 'ada@example.com');
  const made = custom.escrow.create({ playerId: ada.id, title: 'Small cut', activity: 'Chess', stakeNaira: 100 });
  assert.equal(made.challenge.housePercent, 5);
  assert.equal(custom.escrow.moneyOf(made.challenge).house, 1000);
  const plain = createEscrow({ memory: true, now: () => 10 });
  const who = plain.upsertPlayer({ name: 'Chi', email: 'chi@example.com' });
  const row = plain.create({ playerId: who.player.id, title: 'Default cut', activity: 'FIFA', stakeNaira: 100 });
  assert.equal(row.challenge.housePercent, 10);
});

test('amount and join guards', () => {
  const h = harness();
  const ada = h.player('Ada', 'ada@example.com');
  const low = h.escrow.create({ playerId: ada.id, title: 'Too small', activity: 'FIFA', stakeNaira: 50 });
  assert.equal(low.ok, false);
  const made = h.escrow.create({ playerId: ada.id, title: 'Real one', activity: 'FIFA', stakeNaira: 1000 });
  const self = h.escrow.join({ code: made.challenge.code, playerId: ada.id });
  assert.equal(self.ok, false);
  h.advance(60 * 1000);
  const bola = h.player('Bola', 'bola@example.com');
  const late = h.escrow.join({ code: made.challenge.code, playerId: bola.id });
  assert.equal(late.ok, false);
  assert.equal(h.escrow.get(made.challenge.code).status, 'expired');
});

test('payout queue pays a winner once and a refund once', async () => {
  const { h, ada, bola, code } = openHeld();
  h.escrow.report({ code, playerId: ada.id, winnerRole: 'creator' });
  h.escrow.report({ code, playerId: bola.id, winnerRole: 'creator' });
  const ch = h.escrow.get(code);
  let transfers = 0;
  let refunds = 0;
  const paystack = {
    enabled: true,
    listBanks: async () => ({ ok: true, banks: [{ code: '058', name: 'GTBank' }] }),
    resolveAccount: async () => ({ ok: true, accountName: 'ADA EXAMPLE', accountNumber: '0123456789' }),
    createRecipient: async () => ({ ok: true, recipientCode: 'RCP_test' }),
    transfer: async () => { transfers += 1; return { ok: true, status: 'success', transferCode: 'TRF_1' }; },
    refund: async () => { refunds += 1; return { ok: true, status: 'processed' }; }
  };
  const payments = createPaymentStore({ memory: true });
  payments.create({ reference: 'onile_ada', roomCode: code, accountId: ada.id, amountKobo: ch.stakeKobo });
  payments.update('onile_ada', { status: 'paid' });
  const payouts = createPayouts({ memory: true, paystack, payments, mode: 'manual' });
  const bank = await payouts.setBank({ accountId: ada.id }, { bankCode: '058', accountNumber: '0123456789' });
  assert.equal(bank.ok, true);
  assert.equal(bank.bank.last4, '6789');
  assert.equal(bank.bank.recipientCode, undefined);

  const first = h.escrow.drain(code, payouts);
  const second = h.escrow.drain(code, payouts);
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.ids, ['prize:onile:' + ch.id]);
  assert.equal(second.duplicate, true);
  assert.equal(payouts.list().length, 1);
  const sent = await payouts.send(first.ids[0], 'desk');
  const resent = await payouts.send(first.ids[0], 'desk');
  assert.equal(sent.ok, true);
  assert.equal(sent.status, 'paid');
  assert.equal(resent.ok, false);
  assert.equal(transfers, 1);

  const refundEscrow = harness();
  const payer = refundEscrow.player('Ada', 'ada-refund@example.com');
  const made = refundEscrow.escrow.create({ playerId: payer.id, title: 'Send back', activity: 'Chess', stakeNaira: 5000 });
  pay(refundEscrow.escrow, made.challenge.code, payer, 'onile_back');
  refundEscrow.advance(60 * 1000);
  const refundPayments = createPaymentStore({ memory: true });
  refundPayments.create({ reference: 'onile_back', roomCode: made.challenge.code, accountId: payer.id, amountKobo: 500000 });
  refundPayments.update('onile_back', { status: 'paid' });
  const refundQueue = createPayouts({ memory: true, paystack, payments: refundPayments, mode: 'manual' });
  const queued = refundEscrow.escrow.drain(made.challenge.code, refundQueue);
  const queuedAgain = refundEscrow.escrow.drain(made.challenge.code, refundQueue);
  assert.equal(queued.ids.length, 1);
  assert.equal(queuedAgain.duplicate, true);
  assert.equal(refundQueue.list().length, 1);
  const back = await refundQueue.send(queued.ids[0], 'desk');
  const backAgain = await refundQueue.send(queued.ids[0], 'desk');
  assert.equal(back.status, 'refunded');
  assert.equal(backAgain.ok, false);
  assert.equal(refunds, 1);
});

test('Paystack webhook signatures use the existing verifier', () => {
  const secret = 'sk_test_unit_only';
  const paystack = createPaystack({ secretKey: secret });
  const raw = Buffer.from(JSON.stringify({
    event: 'charge.success',
    data: { reference: 'onileabc', status: 'success', amount: 500000, currency: 'NGN' }
  }));
  const good = crypto.createHmac('sha512', secret).update(raw).digest('hex');
  assert.equal(paystack.verifySignature(raw, good), true);
  assert.equal(paystack.verifySignature(raw, good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a')), false);
  assert.equal(paystack.verifySignature(raw, ''), false);
});
