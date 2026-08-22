-- Faz 22 — settlement allocations: the many-to-many link between money and invoices.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- THE INVARIANT THIS PHASE EXISTS TO GUARANTEE:
--
--     Σ(open allocations for an invoice) ≤ invoices.gross_amount   — ALWAYS, no exceptions.
--
-- implementation.md §18 states it as "ödenen > fatura, tahsilat > alacak hiç aşılmamalı", and
-- is explicit that an application-level check is not enough: it must hold in PostgreSQL. So it
-- is a trigger, not a convention — see allocations_enforce_invoice_ceiling() below.
--
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT. A CHECK sees one row. This invariant is about the
-- SUM of many rows against a value in a different table, which no CHECK can express. A trigger
-- that recomputes the total for the affected invoice is the only construction that actually
-- holds — and it is written to fire on INSERT, UPDATE and DELETE so there is no gap.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- ONE TABLE, NOT TWO. implementation.md names `payment_allocations` and
-- `collection_allocations`. They would be column-for-column identical — the direction is
-- already unambiguous from `invoices.direction` — and splitting them would mean the ceiling
-- invariant had to be summed ACROSS two tables by two triggers that must agree forever. One
-- table means one trigger means one place the invariant lives. The two names the plan asks for
-- are provided as filtered views in 0050, so the vocabulary survives without the duplication.
--
-- NO STATUS COLUMN. An allocation exists or it has been reversed; `reversed_at` is a nullable
-- timestamp with no transitions to constrain. This is the same decision Faz 20 made for
-- bank_transaction_match_candidates and Faz 19 for its dimension tables, and it is deliberate:
-- implementation.md §17 rule 3 requires a COMPLETE transition guard for every new lifecycle,
-- and the way to honour that in a phase that does not need one is to not invent one.
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

create table if not exists public.invoice_allocations (
  id uuid primary key default gen_random_uuid(),

  -- CASCADE is safe here and is NOT the mistake 0046 made: this table has no append-only
  -- trigger, so a TRUNCATE CASCADE from the staging layer simply clears it, which is the
  -- correct behaviour for a dev reset. An issued invoice cannot be deleted at all (0045), and
  -- a draft cannot carry allocations (the ceiling trigger refuses them), so the cascade only
  -- ever fires during a wholesale reset.
  invoice_id uuid not null references public.invoices(id) on delete cascade,

  -- Where the money came from. Polymorphic, matching how this schema already points at "one of
  -- the financial entities" (audit_logs.entity_table, bank_transaction_match_candidates).
  -- 'manual' covers an operator recording a settlement with no linked record — a cash payment,
  -- an offset agreed by phone — which must be representable or people will falsify one of the
  -- other kinds to get the number in.
  source_table text not null
    check (source_table in ('bank_transactions', 'payment_instances', 'checks', 'manual')),
  -- Null only for 'manual'. Bidirectional so a typed source cannot lose its id.
  source_id uuid,
  constraint invoice_allocations_source_consistency check (
    (source_table = 'manual') = (source_id is null)
  ),

  -- Strictly positive. A "negative allocation" would be a reversal, and reversals are recorded
  -- by setting reversed_at rather than by writing a second row that cancels the first — the
  -- latter makes every SUM in the system conditional on remembering to net them.
  allocated_amount numeric(14,2) not null check (allocated_amount > 0),
  allocated_on date not null default current_date,

  -- Reversal, not deletion: an allocation that was made and undone is history worth keeping,
  -- and the ceiling trigger below ignores reversed rows.
  reversed_at timestamptz,
  reversed_by uuid references public.users(id),
  reversed_reason text,
  constraint invoice_allocations_reversal_consistency check (
    (reversed_at is not null) = (reversed_by is not null)
    and (reversed_at is null or (reversed_reason is not null and btrim(reversed_reason) <> ''))
  ),

  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One open allocation per (invoice, source row). A second one would double-count the same
-- money against the same invoice. Reversed rows are excluded so a corrected allocation can be
-- re-made after its predecessor is reversed.
create unique index if not exists invoice_allocations_open_uq
  on public.invoice_allocations (invoice_id, source_table, source_id)
  where reversed_at is null and source_id is not null;

create index if not exists invoice_allocations_invoice_idx
  on public.invoice_allocations (invoice_id) where reversed_at is null;
create index if not exists invoice_allocations_source_idx
  on public.invoice_allocations (source_table, source_id) where reversed_at is null;

drop trigger if exists invoice_allocations_updated_at on public.invoice_allocations;
create trigger invoice_allocations_updated_at before update on public.invoice_allocations
  for each row execute function public.set_updated_at();

-- ── the allocated total, maintained on the invoice ─────────────────────────────────────────
--
-- DISTINCT FROM Faz 21's `paid_amount`, and the distinction is real accounting rather than
-- bookkeeping pedantry:
--
--   paid_amount      how much money has been RECORDED against this invoice. 0044 deliberately
--                    puts no ceiling on it, because over-receipt happens (a duplicate transfer,
--                    an FX difference at the bank) and blocking it would force an operator to
--                    falsify the record.
--   allocated_amount how much of that money has been formally ASSIGNED to this invoice. Capped
--                    at the invoice total by the trigger below, because assigning 130 to a 120
--                    invoice is not an over-receipt — it is 10 that belongs somewhere else.
--
-- So an over-receipt shows up as paid_amount > gross with allocated_amount = gross, and the
-- unallocated remainder is visible on the source side (0050's settlement_unallocated view).
alter table public.invoices add column if not exists allocated_amount numeric(14,2) not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_allocated_within_gross') then
    alter table public.invoices
      add constraint invoices_allocated_within_gross
      check (allocated_amount >= 0 and allocated_amount <= gross_amount);
  end if;
end $$;

-- ── THE CEILING TRIGGER ────────────────────────────────────────────────────────────────────
create or replace function public.allocations_enforce_invoice_ceiling() returns trigger
language plpgsql as $$
declare
  target uuid;
  targets uuid[];
  total numeric(14,2);
  gross numeric(14,2);
  inv_status text;
begin
  -- An UPDATE can move an allocation between invoices, so BOTH sides must be recomputed.
  -- Collecting them into an array rather than handling only NEW is what stops a moved
  -- allocation from leaving its old invoice over-counted.
  targets := array_remove(array[
    case when tg_op <> 'DELETE' then new.invoice_id end,
    case when tg_op <> 'INSERT' then old.invoice_id end
  ], null);

  foreach target in array targets loop
    select i.gross_amount, i.status into gross, inv_status
    from public.invoices i where i.id = target for update;

    -- The invoice may be gone (ON DELETE CASCADE clearing a draft, or a TRUNCATE). Nothing to
    -- enforce and nothing to update; refusing here would make a legitimate reset impossible —
    -- the lesson 0046 learned the hard way.
    if gross is null then
      continue;
    end if;

    -- Allocations belong to an issued, live invoice. Draft has not been issued, cancelled is
    -- void, closed has been settled and must be reopened first. Checked only when the
    -- allocation set actually grows, so reversing or clearing allocations on a closed or
    -- cancelled invoice stays possible — a guard that blocks cleanup is a guard drawn too wide.
    if tg_op <> 'DELETE' and new.reversed_at is null and inv_status not in ('open', 'partial', 'paid') then
      raise exception
        'invoice_allocations: % durumundaki faturaya (%) tahsilat/ödeme bağlanamaz (yalnız open/partial/paid).',
        inv_status, target;
    end if;

    select coalesce(sum(a.allocated_amount), 0) into total
    from public.invoice_allocations a
    where a.invoice_id = target and a.reversed_at is null;

    if total > gross then
      raise exception
        'invoice_allocations: fatura % için dağıtım toplamı (%) fatura tutarını (%) aşamaz.',
        target, total, gross;
    end if;

    update public.invoices set allocated_amount = total where id = target;
  end loop;

  return coalesce(new, old);
end $$;

-- AFTER, not BEFORE: the sum must be computed over the table's committed-in-statement state,
-- including the row being written. A BEFORE trigger would miss its own NEW row on INSERT.
drop trigger if exists invoice_allocations_ceiling on public.invoice_allocations;
create trigger invoice_allocations_ceiling
  after insert or update or delete on public.invoice_allocations
  for each row execute function public.allocations_enforce_invoice_ceiling();

alter table public.invoice_allocations enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='invoice_allocations'
      and policyname='invoice_allocations_authenticated_all'
  ) then
    create policy invoice_allocations_authenticated_all on public.invoice_allocations
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.invoice_allocations to authenticated;
