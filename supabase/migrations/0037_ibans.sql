-- Faz 19 — counterparty bank accounts, with an append-only change history.
--
-- WHY THIS TABLE GETS ITS OWN HISTORY AND, SAY, counterparty_profiles DOES NOT. Changing a
-- counterparty's IBAN is the single highest-consequence edit in this application: it silently
-- redirects money. It is also the classic invoice-fraud vector ("our bank details have
-- changed"). Every other field can be reconstructed from the source workbook; a payment sent
-- to the wrong account cannot. So the IBAN's history is kept in the database itself, by
-- trigger, where it survives a bug in the application layer.
--
-- RELATIONSHIP TO audit_logs. This does NOT replace the Faz 18 audit() call — the engine still
-- records the user-initiated action in public.audit_logs like every other mutation. The two
-- serve different purposes: audit_logs answers "which operator did what", and is written by
-- the application; iban_change_events answers "what did this IBAN ever say", and is written by
-- the database whether the change arrived through the app, a script, or psql. Belt and braces,
-- on purpose, for this one column.
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.
-- No status/lifecycle enum here either (see 0036's note on §17 rule 3) — is_active is a
-- boolean, and deactivating an IBAN is recorded as an ordinary change event.

create table if not exists public.ibans (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.parties(id) on delete cascade,

  -- Stored exactly as entered (spacing and case preserved for display / source traceability);
  -- all matching and uniqueness happen on the normalized form below.
  iban text not null check (btrim(iban) <> ''),

  -- Whitespace-stripped, uppercased. Generated so it can never drift from `iban` — a hand-
  -- maintained "normalized" column that one code path forgets to update is how duplicate
  -- bank accounts get in.
  iban_normalized text generated always as (upper(regexp_replace(iban, '\s', '', 'g'))) stored,

  bank_name text check (bank_name is null or btrim(bank_name) <> ''),
  account_label text check (account_label is null or btrim(account_label) <> ''),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  is_primary boolean not null default false,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Scoped to the party, NOT globally unique — and this is a deliberate, load-bearing choice.
-- parties is unique on (normalized_name, party_type), so one real firm can legitimately exist
-- as two rows (once 'customer', once 'vendor'), and it would hold the SAME IBAN in both. A
-- global unique index would make that correct state impossible to represent and would fail a
-- truthful import. What must never happen is the same account recorded twice against the same
-- counterparty, which is what this enforces. The cross-party case is surfaced as a
-- data-quality signal by the duplicate view in 0039 instead of being blocked here.
create unique index if not exists ibans_party_normalized_uq
  on public.ibans (party_id, iban_normalized);

create index if not exists ibans_normalized_idx on public.ibans (iban_normalized);
create index if not exists ibans_party_idx on public.ibans (party_id);

-- At most one primary account per counterparty. A partial unique index rather than a CHECK,
-- because the constraint is across rows, not within one.
create unique index if not exists ibans_one_primary_per_party
  on public.ibans (party_id) where is_primary;

drop trigger if exists ibans_updated_at on public.ibans;
create trigger ibans_updated_at before update on public.ibans
  for each row execute function public.set_updated_at();

alter table public.ibans enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ibans' and policyname = 'ibans_authenticated_all'
  ) then
    create policy ibans_authenticated_all on public.ibans
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.ibans to authenticated;

-- ── change history ────────────────────────────────────────────────────────────────────────

create table if not exists public.iban_change_events (
  id uuid primary key default gen_random_uuid(),
  -- Not an FK: the row must outlive the IBAN it describes. A DELETE on ibans is precisely the
  -- event most worth keeping, and an ON DELETE CASCADE here would erase the evidence at the
  -- exact moment it becomes interesting. party_id is likewise denormalized for the same reason.
  iban_id uuid not null,
  party_id uuid not null,
  change_type text not null check (change_type in ('created', 'updated', 'deleted')),
  before_data jsonb,
  after_data jsonb,
  changed_at timestamptz not null default now()
);

create index if not exists iban_change_events_iban_idx on public.iban_change_events (iban_id, changed_at desc);
create index if not exists iban_change_events_party_idx on public.iban_change_events (party_id, changed_at desc);

alter table public.iban_change_events enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'iban_change_events'
      and policyname = 'iban_change_events_authenticated_all'
  ) then
    create policy iban_change_events_authenticated_all on public.iban_change_events
      for all to authenticated using (true) with check (true);
  end if;
end $$;

-- INSERT only. The REVOKE is defence in depth (a superuser ignores it); the triggers below are
-- what actually enforces this, superuser included — the same construction migration 0022 uses
-- for audit_logs, and for the same reason: a history that can be edited is not a history.
grant select, insert on public.iban_change_events to authenticated;
revoke update, delete, truncate on public.iban_change_events from public;
do $$
declare r record;
begin
  for r in
    select distinct grantee
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'iban_change_events'
      and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
      and grantee <> current_user
  loop
    execute format('revoke update, delete, truncate on public.iban_change_events from %I', r.grantee);
  end loop;
end $$;

create or replace function public.iban_change_events_block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'iban_change_events salt-ekleme (append-only): % engellendi.', tg_op;
end;
$$;

drop trigger if exists iban_change_events_no_update on public.iban_change_events;
create trigger iban_change_events_no_update before update on public.iban_change_events
  for each row execute function public.iban_change_events_block_mutation();

drop trigger if exists iban_change_events_no_delete on public.iban_change_events;
create trigger iban_change_events_no_delete before delete on public.iban_change_events
  for each row execute function public.iban_change_events_block_mutation();

drop trigger if exists iban_change_events_no_truncate on public.iban_change_events;
create trigger iban_change_events_no_truncate before truncate on public.iban_change_events
  for each statement execute function public.iban_change_events_block_mutation();

-- ── the recorder ──────────────────────────────────────────────────────────────────────────

-- AFTER, not BEFORE: the event should describe what actually landed, including anything the
-- updated_at trigger or a generated column changed. to_jsonb(row) captures every column, so a
-- future ALTER TABLE ADD COLUMN is recorded from the moment it exists without touching this.
create or replace function public.ibans_record_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into public.iban_change_events (iban_id, party_id, change_type, before_data, after_data)
    values (new.id, new.party_id, 'created', null, to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    -- A no-op UPDATE writes no history. Without this, any bulk "touch" over the table would
    -- bury the real changes under identical rows.
    if to_jsonb(new) - 'updated_at' is not distinct from to_jsonb(old) - 'updated_at' then
      return new;
    end if;
    insert into public.iban_change_events (iban_id, party_id, change_type, before_data, after_data)
    values (new.id, new.party_id, 'updated', to_jsonb(old), to_jsonb(new));
    return new;
  else
    insert into public.iban_change_events (iban_id, party_id, change_type, before_data, after_data)
    values (old.id, old.party_id, 'deleted', to_jsonb(old), null);
    return old;
  end if;
end;
$$;

drop trigger if exists ibans_record_change_trg on public.ibans;
create trigger ibans_record_change_trg
  after insert or update or delete on public.ibans
  for each row execute function public.ibans_record_change();
