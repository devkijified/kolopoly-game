# Inflation Mode: Seven Global Phases, Lifeline and Hustle

This document is the build contract for the Inflation upgrade. It records the
exact rules and balance values the code implements, so the engine, the client
and the tests can be checked against one source. Classic mode is untouched by
everything in this document: every rule here is gated on the room being an
Inflation room.

## 1. The seven phases

Phases follow authoritative elapsed match time on the server. They never
follow individual board laps. A phase changes exactly two things: the rent
multiplier and the GO (passing START) payout. Nothing else is repriced: deed
prices, build costs, taxes, fines, card amounts and auction prices stay at
their printed values in every phase. (This retires the old Phase 3 purchase
price multiplier and the Builder's Roll build multiplier: the phase table in
the brief defines phases by rent and GO only, and silent repricing of deeds
and duplexes made bills impossible to explain.)

| # | Name            | Length | Rent multiplier (dice d1, d2) | GO payout |
|---|-----------------|--------|-------------------------------|-----------|
| 1 | Standard        | 20 min | x1                            | 100%      |
| 2 | Squeeze         | 15 min | x lower die                   | 70%       |
| 3 | Heat            | 10 min | x higher die                  | 50%       |
| 4 | Crunch          | 7 min  | x (d1 + d2)                   | 35%       |
| 5 | Crisis          | 5 min  | x (d1 + d2) x lower die       | 20%       |
| 6 | Meltdown        | 5 min  | x (d1 + d2) x higher die      | 10%       |
| 7 | Final Reckoning | 5 min  | x (d1 + d2) x (d1 + d2)       | 5%        |

Total scheduled match length: 67 minutes (4020 seconds).

Rules that pin the table down:

- "Bill" means the normal property rent the existing rules already compute
  (street rent ladder, station rent by count owned). The multiplier applies
  to street and station rent on dice arrivals only, using the actual
  movement dice that caused the landing (the same dice the player rolled,
  doubles included: a double still uses its two faces).
- Utility rent is already priced off the dice sum by the existing rules, so
  it is never multiplied again. Card moves onto a property (card arrivals)
  stay at x1, as before. Taxes, fines, card payments and every other payment
  are never multiplied.
- GO payout is a percentage of the normal ₦200,000 salary:
  ₦200,000 / ₦140,000 / ₦100,000 / ₦70,000 / ₦40,000 / ₦20,000 / ₦10,000.
  Rounding: salary = floor(200000 x pct / 100). Every percentage in the
  table divides ₦200,000 exactly, so salaries are always whole naira with
  no rounding residue. Rent is printed rent (whole naira) times an integer
  multiplier, so rent is always a whole number too. No floating point money
  exists anywhere in the phase system.
- Nobody's existing money is confiscated and starting cash is unchanged
  (₦1,500,000). Only future GO income shrinks.
- The displayed Inflation Index per phase is 1.0 / 1.4 / 2.0 / 2.9 / 5.0 /
  10.0 / 20.0 (normal salary divided by the phase salary, one decimal). The
  end screen Real Table deflates cash by this index, as before.
- Pure Water Index (display only): ₦50 / ₦70 / ₦100 / ₦140 / ₦250 / ₦500 /
  ₦1,000.

### Clock and pause semantics

- The match clock is server time. `inf.startedAt` is set when the game
  starts; each phase end is an absolute timestamp chained from the previous
  phase end, and the match deadline is the end of phase 7.
- Settling (phase 1) still ends early at a turn boundary once every ownable
  space has an owner (the owner's parlour rule). An early advance starts the
  next phase at that moment with its full listed length, so the whole match
  simply ends earlier.
- The existing table pause (fewer than two connected solvent humans, or all
  humans away while bots sit) freezes the match clock the same way it
  already freezes the turn clock: on resume, the current phase end and the
  match deadline shift by the paused stretch, so a phase always delivers
  its full listed length of live play. Deal breaks and the tactical windows
  below do not pause the match clock.
- Phase warnings fire at 60 seconds and 10 seconds before a phase end, as
  before, naming the incoming phase, its salary and its rent formula.
- In Final Reckoning no new contracts open (proposal window closes), the
  same freeze the old Sudden Death phase applied.

### The deadline and ranking

- Last player standing wins early, exactly as before, at any phase.
- When the deadline (end of Final Reckoning) arrives, pending obligations
  resolve first, in this order, then the ranking is taken:
  1. A pending Hustle expires with no transfer (Hustle money only ever
     moves at resolution, so nothing is half-moved).
  2. A pending Lifeline bill is charged at its frozen full amount if the
     player's cash covers it; if not, it stays outstanding (step 4).
  3. A running auction is voided. Bids in this engine never escrow money,
     so voiding moves nothing; an unowned deed stays with the bank.
  4. Ranking worth = net worth (cash + deeds at price, or mortgage value
     when mortgaged, + buildings at value, the existing `netWorth`) minus
     any outstanding frozen debt the player still owes (a rent debt in the
     debt phase, or an unpayable bill from step 2). The creditor is not
     credited: that money never moved.
- Ranking order (deterministic): higher ranking worth, then higher cash,
  then fewer mortgaged deeds, then earliest last START pass, then lowest
  player id. The winner is declared from this ranking and the end table is
  sorted by the same order for Inflation games.
- Outstanding player-to-player loans at the horn stay as they are: the cash
  already moved when the loan was made, deeds stay with their owners, and
  the ranking counts what each player actually holds. No new settlement is
  invented at the horn.

### Frozen bills

A rent bill is calculated once, at the moment of landing, from the printed
rent and the landing dice, and the resulting amount is frozen on the bill
(the pending Lifeline bill, or the debt record if the player cannot pay).
A phase change after that moment never recalculates it: settling the debt
later always charges the frozen amount. Salary works the same way in
reverse: a START pass is paid at the salary of the phase in force at the
moment of the pass.

## 2. Lifeline

- Every player receives exactly one Lifeline per match (Inflation only).
- When a player lands on a street or station and the multiplied rent they
  would pay is higher than the printed rent, and they still hold their
  Lifeline, the game pauses on a Lifeline bill before any money moves. The
  bill shows the printed rent, the dice, the multiplier and the multiplied
  rent, frozen at landing.
- The player chooses: pay the multiplied rent (Lifeline kept), or spend the
  Lifeline and pay the printed rent instead. Other covers still apply
  afterwards in their existing order (Passage chips fire before a bill
  exists at all, so a covered landing never offers a Lifeline; the kola
  cover reduces what the tenant pays after the Lifeline decision).
- The window is 15 seconds. Silence pays the full multiplied rent and
  keeps the Lifeline (a safe default: nobody loses their one Lifeline by
  being slow). A disconnected player's window simply expires the same way.
- The server validates everything: the bill belongs to the player, the
  Lifeline is unused, the bill is still open. Settling closes the bill, so
  repeated clicks, retries and reconnects can never settle it twice or
  spend the Lifeline twice.
- Bot seats (including AFK takeover seats) never wait: the server applies
  the bot policy instantly at landing. A bot spends its Lifeline when the
  saving is at least ₦100,000, or when paying full would push it into a
  debt it cannot cover from cash.
- Using a Lifeline never blocks anyone else: it sits inside the landing
  player's own turn resolution, like the existing buy decision.

## 3. Hustle

One short explanation, the way the game shows it: "Hustle: pick a player
wey hold cash. You fit grab 10% of their cash (max ₦150,000). If dem guide
their money, your chance drop and if dem catch you, half your fine reach
dem. If dem catch you, you pay fine enter the Owambe pot."

- Inflation only. In-game cash only: no real money, no deposits, no
  staking, no cash-out. A Hustle is a normal game action.
- Who and when: the turn player, during their roll phase, before rolling,
  once per turn. Not while an auction, debt, Lifeline bill, contract
  proposal or another Hustle is open.
- Target: another solvent player holding at least ₦50,000 cash, who is not
  in Kirikiri. A target can be hustled at most once per phase by anyone,
  and the same attacker can hustle the same target at most twice per
  match. Each attacker gets at most 3 attempts per match.
- Amount: 10% of the target's current cash, minimum ₦10,000, capped at
  ₦150,000 (floor to whole naira). The exact amount, the odds and the fine
  are shown to the attacker before they confirm, and the target sees the
  amount at stake when they are asked to defend.
- Fine for being caught: half the amount at stake, minimum ₦10,000. The
  attacker must hold at least the fine in cash to start a Hustle, so a
  fine can never create a debt or bankrupt anyone. A steal is at most 10%
  of the target's cash, so a single Hustle can never bankrupt the target
  either, and cash never goes negative.
- Defence: the target gets a 20 second window to answer. Two choices:
  - Guide my money (defend): the success chance drops to 15%, and if the
    attacker is caught, half the fine goes to the target, half to the pot.
  - Leave am (no defence): the success chance is 45%, and a caught
    attacker's whole fine goes to the Owambe pot.
  - No answer in time (AFK, disconnected, or busy): the attempt resolves
    at a 30% success chance and a caught fine goes wholly to the pot. The
    match never waits longer than the window.
- The roll is made on the server at resolution time, once. Resolution is
  guarded by the Hustle's own state and id: defence answers, retries,
  double clicks and reconnects can never resolve or settle it twice.
- Outcomes move money only at resolution: success moves the amount from
  target to attacker (never more than the target actually holds at that
  moment); caught moves the fine from the attacker, split as above.
  Everyone at the table sees the result in the feed and the bank alerts,
  and the settled outcome is written to the match stamps (the audit trail
  the end screen and records read).
- Bots: a bot may start a Hustle from phase 2 on, on its turn, when the
  richest legal target holds at least twice its cash (or ₦500,000), it can
  cover the fine, and a per-turn chance roll passes (about 1 in 3). A bot
  target defends about 7 times in 10. Bots obey every limit above.
- Abandoning or farming: Hustle attempts are capped per match, targets
  rotate by rule, and no retention reward of any kind is tied to Hustle.

## 4. What the client shows

- The phase strip keeps its one-line shape: phase name, Inflation Index
  chip, Pure Water chip, and the phase countdown. The strip's accessible
  name and title carry the full line: phase, time left, next phase, the
  current formula in words.
- A phase horn (the existing document-style modal) announces each new
  phase with its salary, its rent formula and one worked dice example:
  "Rent ₦10,000, roll 3 + 4: Squeeze take the lower die, x3, so ₦30,000."
  The 60 second warning names the incoming formula before it lands.
- The Lifeline bill and the Hustle defence prompt are sheets inside the
  player's own turn area (the existing action bar and sheet patterns), not
  new permanent HUD. The Hustle button appears only on the attacker's own
  roll phase in Inflation rooms. Countdowns on both windows are text the
  client already knows how to render from server timestamps.
- Phase transitions reuse the existing horn, banner and sound path, so the
  mute toggle and reduced-motion handling already in the client apply
  unchanged.

## 5. Retention additions (cosmetic only)

Built on the existing retention shelf and profile, no new backend:

- The client profile records, per finished Inflation game: the phase the
  player reached (or the phase they were eliminated in), whether they won,
  their final net worth, and whether their Lifeline survived unused.
- Cosmetic survival milestones (badges on the end screen and profile,
  never cash, never goods): First Reckoning (finish an Inflation game),
  Heat Survivor (reach phase 3), Crisis Survivor (reach phase 5),
  Final Reckoning (reach phase 7), Landlord of the Reckoning (win an
  Inflation game), Clean Hands (win with the Lifeline unspent), Iron
  Tenant (finish in the top half after being hustled at least once).
- Personal bests on the end screen: best phase reached, best final net
  worth, Inflation wins. Shown beside the result, stored with the existing
  client profile, never promised as money.
- Rematch: the existing play-again flow is the rematch. The end screen
  keeps its Play Again button, which returns the same table to the lobby
  with the same mode and settings, and the profile counts a rematch chain
  (games played back to back at one sitting) cosmetically.
- Nothing here rewards Hustle use or leaving early: quitting before the
  end records no milestone 
...[truncated 2085 chars]or personal best from that game.

## 6. Wire contract (what the server publishes and accepts)

State (`publicRoom`):

- `room.pendingBill`: null or `{ id, playerId, ownerId, space, printed,
  mult, amount, dice: [d1, d2], endsAt }`. Present only while a Lifeline
  choice is open.
- `room.hustle`: null or `{ id, from, to, amount, fine, endsAt, defended }`
  where `defended` is null (awaiting), true or false. Present only while a
  Hustle defence window is open.
- `room.inf`: `{ phase, phaseName, nextPhaseName (null in phase 7),
  multKind ('none' | 'lower' | 'higher' | 'sum' | 'sumLower' | 'sumHigher'
  | 'sumSq'), phaseEndsAt, deadlineAt, announcedPhase, salary, index,
  preset, hustleCaps: { maxAttempts, cap, targetMinCash }, ... }` plus the
  pre-existing contract fields.
- Player rows gain: `lifelineUsed`, `hustleAttempts`, `hustledTimes`,
  `phaseSurvived` (the phase the player reached, or was eliminated in;
  null outside Inflation).
- End table rows gain the same `phaseSurvived`, `lifelineUsed` and
  `hustledTimes` fields, and a horn ending publishes the table in ranking
  order.

Intents (client to server):

- `lifeline_use { billId }` / `lifeline_skip { billId }`: only the bill's
  player; the server revalidates ownership, the id and single use.
- `hustle_start { targetId }`: the turn player, roll phase; the server
  validates every limit in section 3 and computes amount and fine itself.
- `hustle_defend { hustleId, defend }`: only the target; the first answer
  wins and resolves the Hustle at once.

Snapshots and hosts:

- Room state stays plain JSON end to end, so Node snapshots and Durable
  Object storage carry the new fields without a schema change.
- On import, missing player fields default to unused and unattempted; an
  open Hustle (whose money has not moved) expires; a pending Lifeline bill
  (whose amounts are frozen) survives; a snapshot from the old four-phase
  build keeps its table and current phase, restarts that phase with its
  new listed length, and runs the new schedule from there.
- Test builds only (`KP_TEST=1`, the same gate as every existing test
  hook; the production Worker never enables it): `test_phase { phase }`
  for phases 1 to 7, `test_phase_ends_in { seconds }`,
  `test_horn_in { seconds }` (sets the match deadline) and
  `test_hustle_rolls { rolls: [...] }` (the server consumes one queued
  roll per Hustle resolution, for deterministic tests). Window lengths
  shrink under the same gate, as existing windows already do: Lifeline
  15s becomes 4s, Hustle 20s becomes 5s.
