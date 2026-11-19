// GİB Special Integrator (`Foriba/FitBulut`, `Uyumsoft`, `İzibiz`, `QNB eFinans`) Read-Only e-Invoice Connector.
//
// Invariants:
//   - Network egress strictly via `HttpClient` (`ctx.http` / `defaultHttpClient`) from `@/lib/integrations/types`.
//   - Zero `fetch()`, zero `process.env`, zero floating-point SQL casts; exact amounts via `@/lib/money`.
//   - S-10 Shield: Unknown VKN / counterparties are staged in `public.integration_staged_parties` (`status = 'pending'`)
//     and NEVER auto-inserted into `public.parties`.
//   - SHA-256 raw payload lineage recorded in `public.integration_raw_payloads` + `audit()` trail.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { normalizeTr } from "@/lib/importers/workbook-parser";
import {
  parseUblTrInvoiceXml,
  type ParsedUblTrInvoice,
  type UblInvoiceLineParsed,
} from "@/lib/integrations/einvoice/ubl-tr-parser";
import { normalizeParasutCurrency } from "@/lib/integrations/parasut/mappers";
import {
  defaultHttpClient,
  readCredential,
  type ConnectorContext,
  type HttpClient,
  type IntegrationConnector,
  type SyncOutcome,
} from "@/lib/integrations/types";
import { decimal, money, moneyOrNull } from "@/lib/money";

export const GIB_SPECIAL_INTEGRATOR_PROVIDERS = [
  "foriba",
  "fitbulut",
  "uyumsoft",
  "izibiz",
  "qnb_efinans",
  "qnbefinans",
  "earsiv",
  "gib_integrator",
  "ubl_tr",
] as const;

export type GibSpecialIntegratorProvider = (typeof GIB_SPECIAL_INTEGRATOR_PROVIDERS)[number];

export function isGibSpecialIntegratorProvider(provider: string | undefined | null): boolean {
  if (!provider) return false;
  const norm = provider.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (GIB_SPECIAL_INTEGRATOR_PROVIDERS as readonly string[]).includes(norm);
}

export interface NormalizedIntegratorInvoice {
  ublUuid: string;
  invoiceNo: string;
  profileId: string;
  invoiceTypeCode: string;
  directionHint: "purchase" | "sales" | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  supplierName: string;
  supplierVkn: string | null;
  customerName: string;
  customerVkn: string | null;
  netAmount: number;
  vatAmount: number;
  discountTotal: number;
  withholdingAmount: number;
  payableAmount: number;
  grossAmount: number;
  lines: UblInvoiceLineParsed[];
  rawSource: string;
  payloadSha256: string;
  rawEnvelope: Record<string, unknown>;
}

function rejectXxe(xml: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new DomainError(
      "VALIDATION",
      "Güvenlik politikası gereği DTD/ENTITY (XXE) içeren e-Fatura XML belgesi reddedildi.",
    );
  }
}

function cleanTaxId(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const digits = String(raw).replace(/\D+/g, "");
  return digits.length >= 10 && digits.length <= 11 ? digits : null;
}

function parseIsoOrTrDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const tr = s.match(/^(\d{2})[./-](\d{2})[./-](\d{4})/);
  if (tr) return `${tr[3]}-${tr[2]}-${tr[1]}`;
  return null;
}

function parseAmountField(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? money(raw) : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (!trimmed) return null;
  const lastComma = trimmed.lastIndexOf(",");
  const lastDot = trimmed.lastIndexOf(".");
  let norm = trimmed;
  if (lastComma > lastDot) {
    norm = trimmed.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma && lastComma !== -1) {
    norm = trimmed.replace(/,/g, "");
  }
  return moneyOrNull(norm);
}

function fromParsedUbl(
  parsed: ParsedUblTrInvoice,
  rawXml: string,
  envelopeMeta: Record<string, unknown> = {},
): NormalizedIntegratorInvoice {
  const totalDiscount = parsed.lines.reduce(
    (acc, ln) => money(decimal(acc).plus(ln.discountAmount)),
    0,
  );
  const dirRaw =
    typeof envelopeMeta.direction === "string"
      ? envelopeMeta.direction.toLowerCase()
      : typeof envelopeMeta.documentDirection === "string"
        ? envelopeMeta.documentDirection.toLowerCase()
        : "";
  const directionHint: "purchase" | "sales" | null =
    dirRaw === "outbound" || dirRaw === "outbox" || dirRaw === "sales" || dirRaw === "giden"
      ? "sales"
      : dirRaw === "inbound" || dirRaw === "inbox" || dirRaw === "purchase" || dirRaw === "gelen"
        ? "purchase"
        : null;

  return {
    ublUuid: parsed.ublUuid,
    invoiceNo: parsed.invoiceNo,
    profileId: parsed.profileId,
    invoiceTypeCode: parsed.invoiceTypeCode,
    directionHint,
    issueDate: parsed.issueDate,
    dueDate: parsed.dueDate,
    currency: parsed.currency,
    supplierName: parsed.supplierName,
    supplierVkn: parsed.supplierVkn,
    customerName: parsed.customerName,
    customerVkn: parsed.customerVkn,
    netAmount: parsed.netAmount,
    vatAmount: parsed.vatAmount,
    discountTotal: totalDiscount,
    withholdingAmount: parsed.withholdingAmount,
    payableAmount: parsed.payableAmount,
    grossAmount: parsed.grossAmount,
    lines: parsed.lines,
    rawSource: rawXml,
    payloadSha256: createHash("sha256").update(rawXml, "utf8").digest("hex"),
    rawEnvelope: {
      ...envelopeMeta,
      ublUuid: parsed.ublUuid,
      invoiceNo: parsed.invoiceNo,
      issueDate: parsed.issueDate,
      supplierVkn: parsed.supplierVkn,
      customerVkn: parsed.customerVkn,
      grossAmount: parsed.grossAmount,
      payableAmount: parsed.payableAmount,
      currency: parsed.currency,
    },
  };
}

function decodeEmbeddedUblXml(item: Record<string, unknown>): string | null {
  const rawXmlCandidates = [item.ublXml, item.xml, item.xmlContent, item.rawXml, item.ubl];
  for (const c of rawXmlCandidates) {
    if (typeof c === "string" && c.trim().startsWith("<")) {
      return c.trim();
    }
  }
  const b64Candidates = [
    item.xmlBase64,
    item.ublBase64,
    item.documentBase64,
    item.contentBase64,
    item.binaryData,
  ];
  for (const c of b64Candidates) {
    if (typeof c === "string" && c.trim().length > 16) {
      const decoded = Buffer.from(c.trim(), "base64").toString("utf8").trim();
      if (decoded.includes("<") && /Invoice\b/i.test(decoded)) {
        return decoded;
      }
    }
  }
  return null;
}

function extractEnvelopeItems(root: Record<string, unknown>): unknown[] {
  if (Array.isArray(root.invoices)) return root.invoices;
  if (Array.isArray(root.envelopeList)) return root.envelopeList;
  if (Array.isArray(root.documents)) return root.documents;
  if (Array.isArray(root.items)) return root.items;
  if (Array.isArray(root.faturalar)) return root.faturalar;
  if (root.data && typeof root.data === "object") {
    const d = root.data as Record<string, unknown>;
    if (Array.isArray(d.invoices)) return d.invoices;
    if (Array.isArray(d.items)) return d.items;
    if (Array.isArray(d.documents)) return d.documents;
    if (Array.isArray(d.envelopeList)) return d.envelopeList;
  }
  if (Array.isArray(root.result)) return root.result;
  return [];
}

/**
 * Parses a GİB Special Integrator response (either direct UBL-TR 1.2 XML or REST JSON envelope list
 * with embedded UBL-TR XML / base64 XML / structured e-Invoice summary metadata).
 */
export function parseIntegratorEInvoicePayload(
  body: string,
  contentType?: string | null,
): NormalizedIntegratorInvoice[] {
  const trimmed = body.replace(/^\uFEFF/, "").trim();
  const looksLikeXml =
    trimmed.startsWith("<") ||
    (typeof contentType === "string" && /xml/i.test(contentType));

  if (looksLikeXml) {
    rejectXxe(trimmed);
    const parsed = parseUblTrInvoiceXml(trimmed);
    return [fromParsedUbl(parsed, trimmed)];
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch {
    throw new DomainError(
      "VALIDATION",
      "Özel entegratör e-Fatura yanıtı geçerli bir JSON veya UBL-TR XML değil.",
    );
  }

  const list = Array.isArray(parsedJson)
    ? parsedJson
    : parsedJson && typeof parsedJson === "object"
      ? extractEnvelopeItems(parsedJson as Record<string, unknown>)
      : [];

  const out: NormalizedIntegratorInvoice[] = [];

  for (const rawItem of list) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;

    const embeddedXml = decodeEmbeddedUblXml(item);
    if (embeddedXml) {
      rejectXxe(embeddedXml);
      const parsedUbl = parseUblTrInvoiceXml(embeddedXml);
      const safeMeta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item)) {
        if (
          k !== "ublXml" &&
          k !== "xml" &&
          k !== "xmlContent" &&
          k !== "rawXml" &&
          k !== "xmlBase64" &&
          k !== "ublBase64" &&
          k !== "documentBase64" &&
          k !== "contentBase64" &&
          k !== "binaryData"
        ) {
          safeMeta[k] = v;
        }
      }
      out.push(fromParsedUbl(parsedUbl, embeddedXml, safeMeta));
      continue;
    }

    // Structured JSON summary fallback when integrator list endpoint returns metadata directly
    const ublUuid =
      (typeof item.uuid === "string" && item.uuid.trim()) ||
      (typeof item.ettn === "string" && item.ettn.trim()) ||
      (typeof item.documentUuid === "string" && item.documentUuid.trim()) ||
      null;
    const invoiceNo =
      (typeof item.invoiceNumber === "string" && item.invoiceNumber.trim()) ||
      (typeof item.invoiceNo === "string" && item.invoiceNo.trim()) ||
      (typeof item.belgeNo === "string" && item.belgeNo.trim()) ||
      (typeof item.documentId === "string" && item.documentId.trim()) ||
      null;
    const issueDate =
      parseIsoOrTrDate(item.issueDate) ??
      parseIsoOrTrDate(item.faturaTarihi) ??
      parseIsoOrTrDate(item.documentDate);

    if (!ublUuid || !invoiceNo || !issueDate) continue;

    const dueDate = parseIsoOrTrDate(item.dueDate ?? item.vadeTarihi);
    const currency = normalizeParasutCurrency(item.currency ?? item.paraBirimi ?? "TRY");
    const supplierVkn = cleanTaxId(item.supplierVkn ?? item.senderVkn ?? item.vknTckn ?? item.senderIdentifier);
    const customerVkn = cleanTaxId(item.customerVkn ?? item.receiverVkn ?? item.receiverIdentifier);
    const supplierName =
      (typeof item.supplierName === "string" && item.supplierName.trim()) ||
      (typeof item.senderTitle === "string" && item.senderTitle.trim()) ||
      (typeof item.unvan === "string" && item.unvan.trim()) ||
      "Bilinmeyen Tedarikçi";
    const customerName =
      (typeof item.customerName === "string" && item.customerName.trim()) ||
      (typeof item.receiverTitle === "string" && item.receiverTitle.trim()) ||
      "Bilinmeyen Alıcı";

    const rawNet = parseAmountField(item.netAmount ?? item.taxExclusiveAmount ?? item.matrah);
    const rawVat = parseAmountField(item.vatAmount ?? item.taxAmount ?? item.kdvTutari);
    const rawGross = parseAmountField(item.grossAmount ?? item.taxInclusiveAmount);
    const rawWithholding = parseAmountField(item.withholdingAmount ?? item.tevkifatTutari) ?? 0;
    const rawPayable = parseAmountField(item.payableAmount ?? item.odenecekTutar);

    let netAmount: number;
    let vatAmount: number;
    let grossAmount: number;

    if (rawNet !== null && rawVat !== null) {
      netAmount = rawNet;
      vatAmount = rawVat;
      grossAmount = money(decimal(rawNet).plus(rawVat));
    } else if (rawGross !== null && rawVat !== null) {
      grossAmount = rawGross;
      vatAmount = rawVat;
      netAmount = money(decimal(rawGross).minus(rawVat));
    } else {
      const baseTotal = rawGross ?? rawPayable;
      if (baseTotal === null) continue;
      grossAmount = baseTotal;
      vatAmount = 0;
      netAmount = baseTotal;
    }

    const payableAmount =
      rawPayable ?? money(decimal(grossAmount).minus(rawWithholding));

    const jsonCanon = JSON.stringify(item);
    const dirRaw = typeof item.direction === "string" ? item.direction.toLowerCase() : "";
    const directionHint: "purchase" | "sales" | null =
      dirRaw === "sales" || dirRaw === "outbound" || dirRaw === "giden"
        ? "sales"
        : dirRaw === "purchase" || dirRaw === "inbound" || dirRaw === "gelen"
          ? "purchase"
          : null;

    out.push({
      ublUuid,
      invoiceNo,
      profileId: typeof item.profileId === "string" ? item.profileId : "TICARIFATURA",
      invoiceTypeCode: typeof item.invoiceTypeCode === "string" ? item.invoiceTypeCode : "SATIS",
      directionHint,
      issueDate,
      dueDate,
      currency,
      supplierName,
      supplierVkn,
      customerName,
      customerVkn,
      netAmount,
      vatAmount,
      discountTotal: parseAmountField(item.discountAmount ?? item.iskontoTutari) ?? 0,
      withholdingAmount: rawWithholding,
      payableAmount,
      grossAmount,
      lines: [],
      rawSource: jsonCanon,
      payloadSha256: createHash("sha256").update(jsonCanon, "utf8").digest("hex"),
      rawEnvelope: item,
    });
  }

  return out;
}

async function resolveOrCreateEInvoiceSyncRun(
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
        where integration_kind = 'einvoice' and lower(coalesce(provider, '')) = lower($1)
        order by created_at desc limit 1`,
      [provider],
    );
    connectionId = existing.rows[0]?.id ?? null;
  }
  if (!connectionId) {
    const created = await pool.query<{ id: string }>(
      `insert into public.integration_connections
         (integration_kind, name, provider, status, config)
       values ('einvoice', $1, $2, 'enabled', '{}'::jsonb)
       on conflict (integration_kind, name) do update set provider = excluded.provider
       returning id::text`,
      [`e-Fatura Özel Entegratör (${provider})`, provider],
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

async function recordInvoiceRawPayload(
  client: PoolClient,
  syncRunId: string,
  inv: NormalizedIntegratorInvoice,
): Promise<string | null> {
  const jsonStr = JSON.stringify(inv.rawEnvelope);
  const ins = await client.query<{ id: string }>(
    `insert into public.integration_raw_payloads
       (sync_run_id, resource_type, external_id, payload_sha256, payload_json)
     values ($1::uuid, 'einvoice_document', $2, $3, $4::jsonb)
     on conflict (resource_type, external_id, payload_sha256) do nothing
     returning id::text`,
    [syncRunId, inv.ublUuid, inv.payloadSha256, jsonStr],
  );
  if (ins.rows[0]?.id) return ins.rows[0].id;
  const existing = await client.query<{ id: string }>(
    `select id::text
       from public.integration_raw_payloads
      where resource_type = 'einvoice_document' and external_id = $1 and payload_sha256 = $2
      limit 1`,
    [inv.ublUuid, inv.payloadSha256],
  );
  return existing.rows[0]?.id ?? null;
}

/**
 * Resolves counterparty in `public.parties` WITHOUT ever auto-creating a party (S-10 Shield).
 * Unknown VKN / counterparties are staged in `public.integration_staged_parties` (`status = 'pending'`).
 */
async function resolveOrStageCounterparty(
  client: PoolClient,
  provider: string,
  counterpartyName: string,
  counterpartyVkn: string | null,
  direction: "purchase" | "sales",
  fallbackId: string,
): Promise<{ partyId: string | null; staged: boolean }> {
  const extContactId =
    counterpartyVkn || normalizeTr(counterpartyName).slice(0, 80) || fallbackId;

  // 1. Check previously operator-resolved staged contact
  const resolvedStaged = await client.query<{ resolved_party_id: string }>(
    `select resolved_party_id::text
       from public.integration_staged_parties
      where provider = $1
        and external_contact_id = $2
        and resolved_party_id is not null
        and status in ('linked', 'created')
      limit 1`,
    [provider, extContactId],
  );
  if (resolvedStaged.rows[0]?.resolved_party_id) {
    return { partyId: resolvedStaged.rows[0].resolved_party_id, staged: false };
  }

  // 2. Match by VKN / TCKN in counterparty_profiles
  if (counterpartyVkn) {
    const byVkn = await client.query<{ party_id: string }>(
      `select cp.party_id::text
         from public.counterparty_profiles cp
         join public.parties p on p.id = cp.party_id
        where regexp_replace(coalesce(cp.tax_number, ''), '\\D+', '', 'g') = $1
        limit 1`,
      [counterpartyVkn],
    );
    if (byVkn.rows[0]?.party_id) {
      return { partyId: byVkn.rows[0].party_id, staged: false };
    }

    // VKN explicitly supplied on official GİB invoice but unknown in MAS -> stage in integration_staged_parties!
    await client.query(
      `insert into public.integration_staged_parties
         (provider, external_contact_id, raw_name, tax_id, account_type, status)
       values ($1, $2, $3, $4, $5, 'pending')
       on conflict (provider, external_contact_id) do nothing`,
      [
        provider,
        extContactId,
        counterpartyName,
        counterpartyVkn,
        direction === "purchase" ? "vendor" : "customer",
      ],
    );
    return { partyId: null, staged: true };
  }

  // 3. No VKN supplied: match by TR-normalized party name
  if (counterpartyName) {
    const norm = normalizeTr(counterpartyName);
    const byName = await client.query<{ id: string }>(
      `select id::text from public.parties where normalized_name = $1 limit 1`,
      [norm],
    );
    if (byName.rows[0]?.id) {
      return { partyId: byName.rows[0].id, staged: false };
    }
  }

  await client.query(
    `insert into public.integration_staged_parties
       (provider, external_contact_id, raw_name, tax_id, account_type, status)
     values ($1, $2, $3, null, $4, 'pending')
     on conflict (provider, external_contact_id) do nothing`,
    [
      provider,
      extContactId,
      counterpartyName,
      direction === "purchase" ? "vendor" : "customer",
    ],
  );
  return { partyId: null, staged: true };
}

export interface FetchIntegratorInvoicesOptions {
  endpointUrl: string;
  credential?: string | null;
  credentialEnvVar?: string | null;
  extraHeaders?: Record<string, string>;
}

/**
 * Fetches and parses e-Invoices from a GİB Special Integrator endpoint over `HttpClient`.
 */
export async function fetchIntegratorEInvoices(
  options: FetchIntegratorInvoicesOptions,
  httpClient: HttpClient = defaultHttpClient,
): Promise<{
  rawBody: string;
  envelopeSha256: string;
  invoices: NormalizedIntegratorInvoice[];
}> {
  const token =
    options.credential ??
    (options.credentialEnvVar ? readCredential(options.credentialEnvVar) : null);
  if (!token) {
    throw new DomainError("VALIDATION", "Özel entegratör kimlik bilgisi tanımlı değil.");
  }
  const res = await httpClient.send({
    url: options.endpointUrl,
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, application/xml;q=0.9",
      ...(options.extraHeaders ?? {}),
    },
  });
  if (!res.ok) {
    throw new DomainError(
      res.status === 401 || res.status === 403 ? "FORBIDDEN" : "CONFLICT",
      res.error ?? `Özel entegratör HTTP ${res.status}`,
    );
  }
  return {
    rawBody: res.body,
    envelopeSha256: createHash("sha256").update(res.body, "utf8").digest("hex"),
    invoices: parseIntegratorEInvoicePayload(res.body, res.headers?.["content-type"] ?? null),
  };
}

export function integratorEInvoiceConnector(provider = "fitbulut"): IntegrationConnector {
  const normalizedProvider = provider.trim().toLowerCase() || "fitbulut";

  return {
    kind: "einvoice",
    provider: normalizedProvider,
    async authenticate(ctx: ConnectorContext) {
      const token =
        ctx.credential ??
        (typeof ctx.config.credentialEnvVar === "string"
          ? readCredential(ctx.config.credentialEnvVar)
          : null);
      if (!token) {
        return { ok: false, error: "Özel entegratör kimlik bilgisi tanımlı değil", permanent: true };
      }
      const base = typeof ctx.config.baseUrl === "string" ? ctx.config.baseUrl.replace(/\/$/, "") : null;
      if (!base) {
        return { ok: false, error: "baseUrl yapılandırılmamış", permanent: true };
      }
      const statusPath =
        typeof ctx.config.statusPath === "string" ? ctx.config.statusPath : "/status";
      const res = await ctx.http.send({
        url: `${base}${statusPath.startsWith("/") ? statusPath : `/${statusPath}`}`,
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
          error: "Özel entegratör yapılandırması (baseUrl / kimlik bilgisi) eksik",
          permanent: true,
        };
      }

      const sinceDays = typeof ctx.config.sinceDays === "number" ? ctx.config.sinceDays : 7;
      const sinceISO = new Date(Date.parse(`${ctx.asOfISO}T00:00:00Z`) - sinceDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const inboxPath =
        typeof ctx.config.inboxPath === "string" ? ctx.config.inboxPath : "/inbox";
      const sep = inboxPath.includes("?") ? "&" : "?";
      const endpointUrl = `${base}${inboxPath.startsWith("/") ? inboxPath : `/${inboxPath}`}${sep}from=${sinceISO}&to=${ctx.asOfISO}`;

      const res = await ctx.http.send({
        url: endpointUrl,
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, application/xml;q=0.9",
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

      let invoices: NormalizedIntegratorInvoice[];
      try {
        invoices = parseIntegratorEInvoicePayload(res.body, res.headers?.["content-type"] ?? null);
      } catch (e) {
        return {
          ok: false,
          imported: null,
          skipped: null,
          error: (e as Error).message,
          permanent: true,
        };
      }

      const ownTaxNumber = cleanTaxId(ctx.config.ownTaxNumber ?? ctx.config.ownVkn);
      const defaultDirection: "purchase" | "sales" =
        ctx.config.defaultDirection === "sales" ? "sales" : "purchase";

      const syncRunId = await resolveOrCreateEInvoiceSyncRun(
        pool,
        normalizedProvider,
        ctx.connectionId,
        `${sinceISO}T00:00:00Z`,
      );

      let imported = 0;
      let skipped = 0;
      let stagedParties = 0;

      const client = await pool.connect();
      try {
        await client.query("begin");

        for (const inv of invoices) {
          const payloadId = await recordInvoiceRawPayload(client, syncRunId, inv);

          let direction: "purchase" | "sales" = inv.directionHint ?? defaultDirection;
          if (ownTaxNumber && inv.supplierVkn === ownTaxNumber) {
            direction = "sales";
          } else if (ownTaxNumber && inv.customerVkn === ownTaxNumber) {
            direction = "purchase";
          }

          const counterpartyName = direction === "purchase" ? inv.supplierName : inv.customerName;
          const counterpartyVkn = direction === "purchase" ? inv.supplierVkn : inv.customerVkn;

          const existingByUuid = await client.query<{ id: string }>(
            `select id::text
               from public.invoices
              where ubl_uuid = $1 or external_key = $2
              limit 1`,
            [inv.ublUuid, `einvoice:${normalizedProvider}:${inv.ublUuid}`],
          );
          if ((existingByUuid.rowCount ?? 0) > 0) {
            skipped += 1;
            continue;
          }

          const partyRes = await resolveOrStageCounterparty(
            client,
            normalizedProvider,
            counterpartyName,
            counterpartyVkn,
            direction,
            inv.ublUuid,
          );
          if (!partyRes.partyId) {
            if (partyRes.staged) stagedParties += 1;
            skipped += 1;
            continue;
          }

          const externalKey = `einvoice:${normalizedProvider}:${inv.ublUuid}`;
          const dedupeHash = createHash("sha256")
            .update(
              `einvoice|${normalizedProvider}|${partyRes.partyId}|${inv.invoiceNo}|${inv.issueDate}|${inv.grossAmount.toFixed(2)}`,
            )
            .digest("hex");

          const insInv = await client.query<{ id: string }>(
            `insert into public.invoices
               (direction, invoice_no, party_id, issue_date, due_date, currency,
                net_amount, tax_amount, discount_total, income_tax_withholding_total,
                payable_amount, gross_amount, status, dedupe_hash, external_key, ubl_uuid, notes)
             values ($1, $2, $3::uuid, $4::date, $5::date, $6,
                     $7::numeric, $8::numeric, $9::numeric, $10::numeric,
                     $11::numeric, $12::numeric, 'open', $13, $14, $15, $16)
             on conflict (external_key) where external_key is not null do update
               set due_date = coalesce(excluded.due_date, public.invoices.due_date),
                   net_amount = excluded.net_amount,
                   tax_amount = excluded.tax_amount,
                   discount_total = excluded.discount_total,
                   income_tax_withholding_total = excluded.income_tax_withholding_total,
                   payable_amount = excluded.payable_amount,
                   gross_amount = excluded.gross_amount,
                   ubl_uuid = coalesce(public.invoices.ubl_uuid, excluded.ubl_uuid)
             returning id::text`,
            [
              direction,
              inv.invoiceNo,
              partyRes.partyId,
              inv.issueDate,
              inv.dueDate,
              inv.currency,
              inv.netAmount,
              inv.vatAmount,
              inv.discountTotal,
              inv.withholdingAmount,
              inv.payableAmount,
              inv.grossAmount,
              dedupeHash,
              externalKey,
              inv.ublUuid,
              `GİB Özel Entegratör (${normalizedProvider}) · ${inv.profileId}/${inv.invoiceTypeCode} · ETTN: ${inv.ublUuid}`,
            ],
          );

          if ((insInv.rowCount ?? 0) > 0 && insInv.rows[0]?.id) {
            const invoiceId = insInv.rows[0].id;
            imported += 1;

            if (inv.lines.length > 0) {
              await client.query(
                `delete from public.invoice_lines where invoice_id = $1::uuid`,
                [invoiceId],
              );
              for (const ln of inv.lines) {
                const lineGross = money(decimal(ln.lineNetAmount).plus(ln.vatAmount));
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
            }

            await client.query(
              `insert into public.integration_entity_links
                 (provider, resource_type, external_id, entity_table, entity_id, last_payload_id, last_synced_at)
               values ($1, 'einvoice_document', $2, 'invoices', $3::uuid, $4::uuid, now())
               on conflict (provider, resource_type, external_id) do update
                 set entity_id = excluded.entity_id,
                     last_payload_id = coalesce(excluded.last_payload_id, public.integration_entity_links.last_payload_id),
                     last_synced_at = now()`,
              [normalizedProvider, inv.ublUuid, invoiceId, payloadId],
            );

            await audit(client, {
              actor: actorId,
              action: "integrator_einvoice_upsert",
              entityTable: "invoices",
              entityId: invoiceId,
              after: {
                provider: normalizedProvider,
                invoiceNo: inv.invoiceNo,
                ublUuid: inv.ublUuid,
                direction,
                currency: inv.currency,
                grossAmount: inv.grossAmount,
                payableAmount: inv.payableAmount,
                lineCount: inv.lines.length,
              },
            });
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
                  upserted_count = $4,
                  staged_party_count = $5
            where id = $1::uuid`,
          [syncRunId, `${ctx.asOfISO}T23:59:59Z`, invoices.length, imported, stagedParties],
        );

        if ((updRun.rowCount ?? 0) > 0) {
          await audit(client, {
            actor: actorId,
            action: "integrator_einvoice_sync",
            entityTable: "integration_sync_runs",
            entityId: syncRunId,
            after: {
              provider: normalizedProvider,
              since: sinceISO,
              to: ctx.asOfISO,
              fetchedCount: invoices.length,
              imported,
              skipped,
              stagedParties,
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
        stagedParties,
        syncRunId,
      };
    },
  };
}
