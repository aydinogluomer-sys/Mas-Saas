-- Migration ledger: tracks which supabase/migrations/*.sql files have been applied,
-- with a checksum so drift (a file edited after being applied) is detectable.
-- Bootstrapped by scripts/db/migrate.ts — this file is the literal source of truth for
-- that DDL, not a maintained copy of it.
create table if not exists public.schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now(),
  applied_by text not null default 'unknown'
);

-- 0007's blanket "authenticated can do anything" loop only ever saw tables that existed
-- at the time it ran (before this table existed), so it never granted this table that
-- policy. This block is an explicit, idempotent guarantee of that fact rather than a
-- silent assumption — the ledger records real schema history and must not be writable
-- by ordinary app sessions.
drop policy if exists schema_migrations_authenticated_all
  on public.schema_migrations;

alter table public.schema_migrations enable row level security;

revoke all on table public.schema_migrations
  from public, anon, authenticated;
