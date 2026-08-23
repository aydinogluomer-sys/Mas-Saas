-- Faz 37 — integration hub: connection registry, and four new job types on the EXISTING queue.
--
-- ═══ NO SECOND QUEUE ═══
--
-- Faz 33 built `background_jobs` with retry policy, backoff, a dead-letter state, a transition
-- guard and progress tracking. A scheduled bank sync is a job in exactly that sense, so this
-- migration adds JOB TYPES rather than a parallel `integration_jobs` table. Four tables would
-- have meant four retry policies drifting apart and four places to look when a sync is stuck.
--
-- ═══ NO CREDENTIALS IN THIS DATABASE ═══
--
-- `integration_connections` records that a connection EXISTS and how it is configured — never a
-- token, password or client secret. Those stay in environment variables, the same rule Faz 6/25
-- applied to the Telegram token, and `credential_env_var` names the variable instead of holding
-- its value. A database dump of this system must never be a credential leak, and the pg_dump this
-- project takes before every migration would otherwise become exactly that.

alter table public.background_jobs drop constraint if exists background_jobs_job_type_check;
alter table public.background_jobs add constraint background_jobs_job_type_check
  check (job_type in (
    'excel_import',
    'bank_statement_import',
    'report_generation',
    'large_export',
    'read_model_refresh',
    -- Faz 37. Note for a later phase: a gate that pins the SIZE of this set will break on the
    -- next widening (the Faz 31 lesson). phase37:verify asserts a SUPERSET instead.
    'bank_api_sync',
    'einvoice_sync',
    'fx_rate_sync',
    'accounting_sync'
  ));

create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),

  -- Which integration this is. Closed list: an open text column would let a typo create a
  -- connection no worker ever claims, and it would sit there looking configured.
  integration_kind text not null check (integration_kind in (
    'bank_api', 'einvoice', 'fx_rate', 'accounting'
  )),

  -- Free-text label, because one company can have two bank connections.
  name text not null check (btrim(name) <> ''),

  -- The vendor/provider, as a STRING and not a closed list.
  --
  -- Deliberate: the accounting vendor (Paraşüt / Logo / Mikro / Luca) is a business decision this
  -- codebase cannot make, and is recorded in docs/status-notes.md as awaiting the owner's answer.
  -- Pinning a CHECK list today would either guess for them or have to be migrated the moment they
  -- decide. Nothing branches on this value — it is documentation attached to the row.
  provider text check (provider is null or btrim(provider) <> ''),

  status text not null default 'disabled' check (status in (
    'disabled',   -- configured but not in use
    'enabled',    -- eligible for scheduled sync
    'error',      -- last sync failed; needs attention before it runs again
    'revoked'     -- credentials withdrawn; terminal until reconfigured
  )),

  -- NAMES the environment variable holding the credential. Never the credential.
  credential_env_var text check (credential_env_var is null or credential_env_var ~ '^[A-Z][A-Z0-9_]*$'),

  -- Non-secret configuration: base URL, account filters, schedule.
  config jsonb not null default '{}'::jsonb,

  -- Minutes between scheduled syncs. Null means manual-only.
  sync_interval_minutes integer check (sync_interval_minutes is null or sync_interval_minutes >= 5),

  last_sync_at timestamptz,
  last_success_at timestamptz,
  last_error text,

  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (integration_kind, name),

  -- An errored connection must say why. A row that is merely 'error' with no message is a
  -- support ticket nobody can start work on.
  constraint integration_connections_error_has_reason check (
    status <> 'error' or (last_error is not null and btrim(last_error) <> '')
  )
);

create index if not exists integration_connections_due_idx
  on public.integration_connections (status, integration_kind, last_sync_at);

-- ── transition guard, in the SAME migration as the CHECK (the 0027 lesson) ──────────────
--
-- Allowed:
--   disabled -> enabled     turned on
--   enabled  -> disabled    turned off
--   enabled  -> error       a sync failed
--   error    -> enabled     the cause was fixed
--   error    -> disabled    turned off while broken
--   enabled  -> revoked     credentials withdrawn
--   disabled -> revoked     same, while off
--   error    -> revoked     same, while broken
--
-- REFUSED:
--   revoked -> anything     re-enabling a revoked connection would silently resume pulling data
--                           with credentials somebody deliberately withdrew. Reconfiguring is a
--                           NEW connection, which is also what actually happened.
--   disabled -> error       a connection that never ran cannot have failed.
create or replace function public.integration_connections_guard_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('disabled', 'enabled'),
    ('disabled', 'revoked'),
    ('enabled',  'disabled'),
    ('enabled',  'error'),
    ('enabled',  'revoked'),
    ('error',    'enabled'),
    ('error',    'disabled'),
    ('error',    'revoked')
  ) then
    raise exception 'Geçersiz entegrasyon durumu geçişi: % → % (bağlantı %)',
      old.status, new.status, old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists integration_connections_status_guard on public.integration_connections;
create trigger integration_connections_status_guard
  before update of status on public.integration_connections
  for each row execute function public.integration_connections_guard_transition();

drop trigger if exists integration_connections_updated_at on public.integration_connections;
create trigger integration_connections_updated_at before update on public.integration_connections
  for each row execute function public.set_updated_at();

-- ── RLS: Faz 24B five-tier classification ───────────────────────────────────────────────
--
-- `config` class: everyone may see WHICH integrations exist and whether they are healthy, but
-- only an admin may configure one. Turning on a live bank feed is an administrative act, not
-- finance data entry — and it is the closest thing in this system to granting access to an
-- external system.
alter table public.integration_connections enable row level security;

drop policy if exists integration_connections_select_all_tiers on public.integration_connections;
create policy integration_connections_select_all_tiers on public.integration_connections
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists integration_connections_insert_admin on public.integration_connections;
create policy integration_connections_insert_admin on public.integration_connections
  for insert to mas_radar_admin with check (true);
drop policy if exists integration_connections_update_admin on public.integration_connections;
create policy integration_connections_update_admin on public.integration_connections
  for update to mas_radar_admin using (true) with check (true);
drop policy if exists integration_connections_delete_admin on public.integration_connections;
create policy integration_connections_delete_admin on public.integration_connections
  for delete to mas_radar_admin using (true);

grant select on public.integration_connections to mas_radar_viewer,
  mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager;
grant select, insert, update, delete on public.integration_connections to mas_radar_admin;

-- ── health read model, as a VIEW ────────────────────────────────────────────────────────
create or replace view public.integration_health as
  select
    c.id,
    c.integration_kind,
    c.name,
    c.provider,
    c.status,
    c.sync_interval_minutes,
    c.last_sync_at,
    c.last_success_at,
    c.last_error,
    -- Null when never synced or never scheduled: "no successful sync yet" is not "0 minutes ago".
    case when c.last_success_at is null then null
         else round(extract(epoch from (now() - c.last_success_at)) / 60.0)::int end
      as minutes_since_success,
    -- Overdue only means something for an enabled connection on a schedule.
    case
      when c.status <> 'enabled' or c.sync_interval_minutes is null then false
      when c.last_success_at is null then true
      else now() > c.last_success_at + (c.sync_interval_minutes || ' minutes')::interval
    end as is_overdue,
    (select count(*)::int from public.background_jobs j
      where j.status = 'dead_letter'
        and j.payload->>'connectionId' = c.id::text) as dead_letter_count
  from public.integration_connections c;

grant select on public.integration_health to mas_radar_viewer,
  mas_radar_finance_operator, mas_radar_finance_approver,
  mas_radar_finance_manager, mas_radar_admin;
