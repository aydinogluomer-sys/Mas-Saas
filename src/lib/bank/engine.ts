// Faz 20 — bank statement import, classification, matching and reconciliation.
//
// Inherited rules, applied rather than re-argued:
//   Faz 2  — statements go through the SAME staging layer as every other upload
//            (source_workbooks → source_sheets → source_cells → import_rows), and each
//            bank_transaction keeps source_row_id so it can be traced back to the raw cells.
//   Faz 17 — money crosses the SQL/JS boundary through @/lib/money, never a ::float8 cast.
//   Faz 18 — every mutation records through the canonical audit(), in the same transaction as
//            the change, and input is parsed with a Zod schema at the boundary.
//   Faz 19 — nothing here creates a counterparty. A statement line's counterparty name is kept
//            as raw text (counterparty_name_raw), exactly as checks keep counterparty_label.
//
// NO BANK API. implementation.md defers live bank connections to Faz 37; this phase is
// file-import only, and there is deliberately no code here that opens a socket to a bank.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import * as XLSX from "xlsx";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { safeParseStatementBuffer } from "@/lib/importers/statement-parser";
import { cellsToRows, sha256, sheetCells, hashRow, type RowJson } from "@/lib/importers/row-utils";
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
  targetTable: z.enum(["payment_instances", "checks", "loan_installments"]),
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

/** Reads a canonical field out of a staged row. */
function cell(row: RowJson, col: string | undefined): unknown {
  if (!col) return null;
  const c = row[col];
  if (!c) return null;
  // Prefer the formatted text: it preserves the bank's own "1.234,56" spelling, which the
  // rules module needs in order to disambiguate the separator convention.
  return c.w ?? c.v;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * Import one statement file for one bank account.
 *
 * The account is chosen by the operator, never inferred from the file. That is why
 * `detected_type` is set to 'bank_statement' explicitly here rather than by
 * classifySheetName — see the note on the SheetDetectedType union.
 *
 * Header detection scans the first 25 rows for the first row whose cells map to a usable set
 * of columns, because bank exports routinely start with several title/metadata lines before
 * the real header.
 */
export async function importBankStatement(
  pool: Pool,
  buf: Buffer,
  originalFilename: string,
  bankAccountId: string,
  actorId: string,
): Promise<StatementImportResult> {
  const parsed = safeParseStatementBuffer(buf, originalFilename);

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
    const range = ref ? XLSX.utils.decode_range(ref) : null;

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

    // Preserve every populated cell first — the Faz 2 contract, unchanged.
    for (const c of cells) {
      await client.query(
        `insert into public.source_cells
           (workbook_id, sheet_id, row_index, column_index, address, raw_value, normalized_value, inferred_type, formula)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [workbookId, sheetId, c.rowIndex, c.columnIndex, c.address,
         c.cell.w ?? String(c.cell.v), String(c.cell.v), c.cell.t, c.cell.f ?? null],
      );
    }

    const rows = cellsToRows(cells);

    // Find the header row: first row in the first 25 that yields a usable column map.
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

      // A row missing either is not a transaction — a totals line, a blank, a footer. Counted
      // and reported, never silently dropped and never guessed into existence.
      if (!txnDate || signed == null) {
        skipped++;
        if (skippedReasons.length < 5) {
          skippedReasons.push(`satır ${row.rowIndex}: ${!txnDate ? "tarih okunamadı" : "tutar okunamadı"}`);
        }
        continue;
      }

      // Stage the row so the transaction has real lineage.
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

      // ON CONFLICT DO NOTHING is the duplicate detector: re-importing an overlapping window
      // collapses onto the existing row instead of doubling the account's turnover.
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

/* ── matching ─────────────────────────────────────────────────────────────────────────── */

/**
 * Load open financial records a statement line could correspond to.
 *
 * Only the three entities that EXIST today. Invoices and collections are Faz 22's work and are
 * deliberately absent rather than stubbed.
 */
async function loadMatchTargets(client: PoolClient, txnDate: string, windowDays = 10): Promise<MatchTarget[]> {
  const res = await client.query(
    `select 'payment_instances' as table_name, i.id::text, i.amount, to_char(i.due_date,'YYYY-MM-DD') as due_date,
            coalesce(p.name, '') as label
       from public.payment_instances i
       left join public.payments p on p.id = i.payment_id
      where i.status in ('unpaid','partial','planned','late')
        and i.due_date between $1::date - $2::int and $1::date + $2::int
     union all
     select 'checks', c.id::text, c.amount, to_char(c.maturity_date,'YYYY-MM-DD'),
            coalesce(c.counterparty_label, '')
       from public.checks c
      where c.status in ('planned','unknown') and c.archived_at is null
        and c.maturity_date between $1::date - $2::int and $1::date + $2::int
     union all
     select 'loan_installments', li.id::text, li.amount, to_char(li.due_date,'YYYY-MM-DD'),
            coalesce(l.name, '')
       from public.loan_installments li
       join public.loans l on l.id = li.loan_id
      where li.status in ('planned','unpaid','partial','late') and l.archived_at is null
        and li.due_date between $1::date - $2::int and $1::date + $2::int`,
    [txnDate, windowDays],
  );
  return res.rows.map((r) => ({
    table: r.table_name as MatchTarget["table"],
    id: r.id,
    amount: moneyOrNull(r.amount),
    dueDate: r.due_date,
    label: r.label || null,
  }));
}

export interface MatchRunResult { scanned: number; suggested: number; candidates: number }

/**
 * Score every unmatched transaction against open records and record the candidates.
 *
 * Read-only with respect to financial records: it writes candidate rows and moves transactions
 * from 'unmatched' to 'suggested'. It never sets a match — accepting is a human act.
 */
export async function runMatcher(pool: Pool, actorId: string, limit = 500): Promise<MatchRunResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const txns = await client.query(
      `select id, to_char(txn_date,'YYYY-MM-DD') as txn_date, amount, description, counterparty_name_raw
       from public.bank_transactions
       where status = 'unmatched'
       order by txn_date desc limit $1`,
      [limit],
    );

    let suggested = 0;
    let candidates = 0;
    for (const t of txns.rows) {
      const amount = moneyOrNull(t.amount);
      if (amount == null) continue;
      const targets = await loadMatchTargets(client, t.txn_date);
      const ranked = rankCandidates(
        { amount, txnDate: t.txn_date, description: t.description, counterparty: t.counterparty_name_raw },
        targets,
      );
      // Candidates the operator already rejected must not come back.
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

/** Accept a match. The transaction moves to 'matched'; the financial record is NOT mutated. */
export async function acceptMatch(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(matchDecisionSchema, raw, "Eşleştirme");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, matched_entity_table, matched_entity_id from public.bank_transactions where id=$1 for update`,
      [input.transactionId]);
    if (before.rowCount === 0) throw new DomainError("Banka hareketi bulunamadı.");
    const current = before.rows[0].status as string;
    if (!["unmatched", "suggested"].includes(current)) {
      // The transition guard would refuse this anyway; failing here turns a raw trigger message
      // into something the operator can act on.
      throw new DomainError(`'${current}' durumundaki bir hareket doğrudan eşleştirilemez.`);
    }

    const confidence = await client.query(
      `select confidence from public.bank_transaction_match_candidates
       where bank_transaction_id=$1 and target_table=$2 and target_id=$3`,
      [input.transactionId, input.targetTable, input.targetId]);

    await client.query(
      `update public.bank_transactions
         set status='matched', matched_entity_table=$2, matched_entity_id=$3,
             match_confidence=$4::numeric, matched_at=now(), ignored_reason=null
       where id=$1`,
      [input.transactionId, input.targetTable, input.targetId, confidence.rows[0]?.confidence ?? null],
    );

    await audit(client, {
      actor: actorId, action: "accept_bank_match", entityTable: "bank_transactions",
      entityId: input.transactionId, before: before.rows[0],
      after: {
        status: "matched", matched_entity_table: input.targetTable, matched_entity_id: input.targetId,
        // Recorded explicitly: accepting a bank match does NOT mark a payment paid. Faz 20
        // reconciles the statement against the plan; changing a payment's own status stays an
        // independent, separately audited act.
        financial_record_mutated: false,
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

/** Reject a suggestion. Remembered, so the matcher does not propose it again. */
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

    // With no open candidates left the line goes back to the unmatched queue — the rejection
    // path the status allow-list exists for.
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

/** Mark a line as needing no match. A reason is mandatory (0042's CHECK enforces it too). */
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

/** Finalize a matched line. Reversible via reconciled → matched (see 0042's allow-list). */
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
    await client.query(
      `update public.bank_transactions set status='reconciled', reconciled_at=now() where id=$1`, [transactionId]);
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

/* ── read side ────────────────────────────────────────────────────────────────────────── */

export async function loadUnmatchedQueue(pool: Pool, limit = 100) {
  const r = await pool.query(
    `select id::text, account_name, to_char(txn_date,'YYYY-MM-DD') as txn_date, description,
            counterparty_name_raw, amount, direction, category, category_rule, status,
            open_candidate_count, best_confidence
     from public.bank_unmatched_queue
     order by txn_date desc, abs(amount) desc limit $1`, [limit]);
  return r.rows.map((x) => ({
    id: x.id, accountName: x.account_name, txnDate: x.txn_date, description: x.description,
    counterparty: x.counterparty_name_raw, amount: moneyOrNull(x.amount) ?? 0,
    direction: x.direction as "inflow" | "outflow", category: x.category, categoryRule: x.category_rule,
    status: x.status as string,
    openCandidateCount: intOrNull(x.open_candidate_count) ?? 0,
    bestConfidence: rateOrNull(x.best_confidence),
  }));
}

export async function loadCandidates(pool: Pool, transactionId: string) {
  const r = await pool.query(
    `select id::text, target_table, target_id::text, confidence, reasons,
            (rejected_at is not null) as rejected
     from public.bank_transaction_match_candidates
     where bank_transaction_id=$1 order by rejected, confidence desc`, [transactionId]);
  return r.rows.map((x) => ({
    id: x.id, targetTable: x.target_table, targetId: x.target_id,
    confidence: rateOrNull(x.confidence) ?? 0, reasons: (x.reasons ?? []) as string[],
    rejected: x.rejected as boolean,
  }));
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

/** Two statement lines claiming one financial record — reported, never auto-resolved. */
export async function loadMatchConflicts(pool: Pool) {
  const r = await pool.query(
    `select matched_entity_table, matched_entity_id::text, claim_count, claimed_total
     from public.bank_match_conflicts order by claim_count desc limit 50`);
  return r.rows.map((x) => ({
    targetTable: x.matched_entity_table, targetId: x.matched_entity_id,
    claimCount: intOrNull(x.claim_count) ?? 0, claimedTotal: moneyOrNull(x.claimed_total) ?? 0,
  }));
}

/** Cash accounts that could be given banking detail. */
export async function loadBankableAccounts(pool: Pool) {
  const r = await pool.query(
    `select ca.id::text, ca.name, ca.account_type, (ba.cash_account_id is not null) as has_bank_profile,
            ba.iban_normalized, ba.bank_name
     from public.cash_accounts ca
     left join public.bank_accounts ba on ba.cash_account_id = ca.id
     where ca.is_active order by ca.name`);
  return r.rows as Array<{
    id: string; name: string; account_type: string; has_bank_profile: boolean;
    iban_normalized: string | null; bank_name: string | null;
  }>;
}
