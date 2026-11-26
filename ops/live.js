(function () {
  const root = document.getElementById('live-root');
  if (!root) return;
  const nav = document.querySelector('.live-nav');
  const dialog = document.getElementById('live-confirm');
  let part = 'overview';
  let pending = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function naira(n) {
    return '₦' + new Intl.NumberFormat('en-NG').format(Number(n) || 0);
  }
  async function get(query) {
    const res = await fetch('/ops/live?' + query, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    return res.json();
  }
  function ask(title, body, phrase) {
    return new Promise((resolve) => {
      pending = resolve;
      document.getElementById('live-confirm-title').textContent = title;
      document.getElementById('live-confirm-body').textContent = body;
      const label = document.getElementById('live-phrase-label');
      const input = document.getElementById('live-phrase');
      label.hidden = !phrase;
      input.value = '';
      if (dialog.showModal) dialog.showModal();
      else resolve(true);
    });
  }
  document.getElementById('live-cancel').addEventListener('click', () => { if (dialog.close) dialog.close(); if (pending) pending(false); pending = null; });
  document.getElementById('live-yes').addEventListener('click', () => {
    const phrase = document.getElementById('live-phrase').value;
    if (dialog.close) dialog.close();
    if (pending) pending(phrase || true);
    pending = null;
  });
  async function act(body, title, copy, phrase) {
    const answer = await ask(title, copy, phrase);
    if (!answer) return null;
    if (phrase && answer !== 'SEND PUSH') {
      root.insertAdjacentHTML('afterbegin', '<p class="live-card">Push was not sent. The confirmation phrase did not match.</p>');
      return null;
    }
    const res = await fetch('/ops/live/act', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(Object.assign({ confirm: true, confirmText: phrase ? answer : '' }, body))
    });
    const data = await res.json();
    await show(part);
    return data;
  }

  function health(h) {
    h = h || {};
    return '<div class="live-health"><span>Up ' + esc(h.uptimeSec) + 's</span><span>Build ' + esc(h.build || '—') + '</span><span>' + esc(h.memoryMb) + ' MB</span><span>' + esc(h.websockets) + ' sockets</span><span>' + esc(h.errorRate) + ' errors/min</span></div>';
  }
  function statGrid(items) {
    return '<div class="live-grid">' + items.map((item) => '<div class="live-stat"><span>' + esc(item[0]) + '</span><b>' + esc(item[1]) + '</b></div>').join('') + '</div>';
  }
  function chip(tag) {
    const label = { owner: 'Owner', qa: 'QA', learner: 'Learner', training: 'Training' }[tag] || tag;
    return '<span class="player-chip">' + esc(label) + '</span>';
  }
  function bars(series, key) {
    const max = Math.max.apply(null, series.map((row) => row[key] || 0).concat(1));
    return '<div class="live-bars">' + series.map((row) => {
      const n = row[key] || 0;
      const w = Math.round((n / max) * 100);
      return '<div class="live-bar"><span>' + esc(String(row.day || '').slice(5)) + '</span><i data-w="' + w + '"></i><b>' + esc(n) + '</b></div>';
    }).join('') + '</div>';
  }
  function paintBars() {
    root.querySelectorAll('.live-bar i').forEach((el) => { el.style.width = (el.getAttribute('data-w') || '0') + '%'; });
  }

  async function show(next) {
    part = next;
    nav.querySelectorAll('button').forEach((btn) => btn.classList.toggle('on', btn.getAttribute('data-live') === next));
    if (next === 'overview') {
      const data = await get('part=overview');
      const live = data.live || {};
      const s = data.stats || {};
      const days = data.days || [];
      root.innerHTML = '<article class="live-card"><h2>Live</h2>' + health(data.health) +
        statGrid([
          ['Real players', s.realPlayers || 0],
          ['Active today', s.activeToday || 0],
          ['Active 7d', s.active7d || 0],
          ['Started today', s.tablesStarted || 0],
          ['Finished today', s.tablesFinished || 0],
          ['AFK today', s.afk || 0],
          ['Claims today', s.claims || 0],
          ['Online now', live.playersOnline || 0]
        ]) + '</article>' +
        '<article class="live-card"><h3>Tables by day</h3>' + (days.length ? days.map((row) => '<div class="live-day"><b>' + esc(row.day) + '</b><span>Started ' + esc(row.started) + '</span><span>Finished ' + esc(row.finished) + '</span><span>AFK ' + esc(row.afk) + '</span><span>Claims ' + esc(row.claims) + '</span></div>').join('') : '<p>none yet</p>') + '</article>' +
        ((data.rooms || []).length ? (data.rooms || []).map((room) => '<article class="live-card"><button type="button" data-room="' + esc(room.code) + '">' + esc(room.code) + '</button><p>' + esc(room.status) + ' · ' + esc(room.phase) + ' · ' + esc(room.mode) + '</p></article>').join('') : '<article class="live-card"><h3>Live rooms</h3><p>none yet</p></article>');
    } else if (next === 'rooms') {
      const data = await get('part=rooms');
      const s = data.stats || {};
      root.innerHTML = '<article class="live-card"><h2>Rooms</h2>' + statGrid([['Live rooms', s.live || 0], ['In play', s.playing || 0], ['Humans', s.humans || 0]]) + '<input class="live-search" id="room-q" placeholder="Search code or name"></article>' +
        ((data.rooms || []).length ? (data.rooms || []).map((room) => '<article class="live-card"><div class="live-row"><b>' + esc(room.code) + '</b><button type="button" data-room="' + esc(room.code) + '">Open</button></div><p>' + esc(room.status) + ' · ' + esc(room.phase) + ' · ' + esc(room.humans) + ' human</p></article>').join('') : '<article class="live-card"><p>none yet</p></article>');
      const q = document.getElementById('room-q');
      q.addEventListener('input', async () => {
        const found = await get('part=rooms&q=' + encodeURIComponent(q.value));
        const cards = root.querySelectorAll('.live-card');
        cards.forEach((card, i) => { if (i) card.remove(); });
        root.insertAdjacentHTML('beforeend', (found.rooms || []).map((room) => '<article class="live-card"><div class="live-row"><b>' + esc(room.code) + '</b><button type="button" data-room="' + esc(room.code) + '">Open</button></div></article>').join(''));
      });
    } else if (next === 'players') {
      const data = await get('part=players');
      paintPlayers(data, '');
    } else if (next === 'economy') {
      await economy('7');
    } else if (next === 'payments') {
      const data = await get('part=payments');
      const totals = data.totals || {};
      const pays = data.payments || [];
      const payouts = data.payouts || [];
      root.innerHTML = '<article class="live-card"><h2>Payments</h2><p>Read only. No secret keys.</p>' +
        statGrid([
          ['Payments', totals.count || pays.length || 0],
          ['Paid', naira(totals.paid)],
          ['Failed', totals.failed || 0],
          ['Pending', totals.pending || 0],
          ['Payouts', totals.payouts || payouts.length || 0],
          ['Payouts open', totals.payoutPending || 0]
        ]) + '</article>' +
        (pays.length ? pays.map((pay) => '<article class="live-card"><b>' + esc(pay.status || 'none yet') + '</b> ' + naira(pay.amount) + '<p>' + esc(pay.user || 'No name') + (pay.room ? ' · ' + esc(pay.room) : '') + '</p><p>' + esc(String(pay.at || '').slice(0, 10)) + '</p></article>').join('') : '<article class="live-card"><h3>Payments</h3><p>none yet</p></article>') +
        (payouts.length ? '<article class="live-card"><h3>Payouts</h3>' + payouts.map((row) => '<p>' + esc(row.status || 'open') + ' · ' + naira(row.amount) + (row.room ? ' · ' + esc(row.room) : '') + '</p>').join('') + '</article>' : '');
    } else if (next === 'moderation') {
      const data = await get('part=moderation');
      const s = data.stats || {};
      const reports = data.reports || [];
      const flagged = data.flagged || [];
      root.innerHTML = '<article class="live-card"><h2>Moderation</h2>' + statGrid([['Reports', s.reports || 0], ['Open', s.open || 0], ['Flagged', s.flagged || 0]]) + '</article>' +
        (reports.length ? reports.map((rep) => '<article class="live-card"><p class="chip-bad">' + esc(rep.kind) + ' · ' + esc(rep.status) + '</p><p>' + esc(rep.text) + '</p><p>' + esc(rep.from) + ' about ' + esc(rep.about) + '</p><button type="button" data-player="' + esc(rep.aboutId) + '">Open player</button></article>').join('') : '<article class="live-card"><p>none yet</p></article>') +
        flagged.map((p) => '<article class="live-card"><b>' + esc(p.name) + '</b><p>' + (p.banned ? 'Banned' : '') + ' ' + (p.muted ? 'Muted' : '') + ' · reports ' + esc(p.reports) + '</p></article>').join('');
    } else if (next === 'events') {
      const data = await get('part=events');
      const ev = data.event || {};
      const s = data.stats || {};
      root.innerHTML = '<article class="live-card"><h2>Weekly event</h2>' + statGrid([['Live events', s.live || 0], ['Scheduled', s.scheduled || 0]]) + '<p><b>' + esc(ev.name || 'none yet') + '</b> · ' + esc(ev.status || 'off') + '</p><p>' + esc(ev.starts || 'none yet') + ' → ' + esc(ev.ends || 'none yet') + '</p><div class="live-actions"><button type="button" data-act="event_stop">Stop</button><button type="button" data-act="event_start">Start</button></div></article>' +
        '<article class="live-card"><h3>Schedule</h3><input id="ev-name" placeholder="Event name"><button type="button" id="ev-save">Schedule</button></article>';
      root.querySelector('[data-act="event_stop"]').addEventListener('click', () => act({ action: 'event_stop' }, 'Stop the event', 'Players will leave this event.'));
      root.querySelector('[data-act="event_start"]').addEventListener('click', () => act({ action: 'event_start', name: ev.name }, 'Start the event', 'This event goes live.'));
      document.getElementById('ev-save').addEventListener('click', () => act({ action: 'event_schedule', name: document.getElementById('ev-name').value || 'House week' }, 'Schedule an event', 'Add it to the schedule.'));
    } else if (next === 'broadcast') {
      const data = await get('part=overview');
      const subs = (data.stats && data.stats.pushOn) || 0;
      root.innerHTML = '<article class="live-card"><h2>Broadcast</h2>' + statGrid([['Push on', subs], ['Sent from here', 0]]) + '<textarea id="bc-text" rows="3" maxlength="180" placeholder="In-game announcement"></textarea><div class="live-actions"><button type="button" id="bc-send">Send in game</button><button type="button" id="bc-push">Push to everyone</button></div></article>';
      document.getElementById('bc-send').addEventListener('click', () => act({ action: 'broadcast', text: document.getElementById('bc-text').value }, 'Send the announcement', 'Everyone online will see this banner.'));
      document.getElementById('bc-push').addEventListener('click', () => act({ action: 'broadcast_push', text: document.getElementById('bc-text').value }, 'Push to everyone', 'This would notify every device. Type the phrase to continue.', true));
    } else if (next === 'audit') {
      const data = await get('part=audit');
      const rows = data.audit || [];
      const s = data.stats || {};
      root.innerHTML = '<article class="live-card"><h2>Audit</h2>' + statGrid([['Actions', s.actions != null ? s.actions : rows.length]]) + (rows.length ? rows.map((row) => '<div class="live-row"><span>' + esc(String(row.at).slice(0, 16).replace('T', ' ')) + ' · ' + esc(row.who) + '</span><b>' + esc(row.action) + '</b></div><p>' + esc(row.target) + ' ' + esc(row.detail) + '</p>').join('') : '<p>none yet</p>') + '</article>';
    }
  }

  function paintPlayers(data, query) {
    const stats = data.stats || {};
    const hide = !root.querySelector('#hide-test') || root.querySelector('#hide-test').checked;
    root.innerHTML = '<article class="live-card"><h2>Players</h2><p class="real-count">Real players: ' + esc(stats.real || 0) + '</p>' +
      statGrid([['Real players', stats.real || 0], ['On the shelf', stats.total || 0]]) +
      '<label class="live-toggle"><input type="checkbox" id="hide-test"' + (hide ? ' checked' : '') + '> Hide QA, training, and owner</label>' +
      '<input class="live-search" id="player-q" placeholder="Search by name" value="' + esc(query) + '"></article>' +
      playerList(data.players, hide);
    document.getElementById('hide-test').addEventListener('change', () => paintPlayers(data, document.getElementById('player-q').value));
    document.getElementById('player-q').addEventListener('input', async (ev) => {
      const found = await get('part=players&q=' + encodeURIComponent(ev.target.value));
      const box = document.getElementById('hide-test');
      root.querySelectorAll('.live-player, .live-player-card').forEach((el) => el.remove());
      root.insertAdjacentHTML('beforeend', playerList(found.players, box && box.checked));
    });
  }

  function playerList(rows, hide) {
    return (rows || []).filter((p) => !hide || p.real !== false).map((p) => {
      if (p.shelf) return playerCard(p);
      return '<div class="live-player"><div><b>' + esc(p.name) + '</b><p>' + esc(p.email) + '</p></div><button type="button" data-player="' + esc(p.id) + '">Open</button></div>';
    }).join('') || '<article class="live-card live-player-card"><p>none yet</p></article>';
  }
  function playerCard(p) {
    const name = String(p.name || '').trim() || 'No name';
    const tags = (p.tags || []).map(chip).join('');
    const tables = (p.tablesPlayed || p.tablesWon) ? ('Tables played ' + esc(p.tablesPlayed || 0) + ' · won ' + esc(p.tablesWon || 0)) : 'Tables none yet';
    const credit = p.creditKobo ? '<p>Credit ' + naira(Math.round(p.creditKobo / 100)) + '</p>' : '';
    return '<article class="live-card live-player-card" data-real="' + (p.real ? '1' : '0') + '"><div class="live-player-head"><b>' + esc(name) + '</b><span class="player-chips">' + tags + '</span></div><p>Days played ' + esc(p.daysPlayed || 0) + ' · last ' + esc(p.lastPlayed || 'none yet') + '</p><p>' + tables + '</p><p>Claims ' + esc(p.claims || 0) + ' · Push ' + (p.pushOn ? 'on' : 'off') + '</p>' + credit + '<button type="button" data-player="' + esc(p.id) + '">Open</button></article>';
  }
  async function economy(days) {
    const data = await get('part=economy&days=' + days);
    const h = data.headlines || {};
    const shown = (v) => (v == null || v === '' ? 'none yet' : v);
    const series = data.series || [];
    root.innerHTML = '<article class="live-card"><h2>Economy</h2><div class="live-actions"><button type="button" data-days="7">7 days</button><button type="button" data-days="30">30 days</button></div>' +
      statGrid([
        ['Active today', shown(h.dau)],
        ['Active 7d', shown(h.wau)],
        ['Started', shown(h.started)],
        ['Finished', shown(h.finished)],
        ['Claims', shown(h.claims)],
        ['AFK', shown(h.afk)]
      ]) + '</article>' +
      '<article class="live-card"><h3>Games started</h3>' + (series.length ? bars(data.series, 'started') : '<p>none yet</p>') + '</article>';
    paintBars();
    root.querySelectorAll('[data-days]').forEach((btn) => btn.addEventListener('click', () => economy(btn.getAttribute('data-days'))));
  }
  async function room(code) {
    const data = await get('part=room&code=' + encodeURIComponent(code));
    if (!data.room) { root.innerHTML = '<article class="live-card">No such room.</article>'; return; }
    const r = data.room;
    root.innerHTML = '<article class="live-card"><h2>' + esc(r.code) + '</h2><p>' + esc(r.mode) + ' · ' + esc(r.status) + ' · ' + esc(r.phase) + '</p><div class="live-actions"><button type="button" id="end-room">End</button><button type="button" id="close-room">Close</button></div></article>' +
      r.players.map((p) => '<article class="live-card"><b>' + esc(p.name) + '</b><p>' + esc(p.token) + ' · ' + naira(p.cash) + (p.afk ? ' · AFK' : '') + '</p><p>' + esc((p.properties || []).join(', ')) + '</p><div class="live-actions"><button type="button" data-kick="' + esc(p.id) + '">Kick</button><button type="button" data-nudge="' + esc(p.id) + '">Nudge</button><button type="button" data-bot="' + esc(p.id) + '">Replace with bot</button></div></article>').join('') +
      '<article class="live-card"><h3>Turn log</h3>' + (r.feed || []).map((line) => '<p>' + esc(line.text) + '</p>').join('') + '</article>';
    document.getElementById('end-room').addEventListener('click', () => act({ action: 'end', code: r.code }, 'End the room', 'The table stops. Seats stay on the record.'));
    document.getElementById('close-room').addEventListener('click', () => act({ action: 'close', code: r.code }, 'Close the room', 'The table is removed.'));
    root.querySelectorAll('[data-kick]').forEach((btn) => btn.addEventListener('click', () => act({ action: 'kick', code: r.code, playerId: Number(btn.getAttribute('data-kick')) }, 'Kick this player', 'They leave the table.')));
    root.querySelectorAll('[data-nudge]').forEach((btn) => btn.addEventListener('click', () => act({ action: 'nudge', code: r.code, playerId: Number(btn.getAttribute('data-nudge')) }, 'Nudge this player', 'Their idle clock resets and the table is told.')));
    root.querySelectorAll('[data-bot]').forEach((btn) => btn.addEventListener('click', () => act({ action: 'replace', code: r.code, playerId: Number(btn.getAttribute('data-bot')) }, 'Replace with a bot', 'A bot takes the seat.')));
  }
  async function player(id) {
    const data = await get('part=player&id=' + encodeURIComponent(id));
    if (!data.player) { root.innerHTML = '<article class="live-card">No such player.</article>'; return; }
    const p = data.player;
    if (p.shelf) {
      root.innerHTML = playerCard(p);
      return;
    }
    root.innerHTML = '<article class="live-card"><h2>' + esc(p.name) + '</h2><p>' + esc(p.email) + ' · ' + esc(p.phone) + '</p><p>Played ' + esc(p.games) + ' · won ' + esc(p.wins) + '</p><p>Last seen ' + esc(String(p.lastSeen).slice(0, 16)) + '</p><p>' + (p.banned ? '<span class="chip-bad">Banned</span>' : '<span class="chip-ok">Clear</span>') + ' ' + (p.muted ? 'Muted' : '') + '</p><div class="live-actions"><button type="button" id="ban">' + (p.banned ? 'Unban' : 'Ban') + '</button><button type="button" id="mute">' + (p.muted ? 'Unmute' : 'Mute') + '</button></div></article>' +
      '<article class="live-card"><h3>Cosmetics</h3><p>' + esc(p.cosmetics.join(', ') || 'None') + '</p><h3>Stickers</h3><p>' + esc(p.stickers.join(', ') || 'None') + '</p><button type="button" id="grant">Grant Gold Big Man</button> <button type="button" id="revoke">Revoke it</button></article>' +
      '<article class="live-card"><h3>Spins</h3>' + p.spins.map((s) => '<p>' + esc(s.day) + ' · ' + esc(s.prize) + '</p>').join('') + '<h3>Rewards</h3>' + p.rewards.map((s) => '<p>' + esc(s.day) + ' · ' + esc(s.name) + '</p>').join('') + '</article>' +
      '<article class="live-card"><h3>Rivalries</h3>' + p.rivalries.map((s) => '<p>' + esc(s.name) + ' ' + esc(s.wins) + '-' + esc(s.losses) + '</p>').join('') + '<h3>Trades</h3>' + p.trades.map((s) => '<p>' + esc(s.day) + ' gave ' + esc(s.gave) + ' for ' + esc(s.got) + '</p>').join('') + '<h3>Reports</h3><p>' + esc(p.reports) + '</p></article>';
    document.getElementById('ban').addEventListener('click', () => act({ action: p.banned ? 'unban' : 'ban', playerId: p.id }, p.banned ? 'Unban' : 'Ban', p.name));
    document.getElementById('mute').addEventListener('click', () => act({ action: p.muted ? 'unmute' : 'mute', playerId: p.id }, p.muted ? 'Unmute' : 'Mute chat and emotes', p.name));
    document.getElementById('grant').addEventListener('click', () => act({ action: 'grant', playerId: p.id, kind: 'cosmetic', name: 'Gold Big Man' }, 'Grant cosmetic', 'Gold Big Man'));
    document.getElementById('revoke').addEventListener('click', () => act({ action: 'revoke', playerId: p.id, kind: 'cosmetic', name: 'Gold Big Man' }, 'Revoke cosmetic', 'Gold Big Man'));
  }

  root.addEventListener('click', (ev) => {
    const roomBtn = ev.target.closest('[data-room]');
    if (roomBtn) { room(roomBtn.getAttribute('data-room')); return; }
    const playerBtn = ev.target.closest('[data-player]');
    if (playerBtn) player(playerBtn.getAttribute('data-player'));
  });
  nav.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-live]');
    if (btn) show(btn.getAttribute('data-live'));
  });
  const desk = document.getElementById('desk');
  const watch = new MutationObserver(() => { if (desk && !desk.hidden && !root.dataset.ready) { root.dataset.ready = '1'; show('overview'); } });
  if (desk) watch.observe(desk, { attributes: true, attributeFilter: ['hidden'] });
})();
