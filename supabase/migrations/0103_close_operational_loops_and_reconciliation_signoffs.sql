-- 0103 — Faz 50 (D4): Kalan Tüm "Ekran Var Veri Yolu Yok" Modüllerinin Kapatılması
-- (Rotatif Kredi Hareketleri facility_movements, Dönem Mutabakat İmzalama reconciliation_signoffs,
--  Organizasyonel Boyut / department_id İşlem Bağlantısı, Tahsilat Sözü Kesinleştirme,
--  Doküman Kasası original_filename + Genişletilmiş Bağlantı Varlıkları,
--  Üretim V2 Tam Alan Kalıcılığı cost_model_items ve working_capital_monthly_v Okuma Modeli).
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz (scripts/db/migration-lib.ts).
--   * Sıfır kayan nokta (yalnız numeric); tüm görünümler WITH (security_invoker = true) taşır.
--   * Mevcut CHECK kısıtları ad varsayılmadan conkey üzerinden yapısal hedeflenir.
--   * Her yeni yabancı anahtar (FK) kolonu için B-tree indeks tanımlanır (unindexedForeignKeys = 0).

-- ── 1) Rotatif kredi kullanım / geri ödeme / limit revizyonu: public.facility_movements ───────
alter table public.credit_facilities
  add column if not exists drawn_amount numeric(14,2) not null default 0
    check (drawn_amount >= 0);

update public.credit_facilities f
   set drawn_amount = greatest(
     0,
     coalesce((
       select sum(d.signed_amount)
         from public.facility_drawdowns d
        where d.facility_id = f.id
          and d.currency = f.currency
     ), 0)
   );

create table if not exists public.facility_movements (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.credit_facilities(id) on delete cascade,
  movement_type text not null
    check (movement_type in ('drawdown', 'repayment', 'limit_revision')),
  movement_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  bank_tx_id uuid references public.bank_transactions(id) on delete set null,
  notes text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_facility_movements_facility_date
  on public.facility_movements (facility_id, movement_date desc);
create index if not exists idx_facility_movements_bank_tx
  on public.facility_movements (bank_tx_id)
  where bank_tx_id is not null;
create index if not exists idx_facility_movements_created_by
  on public.facility_movements (created_by)
  where created_by is not null;

-- Kilitli döneme geçmiş tarihli kredi hareketi yazılmasını engelle (0100 kalkanı ile uyumlu)
create or replace function public.enforce_facility_movements_period_lock()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('DELETE', 'UPDATE') then
    perform public.assert_date_not_in_locked_period(old.movement_date, 'facility_movements');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.assert_date_not_in_locked_period(new.movement_date, 'facility_movements');
    return new;
  end if;
  return old;
end $$;

drop trigger if exists facility_movements_closed_period_lock on public.facility_movements;
create trigger facility_movements_closed_period_lock
  before insert or update or delete on public.facility_movements
  for each row execute function public.enforce_facility_movements_period_lock();

-- Atomik limit aşımı ve negatif kullanım korumalı drawn_amount / limit_amount senkronizasyonu
create or replace function public.facility_movements_sync_facility()
returns trigger
language plpgsql
as $$
declare
  v_limit numeric(14,2);
  v_drawn numeric(14,2);
  v_currency text;
  v_status text;
begin
  select f.limit_amount, f.drawn_amount, f.currency, f.status
    into v_limit, v_drawn, v_currency, v_status
    from public.credit_facilities f
   where f.id = new.facility_id
     for update;

  if not found then
    raise exception 'Kredi limiti bulunamadı (%).', new.facility_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.currency <> v_currency then
    raise exception 'Kredi hareketi para birimi (%) kredi limiti para birimiyle (%) eşleşmiyor.',
      new.currency, v_currency
      using errcode = 'check_violation';
  end if;

  if new.movement_type = 'drawdown' then
    if v_status <> 'active' then
      raise exception 'Aktif olmayan kredi limitinden (%) kullanım yapılamaz (durum: %).',
        new.facility_id, v_status
        using errcode = 'check_violation';
    end if;
    if v_drawn + new.amount > v_limit then
      raise exception 'Kredi limiti aşımı: mevcut kullanım (%) + çekiş (%) > toplam limit (%).',
        v_drawn, new.amount, v_limit
        using errcode = 'check_violation';
    end if;
    update public.credit_facilities
       set drawn_amount = v_drawn + new.amount
     where id = new.facility_id;
  elsif new.movement_type = 'repayment' then
    if v_drawn - new.amount < 0 then
      raise exception 'Geri ödeme kullanılan bakiyeyi aşamaz: mevcut kullanım (%) < geri ödeme (%).',
        v_drawn, new.amount
        using errcode = 'check_violation';
    end if;
    update public.credit_facilities
       set drawn_amount = v_drawn - new.amount
     where id = new.facility_id;
  elsif new.movement_type = 'limit_revision' then
    if new.amount < v_drawn then
      raise exception 'Yeni kredi limiti (%) mevcut kullanılan bakiyenin (%) altına düşürülemez.',
        new.amount, v_drawn
        using errcode = 'check_violation';
    end if;
    update public.credit_facilities
       set limit_amount = new.amount
     where id = new.facility_id;
  end if;

  return new;
end $$;

drop trigger if exists facility_movements_after_insert_sync on public.facility_movements;
create trigger facility_movements_after_insert_sync
  after insert on public.facility_movements
  for each row execute function public.facility_movements_sync_facility();

-- credit_facility_utilization: hem eski facility_drawdowns hem yeni facility_movements akışını
-- aynı para birimi disiplininde birleştirir (0094 kolon sırası birebir korunur).
create or replace view public.credit_facility_utilization
with (security_invoker = true) as
  with all_movements as (
    select
      d.id,
      d.facility_id,
      d.movement_date,
      d.currency,
      d.signed_amount
    from public.facility_drawdowns d
    union all
    select
      m.id,
      m.facility_id,
      m.movement_date,
      m.currency,
      case when m.movement_type = 'drawdown' then m.amount else -m.amount end as signed_amount
    from public.facility_movements m
    where m.movement_type in ('drawdown', 'repayment')
  )
  select
    f.id                                            as facility_id,
    f.name                                          as facility_name,
    f.facility_type,
    f.currency,
    f.status,
    p.name                                          as lender_name,
    f.limit_amount,
    f.interest_rate,
    f.start_date,
    f.expiry_date,
    f.review_date,
    coalesce(sum(d.signed_amount) filter (where d.currency = f.currency), 0)               as drawn_amount,
    greatest(0, f.limit_amount - coalesce(sum(d.signed_amount) filter (where d.currency = f.currency), 0)) as available_amount,
    case
      when f.limit_amount = 0 then null
      else round(coalesce(sum(d.signed_amount) filter (where d.currency = f.currency), 0) / f.limit_amount, 4)
    end                                             as utilization_ratio,
    (coalesce(sum(d.signed_amount) filter (where d.currency = f.currency), 0) > f.limit_amount) as over_limit,
    count(d.id)                                     as movement_count,
    max(d.movement_date)                            as last_movement_date,
    case
      when f.expiry_date is null then null
      else (f.expiry_date - current_date)
    end                                             as days_to_expiry,
    count(d.id) filter (where d.currency <> f.currency) as foreign_drawdown_count
  from public.credit_facilities f
  left join public.parties p on p.id = f.lender_party_id
  left join all_movements d on d.facility_id = f.id
  group by f.id, f.name, f.facility_type, f.currency, f.status, p.name,
           f.limit_amount, f.interest_rate, f.start_date, f.expiry_date, f.review_date;

-- ── 2) Dönem mutabakat imzalama kanıt defteri: public.reconciliation_signoffs (evidence) ───────
create table if not exists public.reconciliation_signoffs (
  id uuid primary key default gen_random_uuid(),
  period_month date not null
    check (period_month = date_trunc('month', period_month)::date),
  scope text not null
    check (scope in ('bank_cash', 'ar_ap', 'workbook_source', 'trial_balance')),
  status text not null
    check (status in ('signed_clean', 'signed_with_exceptions')),
  open_exception_count int not null default 0
    check (open_exception_count >= 0),
  notes text,
  signed_by uuid not null references public.users(id) on delete restrict,
  signed_at timestamptz not null default now(),

  constraint reconciliation_signoffs_clean_zero_exceptions check (
    status <> 'signed_clean' or open_exception_count = 0
  ),
  constraint reconciliation_signoffs_exception_notes_required check (
    status <> 'signed_with_exceptions' or (notes is not null and btrim(notes) <> '')
  )
);

create index if not exists idx_reconciliation_signoffs_period_scope
  on public.reconciliation_signoffs (period_month desc, scope, signed_at desc);
create index if not exists idx_reconciliation_signoffs_signed_by
  on public.reconciliation_signoffs (signed_by);

create or replace function public.reconciliation_signoffs_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'reconciliation_signoffs append-only: imzalanmış mutabakat kanıtı değiştirilemez veya silinemez'
    using errcode = 'check_violation';
end $$;

drop trigger if exists reconciliation_signoffs_no_update on public.reconciliation_signoffs;
create trigger reconciliation_signoffs_no_update
  before update on public.reconciliation_signoffs
  for each row execute function public.reconciliation_signoffs_append_only();

drop trigger if exists reconciliation_signoffs_no_delete on public.reconciliation_signoffs;
create trigger reconciliation_signoffs_no_delete
  before delete on public.reconciliation_signoffs
  for each row execute function public.reconciliation_signoffs_append_only();

-- ── 3) public.promise_to_pay fatura bağlantısı ve ISO para birimi kısıtı kesinleştirme ─────────
alter table public.promise_to_pay
  add column if not exists invoice_id uuid references public.invoices(id),
  add column if not exists currency text not null default 'TRY';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.promise_to_pay'::regclass
       and conname = 'promise_to_pay_currency_iso_chk'
  ) then
    alter table public.promise_to_pay
      add constraint promise_to_pay_currency_iso_chk
      check (currency ~ '^[A-Z]{3}$');
  end if;
end $$;

create index if not exists idx_promise_to_pay_invoice_id
  on public.promise_to_pay (invoice_id)
  where invoice_id is not null;

-- ── 4) Doküman kasası: documents.original_filename + document_links genişletilmiş hedefler ─────
alter table public.documents
  add column if not exists original_filename text
    check (original_filename is null or btrim(original_filename) <> '');

create or replace view public.document_current_version
with (security_invoker = true) as
  select d.id                                                                   as document_id,
         d.title,
         d.doc_type,
         d.tags,
         d.status,
         a.id                                                                   as attachment_id,
         a.version_no,
         coalesce(a.original_filename, d.original_filename)                     as original_filename,
         a.storage_path,
         a.file_sha256,
         a.byte_size,
         a.mime_type,
         a.uploaded_at,
         (select count(*)::int from public.attachments x where x.document_id = d.id) as version_count
    from public.documents d
    left join lateral (
      select * from public.attachments a2
       where a2.document_id = d.id
       order by a2.version_no desc
       limit 1
    ) a on true;

do $$
declare
  v_attnum smallint;
  r record;
begin
  select a.attnum into v_attnum
    from pg_attribute a
   where a.attrelid = 'public.document_links'::regclass
     and a.attname = 'entity_table'
     and not a.attisdropped;

  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.document_links'::regclass
       and c.contype = 'c'
       and c.conkey = array[v_attnum]
  loop
    execute format('alter table public.document_links drop constraint %I', r.conname);
  end loop;

  alter table public.document_links
    add constraint document_links_entity_table_check
    check (entity_table in (
      'invoices',
      'payment_instances',
      'payments',
      'checks',
      'check_bordros',
      'loans',
      'credit_facilities',
      'reconciliation_signoffs',
      'bank_transactions',
      'parties',
      'contracts_placeholder'
    ));
end $$;

-- ── 5) Organizasyonel boyutlar: invoices / invoice_lines / payments -> department_id vb. ───────
alter table public.invoices
  add column if not exists department_id uuid references public.departments(id) on delete set null;
alter table public.invoice_lines
  add column if not exists department_id uuid references public.departments(id) on delete set null;
alter table public.payments
  add column if not exists cost_center_id uuid references public.cost_centers(id) on delete set null,
  add column if not exists project_id uuid references public.projects(id) on delete set null,
  add column if not exists department_id uuid references public.departments(id) on delete set null;

create index if not exists idx_invoices_department_id
  on public.invoices (department_id)
  where department_id is not null;
create index if not exists idx_invoice_lines_department_id
  on public.invoice_lines (department_id)
  where department_id is not null;
create index if not exists idx_payments_cost_center_id
  on public.payments (cost_center_id)
  where cost_center_id is not null;
create index if not exists idx_payments_project_id
  on public.payments (project_id)
  where project_id is not null;
create index if not exists idx_payments_department_id
  on public.payments (department_id)
  where department_id is not null;

-- budget_actuals_monthly: mevcut 7 kolon sırası korunur, department_id 8. kolon olarak eklenir
create or replace view public.budget_actuals_monthly
with (security_invoker = true) as
  select
    date_trunc('month', v.issue_date)::date                            as period_start,
    case when v.direction = 'sales' then 'income' else 'expense' end   as direction,
    v.cost_center_id,
    v.project_id,
    v.currency,
    sum(v.gross_amount)                                                as actual_amount,
    count(*)                                                           as document_count,
    v.department_id
  from public.invoices v
  where v.status <> 'cancelled'
    and v.issue_date is not null
    and v.gross_amount is not null
  group by 1, 2, v.cost_center_id, v.project_id, v.currency, v.department_id;

-- budget_vs_actual: 0099 yıllık (period_kind = 'annual') 12-ay kuruş-tam dağılımını ve el.period_kind
-- kolonunu birebir korur; departman, proje, masraf merkezi, kategori ve şirket geneli onaylı satırları ölçer;
-- eşleşen fatura/ödeme yoksa NULL (BLANK != ZERO) ve 'not_measured' disiplinini korur.
create or replace view public.budget_vs_actual
with (security_invoker = true) as
  with expanded_lines as (
    select
      b.id                                    as budget_id,
      b.name                                  as budget_name,
      b.fiscal_year,
      b.period_kind,
      l.id                                    as budget_line_id,
      case
        when b.period_kind = 'annual' then make_date(b.fiscal_year, gs.m, 1)
        else l.period_start
      end                                     as period_start,
      l.direction,
      l.cost_center_id,
      l.department_id,
      l.project_id,
      l.category_id,
      l.currency,
      (case
        when b.period_kind = 'annual' and gs.m < 12 then round(l.amount / 12.0, 2)
        when b.period_kind = 'annual' and gs.m = 12 then l.amount - (round(l.amount / 12.0, 2) * 11)
        else l.amount
      end)::numeric(14,2)                     as budget_amount
    from public.budget_lines l
    join public.budgets b on b.id = l.budget_id
    cross join lateral (
      select m
      from generate_series(1, case when b.period_kind = 'annual' then 12 else 1 end) as m
    ) gs
    where l.version_status = 'approved'
  )
  select
    el.budget_id,
    el.budget_name,
    el.fiscal_year,
    el.budget_line_id,
    el.period_start,
    el.direction,
    el.cost_center_id,
    cc.name                                   as cost_center_name,
    el.department_id,
    d.name                                    as department_name,
    el.project_id,
    p.name                                    as project_name,
    el.category_id,
    el.currency,
    el.budget_amount,
    act.actual_amount,
    case
      when act.actual_amount is null then null::numeric
      else act.actual_amount - el.budget_amount
    end                                       as variance_amount,
    case
      when act.actual_amount is null or el.budget_amount = 0 then null::numeric
      else round((act.actual_amount - el.budget_amount) / el.budget_amount, 4)
    end                                       as variance_ratio,
    case
      when act.actual_amount is null then 'not_measured'
      when el.direction = 'expense' and act.actual_amount > el.budget_amount then 'over_budget'
      when el.direction = 'expense' then 'within_budget'
      when act.actual_amount < el.budget_amount then 'under_target'
      else 'on_or_above_target'
    end                                       as variance_verdict,
    (el.department_id is not null)            as department_scoped,
    el.period_kind
  from expanded_lines el
  left join public.cost_centers cc on cc.id = el.cost_center_id
  left join public.departments d on d.id = el.department_id
  left join public.projects p on p.id = el.project_id
  left join lateral (
    select
      case
        when el.category_id is not null then (
          select sum(coalesce(pi.paid_amount, pi.amount))
          from public.payment_instances pi
          join public.payments pay on pay.id = pi.payment_id
          where pi.status in ('paid', 'partial')
            and coalesce(pi.paid_amount, pi.amount) is not null
            and date_trunc('month', pi.due_date)::date = el.period_start
            and (case when coalesce(pi.direction, 'outflow') = 'inflow' then 'income' else 'expense' end) = el.direction
            and pi.currency = el.currency
            and pay.category_id = el.category_id
            and (el.cost_center_id is null or pay.cost_center_id = el.cost_center_id)
            and (el.project_id is null or pay.project_id = el.project_id)
            and (el.department_id is null or pay.department_id = el.department_id)
        )
        else (
          select sum(v.gross_amount)
          from public.invoices v
          where v.status <> 'cancelled'
            and v.issue_date is not null
            and v.gross_amount is not null
            and date_trunc('month', v.issue_date)::date = el.period_start
            and (case when v.direction = 'sales' then 'income' else 'expense' end) = el.direction
            and v.currency = el.currency
            and (el.cost_center_id is null or v.cost_center_id = el.cost_center_id)
            and (el.project_id is null or v.project_id = el.project_id)
            and (el.department_id is null or v.department_id = el.department_id)
        )
      end as actual_amount
  ) act on true;

-- costing_invoice_facts & profitability_by_department: departman bağlantılı TRY faturaları ölçer,
-- veri eksikse BLANK != ZERO kuralıyla NULL ve açık gerekçe üretir.
create or replace view public.costing_invoice_facts
with (security_invoker = true) as
  select
    v.id                                    as invoice_id,
    v.party_id,
    v.direction,
    date_trunc('month', v.issue_date)::date as period_start,
    v.currency,
    v.cost_center_id,
    v.project_id,
    v.gross_amount,
    v.status,
    v.department_id
  from public.invoices v
  where v.status <> 'cancelled'
    and v.issue_date is not null
    and v.gross_amount is not null;

create or replace view public.profitability_by_department
with (security_invoker = true) as
  select
    d.id                                                                                  as department_id,
    d.code                                                                                as department_code,
    d.name                                                                                as department_name,
    d.parent_department_id,
    sum(f.gross_amount) filter (where f.direction = 'sales' and f.currency = 'TRY')       as revenue,
    sum(f.gross_amount) filter (where f.direction = 'purchase' and f.currency = 'TRY')    as direct_cost,
    case
      when sum(f.gross_amount) filter (where f.direction = 'sales' and f.currency = 'TRY') is null
        or sum(f.gross_amount) filter (where f.direction = 'purchase' and f.currency = 'TRY') is null
      then null
      else sum(f.gross_amount) filter (where f.direction = 'sales' and f.currency = 'TRY')
         - sum(f.gross_amount) filter (where f.direction = 'purchase' and f.currency = 'TRY')
    end                                                                                   as margin,
    case
      when sum(f.gross_amount) filter (where f.direction = 'sales' and f.currency = 'TRY') is null
        or sum(f.gross_amount) filter (where f.direction = 'sales' and f.currency = 'TRY') = 0
        or sum(f.gross_amount) filter (where f.direction = 'purchase' and f.currency = 'TRY') is null
      then null
      else round((
        sum(f.gross_amount) filter (where f.direction = 'sales' and f.currency = 'TRY')
        - sum(f.gross_amount) filter (where f.direction = 'purchase' and f.currency = 'TRY')
      ) / sum(f.gross_amount) filter (where f.direction = 'sales' and f.currency = 'TRY'), 4)
    end                                                                                   as margin_rate,
    case
      when count(f.invoice_id) filter (where f.currency = 'TRY') = 0 then 'no_department_invoices'
      when sum(f.gross_amount) filter (where f.direction = 'sales' and f.currency = 'TRY') is null
        or sum(f.gross_amount) filter (where f.direction = 'purchase' and f.currency = 'TRY') is null
      then 'single_side_only'
      else null
    end                                                                                   as unmeasurable_reason,
    case
      when count(f.invoice_id) filter (where f.currency = 'TRY') = 0
        then 'Bu departmana atanmış TRY fatura henüz yok; tahsis kuralı icat edilmedi'
      when sum(f.gross_amount) filter (where f.direction = 'sales' and f.currency = 'TRY') is null
        then 'Departmanın yalnız alış/gider faturası var; gelir bilinmediğinden marj NULL bırakıldı'
      when sum(f.gross_amount) filter (where f.direction = 'purchase' and f.currency = 'TRY') is null
        then 'Departmanın yalnız satış faturası var; doğrudan maliyet bilinmediğinden marj NULL bırakıldı'
      else 'Doğrudan departman etiketli TRY faturalardan ölçüldü'
    end                                                                                   as note,
    count(f.invoice_id) filter (where f.currency <> 'TRY')::int                           as foreign_currency_count
  from public.departments d
  left join public.costing_invoice_facts f on f.department_id = d.id
  group by d.id, d.code, d.name, d.parent_department_id;

-- ── 6) counterparty_unresolved: çek yönünü (inflow/outflow) son kolon olarak ekle ──────────────
create or replace view public.counterparty_unresolved
with (security_invoker = true) as
  select
    'check'::text                as source,
    c.id                         as source_id,
    c.counterparty_label         as raw_label,
    c.maturity_date              as due_date,
    c.amount                     as amount,
    c.status                     as status,
    c.source_workbook_id,
    c.source_sheet_id,
    c.direction                  as direction
  from public.checks c
  where c.archived_at is null
    and c.payee_party_id is null
    and c.payer_party_id is null
    and c.counterparty_label is not null

  union all

  select
    'loan'::text,
    l.id,
    l.name,
    l.first_payment_date,
    l.principal,
    l.status,
    l.source_workbook_id,
    l.source_sheet_id,
    'outflow'::text              as direction
  from public.loans l
  where l.archived_at is null
    and l.lender_party_id is null;

-- ── 7) Zombi working_capital_trend_reference temizliği -> working_capital_monthly_v ───────────
drop view if exists public.working_capital_trend_reference;

-- 0094 working_capital_trend içine v.currency ve count(v.id) ekleyince 0082'nin kapsayan indeksi
-- heap erişimine düşmüştü; currency anahtara eklenip count(v.issue_date) ile tam Index-Only Scan korunur.
drop index if exists public.invoices_direction_status_issue_cover;
create index invoices_direction_status_issue_cover
  on public.invoices (issue_date, direction, status, currency)
  include (gross_amount, allocated_amount);

create or replace view public.working_capital_trend
with (security_invoker = true) as
  with months as (
    select distinct date_trunc('month', issue_date)::date as period_start
    from public.invoices
    where issue_date is not null and status <> 'cancelled'
  ),
  agg as (
    select
      m.period_start,
      coalesce(sum(v.gross_amount - coalesce(v.allocated_amount, 0))
        filter (where v.direction = 'sales' and v.status in ('open', 'partial') and v.currency = 'TRY'), 0)
        as receivables_open,
      coalesce(sum(v.gross_amount - coalesce(v.allocated_amount, 0))
        filter (where v.direction = 'purchase' and v.status in ('open', 'partial') and v.currency = 'TRY'), 0)
        as payables_open,
      coalesce(sum(v.gross_amount)
        filter (where v.direction = 'sales' and v.status <> 'cancelled' and v.currency = 'TRY'
                  and v.issue_date > (m.period_start - interval '365 days')), 0)
        as sales_365,
      coalesce(sum(v.gross_amount)
        filter (where v.direction = 'purchase' and v.status <> 'cancelled' and v.currency = 'TRY'
                  and v.issue_date > (m.period_start - interval '365 days')), 0)
        as purchases_365,
      count(v.issue_date) filter (where v.status <> 'cancelled' and v.currency <> 'TRY') as foreign_currency_count
    from months m
    left join public.invoices v
      on v.issue_date is not null
     and v.issue_date <= (m.period_start + interval '1 month' - interval '1 day')
    group by m.period_start
  )
  select
    period_start,
    receivables_open,
    payables_open,
    case when sales_365 = 0 then null
         else round(receivables_open / (sales_365 / 365.0), 1) end as dso_days,
    case when purchases_365 = 0 then null
         else round(payables_open / (purchases_365 / 365.0), 1) end as dpo_days,
    null::numeric                                                   as dio_days,
    case when sales_365 = 0 or purchases_365 = 0 then null
         else round(receivables_open / (sales_365 / 365.0)
                  - payables_open / (purchases_365 / 365.0), 1) end as cash_cycle_excluding_inventory,
    foreign_currency_count
  from agg
  order by period_start;

create or replace view public.working_capital_monthly_v
with (security_invoker = true) as
  with cash_months as (
    select
      date_trunc('month', t.txn_date)::date                                               as period_start,
      coalesce(sum(t.amount) filter (where t.direction = 'inflow' and t.currency = 'TRY'), 0)::numeric(14,2)
                                                                                          as cash_inflow_try,
      coalesce(sum(abs(t.amount)) filter (where t.direction = 'outflow' and t.currency = 'TRY'), 0)::numeric(14,2)
                                                                                          as cash_outflow_try,
      coalesce(sum(case when t.direction = 'inflow' then t.amount else -abs(t.amount) end)
        filter (where t.currency = 'TRY'), 0)::numeric(14,2)                              as cash_net_try,
      count(t.id) filter (where t.currency <> 'TRY')::int                                 as foreign_cash_tx_count
    from public.bank_transactions t
    where t.status <> 'ignored'
    group by 1
  ),
  all_periods as (
    select w.period_start from public.working_capital_trend w
    union
    select c.period_start from cash_months c
  )
  select
    p.period_start,
    coalesce(w.receivables_open, 0)::numeric(14,2)                                        as receivables_open,
    coalesce(w.payables_open, 0)::numeric(14,2)                                           as payables_open,
    (coalesce(w.receivables_open, 0) - coalesce(w.payables_open, 0))::numeric(14,2)       as net_working_capital_ex_inventory,
    w.dso_days,
    w.dpo_days,
    w.dio_days,
    w.cash_cycle_excluding_inventory,
    coalesce(c.cash_inflow_try, 0)::numeric(14,2)                                         as cash_inflow_try,
    coalesce(c.cash_outflow_try, 0)::numeric(14,2)                                        as cash_outflow_try,
    coalesce(c.cash_net_try, 0)::numeric(14,2)                                            as cash_net_try,
    coalesce(w.foreign_currency_count, 0)::int                                            as foreign_invoice_count,
    coalesce(c.foreign_cash_tx_count, 0)::int                                             as foreign_cash_tx_count
  from all_periods p
  left join public.working_capital_trend w on w.period_start = p.period_start
  left join cash_months c on c.period_start = p.period_start
  order by p.period_start desc;

-- ── 8) Üretim Ekonomisi V2 tam alan kalıcılığı: production_parts, machine_assets, cost_model_items
alter table public.production_parts
  add column if not exists other_operation_minutes numeric(14,4)
    check (other_operation_minutes is null or other_operation_minutes >= 0),
  add column if not exists unit_sale_price numeric(14,2)
    check (unit_sale_price is null or unit_sale_price >= 0),
  add column if not exists currency text not null default 'TRY'
    check (currency ~ '^[A-Z]{3}$'),
  add column if not exists efficiency_rate numeric(8,4)
    check (efficiency_rate is null or (efficiency_rate >= 0 and efficiency_rate <= 2)),
  add column if not exists work_days_per_month int
    check (work_days_per_month is null or (work_days_per_month >= 0 and work_days_per_month <= 31)),
  add column if not exists shift_count int
    check (shift_count is null or (shift_count >= 1 and shift_count <= 4)),
  add column if not exists notes text;

alter table public.machine_assets
  add column if not exists machine_code text,
  add column if not exists purchase_date date,
  add column if not exists currency text not null default 'TRY'
    check (currency ~ '^[A-Z]{3}$'),
  add column if not exists monthly_revenue numeric(14,2)
    check (monthly_revenue is null or monthly_revenue >= 0),
  add column if not exists monthly_operating_cost numeric(14,2)
    check (monthly_operating_cost is null or monthly_operating_cost >= 0),
  add column if not exists annual_maintenance_cost numeric(14,2)
    check (annual_maintenance_cost is null or annual_maintenance_cost >= 0),
  add column if not exists utilization_rate numeric(8,4)
    check (utilization_rate is null or (utilization_rate >= 0 and utilization_rate <= 2)),
  add column if not exists useful_life_months int
    check (useful_life_months is null or useful_life_months > 0),
  add column if not exists is_active boolean not null default true,
  add column if not exists notes text;

create table if not exists public.cost_model_items (
  id uuid primary key default gen_random_uuid(),
  cost_model_id uuid not null references public.cost_models(id) on delete cascade,
  scenario_type text not null
    check (scenario_type in ('normal', 'overtime', 'custom')),
  cost_category text not null check (btrim(cost_category) <> ''),
  description text,
  monthly_amount numeric(14,2) not null check (monthly_amount >= 0),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  staff_count int check (staff_count is null or staff_count >= 0),
  monthly_work_hours numeric(10,2) check (monthly_work_hours is null or monthly_work_hours >= 0),
  efficiency_rate numeric(8,4)
    check (efficiency_rate is null or (efficiency_rate >= 0 and efficiency_rate <= 2)),
  notes text,
  source_workbook_id uuid references public.source_workbooks(id) on delete set null,
  source_sheet_id uuid references public.source_sheets(id) on delete set null,
  source_row_id uuid references public.import_rows(id) on delete set null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cost_model_items_model
  on public.cost_model_items (cost_model_id, scenario_type, cost_category);
create index if not exists idx_cost_model_items_workbook
  on public.cost_model_items (source_workbook_id)
  where source_workbook_id is not null;
create index if not exists idx_cost_model_items_sheet
  on public.cost_model_items (source_sheet_id)
  where source_sheet_id is not null;
create index if not exists idx_cost_model_items_row
  on public.cost_model_items (source_row_id)
  where source_row_id is not null;
create index if not exists idx_cost_model_items_created_by
  on public.cost_model_items (created_by)
  where created_by is not null;

drop trigger if exists cost_model_items_updated_at on public.cost_model_items;
create trigger cost_model_items_updated_at
  before update on public.cost_model_items
  for each row execute function public.set_updated_at();

-- import_external_keys.entity_table CHECK kısıtını cost_model_items ve credit_facilities ile genişlet
do $$
declare
  v_attnum smallint;
  r record;
begin
  select a.attnum into v_attnum
    from pg_attribute a
   where a.attrelid = 'public.import_external_keys'::regclass
     and a.attname = 'entity_table'
     and not a.attisdropped;

  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.import_external_keys'::regclass
       and c.contype = 'c'
       and c.conkey = array[v_attnum]
  loop
    execute format('alter table public.import_external_keys drop constraint %I', r.conname);
  end loop;

  alter table public.import_external_keys
    add constraint import_external_keys_entity_table_check
    check (entity_table in (
      'payments',
      'checks',
      'loans',
      'loan_installments',
      'cashflow_lines',
      'bank_accounts',
      'bank_transactions',
      'invoices',
      'orders',
      'products',
      'projects',
      'budget_lines',
      'fx_positions',
      'production_parts',
      'cost_model_items',
      'machine_assets',
      'credit_facilities'
    ));
end $$;

-- ── 9) 5-katmanlı RLS ve açık tablo/görünüm yetkileri ──────────────────────────────────────────
alter table public.facility_movements enable row level security;
alter table public.cost_model_items enable row level security;
alter table public.reconciliation_signoffs enable row level security;

revoke all on table
  public.facility_movements,
  public.cost_model_items,
  public.reconciliation_signoffs
from public, anon, authenticated, mas_radar_app;

-- operational: facility_movements & cost_model_items
grant select on table public.facility_movements, public.cost_model_items
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;
grant insert, update on table public.facility_movements, public.cost_model_items
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin;
grant delete on table public.facility_movements, public.cost_model_items
  to mas_radar_finance_manager, mas_radar_admin;

drop policy if exists facility_movements_select_all_tiers on public.facility_movements;
create policy facility_movements_select_all_tiers on public.facility_movements
  for select
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists facility_movements_insert_operational on public.facility_movements;
create policy facility_movements_insert_operational on public.facility_movements
  for insert
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (
    created_by is not distinct from public.current_app_user()
    or public.current_app_user() is null
  );

drop policy if exists facility_movements_update_operational on public.facility_movements;
create policy facility_movements_update_operational on public.facility_movements
  for update
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true)
  with check (true);

drop policy if exists facility_movements_delete_managers on public.facility_movements;
create policy facility_movements_delete_managers on public.facility_movements
  for delete
  to mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists cost_model_items_select_all_tiers on public.cost_model_items;
create policy cost_model_items_select_all_tiers on public.cost_model_items
  for select
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists cost_model_items_insert_operational on public.cost_model_items;
create policy cost_model_items_insert_operational on public.cost_model_items
  for insert
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (
    created_by is not distinct from public.current_app_user()
    or public.current_app_user() is null
  );

drop policy if exists cost_model_items_update_operational on public.cost_model_items;
create policy cost_model_items_update_operational on public.cost_model_items
  for update
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true)
  with check (true);

drop policy if exists cost_model_items_delete_managers on public.cost_model_items;
create policy cost_model_items_delete_managers on public.cost_model_items
  for delete
  to mas_radar_finance_manager, mas_radar_admin
  using (true);

-- evidence: reconciliation_signoffs (viewer yalnız okur; tüm çalışma rolleri kayıt düşer; kimse güncelleyemez/silemez)
grant select on table public.reconciliation_signoffs
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;
grant insert on table public.reconciliation_signoffs
  to mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

drop policy if exists reconciliation_signoffs_select_all_tiers on public.reconciliation_signoffs;
create policy reconciliation_signoffs_select_all_tiers on public.reconciliation_signoffs
  for select
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists reconciliation_signoffs_insert_record on public.reconciliation_signoffs;
create policy reconciliation_signoffs_insert_record on public.reconciliation_signoffs
  for insert
  to mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin
  with check (
    signed_by is not distinct from public.current_app_user()
    or public.current_app_user() is null
  );

revoke insert, update, delete, truncate on
  public.credit_facility_utilization,
  public.document_current_version,
  public.budget_actuals_monthly,
  public.budget_vs_actual,
  public.costing_invoice_facts,
  public.profitability_by_department,
  public.counterparty_unresolved,
  public.working_capital_trend,
  public.working_capital_monthly_v
from public, anon, authenticated, mas_radar_app,
     mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

grant select on
  public.credit_facility_utilization,
  public.document_current_version,
  public.budget_actuals_monthly,
  public.budget_vs_actual,
  public.costing_invoice_facts,
  public.profitability_by_department,
  public.counterparty_unresolved,
  public.working_capital_trend,
  public.working_capital_monthly_v
to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
   mas_radar_finance_manager, mas_radar_admin;
