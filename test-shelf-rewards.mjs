import { migrateGoods, openPack, grantPack, ensureRewards, judgePlay, completeSets, spinWheel, homeCity, publicRewards, STICKERS, SETS } from './shelf-rewards.js';
import { linesFor, byId } from './emotes.js';

let n = 0, fail = 0;
const check = (name, cond, extra) => {
  n++;
  if (cond) console.log('  ok ' + n + ' - ' + name);
  else { fail++; console.log('  FAIL ' + n + ' - ' + name + (extra ? ' :: ' + extra : '')); }
};

const vet = { inventory: { cowries: 6, kola: 2, yams: 1, cloth: 1 } };
const moved = migrateGoods(vet);
check('goods become packs and cards', moved.packs === 3 && moved.cards.shield === 2 && moved.cards.bail === 1, JSON.stringify(moved));
check('the old goods are gone', vet.inventory.cowries === 0 && vet.inventory.kola === 0);
check('migration does not run twice', migrateGoods(vet).converted === false && vet.rewards.packs === 3);

const fresh = { inventory: { cowries: 0, kola: 0, yams: 0, cloth: 0 } };
grantPack(fresh, 1);
const opened = openPack(fresh, 'seed-album-1');
check('a pack opens three stickers', opened.ok && opened.stickers.length === 3, JSON.stringify(opened.stickers));
check('the pack is spent', fresh.rewards.packs === 0);

const collector = { inventory: { cowries: 0, kola: 0, yams: 0, cloth: 0 } };
ensureRewards(collector);
for (const s of STICKERS.filter((s) => s.set === 'bridges')) collector.rewards.album[s.id] = 1;
collector.rewards.album['lekki-toll'] = 0;
check('an incomplete set pays nothing', completeSets(collector.rewards).length === 0);
collector.rewards.album['lekki-toll'] = 1;
const done = completeSets(collector.rewards);
check('a finished Bridges set grants Danfo dash', done.length === 1 && done[0].card === 'dash' && collector.rewards.cards.dash === 1, JSON.stringify(done));
check('the set does not pay twice', completeSets(collector.rewards).length === 0);

const room = { paid: true, cityId: 'lagos' };
const player = { bot: false, cardPlayed: null, inJail: false };
check('a paid table blocks every power card', judgePlay(room, player, 'bail', true).error === 'paid');
check('one card per match', judgePlay({ paid: false }, { cardPlayed: 'shield', bot: false }, 'dash', true).error === 'once');
check('an empty hand is refused', judgePlay({ paid: false }, { cardPlayed: null, bot: false }, 'shield', false).error === 'empty');
check('bail needs Kirikiri', judgePlay({ paid: false }, { cardPlayed: null, bot: false, inJail: false }, 'bail', true).error === 'jail');
check('a free table accepts a shield', judgePlay({ paid: false }, { cardPlayed: null, bot: false }, 'shield', true).ok === true);

const spinner = { inventory: { cowries: 0, kola: 0, yams: 0, cloth: 0 } };
const spun = spinWheel(spinner, '2026-11-25', 'spin-seed', homeCity());
check('the first spin of the day lands a prize', spun.ok && spun.prize && spun.prize.line && spinner.rewards.spinDay === '2026-11-25', JSON.stringify(spun.prize));
const again = spinWheel(spinner, '2026-11-25', 'spin-seed', homeCity());
check('a second spin the same day is refused', again.ok === false && again.error === 'spent');
const otherCity = linesFor('aso-rock').map((l) => l.id);
check('another city does not hear the home-city lines', !otherCity.includes('jam') && otherCity.includes('oya'));
const homeLines = linesFor(homeCity()).map((l) => l.id);
check('the home city hears its own lines', homeLines.includes('jam') && homeLines.includes('shine'));
check('an unknown talk is refused', byId('nope') == null && byId('jam').city === homeCity());
check('a finished set names its cosmetic', done[0].cosmeticName === 'Bridge Name Frame', JSON.stringify(done[0]));

const week = publicRewards(collector).stickers.filter((s) => s.set === 'limited');
check('the album lists four gold week stickers', week.length === 4 && week.every((s) => s.gold && s.limited && s.city === 'lagos' && s.count === 0), JSON.stringify(week.map((s) => s.id)));
let leaked = false;
for (let i = 0; i < 30; i++) {
  const p = { inventory: { cowries: 0, kola: 0, yams: 0, cloth: 0 } };
  grantPack(p, 1);
  const pulled = openPack(p, 'week-guard-' + i);
  if ((pulled.stickers || []).some((s) => s.set === 'limited' || String(s.id).indexOf('event-') === 0)) leaked = true;
}
check('a pack never drops a week sticker', leaked === false);

console.log(fail ? fail + ' failed' : 'all ' + n + ' passed');
process.exit(fail ? 1 : 0);
