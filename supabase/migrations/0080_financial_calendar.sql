-- Faz 32 — the unified financial calendar. A VIEW over dates that already exist.
--
-- ═══ THE OPEN QUESTION THE PLAN LEFT FOR THIS PHASE, SETTLED ═══
--
-- implementation.md §3 asks whether salary / SGK / tax / rent / insurance / CapEx dates need a new
-- lightweight recurring-obligation record, or whether they belong in the existing payments module.
-- Answer: THE EXISTING MODULE, and no new table.
--
-- Measured before deciding: public.payments already carries `recurrence_type`
-- (one_off | monthly | weekly | yearly | irregular), `due_day`, `category_id` and
-- `provider_party_id`, with a CHECK requiring due_day whenever recurrence is monthly — and
-- payment_instances already materialises each occurrence. A monthly salary run, an SGK premium, a
-- quarterly tax payment and a rent are all exactly that shape: a categorised recurring payment.
--
-- A second "recurring obligations" table would therefore be a competing source of truth for the
-- one thing payments exists to model. Every screen would then have to ask which of the two to
-- believe, and the reconciliation between them would become somebody's job. What these categories
-- actually need is a category and a recurrence — both of which already exist.
--
-- So this migration adds NO table. The calendar is a read model that gathers dates from the
-- systems that own them.

create or replace view public.financial_calendar as
  -- Scheduled payment instances (this is where salary/rent/tax live, as recurring payments).
  select
    'payment_instance'::text            as source_kind,
    i.id                                as source_id,
    i.due_date                          as event_date,
    coalesce(p.name, '(kalem)')         as label,
    c.name                              as category_name,
    pa.name                             as counterparty_name,
    -- Signed: negative leaves the account. One signed column so a day's net is a plain sum and no
    -- consumer can forget the direction.
    case when i.direction = 'inflow' then i.amount else -i.amount end as amount_signed,
    coalesce(i.currency, 'TRY')         as currency,
    i.status                            as status,
    'contracted'::text                  as certainty
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  left join public.categories c on c.id = p.category_id
  left join public.parties pa on pa.id = p.provider_party_id
  where i.status in ('planned', 'unpaid', 'partial') and i.due_date is not null and i.amount is not null

  union all
  select 'loan_installment', li.id, li.due_date, coalesce(l.name, '(kredi)'), null,
         pl.name, -li.amount, 'TRY', li.status, 'contracted'
  from public.loan_installments li
  join public.loans l on l.id = li.loan_id
  left join public.parties pl on pl.id = l.lender_party_id
  where li.status in ('unpaid', 'partial') and li.due_date is not null and li.amount is not null

  union all
  -- Checks already carry a signed amount (0009), so the sign is taken rather than recomputed.
  select 'check', ch.id, ch.maturity_date, coalesce(ch.counterparty_label, '(çek)'), null,
         null, ch.signed_amount, 'TRY', ch.status, 'contracted'
  from public.checks ch
  where ch.status in ('planned', 'unpaid', 'partial')
    and ch.maturity_date is not null and ch.signed_amount is not null

  union all
  select 'invoice', v.id, v.due_date, coalesce(v.invoice_no, '(fatura)'), null,
         pv.name,
         case when v.direction = 'sales'
              then (v.gross_amount - coalesce(v.allocated_amount, 0))
              else -(v.gross_amount - coalesce(v.allocated_amount, 0)) end,
         v.currency, v.status, 'contracted'
  from public.invoices v
  left join public.parties pv on pv.id = v.party_id
  where v.status in ('open', 'partial') and v.due_date is not null and v.gross_amount is not null

  union all
  -- Faz 25 promises. `expected`, not `contracted`: a promise is a stated intention, and a calendar
  -- that ranked it alongside a signed instalment would overstate what is actually committed.
  -- A promise with no amount is excluded rather than counted as zero.
  select 'promise_to_pay', pr.id, pr.promised_date, pp.name, null, pp.name,
         pr.promised_amount, pr.currency, pr.status, 'expected'
  from public.promise_to_pay pr
  join public.parties pp on pp.id = pr.party_id
  where pr.status = 'pending' and pr.promised_amount is not null

  union all
  -- Facility expiry is a DATE THAT MATTERS but not a cash movement: the drawn balance becomes due
  -- and the unused headroom simply stops existing. amount_signed is NULL rather than 0 so it can
  -- never be summed into a day's net outflow — the same distinction the Faz 27 ladder makes.
  select 'facility_expiry', f.id, f.expiry_date, f.name, null, pf.name,
         null::numeric, f.currency, f.status, 'renewal'
  from public.credit_facilities f
  left join public.parties pf on pf.id = f.lender_party_id
  where f.status in ('active', 'suspended') and f.expiry_date is not null;

-- ── daily rollup, for the calendar screen ──────────────────────────────────────────────
create or replace view public.financial_calendar_daily as
  select
    event_date,
    currency,
    count(*)                                                     as event_count,
    -- Only contracted movements make up the committed net; expected promises are reported beside
    -- it so an optimistic figure can never quietly become the headline.
    coalesce(sum(amount_signed) filter (where certainty = 'contracted'), 0) as net_contracted,
    coalesce(sum(amount_signed) filter (where certainty = 'expected'), 0)   as net_expected,
    coalesce(sum(amount_signed) filter (where certainty = 'contracted' and amount_signed > 0), 0) as inflow_contracted,
    coalesce(sum(amount_signed) filter (where certainty = 'contracted' and amount_signed < 0), 0) as outflow_contracted,
    count(*) filter (where certainty = 'renewal')                as renewal_count
  from public.financial_calendar
  group by event_date, currency;

grant select on public.financial_calendar to authenticated;
grant select on public.financial_calendar_daily to authenticated;
