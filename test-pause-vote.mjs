// Agreed pause tests (raw socket clients, free tables):
// - propose pause, one agrees, one declines: no pause, note says so.
// - propose again, all agree: paused. A move is rejected server-side
//   and the turn deadline does not advance while paused.
// - propose resume, all agree: play resumes, the deadline shifts by
//   the paused stretch and the turn clock runs again.
// - a vote nobody answers lapses on its timeout with no pause.
// - a voter who disconnects mid-vote stops being required.
// - a lone human's proposal lands at once (nobody to agree).
// - a paid table refuses the whole flow.
// Run: node test-pause-vote.mjs   (spawns its own KP_TEST server)
import { spawn } from 'child_process';
import WebSocket from 'ws';

const PORT = 4245;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, extra) {
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (extra ? '  [' + extra + ']' : ''));
  if (!ok) failures++;
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), KP_TEST: '1', KP_ADMIN_TOKEN: '', KP_PERSIST_ROOMS: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('Kolopoly listening')) res(); }));

class Client {
  constructor(name) { this.name = name; this.state = null; this.playerId = null; this.errors = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('ws://127.0.0.1:' + PORT);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'joined') { this.playerId = msg.playerId; if (msg.token) this.token = msg.token; }
        if (msg.type === 'state') this.state = msg.room;
        if (msg.type === 'error') this.errors.push(msg.message);
      });
    });
  }
  send(type, obj) { this.ws.send(JSON.stringify(Object.assign({ type }, obj || {}))); }
  async waitFor(pred, label, ms) {
    const end = Date.now() + (ms || 12000);
    while (Date.now() < end) { if (this.state && pred(this.state)) return this.state; await sleep(50); }
    throw new Error('timeout: ' + label + ' (last state: ' + JSON.stringify(this.state && { status: this.state.status, paused: this.state.paused, vote: this.state.pauseVote })) + ')';
  }
  close() { try { this.ws.close(); } catch (e) { } }
}
let deviceSeq = 0;
async function makeTable(names) {
  const clients = [];
  for (let i = 0; i < names.length; i++) {
    const c = new Client(names[i]);
    await c.connect();
    clients.push(c);
  }
  const host = clients[0];
  host.send('create_room', { name: names[0], token: 'danfo', mode: 'online', clientId: 'pv-host-' + (++deviceSeq), settings: { gameMode: 'classic' } });
  await host.waitFor((s) => s.status === 'lobby', 'host lobby');
  const code = host.state.code;
  for (let i = 1; i < clients.length; i++) {
    clients[i].send('join_room', { code, name: names[i], token: 'keke', clientId: 'pv-guest-' + (++deviceSeq) });
    await clients[i].waitFor((s) => s.status === 'lobby' && s.players.length === i + 1, names[i] + ' seated');
  }
  host.send('start_game', {});
  await host.waitFor((s) => s.status === 'playing', 'table playing');
  return { clients, host, code };
}

try {
  // ------------------------------------------------ room 1: the full vote story
  const t1 = await makeTable(['Ada', 'Bola', 'Chidi']);
  const [A, B, C] = t1.clients;
  A.send('propose_pause', { kind: 'pause' });
  const v1 = await B.waitFor((s) => !!s.pauseVote, 'vote opens for Bola');
  check('pause vote opens with the other two humans as the required set',
    v1.pauseVote.kind === 'pause' && v1.pauseVote.by === A.playerId &&
    v1.pauseVote.needed.slice().sort().join(',') === [B.playerId, C.playerId].sort().join(','),
    JSON.stringify(v1.pauseVote));
  check('game is not paused while the vote runs', !v1.paused && !v1.agreedPause);
  B.send('pause_vote', { agree: true });
  const v2 = await A.waitFor((s) => !!s.pauseVote && s.pauseVote.agreed.includes(B.playerId), 'Bola agreement lands');
  check('one agreement shows in the ballot and the vote stays open', !!v2.pauseVote && !v2.paused);
  C.send('pause_vote', { agree: false });
  const v3 = await A.waitFor((s) => !s.pauseVote, 'decline closes the vote');
  check('a decline kills the vote and the game never pauses', !v3.paused && !v3.agreedPause);
  check('the outcome note names the decline', !!v3.pauseNote && /no gree/.test(v3.pauseNote.text), v3.pauseNote && v3.pauseNote.text);

  // Second proposal, with a short turn clock set while the vote runs.
  A.send('propose_pause', { kind: 'pause' });
  await B.waitFor((s) => !!s.pauseVote, 'second vote opens');
  A.send('test_deadline_in', { seconds: 4 });
  B.send('pause_vote', { agree: true });
  C.send('pause_vote', { agree: true });
  const v4 = await A.waitFor((s) => !!s.agreedPause, 'pause lands when all agree');
  check('unanimous vote pauses the game', v4.paused === true && v4.agreedPause.by === A.playerId);
  const frozenTurn = v4.turnPlayerId;
  const frozenDeadline = v4.turnDeadline;
  check('a turn deadline is on the table to freeze', !!frozenDeadline);
  const turnClient = t1.clients.find((c) => c.playerId === frozenTurn);
  turnClient.errors.length = 0;
  turnClient.send('roll', {});
  await sleep(600);
  check('a move during the agreed pause is rejected by the server',
    turnClient.errors.some((e) => /paused/.test(e)), JSON.stringify(turnClient.errors));
  check('the rejected move changed nothing', A.state.phase === 'roll' && A.state.turnPlayerId === frozenTurn && !A.state.auction);
  await sleep(5000); // the 4s clock would have fired long ago if it ran
  check('the turn deadline does not advance while paused',
    A.state.turnDeadline === frozenDeadline && A.state.turnPlayerId === frozenTurn && A.state.status === 'playing',
    'deadline ' + frozenDeadline + ' -> ' + A.state.turnDeadline);

  B.send('propose_pause', { kind: 'resume' });
  const v5 = await C.waitFor((s) => !!s.pauseVote && s.pauseVote.kind === 'resume', 'resume vote opens');
  check('resume is its own ballot for the other humans', v5.pauseVote.needed.includes(A.playerId) && v5.pauseVote.needed.includes(C.playerId));
  A.send('pause_vote', { agree: true });
  C.send('pause_vote', { agree: true });
  const v6 = await A.waitFor((s) => !s.paused && !s.agreedPause, 'resume lands');
  check('unanimous resume unpauses the game', !v6.pauseVote);
  check('the turn deadline shifted by the paused stretch', v6.turnDeadline > frozenDeadline,
    'deadline ' + frozenDeadline + ' -> ' + v6.turnDeadline);
  await A.waitFor((s) => s.turnPlayerId !== frozenTurn, 'turn clock runs again after resume', 12000);
  check('the turn passes once the shifted clock runs out', true);
  t1.clients.forEach((c) => c.close());

  // ------------------------------------------------ room 2: the vote times out
  const t2 = await makeTable(['Dara', 'Efe']);
  const [D, E] = t2.clients;
  D.send('propose_pause', { kind: 'pause' });
  await E.waitFor((s) => !!s.pauseVote, 'timeout vote opens');
  const v7 = await D.waitFor((s) => !s.pauseVote && !!s.pauseNote, 'vote lapses', 25000);
  check('an unanswered vote lapses with no pause', !v7.paused && !v7.agreedPause);
  check('the lapse note says time finished', /time finish/.test(v7.pauseNote.text), v7.pauseNote.text);
  t2.clients.forEach((c) => c.close());

  // ------------------------------------------------ room 3: a voter disconnects mid-vote
  const t3 = await makeTable(['Funmi', 'Gbenga', 'Halima']);
  const [F, G, H] = t3.clients;
  F.send('propose_pause', { kind: 'pause' });
  await H.waitFor((s) => !!s.pauseVote && s.pauseVote.needed.includes(G.playerId), 'vote includes Gbenga');
  G.close();
  const v8 = await F.waitFor((s) => !!s.pauseVote && !s.pauseVote.needed.includes(G.playerId), 'Gbenga drops out of the ballot', 15000);
  check('a disconnected voter is no longer required', v8.pauseVote.needed.join(',') === String(H.playerId), JSON.stringify(v8.pauseVote.needed));
  H.send('pause_vote', { agree: true });
  const v9 = await F.waitFor((s) => !!s.agreedPause, 'pause lands with the remaining voter');
  check('the pause lands once every remaining voter agrees', v9.paused === true);
  F.close(); H.close();

  // ------------------------------------------------ room 4: one human alone
  const solo = new Client('Solo');
  await solo.connect();
  solo.send('create_room', { name: 'Solo', token: 'danfo', mode: 'online', clientId: 'pv-solo-' + (++deviceSeq), settings: { gameMode: 'classic' } });
  await solo.waitFor((s) => s.status === 'lobby', 'solo lobby');
  solo.send('add_bot', {});
  await solo.waitFor((s) => s.players.length === 2, 'bot seated');
  solo.send('start_game', {});
  await solo.waitFor((s) => s.status === 'playing', 'solo game playing');
  solo.send('propose_pause', { kind: 'pause' });
  const v10 = await solo.waitFor((s) => !!s.agreedPause, 'solo pause lands');
  check('with no other human to agree, the pause lands at once (bots never vote)', v10.paused === true && !v10.pauseVote);
  check('the note says it landed at once', /at once/.test(v10.pauseNote.text), v10.pauseNote.text);
  solo.send('propose_pause', { kind: 'resume' });
  const v11 = await solo.waitFor((s) => !s.agreedPause, 'solo resume lands');
  check('a lone human resumes at once too', !v11.agreedPause && v11.paused === false, 'paused=' + v11.paused);
  solo.close();

  // ------------------------------------------------ room 5: paid tables refuse
  const t5 = await makeTable(['Paid', 'Other']);
  const [P, O] = t5.clients;
  P.send('test_set_paid', { playerId: O.playerId, fee: 200 });
  await P.waitFor((s) => !!s.paid && s.paid.fee === 200, 'paid flag set');
  P.errors.length = 0;
  P.send('propose_pause', { kind: 'pause' });
  await sleep(600);
  check('a paid table refuses the agreed pause', P.errors.some((e) => /only free table/.test(e)) && !P.state.pauseVote && !P.state.agreedPause,
    JSON.stringify(P.errors));
  t5.clients.forEach((c) => c.close());
} finally {
  server.kill();
}
console.log(failures ? ('\n' + failures + ' FAILURES') : '\nall pause vote checks passed');
process.exit(failures ? 1 : 0);
