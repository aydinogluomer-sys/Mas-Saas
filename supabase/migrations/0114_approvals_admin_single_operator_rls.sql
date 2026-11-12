-- 0114 — Admin tek-operatör öz-onay (self_approved_override) RLS politikası hizalaması (F-46)
-- ve Banka Eşleştirmesi Geri Alma (unmatchTransaction — F-56) durum geçiş korumaları.
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz.
--   * finance_approver ve finance_manager katmanlarında sıkı maker <> checker kuralı korunur.

-- ── 1) Admin tek-operatör öz-onay RLS politikası (F-46) ─────────────────────────────────────────
drop policy if exists approvals_decide_admin_single_operator on public.approvals;
create policy approvals_decide_admin_single_operator on public.approvals
  for update to mas_radar_admin
  using (
    requested_by is distinct from public.current_app_user()
    or exists (
      select 1
        from public.approval_governance_settings s
       where s.singleton_id = true
         and s.allow_single_operator_self_approval = true
    )
  )
  with check (
    requested_by is distinct from public.current_app_user()
    or (
      self_approved_override = true
      and exists (
        select 1
          from public.approval_governance_settings s
         where s.singleton_id = true
           and s.allow_single_operator_self_approval = true
      )
    )
  );

-- ── 2) payment_run_items & payment_runs geri alma geçişleri (F-56 unmatchTransaction) ───────────
create or replace function public.payment_run_items_status_transition_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('included', 'settled'),
    ('included', 'excluded'),
    ('excluded', 'included'),
    ('settled',  'included')
  ) then
    raise exception 'payment_run_items.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;

  return new;
end $$;

create or replace function public.payment_runs_status_transition_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('draft',            'pending_approval'),
    ('draft',            'cancelled'),
    ('pending_approval', 'approved'),
    ('pending_approval', 'draft'),
    ('pending_approval', 'cancelled'),
    ('approved',         'exported'),
    ('approved',         'settled'),
    ('approved',         'cancelled'),
    ('exported',         'settled'),
    ('exported',         'cancelled'),
    ('settled',          'exported'),
    ('settled',          'approved')
  ) then
    raise exception 'payment_runs.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;

  if new.status = 'approved'
     and old.status <> 'settled'
     and current_user not in ('mas_radar_finance_approver', 'mas_radar_finance_manager', 'mas_radar_admin', 'postgres')
  then
    raise exception 'payment_run_approval_requires_approver: ödeme paketini yalnız onaylayıcı veya yönetici onaylayabilir.'
      using errcode = '42501';
  end if;

  return new;
end $$;

-- ── 3) checks geri alma geçişleri: banka eşleştirmesiyle cleared olan çekin geri alınması (F-56) ─
create or replace function public.checks_status_transition_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('planned',            'in_portfolio'),
    ('planned',            'issued_to_vendor'),
    ('planned',            'endorsed_to_vendor'),
    ('planned',            'in_bank_collection'),
    ('planned',            'in_bank_collateral'),
    ('planned',            'cleared'),
    ('planned',            'bounced'),
    ('planned',            'returned'),
    ('planned',            'cancelled'),

    ('unknown',            'in_portfolio'),
    ('unknown',            'issued_to_vendor'),
    ('unknown',            'cancelled'),

    ('in_portfolio',       'endorsed_to_vendor'),
    ('in_portfolio',       'in_bank_collection'),
    ('in_portfolio',       'in_bank_collateral'),
    ('in_portfolio',       'cleared'),
    ('in_portfolio',       'bounced'),
    ('in_portfolio',       'returned'),
    ('in_portfolio',       'cancelled'),

    ('endorsed_to_vendor', 'cleared'),
    ('endorsed_to_vendor', 'bounced'),
    ('endorsed_to_vendor', 'returned'),
    ('endorsed_to_vendor', 'in_portfolio'),

    ('in_bank_collection', 'cleared'),
    ('in_bank_collection', 'bounced'),
    ('in_bank_collection', 'returned'),
    ('in_bank_collection', 'in_portfolio'),

    ('in_bank_collateral', 'cleared'),
    ('in_bank_collateral', 'bounced'),
    ('in_bank_collateral', 'returned'),
    ('in_bank_collateral', 'in_portfolio'),
    ('in_bank_collateral', 'in_bank_collection'),

    ('issued_to_vendor',   'cleared'),
    ('issued_to_vendor',   'bounced'),
    ('issued_to_vendor',   'returned'),
    ('issued_to_vendor',   'cancelled'),

    ('cleared',            'in_portfolio'),
    ('cleared',            'in_bank_collection'),
    ('cleared',            'issued_to_vendor'),

    ('bounced',            'cleared'),
    ('bounced',            'returned'),
    ('bounced',            'in_portfolio'),
    ('bounced',            'cancelled'),

    ('returned',           'cancelled')
  ) then
    raise exception 'checks.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;

  return new;
end $$;
