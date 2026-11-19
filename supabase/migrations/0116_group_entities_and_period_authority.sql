-- 0116 — Faz 60 (M-01, M-20, M-22): Grup İçi Çoklu Tüzel Kişilik (legal_entities & branches)
-- ve Excel'den Bağımsız Muhasebe Dönem Kilidi Otoritesi (accounting_periods).
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz.
--   * Sıfır kayan nokta (yalnız numeric); tüm yeni FK kolonları B-tree indeks taşır.
--   * Tüm yeni tablolar 5-katman RLS/GRANT, tüm görünümler WITH (security_invoker = true) taşır.

-- ── 1) Grup İçi Tüzel Kişilikler (legal_entities — reference sınıfı) ──────────────────────────
create table if not exists public.legal_entities (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  tax_id_vkn text check (tax_id_vkn is null or btrim(tax_id_vkn) <> ''),
  mersis_no text check (mersis_no is null or btrim(mersis_no) <> ''),
  tax_office text,
  base_currency text not null default 'TRY' check (base_currency ~ '^[A-Z]{3}$'),
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists legal_entities_single_default_uq
  on public.legal_entities (is_default)
  where is_default = true;

-- Varsayılan grup ana şirketini idempotent tohumla
insert into public.legal_entities (code, name, tax_id_vkn, tax_office, base_currency, is_default, is_active)
select 'MAS-HQ', 'MAS Makina ve Finans A.Ş.', '6120000001', 'Kurumlar V.D.', 'TRY', true, true
where not exists (select 1 from public.legal_entities);

-- ── 2) Grup İçi Şube / Tesisler (branches — reference sınıfı) ──────────────────────────────────
create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities(id) on delete cascade,
  code text not null check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  city text,
  is_headquarters boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (legal_entity_id, code)
);

create index if not exists idx_branches_legal_entity_id
  on public.branches (legal_entity_id);

insert into public.branches (legal_entity_id, code, name, city, is_headquarters, is_active)
select le.id, 'MERKEZ', 'Merkez Tesis & Hazine', 'İstanbul', true, true
from public.legal_entities le
where le.is_default = true
  and not exists (select 1 from public.branches b where b.legal_entity_id = le.id);

-- ── 3) İşlem-içi aktif tüzel kişilik GUC yardımcısı ───────────────────────────────────────────
create or replace function public.current_legal_entity_id()
returns uuid
language sql
stable
as $$
  select nullif(btrim(current_setting('app.current_legal_entity_id', true)), '')::uuid;
$$;

grant execute on function public.current_legal_entity_id()
  to mas_radar_app, authenticated, mas_radar_viewer, mas_radar_finance_operator,
     mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin;

-- ── 4) Çekirdek tablolara geriye dönük uyumlu legal_entity_id & branch_id eklenmesi ───────────
do $$
declare
  v_default_le uuid;
  v_tbl text;
begin
  select id into v_default_le from public.legal_entities where is_default = true limit 1;

  foreach v_tbl in array array[
    'cash_accounts',
    'payments',
    'invoices',
    'checks',
    'loans',
    'credit_facilities',
    'management_journal_entries',
    'budgets',
    'cost_centers',
    'projects'
  ] loop
    execute format(
      'alter table public.%I add column if not exists legal_entity_id uuid references public.legal_entities(id) on delete restrict',
      v_tbl
    );
    execute format(
      'alter table public.%I add column if not exists branch_id uuid references public.branches(id) on delete set null',
      v_tbl
    );
    if v_default_le is not null then
      execute format('alter table public.%I disable trigger user', v_tbl);
      execute format(
        'update public.%I set legal_entity_id = %L::uuid where legal_entity_id is null',
        v_tbl, v_default_le
      );
      execute format('alter table public.%I enable trigger user', v_tbl);
    end if;
    execute format(
      'create index if not exists %I on public.%I (legal_entity_id) where legal_entity_id is not null',
      'idx_' || v_tbl || '_legal_entity_id', v_tbl
    );
    execute format(
      'create index if not exists %I on public.%I (branch_id) where branch_id is not null',
      'idx_' || v_tbl || '_branch_id', v_tbl
    );
  end loop;
end $$;

-- ── 5) Bağımsız Muhasebe Dönem Kilidi Otoritesi (accounting_periods — operational sınıfı) ─────
create table if not exists public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid references public.legal_entities(id) on delete restrict,
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  status text not null default 'open'
    check (status in ('open', 'reviewed', 'locked')),
  checklist_json jsonb not null default '{}'::jsonb,
  close_note text,
  locked_at timestamptz,
  locked_by uuid references public.users(id) on delete set null,
  reopened_at timestamptz,
  reopened_by uuid references public.users(id) on delete set null,
  reopen_reason text,
  lock_fingerprint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_month)
);

create index if not exists idx_accounting_periods_legal_entity_id
  on public.accounting_periods (legal_entity_id) where legal_entity_id is not null;
create index if not exists idx_accounting_periods_locked_by
  on public.accounting_periods (locked_by) where locked_by is not null;
create index if not exists idx_accounting_periods_reopened_by
  on public.accounting_periods (reopened_by) where reopened_by is not null;

-- Durum geçiş ve rol bekçisi (0100 ile birebir simetrik, Excel satırı gerektirmez)
create or replace function public.enforce_accounting_period_lock_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'locked' then
      raise exception 'period_locked: % dönemi kilitlidir, silinemez.',
        to_char(old.period_month, 'YYYY-MM')
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'locked' then
      if current_user not in ('mas_radar_finance_manager', 'mas_radar_admin', 'postgres') then
        raise exception 'period_lock_requires_manager: dönem kilitleme yetkisi yalnız finans yöneticisi veya yöneticiye aittir.'
          using errcode = '42501';
      end if;
      new.locked_at := coalesce(new.locked_at, now());
    end if;
    return new;
  end if;

  if new.status = 'locked' or old.status = 'locked' then
    if current_user not in ('mas_radar_finance_manager', 'mas_radar_admin', 'postgres') then
      raise exception 'period_lock_requires_manager: dönem kilitleme ve kilit açma yetkisi yalnız finans yöneticisi veya yöneticiye aittir.'
        using errcode = '42501';
    end if;
  end if;

  if (old.status, new.status) not in (
    ('open', 'open'),
    ('open', 'reviewed'),
    ('open', 'locked'),
    ('reviewed', 'open'),
    ('reviewed', 'reviewed'),
    ('reviewed', 'locked'),
    ('locked', 'locked'),
    ('locked', 'reviewed')
  ) then
    raise exception 'accounting_periods.% status geçişi %→% izinli değil',
      old.id, old.status, new.status
      using errcode = '23514';
  end if;

  if old.status <> 'locked' and new.status = 'locked' then
    new.locked_at := coalesce(new.locked_at, now());
    return new;
  end if;

  if old.status = 'locked' and new.status = 'reviewed' then
    if coalesce(length(btrim(new.reopen_reason)), 0) < 10 then
      raise exception 'period_reopen_reason_required: dönem kilidini açmak için en az 10 karakterlik gerekçe zorunludur.'
        using errcode = '23514';
    end if;
    new.reopened_at := coalesce(new.reopened_at, now());
    return new;
  end if;

  if old.status = 'locked' and new.status = 'locked' then
    if new.period_month is distinct from old.period_month
       or new.locked_at is distinct from old.locked_at
    then
      raise exception 'period_locked: % dönemi kilitlidir, dönem tarihi değiştirilemez.',
        to_char(old.period_month, 'YYYY-MM')
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists accounting_periods_lock_guard on public.accounting_periods;
create trigger accounting_periods_lock_guard
  before insert or update or delete on public.accounting_periods
  for each row execute function public.enforce_accounting_period_lock_transition();

-- Mevcut cashflow_months kilitlerini ve son 24 + ileri 12 ayı otomatik tohumla
insert into public.accounting_periods (legal_entity_id, period_month, status, locked_at, locked_by, reopen_reason)
select
  (select id from public.legal_entities where is_default = true limit 1),
  cm.month_start,
  case when cm.status in ('open', 'reviewed', 'locked') then cm.status else 'open' end,
  cm.locked_at,
  cm.locked_by,
  cm.reopen_reason
from public.cashflow_months cm
on conflict (period_month) do nothing;

insert into public.accounting_periods (legal_entity_id, period_month, status)
select
  (select id from public.legal_entities where is_default = true limit 1),
  (date_trunc('month', current_date)::date + (m || ' months')::interval)::date,
  'open'
from generate_series(-18, 12) as m
on conflict (period_month) do nothing;

-- assert_date_not_in_locked_period hem cashflow_months hem accounting_periods kilitlerini denetler
create or replace function public.assert_date_not_in_locked_period(
  p_date date,
  p_table text
)
returns void
language plpgsql
as $$
declare
  v_month date;
begin
  if p_date is null then
    return;
  end if;

  v_month := date_trunc('month', p_date)::date;

  if exists (
    select 1
      from public.cashflow_months cm
     where cm.month_start = v_month
       and cm.status = 'locked'
  ) or exists (
    select 1
      from public.accounting_periods ap
     where ap.period_month = v_month
       and ap.status = 'locked'
  ) then
    raise exception 'period_locked: % ayı kilitlidir, kayıt değiştirilemez (tablo: %).',
      to_char(v_month, 'YYYY-MM'), p_table
      using errcode = 'P0001';
  end if;
end $$;

-- ── 6) 5-Katman RLS & GRANT Kalkanı ───────────────────────────────────────────────────────────
do $$
declare
  tbl text;
begin
  foreach tbl in array array['legal_entities', 'branches'] loop
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

  alter table public.accounting_periods enable row level security;
  revoke all on table public.accounting_periods from public, anon, authenticated, mas_radar_app;
  grant select on table public.accounting_periods
    to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin;
  grant insert, update on table public.accounting_periods
    to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin;
  grant delete on table public.accounting_periods
    to mas_radar_finance_manager, mas_radar_admin;

  drop policy if exists accounting_periods_select_all_tiers on public.accounting_periods;
  create policy accounting_periods_select_all_tiers on public.accounting_periods
    for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin
    using (true);
  drop policy if exists accounting_periods_insert_enter on public.accounting_periods;
  create policy accounting_periods_insert_enter on public.accounting_periods
    for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
    with check (true);
  drop policy if exists accounting_periods_update_enter on public.accounting_periods;
  create policy accounting_periods_update_enter on public.accounting_periods
    for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
    using (true) with check (true);
  drop policy if exists accounting_periods_delete_manage on public.accounting_periods;
  create policy accounting_periods_delete_manage on public.accounting_periods
    for delete to mas_radar_finance_manager, mas_radar_admin
    using (true);
end $$;
