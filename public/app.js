'use strict';
// KOLOPOLY client. Sends intents only; the server owns dice, money and deeds.
// Test hooks: window.__kolopolyState() and window.__kolopolySend(type, obj).
const $ = (id) => document.getElementById(id);
// The game column is sized from --app-h, a pixel lock of the layout
// viewport. 100dvh and visualViewport.height both follow the mobile
// toolbar. A top alert makes that bar show, the board and dock shrink
// (and the GL buffer clears to a black edge), then they snap back.
// Shrinks the size of a toolbar are ignored. Rotation still applies.
(function lockAppShell() {
  let lockedH = 0;
  let lockedW = 0;
  function alertUp() {
    const box = document.getElementById('alerts');
    return !!(box && box.childElementCount);
  }
  function apply(h) {
    lockedH = h;
    document.documentElement.style.setProperty('--app-h', h + 'px');
  }
  function consider(h, w, reason) {
    h = Math.round(h || 0);
    w = Math.round(w || 0);
    if (!h) return lockedH;
    if (!lockedH) { apply(h); lockedW = w; return lockedH; }
    if (alertUp() && reason !== 'orient') return lockedH;
    const dw = Math.abs(w - lockedW);
    const dh = h - lockedH;
    if (reason !== 'orient') {
      if (dw < 48 && dh < 0 && -dh < 180) return lockedH;
      if (dw < 48 && Math.abs(dh) < 32) return lockedH;
    }
    apply(h);
    lockedW = w;
    return lockedH;
  }
  function refresh(reason) { return consider(window.innerHeight, window.innerWidth, reason || 'resize'); }
  refresh('boot');
  window.addEventListener('resize', () => refresh('resize'));
  window.addEventListener('orientationchange', () => {
    setTimeout(() => refresh('orient'), 80);
    setTimeout(() => refresh('orient'), 320);
  });
  window.KPShell = { height: () => lockedH, consider, refresh, alertOpen: alertUp };
})();
// KP9: the header carries ONE meta chip. The room chip also carries the
// running match clock while a timed game plays ("Room NKNZ · 59:52"), so
// the old full-width Classic bar is gone and its space went to the board.
// Under 60 seconds left the time turns urgent red.
let roomChipShown = '';
function fmtMatchClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function headerClockMs(room) {
  if (!room || (room.status !== 'playing' && room.status !== 'countdown')) return null;
  if (room.gameEndsAt) return room.gameEndsAt - Date.now();
  if (room.inf) {
    const end = room.inf.phaseEndsAt || room.inf.hornAt;
    if (end) return end - Date.now();
  }
  return null;
}
function updateRoomChip(room) {
  const chip = $('roomChip');
  if (!room || !room.code) { chip.classList.add('hidden'); roomChipShown = ''; return; }
  chip.classList.remove('hidden');
  const left = headerClockMs(room);
  const show = left != null;
  const key = room.code + '|' + (show ? fmtMatchClock(left) : '') + '|' + (show && left < 60000 ? 'u' : '');
  if (key === roomChipShown) return;
  roomChipShown = key;
  chip.innerHTML = 'Room ' + esc(room.code) + (show ? ' · <span class="chip-time' + (left < 60000 ? ' urgent' : '') + '">' + fmtMatchClock(left) + '</span>' : '');
}
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
// KP13 WS5: Inflation is the landing default and the promoted mode. A
// stored pick from an explicit earlier choice is respected; everyone
// else lands on Inflation.
let selectedGameMode = (() => { try { const v = localStorage.getItem('kolopolyGameMode'); return (v === 'classic' || v === 'inflation') ? v : 'inflation'; } catch (e) { return 'inflation'; } })();
function paintGameMode() {
  $('gameModeRow').querySelectorAll('[data-gmode]').forEach((x) => x.classList.toggle('sel', x.dataset.gmode === selectedGameMode));
  $('presetRow').classList.toggle('hidden', selectedGameMode !== 'inflation');
}
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
let leaveArmed = false;
let endRoomArmed = false;
let wakeLock = null;
let connBannerEl = null;
let heartbeatTimer = null;
let lastLocalActive = Date.now();
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
  try { releaseWakeLock(); } catch (e) { }
  try { stopHeartbeat(); } catch (e) { }
  try { hideConnBanner(); } catch (e) { }
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
// Chrome refuses navigator.vibrate before the user's first tap on the
// frame and logs it as a page error, so buzz stays silent until the
// first pointerdown arms it. Every buzz call site routes through here.
let buzzArmed = false;
window.addEventListener('pointerdown', () => { buzzArmed = true; }, { once: true });
function buzz(pattern) { try { if (buzzArmed && navigator.vibrate) navigator.vibrate(pattern); } catch (e) { } }

// ---------------------------------------------------------------------------
// Sound: tiny WebAudio synth, no samples. Mute persists.
// ---------------------------------------------------------------------------
let audioCtx = null;
let busMain = null;    // important sounds: alerts, siren, gavel, horns
let busAmbient = null; // quiet texture: hop ticks, auction ticks; ducked by important sounds
let master = null;     // KP14: one mastering chain for every bus
let noiseBuf = null;
// KP14 part 1: ONE audio control with three states. 1 = sound + voice,
// 2 = sound only, 3 = all off. Persisted as kolopolyAudio; the legacy
// pair (kolopolyMute / kolopolyVoice) migrates on first read, mute
// winning over voice-off. Voice folds into this button: there is no
// separate voice button anymore.
let audioState = (() => {
  try {
    const v = Number(localStorage.getItem('kolopolyAudio'));
    if (v === 1 || v === 2 || v === 3) return v;
    if (localStorage.getItem('kolopolyMute') === '1') return 3;
    if (localStorage.getItem('kolopolyVoice') === '0') return 2;
  } catch (e) { }
  return 1;
})();
let muted = audioState === 3;
let voiceOn = audioState === 1;
window.__kolopolyAudio = () => ({ state: audioState, muted, voiceOn });
function audio() {
  if (muted) return null;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // KP14 mastering: gentle compressor into a soft highpass, so
      // layered hits stay round and never clip harsh. The highpass sits
      // at 55Hz on purpose: gavel and stamp fundamentals live at 60-90Hz.
      master = audioCtx.createGain(); master.gain.value = 0.95;
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = 0.003; comp.release.value = 0.24;
      const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 55;
      master.connect(comp); comp.connect(hp); hp.connect(audioCtx.destination);
      busMain = audioCtx.createGain(); busMain.gain.value = 0.9; busMain.connect(master);
      busAmbient = audioCtx.createGain(); busAmbient.gain.value = 0.8; busAmbient.connect(master);
      if (typeof armSamples === 'function') armSamples(audioCtx);
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
// Sound stays on unless the player picked mute (state 3). Browsers
// suspend AudioContext on hide, on silence, and sometimes mid-game.
// A one-shot unlock used to remove the gesture listeners, so the next
// suspend had nothing to resume it and the table went quiet by itself.
// Gestures stay armed. A visible page always tries to resume. A player
// who muted is never forced back on.
let audioUnlocked = false;
let audioWatching = false;
function unlockAudio() {
  if (muted) return;
  try {
    const ctx = audio();
    if (!ctx) return;
    if (!audioWatching) {
      audioWatching = true;
      ctx.addEventListener('statechange', () => {
        if (!muted && ctx.state === 'suspended' && document.visibilityState === 'visible') {
          ctx.resume().catch(() => {});
        }
      });
    }
    if (ctx.state === 'suspended') {
      const p = ctx.resume();
      if (p && p.then) p.then(() => { if (ctx.state === 'running') audioUnlocked = true; }).catch(() => {});
    } else if (ctx.state === 'running') audioUnlocked = true;
  } catch (e) { /* garnish */ }
}
function armAudioUnlock() {
  const onGesture = () => { if (!muted) unlockAudio(); };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
  window.addEventListener('touchend', onGesture, true);
}
armAudioUnlock();
function whenRunning(ctx, fn) {
  if (!ctx || muted) return;
  if (ctx.state === 'running') { fn(); return; }
  const p = ctx.resume();
  if (p && p.then) p.then(() => { if (!muted && ctx.state === 'running') fn(); }).catch(() => {});
}
function heard(v) { return Math.min(0.34, (v || 0.08) * 1.75); }
function tone(o) {
  const ctx = audio(); if (!ctx) return;
  whenRunning(ctx, () => toneNow(ctx, o));
}
function toneNow(ctx, o) {
  const t = ctx.currentTime + (o.at || 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.f, t);
  if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(30, o.f2), t + o.dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(heard(o.vol), t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  osc.connect(g); g.connect(o.ambient ? busAmbient : busMain);
  osc.start(t); osc.stop(t + o.dur + 0.05);
}
function noiseHit(o) {
  const ctx = audio(); if (!ctx) return;
  whenRunning(ctx, () => noiseNow(ctx, o));
}
function noiseNow(ctx, o) {
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
  g.gain.exponentialRampToValueAtTime(heard(o.vol == null ? 0.05 : o.vol), t + (o.attack || 0.015));
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  src.connect(f); f.connect(g); g.connect(o.ambient ? busAmbient : busMain);
  src.start(t); src.stop(t + o.dur + 0.05);
}
// ---------------------------------------------------------------------------
// KP14 sound redesign: a designed synth library, zero audio files. Every
// event is built from its referent and fired from its ANIMATION BEAT via
// window.KPBeat (or an alert/state hook), never from the raw socket
// message. window.__kpSfxLog records { event, scheduledAt, beatT, beat }
// so the suite can prove sync without ears; the owner's ear is the
// final judge. logSfx is a no-op in audio state 3, so the log never
// claims a sound that stayed silent.
// ---------------------------------------------------------------------------
window.__kpSfxLog = [];
function logSfx(event, beatT, beat) {
  if (muted) return;
  window.__kpSfxLog.push({ event, scheduledAt: performance.now(), beatT: beatT != null ? beatT : performance.now(), beat: beat || 'ui' });
  if (window.__kpSfxLog.length > 300) window.__kpSfxLog.splice(0, window.__kpSfxLog.length - 300);
}
window.KPSfxEvents = ['diceStart', 'diceSettle', 'hop', 'land', 'credit', 'debit', 'buy', 'buildDuplex', 'buildMansion', 'stamp', 'siren', 'clang', 'cardSwish', 'cardSnap', 'cardWahala', 'cardFamily', 'auctionTick', 'gavel', 'phaseLetter', 'newsSting', 'phaseToll', 'turnRise', 'cheer', 'chime', 'tap', 'decline', 'tax', 'lose', 'timeout'];
// Cash and siren are short self-generated samples (ffmpeg, public
// domain, a few KB each). Money uses the register. The siren plays
// only for a real siren beat (Kirikiri), never for a buy.
const SAMPLE_FILES = { cash: '/sfx/cash.mp3', siren: '/sfx/siren.mp3' };
const sampleRaw = {};
const sampleBuf = {};
window.__kpSamplePlays = [];
function primeSamples() {
  for (const name of Object.keys(SAMPLE_FILES)) {
    sampleRaw[name] = fetch(SAMPLE_FILES[name]).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  }
}
primeSamples();
function decodeSample(ctx, name) {
  if (sampleBuf[name]) return Promise.resolve(sampleBuf[name]);
  const pending = sampleRaw[name];
  if (!ctx || !pending) return Promise.resolve(null);
  return pending.then((ab) => {
    if (!ab) return null;
    if (sampleBuf[name]) return sampleBuf[name];
    return ctx.decodeAudioData(ab.slice(0)).then((buf) => { sampleBuf[name] = buf; return buf; });
  }).catch(() => null);
}
function armSamples(ctx) {
  for (const name of Object.keys(SAMPLE_FILES)) decodeSample(ctx, name);
}
function playBuffer(ctx, buf, gain) {
  if (!ctx || !buf) return;
  whenRunning(ctx, () => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain == null ? 0.85 : gain;
    src.connect(g);
    g.connect(busMain);
    try { src.start(); } catch (e) { /* already started */ }
  });
}
function playSample(name, gain) {
  const ctx = audio();
  if (!ctx) return;
  window.__kpSamplePlays.push(name);
  if (window.__kpSamplePlays.length > 40) window.__kpSamplePlays.splice(0, window.__kpSamplePlays.length - 40);
  if (sampleBuf[name]) { playBuffer(ctx, sampleBuf[name], gain); return; }
  const started = performance.now();
  decodeSample(ctx, name).then((buf) => {
    if (buf && performance.now() - started < 900) playBuffer(ctx, buf, gain);
    else if (!buf && name === 'cash') cashInCue(0);
  });
}
let lastCashAt = 0;
function playCash(gain) {
  const now = performance.now();
  if (now - lastCashAt < 420) return;
  lastCashAt = now;
  playSample('cash', gain == null ? 0.85 : gain);
}
window.KPPrepareSfx = () => {
  const ctx = audio();
  if (!ctx) return Promise.resolve(false);
  return Promise.all(Object.keys(SAMPLE_FILES).map((name) => decodeSample(ctx, name)))
    .then(() => !!(sampleBuf.cash && sampleBuf.siren));
};
const jr = (amt) => 1 + (Math.random() * 2 - 1) * amt; // per-play pitch/timing jitter
function coinTick(at, freq, vol) {
  // One coin strike: two detuned sine partials plus a bandpassed click.
  tone({ f: freq * jr(0.02), at, dur: 0.07, vol });
  tone({ f: freq * 1.34 * jr(0.02), at, dur: 0.05, vol: vol * 0.6 });
  noiseHit({ at, dur: 0.02, vol: vol * 0.5, freq: 4300 + Math.random() * 2300, q: 2.5 });
}
function cashInCue(amount) {
  // Money in: three or four coin strikes into a soft drawer. Short,
  // metallic, not a notification ding. Bigger sums add one more coin.
  const n = (amount || 0) >= 200000 ? 4 : 3;
  const pitches = [1480, 1760, 2093, 2349];
  for (let i = 0; i < n; i++) {
    const at = i * 0.062;
    const f = pitches[i] * jr(0.015);
    tone({ f, at, dur: 0.07, type: 'triangle', vol: 0.06 });
    tone({ f: f * 2.37, at, dur: 0.04, type: 'sine', vol: 0.022 });
    noiseHit({ at, dur: 0.012, vol: 0.035, freq: 3100, q: 3.4 });
  }
  const tail = n * 0.062;
  tone({ f: 523, at: tail, dur: 0.07, type: 'triangle', vol: 0.028 });
  tone({ f: 784, at: tail + 0.06, dur: 0.12, type: 'triangle', vol: 0.036 });
  tone({ f: 130, f2: 70, at: tail + 0.02, dur: 0.1, type: 'sine', vol: 0.03 });
}
function coinCascade(amount, durMs) {
  // Money in: metallic drips that accelerate, then settle. The drip
  // count scales with the amount and the run lasts as long as the
  // alert count-up, so the last coin lands as the number settles.
  const n = Math.max(7, Math.min(22, 6 + Math.round(Math.log10((amount || 0) / 1000 + 1) * 6)));
  const total = Math.max(0.25, Math.min(1.6, (durMs || 900) / 1000));
  let t = 0;
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 1 : i / (n - 1);
    coinTick(t, 5600 - 1300 * k, 0.05 + 0.02 * Math.random());
    t += (total / n) * (1.25 - 0.8 * k) * jr(0.15);
  }
  for (let s = 0; s < 3; s++) coinTick(t + s * 0.09, 4200, 0.028); // settling ticks
}
function coinPour() {
  // Money out: shorter, lower pour, with a soft thud under it.
  const n = 5 + Math.floor(Math.random() * 5);
  for (let i = 0; i < n; i++) coinTick(i * 0.055 * jr(0.2), 3400 - 1000 * (i / n), 0.048);
  tone({ f: 150, f2: 80, at: n * 0.055, dur: 0.16, vol: 0.075 });
}
function knockSfx(at, vol) {
  const v = vol || 0.07;
  noiseHit({ at: at || 0, dur: 0.05, vol: v, freq: 480, ftype: 'lowpass' });
  tone({ f: 210, at: at || 0, dur: 0.06, type: 'triangle', vol: v * 0.8 });
}
function paperSlide(at, dur) { noiseHit({ at: at || 0, dur: dur || 0.22, vol: 0.04, freq: 850, freq2: 2400, q: 1.1 }); }
const sfx = {
  credit(amount) { duckAmbient(); playCash(0.9); },
  debit() { playCash(0.8); },
  diceStart() { for (let i = 0; i < 7; i++) noiseHit({ at: i * 0.12 * jr(0.25), dur: 0.035, vol: 0.07 * (1 - i / 9), freq: 1700 + Math.random() * 900, q: 1.6 }); },
  diceSettle(doubles) { knockSfx(0, 0.1); knockSfx(0.09, 0.08); if (doubles) sfx.horn(); },
  hop() { noiseHit({ dur: 0.04, vol: 0.06, freq: 700, ftype: 'lowpass' }); tone({ f: 320, dur: 0.045, vol: 0.045 }); },
  land() { knockSfx(0, 0.12); },
  buy() { playCash(0.9); },
  buildDuplex() { knockSfx(0, 0.08); knockSfx(0.13, 0.08); for (let i = 0; i < 3; i++) coinTick(0.26 + i * 0.06, 5000, 0.045); },
  buildMansion() { coinCascade(500000, 700); [523, 659, 784].forEach((f, i) => tone({ f, at: 0.1 + i * 0.09, dur: 0.3, type: 'triangle', vol: 0.045 })); },
  build(kind) { if (kind === 'mansion') sfx.buildMansion(); else sfx.buildDuplex(); },
  stamp() { paperSlide(0, 0.1); tone({ f: 130, f2: 60, at: 0.05, dur: 0.16, vol: 0.13 }); noiseHit({ at: 0.05, dur: 0.07, vol: 0.05, freq: 420, ftype: 'lowpass' }); },
  // The siren alone; the cell clang is its own beat, retimed to the
  // door visual (KP13 baked it into the siren at a fixed offset).
  siren() { duckAmbient(); playSample('siren', 0.62); },
  clang(at) { tone({ f: 1400, at: at || 0, dur: 0.3, type: 'square', vol: 0.03 }); tone({ f: 220, at: (at || 0) + 0.02, dur: 0.4, type: 'triangle', vol: 0.075 }); },
  // Up NEPA: crowd murmur swell under the bright return notes.
  chime() { noiseHit({ dur: 0.9, vol: 0.04, freq: 480, ftype: 'lowpass', attack: 0.3 }); tone({ f: 880, at: 0.05, dur: 0.14, vol: 0.07 }); tone({ f: 1174, at: 0.16, dur: 0.2, vol: 0.07 }); },
  horn() { tone({ f: 185, dur: 0.16, type: 'sawtooth', vol: 0.055 }); tone({ f: 185, at: 0.22, dur: 0.2, type: 'sawtooth', vol: 0.055 }); },
  cheer() { noiseHit({ dur: 1.1, vol: 0.045, freq: 900, freq2: 1400, q: 0.6, attack: 0.25 }); tone({ f: 659, at: 0.1, dur: 0.12, vol: 0.05 }); tone({ f: 784, at: 0.22, dur: 0.12, vol: 0.05 }); tone({ f: 988, at: 0.34, dur: 0.22, vol: 0.05 }); },
  cardSwish() { paperSlide(0, 0.26); },
  cardSnap() { noiseHit({ dur: 0.04, vol: 0.06, freq: 2100, q: 2 }); tone({ f: 340, dur: 0.05, type: 'triangle', vol: 0.05 }); },
  cardWahala() { paperSlide(0, 0.2); tone({ f: 196, dur: 0.18, type: 'sawtooth', vol: 0.055 }); tone({ f: 146, at: 0.1, dur: 0.22, type: 'triangle', vol: 0.07 }); },
  cardFamily() { paperSlide(0, 0.18); tone({ f: 523, dur: 0.12, type: 'triangle', vol: 0.07 }); tone({ f: 659, at: 0.1, dur: 0.18, type: 'triangle', vol: 0.07 }); },
  swish() { paperSlide(0, 0.26); },
  auctionTick() { tone({ f: 1480, dur: 0.05, vol: 0.07 }); },
  decline() { noiseHit({ dur: 0.14, vol: 0.08, freq: 980, freq2: 360, q: 0.8 }); tone({ f: 220, f2: 110, dur: 0.22, type: 'triangle', vol: 0.08 }); },
  tax() { tone({ f: 311, dur: 0.09, type: 'square', vol: 0.035 }); tone({ f: 233, at: 0.08, dur: 0.18, type: 'triangle', vol: 0.08 }); },
  lose() { tone({ f: 392, f2: 196, dur: 0.36, type: 'triangle', vol: 0.08 }); tone({ f: 247, at: 0.16, f2: 123, dur: 0.42, type: 'triangle', vol: 0.07 }); },
  timeout() { tone({ f: 880, dur: 0.08, vol: 0.09 }); tone({ f: 620, at: 0.1, dur: 0.12, vol: 0.08 }); },
  gavel() { duckAmbient(); knockSfx(0, 0.13); knockSfx(0.13, 0.1); },
  phaseLetter() { paperSlide(0, 0.3); tone({ f: 130, f2: 62, at: 0.22, dur: 0.15, vol: 0.12 }); },
  newsSting() { duckAmbient(); [523, 659, 784].forEach((f, i) => tone({ f, at: i * 0.09, dur: 0.15, type: 'triangle', vol: 0.04 })); noiseHit({ at: 0.27, dur: 0.18, vol: 0.035, freq: 2400, q: 1.5 }); },
  phaseToll() { tone({ f: 196, dur: 0.7, vol: 0.08 }); tone({ f: 147, at: 0.4, dur: 0.9, vol: 0.07 }); },
  phase() { tone({ f: 392, dur: 0.16, type: 'triangle', vol: 0.09 }); tone({ f: 523, at: 0.13, dur: 0.16, type: 'triangle', vol: 0.09 }); tone({ f: 659, at: 0.26, dur: 0.24, type: 'triangle', vol: 0.09 }); },
  turnRise() { tone({ f: 660, dur: 0.1, vol: 0.045 }); tone({ f: 880, at: 0.09, dur: 0.16, vol: 0.045 }); },
  tap() { tone({ f: 1900, dur: 0.02, vol: 0.012, ambient: true }); }
};
// Beat dispatch: renderers call KPBeat at the animation moment and the
// matching sound is scheduled and logged against that beat.
window.KPBeat = (name, data) => {
  const d = data || {};
  logSfx(name, d.t, d.beat || 'render');
  try {
    if (name === 'diceStart') sfx.diceStart();
    else if (name === 'diceSettle') { sfx.diceSettle(!!d.doubles); buzz(12); }
    else if (name === 'hop') sfx.hop();
    else if (name === 'land') sfx.land();
    else if (name === 'build') sfx.build(d.kind);
    else if (name === 'jailIn') { logSfx('siren', d.t, d.beat || 'render'); logSfx('clang', d.t, d.beat || 'render'); sfx.siren(); sfx.clang(1.26); buzz([70, 50, 70]); }
    else if (name === 'cardLift') {
      if (d.deck === 'wahala') sfx.cardWahala();
      else if (d.deck === 'family') sfx.cardFamily();
      else sfx.cardSwish();
    }
    else if (name === 'cardReveal') sfx.cardSnap();
  } catch (e) { /* sound is garnish, never a blocker */ }
};
window.KPSfxHop = () => sfx.hop();
window.KPPreviewSfx = (name) => { if (sfx[name]) sfx[name](); };
function renderMuteBtn() {
  const b = $('muteBtn');
  b.innerHTML = window.icon(audioState === 1 ? 'soundVoice' : audioState === 2 ? 'sound' : 'mute', 20);
  const label = audioState === 1 ? 'Sound and voice on' : audioState === 2 ? 'Sound on, voice off' : 'Sound off';
  b.setAttribute('aria-label', label);
  b.title = label + '. Tap to change.';
}
$('muteBtn').addEventListener('click', () => {
  audioState = audioState % 3 + 1;
  muted = audioState === 3;
  voiceOn = audioState === 1;
  try { localStorage.setItem('kolopolyAudio', String(audioState)); } catch (e) { }
  renderMuteBtn();
  if (audioState === 3 && window.KPRetention) window.KPRetention.muteFromSound();
  if (audioState !== 3) { unlockAudio(); logSfx('tap', null, 'ui'); sfx.tap(); }
});
renderMuteBtn();
// KP14 part 1: the Share button in the freed header slot carries the
// owner's invitation copy: the room form inside a room, the game form
// on the landing.
function sharePayload() {
  if (state && state.code && myCode) {
    return { title: 'Kolopoly', text: 'Join me to play Kolopoly. Room ' + state.code + ' dey wait for you. Break your kolo, buy the street.', url: inviteLink() };
  }
  return { title: 'Kolopoly', text: 'Come and play Kolopoly. Break your kolo, buy the street.', url: location.origin + '/' };
}
async function shareGame() {
  const data = sharePayload();
  if (navigator.share) { try { await navigator.share(data); } catch (e) { /* user closed the sheet */ } return; }
  try { await navigator.clipboard.writeText(data.text + '\n' + data.url); toast('Invite link copied'); }
  catch (e) { toast(data.text + ' ' + data.url, 6000); }
}
$('shareBtn').innerHTML = window.icon('share', 20);
$('shareBtn').addEventListener('click', shareGame);

// Voice payment alerts (Lesson 9): when a credit lands for THIS player, the
// phone announces it out loud in our own words: "Payment received, {amount}"
// plus "from {name}" on rent. The host can switch voice off for the room;
// every player can switch it off (or mute) on their own phone. A newer
// credit supersedes a speaking one. Where the browser blocks speech before
// a user gesture it fails silently and the chime carries the moment.
// KP14: voiceOn is no longer a separate control. It is derived from
// the one three-state audio control (voice lives only in state 1), so
// the spoken alert obeys the same button as every other sound. The
// room-level voiceAlerts setting still gates it, as before.
function speakCredit(line) {
  try {
    if (!voiceOn || muted) return;
    if (state && state.settings && state.settings.voiceAlerts === false) return;
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel(); // a newer credit supersedes a speaking one
    const u = new SpeechSynthesisUtterance(line);
    u.rate = 1.02;
    synth.speak(u);
  } catch (e) { /* speech blocked or unavailable: the chime already played */ }
}

// ---------------------------------------------------------------------------
// Toasts, alerts (the phone style money cards), spray, flicker
// ---------------------------------------------------------------------------
let toastTimer = null;
const toastQueue = [];
let toastShowing = false;
// Toasts queue: a second toast never kills the first early. Ordinary toasts
// hold 4.5s; big moments pass 5000+. Tapping a toast dismisses it.
function toast(html, ms) {
  const item = html && typeof html === 'object'
    ? html
    : { html: html, ms: ms || 4500 };
  item.ms = item.ms || 4500;
  toastQueue.push(item);
  if (toastQueue.length > 3) toastQueue.splice(0, toastQueue.length - 3);
  pumpToast();
}
function pumpToast() {
  if (toastShowing || !toastQueue.length) return;
  toastShowing = true;
  const item = toastQueue.shift();
  const t = $('toast');
  const actions = item.actions || [];
  const buttons = actions.map((a, i) =>
    '<button type="button" class="t-btn' + (a.primary ? ' primary' : ' ghost') + '" data-toast-act="' + i + '">' + esc(a.label) + '</button>'
  ).join('');
  const close = actions.length ? '<button type="button" class="t-btn ghost" data-toast-dismiss="1">Close</button>' : '';
  const body = item.body != null ? esc(item.body) : (item.html || '');
  t.innerHTML =
    (item.title ? '<div class="t-kicker">' + esc(item.title) + '</div>' : '') +
    '<div class="t-body">' + body + '</div>' +
    (buttons || close ? '<div class="t-actions">' + buttons + close + '</div>' : '');
  t.querySelectorAll('[data-toast-act]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = actions[Number(b.dataset.toastAct)];
      if (act && act.run) act.run();
      dismissToast();
    });
  });
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
$('toast').addEventListener('click', (e) => {
  if (e.target.closest('[data-toast-act]')) return;
  dismissToast();
});
const alertQueue = [];
let alertBusy = false;
function queueAlert(kind, amount, text, balanceAfter, voiceLine) {
  alertQueue.push({ kind, amount, text, balanceAfter, voiceLine: voiceLine || null });
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
  // KP14: the amount counts up while the coins sound. The cascade runs
  // exactly the count-up's length, so the last coin lands as the number
  // settles; the spoken line (state 1 only) waits for the cascade tail
  // and never collides with the coins.
  const durMs = isCredit ? 900 : 600;
  logSfx(isCredit ? 'credit' : 'debit', performance.now(), 'alert');
  if (isCredit) sfx.credit(a.amount, durMs); else sfx.debit();
  if (isCredit && a.amount >= 750000) buzz(90); // the biggest hits only
  const amtEl = el.querySelector('.amt');
  const t0 = performance.now();
  const countUp = (now) => {
    // A frame timestamp can precede t0 by a hair; clamp so the amount
    // never flashes a phantom sign mid-count.
    const k = Math.max(0, Math.min(1, (now - t0) / durMs));
    const eased = 1 - Math.pow(1 - k, 3);
    amtEl.textContent = (isCredit ? '+' : '-') + fmtN(Math.round(a.amount * eased));
    if (k < 1) requestAnimationFrame(countUp);
    else amtEl.textContent = (isCredit ? '+' : '-') + fmtN(a.amount);
  };
  requestAnimationFrame(countUp);
  if (a.voiceLine) setTimeout(() => speakCredit(a.voiceLine), durMs + 120);
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
async function requestWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    if (wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { wakeLock = null; }
}
function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { }
  wakeLock = null;
}
function syncWakeLock(room) {
  if (room && room.status === 'playing' && !room.paused) requestWakeLock();
  else releaseWakeLock();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!muted) unlockAudio();
    if (state && state.status === 'playing' && !state.paused) requestWakeLock();
  } else if (document.visibilityState === 'hidden') releaseWakeLock();
});

function showConnBanner(text) {
  if (!connBannerEl) {
    connBannerEl = document.createElement('div');
    connBannerEl.id = 'connBanner';
    connBannerEl.setAttribute('role', 'status');
    document.body.appendChild(connBannerEl);
  }
  connBannerEl.textContent = text;
  connBannerEl.classList.add('show');
}
function hideConnBanner() {
  if (connBannerEl) connBannerEl.classList.remove('show');
}

function bumpLocalActive() {
  lastLocalActive = Date.now();
  if (sessionLive && ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify({ type: 'heartbeat' })); } catch (e) { }
  }
}
window.addEventListener('pointerdown', bumpLocalActive, { passive: true });
window.addEventListener('keydown', bumpLocalActive);

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!sessionLive || !ws || ws.readyState !== 1) return;
    if (Date.now() - lastLocalActive > 20000) return; // idle phone: AFK path owns this
    try { ws.send(JSON.stringify({ type: 'heartbeat' })); } catch (e) { }
  }, 15000);
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);
  ws.onopen = () => {
    hideConnBanner();
    startHeartbeat();
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
    // KP14 audit: with no seat to resume, any entry intent queued while
    // the socket was down flushes now (see send()).
    if (!rejoinPending) flushQueue();
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
    if (msg.type === 'notice') {
      const quiet = msg.action === 'here' || /quiet|seat|bot/i.test(msg.message || '');
      toast({
        title: msg.title || (quiet ? 'You dey quiet' : 'Kolopoly'),
        body: msg.message || '',
        ms: quiet ? 7000 : 5200,
        actions: quiet ? [{ label: 'I dey here', primary: true, run: () => bumpLocalActive() }] : []
      });
      return;
    }
    if (msg.type === 'shelf') {
      if (msg.inventory) shelfView = Object.assign({}, shelfView || {}, { inventory: msg.inventory, ok: true });
      const box = document.querySelector('#hudSheet #shelfBox');
      if (box && shelfView) paintShelfBox($('hudSheet'));
      if (msg.line) toast(esc(msg.line));
      return;
    }
    if (msg.type === 'state') {
      if (!sessionLive) { sessionLive = true; flushQueue(); }
      onState(msg.room); return;
    }
  };
  ws.onclose = (ev) => {
    sessionLive = false;
    stopHeartbeat();
    if (ev && ev.code === 4001) {
      // The seat was taken by a newer tab or window on purpose: sign this
      // one out of the game instead of fighting over the seat.
      clearSeat();
      entrySent = false;
      hideConnBanner();
      releaseWakeLock();
      showView('view-landing');
      toast('Your seat don open for another tab or window. This one don sign out.', 5200);
      return;
    }
    if (ev && ev.code === 4002) {
      // AFK bot took the seat: keep the seat token so a return can reclaim.
      showConnBanner('You don go quiet. A bot dey hold your seat. Come back sharp to reclaim.');
      setTimeout(connect, 1800);
      return;
    }
    // Soft drop: never scream "disconnected" while the seat is still held.
    if (hasSeat) showConnBanner('Link dey reconnect. Your seat and money dey held.');
    setTimeout(connect, 1800);
  };
}
function flushQueue() {
  while (sendQueue.length && ws && ws.readyState === 1) {
    const m = sendQueue.shift();
    // KP14 audit: a queued entry intent is stale the moment a seat is
    // live; dropping it beats joining a second room by accident.
    if (sessionLive && ENTRY_TYPES.has(m.type)) continue;
    ws.send(JSON.stringify(Object.assign({ type: m.type }, m.obj || {})));
  }
}
// KP14 audit: entry clicks made before the socket finished connecting
// were silently lost (the handlers had already latched entrySent, so
// the room never happened and no retry was possible). Entry intents
// now queue exactly once while the socket is down and flush on open.
const ENTRY_TYPES = new Set(['create_room', 'quick_join', 'join_room']);
function send(type, obj) {
  if (!ws || ws.readyState !== 1) {
    if (ENTRY_TYPES.has(type) && !sendQueue.some((m) => ENTRY_TYPES.has(m.type))) sendQueue.push({ type, obj });
    return;
  }
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
  // KP14 re-engineer: the hero token-rain strip is gone (decoration
  // competing with the determiner); tokens live in this compact strip.
  $('tokenGrid').innerHTML = window.KP_DATA.TOKENS.map((t) =>
    '<button type="button" class="token-pick' + (t.id === selectedToken ? ' sel' : '') + '" data-token="' + t.id + '">' + window.tokenArt(t.id, 30) + '<span>' + esc(t.name) + '</span></button>').join('');
  $('tokenGrid').querySelectorAll('[data-token]').forEach((b) => b.addEventListener('click', () => {
    selectedToken = b.dataset.token;
    try { localStorage.setItem('kolopolyToken', selectedToken); } catch (e) { }
    $('tokenGrid').querySelectorAll('[data-token]').forEach((x) => x.classList.toggle('sel', x === b));
  }));
}
buildTokenPickers();
// KP14 re-engineer: host fine-tuning (preset, room type, house rules)
// lives behind ONE collapsed Room settings disclosure. Every control
// keeps its id and default; create reads them exactly as before, so a
// room created without ever opening the disclosure is unchanged.
$('settingsToggle').addEventListener('click', () => {
  const open = $('roomSettings').classList.toggle('hidden') === false;
  $('settingsToggle').setAttribute('aria-expanded', String(open));
  $('settingsToggle').classList.toggle('open', open);
});
// KP15 hero: the DOM street sleeps when it is off-screen, and its
// layers drift a few px against pointer and scroll (transform writes
// to layer wrappers only; the vehicles and the story animate inside
// their layer on their own clocks). Reduced motion skips all of it.
(function () {
  const scene = document.querySelector('.hero-scene');
  if (!scene) return;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => {
      for (const e of es) scene.classList.toggle('hs-off', !e.isIntersecting);
    }, { threshold: 0.02 }).observe(scene);
  }
  const rm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (rm && rm.matches) return;
  const layers = scene.querySelectorAll('[data-plx]');
  if (!layers.length) return;
  let tPX = 0, tPY = 0, cPX = 0, cPY = 0, sY = 0, raf = 0;
  const apply = () => {
    raf = 0;
    cPX += (tPX - cPX) * 0.08; cPY += (tPY - cPY) * 0.08;
    layers.forEach((l) => {
      const d = parseFloat(l.getAttribute('data-plx')) || 0;
      l.style.transform = 'translate3d(' + (cPX * d * 9).toFixed(2) + 'px,' + (cPY * d * 5 + sY * d * 7).toFixed(2) + 'px,0)';
    });
    if (Math.abs(tPX - cPX) > 0.001 || Math.abs(tPY - cPY) > 0.001) raf = requestAnimationFrame(apply);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(apply); };
  const hero = document.querySelector('.landing-hero');
  if (hero && window.matchMedia('(pointer: fine)').matches) {
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      tPX = ((e.clientX - r.left) / Math.max(1, r.width) - 0.5) * 2;
      tPY = ((e.clientY - r.top) / Math.max(1, r.height) - 0.5) * 2;
      kick();
    });
    hero.addEventListener('pointerleave', () => { tPX = 0; tPY = 0; kick(); });
  }
  window.addEventListener('scroll', () => {
    sY = Math.min(window.scrollY || 0, 240) / 240;
    kick();
  }, { passive: true });
})();
$('nameIn').value = localStorage.getItem('kolopolyName') || '';
$('nameIn').addEventListener('change', () => localStorage.setItem('kolopolyName', $('nameIn').value.trim()));
paintGameMode();
// Create options persist beside the name, token, mode and audio keys.
const OPT_IDS = ['optTimed', 'optDoubleStart', 'optNoRentJail', 'optFirstLap', 'optChaos', 'optVoice', 'optTimer', 'presetSel'];
try {
  const savedOpts = JSON.parse(localStorage.getItem('kolopolyCreateOpts') || 'null');
  if (savedOpts) for (const id of OPT_IDS) {
    const el = $(id);
    if (!el || savedOpts[id] === undefined) continue;
    if (el.type === 'checkbox') el.checked = !!savedOpts[id];
    else if ([...el.options].some((o) => o.value === String(savedOpts[id]))) el.value = String(savedOpts[id]);
  }
} catch (e) { }
for (const id of OPT_IDS) {
  const el = $(id);
  if (el) el.addEventListener('change', () => {
    try {
      const out = {};
      for (const k of OPT_IDS) { const x = $(k); if (x) out[k] = x.type === 'checkbox' ? x.checked : x.value; }
      localStorage.setItem('kolopolyCreateOpts', JSON.stringify(out));
    } catch (e) { }
  });
}
$('gameModeRow').querySelectorAll('[data-gmode]').forEach((b) => b.addEventListener('click', () => {
  selectedGameMode = b.dataset.gmode;
  try { localStorage.setItem('kolopolyGameMode', selectedGameMode); } catch (e) { }
  paintGameMode();
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
      voiceAlerts: $('optVoice').checked,
      turnTimerSec: Number($('optTimer').value)
    }
  });
});
$('quickBtn').addEventListener('click', () => {
  if (!needName() || entrySent) return;
  clearSeat();
  entrySent = true;
  send('quick_join', { name: myName(), token: selectedToken, clientId: CLIENT_ID, gameMode: selectedGameMode });
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
  if (window.KPRetention) window.KPRetention.placeMarket();
  if (focusId) { const el = $(focusId); if (el) el.focus(); }
}
// A remembered player acts first. The name sits once beside the token.
// Editing is one tap away, never a fresh form by default.
(function setupWelcome() {
  const name = rememberedName();
  if (!name || inviteCode) return;
  $('welcomeTitle').textContent = name;
  $('welcomeToken').innerHTML = tokenArtFor(selectedToken);
  $('welcomeSub').textContent = '';
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
  fetch('/api/room/' + code + '?clientId=' + encodeURIComponent(CLIENT_ID || '')).then((r) => r.json()).then((info) => {
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
      return;
    }
    // Lesson 3: this device already holds a seat in the room. Say so on the
    // prompt, with the seat's own name, instead of silently joining under a
    // second identity. Joining reclaims that seat; a different name is a
    // Change away and applies from the next game.
    const seat = info.yourSeat;
    if (seat && (!name || seat.name !== name || seat.token !== selectedToken)) {
      const tokName = (window.KP_DATA.TOKENS.find((t) => t.id === seat.token) || {}).name || seat.token;
      $('inviteAs').textContent = 'You get one seat here as ' + seat.name;
      $('inviteToken').innerHTML = tokenArtFor(seat.token);
      $('inviteMeta').textContent = info.players + (info.players === 1 ? ' player' : ' players') + ' inside · your seat dey here as ' + seat.name + ' (' + tokName + '). Join to reclaim am. Another name? Tap Change: the new name go start from your next game.';
      $('inviteJoinBtn').textContent = 'Join as ' + seat.name;
    }
  }).catch(() => { $('inviteMeta').textContent = 'Room ' + code + '. Join when you ready.'; });
  $('inviteJoinBtn').addEventListener('click', () => {
    if (inviteInfo && (!inviteInfo.exists || inviteInfo.full)) { location.href = location.pathname; return; }
    const seatName = inviteInfo && inviteInfo.yourSeat ? inviteInfo.yourSeat.name : null;
    const joinName = name || seatName;
    if (!joinName) { revealForm('nameIn'); return; }
    if (entrySent) return;
    clearSeat();
    entrySent = true;
    joinSentFor = code;
    send('join_room', { code, name: joinName, token: selectedToken, clientId: CLIENT_ID });
  });
  $('inviteChangeBtn').addEventListener('click', () => revealForm('nameIn'));
}

// ---------------------------------------------------------------------------
// State rendering
// ---------------------------------------------------------------------------
function showView(id) {
  for (const v of ['view-landing', 'view-lobby', 'view-game']) $(v).classList.toggle('active', v === id);
  document.body.classList.toggle('in-game', id === 'view-game');
  if (id === 'view-game' && window.KPShell) window.KPShell.refresh('enter');
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
  hideConnBanner();
  if (room.status === 'playing') { unlockAudio(); syncWakeLock(room); }
  else releaseWakeLock();
  // End hang fix: drop the persisted seat so a refresh returns to landing
  // instead of rejoining into the result card forever. Keep the live
  // session so Play again and Leave still work on this tab.
  if (room.status === 'ended') {
    try { sessionStorage.removeItem('kolopolySeat'); } catch (e) { }
  }
  const meNow = room.players.find((p) => p.id === myId);
  if (meNow && meNow.token) { try { localStorage.setItem('kolopolyToken', meNow.token); } catch (e) { } }
  if (prev && prev.auction && !room.auction && room.status === 'playing') { logSfx('gavel', null, 'state'); sfx.gavel(); }
  // KP14: a fresh high bid ticks softly; the turn arriving at THIS seat
  // gets the two-note rise. Both are render beats of this state push.
  if (prev && prev.auction && room.auction && room.auction.highBid !== prev.auction.highBid) { logSfx('auctionTick', null, 'state'); sfx.auctionTick(); }
  if (prev && room.status === 'playing' && prev.turnPlayerId !== room.turnPlayerId && room.turnPlayerId) { logSfx('turnRise', null, 'turnRender'); sfx.turnRise(); }
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
  updateRoomChip(room);
  // Lesson 10: which game am I in, always on screen.
  const mp = $('modePill');
  if (room.code) {
    mp.classList.remove('hidden');
    mp.classList.add('mode-live');
    const face = room.inf ? phaseFace(room.inf.phaseName) : '';
    mp.textContent = room.inf ? 'Inflation' : 'Classic';
    const full = room.inf
      ? ('Inflation, ' + face)
      : (room.settings.timed ? 'Classic clock' : 'Classic, untimed');
    mp.title = full;
    mp.setAttribute('aria-label', full);
  } else mp.classList.add('hidden');
  processFeed(room, prev);
  processPositions(room);
  if (room.status === 'lobby') renderLobby(room);
  if (room.status === 'playing' || room.status === 'ended' || room.status === 'countdown') renderGame(room);
  if (room.status === 'ended') renderEnd(room);
  prevStatus = room.status;
}

const PHASE_FACE = {
  'Settling': 'Calm market',
  'Inflation': 'Rent don rise',
  'Sapa': 'Sapa dey',
  'Sudden Death': 'Last round'
};
function phaseFace(name) { return PHASE_FACE[name] || name || ''; }
function cueBoard(e, focusIds) {
  const mine = e.playerId != null && focusIds.includes(e.playerId);
  const t = e.text || '';
  if (e.kind === 'deed' && e.amount != null) { logSfx('buy', null, 'feed'); sfx.buy(); return; }
  if (e.kind === 'card') {
    if (window.KP3D && window.KP3D.active) return;
    if (/Wahala/.test(t)) { logSfx('cardWahala', null, 'feed'); sfx.cardWahala(); }
    else { logSfx('cardFamily', null, 'feed'); sfx.cardFamily(); }
    return;
  }
  if (e.kind === 'kirikiri') {
    if (!(window.KP3D && window.KP3D.active)) { logSfx('siren', null, 'feed'); sfx.siren(); sfx.clang(0.35); }
    return;
  }
  if (e.kind === 'timeout') { logSfx('timeout', null, 'feed'); sfx.timeout(); return; }
  if (e.kind === 'auction') { logSfx('decline', null, 'feed'); sfx.decline(); return; }
  if (e.kind === 'jackpot' || e.kind === 'gameEnd') return;
  if (/mortgag|C of O don enter/i.test(t)) { logSfx('stamp', null, 'feed'); sfx.stamp(); }
  if (e.kind === 'debit' && /FIRS|Income Tax|tax/i.test(t)) { logSfx('tax', null, 'feed'); sfx.tax(); }
  if ((e.kind === 'credit' || e.kind === 'debit') && !mine) {
    logSfx(e.kind, null, 'feed');
    if (e.kind === 'credit') sfx.credit(e.amount || 10000, 480);
    else sfx.debit();
  }
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
    // Spoken credit announcement, receiver's phone only (Lesson 9). Debits
    // never speak. Rent names the payer; salary and the pot stay unnamed.
    // KP14: the line is computed here but SPOKEN by the alert pump, after
    // the coin cascade tail, so voice and coins never collide.
    let voiceLine = null;
    if (e.kind === 'credit' && room.mode !== 'pass' && e.playerId === myId) {
      const amt = String(Math.round(e.amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      voiceLine = 'Payment received, ' + amt + ' naira';
      const other = e.otherId != null ? room.players.find((x) => x.id === e.otherId) : null;
      if (other && e.spaceName) voiceLine += ' from ' + other.name;
      voiceLine += '.';
    }
    if ((e.kind === 'credit' || e.kind === 'debit') && focusIds.includes(e.playerId)) {
      const p = room.players.find((x) => x.id === e.playerId);
      queueAlert(e.kind, e.amount, e.text, p ? p.cash : null, voiceLine);
    }
    // A purchase sounds when the deed lands in the feed, not on the
    // button tap (a tap can be refused; the feed cannot lie). The
    // mansion-build deed entry carries no amount and stays silent here:
    // its sound is the build beat.
    cueBoard(e, focusIds);
    // Kirikiri: the siren and clang ride the jailIn animation beat now
    // (retimed to the door visual); the feed keeps the buzz only.
    if (e.kind === 'kirikiri') { buzz([70, 50, 70]); }
    if (e.kind === 'timeout') toast(esc((e.auto ? '(auto) ' : '') + e.text), 5200);
    if (e.kind === 'jackpot' && e.amount < 100000) { logSfx('chime', null, 'feed'); sfx.chime(); }
    if (e.kind === 'jackpot' && e.amount >= 100000) {
      spray();
      logSfx('cheer', null, 'feed');
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
      // Phase 2 arrives as the landlord's letter (paper + stamp thud),
      // Phase 3 breaks like a news sting, Phase 4 tolls low, the rest
      // keep the rising tones.
      if (room.inf && room.inf.phase === 2) { logSfx('phaseLetter', null, 'feed'); sfx.phaseLetter(); }
      else if (room.inf && room.inf.phase === 3) { logSfx('newsSting', null, 'feed'); sfx.newsSting(); }
      else if (room.inf && room.inf.phase === 4) { logSfx('phaseToll', null, 'feed'); sfx.phaseToll(); }
      else sfx.phase();
      showPhaseCeremony(room, e);
    }
  }
  if (room.lastCard && room.lastCard.seq !== lastCardSeq) {
    lastCardSeq = room.lastCard.seq;
    const drawer = room.lastCard.playerId;
    if (room.mode === 'pass' || drawer === myId) showCardModal(room.lastCard);
  }
  // KP14: dice sounds no longer fire on socket time. The tumble and the
  // settle are animation beats (diceStart / diceSettle) in the board
  // renderers, and the doubles horn moved into diceSettle with them.
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
  unlockAudio();
  let n = 3;
  num.textContent = n;
  logSfx('knock', null, 'countdown'); try { sfx.hop(); } catch (e) { }
  const iv = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      clearInterval(iv);
      num.textContent = 'GO';
      logSfx('horn', null, 'countdown'); try { sfx.horn(); } catch (e) { }
      setTimeout(() => o.classList.remove('show'), 450);
    } else {
      num.textContent = n;
      num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
      logSfx('hop', null, 'countdown'); try { sfx.hop(); } catch (e) { }
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
  // KP14 audit: a pass-and-play room can never be joined (join_room
  // refuses it and /api/room answers exists:false), so its code hero,
  // caption and invite machinery hide. The code is decoration there.
  const passRoom = room.mode === 'pass';
  for (const id of ['lobbyCodeCap', 'lobbyCodeHero']) { const el = $(id); if (el) el.classList.toggle('hidden', passRoom); }
  document.querySelectorAll('.invite-actions').forEach((el) => el.classList.toggle('hidden', passRoom));
  const qrEl = $('inviteQr'); if (qrEl) qrEl.classList.toggle('hidden', passRoom);
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
      '<div><div class="nm">' + esc(p.name) + (p.bot ? ' <span class="bot-tag">BOT</span>' : '') + (p.isHost ? ' ' + window.icon('crown', 14) : '') + '</div>' +
      '<div class="meta">' + (p.bot ? 'Bot player · always ready' : room.mode === 'pass' ? 'On this phone' : p.connected ? 'Connected' : 'Disconnected') + '</div></div>' +
      (room.mode === 'pass' && myId === room.hostId && p.id !== room.hostId ? '<button class="btn small ghost" data-remove-local="' + p.id + '" style="margin-left:auto;">Remove</button>' : '') +
      (p.bot && myId === room.hostId ? '<button class="btn small ghost" data-remove-bot="' + p.id + '" style="margin-left:auto;">Remove</button>' : '') + '</div>';
  }).join('');
  $('slotBoard').querySelectorAll('[data-remove-local]').forEach((b) => b.addEventListener('click', () => send('remove_local_player', { playerId: Number(b.dataset.removeLocal) })));
  $('slotBoard').querySelectorAll('[data-remove-bot]').forEach((b) => b.addEventListener('click', () => send('remove_bot', { playerId: Number(b.dataset.removeBot) })));
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
  // Lesson 1: the host is inside the grace window. The room is alive and
  // waiting for them, and nobody can start without them.
  if (room.hostAway) {
    $('startBtn').style.display = 'none';
    $('lobbyHint').textContent = 'Host step out small, room go wake when e return.';
  }
  // Bots (the owner's ask): right after the host creates a room, ask once:
  // "Wanna play with bot?" The host can still add bots later with the Add
  // bot button, up to 4 seats total. Pass and play rooms never see bots.
  const canBots = room.mode !== 'pass' && isHost && room.players.length < 4;
  let botAsked = false;
  try { botAsked = !!sessionStorage.getItem('kolopolyBotAsked:' + room.code); } catch (e) { /* private mode */ }
  $('botPrompt').classList.toggle('hidden', !(canBots && !botAsked && !room.players.some((p) => p.bot)));
  $('addBotBtn').classList.toggle('hidden', !canBots);
}
$('copyInviteBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(inviteLink()); toast('Invite link copied. Send am give your people.'); }
  catch { toast('Copy no work. The link na: ' + inviteLink(), 6000); }
});
$('shareInviteBtn').addEventListener('click', async () => {
  // KP14 audit: the lobby Share button speaks the owner's approved
  // invitation copy, same as the header Share button in a room.
  const data = { title: 'Kolopoly', text: 'Join me to play Kolopoly. Room ' + state.code + ' dey wait for you. Break your kolo, buy the street.', url: inviteLink() };
  if (navigator.share) { try { await navigator.share(data); } catch { /* user closed */ } }
  else { try { await navigator.clipboard.writeText(data.text + '\n' + data.url); toast('Invite link copied.'); } catch { toast(data.text + ' ' + data.url, 6000); } }
});
$('addLocalBtn').addEventListener('click', () => {
  const name = $('localNameIn').value.trim();
  if (!name) { toast('Type the player name first.'); return; }
  send('add_local_player', { name, token: selectedToken });
  $('localNameIn').value = '';
});
$('startBtn').addEventListener('click', () => send('start_game', {}));
function dismissBotPrompt() {
  try { if (state) sessionStorage.setItem('kolopolyBotAsked:' + state.code, '1'); } catch (e) { /* private mode */ }
  $('botPrompt').classList.add('hidden');
}
$('botAdd1').addEventListener('click', () => { send('add_bot', {}); dismissBotPrompt(); });
$('botAdd2').addEventListener('click', () => { send('add_bot', {}); setTimeout(() => send('add_bot', {}), 200); dismissBotPrompt(); });
$('botNone').addEventListener('click', () => dismissBotPrompt());
$('addBotBtn').addEventListener('click', () => send('add_bot', {}));
$('leaveLobbyBtn').addEventListener('click', () => { send('leave', {}); clearSeat(); setTimeout(() => location.reload(), 250); });

// ---------------------------------------------------------------------------
// Game rendering
// ---------------------------------------------------------------------------
window.KPBoard.build($('board'));
window.KPBoard.onSpaceTap = (i) => onSpaceTap(i);
// KP12: the note fan is gone; one banknote glyph badges the cash segment.
{ const cb = $('cashBadge'); if (cb) cb.innerHTML = window.icon('bill', 17); }

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
    const act = b.dataset.act;
    const scrim = root.closest('.scrim');
    const as = state.mode === 'pass' ? viewer : undefined;
    const sendAct = (type, obj) => { const o = Object.assign({}, obj || {}); if (as != null) o.as = as; send(type, o); };
    // Deals sit on the deed itself. These open their own sheet.
    if (act === 'deal-swap') { if (scrim) scrim.classList.remove('show'); openTrade(null, space); return; }
    if (act === 'deal-pass') { if (scrim) scrim.classList.remove('show'); openDeedPass(space); return; }
    if (act === 'deal-loan') { if (scrim) scrim.classList.remove('show'); openDeedLoan(space); return; }
    if (act === 'deal-break') { sendAs('call_deal_break', {}); if (scrim) scrim.classList.remove('show'); return; }
    // KP14: build clicks stay silent. A click sound would lie when the
    // server refuses; the build beat sounds when the building lands.
    if (act === 'build-duplex') { sendAct('build', { space, kind: 'duplex' }); }
    if (act === 'build-mansion') { sendAct('build', { space, kind: 'mansion' }); }
    if (act === 'sell-building') sendAct('sell_building', { space });
    if (act === 'mortgage') sendAct('mortgage', { space });
    if (act === 'unmortgage') sendAct('unmortgage', { space });
    setTimeout(() => { if (scrim) scrim.classList.remove('show'); }, 120);
  }));
}

// Lesson 14: a paused game speaks. A named waiting card covers the board:
// who is missing, how long the wait has run, the frozen turn clock value,
// and the controls underneath visibly disabled instead of silently dead.
function renderPause(room) {
  const o = $('pauseOverlay');
  const show = !!(room.paused && room.status === 'playing' && room.mode !== 'pass');
  $('view-game').classList.toggle('is-paused', show);
  if (!show) { o.classList.remove('show'); o.innerHTML = ''; return; }
  const missing = room.players.filter((p) => !p.connected && !p.bankrupt).map((p) => p.name);
  const clockTxt = room.pauseClockMs != null
    ? 'Turn clock dey frozen at ' + Math.round(room.pauseClockMs / 1000) + 's. E go continue from there when dem return.'
    : 'Turn clock no dey run for this turn.';
  o.innerHTML = '<div class="pause-card"><h3 class="title">Game dey pause</h3>' +
    '<p class="lead" style="margin-top:8px;">We dey wait for <b>' + esc(missing.join(', ') || 'a player') + '</b> to return.</p>' +
    '<p class="caption" id="pauseElapsed">Waiting don reach 0:00.</p>' +
    '<p class="caption">' + clockTxt + '</p>' +
    '<p class="caption">Your seat and your money dey held. Controls go wake the moment dem return.</p></div>';
  o.classList.add('show');
}

// KP13 WS4: per-seat banner copy. The server sends a key + actor +
// params; each client picks the form for its own seat. Short enough to
// stay one line in the slim message bar at 360px in the common cases.
function bannerText(b, mine) {
  const n = b.name || '';
  switch (b.key) {
    case 'opener': return mine ? 'Game don start. Na your turn, ' + n + '.' : 'Game don start. Na ' + n + ' turn.';
    case 'turn': return mine ? 'Na your turn, ' + n + '. Roll the dice.' : 'Na ' + n + ' turn. E dey roll.';
    case 'turn_jail': return mine ? 'Na your turn, ' + n + '. You dey Kirikiri.' : 'Na ' + n + ' turn. E dey Kirikiri.';
    case 'doubles': return mine ? 'Double! Na you go roll again.' : n + ' throw double. E dey roll again.';
    case 'roll_now': return mine ? 'You don free, ' + n + '. Roll the dice.' : n + ' don free. E dey roll now.';
    case 'debt': return mine ? 'You owe ' + b.amount + ' (' + b.reason + '). Sell, mortgage, trade, or declare bankruptcy.' : n + ' owes ' + b.amount + ' (' + b.reason + '). E dey raise the money.';
    case 'rescue': return mine ? 'You win the auction but money no complete. Rescue window: sell, mortgage or borrow. 45 seconds.' : n + ' win the auction but money no complete. Rescue window dey run.';
    default: return '';
  }
}
function renderGame(room) {
  // KP9: no Classic bar. The Classic match clock lives in the header room
  // chip (updateRoomChip); Inflation keeps its phase strip below.
  // Inflation bar
  const infBar = $('infBar');
  if (room.inf) {
    infBar.classList.remove('hidden');
    // KP20: the strip's water chip is a droplet plus the price, so the
    // one line fits whole at 360 (KP19 audit). The full "Pure water ₦X"
    // wording rides the chip's accessible name and title, and stays
    // untouched in the horns, sheets and explainers. The droplet is an
    // inline SVG in the icon wrapper's exact stroke style (icons.js
    // has no drop glyph; KP20's file scope is app.js and style.css).
    const pwAmt = [50, 100, 200, 500][room.inf.phase - 1];
    const priceWord = room.inf.index <= 1 ? 'Printed prices' : ('Prices ' + room.inf.index + 'x');
    // The phase name, index and water price stay in the DOM for the
    // gauge, but the bar itself is out of the layout. The clock the
    // player reads is the header chip. Deal Break and contracts live
    // on the Deals sheet, one door.
    infBar.innerHTML = '<span class="ph">' + esc(phaseFace(room.inf.phaseName)) + '</span>' +
      '<span class="idx" title="How dear things don be, against the printed board">' + priceWord + '</span>' +
      '<span class="water-chip" role="img" aria-label="Pure water ₦' + pwAmt + '" title="Pure water ₦' + pwAmt + '"><svg class="ic" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2c2.9 3.7 6.3 7.5 6.3 11a6.3 6.3 0 1 1-12.6 0c0-3.5 3.4-7.3 6.3-11z"/><path d="M9.3 14.6a2.8 2.8 0 0 0 1.9 3.2"/></svg>₦' + pwAmt + '</span>' +
      '<span class="clk" id="infClock"></span>';
  } else {
    infBar.classList.add('hidden');
  }
  // KP13 WS4: addressee-directed lines render per seat from the
  // server's structured banner (key + actor), never from one shared
  // string: the actor reads the second person form, everyone else a
  // third person report. Shared factual lines (room.message) stay
  // identical everywhere, which is correct for them. On the shared
  // pass-and-play phone the acting seat is the viewer.
  let msgOut = room.message || '';
  if (room.banner && room.status === 'playing') {
    const mine = room.mode === 'pass' ? room.banner.actorId === actingId() : room.banner.actorId === myId;
    msgOut = bannerText(room.banner, mine);
  }
  $('msgText').textContent = msgOut;
  // WS3 actor cue: a small token disc in the acting player's colour at
  // the left of the message bar.
  const cueEl = $('msgCue');
  if (cueEl) {
    const cueP = room.players.find((p) => p.id === (room.banner && room.banner.actorId != null ? room.banner.actorId : room.turnPlayerId));
    if (cueP && room.status === 'playing') {
      cueEl.style.display = '';
      cueEl.style.background = cueP.color;
      cueEl.innerHTML = window.icon(cueP.token, 13);
    } else cueEl.style.display = 'none';
  }
  // Players strip
  $('playersStrip').innerHTML = room.players.map((p) => {
    const loanMark = room.inf && room.inf.contracts.some((c) => c.type === 'loan' && c.borrower === p.id) ? ' · loan' : '';
    return '<div class="pchip' + (p.id === room.turnPlayerId ? ' turn' : '') + (p.bankrupt ? ' bankrupt' : '') + (p.inJail ? ' jailed' : '') + '">' +
      '<span class="avatar" style="background:' + p.color + '">' + window.icon(p.token, 15) + '</span>' +
      '<span><span class="nm">' + esc(p.name) + (p.bot ? ' <span class="bot-tag">' + (p.afkTaken ? 'AFK' : 'BOT') + '</span>' : '') + (p.chaosRole ? ' (' + p.chaosRole + ')' : '') + '</span> ' +
      '<span class="cash">' + fmtN(p.cash) + '</span><span class="meta"> · ' + p.deeds + ' deeds' + loanMark + '</span></span></div>';
  }).join('');
  // Board legal highlights for build placement
  if (room.buildPlace && room.buildPlace.playerId === actingId()) {
    const set = new Set();
    for (let i = 0; i < 40; i++) if (window.KPBoard.canBuildHere(room, actingId(), i, room.buildPlace.kind)) set.add(i);
    window.KPBoard.legalSet = set;
  } else window.KPBoard.legalSet = null;
  window.KPBoard.render(room);
  paintHud(room);
  renderWallet(room);
  renderActionBar(room);
  renderAuction(room);
  renderPause(room);
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

function paintCash(n) {
  const s = typeof n === 'number' ? fmtN(n) : String(n);
  const w = $('walletCash'); if (w) w.textContent = s;
  const h = $('hudCashAmt'); if (h) h.textContent = s;
}
function renderWallet(room) {
  const fp = focusPlayer();
  const cashBtn = $('hudCashBtn');
  if (!fp) {
    paintCash('Spectating');
    $('walletLabel').textContent = 'YOU DEY WATCH';
    if (cashBtn) cashBtn.classList.remove('warn');
    return;
  }
  $('walletLabel').textContent = (room.mode === 'pass' ? esc(fp.name).toUpperCase() + "'S CASH" : 'YOUR CASH');
  if (cashBtn) cashBtn.classList.toggle('warn', !!(fp.sapa && fp.sapa.warn));
  const target = fp.cash;
  if (displayedCash === null || Math.abs(target - displayedCash) < 1) {
    displayedCash = target;
    paintCash(target);
  } else {
    const from = displayedCash;
    const start = performance.now();
    if (cashAnim) cancelAnimationFrame(cashAnim);
    const stepFn = (t) => {
      const k = Math.min(1, (t - start) / 550);
      displayedCash = Math.round(from + (target - from) * k);
      paintCash(displayedCash);
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

// Lesson 4: primary action labels never mutate. The countdown lives in
// its own control beside the button, never inside the label. KP12: that
// control is a progress ring badge overlapping the pill's right end. The
// number span keeps the data-deadline contract the ticker text sweep and
// the beep pulses already speak; the ring itself depletes in the ticker.
const RING_CIRC = 116.24; // 2 * pi * 18.5, the badge's ring radius
function clockChip(deadline) {
  if (!deadline) return '';
  const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  return '<span class="timer-ring" data-ring-deadline="' + deadline + '" role="timer" aria-label="' + s + ' seconds left">' +
    '<svg viewBox="0 0 42 42" aria-hidden="true"><circle class="ring-bg" cx="21" cy="21" r="18.5"></circle>' +
    '<circle class="ring-fg" cx="21" cy="21" r="18.5"></circle></svg>' +
    '<span class="ring-num" data-deadline="' + deadline + '">' + s + 's</span></span>';
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
    html = '';
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
    // Lesson 5: management stays open. The hint lives in the players sheet,
    // not as a second paragraph under the board.
    html = '';
  } else {
    // My action (online: me; pass: the turn player, acting through this phone)
    const actor = room.mode === 'pass' ? turn : me;
    if (actor.pendingChoice != null) {
      html = '<p class="caption" style="align-self:center;">You carry a mortgaged deed choice. Settle am for the popup first.</p>';
    } else if (room.phase === 'roll') {
      html = '<button class="btn green" id="abRoll">' + window.icon('dice', 20) + ' Roll dice</button>' + clockChip(room.turnDeadline);
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
      html = '<button class="btn dark" id="abEnd">End turn</button>' + clockChip(room.turnDeadline);
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
  wire('abBuy', () => { sendAs('buy', {}); }); // KP14: the buy sound fires on the deed feed entry, not the tap
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
  // Secondary row (KP9): a bottom-nav icon bar. IconSax glyphs (vendored
  // under public/icons/, mapped through the icons.js helper) over 11px
  // labels. Ids, wiring and the two-tap armed states are exactly the ones
  // the old text buttons carried.
  const ubtn = (id, ic, label, armed) =>
    '<button class="ubtn' + (armed ? ' armed' : '') + '" id="' + id + '">' +
    '<span class="u-ic">' + window.icon(ic, 21) + '</span>' +
    '<span class="u-lb">' + label + '</span></button>';
  let secHtml = ubtn('sbDeeds', 'docText', 'Deeds');
  secHtml += ubtn('sbLog', 'book', 'Log');
  // Lesson 11: a way out, with an honest two tap confirm. The host also
  // carries the room ending option.
  if (!spectator && me && !me.bankrupt && room.status === 'playing') {
    secHtml += ubtn('sbLeave', 'logout', leaveArmed ? 'Sure?' : 'Leave', leaveArmed);
    if (myId === room.hostId) secHtml += ubtn('sbEndRoom', 'tickCircle', endRoomArmed ? 'Sure?' : 'End', endRoomArmed);
  }
  sec.innerHTML = secHtml;
  wire('sbDeeds', () => openMyDeeds());
  wire('sbLog', () => openGist());
  wire('sbLeave', () => {
    if (!leaveArmed) { leaveArmed = true; renderActionBar(room); setTimeout(() => { leaveArmed = false; if (state) renderActionBar(state); }, 4000); return; }
    leaveArmed = false;
    sendAs('resign', {});
    // KP13 WS2: a confirmed leave is final. The leaver's own client
    // exits to the landing at once, the same way the lobby Leave flow
    // already leaves; it never sits in the room as a ghost seat. In
    // pass-and-play the phone is shared, so it stays with the game.
    if (room.mode !== 'pass') { clearSeat(); setTimeout(() => location.reload(), 250); }
  });
  wire('sbEndRoom', () => {
    if (!endRoomArmed) { endRoomArmed = true; renderActionBar(room); setTimeout(() => { endRoomArmed = false; if (state) renderActionBar(state); }, 4000); return; }
    endRoomArmed = false;
    send('end_room', {});
  });
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

let auctionAnchor = null;
function stableAuctionEnds(a) {
  const key = a.kind + ':' + (a.space == null ? '' : a.space);
  if (!auctionAnchor || auctionAnchor.key !== key) auctionAnchor = { key, endsAt: a.endsAt };
  else if (a.endsAt > auctionAnchor.endsAt + 8000) auctionAnchor = { key, endsAt: a.endsAt };
  else if (a.endsAt < auctionAnchor.endsAt) auctionAnchor.endsAt = a.endsAt;
  return auctionAnchor.endsAt;
}
function renderAuction(room) {
  const slot = $('auctionSlot');
  const overlay = $('auctionOverlay');
  const a = room.auction;
  if (!a) {
    auctionAnchor = null;
    if (slot) slot.innerHTML = '';
    if (overlay) { overlay.classList.remove('show'); overlay.innerHTML = ''; }
    return;
  }
  const label = a.kind === 'deed' ? window.KP_DATA.SPACES[a.space].name : (a.kind === 'duplex' ? 'The last duplex' : 'The last mansion');
  const high = a.highBidder ? byId(a.highBidder) : null;
  const bidder = room.mode === 'pass' ? (bidAs != null ? bidAs : room.turnPlayerId) : myId;
  const canBid = !spectator && a.eligible.includes(bidder) && !a.passed.includes(bidder);
  const phaseLine = room.inf && a.kind === 'deed'
    ? '<p class="caption">Phase ' + room.inf.phase + ' context: printed rent on this street go multiply by ' + (room.inf.phase === 1 ? 'nothing yet' : room.inf.phase === 2 ? 'the lowest die' : 'the bigger die') + '. Auction price na the bid, always.</p>'
    : '';
  const ends = stableAuctionEnds(a);
  const host = overlay || slot;
  if (slot && host !== slot) slot.innerHTML = '';
  host.innerHTML = '<div class="auction-card">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;"><b class="title" style="font-size:17px;">' + window.icon('gavel', 18) + ' Auction: ' + esc(label) + '</b>' +
    '<span class="turn-timer" data-deadline="' + ends + '" data-auction-clock="1">' + Math.max(0, Math.round((ends - Date.now()) / 1000)) + 's</span></div>' +
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
  if (overlay) overlay.classList.add('show');
  host.querySelectorAll('[data-bid]').forEach((b) => b.addEventListener('click', () => {
    const o = { amount: Number(b.dataset.bid) };
    if (room.mode === 'pass') o.as = bidder;
    send('bid', o);
  }));
  host.querySelectorAll('[data-bidas]').forEach((b) => b.addEventListener('click', () => { bidAs = Number(b.dataset.bidas); renderAuction(room); }));
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
  // KP14: with the 3D board live, the card lift and reveal beats own
  // the sound (cardSwish at the lift, cardSnap at the flip). This 2D
  // fallback keeps a swish and a snap of its own.
  if (!(window.KP3D && window.KP3D.active)) {
    logSfx('cardSwish', null, 'render2d'); sfx.cardSwish();
    setTimeout(() => { logSfx('cardSnap', null, 'render2d'); sfx.cardSnap(); }, 130);
  }
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
    '<p class="caption">You fit build anytime, even when no be your turn. Open a deed to manage am.</p>' +
    '<div class="mt8">' + deedRowsFor(me.id, room, false) + '</div>' +
    '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>';
  $('listScrim').classList.add('show');
  wireSheetButtons($('listSheet'), me.id);
  $('listSheet').querySelectorAll('[data-open-deed]').forEach((b) => b.addEventListener('click', () => {
    closeScrim('listScrim');
    onSpaceTap(Number(b.dataset.openDeed));
  }));
}
function swapDeedGrid(playerId, room) {
  const ids = window.KP_DATA.OWNABLE.filter((i) => room.props[i] && room.props[i].o === playerId);
  if (!ids.length) return '<p class="caption">No deeds yet.</p>';
  return '<div class="swap-grid">' + ids.map((i) => {
    const sp = window.KP_DATA.SPACES[i];
    const pr = room.props[i];
    const band = sp.type === 'street' ? window.KP_DATA.GROUPS[sp.group].color : (sp.type === 'station' ? '#3d3d3d' : '#3f7fbf');
    const tag = pr.b >= 5 ? 'Mansion' : pr.b > 0 ? (pr.b + ' duplex') : pr.m ? 'Mortgaged' : pr.pl ? 'Pledged' : 'Site';
    return '<button type="button" class="swap-deed" data-deed="' + i + '" aria-pressed="false">' +
      '<span class="swap-band" style="background:' + band + '"></span>' +
      '<span class="swap-tick" aria-hidden="true"></span>' +
      '<span class="swap-name">' + esc(sp.name) + '</span>' +
      '<span class="swap-tag">' + tag + '</span></button>';
  }).join('') + '</div>';
}
function markSwapDeed(rootId, space) {
  const b = document.querySelector('#' + rootId + ' .swap-deed[data-deed="' + space + '"]');
  if (!b) return;
  b.classList.add('on');
  b.setAttribute('aria-pressed', 'true');
}
function openTrade(presetTo, presetSpace) {
  const room = state;
  const me = focusPlayer();
  if (!me || spectator) return;
  const others = room.players.filter((p) => p.id !== me.id && !p.bankrupt);
  if (!others.length) { toast('No living player to trade with.'); return; }
  let partner = presetTo;
  if (partner == null && presetSpace != null && room.props[presetSpace] && room.props[presetSpace].o != null && room.props[presetSpace].o !== me.id) {
    partner = room.props[presetSpace].o;
  }
  $('listSheet').innerHTML = '<div class="grab"></div><h3 class="title">' + (room.inf ? 'Propose a swap contract' : 'Propose a trade') + '</h3>' +
    (room.mode === 'pass' ? '<label style="display:block;font-weight:800;font-size:12px;margin:10px 0 6px;">You dey act as</label><select class="textin" id="actAs">' + room.players.filter((p) => !p.bankrupt).map((p) => '<option value="' + p.id + '"' + (p.id === me.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>' : '') +
    (room.inf ? '<p class="caption">For Inflation Mode, swaps na contracts: propose anytime, except during an auction, another player debt, or a pause. The other side gets 30 seconds to answer. If e no dey for contract board, e no happen.</p>' : '<p class="caption">Trades fit happen any time. Deeds with buildings for their set no fit trade until the buildings sell.</p>') +
    '<label style="display:block;font-weight:800;font-size:12px;margin:12px 0 6px;">Trade with</label>' +
    '<select class="textin" id="tradeTo">' + others.map((p) => '<option value="' + p.id + '"' + (partner != null && Number(partner) === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>' +
    '<div class="trade-side"><div class="trade-side-h">You give</div><input class="num-in" id="giveCash" type="number" min="0" inputmode="numeric" placeholder="Cash ₦">' +
    '<div class="mt8" id="giveDeeds">' + swapDeedGrid(me.id, room) + '</div>' +
    '<label class="deed-check"><input type="number" id="giveGoojf" min="0" max="' + me.goojf + '" value="0" style="width:64px;"> <span>Get Out cards (you hold ' + me.goojf + ')</span></label></div>' +
    '<div class="trade-side"><div class="trade-side-h">You want</div><input class="num-in" id="wantCash" type="number" min="0" inputmode="numeric" placeholder="Cash ₦">' +
    '<div class="mt8" id="wantDeeds"></div>' +
    '<label class="deed-check"><input type="number" id="wantGoojf" min="0" value="0" style="width:64px;"> <span>Get Out cards</span></label></div>' +
    '<div id="honourBox"></div>' +
    '<div class="btnrow"><button class="btn ghost" data-close="1">Cancel</button><button class="btn" id="tradeGo">Propose</button></div>';
  $('listScrim').classList.add('show');
  wireSheetButtons($('listSheet'), me.id);
  const actSel = $('actAs');
  const actorId = () => (actSel ? Number(actSel.value) : me.id);
  const fillHonour = () => {
    if (!room.inf) { $('honourBox').innerHTML = ''; return; }
    const checked = Array.from($('wantDeeds').querySelectorAll('.swap-deed.on')).map((c) => Number(c.dataset.deed));
    const withPass = checked.filter((i) => room.inf.contracts.some((c) => c.type === 'pass' && c.street === i));
    $('honourBox').innerHTML = withPass.length
      ? '<p class="caption mt8">Pass chips dey on streets you dey request. Tick the ones you go honour as new owner:</p>' + withPass.map((i) => '<label class="deed-check"><input type="checkbox" data-honour-req="' + i + '"><span>Honour Pass on ' + esc(window.KP_DATA.SPACES[i].name) + '</span></label>').join('')
      : '';
  };
  const applyPreset = () => {
    if (presetSpace == null) return;
    const owner = room.props[presetSpace] && room.props[presetSpace].o;
    const side = owner === actorId() ? 'giveDeeds' : 'wantDeeds';
    markSwapDeed(side, presetSpace);
    fillHonour();
  };
  const fillWant = () => {
    const toId = Number($('tradeTo').value);
    $('wantDeeds').innerHTML = swapDeedGrid(toId, room);
    applyPreset();
  };
  const toggleCard = (b) => {
    const on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  $('giveDeeds').addEventListener('click', (e) => {
    const b = e.target.closest('.swap-deed');
    if (!b) return;
    toggleCard(b);
  });
  $('wantDeeds').addEventListener('click', (e) => {
    const b = e.target.closest('.swap-deed');
    if (!b) return;
    toggleCard(b);
    fillHonour();
  });
  $('tradeTo').addEventListener('change', fillWant);
  if (actSel) actSel.addEventListener('change', () => {
    $('giveDeeds').innerHTML = swapDeedGrid(Number(actSel.value), room);
    fillWant();
  });
  fillWant();
  $('tradeGo').addEventListener('click', () => {
    const grab = (rootId) => Array.from($(rootId).querySelectorAll('.swap-deed.on')).map((c) => Number(c.dataset.deed));
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
function openDeedPass(space) {
  const room = state;
  const me = focusPlayer();
  if (!room || !room.inf || !me) return;
  const sp = window.KP_DATA.SPACES[space];
  const ownerId = room.props[space] && room.props[space].o;
  const owner = byId(ownerId);
  $('listSheet').innerHTML = '<div class="grab"></div><h3 class="title">Buy a Pass</h3>' +
    '<p class="lead">' + esc(sp.name) + (owner ? ' · Owner: <b>' + esc(owner.name) + '</b>' : '') + '</p>' +
    '<p class="caption">A chip means: when you land here and rent suppose fire, you pay ₦0 and one chip burns. Chips die at this phase end.</p>' +
    '<div class="join-row mt8"><select class="textin" id="passChips"><option value="1">1 chip</option><option value="2">2 chips</option></select>' +
    '<input class="textin" id="passPrice" type="number" min="5000" inputmode="numeric" placeholder="Price ₦ (min 5,000)" style="text-transform:none;letter-spacing:normal;text-align:left;"></div>' +
    '<div class="btnrow"><button class="btn ghost" data-close="1">Cancel</button><button class="btn" id="passGo">Propose Pass</button></div>';
  $('listScrim').classList.add('show');
  wireSheetButtons($('listSheet'), me.id);
  $('passGo').addEventListener('click', () => {
    const o = { kind: 'pass', street: space, chips: Number($('passChips').value), price: Number($('passPrice').value || 0) };
    if (room.mode === 'pass') o.as = me.id;
    send('contract_propose', o);
    closeScrim('listScrim');
  });
}
function openDeedLoan(space) {
  const room = state;
  const me = focusPlayer();
  if (!room || !room.inf || !me) return;
  const sp = window.KP_DATA.SPACES[space];
  const lenders = room.players.filter((p) => p.id !== me.id && !p.bankrupt);
  $('listSheet').innerHTML = '<div class="grab"></div><h3 class="title">Pledge a loan</h3>' +
    '<p class="lead">Security: <b>' + esc(sp.name) + '</b></p>' +
    '<p class="caption">Phase 2 and up. Max 80 percent of the printed price (' + fmtN(Math.floor(sp.price * 0.8)) + '). Interest na one flat pick.</p>' +
    '<label style="display:block;font-weight:800;font-size:12px;margin:8px 0 6px;">Lender</label>' +
    '<select class="textin" id="loanLender">' + lenders.map((p) => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('') + '</select>' +
    '<div class="join-row mt8"><input class="textin" id="loanAmount" type="number" min="0" inputmode="numeric" placeholder="Amount ₦" style="text-transform:none;letter-spacing:normal;text-align:left;">' +
    '<select class="textin" id="loanPct"><option value="0">0%</option><option value="10" selected>10%</option><option value="20">20%</option><option value="30">30%</option></select>' +
    '<select class="textin" id="loanTerm"><option value="1">1 lap</option><option value="2" selected>2 laps</option><option value="3">3 laps</option></select></div>' +
    '<div class="btnrow"><button class="btn ghost" data-close="1">Cancel</button><button class="btn" id="loanGo">Propose loan</button></div>';
  $('listScrim').classList.add('show');
  wireSheetButtons($('listSheet'), me.id);
  $('loanGo').addEventListener('click', () => {
    const o = { kind: 'loan', to: Number($('loanLender').value), pledgedSpace: space, amount: Number($('loanAmount').value || 0), interestPct: Number($('loanPct').value), termLaps: Number($('loanTerm').value) };
    if (room.mode === 'pass') o.as = me.id;
    send('contract_propose', o);
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
let endSoundFor = '';
let boardView = 'full';
try { boardView = localStorage.getItem('kolopolyView') === 'follow' ? 'follow' : 'full'; } catch (e) { }
function rememberTable(room) {
  const top = room.endTable && room.endTable[0];
  if (!top || !room.code) return;
  const id = room.code + ':' + top.name + ':' + top.netWorth;
  try {
    const key = 'kolopolyRecords';
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    if (list.some((r) => r.id === id)) return;
    list.unshift({ id, name: top.name, netWorth: top.netWorth, mode: room.inf ? 'Inflation' : 'Classic', at: Date.now() });
    localStorage.setItem(key, JSON.stringify(list.slice(0, 20)));
  } catch (e) { /* private mode */ }
}
function openRecords() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem('kolopolyRecords') || '[]'); } catch (e) { list = []; }
  const rows = list.map((r) => '<div class="records-row"><b>' + esc(r.name) + '</b> · ' + fmtN(r.netWorth) + '<div class="caption">' + esc(r.mode) + ' · this phone</div></div>').join('');
  $('hudSheet').innerHTML = '<div class="grab"></div><h3 class="title">Top landlords</h3>' +
    '<p class="caption">Tables that finished on this phone. A shared board for every player needs a saved store. That is the next pass.</p>' +
    (rows || '<p class="caption">No table don finish on this phone yet.</p>') +
    '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>';
  $('hudScrim').classList.add('show');
  wireSheetButtons($('hudSheet'), myId);
}
function paintViewToggle() {
  const b = $('viewToggle');
  if (!b) return;
  const follow = boardView === 'follow';
  b.setAttribute('aria-pressed', follow ? 'true' : 'false');
  b.setAttribute('aria-label', follow ? 'Following the token. Tap for the full board.' : 'Full board. Tap to follow the token.');
  b.innerHTML = window.icon(follow ? 'eye' : 'home', 20);
}
function syncBoardView() {
  paintViewToggle();
  if (window.KP3D && KP3D.setView && KP3D.getView && KP3D.getView() !== boardView) KP3D.setView(boardView);
}
function paintHud(room) {
  const players = $('hudPlayers');
  if (players) players.innerHTML = window.icon('users', 20) + '<span class="hud-badge">' + room.players.length + '</span>';
  const deals = $('hudDeals');
  if (deals) deals.innerHTML = window.icon(room.inf ? 'card' : 'swapH', 20);
  syncBoardView();
}
function openHud(kind) {
  const room = state;
  if (!room) return;
  if (kind === 'feed') { openGist(); return; }
  if (kind === 'deals') {
    $('hudSheet').innerHTML = '<div class="grab"></div><h3 class="title">Deals</h3>' +
      '<p class="caption">Trade, contracts and Deal Break. One door. Dice and landings stay with the turn.</p>' +
      '<div class="btnrow"><button class="btn" id="hudTrade">Offer a trade</button>' +
      (room.inf ? '<button class="btn" id="hudContracts">Contracts</button><button class="btn" id="hudDealBreak">Deal Break</button>' : '') +
      '<button class="btn ghost" data-close="1">Close</button></div>';
    $('hudScrim').classList.add('show');
    wireSheetButtons($('hudSheet'), myId);
    const tr = $('hudTrade'); if (tr) tr.addEventListener('click', () => { closeScrim('hudScrim'); openTrade(); });
    const ct = $('hudContracts'); if (ct) ct.addEventListener('click', () => { closeScrim('hudScrim'); openContracts(); });
    const db = $('hudDealBreak'); if (db) db.addEventListener('click', () => { closeScrim('hudScrim'); sendAs('call_deal_break', {}); });
    return;
  }
  if (kind === 'wallet') {
    const fp = focusPlayer();
    const sapa = fp && fp.sapa && fp.sapa.warn
      ? '<p class="caption">Sapa dey near: one bad landing fit cost you ' + fmtN(fp.sapa.exposure) + '.</p>' : '';
    $('hudSheet').innerHTML = '<div class="grab"></div><h3 class="title">' + (fp ? esc($('walletLabel').textContent) : 'Cash') + '</h3>' +
      '<p class="lead">' + (fp ? fmtN(fp.cash) : 'Spectating') + '</p>' + sapa +
      '<div class="shelf-head"><span class="shelf-kicker">SHELF</span></div>' +
      '<div class="market-shelf" id="shelfBox"></div>' +
      '<p class="shelf-tip" id="shelfTip"></p>' +
      '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>';
    $('hudScrim').classList.add('show');
    wireSheetButtons($('hudSheet'), myId);
    paintShelfBox($('hudSheet'));
    return;
  }
  const meId = focusPlayer() ? focusPlayer().id : null;
  const rows = room.players.map((p) => {
    const marks = (p.id === room.turnPlayerId ? ' · turn' : '') + (p.inJail ? ' · Kirikiri' : '') + (p.bankrupt ? ' · out' : '') + (p.bot ? ' · ' + (p.afkTaken ? 'AFK' : 'BOT') : '');
    const self = meId != null && p.id === meId;
    return '<button type="button" class="hud-sheet-row" data-opp="' + p.id + '"' + (self ? ' data-self="1"' : '') + '><span class="avatar" style="background:' + p.color + '">' + window.icon(p.token, 18) + '</span>' +
      '<div class="grow"><b>' + esc(p.name) + '</b><div class="caption">' + p.deeds + ' deeds' + marks + '</div></div>' +
      '<span class="cash">' + fmtN(p.cash) + '</span></button>';
  }).join('');
  $('hudSheet').innerHTML = '<div class="grab"></div><h3 class="title">Players</h3>' + rows +
    '<p class="caption">Tap a player. Trade or look at their deeds.</p>' +
    '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>';
  $('hudScrim').classList.add('show');
  wireSheetButtons($('hudSheet'), myId);
  $('hudSheet').querySelectorAll('[data-opp]').forEach((row) => row.addEventListener('click', () => openOpponent(Number(row.dataset.opp))));
}
function openOpponent(playerId) {
  const room = state;
  const p = byId(playerId);
  const me = focusPlayer();
  if (!room || !p) return;
  if (me && p.id === me.id) { openMyDeeds(); return; }
  const dead = !!p.bankrupt;
  $('hudSheet').innerHTML = '<div class="grab"></div><div id="oppMenu" data-player="' + p.id + '">' +
    '<h3 class="title">' + esc(p.name) + (p.bot ? ' <span class="bot-tag">' + (p.afkTaken ? 'AFK' : 'BOT') + '</span>' : '') + '</h3>' +
    '<p class="caption">' + p.deeds + ' deeds · ' + fmtN(p.cash) + (dead ? ' · out of the table' : '') + '</p>' +
    '<div class="btnrow"><button class="btn" id="oppTrade"' + (dead ? ' disabled' : '') + '>Offer a trade</button>' +
    '<button class="btn" id="oppDeeds">View deeds</button></div>' +
    '<div class="btnrow"><button class="btn ghost" id="oppBack">Back</button><button class="btn ghost" data-close="1">Close</button></div></div>';
  wireSheetButtons($('hudSheet'), myId);
  const back = $('oppBack');
  if (back) back.addEventListener('click', () => openHud('players'));
  const trade = $('oppTrade');
  if (trade) trade.addEventListener('click', () => { closeScrim('hudScrim'); openTrade(p.id); });
  const deeds = $('oppDeeds');
  if (deeds) deeds.addEventListener('click', () => { closeScrim('hudScrim'); openTheirDeeds(p.id); });
}
function openTheirDeeds(playerId) {
  const room = state;
  const p = byId(playerId);
  if (!room || !p) return;
  $('listSheet').innerHTML = '<div class="grab"></div><h3 class="title">' + esc(p.name) + ': deeds</h3>' +
    '<p class="caption">Look only. Their hand, not yours.</p>' +
    '<div class="mt8">' + deedRowsFor(p.id, room, false) + '</div>' +
    '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>';
  $('listScrim').classList.add('show');
  wireSheetButtons($('listSheet'), myId);
  $('listSheet').querySelectorAll('[data-open-deed]').forEach((b) => b.addEventListener('click', () => {
    closeScrim('listScrim');
    onSpaceTap(Number(b.dataset.openDeed));
  }));
}
let shelfView = null;
const SHELF_FACE = {
  cowries: { label: 'Cowries', cost: 3, use: '3 cowries → ₦50,000 cash' },
  kola: { label: 'Kola', cost: 1, use: 'Next rent, up to ₦100,000' },
  yams: { label: 'Yam', cost: 1, use: 'Next fee or tax, up to ₦200,000' },
  cloth: { label: 'Cloth', cost: 1, use: '₦150,000 cash for your hand' }
};
const SHELF_ICON = {
  cowries: '<svg viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="16" cy="18" rx="10" ry="7" fill="#f4e2b0" stroke="#2b2018" stroke-width="1.6"/><path d="M10 17c2 2 10 2 12 0" fill="none" stroke="#8a5a10" stroke-width="1.4"/><ellipse cx="16" cy="12" rx="4" ry="2.2" fill="#e8a90c"/></svg>',
  kola: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="17" r="9" fill="#c4552a" stroke="#2b2018" stroke-width="1.6"/><path d="M16 9v16M10 14c3 2 9 2 12 0" fill="none" stroke="#6a2410" stroke-width="1.3"/></svg>',
  yams: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M11 8c2 6 1 12 4 16 4 2 9-1 8-6-1-6-4-12-8-13-2 0-3 1-4 3z" fill="#e7c27a" stroke="#2b2018" stroke-width="1.6"/><path d="M14 14c2 2 4 2 6 0" fill="none" stroke="#8a5a10" stroke-width="1.2"/></svg>',
  cloth: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 10h18l-2 14H9L7 10z" fill="#f7f1e4" stroke="#2b2018" stroke-width="1.6"/><path d="M7 10l4-4h10l4 4" fill="#e8a90c" stroke="#2b2018" stroke-width="1.4"/><path d="M12 14h8M12 18h8" stroke="#c4552a" stroke-width="1.4"/></svg>'
};
window.KPGoods = {
  face: SHELF_FACE,
  slots(inv, opts) {
    opts = opts || {};
    const data = inv || {};
    const uses = opts.uses || {};
    const armed = opts.armed || {};
    return Object.keys(SHELF_FACE).map((key) => {
      const face = SHELF_FACE[key];
      const cost = uses[key] && uses[key].cost ? uses[key].cost : face.cost;
      const have = data[key] || 0;
      const plus = opts.preview && opts.preview[key] ? Math.max(0, Math.floor(Number(opts.preview[key]) || 0)) : 0;
      const incoming = have < 1 && plus > 0;
      const on = armed[key] ? ' armed' : '';
      const empty = have < 1 && !incoming ? ' empty' : '';
      const shown = incoming ? ('+' + plus) : String(have);
      return '<button type="button" class="good-slot' + on + empty + (incoming ? ' incoming' : '') + '" data-good="' + key + '" data-cost="' + cost + '" data-have="' + have + '" aria-label="' + face.label + ', ' + have + (incoming ? ', claim +' + plus : '') + '">' +
        '<span class="good-n' + (incoming ? ' incoming' : '') + '">' + shown + '</span>' +
        '<span class="good-ico">' + SHELF_ICON[key] + '</span>' +
        '<span class="good-k">' + face.label + '</span>' +
        '<span class="good-cost">×' + cost + '</span></button>';
    }).join('');
  }
};
function shelfHTML(view) {
  const inv = (view && view.inventory) || { cowries: 0, kola: 0, yams: 0, cloth: 0 };
  const fp = (typeof focusPlayer === 'function') ? focusPlayer() : null;
  return window.KPGoods.slots(inv, {
    uses: view && view.uses,
    armed: { kola: !!(fp && fp.shelfRent), yams: !!(fp && fp.shelfFee) }
  });
}
function paintShelfBox(root) {
  const box = root && root.querySelector ? root.querySelector('#shelfBox') : $('shelfBox');
  if (!box) return;
  const draw = (view) => {
    if (!box.isConnected) return;
    box.innerHTML = shelfHTML(view);
    const tip = root && root.querySelector ? root.querySelector('#shelfTip') : null;
    box.querySelectorAll('[data-good]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.good;
      const face = SHELF_FACE[key];
      const cost = Number(b.dataset.cost || face.cost);
      const have = Number(b.dataset.have || 0);
      const playing = !!(state && state.status === 'playing' && !spectator && focusPlayer());
      if (!playing) { if (tip) tip.textContent = 'Spend am inside a match.'; return; }
      if (have < cost) { if (tip) tip.textContent = 'Need ' + cost + ' ' + face.label.toLowerCase() + '.'; return; }
      if (tip) tip.textContent = face.use;
      send('use_shelf', { good: key });
    }));
  };
  if (shelfView) draw(shelfView);
  const id = (typeof CLIENT_ID !== 'undefined') ? CLIENT_ID : '';
  if (!id) { draw(shelfView); return; }
  fetch('/api/retention?clientId=' + encodeURIComponent(id)).then((r) => r.json()).then((view) => {
    if (view && view.ok) { shelfView = view; draw(view); }
  }).catch(() => { if (!shelfView) draw(null); });
}
function openGist() {
  const room = state;
  const items = (room.feed || []).slice().reverse().map((e) =>
    '<div class="feed-item"><span class="k">' + esc(e.kind) + '</span><div>' + esc((e.auto ? '(auto) ' : '') + e.text) + '</div></div>').join('') || '<p class="caption">Nothing don happen yet.</p>';
  $('listSheet').innerHTML = '<div class="grab"></div><h3 class="title">Wahala log</h3><p class="caption">Wetin don happen for this table. No be chat.</p><div class="mt8">' + items + '</div>' +
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
  unlockAudio();
  releaseWakeLock();
  try { sessionStorage.removeItem('kolopolySeat'); } catch (e) { }
  rememberTable(room);
  if (endSoundFor !== (room.code || '') + ':' + (room.winner && room.winner.playerId)) {
    endSoundFor = (room.code || '') + ':' + (room.winner && room.winner.playerId);
    const won = !!(room.winner && (room.winner.playerId === myId || room.mode === 'pass'));
    try { if (won) { logSfx('cheer', null, 'end'); sfx.cheer(); } else { logSfx('lose', null, 'end'); sfx.lose(); } } catch (e) { }
  }
  const rows = room.endTable.map((r, idx) =>
    '<li class="end-row' + (idx === 0 ? ' winner' : '') + '">' +
    '<div class="end-rank">' + (idx === 0 ? window.icon('crown', 22) : String(idx + 1)) + '</div>' +
    '<div class="end-who"><div class="end-name">' + esc(r.name) + (r.bot || r.afkTaken ? ' <span class="bot-tag">BOT</span>' : '') + (r.resigned ? ' <span class="end-flag">resigned</span>' : r.bankrupt ? ' <span class="end-flag">out</span>' : '') + '</div>' +
    '<div class="end-title">' + esc(r.title) + '</div>' +
    (r.lessons && r.lessons.length ? r.lessons.map((l) => '<p class="end-lessons">' + esc(l) + '</p>').join('') : '') +
    '</div><div class="end-worth">' + fmtN(r.netWorth) + '</div></li>').join('');
  const hasReal = room.endTable.some((r) => r.realNetWorth != null);
  const realRows = hasReal ? room.endTable.slice().sort((a, b) => b.realNetWorth - a.realNetWorth).map((r, idx) =>
    '<li class="end-row"><div class="end-rank">' + (idx + 1) + '</div><div class="end-who"><div class="end-name">' + esc(r.name) + '</div><div class="end-title">Cash ' + fmtN(r.realCash) + ' at Phase 1 power</div></div><div class="end-worth">' + fmtN(r.realNetWorth) + '</div></li>').join('') : '';
  const winName = room.winner ? room.winner.name : (room.endTable[0] && room.endTable[0].name) || 'Nobody';
  o.innerHTML = '<div class="end-card">' +
    '<p class="end-kicker">FINAL TABLE</p>' +
    '<h2 class="end-headline">' + esc(winName) + ' na the real landlord</h2>' +
    (room.endReason === 'resignation' ? '<p class="end-reason">Won by resignation.</p>' : '') +
    (room.endReason === 'abandoned' ? '<p class="end-reason">Everybody leave the table, so the room close.</p>' : '') +
    (room.endReason === 'host' ? '<p class="end-reason">The host end the room.</p>' : '') +
    '<div class="end-tables">' +
      '<section class="end-panel"><h3 class="end-panel-title">The table</h3><p class="end-panel-sub">Net worth, highest first</p>' +
        '<ol class="end-board">' + rows + '</ol></section>' +
      (hasReal ? '<section class="end-panel"><h3 class="end-panel-title">Buying power</h3><p class="end-panel-sub">Same money at Phase 1 prices</p>' +
        '<ol class="end-board">' + realRows + '</ol>' +
        '<p class="end-note">The naira on the table and the naira wey fit buy the same thing no be the same number.</p></section>' : '') +
    '</div>' +
    (room.dealOfGame ? '<p class="end-deal">Deal of the Game: ' + esc(room.dealOfGame) + '</p>' : '') +
    (room.interestLine ? '<p class="end-note">' + esc(room.interestLine) + '</p>' : '') +
    (room.bankerGhost ? '<p class="end-note">Banker: ' + esc(room.bankerGhost) + ', wey inflation first catch. The ghost run the announcements, no money power.</p>' : '') +
    '<div class="btnrow end-actions"><button class="btn" id="endShare">Final Table card</button>' +
    '<button class="btn green" id="endAgain">Play again</button></div>' +
    '<button class="btn ghost mt8 end-leave" id="endLeave">Leave</button></div>';
  o.classList.add('show');
  $('endShare').addEventListener('click', () => {
    openShare('final', {
      rows: room.endTable.map((r, idx) => ({ name: r.name, netWorth: r.netWorth, title: r.title, crown: idx === 0, bot: !!(r.bot || r.afkTaken) })),
      deal: room.dealOfGame, code: room.code
    });
  });
  $('endAgain').addEventListener('click', () => {
    o.classList.remove('show');
    // Play again needs a live seat again: rejoin path is not used; host
    // play_again resets the room and clients keep myId/sessionLive.
    send('play_again', {});
  });
  $('endLeave').addEventListener('click', () => {
    send('leave', {});
    clearSeat();
    releaseWakeLock();
    setTimeout(() => location.reload(), 200);
  });
  if (window.KPRetention) window.KPRetention.onWin(!!(room.winner && myId && room.winner.playerId === myId));
}
window.__kolopolyRenderEnd = renderEnd;
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

// ---------------------------------------------------------------------------
// Clock beeps (Lesson 7): every live clock that belongs to this player
// beeps inside its last 10 seconds: soft ticks each second, firmer ticks in
// the final 3, one final beep at zero, and the timer chip pulses with each
// beep. One pattern for the turn timer, the Kirikiri roll prompt (same
// deadline), auctions, deal and choice clocks. Mute governs all of it.
// window.__kpBeeps counts fired beeps so tests can prove them without ears.
// ---------------------------------------------------------------------------
window.__kpBeeps = 0;
const beepSeen = {};
function beepTick(secsLeft, final) {
  window.__kpBeeps += 1;
  // KP14: soft sine pips, no square buzz. The final second gets two
  // brighter pings.
  if (final) { tone({ f: 1560, dur: 0.08, vol: 0.06 }); tone({ f: 1560, at: 0.12, dur: 0.13, vol: 0.06 }); }
  else if (secsLeft <= 3) tone({ f: 1420, dur: 0.055, vol: 0.042 });
  else tone({ f: 1180, dur: 0.04, vol: 0.02 });
}
function pulseDeadline(endsAt) {
  document.querySelectorAll('[data-deadline]').forEach((el) => {
    if (Math.abs(Number(el.dataset.deadline) - endsAt) < 1600) {
      el.classList.remove('pulse');
      void el.offsetWidth;
      el.classList.add('pulse');
      setTimeout(() => el.classList.remove('pulse'), 340);
      // KP12: the whole ring badge pulses, not just its number.
      const ring = el.closest('.timer-ring');
      if (ring) {
        ring.classList.remove('pulse');
        void ring.offsetWidth;
        ring.classList.add('pulse');
        setTimeout(() => ring.classList.remove('pulse'), 340);
      }
    }
  });
}
function clockCandidates() {
  const out = [];
  const room = state;
  if (!room || room.status !== 'playing' || spectator) return out;
  const mine = actingId();
  if (room.turnDeadline && (room.turnPlayerId === mine || (room.debt && room.debt.playerId === mine))) out.push({ key: 'turn', endsAt: room.turnDeadline });
  if (room.auction) out.push({ key: 'auction', endsAt: room.auction.endsAt });
  const pr = room.inf && room.inf.proposal;
  if (pr && (room.mode === 'pass' || pr.to === myId)) out.push({ key: 'proposal', endsAt: pr.endsAt });
  const ld = room.inf && room.inf.loanDecision;
  if (ld) {
    const c = room.inf.contracts.find((x) => x.id === ld.contractId);
    if (c && (room.mode === 'pass' || c.lender === myId)) out.push({ key: 'loan', endsAt: ld.endsAt });
  }
  if (room.trade && room.trade.expiresAt && (room.mode === 'pass' || room.trade.to === myId)) out.push({ key: 'trade', endsAt: room.trade.expiresAt });
  if (room.debt && room.debt.rescueEndsAt && room.debt.playerId === mine) out.push({ key: 'rescue', endsAt: room.debt.rescueEndsAt });
  return out;
}
function runClockBeeps() {
  if (muted || !state || state.paused) return;
  for (const c of clockCandidates()) {
    const s = Math.ceil((c.endsAt - Date.now()) / 1000);
    let rec = beepSeen[c.key];
    if (!rec || Math.abs(rec.endsAt - c.endsAt) > 1500) { rec = beepSeen[c.key] = { endsAt: c.endsAt, s: 99 }; }
    if (s >= 1 && s <= 10 && rec.s !== s) { rec.s = s; beepTick(s, false); pulseDeadline(c.endsAt); }
    else if (s <= 0 && rec.s !== 0) { rec.s = 0; beepTick(0, true); pulseDeadline(c.endsAt); }
  }
}

// Ticker: countdown labels and clock beeps, no full re-render.
setInterval(() => {
  runClockBeeps();
  document.querySelectorAll('[data-deadline]').forEach((el) => {
    const left = Math.max(0, Math.round((Number(el.dataset.deadline) - Date.now()) / 1000));
    el.textContent = left + 's';
  });
  // KP12: the turn ring depletes against the room's turn timer length.
  document.querySelectorAll('.timer-ring').forEach((rg) => {
    const dl = Number(rg.getAttribute('data-ring-deadline'));
    const total = Math.max(1, (state && state.settings && state.settings.turnTimerSec) || 60);
    const leftS = Math.max(0, (dl - Date.now()) / 1000);
    const fg = rg.querySelector('.ring-fg');
    if (fg) fg.style.strokeDashoffset = (RING_CIRC * (1 - Math.min(1, leftS / total))).toFixed(1);
  });
  const clk = $('infClock');
  if (clk && state && state.inf) {
    if (state.inf.phaseEndsAt) {
      const s = Math.max(0, Math.floor((state.inf.phaseEndsAt - Date.now()) / 1000));
      clk.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    } else if (state.inf.hornAt) {
      const s = Math.max(0, Math.floor((state.inf.hornAt - Date.now()) / 1000));
      clk.textContent = 'Horn in ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    } else clk.textContent = 'Phase open';
  }
  // KP9: the match clock ticks inside the header room chip.
  if (state) updateRoomChip(state);
  const pe = $('pauseElapsed');
  if (pe && state && state.pausedSince) {
    const s = Math.max(0, Math.floor((Date.now() - state.pausedSince) / 1000));
    pe.textContent = 'Waiting don reach ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + '.';
  }
}, 500);

// KP14: UI taps are a faint tick, delegated on pointerdown so the tick
// lands with the press, not the release. Buttons that carry their own
// beats (actions, bids, the audio and graphics controls, anything in
// the action bar or auction panel) are skipped.
document.addEventListener('pointerdown', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('.ubtn, .btn, [data-close], #shareBtn') : null;
  if (!b || b.disabled) return;
  if (b.hasAttribute('data-act') || b.hasAttribute('data-bid')) return;
  if (b.id === 'muteBtn' || b.id === 'tierBtn') return;
  if (b.closest('#actionBar') || b.closest('#auctionSlot') || b.closest('#auctionOverlay') || b.closest('#hudTray')) return;
  logSfx('tap', null, 'ui');
  sfx.tap();
}, true);

const tray = $('hudTray');
if (tray) tray.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.id === 'viewToggle') return;
  if (b.id === 'hudPlayers') openHud('players');
  else if (b.id === 'hudCashBtn') openHud('wallet');
  else if (b.id === 'hudDeals') openHud('deals');
});
const viewBtn = $('viewToggle');
if (viewBtn) viewBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  boardView = boardView === 'follow' ? 'full' : 'follow';
  try { localStorage.setItem('kolopolyView', boardView); } catch (err) { }
  if (window.KP3D && KP3D.setView) KP3D.setView(boardView);
  paintViewToggle();
});
const recordsBtn = $('recordsBtn');
if (recordsBtn) recordsBtn.addEventListener('click', () => openRecords());
paintViewToggle();
connect();
