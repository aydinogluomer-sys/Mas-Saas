-- Faz 19 — counterparty (cari hesap) detail, as a 1:1 SIDECAR of public.parties.
--
-- WHY A SEPARATE TABLE INSTEAD OF NEW COLUMNS ON parties. The FK graph was introspected
-- against a freshly migrated database before this was written, not guessed from the plan:
-- EIGHT foreign keys in SIX tables point at parties.id —
--   cash_accounts.provider_party_id   cashflow_lines.party_id
--   checks.payee_party_id             checks.payer_party_id      checks.bank_party_id
--   loans.lender_party_id             payments.owner_party_id    payments.provider_party_id
-- (the plan named only three of them). parties is therefore the most-referenced table in the
-- schema and the riskiest one to reshape. Nothing here alters, renames, or re-keys it: this
-- table hangs off it, so every existing FK keeps pointing at exactly the same rows.
--
-- 1:1 is enforced structurally, not by a unique index bolted on afterwards: party_id IS the
-- primary key. A party can have zero or one profile and there is no way to express a second.
--
-- ON DELETE CASCADE is correct here and is NOT a loosening of anything. Every one of the eight
-- FKs above is NO ACTION, so a party that is referenced by any financial record cannot be
-- deleted at all; the cascade only ever fires for a party with no financial history, where
-- leaving an orphan profile behind would be the wrong outcome.
--
-- Idempotent throughout (if not exists / drop trigger if exists / policy-existence check),
-- per LEDGER_EMPTY_RECOVERY.
--
-- NO LIFECYCLE COLUMN. There is deliberately no `status` enum on this table (or on any table
-- added in Faz 19). implementation.md §17 rule 3 requires a status-transition guard, complete
-- on day one, for every new entity that has a lifecycle — the rule exists because 0027 shipped
-- three incomplete allow-lists and left 7/7 checks and 48/48 installments stuck in 'planned'
-- for eight migrations. The safest way to honour that rule in a phase that does not yet need
-- a lifecycle is to not invent one. `is_active` is a boolean, not a state machine.

create table if not exists public.counterparty_profiles (
  party_id uuid primary key references public.parties(id) on delete cascade,

  -- Turkish tax identity. Neither is validated by format: a VKN is 10 digits and a TCKN 11,
  -- but source workbooks legitimately carry foreign counterparties, blanks, and typos that
  -- the import must PRESERVE and FLAG rather than reject (CLAUDE.md: flag, never fix).
  -- Only emptiness is refused, because a blank string pretending to be a tax number is worse
  -- than an honest null.
  tax_number text check (tax_number is null or btrim(tax_number) <> ''),
  tax_office text check (tax_office is null or btrim(tax_office) <> ''),

  address_line text check (address_line is null or btrim(address_line) <> ''),
  city text check (city is null or btrim(city) <> ''),
  country_code text not null default 'TR' check (country_code ~ '^[A-Z]{2}$'),

  -- Credit limit is an agreed ceiling, so it may be zero ("cash only") but never negative.
  -- null = no limit recorded, which is NOT the same as a limit of zero — the distinction
  -- CLAUDE.md draws for every money column in this schema.
  credit_limit numeric(14,2) check (credit_limit is null or credit_limit >= 0),
  credit_limit_currency text not null default 'TRY' check (credit_limit_currency ~ '^[A-Z]{3}$'),
  payment_terms_days int check (payment_terms_days is null or payment_terms_days >= 0),

  contact_name text check (contact_name is null or btrim(contact_name) <> ''),
  contact_email text check (contact_email is null or btrim(contact_email) <> ''),
  contact_phone text check (contact_phone is null or btrim(contact_phone) <> ''),

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists counterparty_profiles_updated_at on public.counterparty_profiles;
create trigger counterparty_profiles_updated_at before update on public.counterparty_profiles
  for each row execute function public.set_updated_at();

-- Not unique: two party rows may legitimately share a tax number, because parties is unique on
-- (normalized_name, party_type) and the same firm can therefore exist once as 'customer' and
-- once as 'vendor'. A shared tax number across parties is a data-quality SIGNAL to surface,
-- not an invariant to enforce — enforcing it here would make a real, correct import fail.
create index if not exists counterparty_profiles_tax_number_idx
  on public.counterparty_profiles (tax_number) where tax_number is not null;

-- Faz 15's mas_radar_app is a member of `authenticated`, so 0007's blanket model applies here
-- too. Written explicitly rather than relying on 0035's ALTER DEFAULT PRIVILEGES: the grant
-- covers privileges, and a table with privileges but RLS never enabled is exactly the gap
-- docs/database-schema.md records for the 11 tables added after 0007's loop ran.
alter table public.counterparty_profiles enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'counterparty_profiles'
      and policyname = 'counterparty_profiles_authenticated_all'
  ) then
    create policy counterparty_profiles_authenticated_all on public.counterparty_profiles
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.counterparty_profiles to authenticated;
