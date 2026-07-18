-- Derived analytics history. This table never replaces or mutates financial source records.
create table public.metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  metric_key text not null,
  dimension_key text not null default 'total',
  value_numeric numeric(20,4),
  value_text text,
  unknown_count integer not null default 0 check (unknown_count >= 0),
  confidence text not null default 'unknown' check (confidence in ('high','medium','low','unknown')),
  source_cutoff timestamptz not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(snapshot_date, metric_key, dimension_key),
  check (value_numeric is not null or value_text is not null or unknown_count > 0)
);

create index metric_snapshots_metric_date_idx on public.metric_snapshots(metric_key, snapshot_date desc);
create index metric_snapshots_date_idx on public.metric_snapshots(snapshot_date desc);

alter table public.metric_snapshots enable row level security;
create policy metric_snapshots_authenticated_all on public.metric_snapshots
  for all to authenticated using (true) with check (true);
