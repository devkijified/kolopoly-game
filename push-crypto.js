'use strict';
// VAPID (RFC 8292) and Web Push encryption (RFC 8291 aes128gcm) using Node
// crypto. The web-push npm package was considered and not added.
const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function fromB64url(s) {
  return Buffer.from(String(s || ''), 'base64url');
}

function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url')
  };
}

function validPublicKey(s) {
  try {
    const buf = fromB64url(s);
    return buf.length === 65 && buf[0] === 4;
  } catch (e) { return false; }
}
function validPrivateKey(s) {
  try { return fromB64url(s).length === 32; } catch (e) { return false; }
}
function validSubject(s) {
  return /^mailto:[^\s@]+@[^\s@]+$/.test(s) || /^https:\/\/[^\s]+$/.test(s);
}

function loadVapid(env, test) {
  env = env || {};
  const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(env.VAPID_SUBJECT || '').trim();
  if (validPublicKey(publicKey) && validPrivateKey(privateKey) && validSubject(subject)) {
    return { enabled: true, publicKey, privateKey, subject, source: 'env' };
  }
  if (test) {
    const g = generateVapidKeys();
    return {
      enabled: true,
      publicKey: g.publicKey,
      privateKey: g.privateKey,
      subject: 'mailto:test@kolopoly.local',
      source: 'test'
    };
  }
  return { enabled: false, publicKey: null, privateKey: null, subject: null, source: 'off' };
}

function jwkFromRaw(publicKey, privateKey) {
  const pub = Buffer.isBuffer(publicKey) ? publicKey : fromB64url(publicKey);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: pub.subarray(1, 33).toString('base64url'),
    y: pub.subarray(33, 65).toString('base64url')
  };
  if (privateKey) jwk.d = (Buffer.isBuffer(privateKey) ? privateKey : fromB64url(privateKey)).toString('base64url');
  return jwk;
}

function vapidAuthorization(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({ aud, exp, sub: vapid.subject }));
  const unsigned = header + '.' + payload;
  const key = crypto.createPrivateKey({ key: jwkFromRaw(vapid.publicKey, vapid.privateKey), format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + unsigned + '.' + b64url(sig) + ', k=' + vapid.publicKey;
}

function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

// RFC 8291: one aes128gcm record. userPublic and userAuth are the
// subscription key strings (base64url), payload is a Buffer.
function encryptPayload(userPublic, userAuth, payload) {
  const uaPublic = fromB64url(userPublic);
  const auth = fromB64url(userAuth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh');
  if (auth.length < 16) throw new Error('bad auth');
  const local = crypto.createECDH('prime256v1');
  local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const ikm = hkdf(shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const padded = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);
  return Buffer.concat([header, ciphertext]);
}

function decryptPayload(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const cipherBytes = body.subarray(21 + idlen);
  const tag = cipherBytes.subarray(cipherBytes.length - 16);
  const data = cipherBytes.subarray(0, cipherBytes.length - 16);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const uaPublic = ecdh.getPublicKey();
  const ikm = hkdf(shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(data), decipher.final()]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end -= 1;
  if (end < 1 || padded[end - 1] !== 2) throw new Error('bad pad');
  return padded.subarray(0, end - 1);
}

async function sendWebPush(sub, payloadObj, vapid) {
  if (!vapid || !vapid.enabled) return { sent: false, reason: 'nokeys', status: 0 };
  const body = encryptPayload(sub.keys.p256dh, sub.keys.auth, Buffer.from(JSON.stringify(payloadObj)));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '43200',
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      Authorization: vapidAuthorization(sub.endpoint, vapid)
    },
    body,
    signal: AbortSignal.timeout(8000)
  });
  return { sent: res.ok, reason: res.ok ? 'ok' : 'delivery', status: res.status };
}

function roundtripSelfTest() {
  const vapid = generateVapidKeys();
  vapid.subject = 'mailto:test@kolopoly.local';
  const header = vapidAuthorization('https://push.example.test/kolopoly/abc', vapid);
  if (!header.startsWith('vapid t=')) throw new Error('auth header');
  const jwt = header.slice('vapid t='.length).split(',')[0].trim();
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('jwt parts');
  const claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  if (claims.aud !== 'https://push.example.test') throw new Error('aud');
  if (claims.sub !== vapid.subject) throw new Error('sub');
  const pub = crypto.createPublicKey({ key: jwkFromRaw(vapid.publicKey), format: 'jwk' });
  const verified = crypto.verify(
    'sha256',
    Buffer.from(parts[0] + '.' + parts[1]),
    { key: pub, dsaEncoding: 'ieee-p1363' },
    fromB64url(parts[2])
  );
  if (!verified) throw new Error('jwt verify');
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const message = Buffer.from('{"title":"Market drop ready","body":"shelf"}');
  const blob = encryptPayload(ua.getPublicKey().toString('base64url'), auth.toString('base64url'), message);
  const back = decryptPayload(blob, ua.getPrivateKey(), auth);
  if (!back.equals(message)) throw new Error('roundtrip');
  return true;
}

module.exports = {
  generateVapidKeys,
  loadVapid,
  validSubject,
  vapidAuthorization,
  encryptPayload,
  decryptPayload,
  sendWebPush,
  roundtripSelfTest
};
