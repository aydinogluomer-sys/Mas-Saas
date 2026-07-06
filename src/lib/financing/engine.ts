// Phase 5 financing engine. Maps accepted ÇEKLER → checks and faiz hesaplama →
// loans + loan_installments, then exposes maturity/debt-service loaders.
// Eligibility mirrors Phase 3 (docs/calculation-rules §Review-status):
//   any linked review ∈ {open, rejected} → EXCLUDED (human must accept/resolve first).
// Invariants: null stays null; signed→direction preserved; validators FLAG not fix;
// reconciliation divergence raises a review but SOURCE VALUES WIN (never adjusted).

import type { Pool, PoolClient } from "pg";
import {
  extractChecks,
  extractLoan,
  type LoanCandidate,
} from "@/lib/importers/extractors";
import type { RowJson, SheetRow } from "@/lib/importers/row-utils";
import { normalizeTr } from "@/lib/importers/workbook-parser";
import {
  reconcileLoan,
  scheduleDueDates,
  type MaturityItem,
} from "./rules";

async function audit(
  client: PoolClient,
  action: string,
  entityTable: string,
  entityId: string | null,
  after: unknown,
): Promise<void> {
  await client.query(
    `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
     values (null,$1,$2,$3,null,$4)`,
    [action, entityTable, entityId, JSON.stringify(after ?? null)],
  );
}

/** Resolve a label to an existing party id by TR-normalized name. Never creates
 *  parties silently (source-of-truth rule; mirrors Phase 4); unresolved stays null
 *  but the raw label + source_row keep full traceability. */
async function partyIdByName(
  client: PoolClient,
  label: string | null,
  partyType?: string,
): Promise<string | null> {
  if (!label) return null;
  const norm = normalizeTr(label);
  const r = await client.query<{ id: string }>(
    partyType
      ? `select id from public.parties where normalized_name=$1 and party_type=$2 limit 1`
      : `select id from public.parties where normalized_name=$1 limit 1`,
    partyType ? [norm, partyType] : [norm],
  );
  return r.rows[0]?.id ?? null;
}

/** Bank tokens (HALK/DENİZ/VİNOV) come from the extractor already ASCII-uppercased;
 *  Turkish normalizeTr would corrupt the round-tripped "I" (DENIZ→denız ≠ deniz),
 *  so match banks by plain ASCII lowercase, which the seed uses verbatim. */
async function bankPartyId(client: PoolClient, bank: string | null): Promise<string | null> {
  if (!bank) return null;
  const r = await client.query<{ id: string }>(
    `select id from public.parties where normalized_name=$1 and party_type='bank' limit 1`,
    [bank.toLowerCase()],
  );
  return r.rows[0]?.id ?? null;
}

/* ── 1) accepted ÇEKLER rows → checks ── */

export interface ChecksMapResult {
  eligible: number;
  created: number;
  skippedAlreadyMapped: number;
  excluded: Array<{ rowIndex: number; reason: string }>;
}

export async function mapAcceptedChecks(pool: Pool, workbookId: string): Promise<ChecksMapResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sheets = await client.query(
      `select id, sheet_name from public.source_sheets
       where workbook_id=$1 and detected_type='checks'`,
      [workbookId],
    );
    const result: ChecksMapResult = { eligible: 0, created: 0, skippedAlreadyMapped: 0, excluded: [] };

    for (const sheet of sheets.rows) {
      const rowsRes = await client.query<{
        id: string;
        row_index: number;
        row_json: RowJson;
        mapping_status: string;
        blocked: boolean;
      }>(
        `select ir.id, ir.row_index, ir.row_json, ir.mapping_status,
                exists (select 1 from public.mapping_reviews mr
                        where mr.import_row_id = ir.id and mr.status in ('open','rejected')) as blocked
         from public.import_rows ir where ir.sheet_id=$1 order by ir.row_index`,
        [sheet.id],
      );
      const sheetRows: SheetRow[] = rowsRes.rows.map((r) => ({ rowIndex: r.row_index, cells: r.row_json }));
      const { candidates } = extractChecks(sheetRows);
      const byIndex = new Map(rowsRes.rows.map((r) => [r.row_index, r]));

      for (const c of candidates) {
        const row = byIndex.get(c.rowIndex);
        if (!row) continue;
        if (!c.maturityDate) {
          result.excluded.push({ rowIndex: c.rowIndex, reason: "vade tarihi çözülemedi (not-null)" });
          continue;
        }
        if (row.blocked) {
          // duplicate_check / unparsed_row open ⇒ waits for human (import both in staging, not ledger)
          result.excluded.push({ rowIndex: c.rowIndex, reason: "açık/ret inceleme" });
          continue;
        }
        result.eligible++;
        if (row.mapping_status === "mapped") {
          result.skippedAlreadyMapped++;
          continue;
        }
        const amount = c.signedAmount == null ? null : Math.abs(c.signedAmount);
        const bankId = await bankPartyId(client, c.bank);
        const payeeId = await partyIdByName(client, c.payee);
        const payerId = await partyIdByName(client, c.payer);
        const counterpartyLabel = c.payee ?? c.payer ?? null; // raw name preserved
        const ins = await client.query(
          `insert into public.checks
             (source_workbook_id, source_sheet_id, source_row_id, maturity_date, serial_no,
              payee_party_id, payer_party_id, bank_party_id, counterparty_label,
              amount, signed_amount, direction, status, notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'planned',$13)
           on conflict (source_row_id) where source_row_id is not null do nothing
           returning id`,
          [
            workbookId, sheet.id, row.id, c.maturityDate, c.serial,
            payeeId, payerId, bankId, counterpartyLabel,
            amount, c.signedAmount, c.direction,
            c.flags.length ? `flags: ${c.flags.join(",")}` : null,
          ],
        );
        if (ins.rowCount === 0) {
          result.skippedAlreadyMapped++;
          continue;
        }
        const checkId: string = ins.rows[0].id;
        await client.query(
          `insert into public.check_events (check_id, event_type, event_note)
           values ($1,'created',$2)`,
          [checkId, `import satır ${c.rowIndex}`],
        );
        await client.query(
          `update public.import_rows set mapping_status='mapped',
             mapped_entity_table='checks', mapped_entity_id=$2 where id=$1`,
          [row.id, checkId],
        );
        await audit(client, "map_check", "checks", checkId, {
          maturity: c.maturityDate, amount, direction: c.direction, bank: c.bank, source_row_id: row.id,
        });
        result.created++;
      }
    }
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 2) faiz hesaplama → loans + loan_installments ── */

export interface LoansMapResult {
  created: number;
  skippedExisting: number;
  installmentsCreated: number;
  reconciliationReviews: number;
  excluded: Array<{ sheet: string; reason: string }>;
}

export async function mapLoans(pool: Pool, workbookId: string): Promise<LoansMapResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sheets = await client.query(
      `select id, sheet_name from public.source_sheets
       where workbook_id=$1 and detected_type='loan_calculation'`,
      [workbookId],
    );
    const result: LoansMapResult = {
      created: 0, skippedExisting: 0, installmentsCreated: 0, reconciliationReviews: 0, excluded: [],
    };

    for (const sheet of sheets.rows) {
      const rowsRes = await client.query<{ id: string; row_index: number; row_json: RowJson }>(
        `select id, row_index, row_json from public.import_rows where sheet_id=$1 order by row_index`,
        [sheet.id],
      );
      const idByRow = new Map(rowsRes.rows.map((r) => [r.row_index, r.id]));
      const cellMap: Record<string, import("@/lib/importers/row-utils").CellVal> = {};
      for (const r of rowsRes.rows)
        for (const [col, cell] of Object.entries(r.row_json)) cellMap[`${col}${r.row_index}`] = cell;

      const { loan } = extractLoan(cellMap);

      const blocked = await client.query<{ n: number }>(
        `select count(*)::int as n from public.mapping_reviews
         where sheet_id=$1 and status in ('open','rejected')`,
        [sheet.id],
      );
      if ((blocked.rows[0]?.n ?? 0) > 0) {
        result.excluded.push({ sheet: sheet.sheet_name, reason: "açık/ret inceleme" });
        continue;
      }
      if (loan.principal == null || loan.firstPaymentDate == null) {
        result.excluded.push({ sheet: sheet.sheet_name, reason: "anapara/ilk ödeme yok — kredi kurulamaz" });
        continue;
      }

      const lenderId = await partyIdByName(client, sheet.sheet_name, "bank"); // best-effort; usually null
      const ins = await client.query(
        `insert into public.loans
           (name, lender_party_id, source_workbook_id, source_sheet_id,
            principal, term_months, installment_count, first_payment_date,
            simple_interest_rate, applied_interest_rate, monthly_cost_rate, annual_cost_rate,
            bsmv_rate, kkdf_rate, installment_amount, total_payment, total_finance_cost, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active')
         on conflict (source_sheet_id) where source_sheet_id is not null do nothing
         returning id`,
        [
          `Kredi — ${sheet.sheet_name}`, lenderId, workbookId, sheet.id,
          loan.principal, loan.termMonths, loan.installments.length, loan.firstPaymentDate,
          loan.simpleRate, loan.appliedRate, loan.monthlyCostRate, loan.annualCostRate,
          loan.bsmvRate, loan.kkdfRate, loan.installmentAmount, loan.totalPayment, loan.totalFinanceCost,
        ],
      );
      if (ins.rowCount === 0) {
        result.skippedExisting++;
        continue;
      }
      const loanId: string = ins.rows[0].id;
      result.created++;

      const schedule = scheduleDueDates(loan.firstPaymentDate, loan.installments.length);
      for (const inst of loan.installments) {
        if (inst.amount == null) continue; // not-null constraint; would have been blocked upstream
        const sched = schedule[inst.no - 1];
        const r = await client.query(
          `insert into public.loan_installments
             (loan_id, installment_no, due_date, amount, principal_component, interest_component, tax_component, status)
           values ($1,$2,$3,$4,$5,$6,$7,'planned')
           on conflict (loan_id, installment_no) do nothing`,
          [
            loanId, inst.no, sched.dueDate, inst.amount, inst.principal, inst.interest,
            (inst.kkdf ?? 0) + (inst.bsmv ?? 0) || null,
          ],
        );
        result.installmentsCreated += r.rowCount ?? 0;
      }

      // reconciliation: FLAG divergence, source values already stored (they WIN)
      const recon = reconcileLoan({
        installmentSum: loan.installmentSum,
        totalPayment: loan.totalPayment,
        principal: loan.principal,
        financeCost: loan.totalFinanceCost,
      });
      if (!recon.ok) {
        const r = await client.query(
          `insert into public.mapping_reviews (workbook_id, sheet_id, issue_type, severity, message)
           select $1,$2,'loan_reconciliation','high',$3
           where not exists (select 1 from public.mapping_reviews
             where sheet_id=$2 and issue_type='loan_reconciliation' and status='open')`,
          [workbookId, sheet.id, recon.issues.map((i) => i.message).join(" · ")],
        );
        result.reconciliationReviews += r.rowCount ?? 0;
      }

      // mark header + amortization rows mapped (traceable)
      const mappedRows = [1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, ...loan.installments.map((i) => i.rowIndex)]
        .map((ri) => idByRow.get(ri))
        .filter((x): x is string => !!x);
      if (mappedRows.length > 0) {
        await client.query(
          `update public.import_rows set mapping_status='mapped',
             mapped_entity_table='loans', mapped_entity_id=$2
           where id = any($1::uuid[]) and mapping_status <> 'mapped'`,
          [mappedRows, loanId],
        );
      }
      await audit(client, "map_loan", "loans", loanId, {
        principal: loan.principal, installments: loan.installments.length,
        total_payment: loan.totalPayment, reconciled: recon.ok, sheet: sheet.sheet_name,
      });
    }
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 3) loaders ── */

export interface CheckRow {
  id: string;
  maturityDate: string;
  serial: string | null;
  amount: number | null;
  signedAmount: number | null;
  direction: "inflow" | "outflow" | "unknown";
  status: string;
  payee: string | null;
  payer: string | null;
  bank: string | null;
  sourceWorkbookId: string | null;
  sourceSheetId: string | null;
  rowIndex: number | null;
}

export async function loadChecks(pool: Pool): Promise<CheckRow[]> {
  const r = await pool.query(`
    select c.id, to_char(c.maturity_date,'YYYY-MM-DD') as maturity_date, c.serial_no as serial,
           c.amount::float8 as amount, c.signed_amount::float8 as signed_amount,
           c.direction, c.status,
           coalesce(pe.name, pa.name, c.counterparty_label) as payee, pa.name as payer, pb.name as bank,
           c.source_workbook_id, c.source_sheet_id, ir.row_index
    from public.checks c
    left join public.parties pe on pe.id=c.payee_party_id
    left join public.parties pa on pa.id=c.payer_party_id
    left join public.parties pb on pb.id=c.bank_party_id
    left join public.import_rows ir on ir.id=c.source_row_id
    order by c.maturity_date`);
  return r.rows.map((x) => ({
    id: x.id, maturityDate: x.maturity_date, serial: x.serial,
    amount: x.amount, signedAmount: x.signed_amount, direction: x.direction, status: x.status,
    payee: x.payee, payer: x.payer, bank: x.bank,
    sourceWorkbookId: x.source_workbook_id, sourceSheetId: x.source_sheet_id, rowIndex: x.row_index,
  }));
}

export interface LoanRow {
  id: string;
  name: string;
  principal: number | null;
  termMonths: number | null;
  installmentCount: number | null;
  firstPaymentDate: string | null;
  installmentAmount: number | null;
  totalPayment: number | null;
  totalFinanceCost: number | null;
  appliedRate: number | null;
  monthlyCostRate: number | null;
  installmentsLoaded: number;
  paidCount: number;
  remainingCount: number;
  remainingAmount: number | null;
  sourceWorkbookId: string | null;
  sourceSheetId: string | null;
}

export async function loadLoans(pool: Pool): Promise<LoanRow[]> {
  const r = await pool.query(`
    select l.id, l.name, l.principal::float8 as principal, l.term_months, l.installment_count,
           to_char(l.first_payment_date,'YYYY-MM-DD') as first_payment_date,
           l.installment_amount::float8 as installment_amount,
           l.total_payment::float8 as total_payment, l.total_finance_cost::float8 as total_finance_cost,
           l.applied_interest_rate::float8 as applied_rate, l.monthly_cost_rate::float8 as monthly_cost_rate,
           l.source_workbook_id, l.source_sheet_id,
           count(li.id)::int as installments_loaded,
           count(li.id) filter (where li.status='paid')::int as paid_count,
           count(li.id) filter (where li.status <> 'paid')::int as remaining_count,
           coalesce(sum(li.amount) filter (where li.status <> 'paid'),0)::float8 as remaining_amount
    from public.loans l
    left join public.loan_installments li on li.loan_id=l.id
    group by l.id
    order by l.first_payment_date nulls last`);
  return r.rows.map((x) => ({
    id: x.id, name: x.name, principal: x.principal, termMonths: x.term_months,
    installmentCount: x.installment_count, firstPaymentDate: x.first_payment_date,
    installmentAmount: x.installment_amount, totalPayment: x.total_payment,
    totalFinanceCost: x.total_finance_cost, appliedRate: x.applied_rate, monthlyCostRate: x.monthly_cost_rate,
    installmentsLoaded: x.installments_loaded, paidCount: x.paid_count,
    remainingCount: x.remaining_count, remainingAmount: x.remaining_amount,
    sourceWorkbookId: x.source_workbook_id, sourceSheetId: x.source_sheet_id,
  }));
}

export async function loadLoanInstallments(pool: Pool, loanId: string): Promise<Array<{
  id: string; no: number | null; dueDate: string; amount: number; principal: number | null;
  interest: number | null; tax: number | null; status: string;
}>> {
  const r = await pool.query(
    `select id, installment_no as no, to_char(due_date,'YYYY-MM-DD') as due_date,
            amount::float8 as amount, principal_component::float8 as principal,
            interest_component::float8 as interest, tax_component::float8 as tax, status
     from public.loan_installments where loan_id=$1 order by installment_no`,
    [loanId],
  );
  return r.rows.map((x) => ({
    id: x.id, no: x.no, dueDate: x.due_date, amount: x.amount,
    principal: x.principal, interest: x.interest, tax: x.tax, status: x.status,
  }));
}

/** Union of open checks + unpaid loan installments as a single maturity stream. */
export async function loadMaturityItems(pool: Pool): Promise<MaturityItem[]> {
  const checks = await pool.query(`
    select c.id, to_char(c.maturity_date,'YYYY-MM-DD') as due, c.amount::float8 as amount,
           c.direction, coalesce(pe.name, pa.name, c.counterparty_label, pb.name, 'çek') as label
    from public.checks c
    left join public.parties pe on pe.id=c.payee_party_id
    left join public.parties pa on pa.id=c.payer_party_id
    left join public.parties pb on pb.id=c.bank_party_id
    where c.status in ('planned','unknown')`);
  const inst = await pool.query(`
    select li.id, to_char(li.due_date,'YYYY-MM-DD') as due, li.amount::float8 as amount, l.name
    from public.loan_installments li join public.loans l on l.id=li.loan_id
    where li.status in ('planned','unpaid','partial','late')`);
  const items: MaturityItem[] = [];
  for (const c of checks.rows)
    items.push({
      id: `chk:${c.id}`, dueDate: c.due, amount: c.amount,
      direction: c.direction, kind: "check", label: c.label,
    });
  for (const i of inst.rows)
    items.push({
      id: `ins:${i.id}`, dueDate: i.due, amount: i.amount,
      direction: "outflow", kind: "loan_installment", label: i.name,
    });
  return items;
}

export type { LoanCandidate };
