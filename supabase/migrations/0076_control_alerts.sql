-- Faz 31 — control alerts and escalation. The synthesis layer's one piece of new state.
--
-- ═══ WHAT THIS PHASE DOES *NOT* DO ═══
--
-- This is a synthesis phase, and the discipline that matters most is not re-enforcing invariants
-- that already hold. Audited before writing a line, with the result recorded per check in
-- docs/database-schema.md:
--
--   ALREADY ENFORCED at the database level, so this phase only REPORTS:
--     * paid > invoice / collection > receivable — Faz 22's allocations_enforce_invoice_ceiling()
--       trigger. A second CHECK would be a duplicate authority that could disagree with it.
--     * duplicate bank transaction — bank_transactions_dedupe_uq is a UNIQUE index. Exact
--       duplicates cannot exist, so the useful check is for NEAR-duplicates the hash cannot see.
--     * new/changed IBAN — Faz 19's iban_change_events already records every one, append-only.
--
--   GENUINELY NEW, because nothing detects them today:
--     * duplicate INVOICE — invoices_dedupe_idx is NOT unique (verified), unlike the bank one.
--     * payment with no invoice, approval bypass, closed-period mutation, missing document.
--
-- The alerts table below is the only new state, because a finding needs somewhere to be
-- acknowledged, and none of the existing tables carries that.

create table if not exists public.control_alerts (
  id uuid primary key default gen_random_uuid(),

  -- Which check produced this. A stable code rather than a free-text title, so a screen can group
  -- by control and a false-positive rate can be computed per rule.
  check_code text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),

  -- What it is about. The same polymorphic (table, id) shape approvals uses — findings point at
  -- rows in many unrelated tables and no single FK could span them.
  subject_table text,
  subject_id uuid,
  subject_label text,

  title text not null,
  detail text,
  -- The named rules behind the finding (Faz 23/29 convention: a verdict travels with its rules).
  rule_codes text[] not null default '{}',
  -- 0..1. NULL means unscored, which is different from 0 ("certainly benign").
  anomaly_score numeric(5,4) check (anomaly_score is null or (anomaly_score >= 0 and anomaly_score <= 1)),
  amount numeric(14,2),
  currency text not null default 'TRY',

  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'snoozed', 'resolved', 'false_positive')),

  acknowledged_at timestamptz,
  acknowledged_by uuid references public.users(id),
  snooze_until date,
  resolved_at timestamptz,
  resolved_by uuid references public.users(id),
  resolution_note text,

  -- The follow-up task, when one was raised. Faz 25's precedent: the existing action_items model
  -- is reused and no second task model is invented.
  action_item_id uuid references public.action_items(id),

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- How many times the detector has re-found this. Re-running controls must not create duplicate
  -- alerts; it bumps this instead.
  occurrence_count int not null default 1 check (occurrence_count > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Exhaustive rather than a pile of implications, so every state names exactly which fields it
  -- may carry (the budget_lines pattern from Faz 28).
  constraint control_alerts_status_consistency check (
    (status = 'open'
      and acknowledged_at is null and snooze_until is null and resolved_at is null)
    or (status = 'acknowledged'
      and acknowledged_at is not null and snooze_until is null and resolved_at is null)
    or (status = 'snoozed'
      and snooze_until is not null and resolved_at is null)
    or (status in ('resolved', 'false_positive')
      and resolved_at is not null)
  ),
  constraint control_alerts_ack_actor check (
    (acknowledged_at is not null) = (acknowledged_by is not null)
  ),
  -- A resolution must say who and why. "Resolved by nobody, for no reason" is how a control gets
  -- quietly switched off.
  constraint control_alerts_resolution_reason check (
    resolved_at is null or (resolved_by is not null and resolution_note is not null
                            and btrim(resolution_note) <> '')
  ),
  constraint control_alerts_subject_pair check (
    (subject_table is null) = (subject_id is null)
  ),
  -- Every alert must cite at least one rule. coalesce() is load-bearing: array_length() on an
  -- EMPTY array returns NULL, and a CHECK evaluating to NULL PASSES — the bug Faz 29 found the
  -- hard way, applied here from the start.
  constraint control_alerts_has_rules check (
    coalesce(array_length(rule_codes, 1), 0) >= 1
  ),
  -- One live alert per (check, subject). Re-detection bumps occurrence_count instead of piling up
  -- rows; a resolved alert may legitimately be superseded by a NEW one if the problem recurs.
  constraint control_alerts_seen_order check (last_seen_at >= first_seen_at)
);

create unique index if not exists control_alerts_live_unique
  on public.control_alerts (check_code, subject_table, subject_id)
  nulls not distinct
  where status in ('open', 'acknowledged', 'snoozed');

create index if not exists control_alerts_status_idx
  on public.control_alerts (status, severity, last_seen_at desc);

-- ── lifecycle guard, in the SAME migration as the CHECK (0027's lesson) ────────────────
--
-- Eleven of the twenty ordered pairs are permitted:
--   open        -> acknowledged | snoozed | resolved | false_positive
--   acknowledged-> snoozed | resolved | false_positive
--   snoozed     -> open | acknowledged | resolved | false_positive
--
-- `snoozed -> open` is the one that is easy to leave out and must not be: a snooze EXPIRES, and
-- without this transition every snoozed alert would be permanently silenced — which is the exact
-- failure mode of an alerting system nobody trusts.
--
-- `resolved` and `false_positive` are terminal. Reopening a closed finding would rewrite the
-- control history it exists to provide; a recurrence is a NEW alert, which is also what the
-- partial unique index above allows.
--
-- `false_positive` is a first-class outcome, not a flavour of resolved: it is the feedback signal
-- the plan asks for, and keeping it distinct is what makes a per-rule false-positive rate
-- computable at all.
create or replace function public.control_alerts_guard_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('open',         'acknowledged'),
    ('open',         'snoozed'),
    ('open',         'resolved'),
    ('open',         'false_positive'),
    ('acknowledged', 'snoozed'),
    ('acknowledged', 'resolved'),
    ('acknowledged', 'false_positive'),
    ('snoozed',      'open'),
    ('snoozed',      'acknowledged'),
    ('snoozed',      'resolved'),
    ('snoozed',      'false_positive')
  ) then
    raise exception 'Geçersiz uyarı durum geçişi: % → % (uyarı %)', old.status, new.status, old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists control_alerts_transition_guard on public.control_alerts;
create trigger control_alerts_transition_guard
  before update of status on public.control_alerts
  for each row execute function public.control_alerts_guard_transition();

drop trigger if exists control_alerts_updated_at on public.control_alerts;
create trigger control_alerts_updated_at before update on public.control_alerts
  for each row execute function public.set_updated_at();

-- ── escalation rules ───────────────────────────────────────────────────────────────────
--
-- Configuration, like approval_rules / treasury_policies / cost_allocation_rules. No lifecycle
-- column: a rule is active or it is not, so §17 rule 3 is genuinely N/A and phase31:verify
-- asserts that structurally rather than trusting this comment.
create table if not exists public.alert_escalation_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text not null,

  -- Which alerts it governs. NULL check_code means "any check of this severity".
  check_code text,
  severity text not null check (severity in ('info', 'warning', 'critical')),

  -- Escalate once an alert has gone unacknowledged this long.
  escalate_after_hours int not null check (escalate_after_hours > 0),
  -- Reuses Faz 25's channels; no new transport is invented here.
  channel text not null default 'telegram' check (channel in ('telegram', 'email')),

  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists alert_escalation_rules_updated_at on public.alert_escalation_rules;
create trigger alert_escalation_rules_updated_at before update on public.alert_escalation_rules
  for each row execute function public.set_updated_at();

create unique index if not exists alert_escalation_rules_active_unique
  on public.alert_escalation_rules (severity, check_code)
  nulls not distinct
  where is_active;

-- Critical findings escalate in an hour, warnings in a day. Both active: an escalation rule that
-- shipped inactive would mean the phase delivered alerting that silently never escalates.
insert into public.alert_escalation_rules (code, description, severity, escalate_after_hours, channel)
values
  ('critical_1h', 'Kritik uyarı 1 saat içinde onaylanmazsa yükselt', 'critical', 1, 'telegram'),
  ('warning_24h', 'Uyarı 24 saat içinde onaylanmazsa yükselt',       'warning', 24, 'telegram')
on conflict (code) do nothing;

-- ── RLS: Faz 24B tier model ────────────────────────────────────────────────────────────
-- control_alerts        -> `operational`: an operator triages findings; a manager clears them.
-- alert_escalation_rules-> `config`: everyone reads, only admin changes. Deliberately not
--                          manager-writable — someone who could lengthen the escalation window on
--                          their own alerts would be turning off the alarm rather than answering
--                          it, the same argument 0058 used for approval_rules.
alter table public.control_alerts enable row level security;
alter table public.alert_escalation_rules enable row level security;

drop policy if exists control_alerts_select_all_tiers on public.control_alerts;
create policy control_alerts_select_all_tiers on public.control_alerts
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists control_alerts_insert_enter on public.control_alerts;
create policy control_alerts_insert_enter on public.control_alerts
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists control_alerts_update_enter on public.control_alerts;
create policy control_alerts_update_enter on public.control_alerts
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists control_alerts_delete_manage on public.control_alerts;
create policy control_alerts_delete_manage on public.control_alerts
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);

drop policy if exists alert_escalation_rules_select_all_tiers on public.alert_escalation_rules;
create policy alert_escalation_rules_select_all_tiers on public.alert_escalation_rules
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists alert_escalation_rules_insert_admin on public.alert_escalation_rules;
create policy alert_escalation_rules_insert_admin on public.alert_escalation_rules
  for insert to mas_radar_admin with check (true);
drop policy if exists alert_escalation_rules_update_admin on public.alert_escalation_rules;
create policy alert_escalation_rules_update_admin on public.alert_escalation_rules
  for update to mas_radar_admin using (true) with check (true);
drop policy if exists alert_escalation_rules_delete_admin on public.alert_escalation_rules;
create policy alert_escalation_rules_delete_admin on public.alert_escalation_rules
  for delete to mas_radar_admin using (true);
