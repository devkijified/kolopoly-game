import './admin-payout.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createEscrow } = require('../escrow');
const { createWinnerMail, DEFAULT_ADMIN } = require('../winner-mail');
const { createOnileMail } = require('../mail');

function world() {
  const escrow = createEscrow({ memory: true, housePercent: 10 });
  const ada = escrow.upsertPlayer({ name: 'Ada', email: 'ada@example.com' }).player;
  const bola = escrow.upsertPlayer({ name: 'Bola', email: 'bola@example.com' }).player;
  return { escrow, ada, bola };
}
function pay(escrow, code, player) {
  const ch = escrow.get(code);
  const out = escrow.recordPayment({
    code, playerId: player.id, reference: 'pay_' + code + '_' + player.id,
    amountKobo: ch.stakeKobo, currency: 'NGN', status: 'success'
  });
  assert.equal(out.ok, true, out.message || out.error);
}
function held(title) {
  const w = world();
  const made = w.escrow.create({ playerId: w.ada.id, title, activity: 'FIFA', stakeNaira: 5000 });
  assert.equal(made.ok, true);
  const code = made.challenge.code;
  w.escrow.join({ code, playerId: w.bola.id });
  pay(w.escrow, code, w.ada);
  pay(w.escrow, code, w.bola);
  assert.equal(w.escrow.get(code).status, 'held');
  return Object.assign(w, { code });
}
function sentMails(sender) {
  return sender.sent;
}
function mockSender() {
  const sent = [];
  return {
    sent,
    async send(mail) { sent.push(mail); return { ok: true }; }
  };
}
function banks(onFile) {
  return { mine(id) { return { bank: onFile && onFile[id] ? { last4: '6789' } : null }; } };
}

test('an agreed winner emails the house once, and a second pass does not', async () => {
  const w = held('Friday FIFA');
  const sender = mockSender();
  const mail = createWinnerMail({
    escrow: w.escrow, mailer: sender, payouts: banks({}),
    adminEmail: 'kijified@gmail.com', publicUrl: 'https://onile.kolopoly.fun'
  });
  w.escrow.report({ code: w.code, playerId: w.ada.id, winnerId: w.ada.id });
  assert.equal(w.escrow.get(w.code).status, 'reported');
  await mail.flush();
  assert.equal(sentMails(sender).length, 0);

  w.escrow.report({ code: w.code, playerId: w.bola.id, winnerId: w.ada.id });
  assert.equal(w.escrow.get(w.code).status, 'agreed');
  await mail.flush();
  await mail.flush();
  assert.equal(sentMails(sender).length, 1);
  const letter = sentMails(sender)[0];
  assert.equal(letter.to, 'kijified@gmail.com');
  assert.equal(letter.subject, 'Onile: winner confirmed · ' + w.code + ' · ₦9,000');
  for (const part of [letter.text, letter.html]) {
    assert.match(part, new RegExp(w.code));
    assert.match(part, /Friday FIFA/);
    assert.match(part, /₦5,000/);
    assert.match(part, /Ada/);
    assert.match(part, /Bola/);
    assert.match(part, /₦10,000/);
    assert.match(part, /10%/);
    assert.match(part, /₦1,000/);
    assert.match(part, /₦9,000/);
    assert.match(part, /https:\/\/onile\.kolopoly\.fun\/admin\?code=/);
    assert.equal(/\b(bet|bets|betting|gambl\w*|wager)\b/i.test(part), false);
  }
  assert.match(letter.text, /Bank details on file: no/);
  assert.match(letter.html, /Open this challenge/);
  assert.match(letter.html, new RegExp('href="https://onile.kolopoly.fun/admin\\?code=' + w.code + '"'));
  const view = w.escrow.adminView(w.escrow.get(w.code));
  assert.equal(view.timeline.some((item) => item.kind === 'admin-emailed'), true);
  assert.equal(w.escrow.pendingWinnerNotices().length, 0);
});

test('an admin decision on a dispute emails once and names the bank when it is on file', async () => {
  const w = held('Night FIFA');
  w.escrow.report({ code: w.code, playerId: w.ada.id, winnerId: w.ada.id });
  w.escrow.report({ code: w.code, playerId: w.bola.id, winnerId: w.bola.id });
  assert.equal(w.escrow.get(w.code).status, 'disputed');
  const sender = mockSender();
  const mail = createWinnerMail({
    escrow: w.escrow, mailer: sender, payouts: banks({ [w.ada.id]: true }),
    publicUrl: 'https://onile.kolopoly.fun'
  });
  await mail.flush();
  assert.equal(sentMails(sender).length, 0);
  const decided = w.escrow.decide({ code: w.code, winnerId: w.ada.id, actor: 'admin' });
  assert.equal(decided.ok, true);
  assert.equal(w.escrow.get(w.code).status, 'agreed');
  await mail.flush();
  await mail.flush();
  assert.equal(sentMails(sender).length, 1);
  assert.match(sentMails(sender)[0].text, /Bank details on file: yes/);
  assert.match(sentMails(sender)[0].text, /Winner: Ada/);
});

test('a refund does not email, and a failed send never blocks the settlement', async () => {
  const w = held('Called off');
  w.escrow.report({ code: w.code, playerId: w.ada.id, winnerId: w.ada.id });
  w.escrow.report({ code: w.code, playerId: w.bola.id, winnerId: w.bola.id });
  w.escrow.get(w.code).status = 'disputed';
  w.escrow.get(w.code).settlement = null;
  const refunded = w.escrow.resolve({ code: w.code, action: 'refund', actor: 'admin' });
  assert.equal(refunded.ok, true);
  const sender = mockSender();
  const quiet = createWinnerMail({ escrow: w.escrow, mailer: sender, payouts: banks({}) });
  await quiet.flush();
  assert.equal(sentMails(sender).length, 0);

  const agreed = held('Chess <b> night');
  agreed.escrow.report({ code: agreed.code, playerId: agreed.ada.id, winnerId: agreed.ada.id });
  agreed.escrow.report({ code: agreed.code, playerId: agreed.bola.id, winnerId: agreed.ada.id });
  assert.equal(agreed.escrow.get(agreed.code).status, 'agreed');
  let fails = true;
  const flaky = {
    sent: [],
    async send(mail) {
      if (fails) throw new Error('mailbox down');
      this.sent.push(mail);
      return { ok: true };
    }
  };
  const mail = createWinnerMail({ escrow: agreed.escrow, mailer: flaky, payouts: banks({}) });
  await mail.flush();
  assert.equal(agreed.escrow.get(agreed.code).status, 'agreed');
  assert.equal(agreed.escrow.pendingWinnerNotices().length, 1);
  assert.equal(agreed.escrow.adminView(agreed.escrow.get(agreed.code)).timeline.some((item) => item.kind === 'admin-emailed'), false);
  fails = false;
  await mail.flush();
  assert.equal(flaky.sent.length, 1);
  assert.match(flaky.sent[0].html, /Chess &lt;b&gt; night/);
  assert.equal(agreed.escrow.pendingWinnerNotices().length, 0);
});

test('the house address defaults, and a refused sender is not recorded as sent', async () => {
  const prev = process.env.ONILE_ADMIN_EMAIL;
  delete process.env.ONILE_ADMIN_EMAIL;
  const w = held('Yard race');
  w.escrow.report({ code: w.code, playerId: w.ada.id, winnerId: w.bola.id });
  w.escrow.report({ code: w.code, playerId: w.bola.id, winnerId: w.bola.id });
  const refused = { sent: [], async send(mail) { this.sent.push(mail); return { ok: false }; } };
  const mail = createWinnerMail({ escrow: w.escrow, mailer: refused, payouts: banks({}) });
  assert.equal(mail.adminEmail, DEFAULT_ADMIN);
  await mail.flush();
  assert.equal(refused.sent[0].to, DEFAULT_ADMIN);
  assert.equal(w.escrow.pendingWinnerNotices().length, 1);
  if (prev == null) delete process.env.ONILE_ADMIN_EMAIL;
  else process.env.ONILE_ADMIN_EMAIL = prev;
});

test('the Resend transport posts the letter and does not log the key', async () => {
  const calls = [];
  const logs = [];
  const mailer = createOnileMail({
    apiKey: 're_test_key_not_real',
    from: 'Onile <hold@example.com>',
    log: (line) => logs.push(String(line)),
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return { ok: true };
    }
  });
  const sent = await mailer.send({
    to: 'kijified@gmail.com',
    subject: 'Onile: winner confirmed · ABCD2345 · ₦9,000',
    text: 'plain',
    html: '<p>held</p>'
  });
  assert.equal(sent.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].body.to[0], 'kijified@gmail.com');
  assert.equal(calls[0].body.subject, 'Onile: winner confirmed · ABCD2345 · ₦9,000');
  assert.equal(calls[0].body.html, '<p>held</p>');
  assert.equal(calls[0].body.text, 'plain');
  assert.equal(logs.join('\n').includes('re_test_key_not_real'), false);
  assert.equal(String(calls[0].auth || '').startsWith('Bearer '), true);
});
