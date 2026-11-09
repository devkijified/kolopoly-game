'use strict';
// Kolopoly on Cloudflare Workers. Static files come from the assets
// binding. Each table is one Durable Object (SQLite) that hibernates
// between messages. Alarms, not setInterval, run the turn clock, AFK,
// auctions and phase horns. The rules are game-host.js, the same module
// the Node server runs.
import hostMod from './game-host.js';
import retentionMod from './retention.js';
import recordsMod from './server-records.js';
import push from './push-webcrypto.js';
import deskHtml from './ops/desk.html';
import deskCss from './ops/desk.css';
import deskJs from './ops/desk.js';

const { createGameHost } = hostMod;
const { createRetention } = retentionMod;
const { createRecords } = recordsMod;

const BUILD_FILES = [
  'public/index.html',
  'public/app.js',
  'public/style.css',
  'public/sw.js',
  'public/retention.js',
  'public/update.js',
  'public/game-data.js',
  'public/board.js',
  'public/board3d.js',
  'public/manifest.webmanifest'
];
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const MAX_PLAYERS = 6;
const POT_MARKS = [200000, 500000, 1000000, 2000000];
const LOCKED_MESSAGE = 'Ops locked until KP_ADMIN_TOKEN is set';
const SESSION_MS = 4 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 5;
const GLOBAL_LIMIT = 20;
const OPS_ROUTES = new Set(['/ops', '/ops/desk.css', '/ops/desk.js', '/ops/snapshot', '/ops/unlock', '/ops/lock']);

let cachedBuild = '';

function b64url(bytes) {
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
function randomHex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
function cleanClientId(v) {
  const s = String(v || '');
  return /^[a-zA-Z0-9-]{8,64}$/.test(s) ? s : null;
}
function sameBytes(a, b) {
  const n = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < n; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}
function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra || {})
  });
}
function isTest(env) { return env && env.KP_TEST === '1'; }

async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text))));
}
async function tokenMatches(given, secret) {
  if (!secret) return false;
  const a = await sha256Bytes(secret);
  const b = await sha256Bytes(given == null ? '' : given);
  return sameBytes(a, b);
}
async function sessionMac(token, body) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('kolopoly.ops.session.v1'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const secret = new Uint8Array(await crypto.subtle.sign('HMAC', base, new TextEncoder().encode(token || '')));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return b64url(sig);
}

async function computeBuild(env) {
  if (cachedBuild) return cachedBuild;
  const enc = new TextEncoder();
  const parts = [];
  for (const rel of BUILD_FILES) {
    const urlPath = '/' + rel.slice('public/'.length);
    const res = await env.ASSETS.fetch(new Request('https://assets.local' + urlPath));
    if (!res.ok) throw new Error('missing asset ' + rel);
    parts.push(enc.encode(rel));
    parts.push(new Uint8Array([0]));
    parts.push(new Uint8Array(await res.arrayBuffer()));
  }
  let n = 0;
  for (const p of parts) n += p.length;
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  cachedBuild = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  return cachedBuild;
}

function roomSummary(room) {
  const humansHere = room.players.filter((p) => p.connected && !p.bot).length;
  return {
    code: room.code,
    isPublic: !!room.isPublic,
    mode: room.mode || 'online',
    status: room.status || 'lobby',
    gameMode: room.settings && room.settings.gameMode === 'inflation' ? 'inflation' : 'classic',
    preset: room.settings ? (room.settings.preset || null) : null,
    players: room.players.length,
    connected: humansHere,
    humans: room.players.filter((p) => !p.bot).length,
    humansHere,
    bots: room.players.filter((p) => p.bot).length,
    paused: !!room.paused,
    phase: room.phase || 'roll',
    infPhase: room.inf ? room.inf.phase : null,
    names: room.players.slice(0, 8).map((p) => ({
      name: String(p.name || '').slice(0, 20),
      bot: !!p.bot,
      here: !!p.connected && !p.bot,
      afk: !!p.afkTaken
    })),
    watching: room.spectators ? room.spectators.size : 0,
    startedAt: room.startedAt || null,
    createdAt: room.createdAt || null,
    opening: false,
    updatedAt: Date.now()
  };
}

function assembleSnapshot(rows, shelf, bootAt) {
  const list = [];
  let humans = 0;
  let humansHere = 0;
  let bots = 0;
  let watching = 0;
  const byStatus = { lobby: 0, playing: 0, ended: 0 };
  for (const row of rows) {
    const status = row.status === 'playing' || row.status === 'ended' ? row.status : 'lobby';
    byStatus[status] = (byStatus[status] || 0) + 1;
    humans += row.humans || 0;
    humansHere += row.humansHere || 0;
    bots += row.bots || 0;
    watching += row.watching || 0;
    const anchor = status !== 'lobby' && row.startedAt ? row.startedAt : (row.createdAt || row.startedAt || Date.now());
    list.push({
      code: row.code,
      mode: row.mode === 'pass' ? 'pass' : 'online',
      rules: row.gameMode === 'inflation' ? 'inflation' : 'classic',
      preset: row.gameMode === 'inflation' ? (row.preset || 'standard') : null,
      isPublic: !!row.isPublic,
      status,
      phase: status === 'playing' ? (row.phase || 'roll') : status,
      paused: !!row.paused,
      infPhase: row.infPhase == null ? null : row.infPhase,
      humans: row.humans || 0,
      humansHere: row.humansHere || 0,
      bots: row.bots || 0,
      seats: row.players || 0,
      watching: row.watching || 0,
      ageSec: Math.max(0, Math.round((Date.now() - anchor) / 1000)),
      names: row.names || []
    });
  }
  const rank = { playing: 0, lobby: 1, ended: 2 };
  list.sort((a, b) => (rank[a.status] - rank[b.status]) || (a.ageSec - b.ageSec) || String(a.code).localeCompare(String(b.code)));
  const today = shelf && shelf.today ? shelf.today : { claims: 0, tablesStarted: 0, tablesFinished: 0, afkTakeovers: 0 };
  const rolling = shelf && shelf.rolling ? shelf.rolling : { window: 'two Lagos days', claims: 0, tablesStarted: 0, tablesFinished: 0, afkTakeovers: 0 };
  return {
    ok: true,
    now: Date.now(),
    lagosDay: shelf ? shelf.day : null,
    uptimeSec: Math.max(0, Math.round((Date.now() - (bootAt || Date.now())) / 1000)),
    live: { rooms: list.length, humans, humansHere, bots, watching, devices: 0, byStatus },
    today: {
      tablesStarted: today.tablesStarted || 0,
      tablesFinished: today.tablesFinished || 0,
      claims: today.claims || 0,
      afkTakeovers: today.afkTakeovers || 0,
      claimedShelves: shelf ? shelf.claimedToday || 0 : 0,
      uniqueShelves: shelf ? shelf.shelves || 0 : 0
    },
    rolling,
    push: shelf && shelf.push ? shelf.push : { enabled: false, source: 'off', subscribers: 0, muted: 0, denied: 0 },
    retention: shelf && shelf.file ? shelf.file : { present: true, writable: true, bytes: 0, override: false, label: 'durable-object' },
    rooms: list.slice(0, 40),
    roomsTruncated: list.length > 40
  };
}

function scrub(value, secret) {
  const STRIP = new Set(['clientId', 'reconnectToken', 'reconnect', 'privateKey', 'publicKey', 'endpoint', 'p256dh', 'auth', 'token', 'ws', 'subscription', 'keys']);
  if (Array.isArray(value)) return value.map((item) => scrub(item, secret));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (STRIP.has(key)) continue;
      out[key] = scrub(child, secret);
    }
    return out;
  }
  if (typeof value === 'string' && secret && value === secret) return '••••';
  return value;
}

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.host = null;
    this.roomCode = '';
    this.shelf = { api: null, ops: [] };
    this.jobs = [];
    this.dirty = false;
    this.deleted = null;
  }

  test() { return isTest(this.env); }

  retentionId() { return this.env.RETENTION.idFromName('shelf'); }
  lobbyId() { return this.env.LOBBY.idFromName('global'); }

  async fetch(request) {
    const url = new URL(request.url);
    const fromPath = (url.pathname.split('/').pop() || '').toUpperCase();
    const code = /^[A-Z]{4}$/.test(fromPath) ? fromPath : String(url.searchParams.get('code') || '').toUpperCase();
    if (/^[A-Z]{4}$/.test(code)) {
      this.roomCode = code;
      await this.state.storage.put('code', code);
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      if (!this.roomCode) this.roomCode = (await this.state.storage.get('code')) || '';
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ connId: randomHex(8), playerId: null, spectator: false, roomCode: this.roomCode || null });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/alarm') { await this.alarm(); return new Response('ok'); }
    if (url.pathname === '/evict') {
      if (this.host) await this.state.storage.put('game', this.host.exportState());
      this.host = null;
      for (const ws of this.state.getWebSockets()) delete ws.__wrap;
      return new Response('ok');
    }
    if (url.pathname.startsWith('/api/room/')) return this.roomHttp(url);
    return new Response('Kolopoly room', { status: 200 });
  }

  async roomHttp(url) {
    await this.ensure();
    const code = url.pathname.slice('/api/room/'.length).trim().toUpperCase();
    const room = this.host && this.host.rooms.get(code);
    if (!room || room.mode === 'pass') return json({ exists: false });
    const hostPlayer = room.players.find((p) => p.id === room.hostId);
    let yourSeat = null;
    const cid = cleanClientId(url.searchParams.get('clientId'));
    if (cid) {
      const mine = room.players.find((p) => p.clientId && p.clientId === cid);
      if (mine) yourSeat = { name: mine.name, token: mine.token };
    }
    return json({
      exists: true, code: room.code, status: room.status,
      hostName: hostPlayer ? hostPlayer.name : null,
      players: room.players.length, full: room.players.length >= MAX_PLAYERS,
      yourSeat
    }, 200, { 'Cache-Control': 'no-cache' });
  }

  async ensure() {
    if (!this.roomCode) this.roomCode = (await this.state.storage.get('code')) || '';
    if (this.host) return;
    const self = this;
    const records = createRecords(this.env);
    this.host = createGameHost({
      test: this.test(),
      afkFast: this.test() && this.env.KP_AFK_FAST === '1',
      fixedCode: this.roomCode || null,
      externalBots: true,
      retention: {
        link(info) { self.shelf.ops.push({ op: 'link', info }); },
        take(id, good) {
          if (!self.shelf.api) return { ok: false, error: 'short' };
          const result = self.shelf.api.take(id, good);
          if (result && result.ok) self.shelf.ops.push({ op: 'take', clientId: id, good });
          return result;
        },
        onSeatWaiting(player) {
          self.shelf.ops.push({
            op: 'waiting',
            player: {
              clientId: player && player.clientId,
              bot: !!(player && player.bot),
              resigned: !!(player && player.resigned),
              leftConfirmed: !!(player && player.leftConfirmed)
            }
          });
        },
        onPot(room) {
          if (!room || room.mode === 'pass' || !room.pot) return;
          room.potMarks = room.potMarks || {};
          const hit = POT_MARKS.filter((n) => room.pot >= n && !room.potMarks[n]);
          if (!hit.length) return;
          for (const n of hit) room.potMarks[n] = true;
          const ids = [];
          for (const p of room.players || []) {
            if (!p || p.bot || p.connected || p.resigned || !p.clientId) continue;
            ids.push(p.clientId);
          }
          if (ids.length) self.shelf.ops.push({ op: 'pot', players: ids });
        },
        noteDay(kind) { self.shelf.ops.push({ op: 'note', kind }); },
        markPlayed(ids) { self.shelf.ops.push({ op: 'played', clientIds: ids }); }
      },
      records: {
        enabled: () => records.enabled(),
        getRecords: () => records.getRecords(),
        recordMatch(room) {
          const job = records.recordMatch(room);
          self.jobs.push(job);
          return job;
        }
      },
      onMutate() { self.dirty = true; },
      onDelete(code) { self.deleted = code; self.dirty = true; }
    });
    const saved = await this.state.storage.get('game');
    if (saved) this.host.importState(saved);
    this.rebind();
  }

  rebind() {
    for (const native of this.state.getWebSockets()) {
      const wrap = this.wrap(native, true);
      this.host.handleConnection(wrap);
      this.adopt(wrap, native.deserializeAttachment() || {});
    }
  }

  wrap(native, fresh) {
    if (!fresh && native.__wrap && native.__wrap._onMessage) return native.__wrap;
    const att = native.deserializeAttachment() || {};
    const wrap = {
      readyState: 1,
      __connId: att.connId || randomHex(8),
      send(data) { try { native.send(typeof data === 'string' ? data : String(data)); } catch (e) { /* closed */ } },
      close(code, reason) {
        wrap.readyState = 3;
        try { native.close(code || 1000, String(reason || '')); } catch (e) { /* closed */ }
      }
    };
    native.__wrap = wrap;
    return wrap;
  }

  adopt(wrap, att) {
    const ctx = wrap._ctx;
    if (!ctx) return;
    ctx.player = null;
    ctx.room = null;
    ctx.spectator = false;
    if (!att || !att.roomCode || !this.host) return;
    const room = this.host.rooms.get(att.roomCode);
    if (!room) return;
    ctx.room = room;
    if (att.spectator) {
      ctx.spectator = true;
      room.spectators.add(wrap);
      return;
    }
    const player = room.players.find((p) => p.id === Number(att.playerId));
    if (!player || player.bot) return;
    ctx.player = player;
    player.ws = wrap;
    player.connected = true;
    room.emptyAt = null;
  }

  syncAttachment(native, wrap) {
    const ctx = wrap._ctx || {};
    const prev = native.deserializeAttachment() || {};
    native.serializeAttachment({
      connId: prev.connId || wrap.__connId,
      playerId: ctx.player ? ctx.player.id : null,
      spectator: !!ctx.spectator,
      roomCode: ctx.room ? ctx.room.code : (this.roomCode || null)
    });
  }

  async prepareShelf(text) {
    this.shelf.ops = [];
    this.shelf.api = null;
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || msg.type !== 'use_shelf') return;
    const res = await this.env.RETENTION.get(this.retentionId()).fetch('https://retention.internal/load');
    const db = await res.json();
    this.shelf.api = createRetention({
      memory: true,
      db,
      test: this.test(),
      env: this.env,
      push
    });
  }

  async webSocketMessage(ws, message) {
    try {
      await this.ensure();
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      await this.prepareShelf(text);
      const wrap = this.wrap(ws, false);
      if (!wrap._onMessage) this.host.handleConnection(wrap);
      wrap._onMessage(text);
      this.syncAttachment(ws, wrap);
      this.host.tick();
      await this.persist();
    } catch (e) {
      const detail = this.test() ? String(e && e.stack || e) : 'The table hit a snag. Try again.';
      try { ws.send(JSON.stringify({ type: 'error', message: detail })); } catch (err) { /* socket gone */ }
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      await this.ensure();
      const wrap = this.wrap(ws, false);
      wrap.readyState = 3;
      if (wrap._onClose) wrap._onClose();
      await this.persist();
    } catch (e) { /* a close during eviction still drops the seat on the next wake */ }
  }

  async alarm() {
    await this.ensure();
    if (this.host) this.host.tick();
    await this.persist();
  }

  async persist() {
    if (!this.host) return;
    if (this.deleted) {
      await this.state.storage.delete('game');
      await this.env.LOBBY.get(this.lobbyId()).fetch('https://lobby.internal/forget?code=' + encodeURIComponent(this.deleted), { method: 'POST' });
      this.deleted = null;
      this.dirty = false;
    } else {
      await this.state.storage.put('game', this.host.exportState());
      if (this.dirty) {
        let summary = null;
        const room = this.roomCode ? this.host.rooms.get(this.roomCode) : null;
        if (!room) {
          for (const r of this.host.rooms.values()) { summary = roomSummary(r); break; }
        } else summary = roomSummary(room);
        if (summary) {
          await this.env.LOBBY.get(this.lobbyId()).fetch('https://lobby.internal/sync', {
            method: 'POST',
            body: JSON.stringify(summary)
          });
        }
        this.dirty = false;
      }
    }
    if (this.shelf.ops.length) {
      const ops = this.shelf.ops.splice(0);
      await this.env.RETENTION.get(this.retentionId()).fetch('https://retention.internal/apply', {
        method: 'POST',
        body: JSON.stringify(ops)
      });
    }
    await this.schedule();
    if (this.jobs.length) {
      const jobs = this.jobs.splice(0);
      await Promise.all(jobs.map((job) => Promise.resolve(job).catch(() => {})));
    }
  }

  async schedule() {
    if (!this.host) { await this.state.storage.deleteAlarm(); return; }
    const at = this.host.nextWake(Date.now());
    if (at == null) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(at);
  }
}

export class LobbyDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ connId: randomHex(8) });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/sync' && request.method === 'POST') {
      const summary = await request.json();
      await this.upsert(summary);
      return json({ ok: true });
    }
    if (url.pathname === '/forget' && request.method === 'POST') {
      await this.forget(String(url.searchParams.get('code') || '').toUpperCase());
      return json({ ok: true });
    }
    if (url.pathname === '/registry') {
      const reg = await this.registry();
      return json(reg);
    }
    if (OPS_ROUTES.has(url.pathname) || url.pathname.startsWith('/ops')) return this.ops(request, url);
    return new Response('Kolopoly lobby', { status: 200 });
  }

  async registry() {
    return (await this.state.storage.get('registry')) || { rooms: {}, bootAt: Date.now() };
  }
  async saveRegistry(reg) {
    if (!reg.bootAt) reg.bootAt = Date.now();
    await this.state.storage.put('registry', reg);
  }
  async upsert(summary) {
    if (!summary || !summary.code) return;
    const reg = await this.registry();
    reg.rooms[summary.code] = summary;
    await this.saveRegistry(reg);
  }
  async forget(code) {
    const reg = await this.registry();
    if (reg.rooms[code]) delete reg.rooms[code];
    await this.saveRegistry(reg);
  }
  makeCode(reg) {
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 4; i++) code += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    } while (reg.rooms[code]);
    return code;
  }
  async allocate(msg) {
    const reg = await this.registry();
    const now = Date.now();
    let pruned = false;
    for (const code of Object.keys(reg.rooms)) {
      const row = reg.rooms[code];
      if (row && row.opening && now - (row.updatedAt || 0) > 60000) {
        delete reg.rooms[code];
        pruned = true;
      }
    }
    if (pruned) await this.saveRegistry(reg);
    if (msg.type === 'join_room' || msg.type === 'rejoin') {
      const code = String(msg.code || '').trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) return null;
      return code;
    }
    if (msg.type === 'quick_join') {
      const want = msg.gameMode === 'classic' ? 'classic' : 'inflation';
      for (const r of Object.values(reg.rooms)) {
        if (!r.isPublic || r.mode !== 'online' || r.status !== 'lobby') continue;
        if (r.gameMode !== want) continue;
        if ((r.connected || 0) >= 1 && (r.players || 0) < MAX_PLAYERS) return r.code;
      }
      for (const r of Object.values(reg.rooms)) {
        if (!r.opening || !r.isPublic || r.gameMode !== want) continue;
        if ((r.players || 0) >= MAX_PLAYERS) continue;
        if (Date.now() - (r.updatedAt || 0) > 20000) continue;
        return r.code;
      }
      const code = this.makeCode(reg);
      reg.rooms[code] = {
        code, isPublic: true, mode: 'online', status: 'lobby', gameMode: want,
        players: 0, connected: 0, humans: 0, humansHere: 0, bots: 0,
        opening: true, updatedAt: Date.now(), names: []
      };
      await this.saveRegistry(reg);
      return code;
    }
    if (msg.type === 'create_room') {
      const code = this.makeCode(reg);
      const settings = msg.settings || {};
      const gameMode = settings.gameMode === 'inflation' ? 'inflation' : 'classic';
      reg.rooms[code] = {
        code, isPublic: false, mode: msg.mode === 'pass' ? 'pass' : 'online', status: 'lobby',
        gameMode, preset: settings.preset || 'standard',
        players: 0, connected: 0, opening: true, updatedAt: Date.now(), names: []
      };
      await this.saveRegistry(reg);
      return code;
    }
    return null;
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); }
    catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'heartbeat' || msg.type === 'presence') {
      try { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); } catch (e) { /* gone */ }
      return;
    }
    if (msg.type === 'create_room' || msg.type === 'quick_join' || msg.type === 'join_room' || msg.type === 'rejoin') {
      const code = await this.allocate(msg);
      if (!code) {
        ws.send(JSON.stringify({ type: 'error', message: msg.type === 'create_room' || msg.type === 'quick_join' ? 'Type your display name first.' : 'No room with that code. Check the code and try again.' }));
        return;
      }
      ws.send(JSON.stringify({ type: 'switch_room', code, entry: msg.type }));
      return;
    }
    ws.send(JSON.stringify({ type: 'error', message: 'Join a room first.' }));
  }

  async webSocketClose() { /* the lobby holds no table */ }

  async ops(request, url) {
    const route = OPS_ROUTES.has(url.pathname) ? url.pathname : null;
    const headers = {
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'private, no-store'
    };
    if (!route) return new Response('Not found', { status: 404, headers });
    const leaked = ['token', 'key', 'password', 'secret', 'kp_admin_token'].some((k) => url.searchParams.has(k));
    if (leaked) {
      return json({ ok: false, error: 'query', message: 'The key does not travel in the address.' }, 400, headers);
    }
    const token = String(this.env.KP_ADMIN_TOKEN || '').trim();
    if (!token) {
      if (request.method === 'GET' && route === '/ops') {
        const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow, noarchive"><title>Kolopoly ops</title></head><body><article><h1>Ops desk</h1><p id="locked">' + LOCKED_MESSAGE + '</p></article></body></html>';
        return new Response(html, { status: 503, headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers) });
      }
      return json({ ok: false, error: 'locked', message: LOCKED_MESSAGE }, 503, headers);
    }
    if (request.method === 'GET' && route === '/ops/desk.css') {
      return new Response(deskCss, { status: 200, headers: Object.assign({ 'Content-Type': 'text/css; charset=utf-8' }, headers) });
    }
    if (request.method === 'GET' && route === '/ops/desk.js') {
      return new Response(deskJs, { status: 200, headers: Object.assign({ 'Content-Type': 'text/javascript; charset=utf-8' }, headers) });
    }
    if (request.method === 'GET' && route === '/ops') {
      const page = String(deskHtml).replace('data-error=""', 'data-error=""');
      return new Response(page, { status: 200, headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers) });
    }
    const authState = (await this.state.storage.get('opsAuth')) || { sessionGen: 0, buckets: {}, global: { n: 0, windowEnd: 0, lockedUntil: 0 } };
    const saveAuth = () => this.state.storage.put('opsAuth', authState);
    const keyOf = () => {
      const xff = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim().slice(0, 64);
      const cf = String(request.headers.get('cf-connecting-ip') || '');
      return cf + '|' + xff;
    };
    const now = Date.now();
    function sweep() {
      const g = authState.global;
      if (g.windowEnd && now > g.windowEnd && !g.lockedUntil) { g.n = 0; g.windowEnd = 0; }
      if (g.lockedUntil && now > g.lockedUntil) { g.n = 0; g.windowEnd = 0; g.lockedUntil = 0; }
      for (const k of Object.keys(authState.buckets)) {
        const bucket = authState.buckets[k];
        const ended = bucket.lockedUntil ? now > bucket.lockedUntil : now > bucket.windowEnd;
        if (ended) delete authState.buckets[k];
      }
    }
    function rateLimited(key) {
      sweep();
      if (authState.global.lockedUntil && now < authState.global.lockedUntil) return true;
      const bucket = authState.buckets[key];
      return !!(bucket && bucket.lockedUntil && now < bucket.lockedUntil);
    }
    function recordFail(key) {
      sweep();
      let bucket = authState.buckets[key];
      if (!bucket) bucket = { n: 0, windowEnd: now + FAIL_WINDOW_MS, lockedUntil: 0 };
      bucket.n += 1;
      if (bucket.n >= FAIL_LIMIT) bucket.lockedUntil = bucket.lockedUntil || (now + FAIL_WINDOW_MS);
      authState.buckets[key] = bucket;
      if (!authState.global.windowEnd || now > authState.global.windowEnd) {
        authState.global.n = 0;
        authState.global.windowEnd = now + FAIL_WINDOW_MS;
        authState.global.lockedUntil = 0;
      }
      authState.global.n += 1;
      if (authState.global.n >= GLOBAL_LIMIT) authState.global.lockedUntil = authState.global.lockedUntil || (now + FAIL_WINDOW_MS);
    }
    async function sessionValid(raw) {
      const parts = String(raw || '').split('.');
      if (parts.length !== 2) return false;
      const mac = await sessionMac(token, parts[0]);
      const a = b64urlToBytes(mac);
      let b;
      try { b = b64urlToBytes(parts[1]); } catch (e) { return false; }
      if (!sameBytes(a, b)) return false;
      let payload;
      try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))); }
      catch (e) { return false; }
      return !!(payload && payload.g === authState.sessionGen && typeof payload.e === 'number' && payload.e > Date.now());
    }
    function readCookie(name) {
      const raw = String(request.headers.get('cookie') || '');
      for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
      }
      return '';
    }
    const bearer = (/^Bearer\s+(\S+)$/i.exec(String(request.headers.get('authorization') || '')) || [])[1] || '';
    async function authed() {
      if (!bearer && !readCookie('kp_ops')) return false;
      if (bearer && (await sessionValid(bearer) || await tokenMatches(bearer, token))) return true;
      if (readCookie('kp_ops') && await sessionValid(readCookie('kp_ops'))) return true;
      return false;
    }
    if (request.method === 'POST' && route === '/ops/unlock') {
      const who = keyOf();
      if (rateLimited(who)) {
        await saveAuth();
        return json({ ok: false, error: 'locked', message: 'Too many tries. The desk is quiet for a while.' }, 429, headers);
      }
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      const given = body && typeof body.token === 'string' ? body.token : '';
      if (!(await tokenMatches(given, token))) {
        recordFail(who);
        await saveAuth();
        return json({ ok: false, error: 'unauthorized', message: 'That key no open this desk.' }, 401, headers);
      }
      delete authState.buckets[who];
      const payload = b64url(new TextEncoder().encode(JSON.stringify({ e: Date.now() + SESSION_MS, g: authState.sessionGen, n: randomHex(8) })));
      const cookie = payload + '.' + await sessionMac(token, payload);
      await saveAuth();
      const host = String(request.headers.get('host') || '');
      const proto = String(request.headers.get('x-forwarded-proto') || '');
      const local = host.startsWith('localhost') || host.startsWith('127.0.0.1');
      const secure = proto === 'https' || (!local && !host.startsWith('127.'));
      const bits = ['kp_ops=' + cookie, 'HttpOnly', 'SameSite=Strict', 'Path=/ops', 'Max-Age=' + Math.floor(SESSION_MS / 1000)];
      if (secure) bits.push('Secure');
      return json({ ok: true }, 200, Object.assign({ 'Set-Cookie': bits.join('; ') }, headers));
    }
    if (request.method === 'POST' && route === '/ops/lock') {
      if (!(await authed())) return json({ ok: false, error: 'unauthorized' }, 401, headers);
      authState.sessionGen += 1;
      await saveAuth();
      return json({ ok: true }, 200, Object.assign({ 'Set-Cookie': 'kp_ops=; HttpOnly; SameSite=Strict; Path=/ops; Max-Age=0' }, headers));
    }
    if (request.method === 'GET' && route === '/ops/snapshot') {
      if (!(await authed())) return json({ ok: false, error: 'unauthorized', message: 'That key no open this desk.' }, 401, headers);
      const reg = await this.registry();
      const shelfRes = await this.env.RETENTION.get(this.env.RETENTION.idFromName('shelf')).fetch('https://retention.internal/summary');
      const shelf = await shelfRes.json();
      const rows = Object.values(reg.rooms || {}).filter((r) => r && r.code && !r.opening);
      return json(scrub(assembleSnapshot(rows, shelf, reg.bootAt), token), 200, headers);
    }
    return json({ ok: false, error: 'method' }, 405, headers);
  }
}

export class RetentionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (!isTest(this.env)) {
      const alarm = await this.state.storage.getAlarm();
      if (alarm == null) await this.state.storage.setAlarm(Date.now() + 15 * 60 * 1000);
    }
    return this.withShelf(async (shelf) => {
      if (url.pathname === '/load') return json(shelf.exportDb());
      if (url.pathname === '/summary') return json(shelf.opsSummary());
      if (url.pathname === '/apply' && request.method === 'POST') {
        const ops = await request.json();
        await shelf.applyOps(ops);
        return json({ ok: true });
      }
      return shelf.handleFetch(request);
    });
  }
  async alarm() {
    await this.withShelf(async (shelf) => { await shelf.sweepDrops(); });
    if (!isTest(this.env)) await this.state.storage.setAlarm(Date.now() + 15 * 60 * 1000);
  }
  async withShelf(fn) {
    const saved = await this.state.storage.get('db');
    const shelf = createRetention({
      memory: true,
      db: saved || null,
      test: isTest(this.env),
      env: this.env,
      push
    });
    const response = await fn(shelf);
    await this.state.storage.put('db', shelf.exportDb());
    return response;
  }
}

async function serveStamped(request, env, pathname) {
  const build = await computeBuild(env);
  const assetPath = pathname === '/' ? '/index.html' : pathname;
  const asset = await env.ASSETS.fetch(new Request('https://assets.local' + assetPath));
  if (!asset.ok) return asset;
  let text = await asset.text();
  if (pathname === '/' || pathname === '/index.html') {
    text = text.split('__KOLOPOLY_BUILD__').join(build);
    if (!text.includes('KOLOPOLY_EDGE')) {
      text = text.replace('</head>', '<script>window.KOLOPOLY_EDGE=1</script></head>');
    }
    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }
    });
  }
  text += '\n// kolopoly-build ' + build + '\n';
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.headers.get('Upgrade') === 'websocket') {
      if (path === '/lobby' || path === '/') {
        return env.LOBBY.get(env.LOBBY.idFromName('global')).fetch(request);
      }
      const roomMatch = path.match(/^\/room\/([A-Za-z]{4})\/?$/);
      if (roomMatch) {
        const code = roomMatch[1].toUpperCase();
        const routed = new URL(request.url);
        routed.pathname = '/room/' + code;
        return env.ROOM.get(env.ROOM.idFromName(code)).fetch(new Request(routed.toString(), request));
      }
      return new Response('Use /lobby or /room/CODE', { status: 404 });
    }
    if (path === '/api/version') {
      try {
        const build = await computeBuild(env);
        return json({ ok: true, build, edge: true });
      } catch (e) {
        return json({ ok: false, error: 'build' }, 500);
      }
    }
    if (path === '/api/records') {
      try {
        const data = await createRecords(env).getRecords();
        return json(data);
      } catch (e) {
        return json({ enabled: false, matches: [], landlords: [] });
      }
    }
    if (path.startsWith('/api/room/')) {
      const code = path.slice('/api/room/'.length).trim().toUpperCase().slice(0, 4);
      if (!/^[A-Z]{4}$/.test(code)) return json({ exists: false });
      const routed = new URL(request.url);
      routed.pathname = '/api/room/' + code;
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(new Request(routed.toString(), request));
    }
    if (path.startsWith('/api/retention') || path.startsWith('/api/push') || path.startsWith('/api/test/')) {
      return env.RETENTION.get(env.RETENTION.idFromName('shelf')).fetch(request);
    }
    if (path === '/ops' || path.startsWith('/ops/')) {
      return env.LOBBY.get(env.LOBBY.idFromName('global')).fetch(request);
    }
    if (path === '/' || path === '/index.html' || path === '/sw.js') return serveStamped(request, env, path);
    return env.ASSETS.fetch(request);
  }
};
