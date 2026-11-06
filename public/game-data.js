'use strict';
// KOLOPOLY game data. One content source for the server and the client.
// board28 (docs/BOARD28-HUSTLE-OWAMBE.md): a 28 space, all Lagos board,
// 7 steps a side (4 corners + 6 middle tiles per side), with raised prices
// and rent ladders. Kirikiri stays the jail (7) and Go to Kirikiri (21).
// The old 40 space board lives only in game-host.js LEGACY_40, used to
// migrate saved rooms.
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
  pink:     { name: 'Old Lagos Middle',      color: '#d94f9e' },
  orange:   { name: 'Ikeja Side',            color: '#f08c28' },
  red:      { name: 'Hotels and Nightlife',  color: '#d63a2f' },
  yellow:   { name: 'Corporate and Capital', color: '#e8c62a' },
  green:    { name: 'Old Money',             color: '#2e9e5b' },
  darkblue: { name: 'The Final Boss',        color: '#2b3f9e' }
};

// type: start | street | station | utility | card | tax | jail |
//       freeparking | gotojail
// deck on card spaces: 'wahala' or 'family'
// KOLOPOLY 28 (board28): 28 spaces, 7 per side counting each corner once
// (4 corners + 6 middle tiles per side). Fewer, bigger tiles read clearly on
// a 360 to 430px phone. A lap is 28 spaces instead of 40, so START comes
// round about 1.4 times as often; deeds, duplexes and rents are raised
// about 1.5x so land still feels valuable and rent still bites.
// art: emblem key shared by the 2D (board.js) and 3D (board3d.js) renderers.
const SPACES = [
  // ---- Side 1 (near side): START to Kirikiri --------------------------------
  { type: 'start', name: 'START', short: 'START', art: 'payday', meaning: 'Every lap starts here. Pass am, salary alert go enter.' },
  { type: 'street', name: 'Makoko', short: 'Makoko', group: 'brown', art: 'stilts', price: 90000, duplex: 75000, rent: [3000, 6000, 15000, 45000, 135000, 240000, 375000], meaning: 'Water world. Houses on stilts, rent on vibes, pride full ground.' },
  { type: 'card', deck: 'family', name: 'Family Meeting', short: 'Family Meeting' },
  { type: 'street', name: 'Ajegunle', short: 'Ajegunle', group: 'brown', art: 'ball', price: 100000, duplex: 75000, rent: [6000, 12000, 30000, 90000, 270000, 480000, 675000], meaning: 'AJ City. Ghetto pride, football factory, music no dey carry last.' },
  { type: 'tax', name: 'FIRS Income Tax', short: 'FIRS Tax', art: 'taxdoc', amount: 200000, meaning: 'Federal tax. Pay ₦200,000 flat, or 10 percent of everything you worth. Choose well.' },
  { type: 'station', name: 'Oshodi Transport Interchange', short: 'Oshodi', art: 'interchange', price: 300000, meaning: 'Danfo capital of the world. Every road for Lagos dey pass here.' },
  { type: 'street', name: 'Mushin', short: 'Mushin', group: 'lightblue', art: 'stalls', price: 160000, duplex: 100000, rent: [9000, 18000, 45000, 135000, 405000, 600000, 825000], meaning: 'No dull yourself here. Mushin boys no dey fear anything.' },
  // ---- Corner: Kirikiri -------------------------------------------------------
  { type: 'jail', name: 'Kirikiri Prison', short: 'Kirikiri', art: 'bars', meaning: 'Kirikiri. If you just dey visit, no wahala. If dem send you here, na another story.' },
  // ---- Side 2 (left side) ---------------------------------------------------
  { type: 'street', name: 'Yaba', short: 'Yaba', group: 'lightblue', art: 'tech', price: 180000, duplex: 100000, rent: [12000, 24000, 60000, 150000, 450000, 675000, 900000], meaning: 'Yabacon Valley. Tech money, student wahala, and Yaba left for the stories.' },
  { type: 'utility', name: 'NEPA (PHCN)', short: 'NEPA', art: 'pylon', price: 225000, meaning: 'Light people. Own am, and every dice roll for your side dey pay you. Up NEPA!' },
  { type: 'street', name: 'Ebute Metta', short: 'Ebute Metta', group: 'pink', art: 'house', price: 220000, duplex: 150000, rent: [15000, 30000, 75000, 225000, 675000, 940000, 1125000], meaning: 'Three shores, old railway blood, Brazilian houses wey still dey stand.' },
  { type: 'street', name: 'Surulere', short: 'Surulere', group: 'pink', art: 'stadium', price: 240000, duplex: 150000, rent: [18000, 36000, 90000, 270000, 750000, 1050000, 1350000], meaning: 'Old Lagos pride. Stadium, nightlife, and real Lagos noise.' },
  { type: 'station', name: 'Lekki Tollgate', short: 'Lekki Toll', art: 'gate', price: 300000, meaning: 'Pay before you pass. Every car wey enter Lekki must drop something for this gate.' },
  { type: 'street', name: 'Allen Avenue', short: 'Allen', group: 'orange', art: 'computer', price: 280000, duplex: 150000, rent: [21000, 42000, 105000, 300000, 825000, 1125000, 1425000], meaning: 'Ikeja side hustle money. Small avenue, big transaction, bigger stories.' },
  // ---- Corner: Owambe Grounds -------------------------------------------------
  { type: 'freeparking', name: 'Owambe Grounds', short: 'Owambe', art: 'party', meaning: 'Owambe Grounds. Every fine, tax and fee for this game dey inside the pot here. Land here, collect everything.' },
  // ---- Side 3 (far side) ----------------------------------------------------
  { type: 'street', name: 'Ikeja GRA', short: 'Ikeja GRA', group: 'orange', art: 'palms', price: 300000, duplex: 150000, rent: [24000, 48000, 120000, 330000, 900000, 1200000, 1500000], meaning: 'The capital side. Government quarters calm inside mainland storm.' },
  { type: 'card', deck: 'wahala', name: 'Wahala', short: 'Wahala' },
  { type: 'street', name: 'Oriental Hotel', short: 'Oriental', group: 'red', art: 'towers', price: 340000, duplex: 225000, rent: [27000, 54000, 135000, 375000, 1050000, 1315000, 1575000], meaning: 'Lekki Road landmark. Big conference, bigger owambe, everybody don pass the lobby.' },
  { type: 'street', name: 'Quilox', short: 'Quilox', group: 'red', art: 'party', price: 360000, duplex: 225000, rent: [30000, 60000, 150000, 450000, 1125000, 1390000, 1650000], meaning: 'The club wey Lagos dey talk about. Bottles dey fly, money dey rain, bouncers dey watch.' },
  { type: 'station', name: 'Murtala Muhammed Intl Airport', short: 'MMIA Airport', art: 'plane', price: 300000, meaning: 'The japa gate. Every flight out of this country starts for this side.' },
  { type: 'street', name: 'Victoria Island', short: 'V.I.', group: 'yellow', art: 'bank', price: 400000, duplex: 225000, rent: [33000, 66000, 165000, 495000, 1200000, 1465000, 1725000], meaning: 'Bank headquarters and champagne Lagos. Business first, sleep later.' },
  // ---- Corner: Go to Kirikiri -------------------------------------------------
  { type: 'gotojail', name: 'Go to Kirikiri', short: 'Go to Kirikiri', art: 'bars', meaning: 'Straight to Kirikiri. No START money, no story.' },
  // ---- Side 4 (right side) --------------------------------------------------
  { type: 'street', name: 'Eko Hotel', short: 'Eko Hotel', group: 'yellow', art: 'dome', price: 420000, duplex: 225000, rent: [36000, 72000, 180000, 540000, 1275000, 1540000, 1800000], meaning: 'Eko Hotel and Suites. Every big wedding, every big show, every big man for one roof.' },
  { type: 'utility', name: 'Water Board', short: 'Water Board', art: 'watertower', price: 225000, meaning: 'Water people. Own am with NEPA and your tenants go pay proper utility money.' },
  { type: 'street', name: 'Ikoyi', short: 'Ikoyi', group: 'green', art: 'mansion', price: 460000, duplex: 300000, rent: [39000, 78000, 195000, 585000, 1350000, 1650000, 1915000], meaning: 'Old money headquarters. High gates, low voices.' },
  { type: 'street', name: 'Bourdillon, Ikoyi', short: 'Bourdillon', group: 'green', art: 'towers', price: 480000, duplex: 300000, rent: [42000, 84000, 225000, 675000, 1500000, 1800000, 2100000], meaning: 'The most expensive street for Nigeria. Houses start where sense end.' },
  { type: 'street', name: 'Eko Atlantic', short: 'Eko Atlantic', group: 'darkblue', art: 'crane', price: 520000, duplex: 300000, rent: [53000, 105000, 263000, 750000, 1650000, 1950000, 2250000], meaning: 'City wey dem build from the sea. Sand fill, towers rise, abroad don come Lagos.' },
  { type: 'street', name: 'Banana Island', short: 'Banana Island', group: 'darkblue', art: 'island', price: 600000, duplex: 300000, rent: [75000, 150000, 300000, 900000, 2100000, 2550000, 3000000], meaning: 'Final boss. If you get house here, you no need introduce yourself.' }
];

// Board geometry, derived once. Every renderer and the engine read these
// instead of hard coding a board length.
const BOARD_SIZE = SPACES.length;          // 28
const SIDE = BOARD_SIZE / 4;               // 7 steps per side
const indexOfType = (t) => SPACES.findIndex((s) => s.type === t);
const JAIL_INDEX = indexOfType('jail');          // 7
const PARKING_INDEX = indexOfType('freeparking'); // 14
const GOTOJAIL_INDEX = indexOfType('gotojail');  // 21
const INCOME_TAX_INDEX = SPACES.findIndex((s) => s.name === 'FIRS Income Tax'); // 4
const NEPA_INDEX = SPACES.findIndex((s) => s.name === 'NEPA (PHCN)');
const TOP_INDEX = SPACES.findIndex((s) => s.name === 'Banana Island');
// Station rent by number of stations one owner holds (1, 2, 3).
const STATION_RENT = [50000, 100000, 200000];
// Utility rent per dice pip: one utility, both utilities.
const UTILITY_PER_PIP = [6000, 15000];
// Bank building stock, scaled to 16 streets (was 32 and 12 for 22 streets).
const DUPLEX_SUPPLY = 24;
const MANSION_SUPPLY = 9;

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
