-- Faz 20 — teach the staging layer that a sheet can be a bank statement.
--
-- source_sheets.detected_type is a CHECK enum (0001) whose members mirror
-- src/lib/importers/workbook-parser.ts's SheetDetectedType union exactly — the file says so in
-- its header: "Types mirror the source_sheets.detected_type / parse_confidence DB enums defined
-- in implementation.md §8 exactly. Do not drift."
--
-- So adding a statement importer is not purely application work: the TypeScript union and this
-- CHECK have to move together or the first import fails at the INSERT. This migration is that
-- half. It is deliberately its own file rather than being buried in 0042, because a constraint
-- change to an existing, populated staging table deserves to be visible in the ledger on its own.
--
-- Nothing else about the staging layer changes: bank statements flow through the SAME
-- source_workbooks → source_sheets → source_cells → import_rows path as every other workbook
-- (implementation.md's rule that the importer never writes domain tables still holds), and
-- 0042's bank_transactions carry the source_row_id lineage forward exactly like checks and
-- loans already do.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.source_sheets'::regclass and conname = 'source_sheets_detected_type_check'
  ) then
    alter table public.source_sheets drop constraint source_sheets_detected_type_check;
  end if;

  alter table public.source_sheets
    add constraint source_sheets_detected_type_check check (detected_type in (
      'loan_calculation', 'capacity', 'machine_roi', 'payment_day_matrix', 'checks',
      'cost_model_normal', 'cost_model_overtime', 'monthly_cashflow',
      'bank_statement',
      'unknown'
    ));
end $$;

-- Drop-and-recreate rather than ADD ... NOT VALID: this widens the accepted set, so every
-- existing row already satisfies the new constraint by construction (the old members are all
-- still members). There is nothing to validate later and no grandfathered violation, which is
-- why the usual "add NOT VALID, VALIDATE in a separate slice" rule (0023/0026 → 0029/0030)
-- does not apply here. A narrowing change would need that treatment; a widening one does not.
