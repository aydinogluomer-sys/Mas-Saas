// Turkish Open Banking (BKM TÖS / PSD2 AIS / Corporate Bank JSON) & ISO 20022 CAMT.053 Live Connector.
//
// Invariants:
//   - Network egress strictly via `HttpClient` (`ctx.http` / `defaultHttpClient`) from `@/lib/integrations/types`.
//   - Zero `fetch()`, zero `process.env`, zero floating-point SQL casts; all money math via `@/lib/money`.
//   - Raw payload lineage stored in `public.integration_raw_payloads` (SHA-256) + `audit()` trail.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { parseCamt053StatementBuffer } from "@/lib/importers/mt940-camt053-parser";
import {
  computeCrossChannelDedupeHash,
  normalizeParasutCurrency,
} from "@/lib/integrations/parasut/mappers";
import {
  defaultHttpClient,
  readCredential,
  type ConnectorContext,
  type HttpClient,
  type IntegrationConnector,
  type SyncOutcome,
} from "@/lib/integrations/types";
import { decimal, money } from "@/lib/money";

export const TURKISH_OPEN_BANKING_PROVIDERS = [
  "garanti",
  "garantibbva",
  "isbank",
  "yapikredi",
  "akbank",
  "qnb",
  "open_banking",
  "bkm_tos",
  "camt053",
  "turkish_bank",
] as const;

export type TurkishOpenBankingProvider = (typeof TURKISH_OPEN_BANKING_PROVIDERS)[number];

export function isTurkishOpenBankingProvider(provider: string | undefined | null): boolean {
  if (!provider) return false;
  const norm = provider.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (TURKISH_OPEN_BANKING_PROVIDERS as readonly string[]).includes(norm);
}

export interface NormalizedOpenBankingTransaction {
  externalId: string;
  txnDate: string;
  valueDate: string;
  amount: number;
  currency: string;
  description: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  referenceNo: string | null;
  externalAccountId: string | null;
  accountIban: string | null;
  transactionKind: "standard" | "own_transfer" | "bank_fee" | "tax_payment" | "payroll";
  rawItem: Record<string, unknown>;
}

function normalizeIban(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(cleaned) ? cleaned : null;
}

function parseFlexibleDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  const trMatch = s.match(/^(\d{2})[./-](\d{2})[./-](\d{4})/);
  if (trMatch) {
    return `${trMatch[3]}-${trMatch[2]}-${trMatch[1]}`;
  }
  return null;
}

/**
 * Parses monetary strings from Turkish Open Banking JSON or ISO/PSD2 payloads without float drift.
 * Handles `"1250.50"`, `"-1250.50"`, `"1.250,50"`, `"1250,50"`, or finite numbers.
 */
export function parseOpenBankingAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return money(raw);
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (!trimmed) return null;

  let normalized = trimmed;
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  if (lastComma > lastDot) {
    // Turkish decimal comma: e.g. "12.450,75" -> "12450.75"
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma && lastComma !== -1) {
    // US thousands comma: e.g. "12,450.75" -> "12450.75"
    normalized = normalized.replace(/,/g, "");
  }

  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return null;
  return money(normalized);
}

function classifyTransactionKind(
  description: string,
  rawType: string | null,
): NormalizedOpenBankingTransaction["transactionKind"] {
  const combined = `${description} ${rawType ?? ""}`.toLowerCase();
  if (/\b(bsmv|masraf|komisyon|eft ücreti|eft ucreti|havale ücreti|hesap işletim)\b/.test(combined)) {
    return "bank_fee";
  }
  if (/\b(vergi|sgk|gib|kdv ödemesi|muhtasar|damga vergisi)\b/.test(combined)) {
    return "tax_payment";
  }
  if (/\b(maaş|maas|bordro|ücret ödemesi|personel maaş)\b/.test(combined)) {
    return "payroll";
  }
  if (/\b(virman|kendi hesab|hesaplar arası)\b/.test(combined)) {
    return "own_transfer";
  }
  return "standard";
}

function applyDirectionSign(amount: number, indicatorRaw: unknown): number {
  if (typeof indicatorRaw !== "string" || !indicatorRaw.trim()) {
    return amount;
  }
  const ind = indicatorRaw.trim().toUpperCase();
  const absVal = decimal(amount).abs();
  if (
    ind === "B" ||
    ind === "BORC" ||
    ind === "BORÇ" ||
    ind === "DBIT" ||
    ind === "DEBIT" ||
    ind === "D" ||
    ind === "OUT" ||
    ind === "GIRIS_DEGIL" ||
    ind === "CIKIS" ||
    ind === "ÇIKIŞ"
  ) {
    return money(absVal.times(-1));
  }
  if (
    ind === "A" ||
    ind === "ALACAK" ||
    ind === "CRDT" ||
    ind === "CREDIT" ||
    ind === "C" ||
    ind === "IN" ||
    ind === "GIRIS" ||
    ind === "GİRİŞ"
  ) {
    return money(absVal);
  }
  return amount;
}

function extractEnvelopeAccountMeta(root: Record<string, unknown>): {
  accountIban: string | null;
  externalAccountId: string | null;
  currency: string | null;
} {
  const acctObj =
    root.account && typeof root.account === "object"
      ? (root.account as Record<string, unknown>)
      : root.hesap && typeof root.hesap === "object"
        ? (root.hesap as Record<string, unknown>)
        : root.data && typeof root.data === "object"
          ? (root.data as Record<string, unknown>)
          : null;

  const accountIban =
    normalizeIban(root.iban) ??
    normalizeIban(root.hesapIban) ??
    normalizeIban(acctObj?.iban) ??
    normalizeIban(acctObj?.hesapIban);

  const externalAccountId =
    (typeof root.accountId === "string" && root.accountId.trim()) ||
    (typeof root.hesapNo === "string" && root.hesapNo.trim()) ||
    (typeof acctObj?.id === "string" && acctObj.id.trim()) ||
    (typeof acctObj?.resourceId === "string" && acctObj.resourceId.trim()) ||
    (typeof acctObj?.hesapNo === "string" && acctObj.hesapNo.trim()) ||
    accountIban ||
    null;

  const currency =
    typeof root.currency === "string"
      ? normalizeParasutCurrency(root.currency)
      : typeof root.paraBirimi === "string"
        ? normalizeParasutCurrency(root.paraBirimi)
        : typeof acctObj?.currency === "string"
          ? normalizeParasutCurrency(acctObj.currency)
          : null;

  return { accountIban, externalAccountId, currency };
}

function extractJsonTransactionArray(root: Record<string, unknown>): unknown[] {
  if (Array.isArray(root.hesapHareketleri)) return root.hesapHareketleri;
  if (Array.isArray(root.accountTransactions)) return root.accountTransactions;
  if (Array.isArray(root.movements)) return root.movements;
  if (Array.isArray(root.transactions)) return root.transactions;
  if (root.transactions && typeof root.transactions === "object") {
    const txObj = root.transactions as Record<string, unknown>;
    if (Array.isArray(txObj.booked)) return txObj.booked;
    if (Array.isArray(txObj.items)) return txObj.items;
  }
  if (root.data && typeof root.data === "object") {
    const dataObj = root.data as Record<string, unknown>;
    if (Array.isArray(dataObj.hesapHareketleri)) return dataObj.hesapHareketleri;
    if (Array.isArray(dataObj.transactions)) return dataObj.transactions;
    if (Array.isArray(dataObj.accountTransactions)) return dataObj.accountTransactions;
    if (dataObj.transactions && typeof dataObj.transactions === "object") {
      const nested = dataObj.transactions as Record<string, unknown>;
      if (Array.isArray(nested.booked)) return nested.booked;
    }
  }
  return [];
}

/**
 * Parses Turkish BKM / TÖS / PSD2 Open Banking JSON payloads into canonical bank movements.
 */
export function parseTurkishOpenBankingJson(raw: unknown): NormalizedOpenBankingTransaction[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const meta = extractEnvelopeAccountMeta(root);
  const items = extractJsonTransactionArray(root);
  const out: NormalizedOpenBankingTransaction[] = [];

  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;

    const txAmtObj =
      r.transactionAmount && typeof r.transactionAmount === "object"
        ? (r.transactionAmount as Record<string, unknown>)
        : r.islemTutari && typeof r.islemTutari === "object"
          ? (r.islemTutari as Record<string, unknown>)
          : null;

    const rawAmountCandidate =
      txAmtObj?.amount ??
      txAmtObj?.tutar ??
      r.tutar ??
      r.islemTutari ??
      r.amount ??
      r.hareketTutari;

    const parsedAmt = parseOpenBankingAmount(rawAmountCandidate);
    if (parsedAmt === null) continue;

    const signedAmount = applyDirectionSign(
      parsedAmt,
      r.borcAlacak ?? r.borcAlacakKodu ?? r.creditDebitIndicator ?? r.islemYonu ?? r.direction,
    );

    const txnDate =
      parseFlexibleDate(r.islemTarihi) ??
      parseFlexibleDate(r.bookingDate) ??
      parseFlexibleDate(r.hareketTarihi) ??
      parseFlexibleDate(r.date) ??
      parseFlexibleDate(r.valueDate);
    if (!txnDate) continue;

    const valueDate =
      parseFlexibleDate(r.valorTarihi) ??
      parseFlexibleDate(r.valueDate) ??
      txnDate;

    const currency = normalizeParasutCurrency(
      txAmtObj?.currency ??
        txAmtObj?.paraBirimi ??
        r.paraBirimi ??
        r.dovizKodu ??
        r.currency ??
        meta.currency ??
        "TRY",
    );

    const cdtrAcct =
      r.creditorAccount && typeof r.creditorAccount === "object"
        ? (r.creditorAccount as Record<string, unknown>)
        : null;
    const dbtrAcct =
      r.debtorAccount && typeof r.debtorAccount === "object"
        ? (r.debtorAccount as Record<string, unknown>)
        : null;

    const counterpartyName =
      (typeof r.karsiTarafUnvan === "string" && r.karsiTarafUnvan.trim()) ||
      (typeof r.karsiAdSoyad === "string" && r.karsiAdSoyad.trim()) ||
      (typeof r.counterparty === "string" && r.counterparty.trim()) ||
      (signedAmount >= 0
        ? (typeof r.debtorName === "string" && r.debtorName.trim()) ||
          (typeof r.gonderenAdi === "string" && r.gonderenAdi.trim())
        : (typeof r.creditorName === "string" && r.creditorName.trim()) ||
          (typeof r.aliciAdi === "string" && r.aliciAdi.trim())) ||
      (typeof r.creditorName === "string" && r.creditorName.trim()) ||
      (typeof r.debtorName === "string" && r.debtorName.trim()) ||
      null;

    const counterpartyIban =
      normalizeIban(r.karsiIban) ??
      normalizeIban(r.karsiHesapIban) ??
      (signedAmount >= 0 ? normalizeIban(dbtrAcct?.iban) : normalizeIban(cdtrAcct?.iban)) ??
      normalizeIban(cdtrAcct?.iban) ??
      normalizeIban(dbtrAcct?.iban);

    const description =
      (typeof r.aciklama === "string" && r.aciklama.trim()) ||
      (typeof r.islemAciklamasi === "string" && r.islemAciklamasi.trim()) ||
      (typeof r.remittanceInformationUnstructured === "string" &&
        r.remittanceInformationUnstructured.trim()) ||
      (typeof r.description === "string" && r.description.trim()) ||
      "";

    const referenceNo =
      (typeof r.referansNo === "string" && r.referansNo.trim()) ||
      (typeof r.dekontNo === "string" && r.dekontNo.trim()) ||
      (typeof r.endToEndId === "string" && r.endToEndId.trim()) ||
      (typeof r.reference === "string" && r.reference.trim()) ||
      null;

    const accountIban =
      normalizeIban(r.iban) ??
      normalizeIban(r.hesapIban) ??
      meta.accountIban;

    const externalAccountId =
      (typeof r.accountId === "string" && r.accountId.trim()) ||
      (typeof r.hesapNo === "string" && r.hesapNo.trim()) ||
      meta.externalAccountId ||
      accountIban;

    const explicitId =
      (typeof r.hareketId === "string" && r.hareketId.trim()) ||
      (typeof r.islemId === "string" && r.islemId.trim()) ||
      (typeof r.transactionId === "string" && r.transactionId.trim()) ||
      (typeof r.entryReference === "string" && r.entryReference.trim()) ||
      (typeof r.id === "string" && r.id.trim()) ||
      (typeof r.id === "number" && Number.isFinite(r.id) ? String(r.id) : "") ||
      referenceNo;

    const externalId =
      explicitId ||
      createHash("sha256")
        .update(
          `${externalAccountId ?? ""}|${txnDate}|${signedAmount.toFixed(2)}|${currency}|${description}|${i}`,
        )
        .digest("hex")
        .slice(0, 32);

    const rawType =
      typeof r.islemTipi === "string"
        ? r.islemTipi
        : typeof r.proprietaryBankTransactionCode === "string"
          ? r.proprietaryBankTransactionCode
          : null;

    out.push({
      externalId,
      txnDate,
      valueDate,
      amount: signedAmount,
      currency,
      description,
      counterpartyName,
      counterpartyIban,
      referenceNo,
      externalAccountId,
      accountIban,
      transactionKind: classifyTransactionKind(description, rawType),
      rawItem: r,
    });
  }

  return out;
}

/**
 * Parses an ISO 20022 CAMT.053 XML payload into canonical bank movements (rejecting XXE).
 */
export function parseTurkishOpenBankingCamt053(xmlBody: string): NormalizedOpenBankingTransaction[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xmlBody)) {
    throw new DomainError(
      "VALIDATION",
      "Güvenlik politikası gereği DTD/ENTITY (XXE) içeren CAMT.053 XML belgesi reddedildi.",
    );
  }
  const stmtAcctIbanMatch = xmlBody.match(
    /<(?:[a-zA-Z0-9_]+:)?Acct[\s\S]*?<(?:[a-zA-Z0-9_]+:)?IBAN>\s*([A-Z0-9\s]+)\s*<\/(?:[a-zA-Z0-9_]+:)?IBAN>/i,
  );
  const stmtIban = normalizeIban(stmtAcctIbanMatch?.[1] ?? null);
  const stmtIdMatch = xmlBody.match(
    /<(?:[a-zA-Z0-9_]+:)?Stmt[\s\S]*?<(?:[a-zA-Z0-9_]+:)?Id>\s*([^<\s]+)\s*<\/(?:[a-zA-Z0-9_]+:)?Id>/i,
  );
  const stmtId = stmtIdMatch?.[1]?.trim() ?? "stmt";

  const parsed = parseCamt053StatementBuffer(Buffer.from(xmlBody, "utf8"));
  if (!parsed.ok) {
    throw new DomainError("VALIDATION", parsed.error);
  }

  const out: NormalizedOpenBankingTransaction[] = [];
  // Row 0 is header: ["Tarih","Valör","Tutar","Para Birimi","Açıklama","Karşı Taraf","Karşı IBAN","Referans"]
  for (let i = 1; i < parsed.rows.length; i++) {
    const [txDate, valDate, signedAmtTr, ccy, desc, counterparty, cpIban, ref] = parsed.rows[i];
    const amt = parseOpenBankingAmount(signedAmtTr);
    if (amt === null || !txDate) continue;
    const referenceNo = ref?.trim() ? ref.trim() : null;
    const externalId =
      referenceNo ??
      createHash("sha256")
        .update(`${stmtId}|${stmtIban ?? ""}|${txDate}|${amt.toFixed(2)}|${ccy}|${desc}|${i}`)
        .digest("hex")
        .slice(0, 32);

    out.push({
      externalId,
      txnDate: txDate,
      valueDate: valDate || txDate,
      amount: amt,
      currency: normalizeParasutCurrency(ccy),
      description: desc || "",
      counterpartyName: counterparty?.trim() ? counterparty.trim() : null,
      counterpartyIban: normalizeIban(cpIban),
      referenceNo,
      externalAccountId: stmtIban,
      accountIban: stmtIban,
      transactionKind: classifyTransactionKind(desc || "", null),
      rawItem: {
        format: "camt053",
        stmtId,
        stmtIban,
        txDate,
        valDate,
        amount: amt,
        currency: ccy,
        description: desc,
        counterparty,
        counterpartyIban: cpIban,
        referenceNo,
      },
    });
  }
  return out;
}

/**
 * Parses either Turkish Open Banking JSON or CAMT.053 XML response payloads.
 */
export function parseOpenBankingPayload(
  body: string,
  contentType?: string | null,
): { format: "json" | "camt053"; transactions: NormalizedOpenBankingTransaction[] } {
  const trimmed = body.replace(/^\uFEFF/, "").trim();
  const isXml =
    trimmed.startsWith("<") ||
    (typeof contentType === "string" && /xml/i.test(contentType));

  if (isXml) {
    return {
      format: "camt053",
      transactions: parseTurkishOpenBankingCamt053(trimmed),
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch {
    throw new DomainError("VALIDATION", "Açık Bankacılık yanıtı geçerli bir JSON veya CAMT.053 XML değil.");
  }
  return {
    format: "json",
    transactions: parseTurkishOpenBankingJson(parsedJson),
  };
}

export interface FetchTurkishBankTransactionsOptions {
  endpointUrl: string;
  credential?: string | null;
  credentialEnvVar?: string | null;
  accept?: string;
  extraHeaders?: Record<string, string>;
}

/**
 * Fetches & parses Turkish Open Banking movimientos over the `HttpClient` network seam.
 */
export async function fetchTurkishBankTransactions(
  options: FetchTurkishBankTransactionsOptions,
  httpClient: HttpClient = defaultHttpClient,
): Promise<{
  rawBody: string;
  payloadSha256: string;
  format: "json" | "camt053";
  transactions: NormalizedOpenBankingTransaction[];
}> {
  const token =
    options.credential ??
    (options.credentialEnvVar ? readCredential(options.credentialEnvVar) : null);
  if (!token) {
    throw new DomainError("VALIDATION", "Açık Bankacılık kimlik bilgisi tanımlı değil.");
  }

  const res = await httpClient.send({
    url: options.endpointUrl,
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: options.accept ?? "application/json, application/xml;q=0.9",
      ...(options.extraHeaders ?? {}),
    },
  });

  if (!res.ok) {
    throw new DomainError(
      res.status === 401 || res.status === 403 ? "FORBIDDEN" : "CONFLICT",
      res.error ?? `Açık Bankacılık HTTP ${res.status}`,
    );
  }

  const payloadSha256 = createHash("sha256").update(res.body, "utf8").digest("hex");
  const parsed = parseOpenBankingPayload(res.body, res.headers?.["content-type"] ?? null);
  return {
    rawBody: res.body,
    payloadSha256,
    format: parsed.format,
    transactions: parsed.transactions,
  };
}

async function resolveOrCreateSyncRun(
  pool: Pool,
  provider: string,
  connectionIdHint: string | undefined,
  watermarkFromISO: string,
): Promise<string> {
  let connectionId = connectionIdHint ?? null;
  if (!connectionId) {
    const existing = await pool.query<{ id: string }>(
      `select id::text
         from public.integration_connections
        where integration_kind = 'bank_api' and lower(coalesce(provider, '')) = lower($1)
        order by created_at desc limit 1`,
      [provider],
    );
    connectionId = existing.rows[0]?.id ?? null;
  }
  if (!connectionId) {
    const created = await pool.query<{ id: string }>(
      `insert into public.integration_connections
         (integration_kind, name, provider, status, config)
       values ('bank_api', $1, $2, 'enabled', '{}'::jsonb)
       on conflict (integration_kind, name) do update set provider = excluded.provider
       returning id::text`,
      [`Açık Bankacılık (${provider})`, provider],
    );
    connectionId = created.rows[0].id;
  }

  const runRes = await pool.query<{ id: string }>(
    `insert into public.integration_sync_runs
       (integration_id, started_at, watermark_from, status)
     values ($1::uuid, now(), $2::timestamptz, 'running')
     returning id::text`,
    [connectionId, watermarkFromISO],
  );
  return runRes.rows[0].id;
}

async function resolveBankAccountForMovement(
  client: PoolClient,
  provider: string,
  tx: NormalizedOpenBankingTransaction,
  configuredBankAccountId: string | null,
): Promise<string | null> {
  if (tx.externalAccountId) {
    const byExtId = await client.query<{ bank_account_id: string }>(
      `select bank_account_id::text
         from public.integration_account_mappings
        where provider = $1
          and external_account_id = $2
          and bank_account_id is not null
        limit 1`,
      [provider, tx.externalAccountId],
    );
    if (byExtId.rows[0]?.bank_account_id) {
      return byExtId.rows[0].bank_account_id;
    }
  }

  if (tx.accountIban) {
    const byMappedIban = await client.query<{ bank_account_id: string }>(
      `select bank_account_id::text
         from public.integration_account_mappings
        where provider = $1
          and replace(upper(coalesce(external_iban, '')), ' ', '') = $2
          and bank_account_id is not null
        order by updated_at desc
        limit 1`,
      [provider, tx.accountIban],
    );
    if (byMappedIban.rows[0]?.bank_account_id) {
      return byMappedIban.rows[0].bank_account_id;
    }

    const byBankIban = await client.query<{ cash_account_id: string }>(
      `select cash_account_id::text
         from public.bank_accounts
        where replace(upper(coalesce(iban, '')), ' ', '') = $1
        limit 1`,
      [tx.accountIban],
    );
    if (byBankIban.rows[0]?.cash_account_id) {
      const resolvedId = byBankIban.rows[0].cash_account_id;
      await client.query(
        `insert into public.integration_account_mappings
           (provider, external_account_id, external_iban, external_currency, cash_account_id, bank_account_id)
         values ($1, $2, $3, $4, $5::uuid, $5::uuid)
         on conflict (provider, external_account_id) do update
           set external_iban = excluded.external_iban,
               bank_account_id = coalesce(public.integration_account_mappings.bank_account_id, excluded.bank_account_id),
               cash_account_id = coalesce(public.integration_account_mappings.cash_account_id, excluded.cash_account_id)`,
        [provider, tx.externalAccountId ?? tx.accountIban, tx.accountIban, tx.currency, resolvedId],
      );
      return resolvedId;
    }
  }

  if (configuredBankAccountId) {
    return configuredBankAccountId;
  }

  const fallbackMapped = await client.query<{ bank_account_id: string }>(
    `select bank_account_id::text
       from public.integration_account_mappings
      where provider = $1 and bank_account_id is not null
      order by updated_at desc limit 1`,
    [provider],
  );
  if (fallbackMapped.rows[0]?.bank_account_id) {
    return fallbackMapped.rows[0].bank_account_id;
  }

  const firstBank = await client.query<{ cash_account_id: string }>(
    `select cash_account_id::text from public.bank_accounts order by created_at asc limit 1`,
  );
  return firstBank.rows[0]?.cash_account_id ?? null;
}

async function recordRawPayloadEvidence(
  client: PoolClient,
  syncRunId: string,
  resourceType: string,
  externalId: string,
  payloadObj: unknown,
  explicitSha256?: string,
): Promise<string | null> {
  const jsonStr = JSON.stringify(payloadObj);
  const sha = explicitSha256 ?? createHash("sha256").update(jsonStr, "utf8").digest("hex");
  const ins = await client.query<{ id: string }>(
    `insert into public.integration_raw_payloads
       (sync_run_id, resource_type, external_id, payload_sha256, payload_json)
     values ($1::uuid, $2, $3, $4, $5::jsonb)
     on conflict (resource_type, external_id, payload_sha256) do nothing
     returning id::text`,
    [syncRunId, resourceType, externalId, sha, jsonStr],
  );
  if (ins.rows[0]?.id) return ins.rows[0].id;
  const existing = await client.query<{ id: string }>(
    `select id::text
       from public.integration_raw_payloads
      where resource_type = $1 and external_id = $2 and payload_sha256 = $3
      limit 1`,
    [resourceType, externalId, sha],
  );
  return existing.rows[0]?.id ?? null;
}

export function turkishBankConnector(provider = "open_banking"): IntegrationConnector {
  const normalizedProvider = provider.trim().toLowerCase() || "open_banking";

  return {
    kind: "bank_api",
    provider: normalizedProvider,
    async authenticate(ctx: ConnectorContext) {
      const token =
        ctx.credential ??
        (typeof ctx.config.credentialEnvVar === "string"
          ? readCredential(ctx.config.credentialEnvVar)
          : null);
      if (!token) {
        return { ok: false, error: "Açık Bankacılık kimlik bilgisi tanımlı değil", permanent: true };
      }
      const base = typeof ctx.config.baseUrl === "string" ? ctx.config.baseUrl.replace(/\/$/, "") : null;
      if (!base) {
        return { ok: false, error: "baseUrl yapılandırılmamış", permanent: true };
      }
      const accountsPath =
        typeof ctx.config.accountsPath === "string" ? ctx.config.accountsPath : "/accounts";
      const res = await ctx.http.send({
        url: `${base}${accountsPath.startsWith("/") ? accountsPath : `/${accountsPath}`}`,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, application/xml;q=0.9",
        },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `Kimlik doğrulama reddedildi (${res.status})`, permanent: true };
      }
      return res.ok ? { ok: true } : { ok: false, error: res.error ?? `HTTP ${res.status}` };
    },

    async sync(ctx: ConnectorContext, pool: Pool, actorId: string | null): Promise<SyncOutcome> {
      const base = typeof ctx.config.baseUrl === "string" ? ctx.config.baseUrl.replace(/\/$/, "") : null;
      const token =
        ctx.credential ??
        (typeof ctx.config.credentialEnvVar === "string"
          ? readCredential(ctx.config.credentialEnvVar)
          : null);
      if (!base || !token) {
        return {
          ok: false,
          imported: null,
          skipped: null,
          error: "Açık Bankacılık yapılandırması (baseUrl / kimlik bilgisi) eksik",
          permanent: true,
        };
      }

      const sinceDays = typeof ctx.config.sinceDays === "number" ? ctx.config.sinceDays : 7;
      const sinceISO = new Date(Date.parse(`${ctx.asOfISO}T00:00:00Z`) - sinceDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const txPath =
        typeof ctx.config.transactionsPath === "string"
          ? ctx.config.transactionsPath
          : "/transactions";
      const sep = txPath.includes("?") ? "&" : "?";
      const endpointUrl = `${base}${txPath.startsWith("/") ? txPath : `/${txPath}`}${sep}from=${sinceISO}&to=${ctx.asOfISO}`;

      const res = await ctx.http.send({
        url: endpointUrl,
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, application/xml;q=0.9",
          ...(typeof ctx.config.consentId === "string"
            ? { "x-consent-id": ctx.config.consentId }
            : {}),
        },
      });

      if (!res.ok) {
        return {
          ok: false,
          imported: null,
          skipped: null,
          error: res.error ?? `HTTP ${res.status}`,
          permanent: res.status === 401 || res.status === 403,
        };
      }

      let parsedPayload: { format: "json" | "camt053"; transactions: NormalizedOpenBankingTransaction[] };
      try {
        parsedPayload = parseOpenBankingPayload(res.body, res.headers?.["content-type"] ?? null);
      } catch (e) {
        return {
          ok: false,
          imported: null,
          skipped: null,
          error: (e as Error).message,
          permanent: true,
        };
      }

      const envelopeSha256 = createHash("sha256").update(res.body, "utf8").digest("hex");
      const syncRunId = await resolveOrCreateSyncRun(
        pool,
        normalizedProvider,
        ctx.connectionId,
        `${sinceISO}T00:00:00Z`,
      );

      let imported = 0;
      let skipped = 0;
      const configuredBankAccountId =
        typeof ctx.config.bankAccountId === "string" ? ctx.config.bankAccountId : null;

      const client = await pool.connect();
      try {
        await client.query("begin");

        // Record envelope-level SHA-256 lineage
        await recordRawPayloadEvidence(
          client,
          syncRunId,
          `open_banking_${parsedPayload.format}_envelope`,
          `${normalizedProvider}:${sinceISO}:${ctx.asOfISO}`,
          {
            provider: normalizedProvider,
            format: parsedPayload.format,
            since: sinceISO,
            to: ctx.asOfISO,
            itemCount: parsedPayload.transactions.length,
          },
          envelopeSha256,
        );

        for (const tx of parsedPayload.transactions) {
          const bankAccountId = await resolveBankAccountForMovement(
            client,
            normalizedProvider,
            tx,
            configuredBankAccountId,
          );
          if (!bankAccountId) {
            await client.query("rollback");
            await pool
              .query(
                `update public.integration_sync_runs
                    set finished_at = now(), status = 'failed', error_summary = $2
                  where id = $1::uuid`,
                [syncRunId, "Tanımlı veya eşleşen banka hesabı bulunamadı"],
              )
              .catch(() => undefined);
            return {
              ok: false,
              imported: null,
              skipped: null,
              syncRunId,
              error: "Tanımlı banka hesabı yok — önce hesap veya IBAN eşlemesi tanımlanmalı",
              permanent: true,
            };
          }

          const payloadId = await recordRawPayloadEvidence(
            client,
            syncRunId,
            "open_banking_transaction",
            tx.externalId,
            tx.rawItem,
          );

          const crossHash = computeCrossChannelDedupeHash({
            bankAccountId,
            txnDate: tx.txnDate,
            amount: tx.amount,
            currency: tx.currency,
            reference: tx.referenceNo ?? tx.externalId,
          });

          const existingCross = await client.query<{ id: string }>(
            `select id::text
               from public.bank_transactions
              where bank_account_id = $1::uuid
                and cross_channel_dedupe_hash = $2
              limit 1`,
            [bankAccountId, crossHash],
          );
          if (existingCross.rows[0]?.id) {
            skipped += 1;
            continue;
          }

          const dedupeHash = `openbanking:${normalizedProvider}:${tx.externalId}`;
          const ins = await client.query<{ id: string }>(
            `insert into public.bank_transactions
               (bank_account_id, txn_date, amount, currency, description,
                counterparty_name_raw, reference_no, channel, status,
                transaction_kind, dedupe_hash, cross_channel_dedupe_hash)
             values ($1::uuid, $2::date, $3::numeric, $4, $5,
                     $6, $7, 'open_banking_api', 'unmatched',
                     $8, $9, $10)
             on conflict (bank_account_id, dedupe_hash) do nothing
             returning id::text`,
            [
              bankAccountId,
              tx.txnDate,
              tx.amount,
              tx.currency,
              tx.description,
              tx.counterpartyName,
              tx.referenceNo,
              tx.transactionKind,
              dedupeHash,
              crossHash,
            ],
          );

          if ((ins.rowCount ?? 0) > 0 && ins.rows[0]?.id) {
            imported += 1;
            await client.query(
              `insert into public.integration_entity_links
                 (provider, resource_type, external_id, entity_table, entity_id, last_payload_id, last_synced_at)
               values ($1, 'open_banking_transaction', $2, 'bank_transactions', $3::uuid, $4::uuid, now())
               on conflict (provider, resource_type, external_id) do update
                 set entity_id = excluded.entity_id,
                     last_payload_id = coalesce(excluded.last_payload_id, public.integration_entity_links.last_payload_id),
                     last_synced_at = now()`,
              [normalizedProvider, tx.externalId, ins.rows[0].id, payloadId],
            );
          } else {
            skipped += 1;
          }
        }

        const updRun = await client.query(
          `update public.integration_sync_runs
              set finished_at = now(),
                  watermark_to = $2::timestamptz,
                  status = 'succeeded',
                  fetched_count = $3,
                  upserted_count = $4
            where id = $1::uuid`,
          [syncRunId, `${ctx.asOfISO}T23:59:59Z`, parsedPayload.transactions.length, imported],
        );

        if ((updRun.rowCount ?? 0) > 0) {
          await audit(client, {
            actor: actorId,
            action: "open_banking_sync",
            entityTable: "integration_sync_runs",
            entityId: syncRunId,
            after: {
              provider: normalizedProvider,
              format: parsedPayload.format,
              since: sinceISO,
              to: ctx.asOfISO,
              envelopeSha256,
              fetchedCount: parsedPayload.transactions.length,
              imported,
              skipped,
            },
          });
        }

        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        await pool
          .query(
            `update public.integration_sync_runs
                set finished_at = now(), status = 'failed', error_summary = $2
              where id = $1::uuid`,
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
        imported,
        skipped,
        syncRunId,
      };
    },
  };
}
