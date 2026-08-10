-- P0-A: re-point every existing "who did this" FK from the disposable auth.users stub
-- (scripts/db/local-bootstrap.sql — "never ships to a real Supabase-like backend, never
-- has rows inserted", a single id-only column that exists purely so these FKs type-check
-- locally) to the real public.users table added in 0031.
--
-- auth.users itself is left untouched — repointing the FK, not repurposing the stub,
-- means nothing about scripts/db/migrate.ts's checkAuthPrereqs() or local-bootstrap.sql
-- needs to change.
--
-- Same fail-closed pattern as 0029/0030: before dropping/re-adding each constraint,
-- verify (a) the constraint that actually exists is the one expected (right table, right
-- column, really targets auth.users) and (b) the column carries zero non-null rows in the
-- live database — every one of these 8 columns is, in every real and historical dataset,
-- unconditionally null (no code path anywhere ever writes them; confirmed by repo-wide
-- grep). If either check fails, stop with RAISE EXCEPTION rather than silently repoint
-- data that might not actually be safe.
--
-- Idempotent (per LEDGER_EMPTY_RECOVERY): each block first checks whether the constraint
-- already targets public.users (a prior run already repointed it) and, if so, does
-- nothing — only a constraint still targeting auth.users gets verified-then-repointed.

do $$
declare
  v_target regclass;
  v_orphans bigint;
begin
  select confrelid into v_target from pg_constraint
    where conname = 'source_workbooks_imported_by_fkey' and conrelid = 'public.source_workbooks'::regclass and contype = 'f';
  if v_target = 'public.users'::regclass then
    return;
  elsif v_target is distinct from 'auth.users'::regclass then
    raise exception 'GÜVENLİK DURDURMASI: source_workbooks_imported_by_fkey beklenmedik bir hedefe işaret ediyor (bulunan: %)', v_target;
  end if;
  select count(*) into v_orphans from public.source_workbooks where imported_by is not null;
  if v_orphans <> 0 then
    raise exception 'GÜVENLİK DURDURMASI: source_workbooks.imported_by''de % NULL-olmayan satır var — repoint güvenli değil, durduruluyor', v_orphans;
  end if;
  alter table public.source_workbooks drop constraint source_workbooks_imported_by_fkey;
  alter table public.source_workbooks add constraint source_workbooks_imported_by_fkey
    foreign key (imported_by) references public.users(id);
end $$;

do $$
declare
  v_target regclass;
  v_orphans bigint;
begin
  select confrelid into v_target from pg_constraint
    where conname = 'mapping_reviews_reviewed_by_fkey' and conrelid = 'public.mapping_reviews'::regclass and contype = 'f';
  if v_target = 'public.users'::regclass then
    return;
  elsif v_target is distinct from 'auth.users'::regclass then
    raise exception 'GÜVENLİK DURDURMASI: mapping_reviews_reviewed_by_fkey beklenmedik bir hedefe işaret ediyor (bulunan: %)', v_target;
  end if;
  select count(*) into v_orphans from public.mapping_reviews where reviewed_by is not null;
  if v_orphans <> 0 then
    raise exception 'GÜVENLİK DURDURMASI: mapping_reviews.reviewed_by''de % NULL-olmayan satır var — repoint güvenli değil, durduruluyor', v_orphans;
  end if;
  alter table public.mapping_reviews drop constraint mapping_reviews_reviewed_by_fkey;
  alter table public.mapping_reviews add constraint mapping_reviews_reviewed_by_fkey
    foreign key (reviewed_by) references public.users(id);
end $$;

do $$
declare
  v_target regclass;
begin
  select confrelid into v_target from pg_constraint
    where conname = 'audit_logs_actor_fkey' and conrelid = 'public.audit_logs'::regclass and contype = 'f';
  if v_target = 'public.users'::regclass then
    return;
  elsif v_target is distinct from 'auth.users'::regclass then
    raise exception 'GÜVENLİK DURDURMASI: audit_logs_actor_fkey beklenmedik bir hedefe işaret ediyor (bulunan: %)', v_target;
  end if;
  -- actor stays nullable here — every pre-P0-A row keeps actor=null forever (audit_logs
  -- is append-only per 0022, history is never rewritten); only new writes populate it.
  alter table public.audit_logs drop constraint audit_logs_actor_fkey;
  alter table public.audit_logs add constraint audit_logs_actor_fkey
    foreign key (actor) references public.users(id);
end $$;

do $$
declare
  v_target regclass;
  v_orphans bigint;
begin
  select confrelid into v_target from pg_constraint
    where conname = 'check_events_created_by_fkey' and conrelid = 'public.check_events'::regclass and contype = 'f';
  if v_target = 'public.users'::regclass then
    return;
  elsif v_target is distinct from 'auth.users'::regclass then
    raise exception 'GÜVENLİK DURDURMASI: check_events_created_by_fkey beklenmedik bir hedefe işaret ediyor (bulunan: %)', v_target;
  end if;
  select count(*) into v_orphans from public.check_events where created_by is not null;
  if v_orphans <> 0 then
    raise exception 'GÜVENLİK DURDURMASI: check_events.created_by''de % NULL-olmayan satır var — repoint güvenli değil, durduruluyor', v_orphans;
  end if;
  alter table public.check_events drop constraint check_events_created_by_fkey;
  alter table public.check_events add constraint check_events_created_by_fkey
    foreign key (created_by) references public.users(id);
end $$;

do $$
declare
  v_target regclass;
  v_orphans bigint;
begin
  select confrelid into v_target from pg_constraint
    where conname = 'scenarios_created_by_fkey' and conrelid = 'public.scenarios'::regclass and contype = 'f';
  if v_target = 'public.users'::regclass then
    return;
  elsif v_target is distinct from 'auth.users'::regclass then
    raise exception 'GÜVENLİK DURDURMASI: scenarios_created_by_fkey beklenmedik bir hedefe işaret ediyor (bulunan: %)', v_target;
  end if;
  select count(*) into v_orphans from public.scenarios where created_by is not null;
  if v_orphans <> 0 then
    raise exception 'GÜVENLİK DURDURMASI: scenarios.created_by''de % NULL-olmayan satır var — repoint güvenli değil, durduruluyor', v_orphans;
  end if;
  alter table public.scenarios drop constraint scenarios_created_by_fkey;
  alter table public.scenarios add constraint scenarios_created_by_fkey
    foreign key (created_by) references public.users(id);
end $$;

do $$
declare
  v_target regclass;
  v_orphans bigint;
begin
  select confrelid into v_target from pg_constraint
    where conname = 'action_items_created_by_fkey' and conrelid = 'public.action_items'::regclass and contype = 'f';
  if v_target = 'public.users'::regclass then
    return;
  elsif v_target is distinct from 'auth.users'::regclass then
    raise exception 'GÜVENLİK DURDURMASI: action_items_created_by_fkey beklenmedik bir hedefe işaret ediyor (bulunan: %)', v_target;
  end if;
  select count(*) into v_orphans from public.action_items where created_by is not null;
  if v_orphans <> 0 then
    raise exception 'GÜVENLİK DURDURMASI: action_items.created_by''de % NULL-olmayan satır var — repoint güvenli değil, durduruluyor', v_orphans;
  end if;
  alter table public.action_items drop constraint action_items_created_by_fkey;
  alter table public.action_items add constraint action_items_created_by_fkey
    foreign key (created_by) references public.users(id);
end $$;

do $$
declare
  v_target regclass;
  v_orphans bigint;
begin
  select confrelid into v_target from pg_constraint
    where conname = 'external_assumptions_reviewed_by_fkey' and conrelid = 'public.external_assumptions'::regclass and contype = 'f';
  if v_target = 'public.users'::regclass then
    return;
  elsif v_target is distinct from 'auth.users'::regclass then
    raise exception 'GÜVENLİK DURDURMASI: external_assumptions_reviewed_by_fkey beklenmedik bir hedefe işaret ediyor (bulunan: %)', v_target;
  end if;
  select count(*) into v_orphans from public.external_assumptions where reviewed_by is not null;
  if v_orphans <> 0 then
    raise exception 'GÜVENLİK DURDURMASI: external_assumptions.reviewed_by''de % NULL-olmayan satır var — repoint güvenli değil, durduruluyor', v_orphans;
  end if;
  alter table public.external_assumptions drop constraint external_assumptions_reviewed_by_fkey;
  alter table public.external_assumptions add constraint external_assumptions_reviewed_by_fkey
    foreign key (reviewed_by) references public.users(id);
end $$;

do $$
declare
  v_target regclass;
  v_orphans bigint;
begin
  select confrelid into v_target from pg_constraint
    where conname = 'external_assumptions_created_by_fkey' and conrelid = 'public.external_assumptions'::regclass and contype = 'f';
  if v_target = 'public.users'::regclass then
    return;
  elsif v_target is distinct from 'auth.users'::regclass then
    raise exception 'GÜVENLİK DURDURMASI: external_assumptions_created_by_fkey beklenmedik bir hedefe işaret ediyor (bulunan: %)', v_target;
  end if;
  select count(*) into v_orphans from public.external_assumptions where created_by is not null;
  if v_orphans <> 0 then
    raise exception 'GÜVENLİK DURDURMASI: external_assumptions.created_by''de % NULL-olmayan satır var — repoint güvenli değil, durduruluyor', v_orphans;
  end if;
  alter table public.external_assumptions drop constraint external_assumptions_created_by_fkey;
  alter table public.external_assumptions add constraint external_assumptions_created_by_fkey
    foreign key (created_by) references public.users(id);
end $$;
