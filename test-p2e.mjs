// KOLOPOLY Play to Earn, end to end against a stub Paystack and a stub
// Supabase. Nothing here talks to the real Paystack and no real money
// can move: the server runs with a fixture secret and PAYSTACK_API_BASE
// pointed at the stub below.
// Covers: initialize (kobo, NGN, callback, metadata), webhook signature
// (good, forged, unsigned), duplicate webhooks, failed and abandoned
// payments, late success, verify timeout plus retry, wrong amount,
// payment for a seat that is gone, early end refused, prize split in
// kobo, winner bank, desk transfer (idempotent, double tap, failure,
// resend, OTP, lost answer plus sweep), transfer webhooks, refunds, the
// AFK review gate, the ops money view, restart persistence and the
// durable copy for a host with no disk.
// Run: node test-p2e.mjs
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { createPayouts, isHouseHoldError, HOUSE_HOLD_MESSAGE } = require('./payouts.js');
const { createPrizeLedger } = require('./prize-ledger.js');
const { createPaymentStore } = require('./paystack.js');

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms) {
  const end = Date.now() + (ms || 8000);
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(80); }
  throw new Error('timeout: ' + label);
}

// ---------------------------------------------------------------------------
// U: the payout queue in process, with a scripted Paystack.
// ---------------------------------------------------------------------------
console.log('U1: payout queue rules');
{
  const calls = [];
  let transferAnswer = { ok: true, status: 'success' };
  const seenRefs = new Set();
  const ps = {
    enabled: true,
    async listBanks() { return { ok: true, banks: [{ code: '058', name: 'GTBank' }] }; },
    async resolveAccount(n) { return n === '0123456789' ? { ok: true, accountName: 'ADA OBI' } : { ok: false, message: 'no match' }; },
    async createRecipient() { return { ok: true, recipientCode: 'RCP_unit' }; },
    async transfer(info) {
      calls.push(info);
      if (seenRefs.has(info.reference) && transferAnswer.status === 'success') return { ok: false, message: 'Duplicate transfer reference' };
      seenRefs.add(info.reference);
      return transferAnswer;
    },
    async verifyTransfer() { return { ok: true, status: 'success' }; },
    async refund() { return { ok: true, status: 'pending' }; }
  };
  const file = '/tmp/kolopoly-p2e-unit-payouts.json';
  try { fs.unlinkSync(file); } catch (e) { /* first run */ }
  const payments = createPaymentStore({ memory: true });
  const q = createPayouts({ file, paystack: ps, payments, mode: 'manual' });
  const row = q.fromLedger({ kind: 'prize', roomCode: 'ABCD', gameKey: 'ABCD-1', playerId: 1, name: 'Ada', accountId: 'acc1', email: 'a@x.ng', amount: 900, amountKobo: 89910, at: 1 });
  check('a prize with no bank on file waits for the bank', row.status === 'awaiting-bank', row.status);
  const again = q.fromLedger({ kind: 'prize', roomCode: 'ABCD', gameKey: 'ABCD-1', playerId: 1, name: 'Ada', accountId: 'acc1', amount: 900, amountKobo: 89910, at: 2 });
  check('the same game never queues a second prize', again === row && q.list().length === 1);
  check('the transfer reference is Paystack shaped and fixed by the row', /^kpw_[0-9a-f]{28}$/.test(row.transferRef));
  const badBank = await q.setBank({ accountId: 'acc1' }, { bankCode: '058', accountNumber: '12345' });
  check('a short account number is refused', !badBank.ok && badBank.error === 'account');
  const noMatch = await q.setBank({ accountId: 'acc1' }, { bankCode: '058', accountNumber: '9999999999' });
  check('an account the bank does not know is refused', !noMatch.ok && noMatch.error === 'resolve');
  const okBank = await q.setBank({ accountId: 'acc1' }, { bankCode: '058', accountNumber: '0123456789' });
  check('a real account saves, masked', okBank.ok && okBank.bank.last4 === '6789' && okBank.bank.accountName === 'ADA OBI' && !JSON.stringify(okBank).includes('0123456789'));
  check('saving the bank makes the prize ready', q.get(row.id).status === 'ready');
  const stored = fs.readFileSync(file, 'utf8');
  check('the full account number is never stored', !stored.includes('0123456789') && stored.includes('6789'));
  // Double tap: two sends at once, only one transfer.
  const [s1, s2] = await Promise.all([q.send(row.id, 'desk'), q.send(row.id, 'desk')]);
  check('two sends at once make exactly one transfer call', calls.length === 1, 'calls ' + calls.length);
  check('the first send pays, the second is refused by state', s1.ok && s1.status === 'paid' && !s2.ok && s2.error === 'state', JSON.stringify([s1, s2]));
  check('the transfer carries the exact kobo', calls[0].amountKobo === 89910 && calls[0].recipientCode === 'RCP_unit');
  const s3 = await q.send(row.id, 'desk');
  check('a paid prize cannot be sent again', !s3.ok && calls.length === 1);
  // Failure, then a resend with the same reference.
  const row2 = q.fromLedger({ kind: 'prize', roomCode: 'EFGH', gameKey: 'EFGH-1', playerId: 2, name: 'Ada', accountId: 'acc1', amount: 360, amountKobo: 36000, at: 3 });
  check('a second prize for a banked account is ready at once', row2.status === 'ready');
  transferAnswer = { ok: false, message: 'You cannot initiate third party payouts as a starter business' };
  const f1 = await q.send(row2.id, 'desk');
  check('a refused transfer reads failed with the Paystack reason', !f1.ok && q.get(row2.id).status === 'failed' && /starter business/.test(q.get(row2.id).lastError));
  const callsAfterHold = calls.length;
  const holdCollect = await q.collect('acc1', { roomCode: 'EFGH', gameKey: 'EFGH-1' });
  check('collect after a starter-business block does not call send again', calls.length === callsAfterHold, 'calls ' + calls.length);
  check('collect after a starter-business block is queued, not a failed collect', !!(holdCollect.ok && holdCollect.houseHold && holdCollect.message === HOUSE_HOLD_MESSAGE && q.get(row2.id).status === 'failed' && /starter business/.test(q.get(row2.id).lastError)), JSON.stringify(holdCollect));
  const minedHold = q.mine('acc1').payouts.find((r) => r.id === row2.id);
  check('the winner view flags houseHold and hides the Paystack error', !!(minedHold && minedHold.houseHold && minedHold.status === 'failed' && !JSON.stringify(minedHold).includes('starter business')), JSON.stringify(minedHold));
  transferAnswer = { ok: true, status: 'otp' };
  await q.send(row2.id, 'desk');
  check('a transfer waiting on OTP is marked otp with the fix', q.get(row2.id).status === 'otp' && /OTP/.test(q.get(row2.id).lastError));
  check('the resend reused the same transfer reference', calls[1].reference === calls[2].reference && calls[1].reference === row2.transferRef);
  // Lost answer: stays sending; the sweep asks Paystack and finishes it.
  const row3 = q.fromLedger({ kind: 'prize', roomCode: 'IJKL', gameKey: 'IJKL-1', playerId: 3, name: 'Ada', accountId: 'acc1', amount: 540, amountKobo: 54000, at: 4 });
  transferAnswer = { ok: false, unsure: true, message: 'no answer' };
  await q.send(row3.id, 'desk');
  check('a transfer with no answer stays in sending, never failed', q.get(row3.id).status === 'sending');
  check('a row in sending cannot be marked paid by hand', !q.markManual(row3.id).ok);
  await q.sweep(-1);
  check('the sweep settles it from Paystack by reference', q.get(row3.id).status === 'paid');
  // Transfer webhooks.
  const row4 = q.fromLedger({ kind: 'prize', roomCode: 'MNOP', gameKey: 'MNOP-1', playerId: 4, name: 'Ada', accountId: 'acc1', amount: 360, amountKobo: 36000, at: 5 });
  transferAnswer = { ok: true, status: 'pending' };
  await q.send(row4.id, 'desk');
  check('a pending transfer stays sending', q.get(row4.id).status === 'sending');
  q.onWebhook('transfer.success', { reference: row4.transferRef });
  check('transfer.success marks it paid', q.get(row4.id).status === 'paid');
  check('a duplicate transfer webhook changes nothing', q.onWebhook('transfer.success', { reference: row4.transferRef }) === false);
  // AFK review and accountless prizes.
  const afk = q.fromLedger({ kind: 'prize', roomCode: 'QRST', gameKey: 'QRST-1', playerId: 5, name: 'Bola', accountId: 'acc2', amount: 360, amountKobo: 36000, review: 'afk', at: 6 });
  check('an AFK-held winner waits for desk review', afk.status === 'review' && /AFK/.test(afk.note));
  check('a row in review cannot be sent', !(await q.send(afk.id, 'desk')).ok);
  check('approving it moves it on to the bank step', q.approve(afk.id).ok && q.get(afk.id).status === 'awaiting-bank');
  const testRow = q.fromLedger({ kind: 'prize', roomCode: 'TEST', gameKey: 'TEST-1', playerId: 6, name: 'T', accountId: 'acc3', amount: 360, testMode: true, at: 7 });
  check('test mode prizes never send', testRow.status === 'test' && !(await q.send(testRow.id, 'desk')).ok);
  // Refunds through the original transaction.
  payments.create({ reference: 'kpref1', roomCode: 'UVWX', playerId: 7, accountId: 'acc4', email: 'c@x.ng', amountKobo: 20000 });
  payments.update('kpref1', { status: 'paid', seat: 'seated' });
  const ref = q.fromLedger({ kind: 'refund-due', roomCode: 'UVWX', playerId: 7, name: 'C', accountId: 'acc4', amount: 200, reference: 'kpref1', at: 8 });
  check('a refund for a real payment is ready and keyed by the reference', ref.status === 'ready' && ref.id === 'refund:kpref1');
  check('the payment record now reads refund-due', payments.get('kpref1').seat === 'refund-due');
  check('the same refund never queues twice', q.fromLedger({ kind: 'refund-due', roomCode: 'UVWX', playerId: 7, amount: 200, reference: 'kpref1', at: 9 }) === ref);
  await q.send(ref.id, 'desk');
  check('a refund Paystack accepted reads refund-pending', q.get(ref.id).status === 'refund-pending');
  q.onWebhook('refund.processed', { transaction_reference: 'kpref1' });
  check('refund.processed marks it refunded and the payment too', q.get(ref.id).status === 'refunded' && payments.get('kpref1').seat === 'refunded');
  // Restart: a fresh queue on the same file sees everything.
  const q2 = createPayouts({ file, paystack: ps, payments, mode: 'manual' });
  check('the queue survives a restart from its file', q2.list().length === q.list().length && q2.get(row.id).status === 'paid' && q2.get(afk.id).status === 'awaiting-bank');
  check('the saved bank survives the restart', q2.mine('acc1').bank && q2.mine('acc1').bank.last4 === '6789');
  const beforeCalls = calls.length;
  transferAnswer = { ok: true, status: 'success' };
  const cq = createPayouts({ memory: true, paystack: ps, payments, mode: 'manual' });
  const queued = cq.fromLedger({ kind: 'prize', roomCode: 'RFFU', gameKey: 'RFFU-1', playerId: 9, name: 'Kiji', accountId: 'winner1', amount: 360, amountKobo: 36000, at: 40 });
  const needBank = await cq.collect('winner1', { roomCode: 'RFFU' });
  check('collect with no bank asks for the bank and sends nothing', !needBank.ok && needBank.error === 'bank' && calls.length === beforeCalls, JSON.stringify(needBank));
  await cq.setBank({ accountId: 'winner1' }, { bankCode: '058', accountNumber: '0123456789' });
  const [c1, c2] = await Promise.all([cq.collect('winner1', { roomCode: 'RFFU', gameKey: 'RFFU-1' }), cq.collect('winner1', { roomCode: 'RFFU', gameKey: 'RFFU-1' })]);
  check('one collect pays and the twin tap does not start a second transfer', calls.length === beforeCalls + 1 && [c1, c2].filter((r) => r && r.ok).length === 2 && cq.get(queued.id).status === 'paid', JSON.stringify([c1, c2, calls.length]));
  const againCollect = await cq.collect('winner1', { roomCode: 'RFFU' });
  check('a paid prize collect says already paid', againCollect.ok && againCollect.already && againCollect.status === 'paid' && calls.length === beforeCalls + 1);
  transferAnswer = { ok: false, message: 'You cannot initiate third party payouts as a starter business' };
  const holdRow = cq.fromLedger({ kind: 'prize', roomCode: 'HOLD', gameKey: 'HOLD-1', playerId: 10, name: 'Kiji', accountId: 'winner1', amount: 360, amountKobo: 36000, at: 41 });
  const callsBeforeHold = calls.length;
  const firstHold = await cq.collect('winner1', { roomCode: 'HOLD', gameKey: 'HOLD-1' });
  check('the first collect against a starter-business block tries once, then queues', firstHold.ok && firstHold.houseHold && firstHold.message === HOUSE_HOLD_MESSAGE && cq.get(holdRow.id).status === 'failed' && calls.length === callsBeforeHold + 1, JSON.stringify(firstHold));
  const secondHold = await cq.collect('winner1', { roomCode: 'HOLD', gameKey: 'HOLD-1' });
  check('a second collect against that block does not call send', secondHold.ok && secondHold.already && secondHold.houseHold && calls.length === callsBeforeHold + 1, JSON.stringify(secondHold));
  check('insufficient balance is the same house hold', isHouseHoldError('Insufficient balance') && isHouseHoldError('Transfers are not enabled on this business') && !isHouseHoldError('Transfer failed.'));
  transferAnswer = { ok: true, status: 'success' };
  const stuck = cq.openRows();
  check('open rows name room, amount and status only', Array.isArray(stuck) && stuck.every((r) => r.roomCode && r.amount != null && r.status && r.name == null));
  const v = q2.view();
  check('the desk view totals real money only, in kobo', v.totals.prizePaidKobo === 89910 + 54000 + 36000 && v.totals.refundDoneKobo === 20000, JSON.stringify(v.totals));
  // Ledger hook wiring and kobo fields.
  const led = createPrizeLedger({ memory: true });
  const seen = [];
  led.setOnAdd((e) => seen.push(e));
  led.add({ kind: 'prize', roomCode: 'ZZZZ', amount: 899, amountKobo: 89910, gameKey: 'ZZZZ-1', name: 'A' });
  check('the ledger keeps exact kobo beside the naira and hands the entry on', seen.length === 1 && seen[0].amountKobo === 89910 && seen[0].gameKey === 'ZZZZ-1');
}

// ---------------------------------------------------------------------------
// S: the server against a stub Paystack and a stub Supabase.
// ---------------------------------------------------------------------------
const PORT = 4251;
const BASE = 'ws://127.0.0.1:' + PORT;
const HTTP = 'http://127.0.0.1:' + PORT;
const STUB_PORT = 4252;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const SECRET = 'sk_test_p2e_suite_fixture';
const TOKEN = 'p2e-desk-token';
const FILES = {
  retention: '/tmp/kolopoly-p2e-retention.json',
  competition: '/tmp/kolopoly-p2e-competition.json',
  prizes: '/tmp/kolopoly-p2e-prizes.json',
  payments: '/tmp/kolopoly-p2e-payments.json',
  payouts: '/tmp/kolopoly-p2e-payouts.json'
};
function wipeFiles() { for (const f of Object.values(FILES)) { try { fs.unlinkSync(f); } catch (e) { /* none */ } } }
wipeFiles();

// The stub Paystack. txn holds what each reference "did" at Paystack.
const txn = new Map(); // reference -> { status, amount, currency }
const initBodies = [];
const verifyCalls = new Map();
const slowVerify = new Set();
const transfers = [];
const refunds = [];
let transferMode = 'success';
const kv = new Map(); // stub Supabase kolopoly_kv
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url || '';
    const auth = String(req.headers.authorization || '');
    if (url.startsWith('/rest/v1/')) {
      if (url.startsWith('/rest/v1/kolopoly_kv')) {
        if (req.method === 'GET') {
          const m = /key=eq\.([^&]+)/.exec(url);
          const k = m ? decodeURIComponent(m[1]) : '';
          res.end(JSON.stringify(kv.has(k) ? [{ doc: kv.get(k) }] : []));
          return;
        }
        const b = JSON.parse(body || '{}');
        kv.set(b.key, b.doc);
        res.statusCode = 201; res.end('');
        return;
      }
      res.statusCode = 201; res.end('[]');
      return;
    }
    if (auth !== 'Bearer ' + SECRET) { res.statusCode = 401; res.end(JSON.stringify({ status: false, message: 'Invalid key' })); return; }
    if (req.method === 'POST' && url === '/transaction/initialize') {
      const b = JSON.parse(body || '{}');
      initBodies.push(b);
      txn.set(b.reference, { status: 'abandoned', amount: b.amount, currency: b.currency });
      res.end(JSON.stringify({ status: true, data: { authorization_url: STUB + '/pay/' + b.reference, access_code: 'stub', reference: b.reference } }));
      return;
    }
    let m = /^\/transaction\/verify\/(.+)$/.exec(url);
    if (req.method === 'GET' && m) {
      const ref = decodeURIComponent(m[1]);
      const n = (verifyCalls.get(ref) || 0) + 1;
      verifyCalls.set(ref, n);
      const t = txn.get(ref);
      const answer = () => res.end(JSON.stringify(t ? { status: true, data: { status: t.status, amount: t.amount, currency: t.currency || 'NGN', reference: ref, channel: t.channel || '' } } : { status: false, message: 'Transaction reference not found' }));
      if (slowVerify.has(ref) && n === 1) { setTimeout(answer, 1500); return; }
      answer();
      return;
    }
    if (req.method === 'GET' && url.startsWith('/bank?')) {
      res.end(JSON.stringify({ status: true, data: [{ name: 'Guaranty Trust Bank', code: '058', active: true }, { name: 'Opay', code: '999992', active: true }] }));
      return;
    }
    if (req.method === 'GET' && url.startsWith('/bank/resolve')) {
      const u = new URL(url, STUB);
      if (u.searchParams.get('account_number') === '0011223344') { res.end(JSON.stringify({ status: true, data: { account_number: '0011223344', account_name: 'ADA OKAFOR' } })); return; }
      res.statusCode = 422; res.end(JSON.stringify({ status: false, message: 'Could not resolve account name' }));
      return;
    }
    if (req.method === 'POST' && url === '/transferrecipient') {
      res.end(JSON.stringify({ status: true, data: { recipient_code: 'RCP_stub_' + crypto.randomBytes(3).toString('hex') } }));
      return;
    }
    if (req.method === 'POST' && url === '/transfer') {
      const b = JSON.parse(body || '{}');
      if (transfers.some((t) => t.reference === b.reference && t.status === 'success')) { res.statusCode = 400; res.end(JSON.stringify({ status: false, message: 'Transfer reference already exists' })); return; }
      if (transferMode === 'refuse') { transfers.push(Object.assign({ status: 'refused' }, b)); res.statusCode = 400; res.end(JSON.stringify({ status: false, message: 'You cannot initiate third party payouts as a starter business' })); return; }
      transfers.push(Object.assign({ status: 'success' }, b));
      res.end(JSON.stringify({ status: true, data: { status: 'success', transfer_code: 'TRF_stub', reference: b.reference } }));
      return;
    }
    m = /^\/transfer\/verify\/(.+)$/.exec(url);
    if (req.method === 'GET' && m) {
      const t = transfers.find((x) => x.reference === decodeURIComponent(m[1]));
      res.end(JSON.stringify(t ? { status: true, data: { status: t.status } } : { status: false, message: 'Transfer not found' }));
      return;
    }
    if (req.method === 'POST' && url === '/refund') {
      const b = JSON.parse(body || '{}');
      refunds.push(b);
      res.end(JSON.stringify({ status: true, data: { status: 'pending', transaction: { reference: b.transaction } } }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

let server = null;
let serverLog = '';
async function startServer(extraEnv) {
  serverLog = '';
  server = spawn(process.execPath, ['server.js'], {
    cwd: new URL('.', import.meta.url).pathname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), KP_TEST: '1', KP_ADMIN_TOKEN: TOKEN, KP_PAYMENTS: 'paystack',
      PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_BASE: STUB, PAYSTACK_TIMEOUT_MS: '700',
      KP_AUTH_SECRET: 'p2e-suite-auth-secret', KP_SWEEP_INTERVAL_MS: '400', KP_SWEEP_AGE_MS: '600000',
      KP_PUBLIC_URL: 'https://kolopoly.fun',
      SUPABASE_URL: STUB, SUPABASE_SERVICE_ROLE_KEY: 'stub-service-key',
      KP_RETENTION_FILE: FILES.retention, KP_COMPETITION_FILE: FILES.competition,
      KP_PRIZES_FILE: FILES.prizes, KP_PAYMENTS_FILE: FILES.payments, KP_PAYOUTS_FILE: FILES.payouts
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await until(() => serverLog.includes('listening'), 'server listening', 10000);
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  const done = new Promise((r) => s.on('exit', r));
  s.kill('SIGTERM');
  await done;
}

class Client {
  constructor(name) { this.name = name; this.state = null; this.playerId = null; this.errors = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'joined') { this.playerId = msg.playerId; this.code = msg.code; }
        if (msg.type === 'state') this.state = msg.room;
        if (msg.type === 'error') this.errors.push(msg.message);
      });
    });
  }
  send(type, obj) { this.ws.send(JSON.stringify(Object.assign({ type }, obj || {}))); }
  me() { return this.state && this.state.players.find((p) => p.id === this.playerId); }
  async waitFor(pred, label, ms) {
    const end = Date.now() + (ms || 9000);
    while (Date.now() < end) { if (this.state && pred(this.state)) return this.state; await sleep(60); }
    throw new Error('timeout waiting for: ' + label + ' (client ' + this.name + ')');
  }
  async waitError(substr, label, ms) {
    const end = Date.now() + (ms || 6000);
    while (Date.now() < end) { if (this.errors.some((e) => e.includes(substr))) return true; await sleep(60); }
    throw new Error('timeout waiting for error "' + substr + '": ' + label + ' (got: ' + this.errors.join(' | ') + ')');
  }
  close() { try { this.ws.close(); } catch (e) { /* gone */ } }
}
async function api(method, path, body, token, extraHeaders) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(HTTP + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json };
}
async function signIn(email) {
  const r = await api('POST', '/api/auth/request', { email });
  const v = await api('POST', '/api/auth/verify', { email, code: r.body.devCode });
  return v.body;
}
function sign(payload, secret) { return crypto.createHmac('sha512', secret || SECRET).update(payload).digest('hex'); }
async function webhook(obj, opts) {
  const payload = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json' };
  if (!opts || !opts.noSig) headers['x-paystack-signature'] = sign(payload, opts && opts.secret);
  const res = await fetch(HTTP + '/api/paystack/webhook', { method: 'POST', headers, body: payload });
  return res.status;
}
function chargeSuccess(reference, amount, currency) {
  return { event: 'charge.success', data: { reference, status: 'success', amount: amount == null ? 20000 : amount, currency: currency || 'NGN' } };
}
async function money() { return (await api('GET', '/ops/money', null, TOKEN)).body; }
async function desk(action, id, note) { return api('POST', '/ops/money/action', { action, id, note }, TOKEN); }
function payRec(ref) { return JSON.parse(fs.readFileSync(FILES.payments, 'utf8')).find((r) => r.reference === ref); }
async function paidTable(host, guest, hostAcct, guestAcct) {
  host.send('create_room', { name: host.name, token: 'danfo', mode: 'online', cityId: 'lagos', authToken: hostAcct.token, settings: { gameMode: 'classic', timed: false } });
  await host.waitFor((s) => s.status === 'lobby', 'paid lobby');
  guest.send('join_room', { code: host.state.code, name: guest.name, token: 'keke', authToken: guestAcct.token });
  await host.waitFor((s) => s.players.length === 2, 'guest seated');
  return host.state.code;
}

try {
  await startServer();
  const ada = await signIn('ada@example.com');
  const bola = await signIn('bola@example.com');
  const chidi = await signIn('chidi@example.com');

  console.log('S1: happy path, Paystack initialize to winner paid');
  let firstCode; let winnerAcct; let prizeId;
  {
    const host = new Client('Ada'); await host.connect();
    const guest = new Client('Bola'); await guest.connect();
    firstCode = await paidTable(host, guest, ada, bola);
    const initA = await api('POST', '/api/payments/initialize', { roomCode: firstCode }, ada.token);
    check('initialize answers with a Paystack page and a kp reference', initA.status === 200 && /^kp[0-9a-z]+$/.test(initA.body.reference) && initA.body.authorizationUrl.startsWith(STUB), JSON.stringify(initA.body));
    const sent = initBodies.find((b) => b.reference === initA.body.reference);
    check('Paystack is asked for 20000 kobo in NGN', sent.amount === 20000 && sent.currency === 'NGN', JSON.stringify(sent));
    check('the callback brings the player back to this table', sent.callback_url === 'https://kolopoly.fun/?paid=' + firstCode, sent.callback_url);
    check('the metadata names the room, seat, account and city', sent.metadata.roomCode === firstCode && sent.metadata.accountId === ada.accountId && sent.metadata.cityId === 'lagos' && sent.metadata.playerId === host.playerId);
    check('the email on the payment is the signed-in account', sent.email === 'ada@example.com');
    const reuse = await api('POST', '/api/payments/initialize', { roomCode: firstCode }, ada.token);
    check('a second tap reuses the open payment instead of opening another', reuse.body.reference === initA.body.reference);
    const forged = await api('POST', '/api/payments/initialize', { roomCode: firstCode, amount: 1 }, chidi.token);
    check('a stranger with no seat cannot open a payment for the table', forged.status === 403);
    const status0 = await api('GET', '/api/payments/status?reference=' + initA.body.reference);
    check('an opened but unpaid payment (Paystack says abandoned) stays pending', status0.body.status === 'pending', JSON.stringify(status0.body));
    check('abandoned is named so the phone can stop spinning', status0.body.gateway === 'abandoned' && status0.body.status === 'pending', JSON.stringify(status0.body));
    txn.set(initA.body.reference, { status: 'pending', amount: 20000, currency: 'NGN', channel: 'bank_transfer' });
    const statusWait = await api('GET', '/api/payments/status?reference=' + initA.body.reference);
    check('a transfer still in flight stays pending and names the channel', statusWait.body.status === 'pending' && statusWait.body.gateway === 'pending' && statusWait.body.channel === 'bank_transfer', JSON.stringify(statusWait.body));
    txn.set(initA.body.reference, { status: 'abandoned', amount: 20000, currency: 'NGN' });
    // Forged and unsigned webhooks.
    txn.get(initA.body.reference).status = 'success';
    check('a forged signature is refused', (await webhook(chargeSuccess(initA.body.reference), { secret: 'sk_test_wrong' })) === 401);
    check('an unsigned webhook is refused', (await webhook(chargeSuccess(initA.body.reference), { noSig: true })) === 401);
    await sleep(150);
    check('the refused webhooks seated nobody', host.me().paidSeat === false);
    check('a signed charge.success is accepted', (await webhook(chargeSuccess(initA.body.reference))) === 200);
    await host.waitFor(() => host.me().paidSeat === true, 'host seat paid by webhook');
    check('the webhook seats the payer', true);
    await webhook(chargeSuccess(initA.body.reference));
    await webhook(chargeSuccess(initA.body.reference));
    await sleep(150);
    const recA = payRec(initA.body.reference);
    check('three deliveries settle once', recA.events.filter((e) => e.kind === 'settled').length === 1 && recA.seat === 'seated', JSON.stringify(recA.events));
    // Guest pays; Paystack verify times out once, then answers.
    const initB = await api('POST', '/api/payments/initialize', { roomCode: firstCode }, bola.token);
    txn.get(initB.body.reference).status = 'success';
    slowVerify.add(initB.body.reference);
    const st = await api('GET', '/api/payments/status?reference=' + initB.body.reference);
    check('a verify that times out is retried once and still settles', st.body.status === 'paid' && verifyCalls.get(initB.body.reference) === 2, JSON.stringify(st.body) + ' calls ' + verifyCalls.get(initB.body.reference));
    check('the timeout is logged with its cause', /Paystack call failed \(GET \/transaction\/verify/.test(serverLog));
    await host.waitFor((s) => s.paid.allPaid, 'all paid');
    host.send('end_room', {});
    await guest.waitFor((s) => s.status === 'lobby', 'still lobby');
    host.send('start_game', {});
    await host.waitFor((s) => s.status === 'playing', 'game on');
    check('a paid table always runs on the match clock', !!host.state.gameEndsAt);
    check('the payments now read in-game', payRec(initA.body.reference).seat === 'in-game' && payRec(initB.body.reference).seat === 'in-game');
    const lateInit = await api('POST', '/api/payments/initialize', { roomCode: firstCode }, ada.token);
    check('no payment opens once the game has started', lateInit.status === 400);
    host.send('end_room', {});
    await host.waitError('no fit end early', 'early end refused');
    check('the host cannot end a paid game early', host.state.status === 'playing');
    host.send('test_clock', { secondsLeft: 0 });
    await host.waitFor((s) => s.status === 'ended' && !!s.prize, 'clock ended the game');
    const pz = host.state.prize;
    check('prize split in kobo: pot 40000, winner 36000, house 4000', pz.potKobo === 40000 && pz.winnerKobo === 36000 && pz.houseKobo === 4000 && pz.winnerKobo + pz.houseKobo === pz.potKobo, JSON.stringify(pz));
    winnerAcct = pz.winnerId === host.playerId ? ada : bola;
    await sleep(150);
    check('both entries now read consumed', payRec(initA.body.reference).seat === 'consumed' && payRec(initB.body.reference).seat === 'consumed');
    const m1 = await money();
    const prow = m1.payouts.find((p) => p.kind === 'prize' && p.roomCode === firstCode);
    prizeId = prow && prow.id;
    check('the desk sees the prize waiting for the winner bank', !!prow && prow.status === 'awaiting-bank' && prow.amountKobo === 36000 && prow.accountId === winnerAcct.accountId, JSON.stringify(prow));
    check('the desk totals: collected 40000, house 4000, one paid game', m1.totals.collectedKobo === 40000 && m1.totals.houseKobo === 4000 && m1.totals.paidGames === 1 && m1.totals.prizeOwedKobo === 36000, JSON.stringify(m1.totals));
    check('the desk money view is locked without the key', (await api('GET', '/ops/money')).status === 401);
    check('a desk action from another origin is refused', (await api('POST', '/ops/money/action', { action: 'send', id: prizeId }, TOKEN, { Origin: 'https://evil.example' })).status === 403);
    const mine = await api('GET', '/api/payouts/mine', null, winnerAcct.token);
    check('the winner sees the prize under their account', mine.status === 200 && mine.body.payouts.some((p) => p.id === prizeId && p.status === 'awaiting-bank' && p.amount === 360));
    const loserAcct = winnerAcct === ada ? bola : ada;
    const theirs = await api('GET', '/api/payouts/mine', null, loserAcct.token);
    check('the other player does not see it', !theirs.body.payouts.some((p) => p.id === prizeId));
    check('the payout routes need sign-in', (await api('GET', '/api/payouts/mine')).status === 401);
    const banks = await api('GET', '/api/payouts/banks', null, winnerAcct.token);
    check('the bank list loads', banks.status === 200 && banks.body.banks.some((b) => b.code === '058'));
    const bad = await api('POST', '/api/payouts/bank', { bankCode: '058', accountNumber: '9999999999' }, winnerAcct.token);
    check('an account the bank cannot resolve is refused', bad.status === 400 && bad.body.error === 'resolve');
    const good = await api('POST', '/api/payouts/bank', { bankCode: '058', accountNumber: '0011223344' }, winnerAcct.token);
    check('the resolved bank saves with the account name, masked', good.status === 200 && good.body.bank.accountName === 'ADA OKAFOR' && good.body.bank.last4 === '3344' && !JSON.stringify(good.body).includes('0011223344'));
    const m2 = await money();
    check('the prize is now ready for the desk', m2.payouts.find((p) => p.id === prizeId).status === 'ready');
    const sendRes = await desk('send', prizeId);
    check('the desk send makes one transfer of 36000 kobo', sendRes.status === 200 && sendRes.body.status === 'paid' && transfers.length === 1 && transfers[0].amount === 36000 && transfers[0].currency === 'NGN', JSON.stringify(sendRes.body));
    const again = await desk('send', prizeId);
    check('sending a paid prize again is refused and moves nothing', again.status === 400 && transfers.length === 1);
    check('a forged transfer.failed webhook is refused', (await webhook({ event: 'transfer.failed', data: { reference: transfers[0].reference } }, { secret: 'sk_test_wrong' })) === 401);
    await webhook({ event: 'transfer.success', data: { reference: transfers[0].reference } });
    const m3 = await money();
    check('the paid prize stays paid after its webhook', m3.payouts.find((p) => p.id === prizeId).status === 'paid' && m3.totals.prizePaidKobo === 36000);
    const mine2 = await api('GET', '/api/payouts/mine', null, winnerAcct.token);
    check('the winner sees it paid with the bank masked', mine2.body.payouts.find((p) => p.id === prizeId).status === 'paid' && mine2.body.bank.last4 === '3344');
    host.close(); guest.close();
  }

  console.log('S2: failed, late, wrong amount and seatless payments');
  let leftRef;
  {
    const host = new Client('Chidi'); await host.connect();
    const guest = new Client('Ada'); await guest.connect();
    const code = await paidTable(host, guest, chidi, ada);
    const i1 = await api('POST', '/api/payments/initialize', { roomCode: code }, chidi.token);
    txn.get(i1.body.reference).status = 'failed';
    const s1 = await api('GET', '/api/payments/status?reference=' + i1.body.reference);
    check('a failed charge reads failed', s1.body.status === 'failed');
    check('the failed payment seats nobody', host.me().paidSeat === false);
    // A success that lands after the failure still settles (late wins).
    txn.get(i1.body.reference).status = 'success';
    await webhook(chargeSuccess(i1.body.reference));
    await host.waitFor(() => host.me().paidSeat === true, 'late success seats');
    check('a late success after a failed read still seats the payer', payRec(i1.body.reference).events.some((e) => e.kind === 'settled' && e.late));
    // Wrong amount.
    const i2 = await api('POST', '/api/payments/initialize', { roomCode: code }, ada.token);
    txn.set(i2.body.reference, { status: 'success', amount: 100, currency: 'NGN' });
    await webhook(chargeSuccess(i2.body.reference, 100));
    await sleep(200);
    check('a success for the wrong amount seats nobody', guest.me().paidSeat === false);
    const m = await money();
    const mm = m.payouts.find((p) => p.id === 'refund:' + i2.body.reference);
    check('the wrong amount is queued straight back as a refund', !!mm && mm.status === 'ready' && mm.amountKobo === 100 && payRec(i2.body.reference).seat === 'refund-due', JSON.stringify(mm));
    // A seat that leaves after paying gets a refund through Paystack.
    const i3 = await api('POST', '/api/payments/initialize', { roomCode: code }, ada.token);
    check('after a wrong amount the seat can open a fresh payment', i3.status === 200 && i3.body.reference !== i2.body.reference);
    txn.get(i3.body.reference).status = 'success';
    await webhook(chargeSuccess(i3.body.reference));
    await guest.waitFor(() => guest.me().paidSeat === true, 'guest paid');
    leftRef = i3.body.reference;
    guest.send('leave', {});
    await sleep(300);
    const m2 = await money();
    const lr = m2.payouts.find((p) => p.id === 'refund:' + leftRef);
    check('leaving a paid lobby queues the refund against its payment', !!lr && lr.status === 'ready' && lr.amountKobo === 20000 && payRec(leftRef).seat === 'refund-due', JSON.stringify(lr));
    const rs = await desk('send', lr.id);
    check('the desk refund goes back through the original transaction', rs.status === 200 && refunds.some((r) => r.transaction === leftRef), JSON.stringify(rs.body));
    await webhook({ event: 'refund.processed', data: { transaction_reference: leftRef } });
    const m3 = await money();
    check('refund.processed closes it as refunded', m3.payouts.find((p) => p.id === lr.id).status === 'refunded' && payRec(leftRef).seat === 'refunded');
    // A confirmation that arrives for a seat already gone.
    const ghost = new Client('Bola'); await ghost.connect();
    ghost.send('join_room', { code, name: 'Bola', token: 'okada', authToken: bola.token });
    await host.waitFor((s) => s.players.length === 2, 'bola seated');
    const i4 = await api('POST', '/api/payments/initialize', { roomCode: code }, bola.token);
    ghost.send('leave', {});
    await sleep(300);
    txn.get(i4.body.reference).status = 'success';
    await webhook(chargeSuccess(i4.body.reference));
    await sleep(200);
    const m4 = await money();
    const gr = m4.payouts.find((p) => p.id === 'refund:' + i4.body.reference);
    check('money that lands after the seat left is owed back, never kept', !!gr && gr.status === 'ready' && gr.why === 'no-seat', JSON.stringify(gr));
    host.close(); ghost.close();
  }

  console.log('S3: restart keeps every record, lobby money comes back');
  let lobbyRef;
  {
    const host = new Client('Ada'); await host.connect();
    const guest = new Client('Chidi'); await guest.connect();
    const code = await paidTable(host, guest, ada, chidi);
    const i = await api('POST', '/api/payments/initialize', { roomCode: code }, ada.token);
    txn.get(i.body.reference).status = 'success';
    await webhook(chargeSuccess(i.body.reference));
    await host.waitFor(() => host.me().paidSeat === true, 'seated before restart');
    lobbyRef = i.body.reference;
    host.close(); guest.close();
    const before = await money();
    await stopServer();
    await startServer();
    const after = await money();
    check('the prize history survives the restart', after.payouts.find((p) => p.id === prizeId).status === 'paid');
    check('consumed entries are not refunded by the restart', !after.payouts.some((p) => p.paymentRef && p.roomCode === firstCode));
    const lb = after.payouts.find((p) => p.id === 'refund:' + lobbyRef);
    check('a paid lobby seat lost to the restart is queued for refund once', !!lb && lb.status === 'ready' && lb.why === 'restart' && after.payouts.filter((p) => p.id === 'refund:' + lobbyRef).length === 1, JSON.stringify(lb));
    const added = after.payouts.filter((p) => !before.payouts.some((b) => b.id === p.id));
    // Two lobbies held paid seats at the restart: this one and the S2
    // table, where Chidi's late-success seat was still waiting.
    check('the restart kept every earlier row and only added lobby refunds', before.payouts.every((b) => after.payouts.some((p) => p.id === b.id)) && added.length === 2 && added.every((p) => p.kind === 'refund' && p.why === 'restart'), JSON.stringify(added.map((p) => [p.id, p.why])));
    await stopServer();
    await startServer();
    const third = await money();
    check('a second restart queues nothing new', third.payouts.length === after.payouts.length);
    const bank = await api('GET', '/api/payouts/mine', null, winnerAcct.token);
    check('the winner bank survives restarts', bank.body.bank && bank.body.bank.last4 === '3344');
  }

  console.log('S4: a host with no disk restores from the durable copy');
  {
    await sleep(800); // let the debounced mirror writes land
    const before = await money();
    await stopServer();
    wipeFiles();
    await startServer();
    check('the boot says it restored from the durable copy', /Restored from the durable copy: payments, prize ledger, payouts/.test(serverLog), serverLog.split('\n').filter((l) => /durable|Restored/.test(l)).join(' | '));
    const after = await money();
    check('every payout row came back', after.payouts.length === before.payouts.length && after.payouts.find((p) => p.id === prizeId).status === 'paid');
    check('the money totals came back', after.totals.collectedKobo === before.totals.collectedKobo && after.totals.houseKobo === 4000, JSON.stringify(after.totals));
    check('nothing was refunded twice on the restore', after.payouts.filter((p) => p.id === 'refund:' + lobbyRef).length === 1);
  }

  console.log('S5: a refused transfer can be sent again safely, or paid by hand');
  {
    const host = new Client('Ada'); await host.connect();
    const guest = new Client('Bola'); await guest.connect();
    const code = await paidTable(host, guest, ada, bola);
    for (const [acct] of [[ada], [bola]]) {
      const i = await api('POST', '/api/payments/initialize', { roomCode: code }, acct.token);
      txn.get(i.body.reference).status = 'success';
      await webhook(chargeSuccess(i.body.reference));
    }
    await host.waitFor((s) => s.paid.allPaid, 'all paid again');
    host.send('start_game', {});
    await host.waitFor((s) => s.status === 'playing', 'started');
    host.send('test_clock', { secondsLeft: 0 });
    await host.waitFor((s) => s.status === 'ended' && !!s.prize, 'ended');
    const w = host.state.prize.winnerId === host.playerId ? ada : bola;
    if (w !== winnerAcct) await api('POST', '/api/payouts/bank', { bankCode: '058', accountNumber: '0011223344' }, w.token);
    const m = await money();
    const row = m.payouts.find((p) => p.kind === 'prize' && p.roomCode === code);
    check('the second prize is ready (bank on file)', row.status === 'ready', row.status);
    transferMode = 'refuse';
    const r1 = await desk('send', row.id);
    check('a refused transfer reads failed with the Paystack reason', r1.status === 400 && /starter business/.test(r1.body.message || ''), JSON.stringify(r1.body));
    transferMode = 'success';
    const r2 = await desk('send', row.id);
    const sentRefs = transfers.filter((t) => t.amount === 36000).map((t) => t.reference);
    check('the resend pays with the same reference', r2.status === 200 && r2.body.status === 'paid' && sentRefs[sentRefs.length - 1] === sentRefs[sentRefs.length - 2]);
    const lb = m.payouts.find((p) => p.id === 'refund:' + lobbyRef);
    const hand = await desk('mark', lb.id, 'paid by bank app');
    check('the desk can settle a row by hand', hand.status === 200 && hand.body.status === 'refunded-manual');
    host.close(); guest.close();
  }

  console.log('S6: a paid game everybody walks away from still pays its winner');
  {
    const host = new Client('Ada'); await host.connect();
    const guest = new Client('Bola'); await guest.connect();
    const code = await paidTable(host, guest, ada, bola);
    for (const acct of [ada, bola]) {
      const i = await api('POST', '/api/payments/initialize', { roomCode: code }, acct.token);
      txn.get(i.body.reference).status = 'success';
      await webhook(chargeSuccess(i.body.reference));
    }
    await host.waitFor((s) => s.paid.allPaid, 'all paid S6');
    host.send('start_game', {});
    await host.waitFor((s) => s.status === 'playing', 'started S6');
    host.close(); guest.close();
    const row = await until(async () => (await money()).payouts.find((p) => p.kind === 'prize' && p.roomCode === code), 'abandoned prize', 9000);
    check('the walked-away game ends on the richest seat and owes the prize', !!row && row.amountKobo === 36000);
    const m = await money();
    check('no refund was written for that game', !m.payouts.some((p) => p.kind === 'refund' && p.roomCode === code));
  }
} catch (e) {
  failures += 1;
  console.log('  FAIL - ' + (e && e.stack ? e.stack : e));
} finally {
  await stopServer();
  stub.close();
}
console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
if (failures) { console.log(serverLog.slice(-3000)); process.exit(1); }
