-- 0027's checks/loan_installments guards each shipped with a one-entry allow-list
-- (planned -> cancelled) and nothing else, so from the moment 0027 landed neither table
-- could ever record the outcome it exists to track: a check being honoured or returned,
-- an installment being paid. The DDL always expected those outcomes — checks.status has
-- accepted 'cleared'/'bounced' since 0005:19, loan_installments.status has accepted
-- 'paid'/'late' since 0005:81, and implementation.md:1320 defines check_events.event_type
-- with 'cleared'/'bounced' members — but no code path ever wrote them, because the engine
-- layer (src/lib/financing/engine.ts) only ever grew cancelCheck/cancelLoanInstallment.
--
-- The visible symptom is the loans KPI at src/lib/financing/engine.ts:379:
--   count(li.id) filter (where li.status='paid')::int as paid_count
-- which has therefore returned 0 for every loan since Phase 5, and 'remaining_count' has
-- returned the full installment count regardless of what was actually paid. In the real
-- mas_radar_dev today: 7/7 checks and 48/48 installments are still status='planned'.
--
-- Fix: extend the two allow-lists with exactly the settlement transitions their engine
-- counterparts (markCheckCleared/markCheckBounced/markInstallmentPaid, added alongside this
-- migration) need, and nothing more:
--   checks:            planned -> cleared, planned -> bounced
--   loan_installments: planned -> paid, planned -> late, late -> paid, late -> cancelled
-- 'late' is included for installments because it is a status the DDL already allows and an
-- overdue installment must be able to reach 'paid' (paying late is the normal case) or be
-- cancelled; checks get no 'late' equivalent because checks.status has no such value.
-- Deliberately NOT added: any transition OUT of a settled state (cleared/bounced/paid ->
-- anything). Undoing a settlement is a separate, auditable reversal flow that no engine
-- function implements today — this migration fixes the one broken direction, it does not
-- widen scope beyond it (same restraint as 0033's note on 'paid' -> 'partial').
-- Same-status updates (e.g. cleared -> cleared) need no entry: the trigger returns early
-- before the allow-list is consulted (0027, lines 12-14).
--
-- create or replace is itself idempotent; safe to re-run (LEDGER_EMPTY_RECOVERY pattern).
create or replace function public.checks_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('planned', 'cleared'), ('planned', 'bounced'),
    ('planned', 'cancelled')
  ) then
    raise exception 'checks.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;

create or replace function public.loan_installments_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('planned', 'paid'), ('late', 'paid'),
    ('planned', 'late'),
    ('planned', 'cancelled'), ('late', 'cancelled')
  ) then
    raise exception 'loan_installments.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;
