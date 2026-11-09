// The push roundtrip is a test hook. It must answer only when KP_TEST is on,
// on the Node handler and on the Worker fetch handler (same module).
// The shelf v2 section below proves the kolo redesign: conversion, the
// kolo and its ticket, second chance, the postcard album, cosmetics,
// the streak rules, and byte-stable v1 answers for legacy clients.
import { Readable } from 'node:stream';
import { createRetention, SHELF_V2, ALBUM } from './retention.js';

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else {
    failures += 1;
    console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : ''));
  }
}

function mockRes() {
  const res = {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(status) { res.status = status; },
    end(body) { res.body = String(body); res.headersSent = true; }
  };
  return res;
}

const off = createRetention({ memory: true, test: false, env: {} });
check('a live shelf does not accept the roundtrip route', off.accepts({ url: '/api/test/push-roundtrip' }) === false);
const offNode = mockRes();
off.handle({ method: 'GET', url: '/api/test/push-roundtrip', headers: {} }, offNode);
await new Promise((resolve) => setImmediate(resolve));
check('the Node handler does not run the roundtrip when the test flag is off', offNode.status === 404, String(offNode.status) + ' ' + offNode.body);

const offFetch = await off.handleFetch(new Request('http://kolopoly.test/api/test/push-roundtrip'));
const offJson = await offFetch.json();
check('the Worker handler does not run the roundtrip when the test flag is off', offFetch.status === 404 && offJson.ok === false, String(offFetch.status));

const on = createRetention({ memory: true, test: true, env: {} });
check('a test shelf accepts the roundtrip route', on.accepts({ url: '/api/test/push-roundtrip' }) === true);
const onNode = mockRes();
on.handle({ method: 'GET', url: '/api/test/push-roundtrip', headers: {} }, onNode);
await new Promise((resolve) => setImmediate(resolve));
check('the Node handler still roundtrips when KP_TEST is on', onNode.status === 200 && JSON.parse(onNode.body).ok === true, onNode.body);
const onFetch = await on.handleFetch(new Request('http://kolopoly.test/api/test/push-roundtrip'));
const onJson = await onFetch.json();
check('the Worker handler still roundtrips when KP_TEST is on', onFetch.status === 200 && onJson.ok === true, JSON.stringify(onJson));

// ---------------------------------------------------------------------
// Shelf v2. One memory shelf with pinned test VAPID keys, so response
// bodies are byte-predictable. The v1 fixtures below were captured
// from the pre-redesign module; a legacy client must see those exact
// bytes before and after every v2 event on the same shelf.
// ---------------------------------------------------------------------
const TEST_VAPID = {
  VAPID_PUBLIC_KEY: 'BB-a8hjeY6_XCw9pQ8ThQ2zIa_Mpxi50DrJzSwQ4q81BuiW7a0h2vDh8xRHt_JrRvyya0S3V-3QhrmgEamKWKNs',
  VAPID_PRIVATE_KEY: 'P-ORRY3tlRVF_yV1eFtJOvvMsGJS22DxWVgXsZl4jT0',
  VAPID_SUBJECT: 'mailto:test@kolopoly.local'
};
const ret = createRetention({ memory: true, test: true, env: TEST_VAPID });
const raw = async (path, init) => {
  const r = await ret.handleFetch(new Request('http://kolopoly.test' + path, init || {}));
  return { status: r.status, text: await r.text() };
};
const getRaw = (path) => raw(path);
const postRaw = (path, body) => raw(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = async (path) => { const r = await getRaw(path); return { status: r.status, body: JSON.parse(r.text) }; };
const post = async (path, body) => { const r = await postRaw(path, body); return { status: r.status, body: JSON.parse(r.text) }; };
const claimV1 = (id, day) => post('/api/retention/claim', { clientId: id, day });
const claimV2 = (id, day) => post('/api/retention/claim', { clientId: id, v: 2, day });
const viewV1 = (id, day) => get('/api/retention?clientId=' + id + '&day=' + day);
const viewV2 = (id, day) => get('/api/retention?v=2&clientId=' + id + '&day=' + day);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const PUSH_JSON = '"push":{"enabled":true,"publicKey":"' + TEST_VAPID.VAPID_PUBLIC_KEY + '","subscribed":false,"muted":false,"denied":false}';
const USES_JSON = '"uses":{"cowries":{"cost":3,"kind":"cash","amount":50000},"kola":{"cost":1,"kind":"rent","amount":100000},"yams":{"cost":1,"kind":"fee","amount":200000},"cloth":{"cost":1,"kind":"cash","amount":150000}}';
const FIXTURES = [
  '{"ok":true,"day":"2026-11-02","canClaim":true,"warmReady":false,"claimCount":0,"inventory":{"cowries":0,"kola":0,"yams":0,"cloth":0},' + PUSH_JSON + ',"nextDrop":{"cowries":6,"kola":2,"yams":1,"cloth":1},' + USES_JSON + '}',
  '{"ok":true,"day":"2026-11-02","canClaim":false,"warmReady":false,"claimCount":1,"inventory":{"cowries":6,"kola":2,"yams":1,"cloth":1},' + PUSH_JSON + ',"nextDrop":null,' + USES_JSON + ',"already":false,"first":true,"warm":false,"granted":{"cowries":6,"kola":2,"yams":1,"cloth":1},"line":"Cowries, kola, yam and cloth don enter your shelf. Spend them inside a match."}',
  '{"ok":true,"day":"2026-11-02","canClaim":false,"warmReady":false,"claimCount":1,"inventory":{"cowries":6,"kola":2,"yams":1,"cloth":1},' + PUSH_JSON + ',"nextDrop":null,' + USES_JSON + '}',
  '{"ok":true,"day":"2026-11-03","canClaim":false,"warmReady":false,"claimCount":2,"inventory":{"cowries":15,"kola":5,"yams":2,"cloth":2},' + PUSH_JSON + ',"nextDrop":null,' + USES_JSON + ',"already":false,"first":false,"warm":true,"granted":{"cowries":9,"kola":3,"yams":1,"cloth":1},"line":"Market remember you from yesterday. Extra cowries and kola dey your shelf. Spend them inside a match."}',
  '{"ok":true,"day":"2026-11-03","canClaim":false,"warmReady":false,"claimCount":2,"inventory":{"cowries":15,"kola":5,"yams":2,"cloth":2},' + PUSH_JSON + ',"nextDrop":null,' + USES_JSON + ',"already":true,"first":false,"warm":false,"granted":null,"line":"You don collect today market drop. The next one opens with Lagos dawn."}'
];
async function legacyFlow(id) {
  const out = [];
  out.push((await getRaw('/api/retention?clientId=' + id + '&day=2026-11-02')).text);
  out.push((await postRaw('/api/retention/claim', { clientId: id, day: '2026-11-02' })).text);
  out.push((await getRaw('/api/retention?clientId=' + id + '&day=2026-11-02')).text);
  out.push((await postRaw('/api/retention/claim', { clientId: id, day: '2026-11-03' })).text);
  out.push((await postRaw('/api/retention/claim', { clientId: id, day: '2026-11-03' })).text);
  return out;
}
{
  const got = await legacyFlow('legacy-0001');
  for (let i = 0; i < FIXTURES.length; i++) {
    check('v1 fixture ' + 'ABCDE'[i] + ' is byte-stable for a legacy client', got[i] === FIXTURES[i], got[i]);
  }
}

check('the ticket settings carry the launch defaults', SHELF_V2.piecesNeeded === 7 && SHELF_V2.ticket.tableFee === 200 && SHELF_V2.ticket.credit === 200 && SHELF_V2.ticket.table === 'Ibadan');
check('the album holds the 12 board cards', ALBUM.length === 12 && ALBUM.some((c) => c.id === 'banana-island') && ALBUM.some((c) => c.id === 'mmia-airport'));
check('the gift route is accepted', ret.accepts({ url: '/api/retention/gift' }) === true);

// Conversion: a veteran of the old shelf moves once, generously.
{
  await claimV1('veteran-0001', '2026-11-02');
  await claimV1('veteran-0001', '2026-11-03');
  await claimV1('veteran-0001', '2026-11-04');
  const before = await viewV1('veteran-0001', '2026-11-04');
  check('the veteran holds 38 old goods before the move', before.body.inventory.cowries === 24 && before.body.inventory.kola === 8 && before.body.inventory.yams === 3 && before.body.inventory.cloth === 3, JSON.stringify(before.body.inventory));
  const moved = await viewV2('veteran-0001', '2026-11-04');
  const conv = moved.body.conversion;
  check('conversion shows the stored goods it ate', !!conv && conv.goods.cowries === 24 && conv.goods.kola === 8 && conv.goods.yams === 3 && conv.goods.cloth === 3, JSON.stringify(conv));
  check('conversion pays 6 pieces for 38 goods', !!conv && conv.pieces === 6, JSON.stringify(conv));
  check('conversion pays 3 distinct postcards', !!conv && conv.postcards.length === 3 && new Set(conv.postcards).size === 3, JSON.stringify(conv));
  check('the converted pieces sit in the kolo', moved.body.kolo.pieces === 6, JSON.stringify(moved.body.kolo));
  const v1After = await viewV1('veteran-0001', '2026-11-04');
  check('the old goods zero out at conversion', v1After.body.inventory.cowries === 0 && v1After.body.inventory.kola === 0 && v1After.body.inventory.yams === 0 && v1After.body.inventory.cloth === 0);
  check('the v1 drop closes for a converted player', v1After.body.canClaim === false && v1After.body.nextDrop === null);
  const again = await viewV2('veteran-0001', '2026-11-04');
  check('the conversion shows exactly once', again.body.conversion === null);
  const v1Claim = await claimV1('veteran-0001', '2026-11-05');
  check('a v1 claim after conversion grants nothing', v1Claim.body.already === true && v1Claim.body.granted === null, JSON.stringify(v1Claim.body));
  ret.markPlayed(['veteran-0001'], '2026-11-05');
  const c = await claimV2('veteran-0001', '2026-11-05');
  check('the seventh piece breaks the converted kolo', c.body.chest === 'broke' && c.body.kolo.pieces === 0, JSON.stringify(c.body.kolo));
  check('the conversion ticket carries the rules', !!c.body.kolo.ticket && c.body.kolo.ticket.tableFee === 200 && c.body.kolo.ticket.credit === 200 && c.body.kolo.ticket.expiresDay === '2026-11-19' && c.body.kolo.ticket.transferable === false, JSON.stringify(c.body.kolo.ticket));
}

// The kolo: pieces daily, one ticket held, a waiting kolo, a lapse.
{
  let d7 = null;
  let d8 = null;
  let d13 = null;
  let last = null;
  for (let d = 2; d <= 13; d++) {
    const day = '2026-11-' + String(d).padStart(2, '0');
    ret.markPlayed(['kolo-00001'], day);
    last = await claimV2('kolo-00001', day);
    if (d === 2) check('day one drops a piece and a Rent Shield', last.body.kolo.pieces === 1 && last.body.granted.secondChance === 'rentShield', JSON.stringify(last.body.granted));
    if (d === 3) check('day two alternates to a Bail Card', last.body.granted.secondChance === 'bailCard' && last.body.secondChance.length === 2, JSON.stringify(last.body.secondChance));
    if (d === 4) check('the second-chance hand caps at two', last.body.granted.secondChance === null && last.body.secondChance.length === 2, JSON.stringify(last.body.secondChance));
    if (d === 6) check('a lapsed shield frees the hand for the next one', last.body.granted.secondChance === 'rentShield', JSON.stringify(last.body.granted));
    if (d === 8) d7 = last;
    if (d === 9) d8 = last;
    if (d === 13) d13 = last;
  }
  const t = d7.body.kolo.ticket;
  check('day seven breaks the kolo into one ticket', d7.body.chest === 'broke' && d7.body.kolo.pieces === 0 && !!t, JSON.stringify(d7.body.kolo));
  check('the ticket names the lowest paid table and its fee', !!t && t.kind === 'entry' && t.table === 'Ibadan' && t.venue === 'The Brown Roof' && t.tableFee === 200 && t.credit === 200, JSON.stringify(t));
  check('the ticket is non-transferable with a 14 day expiry and no cash field', !!t && t.transferable === false && t.issuedDay === '2026-11-08' && t.expiresDay === '2026-11-22' && !('cash' in t), JSON.stringify(t));
  check('the day 8 milestone pays pieces on top of the daily piece', d8.body.granted.milestone && d8.body.granted.milestone.totalDays === 8 && d8.body.kolo.pieces === 3, JSON.stringify(d8.body.kolo));
  check('a second full kolo waits while a ticket is held', d13.body.chest === 'waiting' && d13.body.kolo.pieces === 7 && d13.body.kolo.ticket.expiresDay === '2026-11-22', JSON.stringify(d13.body.kolo));
  const lapsed = await viewV2('kolo-00001', '2026-11-23');
  check('the lapsed ticket frees the slot and the waiting kolo breaks', !!lapsed.body.kolo.ticket && lapsed.body.kolo.ticket.issuedDay === '2026-11-23' && lapsed.body.kolo.ticket.expiresDay === '2026-12-07' && lapsed.body.kolo.pieces === 0, JSON.stringify(lapsed.body.kolo));
}

// The Day 7 chest: no played match, no break. A played mark pays.
{
  let d7 = null;
  for (let d = 2; d <= 8; d++) d7 = await claimV2('blocked-001', '2026-11-0' + d);
  check('a full kolo without a played match stays shut', d7.body.chest === 'blocked' && d7.body.kolo.pieces === 7 && d7.body.kolo.ticket === null && d7.body.kolo.full === true && d7.body.kolo.complete === false, JSON.stringify(d7.body.kolo));
  ret.markPlayed(['blocked-001'], '2026-11-09');
  const paid = await claimV2('blocked-001', '2026-11-09');
  check('a played match opens the chest on the next claim', paid.body.chest === 'broke' && !!paid.body.kolo.ticket && paid.body.kolo.ticket.expiresDay === '2026-11-23', JSON.stringify(paid.body.kolo));
  check('the milestone still pays on the chest day', !!paid.body.granted.milestone && paid.body.granted.milestone.totalDays === 8, JSON.stringify(paid.body.granted));
}
// The worker ops lane carries the same played mark.
{
  let d7 = null;
  for (let d = 2; d <= 8; d++) d7 = await claimV2('ops-00001', '2026-11-0' + d);
  check('the ops player is blocked before the mark', d7.body.chest === 'blocked', JSON.stringify(d7.body.kolo));
  ret.applyOps([{ op: 'played', clientIds: ['ops-00001'], day: '2026-11-09' }]);
  const paid = await claimV2('ops-00001', '2026-11-09');
  check('an ops played mark opens the chest too', paid.body.chest === 'broke' && !!paid.body.kolo.ticket, JSON.stringify(paid.body.kolo));
}

// Grace: one missed day per week is covered, then the run restarts.
{
  const seq = ['2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-12', '2026-11-13', '2026-11-15'];
  const byDay = {};
  for (const day of seq) byDay[day] = await claimV2('grace-0001', day);
  check('grace covers the first missed day of the week', byDay['2026-11-05'].body.graced === true && byDay['2026-11-05'].body.streak.week === 3 && byDay['2026-11-05'].body.streak.graceLeft === 0, JSON.stringify(byDay['2026-11-05'].body.streak));
  check('two missed days restart the run and the kolo', byDay['2026-11-09'].body.streakReset === true && byDay['2026-11-09'].body.streak.week === 1 && byDay['2026-11-09'].body.kolo.pieces === 1, JSON.stringify(byDay['2026-11-09'].body.streak));
  check('a new week earns a fresh grace day', byDay['2026-11-12'].body.graced === true && byDay['2026-11-12'].body.streak.week === 3, JSON.stringify(byDay['2026-11-12'].body.streak));
  check('the run total still pays its milestone through the gaps', byDay['2026-11-13'].body.kolo.pieces === 6 && byDay['2026-11-13'].body.streak.totalDays === 8, JSON.stringify(byDay['2026-11-13'].body.kolo));
  check('grace does not cover a second miss in the same week', byDay['2026-11-15'].body.streakReset === true && byDay['2026-11-15'].body.streak.week === 1, JSON.stringify(byDay['2026-11-15'].body.streak));
}

// Milestones: total days never reset and pay at 8, 15, 22, 30.
{
  let m8 = null;
  for (let d = 2; d <= 15; d++) {
    const c = await claimV2('miles-00001', '2026-11-' + String(d).padStart(2, '0'));
    if (d === 9) m8 = c;
  }
  check('the 8 total day milestone pays', !!m8.body.granted.milestone && m8.body.granted.milestone.totalDays === 8 && m8.body.streak.milestonesPaid.join(',') === '8', JSON.stringify(m8.body.streak));
  const m15 = await claimV2('miles-00001', '2026-11-18');
  check('the 15 total day milestone pays even as the run resets', m15.body.streak.totalDays === 15 && !!m15.body.granted.milestone && m15.body.granted.milestone.totalDays === 15 && m15.body.streakReset === true && m15.body.streak.milestonesPaid.join(',') === '8,15', JSON.stringify(m15.body.streak));
  const after = await claimV2('miles-00001', '2026-11-19');
  check('a milestone never pays twice', after.body.granted.milestone === null && after.body.streak.totalDays === 16, JSON.stringify(after.body.streak));
}

// Postcards: duplicates gift across players, safely.
{
  ret.link({ clientId: 'album-00002', roomCode: 'TEST', seat: 1 });
  let dupe = null;
  for (let d = 0; d < 40 && !dupe; d++) {
    const c = await claimV2('album-00001', addDays('2026-11-02', d));
    const found = c.body.album.cards.find((x) => x.count >= 2);
    if (found) dupe = found.id;
  }
  check('daily claims grow a duplicate postcard', !!dupe);
  const giftDay = '2026-11-02';
  const sent = await post('/api/retention/gift', { clientId: 'album-00001', toClientId: 'album-00002', card: dupe, day: giftDay });
  check('a duplicate gifts to another player', sent.status === 200 && sent.body.ok === true, JSON.stringify(sent.body));
  const senderView = await viewV2('album-00001', giftDay);
  check('the sender keeps one copy', senderView.body.album.cards.find((x) => x.id === dupe).count === 1, JSON.stringify(senderView.body.album.cards.find((x) => x.id === dupe)));
  const receiverView = await viewV2('album-00002', giftDay);
  check('the receiver album shows the gifted card', receiverView.body.album.cards.find((x) => x.id === dupe).count === 1, JSON.stringify(receiverView.body.album.cards.find((x) => x.id === dupe)));
  const noDupe = await post('/api/retention/gift', { clientId: 'album-00001', toClientId: 'album-00002', card: dupe, day: giftDay });
  check('a single copy cannot be gifted away', noDupe.body.ok === false && noDupe.body.error === 'nodupe', JSON.stringify(noDupe.body));
  const self = await post('/api/retention/gift', { clientId: 'album-00001', toClientId: 'album-00001', card: dupe, day: giftDay });
  check('a gift to yourself is refused', self.status === 400 && self.body.error === 'self', JSON.stringify(self.body));
  const ghost = await post('/api/retention/gift', { clientId: 'album-00001', toClientId: 'nobody-0001', card: dupe, day: giftDay });
  check('a gift to an unknown player is refused', ghost.status === 404 && ghost.body.error === 'friend', JSON.stringify(ghost.body));
  const badCard = await post('/api/retention/gift', { clientId: 'album-00001', toClientId: 'album-00002', card: 'not-a-card', day: giftDay });
  check('a gift of a card that does not exist is refused', badCard.status === 400 && badCard.body.error === 'gift', JSON.stringify(badCard.body));
}

// Album completion: tickets and the token land, never cash, pages stay.
{
  let done = null;
  for (let d = 0; d < 200 && !done; d++) {
    const c = await claimV2('album-00003', addDays('2026-11-02', d));
    if (c.body.album.completedSeasons.includes(1)) done = c.body;
  }
  check('the album page completes inside 200 daily claims', !!done);
  check('completion starts the next season page and keeps the old one', !!done && done.album.season === 2 && done.album.completedSeasons.join(',') === '1', JSON.stringify(done && done.album.completedSeasons));
  check('completion pays entry tickets, one held and one waiting', !!done && !!done.kolo.ticket && done.kolo.ticket.kind === 'entry' && done.kolo.pendingTickets === 1, JSON.stringify(done && done.kolo));
  check('completion pays the named token cosmetic', !!done && !!done.cosmetics.token && done.cosmetics.token.name === 'Real Landlord Token' && done.cosmetics.token.seasons.join(',') === '1', JSON.stringify(done && done.cosmetics.token));
  check('no cash field rides anywhere in the v2 view', !!done && !JSON.stringify(done).includes('"cash'));
}

// Cosmetics: rotation, completion, permanence across a broken run.
{
  let fifth = null;
  let sixth = null;
  for (let d = 2; d <= 7; d++) {
    const c = await claimV2('cosmo-00001', '2026-11-0' + d);
    if (d === 6) fifth = c;
    if (d === 7) sixth = c;
  }
  check('five claims complete the first cosmetic in rotation', !!fifth.body.granted.cosmetic && fifth.body.granted.cosmetic.item === 'danfoLivery' && fifth.body.granted.cosmetic.pieces === 5 && fifth.body.granted.cosmetic.complete === true, JSON.stringify(fifth.body.granted.cosmetic));
  check('the rotation moves to the next cosmetic', !!sixth.body.granted.cosmetic && sixth.body.granted.cosmetic.item === 'kekeColour' && sixth.body.granted.cosmetic.pieces === 1, JSON.stringify(sixth.body.granted.cosmetic));
  const later = await claimV2('cosmo-00001', '2026-11-20');
  const items = Object.fromEntries(later.body.cosmetics.items.map((i) => [i.id, i.pieces]));
  check('cosmetics survive a broken run untouched', later.body.streakReset === true && items.danfoLivery === 5 && items.kekeColour === 2 && items.okadaOutfit === 0, JSON.stringify(items));
}

// Second chance spend guard: free tables only, wired ahead of paid rooms.
{
  const c = await claimV2('spend-00001', '2026-11-02');
  const item = c.body.secondChance[0];
  check('the view marks second chance as free table only', !!item && item.kind === 'rentShield' && item.label === 'Rent Shield' && item.freeOnly === true && item.paidUsable === false && item.expiresDay === '2026-11-05', JSON.stringify(item));
  const paidTry = ret.spendV2('spend-00001', 'rentShield', { paid: true, day: '2026-11-02' });
  check('a paid room spend refuses a second-chance good', paidTry.ok === false && paidTry.error === 'paid' && paidTry.freeOnly === true, JSON.stringify(paidTry));
  const freeTry = ret.spendV2('spend-00001', 'rentShield', { paid: false, day: '2026-11-02' });
  check('a free table spend takes the good', freeTry.ok === true && freeTry.held === 0, JSON.stringify(freeTry));
  const again = ret.spendV2('spend-00001', 'rentShield', { paid: false, day: '2026-11-02' });
  check('a spent good is gone', again.ok === false && again.error === 'short', JSON.stringify(again));
  const unknown = ret.spendV2('spend-00001', 'cowries', { day: '2026-11-02' });
  check('an old tribute good is not a v2 spend', unknown.ok === false && unknown.error === 'good', JSON.stringify(unknown));
}

// The Node handler serves the same v2 contract.
{
  const callNode = (method, url, body) => new Promise((resolveP, rejectP) => {
    const req = Readable.from([Buffer.from(body ? JSON.stringify(body) : '')]);
    req.method = method;
    req.url = url;
    req.headers = {};
    const res = mockRes();
    const origEnd = res.end.bind(res);
    res.end = (data) => { origEnd(data); resolveP({ status: res.status, body: JSON.parse(res.body) }); };
    try { ret.handle(req, res); } catch (e) { rejectP(e); }
  });
  const v = await callNode('GET', '/api/retention?clientId=node-00001&v=2&day=2026-11-02');
  check('the Node handler answers a v2 view', v.status === 200 && v.body.v === 2 && v.body.kolo.piecesNeeded === 7, JSON.stringify(v.body).slice(0, 120));
  const c = await callNode('POST', '/api/retention/claim', { clientId: 'node-00001', v: 2, day: '2026-11-02' });
  check('the Node handler answers a v2 claim', c.status === 200 && c.body.granted.piece === 1 && c.body.kolo.pieces === 1, JSON.stringify(c.body).slice(0, 120));
}

// After every v2 event above, a fresh legacy client still sees v1 bytes.
{
  const got = await legacyFlow('legacy-0002');
  for (let i = 0; i < FIXTURES.length; i++) {
    check('v1 fixture ' + 'ABCDE'[i] + ' is still byte-stable after the v2 run', got[i] === FIXTURES[i], got[i]);
  }
}

console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
