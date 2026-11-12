-- ================================================================================================
-- 0113: Likidite Projeksiyonu & Finansal Takvim Çek-Fatura Tahsisat Koruması (F-15 / F-20 İnce Ayar)
-- ================================================================================================
-- Neden gerekli?
-- 1) 0102 `check-bordro.ts` üzerinde müşteri çeki tedarikçiye ciro edildiğinde (`endorse_to_vendor`)
--    veya kendi keşide çekimiz kesildiğinde (`issue_own_check`), `public.invoice_allocations`
--    tablosuna aktif tahsisat satırı yazılır ve `invoices.allocated_amount` faturanın açık
--    bakiyesinden zaten düşülür; çek karşılıksız (`bounced`) çıktığında ise tahsisat terslenip
--    fatura borcu yeniden canlanır.
-- 2) Bu nedenle `checks` bağlantısı üzerinden faturanın projeksiyondan tamamen gizlenmesi YALNIZCA:
--    a) Çek halen projeksiyonun kendi `'check'` ayağında yer alan aktif bir statüdeyse
--       (`planned`, `in_portfolio`, `in_bank_collection`, `in_bank_collateral`, `issued_to_vendor`), VE
--    b) İlgili çek için `invoice_allocations` üzerinde aktif bir tahsisat satırı YOKSA (eski manuel
--       `linked_invoice_id` bağlantıları) uygulanmalıdır.
-- ================================================================================================

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
        and c2.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
        and not exists (
          select 1
          from public.invoice_allocations ia
          where ia.invoice_id = v.id
            and ia.source_table = 'checks'
            and ia.source_id = c2.id
            and ia.reversed_at is null
        )
    )

  union all

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
        and c2.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
        and not exists (
          select 1
          from public.invoice_allocations ia
          where ia.invoice_id = v.id
            and ia.source_table = 'checks'
            and ia.source_id = c2.id
            and ia.reversed_at is null
        )
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

revoke insert, update, delete, truncate on
  public.liquidity_forecast_daily,
  public.financial_calendar
from public, anon, authenticated, mas_radar_app,
     mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

grant select on
  public.liquidity_forecast_daily,
  public.financial_calendar
to authenticated, mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
   mas_radar_finance_manager, mas_radar_admin;
