-- 0110 — Durum Makinelerinde Hapis Çıkışlarının Açılması (F-15 / F-57),
-- Tevkifatlı Fatura 'paid' Kapanış Kuralı (F-24), Çek-Fatura Kolon Hizalaması (F-20)
-- ve liquidity_forecast_daily / financial_calendar Çift Sayım Koruması (F-15).
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz.
--   * Tüm görünümler WITH (security_invoker = true) taşır.

-- ── 1) payment_instances geçiş bekçisi: 'partial' -> 'unpaid' | 'cancelled' çıkışları ──────────
create or replace function public.payment_instances_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('unpaid', 'paid'), ('planned', 'paid'), ('late', 'paid'), ('partial', 'paid'),
    ('unpaid', 'partial'), ('planned', 'partial'), ('late', 'partial'),
    ('unpaid', 'late'), ('planned', 'late'),
    ('paid', 'unpaid'),
    ('partial', 'unpaid'),
    ('unpaid', 'cancelled'), ('planned', 'cancelled'), ('late', 'cancelled'), ('partial', 'cancelled')
  ) then
    raise exception 'payment_instances.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;

-- ── 2) checks geçiş bekçisi: 'unknown' -> 'in_portfolio' | 'issued_to_vendor' | 'cancelled' ────
create or replace function public.checks_status_transition_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    -- Geriye uyumlu 'planned' çıkışları
    ('planned',            'in_portfolio'),
    ('planned',            'issued_to_vendor'),
    ('planned',            'endorsed_to_vendor'),
    ('planned',            'in_bank_collection'),
    ('planned',            'in_bank_collateral'),
    ('planned',            'cleared'),
    ('planned',            'bounced'),
    ('planned',            'returned'),
    ('planned',            'cancelled'),

    -- İçe aktarım 'unknown' durumundan sınıflandırma / iptal çıkışları (F-15 / F-57)
    ('unknown',            'in_portfolio'),
    ('unknown',            'issued_to_vendor'),
    ('unknown',            'cancelled'),

    -- Portföydeki müşteri çeki / senedi (in_portfolio)
    ('in_portfolio',       'endorsed_to_vendor'),
    ('in_portfolio',       'in_bank_collection'),
    ('in_portfolio',       'in_bank_collateral'),
    ('in_portfolio',       'cleared'),
    ('in_portfolio',       'bounced'),
    ('in_portfolio',       'returned'),
    ('in_portfolio',       'cancelled'),

    -- Tedarikçiye ciro edilen müşteri çeki
    ('endorsed_to_vendor', 'cleared'),
    ('endorsed_to_vendor', 'bounced'),
    ('endorsed_to_vendor', 'returned'),
    ('endorsed_to_vendor', 'in_portfolio'),

    -- Bankada tahsildeki müşteri çeki
    ('in_bank_collection', 'cleared'),
    ('in_bank_collection', 'bounced'),
    ('in_bank_collection', 'returned'),
    ('in_bank_collection', 'in_portfolio'),

    -- Bankada kredi teminatındaki müşteri çeki
    ('in_bank_collateral', 'cleared'),
    ('in_bank_collateral', 'bounced'),
    ('in_bank_collateral', 'returned'),
    ('in_bank_collateral', 'in_portfolio'),
    ('in_bank_collateral', 'in_bank_collection'),

    -- Kendi keşide ettiğimiz borç çeki / senedimiz
    ('issued_to_vendor',   'cleared'),
    ('issued_to_vendor',   'bounced'),
    ('issued_to_vendor',   'returned'),
    ('issued_to_vendor',   'cancelled'),

    -- Karşılıksız (bounced) sonrası tahsilat, rücu portföy dönüşü, iade veya terkin
    ('bounced',            'cleared'),
    ('bounced',            'returned'),
    ('bounced',            'in_portfolio'),
    ('bounced',            'cancelled'),

    -- İade edilen çekin kayıttan iptali
    ('returned',           'cancelled')
  ) then
    raise exception 'checks.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;

  return new;
end $$;

-- ── 3) loan_installments geçiş bekçisi: 'unpaid' ve 'partial' hapis çıkışları ──────────────────
create or replace function public.loan_installments_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('planned', 'paid'),    ('late', 'paid'),    ('unpaid', 'paid'),    ('partial', 'paid'),
    ('planned', 'partial'), ('late', 'partial'), ('unpaid', 'partial'),
    ('planned', 'late'),    ('unpaid', 'late'),
    ('unpaid', 'planned'),  ('partial', 'planned'), ('paid', 'planned'),
    ('planned', 'cancelled'), ('late', 'cancelled'), ('unpaid', 'cancelled'), ('partial', 'cancelled')
  ) then
    raise exception 'loan_installments.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;

-- ── 4) Tevkifatlı Faturalarda payable_amount Tam Kapanış Kuralı (F-24) ─────────────────────────
create or replace function public.allocations_enforce_invoice_ceiling()
returns trigger
language plpgsql
as $$
declare
  target uuid;
  targets uuid[];
  total numeric(14,2);
  gross numeric(14,2);
  v_payable numeric(14,2);
  v_ceiling numeric(14,2);
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
    select i.gross_amount, i.payable_amount, i.status, i.allocated_amount, i.paid_amount
      into gross, v_payable, inv_status, prev_alloc, prev_paid
      from public.invoices i
     where i.id = target
       for update;

    if gross is null then
      continue;
    end if;

    v_ceiling := coalesce(v_payable, gross);

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

    if total > v_ceiling then
      raise exception
        'invoice_allocations: fatura % için dağıtım toplamı (%) fatura tutarını (%) aşamaz.',
        target, total, v_ceiling;
    end if;

    new_paid := greatest(total, coalesce(prev_paid, 0) - greatest(0, coalesce(prev_alloc, 0) - total));

    if inv_status in ('open', 'partial', 'paid') then
      next_status := case
        when new_paid <= 0 then 'open'
        when new_paid >= v_ceiling then 'paid'
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

-- Mevcut kısmi görünümde takılı kalmış tevkifatlı faturaları hizala
do $$
begin
  if exists (
    select 1
      from public.invoices i
     where i.status = 'partial'
       and i.payable_amount is not null
       and greatest(coalesce(i.paid_amount, 0), coalesce(i.allocated_amount, 0)) >= i.payable_amount
  ) then
    alter table public.invoices disable trigger user;
    update public.invoices i
       set status = 'paid'
     where i.status = 'partial'
       and i.payable_amount is not null
       and greatest(coalesce(i.paid_amount, 0), coalesce(i.allocated_amount, 0)) >= i.payable_amount;
    alter table public.invoices enable trigger user;
  end if;
end $$;

-- ── 5) checks.settled_invoice_id <-> checks.linked_invoice_id Çift Yönlü Senkron (F-20) ────────
create or replace function public.checks_sync_invoice_link_columns()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.settled_invoice_id := coalesce(new.settled_invoice_id, new.linked_invoice_id);
    new.linked_invoice_id  := coalesce(new.linked_invoice_id, new.settled_invoice_id);
    return new;
  end if;

  if new.settled_invoice_id is distinct from old.settled_invoice_id
     and new.linked_invoice_id is not distinct from old.linked_invoice_id then
    new.linked_invoice_id := new.settled_invoice_id;
  elsif new.linked_invoice_id is distinct from old.linked_invoice_id
     and new.settled_invoice_id is not distinct from old.settled_invoice_id then
    new.settled_invoice_id := new.linked_invoice_id;
  end if;

  return new;
end $$;

drop trigger if exists checks_sync_invoice_links on public.checks;
create trigger checks_sync_invoice_links
  before insert or update on public.checks
  for each row execute function public.checks_sync_invoice_link_columns();

do $$
begin
  if exists (
    select 1
      from public.checks c
     where c.settled_invoice_id is distinct from c.linked_invoice_id
  ) then
    alter table public.checks disable trigger user;
    update public.checks
       set settled_invoice_id = coalesce(settled_invoice_id, linked_invoice_id),
           linked_invoice_id  = coalesce(linked_invoice_id, settled_invoice_id)
     where settled_invoice_id is distinct from linked_invoice_id;
    alter table public.checks enable trigger user;
  end if;
end $$;

-- ── 6) liquidity_forecast_daily & financial_calendar Çift Sayım Koruması (F-15 & F-20) ─────────
create or replace view public.liquidity_forecast_daily
with (security_invoker = true) as
  select
    pi.due_date                                   as flow_date,
    pi.currency                                   as currency,
    'payment_instance'::text                      as source_kind,
    pi.id                                         as source_id,
    case
      when pi.direction = 'inflow' then
        greatest(0, case when pi.status = 'partial' then pi.amount - coalesce(pi.paid_amount, 0) else pi.amount end)
      else
        -greatest(0, case when pi.status = 'partial' then pi.amount - coalesce(pi.paid_amount, 0) else pi.amount end)
    end                                           as amount_signed,
    'contracted'::text                            as certainty
  from public.payment_instances pi
  left join public.payments p on p.id = pi.payment_id
  where pi.status in ('planned', 'unpaid', 'partial', 'late')
    and (p.id is null or (p.status = 'active' and p.archived_at is null))
    and coalesce(pi.direction, 'outflow') <> 'transfer'
    and pi.currency is not null
    and pi.due_date is not null
    and pi.amount is not null

  union all

  select
    li.due_date,
    l.currency,
    'loan_installment'::text,
    li.id,
    -greatest(0, case when li.status = 'partial' then li.amount - coalesce(li.paid_amount, 0) else li.amount end),
    'contracted'::text
  from public.loan_installments li
  join public.loans l on l.id = li.loan_id
  where l.archived_at is null
    and li.status in ('planned', 'unpaid', 'partial', 'late')
    and li.due_date is not null
    and li.amount is not null

  union all

  select
    c.maturity_date,
    c.currency,
    'check'::text,
    c.id,
    c.signed_amount,
    'contracted'::text
  from public.checks c
  where c.archived_at is null
    and c.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
    and c.maturity_date is not null
    and c.signed_amount is not null

  union all

  select
    v.due_date,
    v.currency,
    'invoice'::text,
    v.id,
    case
      when v.direction = 'sales'
        then (coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)))
      else -(coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)))
    end,
    'contracted'::text
  from public.invoices v
  where v.status in ('open', 'partial')
    and v.due_date is not null
    and v.gross_amount is not null
    and coalesce(v.payable_amount, v.gross_amount) > greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0))
    and not (
      v.settled_by_check_id is not null
      and exists (
        select 1 from public.checks c0
        where c0.id = v.settled_by_check_id
          and c0.archived_at is null
          and c0.status <> 'cancelled'
      )
    )
    and not exists (
      select 1
      from public.payment_instances pi2
      left join public.payments p2 on p2.id = pi2.payment_id
      where pi2.linked_invoice_id = v.id
        and pi2.status <> 'cancelled'
        and (p2.id is null or (p2.status = 'active' and p2.archived_at is null))
    )
    and not exists (
      select 1
      from public.checks c2
      where coalesce(c2.settled_invoice_id, c2.linked_invoice_id) = v.id
        and c2.archived_at is null
        and c2.status <> 'cancelled'
    )

  union all

  -- F-15: Açık bir satış faturasına bağlı söz (pr.invoice_id) zaten fatura ayağında sayıldığı için
  -- projeksiyonda mükerrer toplanmaz; yalnızca faturasız veya projeksiyon dışı sözler eklenir.
  select
    pr.promised_date,
    pr.currency,
    'promise_to_pay'::text,
    pr.id,
    pr.promised_amount,
    'expected'::text
  from public.promise_to_pay pr
  where pr.status = 'pending'
    and pr.promised_amount is not null
    and pr.currency is not null
    and (
      pr.invoice_id is null
      or not exists (
        select 1
        from public.invoices inv
        where inv.id = pr.invoice_id
          and inv.status in ('open', 'partial')
          and inv.due_date is not null
          and inv.gross_amount is not null
          and coalesce(inv.payable_amount, inv.gross_amount) > greatest(coalesce(inv.allocated_amount, 0), coalesce(inv.paid_amount, 0))
      )
    );

create or replace view public.financial_calendar
with (security_invoker = true) as
  select
    'payment_instance'::text            as source_kind,
    i.id                                as source_id,
    i.due_date                          as event_date,
    coalesce(p.name, '(kalem)')         as label,
    c.name                              as category_name,
    pa.name                             as counterparty_name,
    case
      when i.direction = 'inflow' then
        greatest(0, case when i.status = 'partial' then i.amount - coalesce(i.paid_amount, 0) else i.amount end)
      else
        -greatest(0, case when i.status = 'partial' then i.amount - coalesce(i.paid_amount, 0) else i.amount end)
    end                                 as amount_signed,
    i.currency                          as currency,
    i.status                            as status,
    'contracted'::text                  as certainty
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  left join public.categories c on c.id = p.category_id
  left join public.parties pa on pa.id = p.provider_party_id
  where i.status in ('planned', 'unpaid', 'partial', 'late')
    and (p.id is null or (p.status = 'active' and p.archived_at is null))
    and coalesce(i.direction, 'outflow') <> 'transfer'
    and i.currency is not null
    and i.due_date is not null
    and i.amount is not null

  union all

  select
    'loan_installment'::text,
    li.id,
    li.due_date,
    coalesce(l.name, '(kredi)'),
    null::text,
    pl.name,
    -greatest(0, case when li.status = 'partial' then li.amount - coalesce(li.paid_amount, 0) else li.amount end),
    l.currency,
    li.status,
    'contracted'::text
  from public.loan_installments li
  join public.loans l on l.id = li.loan_id
  left join public.parties pl on pl.id = l.lender_party_id
  where l.archived_at is null
    and li.status in ('planned', 'unpaid', 'partial', 'late')
    and li.due_date is not null
    and li.amount is not null

  union all

  select
    'check'::text,
    ch.id,
    ch.maturity_date,
    coalesce(ch.counterparty_label, '(çek)'),
    null::text,
    coalesce(pe.name, py.name),
    ch.signed_amount,
    ch.currency,
    ch.status,
    'contracted'::text
  from public.checks ch
  left join public.parties pe on pe.id = ch.payee_party_id
  left join public.parties py on py.id = ch.payer_party_id
  where ch.archived_at is null
    and ch.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
    and ch.maturity_date is not null
    and ch.signed_amount is not null

  union all

  select
    'invoice'::text,
    v.id,
    v.due_date,
    coalesce(v.invoice_no, '(fatura)'),
    null::text,
    pv.name,
    case
      when v.direction = 'sales'
        then (coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)))
      else -(coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)))
    end,
    v.currency,
    v.status,
    'contracted'::text
  from public.invoices v
  left join public.parties pv on pv.id = v.party_id
  where v.status in ('open', 'partial')
    and v.due_date is not null
    and v.gross_amount is not null
    and coalesce(v.payable_amount, v.gross_amount) > greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0))
    and not (
      v.settled_by_check_id is not null
      and exists (
        select 1 from public.checks c0
        where c0.id = v.settled_by_check_id
          and c0.archived_at is null
          and c0.status <> 'cancelled'
      )
    )
    and not exists (
      select 1
      from public.payment_instances pi2
      left join public.payments p2 on p2.id = pi2.payment_id
      where pi2.linked_invoice_id = v.id
        and pi2.status <> 'cancelled'
        and (p2.id is null or (p2.status = 'active' and p2.archived_at is null))
    )
    and not exists (
      select 1
      from public.checks c2
      where coalesce(c2.settled_invoice_id, c2.linked_invoice_id) = v.id
        and c2.archived_at is null
        and c2.status <> 'cancelled'
    )

  union all

  select
    'promise_to_pay'::text,
    pr.id,
    pr.promised_date,
    pp.name,
    null::text,
    pp.name,
    pr.promised_amount,
    pr.currency,
    pr.status,
    'expected'::text
  from public.promise_to_pay pr
  join public.parties pp on pp.id = pr.party_id
  where pr.status = 'pending'
    and pr.promised_amount is not null
    and pr.currency is not null

  union all

  select
    'facility_expiry'::text,
    f.id,
    f.expiry_date,
    f.name,
    null::text,
    pf.name,
    null::numeric,
    f.currency,
    f.status,
    'renewal'::text
  from public.credit_facilities f
  left join public.parties pf on pf.id = f.lender_party_id
  where f.status in ('active', 'suspended')
    and f.expiry_date is not null;
