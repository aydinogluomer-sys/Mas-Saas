-- Faz 21 — cancellation / reversal records.
--
-- WHY A RECORD AND NOT JUST A STATUS. implementation.md is explicit: cancellation is "bağlı bir
-- reversal kaydı", not a silent status change. The difference matters because
-- `invoices.status = 'cancelled'` answers only "is it void"; it cannot answer who voided it,
-- when, why, or — critically — WHAT IT SAID at the moment it was voided. Once the row's status
-- flips, the invoice is frozen but its history is not self-describing.
--
-- So a cancellation writes a row here carrying a frozen JSON snapshot of the invoice and its
-- lines. 0026 supplies the cancellation FIELDS on the invoice (bidirectional consistency,
-- non-blank reason); 0022 supplies the APPEND-ONLY construction for the record itself; 0024
-- supplies the immutability posture. All three reused, no fourth mechanism invented.
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

create table if not exists public.invoice_reversals (
  id uuid primary key default gen_random_uuid(),

  -- DELIBERATELY NOT A FOREIGN KEY — the same decision, for the same reason, as 0037's
  -- iban_change_events.iban_id: this row is evidence, and evidence must outlive the thing it
  -- describes.
  --
  -- The first draft of this migration DID declare `references public.invoices(id) on delete
  -- restrict`, and `pnpm import:real` failed on it immediately. `scripts/import-real.ts` runs
  -- `truncate public.source_workbooks cascade`, invoices carry a source_workbook_id lineage
  -- column, and TRUNCATE CASCADE follows every referencing FK regardless of its ON DELETE
  -- action — so the cascade reached this table and the append-only trigger aborted a
  -- legitimate development reset. A guard drawn wide enough to break normal operation is the
  -- 0027 failure in a different costume.
  --
  -- Dropping the FK fixes that as a side effect, but it is the right shape independently: any
  -- table that can cascade into an append-only evidence table can destroy the evidence, which
  -- is exactly what an audit record exists to prevent. Referential integrity is maintained
  -- where it belongs instead — the engine resolves and locks the invoice before writing, and
  -- the deferred trigger at the bottom of this file refuses a cancelled invoice that has no
  -- reversal row.
  invoice_id uuid not null,

  reversal_type text not null check (reversal_type in ('cancellation', 'credit_note')),
  reason text not null check (btrim(reason) <> ''),

  -- What was reversed, in money, at the time. Stored rather than derived: the invoice's own
  -- amounts are frozen once issued, but a credit note may reverse only part of it.
  reversed_amount numeric(14,2) not null check (reversed_amount >= 0),

  -- The frozen copy. jsonb rather than a set of mirrored columns, because the point is to keep
  -- whatever the invoice said — including columns added to invoices in later phases — without
  -- this table needing to be migrated in lockstep. Same reasoning as 0037's to_jsonb(row)
  -- change recorder.
  snapshot jsonb not null,

  -- A credit note is itself an invoice; a plain cancellation is not. Nullable, and only
  -- meaningful for reversal_type='credit_note'. Not an FK either, for the same cascade reason
  -- as invoice_id above.
  credit_note_invoice_id uuid,
  constraint invoice_reversals_credit_note_link check (
    reversal_type = 'credit_note' or credit_note_invoice_id is null
  ),

  created_by uuid references public.users(id),
  created_at timestamptz not null default now()
);

-- At most ONE cancellation per invoice. Credit notes may be many (a partial refund, then
-- another), so the uniqueness is scoped to the cancellation type rather than the invoice.
create unique index if not exists invoice_reversals_one_cancellation
  on public.invoice_reversals (invoice_id) where reversal_type = 'cancellation';
create index if not exists invoice_reversals_invoice_idx
  on public.invoice_reversals (invoice_id, created_at desc);

-- ── append-only, superuser included (0022's construction) ──────────────────────────────────
-- The REVOKE is defence in depth; the triggers are what actually enforce it. A reversal record
-- that can be edited or deleted is not evidence of anything.
alter table public.invoice_reversals enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='invoice_reversals'
      and policyname='invoice_reversals_authenticated_all'
  ) then
    create policy invoice_reversals_authenticated_all on public.invoice_reversals
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert on public.invoice_reversals to authenticated;
revoke update, delete, truncate on public.invoice_reversals from public;
do $$
declare r record;
begin
  for r in
    select distinct grantee
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'invoice_reversals'
      and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
      and grantee <> current_user
  loop
    execute format('revoke update, delete, truncate on public.invoice_reversals from %I', r.grantee);
  end loop;
end $$;

create or replace function public.invoice_reversals_block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'invoice_reversals salt-ekleme (append-only): % engellendi.', tg_op;
end;
$$;

drop trigger if exists invoice_reversals_no_update on public.invoice_reversals;
create trigger invoice_reversals_no_update before update on public.invoice_reversals
  for each row execute function public.invoice_reversals_block_mutation();

drop trigger if exists invoice_reversals_no_delete on public.invoice_reversals;
create trigger invoice_reversals_no_delete before delete on public.invoice_reversals
  for each row execute function public.invoice_reversals_block_mutation();

drop trigger if exists invoice_reversals_no_truncate on public.invoice_reversals;
create trigger invoice_reversals_no_truncate before truncate on public.invoice_reversals
  for each statement execute function public.invoice_reversals_block_mutation();

-- ── a cancelled invoice MUST carry its reversal record ─────────────────────────────────────
--
-- Without this the whole design is advisory: an operator (or a future code path) could set
-- status='cancelled' directly and satisfy 0044's cancellation-fields CHECK while leaving no
-- record behind — exactly the "silent status change" the plan rules out. A CHECK constraint
-- cannot express this because it spans two tables, so it is a constraint trigger, DEFERRABLE
-- INITIALLY DEFERRED so the engine can write the invoice and its reversal in either order
-- within one transaction and be judged on the committed state.
create or replace function public.invoices_require_reversal_record() returns trigger
language plpgsql as $$
begin
  if new.status = 'cancelled'
     and not exists (
       select 1 from public.invoice_reversals r
       where r.invoice_id = new.id and r.reversal_type = 'cancellation'
     ) then
    raise exception
      'invoices.%: iptal, bağlı bir reversal kaydı olmadan tamamlanamaz (sessiz durum değişimi yasak).',
      new.id;
  end if;
  return null;
end $$;

drop trigger if exists invoices_require_reversal_record on public.invoices;
create constraint trigger invoices_require_reversal_record
  after insert or update of status on public.invoices
  deferrable initially deferred
  for each row execute function public.invoices_require_reversal_record();
