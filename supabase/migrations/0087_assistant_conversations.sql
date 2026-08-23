-- Faz 38 — conversation context for the finance assistant.
--
-- ═══ THE EXISTING ANSWER PIPELINE IS NOT TOUCHED ═══
--
-- `ai_response_snapshots` already stores every answer with its question, response mode, model,
-- source fact keys and source hrefs. This migration does NOT replace it and does not change how
-- an answer is produced. It adds the two columns a follow-up question needs — which conversation
-- a turn belongs to, and its position in that conversation — plus the conversation itself.
--
-- Everything that makes the assistant safe lives in src/lib/ai (mutationIntent, the
-- deterministic-first flow, AI_FORCE_DETERMINISTIC). None of it moves here, and Faz 38 extends
-- around it rather than through it.

create table if not exists public.assistant_conversations (
  id uuid primary key default gen_random_uuid(),

  -- Derived from the first question, so a history list is readable without opening each thread.
  title text not null check (btrim(title) <> ''),

  status text not null default 'active' check (status in ('active', 'archived')),
  archived_at timestamptz,
  archive_reason text,

  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 0026's bidirectional-consistency pattern, reused rather than reinvented.
  constraint assistant_conversations_archive_consistency check (
    (status = 'archived') = (archived_at is not null)
    and (archived_at is not null) = (archive_reason is not null)
    and (archive_reason is null or btrim(archive_reason) <> '')
  )
);

create index if not exists assistant_conversations_owner_idx
  on public.assistant_conversations (created_by, status, updated_at desc);

-- ── link answers to conversations ───────────────────────────────────────────────────────
--
-- Nullable on purpose: every answer ever recorded predates conversations, and a NOT NULL column
-- would either reject that history or force it into a fabricated thread. A null conversation_id
-- means "a one-off question", which is exactly what those were.
alter table public.ai_response_snapshots
  add column if not exists conversation_id uuid references public.assistant_conversations(id) on delete set null;
alter table public.ai_response_snapshots
  add column if not exists turn_index integer;

alter table public.ai_response_snapshots
  drop constraint if exists ai_response_snapshots_turn_consistency;
alter table public.ai_response_snapshots
  add constraint ai_response_snapshots_turn_consistency check (
    (conversation_id is null) = (turn_index is null)
    and (turn_index is null or turn_index >= 1)
  );

create index if not exists ai_response_snapshots_conversation_idx
  on public.ai_response_snapshots (conversation_id, turn_index);

-- ── transition guard, in the SAME migration as the CHECK (the 0027 lesson) ──────────────
--
-- Allowed: active -> archived, archived -> active.
--
-- Both directions on purpose: archiving a conversation is tidying, not a decision with
-- consequences, and un-archiving one an operator still needs is a normal thing to want. There is
-- no third state, so the guard's job here is narrow — it exists so a future state cannot be added
-- without someone deciding which moves into and out of it are legal.
create or replace function public.assistant_conversations_guard_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('active',   'archived'),
    ('archived', 'active')
  ) then
    raise exception 'Geçersiz konuşma durumu geçişi: % → % (konuşma %)',
      old.status, new.status, old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists assistant_conversations_status_guard on public.assistant_conversations;
create trigger assistant_conversations_status_guard
  before update of status on public.assistant_conversations
  for each row execute function public.assistant_conversations_guard_transition();

drop trigger if exists assistant_conversations_updated_at on public.assistant_conversations;
create trigger assistant_conversations_updated_at before update on public.assistant_conversations
  for each row execute function public.set_updated_at();

-- ── RLS: ownership, the `personal` class from Faz 36 ────────────────────────────────────
--
-- A conversation is a person's own working thread — closer to a saved view than to a financial
-- record. It is owner-scoped for the same reason: what somebody asked the assistant, and in what
-- order, is theirs.
--
-- Viewer keeps READ only, exactly as Faz 36 settled: Faz 24B asserts as an invariant that a
-- viewer writes to NO table, and that rule is worth more than letting a read-only colleague name
-- a thread. A viewer can still ASK — the answer is recorded in ai_response_snapshots by the
-- application path, which is not tier-scoped writing.
alter table public.assistant_conversations enable row level security;

drop policy if exists assistant_conversations_own_select_all_tiers on public.assistant_conversations;
create policy assistant_conversations_own_select_all_tiers on public.assistant_conversations
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (created_by = public.current_app_user());

drop policy if exists assistant_conversations_insert_enter on public.assistant_conversations;
create policy assistant_conversations_insert_enter on public.assistant_conversations
  for insert to mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin with check (true);

drop policy if exists assistant_conversations_update_own on public.assistant_conversations;
create policy assistant_conversations_update_own on public.assistant_conversations
  for update to mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (created_by = public.current_app_user())
  with check (created_by = public.current_app_user());

drop policy if exists assistant_conversations_delete_own on public.assistant_conversations;
create policy assistant_conversations_delete_own on public.assistant_conversations
  for delete to mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (created_by = public.current_app_user());

grant select on public.assistant_conversations to mas_radar_viewer;
grant select, insert, update, delete on public.assistant_conversations
  to mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;
