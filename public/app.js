'use strict';
// KOLOPOLY client. Sends intents only; the server owns dice, money and deeds.
// Test hooks: window.__kolopolyState() and window.__kolopolySend(type, obj).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.KPesc = esc;
// fmtN is a global function declared by game-data.js; redeclaring it here
// would throw. Use it directly.

let ws = null;
let myId = null;
let myCode = null;
let spectator = false;
let state = null;
let entrySent = false;
let selectedToken = (() => {
  try {
    const t = localStorage.getItem('kolopolyToken');
    if (t && window.KP_DATA && window.KP_DATA.TOKENS.some((x) => x.id === t)) return t;
  } catch (e) { }
  return 'danfo';
})();
let selectedGameMode = 'classic';
let selectedRoomMode = 'online';
let lastFeedSeq = 0;
let feedPrimed = false;
let lastCardSeq = 0;
let shownTradeId = 0;
let shownProposalId = 0;
let shownLoanDecisionId = 0;
let prevStatus = null;
let prevTurnPlayer = null;
let prevPhaseNum = 0;
let countdownDoneFor = null;
let displayedCash = null;
let cashAnim = null;
let bidAs = null;
let bankruptArmed = false;
const seenPositions = {};

// Reconnect session: a seat (room code + player id + token) survives a
// dropped socket, so a reconnected player resumes instead of becoming a
// stranger whose next intent fails with "Join a room first."
let myToken = null;
let hasSeat = false;
let sessionLive = false;
let rejoinPending = false;
const sendQueue = [];
function saveSeat() {
  try {
    if (myCode) {
      const fp = (state && myId != null) ? state.players.find((p) => p.id === myId) : null;
      const seat = { code: myCode, playerId: myId, token: myToken, spectator, name: fp ? fp.name : rememberedName() };
      sessionStorage.setItem('kolopolySeat', JSON.stringify(seat));
      // A localStorage twin (with a timestamp) lets a closed tab reclaim the
      // same seat later; the server token still has to match.
      localStorage.setItem('kolopolySeatLS', JSON.stringify(Object.assign({ ts: Date.now() }, seat)));
    } else {
      sessionStorage.removeItem('kolopolySeat');
      localStorage.removeItem('kolopolySeatLS');
    }
  } catch (e) { }
}
function clearSeat() {
  myCode = null; myId = null; myToken = null; hasSeat = false; spectator = false;
  try { sessionStorage.removeItem('kolopolySeat'); localStorage.removeItem('kolopolySeatLS'); } catch (e) { }
}
function loadSeat() {
  try {
    const s = JSON.parse(sessionStorage.getItem('kolopolySeat') || 'null');
    if (s && s.code) return s;
    const ls = JSON.parse(localStorage.getItem('kolopolySeatLS') || 'null');
    if (ls && ls.code && ls.ts && Date.now() - ls.ts < 6 * 60 * 60 * 1000) return ls;
  } catch (e) { }
  return null;
}
// Remember the player: one persistent id per device, plus the profile.
function makeClientId() {
  try {
    const id = localStorage.getItem('kolopolyClientId');
    if (id) return id;
    const fresh = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'kp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
    localStorage.setItem('kolopolyClientId', fresh);
    return fresh;
  } catch (e) { return null; }
}
const CLIENT_ID = makeClientId();
function rememberedName() { try { return localStorage.getItem('kolopolyName') || ''; } catch (e) { return ''; } }
function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { } }

// ---------------------------------------------------------------------------
// Sound: tiny WebAudio synth, no samples. Mute persists.
// ---------------------------------------------------------------------------
let audioCtx = null;
let busMain = null;    // important sounds: alerts, siren, gavel, horns
let busAmbient = null; // quiet texture: hop ticks, auction ticks; ducked by important sounds
let noiseBuf = null;
let muted = localStorage.getItem('kolopolyMute') === '1';
function audio() {
  if (muted) return null;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      busMain = audioCtx.createGain(); busMain.gain.value = 0.9; busMain.connect(audioCtx.destination);
      busAmbient = audioCtx.createGain(); busAmbient.gain.value = 0.8; busAmbient.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch (e) { return null; }
}
// Mix rule: the newest important sound ducks the ambient texture briefly.
function duckAmbient() {
  if (!audioCtx || !busAmbient) return;
  const t = audioCtx.currentTime;
  busAmbient.gain.cancelScheduledValues(t);
  busAmbient.gain.setValueAtTime(0.22, t);
  busAmbient.gain.linearRampToValueAtTime(0.8, t + 0.7);
}
function tone(o) {
  const ctx = audio(); if (!ctx) return;
  const t = ctx.currentTime + (o.at || 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.f, t);
  if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(30, o.f2), t + o.dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.vol || 0.08, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  osc.connect(g); g.connect(o.ambient ? busAmbient : busMain);
  osc.start(t); osc.stop(t + o.dur + 0.05);
}
function noiseHit(o) {
  const ctx = audio(); if (!ctx) return;
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = ctx.currentTime + (o.at || 0);
  const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = o.ftype || 'bandpass';
  f.frequency.setValueAtTime(o.freq || 1200, t);
  f.Q.value = o.q || 0.9;
  if (o.freq2) f.frequency.exponentialRampToValueAtTime(o.freq2, t + o.dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.vol || 0.05, t + (o.attack || 0.015));
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  src.connect(f); f.connect(g); g.connect(o.ambient ? busAmbient : busMain);
  src.start(t); src.stop(t + o.dur + 0.05);
}
const sfx = {
  // OPay style success: two bright tones up, tiny sparkle.
  credit() { duckAmbient(); tone({ f: 988, dur: 0.13, vol: 0.10 }); tone({ f: 1319, at: 0.09, dur: 0.26, vol: 0.10 }); tone({ f: 1976, at: 0.09, dur: 0.1, vol: 0.028 }); },
  // Calm low thud, no celebration.
  debit() { tone({ f: 170, f2: 92, dur: 0.2, vol: 0.12 }); noiseHit({ dur: 0.08, vol: 0.03, freq: 300, ftype: 'lowpass' }); },
  dice() { [0, 0.055, 0.12].forEach((at, i) => noiseHit({ at, dur: 0.035, vol: 0.045, freq: 1500 + i * 350, q: 1.4 })); tone({ f: 210, at: 0.12, dur: 0.07, type: 'triangle', vol: 0.05 }); },
  hop() { tone({ f: 1250, dur: 0.03, type: 'square', vol: 0.011, ambient: true }); },
  buy() { tone({ f: 1319, dur: 0.09, type: 'triangle', vol: 0.09 }); tone({ f: 1760, at: 0.07, dur: 0.17, type: 'triangle', vol: 0.09 }); noiseHit({ at: 0.02, dur: 0.05, vol: 0.02, freq: 3200, q: 2 }); },
  gavel() { duckAmbient(); tone({ f: 190, f2: 90, dur: 0.1, type: 'triangle', vol: 0.14 }); noiseHit({ dur: 0.05, vol: 0.06, freq: 900, ftype: 'lowpass' }); tone({ f: 190, f2: 90, at: 0.13, dur: 0.1, type: 'triangle', vol: 0.1 }); },
  auctionTick() { tone({ f: 1560, dur: 0.03, type: 'square', vol: 0.018, ambient: true }); },
  swish() { noiseHit({ dur: 0.28, vol: 0.05, freq: 750, freq2: 2600, q: 1.1 }); },
  build() { [0, 0.13, 0.26].forEach((at) => { noiseHit({ at, dur: 0.05, vol: 0.07, freq: 500, ftype: 'lowpass' }); tone({ f: 240, at, dur: 0.06, type: 'triangle', vol: 0.06 }); }); },
  stamp() { tone({ f: 130, f2: 60, dur: 0.16, vol: 0.14 }); noiseHit({ dur: 0.07, vol: 0.06, freq: 420, ftype: 'lowpass' }); },
  // Police siren first (the owner's order), then the cell clang.
  siren() { duckAmbient(); for (let i = 0; i < 7; i++) tone({ f: i % 2 ? 720 : 960, at: i * 0.17, dur: 0.17, type: 'triangle', vol: 0.05 }); this.clang(1.26); },
  clang(at) { tone({ f: 1400, at: at || 0, dur: 0.3, type: 'square', vol: 0.032 }); tone({ f: 220, at: (at || 0) + 0.02, dur: 0.4, type: 'triangle', vol: 0.08 }); },
  // Up NEPA: crowd murmur swell under the bright return notes.
  chime() { noiseHit({ dur: 0.9, vol: 0.04, freq: 480, ftype: 'lowpass', attack: 0.3 }); tone({ f: 880, at: 0.05, dur: 0.14, vol: 0.07 }); tone({ f: 1174, at: 0.16, dur: 0.2, vol: 0.07 }); },
  horn() { tone({ f: 185, dur: 0.16, type: 'sawtooth', vol: 0.06 }); tone({ f: 185, at: 0.22, dur: 0.2, type: 'sawtooth', vol: 0.06 }); },
  cheer() { noiseHit({ dur: 1.1, vol: 0.045, freq: 900, freq2: 1400, q: 0.6, attack: 0.25 }); tone({ f: 659, at: 0.1, dur: 0.12, vol: 0.05 }); tone({ f: 784, at: 0.22, dur: 0.12, vol: 0.05 }); tone({ f: 988, at: 0.34, dur: 0.22, vol: 0.05 }); },
  phaseLetter() { tone({ f: 180, f2: 90, dur: 0.09, type: 'triangle', vol: 0.1 }); noiseHit({ at: 0.05, dur: 0.25, vol: 0.04, freq: 900, freq2: 2200 }); },
  newsSting() { duckAmbient(); [523, 659, 784].forEach((f, i) => tone({ f, at: i * 0.09, dur: 0.16, type: 'sawtooth', vol: 0.04 })); noiseHit({ at: 0.27, dur: 0.2, vol: 0.04, freq: 2400, q: 1.5 }); },
  phase() { tone({ f: 392, dur: 0.16, type: 'triangle', vol: 0.09 }); tone({ f: 523, at: 0.13, dur: 0.16, type: 'triangle', vol: 0.09 }); tone({ f: 659, at: 0.26, dur: 0.24, type: 'triangle', vol: 0.09 }); }
};
window.KPSfxHop = () => sfx.hop();
function renderMuteBtn() { $('muteBtn').innerHTML = window.icon(muted ? 'mute' : 'sound', 20); }
$('muteBtn').addEventListener('click', () => { muted = !muted; localStorage.setItem('kolopolyMute', muted ? '1' : '0'); renderMuteBtn(); if (!muted) sfx.credit(); });
renderMuteBtn();

// ---------------------------------------------------------------------------
// Toasts, alerts (the phone style money cards), spray, flicker
// ---------------------------------------------------------------------------
let toastTimer = null;
const toastQueue = [];
let toastShowing = false;
// Toasts queue: a second toast never kills the first early. Ordinary toasts
// hold 4.5s; big moments pass 5000+. Tapping a toast dismisses it.
function toast(html, ms) {
  toastQueue.push({ html, ms: ms || 4500 });
  if (toastQueue.length > 3) toastQueue.splice(0, toastQueue.length - 3);
  pumpToast();
}
function pumpToast() {
  if (toastShowing || !toastQueue.length) return;
  toastShowing = true;
  const item = toastQueue.shift();
  const t = $('toast');
  t.innerHTML = item.html;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, item.ms);
}
function dismissToast() {
  clearTimeout(toastTimer);
  $('toast').classList.remove('show');
  toastShowing = false;
  setTimeout(pumpToast, 180);
}
$('toast').addEventListener('click', dismissToast);
const alertQueue = [];
let alertBusy = false;
function queueAlert(kind, amount, text, balanceAfter) {
  alertQueue.push({ kind, amount, text, balanceAfter });
  if (alertQueue.length > 3) alertQueue.splice(0, alertQueue.length - 3);
  pumpAlerts();
}
const SUCC_SVG = '<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="succ-c" cx="26" cy="26" r="23" fill="none"/><path class="succ-k" fill="none" d="M14.5 27.5l7.5 7.5L37.5 19"/></svg>';
function pumpAlerts() {
  if (alertBusy || !alertQueue.length) return;
  alertBusy = true;
  const a = alertQueue.shift();
  const isCredit = a.kind === 'credit';
  const el = document.createElement('div');
  el.className = 'alert-card ' + a.kind;
  el.innerHTML =
    '<div class="alert-bank"><span class="alert-logo">' + window.icon('bank', 14) + '</span>' +
    '<span class="alert-bank-name">KOLOPOLY ALERT</span>' +
    '<span class="alert-pill">' + (isCredit ? 'CREDIT' : 'DEBIT') + '</span></div>' +
    (isCredit ? '<div class="alert-success"><span class="succ-ring">' + SUCC_SVG + '</span><span class="succ-text">Payment received</span></div>' : '') +
    '<div class="amt">' + (isCredit ? '+' : '-') + fmtN(a.amount) + '</div>' +
    '<div class="why">' + esc(a.text) + '</div>' +
    (a.balanceAfter != null ? '<div class="bal">Balance: ' + fmtN(a.balanceAfter) + '</div>' : '');
  $('alerts').appendChild(el);
  if (isCredit) sfx.credit(); else sfx.debit();
  if (isCredit && a.amount >= 750000) buzz(90); // the biggest hits only
  const hold = isCredit ? 3200 : 2600; // alerts dwell ~2.8s; credits a beat longer, OPay style
  setTimeout(() => { el.classList.add('out'); setTimeout(() => { el.remove(); alertBusy = false; pumpAlerts(); }, 260); }, hold);
}
function spray() {
  for (let k = 0; k < 14; k++) {
    const n = document.createElement('div');
    n.className = 'spray-note';
    n.textContent = ['₦50,000', '₦20,000', '₦10,000', '₦5,000'][k % 4];
    n.style.left = (6 + Math.random() * 84) + 'vw';
    n.style.top = (4 + Math.random() * 10) + 'vh';
    n.style.animationDelay = (Math.random() * 0.5) + 's';
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 2400);
  }
}
function nepaFlicker() {
  const f = $('flicker');
  f.classList.remove('go');
  void f.offsetWidth;
  f.classList.add('go');
  sfx.chime();
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);
  ws.onopen = () => {
    // Resume the seat on every (re)connect: this is what makes a dropped
    // socket a brief pause instead of a stranger session mid-game. An invite
    // link for a different room wins over the stored seat.
    const seat = loadSeat();
    const invite = new URLSearchParams(location.search).get('join');
    const inviteWins = invite && seat && invite.trim().toUpperCase().slice(0, 4) !== seat.code;
    // A seat saved under a different display name belongs to a different
    // person on this device: never auto-resume into their game.
    const seatStale = seat && seat.name && rememberedName() && seat.name !== rememberedName();
    if (seat && seat.code && !inviteWins && !seatStale) {
      myCode = seat.code; myId = seat.playerId; myToken = seat.token; spectator = !!seat.spectator; hasSeat = true;
      rejoinPending = true;
      ws.send(JSON.stringify({ type: 'rejoin', code: seat.code, playerId: seat.playerId, token: seat.token, spectator: seat.spectator }));
    }
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'joined') {
      myId = msg.playerId;
      myCode = msg.code;
      if (msg.token) myToken = msg.token;
      spectator = !!msg.spectator;
      hasSeat = true;
      sessionLive = true;
      rejoinPending = false;
      entrySent = true;
      saveSeat();
      flushQueue();
      return;
    }
    if (msg.type === 'rejoin_failed') {
      rejoinPending = false;
      clearSeat();
      try { sessionStorage.setItem('kolopolyRoomGone', '1'); } catch (e) { }
      location.reload();
      return;
    }
    if (msg.type === 'error') {
      // A bound seat can never be told to join a room: that error only makes
      // sense on the landing screen before any room exists.
      if (msg.message === 'Join a room first.' && (state || hasSeat)) return;
      toast(esc(msg.message)); return;
    }
    if (msg.type === 'notice') { toast(esc(msg.message), 5200); return; }
    if (msg.type === 'state') {
      if (!sessionLive) { sessionLive = true; flushQueue(); }
      onState(msg.room); return;
    }
  };
  ws.onclose = (ev) => {
    sessionLive = false;
    if (ev && ev.code === 4001) {
      // The seat was taken by a newer tab or window on purpose: sign this
      // one out of the game instead of fighting over the seat.
      clearSeat();
      entrySent = false;
      showView('view-landing');
      toast('Your seat don open for another tab or window. This one don sign out.', 5200);
      return;
    }
    setTimeout(connect, 2500);
  };
}
function flushQueue() {
  while (sendQueue.length && ws && ws.readyState === 1) {
    const m = sendQueue.shift();
    ws.send(JSON.stringify(Object.assign({ type: m.type }, m.obj || {})));
  }
}
function send(type, obj) {
  if (!ws || ws.readyState !== 1) return;
  // While a rejoin is in flight the socket is open but unbound: queue the
  // intent instead of firing it at a session that has no room yet.
  if (!sessionLive && hasSeat && type !== 'rejoin') {
    if (sendQueue.length < 12) sendQueue.push({ type, obj });
    return;
  }
  ws.send(JSON.stringify(Object.assign({ type }, obj || {})));
}
window.__kolopolySend = send;
window.__kolopolyState = () => state;
window.__kolopolyDrop = () => { if (ws) ws.close(); };
window.__kolopolySession = () => ({ live: sessionLive, hasSeat, code: myCode, id: myId, queued: sendQueue.length });
try {
  if (sessionStorage.getItem('kolopolyRoomGone')) {
    sessionStorage.removeItem('kolopolyRoomGone');
    setTimeout(() => toast('Your room don close. Start a fresh one.'), 500);
  }
} catch (e) { }

// ---------------------------------------------------------------------------
// Entry: name, tokens, mode pickers, invite
// ---------------------------------------------------------------------------
function buildTokenPickers() {
  $('heroTokens').innerHTML = window.KP_DATA.TOKENS.map((t) => '<span title="' + esc(t.name) + '">' + window.tokenArt(t.id, 38) + '</span>').join('');
  $('tokenGrid').innerHTML = window.KP_DATA.TOKENS.map((t) =>
    '<button type="button" class="token-pick' + (t.id === selectedToken ? ' sel' : '') + '" data-token="' + t.id + '">' + window.tokenArt(t.id, 44) + '<span>' + esc(t.name) + '</span></button>').join('');
  $('tokenGrid').querySelectorAll('[data-token]').forEach((b) => b.addEventListener('click', () => {
    selectedToken = b.dataset.token;
    try { localStorage.setItem('kolopolyToken', selectedToken); } catch (e) { }
    $('tokenGrid').querySelectorAll('[data-token]').forEach((x) => x.classList.toggle('sel', x === b));
  }));
}
buildTokenPickers();
$('nameIn').value = localStorage.getItem('kolopolyName') || '';
$('nameIn').addEventListener('change', () => localStorage.setItem('kolopolyName', $('nameIn').value.trim()));
$('gameModeRow').querySelectorAll('[data-gmode]').forEach((b) => b.addEventListener('click', () => {
  selectedGameMode = b.dataset.gmode;
  $('gameModeRow').querySelectorAll('[data-gmode]').forEach((x) => x.classList.toggle('sel', x === b));
  $('presetRow').classList.toggle('hidden', selectedGameMode !== 'inflation');
}));
$('roomModeRow').querySelectorAll('[data-rmode]').forEach((b) => b.addEventListener('click', () => {
  selectedRoomMode = b.dataset.rmode;
  $('roomModeRow').querySelectorAll('[data-rmode]').forEach((x) => x.classList.toggle('sel', x === b));
}));
function myName() { return $('nameIn').value.trim(); }
function needName() { if (!myName()) { toast('Type your display name first.'); $('nameIn').focus(); return false; } localStorage.setItem('kolopolyName', myName()); return true; }

$('createBtn').addEventListener('click', () => {
  if (!needName() || entrySent) return;
  clearSeat(); // a fresh entry choice abandons any stored seat
  entrySent = true;
  send('create_room', {
    name: myName(), token: selectedToken, clientId: CLIENT_ID, mode: selectedRoomMode,
    settings: {
      gameMode: selectedGameMode,
      preset: $('presetSel').value,
      timed: $('optTimed').checked,
      doubleStart: $('optDoubleStart').checked,
      noRentInJail: $('optNoRentJail').checked,
      firstLapNoBuy: $('optFirstLap').checked,
      chaos: $('optChaos').checked,
      turnTimerSec: Number($('optTimer').value)
    }
  });
});
$('quickBtn').addEventListener('click', () => {
  if (!needName() || entrySent) return;
  clearSeat();
  entrySent = true;
  send('quick_join', { name: myName(), token: selectedToken, clientId: CLIENT_ID });
});
let joinSentFor = null;
function tryJoin(code) {
  code = (code || '').trim().toUpperCase();
  if (code.length !== 4 || !needName()) return;
  if (entrySent && joinSentFor === code) return;
  clearSeat();
  entrySent = true;
  joinSentFor = code;
  send('join_room', { code, name: myName(), token: selectedToken, clientId: CLIENT_ID });
}
$('joinBtn').addEventListener('click', () => tryJoin($('codeIn').value));
$('codeIn').addEventListener('input', () => { if ($('codeIn').value.trim().length === 4) tryJoin($('codeIn').value); });

const inviteCode = new URLSearchParams(location.search).get('join');
function tokenArtFor(id) {
  const t = window.KP_DATA.TOKENS.find((x) => x.id === id) || window.KP_DATA.TOKENS[0];
  return window.tokenArt(t.id, 40);
}
function revealForm(focusId) {
  $('joinCard').classList.remove('hidden');
  $('welcomeCard').classList.add('hidden');
  if (focusId) { const el = $(focusId); if (el) el.focus(); }
}
// Welcome back: a remembered player acts first; editing is one tap away,
// never a fresh form by default.
(function setupWelcome() {
  const name = rememberedName();
  if (!name || inviteCode) return;
  $('welcomeTitle').textContent = 'Welcome back, ' + name;
  $('welcomeToken').innerHTML = tokenArtFor(selectedToken);
  $('welcomeSub').textContent = 'Your token and settings dey as you leave am. Create a room, quick play, or join with a code.';
  $('welcomeCard').classList.remove('hidden');
  $('joinCard').classList.add('hidden');
  $('welcomeCreate').addEventListener('click', () => { $('nameIn').value = name; $('createBtn').click(); });
  $('welcomeQuick').addEventListener('click', () => { $('nameIn').value = name; $('quickBtn').click(); });
  $('welcomeJoinCode').addEventListener('click', () => revealForm('codeIn'));
  $('welcomeChange').addEventListener('click', () => revealForm('nameIn'));
})();
// Invite link: one compact prompt, one tap into the lobby.
let inviteInfo = null;
if (inviteCode) {
  const code = inviteCode.trim().toUpperCase().slice(0, 4);
  $('codeIn').value = code;
  $('inviteBanner').classList.add('show');
  const name = rememberedName();
  $('inviteTitle').textContent = 'You were invited to room ' + code;
  $('inviteToken').innerHTML = tokenArtFor(selectedToken);
  if (name) {
    $('joinCard').classList.add('hidden');
    $('inviteAs').textContent = 'Join as ' + name;
  } else {
    $('inviteAs').textContent = 'Type your name below, then join.';
  }
  $('inviteMeta').textContent = 'Checking the room...';
  history.replaceState(null, '', location.pathname);
  fetch('/api/room/' + code).then((r) => r.json()).then((info) => {
    inviteInfo = info;
    if (!info.exists) {
      $('inviteTitle').textContent = 'That room don close.';
      $('inviteMeta').textContent = 'The link don expire, or the game don finish.';
      $('inviteJoinBtn').textContent = 'Start fresh instead';
      return;
    }
    $('inviteTitle').textContent = (info.hostName ? info.hostName + "'s room" : 'Room ' + code) + ' · ' + code;
    $('inviteMeta').textContent = info.players + (info.players === 1 ? ' player' : ' players') + ' inside · ' + (info.status === 'lobby' ? 'waiting in the lobby' : 'game don start: watch, or reclaim your seat if you been dey inside');
    if (info.full) {
      $('inviteMeta').textContent = 'That room don full: 6 players dey inside.';
      $('inviteJoinBtn').textContent = 'Start fresh instead';
    }
  }).catch(() => { $('inviteMeta').textContent = 'Room ' + code + '. Join when you ready.'; });
  $('inviteJoinBtn').addEventListener('click', () => {
    if (inviteInfo && (!inviteInfo.exists || inviteInfo.full)) { location.href = location.pathname; return; }
    if (!name) { revealForm('nameIn'); return; }
    if (entrySent) return;
    clearSeat();
    entrySent = true;
    joinSentFor = code;
    send('join_room', { code, name, token: selectedToken, clientId: CLIENT_ID });
  });
  $('inviteChangeBtn').addEventListener('click', () => revealForm('nameIn'));
}

// ---------------------------------------------------------------------------
// State rendering
// ---------------------------------------------------------------------------
function showView(id) {
  for (const v of ['view-landing', 'view-lobby', 'view-game']) $(v).classList.toggle('active', v === id);
}
function focusPlayer() {
  if (!state) return null;
  if (state.mode === 'pass') return state.players.find((p) => p.id === state.turnPlayerId) || state.players[0];
  return state.players.find((p) => p.id === myId) || null;
}
function actingId() {
  if (!state) return null;
  if (state.mode === 'pass') return state.turnPlayerId;
  return myId;
}
function sendAs(type, obj) {
  const o = Object.assign({}, obj || {});
  if (state && state.mode === 'pass') o.as = o.as != null ? o.as : actingId();
  send(type, o);
}
function byId(id) { return state ? state.players.find((p) => p.id === id) : null; }

function onState(room) {
  const prev = state;
  state = room;
  const meNow = room.players.find((p) => p.id === myId);
  if (meNow && meNow.token) { try { localStorage.setItem('kolopolyToken', meNow.token); } catch (e) { } }
  if (prev && prev.auction && !room.auction && room.status === 'playing') sfx.gavel();
  if (!prev || prev.status !== room.status) {
    if (room.status === 'lobby') showView('view-lobby');
    else if (room.status === 'countdown' || room.status === 'playing' || room.status === 'ended') {
      showView('view-game');
      if (room.status === 'countdown' && countdownDoneFor !== room.code + ':' + (room.startedKey || '')) {
        countdownDoneFor = room.code + ':' + (room.startedKey || '');
        runCountdown();
      }
    }
  }
  $('roomChip').classList.toggle('hidden', !room.code);
  $('roomChip').textContent = room.code ? 'Room ' + room.code : '';
  processFeed(room, prev);
  processPositions(room);
  if (room.status === 'lobby') renderLobby(room);
  if (room.status === 'playing' || room.status === 'ended' || room.status === 'countdown') renderGame(room);
  if (room.status === 'ended') renderEnd(room);
  prevStatus = room.status;
}

function processFeed(room, prev) {
  const feed = room.feed || [];
  if (!feedPrimed) {
    lastFeedSeq = feed.length ? feed[feed.length - 1].seq : 0;
    feedPrimed = true;
    if (room.lastCard) lastCardSeq = room.lastCard.seq || 0;
    prevPhaseNum = room.inf ? room.inf.phase : 0;
    return;
  }
  const focusIds = room.mode === 'pass' ? room.players.map((p) => p.id) : [myId];
  for (const e of feed) {
    if (e.seq <= lastFeedSeq) continue;
    lastFeedSeq = e.seq;
    if ((e.kind === 'credit' || e.kind === 'debit') && focusIds.includes(e.playerId)) {
      const p = room.players.find((x) => x.id === e.playerId);
      queueAlert(e.kind, e.amount, e.text, p ? p.cash : null);
    }
    if (e.kind === 'kirikiri') { sfx.siren(); buzz([70, 50, 70]); }
    if (e.kind === 'timeout') toast(esc(e.text), 5200);
    if (e.kind === 'jackpot' && e.amount >= 100000) {
      spray();
      sfx.cheer();
      buzz(120);
      const winner = room.players.find((x) => x.id === e.playerId);
      if (focusIds.includes(e.playerId)) {
        setTimeout(() => openShare('jackpot', { name: winner ? winner.name : 'A landlord', amount: e.amount, line: 'collect the full Owambe pot for room ' + room.code + '. Spray am for everybody.', code: room.code }), 900);
      }
    }
    if (e.kind === 'deedBig') {
      const buyer = room.players.find((x) => x.id === e.playerId);
      if (focusIds.includes(e.playerId)) {
        setTimeout(() => openShare('landlord', { name: buyer ? buyer.name : 'A landlord', amount: e.amount, line: 'don buy Banana Island. LANDLORD level don change for this table.', code: room.code }), 900);
      }
    }
    if (e.kind === 'kirikiri' && e.trips === 2) {
      const p = room.players.find((x) => x.id === e.playerId);
      if (focusIds.includes(e.playerId)) {
        setTimeout(() => openShare('kirikiri', { name: p ? p.name : 'A guest', amount: null, line: 'don check into Kirikiri for the second time this game. Frequent guest levels.', code: room.code }), 900);
      }
    }
    if (e.kind === 'phase') {
      // Phase 2 arrives as the landlord's letter (knock + paper), Phase 3
      // breaks like a news sting, the rest keep the rising tones.
      if (room.inf && room.inf.phase === 2) sfx.phaseLetter();
      else if (room.inf && room.inf.phase === 3) sfx.newsSting();
      else sfx.phase();
      showPhaseCeremony(room, e);
    }
  }
  if (room.lastCard && room.lastCard.seq !== lastCardSeq) {
    lastCardSeq = room.lastCard.seq;
    const drawer = room.lastCard.playerId;
    if (room.mode === 'pass' || drawer === myId) showCardModal(room.lastCard);
  }
  if (room.dice && prev && room.dice !== prev.dice && room.status === 'playing') {
    sfx.dice();
    if (room.dice[0] === room.dice[1]) sfx.horn();
  }
}
function processPositions(room) {
  for (const p of room.players) {
    if (seenPositions[p.id] !== undefined && seenPositions[p.id] !== p.position && p.position === 12) nepaFlicker();
    seenPositions[p.id] = p.position;
  }
}
function showPhaseCeremony(room, entry) {
  const inf = room.inf;
  if (!inf) return;
  const o = $('phaseOverlay');
  const PW = [50, 100, 200, 500][inf.phase - 1];
  let inner;
  if (inf.phase === 2) {
    // The landlord's rent increase letter (lessons doc, Upgrade 1).
    inner = '<div class="ceremony ceremony-letter">' +
      '<p class="lhead">From the Office of Your Landlord</p>' +
      '<p>Dear Tenant,</p>' +
      '<p style="margin-top:10px;">This is to inform you that your rent has been reviewed upward with immediate effect. Market forces no gree anybody, and cement no dey wait.</p>' +
      '<p style="margin-top:10px;">Salary don drop to <b>' + fmtN(inf.salary) + '</b>. Rent now na printed rent x your lowest die, and building cost follow the same dice. Pure water don reach <b>₦' + PW + '</b>.</p>' +
      '<p class="lsign">Signed,<br><b>Your Landlord</b></p>' +
      '<p class="lfoot">Na the year wey fees jump from ₦45,000 to ₦100,000 be this.</p></div>';
  } else if (inf.phase === 3) {
    // Breaking news in the May 2023 mould, with the real figures.
    inner = '<div class="ceremony ceremony-news"><div class="newsbar">BREAKING NEWS</div>' +
      '<div class="newsbody"><p class="newsline">Subsidy don go. Fuel: ₦185 don turn ₦488.</p>' +
      '<p style="margin-top:10px;">' + esc(entry.text) + '</p>' +
      '<p style="margin-top:10px;">Salary na <b>' + fmtN(inf.salary) + '</b> now. Rent and land price na printed x your bigger die. Pure water don reach <b>₦' + PW + '</b>. If e no dey for contract board, e no happen.</p></div></div>';
  } else if (inf.phase === 4) {
    inner = '<div class="ceremony ceremony-notice"><div class="nhead">FINAL NOTICE</div>' +
      '<p>' + esc(room.message || entry.text) + '</p>' +
      '<p style="margin-top:10px;">Pure water don reach <b>₦' + PW + '</b>. No new contracts. The horn go decide am on net worth, and the Real Table go talk the rest for the end screen.</p></div>';
  } else {
    inner = '<div class="phase-ceremony"><div class="big">PHASE ' + inf.phase + '</div><p class="lead">' + esc(entry.text) + '</p></div>';
  }
  o.innerHTML = inner;
  o.classList.add('show');
  setTimeout(() => o.classList.remove('show'), 3400);
}
function runCountdown() {
  const o = $('countOverlay');
  const num = $('countNum');
  o.classList.add('show');
  let n = 3;
  num.textContent = n;
  const iv = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      clearInterval(iv);
      num.textContent = 'GO';
      setTimeout(() => o.classList.remove('show'), 450);
    } else {
      num.textContent = n;
      num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
    }
  }, 620);
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
let qrForCode = null;
function inviteLink() { return location.origin + '/?join=' + state.code; }
function renderLobby(room) {
  $('lobbyCode').textContent = room.code;
  const modeLine = room.settings.gameMode === 'inflation'
    ? 'Inflation Mode · ' + ({ quick: 'Quick Bite', standard: 'Standard', fullnight: 'Full Night' }[room.settings.preset] || 'Standard') + ' preset'
    : 'Classic Mode';
  $('lobbyModeLine').textContent = modeLine + (room.mode === 'pass' ? ' · This phone (pass and play)' : room.isPublic ? ' · Public quick room' : ' · Private room');
  $('copyInviteBtn').innerHTML = window.icon('copy', 16) + ' Copy invite';
  $('shareInviteBtn').innerHTML = window.icon('share', 16) + ' Share';
  if (typeof qrcode === 'function' && qrForCode !== room.code) {
    qrForCode = room.code;
    let svg = '';
    for (let t = 4; t <= 14 && !svg; t++) {
      try { const qr = qrcode(t, 'M'); qr.addData(inviteLink()); qr.make(); svg = qr.createSvgTag({ cellSize: 3, margin: 6, scalable: true }); } catch (e) { svg = ''; }
    }
    $('inviteQr').innerHTML = svg;
  }
  $('slotBoard').innerHTML = Array.from({ length: 6 }, (_, k) => {
    const p = room.players[k];
    if (!p) return '<div class="slot empty">Waiting for player…</div>';
    return '<div class="slot"><div class="avatar" style="background:' + p.color + '">' + window.icon(p.token, 22) + '</div>' +
      '<div><div class="nm">' + esc(p.name) + (p.isHost ? ' ' + window.icon('crown', 14) : '') + '</div>' +
      '<div class="meta">' + (room.mode === 'pass' ? 'On this phone' : p.connected ? 'Connected' : 'Disconnected') + '</div></div>' +
      (room.mode === 'pass' && myId === room.hostId && p.id !== room.hostId ? '<button class="btn small ghost" data-remove-local="' + p.id + '" style="margin-left:auto;">Remove</button>' : '') + '</div>';
  }).join('');
  $('slotBoard').querySelectorAll('[data-remove-local]').forEach((b) => b.addEventListener('click', () => send('remove_local_player', { playerId: Number(b.dataset.removeLocal) })));
  $('passAddBox').classList.toggle('hidden', room.mode !== 'pass');
  const chips = [];
  if (room.settings.gameMode === 'inflation') chips.push('Phases: salary ₦200,000 → ₦100,000 → ₦50,000 → ₦25,000');
  else chips.push(room.settings.timed ? 'Timed: 60 minutes' : 'Untimed: last landlord standing');
  if (room.settings.doubleStart) chips.push('Double salary on exact START landing');
  if (room.settings.noRentInJail) chips.push('No rent while in Kirikiri');
  if (room.settings.firstLapNoBuy) chips.push('First lap: no buying');
  chips.push('Turn timer: ' + (room.settings.turnTimerSec ? room.settings.turnTimerSec + 's' : 'off'));
  $('lobbySettings').innerHTML = chips.map((c) => '<span class="chip">' + esc(c) + '</span>').join('');
  $('chaosNote').textContent = room.settings.chaos
    ? 'CHAOS MODE ON: one seat go be Nepo (+₦500,000 and a free deed), one seat go be Lapo (₦1,000,000 start, first rent forgiven). Seats are picked when the game starts, nobody is ambushed after.'
    : '';
  const isHost = myId === room.hostId;
  $('startBtn').style.display = isHost || room.mode === 'pass' ? '' : 'none';
  $('startBtn').disabled = room.players.length < 2;
  $('startBtn').innerHTML = window.icon('play', 18) + ' Start game (' + room.players.length + ' players)';
  $('lobbyHint').textContent = room.players.length < 2
    ? 'You need at least 2 players. Share the code make your people join.'
    : isHost ? 'Everybody don enter? Start when ready.' : 'Waiting for the host to start the game.';
}
$('copyInviteBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(inviteLink()); toast('Invite link copied. Send am give your people.'); }
  catch { toast('Copy no work. The link na: ' + inviteLink(), 6000); }
});
$('shareInviteBtn').addEventListener('click', async () => {
  const data = { title: 'KOLOPOLY', text: 'Join my Kolopoly room ' + state.code + '. Lagos property wahala, bring your A game.', url: inviteLink() };
  if (navigator.share) { try { await navigator.share(data); } catch { /* user closed */ } }
  else { try { await navigator.clipboard.writeText(inviteLink()); toast('Invite link copied.'); } catch { toast(inviteLink(), 6000); } }
});
$('addLocalBtn').addEventListener('click', () => {
  const name = $('localNameIn').value.trim();
  if (!name) { toast('Type the player name first.'); return; }
  send('add_local_player', { name, token: selectedToken });
  $('localNameIn').value = '';
});
$('startBtn').addEventListener('click', () => send('start_game', {}));
$('leaveLobbyBtn').addEventListener('click', () => { send('leave', {}); clearSeat(); setTimeout(() => location.reload(), 250); });

// ---------------------------------------------------------------------------
// Game rendering
// ---------------------------------------------------------------------------
window.KPBoard.build($('board'));
window.KPBoard.onSpaceTap = (i) => onSpaceTap(i);
$('fullBoardBtn').innerHTML = window.icon('eye', 15) + ' <span>Full board</span>';
function syncViewBtn() {
  const span = $('fullBoardBtn').querySelector('span');
  if (span) span.textContent = window.KPBoard.effectiveFull() ? 'Follow token' : 'Full board';
}
$('fullBoardBtn').addEventListener('click', () => {
  window.KPBoard.toggleView();
  syncViewBtn();
  if (state) window.KPBoard.applyCamera(state);
});
syncViewBtn();
window.addEventListener('resize', syncViewBtn);
$('rotateHint').innerHTML = window.icon('rotate', 15) + ' Rotate your phone for the full board';
$('denomRow').innerHTML = window.KP_DATA.DENOMS.map((d) => '<span class="denom">' + fmtN(d) + '</span>').join('');

function onSpaceTap(i) {
  if (!state || state.status !== 'playing') return;
  if (state.buildPlace && state.buildPlace.playerId === actingId()) {
    const kind = state.buildPlace.kind;
    if (window.KPBoard.canBuildHere(state, actingId(), i, kind)) {
      sendAs('build_place', { space: i, as: state.buildPlace.playerId });
      return;
    }
    toast('That ' + kind + ' no fit land there. Pick a highlighted street in the set.');
    return;
  }
  const pr = state.props[i];
  const viewer = state.mode === 'pass' ? (pr && pr.o != null ? pr.o : state.turnPlayerId) : myId;
  $('deedSheet').innerHTML = window.KPBoard.deedHTML(i, state, viewer);
  $('deedScrim').classList.add('show');
  if (window.KP3D) window.KP3D.showDeedCard(i);
  wireSheetButtons($('deedSheet'), viewer);
}
function closeScrim(id) { $(id).classList.remove('show'); }
document.querySelectorAll('.scrim').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s && s.id !== 'choiceScrim') s.classList.remove('show'); }));
function wireSheetButtons(root, viewer) {
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { root.closest('.scrim').classList.remove('show'); }));
  root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const space = Number(b.dataset.space);
    const as = state.mode === 'pass' ? viewer : undefined;
    const sendAct = (type, obj) => { const o = Object.assign({}, obj || {}); if (as != null) o.as = as; send(type, o); };
    if (b.dataset.act === 'build-duplex') { sfx.build(); sendAct('build', { space, kind: 'duplex' }); }
    if (b.dataset.act === 'build-mansion') { sfx.build(); sendAct('build', { space, kind: 'mansion' }); }
    if (b.dataset.act === 'sell-building') sendAct('sell_building', { space });
    if (b.dataset.act === 'mortgage') { sfx.stamp(); sendAct('mortgage', { space }); }
    if (b.dataset.act === 'unmortgage') { sfx.stamp(); sendAct('unmortgage', { space }); }
    setTimeout(() => root.closest('.scrim').classList.remove('show'), 120);
  }));
}

function renderGame(room) {
  // Inflation bar
  const infBar = $('infBar');
  if (room.inf) {
    infBar.classList.remove('hidden');
    infBar.innerHTML = '<span class="ph">Phase ' + room.inf.phase + ': ' + esc(room.inf.phaseName) + '</span>' +
      '<span class="idx">Index ' + room.inf.index + 'x</span>' +
      '<span class="water-chip">Pure water ₦' + [50, 100, 200, 500][room.inf.phase - 1] + '</span>' +
      '<span>Salary ' + fmtN(room.inf.salary) + '</span>' +
      '<span class="clk" id="infClock"></span>' +
      '<button id="dealBreakBtn">' + window.icon('clock', 14) + ' Deal Break</button>' +
      '<button id="contractsBtn">' + window.icon('card', 14) + ' Contracts (' + room.inf.contracts.length + ')</button>' +
      '<span class="infbar-note">Pure water na the gauge: one sachet start from ₦50 these days, and na im price dey tell us how market don be. The Index na the maths; the sachet na the memory.</span>';
    $('dealBreakBtn').addEventListener('click', () => sendAs('call_deal_break', {}));
    $('contractsBtn').addEventListener('click', () => openContracts());
  } else {
    infBar.classList.add('hidden');
  }
  $('msgText').textContent = room.message || '';
  // Players strip
  $('playersStrip').innerHTML = room.players.map((p) => {
    const loanMark = room.inf && room.inf.contracts.some((c) => c.type === 'loan' && c.borrower === p.id) ? ' · loan' : '';
    return '<div class="pchip' + (p.id === room.turnPlayerId ? ' turn' : '') + (p.bankrupt ? ' bankrupt' : '') + (p.inJail ? ' jailed' : '') + '">' +
      '<span class="avatar" style="background:' + p.color + '">' + window.icon(p.token, 15) + '</span>' +
      '<span><span class="nm">' + esc(p.name) + (p.chaosRole ? ' (' + p.chaosRole + ')' : '') + '</span><br>' +
      '<span class="cash">' + fmtN(p.cash) + '</span><span class="meta"> · ' + p.deeds + ' deeds' + loanMark + '</span></span></div>';
  }).join('');
  // Board legal highlights for build placement
  if (room.buildPlace && room.buildPlace.playerId === actingId()) {
    const set = new Set();
    for (let i = 0; i < 40; i++) if (window.KPBoard.canBuildHere(room, actingId(), i, room.buildPlace.kind)) set.add(i);
    window.KPBoard.legalSet = set;
  } else window.KPBoard.legalSet = null;
  window.KPBoard.render(room);
  renderWallet(room);
  renderActionBar(room);
  renderAuction(room);
  maybeShowModals(room);
  // Pass and play banner on turn change
  if (room.mode === 'pass' && prevTurnPlayer !== null && prevTurnPlayer !== room.turnPlayerId && room.status === 'playing') {
    const np = byId(room.turnPlayerId);
    const b = $('passBanner');
    b.textContent = 'Pass the phone to ' + (np ? np.name : 'the next player');
    b.classList.add('show');
    setTimeout(() => b.classList.remove('show'), 2100);
  }
  prevTurnPlayer = room.turnPlayerId;
}

function renderWallet(room) {
  const fp = focusPlayer();
  if (!fp) { $('walletCash').textContent = 'Spectating'; $('walletLabel').textContent = 'YOU DEY WATCH'; return; }
  $('walletLabel').textContent = (room.mode === 'pass' ? esc(fp.name).toUpperCase() + "'S CASH" : 'YOUR CASH');
  const target = fp.cash;
  if (displayedCash === null || Math.abs(target - displayedCash) < 1) {
    displayedCash = target;
    $('walletCash').textContent = fmtN(target);
  } else {
    const from = displayedCash;
    const start = performance.now();
    if (cashAnim) cancelAnimationFrame(cashAnim);
    const stepFn = (t) => {
      const k = Math.min(1, (t - start) / 550);
      displayedCash = Math.round(from + (target - from) * k);
      $('walletCash').textContent = fmtN(displayedCash);
      if (k < 1) cashAnim = requestAnimationFrame(stepFn);
    };
    cashAnim = requestAnimationFrame(stepFn);
  }
  const sapaSlot = $('sapaSlot');
  if (fp.sapa && fp.sapa.warn) {
    sapaSlot.innerHTML = '<div class="sapa-warn">' + window.icon('alert', 15) + ' Sapa dey near: one bad landing fit cost you ' + fmtN(fp.sapa.exposure) + '. Buy a Pass or arrange a loan before you roll.</div>';
  } else sapaSlot.innerHTML = '';
  // The portrait rail clears the fixed wallet bar by its real height, so
  // nothing hides behind it when the auction card or sapa warning grows it.
  const wb = document.querySelector('.walletbar');
  if (wb) document.documentElement.style.setProperty('--wallet-h', wb.offsetHeight + 'px');
}

function timerSpan(deadline) {
  if (!deadline) return '';
  const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  return ' <span class="turn-timer" data-deadline="' + deadline + '">' + s + 's</span>';
}
function renderActionBar(room) {
  const bar = $('actionBar');
  const sec = $('secondaryBar');
  const A = actingId();
  const me = byId(A);
  const turn = byId(room.turnPlayerId);
  let html = '';
  if (spectator || !me) {
    html = '<p class="caption" style="align-self:center;">You dey watch this game as spectator.</p>';
  } else if (room.status === 'ended') {
    html = '<p class="caption" style="align-self:center;">Game don finish. See the final table.</p>';
  } else if (room.auction) {
    html = '<p class="caption" style="align-self:center;">Auction dey run. Bid for the panel above.</p>';
  } else if (room.debt) {
    if (room.debt.playerId === me.id) {
      html = '<button class="btn" id="abManage">' + window.icon('book', 18) + ' Raise money</button>' +
        '<button class="btn red" id="abBankrupt">' + (bankruptArmed ? 'Tap again: confirm bankruptcy' : window.icon('alert', 18) + ' Bankruptcy') + '</button>';
    } else {
      const d = byId(room.debt.playerId);
      html = '<p class="caption" style="align-self:center;">' + esc(d ? d.name : 'A player') + ' dey raise ' + fmtN(room.debt.amount) + ' (' + esc(room.debt.reason) + ').</p>';
    }
  } else if (room.buildPlace && room.buildPlace.playerId === me.id) {
    html = '<p class="caption" style="align-self:center;">You win the last ' + room.buildPlace.kind + '. Tap a highlighted street to place am.</p>';
  } else if (room.turnPlayerId !== me.id && room.mode !== 'pass') {
    html = '<p class="caption" style="align-self:center;">Na ' + esc(turn ? turn.name : '') + ' turn. Wait small.</p>';
  } else {
    // My action (online: me; pass: the turn player, acting through this phone)
    const actor = room.mode === 'pass' ? turn : me;
    if (actor.pendingChoice != null) {
      html = '<p class="caption" style="align-self:center;">You carry a mortgaged deed choice. Settle am for the popup first.</p>';
    } else if (room.phase === 'roll') {
      html = '<button class="btn green" id="abRoll">' + window.icon('dice', 20) + ' Roll dice' + timerSpan(room.turnDeadline) + '</button>';
    } else if (room.phase === 'jail') {
      html = '<button class="btn" id="abJailPay">Pay bail ' + fmtN(50000) + '</button>' +
        (actor.goojf > 0 ? '<button class="btn" id="abJailCard">' + window.icon('card', 18) + ' Use Get Out card</button>' : '') +
        '<button class="btn green" id="abJailRoll">' + window.icon('dice', 20) + ' Roll for double</button>';
    } else if (room.phase === 'buy') {
      const price = room.buyPrice != null ? room.buyPrice : (room.buySpace != null ? roomAmount(room.buySpace) : 0);
      html = '<button class="btn green" id="abBuy">' + window.icon('check', 18) + ' Buy ' + fmtN(price) + '</button>' +
        '<button class="btn ghost" id="abDecline">' + window.icon('gavel', 18) + ' Send to auction</button>';
    } else if (room.phase === 'tax') {
      const pct = Math.floor((actor.netWorth || 0) * 0.10);
      html = '<button class="btn" id="abTaxFlat">Pay flat ' + fmtN(200000) + '</button>' +
        '<button class="btn" id="abTaxPct">Pay 10%: ' + fmtN(pct) + '</button>';
    } else if (room.phase === 'end') {
      html = '<button class="btn dark" id="abEnd">End turn' + timerSpan(room.turnDeadline) + '</button>';
    } else {
      html = '<p class="caption" style="align-self:center;">Wait small…</p>';
    }
  }
  bar.innerHTML = html;
  const wire = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  wire('abRoll', () => sendAs('roll', {}));
  wire('abJailPay', () => sendAs('jail_pay', {}));
  wire('abJailCard', () => sendAs('jail_card', {}));
  wire('abJailRoll', () => sendAs('jail_roll', {}));
  wire('abBuy', () => { sfx.buy(); sendAs('buy', {}); });
  wire('abDecline', () => sendAs('decline', {}));
  wire('abTaxFlat', () => sendAs('tax_choice', { choice: 'flat' }));
  wire('abTaxPct', () => sendAs('tax_choice', { choice: 'percent' }));
  wire('abEnd', () => { bankruptArmed = false; sendAs('end_turn', {}); });
  wire('abManage', () => openMyDeeds());
  wire('abBankrupt', () => {
    if (!bankruptArmed) { bankruptArmed = true; renderActionBar(room); setTimeout(() => { bankruptArmed = false; if (state) renderActionBar(state); }, 3500); return; }
    bankruptArmed = false;
    sendAs('declare_bankruptcy', {});
  });
  // Secondary row: deeds, trade, gist
  let secHtml = '<button class="btn small ghost" id="sbDeeds">' + window.icon('book', 16) + ' My deeds</button>';
  if (!spectator) secHtml += '<button class="btn small ghost" id="sbTrade">' + window.icon('swap', 16) + ' ' + (room.inf ? 'Swap contract' : 'Trade') + '</button>';
  if (room.inf && !spectator) secHtml += '<button class="btn small ghost" id="sbContracts">' + window.icon('card', 16) + ' Contracts</button>';
  secHtml += '<button class="btn small ghost" id="sbGist">' + window.icon('eye', 16) + ' Game gist</button>';
  sec.innerHTML = secHtml;
  wire('sbDeeds', () => openMyDeeds());
  wire('sbTrade', () => openTrade());
  wire('sbContracts', () => openContracts());
  wire('sbGist', () => openGist());
}
// ---------------------------------------------------------------------------
// Smart auto-end: when the turn player has nothing left to decide, the turn
// passes by itself after a short visible countdown on the End turn button.
// Any touch from that player holds the turn (the management window stays:
// building, trades, contracts and mortgage decisions all block or cancel
// it). This is only the client's own end_turn intent on a timer; the server
// rules and the 60s turn timer backstop are untouched.
// ---------------------------------------------------------------------------
const AUTO_END_MS = 6000;
let autoEnd = null; // { key, deadline }

function autoEndSheetOpen() {
  return !!document.querySelector('.scrim.show, .overlay.show');
}
function autoEndBuildAvailable(room, actor) {
  // A build counts as available when the placement is legal (full set, even
  // build, nothing mortgaged or pledged), the bank still has the building,
  // and the player can pay the printed cost. Printed cost is the floor in
  // every mode: Inflation multiplies it by a die of 1 or more, so a player
  // who cannot pay printed cannot build at all, and one who can might.
  const D = window.KP_DATA;
  for (let i = 0; i < D.SPACES.length; i++) {
    const sp = D.SPACES[i];
    if (!sp || sp.type !== 'street') continue;
    if (actor.cash < (sp.duplex || 0)) continue;
    if (room.duplexSupply > 0 && window.KPBoard.canBuildHere(room, actor.id, i, 'duplex')) return true;
    if (room.mansionSupply > 0 && window.KPBoard.canBuildHere(room, actor.id, i, 'mansion')) return true;
  }
  return false;
}
function autoEndBlocked(room) {
  if (!room || room.status !== 'playing' || room.paused || spectator) return true;
  const actor = byId(room.turnPlayerId);
  if (!actor || actor.bankrupt) return true;
  if (actingId() !== room.turnPlayerId) return true; // only the turn player's own client arms it
  if (room.phase !== 'end') return true; // doubles and roll-again live in the roll phase
  if (room.auction || room.debt || room.buildPlace || room.trade) return true;
  if (actor.pendingChoice != null) return true;
  if (room.inf && (room.inf.proposal || room.inf.loanDecision || room.inf.dealBreakEndsAt)) return true;
  if (autoEndSheetOpen()) return true;
  if (autoEndBuildAvailable(room, actor)) return true;
  if (room.turnDeadline && room.turnDeadline - Date.now() < AUTO_END_MS + 1500) return true;
  if (!$('abEnd')) return true;
  return false;
}
function autoEndStrip() {
  const btn = $('abEnd');
  if (btn) { const f = btn.querySelector('.autoend-fill'); if (f) f.remove(); }
  const lbl = $('autoEndLabel');
  if (lbl) lbl.remove();
}
function autoEndCancel() {
  if (!autoEnd) return;
  autoEnd = null;
  autoEndStrip();
}
function autoEndPaint() {
  const btn = $('abEnd');
  if (!btn || !autoEnd) return;
  const left = Math.max(0, autoEnd.deadline - Date.now());
  if (!btn.querySelector('.autoend-fill')) {
    const f = document.createElement('span');
    f.className = 'autoend-fill';
    btn.appendChild(f);
  }
  btn.querySelector('.autoend-fill').style.width = (left / AUTO_END_MS * 100) + '%';
  let lbl = $('autoEndLabel');
  if (!lbl) {
    lbl = document.createElement('span');
    lbl.className = 'autoend-label';
    lbl.id = 'autoEndLabel';
    $('actionBar').appendChild(lbl);
  }
  lbl.textContent = 'Turn go pass by itself in ' + Math.ceil(left / 1000) + 's · touch anything make e wait';
}
function autoEndEvaluate() {
  const room = state;
  if (!room || autoEndBlocked(room)) { autoEndCancel(); return; }
  const key = room.turnPlayerId + '|' + (room.turnDeadline || 'x');
  if (autoEnd && autoEnd.key === key) {
    if (Date.now() >= autoEnd.deadline) {
      autoEndCancel();
      bankruptArmed = false;
      sendAs('end_turn', {});
      return;
    }
    autoEndPaint();
    return;
  }
  autoEnd = { key, deadline: Date.now() + AUTO_END_MS };
  autoEndPaint();
}
setInterval(autoEndEvaluate, 100);
// Any real touch or key press by the player holds the turn: cancel at once.
// State pushes do not fire these, so the countdown survives re-renders; a
// touch that opens a sheet also keeps it blocked while the sheet is up.
document.addEventListener('pointerdown', () => autoEndCancel(), true);
document.addEventListener('keydown', () => autoEndCancel(), true);

function roomAmount(i) { return window.KP_DATA.SPACES[i].price || 0; }

function renderAuction(room) {
  const slot = $('auctionSlot');
  const a = room.auction;
  if (!a) { slot.innerHTML = ''; return; }
  const label = a.kind === 'deed' ? window.KP_DATA.SPACES[a.space].name : (a.kind === 'duplex' ? 'The last duplex' : 'The last mansion');
  const high = a.highBidder ? byId(a.highBidder) : null;
  const bidder = room.mode === 'pass' ? (bidAs != null ? bidAs : room.turnPlayerId) : myId;
  const canBid = !spectator && a.eligible.includes(bidder) && !a.passed.includes(bidder);
  const phaseLine = room.inf && a.kind === 'deed'
    ? '<p class="caption">Phase ' + room.inf.phase + ' context: printed rent on this street go multiply by ' + (room.inf.phase === 1 ? 'nothing yet' : room.inf.phase === 2 ? 'the lowest die' : 'the bigger die') + '. Auction price na the bid, always.</p>'
    : '';
  slot.innerHTML = '<div class="auction-card">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;"><b class="title" style="font-size:17px;">' + window.icon('gavel', 18) + ' Auction: ' + esc(label) + '</b>' +
    '<span class="turn-timer" data-deadline="' + a.endsAt + '">' + Math.max(0, Math.round((a.endsAt - Date.now()) / 1000)) + 's</span></div>' +
    '<p style="margin:6px 0 0;">High bid: <b>' + (a.highBid > 0 ? fmtN(a.highBid) + ' by ' + esc(high ? high.name : '') : 'no bid yet') + '</b> · Next minimum: <b>' + fmtN(a.minNext) + '</b></p>' +
    phaseLine +
    (room.mode === 'pass' ? '<p class="caption" style="margin-top:6px;">Bidding as: ' + room.players.filter((p) => a.eligible.includes(p.id) && !p.bankrupt).map((p) => '<button class="chip" data-bidas="' + p.id + '" style="' + (bidder === p.id ? 'background:var(--gold);' : '') + '">' + esc(p.name) + '</button>').join(' ') + '</p>' : '') +
    (canBid ? '<div class="bid-grid">' +
      '<button class="btn small" data-bid="' + a.minNext + '">Bid ' + fmtN(a.minNext) + '</button>' +
      '<button class="btn small ghost" data-bid="' + Math.max(a.minNext, a.highBid + 10000) + '">' + fmtN(Math.max(a.minNext, a.highBid + 10000)) + '</button>' +
      '<button class="btn small ghost" data-bid="' + Math.max(a.minNext, a.highBid + 50000) + '">' + fmtN(Math.max(a.minNext, a.highBid + 50000)) + '</button>' +
      '<button class="btn small ghost" data-bid="' + Math.max(a.minNext, a.highBid + 100000) + '">' + fmtN(Math.max(a.minNext, a.highBid + 100000)) + '</button></div>' +
      '<button class="btn small red block mt8" id="bidPass">Pass</button>'
      : '<p class="caption" style="margin-top:6px;">' + (spectator ? 'You dey watch.' : 'You don pass for this auction, or you no dey eligible.') + '</p>') +
    '</div>';
  slot.querySelectorAll('[data-bid]').forEach((b) => b.addEventListener('click', () => {
    const o = { amount: Number(b.dataset.bid) };
    if (room.mode === 'pass') o.as = bidder;
    send('bid', o);
  }));
  slot.querySelectorAll('[data-bidas]').forEach((b) => b.addEventListener('click', () => { bidAs = Number(b.dataset.bidas); renderAuction(room); }));
  const pass = $('bidPass');
  if (pass) pass.addEventListener('click', () => { const o = {}; if (room.mode === 'pass') o.as = bidder; send('pass_bid', o); });
}

// ---------------------------------------------------------------------------
// Modals: drawn card, mortgaged deed choice, proposals, loan decisions
// ---------------------------------------------------------------------------
const CARD_FX_LABELS = {
  payBank: 'Pay am', repairs: 'Pay am', nepaLight: 'Settle am', lekkiRain: 'Settle am', fakeAlert: 'E don happen',
  payEach: 'Pay am', collectEach: 'Collect am', bankPays: 'Collect am', upNepa: 'Collect am', fineRefund: 'Collect am',
  freeUnmortgage: 'Use am', sapa: 'Na so e be', moveTo: 'Move', moveBack: 'Move', moveNearest: 'Move', jail: 'Go Kirikiri',
  goojf: 'Keep the card', shield: 'Keep the shield'
};
function showCardModal(card) {
  sfx.swish();
  const m = $('cardModal');
  const deckData = card.deck === 'wahala' ? window.KP_DATA.WAHALA : window.KP_DATA.FAMILY;
  const found = deckData.find((c) => c.id === card.id);
  const fxType = found && found.fx ? found.fx.type : '';
  const label = CARD_FX_LABELS[fxType] || 'Na so e be';
  m.className = 'modal-card card-face ' + (card.deck === 'wahala' ? 'face-wahala' : 'face-family');
  m.innerHTML = '<p class="caption" style="letter-spacing:1px;">' + (card.deck === 'wahala' ? 'WAHALA CARD' : 'FAMILY MEETING CARD') + '</p>' +
    '<p class="lead" style="margin-top:8px;">' + esc(card.text) + '</p>' +
    '<div class="btnrow"><button class="btn" data-close="1">' + label + '</button></div>';
  $('cardScrim').classList.add('show');
  if (window.KP3D) window.KP3D.onCardDrawn(card);
  m.querySelector('[data-close]').addEventListener('click', () => {
    closeScrim('cardScrim');
    if (window.KP3D) window.KP3D.onCardResolved(card);
  });
}
function maybeShowModals(room) {
  // Mortgaged deed choice (from a trade or bankruptcy handover)
  const focusIds = room.mode === 'pass' ? room.players.map((p) => p.id) : [myId];
  const holder = room.players.find((p) => focusIds.includes(p.id) && p.pendingChoice != null);
  if (holder && room.status === 'playing') {
    const i = holder.pendingChoice;
    const sp = window.KP_DATA.SPACES[i];
    const m = $('choiceModal');
    m.innerHTML = '<h3 class="title">' + esc(sp.name) + ' land for your hand, but e dey mortgaged</h3>' +
      '<p class="lead" style="margin-top:8px;">' + esc(holder.name) + ', choose now: pay 10 percent interest (' + fmtN(Math.round(window.KP_DATA.mortgageOf(sp.price) * 0.10)) + ') and the deed stays mortgaged, or lift the mortgage fully for ' + fmtN(window.KP_DATA.unmortgageCost(sp.price)) + '.</p>' +
      '<div class="btnrow"><button class="btn ghost" id="choiceInterest">Pay interest</button><button class="btn" id="choiceLift">Lift mortgage</button></div>';
    $('choiceScrim').classList.add('show');
    $('choiceInterest').addEventListener('click', () => { const o = { choice: 'interest' }; if (room.mode === 'pass') o.as = holder.id; send('mortgage_choice', o); closeScrim('choiceScrim'); });
    $('choiceLift').addEventListener('click', () => { const o = { choice: 'lift' }; if (room.mode === 'pass') o.as = holder.id; send('mortgage_choice', o); closeScrim('choiceScrim'); });
  } else {
    closeScrim('choiceScrim');
  }
  // Incoming trade
  const t = room.trade;
  if (t && !spectator && (room.mode === 'pass' || t.to === myId) && t.id !== shownTradeId) {
    shownTradeId = t.id;
    showProposalModal(tradeSummaryHTML(t, room),
      (honour) => {
        const o = { accept: true };
        if (honour && honour.length) o.honourPass = honour;
        if (room.mode === 'pass') o.as = t.to;
        send('trade_respond', o);
      },
      null,
      () => { const o = { accept: false }; if (room.mode === 'pass') o.as = t.to; send('trade_respond', o); },
      t);
    return;
  }
  // Incoming contract proposal
  const pr = room.inf && room.inf.proposal;
  if (pr && !spectator && (room.mode === 'pass' || pr.to === myId) && pr.id !== shownProposalId) {
    shownProposalId = pr.id;
    showProposalModal(contractSummaryHTML(pr, room), null, () => {
      const o = { accept: true }; if (room.mode === 'pass') o.as = pr.to; send('contract_respond', o);
    }, () => { const o = { accept: false }; if (room.mode === 'pass') o.as = pr.to; send('contract_respond', o); }, null, true);
    return;
  }
  // Loan decision for the lender
  const ld = room.inf && room.inf.loanDecision;
  if (ld && ld.contractId !== shownLoanDecisionId) {
    const c = room.inf.contracts.find((x) => x.id === ld.contractId);
    // Contract may already be repaid mid decision; find in active list may miss seized ones, guard:
    const lenderId = c ? c.lender : null;
    if (c && (room.mode === 'pass' || lenderId === myId)) {
      shownLoanDecisionId = ld.contractId;
      showLoanDecision(c, room);
    }
  }
}
function sideSummary(side, room) {
  const parts = [];
  if (side.cash > 0) parts.push(fmtN(side.cash));
  for (const i of side.spaces) parts.push(window.KP_DATA.SPACES[i].name);
  if (side.goojf > 0) parts.push(side.goojf + ' Get Out of Kirikiri Free card(s)');
  return parts.length ? parts.join(' + ') : 'nothing';
}
function tradeSummaryHTML(t, room) {
  const from = byId(t.from);
  const to = byId(t.to);
  let honour = '';
  if (room.inf) {
    const withPass = t.offer.spaces.filter((i) => room.inf.contracts.some((c) => c.type === 'pass' && c.street === i));
    if (withPass.length) {
      honour = '<p class="caption" style="margin-top:8px;">Pass chips dey on: ' + withPass.map((i) => window.KP_DATA.SPACES[i].name).join(', ') + '. Tick to honour them as the new owner; leave unticked and the chips die.</p>' +
        withPass.map((i) => '<label class="deed-check"><input type="checkbox" data-honour="' + i + '"><span>Honour Pass on ' + esc(window.KP_DATA.SPACES[i].name) + '</span></label>').join('');
    }
  }
  return '<h3 class="title">Trade from ' + esc(from ? from.name : '') + '</h3>' +
    '<p class="lead" style="margin-top:8px;">' + esc(from ? from.name : '') + ' gives: <b>' + esc(sideSummary(t.offer, room)) + '</b></p>' +
    '<p class="lead">' + esc(to ? to.name : '') + ' gives: <b>' + esc(sideSummary(t.request, room)) + '</b></p>' + honour +
    (t.expiresAt ? '<p class="caption">This swap contract expires in <span class="turn-timer" data-deadline="' + t.expiresAt + '"></span>.</p>' : '');
}
function contractSummaryHTML(pr, room) {
  const from = byId(pr.from);
  if (pr.kind === 'pass') {
    const sp = window.KP_DATA.SPACES[pr.terms.street];
    return '<h3 class="title">Pass contract offer</h3>' +
      '<p class="lead" style="margin-top:8px;">' + esc(from ? from.name : '') + ' wan buy <b>' + pr.terms.chips + ' Pass chip(s)</b> for <b>' + esc(sp.name) + '</b> at <b>' + fmtN(pr.terms.price) + '</b>.</p>' +
      '<p class="caption">A chip means: when they land on your ' + esc(sp.name) + ' and rent suppose fire, they pay ₦0 and one chip burns. Chips die at this phase end. If the street changes owner, chips die unless the new owner honours them.</p>';
  }
  const sp = window.KP_DATA.SPACES[pr.terms.pledgedSpace];
  const due = pr.terms.amount + Math.floor(pr.terms.amount * pr.terms.interestPct / 100);
  return '<h3 class="title">Loan contract offer</h3>' +
    '<p class="lead" style="margin-top:8px;">' + esc(from ? from.name : '') + ' wan borrow <b>' + fmtN(pr.terms.amount) + '</b> from you, security na their <b>' + esc(sp.name) + '</b> deed.</p>' +
    '<p class="caption">Pay back ' + fmtN(due) + ' before ' + pr.terms.termLaps + ' of their lap(s) finish or this phase ends, whichever first. If they default, you choose: seize ' + esc(sp.name) + ' (debt dies, non recourse) or extend once for extra 10 percent. While pledged, the deed no fit trade, mortgage, or build on its set.</p>';
}
function showProposalModal(html, onAcceptWithHonour, onAccept, onDecline, trade, isContract) {
  const m = $('proposalModal');
  m.innerHTML = html + '<div class="btnrow"><button class="btn red" id="propNo">Decline</button><button class="btn green" id="propYes">Accept</button></div>' +
    '<p class="caption center mt8">The phone should be with the player wey go answer.</p>';
  $('proposalScrim').classList.add('show');
  $('propNo').addEventListener('click', () => { closeScrim('proposalScrim'); if (onDecline) onDecline(); });
  $('propYes').addEventListener('click', () => {
    closeScrim('proposalScrim');
    if (onAcceptWithHonour) {
      const honour = Array.from(m.querySelectorAll('[data-honour]:checked')).map((c) => Number(c.dataset.honour));
      onAcceptWithHonour(honour);
    } else if (onAccept) onAccept();
  });
}
function showLoanDecision(c, room) {
  const borrower = byId(c.borrower);
  const sp = window.KP_DATA.SPACES[c.pledgedSpace];
  const m = $('proposalModal');
  m.innerHTML = '<h3 class="title">Loan don due</h3>' +
    '<p class="lead" style="margin-top:8px;">' + esc(borrower ? borrower.name : '') + ' never pay back ' + fmtN(c.dueTotal) + ' for the loan against <b>' + esc(sp.name) + '</b>. Lender, choose:</p>' +
    '<div class="btnrow"><button class="btn red" id="ldSeize">Seize ' + esc(sp.name) + '</button>' +
    (c.extended ? '' : '<button class="btn" id="ldExtend">Extend one lap (+10%)</button>') + '</div>' +
    '<p class="caption">No answer in 30 seconds: the server extends once if e never extend, otherwise e seize automatically.</p>';
  $('proposalScrim').classList.add('show');
  $('ldSeize').addEventListener('click', () => { const o = { contractId: c.id, choice: 'seize' }; if (room.mode === 'pass') o.as = c.lender; send('loan_decide', o); closeScrim('proposalScrim'); });
  const ex = $('ldExtend');
  if (ex) ex.addEventListener('click', () => { const o = { contractId: c.id, choice: 'extend' }; if (room.mode === 'pass') o.as = c.lender; send('loan_decide', o); closeScrim('proposalScrim'); });
}

// ---------------------------------------------------------------------------
// Sheets: my deeds, trade/swap, contracts board, gist
// ---------------------------------------------------------------------------
function deedRowsFor(playerId, room, picker) {
  return window.KP_DATA.OWNABLE.filter((i) => room.props[i] && room.props[i].o === playerId).map((i) => {
    const sp = window.KP_DATA.SPACES[i];
    const pr = room.props[i];
    const band = sp.type === 'street' ? window.KP_DATA.GROUPS[sp.group].color : '#3d3d3d';
    return '<div class="deed-check">' + (picker ? '<input type="checkbox" data-deed="' + i + '">' : '') +
      '<span class="dot" style="background:' + band + '"></span><span style="flex:1"><b>' + esc(sp.name) + '</b>' +
      '<span class="meta"> ' + (pr.b >= 5 ? '· Mansion' : pr.b > 0 ? '· ' + pr.b + ' duplex' : '') + (pr.m ? ' · mortgaged' : '') + (pr.pl ? ' · pledged' : '') + '</span></span>' +
      (!picker ? '<button class="btn small ghost" data-open-deed="' + i + '">Open</button>' : '') + '</div>';
  }).join('') || '<p class="caption">No deeds yet.</p>';
}
function openMyDeeds() {
  const room = state;
  const me = focusPlayer();
  if (!me) return;
  $('listSheet').innerHTML = '<div class="grab"></div><h3 class="title">' + esc(me.name) + ': your deeds</h3>' +
    '<p class="caption">Cash ' + fmtN(me.cash) + ' · Net worth ' + fmtN(me.netWorth) + ' · Bank supply: ' + room.duplexSupply + ' duplexes, ' + room.mansionSupply + ' mansions · Owambe pot ' + fmtN(room.pot) + '</p>' +
    '<div class="mt8">' + deedRowsFor(me.id, room, false) + '</div>' +
    '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>';
  $('listScrim').classList.add('show');
  wireSheetButtons($('listSheet'), me.id);
  $('listSheet').querySelectorAll('[data-open-deed]').forEach((b) => b.addEventListener('click', () => {
    closeScrim('listScrim');
    onSpaceTap(Number(b.dataset.openDeed));
  }));
}
function openTrade() {
  const room = state;
  const me = focusPlayer();
  if (!me || spectator) return;
  const others = room.players.filter((p) => p.id !== me.id && !p.bankrupt);
  if (!others.length) { toast('No living player to trade with.'); return; }
  $('listSheet').innerHTML = '<div class="grab"></div><h3 class="title">' + (room.inf ? 'Propose a swap contract' : 'Propose a trade') + '</h3>' +
    (room.mode === 'pass' ? '<label style="display:block;font-weight:800;font-size:12px;margin:10px 0 6px;">You dey act as</label><select class="textin" id="actAs">' + room.players.filter((p) => !p.bankrupt).map((p) => '<option value="' + p.id + '"' + (p.id === me.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>' : '') +
    (room.inf ? '<p class="caption">For Inflation Mode, swaps na contracts: propose during your turn before you roll, or during a Deal Break. The other side gets 30 seconds to answer. If e no dey for contract board, e no happen.</p>' : '<p class="caption">Trades fit happen any time. Deeds with buildings for their set no fit trade until the buildings sell.</p>') +
    '<label style="display:block;font-weight:800;font-size:12px;margin:12px 0 6px;">Trade with</label>' +
    '<select class="textin" id="tradeTo">' + others.map((p) => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('') + '</select>' +
    '<div class="trade-cols mt8"><div><b>You give</b><input class="num-in mt8" id="giveCash" type="number" min="0" placeholder="Cash ₦">' +
    '<div class="mt8" id="giveDeeds">' + deedRowsFor(me.id, room, true) + '</div>' +
    '<label class="deed-check"><input type="number" id="giveGoojf" min="0" max="' + me.goojf + '" value="0" style="width:64px;"> <span>Get Out cards (you hold ' + me.goojf + ')</span></label></div>' +
    '<div><b>You want</b><input class="num-in mt8" id="wantCash" type="number" min="0" placeholder="Cash ₦">' +
    '<div class="mt8" id="wantDeeds"></div>' +
    '<label class="deed-check"><input type="number" id="wantGoojf" min="0" value="0" style="width:64px;"> <span>Get Out cards</span></label></div></div>' +
    '<div id="honourBox"></div>' +
    '<div class="btnrow"><button class="btn ghost" data-close="1">Cancel</button><button class="btn" id="tradeGo">Propose</button></div>';
  $('listScrim').classList.add('show');
  wireSheetButtons($('listSheet'), me.id);
  const fillWant = () => {
    const toId = Number($('tradeTo').value);
    $('wantDeeds').innerHTML = deedRowsFor(toId, room, true);
    if (room.inf) {
      const checked = Array.from($('wantDeeds').querySelectorAll('[data-deed]:checked')).map((c) => Number(c.dataset.deed));
      const withPass = checked.filter((i) => room.inf.contracts.some((c) => c.type === 'pass' && c.street === i));
      $('honourBox').innerHTML = withPass.length
        ? '<p class="caption mt8">Pass chips dey on streets you dey request. Tick the ones you go honour as new owner:</p>' + withPass.map((i) => '<label class="deed-check"><input type="checkbox" data-honour-req="' + i + '"><span>Honour Pass on ' + esc(window.KP_DATA.SPACES[i].name) + '</span></label>').join('')
        : '';
      $('wantDeeds').querySelectorAll('[data-deed]').forEach((c) => c.addEventListener('change', fillWant));
    }
  };
  $('tradeTo').addEventListener('change', fillWant);
  const actSel = $('actAs');
  if (actSel) actSel.addEventListener('change', () => {
    $('giveDeeds').innerHTML = deedRowsFor(Number(actSel.value), room, true);
    fillWant();
  });
  fillWant();
  $('tradeGo').addEventListener('click', () => {
    const grab = (rootId) => Array.from($(rootId).querySelectorAll('[data-deed]:checked')).map((c) => Number(c.dataset.deed));
    const honour = Array.from($('listSheet').querySelectorAll('[data-honour-req]:checked')).map((c) => Number(c.dataset.honourReq));
    const o = {
      to: Number($('tradeTo').value),
      offer: { cash: Number($('giveCash').value || 0), spaces: grab('giveDeeds'), goojf: Number($('giveGoojf').value || 0) },
      request: { cash: Number($('wantCash').value || 0), spaces: grab('wantDeeds'), goojf: Number($('wantGoojf').value || 0) },
      honourPass: honour
    };
    if (room.mode === 'pass') { const sel = $('actAs'); o.as = sel ? Number(sel.value) : me.id; }
    send('trade_propose', o);
    closeScrim('listScrim');
  });
}
function openContracts() {
  const room = state;
  if (!room.inf) return;
  const me = focusPlayer();
  const nameOf = (id) => { const p = byId(id); return p ? p.name : '?'; };
  const rows = room.inf.contracts.map((c) => {
    if (c.type === 'pass') {
      return '<div class="contract-row"><div class="grow"><b>Pass: ' + esc(window.KP_DATA.SPACES[c.street].name) + '</b>' +
        '<div class="caption">' + esc(nameOf(c.buyer)) + ' hold ' + c.chipsLeft + ' chip(s) against ' + esc(nameOf(c.seller)) + ' · bought ' + fmtN(c.price) + ' · Phase ' + c.phaseCreated + ' (dies at phase end)</div></div>' + window.icon('card', 20) + '</div>';
    }
    return '<div class="contract-row"><div class="grow"><b>Loan: ' + fmtN(c.amount) + '</b>' +
      '<div class="caption">' + esc(nameOf(c.borrower)) + ' borrow from ' + esc(nameOf(c.lender)) + ' · security: ' + esc(window.KP_DATA.SPACES[c.pledgedSpace].name) + ' · pay back ' + fmtN(c.dueTotal) + ' · laps ' + c.lapsElapsed + '/' + c.termLaps + (c.extended ? ' · extended' : '') + '</div></div>' +
      (me && c.borrower === me.id ? '<button class="btn small green" data-repay="' + c.id + '">Repay ' + fmtN(c.dueTotal) + '</button>' : '') + '</div>';
  }).join('') || '<p class="caption">No active contracts. The board is clean, for now.</p>';
  const myDeeds = window.KP_DATA.OWNABLE.filter((i) => room.props[i] && room.props[i].o === (me && me.id));
  const othersStreets = window.KP_DATA.OWNABLE.filter((i) => {
    const sp = window.KP_DATA.SPACES[i];
    return sp.type === 'street' && room.props[i] && room.props[i].o != null && room.props[i].o !== (me && me.id);
  });
  $('listSheet').innerHTML = '<div class="grab"></div><h3 class="title">Contract Board</h3>' +
    (room.mode === 'pass' ? '<label style="display:block;font-weight:800;font-size:12px;margin:10px 0 6px;">You dey act as</label><select class="textin" id="actAsC">' + room.players.filter((p) => !p.bankrupt).map((p) => '<option value="' + p.id + '"' + (me && p.id === me.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>' : '') +
    '<p class="caption">Every deal for this table dey registered here, public. If e no dey for contract board, e no happen.</p>' +
    '<div class="mt8">' + rows + '</div>' +
    '<h3 class="title mt14" style="font-size:17px;">Buy a Pass</h3>' +
    '<label style="display:block;font-weight:800;font-size:12px;margin:8px 0 6px;">Street (owned by another player)</label>' +
    '<select class="textin" id="passStreet">' + othersStreets.map((i) => '<option value="' + i + '">' + esc(window.KP_DATA.SPACES[i].name) + ' (owner: ' + esc(nameOf(room.props[i].o)) + ')</option>').join('') + '</select>' +
    '<div class="join-row mt8"><select class="textin" id="passChips"><option value="1">1 chip</option><option value="2">2 chips</option></select>' +
    '<input class="textin" id="passPrice" type="number" min="5000" placeholder="Price ₦ (min 5,000)" style="text-transform:none;letter-spacing:normal;text-align:left;"></div>' +
    '<button class="btn block mt8" id="passGo">Propose Pass contract</button>' +
    '<h3 class="title mt14" style="font-size:17px;">Request a collateral loan</h3>' +
    '<p class="caption">Phase 2 and up only. Max 80 percent of the pledged deed price. Interest na one flat pick: 0, 10, 20 or 30 percent.</p>' +
    '<label style="display:block;font-weight:800;font-size:12px;margin:8px 0 6px;">Your deed as security</label>' +
    '<select class="textin" id="loanDeed">' + myDeeds.map((i) => '<option value="' + i + '">' + esc(window.KP_DATA.SPACES[i].name) + ' (price ' + fmtN(window.KP_DATA.SPACES[i].price) + ')</option>').join('') + '</select>' +
    '<label style="display:block;font-weight:800;font-size:12px;margin:8px 0 6px;">Lender</label>' +
    '<select class="textin" id="loanLender">' + room.players.filter((p) => p.id !== (me && me.id) && !p.bankrupt).map((p) => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('') + '</select>' +
    '<div class="join-row mt8"><input class="textin" id="loanAmount" type="number" min="0" placeholder="Amount ₦" style="text-transform:none;letter-spacing:normal;text-align:left;">' +
    '<select class="textin" id="loanPct"><option value="0">0%</option><option value="10" selected>10%</option><option value="20">20%</option><option value="30">30%</option></select>' +
    '<select class="textin" id="loanTerm"><option value="1">1 lap</option><option value="2" selected>2 laps</option><option value="3">3 laps</option></select></div>' +
    '<button class="btn block mt8" id="loanGo">Propose loan contract</button>' +
    '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>';
  $('listScrim').classList.add('show');
  wireSheetButtons($('listSheet'), me && me.id);
  const actAsC = () => { const sel = $('actAsC'); return sel ? Number(sel.value) : (me && me.id); };
  $('listSheet').querySelectorAll('[data-repay]').forEach((b) => b.addEventListener('click', () => {
    const o = { contractId: Number(b.dataset.repay) };
    if (room.mode === 'pass') o.as = actAsC();
    send('repay_loan', o);
    closeScrim('listScrim');
  }));
  $('passGo').addEventListener('click', () => {
    const o = { kind: 'pass', street: Number($('passStreet').value), chips: Number($('passChips').value), price: Number($('passPrice').value || 0) };
    if (room.mode === 'pass') o.as = actAsC();
    send('contract_propose', o);
    closeScrim('listScrim');
  });
  $('loanGo').addEventListener('click', () => {
    const o = { kind: 'loan', to: Number($('loanLender').value), pledgedSpace: Number($('loanDeed').value), amount: Number($('loanAmount').value || 0), interestPct: Number($('loanPct').value), termLaps: Number($('loanTerm').value) };
    if (room.mode === 'pass') o.as = actAsC();
    send('contract_propose', o);
    closeScrim('listScrim');
  });
}
function openGist() {
  const room = state;
  const items = (room.feed || []).slice().reverse().map((e) =>
    '<div class="feed-item"><span class="k">' + esc(e.kind) + '</span><div>' + esc(e.text) + '</div></div>').join('') || '<p class="caption">Nothing don happen yet.</p>';
  $('listSheet').innerHTML = '<div class="grab"></div><h3 class="title">Game gist</h3><div class="mt8">' + items + '</div>' +
    '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>';
  $('listScrim').classList.add('show');
  wireSheetButtons($('listSheet'), myId);
}

// ---------------------------------------------------------------------------
// End screen and share cards
// ---------------------------------------------------------------------------
function renderEnd(room) {
  const o = $('endOverlay');
  if (!room.endTable) { o.classList.remove('show'); return; }
  const rows = room.endTable.map((r, idx) =>
    '<tr class="' + (idx === 0 ? 'winner-row' : '') + '"><td>' + (idx === 0 ? window.icon('crown', 17) + ' ' : '') + esc(r.name) + (r.bankrupt ? ' (bankrupt)' : '') + '<br><span class="meta" style="color:inherit;opacity:.75;">' + esc(r.title) + '</span>' +
    (r.lessons && r.lessons.length ? r.lessons.map((l) => '<span class="end-lessons">' + esc(l) + '</span>').join('') : '') +
    '</td><td>' + fmtN(r.netWorth) + '</td></tr>').join('');
  const hasReal = room.endTable.some((r) => r.realNetWorth != null);
  const realRows = hasReal ? room.endTable.slice().sort((a, b) => b.realNetWorth - a.realNetWorth).map((r) =>
    '<tr><td>' + esc(r.name) + '<br><span class="meta" style="color:inherit;opacity:.75;">Cash ' + fmtN(r.realCash) + ' at Phase 1 power</span></td><td>' + fmtN(r.realNetWorth) + '</td></tr>').join('') : '';
  o.innerHTML = '<h2 class="headline" style="color:var(--gold);">' + esc(room.winner ? room.winner.name : '') + ' na the real landlord</h2>' +
    '<p class="caption" style="color:#ffe9c9;opacity:.8;">THE NOMINAL TABLE: wetin the numbers talk</p>' +
    '<table class="end-table"><tr><th>Player and title</th><th>Net worth</th></tr>' + rows + '</table>' +
    (hasReal ? '<p class="caption" style="color:#ffe9c9;opacity:.8;">THE REAL TABLE: wetin the money fit buy at Phase 1 prices (cash divided by the Inflation Index ' + (room.inf ? room.inf.index : '') + 'x)</p>' +
      '<table class="end-table"><tr><th>Player</th><th>Real net worth</th></tr>' + realRows + '</table>' +
      '<p class="caption real-table-note" style="color:#ffe9c9;opacity:.75;">Nominal no be real. The argument between these two tables na the lesson; argue am well.</p>' : '') +
    (room.dealOfGame ? '<p class="lead" style="max-width:460px;">Deal of the Game: ' + esc(room.dealOfGame) + '</p>' : '') +
    (room.interestLine ? '<p class="caption" style="color:#ffe9c9;opacity:.85;max-width:460px;">' + esc(room.interestLine) + '</p>' : '') +
    (room.bankerGhost ? '<p class="caption">Banker: ' + esc(room.bankerGhost) + ', wey inflation first catch. The ghost run the announcements, no money power.</p>' : '') +
    '<div class="btnrow" style="max-width:460px;width:100%;"><button class="btn" id="endShare">Final Table card</button>' +
    '<button class="btn green" id="endAgain">Play again</button></div>' +
    '<button class="btn ghost mt8" id="endLeave">Leave</button>';
  o.classList.add('show');
  $('endShare').addEventListener('click', () => {
    openShare('final', {
      rows: room.endTable.map((r, idx) => ({ name: r.name, netWorth: r.netWorth, title: r.title, crown: idx === 0 })),
      deal: room.dealOfGame, code: room.code
    });
  });
  $('endAgain').addEventListener('click', () => { o.classList.remove('show'); send('play_again', {}); });
  $('endLeave').addEventListener('click', () => { send('leave', {}); clearSeat(); setTimeout(() => location.reload(), 250); });
}
let shareCanvas = null;
function openShare(kind, data) {
  shareCanvas = window.KPBoard.drawShareCard(kind, data);
  const o = $('shareOverlay');
  o.innerHTML = '<div class="share-canvas-box"></div>' +
    '<div class="btnrow" style="max-width:430px;width:100%;"><button class="btn" id="shareGo">Share card</button>' +
    '<button class="btn ghost" id="shareDl">Download</button>' +
    '<button class="btn ghost" id="shareClose">Close</button></div>';
  o.querySelector('.share-canvas-box').appendChild(shareCanvas);
  o.classList.add('show');
  $('shareClose').addEventListener('click', () => o.classList.remove('show'));
  $('shareDl').addEventListener('click', () => {
    const a = document.createElement('a');
    a.download = 'kolopoly-' + kind + '.png';
    a.href = shareCanvas.toDataURL('image/png');
    a.click();
  });
  $('shareGo').addEventListener('click', () => {
    shareCanvas.toBlob(async (blob) => {
      const file = new File([blob], 'kolopoly-' + kind + '.png', { type: 'image/png' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'KOLOPOLY' }); } catch { /* closed */ }
      } else {
        const a = document.createElement('a');
        a.download = 'kolopoly-' + kind + '.png';
        a.href = shareCanvas.toDataURL('image/png');
        a.click();
        toast('Sharing no dey for this browser, so the card download instead.');
      }
    });
  });
}
window.__kolopolyShareCard = openShare;

// Sheets dismiss with a downward swipe too, like every app users know.
// (Modal cards carry forced choices and stay button-only.)
document.querySelectorAll('.sheet').forEach((sh) => {
  let y0 = null;
  sh.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  sh.addEventListener('touchend', (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    if (dy > 70 && sh.scrollTop <= 0) { const sc = sh.closest('.scrim'); if (sc) sc.classList.remove('show'); }
  }, { passive: true });
});

// One second ticker: countdown labels only, no full re-render.
let lastAuctionTickSec = -1;
setInterval(() => {
  // Auction pressure: a tick a second under the last five seconds.
  const auc = state && state.auction;
  if (auc) {
    const s = Math.ceil((auc.endsAt - Date.now()) / 1000);
    if (s <= 5 && s >= 1 && s !== lastAuctionTickSec) { lastAuctionTickSec = s; sfx.auctionTick(); }
  } else lastAuctionTickSec = -1;
  document.querySelectorAll('[data-deadline]').forEach((el) => {
    const left = Math.max(0, Math.round((Number(el.dataset.deadline) - Date.now()) / 1000));
    el.textContent = left + 's';
  });
  const clk = $('infClock');
  if (clk && state && state.inf) {
    if (state.inf.phaseEndsAt) {
      const s = Math.max(0, Math.floor((state.inf.phaseEndsAt - Date.now()) / 1000));
      clk.textContent = 'Phase ends ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    } else if (state.inf.hornAt) {
      const s = Math.max(0, Math.floor((state.inf.hornAt - Date.now()) / 1000));
      clk.textContent = 'Horn in ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    } else clk.textContent = 'Phase open';
  }
}, 500);

connect();
