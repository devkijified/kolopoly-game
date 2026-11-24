'use strict';
// A home-screen tab keeps the copy of the game it opened with. When a
// deploy is ready, say so in the table's voice and reload on a short
// countdown. Tap takes it now. Ignoring the banner still reloads. A hop
// already in motion gets at most two seconds to finish; the reload is
// not cancelled.
(function () {
  const COUNTDOWN_SEC = 6;
  const ANIM_GRACE_MS = 2000;
  const LANDING_POLL_MS = 60000;
  const TABLE_POLL_MS = 120000;

  let registration = null;
  let armed = false;
  let closing = false;
  let reloading = false;
  let tickTimer = null;
  let left = COUNTDOWN_SEC;
  // '' is a fresh build. 'room' is a dead room on the same build.
  // 'fresh-room' is both: a restart took the room and shipped a new build.
  let note = '';
  // iOS Safari drops location.reload() after a return from Paystack
  // (the page is still the bfcache copy, and a timer is not a tap).
  // A cache-busting replace navigates for real. The seat stays in
  // localStorage and the pay reference stays in sessionStorage.
  function hardReload() {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('_kp', Date.now().toString(36));
      window.location.replace(url.toString());
    } catch (e) {
      window.location.reload();
    }
  }
  let reloadImpl = hardReload;
  let hadController = !!('serviceWorker' in navigator && navigator.serviceWorker.controller);
  let loadedBuild = readBuild();

  function readBuild() {
    const meta = document.querySelector('meta[name="kolopoly-build"]');
    const v = meta && meta.getAttribute('content');
    if (!v || v.indexOf('__KOLOPOLY') === 0) return '';
    return v;
  }
  function onLanding() {
    const view = document.getElementById('view-landing');
    return !!(view && view.classList.contains('active'));
  }
  function tableBusy() {
    try {
      if (window.KP3D && typeof window.KP3D.midBeat === 'function') return !!window.KP3D.midBeat();
    } catch (e) { /* the board flag below still applies */ }
    try { return !!(window.KPBoard && window.KPBoard.animating); }
    catch (e) { return false; }
  }
  function lineText() {
    const tail = left > 0 ? ('reloading in ' + left) : 'reloading now';
    if (note === 'room') return 'Your room don close · ' + tail;
    if (note === 'fresh-room') return 'Fresh table ready · your room don close · ' + tail;
    return 'Fresh table ready · ' + tail;
  }
  function paint() {
    const line = document.getElementById('updateLine');
    const kicker = document.getElementById('updateKicker');
    if (kicker) kicker.textContent = note === 'room' ? 'Room don close' : 'Fresh table';
    if (!line) return;
    line.textContent = lineText();
  }
  function show() {
    const banner = document.getElementById('updateBanner');
    if (!banner) return;
    paint();
    banner.classList.remove('hidden');
  }
  function finishReload() {
    if (reloading) return;
    reloading = true;
    try { reloadImpl(); }
    catch (e) {
      try { hardReload(); } catch (e2) { /* the countdown already asked */ }
    }
    // If Safari swallowed the navigation, a later tap must be able to try again.
    setTimeout(() => { reloading = false; }, 1500);
  }
  function beginReload() {
    if (!armed || closing) return;
    closing = true;
    clearInterval(tickTimer);
    left = 0;
    paint();
    const started = Date.now();
    const step = () => {
      if (!tableBusy() || Date.now() - started >= ANIM_GRACE_MS) finishReload();
      else setTimeout(step, 100);
    };
    step();
  }
  function mergeNote(prev, incoming) {
    const fresh = prev === '' || prev === 'fresh-room' || incoming === '' || incoming === 'fresh-room';
    const room = prev === 'room' || prev === 'fresh-room' || incoming === 'room' || incoming === 'fresh-room';
    if (fresh && room) return 'fresh-room';
    if (room) return 'room';
    return '';
  }
  function arm(opts) {
    opts = opts || {};
    const incoming = opts.note === 'room' ? 'room' : (opts.note === 'fresh-room' ? 'fresh-room' : '');
    if (armed) {
      // A later fact can enrich the line (a build change, or the room
      // that died under it) without restarting the countdown.
      const merged = mergeNote(note, incoming);
      if (merged !== note) { note = merged; paint(); }
      return;
    }
    armed = true;
    note = incoming;
    const requested = Object.prototype.hasOwnProperty.call(opts, 'seconds') ? Number(opts.seconds) : COUNTDOWN_SEC;
    left = Number.isFinite(requested) ? Math.max(0, Math.min(8, Math.round(requested))) : COUNTDOWN_SEC;
    show();
    if (left <= 0) { beginReload(); return; }
    tickTimer = setInterval(() => {
      left -= 1;
      paint();
      if (left <= 0) {
        clearInterval(tickTimer);
        beginReload();
      }
    }, 1000);
  }
  function watchWorker(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // The first claim of a cold tab is not a deploy. A worker that
      // reaches installed while one was already in control is.
      if (!hadController) return;
      // A new worker is not itself a new game. The page that just loaded
      // (or came back from Paystack) may already be that build. Ask the
      // server before putting the banner up.
      if (worker.state === 'installed') checkNow();
    });
  }
  function bind(reg) {
    registration = reg;
    if (reg.waiting && hadController) checkNow();
    watchWorker(reg.installing);
    reg.addEventListener('updatefound', () => watchWorker(reg.installing));
  }
  // Returns true when the server is already on a newer build and the
  // banner has been asked to show. A hidden tab waits; coming forward
  // runs this again, so the countdown is seen rather than spent offscreen.
  async function checkNow() {
    if (document.visibilityState === 'hidden') return false;
    try {
      if (registration) await registration.update();
    } catch (e) { /* a failed worker check still leaves the version line */ }
    try {
      const res = await fetch('/api/version', { cache: 'no-store' });
      if (!res.ok) return false;
      const data = await res.json();
      const build = data && data.build;
      if (!build) return false;
      if (!loadedBuild) { loadedBuild = String(build); return false; }
      if (String(build) !== loadedBuild) { arm(); return true; }
    } catch (e) { /* the version line can miss a round */ }
    return false;
  }
  function schedule() {
    const wait = onLanding() ? LANDING_POLL_MS : TABLE_POLL_MS;
    setTimeout(() => { checkNow().then(schedule, schedule); }, wait);
  }

  const nowBtn = document.getElementById('updateNow');
  if (nowBtn) nowBtn.addEventListener('click', () => {
    // The countdown may already have asked, and iOS may have ignored it.
    // A tap is a user gesture, so it always tries the navigation again.
    if (closing) { reloading = false; finishReload(); return; }
    beginReload();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      checkNow();
    });
    navigator.serviceWorker.register('/sw.js').then(bind).catch(() => {});
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkNow();
  });
  // Coming back from Paystack can restore a frozen page. Ask again,
  // and if a reload already bounced, let the next tap or this check
  // navigate with a fresh replace.
  window.addEventListener('pageshow', (ev) => {
    if (!ev.persisted) return;
    reloading = false;
    checkNow().then((stale) => {
      if (stale && armed && left <= 0) { closing = false; beginReload(); }
    }).catch(() => {});
  });
  // Landing checks often. A match that stays on screen still checks,
  // slower, so a home-screen table hears a deploy without a tab switch.
  // A socket drop does not wait for either of those: the client asks
  // checkNow the moment the link falls and again when it returns.
  setTimeout(checkNow, 2000);
  schedule();

  window.KPUpdate = {
    arm: arm,
    checkNow: checkNow,
    setReload(fn) { if (typeof fn === 'function') reloadImpl = fn; }
  };
})();
