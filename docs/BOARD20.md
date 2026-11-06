# board20: 20 spaces, long bold tiles, a name on every piece

Owner asks t113u (5 tiles a side, bigger tiles), t114u (bigger, bolder,
long rectangular tiles, highly visible on mobile) and t115u (label every
piece with its player's name). The server (`game-host.js`, shared by the
Node host and the Cloudflare Durable Object host) stays the only judge of
the rules. Owambe Rush, the missed turn fee, Sapa Deals and the ambient
music are unchanged and live in `docs/BOARD28-HUSTLE-OWAMBE.md`; Hustle 2
lives in `docs/INFLATION-7.md` section 3.

## 1. The board: 20 spaces, all Lagos

5 steps a side counting each corner once: 4 corners plus 4 middle tiles per
side. Corners: START (0), Kirikiri Prison (5, jail / just visiting), Owambe
Grounds (10, the pot), Go to Kirikiri (15). Five two-street colour sets,
two stations (Lekki Tollgate, MMIA), one utility (NEPA), one tax square
and one card square per deck. Landmarks kept: Quilox, Oriental Hotel, Eko
Hotel, Lekki Tollgate and Kirikiri. Left the board: Oshodi, Mushin, Ebute
Metta, Allen Avenue, Ikeja GRA, Water Board, Ikoyi and Bourdillon.

A lap is 20 spaces instead of 28, so START comes round 1.4 times as often
again. Deeds, duplexes and rents are raised about 1.35x over board28
(roughly 2x the original 40 space board) so land still feels valuable and
rent still bites. Salary (₦200,000 in Classic, Inflation phase salaries),
bail (₦50,000), mortgage (half) and unmortgage (+10%) are unchanged.

Rent ladder reads: site / full set / 1 duplex / 2 / 3 / 4 / mansion.

| # | Space | Set / type | Price | Duplex | Rent |
|---|---|---|---|---|---|
| 0 | START | start |  |  |  |
| 1 | Makoko | brown | ₦120,000 | ₦100,000 | ₦4,000 / ₦8,000 / ₦20,000 / ₦60,000 / ₦180,000 / ₦320,000 / ₦500,000 |
| 2 | Family Meeting | card |  |  |  |
| 3 | Ajegunle | brown | ₦140,000 | ₦100,000 | ₦8,000 / ₦16,000 / ₦40,000 / ₦120,000 / ₦360,000 / ₦640,000 / ₦900,000 |
| 4 | FIRS Income Tax | tax |  |  | ₦200,000 or 10% of net worth |
| 5 | Kirikiri Prison | jail |  |  |  |
| 6 | Yaba | lightblue | ₦240,000 | ₦150,000 | ₦16,000 / ₦32,000 / ₦80,000 / ₦200,000 / ₦600,000 / ₦900,000 / ₦1,200,000 |
| 7 | Lekki Tollgate | station | ₦400,000 |  | ₦75,000 / ₦200,000 for 1 / 2 stations owned |
| 8 | Surulere | lightblue | ₦280,000 | ₦150,000 | ₦24,000 / ₦48,000 / ₦120,000 / ₦360,000 / ₦1,000,000 / ₦1,400,000 / ₦1,800,000 |
| 9 | NEPA (PHCN) | utility | ₦300,000 |  | dice x ₦10,000 |
| 10 | Owambe Grounds | freeparking |  |  |  |
| 11 | Oriental Hotel | red | ₦440,000 | ₦300,000 | ₦36,000 / ₦72,000 / ₦180,000 / ₦500,000 / ₦1,400,000 / ₦1,750,000 / ₦2,100,000 |
| 12 | Wahala | card |  |  |  |
| 13 | Quilox | red | ₦470,000 | ₦300,000 | ₦40,000 / ₦80,000 / ₦200,000 / ₦600,000 / ₦1,500,000 / ₦1,850,000 / ₦2,200,000 |
| 14 | Murtala Muhammed Intl Airport | station | ₦400,000 |  | ₦75,000 / ₦200,000 for 1 / 2 stations owned |
| 15 | Go to Kirikiri | gotojail |  |  |  |
| 16 | Victoria Island | yellow | ₦520,000 | ₦300,000 | ₦45,000 / ₦90,000 / ₦225,000 / ₦670,000 / ₦1,600,000 / ₦1,950,000 / ₦2,300,000 |
| 17 | Eko Hotel | yellow | ₦550,000 | ₦300,000 | ₦50,000 / ₦100,000 / ₦245,000 / ₦730,000 / ₦1,700,000 / ₦2,050,000 / ₦2,400,000 |
| 18 | Eko Atlantic | darkblue | ₦680,000 | ₦400,000 | ₦70,000 / ₦140,000 / ₦355,000 / ₦1,000,000 / ₦2,200,000 / ₦2,600,000 / ₦3,000,000 |
| 19 | Banana Island | darkblue | ₦800,000 | ₦400,000 | ₦100,000 / ₦200,000 / ₦400,000 / ₦1,200,000 / ₦2,800,000 / ₦3,400,000 / ₦4,000,000 |

Supplies: 16 duplexes, 6 mansions (scaled to ten streets). Station rent:
₦75,000 with one, ₦200,000 with both. Utility rent: dice total x ₦10,000
(NEPA is the only utility, so owning it is owning them all). Inflation rent
multipliers apply to these printed numbers exactly as `docs/INFLATION-7.md`
describes; the phase table is unchanged.

## 2. Long, bold tiles (2D and 3D)

Both renderers read `KP_DATA.SIDE`, `BOARD_SIZE` and the index constants;
no index is hard coded. The ring keeps its 12.2 unit footprint and the
same camera fit, but its depth (`CORNER`, the local depth of every tile)
grows from 1.6 to 2.5 units. A middle tile is now 1.8 wide by 2.5 deep: a
long rectangle with about 75% more area than a board28 tile (1.5 x 1.6)
and 2.8x an original 40 space tile (1.0 x 1.6). Corners are 2.5 x 2.5.

- 3D (`public/board3d.js`): tile faces paint at 210 px per unit (525 px
  deep) in a scaled logical space, so type grows with the tile. Street
  tiles carry a colour band 30% of the tile deep (was 25%) with the name in
  heavy type up to 46 px (was 36), and a price up to 44 px (was 34). Other
  tiles get a 13% band (was 7.5%) and 40 px names. The centre field shrinks
  to 7.2 x 7.2; the lagoon, skyline and decks are refitted inside it.
- 2D (`public/board.js`, `public/style.css`): the grid is 2.5 / 1.8 x 4 /
  2.5. Colour bands are 26% of the tile (was 19%); names are 900 weight at
  clamp(11px, 3.8cqw, 20px) (was 9.5 to 16 px), prices clamp(10px, 3.3cqw,
  17px). Full naira prices show from a 520 px wide board.

## 3. A name on every piece

Every piece wears a bold tag in its player's colour with a white rim. The
local seat reads YOU (online rooms; it has a gold rim and sits on top).
Everyone else's piece shows their name, cut to 8 characters plus an
ellipsis past 9. Pass and play shares one phone, so there every piece
shows its player's name. 2D: `.tok-tag` (`.tok-you` / `.tok-name`), 12 to
12.5 px, 900 weight. 3D: a sprite above each piece, rebuilt only when the
name or colour changes. Tags are static, so reduced motion needs no change.

## 4. Saved rooms (40 and 28 space snapshots)

`importState` runs `migrateBoard`. `room.boardSize` says which board a
snapshot used (missing means 40); `LEGACY_40` and `LEGACY_28` in
`game-host.js` hold the old names and printed prices. Deeds move by name
(Makoko, Ajegunle, Yaba, Surulere, Lekki Tollgate, MMIA, NEPA, Oriental,
Quilox, Victoria Island, Eko Hotel, Eko Atlantic, Banana Island). A deed
whose space is gone is refunded at its old printed price (half if
mortgaged) plus its buildings at the old duplex price. Buildings on a
street whose new set the owner no longer holds whole are refunded at the
new duplex price. Positions map by name (jailed players stay in Kirikiri);
a vanished space scales onto the ring, and a free player never rests on
Go to Kirikiri (moved one step on). Contracts on vanished spaces are
voided; open auctions, buy prompts, bills, rushes and offers are cleared,
and supplies are capped. Tests: `test-board20.mjs` B8 (40 to 20) and B9
(28 to 20), `test/worker/game.test.mjs` (40 to 20 through a Durable Object
eviction).
