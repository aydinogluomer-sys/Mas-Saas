-- Faz 25 — promise to pay: what a customer SAID they would do, kept apart from what they did.
--
-- A promise is not a receivable and must never be mistaken for one. `invoices` records an
-- obligation; this records a statement made on a phone call. Keeping them in separate tables is
-- the point: a promise carries no accounting weight, cannot be allocated against, and never
-- changes an invoice's balance. It exists so the gap between the two can be measured, which is
-- the only reason a collections function tracks promises at all.
--
-- WHY A NEW TABLE RATHER THAN REUSING action_items
--
-- The plan is explicit that collection NOTES reuse action_items and that no second task model
-- gets invented, and this migration honours that — the follow-up work a broken promise creates
-- is an action_item (0060 widens its source_type for exactly this). But a promise itself is not
-- a task: it has a counterparty, an amount, a promised DATE that is compared against reality,
-- and an outcome that feeds a score. Modelling it as an action_item would have meant stuffing
-- those into `note` and losing every one of them to free text.

create table if not exists public.promise_to_pay (
  id uuid primary key default gen_random_uuid(),

  -- Who promised. Required: a promise nobody made is not a promise.
  party_id uuid not null references public.parties(id),

  -- Which invoice, when the promise is about a specific one. NULLABLE on purpose: customers
  -- routinely promise against a balance ("I'll send 50.000 next week") without naming documents,
  -- and forcing an invoice here would either block that or invite a wrong guess.
  invoice_id uuid references public.invoices(id),

  -- NULL means UNKNOWN, not zero (CLAUDE.md). "They said they'd pay something this week" is a
  -- real promise worth tracking, and recording it as 0,00 TL would understate exposure in every
  -- view that sums this column.
  promised_amount numeric(14,2),
  currency text not null default 'TRY',

  -- The date they said it would arrive. NOT NULL: this is the column the whole table exists to
  -- compare against today, and a promise without a date cannot be kept or broken.
  promised_date date not null,

  status text not null default 'pending'
    check (status in ('pending', 'kept', 'broken', 'cancelled')),

  -- How the promise reached us, so a score can weigh a signed commitment differently from a
  -- remark on a call if that is ever wanted. Deliberately descriptive, not scored today.
  channel text not null default 'phone'
    check (channel in ('phone', 'email', 'meeting', 'message', 'other')),

  resolved_at timestamptz,
  -- NULLABLE, and the reason is the Faz 24A lesson repeated: the broken-promise detection job
  -- has no signed-in user behind it. Requiring an actor here would have forced the job to invent
  -- one, which is exactly the fabrication that phase removed from the archive engine. A NULL
  -- here means "no person decided this" — and resolution_source says which mechanism did.
  resolved_by uuid references public.users(id),
  resolution_source text
    check (resolution_source in ('manual', 'auto_detection')),

  note text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Resolution fields travel together with the status, in both directions.
  constraint promise_to_pay_resolution_consistency check (
    (status <> 'pending') = (resolved_at is not null)
    and (resolved_at is not null) = (resolution_source is not null)
  ),

  -- A promise of a negative amount is not a promise. Zero is allowed and means an explicit
  -- "nothing this period", which is a different statement from an unknown amount (NULL).
  constraint promise_to_pay_amount_sign check (promised_amount is null or promised_amount >= 0)
);

comment on table public.promise_to_pay is
  'Faz 25: a customer''s stated intention to pay. Carries no accounting weight — it never '
  'changes an invoice balance and is never allocated against. Exists to measure the gap '
  'between what was promised and what arrived.';
comment on column public.promise_to_pay.promised_amount is
  'NULL = unknown (the customer did not name a figure), NOT zero. Zero is an explicit "nothing".';
comment on column public.promise_to_pay.resolved_by is
  'NULL when the automatic detection job resolved it rather than a person; resolution_source '
  'distinguishes the two. No actor is invented to satisfy a constraint.';

-- ── status transition guard, in the SAME migration as the CHECK ────────────────────────
--
-- Migration 0027 is why this is not deferred: it opened checks/loan_installments with only
-- planned→cancelled while the CHECK had allowed cleared/bounced/paid since 0005, and 7/7 checks
-- and 48/48 installments sat frozen in the real database for eight migrations. The allow-list
-- below is therefore written against the full CHECK, not against the transitions that happen to
-- be convenient today.
--
-- The four permitted moves:
--   pending → kept        the money arrived
--   pending → broken      the date passed without it
--   pending → cancelled   the promise was withdrawn or superseded before its date
--   broken  → kept        THE ONE THAT IS EASY TO MISS. Late payment is the normal outcome of a
--                         broken promise, not an exception. Without this, a customer who pays
--                         three days late is frozen as 'broken' forever and every score built on
--                         this table would permanently understate them.
--
-- kept and cancelled are terminal. Reopening a settled promise would rewrite collection history
-- silently; the honest way to record a further commitment is a NEW promise, which is also what
-- the score should see.
create or replace function public.promise_to_pay_guard_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('pending', 'kept'),
    ('pending', 'broken'),
    ('pending', 'cancelled'),
    ('broken',  'kept')
  ) then
    raise exception 'Geçersiz ödeme sözü durum geçişi: % → % (söz %)', old.status, new.status, old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists promise_to_pay_transition_guard on public.promise_to_pay;
create trigger promise_to_pay_transition_guard
  before update of status on public.promise_to_pay
  for each row execute function public.promise_to_pay_guard_transition();

drop trigger if exists promise_to_pay_updated_at on public.promise_to_pay;
create trigger promise_to_pay_updated_at before update on public.promise_to_pay
  for each row execute function public.set_updated_at();

-- ── indexes ────────────────────────────────────────────────────────────────────────────
-- The detection job's exact predicate: pending promises whose date has passed.
create index if not exists promise_to_pay_due_idx
  on public.promise_to_pay (status, promised_date);
create index if not exists promise_to_pay_party_idx
  on public.promise_to_pay (party_id, status);
create index if not exists promise_to_pay_invoice_idx
  on public.promise_to_pay (invoice_id) where invoice_id is not null;

-- Guards against double entry of the same open promise. NULLS NOT DISTINCT matters here: most
-- promises have no invoice_id, and under the default rule every one of those NULLs counts as
-- unique, so the index would silently protect nothing for the common case.
create unique index if not exists promise_to_pay_open_unique
  on public.promise_to_pay (party_id, invoice_id, promised_date)
  nulls not distinct
  where status = 'pending';

-- ── RLS, in the Faz 24B tier model ─────────────────────────────────────────────────────
-- Access class: OPERATIONAL. Recording that a customer promised to pay is day-to-day collections
-- work, which is finance_operator's job; correcting or removing one is manager/admin. This is the
-- same class payments/invoices/checks carry, and it is chosen from 0058's own reasoning rather
-- than by reinstating the pre-24B blanket policy.
--
-- Written out explicitly rather than relying on any default: the policy names follow the
-- `<table>_select_all_tiers` convention that db:roles-rls:verify targets structurally, and
-- src/lib/authz/matrix.ts carries the matching classification so code and database are proven to
-- agree by that gate.
alter table public.promise_to_pay enable row level security;

drop policy if exists promise_to_pay_select_all_tiers on public.promise_to_pay;
create policy promise_to_pay_select_all_tiers on public.promise_to_pay
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists promise_to_pay_insert_enter on public.promise_to_pay;
create policy promise_to_pay_insert_enter on public.promise_to_pay
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (true);

-- Deliberately NOT owner-scoped, unlike action_items. Collections is collaborative: whoever
-- answers the phone when the money lands must be able to mark the promise kept, even though a
-- colleague recorded it. Restricting updates to the creator would leave promises stuck pending
-- whenever someone was away — the availability cost outweighs the tightening, which is the same
-- judgement Faz 24B made about backfilling owner columns.
drop policy if exists promise_to_pay_update_enter on public.promise_to_pay;
create policy promise_to_pay_update_enter on public.promise_to_pay
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);

drop policy if exists promise_to_pay_delete_manage on public.promise_to_pay;
create policy promise_to_pay_delete_manage on public.promise_to_pay
  for delete to mas_radar_finance_manager, mas_radar_admin
  using (true);
