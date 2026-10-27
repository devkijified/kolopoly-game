// Kolopoly bot brain.
//
// A bot is a normal seat on the server: server.js gives it a fake socket and
// this brain plays through the exact same intents a human client sends. It
// only ever sees the public room state (the same JSON every client gets), so
// it has no engine shortcut and no rule exemption: turn timers, auctions,
// debts, parallel management and pause rules all apply to it exactly.
//
// Personality (one only, no settings): competent, beatable, honest.
// - Buys an unowned landing when the cash left over keeps a reserve
//   (250,000 in Classic; scaled up by the phase multiplier in Inflation).
// - Auction bids capped at printed price, 1.2x only to complete its own set
//   or block an opponent's set, and never more cash than it holds.
// - Builds evenly on completed sets, mansions last on the richest street,
//   whenever the cash after building keeps the reserve. Builds on other
//   players' turns too (parallel management), like a human can.
// - Kirikiri: rolls for doubles twice, then pays bail; plays a Get Out of
//   Kirikiri card instead of paying when it holds one by the third attempt.
// - Pays debts promptly: mortgages the lowest value unbuilt deeds first,
//   sells buildings next, never defaults while assets remain.
// - Trades: accepts only when it clearly gains net worth (deeds valued at
//   price, or mortgage value when mortgaged; a set completion is worth 30%
//   extra; a card counts 50,000). Declines everything else.
// - Inflation: respects phase multipliers in buy and build maths, buys a
//   passage contract only when cheap on a street it will plausibly cross,
//   never lends without collateral (the server only ever offers collateral
//   loans, and the bot still checks the rate and its reserve).
// - Never resigns.
//
// If the brain ever fails to decide, the room's own timeout auto-actions take
// over, exactly like a stalled human, so a bot can never wedge a game.

const D = require('./public/game-data.js');

const BOT_NAMES = ['BOT Ade', 'BOT Ngozi', 'BOT Emeka', 'BOT Fatima', 'BOT Chidi', 'BOT Blessing'];
const BASE_RESERVE = 250000;
const JAIL_FINE = D.JAIL_FINE;

// Typical rent multiplier per Inflation phase (phase 1 prints, phase 2 uses
// the smaller die, phases 3 and 4 the bigger die). Mirrors the copy the game
// itself shows players.
function typicalMult(phase) {
  return [1, 2.53, 4.47, 4.47][Math.max(1, Math.min(4, phase || 1)) - 1];
}

function reserveFor(st) {
  if (!st || !st.inf) return BASE_RESERVE;
  return Math.round(BASE_RESERVE * typicalMult(st.inf.phase));
}

class BotBrain {
  constructor(opts) {
    this.playerId = opts.playerId;
    this.sendIntent = opts.send;
    this.test = !!opts.test;
    this.state = null;          // latest public room snapshot
    this.hold = false;          // test lever (KP_TEST hook): freeze decisions
    this.errors = [];           // every error line the server sent this seat
    this.actions = 0;           // intents sent
    this.jailAttempts = 0;      // jail_roll sends during the current Kirikiri stay
    this.dead = false;
    this.thinkTimer = null;
    this.cooldownUntil = 0;
    this.lastPassAt = 0;
    const iv = setInterval(() => this.kick(true), this.test ? 80 : 2000);
    if (iv.unref) iv.unref();
    this.watchdog = iv;
  }

  kill() {
    this.dead = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
  }

  // Raw frames from the fake socket (the same JSON a browser would get).
  handleRaw(data) {
    if (this.dead) return;
    let msg;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    try {
      if (msg.type === 'state' && msg.room) { this.state = msg.room; this.kick(false); }
      else if (msg.type === 'error') { this.errors.push(String(msg.message || 'error')); }
    } catch (e) { /* a brain bug must never reach the server loop */ }
  }

  kick(fromWatchdog) {
    if (this.dead) return;
    if (this.thinkTimer && !fromWatchdog) return;
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    const lo = this.test ? 5 : 600;
    const hi = this.test ? 30 : 1800;
    const wait = lo + Math.floor(Math.random() * (hi - lo));
    this.thinkTimer = setTimeout(() => {
      this.thinkTimer = null;
      try { this.decide(); } catch (e) { this.errors.push('brain: ' + (e && e.message)); }
    }, wait);
    if (this.thinkTimer.unref) this.thinkTimer.unref();
  }

  send(obj) {
    if (this.dead) return;
    this.actions += 1;
    this.cooldownUntil = Date.now() + (this.test ? 20 : 300);
    this.sendIntent(obj);
  }

  me(st) { return st.players.find((p) => p.id === this.playerId) || null; }

  // ---- public-state helpers (props: { o, m, b, pl } per space) -----------

  prop(st, i) { return st.props[i]; }

  ownsSet(st, pid, group) {
    return D.GROUP_SPACES[group].every((g) => { const pr = st.props[g]; return pr && pr.o === pid; });
  }

  groupBuildings(st, group) {
    return D.GROUP_SPACES[group].reduce((sum, g) => sum + (st.props[g] ? st.props[g].b : 0), 0);
  }

  setFrozen(st, group) {
    return D.GROUP_SPACES[group].some((g) => { const pr = st.props[g]; return pr && (pr.m || pr.pl); });
  }

  canBuildHere(st, pid, i, kind) {
    const sp = D.SPACES[i];
    if (!sp || sp.type !== 'street') return false;
    const pr = st.props[i];
    if (!pr || pr.o !== pid || pr.m || pr.pl) return false;
    if (!this.ownsSet(st, pid, sp.group) || this.setFrozen(st, sp.group)) return false;
    const bs = D.GROUP_SPACES[sp.group].map((g) => st.props[g].b);
    if (kind === 'mansion') return pr.b === 4 && bs.every((b) => b >= 4);
    if (pr.b >= 4) return false;
    return (pr.b + 1) - Math.min.apply(null, bs) <= 1;
  }

  // Deeds the bot can mortgage right now, cheapest mortgage value first
  // (spec: raise by mortgaging the lowest value unbuilt deeds first).
  mortgageCandidates(st, me) {
    const out = [];
    for (let i = 0; i < D.SPACES.length; i++) {
      const pr = st.props[i];
      if (!pr || pr.o !== me.id || pr.m || pr.pl) continue;
      const sp = D.SPACES[i];
      if (sp.type === 'street' && this.groupBuildings(st, sp.group) > 0) continue;
      out.push(i);
    }
    out.sort((a, b) => D.mortgageOf(D.SPACES[a].price) - D.mortgageOf(D.SPACES[b].price));
    return out;
  }

  // Buildings the bot can sell right now (even selling, richest first so one
  // sale raises as much as possible).
  sellCandidates(st, me) {
    const out = [];
    for (let i = 0; i < D.SPACES.length; i++) {
      const pr = st.props[i];
      if (!pr || pr.o !== me.id || pr.b <= 0) continue;
      const sp = D.SPACES[i];
      const bs = D.GROUP_SPACES[sp.group].map((g) => st.props[g].b);
      if (pr.b - Math.max.apply(null, bs) < 0) continue;
      if (pr.b !== Math.max.apply(null, bs)) continue;
      out.push(i);
    }
    out.sort((a, b) => D.SPACES[b].duplex - D.SPACES[a].duplex);
    return out;
  }

  // ---- decision entry ------------------------------------------------------

  decide() {
    const st = this.state;
    if (this.dead || !st || this.hold) return;
    if (Date.now() < this.cooldownUntil) { this.kick(true); return; }
    if (st.status !== 'playing' || st.paused) return;
    const me = this.me(st);
    if (!me || me.bankrupt || me.resigned) return;
    if (!me.inJail) this.jailAttempts = 0;

    // 1. My own debt: raise funds the honest way, promptly.
    if (st.debt && st.debt.playerId === me.id) return this.decideDebt(st, me);

    // 2. A mortgaged deed choice is waiting on me.
    if (me.pendingChoice != null) return this.decideChoice(st, me);

    // 3. A building placement is waiting on me (auction win or contested build).
    if (st.buildPlace && st.buildPlace.playerId === me.id) {
      const spot = this.bestPlacement(st, me, st.buildPlace.kind);
      if (spot != null) { this.send({ type: 'build_place', space: spot }); return; }
      return; // no legal spot: the server deadline fizzles it, never a stall
    }

    // 4. A live auction I am part of.
    if (st.auction) return this.decideAuction(st, me);

    // 5. A trade addressed to me.
    if (st.trade && st.trade.to === me.id) return this.decideTrade(st, me);

    // 6. Inflation: a loan decision where I am the lender.
    if (st.inf && st.inf.loanDecision) {
      const c = (st.inf.contracts || []).find((x) => x.id === st.inf.loanDecision.contractId);
      if (c && c.type === 'loan' && c.lender === me.id) {
        const pledged = D.SPACES[c.pledgedSpace];
        const completesMine = pledged && pledged.type === 'street' &&
          D.GROUP_SPACES[pledged.group].every((g) => g === c.pledgedSpace || (st.props[g] && st.props[g].o === me.id));
        const seize = completesMine || (pledged && pledged.price >= c.dueTotal) || c.extended;
        this.send({ type: 'loan_decide', contractId: c.id, decide: seize ? 'seize' : 'extend' });
        return;
      }
    }

    // 7. Inflation: a contract proposal addressed to me.
    if (st.inf && st.inf.proposal && st.inf.proposal.to === me.id) {
      return this.decideProposal(st, me, st.inf.proposal);
    }

    // Another player's debt blocks my management; I simply wait it out.
    if (st.debt) return;

    // 8. Inflation: repay my own loan when comfortably able.
    if (st.inf) {
      const mine = (st.inf.contracts || []).find((x) => x.type === 'loan' && x.borrower === me.id);
      if (mine && me.cash - mine.dueTotal >= reserveFor(st)) {
        this.send({ type: 'repay_loan', contractId: mine.id });
        return;
      }
    }

    // 9. My turn.
    if (st.turnPlayerId === me.id) return this.decideTurn(st, me);

    // 10. Off turn: parallel management, like a human can.
    this.decideManage(st, me);
  }

  // ---- debts ---------------------------------------------------------------

  decideDebt(st, me) {
    if (me.cash >= st.debt.amount) return; // settles itself on the next raise action; nothing owed in practice
    const m = this.mortgageCandidates(st, me)[0];
    if (m != null) { this.send({ type: 'mortgage', space: m }); return; }
    const s = this.sellCandidates(st, me)[0];
    if (s != null) { this.send({ type: 'sell_building', space: s }); return; }
    // Nothing left to raise with: the honest end (the server also auto checks).
    this.send({ type: 'declare_bankruptcy' });
  }

  decideChoice(st, me) {
    const i = me.pendingChoice;
    const price = D.SPACES[i].price;
    const m = D.mortgageOf(price);
    const liftCost = m + Math.round(m * 0.1);
    const interest = Math.round(m * 0.1);
    const reserve = reserveFor(st);
    if (me.cash - liftCost >= reserve) { this.send({ type: 'mortgage_choice', choice: 'lift' }); return; }
    if (me.cash >= interest) { this.send({ type: 'mortgage_choice', choice: 'interest' }); return; }
    // Cannot even cover the interest yet: raise on another deed first.
    const raise = this.mortgageCandidates(st, me).find((x) => x !== i);
    if (raise != null) { this.send({ type: 'mortgage', space: raise }); return; }
    const s = this.sellCandidates(st, me)[0];
    if (s != null) { this.send({ type: 'sell_building', space: s }); return; }
    this.send({ type: 'mortgage_choice', choice: 'interest' }); // server forces the default anyway
  }

  // ---- auctions --------------------------------------------------------------

  wouldComplete(st, me, space) {
    const sp = D.SPACES[space];
    if (sp.type === 'street') {
      return D.GROUP_SPACES[sp.group].every((g) => g === space || (st.props[g] && st.props[g].o === me.id));
    }
    if (sp.type === 'station') {
      return D.STATIONS.every((g) => g === space || (st.props[g] && st.props[g].o === me.id));
    }
    if (sp.type === 'utility') {
      return D.UTILITIES.every((g) => g === space || (st.props[g] && st.props[g].o === me.id));
    }
    return false;
  }

  wouldBlock(st, me, space) {
    const sp = D.SPACES[space];
    const others = st.players.filter((p) => p.id !== me.id && !p.bankrupt);
    const groups = sp.type === 'street' ? [D.GROUP_SPACES[sp.group]]
      : sp.type === 'station' ? [D.STATIONS] : sp.type === 'utility' ? [D.UTILITIES] : [];
    for (const members of groups) {
      for (const p of others) {
        if (members.every((g) => g === space || (st.props[g] && st.props[g].o === p.id))) return true;
      }
    }
    return false;
  }

  bestPlacement(st, me, kind) {
    let best = null;
    let bestRent = -1;
    for (let i = 0; i < D.SPACES.length; i++) {
      if (!this.canBuildHere(st, me.id, i, kind)) continue;
      const rent = D.SPACES[i].rent[6];
      if (rent > bestRent) { bestRent = rent; best = i; }
    }
    return best;
  }

  decideAuction(st, me) {
    const a = st.auction;
    if (!a.eligible.includes(me.id) || a.passed.includes(me.id)) return;
    if (a.highBidder === me.id) return; // winning: sit tight
    let cap;
    if (a.kind === 'deed') {
      const printed = D.SPACES[a.space].price;
      const hot = this.wouldComplete(st, me, a.space) || this.wouldBlock(st, me, a.space);
      cap = hot ? Math.floor(printed * 1.2) : printed;
    } else {
      const spot = this.bestPlacement(st, me, a.kind);
      if (spot == null) { this.send({ type: 'pass_bid' }); return; }
      cap = D.SPACES[spot].duplex;
    }
    cap = Math.min(cap, me.cash); // never bid money it does not hold
    if (a.minNext > cap) { this.send({ type: 'pass_bid' }); return; }
    this.send({ type: 'bid', amount: a.minNext });
  }

  // ---- trades ------------------------------------------------------------------

  sideValue(st, receiverId, side) {
    let v = side.cash || 0;
    const mine = new Set();
    for (let i = 0; i < D.SPACES.length; i++) {
      const pr = st.props[i];
      if (pr && pr.o === receiverId) mine.add(i);
    }
    for (const i of side.spaces || []) {
      const pr = st.props[i];
      const printed = D.SPACES[i].price;
      let val = pr && pr.m ? D.mortgageOf(printed) : printed;
      const sp = D.SPACES[i];
      if (sp.type === 'street') {
        const after = new Set(mine); after.add(i);
        if (D.GROUP_SPACES[sp.group].every((g) => after.has(g))) val = Math.round(val * 1.3);
      }
      v += val;
    }
    v += (side.goojf || 0) * 50000;
    return v;
  }

  decideTrade(st, me) {
    const t = st.trade;
    const gain = this.sideValue(st, me.id, t.offer);
    const loss = this.sideValue(st, me.id, t.request);
    this.send({ type: 'trade_respond', accept: gain > loss, honourPass: false });
  }

  // ---- Inflation contracts -------------------------------------------------------

  decideProposal(st, me, proposal) {
    const terms = proposal.terms || {};
    if (proposal.kind === 'pass') {
      // I own the street. Accept when the price covers one landing at the
      // current phase rate; decline cheap passes.
      const sp = D.SPACES[terms.street];
      const fair = sp ? Math.round(sp.rent[0] * typicalMult(st.inf.phase)) : Infinity;
      this.send({ type: 'contract_respond', accept: terms.price >= fair });
      return;
    }
    if (proposal.kind === 'loan') {
      // I am the lender. Collateral is structural (the server only offers
      // collateral loans); still check the rate, the amount and my reserve.
      const pledged = D.SPACES[terms.pledgedSpace];
      const ok = !!pledged &&
        terms.interestPct >= 10 &&
        terms.amount <= Math.floor(D.mortgageOf(pledged.price) * 0.8) &&
        me.cash - terms.amount >= reserveFor(st);
      this.send({ type: 'contract_respond', accept: ok });
      return;
    }
    this.send({ type: 'contract_respond', accept: false });
  }

  maybeProposePass(st, me) {
    const inf = st.inf;
    if (!inf || inf.phase >= 4 || inf.proposal) return false;
    if (Date.now() - this.lastPassAt < 45000) return false;
    const solvent = st.players.filter((p) => !p.bankrupt);
    if (solvent.length <= 2) return false;
    const reserve = reserveFor(st);
    const held = new Set((inf.contracts || []).filter((c) => c.type === 'pass' && c.buyer === me.id).map((c) => c.street));
    for (let d = 2; d <= 11; d++) {
      const i = (me.position + d) % 40;
      const sp = D.SPACES[i];
      if (!sp || sp.type !== 'street') continue;
      const pr = st.props[i];
      if (!pr || pr.o === me.id || pr.m) continue;
      const owner = st.players.find((p) => p.id === pr.o);
      if (!owner || owner.bankrupt) continue;
      if (held.has(i)) continue;
      const landing = Math.round(sp.rent[0] * typicalMult(inf.phase));
      if (landing < 20000) continue; // only worth covering real rent
      const price = sp.rent[0]; // cheap: one printed landing
      if (me.cash - price < reserve) return false;
      this.lastPassAt = Date.now();
      this.send({ type: 'contract_propose', kind: 'pass', street: i, chips: 1, price });
      return true;
    }
    return false;
  }

  // ---- parallel management ---------------------------------------------------------

  // Returns true when it sent something. Builds evenly on completed sets,
  // mansions last on the richest street, lifts a mortgage when rich.
  decideManage(st, me) {
    if (st.auction || st.buildPlace || st.debt) return false;
    const reserve = reserveFor(st);
    const myTurn = st.turnPlayerId === me.id;
    // Mansion first preference is wrong: mansions go last, after duplexes are
    // maxed somewhere. Try duplexes on the richest legal street, then a
    // mansion where a street already stands at four.
    const tryKind = (kind) => {
      const supply = kind === 'mansion' ? st.mansionSupply : st.duplexSupply;
      if (supply <= 0) return false;
      if (supply === 1 && !myTurn) return false; // a contested single would be refused off turn
      let best = null;
      let bestRent = -1;
      for (let i = 0; i < D.SPACES.length; i++) {
        if (!this.canBuildHere(st, me.id, i, kind)) continue;
        if (D.SPACES[i].rent[6] > bestRent) { bestRent = D.SPACES[i].rent[6]; best = i; }
      }
      if (best == null) return false;
      const printed = D.SPACES[best].duplex;
      let expected = printed;
      let worst = printed;
      if (st.inf && st.inf.phase >= 2) { expected = Math.round(printed * typicalMult(st.inf.phase)); worst = printed * 6; }
      if (me.cash < worst) return false;             // can always pay the Builder's Roll
      if (me.cash - expected < reserve) return false; // keeps the reserve on the typical roll
      this.send({ type: 'build', space: best, kind });
      return true;
    };
    if (tryKind('duplex')) return true;
    if (tryKind('mansion')) return true;
    // Lift the cheapest mortgaged deed when comfortably rich.
    const mortgaged = [];
    for (let i = 0; i < D.SPACES.length; i++) {
      const pr = st.props[i];
      if (pr && pr.o === me.id && pr.m) mortgaged.push(i);
    }
    mortgaged.sort((a, b) => D.SPACES[a].price - D.SPACES[b].price);
    if (mortgaged.length) {
      const i = mortgaged[0];
      const price = D.SPACES[i].price;
      const cost = D.mortgageOf(price) + Math.round(D.mortgageOf(price) * 0.1);
      if (me.cash - cost >= Math.round(reserve * 1.5)) {
        this.send({ type: 'unmortgage', space: i });
        return true;
      }
    }
    return false;
  }

  // ---- my turn ------------------------------------------------------------------------

  decideTurn(st, me) {
    const phase = st.phase;
    if (phase === 'roll') {
      if (this.decideManage(st, me)) return;
      this.send({ type: 'roll' });
      return;
    }
    if (phase === 'jail') {
      if (me.goojf > 0 && this.jailAttempts >= 2) { this.send({ type: 'jail_card' }); return; }
      if (this.jailAttempts >= 2) {
        if (me.cash >= JAIL_FINE) { this.send({ type: 'jail_pay' }); return; }
        const m = this.mortgageCandidates(st, me)[0];
        if (m != null) { this.send({ type: 'mortgage', space: m }); return; }
        const s = this.sellCandidates(st, me)[0];
        if (s != null) { this.send({ type: 'sell_building', space: s }); return; }
        this.jailAttempts += 1;
        this.send({ type: 'jail_roll' }); // forced bail flow takes over from here
        return;
      }
      this.jailAttempts += 1;
      this.send({ type: 'jail_roll' });
      return;
    }
    if (phase === 'buy') {
      const price = st.buyPrice;
      if (price != null && me.cash - price >= reserveFor(st)) { this.send({ type: 'buy' }); return; }
      this.send({ type: 'decline' });
      return;
    }
    if (phase === 'tax') {
      const pct = Math.floor((me.netWorth || 0) * 0.10);
      this.send({ type: 'tax_choice', choice: pct < 200000 ? 'percent' : 'flat' });
      return;
    }
    if (phase === 'end') {
      if (this.decideManage(st, me)) return;
      if (st.inf && this.maybeProposePass(st, me)) return;
      this.send({ type: 'end_turn' });
      return;
    }
    // 'debt', 'auction' and 'buildPlace' phases are handled above; anything
    // else is a wait (the room deadline is the fallback, never a stall).
  }
}

module.exports = { BotBrain, BOT_NAMES, typicalMult, reserveFor };
