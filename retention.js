'use strict';
// Return retention: a daily market shelf and Web Push whispers.
// The shelf is cowries, kola, yams and cloth. It is not table cash,
// not deeds, and it does not touch the board, the modes, or the economy.
// Identity is the same pair the table already uses: clientId, and the
// seat reconnect token once a room has linked them.
const fs = require('fs');
const path = require('path');
const { loadVapid, sendWebPush, roundtripSelfTest } = require('./push-crypto');

const GOODS = ['cowries', 'kola', 'yams', 'cloth'];
const BASE_DROP = { cowries: 6, kola: 2, yams: 1, cloth: 1 };
// Soft extra when yesterday (Lagos) was also claimed. Missing a day
// pays the base again. There is no streak counter to reset.
const WARM_EXTRA = { cowries: 3, kola: 1, yams: 0, cloth: 0 };
// What a good does at the table. Claim never pays table cash. The
// player spends the shelf during a match: cowries and cloth become
// cash, one kola covers the next rent, one yam covers the next fee.
const USES = {
  cowries: { cost: 3, kind: 'cash', amount: 50000 },
  kola: { cost: 1, kind: 'rent', amount: 100000 },
  yams: { cost: 1, kind: 'fee', amount: 200000 },
  cloth: { cost: 1, kind: 'cash', amount: 150000 }
};
const POT_MARKS = [200000, 500000, 1000000, 2000000];
const NUDGE_GAP_MS = 30 * 60 * 1000;

const NUDGES = {
  drop: {
    title: 'Market drop ready',
    body: "Today's market drop dey ready. Cowries, kola, yam and cloth don land for your shelf.",
    tag: 'kolopoly-drop',
    url: '/'
  },
  waiting: {
    title: 'Your seat is held',
    body: 'Your seat is held. The table dey wait for you, and this room still get your place.',
    tag: 'kolopoly-waiting',
    url: '/'
  },
  pot: {
    title: 'Owambe pot',
    body: 'The Owambe pot don swell. Land on the grounds and you fit collect every naira wey dey inside.',
    tag: 'kolopoly-pot',
    url: '/'
  }
};

function lagosDay(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}
function prevDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
function validDay(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function cleanClientId(v) {
  const s = String(v || '');
  return /^[a-zA-Z0-9-]{8,64}$/.test(s) ? s : null;
}
function cleanToken(v) {
  const s = String(v || '');
  return /^[a-f0-9]{24}$/i.test(s) ? s.toLowerCase() : null;
}
function cleanName(v) {
  const s = String(v || '').trim().slice(0, 20);
  return s || '';
}

function createRetention(opts) {
  opts = opts || {};
  const test = !!opts.test;
  const file = opts.file || path.join(__dirname, 'data', 'retention.json');
  const vapid = loadVapid(opts.env || process.env, test);
  const db = { players: {}, tokens: {}, stats: emptyStats() };
  let saveWarned = false;
  const testLog = [];

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        db.players = parsed.players && typeof parsed.players === 'object' ? parsed.players : {};
        db.tokens = parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {};
        db.stats = mergeStats(parsed.stats);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.log('Retention shelf started empty.');
    }
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!saveWarned) {
        saveWarned = true;
        console.log('Retention shelf could not be saved.');
      }
    }
  }
  load();

  function blank(id) {
    return {
      clientId: id,
      name: '',
      inventory: { cowries: 0, kola: 0, yams: 0, cloth: 0 },
      lastClaimDay: null,
      claimCount: 0,
      push: null,
      pushMuted: false,
      pushDenied: false,
      lastNudgeAt: {},
      lastDropNudgeDay: null
    };
  }
  function normalize(p) {
    p.inventory = p.inventory || {};
    for (const g of GOODS) {
      const n = Math.floor(Number(p.inventory[g]) || 0);
      p.inventory[g] = n > 0 ? n : 0;
    }
    p.lastNudgeAt = p.lastNudgeAt || {};
    p.claimCount = Math.max(0, Math.floor(Number(p.claimCount) || 0));
    return p;
  }
  function ensure(id) {
    if (!db.players[id]) db.players[id] = blank(id);
    return normalize(db.players[id]);
  }

  function resolve(body) {
    body = body || {};
    const sentId = body.clientId != null && String(body.clientId) !== '';
    const sentTok = body.token != null && String(body.token) !== '';
    const cid = cleanClientId(body.clientId);
    const tok = cleanToken(body.token);
    if (sentId && !cid) return { error: 'identity' };
    if (sentTok && !tok) return { error: 'identity' };
    if (!cid && !tok) return { error: 'identity' };
    if (cid && tok && db.tokens[tok] && db.tokens[tok] !== cid) return { error: 'mismatch' };
    if (cid) return { id: cid, token: tok };
    if (tok && db.tokens[tok]) return { id: db.tokens[tok], token: tok };
    return { error: 'identity' };
  }
  function bindToken(who) {
    if (who && who.token) db.tokens[who.token] = who.id;
  }

  function link(info) {
    info = info || {};
    const cid = cleanClientId(info.clientId);
    const tok = cleanToken(info.token);
    if (!cid) return null;
    const p = ensure(cid);
    const name = cleanName(info.name);
    if (name) p.name = name;
    if (tok) {
      db.tokens[tok] = cid;
      p.tokens = Array.isArray(p.tokens) ? p.tokens : [];
      if (!p.tokens.includes(tok)) {
        p.tokens.push(tok);
        if (p.tokens.length > 8) p.tokens.shift();
      }
    }
    save();
    return p;
  }

  function dayFrom(body, query) {
    const raw = body && body.day != null ? body.day : (query ? query.get('day') : null);
    if (raw == null || raw === '') return { day: lagosDay(new Date()) };
    if (!test) return { day: lagosDay(new Date()) };
    if (!validDay(raw)) return { error: 'day' };
    return { day: String(raw) };
  }

  function publicView(id, day) {
    const p = db.players[id] ? normalize(db.players[id]) : blank(id);
    const warmReady = !!p.lastClaimDay && p.lastClaimDay === prevDay(day);
    return {
      ok: true,
      day,
      canClaim: p.lastClaimDay !== day,
      warmReady,
      claimCount: p.claimCount,
      inventory: {
        cowries: p.inventory.cowries,
        kola: p.inventory.kola,
        yams: p.inventory.yams,
        cloth: p.inventory.cloth
      },
      push: {
        enabled: vapid.enabled,
        publicKey: vapid.publicKey,
        subscribed: !!(p.push && p.push.endpoint),
        muted: !!p.pushMuted,
        denied: !!p.pushDenied
      },
      nextDrop: p.lastClaimDay !== day ? {
        cowries: BASE_DROP.cowries + (warmReady ? WARM_EXTRA.cowries : 0),
        kola: BASE_DROP.kola + (warmReady ? WARM_EXTRA.kola : 0),
        yams: BASE_DROP.yams + (warmReady ? WARM_EXTRA.yams : 0),
        cloth: BASE_DROP.cloth + (warmReady ? WARM_EXTRA.cloth : 0)
      } : null,
      uses: {
        cowries: { cost: USES.cowries.cost, kind: USES.cowries.kind, amount: USES.cowries.amount },
        kola: { cost: USES.kola.cost, kind: USES.kola.kind, amount: USES.kola.amount },
        yams: { cost: USES.yams.cost, kind: USES.yams.kind, amount: USES.yams.amount },
        cloth: { cost: USES.cloth.cost, kind: USES.cloth.kind, amount: USES.cloth.amount }
      }
    };
  }

  function inventoryOf(p) {
    return {
      cowries: p.inventory.cowries,
      kola: p.inventory.kola,
      yams: p.inventory.yams,
      cloth: p.inventory.cloth
    };
  }
  // Debit the shelf. The table calls this when a seated player spends.
  // Claim stays goods-only. A short shelf does not go negative.
  function take(clientId, good) {
    const id = cleanClientId(clientId);
    const use = USES[good];
    if (!id || !use) return { ok: false, error: 'good' };
    if (!db.players[id]) return { ok: false, error: 'short' };
    const p = normalize(db.players[id]);
    if (p.inventory[good] < use.cost) return { ok: false, error: 'short' };
    p.inventory[good] -= use.cost;
    save();
    return {
      ok: true,
      good,
      cost: use.cost,
      kind: use.kind,
      amount: use.amount,
      inventory: inventoryOf(p)
    };
  }
  function restore(clientId, good, qty) {
    const id = cleanClientId(clientId);
    const use = USES[good];
    if (!id || !use || !db.players[id]) return;
    const p = normalize(db.players[id]);
    const n = Math.max(0, Math.floor(Number(qty) || use.cost));
    p.inventory[good] += n;
    save();
  }

  function claim(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const picked = dayFrom(body, null);
    if (picked.error) return { status: 400, body: { ok: false, error: picked.error } };
    const day = picked.day;
    const p = ensure(who.id);
    bindToken(who);
    const name = cleanName(body.name);
    if (name) p.name = name;
    if (p.lastClaimDay === day) {
      save();
      return {
        status: 200,
        body: Object.assign(publicView(who.id, day), {
          already: true,
          first: false,
          warm: false,
          granted: null,
          line: 'You don collect today market drop. The next one opens with Lagos dawn.'
        })
      };
    }
    const warm = p.lastClaimDay === prevDay(day);
    const granted = {};
    for (const g of GOODS) {
      granted[g] = BASE_DROP[g] + (warm ? WARM_EXTRA[g] : 0);
      p.inventory[g] += granted[g];
    }
    const first = p.claimCount === 0;
    p.claimCount += 1;
    p.lastClaimDay = day;
    bumpStat('claims', day);
    save();
    return {
      status: 200,
      body: Object.assign(publicView(who.id, day), {
        already: false,
        first,
        warm,
        granted,
        line: warm
          ? 'Market remember you from yesterday. Extra cowries and kola dey your shelf. Spend them inside a match.'
          : 'Cowries, kola, yam and cloth don enter your shelf. Spend them inside a match.'
      })
    };
  }

  function normalizeSub(s) {
    if (!s || typeof s !== 'object') return null;
    const endpoint = String(s.endpoint || '');
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000) return null;
    const keys = s.keys || {};
    const p256dh = String(keys.p256dh || '');
    const auth = String(keys.auth || '');
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(p256dh)) return null;
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(auth)) return null;
    return { endpoint, keys: { p256dh, auth } };
  }

  function subscribe(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const sub = normalizeSub(body.subscription);
    if (!sub) return { status: 400, body: { ok: false, error: 'subscription' } };
    const p = ensure(who.id);
    bindToken(who);
    const name = cleanName(body.name);
    if (name) p.name = name;
    p.push = sub;
    p.pushMuted = false;
    p.pushDenied = false;
    save();
    return { status: 200, body: { ok: true, subscribed: true, muted: false } };
  }
  function mute(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const p = ensure(who.id);
    bindToken(who);
    p.pushMuted = !!body.muted;
    if (!body.muted) p.pushDenied = false;
    save();
    return { status: 200, body: { ok: true, muted: p.pushMuted } };
  }
  function denied(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const p = ensure(who.id);
    bindToken(who);
    p.pushDenied = true;
    p.pushMuted = true;
    save();
    return { status: 200, body: { ok: true, denied: true } };
  }
  function unsubscribe(body) {
    const who = resolve(body);
    if (who.error) return { status: 400, body: { ok: false, error: who.error } };
    const p = ensure(who.id);
    bindToken(who);
    p.push = null;
    p.pushMuted = true;
    save();
    return { status: 200, body: { ok: true, subscribed: false } };
  }

  function nudgePayload(kind) {
    const src = NUDGES[kind] || NUDGES.drop;
    return { title: src.title, body: src.body, tag: src.tag, url: src.url };
  }

  async function deliver(id, kind, opts) {
    opts = opts || {};
    const p = db.players[id] ? normalize(db.players[id]) : null;
    if (!p) return { sent: false, reason: 'nosub' };
    if (p.pushDenied) return { sent: false, reason: 'denied' };
    if (p.pushMuted) return { sent: false, reason: 'muted' };
    if (!p.push || !p.push.endpoint) return { sent: false, reason: 'nosub' };
    const nowMs = Date.now();
    if (!opts.force && p.lastNudgeAt[kind] && nowMs - p.lastNudgeAt[kind] < (test ? 0 : NUDGE_GAP_MS)) {
      return { sent: false, reason: 'throttle' };
    }
    if (kind === 'drop' && !opts.force && p.lastDropNudgeDay && opts.day && p.lastDropNudgeDay === opts.day) {
      return { sent: false, reason: 'already' };
    }
    const payload = nudgePayload(kind);
    p.lastNudgeAt[kind] = nowMs;
    if (kind === 'drop' && opts.day) p.lastDropNudgeDay = opts.day;
    save();
    if (test) {
      testLog.push({ clientId: id, kind, payload });
      return { sent: true, reason: 'test', payload };
    }
    try {
      const result = await sendWebPush(p.push, payload, vapid);
      if (result.status === 404 || result.status === 410) {
        p.push = null;
        save();
      }
      return { sent: !!result.sent, reason: result.reason, payload };
    } catch (e) {
      return { sent: false, reason: 'delivery' };
    }
  }

  function onSeatWaiting(player) {
    if (!player || player.bot || player.resigned || player.leftConfirmed) return;
    const id = cleanClientId(player.clientId);
    if (!id) return;
    deliver(id, 'waiting', {}).catch(() => {});
  }
  function onPot(room) {
    if (!room || room.mode === 'pass' || !room.pot) return;
    room.potMarks = room.potMarks || {};
    const hit = POT_MARKS.filter((n) => room.pot >= n && !room.potMarks[n]);
    if (!hit.length) return;
    for (const n of hit) room.potMarks[n] = true;
    for (const p of room.players || []) {
      if (!p || p.bot || p.connected || p.resigned || !p.clientId) continue;
      deliver(p.clientId, 'pot', {}).catch(() => {});
    }
  }
  async function sweepDrops(day) {
    const today = day || lagosDay(new Date());
    let sent = 0;
    for (const p of Object.values(db.players)) {
      if (!p || !p.push || p.pushMuted || p.pushDenied) continue;
      if (p.lastClaimDay === today) continue;
      if (p.lastDropNudgeDay === today) continue;
      const result = await deliver(p.clientId, 'drop', { day: today });
      if (result.sent) sent += 1;
    }
    return sent;
  }

  function emptyStats() {
    return { claims: {}, tablesStarted: {}, tablesFinished: {}, afk: {} };
  }
  function mergeStats(src) {
    const stats = emptyStats();
    if (!src || typeof src !== 'object') return stats;
    for (const kind of Object.keys(stats)) {
      const bucket = src[kind];
      if (!bucket || typeof bucket !== 'object') continue;
      for (const [day, n] of Object.entries(bucket)) {
        if (!validDay(day)) continue;
        const v = Math.floor(Number(n) || 0);
        if (v > 0) stats[kind][day] = v;
      }
    }
    return stats;
  }
  function pruneStats() {
    const keep = new Set();
    let cursor = lagosDay(new Date());
    for (let i = 0; i < 21; i++) {
      keep.add(cursor);
      cursor = prevDay(cursor);
    }
    for (const bucket of Object.values(db.stats)) {
      for (const day of Object.keys(bucket)) {
        if (!keep.has(day)) delete bucket[day];
      }
    }
  }
  function bumpStat(kind, day) {
    if (!db.stats[kind]) db.stats[kind] = {};
    const d = validDay(day) ? String(day) : lagosDay(new Date());
    db.stats[kind][d] = Math.floor(Number(db.stats[kind][d]) || 0) + 1;
    pruneStats();
  }
  function dayCount(kind, day) {
    const bucket = db.stats[kind] || {};
    return Math.floor(Number(bucket[day]) || 0);
  }
  // House ledger only. Counts and health. No shelf names, client ids,
  // reconnect tokens, or push key material.
  function noteDay(kind, day) {
    if (kind !== 'tablesStarted' && kind !== 'tablesFinished' && kind !== 'afk') return;
    bumpStat(kind, day);
    save();
  }
  function fileStatus() {
    const usingOverride = !!(opts.env && String(opts.env.KP_RETENTION_FILE || '').trim());
    let present = false;
    let bytes = 0;
    let writable = false;
    try {
      const st = fs.statSync(file);
      present = st.isFile();
      bytes = st.size;
    } catch (e) { present = false; }
    try {
      fs.accessSync(path.dirname(file), fs.constants.W_OK);
      writable = true;
    } catch (e) { writable = false; }
    return {
      present,
      writable,
      bytes,
      override: usingOverride,
      label: usingOverride ? 'custom' : 'retention.json'
    };
  }
  function opsSummary() {
    const day = lagosDay(new Date());
    const yesterday = prevDay(day);
    let shelves = 0;
    let claimedToday = 0;
    let subscribers = 0;
    let muted = 0;
    let denied = 0;
    for (const p of Object.values(db.players)) {
      if (!p || typeof p !== 'object') continue;
      shelves += 1;
      if (p.lastClaimDay === day) claimedToday += 1;
      if (p.push && p.push.endpoint) subscribers += 1;
      if (p.pushMuted) muted += 1;
      if (p.pushDenied) denied += 1;
    }
    const roll = (kind) => dayCount(kind, day) + dayCount(kind, yesterday);
    return {
      day,
      yesterday,
      shelves,
      claimedToday,
      today: {
        claims: dayCount('claims', day),
        tablesStarted: dayCount('tablesStarted', day),
        tablesFinished: dayCount('tablesFinished', day),
        afkTakeovers: dayCount('afk', day)
      },
      rolling: {
        window: 'two Lagos days',
        claims: roll('claims'),
        tablesStarted: roll('tablesStarted'),
        tablesFinished: roll('tablesFinished'),
        afkTakeovers: roll('afk')
      },
      push: {
        enabled: !!vapid.enabled,
        source: vapid.source || 'off',
        subscribers,
        muted,
        denied
      },
      file: fileStatus()
    };
  }

  function accepts(req) {
    const clean = (req.url || '').split('?')[0];
    return clean === '/api/retention'
      || clean === '/api/retention/claim'
      || clean === '/api/push/vapid'
      || clean === '/api/push/subscribe'
      || clean === '/api/push/mute'
      || clean === '/api/push/denied'
      || clean === '/api/push/unsubscribe'
      || (test && (clean === '/api/test/nudge' || clean === '/api/test/sweep' || clean === '/api/test/push-roundtrip'));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > 8192) { reject(new Error('too big')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }
  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  }

  function handle(req, res) {
    const clean = (req.url || '').split('?')[0];
    const query = (() => { try { return new URL(req.url, 'http://localhost').searchParams; } catch (e) { return new URLSearchParams(); } })();
    Promise.resolve().then(async () => {
      if (req.method === 'GET' && clean === '/api/push/vapid') {
        sendJson(res, 200, { ok: true, enabled: vapid.enabled, publicKey: vapid.publicKey });
        return;
      }
      if (req.method === 'GET' && clean === '/api/test/push-roundtrip') {
        roundtripSelfTest();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && clean === '/api/retention') {
        const picked = dayFrom({ day: query.get('day') }, null);
        if (picked.error) { sendJson(res, 400, { ok: false, error: picked.error }); return; }
        const who = resolve({ clientId: query.get('clientId'), token: query.get('token') });
        if (who.error) { sendJson(res, 400, { ok: false, error: who.error }); return; }
        sendJson(res, 200, publicView(who.id, picked.day));
        return;
      }
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
      const body = await readBody(req);
      if (clean === '/api/retention/claim') { const out = claim(body); sendJson(res, out.status, out.body); return; }
      if (clean === '/api/push/subscribe') { const out = subscribe(body); sendJson(res, out.status, out.body); return; }
      if (clean === '/api/push/mute') { const out = mute(body); sendJson(res, out.status, out.body); return; }
      if (clean === '/api/push/denied') { const out = denied(body); sendJson(res, out.status, out.body); return; }
      if (clean === '/api/push/unsubscribe') { const out = unsubscribe(body); sendJson(res, out.status, out.body); return; }
      if (test && clean === '/api/test/nudge') {
        const who = resolve(body);
        if (who.error) { sendJson(res, 400, { ok: false, error: who.error }); return; }
        const kind = NUDGES[body.kind] ? body.kind : 'drop';
        const result = await deliver(who.id, kind, { force: !!body.force, day: validDay(body.day) ? body.day : lagosDay(new Date()) });
        sendJson(res, 200, result);
        return;
      }
      if (test && clean === '/api/test/sweep') {
        const picked = dayFrom(body, null);
        if (picked.error) { sendJson(res, 400, { ok: false, error: picked.error }); return; }
        const before = testLog.length;
        const sent = await sweepDrops(picked.day);
        sendJson(res, 200, { ok: true, sent, nudges: testLog.slice(before) });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'no route' });
    }).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: 'bad request' });
    });
  }

  return {
    vapid,
    accepts,
    handle,
    link,
    take,
    restore,
    onSeatWaiting,
    onPot,
    sweepDrops,
    noteDay,
    opsSummary,
    testLog
  };
}

module.exports = { createRetention, GOODS, BASE_DROP, WARM_EXTRA, USES, NUDGES, lagosDay };
