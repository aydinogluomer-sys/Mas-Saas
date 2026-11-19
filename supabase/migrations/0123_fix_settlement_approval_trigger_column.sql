-- =============================================================================
-- Migration 0123: Fix approval_rules column reference in enforce_outflow_settlement_approval_gate()
--
-- Aligns PL/pgSQL trigger lookup with `public.approval_rules(trigger_kind, applies_to)`
-- from migration 0054 so < threshold settlements succeed while >= threshold unapproved
-- outflow settlements raise SQLSTATE 42501 (`APPROVAL_REQUIRED`).
-- =============================================================================

create or replace function public.enforce_outflow_settlement_approval_gate()
returns trigger
language plpgsql
as $$
declare
  v_threshold numeric;
  v_effective_amount numeric;
  v_has_approved boolean;
begin
  if new.status not in ('paid', 'partial') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status in ('paid', 'partial')
     and coalesce(new.paid_amount, 0) <= coalesce(old.paid_amount, 0) then
    return new;
  end if;
  if coalesce(new.direction, 'outflow') <> 'outflow' then
    return new;
  end if;

  select r.threshold_amount
    into v_threshold
    from public.approval_rules r
   where r.is_active = true
     and r.trigger_kind = 'amount_threshold'
     and r.threshold_amount is not null
     and (cardinality(r.applies_to) = 0 or 'payment_instances' = any(r.applies_to))
   order by r.threshold_amount asc
   limit 1;

  if v_threshold is null then
    return new;
  end if;

  v_effective_amount := greatest(coalesce(new.amount, 0), coalesce(new.paid_amount, 0));

  if new.currency = 'TRY' and v_effective_amount >= v_threshold then
    select exists (
      select 1
        from public.approvals a
       where a.subject_table = 'payment_instances'
         and a.subject_id = new.id
         and a.status = 'approved'
    ) into v_has_approved;

    if coalesce(new.approval_status, 'not_required') <> 'approved' or not coalesce(v_has_approved, false) then
      raise exception using
        errcode = '42501',
        message = format(
          'APPROVAL_REQUIRED: %s TRY tutarındaki ödeme eşik üstüdür (>= %s TRY); onay tamamlanmadan ödenmiş işaretlenemez.',
          v_effective_amount,
          v_threshold
        );
    end if;
  end if;

  return new;
end;
$$;
