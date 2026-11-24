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
  function paintShelf(rewards) {
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
    el.innerHTML = '<div class="album-card"><h2>Lagos sticker album</h2>' +
      sets.map((s) => '<p class="album-set"><b>' + s.name + '</b> ' + s.have + '/' + s.size + (s.done ? ' · complete' : '') + '</p>').join('') +
      '<div class="album-grid">' + stickers.map((s) =>
        '<button type="button" class="sticker' + (s.count ? '' : ' missing') + (s.gold ? ' gold' : '') + '" data-sticker="' + s.id + '" data-count="' + s.count + '">' +
        '<span class="st-name">' + s.name + '</span><span class="st-stars">' + stars(s.stars, s.gold) + '</span><span class="st-n">' + (s.count || 0) + '</span></button>'
      ).join('') + '</div>' +
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
  function reveal(stickers) {
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
      el.innerHTML = '<div class="pack-card"><p class="pack-kicker">BIG DADDY PACK</p><h2>Open am</h2><div class="pack-row">' +
        shown.map((s) => '<div class="sticker' + (s.gold ? ' gold' : '') + '"><span class="st-name">' + s.name + '</span><span class="st-stars">' + stars(s.stars, s.gold) + '</span></div>').join('') +
        '</div><button type="button" class="btn gold block" id="packNext">' + (i < stickers.length ? 'Next sticker' : 'Done') + '</button></div>';
      el.querySelector('#packNext').addEventListener('click', () => {
        if (i < stickers.length) { i += 1; draw(); }
        else el.remove();
      });
    };
    el.addEventListener('pointerdown', (ev) => {
      if (ev.target.id === 'packNext') return;
      i = stickers.length;
      draw();
    });
    i = 1;
    draw();
    if (window.KPBigDaddy) window.KPBigDaddy.show('drop', { force: true });
  }
  async function openPack() {
    const out = await post('/api/rewards/open', {});
    if (!out || !out.ok) return;
    paintShelf(out.rewards);
    reveal(out.stickers || []);
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
  window.KPRewards = { paintShelf, reveal, refresh, openPack };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(refresh, 400));
  else setTimeout(refresh, 400);
})();
