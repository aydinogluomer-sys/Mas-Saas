-- Status transition guard: three separate, table-specific functions (not one shared function)
-- so no table's allow-list can accidentally reference a status literal that isn't valid for
-- it. Each guards ONLY the status column — unlike Slice 2's archived-immutability trigger,
-- this does not lock the rest of the row. Same-status updates (including cancelled→cancelled)
-- are always a no-op and never reach the allow-list check, for every status uniformly.
-- loans has no trigger: its status enum (active/closed/planned/unknown, 0005:64) has no
-- 'cancelled' value.

create or replace function public.payment_instances_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('unpaid', 'paid'), ('planned', 'paid'), ('late', 'paid'), ('partial', 'paid'),
    ('paid', 'unpaid'),
    ('unpaid', 'cancelled'), ('planned', 'cancelled'), ('late', 'cancelled')
  ) then
    raise exception 'payment_instances.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;

drop trigger if exists payment_instances_status_transition_guard on public.payment_instances;
create trigger payment_instances_status_transition_guard before update on public.payment_instances
  for each row execute function public.payment_instances_status_transition_guard();

create or replace function public.checks_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('planned', 'cancelled')
  ) then
    raise exception 'checks.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;

drop trigger if exists checks_status_transition_guard on public.checks;
create trigger checks_status_transition_guard before update on public.checks
  for each row execute function public.checks_status_transition_guard();

create or replace function public.loan_installments_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('planned', 'cancelled')
  ) then
    raise exception 'loan_installments.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;

drop trigger if exists loan_installments_status_transition_guard on public.loan_installments;
create trigger loan_installments_status_transition_guard before update on public.loan_installments
  for each row execute function public.loan_installments_status_transition_guard();
