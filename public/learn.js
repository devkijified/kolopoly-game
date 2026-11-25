'use strict';
// How to play, and the small first-time tips. The guide is a swipeable
// stack. A tip sits beside one button, never covers the board, and
// never takes the tap the player needs.
(function () {
  const TIPS_OFF = 'kolopolyLearnTips';
  const SEEN_KEY = 'kolopolyFirstTips';
  const TIPS = {
    roll: { sel: '#abRoll', line: 'Tap Roll. It is your turn.' },
    buy: { sel: '#abBuy', line: 'Buy it, or send it to auction.' },
    rent: { sel: '#hudCashBtn', line: 'Your money went to Ada.' },
    salary: { sel: '#hudCashBtn', line: 'The bank paid your salary.' },
    jail: { sel: '#abJailPay', line: 'Tap Pay bail or roll double.' },
    wait: { sel: '.wait-hint', line: 'Wait. It is Ada\'s turn.' }
  };

  function data() { return window.KP_DATA || {}; }
  function money(n) {
    return data().fmtN ? data().fmtN(n) : ('₦' + n);
  }
  function roomNow() {
    try { return window.__kolopolyState && window.__kolopolyState(); } catch (e) { return null; }
  }
  function salary() {
    const room = roomNow();
    if (room && room.inf && room.inf.salary) return room.inf.salary;
    return data().START_PAY || 0;
  }
  function bail() {
    const room = roomNow();
    if (room && room.fees && room.fees.bail) return room.fees.bail;
    return data().JAIL_FINE || 0;
  }
  function street() {
    const spaces = data().SPACES || [];
    return spaces[4] || { name: 'Ajegunle', rent: [0, 0, 0] };
  }
  function cards() {
    const sp = street();
    const site = money(sp.rent ? sp.rent[0] : 0);
    const built = money(sp.rent ? sp.rent[2] : 0);
    return [
      { img: '/mascot/daddy-clap.webp', title: 'Goal', lines: ['Last one with money wins.', 'Or the richest when time ends.'] },
      { img: '/tokens/big-man.webp', title: 'Your turn', lines: ['Tap Roll.', 'Your piece moves that many squares.'] },
      { img: '/stickers/balogun-market.webp', title: 'Empty street', lines: ['Buy it, or send it to auction.', sp.name + ' costs ' + money(sp.price || 0) + '.'] },
      { img: '/mascot/daddy-money.webp', title: 'Someone’s street', lines: ['Pay them rent.', sp.name + ' site rent is ' + site + '.'] },
      { img: '/mascot/daddy-deed.webp', title: 'One colour', lines: ['Own every street in one colour.', 'Build, and rent jumps to ' + built + '.'] },
      { img: '/stickers/event-nepa.webp', title: 'Wahala cards', lines: ['Wahala cards are random.', 'Some pay you. Some take money.'] },
      { img: '/stickers/kirikiri.webp', title: 'Kirikiri', lines: ['Pay bail of ' + money(bail()) + '.', 'Or roll a double to walk out.'] },
      { img: '/mascot/daddy-stand.webp', title: 'Pass START', lines: ['Pass START and collect ' + money(salary()) + '.', 'It lands in your cash.'] },
      { img: '/mascot/daddy-deed.webp', title: 'Out of cash', lines: ['Sell or swap streets.', 'If you still cannot pay, you are out.'] }
    ];
  }

  function ensure() {
    let root = document.getElementById('howScrim');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'howScrim';
    root.hidden = true;
    root.innerHTML = '<div class="how-sheet" role="dialog" aria-label="How to play">' +
      '<button type="button" class="how-x" id="howClose">Close</button>' +
      '<div class="how-track" id="howTrack"></div>' +
      '<div class="how-dots" id="howDots"></div>' +
      '<div class="how-actions">' +
      '<button type="button" class="btn block" id="howTrain">Play Training Ground</button>' +
      '<button type="button" class="btn block ghost" id="howNow">Play now</button></div></div>';
    document.body.appendChild(root);
    root.addEventListener('click', (ev) => { if (ev.target === root) close(); });
    root.querySelector('#howClose').addEventListener('click', close);
    root.querySelector('#howTrain').addEventListener('click', () => {
      close();
      if (window.KPStartPractice) window.KPStartPractice('intro');
    });
    root.querySelector('#howNow').addEventListener('click', () => {
      close();
      const welcome = document.getElementById('welcomeCard');
      const quick = welcome && !welcome.classList.contains('hidden') ? document.getElementById('welcomeQuick') : document.getElementById('quickBtn');
      if (quick) quick.click();
    });
    const track = root.querySelector('#howTrack');
    track.addEventListener('scroll', () => paintDot(root), { passive: true });
    return root;
  }
  function paintDot(root) {
    const track = root.querySelector('#howTrack');
    const dots = root.querySelectorAll('.how-dot');
    if (!track || !dots.length) return;
    const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    dots.forEach((d, n) => d.classList.toggle('on', n === i));
  }
  function open() {
    const root = ensure();
    const list = cards();
    const track = root.querySelector('#howTrack');
    track.innerHTML = list.map((c) =>
      '<article class="how-card"><img alt="" src="' + c.img + '"><h3>' + c.title + '</h3>' +
      c.lines.map((line) => '<p>' + line + '</p>').join('') + '</article>').join('');
    root.querySelector('#howDots').innerHTML = list.map((_, i) =>
      '<i class="how-dot' + (i ? '' : ' on') + '"></i>').join('');
    track.scrollLeft = 0;
    root.hidden = false;
  }
  function close() {
    const root = document.getElementById('howScrim');
    if (root) root.hidden = true;
  }

  function tipsOn() {
    try { return localStorage.getItem(TIPS_OFF) !== '0'; } catch (e) { return true; }
  }
  function setTips(on) {
    try { localStorage.setItem(TIPS_OFF, on ? '1' : '0'); } catch (e) { /* private mode */ }
    const box = document.getElementById('optLearnTips');
    if (box) box.checked = !!on;
    if (!on) hideTip();
  }
  function bag() {
    try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch (e) { return {}; }
  }
  function who(room, meId) {
    const me = room && room.players && room.players.find((p) => p.id === meId);
    let device = 'device';
    try { device = localStorage.getItem('kolopolyClientId') || device; } catch (e) { /* private */ }
    return (me && me.accountId) || device;
  }
  function seen(id, owner) {
    const all = bag();
    return !!(all[owner] && all[owner][id]);
  }
  function mark(id, owner) {
    const all = bag();
    all[owner] = all[owner] || {};
    all[owner][id] = 1;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(all)); } catch (e) { /* private */ }
  }
  function inGame() {
    const view = document.getElementById('view-game');
    return !!(view && view.classList.contains('active'));
  }
  function hideTip(remove) {
    const tip = document.getElementById('learnTip');
    const msg = document.querySelector('.msgbar');
    if (msg) msg.classList.remove('tip-covered');
    if (!tip) return;
    if (remove) tip.remove();
    else tip.hidden = true;
  }
  function trainingLesson(room) {
    const step = room && room.practice;
    return !!(step && step.kind === 'intro' && step.step && step.step !== 'ready' && step.action !== 'stay' && step.action !== 'free');
  }
  function overlaps(a, b, pad) {
    const p = pad || 0;
    return a.left < b.right + p && a.right > b.left - p && a.top < b.bottom + p && a.bottom > b.top - p;
  }
  function blockedBoxes(target) {
    const boxes = [];
    if (target) boxes.push(target.getBoundingClientRect());
    const ring = document.getElementById('coachRing');
    if (ring && !ring.hidden) boxes.push(ring.getBoundingClientRect());
    const card = document.getElementById('coachPop');
    if (card && !card.hidden) boxes.push(card.getBoundingClientRect());
    const topbar = document.querySelector('.topbar');
    if (topbar) boxes.push(topbar.getBoundingClientRect());
    const nav = document.getElementById('secondaryBar');
    if (nav) boxes.push(nav.getBoundingClientRect());
    document.querySelectorAll('#deedSheet p, #deedSheet .kv, #deedSheet td, #deedSheet .flavour, #deedSheet .meaning').forEach((node) => {
      const st = getComputedStyle(node);
      if (st.visibility === 'hidden' || st.display === 'none') return;
      const b = node.getBoundingClientRect();
      if (b.width > 8 && b.height > 8) boxes.push(b);
    });
    return boxes;
  }
  function placeBubble(tip, el) {
    const r = el.getBoundingClientRect();
    const blocked = blockedBoxes(el);
    tip.hidden = false;
    const aside = document.querySelector('#deedSheet .deed-aside');
    if (aside && getComputedStyle(aside).visibility === 'hidden') {
      const gapBox = aside.getBoundingClientRect();
      if (gapBox.width > 40 && gapBox.height > 24) {
        const tw0 = tip.offsetWidth;
        const th0 = tip.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - tw0 - 8, gapBox.left));
        const target = el.getBoundingClientRect();
        let top = Math.max(gapBox.top, target.bottom + 10);
        top = Math.max(8, Math.min(window.innerHeight - th0 - 8, top));
        const parked = { left: left, top: top, right: left + tw0, bottom: top + th0 };
        if (!overlaps(parked, el.getBoundingClientRect(), 2)) {
          tip.style.left = left + 'px';
          tip.style.top = top + 'px';
          const msg = document.querySelector('.msgbar');
          if (msg) msg.classList.remove('tip-covered');
          return;
        }
      }
    }
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const gap = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const raw = [
      { left: r.left + r.width / 2 - tw / 2, top: r.top - th - gap },
      { left: r.left + r.width / 2 - tw / 2, top: r.bottom + gap },
      { left: r.right + gap, top: r.top + (r.height - th) / 2 },
      { left: r.left - tw - gap, top: r.top + (r.height - th) / 2 }
    ];
    const spots = raw.map((s) => ({
      left: Math.max(8, Math.min(vw - tw - 8, s.left)),
      top: Math.max(8, Math.min(vh - th - 8, s.top))
    }));
    const clear = spots.find((s) => {
      const box = { left: s.left, top: s.top, right: s.left + tw, bottom: s.top + th };
      return !blocked.some((b) => overlaps(box, b, 4));
    });
    let spot = clear || spots[0];
    const boxAt = (s) => ({ left: s.left, top: s.top, right: s.left + tw, bottom: s.top + th });
    if (overlaps(boxAt(spot), r, 0)) {
      const above = r.top - th - gap;
      const below = r.bottom + gap;
      if (above >= 8) spot = { left: Math.max(8, Math.min(vw - tw - 8, spot.left)), top: above };
      else if (below + th <= vh - 8) spot = { left: Math.max(8, Math.min(vw - tw - 8, spot.left)), top: below };
    }
    if (overlaps(boxAt(spot), r, 0)) {
      const push = boxAt(spot).bottom - r.top + gap;
      if (spot.top - push >= 8) spot = { left: spot.left, top: spot.top - push };
    }
    tip.style.left = spot.left + 'px';
    tip.style.top = spot.top + 'px';
    const msg = document.querySelector('.msgbar');
    if (msg) msg.classList.toggle('tip-covered', overlaps(boxAt(spot), msg.getBoundingClientRect(), 0));
  }
  function ensureTip() {
    let tip = document.getElementById('learnTip');
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'learnTip';
    tip.innerHTML = '<p></p>';
    document.body.appendChild(tip);
    return tip;
  }
  function show(id, owner) {
    const spec = TIPS[id];
    const room = roomNow();
    if (!spec || !tipsOn() || !inGame() || !trainingLesson(room)) { hideTip(true); return false; }
    const el = document.querySelector(spec.sel);
    const box = el && el.getBoundingClientRect();
    const inTable = el && el.closest('#view-game');
    if (!el || !inTable || box.width < 8 || box.height < 8) { hideTip(true); return false; }
    const tip = ensureTip();
    tip.dataset.tip = id;
    tip.querySelector('p').textContent = spec.line;
    placeBubble(tip, el);
    if (owner) mark(id, owner);
    return true;
  }
  function place() {
    const room = roomNow();
    const tip = document.getElementById('learnTip');
    if (!tip || tip.hidden || !trainingLesson(room)) return;
    const el = document.querySelector(room.practice.target || '');
    if (!el) return;
    placeBubble(tip, el);
  }
  function aimed(sel) {
    const all = document.querySelectorAll(sel);
    for (const el of all) if (el.classList.contains('coach-live')) return el;
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width > 8 && r.height > 8) return el;
    }
    return all[0] || null;
  }
  function sync(room, meId) {
    if (!inGame() || !trainingLesson(room) || !tipsOn()) { hideTip(true); return; }
    const step = room.practice;
    if (!step.target || !step.line) { hideTip(true); return; }
    const el = aimed(step.target);
    const box = el && el.getBoundingClientRect();
    const inTable = el && (el.closest('#view-game') || el.closest('.sheet') || el.closest('.modal-card') || el.closest('#coachPop'));
    if (!el || !inTable || box.width < 8 || box.height < 8) { hideTip(true); return; }
    const tip = ensureTip();
    tip.dataset.tip = step.step;
    tip.querySelector('p').textContent = step.line;
    placeBubble(tip, el);
    if (meId) mark(step.step, who(room, meId));
  }
  function onRoom(room, meId) {
    sync(room, meId);
    if (window.KPLessonChrome) window.KPLessonChrome();
  }

  function boot() {
    ['howBtn', 'welcomeHowBtn', 'lobbyHowBtn', 'hudHelp'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', open);
    });
    const box = document.getElementById('optLearnTips');
    if (box) {
      box.checked = tipsOn();
      box.addEventListener('change', () => setTips(box.checked));
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.KPHowTo = { open: open, close: close };
  window.KPLearn = { onRoom: onRoom, sync: sync, show: show, hide: hideTip, place: place, tipsOn: tipsOn, setTips: setTips, seen: seen };
})();
