import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createEscrow } = require('../escrow');
const { createPayouts } = require('../../payouts');
const { createPayoutDetails } = require('../payout-details');
const { createAuth, accountIdFor } = require('../../auth');
const { winnerLetter } = require('../winner-mail');

const ACCOUNT = '0123456789';
const SECRET = 'payout-desk-secret';

function seed(dir) {
  const adaId = accountIdFor('ada@example.com');
  const bolaId = accountIdFor('bola@example.com');
  const escrow = createEscrow({ file: path.join(dir, 'escrow.json'), housePercent: 10 });
  const ada = escrow.upsertPlayer({ accountId: adaId, name: 'Ada', email: 'ada@example.com' }).player;
  const bola = escrow.upsertPlayer({ accountId: bolaId, name: 'Bola', email: 'bola@example.com' }).player;
  const made = escrow.create({ playerId: ada.id, title: 'Friday FIFA', activity: 'FIFA', stakeNaira: 1000 });
  assert.equal(made.ok, true);
  escrow.join({ code: made.challenge.code, playerId: bola.id });
  const paystack = {
    enabled: true,
    async listBanks() { return { ok: true, banks: [{ code: '058', name: 'GTBank' }] }; },
    async resolveAccount() { return { ok: true, accountName: 'ADA OKAFOR' }; },
    async createRecipient() { return { ok: true, recipientCode: 'RCP_test' }; }
  };
  const payouts = createPayouts({ file: path.join(dir, 'payouts.json'), paystack, mode: 'manual' });
  const ready = payouts.fromLedger({
    kind: 'prize', roomCode: 'CHESSN1', gameKey: 'onile:chess', playerId: 1,
    name: 'Ada', accountId: adaId, amountKobo: 180000, at: 1
  });
  const waiting = payouts.fromLedger({
    kind: 'prize', roomCode: 'FIFAN1', gameKey: 'onile:fifa', playerId: 1,
    name: 'Bola', accountId: bolaId, amountKobo: 200000, at: 2
  });
  return { ada, bola, code: made.challenge.code, ready, waiting, payouts };
}

test('the admin desk receives the full account number and players do not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onile-payout-'));
  const seeded = seed(dir);
  const saved = await seeded.payouts.setBank({ accountId: seeded.ada.id }, { bankCode: '058', accountNumber: ACCOUNT });
  assert.equal(saved.ok, true);
  assert.equal(saved.bank.last4, '6789');
  assert.equal(JSON.stringify(saved.bank).includes(ACCOUNT), false);
  createPayoutDetails({ file: path.join(dir, 'payout-details.json') }).remember(seeded.ada.id, {
    bankName: saved.bank.bankName,
    accountName: saved.bank.accountName,
    accountNumber: ACCOUNT
  });
  const stored = fs.readFileSync(path.join(dir, 'payouts.json'), 'utf8');
  assert.equal(stored.includes(ACCOUNT), false);

  const port = 4311;
  const child = spawn(process.execPath, ['onile/server.js'], {
    cwd: path.join(import.meta.dirname, '..', '..'),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      KP_ADMIN_TOKEN: 'desk-test-key',
      KP_AUTH_SECRET: SECRET,
      KP_TEST: '1',
      KP_MAIL_TEST: '1',
      ONILE_DATA_DIR: dir,
      ONILE_PUBLIC_URL: 'http://127.0.0.1:' + port,
      RESEND_API_KEY: '',
      PAYSTACK_SECRET_KEY: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = 'http://127.0.0.1:' + port;
  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(base + '/api/health')).ok) { up = true; break; } } catch (e) {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(up, true);

    const locked = await fetch(base + '/api/admin/queue');
    const lockedBody = await locked.json();
    assert.equal(locked.status, 401);
    assert.equal(JSON.stringify(lockedBody).includes(ACCOUNT), false);

    const opened = await fetch(base + '/api/admin/unlock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'desk-test-key' })
    });
    const cookie = (opened.headers.get('set-cookie') || '').split(';')[0];
    const queue = await fetch(base + '/api/admin/queue', { headers: { Cookie: cookie } });
    const body = await queue.json();
    assert.equal(queue.status, 200);
    const ready = body.payouts.find((p) => p.id === seeded.ready.id);
    const waiting = body.payouts.find((p) => p.id === seeded.waiting.id);
    assert.equal(ready.bank.bankName, 'GTBank');
    assert.equal(ready.bank.accountName, 'ADA OKAFOR');
    assert.equal(ready.bank.accountNumber, ACCOUNT);
    assert.equal(ready.amountKobo, 180000);
    assert.equal(waiting.bank, null);
    assert.equal(JSON.stringify(waiting).includes(ACCOUNT), false);

    const auth = createAuth({ secret: SECRET });
    const requested = auth.requestCode('ada@example.com');
    const session = auth.verifyCode('ada@example.com', requested.code);
    const playerHeaders = { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' };
    const challenge = await fetch(base + '/api/challenges/' + seeded.code, { headers: playerHeaders });
    const challengeBody = await challenge.json();
    assert.equal(challenge.status, 200);
    assert.equal(challengeBody.challenge.bank.last4, '6789');
    assert.equal(challengeBody.challenge.bank.accountNumber, undefined);
    assert.equal(JSON.stringify(challengeBody).includes(ACCOUNT), false);

    const mine = await fetch(base + '/api/challenges/mine', { headers: playerHeaders });
    const mineBody = await mine.json();
    assert.equal(mine.status, 200);
    assert.equal(JSON.stringify(mineBody).includes(ACCOUNT), false);

    const bank = await fetch(base + '/api/bank', {
      method: 'POST', headers: playerHeaders,
      body: JSON.stringify({ bankCode: '058', accountNumber: ACCOUNT })
    });
    const bankBody = await bank.json();
    assert.equal(JSON.stringify(bankBody).includes(ACCOUNT), false);

    const letter = winnerLetter({
      code: 'CHESSN1', title: 'Chess', stakeKobo: 200000, housePercent: 10,
      potKobo: 200000, houseKobo: 20000, prizeKobo: 180000,
      winner: { name: 'Ada' }, players: [{ name: 'Ada' }], bankOnFile: true
    }, 'https://onile.kolopoly.fun/admin?code=CHESSN1');
    assert.equal((letter.text + letter.html).includes(ACCOUNT), false);
    assert.equal(log.includes(ACCOUNT), false);
  } finally {
    child.kill('SIGTERM');
  }
});

test('a claimed payout with claimedBank and no bank field still shows the account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onile-claimed-'));
  const kemiId = accountIdFor('kemi@example.com');
  const tundeId = accountIdFor('tunde@example.com');
  const escrow = createEscrow({ file: path.join(dir, 'escrow.json'), housePercent: 10 });
  const kemi = escrow.upsertPlayer({ accountId: kemiId, name: 'Kemi', email: 'kemi@example.com' }).player;
  escrow.create({ playerId: kemi.id, title: 'Yard race', activity: 'Race', stakeNaira: 1000 });
  const payoutFile = path.join(dir, 'payouts.json');
  const queue = createPayouts({ file: payoutFile, paystack: { enabled: false }, mode: 'manual' });
  const claimed = queue.fromLedger({
    kind: 'prize', roomCode: 'ML5ASMBW', gameKey: 'onile:claimed', playerId: 1,
    name: 'Kemi', accountId: kemiId, amountKobo: 360000, at: 1
  });
  const fetched = queue.fromLedger({
    kind: 'prize', roomCode: 'PAYSTK1', gameKey: 'onile:fetched', playerId: 1,
    name: 'Tunde', accountId: tundeId, amountKobo: 180000, at: 2
  });
  const doc = JSON.parse(fs.readFileSync(payoutFile, 'utf8'));
  const claimedRow = doc.payouts.find((p) => p.id === claimed.id);
  claimedRow.status = 'claimed';
  claimedRow.claimedBank = { bankName: 'GTBank', accountName: 'KEMI ADE', last4: '1222', at: 1 };
  delete claimedRow.bank;
  const fetchedRow = doc.payouts.find((p) => p.id === fetched.id);
  fetchedRow.status = 'claimed';
  fetchedRow.claimedBank = { bankName: 'GTBank', accountName: 'TUNDE BELLO', last4: '6789', at: 1 };
  delete fetchedRow.bank;
  doc.banks = {
    [tundeId]: { bankCode: '058', bankName: 'GTBank', accountName: 'TUNDE BELLO', last4: '6789', recipientCode: 'RCP_ok' }
  };
  fs.writeFileSync(payoutFile, JSON.stringify(doc));
  createPayoutDetails({ file: path.join(dir, 'payout-details.json') }).remember(kemiId, {
    bankName: 'GTBank', accountName: 'KEMI ADE', accountNumber: '0801111222'
  });

  const stub = http.createServer((req, res) => {
    if (req.url === '/transferrecipient/RCP_ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: true, data: { details: { account_number: '0123456789', account_name: 'TUNDE BELLO' } } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubPort = stub.address().port;
  const secret = 'sk_test_fixture_not_real';
  const port = 4312;
  const child = spawn(process.execPath, ['onile/server.js'], {
    cwd: path.join(import.meta.dirname, '..', '..'),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      KP_ADMIN_TOKEN: 'desk-test-key',
      KP_AUTH_SECRET: SECRET,
      KP_TEST: '1',
      ONILE_DATA_DIR: dir,
      RESEND_API_KEY: '',
      PAYSTACK_SECRET_KEY: secret,
      PAYSTACK_API_BASE: 'http://127.0.0.1:' + stubPort
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = 'http://127.0.0.1:' + port;
  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(base + '/api/health')).ok) { up = true; break; } } catch (e) {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(up, true);
    const opened = await fetch(base + '/api/admin/unlock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'desk-test-key' })
    });
    const cookie = (opened.headers.get('set-cookie') || '').split(';')[0];
    const queue = await fetch(base + '/api/admin/queue', { headers: { Cookie: cookie } });
    const body = await queue.json();
    const shown = body.payouts.find((p) => p.id === claimed.id);
    assert.equal(shown.status, 'claimed');
    assert.equal(shown.bank.bankName, 'GTBank');
    assert.equal(shown.bank.accountName, 'KEMI ADE');
    assert.equal(shown.bank.accountNumber, '0801111222');
    assert.equal(shown.amountKobo, 360000);
    const fromPaystack = body.payouts.find((p) => p.id === fetched.id);
    assert.equal(fromPaystack.bank.accountNumber, '0123456789');
    assert.equal(fromPaystack.bank.accountName, 'TUNDE BELLO');
    const cached = fs.readFileSync(path.join(dir, 'payout-details.json'), 'utf8');
    assert.equal(cached.includes('0123456789'), true);
    assert.equal(fs.readFileSync(payoutFile, 'utf8').includes('0123456789'), false);
    const auth = createAuth({ secret: SECRET });
    const session = auth.verifyCode('kemi@example.com', auth.requestCode('kemi@example.com').code);
    const mine = await fetch(base + '/api/challenges/mine', { headers: { Authorization: 'Bearer ' + session.token } });
    const mineBody = await mine.json();
    assert.equal(JSON.stringify(mineBody).includes('0801111222'), false);
    assert.equal(JSON.stringify(mineBody).includes('0123456789'), false);
    assert.equal(log.includes('0801111222'), false);
    assert.equal(log.includes('0123456789'), false);
    assert.equal(log.includes(secret), false);
  } finally {
    child.kill('SIGTERM');
    stub.close();
  }
});
