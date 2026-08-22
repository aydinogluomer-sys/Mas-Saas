-- Faz 24A — the real Approval entity.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- THE STATUS ALLOW-LIST. Third time this repo builds one; the rule has not changed.
--
--   CHECK admits:  pending · approved · rejected · reworked
--
--   pending  → approved    the checker approved it
--   pending  → rejected    the checker refused it
--   pending  → reworked    sent back to the maker for changes
--   reworked → pending     the maker resubmitted
--   reworked → rejected    abandoned instead of resubmitted
--
--   REACHABILITY: pending is the insert default; approved and rejected from pending; reworked
--   from pending; pending again from reworked. All four reachable, none a dead letter.
--
--   approved and rejected are TERMINAL. A decision that can be silently un-made is not a
--   decision, and maker-checker exists precisely to make the decision the record. Reopening is
--   a NEW approval round (see round_no below), which leaves both rounds visible instead of
--   overwriting the first one — the same reasoning that made Faz 21's `cancelled` terminal.
--
--   Same-status updates are a no-op for every value (0027's one correct part).
--
-- scripts/phase24a-verify.ts proves this by enumerating all 16 pairs against real rows.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- WHY round_no EXISTS, and why it is not decoration. The two legacy review systems this phase
-- consolidates (mapping_reviews, external_assumptions.review_status) have NO transition guard
-- and six gate scripts jump their status arbitrarily — `update mapping_reviews set
-- status='resolved'` from whatever the row happened to be. Those writes must keep working
-- byte-for-byte (implementation.md's rule, and Faz 18's precedent). So when 0055's bridge sees
-- a legacy jump that this table's guard would refuse, it opens a NEW ROUND rather than forcing
-- an illegal transition or weakening the guard. Reopening a resolved review genuinely IS a new
-- approval round; modelling it that way keeps both the history and the guard intact.
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),

  -- Polymorphic subject, matching how this schema already points at "one of the entities"
  -- (audit_logs.entity_table, bank_transaction_match_candidates.target_table). The two legacy
  -- systems are members from day one — that is the consolidation.
  subject_table text not null check (subject_table in (
    'mapping_reviews', 'external_assumptions',
    'invoices', 'payment_instances', 'ibans', 'parties', 'bank_transactions'
  )),
  subject_id uuid not null,
  -- Human-readable at the time of request, so a decided approval still reads sensibly after the
  -- subject is archived or renamed.
  subject_label text,

  -- Why an approval was needed. Free text would make the queue unfilterable; the rule that
  -- fired is recorded in rule_code (0054).
  request_kind text not null check (request_kind in (
    'data_review', 'amount_threshold', 'new_iban', 'new_counterparty', 'invoice', 'payment', 'other'
  )),
  rule_code text,

  -- Which round of approval this is for the subject. 1 for the first.
  round_no int not null default 1 check (round_no > 0),

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'reworked')),

  -- The money that triggered an amount-threshold rule, when there is one. numeric like every
  -- other money column; the application decodes through money.ts.
  amount numeric(14,2),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),

  requested_by uuid references public.users(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.users(id),
  decided_at timestamptz,
  decision_note text,

  -- A decision must carry its moment, and an undecided approval must not claim one.
  --
  -- decided_by is deliberately NOT paired into this constraint, and that is a correction made
  -- after measuring rather than a looseness. The first version required a named decider for
  -- every decision, and 0055's bridge then ABORTED legacy writes: the six gate scripts resolve
  -- mapping_reviews anonymously (`set status='resolved', reviewed_at=now()` with no reviewer),
  -- and pre-P0-A history has the same shape. The choice was between representing that history
  -- truthfully with a null decider, or inventing an actor to satisfy the constraint — and
  -- inventing attribution is exactly what Faz 19's archive engine removed a hardcoded
  -- "Yerel kullanıcı" fallback to stop. A null decider therefore means "this decision predates
  -- or bypassed the maker-checker flow"; every decision made THROUGH src/lib/approvals/engine.ts
  -- names its decider, and phase24a:verify asserts that of the engine rather than of the table.
  constraint approvals_decision_consistency check (
    (status in ('approved', 'rejected')) = (decided_at is not null)
  ),

  -- MAKER-CHECKER, enforced in the database rather than trusted to the UI. The whole point of
  -- the pattern is that the person who asked cannot be the person who agreed; a check that
  -- lives only in an action is one refactor away from being gone.
  constraint approvals_maker_is_not_checker check (
    decided_by is null or requested_by is null or decided_by <> requested_by
  ),

  -- The exact domain value of the subject at the time, preserved verbatim. The four canonical
  -- statuses above cannot express 'resolved' vs 'accepted' (mapping_reviews) or
  -- 'pending_review' (external_assumptions), and flattening them would lose information the
  -- legacy screens still show.
  subject_status text,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (subject_table, subject_id, round_no)
);

create index if not exists approvals_pending_idx on public.approvals (status, requested_at desc)
  where status in ('pending', 'reworked');
create index if not exists approvals_subject_idx on public.approvals (subject_table, subject_id, round_no desc);

drop trigger if exists approvals_updated_at on public.approvals;
create trigger approvals_updated_at before update on public.approvals
  for each row execute function public.set_updated_at();

-- ── the guard, in the SAME migration as the column ─────────────────────────────────────────
create or replace function public.approvals_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('pending',  'approved'),
    ('pending',  'rejected'),
    ('pending',  'reworked'),
    ('reworked', 'pending'),
    ('reworked', 'rejected')
  ) then
    raise exception 'approvals.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;

drop trigger if exists approvals_status_transition_guard on public.approvals;
create trigger approvals_status_transition_guard before update on public.approvals
  for each row execute function public.approvals_status_transition_guard();

alter table public.approvals enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='approvals' and policyname='approvals_authenticated_all'
  ) then
    create policy approvals_authenticated_all on public.approvals
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.approvals to authenticated;

-- ── approval_steps: the workflow's own trail, append-only ──────────────────────────────────
--
-- Distinct from audit_logs, and both are kept. audit_logs answers "which operator did what" for
-- the whole application; approval_steps answers "how did THIS approval get here" and is the
-- thing a maker-checker review actually reads. Append-only by the 0022 construction, because a
-- workflow history that can be edited proves nothing about who agreed to what.
create table if not exists public.approval_steps (
  id uuid primary key default gen_random_uuid(),
  -- Not an FK, for the reason 0037 and 0046 both record: evidence must outlive its subject, and
  -- any table that can cascade into an append-only table can destroy it. `pnpm import:real`
  -- taught this the hard way in Faz 21.
  approval_id uuid not null,
  step_no int not null check (step_no > 0),
  action text not null check (action in ('requested', 'approved', 'rejected', 'reworked', 'commented', 'resubmitted')),
  actor uuid references public.users(id),
  note text,
  -- What the status was before and after this step, so a round can be replayed without
  -- re-deriving it from timestamps.
  from_status text,
  to_status text,
  created_at timestamptz not null default now(),
  unique (approval_id, step_no)
);

create index if not exists approval_steps_approval_idx on public.approval_steps (approval_id, step_no);

alter table public.approval_steps enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='approval_steps' and policyname='approval_steps_authenticated_all'
  ) then
    create policy approval_steps_authenticated_all on public.approval_steps
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert on public.approval_steps to authenticated;
revoke update, delete, truncate on public.approval_steps from public;
do $$
declare r record;
begin
  for r in
    select distinct grantee from information_schema.role_table_grants
    where table_schema='public' and table_name='approval_steps'
      and privilege_type in ('UPDATE','DELETE','TRUNCATE') and grantee <> current_user
  loop
    execute format('revoke update, delete, truncate on public.approval_steps from %I', r.grantee);
  end loop;
end $$;

create or replace function public.approval_steps_block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'approval_steps salt-ekleme (append-only): % engellendi.', tg_op;
end;
$$;

drop trigger if exists approval_steps_no_update on public.approval_steps;
create trigger approval_steps_no_update before update on public.approval_steps
  for each row execute function public.approval_steps_block_mutation();

drop trigger if exists approval_steps_no_delete on public.approval_steps;
create trigger approval_steps_no_delete before delete on public.approval_steps
  for each row execute function public.approval_steps_block_mutation();

drop trigger if exists approval_steps_no_truncate on public.approval_steps;
create trigger approval_steps_no_truncate before truncate on public.approval_steps
  for each statement execute function public.approval_steps_block_mutation();
