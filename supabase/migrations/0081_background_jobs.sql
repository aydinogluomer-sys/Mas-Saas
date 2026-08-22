-- Faz 33 — background job queue: retry policy, dead-letter queue, progress tracking.
--
-- ═══ ONE QUEUE, MANY JOB TYPES — NOT FOUR TABLES ═══
--
-- The plan lists four things that sound like four features: an import queue for large Excel/CSV
-- files, a report-generation queue, a large-export queue, and import-progress tracking. They are
-- one mechanism. A job is "work that takes longer than a request, may fail, should be retried a
-- bounded number of times, and reports progress" — and that description does not change because
-- the payload is a bank statement instead of a PDF export.
--
-- Four tables would have meant four status vocabularies, four retry policies drifting apart, four
-- RLS classifications and four places to look when something is stuck. `job_type` is a column.
--
-- ═══ WHY A DEAD-LETTER QUEUE IS A STATUS, NOT A SECOND TABLE ═══
--
-- A dead-lettered job is the same row, with its history intact: the attempts it burned, the error
-- that killed it, the payload that caused it. Moving it to a separate table would either copy that
-- history (two sources) or lose it. `dead_letter` is terminal-until-replayed, and the guard below
-- permits exactly one way out of it — a deliberate human replay.
--
-- ═══ NULL vs ZERO, AGAIN ═══
--
-- `progress_total` is NULLABLE. A job that has not yet counted its work (an Excel file whose sheets
-- have not been opened) has an UNKNOWN total, and writing 0 would render as "0 of 0 — complete".
-- `progress_done` defaults to 0 because "no rows processed yet" is a genuine zero.

create table if not exists public.background_jobs (
  id uuid primary key default gen_random_uuid(),

  -- Deliberately a closed list. An open text column would let a typo create a job type no worker
  -- claims, and the job would sit in the queue looking healthy forever.
  job_type text not null check (job_type in (
    'excel_import',
    'bank_statement_import',
    'report_generation',
    'large_export',
    'read_model_refresh'
  )),

  status text not null default 'queued' check (status in (
    'queued',      -- waiting for a worker; next_run_at says when it is eligible
    'running',     -- claimed by a worker
    'succeeded',   -- terminal
    'failed',      -- transient failure, may return to queued while attempts remain
    'dead_letter', -- attempts exhausted or permanently rejected; replayable by a human
    'cancelled'    -- terminal, withdrawn before it ran
  )),

  -- Lower runs first. Bounded so "priority = -999999" cannot starve the queue.
  priority integer not null default 100 check (priority between 1 and 1000),

  payload jsonb not null default '{}'::jsonb,

  -- Idempotency for enqueue. Partial-unique below: only among jobs that are still live, so the
  -- same import can legitimately be re-run next month.
  dedupe_key text check (dedupe_key is null or btrim(dedupe_key) <> ''),

  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 50),

  -- Retry policy lives in the row, not in a worker's head: a job that must wait for backoff is
  -- simply not yet eligible, and any worker can see why.
  next_run_at timestamptz not null default now(),

  started_at timestamptz,
  finished_at timestamptz,
  last_error text,

  progress_total integer check (progress_total is null or progress_total >= 0),
  progress_done integer not null default 0 check (progress_done >= 0),

  dead_lettered_at timestamptz,
  dead_letter_reason text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Progress can never exceed the work. Caught here rather than in a worker, because a progress
  -- bar reading 118% is a bug report from a user instead of a rejected write.
  constraint background_jobs_progress_within_total check (
    progress_total is null or progress_done <= progress_total
  ),

  -- 0026's bidirectional-consistency pattern, reused rather than reinvented.
  constraint background_jobs_dead_letter_consistency check (
    (status = 'dead_letter') = (dead_lettered_at is not null)
    and (dead_lettered_at is not null) = (dead_letter_reason is not null)
    and (dead_letter_reason is null or btrim(dead_letter_reason) <> '')
  ),

  -- Every terminal state has a finish time; no non-terminal state has one. Without this, a
  -- "how long do jobs take" question has no trustworthy answer.
  constraint background_jobs_terminal_finished check (
    (status in ('succeeded', 'failed', 'dead_letter', 'cancelled')) = (finished_at is not null)
  ),

  -- A running job has been started. (started_at is deliberately NOT cleared on requeue: the
  -- fact that an earlier attempt began is history, and history is not erased to tidy a column.)
  constraint background_jobs_running_started check (
    status <> 'running' or started_at is not null
  )
);

-- Only one LIVE job per dedupe key. Terminal rows are excluded so the same logical import can be
-- enqueued again later — the alternative (a plain unique) would make every monthly import fail
-- because last month's succeeded.
create unique index if not exists background_jobs_dedupe_live
  on public.background_jobs (dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running', 'failed');

-- The claim query: eligible work, best priority first, oldest first within a priority.
create index if not exists background_jobs_claim_idx
  on public.background_jobs (status, next_run_at, priority, created_at);

create index if not exists background_jobs_type_status_idx
  on public.background_jobs (job_type, status, created_at desc);

-- ── transition guard, in the SAME migration as the CHECK ────────────────────────────────
--
-- The CHECK says which values are legal. It says nothing about which MOVES are legal, and those
-- are different questions: 'succeeded' is a legal value and succeeded -> running is an illegal
-- move. Shipping the column without the guard (the 0027 lesson) leaves the second question
-- unanswered until something silently answers it wrongly.
--
-- Allowed moves, and why:
--   queued      -> running       a worker claimed it
--   queued      -> cancelled     withdrawn before it ran
--   running     -> succeeded     finished
--   running     -> failed        transient failure; retried while attempts remain
--   running     -> dead_letter   permanently rejected (bad payload — retrying cannot help)
--   running     -> queued        worker died; a reaper returns the job to the queue
--   failed      -> queued        backoff elapsed, attempts remain
--   failed      -> dead_letter   attempts exhausted
--   dead_letter -> queued        DELIBERATE human replay after the cause was fixed
--
-- REFUSED, and these are the point of the guard:
--   succeeded -> anything   a completed job cannot be un-completed; re-running is a NEW job.
--                           Without this, a retry loop could re-execute a finished import and
--                           double every row it wrote.
--   cancelled -> anything   the same, for work somebody deliberately withdrew.
create or replace function public.background_jobs_guard_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('queued',      'running'),
    ('queued',      'cancelled'),
    ('running',     'succeeded'),
    ('running',     'failed'),
    ('running',     'dead_letter'),
    ('running',     'queued'),
    ('failed',      'queued'),
    ('failed',      'dead_letter'),
    ('dead_letter', 'queued')
  ) then
    raise exception 'Geçersiz iş durumu geçişi: % → % (iş %)',
      old.status, new.status, old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists background_jobs_status_guard on public.background_jobs;
create trigger background_jobs_status_guard
  before update of status on public.background_jobs
  for each row execute function public.background_jobs_guard_transition();

drop trigger if exists background_jobs_updated_at on public.background_jobs;
create trigger background_jobs_updated_at before update on public.background_jobs
  for each row execute function public.set_updated_at();

-- ── RLS: Faz 24B five-tier classification, never a blanket `authenticated` ──────────────
--
-- Classified `operational`: enqueuing an import is data entry, everyone may watch the queue, and
-- only a manager/admin may delete a row. Deleting is separated from cancelling on purpose —
-- cancelling is a status change that leaves the record, deleting destroys the evidence that the
-- job ever existed.
alter table public.background_jobs enable row level security;

drop policy if exists background_jobs_select_all_tiers on public.background_jobs;
create policy background_jobs_select_all_tiers on public.background_jobs
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists background_jobs_insert_enter on public.background_jobs;
create policy background_jobs_insert_enter on public.background_jobs
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (true);
drop policy if exists background_jobs_update_enter on public.background_jobs;
create policy background_jobs_update_enter on public.background_jobs
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists background_jobs_delete_manage on public.background_jobs;
create policy background_jobs_delete_manage on public.background_jobs
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);

grant select on public.background_jobs to mas_radar_viewer, mas_radar_finance_approver;
grant select, insert, update on public.background_jobs
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin;
grant delete on public.background_jobs to mas_radar_finance_manager, mas_radar_admin;

-- ── queue health, as a VIEW (not stored) ────────────────────────────────────────────────
create or replace view public.background_job_queue_health as
  select
    job_type,
    status,
    count(*)::int                                             as job_count,
    -- Oldest waiting item is the number that tells you the queue is stuck; an average hides it.
    min(created_at)                                           as oldest_created_at,
    max(attempts)                                             as max_attempts_used,
    -- NULL when nothing has finished: an unmeasured duration is not zero seconds.
    avg(extract(epoch from (finished_at - started_at)))
      filter (where finished_at is not null and started_at is not null) as avg_seconds
  from public.background_jobs
  group by job_type, status;

grant select on public.background_job_queue_health to mas_radar_viewer,
  mas_radar_finance_operator, mas_radar_finance_approver,
  mas_radar_finance_manager, mas_radar_admin;
