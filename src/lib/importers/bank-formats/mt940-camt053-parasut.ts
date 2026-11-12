// Faz 51 (E1) — Hybrid Bank Statement Parser & Cross-Channel Deduplicator
// (SWIFT MT940, ISO 20022 camt.053 XML, and Paraşüt Bank/Statement Excel .xlsx / .csv).
//
// Solves the Paraşüt bank surprise: unreconciled bank lines in Paraşüt do not appear in
// Paraşüt API v4 `/transactions` until matched in Paraşüt's UI. Operators can drop an MT940,
// camt.053 XML, or Paraşüt Bank Excel at any time; when the movement later arrives from
// Paraşüt API v4 (or vice versa), `cross_channel_dedupe_hash` prevents double-counting.

import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { classifyTransaction, dedupeKey, detectStatementColumns, parseStatementDate, resolveSignedAmount, statementColumnsUsable, type StatementField } from "@/lib/bank/rules";
import { DomainError } from "@/lib/domain-error";
import { cellsToRows, sha256, sheetCells, type RowJson } from "@/lib/importers/row-utils";
import { safeParseStatementBuffer } from "@/lib/importers/statement-parser";
import {
  computeCrossChannelDedupeHash,
  normalizeParasutCurrency,
} from "@/lib/integrations/parasut/mappers";
import { moneyOrNull } from "@/lib/money";

export type HybridBankFormat = "mt940" | "camt053" | "parasut_xlsx" | "csv";

export interface ParsedHybridBankLine {
  txnDate: string;
  valueDate: string | null;
  amount: number;
  currency: string;
  description: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  referenceNo: string | null;
  balanceAfter: number | null;
  channel: string;
}

export interface ParsedHybridStatement {
  ok: true;
  format: HybridBankFormat;
  accountIban: string | null;
  currency: string;
  lines: ParsedHybridBankLine[];
}

export type HybridParseResult =
  | ParsedHybridStatement
  | { ok: false; error: string };

const TR_IBAN_RE = /\b(TR\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{2})\b/i;

function extractIban(text: string): string | null {
  const m = text.match(TR_IBAN_RE);
  return m ? m[1].replace(/\s+/g, "").toUpperCase() : null;
}

function parseYymmdd(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
  return `${yyyy}-${mm}-${dd}`;
}

/* ── 1) SWIFT MT940 Parser (:20:, :25:, :60F:/:60M:, :61:, :86:, :62F:/:62M:) ─────────── */

export function parseMt940Statement(text: string): HybridParseResult {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!/:61:/.test(normalized) && !/:60[FM]:/.test(normalized)) {
    return { ok: false, error: "MT940 blok etiketleri (:60F:/:61:) bulunamadı." };
  }

  let accountIban: string | null = null;
  let statementCurrency = "TRY";
  const lines: ParsedHybridBankLine[] = [];

  // Split into tagged blocks `:TAG:content`
  const tagRegex = /^:(\d{2}[A-Z]?):(.*)$/gm;
  const blocks: Array<{ tag: string; body: string }> = [];
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = tagRegex.exec(normalized)) !== null) {
    if (blocks.length > 0 && match.index > lastIndex) {
      const extra = normalized.slice(lastIndex, match.index).trim();
      if (extra) {
        blocks[blocks.length - 1].body += "\n" + extra;
      }
    }
    blocks.push({ tag: match[1], body: match[2].trim() });
    lastIndex = match.index + match[0].length;
  }
  if (blocks.length > 0 && lastIndex < normalized.length) {
    const tail = normalized.slice(lastIndex).trim().replace(/^-\}?$/m, "").trim();
    if (tail) blocks[blocks.length - 1].body += "\n" + tail;
  }

  let pending61: ParsedHybridBankLine | null = null;

  for (const blk of blocks) {
    if (blk.tag === "25") {
      accountIban = extractIban(blk.body) ?? blk.body.replace(/\s+/g, "").slice(0, 34);
    } else if (blk.tag === "60F" || blk.tag === "60M") {
      // e.g. C261001TRY125000,00
      const m60 = blk.body.match(/^[CD](\d{6})([A-Z]{3})([\d.,]+)/);
      if (m60) {
        statementCurrency = normalizeParasutCurrency(m60[2]);
      }
    } else if (blk.tag === "61") {
      if (pending61) {
        lines.push(pending61);
        pending61 = null;
      }
      // :61:YYMMDD[MMDD](C|D|RC|RD)[A-Z]?amount(Nxxx)(ref)[//bankref]
      const firstLine = blk.body.split("\n")[0].trim();
      const m61 = firstLine.match(
        /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+(?:[.,]\d{1,2})?)([A-Z][A-Z0-9]{3})([^\n/]*)(?:\/\/(.*))?$/,
      );
      if (!m61) continue;

      const valueDate = parseYymmdd(m61[1]);
      if (!valueDate) continue;
      let txnDate = valueDate;
      if (m61[2]) {
        const yyyy = valueDate.slice(0, 4);
        txnDate = `${yyyy}-${m61[2].slice(0, 2)}-${m61[2].slice(2, 4)}`;
      }

      const dc = m61[3];
      const rawAmtStr = m61[5].replace(",", ".");
      const absAmt = moneyOrNull(rawAmtStr);
      if (absAmt == null) continue;

      // In MT940: C = Credit (+), D = Debit (-), RC = Reversal Credit (-), RD = Reversal Debit (+)
      const sign = dc === "C" || dc === "RD" ? 1 : -1;
      const signedAmount = sign * Math.abs(absAmt);
      const custRef = m61[7]?.trim() && m61[7].trim() !== "NONREF" ? m61[7].trim() : null;
      const bankRef = m61[8]?.trim() || null;

      pending61 = {
        txnDate,
        valueDate,
        amount: signedAmount,
        currency: statementCurrency,
        description: firstLine,
        counterpartyName: null,
        counterpartyIban: null,
        referenceNo: bankRef ?? custRef,
        balanceAfter: null,
        channel: "mt940",
      };
    } else if (blk.tag === "86" && pending61) {
      const narrative = blk.body.replace(/\s+/g, " ").trim();
      if (narrative) {
        pending61.description = narrative;
        pending61.counterpartyIban = extractIban(narrative);
      }
      lines.push(pending61);
      pending61 = null;
    }
  }

  if (pending61) {
    lines.push(pending61);
  }

  return {
    ok: true,
    format: "mt940",
    accountIban,
    currency: statementCurrency,
    lines,
  };
}

/* ── 2) ISO 20022 camt.053 XML Parser (<BkToCstmrStmt> / <Stmt> / <Ntry>) ─────────────── */

function xmlTagValue(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  return decodeXmlEntities(m[1].trim());
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function parseCamt053Statement(xml: string): HybridParseResult {
  if (!/<BkToCstmrStmt\b/i.test(xml) && !/<Stmt\b/i.test(xml)) {
    return { ok: false, error: "ISO 20022 camt.053 (<BkToCstmrStmt>/<Stmt>) kök etiketi bulunamadı." };
  }

  const acctBlock = xmlTagValue(xml, "Acct") ?? "";
  const accountIban = xmlTagValue(acctBlock, "IBAN") ?? extractIban(acctBlock);
  const statementCurrency = normalizeParasutCurrency(xmlTagValue(acctBlock, "Ccy") ?? "TRY");

  const lines: ParsedHybridBankLine[] = [];
  const ntryRegex = /<Ntry(?:\s[^>]*)?>([\s\S]*?)<\/Ntry>/gi;
  let m: RegExpExecArray | null;

  while ((m = ntryRegex.exec(xml)) !== null) {
    const ntry = m[1];
    const amtMatch = ntry.match(/<Amt(?:\s+[^>]*Ccy=["']([A-Z]{3})["'][^>]*)?>([\d.,\s]+)<\/Amt>/i);
    const rawAmt = amtMatch ? amtMatch[2].trim().replace(",", ".") : xmlTagValue(ntry, "Amt")?.replace(",", ".");
    const currency = normalizeParasutCurrency(amtMatch?.[1] ?? statementCurrency);
    const absAmt = rawAmt ? moneyOrNull(rawAmt) : null;
    if (absAmt == null) continue;

    const cdtDbt = (xmlTagValue(ntry, "CdtDbtInd") ?? "CRDT").toUpperCase();
    const sign = cdtDbt === "DBIT" ? -1 : 1;

    const bookgBlock = xmlTagValue(ntry, "BookgDt") ?? "";
    const valBlock = xmlTagValue(ntry, "ValDt") ?? "";
    const bookgDt =
      (xmlTagValue(bookgBlock, "Dt") ?? xmlTagValue(bookgBlock, "DtTm"))?.slice(0, 10) ?? null;
    const valDt =
      (xmlTagValue(valBlock, "Dt") ?? xmlTagValue(valBlock, "DtTm"))?.slice(0, 10) ?? null;
    const txnDate = bookgDt ?? valDt;
    if (!txnDate || !/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) continue;

    const ref =
      xmlTagValue(ntry, "AcctSvcrRef") ??
      xmlTagValue(ntry, "EndToEndId") ??
      xmlTagValue(ntry, "TxId");
    const cleanRef = ref && ref !== "NOTPROVIDED" ? ref : null;

    const ustrd = xmlTagValue(ntry, "Ustrd");
    const addtl = xmlTagValue(ntry, "AddtlNtryInf") ?? xmlTagValue(ntry, "AddtlTxInf");
    const description = [ustrd, addtl].filter(Boolean).join(" — ") || "camt.053 Hareketi";

    const rltdPties = xmlTagValue(ntry, "RltdPties") ?? "";
    const partyBlock =
      sign < 0
        ? xmlTagValue(rltdPties, "Cdtr") ?? ""
        : xmlTagValue(rltdPties, "Dbtr") ?? "";
    const partyAcctBlock =
      sign < 0
        ? xmlTagValue(rltdPties, "CdtrAcct") ?? ""
        : xmlTagValue(rltdPties, "DbtrAcct") ?? "";

    const counterpartyName = xmlTagValue(partyBlock, "Nm");
    const counterpartyIban =
      xmlTagValue(partyAcctBlock, "IBAN") ?? extractIban(description);

    lines.push({
      txnDate,
      valueDate: valDt,
      amount: sign * Math.abs(absAmt),
      currency,
      description,
      counterpartyName,
      counterpartyIban: counterpartyIban ? counterpartyIban.replace(/\s+/g, "").toUpperCase() : null,
      referenceNo: cleanRef,
      balanceAfter: null,
      channel: "camt053",
    });
  }

  return {
    ok: true,
    format: "camt053",
    accountIban: accountIban ? accountIban.replace(/\s+/g, "").toUpperCase() : null,
    currency: statementCurrency,
    lines,
  };
}

/* ── 3) Paraşüt Bank / Statement Excel (.xlsx) & CSV Parser ───────────────────────────── */

function cellVal(row: RowJson, col: string | undefined): unknown {
  if (!col) return null;
  const c = row[col];
  if (!c) return null;
  return c.w ?? c.v;
}

function cellText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export async function parseHybridBankBuffer(
  buf: Buffer,
  filename: string,
): Promise<HybridParseResult> {
  if (buf.length === 0) {
    return { ok: false, error: "Boş dosya (0 bayt)." };
  }

  const lowerName = filename.trim().toLowerCase();
  const head4 = buf.subarray(0, Math.min(4, buf.length));
  const isZip = head4.length === 4 && head4[0] === 0x50 && head4[1] === 0x4b;

  if (!isZip) {
    const utf8 = buf.toString("utf8").replace(/^\uFEFF/, "");
    if (
      lowerName.endsWith(".xml") ||
      /<BkToCstmrStmt\b/i.test(utf8) ||
      (/<\?xml\b/i.test(utf8) && /<Stmt\b/i.test(utf8))
    ) {
      return parseCamt053Statement(utf8);
    }
    if (
      lowerName.endsWith(".mt940") ||
      lowerName.endsWith(".sta") ||
      lowerName.endsWith(".940") ||
      (/:20:/.test(utf8) && /:61:/.test(utf8))
    ) {
      return parseMt940Statement(utf8);
    }
  }

  // Fallback to ExcelJS (.xlsx) or RFC-4180 CSV (Paraşüt Bank Excel / bank statement)
  const parsed = await safeParseStatementBuffer(buf, filename);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const sheetName = parsed.workbook.SheetNames[0];
  const ws = parsed.workbook.Sheets[sheetName];
  const cells = sheetCells(ws);
  const rows = cellsToRows(cells);

  let columns: Partial<Record<StatementField, string>> = {};
  let currencyCol: string | undefined;
  let headerRowIndex = -1;

  for (const row of rows.slice(0, 25)) {
    const header: Record<string, string> = {};
    for (const [col, c] of Object.entries(row.cells)) {
      const hText = String(c.w ?? c.v).trim();
      header[col] = hText;
      if (/^(d[öo]viz|para\s*birimi|currency)$/i.test(hText)) {
        currencyCol = col;
      }
    }
    const detected = detectStatementColumns(header);
    if (statementColumnsUsable(detected)) {
      columns = detected;
      headerRowIndex = row.rowIndex;
      break;
    }
  }

  if (headerRowIndex === -1) {
    return {
      ok: false,
      error: "Paraşüt/Banka Excel başlık satırı tanınmadı (Tarih ve Tutar/Borç/Alacak sütunları gerekli).",
    };
  }

  const lines: ParsedHybridBankLine[] = [];
  for (const row of rows) {
    if (row.rowIndex <= headerRowIndex) continue;
    const txnDate = parseStatementDate(cellVal(row.cells, columns.txn_date));
    const signed = resolveSignedAmount({
      amount: cellVal(row.cells, columns.amount),
      debit: cellVal(row.cells, columns.debit),
      credit: cellVal(row.cells, columns.credit),
      directionHint: cellText(cellVal(row.cells, columns.direction)),
    });
    if (!txnDate || signed == null) continue;

    const currency = normalizeParasutCurrency(cellText(cellVal(row.cells, currencyCol)) ?? "TRY");
    const description = cellText(cellVal(row.cells, columns.description)) ?? "";
    const counterpartyName = cellText(cellVal(row.cells, columns.counterparty));
    const counterpartyIban =
      cellText(cellVal(row.cells, columns.counterparty_iban))?.replace(/\s+/g, "").toUpperCase() ??
      extractIban(description);
    const referenceNo = cellText(cellVal(row.cells, columns.reference));
    const balanceAfter = resolveSignedAmount({ amount: cellVal(row.cells, columns.balance) });

    lines.push({
      txnDate,
      valueDate: parseStatementDate(cellVal(row.cells, columns.value_date)),
      amount: Number(signed),
      currency,
      description,
      counterpartyName,
      counterpartyIban,
      referenceNo,
      balanceAfter: balanceAfter != null ? Number(balanceAfter) : null,
      channel: parsed.format === "xlsx" ? "parasut_xlsx" : "csv",
    });
  }

  return {
    ok: true,
    format: parsed.format === "xlsx" ? "parasut_xlsx" : "csv",
    accountIban: null,
    currency: lines[0]?.currency ?? "TRY",
    lines,
  };
}

export interface HybridBankImportResult {
  ok: boolean;
  format?: HybridBankFormat;
  workbookId: string;
  rowsSeen: number;
  inserted: number;
  duplicates: number;
  ownTransfers: number;
  error?: string;
}

/**
 * Imports an MT940, ISO 20022 camt.053 XML, or Paraşüt Bank Excel/CSV into `public.bank_transactions`
 * with full `cross_channel_dedupe_hash` deduplication against Paraşüt API v4 `/transactions` and
 * automatic `own_transfer` detection across company IBANs.
 */
export async function importHybridBankStatement(
  pool: Pool,
  input: {
    buf: Buffer;
    filename: string;
    bankAccountId: string;
    actorId: string | null;
  },
): Promise<HybridBankImportResult> {
  const parsed = await parseHybridBankBuffer(input.buf, input.filename);
  const client = await pool.connect();

  try {
    await client.query("begin");

    const acct = await client.query<{ cash_account_id: string; iban: string | null }>(
      `select cash_account_id::text, iban from public.bank_accounts where cash_account_id = $1`,
      [input.bankAccountId],
    );
    if (acct.rowCount === 0) {
      throw new DomainError("Seçilen banka hesabı bulunamadı.");
    }

    const wb = await client.query<{ id: string }>(
      `insert into public.source_workbooks (original_filename, file_sha256, status, imported_by)
       values ($1, $2, 'pending', $3)
       returning id::text`,
      [input.filename, sha256(input.buf), input.actorId],
    );
    const workbookId = wb.rows[0].id;

    if (!parsed.ok) {
      await client.query(
        `update public.source_workbooks set status = 'failed', parse_error = $2 where id = $1`,
        [workbookId, parsed.error],
      );
      await audit(client, {
        actor: input.actorId,
        action: "import_hybrid_bank_failed",
        entityTable: "source_workbooks",
        entityId: workbookId,
        after: { filename: input.filename, error: parsed.error },
      });
      await client.query("commit");
      return {
        ok: false,
        workbookId,
        rowsSeen: 0,
        inserted: 0,
        duplicates: 0,
        ownTransfers: 0,
        error: parsed.error,
      };
    }

    // Load all company IBANs to detect inter-account transfers (own_transfer)
    const ownIbansRes = await client.query<{ iban: string }>(
      `select replace(upper(iban), ' ', '') as iban
         from public.bank_accounts
        where iban is not null and btrim(iban) <> ''`,
    );
    const ownIbans = new Set<string>(ownIbansRes.rows.map((r) => r.iban));
    const currentAccountIban = acct.rows[0].iban
      ? acct.rows[0].iban.replace(/\s+/g, "").toUpperCase()
      : null;

    let inserted = 0;
    let duplicates = 0;
    let ownTransfers = 0;
    const consumedCrossIds = new Set<string>();

    for (const line of parsed.lines) {
      const crossHash = computeCrossChannelDedupeHash({
        bankAccountId: input.bankAccountId,
        txnDate: line.txnDate,
        amount: line.amount,
        currency: line.currency,
        reference: line.referenceNo,
      });

      const alreadyExists = await client.query<{ id: string }>(
        `select id::text
           from public.bank_transactions
          where bank_account_id = $1
            and not (id = any($6::uuid[]))
            and (
              (cross_channel_dedupe_hash = $2 and channel <> $7)
              or (
                txn_date = $3::date
                and amount = $4::numeric
                and currency = $5
                and channel = 'parasut_api'
              )
            )
          order by (cross_channel_dedupe_hash = $2) desc, created_at asc
          limit 1`,
        [
          input.bankAccountId,
          crossHash,
          line.txnDate,
          line.amount,
          line.currency,
          Array.from(consumedCrossIds),
          line.channel,
        ],
      );

      if (alreadyExists.rows[0]?.id) {
        consumedCrossIds.add(alreadyExists.rows[0].id);
        await client.query(
          `update public.bank_transactions
              set cross_channel_dedupe_hash = coalesce(cross_channel_dedupe_hash, $2)
            where id = $1`,
          [alreadyExists.rows[0].id, crossHash],
        );
        duplicates++;
        continue;
      }

      const isOwnTransfer =
        Boolean(
          line.counterpartyIban &&
            ownIbans.has(line.counterpartyIban) &&
            line.counterpartyIban !== currentAccountIban,
        ) || /\bvirman\b/i.test(line.description);

      const classification = classifyTransaction({
        description: line.description,
        counterparty: line.counterpartyName,
        amount: String(line.amount),
      });
      const transactionKind = isOwnTransfer
        ? "own_transfer"
        : classification.category === "bank_fee"
          ? "bank_fee"
          : classification.category === "tax"
            ? "tax_payment"
            : classification.category === "salary"
              ? "payroll"
              : "standard";

      const lineDedupe = dedupeKey({
        txnDate: line.txnDate,
        amount: String(line.amount),
        description: line.description,
        reference: line.referenceNo,
      });

      const ins = await client.query<{ id: string }>(
        `insert into public.bank_transactions
           (bank_account_id, source_workbook_id, txn_date, value_date, description,
            counterparty_name_raw, counterparty_iban_raw, reference_no, channel,
            amount, currency, balance_after, category, category_rule,
            transaction_kind, dedupe_hash, cross_channel_dedupe_hash)
         values ($1, $2, $3::date, $4::date, $5,
                 $6, $7, $8, $9,
                 $10::numeric, $11, $12::numeric, $13, $14,
                 $15, $16, $17)
         on conflict do nothing
         returning id::text`,
        [
          input.bankAccountId,
          workbookId,
          line.txnDate,
          line.valueDate,
          line.description,
          line.counterpartyName,
          line.counterpartyIban,
          line.referenceNo,
          line.channel,
          line.amount,
          line.currency,
          line.balanceAfter,
          classification.category,
          classification.rule,
          transactionKind,
          lineDedupe,
          crossHash,
        ],
      );

      if (ins.rows[0]?.id) {
        inserted++;
        if (transactionKind === "own_transfer") ownTransfers++;
      } else {
        duplicates++;
      }
    }

    await client.query(
      `update public.source_workbooks
          set status = 'parsed',
              notes = $2
        where id = $1`,
      [
        workbookId,
        `hybrid_bank(${parsed.format}) rows=${parsed.lines.length} inserted=${inserted} duplicates=${duplicates} own_transfer=${ownTransfers}`,
      ],
    );

    await audit(client, {
      actor: input.actorId,
      action: "import_hybrid_bank_statement",
      entityTable: "bank_transactions",
      entityId: null,
      after: {
        workbookId,
        bankAccountId: input.bankAccountId,
        filename: input.filename,
        format: parsed.format,
        rowsSeen: parsed.lines.length,
        inserted,
        duplicates,
        ownTransfers,
      },
    });

    await client.query("commit");
    return {
      ok: true,
      format: parsed.format,
      workbookId,
      rowsSeen: parsed.lines.length,
      inserted,
      duplicates,
      ownTransfers,
    };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
