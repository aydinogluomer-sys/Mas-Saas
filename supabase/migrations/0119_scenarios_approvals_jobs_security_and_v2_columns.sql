-- 0119 — Faz 60 (M-13..M-19, M-32, M-44, M-50..M-68): Birleşik Dinamik Senaryo Haftalık Kırılımı
-- (scenario_run_weeks), Ödeme & Fatura Split-Brain Kapatma Kolonları, Görev/MFA/Oturum/İş Kuyruğu
-- Zırhı, Genişletilmiş Arşiv Kapsamı ve V2 Standart İçe Aktarım Kalıcılık Kolonları.
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz.
--   * Sıfır kayan nokta (yalnız numeric); tüm yeni FK kolonları B-tree indeks taşır.
--   * phase19:verify kuralı: orders, projects, products, departments, cost_centers tablolarına
--     'status', 'state' veya 'lifecycle' adında kolon eklenmez (fulfillment_stage kullanılır).

-- ── 1) Birleşik Dinamik Senaryo Haftalık Kırılımı (scenario_run_weeks — derived sınıfı) ───────
create table if not exists public.scenario_run_weeks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.scenario_runs(id) on delete cascade,
  week_index int not null check (week_index between 1 and 52),
  week_start date not null,
  baseline_inflow numeric(14,2) not null default 0,
  baseline_outflow numeric(14,2) not null default 0,
  baseline_closing_cash numeric(14,2),
  scenario_inflow numeric(14,2) not null default 0,
  scenario_outflow numeric(14,2) not null default 0,
  auto_facility_draw numeric(14,2) not null default 0 check (auto_facility_draw >= 0),
  incremental_interest_tax numeric(14,2) not null default 0 check (incremental_interest_tax >= 0),
  scenario_closing_cash numeric(14,2),
  remaining_facility_headroom numeric(14,2),
  projected_dscr numeric(10,4),
  covenant_breach boolean not null default false,
  created_at timestamptz not null default now(),
  unique (run_id, week_index)
);

create index if not exists idx_scenario_run_weeks_run_id on public.scenario_run_weeks (run_id);

alter table public.scenario_runs
  add column if not exists total_auto_facility_draw numeric(14,2) default 0,
  add column if not exists total_incremental_interest_tax numeric(14,2) default 0,
  add column if not exists deferred_receivables_carryover numeric(14,2) default 0,
  add column if not exists projected_ebitda_try numeric(14,2),
  add column if not exists projected_min_dscr numeric(10,4),
  add column if not exists covenant_breach_count int not null default 0;

-- ── 2) Ödemeler (/payments) & Faturalar (/invoices) Split-Brain ve Çoklu Satır Genişletmeleri ─
alter table public.payments
  add column if not exists iban text,
  add column if not exists tdhp_expense_code text default '770',
  add column if not exists auto_match_vkn text;

alter table public.payment_instances
  add column if not exists linked_invoice_id uuid references public.invoices(id) on delete set null,
  add column if not exists bank_transaction_id uuid references public.bank_transactions(id) on delete set null,
  add column if not exists journal_entry_id uuid references public.management_journal_entries(id) on delete set null;

create index if not exists idx_payment_instances_linked_invoice_id
  on public.payment_instances (linked_invoice_id) where linked_invoice_id is not null;
create index if not exists idx_payment_instances_bank_txn_id
  on public.payment_instances (bank_transaction_id) where bank_transaction_id is not null;
create index if not exists idx_payment_instances_journal_entry_id
  on public.payment_instances (journal_entry_id) where journal_entry_id is not null;

alter table public.invoices
  add column if not exists discount_total numeric(14,2) not null default 0 check (discount_total >= 0),
  add column if not exists income_tax_withholding_total numeric(14,2) not null default 0 check (income_tax_withholding_total >= 0),
  add column if not exists ubl_uuid text,
  add column if not exists source_document_id uuid references public.documents(id) on delete set null,
  add column if not exists is_doubtful boolean not null default false,
  add column if not exists doubtful_provision_entry_id uuid references public.management_journal_entries(id) on delete set null,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text,
  add column if not exists archived_by_label text;

create unique index if not exists idx_invoices_ubl_uuid_uq
  on public.invoices (ubl_uuid) where ubl_uuid is not null;
create index if not exists idx_invoices_source_document_id
  on public.invoices (source_document_id) where source_document_id is not null;
create index if not exists idx_invoices_doubtful_je_id
  on public.invoices (doubtful_provision_entry_id) where doubtful_provision_entry_id is not null;

alter table public.invoice_lines
  add column if not exists discount_rate numeric(6,4) default 0 check (discount_rate is null or (discount_rate >= 0 and discount_rate <= 1)),
  add column if not exists discount_amount numeric(14,2) default 0 check (discount_amount is null or discount_amount >= 0),
  add column if not exists income_tax_withholding_rate numeric(6,4) default 0 check (income_tax_withholding_rate is null or (income_tax_withholding_rate >= 0 and income_tax_withholding_rate <= 1)),
  add column if not exists income_tax_withholding_amount numeric(14,2) default 0 check (income_tax_withholding_amount is null or income_tax_withholding_amount >= 0),
  add column if not exists cost_center_id uuid references public.cost_centers(id) on delete set null,
  add column if not exists project_id uuid references public.projects(id) on delete set null;

create index if not exists idx_invoice_lines_cost_center_id
  on public.invoice_lines (cost_center_id) where cost_center_id is not null;
create index if not exists idx_invoice_lines_project_id
  on public.invoice_lines (project_id) where project_id is not null;

-- ── 3) Kredi Limitleri, Cariler, Banka Hesapları & Dokümanlar Arşiv + Çıkarım Metaverisi ───────
alter table public.credit_facilities
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text,
  add column if not exists archived_by_label text;

alter table public.parties
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text,
  add column if not exists archived_by_label text;

alter table public.cash_accounts
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text,
  add column if not exists archived_by_label text;

alter table public.documents
  add column if not exists extracted_metadata jsonb,
  add column if not exists storage_backend text not null default 'local_cas'
    check (storage_backend in ('local_cas', 's3_worm')),
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text,
  add column if not exists archived_by_label text;

drop trigger if exists invoices_archived_immutability on public.invoices;
create trigger invoices_archived_immutability
  before update on public.invoices
  for each row execute function public.archive_metadata_immutability_guard();

drop trigger if exists credit_facilities_archived_immutability on public.credit_facilities;
create trigger credit_facilities_archived_immutability
  before update on public.credit_facilities
  for each row execute function public.archive_metadata_immutability_guard();

drop trigger if exists parties_archived_immutability on public.parties;
create trigger parties_archived_immutability
  before update on public.parties
  for each row execute function public.archive_metadata_immutability_guard();

drop trigger if exists cash_accounts_archived_immutability on public.cash_accounts;
create trigger cash_accounts_archived_immutability
  before update on public.cash_accounts
  for each row execute function public.archive_metadata_immutability_guard();

drop trigger if exists documents_archived_immutability on public.documents;
create trigger documents_archived_immutability
  before update on public.documents
  for each row execute function public.archive_metadata_immutability_guard();

-- ── 4) Görevler (action_items), Hatırlatıcılar, Güvenlik (TOTP MFA / IP) ve İş Kuyruğu ───────
alter table public.action_items
  add column if not exists owner_user_id uuid references public.users(id) on delete set null,
  add column if not exists auto_close_on_settlement boolean not null default true;

create index if not exists idx_action_items_owner_user_id
  on public.action_items (owner_user_id) where owner_user_id is not null;

-- reminders.target_kind kapsamına invoice ve covenant_record eklenmesi
do $$
declare
  v_attnum smallint;
  r record;
begin
  select a.attnum into v_attnum
    from pg_attribute a
   where a.attrelid = 'public.reminders'::regclass
     and a.attname = 'target_kind'
     and not a.attisdropped;

  if v_attnum is not null then
    for r in
      select c.conname
        from pg_constraint c
       where c.conrelid = 'public.reminders'::regclass
         and c.contype = 'c'
         and c.conkey = array[v_attnum]
    loop
      execute format('alter table public.reminders drop constraint %I', r.conname);
    end loop;

    alter table public.reminders
      add constraint reminders_target_kind_check
      check (target_kind in (
        'payment_instance',
        'check',
        'loan_installment',
        'invoice',
        'promise_to_pay',
        'covenant_record'
      ));
  end if;
end $$;

alter table public.users
  add column if not exists email text check (email is null or btrim(email) <> ''),
  add column if not exists totp_secret_encrypted text,
  add column if not exists totp_enabled_at timestamptz;

alter table public.sessions
  add column if not exists ip_address text,
  add column if not exists user_agent text;

alter table public.background_jobs
  add column if not exists heartbeat_at timestamptz,
  add column if not exists artifact_document_id uuid references public.documents(id) on delete set null;

create index if not exists idx_background_jobs_artifact_doc_id
  on public.background_jobs (artifact_document_id) where artifact_document_id is not null;

-- ── 5) V2 Standart Şablon Kalıcılık Kolonları (phase19 uyumlu: status/state/lifecycle YOK) ───
alter table public.orders
  add column if not exists order_amount numeric(14,2) check (order_amount is null or order_amount >= 0),
  add column if not exists currency text default 'TRY' check (currency is null or currency ~ '^[A-Z]{3}$'),
  add column if not exists expected_delivery_date date,
  add column if not exists fulfillment_stage text default 'open';

alter table public.products
  add column if not exists unit text default 'ADET',
  add column if not exists unit_cost numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  add column if not exists unit_price numeric(14,4) check (unit_price is null or unit_price >= 0),
  add column if not exists currency text default 'TRY' check (currency is null or currency ~ '^[A-Z]{3}$');

alter table public.projects
  add column if not exists contract_value numeric(14,2) check (contract_value is null or contract_value >= 0),
  add column if not exists budget_cost numeric(14,2) check (budget_cost is null or budget_cost >= 0),
  add column if not exists currency text default 'TRY' check (currency is null or currency ~ '^[A-Z]{3}$'),
  add column if not exists start_date date,
  add column if not exists end_date date;

alter table public.cashflow_lines
  add column if not exists currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$');

-- ── 6) scenario_run_weeks RLS & GRANT (derived sınıfı) ────────────────────────────────────────
alter table public.scenario_run_weeks enable row level security;
revoke all on table public.scenario_run_weeks from public, anon, authenticated, mas_radar_app;
grant select on table public.scenario_run_weeks
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin;
grant insert, update on table public.scenario_run_weeks
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin;
grant delete on table public.scenario_run_weeks
  to mas_radar_finance_manager, mas_radar_admin;

drop policy if exists scenario_run_weeks_select_all_tiers on public.scenario_run_weeks;
create policy scenario_run_weeks_select_all_tiers on public.scenario_run_weeks
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin
  using (true);
drop policy if exists scenario_run_weeks_insert_enter on public.scenario_run_weeks;
create policy scenario_run_weeks_insert_enter on public.scenario_run_weeks
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (true);
drop policy if exists scenario_run_weeks_update_enter on public.scenario_run_weeks;
create policy scenario_run_weeks_update_enter on public.scenario_run_weeks
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists scenario_run_weeks_delete_manage on public.scenario_run_weeks;
create policy scenario_run_weeks_delete_manage on public.scenario_run_weeks
  for delete to mas_radar_finance_manager, mas_radar_admin
  using (true);
