-- Kolopoly durable money records: one row per money store (payments,
-- prize ledger, payout queue), each holding that store's whole JSON
-- document. The Render free plan has no persistent disk, so the game
-- server mirrors its money files here and reads them back at boot.
-- Run once in the Supabase SQL editor for the records project.
create table if not exists public.kolopoly_kv (
  key text primary key,
  doc jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.kolopoly_kv enable row level security;

-- Service role only, same as kolopoly_matches: no anon or
-- authenticated grants, nothing but the game server touches money.
grant select, insert, update, delete on public.kolopoly_kv to service_role;
