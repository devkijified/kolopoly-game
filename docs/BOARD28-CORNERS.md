# corners28: eight new deeds around the four corners

The board grows from 20 spaces to 28. Every side has seven steps
(one corner plus six middle tiles). Tile sizes do not shrink: corners
stay 2.5 units and middle tiles stay 1.8, so the ring grows from 12.2
to 15.8. The perspective camera re-fits the longer ring so the whole
board still reads at 360px.

The eight new deeds sit immediately next to the four corners, one on
each side:

| Space | Name | Price | Group | Perk | Flavour |
| --- | --- | --- | --- | --- | --- |
| 1 | Third Mainland Bridge | ₦100,000 | (bridge, ownable) | Pass toll ₦8,000 | Lagos longest wahala, still the only way to the island. |
| 6 | Alaba Market | ₦175,000 | The Trenches (brown) | Duplex and mansion 30% cheaper | If e no dey Alaba, e no dey Lagos. |
| 8 | Computer Village | ₦210,000 | Mainland Hustle (lightblue) | Sapa Deal you buy cost 20% less; the village covers the seller | Phone, laptop, charging cable, and a man wey go 'flash am'. |
| 13 | Mama Put | ₦320,000 | Owambe Supplies (pink) | Owner collects ₦15,000 soup money from the bank on a landing | Rice, stew, and a plastic chair wey don see plenty Lagos. |
| 15 | Party Rentals | ₦380,000 | Owambe Supplies (pink) | ₦5,000 from the bank whenever the Owambe pot is credited | Canopy, chairs, cooler, generator: the owambe no go start without am. |
| 20 | Police Checkpoint | ₦500,000 | Road Wahala (olive) | Anyone sent to Kirikiri settles the owner ₦25,000 first | 'Anything for the boys?' The boom dey down until you drop something. |
| 22 | Danfo Park | ₦510,000 | Road Wahala (olive) | Pass toll ₦12,000 | Every yellow bus for this town start and end for this park. |
| 27 | The Marina | ₦750,000 | Final Boss (darkblue) | Owner's START salary is ₦50,000 extra | Waterfront Lagos. Banks, boats, and the breeze wey the island dey flex. |

Banana Island stays the king at ₦800,000 (space 26). The other corners
are still START (0), Kirikiri (7), Owambe Grounds (14) and Go to
Kirikiri (21).

## Perks (server-authoritative)

- A **pass toll** is collected for every space crossed (`k = 1..n-1`)
  when the deed is owned and unmortgaged. Landing on an owned bridge
  pays the same amount as rent. If the payer cannot cover it, they
  pay what they have: a pass or a Kirikiri door never opens a debt
  window mid-move.
- **Computer Village** Sapa discount: the buyer pays 80% of the agreed
  cash; the seller still collects 100%; the bank covers the 20%.
- **Police Checkpoint** settle runs just before `sendToKirikiri`
  commits the player to jail, with the same cash-only rule.
- **Party Rentals** cut is paid from the bank when money enters the
  pot, not taken out of the pot itself.

## Migration

Rooms are stamped `boardGen: 'corners28'`. An unstamped snapshot is
migrated by space **name**, not by size: a 20-space room, an old
28-space room (Oshodi, Mushin, Allen, Ikoyi, …) and a 40-space room
all remap owners and positions onto the new ring. A vanished deed
(Ikoyi and friends) is refunded at its printed price. Banana Island
moves 19→26 from board20 and 27→26 from the old board28.

## Camera and pot

In portrait the 28-space ring is not stretched into a hallway: tile
widths stay 1.8 (corners 2.5) and the board's depth is capped at
1.25× its width, so the far row sits at about 55-60 percent of the
near-row scale. The cinema elevation is 58° portrait / 48° landscape,
FOV 42°, with a modest look toward the far edge (included in the
fit). Far-edge billboards carry the short name and the price, at a
constant screen size (no depth attenuation) and staggered heights so
they stay legible at 390px. The Owambe pot is scaled 1.72× with a
real coin and note heap that is already visible at idle zoom.
