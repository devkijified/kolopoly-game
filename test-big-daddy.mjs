// Big Daddy only speaks on a highlight, and not twice inside 20 seconds.
// A tap clears him. Turning the setting off keeps him quiet.
import fs from 'fs';
import vm from 'vm';

const store = {};
const listeners = [];
let el = null;
function freshEl() {
  const img = { src: '', style: {} };
  const bubble = { textContent: '', appendChild() {}, children: [] };
  return {
    hidden: true,
    className: '',
    innerHTML: '',
    setAttribute() {},
    querySelector(sel) { return sel === 'img' ? img : bubble; }
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
check('a big rent is a highlight', BD.detect(
  { feed: [{ seq: 1 }], props: [], players: [] },
  { feed: [{ seq: 2, kind: 'credit', spaceName: 'Lekki', amount: 80000 }], props: [], players: [] }
) === 'rent');
check('a small rent stays quiet', BD.detect(
  { feed: [{ seq: 1 }], props: [], players: [] },
  { feed: [{ seq: 2, kind: 'credit', spaceName: 'Yaba', amount: 8000 }], props: [], players: [] }
) == null);
context.KP_DATA = { GROUP_SPACES: { vi: [0, 1] } };
check('a finished colour set throws naira', BD.detect(
  { feed: [], props: [{ o: 1, b: 0 }, { o: null, b: 0 }], players: [] },
  { feed: [], props: [{ o: 1, b: 0 }, { o: 1, b: 0 }], players: [] }
) === 'rent');
check('a new hotel throws naira', BD.detect(
  { feed: [], props: [{ o: 1, b: 4 }], players: [] },
  { feed: [], props: [{ o: 1, b: 5 }], players: [] }
) === 'rent');
check('Kirikiri peeks through the bars', BD.detect(
  { feed: [], props: [], players: [] },
  { feed: [{ seq: 1, kind: 'kirikiri' }], props: [], players: [] }
) === 'jail');
check('the pot is a party', BD.detect(
  { feed: [], owambeResult: null, props: [], players: [] },
  { feed: [], owambeResult: { id: 4, winnerId: 2, amount: 120000 }, props: [], players: [] }
) === 'pot');
check('a new salary phase tints the agbada', BD.detect(
  { feed: [{ seq: 1 }], inf: { phase: 1 }, props: [], players: [] },
  { feed: [{ seq: 2, kind: 'phase' }], inf: { phase: 2 }, props: [], players: [] }
) === 'salary');
check('a phase warning is not a new salary', BD.detect(
  { feed: [{ seq: 1 }], inf: { phase: 2 }, props: [], players: [] },
  { feed: [{ seq: 2, kind: 'phase' }], inf: { phase: 2 }, props: [], players: [] }
) == null);
check('all seats paid locks the table', BD.detect(
  { feed: [], paid: { allPaid: false }, props: [], players: [] },
  { feed: [], paid: { allPaid: true }, props: [], players: [] }
) === 'paid');
check('an AFK seat is shown to everybody else', BD.detect(
  { feed: [], props: [], players: [{ id: 2, afkTaken: false }] },
  { feed: [], props: [], players: [{ id: 2, afkTaken: true }] },
  1
) === 'afk');
check('the player who walked does not get the AFK line', BD.detect(
  { feed: [], props: [], players: [{ id: 2, afkTaken: false }] },
  { feed: [], props: [], players: [{ id: 2, afkTaken: true }] },
  2
) == null);
check('a wipe fans the deed', BD.detect(
  { feed: [], props: [], players: [{ id: 3, bankrupt: false }] },
  { feed: [{ seq: 9, kind: 'bankrupt' }], props: [], players: [{ id: 3, bankrupt: true }] }
) === 'lose');

check('the first pop shows', BD.show('rent', { now: 1000, still: true }) === true);
check('a second pop inside 20 seconds is refused', BD.show('pot', { now: 5000, still: true }) === false);
check('after 20 seconds he can speak again', BD.show('jail', { now: 1000 + BD.gap, still: true }) === true);
const skip = listeners.find((l) => l.ev === 'pointerdown');
skip.fn();
check('a tap clears him', document.getElementById('bigDaddy').hidden === true);

BD.setEnabled(false);
check('the setting off keeps him quiet', BD.show('drop', { now: 999999, force: true }) === false);
BD.setEnabled(true);
check('turning him back on allows a forced pop', BD.show('drop', { now: 999999, force: true, still: true }) === true);
check('the market line is the drop line', BD.lines.drop.line.indexOf("Today's drop") === 0);

console.log(fail ? fail + ' failed' : 'all ' + n + ' passed');
process.exit(fail ? 1 : 0);
