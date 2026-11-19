-- 0118 — Faz 60 (M-45..M-49): Tam Kapsamlı Üretim Modülü (work_centers, TDHP 150/151/152
-- inventory_items & inventory_movements, canlı DIO / CCC görünümü, bom_headers & bom_lines,
-- work_orders & OEE, çoklu müşteri/döviz customer_rate_cards).
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz.
--   * Sıfır kayan nokta (yalnız numeric); her FK kolonu B-tree indeks taşır.

-- ── 1) İş İstasyonları (work_centers — reference sınıfı) ──────────────────────────────────────
create table if not exists public.work_centers (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid references public.legal_entities(id) on delete restrict,
  code text not null unique check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  operation_type text not null default 'freze'
    check (operation_type in ('torna', 'freze', 'taslama', 'lazer', 'kaynak', 'montaj', 'kalite', 'fason', 'diger')),
  machine_count int not null default 1 check (machine_count >= 1),
  shifts_per_day int not null default 1 check (shifts_per_day between 1 and 3),
  shift_minutes int not null default 480 check (shift_minutes between 60 and 720),
  working_days_per_month int not null default 22 check (working_days_per_month between 1 and 31),
  target_oee_pct numeric(5,2) not null default 80.00 check (target_oee_pct > 0 and target_oee_pct <= 100),
  hourly_power_kw numeric(10,2) not null default 15.00 check (hourly_power_kw >= 0),
  standard_rate_per_min_try numeric(12,4) check (standard_rate_per_min_try is null or standard_rate_per_min_try >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_work_centers_legal_entity_id
  on public.work_centers (legal_entity_id) where legal_entity_id is not null;

-- Varsayılan iş istasyonları tohumu
insert into public.work_centers (code, name, operation_type, machine_count, shifts_per_day, shift_minutes, target_oee_pct, standard_rate_per_min_try)
values
  ('WC-FREZE',   'CNC İşleme Merkezi (Freze)', 'freze',   3, 2, 480, 82.00, 18.50),
  ('WC-TORNA',   'CNC Torna Hücresi',          'torna',   2, 2, 480, 84.00, 15.00),
  ('WC-TASLAMA', 'Hassas Taşlama & Yüzey',     'taslama', 1, 1, 480, 78.00, 14.00),
  ('WC-MONTAJ',  'Montaj & Kalite Kontrol',    'montaj',  1, 1, 480, 88.00, 10.50)
on conflict (code) do nothing;

-- ── 2) Stok Kartları & Stok Hareketleri (TDHP 150/151/152) ────────────────────────────────────
create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid references public.legal_entities(id) on delete restrict,
  sku text not null unique check (btrim(sku) <> ''),
  name text not null check (btrim(name) <> ''),
  item_type text not null default 'raw_material'
    check (item_type in ('raw_material', 'semi_finished', 'finished_good', 'consumable')),
  tdhp_account_code text not null default '150'
    check (tdhp_account_code in ('150', '151', '152', '153', '157')),
  unit text not null default 'ADET' check (btrim(unit) <> ''),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  standard_unit_cost numeric(14,4) not null default 0 check (standard_unit_cost >= 0),
  on_hand_qty numeric(14,4) not null default 0,
  reorder_point numeric(14,4) not null default 0 check (reorder_point >= 0),
  lead_time_days int not null default 7 check (lead_time_days >= 0),
  linked_part_id uuid references public.production_parts(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_inventory_items_legal_entity_id
  on public.inventory_items (legal_entity_id) where legal_entity_id is not null;
create index if not exists idx_inventory_items_linked_part_id
  on public.inventory_items (linked_part_id) where linked_part_id is not null;

-- ── 3) Ürün Ağacı / Reçete (bom_headers & bom_lines — operational sınıfı) ─────────────────────
create table if not exists public.bom_headers (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null references public.production_parts(id) on delete cascade,
  version_code text not null default 'V1' check (btrim(version_code) <> ''),
  batch_size numeric(12,4) not null default 1 check (batch_size > 0),
  subcontract_cost_per_unit numeric(14,4) not null default 0 check (subcontract_cost_per_unit >= 0),
  subcontract_currency text not null default 'TRY' check (subcontract_currency ~ '^[A-Z]{3}$'),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (part_id, version_code)
);

create index if not exists idx_bom_headers_part_id on public.bom_headers (part_id);

create table if not exists public.bom_lines (
  id uuid primary key default gen_random_uuid(),
  bom_id uuid not null references public.bom_headers(id) on delete cascade,
  line_no int not null default 1 check (line_no >= 1),
  raw_material_item_id uuid references public.inventory_items(id) on delete restrict,
  material_label text not null check (btrim(material_label) <> ''),
  qty_per_unit numeric(14,4) not null default 1 check (qty_per_unit >= 0),
  scrap_pct numeric(6,2) not null default 0 check (scrap_pct >= 0 and scrap_pct < 100),
  unit_cost_override numeric(14,4) check (unit_cost_override is null or unit_cost_override >= 0),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  work_center_id uuid references public.work_centers(id) on delete set null,
  std_setup_minutes numeric(10,2) not null default 0 check (std_setup_minutes >= 0),
  std_run_minutes numeric(10,2) not null default 0 check (std_run_minutes >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_bom_lines_bom_id on public.bom_lines (bom_id);
create index if not exists idx_bom_lines_raw_material on public.bom_lines (raw_material_item_id) where raw_material_item_id is not null;
create index if not exists idx_bom_lines_work_center on public.bom_lines (work_center_id) where work_center_id is not null;

-- ── 4) İş Emirleri & Canlı OEE (work_orders — operational sınıfı, tam geçiş bekçisiyle) ───────
create table if not exists public.work_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique check (btrim(order_no) <> ''),
  part_id uuid references public.production_parts(id) on delete set null,
  bom_id uuid references public.bom_headers(id) on delete set null,
  work_center_id uuid not null references public.work_centers(id) on delete restrict,
  party_id uuid references public.parties(id) on delete set null,
  planned_qty numeric(14,2) not null check (planned_qty > 0),
  good_qty numeric(14,2) not null default 0 check (good_qty >= 0),
  scrap_qty numeric(14,2) not null default 0 check (scrap_qty >= 0),
  planned_minutes numeric(12,2) not null check (planned_minutes > 0),
  actual_run_minutes numeric(12,2) not null default 0 check (actual_run_minutes >= 0),
  downtime_minutes numeric(12,2) not null default 0 check (downtime_minutes >= 0),
  downtime_reason text,
  status text not null default 'planned'
    check (status in ('planned', 'in_progress', 'completed', 'cancelled')),
  due_date date,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_work_orders_part_id on public.work_orders (part_id) where part_id is not null;
create index if not exists idx_work_orders_bom_id on public.work_orders (bom_id) where bom_id is not null;
create index if not exists idx_work_orders_work_center_id on public.work_orders (work_center_id);
create index if not exists idx_work_orders_party_id on public.work_orders (party_id) where party_id is not null;
create index if not exists idx_work_orders_created_by on public.work_orders (created_by) where created_by is not null;

create or replace function public.work_orders_status_transition_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('planned',     'in_progress'),
    ('planned',     'completed'),
    ('planned',     'cancelled'),
    ('in_progress', 'completed'),
    ('in_progress', 'planned'),
    ('in_progress', 'cancelled'),
    ('completed',   'in_progress'),
    ('cancelled',   'planned')
  ) then
    raise exception 'work_orders.% status geçişi %→% izinli değil', old.id, old.status, new.status
      using errcode = '23514';
  end if;

  return new;
end $$;

drop trigger if exists work_orders_status_guard on public.work_orders;
create trigger work_orders_status_guard
  before update on public.work_orders
  for each row execute function public.work_orders_status_transition_guard();

-- ── 5) Stok Hareketleri (inventory_movements — operational sınıfı) ────────────────────────────
create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  movement_type text not null
    check (movement_type in ('receipt', 'production_issue', 'production_output', 'sale_issue', 'scrap', 'adjustment')),
  qty numeric(14,4) not null check (qty <> 0),
  unit_cost numeric(14,4) not null default 0 check (unit_cost >= 0),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  fx_rate_to_try numeric(14,6) not null default 1 check (fx_rate_to_try > 0),
  work_order_id uuid references public.work_orders(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  journal_entry_id uuid references public.management_journal_entries(id) on delete set null,
  occurred_on date not null default current_date,
  notes text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_inv_mov_item_id on public.inventory_movements (item_id);
create index if not exists idx_inv_mov_work_order_id on public.inventory_movements (work_order_id) where work_order_id is not null;
create index if not exists idx_inv_mov_invoice_id on public.inventory_movements (invoice_id) where invoice_id is not null;
create index if not exists idx_inv_mov_je_id on public.inventory_movements (journal_entry_id) where journal_entry_id is not null;
create index if not exists idx_inv_mov_created_by on public.inventory_movements (created_by) where created_by is not null;

-- ── 6) Çoklu Müşteri & Döviz Tarife Kartları (customer_rate_cards — akon_* yerine genel yapı) ─
create table if not exists public.customer_rate_cards (
  id uuid primary key default gen_random_uuid(),
  party_id uuid references public.parties(id) on delete set null,
  customer_label text not null check (btrim(customer_label) <> ''),
  work_center_id uuid references public.work_centers(id) on delete set null,
  operation_type text not null default 'freze'
    check (operation_type in ('torna', 'freze', 'taslama', 'lazer', 'kaynak', 'montaj', 'kalite', 'fason', 'diger')),
  rate_per_minute numeric(12,4) not null check (rate_per_minute >= 0),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  valid_from date not null default '2025-01-01',
  valid_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_customer_rate_cards_party_id on public.customer_rate_cards (party_id) where party_id is not null;
create index if not exists idx_customer_rate_cards_wc_id on public.customer_rate_cards (work_center_id) where work_center_id is not null;

-- Mevcut cost_models içindeki tarihsel tarife verilerini genel müşteri tarife kartına taşı
insert into public.customer_rate_cards (customer_label, operation_type, rate_per_minute, currency, valid_from)
select
  'Standart Kontrat Tarifesi',
  'freze',
  cm.akon_freze_tl_per_min,
  'TRY',
  '2025-01-01'::date
from public.cost_models cm
where cm.akon_freze_tl_per_min is not null
  and cm.akon_freze_tl_per_min > 0
  and not exists (
    select 1 from public.customer_rate_cards crc
    where crc.operation_type = 'freze' and crc.rate_per_minute = cm.akon_freze_tl_per_min
  )
limit 1;

insert into public.customer_rate_cards (customer_label, operation_type, rate_per_minute, currency, valid_from)
select
  'Standart Kontrat Tarifesi',
  'torna',
  cm.akon_torna_tl_per_min,
  'TRY',
  '2025-01-01'::date
from public.cost_models cm
where cm.akon_torna_tl_per_min is not null
  and cm.akon_torna_tl_per_min > 0
  and not exists (
    select 1 from public.customer_rate_cards crc
    where crc.operation_type = 'torna' and crc.rate_per_minute = cm.akon_torna_tl_per_min
  )
limit 1;

-- machine_roi_snapshots üzerine NPV, IRR, İskontolu Payback ve 253/257 Amortisman Vergi Kalkanı kolonları
alter table public.machine_roi_snapshots
  add column if not exists useful_life_years int default 5 check (useful_life_years is null or useful_life_years between 1 and 30),
  add column if not exists discount_rate_pct numeric(6,2) default 25.00 check (discount_rate_pct is null or discount_rate_pct >= 0),
  add column if not exists annual_depreciation numeric(14,2),
  add column if not exists tax_shield_amount numeric(14,2),
  add column if not exists npv_try numeric(14,2),
  add column if not exists irr_pct numeric(8,2),
  add column if not exists discounted_payback_months numeric(8,2);

-- ── 7) İşletme Sermayesi Görünümü: Stok Girildiğinde Canlı DIO & CCC Açılır, Yoksa NULL Kalır ─
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
  )
  select
    c.receivables_open,
    c.payables_open,
    c.sales_365,
    c.purchases_365,
    case when c.sales_365 is null or c.sales_365 = 0 then null
         else round(c.receivables_open / (c.sales_365 / 365.0), 1) end as dso_days,
    case when c.purchases_365 is null or c.purchases_365 = 0 then null
         else round(c.payables_open / (c.purchases_365 / 365.0), 1) end as dpo_days,
    case
      when coalesce(inv.item_count, 0) = 0 or inv.inventory_value_try is null then null::numeric
      when c.purchases_365 is null or c.purchases_365 = 0 then null::numeric
      else round(inv.inventory_value_try / (c.purchases_365 / 365.0), 1)
    end as dio_days,
    case
      when coalesce(inv.item_count, 0) = 0 or inv.inventory_value_try is null then 'no_inventory_data'::text
      when c.purchases_365 is null or c.purchases_365 = 0 then 'no_purchases_denominator'::text
      else null::text
    end as dio_unmeasurable_reason,
    case
      when coalesce(inv.item_count, 0) = 0 or inv.inventory_value_try is null then null::numeric
      when c.sales_365 is null or c.sales_365 = 0
        or c.purchases_365 is null or c.purchases_365 = 0 then null::numeric
      else round(
        c.receivables_open / (c.sales_365 / 365.0)
        + inv.inventory_value_try / (c.purchases_365 / 365.0)
        - c.payables_open / (c.purchases_365 / 365.0),
        1
      )
    end as cash_conversion_cycle_days,
    case
      when coalesce(inv.item_count, 0) = 0 or inv.inventory_value_try is null then 'dio_unknown'::text
      when c.sales_365 is null or c.sales_365 = 0
        or c.purchases_365 is null or c.purchases_365 = 0 then 'missing_turnover_denominator'::text
      else null::text
    end as ccc_unmeasurable_reason,
    case
      when c.sales_365 is null or c.sales_365 = 0
        or c.purchases_365 is null or c.purchases_365 = 0 then null
      else round(c.receivables_open / (c.sales_365 / 365.0)
               - c.payables_open / (c.purchases_365 / 365.0), 1)
    end as cash_cycle_excluding_inventory
  from c
  cross join inv;

revoke insert, update, delete, truncate on table public.working_capital_metrics
  from public, anon, authenticated, mas_radar_app,
       mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
       mas_radar_finance_manager, mas_radar_admin;
grant select on table public.working_capital_metrics
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

-- ── 8) 5-Katman RLS & GRANT Kalkanı ───────────────────────────────────────────────────────────
do $$
declare
  tbl text;
begin
  foreach tbl in array array['work_centers', 'inventory_items', 'customer_rate_cards'] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on table public.%I from public, anon, authenticated, mas_radar_app', tbl);
    execute format(
      'grant select on table public.%I to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      tbl
    );
    execute format(
      'grant insert, update, delete on table public.%I to mas_radar_finance_manager, mas_radar_admin',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_select_all_tiers', tbl);
    execute format(
      'create policy %I on public.%I for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_select_all_tiers', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_insert_manage', tbl);
    execute format(
      'create policy %I on public.%I for insert to mas_radar_finance_manager, mas_radar_admin with check (true)',
      tbl || '_insert_manage', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_update_manage', tbl);
    execute format(
      'create policy %I on public.%I for update to mas_radar_finance_manager, mas_radar_admin using (true) with check (true)',
      tbl || '_update_manage', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_delete_manage', tbl);
    execute format(
      'create policy %I on public.%I for delete to mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_delete_manage', tbl
    );
  end loop;

  foreach tbl in array array['bom_headers', 'bom_lines', 'work_orders', 'inventory_movements'] loop
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
end $$;
