-- Faz 31 — the financial control registry and the anomaly detectors. VIEWS only.
--
-- ═══ REPORTING LAYER, NOT A SECOND ENFORCEMENT LAYER ═══
--
-- Every check below was classified before it was written, and the classification is in the view
-- itself (`enforcement` column) so a reader can tell at a glance whether a finding means "the
-- database let something through" or "the database already prevents this and here is the
-- evidence it is holding":
--
--   enforced_elsewhere — a trigger or unique index already makes the violation impossible. A row
--                        appearing here would mean legacy data predating the constraint, which is
--                        worth SEEING but must never be re-enforced with a second authority that
--                        could disagree with the first.
--   detection_only     — nothing prevents it; this view is the only thing that notices.
--
-- NO MODEL, ANYWHERE. Every anomaly rule is arithmetic over recorded rows with a named threshold.
-- There is no learned weighting, no distribution fitting and no LLM — src/lib/controls/* does not
-- import @/lib/ai, and phase31:verify proves it with a negative control.

-- ── 1) the control registry ────────────────────────────────────────────────────────────
--
-- One row per control, so the dashboard can list every check that EXISTS even when it currently
-- finds nothing. A control that silently disappears when it has no findings is a control nobody
-- notices has broken.
create or replace view public.control_registry as
  select * from (values
    ('duplicate_invoice',        'Yinelenen fatura',                'critical', 'detection_only',
     'invoices.dedupe_hash benzersiz DEĞİL (bank_transactions''ınkinin aksine) — bunu yalnız bu kontrol yakalar'),
    ('near_duplicate_bank_txn',  'Yinelenene yakın banka hareketi', 'warning',  'enforced_elsewhere',
     'Birebir kopya bank_transactions_dedupe_uq ile zaten imkânsız; bu, hash''in göremediği yakın kopyaları arar'),
    ('allocation_over_invoice',  'Dağıtım faturayı aşıyor',         'critical', 'enforced_elsewhere',
     'Faz 22''nin allocations_enforce_invoice_ceiling() trigger''ı zaten engelliyor; burada yalnız görünürlük'),
    ('payment_without_invoice',  'Faturasız ödeme',                 'warning',  'detection_only',
     'Hiçbir mekanizma engellemiyor'),
    ('unmatched_bank_txn_aged',  'Uzun süredir eşleşmemiş hareket', 'warning',  'detection_only',
     'status=''unmatched'' bir veri durumu; yaşlanması bir bulgu'),
    ('unknown_counterparty',     'Tanınmayan karşı taraf',          'warning',  'enforced_elsewhere',
     'Faz 19: uygulama eşleme sırasında sessizce parties satırı YARATMIYOR; ham etiket kasıtlı'),
    ('iban_changed',             'IBAN değişti/yeni IBAN',          'critical', 'enforced_elsewhere',
     'Faz 19''un iban_change_events''i her değişimi zaten salt-ekleme kaydediyor; burada görünürlük'),
    ('large_payment',            'Büyük/olağandışı ödeme',          'warning',  'detection_only',
     'Eşik settings.critical_payment_threshold_try''den okunuyor — ikinci bir sayı icat edilmedi'),
    ('closed_period_mutation',   'Kapalı dönem mutasyonu',          'critical', 'detection_only',
     'cashflow_months.status=''locked'' dönem çıpası; mutasyonu hiçbir şey engellemiyor'),
    ('approval_bypass',          'Onay atlanmış',                   'critical', 'detection_only',
     'Faz 24A''nın approvals''ı var ama eşiği aşan kaydın onayı olup olmadığını kimse kontrol etmiyordu'),
    ('missing_source_document',  'Kaynak belge eksik',              'info',     'detection_only',
     'Kaynak soyağacı Faz 2''den beri var; eksikliği bir bulgu olarak raporlanmıyordu')
  ) as t(check_code, title, default_severity, enforcement, rationale);

-- ── 2) duplicate invoices — GENUINELY NEW ──────────────────────────────────────────────
--
-- Same party, same gross amount, same issue date, different invoice_no. That combination is
-- overwhelmingly a double entry rather than two real invoices, and nothing in the schema stops it:
-- invoices_dedupe_idx is a plain (non-unique) index, unlike bank_transactions_dedupe_uq.
create or replace view public.control_duplicate_invoices as
  select
    v1.id                      as invoice_id,
    v2.id                      as duplicate_of_invoice_id,
    v1.party_id,
    p.name                     as party_name,
    v1.invoice_no,
    v2.invoice_no              as other_invoice_no,
    v1.issue_date,
    v1.gross_amount,
    v1.currency
  from public.invoices v1
  join public.invoices v2
    on v2.party_id is not distinct from v1.party_id
   and v2.gross_amount = v1.gross_amount
   and v2.issue_date = v1.issue_date
   and v2.direction = v1.direction
   and v2.id < v1.id                                   -- each pair once, deterministically
  left join public.parties p on p.id = v1.party_id
  where v1.status <> 'cancelled' and v2.status <> 'cancelled'
    and v1.gross_amount is not null;

-- ── 3) near-duplicate bank transactions — the hash cannot see these ────────────────────
--
-- Exact duplicates are impossible (unique index). What slips through is the same account, same
-- day and same amount with a different description — a re-import with a reformatted memo line.
create or replace view public.control_near_duplicate_bank_txns as
  select
    b1.id                      as txn_id,
    b2.id                      as near_duplicate_of,
    b1.bank_account_id,
    b1.txn_date,
    b1.amount,
    b1.description,
    b2.description             as other_description
  from public.bank_transactions b1
  join public.bank_transactions b2
    on b2.bank_account_id = b1.bank_account_id
   and b2.txn_date = b1.txn_date
   and b2.amount = b1.amount
   and b2.id < b1.id
  where b1.status <> 'ignored' and b2.status <> 'ignored';

-- ── 4) allocation over invoice — evidence the Faz 22 trigger is holding ────────────────
--
-- Expected to be EMPTY. If it is not, the row predates the trigger; the answer is to investigate
-- that row, never to add a second constraint that could disagree with the first.
create or replace view public.control_allocation_over_invoice as
  select
    v.id                       as invoice_id,
    v.invoice_no,
    v.gross_amount,
    coalesce(sum(a.allocated_amount), 0) as allocated_total,
    coalesce(sum(a.allocated_amount), 0) - v.gross_amount as excess
  from public.invoices v
  -- Reversed allocations are excluded: the Faz 22 ceiling counts OPEN allocations, and including
  -- reversed ones here would manufacture violations the trigger never permitted.
  join public.invoice_allocations a on a.invoice_id = v.id and a.reversed_at is null
  where v.gross_amount is not null
  group by v.id, v.invoice_no, v.gross_amount
  having coalesce(sum(a.allocated_amount), 0) > v.gross_amount;

-- ── 5) payments with no invoice behind them — GENUINELY NEW ────────────────────────────
create or replace view public.control_payment_without_invoice as
  select
    i.id                       as payment_instance_id,
    coalesce(p.name, '(kalem)') as payment_name,
    i.due_date,
    i.amount,
    i.currency,
    i.status
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  -- invoice_allocations is polymorphic (source_table, source_id), not a direct FK column.
  left join public.invoice_allocations a
    on a.source_table = 'payment_instances' and a.source_id = i.id and a.reversed_at is null
  where i.status in ('paid', 'partial')
    and i.amount is not null
    and a.id is null;

-- ── 6) aged unmatched bank transactions ────────────────────────────────────────────────
create or replace view public.control_unmatched_bank_aged as
  select
    b.id                       as txn_id,
    b.bank_account_id,
    b.txn_date,
    b.amount,
    b.description,
    (current_date - b.txn_date) as age_days
  from public.bank_transactions b
  where b.status = 'unmatched'
    and b.txn_date < current_date - 30;

-- ── 7) IBAN changes — visibility over Faz 19's append-only evidence ────────────────────
create or replace view public.control_iban_changes as
  select
    e.id                       as event_id,
    e.iban_id,
    e.change_type,
    e.changed_at,
    e.before_data,
    e.after_data,
    (e.changed_at > now() - interval '30 days') as is_recent
  from public.iban_change_events e;

-- ── 8) large payments — threshold READ, not reinvented ─────────────────────────────────
--
-- The threshold comes from public.settings, the same number Faz 24A pinned approval_rules to. A
-- second hardcoded figure here would be a second definition of "large".
create or replace view public.control_large_payments as
  with threshold as (
    select coalesce((select (value #>> '{}')::numeric from public.settings
                     where key = 'critical_payment_threshold_try'), 100000) as amount
  )
  select
    i.id                       as payment_instance_id,
    coalesce(p.name, '(kalem)') as payment_name,
    i.due_date,
    i.amount,
    i.currency,
    t.amount                   as threshold_amount
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  cross join threshold t
  where i.amount is not null and i.amount >= t.amount;

-- ── 9) closed-period mutation — GENUINELY NEW, on an anchor that already exists ────────
--
-- The period anchor is cashflow_months.status = 'locked', which has existed since the early
-- phases. (The plan attributes the period lock to Faz 24B; that phase actually delivered
-- role-based RLS — the locking concept predates it. Recorded because the check depends on it.)
create or replace view public.control_closed_period_mutations as
  select
    v.id                       as invoice_id,
    v.invoice_no,
    v.issue_date,
    date_trunc('month', v.issue_date)::date as period_start,
    v.updated_at,
    cm.status                  as period_status
  from public.invoices v
  join public.cashflow_months cm
    on cm.month_start = date_trunc('month', v.issue_date)::date
  where cm.status = 'locked'
    and v.updated_at > cm.updated_at;

-- ── 10) approval bypass — GENUINELY NEW ────────────────────────────────────────────────
--
-- A payment at or above the configured threshold with NO approval row of any round. Faz 24A built
-- the approval entity; nothing until now checked that it was actually used.
create or replace view public.control_approval_bypass as
  with threshold as (
    select coalesce((select (value #>> '{}')::numeric from public.settings
                     where key = 'critical_payment_threshold_try'), 100000) as amount
  )
  select
    i.id                       as payment_instance_id,
    coalesce(p.name, '(kalem)') as payment_name,
    i.amount,
    i.due_date,
    t.amount                   as threshold_amount
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  cross join threshold t
  where i.amount is not null
    and i.amount >= t.amount
    and i.status in ('paid', 'partial')
    and not exists (
      select 1 from public.approvals a
      where a.subject_table = 'payment_instances' and a.subject_id = i.id);

-- ── 11) missing source document ────────────────────────────────────────────────────────
create or replace view public.control_missing_source_document as
  select
    v.id                       as invoice_id,
    v.invoice_no,
    v.issue_date,
    v.gross_amount
  from public.invoices v
  where v.source_workbook_id is null
    and v.status <> 'cancelled';

-- ── 12) anomaly detectors — deterministic rules, named thresholds ──────────────────────
--
-- ROUND NUMBER: a suspiciously round large amount. Genuine invoices rarely land on exact
-- thousands at scale, and fabricated ones frequently do.
create or replace view public.anomaly_round_number_payments as
  select
    i.id                       as payment_instance_id,
    coalesce(p.name, '(kalem)') as payment_name,
    i.amount,
    i.due_date
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  where i.amount is not null
    and i.amount >= 10000
    and mod(i.amount, 1000) = 0;

-- SPLIT PAYMENT: several payments to the same counterparty on the same day, each below the
-- approval threshold but together above it — the classic way an approval gate is walked around.
create or replace view public.anomaly_split_payments as
  with threshold as (
    select coalesce((select (value #>> '{}')::numeric from public.settings
                     where key = 'critical_payment_threshold_try'), 100000) as amount
  )
  select
    p.provider_party_id        as party_id,
    pa.name                    as party_name,
    i.due_date,
    count(*)                   as payment_count,
    sum(i.amount)              as total_amount,
    max(i.amount)              as largest_single,
    t.amount                   as threshold_amount
  from public.payment_instances i
  join public.payments p on p.id = i.payment_id
  left join public.parties pa on pa.id = p.provider_party_id
  cross join threshold t
  where i.amount is not null and p.provider_party_id is not null
  group by p.provider_party_id, pa.name, i.due_date, t.amount
  having count(*) >= 2
     and sum(i.amount) >= t.amount
     and max(i.amount) < t.amount;

-- NEW PAYEE: the first payment ever made to a counterparty. Not wrong, but worth a look.
create or replace view public.anomaly_new_payee as
  select
    p.provider_party_id        as party_id,
    pa.name                    as party_name,
    min(i.due_date)            as first_payment_date,
    count(*)                   as payment_count,
    sum(i.amount)              as total_amount
  from public.payment_instances i
  join public.payments p on p.id = i.payment_id
  left join public.parties pa on pa.id = p.provider_party_id
  where p.provider_party_id is not null and i.amount is not null
  group by p.provider_party_id, pa.name
  having min(i.due_date) > current_date - 90;

-- AMOUNT VS BASELINE: a payment far above what this counterparty has historically received.
-- The baseline is that party's own average, so a large supplier is not flagged for being large.
create or replace view public.anomaly_amount_vs_baseline as
  with party_baseline as (
    select p.provider_party_id as party_id,
           avg(i.amount)       as avg_amount,
           count(*)            as sample_count
    from public.payment_instances i
    join public.payments p on p.id = i.payment_id
    where i.amount is not null and p.provider_party_id is not null
    group by p.provider_party_id
    -- Fewer than four observations is not a baseline; flagging against it would produce noise
    -- from thin history rather than signal.
    having count(*) >= 4
  )
  select
    i.id                       as payment_instance_id,
    pa.name                    as party_name,
    i.amount,
    b.avg_amount,
    b.sample_count,
    round(i.amount / nullif(b.avg_amount, 0), 2) as times_baseline
  from public.payment_instances i
  join public.payments p on p.id = i.payment_id
  join party_baseline b on b.party_id = p.provider_party_id
  left join public.parties pa on pa.id = p.provider_party_id
  where i.amount is not null
    and b.avg_amount > 0
    and i.amount >= b.avg_amount * 3;

-- UNUSUAL RECORD HOUR — named honestly.
--
-- bank_transactions has NO transaction time: only txn_date (a date). Measured, not assumed. So
-- this cannot detect "a payment made at 3am"; it detects a row RECORDED at 3am, which is still a
-- real signal but a different one. The view and its column say so, because calling it a
-- transaction hour would be asserting something the data cannot support.
create or replace view public.anomaly_unusual_record_hour as
  select
    b.id                       as txn_id,
    b.txn_date,
    b.amount,
    b.created_at               as recorded_at,
    extract(hour from b.created_at at time zone 'Europe/Istanbul')::int as recorded_hour,
    'kayıt saati — işlem saati şemada YOK'::text as caveat
  from public.bank_transactions b
  where b.status <> 'ignored'
    and extract(hour from b.created_at at time zone 'Europe/Istanbul') not between 7 and 20;

-- ── 13) the dashboard rollup: PASS / WARNING / CRITICAL ────────────────────────────────
--
-- Every registered control appears, including the ones finding nothing — a control that vanishes
-- when clean is a control nobody notices has broken.
create or replace view public.control_dashboard as
  select
    r.check_code,
    r.title,
    r.default_severity,
    r.enforcement,
    r.rationale,
    coalesce(f.finding_count, 0) as finding_count,
    case
      when coalesce(f.finding_count, 0) = 0 then 'PASS'
      when r.default_severity = 'critical' then 'CRITICAL'
      when r.default_severity = 'warning' then 'WARNING'
      else 'INFO'
    end                        as state
  from public.control_registry r
  left join lateral (
    select case r.check_code
      when 'duplicate_invoice'       then (select count(*) from public.control_duplicate_invoices)
      when 'near_duplicate_bank_txn' then (select count(*) from public.control_near_duplicate_bank_txns)
      when 'allocation_over_invoice' then (select count(*) from public.control_allocation_over_invoice)
      when 'payment_without_invoice' then (select count(*) from public.control_payment_without_invoice)
      when 'unmatched_bank_txn_aged' then (select count(*) from public.control_unmatched_bank_aged)
      when 'unknown_counterparty'    then (select count(*) from public.checks where counterparty_label is not null and payee_party_id is null)
      when 'iban_changed'            then (select count(*) from public.control_iban_changes where is_recent)
      when 'large_payment'           then (select count(*) from public.control_large_payments)
      when 'closed_period_mutation'  then (select count(*) from public.control_closed_period_mutations)
      when 'approval_bypass'         then (select count(*) from public.control_approval_bypass)
      when 'missing_source_document' then (select count(*) from public.control_missing_source_document)
      else 0 end as finding_count
  ) f on true;

grant select on public.control_registry to authenticated;
grant select on public.control_duplicate_invoices to authenticated;
grant select on public.control_near_duplicate_bank_txns to authenticated;
grant select on public.control_allocation_over_invoice to authenticated;
grant select on public.control_payment_without_invoice to authenticated;
grant select on public.control_unmatched_bank_aged to authenticated;
grant select on public.control_iban_changes to authenticated;
grant select on public.control_large_payments to authenticated;
grant select on public.control_closed_period_mutations to authenticated;
grant select on public.control_approval_bypass to authenticated;
grant select on public.control_missing_source_document to authenticated;
grant select on public.anomaly_round_number_payments to authenticated;
grant select on public.anomaly_split_payments to authenticated;
grant select on public.anomaly_new_payee to authenticated;
grant select on public.anomaly_amount_vs_baseline to authenticated;
grant select on public.anomaly_unusual_record_hour to authenticated;
grant select on public.control_dashboard to authenticated;
