-- Faz 31 — one enum value, in a migration that does nothing else.
--
-- Faz 22 established that extending an enum CHECK gets its own explicit migration; Faz 25 and
-- Faz 29 repeated it. The reason is auditability: this statement changes what action_items will
-- accept from now on, and a reviewer asking "when did control findings become tasks" should find
-- one file rather than a line buried in a table definition.
--
-- ONE VALUE, NOT SEVERAL. The plan asks for an anomaly review workflow with false-positive
-- feedback, and the temptation is a source_type per finding kind (duplicate_invoice,
-- approval_bypass, ...). That would push classification into an enum where changing it costs a
-- migration, when control_alerts.check_code already carries the finding kind and
-- related_entity_table/related_entity_id already say what it is about. Faz 25 made the same call
-- for 'collection'.
alter table public.action_items drop constraint if exists action_items_source_type_check;
alter table public.action_items
  add constraint action_items_source_type_check
  check (source_type in (
    'manual', 'home_action', 'fact', 'mapping_review', 'report', 'ai_response', 'collection',
    -- Faz 31
    'control'
  ));

-- Strict superset of the previous set, so no existing row can be invalidated — the property that
-- makes replacing the constraint safe on a populated database.
