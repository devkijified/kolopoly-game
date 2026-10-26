'use strict';
// KOLOPOLY board renderer. Builds the 40 space grid from KP_DATA, animates
// token hops, drives the follow camera, fills deed sheets and draws the
// portrait share cards on canvas. No game rules live here beyond display
// mirrors of the server checks (the server validates everything).
const D = window.KP_DATA;

const COLW = [1.6, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.6];
const TOTALW = COLW.reduce((a, b) => a + b, 0);
function gridPos(i) {
  if (i <= 10) return { row: 11, col: 11 - i };
  if (i <= 20) return { row: 21 - i, col: 1 };
  if (i <= 30) return { row: 1, col: i - 19 };
  return { row: i - 29, col: 11 };
}
function spaceCenter(i) {
  const { row, col } = gridPos(i);
  let px = 0; for (let c = 1; c < col; c++) px += COLW[c - 1];
  let py = 0; for (let r = 1; r < row; r++) py += COLW[r - 1];
  return { x: (px + COLW[col - 1] / 2) / TOTALW, y: (py + COLW[row - 1] / 2) / TOTALW };
}
const TOKEN_SLOTS = [[-0.021, -0.021], [0.021, -0.021], [-0.021, 0.021], [0.021, 0.021], [0, -0.033], [0, 0.033]];

const KPBoard = {
  els: [],
  center: null,
  tokenEls: {},
  displayedPos: {},
  animating: false,
  fullBoard: false,
  focusSpace: 0,
  onSpaceTap: null,
  lastState: null,

  build(boardEl) {
    boardEl.innerHTML = '';
    this.els = [];
    for (let i = 0; i < 40; i++) {
      const sp = D.SPACES[i];
      const { row, col } = gridPos(i);
      const el = document.createElement('div');
      el.className = 'bspace' + ((row === 1 || row === 11) && (col === 1 || col === 11) ? ' corner' : '');
      el.style.gridRow = row;
      el.style.gridColumn = col;
      el.dataset.space = i;
      const bandColor = sp.type === 'street' ? D.GROUPS[sp.group].color
        : sp.type === 'station' ? '#3d3d3d' : sp.type === 'utility' ? '#3f7fbf'
        : i === 0 ? '#e8a90c' : i === 20 ? '#e8a90c' : i === 10 || i === 30 ? '#8c2f2f'
        : sp.type === 'card' ? (sp.deck === 'wahala' ? '#d64545' : '#3f7fbf') : '#b8a888';
      el.innerHTML =
        '<div class="band" style="background:' + bandColor + '"></div>' +
        '<div class="nm">' + (sp.short || sp.name) + '</div>' +
        '<div class="pips"></div>' +
        (i === 20 ? '<div class="potamt"></div>' : '') +
        '<div class="pr">' + (sp.price ? D.fmtN(sp.price) : sp.type === 'tax' ? D.fmtN(sp.amount) : '') + '</div>' +
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
      '<div class="logo">KOLOPOLY</div>' +
      '<div class="meta" id="centerPhase"></div>' +
      '<div class="pot" id="centerPot">Pot ₦0</div>' +
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
        el.classList.toggle('mortgaged', !!pr.m);
        if (pr.b >= 5) pips.innerHTML = '<i class="mansion"></i>';
        else if (pr.b > 0) pips.innerHTML = '<i></i>'.repeat(pr.b);
        else pips.innerHTML = '';
        let tag = el.querySelector('.pledgetag');
        if (pr.pl) {
          if (!tag) { tag = document.createElement('div'); tag.className = 'pledgetag'; tag.textContent = 'PLEDGED'; el.appendChild(tag); }
        } else if (tag) tag.remove();
      } else {
        ownbar.style.background = 'transparent';
        el.classList.remove('mortgaged');
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
    const centerDice = document.getElementById('centerDice');
    if (centerDice) centerDice.innerHTML = state.dice ? this.dieHTML(state.dice[0]) + this.dieHTML(state.dice[1]) : '';
    const centerSupply = document.getElementById('centerSupply');
    if (centerSupply) centerSupply.textContent = 'Bank supply: ' + state.duplexSupply + ' duplexes, ' + state.mansionSupply + ' mansions';
    const centerPhase = document.getElementById('centerPhase');
    if (centerPhase) {
      centerPhase.textContent = state.inf
        ? 'Phase ' + state.inf.phase + ': ' + state.inf.phaseName + ' · Index ' + state.inf.index + 'x · Pure water ₦' + [5, 10, 20, 50][state.inf.phase - 1] + ' · Salary ' + D.fmtN(state.inf.salary)
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
      el.style.background = p.color;
      el.innerHTML = window.icon(p.token, 13);
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
    // Teleports (Kirikiri) jump; normal moves hop space by space.
    const el = this.tokenEls[p.id];
    const fwd = (to - from + 40) % 40;
    if (p.inJail || fwd > 12 || fwd === 0) {
      this.displayedPos[p.id] = to;
      this.placeToken(el, p, to, slotCount);
      this.focusSpace = to;
      this.applyCamera(state);
      return;
    }
    this.animating = true;
    let cur = from;
    const step = () => {
      if (!this.lastState || this.lastState !== state && this.displayedPos[p.id] === to) { this.animating = false; return; }
      cur = (cur + 1) % 40;
      this.displayedPos[p.id] = cur;
      this.placeToken(el, p, cur, slotCount);
      this.focusSpace = cur;
      this.applyCamera(state);
      if (cur !== to) setTimeout(step, 230);
      else { this.animating = false; if (this.lastState) this.renderTokens(this.lastState); }
    };
    setTimeout(step, 60);
  },

  applyCamera(state) {
    const board = document.getElementById('board');
    const wrap = document.getElementById('boardWrap');
    if (!board || !wrap) return;
    const size = wrap.clientWidth;
    if (!size) return;
    if (this.fullBoard || !state || state.status !== 'playing') {
      board.style.transform = 'scale(1)';
      return;
    }
    const focusPlayer = state.players.find((p) => p.id === state.turnPlayerId);
    const focus = this.animating ? this.focusSpace : (focusPlayer ? focusPlayer.position : this.focusSpace);
    const c = spaceCenter(focus);
    const k = 2.15;
    let tx = size / 2 - c.x * size * k;
    let ty = size / 2 - c.y * size * k;
    tx = Math.max(size - size * k, Math.min(0, tx));
    ty = Math.max(size - size * k, Math.min(0, ty));
    board.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + k + ')';
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

  deedHTML(i, state, viewerId) {
    const sp = D.SPACES[i];
    const byId = {};
    for (const p of state.players) byId[p.id] = p;
    const esc = window.KPesc || ((s) => String(s));
    if (!sp.price) {
      let body = '';
      if (sp.type === 'start') body = 'Pass START and salary alert enter your account. Classic pays ' + D.fmtN(D.START_PAY) + (state.inf ? '; this room dey Phase ' + state.inf.phase + ', so salary na ' + D.fmtN(state.inf.salary) : '') + '.';
      else if (sp.type === 'jail') body = 'Kirikiri. Just visiting no wahala. If you dey inside: pay bail ' + D.fmtN(D.JAIL_FINE) + ', flash a Get Out card, or roll a double within 3 turns.';
      else if (sp.type === 'gotojail') body = 'Land here and officers bundle you straight to Kirikiri. No salary for the trip.';
      else if (sp.type === 'freeparking') body = 'Owambe Grounds. The pot holds ' + D.fmtN(state.pot) + ' right now. Land here and you collect everything. The pot only grows from taxes, fines and fees, never from rent.';
      else if (sp.type === 'tax') body = 'Tax space. Landing here costs ' + D.fmtN(sp.amount) + (i === 4 ? ' flat, or 10 percent of your total worth, your choice' : '') + '. The money enters the Owambe pot.';
      else if (sp.type === 'card') body = 'Draw a ' + (sp.deck === 'wahala' ? 'WAHALA' : 'FAMILY MEETING') + ' card and do wetin e talk.';
      return '<div class="grab"></div><h3 class="title">' + esc(sp.name) + '</h3>' +
        (sp.meaning ? '<div class="meaning">' + esc(sp.meaning) + '</div>' : '') +
        '<p class="lead" style="margin-top:10px;">' + body + '</p>' +
        '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>';
    }
    const pr = state.props[i];
    const owner = pr && pr.o != null ? byId[pr.o] : null;
    const band = sp.type === 'street' ? D.GROUPS[sp.group].color : sp.type === 'station' ? '#3d3d3d' : '#3f7fbf';
    let html = '<div class="grab"></div><div class="deed-band" style="background:' + band + '"></div>';
    html += '<h3 class="title">' + esc(sp.name) + '</h3>';
    html += '<p class="caption">' + (sp.type === 'street' ? D.GROUPS[sp.group].name + ' set' : sp.type === 'station' ? 'Station' : 'Utility') +
      (owner ? ' · Owner: <b>' + esc(owner.name) + '</b>' : ' · Unowned, bank dey hold am') +
      (pr && pr.m ? ' · <b>MORTGAGED</b>' : '') + (pr && pr.pl ? ' · <b>PLEDGED as loan security</b>' : '') +
      (pr && pr.b ? ' · ' + (pr.b >= 5 ? 'Mansion built' : pr.b + ' duplex(es) built') : '') + '</p>';
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
        '</div><p class="caption mt8">Manage actions work on your turn, or while you dey raise money for a debt. The server enforces even building, full sets and pledges.</p>';
    }
    html += '<div class="btnrow"><button class="btn ghost" data-close="1">Close</button></div>';
    return html;
  },

  drawShareCard(kind, data) {
    const cv = document.createElement('canvas');
    cv.width = 1080; cv.height = 1350;
    const x = cv.getContext('2d');
    x.fillStyle = '#f5efe2'; x.fillRect(0, 0, 1080, 1350);
    x.strokeStyle = '#e8a90c'; x.lineWidth = 14; x.strokeRect(28, 28, 1024, 1294);
    x.strokeStyle = '#2b2018'; x.lineWidth = 3; x.strokeRect(52, 52, 976, 1246);
    x.textAlign = 'center';
    x.fillStyle = '#2b2018';
    x.font = '700 96px "Aeonik Pro", sans-serif';
    x.fillText('KOLOPOLY', 540, 170);
    x.font = '700 30px "Figtree", sans-serif';
    x.fillStyle = '#e8a90c';
    const titles = { jackpot: 'OWAMBE JACKPOT', landlord: 'LANDLORD DON LAND', kirikiri: 'KIRIKIRI GUEST', final: 'THE FINAL TABLE', phase: 'INFLATION DON LAND' };
    x.fillText(titles[kind] || 'KOLOPOLY', 540, 250);
    x.fillStyle = '#2b2018';
    if (kind === 'final' && data.rows) {
      let y = 380;
      x.font = '700 44px "Aeonik Pro", sans-serif';
      for (const r of data.rows.slice(0, 6)) {
        x.textAlign = 'left';
        x.fillText((r.crown ? '♛ ' : '') + r.name, 110, y);
        x.textAlign = 'right';
        x.fillText(D.fmtN(r.netWorth), 970, y);
        x.font = '600 30px "Figtree", sans-serif';
        x.fillStyle = '#5c4c3d';
        x.textAlign = 'left';
        x.fillText(r.title, 110, y + 42);
        x.fillStyle = '#2b2018';
        x.font = '700 44px "Aeonik Pro", sans-serif';
        y += 108;
      }
      x.textAlign = 'center';
      if (data.deal) {
        x.font = '600 32px "Figtree", sans-serif';
        x.fillStyle = '#0f7a50';
        wrapText(x, 'Deal of the Game: ' + data.deal, 540, y + 30, 880, 42);
      }
    } else {
      x.font = '700 74px "Aeonik Pro", sans-serif';
      wrapText(x, data.name || '', 540, 430, 900, 84);
      if (data.amount != null) {
        x.font = '700 120px "Aeonik Pro", sans-serif';
        x.fillStyle = kind === 'kirikiri' ? '#b02e2e' : '#0f7a50';
        x.fillText(D.fmtN(data.amount), 540, 620);
        x.fillStyle = '#2b2018';
      }
      x.font = '600 40px "Figtree", sans-serif';
      wrapText(x, data.line || '', 540, data.amount != null ? 740 : 560, 880, 54);
    }
    x.font = '700 34px "Figtree", sans-serif';
    x.fillStyle = '#5c4c3d';
    x.fillText('Room ' + (data.code || '····') + ' · Play KOLOPOLY with your people', 540, 1240);
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
