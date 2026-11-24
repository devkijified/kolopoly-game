// Room updates stay a full picture with the quiet parts left out.
// A fat gist no longer rides on every message, and null blocks the
// client already ignores are not sent. paid and inf stay, even when
// null. Run: node test-payload.mjs
import { createRequire } from 'module';
import { EventEmitter } from 'events';

const require = createRequire(import.meta.url);
const { createGameHost } = require('./game-host.js');

let checks = 0, failures = 0;
const check = (name, cond, extra) => {
  checks++;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures++; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
};

const host = createGameHost({ test: true, leanWire: true });
let last = '';
const fake = new EventEmitter();
fake.readyState = 1;
fake.send = (d) => { last = String(d); };
fake.close = () => {};
host.handleConnection(fake);
const say = (o) => fake.emit('message', JSON.stringify(o));
say({ type: 'create_room', name: 'Ada', token: 'danfo', mode: 'online', settings: { gameMode: 'classic', timed: true } });
const code = [...host.rooms.keys()][0];
const room = host.rooms.get(code);
for (let i = 0; i < 14; i++) {
  room.feed.push({ seq: i + 1, kind: 'info', text: 'Salary alert don enter: ₦200,000 for Ada. A real gist line with a name and an amount, number ' + i + '.' });
}
room.feedSeq = 14;
say({ type: 'test_set_pot', amount: 0 });
const msg = JSON.parse(last);
const body = msg.room;
check('the wire keeps the newest six gist lines', body.feed.length === 6 && body.feed[0].seq === 9 && body.feed[5].seq === 14, 'len ' + body.feed.length);
check('a classic room still says paid and inf are null', body.paid === null && body.inf === null);
check('absent blocks are left out', !('auction' in body) && !('debt' in body) && !('trade' in body) && !('hustle' in body));
check('unowned deeds stay an explicit null', body.props[2] && body.props[2].o === null);
const bytes = Buffer.byteLength(last);
check('a fat update stays under 5 KB', bytes < 5000, bytes + ' bytes');
const lobby = createGameHost({ test: true, leanWire: true });
let lobbyRaw = '';
const seat = new EventEmitter();
seat.readyState = 1;
seat.send = (d) => { lobbyRaw = String(d); };
seat.close = () => {};
lobby.handleConnection(seat);
seat.emit('message', JSON.stringify({ type: 'create_room', name: 'Ada', token: 'danfo', mode: 'online', settings: { gameMode: 'inflation' } }));
const lobbyRoom = JSON.parse(lobbyRaw).room;
check('the lobby still carries the seven salaries', lobbyRoom.status === 'lobby' && Array.isArray(lobbyRoom.salaryLadder) && lobbyRoom.salaryLadder[1] === 140000 && lobbyRoom.salaryLadder[6] === 10000, JSON.stringify(lobbyRoom.salaryLadder));

console.log('---\nchecks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
