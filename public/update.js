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
  let reloadImpl = function () { window.location.reload(); };
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
  function paint() {
    const line = document.getElementById('updateLine');
    if (!line) return;
    line.textContent = left > 0
      ? ('Fresh table ready · reloading in ' + left)
      : 'Fresh table ready · reloading now';
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
      try { window.location.reload(); } catch (e2) { /* the countdown already asked */ }
    }
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
  function arm(opts) {
    opts = opts || {};
    if (armed) return;
    armed = true;
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
      if (worker.state === 'installed') arm();
    });
  }
  function bind(reg) {
    registration = reg;
    if (reg.waiting && hadController) arm();
    watchWorker(reg.installing);
    reg.addEventListener('updatefound', () => watchWorker(reg.installing));
  }
  async function poke() {
    if (document.visibilityState === 'hidden') return;
    try {
      if (registration) await registration.update();
    } catch (e) { /* a failed check leaves the open table alone */ }
    try {
      const res = await fetch('/api/version', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const build = data && data.build;
      if (!build) return;
      if (!loadedBuild) { loadedBuild = String(build); return; }
      if (String(build) !== loadedBuild) arm();
    } catch (e) { /* the version line can miss a round */ }
  }
  function schedule() {
    const wait = onLanding() ? LANDING_POLL_MS : TABLE_POLL_MS;
    setTimeout(() => { poke().then(schedule, schedule); }, wait);
  }

  const nowBtn = document.getElementById('updateNow');
  if (nowBtn) nowBtn.addEventListener('click', () => beginReload());

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      arm();
    });
    navigator.serviceWorker.register('/sw.js').then(bind).catch(() => {});
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poke();
  });
  // Landing checks often. A match that stays on screen still checks,
  // slower, so a home-screen table hears a deploy without a tab switch.
  setTimeout(poke, 2000);
  schedule();

  window.KPUpdate = {
    arm: arm,
    setReload(fn) { if (typeof fn === 'function') reloadImpl = fn; }
  };
})();
