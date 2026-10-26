# KOLOPOLY

A Nigerian property-trading board game for the browser, built for the living room:
2 to 6 players, online rooms or pass-and-play on one phone, dice, deeds, auctions,
Kirikiri, and a money system where every movement lands like a bank alert.

You move around a 40-space Lagos-and-beyond board (Makoko to Banana Island),
buy streets, complete colour sets named for what they mean (Old Money Belt,
New Money Corridor, Corporate and Capital), build Duplexes and Mansions, mortgage
in a squeeze, trade at any time, and try not to be the one whose cash finishes
while their property is still standing. Fees, taxes and fines feed the Owambe
pot on Owambe Grounds; whoever lands there collects it all.

## Run it

```sh
npm install
npm start          # PORT env or 4173
```

Open the URL, type your name, create a room or take a quick game. Rooms are
4-letter codes; the invite link, share button and QR code are in the lobby.
No build step, no framework, no runtime CDN: Node (built-in http + the `ws`
package) serves `public/`, and the server is authoritative for dice, money,
deeds, auctions, contracts and timers. Clients send intents only.

## The money scale

The board is priced at a $1 = ₦1,000 feel. Starting cash is ₦1,500,000, dealt
as 2x ₦500,000, 2x ₦200,000, 1x ₦50,000, 4x ₦10,000, 2x ₦5,000. Passing START
pays a ₦200,000 Salary Alert. Money is always shown exact, never rounded or
compacted; counts elsewhere in the UI are compact, money never is.

## Modes

**Classic** is the faithful engine: buy or go to a compulsory 20-second
auction; set ownership doubles site rent; even building; a finite supply of
32 Duplexes and 12 Mansions with a shortage auction for a contested last one;
mortgage at half, unmortgage at half plus 10 percent; Kirikiri by fine, card
or doubles; trading of cash, deeds and the Get Out card at any time; bankruptcy
to your creditor or to a bank auction; last solvent player wins. Host toggles
(all off by default): double START pay on an exact landing, no rent while in
Kirikiri, first-lap no buying. Timed games end at a 60-minute horn on net
worth.

**Inflation Mode** is the owner's own living-room system on top: the game
reprices itself in phases while salaries decay (₦200,000, ₦100,000, ₦50,000,
₦25,000), rent and build costs multiply by the dice you rolled, and deals only
count when they are registered on the public Contract Board: Passage rights
that cancel rent, collateral loans against a pledged deed, set-completion
swaps, Contract Windows and Deal Breaks, a Rescue Window for a winning bidder
who cannot pay, and a Sudden Death final phase that ends on net worth. The
Inflation Index (1.0x, 5.1x, 17.9x, 35.8x) is displayed through the Pure Water
Index: a sachet at ₦5, ₦10, ₦20, ₦50 across the phases, labelled as the gauge
it is. Phase horns arrive as Nigerian documents: a landlord's rent increase
letter, a breaking-news banner, a final notice. The end screen publishes a
Nominal Table and a Real Table (final cash restated at Phase 1 purchasing
power) plus lesson lines generated from each player's own ledger.

Presets: Quick Bite, Standard, Full Night.

## Design sources

The design is fully specified in three documents (kept with the project's
research notes):

- `~/workspace/research_notes/kolopoly-design-brief-20261026.md` — board,
  prices, rent ladders, decks, tokens, mechanics.
- `~/workspace/research_notes/kolopoly-nostalgia-research-20261026.md` —
  amendments that override the brief: board swaps, the Owambe jackpot, the
  Alert system, the language guide, the share cards, Nepo/Lapo.
- `~/workspace/research_notes/kolopoly-inflation-mode-spec-20261026.md` —
  Inflation Mode, as corrected by the owner (dice-multiplied build costs)
  and rescaled x10.
- `~/workspace/research_notes/kolopoly-inflation-nigeria-lessons-20261026.md` —
  the Nigeria lessons layer: document-skinned phase horns, end-screen lesson
  lines and the Real Table, the Pure Water Index.

## Tests

```sh
node test-engine.mjs    # protocol-level scripted games over WebSocket
node test-browser.mjs   # two rig pages at 390x844, screenshots in shots/
```

Both spawn their own server with `KP_TEST=1`, which shortens the auction
clock and enables dice/card/position/phase hooks (`test_dice`, `test_card`,
`test_set_cash`, `test_set_position`, `test_give`, `test_clock`,
`test_set_pot`, `test_phase`, `test_phase_ends_in`, `test_horn_in`). The
hooks do not exist in normal runs.

## IP note

KOLOPOLY is an original work: the name, board, artwork, token set and every
card's wording were written for this game. Its mechanics are implemented from
the public rules tradition of property-trading board games, plus the owner's
own Inflation system. Place names are facts. KOLOPOLY is not affiliated with
Hasbro or Bestman Games.
