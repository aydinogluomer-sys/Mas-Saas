-- Phase 14A: data-quality action workflow.
-- Tasks are operational follow-ups. They never mutate payment/check/loan/cashflow
-- source-of-truth tables; they only point back to facts, reviews, reports or AI output.

create table public.action_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  owner text,
  due_date date,
  status text not null default 'open' check (status in ('open','in_progress','blocked','done','cancelled')),
  source_type text not null default 'manual' check (source_type in ('manual','home_action','fact','mapping_review','report','ai_response')),
  source_fact_key text,
  source_href text,
  related_entity_table text,
  related_entity_id uuid,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger action_items_updated_at before update on public.action_items
  for each row execute function public.set_updated_at();

create index action_items_status_idx on public.action_items(status, severity, due_date);
create index action_items_related_idx on public.action_items(related_entity_table, related_entity_id);
create unique index action_items_open_related_unique on public.action_items(source_type, related_entity_table, related_entity_id)
  where related_entity_id is not null and status in ('open','in_progress','blocked');
create unique index action_items_open_fact_unique on public.action_items(source_type, source_fact_key)
  where source_fact_key is not null and status in ('open','in_progress','blocked');

alter table public.action_items enable row level security;
create policy action_items_authenticated_all on public.action_items
  for all to authenticated using (true) with check (true);
