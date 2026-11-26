// Big Daddy only speaks on a highlight, and not twice inside 20 seconds.
// A tap clears him. Turning the setting off keeps him quiet.
import fs from 'fs';
import vm from 'vm';

const store = {};
const listeners = [];
let el = null;
function freshEl() {
  const img = { src: '', style: {} };
  const line = { textContent: '' };
  const chip = { addEventListener(ev, fn) { if (ev === 'click') chip.onclick = fn; } };
  return {
    hidden: true,
    className: '',
    classList: { add() {}, remove() {}, contains() { return false; } },
    innerHTML: '',
    setAttribute() {},
    querySelector(sel) {
      if (sel === 'img') return img;
      if (sel === '.bd-line') return line;
      if (sel === '.bd-chip') return chip;
      return line;
    },
    chip
  };
}
const document = {
  readyState: 'complete',
  querySelector: () => ({ content: 'abc' }),
  getElementById(id) {
    if (id === 'optBigDaddy') return { checked: true, addEventListener() {} };
    if (id === 'bigDaddy') return el;
    return null;
  },
  addEventListener(ev, fn) { listeners.push({ ev, fn }); },
  createElement() { el = freshEl(); return el; },
  body: { appendChild() {} }
};
const context = {
  document,
  localStorage: {
    getItem: (k) => (store[k] == null ? null : store[k]),
    setItem: (k, v) => { store[k] = String(v); }
  },
  matchMedia: () => ({ matches: false }),
  setTimeout() { return 1; },
  clearTimeout() {}
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('./public/big-daddy.js', import.meta.url), 'utf8'), context);
const BD = context.KPBigDaddy;

let n = 0, fail = 0;
const check = (name, cond, extra) => {
  n++;
  if (cond) console.log('  ok ' + n + ' - ' + name);
  else { fail++; console.log('  FAIL ' + n + ' - ' + name + (extra ? ' :: ' + extra : '')); }
};

check('pop-ups start on', BD.enabled() === true);
check('a big rent is a highlight for the collector', BD.detect(
  { feed: [{ seq: 1 }], props: [], players: [{ id: 1 }, { id: 2 }] },
  { feed: [{ seq: 2, kind: 'credit', spaceName: 'Lekki', amount: 80000, playerId: 1, otherId: 2 }], props: [], players: [{ id: 1 }, { id: 2 }] },
  1
) === 'rent');
check('the other player does not get the rent tip', BD.detect(
  { feed: [{ seq: 1 }], props: [], players: [{ id: 1 }, { id: 2 }] },
  { feed: [{ seq: 8, kind: 'credit', spaceName: 'Lekki', amount: 80000, playerId: 1, otherId: 2 }], props: [], players: [{ id: 1 }, { id: 2 }] },
  2
) == null);
check('a small rent stays quiet', BD.detect(
  { feed: [{ seq: 1 }], props: [], players: [] },
  { feed: [{ seq: 2, kind: 'credit', spaceName: 'Yaba', amount: 8000, playerId: 1 }], props: [], players: [] },
  1
) == null);
context.KP_DATA = { GROUP_SPACES: { vi: [0, 1] } };
check('a finished colour set tips the owner', BD.detect(
  { feed: [], props: [{ o: 1, b: 0 }, { o: null, b: 0 }], players: [{ id: 1 }, { id: 2 }] },
  { feed: [], props: [{ o: 1, b: 0 }, { o: 1, b: 0 }], players: [{ id: 1 }, { id: 2 }] },
  1
) === 'rent');
check('a finished colour set stays quiet for the other seat', BD.detect(
  { feed: [], props: [{ o: 1, b: 0 }, { o: null, b: 0 }], players: [{ id: 1 }, { id: 2 }] },
  { feed: [], props: [{ o: 1, b: 0 }, { o: 1, b: 0 }], players: [{ id: 1 }, { id: 2 }] },
  2
) == null);
check('a new hotel tips the owner', BD.detect(
  { feed: [], props: [{ o: 1, b: 4 }], players: [{ id: 1 }, { id: 2 }] },
  { feed: [], props: [{ o: 1, b: 5 }], players: [{ id: 1 }, { id: 2 }] },
  1
) === 'rent');
const jailPrev = { feed: [], props: [], players: [{ id: 1, inJail: false }, { id: 2, inJail: false }] };
const jailRoom = { feed: [{ seq: 11, kind: 'kirikiri', playerId: 1 }], props: [], players: [{ id: 1, inJail: true }, { id: 2, inJail: false }] };
check('the other player sees no Kirikiri tip', BD.detect(jailPrev, jailRoom, 2) == null);
check('Kirikiri tips only the player who landed there', BD.detect(jailPrev, jailRoom, 1) === 'jail');
check('the same Kirikiri tip does not repeat', BD.detect(jailPrev, jailRoom, 1) == null);
check('the pot tips the winner only', BD.detect(
  { feed: [], owambeResult: null, props: [], players: [{ id: 1 }, { id: 2 }] },
  { feed: [], owambeResult: { id: 4, winnerId: 2, amount: 120000 }, props: [], players: [{ id: 1 }, { id: 2 }] },
  2
) === 'pot');
check('the pot stays quiet for the other seat', BD.detect(
  { feed: [], owambeResult: null, props: [], players: [{ id: 1 }, { id: 2 }] },
  { feed: [], owambeResult: { id: 5, winnerId: 2, amount: 120000 }, props: [], players: [{ id: 1 }, { id: 2 }] },
  1
) == null);
check('a new salary phase tips the player whose turn it is', BD.detect(
  { feed: [{ seq: 1 }], inf: { phase: 1 }, props: [], players: [{ id: 1 }, { id: 2 }], turnPlayerId: 1 },
  { feed: [{ seq: 2, kind: 'phase' }], inf: { phase: 2 }, props: [], players: [{ id: 1 }, { id: 2 }], turnPlayerId: 1 },
  1
) === 'salary');
check('a new salary phase stays quiet for the waiting player', BD.detect(
  { feed: [{ seq: 1 }], inf: { phase: 1 }, props: [], players: [{ id: 1 }, { id: 2 }], turnPlayerId: 1 },
  { feed: [{ seq: 12, kind: 'phase' }], inf: { phase: 2 }, props: [], players: [{ id: 1 }, { id: 2 }], turnPlayerId: 1 },
  2
) == null);
check('a phase warning is not a new salary', BD.detect(
  { feed: [{ seq: 1 }], inf: { phase: 2 }, props: [], players: [], turnPlayerId: 1 },
  { feed: [{ seq: 2, kind: 'phase' }], inf: { phase: 2 }, props: [], players: [], turnPlayerId: 1 },
  1
) == null);
check('all seats paid tips the host only', BD.detect(
  { feed: [], paid: { allPaid: false }, props: [], players: [{ id: 1 }, { id: 2 }], hostId: 1 },
  { feed: [], paid: { allPaid: true }, props: [], players: [{ id: 1 }, { id: 2 }], hostId: 1 },
  1
) === 'paid');
check('all seats paid stays quiet for the other seat', BD.detect(
  { feed: [], paid: { allPaid: false }, props: [], players: [{ id: 1 }, { id: 2 }], hostId: 1, code: 'B' },
  { feed: [], paid: { allPaid: true }, props: [], players: [{ id: 1 }, { id: 2 }], hostId: 1, code: 'B' },
  2
) == null);
check('an AFK seat does not tip either player', BD.detect(
  { feed: [], props: [], players: [{ id: 1 }, { id: 2, afkTaken: false }] },
  { feed: [], props: [], players: [{ id: 1 }, { id: 2, afkTaken: true }] },
  1
) == null && BD.detect(
  { feed: [], props: [], players: [{ id: 1 }, { id: 2, afkTaken: false }] },
  { feed: [], props: [], players: [{ id: 1 }, { id: 2, afkTaken: true }] },
  2
) == null);
const brokePrev = { feed: [], props: [], players: [{ id: 1 }, { id: 3, bankrupt: false }] };
const brokeRoom = { feed: [{ seq: 9, kind: 'bankrupt', playerId: 3 }], props: [], players: [{ id: 1 }, { id: 3, bankrupt: true }] };
check('a wipe tips the player who went out', BD.detect(brokePrev, brokeRoom, 3) === 'lose');
check('a wipe stays quiet for the other seat', BD.detect(
  { feed: [], props: [], players: [{ id: 1 }, { id: 3, bankrupt: false }] },
  { feed: [{ seq: 19, kind: 'bankrupt', playerId: 3 }], props: [], players: [{ id: 1 }, { id: 3, bankrupt: true }] },
  1
) == null);
const buildPrev = { phase: 'roll', feed: [], players: [{ id: 1, cash: 400000 }, { id: 2, cash: 400000 }] };
const buildRoom = { phase: 'end', turnPlayerId: 1, feed: [{ seq: 30 }], players: [{ id: 1, cash: 400000 }, { id: 2, cash: 400000 }] };
check('the build tip goes to the player ending the turn', BD.detect(buildPrev, buildRoom, 1) === 'build');
check('the build tip stays quiet for the other seat', BD.detect(
  { phase: 'roll', feed: [], players: [{ id: 1, cash: 400000 }, { id: 2, cash: 400000 }] },
  { phase: 'end', turnPlayerId: 1, feed: [{ seq: 31 }], players: [{ id: 1, cash: 400000 }, { id: 2, cash: 400000 }] },
  2
) == null);
check('low cash tips that player only', BD.detect(
  { feed: [], players: [{ id: 1, cash: 100000 }, { id: 2, cash: 100000 }] },
  { feed: [], players: [{ id: 1, cash: 50000 }, { id: 2, cash: 100000 }] },
  1
) === 'low');
check('low cash stays quiet for the other seat', BD.detect(
  { feed: [], players: [{ id: 1, cash: 100000 }, { id: 2, cash: 100000 }] },
  { feed: [], players: [{ id: 1, cash: 40000 }, { id: 2, cash: 100000 }] },
  2
) == null);
check('no tip line says Monopoly', Object.keys(BD.lines).every((id) => !/monopoly/i.test(BD.lines[id].line)));

check('the first pop shows', BD.show('rent', { now: 1000, still: true }) === true);
check('a second pop inside 20 seconds is refused', BD.show('pot', { now: 5000, still: true }) === false);
check('after 20 seconds he can speak again', BD.show('jail', { now: 1000 + BD.gap, still: true }) === true);
document.getElementById('bigDaddy').chip.onclick();
check('a tap clears him', document.getElementById('bigDaddy').hidden === true);

BD.setEnabled(false);
check('the setting off keeps him quiet', BD.show('drop', { now: 999999, force: true }) === false);
BD.setEnabled(true);
check('turning him back on allows a forced pop', BD.show('drop', { now: 999999, force: true, still: true }) === true);
check('the market line is the drop line', BD.lines.drop.line.indexOf("Today's drop") === 0);

console.log(fail ? fail + ' failed' : 'all ' + n + ' passed');
process.exit(fail ? 1 : 0);
