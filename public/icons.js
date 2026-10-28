'use strict';
// KOLOPOLY icon wrapper. One source of truth: icon(name) returns an inline
// SVG string. UI icons are IconSax style strokes; token glyphs are drawn for
// the six player pieces. No emoji anywhere in the game chrome.
const KP_ICON_PATHS = {
  dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.2" cy="8.2" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.8" cy="8.2" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="8.2" cy="15.8" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.8" cy="15.8" r="1.3" fill="currentColor" stroke="none"/>',
  gavel: '<path d="M13.5 6.5l4 4M10 4l4.5 4.5M15.5 2.5l6 6M12 7l-2.5-2.5a1.8 1.8 0 0 0-2.5 0l-1 1a1.8 1.8 0 0 0 0 2.5L8.5 10.5M11 13l-5.5 5.5a2.1 2.1 0 1 0 3 3L14 16M3 21.5h8"/>',
  swap: '<path d="M4 7h13M13.5 3.5L17 7l-3.5 3.5M20 17H7M10.5 13.5L7 17l3.5 3.5"/>',
  crown: '<path d="M3 18.5h18M4 18.5L2.8 8.5l5.2 3.4L12 5l4 6.9 5.2-3.4L20 18.5"/>',
  sound: '<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.8a7.4 7.4 0 0 1 0 10.4"/>',
  // KP14 WS-C: state 1 of the one audio button (sound + voice on) is the
  // speaker and its wave wearing a small mic badge, so the three states
  // read apart at 20px: badged speaker (sound + voice), plain speaker
  // (sound alone), crossed speaker (all off). There is no voice button
  // and no speech-bubble glyph for voice anymore: the messages bubble
  // belongs to Gist alone.
  soundVoice: '<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4z"/><path d="M15.2 10a2.6 2.6 0 0 1 0 4"/><circle cx="18.1" cy="18.1" r="3.9" fill="#fffaf0" stroke-width="1.3"/><rect x="17.15" y="15.6" width="1.9" height="3.1" rx="0.95" fill="currentColor" stroke="none"/><path d="M16.35 17.9a1.75 1.75 0 0 0 3.5 0" stroke-width="1"/>',
  mute: '<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>',
  share: '<circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="5.5" r="2.6"/><circle cx="17.5" cy="18.5" r="2.6"/><path d="M8.3 10.8l6.9-4M8.3 13.2l6.9 4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M3.5 20c.6-3.2 2.8-4.8 5.5-4.8s4.9 1.6 5.5 4.8"/><circle cx="17" cy="9.5" r="2.7"/><path d="M16.5 15.4c2.3.3 3.7 1.8 4.1 4.1"/>',
  home: '<path d="M4 11.5L12 4l8 7.5"/><path d="M6.5 10v9.5h11V10"/><path d="M10 19.5v-5h4v5"/>',
  bank: '<path d="M3.5 9.5L12 4l8.5 5.5M4.5 9.5h15M5.5 9.5V18M10 9.5V18M14 9.5V18M18.5 9.5V18M3.5 20.5h17M3.5 18h17"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18"/>',
  alert: '<path d="M12 4L2.8 20h18.4L12 4z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.2" r="0.6" fill="currentColor"/>',
  chevD: '<path d="M5.5 9.5L12 16l6.5-6.5"/>',
  spark: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3z"/><path d="M18.8 15.8l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z"/>',
  bill: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6.2 9.2h.01M17.8 14.8h.01"/>',
  key: '<circle cx="8" cy="14.5" r="4.5"/><path d="M11.2 11.3L20 2.5M16.5 6l3 3M14 8.5l2.2 2.2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  flag: '<path d="M5.5 21.5v-17"/><path d="M5.5 4.8c4-2.2 6.5 2 12.5 0v8.5c-6 2-8.5-2.2-12.5 0"/>',
  leave: '<path d="M14 4h-7.5v16H14M10.5 12h10M17 8.5L20.5 12 17 15.5"/>',
  book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15z"/><path d="M5 19.5A1.5 1.5 0 0 1 6.5 18H19v3H6.5A1.5 1.5 0 0 1 5 19.5z"/>',
  jail: '<path d="M5 21V8.5M9.7 21V8.5M14.3 21V8.5M19 21V8.5M3.5 8.5h17M3.5 4.5h17M3.5 21h17"/>',
  play: '<path d="M7 4.8v14.4L19 12 7 4.8z"/>',
  // KP9 utility bar: the five IconSax glyphs, vendored as files under
  // public/icons/ (document-text, arrow-swap-horizontal, messages-2,
  // logout, tick-circle) and mapped here through the same helper.
  docText: '<path d="M21 10.5V15.2C21 19.1 19.1 21 15.2 21H8.8C4.9 21 3 19.1 3 15.2V8.8C3 4.9 4.9 3 8.8 3H15.5"/><path d="M21 10.5H18.3C16.5 10.5 15.5 9.5 15.5 7.7V3"/><path d="M8 13.2H13.5"/><path d="M8 16.8H11"/>',
  swapH: '<path d="M3.5 7.5H20.5"/><path d="M17.2 4.2L20.5 7.5L17.2 10.8"/><path d="M20.5 16.5H3.5"/><path d="M6.8 13.2L3.5 16.5L6.8 19.8"/>',
  messages: '<path d="M14.5 2.5H18C20.6 2.5 21.5 3.4 21.5 6V9.5C21.5 12.1 20.6 13 18 13H17"/><path d="M6.5 20.5H13C15.8 20.5 17 19.3 17 16.5V11.5C17 8.7 15.8 7.5 13 7.5H6.5C3.7 7.5 2.5 8.7 2.5 11.5V16.5C2.5 19.3 3.7 20.5 6.5 20.5Z"/><path d="M6.2 20.4L5.9 22.4C5.8 23 6.5 23.4 7 23L9.8 20.5"/>',
  logout: '<path d="M12.5 3.5H10C6.5 3.5 4.5 5.5 4.5 9V15C4.5 18.5 6.5 20.5 10 20.5H12.5"/><path d="M9 12H20.5"/><path d="M17 8L20.5 12L17 16"/>',
  tickCircle: '<path d="M12 21.5C17.25 21.5 21.5 17.25 21.5 12C21.5 6.75 17.25 2.5 12 2.5C6.75 2.5 2.5 6.75 2.5 12C2.5 17.25 6.75 21.5 12 21.5Z"/><path d="M8.2 12.4L11.1 15.3L15.9 10"/>'
};
// Token glyphs, drawn on a 48 grid so they stay crisp on the board pieces.
const KP_TOKEN_PATHS = {
  danfo: '<rect x="7" y="7" width="34" height="27" rx="6"/><path d="M7 21h34"/><path d="M13.5 14.5h9M25.5 14.5h9"/><path d="M14 34v3.5M34 34v3.5"/><circle cx="15" cy="39.5" r="2.8"/><circle cx="33" cy="39.5" r="2.8"/><path d="M18 27.5h12"/>',
  keke: '<path d="M9 31V19a9 9 0 0 1 18 0v12"/><path d="M6 31h23"/><path d="M29 31l7 4"/><circle cx="12" cy="38" r="4.2"/><circle cx="30" cy="38" r="4.2"/><circle cx="40" cy="38" r="3"/><path d="M18 10.5V19"/>',
  okada: '<circle cx="11" cy="35" r="6"/><circle cx="37" cy="35" r="6"/><path d="M11 35l9-15h7l5 9M20 20l-3.5 15M27 20l10 15M31 13h6l3.5 9M17 27h11"/>',
  generator: '<rect x="7" y="11" width="34" height="26" rx="3.5"/><circle cx="24" cy="24" r="6.5"/><path d="M24 17.5v13M17.5 24h13M19.4 19.4l9.2 9.2M28.6 19.4l-9.2 9.2"/><path d="M13 11V7.5M35 11V7.5"/>',
  boot: '<path d="M5 33.5c7.5.5 13-1 17.5-5.5l4.5-9.5c.8-1.8 3.4-2 4.4-.3l2.3 4.8 8 2.8c2.4.9 2.2 7.2-.4 7.2H7.5c-2 0-3.4-.8-2.5 0z"/><path d="M9 38.5v3M17 38.5v3M25 38.5v3M33 38.5v3M41 38.5v3"/><path d="M26 24.5l4.5 2M24 28.5l4.5 2"/>',
  fila: '<path d="M7 31c0-9.5 7.6-16 17-16s17 6.5 17 16"/><path d="M7 31h34"/><path d="M13.5 31c1.8-5 5.7-7.5 10.5-7.5S32.7 26 34.5 31"/><path d="M24 15v-3"/>'
};
function icon(name, size) {
  const s = size || 20;
  if (KP_TOKEN_PATHS[name]) {
    return '<svg class="ic ic-token" width="' + s + '" height="' + s + '" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + KP_TOKEN_PATHS[name] + '</svg>';
  }
  const p = KP_ICON_PATHS[name] || '';
  return '<svg class="ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
}
window.icon = icon;
window.KP_TOKEN_PATHS = KP_TOKEN_PATHS;

// ---------------------------------------------------------------------------
// Rich token art: the six pieces drawn as shaded objects on a 48 grid.
// Used on the board and in the token picker. The stroke glyphs above stay
// for small UI avatars where a white line mark reads better.
// ---------------------------------------------------------------------------
const KP_TOKEN_ART = {
  danfo:
    '<ellipse cx="24" cy="42" rx="17" ry="3" fill="#000" opacity=".18"/>' +
    '<rect x="4" y="13" width="40" height="21" rx="5" fill="#f6b73c"/>' +
    '<rect x="4" y="13" width="40" height="7" rx="3.5" fill="#ffd873"/>' +
    '<rect x="4" y="25" width="40" height="4" fill="#232323"/>' +
    '<rect x="8" y="16" width="6.5" height="5.5" rx="1" fill="#cfeefb"/>' +
    '<rect x="16.5" y="16" width="6.5" height="5.5" rx="1" fill="#cfeefb"/>' +
    '<rect x="25" y="16" width="6.5" height="5.5" rx="1" fill="#cfeefb"/>' +
    '<rect x="33.5" y="16" width="6.5" height="5.5" rx="1" fill="#9fd4ea"/>' +
    '<rect x="6" y="30" width="5" height="3" rx="1" fill="#fff3c4"/>' +
    '<rect x="37" y="30" width="5" height="3" rx="1" fill="#fff3c4"/>' +
    '<circle cx="13" cy="35" r="4.6" fill="#1d1d1f"/><circle cx="13" cy="35" r="2" fill="#cfd4d8"/>' +
    '<circle cx="35" cy="35" r="4.6" fill="#1d1d1f"/><circle cx="35" cy="35" r="2" fill="#cfd4d8"/>',
  keke:
    '<ellipse cx="24" cy="42" rx="15" ry="3" fill="#000" opacity=".18"/>' +
    '<path d="M10 30 L14 14 Q15 10 20 10 L30 10 Q36 10 37 16 L38 30 Z" fill="#1d9e6c"/>' +
    '<path d="M15 15 L33 15 L34 22 L14 22 Z" fill="#cfeefb"/>' +
    '<rect x="8" y="29" width="32" height="5" rx="2" fill="#146c48"/>' +
    '<rect x="20" y="22" width="8" height="7" fill="#f6b73c"/>' +
    '<circle cx="13" cy="36" r="4.4" fill="#1d1d1f"/><circle cx="13" cy="36" r="1.8" fill="#cfd4d8"/>' +
    '<circle cx="35" cy="36" r="4.4" fill="#1d1d1f"/><circle cx="35" cy="36" r="1.8" fill="#cfd4d8"/>' +
    '<circle cx="24" cy="38" r="3.4" fill="#1d1d1f"/><circle cx="24" cy="38" r="1.3" fill="#cfd4d8"/>',
  okada:
    '<ellipse cx="24" cy="42" rx="17" ry="3" fill="#000" opacity=".18"/>' +
    '<circle cx="11" cy="34" r="6.5" fill="none" stroke="#1d1d1f" stroke-width="3"/><circle cx="11" cy="34" r="1.6" fill="#1d1d1f"/>' +
    '<circle cx="38" cy="34" r="6.5" fill="none" stroke="#1d1d1f" stroke-width="3"/><circle cx="38" cy="34" r="1.6" fill="#1d1d1f"/>' +
    '<path d="M11 34 L20 22 L30 22 L38 34 L29 34 L24 27 L18 34 Z" fill="#d64545"/>' +
    '<rect x="19" y="19" width="10" height="4" rx="2" fill="#232323"/>' +
    '<path d="M30 22 L35 15 L39 16 L34 23 Z" fill="#232323"/>' +
    '<circle cx="24" cy="8" r="3.6" fill="#f6b73c"/>' +
    '<path d="M22 12 Q27 12 28 18 L29 23 L21 23 L20 17 Q20 12 22 12Z" fill="#2b2018"/>' +
    '<path d="M27 17 L34 16 L35 19 L28 21 Z" fill="#2b2018"/>' +
    '<path d="M22 23 L27 30 L24 32 L18 25 Z" fill="#2b2018"/>',
  generator:
    '<ellipse cx="24" cy="42" rx="16" ry="3" fill="#000" opacity=".18"/>' +
    '<rect x="7" y="10" width="34" height="26" rx="4" fill="#c23b2e"/>' +
    '<rect x="7" y="10" width="34" height="26" rx="4" fill="none" stroke="#232323" stroke-width="3"/>' +
    '<rect x="12" y="16" width="11" height="14" rx="2" fill="#232323"/>' +
    '<circle cx="30" cy="20" r="3.4" fill="#f5efe2"/>' +
    '<rect x="26.5" y="26" width="9" height="2.4" fill="#f5efe2" opacity=".85"/>' +
    '<rect x="26.5" y="30" width="9" height="2.4" fill="#f5efe2" opacity=".85"/>' +
    '<circle cx="17.5" cy="23" r="2.2" fill="#f6b73c"/>' +
    '<rect x="14" y="36" width="6" height="4" fill="#232323"/><rect x="28" y="36" width="6" height="4" fill="#232323"/>' +
    '<rect x="20" y="6" width="8" height="4" rx="2" fill="#232323"/>',
  boot:
    '<ellipse cx="24" cy="42" rx="16" ry="3" fill="#000" opacity=".18"/>' +
    '<path d="M5 34 Q5 20 12 12 L16 8 Q18 6 20 9 L23 16 Q24 20 28 22 L41 28 Q45 30 44 34 Q43.5 37 40 37 L9 37 Q5 37 5 34Z" fill="#ff7a1a"/>' +
    '<path d="M5 37 L44 37 L44 40 Q30 41.5 5 40Z" fill="#232323"/>' +
    '<rect x="10" y="40" width="3.5" height="3" fill="#232323"/><rect x="19" y="40.5" width="3.5" height="3" fill="#232323"/>' +
    '<rect x="28" y="40.5" width="3.5" height="3" fill="#232323"/><rect x="37" y="40" width="3.5" height="3" fill="#232323"/>' +
    '<path d="M14 14 L20 12 M13 19 L20 17 M13 24 L20 22" stroke="#fff3c4" stroke-width="2.2" stroke-linecap="round"/>' +
    '<path d="M26 24 L40 30" stroke="#ffffff" stroke-width="3" opacity=".85" stroke-linecap="round"/>',
  fila:
    '<ellipse cx="24" cy="40" rx="15" ry="3" fill="#000" opacity=".15"/>' +
    '<path d="M8 34 Q8 16 24 14 Q40 16 40 34 Q32 38 24 38 Q16 38 8 34Z" fill="#7a4fa3"/>' +
    '<path d="M8 34 Q16 30 24 30 Q32 30 40 34 Q32 38 24 38 Q16 38 8 34Z" fill="#5d3a82"/>' +
    '<path d="M24 14 Q27 8 33 8 Q30 13 28 15 Q25 16 24 14Z" fill="#7a4fa3"/>' +
    '<path d="M12 24 Q24 20 36 24" stroke="#f6b73c" stroke-width="2.4" fill="none"/>' +
    '<path d="M11 29 Q24 25 37 29" stroke="#f6b73c" stroke-width="2" fill="none" opacity=".8"/>'
};
function tokenArt(id, size) {
  const s = size || 48;
  const body = KP_TOKEN_ART[id] || KP_TOKEN_PATHS[id] || '';
  return '<svg class="tokart" width="' + s + '" height="' + s + '" viewBox="0 0 48 48" aria-hidden="true">' + body + '</svg>';
}
window.tokenArt = tokenArt;
window.KP_TOKEN_ART = KP_TOKEN_ART;

// ---------------------------------------------------------------------------
// Tile scene art: one small original scene per space identity, drawn filled
// on a 48 grid. Accent parts use currentColor, which the tile sets to its
// colour band colour.
// ---------------------------------------------------------------------------
const KP_ART = {
  payday:
    '<rect x="6" y="15" width="27" height="17" rx="2.5" fill="#1d9e6c"/>' +
    '<rect x="6" y="15" width="27" height="17" rx="2.5" fill="none" stroke="#0f7a50" stroke-width="2"/>' +
    '<circle cx="19.5" cy="23.5" r="5" fill="#f5efe2"/>' +
    '<text x="19.5" y="28" font-size="10" font-weight="900" text-anchor="middle" fill="#0f7a50">₦</text>' +
    '<circle cx="36" cy="30" r="7" fill="#f6b73c" stroke="#e8a90c" stroke-width="2"/>' +
    '<text x="36" y="34.5" font-size="10" font-weight="900" text-anchor="middle" fill="#7a5200">₦</text>',
  stilts:
    '<rect x="8" y="13" width="13" height="9" fill="#b0653a"/><path d="M6 13 L14.5 7 L23 13Z" fill="#7a3b22"/>' +
    '<rect x="27" y="13" width="13" height="9" fill="#c97b4a"/><path d="M25 13 L33.5 7 L42 13Z" fill="#7a3b22"/>' +
    '<path d="M12 32 L12 22 M20 32 L20 22 M30 32 L30 22 M38 32 L38 22" stroke="#8a5a33" stroke-width="2.6"/>' +
    '<path d="M4 34 Q10 31 16 34 T28 34 T44 34" stroke="#3f7fbf" stroke-width="3" fill="none" stroke-linecap="round"/>' +
    '<path d="M6 40 Q12 37 18 40 T30 40 T44 40" stroke="#7ec3e8" stroke-width="3" fill="none" stroke-linecap="round"/>',
  stalls:
    '<path d="M6 18 L42 18 L38 10 L10 10Z" fill="currentColor"/>' +
    '<path d="M13 10.8 L15 17.4 M20 10.4 L21.4 17.4 M27 10.4 L26.6 17.4 M34 10.8 L33 17.4" stroke="#fffdf7" stroke-width="2"/>' +
    '<rect x="9" y="18" width="30" height="4" fill="#8a5a33"/>' +
    '<rect x="11" y="22" width="26" height="13" fill="#e8dcc2"/>' +
    '<rect x="14" y="26" width="6" height="6" fill="#d64545"/><rect x="22" y="26" width="6" height="6" fill="#f6b73c"/><rect x="30" y="26" width="6" height="6" fill="#1d9e6c"/>' +
    '<path d="M10 35 L10 42 M38 35 L38 42" stroke="#8a5a33" stroke-width="3"/>',
  ball:
    '<circle cx="24" cy="23" r="15" fill="#fffdf7" stroke="#2b2018" stroke-width="2.4"/>' +
    '<path d="M24 16 L30 20.5 L27.8 27.5 L20.2 27.5 L18 20.5Z" fill="#2b2018"/>' +
    '<path d="M24 8.5 L24 16 M38 18 L30 20.5 M33.5 34.5 L27.8 27.5 M14.5 34.5 L20.2 27.5 M10 18 L18 20.5" stroke="#2b2018" stroke-width="1.8"/>' +
    '<path d="M6 41 Q24 35 42 41" stroke="#1d9e6c" stroke-width="3" fill="none" stroke-linecap="round"/>',
  house:
    '<path d="M5 25 L24 8 L43 25 L38 25 L24 13 L10 25Z" fill="#b02e2e"/>' +
    '<rect x="12" y="24" width="24" height="16" fill="#f3e7c8"/>' +
    '<rect x="21" y="30" width="6" height="10" fill="#8a5a33"/>' +
    '<rect x="14.5" y="27" width="5" height="5" fill="#7ec3e8"/><rect x="28.5" y="27" width="5" height="5" fill="#7ec3e8"/>',
  bread:
    '<path d="M8 30 Q8 16 24 16 Q40 16 40 30 Q40 36 34 36 L14 36 Q8 36 8 30Z" fill="#e0a458"/>' +
    '<path d="M15 21 Q17 25 15 28 M24 20 Q26 24 24 28 M33 21 Q35 25 33 28" stroke="#b97f36" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
    '<rect x="6" y="36" width="36" height="3.4" rx="1.7" fill="#8a5a33"/>',
  tech:
    '<rect x="10" y="12" width="28" height="20" rx="2.5" fill="#2b3f9e"/>' +
    '<rect x="13" y="15" width="22" height="14" fill="#7ec3e8"/>' +
    '<path d="M16 26 L21 20 L25 24 L30 18" stroke="#0f7a50" stroke-width="2.2" fill="none"/>' +
    '<rect x="20" y="32" width="8" height="3.4" fill="#2b2018"/>' +
    '<rect x="14" y="37" width="20" height="2.6" rx="1.3" fill="#2b2018"/>',
  stadium:
    '<path d="M10 10 L10 22 M38 10 L38 22" stroke="#2b2018" stroke-width="2.4"/>' +
    '<circle cx="7.5" cy="9" r="2.2" fill="#ffd873"/><circle cx="12.5" cy="9" r="2.2" fill="#ffd873"/>' +
    '<circle cx="35.5" cy="9" r="2.2" fill="#ffd873"/><circle cx="40.5" cy="9" r="2.2" fill="#ffd873"/>' +
    '<path d="M6 26 Q24 18 42 26 L39 36 Q24 41 9 36Z" fill="#3f7fbf"/>' +
    '<path d="M6 26 Q24 18 42 26 Q24 31 6 26Z" fill="#7ec3e8"/>' +
    '<ellipse cx="24" cy="25.5" rx="10" ry="2.8" fill="#1d9e6c"/>',
  towers:
    '<rect x="8" y="16" width="9" height="26" fill="#5c6b7a"/>' +
    '<rect x="19.5" y="8" width="10" height="34" fill="#2b3f9e"/>' +
    '<rect x="32" y="13" width="9" height="29" fill="#7a4fa3"/>' +
    '<rect x="10.4" y="20" width="4" height="3" fill="#ffe9a8"/><rect x="10.4" y="27" width="4" height="3" fill="#ffe9a8"/><rect x="10.4" y="34" width="4" height="3" fill="#ffe9a8"/>' +
    '<rect x="22.4" y="13" width="4" height="3" fill="#ffe9a8"/><rect x="22.4" y="20" width="4" height="3" fill="#ffe9a8"/><rect x="22.4" y="27" width="4" height="3" fill="#ffe9a8"/><rect x="22.4" y="34" width="4" height="3" fill="#ffe9a8"/>' +
    '<rect x="34.4" y="18" width="4" height="3" fill="#ffe9a8"/><rect x="34.4" y="25" width="4" height="3" fill="#ffe9a8"/><rect x="34.4" y="32" width="4" height="3" fill="#ffe9a8"/>' +
    '<rect x="6" y="42" width="36" height="2.6" fill="#2b2018"/>',
  computer:
    '<rect x="9" y="11" width="30" height="21" rx="2" fill="#232323"/>' +
    '<rect x="12" y="14" width="24" height="15" fill="#39c2a5"/>' +
    '<path d="M16 19 H24 M16 23.5 H28" stroke="#dffcf3" stroke-width="2.2" stroke-linecap="round"/>' +
    '<rect x="22" y="32" width="4" height="3" fill="#232323"/>' +
    '<rect x="13" y="36.5" width="22" height="3" rx="1.5" fill="#232323"/>',
  gate:
    '<rect x="7" y="14" width="5" height="28" fill="#8a5a33"/><rect x="36" y="14" width="5" height="28" fill="#8a5a33"/>' +
    '<rect x="5.5" y="10" width="8" height="5" rx="1" fill="#5d3a1c"/><rect x="34.5" y="10" width="8" height="5" rx="1" fill="#5d3a1c"/>' +
    '<rect x="18" y="12.5" width="12" height="5" rx="1" fill="currentColor"/>' +
    '<path d="M12 20 H36 M12 40 H36" stroke="#2b2018" stroke-width="3"/>' +
    '<path d="M17.5 20 V40 M24 20 V40 M30.5 20 V40" stroke="#2b2018" stroke-width="2.6"/>',
  bank:
    '<path d="M24 6 L42 16 L6 16Z" fill="#2b2018"/>' +
    '<circle cx="24" cy="11.5" r="1.8" fill="#f5efe2"/>' +
    '<rect x="8" y="19" width="4.5" height="17" fill="#8a94a6"/><rect x="17.5" y="19" width="4.5" height="17" fill="#8a94a6"/>' +
    '<rect x="26" y="19" width="4.5" height="17" fill="#8a94a6"/><rect x="35.5" y="19" width="4.5" height="17" fill="#8a94a6"/>' +
    '<rect x="5" y="36" width="38" height="3.4" fill="#2b2018"/>' +
    '<rect x="5" y="41" width="38" height="2.6" fill="#2b2018"/>',
  palms:
    '<path d="M16 42 Q15 28 18 16" stroke="#8a5a33" stroke-width="3.4" fill="none" stroke-linecap="round"/>' +
    '<path d="M18 16 Q10 8 4 12 M18 16 Q14 6 8 5 M18 16 Q22 6 28 6 M18 16 Q26 10 31 13" stroke="#1d9e6c" stroke-width="2.8" fill="none" stroke-linecap="round"/>' +
    '<path d="M34 42 Q35 32 33 24" stroke="#8a5a33" stroke-width="2.8" fill="none" stroke-linecap="round"/>' +
    '<path d="M33 24 Q27 18 22 20 M33 24 Q31 15 26 14 M33 24 Q37 16 42 16" stroke="#1d9e6c" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
    '<path d="M6 43 Q24 39 42 43" stroke="#e8a90c" stroke-width="2.6" fill="none"/>',
  crane:
    '<path d="M12 42 V10 M12 10 H38" stroke="#2b2018" stroke-width="3.4"/>' +
    '<path d="M12 16 L24 10" stroke="#2b2018" stroke-width="2.2"/>' +
    '<path d="M33 10 V18" stroke="#2b2018" stroke-width="2.2"/>' +
    '<rect x="28" y="18" width="10" height="7" fill="#d64545"/>' +
    '<rect x="10" y="30" width="12" height="8" fill="#3f7fbf"/><rect x="23" y="30" width="12" height="8" fill="#f08c28"/>' +
    '<path d="M6 42 H42" stroke="#2b2018" stroke-width="2.6"/>' +
    '<path d="M6 45.5 Q12 43.5 18 45.5 T30 45.5 T42 45.5" stroke="#7ec3e8" stroke-width="2" fill="none"/>',
  dome:
    '<rect x="22.6" y="4" width="2.8" height="6" fill="#2b2018"/><path d="M25.4 4 L33 6 L25.4 8.4Z" fill="#d64545"/>' +
    '<path d="M10 26 Q24 8 38 26Z" fill="#2e9e5b"/>' +
    '<rect x="8" y="26" width="32" height="3" fill="#2b2018"/>' +
    '<rect x="11" y="29" width="3.6" height="10" fill="#cfd4d8"/><rect x="19" y="29" width="3.6" height="10" fill="#cfd4d8"/>' +
    '<rect x="26.5" y="29" width="3.6" height="10" fill="#cfd4d8"/><rect x="34" y="29" width="3.6" height="10" fill="#cfd4d8"/>' +
    '<rect x="6" y="39" width="36" height="3" fill="#2b2018"/>',
  mansion:
    '<path d="M4 22 L24 7 L44 22 L40 22 L24 11 L8 22Z" fill="#7a1f1f"/>' +
    '<rect x="9" y="21" width="30" height="17" fill="#fdf6df"/>' +
    '<rect x="12" y="21" width="3" height="17" fill="#e3d7c3"/><rect x="20" y="21" width="3" height="17" fill="#e3d7c3"/>' +
    '<rect x="28" y="21" width="3" height="17" fill="#e3d7c3"/><rect x="35" y="21" width="3" height="17" fill="#e3d7c3"/>' +
    '<rect x="21" y="28" width="6" height="10" fill="#5d3a1c"/>' +
    '<rect x="4" y="38" width="40" height="2.6" fill="#2b2018"/>',
  island:
    '<circle cx="35" cy="11" r="5.5" fill="#f6b73c"/>' +
    '<path d="M22 33 Q21 24 24 18" stroke="#8a5a33" stroke-width="2.8" fill="none" stroke-linecap="round"/>' +
    '<path d="M24 18 Q18 11 12 13 M24 18 Q21 9 16 8 M24 18 Q28 10 34 10 M24 18 Q30 13 35 15" stroke="#1d9e6c" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
    '<path d="M8 36 Q18 30 30 33 Q40 35 42 38 Q30 42 16 41 Q7 40 8 36Z" fill="#e8c98a"/>' +
    '<path d="M5 44.5 Q11 42.5 17 44.5 T29 44.5 T41 44.5" stroke="#3f7fbf" stroke-width="2.2" fill="none"/>',
  pylon:
    '<path d="M13 12 H35 M15 20 H33" stroke="#2b2018" stroke-width="2.6"/>' +
    '<path d="M13 12 Q24 20 35 12 M15 20 Q24 27 33 20" stroke="#5c4c3d" stroke-width="1.6" fill="none"/>' +
    '<path d="M18 44 L22 8 H26 L30 44 M19.5 32 H28.5 M20.5 22 H27.5" stroke="#2b2018" stroke-width="2.4" fill="none"/>' +
    '<circle cx="24" cy="29" r="3" fill="#ffd873"/>',
  watertower:
    '<rect x="12" y="4.5" width="24" height="3.4" rx="1.6" fill="#2b5f8a"/>' +
    '<path d="M13 8 H35 L33 20 Q24 24 15 20Z" fill="#3f7fbf"/>' +
    '<path d="M16 22 L13 42 M32 22 L35 42 M24 23 V42 M14.5 32 H33.5" stroke="#2b2018" stroke-width="2.6"/>' +
    '<path d="M40.5 25 Q44.5 31 40.5 34.5 Q36.5 31 40.5 25Z" fill="#7ec3e8"/>',
  bars:
    '<rect x="7" y="7" width="34" height="34" rx="3" fill="#3a3f46"/>' +
    '<path d="M14 7 V41 M21.5 7 V41 M29 7 V41 M36.5 7 V41" stroke="#cfd4d8" stroke-width="3"/>' +
    '<rect x="7" y="21" width="34" height="4.6" fill="#232323"/>' +
    '<circle cx="24" cy="31.5" r="3.4" fill="#f6b73c"/>',
  party:
    '<path d="M5 20 Q24 6 43 20 L43 24.5 Q36.5 20.5 31 24.5 Q24 20.5 17.5 24.5 Q11 20.5 5 24.5Z" fill="currentColor"/>' +
    '<path d="M8 24.5 V40 M40 24.5 V40" stroke="#8a5a33" stroke-width="2.8"/>' +
    '<rect x="14" y="27" width="6" height="3.6" rx="1" fill="#1d9e6c" transform="rotate(-14 17 29)"/>' +
    '<rect x="22" y="28.5" width="6" height="3.6" rx="1" fill="#f6b73c" transform="rotate(10 25 30)"/>' +
    '<rect x="29" y="26.5" width="6" height="3.6" rx="1" fill="#d64545" transform="rotate(-8 32 28)"/>' +
    '<path d="M19.5 34 h9 l-1.4 6.5 h-6.2Z" fill="#b0653a"/>' +
    '<path d="M12 40.5 H36" stroke="#2b2018" stroke-width="2.6"/>',
  taxdoc:
    '<path d="M13 5 H32 L37 10 V43 H13Z" fill="#fffdf7" stroke="#2b2018" stroke-width="2.2"/>' +
    '<path d="M32 5 V10 H37" fill="none" stroke="#2b2018" stroke-width="2"/>' +
    '<path d="M17 17 H33 M17 22 H33 M17 27 H27" stroke="#b8a888" stroke-width="2.2"/>' +
    '<text x="17.5" y="40" font-size="11" font-weight="900" fill="#b02e2e">₦</text>' +
    '<circle cx="31" cy="35" r="5.4" fill="none" stroke="#b02e2e" stroke-width="2"/>' +
    '<path d="M28.5 35 L30.6 37 L33.8 33.4" stroke="#b02e2e" stroke-width="1.8" fill="none"/>',
  cards:
    '<rect x="9" y="10" width="19" height="27" rx="2.6" transform="rotate(-9 18 24)" fill="#d64545"/>' +
    '<rect x="21" y="11" width="19" height="27" rx="2.6" transform="rotate(8 30 24)" fill="#3f7fbf"/>' +
    '<circle cx="17.5" cy="21" r="3.4" fill="#ffffff" opacity=".85"/>' +
    '<path d="M30.5 19 l1.7 3.8 4.1.4 -3.1 2.7 .9 4 -3.6-2.1 -3.6 2.1 .9-4 -3.1-2.7 4.1-.4Z" fill="#ffffff" opacity=".9"/>',
  train:
    '<rect x="20" y="3.4" width="8" height="3.4" rx="1.6" fill="#f6b73c"/>' +
    '<rect x="11" y="7" width="26" height="27" rx="6" fill="#3f7fbf"/>' +
    '<rect x="15" y="11" width="18" height="9" rx="2" fill="#cfeefb"/>' +
    '<rect x="11" y="24" width="26" height="3" fill="#2b2018"/>' +
    '<circle cx="17.5" cy="29.5" r="2.2" fill="#ffd873"/><circle cx="30.5" cy="29.5" r="2.2" fill="#ffd873"/>' +
    '<path d="M15 41 L20 34 M33 41 L28 34" stroke="#2b2018" stroke-width="2.6"/>',
  plane:
    '<path d="M24 4 L27 16 L42 26 L42 30 L27 25 L27 36 L30.5 40 L30.5 42.6 L24 41.4 L17.5 42.6 L17.5 40 L21 36 L21 25 L6 30 L6 26 L21 16Z" fill="#5c6b7a"/>' +
    '<path d="M24 4 L27 16 L21 16Z" fill="#d64545"/>',
  ship:
    '<rect x="13" y="24" width="10" height="7" fill="#d64545"/><rect x="24" y="24" width="10" height="7" fill="#3f7fbf"/>' +
    '<rect x="18.5" y="16.5" width="10" height="7" fill="#f08c28"/>' +
    '<path d="M36 31 V14" stroke="#2b2018" stroke-width="2.4"/><path d="M36 14 L42 20 H36" fill="#f6b73c"/>' +
    '<path d="M8 31 H40 L36 41 H13Z" fill="#2b2018"/>' +
    '<path d="M5 45 Q11 43 17 45 T29 45 T41 45" stroke="#3f7fbf" stroke-width="2.2" fill="none"/>',
  interchange:
    '<path d="M4 30 Q24 30 44 16" stroke="#8a94a6" stroke-width="6" fill="none"/>' +
    '<path d="M4 16 Q24 34 44 32" stroke="#5c6b7a" stroke-width="6" fill="none"/>' +
    '<path d="M4 30 Q24 30 44 16" stroke="#f5efe2" stroke-width="1.4" stroke-dasharray="4 4" fill="none"/>' +
    '<rect x="19" y="18.5" width="11" height="6.5" rx="1.6" fill="#f6b73c"/>' +
    '<rect x="21" y="20.1" width="3" height="2.4" fill="#cfeefb"/><rect x="25.4" y="20.1" width="3" height="2.4" fill="#cfeefb"/>' +
    '<circle cx="22" cy="25.5" r="1.5" fill="#232323"/><circle cx="27.5" cy="25.5" r="1.5" fill="#232323"/>'
};
function tileArt(id) {
  const body = KP_ART[id] || '';
  return '<svg class="tileart" viewBox="0 0 48 48" aria-hidden="true">' + body + '</svg>';
}
window.tileArt = tileArt;
window.KP_ART = KP_ART;
