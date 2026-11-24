'use strict';
// Packs, power cards, the Lagos sticker album, and cosmetics.
// Nothing here is bought with real money. Goods (cowries, kola, yam,
// cloth) convert once into packs and cards so a stored shelf is not lost.
const CARDS = {
  bail: { id: 'bail', name: 'Bail card', line: 'Bail card! Kirikiri don open. Big Daddy say make you comot free.' },
  shield: { id: 'shield', name: 'Area Boys rent shield', line: 'Area Boys don stand. This rent no go touch you.' },
  double: { id: 'double', name: 'Double Alert', line: 'Double Alert! Your next salary na times two.' },
  dash: { id: 'dash', name: 'Danfo dash', line: 'Danfo dash! One fresh roll, hold am.' }
};
const STICKERS = [
  { id: 'lekki-toll', name: 'Lekki Toll Gate', set: 'bridges', stars: 1 },
  { id: 'carter', name: 'Carter Bridge', set: 'bridges', stars: 1 },
  { id: 'third-mainland', name: 'Third Mainland Bridge', set: 'bridges', stars: 2 },
  { id: 'balogun', name: 'Balogun Market', set: 'markets', stars: 1 },
  { id: 'suya', name: 'Suya Spot', set: 'markets', stars: 1 },
  { id: 'computer-village', name: 'Computer Village', set: 'markets', stars: 2 },
  { id: 'tbs', name: 'Tafawa Balewa Square', set: 'squares', stars: 1 },
  { id: 'national-theatre', name: 'National Theatre', set: 'squares', stars: 2 },
  { id: 'eko-atlantic', name: 'Eko Atlantic', set: 'squares', stars: 3, gold: true },
  { id: 'danfo', name: 'Danfo', set: 'motors', stars: 1 },
  { id: 'molue', name: 'Molue', set: 'motors', stars: 2 },
  { id: 'okada', name: 'Okada', set: 'motors', stars: 1 },
  { id: 'kirikiri', name: 'Kirikiri', set: 'night', stars: 2 },
  { id: 'owambe-hall', name: 'Owambe Hall', set: 'night', stars: 1 },
  { id: 'marina-lights', name: 'Marina Lights', set: 'night', stars: 3, gold: true }
];
const SETS = {
  bridges: { name: 'Bridges', reward: { kind: 'card', card: 'dash' } },
  markets: { name: 'Markets', reward: { kind: 'card', card: 'shield' } },
  squares: { name: 'Squares', reward: { kind: 'cosmetic', id: 'board-night' } },
  motors: { name: 'Motors', reward: { kind: 'cosmetic', id: 'token-gold-danfo' } },
  night: { name: 'Night Lagos', reward: { kind: 'cosmetic', id: 'daddy-gold' } }
};
const COSMETICS = {
  'token-gold-danfo': { id: 'token-gold-danfo', slot: 'token', name: 'Gold Danfo' },
  'board-night': { id: 'board-night', slot: 'board', name: 'Night Market' },
  'daddy-gold': { id: 'daddy-gold', slot: 'daddy', name: 'Gold Agbada' },
  'celebrate-spray': { id: 'celebrate-spray', slot: 'celebrate', name: 'Naira Spray' }
};
const CARD_IDS = Object.keys(CARDS);

function hashSeed(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function blankRewards() {
  return {
    migrated: false,
    packs: 0,
    cards: { bail: 0, shield: 0, double: 0, dash: 0 },
    album: {},
    setsDone: {},
    cosmetics: [],
    equipped: { token: null, board: null, daddy: null, celebrate: null }
  };
}
function ensureRewards(p) {
  if (!p.rewards || typeof p.rewards !== 'object') p.rewards = blankRewards();
  const r = p.rewards;
  r.cards = r.cards || { bail: 0, shield: 0, double: 0, dash: 0 };
  for (const id of CARD_IDS) r.cards[id] = Math.max(0, Math.floor(Number(r.cards[id]) || 0));
  r.album = r.album || {};
  r.setsDone = r.setsDone || {};
  r.cosmetics = Array.isArray(r.cosmetics) ? r.cosmetics : [];
  r.equipped = r.equipped || { token: null, board: null, daddy: null, celebrate: null };
  r.packs = Math.max(0, Math.floor(Number(r.packs) || 0));
  r.migrated = !!r.migrated;
  return r;
}
function migrateGoods(p) {
  const r = ensureRewards(p);
  if (r.migrated) return { converted: false, packs: 0, cards: { bail: 0, shield: 0, double: 0, dash: 0 } };
  const inv = p.inventory || { cowries: 0, kola: 0, yams: 0, cloth: 0 };
  const cowries = Math.max(0, Math.floor(Number(inv.cowries) || 0));
  const kola = Math.max(0, Math.floor(Number(inv.kola) || 0));
  const yams = Math.max(0, Math.floor(Number(inv.yams) || 0));
  const cloth = Math.max(0, Math.floor(Number(inv.cloth) || 0));
  const packsFromCowries = cowries > 0 ? Math.max(1, Math.floor(cowries / 3)) : 0;
  const gained = {
    packs: packsFromCowries + cloth,
    cards: { bail: yams, shield: kola, double: 0, dash: 0 }
  };
  r.packs += gained.packs;
  r.cards.bail += yams;
  r.cards.shield += kola;
  if (p.inventory) {
    p.inventory.cowries = 0;
    p.inventory.kola = 0;
    p.inventory.yams = 0;
    p.inventory.cloth = 0;
  }
  r.migrated = true;
  return { converted: (gained.packs + yams + kola) > 0, packs: gained.packs, cards: gained.cards };
}
function grantPack(p, n) {
  const r = ensureRewards(p);
  migrateGoods(p);
  const add = Math.max(0, Math.floor(Number(n) || 0));
  r.packs += add;
  return r.packs;
}
function drawSticker(rnd) {
  const roll = rnd();
  let pool;
  if (roll < 0.08) pool = STICKERS.filter((s) => s.gold);
  else if (roll < 0.30) pool = STICKERS.filter((s) => s.stars === 2);
  else pool = STICKERS.filter((s) => s.stars === 1);
  if (!pool.length) pool = STICKERS;
  return pool[Math.floor(rnd() * pool.length) % pool.length];
}
function completeSets(r) {
  const rewards = [];
  for (const [setId, set] of Object.entries(SETS)) {
    if (r.setsDone[setId]) continue;
    const members = STICKERS.filter((s) => s.set === setId);
    if (!members.every((s) => (r.album[s.id] || 0) >= 1)) continue;
    r.setsDone[setId] = true;
    if (set.reward.kind === 'card') {
      r.cards[set.reward.card] += 1;
      rewards.push({ set: setId, name: set.name, kind: 'card', card: set.reward.card });
    } else if (set.reward.kind === 'cosmetic' && COSMETICS[set.reward.id]) {
      if (!r.cosmetics.includes(set.reward.id)) r.cosmetics.push(set.reward.id);
      rewards.push({ set: setId, name: set.name, kind: 'cosmetic', id: set.reward.id });
    }
  }
  return rewards;
}
function openPack(p, seed) {
  const r = ensureRewards(p);
  migrateGoods(p);
  if (r.packs < 1) return { ok: false, error: 'empty' };
  r.packs -= 1;
  const rnd = mulberry(hashSeed(seed || ('pack-' + r.packs + '-' + JSON.stringify(r.album))));
  const pulled = [];
  for (let i = 0; i < 3; i++) {
    const s = drawSticker(rnd);
    const had = r.album[s.id] || 0;
    r.album[s.id] = had + 1;
    pulled.push({ id: s.id, name: s.name, set: s.set, stars: s.stars, gold: !!s.gold, duplicate: had >= 1 });
  }
  const completed = completeSets(r);
  return { ok: true, stickers: pulled, completed, packs: r.packs, cards: Object.assign({}, r.cards), album: Object.assign({}, r.album) };
}
function giftDuplicate(from, stickerId) {
  const r = ensureRewards(from);
  const id = String(stickerId || '');
  if (!STICKERS.some((s) => s.id === id)) return { ok: false, error: 'sticker' };
  if ((r.album[id] || 0) < 2) return { ok: false, error: 'nodupe' };
  r.album[id] -= 1;
  return { ok: true, id };
}
function receiveSticker(to, stickerId) {
  const r = ensureRewards(to);
  if (!STICKERS.some((s) => s.id === stickerId)) return { ok: false, error: 'sticker' };
  r.album[stickerId] = (r.album[stickerId] || 0) + 1;
  const completed = completeSets(r);
  return { ok: true, completed };
}
function spendCard(p, card) {
  const r = ensureRewards(p);
  if (!CARDS[card]) return { ok: false, error: 'card' };
  if (r.cards[card] < 1) return { ok: false, error: 'empty' };
  r.cards[card] -= 1;
  return { ok: true, card, left: r.cards[card] };
}
function giveCard(p, card, n) {
  const r = ensureRewards(p);
  if (!CARDS[card]) return { ok: false, error: 'card' };
  r.cards[card] += Math.max(1, Math.floor(Number(n) || 1));
  return { ok: true, cards: Object.assign({}, r.cards) };
}
function equipCosmetic(p, id) {
  const r = ensureRewards(p);
  const c = COSMETICS[id];
  if (!c) return { ok: false, error: 'cosmetic' };
  if (!r.cosmetics.includes(id)) return { ok: false, error: 'unowned' };
  r.equipped[c.slot] = id;
  return { ok: true, equipped: Object.assign({}, r.equipped) };
}
function publicRewards(p) {
  const r = ensureRewards(p);
  const sets = Object.keys(SETS).map((id) => {
    const members = STICKERS.filter((s) => s.set === id);
    const have = members.filter((s) => (r.album[s.id] || 0) >= 1).length;
    return { id, name: SETS[id].name, have, size: members.length, done: !!r.setsDone[id] };
  });
  return {
    packs: r.packs,
    cards: Object.assign({}, r.cards),
    album: Object.assign({}, r.album),
    sets,
    cosmetics: r.cosmetics.slice(),
    equipped: Object.assign({}, r.equipped),
    stickers: STICKERS.map((s) => ({ id: s.id, name: s.name, set: s.set, stars: s.stars, gold: !!s.gold, count: r.album[s.id] || 0 }))
  };
}
// Free and private free tables only. One card per player per match.
function judgePlay(room, player, card, have) {
  if (!CARDS[card]) return { ok: false, error: 'card', message: 'That card no dey.' };
  if (room && (room.paid || room.paidFee || room.cityId)) return { ok: false, error: 'paid', message: 'Power cards no dey for paid tables.' };
  if (!player || player.bot) return { ok: false, error: 'who', message: 'You no fit play a card now.' };
  if (player.cardPlayed) return { ok: false, error: 'once', message: 'You don play your one card for this match.' };
  if (!have) return { ok: false, error: 'empty', message: 'You no hold that card.' };
  if (card === 'bail' && !player.inJail) return { ok: false, error: 'jail', message: 'Bail card na for Kirikiri only.' };
  if (card === 'dash' && player.danfoDash) return { ok: false, error: 'dash', message: 'Danfo dash already dey on your next roll.' };
  if (card === 'shield' && player.areaShield) return { ok: false, error: 'shield', message: 'Area Boys already dey cover your next rent.' };
  if (card === 'double' && player.doubleSalary) return { ok: false, error: 'double', message: 'Double Alert already dey on your next salary.' };
  return { ok: true };
}

module.exports = {
  CARDS, STICKERS, SETS, COSMETICS, CARD_IDS,
  blankRewards, ensureRewards, migrateGoods, grantPack, openPack, completeSets, giftDuplicate, receiveSticker,
  spendCard, giveCard, equipCosmetic, publicRewards, judgePlay, hashSeed
};
