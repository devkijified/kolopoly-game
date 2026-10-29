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
  function setLine(text) { const el = $('marketLine'); if (el && text) el.textContent = text; }

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

  function renderShelf(inv) {
    const shelf = $('marketShelf');
    if (!shelf) return;
    const data = inv || { cowries: 0, kola: 0, yams: 0, cloth: 0 };
    shelf.innerHTML = GOODS.map(([key, label]) =>
      '<div class="market-good"><span class="n">' + (data[key] || 0) + '</span><span class="k">' + label + '</span></div>'
    ).join('');
  }
  function renderClaim(view) {
    const btn = $('claimBtn');
    if (!btn || !view) return;
    if (view.canClaim) {
      btn.disabled = false;
      btn.textContent = "Claim today's drop";
      if (view.warmReady) setLine("Yesterday's visit is still warm. Today's drop carries a little extra.");
      else setLine('Once each Lagos day: cowries, kola, yam and cloth for your shelf.');
    } else {
      btn.disabled = true;
      btn.textContent = 'Collected today';
      setLine('You don collect today market drop. The next one opens with Lagos dawn.');
    }
    renderShelf(view.inventory);
  }
  function renderSwitch() {
    const box = $('optWhisper');
    const cap = $('whisperCap');
    if (!box) return;
    syncing = true;
    const denied = serverDenied || (typeof Notification !== 'undefined' && Notification.permission === 'denied');
    box.checked = !denied && !localMuted() && subscribed && !serverMuted;
    box.disabled = !clientId() || !pushEnabled;
    if (cap) {
      if (!pushEnabled) cap.textContent = 'Whispers need the server keys. The shelf still works.';
      else if (denied) cap.textContent = 'Whispers stay off. This phone already refused them.';
      else if (localMuted() || serverMuted) cap.textContent = 'Whispers are muted. This switch turns them back on.';
      else if (subscribed) cap.textContent = 'On. The table can speak when the pot swells, your seat is held, or the drop is ready.';
      else cap.textContent = 'Off until you ask. Mute here any time. Sound off mutes them too.';
    }
    syncing = false;
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
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
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
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setLine('This phone cannot take whispers. The shelf still works.');
      renderSwitch();
      return false;
    }
    let perm = Notification.permission;
    if (perm !== 'granted') perm = await Notification.requestPermission();
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
    const denied = serverDenied || (typeof Notification !== 'undefined' && Notification.permission === 'denied');
    const whispersOn = subscribed && !serverMuted && !localMuted();
    const canWhisper = pushEnabled && !denied && !whispersOn && !localMuted();
    if (!canInstall && !canWhisper) return;
    const sheet = $('retentionSheet');
    if (!sheet) return;
    asking = true;
    const title = $('retentionTitle');
    const body = $('retentionBody');
    const iosLine = $('retentionIos');
    const installBtn = $('retentionInstall');
    const whisperBtn = $('retentionWhisper');
    if (title) title.textContent = reason === 'win' ? 'The table remembers a landlord' : 'The market knows your shelf';
    if (body) body.textContent = 'Add Kolopoly to your home screen so the table stays one tap away. Whispers fit tell you when the Owambe pot swells, when your seat dey held, or when the next drop is ready.';
    if (iosLine) {
      iosLine.textContent = ios() && !standalone()
        ? 'On iPhone, tap Share, then Add to Home Screen. Whispers only arrive from that icon.'
        : '';
    }
    if (installBtn) installBtn.classList.toggle('hidden', !canInstall || (ios() && !deferredInstall));
    if (whisperBtn) whisperBtn.classList.toggle('hidden', !canWhisper);
    if (denied && body) body.textContent = 'Add Kolopoly to your home screen so the table stays one tap away. Whispers stay off. This phone already refused them.';
    sheet.classList.remove('hidden');
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
      setLine(out.line);
      renderClaim(out);
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
      const anchor = $('welcomeCreate');
      if (anchor) welcome.insertBefore(market, anchor);
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
  const box = $('optWhisper');
  if (box) box.addEventListener('change', () => {
    if (syncing) return;
    if (box.checked) enableWhispers().then((ok) => { if (!ok) renderSwitch(); });
    else muteWhispers(true);
  });
  const later = $('retentionLater');
  if (later) later.addEventListener('click', () => {
    try { localStorage.setItem('kolopolyRetentionLater', String(Date.now() + SNOOZE_MS)); } catch (e) { /* still close */ }
    hideSheet();
  });
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
  if (whisperBtn) whisperBtn.addEventListener('click', () => {
    enableWhispers().then((ok) => { if (ok) whisperBtn.classList.add('hidden'); });
  });

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
    muteFromSound() { muteWhispers(true); }
  };
})();
