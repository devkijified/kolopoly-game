'use strict';
// Big Daddy, Kolopoly's own landlord. He springs in for a highlight and
// leaves. He never takes a tap, so a turn, a dice roll, a timer and a
// paid-table countdown all keep working under him. One pop per 20 seconds.
(function () {
  const GAP_MS = 20000;
  const KEY = 'kolopolyBigDaddy';
  const BUILD = (document.querySelector('meta[name="kolopoly-build"]') || {}).content || '';
  const POSES = {
    money: '/mascot/daddy-money.webp',
    deed: '/mascot/daddy-deed.webp',
    jail: '/mascot/daddy-jail.webp',
    clap: '/mascot/daddy-clap.webp',
    stand: '/mascot/daddy-stand.webp'
  };
  // Phase 1 stays the emerald agbada. Later phases shift the cloth.
  const TINT = {
    1: 'none',
    2: 'hue-rotate(18deg) saturate(1.2)',
    3: 'hue-rotate(42deg) saturate(1.15)',
    4: 'hue-rotate(-12deg) saturate(0.85)',
    5: 'hue-rotate(68deg) saturate(1.1)',
    6: 'hue-rotate(-28deg) contrast(1.05)',
    7: 'sepia(0.35) saturate(1.3)'
  };
  const LINES = {
    rent: { pose: 'money', edge: 'left', ms: 1800, line: 'Oya collect am! This one na your money!' },
    pot: { pose: 'clap', edge: 'right', ms: 2000, line: 'Na your party! The pot don land!' },
    jail: { pose: 'jail', edge: 'left', ms: 2200, line: 'Ah-ah, Kirikiri? Even Big Daddy dey visit. Roll or pay small, make we comot.' },
    lose: { pose: 'deed', edge: 'right', ms: 2100, line: 'E don happen. No shame. Next table, you go shine.', then: 'clap' },
    salary: { pose: 'stand', edge: 'left', ms: 2000, line: 'New salary season! Inflation no go catch you if you hustle.', tint: true },
    paid: { pose: 'clap', edge: 'right', ms: 1800, line: 'All seats paid, table locked. Play sharp!', stamp: 'PAID' },
    afk: { pose: 'stand', edge: 'left', ms: 2200, line: 'Your person don waka? I go hold the seat small. I no go sell your house.' },
    drop: { pose: 'clap', edge: 'right', ms: 1800, line: "Today's drop don land. Come collect before e expire!" },
    card: { pose: 'stand', edge: 'right', ms: 1800, line: 'Power card don land for the table!' },
    low: { pose: 'money', edge: 'left', ms: 5000, line: 'Your cash dey low. Mortgage or trade before the next rent catch you.' },
    build: { pose: 'deed', edge: 'right', ms: 5000, line: 'If you get the colour set, build now. Rent go fat for the next person.' }
  };
  let lastAt = 0;
  const pending = [];
  let timer = null;
  let swapTimer = null;
  let current = null;

  function enabled() {
    try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; }
  }
  function setEnabled(on) {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* private mode still hides the live pop */ }
    const box = document.getElementById('optBigDaddy');
    if (box) box.checked = !!on;
    if (!on) hide();
  }
  function reduced() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }
  function allow(now) {
    return enabled() && (!lastAt || ((now || Date.now()) - lastAt >= GAP_MS));
  }
  function src(pose) {
    const path = POSES[pose] || POSES.stand;
    return path + (BUILD && BUILD.indexOf('__KOLOPOLY') !== 0 ? '?v=' + BUILD : '');
  }
  function propsFor(id) {
    if (id === 'rent') {
      return [14, 30, 46, 62, 76, 88].map((left, i) =>
        '<span class="bd-note" style="left:' + left + '%;animation-delay:' + (i * 0.07) + 's">₦</span>').join('');
    }
    if (id === 'pot') {
      const colors = ['#ffc857', '#1f8a4c', '#e25b4a', '#f4ecdc', '#7eb6ff'];
      return [8, 22, 34, 48, 60, 74, 88].map((left, i) =>
        '<span class="bd-bit" style="left:' + left + '%;background:' + colors[i % colors.length] + ';animation-delay:' + (i * 0.05) + 's"></span>').join('');
    }
    if (id === 'drop') return '<span class="bd-pack" aria-hidden="true"></span>';
    return '';
  }
  function ensure() {
    let el = document.getElementById('bigDaddy');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'bigDaddy';
    el.className = 'bd-pop';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  }
  function hide() {
    clearTimeout(timer);
    clearTimeout(swapTimer);
    timer = null;
    swapTimer = null;
    current = null;
    const el = document.getElementById('bigDaddy');
    if (el) { el.hidden = true; if (el.classList) el.classList.remove('bd-show'); }
  }
  function gamePaused() {
    try {
      const s = window.__kolopolyState && window.__kolopolyState();
      return !!(s && s.paused && s.status === 'playing' && s.mode !== 'pass');
    } catch (e) { return false; }
  }
  let held = false;
  function hold() {
    if (held) { hide(); return; }
    held = true;
    if (current) pending.unshift({ id: current, extra: {} });
    hide();
  }
  function release() {
    if (!held) return;
    held = false;
    if (gamePaused() || current) return;
    const next = pending.shift();
    if (next) show(next.id, Object.assign({ force: true }, next.extra || {}));
  }
  function show(id, extra) {
    extra = extra || {};
    const spec = LINES[id];
    if (!spec || !enabled()) return false;
    const lesson = window.__kolopolyState && window.__kolopolyState();
    const teaching = lesson && lesson.practice && lesson.practice.kind !== 'free' && lesson.practice.action !== 'free' && lesson.practice.step !== 'ready';
    if (teaching) {
      pending.push({ id, extra });
      hide();
      return true;
    }
    if (gamePaused() || held) {
      if (current) pending.unshift({ id: current, extra: {} });
      pending.push({ id, extra });
      held = true;
      hide();
      return true;
    }
    const now = extra.now || Date.now();
    if (!extra.force && (current || (lastAt && now - lastAt < 800))) {
      pending.push({ id, extra });
      return true;
    }
    lastAt = now;
    const el = ensure();
    const pose = spec.pose;
    const tint = spec.tint ? (TINT[extra.phase] || 'none') : 'none';
    const jail = id === 'jail';
    const still = reduced() || extra.still;
    el.className = 'bd-stage' + (still ? ' bd-still' : ' bd-show');
    el.hidden = false;
    el.innerHTML = '<div class="bd-dim"></div><div class="bd-pop' + (jail ? ' bd-jail' : '') + (still ? ' bd-still' : ' bd-show') + '">' +
      '<div class="bd-fx">' + propsFor(id) + '</div>' +
      '<img class="bd-fig" alt="" decoding="async" loading="lazy">' +
      '<div class="bd-bubble"></div></div>';
    const img = el.querySelector('img');
    img.src = src(pose);
    img.style.filter = tint === 'none' ? '' : tint;
    const bubble = el.querySelector('.bd-bubble');
    bubble.textContent = '';
    if (spec.stamp) {
      const stamp = document.createElement('div');
      stamp.className = 'bd-stamp';
      stamp.textContent = spec.stamp;
      bubble.appendChild(stamp);
    }
    const line = document.createElement('div');
    line.textContent = extra.line || spec.line;
    bubble.appendChild(line);
    current = id;
    clearTimeout(timer);
    clearTimeout(swapTimer);
    const words = (extra.line || spec.line || '').length;
    const ms = Math.max(4500, Math.min(8000, 4000 + words * 45));
    timer = setTimeout(() => {
      hide();
      const next = pending.shift();
      if (next) show(next.id, Object.assign({ force: true }, next.extra || {}));
    }, extra.ms || ms);
    bubble.addEventListener('click', () => { hide(); const next = pending.shift(); if (next) show(next.id, Object.assign({ force: true }, next.extra || {})); });
    if (spec.then && !reduced() && !extra.still) {
      swapTimer = setTimeout(() => {
        if (current !== id || !img) return;
        img.src = src(spec.then);
      }, 700);
    }
    try { if (window.KPBigDaddySting) window.KPBigDaddySting(); } catch (e) { /* sound is garnish */ }
    return true;
  }

  // One highlight from a room update. Feed lines and seat changes share
  // the same 20 second gate, so two beats in one push still show once.
  function detect(prev, room, meId) {
    if (!prev || !room) return null;
    const prevSeq = prev.feed && prev.feed.length ? prev.feed[prev.feed.length - 1].seq : 0;
    const fresh = (room.feed || []).filter((e) => e && e.seq > prevSeq);
    for (const e of fresh) {
      if (e.kind === 'power') return 'card';
      if (e.kind === 'bankrupt') return 'lose';
      if (e.kind === 'kirikiri') return 'jail';
      if (e.kind === 'jackpot') return 'pot';
    }
    if (room.owambeResult && room.owambeResult.winnerId != null &&
      (!prev.owambeResult || prev.owambeResult.id !== room.owambeResult.id)) return 'pot';
    if (room.props && prev.props) {
      for (let i = 0; i < room.props.length; i++) {
        const now = room.props[i];
        const old = prev.props[i];
        if (now && old && now.b >= 5 && old.b < 5) return 'rent';
      }
      const groups = (window.KP_DATA && window.KP_DATA.GROUP_SPACES) || {};
      for (const g of Object.keys(groups)) {
        const ids = groups[g];
        if (!ids || !ids.length) continue;
        const owner = room.props[ids[0]] && room.props[ids[0]].o;
        if (owner == null) continue;
        const full = ids.every((i) => room.props[i] && room.props[i].o === owner);
        const was = ids.every((i) => prev.props[i] && prev.props[i].o === owner);
        if (full && !was) return 'rent';
      }
    }
    for (const e of fresh) {
      if (e.kind === 'credit' && e.spaceName && Number(e.amount) >= 40000) return 'rent';
      if (e.kind === 'phase') {
        const now = room.inf ? room.inf.phase : 0;
        const before = prev.inf ? prev.inf.phase : 0;
        if (now > before) return 'salary';
      }
    }
    if (room.paid && room.paid.allPaid && !(prev.paid && prev.paid.allPaid)) return 'paid';
    if (room.players && prev.players) {
      for (const p of room.players) {
        if (!p || !p.afkTaken || p.id === meId) continue;
        const was = prev.players.find((x) => x.id === p.id);
        if (was && !was.afkTaken) return 'afk';
      }
      for (const p of room.players) {
        if (!p || !p.bankrupt) continue;
        const was = prev.players.find((x) => x.id === p.id);
        if (was && !was.bankrupt) return 'lose';
      }
    }
    const me = (room.players || []).find((p) => p.id === meId);
    const prevMe = (prev.players || []).find((p) => p.id === meId);
    if (me && prevMe && me.cash < 80000 && prevMe.cash >= 80000) return 'low';
    if (room.phase === 'end' && prev.phase !== 'end' && me && me.cash > 200000) return 'build';
    return null;
  }


  function bootToggle() {
    const box = document.getElementById('optBigDaddy');
    if (!box) return;
    box.checked = enabled();
    box.addEventListener('change', () => setEnabled(box.checked));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootToggle);
  else bootToggle();

  window.KPBigDaddy = {
    show: show,
    hide: hide,
    hold: hold,
    release: release,
    allow: allow,
    enabled: enabled,
    setEnabled: setEnabled,
    detect: detect,
    lines: LINES,
    gap: GAP_MS,
    _last: () => lastAt,
    _setLast: (t) => { lastAt = t; }
  };
})();
