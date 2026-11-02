'use strict';
// VAPID (RFC 8292) and Web Push encryption (RFC 8291 aes128gcm) using
// WebCrypto. The Node server keeps push-crypto.js. Workers cannot use
// Node's createECDH / createCipheriv, so this is the shelf's push path
// there. Keys are the same VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY strings.
//
// A fixed test pair is used when KP_TEST is on and no keys are configured.
// It is not a production secret; production always reads the environment.

const TEST_VAPID = {
  publicKey: 'BPmLNqxC-7aovOAqIT1X80Ofp-ZIW5f1ewv8Wk-bZLY2MQPW2l6bwESMBL3n12wdmvMUmaL9DaTR0OEXHde62w0',
  privateKey: 'EdSgeSOCBjonxCJzPBYbPW3A7mqRfn7wePNN9Q3U-eY'
};

function bytesToB64url(bytes) {
  let bin = '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlToBytes(s) {
  const src = String(s || '');
  const pad = src.length % 4 === 0 ? '' : '='.repeat(4 - (src.length % 4));
  const b64 = src.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function validPublicKey(s) {
  try {
    const buf = b64urlToBytes(s);
    return buf.length === 65 && buf[0] === 4;
  } catch (e) { return false; }
}
function validPrivateKey(s) {
  try { return b64urlToBytes(s).length === 32; } catch (e) { return false; }
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
    return {
      enabled: true,
      publicKey: TEST_VAPID.publicKey,
      privateKey: TEST_VAPID.privateKey,
      subject: 'mailto:test@kolopoly.local',
      source: 'test'
    };
  }
  return { enabled: false, publicKey: null, privateKey: null, subject: null, source: 'off' };
}

function jwkFromRaw(publicKey, privateKey) {
  const pub = publicKey instanceof Uint8Array ? publicKey : b64urlToBytes(publicKey);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(pub.subarray(1, 33)),
    y: bytesToB64url(pub.subarray(33, 65)),
    ext: true
  };
  if (privateKey) jwk.d = bytesToB64url(privateKey instanceof Uint8Array ? privateKey : b64urlToBytes(privateKey));
  return jwk;
}

async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

async function vapidAuthorization(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify({ aud, exp, sub: vapid.subject })));
  const unsigned = header + '.' + payload;
  const key = await crypto.subtle.importKey(
    'jwk',
    jwkFromRaw(vapid.publicKey, vapid.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsigned)
  ));
  return 'vapid t=' + unsigned + '.' + bytesToB64url(sig) + ', k=' + vapid.publicKey;
}

async function encryptPayload(userPublic, userAuth, payload) {
  const uaPublic = typeof userPublic === 'string' ? b64urlToBytes(userPublic) : userPublic;
  const auth = typeof userAuth === 'string' ? b64urlToBytes(userAuth) : userAuth;
  const plain = payload instanceof Uint8Array ? payload : new TextEncoder().encode(payload);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh');
  if (auth.length < 16) throw new Error('bad auth');
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(
    shared,
    auth,
    concatBytes([new TextEncoder().encode('WebPush: info\0'), uaPublic, asPublic]),
    32
  );
  const cek = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const padded = concatBytes([plain, new Uint8Array([2])]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, padded));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  const view = new DataView(header.buffer);
  view.setUint32(16, 4096, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concatBytes([header, ciphertext]);
}

async function sendWebPush(sub, payloadObj, vapid) {
  if (!vapid || !vapid.enabled) return { sent: false, reason: 'nokeys', status: 0 };
  const body = await encryptPayload(sub.keys.p256dh, sub.keys.auth, JSON.stringify(payloadObj));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '43200',
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      Authorization: await vapidAuthorization(sub.endpoint, vapid)
    },
    body
  });
  return { sent: res.ok, reason: res.ok ? 'ok' : 'delivery', status: res.status };
}

async function roundtripSelfTest() {
  const vapid = loadVapid({}, true);
  const header = await vapidAuthorization('https://push.example.test/kolopoly/abc', vapid);
  if (!header.startsWith('vapid t=')) throw new Error('auth header');
  const jwt = header.slice('vapid t='.length).split(',')[0].trim();
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('jwt parts');
  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  if (claims.aud !== 'https://push.example.test') throw new Error('aud');
  if (claims.sub !== vapid.subject) throw new Error('sub');
  const pub = await crypto.subtle.importKey(
    'jwk',
    jwkFromRaw(vapid.publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pub,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (!verified) throw new Error('jwt verify');
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const uaJwk = await crypto.subtle.exportKey('jwk', ua.privateKey);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const message = new TextEncoder().encode('{"title":"Market drop ready","body":"shelf"}');
  const blob = await encryptPayload(bytesToB64url(uaPub), bytesToB64url(auth), message);
  const back = await decryptWithJwk(blob, uaJwk, uaPub, auth);
  const backText = new TextDecoder().decode(back);
  if (backText !== new TextDecoder().decode(message)) throw new Error('roundtrip');
  return true;
}

async function decryptWithJwk(body, uaJwk, uaPub, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipherBytes = body.subarray(21 + idlen);
  const local = await crypto.subtle.importKey(
    'jwk',
    uaJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, local, 256));
  const ikm = await hkdf(
    shared,
    auth,
    concatBytes([new TextEncoder().encode('WebPush: info\0'), uaPub, asPublic]),
    32
  );
  const cek = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, cipherBytes));
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end -= 1;
  if (end < 1 || padded[end - 1] !== 2) throw new Error('bad pad');
  return padded.subarray(0, end - 1);
}

module.exports = {
  loadVapid,
  validSubject,
  vapidAuthorization,
  encryptPayload,
  sendWebPush,
  roundtripSelfTest,
  TEST_VAPID
};
