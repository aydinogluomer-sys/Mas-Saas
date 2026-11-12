// Faz 20 / Faz 41 / Faz 48 (D2) — bank statement import, classification, matching, atomic settlement & reconciliation.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { decimal, intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { cellsToRows, decodeRange, sha256, sheetCells, hashRow, type RowJson } from "@/lib/importers/row-utils";
import {
  classifyTransaction,
  dedupeKey,
  detectStatementColumns,
  parseStatementDate,
  rankCandidates,
  resolveSignedAmount,
  statementColumnsUsable,
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

export const ignoreSchema = z.object({
  transactionId: z.uuid(),
  reason: z.string().trim().min(3, "Gerekçe en az 3 karakter olmalı"),
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
  format?: "xlsx" | "csv";
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

/* ── matching & atomic settlement (Faz 48 D2) ─────────────────────────────────────────── */

async function loadMatchTargets(client: PoolClient, txnDate: string, windowDays = 10): Promise<MatchTarget[]> {
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
            li.amount as amount,
            to_char(li.due_date,'YYYY-MM-DD'),
            coalesce(pa.name, l.name, ''),
            'outflow'::text as direction,
            l.currency as currency
       from public.loan_installments li
       join public.loans l on l.id = li.loan_id
       left join public.parties pa on pa.id = l.lender_party_id
      where li.status in ('planned','late') and l.archived_at is null
        and li.due_date between $1::date - $2::int and $1::date + $2::int
     union all
     select 'invoices', inv.id::text, (inv.gross_amount - coalesce(inv.allocated_amount, 0)),
            to_char(coalesce(inv.due_date, inv.issue_date),'YYYY-MM-DD'),
            coalesce(pa.name || ' ' || inv.invoice_no, inv.invoice_no),
            case when inv.direction = 'sales' then 'inflow' else 'outflow' end as direction,
            inv.currency as currency
       from public.invoices inv
       join public.parties pa on pa.id = inv.party_id
      where inv.status in ('open','partial')
        and inv.gross_amount > coalesce(inv.allocated_amount, 0)
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
      const ranked = rankCandidates(
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
      after: { scanned: txns.rowCount ?? 0, suggested, candidates },
    });
    await client.query("commit");
    return { scanned: txns.rowCount ?? 0, suggested, candidates };
  } catch (e) {
    await client.query("rollback");
    throw e;
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

/**
 * Faz 48 (D2): Accepts a bank match and atomically settles the linked financial obligation
 * (`invoices`, `payment_instances`, `checks`, or `loan_installments`) — plus any active
 * `payment_run_items` / `payment_runs` entry — inside a single locked PostgreSQL transaction.
 */
export async function acceptMatch(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(matchDecisionSchema, raw, "Eşleştirme");
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
    }>(
      `select bt.id::text, bt.status, bt.matched_entity_table, bt.matched_entity_id::text,
              bt.amount::text as amount, to_char(bt.txn_date,'YYYY-MM-DD') as txn_date,
              coalesce(bt.currency, ca.currency, 'TRY') as currency
         from public.bank_transactions bt
         left join public.cash_accounts ca on ca.id = bt.bank_account_id
        where bt.id = $1
        for update of bt`,
      [input.transactionId],
    );
    if (before.rowCount === 0) throw new DomainError("NOT_FOUND", "Banka hareketi bulunamadı.");
    const txRow = before.rows[0];
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
        allocated_amount: string;
        approval_status: string;
      }>(
        `select id::text, direction, invoice_no, status, currency,
                gross_amount::text, coalesce(allocated_amount, 0)::text as allocated_amount,
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

      const openDec = decimal(inv.gross_amount).minus(decimal(inv.allocated_amount));
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

      const updPi = await client.query(
        `update public.payment_instances
            set status = $2, paid_amount = $3::numeric, paid_at = ($4::date)::timestamptz
          where id = $1`,
        [input.targetId, nextStatus, newPaidDec.toFixed(2), txDate],
      );
      if (updPi.rowCount !== 1) {
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
        currency: string;
      }>(
        `select li.id::text, li.status, li.amount::text as amount, l.currency
           from public.loan_installments li
           join public.loans l on l.id = li.loan_id
          where li.id = $1 and l.archived_at is null
          for update of li`,
        [input.targetId],
      );
      if (liRes.rowCount === 0) throw new DomainError("NOT_FOUND", "Eşleştirilecek kredi taksiti bulunamadı.");
      const li = liRes.rows[0];
      if (!["planned", "late"].includes(li.status)) {
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
      const openInstallmentDec = decimal(li.amount);
      if (!absTxDec.eq(openInstallmentDec)) {
        throw new DomainError(
          "CONFLICT",
          `Kredi taksiti kapanışı için banka hareketi tutarı (${absTxDec.toFixed(2)} ${txCurrency}) kalan taksit tutarıyla (${openInstallmentDec.toFixed(2)} ${li.currency}) eşleşmelidir.`,
        );
      }

      const updLi = await client.query(
        `update public.loan_installments
            set status = 'paid', paid_at = ($2::date)::timestamptz
          where id = $1`,
        [input.targetId, txDate],
      );
      if (updLi.rowCount !== 1) {
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
        confidence.rows[0]?.confidence ?? null,
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

    await audit(client, {
      actor: actorId, action: "accept_bank_match", entityTable: "bank_transactions",
      entityId: input.transactionId, before: txRow,
      after: {
        status: "matched",
        matched_entity_table: input.targetTable,
        matched_entity_id: input.targetId,
        financial_record_mutated: true,
        targetFullySettled,
        settledAllocationId,
        settledRunId,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
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
    const before = await client.query(
      `select id, status, ignored_reason from public.bank_transactions where id=$1 for update`, [input.transactionId]);
    if (before.rowCount === 0) throw new DomainError("Banka hareketi bulunamadı.");
    await client.query(
      `update public.bank_transactions
         set status='ignored', ignored_reason=$2, matched_entity_table=null, matched_entity_id=null,
             match_confidence=null, matched_at=null
       where id=$1`,
      [input.transactionId, input.reason]);
    await audit(client, {
      actor: actorId, action: "ignore_bank_transaction", entityTable: "bank_transactions",
      entityId: input.transactionId, before: before.rows[0], after: { status: "ignored", reason: input.reason },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
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
            li.amount::text as open_amount,
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
            (inv.gross_amount - coalesce(inv.allocated_amount, 0))::text as open_amount,
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
    `select id::text, account_name, to_char(txn_date,'YYYY-MM-DD') as txn_date, description,
            counterparty_name_raw, amount, direction, category, category_rule, status,
            open_candidate_count, best_confidence
     from public.bank_unmatched_queue
     order by txn_date desc, abs(amount) desc, id desc limit $1 offset $2`, [limit, Math.max(0, offset)]);
  return r.rows.map((x) => ({
    id: x.id, accountName: x.account_name, txnDate: x.txn_date, description: x.description,
    counterparty: x.counterparty_name_raw, amount: moneyOrNull(x.amount) ?? 0,
    direction: x.direction as "inflow" | "outflow", category: x.category, categoryRule: x.category_rule,
    status: x.status as string,
    openCandidateCount: intOrNull(x.open_candidate_count) ?? 0,
    bestConfidence: rateOrNull(x.best_confidence),
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
              when 'loan_installments' then li.amount::text
              when 'invoices' then (inv.gross_amount - coalesce(inv.allocated_amount, 0))::text
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
