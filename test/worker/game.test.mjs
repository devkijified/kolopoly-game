import { env, runInDurableObject, SELF } from 'cloudflare:test';
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
    actor.send({ type: 'test_set_position', playerId: turn, space: 13 });
    actor.send({ type: 'test_dice', rolls: [[1, 2]] });
    actor.send({ type: 'roll' });
    const moved = await ada.until((m) => m.type === 'state' && m.room.players.find((p) => p.id === turn).position === 16, 'rolled to 16');
    expect(moved.room.players.find((p) => p.id === turn).position).toBe(16);

    await env.ROOM.get(env.ROOM.idFromName(ada.code)).fetch('http://room.internal/evict?code=' + ada.code);
    ada.send({ type: 'test_set_cash', playerId: ada.playerId, amount: 1234567 });
    const after = await ada.until((m) => {
      if (m.type !== 'state') return false;
      const row = m.room.players.find((p) => p.id === ada.playerId);
      return row && row.cash === 1234567 && m.room.players.find((p) => p.id === turn).position === 16;
    }, 'state survived eviction');
    expect(after.room.code).toBe(ada.code);

    ada.ws.close();
    const back = await seat('/room/' + ada.code);
    back.send({ type: 'rejoin', code: ada.code, playerId: ada.playerId, token: ada.token });
    const rejoined = await back.until((m) => m.type === 'joined' && m.rejoined, 'rejoined');
    expect(rejoined.playerId).toBe(ada.playerId);
    const restored = await back.until((m) => m.type === 'state' && m.room.players.find((p) => p.id === ada.playerId).cash === 1234567, 'cash held');
    expect(restored.room.players.find((p) => p.id === turn).position).toBe(16);

    const stranger = await seat('/room/' + ada.code);
    stranger.send({ type: 'rejoin', code: ada.code, playerId: ada.playerId, token: 'not-the-token' });
    const failed = await stranger.until((m) => m.type === 'rejoin_failed', 'bad token');
    expect(failed.type).toBe('rejoin_failed');
  });

  it('plays a two-player Inflation game and lets an alarm skip a stalled turn with the missed turn fee', async () => {
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
    const skipped = await ada.until((m) => m.type === 'state' && m.room.turnPlayerId !== turn && m.room.missedTurn, 'alarm skipped the stalled turn');
    expect(skipped.room.missedTurn.playerId).toBe(turn);
    expect(skipped.room.missedTurn.fee).toBe(25000);
    expect(skipped.room.players.find((p) => p.id === turn).cash).toBe(1500000 - 25000);
    expect(skipped.room.pot).toBe(25000);
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

describe('worker ops competition ladder', () => {
  const bearer = { Authorization: 'Bearer test-house-key' };
  async function readLadder() {
    const res = await SELF.fetch('http://kolopoly.test/ops/competition', { headers: bearer });
    return { status: res.status, body: await res.json() };
  }

  it('serves the seeded ladder and the exact money table behind the house key', async () => {
    const locked = await SELF.fetch('http://kolopoly.test/ops/competition');
    expect(locked.status).toBe(401);
    const { status, body } = await readLadder();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.settings.cities).toHaveLength(6);
    const summit = body.settings.cities.find((c) => c.flagship);
    expect(summit.city).toBe('Aso Rock, Abuja');
    expect(summit.fee).toBe(25000);
    expect(body.settings.splits['2']).toBe(80);
    expect(body.settings.splits['6']).toBe(60);
    const lagos = body.table.find((row) => row.id === 'lagos');
    const six = lagos.sizes.find((s) => s.players === 6);
    expect(six.pot).toBe(30000);
    expect(six.winner).toBe(18000);
    expect(six.house).toBe(12000);
    const ibadan = body.table.find((row) => row.id === 'ibadan');
    const two = ibadan.sizes.find((s) => s.players === 2);
    expect(two.pot).toBe(400);
    expect(two.winner).toBe(320);
    expect(two.house).toBe(80);
    expect(JSON.stringify(body)).not.toContain('test-house-key');
  });

  it('refuses a bad save and keeps a clean one', async () => {
    const { body } = await readLadder();
    const edited = JSON.parse(JSON.stringify(body.settings));
    edited.cities.find((c) => c.id === 'kano').fee = 1500;
    const bad = JSON.parse(JSON.stringify(edited));
    bad.splits['3'] = 95;
    const badRes = await SELF.fetch('http://kolopoly.test/ops/competition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer },
      body: JSON.stringify(bad)
    });
    expect(badRes.status).toBe(400);
    const badFee = JSON.parse(JSON.stringify(edited));
    badFee.cities.find((c) => c.id === 'kano').fee = -5;
    const badFeeRes = await SELF.fetch('http://kolopoly.test/ops/competition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer },
      body: JSON.stringify(badFee)
    });
    expect(badFeeRes.status).toBe(400);
    const saved = await SELF.fetch('http://kolopoly.test/ops/competition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer },
      body: JSON.stringify(edited)
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    expect(savedBody.saved).toBe(true);
    const reread = await readLadder();
    expect(reread.body.saved).toBe(true);
    expect(reread.body.settings.cities.find((c) => c.id === 'kano').fee).toBe(1500);
    const kano = reread.body.table.find((row) => row.id === 'kano');
    const kanoFour = kano.sizes.find((s) => s.players === 4);
    expect(kanoFour.pot).toBe(6000);
    expect(kanoFour.winner).toBe(4200);
    expect(kanoFour.house).toBe(1800);
  });
});

describe('worker inflation: seven phases, lifeline and snapshots', () => {
  it('opens an Inflation room on Standard with a deadline, and test hooks move the phase', async () => {
    const ada = await enter('create_room', {
      name: 'Ada', token: 'danfo', mode: 'online', clientId: 'worker-ada-inf7', settings: inflation
    });
    const bola = await seat('/room/' + ada.code);
    bola.send({ type: 'join_room', code: ada.code, name: 'Bola', token: 'keke', clientId: 'worker-bola-inf7' });
    await bola.until((m) => m.type === 'joined', 'bola joined');
    await ada.until((m) => m.type === 'state' && m.room.players.length === 2, 'both seated');
    ada.send({ type: 'start_game' });
    const playing = await ada.until((m) => m.type === 'state' && m.room.status === 'playing' && m.room.inf, 'inflation started');
    expect(playing.room.inf.phase).toBe(1);
    expect(playing.room.inf.phaseName).toBe('Standard');
    expect(playing.room.inf.salary).toBe(200000);
    expect(playing.room.inf.nextPhaseName).toBe('Squeeze');
    expect(typeof playing.room.inf.deadlineAt).toBe('number');
    expect(playing.room.inf.deadlineAt).toBeGreaterThan(playing.room.inf.phaseEndsAt);
    // The vitest bindings set KP_TEST=1, so the scripted hooks are live in
    // this harness. The production build gates the same hooks on isTest(env)
    // in worker.js, so they stay shut outside test mode.
    ada.send({ type: 'test_phase', phase: 2 });
    const squeezed = await ada.until((m) => m.type === 'state' && m.room.inf && m.room.inf.phase === 2, 'squeeze by hook');
    expect(squeezed.room.inf.phaseName).toBe('Squeeze');
    expect(squeezed.room.inf.salary).toBe(140000);
  });

  it('charges Squeeze rent at printed times the lower die through the Lifeline bill', async () => {
    const ada = await enter('create_room', {
      name: 'Ada', token: 'danfo', mode: 'online', clientId: 'worker-ada-inf7r', settings: inflation
    });
    const bola = await seat('/room/' + ada.code);
    bola.send({ type: 'join_room', code: ada.code, name: 'Bola', token: 'keke', clientId: 'worker-bola-inf7r' });
    await bola.until((m) => m.type === 'joined', 'bola joined');
    await ada.until((m) => m.type === 'state' && m.room.players.length === 2, 'both seated');
    ada.send({ type: 'start_game' });
    const playing = await ada.until((m) => m.type === 'state' && m.room.status === 'playing' && m.room.inf, 'inflation started');
    const turn = playing.room.turnPlayerId;
    const buyer = turn === ada.playerId ? ada : bola;
    const tenant = turn === ada.playerId ? bola : ada;
    const tenantId = playing.room.players.find((p) => p.id !== turn).id;
    buyer.send({ type: 'test_set_position', playerId: turn, space: 5 });
    buyer.send({ type: 'test_dice', rolls: [[1, 2]] });
    buyer.send({ type: 'roll' });
    await ada.until((m) => m.type === 'state' && m.room.phase === 'buy' && m.room.buySpace === 8, 'surulere offered');
    buyer.send({ type: 'buy' });
    await ada.until((m) => m.type === 'state' && m.room.props[8].o === turn, 'surulere bought');
    buyer.send({ type: 'end_turn' });
    await ada.until((m) => m.type === 'state' && m.room.turnPlayerId === tenantId && m.room.phase === 'roll', 'tenant to roll');
    ada.send({ type: 'test_phase', phase: 2 });
    await ada.until((m) => m.type === 'state' && m.room.inf.phase === 2, 'squeeze');
    tenant.send({ type: 'test_set_position', playerId: tenantId, space: 1 });
    tenant.send({ type: 'test_dice', rolls: [[2, 5]] });
    tenant.send({ type: 'roll' });
    const billed = await ada.until((m) => m.type === 'state' && m.room.pendingBill && m.room.pendingBill.playerId === tenantId, 'lifeline bill');
    expect(billed.room.pendingBill.printed).toBe(24000);
    expect(billed.room.pendingBill.mult).toBe(2);
    expect(billed.room.pendingBill.amount).toBe(48000);
    const ownerBefore = billed.room.players.find((p) => p.id === turn).cash;
    const tenantBefore = billed.room.players.find((p) => p.id === tenantId).cash;
    tenant.send({ type: 'lifeline_skip', billId: billed.room.pendingBill.id, id: billed.room.pendingBill.id });
    const settled = await ada.until((m) => m.type === 'state' && !m.room.pendingBill
      && m.room.players.find((p) => p.id === turn).cash === ownerBefore + 48000, 'rent settled');
    expect(settled.room.players.find((p) => p.id === tenantId).cash).toBe(tenantBefore - 48000);
  });

  it('imports an old shape snapshot with defaults and the game continues', async () => {
    const ada = await enter('create_room', {
      name: 'Ada', token: 'danfo', mode: 'online', clientId: 'worker-ada-inf7s', settings: inflation
    });
    const bola = await seat('/room/' + ada.code);
    bola.send({ type: 'join_room', code: ada.code, name: 'Bola', token: 'keke', clientId: 'worker-bola-inf7s' });
    await bola.until((m) => m.type === 'joined', 'bola joined');
    await ada.until((m) => m.type === 'state' && m.room.players.length === 2, 'both seated');
    ada.send({ type: 'start_game' });
    await ada.until((m) => m.type === 'state' && m.room.status === 'playing' && m.room.inf, 'inflation started');
    ada.send({ type: 'test_set_cash', playerId: ada.playerId, amount: 1234567 });
    await ada.until((m) => m.type === 'state' && m.room.players.find((p) => p.id === ada.playerId).cash === 1234567, 'state persisted');
    // Rewrite the live table into the pre upgrade shape: the phase sits in
    // inf with a horn timestamp and no version marker, there is no
    // deadlineAt, and the player rows carry no Lifeline or Hustle fields.
    // Eviction then exports exactly this shape to storage, and the next
    // wake imports it, which is the path an old snapshot would travel.
    const stub = env.ROOM.get(env.ROOM.idFromName(ada.code));
    await runInDurableObject(stub, async (instance) => {
      expect(instance.host).toBeTruthy();
      const rooms = [...instance.host.rooms.values()];
      expect(rooms.length).toBe(1);
      const room = rooms[0];
      room.inf.phase = 2;
      room.inf.hornAt = Date.now() + 600000;
      delete room.inf.v;
      delete room.inf.deadlineAt;
      for (const p of room.players) {
        delete p.lifelineUsed;
        delete p.hustleAttempts;
        delete p.lastHustledPhase;
      }
      // The snapshot is also a 40 space board. The other seat owns old
      // Yaba (13) and old Parkview Estate (37, gone on board20).
      const other = room.players.find((p) => p.id !== room.turnPlayerId);
      delete room.boardSize;
      const legacy = [1, 3, 5, 6, 8, 9, 11, 12, 13, 14, 15, 16, 18, 19, 21, 23, 24, 25, 26, 27, 28, 29, 31, 32, 34, 35, 37, 39];
      room.props = {};
      for (const i of legacy) room.props[i] = { owner: null, mortgaged: false, buildings: 0, mansionLap: -1, pledged: null };
      room.props[13].owner = other.id;
      room.props[37].owner = other.id;
      for (const p of room.players) p.position = 0;
    });
    await stub.fetch('http://room.internal/evict?code=' + ada.code);
    ada.send({ type: 'test_set_cash', playerId: ada.playerId, amount: 7654321 });
    const restored = await ada.until((m) => m.type === 'state'
      && m.room.players.find((p) => p.id === ada.playerId).cash === 7654321, 'restored after eviction');
    expect(restored.room.inf.phase).toBe(2);
    expect(Object.keys(restored.room.props).every((k) => Number(k) < 20)).toBe(true);
    expect(typeof restored.room.inf.deadlineAt).toBe('number');
    // The imported game continues: a multiplied Squeeze landing still bills
    // at printed times the lower die and settles.
    const turn = restored.room.turnPlayerId;
    const tenant = turn === ada.playerId ? ada : bola;
    const ownerId = restored.room.players.find((p) => p.id !== turn).id;
    // migrated by name: old Yaba 13 is Yaba 6 on the 20 space board
    expect(restored.room.props[6].o).toBe(ownerId);
    tenant.send({ type: 'test_set_position', playerId: turn, space: 1 });
    tenant.send({ type: 'test_dice', rolls: [[2, 3]] });
    tenant.send({ type: 'roll' });
    const billed = await ada.until((m) => m.type === 'state' && m.room.pendingBill && m.room.pendingBill.playerId === turn, 'bill after import');
    expect(billed.room.pendingBill.amount).toBe(32000);
    const ownerBefore = billed.room.players.find((p) => p.id === ownerId).cash;
    tenant.send({ type: 'lifeline_skip', billId: billed.room.pendingBill.id, id: billed.room.pendingBill.id });
    await ada.until((m) => m.type === 'state' && !m.room.pendingBill
      && m.room.players.find((p) => p.id === ownerId).cash === ownerBefore + 32000, 'rent settled after import');
  });
});
