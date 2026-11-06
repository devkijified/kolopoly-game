# board28 fun layer: Hustle 2, Owambe Rush, missed turns, Sapa Deals, music (board: docs/BOARD20.md)

This is the contract for the board28 upgrade. The server (`game-host.js`,
shared by the Node host and the Cloudflare Durable Object host) is the only
judge of every rule below; clients only show state and send intents.
Hustle 2 (Inflation only) is specified in `docs/INFLATION-7.md` section 3.

## 1. The board and pieces

Superseded by board20: the board is now 20 spaces with long bold tiles and
a name tag on every piece. See `docs/BOARD20.md` for the board table,
prices, tile geometry, name tags and the 40 / 28 space snapshot
migration. Everything below (Hustle summary, Owambe Rush, missed turn fee,
Sapa Deals, music) applies unchanged on the 20 space board.

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
