-- 0125_perf_fk_covering_indexes.sql
-- Covering B-tree indexes for the legal_entity_id and ops_incidents foreign keys introduced in 0122..0124.
-- Serves both RESTRICTIVE entity-isolation RLS predicates (matches_active_legal_entity) and FK referential checks,
-- keeping unindexed FK count strictly below the Faz 14 perf:gate ratchet ceiling.

create index if not exists idx_approvals_legal_entity_id
  on public.approvals (legal_entity_id);

create index if not exists idx_audit_logs_legal_entity_id
  on public.audit_logs (legal_entity_id);

create index if not exists idx_bank_transactions_legal_entity_id
  on public.bank_transactions (legal_entity_id);

create index if not exists idx_control_alerts_legal_entity_id
  on public.control_alerts (legal_entity_id);

create index if not exists idx_notification_outbox_legal_entity_id
  on public.notification_outbox (legal_entity_id);

create index if not exists idx_ops_incidents_acknowledged_by
  on public.ops_incidents (acknowledged_by);

create index if not exists idx_payment_instances_legal_entity_id
  on public.payment_instances (legal_entity_id);

create index if not exists idx_payment_runs_legal_entity_id
  on public.payment_runs (legal_entity_id);

create index if not exists idx_reports_legal_entity_id
  on public.reports (legal_entity_id);

create index if not exists idx_user_legal_entities_legal_entity_id
  on public.user_legal_entities (legal_entity_id);
