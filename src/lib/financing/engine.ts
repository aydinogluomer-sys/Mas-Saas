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
import { DomainError } from "@/lib/domain-error";
import { safeSyncDomainEventWithClient } from "@/lib/ledger/posting-engine";
import { decimal, money, moneyOrNull, rateOrNull } from "@/lib/money";
import { audit } from "@/lib/audit";
import { executeCheckBordroTransition } from "./check-bordro";
import {
  consolidateCurrencyAmounts,
  loadLatestTryFxRateMap,
  type CurrencyBreakdownItem,
} from "./fx-consolidation";
import {
  addMonthsPreservingAnchorDay,
  reconcileLoan,
  scheduleDueDates,
  type MaturityItem,
  type ScheduledInstallment,
} from "./rules";

/** `before` is optional and trailing so every pre-existing call site keeps its exact
 * behaviour (before_data stays null). Settlement mutations pass it: for a status transition
 * the prior status IS the audit-relevant fact — "this check went planned -> cleared" is not
 * recoverable from the after-image alone once the row has moved on. */
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

export async function mapAcceptedChecks(pool: Pool, workbookId: string, actorId: string): Promise<ChecksMapResult> {
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
        resolved_duplicate: boolean;
      }>(
        `select ir.id, ir.row_index, ir.row_json, ir.mapping_status,
                exists (
                  select 1 from public.mapping_reviews mr
                   where mr.import_row_id = ir.id
                     and (
                       mr.status in ('open', 'rejected')
                       or (mr.issue_type = 'duplicate_check' and mr.status in ('open', 'rejected', 'resolved'))
                     )
                ) as blocked,
                exists (
                  select 1 from public.mapping_reviews mr
                   where mr.import_row_id = ir.id
                     and mr.issue_type = 'duplicate_check'
                     and mr.status = 'resolved'
                ) as resolved_duplicate
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
          // 5.C: duplicate_check only imports on explicit 'accepted'; 'resolved' marks it excluded.
          result.excluded.push({
            rowIndex: c.rowIndex,
            reason: row.resolved_duplicate
              ? "mükerrer çek dışlandı (resolved — yalnız accepted içeri alınır)"
              : "açık/ret inceleme",
          });
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
          `insert into public.check_events (check_id, event_type, event_note, created_by)
           values ($1,'created',$2,$3)`,
          [checkId, `import satır ${c.rowIndex}`, actorId],
        );
        await client.query(
          `update public.import_rows set mapping_status='mapped',
             mapped_entity_table='checks', mapped_entity_id=$2 where id=$1`,
          [row.id, checkId],
        );
        await audit(client, {
          actor: actorId, action: "map_check", entityTable: "checks", entityId: checkId,
          after: { maturity: c.maturityDate, amount, direction: c.direction, bank: c.bank, source_row_id: row.id },
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

export async function mapLoans(pool: Pool, workbookId: string, actorId: string): Promise<LoansMapResult> {
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
         on conflict (source_sheet_id) where source_sheet_id is not null and source_row_id is null do nothing
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

      const maxInstallmentNo = loan.installments.reduce(
        (maxNo, inst) => Math.max(maxNo, inst.no),
        loan.installments.length,
      );
      const schedule = scheduleDueDates(loan.firstPaymentDate, maxInstallmentNo);
      const scheduleByNo = new Map<number, ScheduledInstallment>(schedule.map((s) => [s.no, s]));
      for (const inst of loan.installments) {
        if (inst.amount == null) continue; // not-null constraint; would have been blocked upstream
        const sched = scheduleByNo.get(inst.no)
          ?? addMonthsPreservingAnchorDay(loan.firstPaymentDate, Math.max(0, inst.no - 1));
        const taxComponent = inst.kkdf == null && inst.bsmv == null
          ? null
          : money(decimal(inst.kkdf ?? 0).plus(decimal(inst.bsmv ?? 0)));
        const r = await client.query(
          `insert into public.loan_installments
             (loan_id, installment_no, due_date, amount, principal_component, interest_component, tax_component, status)
           values ($1,$2,$3,$4,$5,$6,$7,'planned')
           on conflict (loan_id, installment_no) do nothing`,
          [
            loanId, inst.no, sched.dueDate, inst.amount, inst.principal, inst.interest,
            taxComponent,
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
      await audit(client, {
        actor: actorId, action: "map_loan", entityTable: "loans", entityId: loanId,
        after: {
          principal: loan.principal, installments: loan.installments.length,
          total_payment: loan.totalPayment, reconciled: recon.ok, sheet: sheet.sheet_name,
        },
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
  instrumentType?: "check" | "promissory_note";
  amount: number | null;
  currency?: string;
  signedAmount: number | null;
  direction: "inflow" | "outflow" | "unknown";
  status: string;
  payee: string | null;
  payer: string | null;
  bank: string | null;
  endorsedTo?: string | null;
  collectionBank?: string | null;
  collateralFacility?: string | null;
  settledInvoiceNo?: string | null;
  lastBordroNo?: string | null;
  sourceWorkbookId: string | null;
  sourceSheetId: string | null;
  rowIndex: number | null;
}

export async function loadChecks(pool: Pool, options: { limit?: number; offset?: number } = {}): Promise<CheckRow[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100_000, 100_000));
  const offset = Math.max(0, options.offset ?? 0);
  let r;
  try {
    r = await pool.query(`
      select c.id, to_char(c.maturity_date,'YYYY-MM-DD') as maturity_date, c.serial_no as serial,
             c.instrument_type,
             c.amount, c.signed_amount, c.currency,
             c.direction, c.status,
             coalesce(pe.name, pa.name, c.counterparty_label) as payee, pa.name as payer, pb.name as bank,
             endp.name as endorsed_to,
             colca.name as collection_bank,
             cf.name as collateral_facility,
             inv.invoice_no as settled_invoice_no,
             cb.bordro_no as last_bordro_no,
             c.source_workbook_id, c.source_sheet_id, ir.row_index
      from public.checks c
      left join public.parties pe on pe.id=c.payee_party_id
      left join public.parties pa on pa.id=c.payer_party_id
      left join public.parties pb on pb.id=c.bank_party_id
      left join public.parties endp on endp.id=c.endorsed_to_party_id
      left join public.cash_accounts colca on colca.id=c.collection_bank_account_id
      left join public.credit_facilities cf on cf.id=c.collateral_facility_id
      left join public.invoices inv on inv.id=coalesce(c.settled_invoice_id, c.linked_invoice_id)
      left join public.check_bordros cb on cb.id=c.last_bordro_id
      left join public.import_rows ir on ir.id=c.source_row_id
      where c.archived_at is null
      order by c.maturity_date
      limit $1 offset $2`, [limit, offset]);
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode !== "42703" && pgCode !== "42P01") throw err;
    r = await pool.query(`
      select c.id, to_char(c.maturity_date,'YYYY-MM-DD') as maturity_date, c.serial_no as serial,
             'check'::text as instrument_type,
             c.amount, c.signed_amount, 'TRY'::text as currency,
             c.direction, c.status,
             coalesce(pe.name, pa.name, c.counterparty_label) as payee, pa.name as payer, pb.name as bank,
             null::text as endorsed_to,
             null::text as collection_bank,
             null::text as collateral_facility,
             null::text as settled_invoice_no,
             null::text as last_bordro_no,
             c.source_workbook_id, c.source_sheet_id, ir.row_index
      from public.checks c
      left join public.parties pe on pe.id=c.payee_party_id
      left join public.parties pa on pa.id=c.payer_party_id
      left join public.parties pb on pb.id=c.bank_party_id
      left join public.import_rows ir on ir.id=c.source_row_id
      where c.archived_at is null
      order by c.maturity_date
      limit $1 offset $2`, [limit, offset]);
  }
  return r.rows.map((x) => ({
    id: x.id,
    maturityDate: x.maturity_date,
    serial: x.serial,
    instrumentType: x.instrument_type === "promissory_note" ? "promissory_note" : "check",
    amount: moneyOrNull(x.amount),
    currency: String(x.currency ?? "TRY"),
    signedAmount: moneyOrNull(x.signed_amount),
    direction: x.direction,
    status: x.status,
    payee: x.payee,
    payer: x.payer,
    bank: x.bank,
    endorsedTo: x.endorsed_to ?? null,
    collectionBank: x.collection_bank ?? null,
    collateralFacility: x.collateral_facility ?? null,
    settledInvoiceNo: x.settled_invoice_no ?? null,
    lastBordroNo: x.last_bordro_no ?? null,
    sourceWorkbookId: x.source_workbook_id,
    sourceSheetId: x.source_sheet_id,
    rowIndex: x.row_index,
  }));
}

export async function countChecks(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `select count(*)::int as count from public.checks where archived_at is null`,
  );
  return result.rows[0]?.count ?? 0;
}

export interface LoanRow {
  id: string;
  name: string;
  principal: number | null;
  currency?: string;
  loanKind?: string;
  interestType?: string;
  bsmvRate?: number | null;
  kkdfRate?: number | null;
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

export async function loadLoans(pool: Pool | PoolClient): Promise<LoanRow[]> {
  let r;
  try {
    r = await pool.query(`
      select l.id, l.name, l.principal, l.currency, l.loan_kind, l.interest_type,
             l.bsmv_rate, l.kkdf_rate, l.term_months, l.installment_count,
             to_char(l.first_payment_date,'YYYY-MM-DD') as first_payment_date,
             l.installment_amount,
             l.total_payment, l.total_finance_cost,
             l.applied_interest_rate as applied_rate, l.monthly_cost_rate,
             l.source_workbook_id, l.source_sheet_id,
             count(li.id)::int as installments_loaded,
             count(li.id) filter (where li.status='paid')::int as paid_count,
             count(li.id) filter (where li.status not in ('paid','cancelled'))::int as remaining_count,
             coalesce(sum(greatest(li.amount - coalesce(li.paid_amount, 0), 0)) filter (where li.status not in ('paid','cancelled')),0) as remaining_amount
      from public.loans l
      left join public.loan_installments li on li.loan_id=l.id
      where l.archived_at is null
      group by l.id
      order by l.first_payment_date nulls last`);
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode !== "42703") throw err;
    r = await pool.query(`
      select l.id, l.name, l.principal, 'TRY'::text as currency, 'installment'::text as loan_kind,
             'fixed'::text as interest_type, null::numeric as bsmv_rate, null::numeric as kkdf_rate,
             l.term_months, l.installment_count,
             to_char(l.first_payment_date,'YYYY-MM-DD') as first_payment_date,
             l.installment_amount,
             l.total_payment, l.total_finance_cost,
             l.applied_interest_rate as applied_rate, l.monthly_cost_rate,
             l.source_workbook_id, l.source_sheet_id,
             count(li.id)::int as installments_loaded,
             count(li.id) filter (where li.status='paid')::int as paid_count,
             count(li.id) filter (where li.status not in ('paid','cancelled'))::int as remaining_count,
             coalesce(sum(li.amount) filter (where li.status not in ('paid','cancelled')),0) as remaining_amount
      from public.loans l
      left join public.loan_installments li on li.loan_id=l.id
      where l.archived_at is null
      group by l.id
      order by l.first_payment_date nulls last`);
  }
  return r.rows.map((x) => ({
    // The four TL figures decode at money scale; the two interest rates are numeric(8,4)
    // and decode at RATE_DP so their fourth decimal survives (reconcileLoan compares
    // total_payment − principal − finance_cost against a ±1 TL tolerance).
    id: x.id, name: x.name, principal: moneyOrNull(x.principal), currency: String(x.currency ?? "TRY"),
    loanKind: String(x.loan_kind ?? "installment"), interestType: String(x.interest_type ?? "fixed"),
    bsmvRate: rateOrNull(x.bsmv_rate), kkdfRate: rateOrNull(x.kkdf_rate),
    termMonths: x.term_months,
    installmentCount: x.installment_count, firstPaymentDate: x.first_payment_date,
    installmentAmount: moneyOrNull(x.installment_amount), totalPayment: moneyOrNull(x.total_payment),
    totalFinanceCost: moneyOrNull(x.total_finance_cost),
    appliedRate: rateOrNull(x.applied_rate), monthlyCostRate: rateOrNull(x.monthly_cost_rate),
    installmentsLoaded: x.installments_loaded, paidCount: x.paid_count,
    remainingCount: x.remaining_count, remainingAmount: moneyOrNull(x.remaining_amount),
    sourceWorkbookId: x.source_workbook_id, sourceSheetId: x.source_sheet_id,
  }));
}

export async function loadLoanInstallments(pool: Pool, loanId: string): Promise<Array<{
  id: string; no: number | null; dueDate: string; amount: number; principal: number | null;
  interest: number | null; tax: number | null; bsmv?: number | null; kkdf?: number | null; status: string;
}>> {
  let r;
  try {
    r = await pool.query(
      `select id, installment_no as no, to_char(due_date,'YYYY-MM-DD') as due_date,
              amount, principal_component as principal,
              interest_component as interest, tax_component as tax,
              bsmv_component as bsmv, kkdf_component as kkdf, status
       from public.loan_installments where loan_id=$1 order by installment_no`,
      [loanId],
    );
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode !== "42703") throw err;
    r = await pool.query(
      `select id, installment_no as no, to_char(due_date,'YYYY-MM-DD') as due_date,
              amount, principal_component as principal,
              interest_component as interest, tax_component as tax,
              null::numeric as bsmv, null::numeric as kkdf, status
       from public.loan_installments where loan_id=$1 order by installment_no`,
      [loanId],
    );
  }
  return r.rows.map((x) => ({
    id: x.id, no: x.no, dueDate: x.due_date, amount: moneyOrNull(x.amount) ?? 0,
    principal: moneyOrNull(x.principal), interest: moneyOrNull(x.interest),
    tax: moneyOrNull(x.tax), bsmv: moneyOrNull(x.bsmv), kkdf: moneyOrNull(x.kkdf), status: x.status,
  }));
}

/** Union of open checks + unpaid loan installments as a single maturity stream. */
export async function loadMaturityItems(pool: Pool | PoolClient): Promise<MaturityItem[]> {
  let checks;
  let inst;
  try {
    checks = await pool.query(`
      select c.id, to_char(c.maturity_date,'YYYY-MM-DD') as due, c.amount, coalesce(c.currency, 'TRY') as currency,
             c.direction, coalesce(pe.name, pa.name, c.counterparty_label, pb.name, 'çek') as label
      from public.checks c
      left join public.parties pe on pe.id=c.payee_party_id
      left join public.parties pa on pa.id=c.payer_party_id
      left join public.parties pb on pb.id=c.bank_party_id
      where c.status in ('planned','unknown','in_portfolio','in_bank_collection','in_bank_collateral','issued_to_vendor') and c.archived_at is null`);
    inst = await pool.query(`
      select li.id, to_char(li.due_date,'YYYY-MM-DD') as due, li.amount, coalesce(l.currency, 'TRY') as currency, l.name
      from public.loan_installments li join public.loans l on l.id=li.loan_id
      where li.status in ('planned','unpaid','partial','late') and l.archived_at is null`);
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode !== "42703") throw err;
    checks = await pool.query(`
      select c.id, to_char(c.maturity_date,'YYYY-MM-DD') as due, c.amount, 'TRY'::text as currency,
             c.direction, coalesce(pe.name, pa.name, c.counterparty_label, pb.name, 'çek') as label
      from public.checks c
      left join public.parties pe on pe.id=c.payee_party_id
      left join public.parties pa on pa.id=c.payer_party_id
      left join public.parties pb on pb.id=c.bank_party_id
      where c.status in ('planned','unknown','in_portfolio','in_bank_collection','in_bank_collateral','issued_to_vendor') and c.archived_at is null`);
    inst = await pool.query(`
      select li.id, to_char(li.due_date,'YYYY-MM-DD') as due, li.amount, 'TRY'::text as currency, l.name
      from public.loan_installments li join public.loans l on l.id=li.loan_id
      where li.status in ('planned','unpaid','partial','late') and l.archived_at is null`);
  }
  const items: MaturityItem[] = [];
  for (const c of checks.rows)
    items.push({
      id: `chk:${c.id}`, dueDate: c.due, amount: moneyOrNull(c.amount),
      currency: String(c.currency ?? "TRY"),
      direction: c.direction, kind: "check", label: c.label,
    });
  for (const i of inst.rows)
    items.push({
      id: `ins:${i.id}`, dueDate: i.due, amount: moneyOrNull(i.amount),
      currency: String(i.currency ?? "TRY"),
      direction: "outflow", kind: "loan_installment", label: i.name,
    });
  return items;
}

export interface FinanceDashboardSummary {
  remainingAmount: number;
  due30: number;
  remainingConsolidatedTry: number;
  due30ConsolidatedTry: number;
  remainingByCurrency: CurrencyBreakdownItem[];
  due30ByCurrency: CurrencyBreakdownItem[];
  missingFxCurrencies: string[];
  openChecks: number;
  activeLoans: number;
}

export interface FinanceDashboardMonth {
  monthStart: string;
  kind: "check" | "loan_installment";
  direction: "inflow" | "outflow" | "unknown";
  count: number;
  knownAmount: number;
  byCurrency?: CurrencyBreakdownItem[];
  missingFxCount?: number;
  missingCount: number;
}

export async function loadFinanceDashboard(
  pool: Pool,
  todayISO: string,
): Promise<{ summary: FinanceDashboardSummary; months: FinanceDashboardMonth[] }> {
  const stream = `
    select c.maturity_date as due_date, c.amount, coalesce(c.currency, 'TRY') as currency,
           c.direction::text as direction, 'check'::text as kind
    from public.checks c
    where c.status in ('planned','unknown','in_portfolio','in_bank_collection','in_bank_collateral','issued_to_vendor') and c.archived_at is null
    union all
    select li.due_date,
           greatest(li.amount - coalesce(li.paid_amount, 0), 0) as amount,
           coalesce(l.currency, 'TRY') as currency,
           'outflow'::text, 'loan_installment'::text
    from public.loan_installments li
    join public.loans l on l.id=li.loan_id
    where li.status in ('planned','unpaid','partial','late') and l.archived_at is null`;

  const [countsRes, remCurrRes, due30CurrRes, monthCurrRes, fxMap] = await Promise.all([
    pool.query(`
      select
        (select count(*)::int from public.checks
          where status in ('planned','unknown','in_portfolio','in_bank_collection','in_bank_collateral','issued_to_vendor') and archived_at is null) as open_checks,
        (select count(*)::int from public.loans where archived_at is null) as active_loans`),
    pool.query(`
      select coalesce(l.currency, 'TRY') as currency,
             coalesce(sum(greatest(li.amount - coalesce(li.paid_amount, 0), 0)), 0)::text as amt
      from public.loan_installments li
      join public.loans l on l.id = li.loan_id
      where li.status <> 'paid' and li.status <> 'cancelled' and l.archived_at is null
      group by coalesce(l.currency, 'TRY')`),
    pool.query(`
      with maturity as (${stream})
      select currency, coalesce(sum(amount), 0)::text as amt
      from maturity
      where due_date >= $1::date and due_date < $1::date + 30
        and direction = 'outflow' and amount is not null
      group by currency`, [todayISO]),
    pool.query(`
      with maturity as (${stream})
      select to_char(date_trunc('month',due_date),'YYYY-MM-01') as month_start,
             kind, direction, currency,
             count(*)::int as event_count,
             coalesce(sum(amount) filter (where amount is not null),0)::text as known_amount,
             count(*) filter (where amount is null)::int as missing_count
      from maturity
      where due_date >= $1::date and due_date < ($1::date + interval '24 months')
      group by date_trunc('month',due_date), kind, direction, currency
      order by date_trunc('month',due_date), kind, direction, currency`, [todayISO]),
    loadLatestTryFxRateMap(pool, todayISO),
  ]);

  const remCons = consolidateCurrencyAmounts(
    remCurrRes.rows.map((r) => ({ currency: String(r.currency ?? "TRY"), amount: r.amt })),
    fxMap,
  );
  const due30Cons = consolidateCurrencyAmounts(
    due30CurrRes.rows.map((r) => ({ currency: String(r.currency ?? "TRY"), amount: r.amt })),
    fxMap,
  );

  const monthGroups = new Map<
    string,
    {
      monthStart: string;
      kind: FinanceDashboardMonth["kind"];
      direction: FinanceDashboardMonth["direction"];
      count: number;
      missingCount: number;
      currencyInputs: Array<{ currency: string; amount: string }>;
    }
  >();

  for (const row of monthCurrRes.rows) {
    const key = `${row.month_start}|${row.kind}|${row.direction}`;
    let g = monthGroups.get(key);
    if (!g) {
      g = {
        monthStart: row.month_start as string,
        kind: row.kind as FinanceDashboardMonth["kind"],
        direction: row.direction as FinanceDashboardMonth["direction"],
        count: 0,
        missingCount: 0,
        currencyInputs: [],
      };
      monthGroups.set(key, g);
    }
    g.count += Number(row.event_count ?? 0);
    g.missingCount += Number(row.missing_count ?? 0);
    g.currencyInputs.push({
      currency: String(row.currency ?? "TRY"),
      amount: String(row.known_amount ?? "0"),
    });
  }

  const allMissingFx = new Set<string>([
    ...remCons.missingFxCurrencies,
    ...due30Cons.missingFxCurrencies,
  ]);

  const months: FinanceDashboardMonth[] = [];
  for (const g of monthGroups.values()) {
    const mc = consolidateCurrencyAmounts(g.currencyInputs, fxMap);
    for (const m of mc.missingFxCurrencies) allMissingFx.add(m);
    months.push({
      monthStart: g.monthStart,
      kind: g.kind,
      direction: g.direction,
      count: g.count,
      knownAmount: mc.consolidatedTry,
      byCurrency: mc.byCurrency,
      missingFxCount: mc.missingFxCurrencies.length,
      missingCount: g.missingCount,
    });
  }

  const countRow = countsRes.rows[0] ?? {};
  const pureTryRemaining = remCons.byCurrency.find((c) => c.currency === "TRY")?.nativeAmount ?? 0;
  const pureTryDue30 = due30Cons.byCurrency.find((c) => c.currency === "TRY")?.nativeAmount ?? 0;
  return {
    summary: {
      remainingAmount: pureTryRemaining,
      due30: pureTryDue30,
      remainingConsolidatedTry: remCons.consolidatedTry,
      due30ConsolidatedTry: due30Cons.consolidatedTry,
      remainingByCurrency: remCons.byCurrency,
      due30ByCurrency: due30Cons.byCurrency,
      missingFxCurrencies: [...allMissingFx],
      openChecks: Number(countRow.open_checks ?? 0),
      activeLoans: Number(countRow.active_loans ?? 0),
    },
    months,
  };
}

/* ── 4) settlement — recording the outcome a check or installment actually reached ──
   Mirrors the cancellation functions below exactly (transaction, `for update` row lock,
   allow-list Set + DomainError guard, audit, commit/rollback/finally). The Sets here must
   stay in sync with 0034's trigger allow-lists: the DB is the real authority, and these
   guards exist so a wrong source status fails as a clean domain error the UI can show
   instead of a raw Postgres trigger message. */

export const CHECK_SETTLEABLE_FROM = new Set([
  "planned",
  "in_portfolio",
  "endorsed_to_vendor",
  "in_bank_collection",
  "in_bank_collateral",
  "issued_to_vendor",
]);
const LOAN_INSTALLMENT_PAYABLE_FROM = new Set(["planned", "late", "unpaid", "partial"]);

/** Shared by markCheckCleared/markCheckBounced — delegates to the Turkish Check Bordro engine
 *  so endorsed-check recourse reversal, P0 control_alerts, and collateral release always fire. */
async function settleCheck(
  pool: Pool,
  checkId: string,
  outcome: "cleared" | "bounced",
  actorId: string,
): Promise<void> {
  await executeCheckBordroTransition(
    pool,
    {
      operation: outcome === "cleared" ? "mark_cleared" : "mark_bounced",
      checkIds: [checkId],
    },
    actorId,
  );
}

/** Check honoured by the bank. */
export async function markCheckCleared(pool: Pool, checkId: string, actorId: string): Promise<void> {
  await settleCheck(pool, checkId, "cleared", actorId);
}

/** Check returned unpaid. Not an error state to be hidden — a bounced check is a real,
 *  reportable outcome, so it is recorded exactly like a cleared one. */
export async function markCheckBounced(pool: Pool, checkId: string, actorId: string): Promise<void> {
  await settleCheck(pool, checkId, "bounced", actorId);
}

/** `paidAt` is an ISO date/instant string, or null to record "paid now". It is never left
 *  unset: loan_installments carries the installment_paid_requires_paid_at CHECK (0005:85),
 *  so status='paid' without a timestamp is rejected by the database itself. */
export async function markInstallmentPaid(
  pool: Pool,
  installmentId: string,
  paidAt: string | null,
  actorId: string,
  options?: { cashAccountId?: string | null },
): Promise<void> {
  const normalizedPaidAt = paidAt && paidAt.trim() !== "" ? paidAt.trim() : null;
  if (normalizedPaidAt && Number.isNaN(Date.parse(normalizedPaidAt))) {
    throw new DomainError("VALIDATION", "Geçersiz ödeme tarihi biçimi.");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{
      id: string;
      status: string;
      amount: string;
      installment_no: number | null;
      loan_name: string;
      currency: string;
    }>(
      `select li.id, li.status, li.amount::text as amount, li.installment_no,
              l.name as loan_name, coalesce(l.currency, 'TRY') as currency
         from public.loan_installments li
         join public.loans l on l.id = li.loan_id
        where li.id = $1
        for update of li`,
      [installmentId],
    );
    if (before.rowCount !== 1) throw new DomainError("loan installment not found");
    const row = before.rows[0];
    const currentStatus = row.status;
    if (!LOAN_INSTALLMENT_PAYABLE_FROM.has(currentStatus)) {
      throw new DomainError(`loan_installments ${installmentId}: '${currentStatus}' durumundan ödendi işaretlenemez`);
    }
    const result = await client.query<{ paid_at: string }>(
      `update public.loan_installments
          set status='paid',
              paid_at=coalesce($2::timestamptz, now()),
              paid_amount=coalesce(paid_amount, amount)
        where id=$1
       returning to_char(paid_at,'YYYY-MM-DD') as paid_at`,
      [installmentId, normalizedPaidAt],
    );
    const paidDateISO = result.rows[0].paid_at;

    let bankTxnId: string | null = null;
    if (options?.cashAccountId) {
      const caRes = await client.query<{ id: string; currency: string; is_active: boolean }>(
        `select id::text as id, currency, is_active from public.cash_accounts where id = $1`,
        [options.cashAccountId],
      );
      if (caRes.rowCount !== 1 || !caRes.rows[0].is_active) {
        throw new DomainError("NOT_FOUND", "Seçilen ödeme kasa/banka hesabı bulunamadı veya pasif.");
      }
      if (caRes.rows[0].currency !== row.currency) {
        throw new DomainError(
          "CONFLICT",
          `Taksit para birimi (${row.currency}) ile banka hesabı para birimi (${caRes.rows[0].currency}) eşleşmelidir.`,
        );
      }
      await client.query(
        `insert into public.bank_accounts (cash_account_id) values ($1) on conflict (cash_account_id) do nothing`,
        [options.cashAccountId],
      );
      const signedOutflow = decimal(row.amount).abs().times(-1).toFixed(2);
      const txIns = await client.query<{ id: string }>(
        `insert into public.bank_transactions
           (bank_account_id, txn_date, value_date, amount, currency, description,
            category_rule, status, matched_entity_table, matched_entity_id, matched_at, dedupe_hash)
         values ($1, $2::date, $2::date, $3::numeric, $4, $5,
                 'system_internal_settlement', 'matched', 'loan_installments', $6, now(), $7)
         on conflict (bank_account_id, dedupe_hash) do nothing
         returning id::text as id`,
        [
          options.cashAccountId,
          paidDateISO,
          signedOutflow,
          row.currency,
          `Kredi taksit ödemesi: ${row.loan_name} #${row.installment_no ?? "-"}`,
          installmentId,
          `loan_inst_paid:${installmentId}`,
        ],
      );
      bankTxnId = txIns.rows[0]?.id ?? null;
    }

    await safeSyncDomainEventWithClient(
      client,
      { kind: "loan_installment", installmentId },
      actorId,
    );
    await audit(client, {
      actor: actorId,
      action: "mark_installment_paid",
      entityTable: "loan_installments",
      entityId: installmentId,
      before: { status: currentStatus },
      after: { status: "paid", paid_at: paidDateISO, cashAccountId: options?.cashAccountId ?? null, bankTxnId },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 4) cancellation — checks/loan_installments only, loans has no 'cancelled' enum value ── */

const CHECK_CANCELLABLE_FROM = new Set([
  "planned",
  "unknown",
  "in_portfolio",
  "issued_to_vendor",
  "bounced",
  "returned",
]);
const LOAN_INSTALLMENT_CANCELLABLE_FROM = new Set(["planned", "late", "unpaid", "partial"]);

export async function classifyUnknownCheck(
  pool: Pool,
  checkId: string,
  targetStatus: "in_portfolio" | "issued_to_vendor",
  actorId: string,
): Promise<void> {
  if (targetStatus !== "in_portfolio" && targetStatus !== "issued_to_vendor") {
    throw new DomainError("Geçersiz çek sınıflandırma hedefi.");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{
      id: string;
      status: string;
      direction: string;
      amount: string | null;
    }>(
      `select id::text, status, direction, amount::text from public.checks where id = $1 for update`,
      [checkId],
    );
    if (before.rowCount !== 1) throw new DomainError("check not found");
    const row = before.rows[0];
    if (row.status !== "unknown") {
      throw new DomainError(`checks ${checkId}: '${row.status}' durumundaki çek yeniden sınıflandırılamaz`);
    }
    const nextDirection = targetStatus === "in_portfolio" ? "inflow" : "outflow";
    const absDec = row.amount == null ? null : decimal(row.amount).abs();
    const signedAmt =
      absDec == null ? null : money(nextDirection === "outflow" ? absDec.times(-1) : absDec);

    await client.query(
      `update public.checks
          set status = $2,
              direction = $3,
              signed_amount = $4::numeric
        where id = $1`,
      [checkId, targetStatus, nextDirection, signedAmt],
    );
    await client.query(
      `insert into public.check_events (check_id, event_type, event_note, created_by)
       values ($1, $2, $3, $4)`,
      [
        checkId,
        targetStatus === "in_portfolio" ? "received_to_portfolio" : "issued_to_vendor",
        `Bilinmeyen ('unknown') çek '${targetStatus}' olarak sınıflandırıldı`,
        actorId,
      ],
    );
    await audit(client, {
      actor: actorId,
      action: "classify_unknown_check",
      entityTable: "checks",
      entityId: checkId,
      before: row,
      after: { status: targetStatus, direction: nextDirection, signed_amount: signedAmt },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function cancelCheck(pool: Pool, checkId: string, reason: string, actorId: string): Promise<void> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new DomainError("VALIDATION", "İptal gerekçesi boş bırakılamaz.");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(`select id, status from public.checks where id=$1 for update`, [checkId]);
    if (before.rowCount !== 1) throw new DomainError("check not found");
    const currentStatus = before.rows[0].status as string;
    if (!CHECK_CANCELLABLE_FROM.has(currentStatus)) {
      throw new DomainError(`checks ${checkId}: '${currentStatus}' durumundan iptal edilemez`);
    }
    await client.query(
      `update public.checks set status='cancelled', cancelled_at=now(), cancel_reason=$2 where id=$1`,
      [checkId, trimmedReason],
    );
    await audit(client, {
      actor: actorId, action: "cancel_check", entityTable: "checks", entityId: checkId,
      after: { status: "cancelled", cancel_reason: trimmedReason },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function cancelLoanInstallment(pool: Pool, installmentId: string, reason: string, actorId: string): Promise<void> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new DomainError("VALIDATION", "İptal gerekçesi boş bırakılamaz.");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status from public.loan_installments where id=$1 for update`,
      [installmentId],
    );
    if (before.rowCount !== 1) throw new DomainError("loan installment not found");
    const currentStatus = before.rows[0].status as string;
    if (!LOAN_INSTALLMENT_CANCELLABLE_FROM.has(currentStatus)) {
      throw new DomainError(`loan_installments ${installmentId}: '${currentStatus}' durumundan iptal edilemez`);
    }
    await client.query(
      `update public.loan_installments
          set status='cancelled', cancelled_at=now(), cancel_reason=$2, paid_at=null, paid_amount=null
        where id=$1`,
      [installmentId, trimmedReason],
    );
    await audit(client, {
      actor: actorId, action: "cancel_loan_installment", entityTable: "loan_installments",
      entityId: installmentId,
      after: { status: "cancelled", cancel_reason: trimmedReason },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export type { LoanCandidate };
