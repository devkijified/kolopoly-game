import { createRetention } from './retention.js';
import { forCity } from './events.js';
import { tradeSwap, ensureRewards } from './shelf-rewards.js';

let n = 0, fail = 0;
const check = (name, cond, extra) => {
  n++;
  if (cond) console.log('  ok ' + n + ' - ' + name);
  else { fail++; console.log('  FAIL ' + n + ' - ' + name + (extra ? ' :: ' + extra : '')); }
};

const home = forCity('2026-11-25', 'lagos');
const away = forCity('2026-11-25', 'aso-rock');
check('the home city has this week event', !!(home && home.city === 'lagos' && home.sticker && home.ends));
check('another city does not see a home-city event', away == null);

const a = { inventory: { cowries: 0, kola: 0, yams: 0, cloth: 0 } };
const b = { inventory: { cowries: 0, kola: 0, yams: 0, cloth: 0 } };
ensureRewards(a); ensureRewards(b);
a.rewards.album['lekki-toll'] = 2;
b.rewards.album.danfo = 2;
const swapped = tradeSwap(a, b, 'lekki-toll', 'danfo');
check('a duplicate swap is atomic', swapped.ok && a.rewards.album['lekki-toll'] === 1 && a.rewards.album.danfo === 1 && b.rewards.album['lekki-toll'] === 1 && b.rewards.album.danfo === 1);
check('a single copy cannot be traded', tradeSwap(a, b, 'lekki-toll', 'danfo').ok === false);

const ret = createRetention({ test: true, memory: true });
ret.noteRivalry({ payer: 'payer-000111', owner: 'owner-000222', payerName: 'Kiji', ownerName: 'Ada', amount: 150000 });
const view = await new Promise((resolve) => {
  const req = { method: 'GET', url: '/api/retention?clientId=payer-000111&day=2026-11-25', headers: {} };
  const res = { writeHead() {}, end(body) { resolve(JSON.parse(body)); } };
  ret.handle(req, res);
});
check('a big rent offers a rematch', view.rematch && view.rematch.name === 'Ada' && view.rematch.amount === 150000, JSON.stringify(view.rematch));
check('the head-to-head record is stored', (view.rivalries || []).some((r) => r.youPaid === 150000));

function call(method, url, body) {
  return new Promise((resolve) => {
    const req = { method, url, headers: {} };
    if (body) {
      const raw = Buffer.from(JSON.stringify(body));
      req.on = (ev, fn) => { if (ev === 'data') fn(raw); if (ev === 'end') fn(); };
    }
    const res = { writeHead() {}, end(text) { resolve(JSON.parse(text)); } };
    ret.handle(req, res);
  });
}
const claimed = await call('POST', '/api/events/claim', { clientId: 'payer-000111' });
const owned = claimed.rewards && claimed.rewards.stickers.find((s) => s.id === home.sticker.id);
check('the week claim lands the limited sticker', claimed.ok && owned && owned.count === 1 && owned.limited, JSON.stringify(claimed.ok && owned));

console.log(fail ? fail + ' failed' : 'all ' + n + ' passed');
process.exit(fail ? 1 : 0);
