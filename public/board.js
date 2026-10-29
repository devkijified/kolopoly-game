'use strict';
// KOLOPOLY board renderer. Builds the 40 space grid from KP_DATA, animates
// token hops on the one full board (KP10: there is no follow view; the
// whole board is always on screen), fills deed sheets and draws the
// portrait share cards on canvas. No game rules live here beyond display
// mirrors of the server checks (the server validates everything).
// Presentation only: art per space, a Lagos skyline centre, an Owambe pot
// that visibly grows, 3D styled dice and tokens drawn as objects.
const D = window.KP_DATA;

// KP14 sound beats, 2D renderer edition. In GL mode the 3D layer owns
// the beats (this DOM board still animates invisibly as the click
// grid, and a doubled tick per hop was the old bug); in 2D mode these
// are the animation's own beats.
function beat2d(name, data) {
  try {
    if (window.KP3D && window.KP3D.active) return;
    if (window.KPBeat) window.KPBeat(name, Object.assign({ t: performance.now() }, data || {}));
  } catch (e) { /* sound is garnish */ }
}

const COLW = [1.6, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.6];
const TOTALW = COLW.reduce((a, b) => a + b, 0);
function gridPos(i) {
  if (i <= 10) return { row: 11, col: 11 - i };
  if (i <= 20) return { row: 21 - i, col: 1 };
  if (i <= 30) return { row: 1, col: i - 19 };
  return { row: i - 29, col: 11 };
}
// KP11: the 2D board obeys the same law as the 3D one: its canvas fills
// the presentation box and the track spreads over the box's rectangle.
// Corners stay 1.6 x 1.6; a tall box pours extra depth into the middle
// rows, a wide box pours extra width into the middle columns. The DOM
// fills its box exactly, so no camera correction applies here.
let L2D = { TW: TOTALW, TD: TOTALW, colX: COLW.slice(), rowD: COLW.slice() };
function trackLayout2D(boxAspect) {
  let TW, TD;
  if (boxAspect >= 1) { TW = TOTALW; TD = TOTALW * boxAspect; }
  else { TD = TOTALW; TW = TOTALW / boxAspect; }
  const wm = (TW - 3.2) / 9, dm = (TD - 3.2) / 9;
  const colX = [], rowD = [];
  for (let k = 0; k < 11; k++) {
    colX.push(k === 0 || k === 10 ? 1.6 : wm);
    rowD.push(k === 0 || k === 10 ? 1.6 : dm);
  }
  return { TW, TD, colX, rowD };
}
function spaceCenter(i) {
  const { row, col } = gridPos(i);
  let px = 0; for (let c = 1; c < col; c++) px += L2D.colX[c - 1];
  let py = 0; for (let r = 1; r < row; r++) py += L2D.rowD[r - 1];
  return { x: (px + L2D.colX[col - 1] / 2) / L2D.TW, y: (py + L2D.rowD[row - 1] / 2) / L2D.TD };
}
const TOKEN_SLOTS = [[-0.021, -0.021], [0.021, -0.021], [-0.021, 0.021], [0.021, 0.021], [0, -0.033], [0, 0.033]];

// Tile price labels are artwork: a compact price never clips into a wrong
// looking number on a small tile. The deed sheet carries the exact figure.
function fmtK(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 1000) { const k = v / 1000; return '₦' + (Number.isInteger(k) ? k : k.toFixed(1)) + 'K'; }
  return '₦' + v;
}
function priceLabel(sp) {
  const v = sp.price ? sp.price : sp.type === 'tax' ? sp.amount : 0;
  if (!v) return '';
  return '<span class="pr-full">' + D.fmtN(v) + '</span><span class="pr-compact">' + fmtK(v) + '</span>';
}

function bandColorFor(i, sp) {
  return sp.type === 'street' ? D.GROUPS[sp.group].color
    : sp.type === 'station' ? '#3d3d3d' : sp.type === 'utility' ? '#3f7fbf'
    : i === 0 ? '#e8a90c' : i === 20 ? '#e8a90c' : i === 10 || i === 30 ? '#8c2f2f'
    : sp.type === 'card' ? (sp.deck === 'wahala' ? '#d64545' : '#3f7fbf') : '#b8a888';
}
// One scene per space identity. Group fallbacks first, hand picks on top.
const ART_BY_GROUP = { brown: 'stalls', lightblue: 'house', pink: 'house', orange: 'towers', red: 'gate', yellow: 'towers', green: 'mansion', darkblue: 'mansion' };
const ART_BY_SPACE = {
  0: 'payday', 1: 'stilts', 3: 'ball', 4: 'taxdoc', 5: 'train', 6: 'stalls', 9: 'bread',
  12: 'pylon', 13: 'tech', 14: 'stadium', 15: 'plane', 18: 'stalls', 19: 'computer',
  20: 'party', 24: 'palms', 25: 'crane', 27: 'bank', 28: 'watertower', 29: 'dome',
  30: 'bars', 32: 'towers', 35: 'interchange', 38: 'taxdoc', 39: 'island'
};
function artFor(i, sp) {
  if (ART_BY_SPACE[i]) return ART_BY_SPACE[i];
  if (sp.type === 'street') return ART_BY_GROUP[sp.group] || 'house';
  if (sp.type === 'station') return 'train';
  if (sp.type === 'utility') return i === 12 ? 'pylon' : 'watertower';
  if (sp.type === 'jail' || sp.type === 'gotojail') return 'bars';
  if (sp.type === 'freeparking') return 'party';
  if (sp.type === 'tax') return 'taxdoc';
  if (sp.type === 'card') return 'cards';
  if (sp.type === 'start') return 'payday';
  return 'house';
}

const DUPLEX_SVG = '<svg viewBox="0 0 24 24" class="bldg" aria-hidden="true"><path d="M3 11 L12 3 L21 11 L19 11 L12 5 L5 11Z" fill="#7a1f1f"/><rect x="6" y="11" width="12" height="9" fill="#1d9e6c"/><rect x="10.4" y="14.5" width="3.2" height="5.5" fill="#0c4d31"/><rect x="7.4" y="12.8" width="2.4" height="2.4" fill="#ffe9a8"/><rect x="14.2" y="12.8" width="2.4" height="2.4" fill="#ffe9a8"/></svg>';
const MANSION_SVG = '<svg viewBox="0 0 24 24" class="bldg mansion" aria-hidden="true"><path d="M2 9 L12 2 L22 9 L20 9 L12 3.6 L4 9Z" fill="#5d1414"/><rect x="4" y="9" width="16" height="11" fill="#b02e2e"/><rect x="7" y="12" width="2.6" height="4" fill="#ffe9a8"/><rect x="14.4" y="12" width="2.6" height="4" fill="#ffe9a8"/><rect x="10.6" y="13.5" width="2.8" height="6.5" fill="#3d0d0d"/><rect x="2.5" y="20" width="19" height="1.6" fill="#5d1414"/></svg>';

const SKYLINE_SVG =
  '<svg viewBox="0 0 320 96" preserveAspectRatio="xMidYMax slice" aria-hidden="true">' +
  '<circle cx="274" cy="18" r="13" fill="#f6b73c" opacity=".55"/>' +
  '<g fill="#2e6b46" opacity=".20">' +
  '<rect x="8" y="38" width="26" height="58"/><rect x="40" y="26" width="20" height="70"/>' +
  '<rect x="64" y="46" width="30" height="50"/><rect x="236" y="30" width="22" height="66"/>' +
  '<rect x="262" y="44" width="26" height="52"/><rect x="292" y="22" width="20" height="74"/></g>' +
  '<path d="M0 74 Q160 40 320 74" stroke="#2b2018" stroke-width="4" fill="none" opacity=".30"/>' +
  '<path d="M60 66 V96 M160 58 V96 M260 66 V96" stroke="#2b2018" stroke-width="4" opacity=".30"/>' +
  '<path d="M0 76 H320" stroke="#2b2018" stroke-width="3" opacity=".30"/>' +
  '<g transform="translate(140,50)"><rect width="34" height="13" rx="3" fill="#f6b73c" opacity=".95"/>' +
  '<rect x="3" y="3" width="6" height="4" fill="#cfeefb"/><rect x="11" y="3" width="6" height="4" fill="#cfeefb"/><rect x="19" y="3" width="6" height="4" fill="#cfeefb"/>' +
  '<rect y="8" width="34" height="2.4" fill="#232323" opacity=".8"/>' +
  '<circle cx="8" cy="14" r="2.6" fill="#232323"/><circle cx="26" cy="14" r="2.6" fill="#232323"/></g>' +
  '<path d="M0 88 Q20 84 40 88 T80 88 T120 88 T160 88 T200 88 T240 88 T280 88 T320 88" stroke="#3f7fbf" stroke-width="2.4" fill="none" opacity=".35"/>' +
  '</svg>';

const SEAL_SVG =
  '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
  '<circle cx="24" cy="24" r="15.5" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
  '<path d="M24 14 L27 20.5 L34 21.4 L28.8 26.2 L30.2 33.2 L24 29.7 L17.8 33.2 L19.2 26.2 L14 21.4 L21 20.5Z" fill="currentColor"/></svg>';

const LANDSCAPE_Q = '(orientation: landscape) and (min-width: 700px)';

const KPBoard = {
  els: [],
  center: null,
  tokenEls: {},
  displayedPos: {},
  animating: false,
  onSpaceTap: null,
  lastState: null,
  lastDiceKey: null,

  // Fit the grid templates to the board element's own box (KP11): the
  // track rectangle follows the box, so the DOM board fills it edge to
  // edge just like the 3D one. No-ops until the element has a real size
  // and whenever the aspect class has not changed.
  fitLayout() {
    const el = this.boardEl;
    if (!el || !el.clientWidth || !el.clientHeight) return;
    const L = trackLayout2D(el.clientHeight / el.clientWidth);
    if (Math.abs(L.TD / L.TW - L2D.TD / L2D.TW) < 0.012 && Math.abs(L.TW - L2D.TW) < 0.05) return;
    L2D = L;
    el.style.gridTemplateColumns = L.colX.map((v) => v.toFixed(4) + 'fr').join(' ');
    el.style.gridTemplateRows = L.rowD.map((v) => v.toFixed(4) + 'fr').join(' ');
  },

  build(boardEl) {
    this.boardEl = boardEl;
    boardEl.innerHTML = '';
    this.els = [];
    for (let i = 0; i < 40; i++) {
      const sp = D.SPACES[i];
      const { row, col } = gridPos(i);
      const el = document.createElement('div');
      const isCorner = (row === 1 || row === 11) && (col === 1 || col === 11);
      el.className = 'bspace' + (isCorner ? ' corner' : '');
      el.style.gridRow = row;
      el.style.gridColumn = col;
      el.dataset.space = i;
      const bandColor = bandColorFor(i, sp);
      el.style.setProperty('--band', bandColor);
      el.innerHTML =
        '<div class="band"></div>' +
        '<div class="tile-art" style="color:' + bandColor + '">' + window.tileArt(artFor(i, sp)) + '</div>' +
        '<div class="nm">' + (sp.short || sp.name) + '</div>' +
        '<div class="pips"></div>' +
        (i === 20 ? '<div class="potamt"></div>' : '') +
        '<div class="pr">' + priceLabel(sp) + '</div>' +
        '<div class="ownbar"></div>';
      el.addEventListener('click', () => { if (this.onSpaceTap) this.onSpaceTap(i); });
      boardEl.appendChild(el);
      this.els.push(el);
    }
    const center = document.createElement('div');
    center.className = 'bcenter';
    center.style.gridRow = '2 / 11';
    center.style.gridColumn = '2 / 11';
    center.innerHTML =
      '<div class="skyline">' + SKYLINE_SVG + '</div>' +
      '<div class="logo">KOLO<span class="gold">POLY</span></div>' +
      '<div class="meta" id="centerPhase"></div>' +
      '<div class="pot-visual" id="centerPotVisual" data-tier="0"><div class="pot-notes"></div><div class="pot-bowl"><span></span></div></div>' +
      '<div class="pot" id="centerPot">Owambe Pot ₦0</div>' +
      '<div class="dice-row" id="centerDice"></div>' +
      '<div class="deck-row"><span class="deck-pile wahala">WAHALA</span><span class="deck-pile family">FAMILY MEETING</span></div>' +
      '<div class="meta" id="centerSupply"></div>';
    boardEl.appendChild(center);
    this.center = center;
    const layer = document.createElement('div');
    layer.className = 'btokens';
    layer.id = 'tokenLayer';
    boardEl.appendChild(layer);
    this.tokenLayer = layer;
  },

  dieHTML(v) {
    const on = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }[v] || [];
    let cells = '';
    for (let k = 0; k < 9; k++) cells += '<i class="' + (on.includes(k) ? 'on' : '') + '"></i>';
    return '<div class="die">' + cells + '</div>';
  },

  render(state) {
    this.fitLayout();
    this.lastState = state;
    const byId = {};
    for (const p of state.players) byId[p.id] = p;
    for (let i = 0; i < 40; i++) {
      const el = this.els[i];
      const pr = state.props[i];
      const pips = el.querySelector('.pips');
      const ownbar = el.querySelector('.ownbar');
      if (pr && pr.o != null) {
        const owner = byId[pr.o];
        ownbar.style.background = owner ? owner.color : 'transparent';
        el.classList.add('owned');
        el.style.setProperty('--own', owner ? owner.color : 'transparent');
        el.classList.toggle('mortgaged', !!pr.m);
        if (pr.b >= 5) pips.innerHTML = MANSION_SVG;
        else if (pr.b > 0) pips.innerHTML = DUPLEX_SVG.repeat(pr.b);
        else pips.innerHTML = '';
        let tag = el.querySelector('.pledgetag');
        if (pr.pl) {
          if (!tag) { tag = document.createElement('div'); tag.className = 'pledgetag'; tag.textContent = 'PLEDGED'; el.appendChild(tag); }
        } else if (tag) tag.remove();
      } else {
        ownbar.style.background = 'transparent';
        el.classList.remove('owned', 'mortgaged');
        el.style.removeProperty('--own');
        pips.innerHTML = '';
        const tag = el.querySelector('.pledgetag');
        if (tag) tag.remove();
      }
      if (i === 20) {
        const potEl = el.querySelector('.potamt');
        if (potEl) potEl.textContent = 'Pot ' + D.fmtN(state.pot);
      }
      el.classList.toggle('legal', !!this.legalSet && this.legalSet.has(i));
    }
    const centerPot = document.getElementById('centerPot');
    if (centerPot) centerPot.textContent = 'Owambe Pot ' + D.fmtN(state.pot);
    const potVisual = document.getElementById('centerPotVisual');
    if (potVisual) {
      const pot = state.pot || 0;
      const tier = pot <= 0 ? 0 : pot < 100000 ? 1 : pot < 300000 ? 2 : pot < 600000 ? 3 : pot < 1000000 ? 4 : 5;
      if (potVisual.dataset.tier !== String(tier)) {
        potVisual.dataset.tier = String(tier);
        potVisual.querySelector('.pot-notes').innerHTML = '<i></i>'.repeat(tier * 2);
      }
    }
    const centerDice = document.getElementById('centerDice');
    if (centerDice) {
      const key = state.dice ? state.dice.join(',') : '';
      if (key !== this.lastDiceKey) {
        this.lastDiceKey = key;
        centerDice.innerHTML = state.dice ? this.dieHTML(state.dice[0]) + this.dieHTML(state.dice[1]) : '';
        if (key && state.status === 'playing') {
          centerDice.classList.remove('tumble');
          void centerDice.offsetWidth;
          centerDice.classList.add('tumble');
          beat2d('diceStart', { values: state.dice.slice() });
          const dbl = state.dice[0] === state.dice[1];
          setTimeout(() => beat2d('diceSettle', { doubles: dbl }), 570); // the CSS tumble runs 0.5s, second die 0.07s behind
        }
      }
    }
    const centerSupply = document.getElementById('centerSupply');
    if (centerSupply) centerSupply.textContent = 'Bank supply: ' + state.duplexSupply + ' duplexes, ' + state.mansionSupply + ' mansions';
    const centerPhase = document.getElementById('centerPhase');
    if (centerPhase) {
      centerPhase.textContent = state.inf
        ? 'Phase ' + state.inf.phase + ': ' + state.inf.phaseName + ' · Index ' + state.inf.index + 'x · Pure water ₦' + [50, 100, 200, 500][state.inf.phase - 1] + ' · Salary ' + D.fmtN(state.inf.salary)
        : '';
    }
    this.renderTokens(state);
    this.applyCamera(state);
  },

  renderTokens(state) {
    const layer = this.tokenLayer;
    if (!layer) return;
    const seen = new Set();
    const slotCount = {};
    for (const p of state.players) {
      seen.add(p.id);
      let el = this.tokenEls[p.id];
      if (!el) {
        el = document.createElement('div');
        el.className = 'btoken';
        this.tokenEls[p.id] = el;
        layer.appendChild(el);
      }
      const sig = p.token + '|' + p.color;
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.innerHTML = '<span class="tok-base" style="background:' + p.color + '"></span><span class="tok-in">' + window.tokenArt(p.token) + '</span>';
      }
      el.title = p.name;
      const target = p.position;
      const shown = this.displayedPos[p.id];
      if (shown === undefined) {
        this.displayedPos[p.id] = target;
        this.placeToken(el, p, target, slotCount);
      } else if (shown !== target && !this.animating && state.status === 'playing') {
        this.animateToken(p, shown, target, slotCount, state);
      } else if (!this.animating) {
        this.placeToken(el, p, target, slotCount);
      }
    }
    for (const id of Object.keys(this.tokenEls)) {
      if (!seen.has(Number(id))) { this.tokenEls[id].remove(); delete this.tokenEls[id]; delete this.displayedPos[id]; }
    }
  },

  placeToken(el, p, pos, slotCount) {
    const c = spaceCenter(pos);
    const slot = slotCount[pos] || 0;
    slotCount[pos] = slot + 1;
    const off = TOKEN_SLOTS[slot % TOKEN_SLOTS.length];
    el.style.left = ((c.x + off[0]) * 100) + '%';
    el.style.top = ((c.y + off[1]) * 100) + '%';
    el.style.opacity = p.bankrupt ? '0.35' : '1';
  },

  animateToken(p, from, to, slotCount, state) {
    // Teleports (Kirikiri) jump; normal moves hop space by space, in the
    // open, on the full board (KP10: one view only, nothing chases them).
    const el = this.tokenEls[p.id];
    const fwd = (to - from + 40) % 40;
    if (p.inJail || fwd > 12 || fwd === 0) {
      this.displayedPos[p.id] = to;
      this.placeToken(el, p, to, slotCount);
      if (p.inJail) beat2d('jailIn', { playerId: p.id });
      return;
    }
    this.animating = true;
    const inner = el.querySelector('.tok-in');
    let cur = from;
    const step = () => {
      if (!this.lastState || this.lastState !== state && this.displayedPos[p.id] === to) { this.animating = false; return; }
      cur = (cur + 1) % 40;
      this.displayedPos[p.id] = cur;
      this.placeToken(el, p, cur, slotCount);
      if (inner) {
        inner.classList.remove('hop');
        void inner.offsetWidth;
        inner.classList.add('hop');
      }
      beat2d('hop', { playerId: p.id });
      if (cur !== to) setTimeout(step, 230);
      else { this.animating = false; beat2d('land', { playerId: p.id, space: to }); if (this.lastState) this.renderTokens(this.lastState); }
    };
    setTimeout(step, 60);
  },

  // KP10: there is no DOM camera anymore. The board is never transformed:
  // the whole square is always on screen. The hook stays because the 3D
  // layer patches it (in gl mode the DOM board is an invisible click grid
  // and must never be transformed either).
  applyCamera(state) {
    const board = document.getElementById('board');
    if (board) board.style.transform = 'scale(1)';
  },

  // Client mirror of the server rent maths, for deed sheet previews only.
  clientRent(state, i) {
    const sp = D.SPACES[i];
    const pr = state.props[i];
    if (!pr || pr.o == null || pr.m) return 0;
    if (sp.type === 'station') {
      const n = D.STATIONS.filter((s) => state.props[s] && state.props[s].o === pr.o).length;
      return 25000 * Math.pow(2, n - 1);
    }
    if (sp.type === 'utility') return null;
    if (pr.b >= 5) return sp.rent[6];
    if (pr.b > 0) return sp.rent[pr.b + 1];
    const ownsSet = D.GROUP_SPACES[sp.group].every((g) => state.props[g] && state.props[g].o === pr.o);
    const setMort = D.GROUP_SPACES[sp.group].some((g) => state.props[g] && state.props[g].m);
    return ownsSet && !setMort ? sp.rent[1] : sp.rent[0];
  },
  canBuildHere(state, playerId, i, kind) {
    const sp = D.SPACES[i];
    const pr = state.props[i];
    if (!sp || sp.type !== 'street' || !pr || pr.o !== playerId || pr.m) return false;
    if (!D.GROUP_SPACES[sp.group].every((g) => state.props[g] && state.props[g].o === playerId)) return false;
    if (D.GROUP_SPACES[sp.group].some((g) => state.props[g] && (state.props[g].m || state.props[g].pl))) return false;
    const bs = D.GROUP_SPACES[sp.group].map((g) => state.props[g].b);
    if (kind === 'duplex') {
      if (pr.b >= 4) return false;
      return (pr.b + 1) - Math.min(...bs) <= 1;
    }
    if (pr.b !== 4) return false;
    return bs.every((b) => b >= 4);
  },

  tileFace(i) {
    const sp = D.SPACES[i];
    if (!sp) return { band: '#b8a888', art: 'house', name: '', price: '' };
    return {
      band: bandColorFor(i, sp),
      art: artFor(i, sp),
      name: sp.short || sp.name,
      price: sp.price ? D.fmtN(sp.price) : ''
    };
  },

  deedHTML(i, state, viewerId) {
    const sp = D.SPACES[i];
    const byId = {};
    for (const p of state.players) byId[p.id] = p;
    const esc = window.KPesc || ((s) => String(s));
    const band = bandColorFor(i, sp);
    const head =
      '<div class="grab"></div><div class="deed-doc">' +
      '<div class="deed-head" style="background:' + band + '">' +
      '<div class="deed-seal">' + SEAL_SVG + '</div>' +
      '<div class="deed-head-tx"><div class="deed-kicker">KOLOPOLY LAND REGISTRY · TITLE DEED</div>' +
      '<h3 class="title">' + esc(sp.name) + '</h3>';
    if (!sp.price) {
      let body = '';
      if (sp.type === 'start') body = 'Pass START and salary alert enter your account. Classic pays ' + D.fmtN(D.START_PAY) + (state.inf ? '; this room dey Phase ' + state.inf.phase + ', so salary na ' + D.fmtN(state.inf.salary) : '') + '.';
      else if (sp.type === 'jail') body = 'Kirikiri. Just visiting no wahala. If you dey inside: pay bail ' + D.fmtN(D.JAIL_FINE) + ', flash a Get Out card, or roll a double within 3 turns.';
      else if (sp.type === 'gotojail') body = 'Land here and officers bundle you straight to Kirikiri. No salary for the trip.';
      else if (sp.type === 'freeparking') body = 'Owambe Grounds. The pot holds ' + D.fmtN(state.pot) + ' right now. Land here and you collect everything. The pot only grows from taxes, fines and fees, never from rent.';
      else if (sp.type === 'tax') body = 'Tax space. Landing here costs ' + D.fmtN(sp.amount) + (i === 4 ? ' flat, or 10 percent of your total worth, your choice' : '') + '. The money enters the Owambe pot.';
      else if (sp.type === 'card') body = 'Draw a ' + (sp.deck === 'wahala' ? 'WAHALA' : 'FAMILY MEETING') + ' card and do wetin e talk.';
      return head + '</div></div>' +
        '<div class="deed-body">' +
        (sp.meaning ? '<div class="meaning">' + esc(sp.meaning) + '</div>' : '') +
        '<p class="lead" style="margin-top:10px;">' + body + '</p>' +
        '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>' +
        '</div></div>';
    }
    const pr = state.props[i];
    const owner = pr && pr.o != null ? byId[pr.o] : null;
    let html = head +
      '<p class="deed-sub">' + (sp.type === 'street' ? D.GROUPS[sp.group].name + ' set' : sp.type === 'station' ? 'Station' : 'Utility') +
      (owner ? ' · Owner: <b>' + esc(owner.name) + '</b>' : ' · Unowned, bank dey hold am') +
      (pr && pr.m ? ' · <b>MORTGAGED</b>' : '') + (pr && pr.pl ? ' · <b>PLEDGED as loan security</b>' : '') +
      (pr && pr.b ? ' · ' + (pr.b >= 5 ? 'Mansion built' : pr.b + ' duplex(es) built') : '') + '</p></div>' +
      (owner ? '<div class="deed-stamp" style="--own:' + owner.color + '">OWNED</div>' : '') +
      '</div><div class="deed-body">';
    if (sp.meaning) html += '<div class="meaning">' + esc(sp.meaning) + '</div>';
    html += '<div class="kv"><span>Price</span><b>' + D.fmtN(sp.price) + '</b></div>';
    html += '<div class="kv"><span>Mortgage value</span><b>' + D.fmtN(D.mortgageOf(sp.price)) + '</b></div>';
    html += '<div class="kv"><span>Lift mortgage for</span><b>' + D.fmtN(D.unmortgageCost(sp.price)) + '</b></div>';
    if (sp.type === 'street') {
      const rows = [['Site only', sp.rent[0]], ['Full set (site x2)', sp.rent[1]], ['1 duplex', sp.rent[2]], ['2 duplexes', sp.rent[3]], ['3 duplexes', sp.rent[4]], ['4 duplexes', sp.rent[5]], ['MANSION', sp.rent[6]]];
      const cur = !pr || pr.o == null ? -1 : pr.b >= 5 ? 6 : pr.b > 0 ? pr.b + 1 : (this.clientRent(state, i) === sp.rent[1] ? 1 : 0);
      html += '<table class="ladder"><tr><th>Rent ladder</th><th>Rent</th></tr>' +
        rows.map((r, idx) => '<tr class="' + (idx === cur ? 'here' : '') + '"><td>' + r[0] + '</td><td>' + D.fmtN(r[1]) + '</td></tr>').join('') + '</table>';
      html += '<p class="caption">Build cost: Classic and Phase 1 pay the printed ' + D.fmtN(sp.duplex) + '. Phase 2 multiplies the printed cost by your lowest die, Phase 3 by your bigger die, same as rent. Cement don reach new price: na why your duplex cost dey multiply, no be malice.</p>';
    } else if (sp.type === 'station') {
      const rows = [['1 station', 25000], ['2 stations', 50000], ['3 stations', 100000], ['4 stations', 200000]];
      const n = pr && pr.o != null ? D.STATIONS.filter((s) => state.props[s] && state.props[s].o === pr.o).length : 0;
      html += '<table class="ladder"><tr><th>Stations owned</th><th>Rent</th></tr>' +
        rows.map((r, idx) => '<tr class="' + (idx === n - 1 ? 'here' : '') + '"><td>' + r[0] + '</td><td>' + D.fmtN(r[1]) + '</td></tr>').join('') + '</table>';
    } else {
      html += '<p class="lead" style="margin-top:10px;">Rent na dice total x ₦1,000. Own both utilities and na dice total x ₦10,000. Utilities never carry the Inflation multiplier.</p>';
    }
    if (state.inf && (sp.type === 'street' || sp.type === 'station')) {
      const base = this.clientRent(state, i);
      const me = byId[viewerId];
      const myPass = me && pr && pr.o != null ? state.inf.contracts.find((c) => c.type === 'pass' && c.buyer === viewerId && c.street === i && c.seller === pr.o) : null;
      if (base) {
        html += '<div class="meaning">Inflation Phase ' + state.inf.phase + ': rent if you land here by dice na printed ' + D.fmtN(base) + (state.inf.phase === 1 ? ' (no multiplier yet)' : state.inf.phase === 2 ? ' x your lowest die (1 to 6)' : ' x your bigger die (1 to 6)') + '. Worst case: ' + D.fmtN(base * (state.inf.phase === 1 ? 1 : 6)) + '.' +
          (myPass ? ' You hold ' + myPass.chipsLeft + ' Pass chip(s) for this street: a landing go cost you ₦0.' : '') + '</div>';
      }
    }
    if (owner && viewerId === owner.id) {
      html += '<div class="btnrow">' +
        (sp.type === 'street' ? '<button class="btn small green" data-act="build-duplex" data-space="' + i + '">Build duplex</button>' +
          '<button class="btn small green" data-act="build-mansion" data-space="' + i + '">Build mansion</button>' +
          '<button class="btn small ghost" data-act="sell-building" data-space="' + i + '">Sell building</button>' : '') +
        (pr && !pr.m ? '<button class="btn small ghost" data-act="mortgage" data-space="' + i + '">Mortgage for ' + D.fmtN(D.mortgageOf(sp.price)) + '</button>'
          : '<button class="btn small ghost" data-act="unmortgage" data-space="' + i + '">Lift mortgage ' + D.fmtN(D.unmortgageCost(sp.price)) + '</button>') +
        '</div><p class="caption mt8">You fit build anytime, even when no be your turn. The server checks the live state when your action land. Even building, full sets and pledges still apply.</p>';
    }
    const dealActorId = state.mode === 'pass' ? state.turnPlayerId : viewerId;
    const meDeal = byId[dealActorId];
    const dealOthers = meDeal && !meDeal.bankrupt && state.players.some((p) => p.id !== meDeal.id && !p.bankrupt);
    if (meDeal && pr && pr.o != null && dealOthers) {
      const mine = pr.o === meDeal.id;
      html += '<div class="deed-deals"><div class="deed-deals-k">Deals</div><div class="btnrow">';
      html += '<button type="button" class="btn" data-act="deal-swap" data-space="' + i + '">' + (mine ? 'Offer in a swap' : 'Swap for this') + '</button>';
      if (state.inf && sp.type === 'street' && !mine && state.inf.phase < 4) {
        html += '<button type="button" class="btn" data-act="deal-pass" data-space="' + i + '">Buy a Pass</button>';
      }
      if (state.inf && mine && state.inf.phase >= 2 && state.inf.phase < 4 && !pr.m && !pr.pl) {
        html += '<button type="button" class="btn" data-act="deal-loan" data-space="' + i + '">Pledge a loan</button>';
      }
      if (state.inf) html += '<button type="button" class="btn ghost" data-act="deal-break" data-space="' + i + '">Deal Break</button>';
      html += '</div><p class="caption">Deals for this deed. If e no dey for contract board, e no happen.</p></div>';
    }
    html += '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>';
    html += '</div></div>';
    return html;
  },

  drawShareCard(kind, data) {
    const cv = document.createElement('canvas');
    cv.width = 1080; cv.height = 1350;
    const x = cv.getContext('2d');
    const ink = '#2b2018';
    const cream = '#f6efe2';
    const gold = '#e8a90c';
    const goldSoft = '#ffc857';
    const paper = '#fffaf0';
    const rr = (l, t, w, h, r) => {
      x.beginPath();
      x.moveTo(l + r, t);
      x.arcTo(l + w, t, l + w, t + h, r);
      x.arcTo(l + w, t + h, l, t + h, r);
      x.arcTo(l, t + h, l, t, r);
      x.arcTo(l, t, l + w, t, r);
      x.closePath();
    };
    x.fillStyle = cream;
    x.fillRect(0, 0, 1080, 1350);
    const sun = x.createRadialGradient(880, 160, 10, 880, 200, 460);
    sun.addColorStop(0, 'rgba(255, 200, 87, 0.7)');
    sun.addColorStop(1, 'rgba(255, 200, 87, 0)');
    x.fillStyle = sun;
    x.fillRect(0, 0, 1080, 640);
    x.fillStyle = 'rgba(43, 32, 24, 0.1)';
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 8; col++) {
        x.beginPath();
        x.arc(78 + col * 16, 86 + row * 16, row % 2 ? 2.2 : 3.1, 0, Math.PI * 2);
        x.fill();
      }
    }
    // Lagos roofline, comic flat colour, sitting above the footer.
    x.fillStyle = ink;
    const roofs = [[48, 1040, 64, 150], [118, 990, 46, 200], [170, 1060, 70, 130], [250, 960, 38, 230], [300, 1020, 80, 170], [760, 1000, 54, 190], [820, 1068, 90, 122], [920, 980, 40, 210], [970, 1048, 70, 142]];
    for (const b of roofs) { x.fillRect(b[0], b[1], b[2], b[3]); }
    x.fillStyle = goldSoft;
    for (const b of roofs) {
      for (let wy = b[1] + 16; wy < 1168; wy += 22) {
        for (let wx = b[0] + 8; wx < b[0] + b[2] - 8; wx += 16) {
          x.fillRect(wx, wy, 6, 8);
        }
      }
    }
    x.strokeStyle = gold;
    x.lineWidth = 22;
    x.strokeRect(24, 24, 1032, 1302);
    x.strokeStyle = ink;
    x.lineWidth = 5;
    x.strokeRect(48, 48, 984, 1254);
    x.fillStyle = ink;
    rr(78, 78, 924, 168, 28);
    x.fill();
    x.textAlign = 'left';
    x.font = '700 84px "Aeonik Pro", sans-serif';
    const leftWord = 'KOLO';
    const rightWord = 'POLY';
    const lw = x.measureText(leftWord).width;
    const rw = x.measureText(rightWord).width;
    const wx0 = 540 - (lw + rw) / 2;
    x.fillStyle = cream;
    x.fillText(leftWord, wx0, 168);
    x.fillStyle = goldSoft;
    x.fillText(rightWord, wx0 + lw, 168);
    x.textAlign = 'center';
    x.font = '700 26px Figtree, sans-serif';
    x.fillStyle = gold;
    const titles = { jackpot: 'OWAMBE JACKPOT', landlord: 'LANDLORD DON LAND', kirikiri: 'KIRIKIRI GUEST', final: 'THE FINAL TABLE', phase: 'INFLATION DON LAND' };
    x.fillText(titles[kind] || 'KOLOPOLY', 540, 214);
    if (kind === 'final' && data.rows) {
      x.font = '700 30px Figtree, sans-serif';
      const shout = 'Landlord don land';
      const bw = Math.min(720, x.measureText(shout).width + 72);
      rr(540 - bw / 2, 268, bw, 64, 32);
      x.fillStyle = paper;
      x.fill();
      x.lineWidth = 4;
      x.strokeStyle = ink;
      x.stroke();
      x.beginPath();
      x.moveTo(500, 332);
      x.lineTo(540, 358);
      x.lineTo(548, 332);
      x.closePath();
      x.fillStyle = paper;
      x.fill();
      x.stroke();
      x.fillStyle = ink;
      x.fillText(shout, 540, 310);
      let y = 390;
      const rows = data.rows.slice(0, 6);
      rows.forEach((r, i) => {
        const h = 118;
        rr(96, y, 888, h, 22);
        x.fillStyle = i === 0 ? '#fff1c2' : paper;
        x.fill();
        x.lineWidth = i === 0 ? 6 : 3;
        x.strokeStyle = i === 0 ? gold : '#e3d7c3';
        x.stroke();
        x.beginPath();
        x.arc(168, y + h / 2, 30, 0, Math.PI * 2);
        x.fillStyle = i === 0 ? gold : ink;
        x.fill();
        x.fillStyle = i === 0 ? ink : goldSoft;
        x.font = '700 28px "Aeonik Pro", sans-serif';
        x.textAlign = 'center';
        x.fillText(String(i + 1), 168, y + h / 2 + 10);
        if (i === 0) {
          x.strokeStyle = gold;
          x.lineWidth = 3;
          x.beginPath();
          x.moveTo(148, y + 28);
          x.lineTo(158, y + 14);
          x.lineTo(168, y + 26);
          x.lineTo(178, y + 12);
          x.lineTo(188, y + 28);
          x.stroke();
        }
        x.textAlign = 'left';
        x.fillStyle = ink;
        x.font = '700 36px "Aeonik Pro", sans-serif';
        const name = r.name || '';
        x.fillText(name, 214, y + 48);
        if (r.bot) {
          const nw = x.measureText(name).width;
          x.font = '800 16px Figtree, sans-serif';
          const tag = 'BOT';
          const tw = x.measureText(tag).width + 18;
          const tx = Math.min(214 + nw + 12, 700);
          rr(tx, y + 26, tw, 26, 13);
          x.fillStyle = ink;
          x.fill();
          x.fillStyle = goldSoft;
          x.textAlign = 'center';
          x.fillText(tag, tx + tw / 2, y + 44);
          x.textAlign = 'left';
        }
        x.font = '600 22px Figtree, sans-serif';
        x.fillStyle = '#5c4c3d';
        x.fillText(r.title || '', 214, y + 86);
        x.textAlign = 'right';
        x.fillStyle = ink;
        x.font = '700 32px "Aeonik Pro", sans-serif';
        x.fillText(D.fmtN(r.netWorth), 950, y + 68);
        y += h + 14;
      });
      if (data.deal && y < 1120) {
        x.textAlign = 'center';
        x.font = '700 26px Figtree, sans-serif';
        x.fillStyle = '#0f7a50';
        wrapText(x, 'Deal of the Game: ' + data.deal, 540, Math.min(y + 20, 1140), 860, 34);
      }
    } else {
      rr(120, 300, 840, 760, 36);
      x.fillStyle = 'rgba(255, 250, 240, 0.92)';
      x.fill();
      x.lineWidth = 5;
      x.strokeStyle = ink;
      x.stroke();
      x.fillStyle = ink;
      x.textAlign = 'center';
      x.font = '700 64px "Aeonik Pro", sans-serif';
      wrapText(x, data.name || '', 540, 420, 760, 74);
      if (data.amount != null) {
        x.font = '700 108px "Aeonik Pro", sans-serif';
        x.fillStyle = kind === 'kirikiri' ? '#b02e2e' : '#0f7a50';
        x.fillText(D.fmtN(data.amount), 540, 640);
      }
      x.fillStyle = ink;
      x.font = '600 36px Figtree, sans-serif';
      wrapText(x, data.line || '', 540, data.amount != null ? 740 : 620, 760, 48);
    }
    x.fillStyle = ink;
    x.fillRect(78, 1184, 924, 96);
    x.fillStyle = cream;
    x.font = '700 28px Figtree, sans-serif';
    x.textAlign = 'center';
    x.fillText('Room ' + (data.code || '····') + '  ·  Play KOLOPOLY with your people', 540, 1242);
    return cv;
  }
};
function wrapText(x, text, cx, y, maxW, lh) {
  const words = String(text).split(' ');
  let line = '', yy = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (x.measureText(test).width > maxW && line) { x.fillText(line, cx, yy); line = w; yy += lh; }
    else line = test;
  }
  if (line) x.fillText(line, cx, yy);
  return yy;
}
window.KPBoard = KPBoard;
window.addEventListener('resize', () => {
  KPBoard.fitLayout();
  if (KPBoard.lastState) {
    KPBoard.applyCamera(KPBoard.lastState);
    KPBoard.renderTokens(KPBoard.lastState);
  }
});
