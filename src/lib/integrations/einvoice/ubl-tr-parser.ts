// Faz 60 (M-64) — GİB UBL-TR 1.2 (.xml ve .zip) e-Fatura / e-Arşiv Ayrıştırıcı ve Atomik İçe Aktarma Motoru.
//
// Kurallar:
//   - Dış ağ çağrısı (fetch) YOK; yalnız yüklenen XML / ZIP baytları işlenir.
//   - S-10 / Faz 19 Kalkanı: Tanınmayan VKN veya ünvan için hiçbir koşulda otomatik cari kart açılmaz;
//     `integration_staged_parties` onay kuyruğuna düşürülür. Eşleşen carilerde fatura (`invoices`),
//     satırlar (`invoice_lines`) ve TDHP yönetim yevmiyesi tek transaction içinde kaydedilir.

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { resolveActiveDocumentStorageBackend, storeFile } from "@/lib/documents/storage";
import { DomainError } from "@/lib/domain-error";
import { normalizeTr } from "@/lib/importers/workbook-parser";
import { safeSyncDomainEventWithClient } from "@/lib/ledger/posting-engine";
import { decimal, moneyOrNull } from "@/lib/money";

export interface UblInvoiceLineParsed {
  lineNo: number;
  itemName: string;
  quantity: number;
  unitCode: string;
  unitPrice: number;
  lineNetAmount: number;
  vatRate: number;
  vatAmount: number;
  discountAmount: number;
}

export interface ParsedUblTrInvoice {
  ublUuid: string;
  invoiceNo: string;
  profileId: string;
  invoiceTypeCode: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  supplierName: string;
  supplierVkn: string | null;
  customerName: string;
  customerVkn: string | null;
  netAmount: number;
  vatAmount: number;
  withholdingAmount: number;
  payableAmount: number;
  grossAmount: number;
  lines: UblInvoiceLineParsed[];
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function firstTagValue(xml: string, localTag: string): string | null {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${localTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${localTag}>`, "i");
  const m = re.exec(xml);
  return m ? decodeXmlEntities(m[1].replace(/<[^>]+>/g, " ")) : null;
}

function allBlocks(xml: string, localTag: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${localTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${localTag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function extractCurrencyAttr(xml: string, localTag: string): string | null {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${localTag}[^>]*currencyID=["']([A-Z]{3})["'][^>]*>`, "i");
  const m = re.exec(xml);
  if (!m) return null;
  const raw = m[1].toUpperCase();
  return raw === "TRL" ? "TRY" : raw;
}

function extractPartyInfo(partyXml: string | null): { name: string; vkn: string | null } {
  if (!partyXml) return { name: "Bilinmeyen Taraf", vkn: null };
  const idMatches = [
    ...partyXml.matchAll(/<(?:[A-Za-z0-9_]+:)?ID[^>]*schemeID=["'](?:VKN|TCKN)["'][^>]*>([^<]+)<\/(?:[A-Za-z0-9_]+:)?ID>/gi),
  ];
  let vkn = idMatches[0]?.[1]?.replace(/\D+/g, "") ?? null;
  if (!vkn) {
    const anyDigits = partyXml.match(/<(?:[A-Za-z0-9_]+:)?ID[^>]*>\s*(\d{10,11})\s*<\/(?:[A-Za-z0-9_]+:)?ID>/i);
    if (anyDigits) vkn = anyDigits[1];
  }

  const partyNameBlock = firstTagValue(partyXml, "PartyName");
  let name = partyNameBlock || firstTagValue(partyXml, "RegistrationName") || "";
  if (!name) {
    const first = firstTagValue(partyXml, "FirstName") ?? "";
    const family = firstTagValue(partyXml, "FamilyName") ?? "";
    name = `${first} ${family}`.trim();
  }
  return { name: name || "Bilinmeyen Cari", vkn };
}

/**
 * Parses a single GİB UBL-TR 1.2 `<Invoice>` XML string into deterministic monetary fields.
 */
export function parseUblTrInvoiceXml(xmlRaw: string): ParsedUblTrInvoice {
  const xml = xmlRaw.replace(/^\uFEFF/, "").trim();
  if (!/<(?:[A-Za-z0-9_]+:)?Invoice[\s>]/i.test(xml)) {
    throw new DomainError("VALIDATION", "Geçerli bir GİB UBL-TR <Invoice> XML belgesi bulunamadı.");
  }

  // Strip embedded <cac:Signature> and <cac:AdditionalDocumentReference> before reading top-level ID/UUID
  const headerXml = xml
    .replace(/<(?:[A-Za-z0-9_]+:)?Signature[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?Signature>/gi, "")
    .replace(
      /<(?:[A-Za-z0-9_]+:)?AdditionalDocumentReference[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?AdditionalDocumentReference>/gi,
      "",
    );

  const invoiceNo = firstTagValue(headerXml, "ID");
  const ublUuid = (firstTagValue(headerXml, "UUID") ?? "").toLowerCase();
  const issueDate = firstTagValue(headerXml, "IssueDate") ?? "";
  if (!invoiceNo || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    throw new DomainError(
      "VALIDATION",
      "UBL-TR faturasında zorunlu Fatura No (cbc:ID) veya Düzenleme Tarihi (cbc:IssueDate) eksik.",
    );
  }

  const profileId = firstTagValue(headerXml, "ProfileID") ?? "TICARIFATURA";
  const invoiceTypeCode = (firstTagValue(headerXml, "InvoiceTypeCode") ?? "SATIS").toUpperCase();
  const dueDateRaw =
    firstTagValue(headerXml, "PaymentDueDate") ?? firstTagValue(headerXml, "DueDate") ?? null;
  const dueDate = dueDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw) ? dueDateRaw : null;

  const rawCur =
    firstTagValue(headerXml, "DocumentCurrencyCode")?.toUpperCase() ??
    extractCurrencyAttr(headerXml, "PayableAmount") ??
    "TRY";
  const currency = rawCur === "TRL" ? "TRY" : /^[A-Z]{3}$/.test(rawCur) ? rawCur : "TRY";

  const supplierBlock = allBlocks(headerXml, "AccountingSupplierParty")[0] ?? null;
  const customerBlock = allBlocks(headerXml, "AccountingCustomerParty")[0] ?? null;
  const supplier = extractPartyInfo(supplierBlock);
  const customer = extractPartyInfo(customerBlock);

  const monetaryBlock = allBlocks(headerXml, "LegalMonetaryTotal")[0] ?? headerXml;
  const lineExtension = moneyOrNull(firstTagValue(monetaryBlock, "LineExtensionAmount")) ?? 0;
  const taxExclusive = moneyOrNull(firstTagValue(monetaryBlock, "TaxExclusiveAmount")) ?? lineExtension;
  const taxInclusive = moneyOrNull(firstTagValue(monetaryBlock, "TaxInclusiveAmount")) ?? taxExclusive;
  const payable = moneyOrNull(firstTagValue(monetaryBlock, "PayableAmount")) ?? taxInclusive;

  const taxBlocks = allBlocks(headerXml, "TaxTotal");
  const topTaxXml = taxBlocks[0] ?? "";
  const vatAmount =
    moneyOrNull(firstTagValue(topTaxXml, "TaxAmount")) ??
    Number(decimal(taxInclusive).minus(taxExclusive).round(2).toFixed(2));

  const withholdingBlocks = allBlocks(headerXml, "WithholdingTaxTotal");
  const withholdingAmount = withholdingBlocks.reduce(
    (acc, b) => Number(decimal(acc).plus(moneyOrNull(firstTagValue(b, "TaxAmount")) ?? 0).round(2).toFixed(2)),
    0,
  );

  const lineBlocks = allBlocks(xml, "InvoiceLine");
  const lines: UblInvoiceLineParsed[] = lineBlocks.map((lb, idx) => {
    const qtyMatch = lb.match(
      /<(?:[A-Za-z0-9_]+:)?InvoicedQuantity([^>]*)>([^<]+)<\/(?:[A-Za-z0-9_]+:)?InvoicedQuantity>/i,
    );
    const unitCodeMatch = qtyMatch?.[1]?.match(/unitCode=["']([^"']+)["']/i);
    const quantity = Math.max(0.0001, Number(qtyMatch?.[2]?.trim() ?? "1") || 1);
    const unitCode = unitCodeMatch?.[1] ?? "C62";
    const lineNetAmount = moneyOrNull(firstTagValue(lb, "LineExtensionAmount")) ?? 0;
    const priceBlock = allBlocks(lb, "Price")[0] ?? "";
    const unitPrice =
      moneyOrNull(firstTagValue(priceBlock, "PriceAmount")) ??
      (quantity > 0 ? Number(decimal(lineNetAmount).div(quantity).round(4).toFixed(4)) : lineNetAmount);
    const itemBlock = allBlocks(lb, "Item")[0] ?? "";
    const itemName =
      firstTagValue(itemBlock, "Name") ??
      firstTagValue(itemBlock, "Description") ??
      firstTagValue(lb, "Note") ??
      `Kalem ${idx + 1}`;
    const lineTaxBlock = allBlocks(lb, "TaxTotal")[0] ?? "";
    const lineVatAmt = moneyOrNull(firstTagValue(lineTaxBlock, "TaxAmount")) ?? 0;
    const pctRaw = Number(firstTagValue(lineTaxBlock, "Percent") ?? "20");
    const vatRate = Number.isFinite(pctRaw) ? (pctRaw > 1 ? pctRaw / 100 : pctRaw) : 0.2;
    const allowanceBlock = allBlocks(lb, "AllowanceCharge")[0] ?? "";
    const discountAmount = moneyOrNull(firstTagValue(allowanceBlock, "Amount")) ?? 0;

    return {
      lineNo: idx + 1,
      itemName: itemName.slice(0, 240),
      quantity,
      unitCode,
      unitPrice,
      lineNetAmount,
      vatRate,
      vatAmount: lineVatAmt,
      discountAmount,
    };
  });

  const effectiveUuid =
    ublUuid && /^[0-9a-f-]{32,36}$/i.test(ublUuid)
      ? ublUuid
      : createHash("sha256")
          .update(`${supplier.vkn ?? supplier.name}|${invoiceNo}|${issueDate}`)
          .digest("hex")
          .slice(0, 32)
          .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

  return {
    ublUuid: effectiveUuid,
    invoiceNo,
    profileId,
    invoiceTypeCode,
    issueDate,
    dueDate,
    currency,
    supplierName: supplier.name,
    supplierVkn: supplier.vkn,
    customerName: customer.name,
    customerVkn: customer.vkn,
    netAmount: taxExclusive,
    vatAmount,
    withholdingAmount,
    payableAmount: payable,
    grossAmount: taxInclusive,
    lines,
  };
}

/**
 * Extracts `.xml` files from a standard ZIP buffer (supports Stored method=0 and Deflate method=8)
 * using Node's built-in `node:zlib` with strict decompression size cap (25 MB).
 */
export function extractXmlEntriesFromZip(
  zipBuf: Buffer,
): Array<{ filename: string; xml: string }> {
  const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
  const entries: Array<{ filename: string; xml: string }> = [];
  let totalUncompressed = 0;
  let offset = 0;

  while (offset + 30 <= zipBuf.length) {
    const sig = zipBuf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // End of local file headers (central directory starts with 0x02014b50)

    const flags = zipBuf.readUInt16LE(offset + 6);
    if ((flags & 0x08) !== 0) {
      throw new DomainError(
        "VALIDATION",
        "Veri tanımlayıcılı (streaming bit-3) ZIP arşivleri güvenlik gereği doğrudan XML olarak yüklenmelidir.",
      );
    }
    const method = zipBuf.readUInt16LE(offset + 8);
    const compressedSize = zipBuf.readUInt32LE(offset + 18);
    const uncompressedSize = zipBuf.readUInt32LE(offset + 22);
    const nameLen = zipBuf.readUInt16LE(offset + 26);
    const extraLen = zipBuf.readUInt16LE(offset + 28);

    const dataStart = offset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBuf.length) break;

    const entryName = zipBuf.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
    offset = dataEnd;

    if (!entryName.toLowerCase().endsWith(".xml") || entryName.includes("__MACOSX")) {
      continue;
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new DomainError("VALIDATION", "ZIP arşivi açılmış boyutu 25 MB sınırını aşıyor.");
    }

    const slice = zipBuf.subarray(dataStart, dataEnd);
    let rawBytes: Buffer;
    if (method === 0) {
      rawBytes = slice;
    } else if (method === 8) {
      rawBytes = inflateRawSync(slice, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
    } else {
      throw new DomainError("VALIDATION", `Desteklenmeyen ZIP sıkıştırma yöntemi (${method}).`);
    }

    entries.push({ filename: entryName, xml: rawBytes.toString("utf8") });
  }

  return entries;
}

export interface UblImportSummary {
  parsedCount: number;
  importedCount: number;
  duplicateCount: number;
  stagedPartyCount: number;
  invoiceNumbers: string[];
}

/**
 * Atomically imports one or more GİB UBL-TR 1.2 invoices from an `.xml` or `.zip` upload.
 * Respects S-10 Shield: never silently creates a counterparty; unknown VKN/names are queued in
 * `integration_staged_parties` for explicit operator review.
 */
export async function importUblTrUpload(
  pool: Pool,
  params: {
    bytes: Buffer;
    filename: string;
    defaultDirection: "purchase" | "sales";
    ownTaxNumber?: string | null;
    actorId: string;
  },
): Promise<UblImportSummary> {
  const isZip =
    params.filename.toLowerCase().endsWith(".zip") ||
    (params.bytes.length >= 4 && params.bytes.readUInt32LE(0) === 0x04034b50);

  const xmlItems = isZip
    ? extractXmlEntriesFromZip(params.bytes)
    : [{ filename: params.filename, xml: params.bytes.toString("utf8") }];

  if (xmlItems.length === 0) {
    throw new DomainError("VALIDATION", "Yüklenen dosyada işlenecek .xml e-Fatura bulunamadı.");
  }

  const parsedInvoices = xmlItems.map((item) => ({
    filename: item.filename,
    xml: item.xml,
    parsed: parseUblTrInvoiceXml(item.xml),
  }));

  const client = await pool.connect();
  try {
    await client.query("begin");

    const ownVknClean = params.ownTaxNumber ? params.ownTaxNumber.replace(/\D+/g, "") : null;
    let importedCount = 0;
    let duplicateCount = 0;
    let stagedPartyCount = 0;
    const invoiceNumbers: string[] = [];

    for (const { xml, parsed } of parsedInvoices) {
      const payloadSha = createHash("sha256").update(xml, "utf8").digest("hex");

      // Determine direction: if ownVkn matches supplierVkn -> sales, if customerVkn -> purchase, else defaultDirection
      let direction: "purchase" | "sales" = params.defaultDirection;
      if (ownVknClean && parsed.supplierVkn === ownVknClean) {
        direction = "sales";
      } else if (ownVknClean && parsed.customerVkn === ownVknClean) {
        direction = "purchase";
      }

      const counterpartyName = direction === "purchase" ? parsed.supplierName : parsed.customerName;
      const counterpartyVkn = direction === "purchase" ? parsed.supplierVkn : parsed.customerVkn;

      // Deduplicate by ubl_uuid (text column in public.invoices)
      const dupCheck = await client.query<{ id: string }>(
        `select id::text from public.invoices where ubl_uuid = $1 limit 1`,
        [parsed.ublUuid],
      );
      if ((dupCheck.rowCount ?? 0) > 0) {
        duplicateCount += 1;
        continue;
      }

      // Resolve existing party by VKN/TCKN first, then TR-normalized name (NEVER auto-inserts a party!)
      let partyId: string | null = null;
      if (counterpartyVkn) {
        const byVkn = await client.query<{ party_id: string }>(
          `select cp.party_id::text
             from public.counterparty_profiles cp
             join public.parties p on p.id = cp.party_id
            where regexp_replace(coalesce(cp.tax_number, ''), '\\D+', '', 'g') = $1
            limit 1`,
          [counterpartyVkn],
        );
        partyId = byVkn.rows[0]?.party_id ?? null;
      }
      if (!partyId && counterpartyName) {
        const norm = normalizeTr(counterpartyName);
        const byName = await client.query<{ id: string }>(
          `select id::text from public.parties where normalized_name = $1 limit 1`,
          [norm],
        );
        partyId = byName.rows[0]?.id ?? null;
      }

      // Record raw SHA-256 evidence payload
      await client.query(
        `insert into public.integration_raw_payloads
           (provider, resource_type, external_id, payload_sha256, payload_json)
         values ('gib_ubl_tr', 'ubl_invoice', $1, $2, $3::jsonb)
         on conflict do nothing`,
        [parsed.ublUuid, payloadSha, JSON.stringify(parsed)],
      );

      if (!partyId) {
        // S-10 Shield: Stage unknown counterparty for explicit operator review
        const extContactId = counterpartyVkn || normalizeTr(counterpartyName).slice(0, 80) || parsed.ublUuid;
        await client.query(
          `insert into public.integration_staged_parties
             (provider, external_contact_id, raw_name, tax_id, account_type, status)
           values ('gib_ubl_tr', $1, $2, $3, $4, 'pending')
           on conflict (provider, external_contact_id) do nothing`,
          [
            extContactId,
            counterpartyName,
            counterpartyVkn,
            direction === "purchase" ? "vendor" : "customer",
          ],
        );
        stagedPartyCount += 1;
        continue;
      }

      // Store raw UBL XML in content-addressed vault & create document metadata record (`extracted_metadata` from 0119)
      const xmlBytes = Buffer.from(xml, "utf8");
      const storedXml = storeFile(xmlBytes, "xml");
      const storageBackend = resolveActiveDocumentStorageBackend();
      const docFilename = `${parsed.invoiceNo.replace(/[^A-Za-z0-9_-]/g, "_")}.xml`;
      const docRes = await client.query<{ id: string }>(
        `insert into public.documents
           (title, doc_type, tags, description, original_filename, storage_backend, extracted_metadata, created_by)
         values ($1, 'invoice_scan', array['ubl-tr','efatura']::text[], $2, $3, $4, $5::jsonb, $6::uuid)
         returning id::text`,
        [
          `e-Fatura ${parsed.invoiceNo} (${counterpartyName})`,
          `GİB UBL-TR ${parsed.profileId} · ${parsed.invoiceTypeCode} · ETTN ${parsed.ublUuid}`,
          docFilename,
          storageBackend,
          JSON.stringify({
            ublUuid: parsed.ublUuid,
            invoiceNo: parsed.invoiceNo,
            profileId: parsed.profileId,
            invoiceTypeCode: parsed.invoiceTypeCode,
            supplierVkn: parsed.supplierVkn,
            customerVkn: parsed.customerVkn,
            currency: parsed.currency,
            payableAmount: parsed.payableAmount,
            sha256: storedXml.sha256,
          }),
          params.actorId,
        ],
      );
      const sourceDocId = docRes.rows[0].id;

      await client.query(
        `insert into public.attachments
           (document_id, version_no, original_filename, storage_path, file_sha256, byte_size, mime_type, uploaded_by)
         values ($1::uuid, 1, $2, $3, $4, $5, 'application/xml', $6::uuid)
         on conflict do nothing`,
        [
          sourceDocId,
          docFilename,
          storedXml.storagePath,
          storedXml.sha256,
          storedXml.byteSize,
          params.actorId,
        ],
      );

      const totalDiscount = parsed.lines.reduce(
        (acc, l) => Number(decimal(acc).plus(l.discountAmount).round(2).toFixed(2)),
        0,
      );
      const dedupeHash = createHash("sha256")
        .update(`ubl|${partyId}|${parsed.invoiceNo}|${parsed.issueDate}|${parsed.grossAmount.toFixed(2)}`)
        .digest("hex");

      const invRes = await client.query<{ id: string }>(
        `insert into public.invoices
           (invoice_no, direction, party_id, issue_date, due_date, currency,
            net_amount, tax_amount, discount_total, income_tax_withholding_total, payable_amount, gross_amount,
            dedupe_hash, ubl_uuid, source_document_id, notes)
         values ($1, $2, $3::uuid, $4::date, $5::date, $6,
                 $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::numeric,
                 $13, $14, $15::uuid, $16)
         returning id::text`,
        [
          parsed.invoiceNo,
          direction,
          partyId,
          parsed.issueDate,
          parsed.dueDate,
          parsed.currency,
          parsed.netAmount,
          parsed.vatAmount,
          totalDiscount,
          parsed.withholdingAmount,
          parsed.payableAmount,
          parsed.grossAmount,
          dedupeHash,
          parsed.ublUuid,
          sourceDocId,
          `GİB UBL-TR (${parsed.profileId}/${parsed.invoiceTypeCode}) ETTN: ${parsed.ublUuid}`,
        ],
      );
      const invoiceId = invRes.rows[0].id;

      for (const ln of parsed.lines) {
        const lineGross = Number(decimal(ln.lineNetAmount).plus(ln.vatAmount).round(2).toFixed(2));
        await client.query(
          `insert into public.invoice_lines
             (invoice_id, line_no, description, quantity, unit, unit_price,
              discount_amount, tax_rate, tax_amount, net_amount, gross_amount)
           values ($1::uuid, $2, $3, $4::numeric, $5, $6::numeric,
                   $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::numeric)`,
          [
            invoiceId,
            ln.lineNo,
            ln.itemName,
            ln.quantity,
            ln.unitCode,
            ln.unitPrice,
            ln.discountAmount,
            ln.vatRate,
            ln.vatAmount,
            ln.lineNetAmount,
            lineGross,
          ],
        );
      }

      await client.query(
        `insert into public.document_links
           (document_id, entity_table, entity_id, entity_label, link_kind, created_by)
         values ($1::uuid, 'invoices', $2::uuid, $3, 'supporting', $4::uuid)
         on conflict (document_id, entity_table, entity_id, link_kind) do nothing`,
        [sourceDocId, invoiceId, `e-Fatura ${parsed.invoiceNo}`, params.actorId],
      );

      await safeSyncDomainEventWithClient(
        client,
        { kind: "invoice", invoiceId },
        params.actorId,
      );

      if (invRes.rowCount === 1) {
        await audit(client, {
          actor: params.actorId,
          action: "import_ubl_tr_einvoice",
          entityTable: "invoices",
          entityId: invoiceId,
          after: {
            invoiceNo: parsed.invoiceNo,
            ublUuid: parsed.ublUuid,
            direction,
            currency: parsed.currency,
            grossAmount: parsed.grossAmount,
            lineCount: parsed.lines.length,
          },
        });
      }

      importedCount += 1;
      invoiceNumbers.push(parsed.invoiceNo);
    }

    await client.query("commit");
    return {
      parsedCount: parsedInvoices.length,
      importedCount,
      duplicateCount,
      stagedPartyCount,
      invoiceNumbers,
    };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
