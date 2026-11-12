// Faz 48 (D2) — ISO 20022 `pain.001.001.03` XML & 4-Bank (Garanti BBVA, İş Bankası, Yapı Kredi, Akbank)
// Bulk EFT / Havale CSV + ExcelJS `.xlsx` Exporter with BEC Fraud Shield.
//
// Security & Financial Guarantees:
//   1. Maker-Checker Gate: `payment_runs.status` MUST be in `('approved', 'exported', 'settled')`.
//      Any `draft`, `pending_approval`, or `cancelled` run is strictly rejected (`FORBIDDEN`).
//   2. BEC Fraud Shield: Every active item MUST carry a valid 26-char TR IBAN passing ISO 7064 MOD-97 == 1,
//      `iban_verified = true`, AND (when linked to `public.ibans`) live `is_active = true` +
//      `approval_status = 'approved'`.
//   3. Zero `float8`: Control sums (`<CtrlSum>`) and item amounts are summed in `decimal()` (`@/lib/money`).
//   4. Injection Hardening: Strict XML 1.0 entity escaping + control-char stripping for `pain.001`, and
//      spreadsheet formula-injection neutralization (`=`, `+`, `-`, `@`, `\t`, `\r` prefixing) for CSV/XLSX.

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { isTurkishIban, isValidIbanChecksum, normalizeIban } from "@/lib/counterparties/rules";
import { DomainError } from "@/lib/domain-error";
import { decimal } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";

export const PAYMENT_RUN_EXPORT_FORMATS = [
  "pain001",
  "garanti_csv",
  "garanti_xlsx",
  "isbank_csv",
  "isbank_xlsx",
  "yapikredi_csv",
  "yapikredi_xlsx",
  "akbank_csv",
  "akbank_xlsx",
] as const;

export type PaymentRunExportFormat = (typeof PAYMENT_RUN_EXPORT_FORMATS)[number];

export const exportPaymentRunSchema = z.object({
  runId: z.uuid(),
  format: z.enum(PAYMENT_RUN_EXPORT_FORMATS).default("pain001"),
  debtorName: z.string().trim().min(1).max(70).optional(),
});

/** Strip XML 1.0 illegal control characters and escape XML special entities. */
export function escapeXml(raw: string): string {
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
  return cleaned
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Neutralizes CSV / Excel formula injection (OWASP CSV Injection) on untrusted text fields
 * while preserving numeric columns untouched.
 */
export function sanitizeSpreadsheetText(raw: string): string {
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ").trim();
  if (/^[=+\-@\t\r]/.test(cleaned)) {
    return `'${cleaned}`;
  }
  return cleaned;
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n;]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function encodeRfc4180Csv(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): Buffer {
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((r) => r.map(escapeCsvCell).join(",")),
  ];
  // UTF-8 BOM so Turkish banking portals & desktop Excel decode Turkish characters cleanly
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

async function encodeBankXlsx(
  sheetTitle: string,
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): Promise<Buffer> {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "MAS Nakit Radar";
  const ws = wb.addWorksheet(sheetTitle.slice(0, 31));
  ws.addRow([...headers]);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow([...r]);
  }
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab);
}

/** TR IBAN chars 4..9 (5 digits after TR + 2 check digits) carry the TCMB bank code. */
function extractTrBankCode(normalizedIban: string): string {
  return normalizedIban.slice(4, 9);
}

interface ValidatedExportItem {
  id: string;
  endToEndId: string;
  beneficiaryName: string;
  beneficiaryIban: string;
  amountFixed: string;
  currency: string;
  dueDate: string | null;
  description: string;
  sameBank: boolean;
}

type BankTemplateKey = "garanti" | "isbank" | "yapikredi" | "akbank";

const BANK_TEMPLATE_META: Record<
  BankTemplateKey,
  { sheetTitle: string; headers: readonly string[] }
> = {
  garanti: {
    sheetTitle: "Garanti_Toplu_Odeme",
    headers: [
      "SiraNo",
      "TransferTipi",
      "AliciUnvan",
      "AliciIBAN",
      "Tutar",
      "Doviz",
      "ValörTarihi",
      "Aciklama",
      "ReferansNo",
    ],
  },
  isbank: {
    sheetTitle: "IsBankasi_Toplu_EFT",
    headers: [
      "IslemSira",
      "OdemeTuru",
      "AlacakliAdi",
      "AlacakliIBAN",
      "OdemeTutari",
      "ParaBirimi",
      "OdemeTarihi",
      "IslemAciklamasi",
      "UctanUcaRef",
    ],
  },
  yapikredi: {
    sheetTitle: "YapiKredi_Toplu_Transfer",
    headers: [
      "KayitNo",
      "Kanal",
      "LehdarUnvan",
      "LehdarIBAN",
      "Tutar",
      "ParaBirimi",
      "PlanlananTarih",
      "Aciklama",
      "PaketReferans",
    ],
  },
  akbank: {
    sheetTitle: "Akbank_Toplu_Odeme",
    headers: [
      "SatirNo",
      "IslemTipi",
      "AliciAdiSoyadiUnvani",
      "AliciIBAN",
      "IslemTutari",
      "DovizKodu",
      "IslemTarihi",
      "OdemeAciklamasi",
      "ReferansKodu",
    ],
  },
};

function buildPain001Xml(params: {
  runCode: string;
  createdIsoUtc: string;
  executionDate: string;
  debtorName: string;
  debtorIban: string;
  debtorBic: string | null;
  controlSumFixed: string;
  items: readonly ValidatedExportItem[];
}): Buffer {
  const {
    runCode,
    createdIsoUtc,
    executionDate,
    debtorName,
    debtorIban,
    debtorBic,
    controlSumFixed,
    items,
  } = params;

  const msgId = escapeXml(runCode.slice(0, 35));
  const pmtInfId = escapeXml(`${runCode}-PMT`.slice(0, 35));
  const nbOfTxs = String(items.length);
  const finInstnIdXml = debtorBic
    ? `<BIC>${escapeXml(debtorBic.toUpperCase())}</BIC>`
    : `<Othr><Id>NOTPROVIDED</Id></Othr>`;

  const txBlocks = items
    .map((it) => {
      const nm = escapeXml(it.beneficiaryName.slice(0, 70));
      const ustrd = escapeXml(it.description.slice(0, 140));
      const e2e = escapeXml(it.endToEndId.slice(0, 35));
      return [
        "      <CdtTrfTxInf>",
        "        <PmtId>",
        `          <EndToEndId>${e2e}</EndToEndId>`,
        "        </PmtId>",
        "        <Amt>",
        `          <InstdAmt Ccy="${escapeXml(it.currency)}">${it.amountFixed}</InstdAmt>`,
        "        </Amt>",
        "        <Cdtr>",
        `          <Nm>${nm}</Nm>`,
        "        </Cdtr>",
        "        <CdtrAcct>",
        "          <Id>",
        `            <IBAN>${escapeXml(it.beneficiaryIban)}</IBAN>`,
        "          </Id>",
        "        </CdtrAcct>",
        "        <RmtInf>",
        `          <Ustrd>${ustrd}</Ustrd>`,
        "        </RmtInf>",
        "      </CdtTrfTxInf>",
      ].join("\n");
    })
    .join("\n");

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">',
    "  <CstmrCdtTrfInitn>",
    "    <GrpHdr>",
    `      <MsgId>${msgId}</MsgId>`,
    `      <CreDtTm>${escapeXml(createdIsoUtc)}</CreDtTm>`,
    `      <NbOfTxs>${nbOfTxs}</NbOfTxs>`,
    `      <CtrlSum>${controlSumFixed}</CtrlSum>`,
    "      <InitgPty>",
    `        <Nm>${escapeXml(debtorName.slice(0, 70))}</Nm>`,
    "      </InitgPty>",
    "    </GrpHdr>",
    "    <PmtInf>",
    `      <PmtInfId>${pmtInfId}</PmtInfId>`,
    "      <PmtMtd>TRF</PmtMtd>",
    "      <BtchBookg>true</BtchBookg>",
    `      <NbOfTxs>${nbOfTxs}</NbOfTxs>`,
    `      <CtrlSum>${controlSumFixed}</CtrlSum>`,
    `      <ReqdExctnDt>${escapeXml(executionDate)}</ReqdExctnDt>`,
    "      <Dbtr>",
    `        <Nm>${escapeXml(debtorName.slice(0, 70))}</Nm>`,
    "      </Dbtr>",
    "      <DbtrAcct>",
    "        <Id>",
    `          <IBAN>${escapeXml(debtorIban)}</IBAN>`,
    "        </Id>",
    `        <Ccy>${escapeXml(items[0].currency)}</Ccy>`,
    "      </DbtrAcct>",
    "      <DbtrAgt>",
    "        <FinInstnId>",
    `          ${finInstnIdXml}`,
    "        </FinInstnId>",
    "      </DbtrAgt>",
    txBlocks,
    "    </PmtInf>",
    "  </CstmrCdtTrfInitn>",
    "</Document>",
    "",
  ].join("\n");

  return Buffer.from(xml, "utf8");
}

export interface PaymentRunExportArtifact {
  runId: string;
  runCode: string;
  format: PaymentRunExportFormat;
  filename: string;
  contentType: string;
  buffer: Buffer;
  sha256: string;
  itemCount: number;
  controlSum: string;
}

export async function exportPaymentRun(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<PaymentRunExportArtifact> {
  const input = parseOrThrow(exportPaymentRunSchema, raw, "Ödeme paketi banka ihracı");
  const client = await pool.connect();
  try {
    await client.query("begin");

    const runRes = await client.query<{
      id: string;
      run_code: string;
      status: string;
      planned_execution_date: string;
      currency: string;
      total_amount: string;
      exported_format: string | null;
      source_bank_account_id: string;
    }>(
      `select id::text, run_code, status,
              to_char(planned_execution_date, 'YYYY-MM-DD') as planned_execution_date,
              currency, total_amount::text, exported_format, source_bank_account_id::text
         from public.payment_runs
        where id = $1
        for update`,
      [input.runId],
    );
    if (runRes.rowCount === 0) {
      throw new DomainError("NOT_FOUND", "Ödeme paketi bulunamadı.");
    }
    const run = runRes.rows[0];

    if (!["approved", "exported", "settled"].includes(run.status)) {
      throw new DomainError(
        "FORBIDDEN",
        `Onaylanmamış veya iptal edilmiş ödeme paketi ('${run.status}') banka dosyası olarak ihraç edilemez — önce maker-checker onayı tamamlanmalıdır.`,
      );
    }

    const bankRes = await client.query<{
      account_name: string;
      iban_normalized: string | null;
      swift_bic: string | null;
      currency: string;
    }>(
      `select ca.name as account_name, ba.iban_normalized, ba.swift_bic, ca.currency
         from public.bank_accounts ba
         join public.cash_accounts ca on ca.id = ba.cash_account_id
        where ba.cash_account_id = $1`,
      [run.source_bank_account_id],
    );
    if (bankRes.rowCount === 0) {
      throw new DomainError("NOT_FOUND", "Kaynak banka hesabı profili bulunamadı.");
    }
    const bank = bankRes.rows[0];
    const debtorIban = bank.iban_normalized ? normalizeIban(bank.iban_normalized) : "";
    if (!debtorIban || !isTurkishIban(debtorIban) || !isValidIbanChecksum(debtorIban)) {
      throw new DomainError(
        "CONFLICT",
        "Kaynak banka hesabının geçerli bir TR IBAN (26 hane, ISO 7064 MOD-97) kaydı yok — ihraca izin verilmedi.",
      );
    }

    const itemsRes = await client.query<{
      id: string;
      beneficiary_name: string;
      beneficiary_iban: string;
      amount: string;
      currency: string;
      due_date: string | null;
      description: string;
      iban_verified: boolean;
      party_id: string | null;
      iban_id: string | null;
      dir_is_active: boolean | null;
      dir_approval_status: string | null;
      dir_iban_normalized: string | null;
    }>(
      `select pri.id::text,
              pri.beneficiary_name,
              pri.beneficiary_iban,
              pri.amount::text,
              pri.currency,
              to_char(pri.due_date, 'YYYY-MM-DD') as due_date,
              pri.description,
              pri.iban_verified,
              pri.party_id::text,
              pri.iban_id::text,
              ib.is_active as dir_is_active,
              ib.approval_status as dir_approval_status,
              ib.iban_normalized as dir_iban_normalized
         from public.payment_run_items pri
         left join public.ibans ib on ib.id = pri.iban_id
        where pri.run_id = $1
          and pri.status in ('included', 'settled')
        order by (pri.due_date is null), pri.due_date asc, pri.created_at asc, pri.id asc
        for update of pri`,
      [input.runId],
    );

    if (itemsRes.rowCount === 0) {
      throw new DomainError("CONFLICT", "Ödeme paketinde ihraç edilecek aktif kalem bulunamadı.");
    }

    const debtorBankCode = extractTrBankCode(debtorIban);
    const validated: ValidatedExportItem[] = [];
    let sumDec = decimal(0);

    for (const [idx, row] of itemsRes.rows.entries()) {
      const ibanNorm = normalizeIban(row.beneficiary_iban);
      if (!isTurkishIban(ibanNorm) || !isValidIbanChecksum(ibanNorm)) {
        throw new DomainError(
          "CONFLICT",
          `BEC / IBAN Kalkanı: '${row.beneficiary_name}' kaleminin IBAN'ı (${ibanNorm}) geçerli bir 26 haneli TR IBAN (MOD-97) değil.`,
        );
      }
      if (!row.iban_verified) {
        throw new DomainError(
          "FORBIDDEN",
          `BEC Kalkanı: '${row.beneficiary_name}' kaleminin IBAN'ı (${ibanNorm}) ikinci göz tarafından doğrulanmamış (iban_verified=false) — ihraca izin verilmedi.`,
        );
      }
      if (row.iban_id) {
        if (row.dir_is_active !== true || row.dir_approval_status !== "approved") {
          throw new DomainError(
            "FORBIDDEN",
            `BEC Kalkanı: '${row.beneficiary_name}' kaleminin kayıtlı IBAN'ı pasif veya onay bekler durumda (${row.dir_approval_status ?? "bilinmiyor"}) — ihraca izin verilmedi.`,
          );
        }
        if (row.dir_iban_normalized && normalizeIban(row.dir_iban_normalized) !== ibanNorm) {
          throw new DomainError(
            "FORBIDDEN",
            `BEC Kalkanı: '${row.beneficiary_name}' kaleminin IBAN değeri rehber kaydından sapmış — ihraca izin verilmedi.`,
          );
        }
      }
      if (row.currency !== run.currency) {
        throw new DomainError(
          "CONFLICT",
          `Kalem dövizi (${row.currency}) paket döviziyle (${run.currency}) uyuşmuyor.`,
        );
      }

      const amtDec = decimal(row.amount);
      if (amtDec.lte(0)) {
        throw new DomainError("CONFLICT", "Sıfır veya negatif tutarlı kalem banka dosyasına yazılamaz.");
      }
      sumDec = sumDec.plus(amtDec);

      validated.push({
        id: row.id,
        endToEndId: `${run.run_code}-${String(idx + 1).padStart(3, "0")}`,
        beneficiaryName: row.beneficiary_name,
        beneficiaryIban: ibanNorm,
        amountFixed: amtDec.toFixed(2),
        currency: row.currency,
        dueDate: row.due_date,
        description: row.description,
        sameBank: extractTrBankCode(ibanNorm) === debtorBankCode,
      });
    }

    const expectedTotalDec = decimal(run.total_amount);
    if (!sumDec.eq(expectedTotalDec)) {
      throw new DomainError(
        "CONFLICT",
        `Kontrol toplamı uyumsuzluğu: paket başlığı ${expectedTotalDec.toFixed(2)}, kalemler toplamı ${sumDec.toFixed(2)}.`,
      );
    }

    const controlSumFixed = sumDec.toFixed(2);
    const debtorName = (input.debtorName ?? process.env.MAS_COMPANY_LEGAL_NAME ?? bank.account_name).trim();
    const createdIsoUtc = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    let buffer: Buffer;
    let contentType: string;
    let filename: string;

    if (input.format === "pain001") {
      buffer = buildPain001Xml({
        runCode: run.run_code,
        createdIsoUtc,
        executionDate: run.planned_execution_date,
        debtorName,
        debtorIban,
        debtorBic: bank.swift_bic,
        controlSumFixed,
        items: validated,
      });
      contentType = "application/xml; charset=utf-8";
      filename = `${run.run_code}_pain.001.001.03.xml`;
    } else {
      const [bankKey, ext] = input.format.split("_") as [BankTemplateKey, "csv" | "xlsx"];
      const meta = BANK_TEMPLATE_META[bankKey];
      if (ext === "csv") {
        const csvRows = validated.map((it, idx) => [
          String(idx + 1),
          it.sameBank ? "HAVALE" : "EFT",
          sanitizeSpreadsheetText(it.beneficiaryName),
          it.beneficiaryIban,
          it.amountFixed,
          it.currency,
          run.planned_execution_date,
          sanitizeSpreadsheetText(it.description),
          it.endToEndId,
        ]);
        buffer = encodeRfc4180Csv(meta.headers, csvRows);
        contentType = "text/csv; charset=utf-8";
        filename = `${run.run_code}_${bankKey}.csv`;
      } else {
        const xlsxRows = validated.map((it, idx) => [
          idx + 1,
          it.sameBank ? "HAVALE" : "EFT",
          sanitizeSpreadsheetText(it.beneficiaryName),
          it.beneficiaryIban,
          Number(it.amountFixed),
          it.currency,
          run.planned_execution_date,
          sanitizeSpreadsheetText(it.description),
          it.endToEndId,
        ]);
        buffer = await encodeBankXlsx(meta.sheetTitle, meta.headers, xlsxRows);
        contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        filename = `${run.run_code}_${bankKey}.xlsx`;
      }
    }

    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const nextStatus = run.status === "approved" ? "exported" : run.status;

    const upd = await client.query(
      `update public.payment_runs
          set status = $2,
              exported_at = now(),
              exported_format = $3,
              exported_hash = $4
        where id = $1`,
      [input.runId, nextStatus, input.format, sha256],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Ödeme paketi ihraç kaydı güncellenemedi veya yetkiniz yok.");
    }

    await audit(client, {
      actor: actorId,
      action: "export_payment_run",
      entityTable: "payment_runs",
      entityId: input.runId,
      before: { status: run.status, exportedFormat: run.exported_format },
      after: {
        status: nextStatus,
        format: input.format,
        sha256,
        itemCount: validated.length,
        controlSum: controlSumFixed,
      },
    });

    await client.query("commit");
    return {
      runId: input.runId,
      runCode: run.run_code,
      format: input.format,
      filename,
      contentType,
      buffer,
      sha256,
      itemCount: validated.length,
      controlSum: controlSumFixed,
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

