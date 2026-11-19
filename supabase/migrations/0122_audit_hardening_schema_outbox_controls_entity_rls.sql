-- =============================================================================
-- Migration 0122: Technical & Financial Audit Hardening (P0 / P1 / P2 Closure)
--
-- 1. Runtime Role Hygiene & SECURITY DEFINER Schema Parity Summary RPC (`get_schema_ledger_summary`)
-- 2. Unified Idempotent Notification Outbox (`notification_outbox`) & Stateful Ops Incidents (`ops_incidents`)
-- 3. Control Escalation Tracking (`control_alerts`), Duplicate Check/Payment Detectors & IBAN/Approval View Fixes
-- 4. Obligation Reconciliation Lifecycle Columns & Outflow Settlement Maker-Checker Hard-Gate Trigger
-- 5. DSO / DPO Minimum-Observation Guard & Draft/Archive Exclusion (`dso_dpo_components`, `working_capital_metrics`)
-- 6. Multi-Entity Membership (`user_legal_entities`), Entity Period Uniqueness & PostgreSQL RESTRICTIVE Entity RLS
-- =============================================================================

-- ── 1) Runtime Role Hygiene & Schema Ledger Summary RPC ──────────────────────
do $revoke_auth$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and exists (select 1 from pg_roles where rolname = 'mas_radar_app') then
    execute 'revoke authenticated from mas_radar_app';
  end if;
exception when others then
  null;
end
$revoke_auth$;

create or replace function public.get_schema_ledger_summary()
returns table (
  migration_count int,
  latest_version text,
  checksum_digest text,
  last_applied_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    count(*)::int as migration_count,
    max(version)::text as latest_version,
    encode(
      sha256(
        convert_to(
          coalesce(string_agg(version || ':' || checksum, ',' order by version), ''),
          'UTF8'
        )
      ),
      'hex'
    )::text as checksum_digest,
    max(applied_at) as last_applied_at
  from public.schema_migrations;
$$;

revoke all on function public.get_schema_ledger_summary() from public;
do $grant_schema_rpc$
declare
  r text;
begin
  foreach r in array array[
    'anon', 'authenticated'
  ] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.get_schema_ledger_summary() from %I', r);
    end if;
  end loop;

  foreach r in array array[
    'mas_radar_app',
    'mas_radar_viewer',
    'mas_radar_finance_operator',
    'mas_radar_finance_approver',
    'mas_radar_finance_manager',
    'mas_radar_admin'
  ] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function public.get_schema_ledger_summary() to %I', r);
    end if;
  end loop;
end
$grant_schema_rpc$;

-- ── 2) Unified Notification Outbox & Stateful Ops Incidents ──────────────────
create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  stream text not null
    check (stream in ('ops_incident', 'cfo_briefing', 'periodic_report', 'reminder_digest', 'counterparty_notice', 'auth_security')),
  channel text not null
    check (channel in ('telegram', 'email', 'sms', 'whatsapp')),
  recipient_target text not null,
  idempotency_key text not null unique,
  subject text,
  body_text text not null,
  body_format text not null default 'plain'
    check (body_format in ('plain', 'html')),
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'claiming', 'sent', 'failed_retryable', 'dead_letter', 'skipped')),
  claim_token uuid,
  claimed_at timestamptz,
  attempt_count int not null default 0 check (attempt_count >= 0),
  max_attempts int not null default 5 check (max_attempts >= 1),
  next_retry_at timestamptz not null default now(),
  sent_at timestamptz,
  provider_message_ids text[] not null default '{}',
  last_error text,
  legal_entity_id uuid references public.legal_entities(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notification_outbox_pending_idx
  on public.notification_outbox (status, next_retry_at, created_at)
  where status in ('pending', 'failed_retryable');

create table if not exists public.ops_incidents (
  signal_key text primary key,
  severity text not null check (severity in ('P0', 'P1', 'P2')),
  state text not null default 'OK'
    check (state in ('OK', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'UNKNOWN')),
  last_value text not null default '',
  state_fingerprint text not null default '',
  note text not null default '',
  opened_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.users(id),
  resolved_at timestamptz,
  last_notified_at timestamptz,
  last_notified_state text,
  occurrence_count int not null default 0 check (occurrence_count >= 0),
  updated_at timestamptz not null default now()
);

alter table public.control_alerts
  add column if not exists last_escalated_at timestamptz,
  add column if not exists escalation_count int not null default 0;

-- Seed complete escalation rules (-1, -8, -31) for payment_instance and loan_installment
insert into public.reminders (name, target_kind, offset_days, channel, is_active)
values
  ('1–7 Gün gecikmiş ödeme kontrolü', 'payment_instance', -1, 'telegram', true),
  ('8–30 Gün gecikmiş ödeme ihtarı', 'payment_instance', -8, 'telegram', true),
  ('30+ Gün gecikmiş ödeme hukuki eskalasyon', 'payment_instance', -31, 'telegram', true),
  ('1–7 Gün gecikmiş kredi taksiti', 'loan_installment', -1, 'telegram', true),
  ('8–30 Gün gecikmiş kredi taksiti ihtarı', 'loan_installment', -8, 'telegram', true),
  ('30+ Gün gecikmiş kredi taksiti eskalasyonu', 'loan_installment', -31, 'telegram', true)
on conflict (target_kind, offset_days, channel) do nothing;

-- ── 3) Duplicate Check/Payment Control Views & IBAN / Approval Bypass Fixes ──
create or replace view public.control_registry
with (security_invoker = true) as
  select * from (values
    ('duplicate_invoice',          'Yinelenen fatura',                'critical', 'detection_only',
     'invoices.dedupe_hash benzersiz DEĞİL (bank_transactions''ınkinin aksine) — bunu yalnız bu kontrol yakalar'),
    ('near_duplicate_bank_txn',    'Yinelenene yakın banka hareketi', 'warning',  'enforced_elsewhere',
     'Birebir kopya bank_transactions_dedupe_uq ile zaten imkânsız; bu, hash''in göremediği yakın kopyaları arar'),
    ('allocation_over_invoice',    'Dağıtım faturayı aşıyor',         'critical', 'enforced_elsewhere',
     'Faz 22''nin allocations_enforce_invoice_ceiling() trigger''ı zaten engelliyor; burada yalnız görünürlük'),
    ('payment_without_invoice',    'Faturasız ödeme',                 'warning',  'detection_only',
     'Hiçbir mekanizma engellemiyor'),
    ('unmatched_bank_txn_aged',    'Uzun süredir eşleşmemiş hareket', 'warning',  'detection_only',
     'status=''unmatched'' bir veri durumu; yaşlanması bir bulgu'),
    ('unknown_counterparty',       'Tanınmayan karşı taraf',          'warning',  'enforced_elsewhere',
     'Faz 19: uygulama eşleme sırasında sessizce parties satırı YARATMIYOR; ham etiket kasıtlı'),
    ('iban_changed',               'IBAN değişti/yeni IBAN',          'critical', 'enforced_elsewhere',
     'Faz 19''un iban_change_events''i her değişimi kaydeder; onaylanmamış aktif IBAN''lar kritik bulgu üretir'),
    ('large_payment',              'Büyük/olağandışı ödeme',          'warning',  'detection_only',
     'Eşik settings.critical_payment_threshold_try''den okunuyor — ikinci bir sayı icat edilmedi'),
    ('closed_period_mutation',     'Kapalı dönem mutasyonu',          'critical', 'enforced_elsewhere',
     'Faz 45 (0100) enforce_closed_period_lock() BEFORE trigger''ı kilitli döneme yazmayı zaten engelliyor; görünüm yalnız tarihsel anomali kanıtı'),
    ('approval_bypass',            'Onay atlanmış',                   'critical', 'enforced_elsewhere',
     'Faz 62 (0122) enforce_outflow_settlement_approval_gate() BEFORE UPDATE trigger''ı eşik üstü onaysız ödeme kapamalarını reddeder; görünüm geçmiş kayıtları izler'),
    ('missing_source_document',    'Kaynak belge eksik',              'info',     'detection_only',
     'Kaynak soyağacı Faz 2''den beri var; eksikliği bir bulgu olarak raporlanmıyordu'),
    ('duplicate_check',            'Olası mükerrer çek / senet kaydı','warning',  'detection_only',
     'Aynı lehtar/keşideci, aynı tutar ve ±3 gün vade penceresinde seri numarası ayrışmayan birden fazla aktif çek/senet kaydı'),
    ('duplicate_payment_template', 'Olası mükerrer ödeme şablonu',    'warning',  'detection_only',
     'Aynı normalize isim, sıklık, vade günü ve varsayılan tutara sahip birden fazla aktif ödeme şablonu')
  ) as t(check_code, title, default_severity, enforcement, rationale);

create or replace view public.control_duplicate_checks
with (security_invoker = true) as
  select
    c1.id as check_id,
    c2.id as duplicate_of_check_id,
    coalesce(c1.counterparty_label, '(lehtar yok)') as counterparty_label,
    c1.amount,
    c1.currency,
    c1.direction,
    c1.maturity_date,
    c1.serial_no
  from public.checks c1
  join public.checks c2
    on c1.id > c2.id
   and c1.archived_at is null
   and c2.archived_at is null
   and c1.status not in ('cancelled', 'returned')
   and c2.status not in ('cancelled', 'returned')
   and c1.direction = c2.direction
   and c1.currency = c2.currency
   and c1.amount = c2.amount
   and coalesce(c1.payee_party_id::text, lower(btrim(coalesce(c1.counterparty_label, ''))))
       = coalesce(c2.payee_party_id::text, lower(btrim(coalesce(c2.counterparty_label, ''))))
   and abs(c1.maturity_date - c2.maturity_date) <= 3
   and (
     nullif(btrim(coalesce(c1.serial_no, '')), '') is null
     or nullif(btrim(coalesce(c2.serial_no, '')), '') is null
     or lower(btrim(c1.serial_no)) = lower(btrim(c2.serial_no))
   );

create or replace view public.control_duplicate_payments
with (security_invoker = true) as
  select
    p1.id as payment_id,
    p2.id as duplicate_of_payment_id,
    p1.name as payment_name,
    p1.recurrence_type,
    p1.due_day,
    p1.default_amount,
    p1.currency
  from public.payments p1
  join public.payments p2
    on p1.id > p2.id
   and p1.status = 'active'
   and p2.status = 'active'
   and p1.archived_at is null
   and p2.archived_at is null
   and lower(btrim(p1.name)) = lower(btrim(p2.name))
   and coalesce(p1.provider_party_id::text, '') = coalesce(p2.provider_party_id::text, '')
   and p1.recurrence_type = p2.recurrence_type
   and coalesce(p1.due_day, -1) = coalesce(p2.due_day, -1)
   and coalesce(p1.default_amount, -1) = coalesce(p2.default_amount, -1)
   and p1.currency = p2.currency;

-- control_iban_changes: preserve original 6 columns, append `requires_verification` so verified IBANs don't stay CRITICAL for 30 days
create or replace view public.control_iban_changes
with (security_invoker = true) as
  select
    e.id as event_id,
    e.iban_id,
    e.change_type,
    e.changed_at,
    e.before_data,
    e.after_data,
    (
      e.changed_at > now() - interval '30 days'
      and coalesce(ib.approval_status, 'pending_approval') <> 'approved'
      and coalesce(ib.is_active, true) = true
    ) as is_recent,
    (coalesce(ib.approval_status, 'pending_approval') <> 'approved') as requires_verification
  from public.iban_change_events e
  left join public.ibans ib on ib.id = e.iban_id;

-- control_approval_bypass: catch both amount >= threshold AND paid_amount >= threshold (e.g. when amount was NULL)
create or replace view public.control_approval_bypass
with (security_invoker = true) as
  with threshold as (
    select coalesce((select (value #>> '{}')::numeric from public.settings
                     where key = 'critical_payment_threshold_try'), 100000) as amount
  )
  select
    i.id as payment_instance_id,
    coalesce(p.name, '(kalem)') as payment_name,
    coalesce(i.amount, i.paid_amount) as amount,
    i.due_date,
    t.amount as threshold_amount,
    i.currency,
    case
      when i.currency = 'TRY' then 1::numeric(18,10)
      else fx.rate
    end as fx_rate,
    case
      when i.currency = 'TRY' then round(greatest(coalesce(i.amount, 0), coalesce(i.paid_amount, 0)), 2)
      when fx.rate is not null then round(greatest(coalesce(i.amount, 0), coalesce(i.paid_amount, 0)) * fx.rate, 2)
      else null::numeric
    end as try_equivalent,
    (i.currency <> 'TRY' and fx.rate is null) as needs_fx_review
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  cross join threshold t
  left join lateral (
    select s.rate
    from public.fx_rate_snapshots s
    where i.currency <> 'TRY'
      and s.base_currency = i.currency
      and s.quote_currency = 'TRY'
      and s.rate_date <= coalesce(i.due_date, current_date)
    order by s.rate_date desc, s.created_at desc
    limit 1
  ) fx on true
  where coalesce(i.direction, 'outflow') = 'outflow'
    and (i.amount is not null or i.paid_amount is not null)
    and i.status in ('paid', 'partial')
    and (
      (i.currency = 'TRY' and greatest(coalesce(i.amount, 0), coalesce(i.paid_amount, 0)) >= t.amount)
      or (i.currency <> 'TRY' and fx.rate is not null and round(greatest(coalesce(i.amount, 0), coalesce(i.paid_amount, 0)) * fx.rate, 2) >= t.amount)
      or (i.currency <> 'TRY' and fx.rate is null)
    )
    and not exists (
      select 1
      from public.approvals a
      where a.subject_table = 'payment_instances'
        and a.subject_id = i.id
        and a.status = 'approved'
    );

create or replace view public.control_dashboard
with (security_invoker = true) as
  with counts(check_code, finding_count) as (
    select 'duplicate_invoice'::text,       count(*)::bigint from public.control_duplicate_invoices
    union all
    select 'near_duplicate_bank_txn'::text, count(*)::bigint from public.control_near_duplicate_bank_txns
    union all
    select 'allocation_over_invoice'::text, count(*)::bigint from public.control_allocation_over_invoice
    union all
    select 'payment_without_invoice'::text, count(*)::bigint from public.control_payment_without_invoice
    union all
    select 'unmatched_bank_txn_aged'::text, count(*)::bigint from public.control_unmatched_bank_aged
    union all
    select 'unknown_counterparty'::text,    count(*)::bigint from public.checks
     where counterparty_label is not null and payee_party_id is null and archived_at is null
    union all
    select 'iban_changed'::text,            count(*)::bigint from public.control_iban_changes where is_recent
    union all
    select 'large_payment'::text,           count(*)::bigint from public.control_large_payments
    union all
    select 'closed_period_mutation'::text,  count(*)::bigint from public.control_closed_period_mutations
    union all
    select 'approval_bypass'::text,         count(*)::bigint from public.control_approval_bypass
    union all
    select 'missing_source_document'::text, count(*)::bigint from public.control_missing_source_document
    union all
    select 'duplicate_check'::text,         count(*)::bigint from public.control_duplicate_checks
    union all
    select 'duplicate_payment_template'::text, count(*)::bigint from public.control_duplicate_payments
  )
  select
    r.check_code,
    r.title,
    r.default_severity,
    r.enforcement,
    r.rationale,
    coalesce(c.finding_count, 0) as finding_count,
    case
      when coalesce(c.finding_count, 0) = 0 then 'PASS'
      when r.default_severity = 'critical' then 'CRITICAL'
      when r.default_severity = 'warning' then 'WARNING'
      else 'INFO'
    end as state
  from public.control_registry r
  left join counts c on c.check_code = r.check_code;

-- ── 4) Reconciliation Lifecycle Columns & Outflow Settlement Hard-Gate ───────
alter table public.payment_instances
  add column if not exists reconciliation_status text not null default 'unreconciled'
    check (reconciliation_status in ('unreconciled', 'matched_statement', 'reconciled')),
  add column if not exists disputed_at timestamptz,
  add column if not exists dispute_reason text,
  add column if not exists rescheduled_from_date date;

alter table public.loan_installments
  add column if not exists reconciliation_status text not null default 'unreconciled'
    check (reconciliation_status in ('unreconciled', 'matched_statement', 'reconciled')),
  add column if not exists disputed_at timestamptz,
  add column if not exists dispute_reason text,
  add column if not exists rescheduled_from_date date;

-- Enforce maker-checker approval on new outflow settlements >= critical threshold at DB trigger level
create or replace function public.enforce_outflow_settlement_approval_gate()
returns trigger
language plpgsql
as $$
declare
  v_threshold numeric;
  v_effective_amount numeric;
  v_has_approved boolean;
begin
  -- Only fire when transitioning into 'paid' or 'partial' on an outflow row
  if new.status not in ('paid', 'partial') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status in ('paid', 'partial')
     and coalesce(new.paid_amount, 0) <= coalesce(old.paid_amount, 0) then
    return new;
  end if;
  if coalesce(new.direction, 'outflow') <> 'outflow' then
    return new;
  end if;

  select r.threshold_amount
    into v_threshold
    from public.approval_rules r
   where r.is_active = true
     and r.rule_kind = 'amount_threshold'
     and r.threshold_amount is not null
   order by r.threshold_amount asc
   limit 1;

  if v_threshold is null then
    return new;
  end if;

  v_effective_amount := greatest(coalesce(new.amount, 0), coalesce(new.paid_amount, 0));

  if new.currency = 'TRY' and v_effective_amount >= v_threshold then
    select exists (
      select 1
        from public.approvals a
       where a.subject_table = 'payment_instances'
         and a.subject_id = new.id
         and a.status = 'approved'
    ) into v_has_approved;

    if coalesce(new.approval_status, 'not_required') <> 'approved' or not coalesce(v_has_approved, false) then
      raise exception using
        errcode = '42501',
        message = format(
          'APPROVAL_REQUIRED: %s TRY tutarındaki ödeme eşik üstüdür (>= %s TRY); onay tamamlanmadan ödenmiş işaretlenemez.',
          v_effective_amount,
          v_threshold
        );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists payment_instances_settlement_approval_gate on public.payment_instances;
create trigger payment_instances_settlement_approval_gate
  before update of status, paid_amount on public.payment_instances
  for each row
  execute function public.enforce_outflow_settlement_approval_gate();

-- Disable single-operator self-approval whenever >= 2 active approver/manager/admin users exist
update public.approval_governance_settings
   set allow_single_operator_self_approval = false,
       updated_at = now()
 where allow_single_operator_self_approval = true
   and (
     select count(*)
       from public.users u
      where u.is_active = true
        and u.role in ('finance_approver', 'finance_manager', 'admin')
   ) >= 2;

-- ── 5) DSO / DPO Formula & Observation-Window Guard ──────────────────────────
create or replace view public.dso_dpo_components
with (security_invoker = true) as
  select
    (select coalesce(sum(greatest(0, coalesce(payable_amount, gross_amount) - greatest(coalesce(allocated_amount, 0), coalesce(paid_amount, 0)))), 0)
       from public.invoices
      where direction = 'sales'
        and status in ('open', 'partial')
        and archived_at is null
        and bad_debt_at is null
        and settled_by_check_id is null
        and currency = 'TRY') as receivables_open,
    (select coalesce(sum(greatest(0, coalesce(payable_amount, gross_amount) - greatest(coalesce(allocated_amount, 0), coalesce(paid_amount, 0)))), 0)
       from public.invoices
      where direction = 'purchase'
        and status in ('open', 'partial')
        and archived_at is null
        and bad_debt_at is null
        and settled_by_check_id is null
        and currency = 'TRY') as payables_open,
    (select coalesce(sum(gross_amount), 0)
       from public.invoices
      where direction = 'sales'
        and status not in ('cancelled', 'draft')
        and archived_at is null
        and currency = 'TRY'
        and issue_date >= current_date - 365) as sales_365,
    (select coalesce(sum(gross_amount), 0)
       from public.invoices
      where direction = 'purchase'
        and status not in ('cancelled', 'draft')
        and archived_at is null
        and currency = 'TRY'
        and issue_date >= current_date - 365) as purchases_365,
    (select coalesce(sum(gross_amount), 0)
       from public.invoices
      where direction = 'sales'
        and status not in ('cancelled', 'draft')
        and archived_at is null
        and currency = 'TRY'
        and issue_date >= current_date - 90) as sales_90,
    (select coalesce(sum(gross_amount), 0)
       from public.invoices
      where direction = 'purchase'
        and status not in ('cancelled', 'draft')
        and archived_at is null
        and currency = 'TRY'
        and issue_date >= current_date - 90) as purchases_90,
    (select count(*)
       from public.invoices
      where status not in ('cancelled', 'draft')
        and archived_at is null
        and currency <> 'TRY') as foreign_currency_count,
    (select count(*)::int
       from public.invoices
      where direction = 'sales'
        and status not in ('cancelled', 'draft')
        and archived_at is null
        and currency = 'TRY'
        and issue_date >= current_date - 365) as sales_invoice_count_365,
    (select greatest(1, current_date - min(issue_date) + 1)::int
       from public.invoices
      where direction = 'sales'
        and status not in ('cancelled', 'draft')
        and archived_at is null
        and currency = 'TRY'
        and issue_date >= current_date - 365) as sales_history_span_days,
    (select count(*)::int
       from public.invoices
      where direction = 'purchase'
        and status not in ('cancelled', 'draft')
        and archived_at is null
        and currency = 'TRY'
        and issue_date >= current_date - 365) as purchase_invoice_count_365,
    (select greatest(1, current_date - min(issue_date) + 1)::int
       from public.invoices
      where direction = 'purchase'
        and status not in ('cancelled', 'draft')
        and archived_at is null
        and currency = 'TRY'
        and issue_date >= current_date - 365) as purchase_history_span_days;

create or replace view public.working_capital_metrics
with (security_invoker = true) as
  with c as (select * from public.dso_dpo_components),
  inv as (
    select
      count(*)::int as item_count,
      sum(case when ii.on_hand_qty > 0 then ii.on_hand_qty * ii.standard_unit_cost else 0 end) as inventory_value_try
    from public.inventory_items ii
    where ii.is_active = true
      and ii.currency = 'TRY'
  ),
  calc as (
    select
      c.*,
      inv.item_count,
      inv.inventory_value_try,
      -- Guard against single-invoice / <14-day history producing algebraic 365.0-day artifact (X / (X / 365) = 365)
      case
        when c.sales_365 is null or c.sales_365 = 0 then null::numeric
        when coalesce(c.sales_invoice_count_365, 0) < 2 and coalesce(c.sales_history_span_days, 0) < 14 then null::numeric
        else round(
          c.receivables_open / (c.sales_365 / greatest(30.0, least(365.0, coalesce(c.sales_history_span_days, 365)::numeric))),
          1
        )
      end as computed_dso,
      case
        when c.purchases_365 is null or c.purchases_365 = 0 then null::numeric
        when coalesce(c.purchase_invoice_count_365, 0) < 2 and coalesce(c.purchase_history_span_days, 0) < 14 then null::numeric
        else round(
          c.payables_open / (c.purchases_365 / greatest(30.0, least(365.0, coalesce(c.purchase_history_span_days, 365)::numeric))),
          1
        )
      end as computed_dpo
    from c
    cross join inv
  )
  select
    calc.receivables_open,
    calc.payables_open,
    calc.sales_365,
    calc.purchases_365,
    calc.computed_dso as dso_days,
    calc.computed_dpo as dpo_days,
    case
      when coalesce(calc.item_count, 0) = 0 or calc.inventory_value_try is null then null::numeric
      when calc.purchases_365 is null or calc.purchases_365 = 0 then null::numeric
      else round(calc.inventory_value_try / (calc.purchases_365 / 365.0), 1)
    end as dio_days,
    case
      when coalesce(calc.item_count, 0) = 0 or calc.inventory_value_try is null then 'no_inventory_data'::text
      when calc.purchases_365 is null or calc.purchases_365 = 0 then 'no_purchases_denominator'::text
      else null::text
    end as dio_unmeasurable_reason,
    case
      when coalesce(calc.item_count, 0) = 0 or calc.inventory_value_try is null then null::numeric
      when calc.computed_dso is null or calc.computed_dpo is null then null::numeric
      else round(
        calc.computed_dso
        + (calc.inventory_value_try / (calc.purchases_365 / 365.0))
        - calc.computed_dpo,
        1
      )
    end as cash_conversion_cycle_days,
    case
      when coalesce(calc.item_count, 0) = 0 or calc.inventory_value_try is null then 'dio_unknown'::text
      when calc.computed_dso is null or calc.computed_dpo is null then 'missing_turnover_denominator'::text
      else null::text
    end as ccc_unmeasurable_reason,
    case
      when calc.computed_dso is null or calc.computed_dpo is null then null::numeric
      else round(calc.computed_dso - calc.computed_dpo, 1)
    end as cash_cycle_excluding_inventory
  from calc;

-- ── 6) Multi-Entity Membership, Period Lock Scoping & PostgreSQL RESTRICTIVE Entity RLS ──
create table if not exists public.user_legal_entities (
  user_id uuid not null references public.users(id) on delete cascade,
  legal_entity_id uuid not null references public.legal_entities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, legal_entity_id)
);

-- Replace global accounting_periods(period_month) uniqueness with entity-scoped uniqueness
do $acct_period_uq$
begin
  if exists (
    select 1
      from pg_constraint
     where conrelid = 'public.accounting_periods'::regclass
       and conname = 'accounting_periods_period_month_key'
  ) then
    alter table public.accounting_periods drop constraint accounting_periods_period_month_key;
  end if;
end
$acct_period_uq$;

create unique index if not exists accounting_periods_entity_month_uq
  on public.accounting_periods (coalesce(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid), period_month);

-- Add legal_entity_id to operational/audit/report tables that lacked it
alter table public.payment_instances
  add column if not exists legal_entity_id uuid references public.legal_entities(id) default public.current_legal_entity_id();
alter table public.payment_runs
  add column if not exists legal_entity_id uuid references public.legal_entities(id) default public.current_legal_entity_id();
alter table public.bank_transactions
  add column if not exists legal_entity_id uuid references public.legal_entities(id) default public.current_legal_entity_id();
alter table public.reports
  add column if not exists legal_entity_id uuid references public.legal_entities(id) default public.current_legal_entity_id();
alter table public.control_alerts
  add column if not exists legal_entity_id uuid references public.legal_entities(id) default public.current_legal_entity_id();
alter table public.approvals
  add column if not exists legal_entity_id uuid references public.legal_entities(id) default public.current_legal_entity_id();
alter table public.audit_logs
  add column if not exists legal_entity_id uuid references public.legal_entities(id) default public.current_legal_entity_id();

-- Helper predicate for RESTRICTIVE entity isolation:
-- 1) Consolidated mode (`current_legal_entity_id() IS NULL`) sees group scope.
-- 2) Specific entity mode (`current_legal_entity_id() = E`) sees rows owned by E, plus legacy NULL rows ONLY if E is the default HQ entity.
create or replace function public.matches_active_legal_entity(row_entity_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select
    public.current_legal_entity_id() is null
    or row_entity_id = public.current_legal_entity_id()
    or (
      row_entity_id is null
      and exists (
        select 1
          from public.legal_entities le
         where le.id = public.current_legal_entity_id()
           and le.is_default = true
      )
    );
$$;

do $entity_rls_and_grants$
declare
  tbl text;
begin
  -- 6a) Operational class grants & RLS for notification_outbox and ops_incidents
  foreach tbl in array array['notification_outbox', 'ops_incidents'] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on table public.%I from public, anon, authenticated, mas_radar_app', tbl);
    execute format(
      'grant select on table public.%I to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      tbl
    );
    execute format(
      'grant insert, update on table public.%I to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin',
      tbl
    );
    execute format(
      'grant delete on table public.%I to mas_radar_finance_manager, mas_radar_admin',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_select_all_tiers', tbl);
    execute format(
      'create policy %I on public.%I for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_select_all_tiers', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_insert_enter', tbl);
    execute format(
      'create policy %I on public.%I for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true)',
      tbl || '_insert_enter', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_update_enter', tbl);
    execute format(
      'create policy %I on public.%I for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin using (true) with check (true)',
      tbl || '_update_enter', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_delete_manage', tbl);
    execute format(
      'create policy %I on public.%I for delete to mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_delete_manage', tbl
    );
  end loop;

  -- 6b) Config class grants & RLS for user_legal_entities
  alter table public.user_legal_entities enable row level security;
  revoke all on table public.user_legal_entities from public, anon, authenticated, mas_radar_app;
  grant select on table public.user_legal_entities
    to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin;
  grant insert, update, delete on table public.user_legal_entities
    to mas_radar_admin;

  drop policy if exists user_legal_entities_select_all_tiers on public.user_legal_entities;
  create policy user_legal_entities_select_all_tiers on public.user_legal_entities
    for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin
    using (true);
  drop policy if exists user_legal_entities_insert_admin on public.user_legal_entities;
  create policy user_legal_entities_insert_admin on public.user_legal_entities
    for insert to mas_radar_admin with check (true);
  drop policy if exists user_legal_entities_update_admin on public.user_legal_entities;
  create policy user_legal_entities_update_admin on public.user_legal_entities
    for update to mas_radar_admin using (true) with check (true);
  drop policy if exists user_legal_entities_delete_admin on public.user_legal_entities;
  create policy user_legal_entities_delete_admin on public.user_legal_entities
    for delete to mas_radar_admin using (true);

  -- 6c) Grants on new views
  revoke all on table public.control_duplicate_checks, public.control_duplicate_payments from public, anon, authenticated;
  grant select on table public.control_duplicate_checks, public.control_duplicate_payments
    to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin;

  -- 6d) RESTRICTIVE Legal-Entity Isolation Policies across entity-scoped financial & reporting tables
  foreach tbl in array array[
    'accounting_periods',
    'branches',
    'budgets',
    'cash_accounts',
    'bank_transactions',
    'checks',
    'cost_centers',
    'credit_facilities',
    'inventory_items',
    'invoices',
    'loans',
    'management_journal_entries',
    'payments',
    'payment_instances',
    'payment_runs',
    'projects',
    'work_centers',
    'reports',
    'control_alerts',
    'notification_outbox'
  ] loop
    execute format('drop policy if exists %I on public.%I', tbl || '_legal_entity_isolation', tbl);
    execute format(
      'create policy %I on public.%I as restrictive for all to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin using (public.matches_active_legal_entity(legal_entity_id)) with check (public.matches_active_legal_entity(legal_entity_id))',
      tbl || '_legal_entity_isolation', tbl
    );
  end loop;
end
$entity_rls_and_grants$;
