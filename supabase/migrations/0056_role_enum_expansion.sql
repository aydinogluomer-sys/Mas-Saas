-- Faz 24B — the five-tier role enum.
--
-- users.role has been `admin | operator` since 0031. This widens it to the five tiers the
-- plan calls for and carries the existing accounts across WITHOUT capability loss.
--
-- THE MAPPING, and why it is this and not something tidier:
--
--   admin    -> admin             Unchanged. Same name, same meaning.
--   operator -> finance_manager   NOT finance_operator, which is the mapping the name
--                                 similarity suggests.
--
-- The reasoning matters more than the result. Today `operator` is "everything except the
-- admin-only pages": entering payments, resolving reviews, running scenarios, deciding the
-- reviews that Faz 24A turned into approvals. `finance_operator` in the new matrix explicitly
-- CANNOT approve. Mapping operator -> finance_operator would therefore silently REVOKE a
-- capability every existing account uses daily, and the first symptom would be an operator
-- unable to clear their own approval queue — a privilege regression delivered by a migration
-- nobody asked to change their permissions. A migration may add restrictions the operator
-- chooses; it may not quietly take away what an account already had.
--
-- `finance_manager` is the tier that preserves today's behaviour exactly (data entry AND
-- approval, but not user administration). Anyone who should be narrower can be demoted
-- deliberately from the security screen — a decision made by a human, visible in the audit
-- log, which is precisely where that decision belongs.
--
-- The NEW-user default drops to `viewer` (was `operator`). A freshly created account should
-- start with the least privilege that is still useful; whoever creates it picks the real tier
-- in the same form. This changes no existing row.

-- ── 1) widen the allowed set BEFORE rewriting any value ────────────────────────────────
-- Order is load-bearing: the update below writes 'finance_manager', which the old CHECK
-- would reject. Drop first, update, then re-add the narrowed-to-five constraint.
alter table public.users drop constraint if exists users_role_check;

-- ── 2) carry the existing accounts across ──────────────────────────────────────────────
update public.users set role = 'finance_manager' where role = 'operator';

-- ── 3) the new constraint ──────────────────────────────────────────────────────────────
alter table public.users
  add constraint users_role_check check (role in (
    'viewer',
    'finance_operator',
    'finance_approver',
    'finance_manager',
    'admin'
  ));

alter table public.users alter column role set default 'viewer';

comment on column public.users.role is
  'Faz 24B five-tier role. viewer=read-only; finance_operator=data entry, cannot approve; '
  'finance_approver=decides approvals, minimal data entry; finance_manager=both; admin=also '
  'user/config administration. Pre-24B ''operator'' accounts became finance_manager so that no '
  'account lost a capability it already had.';

-- ── 4) prove the migration left nothing behind ─────────────────────────────────────────
-- A stray legacy value would fail the CHECK above, but only for rows that exist right now.
-- This is the assertion that the mapping was total: if any row still holds a pre-24B value
-- the migration refuses to complete rather than leaving an account in an undefined tier.
do $$
declare
  v_stale int;
begin
  select count(*) into v_stale from public.users where role in ('operator');
  if v_stale > 0 then
    raise exception 'Faz 24B: % kullanıcı hâlâ eski ''operator'' rolünde — eşleme eksik', v_stale;
  end if;
end $$;
