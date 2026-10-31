'use strict';
// Kolopoly finished-game records. Server side only: this module is the
// one place that talks to the Supabase store, with the service role key
// from the environment. The key never reaches the browser; clients read
// records through GET /api/records on this server.
//
// If SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing, every function
// here is a graceful no-op and the game runs exactly as it did before
// records existed. The store is the lakalaka-game Supabase project, but
// the table is Kolopoly's own (kolopoly_matches), so the two games never
// mix rows.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CACHE_MS = 30000;

let cache = { at: 0, data: null };

function enabled() {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

function storeHeaders(extra) {
  return Object.assign({
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

// Save one finished game, from the room endGame just closed. Fire and
// forget by contract: the caller never awaits this in the game path, and
// a failed write only logs one line. The caller guards the once-only
// write with room.recordSaved, so a re-ended room cannot double-write.
async function recordMatch(room) {
  if (!enabled()) return;
  if (!room || !room.winner || !Array.isArray(room.endTable)) return;
  try {
    const winnerRow = room.endTable.find((r) => r.playerId === room.winner.playerId) || room.endTable[0];
    const res = await fetch(SUPABASE_URL + '/rest/v1/kolopoly_matches', {
      method: 'POST',
      headers: storeHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        room_code: room.code,
        mode: (room.settings && room.settings.gameMode === 'inflation') ? 'Inflation' : 'Classic',
        player_count: room.players.length,
        winner_name: room.winner.name,
        winner_net_worth: Math.round(Number(winnerRow && winnerRow.netWorth) || 0),
        players: room.endTable
      })
    });
    if (!res.ok) throw new Error('store answered ' + res.status);
    cache = { at: 0, data: null }; // the newest game should show on the next read
  } catch (err) {
    console.log('records: could not save the game (' + (err && err.message ? err.message : err) + '). The game is unaffected.');
  }
}

async function fetchMatches(limit) {
  const url = SUPABASE_URL + '/rest/v1/kolopoly_matches?select=played_at,room_code,mode,winner_name,winner_net_worth,player_count,players&order=played_at.desc&limit=' + limit;
  const res = await fetch(url, { headers: storeHeaders() });
  if (!res.ok) throw new Error('store answered ' + res.status);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// Top landlords: ranked by wins first, then by the biggest winning net
// worth. Records follow the typed winner name, exactly as typed
// (trimmed). No accounts.
function aggregateLandlords(rows) {
  const byName = new Map();
  for (const row of rows) {
    const name = String((row && row.winner_name) || '').trim();
    if (!name) continue;
    let agg = byName.get(name);
    if (!agg) { agg = { name, wins: 0, bestNetWorth: 0 }; byName.set(name, agg); }
    agg.wins += 1;
    const worth = Number(row.winner_net_worth) || 0;
    if (worth > agg.bestNetWorth) agg.bestNetWorth = worth;
  }
  return [...byName.values()]
    .sort((a, b) => (b.wins - a.wins) || (b.bestNetWorth - a.bestNetWorth) || a.name.localeCompare(b.name))
    .slice(0, 20);
}

async function getRecords() {
  if (!enabled()) return { enabled: false, matches: [], landlords: [] };
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_MS) return cache.data;
  try {
    const rows = await fetchMatches(200);
    const data = {
      enabled: true,
      matches: rows.slice(0, 20).map((r) => ({
        played_at: r.played_at,
        room_code: r.room_code,
        mode: r.mode,
        winner_name: r.winner_name,
        winner_net_worth: r.winner_net_worth,
        player_count: r.player_count,
        players: Array.isArray(r.players) ? r.players : []
      })),
      landlords: aggregateLandlords(rows)
    };
    cache = { at: now, data };
    return data;
  } catch (err) {
    console.log('records: could not load matches (' + (err && err.message ? err.message : err) + ').');
    return cache.data || { enabled: true, matches: [], landlords: [], error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { enabled, recordMatch, getRecords };
