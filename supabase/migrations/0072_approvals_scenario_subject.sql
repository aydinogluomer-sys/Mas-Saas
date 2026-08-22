-- Faz 29 — widening approvals.subject_table, in a migration that does nothing else.
--
-- Faz 22 established that extending an enum CHECK gets its own explicit migration, and Faz 25
-- repeated it. The reason is auditability: this one statement changes what the approval entity
-- will accept from now on, and a reviewer asking "when did optimisation runs become approvable"
-- should find one file rather than a line buried in a table definition.
--
-- THIS IS THE CONNECTION, NOT A FORK. Faz 24A built `approvals` with a polymorphic
-- (subject_table, subject_id) precisely so that a new approvable thing costs one enum value and
-- nothing else. Scenario/optimisation approval therefore adds a value here and reuses
-- requestApproval/decideApproval unchanged — no second review table, no parallel status column on
-- optimization_runs, no third bespoke variant of the pattern Faz 24A spent a phase consolidating.
--
-- The widening is a strict superset of the previous value set, so no existing row can be
-- invalidated by it. That is what makes replacing the constraint safe on a populated database.
alter table public.approvals drop constraint if exists approvals_subject_table_check;
alter table public.approvals
  add constraint approvals_subject_table_check
  check (subject_table in (
    'mapping_reviews', 'external_assumptions', 'invoices', 'payment_instances',
    'ibans', 'parties', 'bank_transactions',
    -- Faz 29
    'optimization_runs'
  ));
