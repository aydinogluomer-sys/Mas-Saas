-- 0107 — Faz 54 (F1): Otomatik Beslenen 13 Haftalık Doğrudan Nakit Tahmini Anlık Görüntüleri
-- (`forecast_snapshots_13w`, `forecast_snapshot_13w_lines`) ve Tahmin vs. Gerçekleşen
-- Varyans Özeti Görünümü (`forecast_13w_variance_v`).
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz (scripts/db/migration-lib.ts).
--   * Sıfır kayan nokta (yalnız numeric(14,2)); görünüm WITH (security_invoker = true) taşır.
--   * 5 katmanlı RLS (`operational` sınıfı) ve açık REVOKE/GRANT tanımları.

-- ── 1) public.forecast_snapshots_13w ──────────────────────────────────────────────────────────
create table if not exists public.forecast_snapshots_13w (
  id uuid primary key default gen_random_uuid(),
  snapshot_week_start date not null,
  as_of_date date not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  opening_cash numeric(14,2),
  unknown_opening_count int not null default 0 check (unknown_opening_count >= 0),
  frozen_by uuid references public.users(id) on delete set null,
  frozen_at timestamptz not null default now(),
  unique (snapshot_week_start, currency)
);

create index if not exists idx_forecast_snapshots_13w_week_currency
  on public.forecast_snapshots_13w (snapshot_week_start desc, currency);

create index if not exists idx_forecast_snapshots_13w_frozen_by
  on public.forecast_snapshots_13w (frozen_by)
  where frozen_by is not null;

-- ── 2) public.forecast_snapshot_13w_lines ─────────────────────────────────────────────────────
create table if not exists public.forecast_snapshot_13w_lines (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.forecast_snapshots_13w(id) on delete cascade,
  week_index int not null check (week_index between 1 and 13),
  week_start date not null,
  direction text not null check (direction in ('inflow', 'outflow')),
  category_bucket text not null check (btrim(category_bucket) <> ''),
  source_classification text not null check (
    source_classification in (
      'promised',
      'behavioral_dbt',
      'scheduled',
      'statutory_tax',
      'manual_override'
    )
  ),
  source_entity_table text,
  source_entity_id uuid,
  party_id uuid references public.parties(id) on delete set null,
  label text not null check (btrim(label) <> ''),
  amount numeric(14,2) not null check (amount >= 0)
);

create index if not exists idx_forecast_snapshot_13w_lines_snapshot_week
  on public.forecast_snapshot_13w_lines (snapshot_id, week_index, week_start);

create index if not exists idx_forecast_snapshot_13w_lines_source_entity
  on public.forecast_snapshot_13w_lines (source_entity_table, source_entity_id)
  where source_entity_table is not null and source_entity_id is not null;

create index if not exists idx_forecast_snapshot_13w_lines_party_id
  on public.forecast_snapshot_13w_lines (party_id)
  where party_id is not null;

-- ── 3) public.forecast_13w_variance_v (`security_invoker = true`) ────────────────────────────
create or replace view public.forecast_13w_variance_v
with (security_invoker = true) as
with snapshot_weeks as (
  select
    fs.id as snapshot_id,
    fs.snapshot_week_start,
    fs.as_of_date,
    fs.currency,
    fs.opening_cash,
    fs.unknown_opening_count,
    w.week_index,
    (fs.snapshot_week_start + ((w.week_index - 1) * 7))::date as week_start,
    (fs.snapshot_week_start + ((w.week_index - 1) * 7) + 6)::date as week_end
  from public.forecast_snapshots_13w fs
  cross join generate_series(1, 13) as w(week_index)
),
line_agg as (
  select
    l.snapshot_id,
    l.week_index,
    coalesce(sum(l.amount) filter (where l.direction = 'inflow'), 0)::numeric(14,2) as forecast_inflow,
    coalesce(sum(l.amount) filter (where l.direction = 'outflow'), 0)::numeric(14,2) as forecast_outflow,
    (
      coalesce(sum(l.amount) filter (where l.direction = 'inflow'), 0)
      - coalesce(sum(l.amount) filter (where l.direction = 'outflow'), 0)
    )::numeric(14,2) as forecast_net,
    count(l.id)::int as line_count
  from public.forecast_snapshot_13w_lines l
  group by l.snapshot_id, l.week_index
)
select
  sw.snapshot_id,
  sw.snapshot_week_start,
  sw.as_of_date,
  sw.currency,
  sw.opening_cash,
  sw.unknown_opening_count,
  sw.week_index,
  sw.week_start,
  sw.week_end,
  coalesce(la.forecast_inflow, 0)::numeric(14,2) as forecast_inflow,
  coalesce(la.forecast_outflow, 0)::numeric(14,2) as forecast_outflow,
  coalesce(la.forecast_net, 0)::numeric(14,2) as forecast_net,
  coalesce(la.line_count, 0)::int as forecast_line_count,
  coalesce(bt_agg.actual_inflow, 0)::numeric(14,2) as actual_inflow,
  coalesce(bt_agg.actual_outflow, 0)::numeric(14,2) as actual_outflow,
  coalesce(bt_agg.actual_net, 0)::numeric(14,2) as actual_net,
  (coalesce(bt_agg.actual_net, 0) - coalesce(la.forecast_net, 0))::numeric(14,2) as net_variance
from snapshot_weeks sw
left join line_agg la
  on la.snapshot_id = sw.snapshot_id
 and la.week_index = sw.week_index
left join lateral (
  select
    coalesce(sum(bt.amount) filter (where bt.amount > 0), 0)::numeric(14,2) as actual_inflow,
    coalesce(abs(sum(bt.amount) filter (where bt.amount < 0)), 0)::numeric(14,2) as actual_outflow,
    coalesce(sum(bt.amount), 0)::numeric(14,2) as actual_net
  from public.bank_transactions bt
  where bt.txn_date between sw.week_start and sw.week_end
    and bt.currency = sw.currency
    and bt.status <> 'ignored'
    and coalesce(bt.transaction_kind, 'standard') <> 'own_transfer'
) bt_agg on true;

alter view public.forecast_13w_variance_v set (security_invoker = true);

revoke insert, update, delete, truncate on public.forecast_13w_variance_v from
  public, anon, authenticated, mas_radar_app,
  mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
  mas_radar_finance_manager, mas_radar_admin;

grant select on public.forecast_13w_variance_v to
  mas_radar_app,
  mas_radar_viewer,
  mas_radar_finance_operator,
  mas_radar_finance_approver,
  mas_radar_finance_manager,
  mas_radar_admin;

-- ── 4) 5-Katmanlı RLS Politikaları (`operational` sınıfı) ────────────────────────────────────
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'forecast_snapshots_13w',
    'forecast_snapshot_13w_lines'
  ] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('alter table public.%I force row level security', tbl);
    execute format('revoke all on public.%I from public, anon, authenticated, mas_radar_app', tbl);

    execute format(
      'grant select on table public.%I to mas_radar_viewer, mas_radar_finance_operator, '
      || 'mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
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

    execute format('drop policy if exists %I on public.%I', tbl || '_tier_select', tbl);
    execute format(
      'create policy %I on public.%I for select to '
      || 'mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin '
      || 'using (true)',
      tbl || '_tier_select',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_tier_insert', tbl);
    execute format(
      'create policy %I on public.%I for insert to '
      || 'mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin '
      || 'with check (true)',
      tbl || '_tier_insert',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_tier_update', tbl);
    execute format(
      'create policy %I on public.%I for update to '
      || 'mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin '
      || 'using (true) with check (true)',
      tbl || '_tier_update',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_tier_delete', tbl);
    execute format(
      'create policy %I on public.%I for delete to '
      || 'mas_radar_finance_manager, mas_radar_admin '
      || 'using (true)',
      tbl || '_tier_delete',
      tbl
    );
  end loop;
end $$;

-- ── 5) Faz 56 (F3) Yabancı Anahtar (FK) İndeks Hijyeni (perf-gate ≤ 115 cırcırı) ─────────────
create index if not exists idx_checks_collateral_record_id
  on public.checks (collateral_record_id) where collateral_record_id is not null;
create index if not exists idx_check_bordros_created_by
  on public.check_bordros (created_by) where created_by is not null;
create index if not exists idx_check_events_check_id
  on public.check_events (check_id);
create index if not exists idx_check_events_created_by
  on public.check_events (created_by) where created_by is not null;
create index if not exists idx_payment_run_items_party_id
  on public.payment_run_items (party_id) where party_id is not null;
create index if not exists idx_payment_run_items_iban_id
  on public.payment_run_items (iban_id) where iban_id is not null;
create index if not exists idx_payment_runs_approved_by
  on public.payment_runs (approved_by) where approved_by is not null;
create index if not exists idx_payment_runs_created_by
  on public.payment_runs (created_by) where created_by is not null;
create index if not exists idx_import_external_keys_first_wb
  on public.import_external_keys (first_seen_workbook_id) where first_seen_workbook_id is not null;
create index if not exists idx_import_external_keys_last_wb
  on public.import_external_keys (last_seen_workbook_id) where last_seen_workbook_id is not null;
create index if not exists idx_checks_account_id
  on public.checks (account_id) where account_id is not null;
create index if not exists idx_checks_payer_party_id
  on public.checks (payer_party_id) where payer_party_id is not null;
create index if not exists idx_checks_payee_party_id
  on public.checks (payee_party_id) where payee_party_id is not null;
create index if not exists idx_checks_bank_party_id
  on public.checks (bank_party_id) where bank_party_id is not null;
create index if not exists idx_payments_cash_account_id
  on public.payments (cash_account_id) where cash_account_id is not null;
create index if not exists idx_payments_category_id
  on public.payments (category_id) where category_id is not null;
create index if not exists idx_loans_lender_party_id
  on public.loans (lender_party_id) where lender_party_id is not null;
create index if not exists idx_covenant_records_loan_id
  on public.covenant_records (loan_id) where loan_id is not null;
create index if not exists idx_covenant_records_facility_id
  on public.covenant_records (facility_id) where facility_id is not null;
create index if not exists idx_facility_drawdowns_loan_id
  on public.facility_drawdowns (loan_id) where loan_id is not null;


