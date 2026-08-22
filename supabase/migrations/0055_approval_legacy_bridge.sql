-- Faz 24A — bringing the two existing review systems into the Approval entity.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- WHAT WAS THERE BEFORE, exactly as measured before this was written.
--
--   mapping_reviews.status            open · accepted · rejected · resolved
--     - NO transition guard. Any value to any value.
--     - reviewed_at/reviewed_by rewritten on EVERY change, including back to 'open'.
--     - Six gate scripts jump it arbitrarily: phase3 (→accepted), phase4/5/12a/13a (→resolved).
--     - The setter silently no-ops when the row is missing and silently returns on a bad value.
--
--   external_assumptions.review_status   pending_review · approved · rejected
--     - NO transition guard.
--     - reviewed_at set ONLY when the new status is 'approved'; otherwise PRESERVED. This is
--       load-bearing: constraint external_assumptions_check1 requires
--       internet-sourced + approved ⇒ reviewed_at is not null.
--     - reviewed_by always rewritten.
--
-- NEITHER LEGACY COLUMN IS CHANGED BY THIS MIGRATION. No guard is added to them, no value is
-- rewritten, no default moves. Adding a transition guard to mapping_reviews would break six
-- verified gate scripts on the first arbitrary jump — which is exactly the 0027 failure, except
-- self-inflicted with full knowledge. The consolidation is that approvals becomes the single
-- Approval ENTITY and every legacy review now produces one; it is not a rewrite of two working
-- domain state machines.
--
-- DIRECTION: legacy → approvals, by trigger. Every existing write path — the UI action, the six
-- gate scripts, a psql session — now yields an approval record without knowing this table
-- exists. The reverse direction (deciding an approval writes the legacy column back) lives in
-- src/lib/approvals/engine.ts, is a NEW path only, and touches nothing that worked before.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

-- Maps a legacy domain value onto the four canonical approval states. The exact legacy value is
-- kept verbatim in approvals.subject_status, because 'resolved' and 'accepted' are different
-- things to the screens that show them and this mapping must not be the only surviving copy.
create or replace function public.approval_map_legacy_status(p_table text, p_status text)
returns text language sql immutable as $$
  select case
    when p_table = 'mapping_reviews' then case p_status
      when 'open' then 'pending'
      when 'accepted' then 'approved'
      when 'rejected' then 'rejected'
      when 'resolved' then 'approved'
      else 'pending' end
    when p_table = 'external_assumptions' then case p_status
      when 'pending_review' then 'pending'
      when 'approved' then 'approved'
      when 'rejected' then 'rejected'
      else 'pending' end
    else 'pending' end;
$$;

/*
 * Records a legacy review state as an approval.
 *
 * The interesting case is the third branch. The legacy tables allow jumps this table's guard
 * refuses — 'resolved' back to 'open' maps to approved → pending, which is not in the allow-list
 * because an approved decision is terminal here. Rather than weaken the guard or block the
 * legacy write, a NEW ROUND is opened. That is not a workaround: reopening a settled review
 * genuinely is a second approval round, and modelling it as one keeps both rounds readable
 * instead of overwriting the first.
 */
create or replace function public.approval_sync_from_legacy() returns trigger
language plpgsql as $$
declare
  v_subject_table text := tg_argv[0];
  v_status text;
  v_mapped text;
  v_label text;
  v_reviewer uuid;
  v_latest record;
  v_next_round int;
  v_step int;
  v_old_status text;
begin
  -- NEW and OLD are read in SEPARATE branches, never inside one expression.
  --
  -- The first version of this function wrote
  --   `case when v_subject_table='mapping_reviews' then old.status else old.review_status end`
  -- and PL/pgSQL raised `record "old" has no field "review_status"` on mapping_reviews: the
  -- field lookup is resolved against the actual rowtype regardless of which CASE branch would
  -- be taken. The exception propagated out of this AFTER trigger and KILLED THE LEGACY INSERT —
  -- precisely the outcome this bridge exists to make impossible. Branching first is what keeps
  -- each field reference confined to the rowtype that has it.
  if v_subject_table = 'mapping_reviews' then
    v_status := new.status;
    v_label := left(coalesce(new.message, new.issue_type), 200);
    v_reviewer := new.reviewed_by;
    if tg_op = 'UPDATE' then v_old_status := old.status; end if;
  else
    v_status := new.review_status;
    v_label := left(coalesce(new.label, new.assumption_type), 200);
    v_reviewer := new.reviewed_by;
    if tg_op = 'UPDATE' then v_old_status := old.review_status; end if;
  end if;

  v_mapped := public.approval_map_legacy_status(v_subject_table, v_status);

  select * into v_latest from public.approvals a
  where a.subject_table = v_subject_table and a.subject_id = new.id
  order by a.round_no desc limit 1;

  if v_latest is null then
    insert into public.approvals
      (subject_table, subject_id, subject_label, request_kind, round_no, status, subject_status,
       decided_by, decided_at)
    values
      (v_subject_table, new.id, v_label, 'data_review', 1, v_mapped, v_status,
       case when v_mapped in ('approved','rejected') then v_reviewer end,
       case when v_mapped in ('approved','rejected') then coalesce(new.reviewed_at, now()) end);

  elsif v_latest.status = v_mapped then
    -- Same canonical state; only the exact legacy value or the label may have moved.
    update public.approvals set subject_status = v_status, subject_label = v_label
    where id = v_latest.id;

  elsif (v_latest.status, v_mapped) in (
      ('pending','approved'), ('pending','rejected'), ('pending','reworked'),
      ('reworked','pending'), ('reworked','rejected')) then
    update public.approvals
      set status = v_mapped,
          subject_status = v_status,
          subject_label = v_label,
          decided_by = case when v_mapped in ('approved','rejected') then coalesce(v_reviewer, decided_by) end,
          decided_at = case when v_mapped in ('approved','rejected') then coalesce(new.reviewed_at, now()) end
    where id = v_latest.id;

  else
    -- A jump the guard refuses (e.g. approved → pending). New round.
    v_next_round := v_latest.round_no + 1;
    insert into public.approvals
      (subject_table, subject_id, subject_label, request_kind, round_no, status, subject_status,
       decided_by, decided_at)
    values
      (v_subject_table, new.id, v_label, 'data_review', v_next_round, v_mapped, v_status,
       case when v_mapped in ('approved','rejected') then v_reviewer end,
       case when v_mapped in ('approved','rejected') then coalesce(new.reviewed_at, now()) end);
  end if;

  -- One step row per legacy transition, so the workflow trail is complete even for changes that
  -- never went through the approvals engine.
  if tg_op = 'INSERT' or v_status is distinct from v_old_status then
    select coalesce(max(s.step_no), 0) + 1 into v_step
    from public.approval_steps s
    where s.approval_id = (
      select a.id from public.approvals a
      where a.subject_table = v_subject_table and a.subject_id = new.id
      order by a.round_no desc limit 1);

    insert into public.approval_steps (approval_id, step_no, action, actor, note, from_status, to_status)
    select a.id, v_step,
           case v_mapped when 'approved' then 'approved' when 'rejected' then 'rejected'
                         when 'reworked' then 'reworked' else 'requested' end,
           v_reviewer,
           'legacy köprüsü: ' || v_subject_table,
           v_old_status,
           v_status
    from public.approvals a
    where a.subject_table = v_subject_table and a.subject_id = new.id
    order by a.round_no desc limit 1;
  end if;

  return null;
end $$;

-- AFTER triggers: the legacy write commits on its own terms and the approval is derived from
-- what actually landed. A BEFORE trigger could fail a legacy write, which is precisely the
-- outcome this design refuses.
drop trigger if exists mapping_reviews_approval_sync on public.mapping_reviews;
create trigger mapping_reviews_approval_sync
  after insert or update of status on public.mapping_reviews
  for each row execute function public.approval_sync_from_legacy('mapping_reviews');

drop trigger if exists external_assumptions_approval_sync on public.external_assumptions;
create trigger external_assumptions_approval_sync
  after insert or update of review_status on public.external_assumptions
  for each row execute function public.approval_sync_from_legacy('external_assumptions');

-- ── backfill ───────────────────────────────────────────────────────────────────────────────
-- Existing rows get their round 1 so the queue is complete from the moment this ships. Guarded
-- by NOT EXISTS so a re-run adds nothing (LEDGER_EMPTY_RECOVERY).
insert into public.approvals
  (subject_table, subject_id, subject_label, request_kind, round_no, status, subject_status,
   decided_by, decided_at)
select 'mapping_reviews', m.id, left(coalesce(m.message, m.issue_type), 200), 'data_review', 1,
       public.approval_map_legacy_status('mapping_reviews', m.status), m.status,
       case when m.status in ('accepted','rejected','resolved') then m.reviewed_by end,
       case when m.status in ('accepted','rejected','resolved') then coalesce(m.reviewed_at, m.created_at) end
from public.mapping_reviews m
where not exists (
  select 1 from public.approvals a where a.subject_table='mapping_reviews' and a.subject_id=m.id);

insert into public.approvals
  (subject_table, subject_id, subject_label, request_kind, round_no, status, subject_status,
   decided_by, decided_at)
select 'external_assumptions', e.id, left(coalesce(e.label, e.assumption_type), 200), 'data_review', 1,
       public.approval_map_legacy_status('external_assumptions', e.review_status), e.review_status,
       case when e.review_status in ('approved','rejected') then e.reviewed_by end,
       case when e.review_status in ('approved','rejected') then coalesce(e.reviewed_at, e.created_at) end
from public.external_assumptions e
where not exists (
  select 1 from public.approvals a where a.subject_table='external_assumptions' and a.subject_id=e.id);

-- ── the unified queue ──────────────────────────────────────────────────────────────────────
-- One list an operator works, regardless of which system raised the item. This is what "no
-- third variant" means in practice: new approval kinds land here beside the legacy reviews
-- instead of growing their own screen.
create or replace view public.approval_queue as
  select
    a.id, a.subject_table, a.subject_id, a.subject_label, a.request_kind, a.rule_code,
    a.round_no, a.status, a.subject_status, a.amount, a.currency,
    a.requested_by, a.requested_at, a.decided_by, a.decided_at, a.decision_note,
    ru.display_name as requested_by_name,
    du.display_name as decided_by_name,
    (select count(*) from public.approval_steps s where s.approval_id = a.id) as step_count
  from public.approvals a
  left join public.users ru on ru.id = a.requested_by
  left join public.users du on du.id = a.decided_by;

grant select on public.approval_queue to authenticated;
