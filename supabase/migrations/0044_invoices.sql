-- Faz 21 — Fatura Merkezi: invoice header.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- THE STATUS ALLOW-LIST. Six states, and every transition the application needs is declared
-- HERE, in the same migration as the CHECK constraint that admits the values.
--
-- This repo has paid for getting this wrong once: 0027 shipped three guards whose allow-lists
-- did not cover the values their CHECK constraints accepted, and 7/7 checks plus 48/48 loan
-- installments sat frozen in 'planned' for eight migrations while a KPI reported 0 paid.
-- docs/database-schema.md tells the whole story. Faz 20 repeated the discipline for
-- bank_transactions; this table has six states rather than five, so the matrix is larger and
-- the same rule applies with more force.
--
--   CHECK admits:  draft · open · partial · paid · closed · cancelled
--
--   draft   → open        invoice issued
--   draft   → cancelled   a draft discarded before it ever existed commercially
--   open    → partial     part of it was paid
--   open    → paid        paid in full
--   open    → closed      settled without full payment (write-off, agreed discount)
--   open    → cancelled   an ISSUED invoice voided — requires a reversal record (0046)
--   partial → paid        remainder paid
--   partial → open        the only payment was reversed
--   partial → closed      remainder written off
--   partial → cancelled   voided while partly paid
--   paid    → partial     a payment was reversed
--   paid    → open        every payment was reversed
--   paid    → closed      archived after settlement
--   closed  → open        reopened for correction
--
--   REACHABILITY: draft is the insert default; open from draft; partial from open/paid; paid
--   from open/partial; closed from open/partial/paid; cancelled from draft/open/partial.
--   All six reachable. scripts/phase21-verify.ts proves this by ENUMERATION over all 36 pairs
--   against real rows — it does not read this comment.
--
--   Deliberately NOT allowed, each for a reason rather than by omission:
--     anything → draft        an issued invoice cannot be un-issued. Reverting to 'draft'
--                             would erase the fact that it was ever put in front of a
--                             counterparty, and would re-open the immutability window below.
--     draft → partial/paid/closed   nothing can be paid before it is issued.
--     closed → partial/paid/cancelled   reopen to 'open' first, so the reopen is its own
--                             audited act (same construction as Faz 20's reconciled → matched).
--     cancelled → anything    TERMINAL. A cancelled invoice is voided by the linked reversal
--                             record in 0046; the remedy is to issue a new invoice, never to
--                             resurrect a voided one. This is the difference between an audit
--                             trail and a rewrite.
--
--   Same-status updates are a no-op for every value and never reach the allow-list (0027's
--   one correct part).
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),

  -- Sales (we issued it) vs purchase (we received it). Determines which side of the cash flow
  -- it belongs to; kept explicit rather than inferred from the party's type, because one
  -- counterparty can legitimately be both customer and supplier.
  direction text not null check (direction in ('sales', 'purchase')),
  invoice_no text not null check (btrim(invoice_no) <> ''),

  -- The counterparty. NOT NULL: an invoice without a party is not an invoice. NO ACTION
  -- matches every other FK into parties (Faz 19) — a referenced party cannot be deleted.
  party_id uuid not null references public.parties(id),

  -- Faz 19's organisational dimensions, all optional. Real column names verified by
  -- introspection before this migration was written, not assumed from the plan.
  cost_center_id uuid references public.cost_centers(id),
  project_id uuid references public.projects(id),
  order_id uuid references public.orders(id),

  issue_date date not null,
  due_date date,
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),

  -- Money. gross = net + tax is a real invariant and is enforced, not merely expected: an
  -- invoice whose parts do not add up is a data-entry error that must fail at write time
  -- rather than surface as an unexplained difference in a cash-flow forecast months later.
  net_amount numeric(14,2) not null check (net_amount >= 0),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  gross_amount numeric(14,2) not null check (gross_amount >= 0),
  constraint invoices_gross_is_net_plus_tax check (gross_amount = net_amount + tax_amount),

  -- Running settlement total. No upper bound on purpose: overpayment happens in reality
  -- (duplicate transfer, FX rounding at the bank), and blocking it would force an operator to
  -- falsify the record. It is surfaced by the overpaid view in 0047 instead — flag, never fix.
  paid_amount numeric(14,2) not null default 0 check (paid_amount >= 0),

  status text not null default 'draft'
    check (status in ('draft', 'open', 'partial', 'paid', 'closed', 'cancelled')),

  -- 0026's cancellation-fields pattern, reused rather than reinvented: bidirectional
  -- consistency plus a non-blank reason.
  cancelled_at timestamptz,
  cancel_reason text,
  constraint invoices_cancel_consistency check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (cancelled_at is not null) = (cancel_reason is not null)
    and (cancel_reason is null or btrim(cancel_reason) <> '')
  ),

  closed_at timestamptz,
  close_reason text,
  constraint invoices_close_consistency check (
    (status = 'closed') = (closed_at is not null)
    and (closed_at is not null) = (close_reason is not null)
    and (close_reason is null or btrim(close_reason) <> '')
  ),

  -- Faz 2 staging lineage, the same three columns checks/loans/bank_transactions carry.
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),

  -- Duplicate-detection fingerprint (party + number + amount + date). NOT unique — see the
  -- index note below.
  dedupe_hash text,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- NOT a unique index, and the contrast with Faz 20 is deliberate.
--
-- bank_transactions.dedupe_hash IS uniquely indexed, because re-importing an overlapping
-- statement window is a mechanical, expected act and the right answer is "collapse onto the
-- existing row". An invoice duplicate is a different animal: it is a human or supplier error,
-- the two rows may differ in ways that matter, and refusing the second one would force the
-- operator to either falsify a number or abandon the import. So duplicates here are DETECTED
-- and reported (0047's invoice_duplicate_suspects view), never silently merged or blocked.
create index if not exists invoices_dedupe_idx on public.invoices (dedupe_hash) where dedupe_hash is not null;
create index if not exists invoices_party_idx on public.invoices (party_id, issue_date desc);
create index if not exists invoices_status_idx on public.invoices (status) where status in ('open', 'partial');
create index if not exists invoices_due_idx on public.invoices (due_date) where due_date is not null;
create index if not exists invoices_no_idx on public.invoices (party_id, invoice_no);

drop trigger if exists invoices_updated_at on public.invoices;
create trigger invoices_updated_at before update on public.invoices
  for each row execute function public.set_updated_at();

-- ── status transition guard, in the SAME migration as the column ───────────────────────────
create or replace function public.invoices_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('draft',   'open'),      ('draft',   'cancelled'),
    ('open',    'partial'),   ('open',    'paid'),
    ('open',    'closed'),    ('open',    'cancelled'),
    ('partial', 'paid'),      ('partial', 'open'),
    ('partial', 'closed'),    ('partial', 'cancelled'),
    ('paid',    'partial'),   ('paid',    'open'),
    ('paid',    'closed'),
    ('closed',  'open')
  ) then
    raise exception 'invoices.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;

drop trigger if exists invoices_status_transition_guard on public.invoices;
create trigger invoices_status_transition_guard before update on public.invoices
  for each row execute function public.invoices_status_transition_guard();

-- ── content immutability once issued (0024's pattern) ──────────────────────────────────────
--
-- `draft` is the ONLY editable state. Once an invoice has been issued, its commercial content
-- — who it is for, its number, its dates, its amounts — is frozen. This is not caution, it is
-- what an invoice IS: a document already in a counterparty's hands. Corrections happen by
-- cancelling and reissuing, or by a credit note (0046), both of which leave a trail.
--
-- Deliberately NOT frozen: `status`, `paid_amount`, the cancellation/close metadata, `notes`,
-- and `updated_at`. Settlement must keep working on an issued invoice — freezing it would
-- recreate exactly the 0027 failure in a different disguise, where the row becomes unusable
-- because a guard was drawn too wide.
create or replace function public.invoices_content_immutability_guard() returns trigger
language plpgsql as $$
begin
  if old.status = 'draft' then
    return new;
  end if;
  if new.direction    is distinct from old.direction
     or new.invoice_no   is distinct from old.invoice_no
     or new.party_id     is distinct from old.party_id
     or new.issue_date   is distinct from old.issue_date
     or new.due_date     is distinct from old.due_date
     or new.currency     is distinct from old.currency
     or new.net_amount   is distinct from old.net_amount
     or new.tax_amount   is distinct from old.tax_amount
     or new.gross_amount is distinct from old.gross_amount then
    raise exception
      'invoices.%: düzenlenmiş fatura içeriği değiştirilemez (durum=%). Düzeltme iptal+yeniden düzenleme ya da iade faturasıyla yapılır.',
      old.id, old.status;
  end if;
  return new;
end $$;

drop trigger if exists invoices_content_immutability_guard on public.invoices;
create trigger invoices_content_immutability_guard before update on public.invoices
  for each row execute function public.invoices_content_immutability_guard();

alter table public.invoices enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='invoices' and policyname='invoices_authenticated_all'
  ) then
    create policy invoices_authenticated_all on public.invoices
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.invoices to authenticated;
