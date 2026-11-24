'use strict';
// Durable copies of the money records. The Node host writes its money
// files (payments, the prize ledger, the payout queue) to local disk,
// and a Render free web service has no persistent disk: every deploy,
// restart or idle spin-down starts on a fresh filesystem. So each money
// store also mirrors its whole document into one row of a Supabase
// table (kolopoly_kv, migration 002), and at boot a store whose local
// file is missing is hydrated from that row before the server listens.
//
// Same Supabase project and service role key as the match records
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). With either missing the
// mirror is a no-op and the local files are the only copy, which is
// fine on a host with a real disk (KP_DATA_DIR on a mounted volume).
// Writes are debounced per key and serialized, so a burst of saves
// becomes one upsert carrying the latest document.

function createDurable(env, opts) {
  env = env || {};
  opts = opts || {};
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  const table = String(env.KP_DURABLE_TABLE || 'kolopoly_kv');
  const enabled = !!(url && key) && env.KP_DURABLE !== 'off';
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : 400;
  const pending = new Map();
  const timers = new Map();
  const inflight = new Map();
  let warned = false;

  function headers(extra) {
    return Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, extra || {});
  }
  async function load(name) {
    if (!enabled) return null;
    try {
      const res = await fetch(url + '/rest/v1/' + table + '?key=eq.' + encodeURIComponent(name) + '&select=doc', {
        headers: headers(), signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) { console.log('Durable copy of ' + name + ' could not be read (' + res.status + ').'); return null; }
      const rows = await res.json();
      return Array.isArray(rows) && rows[0] ? rows[0].doc : null;
    } catch (e) {
      console.log('Durable copy of ' + name + ' could not be read.');
      return null;
    }
  }
  async function write(name) {
    const doc = pending.get(name);
    pending.delete(name);
    try {
      const res = await fetch(url + '/rest/v1/' + table + '?on_conflict=key', {
        method: 'POST',
        headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ key: name, doc, updated_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok && !warned) { warned = true; console.log('Durable copy write refused (' + res.status + '). Run migrations/002_kolopoly_kv.sql.'); }
    } catch (e) {
      if (!warned) { warned = true; console.log('Durable copy write failed; the local file still holds the record.'); }
    }
  }
  function flushKey(name) {
    timers.delete(name);
    const prev = inflight.get(name) || Promise.resolve();
    const next = prev.then(() => (pending.has(name) ? write(name) : null));
    inflight.set(name, next);
    return next;
  }
  function mirror(name) {
    return {
      push(doc) {
        if (!enabled) return;
        pending.set(name, JSON.parse(JSON.stringify(doc)));
        if (!timers.has(name)) timers.set(name, setTimeout(() => flushKey(name), debounceMs));
      }
    };
  }
  async function flush() {
    for (const [name, t] of timers) { clearTimeout(t); timers.delete(name); flushKey(name); }
    await Promise.all([...inflight.values()]);
  }
  return { enabled, load, mirror, flush };
}

module.exports = { createDurable };
