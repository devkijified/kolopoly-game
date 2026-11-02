import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

const openSockets = [];
afterEach(() => {
  while (openSockets.length) {
    const ws = openSockets.pop();
    try { ws.close(); } catch (e) { /* already closed */ }
  }
});

function openSocket() {
  const q = [];
  const pending = [];
  return {
    q,
    push(msg) {
      if (pending.length) pending.shift()(msg);
      else q.push(msg);
    },
    next() {
      if (q.length) return Promise.resolve(q.shift());
      return new Promise((resolve) => pending.push(resolve));
    },
    async until(pred, label) {
      const start = Date.now();
      const seen = [];
      while (Date.now() - start < 8000) {
        const msg = await this.next();
        seen.push(msg.type);
        if (pred(msg)) return msg;
      }
      throw new Error((label || 'timeout') + ' saw ' + seen.join(','));
    }
  };
}

async function seat(path) {
  const res = await SELF.fetch('http://kolopoly.test' + path, {
    headers: { Upgrade: 'websocket' }
  });
  if (!res.webSocket) throw new Error('no websocket for ' + path + ' status ' + res.status);
  const ws = res.webSocket;
  openSockets.push(ws);
  ws.accept();
  const box = openSocket();
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
    box.push(JSON.parse(raw));
  });
  box.ws = ws;
  box.send = (obj) => ws.send(JSON.stringify(obj));
  return box;
}

async function enter(kind, payload) {
  const lobby = await seat('/lobby');
  lobby.send(Object.assign({ type: kind }, payload));
  const switched = await lobby.until((m) => m.type === 'switch_room', 'switch');
  const table = await seat('/room/' + switched.code);
  table.send(Object.assign({ type: kind }, payload));
  const joined = await table.until((m) => m.type === 'joined', 'joined');
  const state = await table.until((m) => m.type === 'state' && m.room, 'state');
  table.code = switched.code;
  table.playerId = joined.playerId;
  table.token = joined.token;
  table.room = state.room;
  table.note = (msg) => { if (msg.type === 'state') table.room = msg.room; };
  const prev = table.until.bind(table);
  table.until = async (pred, label) => {
    const msg = await prev(pred, label);
    table.note(msg);
    return msg;
  };
  return table;
}

const classic = {
  gameMode: 'classic',
  timed: false,
  turnTimerSec: 30
};
const inflation = {
  gameMode: 'inflation',
  preset: 'quick',
  timed: false,
  turnTimerSec: 30
};

describe('worker table', () => {
  it('stamps the build and keeps the service worker uncached', async () => {
    const ver = await (await SELF.fetch('http://kolopoly.test/api/version')).json();
    expect(ver.ok).toBe(true);
    expect(ver.edge).toBe(true);
    expect(ver.build).toMatch(/^[a-f0-9]{12}$/);
    const home = await SELF.fetch('http://kolopoly.test/');
    const html = await home.text();
    expect(html).toContain('content="' + ver.build + '"');
    expect(html).toContain('KOLOPOLY_EDGE');
    expect(html).not.toContain('__KOLOPOLY_BUILD__');
    const sw = await SELF.fetch('http://kolopoly.test/sw.js');
    expect(sw.headers.get('cache-control')).toContain('no-store');
    expect(await sw.text()).toContain('kolopoly-build ' + ver.build);
    const records = await (await SELF.fetch('http://kolopoly.test/api/records')).json();
    expect(records.enabled).toBe(false);
    expect(records.matches).toEqual([]);
  });

  it('plays a two-player Classic game, then reconnects after the object is evicted', async () => {
    const ada = await enter('create_room', {
      name: 'Ada', token: 'danfo', mode: 'online', clientId: 'worker-ada-classic', settings: classic
    });
    const bola = await seat('/room/' + ada.code);
    bola.send({ type: 'join_room', code: ada.code, name: 'Bola', token: 'keke', clientId: 'worker-bola-classic' });
    await bola.until((m) => m.type === 'joined', 'bola joined');
    await ada.until((m) => m.type === 'state' && m.room.players.length === 2, 'both seated');
    ada.send({ type: 'start_game' });
    let playing = await ada.until((m) => m.type === 'state' && m.room.status === 'playing', 'classic started');
    expect(playing.room.settings.gameMode).toBe('classic');
    const turn = playing.room.turnPlayerId;
    const actor = turn === ada.playerId ? ada : bola;
    actor.send({ type: 'test_set_position', playerId: turn, space: 17 });
    actor.send({ type: 'test_dice', rolls: [[1, 2]] });
    actor.send({ type: 'roll' });
    const moved = await ada.until((m) => m.type === 'state' && m.room.players.find((p) => p.id === turn).position === 20, 'rolled to 20');
    expect(moved.room.players.find((p) => p.id === turn).position).toBe(20);

    await env.ROOM.get(env.ROOM.idFromName(ada.code)).fetch('http://room.internal/evict?code=' + ada.code);
    ada.send({ type: 'test_set_cash', playerId: ada.playerId, amount: 1234567 });
    const after = await ada.until((m) => {
      if (m.type !== 'state') return false;
      const row = m.room.players.find((p) => p.id === ada.playerId);
      return row && row.cash === 1234567 && m.room.players.find((p) => p.id === turn).position === 20;
    }, 'state survived eviction');
    expect(after.room.code).toBe(ada.code);

    ada.ws.close();
    const back = await seat('/room/' + ada.code);
    back.send({ type: 'rejoin', code: ada.code, playerId: ada.playerId, token: ada.token });
    const rejoined = await back.until((m) => m.type === 'joined' && m.rejoined, 'rejoined');
    expect(rejoined.playerId).toBe(ada.playerId);
    const restored = await back.until((m) => m.type === 'state' && m.room.players.find((p) => p.id === ada.playerId).cash === 1234567, 'cash held');
    expect(restored.room.players.find((p) => p.id === turn).position).toBe(20);

    const stranger = await seat('/room/' + ada.code);
    stranger.send({ type: 'rejoin', code: ada.code, playerId: ada.playerId, token: 'not-the-token' });
    const failed = await stranger.until((m) => m.type === 'rejoin_failed', 'bad token');
    expect(failed.type).toBe('rejoin_failed');
  });

  it('plays a two-player Inflation game and lets an alarm roll a stalled turn', async () => {
    const ada = await enter('create_room', {
      name: 'Ada', token: 'danfo', mode: 'online', clientId: 'worker-ada-inf', settings: inflation
    });
    const bola = await seat('/room/' + ada.code);
    bola.send({ type: 'join_room', code: ada.code, name: 'Bola', token: 'keke', clientId: 'worker-bola-inf' });
    await bola.until((m) => m.type === 'joined', 'bola joined');
    await ada.until((m) => m.type === 'state' && m.room.players.length === 2, 'both seated');
    ada.send({ type: 'start_game' });
    const playing = await ada.until((m) => m.type === 'state' && m.room.status === 'playing' && m.room.inf, 'inflation started');
    expect(playing.room.settings.gameMode).toBe('inflation');
    expect(playing.room.inf.phase).toBe(1);
    expect(playing.room.inf.salary).toBe(200000);
    const turn = playing.room.turnPlayerId;
    const actor = turn === ada.playerId ? ada : bola;
    actor.send({ type: 'test_deadline_in', seconds: 0 });
    await ada.until((m) => m.type === 'state', 'deadline stored');
    await env.ROOM.get(env.ROOM.idFromName(ada.code)).fetch('http://room.internal/alarm?code=' + ada.code);
    const rolled = await ada.until((m) => m.type === 'state' && m.room.dice && m.room.turnPlayerId === turn && m.room.phase !== 'roll', 'alarm rolled');
    expect(rolled.room.dice.length).toBe(2);
  });

  it('turns an idle seat into an AFK bot from the alarm', async () => {
    const ada = await enter('create_room', {
      name: 'Ada', token: 'danfo', mode: 'online', clientId: 'worker-ada-afk', settings: classic
    });
    const bola = await seat('/room/' + ada.code);
    bola.send({ type: 'join_room', code: ada.code, name: 'Bola', token: 'keke', clientId: 'worker-bola-afk' });
    await bola.until((m) => m.type === 'joined', 'bola joined');
    const both = await ada.until((m) => m.type === 'state' && m.room.players.length === 2, 'both seated');
    const bolaId = both.room.players.find((p) => p.name === 'Bola').id;
    ada.send({ type: 'start_game' });
    await ada.until((m) => m.type === 'state' && m.room.status === 'playing', 'started');
    ada.send({ type: 'test_idle_for', playerId: bolaId, ms: 9000 });
    await ada.until((m) => m.type === 'state', 'idle marked');
    await env.ROOM.get(env.ROOM.idFromName(ada.code)).fetch('http://room.internal/alarm?code=' + ada.code);
    const taken = await ada.until((m) => {
      if (m.type !== 'state') return false;
      const row = m.room.players.find((p) => p.id === bolaId);
      return row && row.bot && row.afkTaken;
    }, 'afk bot');
    expect(taken.room.players.find((p) => p.id === bolaId).bot).toBe(true);
  });

  it('matches quick_join only inside the mode the player picked', async () => {
    const classicHost = await enter('quick_join', {
      name: 'ClassicHost', token: 'danfo', clientId: 'worker-quick-classic-1', gameMode: 'classic'
    });
    expect(classicHost.room.isPublic).toBe(true);
    expect(classicHost.room.settings.gameMode).toBe('classic');

    const infLobby = await seat('/lobby');
    infLobby.send({ type: 'quick_join', name: 'InfPlayer', token: 'keke', clientId: 'worker-quick-inf-1', gameMode: 'inflation' });
    const infSwitch = await infLobby.until((m) => m.type === 'switch_room', 'inf switch');
    expect(infSwitch.code).not.toBe(classicHost.code);
    const inf = await seat('/room/' + infSwitch.code);
    inf.send({ type: 'quick_join', name: 'InfPlayer', token: 'keke', clientId: 'worker-quick-inf-1', gameMode: 'inflation' });
    await inf.until((m) => m.type === 'joined', 'inf joined');
    const infState = await inf.until((m) => m.type === 'state' && m.room.settings, 'inf state');
    expect(infState.room.settings.gameMode).toBe('inflation');
    expect(infState.room.code).not.toBe(classicHost.code);

    const inf2Lobby = await seat('/lobby');
    inf2Lobby.send({ type: 'quick_join', name: 'InfTwo', token: 'okada', clientId: 'worker-quick-inf-2', gameMode: 'inflation' });
    const inf2Switch = await inf2Lobby.until((m) => m.type === 'switch_room', 'inf2 switch');
    expect(inf2Switch.code).toBe(infSwitch.code);
    const inf2 = await seat('/room/' + inf2Switch.code);
    inf2.send({ type: 'quick_join', name: 'InfTwo', token: 'okada', clientId: 'worker-quick-inf-2', gameMode: 'inflation' });
    const inf2State = await inf2.until((m) => m.type === 'state' && m.room.players.length === 2, 'second inflation seat');
    expect(inf2State.room.code).toBe(infSwitch.code);
    expect(inf2State.room.settings.gameMode).toBe('inflation');

    const bare = await seat('/lobby');
    bare.send({ type: 'quick_join', name: 'Bare', token: 'boot', clientId: 'worker-quick-bare-1' });
    const bareSwitch = await bare.until((m) => m.type === 'switch_room', 'bare switch');
    expect(bareSwitch.code).toBe(infSwitch.code);
  });

  it('stores a whisper subscription and signs a VAPID roundtrip', async () => {
    const vapid = await (await SELF.fetch('http://kolopoly.test/api/push/vapid')).json();
    expect(vapid.ok).toBe(true);
    expect(vapid.enabled).toBe(true);
    expect(typeof vapid.publicKey).toBe('string');
    expect(vapid.publicKey.length).toBeGreaterThan(20);
    const round = await SELF.fetch('http://kolopoly.test/api/test/push-roundtrip');
    expect(round.status).toBe(200);
    const sub = await SELF.fetch('http://kolopoly.test/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'worker-push-client1',
        name: 'Ngozi',
        subscription: {
          endpoint: 'https://push.example.test/kolopoly/abc',
          keys: { p256dh: 'BPmLNqxC-7aovOAqIT1X80', auth: 'dGVzdC1hdXRoLWtleQ' }
        }
      })
    });
    const saved = await sub.json();
    expect(sub.status).toBe(200);
    expect(saved.subscribed).toBe(true);
    const shelf = await (await SELF.fetch('http://kolopoly.test/api/retention?clientId=worker-push-client1')).json();
    expect(shelf.push.subscribed).toBe(true);
    expect(shelf.push.publicKey).toBe(vapid.publicKey);
    expect(JSON.stringify(shelf)).not.toContain('privateKey');
  });

  it('opens the ops desk with the house key and lists a live table', async () => {
    const ada = await enter('create_room', {
      name: 'Ada', token: 'danfo', mode: 'online', clientId: 'worker-ada-ops', settings: classic
    });
    expect(ada.room.code).toMatch(/^[A-Z]{4}$/);
    const locked = await SELF.fetch('http://kolopoly.test/ops/snapshot');
    expect(locked.status).toBe(401);
    const bad = await SELF.fetch('http://kolopoly.test/ops/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'nope' })
    });
    expect(bad.status).toBe(401);
    const opened = await SELF.fetch('http://kolopoly.test/ops/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ token: 'test-house-key' })
    });
    expect(opened.status).toBe(200);
    const cookie = opened.headers.get('set-cookie') || '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/ops');
    expect(cookie).not.toContain('Secure');
    const page = await (await SELF.fetch('http://kolopoly.test/ops')).text();
    expect(page).toContain('House key');
    expect(page).toContain('noindex');
    expect(page).not.toContain('test-house-key');
    let body = null;
    let snapStatus = 0;
    const start = Date.now();
    while (Date.now() - start < 4000) {
      const snap = await SELF.fetch('http://kolopoly.test/ops/snapshot', {
        headers: { cookie: cookie.split(';')[0] }
      });
      snapStatus = snap.status;
      body = await snap.json();
      if (body && body.rooms && body.rooms.some((r) => r.code === ada.room.code)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(snapStatus).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.live.rooms).toBeGreaterThan(0);
    expect(body.rooms.some((r) => r.code === ada.room.code)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('test-house-key');
    expect(JSON.stringify(body)).not.toContain('worker-ada-ops');
  });
});
