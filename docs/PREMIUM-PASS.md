# Premium game pass (2026-11-11)

Owner brief: GTA V premium look on the classic Three.js client, and "the game
must feel like a game, not a website": every popup, sheet, toast, button,
menu, landing and lobby styled as premium mobile game UI.

## What changed
- `public/premium.css` (new, loaded after style.css): dark smoked-glass panels
  with bevel, gold rim and fine texture; chunky bevelled buttons with a real
  bottom edge and press-down; scale-pop / slide-with-overshoot entrances for
  sheets, modals, toasts, bank alerts, lobby slots, end rows; card flip for
  Wahala/Family Meeting; arcade pulse on Owambe GRAB; game-styled inputs,
  toggles, lists and tables; no scrollbars, underlined links or list bullets.
  Text floor 12px on game surfaces. Applies to 2D and 3D alike.
- `public/game-feel.js` (new, ~4 KB): press state held for a frame, ripple,
  click SFX and haptic on every chunky control; money readouts count up to
  the new value (final text exact).
- `public/app.js`: `window.__kpUiTap` synth click on the existing mastering
  chain (respects the one mute button), light `navigator.vibrate` via `buzz`.
- `public/board3d.js`: cinematic tilt (56 deg portrait / 50 deg landscape,
  was 87 deg near plan) inside the KP11 orthographic fit law; ACES filmic
  tone mapping; Lagos golden-hour key light (low warm sun, soft PCF shadows,
  cool sky bounce); procedural golden-hour sky environment map via PMREM
  for reflections on metal, glass, gold and dice.

## Assets and licences
No third-party asset was added. The environment map is generated at runtime
(gradient dome + sun disc, prefiltered by PMREM): 0 bytes downloaded. The UI
click is synthesised with WebAudio. The Babylon `public/heroes/*.glb` models
were not reused (they would add ~870 KB before the board shows and the
classic client has its own primitive pieces with name/YOU tags).

## Budget
+~24 KB uncompressed (premium.css + game-feel.js), ~6 KB gzipped.

## Board pass (GTA V grounding)

- Tiles: painted concrete (deterministic grain, worn frame), colour band as a glossy enamel strip; darker concrete slab sides; tops roughness 0.62.
- Centre: dark asphalt plaza with gold border and dashed lane line; cream/gold wordmark (the wordmark probe now treats the dark floor as the hole); night skyline silhouettes with lit windows; brighter lagoon wash plus a glossier, emissive-lifted 3D water strip.
- Surfaces: CC0 ambientCG maps lazy-loaded 1.2 s after the board shows (`public/tex/`, ~63 KB, see `public/tex/SOURCES.md`): concrete normal/colour on tiles and slabs, asphalt normal on the centre, asphalt ground plane around the board.
- Camera: a 1.6 s cinematic push-in on a new purchase, a new Kirikiri arrival, and an Owambe result, then the glide back. The orthographic fit-law camera is kept (a perspective camera would break the KP11 fit law and its tests); follow mode is still the ortho zoom dolly.
- Bloom: a cheap additive halo on the Owambe pot on high and ultra tiers only (no post pass).
- Pot label: the painted OWAMBE POT caption is removed and the live chip sits low at the pot front, clear of the slogan.
- Bank alert: dark game banner with a gradient credit/debit strip, gold coin logo, neon amounts. HUD badges 12px (18px pill); the mode pill and room chip are 12px at <=520px.

Licences: ambientCG Asphalt026C and Concrete034, CC0 1.0 (https://ambientcg.com/license).

## Camera, pot, and a fixed board (follow-up)

- The game camera is a true PerspectiveCamera at 46° (portrait) / 42° (landscape), 50° on the lite tier. The old 100/100 orthographic fit law is replaced: every corner of the ring stays on stage, the idle view fills most of the box, and far-edge tiles carry camera-facing name/price chips. A hop dollies onto the moving token and eases back; buy, jail and Owambe push-ins are kept. 2D is unchanged.
- The portrait dock and rail reserve a constant height (`--dock-reserve`, `--rail-reserve`), so Buy / Auction / End turn, the timer, a bank alert or a sheet can never resize the board. A browser test asserts the wrap and canvas stay within 1px across those moments.
- The Owambe pot is a live physical thing: coins and notes arc in from the payer, clink and buzz, the pile and glow grow with the amount, the chip counts up, and the pot wobbles at 25/50/75/100%. A GRAB drains the pile to the winner. 2D has a fill gauge, a flying-coin sprite and the same counter. Low tiers use fewer coins and skip sparkles.
- Tile tops are darker concrete with cream prices, for contrast under the new lighting.

