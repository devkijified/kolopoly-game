// The Players tab reads the shelf file, not an empty in-memory list.
// QA, Learner, training-only and the owner are tagged and kept out of
// the real-player count. The payload has no push keys and no house key.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TOKEN = 'kp-test-sentinel-token-9f3a';
let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures += 1; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
}
function lagosDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function prevDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

const today = lagosDay(new Date());
const yesterday = prevDay(today);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolopoly-roster-'));
const shelf = {
  players: {
    kiji: { clientId: 'kiji', name: 'Kiji', claimCount: 4, push: { endpoint: 'https://push.example/secret-endpoint' }, playedDays: { [today]: true }, stats: { played: 5, wins: 2 }, tokens: ['secret-token'] },
    qa: { clientId: 'qa1', name: 'QA Ada', claimCount: 1, playedDays: { [yesterday]: true }, stats: { played: 1, wins: 0 } },
    learner: { clientId: 'learn', name: 'Learner', claimCount: 0, playedDays: {}, stats: { played: 0, wins: 0 } },
    blank: { clientId: 'blank', name: '', claimCount: 0, playedDays: {}, tokens: ['secret-token-blank'] },
    named: { clientId: 'noname-day', name: '', claimCount: 1, playedDays: { [today]: true }, tokens: ['secret-token-day'] },
    tunde: { clientId: 'tunde', name: 'Tunde', claimCount: 2, push: { endpoint: 'https://push.example/tunde' }, playedDays: { [today]: true, [yesterday]: true }, stats: { played: 3, wins: 1 }, tokens: ['secret-token'] },
    tunde2: { clientId: 'tunde-phone', name: 'Tunde', claimCount: 1, playedDays: { [yesterday]: true }, stats: { played: 1, wins: 0 } },
    chioma: { name: 'Chioma', claimCount: 0, playedDays: { [yesterday]: true }, push: null, tokens: ['abababababababababababab'] }
  },
  tokens: {},
  stats: {
    claims: { [today]: 2 },
    tablesStarted: { [today]: 4, [yesterday]: 1 },
    tablesFinished: { [today]: 3 },
    afk: { [today]: 1 }
  }
};
fs.writeFileSync(path.join(dir, 'retention.json'), JSON.stringify(shelf));
fs.writeFileSync(path.join(dir, 'play-credits.json'), JSON.stringify({
  accounts: {
    tunde: { balanceKobo: 20000, entries: [] },
    walletonly: { balanceKobo: 5000, entries: [] }
  }
}));

const port = 4477;
const env = {
  ...process.env,
  PORT: String(port),
  KP_TEST: '',
  KP_ADMIN_TOKEN: TOKEN,
  KP_DATA_DIR: dir,
  KP_PERSIST_ROOMS: '',
  KP_OPS_AUDIT_FILE: path.join(dir, 'audit.json')
};
let logs = '';
const child = spawn(process.execPath, ['server.js'], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not boot\n' + logs)), 8000);
  child.stdout.on('data', (d) => { if (String(d).includes('Kolopoly listening')) { clearTimeout(timer); resolve(); } });
});

function request(method, urlPath, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  let body;
  if (opts.json) {
    headers['Content-Type'] = 'application/json';
    headers.Accept = 'application/json';
    body = JSON.stringify(opts.json);
  }
  return fetch('http://127.0.0.1:' + port + urlPath, { method, headers, body }).then(async (res) => {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { status: res.status, text, json, setCookie };
  });
}

try {
  await ready;
  const opened = await request('POST', '/ops/unlock', { json: { token: TOKEN } });
  const line = (opened.setCookie || []).find((item) => item.startsWith('kp_ops=')) || '';
  const session = line ? line.split(';')[0].slice('kp_ops='.length) : '';
  check('house key opens the desk', opened.status === 200 && !!session);
  const auth = { Cookie: 'kp_ops=' + session, Accept: 'application/json' };

  const players = await request('GET', '/ops/live?part=players', { headers: auth });
  const rows = (players.json && players.json.players) || [];
  const byName = Object.fromEntries(rows.map((row) => [row.name || 'No name', row]));
  check('shelf players are listed', rows.length >= 6, String(rows.length));
  check('blank name is No name on the wire as empty and not dropped', rows.some((row) => row.name === ''));
  check('real players are the named shelves plus a nameless played day', players.json.stats.real === 3, JSON.stringify(players.json.stats));
  check('Kiji is the owner and not real', byName.Kiji && byName.Kiji.tags.includes('owner') && byName.Kiji.real === false);
  check('QA Ada is tagged', byName['QA Ada'] && byName['QA Ada'].tags.includes('qa') && byName['QA Ada'].real === false);
  check('Learner is tagged', byName.Learner && byName.Learner.tags.includes('learner') && byName.Learner.real === false);
  check('a nameless shelf is training', rows.some((row) => row.name === '' && row.tags.includes('training') && row.real === false));
  check('two Tunde shelves merge into one person', byName.Tunde && byName.Tunde.daysPlayed === 2 && byName.Tunde.lastPlayed === today && byName.Tunde.tablesPlayed === 4 && byName.Tunde.tablesWon === 1 && byName.Tunde.claims === 3 && byName.Tunde.pushOn === true && byName.Tunde.creditKobo === 20000 && rows.filter((row) => row.name === 'Tunde').length === 1);
  check('a shelf with no tables field still counts when a day was played', byName.Chioma && byName.Chioma.tablesPlayed === 0 && byName.Chioma.daysPlayed === 1 && byName.Chioma.real === true);
  check('a played day with a blank name stays real', rows.some((row) => row.name === '' && row.real === true && row.daysPlayed === 1));
  check('a credit with no shelf still shows', rows.some((row) => row.creditKobo === 5000 && row.real === false));
  check('the player list has no push endpoint or house key', !players.text.includes('secret-endpoint') && !players.text.includes('secret-token') && !players.text.includes(TOKEN) && !players.text.includes('p256dh'));

  const overview = await request('GET', '/ops/live?part=overview', { headers: auth });
  const stats = overview.json.stats;
  check('overview counts real players and today', stats.realPlayers === 3 && stats.activeToday === 2 && stats.active7d === 3 && stats.tablesStarted === 4 && stats.tablesFinished === 3 && stats.afk === 1 && stats.claims === 2, JSON.stringify(stats));
  check('overview days come from the shelf', (overview.json.days || []).some((row) => row.day === today && row.started === 4 && row.finished === 3));

  const rooms = await request('GET', '/ops/live?part=rooms', { headers: auth });
  check('rooms header is zero when none are live', rooms.json.stats.live === 0 && rooms.json.stats.playing === 0);

  const pay = await request('GET', '/ops/live?part=payments', { headers: auth });
  check('empty payments are zeros', pay.json.totals.count === 0 && pay.json.totals.paid === 0 && pay.json.totals.pending === 0 && pay.json.payments.length === 0, JSON.stringify(pay.json.totals));

  const econ = await request('GET', '/ops/live?part=economy&days=7', { headers: auth });
  check('economy uses shelf days, not a fake rate', econ.json.tracked === true && econ.json.headlines.started === 5 && econ.json.headlines.finished === 3 && econ.json.headlines.d1 == null);
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  child.kill();
}
console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
