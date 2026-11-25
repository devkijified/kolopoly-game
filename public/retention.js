'use strict';
// Daily market shelf, home-screen install, and whisper opt-in.
// The ask waits for a win or the first Claim. Nothing here subscribes
// on a cold landing. Sound-off and the shelf switch can mute whispers.
// A phone that already refused permission is not asked again.
(function () {
  const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
  let deferredInstall = null;
  let pushEnabled = false;
  let publicKey = null;
  let subscribed = false;
  let serverMuted = false;
  let serverDenied = false;
  let asking = false;
  let syncing = false;
  let deviceHasSub = false;
  let installShown = false;
  let refreshed = false;
  let winPending = false;
  let claimPending = false;

  function clientId() {
    try { return localStorage.getItem('kolopolyClientId') || ''; } catch (e) { return ''; }
  }
  function seatToken() {
    try {
      const raw = localStorage.getItem('kolopolySeatLS') || sessionStorage.getItem('kolopolySeat');
      const seat = JSON.parse(raw || 'null');
      return seat && seat.token ? seat.token : '';
    } catch (e) { return ''; }
  }
  function playerName() {
    try { return localStorage.getItem('kolopolyName') || ''; } catch (e) { return ''; }
  }
  function localMuted() {
    try { return localStorage.getItem('kolopolyWhisperMuted') === '1'; } catch (e) { return false; }
  }
  function setLocalMuted(on) {
    try {
      if (on) localStorage.setItem('kolopolyWhisperMuted', '1');
      else localStorage.removeItem('kolopolyWhisperMuted');
    } catch (e) { /* storage can be closed */ }
  }
  function snoozed() {
    try { return Number(localStorage.getItem('kolopolyRetentionLater') || 0) > Date.now(); }
    catch (e) { return false; }
  }
  function standalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  function ios() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function $(id) { return document.getElementById(id); }
  function setLine(text) { const el = $('marketLine'); if (el) el.textContent = text || ''; }

  function authToken() {
    try { return localStorage.getItem('kolopolyAuthToken') || ''; } catch (e) { return ''; }
  }
  function identityBody() {
    const body = { clientId: clientId(), token: seatToken(), name: playerName() };
    const t = authToken();
    if (t) body.authToken = t;
    return body;
  }
  async function post(url, extra) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(identityBody(), extra || {}))
    });
    return res.json();
  }

  function renderShelf() {
    const shelf = $('marketShelf');
    if (!shelf) return;
    if (window.KPRewards && window.KPRewards.current) window.KPRewards.paintShelf(window.KPRewards.current);
  }
  function paintShelfBtn(view) {
    const b = $('shelfBtn');
    if (!b) return;
    const landing = document.getElementById('view-landing');
    const onLanding = !!(landing && landing.classList.contains('active'));
    if (!onLanding || !clientId()) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    b.classList.toggle('ready', !!(view && view.canClaim));
    b.setAttribute('aria-label', view && view.canClaim ? 'Claim the market drop' : 'Market shelf');
    if (!b.dataset.drawn) {
      b.dataset.drawn = '1';
      b.innerHTML = '<svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="16" cy="18" rx="10" ry="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 17c2 2 10 2 12 0" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
    }
  }
  function setShelfOpen(on) {
    const card = $('marketCard');
    const close = $('shelfClose');
    if (card) card.classList.toggle('market-open', !!on);
    if (close) close.classList.toggle('hidden', !on);
    paintStrip();
  }
  function renderClaim(view) {
    const btn = $('claimBtn');
    if (!btn || !view) return;
    if (view.canClaim) {
      btn.disabled = false;
      btn.classList.remove('hidden');
      btn.classList.add('claim-live');
      setDailyTitle(btn, 'Claim your drop');
      setLine('');
    } else {
      btn.classList.remove('claim-live');
      btn.classList.add('hidden');
      btn.disabled = true;
      setLine('');
    }
    renderShelf();
    paintShelfBtn(view);
    paintSpin(view);
    paintEvent(view);
    paintRematch(view);
    window.__kpRivalries = (view && view.rivalries) || [];
    lastView = view;
    paintStrip();
    if (window.KPpaintAccountChip) window.KPpaintAccountChip(v2view);
  }

  // The landing carries ONE compact shelf strip fed by the v2 view:
  // kolo pieces, streak, and a held ticket. The old "Postcards 0/12"
  // cell was the board-card album, not the sticker book, so it left
  // the strip. The sticker album lives on the cash sheet.
  let v2view = null;
  let lastView = null;
  async function refreshV2() {
    const id = clientId();
    if (!id) return;
    try {
      const res = await fetch('/api/retention?v=2&clientId=' + encodeURIComponent(id) + (authToken() ? '&authToken=' + encodeURIComponent(authToken()) : ''));
      const v = await res.json();
      if (!v || !v.ok) return;
      v2view = v;
      paintStrip();
      if (window.KPpaintAccountChip) window.KPpaintAccountChip(v2view);
    } catch (e) { /* the strip can wait for the next open */ }
  }
  function paintStrip() {
    const strip = $('shelfStrip');
    if (!strip) return;
    const card = $('marketCard');
    if (!v2view || (card && card.classList.contains('market-open'))) { strip.classList.add('hidden'); return; }
    const kolo = v2view.kolo || { pieces: 0, piecesNeeded: 7, ticket: null };
    const streak = v2view.streak || { week: 0 };
    let cells =
      '<span class="strip-cell"><span class="strip-k">Kolo</span><span class="strip-v">' + (kolo.pieces || 0) + '/' + (kolo.piecesNeeded || 7) + '</span></span>' +
      '<span class="strip-cell"><span class="strip-k">Streak</span><span class="strip-v">' + (streak.week || 0) + 'd</span></span>';
    if (kolo.ticket) cells += '<span class="strip-cell"><span class="strip-k">Ticket</span><span class="strip-v">Lagos ₦200</span></span>';
    if (lastView && lastView.canClaim) cells += '<span class="strip-claim">Claim</span>';
    strip.innerHTML = cells;
    strip.classList.remove('hidden');
  }
  // The phone rig can force a permission or a missing push stack when it
  // is proving the opt-in states. A real visit never sets these.
  function notificationPermission() {
    try { if (typeof window.__kpForcePerm === 'string') return window.__kpForcePerm; } catch (e) { /* use the browser */ }
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  }
  function browserCanPush() {
    try { if (window.__kpForcePush === 'off') return false; } catch (e) { /* use the browser */ }
    return typeof Notification !== 'undefined' && 'serviceWorker' in navigator && typeof window.PushManager === 'function';
  }
  function iosNeedsIcon() {
    return ios() && !standalone() && notificationPermission() !== 'granted';
  }
  function pushDenied() {
    const perm = notificationPermission();
    if (perm === 'denied') return true;
    if (perm === 'granted') return false;
    return !!serverDenied;
  }
  function iosNeedsHome() {
    return ios() && !standalone();
  }
  function whispersOn() {
    if (iosNeedsHome()) return false;
    if (!browserCanPush() || pushDenied() || localMuted() || serverMuted) return false;
    // A live PushSubscription on this phone is the witness. iOS can
    // report permission as "default" after a relaunch even when the
    // subscription is still there.
    if (deviceHasSub) return true;
    return notificationPermission() === 'granted' && subscribed;
  }
  function canAskWhisper() {
    if (!pushEnabled || !browserCanPush()) return false;
    if (pushDenied() || whispersOn()) return false;
    if (localMuted() || serverMuted) return false;
    if (iosNeedsIcon()) return false;
    return true;
  }
  function renderSwitch() {
    const box = $('optWhisper');
    const cap = $('whisperCap');
    const row = box ? box.closest('.whisper-row') : null;
    if (!box) return;
    syncing = true;
    const denied = pushDenied();
    const on = whispersOn();
    const canBrowser = browserCanPush();
    const muted = !on && !denied && (localMuted() || serverMuted);
    box.checked = on;
    box.disabled = !clientId() || !pushEnabled || !canBrowser || denied;
    let state = '';
    if (cap) {
      if (iosNeedsHome()) { cap.textContent = 'Add to Home Screen to get alerts'; state = 'ios'; box.checked = false; box.disabled = false; }
      else if (!pushEnabled) { cap.textContent = 'Off'; state = 'off'; }
      else if (!canBrowser) { cap.textContent = 'Unavailable'; state = 'unavailable'; }
      else if (denied) { cap.textContent = 'Blocked'; state = 'blocked'; }
      else if (muted) { cap.textContent = 'Muted'; state = 'muted'; }
      else if (on) { cap.textContent = 'On'; state = 'on'; }
      else cap.textContent = '';
      cap.dataset.state = state;
    }
    if (row) row.classList.toggle('is-on', on);
    syncing = false;
    paintSheet();
  }
  function paintSheet() {
    const sheet = $('retentionSheet');
    if (!sheet || sheet.classList.contains('hidden')) return;
    const reason = sheet.dataset.reason || '';
    const canInstall = !standalone() && (!!deferredInstall || ios());
    const ask = canAskWhisper();
    const on = whispersOn();
    const denied = pushDenied();
    const muted = !on && (localMuted() || serverMuted);
    const perm = notificationPermission();
    const title = $('retentionTitle');
    const body = $('retentionBody');
    const iosLine = $('retentionIos');
    const installBtn = $('retentionInstall');
    const whisperBtn = $('retentionWhisper');
    const later = $('retentionLater');
    const live = $('retentionLive');
    const status = $('retentionStatus');
    const close = $('retentionClose');
    if (title) title.textContent = reason === 'win' ? 'The table remembers a landlord' : 'The market knows your shelf';
    if (iosLine) {
      iosLine.textContent = ios() && !standalone()
        ? 'On iPhone, tap Share, then Add to Home Screen. Whispers only arrive from that icon.'
        : '';
    }
    let statusText = '';
    if (on) {
      if (body) body.textContent = canInstall
        ? 'Whispers are on. Add Kolopoly to your home screen so the table stays one tap away.'
        : 'Whispers are on. The table will tap you when the pot swells, your seat is held, or the next drop is ready.';
    } else if (denied) {
      statusText = 'Whispers blocked';
      if (body) body.textContent = 'This phone already refused whispers. Turn them on in the phone settings if you change your mind. The shelf still works.';
    } else if (!browserCanPush()) {
      statusText = 'Whispers unavailable';
      if (body) body.textContent = 'This phone cannot take whispers. The shelf still works.';
    } else if (!pushEnabled) {
      statusText = 'Whispers off';
      if (body) body.textContent = 'Whispers are not turned on for this server yet. Your packs still dey your shelf.';
    } else if (iosNeedsIcon()) {
      if (body) body.textContent = 'Add Kolopoly to your home screen so the table stays one tap away. Whispers only arrive from that icon.';
    } else if (muted) {
      statusText = 'Whispers muted';
      if (body) body.textContent = 'Whispers are quiet on this phone. Turn them back on when you want the table to tap you.';
    } else if (perm === 'granted') {
      if (body) body.textContent = 'This phone already allowed whispers. One tap finishes it. The table will tap you when the pot swells, your seat is held, or the next drop is ready.';
    } else if (body) {
      body.textContent = 'Add Kolopoly to your home screen so the table stays one tap away. Whispers fit tell you when the Owambe pot swells, when your seat dey held, or when the next drop is ready.';
    }
    if (status) {
      status.textContent = statusText;
      status.classList.toggle('hidden', !statusText);
    }
    if (live) live.classList.toggle('hidden', !on);
    if (installBtn) installBtn.classList.toggle('hidden', !canInstall || (ios() && !deferredInstall));
    const showWhisperBtn = (ask || (muted && !denied && browserCanPush() && pushEnabled && !iosNeedsIcon()));
    if (whisperBtn) whisperBtn.classList.toggle('hidden', !showWhisperBtn);
    // "Not now" is the decline. It stays only while the ask is still open.
    // Once the phone has allowed whispers, or already refused them, it goes.
    const showLater = !on && perm !== 'granted' && !denied && browserCanPush() && pushEnabled && !muted && (ask || iosNeedsIcon());
    if (later) later.classList.toggle('hidden', !showLater);
    if (close) close.classList.toggle('hidden', showLater);
  }

  async function refresh() {
    const id = clientId();
    if (!id) {
      const btn = $('claimBtn');
      if (btn) btn.disabled = true;
      setLine('This phone is not keeping a shelf yet.');
      return;
    }
    try {
      const res = await fetch('/api/retention?clientId=' + encodeURIComponent(id) + (authToken() ? '&authToken=' + encodeURIComponent(authToken()) : ''));
      const view = await res.json();
      if (!view || !view.ok) return;
      if (view.rewards && window.KPRewards) window.KPRewards.paintShelf(view.rewards);
      pushEnabled = !!(view.push && view.push.enabled);
      publicKey = view.push ? view.push.publicKey : null;
      subscribed = !!(view.push && view.push.subscribed);
      serverMuted = !!(view.push && view.push.muted);
      serverDenied = !!(view.push && view.push.denied);
      renderClaim(view);
      refreshV2();
      if (localMuted() && subscribed && !serverMuted) {
        await post('/api/push/mute', { muted: true });
        serverMuted = true;
      }
      if (view && view.installed) accountInstalled = true;
      else if (localInstalled() && authToken()) rememberInstalled();
      renderSwitch();
      paintInstallButton();
      refreshed = true;
      adoptDeviceSubscription().then(() => { renderSwitch(); }).catch(() => {});
      if (winPending) maybeAsk('win');
      else if (claimPending) maybeAsk('claim');
    } catch (e) { /* the shelf can wait for the next open */ }
  }

  function deviceSubscription() {
    if (!browserCanPush() || !('serviceWorker' in navigator)) return Promise.resolve(null);
    const ready = navigator.serviceWorker.ready;
    if (!ready || typeof ready.then !== 'function') return Promise.resolve(null);
    return Promise.race([
      ready.then((reg) => (reg && reg.pushManager ? reg.pushManager.getSubscription() : null)).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500))
    ]);
  }
  async function adoptDeviceSubscription() {
    if (iosNeedsHome()) return;
    const sub = await deviceSubscription();
    if (!sub || !sub.endpoint) return;
    deviceHasSub = true;
    if (localMuted() || serverMuted) return;
    if (subscribed && !serverMuted) return;
    try {
      const out = await post('/api/push/subscribe', { subscription: sub.toJSON() });
      if (out && out.ok) {
        subscribed = true;
        serverMuted = false;
        serverDenied = false;
      }
    } catch (e) { /* the toggle still follows the phone */ }
  }

  function b64urlToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function enableWhispers() {
    if (!pushEnabled || !publicKey) {
      setLine('Whispers are not turned on for this server yet. Your packs still dey your shelf.');
      renderSwitch();
      return false;
    }
    if (notificationPermission() === 'denied') {
      serverDenied = true;
      try { await post('/api/push/denied', {}); } catch (e) { /* local denial still stands */ }
      renderSwitch();
      return false;
    }
    if (ios() && !standalone()) {
      setLine('On iPhone, add Kolopoly to your Home Screen first. Whispers only arrive from that icon.');
      renderSwitch();
      return false;
    }
    if (!browserCanPush()) {
      setLine('This phone cannot take whispers. The shelf still works.');
      renderSwitch();
      return false;
    }
    let perm = notificationPermission();
    if (perm !== 'granted') perm = await Notification.requestPermission();
    try { if (perm === 'granted') window.__kpForcePerm = 'granted'; } catch (e) { /* the browser permission still stands */ }
    if (perm !== 'granted') {
      if (perm === 'denied') {
        serverDenied = true;
        try { await post('/api/push/denied', {}); } catch (e) { /* recorded locally */ }
      }
      renderSwitch();
      return false;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64urlToBytes(publicKey)
      });
    }
    const json = sub.toJSON();
    const out = await post('/api/push/subscribe', { subscription: json });
    if (!out || !out.ok) {
      setLine('The table could not keep this whisper. Try the switch again.');
      renderSwitch();
      return false;
    }
    subscribed = true;
    serverMuted = false;
    serverDenied = false;
    setLocalMuted(false);
    renderSwitch();
    return true;
  }

  async function muteWhispers(on) {
    setLocalMuted(!!on);
    if (clientId()) {
      try {
        const out = await post('/api/push/mute', { muted: !!on });
        if (out && out.ok) serverMuted = !!out.muted;
      } catch (e) { /* the local mute still holds */ }
    }
    renderSwitch();
  }

  function hideSheet() {
    const sheet = $('retentionSheet');
    if (sheet) sheet.classList.add('hidden');
  }
  function maybeAsk(reason) {
    if (asking || snoozed()) return;
    const canInstall = !standalone() && (!!deferredInstall || ios());
    // A phone that already answered, with nothing left to install, stays
    // quiet. The shelf switch is the on, blocked, or muted state.
    if (!canInstall && !canAskWhisper()) return;
    const sheet = $('retentionSheet');
    if (!sheet) return;
    asking = true;
    sheet.dataset.reason = reason || '';
    sheet.classList.remove('hidden');
    paintSheet();
  }

  async function onClaim() {
    const btn = $('claimBtn');
    if (!clientId()) return;
    if (btn) btn.disabled = true;
    try {
      const out = await post('/api/retention/claim', {});
      if (!out || !out.ok) {
        if (btn) btn.disabled = false;
        setLine('The market no answer. Try the claim again.');
        return;
      }
      if (out.rewards && window.KPRewards) window.KPRewards.paintShelf(out.rewards);
      renderClaim(out);
      const landed = $('marketLanded');
      if (landed) {
        landed.textContent = out.granted ? (out.line || 'Big Daddy don drop your pack.') : '';
      }
      if (out.granted && window.KPBigDaddy) window.KPBigDaddy.show('drop');
      if (out.first) {
        claimPending = true;
        if (refreshed) maybeAsk('claim');
      }
    } catch (e) {
      if (btn) btn.disabled = false;
      setLine('The market no answer. Try the claim again.');
    }
  }

  function placeMarket() {
    const market = $('marketCard');
    const welcome = $('welcomeCard');
    const join = $('joinCard');
    if (!market || !welcome || !join) return;
    // Landing order: the shelf card sits directly under whichever home
    // card is showing (the welcome card for a remembered player, the
    // join card otherwise), above the token rail.
    const home = !welcome.classList.contains('hidden') ? welcome : join;
    const rail = $('dailyRail');
    if (home.parentNode) {
      if (rail) home.parentNode.insertBefore(rail, home.nextSibling);
      home.parentNode.insertBefore(market, rail ? rail.nextSibling : home.nextSibling);
    }
    paintStrip();
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    sawInstallPrompt = true;
    androidAssumed = false;
    paintInstallButton();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    rememberInstalled();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const claimBtn = $('claimBtn');
  if (claimBtn) claimBtn.addEventListener('click', onClaim);
  const shelfBtn = $('shelfBtn');
  if (shelfBtn) shelfBtn.addEventListener('click', () => {
    const card = $('marketCard');
    setShelfOpen(!(card && card.classList.contains('market-open')));
  });
  const shelfClose = $('shelfClose');
  if (shelfClose) shelfClose.addEventListener('click', () => setShelfOpen(false));
  const shelfStrip = $('shelfStrip');
  if (shelfStrip) shelfStrip.addEventListener('click', () => setShelfOpen(true));
  const box = $('optWhisper');
  if (box) box.addEventListener('change', () => {
    if (syncing) return;
    if (iosNeedsHome()) {
      box.checked = false;
      showInstallSheet('alerts');
      return;
    }
    if (box.checked) enableWhispers().then((ok) => { if (!ok) renderSwitch(); });
    else { deviceHasSub = false; muteWhispers(true); }
  });
  function dismissSheet() {
    try { localStorage.setItem('kolopolyRetentionLater', String(Date.now() + SNOOZE_MS)); } catch (e) { /* still close */ }
    hideSheet();
  }
  const later = $('retentionLater');
  if (later) later.addEventListener('click', dismissSheet);
  const closeBtn = $('retentionClose');
  if (closeBtn) closeBtn.addEventListener('click', dismissSheet);
  const offBtn = $('retentionOff');
  if (offBtn) offBtn.addEventListener('click', () => { muteWhispers(true); });
  const installBtn = $('retentionInstall');
  if (installBtn) installBtn.addEventListener('click', async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (e) { /* the sheet can stay */ }
      deferredInstall = null;
      installBtn.classList.add('hidden');
      return;
    }
    const iosLine = $('retentionIos');
    if (iosLine) iosLine.textContent = 'On iPhone, tap Share, then Add to Home Screen. Whispers only arrive from that icon.';
  });
  const whisperBtn = $('retentionWhisper');
  if (whisperBtn) whisperBtn.addEventListener('click', () => { enableWhispers(); });

  try { if (localStorage.getItem('kolopolyAudio') === '3') setLocalMuted(true); } catch (e) { /* sound pref can be unread */ }
  placeMarket();
  refresh();

  // -------------------------------------------------------------------
  // Inflation record (cosmetic only, docs/INFLATION-7.md section 5).
  // A finished Inflation game leaves a small local record: games, wins,
  // best phase reached, best final net worth, clean wins, a rematch
  // chain, and the milestone badges earned. No cash, no goods, nothing
  // promised as money. The app only calls this for a seated player
  // whose game reached the end without them resigning, so quitting
  // early and farming Hustle earn nothing here.
  // -------------------------------------------------------------------
  const INF_RECORD_KEY = 'kolopolyInfRecord';
  const INF_CHAIN_MS = 10 * 60 * 1000;
  const INF_BADGES = [
    ['first', 'First Reckoning'],
    ['heat', 'Heat Survivor'],
    ['crisis', 'Crisis Survivor'],
    ['final', 'Final Reckoning'],
    ['landlord', 'Landlord of the Reckoning'],
    ['clean', 'Clean Hands'],
    ['iron', 'Iron Tenant']
  ];
  function infDefault() {
    return { games: 0, wins: 0, cleanWins: 0, bestPhase: 0, bestNetWorth: 0, chain: 0, lastEndAt: 0, lastGameKey: '', badges: [], iron: false };
  }
  function infLoad() {
    try {
      const raw = JSON.parse(localStorage.getItem(INF_RECORD_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return infDefault();
      return Object.assign(infDefault(), raw);
    } catch (e) { return infDefault(); }
  }
  function infSave(p) {
    try { localStorage.setItem(INF_RECORD_KEY, JSON.stringify(p)); } catch (e) { /* storage can be closed */ }
  }
  function infBadgeEarned(p, id) {
    switch (id) {
      case 'first': return p.games >= 1;
      case 'heat': return p.bestPhase >= 3;
      case 'crisis': return p.bestPhase >= 5;
      case 'final': return p.bestPhase >= 7;
      case 'landlord': return p.wins >= 1;
      case 'clean': return p.cleanWins >= 1;
      case 'iron': return !!p.iron;
      default: return false;
    }
  }
  function infBadgeLabels(p, onlyIds) {
    return INF_BADGES.filter(([id]) => (!onlyIds || onlyIds.includes(id)) && (onlyIds ? true : p.badges.includes(id))).map(([, label]) => label);
  }
  // summary: { gameKey, phaseReached, won, netWorth, lifelineUsed,
  // hustledTimes, topHalf }. Returns the standing profile plus the
  // badges this game newly earned, or null for a bad summary.
  function recordInflationGame(summary) {
    if (!summary || !summary.gameKey) return null;
    const p = infLoad();
    if (p.lastGameKey === summary.gameKey) {
      // The same finished game seen again (a refresh on the end
      // screen): report the standing record, count nothing twice.
      return { profile: p, newBadges: [], badges: infBadgeLabels(p) };
    }
    const before = INF_BADGES.filter(([id]) => infBadgeEarned(p, id)).map(([id]) => id);
    p.games += 1;
    if (summary.won) {
      p.wins += 1;
      if (!summary.lifelineUsed) p.cleanWins += 1;
    }
    if (summary.phaseReached > p.bestPhase) p.bestPhase = summary.phaseReached;
    if (summary.netWorth > p.bestNetWorth) p.bestNetWorth = summary.netWorth;
    if (summary.topHalf && (summary.hustledTimes || 0) >= 1) p.iron = true;
    const nowMs = Date.now();
    // A rematch chain is games finished back to back at one sitting:
    // the next finish lands within 20 minutes of the last one.
    p.chain = (p.lastEndAt && nowMs - p.lastEndAt <= INF_CHAIN_MS) ? (p.chain || 1) + 1 : 1;
    p.lastEndAt = nowMs;
    p.lastGameKey = summary.gameKey;
    const earned = INF_BADGES.filter(([id]) => infBadgeEarned(p, id)).map(([id]) => id);
    p.badges = earned;
    infSave(p);
    return {
      profile: p,
      newBadges: infBadgeLabels(p, earned.filter((id) => !before.includes(id))),
      badges: infBadgeLabels(p, earned)
    };
  }

  const INSTALL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
  const INSTALLED_KEY = 'kp_installed';
  let accountInstalled = false;
  let sawInstallPrompt = false;
  let androidAssumed = false;
  function installSnoozed() {
    try { return Number(localStorage.getItem('kolopolyInstallLater') || 0) > Date.now(); } catch (e) { return false; }
  }
  function snoozeInstall() {
    try { localStorage.setItem('kolopolyInstallLater', String(Date.now() + INSTALL_SNOOZE_MS)); } catch (e) { /* still close */ }
  }
  function localInstalled() {
    try { return localStorage.getItem(INSTALLED_KEY) === '1'; } catch (e) { return false; }
  }
  function deviceKind() {
    const ua = navigator.userAgent || '';
    if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ipad';
    if (/iPhone|iPod/.test(ua)) return 'iphone';
    if (/Android/i.test(ua)) return 'android';
    return 'other';
  }
  function installCta() {
    const k = deviceKind();
    if (k === 'iphone') return 'Install on your iPhone';
    if (k === 'ipad') return 'Install on your iPad';
    if (k === 'android') return 'Install on your Android';
    return 'Install Kolopoly';
  }
  function installGuideTitle() {
    const k = deviceKind();
    if (k === 'ipad') return 'Install Kolopoly on your iPad';
    return 'Install Kolopoly on your iPhone';
  }
  function knownInstalled() {
    return standalone() || localInstalled() || accountInstalled || (deviceKind() === 'android' && androidAssumed);
  }
  function installMode() {
    if (standalone()) return 'hidden';
    if (deviceKind() === 'android' && (localInstalled() || accountInstalled || androidAssumed)) return 'hidden';
    if (ios() && (localInstalled() || accountInstalled)) return 'note';
    if (localInstalled() || accountInstalled) return 'hidden';
    return 'prompt';
  }
  function rememberInstalled() {
    try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) { /* storage can be closed */ }
    accountInstalled = true;
    const sheet = $('installSheet');
    if (sheet) sheet.classList.add('hidden');
    paintInstallButton();
    const t = authToken();
    if (!t) return;
    fetch('/api/account/installed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify(identityBody())
    }).catch(() => {});
  }
  function shareIcon() {
    return '<svg class="ig-share" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3.2l4.2 4.2-1.4 1.4L13 6.9V15h-2V6.9L9.2 8.8 7.8 7.4 12 3.2zM5 13h2v6h10v-6h2v8H5v-8z"/></svg>';
  }
  function ensureInstallSheet() {
    let sheet = $('installSheet');
    if (sheet) return sheet;
    sheet = document.createElement('div');
    sheet.id = 'installSheet';
    sheet.className = 'install-sheet hidden';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-labelledby', 'installTitle');
    document.body.appendChild(sheet);
    return sheet;
  }
  function showIosGuide() {
    if (standalone() || installMode() !== 'prompt') return;
    const sheet = ensureInstallSheet();
    sheet.innerHTML = '<h2 class="title" id="installTitle">' + installGuideTitle() + '</h2>' +
      '<div class="install-guide">' +
        '<div class="ig-step ig-1"><div class="ig-bar"><span class="ig-arrow" aria-hidden="true"></span>' + shareIcon() + '</div><p>Tap Safari\'s share icon</p></div>' +
        '<div class="ig-step ig-2"><div class="ig-row"><span class="ig-plus" aria-hidden="true">+</span><span>Add to Home Screen</span></div></div>' +
      '</div>' +
      '<button class="btn ghost block mt8" type="button" id="installLater">Not now</button>';
    const later = $('installLater');
    if (later) later.addEventListener('click', () => { snoozeInstall(); sheet.classList.add('hidden'); });
    sheet.classList.remove('hidden');
  }
  async function fireAndroidInstall() {
    if (!deferredInstall) return false;
    const ev = deferredInstall;
    deferredInstall = null;
    try { ev.prompt(); await ev.userChoice; } catch (e) { /* the browser sheet can close itself */ }
    paintInstallButton();
    return true;
  }
  function showInstallSheet() {
    if (installMode() !== 'prompt') return;
    if (ios()) { showIosGuide(); return; }
    fireAndroidInstall();
  }
  function paintInstallButton() {
    const b = $('lobbyInstallBtn');
    const mode = installMode();
    if (b) {
      b.textContent = installCta();
      b.classList.toggle('hidden', mode !== 'prompt');
      if (!b.dataset.wired) {
        b.dataset.wired = '1';
        b.addEventListener('click', () => showInstallSheet());
      }
    }
    let note = $('lobbyInstallNote');
    if (!note && b && b.parentNode) {
      note = document.createElement('p');
      note.id = 'lobbyInstallNote';
      note.className = 'install-note hidden';
      b.parentNode.insertBefore(note, b.nextSibling);
    }
    if (note) {
      note.textContent = 'Open the Kolopoly app from your Home Screen';
      note.classList.toggle('hidden', mode !== 'note');
    }
    const card = $('endInstall');
    if (card && mode !== 'prompt') card.remove();
  }
  function maybeInstall(reason) {
    paintInstallButton();
    if (installMode() !== 'prompt' || installShown || installSnoozed()) return;
    if (reason !== 'end' && reason !== 'lobby') return;
    installShown = true;
    if (ios()) showIosGuide();
  }
  async function detectAndroidInstall() {
    if (deviceKind() !== 'android' || standalone()) return;
    try {
      if (typeof navigator.getInstalledRelatedApps === 'function') {
        const apps = await navigator.getInstalledRelatedApps();
        if (Array.isArray(apps) && apps.some((a) => a && (a.platform === 'webapp' || a.url))) {
          rememberInstalled();
          return;
        }
      }
    } catch (e) { /* the prompt event is the other witness */ }
    setTimeout(() => {
      if (!sawInstallPrompt && !deferredInstall && !localInstalled()) {
        androidAssumed = true;
        paintInstallButton();
      }
    }, 3000);
  }
  if (standalone()) rememberInstalled();
  else detectAndroidInstall();
  paintInstallButton();

  function setDailyTitle(btn, text) {
    if (!btn) return;
    const title = btn.querySelector('.daily-title');
    if (title) title.textContent = text;
    else btn.textContent = text;
  }
  function daysLeft(ends) {
    const end = Date.parse(String(ends || '') + 'T23:59:59Z');
    if (!end) return '';
    const days = Math.max(0, Math.ceil((end - Date.now()) / 86400000));
    if (days <= 1) return '1 day left';
    return days + ' days left';
  }
  function paintEvent(view) {
    const el = $('eventBanner');
    if (!el) return;
    const ev = view && view.event;
    if (!ev) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    const art = '/events/' + encodeURIComponent(ev.id) + '.webp?v=__KOLOPOLY_BUILD__';
    const sticker = '/stickers/' + encodeURIComponent(ev.sticker.id) + '.webp?v=__KOLOPOLY_BUILD__';
    const left = daysLeft(ev.ends);
    el.innerHTML =
      '<img class="event-art" alt="" width="960" height="540" decoding="async" src="' + art + '">' +
      '<div class="event-face">' +
        '<div class="event-copy">' +
          '<span class="count-chip">' + left + '</span>' +
          '<h3>' + ev.name + '</h3>' +
          '<p>' + ev.blurb + '</p>' +
        '</div>' +
        '<div class="event-sticker" title="' + ev.sticker.name + '">' +
          '<img alt="" width="512" height="512" decoding="async" src="' + sticker + '">' +
          '<span>Week sticker</span>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="btn gold" id="eventClaim">Collect</button>';
    const b = $('eventClaim');
    if (b) b.addEventListener('click', async (evClick) => {
      evClick.stopPropagation();
      let out = null;
      try { out = await post('/api/events/claim', {}); } catch (e) { out = null; }
      setLine(out && out.ok ? (ev.sticker.name + ' don enter your album.') : ((out && out.message) || 'That sticker no land.'));
      if (out && out.ok) b.disabled = true;
    });
  }
  function paintRematch(view) {
    const el = $('rematchBanner');
    if (!el) return;
    const row = view && view.rematch;
    if (!row) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    const rawName = row.name || 'Your person';
    const name = String(rawName).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const letter = rawName.trim().charAt(0).toUpperCase() || '?';
    const token = (row.token && window.tokenArt) ? window.tokenArt(row.token, 48) : ('<span class="payback-letter">' + letter + '</span>');
    const wins = row.wins || 0;
    const losses = row.losses || 0;
    el.innerHTML =
      '<img class="payback-daddy" alt="" width="256" height="320" decoding="async" src="/mascot/daddy-money.webp?v=__KOLOPOLY_BUILD__">' +
      '<div class="payback-body">' +
        '<p class="event-kicker">PAY THEM BACK</p>' +
        '<div class="payback-who"><span class="payback-token">' + token + '</span><strong>' + name + '</strong></div>' +
        '<p class="payback-score"><span>' + wins + '</span><em>you</em><span>' + losses + '</span><em>them</em></p>' +
        '<button type="button" class="btn gold" id="rematchGo">Rematch</button>' +
      '</div>';
    const go = $('rematchGo');
    if (go) go.addEventListener('click', () => {
      const welcome = $('welcomeCard');
      const quick = welcome && !welcome.classList.contains('hidden') ? $('welcomeQuick') : $('quickBtn');
      if (quick) quick.click();
    });
  }
  function paintSpin(view) {
    const b = $('spinBtn');
    if (!b) return;
    const ready = !!(view && view.spin && view.spin.canSpin);
    b.disabled = !ready;
    setDailyTitle(b, ready ? 'Big Daddy spin' : 'Spin don finish today');
  }
  const SPIN_ART = {
    pack: '/mascot/daddy-clap.webp?v=__KOLOPOLY_BUILD__',
    card: '/cards/double.webp?v=__KOLOPOLY_BUILD__',
    sticker: '/stickers/eko-atlantic.webp?v=__KOLOPOLY_BUILD__',
    look: '/mascot/daddy-deed.webp?v=__KOLOPOLY_BUILD__',
    wink: '/mascot/daddy-stand.webp?v=__KOLOPOLY_BUILD__'
  };
  function wheelFace(segs) {
    const colors = ['#9c2b3a', '#1f7a45', '#e8a317', '#2f6f8f', '#c4552a'];
    const slice = 360 / Math.max(1, segs.length);
    const stops = segs.map((s, i) => colors[i % colors.length] + ' ' + (i * slice) + 'deg ' + ((i + 1) * slice) + 'deg').join(', ');
    const icons = segs.map((s, i) => {
      const ang = ((i + 0.5) * slice - 90) * Math.PI / 180;
      const x = 50 + Math.cos(ang) * 33;
      const y = 50 + Math.sin(ang) * 33;
      const src = SPIN_ART[s.id] || SPIN_ART.pack;
      return '<img class="wheel-prize" alt="" style="left:' + x.toFixed(1) + '%;top:' + y.toFixed(1) + '%" src="' + src + '">';
    }).join('');
    return '<div class="spin-wheel" id="spinWheel" style="background:conic-gradient(' + stops + ')">' + icons + '</div>';
  }
  function spinMarkup(segs) {
    const face = wheelFace(segs);
    let bulbs = '';
    for (let i = 0; i < 12; i++) bulbs += '<i style="transform:rotate(' + (i * 30) + 'deg) translateY(-104px)"></i>';
    return '<div class="spin-card"><p class="pack-kicker">BIG DADDY</p><h2>Spin am</h2>' +
      '<div class="wheel-row">' +
        '<img class="wheel-daddy" alt="" width="256" height="320" decoding="async" src="/mascot/daddy-stand.webp?v=__KOLOPOLY_BUILD__">' +
        '<div class="rim">' +
          '<div class="bulbs" aria-hidden="true">' + bulbs + '</div>' +
          '<div class="spin-pointer" aria-hidden="true"></div>' +
          face +
          '<button type="button" class="spin-hub" id="spinGo">SPIN</button>' +
        '</div>' +
      '</div>' +
      '<div class="spin-result" id="spinResult"><p>One spin. The wheel go decide.</p></div>' +
      '<button type="button" class="btn ghost block" id="spinClose">Close</button></div>';
  }
  function burstConfetti(stage) {
    const box = document.createElement('div');
    box.className = 'confetti';
    const colors = ['#ffc857', '#f4ecdc', '#e23d3d', '#3ecf8e', '#7eb6ff'];
    for (let i = 0; i < 18; i++) {
      const bit = document.createElement('i');
      bit.style.left = (8 + Math.random() * 84) + '%';
      bit.style.background = colors[i % colors.length];
      bit.style.animationDelay = (Math.random() * 0.25) + 's';
      box.appendChild(bit);
    }
    stage.appendChild(box);
    setTimeout(() => { if (box.parentNode) box.remove(); }, 1600);
  }
  function tickWheel() {
    const gaps = [70, 85, 100, 120, 150, 190, 240, 310, 400, 520, 680];
    let at = 80;
    gaps.forEach((gap) => {
      at += gap;
      setTimeout(() => { if (window.KPPreviewSfx) window.KPPreviewSfx('auctionTick'); }, at);
    });
  }
  function openSpin() {
    let stage = $('spinStage');
    if (stage) stage.remove();
    stage = document.createElement('div');
    stage.id = 'spinStage';
    stage.className = 'spin-scrim';
    const preview = [
      { id: 'pack', label: 'A fresh pack' },
      { id: 'card', label: 'A power card' },
      { id: 'sticker', label: 'A rare sticker' },
      { id: 'look', label: 'A new look' },
      { id: 'wink', label: 'Big Daddy wink' }
    ];
    stage.innerHTML = spinMarkup(preview);
    document.body.appendChild(stage);
    stage.querySelector('#spinClose').addEventListener('click', () => stage.remove());
    const go = stage.querySelector('#spinGo');
    go.addEventListener('click', async () => {
      go.disabled = true;
      let out = null;
      try { out = await post('/api/rewards/spin', {}); } catch (e) { out = null; }
      if (!out || !out.segments) {
        go.disabled = false;
        const result = stage.querySelector('#spinResult');
        if (result) result.innerHTML = '<p>The wheel no answer. Try again.</p>';
        return;
      }
      if (!out.ok) {
        paintSpin({ spin: out.spin });
        const result = stage.querySelector('#spinResult');
        if (result) result.innerHTML = '<p>You don spin today. The next one opens at dawn.</p>';
        return;
      }
      const segs = out.segments;
      const slice = 360 / segs.length;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const turns = reduce ? 0 : 5;
      const landing = turns * 360 + (360 - (out.index * slice) - slice / 2);
      const wheel = stage.querySelector('#spinWheel');
      wheel.outerHTML = wheelFace(segs);
      const live = stage.querySelector('#spinWheel');
      const finish = () => {
        const prize = out.prize || {};
        const src = SPIN_ART[prize.id] || SPIN_ART.pack;
        const result = stage.querySelector('#spinResult');
        if (result) {
          result.innerHTML = '<article class="prize-card"><img alt="" src="' + src + '"><h3>' +
            (prize.label || 'Something don land') + '</h3><p>' + (prize.line || '') + '</p></article>';
        }
        go.textContent = 'Nice';
        burstConfetti(stage);
        if (out.rewards && window.KPRewards) window.KPRewards.paintShelf(out.rewards);
        paintSpin({ spin: out.spin });
        if (window.KPBigDaddy) window.KPBigDaddy.show('drop', { force: true, line: prize.line || 'Spin don land!' });
        if (window.KPPreviewSfx) window.KPPreviewSfx('cheer');
      };
      if (reduce) { finish(); return; }
      tickWheel();
      requestAnimationFrame(() => { live.style.transform = 'rotate(' + landing + 'deg)'; });
      setTimeout(finish, 3400);
    });
  }
  const spinBtn = $('spinBtn');
  if (spinBtn) spinBtn.addEventListener('click', () => openSpin());
  window.KPRetention = {
    recordInflationGame,
    infProfile() { return infLoad(); },
    onWin(won) {
      if (!won) return;
      winPending = true;
      if (refreshed) maybeAsk('win');
    },
    placeMarket,
    muteFromSound() { muteWhispers(true); },
    maybeInstall,
    showInstall: showInstallSheet,
    endInstallHtml() {
      const mode = installMode();
      if (mode === 'note') return '<p class="install-note" id="endInstallNote">Open the Kolopoly app from your Home Screen</p>';
      if (mode !== 'prompt' || installSnoozed()) return '';
      return '<div class="install-card" id="endInstall"><button class="btn gold block" type="button" id="endInstallGo">' + installCta() + '</button><button class="btn ghost block mt8" type="button" id="endInstallLater">Not now</button></div>';
    },
    bindEndInstall() {
      const later = $('endInstallLater');
      if (later) later.addEventListener('click', () => {
        snoozeInstall();
        const card = $('endInstall');
        if (card) card.remove();
      });
      const go = $('endInstallGo');
      if (go) go.addEventListener('click', () => showInstallSheet('end'));
    },
    refresh,
    paintRematch
  };
})();
