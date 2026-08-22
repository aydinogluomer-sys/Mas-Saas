-- Faz 21 — invoice read models.
--
-- Views, not stored aggregates or scored columns — the same reasoning as 0039 and 0043: a
-- second copy of a derivable number is a second thing that can go stale, and this schema has
-- already been bitten by that (pre-0034 the loans paid_count KPI read 0 for every loan since
-- Phase 5). Everything here is recomputed at read time.
--
-- All arithmetic stays in numeric; the application decodes through src/lib/money.ts.

-- ── 1) open receivables/payables with ageing ───────────────────────────────────────────────
--
-- `remaining` is gross − paid. It can go NEGATIVE when a counterparty overpays, and that is
-- reported rather than clamped to zero: 0044 deliberately puts no upper bound on paid_amount
-- because overpayment genuinely happens, and hiding it here would undo that decision.
create or replace view public.invoice_open_items as
  select
    i.id,
    i.direction,
    i.invoice_no,
    i.party_id,
    pa.name                                   as party_name,
    i.issue_date,
    i.due_date,
    i.currency,
    i.gross_amount,
    i.paid_amount,
    (i.gross_amount - i.paid_amount)          as remaining,
    i.status,
    case
      when i.due_date is null then null
      else (current_date - i.due_date)
    end                                       as days_overdue,
    case
      when i.due_date is null then 'tarihsiz'
      when i.due_date >= current_date then 'vadesi gelmemiş'
      when current_date - i.due_date <= 30 then '1-30 gün'
      when current_date - i.due_date <= 60 then '31-60 gün'
      when current_date - i.due_date <= 90 then '61-90 gün'
      else '90+ gün'
    end                                       as ageing_bucket,
    i.cost_center_id,
    i.project_id
  from public.invoices i
  join public.parties pa on pa.id = i.party_id
  where i.status in ('open', 'partial');

-- ── 2) duplicate suspects ──────────────────────────────────────────────────────────────────
--
-- The heuristic implementation.md asks for: counterparty + number + amount + date. Reported,
-- never blocked — see 0044's note on why invoices differ from bank_transactions here.
--
-- Two independent signals, kept separate so the reason is visible rather than collapsed into
-- one score:
--   same_number  — same party and same invoice number. Nearly always a true duplicate.
--   near_match   — same party, same gross amount, issue dates within 7 days, DIFFERENT number.
--                  This is the one that catches a supplier re-sending under a new number.
--
-- Cancelled invoices are excluded: voiding one of a pair is precisely how a duplicate gets
-- resolved, and continuing to report it afterwards would train the operator to ignore the view.
create or replace view public.invoice_duplicate_suspects as
  select
    a.id                      as invoice_id,
    b.id                      as other_invoice_id,
    a.party_id,
    pa.name                   as party_name,
    a.invoice_no,
    b.invoice_no              as other_invoice_no,
    a.gross_amount,
    a.issue_date,
    b.issue_date              as other_issue_date,
    case
      when a.invoice_no = b.invoice_no then 'same_number'
      else 'near_match'
    end                       as signal,
    abs(a.issue_date - b.issue_date) as date_gap_days
  from public.invoices a
  join public.invoices b
    on b.party_id = a.party_id
   and b.direction = a.direction
   and b.id <> a.id
   -- Emit each pair once (a < b) instead of twice mirrored.
   and a.id < b.id
  join public.parties pa on pa.id = a.party_id
  where a.status <> 'cancelled'
    and b.status <> 'cancelled'
    and (
      a.invoice_no = b.invoice_no
      or (a.gross_amount = b.gross_amount and abs(a.issue_date - b.issue_date) <= 7)
    );

-- ── 3) header vs. lines reconciliation ─────────────────────────────────────────────────────
--
-- Reported, not enforced. A trigger could refuse a header whose lines do not add up, but lines
-- are necessarily written AFTER their header, so such a trigger would either have to be
-- deferred (and then fail an entire import transaction for one bad row) or block the normal
-- insert order outright. The repo's established answer for this class of problem is the
-- cashflow identity check: compute it, surface it, let a human decide. Invoices with no lines
-- at all are excluded — a header-only invoice is a legitimate way to record a one-line bill.
create or replace view public.invoice_line_mismatches as
  select
    i.id                                        as invoice_id,
    i.invoice_no,
    i.party_id,
    i.gross_amount                              as header_gross,
    l.line_gross                                as lines_gross,
    (i.gross_amount - l.line_gross)             as difference,
    l.line_count
  from public.invoices i
  join (
    select invoice_id, sum(gross_amount) as line_gross, count(*) as line_count
    from public.invoice_lines group by invoice_id
  ) l on l.invoice_id = i.id
  where i.gross_amount <> l.line_gross;

-- ── 4) overpaid invoices ───────────────────────────────────────────────────────────────────
create or replace view public.invoice_overpaid as
  select
    i.id, i.invoice_no, i.party_id, pa.name as party_name,
    i.gross_amount, i.paid_amount,
    (i.paid_amount - i.gross_amount) as overpaid_by, i.status
  from public.invoices i
  join public.parties pa on pa.id = i.party_id
  where i.paid_amount > i.gross_amount;

-- ── 5) per-counterparty invoice position ───────────────────────────────────────────────────
create or replace view public.invoice_party_summary as
  select
    pa.id                                                                    as party_id,
    pa.name                                                                  as party_name,
    count(i.id) filter (where i.direction = 'sales')                         as sales_count,
    count(i.id) filter (where i.direction = 'purchase')                      as purchase_count,
    coalesce(sum(i.gross_amount) filter (where i.direction = 'sales' and i.status in ('open','partial')), 0)    as receivable_open,
    coalesce(sum(i.paid_amount)  filter (where i.direction = 'sales' and i.status in ('open','partial')), 0)    as receivable_paid,
    coalesce(sum(i.gross_amount) filter (where i.direction = 'purchase' and i.status in ('open','partial')), 0) as payable_open,
    coalesce(sum(i.paid_amount)  filter (where i.direction = 'purchase' and i.status in ('open','partial')), 0) as payable_paid,
    count(i.id) filter (where i.status = 'cancelled')                        as cancelled_count,
    min(i.due_date) filter (where i.status in ('open','partial'))            as earliest_due_date
  from public.parties pa
  left join public.invoices i on i.party_id = pa.id
  group by pa.id, pa.name;

grant select on public.invoice_open_items to authenticated;
grant select on public.invoice_duplicate_suspects to authenticated;
grant select on public.invoice_line_mismatches to authenticated;
grant select on public.invoice_overpaid to authenticated;
grant select on public.invoice_party_summary to authenticated;
