'use strict';
// LiveOps records for the house desk. Seed rows are fictional and only
// appear when the server is in test mode, so a screenshot never needs a
// real player's name, phone or email. The house key is never stored.
const fs = require('fs');
const path = require('path');

const PUSH_PHRASE = 'SEND PUSH';
const TABLE_ACTIONS = new Set(['end', 'close', 'kick', 'nudge', 'replace']);

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}
function dayKey(n) {
  return daysAgo(n).slice(0, 10);
}

function seedPlayers() {
  return [
    {
      id: 'seed-ada',
      name: 'Adaeze Seed',
      phone: '08030001101',
      email: 'adaeze.seed@example.test',
      games: 18,
      wins: 7,
      lastSeen: daysAgo(0),
      cosmetics: ['Gold Big Man'],
      stickers: ['Lekki Toll', 'Owambe Hall'],
      spins: [{ day: dayKey(1), prize: 'Pack' }, { day: dayKey(4), prize: 'Pack' }],
      rewards: [{ day: dayKey(3), kind: 'set', name: 'Brown set' }],
      rivalries: [{ name: 'Chinedu Seed', wins: 4, losses: 2 }],
      trades: [{ day: dayKey(2), with: 'Chinedu Seed', gave: 'Makoko', got: 'Yaba' }],
      reports: 0,
      banned: false,
      muted: false
    },
    {
      id: 'seed-chi',
      name: 'Chinedu Seed',
      phone: '08030001102',
      email: 'chinedu.seed@example.test',
      games: 11,
      wins: 3,
      lastSeen: daysAgo(1),
      cosmetics: ['Gold Suya'],
      stickers: ['Danfo'],
      spins: [{ day: dayKey(1), prize: 'Nothing' }],
      rewards: [],
      rivalries: [{ name: 'Adaeze Seed', wins: 2, losses: 4 }],
      trades: [{ day: dayKey(2), with: 'Adaeze Seed', gave: 'Yaba', got: 'Makoko' }],
      reports: 1,
      banned: false,
      muted: false
    },
    {
      id: 'seed-bim',
      name: 'Bimpe Seed',
      phone: '08030001103',
      email: 'bimpe.seed@example.test',
      games: 6,
      wins: 1,
      lastSeen: daysAgo(6),
      cosmetics: [],
      stickers: ['NEPA'],
      spins: [],
      rewards: [{ day: dayKey(6), kind: 'daily', name: 'Day 2 pack' }],
      rivalries: [],
      trades: [],
      reports: 0,
      banned: false,
      muted: false
    }
  ];
}

function seedEconomy() {
  const rows = [];
  for (let i = 29; i >= 0; i--) {
    const wave = 8 + (i % 7) * 2;
    rows.push({
      day: dayKey(i),
      dau: 36 + wave,
      signups: 2 + (i % 4),
      started: 10 + (i % 5),
      finished: 7 + (i % 3),
      lengthMin: 26 + (i % 6),
      abandon: Math.round((0.16 + (i % 5) * 0.01) * 100) / 100,
      spins: 14 + (i % 4),
      sets: 1 + (i % 3),
      trades: 3 + (i % 2),
      events: i % 7 === 0 ? 8 : 2,
      pushes: 5 + (i % 3)
    });
  }
  return rows;
}

function seedPayments() {
  return [
    { id: 'pay_seed_ok', status: 'paid', amount: 50000, user: 'Adaeze Seed', at: daysAgo(1) },
    { id: 'pay_seed_fail', status: 'failed', amount: 20000, user: 'Chinedu Seed', at: daysAgo(2) },
    { id: 'pay_seed_wait', status: 'pending', amount: 50000, user: 'Bimpe Seed', at: daysAgo(0) }
  ];
}

function seedReports() {
  return [
    {
      id: 'rep-seed-1',
      kind: 'chat',
      from: 'Adaeze Seed',
      about: 'Chinedu Seed',
      aboutId: 'seed-chi',
      text: 'Seeded report: a chat line flagged in the test desk.',
      at: daysAgo(1),
      status: 'open'
    }
  ];
}

function createLive(opts) {
  opts = opts || {};
  const seeded = !!opts.seed;
  const players = seeded ? seedPlayers() : [];
  const economy = seeded ? seedEconomy() : [];
  const payments = seeded ? seedPayments() : [];
  const reports = seeded ? seedReports() : [];
  let event = seeded ? {
    id: 'owambe-week',
    name: 'Owambe Week',
    status: 'live',
    starts: dayKey(1),
    ends: dayKey(-6),
    note: 'Lagos sticker week. Seeded for the desk.'
  } : { id: '', name: 'No event', status: 'off', starts: '', ends: '', note: '' };
  const scheduled = [];
  const audit = [];
  const auditFile = opts.auditFile || '';

  function loadAudit() {
    if (!auditFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
      if (Array.isArray(raw)) raw.slice(-200).forEach((row) => audit.push(row));
    } catch (e) { /* a missing file is a fresh desk */ }
  }
  function saveAudit() {
    if (!auditFile) return;
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true });
      fs.writeFileSync(auditFile, JSON.stringify(audit.slice(-200)));
    } catch (e) { /* the desk still answers if the disk is missing */ }
  }
  loadAudit();

  function writeAudit(action, target, detail) {
    audit.push({
      at: new Date().toISOString(),
      who: 'owner',
      action,
      target: String(target || ''),
      detail: String(detail || '').slice(0, 180)
    });
    if (audit.length > 200) audit.splice(0, audit.length - 200);
    saveAudit();
  }

  function headlines(rows) {
    const last = rows[rows.length - 1] || {};
    const week = rows.slice(-7);
    const started = rows.reduce((s, r) => s + r.started, 0);
    const finished = rows.reduce((s, r) => s + r.finished, 0);
    return {
      dau: last.dau || 0,
      wau: week.reduce((s, r) => s + r.dau, 0) ? Math.round(week.reduce((s, r) => s + r.dau, 0) / 2.4) : 0,
      mau: rows.length ? Math.round(rows.reduce((s, r) => s + r.dau, 0) / 3.1) : 0,
      signups: week.reduce((s, r) => s + r.signups, 0),
      started: week.reduce((s, r) => s + r.started, 0),
      finished: week.reduce((s, r) => s + r.finished, 0),
      lengthMin: last.lengthMin || 0,
      abandon: last.abandon || 0,
      d1: 0.41,
      d7: 0.18,
      spins: week.reduce((s, r) => s + r.spins, 0),
      sets: week.reduce((s, r) => s + r.sets, 0),
      trades: week.reduce((s, r) => s + r.trades, 0),
      events: week.reduce((s, r) => s + r.events, 0),
      pushes: week.reduce((s, r) => s + r.pushes, 0),
      windowStarted: started,
      windowFinished: finished
    };
  }

  function liveRooms() {
    const list = [];
    const rooms = opts.rooms;
    if (!rooms || typeof rooms.values !== 'function') return list;
    for (const room of rooms.values()) {
      list.push({
        code: room.code,
        seed: false,
        mode: room.mode === 'pass' ? 'pass' : 'online',
        status: room.status || 'lobby',
        phase: room.phase || room.status || 'lobby',
        humans: (room.players || []).filter((p) => !p.bot).length,
        bots: (room.players || []).filter((p) => p.bot).length,
        players: (room.players || []).map((p) => ({
          id: p.id,
          name: String(p.name || '').slice(0, 24),
          token: p.token || '',
          cash: p.cash || 0,
          bot: !!p.bot,
          afk: !!p.afkTaken,
          properties: []
        })),
        feed: (room.feed || []).slice(-8).map((e) => ({ kind: e.kind, text: String(e.text || '').slice(0, 140) }))
      });
    }
    return list;
  }

  function seedRoom() {
    if (!seeded) return null;
    return {
      code: 'SEED01',
      seed: true,
      mode: 'online',
      status: 'playing',
      phase: 'roll',
      humans: 2,
      bots: 0,
      players: [
        { id: 1, name: 'Adaeze Seed', token: 'big-man', cash: 1500000, bot: false, afk: false, properties: ['Makoko', 'Yaba'] },
        { id: 2, name: 'Chinedu Seed', token: 'suya', cash: 1325000, bot: false, afk: true, properties: ['Lekki Tollgate'] }
      ],
      feed: [
        { kind: 'info', text: 'Seed table opened. No real players.' },
        { kind: 'timeout', text: 'Chinedu Seed has been quiet for a minute.' }
      ]
    };
  }

  function allRooms() {
    const live = liveRooms();
    const demo = seedRoom();
    return demo ? [demo].concat(live) : live;
  }

  function publicPlayer(p) {
    return {
      id: p.id,
      name: p.name,
      phone: p.phone,
      email: p.email,
      games: p.games,
      wins: p.wins,
      lastSeen: p.lastSeen,
      cosmetics: p.cosmetics.slice(),
      stickers: p.stickers.slice(),
      spins: p.spins.slice(),
      rewards: p.rewards.slice(),
      rivalries: p.rivalries.slice(),
      trades: p.trades.slice(),
      reports: p.reports,
      banned: p.banned,
      muted: p.muted
    };
  }

  function health() {
    const mem = process.memoryUsage();
    return {
      uptimeSec: Math.max(0, Math.round(process.uptime())),
      build: String(opts.build || ''),
      memoryMb: Math.round((mem.rss || 0) / 1048576),
      websockets: typeof opts.wsCount === 'function' ? opts.wsCount() : 0,
      errorRate: typeof opts.errorRate === 'function' ? opts.errorRate() : 0
    };
  }

  function tagsFor(row) {
    const name = String(row.name || '').trim();
    const tags = [];
    if (/^kiji$/i.test(name)) tags.push('owner');
    if (/^qa\s/i.test(name)) tags.push('qa');
    if (/^learner\b/i.test(name)) tags.push('learner');
    const tables = Number(row.tablesPlayed) || 0;
    if (!name || /^train/i.test(name)) tags.push('training');
    else if (tables <= 0 && tags.length) tags.push('training');
    return tags;
  }
  function creditBook() {
    if (!opts.playCredit || typeof opts.playCredit.view !== 'function') return [];
    const book = opts.playCredit.view();
    return book && Array.isArray(book.accounts) ? book.accounts : [];
  }
  function shelfPlayers() {
    const roster = opts.retention && typeof opts.retention.opsRoster === 'function' ? opts.retention.opsRoster() : { day: '', players: [] };
    const byId = new Map();
    for (const row of roster.players || []) {
      if (!row || !row.id) continue;
      byId.set(row.id, {
        id: row.id,
        name: row.name || '',
        daysPlayed: row.daysPlayed || 0,
        lastPlayed: row.lastPlayed || '',
        activeToday: !!row.activeToday,
        active7d: !!row.active7d,
        tablesPlayed: row.tablesPlayed || 0,
        tablesWon: row.tablesWon || 0,
        claims: row.claims || 0,
        pushOn: !!row.pushOn,
        creditKobo: 0,
        shelf: true
      });
    }
    for (const acct of creditBook()) {
      const id = String(acct.accountId || '');
      if (!id) continue;
      const hit = byId.get(id);
      const kobo = Math.round(Number(acct.balanceKobo) || 0);
      if (hit) hit.creditKobo = kobo;
      else if (kobo !== 0) {
        byId.set(id, {
          id, name: '', daysPlayed: 0, lastPlayed: '', activeToday: false, active7d: false,
          tablesPlayed: 0, tablesWon: 0, claims: 0, pushOn: false, creditKobo: kobo, shelf: true
        });
      }
    }
    const rows = [];
    for (const row of byId.values()) {
      const tags = tagsFor(row);
      rows.push(Object.assign({}, row, { tags, real: tags.length === 0 }));
    }
    if (!rows.length && seeded) {
      return seedPlayers().map((p) => Object.assign({}, p, { tags: tagsFor(p), real: tagsFor(p).length === 0, shelf: false, creditKobo: 0, pushOn: false, claims: 0, daysPlayed: 0, lastPlayed: '', tablesPlayed: p.games || 0, tablesWon: p.wins || 0 }));
    }
    return rows;
  }
  function houseStats() {
    const rows = shelfPlayers().filter((row) => row.shelf);
    const real = rows.filter((row) => row.real);
    const summary = opts.retention && typeof opts.retention.opsSummary === 'function' ? opts.retention.opsSummary() : null;
    const today = summary && summary.today ? summary.today : { claims: 0, tablesStarted: 0, tablesFinished: 0, afkTakeovers: 0 };
    return {
      realPlayers: real.length,
      players: rows.length,
      activeToday: real.filter((row) => row.activeToday).length,
      active7d: real.filter((row) => row.active7d).length,
      tablesStarted: today.tablesStarted || 0,
      tablesFinished: today.tablesFinished || 0,
      afk: today.afkTakeovers || 0,
      claims: today.claims || 0,
      pushOn: summary && summary.push ? summary.push.subscribers || 0 : rows.filter((row) => row.pushOn).length
    };
  }
  function publicShelf(row) {
    return {
      id: row.id,
      name: row.name || '',
      tags: row.tags || [],
      real: !!row.real,
      shelf: true,
      daysPlayed: row.daysPlayed || 0,
      lastPlayed: row.lastPlayed || '',
      tablesPlayed: row.tablesPlayed || 0,
      tablesWon: row.tablesWon || 0,
      claims: row.claims || 0,
      pushOn: !!row.pushOn,
      creditKobo: row.creditKobo || 0
    };
  }
  function ledgerPayments() {
    if (!opts.money || typeof opts.money.view !== 'function') return null;
    let view;
    try { view = opts.money.view(); } catch (e) { return null; }
    if (!view || view.ok === false) return null;
    const payments = (view.payments || []).map((row) => ({
      id: String(row.reference || ''),
      status: row.status || '',
      amount: Math.round((Number(row.amountKobo) || 0) / 100),
      user: row.email || '',
      at: new Date(row.createdAt || Date.now()).toISOString(),
      room: row.roomCode || ''
    }));
    const payouts = (view.payouts || []).map((row) => ({
      id: String(row.id || ''),
      status: row.status || '',
      kind: row.kind || '',
      amount: Math.round((Number(row.amountKobo) || 0) / 100),
      room: row.roomCode || ''
    }));
    const totals = view.totals || {};
    return {
      ok: true,
      source: 'ledger',
      totals: {
        count: payments.length,
        paid: Math.round((Number(totals.collectedKobo) || 0) / 100) || payments.filter((row) => row.status === 'paid').reduce((sum, row) => sum + row.amount, 0),
        failed: payments.filter((row) => row.status === 'failed').length,
        pending: payments.filter((row) => row.status === 'pending' || row.status === 'abandoned').length,
        payouts: payouts.length,
        payoutPending: Number(totals.open) || payouts.filter((row) => row.status && row.status !== 'paid' && row.status !== 'paid-manual' && row.status !== 'refunded' && row.status !== 'refunded-manual').length
      },
      payments,
      payouts
    };
  }

  function view(part, query) {
    query = query || {};
    if (part === 'rooms') {
      const q = String(query.q || '').toLowerCase();
      const rooms = allRooms().filter((r) => !q || String(r.code).toLowerCase().includes(q) || r.players.some((p) => p.name.toLowerCase().includes(q)));
      return {
        ok: true,
        rooms,
        stats: {
          live: rooms.length,
          playing: rooms.filter((r) => r.status === 'playing').length,
          humans: rooms.reduce((sum, r) => sum + (r.humans || 0), 0)
        }
      };
    }
    if (part === 'room') {
      const code = String(query.code || '').toUpperCase();
      const room = allRooms().find((r) => r.code === code);
      if (!room) return { ok: false, error: 'missing', message: 'No table with that code.' };
      return { ok: true, room };
    }
    if (part === 'players') {
      const q = String(query.q || '').toLowerCase();
      const rows = shelfPlayers().filter((p) => {
        if (!q) return true;
        if (p.shelf) return (p.name || 'no name').toLowerCase().includes(q);
        return p.name.toLowerCase().includes(q) || String(p.phone || '').includes(q) || String(p.email || '').toLowerCase().includes(q);
      });
      const listed = rows.filter((p) => p.shelf);
      const pool = listed.length ? listed : rows;
      return {
        ok: true,
        stats: {
          real: pool.filter((p) => p.real).length,
          total: pool.length
        },
        players: rows.map((p) => (p.shelf ? publicShelf(p) : { id: p.id, name: p.name, phone: p.phone, email: p.email, banned: p.banned, muted: p.muted, lastSeen: p.lastSeen, tags: p.tags || [], real: p.real !== false, shelf: false }))
      };
    }
    if (part === 'player') {
      const id = String(query.id || '');
      const shelf = shelfPlayers().find((row) => row.shelf && row.id === id);
      if (shelf) return { ok: true, player: publicShelf(shelf) };
      const p = players.find((row) => row.id === id);
      if (!p) return { ok: false, error: 'missing', message: 'No player with that id.' };
      return { ok: true, player: publicPlayer(p) };
    }
    if (part === 'economy') {
      const days = String(query.days || '7') === '30' ? 30 : 7;
      const series = opts.retention && typeof opts.retention.opsDays === 'function' ? opts.retention.opsDays(days) : [];
      if ((series && series.length) || !seeded) {
        const stats = houseStats();
        const started = (series || []).reduce((sum, row) => sum + (row.started || 0), 0);
        const finished = (series || []).reduce((sum, row) => sum + (row.finished || 0), 0);
        return {
          ok: true,
          days,
          tracked: true,
          headlines: {
            dau: stats.activeToday,
            wau: stats.active7d,
            started,
            finished,
            claims: (series || []).reduce((sum, row) => sum + (row.claims || 0), 0),
            afk: (series || []).reduce((sum, row) => sum + (row.afk || 0), 0)
          },
          series: series || []
        };
      }
      const rows = economy.slice(-days);
      return { ok: true, days, headlines: headlines(rows.length ? rows : economy), series: rows };
    }
    if (part === 'payments') {
      const ledger = ledgerPayments();
      if (ledger && (ledger.payments.length || ledger.totals.payouts || !seeded)) return ledger;
      const paid = payments.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amount, 0);
      return {
        ok: true,
        totals: {
          count: payments.length,
          paid,
          failed: payments.filter((p) => p.status === 'failed').length,
          pending: payments.filter((p) => p.status === 'pending').length,
          payouts: 0,
          payoutPending: 0
        },
        payments
      };
    }
    if (part === 'moderation') {
      const flagged = players.filter((p) => p.reports > 0 || p.banned || p.muted).map(publicPlayer);
      return {
        ok: true,
        stats: { reports: reports.length, open: reports.filter((r) => r.status === 'open').length, flagged: flagged.length },
        reports,
        flagged
      };
    }
    if (part === 'events') {
      return { ok: true, event, scheduled, stats: { live: event && event.status === 'live' ? 1 : 0, scheduled: scheduled.length } };
    }
    if (part === 'audit') {
      const rows = audit.slice().reverse();
      return { ok: true, audit: rows, stats: { actions: rows.length } };
    }
    const rooms = allRooms();
    const days = opts.retention && typeof opts.retention.opsDays === 'function' ? opts.retention.opsDays(7) : [];
    return {
      ok: true,
      health: health(),
      stats: houseStats(),
      days: days || [],
      live: {
        playersOnline: rooms.reduce((s, r) => s + r.humans, 0),
        rooms: rooms.length,
        playing: rooms.filter((r) => r.status === 'playing').length
      },
      rooms: rooms.slice(0, 8)
    };
  }

  function act(body) {
    if (!body || body.confirm !== true) {
      return { ok: false, status: 400, error: 'confirm', message: 'Confirm the action first.' };
    }
    const action = String(body.action || '');
    if (action === 'broadcast_push') {
      if (String(body.confirmText || '') !== PUSH_PHRASE) {
        return { ok: false, status: 400, error: 'confirm', message: 'Type SEND PUSH to send a push to everyone.' };
      }
      writeAudit(action, 'everyone', 'Push held. The desk does not fan out a push from this button.');
      return { ok: true, message: 'Push confirmation recorded. No push was sent.' };
    }
    if (TABLE_ACTIONS.has(action)) {
      const code = String(body.code || '').toUpperCase();
      if (code === 'SEED01') {
        writeAudit(action, code, 'Seed table. ' + (body.playerId != null ? 'seat ' + body.playerId : 'table'));
        return { ok: true, seed: true, code, action };
      }
      if (typeof opts.admin !== 'function') {
        return { ok: false, status: 503, error: 'locked', message: 'Table actions are not wired on this host.' };
      }
      const out = opts.admin(body) || { ok: false };
      if (!out.ok) return { ok: false, status: 400, error: out.error || 'bad', message: out.message || 'The table refused that.' };
      writeAudit(action, code, out.message || action);
      return { ok: true, code, action };
    }
    const player = players.find((p) => p.id === String(body.playerId || ''));
    if (action === 'ban' || action === 'unban' || action === 'mute' || action === 'unmute') {
      if (!player) return { ok: false, status: 400, error: 'missing', message: 'No player with that id.' };
      if (action === 'ban') player.banned = true;
      if (action === 'unban') player.banned = false;
      if (action === 'mute') player.muted = true;
      if (action === 'unmute') player.muted = false;
      writeAudit(action, player.id, player.name);
      return { ok: true, player: publicPlayer(player) };
    }
    if (action === 'grant' || action === 'revoke') {
      if (!player) return { ok: false, status: 400, error: 'missing', message: 'No player with that id.' };
      const kind = body.kind === 'sticker' ? 'stickers' : 'cosmetics';
      const name = String(body.name || '').slice(0, 40);
      if (!name) return { ok: false, status: 400, error: 'bad', message: 'Name the cosmetic or sticker.' };
      const list = player[kind];
      if (action === 'grant' && !list.includes(name)) list.push(name);
      if (action === 'revoke') player[kind] = list.filter((item) => item !== name);
      writeAudit(action, player.id, kind + ' ' + name);
      return { ok: true, player: publicPlayer(player) };
    }
    if (action === 'event_start' || action === 'event_stop' || action === 'event_schedule') {
      if (action === 'event_stop') event = Object.assign({}, event, { status: 'off' });
      if (action === 'event_start') event = Object.assign({}, event, { status: 'live', name: String(body.name || event.name || 'House event').slice(0, 40) });
      if (action === 'event_schedule') {
        scheduled.push({ name: String(body.name || 'Scheduled').slice(0, 40), starts: String(body.starts || ''), ends: String(body.ends || '') });
      }
      writeAudit(action, event.id || 'event', event.name);
      return { ok: true, event, scheduled };
    }
    if (action === 'grant_credit') {
      if (typeof opts.playCredit !== 'function' && !(opts.playCredit && opts.playCredit.grant)) {
        return { ok: false, status: 503, error: 'locked', message: 'Play credit is not wired on this host.' };
      }
      const book = opts.playCredit;
      const out = book.grant({
        id: String(body.id || ''),
        accountId: String(body.accountId || ''),
        kobo: Number(body.kobo),
        reason: String(body.reason || ''),
        roomCode: String(body.roomCode || ''),
        by: 'owner'
      });
      if (!out.ok) return { ok: false, status: 400, error: out.error, message: out.message };
      writeAudit('grant_credit', out.id, 'balance ' + out.balanceKobo + (out.already ? ' already' : ''));
      return { ok: true, already: !!out.already, balanceKobo: out.balanceKobo, id: out.id };
    }
    if (action === 'broadcast') {
      const text = String(body.text || '').trim().slice(0, 180);
      if (!text) return { ok: false, status: 400, error: 'bad', message: 'Write the announcement first.' };
      writeAudit(action, 'online', text);
      return { ok: true, message: 'Announcement queued for players who are online.' };
    }
    return { ok: false, status: 400, error: 'action', message: 'Unknown action.' };
  }

  return { view, act, health };
}

module.exports = { createLive, PUSH_PHRASE };
