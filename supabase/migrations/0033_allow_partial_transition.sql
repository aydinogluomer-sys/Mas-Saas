-- 0027's payment_instances_status_transition_guard allow-list mirrors markInstancePaid's
-- PAYABLE_FROM set (unpaid/planned/late/partial -> paid) but never got the matching entries
-- for -> 'partial' — meaning markInstancePartial (src/lib/radar/engine.ts), and the
-- markPartialAction UI it backs (src/app/(dashboard)/radar/actions.ts), could never
-- successfully record a partial payment on ANY instance, from ANY status, since 0027 shipped:
-- every attempt reached this trigger and was rejected. Found via scripts/seed-demo.ts against
-- a freshly migrated database (its demo lifecycle script hit this exact rejection).
--
-- Fix: add the three entries that mirror '-> paid' exactly (unpaid/planned/late -> partial).
-- Deliberately NOT adding 'paid' -> 'partial' (undoing a full payment down to a partial one is
-- not a flow markInstancePaid/markInstancePartial support today, same as REVERSIBLE_FROM only
-- covers 'paid' -> 'unpaid', not 'partial' -> 'unpaid' — this migration does not expand scope
-- beyond the one broken transition, it only fixes it). 'partial' -> 'partial' (correcting an
-- already-recorded partial amount) needs no new entry: the trigger already treats same-status
-- updates as a no-op before the allow-list is even consulted (0027, line 12-14).
--
-- create or replace is itself idempotent; safe to re-run (LEDGER_EMPTY_RECOVERY pattern).
create or replace function public.payment_instances_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('unpaid', 'paid'), ('planned', 'paid'), ('late', 'paid'), ('partial', 'paid'),
    ('unpaid', 'partial'), ('planned', 'partial'), ('late', 'partial'),
    ('paid', 'unpaid'),
    ('unpaid', 'cancelled'), ('planned', 'cancelled'), ('late', 'cancelled')
  ) then
    raise exception 'payment_instances.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;
