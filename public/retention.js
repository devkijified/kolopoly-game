'use strict';
// Daily market shelf, home-screen install, and whisper opt-in.
// The ask waits for a win or the first Claim. Nothing here subscribes
// on a cold landing. Sound-off and the shelf switch can mute whispers.
// A phone that already refused permission is not asked again.
(function () {
  const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
  const GOODS = [
    ['cowries', 'Cowries'],
    ['kola', 'Kola'],
    ['yams', 'Yams'],
    ['cloth', 'Cloth']
  ];
  let deferredInstall = null;
  let pushEnabled = false;
  let publicKey = null;
  let subscribed = false;
  let serverMuted = false;
  let serverDenied = false;
  let asking = false;
  let syncing = false;
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

  function identityBody() {
    return { clientId: clientId(), token: seatToken(), name: playerName() };
  }
  async function post(url, extra) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(identityBody(), extra || {}))
    });
    return res.json();
  }

  function renderShelf(inv, uses, preview) {
    const shelf = $('marketShelf');
    if (!shelf) return;
    const data = inv || { cowries: 0, kola: 0, yams: 0, cloth: 0 };
    if (window.KPGoods) {
      shelf.innerHTML = window.KPGoods.slots(data, { uses: uses || {}, preview: preview || null });
      shelf.querySelectorAll('[data-good]').forEach((b) => b.addEventListener('click', () => {
        const face = window.KPGoods.face[b.dataset.good];
        if (face) setLine(face.use);
      }));
      return;
    }
    shelf.innerHTML = GOODS.map(([key, label]) =>
      '<div class="market-good"><span class="n">' + (data[key] || 0) + '</span><span class="k">' + label + '</span></div>'
    ).join('');
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
  }
  function renderClaim(view) {
    const btn = $('claimBtn');
    if (!btn || !view) return;
    if (view.canClaim) {
      btn.disabled = false;
      btn.classList.remove('hidden');
      btn.classList.add('claim-live');
      btn.textContent = 'Claim';
      setLine('');
    } else {
      btn.classList.remove('claim-live');
      btn.classList.add('hidden');
      btn.disabled = true;
      setLine('');
    }
    renderShelf(view.inventory, view.uses, view.canClaim ? view.nextDrop : null);
    paintShelfBtn(view);
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
  function whispersOn() {
    return browserCanPush() && notificationPermission() === 'granted' && subscribed && !serverMuted && !localMuted() && !pushDenied();
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
      if (!pushEnabled) { cap.textContent = 'Off'; state = 'off'; }
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
      if (body) body.textContent = 'Whispers are not turned on for this server yet. Your shelf still keeps the goods.';
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
      const res = await fetch('/api/retention?clientId=' + encodeURIComponent(id));
      const view = await res.json();
      if (!view || !view.ok) return;
      pushEnabled = !!(view.push && view.push.enabled);
      publicKey = view.push ? view.push.publicKey : null;
      subscribed = !!(view.push && view.push.subscribed);
      serverMuted = !!(view.push && view.push.muted);
      serverDenied = !!(view.push && view.push.denied);
      renderClaim(view);
      if (localMuted() && subscribed && !serverMuted) {
        await post('/api/push/mute', { muted: true });
        serverMuted = true;
      }
      renderSwitch();
      refreshed = true;
      if (winPending) maybeAsk('win');
      else if (claimPending) maybeAsk('claim');
    } catch (e) { /* the shelf can wait for the next open */ }
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
      setLine('Whispers are not turned on for this server yet. Your shelf still keeps the goods.');
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
      renderClaim(out);
      const landed = $('marketLanded');
      if (landed) {
        if (out.granted) {
          const g = out.granted;
          landed.textContent = '+' + g.cowries + ' cowries  +' + g.kola + ' kola  +' + g.yams + ' yam  +' + g.cloth + ' cloth';
        } else landed.textContent = '';
      }
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
    if (!welcome.classList.contains('hidden')) {
      const anchor = $('welcomePlay') || $('welcomeQuick') || $('welcomeCreate');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(market, anchor);
      else welcome.appendChild(market);
    } else {
      join.appendChild(market);
    }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
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
  const box = $('optWhisper');
  if (box) box.addEventListener('change', () => {
    if (syncing) return;
    if (box.checked) enableWhispers().then((ok) => { if (!ok) renderSwitch(); });
    else muteWhispers(true);
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

  window.KPRetention = {
    onWin(won) {
      if (!won) return;
      winPending = true;
      if (refreshed) maybeAsk('win');
    },
    placeMarket,
    muteFromSound() { muteWhispers(true); },
    refresh
  };
})();
