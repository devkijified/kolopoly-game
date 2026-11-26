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
  const seen = new Set();
  let timer = null;
  let swapTimer = null;
  let current = null;
  const TIP_MS = 4000;

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
  function place(el) {
    const game = document.getElementById('view-game');
    const bar = document.getElementById('actionBar');
    const onTable = game && game.classList && game.classList.contains('active') && bar && bar.parentNode;
    if (onTable) {
      el.classList.remove('bd-fixed');
      if (el.parentNode !== bar.parentNode || el.nextSibling !== bar) bar.parentNode.insertBefore(el, bar);
      return;
    }
    el.classList.add('bd-fixed');
    if (!el.parentNode) document.body.appendChild(el);
  }
  function dismiss() {
    hide();
    const next = pending.shift();
    if (next) show(next.id, Object.assign({ force: true }, next.extra || {}));
  }
  function show(id, extra) {
    extra = extra || {};
    const spec = LINES[id];
    if (!spec || !enabled()) return false;
    if (spec.line && /monopoly/i.test(spec.line)) return false;
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
    if (!extra.force && lastAt && now - lastAt < GAP_MS) return false;
    lastAt = now;
    const el = ensure();
    const pose = spec.pose;
    const tint = spec.tint ? (TINT[extra.phase] || 'none') : 'none';
    el.className = 'bd-tip';
    el.hidden = false;
    place(el);
    el.innerHTML = '<button type="button" class="bd-chip">' +
      '<img alt="" decoding="async" width="36" height="36">' +
      '<span class="bd-line"></span></button>';
    const img = el.querySelector('img');
    img.src = src(pose);
    img.style.filter = tint === 'none' ? '' : tint;
    const line = el.querySelector('.bd-line');
    const text = extra.line || spec.line;
    line.textContent = spec.stamp ? (spec.stamp + '. ' + text) : text;
    current = id;
    clearTimeout(timer);
    clearTimeout(swapTimer);
    timer = setTimeout(dismiss, extra.ms || TIP_MS);
    const chip = el.querySelector('.bd-chip');
    if (chip && chip.addEventListener) chip.addEventListener('click', (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      dismiss();
    });
    try { if (window.KPBigDaddySting) window.KPBigDaddySting(); } catch (e) { /* sound is garnish */ }
    return true;
  }
  // Drop the chip once the seat no longer has that action.
  function follow(room, meId) {
    if (!current || !room) return;
    const me = (room.players || []).find((p) => p && p.id === meId);
    if (current === 'jail' && (!me || !me.inJail)) hide();
    else if (current === 'build' && room.phase !== 'end') hide();
    else if (current === 'low' && (!me || me.cash >= 80000)) hide();
  }

  // One highlight from a room update, and only for the seat that can
  // act on it. Everyone else keeps the ordinary log line.
  function freshFeed(prev, room) {
    const prevSeq = prev.feed && prev.feed.length ? prev.feed[prev.feed.length - 1].seq : 0;
    return (room.feed || []).filter((e) => e && e.seq > prevSeq);
  }
  function offer(hit, meId) {
    if (!hit || hit.actorId == null || meId == null) return null;
    if (String(hit.actorId) !== String(meId)) return null;
    if (seen.has(hit.key)) return null;
    seen.add(hit.key);
    return hit.id;
  }
  function detect(prev, room, meId) {
    if (!prev || !room) return null;
    const fresh = freshFeed(prev, room);
    let hit = null;
    for (const e of fresh) {
      if (hit) break;
      if (e.kind === 'power' && e.playerId != null) hit = { id: 'card', actorId: e.playerId, key: 'card:' + e.seq };
      else if (e.kind === 'kirikiri' && e.playerId != null) hit = { id: 'jail', actorId: e.playerId, key: 'jail:' + e.seq };
      else if (e.kind === 'jackpot' && e.playerId != null) hit = { id: 'pot', actorId: e.playerId, key: 'pot:' + e.seq };
      else if (e.kind === 'bankrupt' && e.playerId != null) hit = { id: 'lose', actorId: e.playerId, key: 'lose:' + e.seq };
    }
    if (!hit && room.owambeResult && room.owambeResult.winnerId != null &&
      (!prev.owambeResult || prev.owambeResult.id !== room.owambeResult.id)) {
      hit = { id: 'pot', actorId: room.owambeResult.winnerId, key: 'owambe:' + room.owambeResult.id };
    }
    if (!hit && room.props && prev.props) {
      for (let i = 0; i < room.props.length && !hit; i++) {
        const now = room.props[i];
        const old = prev.props[i];
        if (now && old && now.b >= 5 && old.b < 5 && now.o != null) {
          hit = { id: 'rent', actorId: now.o, key: 'hotel:' + i };
        }
      }
      const groups = (window.KP_DATA && window.KP_DATA.GROUP_SPACES) || {};
      for (const g of Object.keys(groups)) {
        if (hit) break;
        const ids = groups[g];
        if (!ids || !ids.length) continue;
        const owner = room.props[ids[0]] && room.props[ids[0]].o;
        if (owner == null) continue;
        const full = ids.every((i) => room.props[i] && room.props[i].o === owner);
        const was = ids.every((i) => prev.props[i] && prev.props[i].o === owner);
        if (full && !was) hit = { id: 'rent', actorId: owner, key: 'set:' + g + ':' + owner };
      }
    }
    if (!hit) {
      for (const e of fresh) {
        if (e.kind === 'credit' && e.spaceName && Number(e.amount) >= 40000 && e.playerId != null) {
          hit = { id: 'rent', actorId: e.playerId, key: 'rent:' + e.seq };
          break;
        }
        if (e.kind === 'phase') {
          const now = room.inf ? room.inf.phase : 0;
          const before = prev.inf ? prev.inf.phase : 0;
          if (now > before && room.turnPlayerId != null) {
            hit = { id: 'salary', actorId: room.turnPlayerId, key: 'salary:' + now };
            break;
          }
        }
      }
    }
    if (!hit && room.paid && room.paid.allPaid && !(prev.paid && prev.paid.allPaid) && room.hostId != null) {
      hit = { id: 'paid', actorId: room.hostId, key: 'paid:' + (room.code || '') };
    }
    if (!hit && room.players && prev.players) {
      for (const p of room.players) {
        if (!p || !p.bankrupt || p.id == null) continue;
        const was = prev.players.find((x) => x.id === p.id);
        if (was && !was.bankrupt) {
          hit = { id: 'lose', actorId: p.id, key: 'broke:' + p.id };
          break;
        }
      }
    }
    const me = (room.players || []).find((p) => p && String(p.id) === String(meId));
    const prevMe = (prev.players || []).find((p) => p && String(p.id) === String(meId));
    if (!hit && me && prevMe && me.cash < 80000 && prevMe.cash >= 80000) {
      hit = { id: 'low', actorId: me.id, key: 'low:' + me.id + ':' + me.cash };
    }
    if (!hit && room.phase === 'end' && prev.phase !== 'end' && room.turnPlayerId != null) {
      const turn = (room.players || []).find((p) => p && p.id === room.turnPlayerId);
      if (turn && turn.cash > 200000) {
        const seq = fresh.length ? fresh[fresh.length - 1].seq : room.turnPlayerId;
        hit = { id: 'build', actorId: turn.id, key: 'build:' + turn.id + ':' + seq };
      }
    }
    return offer(hit, meId);
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
    follow: follow,
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
