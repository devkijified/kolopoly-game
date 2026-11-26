'use strict';
var state = { me: null, config: { housePercent: 10, payments: false }, flash: '' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function naira(kobo) {
  var n = Math.abs(Number(kobo) || 0) / 100;
  var digits = Number.isInteger(n) ? 0 : 2;
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: digits, maximumFractionDigits: 2 });
}
function when(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}
function pretty(code) {
  var c = String(code || '');
  return c.slice(0, 4) + ' ' + c.slice(4);
}
function api(path, opts) {
  opts = opts || {};
  return fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).then(function (res) {
    return res.json().catch(function () { return { ok: false }; }).then(function (data) {
      data.status = res.status;
      return data;
    });
  });
}
function go(href) {
  history.pushState({}, '', href);
  return load();
}
function flash(msg) { state.flash = msg || ''; }

function shell(inner) {
  var signed = state.me && state.me.name;
  var me = signed ? '<div class="who">Signed in as ' + esc(state.me.name) + '</div>' : '';
  var note = state.flash ? '<div class="flash" role="status">' + esc(state.flash) + '</div>' : '';
  var nav = signed
    ? '<a class="navlink" href="/mine" data-nav>Mine</a>'
    : '<a class="navlink" href="/signin" data-nav>Sign in</a>';
  return '<div class="wrap">' +
    '<header class="topbar"><a class="brand" href="/" data-nav><span class="mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M3 9.5 10 3l7 6.5V17a1 1 0 0 1-1 1h-4.2v-5H8.2V18H4a1 1 0 0 1-1-1V9.5z" fill="#1b140f"/></svg></span>ONILE</a>' +
    nav + '</header>' +
    note + me + inner + '</div>';
}
function signInCard(next) {
  return '<section class="card"><strong>Sign in first.</strong><p class="fine">A display name and your email. Same account as Kolopoly. No password.</p><div class="actions"><a class="btn" href="/signin?next=' + encodeURIComponent(next) + '" data-nav>Sign in</a></div></section>';
}
function moneyCard(c) {
  var held = c.heldKobo != null ? c.heldKobo : 0;
  var base = held > 0 ? held : c.potKobo;
  var pct = Number(c.housePercent) || 0;
  var prize = Math.floor(base * (100 - pct) / 100);
  var house = base - prize;
  return '<section class="money" aria-label="Pot">' +
    '<div><span class="muted">Stake each</span><b>' + naira(c.stakeKobo) + '</b></div>' +
    '<div><span class="muted">Pot held</span><b>' + naira(held > 0 ? held : c.potKobo) + '</b></div>' +
    '<div><span class="muted">Winner receives</span><b>' + naira(prize) + '</b></div>' +
    '<div><span class="muted">House keeps ' + esc(c.housePercent) + '%</span><b>' + naira(house) + '</b></div>' +
    '</section>';
}
function people(c) {
  var rows = (c.players || []).map(function (person, i) {
    var chip = person.paid ? '<span class="chip ok">Paid</span>' : '<span class="chip wait">Not paid</span>';
    var label = i === 0 ? 'Opened it' : 'Player';
    return '<div class="person"><div><span class="muted">' + label + '</span><strong>' + esc(person.name) + '</strong></div>' + chip + '</div>';
  });
  var openSeats = Math.max(0, (c.maxPlayers || 2) - rows.length);
  for (var n = 0; n < openSeats; n++) {
    rows.push('<div class="person"><div><span class="muted">Open seat</span><strong>Waiting</strong></div><span class="chip wait">Not yet</span></div>');
  }
  return '<div class="stack">' + rows.join('') + '</div>';
}
function statusBanner(c) {
  var map = {
    open: ['Waiting', 'Share the code. Onile holds each stake. The creator can start once two players have paid.'],
    joined: ['Lobby', 'Same stake for every seat. Unpaid seats are dropped when it starts.'],
    held: ['Funds held', 'Go and play. Come back and name the winner. We do not release the pot early.'],
    reported: ['Funds held', 'Your report is in. The pot stays here until the other player reports.'],
    agreed: ['Agreed', (c.winnerName || 'The winner') + ' is paid ' + naira(c.prizeKobo) + '. The house keeps ' + naira(c.houseKobo) + '.'],
    disputed: ['With the house', c.disputeReason === 'timeout' ? 'The deadline passed without an agreement. The house will decide.' : 'You named different winners. The house will decide.'],
    resolved: ['Split', 'Each payment goes back to the person who paid it.'],
    refunded: ['Sent back', 'The pot was not completed, so the money goes back.'],
    expired: ['Closed', 'Nobody paid before the deadline.']
  };
  var pair = map[c.status] || ['Onile', ''];
  if (c.status === 'open' && c.you !== 'creator') pair = ['Open', 'Join in, then pay your part. Onile holds the pot until you both agree.'];
  var tone = c.status === 'agreed' || c.status === 'resolved' || c.status === 'refunded' ? 'good' : (c.status === 'disputed' ? 'bad' : 'held');
  return '<section class="banner ' + tone + '"><p class="kicker">Challenge</p><h2>' + esc(pair[0]) + '</h2><p>' + esc(pair[1]) + '</p></section>';
}

function viewHome() {
  var cut = state.config.housePercent != null ? state.config.housePercent : 10;
  return shell(
    '<h1 class="display">We hold the money. Nobody runs.</h1>' +
    '<p class="lede">Open a challenge with one other person. You each pay the same amount. Onile holds the pot until you agree who won.</p>' +
    '<div class="stamp">Funds held</div>' +
    '<div class="actions"><a class="btn" href="/new" data-nav>Open a challenge</a><a class="btn secondary" href="/join" data-nav>I have a code</a></div>' +
    '<div class="stack">' +
      '<article class="step"><div class="num">1</div><div><strong>Share a code</strong><span>Title, activity, amount, and the rules if you want them.</span></div></article>' +
      '<article class="step"><div class="num">2</div><div><strong>Both of you pay</strong><span>Paystack takes the payment. Onile holds it. Neither of you can pull it back mid-game.</span></div></article>' +
      '<article class="step"><div class="num">3</div><div><strong>Name the winner</strong><span>If you agree, the winner is paid, minus the house ' + esc(cut) + '%. If you do not, the house decides.</span></div></article>' +
    '</div>' +
    '<p class="fine">If the other person never joins or pays, your money is sent back. A sister of Kolopoly. The board game is a different service.</p>'
  );
}

function viewCreate() {
  if (!state.me || !state.me.name) {
    return shell('<p class="kicker">New challenge</p><h1 class="display">Open it.</h1><div class="stack">' + signInCard('/new') + '</div>');
  }
  return shell(
    '<p class="kicker">New challenge</p><h1 class="display">Open it.</h1>' +
    '<form class="card" data-act="create" style="margin-top:14px">' +
      '<label for="title">Title</label><input id="title" name="title" required maxlength="80" placeholder="Friday at Tobi\'s">' +
      '<label for="activity">Game or activity</label><input id="activity" name="activity" required maxlength="60" placeholder="FIFA, chess, a race">' +
      '<label for="seats">Players</label><select id="seats" name="maxPlayers"><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8</option></select>' +
      '<label for="amount">Stake each (₦)</label><input id="amount" name="stakeNaira" inputmode="numeric" required placeholder="5000">' +
      '<label for="rules">Rules, optional</label><textarea id="rules" name="rules" maxlength="500" placeholder="Best of three. Extra time counts."></textarea>' +
      '<label for="deadline">Deadline, optional</label><input id="deadline" name="deadline" type="datetime-local">' +
      '<div class="actions"><button type="submit">Create and get a code</button></div>' +
    '</form>'
  );
}

function viewJoin() {
  if (!state.me || !state.me.name) {
    return shell('<p class="kicker">Join</p><h1 class="display">Enter the code.</h1><div class="stack">' + signInCard('/join') + '</div>');
  }
  return shell(
    '<p class="kicker">Join</p><h1 class="display">Enter the code.</h1>' +
    '<form class="card" data-act="join" style="margin-top:14px">' +
      '<label for="code">Challenge code</label><input id="code" name="code" required maxlength="16" autocapitalize="characters" placeholder="ABCD 2345">' +
      '<div class="actions"><button type="submit">Find the challenge</button></div>' +
    '</form>'
  );
}

function payoutBlock(c) {
  if (c.status !== 'agreed' || c.you == null) return '';
  var youWon = !!(state.me && c.winnerId && state.me.id === c.winnerId);
  if (!youWon) return '<p class="fine">The winner is paid to the bank account they saved. The house sends it once.</p>';
  var p = c.payout;
  var line = 'The house sends ' + naira(c.prizeKobo) + ' to your bank. It is sent once.';
  if (p) {
    var labels = {
      'awaiting-bank': 'Add the account that should receive it. The payout stays queued.',
      ready: 'Queued. The house sends it from the desk.',
      sending: 'On the way to your bank.',
      paid: 'Paid to your bank.',
      'paid-manual': 'Paid by hand.',
      otp: 'Paystack still needs a confirmation on the house account.',
      failed: 'The send did not land. The house can try the same payout again. It will not create a second one.',
      review: 'The house is checking this before it is sent.',
      claimed: 'Claimed — house sends it to your bank soon'
    };
    if (p.claimed || p.status === 'claimed') line = labels.claimed;
    else if (p.houseHold) line = 'Queued — house sends it soon';
    else line = labels[p.status] || line;
  }
  var bank = c.bank ? '<p class="fine">Saved account: ' + esc(c.bank.bankName) + ' · ' + esc(c.bank.accountName) + ' · ••••' + esc(c.bank.last4) + '</p>' : '';
  var form = '';
  if (!c.bank || (p && p.status === 'awaiting-bank')) {
    form = '<form data-act="bank"><label for="bankCode">Bank</label><select id="bankCode" name="bankCode" required><option value="">Loading banks…</option></select>' +
      '<label for="accountNumber">Account number</label><input id="accountNumber" name="accountNumber" inputmode="numeric" maxlength="10" required placeholder="10 digits">' +
      '<div class="actions"><button type="submit" class="green">Save this account</button></div></form>';
  } else if (p && !p.claimed && p.status !== 'claimed' && (p.status === 'ready' || p.status === 'failed')) {
    form = '<form data-act="collect" data-code="' + esc(c.code || '') + '"><div class="actions"><button type="submit" class="green">Collect</button></div></form>';
  }
  return '<section class="card"><strong>Your payout</strong><p class="fine">' + esc(line) + '</p>' + bank + form + '</section>';
}

function reportBlock(c) {
  if (!c.you || (c.status !== 'held' && c.status !== 'reported')) return '';
  if (c.yourReport) {
    var said = (c.players || []).filter(function (p) { return p.id === c.yourReport; })[0];
    return '<section class="card"><strong>You said ' + esc(said ? said.name : 'someone') + ' won.</strong><p class="fine">Waiting for every paid player. The pot does not move until the reports match.</p></section>';
  }
  var buttons = (c.players || []).filter(function (p) { return p.paid; }).map(function (p, i) {
    return '<button type="submit" name="winnerId" value="' + esc(p.id) + '"' + (i === 0 ? ' class="green"' : '') + '>' + esc(p.name) + ' won</button>';
  }).join('');
  return '<form data-act="report"><p class="kicker">Name the winner</p><div class="actions">' + buttons + '</div></form>';
}

function lobbyActions(c) {
  if (c.status !== 'open' && c.status !== 'joined') return '';
  if (c.you !== 'creator') return '';
  var start = c.canStart ? '<form data-act="start"><div class="actions"><button type="submit" class="green">Start</button></div><p class="fine">Unpaid seats are dropped. The pot stays held until everyone names the same winner.</p></form>' : '<p class="fine">Start opens once two players have paid.</p>';
  return start + '<form data-act="cancel"><div class="actions"><button type="submit" class="secondary">Cancel challenge</button></div></form>';
}
function payBlock(c) {
  if (!c.you) return '';
  var mine = (c.players || []).filter(function (p) { return p.isYou; })[0];
  if (!mine || mine.paid) return '';
  if (c.status !== 'open' && c.status !== 'joined') return '';
  return '<form data-act="pay"><div class="actions"><button type="submit">Pay ' + naira(c.stakeKobo) + ' with Paystack</button></div>' +
    '<p class="fine">You leave this page for Paystack. Onile holds the money only after Paystack confirms the same amount.</p></form>';
}

function joinBlock(c) {
  if (c.you || c.status !== 'open') return '';
  if (!state.me || !state.me.name) return signInCard('/c/' + c.code);
  return '<form class="card" data-act="join-here"><p class="fine">Joining as ' + esc(state.me.name) + '.</p><div class="actions"><button type="submit">Join this challenge</button></div></form>';
}

function statements(c) {
  if (!c.statements || !c.statements.length) return '';
  return '<section class="card"><strong>Reports</strong>' + c.statements.map(function (s) {
    return '<p class="fine">' + esc(s.name) + ' said ' + esc(s.winner) + ' won.</p>';
  }).join('') + '</section>';
}

function viewChallenge(code, c) {
  if (!c) return shell('<h1 class="display">That code is not a challenge.</h1><div class="actions"><a class="btn" href="/join" data-nav>Try another code</a></div>');
  var rules = c.rules ? '<p class="fine"><strong>Rules.</strong> ' + esc(c.rules) + '</p>' : '';
  var due = c.reportBy ? 'Report by ' + when(c.reportBy) : 'Join and pay by ' + when(c.joinBy);
  var share = '<section class="card"><p class="kicker">Code</p><div class="code">' + esc(pretty(c.code)) + '</div>' +
    '<button type="button" data-act="copy" data-code="' + esc(c.code) + '">Copy link</button></section>';
  return shell(
    '<p class="kicker">' + esc(c.activity) + '</p><h1 class="display">' + esc(c.title) + '</h1>' +
    '<p class="fine">' + esc(due) + '</p>' +
    '<div class="stack">' + statusBanner(c) + moneyCard(c) + people(c) + joinBlock(c) + payBlock(c) + lobbyActions(c) + reportBlock(c) + payoutBlock(c) + share + rules + statements(c) + '</div>'
  );
}

function viewMine(rows) {
  var list = (rows || []).map(function (c) {
    var labels = { open: 'Open', joined: 'Needs payment', held: 'Funds held', reported: 'Needs a report', agreed: 'Agreed', disputed: 'Dispute', resolved: 'Split', refunded: 'Sent back', expired: 'Closed' };
    return '<a class="card challenge-link" href="/c/' + esc(c.code) + '" data-nav><b>' + esc(c.title) + '</b><span class="fine">' + esc(c.activity) + ' · ' + naira(c.stakeKobo) + ' each</span><div style="margin-top:8px"><span class="chip">' + esc(labels[c.status] || c.status) + '</span></div></a>';
  }).join('');
  var body = list || '<section class="card"><strong>Nothing here yet.</strong><p class="fine">Open a challenge and send the code.</p></section>';
  var who = state.me && state.me.name ? '' : signInCard('/mine');
  return shell('<p class="kicker">Yours</p><h1 class="display">My challenges</h1><div class="stack">' + who + '</div><div class="list">' + (state.me && state.me.name ? body : '') + '</div>');
}
function nextPath() {
  var n = new URLSearchParams(location.search).get('next') || '/mine';
  if (n.charAt(0) !== '/' || n.indexOf('//') === 0) return '/mine';
  return n;
}
function viewSignin() {
  if (state.me && state.me.name && !state.codeSent) {
    return shell('<p class="kicker">Account</p><h1 class="display">You are in.</h1><p class="lede">Signed in as ' + esc(state.me.name) + '.</p><div class="actions"><a class="btn" href="' + esc(nextPath()) + '" data-nav>Continue</a></div>');
  }
  var pending = state.pending || { name: '', email: '' };
  var codeForm = state.codeSent
    ? '<form class="card" data-act="verify-code" style="margin-top:12px"><label for="signin-code">Sign-in code</label><input id="signin-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="6 digit code"><div class="actions"><button type="submit" class="green">Sign in</button></div></form>'
    : '';
  return shell(
    '<p class="kicker">Account</p><h1 class="display">Sign in.</h1>' +
    '<p class="lede">A display name and your email. It is the same account as Kolopoly. No password: we send a 6 digit code.</p>' +
    '<form class="card" data-act="send-code" style="margin-top:14px">' +
      '<label for="display-name">Display name</label><input id="display-name" name="name" required maxlength="40" autocomplete="nickname" value="' + esc(pending.name) + '">' +
      '<label for="email">Email</label><input id="email" name="email" type="email" required maxlength="120" autocomplete="email" value="' + esc(pending.email) + '">' +
      '<div class="actions"><button type="submit">Send code</button></div>' +
    '</form>' + codeForm
  );
}

var desk = { tab: 'open', code: null, confirm: null };
var DESK_TABS = [
  ['open', 'Open'], ['live', 'Live'], ['disputes', 'Disputes'], ['settled', 'Settled'],
  ['payouts', 'Payouts'], ['payments', 'Payments'], ['users', 'Users']
];
var STATUS_LABEL = {
  open: 'Open', joined: 'Waiting', held: 'Live', reported: 'Reports in', disputed: 'Dispute',
  agreed: 'Settled', resolved: 'Settled', refunded: 'Refunded', cancelled: 'Cancelled', expired: 'Closed'
};
function lagos(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}
function seatLine(players) {
  return (players || []).map(function (p) { return esc(p.name) + (p.paid ? ' paid' : ' unpaid'); }).join(' · ');
}
function challengeCard(c) {
  return '<button type="button" class="desk-card" data-act="open-detail" data-code="' + esc(c.code) + '">' +
    '<span class="desk-card-top"><strong>' + esc(c.code) + '</strong><span class="chip">' + esc(STATUS_LABEL[c.status] || c.status) + '</span></span>' +
    '<b>' + esc(c.title) + '</b>' +
    '<span class="fine">Stake ' + naira(c.stakeKobo) + ' · Pot held ' + naira(c.heldNowKobo || 0) + '</span>' +
    '<span class="fine">' + (seatLine(c.players) || 'No seats yet') + '</span>' +
    '<span class="fine">' + esc(lagos(c.createdAt)) + ' Lagos</span></button>';
}
function detailSheet(data, c) {
  if (!c) return '';
  var timeline = (c.timeline || []).map(function (item) {
    var ref = item.ref ? '<br>Paystack ' + esc(item.ref) : '';
    var money = item.amountKobo ? ' · ' + naira(item.amountKobo) : '';
    return '<li><strong>' + esc(item.kind) + '</strong><span>' + esc(item.text || '') + money + ref + '</span><em>' + esc(lagos(item.at)) + '</em></li>';
  }).join('');
  var said = (c.statements || []).map(function (s) {
    return '<p class="fine">' + esc(s.name) + ' said ' + esc(s.winner) + ' won.</p>';
  }).join('');
  var actions = ['<button type="button" data-act="copy" data-code="' + esc(c.code) + '">Copy challenge link</button>'];
  if (c.bucket === 'open') actions.push('<button type="button" class="red" data-act="ask" data-kind="cancel" data-code="' + esc(c.code) + '">Cancel and refund</button>');
  if (c.bucket === 'live' || c.bucket === 'disputes') {
    (c.players || []).filter(function (p) { return p.paid; }).forEach(function (p) {
      actions.push('<button type="button" class="green" data-act="ask" data-kind="winner" data-code="' + esc(c.code) + '" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Pay ' + esc(p.name) + '</button>');
    });
  }
  if (c.bucket === 'disputes') actions.push('<button type="button" class="red" data-act="ask" data-kind="refund" data-code="' + esc(c.code) + '">Refund everyone</button>');
  (data.payouts || []).filter(function (p) { return p.roomCode === c.code; }).forEach(function (p) {
    var done = /^(paid|paid-manual|refunded|refunded-manual)$/.test(p.status);
    if (!done) actions.push('<button type="button" data-act="ask" data-kind="manual" data-id="' + esc(p.id) + '">Mark payout paid</button>');
  });
  return '<div class="sheet-back" data-act="close-sheet"></div><section class="sheet" role="dialog" aria-label="Challenge detail">' +
    '<div class="desk-card-top"><strong>' + esc(c.code) + '</strong><button type="button" class="secondary sheet-close" data-act="close-sheet">Close</button></div>' +
    '<h2>' + esc(c.title) + '</h2><p class="fine">' + esc(c.activity) + ' · ' + esc(STATUS_LABEL[c.status] || c.status) + '</p>' +
    said + '<ol class="timeline">' + (timeline || '<li><span>No events yet.</span></li>') + '</ol><div class="actions">' + actions.join('') + '</div></section>';
}
function confirmBox() {
  var ask = desk.confirm;
  if (!ask) return '';
  return '<div class="confirm-back" data-act="confirm-no"></div><section class="confirm-card" role="alertdialog" aria-label="Confirm">' +
    '<h2>' + esc(ask.title) + '</h2><p>' + esc(ask.body) + '</p>' +
    '<div class="actions"><button type="button" class="red" data-act="confirm-yes">Confirm</button>' +
    '<button type="button" class="secondary" data-act="confirm-no">Go back</button></div></section>';
}
function viewAdmin(data) {
  if (!data) {
    return shell(
      '<div class="desk-head"><strong>HOUSE DESK</strong><p>Same key as the Kolopoly ops desk.</p></div>' +
      '<form class="card" data-act="unlock"><label for="token">Desk key</label><input id="token" name="token" type="password" autocomplete="current-password" required>' +
      '<div class="actions"><button type="submit">Open the desk</button></div></form>'
    );
  }
  var stats = data.stats || {};
  var tabs = DESK_TABS.map(function (pair) {
    return '<button type="button" class="desk-tab' + (desk.tab === pair[0] ? ' on' : '') + '" data-act="desk-tab" data-tab="' + pair[0] + '">' + pair[1] + '</button>';
  }).join('');
  var list = '';
  if (desk.tab === 'payouts') {
    list = (data.payouts || []).map(function (p) {
      var bank = p.bank ? esc(p.bank.bankName) + ' · ••••' + esc(p.bank.last4) : 'No bank yet';
      return '<article class="card"><strong>' + esc(p.kind) + ' · ' + naira(p.amountKobo) + '</strong>' +
        '<p class="fine">' + esc(p.roomCode) + ' · ' + esc(p.name || '') + ' · ' + esc(p.status) + '<br>' + bank + '</p>' +
        '<p class="fine">' + esc(lagos(p.createdAt || p.updatedAt)) + ' Lagos</p>' +
        '<div class="actions"><button type="button" data-act="ask" data-kind="manual" data-id="' + esc(p.id) + '">Mark payout paid</button></div></article>';
    }).join('') || '<section class="card">No payout rows.</section>';
  } else if (desk.tab === 'payments') {
    list = (data.payments || []).map(function (p) {
      return '<article class="card"><strong>' + esc(p.code || 'Payment') + ' · ' + naira(p.amountKobo) + '</strong>' +
        '<p class="fine">' + esc(p.status) + (p.email ? ' · ' + esc(p.email) : '') + '</p>' +
        '<p class="fine">Paystack ' + esc(p.reference) + '</p><p class="fine">' + esc(lagos(p.createdAt)) + ' Lagos</p></article>';
    }).join('') || '<section class="card">No payments yet.</section>';
  } else if (desk.tab === 'users') {
    list = (data.users || []).map(function (u) {
      return '<article class="card"><strong>' + esc(u.name) + '</strong><p class="fine">' + esc(u.email) + '</p>' +
        '<p class="fine">' + esc(u.challenges) + ' challenge' + (u.challenges === 1 ? '' : 's') + '</p></article>';
    }).join('') || '<section class="card">No players yet.</section>';
  } else {
    list = (data.challenges || []).filter(function (c) { return c.bucket === desk.tab; }).map(challengeCard).join('') ||
      '<section class="card">Nothing in this list.</section>';
  }
  var openRow = (data.challenges || []).filter(function (c) { return c.code === desk.code; })[0];
  return shell(
    '<div class="desk-head"><strong>HOUSE DESK</strong><p>Every challenge. Held funds refresh on their own.</p></div>' +
    '<div class="stats">' +
      '<div class="stat"><span>Open challenges</span><b>' + esc(stats.open || 0) + '</b></div>' +
      '<div class="stat"><span>Held in escrow</span><b>' + naira(stats.heldKobo || 0) + '</b></div>' +
      '<div class="stat"><span>Paid in today</span><b>' + naira(stats.paidTodayKobo || 0) + '</b></div>' +
      '<div class="stat"><span>Paid in, 7 days</span><b>' + naira(stats.paidWeekKobo || 0) + '</b></div>' +
      '<div class="stat"><span>Settled</span><b>' + esc(stats.settled || 0) + '</b></div>' +
      '<div class="stat"><span>Disputes waiting</span><b>' + esc(stats.disputes || 0) + '</b></div>' +
      '<div class="stat"><span>Payouts pending</span><b>' + esc(stats.payoutsPending || 0) + '</b></div>' +
      '<div class="stat"><span>Payouts paid</span><b>' + naira(stats.payoutsPaidKobo || 0) + '</b></div>' +
      '<div class="stat"><span>House cut earned</span><b>' + naira(stats.houseKobo || 0) + '</b></div>' +
      '<div class="stat"><span>Users</span><b>' + esc(stats.users || 0) + '</b></div>' +
    '</div><div class="desk-tabs">' + tabs + '</div><div class="list">' + list + '</div>' +
    '<div class="actions"><button type="button" class="ghost" data-act="lock">Lock the desk</button></div>' +
    detailSheet(data, openRow) + confirmBox()
  );
}

var page = { name: 'home', code: '', challenge: null, mine: [], admin: undefined };

function route() {
  var path = location.pathname.replace(/\/$/, '') || '/';
  if (path === '/') return { name: 'home' };
  if (path === '/new') return { name: 'new' };
  if (path === '/join') return { name: 'join' };
  if (path === '/mine') return { name: 'mine' };
  if (path === '/signin') return { name: 'signin' };
  if (path === '/admin') return { name: 'admin' };
  var m = path.match(/^\/c\/([A-Za-z0-9]+)$/);
  if (m) return { name: 'challenge', code: m[1].toUpperCase() };
  return { name: 'home' };
}

function draw() {
  var r = route();
  var html = '';
  if (r.name === 'home') html = viewHome();
  else if (r.name === 'new') html = viewCreate();
  else if (r.name === 'join') html = viewJoin();
  else if (r.name === 'mine') html = viewMine(page.mine);
  else if (r.name === 'signin') html = viewSignin();
  else if (r.name === 'admin') html = viewAdmin(page.admin);
  else html = viewChallenge(r.code, page.challenge);
  document.getElementById('app').innerHTML = html;
  var select = document.getElementById('bankCode');
  if (select) loadBanks(select);
}

function loadBanks(select) {
  api('/api/banks').then(function (data) {
    if (!data.ok) { select.innerHTML = '<option value="">Banks unavailable</option>'; return; }
    select.innerHTML = '<option value="">Pick a bank</option>' + data.banks.map(function (b) {
      return '<option value="' + esc(b.code) + '">' + esc(b.name) + '</option>';
    }).join('');
  });
}

function load() {
  var r = route();
  var jobs = [api('/api/me'), api('/api/config')];
  return Promise.all(jobs).then(function (pair) {
    state.me = pair[0].ok ? pair[0].player : null;
    state.config = pair[1].ok ? pair[1] : state.config;
    if (r.name === 'challenge') {
      return api('/api/challenges/' + r.code).then(function (data) {
        page.challenge = data.ok ? data.challenge : null;
        if (!data.ok) flash(data.message || 'No challenge with that code.');
      });
    }
    if (r.name === 'mine' && state.me) {
      return api('/api/challenges/mine').then(function (data) { page.mine = data.challenges || []; });
    }
    if (r.name === 'admin') {
      return api('/api/admin/queue').then(function (data) { page.admin = data.ok ? data : null; });
    }
  }).then(draw);
}

function formData(form) {
  var data = {};
  new FormData(form).forEach(function (value, key) { data[key] = String(value).trim(); });
  return data;
}

document.addEventListener('click', function (e) {
  var nav = e.target.closest('[data-nav]');
  if (nav) { e.preventDefault(); flash(''); go(nav.getAttribute('href')); return; }
  var copy = e.target.closest('[data-act="copy"]');
  if (copy) {
    var link = location.origin + '/c/' + copy.getAttribute('data-code');
    var done = function () { flash('Link copied.'); draw(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done).catch(function () { flash(link); draw(); });
    else { flash(link); draw(); }
    return;
  }
  var tab = e.target.closest('[data-act="desk-tab"]');
  if (tab) { desk.tab = tab.getAttribute('data-tab'); desk.confirm = null; draw(); return; }
  var opened = e.target.closest('[data-act="open-detail"]');
  if (opened) { desk.code = opened.getAttribute('data-code'); draw(); return; }
  if (e.target.closest('[data-act="close-sheet"]')) { desk.code = null; desk.confirm = null; draw(); return; }
  var ask = e.target.closest('[data-act="ask"]');
  if (ask) {
    var kind = ask.getAttribute('data-kind');
    var who = ask.getAttribute('data-name') || 'this player';
    var titles = { cancel: 'Cancel and refund?', winner: 'Pay ' + who + '?', refund: 'Refund everyone?', manual: 'Mark this payout paid?' };
    var bodies = {
      cancel: 'Anyone who already paid is refunded. This cannot be taken back from the desk.',
      winner: who + ' receives the pot minus the house cut. It is queued once.',
      refund: 'Every paid stake goes back. No winner is paid.',
      manual: 'Record that this payout was sent by hand. It will not be sent again.'
    };
    desk.confirm = { kind: kind, code: ask.getAttribute('data-code'), id: ask.getAttribute('data-id'), title: titles[kind], body: bodies[kind] };
    draw();
    return;
  }
  if (e.target.closest('[data-act="confirm-no"]')) { desk.confirm = null; draw(); return; }
  if (e.target.closest('[data-act="confirm-yes"]')) {
    var job = desk.confirm;
    desk.confirm = null;
    if (!job) return;
    var done = function (res, okText) {
      flash(res.ok ? okText : (res.message || 'The desk could not do that.'));
      load();
    };
    if (job.kind === 'cancel') api('/api/admin/cancel', { method: 'POST', body: { code: job.code } }).then(function (res) { done(res, 'Cancelled. Paid stakes are refunded.'); });
    else if (job.kind === 'winner') api('/api/admin/decide', { method: 'POST', body: { code: job.code, winnerId: job.id } }).then(function (res) { done(res, 'Winner queued. It will not be paid twice.'); });
    else if (job.kind === 'refund') api('/api/admin/resolve', { method: 'POST', body: { code: job.code, action: 'refund' } }).then(function (res) { done(res, 'Everyone who paid is refunded.'); });
    else if (job.kind === 'manual') api('/api/admin/payouts/manual', { method: 'POST', body: { id: job.id, note: 'paid by hand' } }).then(function (res) { done(res, 'Marked paid by hand.'); });
    return;
  }
  if (e.target.closest('[data-act="lock"]')) {
    api('/api/admin/lock', { method: 'POST', body: {} }).then(function () { page.admin = null; flash('Desk locked.'); load(); });
  }
});

document.addEventListener('submit', function (e) {
  var form = e.target;
  if (!form || !form.dataset || !form.dataset.act) return;
  e.preventDefault();
  var act = form.dataset.act;
  var data = formData(form);
  var submitter = e.submitter;
  if (submitter && submitter.name) data[submitter.name] = submitter.value;
  if (submitter && submitter.name === 'winnerId') data.winnerId = submitter.value;
  if (submitter && submitter.getAttribute('data-id')) data.winnerId = submitter.getAttribute('data-id');
  var button = form.querySelector('button');
  if (button) button.disabled = true;

  if (act === 'create') {
    if (data.deadline) data.deadline = new Date(data.deadline).toISOString();
    else delete data.deadline;
    api('/api/challenges', { method: 'POST', body: data }).then(function (res) {
      if (res.status === 401) { go('/signin?next=/new'); return; }
      if (!res.ok) { flash(res.message || 'Could not open it.'); load(); return; }
      flash('Challenge open. Share the code.');
      go('/c/' + res.challenge.code);
    });
    return;
  }
  if (act === 'join') {
    api('/api/challenges/join', { method: 'POST', body: data }).then(function (res) {
      if (!res.ok) { flash(res.message || 'Could not join.'); if (button) button.disabled = false; draw(); return; }
      go('/c/' + res.challenge.code);
    });
    return;
  }
  if (act === 'join-here') {
    data.code = route().code;
    api('/api/challenges/join', { method: 'POST', body: data }).then(function (res) {
      flash(res.ok ? 'You are in. Pay your part to lock the pot.' : (res.message || 'Could not join.'));
      load();
    });
    return;
  }
  if (act === 'start') {
    api('/api/challenges/' + route().code + '/start', { method: 'POST', body: {} }).then(function (res) {
      flash(res.ok ? 'Started. The pot is held.' : (res.message || 'Could not start.'));
      load();
    });
    return;
  }
  if (act === 'cancel') {
    api('/api/challenges/' + route().code + '/cancel', { method: 'POST', body: {} }).then(function (res) {
      flash(res.ok ? 'Cancelled. Anyone who paid is refunded.' : (res.message || 'Could not cancel.'));
      load();
    });
    return;
  }
  if (act === 'pay') {
    api('/api/challenges/' + route().code + '/pay', { method: 'POST', body: {} }).then(function (res) {
      if (res.authorizationUrl) { location.href = res.authorizationUrl; return; }
      flash(res.alreadyPaid ? 'You have already paid.' : (res.message || 'Paystack did not open.'));
      load();
    });
    return;
  }
  if (act === 'report') {
    api('/api/challenges/' + route().code + '/report', { method: 'POST', body: { winnerId: data.winnerId } }).then(function (res) {
      flash(res.ok ? 'Report saved.' : (res.message || 'Could not save that.'));
      load();
    });
    return;
  }
  if (act === 'bank') {
    api('/api/bank', { method: 'POST', body: data }).then(function (res) {
      flash(res.ok ? 'Account saved. Only the bank, the name, and the last four digits stay here.' : (res.message || 'Could not save that account.'));
      load();
    });
    return;
  }
  if (act === 'collect') {
    var code = form.getAttribute('data-code') || route().code;
    api('/api/payouts/collect', { method: 'POST', body: { roomCode: code } }).then(function (res) {
      flash(res.ok ? (res.message || 'Claimed — house sends it to your bank soon') : (res.message || 'Could not claim that prize.'));
      load();
    });
    return;
  }
  if (act === 'send-code') {
    api('/api/auth/request', { method: 'POST', body: { name: data.name, email: data.email } }).then(function (res) {
      if (!res.ok) { flash(res.message || 'The code was not sent.'); state.codeSent = false; draw(); return; }
      state.pending = { name: data.name, email: data.email };
      state.codeSent = true;
      flash('Code sent. Check your email and enter the 6 digits.' + (res.devCode ? ' Test code: ' + res.devCode : ''));
      draw();
    });
    return;
  }
  if (act === 'verify-code') {
    var pending = state.pending || {};
    api('/api/auth/verify', { method: 'POST', body: { name: pending.name, email: pending.email, code: data.code } }).then(function (res) {
      if (!res.ok) { flash(res.message || 'That code was not right.'); draw(); return; }
      state.me = res.player;
      state.codeSent = false;
      state.pending = null;
      flash('');
      go(nextPath());
    });
    return;
  }
  if (act === 'unlock') {
    api('/api/admin/unlock', { method: 'POST', body: { token: data.token } }).then(function (res) {
      flash(res.ok ? '' : (res.message || 'That key did not open the desk.'));
      load();
    });
    return;
  }
  if (act === 'resolve') {
    api('/api/admin/resolve', { method: 'POST', body: { code: form.dataset.code, action: data.action, winnerId: data.winnerId } }).then(function (res) {
      flash(res.ok ? 'Resolved. The payout row exists once.' : (res.message || 'Could not resolve.'));
      load();
    });
  }
});

window.addEventListener('popstate', function () { flash(''); load(); });

var params = new URLSearchParams(location.search);
var back = params.get('reference') || params.get('trxref');
setInterval(function () {
  if (route().name !== 'admin' || !page.admin || desk.confirm) return;
  api('/api/admin/queue').then(function (data) {
    if (!data.ok || route().name !== 'admin') return;
    page.admin = data;
    draw();
  });
}, 25000);
load().then(function () {
  if (!back) return;
  flash('Checking that payment with Paystack…');
  draw();
  api('/api/payments/status?reference=' + encodeURIComponent(back)).then(function (res) {
    history.replaceState({}, '', location.pathname);
    flash(res.challenge && res.challenge.you && res.status === 'paid' ? 'Payment confirmed. Onile is holding it.' : 'Still waiting for Paystack to confirm.');
    load();
  });
});
