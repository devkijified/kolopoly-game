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
  play: '<path d="M7 4.8v14.4L19 12 7 4.8z"/>'
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
