-- Faz 20 — the bank account model.
--
-- THE ARCHITECTURE DECISION implementation.md left open ("add IBAN/branch/available/blocked/
-- overdraft columns to cash_accounts, OR a separate bank_accounts table") is settled here as a
-- SEPARATE 1:1 SIDECAR, and the deciding evidence is what is actually in the table today:
--
--   name             account_type
--   ---------------- --------------
--   Deniz            bank_account
--   HESAP Halk       bank_account
--   Kasa             cash            <- a cash box. No IBAN, no branch, no overdraft.
--   Vinov            check_account
--   Halk Business    credit_card     <- no IBAN, no branch
--   Halk KK - Paraf  credit_card     <- no IBAN, no branch
--
-- Only TWO of six rows are bank accounts. Widening cash_accounts would add five columns that
-- are permanently null and meaningless for two thirds of the rows, and would quietly redefine
-- what the table means — docs/database-schema.md describes cash_accounts as the general-ledger
-- cash position ("Genel defter hesabı, IBAN/şube-farkında değil"), which is exactly right and
-- is what cashflow_lines, payments, payment_instances and checks all depend on.
--
-- Four foreign keys point at cash_accounts (payments.cash_account_id,
-- payment_instances.paid_from_account_id, cashflow_lines.account_id, checks.account_id).
-- Faz 19 set the precedent for this situation and it applies unchanged: hang the detail off the
-- referenced table, do not reshape it.
--
-- cash_account_id IS the primary key, so a bank account is not a second identity for the same
-- money — it is the banking detail OF a cash account. There is no way to express two bank
-- profiles for one account, and no way to have a bank account that the cash position does not
-- already know about.
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

create table if not exists public.bank_accounts (
  cash_account_id uuid primary key references public.cash_accounts(id) on delete cascade,

  iban text check (iban is null or btrim(iban) <> ''),
  -- Same generated-column technique as 0037's counterparty IBANs, and it must stay identical
  -- to src/lib/counterparties/rules.ts's normalizeIban().
  iban_normalized text generated always as (upper(regexp_replace(coalesce(iban, ''), '\s', '', 'g'))) stored,

  bank_name text check (bank_name is null or btrim(bank_name) <> ''),
  branch_code text check (branch_code is null or btrim(branch_code) <> ''),
  branch_name text check (branch_name is null or btrim(branch_name) <> ''),
  account_number text check (account_number is null or btrim(account_number) <> ''),
  swift_bic text check (swift_bic is null or btrim(swift_bic) <> ''),

  -- Balances the BANK reports, distinct from any balance this application computes. Nullable
  -- because "not imported yet" is a real state and must not read as zero.
  available_balance numeric(14,2),
  blocked_balance numeric(14,2) check (blocked_balance is null or blocked_balance >= 0),
  -- KMH (kredili mevduat hesabı). Zero is a real value ("no overdraft facility"); null means
  -- "not recorded". Never negative.
  overdraft_limit numeric(14,2) check (overdraft_limit is null or overdraft_limit >= 0),
  balance_as_of timestamptz,
  last_statement_date date,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- GLOBALLY unique, and this is a deliberate CONTRAST with 0037's counterparty IBANs.
--
-- 0037 scopes IBAN uniqueness to the party, because `parties` is unique on
-- (normalized_name, party_type) and one real firm can legitimately appear twice — so the same
-- counterparty account can honestly appear under two rows. That reasoning does not transfer:
-- these are MAS's OWN accounts. One IBAN is one account, full stop, and two cash_accounts
-- claiming the same IBAN is a data error that would split one account's statement in two.
create unique index if not exists bank_accounts_iban_uq
  on public.bank_accounts (iban_normalized) where iban is not null;

drop trigger if exists bank_accounts_updated_at on public.bank_accounts;
create trigger bank_accounts_updated_at before update on public.bank_accounts
  for each row execute function public.set_updated_at();

alter table public.bank_accounts enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='bank_accounts' and policyname='bank_accounts_authenticated_all'
  ) then
    create policy bank_accounts_authenticated_all on public.bank_accounts
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.bank_accounts to authenticated;
