// Auction sheet copy: list price in Classic, list plus Now in Inflation,
// and no Phase 1 debug line.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const D = require('./public/game-data.js');

let n = 0, fail = 0;
function check(name, cond, extra) {
  n += 1;
  if (cond) console.log('  ok ' + n + ' - ' + name);
  else { fail += 1; console.log('  FAIL ' + n + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}

const lekki = D.SPACES.find((s) => s.name === 'Lekki Tollgate');
const makoko = D.SPACES.find((s) => s.name === 'Makoko');
const classic = D.auctionPriceCopy(lekki, null, 66000);
check('classic names the printed list price', classic && classic.text.indexOf('List price ' + D.fmtN(400000)) === 0, classic && classic.text);
check('classic station shows base rent', classic.text.indexOf('Rent ' + D.fmtN(75000)) > 0, classic.text);
check('classic has no phase lecture', classic.phase === '', classic.phase);
check('a bid under the list is marked under list', classic.hint === 'under list');
check('the toll uses a gold band', classic.band === '#e8a90c');

const phase1 = D.auctionPriceCopy(lekki, { phase: 1, index: 1 }, 0);
check('phase 1 does not invent a Now price', phase1.text.indexOf('Now') === -1, phase1.text);
check('phase 1 hides the multiplier line', phase1.phase === '');
check('phase 1 never says the rent multiplies by nothing', phase1.text.indexOf('nothing') === -1 && phase1.phase.indexOf('nothing') === -1);

const phase3 = D.auctionPriceCopy(makoko, { phase: 3, index: 2 }, 200000);
check('inflation shows list and the phase price', phase3.text.indexOf('List price ' + D.fmtN(120000)) === 0 && phase3.text.indexOf('Now ' + D.fmtN(240000)) > 0, phase3.text);
check('inflation keeps the street rent on the line', phase3.text.indexOf('Rent ' + D.fmtN(4000)) > 0, phase3.text);
check('a bid over the list is marked over list', phase3.hint === 'over list');
check('later phases use one plain line', phase3.phase === 'You pay the bid. Printed rent is higher this phase.');
check('Makoko keeps its colour band', phase3.band === '#8a5a33');
check('no copy says Monopoly', JSON.stringify([classic, phase1, phase3]).toLowerCase().indexOf('monopoly') === -1);

console.log(fail ? fail + ' failed' : 'all ' + n + ' passed');
process.exit(fail ? 1 : 0);
