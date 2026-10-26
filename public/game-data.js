'use strict';
// KOLOPOLY game data. One content source for the server and the client.
// Board, prices and rent ladders come from the design brief
// (~/workspace/research_notes/kolopoly-design-brief-20261026.md) with the
// two board swaps from the nostalgia research: space 24 is GRA, Port
// Harcourt and space 29 is Maitama, Abuja, prices unchanged.
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
  orange:   { name: 'The Capital Side',      color: '#f08c28' },
  red:      { name: 'New Money Corridor',    color: '#d63a2f' },
  yellow:   { name: 'Corporate and Capital', color: '#e8c62a' },
  green:    { name: 'Old Money',             color: '#2e9e5b' },
  darkblue: { name: 'The Final Boss',        color: '#2b3f9e' }
};

// type: start | street | station | utility | card | tax | jail |
//       freeparking | gotojail
// deck on card spaces: 'wahala' or 'family'
const SPACES = [
  { type: 'start', name: 'START', short: 'START', meaning: 'Every lap starts here. Pass am, salary alert go enter.' },
  { type: 'street', name: 'Makoko', short: 'Makoko', group: 'brown', price: 60000, duplex: 50000, rent: [2000, 4000, 10000, 30000, 90000, 160000, 250000], meaning: 'Water world. Houses on stilts, rent on vibes, pride full ground.' },
  { type: 'card', deck: 'family', name: 'Family Meeting', short: 'Family Meeting' },
  { type: 'street', name: 'Ajegunle', short: 'Ajegunle', group: 'brown', price: 60000, duplex: 50000, rent: [4000, 8000, 20000, 60000, 180000, 320000, 450000], meaning: 'AJ City. Ghetto pride, football factory, music no dey carry last.' },
  { type: 'tax', name: 'FIRS Income Tax', short: 'FIRS Tax', amount: 200000, meaning: 'Federal tax. Pay ₦200,000 flat, or 10 percent of everything you worth. Choose well.' },
  { type: 'station', name: 'Iddo Terminus', short: 'Iddo', price: 200000, meaning: 'The old rail heart of Lagos. Trains, traders and travellers since forever.' },
  { type: 'street', name: 'Mushin', short: 'Mushin', group: 'lightblue', price: 100000, duplex: 50000, rent: [6000, 12000, 30000, 90000, 270000, 400000, 550000], meaning: 'No dull yourself here. Mushin boys no dey fear anybody.' },
  { type: 'card', deck: 'wahala', name: 'Wahala', short: 'Wahala' },
  { type: 'street', name: 'Bariga', short: 'Bariga', group: 'lightblue', price: 100000, duplex: 50000, rent: [6000, 12000, 30000, 90000, 270000, 400000, 550000], meaning: 'Mainland heart. Small money, big noise, everybody sabi everybody.' },
  { type: 'street', name: 'Agege', short: 'Agege', group: 'lightblue', price: 120000, duplex: 50000, rent: [8000, 16000, 40000, 100000, 300000, 450000, 600000], meaning: 'Home of Agege bread. If you never chop am with ewa agoyin, you never ready.' },
  { type: 'jail', name: 'Kirikiri Prison', short: 'Kirikiri', meaning: 'Kirikiri. If you just dey visit, no wahala. If dem send you here, na another story.' },
  { type: 'street', name: 'Ebute Metta', short: 'Ebute Metta', group: 'pink', price: 140000, duplex: 100000, rent: [10000, 20000, 50000, 150000, 450000, 625000, 750000], meaning: 'Three shores, old railway blood, Brazilian houses wey don see everything.' },
  { type: 'utility', name: 'NEPA (PHCN)', short: 'NEPA', price: 150000, meaning: 'Light people. Own am, and every dice roll for your side dey pay you. Up NEPA!' },
  { type: 'street', name: 'Yaba', short: 'Yaba', group: 'pink', price: 140000, duplex: 100000, rent: [10000, 20000, 50000, 150000, 450000, 625000, 750000], meaning: 'Yabacon Valley. Tech money, student wahala, and Yaba Left wey everybody dey joke.' },
  { type: 'street', name: 'Surulere', short: 'Surulere', group: 'pink', price: 160000, duplex: 100000, rent: [12000, 24000, 60000, 180000, 500000, 700000, 900000], meaning: 'Old Lagos pride. Stadium, nightlife, and respect wey money no fit buy.' },
  { type: 'station', name: 'Murtala Muhammed Intl Airport', short: 'MMIA Airport', price: 200000, meaning: 'The japa gate. Every flight out of this country starts for this side.' },
  { type: 'street', name: 'Maryland', short: 'Maryland', group: 'orange', price: 180000, duplex: 100000, rent: [14000, 28000, 70000, 200000, 550000, 750000, 950000], meaning: 'GRA calm inside mainland storm. Quiet streets, serious landlords.' },
  { type: 'card', deck: 'family', name: 'Family Meeting', short: 'Family Meeting' },
  { type: 'street', name: 'Opebi', short: 'Opebi', group: 'orange', price: 180000, duplex: 100000, rent: [14000, 28000, 70000, 200000, 550000, 750000, 950000], meaning: 'Allen side hustle money. Small street, big transactions.' },
  { type: 'street', name: 'Ikeja', short: 'Ikeja', group: 'orange', price: 200000, duplex: 100000, rent: [16000, 32000, 80000, 220000, 600000, 800000, 1000000], meaning: 'The capital. Computer Village cash, government paper, traffic as tax.' },
  { type: 'freeparking', name: 'Owambe Grounds', short: 'Owambe', meaning: 'Owambe Grounds. Every fine, tax and fee for this game dey inside the pot here. Land here, collect everything.' },
  { type: 'street', name: 'Ajah', short: 'Ajah', group: 'red', price: 220000, duplex: 150000, rent: [18000, 36000, 90000, 250000, 700000, 875000, 1050000], meaning: 'Lekki corridor starter pack. New estates, old flood, long traffic.' },
  { type: 'card', deck: 'wahala', name: 'Wahala', short: 'Wahala' },
  { type: 'street', name: 'Lekki Phase 1', short: 'Lekki Ph 1', group: 'red', price: 220000, duplex: 150000, rent: [18000, 36000, 90000, 250000, 700000, 875000, 1050000], meaning: 'New money uniform. If your estate no get gate, you never arrive.' },
  { type: 'street', name: 'GRA, Port Harcourt', short: 'GRA PH', group: 'red', price: 240000, duplex: 150000, rent: [20000, 40000, 100000, 300000, 750000, 925000, 1100000], meaning: 'Oil money old guard. Quiet, green, and very sure of itself.' },
  { type: 'station', name: 'Apapa Port', short: 'Apapa Port', price: 200000, meaning: 'Where containers land. If Nigeria imports am, e pass here first.' },
  { type: 'street', name: 'Oniru', short: 'Oniru', group: 'yellow', price: 260000, duplex: 150000, rent: [22000, 44000, 110000, 330000, 800000, 975000, 1150000], meaning: 'Village boy wey don blow. New wealth, no apology.' },
  { type: 'street', name: 'Victoria Island', short: 'V.I.', group: 'yellow', price: 260000, duplex: 150000, rent: [22000, 44000, 110000, 330000, 800000, 975000, 1150000], meaning: 'Bank headquarters and champagne Lagos. Business first, sleep later.' },
  { type: 'utility', name: 'Water Board', short: 'Water Board', price: 150000, meaning: 'Water people. Own am with NEPA and your tenants go pay proper utility money.' },
  { type: 'street', name: 'Maitama, Abuja', short: 'Maitama', group: 'yellow', price: 280000, duplex: 150000, rent: [24000, 48000, 120000, 360000, 850000, 1025000, 1200000], meaning: 'Capital old money. Ministers, embassies, and silence wey cost billions.' },
  { type: 'gotojail', name: 'Go to Kirikiri', short: 'Go to Kirikiri', meaning: 'Straight to Kirikiri. No START money, no story.' },
  { type: 'street', name: 'Ikoyi', short: 'Ikoyi', group: 'green', price: 300000, duplex: 200000, rent: [26000, 52000, 130000, 390000, 900000, 1100000, 1275000], meaning: 'Old money headquarters. High gates, low voices.' },
  { type: 'street', name: 'Osborne, Ikoyi', short: 'Osborne', group: 'green', price: 300000, duplex: 200000, rent: [26000, 52000, 130000, 390000, 900000, 1100000, 1275000], meaning: 'Foreshore calm. Corporate oga dem dey hide here.' },
  { type: 'card', deck: 'family', name: 'Family Meeting', short: 'Family Meeting' },
  { type: 'street', name: 'Bourdillon, Ikoyi', short: 'Bourdillon', group: 'green', price: 320000, duplex: 200000, rent: [28000, 56000, 150000, 450000, 1000000, 1200000, 1400000], meaning: 'The most expensive street for Nigeria. Houses start where sense end.' },
  { type: 'station', name: 'Oshodi Transport Interchange', short: 'Oshodi', price: 200000, meaning: 'Danfo capital of the world. Every road for Lagos dey pass here.' },
  { type: 'card', deck: 'wahala', name: 'Wahala', short: 'Wahala' },
  { type: 'street', name: 'Parkview Estate, Ikoyi', short: 'Parkview', group: 'darkblue', price: 350000, duplex: 200000, rent: [35000, 70000, 175000, 500000, 1100000, 1300000, 1500000], meaning: 'Estate wey fine like abroad. Accent sef don change.' },
  { type: 'tax', name: 'Lagos Consumption Tax', short: 'Lagos Tax', amount: 100000, meaning: 'Lagos State consumption tax. Flat ₦100,000. The city must chop too.' },
  { type: 'street', name: 'Banana Island', short: 'Banana Island', group: 'darkblue', price: 400000, duplex: 200000, rent: [50000, 100000, 200000, 600000, 1400000, 1700000, 2000000], meaning: 'Final boss. If you get house here, you no need introduce yourself.' }
];

// Group membership by space index, derived once.
const GROUP_SPACES = {};
SPACES.forEach((s, i) => { if (s.group) { (GROUP_SPACES[s.group] = GROUP_SPACES[s.group] || []).push(i); } });
const STATIONS = [5, 15, 25, 35];
const UTILITIES = [12, 28];
const OWNABLE = SPACES.map((s, i) => (s.price ? i : -1)).filter((i) => i >= 0);

function mortgageOf(p) { return Math.floor(p / 2); }
function unmortgageCost(p) { const m = mortgageOf(p); return m + Math.round(m * 0.10); }

// ---------------------------------------------------------------------------
// Decks: 16 cards each. Composition rule from the research: at least half
// Universal per deck, at most 4 Era cards per deck. tag: 'U' universal,
// 'C' current habit, 'E' era. fx types are implemented in server.js.
// ---------------------------------------------------------------------------
const WAHALA = [
  { id: 'w01', tag: 'U', text: 'Advance to Banana Island. If you pass START, collect ₦200,000.', fx: { type: 'moveTo', space: 39 } },
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
  { id: 'w16', tag: 'C', text: 'Rain don fall for Lekki. Everywhere na swimming pool. If you own anything in the New Money Corridor set, pay ₦15,000 for each one to pump water. If you own nothing there, collect ₦10,000.', fx: { type: 'lekkiRain', perProp: 15000, noneAmount: 10000 } }
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
  { id: 'f13', tag: 'C', text: 'Allowee alert don enter. Corper wey dey serve don see small joy. Collect ₦30,000.', fx: { type: 'bankPays', amount: 30000 } },
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

const DATA = { fmtN, DENOMS, START_CASH, START_PAY, JAIL_FINE, GROUPS, SPACES, GROUP_SPACES, STATIONS, UTILITIES, OWNABLE, WAHALA, FAMILY, TOKENS, PLAYER_COLORS, mortgageOf, unmortgageCost };
if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
if (typeof window !== 'undefined') window.KP_DATA = DATA;
