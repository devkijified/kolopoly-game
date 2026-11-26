import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createEscrow } = require('../escrow');

function world() {
  let t = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onile-admin-'));
  const escrow = createEscrow({
    file: path.join(dir, 'escrow.json'),
    now: () => t,
    joinWindowMs: 7 * 24 * 60 * 60 * 1000,
    reportWindowMs: 7 * 24 * 60 * 60 * 1000,
    housePercent: 10
  });
  const ada = escrow.upsertPlayer({ name: 'Ada', email: 'ada@example.com' }).player;
  const bola = escrow.upsertPlayer({ name: 'Bola', email: 'bola@example.com' }).player;
  const chi = escrow.upsertPlayer({ name: 'Chioma', email: 'chioma@example.com' }).player;
  function pay(code, player) {
    const ch = escrow.get(code);
    const out = escrow.recordPayment({
      code, playerId: player.id, reference: 'pay_' + code + '_' + player.id,
      amountKobo: ch.stakeKobo, currency: 'NGN', status: 'success'
    });
    assert.equal(out.ok, true, out.message || out.error);
  }
  function pair(title) {
    const made = escrow.create({ playerId: ada.id, title, activity: 'FIFA', stakeNaira: 1000, maxPlayers: 2 });
    assert.equal(made.ok, true);
    escrow.join({ code: made.challenge.code, playerId: bola.id });
    pay(made.challenge.code, ada);
    pay(made.challenge.code, bola);
    return made.challenge.code;
  }
  const expiring = escrow.create({ playerId: ada.id, title: 'Expires', activity: 'Chess', stakeNaira: 1000 });
  expiring.challenge.joinBy = t - 1000;
  assert.equal(escrow.get(expiring.challenge.code).status, 'expired');

  const open = escrow.create({ playerId: ada.id, title: 'Just opened', activity: 'Chess', stakeNaira: 2000 }).challenge.code;
  const waiting = escrow.create({ playerId: ada.id, title: 'One paid', activity: 'FIFA', stakeNaira: 1500, maxPlayers: 4 }).challenge.code;
  escrow.join({ code: waiting, playerId: bola.id });
  pay(waiting, ada);
  assert.equal(escrow.get(waiting).status, 'joined');

  const live = pair('Playing');
  const reporting = pair('Reports');
  escrow.report({ code: reporting, playerId: ada.id, winnerId: ada.id });
  const fight = pair('Disagree');
  escrow.report({ code: fight, playerId: ada.id, winnerId: ada.id });
  escrow.report({ code: fight, playerId: bola.id, winnerId: bola.id });
  const done = pair('Agreed');
  escrow.report({ code: done, playerId: ada.id, winnerId: ada.id });
  escrow.report({ code: done, playerId: bola.id, winnerId: ada.id });

  const refund = escrow.create({ playerId: ada.id, title: 'Called off', activity: 'Race', stakeNaira: 1000, maxPlayers: 3 }).challenge.code;
  escrow.join({ code: refund, playerId: chi.id });
  pay(refund, ada);
  escrow.cancel({ code: refund, playerId: ada.id });
  const dropped = escrow.create({ playerId: ada.id, title: 'Empty cancel', activity: 'Ayo', stakeNaira: 1000 }).challenge.code;
  escrow.cancel({ code: dropped, playerId: ada.id });

  return {
    dir, escrow,
    codes: {
      expired: expiring.challenge.code, open, waiting, live, reporting, fight, done, refund, dropped
    }
  };
}

test('the desk lists every challenge state, including open and paid', () => {
  const { escrow, codes } = world();
  const view = escrow.overview();
  const byCode = Object.fromEntries(view.challenges.map((c) => [c.code, c]));
  assert.equal(byCode[codes.open].bucket, 'open');
  assert.equal(byCode[codes.open].status, 'open');
  assert.equal(byCode[codes.waiting].bucket, 'open');
  assert.equal(byCode[codes.waiting].status, 'joined');
  assert.equal(byCode[codes.waiting].paidCount, 1);
  assert.ok(byCode[codes.waiting].players.some((p) => p.paid && p.paymentRef));
  assert.equal(byCode[codes.live].bucket, 'live');
  assert.equal(byCode[codes.reporting].bucket, 'live');
  assert.equal(byCode[codes.fight].bucket, 'disputes');
  assert.equal(byCode[codes.fight].statements.length, 2);
  assert.equal(byCode[codes.done].bucket, 'settled');
  assert.equal(byCode[codes.refund].bucket, 'settled');
  assert.equal(byCode[codes.dropped].bucket, 'settled');
  assert.equal(byCode[codes.expired].bucket, 'settled');
  assert.equal(view.challenges.length, 9);
  assert.equal(view.stats.open, 2);
  assert.equal(view.stats.live, 2);
  assert.equal(view.stats.disputes, 1);
  assert.equal(view.stats.settled, 4);
  assert.ok(view.stats.heldKobo > 0);
  assert.equal(view.stats.users, 3);
  assert.ok(byCode[codes.waiting].timeline.some((item) => item.kind === 'payment' && item.ref));
});

test('the admin queue endpoint returns every state and stays locked without the key', async () => {
  const { dir, codes } = world();
  const port = 4293;
  const child = spawn(process.execPath, ['onile/server.js'], {
    cwd: path.join(import.meta.dirname, '..', '..'),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      KP_ADMIN_TOKEN: 'desk-test-key',
      KP_AUTH_SECRET: 'admin-overview-secret',
      KP_TEST: '1',
      ONILE_DATA_DIR: dir,
      ONILE_PUBLIC_URL: 'http://127.0.0.1:' + port,
      RESEND_API_KEY: '',
      PAYSTACK_SECRET_KEY: ''
    }),
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const base = 'http://127.0.0.1:' + port;
  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(base + '/api/health')).ok) { up = true; break; } } catch (e) {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(up, true);
    const locked = await fetch(base + '/api/admin/queue');
    assert.equal(locked.status, 401);
    const opened = await fetch(base + '/api/admin/unlock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'desk-test-key' })
    });
    assert.equal(opened.status, 200);
    const cookie = (opened.headers.get('set-cookie') || '').split(';')[0];
    const queue = await fetch(base + '/api/admin/queue', { headers: { Cookie: cookie } });
    const body = await queue.json();
    assert.equal(queue.status, 200);
    const found = new Set(body.challenges.map((c) => c.code));
    for (const code of Object.values(codes)) assert.equal(found.has(code), true, code);
    assert.equal(body.challenges.find((c) => c.code === codes.open).bucket, 'open');
    assert.equal(body.challenges.find((c) => c.code === codes.waiting).players.some((p) => p.paid), true);
    const prize = body.payouts.find((p) => p.roomCode === codes.done && p.kind === 'prize');
    assert.ok(prize);
    assert.equal(prize.bank, null);
    const blocked = await fetch(base + '/api/admin/payouts/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ id: prize.id, note: 'paid by hand' })
    });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 400);
    assert.equal(blockedBody.message, 'Waiting for bank details');
    const again = await (await fetch(base + '/api/admin/queue', { headers: { Cookie: cookie } })).json();
    assert.equal(again.payouts.find((p) => p.id === prize.id).status, 'awaiting-bank');
  } finally {
    child.kill('SIGTERM');
  }
});
