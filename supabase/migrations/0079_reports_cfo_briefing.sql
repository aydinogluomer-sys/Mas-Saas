-- Faz 32 — one enum value, in a migration that does nothing else.
--
-- Faz 22 established that widening an enum CHECK gets its own explicit migration; Faz 25/29/31
-- repeated it. The CFO morning briefing is stored as a `reports` row like every other generated
-- report, so it reuses that table, its body_md column and its audit trail rather than introducing
-- a parallel "briefings" table that would need its own lifecycle, its own RLS and its own history.
alter table public.reports drop constraint if exists reports_report_type_check;
alter table public.reports
  add constraint reports_report_type_check
  check (report_type in (
    'daily', 'weekly', 'monthly', 'strategic', 'data_quality',
    -- Faz 32
    'cfo_briefing'
  ));

-- Strict superset of the previous set, so no existing row can be invalidated.
--
-- NOTE FOR LATER PHASES (the Faz 31 lesson): a gate that pins the SIZE of this set will break the
-- next time it is widened. Assert that the values you care about are PRESENT, not that the total
-- is N — phase25:verify had to be corrected for exactly that.
