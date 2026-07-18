-- audit_logs is append-only: no UPDATE, DELETE, or TRUNCATE, ever (CLAUDE.md audit-trail rule).
-- REVOKE is defense-in-depth only (this app connects as a superuser locally, which bypasses
-- GRANT/REVOKE); the triggers below are what actually enforces this, superuser included.
-- Idempotent throughout (matches 0020/0021's convention) — this migration must be safe to
-- re-run against a DB that already has its effects, per LEDGER_EMPTY_RECOVERY.

revoke update, delete, truncate on public.audit_logs from public;

do $$
declare r record;
begin
  for r in
    select distinct grantee
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'audit_logs'
      and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
      and grantee <> current_user
  loop
    execute format('revoke update, delete, truncate on public.audit_logs from %I', r.grantee);
  end loop;
end $$;

create or replace function public.audit_logs_block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only: % is not permitted', TG_OP;
end $$;

drop trigger if exists audit_logs_block_update_delete on public.audit_logs;
create trigger audit_logs_block_update_delete before update or delete on public.audit_logs
  for each row execute function public.audit_logs_block_mutation();

drop trigger if exists audit_logs_block_truncate on public.audit_logs;
create trigger audit_logs_block_truncate before truncate on public.audit_logs
  for each statement execute function public.audit_logs_block_mutation();
