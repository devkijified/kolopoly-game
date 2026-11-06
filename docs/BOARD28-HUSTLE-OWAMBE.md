# board28: the Lagos board, Hustle 2, Owambe Rush, missed turns, Sapa Deals, music

This is the contract for the board28 upgrade. The server (`game-host.js`,
shared by the Node host and the Cloudflare Durable Object host) is the only
judge of every rule below; clients only show state and send intents.
Hustle 2 (Inflation only) is specified in `docs/INFLATION-7.md` section 3.

## 1. The board: 28 spaces, all Lagos

7 steps a side counting corners: 4 corners plus 6 middle tiles per side.
Corners: START (0), Kirikiri Prison (7, jail / just visiting), Owambe
Grounds (14, the pot), Go to Kirikiri (21). Eight two-street colour sets,
three stations, two utilities, one tax square, one card square per deck.
Salary for passing START stays ₦200,000 in Classic (Inflation phase
salaries are unchanged). Bail ₦50,000. Mortgage is half the price,
unmortgage is the mortgage plus 10%.

Rent ladder reads: site / full set / 1 duplex / 2 / 3 / 4 / mansion.

| # | Space | Set / type | Price | Duplex | Rent |
|---|---|---|---|---|---|
| 0 | START | start |  |  |  |
| 1 | Makoko | brown | ₦90,000 | ₦75,000 | ₦3,000 / ₦6,000 / ₦15,000 / ₦45,000 / ₦135,000 / ₦240,000 / ₦375,000 |
| 2 | Family Meeting | card |  |  |  |
| 3 | Ajegunle | brown | ₦100,000 | ₦75,000 | ₦6,000 / ₦12,000 / ₦30,000 / ₦90,000 / ₦270,000 / ₦480,000 / ₦675,000 |
| 4 | FIRS Income Tax | tax |  |  | ₦200,000 or 10% of net worth |
| 5 | Oshodi Transport Interchange | station | ₦300,000 |  | ₦50,000 / ₦100,000 / ₦200,000 by stations owned |
| 6 | Mushin | lightblue | ₦160,000 | ₦100,000 | ₦9,000 / ₦18,000 / ₦45,000 / ₦135,000 / ₦405,000 / ₦600,000 / ₦825,000 |
| 7 | Kirikiri Prison | jail |  |  |  |
| 8 | Yaba | lightblue | ₦180,000 | ₦100,000 | ₦12,000 / ₦24,000 / ₦60,000 / ₦150,000 / ₦450,000 / ₦675,000 / ₦900,000 |
| 9 | NEPA (PHCN) | utility | ₦225,000 |  | dice x ₦6,000 (one) or x ₦15,000 (both) |
| 10 | Ebute Metta | pink | ₦220,000 | ₦150,000 | ₦15,000 / ₦30,000 / ₦75,000 / ₦225,000 / ₦675,000 / ₦940,000 / ₦1,125,000 |
| 11 | Surulere | pink | ₦240,000 | ₦150,000 | ₦18,000 / ₦36,000 / ₦90,000 / ₦270,000 / ₦750,000 / ₦1,050,000 / ₦1,350,000 |
| 12 | Lekki Tollgate | station | ₦300,000 |  | ₦50,000 / ₦100,000 / ₦200,000 by stations owned |
| 13 | Allen Avenue | orange | ₦280,000 | ₦150,000 | ₦21,000 / ₦42,000 / ₦105,000 / ₦300,000 / ₦825,000 / ₦1,125,000 / ₦1,425,000 |
| 14 | Owambe Grounds | freeparking |  |  |  |
| 15 | Ikeja GRA | orange | ₦300,000 | ₦150,000 | ₦24,000 / ₦48,000 / ₦120,000 / ₦330,000 / ₦900,000 / ₦1,200,000 / ₦1,500,000 |
| 16 | Wahala | card |  |  |  |
| 17 | Oriental Hotel | red | ₦340,000 | ₦225,000 | ₦27,000 / ₦54,000 / ₦135,000 / ₦375,000 / ₦1,050,000 / ₦1,315,000 / ₦1,575,000 |
| 18 | Quilox | red | ₦360,000 | ₦225,000 | ₦30,000 / ₦60,000 / ₦150,000 / ₦450,000 / ₦1,125,000 / ₦1,390,000 / ₦1,650,000 |
| 19 | Murtala Muhammed Intl Airport | station | ₦300,000 |  | ₦50,000 / ₦100,000 / ₦200,000 by stations owned |
| 20 | Victoria Island | yellow | ₦400,000 | ₦225,000 | ₦33,000 / ₦66,000 / ₦165,000 / ₦495,000 / ₦1,200,000 / ₦1,465,000 / ₦1,725,000 |
| 21 | Go to Kirikiri | gotojail |  |  |  |
| 22 | Eko Hotel | yellow | ₦420,000 | ₦225,000 | ₦36,000 / ₦72,000 / ₦180,000 / ₦540,000 / ₦1,275,000 / ₦1,540,000 / ₦1,800,000 |
| 23 | Water Board | utility | ₦225,000 |  | dice x ₦6,000 (one) or x ₦15,000 (both) |
| 24 | Ikoyi | green | ₦460,000 | ₦300,000 | ₦39,000 / ₦78,000 / ₦195,000 / ₦585,000 / ₦1,350,000 / ₦1,650,000 / ₦1,915,000 |
| 25 | Bourdillon, Ikoyi | green | ₦480,000 | ₦300,000 | ₦42,000 / ₦84,000 / ₦225,000 / ₦675,000 / ₦1,500,000 / ₦1,800,000 / ₦2,100,000 |
| 26 | Eko Atlantic | darkblue | ₦520,000 | ₦300,000 | ₦53,000 / ₦105,000 / ₦263,000 / ₦750,000 / ₦1,650,000 / ₦1,950,000 / ₦2,250,000 |
| 27 | Banana Island | darkblue | ₦600,000 | ₦300,000 | ₦75,000 / ₦150,000 / ₦300,000 / ₦900,000 / ₦2,100,000 / ₦2,550,000 / ₦3,000,000 |

Supplies: 24 duplexes, 9 mansions (scaled down from the 40 space bank).
Station rent: ₦50,000 / ₦100,000 / ₦200,000 for 1 / 2 / 3 stations owned.
Inflation rent multipliers apply to these printed numbers exactly as
`docs/INFLATION-7.md` describes; nothing in the phase table changed.

Renderers: `public/board.js` (2D grid, 8 x 8 cells) and `public/board3d.js`
(Three.js ring) both read `KP_DATA.SIDE`, `BOARD_SIZE`, `JAIL_INDEX`,
`PARKING_INDEX`, `GOTOJAIL_INDEX` and each space's `art` key; no index is
hard coded. The ring keeps its 12.2 unit footprint, so a middle tile is 1.5
units wide instead of 1.0 (50% larger names and art on phones) with the
same camera framing. 2D tile text, dice and pieces are larger at 360 to 430
px wide.

### Saved rooms from the 40 space board

`importState` runs `migrateBoard`: deeds move by name to their new index
(Makoko, Ajegunle, Mushin, Ebute Metta, Yaba, Surulere, Victoria Island,
Ikoyi, Bourdillon, Banana Island, the utilities, MMIA and Oshodi). A deed
whose space is gone is refunded to its owner at the old printed price
(half if mortgaged) plus its buildings at the old duplex price. Buildings
on a street whose new set the owner no longer holds whole are refunded at
the new duplex price. Positions map by name (jailed players stay in
Kirikiri; anything else scales onto the ring). Contracts on vanished
spaces are voided. Open auctions, buy prompts, bills, rushes and offers
are cleared, and supplies are capped.

## 2. Pieces and dice

Bigger dice (2D: 38 to 56 px; 3D: 0.58 units, up from 0.42), bolder pieces
(wider pedestal with a dark rim, 2D outline), and the local player's piece
wears a YOU tag in online rooms (pass and play has no single "you"). The
tag is static (no animation), so reduced motion needs no change.

## 2b. Hustle 2 summary (Inflation only; full rules in docs/INFLATION-7.md section 3)

- Defence window: **4 seconds** live (3 s in KP_TEST builds), down from 6.
  The turn clock pauses while it runs.
- Odds: Guard my money 25%; Leave am 55%; **no answer = uncaught**: a
  target who does not guard in time is treated as unguarded, so the steal
  resolves at the same 55% (it is never an automatic defence).
- Win: 12% of the target's cash (min ₦20,000, cap ₦200,000); one success
  in five is a Big Grab (up to 2x, max 25% of the target's cash, ₦400,000).
- **Fail fine** (owner t107u): a caught hustle (guarded or not) pays 25% of
  the amount at stake, min ₦10,000, max ₦50,000, into the Owambe pot. It is
  capped at the hustler's cash in hand, so it never opens a debt, never
  bankrupts and never goes negative. Example: a ₦120,000 stake risks a
  ₦30,000 fine. The fine is shown on the Hustle sheet before confirming.
- Heat: every failure adds Heat; at Heat 3 the hustler pays that fine and
  goes straight to Kirikiri, Heat resets to 0.
- Caps: 6 attempts per match, 3 on the same target, one round of cover for
  whoever was just hustled. Server RNG only, settled exactly once.

## 3. Owambe Rush (all modes)

- The pot fills from fines (including Hustle fail fines), taxes, card charges and the missed turn fee,
  as before; it shows on the Owambe tile and the centre of the board.
- Trigger: landing on Owambe Grounds with the pot at ₦50,000 or more
  starts a Rush (below that the lander simply collects the small pot, as
  before). A pot that reaches ₦500,000 by itself starts an overflow Rush
  with no landing (after an unclaimed Rush, the overflow waits 60 s).
- Countdown: 3 s "OWAMBE POT DEY COME" with a big number, then an 8 s
  GRAB window with a big GRAB button.
- First successful tap wins the whole pot. There is no randomness: the
  server processes intents for a room one at a time and the first valid
  `owambe_grab` it handles wins. The rush record is cleared before any
  money moves, so every later tap (simultaneous, replayed after a
  reconnect, or a double click) gets "That Owambe Rush don close." and
  moves nothing. An early tap during COMING is refused without lockout.
- Everyone at the table may grab, including players in Kirikiri and the
  lander. Bankrupt and resigned players and spectators cannot. AFK
  takeover seats never grab (an AFK player misses it). Real bots grab
  after a human-like 0.9 to 2.5 s reaction.
- Nobody grabs in time: the pot rolls over intact and keeps growing.
- Feedback: "X won ₦Y!" toast with the reaction time, a jackpot feed
  entry, the stamp in the match record and the 3D spray moment.
- Reconnect safe: the live rush is in state and survives a snapshot and
  restore; pauses shift its clock; DO alarms wake for it.
- Separate from Hustle in every way (own intent, own state, own odds: none).

Wire: `room.owambe` = null or `{ id, state: 'coming' | 'open', opensAt,
closesAt, by, reason: 'landing' | 'overflow' }`; `room.owambeResult` =
`{ id, winnerId | null, amount, at, reactionMs }`; `room.owambeRules` =
`{ min, auto, comingSecs, openSecs }`. Intent: `owambe_grab { rushId }`
(pass and play adds `as`).

## 4. Missed turn fee (all modes, timed turns)

When the turn clock runs out while the turn player still has to roll (or
decide in Kirikiri), the server charges a ₦25,000 missed turn fee into the
Owambe pot and skips the turn. The fee is capped at the cash in hand, so
it never opens a debt or bankrupts anyone. A jailed player's skipped turn
counts as one of their three tries. Bots and AFK takeover seats act on
their own clock, so they almost never miss; if they do, the same rule
applies. Other clock outcomes are unchanged (buy goes to auction, tax takes
the smaller charge, end passes the turn). Everyone sees a toast; the feed
carries a `timeout` entry with `auto: true, reason: 'turn timer', missed:
true`. Wire: `room.missedTurn` = `{ playerId, fee, at, turn }` and
`room.missedTurnFee` = 25000.

## 5. Sapa Deals (all modes)

While a player is raising money for a debt they are marked vulnerable (a
SAPA tag on their chip). Any other living player can offer cash for one or
more of their deeds (unbuilt sets, not pledged as loan security). One
offer is open at a time, the debtor answers Accept or Decline within 12
seconds (no answer = lapsed), and each offerer can make at most 3 offers
per debt. The debt clock does not stop. The server revalidates everything
on Accept (ownership, buildings, cash) and settles exactly once: the offer
is closed before money or deeds move, cash goes to the debtor, deeds go to
the buyer (a mortgaged deed brings the usual interest choice; Inflation
passes on the street follow the deed as in a normal transfer), and the
debt settles if the money now covers it. Decline, timeout or a voided
offer change nothing, and the normal raise money / bankruptcy path
carries on. Bots answer offers on their own (accept at 60% of the printed
price or better).

Wire: `room.sapaOffer` = null or `{ id, from, to, spaces, cash, endsAt }`,
`room.sapaResult` = `{ id, from, to, outcome: 'accepted' | 'declined' |
'timeout' | 'void', cash?, spaces?, at }`. Intents: `sapa_offer { to,
spaces, cash }`, `sapa_answer { offerId, accept }`. The client offers in
online rooms; pass and play debtors can still answer.

## 6. Ambient music

A soft, original 16 s highlife-feel loop (`public/sfx/ambient-highlife.mp3`,
about 80 KB, regenerated by `python3 tools/make_ambient.py`) plays under a
game in progress on its own quiet bus.

- Starts only after a user gesture, fetched lazily (not in the first
  load), fades in over 4 s.
- Ducks to 30% under every sound effect and UI tick, then rises back.
- Silent whenever the sound button is on "Sound off" (state 3).
- Level: Off / Low / Medium. Long-press (or right-click) the sound button
  to open the Background music sheet. Stored as `localStorage.kolopolyMusic`.
  Players with reduced motion set start at Off until they pick a level.
- Leaves with the room (stops when the game ends or the seat clears).
- `window.KPMusic.get()` and `window.KPMusic.set('off' | 'low' | 'medium')`
  exist for tests and support.

## 7. Follow up (not in this change)

- Earn / stake tables: skipped on purpose. Any future table must stay
  in-game cash only, with no deposits, cash-out or real money.
