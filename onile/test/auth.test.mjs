import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAuth, accountIdFor } = require('../../auth');
const { createEscrow } = require('../escrow');

const SECRET = 'shared-kolopoly-onile-secret';

test('a Kolopoly sign-in token is the same Onile account', () => {
  const kolopoly = createAuth({ secret: SECRET });
  const onile = createAuth({ secret: SECRET });
  const requested = kolopoly.requestCode('ada@example.com');
  assert.equal(requested.ok, true);
  const wrong = kolopoly.verifyCode('ada@example.com', '000000');
  assert.equal(wrong.ok, false);
  const session = kolopoly.verifyCode('ada@example.com', requested.code);
  assert.equal(session.ok, true);
  assert.equal(session.accountId, accountIdFor('ada@example.com'));
  const seen = onile.verifyToken(session.token);
  assert.equal(seen.accountId, session.accountId);
  assert.equal(seen.email, 'ada@example.com');

  const escrow = createEscrow({ memory: true, now: () => 1 });
  const saved = escrow.upsertPlayer({ accountId: session.accountId, email: session.email, name: 'Ada' });
  const renamed = escrow.upsertPlayer({ accountId: session.accountId, email: 'Ada@Example.com', name: 'Adaeze' });
  assert.equal(saved.player.id, session.accountId);
  assert.equal(renamed.player.id, session.accountId);
  assert.equal(renamed.player.name, 'Adaeze');
  assert.equal(escrow.player(session.accountId).email, 'ada@example.com');
  const junk = escrow.upsertPlayer({ accountId: 'not-an-account', email: 'ada@example.com', name: 'Ada' });
  assert.equal(junk.ok, false);
});

test('sign-up accepts only a display name, an email, and the Kolopoly code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onile-auth-'));
  const port = 4271;
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    KP_AUTH_SECRET: SECRET,
    KP_TEST: '1',
    KP_MAIL_TEST: '1',
    ONILE_DATA_DIR: dir,
    ONILE_PUBLIC_URL: 'http://127.0.0.1:' + port,
    RESEND_API_KEY: '',
    PAYSTACK_SECRET_KEY: '',
    KP_ADMIN_TOKEN: ''
  });
  const child = spawn(process.execPath, ['onile/server.js'], {
    cwd: path.join(import.meta.dirname, '..', '..'),
    env,
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const base = 'http://127.0.0.1:' + port;
  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      try {
        const health = await fetch(base + '/api/health');
        if (health.ok) { up = true; break; }
      } catch (e) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(up, true);

    const nameless = await fetch(base + '/api/auth/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com' })
    });
    assert.equal(nameless.status, 400);

    const sent = await fetch(base + '/api/auth/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', phone: '0800' })
    });
    const sentBody = await sent.json();
    assert.equal(sent.status, 200);
    assert.equal(typeof sentBody.devCode, 'string');
    assert.equal(sentBody.phone, undefined);

    const bad = await fetch(base + '/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', code: '000000' })
    });
    assert.equal(bad.status, 400);

    const verified = await fetch(base + '/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', code: sentBody.devCode })
    });
    const verifiedBody = await verified.json();
    assert.equal(verified.status, 200);
    assert.equal(verifiedBody.player.id, accountIdFor('ada@example.com'));
    assert.equal(verifiedBody.player.name, 'Ada');
    assert.equal(verifiedBody.player.email, 'ada@example.com');
    assert.deepEqual(Object.keys(verifiedBody.player).sort(), ['email', 'id', 'name']);
    const cookie = (verified.headers.get('set-cookie') || '').split(';')[0];
    const me = await fetch(base + '/api/me', { headers: { Cookie: cookie } });
    const meBody = await me.json();
    assert.equal(meBody.player.id, verifiedBody.player.id);

    const kolopoly = createAuth({ secret: SECRET });
    const bolaCode = kolopoly.requestCode('bola@example.com');
    const bola = kolopoly.verifyCode('bola@example.com', bolaCode.code);
    const bearer = await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + bola.token } });
    const bearerBody = await bearer.json();
    assert.equal(bearer.status, 200);
    assert.equal(bearerBody.player.id, accountIdFor('bola@example.com'));
    assert.equal(bearerBody.player.email, 'bola@example.com');
    assert.equal(bearerBody.player.name, '');

    const closed = await fetch(base + '/api/challenges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Friday', activity: 'FIFA', stakeNaira: 1000 })
    });
    assert.equal(closed.status, 401);
  } finally {
    child.kill('SIGTERM');
  }
});
