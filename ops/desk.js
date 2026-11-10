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
    if (next === 'desk') loadCompetition();
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
    compLoaded = false;
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

  // Paid competitions: the city ladder panel. The desk reads the saved
  // ladder (or the seeded one), edits it in place, recomputes the money
  // table as the admin types, and saves through the same house key.
  const COMP_SIZES = [2, 3, 4, 5, 6];
  let comp = null;
  let compLoaded = false;
  let compLoading = false;

  function naira(n) {
    return '₦' + num(n);
  }
  function compNote(text, kind) {
    const el = $('comp-note');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('ok', 'bad');
    if (kind) el.classList.add(kind);
  }
  function field(labelText, inputEl) {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = labelText;
    wrap.append(label, inputEl);
    return wrap;
  }
  function textInput(value) {
    const el = document.createElement('input');
    el.type = 'text';
    el.value = value == null ? '' : String(value);
    return el;
  }
  function numberInput(value) {
    const el = document.createElement('input');
    el.type = 'number';
    el.min = '0';
    el.step = '1';
    el.inputMode = 'numeric';
    el.value = value == null ? '' : String(value);
    return el;
  }

  function renderCompEditors() {
    const citiesEl = $('comp-cities');
    const splitsEl = $('comp-splits');
    if (!citiesEl || !splitsEl || !comp) return;
    citiesEl.replaceChildren();
    (comp.cities || []).forEach((row, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'comp-row';
      wrap.dataset.idx = String(i);
      const city = textInput(row.city);
      city.dataset.field = 'city';
      const venue = textInput(row.venue);
      venue.dataset.field = 'venue';
      const fee = numberInput(row.fee);
      fee.dataset.field = 'fee';
      const flagWrap = document.createElement('label');
      flagWrap.className = 'flagship';
      const flag = document.createElement('input');
      flag.type = 'checkbox';
      flag.dataset.field = 'flagship';
      flag.checked = !!row.flagship;
      flagWrap.append(flag, document.createTextNode('Flagship'));
      wrap.append(field('City', city), field('Venue', venue), field('Entry fee (₦)', fee), flagWrap);
      citiesEl.append(wrap);
    });
    splitsEl.replaceChildren();
    for (const size of COMP_SIZES) {
      const wrap = document.createElement('div');
      wrap.className = 'comp-split';
      const share = numberInput(comp.splits ? comp.splits[size] : '');
      share.dataset.size = String(size);
      wrap.append(field(size + ' players, winner %', share));
      splitsEl.append(wrap);
    }
  }

  function readCompForm() {
    const cities = [];
    document.querySelectorAll('#comp-cities .comp-row').forEach((wrap, i) => {
      const get = (name) => wrap.querySelector('[data-field="' + name + '"]');
      const feeRaw = get('fee').value;
      cities.push({
        id: comp && comp.cities && comp.cities[i] ? comp.cities[i].id : undefined,
        city: get('city').value,
        venue: get('venue').value,
        fee: feeRaw === '' ? NaN : Number(feeRaw),
        flagship: get('flagship').checked
      });
    });
    const splits = {};
    document.querySelectorAll('#comp-splits [data-size]').forEach((el) => {
      splits[el.dataset.size] = el.value === '' ? NaN : Number(el.value);
    });
    return { cities, splits };
  }

  function compFormProblem(form) {
    for (const row of form.cities) {
      if (!String(row.city || '').trim()) return 'Every city needs a name.';
      if (!String(row.venue || '').trim()) return row.city + ' needs a venue name.';
      if (!Number.isInteger(row.fee) || row.fee < 1) return 'The entry fee for ' + row.city + ' must be a whole number of naira, at least 1.';
    }
    let prev = Infinity;
    for (const size of COMP_SIZES) {
      const share = form.splits[size];
      if (!Number.isInteger(share) || share < 1 || share > 100) {
        return 'The winner share for ' + size + ' players must be a whole percent between 1 and 100.';
      }
      if (share > prev) return 'The winner share cannot grow as the table gets bigger.';
      prev = share;
    }
    if (form.cities.filter((row) => row.flagship).length > 1) return 'Only one table can be the flagship.';
    return '';
  }

  function renderCompTable(form) {
    const tableEl = $('comp-table');
    const noteEl = $('comp-table-note');
    if (!tableEl) return;
    tableEl.replaceChildren();
    const problem = compFormProblem(form);
    if (noteEl) noteEl.textContent = problem ? 'Fix the ladder to see the money table: ' + problem : '';
    if (problem) return;
    for (const row of form.cities) {
      const block = document.createElement('div');
      block.className = 'comp-city';
      const head = document.createElement('p');
      head.className = 'comp-city-head';
      head.textContent = row.city + ' · ' + row.venue + ' · entry ' + naira(row.fee) + ' ';
      if (row.flagship) {
        const flag = document.createElement('span');
        flag.className = 'flag';
        flag.textContent = 'Flagship';
        head.append(flag);
      }
      const sizes = document.createElement('div');
      sizes.className = 'comp-sizes';
      for (const players of COMP_SIZES) {
        const pot = row.fee * players;
        const winner = Math.round(pot * form.splits[players] / 100);
        const cell = document.createElement('div');
        cell.className = 'comp-cell';
        const title = document.createElement('b');
        title.textContent = players + ' players';
        const potLine = document.createElement('span');
        potLine.textContent = 'Pot ' + naira(pot);
        const winLine = document.createElement('span');
        winLine.className = 'win';
        winLine.textContent = 'Winner ' + naira(winner);
        const houseLine = document.createElement('span');
        houseLine.textContent = 'House ' + naira(pot - winner);
        cell.append(title, potLine, document.createElement('br'), winLine, document.createElement('br'), houseLine);
        sizes.append(cell);
      }
      block.append(head, sizes);
      tableEl.append(block);
    }
  }

  function compEdited() {
    compLoaded = true;
    renderCompTable(readCompForm());
    compNote('Unsaved changes. The money table above already follows your typing.', '');
  }

  async function loadCompetition() {
    if (compLoaded || compLoading) return;
    compLoading = true;
    try {
      const res = await fetch('/ops/competition', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) throw new Error('status');
      const data = await res.json();
      comp = data.settings;
      compLoaded = true;
      renderCompEditors();
      renderCompTable(readCompForm());
      compNote(data.saved
        ? 'This ladder is saved in the house settings.'
        : 'This is the seeded ladder. Save it to make it the house settings.', '');
    } catch (e) {
      compNote('The ladder no gree load. Lock the desk and open it again.', 'bad');
    } finally {
      compLoading = false;
    }
  }

  async function saveCompetition() {
    const btn = $('comp-save-btn');
    const form = readCompForm();
    const problem = compFormProblem(form);
    if (problem) {
      compNote(problem + ' Nothing was saved.', 'bad');
      return;
    }
    btn.disabled = true;
    try {
      const res = await fetch('/ops/competition', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        compNote(data.message || 'The save was refused. Nothing was saved.', 'bad');
        return;
      }
      comp = data.settings;
      renderCompEditors();
      renderCompTable(readCompForm());
      compNote('Saved. The ladder is now the house settings.', 'ok');
    } catch (e) {
      compNote('The line drop. The save did not land.', 'bad');
    } finally {
      btn.disabled = false;
    }
  }

  const compCitiesEl = $('comp-cities');
  const compSplitsEl = $('comp-splits');
  if (compCitiesEl) compCitiesEl.addEventListener('input', compEdited);
  if (compCitiesEl) compCitiesEl.addEventListener('change', compEdited);
  if (compSplitsEl) compSplitsEl.addEventListener('input', compEdited);
  const compSaveBtn = $('comp-save-btn');
  if (compSaveBtn) compSaveBtn.addEventListener('click', saveCompetition);

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
