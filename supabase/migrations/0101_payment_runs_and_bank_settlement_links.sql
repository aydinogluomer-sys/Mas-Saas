-- 0101 — Faz 48 (D2): Canlı Maker-Checker onay döngüsü, Ödeme Çalıştırma Paketi
-- (payment_runs + payment_run_items), IBAN BEC doğrulama kalkanı ve banka eşleştirme ->
-- otomatik ödeme/fatura/çek/taksit kapanış bağlantıları.
--
-- Kurallar:
--   * Üst-seviye işlem komutu ve eşzamanlı indeks kullanılmaz (scripts/db/migration-lib.ts).
--   * Sıfır kayan nokta (yalnız numeric); tüm görünümler WITH (security_invoker = true) taşır.
--   * 0098 varsayılan yetki daraltmasına uygun olarak yeni tablolarda açık GRANT ve 5 katmanlı RLS.

-- ── 1) approvals & approval_rules kapsam genişletmesi (yapısal conkey hedeflemesiyle) ───────
do $widen_approvals$
declare
  r record;
begin
  -- approvals.subject_table tek-kolon CHECK kısıtlarını kaldır ve genişletilmiş kümeyle yeniden kur
  for r in
    select c.conname
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = 'public.approvals'::regclass
       and c.contype = 'c'
       and cardinality(c.conkey) = 1
       and a.attname = 'subject_table'
  loop
    execute format('alter table public.approvals drop constraint if exists %I', r.conname);
  end loop;

  alter table public.approvals
    add constraint approvals_subject_table_check
    check (subject_table in (
      'mapping_reviews', 'external_assumptions',
      'invoices', 'payment_instances', 'payments', 'ibans', 'parties', 'bank_transactions',
      'optimization_runs', 'payment_runs', 'budgets', 'budget_lines', 'forecast_lines'
    ));

  -- approvals.request_kind tek-kolon CHECK kısıtlarını kaldır ve genişletilmiş kümeyle yeniden kur
  for r in
    select c.conname
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = 'public.approvals'::regclass
       and c.contype = 'c'
       and cardinality(c.conkey) = 1
       and a.attname = 'request_kind'
  loop
    execute format('alter table public.approvals drop constraint if exists %I', r.conname);
  end loop;

  alter table public.approvals
    add constraint approvals_request_kind_check
    check (request_kind in (
      'data_review', 'amount_threshold', 'new_iban', 'new_counterparty',
      'invoice', 'payment', 'payment_run', 'budget', 'other'
    ));

  -- approval_rules.trigger_kind tek-kolon CHECK kısıtlarını kaldır ve genişletilmiş kümeyle yeniden kur
  -- (Not: 0054'ün 5 varsayılan kural satırı değiştirilmez; phase24a-verify 5 varsayılan kural bekler.)
  for r in
    select c.conname
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = 'public.approval_rules'::regclass
       and c.contype = 'c'
       and cardinality(c.conkey) = 1
       and a.attname = 'trigger_kind'
  loop
    execute format('alter table public.approval_rules drop constraint if exists %I', r.conname);
  end loop;

  alter table public.approval_rules
    add constraint approval_rules_trigger_kind_check
    check (trigger_kind in (
      'amount_threshold', 'new_iban', 'new_counterparty',
      'invoice', 'payment', 'payment_run', 'budget'
    ));
end $widen_approvals$;

-- ── 2) Mevcut finansal tablolarda canlı onay / IBAN BEC / banka kapanış izleme kolonları ─────
alter table public.invoices
  add column if not exists approval_status text not null default 'not_required',
  add column if not exists approval_id uuid references public.approvals(id) on delete set null,
  add column if not exists approved_by uuid references public.users(id) on delete set null,
  add column if not exists approved_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_approval_status_chk') then
    alter table public.invoices
      add constraint invoices_approval_status_chk
      check (approval_status in ('not_required', 'pending_approval', 'approved', 'rejected'));
  end if;
end $$;

alter table public.payment_instances
  add column if not exists approval_status text not null default 'not_required',
  add column if not exists approval_id uuid references public.approvals(id) on delete set null,
  add column if not exists approved_by uuid references public.users(id) on delete set null,
  add column if not exists approved_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_instances_approval_status_chk') then
    alter table public.payment_instances
      add constraint payment_instances_approval_status_chk
      check (approval_status in ('not_required', 'pending_approval', 'approved', 'rejected'));
  end if;
end $$;

-- ibans: mevcut kayıtlar varsayılan 'approved' kalır; new_iban_requires_approval kuralı tetiklendiğinde
-- yeni eklenen IBAN 'pending_approval' olarak doğar ve ikinci göz onaylayana kadar pain.001 / EFT ihracında bloklanır.
alter table public.ibans
  add column if not exists approval_status text not null default 'approved',
  add column if not exists approval_id uuid references public.approvals(id) on delete set null,
  add column if not exists verified_by uuid references public.users(id) on delete set null,
  add column if not exists verified_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ibans_approval_status_chk') then
    alter table public.ibans
      add constraint ibans_approval_status_chk
      check (approval_status in ('pending_approval', 'approved', 'rejected'));
  end if;
end $$;

alter table public.parties
  add column if not exists approval_status text not null default 'approved',
  add column if not exists approval_id uuid references public.approvals(id) on delete set null,
  add column if not exists approved_by uuid references public.users(id) on delete set null,
  add column if not exists approved_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'parties_approval_status_chk') then
    alter table public.parties
      add constraint parties_approval_status_chk
      check (approval_status in ('pending_approval', 'approved', 'rejected'));
  end if;
end $$;

alter table public.bank_transactions
  add column if not exists settled_allocation_id uuid references public.invoice_allocations(id) on delete set null,
  add column if not exists settled_at timestamptz,
  add column if not exists settled_by uuid references public.users(id) on delete set null;

create index if not exists idx_bank_transactions_settled_allocation
  on public.bank_transactions (settled_allocation_id)
  where settled_allocation_id is not null;

-- ── 3) 0048 fatura dağıtım tavanı tetikleyicisini paid_amount + status senkronizasyonuyla güçlendir
--       ve 0100 açık dönem tahsilatı istisnasını paid_amount/status kapanışıyla uyumlu tut ────────
create or replace function public.allocations_enforce_invoice_ceiling()
returns trigger
language plpgsql
as $$
declare
  target uuid;
  targets uuid[];
  total numeric(14,2);
  gross numeric(14,2);
  prev_alloc numeric(14,2);
  prev_paid numeric(14,2);
  new_paid numeric(14,2);
  inv_status text;
  next_status text;
begin
  targets := array_remove(array[
    case when tg_op <> 'DELETE' then new.invoice_id end,
    case when tg_op <> 'INSERT' then old.invoice_id end
  ], null);

  foreach target in array targets loop
    select i.gross_amount, i.status, i.allocated_amount, i.paid_amount
      into gross, inv_status, prev_alloc, prev_paid
      from public.invoices i
     where i.id = target
       for update;

    if gross is null then
      continue;
    end if;

    if tg_op <> 'DELETE' and new.reversed_at is null and inv_status not in ('open', 'partial', 'paid') then
      raise exception
        'invoice_allocations: % durumundaki faturaya (%) tahsilat/ödeme bağlanamaz (yalnız open/partial/paid).',
        inv_status, target;
    end if;

    select coalesce(sum(a.allocated_amount), 0)
      into total
      from public.invoice_allocations a
     where a.invoice_id = target
       and a.reversed_at is null;

    if total > gross then
      raise exception
        'invoice_allocations: fatura % için dağıtım toplamı (%) fatura tutarını (%) aşamaz.',
        target, total, gross;
    end if;

    -- Faz 48 (D2): Dağıtım ekleme/ters kayıt işlemlerinde paid_amount ve status (open <-> partial <-> paid)
    -- otomatik güncellenir; varsa dağıtım-dışı fazla ödeme (over-receipt: prev_paid > prev_alloc) korunur.
    new_paid := greatest(total, coalesce(prev_paid, 0) - greatest(0, coalesce(prev_alloc, 0) - total));

    if inv_status in ('open', 'partial', 'paid') then
      next_status := case
        when new_paid <= 0 then 'open'
        when new_paid >= gross then 'paid'
        else 'partial'
      end;
    else
      next_status := inv_status;
    end if;

    update public.invoices
       set allocated_amount = total,
           paid_amount = new_paid,
           status = next_status
     where id = target;
  end loop;

  return coalesce(new, old);
end $$;

create or replace function public.enforce_closed_period_lock()
returns trigger
language plpgsql
as $$
begin
  case tg_table_name
    when 'payment_instances' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.due_date, tg_table_name);
        perform public.assert_date_not_in_locked_period(old.instance_month, tg_table_name);
        if old.paid_at is not null then
          perform public.assert_date_not_in_locked_period((old.paid_at at time zone 'Europe/Istanbul')::date, tg_table_name);
        end if;
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.due_date, tg_table_name);
        perform public.assert_date_not_in_locked_period(new.instance_month, tg_table_name);
        if new.paid_at is not null then
          perform public.assert_date_not_in_locked_period((new.paid_at at time zone 'Europe/Istanbul')::date, tg_table_name);
        end if;
      end if;

    when 'payments' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.due_date, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.due_date, tg_table_name);
      end if;

    when 'cashflow_lines' then
      if tg_op <> 'INSERT' then
        perform public.assert_cashflow_month_id_not_locked(old.cashflow_month_id, tg_table_name);
        perform public.assert_date_not_in_locked_period(old.date_value, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_cashflow_month_id_not_locked(new.cashflow_month_id, tg_table_name);
        perform public.assert_date_not_in_locked_period(new.date_value, tg_table_name);
      end if;

    when 'invoices' then
      -- Açık bir dönemde yapılan tahsilat/ödeme dağıtımı (invoice_allocations -> allocations_enforce_invoice_ceiling,
      -- pg_trigger_depth() > 1) geçmiş dönemde kesilmiş açık bir faturanın allocated_amount, paid_amount ve
      -- tahsilat durumunu (open/partial/paid) güncellediğinde faturanın ticari içeriği değişmemiştir; dağıtımın
      -- kendi tarihi zaten invoice_allocations üzerindeki period_lock tetikleyicisiyle denetlenir.
      if tg_op = 'UPDATE'
         and pg_trigger_depth() > 1
         and new.direction is not distinct from old.direction
         and new.invoice_no is not distinct from old.invoice_no
         and new.party_id is not distinct from old.party_id
         and new.issue_date is not distinct from old.issue_date
         and new.due_date is not distinct from old.due_date
         and new.currency is not distinct from old.currency
         and new.net_amount is not distinct from old.net_amount
         and new.tax_amount is not distinct from old.tax_amount
         and new.gross_amount is not distinct from old.gross_amount
         and new.notes is not distinct from old.notes
         and new.cancelled_at is not distinct from old.cancelled_at
         and new.closed_at is not distinct from old.closed_at
         and new.status in ('open', 'partial', 'paid')
      then
        return new;
      end if;

      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.issue_date, tg_table_name);
        perform public.assert_date_not_in_locked_period(old.due_date, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.issue_date, tg_table_name);
        perform public.assert_date_not_in_locked_period(new.due_date, tg_table_name);
      end if;

    when 'invoice_allocations' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.allocated_on, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.allocated_on, tg_table_name);
      end if;

    when 'checks' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.maturity_date, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.maturity_date, tg_table_name);
      end if;

    when 'loan_installments' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.due_date, tg_table_name);
        if old.paid_at is not null then
          perform public.assert_date_not_in_locked_period((old.paid_at at time zone 'Europe/Istanbul')::date, tg_table_name);
        end if;
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.due_date, tg_table_name);
        if new.paid_at is not null then
          perform public.assert_date_not_in_locked_period((new.paid_at at time zone 'Europe/Istanbul')::date, tg_table_name);
        end if;
      end if;

    when 'bank_transactions' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.txn_date, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.txn_date, tg_table_name);
      end if;

    else
      raise exception 'enforce_closed_period_lock: tanımsız tablo %', tg_table_name;
  end case;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

-- ── 4) public.payment_runs ve public.payment_run_items tabloları ─────────────────────────────
create table if not exists public.payment_runs (
  id uuid primary key default gen_random_uuid(),
  run_code text not null unique check (btrim(run_code) <> ''),
  planned_execution_date date not null,
  source_bank_account_id uuid not null references public.bank_accounts(cash_account_id) on delete restrict,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_amount numeric(14,2) not null check (total_amount > 0),
  item_count int not null check (item_count > 0),

  -- 14 günlük kasa alt limiti (minimum cash buffer) simülasyon kanıtı (FIN-03 null-duyarlı)
  pre_run_cash numeric(14,2),
  projected_14d_min_cash numeric(14,2),
  min_cash_floor numeric(14,2),
  breaches_cash_floor boolean not null default false,

  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'exported', 'settled', 'cancelled')),
  approval_id uuid references public.approvals(id) on delete set null,

  exported_format text,
  exported_hash text,

  created_by uuid not null references public.users(id),
  approved_by uuid references public.users(id),
  approved_at timestamptz,
  exported_at timestamptz,
  settled_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payment_runs_maker_is_not_checker check (
    approved_by is null or approved_by <> created_by
  ),
  constraint payment_runs_approval_consistency check (
    not (status in ('approved', 'exported', 'settled'))
    or (approved_by is not null and approved_at is not null)
  ),
  constraint payment_runs_cancel_consistency check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (cancelled_at is not null) = (cancel_reason is not null)
    and (cancel_reason is null or btrim(cancel_reason) <> '')
  )
);

create index if not exists idx_payment_runs_status_exec_date
  on public.payment_runs (status, planned_execution_date desc);
create index if not exists idx_payment_runs_source_bank
  on public.payment_runs (source_bank_account_id);
create index if not exists idx_payment_runs_approval_id
  on public.payment_runs (approval_id)
  where approval_id is not null;

drop trigger if exists payment_runs_updated_at on public.payment_runs;
create trigger payment_runs_updated_at
  before update on public.payment_runs
  for each row execute function public.set_updated_at();

create or replace function public.payment_runs_status_transition_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('draft',            'pending_approval'),
    ('draft',            'cancelled'),
    ('pending_approval', 'approved'),
    ('pending_approval', 'draft'),
    ('pending_approval', 'cancelled'),
    ('approved',         'exported'),
    ('approved',         'settled'),
    ('approved',         'cancelled'),
    ('exported',         'settled'),
    ('exported',         'cancelled')
  ) then
    raise exception 'payment_runs.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;

  if new.status = 'approved'
     and current_user not in ('mas_radar_finance_approver', 'mas_radar_finance_manager', 'mas_radar_admin', 'postgres')
  then
    raise exception 'payment_run_approval_requires_approver: ödeme paketini yalnız onaylayıcı veya yönetici onaylayabilir.'
      using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists payment_runs_status_transition_guard on public.payment_runs;
create trigger payment_runs_status_transition_guard
  before update on public.payment_runs
  for each row execute function public.payment_runs_status_transition_guard();

create table if not exists public.payment_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payment_runs(id) on delete cascade,
  target_type text not null
    check (target_type in ('invoice', 'payment_instance', 'check', 'loan_installment')),
  target_id uuid not null,
  party_id uuid references public.parties(id) on delete restrict,
  iban_id uuid references public.ibans(id) on delete set null,
  beneficiary_name text not null check (btrim(beneficiary_name) <> ''),
  beneficiary_iban text not null check (btrim(beneficiary_iban) <> ''),
  amount numeric(14,2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  due_date date,
  description text not null check (btrim(description) <> ''),
  iban_verified boolean not null default false,
  settled_bank_tx_id uuid references public.bank_transactions(id) on delete set null,
  settled_at timestamptz,
  status text not null default 'included'
    check (status in ('included', 'settled', 'excluded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Açık bir hedef kalemin aynı anda iki aktif pakette yer almasını önleyen kısmi benzersiz indeks
create unique index if not exists payment_run_items_active_target_uq
  on public.payment_run_items (target_type, target_id)
  where status = 'included';

create index if not exists idx_payment_run_items_run_id
  on public.payment_run_items (run_id);
create index if not exists idx_payment_run_items_target
  on public.payment_run_items (target_type, target_id);
create index if not exists idx_payment_run_items_settled_bank_tx
  on public.payment_run_items (settled_bank_tx_id)
  where settled_bank_tx_id is not null;

drop trigger if exists payment_run_items_updated_at on public.payment_run_items;
create trigger payment_run_items_updated_at
  before update on public.payment_run_items
  for each row execute function public.set_updated_at();

create or replace function public.payment_run_items_status_transition_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('included', 'settled'),
    ('included', 'excluded'),
    ('excluded', 'included')
  ) then
    raise exception 'payment_run_items.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;

  return new;
end $$;

drop trigger if exists payment_run_items_status_transition_guard on public.payment_run_items;
create trigger payment_run_items_status_transition_guard
  before update on public.payment_run_items
  for each row execute function public.payment_run_items_status_transition_guard();

-- ── 5) 5-katmanlı RLS ve açık tablo yetkileri (operational sınıfı + maker-checker geri yazımı) ─
alter table public.payment_runs enable row level security;
alter table public.payment_run_items enable row level security;

revoke all on table public.payment_runs from public, anon, authenticated, mas_radar_app;
revoke all on table public.payment_run_items from public, anon, authenticated, mas_radar_app;

grant select on table public.payment_runs
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;
grant insert, update on table public.payment_runs
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin;
grant update on table public.payment_runs
  to mas_radar_finance_approver;
grant delete on table public.payment_runs
  to mas_radar_finance_manager, mas_radar_admin;

grant select on table public.payment_run_items
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;
grant insert, update on table public.payment_run_items
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin;
grant update on table public.payment_run_items
  to mas_radar_finance_approver;
grant delete on table public.payment_run_items
  to mas_radar_finance_manager, mas_radar_admin;

drop policy if exists payment_runs_select_all_tiers on public.payment_runs;
create policy payment_runs_select_all_tiers on public.payment_runs
  for select
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists payment_runs_insert_operational on public.payment_runs;
create policy payment_runs_insert_operational on public.payment_runs
  for insert
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (
    created_by is not distinct from public.current_app_user()
    or public.current_app_user() is null
  );

drop policy if exists payment_runs_update_operational on public.payment_runs;
create policy payment_runs_update_operational on public.payment_runs
  for update
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true)
  with check (true);

drop policy if exists payment_runs_delete_managers on public.payment_runs;
create policy payment_runs_delete_managers on public.payment_runs
  for delete
  to mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists payment_run_items_select_all_tiers on public.payment_run_items;
create policy payment_run_items_select_all_tiers on public.payment_run_items
  for select
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists payment_run_items_insert_operational on public.payment_run_items;
create policy payment_run_items_insert_operational on public.payment_run_items
  for insert
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (true);

drop policy if exists payment_run_items_update_operational on public.payment_run_items;
create policy payment_run_items_update_operational on public.payment_run_items
  for update
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true)
  with check (true);

drop policy if exists payment_run_items_delete_managers on public.payment_run_items;
create policy payment_run_items_delete_managers on public.payment_run_items
  for delete
  to mas_radar_finance_manager, mas_radar_admin
  using (true);

-- ── 6) mas_radar_finance_approver için dar Maker-Checker geri yazım politikaları ve kolon bekçisi
grant select, update on table public.invoices to mas_radar_finance_approver;
grant select, update on table public.payment_instances to mas_radar_finance_approver;
grant select, update on table public.ibans to mas_radar_finance_approver;
grant select, update on table public.parties to mas_radar_finance_approver;

drop policy if exists payment_runs_approver_writeback on public.payment_runs;
create policy payment_runs_approver_writeback on public.payment_runs
  for update to mas_radar_finance_approver
  using (
    public.current_app_user() is not null
    and created_by is distinct from public.current_app_user()
    and exists (
      select 1
        from public.approvals a
       where a.subject_table = 'payment_runs'
         and a.subject_id = payment_runs.id
         and a.requested_by is distinct from public.current_app_user()
    )
  )
  with check (
    created_by is distinct from public.current_app_user()
    and exists (
      select 1
        from public.approvals a
       where a.subject_table = 'payment_runs'
         and a.subject_id = payment_runs.id
         and a.requested_by is distinct from public.current_app_user()
    )
  );

drop policy if exists payment_run_items_approver_writeback on public.payment_run_items;
create policy payment_run_items_approver_writeback on public.payment_run_items
  for update to mas_radar_finance_approver
  using (
    public.current_app_user() is not null
    and (
      exists (
        select 1
          from public.payment_runs pr
          join public.approvals a
            on a.subject_table = 'payment_runs' and a.subject_id = pr.id
         where pr.id = payment_run_items.run_id
           and pr.created_by is distinct from public.current_app_user()
           and a.requested_by is distinct from public.current_app_user()
      )
      or exists (
        select 1
          from public.approvals a
         where a.subject_table = 'ibans'
           and a.subject_id = payment_run_items.iban_id
           and a.requested_by is distinct from public.current_app_user()
      )
    )
  )
  with check (
    exists (
      select 1
        from public.payment_runs pr
        join public.approvals a
          on a.subject_table = 'payment_runs' and a.subject_id = pr.id
       where pr.id = payment_run_items.run_id
         and pr.created_by is distinct from public.current_app_user()
         and a.requested_by is distinct from public.current_app_user()
    )
    or exists (
      select 1
        from public.approvals a
       where a.subject_table = 'ibans'
         and a.subject_id = payment_run_items.iban_id
         and a.requested_by is distinct from public.current_app_user()
    )
  );

drop policy if exists invoices_approver_writeback on public.invoices;
create policy invoices_approver_writeback on public.invoices
  for update to mas_radar_finance_approver
  using (
    public.current_app_user() is not null
    and exists (
      select 1
        from public.approvals a
       where a.subject_table = 'invoices'
         and a.subject_id = invoices.id
         and a.requested_by is distinct from public.current_app_user()
    )
  )
  with check (
    exists (
      select 1
        from public.approvals a
       where a.subject_table = 'invoices'
         and a.subject_id = invoices.id
         and a.requested_by is distinct from public.current_app_user()
    )
  );

drop policy if exists payment_instances_approver_writeback on public.payment_instances;
create policy payment_instances_approver_writeback on public.payment_instances
  for update to mas_radar_finance_approver
  using (
    public.current_app_user() is not null
    and exists (
      select 1
        from public.approvals a
       where a.subject_table = 'payment_instances'
         and a.subject_id = payment_instances.id
         and a.requested_by is distinct from public.current_app_user()
    )
  )
  with check (
    exists (
      select 1
        from public.approvals a
       where a.subject_table = 'payment_instances'
         and a.subject_id = payment_instances.id
         and a.requested_by is distinct from public.current_app_user()
    )
  );

drop policy if exists ibans_approver_writeback on public.ibans;
create policy ibans_approver_writeback on public.ibans
  for update to mas_radar_finance_approver
  using (
    public.current_app_user() is not null
    and exists (
      select 1
        from public.approvals a
       where a.subject_table = 'ibans'
         and a.subject_id = ibans.id
         and a.requested_by is distinct from public.current_app_user()
    )
  )
  with check (
    exists (
      select 1
        from public.approvals a
       where a.subject_table = 'ibans'
         and a.subject_id = ibans.id
         and a.requested_by is distinct from public.current_app_user()
    )
  );

drop policy if exists parties_approver_writeback on public.parties;
create policy parties_approver_writeback on public.parties
  for update to mas_radar_finance_approver
  using (
    public.current_app_user() is not null
    and exists (
      select 1
        from public.approvals a
       where a.subject_table = 'parties'
         and a.subject_id = parties.id
         and a.requested_by is distinct from public.current_app_user()
    )
  )
  with check (
    exists (
      select 1
        from public.approvals a
       where a.subject_table = 'parties'
         and a.subject_id = parties.id
         and a.requested_by is distinct from public.current_app_user()
    )
  );

create or replace function public.enforce_approver_subject_writeback_columns()
returns trigger
language plpgsql
as $$
declare
  v_table text := tg_table_name;
begin
  if current_user <> 'mas_radar_finance_approver' then
    return new;
  end if;

  if v_table = 'payment_runs' then
    if (to_jsonb(new) - array[
          'status', 'approval_id', 'approved_by', 'approved_at',
          'cancelled_at', 'cancel_reason', 'updated_at'
        ])
       is distinct from
       (to_jsonb(old) - array[
          'status', 'approval_id', 'approved_by', 'approved_at',
          'cancelled_at', 'cancel_reason', 'updated_at'
        ])
    then
      raise exception 'Onaylayıcı payment_runs üzerinde yalnız onay durumunu güncelleyebilir.'
        using errcode = 'insufficient_privilege';
    end if;
  elsif v_table = 'payment_run_items' then
    if (to_jsonb(new) - array['status', 'iban_verified', 'updated_at'])
       is distinct from
       (to_jsonb(old) - array['status', 'iban_verified', 'updated_at'])
    then
      raise exception 'Onaylayıcı payment_run_items üzerinde yalnız kalem durumunu güncelleyebilir.'
        using errcode = 'insufficient_privilege';
    end if;
  elsif v_table in ('invoices', 'payment_instances', 'parties') then
    if (to_jsonb(new) - array['approval_status', 'approval_id', 'approved_by', 'approved_at', 'updated_at'])
       is distinct from
       (to_jsonb(old) - array['approval_status', 'approval_id', 'approved_by', 'approved_at', 'updated_at'])
    then
      raise exception 'Onaylayıcı % üzerinde yalnız onay durumunu güncelleyebilir.', v_table
        using errcode = 'insufficient_privilege';
    end if;
  elsif v_table = 'ibans' then
    if (to_jsonb(new) - array['approval_status', 'approval_id', 'verified_by', 'verified_at', 'updated_at'])
       is distinct from
       (to_jsonb(old) - array['approval_status', 'approval_id', 'verified_by', 'verified_at', 'updated_at'])
    then
      raise exception 'Onaylayıcı ibans üzerinde yalnız IBAN onay/doğrulama durumunu güncelleyebilir.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end $$;

do $attach_approver_guards$
declare
  tbl text;
begin
  foreach tbl in array array[
    'payment_runs',
    'payment_run_items',
    'invoices',
    'payment_instances',
    'ibans',
    'parties'
  ] loop
    execute format('drop trigger if exists %I on public.%I', tbl || '_approver_column_guard', tbl);
    execute format(
      'create trigger %I before update on public.%I '
      || 'for each row execute function public.enforce_approver_subject_writeback_columns()',
      tbl || '_approver_column_guard',
      tbl
    );
  end loop;
end $attach_approver_guards$;

-- ── 7) Kendi kendini doğrulayan şema ve RLS kapısı ────────────────────────────────────────────
do $verify_0101$
declare
  v_tbl text;
  v_rls boolean;
begin
  foreach v_tbl in array array['payment_runs', 'payment_run_items'] loop
    select c.relrowsecurity
      into v_rls
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = v_tbl;

    if v_rls is not true then
      raise exception '0101 doğrulama hatası: public.% tablosu bulunamadı veya RLS aktif değil.', v_tbl;
    end if;
  end loop;
end $verify_0101$;
