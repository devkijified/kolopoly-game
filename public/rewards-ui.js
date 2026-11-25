'use strict';
// Packs, the Lagos sticker album, power cards, and looks. No real-money shop.
(function () {
  function $(id) { return document.getElementById(id); }
  function auth() {
    try { return localStorage.getItem('kolopolyAuthToken') || ''; } catch (e) { return ''; }
  }
  function clientId() {
    try { return localStorage.getItem('kolopolyClientId') || ''; } catch (e) { return ''; }
  }
  function post(url, body) {
    const extra = { clientId: clientId() };
    const t = auth();
    if (t) extra.authToken = t;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(extra, body || {}))
    }).then((r) => r.json());
  }
  function stars(n, gold) {
    let s = '';
    for (let i = 0; i < n; i++) s += '★';
    return gold ? s + ' GOLD' : s;
  }
  const STICKER_FILE = {
    'lekki-toll': 'lekki-toll-gate',
    carter: 'carter-bridge',
    'third-mainland': 'third-mainland-bridge',
    balogun: 'balogun-market',
    suya: 'suya-spot',
    'computer-village': 'computer-village',
    tbs: 'tafawa-balewa-square',
    'national-theatre': 'national-theatre',
    'eko-atlantic': 'eko-atlantic',
    danfo: 'danfo',
    molue: 'molue',
    okada: 'okada',
    kirikiri: 'kirikiri',
    'owambe-hall': 'owambe-hall',
    'marina-lights': 'marina-lights',
    'event-owambe': 'event-owambe',
    'event-nepa': 'event-nepa',
    'event-toll': 'event-toll',
    'event-marina': 'event-marina'
  };
  function art(id) {
    const file = STICKER_FILE[id] || id;
    return '<span class="st-art"><img alt="" width="512" height="512" decoding="async" loading="lazy" src="/stickers/' + file + '.webp?v=__KOLOPOLY_BUILD__"></span>';
  }
  let lastRewards = null;
  function paintShelf(rewards) {
    lastRewards = rewards;
    const shelf = $('marketShelf');
    if (!shelf || !rewards) return;
    window.KPRewards.current = rewards;
    const cards = rewards.cards || {};
    shelf.innerHTML =
      '<div class="reward-row">' +
      '<button type="button" class="btn gold" id="openPackBtn">Open pack (' + (rewards.packs || 0) + ')</button>' +
      '<button type="button" class="btn ghost" id="albumBtn">Album</button>' +
      '</div>' +
      '<div class="reward-cards">' +
      ['bail', 'shield', 'double', 'dash'].map((id) => {
        const name = { bail: 'Bail', shield: 'Area Boys', double: 'Double Alert', dash: 'Danfo dash' }[id];
        return '<span class="reward-card">' + name + ' <b>' + (cards[id] || 0) + '</b></span>';
      }).join('') +
      '</div>';
    const open = $('openPackBtn');
    if (open) open.addEventListener('click', () => openPack());
    const album = $('albumBtn');
    if (album) album.addEventListener('click', () => showAlbum(rewards));
  }
  function showAlbum(rewards) {
    let el = $('albumSheet');
    if (!el) {
      el = document.createElement('div');
      el.id = 'albumSheet';
      el.className = 'album-sheet';
      document.body.appendChild(el);
    }
    const sets = rewards.sets || [];
    const stickers = rewards.stickers || [];
    const tile = (s) =>
      '<button type="button" class="sticker' + (s.count ? '' : ' missing') + (s.gold ? ' gold' : '') + '" data-sticker="' + s.id + '" data-count="' + s.count + '">' +
      art(s.id) + (s.count ? '<span class="st-badge">' + s.count + '</span>' : '<span class="st-q">?</span>') +
      '<span class="st-name">' + s.name + '</span><span class="st-stars">' + stars(s.stars, s.gold) + '</span></button>';
    const book = stickers.filter((s) => s.set !== 'limited');
    const limited = stickers.filter((s) => s.set === 'limited');
    el.innerHTML = '<div class="album-card"><h2>Sticker album</h2>' +
      sets.map((s) => '<p class="album-set"><b>' + s.name + '</b> ' + s.have + '/' + s.size + (s.done ? ' · complete' : '') +
        (s.reward ? ' · reward: ' + s.reward : '') + '</p>').join('') +
      '<div class="album-grid">' + book.map(tile).join('') + '</div>' +
      '<h3 class="album-k">Limited</h3>' +
      '<div class="album-grid album-limited">' + limited.map(tile).join('') + '</div>' +
      '<p class="album-note">A duplicate can go to a friend. Tap one you hold twice.</p>' +
      '<button type="button" class="btn ghost block" id="albumClose">Close</button></div>';
    el.querySelector('#albumClose').addEventListener('click', () => { el.remove(); });
    el.querySelectorAll('.sticker').forEach((b) => b.addEventListener('click', async () => {
      if (Number(b.dataset.count) < 2) return;
      const to = window.prompt('Friend client id for this duplicate');
      if (!to) return;
      const out = await post('/api/rewards/gift', { sticker: b.dataset.sticker, to: to.trim() });
      const note = el.querySelector('.album-note');
      if (note) note.textContent = out && out.ok ? 'Duplicate don go.' : ((out && out.message) || 'That gift no send.');
    }));
  }
  function reveal(stickers, completed) {
    let el = $('packReveal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'packReveal';
      el.className = 'pack-reveal';
      document.body.appendChild(el);
    }
    let i = 0;
    const draw = () => {
      const shown = stickers.slice(0, i);
      const done = (i >= stickers.length && completed && completed.length)
        ? '<div class="set-reveal"><p class="pack-kicker">SET COMPLETE</p><h2>' + completed.map((c) => c.name).join(', ') + '</h2>' +
          '<p class="album-set">' + completed.map((c) => c.cosmeticName || c.name).join(' · ') + ' don land.</p>' +
          '<div class="pack-row">' +
          ((lastRewards && lastRewards.stickers) || []).filter((s) => completed.some((c) => c.set === s.set)).map((s) =>
            '<div class="sticker">' + art(s.id) + '<span class="st-name">' + s.name + '</span></div>').join('') + '</div></div>'
        : '';
      el.innerHTML = '<div class="pack-card"><p class="pack-kicker">BIG DADDY PACK</p><h2>Open am</h2><div class="pack-row">' +
        shown.map((s) => '<div class="sticker pack-flip' + (s.gold ? ' gold' : '') + '">' + art(s.id) + '<span class="st-name">' + s.name + '</span><span class="st-stars">' + stars(s.stars, s.gold) + '</span></div>').join('') +
        '</div>' + done +
        '<button type="button" class="btn gold block" id="packNext">' + (i < stickers.length ? 'Next sticker' : 'Done') + '</button></div>';
      el.querySelector('#packNext').addEventListener('click', () => {
        if (i < stickers.length) { i += 1; draw(); }
        else el.remove();
      });
    };
    const skip = (ev) => {
      if (ev.target && ev.target.id === 'packNext') return;
      if (i < stickers.length) { i = stickers.length; draw(); }
    };
    el.onclick = skip;
    i = 1;
    draw();
    if (completed && completed.length && window.KPBigDaddy) {
      const prize = completed.map((c) => c.cosmeticName || c.name).join(', ');
      window.KPBigDaddy.show('drop', { force: true, line: 'Set complete! ' + prize + ' don land.' });
    }
  }
  async function openPack() {
    const out = await post('/api/rewards/open', {});
    if (!out || !out.ok) return;
    paintShelf(out.rewards);
    reveal(out.stickers || [], out.completed || []);
  }
  async function refresh() {
    const id = clientId();
    if (!id) return;
    try {
      const res = await fetch('/api/retention?clientId=' + encodeURIComponent(id) + (auth() ? '&authToken=' + encodeURIComponent(auth()) : ''));
      const view = await res.json();
      if (view && view.rewards) paintShelf(view.rewards);
    } catch (e) { /* the shelf can wait */ }
  }
  async function openAlbum() {
    if (!lastRewards) {
      const id = clientId();
      if (!id) return;
      try {
        const res = await fetch('/api/retention?clientId=' + encodeURIComponent(id) + (auth() ? '&authToken=' + encodeURIComponent(auth()) : ''));
        const view = await res.json();
        if (view && view.rewards) lastRewards = view.rewards;
      } catch (e) { return; }
    }
    if (lastRewards) showAlbum(lastRewards);
  }
  window.KPRewards = { paintShelf, reveal, refresh, openPack, openAlbum };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(refresh, 400));
  else setTimeout(refresh, 400);
})();
