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

-- ── 2b) drain the deferred guard BEFORE the next ALTER TABLE ───────────────────────────
--
-- MEASURED, NOT ANTICIPATED. Without this line the migration above is a live grenade, and
-- the reason is invisible from reading 0056 alone.
--
-- 0031 put a DEFERRABLE INITIALLY DEFERRED constraint trigger on this table
-- (`users_require_active_admin`, AFTER UPDATE OF role, is_active OR DELETE, FOR EACH ROW).
-- The UPDATE above matches that trigger's event, so every rewritten row queues a pending
-- trigger event that, being INITIALLY DEFERRED, is not checked until COMMIT. PostgreSQL
-- refuses to run ALTER TABLE on a relation that has such a queue:
--
--   ERROR:  cannot ALTER TABLE "users" because it has pending trigger events
--
-- and migrate.ts runs each migration inside one transaction, so step 3 below hits exactly
-- that error and the whole migration rolls back. Reproduced against a disposable database
-- migrated to 0055 and seeded with the two role='operator' rows the real database holds
-- today; with ZERO operator rows the UPDATE matches nothing, queues nothing, and 0056
-- passes — which is precisely why every gate so far ran green. The failure is data-
-- dependent, and the data that triggers it is the production data.
--
-- SET CONSTRAINTS ... IMMEDIATE checks the queued events NOW instead of at COMMIT. They
-- pass (the UPDATE moved operator→finance_manager and left every admin untouched, so "at
-- least one active admin" still holds), the queue empties, and ALTER TABLE is free.
--
-- WHY THE CONSTRAINT IS NAMED RATHER THAN `SET CONSTRAINTS ALL IMMEDIATE`:
-- two deferrable constraints exist at this point in the schema — this one and
-- `invoices_require_reversal_record` (0044). `ALL` would arm the invoice guard as well and
-- give 0056 a way to fail for a reason that has nothing to do with roles. Naming the
-- constraint fires only the invariant this UPDATE could actually have disturbed.
-- The named form errors if no such constraint exists; that cannot happen here, because
-- 0031 creates it unconditionally and no migration between 0031 and 0056 drops, renames or
-- replaces it (verified by grep across the whole migration set).
--
-- THIS DOES NOT WEAKEN THE GUARD, IT ONLY MOVES WHEN IT FIRES. If the invariant is
-- genuinely violated — no active admin left — the exception is raised HERE and the
-- migration refuses to complete, exactly as it would have at COMMIT.
set constraints users_require_active_admin immediate;

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
