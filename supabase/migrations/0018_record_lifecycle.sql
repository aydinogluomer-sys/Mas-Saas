-- Reversible record lifecycle. Source rows, financial history and audit logs are never deleted.
alter table public.payments add column if not exists archived_at timestamptz;
alter table public.payments add column if not exists archive_reason text;
alter table public.payments add column if not exists archived_by_label text;
alter table public.checks add column if not exists archived_at timestamptz;
alter table public.checks add column if not exists archive_reason text;
alter table public.checks add column if not exists archived_by_label text;
alter table public.loans add column if not exists archived_at timestamptz;
alter table public.loans add column if not exists archive_reason text;
alter table public.loans add column if not exists archived_by_label text;
alter table public.scenario_runs add column if not exists archived_at timestamptz;
alter table public.scenario_runs add column if not exists archive_reason text;
alter table public.scenario_runs add column if not exists archived_by_label text;
alter table public.external_assumptions add column if not exists archived_at timestamptz;
alter table public.external_assumptions add column if not exists archive_reason text;
alter table public.external_assumptions add column if not exists archived_by_label text;
alter table public.action_items add column if not exists archived_at timestamptz;
alter table public.action_items add column if not exists archive_reason text;
alter table public.action_items add column if not exists archived_by_label text;

create index if not exists payments_archived_at_idx on public.payments(archived_at);
create index if not exists checks_archived_at_idx on public.checks(archived_at);
create index if not exists loans_archived_at_idx on public.loans(archived_at);
