-- 0096 — Wave 0: the forced password change (0095) can audit itself for every tier.
--
-- WHAT WAS BROKEN. 0095 added users.must_change_password, and the application now forces a
-- change after an admin creates an account, resets a password or demands one. The way out is the
-- user's own change at /change-password, and that change must leave an audit row — an
-- unaudited credential change is not something this schema allows anywhere else. The row is
-- written through the one audit writer, in the user's own tier, so it is judged by the same RLS
-- as the person's other requests (src/lib/auth.ts changeOwnPassword).
--
-- Four tiers can already record evidence: 0058 gives operator, approver, manager and admin
-- `audit_logs_insert_record` (with check (true)). The viewer tier has NO insert policy on any
-- table — 0058's "a viewer cannot write to ANY table" — so a viewer's password change could not
-- be audited, and therefore could not happen at all.
--
-- WHAT THIS ADDS, AND HOW NARROW IT IS. One INSERT policy, for the viewer tier only, admitting
-- exactly one kind of row:
--
--   action       = 'change_own_password'
--   entity_table = 'users'
--   actor        = current_app_user()      the person, as published by the runtime (0057)
--   entity_id    = current_app_user()      their OWN account, never another one
--
-- current_app_user() is NULL on a connection that carries no user id (scripts, the login path,
-- the read-only Telegram identity), and `=` against NULL is NULL, so an unset context matches no
-- row — the same reasoning 0058 wrote down for its owner-scoped policies. The generic probe
-- `insert into audit_logs default values` (db:roles-rls:verify, section B) is still refused for
-- viewer: its action is NULL. No UPDATE or DELETE path is added for anyone; audit_logs stays
-- append-only (0022 triggers + 0058 evidence class).
--
-- WHY A POLICY AND NOT A SECURITY DEFINER FUNCTION. A definer function doing update + audit would
-- also work, but nothing in this schema uses one, it would run with its owner's rights (and a
-- search_path to pin), and the trail would be written by the owner rather than by the tier whose
-- request it records. The policy keeps the existing model — runtime role for the users/sessions
-- rows (0035), the person's tier for the evidence — and adds the smallest permission that model
-- was missing.
--
-- Idempotent: dropped and re-created by name; the assertions below re-run harmlessly.

drop policy if exists audit_logs_insert_own_password_change on public.audit_logs;
create policy audit_logs_insert_own_password_change on public.audit_logs
  for insert to mas_radar_viewer
  with check (
    action = 'change_own_password'
    and entity_table = 'users'
    and actor = public.current_app_user()
    and entity_id = public.current_app_user()
  );

comment on policy audit_logs_insert_own_password_change on public.audit_logs is
  'Wave 0 / 0096: the only viewer write in the schema — the audit row of the viewer''s OWN '
  'password change (actor = entity_id = current_app_user()). Unset app.user_id matches nothing.';

-- Every tier can now record its own password change, and the viewer exception is exactly the
-- one policy above. Checked here so a later migration that drops a tier from the evidence policy,
-- or widens the viewer's reach on this table, fails loudly instead of locking a tier out of
-- /change-password or quietly giving viewers a general audit write.
do $$
declare
  v_tier text;
  v_viewer_policies text;
begin
  foreach v_tier in array array[
    'mas_radar_viewer',
    'mas_radar_finance_operator',
    'mas_radar_finance_approver',
    'mas_radar_finance_manager',
    'mas_radar_admin'
  ] loop
    if not exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = 'audit_logs'
         and cmd in ('INSERT', 'ALL') and v_tier = any (roles::text[])
    ) then
      raise exception '0096: % katmanının audit_logs INSERT yolu yok', v_tier;
    end if;
  end loop;

  select string_agg(policyname, ', ' order by policyname) into v_viewer_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'audit_logs'
     and cmd <> 'SELECT' and 'mas_radar_viewer' = any (roles::text[]);
  if v_viewer_policies is distinct from 'audit_logs_insert_own_password_change' then
    raise exception '0096: viewer katmanının audit_logs üzerindeki yazma politikaları beklenmedik: %',
      coalesce(v_viewer_policies, '(yok)');
  end if;
end $$;
