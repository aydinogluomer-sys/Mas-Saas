// Faz 53 (E3) — Mali Müşavir Yasal Mizan (.xlsx / .csv / .xml) İçe Aktarıcısı.
//
// Özellikler:
//   1. Luca, Logo, Mikro, Zirve, Eta ve Paraşüt standart mizan çıktılarını (.xlsx, .csv, .xml) ayrıştırır.
//   2. Türkçe sütun başlıklarını ('Hesap Kodu', 'Hesap Adı', 'Borç', 'Alacak', 'Borç Bakiyesi', 'Alacak Bakiyesi') tanır.
//   3. Ana hesap ('120') + kırılımlı alt hesap ('120.01', '120.01.005') birlikte geldiğinde
//      çift sayımı önlemek için yaprak olmayan satırları `is_leaf = false` işaretler;
//      mizan toplamlarını YALNIZ `is_leaf = true` satırlardan hesaplar ve ana hesap satırıyla
//      alt hesapların toplamını karşılaştırarak sağlama (parent assertion) uyarısı üretir.
//   4. Mizan kendi içinde dengeli değilse (`total_debit_try <> total_credit_try`) dosyayı reddetmez;
//      `is_self_balanced = false` kritik uyarısıyla kaydeder (Bayrakla, asla sessiz düzeltme!).

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { decodeTurkishCsvBuffer, parseCsvStatementBuffer } from "@/lib/importers/csv-parser";
import { decodeCell, type CellVal, type ParsedWorksheet } from "@/lib/importers/row-utils";
import { safeParseWorkbookBuffer } from "@/lib/importers/workbook-parser";
import { decimal, money } from "@/lib/money";

export interface ParsedStatutoryMizanLine {
  accountCode: string;
  tdhpRootCode: string;
  accountName: string;
  isLeaf: boolean;
  debitTotalTry: number;
  creditTotalTry: number;
  debitBalanceTry: number;
  creditBalanceTry: number;
}

export interface ParentHierarchyWarning {
  parentCode: string;
  parentDebitTry: number;
  childrenDebitTry: number;
  parentCreditTry: number;
  childrenCreditTry: number;
}

export interface ParsedStatutoryMizan {
  lines: ParsedStatutoryMizanLine[];
  leafCount: number;
  nonLeafCount: number;
  totalDebitTry: number;
  totalCreditTry: number;
  isSelfBalanced: boolean;
  parentWarnings: ParentHierarchyWarning[];
}

export interface ImportStatutoryMizanInput {
  asOfDate: string;
  periodLabel: string;
  sourceSoftware?: string | null;
  originalFilename: string;
  buffer: Buffer;
}

export interface ImportedStatutoryMizanResult {
  trialBalanceId: string;
  asOfDate: string;
  periodLabel: string;
  sourceSoftware: string | null;
  originalFilename: string;
  fileSha256: string;
  leafCount: number;
  nonLeafCount: number;
  totalDebitTry: number;
  totalCreditTry: number;
  isSelfBalanced: boolean;
  parentWarnings: ParentHierarchyWarning[];
}

function normalizeHeader(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Normalizes a Turkish TDHP account code such as `"120 01 005"` or `"120-01-005"` into `"120.01.005"`.
 * Returns `null` if the string does not start with a valid 3-digit TDHP root (`100`..`999`).
 */
export function normalizeStatutoryAccountCode(raw: unknown): {
  accountCode: string;
  tdhpRootCode: string;
} | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const lowered = normalizeHeader(s);
  if (
    lowered.startsWith("toplam") ||
    lowered.startsWith("genel toplam") ||
    lowered.startsWith("yekun") ||
    lowered.startsWith("hesap kodu")
  ) {
    return null;
  }

  // Replace spaces/hyphens/slashes between code segments with dots
  const cleaned = s
    .replace(/[\s\-/]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");

  const match = /^([1-9][0-9]{2})(?:\.([0-9A-Za-z.]+))?$/.exec(cleaned);
  if (!match) return null;

  const root = match[1];
  const rest = match[2];
  return {
    accountCode: rest ? `${root}.${rest}` : root,
    tdhpRootCode: root,
  };
}

/**
 * Parses a Turkish or international formatted number cell into a non-negative 2-decimal number.
 * Supports `"1.250.400,75"`, `"1,250,400.75"`, `"1250400.75"`, `"-"` / `""` -> `0`.
 */
export function parseTurkishMizanAmount(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.max(0, money(Math.abs(raw))) : 0;
  }
  const s0 = String(raw ?? "").trim();
  if (!s0 || s0 === "-" || s0 === "--") return 0;

  // Strip currency symbols, B/A markers, parentheses, spaces
  const s = s0
    .replace(/[₺$€£()]/g, "")
    .replace(/\b(TL|TRY|B|A|BORC|ALACAK)\b/gi, "")
    .trim();
  if (!s) return 0;

  let normalized = s;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma > lastDot) {
    // Turkish format: 1.234.567,89
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma && lastComma !== -1) {
    // US format: 1,234,567.89
    normalized = s.replace(/,/g, "");
  } else if (lastDot !== -1 && s.indexOf(".") !== lastDot) {
    // Multiple dots and no comma: 1.234.567 (integer thousands)
    normalized = s.replace(/\./g, "");
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, money(Math.abs(n)));
}

interface RawMizanCandidateRow {
  accountCode: string;
  tdhpRootCode: string;
  accountName: string;
  debitTotalTry: number;
  creditTotalTry: number;
  debitBalanceTry: number | null;
  creditBalanceTry: number | null;
}

function finalizeHierarchyAndTotals(rawRows: RawMizanCandidateRow[]): ParsedStatutoryMizan {
  if (rawRows.length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Yüklenen mizan dosyasında geçerli hiçbir TDHP hesap satırı (100-999) bulunamadı.",
    );
  }

  // Deduplicate identical account_code rows by summing or keeping the last explicit row
  // (in standard Luca/Logo mizans each account_code is unique; if repeated, keep last non-empty)
  const byCode = new Map<string, RawMizanCandidateRow>();
  for (const r of rawRows) {
    byCode.set(r.accountCode, r);
  }
  const uniqueRows = Array.from(byCode.values()).sort((a, b) =>
    a.accountCode.localeCompare(b.accountCode, "tr-TR"),
  );

  const allCodes = uniqueRows.map((r) => r.accountCode);

  const lines: ParsedStatutoryMizanLine[] = uniqueRows.map((row) => {
    const isAncestorOfAnother = allCodes.some(
      (other) =>
        other !== row.accountCode &&
        (other.startsWith(`${row.accountCode}.`) ||
          (row.accountCode.length === 3 && other.startsWith(row.accountCode))),
    );

    const net = Number(decimal(row.debitTotalTry).minus(row.creditTotalTry).round(2).toFixed(2));
    const computedDebitBal = net > 0 ? net : 0;
    const computedCreditBal = net < 0 ? Math.abs(net) : 0;

    return {
      accountCode: row.accountCode,
      tdhpRootCode: row.tdhpRootCode,
      accountName: row.accountName || `Hesap ${row.accountCode}`,
      isLeaf: !isAncestorOfAnother,
      debitTotalTry: row.debitTotalTry,
      creditTotalTry: row.creditTotalTry,
      debitBalanceTry: row.debitBalanceTry !== null ? row.debitBalanceTry : computedDebitBal,
      creditBalanceTry: row.creditBalanceTry !== null ? row.creditBalanceTry : computedCreditBal,
    };
  });

  // Verify parent rows against the sum of their leaf descendants
  const parentWarnings: ParentHierarchyWarning[] = [];
  for (const parent of lines) {
    if (parent.isLeaf) continue;
    const leafDescendants = lines.filter(
      (child) =>
        child.isLeaf &&
        child.accountCode !== parent.accountCode &&
        (child.accountCode.startsWith(`${parent.accountCode}.`) ||
          (parent.accountCode.length === 3 && child.accountCode.startsWith(parent.accountCode))),
    );
    if (leafDescendants.length === 0) continue;

    let childrenDebit = decimal(0);
    let childrenCredit = decimal(0);
    for (const c of leafDescendants) {
      childrenDebit = childrenDebit.plus(c.debitTotalTry);
      childrenCredit = childrenCredit.plus(c.creditTotalTry);
    }
    const cd = Number(childrenDebit.round(2).toFixed(2));
    const cc = Number(childrenCredit.round(2).toFixed(2));

    if (
      Math.abs(parent.debitTotalTry - cd) > 0.01 ||
      Math.abs(parent.creditTotalTry - cc) > 0.01
    ) {
      parentWarnings.push({
        parentCode: parent.accountCode,
        parentDebitTry: parent.debitTotalTry,
        childrenDebitTry: cd,
        parentCreditTry: parent.creditTotalTry,
        childrenCreditTry: cc,
      });
    }
  }

  let totalDebit = decimal(0);
  let totalCredit = decimal(0);
  let leafCount = 0;
  let nonLeafCount = 0;

  for (const line of lines) {
    if (line.isLeaf) {
      leafCount += 1;
      totalDebit = totalDebit.plus(line.debitTotalTry);
      totalCredit = totalCredit.plus(line.creditTotalTry);
    } else {
      nonLeafCount += 1;
    }
  }

  const totalDebitTry = Number(totalDebit.round(2).toFixed(2));
  const totalCreditTry = Number(totalCredit.round(2).toFixed(2));

  return {
    lines,
    leafCount,
    nonLeafCount,
    totalDebitTry,
    totalCreditTry,
    isSelfBalanced: totalDebit.round(2).eq(totalCredit.round(2)),
    parentWarnings,
  };
}

function parseAoaMizanRows(aoa: unknown[][]): ParsedStatutoryMizan {
  let headerRowIdx = -1;
  let colCode = 0;
  let colName = 1;
  let colDebit = 2;
  let colCredit = 3;
  let colDebitBal = -1;
  let colCreditBal = -1;

  for (let i = 0; i < Math.min(aoa.length, 25); i++) {
    const row = aoa[i] ?? [];
    const normCells = row.map((c) => normalizeHeader(c));
    const codeIdx = normCells.findIndex(
      (h) =>
        h === "hesap kodu" ||
        h === "hesap no" ||
        h === "kod" ||
        h === "kebir kodu" ||
        h === "account code" ||
        h.includes("hesap kod"),
    );
    const debitIdx = normCells.findIndex(
      (h) =>
        h === "borc" ||
        h === "borc toplami" ||
        h === "borc tutari" ||
        h === "toplam borc" ||
        h === "debit" ||
        (h.includes("borc") && !h.includes("bakiye")),
    );
    if (codeIdx !== -1 && debitIdx !== -1) {
      headerRowIdx = i;
      colCode = codeIdx;
      const nameIdx = normCells.findIndex(
        (h, idx) =>
          idx !== codeIdx &&
          (h.includes("hesap ad") ||
            h.includes("aciklama") ||
            h === "ad" ||
            h === "unvan" ||
            h.includes("account name")),
      );
      colName = nameIdx !== -1 ? nameIdx : codeIdx + 1;
      colDebit = debitIdx;
      const creditIdx = normCells.findIndex(
        (h) =>
          h === "alacak" ||
          h === "alacak toplami" ||
          h === "alacak tutari" ||
          h === "toplam alacak" ||
          h === "credit" ||
          (h.includes("alacak") && !h.includes("bakiye")),
      );
      colCredit = creditIdx !== -1 ? creditIdx : debitIdx + 1;
      colDebitBal = normCells.findIndex(
        (h) => h.includes("borc bakiye") || h === "bakiye borc" || h === "debit balance",
      );
      colCreditBal = normCells.findIndex(
        (h) => h.includes("alacak bakiye") || h === "bakiye alacak" || h === "credit balance",
      );
      break;
    }
  }

  const startIdx = headerRowIdx !== -1 ? headerRowIdx + 1 : 0;
  const candidates: RawMizanCandidateRow[] = [];

  for (let i = startIdx; i < aoa.length; i++) {
    const row = aoa[i] ?? [];
    if (row.length < 3) continue;
    const normCode = normalizeStatutoryAccountCode(row[colCode]);
    if (!normCode) continue;

    const accountName = String(row[colName] ?? "").trim() || `TDHP ${normCode.accountCode}`;
    const debitTotalTry = parseTurkishMizanAmount(row[colDebit]);
    const creditTotalTry = parseTurkishMizanAmount(row[colCredit]);
    const debitBalanceTry =
      colDebitBal !== -1 && row[colDebitBal] !== undefined && String(row[colDebitBal]).trim() !== ""
        ? parseTurkishMizanAmount(row[colDebitBal])
        : null;
    const creditBalanceTry =
      colCreditBal !== -1 &&
      row[colCreditBal] !== undefined &&
      String(row[colCreditBal]).trim() !== ""
        ? parseTurkishMizanAmount(row[colCreditBal])
        : null;

    candidates.push({
      accountCode: normCode.accountCode,
      tdhpRootCode: normCode.tdhpRootCode,
      accountName,
      debitTotalTry,
      creditTotalTry,
      debitBalanceTry,
      creditBalanceTry,
    });
  }

  return finalizeHierarchyAndTotals(candidates);
}

function extractXmlTag(block: string, tagNames: string[]): string | null {
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = re.exec(block);
    if (m && m[1] !== undefined) {
      return m[1].trim();
    }
    const attrRe = new RegExp(`\\b${tag}\\s*=\\s*["']([^"']+)["']`, "i");
    const attrM = attrRe.exec(block);
    if (attrM && attrM[1] !== undefined) {
      return attrM[1].trim();
    }
  }
  return null;
}

function parseXmlMizanText(xmlText: string): ParsedStatutoryMizan {
  const candidates: RawMizanCandidateRow[] = [];
  const rowBlockRe =
    /<(Satir|Row|Hesap|Account|MizanSatir|Line|AccountBalance)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;

  while ((m = rowBlockRe.exec(xmlText)) !== null) {
    const fullBlock = m[0];
    const codeRaw = extractXmlTag(fullBlock, [
      "HesapKodu",
      "AccountCode",
      "Kod",
      "Code",
      "KebirKodu",
      "account_code",
    ]);
    const normCode = normalizeStatutoryAccountCode(codeRaw);
    if (!normCode) continue;

    const nameRaw =
      extractXmlTag(fullBlock, [
        "HesapAdi",
        "AccountName",
        "Ad",
        "Name",
        "Aciklama",
        "account_name",
      ]) ?? `TDHP ${normCode.accountCode}`;
    const debitRaw = extractXmlTag(fullBlock, [
      "BorcToplami",
      "Borc",
      "DebitTotal",
      "Debit",
      "borc_toplami",
      "borc",
    ]);
    const creditRaw = extractXmlTag(fullBlock, [
      "AlacakToplami",
      "Alacak",
      "CreditTotal",
      "Credit",
      "alacak_toplami",
      "alacak",
    ]);
    const debitBalRaw = extractXmlTag(fullBlock, [
      "BorcBakiyesi",
      "BakiyeBorc",
      "DebitBalance",
      "borc_bakiyesi",
    ]);
    const creditBalRaw = extractXmlTag(fullBlock, [
      "AlacakBakiyesi",
      "BakiyeAlacak",
      "CreditBalance",
      "alacak_bakiyesi",
    ]);

    candidates.push({
      accountCode: normCode.accountCode,
      tdhpRootCode: normCode.tdhpRootCode,
      accountName: nameRaw,
      debitTotalTry: parseTurkishMizanAmount(debitRaw),
      creditTotalTry: parseTurkishMizanAmount(creditRaw),
      debitBalanceTry: debitBalRaw !== null ? parseTurkishMizanAmount(debitBalRaw) : null,
      creditBalanceTry: creditBalRaw !== null ? parseTurkishMizanAmount(creditBalRaw) : null,
    });
  }

  return finalizeHierarchyAndTotals(candidates);
}

function sheetToAoa(ws: ParsedWorksheet): unknown[][] {
  const ref = typeof ws["!ref"] === "string" ? ws["!ref"] : "";
  if (!ref) return [];
  const parts = ref.split(":");
  const end = decodeCell(parts[1] ?? parts[0]);
  const rows: unknown[][] = Array.from({ length: end.r + 1 }, () => []);
  for (const [addr, cell] of Object.entries(ws)) {
    if (addr.startsWith("!") || !cell || typeof cell !== "object") continue;
    const { r, c } = decodeCell(addr);
    const cv = cell as CellVal;
    if (!rows[r]) rows[r] = [];
    rows[r][c] = cv.w ?? cv.v ?? "";
  }
  return rows;
}

/**
 * Parses a Statutory Mizan file buffer (`.xlsx`, `.csv`/`.tsv`, or `.xml`) in memory.
 */
export async function parseStatutoryMizanBuffer(
  buffer: Buffer,
  filename: string,
): Promise<ParsedStatutoryMizan> {
  if (!buffer || buffer.length === 0) {
    throw new DomainError("VALIDATION_ERROR", "Yüklenen mizan dosyası boş (0 bayt).");
  }

  const lowerName = filename.trim().toLowerCase();
  const isZipHeader =
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04;

  if (isZipHeader || lowerName.endsWith(".xlsx")) {
    const parsed = await safeParseWorkbookBuffer(buffer);
    if (!parsed.ok) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Mizan Excel dosyası okunamadı: ${parsed.error}`,
      );
    }
    const firstSheetName = parsed.workbook.SheetNames[0];
    const sheet = firstSheetName ? parsed.workbook.Sheets[firstSheetName] : undefined;
    if (!sheet) {
      throw new DomainError("VALIDATION_ERROR", "Mizan çalışma kitabında sayfa bulunamadı.");
    }
    const aoa = sheetToAoa(sheet);
    return parseAoaMizanRows(aoa);
  }

  const decoded = decodeTurkishCsvBuffer(buffer);
  const trimmedText = decoded.text.trim();
  if (lowerName.endsWith(".xml") || trimmedText.startsWith("<?xml") || trimmedText.startsWith("<")) {
    return parseXmlMizanText(trimmedText);
  }

  const csvRes = parseCsvStatementBuffer(buffer);
  if (!csvRes.ok) {
    throw new DomainError("VALIDATION_ERROR", `Mizan CSV dosyası okunamadı: ${csvRes.error}`);
  }
  return parseAoaMizanRows(csvRes.rows);
}

/**
 * Imports a Statutory CPA Mizan into `public.statutory_trial_balances` and
 * `public.statutory_trial_balance_lines` and records an audit trail entry.
 */
export async function importStatutoryMizan(
  poolOrClient: Pool | PoolClient,
  input: ImportStatutoryMizanInput,
  actorId: string,
): Promise<ImportedStatutoryMizanResult> {
  const parsed = await parseStatutoryMizanBuffer(input.buffer, input.originalFilename);
  const fileSha256 = createHash("sha256").update(input.buffer).digest("hex");

  const isPool = "connect" in poolOrClient && typeof poolOrClient.connect === "function";
  const client = isPool
    ? await (poolOrClient as Pool).connect()
    : (poolOrClient as PoolClient);

  try {
    if (isPool) await client.query("begin");

    const headerRes = await client.query<{ id: string; is_self_balanced: boolean }>(
      `insert into public.statutory_trial_balances
         (as_of_date, period_label, source_software, original_filename, file_sha256,
          total_debit_try, total_credit_try, imported_by)
       values ($1::date, $2, $3, $4, $5, $6::numeric(16,2), $7::numeric(16,2), $8)
       returning id::text, is_self_balanced`,
      [
        input.asOfDate,
        input.periodLabel.trim(),
        input.sourceSoftware?.trim() || "Luca / Logo / Standart Mizan",
        input.originalFilename.trim(),
        fileSha256,
        parsed.totalDebitTry.toFixed(2),
        parsed.totalCreditTry.toFixed(2),
        actorId,
      ],
    );
    const trialBalanceId = headerRes.rows[0].id;

    for (const line of parsed.lines) {
      await client.query(
        `insert into public.statutory_trial_balance_lines
           (trial_balance_id, account_code, tdhp_root_code, account_name, is_leaf,
            debit_total_try, credit_total_try, debit_balance_try, credit_balance_try)
         values ($1, $2, $3, $4, $5, $6::numeric(16,2), $7::numeric(16,2), $8::numeric(16,2), $9::numeric(16,2))`,
        [
          trialBalanceId,
          line.accountCode,
          line.tdhpRootCode,
          line.accountName,
          line.isLeaf,
          line.debitTotalTry.toFixed(2),
          line.creditTotalTry.toFixed(2),
          line.debitBalanceTry.toFixed(2),
          line.creditBalanceTry.toFixed(2),
        ],
      );
    }

    await audit(client, {
      actor: actorId,
      action: "statutory_mizan_imported",
      entityTable: "statutory_trial_balances",
      entityId: trialBalanceId,
      after: {
        asOfDate: input.asOfDate,
        periodLabel: input.periodLabel,
        originalFilename: input.originalFilename,
        fileSha256,
        leafCount: parsed.leafCount,
        nonLeafCount: parsed.nonLeafCount,
        totalDebitTry: parsed.totalDebitTry,
        totalCreditTry: parsed.totalCreditTry,
        isSelfBalanced: headerRes.rows[0].is_self_balanced,
        parentWarningCount: parsed.parentWarnings.length,
      },
    });

    if (isPool) await client.query("commit");

    return {
      trialBalanceId,
      asOfDate: input.asOfDate,
      periodLabel: input.periodLabel,
      sourceSoftware: input.sourceSoftware?.trim() || "Luca / Logo / Standart Mizan",
      originalFilename: input.originalFilename,
      fileSha256,
      leafCount: parsed.leafCount,
      nonLeafCount: parsed.nonLeafCount,
      totalDebitTry: parsed.totalDebitTry,
      totalCreditTry: parsed.totalCreditTry,
      isSelfBalanced: headerRes.rows[0].is_self_balanced,
      parentWarnings: parsed.parentWarnings,
    };
  } catch (err) {
    if (isPool) await client.query("rollback");
    throw err;
  } finally {
    if (isPool) client.release();
  }
}
