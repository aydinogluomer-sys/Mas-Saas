-- Faz 15 — separate the Next.js runtime DB role from the owner/migration role.
--
-- Until now src/lib/db.ts and scripts/db/migrate.ts shared one connection string, and the
-- only role in the cluster was `postgres` (superuser). That meant every RLS policy written
-- since 0007 was decorative: PostgreSQL lets superusers bypass row security unconditionally,
-- regardless of which role a policy targets. This migration creates the low-privilege role
-- the app actually runs as, so those policies finally take effect.
--
-- The role is created NOLOGIN on purpose. A password is never committed to git; it is set
-- once per cluster, out of band, by scripts/db/set-app-role-password.ts, which also flips
-- the role to LOGIN. Until that script runs, the role exists but cannot connect.
--
-- Cluster-scoped note: roles are shared by every database in the instance, so re-running
-- this migration against another database (mas_radar_verify, a disposable test DB) finds the
-- role already present and only re-applies the per-database GRANTs. That is why the role
-- creation is guarded and the grants are not.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mas_radar_app') then
    create role mas_radar_app
      nosuperuser nobypassrls nocreatedb nocreaterole noreplication nologin;
  end if;
end $$;

-- Membership in `authenticated` is load-bearing, not cosmetic: every policy from 0007
-- onwards is written `for all to authenticated`, and PostgreSQL matches a policy's target
-- role through role MEMBERSHIP. Without this grant the app would satisfy no policy at all
-- and would read zero rows from every RLS-enabled table.
grant authenticated to mas_radar_app;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Exception 1 — the migration ledger stays owner-only. 0020 already enabled RLS on it and
-- revoked table privileges; the blanket GRANT above would have handed them straight back,
-- so this REVOKE must come after it. scripts/db/migrate.ts connects with the owner role
-- (MIGRATION_DATABASE_URL), and no runtime code path reads this table.
revoke all on table public.schema_migrations from authenticated;

-- Exception 2 — public.users / public.sessions. 0031 locked these down with
-- `using (false)` deny-all policies, and its own comment records the assumption behind
-- them: "The app itself connects as the Postgres superuser (src/lib/db.ts) and bypasses
-- RLS like everywhere else". This migration removes exactly that assumption, so leaving
-- the deny-all as the only policy would lock the application out of its own auth tables —
-- src/lib/auth.ts reads and writes both on every login, session check and logout.
--
-- The fix keeps 0031's intent instead of discarding it. PERMISSIVE policies combine with
-- OR, so adding a policy scoped to the runtime role leaves the deny-all fully in force for
-- every OTHER member of `authenticated` (the hypothetical PostgREST-style access path 0031
-- was defending against) while letting the one role that legitimately needs these tables
-- through. No REVOKE is added here: for these two tables RLS, not table privilege, is the
-- control surface.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'users' and policyname = 'users_app_runtime') then
    create policy users_app_runtime on public.users for all to mas_radar_app using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sessions' and policyname = 'sessions_app_runtime') then
    create policy sessions_app_runtime on public.sessions for all to mas_radar_app using (true) with check (true);
  end if;
end $$;

-- Exception 3 — public.audit_logs needs no extra REVOKE. It is append-only since 0022 by
-- BEFORE triggers that raise on UPDATE/DELETE/TRUNCATE, which apply to every role including
-- this one; the INSERT the app legitimately performs is what the grant above is for.

-- Safety net only. Rule 2 of the v4 plan still stands: every new table adds its own RLS and
-- grants in its own migration. These default privileges just stop a forgotten grant from
-- silently breaking the runtime, and apply to tables created by the owner role from here on.
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;
