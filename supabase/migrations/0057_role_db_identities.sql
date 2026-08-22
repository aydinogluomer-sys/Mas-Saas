-- Faz 24B — one PostgreSQL role per application tier, and the session context policies read.
--
-- WHY REAL DATABASE ROLES AND NOT A SESSION VARIABLE
--
-- The application connects as a single login role (`mas_radar_app`, Faz 15), so on its own the
-- database cannot tell a viewer's request from an admin's. The two ways to close that are a
-- session GUC that policies consult, or genuine roles the connection switches into. This picks
-- roles, because `to <role>` is the mechanism PostgreSQL's policy matcher is actually built
-- around: the check happens in the planner, on every statement, with no expression for a
-- future policy author to forget to add.
--
-- THE INHERITANCE TRAP, AND THE PG16 FEATURE THAT AVOIDS IT
--
-- Policies match by role MEMBERSHIP, not by the connected identity — docs/database-schema.md
-- records this about `authenticated`, and it cuts the other way here. A plain
-- `grant mas_radar_viewer to mas_radar_app` would make the app a member of all five tiers at
-- once, so it would satisfy the UNION of every tier's policies — an admin, permanently. That
-- is the exact opposite of the phase.
--
-- PostgreSQL 16 separates the two halves of membership, so the grants below say
-- `with inherit false, set true`: the app may SET ROLE into a tier, but inherits nothing from
-- it. Measured on this cluster before the design was committed to: connected as the app with
-- no SET ROLE, a table carrying only tier policies returns ZERO rows; after `set role`, the
-- tier's policies apply exactly; after `reset role`, it returns to zero. That last property is
-- what makes the pattern safe on a pooled connection — a leaked role cannot outlive the
-- checkout, because the reset lands the connection back on an identity that can read nothing.
--
-- The consequence, stated plainly because it IS the regression risk of this phase: after the
-- policy migration, an unswitched `mas_radar_app` can no longer read business tables. That is
-- deliberate. The only paths that legitimately run unswitched are the login/session lookups,
-- and those keep the `mas_radar_app`-targeted policies Faz 15 added to users/sessions.

-- ── 1) the five tier roles ─────────────────────────────────────────────────────────────
-- NOLOGIN: nobody connects AS a tier. They exist to be switched into and to be named by
-- policies. A tier that could log in would be a second credential to leak for no benefit.
do $$
declare
  v_role text;
begin
  foreach v_role in array array[
    'mas_radar_viewer',
    'mas_radar_finance_operator',
    'mas_radar_finance_approver',
    'mas_radar_finance_manager',
    'mas_radar_admin'
  ] loop
    if not exists (select 1 from pg_roles where rolname = v_role) then
      execute format('create role %I nologin nosuperuser nobypassrls', v_role);
    end if;
    -- Membership in `authenticated` carries the table-level GRANTs from 0035 (and its default
    -- privileges for tables added later). GRANTs decide whether the command may be attempted
    -- at all; the policies in 0058 decide which rows it may touch. Both layers are needed:
    -- RLS without a GRANT is unreachable, a GRANT without RLS is unrestricted.
    execute format('grant authenticated to %I', v_role);
    -- INHERIT FALSE / SET TRUE — see the header. The app may become the tier; it never IS one.
    execute format('grant %I to mas_radar_app with inherit false, set true', v_role);
  end loop;
end $$;

-- ── 2) session context the policies read ───────────────────────────────────────────────
-- SET ROLE says which TIER is acting. It cannot say WHICH PERSON, and the row-level rules need
-- that: "an approver may not decide their own request" is a statement about a user id, not a
-- tier. The application sets this alongside the role on the same connection checkout.
--
-- `current_setting(..., true)` returns NULL rather than raising when the setting is absent, so
-- an unswitched connection (a script, the login path) simply has no app user — which the
-- policies below treat as "matches nothing", never as "matches everything".
create or replace function public.current_app_user()
returns uuid
language sql
stable
-- No SECURITY DEFINER: this reads only the caller's own session state and must not carry any
-- privilege of its own.
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

comment on function public.current_app_user() is
  'Faz 24B: the application user id for the current connection, set by the runtime alongside '
  'SET ROLE. NULL when unset (scripts, the login path) — row-level policies must treat NULL as '
  'no match, never as a wildcard.';

-- A readable name for the tier currently acting. Policies do not need it (they use `to role`),
-- but the gate and the audit surface do, and deriving it in one place stops five spellings of
-- the same string appearing across the codebase.
create or replace function public.current_app_role()
returns text
language sql
stable
as $$
  select case current_user
    when 'mas_radar_viewer'           then 'viewer'
    when 'mas_radar_finance_operator' then 'finance_operator'
    when 'mas_radar_finance_approver' then 'finance_approver'
    when 'mas_radar_finance_manager'  then 'finance_manager'
    when 'mas_radar_admin'            then 'admin'
    else current_user::text
  end;
$$;

comment on function public.current_app_role() is
  'Faz 24B: the application tier for the current connection, derived from the switched role. '
  'Returns the raw role name for unswitched connections (mas_radar_app, postgres) so the '
  'answer is never a misleading tier name.';

grant execute on function public.current_app_user() to authenticated;
grant execute on function public.current_app_role() to authenticated;
