-- P0-A: real multi-user auth. Replaces the single-shared-password access gate
-- (src/lib/auth.ts) with named accounts, admin/operator roles, and DB-backed sessions.
--
-- username, not email — there is no email-sending infrastructure anywhere in this app
-- (reminders go via Telegram only), so a "forgot password" email flow can't honestly
-- exist. Password resets are admin-driven instead.
--
-- Idempotent throughout (if not exists / drop trigger if exists / policy-existence
-- check), per LEDGER_EMPTY_RECOVERY — must be safe to re-run against a DB where these
-- effects already exist (e.g. a raw dev-reset that applies every migration file's SQL
-- directly before the ledger is backfilled).

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9_.-]{3,32}$'),
  password_hash text not null,
  display_name text not null check (char_length(display_name) > 0),
  role text not null default 'operator' check (role in ('admin', 'operator')),
  is_active boolean not null default true,
  failed_login_count int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists users_updated_at on public.users;
create trigger users_updated_at before update on public.users
  for each row execute function public.set_updated_at();

-- Fail-closed invariant: at least one active admin must always exist. Deactivating,
-- demoting, or deleting the last one aborts the whole transaction — a UI-only guard
-- is not sufficient (an admin script or a race between two admin sessions could still
-- get through). Deferred so the check runs against the final state at COMMIT, not
-- mid-transaction — a caller doing "promote new admin, then demote old admin" in one
-- transaction is not falsely rejected on the intermediate state.
create or replace function public.enforce_at_least_one_active_admin() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from public.users where role = 'admin' and is_active) then
    raise exception 'GÜVENLİK DURDURMASI: en az bir aktif admin hesabı kalmalı.';
  end if;
  return null;
end;
$$;

drop trigger if exists users_require_active_admin on public.users;
create constraint trigger users_require_active_admin
  after update of role, is_active or delete on public.users
  deferrable initially deferred
  for each row execute function public.enforce_at_least_one_active_admin();

-- Unlike every other table in this schema (0007_rls.sql's "single-operator: any
-- authenticated role has full access" model), users/sessions hold live credentials
-- (password_hash, token_hash) — RLS here is deliberately default-deny, not decorative.
-- The app itself connects as the Postgres superuser (src/lib/db.ts) and bypasses RLS
-- like everywhere else; this policy is real defense-in-depth against any hypothetical
-- non-superuser/PostgREST-style access path, which would otherwise read plaintext-
-- adjacent secrets under the "true" policy every other table uses.
alter table public.users enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'users' and policyname = 'users_deny_all') then
    create policy users_deny_all on public.users for all to authenticated using (false) with check (false);
  end if;
end $$;

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz
);

create index if not exists sessions_user_id_idx on public.sessions(user_id);

alter table public.sessions enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sessions' and policyname = 'sessions_deny_all') then
    create policy sessions_deny_all on public.sessions for all to authenticated using (false) with check (false);
  end if;
end $$;
