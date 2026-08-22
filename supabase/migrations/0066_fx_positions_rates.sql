-- Faz 27 — FX: the rates we observed, and the exposure we carry.
--
-- Two tables with deliberately different characters:
--
--   fx_rate_snapshots   an OBSERVATION. "On 2026-08-21 the TCMB selling rate for USD/TRY was
--                       X". That is a historical fact and it is APPEND-ONLY (the 0022 pattern,
--                       triggers plus REVOKE plus the Faz 24B `evidence` access class). A rate
--                       that can be edited after the fact makes every revaluation built on it
--                       unfalsifiable — you could always make last quarter's gain appear.
--   fx_positions        an EXPOSURE we choose to record and revise. Ordinary operational data.

create table if not exists public.fx_rate_snapshots (
  id uuid primary key default gen_random_uuid(),

  base_currency text not null,
  quote_currency text not null default 'TRY',
  rate_date date not null,

  -- TCMB publishes four figures and they are not interchangeable: you buy at one and sell at
  -- another. Storing only a single "rate" would force every consumer to guess which side it was.
  -- `rate` is the one revaluation uses; the others are recorded because they were published.
  rate numeric(18,10) not null check (rate > 0),
  forex_buying numeric(18,10) check (forex_buying is null or forex_buying > 0),
  forex_selling numeric(18,10) check (forex_selling is null or forex_selling > 0),
  banknote_buying numeric(18,10) check (banknote_buying is null or banknote_buying > 0),
  banknote_selling numeric(18,10) check (banknote_selling is null or banknote_selling > 0),

  -- Where the number came from. 'tcmb' means it was fetched from the published bulletin;
  -- 'manual' means a person typed it. Never inferred, always recorded.
  source text not null default 'manual'
    check (source in ('tcmb', 'manual', 'bank', 'other')),
  source_ref text,
  fetched_at timestamptz not null default now(),
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),

  constraint fx_rate_snapshots_pair_differs check (base_currency <> quote_currency),
  -- One rate per pair per day per source. A second observation from the same source on the same
  -- day is a correction, and corrections to an append-only table are a NEW source, not an edit.
  constraint fx_rate_snapshots_unique unique (base_currency, quote_currency, rate_date, source)
);

comment on table public.fx_rate_snapshots is
  'Faz 27: observed FX rates. APPEND-ONLY — a rate that can be edited afterwards makes every '
  'revaluation built on it unfalsifiable.';

-- ── append-only enforcement (0022 pattern) ─────────────────────────────────────────────
-- REVOKE is defence in depth; the triggers are what actually bind, and they refuse the superuser
-- too. Same construction as audit_logs, for the same reason.
create or replace function public.fx_rate_snapshots_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'fx_rate_snapshots salt-ekleme bir tablodur: % reddedildi', tg_op
    using errcode = 'restrict_violation';
end $$;

drop trigger if exists fx_rate_snapshots_no_update on public.fx_rate_snapshots;
create trigger fx_rate_snapshots_no_update before update on public.fx_rate_snapshots
  for each row execute function public.fx_rate_snapshots_block_mutation();

drop trigger if exists fx_rate_snapshots_no_delete on public.fx_rate_snapshots;
create trigger fx_rate_snapshots_no_delete before delete on public.fx_rate_snapshots
  for each row execute function public.fx_rate_snapshots_block_mutation();

drop trigger if exists fx_rate_snapshots_no_truncate on public.fx_rate_snapshots;
create trigger fx_rate_snapshots_no_truncate before truncate on public.fx_rate_snapshots
  for each statement execute function public.fx_rate_snapshots_block_mutation();

revoke update, delete, truncate on public.fx_rate_snapshots from authenticated;

create index if not exists fx_rate_snapshots_lookup_idx
  on public.fx_rate_snapshots (base_currency, quote_currency, rate_date desc);

-- ── positions ──────────────────────────────────────────────────────────────────────────
create table if not exists public.fx_positions (
  id uuid primary key default gen_random_uuid(),

  currency text not null,
  -- Signed exposure in the FOREIGN currency. Positive = we hold/are owed it (asset);
  -- negative = we owe it (liability). One signed column rather than an amount plus a direction
  -- enum, because a net position is then a plain sum and no consumer can forget the sign.
  amount numeric(18,2) not null,

  position_kind text not null default 'other'
    check (position_kind in (
      'bank_balance', 'receivable', 'payable', 'loan', 'facility', 'forward', 'other'
    )),

  as_of_date date not null,
  -- The rate at which this exposure entered the books. Revaluation is the difference between
  -- this and today's rate; without it a gain/loss figure is not computable, only guessable.
  entry_rate numeric(18,10) check (entry_rate is null or entry_rate > 0),

  counterparty_party_id uuid references public.parties(id),
  source_note text,
  is_active boolean not null default true,

  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A TRY position against TRY is not an FX position; it is just cash.
  constraint fx_positions_not_local check (currency <> 'TRY'),
  -- Zero is allowed (a closed-out position recorded for history); the column is signed, so no
  -- sign constraint is possible or wanted.
  constraint fx_positions_currency_len check (char_length(currency) between 3 and 3)
);

comment on column public.fx_positions.amount is
  'Signed FOREIGN-currency exposure. Positive = asset, negative = liability. One signed column '
  'so a net position is a plain sum.';

drop trigger if exists fx_positions_updated_at on public.fx_positions;
create trigger fx_positions_updated_at before update on public.fx_positions
  for each row execute function public.set_updated_at();

create index if not exists fx_positions_currency_idx
  on public.fx_positions (currency, as_of_date) where is_active;

-- ── RLS: Faz 24B tiers ─────────────────────────────────────────────────────────────────
-- fx_rate_snapshots  -> `evidence`: SELECT for everyone, INSERT for operator/approver/manager/
--                       admin, and NO update or delete policy for ANY tier including admin. RLS
--                       agreeing with the trigger means the refusal does not depend on which of
--                       the two layers a later change touches.
-- fx_positions       -> `operational`, like the rest of the financing tables.
alter table public.fx_rate_snapshots enable row level security;
alter table public.fx_positions enable row level security;

drop policy if exists fx_rate_snapshots_select_all_tiers on public.fx_rate_snapshots;
create policy fx_rate_snapshots_select_all_tiers on public.fx_rate_snapshots
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists fx_rate_snapshots_insert_record on public.fx_rate_snapshots;
create policy fx_rate_snapshots_insert_record on public.fx_rate_snapshots
  for insert to mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin with check (true);

drop policy if exists fx_positions_select_all_tiers on public.fx_positions;
create policy fx_positions_select_all_tiers on public.fx_positions
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists fx_positions_insert_enter on public.fx_positions;
create policy fx_positions_insert_enter on public.fx_positions
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists fx_positions_update_enter on public.fx_positions;
create policy fx_positions_update_enter on public.fx_positions
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists fx_positions_delete_manage on public.fx_positions;
create policy fx_positions_delete_manage on public.fx_positions
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);
