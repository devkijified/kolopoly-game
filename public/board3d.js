'use strict';
// KOLOPOLY 3D layer. One Three.js renderer whose canvas is re-parented into
// whichever scene is on screen: landing street, lobby plaza, the game board,
// and the end podium. All art, textures and models are original work drawn in
// code (canvas textures + low poly geometry); the standard matched is the
// classic property board genre, never its artwork. If WebGL is unavailable
// this module stays inert and the 2D presentation carries the game alone.
// The server still owns every rule: this layer only renders state.
import * as THREE from 'three';

const D = window.KP_DATA;
const B = window.KPBoard;
const $ = (id) => document.getElementById(id);

const KP3D = { active: false };
window.KP3D = KP3D;

// KP14 sound beats: the renderers own the animation, so the renderers
// call the beats. app.js maps each beat to its designed sound, which
// is what keeps sound and picture in sync (the socket message arrives
// before the dice have tumbled, the token has landed, the building
// has grown). The beat timestamp rides along for the sync log.
function beat(name, data) {
  try { if (window.KPBeat) window.KPBeat(name, Object.assign({ t: performance.now() }, data || {})); } catch (e) { /* sound is garnish, never a blocker */ }
}

// ---------------------------------------------------------------------------
// Best View (KP14): a capability engine replaces the KP13 Auto heuristic.
// KP13 law stands (sharp by default, adapt only under real load, textures
// never shrink); KP14 decides WHERE sharp starts from evidence, and
// remembers what the phone proved.
//
// - Boot probe: devicePixelRatio, the unmasked WebGL renderer string,
//   hardwareConcurrency, deviceMemory, screen size and, where present,
//   navigator.connection. detectProfile(sig) is a pure function of that
//   probe, so tests can present whole device classes to it.
// - Profiles: ULTRA (pixelRatio min(dpr,3), shadows 2048, anisotropy up
//   to 16), HIGH (min(dpr,2.5), 1024), BALANCED (min(dpr,2), 512),
//   LITE (min(dpr,1.5), no shadows, reduced textures and ambient life).
//   Flagship signals (Apple GPU strings, recent Adreno/Mali flagships,
//   8+ cores, 4GB+) land ULTRA; honest mid hardware HIGH or BALANCED;
//   weak signals LITE. Software GL on a non-mobile UA (VMs, remote
//   desktops) is capped low: a real phone never renders through
//   SwiftShader, an emulator window very often does.
// - Network strength is a SECONDARY signal only: this game's assets
//   are generated locally and weigh almost nothing on the wire, so a
//   slow link says nothing about what the GPU can draw. Save-data or a
//   2g-class link therefore starts exactly one profile conservative,
//   never more; it is a courtesy to the page load, not a quality cap.
// - The KP13 FPS stepper remains as the safety net and GAINS MEMORY:
//   a stepped-down pixel ratio that then holds stable is persisted as
//   a learned ceiling (localStorage 'kolopolyViewLearn', versioned),
//   so the next load STARTS at the proven level instead of hanging at
//   a cap the phone already failed. After three stable sessions at the
//   learned cap, one fresh session retries a single ladder step above
//   it; if the retry holds, it becomes the learned cap; if it steps
//   back down, the counter restarts. In-session recovery never climbs
//   past the session's start cap: the only way up is the next session.
// - Manual picks persist in 'kolopolyTier' (the KP13 migration key
//   'kolopolyTierVer' stays at '2'; pre-KP14 values map forward at
//   read: high -> ultra, mid -> balanced, low -> lite). The topbar
//   button cycles Auto, Ultra, High, Balanced, Lite and LABELS the
//   detection ("Graphics: Auto (Ultra)").
// - The profile owns pixels only, never game behaviour.
// ---------------------------------------------------------------------------
const PROFILE_PARAMS = {
  ultra: { dprCap: 3, shadowSize: 2048, texScale: 1.2, centreScale: 1.5, aniso: 16, ambientOn: 1500, ambientOff: 750 },
  high: { dprCap: 2.5, shadowSize: 1024, texScale: 1.2, centreScale: 1.5, aniso: 8, ambientOn: 1500, ambientOff: 750 },
  balanced: { dprCap: 2, shadowSize: 512, texScale: 1.2, centreScale: 1.5, aniso: 4, ambientOn: 1200, ambientOff: 1000 },
  lite: { dprCap: 1.5, shadowSize: 0, texScale: 0.9, centreScale: 1.05, aniso: 2, ambientOn: 700, ambientOff: 1600 }
};
const PROFILE_ORDER = ['lite', 'balanced', 'high', 'ultra'];
const PROFILE_LADDER = [3, 2.5, 2, 1.75, 1.5, 1.25, 1]; // pixel ratio steps, high to low
let glRendererName = '';
// KP13 one-time migration, unchanged: clear any tier stored before the
// sharp defaults existed, exactly once (versioned by 'kolopolyTierVer').
try {
  if (localStorage.getItem('kolopolyTierVer') !== '2') {
    localStorage.removeItem('kolopolyTier');
    localStorage.setItem('kolopolyTierVer', '2');
  }
} catch (e) { /* storage off: every load simply lands on Auto */ }
const LEGACY_TIER = { high: 'ultra', mid: 'balanced', low: 'lite' };
function tierOverride() {
  try {
    let v = localStorage.getItem('kolopolyTier');
    if (v && LEGACY_TIER[v]) { try { localStorage.setItem('kolopolyTier', LEGACY_TIER[v]); } catch (e) { /* read-only storage */ } v = LEGACY_TIER[v]; }
    return (v === 'ultra' || v === 'high' || v === 'balanced' || v === 'lite') ? v : null;
  } catch (e) { return null; }
}
function collectSignals() {
  const nav = window.navigator || {};
  const conn = nav.connection || {};
  return {
    dpr: window.devicePixelRatio || 1,
    gl: glRendererName || '',
    cores: nav.hardwareConcurrency || 0,
    mem: nav.deviceMemory || 0, // GB, Chromium only; 0 means unknown
    ua: nav.userAgent || '',
    screen: { w: (window.screen && window.screen.width) || 0, h: (window.screen && window.screen.height) || 0 },
    conn: { effectiveType: conn.effectiveType || '', downlink: conn.downlink || 0, saveData: !!conn.saveData }
  };
}
// Pure profile detection: signals in, profile name out. Exposed as
// KP3D.detectProfile so the browser suite can grade whole device
// classes without a drawer full of phones.
function detectProfile(sig) {
  sig = sig || {};
  const dpr = sig.dpr || 1, cores = sig.cores || 0, mem = sig.mem || 0;
  const gl = String(sig.gl || '').toLowerCase(), ua = String(sig.ua || '').toLowerCase();
  const conn = sig.conn || {};
  let score = 0;
  if (dpr >= 3) score += 2; else if (dpr >= 2) score += 1;
  if (cores >= 8) score += 2; else if (cores >= 6) score += 1; else if (cores > 0 && cores <= 2) score -= 2;
  if (mem >= 4) score += 1; else if (mem > 0 && mem <= 2) score -= 1;
  if (/apple (gpu|a1\d)|angle \(apple|adreno.*(7[4-9]\d|8\d\d)|mali-g(710|715|720|725|925|930)|immortalis|xclipse/.test(gl)) score += 2;
  if (/mali-[24]\d\d|mali-t[678]|adreno.*[23]\d\d|powervr sgx/.test(gl)) score -= 2;
  if (/(iphone|ipad)/.test(ua) && dpr >= 2.5) score += 1;
  if (/swiftshader|llvmpipe|software rasterizer|paravirtual/.test(gl) && !/(iphone|ipad|android|mobile)/.test(ua) && score > 1) score = 1;
  let name = score >= 5 ? 'ultra' : score >= 2 ? 'high' : score >= 0 ? 'balanced' : 'lite';
  if (cores > 0 && cores <= 2 && mem > 0 && mem <= 1.5) name = 'lite';
  // Network: a secondary signal only (see the header note). Save-data
  // or a 2g-class link starts exactly one profile conservative.
  if (conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') {
    const ix = PROFILE_ORDER.indexOf(name);
    if (ix > 0) name = PROFILE_ORDER[ix - 1];
  }
  return name;
}
let lastProbe = collectSignals();
// The learned ceiling: the pixel ratio a previous session stepped down
// to and then held. Versioned so the shape can evolve.
let learned = null;
try { const j = JSON.parse(localStorage.getItem('kolopolyViewLearn') || 'null'); if (j && j.v === 1 && typeof j.cap === 'number') learned = j; } catch (e) { learned = null; }
function saveLearn(cap, ok) {
  learned = { v: 1, cap, ok };
  try { localStorage.setItem('kolopolyViewLearn', JSON.stringify(learned)); } catch (e) { /* storage off: session-only memory */ }
}
// Auto FPS stepper state (the stepper itself sits beside the render
// loop). Declared here because applyTier resets it, and applyTier runs
// once at module load.
let autoPrCap = PROFILE_PARAMS.high.dprCap, autoStartCap = PROFILE_PARAMS.high.dprCap, autoProfile = 'high';
let autoWinStart = 0, autoWinFrames = 0;
let autoSlowWins = 0, autoFastWins = 0, autoStableWins = 0, autoGraceUntil = 0;
let learnSessionCounted = false;
// KP15: the stepper DECIDES immediately (autoPrCap above) but the buffer
// resize is gated: a decided step waits in this flag until a scene entry
// or a game turn boundary applies it, never mid-motion.
let pendingAutoPr = false;
// The pixel ratio cap actually in force: Auto adapts, manual picks do not.
function prCap() { return TIER.auto ? autoPrCap : TIER.dprCap; }
function applyTier(name, auto) {
  if (auto) {
    autoProfile = detectProfile(lastProbe);
    TIER = { name: 'auto', auto: true, profile: autoProfile, ...PROFILE_PARAMS[autoProfile] };
    const profCap = PROFILE_PARAMS[autoProfile].dprCap;
    autoStartCap = profCap;
    if (learned && learned.cap < profCap) {
      autoStartCap = learned.cap;
      if ((learned.ok || 0) >= 3) {
        // one fresh-session retry: a single ladder step above the
        // learned ceiling, never a leap back to the profile cap
        const ups = PROFILE_LADDER.filter((v) => v > learned.cap + 0.001 && v <= profCap);
        if (ups.length) autoStartCap = Math.min(...ups);
      }
    }
    autoPrCap = autoStartCap;
  } else {
    TIER = { name, auto: false, profile: name, ...(PROFILE_PARAMS[name] || PROFILE_PARAMS.high) };
    autoProfile = name;
    autoStartCap = TIER.dprCap;
    autoPrCap = TIER.dprCap;
  }
  autoSlowWins = 0; autoFastWins = 0; autoStableWins = 0; autoWinStart = 0; autoWinFrames = 0;
  pendingAutoPr = false; // KP15: a fresh tier supersedes any gated step
  learnSessionCounted = false;
  autoGraceUntil = (typeof performance !== 'undefined' ? performance.now() : 0) + 6000;
  KP3D.tier = TIER.name;
  KP3D.tierAuto = TIER.auto;
  KP3D.profile = TIER.profile;
}
let TIER = null;
applyTier(tierOverride() || 'auto', !tierOverride()); // the profile is re-resolved with the GL renderer string in initGL
KP3D.detectProfile = detectProfile;
KP3D.probe = function () { return lastProbe; };

// ---------------------------------------------------------------------------
// Layout maths, mirrored from board.js (same grid, same slots)
// ---------------------------------------------------------------------------
const COLW = [1.6, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.6];
const TOTALW = 12.2;
function gridPos(i) {
  if (i <= 10) return { row: 11, col: 11 - i };
  if (i <= 20) return { row: 21 - i, col: 1 };
  if (i <= 30) return { row: 1, col: i - 19 };
  return { row: i - 29, col: 11 };
}
function tileRect(i, L) {
  const g = L || { TW: TOTALW, TD: TOTALW, colX: COLW, rowD: COLW };
  const { row, col } = gridPos(i);
  let x = 0; for (let c = 1; c < col; c++) x += g.colX[c - 1];
  let z = 0; for (let r = 1; r < row; r++) z += g.rowD[r - 1];
  return { x: x - g.TW / 2, z: z - g.TD / 2, w: g.colX[col - 1], d: g.rowD[row - 1] };
}
// KP11: the board is a rectangle built from the presentation box itself.
// There is no plinth, platform, rim or table under the tile ring: the
// ring's own outer edge is the board's silhouette, and the layout spreads
// the track over a footprint whose depth-to-width ratio equals the box
// aspect (corrected for the fitted camera's elevation, so the projected
// silhouette binds both box axes at once at 100 percent). Corners stay
// square (1.6 x 1.6) in every layout: a tall box pours its extra depth
// into the nine middle rows (near/far tiles keep their depth, side tiles
// gain length); a wide box pours its extra width into the nine middle
// columns (side tiles keep their width, near/far tiles gain breadth).
// Tile local depth (lz) is 1.6 in every layout, so only local width (lx)
// varies, and tile face textures are generated for the tile's own lx.
function trackLayout(boxAspect, forceTall) {
  const camAspect = 1 / boxAspect;
  // KP19: in a portrait window the layout ALWAYS takes the tall
  // construction (near-plan factor, width fixed, depth from the box's
  // own aspect), even when the stage box itself is squat: the board
  // then fills its stage exactly at true proportions, the KP11 law at
  // every portrait size. Landscape windows keep the two-branch rule.
  const sinEl = (forceTall || camAspect < 1.2) ? 0.99862 : 0.95083; // fullDir depth factors: 87 or 71.9 degrees
  let TW, TD;
  if (forceTall || boxAspect >= 1) { TW = TOTALW; TD = TOTALW * boxAspect / sinEl; }
  else { TD = TOTALW; TW = TOTALW * sinEl / boxAspect; }
  const wm = (TW - 3.2) / 9, dm = (TD - 3.2) / 9;
  const colX = [], rowD = [];
  for (let k = 0; k < 11; k++) {
    colX.push(k === 0 || k === 10 ? 1.6 : wm);
    rowD.push(k === 0 || k === 10 ? 1.6 : dm);
  }
  return { TW, TD, colX, rowD, boxAspect, tallForced: !!forceTall };
}
function portraitWindow() { return window.innerHeight >= window.innerWidth; }
// Texture top (the colour band) always points toward the board centre, so a
// name reads correctly from its own side of the table on all four edges.
function tileRotY(i) { return i <= 9 ? 0 : i <= 19 ? -Math.PI / 2 : i <= 29 ? Math.PI : Math.PI / 2; }
function tileLocal(rect, i) {
  const th = tileRotY(i);
  return (th === 0 || th === Math.PI) ? { lx: rect.w, lz: rect.d } : { lx: rect.d, lz: rect.w };
}
function localToWorld(rect, th, lx, lz) {
  const cx = rect.x + rect.w / 2, cz = rect.z + rect.d / 2;
  return { x: cx + lx * Math.cos(th) + lz * Math.sin(th), z: cz - lx * Math.sin(th) + lz * Math.cos(th) };
}
const TOKEN_SLOTS = [[-0.20, 0.10], [0.20, 0.10], [-0.20, 0.38], [0.20, 0.38], [0, -0.05], [0, 0.52]];
function bandColorFor(i, sp) {
  return sp.type === 'street' ? D.GROUPS[sp.group].color
    : sp.type === 'station' ? '#3d3d3d' : sp.type === 'utility' ? '#3f7fbf'
    : i === 0 || i === 20 ? '#e8a90c' : i === 10 || i === 30 ? '#8c2f2f'
    : sp.type === 'card' ? (sp.deck === 'wahala' ? '#d64545' : '#3f7fbf') : '#b8a888';
}
const ART_BY_GROUP = { brown: 'stalls', lightblue: 'house', pink: 'house', orange: 'towers', red: 'gate', yellow: 'towers', green: 'mansion', darkblue: 'mansion' };
const ART_BY_SPACE = {
  0: 'payday', 1: 'stilts', 3: 'ball', 4: 'taxdoc', 5: 'train', 6: 'stalls', 9: 'bread',
  12: 'pylon', 13: 'tech', 14: 'stadium', 15: 'plane', 18: 'stalls', 19: 'computer',
  20: 'party', 24: 'palms', 25: 'crane', 27: 'bank', 28: 'watertower', 29: 'dome',
  30: 'bars', 32: 'towers', 35: 'danfo', 39: 'island'
};
function artFor(i, sp) {
  if (ART_BY_SPACE[i]) return ART_BY_SPACE[i];
  if (sp.type === 'street') return ART_BY_GROUP[sp.group] || 'house';
  if (sp.type === 'station') return 'train';
  if (sp.type === 'utility') return i === 12 ? 'pylon' : 'watertower';
  if (sp.type === 'jail' || sp.type === 'gotojail') return 'bars';
  if (sp.type === 'freeparking') return 'party';
  if (sp.type === 'tax') return 'taxdoc';
  if (sp.type === 'card') return 'cards';
  if (sp.type === 'start') return 'payday';
  return 'house';
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------
function cnv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
// Canvas at a tier-scaled resolution with the 2D context pre-scaled, so all
// painters keep drawing in the same logical (high tier) coordinate space.
function cnvS(w, h, ts) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w * ts)); c.height = Math.max(2, Math.round(h * ts));
  const x = c.getContext('2d');
  if (ts !== 1) x.scale(ts, ts);
  return [c, x];
}
function maxAniso() { try { return renderer ? renderer.capabilities.getMaxAnisotropy() : 4; } catch (e) { return 4; } }
// Board textures (tiles, centre field) are read at grazing angles on the
// tilted board, so they take the renderer's full anisotropy (capped at
// 16, KP13) instead of the tier's small cap: that is what keeps tile
// names and prices crisp on the far rows. Mipmaps stay at the Three r186
// default (generateMipmaps true, LinearMipmapLinearFilter): WebGL2
// handles these rectangular canvases natively.
function texOf(c, board) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = board ? Math.min(16, maxAniso()) : Math.min(TIER.aniso, maxAniso()); return t; }
function rr(x, a, b, w, h, r) {
  x.beginPath();
  x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r);
  x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath();
}
function fitFont(x, text, maxW, start, weight, family) {
  let s = start;
  x.font = weight + ' ' + s + 'px ' + family;
  while (x.measureText(text).width > maxW && s > 9) { s -= 2; x.font = weight + ' ' + s + 'px ' + family; }
  return s;
}
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
// KP12: band hues deepen a touch (saturation up, lightness down) so the
// band and the bold name on it read as one strong header.
function deepenBand(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return hex;
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = 0;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (mx === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  const s2 = Math.min(1, s * 1.22), l2 = Math.max(0, l * 0.93);
  const c = (1 - Math.abs(2 * l2 - 1)) * s2, xx = c * (1 - Math.abs((h * 6) % 2 - 1)), m = l2 - c / 2;
  let r2, g2, b2;
  if (h < 1 / 6) { r2 = c; g2 = xx; b2 = 0; } else if (h < 2 / 6) { r2 = xx; g2 = c; b2 = 0; }
  else if (h < 3 / 6) { r2 = 0; g2 = c; b2 = xx; } else if (h < 4 / 6) { r2 = 0; g2 = xx; b2 = c; }
  else if (h < 5 / 6) { r2 = xx; g2 = 0; b2 = c; } else { r2 = c; g2 = 0; b2 = xx; }
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r2) + to(g2) + to(b2);
}
// KP12: the ink deepens to a near-black brown across every generated
// face, so names, prices and glyph strokes survive a screenshot.
const INK = '#1e1409', CREAM = '#fdf6df', GOLD = '#e8a90c';

// ---------------------------------------------------------------------------
// Emblem painters: tiny original scenes, drawn in a box centred (cx, cy)
// ---------------------------------------------------------------------------
function emblem(x, id, cx, cy, s, accent) {
  const u = s / 100; // unit
  x.save(); x.translate(cx, cy); x.lineWidth = 4.4 * u; x.lineJoin = 'round'; x.lineCap = 'round';
  const box = (a, b, w, h, fill) => { x.fillStyle = fill; x.fillRect(a * u, b * u, w * u, h * u); };
  const circ = (a, b, r, fill) => { x.fillStyle = fill; x.beginPath(); x.arc(a * u, b * u, r * u, 0, 7); x.fill(); };
  const line = (a, b, c2, d, col, w) => { x.strokeStyle = col; x.lineWidth = (w || 4) * u; x.beginPath(); x.moveTo(a * u, b * u); x.lineTo(c2 * u, d * u); x.stroke(); };
  switch (id) {
    case 'danfo': case 'train': {
      if (id === 'train') {
        box(-34, -22, 68, 46, '#4a4a52'); box(-28, -16, 24, 16, '#cfeefb'); box(4, -16, 24, 16, '#cfeefb');
        box(-34, 12, 68, 6, GOLD); circ(-20, 28, 7, INK); circ(20, 28, 7, INK); line(-40, 36, 40, 36, INK, 4); break;
      }
      box(-36, -18, 72, 34, '#f6b73c'); box(-36, -18, 72, 10, '#fdf6df');
      x.fillStyle = '#274b63'; for (let k = 0; k < 4; k++) x.fillRect((-30 + k * 16) * u, -4 * u, 12 * u, 9 * u);
      box(-36, 8, 72, 4, INK); circ(-22, 20, 7.5, INK); circ(22, 20, 7.5, INK); circ(-22, 20, 3, '#cfd4d8'); circ(22, 20, 3, '#cfd4d8'); break;
    }
    case 'plane': {
      x.fillStyle = '#eef2f5'; x.beginPath(); x.ellipse(0, 0, 34 * u, 10 * u, 0, 0, 7); x.fill();
      x.beginPath(); x.moveTo(24 * u, -2 * u); x.lineTo(40 * u, -22 * u); x.lineTo(46 * u, -22 * u); x.lineTo(38 * u, 0); x.closePath(); x.fillStyle = '#d64545'; x.fill();
      x.beginPath(); x.moveTo(-6 * u, 0); x.lineTo(-18 * u, 16 * u); x.lineTo(-8 * u, 16 * u); x.lineTo(4 * u, 2 * u); x.closePath(); x.fillStyle = '#3f7fbf'; x.fill();
      x.fillStyle = '#274b63'; for (let k = 0; k < 5; k++) x.fillRect((-20 + k * 9) * u, -3 * u, 5 * u, 4 * u); break;
    }
    case 'crane': { // Apapa port: crane + container ship hull
      line(-30, 30, -30, -26, INK, 6); line(-30, -26, 30, -26, INK, 6); line(8, -26, 8, -6, INK, 4); line(-30, -26, -6, 30, INK, 3);
      box(0, -4, 17, 13, '#d64545'); box(-38, 22, 76, 10, '#274b63'); box(-30, 12, 20, 10, '#3f7fbf'); box(-8, 12, 20, 10, '#e8a90c'); break;
    }
    case 'pylon': {
      line(-24, 34, 0, -30, INK, 5); line(24, 34, 0, -30, INK, 5); line(-19, 12, 19, 12, INK, 4); line(-13, -6, 13, -6, INK, 4);
      line(-30, -20, 30, -20, INK, 4); line(-34, -14, -30, -20, GOLD, 5); line(34, -14, 30, -20, GOLD, 5);
      circ(0, -34, 5, GOLD); break;
    }
    case 'watertower': {
      box(-16, -26, 32, 30, '#5aa9e6'); x.beginPath(); x.moveTo(-20 * u, -26 * u); x.lineTo(0, -40 * u); x.lineTo(20 * u, -26 * u); x.closePath(); x.fillStyle = '#2f6fb3'; x.fill();
      line(-12, 4, -18, 34, INK, 5); line(12, 4, 18, 34, INK, 5); line(-15, 20, 15, 20, INK, 3);
      x.fillStyle = '#bfe3ff'; x.beginPath(); x.moveTo(24 * u, 8 * u); x.quadraticCurveTo(31 * u, 20 * u, 24 * u, 26 * u); x.quadraticCurveTo(17 * u, 20 * u, 24 * u, 8 * u); x.fill(); break;
    }
    case 'taxdoc': {
      rr(x, -22 * u, -32 * u, 44 * u, 62 * u, 4 * u); x.fillStyle = '#fffdf4'; x.fill(); x.strokeStyle = INK; x.lineWidth = 3.8 * u; x.stroke();
      x.fillStyle = '#b02e2e'; x.font = '900 ' + 24 * u + 'px "Aeonik Pro", sans-serif'; x.textAlign = 'center'; x.fillText('₦', 0, -8 * u);
      x.fillStyle = '#9a8a76'; for (let k = 0; k < 3; k++) x.fillRect(-14 * u, (4 + k * 9) * u, 28 * u, 3.4 * u); break;
    }
    case 'cards': {
      x.save(); x.rotate(-0.22); rr(x, -30 * u, -24 * u, 42 * u, 56 * u, 5 * u); x.fillStyle = '#fffdf4'; x.fill(); x.strokeStyle = INK; x.lineWidth = 3.8 * u; x.stroke(); x.restore();
      x.save(); x.rotate(0.2); rr(x, -12 * u, -26 * u, 42 * u, 56 * u, 5 * u); x.fillStyle = accent || '#d64545'; x.fill(); x.strokeStyle = INK; x.stroke();
      x.fillStyle = '#fff'; x.font = '900 ' + 34 * u + 'px "Aeonik Pro", sans-serif'; x.textAlign = 'center'; x.fillText('?', 9 * u, 12 * u); x.restore(); break;
    }
    case 'bars': {
      x.fillStyle = '#6b6f76'; for (let k = 0; k < 5; k++) x.fillRect((-30 + k * 15) * u, -32 * u, 6 * u, 64 * u);
      box(-38, -36, 76, 7, '#4a4d52'); box(-38, 29, 76, 7, '#4a4d52');
      circ(24, 0, 8, GOLD); box(21, -2, 6, 14, GOLD); break;
    }
    case 'party': {
      x.beginPath(); x.moveTo(-38 * u, -8 * u); x.quadraticCurveTo(0, -34 * u, 38 * u, -8 * u); x.closePath();
      x.fillStyle = '#d94f9e'; x.fill(); x.strokeStyle = '#fff'; x.lineWidth = 3.6 * u;
      for (let k = -2; k <= 2; k++) { x.beginPath(); x.moveTo(k * 14 * u, -20 * u + Math.abs(k) * 3 * u); x.lineTo(k * 14 * u, -6 * u); x.stroke(); }
      x.fillStyle = '#1d9e6c'; const notes = [[-24, 14], [-4, 20], [16, 12], [4, 28], [-16, 29]];
      for (const [a, b] of notes) { x.save(); x.translate(a * u, b * u); x.rotate(0.4); x.fillRect(-9 * u, -4 * u, 18 * u, 8 * u); x.restore(); } break;
    }
    case 'payday': {
      x.beginPath(); x.moveTo(-34 * u, 30 * u); x.lineTo(-34 * u, -6 * u); x.quadraticCurveTo(0, -38 * u, 34 * u, -6 * u); x.lineTo(34 * u, 30 * u); x.lineTo(22 * u, 30 * u); x.lineTo(22 * u, -4 * u); x.quadraticCurveTo(0, -24 * u, -22 * u, -4 * u); x.lineTo(-22 * u, 30 * u); x.closePath();
      x.fillStyle = GOLD; x.fill();
      x.fillStyle = INK; x.font = '900 ' + 34 * u + 'px "Aeonik Pro", sans-serif'; x.textAlign = 'center'; x.fillText('₦', 0, 24 * u); break;
    }
    case 'stilts': {
      line(-26, -2, -26, 30, '#7a4a22', 5); line(0, -2, 0, 32, '#7a4a22', 5); line(26, -2, 26, 30, '#7a4a22', 5);
      box(-30, -24, 60, 22, '#b9793f'); x.beginPath(); x.moveTo(-36 * u, -24 * u); x.lineTo(0, -40 * u); x.lineTo(36 * u, -24 * u); x.closePath(); x.fillStyle = '#7a1f1f'; x.fill();
      x.strokeStyle = '#3f7fbf'; x.lineWidth = 3.6 * u; x.beginPath(); x.moveTo(-38 * u, 34 * u); x.quadraticCurveTo(-19 * u, 28 * u, 0, 34 * u); x.quadraticCurveTo(19 * u, 40 * u, 38 * u, 34 * u); x.stroke(); break;
    }
    case 'ball': {
      circ(0, 0, 27, '#fffdf4'); x.strokeStyle = INK; x.lineWidth = 3.8 * u; x.beginPath(); x.arc(0, 0, 27 * u, 0, 7); x.stroke();
      x.fillStyle = INK; x.beginPath(); for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / 5; const px = Math.cos(a) * 10 * u, py = Math.sin(a) * 10 * u; k ? x.lineTo(px, py) : x.moveTo(px, py); } x.closePath(); x.fill();
      line(-24, -18, -12, -8, INK, 2.4); line(24, -18, 12, -8, INK, 2.4); line(0, 27, 0, 12, INK, 2.4); break;
    }
    case 'bread': {
      x.beginPath(); x.ellipse(0, 4 * u, 32 * u, 19 * u, 0, 0, 7); x.fillStyle = '#d99a4e'; x.fill(); x.strokeStyle = '#a86f2c'; x.lineWidth = 3.6 * u; x.stroke();
      x.strokeStyle = '#f3d9ae'; for (let k = -1; k <= 1; k++) { x.beginPath(); x.moveTo(k * 13 * u - 5 * u, -6 * u); x.lineTo(k * 13 * u + 3 * u, 2 * u); x.stroke(); } break;
    }
    case 'stalls': {
      box(-32, -4, 64, 30, '#a86f2c'); x.fillStyle = '#d64545';
      x.beginPath(); x.moveTo(-38 * u, -4 * u); for (let k = 0; k < 6; k++) x.arc((-32 + k * 12.8) * u, -4 * u, 6.4 * u, Math.PI, 0); x.lineTo(38 * u, 4 * u); x.lineTo(-38 * u, 4 * u); x.closePath(); x.fill();
      circ(-16, 14, 7, '#f08c28'); circ(0, 16, 7, '#d63a2f'); circ(16, 14, 7, '#2e9e5b'); line(-32, -4, -32, -22, INK, 4); line(32, -4, 32, -22, INK, 4); break;
    }
    case 'tech': {
      rr(x, -22 * u, -22 * u, 44 * u, 44 * u, 6 * u); x.fillStyle = '#274b63'; x.fill();
      x.strokeStyle = GOLD; x.lineWidth = 3.8 * u; for (let k = -1; k <= 1; k++) { line(k * 14, -30, k * 14, -22, GOLD, 3); line(k * 14, 22, k * 14, 30, GOLD, 3); line(-30, k * 14, -22, k * 14, GOLD, 3); line(22, k * 14, 30, k * 14, GOLD, 3); }
      circ(0, 0, 8, GOLD); break;
    }
    case 'stadium': {
      x.beginPath(); x.ellipse(0, 6 * u, 36 * u, 20 * u, 0, 0, 7); x.fillStyle = '#c9ccd4'; x.fill();
      x.beginPath(); x.ellipse(0, 6 * u, 24 * u, 11 * u, 0, 0, 7); x.fillStyle = '#2e9e5b'; x.fill();
      line(-30, -6, -30, -28, INK, 4); line(30, -6, 30, -28, INK, 4); circ(-30, -31, 5, '#ffe9a8'); circ(30, -31, 5, '#ffe9a8'); break;
    }
    case 'computer': {
      rr(x, -28 * u, -24 * u, 56 * u, 38 * u, 4 * u); x.fillStyle = '#274b63'; x.fill();
      x.fillStyle = '#7ec3e8'; x.font = '700 ' + 15 * u + 'px monospace'; x.textAlign = 'center'; x.fillText('</>', 0, 3 * u);
      box(-6, 14, 12, 6, INK); box(-20, 22, 40, 5, INK); break;
    }
    case 'palms': case 'island': {
      line(0, 32, -4, -6, '#7a4a22', 6); x.fillStyle = '#2e9e5b';
      for (let k = 0; k < 5; k++) { const a = -0.4 - k * 0.55; x.beginPath(); x.ellipse(Math.cos(a) * 16 * u - 4 * u, -12 * u + Math.sin(a) * 9 * u, 17 * u, 5.5 * u, a + 2.6, 0, 7); x.fill(); }
      if (id === 'island') { x.beginPath(); x.ellipse(0, 34 * u, 34 * u, 7 * u, 0, 0, 7); x.fillStyle = '#e8cf8f'; x.fill(); } break;
    }
    case 'bank': {
      x.beginPath(); x.moveTo(-34 * u, -22 * u); x.lineTo(0, -38 * u); x.lineTo(34 * u, -22 * u); x.closePath(); x.fillStyle = '#8a6d3b'; x.fill();
      x.fillStyle = '#b8a888'; for (let k = 0; k < 4; k++) x.fillRect((-28 + k * 16) * u, -16 * u, 8 * u, 34 * u);
      box(-36, 20, 72, 7, '#8a6d3b'); box(-36, -22, 72, 6, '#8a6d3b'); break;
    }
    case 'dome': {
      x.beginPath(); x.arc(0, 16 * u, 30 * u, Math.PI, 0); x.closePath(); x.fillStyle = '#3f7fbf'; x.fill();
      line(0, -14, 0, -30, INK, 4); circ(0, -32, 4, GOLD); box(-36, 16, 72, 8, '#274b63'); break;
    }
    case 'gate': {
      box(-36, -28, 10, 56, '#6b4a2f'); box(26, -28, 10, 56, '#6b4a2f');
      x.strokeStyle = '#3d3d3d'; x.lineWidth = 4.2 * u; for (let k = 0; k < 4; k++) { x.beginPath(); x.moveTo(-26 * u, (-18 + k * 13) * u); x.lineTo(26 * u, (-18 + k * 13) * u); x.stroke(); }
      box(-40, -34, 80, 8, GOLD); break;
    }
    case 'towers': case 'house': case 'mansion': {
      if (id === 'house') {
        box(-26, -6, 52, 34, '#e8dcc2'); x.beginPath(); x.moveTo(-32 * u, -6 * u); x.lineTo(0, -30 * u); x.lineTo(32 * u, -6 * u); x.closePath(); x.fillStyle = '#b02e2e'; x.fill();
        box(-5, 8, 10, 20, '#7a4a22'); box(-19, 2, 9, 9, '#ffe9a8'); box(10, 2, 9, 9, '#ffe9a8'); break;
      }
      if (id === 'mansion') {
        box(-34, -12, 68, 40, '#f0e6cf'); box(-38, -18, 76, 8, '#5d1414');
        box(-8, 6, 16, 22, '#3d0d0d'); box(-27, -2, 10, 10, '#ffe9a8'); box(17, -2, 10, 10, '#ffe9a8');
        line(-38, 32, 38, 32, '#5d1414', 5); line(-38, 24, -38, 32, '#5d1414', 4); line(38, 24, 38, 32, '#5d1414', 4); break;
      }
      box(-30, -28, 20, 56, '#7d8aa0'); box(-6, -16, 18, 44, '#97a5ba'); box(16, -34, 18, 62, '#6b7a90');
      x.fillStyle = '#ffe9a8'; for (let r2 = 0; r2 < 4; r2++) for (let c2 = 0; c2 < 2; c2++) x.fillRect((-26 + c2 * 8) * u, (-22 + r2 * 12) * u, 5 * u, 6 * u);
      for (let r2 = 0; r2 < 5; r2++) x.fillRect(20 * u, (-28 + r2 * 12) * u, 5 * u, 6 * u); break;
    }
    default: box(-20, -14, 40, 30, accent || GOLD);
  }
  x.restore();
}

// ---------------------------------------------------------------------------
// Tile face textures, drawn in reading space (name reads from the board edge)
// ---------------------------------------------------------------------------
const tileTexCache = {};
// KP11: the canvas is generated for the tile's own rectangular
// proportions in the current layout (wPx from the tile's local width at
// 210px per unit, bucketed to 8px), so the face art never stretches when
// the track spreads. Height is constant: local depth is 1.6 in every
// layout, so H stays 336 and every painter constant below stays true.
function tileTexture(i, mortgaged, wPx) {
  const sp = D.SPACES[i];
  const corner = i % 10 === 0;
  const W = corner ? 336 : (wPx || 208), H = 336;
  const key = i + (mortgaged ? 'm' : '') + 'w' + W;
  if (tileTexCache[key]) return tileTexCache[key];
  const [c, x] = cnvS(W, H, TIER.texScale);
  const band = deepenBand(bandColorFor(i, sp));
  const art = artFor(i, sp);
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#fffdf4'); g.addColorStop(1, '#f6e9cd');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.strokeStyle = 'rgba(43,32,24,0.35)'; x.lineWidth = 3; x.strokeRect(4, 4, W - 8, H - 8);
  x.textAlign = 'center';
  const name = sp.short || sp.name;
  if (sp.type === 'card') {
    x.fillStyle = sp.deck === 'wahala' ? '#f9ded8' : '#dcecfb'; x.fillRect(6, 6, W - 12, H - 12);
    emblem(x, 'cards', W / 2, H * 0.40, corner ? 150 : 118, band);
    x.fillStyle = band; x.fillRect(6, H * 0.70, W - 12, H * 0.24);
    x.fillStyle = '#fff'; fitFont(x, name.toUpperCase(), W - 24, 36, '900', '"Aeonik Pro", sans-serif');
    x.fillText(name.toUpperCase(), W / 2, H * 0.86);
  } else if (corner) {
    emblem(x, art, W / 2, H * 0.40, 168, band);
    x.fillStyle = band; x.fillRect(6, H * 0.70, W - 12, H * 0.24);
    x.fillStyle = lum(band) > 0.55 ? INK : '#fff';
    fitFont(x, name.toUpperCase(), W - 26, 42, '900', '"Aeonik Pro", sans-serif');
    x.fillText(name.toUpperCase(), W / 2, H * 0.865);
    if (i === 0) { x.fillStyle = INK; x.font = '800 24px "Figtree", sans-serif'; x.fillText('Collect ' + D.fmtN(D.START_PAY) + ' salary', W / 2, H * 0.66); }
    if (i === 20) { x.fillStyle = '#6e5510'; x.font = '800 24px "Figtree", sans-serif'; x.fillText('Land here, collect the pot', W / 2, H * 0.66); }
  } else if (sp.type === 'street') {
    x.fillStyle = band; x.fillRect(6, 6, W - 12, H * 0.25);
    x.fillStyle = 'rgba(0,0,0,0.18)'; x.fillRect(6, H * 0.25 + 3, W - 12, 4);
    x.fillStyle = lum(band) > 0.55 ? INK : '#fff';
    const words = name.split(' ');
    let lines = [name];
    if (x.measureText(name).width > 0 && fitFont(x, name.toUpperCase(), W - 20, 36, '900', '"Aeonik Pro", sans-serif') <= 21 && words.length > 1) {
      const mid = Math.ceil(words.length / 2);
      lines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
    }
    x.font = '900 ' + Math.min(36, fitFont(x, lines[0].toUpperCase(), W - 20, 36, '900', '"Aeonik Pro", sans-serif')) + 'px "Aeonik Pro", sans-serif';
    lines.forEach((ln, k) => x.fillText(ln.toUpperCase(), W / 2, H * 0.115 + k * H * 0.085));
    emblem(x, art, W / 2, H * 0.55, 104, band);
    x.fillStyle = INK; x.font = '900 34px "Aeonik Pro", sans-serif';
    x.fillText(D.fmtN(sp.price), W / 2, H * 0.945);
  } else {
    x.fillStyle = band; x.fillRect(6, 6, W - 12, H * 0.075);
    x.fillStyle = INK;
    fitFont(x, name.toUpperCase(), W - 18, 30, '900', '"Aeonik Pro", sans-serif');
    x.fillText(name.toUpperCase(), W / 2, H * 0.20);
    emblem(x, art, W / 2, H * 0.52, 112, band);
    if (sp.price) { x.font = '900 30px "Aeonik Pro", sans-serif'; x.fillText(D.fmtN(sp.price), W / 2, H * 0.945); }
    else if (sp.amount) { x.font = '800 27px "Aeonik Pro", sans-serif'; x.fillText('Pay ' + D.fmtN(sp.amount), W / 2, H * 0.945); }
  }
  if (mortgaged) {
    x.fillStyle = 'rgba(60,60,66,0.45)'; x.fillRect(0, 0, W, H);
    x.save(); x.translate(W / 2, H / 2); x.rotate(-0.5);
    x.fillStyle = 'rgba(255,255,255,0.92)'; x.font = '900 30px "Aeonik Pro", sans-serif'; x.textAlign = 'center';
    x.fillText('MORTGAGED', 0, 10); x.restore();
  }
  const t = texOf(c, true);
  tileTexCache[key] = t;
  return t;
}

// Shared small textures
let _woodTex = null, _noteTex = null, _cardBackTex = null, _winTex = [];
function woodTexture() {
  if (_woodTex) return _woodTex;
  const c = cnv(512, 512), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 512, 512);
  g.addColorStop(0, '#5d4128'); g.addColorStop(0.55, '#3a2817'); g.addColorStop(1, '#2b1c0f');
  x.fillStyle = g; x.fillRect(0, 0, 512, 512);
  for (let k = 0; k < 90; k++) {
    x.strokeStyle = 'rgba(' + (20 + Math.random() * 40) + ',' + (12 + Math.random() * 22) + ',6,' + (0.05 + Math.random() * 0.12) + ')';
    x.lineWidth = 1 + Math.random() * 3;
    const y = Math.random() * 512;
    x.beginPath(); x.moveTo(0, y); x.bezierCurveTo(170, y + 8 - Math.random() * 16, 340, y - 8 + Math.random() * 16, 512, y); x.stroke();
  }
  _woodTex = texOf(c); _woodTex.wrapS = _woodTex.wrapT = THREE.RepeatWrapping;
  return _woodTex;
}
function noteTexture() {
  if (_noteTex) return _noteTex;
  const c = cnv(128, 64), x = c.getContext('2d');
  x.fillStyle = '#7bc47f'; x.fillRect(0, 0, 128, 64);
  x.fillStyle = '#a5ddab'; x.fillRect(6, 6, 116, 52);
  x.fillStyle = '#14532d'; x.font = '900 24px "Aeonik Pro", sans-serif'; x.textAlign = 'center';
  x.fillText('₦50,000', 64, 40);
  x.strokeStyle = '#14532d'; x.lineWidth = 3; x.strokeRect(3, 3, 122, 58);
  _noteTex = texOf(c);
  return _noteTex;
}
function cardBackTexture(deck) {
  const key = deck || 'back';
  if (_cardBackTex && _cardBackTex[key]) return _cardBackTex[key];
  const c = cnv(184, 260), x = c.getContext('2d');
  const col = deck === 'wahala' ? '#b02e2e' : deck === 'family' ? '#2f6fb3' : '#3a2817';
  x.fillStyle = '#fffdf4'; x.fillRect(0, 0, 184, 260);
  x.fillStyle = col; rr(x, 10, 10, 164, 240, 12); x.fill();
  x.strokeStyle = 'rgba(255,255,255,0.65)'; x.lineWidth = 3; rr(x, 20, 20, 144, 220, 9); x.stroke();
  x.fillStyle = '#fff'; x.textAlign = 'center';
  x.font = '900 30px "Aeonik Pro", sans-serif';
  const label = deck === 'wahala' ? 'WAHALA' : deck === 'family' ? 'FAMILY' : 'KOLOPOLY';
  fitFont(x, label, 150, 30, '900', '"Aeonik Pro", sans-serif');
  x.fillText(label, 92, 118);
  if (deck === 'family') { x.font = '900 24px "Aeonik Pro", sans-serif'; x.fillText('MEETING', 92, 148); }
  x.font = '900 44px "Aeonik Pro", sans-serif'; x.fillText('?', 92, 205);
  const t = texOf(c);
  _cardBackTex = _cardBackTex || {}; _cardBackTex[key] = t;
  return t;
}
function windowTexture(base, lit) {
  const c = cnv(128, 256), x = c.getContext('2d');
  x.fillStyle = base; x.fillRect(0, 0, 128, 256);
  for (let r2 = 0; r2 < 9; r2++) for (let c2 = 0; c2 < 4; c2++) {
    x.fillStyle = Math.random() < lit ? '#ffe9a8' : 'rgba(20,28,38,0.55)';
    x.fillRect(10 + c2 * 29, 12 + r2 * 26, 19, 15);
  }
  return texOf(c);
}
// The landing skyline's facade: a finer window grid than the street
// buildings use, because these towers are read at panorama distance
// and the coarse 4x9 grid reads as toy blocks there.
function skylineTexture(base, lit) {
  const c = cnv(128, 256), x = c.getContext('2d');
  x.fillStyle = base; x.fillRect(0, 0, 128, 256);
  for (let r2 = 0; r2 < 16; r2++) for (let c2 = 0; c2 < 8; c2++) {
    x.fillStyle = Math.random() < lit ? '#ffe9a8' : 'rgba(20,28,38,0.5)';
    x.fillRect(6 + c2 * 15, 8 + r2 * 15, 9, 8);
  }
  return texOf(c);
}
function diceFaceTexture(v) {
  const c = cnv(128, 128), x = c.getContext('2d');
  const g = x.createRadialGradient(40, 36, 8, 64, 64, 96);
  g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#e9e2d2');
  x.fillStyle = g; rr(x, 2, 2, 124, 124, 20); x.fill();
  x.strokeStyle = 'rgba(43,32,24,0.25)'; x.lineWidth = 3; rr(x, 3, 3, 122, 122, 19); x.stroke();
  const P = { 1: [64], 2: [34, 94], 3: [32, 64, 96], 4: [34, 94], 5: [34, 94], 6: [34, 94] };
  const pos = {
    1: [[64, 64]], 2: [[36, 36], [92, 92]], 3: [[34, 34], [64, 64], [94, 94]],
    4: [[36, 36], [92, 36], [36, 92], [92, 92]], 5: [[36, 36], [92, 36], [64, 64], [36, 92], [92, 92]],
    6: [[36, 34], [92, 34], [36, 64], [92, 64], [36, 94], [92, 94]]
  }[v];
  x.fillStyle = v === 1 ? '#b02e2e' : INK;
  for (const [a, b] of pos) { x.beginPath(); x.arc(a, b, v === 1 ? 17 : 13, 0, 7); x.fill(); }
  return texOf(c);
}

// ---------------------------------------------------------------------------
// Shared materials and geometry
// ---------------------------------------------------------------------------
const MAT = {
  cream: new THREE.MeshStandardMaterial({ color: 0xf3e6c8, roughness: 0.85 }),
  slabSide: new THREE.MeshStandardMaterial({ color: 0xe9dcbc, roughness: 0.9 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x232323, roughness: 0.6 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x274b63, roughness: 0.25, metalness: 0.35 }),
  white: new THREE.MeshStandardMaterial({ color: 0xfdfbf5, roughness: 0.7 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xc9920e, roughness: 0.35, metalness: 0.55 }),
  shadow: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.20, depthWrite: false })
};
function std(color, rough, metal) { return new THREE.MeshStandardMaterial({ color, roughness: rough == null ? 0.8 : rough, metalness: metal || 0 }); }
function bx(w, h, d, mat, x2, y, z, shadow) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x2 || 0, y || 0, z || 0);
  if (shadow !== false) { m.castShadow = true; m.receiveShadow = true; }
  return m;
}
function cyl(rt, rb, h, mat, x2, y, z, seg) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 20), mat);
  m.position.set(x2 || 0, y || 0, z || 0);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function blobShadow(r) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 20), MAT.shadow);
  m.rotation.x = -Math.PI / 2; m.position.y = 0.012; m.renderOrder = 1;
  return m;
}

// ---------------------------------------------------------------------------
// Tokens: modelled pieces on a player colour disc. Each has its own
// silhouette and signature colour story (danfo yellow, keke green and
// yellow, okada black and red, generator red, boot tan leather, fila deep
// purple) so no two can be confused from across the board.
// ---------------------------------------------------------------------------
const glassMat = new THREE.MeshStandardMaterial({ color: 0xa8d8ea, roughness: 0.08, metalness: 0.25 });
// A box with genuinely rounded edges: a rounded rect extruded with a bevel.
// The mesh base sits at its position y, the top at roughly y + h.
function rbox(w, h, d, r, mat) {
  const rr2 = Math.max(0.005, Math.min(r, w / 2 - 0.002, d / 2 - 0.002));
  const s = new THREE.Shape();
  const hw = w / 2 - rr2, hd = d / 2 - rr2;
  s.moveTo(-hw, -d / 2);
  s.lineTo(hw, -d / 2);
  s.absarc(hw, -hd, rr2, -Math.PI / 2, 0, false);
  s.lineTo(w / 2, hd);
  s.absarc(hw, hd, rr2, 0, Math.PI / 2, false);
  s.lineTo(-hw, d / 2);
  s.absarc(-hw, hd, rr2, Math.PI / 2, Math.PI, false);
  s.lineTo(-w / 2, -hd);
  s.absarc(-hw, -hd, rr2, Math.PI, Math.PI * 1.5, false);
  const bev = Math.min(0.014, h * 0.2);
  const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2, steps: 1, curveSegments: 10 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bev, 0);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
// A tube between two points: forks, limbs, frame rails.
function tube(x1, y1, z1, x2, y2, z2, r, mat) {
  const a = new THREE.Vector3(x1, y1, z1), b = new THREE.Vector3(x2, y2, z2);
  const dir = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, dir.length(), 8), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.castShadow = true;
  return m;
}
// A wheel with a tyre, spokes and a hub, axle along X.
function wheel(r, wdt, hubMat) {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(new THREE.TorusGeometry(r - wdt * 0.26, wdt * 0.30, 10, 22), MAT.dark);
  tyre.rotation.y = Math.PI / 2; tyre.castShadow = true; g.add(tyre);
  const spokeMat = std(0xb9b3a4, 0.4, 0.6);
  for (let k = 0; k < 3; k++) {
    const sp = bx(0.014, (r - wdt * 0.2) * 2, wdt * 0.55, spokeMat, 0, 0, 0, false);
    sp.rotation.x = k * Math.PI / 3;
    g.add(sp);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.30, r * 0.30, wdt * 0.9, 12), hubMat || MAT.gold);
  hub.rotation.z = Math.PI / 2; g.add(hub);
  return g;
}
function decalPlane(w, h, tex) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }));
  m.castShadow = false;
  return m;
}
let _routeTex = null, _genTex = null, _filaTex = null, _grilleTex = null;
function danfoGrilleTexture() {
  if (_grilleTex) return _grilleTex;
  const c = cnv(128, 48), x = c.getContext('2d');
  x.fillStyle = '#2a2a2a'; x.fillRect(0, 0, 128, 48);
  x.fillStyle = '#8f8a7c';
  for (let k = 0; k < 5; k++) x.fillRect(10, 6 + k * 9, 108, 3);
  x.strokeStyle = '#101010'; x.lineWidth = 4; x.strokeRect(2, 2, 124, 44);
  _grilleTex = texOf(c);
  return _grilleTex;
}
function danfoRouteTexture() {
  if (_routeTex) return _routeTex;
  const c = cnv(256, 64), x = c.getContext('2d');
  x.fillStyle = '#fdfbf5'; x.fillRect(0, 0, 256, 64);
  x.strokeStyle = '#232323'; x.lineWidth = 5; x.strokeRect(3, 3, 250, 58);
  x.fillStyle = '#232323'; x.textAlign = 'center';
  fitFont(x, 'OSHODI · CMS', 228, 34, '900', '"Aeonik Pro", sans-serif');
  x.fillText('OSHODI · CMS', 128, 43);
  _routeTex = texOf(c);
  return _routeTex;
}
function genPanelTexture() {
  if (_genTex) return _genTex;
  const c = cnv(256, 160), x = c.getContext('2d');
  x.fillStyle = '#26221f'; x.fillRect(0, 0, 256, 160);
  x.strokeStyle = '#0f0d0b'; x.lineWidth = 6; x.strokeRect(3, 3, 250, 154);
  x.fillStyle = '#4a443d';
  for (let k = 0; k < 7; k++) x.fillRect(18, 18 + k * 13, 96, 6); // grille slats
  x.fillStyle = '#17140f';
  x.fillRect(140, 22, 42, 42); x.fillRect(196, 22, 42, 42); // sockets
  x.fillStyle = '#e8c62a'; x.beginPath(); x.arc(161, 43, 7, 0, 7); x.arc(217, 43, 7, 0, 7); x.fill();
  x.fillStyle = '#c23a2e'; rr(x, 140, 84, 40, 22, 5); x.fill(); // switch
  x.fillStyle = '#fdfbf5'; x.beginPath(); x.arc(213, 108, 24, 0, 7); x.fill(); // gauge
  x.strokeStyle = '#232323'; x.lineWidth = 3; x.beginPath(); x.arc(213, 108, 24, 0, 7); x.stroke();
  x.beginPath(); x.moveTo(213, 108); x.lineTo(226, 94); x.stroke();
  x.fillStyle = '#e8c62a'; x.font = '900 19px "Aeonik Pro", sans-serif'; x.textAlign = 'center';
  x.fillText('TIGER', 64, 140);
  _genTex = texOf(c);
  return _genTex;
}
function filaClothTexture() {
  if (_filaTex) return _filaTex;
  const c = cnv(256, 128), x = c.getContext('2d');
  x.fillStyle = '#5b2a86'; x.fillRect(0, 0, 256, 128);
  x.fillStyle = '#6f3aa0'; for (let k = 0; k < 8; k++) x.fillRect(k * 32, 0, 15, 128);
  x.fillStyle = '#e8c62a';
  for (let ry = 0; ry < 4; ry++) for (let rx = 0; rx < 8; rx++) {
    const cx = 16 + rx * 32, cy = 16 + ry * 32;
    x.save(); x.translate(cx, cy); x.rotate(Math.PI / 4); x.fillRect(-5, -5, 10, 10); x.restore();
  }
  x.fillStyle = 'rgba(232,198,42,0.85)'; x.fillRect(0, 112, 256, 6);
  _filaTex = texOf(c);
  return _filaTex;
}

function buildDanfo(scale) {
  // Yellow Lagos bus: bold body, black waist stripe, route board, readable at ~40px.
  const g = new THREE.Group();
  const yellow = std(0xf6b733, 0.38, 0.08);
  const yellowLite = std(0xffd873, 0.42);
  const body = rbox(0.46, 0.34, 0.72, 0.05, yellow); body.position.set(0, 0.12, 0); g.add(body);
  const roof = rbox(0.44, 0.055, 0.70, 0.02, MAT.white); roof.position.set(0, 0.445, 0); g.add(roof);
  for (const rx of [-0.14, 0.14]) g.add(bx(0.028, 0.022, 0.54, MAT.dark, rx, 0.51, 0));
  for (const rz of [-0.24, 0, 0.24]) g.add(bx(0.34, 0.022, 0.028, MAT.dark, 0, 0.51, rz));
  for (const sx of [-0.233, 0.233]) g.add(bx(0.014, 0.13, 0.52, glassMat, sx, 0.34, -0.02));
  g.add(bx(0.38, 0.13, 0.014, glassMat, 0, 0.34, 0.365));
  g.add(bx(0.34, 0.11, 0.014, glassMat, 0, 0.335, -0.365));
  for (const sx of [-0.234, 0.234]) g.add(bx(0.014, 0.055, 0.70, MAT.dark, sx, 0.20, 0));
  g.add(bx(0.46, 0.055, 0.022, MAT.dark, 0, 0.12, 0.36));
  const grille = decalPlane(0.30, 0.095, danfoGrilleTexture()); grille.position.set(0, 0.185, 0.372); g.add(grille);
  for (const hx of [-0.17, 0.17]) {
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.018, 12), std(0xfff2c0, 0.22, 0.2));
    lamp.rotation.x = Math.PI / 2; lamp.position.set(hx, 0.195, 0.368); g.add(lamp);
  }
  const board = decalPlane(0.34, 0.085, danfoRouteTexture()); board.position.set(0, 0.455, 0.34); board.rotation.x = -0.28; g.add(board);
  for (const sx of [-1, 1]) {
    g.add(tube(sx * 0.23, 0.38, 0.30, sx * 0.295, 0.43, 0.34, 0.009, MAT.dark));
    g.add(bx(0.018, 0.08, 0.055, MAT.dark, sx * 0.30, 0.43, 0.34));
  }
  for (const [wx, wz] of [[-0.23, 0.22], [0.23, 0.22], [-0.23, -0.22], [0.23, -0.22]]) {
    const w = wheel(0.09, 0.055, MAT.white); w.position.set(wx, 0.09, wz); g.add(w);
  }
  g.add(bx(0.42, 0.04, 0.02, yellowLite, 0, 0.28, 0.0)); // side highlight for phone silhouette
  g.scale.setScalar(scale || 1);
  return g;
}
function buildKeke(scale) {
  // Yellow/green tricycle: canopy shell, front cowl, three wheels.
  const g = new THREE.Group();
  const yellow = std(0xf2b234, 0.45), green = std(0x1f9d57, 0.55);
  const body = rbox(0.40, 0.22, 0.52, 0.05, yellow); body.position.set(0, 0.10, 0.04); g.add(body);
  g.add(bx(0.41, 0.055, 0.53, green, 0, 0.12, 0.04));
  const cowl = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), yellow);
  cowl.scale.set(1.08, 0.88, 0.82); cowl.position.set(0, 0.26, -0.25); cowl.castShadow = true; g.add(cowl);
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.022, 12), std(0xfff2c0, 0.22));
  lamp.rotation.x = Math.PI / 2; lamp.position.set(0, 0.29, -0.375); g.add(lamp);
  const shield = bx(0.28, 0.19, 0.014, glassMat, 0, 0.43, -0.26); shield.rotation.x = -0.22; g.add(shield);
  g.add(tube(-0.10, 0.36, -0.22, 0.10, 0.36, -0.22, 0.016, MAT.dark));
  const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.245, 0.245, 0.44, 16, 1, true, Math.PI / 2, Math.PI), new THREE.MeshStandardMaterial({ color: 0x1f9d57, roughness: 0.6, side: THREE.DoubleSide }));
  canopy.rotation.x = Math.PI / 2; canopy.position.set(0, 0.34, 0.06); canopy.castShadow = true; g.add(canopy);
  for (const [px, pz] of [[-0.18, -0.14], [0.18, -0.14], [-0.18, 0.26], [0.18, 0.26]]) g.add(bx(0.034, 0.21, 0.034, MAT.dark, px, 0.40, pz));
  g.add(bx(0.30, 0.055, 0.18, MAT.dark, 0, 0.335, 0.14));
  g.add(bx(0.22, 0.055, 0.11, MAT.dark, 0, 0.32, -0.10));
  const wf = wheel(0.082, 0.05, MAT.white); wf.position.set(0, 0.082, -0.34); g.add(wf);
  for (const sx of [-0.22, 0.22]) { const w = wheel(0.09, 0.055, MAT.white); w.position.set(sx, 0.09, 0.21); g.add(w); }
  g.scale.setScalar(scale || 1);
  return g;
}
function buildOkada(scale) {
  // Motorbike + rider silhouette: tank, helmet, wheels that read as a bike at phone size.
  const g = new THREE.Group();
  const black = std(0x1e1e20, 0.42, 0.35), red = std(0xc22e2e, 0.32, 0.28);
  const skin = std(0x8a5a3b, 0.68), cloth = std(0x274b63, 0.75);
  for (const wz of [-0.27, 0.27]) { const w = wheel(0.125, 0.048, std(0xd8d2c2, 0.35, 0.6)); w.position.set(0, 0.125, wz); g.add(w); }
  g.add(tube(0, 0.125, -0.27, 0, 0.43, -0.16, 0.018, black));
  g.add(tube(0, 0.43, -0.16, 0, 0.355, 0.07, 0.02, black));
  g.add(tube(0, 0.22, 0.03, 0, 0.125, 0.27, 0.016, black));
  g.add(bx(0.34, 0.032, 0.032, black, 0, 0.445, -0.17));
  const tank = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 10), red);
  tank.scale.set(0.74, 0.64, 1.5); tank.position.set(0, 0.365, -0.03); tank.castShadow = true; g.add(tank);
  g.add(bx(0.145, 0.10, 0.18, black, 0, 0.20, 0.03));
  const seat = bx(0.165, 0.05, 0.33, MAT.dark, 0, 0.365, 0.125); seat.rotation.x = 0.05; g.add(seat);
  g.add(bx(0.19, 0.024, 0.10, std(0xd8d2c2, 0.4, 0.6), 0, 0.38, 0.31));
  const lampF = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.04, 0.034, 12), std(0xfff2c0, 0.22));
  lampF.rotation.x = Math.PI / 2 - 0.35; lampF.position.set(0, 0.43, -0.21); g.add(lampF);
  const torso = cyl(0.078, 0.10, 0.32, cloth, 0, 0.575, 0.12); torso.rotation.x = 0.28; g.add(torso);
  for (const sx of [-1, 1]) {
    g.add(tube(sx * 0.06, 0.67, 0.07, sx * 0.14, 0.445, -0.16, 0.022, cloth));
    g.add(tube(sx * 0.08, 0.385, 0.11, sx * 0.125, 0.17, 0.08, 0.026, std(0x33383e, 0.8)));
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.078, 14, 12), skin);
  head.position.set(0, 0.79, 0.05); head.castShadow = true; g.add(head);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.086, 14, 10, 0, Math.PI * 2, 0, 1.35), red);
  helmet.position.set(0, 0.80, 0.05); helmet.castShadow = true; g.add(helmet);
  g.scale.setScalar(scale || 1);
  return g;
}
function buildGenerator(scale) {
  // Red Tiger-style genset: frame cage, panel face, fuel cap, recoil - household Lagos.
  const g = new THREE.Group();
  const red = std(0xc22e2e, 0.42, 0.12);
  for (const [fx, fz] of [[-0.21, 0.14], [0.21, 0.14], [-0.21, -0.14], [0.21, -0.14]]) g.add(bx(0.08, 0.08, 0.08, MAT.dark, fx, 0.04, fz));
  const body = rbox(0.48, 0.32, 0.34, 0.04, red); body.position.set(0, 0.08, 0); g.add(body);
  const panel = decalPlane(0.40, 0.25, genPanelTexture()); panel.position.set(0, 0.235, 0.178); g.add(panel);
  g.add(bx(0.42, 0.26, 0.014, MAT.dark, 0, 0.235, -0.172));
  for (const sx of [-0.255, 0.255]) for (const sz of [-0.18, 0.18]) g.add(tube(sx, 0.06, sz, sx, 0.48, sz, 0.018, MAT.dark));
  for (const sz of [-0.18, 0.18]) g.add(tube(-0.255, 0.48, sz, 0.255, 0.48, sz, 0.018, MAT.dark));
  for (const sx of [-0.255, 0.255]) g.add(tube(sx, 0.48, -0.18, sx, 0.48, 0.18, 0.018, MAT.dark));
  const capTop = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.034, 12), MAT.dark);
  capTop.position.set(-0.13, 0.42, 0); g.add(capTop);
  const starter = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.082, 0.024, 16), MAT.dark);
  starter.rotation.z = Math.PI / 2; starter.position.set(0.255, 0.24, 0); g.add(starter);
  g.scale.setScalar(scale || 1);
  return g;
}
function buildBoot(scale) {
  // Studded football boot: sole, toe box, collar, laces - street football Lagos.
  const g = new THREE.Group();
  const tan = std(0xff7a1a, 0.55), tanDark = std(0xd45e10, 0.58), soleMat = std(0x2a2218, 0.7);
  const sole = rbox(0.22, 0.05, 0.60, 0.02, soleMat); sole.position.set(0, 0.03, 0.01); g.add(sole);
  const toe = rbox(0.205, 0.105, 0.33, 0.05, tan); toe.position.set(0, 0.078, -0.125); toe.rotation.x = 0.05; g.add(toe);
  const heel = rbox(0.20, 0.23, 0.20, 0.045, tan); heel.position.set(0, 0.078, 0.17); heel.rotation.x = -0.06; g.add(heel);
  const tongue = bx(0.125, 0.022, 0.19, tanDark, 0, 0.19, 0.04); tongue.rotation.x = -0.5; g.add(tongue);
  for (let k = 0; k < 4; k++) {
    const lace = bx(0.115, 0.014, 0.024, MAT.white, 0, 0.17 + k * 0.028, 0.09 - k * 0.035);
    lace.rotation.x = -0.5; lace.rotation.y = k % 2 ? 0.16 : -0.16; g.add(lace);
  }
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.102, 0.08, 14, 1, true), new THREE.MeshStandardMaterial({ color: 0xd45e10, roughness: 0.65, side: THREE.DoubleSide }));
  collar.position.set(0, 0.32, 0.17); collar.castShadow = true; g.add(collar);
  const studG = new THREE.CylinderGeometry(0.015, 0.019, 0.034, 8);
  const studM = std(0xd8d2c2, 0.35, 0.6);
  for (const [sx, sz] of [[-0.065, -0.22], [0.065, -0.22], [-0.07, 0.02], [0.07, 0.02], [-0.065, 0.23], [0.065, 0.23]]) {
    const s = new THREE.Mesh(studG, studM); s.position.set(sx, 0.015, sz); g.add(s);
  }
  g.scale.setScalar(scale || 1);
  return g;
}
function buildFila(scale) {
  // Abeti-aja (fila): purple cloth, gold band, dog-ear flaps - readable cap silhouette.
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ map: filaClothTexture(), roughness: 0.82 });
  const purple = std(0x5b2a86, 0.82), purpleDark = std(0x452065, 0.82);
  const bodyM = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.22, 0.26, 20), cloth);
  bodyM.position.y = 0.17; bodyM.castShadow = true; g.add(bodyM);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.17, 18, 10), purple);
  dome.scale.set(1, 0.5, 1); dome.position.y = 0.30; dome.castShadow = true; g.add(dome);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.23, 0.05, 20), std(0xe8c62a, 0.45, 0.35));
  band.position.y = 0.06; g.add(band);
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.19, 10), cloth);
    ear.scale.set(1, 1, 0.44);
    ear.position.set(sx * 0.195, 0.345, 0);
    ear.rotation.z = sx * -0.55;
    ear.castShadow = true; g.add(ear);
  }
  const fold = bx(0.30, 0.085, 0.04, purpleDark, 0, 0.15, 0.195); fold.rotation.x = 0.35; g.add(fold);
  g.scale.setScalar(scale || 1);
  return g;
}
const TOKEN_BUILDERS = { danfo: buildDanfo, keke: buildKeke, okada: buildOkada, generator: buildGenerator, boot: buildBoot, fila: buildFila };
function makeToken(tokenId, colorHex, scale) {
  const g = new THREE.Group();
  // Phone track: thicker coloured pedestal so the piece reads against cream tiles.
  const disc = cyl(0.255, 0.27, 0.055, std(new THREE.Color(colorHex).getHex(), 0.48), 0, 0.028, 0, 24);
  g.add(disc);
  const sc = (scale == null ? 1.18 : scale);
  const inner = (TOKEN_BUILDERS[tokenId] || buildDanfo)(sc);
  inner.position.y = 0.055;
  g.add(inner);
  g.add(blobShadow(0.34));
  g.userData.inner = inner;
  return g;
}

// ---------------------------------------------------------------------------
// Buildings: duplexes rise on the band strip, a mansion replaces four
// ---------------------------------------------------------------------------
function prismRoof(w, d, h, mat) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(0, h); shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true;
  return m;
}
function makeDuplex(colorHex, w) {
  const g = new THREE.Group();
  const body = bx(w, w * 0.62, w * 0.78, MAT.cream, 0, w * 0.31, 0);
  g.add(body);
  const roof = prismRoof(w * 1.12, w * 0.86, w * 0.42, std(new THREE.Color(colorHex).multiplyScalar(0.72).getHex(), 0.7));
  roof.position.y = w * 0.62; g.add(roof);
  g.add(bx(w * 0.20, w * 0.34, 0.02, std(0x5a3a22, 0.8), 0, w * 0.17, w * 0.40));
  g.add(bx(w * 0.22, w * 0.20, 0.02, new THREE.MeshStandardMaterial({ color: 0xffe9a8, roughness: 0.4, emissive: 0x664d12 }), -w * 0.26, w * 0.36, w * 0.40));
  g.add(bx(w * 0.22, w * 0.20, 0.02, new THREE.MeshStandardMaterial({ color: 0xffe9a8, roughness: 0.4, emissive: 0x664d12 }), w * 0.26, w * 0.36, w * 0.40));
  return g;
}
function makeMansion(colorHex, w) {
  const g = new THREE.Group();
  g.add(bx(w, w * 0.52, w * 0.72, std(0xf0e6cf, 0.8), 0, w * 0.26, 0));
  g.add(bx(w * 1.08, w * 0.09, w * 0.80, std(new THREE.Color(colorHex).multiplyScalar(0.6).getHex(), 0.7), 0, w * 0.565, 0)); // flat roof slab
  g.add(bx(w * 0.24, w * 0.38, 0.03, std(0x3d0d0d, 0.7), 0, w * 0.19, w * 0.375)); // door
  const winMat = new THREE.MeshStandardMaterial({ color: 0xffe9a8, roughness: 0.4, emissive: 0x664d12 });
  g.add(bx(w * 0.20, w * 0.18, 0.02, winMat, -w * 0.30, w * 0.32, w * 0.37));
  g.add(bx(w * 0.20, w * 0.18, 0.02, winMat, w * 0.30, w * 0.32, w * 0.37));
  // fence and gate across the front
  g.add(bx(w * 1.02, w * 0.05, 0.025, std(0x5d4a33, 0.8), 0, w * 0.16, w * 0.52));
  for (let k = -2; k <= 2; k++) { if (k === 0) continue; g.add(bx(0.03, w * 0.20, 0.025, std(0x5d4a33, 0.8), k * w * 0.22, w * 0.10, w * 0.52)); }
  g.add(bx(0.05, w * 0.30, 0.05, std(0x5d4a33, 0.8), -w * 0.14, w * 0.15, w * 0.52));
  g.add(bx(0.05, w * 0.30, 0.05, std(0x5d4a33, 0.8), w * 0.14, w * 0.15, w * 0.52));
  return g;
}

// ---------------------------------------------------------------------------
// Dice: pips on every face, the server result rules the settle orientation
// ---------------------------------------------------------------------------
const DIE_TOP = { 1: [0, 0, 0], 2: [-Math.PI / 2, 0, 0], 3: [0, 0, Math.PI / 2], 4: [0, 0, -Math.PI / 2], 5: [Math.PI / 2, 0, 0], 6: [Math.PI, 0, 0] };
function makeDie(size) {
  const mats = [3, 4, 1, 6, 2, 5].map((v) => new THREE.MeshStandardMaterial({ map: diceFaceTexture(v), roughness: 0.35 }));
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mats);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function dieTargetQuat(v, yawK) {
  const e = DIE_TOP[v] || DIE_TOP[1];
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2]));
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (yawK || 0) * Math.PI / 2);
  return yaw.multiply(q);
}

// ---------------------------------------------------------------------------
// Cards in 3D: deck stacks, the drawn card, tray cards, deed card
// ---------------------------------------------------------------------------
function makeCardMesh(w, h, frontTex, backTex) {
  const edge = std(0xf7f1de, 0.6);
  const front = new THREE.MeshStandardMaterial({ map: frontTex, roughness: 0.55 });
  const back = new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.55 });
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.035), [edge, edge, edge, edge, front, back]);
  m.castShadow = true;
  return m;
}
function deckStack(deck, count) {
  const g = new THREE.Group();
  const top = cardBackTexture(deck);
  for (let k = 0; k < count; k++) {
    const card = makeCardMesh(0.92, 1.30, top, top);
    card.position.y = 0.02 + k * 0.016;
    card.rotation.y = (k % 3 - 1) * 0.03;
    g.add(card);
  }
  return g;
}
function nameSprite(name, colorHex, small) {
  const c = cnv(256, 64), x = c.getContext('2d');
  x.fillStyle = colorHex; rr(x, 4, 8, 248, 48, 24); x.fill();
  x.strokeStyle = 'rgba(255,255,255,0.85)'; x.lineWidth = 3; rr(x, 5, 9, 246, 46, 23); x.stroke();
  x.fillStyle = '#fff'; x.textAlign = 'center';
  const nm = name.length > 15 ? name.slice(0, 14) + '…' : name;
  fitFont(x, nm, 224, 30, '800', '"Figtree", sans-serif');
  x.fillText(nm, 128, 33 + (small ? 9 : 10));
  const t = texOf(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  sp.scale.set(2.3, 0.575, 1);
  return sp;
}
function deedCardTexture(i, ownerColor) {
  const sp = D.SPACES[i];
  const c = cnv(220, 312), x = c.getContext('2d');
  const band = bandColorFor(i, sp);
  x.fillStyle = '#fffdf4'; x.fillRect(0, 0, 220, 312);
  x.fillStyle = band; x.fillRect(0, 0, 220, 84);
  x.fillStyle = lum(band) > 0.55 ? INK : '#fff'; x.textAlign = 'center';
  fitFont(x, (sp.short || sp.name).toUpperCase(), 196, 30, '900', '"Aeonik Pro", sans-serif');
  x.fillText((sp.short || sp.name).toUpperCase(), 110, 52);
  x.fillStyle = '#8a7a5f'; x.font = '700 15px "Figtree", sans-serif';
  x.fillText('KOLOPOLY LAND REGISTRY', 110, 116);
  x.fillText('TITLE DEED', 110, 138);
  emblem(x, artFor(i, sp), 110, 196, 74, band);
  x.fillStyle = INK; x.font = '700 24px "Aeonik Pro", sans-serif';
  x.fillText(sp.price ? D.fmtN(sp.price) : '', 110, 288);
  if (ownerColor) { x.strokeStyle = ownerColor; x.lineWidth = 12; x.strokeRect(6, 6, 208, 300); }
  else { x.strokeStyle = 'rgba(43,32,24,0.3)'; x.lineWidth = 3; x.strokeRect(4, 4, 212, 304); }
  return texOf(c);
}
function textSprite(text, opts) {
  const o = opts || {};
  const c = cnv(384, 96), x = c.getContext('2d');
  x.fillStyle = o.bg || 'rgba(30,20,10,0.88)'; rr(x, 6, 14, 372, 68, 18); x.fill();
  x.fillStyle = o.fg || '#ffe9c9'; x.textAlign = 'center';
  fitFont(x, text, 350, o.size || 40, '900', '"Aeonik Pro", sans-serif');
  x.fillText(text, 192, 62);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: texOf(c), transparent: true, depthWrite: false }));
  sp.scale.set(2.7, 0.68, 1);
  return sp;
}

// ---------------------------------------------------------------------------
// Centre floor texture (wordmark, skyline strip, pot and deck labels)
// ---------------------------------------------------------------------------
// KP11: the centre field is the rectangle inside the rectangular track.
// The canvas is generated for the field's own proportions at a constant
// 114px per world unit, so the wordmark, pot and labels stay true-sized
// and undistorted at any box aspect; only the canvas shape and the
// skyline's baseline (tied to the field's north edge) move.
let wordmarkProbe = null;
function measureWordmark(canvas, ts, yLogical, x0, x1, wordZ) {
  // Backing-store scan of the glyph band. A column counts as letter
  // ink when it holds the near-black of KOLO or the gold of POLY.
  // The widest internal hole, in logical pixels, is the gap. One word
  // means that hole is gone.
  let maxGap = 999, ink = 0;
  try {
    const ctx = canvas.getContext('2d');
    const y = Math.max(0, Math.round((yLogical - 120) * ts));
    const h = Math.max(2, Math.round(130 * ts));
    const x = Math.max(0, Math.round((x0 - 2) * ts));
    const w = Math.max(2, Math.min(canvas.width - x, Math.round((x1 - x0 + 4) * ts)));
    const img = ctx.getImageData(x, y, w, Math.min(h, canvas.height - y));
    let gap = 0, seen = false, worst = 0;
    for (let col = 0; col < w; col++) {
      let hit = false;
      for (let row = 0; row < img.height && !hit; row += 2) {
        const i = (row * w + col) * 4;
        const r = img.data[i], gch = img.data[i + 1], b = img.data[i + 2], a = img.data[i + 3];
        if (a < 40) continue;
        // Cream floor is the only thing that counts as a hole. Antialiased
        // edges of the ink and the gold both count as letter.
        const cream = r > 220 && gch > 190 && b > 150;
        if (!cream) hit = true;
      }
      if (hit) {
        ink += 1;
        if (seen && gap > worst) worst = gap;
        seen = true;
        gap = 0;
      } else if (seen) gap += 1;
    }
    maxGap = Math.round(worst / ts);
  } catch (e) { maxGap = 999; ink = 0; }
  return { gap: maxGap, ink, wordZ, bridgeZ: -2.45, text: 'KOLOPOLY', clearOfBridge: wordZ > -1.2 };
}
function centreTexture(innerW, innerD) {
  const K = 114;
  const W = Math.round(innerW * K), H = Math.round(innerD * K);
  // KP13: the centre field is the biggest surface on the tilted board and
  // the most visibly soft surface in the owner's screenshot, so it draws
  // at the centre scale (x1.5 over the painter space on Auto/High/Mid).
  const [c, x] = cnvS(W, H, TIER.centreScale);
  const g = x.createRadialGradient(W / 2, H / 2, 80, W / 2, H / 2, Math.max(W, H) * 0.72);
  g.addColorStop(0, '#fdf3d8'); g.addColorStop(1, '#f0dfba');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.strokeStyle = 'rgba(160,116,32,0.55)'; x.lineWidth = 5; x.strokeRect(26, 26, W - 52, H - 52);
  x.strokeStyle = 'rgba(160,116,32,0.25)'; x.lineWidth = 2; x.strokeRect(44, 44, W - 88, H - 88);
  const px = (wx) => (wx / innerW + 0.5) * W, pz = (wz) => (wz / innerD + 0.5) * H;
  // Lagos skyline wash: stepped towers with lit windows that still read at phone size
  const hs = [70, 120, 88, 150, 96, 132, 74, 118, 84, 140, 92];
  const skyCols = ['rgba(46,80,66,0.42)', 'rgba(55,70,88,0.40)', 'rgba(90,70,48,0.38)'];
  let bx0 = px(-innerW / 2 + 0.2);
  hs.forEach((h, ki) => {
    const w = 52 + (h % 40);
    const top = pz(1.35 - innerD / 2) - h;
    x.fillStyle = skyCols[ki % 3]; x.fillRect(bx0, top, w, h);
    x.fillStyle = 'rgba(255,233,168,0.55)';
    for (let r = 0; r < Math.floor(h / 18); r++) for (let c = 0; c < Math.floor(w / 14); c++) {
      if ((r + c + ki) % 3 === 0) continue;
      x.fillRect(bx0 + 4 + c * 14, top + 6 + r * 18, 7, 8);
    }
    bx0 += w + 14;
  });
  // Third Mainland arc + lagoon wash (believable water, not a flat stripe)
  x.strokeStyle = 'rgba(43,32,24,0.4)'; x.lineWidth = 7;
  x.beginPath(); x.moveTo(px(-4.2), pz(-2.45)); x.quadraticCurveTo(px(0), pz(-3.6), px(4.2), pz(-2.45)); x.stroke();
  const lag = x.createLinearGradient(px(-4.5), pz(-2.8), px(4.5), pz(-1.6));
  lag.addColorStop(0, 'rgba(40,110,170,0.22)'); lag.addColorStop(0.5, 'rgba(70,160,210,0.38)'); lag.addColorStop(1, 'rgba(40,110,170,0.22)');
  x.fillStyle = lag; x.beginPath(); x.moveTo(px(-4.4), pz(-2.55)); x.quadraticCurveTo(px(0), pz(-1.55), px(4.4), pz(-2.55)); x.lineTo(px(4.4), pz(-1.85)); x.quadraticCurveTo(px(0), pz(-1.35), px(-4.4), pz(-1.85)); x.closePath(); x.fill();
  x.strokeStyle = 'rgba(180,220,245,0.45)'; x.lineWidth = 2.5;
  x.beginPath(); x.moveTo(px(-4.2), pz(-2.05)); x.quadraticCurveTo(px(0), pz(-1.7), px(4.2), pz(-2.05)); x.stroke();
  // One continuous wordmark. KOLO stays ink and POLY stays gold, but
  // the two halves share a baseline and overlap by a few pixels so the
  // join cannot open a gap. The bridge (north, z -2.45) never crosses
  // this line: the word sits south of centre as a single run of letters.
  x.textAlign = 'left';
  x.textBaseline = 'alphabetic';
  try { x.letterSpacing = '0px'; } catch (e) { /* older canvas */ }
  x.font = '900 112px "Aeonik Pro", sans-serif';
  // One fill of the whole word, then a clip repaints POLY in gold on
  // the same glyphs. Two separate fillText calls were leaving a hole
  // the bridge sat in. A clip cannot open that hole.
  const word = 'KOLOPOLY';
  const fullW = x.measureText(word).width;
  const kw = x.measureText('KOLO').width;
  const wordZ = 0.95;
  const yWord = pz(wordZ);
  const xWord = px(0) - fullW / 2;
  x.fillStyle = INK;
  x.fillText(word, xWord, yWord);
  x.save();
  x.beginPath();
  x.rect(xWord + kw - 2, yWord - 140, fullW, 180);
  x.clip();
  x.fillStyle = '#b57f10';
  x.fillText(word, xWord, yWord);
  x.restore();
  wordmarkProbe = measureWordmark(c, TIER.centreScale || 1, yWord, xWord, xWord + fullW, wordZ);
  // The slogan takes the old cities subline's slot, set bold and tracked
  // so it reads at frame size.
  x.fillStyle = 'rgba(30,20,9,0.85)'; x.font = '700 33px "Aeonik Pro", sans-serif'; x.textAlign = 'center';
  try { x.letterSpacing = '1.5px'; } catch (e) { /* older canvas: untracked is fine */ }
  x.fillText('Break your kolo, buy the street.', px(0), pz(1.35));
  try { x.letterSpacing = '0px'; } catch (e) { /* noop */ }
  x.fillStyle = 'rgba(138,109,29,0.9)'; x.font = '900 30px "Aeonik Pro", sans-serif';
  x.fillText('OWAMBE POT', px(0), pz(3.35));
  x.fillStyle = 'rgba(43,32,24,0.5)'; x.font = '700 24px "Figtree", sans-serif';
  x.fillText('WAHALA', px(-2.95), pz(-0.28));
  x.fillText('FAMILY MEETING', px(2.95), pz(-0.28));
  return texOf(c, true);
}

// Tile band colour, mirrored from board.js bandColorFor: the landing
// flash (Lesson 8) rings the tile in its own band colour.
function bandColorHex(i, sp) {
  return sp.type === 'street' ? D.GROUPS[sp.group].color
    : sp.type === 'station' ? '#3d3d3d' : sp.type === 'utility' ? '#3f7fbf'
    : i === 0 ? '#e8a90c' : i === 20 ? '#e8a90c' : i === 10 || i === 30 ? '#8c2f2f'
    : sp.type === 'card' ? (sp.deck === 'wahala' ? '#d64545' : '#3f7fbf') : '#b8a888';
}

// ---------------------------------------------------------------------------
// GAME SCENE
// ---------------------------------------------------------------------------
const _zeroLook = new THREE.Vector3();
const PHASE_LOOKS = [
  { key: 0xffd9a0, int: 1.55, bg: 0x2a1a0e },
  { key: 0xffc98a, int: 1.50, bg: 0x2e1c0e },
  { key: 0xff9a6a, int: 1.45, bg: 0x35200f },
  { key: 0xff8a5a, int: 1.35, bg: 0x26150a }
];
class GameScene {
  constructor() {
    const s = this.scene = new THREE.Scene();
    s.background = new THREE.Color(0x2a1a0e);
    // Fog pushed far beyond the board (KP11): the rectangular board now
    // fills the whole box, so a fog band at 30 to 52 units would tint the
    // far tiles toward the void colour. The board (under ~40 units away)
    // sits entirely inside the clear range; the fog remains only as the
    // phase-tinted void past the board's edge.
    s.fog = new THREE.Fog(0x2a1a0e, 60, 140);
    // KP11: the game camera is ORTHOGRAPHIC, fitted to the board. This
    // is the honest route to the owner's 100/100 law: a perspective
    // camera at any finite distance projects the near edge larger than
    // the far edge (measured: width binds at 100 percent only by
    // leaving height at 98.2), so both axes can never coincide with
    // the box at once. Under parallel projection the layout's own
    // proportions are the projection's proportions: the ring spans
    // exactly the frustum, which is the box, on both axes. The view
    // stays the near-plan 87 degree read the game already had.
    this.camera = new THREE.OrthographicCamera(-6.1, 6.1, 6.1, -6.1, 0.1, 120);
    this.camDir = new THREE.Vector3(0, 26.6, 1.4).normalize();
    this.zoomK = 1; // frustum scale: 1 = fitted to the board; <1 = tighter (countdown or Follow)
    this.look = new THREE.Vector3();
    this.lookWant = new THREE.Vector3();
    this.viewFollow = false;
    this.viewKick = 0;
    this.hemi = new THREE.HemisphereLight(0xfff2d8, 0x5a4028, 0.8); s.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffd9a0, 1.55);
    this.key.position.set(7, 13, 8);
    this.key.castShadow = TIER.shadowSize > 0;
    this.key.shadow.mapSize.set(TIER.shadowSize || 1024, TIER.shadowSize || 1024);
    this.key.shadow.camera.left = -10; this.key.shadow.camera.right = 10;
    this.key.shadow.camera.top = 10; this.key.shadow.camera.bottom = -10;
    this.key.shadow.camera.near = 2; this.key.shadow.camera.far = 34;
    this.key.shadow.bias = -0.0006;
    s.add(this.key);
    this.keyLight = this.key;
    const fill = new THREE.DirectionalLight(0xbfd9ff, 0.32); fill.position.set(-7, 9, -6); s.add(fill);
    this.accent = new THREE.PointLight(0xffc857, 0, 12); this.accent.position.set(0, 2.5, 0); s.add(this.accent);
    // KP11: no table, no plinth, no platform, no rim. The owner circled
    // the whole framed assembly and struck it: the tile ring stands on
    // its own, its outer edge is the board's silhouette, and the layout
    // (trackLayout) spreads that ring over the presentation box itself.
    // The layout starts square and reflows to the live box aspect the
    // first time the game stage is fitted (see maybeRelayout).
    this.layout = trackLayout(1);
    this.buildTiles(s);
    this.buildCentre(s);
    this.tokens = new Map();
    this.tokenGroup = new THREE.Group(); s.add(this.tokenGroup);
    this.turnRing = new THREE.Mesh(new THREE.RingGeometry(0.30, 0.40, 28), new THREE.MeshBasicMaterial({ color: 0xffc857, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    this.turnRing.rotation.x = -Math.PI / 2; this.turnRing.position.y = 0.245; this.turnRing.visible = false; s.add(this.turnRing);
    this.pulse = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.46, 28), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    this.pulse.rotation.x = -Math.PI / 2; this.pulse.position.y = 0.25; s.add(this.pulse);
    this.pulseT = 1;
    this.diceAnim = null; this.cardAnim = null; this.deedAnim = null;
    this.syncedOnce = false; // build beats stay silent until the scene has a baseline sync
    this.lastDiceKey = ''; this.lastCardSeq = -1; this.lastFeedSeq = -1;
    this.bankruptSeen = new Set();
    this.countdownZoom = 0;
    this.phaseLook = 0; this.phaseLookCur = { key: new THREE.Color(0xffd9a0), int: 1.55, bg: new THREE.Color(0x2a1a0e) };
  }
  host() { return $('boardWrap'); }

  // Texture width for a tile's face: its local width at 210px per unit,
  // bucketed to 8px, so the generated canvas matches the tile's own
  // rectangular proportions in the live layout (no stretched art).
  texW(t) { return Math.max(160, Math.min(420, Math.round(t.lx * 210 / 8) * 8)); }

  buildTiles(s) {
    this.tiles = [];
    const pickMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true });
    this.pickables = [];
    for (let i = 0; i < 40; i++) {
      const rect = tileRect(i, this.layout);
      const th = tileRotY(i);
      const { lx, lz } = tileLocal(rect, i);
      const grp = new THREE.Group();
      grp.position.set(rect.x + rect.w / 2, 0, rect.z + rect.d / 2);
      grp.rotation.y = th;
      const slabMat = MAT.slabSide.clone();
      const slab = new THREE.Mesh(new THREE.BoxGeometry(1, 0.22, 1), slabMat);
      slab.position.y = 0.11;
      grp.add(slab);
      const topMat = new THREE.MeshStandardMaterial({ roughness: 0.82 });
      const top = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), topMat);
      top.rotation.x = -Math.PI / 2; top.position.y = 0.221; top.receiveShadow = true;
      grp.add(top);
      // owner frame and plaque (hidden until owned), centre edge plaque thicker
      const frame = new THREE.Group();
      const fm = std(0xffffff, 0.5);
      const bars = [];
      for (let k = 0; k < 4; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(1, 0.05, 1), fm); b.position.y = 0.245; frame.add(b); bars.push(b); }
      frame.visible = false;
      grp.add(frame);
      const bld = new THREE.Group(); grp.add(bld);
      const pledge = makeCardMesh(0.44, 0.62, cardBackTexture(null), cardBackTexture(null));
      pledge.rotation.set(-0.5, 0.3, 0.12); pledge.visible = false;
      grp.add(pledge);
      const pick = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), pickMat);
      pick.rotation.x = -Math.PI / 2; pick.position.y = 0.30;
      pick.userData.space = i;
      grp.add(pick); this.pickables.push(pick);
      s.add(grp);
      const t = { i, grp, topMat, slabMat, frame, frameMat: fm, bld, pledge, sig: '', bSig: -1, rect, th, lx, lz, slab, top, pick, bars };
      this.tiles.push(t);
      topMat.map = tileTexture(i, false, this.texW(t));
      this._fitTileParts(t);
    }
  }

  // (Re)build one tile's sized geometry from its current rect: slab, top
  // face, pick plane, the four owner-frame bars and the pledge offset.
  // Buildings are NOT touched here; relayout clears them and the next
  // sync rebuilds them unscaled at the new proportions.
  _fitTileParts(t) {
    const { lx, lz } = t;
    t.slab.geometry.dispose();
    t.slab.geometry = new THREE.BoxGeometry(lx - 0.05, 0.22, lz - 0.05);
    t.top.geometry.dispose();
    t.top.geometry = new THREE.PlaneGeometry(lx - 0.05, lz - 0.05);
    t.pick.geometry.dispose();
    t.pick.geometry = new THREE.PlaneGeometry(lx, lz);
    const fw = 0.075, fh = 0.05;
    const specs = [
      [lx - 0.02, fw, 0, -lz / 2 + fw / 2 + 0.015],
      [lx - 0.02, fw + 0.035, 0, lz / 2 - (fw + 0.035) / 2 - 0.015],
      [fw, lz - 0.02, -lx / 2 + fw / 2 + 0.015, 0],
      [fw, lz - 0.02, lx / 2 - fw / 2 - 0.015, 0]
    ];
    t.bars.forEach((b, k) => {
      const [w, d, px2, pz] = specs[k];
      b.geometry.dispose();
      b.geometry = new THREE.BoxGeometry(w, fh, d);
      b.position.set(px2, 0.245, pz);
    });
    t.pledge.position.set(lx * 0.22, 0.42, lz * 0.16);
  }

  // KP11 reflow: spread the existing tile ring over a new box aspect.
  // Geometry is rebuilt per tile (never scaled, so tokens, buildings and
  // faces keep true proportions); the centre floor and skyline follow.
  relayout(boxAspect) {
    const L = trackLayout(boxAspect, !!this.tallLayout);
    const cur = this.layout;
    if (cur && cur.tallForced === L.tallForced && Math.abs(L.TD / L.TW - cur.TD / cur.TW) < 0.012 && Math.abs(L.TW - cur.TW) < 0.05) return false;
    this.layout = L;
    for (const t of this.tiles) {
      t.rect = tileRect(t.i, L);
      const { lx, lz } = tileLocal(t.rect, t.i);
      t.lx = lx; t.lz = lz;
      t.grp.position.set(t.rect.x + t.rect.w / 2, 0, t.rect.z + t.rect.d / 2);
      this._fitTileParts(t);
      t.bld.clear(); t.bSig = -1; t.sig = ''; // forces texture + building rebuild on next sync
    }
    this._fitCentre();
    for (const o of this.tokens.values()) if (!o.anim) o.grp.position.copy(this.worldFor(o.pos, o.slot));
    if (this.lastState) this.sync(this.lastState);
    return true;
  }
  maybeRelayout(boxAspect) {
    if (!boxAspect || !isFinite(boxAspect) || boxAspect < 0.2 || boxAspect > 5) return;
    if (!this.tiles || !this.tiles.length) return;
    // KP19: a portrait WINDOW always builds the tall construction,
    // whatever the stage box's own aspect. KP18 floored the aspect at
    // square and centred the board with void margins; the owner
    // rejected the margins outright (the board must span its stage
    // 100% x 100%, the KP11 law). So the raw stage aspect now goes
    // through untouched, and trackLayout's tall formula derives the
    // depth from that very aspect, paired with the near-plan camera
    // direction (see update()): a squat stage gets a shallower board
    // at true proportions that still binds both stage axes exactly.
    // Landscape windows keep the two-branch rule exactly as before.
    this.tallLayout = portraitWindow();
    this.relayout(boxAspect);
  }

  buildCentre(s) {
    const L = this.layout;
    const innerW = L.TW - 3.2, innerD = L.TD - 3.2;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(innerW + 0.34, innerD + 0.34), new THREE.MeshStandardMaterial({ map: centreTexture(innerW, innerD), roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0.02; floor.receiveShadow = true; s.add(floor);
    this.floorMesh = floor;
    // skyline row
    const winMats = [0x39594a, 0x51606e, 0x6e5a41].map((col, k) => new THREE.MeshStandardMaterial({ map: skylineTexture('#' + col.toString(16).padStart(6, '0'), 0.55), roughness: 0.78 }));
    // Skyline kept low (tallest 0.52) and riding the centre field's north
    // edge (z = 1.28 - innerD/2, span inside x +-3.95 at the square
    // layout) so it stays strictly inside the centre island and never
    // crowds the top track from the full-board camera. _fitCentre
    // re-seats the row when the layout reflows.
    const hs = [0.25, 0.43, 0.32, 0.52, 0.35, 0.47, 0.28, 0.4, 0.3, 0.48, 0.33];
    this.skylineBars = [];
    let sx = -3.3;
    hs.forEach((h, k) => {
      const w = 0.42 + (k % 3) * 0.1;
      const b = bx(w, h, 0.44, winMats[k % 3], sx + w / 2, h / 2 + 0.02, 1.28 - innerD / 2);
      b.userData.baseX = sx + w / 2;
      sx += w + 0.16; s.add(b); this.skylineBars.push(b);
    });
    // water and bridge
    const water = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 1.0), new THREE.MeshStandardMaterial({ color: 0x2f6fad, roughness: 0.22, metalness: 0.45, envMapIntensity: 0.6 }));
    water.rotation.x = -Math.PI / 2; water.position.set(0, 0.035, -2.45); water.receiveShadow = true; s.add(water);
    const bridgeMat = std(0x333a40, 0.6, 0.3);
    // Bridge arc shrunk (Lesson 6c): radius 1.1 (peak 1.2), deck 2.6 long,
    // piers to match. Between the smaller arc and the wordmark's move
    // south, the bridge can no longer reach the word at any camera angle.
    const arc = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.05, 8, 36, Math.PI), bridgeMat);
    arc.position.set(0, 0.10, -2.45); arc.castShadow = true; s.add(arc);
    s.add(bx(2.6, 0.07, 0.55, bridgeMat, 0, 0.09, -2.45));
    for (const px2 of [-1.0, 0, 1.0]) s.add(bx(0.16, 0.5, 0.4, bridgeMat, px2, -0.1, -2.45));
    this.bridgeDanfo = buildDanfo(0.52); s.add(this.bridgeDanfo);
    // Owambe pot
    const potPts = [];
    [[0.03, 0], [0.30, 0.01], [0.44, 0.10], [0.50, 0.26], [0.47, 0.38], [0.50, 0.42]].forEach((p) => potPts.push(new THREE.Vector2(p[0], p[1])));
    const pot = new THREE.Mesh(new THREE.LatheGeometry(potPts, 22), new THREE.MeshStandardMaterial({ color: 0x9a6a24, roughness: 0.38, metalness: 0.5, side: THREE.DoubleSide }));
    pot.position.set(0, 0.02, 2.35); pot.castShadow = true; s.add(pot);
    this.potNotes = new THREE.Group(); this.potNotes.position.set(0, 0.30, 2.35); s.add(this.potNotes);
    this.potTier = -1;
    this.potLabel = textSprite('Owambe Pot ₦0'); this.potLabel.position.set(0, 1.05, 2.35); s.add(this.potLabel);
    this.potLabelHome = this.potLabel.position.clone(); // anchor for the stage clamp in update()
    // decks and discards
    this.deckPos = { wahala: new THREE.Vector3(-2.95, 0.02, -0.9), family: new THREE.Vector3(2.95, 0.02, -0.9) };
    this.discardPos = { wahala: new THREE.Vector3(-1.90, 0.02, -0.9), family: new THREE.Vector3(1.90, 0.02, -0.9) };
    for (const deck of ['wahala', 'family']) {
      const st = deckStack(deck, 7); st.position.copy(this.deckPos[deck]); st.rotation.y = deck === 'wahala' ? 0.12 : -0.12; s.add(st);
      const dis = makeCardMesh(0.78, 1.10, cardBackTexture(deck), cardBackTexture(deck));
      dis.rotation.x = -Math.PI / 2; dis.rotation.z = 0.2; dis.position.set(this.discardPos[deck].x, 0.055, this.discardPos[deck].z);
      dis.visible = false; s.add(dis); this['discard_' + deck] = dis;
    }
    // dice
    this.dice = [makeDie(0.42), makeDie(0.42)];
    this.diceRest = [new THREE.Vector3(1.55, 0.235, 3.05), new THREE.Vector3(2.35, 0.235, 2.55)];
    this.dice.forEach((d, k) => { d.position.copy(this.diceRest[k]); d.visible = false; s.add(d); });
    // flying card for draws
    this.flyCard = makeCardMesh(0.78, 1.10, cardBackTexture('wahala'), cardBackTexture(null));
    this.flyCard.visible = false; s.add(this.flyCard);
    // held card tray at the centre south edge
    this.tray = new THREE.Group(); s.add(this.tray);
    this.trayCards = new Map();
    // deed card that rises from a tapped tile
    this.deedCard = makeCardMesh(1.05, 1.48, deedCardTexture(39, null), cardBackTexture(null));
    this.deedCard.visible = false; s.add(this.deedCard);
  }

  // Refit the centre field to the current layout: the floor plane grows
  // into the rectangle (its texture regenerated at the field's own
  // proportions, so the wordmark stays true-sized) and the skyline row
  // spreads along the field's north edge. The bridge, pot, decks and
  // dice keep their fixed centre positions and true sizes.
  _fitCentre() {
    if (!this.floorMesh) return;
    const L = this.layout;
    const innerW = L.TW - 3.2, innerD = L.TD - 3.2;
    this.floorMesh.geometry.dispose();
    this.floorMesh.geometry = new THREE.PlaneGeometry(innerW + 0.34, innerD + 0.34);
    if (this.floorMesh.material.map) this.floorMesh.material.map.dispose();
    this.floorMesh.material.map = centreTexture(innerW, innerD);
    this.floorMesh.material.needsUpdate = true;
    const spread = innerW / 9;
    for (const b of this.skylineBars || []) {
      b.position.x = b.userData.baseX * spread;
      b.position.z = 1.28 - innerD / 2;
    }
  }

  setPot(pot) {
    const tier = pot <= 0 ? 0 : pot < 100000 ? 1 : pot < 300000 ? 2 : pot < 600000 ? 3 : pot < 1000000 ? 4 : 5;
    if (tier !== this.potTier) {
      this.potTier = tier;
      this.potNotes.clear();
      const n = tier * 3;
      for (let k = 0; k < n; k++) {
        const note = bx(0.36, 0.018, 0.18, new THREE.MeshStandardMaterial({ map: noteTexture(), roughness: 0.7 }), (Math.random() - 0.5) * 0.4, 0.04 + k * 0.02, (Math.random() - 0.5) * 0.3);
        note.rotation.y = Math.random() * 1.2 - 0.6;
        this.potNotes.add(note);
      }
    }
    const label = 'Owambe Pot ' + D.fmtN(pot);
    if (this.potLabelText !== label) {
      this.potLabelText = label;
      const nl = textSprite(label); nl.position.copy(this.potLabelHome || this.potLabel.position);
      this.scene.remove(this.potLabel); this.potLabel = nl; this.scene.add(nl);
    }
  }

  worldFor(i, slotIdx) {
    const t = this.tiles[i];
    const off = TOKEN_SLOTS[slotIdx % TOKEN_SLOTS.length];
    const w = localToWorld(t.rect, t.th, off[0] * Math.min(t.lx, 1.15), off[1] * Math.min(t.lz, 1.5));
    return new THREE.Vector3(w.x, 0.22, w.z);
  }

  sync(state) {
    this.lastState = state;
    if (KP3D._pendingView) { const mode = KP3D._pendingView; KP3D._pendingView = null; KP3D.setView(mode); }
    // KP15: a turn boundary is a gated moment: a pending Auto step is
    // applied here, in the same beat as the state-driven redraw that
    // follows a turn change, never in the middle of a hop or a cascade.
    const turnKey = (state.status || '') + ':' + (state.turnPlayerId || '');
    if (this._turnKey !== turnKey) { this._turnKey = turnKey; flushPendingAutoPr(); }
    // tiles: ownership, mortgage, buildings, pledges
    const byId = {}; for (const p of state.players) byId[p.id] = p;
    for (let i = 0; i < 40; i++) {
      const t = this.tiles[i];
      const pr = state.props[i];
      const sig = pr ? (pr.o + '|' + pr.m + '|' + pr.b + '|' + pr.pl) : 'x';
      if (sig === t.sig) continue;
      t.sig = sig;
      if (pr && pr.o != null) {
        const owner = byId[pr.o];
        t.frame.visible = true;
        t.frameMat.color.set(owner ? owner.color : '#ffffff');
        t.topMat.map = tileTexture(i, !!pr.m, this.texW(t));
        t.topMat.color.set(pr.m ? 0x8f8f8f : 0xffffff);
        t.topMat.needsUpdate = true;
      } else {
        t.frame.visible = false;
        t.topMat.map = tileTexture(i, false, this.texW(t));
        t.topMat.color.set(0xffffff);
        t.topMat.needsUpdate = true;
      }
      t.pledge.visible = !!(pr && pr.pl);
      // buildings
      const wantB = pr && pr.o != null ? pr.b : 0;
      if (wantB !== t.bSig) {
        const prevB = t.bSig;
        t.bSig = wantB;
        // a building born upward (not a layout rebuild, prevB -1, and
        // not the scene's first sync) is a sound beat: it lands with
        // the growth animation this sync just started
        if (prevB >= 0 && wantB > prevB && this.syncedOnce) beat('build', { kind: wantB >= 5 ? 'mansion' : 'duplex', space: i });
        t.bld.clear();
        const sp = D.SPACES[i];
        if (wantB > 0 && sp.type === 'street') {
          const col = D.GROUPS[sp.group].color;
          const stripZ = -t.lz / 2 + 0.30;
          if (wantB >= 5) {
            const m = makeMansion(col, Math.min(t.lx * 0.52, 0.86));
            m.position.set(0, 0.22, stripZ + 0.05);
            m.userData.born = performance.now();
            t.bld.add(m);
            if (TIER.shadowSize === 0) { const bl = blobShadow(Math.min(t.lx * 0.52, 0.86) * 0.62); bl.position.set(0, 0.235, stripZ + 0.05); t.bld.add(bl); }
          } else {
            const w = Math.min(0.30, t.lx * 0.205);
            for (let k = 0; k < wantB; k++) {
              const d = makeDuplex(col, w);
              d.position.set((k - (wantB - 1) / 2) * (w + 0.055), 0.22, stripZ);
              d.userData.born = performance.now() + k * 80;
              t.bld.add(d);
              if (TIER.shadowSize === 0) { const bl = blobShadow(w * 0.62); bl.position.set((k - (wantB - 1) / 2) * (w + 0.055), 0.235, stripZ); t.bld.add(bl); }
            }
          }
        }
      }
    }
    this.setPot(state.pot || 0);
    // legal build highlights
    const legal = B.legalSet;
    for (const t of this.tiles) {
      const on = !!legal && legal.has(t.i);
      t.slabMat.emissive = t.slabMat.emissive || new THREE.Color(0);
      t.slabMat.emissive.setHex(on ? 0x8a6a10 : 0x000000);
    }
    // dice
    const dkey = state.dice ? state.dice.join(',') : '';
    if (dkey !== this.lastDiceKey) {
      this.lastDiceKey = dkey;
      if (state.dice && state.status === 'playing') {
        this.dice.forEach((d, k) => {
          d.visible = true;
          this.diceAnim = this.diceAnim || { t: 0, dur: 0.9, from: [], to: [], pFrom: [], pTo: [] };
          this.diceAnim.from[k] = d.quaternion.clone();
          this.diceAnim.to[k] = dieTargetQuat(state.dice[k], (Math.random() * 4) | 0);
          this.diceAnim.pFrom[k] = new THREE.Vector3(0.4 - k * 0.7, 2.6, 0.8);
          this.diceAnim.pTo[k] = this.diceRest[k].clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3));
        });
        this.diceAnim.t = 0;
        this.diceAnim.values = state.dice.slice();
        beat('diceStart', { values: state.dice.slice() });
        if (state.dice[0] === state.dice[1]) this.accentT = 1;
      }
    }
    // drawn card (table-wide theatre; the DOM face belongs to the drawer)
    if (state.lastCard && state.lastCard.seq !== this.lastCardSeq) {
      this.lastCardSeq = state.lastCard.seq;
      this.startCardAnim(state.lastCard, false);
    }
    // feed: scaled money theatre
    const feed = state.feed || [];
    if (this.lastFeedSeq < 0 && feed.length) this.lastFeedSeq = feed[feed.length - 1].seq;
    for (const e of feed) {
      if (e.seq <= this.lastFeedSeq) continue;
      this.lastFeedSeq = e.seq;
      const p = byId[e.playerId];
      if (e.kind === 'jackpot' && e.amount >= 100000) bigMoment('OWAMBE JACKPOT', p ? p.name : 'A landlord', e.amount, 'collect the full Owambe pot. Spray am for everybody.');
      else if ((e.kind === 'credit' || e.kind === 'debit') && e.amount >= 750000) bigMoment(e.amount >= 1500000 ? 'MANSION MONEY' : 'BIG HIT', p ? p.name : 'A player', e.amount, e.text || '');
    }
    for (const p of state.players) if (p.bankrupt && !this.bankruptSeen.has(p.id)) {
      this.bankruptSeen.add(p.id);
      if (state.inf && state.inf.phase === 3 && state.status === 'playing') bigMoment('PHASE 3 EXECUTION', p.name, null, 'don commot for the table. Inflation no dey pity anybody.');
    }
    this.syncTokens(state);
    this.syncTray(state);
    this.syncedOnce = true;
    // phase relight targets
    const look = PHASE_LOOKS[state.inf ? state.inf.phase - 1 : 0];
    this.phaseTarget = { key: new THREE.Color(look.key), int: look.int, bg: new THREE.Color(look.bg) };
    if (state.status === 'countdown' && !this.countedFor) { this.countedFor = state.code; this.countdownZoom = 2.4; this.camDir.set(0, 20, 18).normalize(); this.zoomK = 0.7; }
    if (state.status === 'playing') this.countedFor = null;
  }

  syncTokens(state) {
    const seen = new Set();
    const slotCount = {};
    for (const p of state.players) {
      seen.add(p.id);
      const slot = slotCount[p.position] || 0; slotCount[p.position] = slot + 1;
      let o = this.tokens.get(p.id);
      if (!o) {
        const grp = makeToken(p.token, p.color, 1);
        this.tokenGroup.add(grp);
        o = { grp, inner: grp.userData.inner, pos: p.position, target: p.position, anim: null, bob: Math.random() * 6, slot };
        this.tokens.set(p.id, o);
        grp.position.copy(this.worldFor(p.position, slot));
      }
      o.slot = slot;
      o.bankrupt = p.bankrupt; o.inJail = p.inJail;
      // bankrupt tokens sink and shrink a touch; materials are shared, so no opacity tricks
      o.grp.scale.setScalar(p.bankrupt ? 0.78 : 1);
      if (o.target !== p.position) {
        const from = o.target;
        o.target = p.position;
        if (o.anim) { o.pos = o.anim.cur; o.anim = null; }
        const fwd = (p.position - from + 40) % 40;
        if (p.inJail || fwd > 12 || fwd === 0 || state.status !== 'playing') {
          o.pos = p.position;
          o.grp.position.copy(this.worldFor(p.position, slot));
          // the Kirikiri teleport IS the door visual: the clang lands here
          if (p.inJail) beat('jailIn', { playerId: p.id });
        } else {
          const path = [];
          let cur = from;
          while (cur !== p.position) { cur = (cur + 1) % 40; path.push(cur); }
          o.anim = { path, t: 0, step: 0.235, cur: from };
        }
      } else if (!o.anim) {
        o.grp.position.copy(this.worldFor(p.position, slot));
      }
    }
    for (const [id, o] of this.tokens) if (!seen.has(id)) { this.tokenGroup.remove(o.grp); this.tokens.delete(id); }
    // turn ring follows the turn player's token, in the player's own
    // colour (Lesson 8): the active piece is findable at a glance.
    const turn = state.players.find((p) => p.id === state.turnPlayerId);
    if (turn && state.status === 'playing') {
      const o = this.tokens.get(turn.id);
      if (o) {
        this.turnRing.visible = true;
        this.turnRing.position.set(o.grp.position.x, 0.245, o.grp.position.z);
        this.turnRing.material.color.set(turn.color);
      }
    } else this.turnRing.visible = false;
  }

  syncTray(state) {
    const holders = state.players.filter((p) => p.goojf > 0 && !p.bankrupt);
    const want = new Set(holders.map((p) => p.id));
    for (const [id, m] of this.trayCards) if (!want.has(id)) { this.tray.remove(m); this.trayCards.delete(id); }
    holders.forEach((p, idx) => {
      let m = this.trayCards.get(p.id);
      if (!m) {
        m = makeCardMesh(0.56, 0.80, trayCardTexture(p.color), cardBackTexture(null));
        m.userData.trayPlayer = p.id;
        this.tray.add(m); this.trayCards.set(p.id, m);
        this.pickables.push(m);
      }
      m.position.set(-1.05 + idx * 0.72 + (p.goojf > 1 ? 0.1 : 0), 0.44, 4.02);
      m.rotation.set(-0.38, 0, 0);
      m.scale.setScalar(p.goojf > 1 ? 1.06 : 1);
    });
  }

  startCardAnim(card, fromHook) {
    const deck = card.deck;
    const front = cardBackTexture(deck);
    this.flyCard.material[4].map = front; this.flyCard.material[4].needsUpdate = true;
    this.flyCard.visible = true;
    this.cardAnim = {
      deck, cardId: card.id, drawerId: card.playerId,
      t: 0, phase: 'lift', holdMode: fromHook ? 'modal' : 'auto', holdT: 0,
      from: this.deckPos[deck].clone().add(new THREE.Vector3(0, 0.16, 0)),
      hover: new THREE.Vector3(0, 1.95, 1.15)
    };
    this.flyCard.position.copy(this.cardAnim.from);
    this.flyCard.rotation.set(0, Math.PI, 0);
    beat('cardLift', { deck });
  }
  resolveCard(card) {
    if (this.cardAnim && this.cardAnim.cardId === card.id && this.cardAnim.phase !== 'exit') {
      this.cardAnim.phase = 'exit'; this.cardAnim.t = 0;
      this.cardAnim.exitTo = card.id === 'w08' ? 'tray' : 'discard';
    }
  }

  showDeed(i) {
    const st = this.lastState;
    const pr = st ? st.props[i] : null;
    const owner = pr && pr.o != null ? st.players.find((p) => p.id === pr.o) : null;
    this.deedCard.material[4].map = deedCardTexture(i, owner ? owner.color : null);
    this.deedCard.material[4].needsUpdate = true;
    const t = this.tiles[i];
    const c = localToWorld(t.rect, t.th, 0, 0);
    this.deedAnim = { t: 0, mode: 'rise', i };
    this.deedCard.visible = true;
    this.deedCard.position.set(c.x, 0.3, c.z);
    this.deedCard.rotation.set(-0.42, 0, 0);
  }
  hideDeed() { if (this.deedAnim) this.deedAnim.mode = 'sink'; }

  onTap(raycaster, ndc, camera) {
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(this.pickables, false);
    if (!hits.length) return;
    const h = hits[0].object;
    if (h.userData.space != null) {
      // KP10: a tap opens the deed, nothing more. The camera never zooms
      // or chases: the whole board is already on screen.
      if (B.onSpaceTap) B.onSpaceTap(h.userData.space);
    } else if (h.userData.trayPlayer != null) {
      const btn = $('abJailCard');
      if (btn) btn.click();
      else {
        const m = this.trayCards.get(h.userData.trayPlayer);
        if (m) { m.userData.pulse = 1; }
      }
    }
  }

  // The fitted view direction per stage shape: near plan (about 87
  // degrees) for portrait and squarish stages, a lower 72 degrees for
  // wide landscape stages. trackLayout's elevation factors mirror these
  // two directions exactly.
  _followToken() {
    for (const o of this.tokens.values()) if (o.anim) return o;
    const st = this.lastState;
    if (st && this.tokens.has(st.turnPlayerId)) return this.tokens.get(st.turnPlayerId);
    const first = this.tokens.values().next();
    return first && first.value ? first.value : null;
  }
  fullDir(aspect) {
    if (aspect < 1.2) return new THREE.Vector3(0, 26.6, 1.4).normalize();
    return new THREE.Vector3(0, 22.1, 7.2).normalize();
  }
  // KP11 fit: set the orthographic frustum to the board itself. The
  // frustum's width span is the track width; its height span is the
  // track depth times the view direction's depth factor (the component
  // of the world z axis that survives projection). Because trackLayout
  // built the footprint from the box's own aspect with that same
  // factor, the frustum's aspect IS the box's aspect, so the renderer
  // maps it onto the canvas with no stretch and the ring's silhouette
  // coincides with the box edges at exactly 100 percent on both axes:
  // nothing cut, nothing left over. zoomK tightens the frustum for the
  // countdown pass only; the fitted game sits at zoomK 1.
  _applyCam() {
    const cam = this.camera;
    const L = this.layout || trackLayout(1);
    const d = this.camDir;
    const f = Math.sqrt(Math.max(0.05, 1 - d.z * d.z));
    const halfW = (L.TW / 2) * this.zoomK;
    const halfH = (L.TD * f / 2) * this.zoomK;
    cam.left = -halfW; cam.right = halfW; cam.top = halfH; cam.bottom = -halfH;
    const look = this.look || _zeroLook;
    cam.position.copy(d).multiplyScalar(30).add(look);
    cam.lookAt(look);
    cam.updateProjectionMatrix();
  }

  update(dt, tNow) {
    const s = this.scene;
    // bridge danfo shuttle (range and height follow the smaller arc)
    const bu = (Math.sin(tNow * 0.13) + 1) / 2;
    const bx2 = -0.92 + bu * 1.84;
    this.bridgeDanfo.position.set(bx2, 0.16 + Math.sin(bu * Math.PI) * 0.92, -2.45);
    this.bridgeDanfo.rotation.z = Math.cos(bu * Math.PI) * 0.42 * (Math.cos(tNow * 0.13) > 0 ? 1 : -1);
    this.bridgeDanfo.rotation.y = Math.cos(tNow * 0.13) > 0 ? Math.PI / 2 : -Math.PI / 2;
    // pot notes gentle shimmer
    this.potNotes.rotation.y = Math.sin(tNow * 0.4) * 0.05;
    // tokens: hops, idle bob, jail cell tilt
    for (const [pid, o] of this.tokens) {
      if (o.anim) {
        const a = o.anim;
        a.t += dt;
        const k = Math.min(1, a.t / a.step);
        const fromI = a.path.length && a.t >= 0 ? a.cur : a.cur;
        const nextI = a.path[0];
        const p0 = this.worldFor(fromI, o.slot), p1 = this.worldFor(nextI, o.slot);
        const pos = p0.clone().lerp(p1, k);
        pos.y = 0.22 + Math.sin(k * Math.PI) * 0.34;
        if (k < 0.22) { o.inner.scale.y = 0.88; o.inner.position.y = 0.045 - 0.02; }
        else if (k > 0.9) { o.inner.scale.y = 0.86; }
        else { o.inner.scale.y = 1; o.inner.position.y = 0.045; }
        o.grp.position.copy(pos);
        // Lesson 8: the moving piece grows a touch so the eye can track it.
        o.grp.scale.setScalar((o.bankrupt ? 0.78 : 1) * 1.12);
        if (k >= 1) {
          a.cur = nextI; a.path.shift(); a.t = 0;
          beat('hop', { playerId: pid });
          o.pos = nextI;
          // The landing tile flashes its own band colour.
          this.pulse.material.color.set(bandColorHex(nextI, D.SPACES[nextI]));
          this.pulse.position.set(pos.x, 0.25, pos.z); this.pulseT = 0;
          if (!a.path.length) {
            o.anim = null; o.inner.scale.y = 1; o.grp.scale.setScalar(o.bankrupt ? 0.78 : 1);
            beat('land', { playerId: pid, space: nextI });
          }
        }
      } else {
        o.inner.position.y = 0.045 + Math.sin(tNow * 1.7 + o.bob) * 0.012;
        o.inner.rotation.y = Math.sin(tNow * 0.6 + o.bob) * 0.05;
      }
      if (o.inJail) o.grp.rotation.z = 0.0;
    }
    if (this.pulseT < 1) {
      this.pulseT = Math.min(1, this.pulseT + dt * 2.2);
      const sc = 1 + this.pulseT * 1.7;
      this.pulse.scale.set(sc, sc, 1);
      this.pulse.material.opacity = 0.55 * (1 - this.pulseT);
    }
    this.turnRing.material.opacity = 0.6 + Math.sin(tNow * 3.2) * 0.25;
    const ringPulse = 1 + Math.sin(tNow * 3.2) * 0.07;
    this.turnRing.scale.set(ringPulse, ringPulse, 1);
    // buildings grow in
    const nowMs = performance.now();
    for (const t2 of this.tiles) {
      if (!t2.bld.children.length) continue;
      for (const b of t2.bld.children) {
        const born = b.userData.born || 0;
        const k = Math.max(0, Math.min(1, (nowMs - born) / 480));
        if (k < 1) {
          const e = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2); // soft overshoot
          b.scale.y = Math.max(0.01, k === 0 ? 0.01 : (1 - Math.pow(1 - k, 3)) * (0.92 + 0.08 * e));
        } else if (b.scale.y !== 1) b.scale.y = 1;
      }
    }
    // dice tumble
    if (this.diceAnim) {
      const a = this.diceAnim;
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.dice.forEach((d, idx) => {
        if (!a.from[idx]) return;
        d.quaternion.slerpQuaternions(a.from[idx], a.to[idx], e);
        const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 1, 0.2).normalize(), (1 - k) * 9 * (idx ? -1 : 1));
        d.quaternion.premultiply(spin);
        const pos = a.pFrom[idx].clone().lerp(a.pTo[idx], e);
        pos.y += Math.sin(k * Math.PI) * 0.5 + (1 - k) * 0.4;
        d.position.copy(pos);
      });
      if (k >= 1) {
        const vals = a.values || [];
        this.diceAnim = null;
        beat('diceSettle', { doubles: vals.length === 2 && vals[0] === vals[1] });
      }
    }
    // flying card
    if (this.cardAnim) {
      const a = this.cardAnim;
      const card = this.flyCard;
      if (a.phase === 'lift') {
        a.t += dt;
        const k = Math.min(1, a.t / 0.6);
        const e = 1 - Math.pow(1 - k, 3);
        card.position.lerpVectors(a.from, a.hover, e);
        card.position.y += Math.sin(k * Math.PI) * 0.35;
        card.rotation.y = Math.PI * (1 - e);
        card.rotation.x = -0.16 * e;
        if (k >= 1) { a.phase = 'hold'; a.holdT = 0; beat('cardReveal', { deck: a.deck }); }
      } else if (a.phase === 'hold') {
        a.holdT += dt;
        card.position.y = a.hover.y + Math.sin(tNow * 2.1) * 0.05;
        if (a.holdMode === 'auto' && a.holdT > 2.6) { a.phase = 'exit'; a.t = 0; a.exitTo = a.cardId === 'w08' ? 'tray' : 'discard'; a.from = card.position.clone(); }
      } else if (a.phase === 'exit') {
        a.t += dt;
        const k = Math.min(1, a.t / 0.55);
        const e = k * k;
        const dest = a.exitTo === 'tray'
          ? new THREE.Vector3(0, 0.5, 4.02)
          : this.discardPos[a.deck].clone().add(new THREE.Vector3(0, 0.10, 0));
        card.position.lerpVectors(a.from || a.hover, dest, e);
        card.rotation.x = a.exitTo === 'tray' ? -0.38 * e : (-Math.PI / 2 + 0.16) * e;
        card.rotation.y *= (1 - e);
        const sc = 1 - e * (a.exitTo === 'tray' ? 0.4 : 0.15);
        card.scale.setScalar(sc);
        if (k >= 1) {
          card.visible = false; card.scale.setScalar(1); card.rotation.set(0, 0, 0);
          if (a.exitTo === 'discard') this['discard_' + a.deck].visible = true;
          this.cardAnim = null;
        }
      }
    }
    // deed card rise and sink
    if (this.deedAnim) {
      const a = this.deedAnim;
      a.t += dt;
      if (a.mode === 'rise') {
        const k = Math.min(1, a.t / 0.45);
        this.deedCard.position.y = 0.3 + (1 - Math.pow(1 - k, 3)) * 1.2;
        if (k >= 1) a.mode = 'hover';
      } else if (a.mode === 'hover') {
        this.deedCard.position.y = 1.5 + Math.sin(tNow * 1.8) * 0.04;
      } else if (a.mode === 'sink') {
        const k = Math.min(1, a.t / 0.3);
        this.deedCard.position.y = 1.5 * (1 - k) + 0.2;
        if (k >= 1) { this.deedCard.visible = false; this.deedAnim = null; }
      }
    }
    // tray pulse feedback
    for (const m of this.trayCards.values()) if (m.userData.pulse) { m.userData.pulse = 0; m.scale.setScalar(1.18); setTimeout(() => m.scale.setScalar(1), 160); }
    // phase light easing
    if (this.phaseTarget) {
      const c = this.phaseLookCur;
      c.key.lerp(this.phaseTarget.key, dt * 2); c.bg.lerp(this.phaseTarget.bg, dt * 2);
      c.int += (this.phaseTarget.int - c.int) * Math.min(1, dt * 2);
      this.key.color.copy(c.key); this.key.intensity = c.int;
      s.background.copy(c.bg); s.fog.color.copy(c.bg);
    }
    if (this.accentT > 0) { this.accentT = Math.max(0, this.accentT - dt * 1.4); this.accent.intensity = this.accentT * 14; }
    // camera
    let wantDir, wantZoom, damp = 2.4;
    this.lookWant.set(0, 0, 0);
    if (this.countdownZoom > 0) {
      // The 3-2-1 countdown opens on a closer angled pass (a tighter
      // frustum on a lower direction), then the camera glides out to
      // the fitted framing and stays.
      this.countdownZoom -= dt;
      wantDir = new THREE.Vector3(0, 12.6, 11.4).normalize(); wantZoom = 0.62; damp = 1.1;
    } else if (this.viewFollow) {
      // Follow: about 2.2x on the moving token. Full stays the fitted
      // board (zoom 1, the full-bleed frustum). A toggle applies on the
      // next frame, including mid hop. The glide is about 300ms.
      wantDir = this.fullDir(portraitWindow() ? 1 : (this.camera.aspect || 1));
      wantZoom = 1 / 2.2;
      const tok = this._followToken();
      if (tok) this.lookWant.set(tok.grp.position.x, 0, tok.grp.position.z);
      damp = this.viewKick > 0 ? 11 : 7;
    } else {
      // Full board: the fitted orthographic frustum (see _applyCam),
      // centred, edge to edge. Portrait keeps the near-plan direction
      // even on a squat stage.
      wantDir = this.fullDir(portraitWindow() ? 1 : (this.camera.aspect || 1)); wantZoom = 1;
      if (this.viewKick > 0) damp = 11;
    }
    if (this.viewKick > 0) this.viewKick = Math.max(0, this.viewKick - dt);
    const kk = 1 - Math.exp(-dt * damp);
    this.camDir.lerp(wantDir, kk).normalize();
    this.zoomK += (wantZoom - this.zoomK) * kk;
    if (this.look) this.look.lerp(this.lookWant, kk);
    this._applyCam();
    this.camGlide = this.camDir.angleTo(wantDir) > 0.004 || Math.abs(this.zoomK - wantZoom) > 0.004;
    // Owambe pot label: keep the chip fully on stage. The pot sits at the
    // board centre; when framing ever pushed it toward an edge the label
    // followed it out and clipped ("ambe Pot NO"). Project the
    // home anchor; when the label would cross a stage edge, slide it back
    // inside with a 6px margin, moving along the camera plane so its depth
    // and size hold. The pot amount is a headline number: it stays readable.
    if (this.potLabel && this.potLabelHome) {
      const cam = this.camera;
      cam.updateMatrixWorld(true);
      const home = this.potLabelHome;
      const v = home.clone().project(cam);
      const hostEl = this.host();
      const cw = hostEl ? hostEl.clientWidth : 0, ch = hostEl ? hostEl.clientHeight : 0;
      let placed = false;
      if (cw > 0 && ch > 0 && v.z < 1) {
        // Orthographic frustum: the visible world size is the frustum
        // itself, at every depth.
        const visW = cam.right - cam.left, visH = cam.top - cam.bottom;
        const limX = Math.max(0, 1 - this.potLabel.scale.x / visW - 12 / cw);
        const limY = Math.max(0, 1 - this.potLabel.scale.y / visH - 12 / ch);
        const dx = Math.min(limX, Math.max(-limX, v.x)) - v.x;
        const dy = Math.min(limY, Math.max(-limY, v.y)) - v.y;
        if (dx || dy) {
          const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
          const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
          this.potLabel.position.copy(home).addScaledVector(right, dx * visW * 0.5).addScaledVector(up, dy * visH * 0.5);
          placed = true;
        }
      }
      if (!placed) this.potLabel.position.copy(home);
    }
  }
  isBusy() {
    if (this.diceAnim || this.cardAnim) return true;
    if (this.deedAnim && this.deedAnim.mode !== 'hover') return true;
    if (this.countdownZoom > 0) return true;
    if (this.pulseT < 1) return true;
    if (this.camGlide) return true;
    for (const o of this.tokens.values()) if (o.anim) return true;
    return false;
  }
}
function trayCardTexture(colorHex) {
  const c = cnv(184, 260), x = c.getContext('2d');
  x.fillStyle = '#fdf6df'; x.fillRect(0, 0, 184, 260);
  x.fillStyle = GOLD; x.fillRect(0, 0, 184, 62);
  x.fillStyle = INK; x.textAlign = 'center'; x.font = '900 25px "Aeonik Pro", sans-serif';
  x.fillText('GET OUT OF', 92, 40);
  x.font = '900 27px "Aeonik Pro", sans-serif'; x.fillText('KIRIKIRI', 92, 108);
  x.fillStyle = '#b02e2e'; x.font = '900 44px "Aeonik Pro", sans-serif'; x.fillText('FREE', 92, 158);
  x.fillStyle = '#5c4c3d'; x.font = '700 16px "Figtree", sans-serif';
  x.fillText('Your uncle na', 92, 192); x.fillText('senior officer', 92, 214);
  x.fillStyle = colorHex; x.fillRect(0, 232, 184, 28);
  return texOf(c);
}

// ---------------------------------------------------------------------------
// Scaled money theatre: a rare full-screen takeover for the biggest moments
// ---------------------------------------------------------------------------
let bigMomentUntil = 0;
function bigMoment(kicker, name, amount, line) {
  const now = performance.now();
  if (now < bigMomentUntil) return;
  bigMomentUntil = now + 4200;
  let el = $('bigMoment');
  if (!el) { el = document.createElement('div'); el.id = 'bigMoment'; document.body.appendChild(el); }
  el.innerHTML = '<div class="bm-kicker">' + kicker + '</div>' +
    (amount != null ? '<div class="bm-amt">' + D.fmtN(amount) + '</div>' : '<div class="bm-amt" style="font-size:clamp(30px,7vw,52px);">' + name + '</div>') +
    '<div class="bm-line">' + (amount != null ? '<b>' + name + '</b>: ' : '') + line + '</div>';
  el.classList.add('show');
  for (let k = 0; k < 12; k++) {
    const n = document.createElement('div');
    n.className = 'spray-note';
    n.textContent = ['₦50,000', '₦20,000', '₦10,000', '₦5,000'][k % 4];
    n.style.left = (8 + Math.random() * 82) + 'vw';
    n.style.top = (5 + Math.random() * 12) + 'vh';
    n.style.animationDelay = (Math.random() * 0.45) + 's';
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 2300);
  }
  setTimeout(() => el.classList.remove('show'), 1950);
}

// ---------------------------------------------------------------------------
// LANDING: no GL scene (KP15). The hero is a DOM/SVG street in index.html
// now (see .hero-scene in style.css): a layered panorama with a 12 second
// story loop around the slogan. The old WebGL landing street is gone for
// two reasons proven from the code that used to live here:
//  1. Its danfo took its x from absolute time while the render loop only
//     draws ambient scenes in bursts (TIER.ambientOn, then a rest), so
//     the bus froze every rest and teleported forward on resume: the
//     flicker the owner saw whenever the bus crossed.
//  2. The Auto FPS stepper counted only drawn frames over wall-clock
//     windows, so the duty cycle read as ~20fps forever and kept
//     stepping the pixel ratio down, reallocating the fullscreen
//     canvas backing store mid-session: a full-screen flash per step.
// setScene treats the landing as a no-GL view and keeps the canvas
// hidden until the lobby or the game claims it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LOBBY SCENE: players gather around the plaza
// ---------------------------------------------------------------------------
class LobbyScene {
  constructor() {
    const s = this.scene = new THREE.Scene();
    s.background = new THREE.Color(0x2a1a0e);
    s.fog = new THREE.Fog(0x2a1a0e, 24, 44);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);
    this.camPos = new THREE.Vector3(0, 5.6, 9.2);
    this.camera.position.copy(this.camPos);
    s.add(new THREE.HemisphereLight(0xfff2d8, 0x5a4028, 0.85));
    const key = new THREE.DirectionalLight(0xffd9a0, 1.5); key.position.set(6, 11, 7); key.castShadow = TIER.shadowSize > 0;
    key.shadow.mapSize.set(TIER.shadowSize || 1024, TIER.shadowSize || 1024); key.shadow.camera.left = -8; key.shadow.camera.right = 8; key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
    s.add(key);
    this.keyLight = key;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(24, 36), std(0x1d1208, 1));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.32; ground.receiveShadow = true; s.add(ground);
    const plazaTexC = cnv(512, 512), px = plazaTexC.getContext('2d');
    px.fillStyle = '#f3e3bc'; px.fillRect(0, 0, 512, 512);
    px.strokeStyle = 'rgba(160,116,32,0.7)'; px.lineWidth = 6;
    px.beginPath(); px.arc(256, 256, 236, 0, Math.PI * 2); px.stroke();
    px.beginPath(); px.arc(256, 256, 150, 0, Math.PI * 2); px.stroke();
    px.fillStyle = INK; px.textAlign = 'center'; px.font = '900 64px "Aeonik Pro", sans-serif';
    px.fillText('KOLOPOLY', 256, 240);
    px.fillStyle = '#8a6d1d'; px.font = '700 26px "Figtree", sans-serif';
    px.fillText('THE TABLE DEY WAIT', 256, 282);
    const plaza = cyl(5.3, 5.5, 0.3, std(0x6b4a2c, 0.8), 0, -0.15, 0, 40);
    const plazaTop = new THREE.Mesh(new THREE.CircleGeometry(5.3, 40), new THREE.MeshStandardMaterial({ map: texOf(plazaTexC), roughness: 0.9 }));
    plazaTop.rotation.x = -Math.PI / 2; plazaTop.position.y = 0.005; plazaTop.receiveShadow = true;
    s.add(plaza); s.add(plazaTop);
    // centre plinth with a mini pot
    s.add(bx(1.1, 0.5, 1.1, std(0x8a5a33, 0.8), 0, 0.25, 0));
    const potPts = [];
    [[0.03, 0], [0.26, 0.01], [0.38, 0.09], [0.42, 0.24], [0.39, 0.32]].forEach((p) => potPts.push(new THREE.Vector2(p[0], p[1])));
    const pot = new THREE.Mesh(new THREE.LatheGeometry(potPts, 18), new THREE.MeshStandardMaterial({ color: 0x9a6a24, roughness: 0.38, metalness: 0.5, side: THREE.DoubleSide }));
    pot.position.y = 0.5; pot.castShadow = true; s.add(pot);
    this.slotsGroup = new THREE.Group(); s.add(this.slotsGroup);
    this.sig = '';
    this.countdown = false;
  }
  host() { return $('lobbyStage'); }
  isBusy() { return this.countdown; }
  slotPos(k) { const a = (k / 6) * Math.PI * 2 + Math.PI / 2 - 0.55; return new THREE.Vector3(Math.cos(a) * 3.55, 0, Math.sin(a) * 3.55); }
  sync(state) {
    if (!state || !state.players) return;
    this.countdown = state.status === 'countdown';
    const sig = state.players.map((p) => p.id + ':' + p.token + ':' + p.name + ':' + p.connected + ':' + p.isHost).join(';') + '|' + state.players.length;
    if (sig === this.sig) return;
    this.sig = sig;
    this.slotsGroup.clear();
    for (let k = 0; k < 6; k++) {
      const p = state.players[k];
      const pos = this.slotPos(k);
      if (!p) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.44, 26), new THREE.MeshBasicMaterial({ color: 0xffe1a8, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2; ring.position.set(pos.x, 0.02, pos.z);
        ring.userData.ghost = true;
        this.slotsGroup.add(ring);
        continue;
      }
      const tok = makeToken(p.token, p.color, 1.3);
      tok.position.copy(pos);
      tok.position.y = 0.01;
      tok.lookAt(0, 0, 0);
      tok.rotateY(Math.PI);
      if (!p.connected) tok.scale.setScalar(0.92);
      const label = nameSprite(p.name + (p.isHost ? ' · HOST' : '') + (p.connected ? '' : ' · AWAY'), p.color);
      label.position.set(pos.x, 1.55, pos.z);
      if (!p.connected) label.material.opacity = 0.5;
      this.slotsGroup.add(tok); this.slotsGroup.add(label);
      tok.userData.bob = k * 1.3;
      this.slotsGroup.userData['tok' + k] = tok;
    }
  }
  update(dt, t) {
    for (const ch of this.slotsGroup.children) {
      if (ch.userData.ghost) ch.material.opacity = 0.22 + Math.sin(t * 2.2) * 0.13;
      if (ch.userData.bob != null && ch.userData.inner) ch.userData.inner.position.y = 0.045 + Math.sin(t * 1.8 + ch.userData.bob) * 0.02;
    }
    const want = this.countdown ? new THREE.Vector3(0, 3.2, 4.4) : new THREE.Vector3(0, 5.6, 9.2);
    this.camPos.lerp(want, 1 - Math.exp(-dt * 1.6));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(0, 0.55, 0);
  }
}

// ---------------------------------------------------------------------------
// END SCENE: podium and notes spray behind the final table
// ---------------------------------------------------------------------------
class EndScene {
  constructor() {
    const s = this.scene = new THREE.Scene();
    s.background = new THREE.Color(0x241407);
    s.fog = new THREE.Fog(0x241407, 16, 34);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    s.add(new THREE.HemisphereLight(0xffe9c9, 0x4a3018, 0.7));
    const spot = new THREE.SpotLight(0xffc857, 60, 30, 0.6, 0.5);
    spot.position.set(0, 9, 3); spot.target.position.set(0, 0.8, 0); s.add(spot); s.add(spot.target);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(20, 32), std(0x180d05, 1));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; s.add(ground);
    const steps = [
      [1.7, 0.95, 0xffc857], [1.35, 0.58, 0xb9c2cc], [1.1, 0.34, 0xc98a4a]
    ];
    this.stepTops = [];
    steps.forEach(([w, h, col], k) => {
      const st = bx(w, h, w, new THREE.MeshStandardMaterial({ color: col, roughness: 0.35, metalness: 0.55 }), (k - 1) * 1.55, h / 2, k === 0 ? -0.3 : 0.35);
      s.add(st); this.stepTops.push(h);
    });
    this.podiumGroup = new THREE.Group(); s.add(this.podiumGroup);
    // falling notes
    this.notes = [];
    const noteMat = new THREE.MeshBasicMaterial({ map: noteTexture(), side: THREE.DoubleSide, transparent: true, opacity: 0.92 });
    const noteGeo = new THREE.PlaneGeometry(0.55, 0.28);
    for (let k = 0; k < 42; k++) {
      const n = new THREE.Mesh(noteGeo, noteMat);
      n.userData = { x: (Math.random() - 0.5) * 9, y: Math.random() * 6, z: (Math.random() - 0.5) * 6 - 1, sp: 0.5 + Math.random() * 0.8, ph: Math.random() * 6.28 };
      n.position.set(n.userData.x, n.userData.y, n.userData.z);
      this.notes.push(n); s.add(n);
    }
    this.sig = '';
  }
  host() { return $('endOverlay'); }
  sync(state) {
    if (!state || !state.endTable || !state.endTable.length) return;
    const sig = state.endTable.map((r) => r.name).join(';') + '|' + (state.winner ? state.winner.playerId : '');
    if (sig === this.sig) return;
    this.sig = sig;
    this.podiumGroup.clear();
    const order = [0, 1, 2];
    const placePos = [[0, this.stepTops[0], -0.3], [-1.55, this.stepTops[1], 0.35], [1.55, this.stepTops[2], 0.35]];
    state.endTable.slice(0, 3).forEach((row, rank) => {
      const p = state.players.find((pl) => pl.name === row.name);
      if (!p) return;
      const slot = placePos[order[rank]];
      const tok = makeToken(p.token, p.color, rank === 0 ? 1.65 : 1.25);
      tok.position.set(slot[0], slot[1], slot[2]);
      tok.rotation.y = rank === 0 ? 0 : (rank === 1 ? 0.5 : -0.5);
      this.podiumGroup.add(tok);
      const label = nameSprite((rank + 1) + ' · ' + row.name, p.color);
      label.position.set(slot[0], slot[1] + (rank === 0 ? 2.2 : 1.8), slot[2]);
      this.podiumGroup.add(label);
    });
  }
  update(dt, t) {
    for (const n of this.notes) {
      n.userData.y -= dt * n.userData.sp;
      n.userData.ph += dt * 2.4;
      if (n.userData.y < 0.05) n.userData.y = 5.5 + Math.random();
      n.position.y = n.userData.y;
      n.position.x = n.userData.x + Math.sin(n.userData.ph) * 0.3;
      n.rotation.set(n.userData.ph, n.userData.ph * 0.7, 0);
    }
    const a = t * 0.16;
    this.camera.position.set(Math.sin(a) * 7.6, 3.3 + Math.sin(t * 0.3) * 0.3, Math.cos(a) * 7.6);
    this.camera.lookAt(0, 1.0, 0);
  }
}

// ---------------------------------------------------------------------------
// Scene manager: one renderer, canvas reparented per scene
// ---------------------------------------------------------------------------
let renderer = null;
const SCENES = {};
let activeName = '';
let raycaster = null;
let lastFitW = 0, lastFitH = 0, lastFitAt = 0;

function currentView() {
  if ($('endOverlay') && $('endOverlay').classList.contains('show')) return 'end';
  if ($('view-game') && $('view-game').classList.contains('active')) return 'game';
  if ($('view-lobby') && $('view-lobby').classList.contains('active')) return 'lobby';
  return 'landing';
}
function setScene(name) {
  activeName = name;
  // KP15: a pending Auto step lands HERE, at a scene entry (game turn
  // boundaries flush it too, see GameScene.sync), never mid-motion:
  // resizing the drawing buffer on a live scene clears it for a frame,
  // which read as a full-screen flash when the stepper fired mid-game.
  flushPendingAutoPr();
  const cv = renderer.domElement;
  if (name === 'landing') {
    // KP15: the landing hero is a DOM/SVG street now; the GL canvas has
    // no stage here and stays hidden until the lobby or the game.
    cv.style.display = 'none';
    return;
  }
  cv.style.display = '';
  const sc = SCENES[name];
  if (!sc) return;
  const host = sc.host();
  if (host && cv.parentElement !== host) host.appendChild(cv);
  cv.id = ''; cv.className = 'gl-canvas';
  lastFitW = 0; lastFitH = 0;
  fitCanvas(true);
}
function fitCanvas(force) {
  if (!renderer || !activeName) return;
  if (activeName === 'landing') return; // KP15: no GL stage on the landing
  const host = renderer.domElement.parentElement;
  if (!host) return;
  let w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  // KP11: the game board's layout is built from this box's own aspect;
  // reflow it whenever the fitted size says the aspect class changed
  // (first activation, rotation, a rail that grows or shrinks).
  if (activeName === 'game' && SCENES.game) SCENES.game.maybeRelayout(h / w);
  if (!force && w === lastFitW && h === lastFitH) return;
  lastFitW = w; lastFitH = h;
  renderer.setSize(w, h, false);
  const sc = SCENES[activeName];
  if (sc) { sc.camera.aspect = w / h; sc.camera.updateProjectionMatrix(); }
}
let lastTs = 0, pendingDt = 0, lastRenderTs = 0;
let motionUntil = 0, ambientOnUntil = 0, ambientOffUntil = 0;
function motion(seconds) { motionUntil = Math.max(motionUntil, performance.now() + seconds * 1000); }
// While a sheet or overlay covers the game board the player is reading, not
// watching: motion-window draws are skipped (running animations still draw).
const SHEET_IDS = ['deedScrim', 'listScrim', 'cardScrim', 'choiceScrim', 'proposalScrim', 'shareOverlay', 'phaseOverlay', 'countOverlay', 'pauseOverlay'];
function sheetCovering() {
  for (const id of SHEET_IDS) { const el = document.getElementById(id); if (el && el.classList.contains('show')) return true; }
  return false;
}
// Frame accounting for the probe: fps is the draw rate inside active windows
// (rendering is on demand, so an idle scene correctly reports no new frames).
let statFrames = 0, statFps = 0, statWinStart = 0, statWinFrames = 0, prevDrawTs = 0;
function noteFrame(ts) {
  if (prevDrawTs && ts - prevDrawTs > 250) { statWinStart = ts; statWinFrames = 0; }
  if (!statWinStart) statWinStart = ts;
  prevDrawTs = ts; statFrames += 1; statWinFrames += 1;
  if (ts - statWinStart >= 1000) { statFps = Math.round(statWinFrames * 1000 / Math.max(1, ts - statWinStart)); statWinFrames = 0; statWinStart = ts; }
}
// Auto FPS stepper (KP13, memory added in KP14): the only runtime
// adaptation, and Auto only. It watches busy windows (frames actually
// drawn, counted in the loop) in ~2s slices: two consecutive slow
// windows (under 24fps against the ~30fps draw cap) step the pixel
// ratio down the ladder, three consecutive fast ones (29fps+) step it
// back up, but never past the session's start cap (the profile cap,
// or the learned ceiling where one exists). Floor: 1.5 on devices
// whose DPR is 2+, else 1. It never touches texture resolution, and it
// rests for 6s after boot, a scene switch or a tier change.
// Memory: three consecutive non-slow windows prove the current level.
// If the session stepped down to reach it, that level is learned
// (retry counter reset). If the session started at a retry above the
// learned ceiling and holds its start cap, the higher cap is learned.
// If it started exactly at the learned ceiling, the stable-session
// counter grows toward the next retry.
// KP15 gating: autoAdapt calls applyAutoPr() exactly as before, but all
// it does now is raise the pending flag: the logical cap (and everything
// the learning below derives from it) updates at decision time, while
// the renderer resize lands only at a gated moment. On the old WebGL
// landing this same resize was the fullscreen flash; in the game it
// could clear the board for a frame mid-hop. A deliberate manual tier
// pick still applies immediately (visible feedback for a user action)
// and clears any pending step.
function applyAutoPr() { pendingAutoPr = true; }
function flushPendingAutoPr() {
  if (!pendingAutoPr || !renderer) return;
  pendingAutoPr = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, autoPrCap));
  lastFitW = 0; lastFitH = 0; fitCanvas(true);
}
function autoAdapt(ts) {
  if (!TIER.auto || !renderer) return;
  if (!autoWinStart) { autoWinStart = ts; autoWinFrames = 0; return; }
  if (ts - autoWinStart < 2000) return;
  const fps = autoWinFrames * 1000 / Math.max(1, ts - autoWinStart);
  autoWinStart = ts; autoWinFrames = 0;
  if (ts < autoGraceUntil) { autoSlowWins = 0; autoFastWins = 0; autoStableWins = 0; return; }
  const dpr = window.devicePixelRatio || 1;
  const floor = dpr >= 2 ? 1.5 : 1;
  if (fps >= 24) autoStableWins += 1; else autoStableWins = 0;
  if (autoStableWins >= 3 && !learnSessionCounted) {
    learnSessionCounted = true;
    if (autoPrCap < autoStartCap - 0.001) saveLearn(autoPrCap, 0);
    else if (learned && autoStartCap > learned.cap + 0.001) saveLearn(autoStartCap, 1);
    else if (learned && Math.abs(autoStartCap - learned.cap) < 0.001) saveLearn(learned.cap, (learned.ok || 0) + 1);
  }
  if (fps < 24) {
    autoFastWins = 0; autoSlowWins += 1;
    if (autoSlowWins >= 2) {
      autoSlowWins = 0;
      const downs = PROFILE_LADDER.filter((v) => v < autoPrCap - 0.001 && v >= floor);
      if (downs.length) { autoPrCap = Math.max(...downs); autoStableWins = 0; applyAutoPr(); }
    }
  } else if (fps >= 29) {
    autoSlowWins = 0; autoFastWins += 1;
    if (autoFastWins >= 3) {
      autoFastWins = 0;
      const ups = PROFILE_LADDER.filter((v) => v > autoPrCap + 0.001 && v <= autoStartCap);
      if (ups.length) { autoPrCap = Math.min(...ups); applyAutoPr(); }
    }
  } else { autoSlowWins = 0; autoFastWins = 0; }
}
KP3D.motion = motion;
// Render on demand: frames are drawn only inside animation windows (a token
// hop, a dice tumble, a card flight, a camera glide, a fresh state push) or
// in the ambient scenes' breathing pattern (1.5s moving, 0.75s resting).
// A still board costs zero GPU, which is the right shape for phones, and a
// resting page reports network idle like any other page.
function loop(ts) {
  requestAnimationFrame(loop);
  if (!renderer) return;
  const rawDt = Math.min(0.1, lastTs ? (ts - lastTs) / 1000 : 0.016);
  lastTs = ts;
  if (document.hidden) { pendingDt = 0; return; }
  pendingDt += rawDt;
  // a board game does not need 60fps: capping at ~30 halves GPU and battery
  // cost on phones and keeps software renderers (test rigs) responsive
  if (ts - lastRenderTs < 33) return;
  const want = currentView();
  if (want !== activeName) { setScene(want); motion(2.5); autoGraceUntil = ts + 6000; }
  if (ts - lastFitAt > 600) { lastFitAt = ts; fitCanvas(false); }
  const sc = SCENES[activeName];
  if (!sc) return;
  // the end overlay innerHTML is rewritten by renderEnd; keep the canvas home
  if (activeName === 'end') {
    const host = sc.host();
    if (host && renderer.domElement.parentElement !== host) { host.appendChild(renderer.domElement); fitCanvas(true); }
  }
  const busy = !!(sc.isBusy && sc.isBusy());
  let draw = busy || ts < motionUntil;
  if (draw && !busy && activeName === 'game' && sheetCovering()) draw = false;
  if (!draw && activeName !== 'game') {
    if (ts >= ambientOffUntil) { ambientOnUntil = ts + TIER.ambientOn; ambientOffUntil = ambientOnUntil + TIER.ambientOff; }
    draw = ts < ambientOnUntil;
  }
  if (!draw) { pendingDt = Math.min(pendingDt, 0.05); return; }
  lastRenderTs = ts;
  const dt = Math.min(0.08, pendingDt);
  pendingDt = 0;
  if (sc.update) sc.update(dt, ts / 1000);
  renderer.render(sc.scene, sc.camera);
  noteFrame(ts);
  autoWinFrames += 1; autoAdapt(ts);
}

// ---------------------------------------------------------------------------
// Public API used by app.js hooks and the board patches below
// ---------------------------------------------------------------------------
KP3D.showDeedCard = function (i) { if (SCENES.game) { SCENES.game.showDeed(i); motion(1.4); } };
KP3D.hideDeedCard = function () { if (SCENES.game) { SCENES.game.hideDeed(); motion(0.8); } };
KP3D.onCardDrawn = function (card) {
  const g = SCENES.game; if (!g) return;
  if (g.cardAnim && g.cardAnim.cardId === card.id) g.cardAnim.holdMode = 'modal';
  else g.startCardAnim(card, true);
  motion(3);
};
KP3D.onCardResolved = function (card) { if (SCENES.game) { SCENES.game.resolveCard(card); motion(1.6); } };
// KP11 proof probe: project the tile ring's own slab box (the fitted
// silhouette: footprint corners at slab bottom and top) through the LIVE
// game camera and report its on-canvas pixel extent plus its span as a
// percentage of the canvas on each axis, so tests measure the rendered
// board against the owner's 100 percent law instead of guessing sizes.
KP3D.boardProbePx = function () {
  const g = SCENES.game;
  if (!g || !renderer || !renderer.domElement) return null;
  const cam = g.camera;
  cam.updateMatrixWorld(true);
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  if (!w || !h) return null;
  const L = g.layout || { TW: 12.2, TD: 12.2 };
  const xs = [], ys = [];
  for (const cx of [-L.TW / 2, L.TW / 2]) for (const cz of [-L.TD / 2, L.TD / 2]) for (const cy of [0, 0.22]) {
    const v = new THREE.Vector3(cx, cy, cz).project(cam);
    xs.push((v.x + 1) / 2 * w); ys.push((1 - v.y) / 2 * h);
  }
  const rimWidthPx = Math.max(...xs) - Math.min(...xs);
  const rimHeightPx = Math.max(...ys) - Math.min(...ys);
  return {
    rimWidthPx: Math.round(rimWidthPx),
    rimHeightPx: Math.round(rimHeightPx),
    rimWPct: Math.round(rimWidthPx / w * 1000) / 10,
    rimHPct: Math.round(rimHeightPx / h * 1000) / 10,
    canvasW: w, canvasH: h
  };
};
// Follow is ~2.2x on the token. Full is the fitted board. The glide
// starts the frame the call lands, including while a token is mid hop.
KP3D.setView = function (mode) {
  const g = SCENES.game;
  if (!g) { KP3D._pendingView = mode; return; }
  g.viewFollow = mode === 'follow';
  g.viewKick = 0.45;
  motion(0.6);
};
KP3D.getView = function () {
  const g = SCENES.game;
  return g && g.viewFollow ? 'follow' : 'full';
};
KP3D.camZoom = function () {
  const g = SCENES.game;
  return g ? g.zoomK : null;
};
KP3D.wordmark = function () { return wordmarkProbe; };

// ---------------------------------------------------------------------------
// Board patches: feed the 3D sync from the same render the DOM uses, and
// stop the DOM camera from transforming the invisible click grid in gl mode
// ---------------------------------------------------------------------------
function patchBoard() {
  const origRender = B.render.bind(B);
  B.render = function (state) {
    origRender(state);
    if (!KP3D.active) return;
    if (SCENES.game) SCENES.game.sync(state);
    if (SCENES.lobby) SCENES.lobby.sync(state);
    if (SCENES.end) SCENES.end.sync(state);
    motion(1.8);
  };
  const origCam = B.applyCamera.bind(B);
  B.applyCamera = function (state) {
    if (KP3D.active) return;
    origCam(state);
  };
  // the lobby renders through its own app function, not KPBoard.render
  if (typeof window.renderLobby === 'function') {
    const origLobby = window.renderLobby;
    window.renderLobby = function (room) {
      origLobby(room);
      if (!KP3D.active) return;
      if (SCENES.lobby) SCENES.lobby.sync(room);
      motion(1.5);
    };
  }
  // catch up with whatever state is already on screen
  if (typeof window.__kolopolyState === 'function') {
    const st = window.__kolopolyState();
    if (st) {
      if (SCENES.game) SCENES.game.sync(st);
      if (SCENES.lobby) SCENES.lobby.sync(st);
      if (SCENES.end) SCENES.end.sync(st);
    }
  }
}

// ---------------------------------------------------------------------------
// Tier control: manual override and live re-tuning (pixel ratio and shadows
// apply at once; texture sizes stay as drawn until the next page load)
// ---------------------------------------------------------------------------
function retuneShadowLight(l) {
  if (!l || !l.shadow) return;
  l.castShadow = TIER.shadowSize > 0;
  if (TIER.shadowSize > 0 && l.shadow.mapSize.x !== TIER.shadowSize) {
    l.shadow.mapSize.set(TIER.shadowSize, TIER.shadowSize);
    if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
  }
}
function applyTierToRenderer() {
  if (!renderer) return;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, prCap()));
  renderer.shadowMap.enabled = TIER.shadowSize > 0;
  for (const n in SCENES) retuneShadowLight(SCENES[n] && SCENES[n].keyLight);
  lastFitW = 0; lastFitH = 0; fitCanvas(true); motion(1.2);
}
KP3D.setTier = function (name) {
  if (name === 'auto') { try { localStorage.removeItem('kolopolyTier'); } catch (e) {} applyTier('auto', true); }
  else if (PROFILE_PARAMS[name]) { try { localStorage.setItem('kolopolyTier', name); } catch (e) {} applyTier(name, false); }
  applyTierToRenderer();
  return TIER.name;
};

// ---------------------------------------------------------------------------
// Init: WebGL or silent fallback to the 2D board
// ---------------------------------------------------------------------------
function initGL() {
  let gl = null;
  try {
    const probe = document.createElement('canvas');
    gl = probe.getContext('webgl2') || probe.getContext('webgl');
  } catch (e) { gl = null; }
  if (!gl) return;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (e) { renderer = null; return; }
  try {
    const dbgExt = renderer.getContext().getExtension('WEBGL_debug_renderer_info');
    if (dbgExt) glRendererName = String(renderer.getContext().getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) || '');
  } catch (e) { /* a masked renderer string is fine, the other signals carry the pick */ }
  // the probe is complete only now that the GL renderer string is
  // known: re-resolve the Auto profile with it before any scene is
  // built, so shadow and texture budgets come from the full evidence
  lastProbe = collectSignals();
  if (!tierOverride()) applyTier('auto', true);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, prCap()));
  renderer.shadowMap.enabled = TIER.shadowSize > 0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    KP3D.active = false;
    document.body.classList.remove('gl-on');
    if (renderer) { renderer.dispose(); renderer = null; }
  });
  raycaster = new THREE.Raycaster();
  // 'click', not 'pointerdown': the deed sheet this tap opens covers the
  // screen before the same gesture's click arrives, and the scrim's own
  // tap-outside-to-dismiss would close the sheet the tap just opened.
  renderer.domElement.addEventListener('click', (e) => {
    if (activeName !== 'game' || !SCENES.game) return;
    const r = renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    SCENES.game.onTap(raycaster, ndc, SCENES.game.camera);
    motion(3);
  });
  try {
    SCENES.game = new GameScene();
    SCENES.lobby = new LobbyScene();
    SCENES.end = new EndScene();
  } catch (e) {
    renderer = null;
    return;
  }
  KP3D.active = true;
  document.body.classList.add('gl-on');
  KP3D.debug = function () {
    const g = SCENES.game;
    if (!g) return { active: true, scene: activeName, tier: TIER.name, tierAuto: TIER.auto };
    // KP11 proof: the frame assembly (table, platform, rim) is gone from
    // the scene graph. Any mesh ever flagged as a frame part is counted;
    // the count is structurally zero because the parts are never built.
    let frameMeshes = 0;
    g.scene.traverse((o) => { if (o.userData && o.userData.framePart) frameMeshes += 1; });
    const tileMap = g.tiles && g.tiles[1] && g.tiles[1].topMat ? g.tiles[1].topMat.map : null;
    const centreMap = g.floorMesh && g.floorMesh.material ? g.floorMesh.material.map : null;
    return {
      active: true, scene: activeName,
      frameMeshes,
      layout: g.layout ? { tw: Math.round(g.layout.TW * 100) / 100, td: Math.round(g.layout.TD * 100) / 100 } : null,
      tier: TIER.name, tierAuto: TIER.auto, glRenderer: glRendererName,
      dpr: renderer ? renderer.getPixelRatio() : 0, shadowSize: TIER.shadowSize, texScale: TIER.texScale,
      // KP13 sharpness probe: what the screen actually gets. Canvas
      // backing store vs CSS size, the drawn size of a street tile
      // texture and of the centre field, anisotropy in force, mipmap
      // state, and the Auto stepper's current pixel ratio cap.
      pixelRatio: renderer ? renderer.getPixelRatio() : 0,
      canvasBacking: renderer && renderer.domElement ? { w: renderer.domElement.width, h: renderer.domElement.height } : null,
      tileTex: tileMap && tileMap.image ? { w: tileMap.image.width, h: tileMap.image.height } : null,
      centreTex: centreMap && centreMap.image ? { w: centreMap.image.width, h: centreMap.image.height } : null,
      aniso: { max: maxAniso(), tile: tileMap ? tileMap.anisotropy : 0, centre: centreMap ? centreMap.anisotropy : 0 },
      mipmaps: tileMap ? { generate: tileMap.generateMipmaps, minFilter: tileMap.minFilter } : null,
      autoPrCap,
      autoPending: pendingAutoPr,
      // KP14 Best View probe: the resolved profile, the session start
      // cap, the learned ceiling on file, and the raw signals the
      // profile was decided from
      profile: TIER.profile, startCap: autoStartCap,
      learned: learned ? { cap: learned.cap, ok: learned.ok || 0 } : null,
      probe: lastProbe,
      frames: statFrames, fps: statFps,
      deedVisible: g.deedCard.visible,
      deedY: Math.round(g.deedCard.position.y * 100) / 100,
      deedAnim: g.deedAnim ? g.deedAnim.mode : null,
      cardAnim: g.cardAnim ? g.cardAnim.phase : null,
      tokens: g.tokens.size,
      lobbySlots: SCENES.lobby ? SCENES.lobby.slotsGroup.children.length : -1,
      lobbySig: SCENES.lobby ? SCENES.lobby.sig : ''
    };
  };
  patchBoard();
  // hide the 3D deed card when its sheet closes
  const scrim = $('deedScrim');
  if (scrim) {
    new MutationObserver(() => { if (!scrim.classList.contains('show')) KP3D.hideDeedCard(); })
      .observe(scrim, { attributes: true, attributeFilter: ['class'] });
  }
  window.addEventListener('resize', () => { fitCanvas(true); motion(1.2); });
  window.addEventListener('orientationchange', () => setTimeout(() => { fitCanvas(true); motion(1.2); }, 250));
  // mobile browser chrome showing or hiding mid-game changes the visible
  // height without a window resize on some phones: refit from the viewport
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { fitCanvas(false); motion(0.5); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastTs = 0; motion(0.8); } });
  // graphics quality button beside the mute button: cycles Auto,
  // Ultra, High, Balanced, Lite, and labels the detection while Auto
  // is in force ("Graphics: Auto (Ultra)"), so the player can see
  // what Best View decided for their phone
  const tierBtn = $('tierBtn');
  if (tierBtn) {
    tierBtn.classList.remove('hidden');
    const capName = (n) => n.charAt(0).toUpperCase() + n.slice(1);
    const tierLabel = () => (TIER.auto ? 'Auto (' + capName(TIER.profile) + ')' : capName(TIER.name));
    const paintTierBtn = () => {
      tierBtn.innerHTML = window.icon ? window.icon('spark', 20) : 'Q';
      tierBtn.title = 'Graphics: ' + tierLabel();
      tierBtn.setAttribute('aria-label', 'Graphics quality: ' + tierLabel() + '. Tap to change.');
    };
    paintTierBtn();
    tierBtn.addEventListener('click', () => {
      const order = ['auto', 'ultra', 'high', 'balanced', 'lite'];
      const cur = TIER.auto ? 'auto' : TIER.name;
      KP3D.setTier(order[(order.indexOf(cur) + 1) % order.length]);
      paintTierBtn();
      if (typeof window.toast === 'function') window.toast('Graphics: ' + tierLabel(), 2600);
    });
  }
  setScene('landing');
  motion(2.2);
  requestAnimationFrame(loop);
}
Promise.race([
  (document.fonts && document.fonts.ready) || Promise.resolve(),
  new Promise((r) => setTimeout(r, 1300))
]).then(() => { try { initGL(); } catch (e) { /* 2D fallback carries on */ } });
