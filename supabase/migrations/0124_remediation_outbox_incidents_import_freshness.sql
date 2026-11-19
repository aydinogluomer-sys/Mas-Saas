-- =============================================================================
-- Migration 0124: Remediation — Outbox Uncertain-Delivery State, Atomic Reminder
--                 Claiming, Incident Suppression/Evidence, Valid Import Freshness
--                 View & 31+ Escalation Rule Naming (I-002, I-005, I-006, I-007, I-013)
--
-- 100% additive, non-destructive, idempotent, zero row deletion.
-- Note: Per scripts/db/migration-lib.ts rules, no top-level transaction control
-- statements and no CREATE INDEX CONCURRENTLY are used.
-- =============================================================================

-- ── 1) public.notification_outbox: delivery_uncertain status + metadata columns ──
alter table public.notification_outbox
  add column if not exists uncertain_at timestamptz,
  add column if not exists correlation_id text;

do $outbox_status_chk$
declare
  v_con record;
begin
  for v_con in
    select con.conname
      from pg_constraint con
      join pg_attribute att
        on att.attrelid = con.conrelid
       and att.attnum = con.conkey[1]
     where con.conrelid = 'public.notification_outbox'::regclass
       and con.contype = 'c'
       and coalesce(array_length(con.conkey, 1), 0) = 1
       and att.attname = 'status'
  loop
    execute format('alter table public.notification_outbox drop constraint %I', v_con.conname);
  end loop;

  alter table public.notification_outbox
    add constraint notification_outbox_status_check
    check (
      status in (
        'pending',
        'claiming',
        'sent',
        'failed_retryable',
        'delivery_uncertain',
        'dead_letter',
        'skipped'
      )
    );
end
$outbox_status_chk$;

-- ── 2) public.reminder_deliveries: atomic claiming + delivery_uncertain + index ──
alter table public.reminder_deliveries
  add column if not exists claim_token uuid,
  add column if not exists claimed_at timestamptz;

do $reminder_deliveries_status_chk$
declare
  v_con record;
begin
  for v_con in
    select con.conname
      from pg_constraint con
      join pg_attribute att
        on att.attrelid = con.conrelid
       and att.attnum = con.conkey[1]
     where con.conrelid = 'public.reminder_deliveries'::regclass
       and con.contype = 'c'
       and coalesce(array_length(con.conkey, 1), 0) = 1
       and att.attname = 'status'
  loop
    execute format('alter table public.reminder_deliveries drop constraint %I', v_con.conname);
  end loop;

  alter table public.reminder_deliveries
    add constraint reminder_deliveries_status_check
    check (
      status in (
        'pending',
        'claiming',
        'sent',
        'failed',
        'skipped',
        'delivery_uncertain'
      )
    );
end
$reminder_deliveries_status_chk$;

create index if not exists reminder_deliveries_pending_sched_idx
  on public.reminder_deliveries (status, scheduled_for, id)
  where status in ('pending', 'claiming');

-- ── 3) public.ops_incidents: SUPPRESSED state + suppression/evidence/correlation ──
alter table public.ops_incidents
  add column if not exists suppressed_until timestamptz,
  add column if not exists suppression_reason text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_success_at timestamptz,
  add column if not exists resolution_evidence jsonb,
  add column if not exists correlation_id text;

do $ops_incidents_state_chk$
declare
  v_con record;
begin
  for v_con in
    select con.conname
      from pg_constraint con
      join pg_attribute att
        on att.attrelid = con.conrelid
       and att.attnum = con.conkey[1]
     where con.conrelid = 'public.ops_incidents'::regclass
       and con.contype = 'c'
       and coalesce(array_length(con.conkey, 1), 0) = 1
       and att.attname = 'state'
  loop
    execute format('alter table public.ops_incidents drop constraint %I', v_con.conname);
  end loop;

  alter table public.ops_incidents
    add constraint ops_incidents_state_check
    check (
      state in (
        'OK',
        'OPEN',
        'ACKNOWLEDGED',
        'RESOLVED',
        'UNKNOWN',
        'SUPPRESSED'
      )
    );
end
$ops_incidents_state_chk$;

-- ── 4) public.valid_workbook_imports view (I-005: non-empty parsed/mapped imports) ──
-- Canonical staging rows table in PostgreSQL is `public.import_rows(workbook_id)`
-- (not `source_rows`). Includes both legacy `status = 'parsed'` (`workbook-importer.ts`)
-- and Standard Import V2 `status = 'mapped'` (`v2/mapper.ts`), while excluding
-- `'pending'`, `'failed'`, and empty workbooks with 0 `import_rows`.
create or replace view public.valid_workbook_imports
with (security_invoker = true) as
  select sw.*
    from public.source_workbooks sw
   where sw.status in ('parsed', 'mapped')
     and exists (
       select 1
         from public.import_rows ir
        where ir.workbook_id = sw.id
     );

revoke all on table public.valid_workbook_imports from public;
do $grant_valid_workbook_imports$
declare
  r text;
begin
  foreach r in array array[
    'anon',
    'authenticated',
    'mas_radar_app',
    'mas_radar_viewer',
    'mas_radar_finance_operator',
    'mas_radar_finance_approver',
    'mas_radar_finance_manager',
    'mas_radar_admin'
  ] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.valid_workbook_imports from %I', r);
    end if;
  end loop;

  foreach r in array array[
    'mas_radar_viewer',
    'mas_radar_finance_operator',
    'mas_radar_finance_approver',
    'mas_radar_finance_manager',
    'mas_radar_admin'
  ] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant select on table public.valid_workbook_imports to %I', r);
    end if;
  end loop;
end
$grant_valid_workbook_imports$;

-- ── 5) Standardize -31 reminder rule names (I-006 / Section 7) ──────────────────
-- Preserves rule IDs and all historical `reminder_deliveries` foreign-key references.
update public.reminders
   set name = regexp_replace(
                regexp_replace(
                  regexp_replace(name, '30\+', '31+', 'g'),
                  'hukuki\s+eskalasyonu?',
                  'üst eskalasyon (iç inceleme)',
                  'gi'
                ),
                'hukuki',
                'üst eskalasyon (iç inceleme)',
                'gi'
              )
 where offset_days = -31
   and (name ilike '%30+%' or name ilike '%hukuki%');

-- ── 6) Post-DDL Catalog Invariant Verification ────────────────────────────────
do $verify_0124$
declare
  v_unprotected_views int;
begin
  select count(*)::int
    into v_unprotected_views
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'v'
     and not coalesce('security_invoker=true' = any(c.reloptions), false);

  if v_unprotected_views > 0 then
    raise exception '0124 verification failed: % public view(s) missing security_invoker=true', v_unprotected_views;
  end if;

  if to_regclass('public.valid_workbook_imports') is null then
    raise exception '0124 verification failed: public.valid_workbook_imports missing';
  end if;

  if to_regclass('public.reminder_deliveries_pending_sched_idx') is null then
    raise exception '0124 verification failed: reminder_deliveries_pending_sched_idx missing';
  end if;
end
$verify_0124$;
