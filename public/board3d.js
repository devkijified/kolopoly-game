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

// ---------------------------------------------------------------------------
// Quality tiers: one adaptive profile picked at boot from the hardware, so a
// weak phone sheds pixel ratio, shadow cost and texture size before it sheds
// frames. The tier owns pixels only, never game behaviour. Parameters are
// relative to the shipped high tier (DPR cap 2, 1024px shadow maps, tile and
// centre textures drawn in a 2x space). A manual pick beats the auto pick:
// localStorage 'kolopolyTier' (high|mid|low), KP3D.setTier(), or the topbar
// spark button, which cycles Auto, High, Mid, Low. Texture sizes are baked
// when a texture is first drawn, so a mid-game tier change re-tunes pixel
// ratio and shadows at once while textures keep their drawn size.
// ---------------------------------------------------------------------------
const TIER_PARAMS = {
  high: { dprCap: 2, shadowSize: 1024, texScale: 1, aniso: 4, ambientOn: 1500, ambientOff: 750 },
  mid: { dprCap: 1.5, shadowSize: 512, texScale: 0.75, aniso: 2, ambientOn: 1200, ambientOff: 1000 },
  low: { dprCap: 1, shadowSize: 0, texScale: 0.5, aniso: 1, ambientOn: 700, ambientOff: 1600 }
};
let TIER = { name: 'high', auto: true, ...TIER_PARAMS.high };
let glRendererName = '';
function tierOverride() {
  try { const v = localStorage.getItem('kolopolyTier'); return (v === 'high' || v === 'mid' || v === 'low') ? v : null; } catch (e) { return null; }
}
function autoTierName(rendererStr) {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 0; // GB, Chromium only; 0 means unknown
  const smallScreen = Math.min(window.screen.width || 9999, window.screen.height || 9999) <= 480;
  if (rendererStr && /swiftshader|llvmpipe|software rasterizer|paravirtual/i.test(rendererStr)) return 'low';
  if (cores <= 2 || (mem > 0 && mem <= 1)) return 'low';
  if ((cores <= 4 && mem > 0 && mem <= 2) || (smallScreen && mem > 0 && mem <= 2)) return 'low';
  if (cores >= 8 && (mem === 0 || mem >= 4)) return 'high';
  if (cores >= 6 && mem === 0 && !smallScreen) return 'high';
  return 'mid';
}
function applyTier(name, auto) {
  TIER = { name, auto: !!auto, ...(TIER_PARAMS[name] || TIER_PARAMS.high) };
  KP3D.tier = TIER.name;
  KP3D.tierAuto = TIER.auto;
}
applyTier(tierOverride() || autoTierName(null), !tierOverride()); // refined with the GL renderer string in initGL

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
function tileRect(i) {
  const { row, col } = gridPos(i);
  let x = 0; for (let c = 1; c < col; c++) x += COLW[c - 1];
  let z = 0; for (let r = 1; r < row; r++) z += COLW[r - 1];
  return { x: x - TOTALW / 2, z: z - TOTALW / 2, w: COLW[col - 1], d: COLW[row - 1] };
}
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
function texOf(c) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.min(TIER.aniso, maxAniso()); return t; }
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
const INK = '#2b2018', CREAM = '#fdf6df', GOLD = '#e8a90c';

// ---------------------------------------------------------------------------
// Emblem painters: tiny original scenes, drawn in a box centred (cx, cy)
// ---------------------------------------------------------------------------
function emblem(x, id, cx, cy, s, accent) {
  const u = s / 100; // unit
  x.save(); x.translate(cx, cy); x.lineWidth = 3.4 * u; x.lineJoin = 'round'; x.lineCap = 'round';
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
      rr(x, -22 * u, -32 * u, 44 * u, 62 * u, 4 * u); x.fillStyle = '#fffdf4'; x.fill(); x.strokeStyle = INK; x.lineWidth = 3 * u; x.stroke();
      x.fillStyle = '#b02e2e'; x.font = '900 ' + 21 * u + 'px "Aeonik Pro", sans-serif'; x.textAlign = 'center'; x.fillText('₦', 0, -8 * u);
      x.fillStyle = '#9a8a76'; for (let k = 0; k < 3; k++) x.fillRect(-14 * u, (4 + k * 9) * u, 28 * u, 3.4 * u); break;
    }
    case 'cards': {
      x.save(); x.rotate(-0.22); rr(x, -30 * u, -24 * u, 42 * u, 56 * u, 5 * u); x.fillStyle = '#fffdf4'; x.fill(); x.strokeStyle = INK; x.lineWidth = 3 * u; x.stroke(); x.restore();
      x.save(); x.rotate(0.2); rr(x, -12 * u, -26 * u, 42 * u, 56 * u, 5 * u); x.fillStyle = accent || '#d64545'; x.fill(); x.strokeStyle = INK; x.stroke();
      x.fillStyle = '#fff'; x.font = '900 ' + 30 * u + 'px "Aeonik Pro", sans-serif'; x.textAlign = 'center'; x.fillText('?', 9 * u, 12 * u); x.restore(); break;
    }
    case 'bars': {
      x.fillStyle = '#6b6f76'; for (let k = 0; k < 5; k++) x.fillRect((-30 + k * 15) * u, -32 * u, 6 * u, 64 * u);
      box(-38, -36, 76, 7, '#4a4d52'); box(-38, 29, 76, 7, '#4a4d52');
      circ(24, 0, 8, GOLD); box(21, -2, 6, 14, GOLD); break;
    }
    case 'party': {
      x.beginPath(); x.moveTo(-38 * u, -8 * u); x.quadraticCurveTo(0, -34 * u, 38 * u, -8 * u); x.closePath();
      x.fillStyle = '#d94f9e'; x.fill(); x.strokeStyle = '#fff'; x.lineWidth = 3 * u;
      for (let k = -2; k <= 2; k++) { x.beginPath(); x.moveTo(k * 14 * u, -20 * u + Math.abs(k) * 3 * u); x.lineTo(k * 14 * u, -6 * u); x.stroke(); }
      x.fillStyle = '#1d9e6c'; const notes = [[-24, 14], [-4, 20], [16, 12], [4, 28], [-16, 29]];
      for (const [a, b] of notes) { x.save(); x.translate(a * u, b * u); x.rotate(0.4); x.fillRect(-9 * u, -4 * u, 18 * u, 8 * u); x.restore(); } break;
    }
    case 'payday': {
      x.beginPath(); x.moveTo(-34 * u, 30 * u); x.lineTo(-34 * u, -6 * u); x.quadraticCurveTo(0, -38 * u, 34 * u, -6 * u); x.lineTo(34 * u, 30 * u); x.lineTo(22 * u, 30 * u); x.lineTo(22 * u, -4 * u); x.quadraticCurveTo(0, -24 * u, -22 * u, -4 * u); x.lineTo(-22 * u, 30 * u); x.closePath();
      x.fillStyle = GOLD; x.fill();
      x.fillStyle = INK; x.font = '900 ' + 30 * u + 'px "Aeonik Pro", sans-serif'; x.textAlign = 'center'; x.fillText('₦', 0, 24 * u); break;
    }
    case 'stilts': {
      line(-26, -2, -26, 30, '#7a4a22', 5); line(0, -2, 0, 32, '#7a4a22', 5); line(26, -2, 26, 30, '#7a4a22', 5);
      box(-30, -24, 60, 22, '#b9793f'); x.beginPath(); x.moveTo(-36 * u, -24 * u); x.lineTo(0, -40 * u); x.lineTo(36 * u, -24 * u); x.closePath(); x.fillStyle = '#7a1f1f'; x.fill();
      x.strokeStyle = '#3f7fbf'; x.lineWidth = 3 * u; x.beginPath(); x.moveTo(-38 * u, 34 * u); x.quadraticCurveTo(-19 * u, 28 * u, 0, 34 * u); x.quadraticCurveTo(19 * u, 40 * u, 38 * u, 34 * u); x.stroke(); break;
    }
    case 'ball': {
      circ(0, 0, 27, '#fffdf4'); x.strokeStyle = INK; x.lineWidth = 3 * u; x.beginPath(); x.arc(0, 0, 27 * u, 0, 7); x.stroke();
      x.fillStyle = INK; x.beginPath(); for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / 5; const px = Math.cos(a) * 10 * u, py = Math.sin(a) * 10 * u; k ? x.lineTo(px, py) : x.moveTo(px, py); } x.closePath(); x.fill();
      line(-24, -18, -12, -8, INK, 2.4); line(24, -18, 12, -8, INK, 2.4); line(0, 27, 0, 12, INK, 2.4); break;
    }
    case 'bread': {
      x.beginPath(); x.ellipse(0, 4 * u, 32 * u, 19 * u, 0, 0, 7); x.fillStyle = '#d99a4e'; x.fill(); x.strokeStyle = '#a86f2c'; x.lineWidth = 3 * u; x.stroke();
      x.strokeStyle = '#f3d9ae'; for (let k = -1; k <= 1; k++) { x.beginPath(); x.moveTo(k * 13 * u - 5 * u, -6 * u); x.lineTo(k * 13 * u + 3 * u, 2 * u); x.stroke(); } break;
    }
    case 'stalls': {
      box(-32, -4, 64, 30, '#a86f2c'); x.fillStyle = '#d64545';
      x.beginPath(); x.moveTo(-38 * u, -4 * u); for (let k = 0; k < 6; k++) x.arc((-32 + k * 12.8) * u, -4 * u, 6.4 * u, Math.PI, 0); x.lineTo(38 * u, 4 * u); x.lineTo(-38 * u, 4 * u); x.closePath(); x.fill();
      circ(-16, 14, 7, '#f08c28'); circ(0, 16, 7, '#d63a2f'); circ(16, 14, 7, '#2e9e5b'); line(-32, -4, -32, -22, INK, 4); line(32, -4, 32, -22, INK, 4); break;
    }
    case 'tech': {
      rr(x, -22 * u, -22 * u, 44 * u, 44 * u, 6 * u); x.fillStyle = '#274b63'; x.fill();
      x.strokeStyle = GOLD; x.lineWidth = 3 * u; for (let k = -1; k <= 1; k++) { line(k * 14, -30, k * 14, -22, GOLD, 3); line(k * 14, 22, k * 14, 30, GOLD, 3); line(-30, k * 14, -22, k * 14, GOLD, 3); line(22, k * 14, 30, k * 14, GOLD, 3); }
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
      x.strokeStyle = '#3d3d3d'; x.lineWidth = 3.4 * u; for (let k = 0; k < 4; k++) { x.beginPath(); x.moveTo(-26 * u, (-18 + k * 13) * u); x.lineTo(26 * u, (-18 + k * 13) * u); x.stroke(); }
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
function tileTexture(i, mortgaged) {
  const key = i + (mortgaged ? 'm' : '');
  if (tileTexCache[key]) return tileTexCache[key];
  const sp = D.SPACES[i];
  const corner = i % 10 === 0;
  const W = corner ? 336 : 208, H = corner ? 336 : 336;
  const [c, x] = cnvS(W, H, TIER.texScale);
  const band = bandColorFor(i, sp);
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
    x.fillStyle = '#fff'; fitFont(x, name.toUpperCase(), W - 24, 30, '900', '"Aeonik Pro", sans-serif');
    x.fillText(name.toUpperCase(), W / 2, H * 0.86);
  } else if (corner) {
    emblem(x, art, W / 2, H * 0.40, 168, band);
    x.fillStyle = band; x.fillRect(6, H * 0.70, W - 12, H * 0.24);
    x.fillStyle = lum(band) > 0.55 ? INK : '#fff';
    fitFont(x, name.toUpperCase(), W - 26, 36, '900', '"Aeonik Pro", sans-serif');
    x.fillText(name.toUpperCase(), W / 2, H * 0.865);
    if (i === 0) { x.fillStyle = INK; x.font = '700 21px "Figtree", sans-serif'; x.fillText('Collect ' + D.fmtN(D.START_PAY) + ' salary', W / 2, H * 0.66); }
    if (i === 20) { x.fillStyle = '#8a6d1d'; x.font = '700 21px "Figtree", sans-serif'; x.fillText('Land here, collect the pot', W / 2, H * 0.66); }
  } else if (sp.type === 'street') {
    x.fillStyle = band; x.fillRect(6, 6, W - 12, H * 0.25);
    x.fillStyle = 'rgba(0,0,0,0.18)'; x.fillRect(6, H * 0.25 + 3, W - 12, 4);
    x.fillStyle = lum(band) > 0.55 ? INK : '#fff';
    const words = name.split(' ');
    let lines = [name];
    if (x.measureText(name).width > 0 && fitFont(x, name.toUpperCase(), W - 20, 30, '900', '"Aeonik Pro", sans-serif') <= 17 && words.length > 1) {
      const mid = Math.ceil(words.length / 2);
      lines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
    }
    x.font = '900 ' + Math.min(30, fitFont(x, lines[0].toUpperCase(), W - 20, 30, '900', '"Aeonik Pro", sans-serif')) + 'px "Aeonik Pro", sans-serif';
    lines.forEach((ln, k) => x.fillText(ln.toUpperCase(), W / 2, H * 0.115 + k * H * 0.085));
    emblem(x, art, W / 2, H * 0.55, 104, band);
    x.fillStyle = INK; x.font = '700 25px "Aeonik Pro", sans-serif';
    x.fillText(D.fmtN(sp.price), W / 2, H * 0.945);
  } else {
    x.fillStyle = band; x.fillRect(6, 6, W - 12, H * 0.075);
    x.fillStyle = INK;
    fitFont(x, name.toUpperCase(), W - 18, 25, '900', '"Aeonik Pro", sans-serif');
    x.fillText(name.toUpperCase(), W / 2, H * 0.20);
    emblem(x, art, W / 2, H * 0.52, 112, band);
    if (sp.price) { x.font = '700 25px "Aeonik Pro", sans-serif'; x.fillText(D.fmtN(sp.price), W / 2, H * 0.945); }
    else if (sp.amount) { x.font = '700 23px "Aeonik Pro", sans-serif'; x.fillText('Pay ' + D.fmtN(sp.amount), W / 2, H * 0.945); }
  }
  if (mortgaged) {
    x.fillStyle = 'rgba(60,60,66,0.45)'; x.fillRect(0, 0, W, H);
    x.save(); x.translate(W / 2, H / 2); x.rotate(-0.5);
    x.fillStyle = 'rgba(255,255,255,0.92)'; x.font = '900 30px "Aeonik Pro", sans-serif'; x.textAlign = 'center';
    x.fillText('MORTGAGED', 0, 10); x.restore();
  }
  const t = texOf(c);
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
// Tokens: stylised low poly objects on a player colour disc
// ---------------------------------------------------------------------------
function buildDanfo(scale) {
  const g = new THREE.Group();
  const yellow = std(0xf6b73c, 0.5);
  const body = bx(0.40, 0.30, 0.62, yellow, 0, 0.27, 0); body.geometry = new THREE.BoxGeometry(0.40, 0.30, 0.62);
  g.add(body);
  g.add(bx(0.42, 0.07, 0.64, MAT.white, 0, 0.455, 0)); // roof
  const glassBand = bx(0.415, 0.11, 0.50, MAT.glass, 0, 0.33, -0.02); g.add(glassBand);
  g.add(bx(0.415, 0.045, 0.63, MAT.dark, 0, 0.20, 0)); // black stripe
  g.add(bx(0.36, 0.10, 0.03, MAT.glass, 0, 0.32, 0.315)); // windshield
  const wg = new THREE.CylinderGeometry(0.075, 0.075, 0.05, 14);
  for (const [wx, wz] of [[-0.20, 0.20], [0.20, 0.20], [-0.20, -0.20], [0.20, -0.20]]) {
    const w = new THREE.Mesh(wg, MAT.dark); w.rotation.z = Math.PI / 2; w.position.set(wx, 0.075, wz); w.castShadow = true; g.add(w);
  }
  g.scale.setScalar(scale || 1);
  return g;
}
function buildKeke(scale) {
  const g = new THREE.Group();
  const yellow = std(0xf2b234, 0.55), green = std(0x2e9e5b, 0.7);
  g.add(bx(0.34, 0.20, 0.46, yellow, 0, 0.22, 0.02));
  g.add(bx(0.36, 0.04, 0.42, green, 0, 0.47, 0.0)); // canopy
  for (const [px, pz] of [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.14], [0.16, 0.14]]) g.add(bx(0.035, 0.16, 0.035, MAT.dark, px, 0.38, pz));
  g.add(bx(0.30, 0.13, 0.03, MAT.glass, 0, 0.36, -0.20));
  const wg = new THREE.CylinderGeometry(0.07, 0.07, 0.045, 14);
  for (const [wx, wz] of [[0, -0.30], [-0.19, 0.17], [0.19, 0.17]]) {
    const w = new THREE.Mesh(wg, MAT.dark); w.rotation.z = Math.PI / 2; w.position.set(wx, 0.07, wz); w.castShadow = true; g.add(w);
  }
  g.scale.setScalar(scale || 1);
  return g;
}
function buildOkada(scale) {
  const g = new THREE.Group();
  const frame = std(0xb02e2e, 0.45, 0.3);
  const wg = new THREE.CylinderGeometry(0.115, 0.115, 0.04, 18);
  for (const wz of [-0.24, 0.24]) {
    const w = new THREE.Mesh(wg, MAT.dark); w.rotation.z = Math.PI / 2; w.position.set(0, 0.115, wz); w.castShadow = true; g.add(w);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 10), MAT.gold); hub.rotation.z = Math.PI / 2; hub.position.set(0, 0.115, wz); g.add(hub);
  }
  const tank = bx(0.13, 0.11, 0.30, frame, 0, 0.30, 0.02); tank.rotation.x = 0.1; g.add(tank);
  const bar = bx(0.30, 0.035, 0.035, MAT.dark, 0, 0.44, -0.26); g.add(bar);
  g.add(bx(0.16, 0.05, 0.14, MAT.dark, 0, 0.36, 0.16)); // seat
  const riderBody = cyl(0.075, 0.095, 0.30, std(0x274b63, 0.8), 0, 0.56, 0.10); riderBody.rotation.x = 0.25; g.add(riderBody);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 12), std(0x8a5a3b, 0.7)); head.position.set(0, 0.76, 0.03); head.castShadow = true; g.add(head);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.078, 14, 8, 0, Math.PI * 2, 0, 1.25), std(0xf6b73c, 0.7)); cap.position.set(0, 0.775, 0.03); g.add(cap);
  g.scale.setScalar(scale || 1);
  return g;
}
function buildGenerator(scale) {
  const g = new THREE.Group();
  const red = std(0xc23a2e, 0.5);
  g.add(bx(0.44, 0.32, 0.30, red, 0, 0.24, 0));
  g.add(bx(0.30, 0.20, 0.02, MAT.dark, 0, 0.24, 0.16)); // grille
  g.add(bx(0.46, 0.05, 0.32, MAT.dark, 0, 0.425, 0)); // top frame
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.018, 8, 16, Math.PI), MAT.dark);
  handle.position.set(0, 0.45, 0); handle.castShadow = true; g.add(handle);
  for (const [fx, fz] of [[-0.17, 0.11], [0.17, 0.11], [-0.17, -0.11], [0.17, -0.11]]) g.add(bx(0.07, 0.08, 0.07, MAT.dark, fx, 0.04, fz));
  g.add(bx(0.10, 0.06, 0.02, MAT.gold, -0.12, 0.30, 0.16));
  g.scale.setScalar(scale || 1);
  return g;
}
function buildBoot(scale) {
  const g = new THREE.Group();
  const orange = std(0xe86a17, 0.55);
  const sole = bx(0.20, 0.05, 0.52, MAT.dark, 0, 0.045, 0.02); g.add(sole);
  const toe = bx(0.19, 0.11, 0.30, orange, 0, 0.12, -0.08); toe.rotation.x = 0.06; g.add(toe);
  const heel = bx(0.19, 0.24, 0.20, orange, 0, 0.19, 0.15); heel.rotation.x = -0.1; g.add(heel);
  g.add(bx(0.20, 0.07, 0.10, MAT.white, 0, 0.30, 0.17)); // collar
  const stud = new THREE.CylinderGeometry(0.016, 0.02, 0.035, 8);
  for (const [sx, sz] of [[-0.06, -0.18], [0.06, -0.18], [-0.06, 0.05], [0.06, 0.05], [-0.06, 0.2], [0.06, 0.2]]) {
    const s = new THREE.Mesh(stud, MAT.white); s.position.set(sx, 0.012, sz); g.add(s);
  }
  g.scale.setScalar(scale || 1);
  return g;
}
function buildFila(scale) {
  const g = new THREE.Group();
  const c = cnv(128, 32), x = c.getContext('2d');
  x.fillStyle = '#7a4fa3'; x.fillRect(0, 0, 128, 32);
  x.fillStyle = '#e8c62a'; for (let k = 0; k < 6; k++) x.fillRect(6 + k * 21, 0, 7, 32);
  const side = new THREE.MeshStandardMaterial({ map: texOf(c), roughness: 0.85 });
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.20, 0.24, 18, 1, true), side);
  cap.position.y = 0.24; cap.castShadow = true; g.add(cap);
  const top = new THREE.Mesh(new THREE.CircleGeometry(0.17, 18), std(0x7a4fa3, 0.85));
  top.rotation.x = -Math.PI / 2; top.position.y = 0.36; g.add(top);
  const fold = bx(0.30, 0.10, 0.05, std(0x5d347e, 0.85), 0, 0.30, 0.17); fold.rotation.x = 0.5; g.add(fold);
  g.scale.setScalar(scale || 1);
  return g;
}
const TOKEN_BUILDERS = { danfo: buildDanfo, keke: buildKeke, okada: buildOkada, generator: buildGenerator, boot: buildBoot, fila: buildFila };
function makeToken(tokenId, colorHex, scale) {
  const g = new THREE.Group();
  const disc = cyl(0.235, 0.25, 0.045, std(new THREE.Color(colorHex).getHex(), 0.5), 0, 0.023, 0, 24);
  g.add(disc);
  const inner = (TOKEN_BUILDERS[tokenId] || buildDanfo)(scale || 1);
  inner.position.y = 0.045;
  g.add(inner);
  g.add(blobShadow(0.30));
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
function centreTexture() {
  const S = 1024; const [c, x] = cnvS(S, S, TIER.texScale);
  const g = x.createRadialGradient(S / 2, S / 2, 80, S / 2, S / 2, S * 0.72);
  g.addColorStop(0, '#fdf3d8'); g.addColorStop(1, '#f0dfba');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  x.strokeStyle = 'rgba(160,116,32,0.55)'; x.lineWidth = 5; x.strokeRect(26, 26, S - 52, S - 52);
  x.strokeStyle = 'rgba(160,116,32,0.25)'; x.lineWidth = 2; x.strokeRect(44, 44, S - 88, S - 88);
  const px = (wx) => (wx / 9 + 0.5) * S, pz = (wz) => (wz / 9 + 0.5) * S;
  // skyline silhouette along the north edge
  x.fillStyle = 'rgba(46,80,66,0.30)';
  const hs = [70, 120, 88, 150, 96, 132, 74, 118, 84, 140, 92];
  let bx0 = px(-4.3);
  for (const h of hs) { const w = 52 + (h % 40); x.fillRect(bx0, pz(-3.15) - h, w, h); bx0 += w + 14; }
  x.strokeStyle = 'rgba(43,32,24,0.4)'; x.lineWidth = 7;
  x.beginPath(); x.moveTo(px(-4.2), pz(-2.45)); x.quadraticCurveTo(px(0), pz(-3.6), px(4.2), pz(-2.45)); x.stroke();
  x.strokeStyle = 'rgba(63,127,191,0.5)'; x.lineWidth = 4;
  x.beginPath(); x.moveTo(px(-4.2), pz(-2.05)); x.quadraticCurveTo(px(0), pz(-1.8), px(4.2), pz(-2.05)); x.stroke();
  // wordmark
  x.textAlign = 'center';
  x.fillStyle = INK; x.font = '900 118px "Aeonik Pro", sans-serif';
  x.fillText('KOLO', px(-1.05), pz(-0.55));
  x.fillStyle = '#b57f10';
  const wHalf = x.measureText('KOLO').width;
  x.textAlign = 'left'; x.fillText('POLY', px(-1.05) + wHalf + 6, pz(-0.55));
  x.fillStyle = 'rgba(43,32,24,0.55)'; x.font = '700 30px "Figtree", sans-serif'; x.textAlign = 'center';
  x.fillText('LAGOS · ABUJA · PORT HARCOURT', px(0), pz(0.28));
  x.fillStyle = 'rgba(138,109,29,0.9)'; x.font = '900 30px "Aeonik Pro", sans-serif';
  x.fillText('OWAMBE POT', px(0), pz(3.35));
  x.fillStyle = 'rgba(43,32,24,0.5)'; x.font = '700 24px "Figtree", sans-serif';
  x.fillText('WAHALA', px(-2.95), pz(-0.28));
  x.fillText('FAMILY MEETING', px(2.95), pz(-0.28));
  return texOf(c);
}

// ---------------------------------------------------------------------------
// GAME SCENE
// ---------------------------------------------------------------------------
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
    s.fog = new THREE.Fog(0x2a1a0e, 30, 52);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
    this.camera.position.set(0, 22.1, 7.7);
    this.camPos = new THREE.Vector3(0, 22.1, 7.7);
    this.camTgt = new THREE.Vector3(0, 0, 0.5);
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
    // table
    const table = new THREE.Mesh(new THREE.CircleGeometry(26, 40), std(0x1d1208, 1));
    table.rotation.x = -Math.PI / 2; table.position.y = -0.62; table.receiveShadow = true; s.add(table);
    // platform and rim
    const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.8 });
    const platform = bx(13.7, 0.62, 13.7, wood, 0, -0.31, 0); s.add(platform);
    const rim = bx(14.15, 0.16, 14.15, std(0x1c1006, 0.7), 0, -0.55, 0); s.add(rim);
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
    this.lastDiceKey = ''; this.lastCardSeq = -1; this.lastFeedSeq = -1;
    this.bankruptSeen = new Set();
    this.focusOverride = null; this.focusUntil = 0;
    this.countdownZoom = 0;
    this.phaseLook = 0; this.phaseLookCur = { key: new THREE.Color(0xffd9a0), int: 1.55, bg: new THREE.Color(0x2a1a0e) };
  }
  host() { return $('boardWrap'); }

  buildTiles(s) {
    this.tiles = [];
    const pickMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true });
    this.pickables = [];
    for (let i = 0; i < 40; i++) {
      const sp = D.SPACES[i];
      const rect = tileRect(i);
      const th = tileRotY(i);
      const { lx, lz } = tileLocal(rect, i);
      const grp = new THREE.Group();
      grp.position.set(rect.x + rect.w / 2, 0, rect.z + rect.d / 2);
      grp.rotation.y = th;
      const slabMat = MAT.slabSide.clone();
      const slab = bx(lx - 0.05, 0.22, lz - 0.05, slabMat, 0, 0.11, 0);
      grp.add(slab);
      const topMat = new THREE.MeshStandardMaterial({ map: tileTexture(i, false), roughness: 0.82 });
      const top = new THREE.Mesh(new THREE.PlaneGeometry(lx - 0.05, lz - 0.05), topMat);
      top.rotation.x = -Math.PI / 2; top.position.y = 0.221; top.receiveShadow = true;
      grp.add(top);
      // owner frame and plaque (hidden until owned), centre edge plaque thicker
      const frame = new THREE.Group();
      const fm = std(0xffffff, 0.5);
      const fh = 0.05, fw = 0.075;
      const mkBar = (w, d, px2, pz) => { const b = bx(w, fh, d, fm, px2, 0.245, pz); frame.add(b); return b; };
      mkBar(lx - 0.02, fw, 0, -lz / 2 + fw / 2 + 0.015);
      mkBar(lx - 0.02, fw + 0.035, 0, lz / 2 - (fw + 0.035) / 2 - 0.015);
      mkBar(fw, lz - 0.02, -lx / 2 + fw / 2 + 0.015, 0);
      mkBar(fw, lz - 0.02, lx / 2 - fw / 2 - 0.015, 0);
      frame.visible = false;
      grp.add(frame);
      const bld = new THREE.Group(); grp.add(bld);
      const pledge = makeCardMesh(0.44, 0.62, cardBackTexture(null), cardBackTexture(null));
      pledge.position.set(lx * 0.22, 0.42, lz * 0.16); pledge.rotation.set(-0.5, 0.3, 0.12); pledge.visible = false;
      grp.add(pledge);
      const pick = new THREE.Mesh(new THREE.PlaneGeometry(lx, lz), pickMat);
      pick.rotation.x = -Math.PI / 2; pick.position.y = 0.30;
      pick.userData.space = i;
      grp.add(pick); this.pickables.push(pick);
      s.add(grp);
      this.tiles.push({ i, grp, topMat, slabMat, frame, frameMat: fm, bld, pledge, sig: '', bSig: -1, rect, th, lx, lz });
    }
  }

  buildCentre(s) {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshStandardMaterial({ map: centreTexture(), roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0.02; floor.receiveShadow = true; s.add(floor);
    // skyline row
    const winMats = [0x39594a, 0x51606e, 0x6e5a41].map((col, k) => new THREE.MeshStandardMaterial({ map: windowTexture('#' + col.toString(16).padStart(6, '0'), 0.4), roughness: 0.85 }));
    // Skyline kept low (tallest 0.52) and pulled inward (z -3.22, span inside
    // x +-3.95) so it stays strictly inside the centre island and never
    // crowds the top track from the full-board camera.
    const hs = [0.25, 0.43, 0.32, 0.52, 0.35, 0.47, 0.28, 0.4, 0.3, 0.48, 0.33];
    let sx = -3.3;
    hs.forEach((h, k) => {
      const w = 0.42 + (k % 3) * 0.1;
      const b = bx(w, h, 0.44, winMats[k % 3], sx + w / 2, h / 2 + 0.02, -3.22);
      sx += w + 0.16; s.add(b);
    });
    // water and bridge
    const water = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 1.0), new THREE.MeshStandardMaterial({ color: 0x3f7fbf, roughness: 0.15, metalness: 0.3 }));
    water.rotation.x = -Math.PI / 2; water.position.set(0, 0.035, -2.45); water.receiveShadow = true; s.add(water);
    const bridgeMat = std(0x333a40, 0.6, 0.3);
    // Bridge arc scaled to live inside the island: radius 1.45 (peak 1.55),
    // deck 3.4 long, piers to match. Nothing reaches the track or wordmark.
    const arc = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.05, 8, 36, Math.PI), bridgeMat);
    arc.position.set(0, 0.10, -2.45); arc.castShadow = true; s.add(arc);
    s.add(bx(3.4, 0.07, 0.55, bridgeMat, 0, 0.09, -2.45));
    for (const px2 of [-1.3, 0, 1.3]) s.add(bx(0.16, 0.5, 0.4, bridgeMat, px2, -0.1, -2.45));
    this.bridgeDanfo = buildDanfo(0.52); s.add(this.bridgeDanfo);
    // Owambe pot
    const potPts = [];
    [[0.03, 0], [0.30, 0.01], [0.44, 0.10], [0.50, 0.26], [0.47, 0.38], [0.50, 0.42]].forEach((p) => potPts.push(new THREE.Vector2(p[0], p[1])));
    const pot = new THREE.Mesh(new THREE.LatheGeometry(potPts, 22), new THREE.MeshStandardMaterial({ color: 0x9a6a24, roughness: 0.38, metalness: 0.5, side: THREE.DoubleSide }));
    pot.position.set(0, 0.02, 2.35); pot.castShadow = true; s.add(pot);
    this.potNotes = new THREE.Group(); this.potNotes.position.set(0, 0.30, 2.35); s.add(this.potNotes);
    this.potTier = -1;
    this.potLabel = textSprite('Owambe Pot ₦0'); this.potLabel.position.set(0, 1.05, 2.35); s.add(this.potLabel);
    // decks and discards
    this.deckPos = { wahala: new THREE.Vector3(-2.95, 0.02, -0.9), family: new THREE.Vector3(2.95, 0.02, -0.9) };
    this.discardPos = { wahala: new THREE.Vector3(-1.90, 0.02, -0.9), family: new THREE.Vector3(1.90, 0.02, -0.9) };
    for (const deck of ['wahala', 'family']) {
      const st = deckStack(deck, 7); st.position.copy(this.deckPos[deck]); st.rotation.y = deck === 'wahala' ? 0.12 : -0.12; s.add(st);
      const dis = makeCardMesh(0.92, 1.30, cardBackTexture(deck), cardBackTexture(deck));
      dis.rotation.x = -Math.PI / 2; dis.rotation.z = 0.2; dis.position.set(this.discardPos[deck].x, 0.055, this.discardPos[deck].z);
      dis.visible = false; s.add(dis); this['discard_' + deck] = dis;
    }
    // dice
    this.dice = [makeDie(0.42), makeDie(0.42)];
    this.diceRest = [new THREE.Vector3(1.55, 0.235, 3.05), new THREE.Vector3(2.35, 0.235, 2.55)];
    this.dice.forEach((d, k) => { d.position.copy(this.diceRest[k]); d.visible = false; s.add(d); });
    // flying card for draws
    this.flyCard = makeCardMesh(0.92, 1.30, cardBackTexture('wahala'), cardBackTexture(null));
    this.flyCard.visible = false; s.add(this.flyCard);
    // held card tray at the centre south edge
    this.tray = new THREE.Group(); s.add(this.tray);
    this.trayCards = new Map();
    // deed card that rises from a tapped tile
    this.deedCard = makeCardMesh(1.24, 1.74, deedCardTexture(39, null), cardBackTexture(null));
    this.deedCard.visible = false; s.add(this.deedCard);
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
      const nl = textSprite(label); nl.position.copy(this.potLabel.position);
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
        t.topMat.map = tileTexture(i, !!pr.m);
        t.topMat.color.set(pr.m ? 0x8f8f8f : 0xffffff);
        t.topMat.needsUpdate = true;
      } else {
        t.frame.visible = false;
        t.topMat.map = tileTexture(i, false);
        t.topMat.color.set(0xffffff);
        t.topMat.needsUpdate = true;
      }
      t.pledge.visible = !!(pr && pr.pl);
      // buildings
      const wantB = pr && pr.o != null ? pr.b : 0;
      if (wantB !== t.bSig) {
        t.bSig = wantB;
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
    // phase relight targets
    const look = PHASE_LOOKS[state.inf ? state.inf.phase - 1 : 0];
    this.phaseTarget = { key: new THREE.Color(look.key), int: look.int, bg: new THREE.Color(look.bg) };
    if (state.status === 'countdown' && !this.countedFor) { this.countedFor = state.code; this.countdownZoom = 2.4; this.camPos.set(0, 20, 18); }
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
    // turn ring follows the turn player's token
    const turn = state.players.find((p) => p.id === state.turnPlayerId);
    if (turn && state.status === 'playing') {
      const o = this.tokens.get(turn.id);
      if (o) { this.turnRing.visible = true; this.turnRing.position.set(o.grp.position.x, 0.245, o.grp.position.z); }
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
      const i = h.userData.space;
      const now = performance.now();
      if (this.lastTap && this.lastTap.space === i && now - this.lastTap.at < 420) {
        this.focusOverride = i; this.focusUntil = now + 4200; // inspect zoom
      } else {
        this.focusOverride = i; this.focusUntil = now + 2600;
      }
      this.lastTap = { space: i, at: now };
      if (B.onSpaceTap) B.onSpaceTap(i);
    } else if (h.userData.trayPlayer != null) {
      const btn = $('abJailCard');
      if (btn) btn.click();
      else {
        const m = this.trayCards.get(h.userData.trayPlayer);
        if (m) { m.userData.pulse = 1; }
      }
    }
  }

  update(dt, tNow) {
    const s = this.scene;
    // bridge danfo shuttle
    const bu = (Math.sin(tNow * 0.13) + 1) / 2;
    const bx2 = -1.22 + bu * 2.44;
    this.bridgeDanfo.position.set(bx2, 0.16 + Math.sin(bu * Math.PI) * 1.25, -2.45);
    this.bridgeDanfo.rotation.z = Math.cos(bu * Math.PI) * 0.42 * (Math.cos(tNow * 0.13) > 0 ? 1 : -1);
    this.bridgeDanfo.rotation.y = Math.cos(tNow * 0.13) > 0 ? Math.PI / 2 : -Math.PI / 2;
    // pot notes gentle shimmer
    this.potNotes.rotation.y = Math.sin(tNow * 0.4) * 0.05;
    // tokens: hops, idle bob, jail cell tilt
    for (const o of this.tokens.values()) {
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
        if (k >= 1) {
          a.cur = nextI; a.path.shift(); a.t = 0;
          o.pos = nextI;
          this.pulse.position.set(pos.x, 0.25, pos.z); this.pulseT = 0;
          if (!a.path.length) { o.anim = null; o.inner.scale.y = 1; }
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
      if (k >= 1) this.diceAnim = null;
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
        if (k >= 1) { a.phase = 'hold'; a.holdT = 0; }
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
    const st = this.lastState;
    let wantPos, wantTgt, damp = 2.4;
    if (this.countdownZoom > 0) {
      this.countdownZoom -= dt;
      wantPos = new THREE.Vector3(0, 12.6, 11.4); wantTgt = new THREE.Vector3(0, 0, -0.4); damp = 1.1;
    } else if (B.effectiveFull()) {
      // Full board: steep (72 degrees) and centred on the island, fitted
      // with the real projection against the square stage (the wrap is
      // aspect 1/1 at every size): the rim silhouette fills 93% of the
      // width and 81% of the height, dead centre, so no tile is cropped,
      // no dead band opens up, and the far row barely foreshortens.
      wantPos = new THREE.Vector3(0, 22.1, 7.7); wantTgt = new THREE.Vector3(0, 0, 0.5);
    } else {
      let f = null;
      if (this.focusOverride != null && performance.now() < this.focusUntil) {
        const t2 = this.tiles[this.focusOverride];
        f = new THREE.Vector3(t2.grp.position.x, 0.2, t2.grp.position.z);
      } else if (st) {
        const turn = st.players.find((p) => p.id === st.turnPlayerId);
        if (turn) { const o = this.tokens.get(turn.id); if (o) f = o.grp.position.clone(); }
      }
      if (!f) f = new THREE.Vector3(0, 0.2, 0);
      const inspect = this.focusOverride != null && performance.now() < this.focusUntil;
      wantPos = f.clone().add(inspect ? new THREE.Vector3(1.8, 3.2, 3.2) : new THREE.Vector3(3.4, 5.6, 6.0));
      wantTgt = f; damp = 3.0;
    }
    const kk = 1 - Math.exp(-dt * damp);
    this.camPos.lerp(wantPos, kk); this.camTgt.lerp(wantTgt, kk);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTgt);
    this.camGlide = this.camPos.distanceTo(wantPos) > 0.05 || this.camTgt.distanceTo(wantTgt) > 0.05;
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
// LANDING SCENE: a Lagos street behind the glass join card
// ---------------------------------------------------------------------------
class LandingScene {
  constructor() {
    const s = this.scene = new THREE.Scene();
    s.background = new THREE.Color(0x35200f);
    s.fog = new THREE.Fog(0xf2b26b, 18, 46);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);
    this.camera.position.set(0, 3.1, 10.5);
    s.add(new THREE.HemisphereLight(0xffe6c0, 0x6a4a28, 0.95));
    const sun = new THREE.DirectionalLight(0xffc37a, 1.5); sun.position.set(-6, 9, 7); s.add(sun);
    // sun disc
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.6, 28), new THREE.MeshBasicMaterial({ color: 0xffd98a, fog: false }));
    disc.position.set(-7.5, 5.4, -16); s.add(disc);
    // ground and road
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(70, 40), std(0x4a3626, 1));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; s.add(ground);
    const road = bx(46, 0.04, 3.1, std(0x2e2a26, 0.95), 0, 0.0, 2.6); road.castShadow = false; s.add(road);
    for (let k = -9; k <= 9; k++) { const dash = bx(1.1, 0.045, 0.14, std(0xf3e6c8, 0.8), k * 2.4, 0.005, 2.6); dash.castShadow = false; s.add(dash); }
    // buildings both sides
    const cols = [0x8a5a3b, 0x39594a, 0x51606e, 0xa8763e, 0x6e4a5a];
    const spots = [[-11, -6.5, 3.4], [-7.6, -7.5, 4.6], [-4.2, -6.8, 2.8], [4.6, -7.2, 3.8], [8.2, -6.6, 2.6], [11.4, -7.4, 4.2], [-9.5, -3.4, 2.2], [9.8, -3.2, 2.4], [-13.5, -4.5, 5.0], [13.8, -4.8, 5.4]];
    for (const [px2, pz, h] of spots) {
      const mat = new THREE.MeshStandardMaterial({ map: windowTexture('#' + cols[Math.abs((px2 * 7) | 0) % 5].toString(16).padStart(6, '0'), 0.5), roughness: 0.9 });
      s.add(bx(2.6, h, 2.2, mat, px2, h / 2, pz));
    }
    // bridge silhouette far north
    const bMat = new THREE.MeshBasicMaterial({ color: 0x54382a });
    const arc = new THREE.Mesh(new THREE.TorusGeometry(7.5, 0.22, 6, 40, Math.PI), bMat);
    arc.position.set(0, 0.4, -13); s.add(arc);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(17, 0.3, 1.4), bMat); deck.position.set(0, 0.4, -13); s.add(deck);
    // palms
    for (const [px2, pz] of [[-5.5, 0.6], [5.8, 0.4], [-2.8, 5.6], [3.1, 5.8], [12.5, 1.2], [-12.8, 1.0]]) {
      const trunk = cyl(0.06, 0.09, 1.6, std(0x7a5a38, 1), px2, 0.8, pz, 8); s.add(trunk);
      for (let f = 0; f < 5; f++) {
        const frond = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.15, 6), std(0x3f7a3a, 0.9));
        frond.position.set(px2 + Math.cos(f * 1.26) * 0.42, 1.75, pz + Math.sin(f * 1.26) * 0.42);
        frond.rotation.z = Math.cos(f * 1.26) * 1.15; frond.rotation.x = -Math.sin(f * 1.26) * 1.15;
        s.add(frond);
      }
    }
    // clouds
    this.clouds = [];
    for (let k = 0; k < 5; k++) {
      const cl = new THREE.Group();
      const cm = new THREE.MeshBasicMaterial({ color: 0xfff3dd, transparent: true, opacity: 0.85 });
      for (let j = 0; j < 3; j++) { const puff = new THREE.Mesh(new THREE.SphereGeometry(0.7 + j * 0.25, 10, 8), cm); puff.scale.y = 0.45; puff.position.set(j * 0.9 - 0.8, 0, 0); cl.add(puff); }
      cl.position.set(-14 + k * 7, 6.4 + (k % 2) * 0.9, -11 - (k % 3));
      this.clouds.push(cl); s.add(cl);
    }
    // traffic: the danfo loop and a parked keke
    this.danfo = buildDanfo(1.25); this.danfo.position.set(-8, 0.03, 2.05); this.danfo.rotation.y = Math.PI / 2; s.add(this.danfo);
    this.danfo.add(new THREE.Mesh(new THREE.CircleGeometry(0.55, 18), MAT.shadow));
    this.danfo.children[this.danfo.children.length - 1].rotation.x = -Math.PI / 2;
    this.danfo.children[this.danfo.children.length - 1].position.y = -0.01;
    const keke = buildKeke(1.1); keke.position.set(6.4, 0.03, 5.6); keke.rotation.y = -0.5; s.add(keke);
    const gen = buildGenerator(1.0); gen.position.set(-6.2, 0.02, 5.4); gen.rotation.y = 0.4; s.add(gen);
  }
  host() { return $('view-landing'); }
  update(dt, t) {
    const d = this.danfo;
    const span = 21;
    let x = ((t * 1.55) % span) - span / 2;
    d.position.x = x;
    d.position.y = 0.03 + Math.abs(Math.sin(t * 9)) * 0.012;
    for (const cl of this.clouds) { cl.position.x += dt * 0.14; if (cl.position.x > 17) cl.position.x = -17; }
    this.camera.position.set(Math.sin(t * 0.07) * 2.3, 3.1 + Math.sin(t * 0.11) * 0.35, 10.5);
    this.camera.lookAt(0, 1.15, -1.2);
  }
}

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
  const sc = SCENES[name];
  if (!sc) return;
  activeName = name;
  const host = sc.host();
  if (host && renderer.domElement.parentElement !== host) host.appendChild(renderer.domElement);
  const cv = renderer.domElement;
  if (name === 'landing') { cv.id = 'glLandingCanvas'; cv.className = ''; }
  else { cv.id = ''; cv.className = 'gl-canvas'; }
  lastFitW = 0; lastFitH = 0;
  fitCanvas(true);
}
function fitCanvas(force) {
  if (!renderer || !activeName) return;
  const host = renderer.domElement.parentElement;
  if (!host) return;
  let w = host.clientWidth, h = host.clientHeight;
  if (activeName === 'landing') { w = window.innerWidth; h = window.innerHeight; }
  if (!w || !h) return;
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
const SHEET_IDS = ['deedScrim', 'listScrim', 'cardScrim', 'choiceScrim', 'proposalScrim', 'shareOverlay', 'phaseOverlay', 'countOverlay'];
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
  if (want !== activeName) { setScene(want); motion(2.5); }
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIER.dprCap));
  renderer.shadowMap.enabled = TIER.shadowSize > 0;
  for (const n in SCENES) retuneShadowLight(SCENES[n] && SCENES[n].keyLight);
  lastFitW = 0; lastFitH = 0; fitCanvas(true); motion(1.2);
}
KP3D.setTier = function (name) {
  if (name === 'auto') { try { localStorage.removeItem('kolopolyTier'); } catch (e) {} applyTier(autoTierName(glRendererName), true); }
  else if (TIER_PARAMS[name]) { try { localStorage.setItem('kolopolyTier', name); } catch (e) {} applyTier(name, false); }
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
  if (!tierOverride()) applyTier(autoTierName(glRendererName), true);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIER.dprCap));
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
    SCENES.landing = new LandingScene();
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
    return {
      active: true, scene: activeName,
      tier: TIER.name, tierAuto: TIER.auto, glRenderer: glRendererName,
      dpr: renderer ? renderer.getPixelRatio() : 0, shadowSize: TIER.shadowSize, texScale: TIER.texScale,
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
  // graphics quality button beside the mute button: cycles Auto, High, Mid, Low
  const tierBtn = $('tierBtn');
  if (tierBtn) {
    tierBtn.classList.remove('hidden');
    const tierLabel = () => (TIER.auto ? 'Auto · ' + TIER.name : TIER.name);
    const paintTierBtn = () => {
      tierBtn.innerHTML = window.icon ? window.icon('spark', 20) : 'Q';
      tierBtn.title = 'Graphics quality: ' + tierLabel();
      tierBtn.setAttribute('aria-label', 'Graphics quality: ' + tierLabel() + '. Tap to change.');
    };
    paintTierBtn();
    tierBtn.addEventListener('click', () => {
      const order = ['auto', 'high', 'mid', 'low'];
      const cur = TIER.auto ? 'auto' : TIER.name;
      KP3D.setTier(order[(order.indexOf(cur) + 1) % order.length]);
      paintTierBtn();
      if (typeof window.toast === 'function') window.toast('Graphics quality: ' + tierLabel(), 2600);
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
