'use strict';
// When to offer "Install Kolopoly", and the small landing chip that does it.
// Desktop stays quiet. A live match and training stay quiet. The chip never
// covers the Play buttons: it sits under them in the page.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.KPInstall = api;
  if (root && root !== window) root.KPInstall = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
  const FIRST_WAIT_MS = 20000;
  const LATER_WAIT_MS = 1000;
  const SNOOZE_KEY = 'kolopolyInstallLater';
  const GAMES_KEY = 'kolopolyInstallGames';
  const LANDED_KEY = 'kolopolyInstallLanded';
  const SEEN_KEY = 'kolopolyInstallSeen';

  function device(ua, opts) {
    ua = String(ua || '');
    opts = opts || {};
    const ipad = /iPad/.test(ua) || (opts.platform === 'MacIntel' && (opts.maxTouchPoints || 0) > 1);
    const iphone = /iPhone|iPod/.test(ua);
    const ios = ipad || iphone;
    const android = /Android/i.test(ua) && !ios;
    if (!ios && !android) return 'desktop';
    if (android) return 'android';
    const inApp = /FBAN|FBAV|Instagram|Line\/|TikTok|musical_ly|Snapchat|Twitter|MicroMessenger|GSA\/|CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    const safari = /Safari/.test(ua) && !inApp;
    return safari ? 'ios' : 'ios-inapp';
  }

  function installed(env) {
    if (!env) return false;
    if (env.standalone === true || env.navigatorStandalone === true) return true;
    const mode = env.displayMode || '';
    return mode === 'standalone' || mode === 'fullscreen' || mode === 'minimal-ui';
  }

  function decide(env) {
    env = env || {};
    const kind = env.kind || device(env.ua, env);
    if (kind === 'desktop') return { show: false, reason: 'desktop' };
    if (installed(env)) return { show: false, reason: 'installed' };
    if (env.inGame || env.inTraining) return { show: false, reason: 'busy' };
    if (!env.onLanding) return { show: false, reason: 'away' };
    if (env.snoozeUntil && env.now < env.snoozeUntil) return { show: false, reason: 'snooze' };
    if (env.sessionShown && !env.chipOpen) return { show: false, reason: 'session' };
    const waited = (env.now || 0) - (env.landedAt || 0);
    const need = (env.gamesPlayed || 0) >= 1 ? LATER_WAIT_MS : FIRST_WAIT_MS;
    if (waited < need) return { show: false, reason: 'early' };
    if (kind === 'android' && !env.hasPrompt) return { show: false, reason: 'no-prompt' };
    return { show: true, kind: kind };
  }

  function snoozeUntil(now) { return (now || 0) + SNOOZE_MS; }

  const ICON_SHARE = '<svg class="install-ico" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 3v9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8.2 6.6L12 3l3.8 3.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICON_PLUS = '<svg class="install-ico" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8M8 12h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  let deferred = null;
  let chipOpen = false;
  let sheetOpen = false;

  function storage(kind) {
    try { return kind === 'session' ? sessionStorage : localStorage; } catch (e) { return null; }
  }
  function readEnv(now) {
    if (typeof window === 'undefined' || !window.document) return null;
    if (window.__kpInstallPreview) return Object.assign({ now: now }, window.__kpInstallPreview, { chipOpen: chipOpen });
    const box = storage('local');
    const ses = storage('session');
    let displayMode = 'browser';
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) displayMode = 'standalone';
      else if (window.matchMedia('(display-mode: fullscreen)').matches) displayMode = 'fullscreen';
    } catch (e) { /* matchMedia can be missing */ }
    const landing = document.getElementById('view-landing');
    const game = document.getElementById('view-game');
    const onLanding = !!(landing && landing.classList.contains('active'));
    const inGame = !!(game && game.classList.contains('active'));
    const inTraining = document.body.classList.contains('train-on') || document.body.classList.contains('train-gate');
    let landedAt = 0;
    if (ses) {
      landedAt = Number(ses.getItem(LANDED_KEY) || 0);
      if (onLanding && !inGame && !inTraining && !landedAt) {
        landedAt = now;
        try { ses.setItem(LANDED_KEY, String(now)); } catch (e) { /* private mode */ }
      }
    }
    return {
      ua: navigator.userAgent || '',
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints || 0,
      standalone: displayMode !== 'browser' || navigator.standalone === true,
      displayMode: displayMode,
      navigatorStandalone: navigator.standalone === true,
      now: now,
      snoozeUntil: box ? Number(box.getItem(SNOOZE_KEY) || 0) : 0,
      sessionShown: !!(ses && ses.getItem(SEEN_KEY) === '1'),
      landedAt: landedAt || now,
      gamesPlayed: box ? Number(box.getItem(GAMES_KEY) || 0) : 0,
      inGame: inGame,
      inTraining: inTraining,
      onLanding: onLanding,
      hasPrompt: !!deferred,
      chipOpen: chipOpen
    };
  }

  function slot() {
    let el = document.getElementById('installSlot');
    if (el) return el;
    const play = document.getElementById('quickBtn');
    if (!play || !play.parentNode) return null;
    el = document.createElement('div');
    el.id = 'installSlot';
    el.hidden = true;
    play.parentNode.insertBefore(el, play.nextSibling);
    return el;
  }

  function backdrop() {
    let el = document.getElementById('installBackdrop');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'installBackdrop';
    el.className = 'install-backdrop';
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  }

  function hide() {
    chipOpen = false;
    sheetOpen = false;
    const el = document.getElementById('installSlot');
    if (el) { el.hidden = true; el.innerHTML = ''; el.dataset.kind = ''; el.dataset.sheet = ''; }
    const bg = document.getElementById('installBackdrop');
    if (bg) { bg.hidden = true; bg.innerHTML = ''; }
  }

  function markSeen() {
    const ses = storage('session');
    if (ses) { try { ses.setItem(SEEN_KEY, '1'); } catch (e) { /* private mode */ } }
  }

  function dismiss(now) {
    const box = storage('local');
    if (box) { try { box.setItem(SNOOZE_KEY, String(snoozeUntil(now || Date.now()))); } catch (e) { /* still close */ } }
    markSeen();
    hide();
  }

  function shareSheet() {
    return '<div class="install-sheet" role="dialog" aria-label="Add Kolopoly to your Home Screen">' +
      '<div class="install-grab"></div>' +
      '<h2>Add Kolopoly to your Home Screen</h2>' +
      '<ol class="install-steps">' +
      '<li><span class="install-num">1</span>' + ICON_SHARE + '<span>Tap Share</span></li>' +
      '<li><span class="install-num">2</span>' + ICON_PLUS + '<span>Tap Add to Home Screen</span></li>' +
      '</ol>' +
      '<p class="install-hint">Share is in Safari\'s toolbar <span class="install-down" aria-hidden="true">↓</span></p>' +
      '<button type="button" class="install-got">Got it</button></div>';
  }

  function paint(choice, now) {
    const el = slot();
    if (!el) return;
    const bg = backdrop();
    if (!choice.show) { hide(); return; }
    const sheetFlag = sheetOpen && choice.kind === 'ios' ? '1' : '0';
    if (el.dataset.kind === choice.kind && el.dataset.sheet === sheetFlag && !el.hidden && bg.hidden === !sheetOpen) return;
    markSeen();
    chipOpen = true;
    el.dataset.kind = choice.kind;
    el.dataset.sheet = sheetFlag;
    const title = choice.kind === 'ios-inapp' ? 'Open in Safari' : 'Install Kolopoly';
    const sub = choice.kind === 'ios-inapp' ? 'Install only works there' : 'Plays full screen, opens faster';
    const action = choice.kind === 'ios' ? 'How' : (choice.kind === 'android' ? 'Install' : '');
    el.hidden = false;
    el.innerHTML = '<div class="install-chip">' +
      '<div class="install-top">' +
      '<img src="/icons/icon-192.png" alt="" width="36" height="36">' +
      '<b>' + title + '</b>' +
      (action ? '<button type="button" class="install-go install-chip-go">' + action + '</button>' : '') +
      '<button type="button" class="install-x" aria-label="Not now">×</button></div>' +
      '<small>' + sub + '</small></div>';
    if (bg) {
      bg.hidden = !sheetOpen;
      bg.innerHTML = sheetOpen && choice.kind === 'ios' ? shareSheet() : '';
    }
    const go = el.querySelector('.install-chip-go');
    const ex = el.querySelector('.install-x');
    const got = bg && bg.querySelector('.install-got');
    if (ex) ex.addEventListener('click', () => dismiss(now));
    if (got) got.addEventListener('click', () => { sheetOpen = false; paint(choice, now); });
    if (bg) bg.onclick = (ev) => { if (ev.target === bg) { sheetOpen = false; paint(choice, now); } };
    if (go) go.addEventListener('click', () => {
      if (choice.kind === 'android' && deferred && typeof deferred.prompt === 'function') {
        const ev = deferred;
        deferred = null;
        try { ev.prompt(); } catch (e) { /* the browser sheet owns the rest */ }
        dismiss(now);
        return;
      }
      if (choice.kind === 'ios') {
        sheetOpen = true;
        el.dataset.sheet = '';
        paint(choice, now);
      }
    });
  }

  function tick(now) {
    if (typeof document === 'undefined') return { show: false, reason: 'no-dom' };
    const env = readEnv(now || Date.now());
    const choice = decide(env);
    paint(choice, env.now);
    return choice;
  }

  function noteGame() {
    const box = storage('local');
    if (box) { try { box.setItem(GAMES_KEY, '1'); } catch (e) { /* private mode */ } }
  }

  function notePrompt(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    deferred = event;
    tick(Date.now());
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('beforeinstallprompt', notePrompt);
    window.addEventListener('appinstalled', () => { deferred = null; hide(); });
    const boot = () => {
      tick(Date.now());
      setInterval(() => tick(Date.now()), 1000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  return {
    device: device,
    decide: decide,
    installed: installed,
    snoozeUntil: snoozeUntil,
    SNOOZE_MS: SNOOZE_MS,
    FIRST_WAIT_MS: FIRST_WAIT_MS,
    noteGame: noteGame,
    notePrompt: notePrompt,
    tick: tick,
    hide: hide
  };
});
