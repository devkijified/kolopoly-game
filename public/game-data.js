'use strict';
// KOLOPOLY game data. One content source for the server and the client.
// board20 (docs/BOARD20.md): a 20 space, all Lagos board, 5 steps a side
// (4 corners + 4 middle tiles per side), so every tile is big enough to
// read on a phone. Prices and rent ladders are raised again for the short
// lap. Kirikiri stays the jail (5) and Go to Kirikiri (15).
// The old 40 and 28 space boards live only in game-host.js (LEGACY_40,
// LEGACY_28), used to migrate saved rooms.
// Money scale: classic $1 = ₦1,000 throughout. Money is always exact.
// Rent ladder reads: site / full set / 1 duplex / 2 / 3 / 4 / mansion.
// Mortgage is always half the price. Zero em dashes in all copy.

// fmt: exact naira formatting, never compact. Used on both sides.
function fmtN(n) {
  n = Math.round(Number(n) || 0);
  const neg = n < 0;
  const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + '\u20A6' + s;
}

const DENOMS = [500000, 200000, 100000, 50000, 10000, 5000, 1000];
const START_CASH = 1500000;
const START_PAY = 200000;
const JAIL_FINE = 50000;

const GROUPS = {
  brown:    { name: 'The Trenches',          color: '#8a5a33' },
  lightblue:{ name: 'Mainland Hustle Belt',  color: '#7ec3e8' },
  red:      { name: 'Hotels and Nightlife',  color: '#d63a2f' },
  yellow:   { name: 'Corporate and Capital', color: '#e8c62a' },
  darkblue: { name: 'The Final Boss',        color: '#2b3f9e' }
};

// type: start | street | station | utility | card | tax | jail |
//       freeparking | gotojail
// deck on card spaces: 'wahala' or 'family'
// KOLOPOLY 20 (board20): 20 spaces, 5 per side counting each corner once
// (4 corners + 4 middle tiles per side). Five sets of two streets, two
// stations, one utility, two card spaces and one tax. A lap is 20 spaces
// instead of 28, so START comes round 1.4 times as often again; deeds,
// duplexes and rents are raised about 1.35x over board28.
// art: emblem key shared by the 2D (board.js) and 3D (board3d.js) renderers.
const SPACES = [
  // ---- Side 1 (near side): START to Kirikiri --------------------------------
  { type: 'start', name: 'START', short: 'START', art: 'payday', meaning: 'Every lap starts here. Pass am, salary alert go enter.' },
  { type: 'street', name: 'Makoko', short: 'Makoko', group: 'brown', art: 'stilts', price: 120000, duplex: 100000, rent: [4000, 8000, 20000, 60000, 180000, 320000, 500000], meaning: 'Water world. Houses on stilts, rent on vibes, pride full ground.' },
  { type: 'card', deck: 'family', name: 'Family Meeting', short: 'Family Meeting' },
  { type: 'street', name: 'Ajegunle', short: 'Ajegunle', group: 'brown', art: 'ball', price: 140000, duplex: 100000, rent: [8000, 16000, 40000, 120000, 360000, 640000, 900000], meaning: 'AJ City. Ghetto pride, football factory, music no dey carry last.' },
  { type: 'tax', name: 'FIRS Income Tax', short: 'FIRS Tax', art: 'taxdoc', amount: 200000, meaning: 'Federal tax. Pay ₦200,000 flat, or 10 percent of everything you worth. Choose well.' },
  // ---- Corner: Kirikiri -------------------------------------------------------
  { type: 'jail', name: 'Kirikiri Prison', short: 'Kirikiri', art: 'bars', meaning: 'Kirikiri. If you just dey visit, no wahala. If dem send you here, na another story.' },
  // ---- Side 2 (left side) ---------------------------------------------------
  { type: 'street', name: 'Yaba', short: 'Yaba', group: 'lightblue', art: 'tech', price: 240000, duplex: 150000, rent: [16000, 32000, 80000, 200000, 600000, 900000, 1200000], meaning: 'Yabacon Valley. Tech money, student wahala, and Yaba left for the stories.' },
  { type: 'station', name: 'Lekki Tollgate', short: 'Lekki Toll', art: 'gate', price: 400000, meaning: 'Pay before you pass. Every car wey enter Lekki must drop something for this gate.' },
  { type: 'street', name: 'Surulere', short: 'Surulere', group: 'lightblue', art: 'stadium', price: 280000, duplex: 150000, rent: [24000, 48000, 120000, 360000, 1000000, 1400000, 1800000], meaning: 'Old Lagos pride. Stadium, nightlife, and real Lagos noise.' },
  { type: 'utility', name: 'NEPA (PHCN)', short: 'NEPA', art: 'pylon', price: 300000, meaning: 'Light people. The only utility on the board. Own am, and every dice roll for your side dey pay you. Up NEPA!' },
  // ---- Corner: Owambe Grounds -------------------------------------------------
  { type: 'freeparking', name: 'Owambe Grounds', short: 'Owambe', art: 'party', meaning: 'Owambe Grounds. Every fine, tax and fee for this game dey inside the pot here. Land here, collect everything.' },
  // ---- Side 3 (far side) ----------------------------------------------------
  { type: 'street', name: 'Oriental Hotel', short: 'Oriental', group: 'red', art: 'towers', price: 440000, duplex: 300000, rent: [36000, 72000, 180000, 500000, 1400000, 1750000, 2100000], meaning: 'Lekki Road landmark. Big conference, bigger owambe, everybody don pass the lobby.' },
  { type: 'card', deck: 'wahala', name: 'Wahala', short: 'Wahala' },
  { type: 'street', name: 'Quilox', short: 'Quilox', group: 'red', art: 'party', price: 470000, duplex: 300000, rent: [40000, 80000, 200000, 600000, 1500000, 1850000, 2200000], meaning: 'The club wey Lagos dey talk about. Bottles dey fly, money dey rain, bouncers dey watch.' },
  { type: 'station', name: 'Murtala Muhammed Intl Airport', short: 'MMIA Airport', art: 'plane', price: 400000, meaning: 'The japa gate. Every flight out of this country starts for this side.' },
  // ---- Corner: Go to Kirikiri -------------------------------------------------
  { type: 'gotojail', name: 'Go to Kirikiri', short: 'Go to Kirikiri', art: 'bars', meaning: 'Straight to Kirikiri. No START money, no story.' },
  // ---- Side 4 (right side) --------------------------------------------------
  { type: 'street', name: 'Victoria Island', short: 'V.I.', group: 'yellow', art: 'bank', price: 520000, duplex: 300000, rent: [45000, 90000, 225000, 670000, 1600000, 1950000, 2300000], meaning: 'Bank headquarters and champagne Lagos. Business first, sleep later.' },
  { type: 'street', name: 'Eko Hotel', short: 'Eko Hotel', group: 'yellow', art: 'dome', price: 550000, duplex: 300000, rent: [50000, 100000, 245000, 730000, 1700000, 2050000, 2400000], meaning: 'Eko Hotel and Suites. Every big wedding, every big show, every big man for one roof.' },
  { type: 'street', name: 'Eko Atlantic', short: 'Eko Atlantic', group: 'darkblue', art: 'crane', price: 680000, duplex: 400000, rent: [70000, 140000, 355000, 1000000, 2200000, 2600000, 3000000], meaning: 'City wey dem build from the sea. Sand fill, towers rise, abroad don come Lagos.' },
  { type: 'street', name: 'Banana Island', short: 'Banana Island', group: 'darkblue', art: 'island', price: 800000, duplex: 400000, rent: [100000, 200000, 400000, 1200000, 2800000, 3400000, 4000000], meaning: 'Final boss. If you get house here, you no need introduce yourself.' }
];

// Board geometry, derived once. Every renderer and the engine read these
// instead of hard coding a board length.
const BOARD_SIZE = SPACES.length;          // 20
const SIDE = BOARD_SIZE / 4;               // 5 steps per side
const indexOfType = (t) => SPACES.findIndex((s) => s.type === t);
const JAIL_INDEX = indexOfType('jail');          // 5
const PARKING_INDEX = indexOfType('freeparking'); // 10
const GOTOJAIL_INDEX = indexOfType('gotojail');  // 15
const INCOME_TAX_INDEX = SPACES.findIndex((s) => s.name === 'FIRS Income Tax'); // 4
const NEPA_INDEX = SPACES.findIndex((s) => s.name === 'NEPA (PHCN)');
const TOP_INDEX = SPACES.findIndex((s) => s.name === 'Banana Island');
// Station rent by number of stations one owner holds (1, 2, 3).
// board20 has two stations: one owned, both owned.
const STATION_RENT = [75000, 200000];
// Utility rent per dice pip. board20 has one utility (NEPA), so owning it
// is owning every utility: both steps are the same 10,000 per pip.
const UTILITY_PER_PIP = [10000, 10000];
// Bank building stock, scaled to 10 streets (24 and 9 for 16 streets).
const DUPLEX_SUPPLY = 16;
const MANSION_SUPPLY = 6;

// Group membership by space index, derived once.
const GROUP_SPACES = {};
SPACES.forEach((s, i) => { if (s.group) { (GROUP_SPACES[s.group] = GROUP_SPACES[s.group] || []).push(i); } });
const STATIONS = SPACES.map((s, i) => (s.type === 'station' ? i : -1)).filter((i) => i >= 0);
const UTILITIES = SPACES.map((s, i) => (s.type === 'utility' ? i : -1)).filter((i) => i >= 0);
const OWNABLE = SPACES.map((s, i) => (s.price ? i : -1)).filter((i) => i >= 0);

function mortgageOf(p) { return Math.floor(p / 2); }
function unmortgageCost(p) { const m = mortgageOf(p); return m + Math.round(m * 0.10); }

// ---------------------------------------------------------------------------
// Decks: 16 cards each. Composition rule from the research: at least half
// Universal per deck, at most 4 Era cards per deck. tag: 'U' universal,
// 'C' current habit, 'E' era. fx types are implemented in server.js.
// ---------------------------------------------------------------------------
const WAHALA = [
  { id: 'w01', tag: 'U', text: 'Advance to Banana Island. If you pass START, collect ₦200,000.', fx: { type: 'moveTo', space: TOP_INDEX } },
  { id: 'w02', tag: 'U', text: 'Go directly to Kirikiri. Do not pass START. Do not collect ₦200,000.', fx: { type: 'jail' } },
  { id: 'w03', tag: 'U', text: 'LASTMA don catch you. Park! Park! You drove one way at Oshodi. Pay a fine of ₦15,000 and register for retraining.', fx: { type: 'payBank', amount: 15000 } },
  { id: 'w04', tag: 'U', text: 'Advance to the nearest Station. If it is owned, pay the owner twice the normal rent.', fx: { type: 'moveNearest', kind: 'station', rentMult: 2 } },
  { id: 'w05', tag: 'U', text: 'Go-slow for Third Mainland Bridge no dey move at all. Go back 3 spaces.', fx: { type: 'moveBack', n: 3 } },
  { id: 'w06', tag: 'C', text: 'Fuel scarcity don hit town and your tanker just arrived. Collect ₦150,000.', fx: { type: 'bankPays', amount: 150000 } },
  { id: 'w07', tag: 'U', text: 'Omo onile don visit your site and work don stop. Pay the bank ₦25,000 for each duplex you own and ₦100,000 for each mansion.', fx: { type: 'repairs', perDuplex: 25000, perMansion: 100000 } },
  { id: 'w08', tag: 'U', text: 'Get Out of Kirikiri Free. Your uncle na senior officer. Keep this card until you need it, or sell it to another player.', fx: { type: 'goojf' } },
  { id: 'w09', tag: 'C', text: 'NEPA don take light for your street. Generator or darkness, na you sabi. Pay ₦20,000. If you own NEPA (PHCN), collect ₦20,000 instead.', fx: { type: 'nepaLight', amount: 20000 } },
  { id: 'w10', tag: 'C', text: 'Up NEPA! Light don come back and the whole street dey shout. Collect ₦15,000. If you own NEPA, collect ₦30,000.', fx: { type: 'upNepa', amount: 15000, ownerAmount: 30000 } },
  { id: 'w11', tag: 'E', text: 'You scratch recharge card, the last PIN number don peel. Pay ₦10,000 to buy another.', fx: { type: 'payBank', amount: 10000 } },
  { id: 'w12', tag: 'C', text: 'Fake alert! Your tenant don send you message wey no carry money. Lose the last rent you collected, up to ₦100,000.', fx: { type: 'fakeAlert', cap: 100000 } },
  { id: 'w13', tag: 'C', text: 'Transfer don hang. I don send am, e never drop. Keep this shield: the next rent you owe is halved, the rest forgiven by network wahala.', fx: { type: 'shield' } },
  { id: 'w14', tag: 'C', text: 'POS agent charge don enter 15 percent. Pay ₦15,000 to withdraw your own money.', fx: { type: 'payBank', amount: 15000 } },
  { id: 'w15', tag: 'E', text: 'Molue don pack up for road. Advance to the nearest Station. If it is owned, pay normal rent only.', fx: { type: 'moveNearest', kind: 'station', rentMult: 1 } },
  { id: 'w16', tag: 'C', text: 'Rain don fall for Lekki. Everywhere na swimming pool. If you own anything in the Hotels and Nightlife set (Oriental Hotel, Quilox), pay ₦15,000 for each one to pump water. If you own nothing there, collect ₦10,000.', fx: { type: 'lekkiRain', perProp: 15000, noneAmount: 10000 } }
];

const FAMILY = [
  { id: 'f01', tag: 'U', text: 'Family meeting don end. Advance to START and collect ₦200,000.', fx: { type: 'moveTo', space: 0 } },
  { id: 'f02', tag: 'U', text: 'Bank alert error favour you. Collect ₦200,000 from the bank. No, you no go report am.', fx: { type: 'bankPays', amount: 200000 } },
  { id: 'f03', tag: 'U', text: 'Your brother wey don japa to Canada send you money for Christmas. Collect ₦100,000.', fx: { type: 'bankPays', amount: 100000 } },
  { id: 'f04', tag: 'U', text: 'Aso-ebi, owambe spray and one canopy for your cousin wedding. Pay ₦100,000.', fx: { type: 'payBank', amount: 100000 } },
  { id: 'f05', tag: 'U', text: 'Na your birthday. Family meeting talk say make every player drop ₦10,000 for you. Collect ₦10,000 from each player.', fx: { type: 'collectEach', amount: 10000 } },
  { id: 'f06', tag: 'U', text: 'Omo onile settlement for your street. Pay ₦40,000 for each duplex you own and ₦115,000 for each mansion.', fx: { type: 'repairs', perDuplex: 40000, perMansion: 115000 } },
  { id: 'f07', tag: 'U', text: 'Your Ankara design win second prize for the cultural day contest. Collect ₦10,000.', fx: { type: 'bankPays', amount: 10000 } },
  { id: 'f08', tag: 'U', text: 'Police raid your viewing centre during Champions League night. Go directly to Kirikiri. Do not pass START.', fx: { type: 'jail' } },
  { id: 'f09', tag: 'E', text: 'Per second billing don land! Your phone money finally dey breathe. Collect ₦20,000.', fx: { type: 'bankPays', amount: 20000 } },
  { id: 'f10', tag: 'E', text: 'Money order from your uncle for abroad don reach post office. Collect ₦50,000.', fx: { type: 'bankPays', amount: 50000 } },
  { id: 'f11', tag: 'C', text: 'WAEC lesson money don due for your younger ones. Pay ₦25,000.', fx: { type: 'payBank', amount: 25000 } },
  { id: 'f12', tag: 'E', text: 'You win monkey post for your street. Holder of the small ball, champion of the close. Collect ₦10,000.', fx: { type: 'bankPays', amount: 10000 } },
  { id: 'f13', tag: 'C', text: 'Allowee alert don enter! Corper allowee don rise to ₦77,000, and your cousin wey dey serve don send you part of it. Collect ₦30,000.', fx: { type: 'bankPays', amount: 30000 } },
  { id: 'f14', tag: 'E', text: 'Story story! Tales by Moonlight don teach you sense. Take back one fine you paid this game, up to ₦20,000.', fx: { type: 'fineRefund', cap: 20000 } },
  { id: 'f15', tag: 'C', text: 'End of month don reach. Sapa dey visit everybody. Every player with more than ₦1,000,000 pays ₦20,000 into the Owambe pot. Players under ₦200,000 collect ₦10,000 from the bank.', fx: { type: 'sapa' } },
  { id: 'f16', tag: 'C', text: 'Your C of O don finally ready. Lift one mortgage free, no 10 percent interest.', fx: { type: 'freeUnmortgage' } }
];

const TOKENS = [
  { id: 'danfo', name: 'Danfo' },
  { id: 'keke', name: 'Keke Napep' },
  { id: 'okada', name: 'Okada' },
  { id: 'generator', name: 'Generator' },
  { id: 'boot', name: 'Football Boot' },
  { id: 'fila', name: 'Fila' }
];

const PLAYER_COLORS = ['#ff6b4a', '#ffc857', '#39c2a5', '#5aa9e6', '#c39bff', '#ff8fb2'];

const DATA = { BOARD_SIZE, SIDE, JAIL_INDEX, PARKING_INDEX, GOTOJAIL_INDEX, INCOME_TAX_INDEX, NEPA_INDEX, TOP_INDEX, STATION_RENT, UTILITY_PER_PIP, DUPLEX_SUPPLY, MANSION_SUPPLY, fmtN, DENOMS, START_CASH, START_PAY, JAIL_FINE, GROUPS, SPACES, GROUP_SPACES, STATIONS, UTILITIES, OWNABLE, WAHALA, FAMILY, TOKENS, PLAYER_COLORS, mortgageOf, unmortgageCost };
if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
if (typeof window !== 'undefined') window.KP_DATA = DATA;
