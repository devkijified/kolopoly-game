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
