// Faz 51 (E1) — Paraşüt API v4 Deterministic Mappers & Idempotent Read-Only Sync Engine (S-1..S-10).
//
// Invariants:
//   * S-1: Upserts invoices via `ON CONFLICT (external_key) WHERE external_key IS NOT NULL`.
//   * S-2: Normalizes Paraşüt's legacy `"TRL"` / `"TL"` currency code to ISO-4217 `"TRY"`.
//   * S-3: Filters out `item_type = 'estimate'` quotes so unaccepted quotes never pollute receivables/payables.
//   * S-4: Inserts unformalized e-Fatura without a GİB number as `status = 'draft'` (`TASLAK-PARASUT-{id}`)
//          and upgrades to `'open'` (with the GİB legal number) in one UPDATE while `old.status = 'draft'`.
//   * S-5: Preserves `withholding_amount`, `vat_withholding_amount`, and `payable_amount`.
//   * S-6: Line-less simple expense bills keep `net_amount = null, tax_amount = null` (`BLANK ≠ ZERO`).
//   * S-7: Captures employee out-of-pocket expenses (`spender_employee_name`) for 335 Personel Borçları.
//   * S-8: Marks inter-account transfers between mapped company accounts as `transaction_kind = 'own_transfer'`.
//   * S-9: Classifies `bank_fees` (`bank_fee`), `taxes` (`tax_payment`), and `salaries` (`payroll`).
//   * S-10: Unknown contacts are staged in `public.integration_staged_parties` (`status = 'pending'`),
//           NEVER inserted directly into `public.parties` (single write gateway: counterparties/engine.ts).

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { audit } from "@/lib/audit";
import { decimal, moneyOrNull } from "@/lib/money";
import { normalizeTr } from "@/lib/importers/workbook-parser";
import type {
  ConnectorContext,
  IntegrationConnector,
  SyncOutcome,
} from "../types";
import {
  buildIncludedIndex,
  computeWatermarkOverlapFrom,
  fetchParasutResourcePages,
  resolveIncludedRelation,
  resolveIncludedRelationList,
  type JsonApiResourceObject,
  type ParasutFetchedRecord,
  type ParasutResourceName,
} from "./client";
import { acquireParasutAccessToken } from "./oauth";
import { ParasutRateLimiter, type RateLimiterOptions } from "./rate-limiter";

export function normalizeParasutCurrency(raw: unknown): string {
  if (typeof raw !== "string") return "TRY";
  const up = raw.trim().toUpperCase();
  if (up === "TRL" || up === "TL" || up === "") return "TRY";
  if (/^[A-Z]{3}$/.test(up)) return up;
  return "TRY";
}

export function normalizeRefToken(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 32);
}

/**
 * Deterministic cross-channel fingerprint shared across:
 *   1) SWIFT MT940 (`:61:`),
 *   2) ISO 20022 `camt.053` XML (`<Ntry>`),
 *   3) Paraşüt Bank Excel (`.xlsx`),
 *   4) Paraşüt API v4 `/transactions`.
 *
 * Uses `(bankAccountId, txnDate, currency, signedAmountKurus)` so the same bank movement
 * arriving via statement file AND via Paraşüt API resolves to the same hash even when
 * channel-specific description strings differ.
 */
export function computeCrossChannelDedupeHash(input: {
  bankAccountId: string;
  txnDate: string;
  amount: number | string;
  currency?: string | null;
  reference?: string | null;
}): string {
  const currency = normalizeParasutCurrency(input.currency ?? "TRY");
  const date = input.txnDate.slice(0, 10);
  const signedKurus = decimal(input.amount).times(100).round(0).toFixed(0);
  const normRef = normalizeRefToken(input.reference);
  const payload = `${input.bankAccountId}|${date}|${currency}|${signedKurus}|${normRef}`;
  return `xch:${createHash("sha256").update(payload).digest("hex").slice(0, 40)}`;
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

function dateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function nonNegativeMoneyOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v !== "number" && typeof v !== "string") return null;
  const parsed = moneyOrNull(v);
  if (parsed == null || parsed < 0) return null;
  return parsed;
}

export interface MappedParasutContact {
  externalId: string;
  name: string;
  normalizedName: string;
  taxId: string | null;
  iban: string | null;
  accountType: "customer" | "vendor" | "company";
}

export function mapParasutContact(
  item: JsonApiResourceObject,
  includedIndex: Map<string, JsonApiResourceObject>,
): MappedParasutContact | null {
  const attrs = item.attributes ?? {};
  const name = strOrNull(attrs.name) ?? strOrNull(attrs.short_name);
  if (!name) return null;
  const rawType = strOrNull(attrs.account_type)?.toLowerCase();
  const accountType: "customer" | "vendor" | "company" =
    rawType === "customer"
      ? "customer"
      : rawType === "supplier" || rawType === "vendor"
        ? "vendor"
        : "company";

  let iban = strOrNull(attrs.iban);
  if (!iban) {
    const ibans = resolveIncludedRelationList(item, "contact_portal", includedIndex);
    if (ibans.length > 0) {
      iban = strOrNull(ibans[0].attributes?.iban);
    }
  }

  return {
    externalId: item.id,
    name,
    normalizedName: normalizeTr(name),
    taxId: strOrNull(attrs.tax_number) ?? strOrNull(attrs.tax_id),
    iban,
    accountType,
  };
}

export interface MappedParasutAccount {
  externalId: string;
  name: string;
  currency: string;
  accountType: "cash" | "bank";
  iban: string | null;
  bankName: string | null;
}

export function mapParasutAccount(item: JsonApiResourceObject): MappedParasutAccount | null {
  const attrs = item.attributes ?? {};
  const name = strOrNull(attrs.name);
  if (!name) return null;
  const rawType = strOrNull(attrs.account_type)?.toLowerCase() ?? "bank";
  const iban = strOrNull(attrs.iban);
  return {
    externalId: item.id,
    name,
    currency: normalizeParasutCurrency(attrs.currency),
    accountType: rawType === "cash" || (!iban && rawType.includes("kasa")) ? "cash" : "bank",
    iban: iban ? iban.replace(/\s+/g, "").toUpperCase() : null,
    bankName: strOrNull(attrs.bank_name) ?? strOrNull(attrs.bank_branch),
  };
}

export interface MappedParasutInvoice {
  externalId: string;
  externalKey: string;
  resourceType: "sales_invoices" | "purchase_bills";
  direction: "sales" | "purchase";
  isEstimate: boolean;
  isFormalized: boolean;
  invoiceNo: string;
  externalStatus: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  netAmount: number | null;
  taxAmount: number | null;
  grossAmount: number;
  withholdingAmount: number | null;
  vatWithholdingAmount: number | null;
  payableAmount: number;
  paidAmount: number;
  status: "draft" | "open" | "partial" | "paid" | "cancelled";
  contactExternalId: string | null;
  contactName: string | null;
  contactTaxId: string | null;
  spenderEmployeeName: string | null;
  description: string | null;
}

export function mapParasutInvoice(
  record: ParasutFetchedRecord,
): MappedParasutInvoice | null {
  const { item, includedIndex } = record;
  const attrs = item.attributes ?? {};
  const resourceType: "sales_invoices" | "purchase_bills" =
    record.resource === "purchase_bills" || item.type === "purchase_bills"
      ? "purchase_bills"
      : "sales_invoices";
  const direction: "sales" | "purchase" = resourceType === "sales_invoices" ? "sales" : "purchase";

  const itemType = (strOrNull(attrs.item_type) ?? "invoice").toLowerCase();
  if (itemType === "estimate" || attrs.is_estimate === true) {
    return {
      externalId: item.id,
      externalKey: `parasut:${resourceType}:${item.id}`,
      resourceType,
      direction,
      isEstimate: true,
      isFormalized: false,
      invoiceNo: `TEKLIF-${item.id}`,
      externalStatus: "estimate",
      issueDate: dateOrNull(attrs.issue_date) ?? "1970-01-01",
      dueDate: null,
      currency: normalizeParasutCurrency(attrs.currency),
      netAmount: null,
      taxAmount: null,
      grossAmount: 0,
      withholdingAmount: null,
      vatWithholdingAmount: null,
      payableAmount: 0,
      paidAmount: 0,
      status: "draft",
      contactExternalId: null,
      contactName: null,
      contactTaxId: null,
      spenderEmployeeName: null,
      description: null,
    };
  }

  const issueDate = dateOrNull(attrs.issue_date);
  if (!issueDate) return null;
  const dueDate = dateOrNull(attrs.due_date);
  const currency = normalizeParasutCurrency(attrs.currency);

  // Gross & Net & Tax (S-6: BLANK ≠ ZERO for line-less simple expense bills)
  const attrGrossTotal = nonNegativeMoneyOrNull(attrs.gross_total);
  const attrNetTotal = nonNegativeMoneyOrNull(attrs.net_total);
  const rawVat = nonNegativeMoneyOrNull(attrs.total_vat ?? attrs.tax_amount);
  const parasutInvertedTotals =
    attrGrossTotal != null &&
    attrNetTotal != null &&
    rawVat != null &&
    rawVat > 0 &&
    decimal(attrGrossTotal).plus(decimal(rawVat)).round(2).eq(decimal(attrNetTotal).round(2));

  const rawGross = parasutInvertedTotals
    ? attrNetTotal
    : (attrGrossTotal ?? attrNetTotal ?? nonNegativeMoneyOrNull(attrs.total_amount));
  const rawNet = parasutInvertedTotals
    ? attrGrossTotal
    : nonNegativeMoneyOrNull(
        attrs.net_total_without_tax ??
          attrs.sub_total ??
          attrs.net_amount ??
          (attrGrossTotal != null &&
          attrNetTotal != null &&
          rawVat != null &&
          decimal(attrNetTotal).plus(decimal(rawVat)).round(2).eq(decimal(attrGrossTotal).round(2))
            ? attrNetTotal
            : undefined),
      );

  const detailsList = resolveIncludedRelationList(item, "details", includedIndex);
  const hasLineDetails =
    detailsList.length > 0 ||
    (Array.isArray(item.relationships?.details?.data) && item.relationships!.details!.data!.length > 0);

  let netAmount: number | null = null;
  let taxAmount: number | null = null;
  let grossAmount: number | null = rawGross;

  if (rawNet != null && rawVat != null) {
    netAmount = rawNet;
    taxAmount = rawVat;
    grossAmount = Number(decimal(rawNet).plus(decimal(rawVat)).toFixed(2));
  } else if (rawGross != null && rawVat != null && (hasLineDetails || rawVat > 0)) {
    const computedNet = Number(decimal(rawGross).minus(decimal(rawVat)).toFixed(2));
    if (computedNet >= 0) {
      netAmount = computedNet;
      taxAmount = rawVat;
      grossAmount = rawGross;
    }
  } else if (rawGross != null && !hasLineDetails && rawVat == null && rawNet == null) {
    // S-6: Line-less simple bill — keep net_amount and tax_amount NULL (never fabricate 0 VAT!)
    netAmount = null;
    taxAmount = null;
    grossAmount = rawGross;
  } else if (rawGross != null && hasLineDetails && rawVat == null) {
    netAmount = rawGross;
    taxAmount = 0;
    grossAmount = rawGross;
  }

  if (grossAmount == null) return null;

  // S-5: Withholding (stopaj) & VAT Withholding (KDV tevkifatı)
  const withholdingAmount =
    nonNegativeMoneyOrNull(attrs.withholding ?? attrs.stopaj_amount ?? attrs.withholding_amount) ?? null;
  const vatWithholdingAmount =
    nonNegativeMoneyOrNull(attrs.vat_withholding ?? attrs.vat_withholding_amount) ?? null;

  const totalDeduction = decimal(withholdingAmount ?? 0).plus(decimal(vatWithholdingAmount ?? 0));
  const computedPayable = Number(
    decimal(grossAmount).minus(totalDeduction).round(2).toFixed(2),
  );
  const explicitPayable = nonNegativeMoneyOrNull(
    attrs.payable_amount ?? attrs.net_total_after_withholding,
  );
  const payableAmount =
    explicitPayable != null && explicitPayable <= grossAmount
      ? explicitPayable
      : Math.max(0, computedPayable);

  const remaining = nonNegativeMoneyOrNull(attrs.remaining ?? attrs.remaining_in_trl);
  const explicitPaid = nonNegativeMoneyOrNull(attrs.total_paid ?? attrs.paid_amount);
  const paidAmount =
    explicitPaid != null
      ? explicitPaid
      : remaining != null
        ? Math.max(0, Number(decimal(payableAmount).minus(decimal(remaining)).toFixed(2)))
        : 0;

  // S-4: GİB e-Fatura formalization detection
  const activeEDoc = resolveIncludedRelation(item, "active_e_document", includedIndex);
  const gibLegalNo =
    strOrNull(activeEDoc?.attributes?.legal_number) ??
    strOrNull(activeEDoc?.attributes?.invoice_number) ??
    strOrNull(attrs.legal_number);
  const series = strOrNull(attrs.invoice_series);
  const seqId =
    attrs.invoice_id != null && String(attrs.invoice_id).trim() !== ""
      ? String(attrs.invoice_id).trim()
      : null;
  const combinedSeriesNo = series && seqId ? `${series}${seqId}` : seqId ?? series;
  const explicitInvoiceNo = gibLegalNo ?? combinedSeriesNo ?? strOrNull(attrs.invoice_no);
  const isFormalized = Boolean(explicitInvoiceNo);
  const invoiceNo = explicitInvoiceNo ?? `TASLAK-PARASUT-${item.id}`;

  const isCancelled =
    attrs.is_aborted === true ||
    attrs.archived === true ||
    strOrNull(attrs.payment_status)?.toLowerCase() === "cancelled";

  let status: "draft" | "open" | "partial" | "paid" | "cancelled";
  if (isCancelled) {
    status = "cancelled";
  } else if (!isFormalized) {
    status = "draft";
  } else if (paidAmount >= payableAmount && payableAmount > 0) {
    status = "paid";
  } else if (paidAmount > 0) {
    status = "partial";
  } else {
    status = "open";
  }

  // Contact / Supplier / Spender (S-7 & S-10)
  const contactRel =
    resolveIncludedRelation(item, "contact", includedIndex) ??
    resolveIncludedRelation(item, "supplier", includedIndex);
  const contactRefData =
    item.relationships?.contact?.data && !Array.isArray(item.relationships.contact.data)
      ? item.relationships.contact.data
      : item.relationships?.supplier?.data && !Array.isArray(item.relationships.supplier.data)
        ? item.relationships.supplier.data
        : null;

  const contactExternalId = contactRel?.id ?? contactRefData?.id ?? null;
  const contactName =
    strOrNull(contactRel?.attributes?.name) ??
    strOrNull(attrs.contact_name) ??
    strOrNull(attrs.supplier_name);
  const contactTaxId =
    strOrNull(contactRel?.attributes?.tax_number) ??
    strOrNull(attrs.tax_number);

  const spenderRel = resolveIncludedRelation(item, "spender", includedIndex);
  const spenderEmployeeName =
    strOrNull(spenderRel?.attributes?.name) ??
    strOrNull(attrs.spender_name) ??
    (itemType === "refund" || strOrNull(attrs.paid_by) === "employee"
      ? strOrNull(attrs.employee_name) ?? "Çalışan Harcaması (335)"
      : null);

  return {
    externalId: item.id,
    externalKey: `parasut:${resourceType}:${item.id}`,
    resourceType,
    direction,
    isEstimate: false,
    isFormalized,
    invoiceNo,
    externalStatus: isCancelled ? "cancelled" : isFormalized ? "formalized" : "unformalized",
    issueDate,
    dueDate,
    currency,
    netAmount,
    taxAmount,
    grossAmount,
    withholdingAmount,
    vatWithholdingAmount,
    payableAmount,
    paidAmount,
    status,
    contactExternalId,
    contactName,
    contactTaxId,
    spenderEmployeeName,
    description: strOrNull(attrs.description),
  };
}

export interface MappedParasutTransaction {
  externalId: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  debitAccountExternalId: string | null;
  creditAccountExternalId: string | null;
  transactionKind: "standard" | "own_transfer" | "bank_fee" | "tax_payment" | "payroll";
  referenceNo: string | null;
  counterpartyName: string | null;
}

export function mapParasutTransaction(
  record: ParasutFetchedRecord,
  mappedExternalAccountIds: ReadonlySet<string>,
): MappedParasutTransaction[] {
  const { item, includedIndex } = record;
  const attrs = item.attributes ?? {};
  const date = dateOrNull(attrs.date) ?? dateOrNull(attrs.issue_date) ?? dateOrNull(attrs.due_date);
  if (!date) return [];

  const rawAmount = nonNegativeMoneyOrNull(attrs.amount ?? attrs.amount_in_trl ?? attrs.net_total ?? attrs.total_paid);
  if (rawAmount == null || rawAmount === 0) return [];

  const currency = normalizeParasutCurrency(attrs.currency);
  const description =
    strOrNull(attrs.description) ??
    (record.resource === "bank_fees"
      ? "Paraşüt Banka Masrafı"
      : record.resource === "taxes"
        ? "Paraşüt Vergi/SGK Tahakkuku"
        : record.resource === "salaries"
          ? "Paraşüt Bordro Toplamı"
          : "Paraşüt Hareketi");

  const debitRef =
    item.relationships?.debit_account?.data && !Array.isArray(item.relationships.debit_account.data)
      ? item.relationships.debit_account.data.id
      : null;
  const creditRef =
    item.relationships?.credit_account?.data && !Array.isArray(item.relationships.credit_account.data)
      ? item.relationships.credit_account.data.id
      : null;

  // S-8: If both debit_account and credit_account belong to company accounts, it's an inter-account transfer!
  const bothCompanyAccounts =
    Boolean(debitRef && creditRef && debitRef !== creditRef) &&
    ((mappedExternalAccountIds.has(debitRef!) && mappedExternalAccountIds.has(creditRef!)) ||
      Boolean(debitRef && creditRef));

  const txType = (strOrNull(attrs.transaction_type) ?? "").toLowerCase();
  const isOwnTransfer =
    bothCompanyAccounts ||
    txType === "account_transfer" ||
    txType === "virman" ||
    txType === "own_transfer";

  let baseKind: MappedParasutTransaction["transactionKind"] = "standard";
  if (record.resource === "bank_fees" || txType.includes("bank_fee")) {
    baseKind = "bank_fee";
  } else if (record.resource === "taxes" || txType.includes("tax")) {
    baseKind = "tax_payment";
  } else if (record.resource === "salaries" || txType.includes("salary") || txType.includes("payroll")) {
    baseKind = "payroll";
  } else if (isOwnTransfer) {
    baseKind = "own_transfer";
  }

  const contactRel = resolveIncludedRelation(item, "contact", includedIndex);
  const counterpartyName = strOrNull(contactRel?.attributes?.name) ?? strOrNull(attrs.contact_name);
  const referenceNo = strOrNull(attrs.reference_no);

  const legs: MappedParasutTransaction[] = [];

  if (debitRef && creditRef && debitRef !== creditRef) {
    // Credit account = money leaving (-amount); Debit account = money entering (+amount)
    legs.push({
      externalId: `${item.id}:out:${creditRef}`,
      date,
      amount: -Math.abs(rawAmount),
      currency,
      description,
      debitAccountExternalId: debitRef,
      creditAccountExternalId: creditRef,
      transactionKind: "own_transfer",
      referenceNo,
      counterpartyName,
    });
    legs.push({
      externalId: `${item.id}:in:${debitRef}`,
      date,
      amount: Math.abs(rawAmount),
      currency,
      description,
      debitAccountExternalId: debitRef,
      creditAccountExternalId: creditRef,
      transactionKind: "own_transfer",
      referenceNo,
      counterpartyName,
    });
    return legs;
  }

  const isInflow = Boolean(debitRef && !creditRef) || txType.includes("inflow") || txType.includes("collection");
  const signedAmount = isInflow ? Math.abs(rawAmount) : -Math.abs(rawAmount);

  legs.push({
    externalId: item.id,
    date,
    amount: signedAmount,
    currency,
    description,
    debitAccountExternalId: debitRef,
    creditAccountExternalId: creditRef,
    transactionKind: baseKind,
    referenceNo,
    counterpartyName,
  });

  return legs;
}

/* ── Database Lineage & Idempotent Upsert Helpers ───────────────────────────────────────── */

function collectReferencedIncludedObjects(record: ParasutFetchedRecord): JsonApiResourceObject[] {
  if (record.includedIndex.size === 0 || !record.item.relationships) return [];
  const seen = new Set<string>();
  const collected: JsonApiResourceObject[] = [];
  for (const relEntry of Object.values(record.item.relationships)) {
    const data = relEntry?.data;
    if (!data) continue;
    const refs = Array.isArray(data) ? data : [data];
    for (const ref of refs) {
      if (!ref || typeof ref.type !== "string" || typeof ref.id !== "string") continue;
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) continue;
      const obj = record.includedIndex.get(key);
      if (obj) {
        seen.add(key);
        collected.push(obj);
      }
    }
  }
  return collected;
}

function reconstructFetchedRecordFromRawPayload(row: {
  resource_type: string;
  external_id: string;
  external_updated_at: string | null;
  payload_sha256: string;
  payload_json: Record<string, unknown>;
}): ParasutFetchedRecord | null {
  const payload = row.payload_json;
  if (!payload || typeof payload !== "object") return null;
  const id = typeof payload.id === "string" && payload.id.trim() !== "" ? payload.id : row.external_id;
  const resource = (
    row.resource_type === "purchase_bills" ? "purchase_bills" : "sales_invoices"
  ) as ParasutResourceName;
  const type = typeof payload.type === "string" ? payload.type : resource;
  const attributes =
    payload.attributes && typeof payload.attributes === "object"
      ? (payload.attributes as Record<string, unknown>)
      : {};
  const relationships =
    payload.relationships && typeof payload.relationships === "object"
      ? (payload.relationships as JsonApiResourceObject["relationships"])
      : undefined;
  const included = Array.isArray(payload.included)
    ? (payload.included as JsonApiResourceObject[])
    : undefined;

  return {
    resource,
    item: {
      id,
      type,
      attributes,
      relationships,
    },
    includedIndex: buildIncludedIndex(included),
    rawJson: payload,
    payloadSha256: row.payload_sha256,
    externalUpdatedAt: row.external_updated_at,
  };
}

async function recordRawPayload(
  client: PoolClient,
  syncRunId: string,
  record: ParasutFetchedRecord,
): Promise<string> {
  const referencedIncluded = collectReferencedIncludedObjects(record);
  const storedPayload =
    referencedIncluded.length > 0
      ? { ...record.rawJson, included: referencedIncluded }
      : record.rawJson;
  const storedJsonStr = JSON.stringify(storedPayload);
  const effectiveSha =
    referencedIncluded.length > 0
      ? createHash("sha256").update(storedJsonStr).digest("hex")
      : record.payloadSha256;

  const ins = await client.query<{ id: string }>(
    `insert into public.integration_raw_payloads
       (sync_run_id, resource_type, external_id, external_updated_at, payload_sha256, payload_json)
     values ($1, $2, $3, $4::timestamptz, $5, $6::jsonb)
     on conflict (resource_type, external_id, payload_sha256) do nothing
     returning id`,
    [
      syncRunId,
      record.resource,
      record.item.id,
      record.externalUpdatedAt,
      effectiveSha,
      storedJsonStr,
    ],
  );
  if (ins.rows[0]?.id) return ins.rows[0].id;

  const existing = await client.query<{ id: string }>(
    `select id from public.integration_raw_payloads
      where resource_type = $1 and external_id = $2 and payload_sha256 = $3
      limit 1`,
    [record.resource, record.item.id, effectiveSha],
  );
  return existing.rows[0].id;
}

async function upsertEntityLink(
  client: PoolClient,
  resourceType: string,
  externalId: string,
  entityTable: string,
  entityId: string,
  payloadId: string | null,
): Promise<void> {
  await client.query(
    `insert into public.integration_entity_links
       (provider, resource_type, external_id, entity_table, entity_id, last_payload_id, last_synced_at)
     values ('parasut', $1, $2, $3, $4, $5, now())
     on conflict (provider, resource_type, external_id) do update
       set entity_table = excluded.entity_table,
           entity_id = excluded.entity_id,
           last_payload_id = coalesce(excluded.last_payload_id, public.integration_entity_links.last_payload_id),
           last_synced_at = now()`,
    [resourceType, externalId, entityTable, entityId, payloadId],
  );
}

/**
 * Resolves a counterparty in `public.parties` WITHOUT ever inserting into `public.parties` (S-10).
 * If unknown, stages a row in `public.integration_staged_parties` (`status = 'pending'`).
 */
async function resolveOrStageParty(
  client: PoolClient,
  contact: {
    externalId: string | null;
    name: string | null;
    taxId: string | null;
    iban?: string | null;
    accountType?: string | null;
  },
): Promise<{ partyId: string | null; stagedNew: boolean }> {
  // 1) Check existing entity link
  if (contact.externalId) {
    const linked = await client.query<{ entity_id: string }>(
      `select entity_id::text
         from public.integration_entity_links
        where provider = 'parasut' and resource_type = 'contacts' and external_id = $1
        limit 1`,
      [contact.externalId],
    );
    if (linked.rows[0]?.entity_id) {
      return { partyId: linked.rows[0].entity_id, stagedNew: false };
    }

    const stagedResolved = await client.query<{ resolved_party_id: string | null }>(
      `select resolved_party_id::text
         from public.integration_staged_parties
        where provider = 'parasut'
          and external_contact_id = $1
          and status in ('linked', 'created')
          and resolved_party_id is not null
        limit 1`,
      [contact.externalId],
    );
    if (stagedResolved.rows[0]?.resolved_party_id) {
      return { partyId: stagedResolved.rows[0].resolved_party_id, stagedNew: false };
    }
  }

  // 2) Match by tax_number in counterparty_profiles
  if (contact.taxId) {
    const byTax = await client.query<{ party_id: string }>(
      `select party_id::text
         from public.counterparty_profiles
        where btrim(tax_number) = btrim($1)
        limit 1`,
      [contact.taxId],
    );
    if (byTax.rows[0]?.party_id) {
      return { partyId: byTax.rows[0].party_id, stagedNew: false };
    }
  }

  // 3) Match by IBAN in ibans
  if (contact.iban) {
    const cleanIban = contact.iban.replace(/\s+/g, "").toUpperCase();
    const byIban = await client.query<{ party_id: string }>(
      `select party_id::text
         from public.ibans
        where replace(upper(iban), ' ', '') = $1
        limit 1`,
      [cleanIban],
    );
    if (byIban.rows[0]?.party_id) {
      return { partyId: byIban.rows[0].party_id, stagedNew: false };
    }
  }

  // 4) Match by normalized_name in public.parties
  const rawName = contact.name?.trim() ?? "";
  if (rawName) {
    const norm = normalizeTr(rawName);
    const byName = await client.query<{ id: string }>(
      `select id::text
         from public.parties
        where normalized_name = $1 or lower(btrim(name)) = lower(btrim($2))
        order by is_active desc, created_at asc
        limit 1`,
      [norm, rawName],
    );
    if (byName.rows[0]?.id) {
      return { partyId: byName.rows[0].id, stagedNew: false };
    }
  }

  // 5) Unknown party -> stage in integration_staged_parties (NEVER insert into public.parties!)
  const extContactId =
    contact.externalId ??
    `name:${createHash("sha256").update(rawName || "unknown").digest("hex").slice(0, 16)}`;
  const safeName = rawName || `Paraşüt Cari #${extContactId}`;

  const existingStage = await client.query<{ id: string; status: string; resolved_party_id: string | null }>(
    `select id::text, status, resolved_party_id::text
       from public.integration_staged_parties
      where provider = 'parasut' and external_contact_id = $1
      limit 1`,
    [extContactId],
  );
  if (existingStage.rows[0]) {
    return {
      partyId: existingStage.rows[0].resolved_party_id ?? null,
      stagedNew: false,
    };
  }

  await client.query(
    `insert into public.integration_staged_parties
       (provider, external_contact_id, raw_name, tax_id, iban, account_type, status)
     values ('parasut', $1, $2, $3, $4, $5, 'pending')
     on conflict (provider, external_contact_id) do nothing`,
    [extContactId, safeName, contact.taxId ?? null, contact.iban ?? null, contact.accountType ?? null],
  );

  return { partyId: null, stagedNew: true };
}

async function upsertMappedParasutInvoiceRecord(
  client: PoolClient,
  rec: ParasutFetchedRecord,
  payloadId: string | null,
): Promise<{
  outcome: "upserted" | "skipped" | "deferred_party" | "non_invoice";
  stagedNew: boolean;
}> {
  const mapped = mapParasutInvoice(rec);
  if (!mapped || mapped.isEstimate) {
    return { outcome: "non_invoice", stagedNew: false };
  }

  const partyRes = await resolveOrStageParty(client, {
    externalId: mapped.contactExternalId,
    name: mapped.contactName ?? mapped.spenderEmployeeName,
    taxId: mapped.contactTaxId,
    accountType: mapped.direction === "sales" ? "customer" : "vendor",
  });
  if (!partyRes.partyId) {
    return { outcome: "deferred_party", stagedNew: partyRes.stagedNew };
  }

  const existingInv = await client.query<{
    id: string;
    status: string;
    invoice_no: string;
    paid_amount: string;
  }>(
    `select id::text, status, invoice_no, paid_amount::text
       from public.invoices
      where external_key = $1
      limit 1`,
    [mapped.externalKey],
  );

  if (existingInv.rows[0]) {
    const cur = existingInv.rows[0];
    if (cur.status === "draft") {
      // S-4: Draft -> formalized upgrade allowed by 0044:183 while old.status = 'draft'
      const nextStatus =
        mapped.status === "partial" || mapped.status === "paid" ? "open" : mapped.status;
      const upd = await client.query<{ id: string }>(
        `update public.invoices
            set invoice_no = $2,
                issue_date = $3::date,
                due_date = $4::date,
                currency = $5,
                net_amount = $6,
                tax_amount = $7,
                gross_amount = $8,
                withholding_amount = $9,
                vat_withholding_amount = $10,
                payable_amount = $11,
                paid_amount = $12,
                status = $13,
                external_status = $14,
                spender_employee_name = coalesce($15, spender_employee_name),
                notes = coalesce($16, notes)
          where id = $1
          returning id::text`,
        [
          cur.id,
          mapped.invoiceNo,
          mapped.issueDate,
          mapped.dueDate,
          mapped.currency,
          mapped.netAmount,
          mapped.taxAmount,
          mapped.grossAmount,
          mapped.withholdingAmount,
          mapped.vatWithholdingAmount,
          mapped.payableAmount,
          mapped.paidAmount,
          nextStatus,
          mapped.externalStatus,
          mapped.spenderEmployeeName,
          mapped.description,
        ],
      );
      if (nextStatus === "open" && (mapped.status === "partial" || mapped.status === "paid")) {
        await client.query(
          `update public.invoices set status = $2, paid_amount = $3 where id = $1`,
          [cur.id, mapped.status, mapped.paidAmount],
        );
      }
      await upsertEntityLink(client, mapped.resourceType, mapped.externalId, "invoices", cur.id, payloadId);
      return {
        outcome: upd.rowCount ? "upserted" : "skipped",
        stagedNew: partyRes.stagedNew,
      };
    }

    // Already issued (old.status <> 'draft'): only settlement / status / external_status may update
    const currentPaid = Number(cur.paid_amount);
    const nextPaid = Math.max(currentPaid, mapped.paidAmount);
    const canTransitionStatus =
      cur.status !== mapped.status &&
      mapped.status !== "draft" &&
      mapped.status !== "cancelled";
    let didUpdate = false;
    if (nextPaid !== currentPaid || canTransitionStatus) {
      await client.query(
        `update public.invoices
            set paid_amount = $2,
                status = case when $3::boolean then $4 else status end,
                external_status = $5
          where id = $1`,
        [cur.id, nextPaid, canTransitionStatus, mapped.status, mapped.externalStatus],
      );
      didUpdate = true;
    }
    await upsertEntityLink(client, mapped.resourceType, mapped.externalId, "invoices", cur.id, payloadId);
    return {
      outcome: didUpdate ? "upserted" : "skipped",
      stagedNew: partyRes.stagedNew,
    };
  }

  // S-1 & S-4: Insert new invoice via ON CONFLICT (external_key) WHERE external_key IS NOT NULL
  const ins = await client.query<{ id: string }>(
    `insert into public.invoices
       (direction, invoice_no, party_id, issue_date, due_date, currency,
        net_amount, tax_amount, gross_amount,
        withholding_amount, vat_withholding_amount, payable_amount,
        paid_amount, status, external_status, external_key,
        spender_employee_name, dedupe_hash, notes)
     values ($1, $2, $3, $4::date, $5::date, $6,
             $7, $8, $9,
             $10, $11, $12,
             $13, $14, $15, $16,
             $17, $18, $19)
     on conflict (external_key) where external_key is not null do update
       set paid_amount = greatest(public.invoices.paid_amount, excluded.paid_amount),
           external_status = excluded.external_status
     returning id::text`,
    [
      mapped.direction,
      mapped.invoiceNo,
      partyRes.partyId,
      mapped.issueDate,
      mapped.dueDate,
      mapped.currency,
      mapped.netAmount,
      mapped.taxAmount,
      mapped.grossAmount,
      mapped.withholdingAmount,
      mapped.vatWithholdingAmount,
      mapped.payableAmount,
      mapped.paidAmount,
      mapped.status === "cancelled" ? "draft" : mapped.status,
      mapped.externalStatus,
      mapped.externalKey,
      mapped.spenderEmployeeName,
      mapped.externalKey,
      mapped.description,
    ],
  );
  const invoiceId = ins.rows[0].id;
  await upsertEntityLink(client, mapped.resourceType, mapped.externalId, "invoices", invoiceId, payloadId);
  return { outcome: "upserted", stagedNew: partyRes.stagedNew };
}

export interface DeferredInvoiceReplaySummary {
  replayedUpserted: number;
  stillDeferred: number;
}

/**
 * F-53 (S-10 Watermark Deferred Replay):
 * Replays invoice raw payloads (`sales_invoices`, `purchase_bills`) that were previously fetched
 * and stored in `integration_raw_payloads` before watermark advancement, but deferred from
 * `public.invoices` because their counterparty was awaiting S-10 operator approval.
 *
 * Once the staged contact is approved (`created` / `linked` or linked via `integration_entity_links`),
 * calling this function materializes all deferred invoices for that contact idempotently.
 */
export async function replayDeferredParasutInvoices(
  client: PoolClient,
): Promise<DeferredInvoiceReplaySummary> {
  const deferredRows = await client.query<{
    id: string;
    resource_type: string;
    external_id: string;
    external_updated_at: string | null;
    payload_sha256: string;
    payload_json: Record<string, unknown>;
  }>(
    `select distinct on (rp.resource_type, rp.external_id)
            rp.id::text as id,
            rp.resource_type,
            rp.external_id,
            rp.external_updated_at::text as external_updated_at,
            rp.payload_sha256,
            rp.payload_json
       from public.integration_raw_payloads rp
      where rp.resource_type in ('sales_invoices', 'purchase_bills')
        and not exists (
          select 1
            from public.integration_entity_links el
           where el.provider = 'parasut'
             and el.resource_type = rp.resource_type
             and el.external_id = rp.external_id
        )
        and not exists (
          select 1
            from public.invoices inv
           where inv.external_key = ('parasut:' || rp.resource_type || ':' || rp.external_id)
        )
      order by rp.resource_type, rp.external_id, rp.fetched_at desc, rp.id desc`,
  );

  let replayedUpserted = 0;
  let stillDeferred = 0;

  for (const row of deferredRows.rows) {
    const rec = reconstructFetchedRecordFromRawPayload(row);
    if (!rec) continue;
    const res = await upsertMappedParasutInvoiceRecord(client, rec, row.id);
    if (res.outcome === "upserted") {
      replayedUpserted += 1;
    } else if (res.outcome === "deferred_party") {
      stillDeferred += 1;
    }
  }

  return { replayedUpserted, stillDeferred };
}

export interface ParasutSyncOptions {
  limiterOptions?: RateLimiterOptions;
}

export function parasutConnector(options: ParasutSyncOptions = {}): IntegrationConnector {
  return {
    kind: "accounting",
    provider: "parasut",
    async authenticate(ctx: ConnectorContext) {
      const tokenRes = await acquireParasutAccessToken(ctx);
      if (!tokenRes.ok) {
        return {
          ok: false,
          error: tokenRes.error ?? "Paraşüt OAuth kimlik doğrulaması başarısız.",
          permanent: tokenRes.permanent ?? true,
        };
      }
      return { ok: true };
    },

    async sync(ctx: ConnectorContext, pool: Pool, actorId: string | null): Promise<SyncOutcome> {
      const tokenRes = await acquireParasutAccessToken(ctx);
      if (!tokenRes.ok || !tokenRes.accessToken || !tokenRes.companyId) {
        return {
          ok: false,
          imported: null,
          skipped: null,
          error: tokenRes.error ?? "Paraşüt OAuth kimlik doğrulaması başarısız.",
          permanent: tokenRes.permanent ?? true,
        };
      }

      const limiter = new ParasutRateLimiter(options.limiterOptions);
      const { accessToken, companyId } = tokenRes;

      // Resolve integration_id and high-water mark
      let connectionId = ctx.connectionId ?? null;
      if (!connectionId) {
        const connLookup = await pool.query<{ id: string }>(
          `select id::text from public.integration_connections
            where integration_kind = 'accounting' and lower(coalesce(provider, '')) = 'parasut'
            order by created_at desc limit 1`,
        );
        connectionId = connLookup.rows[0]?.id ?? null;
      }
      if (!connectionId) {
        const fallbackIns = await pool.query<{ id: string }>(
          `insert into public.integration_connections
             (integration_kind, name, provider, status, config)
           values ('accounting', 'Paraşüt API v4', 'parasut', 'enabled', $1::jsonb)
           on conflict (integration_kind, name) do update set provider = 'parasut'
           returning id::text`,
          [JSON.stringify({ companyId })],
        );
        connectionId = fallbackIns.rows[0].id;
      }

      const lastWatermarkRes = await pool.query<{ watermark_to: string | null }>(
        `select watermark_to::text
           from public.integration_sync_runs
          where integration_id = $1 and status in ('succeeded', 'partial') and watermark_to is not null
          order by finished_at desc nulls last
          limit 1`,
        [connectionId],
      );
      const sinceDays = typeof ctx.config.sinceDays === "number" ? ctx.config.sinceDays : 30;
      const watermarkFromISO = computeWatermarkOverlapFrom(
        lastWatermarkRes.rows[0]?.watermark_to ?? null,
        ctx.asOfISO,
        sinceDays,
      );

      const syncRunRes = await pool.query<{ id: string }>(
        `insert into public.integration_sync_runs
           (integration_id, started_at, watermark_from, status)
         values ($1, now(), $2::timestamptz, 'running')
         returning id::text`,
        [connectionId, watermarkFromISO],
      );
      const syncRunId = syncRunRes.rows[0].id;

      const resources: Array<{
        name: "contacts" | "accounts" | "sales_invoices" | "purchase_bills" | "transactions" | "bank_fees" | "taxes" | "salaries";
        include?: string[];
      }> = [
        { name: "contacts" },
        { name: "accounts" },
        { name: "sales_invoices", include: ["contact", "active_e_document", "details"] },
        { name: "purchase_bills", include: ["supplier", "spender", "details"] },
        { name: "transactions", include: ["debit_account", "credit_account"] },
        { name: "bank_fees" },
        { name: "taxes" },
        { name: "salaries" },
      ];

      const fetchedByResource = new Map<string, ParasutFetchedRecord[]>();
      let maxWatermarkISO: string | null = null;
      let totalFetched = 0;

      for (const spec of resources) {
        const pageRes = await fetchParasutResourcePages({
          http: ctx.http,
          limiter,
          companyId,
          accessToken,
          resource: spec.name,
          include: spec.include,
          watermarkFromISO,
        });

        if (!pageRes.ok) {
          await pool.query(
            `update public.integration_sync_runs
                set finished_at = now(), status = 'failed',
                    fetched_count = $2, error_summary = $3
              where id = $1`,
            [syncRunId, totalFetched, pageRes.error ?? "Paraşüt veri çekme hatası"],
          );
          return {
            ok: false,
            imported: null,
            skipped: null,
            syncRunId,
            error: pageRes.error,
            permanent: pageRes.permanent,
          };
        }

        fetchedByResource.set(spec.name, pageRes.records);
        totalFetched += pageRes.records.length;
        if (
          pageRes.maxUpdatedAtISO &&
          (!maxWatermarkISO || Date.parse(pageRes.maxUpdatedAtISO) > Date.parse(maxWatermarkISO))
        ) {
          maxWatermarkISO = pageRes.maxUpdatedAtISO;
        }
      }

      let upserted = 0;
      let skipped = 0;
      let stagedPartyCount = 0;

      const client = await pool.connect();
      try {
        await client.query("begin");

        // 1) Contacts -> resolve against public.parties or stage in integration_staged_parties (S-10)
        for (const rec of fetchedByResource.get("contacts") ?? []) {
          const payloadId = await recordRawPayload(client, syncRunId, rec);
          const mapped = mapParasutContact(rec.item, rec.includedIndex);
          if (!mapped) {
            skipped++;
            continue;
          }
          const resolved = await resolveOrStageParty(client, {
            externalId: mapped.externalId,
            name: mapped.name,
            taxId: mapped.taxId,
            iban: mapped.iban,
            accountType: mapped.accountType,
          });
          if (resolved.partyId) {
            await upsertEntityLink(client, "contacts", mapped.externalId, "parties", resolved.partyId, payloadId);
          } else if (resolved.stagedNew) {
            stagedPartyCount++;
          }
        }

        // 2) Accounts -> match by IBAN or name to bank_accounts/cash_accounts and record in integration_account_mappings
        const mappedExternalAccountIds = new Set<string>();
        const accountMapToBankId = new Map<string, string>();

        for (const rec of fetchedByResource.get("accounts") ?? []) {
          const payloadId = await recordRawPayload(client, syncRunId, rec);
          const mapped = mapParasutAccount(rec.item);
          if (!mapped) {
            skipped++;
            continue;
          }

          let cashAccountId: string | null = null;
          let bankAccountId: string | null = null;

          if (mapped.iban) {
            const byIban = await client.query<{ cash_account_id: string }>(
              `select cash_account_id::text
                 from public.bank_accounts
                where replace(upper(iban), ' ', '') = $1
                limit 1`,
              [mapped.iban],
            );
            if (byIban.rows[0]?.cash_account_id) {
              cashAccountId = byIban.rows[0].cash_account_id;
              bankAccountId = byIban.rows[0].cash_account_id;
            }
          }

          if (!cashAccountId) {
            const byName = await client.query<{ id: string; bank_id: string | null }>(
              `select ca.id::text as id, ba.cash_account_id::text as bank_id
                 from public.cash_accounts ca
                 left join public.bank_accounts ba on ba.cash_account_id = ca.id
                where lower(btrim(ca.name)) = lower(btrim($1))
                limit 1`,
              [mapped.name],
            );
            if (byName.rows[0]?.id) {
              cashAccountId = byName.rows[0].id;
              bankAccountId = byName.rows[0].bank_id;
            }
          }

          const upMap = await client.query<{ cash_account_id: string | null; bank_account_id: string | null }>(
            `insert into public.integration_account_mappings
               (provider, external_account_id, external_account_name, external_iban, external_currency, cash_account_id, bank_account_id)
             values ('parasut', $1, $2, $3, $4, $5, $6)
             on conflict (provider, external_account_id) do update
               set external_account_name = excluded.external_account_name,
                   external_iban = coalesce(excluded.external_iban, public.integration_account_mappings.external_iban),
                   external_currency = excluded.external_currency,
                   cash_account_id = coalesce(public.integration_account_mappings.cash_account_id, excluded.cash_account_id),
                   bank_account_id = coalesce(public.integration_account_mappings.bank_account_id, excluded.bank_account_id)
             returning cash_account_id::text, bank_account_id::text`,
            [mapped.externalId, mapped.name, mapped.iban, mapped.currency, cashAccountId, bankAccountId],
          );

          const effectiveBankId = upMap.rows[0]?.bank_account_id ?? bankAccountId;
          const effectiveCashId = upMap.rows[0]?.cash_account_id ?? cashAccountId;
          mappedExternalAccountIds.add(mapped.externalId);
          if (effectiveBankId) {
            accountMapToBankId.set(mapped.externalId, effectiveBankId);
            await upsertEntityLink(client, "accounts", mapped.externalId, "bank_accounts", effectiveBankId, payloadId);
          } else if (effectiveCashId) {
            await upsertEntityLink(client, "accounts", mapped.externalId, "cash_accounts", effectiveCashId, payloadId);
          }
        }

        // Load any pre-existing account mappings from DB
        const existingMaps = await client.query<{
          external_account_id: string;
          bank_account_id: string | null;
        }>(
          `select external_account_id, bank_account_id::text
             from public.integration_account_mappings
            where provider = 'parasut'`,
        );
        for (const r of existingMaps.rows) {
          mappedExternalAccountIds.add(r.external_account_id);
          if (r.bank_account_id) {
            accountMapToBankId.set(r.external_account_id, r.bank_account_id);
          }
        }

        // 3) Sales Invoices & Purchase Bills (S-1..S-7, S-10)
        const invoiceRecords = [
          ...(fetchedByResource.get("sales_invoices") ?? []),
          ...(fetchedByResource.get("purchase_bills") ?? []),
        ];

        for (const rec of invoiceRecords) {
          const payloadId = await recordRawPayload(client, syncRunId, rec);
          const invRes = await upsertMappedParasutInvoiceRecord(client, rec, payloadId);
          if (invRes.stagedNew) {
            stagedPartyCount++;
          }
          if (invRes.outcome === "upserted") {
            upserted++;
          } else {
            skipped++;
          }
        }

        // F-53: Replay any previously fetched invoices whose contacts were approved after watermark advanced
        const replayRes = await replayDeferredParasutInvoices(client);
        upserted += replayRes.replayedUpserted;

        // 4) Bank Transactions, Bank Fees, Taxes, Salaries (S-8, S-9, Cross-Channel Dedupe)
        const defaultBankRes = await client.query<{ cash_account_id: string }>(
          `select cash_account_id::text from public.bank_accounts order by created_at asc limit 1`,
        );
        const fallbackBankAccountId = defaultBankRes.rows[0]?.cash_account_id ?? null;

        const txRecords = [
          ...(fetchedByResource.get("transactions") ?? []),
          ...(fetchedByResource.get("bank_fees") ?? []),
          ...(fetchedByResource.get("taxes") ?? []),
          ...(fetchedByResource.get("salaries") ?? []),
        ];

        for (const rec of txRecords) {
          const payloadId = await recordRawPayload(client, syncRunId, rec);
          const legs = mapParasutTransaction(rec, mappedExternalAccountIds);
          if (legs.length === 0) {
            skipped++;
            continue;
          }

          for (const leg of legs) {
            const targetAccountExtId =
              leg.amount < 0
                ? leg.creditAccountExternalId ?? leg.debitAccountExternalId
                : leg.debitAccountExternalId ?? leg.creditAccountExternalId;
            const bankAccountId =
              (targetAccountExtId ? accountMapToBankId.get(targetAccountExtId) : null) ??
              fallbackBankAccountId;

            if (!bankAccountId) {
              skipped++;
              continue;
            }

            // Check if this exact Paraşüt transaction leg was already linked
            const existingLink = await client.query<{ entity_id: string }>(
              `select entity_id::text
                 from public.integration_entity_links
                where provider = 'parasut' and resource_type = $1 and external_id = $2
                limit 1`,
              [rec.resource, leg.externalId],
            );
            if (existingLink.rows[0]?.entity_id) {
              skipped++;
              continue;
            }

            const crossHash = computeCrossChannelDedupeHash({
              bankAccountId,
              txnDate: leg.date,
              amount: leg.amount,
              currency: leg.currency,
              reference: leg.referenceNo,
            });

            // Cross-channel check: was this bank movement already imported via MT940 / camt.053 / Excel?
            const existingCross = await client.query<{ id: string }>(
              `select bt.id::text
                 from public.bank_transactions bt
                where bt.bank_account_id = $1
                  and (
                    bt.cross_channel_dedupe_hash = $2
                    or (
                      bt.txn_date = $3::date
                      and bt.amount = $4::numeric
                      and bt.currency = $5
                      and not exists (
                        select 1 from public.integration_entity_links el
                         where el.provider = 'parasut'
                           and el.entity_table = 'bank_transactions'
                           and el.entity_id = bt.id
                      )
                    )
                  )
                order by bt.created_at asc
                limit 1`,
              [bankAccountId, crossHash, leg.date, leg.amount, leg.currency],
            );

            if (existingCross.rows[0]?.id) {
              const matchedTxId = existingCross.rows[0].id;
              await client.query(
                `update public.bank_transactions
                    set cross_channel_dedupe_hash = coalesce(cross_channel_dedupe_hash, $2),
                        transaction_kind = case
                          when transaction_kind = 'standard' and $3 <> 'standard' then $3
                          else transaction_kind
                        end
                  where id = $1`,
                [matchedTxId, crossHash, leg.transactionKind],
              );
              await upsertEntityLink(
                client,
                rec.resource,
                leg.externalId,
                "bank_transactions",
                matchedTxId,
                payloadId,
              );
              skipped++;
              continue;
            }

            const dedupeHash = `parasut:${rec.resource}:${leg.externalId}`;
            const insTx = await client.query<{ id: string }>(
              `insert into public.bank_transactions
                 (bank_account_id, txn_date, amount, currency, description,
                  counterparty_name_raw, reference_no, channel, status,
                  transaction_kind, dedupe_hash, cross_channel_dedupe_hash)
               values ($1, $2::date, $3::numeric, $4, $5,
                       $6, $7, 'parasut_api', 'unmatched',
                       $8, $9, $10)
               on conflict (bank_account_id, dedupe_hash) do nothing
               returning id::text`,
              [
                bankAccountId,
                leg.date,
                leg.amount,
                leg.currency,
                leg.description,
                leg.counterpartyName,
                leg.referenceNo,
                leg.transactionKind,
                dedupeHash,
                crossHash,
              ],
            );

            if (insTx.rows[0]?.id) {
              upserted++;
              await upsertEntityLink(
                client,
                rec.resource,
                leg.externalId,
                "bank_transactions",
                insTx.rows[0].id,
                payloadId,
              );
            } else {
              skipped++;
            }
          }
        }

        const effectiveWatermarkTo = maxWatermarkISO ?? new Date().toISOString();
        await client.query(
          `update public.integration_sync_runs
              set finished_at = now(),
                  watermark_to = $2::timestamptz,
                  status = 'succeeded',
                  fetched_count = $3,
                  upserted_count = $4,
                  staged_party_count = $5
            where id = $1`,
          [syncRunId, effectiveWatermarkTo, totalFetched, upserted, stagedPartyCount],
        );

        await audit(client, {
          actor: actorId,
          action: "parasut_v4_sync",
          entityTable: "integration_sync_runs",
          entityId: syncRunId,
          after: {
            companyId,
            watermarkFromISO,
            watermarkToISO: effectiveWatermarkTo,
            fetchedCount: totalFetched,
            upsertedCount: upserted,
            skippedCount: skipped,
            stagedPartyCount,
            readOnlyGetGuaranteed: true,
          },
        });

        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        await pool
          .query(
            `update public.integration_sync_runs
                set finished_at = now(), status = 'failed', error_summary = $2
              where id = $1`,
            [syncRunId, (e as Error).message.slice(0, 1000)],
          )
          .catch(() => undefined);
        return {
          ok: false,
          imported: null,
          skipped: null,
          syncRunId,
          error: (e as Error).message,
        };
      } finally {
        client.release();
      }

      return {
        ok: true,
        imported: upserted,
        skipped,
        stagedParties: stagedPartyCount,
        syncRunId,
      };
    },
  };
}
