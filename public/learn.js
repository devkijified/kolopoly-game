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
    if (!tip) return;
    if (remove) tip.remove();
    else tip.hidden = true;
  }
  function trainingLesson(room) {
    const step = room && room.practice;
    return !!(step && step.kind === 'intro' && step.step && step.step !== 'ready' && step.action !== 'stay' && step.action !== 'free');
  }
  function show(id, owner) {
    const spec = TIPS[id];
    const room = roomNow();
    if (!spec || !tipsOn() || !inGame() || !trainingLesson(room)) { hideTip(true); return false; }
    const el = document.querySelector(spec.sel);
    const box = el && el.getBoundingClientRect();
    const inTable = el && el.closest('#view-game');
    if (!el || !inTable || box.width < 8 || box.height < 8) { hideTip(true); return false; }
    let tip = document.getElementById('learnTip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'learnTip';
      tip.innerHTML = '<img alt="" width="42" height="54"><p></p><button type="button" aria-label="Dismiss tip">×</button>';
      document.body.appendChild(tip);
      tip.querySelector('button').addEventListener('click', () => { tip.hidden = true; });
    }
    tip.hidden = false;
    tip.dataset.tip = id;
    tip.querySelector('img').src = '/mascot/daddy-stand.webp';
    tip.querySelector('p').textContent = spec.line;
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const shift = vv ? (vv.offsetTop || 0) : 0;
    const below = r.top < 90;
    tip.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - 58)) + shift + 'px';
    tip.style.left = Math.max(8, Math.min(window.innerWidth - 228, r.left)) + 'px';
    if (owner) mark(id, owner);
    return true;
  }

  const STEP_TIP = {
    roll: 'roll', payroll: 'roll', cardroll: 'roll', jailroll: 'roll', walk1: 'roll', salary: 'roll',
    buy: 'buy',
    adacheer: 'rent', paidcheer: 'rent',
    salarycheer: 'salary',
    jail: 'jail',
    adaroll: 'wait'
  };
  function onRoom(room, meId) {
    if (!inGame() || !trainingLesson(room)) { hideTip(true); return; }
    const id = STEP_TIP[room.practice.step];
    if (!id) { hideTip(true); return; }
    show(id, who(room, meId));
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
  window.KPLearn = { onRoom: onRoom, show: show, hide: hideTip, tipsOn: tipsOn, setTips: setTips, seen: seen };
})();
