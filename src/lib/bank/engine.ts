// Faz 20 / Faz 41 / Faz 48 (D2) — bank statement import, classification, matching, atomic settlement & reconciliation.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { evaluateRulesWithClient } from "@/lib/approvals/engine";
import { audit } from "@/lib/audit";
import { translatePeriodLockError } from "@/lib/cashflow/period-lock";
import { DomainError } from "@/lib/domain-error";
import {
  safeReverseJournalForSourceWithClient,
  safeSyncDomainEventWithClient,
} from "@/lib/ledger/posting-engine";
import { decimal, intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { resolvePromisesForPaidInvoicesWithClient } from "@/lib/receivables/engine";
import { parseOrThrow } from "@/lib/validation";
import { cellsToRows, decodeRange, sha256, sheetCells, hashRow, type RowJson } from "@/lib/importers/row-utils";
import {
  classifyTransaction,
  dedupeKey,
  detectStatementColumns,
  parseStatementDate,
  resolveSignedAmount,
  scoreMatch,
  statementColumnsUsable,
  SUGGESTION_THRESHOLD,
  type MatchScore,
  type MatchTarget,
  type StatementField,
} from "./rules";

/* ── schemas ──────────────────────────────────────────────────────────────────────────── */

export const upsertBankAccountSchema = z.object({
  cashAccountId: z.uuid(),
  iban: z.string().trim().min(5).optional(),
  bankName: z.string().trim().min(1).optional(),
  branchCode: z.string().trim().min(1).optional(),
  branchName: z.string().trim().min(1).optional(),
  accountNumber: z.string().trim().min(1).optional(),
  swiftBic: z.string().trim().min(1).optional(),
  overdraftLimit: z.coerce.number().min(0).optional(),
});

export const matchDecisionSchema = z.object({
  transactionId: z.uuid(),
  targetTable: z.enum(["payment_instances", "checks", "loan_installments", "invoices"]),
  targetId: z.uuid(),
});

export const manualMatchBankTransactionSchema = z
  .object({
    transactionId: z.uuid(),
    targetKey: z.string().trim().optional(),
    targetTable: z.enum(["payment_instances", "checks", "loan_installments", "invoices"]).optional(),
    targetId: z.uuid().optional(),
  })
  .superRefine((val, ctx) => {
    const hasPair = Boolean(val.targetTable && val.targetId);
    const hasKey = Boolean(val.targetKey && val.targetKey.includes(":"));
    if (!hasPair && !hasKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetKey"],
        message: "Eşleştirilecek açık kayıt seçilmelidir.",
      });
    }
  });

export const ignoreSchema = z.object({
  transactionId: z.uuid(),
  reason: z.string().trim().min(3, "Gerekçe en az 3 karakter olmalı"),
});

export const unignoreSchema = z.object({
  transactionId: z.uuid(),
});

export const unmatchSchema = z.object({
  transactionId: z.uuid(),
  reason: z.string().trim().min(3, "Geri alma gerekçesi en az 3 karakter olmalı"),
});

/* ── bank account ─────────────────────────────────────────────────────────────────────── */

export async function upsertBankAccount(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(upsertBankAccountSchema, raw, "Banka hesabı formu");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select * from public.bank_accounts where cash_account_id=$1 for update`, [input.cashAccountId]);
    const acct = await client.query(
      `select id, account_type from public.cash_accounts where id=$1`, [input.cashAccountId]);
    if (acct.rowCount === 0) throw new DomainError("Kasa/banka hesabı bulunamadı.");

    await client.query(
      `insert into public.bank_accounts
         (cash_account_id, iban, bank_name, branch_code, branch_name, account_number, swift_bic, overdraft_limit)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (cash_account_id) do update set
         iban=excluded.iban, bank_name=excluded.bank_name, branch_code=excluded.branch_code,
         branch_name=excluded.branch_name, account_number=excluded.account_number,
         swift_bic=excluded.swift_bic, overdraft_limit=excluded.overdraft_limit`,
      [
        input.cashAccountId, input.iban ?? null, input.bankName ?? null, input.branchCode ?? null,
        input.branchName ?? null, input.accountNumber ?? null, input.swiftBic ?? null,
        input.overdraftLimit ?? null,
      ],
    );
    await audit(client, {
      actor: actorId, action: "upsert_bank_account", entityTable: "bank_accounts",
      entityId: input.cashAccountId, before: before.rows[0] ?? null, after: input,
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── statement import ─────────────────────────────────────────────────────────────────── */

export interface StatementImportResult {
  ok: boolean;
  workbookId: string;
  error?: string;
  format?: "xlsx" | "csv" | "mt940" | "camt053";
  rowsSeen: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  skippedReasons: string[];
}

function cell(row: RowJson, col: string | undefined): unknown {
  if (!col) return null;
  const c = row[col];
  if (!c) return null;
  return c.w ?? c.v;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

export async function importBankStatement(
  pool: Pool,
  buf: Buffer,
  originalFilename: string,
  bankAccountId: string,
  actorId: string,
): Promise<StatementImportResult> {
  const { safeParseStatementBuffer } = await import("@/lib/importers/statement-parser");
  const parsed = await safeParseStatementBuffer(buf, originalFilename);

  const client = await pool.connect();
  try {
    await client.query("begin");

    const acct = await client.query(
      `select cash_account_id from public.bank_accounts where cash_account_id=$1`, [bankAccountId]);
    if (acct.rowCount === 0) {
      throw new DomainError("Bu kasa hesabı için banka hesabı tanımlı değil — önce IBAN/şube bilgisi girin.");
    }

    const wb = await client.query<{ id: string }>(
      `insert into public.source_workbooks (original_filename, file_sha256, status, imported_by)
       values ($1,$2,'pending',$3) returning id`,
      [originalFilename, sha256(buf), actorId],
    );
    const workbookId = wb.rows[0].id;

    if (!parsed.ok) {
      await client.query(
        `update public.source_workbooks set status='failed', parse_error=$2 where id=$1`,
        [workbookId, parsed.error],
      );
      await audit(client, {
        actor: actorId, action: "import_bank_statement_failed", entityTable: "source_workbooks",
        entityId: workbookId, after: { filename: originalFilename, error: parsed.error },
      });
      await client.query("commit");
      return {
        ok: false, workbookId, error: parsed.error,
        rowsSeen: 0, inserted: 0, duplicates: 0, skipped: 0, skippedReasons: [],
      };
    }

    const sheetName = parsed.workbook.SheetNames[0];
    const ws = parsed.workbook.Sheets[sheetName];
    const cells = sheetCells(ws);
    const ref = ws && ws["!ref"] ? String(ws["!ref"]) : null;
    const range = ref ? decodeRange(ref) : null;

    const sheet = await client.query<{ id: string }>(
      `insert into public.source_sheets
         (workbook_id, sheet_name, sheet_name_normalized, sheet_index, used_range,
          row_count, column_count, detected_type, parse_confidence)
       values ($1,$2,$3,0,$4,$5,$6,'bank_statement','high') returning id`,
      [
        workbookId, sheetName, sheetName.toLowerCase(), ref,
        range ? range.e.r - range.s.r + 1 : 0,
        range ? range.e.c - range.s.c + 1 : 0,
      ],
    );
    const sheetId = sheet.rows[0].id;

    // Faz 41 (B2-09): Preserve every populated cell in 500-row UNNEST batches instead of 1 query/cell.
    const CELL_BATCH = 500;
    for (let cellIdx = 0; cellIdx < cells.length; cellIdx += CELL_BATCH) {
      const part = cells.slice(cellIdx, cellIdx + CELL_BATCH);
      await client.query(
        `insert into public.source_cells
           (workbook_id, sheet_id, row_index, column_index, address,
            raw_value, normalized_value, inferred_type, formula)
         select $1, $2, r, c, a, rv, nv, it, f
         from unnest($3::int[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
              as t(r, c, a, rv, nv, it, f)`,
        [
          workbookId,
          sheetId,
          part.map((x) => x.rowIndex),
          part.map((x) => x.columnIndex),
          part.map((x) => x.address),
          part.map((x) => x.cell.w ?? String(x.cell.v)),
          part.map((x) => (x.cell.t === "e" ? null : String(x.cell.v))),
          part.map((x) => (x.cell.t === "e" ? "error" : x.cell.t)),
          part.map((x) => x.cell.f ?? null),
        ],
      );
    }

    const rows = cellsToRows(cells);

    let columns: Partial<Record<StatementField, string>> = {};
    let headerRowIndex = -1;
    for (const row of rows.slice(0, 25)) {
      const header: Record<string, string> = {};
      for (const [col, c] of Object.entries(row.cells)) header[col] = String(c.w ?? c.v);
      const detected = detectStatementColumns(header);
      if (statementColumnsUsable(detected)) {
        columns = detected;
        headerRowIndex = row.rowIndex;
        break;
      }
    }
    if (headerRowIndex === -1) {
      const err = "Ekstre başlık satırı tanınmadı (tarih ve tutar/borç/alacak sütunları bulunamadı).";
      await client.query(`update public.source_workbooks set status='failed', parse_error=$2 where id=$1`, [workbookId, err]);
      await audit(client, {
        actor: actorId, action: "import_bank_statement_failed", entityTable: "source_workbooks",
        entityId: workbookId, after: { filename: originalFilename, error: err },
      });
      await client.query("commit");
      return { ok: false, workbookId, error: err, format: parsed.format, rowsSeen: rows.length, inserted: 0, duplicates: 0, skipped: 0, skippedReasons: [] };
    }

    let inserted = 0;
    let duplicates = 0;
    let skipped = 0;
    const skippedReasons: string[] = [];

    for (const row of rows) {
      if (row.rowIndex <= headerRowIndex) continue;

      const txnDate = parseStatementDate(cell(row.cells, columns.txn_date));
      const signed = resolveSignedAmount({
        amount: cell(row.cells, columns.amount),
        debit: cell(row.cells, columns.debit),
        credit: cell(row.cells, columns.credit),
        directionHint: text(cell(row.cells, columns.direction)),
      });

      if (!txnDate || signed == null) {
        skipped++;
        if (skippedReasons.length < 5) {
          skippedReasons.push(`satır ${row.rowIndex}: ${!txnDate ? "tarih okunamadı" : "tutar okunamadı"}`);
        }
        continue;
      }

      const importRow = await client.query<{ id: string }>(
        `insert into public.import_rows (workbook_id, sheet_id, row_index, row_json, row_hash, detected_entity_type)
         values ($1,$2,$3,$4,$5,'bank_statement') returning id`,
        [workbookId, sheetId, row.rowIndex, JSON.stringify(row.cells), hashRow(row.cells)],
      );

      const description = text(cell(row.cells, columns.description)) ?? "";
      const counterparty = text(cell(row.cells, columns.counterparty));
      const reference = text(cell(row.cells, columns.reference));
      const classification = classifyTransaction({ description, counterparty, amount: signed });
      const hash = dedupeKey({ txnDate, amount: signed, description, reference });

      const ins = await client.query(
        `insert into public.bank_transactions
           (bank_account_id, source_workbook_id, source_sheet_id, source_row_id,
            txn_date, value_date, description, counterparty_name_raw, counterparty_iban_raw,
            reference_no, channel, amount, balance_after, category, category_rule, dedupe_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::numeric,$13::numeric,$14,$15,$16)
         on conflict (bank_account_id, dedupe_hash) do nothing`,
        [
          bankAccountId, workbookId, sheetId, importRow.rows[0].id,
          txnDate, parseStatementDate(cell(row.cells, columns.value_date)),
          description, counterparty, text(cell(row.cells, columns.counterparty_iban)),
          reference, text(cell(row.cells, columns.channel)),
          signed, resolveSignedAmount({ amount: cell(row.cells, columns.balance) }),
          classification.category, classification.rule, hash,
        ],
      );
      if ((ins.rowCount ?? 0) > 0) inserted++;
      else duplicates++;
    }

    await client.query(
      `update public.source_workbooks set status='parsed', notes=$2 where id=$1`,
      [workbookId, `bank_statement rows=${rows.length} inserted=${inserted} duplicates=${duplicates} skipped=${skipped}`],
    );
    await client.query(
      `update public.bank_accounts set last_statement_date = greatest(
         coalesce(last_statement_date, '1900-01-01'::date),
         coalesce((select max(txn_date) from public.bank_transactions where bank_account_id=$1), '1900-01-01'::date))
       where cash_account_id=$1`,
      [bankAccountId],
    );

    await audit(client, {
      actor: actorId, action: "import_bank_statement", entityTable: "bank_transactions", entityId: null,
      after: {
        workbookId, bankAccountId, filename: originalFilename, format: parsed.format,
        rowsSeen: rows.length, inserted, duplicates, skipped,
      },
    });

    await client.query("commit");
    return { ok: true, workbookId, format: parsed.format, rowsSeen: rows.length, inserted, duplicates, skipped, skippedReasons };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── matching & atomic settlement (Faz 48 D2 + Wave 5A F-48 ±90d & manual match) ──────── */

export const EXTENDED_MATCH_WINDOW_DAYS = 90;

export interface ExtendedScoreInput {
  amount: number;
  txnDate: string;
  description: string | null;
  counterparty: string | null;
  currency?: string | null;
}

function daysBetweenISO(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
}

/**
 * F-48: Extends deterministic bank match scoring from ±10d to ±90d while preserving higher
 * confidence for closer dates (`<= 7d` via `scoreMatch`, then graduated `8..10d`, `11..30d`,
 * `31..60d`, `61..90d`) so 30-to-90-day late collections/payments still surface as candidates.
 */
export function scoreExtendedBankMatch(
  txn: ExtendedScoreInput,
  target: MatchTarget,
): MatchScore {
  const base = scoreMatch(txn, target);
  if (
    base.reasons.includes("currency_mismatch") ||
    base.reasons.includes("direction_mismatch")
  ) {
    return base;
  }

  if (target.dueDate) {
    const d = daysBetweenISO(txn.txnDate, target.dueDate);
    if (Number.isFinite(d) && d > 7 && d <= EXTENDED_MATCH_WINDOW_DAYS) {
      let extra = 0;
      let reason = "";
      if (d <= 10) {
        extra = 0.09;
        reason = "date_within_10d";
      } else if (d <= 30) {
        extra = 0.07;
        reason = "date_within_30d";
      } else if (d <= 60) {
        extra = 0.06;
        reason = "date_within_60d";
      } else {
        extra = 0.05;
        reason = "date_within_90d";
      }
      const confidence = Math.min(1, Math.round((base.confidence + extra) * 10000) / 10000);
      return {
        confidence,
        reasons: [...base.reasons, reason],
      };
    }
  }

  return base;
}

export function rankExtendedCandidates(
  txn: ExtendedScoreInput,
  targets: MatchTarget[],
  threshold = SUGGESTION_THRESHOLD,
): Array<MatchTarget & MatchScore> {
  return targets
    .map((t) => ({ ...t, ...scoreExtendedBankMatch(txn, t) }))
    .filter((t) => t.confidence >= threshold)
    .sort((a, b) => b.confidence - a.confidence || (a.label ?? "").localeCompare(b.label ?? "", "tr"));
}

async function loadMatchTargets(
  client: PoolClient,
  txnDate: string,
  windowDays = EXTENDED_MATCH_WINDOW_DAYS,
): Promise<MatchTarget[]> {
  const res = await client.query(
    `select 'payment_instances' as table_name, i.id::text,
            case when i.amount is null then null else (i.amount - coalesce(i.paid_amount, 0)) end as amount,
            to_char(i.due_date,'YYYY-MM-DD') as due_date,
            coalesce(pa.name, p.name, '') as label,
            coalesce(i.direction, p.direction, 'outflow')::text as direction,
            i.currency as currency
       from public.payment_instances i
       left join public.payments p on p.id = i.payment_id
       left join public.parties pa on pa.id = p.provider_party_id
      where i.status in ('unpaid','partial','planned','late')
        and (i.amount is null or i.amount > coalesce(i.paid_amount, 0))
        and i.due_date between $1::date - $2::int and $1::date + $2::int
     union all
     select 'checks', c.id::text, c.amount, to_char(c.maturity_date,'YYYY-MM-DD'),
            coalesce(pa_in.name, pa_out.name, c.counterparty_label, ''),
            c.direction::text as direction,
            c.currency as currency
       from public.checks c
       left join public.parties pa_in on pa_in.id = c.payer_party_id
       left join public.parties pa_out on pa_out.id = c.payee_party_id
      where c.status in ('planned','bounced','in_portfolio','in_bank_collection','in_bank_collateral','issued_to_vendor')
        and c.archived_at is null
        and c.maturity_date between $1::date - $2::int and $1::date + $2::int
     union all
     select 'loan_installments', li.id::text,
            case when li.amount is null then null else (li.amount - coalesce(li.paid_amount, 0)) end as amount,
            to_char(li.due_date,'YYYY-MM-DD'),
            coalesce(pa.name, l.name, ''),
            'outflow'::text as direction,
            l.currency as currency
       from public.loan_installments li
       join public.loans l on l.id = li.loan_id
       left join public.parties pa on pa.id = l.lender_party_id
      where li.status in ('planned','late','unpaid','partial')
        and l.archived_at is null
        and (li.amount is null or li.amount > coalesce(li.paid_amount, 0))
        and li.due_date between $1::date - $2::int and $1::date + $2::int
     union all
     select 'invoices', inv.id::text,
            greatest(0, coalesce(inv.payable_amount, inv.gross_amount) - greatest(coalesce(inv.paid_amount, 0), coalesce(inv.allocated_amount, 0))),
            to_char(coalesce(inv.due_date, inv.issue_date),'YYYY-MM-DD'),
            coalesce(pa.name || ' ' || inv.invoice_no, inv.invoice_no),
            case when inv.direction = 'sales' then 'inflow' else 'outflow' end as direction,
            inv.currency as currency
       from public.invoices inv
       join public.parties pa on pa.id = inv.party_id
      where inv.status in ('open','partial')
        and coalesce(inv.payable_amount, inv.gross_amount) > greatest(coalesce(inv.paid_amount, 0), coalesce(inv.allocated_amount, 0))
        and coalesce(inv.due_date, inv.issue_date) between $1::date - $2::int and $1::date + $2::int`,
    [txnDate, windowDays],
  );
  return res.rows.map((r) => ({
    table: r.table_name as MatchTarget["table"],
    id: r.id,
    amount: moneyOrNull(r.amount),
    dueDate: r.due_date,
    label: r.label || null,
    direction: (r.direction ?? "unknown") as MatchTarget["direction"],
    currency: r.currency ?? null,
  }));
}

export interface MatchRunResult { scanned: number; suggested: number; candidates: number }

export async function runMatcher(pool: Pool, actorId: string, limit = 500): Promise<MatchRunResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const txns = await client.query(
      `select bt.id, to_char(bt.txn_date,'YYYY-MM-DD') as txn_date, bt.amount,
              bt.description, bt.counterparty_name_raw,
              coalesce(bt.currency, ca.currency, 'TRY') as currency
       from public.bank_transactions bt
       left join public.cash_accounts ca on ca.id = bt.bank_account_id
       where bt.status = 'unmatched'
       order by bt.txn_date desc limit $1`,
      [limit],
    );

    let suggested = 0;
    let candidates = 0;
    for (const t of txns.rows) {
      const amount = moneyOrNull(t.amount);
      if (amount == null) continue;
      const targets = await loadMatchTargets(client, t.txn_date);
      const ranked = rankExtendedCandidates(
        {
          amount,
          txnDate: t.txn_date,
          description: t.description,
          counterparty: t.counterparty_name_raw,
          currency: t.currency,
        },
        targets,
      );
      const rejected = await client.query(
        `select target_table, target_id::text from public.bank_transaction_match_candidates
         where bank_transaction_id=$1 and rejected_at is not null`, [t.id]);
      const rejectedKeys = new Set(rejected.rows.map((r) => `${r.target_table}:${r.target_id}`));
      const fresh = ranked.filter((r) => !rejectedKeys.has(`${r.table}:${r.id}`));
      if (fresh.length === 0) continue;

      for (const c of fresh) {
        await client.query(
          `insert into public.bank_transaction_match_candidates
             (bank_transaction_id, target_table, target_id, confidence, reasons)
           values ($1,$2,$3,$4::numeric,$5::jsonb)
           on conflict (bank_transaction_id, target_table, target_id)
           do update set confidence=excluded.confidence, reasons=excluded.reasons`,
          [t.id, c.table, c.id, c.confidence.toFixed(4), JSON.stringify(c.reasons)],
        );
        candidates++;
      }
      await client.query(`update public.bank_transactions set status='suggested' where id=$1`, [t.id]);
      suggested++;
    }

    await audit(client, {
      actor: actorId, action: "run_bank_matcher", entityTable: "bank_transactions", entityId: null,
      after: { scanned: txns.rowCount ?? 0, suggested, candidates, windowDays: EXTENDED_MATCH_WINDOW_DAYS },
    });
    await client.query("commit");
    return { scanned: txns.rowCount ?? 0, suggested, candidates };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    translatePeriodLockError(e);
  } finally {
    client.release();
  }
}

const SETTLEABLE_CHECK_STATUSES = [
  "planned",
  "bounced",
  "in_portfolio",
  "in_bank_collection",
  "in_bank_collateral",
  "issued_to_vendor",
];

const SETTLEABLE_LOAN_INSTALLMENT_STATUSES = [
  "planned",
  "late",
  "unpaid",
  "partial",
];

async function settleBankMatchInternal(
  pool: Pool,
  input: z.infer<typeof matchDecisionSchema>,
  actorId: string,
  options?: { manual?: boolean },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{
      id: string;
      status: string;
      matched_entity_table: string | null;
      matched_entity_id: string | null;
      amount: string | null;
      txn_date: string;
      currency: string;
      category_rule?: string | null;
    }>(
      `select bt.id::text, bt.status, bt.matched_entity_table, bt.matched_entity_id::text,
              bt.amount::text as amount, to_char(bt.txn_date,'YYYY-MM-DD') as txn_date,
              coalesce(bt.currency, ca.currency, 'TRY') as currency,
              bt.category_rule
         from public.bank_transactions bt
         left join public.cash_accounts ca on ca.id = bt.bank_account_id
        where bt.id = $1
        for update of bt`,
      [input.transactionId],
    );
    if (before.rowCount === 0) throw new DomainError("NOT_FOUND", "Banka hareketi bulunamadı.");
    const txRow = before.rows[0];
    const isRealStatementTx = txRow.category_rule !== "radar_settlement";
    const current = txRow.status;
    if (!["unmatched", "suggested"].includes(current)) {
      throw new DomainError("CONFLICT", `'${current}' durumundaki bir hareket doğrudan eşleştirilemez.`);
    }
    if (txRow.amount == null || decimal(txRow.amount).eq(0)) {
      throw new DomainError("CONFLICT", "Tutarı sıfır veya tanımsız olan banka hareketi mali kayıtla eşleştirilemez.");
    }

    const txAmountDec = decimal(txRow.amount);
    const txIsInflow = txAmountDec.gt(0);
    const absTxDec = txAmountDec.abs();
    const txCurrency = txRow.currency;
    const txDate = txRow.txn_date;

    let settledAllocationId: string | null = null;
    let targetFullySettled = false;

    if (input.targetTable === "invoices") {
      const invRes = await client.query<{
        id: string;
        direction: string;
        invoice_no: string;
        status: string;
        currency: string;
        gross_amount: string;
        payable_amount: string | null;
        paid_amount: string;
        allocated_amount: string;
        approval_status: string;
      }>(
        `select id::text, direction, invoice_no, status, currency,
                gross_amount::text, payable_amount::text,
                coalesce(paid_amount, 0)::text as paid_amount,
                coalesce(allocated_amount, 0)::text as allocated_amount,
                approval_status
           from public.invoices
          where id = $1
          for update`,
        [input.targetId],
      );
      if (invRes.rowCount === 0) throw new DomainError("NOT_FOUND", "Eşleştirilecek fatura bulunamadı.");
      const inv = invRes.rows[0];
      if (!["open", "partial"].includes(inv.status)) {
        throw new DomainError("CONFLICT", `Fatura (${inv.invoice_no}) '${inv.status}' durumunda; eşleştirmeyle kapatılamaz.`);
      }
      if (inv.currency !== txCurrency) {
        throw new DomainError("CONFLICT", `Döviz uyumsuzluğu: banka hareketi ${txCurrency}, fatura ${inv.currency}.`);
      }
      if (inv.direction === "sales" && !txIsInflow) {
        throw new DomainError("CONFLICT", "Satış faturası yalnız pozitif (giriş) banka hareketiyle kapatılabilir.");
      }
      if (inv.direction === "purchase" && txIsInflow) {
        throw new DomainError("CONFLICT", "Alış faturası yalnız negatif (çıkış) banka hareketiyle kapatılabilir.");
      }
      if (inv.direction === "purchase" && ["pending_approval", "rejected"].includes(inv.approval_status)) {
        throw new DomainError(
          "FORBIDDEN",
          `Alış faturası (${inv.invoice_no}) maker-checker onayı bekliyor veya reddedildi; onaylanmadan kapatılamaz.`,
        );
      }

      const ceilingDec = decimal(inv.payable_amount ?? inv.gross_amount);
      if (inv.direction === "purchase" && inv.approval_status !== "approved") {
        let firedCount = 0;
        try {
          await client.query("savepoint sp_bank_inv_approval_gate");
          const fired = await evaluateRulesWithClient(client, {
            subjectTable: "invoices",
            triggerKind: "invoice",
            amount: ceilingDec.toFixed(2),
            currency: inv.currency,
          });
          firedCount = fired.length;
          await client.query("release savepoint sp_bank_inv_approval_gate");
        } catch (err) {
          await client.query("rollback to savepoint sp_bank_inv_approval_gate").catch(() => undefined);
          await client.query("release savepoint sp_bank_inv_approval_gate").catch(() => undefined);
          const code = (err as { code?: string } | null)?.code;
          const msg = err instanceof Error ? err.message : String(err);
          if (code !== "42P01" && code !== "42703" && !msg.includes("beklenmeyen SQL")) throw err;
        }
        if (firedCount > 0) {
          throw new DomainError(
            "FORBIDDEN",
            `Alış faturası (${inv.invoice_no}) kritik onay eşiğini aşıyor; bağımsız ikinci onay (maker-checker) tamamlanmadan kapatılamaz.`,
          );
        }
      }
      const settledSoFarDec = decimal(inv.paid_amount).gt(decimal(inv.allocated_amount))
        ? decimal(inv.paid_amount)
        : decimal(inv.allocated_amount);
      const openDec = ceilingDec.minus(settledSoFarDec);
      if (openDec.lte(0)) {
        throw new DomainError("CONFLICT", `Faturanın (${inv.invoice_no}) açık bakiyesi kalmamış.`);
      }
      if (absTxDec.gt(openDec)) {
        throw new DomainError(
          "CONFLICT",
          `Banka hareketi tutarı (${absTxDec.toFixed(2)} ${txCurrency}) faturanın açık bakiyesini (${openDec.toFixed(2)} ${inv.currency}) aşıyor.`,
        );
      }

      const insAlloc = await client.query<{ id: string }>(
        `insert into public.invoice_allocations
           (invoice_id, source_table, source_id, allocated_amount, allocated_on, notes, created_by)
         values ($1, 'bank_transactions', $2, $3::numeric, $4::date, 'Banka ekstresi eşleştirmesi ile otomatik kapatıldı', $5)
         returning id::text as id`,
        [input.targetId, input.transactionId, absTxDec.toFixed(2), txDate, actorId],
      );
      if (insAlloc.rowCount !== 1) {
        throw new DomainError("CONFLICT", "Fatura tahsisi oluşturulamadı.");
      }
      settledAllocationId = insAlloc.rows[0].id;

      const invAfter = await client.query<{ status: string }>(
        `select status from public.invoices where id = $1`,
        [input.targetId],
      );
      targetFullySettled = invAfter.rows[0]?.status === "paid";
      if (targetFullySettled) {
        await resolvePromisesForPaidInvoicesWithClient(client, [input.targetId], actorId);
      }
    } else if (input.targetTable === "payment_instances") {
      const piRes = await client.query<{
        id: string;
        status: string;
        amount: string | null;
        paid_amount: string;
        currency: string;
        direction: string;
        approval_status: string;
      }>(
        `select pi.id::text, pi.status, pi.amount::text as amount,
                coalesce(pi.paid_amount, 0)::text as paid_amount,
                pi.currency,
                coalesce(pi.direction, p.direction, 'outflow') as direction,
                pi.approval_status
           from public.payment_instances pi
           left join public.payments p on p.id = pi.payment_id
          where pi.id = $1
          for update of pi`,
        [input.targetId],
      );
      if (piRes.rowCount === 0) throw new DomainError("NOT_FOUND", "Eşleştirilecek ödeme kalemi bulunamadı.");
      const pi = piRes.rows[0];
      if (!["unpaid", "partial", "planned", "late"].includes(pi.status)) {
        throw new DomainError("CONFLICT", `'${pi.status}' durumundaki ödeme kalemi eşleştirmeyle kapatılamaz.`);
      }
      if (pi.currency !== txCurrency) {
        throw new DomainError("CONFLICT", `Döviz uyumsuzluğu: banka hareketi ${txCurrency}, ödeme kalemi ${pi.currency}.`);
      }
      if (pi.direction === "inflow" && !txIsInflow) {
        throw new DomainError("CONFLICT", "Giriş yönlü ödeme kalemi negatif banka hareketiyle kapatılamaz.");
      }
      if (pi.direction === "outflow" && txIsInflow) {
        throw new DomainError("CONFLICT", "Çıkış yönlü ödeme kalemi pozitif banka hareketiyle kapatılamaz.");
      }
      if (pi.direction === "outflow" && ["pending_approval", "rejected"].includes(pi.approval_status)) {
        throw new DomainError(
          "FORBIDDEN",
          "Ödeme kalemi maker-checker onayı bekliyor veya reddedildi; onaylanmadan kapatılamaz.",
        );
      }

      const prevPaidDec = decimal(pi.paid_amount);
      const newPaidDec = prevPaidDec.plus(absTxDec);
      let nextStatus: "paid" | "partial" = "paid";
      if (pi.amount != null) {
        const totalDec = decimal(pi.amount);
        if (newPaidDec.gt(totalDec)) {
          throw new DomainError(
            "CONFLICT",
            `Banka hareketi tutarı (${absTxDec.toFixed(2)} ${txCurrency}) ödeme kaleminin kalan bakiyesini (${totalDec.minus(prevPaidDec).toFixed(2)} ${pi.currency}) aşıyor.`,
          );
        }
        nextStatus = newPaidDec.gte(totalDec) ? "paid" : "partial";
      }

      if (pi.direction === "outflow" && pi.approval_status !== "approved") {
        const effectiveOutflowDec =
          pi.amount != null && decimal(pi.amount).gt(newPaidDec)
            ? decimal(pi.amount)
            : newPaidDec;
        let firedCount = 0;
        try {
          await client.query("savepoint sp_bank_pi_approval_gate");
          const fired = await evaluateRulesWithClient(client, {
            subjectTable: "payment_instances",
            triggerKind: "payment",
            amount: effectiveOutflowDec.toFixed(2),
            currency: pi.currency,
          });
          firedCount = fired.length;
          await client.query("release savepoint sp_bank_pi_approval_gate");
        } catch (err) {
          await client.query("rollback to savepoint sp_bank_pi_approval_gate").catch(() => undefined);
          await client.query("release savepoint sp_bank_pi_approval_gate").catch(() => undefined);
          const code = (err as { code?: string } | null)?.code;
          const msg = err instanceof Error ? err.message : String(err);
          if (code !== "42P01" && code !== "42703" && !msg.includes("beklenmeyen SQL")) throw err;
        }
        if (firedCount > 0) {
          throw new DomainError(
            "FORBIDDEN",
            "Ödeme kalemi kritik onay eşiğini aşıyor; bağımsız ikinci onay (maker-checker) tamamlanmadan kapatılamaz.",
          );
        }
      }

      let updPiRowCount = 0;
      if (isRealStatementTx) {
        await client.query("savepoint sp_bank_pi_reconcile_col");
        try {
          const updPiRec = await client.query(
            `update public.payment_instances
                set status = $2,
                    paid_amount = $3::numeric,
                    paid_at = ($4::date)::timestamptz,
                    reconciliation_status = 'reconciled'
              where id = $1`,
            [input.targetId, nextStatus, newPaidDec.toFixed(2), txDate],
          );
          updPiRowCount = updPiRec.rowCount ?? 0;
          await client.query("release savepoint sp_bank_pi_reconcile_col");
        } catch (err) {
          await client.query("rollback to savepoint sp_bank_pi_reconcile_col").catch(() => undefined);
          await client.query("release savepoint sp_bank_pi_reconcile_col").catch(() => undefined);
          if ((err as { code?: string } | null)?.code !== "42703") throw err;
          const updPiFallback = await client.query(
            `update public.payment_instances
                set status = $2, paid_amount = $3::numeric, paid_at = ($4::date)::timestamptz
              where id = $1`,
            [input.targetId, nextStatus, newPaidDec.toFixed(2), txDate],
          );
          updPiRowCount = updPiFallback.rowCount ?? 0;
        }
      } else {
        const updPi = await client.query(
          `update public.payment_instances
              set status = $2, paid_amount = $3::numeric, paid_at = ($4::date)::timestamptz
            where id = $1`,
          [input.targetId, nextStatus, newPaidDec.toFixed(2), txDate],
        );
        updPiRowCount = updPi.rowCount ?? 0;
      }
      if (updPiRowCount !== 1) {
        throw new DomainError("CONFLICT", "Ödeme kalemi güncellenemedi.");
      }
      targetFullySettled = nextStatus === "paid";
    } else if (input.targetTable === "checks") {
      const chkRes = await client.query<{
        id: string;
        status: string;
        amount: string | null;
        currency: string;
        direction: string;
      }>(
        `select id::text, status, amount::text as amount, currency, direction
           from public.checks
          where id = $1 and archived_at is null
          for update`,
        [input.targetId],
      );
      if (chkRes.rowCount === 0) throw new DomainError("NOT_FOUND", "Eşleştirilecek çek bulunamadı.");
      const chk = chkRes.rows[0];
      if (!SETTLEABLE_CHECK_STATUSES.includes(chk.status)) {
        throw new DomainError("CONFLICT", `'${chk.status}' durumundaki çek banka eşleştirmesiyle kapatılamaz.`);
      }
      if (chk.currency !== txCurrency) {
        throw new DomainError("CONFLICT", `Döviz uyumsuzluğu: banka hareketi ${txCurrency}, çek ${chk.currency}.`);
      }
      if (chk.direction === "inflow" && !txIsInflow) {
        throw new DomainError("CONFLICT", "Müşteri çeki (inflow) yalnız pozitif banka hareketiyle tahsil edilebilir.");
      }
      if (chk.direction === "outflow" && txIsInflow) {
        throw new DomainError("CONFLICT", "Keşide çekimiz (outflow) yalnız negatif banka hareketiyle ödenebilir.");
      }
      if (chk.amount == null || !absTxDec.eq(decimal(chk.amount))) {
        throw new DomainError("CONFLICT", "Çek kapanışı için banka hareketi tutarı çek tutarıyla birebir eşleşmelidir.");
      }

      const updChk = await client.query(
        `update public.checks set status = 'cleared' where id = $1`,
        [input.targetId],
      );
      if (updChk.rowCount !== 1) {
        throw new DomainError("CONFLICT", "Çek durumu güncellenemedi.");
      }
      const insEvt = await client.query(
        `insert into public.check_events (check_id, event_type, event_note, created_by)
         values ($1, 'cleared', 'Banka ekstresi eşleştirmesi ile kapatıldı', $2)`,
        [input.targetId, actorId],
      );
      if (insEvt.rowCount !== 1) {
        throw new DomainError("CONFLICT", "Çek olayı kaydedilemedi.");
      }
      targetFullySettled = true;
    } else {
      const liRes = await client.query<{
        id: string;
        status: string;
        amount: string | null;
        paid_amount: string;
        currency: string;
      }>(
        `select li.id::text, li.status, li.amount::text as amount,
                coalesce(li.paid_amount, 0)::text as paid_amount,
                l.currency
           from public.loan_installments li
           join public.loans l on l.id = li.loan_id
          where li.id = $1 and l.archived_at is null
          for update of li`,
        [input.targetId],
      );
      if (liRes.rowCount === 0) throw new DomainError("NOT_FOUND", "Eşleştirilecek kredi taksiti bulunamadı.");
      const li = liRes.rows[0];
      if (!SETTLEABLE_LOAN_INSTALLMENT_STATUSES.includes(li.status)) {
        throw new DomainError("CONFLICT", `'${li.status}' durumundaki kredi taksiti eşleştirmeyle kapatılamaz.`);
      }
      if (li.currency !== txCurrency) {
        throw new DomainError("CONFLICT", `Döviz uyumsuzluğu: banka hareketi ${txCurrency}, kredi taksiti ${li.currency}.`);
      }
      if (txIsInflow) {
        throw new DomainError("CONFLICT", "Kredi taksiti yalnız negatif (çıkış) banka hareketiyle kapatılabilir.");
      }
      if (li.amount == null) {
        throw new DomainError("CONFLICT", "Tutarı bilinmeyen kredi taksiti otomatik kapatılamaz.");
      }
      const prevPaidLiDec = decimal(li.paid_amount ?? 0);
      const openInstallmentDec = decimal(li.amount).minus(prevPaidLiDec);
      if (!absTxDec.eq(openInstallmentDec)) {
        throw new DomainError(
          "CONFLICT",
          `Kredi taksiti kapanışı için banka hareketi tutarı (${absTxDec.toFixed(2)} ${txCurrency}) kalan taksit tutarıyla (${openInstallmentDec.toFixed(2)} ${li.currency}) eşleşmelidir.`,
        );
      }

      let updLiRowCount = 0;
      if (isRealStatementTx) {
        await client.query("savepoint sp_bank_li_reconcile_col");
        try {
          const updLiRec = await client.query(
            `update public.loan_installments
                set status = 'paid',
                    paid_amount = amount,
                    paid_at = ($2::date)::timestamptz,
                    reconciliation_status = 'reconciled'
              where id = $1`,
            [input.targetId, txDate],
          );
          updLiRowCount = updLiRec.rowCount ?? 0;
          await client.query("release savepoint sp_bank_li_reconcile_col");
        } catch (err) {
          await client.query("rollback to savepoint sp_bank_li_reconcile_col").catch(() => undefined);
          await client.query("release savepoint sp_bank_li_reconcile_col").catch(() => undefined);
          if ((err as { code?: string } | null)?.code !== "42703") throw err;
          const updLiFallback = await client.query(
            `update public.loan_installments
                set status = 'paid', paid_amount = amount, paid_at = ($2::date)::timestamptz
              where id = $1`,
            [input.targetId, txDate],
          );
          updLiRowCount = updLiFallback.rowCount ?? 0;
        }
      } else {
        const updLi = await client.query(
          `update public.loan_installments
              set status = 'paid', paid_amount = amount, paid_at = ($2::date)::timestamptz
            where id = $1`,
          [input.targetId, txDate],
        );
        updLiRowCount = updLi.rowCount ?? 0;
      }
      if (updLiRowCount !== 1) {
        throw new DomainError("CONFLICT", "Kredi taksiti güncellenemedi.");
      }
      targetFullySettled = true;
    }

    const confidence = await client.query(
      `select confidence from public.bank_transaction_match_candidates
       where bank_transaction_id=$1 and target_table=$2 and target_id=$3`,
      [input.transactionId, input.targetTable, input.targetId]);

    const updBt = await client.query(
      `update public.bank_transactions
          set status='matched', matched_entity_table=$2, matched_entity_id=$3,
              match_confidence=$4::numeric, matched_at=now(), ignored_reason=null,
              settled_allocation_id=$5, settled_at=now(), settled_by=$6
        where id=$1`,
      [
        input.transactionId,
        input.targetTable,
        input.targetId,
        confidence.rows[0]?.confidence ?? (options?.manual ? "1.0000" : null),
        settledAllocationId,
        actorId,
      ],
    );
    if (updBt.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Banka hareketi eşleştirme kaydı yazılamadı.");
    }

    // Settle linked payment_run_items row (and parent payment_runs if all items are settled)
    const runTargetType =
      input.targetTable === "invoices" ? "invoice"
      : input.targetTable === "payment_instances" ? "payment_instance"
      : input.targetTable === "checks" ? "check"
      : "loan_installment";

    let settledRunId: string | null = null;
    const priRes = await client.query<{
      id: string;
      run_id: string;
      amount: string;
    }>(
      `select pri.id::text, pri.run_id::text, pri.amount::text
         from public.payment_run_items pri
         join public.payment_runs pr on pr.id = pri.run_id
        where pri.target_type = $1
          and pri.target_id = $2
          and pri.status = 'included'
          and pr.status in ('approved', 'exported')
        for update of pri, pr`,
      [runTargetType, input.targetId],
    );
    if ((priRes.rowCount ?? 0) > 0) {
      const pri = priRes.rows[0];
      if (targetFullySettled || absTxDec.gte(decimal(pri.amount))) {
        const updPri = await client.query(
          `update public.payment_run_items
              set status = 'settled', settled_bank_tx_id = $2, settled_at = now()
            where id = $1`,
          [pri.id, input.transactionId],
        );
        if (updPri.rowCount === 1) {
          const remRes = await client.query<{ rem: number }>(
            `select count(*)::int as rem
               from public.payment_run_items
              where run_id = $1 and status = 'included'`,
            [pri.run_id],
          );
          if ((remRes.rows[0]?.rem ?? 1) === 0) {
            const updRun = await client.query(
              `update public.payment_runs
                  set status = 'settled', settled_at = now()
                where id = $1 and status in ('approved', 'exported')`,
              [pri.run_id],
            );
            if (updRun.rowCount === 1) {
              settledRunId = pri.run_id;
            }
          }
        }
      }
    }

    if (input.targetTable === "loan_installments") {
      await safeSyncDomainEventWithClient(
        client,
        { kind: "loan_installment", installmentId: input.targetId },
        actorId,
      );
    } else {
      await safeSyncDomainEventWithClient(
        client,
        { kind: "bank_transaction", bankTransactionId: input.transactionId },
        actorId,
      );
    }

    await audit(client, {
      actor: actorId,
      action: options?.manual ? "manual_match_bank_transaction" : "accept_bank_match",
      entityTable: "bank_transactions",
      entityId: input.transactionId,
      before: txRow,
      after: {
        status: "matched",
        matched_entity_table: input.targetTable,
        matched_entity_id: input.targetId,
        manualMatch: Boolean(options?.manual),
        financial_record_mutated: true,
        targetFullySettled,
        settledAllocationId,
        settledRunId,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    translatePeriodLockError(e);
  } finally {
    client.release();
  }
}

/**
 * Faz 48 (D2): Accepts a bank match and atomically settles the linked financial obligation
 * (`invoices`, `payment_instances`, `checks`, or `loan_installments`) — plus any active
 * `payment_run_items` / `payment_runs` entry — inside a single locked PostgreSQL transaction.
 */
export async function acceptMatch(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(matchDecisionSchema, raw, "Eşleştirme");
  await settleBankMatchInternal(pool, input, actorId, { manual: false });
}

export const matchTransaction = acceptMatch;

/**
 * F-48: Operator-initiated manual settlement of an unmatched/suggested bank transaction
 * against any open financial obligation (`invoices`, `payment_instances`, `checks`,
 * `loan_installments`). Accepts either `{ transactionId, targetTable, targetId }` or
 * `{ transactionId, targetKey: "<table>:<uuid>" }`.
 */
export async function manualMatchBankTransaction(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<void> {
  const parsed = parseOrThrow(manualMatchBankTransactionSchema, raw, "Manuel eşleştirme");
  let targetTable = parsed.targetTable;
  let targetId = parsed.targetId;
  if ((!targetTable || !targetId) && parsed.targetKey) {
    const idx = parsed.targetKey.indexOf(":");
    if (idx > 0) {
      targetTable = parsed.targetKey.slice(0, idx) as typeof targetTable;
      targetId = parsed.targetKey.slice(idx + 1).trim();
    }
  }
  const decision = parseOrThrow(
    matchDecisionSchema,
    {
      transactionId: parsed.transactionId,
      targetTable,
      targetId,
    },
    "Manuel eşleştirme hedefi",
  );
  await settleBankMatchInternal(pool, decision, actorId, { manual: true });
}

export async function rejectCandidate(pool: Pool, raw: unknown, actorId: string, reason?: string): Promise<void> {
  const input = parseOrThrow(matchDecisionSchema, raw, "Öneri reddi");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const upd = await client.query(
      `update public.bank_transaction_match_candidates
         set rejected_at=now(), rejected_by=$4, rejected_reason=$5
       where bank_transaction_id=$1 and target_table=$2 and target_id=$3 and rejected_at is null
       returning id`,
      [input.transactionId, input.targetTable, input.targetId, actorId, reason ?? null]);
    if (upd.rowCount === 0) throw new DomainError("Açık bir öneri bulunamadı.");

    const remaining = await client.query(
      `select count(*)::int n from public.bank_transaction_match_candidates
       where bank_transaction_id=$1 and rejected_at is null`, [input.transactionId]);
    if ((intOrNull(remaining.rows[0].n) ?? 0) === 0) {
      await client.query(
        `update public.bank_transactions set status='unmatched' where id=$1 and status='suggested'`,
        [input.transactionId]);
    }

    await audit(client, {
      actor: actorId, action: "reject_bank_match_candidate", entityTable: "bank_transactions",
      entityId: input.transactionId,
      after: { targetTable: input.targetTable, targetId: input.targetId, reason: reason ?? null },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function ignoreTransaction(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(ignoreSchema, raw, "Yok sayma");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{
      id: string;
      status: string;
      ignored_reason: string | null;
    }>(
      `select id::text, status, ignored_reason from public.bank_transactions where id=$1 for update`,
      [input.transactionId],
    );
    if (before.rowCount === 0) throw new DomainError("NOT_FOUND", "Banka hareketi bulunamadı.");
    const currentStatus = before.rows[0].status;
    if (currentStatus === "matched" || currentStatus === "reconciled") {
      throw new DomainError(
        "CONFLICT",
        "Eşleştirilmiş veya mutabakata alınmış banka hareketi doğrudan yok sayılamaz; önce eşleştirmeyi geri alın.",
      );
    }
    if (currentStatus === "ignored") {
      throw new DomainError("CONFLICT", "Bu banka hareketi zaten yok sayılmış durumda.");
    }
    await client.query(
      `update public.bank_transactions
         set status='ignored', ignored_reason=$2, matched_entity_table=null, matched_entity_id=null,
             match_confidence=null, matched_at=null
       where id=$1`,
      [input.transactionId, input.reason],
    );
    await audit(client, {
      actor: actorId, action: "ignore_bank_transaction", entityTable: "bank_transactions",
      entityId: input.transactionId, before: before.rows[0], after: { status: "ignored", reason: input.reason },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    translatePeriodLockError(e);
  } finally {
    client.release();
  }
}

/**
 * F-56: Restores an `'ignored'` bank transaction back to `'unmatched'` so it re-enters
 * the matching queue and liquidity reconciliation.
 */
export async function unignoreTransaction(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<void> {
  const normalized = typeof raw === "string" ? { transactionId: raw } : raw;
  const input = parseOrThrow(unignoreSchema, normalized, "Yok saymayı kaldırma");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{
      id: string;
      status: string;
      ignored_reason: string | null;
    }>(
      `select id::text, status, ignored_reason from public.bank_transactions where id = $1 for update`,
      [input.transactionId],
    );
    if (before.rowCount === 0) throw new DomainError("NOT_FOUND", "Banka hareketi bulunamadı.");
    if (before.rows[0].status !== "ignored") {
      throw new DomainError(
        "CONFLICT",
        `'${before.rows[0].status}' durumundaki banka hareketi yok sayılmış değil.`,
      );
    }
    await client.query(
      `update public.bank_transactions
          set status = 'unmatched',
              ignored_reason = null
        where id = $1`,
      [input.transactionId],
    );
    await audit(client, {
      actor: actorId,
      action: "unignore_bank_transaction",
      entityTable: "bank_transactions",
      entityId: input.transactionId,
      before: before.rows[0],
      after: { status: "unmatched", ignored_reason: null },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    translatePeriodLockError(e);
  } finally {
    client.release();
  }
}

/**
 * F-56: Atomically reverses a `'matched'` or `'reconciled'` bank transaction:
 *   1) Steps `'reconciled'` -> `'matched'` first to satisfy `0042` state-machine guard.
 *   2) Reverses any `invoice_allocations`, `payment_instances`, `checks`, or `loan_installments`
 *      settlement caused by this bank transaction.
 *   3) Restores any `payment_run_items` / `payment_runs` settled by this bank transaction.
 *   4) Posts automatic management-ledger storno (`reversal`) for `bank_transaction` / `loan_installment`.
 *   5) Resets `bank_transactions` back to `'unmatched'`.
 */
export async function unmatchTransaction(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<void> {
  const input = parseOrThrow(unmatchSchema, raw, "Eşleştirmeyi geri alma");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{
      id: string;
      status: string;
      matched_entity_table: string | null;
      matched_entity_id: string | null;
      settled_allocation_id: string | null;
      amount: string | null;
      txn_date: string;
    }>(
      `select id::text, status, matched_entity_table, matched_entity_id::text,
              settled_allocation_id::text, amount::text, to_char(txn_date, 'YYYY-MM-DD') as txn_date
         from public.bank_transactions
        where id = $1
        for update`,
      [input.transactionId],
    );
    if (before.rowCount === 0) throw new DomainError("NOT_FOUND", "Banka hareketi bulunamadı.");
    const txRow = before.rows[0];
    if (!["matched", "reconciled"].includes(txRow.status)) {
      throw new DomainError(
        "CONFLICT",
        `'${txRow.status}' durumundaki banka hareketinin geri alınacak bir eşleşmesi yok.`,
      );
    }

    if (txRow.status === "reconciled") {
      await client.query(
        `update public.bank_transactions
            set status = 'matched', reconciled_at = null
          where id = $1`,
        [input.transactionId],
      );
    }

    // Clear FK reference to invoice_allocations before reversing allocations
    if (txRow.settled_allocation_id) {
      await client.query(
        `update public.bank_transactions set settled_allocation_id = null where id = $1`,
        [input.transactionId],
      );
    }

    const absTxDec = decimal(txRow.amount ?? 0).abs();

    // 1) Reverse any active invoice_allocations sourced from this bank_transaction
    await client.query(
      `update public.invoice_allocations
          set reversed_at = now(),
              reversed_by = $2,
              reversed_reason = $3
        where source_table = 'bank_transactions'
          and source_id = $1::uuid
          and reversed_at is null`,
      [input.transactionId, actorId, `Banka eşleştirmesi geri alındı: ${input.reason}`],
    );

    // 2) Reverse non-invoice matched target if present
    if (txRow.matched_entity_table === "payment_instances" && txRow.matched_entity_id) {
      const piRes = await client.query<{
        id: string;
        status: string;
        paid_amount: string;
      }>(
        `select id::text, status, coalesce(paid_amount, 0)::text as paid_amount
           from public.payment_instances
          where id = $1
          for update`,
        [txRow.matched_entity_id],
      );
      const pi = piRes.rows[0];
      if (pi && ["paid", "partial"].includes(pi.status)) {
        const remDec = decimal(pi.paid_amount).minus(absTxDec);
        if (remDec.lte(0)) {
          await client.query(
            `update public.payment_instances
                set status = 'unpaid', paid_amount = null, paid_at = null
              where id = $1`,
            [pi.id],
          );
        } else {
          await client.query(
            `update public.payment_instances
                set status = 'partial', paid_amount = $2::numeric
              where id = $1`,
            [pi.id, remDec.toFixed(2)],
          );
        }
      }
    } else if (txRow.matched_entity_table === "checks" && txRow.matched_entity_id) {
      const chkRes = await client.query<{
        id: string;
        status: string;
        direction: string;
      }>(
        `select id::text, status, direction
           from public.checks
          where id = $1 and archived_at is null
          for update`,
        [txRow.matched_entity_id],
      );
      const chk = chkRes.rows[0];
      if (chk && chk.status === "cleared") {
        const bordroCheck = await client.query(
          `select 1
             from public.check_events ce
             join public.check_bordros cb on cb.id = ce.bordro_id
            where ce.check_id = $1
              and cb.bordro_type = 'settlement'
            limit 1`,
          [chk.id],
        );
        if ((bordroCheck.rowCount ?? 0) > 0) {
          throw new DomainError(
            "CONFLICT",
            "Tahsilat bordrosuyla kapatılmış çek doğrudan banka üzerinden geri alınamaz; önce çek bordrosunu kontrol edin.",
          );
        }
        const restoredStatus = chk.direction === "outflow" ? "issued_to_vendor" : "in_portfolio";
        const restoredEventType =
          chk.direction === "outflow" ? "issued_to_vendor" : "recalled_to_portfolio";
        await client.query(
          `update public.checks set status = $2 where id = $1`,
          [chk.id, restoredStatus],
        );
        await client.query(
          `insert into public.check_events (check_id, event_type, event_note, created_by)
           values ($1, $2, $3, $4)`,
          [chk.id, restoredEventType, `Banka eşleştirmesi geri alındı: ${input.reason}`, actorId],
        );
      }
    } else if (txRow.matched_entity_table === "loan_installments" && txRow.matched_entity_id) {
      const liRes = await client.query<{ id: string; status: string }>(
        `select id::text, status
           from public.loan_installments
          where id = $1
          for update`,
        [txRow.matched_entity_id],
      );
      const li = liRes.rows[0];
      if (li && ["paid", "partial"].includes(li.status)) {
        await client.query(
          `update public.loan_installments
              set status = 'planned', paid_amount = null, paid_at = null
            where id = $1`,
          [li.id],
        );
      }
      await safeReverseJournalForSourceWithClient(
        client,
        "loan_installment",
        txRow.matched_entity_id,
        `Banka eşleştirmesi geri alındı: ${input.reason}`,
        actorId,
      );
    }

    // 3) Revert any payment_run_items / payment_runs settled by this bank_transaction
    const priRows = await client.query<{ id: string; run_id: string }>(
      `select id::text, run_id::text
         from public.payment_run_items
        where settled_bank_tx_id = $1
          and status = 'settled'
        for update`,
      [input.transactionId],
    );
    for (const pri of priRows.rows) {
      await client.query(
        `update public.payment_run_items
            set status = 'included', settled_bank_tx_id = null, settled_at = null
          where id = $1`,
        [pri.id],
      );
      await client.query(
        `update public.payment_runs
            set status = case when exported_at is not null then 'exported' else 'approved' end,
                settled_at = null
          where id = $1
            and status = 'settled'`,
        [pri.run_id],
      );
    }

    // 4) Reverse management ledger entry posted for this bank_transaction
    await safeReverseJournalForSourceWithClient(
      client,
      "bank_transaction",
      input.transactionId,
      `Banka eşleştirmesi geri alındı: ${input.reason}`,
      actorId,
    );

    // 5) Reset bank_transactions back to unmatched
    await client.query(
      `update public.bank_transactions
          set status = 'unmatched',
              matched_entity_table = null,
              matched_entity_id = null,
              match_confidence = null,
              matched_at = null,
              settled_allocation_id = null,
              settled_at = null,
              settled_by = null
        where id = $1`,
      [input.transactionId],
    );

    await audit(client, {
      actor: actorId,
      action: "unmatch_bank_transaction",
      entityTable: "bank_transactions",
      entityId: input.transactionId,
      before: txRow,
      after: {
        status: "unmatched",
        reason: input.reason,
        revertedEntityTable: txRow.matched_entity_table,
        revertedEntityId: txRow.matched_entity_id,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    translatePeriodLockError(e);
  } finally {
    client.release();
  }
}

export async function reconcileTransaction(pool: Pool, transactionId: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status from public.bank_transactions where id=$1 for update`, [transactionId]);
    if (before.rowCount === 0) throw new DomainError("Banka hareketi bulunamadı.");
    if (before.rows[0].status !== "matched") {
      throw new DomainError("Yalnız eşleştirilmiş bir hareket mutabakata alınabilir.");
    }
    const upd = await client.query(
      `update public.bank_transactions set status='reconciled', reconciled_at=now() where id=$1`, [transactionId]);
    if (upd.rowCount !== 1) throw new DomainError("Mutabakat kaydı güncellenemedi.");
    await audit(client, {
      actor: actorId, action: "reconcile_bank_transaction", entityTable: "bank_transactions",
      entityId: transactionId, before: before.rows[0], after: { status: "reconciled" },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function reconcileBankAccount(
  pool: Pool,
  bankAccountId: string,
  actorId: string,
): Promise<{ reconciledCount: number }> {
  const parsedAccountId = parseOrThrow(z.uuid(), bankAccountId, "Banka hesabı kimliği");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const upd = await client.query<{ id: string }>(
      `update public.bank_transactions
          set status = 'reconciled', reconciled_at = now()
        where bank_account_id = $1 and status = 'matched'
        returning id::text as id`,
      [parsedAccountId],
    );
    const reconciledCount = upd.rowCount ?? 0;
    if (reconciledCount === 0) {
      throw new DomainError("CONFLICT", "Bu hesapta mutabakata alınacak eşleştirilmiş hareket bulunmuyor.");
    }
    await audit(client, {
      actor: actorId,
      action: "reconcile_bank_account",
      entityTable: "bank_accounts",
      entityId: parsedAccountId,
      after: { reconciledCount },
    });
    await client.query("commit");
    return { reconciledCount };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── read side ────────────────────────────────────────────────────────────────────────── */

export interface CandidateTargetDetails {
  counterpartyName: string | null;
  referenceLabel: string | null;
  openAmount: number | null;
  currency: string | null;
  dueDate: string | null;
}

async function loadTargetDetailsMap(
  pool: Pick<Pool, "query">,
  pairs: ReadonlyArray<{ targetTable: string; targetId: string }>,
): Promise<Map<string, CandidateTargetDetails>> {
  const details = new Map<string, CandidateTargetDetails>();
  if (pairs.length === 0) return details;

  const piIds = [...new Set(pairs.filter((p) => p.targetTable === "payment_instances").map((p) => p.targetId))];
  const chkIds = [...new Set(pairs.filter((p) => p.targetTable === "checks").map((p) => p.targetId))];
  const liIds = [...new Set(pairs.filter((p) => p.targetTable === "loan_installments").map((p) => p.targetId))];
  const invIds = [...new Set(pairs.filter((p) => p.targetTable === "invoices").map((p) => p.targetId))];

  const r = await pool.query<{
    target_table: string;
    target_id: string;
    counterparty_name: string | null;
    reference_label: string | null;
    open_amount: string | null;
    currency: string | null;
    due_date: string | null;
  }>(
    `select 'payment_instances'::text as target_table,
            i.id::text as target_id,
            coalesce(pa.name, p.name) as counterparty_name,
            coalesce(p.name, 'Ödeme kalemi') as reference_label,
            case when i.amount is null then null else (i.amount - coalesce(i.paid_amount, 0))::text end as open_amount,
            i.currency as currency,
            to_char(i.due_date, 'YYYY-MM-DD') as due_date
       from public.payment_instances i
       left join public.payments p on p.id = i.payment_id
       left join public.parties pa on pa.id = p.provider_party_id
      where i.id = any($1::uuid[])
     union all
     select 'checks'::text as target_table,
            c.id::text as target_id,
            coalesce(pa_in.name, pa_out.name, c.counterparty_label) as counterparty_name,
            case when c.serial_no is not null then ('Çek ' || c.serial_no) else 'Çek' end as reference_label,
            c.amount::text as open_amount,
            c.currency as currency,
            to_char(c.maturity_date, 'YYYY-MM-DD') as due_date
       from public.checks c
       left join public.parties pa_in on pa_in.id = c.payer_party_id
       left join public.parties pa_out on pa_out.id = c.payee_party_id
      where c.id = any($2::uuid[])
     union all
     select 'loan_installments'::text as target_table,
            li.id::text as target_id,
            coalesce(pa.name, l.name) as counterparty_name,
            (l.name || ' #' || li.installment_no::text) as reference_label,
            case when li.amount is null then null else (li.amount - coalesce(li.paid_amount, 0))::text end as open_amount,
            l.currency as currency,
            to_char(li.due_date, 'YYYY-MM-DD') as due_date
       from public.loan_installments li
       join public.loans l on l.id = li.loan_id
       left join public.parties pa on pa.id = l.lender_party_id
      where li.id = any($3::uuid[])
     union all
     select 'invoices'::text as target_table,
            inv.id::text as target_id,
            pa.name as counterparty_name,
            ('Fatura ' || inv.invoice_no) as reference_label,
            greatest(0, coalesce(inv.payable_amount, inv.gross_amount) - greatest(coalesce(inv.paid_amount, 0), coalesce(inv.allocated_amount, 0)))::text as open_amount,
            inv.currency as currency,
            to_char(coalesce(inv.due_date, inv.issue_date), 'YYYY-MM-DD') as due_date
       from public.invoices inv
       join public.parties pa on pa.id = inv.party_id
      where inv.id = any($4::uuid[])`,
    [piIds, chkIds, liIds, invIds],
  );

  for (const row of r.rows) {
    details.set(`${row.target_table}:${row.target_id}`, {
      counterpartyName: row.counterparty_name ?? null,
      referenceLabel: row.reference_label ?? null,
      openAmount: moneyOrNull(row.open_amount),
      currency: row.currency ?? null,
      dueDate: row.due_date ?? null,
    });
  }
  return details;
}

export async function loadUnmatchedQueue(pool: Pool, limit = 50, offset = 0) {
  const r = await pool.query(
    `select q.id::text, q.account_name, to_char(q.txn_date,'YYYY-MM-DD') as txn_date, q.description,
            q.counterparty_name_raw, q.amount, q.direction, q.category, q.category_rule, q.status,
            q.open_candidate_count, q.best_confidence,
            coalesce(bt.currency, ca.currency, 'TRY') as currency
     from public.bank_unmatched_queue q
     left join public.bank_transactions bt on bt.id = q.id
     left join public.cash_accounts ca on ca.id = q.bank_account_id
     order by q.txn_date desc, abs(q.amount) desc, q.id desc limit $1 offset $2`,
    [limit, Math.max(0, offset)],
  );
  return r.rows.map((x) => ({
    id: x.id as string,
    accountName: x.account_name as string,
    txnDate: x.txn_date as string,
    description: (x.description as string | null) ?? null,
    counterparty: (x.counterparty_name_raw as string | null) ?? null,
    amount: moneyOrNull(x.amount) ?? 0,
    direction: x.direction as "inflow" | "outflow",
    currency:
      typeof x.currency === "string" && x.currency.trim() !== ""
        ? x.currency.trim().toUpperCase()
        : "TRY",
    category: x.category as string,
    categoryRule: (x.category_rule as string | null) ?? null,
    status: x.status as string,
    openCandidateCount: intOrNull(x.open_candidate_count) ?? 0,
    bestConfidence: rateOrNull(x.best_confidence),
  }));
}

export interface ManualMatchTargetOption {
  targetKey: string;
  targetTable: "payment_instances" | "checks" | "loan_installments" | "invoices";
  targetId: string;
  referenceLabel: string;
  counterpartyName: string | null;
  openAmount: number | null;
  currency: string;
  direction: "inflow" | "outflow";
  dueDate: string | null;
}

export async function loadOpenManualMatchTargets(
  pool: Pick<Pool, "query">,
  limit = 200,
): Promise<ManualMatchTargetOption[]> {
  const r = await pool
    .query<{
      target_table: ManualMatchTargetOption["targetTable"];
      target_id: string;
      reference_label: string;
      counterparty_name: string | null;
      open_amount: string | null;
      currency: string | null;
      direction: string | null;
      due_date: string | null;
    }>(
      `select * from (
         select 'invoices'::text as target_table,
                inv.id::text as target_id,
                ('Fatura ' || inv.invoice_no) as reference_label,
                pa.name as counterparty_name,
                greatest(0, coalesce(inv.payable_amount, inv.gross_amount) - greatest(coalesce(inv.paid_amount, 0), coalesce(inv.allocated_amount, 0)))::text as open_amount,
                inv.currency as currency,
                case when inv.direction = 'sales' then 'inflow' else 'outflow' end as direction,
                to_char(coalesce(inv.due_date, inv.issue_date), 'YYYY-MM-DD') as due_date
           from public.invoices inv
           join public.parties pa on pa.id = inv.party_id
          where inv.status in ('open','partial')
            and not (inv.direction = 'purchase' and inv.approval_status in ('pending_approval','rejected'))
            and coalesce(inv.payable_amount, inv.gross_amount) > greatest(coalesce(inv.paid_amount, 0), coalesce(inv.allocated_amount, 0))
         union all
         select 'payment_instances'::text as target_table,
                pi.id::text as target_id,
                coalesce(p.name, 'Ödeme kalemi') as reference_label,
                pa.name as counterparty_name,
                case when pi.amount is null then null else (pi.amount - coalesce(pi.paid_amount, 0))::text end as open_amount,
                pi.currency as currency,
                coalesce(pi.direction, p.direction, 'outflow')::text as direction,
                to_char(pi.due_date, 'YYYY-MM-DD') as due_date
           from public.payment_instances pi
           left join public.payments p on p.id = pi.payment_id
           left join public.parties pa on pa.id = p.provider_party_id
          where pi.status in ('unpaid','partial','planned','late')
            and not (coalesce(pi.direction, p.direction, 'outflow') = 'outflow' and pi.approval_status in ('pending_approval','rejected'))
            and (pi.amount is null or pi.amount > coalesce(pi.paid_amount, 0))
         union all
         select 'checks'::text as target_table,
                c.id::text as target_id,
                case when c.serial_no is not null then ('Çek ' || c.serial_no) else 'Çek' end as reference_label,
                coalesce(pa_in.name, pa_out.name, c.counterparty_label) as counterparty_name,
                c.amount::text as open_amount,
                c.currency as currency,
                c.direction::text as direction,
                to_char(c.maturity_date, 'YYYY-MM-DD') as due_date
           from public.checks c
           left join public.parties pa_in on pa_in.id = c.payer_party_id
           left join public.parties pa_out on pa_out.id = c.payee_party_id
          where c.status in ('planned','bounced','in_portfolio','in_bank_collection','in_bank_collateral','issued_to_vendor')
            and c.archived_at is null
         union all
         select 'loan_installments'::text as target_table,
                li.id::text as target_id,
                (l.name || ' #' || li.installment_no::text) as reference_label,
                coalesce(pa.name, l.name) as counterparty_name,
                case when li.amount is null then null else (li.amount - coalesce(li.paid_amount, 0))::text end as open_amount,
                l.currency as currency,
                'outflow'::text as direction,
                to_char(li.due_date, 'YYYY-MM-DD') as due_date
           from public.loan_installments li
           join public.loans l on l.id = li.loan_id
           left join public.parties pa on pa.id = l.lender_party_id
          where li.status in ('planned','late','unpaid','partial')
            and l.archived_at is null
            and (li.amount is null or li.amount > coalesce(li.paid_amount, 0))
       ) open_targets
       order by due_date desc nulls last, target_table asc
       limit $1`,
      [Math.max(1, limit)],
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42P01" || code === "42703") return { rows: [], rowCount: 0 };
      throw err;
    });

  return r.rows.map((x) => ({
    targetKey: `${x.target_table}:${x.target_id}`,
    targetTable: x.target_table,
    targetId: x.target_id,
    referenceLabel: x.reference_label,
    counterpartyName: x.counterparty_name ?? null,
    openAmount: moneyOrNull(x.open_amount),
    currency: (x.currency ?? "TRY").trim().toUpperCase(),
    direction: x.direction === "inflow" ? "inflow" : "outflow",
    dueDate: x.due_date ?? null,
  }));
}

export async function countUnmatchedQueue(pool: Pick<Pool, "query">): Promise<number> {
  const r = await pool.query<{ n: number }>(`select count(*)::int as n from public.bank_unmatched_queue`);
  return intOrNull(r.rows[0]?.n) ?? 0;
}

export async function loadCandidates(pool: Pool, transactionId: string) {
  const r = await pool.query(
    `select id::text, target_table, target_id::text, confidence, reasons,
            (rejected_at is not null) as rejected
     from public.bank_transaction_match_candidates
     where bank_transaction_id=$1 order by rejected, confidence desc`, [transactionId]);
  const detailMap = await loadTargetDetailsMap(
    pool,
    r.rows.map((x) => ({ targetTable: x.target_table as string, targetId: x.target_id as string })),
  );
  return r.rows.map((x) => {
    const det = detailMap.get(`${x.target_table}:${x.target_id}`);
    return {
      id: x.id as string,
      targetTable: x.target_table as string,
      targetId: x.target_id as string,
      confidence: rateOrNull(x.confidence) ?? 0,
      reasons: (x.reasons ?? []) as string[],
      rejected: x.rejected as boolean,
      counterpartyName: det?.counterpartyName ?? null,
      referenceLabel: det?.referenceLabel ?? null,
      openAmount: det?.openAmount ?? null,
      currency: det?.currency ?? null,
      dueDate: det?.dueDate ?? null,
    };
  });
}

export interface BankMatchCandidate {
  id: string;
  targetTable: string;
  targetId: string;
  confidence: number;
  reasons: string[];
  rejected: boolean;
  counterpartyName?: string | null;
  referenceLabel?: string | null;
  openAmount?: number | null;
  currency?: string | null;
  dueDate?: string | null;
}

export async function loadCandidatesBatch(
  pool: Pick<Pool, "query">,
  transactionIds: readonly string[],
): Promise<Map<string, BankMatchCandidate[]>> {
  const uniqueIds = [...new Set(transactionIds.filter((id) => id.length > 0))];
  const grouped = new Map<string, BankMatchCandidate[]>();
  if (uniqueIds.length === 0) return grouped;
  for (const id of uniqueIds) grouped.set(id, []);

  const r = await pool.query(
    `select mc.bank_transaction_id::text as txn_id,
            mc.id::text,
            mc.target_table,
            mc.target_id::text,
            mc.confidence,
            mc.reasons,
            (mc.rejected_at is not null) as rejected,
            case mc.target_table
              when 'payment_instances' then coalesce(pa_pi.name, p.name)
              when 'checks' then coalesce(pa_chk_in.name, pa_chk_out.name, c.counterparty_label)
              when 'loan_installments' then coalesce(pa_li.name, l.name)
              when 'invoices' then pa_inv.name
              else null
            end as counterparty_name,
            case mc.target_table
              when 'payment_instances' then coalesce(p.name, 'Ödeme kalemi')
              when 'checks' then case when c.serial_no is not null then ('Çek ' || c.serial_no) else 'Çek' end
              when 'loan_installments' then (l.name || ' #' || li.installment_no::text)
              when 'invoices' then ('Fatura ' || inv.invoice_no)
              else null
            end as reference_label,
            case mc.target_table
              when 'payment_instances' then case when pi.amount is null then null else (pi.amount - coalesce(pi.paid_amount, 0))::text end
              when 'checks' then c.amount::text
              when 'loan_installments' then case when li.amount is null then null else (li.amount - coalesce(li.paid_amount, 0))::text end
              when 'invoices' then greatest(0, coalesce(inv.payable_amount, inv.gross_amount) - greatest(coalesce(inv.paid_amount, 0), coalesce(inv.allocated_amount, 0)))::text
              else null
            end as open_amount,
            case mc.target_table
              when 'payment_instances' then pi.currency
              when 'checks' then c.currency
              when 'loan_installments' then l.currency
              when 'invoices' then inv.currency
              else null
            end as currency,
            case mc.target_table
              when 'payment_instances' then to_char(pi.due_date, 'YYYY-MM-DD')
              when 'checks' then to_char(c.maturity_date, 'YYYY-MM-DD')
              when 'loan_installments' then to_char(li.due_date, 'YYYY-MM-DD')
              when 'invoices' then to_char(coalesce(inv.due_date, inv.issue_date), 'YYYY-MM-DD')
              else null
            end as due_date
       from public.bank_transaction_match_candidates mc
       left join public.payment_instances pi on mc.target_table = 'payment_instances' and pi.id = mc.target_id
       left join public.payments p on p.id = pi.payment_id
       left join public.parties pa_pi on pa_pi.id = p.provider_party_id
       left join public.checks c on mc.target_table = 'checks' and c.id = mc.target_id
       left join public.parties pa_chk_in on pa_chk_in.id = c.payer_party_id
       left join public.parties pa_chk_out on pa_chk_out.id = c.payee_party_id
       left join public.loan_installments li on mc.target_table = 'loan_installments' and li.id = mc.target_id
       left join public.loans l on l.id = li.loan_id
       left join public.parties pa_li on pa_li.id = l.lender_party_id
       left join public.invoices inv on mc.target_table = 'invoices' and inv.id = mc.target_id
       left join public.parties pa_inv on pa_inv.id = inv.party_id
      where mc.bank_transaction_id = any($1::uuid[])
      order by mc.bank_transaction_id, rejected, mc.confidence desc`,
    [uniqueIds],
  );
  for (const x of r.rows) {
    const bucket = grouped.get(x.txn_id as string);
    const hasDetails =
      "counterparty_name" in x ||
      "reference_label" in x ||
      "open_amount" in x ||
      "currency" in x ||
      "due_date" in x;
    const item: BankMatchCandidate = hasDetails
      ? {
          id: x.id,
          targetTable: x.target_table,
          targetId: x.target_id,
          confidence: rateOrNull(x.confidence) ?? 0,
          reasons: (x.reasons ?? []) as string[],
          rejected: x.rejected as boolean,
          counterpartyName: (x.counterparty_name as string | null) ?? null,
          referenceLabel: (x.reference_label as string | null) ?? null,
          openAmount: moneyOrNull(x.open_amount),
          currency: (x.currency as string | null) ?? null,
          dueDate: (x.due_date as string | null) ?? null,
        }
      : {
          id: x.id,
          targetTable: x.target_table,
          targetId: x.target_id,
          confidence: rateOrNull(x.confidence) ?? 0,
          reasons: (x.reasons ?? []) as string[],
          rejected: x.rejected as boolean,
        };
    if (bucket) bucket.push(item);
    else grouped.set(x.txn_id as string, [item]);
  }
  return grouped;
}

export async function loadReconciliationSummary(pool: Pool) {
  const r = await pool.query(
    `select bank_account_id::text, account_name, iban_normalized, transaction_count,
            unmatched_count, suggested_count, matched_count, reconciled_count, ignored_count,
            inflow_total, outflow_total, net_total,
            to_char(first_txn_date,'YYYY-MM-DD') as first_txn_date,
            to_char(last_txn_date,'YYYY-MM-DD') as last_txn_date,
            available_balance, to_char(last_statement_date,'YYYY-MM-DD') as last_statement_date
     from public.bank_reconciliation_summary order by account_name`);
  return r.rows.map((x) => ({
    bankAccountId: x.bank_account_id, accountName: x.account_name, iban: x.iban_normalized,
    transactionCount: intOrNull(x.transaction_count) ?? 0,
    unmatchedCount: intOrNull(x.unmatched_count) ?? 0,
    suggestedCount: intOrNull(x.suggested_count) ?? 0,
    matchedCount: intOrNull(x.matched_count) ?? 0,
    reconciledCount: intOrNull(x.reconciled_count) ?? 0,
    ignoredCount: intOrNull(x.ignored_count) ?? 0,
    inflowTotal: moneyOrNull(x.inflow_total) ?? 0,
    outflowTotal: moneyOrNull(x.outflow_total) ?? 0,
    netTotal: moneyOrNull(x.net_total) ?? 0,
    firstTxnDate: x.first_txn_date, lastTxnDate: x.last_txn_date,
    availableBalance: moneyOrNull(x.available_balance),
    lastStatementDate: x.last_statement_date,
  }));
}

export async function loadMatchConflicts(pool: Pool) {
  const r = await pool.query(
    `select matched_entity_table, matched_entity_id::text, claim_count, claimed_total
     from public.bank_match_conflicts order by claim_count desc limit 50`);
  return r.rows.map((x) => ({
    targetTable: x.matched_entity_table, targetId: x.matched_entity_id,
    claimCount: intOrNull(x.claim_count) ?? 0, claimedTotal: moneyOrNull(x.claimed_total) ?? 0,
  }));
}

export interface ResolvedBankTransactionRow {
  id: string;
  accountName: string;
  txnDate: string;
  description: string | null;
  counterparty: string | null;
  amount: number;
  direction: "inflow" | "outflow";
  currency: string;
  status: "matched" | "reconciled" | "ignored";
  matchedEntityTable: string | null;
  matchedEntityId: string | null;
  ignoredReason: string | null;
}

export async function loadRecentResolvedBankTransactions(
  pool: Pick<Pool, "query">,
  limit = 25,
): Promise<ResolvedBankTransactionRow[]> {
  const r = await pool
    .query<{
      id: string;
      account_name: string | null;
      txn_date: string;
      description: string | null;
      counterparty_name_raw: string | null;
      amount: string | null;
      currency: string | null;
      status: "matched" | "reconciled" | "ignored";
      matched_entity_table: string | null;
      matched_entity_id: string | null;
      ignored_reason: string | null;
    }>(
      `select bt.id::text,
              ca.name as account_name,
              to_char(bt.txn_date, 'YYYY-MM-DD') as txn_date,
              bt.description,
              bt.counterparty_name_raw,
              bt.amount::text as amount,
              coalesce(bt.currency, ca.currency, 'TRY') as currency,
              bt.status,
              bt.matched_entity_table,
              bt.matched_entity_id::text,
              bt.ignored_reason
         from public.bank_transactions bt
         left join public.cash_accounts ca on ca.id = bt.bank_account_id
        where bt.status in ('matched', 'reconciled', 'ignored')
        order by bt.updated_at desc nulls last, bt.txn_date desc, bt.id desc
        limit $1`,
      [Math.max(1, limit)],
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42P01" || code === "42703") return { rows: [], rowCount: 0 };
      throw err;
    });

  return r.rows.map((x) => {
    const amt = moneyOrNull(x.amount) ?? 0;
    return {
      id: x.id,
      accountName: x.account_name ?? "Banka Hesabı",
      txnDate: x.txn_date,
      description: x.description ?? null,
      counterparty: x.counterparty_name_raw ?? null,
      amount: amt,
      direction: amt >= 0 ? "inflow" : "outflow",
      currency: (x.currency ?? "TRY").trim().toUpperCase(),
      status: x.status,
      matchedEntityTable: x.matched_entity_table ?? null,
      matchedEntityId: x.matched_entity_id ?? null,
      ignoredReason: x.ignored_reason ?? null,
    };
  });
}

export async function loadBankableAccounts(pool: Pool) {
  const r = await pool.query(
    `select ca.id::text, ca.name, ca.account_type, ca.currency,
            (ba.cash_account_id is not null) as has_bank_profile,
            ba.iban_normalized, ba.bank_name
     from public.cash_accounts ca
     left join public.bank_accounts ba on ba.cash_account_id = ca.id
     where ca.is_active order by ca.name`);
  return r.rows as Array<{
    id: string; name: string; account_type: string; currency: string; has_bank_profile: boolean;
    iban_normalized: string | null; bank_name: string | null;
  }>;
}
