-- Faz 25 — widening two existing CHECK enums, in a migration that does nothing else.
--
-- Faz 22 established that extending an enum CHECK gets its own explicit migration rather than
-- being buried inside a feature migration. The reason is auditability: these two statements
-- change what the REST of the schema will accept from now on, and a reviewer looking for "when
-- did action_items start accepting a collections source" should find one file, not a line
-- hidden in the middle of a table definition.

-- ── 1) reminders.target_kind — three kinds becomes five ────────────────────────────────
--
-- 0006 allowed payment_instance / check / loan_installment. Collections needs two more:
--
--   invoice          chasing an unpaid receivable is the core collections reminder, and until
--                    now the only way to remind about one was through its payment_instance,
--                    which sales invoices do not have.
--   promise_to_pay   remind the operator on the day a promise falls due, so a broken promise is
--                    noticed by a person before the detection job records it as a statistic.
--
-- The application-side kind mapping is NOT derived by elimination any more. Before this phase
-- `targetKindOf()` returned 'loan_installment' for anything that was not payment_instances or
-- checks — a fallthrough that was harmless while three kinds existed and would have silently
-- mislabelled both new ones. src/lib/reminders/rules.ts now maps explicitly and refuses unknown
-- tables; this CHECK is the database half of that same refusal.
alter table public.reminders drop constraint if exists reminders_target_kind_check;
alter table public.reminders
  add constraint reminders_target_kind_check
  check (target_kind in ('payment_instance', 'check', 'loan_installment', 'invoice', 'promise_to_pay'));

-- reminders.channel already permitted ('telegram','email') in 0006 — measured, not assumed.
-- Faz 25 adds the email TRANSPORT, not the column value, so there is deliberately no ALTER here.
-- Recording that explicitly so the absence reads as a finding rather than an omission.

-- ── 2) action_items.source_type — the collections follow-up ─────────────────────────────
--
-- The plan is explicit that collection notes and action history reuse action_items and that no
-- second task model is invented. That reuse needs exactly one new source_type: work created by
-- the collections function, whether a person raised it or the broken-promise job did.
--
-- One value, not three. 'promise_broken' / 'promise_kept' / 'collection_note' would have pushed
-- classification into the enum, where changing it later means another migration; the existing
-- related_entity_table/related_entity_id pair already says WHAT the item is about, and severity
-- already says how urgent. A single 'collection' keeps the widening minimal and reversible.
alter table public.action_items drop constraint if exists action_items_source_type_check;
alter table public.action_items
  add constraint action_items_source_type_check
  check (source_type in (
    'manual', 'home_action', 'fact', 'mapping_review', 'report', 'ai_response', 'collection'
  ));

-- Both statements are idempotent by construction (drop-then-add), which the ledger's
-- LEDGER_EMPTY_RECOVERY replay requires.
--
-- Neither widening can invalidate an existing row: both are strict supersets of the previous
-- value sets, so every row that satisfied the old constraint satisfies the new one. That is the
-- property that makes this safe to run against a populated database, and it is why the
-- constraints are replaced rather than added as NOT VALID and validated later.
