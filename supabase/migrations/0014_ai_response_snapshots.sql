-- Phase 12A: AI/question-answer response snapshots.
-- Commentary only: stores answers, selected deterministic sources, and provider metadata.
-- Never mutates financial source-of-truth tables.

create table public.ai_response_snapshots (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer_md text not null,
  response_mode text not null default 'deterministic'
    check (response_mode in ('deterministic','openai','fallback')),
  model text,
  source_fact_keys text[] not null default '{}',
  source_hrefs text[] not null default '{}',
  report_id uuid references public.reports(id) on delete set null,
  safety_notes text[] not null default '{}',
  meta jsonb,
  created_at timestamptz not null default now()
);
create index ai_response_snapshots_created_idx on public.ai_response_snapshots(created_at desc);
create index ai_response_snapshots_report_idx on public.ai_response_snapshots(report_id) where report_id is not null;

alter table public.ai_response_snapshots enable row level security;
create policy ai_response_snapshots_authenticated_all on public.ai_response_snapshots
  for all to authenticated using (true) with check (true);
