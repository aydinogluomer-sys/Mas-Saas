-- Faz 53 (E3) — Mali Müşavir Yasal Mizan İçe Aktarımı ve 12 Kök Nedenli Yönetim ↔ Yasal Mizan Mutabakat Köprüsü (0106)
--
-- Tablolar (tümü 'operational' RLS sınıfında):
--   1. public.statutory_trial_balances
--   2. public.statutory_trial_balance_lines
--   3. public.trial_balance_reconciliation_runs
--   4. public.trial_balance_reconciliation_items

-- ═══════════════════════════════════════════════════════════════════════════════════════
-- 1. public.statutory_trial_balances
-- ═══════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.statutory_trial_balances (
  id uuid primary key default gen_random_uuid(),
  as_of_date date not null,
  period_label text not null check (length(btrim(period_label)) > 0),
  source_software text,
  original_filename text not null check (length(btrim(original_filename)) > 0),
  file_sha256 text not null check (length(btrim(file_sha256)) > 0),
  total_debit_try numeric(16,2) not null check (total_debit_try >= 0),
  total_credit_try numeric(16,2) not null check (total_credit_try >= 0),
  is_self_balanced boolean generated always as (total_debit_try = total_credit_try) stored,
  imported_by uuid not null references public.users(id),
  imported_at timestamptz not null default now()
);

create index if not exists statutory_trial_balances_as_of_date_idx
  on public.statutory_trial_balances (as_of_date desc, imported_at desc);

create index if not exists statutory_trial_balances_imported_by_idx
  on public.statutory_trial_balances (imported_by);

-- ═══════════════════════════════════════════════════════════════════════════════════════
-- 2. public.statutory_trial_balance_lines
-- ═══════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.statutory_trial_balance_lines (
  id uuid primary key default gen_random_uuid(),
  trial_balance_id uuid not null references public.statutory_trial_balances(id) on delete cascade,
  account_code text not null check (length(btrim(account_code)) > 0),
  tdhp_root_code text not null check (tdhp_root_code ~ '^[1-9][0-9]{2}$'),
  account_name text not null check (length(btrim(account_name)) > 0),
  is_leaf boolean not null default true,
  debit_total_try numeric(16,2) not null default 0 check (debit_total_try >= 0),
  credit_total_try numeric(16,2) not null default 0 check (credit_total_try >= 0),
  debit_balance_try numeric(16,2) not null default 0 check (debit_balance_try >= 0),
  credit_balance_try numeric(16,2) not null default 0 check (credit_balance_try >= 0),
  constraint statutory_trial_balance_lines_unique_code unique (trial_balance_id, account_code)
);

create index if not exists statutory_trial_balance_lines_tb_leaf_root_idx
  on public.statutory_trial_balance_lines (trial_balance_id, is_leaf, tdhp_root_code);

-- ═══════════════════════════════════════════════════════════════════════════════════════
-- 3. public.trial_balance_reconciliation_runs
-- ═══════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.trial_balance_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  statutory_trial_balance_id uuid not null references public.statutory_trial_balances(id) on delete cascade,
  as_of_date date not null,
  management_total_debit_try numeric(16,2) not null default 0,
  management_total_credit_try numeric(16,2) not null default 0,
  statutory_total_debit_try numeric(16,2) not null default 0,
  statutory_total_credit_try numeric(16,2) not null default 0,
  management_ebitda_try numeric(16,2) not null default 0,
  statutory_690_ebt_try numeric(16,2) not null default 0,
  ebitda_to_690_bridge_json jsonb not null default '{}'::jsonb,
  matched_group_count int not null default 0 check (matched_group_count >= 0),
  discrepancy_group_count int not null default 0 check (discrepancy_group_count >= 0),
  created_by uuid references public.users(id),
  created_at timestamptz not null default now()
);

create index if not exists trial_balance_reconciliation_runs_tb_idx
  on public.trial_balance_reconciliation_runs (statutory_trial_balance_id, created_at desc);

create index if not exists trial_balance_reconciliation_runs_created_by_idx
  on public.trial_balance_reconciliation_runs (created_by);

-- ═══════════════════════════════════════════════════════════════════════════════════════
-- 4. public.trial_balance_reconciliation_items
-- ═══════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.trial_balance_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.trial_balance_reconciliation_runs(id) on delete cascade,
  tdhp_group_code text not null check (length(btrim(tdhp_group_code)) > 0),
  tdhp_group_name text not null check (length(btrim(tdhp_group_name)) > 0),
  management_net_try numeric(16,2) not null default 0,
  statutory_net_try numeric(16,2) not null default 0,
  delta_try numeric(16,2) not null default 0,
  root_cause_code text not null check (
    root_cause_code in (
      'MATCHED',
      'CASH_100_INFLATION',
      'CHECK_ENDORSEMENT_OR_CLEARING_LAG',
      'UNBOOKED_BANK_TXN_OR_FX',
      'ISSUED_CHECK_NOT_DELIVERED_TO_CPA',
      'CUTOFF_UNBILLED_OR_UNALLOCATED_CASH',
      'PARTNER_ACCOUNT_PLUG',
      'VAT_TAHAKKUK_UNCLOSED',
      'LOAN_PRINCIPAL_VS_GROSS_INSTALLMENT',
      'MISSING_PURCHASE_INVOICE',
      'PAYROLL_ADVANCE_OR_EXPENSE_GAP',
      'UNPAID_OR_RESTRUCTURED_TAX_DEBT',
      'MANAGEMENT_EBITDA_TO_STATUTORY_690_BRIDGE',
      'OTHER_TDHP_TIMING_GAP'
    )
  ),
  severity text not null check (severity in ('match', 'info', 'warning', 'critical')),
  explanation text not null,
  candidate_evidence_json jsonb not null default '[]'::jsonb,
  action_item_id uuid references public.action_items(id),
  created_at timestamptz not null default now(),
  constraint trial_balance_reconciliation_items_unique_group unique (run_id, tdhp_group_code)
);

create index if not exists trial_balance_reconciliation_items_run_idx
  on public.trial_balance_reconciliation_items (run_id, severity);

create index if not exists trial_balance_reconciliation_items_action_item_idx
  on public.trial_balance_reconciliation_items (action_item_id);

-- ═══════════════════════════════════════════════════════════════════════════════════════
-- 5. 5-Katmanlı RLS Politikaları ('operational' sınıfı)
-- ═══════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'statutory_trial_balances',
    'statutory_trial_balance_lines',
    'trial_balance_reconciliation_runs',
    'trial_balance_reconciliation_items'
  ] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('alter table public.%I force row level security', tbl);

    execute format(
      'grant select on public.%I to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      tbl
    );
    execute format(
      'grant insert, update on public.%I to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin',
      tbl
    );
    execute format(
      'grant delete on public.%I to mas_radar_finance_manager, mas_radar_admin',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_tier_select', tbl);
    execute format(
      'create policy %I on public.%I for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_tier_select',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_tier_insert', tbl);
    execute format(
      'create policy %I on public.%I for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true)',
      tbl || '_tier_insert',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_tier_update', tbl);
    execute format(
      'create policy %I on public.%I for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin using (true) with check (true)',
      tbl || '_tier_update',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_tier_delete', tbl);
    execute format(
      'create policy %I on public.%I for delete to mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_tier_delete',
      tbl
    );
  end loop;
end;
$$;

