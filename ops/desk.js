'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const boot = $('booting');
  const gate = $('gate');
  const desk = $('desk');
  const form = $('gate-form');
  const input = $('house-key');
  const gateError = $('gate-error');
  const unlockBtn = $('unlock-btn');
  const alertBox = $('alert');
  const roomsEl = $('rooms');
  let view = 'boot';
  let timer = 0;
  let polling = false;
  const INF = ['Settling', 'Inflation', 'Sapa', 'Sudden Death'];
  const PHASE = {
    roll: 'Rolling',
    buy: 'Deed offer',
    auction: 'Auction',
    jail: 'Kirikiri',
    tax: 'Levy',
    end: 'Between turns',
    lobby: 'Lobby',
    ended: 'Closed'
  };

  function show(next) {
    view = next;
    boot.hidden = next !== 'boot';
    gate.hidden = next !== 'gate';
    desk.hidden = next !== 'desk';
    if (next !== 'desk') stopPoll();
    if (next === 'gate' && window.matchMedia('(min-width: 800px)').matches) input.focus();
  }
  function setGateError(text) {
    gateError.textContent = text || '';
  }
  function stopPoll() {
    if (timer) clearTimeout(timer);
    timer = 0;
  }
  function schedule() {
    stopPoll();
    timer = setTimeout(pull, document.hidden ? 15000 : 5000);
  }
  function num(n) {
    return new Intl.NumberFormat('en-NG').format(Math.max(0, Number(n) || 0));
  }
  function ageOf(sec) {
    sec = Math.max(0, Number(sec) || 0);
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h ' + (m % 60) + 'm';
    return Math.floor(h / 24) + 'd';
  }
  function bytesOf(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function text(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }
  function tone(id, kind) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('warn', 'bad');
    if (kind) el.classList.add(kind);
  }

  function personLabel(p) {
    const name = p.name || 'Seat';
  if (p.afk) return name + ' · bot holding';
  if (p.bot) return name;
  if (!p.here) return name + ' · away';
    return name;
  }
  function rulesLabel(room) {
    const bits = [];
    bits.push(room.rules === 'inflation' ? 'Inflation' : 'Classic');
    if (room.rules === 'inflation' && room.preset) {
      const preset = { quick: 'Quick Bite', standard: 'Standard', fullnight: 'Full Night' }[room.preset] || room.preset;
      bits.push(preset);
    }
    if (room.infPhase) bits.push(INF[room.infPhase - 1] || ('Phase ' + room.infPhase));
    bits.push(room.mode === 'pass' ? 'Pass-and-play' : (room.isPublic ? 'Quick table' : 'Private'));
    if (room.paused) bits.push('held');
    return bits.join(' · ');
  }
  function seatLabel(room) {
    const bits = [];
    const away = Math.max(0, (room.humans || 0) - (room.humansHere || 0));
    bits.push((room.humansHere || 0) + ((room.humansHere === 1) ? ' here' : ' here'));
    if (away) bits.push(away + ' away');
    if (room.bots) bits.push(room.bots + (room.bots === 1 ? ' bot' : ' bots'));
    if (room.watching) bits.push(room.watching + ' watching');
    const names = (room.names || []).map(personLabel).join(' · ');
    return names ? names : bits.join(' · ');
  }

  function renderRooms(data) {
    roomsEl.replaceChildren();
    const rooms = data.rooms || [];
    if (!rooms.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const title = document.createElement('strong');
      title.textContent = 'No table dey open.';
      const line = document.createElement('p');
      line.className = 'fine';
      line.textContent = 'The board is quiet. When a room opens, the code and the seats land here.';
      empty.append(title, line);
      roomsEl.append(empty);
      return;
    }
    const head = document.createElement('div');
    head.className = 'room-head';
    for (const label of ['Code', 'Table', 'State', 'Seats', 'Age']) {
      const span = document.createElement('span');
      span.textContent = label;
      head.append(span);
    }
    roomsEl.append(head);
    for (const room of rooms) {
      const row = document.createElement('div');
      row.className = 'room';
      const code = document.createElement('div');
      code.className = 'room-code';
      code.textContent = room.code || '----';
      const mode = document.createElement('p');
      mode.className = 'mode-line';
      mode.textContent = rulesLabel(room);
      const pill = document.createElement('span');
      const status = room.status || 'lobby';
      pill.className = 'pill ' + (status === 'playing' ? 'play' : status === 'ended' ? 'end' : 'lobby');
      const phase = PHASE[room.phase] || room.phase || 'Lobby';
      pill.textContent = status === 'playing' ? phase : (status === 'ended' ? 'Closed' : 'Lobby');
      const seats = document.createElement('p');
      seats.className = 'seat-line';
      seats.textContent = seatLabel(room);
      const age = document.createElement('p');
      age.className = 'age';
      age.textContent = ageOf(room.ageSec);
      row.append(code, mode, pill, seats, age);
      roomsEl.append(row);
    }
    if (data.roomsTruncated) {
      const more = document.createElement('p');
      more.className = 'fine';
      more.textContent = 'Showing the first 40 tables.';
      roomsEl.append(more);
    }
  }

  function render(data) {
    const live = data.live || {};
    const today = data.today || {};
    const rolling = data.rolling || {};
    const push = data.push || {};
    const file = data.retention || {};
    const by = live.byStatus || {};
    text('n-rooms', num(live.rooms));
    text('n-rooms-sub', (by.lobby || 0) + ' lobby · ' + (by.ended || 0) + ' closed');
    text('n-humans', num(live.humans));
    const away = Math.max(0, (live.humans || 0) - (live.humansHere || 0));
    text('n-humans-sub', (live.humansHere || 0) + ' here now' + (away ? ' · ' + away + ' away' : ''));
    text('n-bots', num(live.bots));
    text('n-playing', num(by.playing));
    text('n-board-sub', (by.lobby || 0) + ' in the lobby · ' + (by.ended || 0) + ' closed');
    text('n-started', num(today.tablesStarted));
    text('n-finished', num(today.tablesFinished));
    text('n-claims', num(today.claims));
    text('n-claims-sub', (today.claimedShelves || 0) + ' shelves collected');
    text('n-afk', num(today.afkTakeovers));
    text('roll-line', 'Across ' + (rolling.window || 'two Lagos days') + ': '
      + num(rolling.tablesStarted) + ' started · '
      + num(rolling.tablesFinished) + ' finished · '
      + num(rolling.claims) + ' claims · '
      + num(rolling.afkTakeovers) + ' AFK takeovers.');
    text('day-line', data.lagosDay ? ('Lagos day ' + data.lagosDay) : 'Lagos ledger');

    if (!push.enabled) {
      text('h-push', 'Off');
      tone('h-push', 'warn');
    } else if (push.source === 'test') {
      text('h-push', 'On for this test process');
      tone('h-push', 'warn');
    } else {
      text('h-push', 'On');
      tone('h-push', '');
    }
    const phones = Number(push.subscribers) || 0;
    const subBits = [num(phones) + (phones === 1 ? ' phone' : ' phones')];
    if (push.muted) subBits.push(push.muted + ' muted');
    if (push.denied) subBits.push(push.denied + ' declined');
    text('h-subs', subBits.join(' · '));
    if (file.present && file.writable) {
      text('h-file', (file.label || 'shelf') + ' · writable · ' + bytesOf(file.bytes));
      tone('h-file', '');
    } else if (file.writable) {
      text('h-file', 'Not on disk yet · folder can write');
      tone('h-file', 'warn');
    } else {
      text('h-file', 'Cannot write the shelf');
      tone('h-file', 'bad');
    }
    text('h-shelves', num(today.uniqueShelves));
    text('h-devices', num(live.devices));
    text('h-up', ageOf(data.uptimeSec));
    renderRooms(data);
  }

  function markPulse(kind, label) {
    const pulse = $('pulse');
    pulse.classList.remove('stale', 'down');
    if (kind) pulse.classList.add(kind);
    text('pulse-label', label);
  }

  async function pull() {
    if (view !== 'desk' || polling) return;
    polling = true;
    try {
      const res = await fetch('/ops/snapshot', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (res.status === 401 || res.status === 429) {
        show('gate');
        setGateError(res.status === 429
          ? 'Too many tries. The desk is quiet for a while.'
          : 'The desk locked itself. Enter the key again.');
        return;
      }
      if (!res.ok) throw new Error('status');
      const data = await res.json();
      render(data);
      alertBox.hidden = true;
      markPulse('', 'Ledger fresh');
    } catch (e) {
      alertBox.hidden = false;
      alertBox.textContent = 'The line to the server drop. These numbers are the last good read.';
      markPulse('down', 'Line drop');
    } finally {
      polling = false;
      if (view === 'desk') schedule();
    }
  }

  async function unlock(raw) {
    setGateError('');
    unlockBtn.disabled = true;
    try {
      const res = await fetch('/ops/unlock', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token: raw })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        show('desk');
        markPulse('', 'Opening');
        pull();
        return;
      }
      setGateError(data.message || 'That key no open this desk.');
    } catch (e) {
      setGateError('The line drop. Try the key again.');
    } finally {
      unlockBtn.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value;
    input.value = '';
    unlock(value);
  });
  $('lock-btn').addEventListener('click', async () => {
    stopPoll();
    try {
      await fetch('/ops/lock', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}'
      });
    } catch (e) { /* still drop the local view */ }
    show('gate');
    setGateError('');
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && view === 'desk') {
      stopPoll();
      pull();
    }
  });

  const preset = document.body.dataset.error || '';
  if (preset) setGateError(preset);

  fetch('/ops/snapshot', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
    .then(async (res) => {
      if (res.status === 200) {
        const data = await res.json();
        show('desk');
        render(data);
        markPulse('', 'Ledger fresh');
        schedule();
        return;
      }
      show('gate');
      if (!preset) {
        setGateError(res.status === 429 ? 'Too many tries. The desk is quiet for a while.' : '');
      }
    })
    .catch(() => {
      show('gate');
      setGateError(preset || 'The line drop. The desk did not answer.');
    });
})();
