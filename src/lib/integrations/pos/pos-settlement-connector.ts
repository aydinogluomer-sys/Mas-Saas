// POS Settlement Batch Connector (`iyzico`, `PayTR`, Turkish Bank Merchant JSON & CSV) — 0117 Schema.
//
// Invariants:
//   - Network egress strictly via `HttpClient` (`ctx.http` / `defaultHttpClient`) from `@/lib/integrations/types`.
//   - Zero `fetch()`, zero `process.env`, zero floating-point casts; exact arithmetic via `@/lib/money`.
//   - Reconciliation invariant: verifies `gross - commission - bsmv == net`; flags any discrepancy
//     honestly in outcome & `audit()` trail WITHOUT mutating reported `gross`, `commission`, or `net`.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { normalizeParasutCurrency } from "@/lib/integrations/parasut/mappers";
import {
  defaultHttpClient,
  readCredential,
  type ConnectorContext,
  type HttpClient,
  type IntegrationConnector,
  type SyncOutcome,
} from "@/lib/integrations/types";
import { decimal, money, moneyOrNull, rate } from "@/lib/money";

export const POS_SETTLEMENT_PROVIDERS = [
  "iyzico",
  "iyzipay",
  "paytr",
  "pos_settlement",
  "bank_pos",
] as const;

export type PosSettlementProvider = (typeof POS_SETTLEMENT_PROVIDERS)[number];

export function isPosSettlementProvider(provider: string | undefined | null): boolean {
  if (!provider) return false;
  const norm = provider.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (POS_SETTLEMENT_PROVIDERS as readonly string[]).includes(norm);
}

export interface ParsedPosSettlementBatch {
  externalId: string;
  settlementDate: string;
  valueDate: string;
  grossAmount: number;
  commissionAmount: number;
  bsmvAmount: number;
  netAmount: number;
  expectedNetAmount: number;
  discrepancyAmount: number;
  hasDiscrepancy: boolean;
  commissionRate: number;
  currency: string;
  terminalOrProvider: string;
  payloadSha256: string;
  rawRow: Record<string, unknown>;
}

export interface PosSyncOutcome extends SyncOutcome {
  discrepancyCount?: number;
  discrepancies?: Array<{
    externalId: string;
    terminalOrProvider: string;
    settlementDate: string;
    grossAmount: number;
    commissionAmount: number;
    bsmvAmount: number;
    reportedNetAmount: number;
    expectedNetAmount: number;
    discrepancyAmount: number;
  }>;
}

function parseIsoOrTrDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const tr = s.match(/^(\d{2})[./-](\d{2})[./-](\d{4})/);
  if (tr) return `${tr[3]}-${tr[2]}-${tr[1]}`;
  return null;
}

function parsePosMoneyField(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? money(raw) : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (!trimmed) return null;

  let norm = trimmed;
  const lastComma = norm.lastIndexOf(",");
  const lastDot = norm.lastIndexOf(".");
  if (lastComma > lastDot) {
    norm = norm.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma && lastComma !== -1) {
    norm = norm.replace(/,/g, "");
  }
  return moneyOrNull(norm);
}

function buildNormalizedPosRow(
  raw: Record<string, unknown>,
  defaultProviderLabel: string,
  index: number,
): ParsedPosSettlementBatch | null {
  const settlementDate =
    parseIsoOrTrDate(raw.settlement_date) ??
    parseIsoOrTrDate(raw.settlementDate) ??
    parseIsoOrTrDate(raw.sale_date) ??
    parseIsoOrTrDate(raw.saleDate) ??
    parseIsoOrTrDate(raw.transactionDate) ??
    parseIsoOrTrDate(raw.satisTarihi) ??
    parseIsoOrTrDate(raw.satis_tarihi) ??
    parseIsoOrTrDate(raw.islemTarihi);

  const valueDate =
    parseIsoOrTrDate(raw.value_date) ??
    parseIsoOrTrDate(raw.valueDate) ??
    parseIsoOrTrDate(raw.expected_value_date) ??
    parseIsoOrTrDate(raw.payoutDate) ??
    parseIsoOrTrDate(raw.blockageResolvedDate) ??
    parseIsoOrTrDate(raw.valorTarihi) ??
    parseIsoOrTrDate(raw.valor_tarihi) ??
    parseIsoOrTrDate(raw.hesabaGecisTarihi) ??
    settlementDate;

  // BLANK != ZERO: required gross and net amounts must be explicitly present
  const grossAmount = parsePosMoneyField(
    raw.gross_amount ?? raw.grossAmount ?? raw.paidPrice ?? raw.brutTutar ?? raw.brut_tutar,
  );
  const netAmount = parsePosMoneyField(
    raw.net_amount ??
      raw.netAmount ??
      raw.net_settlement_amount ??
      raw.merchantPayoutAmount ??
      raw.netTutar ??
      raw.net_tutar,
  );

  if (!settlementDate || !valueDate || grossAmount === null || netAmount === null) {
    return null;
  }
  if (grossAmount < 0 || netAmount < 0) {
    throw new DomainError(
      "VALIDATION",
      "POS hakediş tutarları (gross_amount / net_amount) negatif olamaz.",
    );
  }

  const commissionAmount =
    parsePosMoneyField(
      raw.commission_amount ??
        raw.commissionAmount ??
        raw.iyziCommissionFee ??
        raw.merchantCommissionRateAmount ??
        raw.komisyonTutari ??
        raw.komisyon_tutari,
    ) ?? 0;

  const bsmvAmount =
    parsePosMoneyField(
      raw.bsmv_amount ?? raw.bsmvAmount ?? raw.taxAmount ?? raw.bsmvTutari ?? raw.bsmv_tutari,
    ) ?? 0;

  if (commissionAmount < 0 || bsmvAmount < 0) {
    throw new DomainError(
      "VALIDATION",
      "POS komisyon veya BSMV tutarları negatif olamaz.",
    );
  }

  // Exact @/lib/money reconciliation check: expectedNet = gross - commission - bsmv (NEVER mutate net!)
  const expectedNetDec = decimal(grossAmount).minus(commissionAmount).minus(bsmvAmount);
  const expectedNetAmount = money(expectedNetDec);
  const discrepancyDec = decimal(netAmount).minus(expectedNetDec);
  const discrepancyAmount = money(discrepancyDec);
  const hasDiscrepancy = !discrepancyDec.eq(0);

  const rawRateDec =
    grossAmount > 0 ? decimal(commissionAmount).div(grossAmount) : decimal(0);
  const clampedRateDec = rawRateDec.lt(0)
    ? decimal(0)
    : rawRateDec.gt(1)
      ? decimal(1)
      : rawRateDec;
  const commissionRate = rate(clampedRateDec.round(4));

  const currency = normalizeParasutCurrency(raw.currency ?? raw.para_birimi ?? raw.paraBirimi ?? "TRY");
  const terminalOrProvider =
    (typeof raw.terminal_or_provider === "string" && raw.terminal_or_provider.trim()) ||
    (typeof raw.terminalOrProvider === "string" && raw.terminalOrProvider.trim()) ||
    (typeof raw.pos_terminal_label === "string" && raw.pos_terminal_label.trim()) ||
    (typeof raw.posTerminalLabel === "string" && raw.posTerminalLabel.trim()) ||
    (typeof raw.terminalId === "string" && raw.terminalId.trim()) ||
    (typeof raw.provider === "string" && raw.provider.trim()) ||
    defaultProviderLabel;

  const explicitId =
    (typeof raw.id === "string" && raw.id.trim()) ||
    (typeof raw.batchId === "string" && raw.batchId.trim()) ||
    (typeof raw.paymentTransactionId === "string" && raw.paymentTransactionId.trim()) ||
    (typeof raw.reference === "string" && raw.reference.trim()) ||
    null;

  const canonicalRowJson = JSON.stringify(raw);
  const payloadSha256 = createHash("sha256").update(canonicalRowJson, "utf8").digest("hex");
  const externalId =
    explicitId ??
    createHash("sha256")
      .update(
        `${terminalOrProvider}|${settlementDate}|${valueDate}|${grossAmount.toFixed(2)}|${netAmount.toFixed(2)}|${currency}|${index}`,
      )
      .digest("hex")
      .slice(0, 32);

  return {
    externalId,
    settlementDate,
    valueDate,
    grossAmount,
    commissionAmount,
    bsmvAmount,
    netAmount,
    expectedNetAmount,
    discrepancyAmount,
    hasDiscrepancy,
    commissionRate,
    currency,
    terminalOrProvider,
    payloadSha256,
    rawRow: raw,
  };
}

function splitCsvLine(line: string, delimiter: "," | ";"): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parsePosCsv(csvText: string, defaultProviderLabel: string): ParsedPosSettlementBatch[] {
  const lines = csvText
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headerLine = lines[0];
  const semicolonCount = (headerLine.match(/;/g) ?? []).length;
  const commaCount = (headerLine.match(/,/g) ?? []).length;
  const delimiter: "," | ";" = semicolonCount > commaCount ? ";" : ",";

  const headers = splitCsvLine(headerLine, delimiter).map((h) =>
    h
      .toLowerCase()
      .replace(/[\s-]+/g, "_")
      .replace(/ı/g, "i")
      .replace(/ş/g, "s")
      .replace(/ğ/g, "g")
      .replace(/ü/g, "u")
      .replace(/ö/g, "o")
      .replace(/ç/g, "c"),
  );

  const out: ParsedPosSettlementBatch[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delimiter);
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = cols[c] ?? "";
    }
    const parsed = buildNormalizedPosRow(obj, defaultProviderLabel, i - 1);
    if (parsed) out.push(parsed);
  }
  return out;
}

function extractPosJsonList(root: unknown): unknown[] {
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== "object") return [];
  const obj = root as Record<string, unknown>;
  if (Array.isArray(obj.settlements)) return obj.settlements;
  if (Array.isArray(obj.batches)) return obj.batches;
  if (Array.isArray(obj.payoutCompletedTransactionList)) {
    return obj.payoutCompletedTransactionList;
  }
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  if (obj.data && typeof obj.data === "object") {
    const d = obj.data as Record<string, unknown>;
    if (Array.isArray(d.settlements)) return d.settlements;
    if (Array.isArray(d.batches)) return d.batches;
    if (Array.isArray(d.items)) return d.items;
  }
  return [];
}

/**
 * Parses POS settlement batch rows from JSON (`iyzico` / `PayTR` / Bank Merchant) or CSV text.
 */
export function parsePosSettlementPayload(
  body: string,
  defaultProviderLabel = "POS",
  contentType?: string | null,
): ParsedPosSettlementBatch[] {
  const trimmed = body.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return [];

  const isJsonCandidate =
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    (typeof contentType === "string" && /json/i.test(contentType));

  if (isJsonCandidate) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new DomainError("VALIDATION", "POS hakediş yanıtı geçerli bir JSON değil.");
    }
    const items = extractPosJsonList(parsed);
    const out: ParsedPosSettlementBatch[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i];
      if (!entry || typeof entry !== "object") continue;
      const row = buildNormalizedPosRow(entry as Record<string, unknown>, defaultProviderLabel, i);
      if (row) out.push(row);
    }
    return out;
  }

  return parsePosCsv(trimmed, defaultProviderLabel);
}

async function resolvePosCashAccountId(
  client: PoolClient,
  provider: string,
  configuredCashAccountId: string | null,
): Promise<string | null> {
  if (configuredCashAccountId) return configuredCashAccountId;

  const mapped = await client.query<{ cash_account_id: string | null; bank_account_id: string | null }>(
    `select cash_account_id::text, bank_account_id::text
       from public.integration_account_mappings
      where provider = $1
        and (cash_account_id is not null or bank_account_id is not null)
      order by updated_at desc limit 1`,
    [provider],
  );
  const mappedId = mapped.rows[0]?.cash_account_id ?? mapped.rows[0]?.bank_account_id ?? null;
  if (mappedId) return mappedId;

  const fallbackAcct = await client.query<{ id: string }>(
    `select id::text
       from public.cash_accounts
      where is_active = true
      order by case when account_type = 'bank' then 0 else 1 end, created_at asc
      limit 1`,
  );
  return fallbackAcct.rows[0]?.id ?? null;
}

async function resolveOrCreatePosSyncRun(
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
      [`POS Hakediş (${provider})`, provider],
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

/**
 * Persists parsed POS settlement batches idempotently into `public.pos_settlement_batches` (`0117` schema)
 * with SHA-256 `integration_raw_payloads` lineage, reconciliation discrepancy reporting, and `audit()`.
 */
export async function persistPosSettlementBatches(
  pool: Pool,
  params: {
    provider: string;
    batches: ParsedPosSettlementBatch[];
    cashAccountId?: string | null;
    connectionId?: string;
    asOfISO: string;
    actorId: string | null;
  },
): Promise<PosSyncOutcome> {
  const normalizedProvider = params.provider.trim().toLowerCase() || "pos_settlement";
  const syncRunId = await resolveOrCreatePosSyncRun(
    pool,
    normalizedProvider,
    params.connectionId,
    `${params.asOfISO}T00:00:00Z`,
  );

  let imported = 0;
  let skipped = 0;
  const discrepancies: NonNullable<PosSyncOutcome["discrepancies"]> = [];

  const client = await pool.connect();
  try {
    await client.query("begin");

    const cashAccountId = await resolvePosCashAccountId(
      client,
      normalizedProvider,
      params.cashAccountId ?? null,
    );
    if (!cashAccountId) {
      await client.query("rollback");
      await pool
        .query(
          `update public.integration_sync_runs
              set finished_at = now(), status = 'failed', error_summary = $2
            where id = $1::uuid`,
          [syncRunId, "POS hakedişi için aktif kasa/banka hesabı bulunamadı"],
        )
        .catch(() => undefined);
      return {
        ok: false,
        imported: null,
        skipped: null,
        syncRunId,
        error: "POS hakedişi için tanımlı kasa/banka hesabı yok",
        permanent: true,
      };
    }

    for (const batch of params.batches) {
      if (batch.hasDiscrepancy) {
        discrepancies.push({
          externalId: batch.externalId,
          terminalOrProvider: batch.terminalOrProvider,
          settlementDate: batch.settlementDate,
          grossAmount: batch.grossAmount,
          commissionAmount: batch.commissionAmount,
          bsmvAmount: batch.bsmvAmount,
          reportedNetAmount: batch.netAmount,
          expectedNetAmount: batch.expectedNetAmount,
          discrepancyAmount: batch.discrepancyAmount,
        });
      }

      const rawIns = await client.query<{ id: string }>(
        `insert into public.integration_raw_payloads
           (sync_run_id, resource_type, external_id, payload_sha256, payload_json)
         values ($1::uuid, 'pos_settlement_batch', $2, $3, $4::jsonb)
         on conflict (resource_type, external_id, payload_sha256) do nothing
         returning id::text`,
        [syncRunId, batch.externalId, batch.payloadSha256, JSON.stringify(batch.rawRow)],
      );
      let payloadId = rawIns.rows[0]?.id ?? null;
      if (!payloadId) {
        const existingRaw = await client.query<{ id: string }>(
          `select id::text
             from public.integration_raw_payloads
            where resource_type = 'pos_settlement_batch'
              and external_id = $1
              and payload_sha256 = $2
            limit 1`,
          [batch.externalId, batch.payloadSha256],
        );
        payloadId = existingRaw.rows[0]?.id ?? null;
      }

      // Idempotency check via entity link or natural batch tuple
      const existingLink = await client.query<{ entity_id: string }>(
        `select entity_id::text
           from public.integration_entity_links
          where provider = $1
            and resource_type = 'pos_settlement_batch'
            and external_id = $2
          limit 1`,
        [normalizedProvider, batch.externalId],
      );
      if ((existingLink.rowCount ?? 0) > 0) {
        skipped += 1;
        continue;
      }

      const existingNatural = await client.query<{ id: string }>(
        `select id::text
           from public.pos_settlement_batches
          where cash_account_id = $1::uuid
            and pos_terminal_label = $2
            and sale_date = $3::date
            and expected_value_date = $4::date
            and gross_amount = $5::numeric
            and net_settlement_amount = $6::numeric
            and currency = $7
          limit 1`,
        [
          cashAccountId,
          batch.terminalOrProvider,
          batch.settlementDate,
          batch.valueDate,
          batch.grossAmount,
          batch.netAmount,
          batch.currency,
        ],
      );
      if ((existingNatural.rowCount ?? 0) > 0) {
        skipped += 1;
        continue;
      }

      // Insert into 0117 `public.pos_settlement_batches` WITHOUT mutating reported net_amount!
      const ins = await client.query<{ id: string }>(
        `insert into public.pos_settlement_batches
           (cash_account_id, pos_terminal_label, sale_date, expected_value_date,
            gross_amount, commission_rate, commission_amount, net_settlement_amount,
            currency, is_settled)
         values ($1::uuid, $2, $3::date, $4::date,
                 $5::numeric, $6::numeric, $7::numeric, $8::numeric,
                 $9, false)
         returning id::text`,
        [
          cashAccountId,
          batch.terminalOrProvider,
          batch.settlementDate,
          batch.valueDate,
          batch.grossAmount,
          batch.commissionRate,
          batch.commissionAmount,
          batch.netAmount,
          batch.currency,
        ],
      );

      if ((ins.rowCount ?? 0) === 1 && ins.rows[0]?.id) {
        const batchId = ins.rows[0].id;
        imported += 1;

        await client.query(
          `insert into public.integration_entity_links
             (provider, resource_type, external_id, entity_table, entity_id, last_payload_id, last_synced_at)
           values ($1, 'pos_settlement_batch', $2, 'pos_settlement_batches', $3::uuid, $4::uuid, now())
           on conflict (provider, resource_type, external_id) do update
             set entity_id = excluded.entity_id,
                 last_payload_id = coalesce(excluded.last_payload_id, public.integration_entity_links.last_payload_id),
                 last_synced_at = now()`,
          [normalizedProvider, batch.externalId, batchId, payloadId],
        );

        await audit(client, {
          actor: params.actorId,
          action: "pos_settlement_batch_insert",
          entityTable: "pos_settlement_batches",
          entityId: batchId,
          after: {
            provider: normalizedProvider,
            externalId: batch.externalId,
            posTerminalLabel: batch.terminalOrProvider,
            saleDate: batch.settlementDate,
            expectedValueDate: batch.valueDate,
            grossAmount: batch.grossAmount,
            commissionAmount: batch.commissionAmount,
            bsmvAmount: batch.bsmvAmount,
            netSettlementAmount: batch.netAmount,
            expectedNetAmount: batch.expectedNetAmount,
            discrepancyAmount: batch.discrepancyAmount,
            hasDiscrepancy: batch.hasDiscrepancy,
            currency: batch.currency,
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
              upserted_count = $4
        where id = $1::uuid`,
      [syncRunId, `${params.asOfISO}T23:59:59Z`, params.batches.length, imported],
    );

    if ((updRun.rowCount ?? 0) > 0) {
      await audit(client, {
        actor: params.actorId,
        action: "pos_settlement_sync",
        entityTable: "integration_sync_runs",
        entityId: syncRunId,
        after: {
          provider: normalizedProvider,
          asOfISO: params.asOfISO,
          fetchedCount: params.batches.length,
          imported,
          skipped,
          discrepancyCount: discrepancies.length,
          discrepancies,
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
    discrepancyCount: discrepancies.length,
    discrepancies,
  };
}

export function posSettlementConnector(provider = "iyzico"): IntegrationConnector {
  const normalizedProvider = provider.trim().toLowerCase() || "iyzico";

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
        return { ok: false, error: "POS entegrasyonu kimlik bilgisi tanımlı değil", permanent: true };
      }
      const base = typeof ctx.config.baseUrl === "string" ? ctx.config.baseUrl.replace(/\/$/, "") : null;
      if (!base) {
        return { ok: false, error: "baseUrl yapılandırılmamış", permanent: true };
      }
      const statusPath =
        typeof ctx.config.statusPath === "string" ? ctx.config.statusPath : "/settlements/status";
      const res = await ctx.http.send({
        url: `${base}${statusPath.startsWith("/") ? statusPath : `/${statusPath}`}`,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/csv;q=0.9",
        },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `POS kimlik doğrulama reddedildi (${res.status})`, permanent: true };
      }
      return res.ok ? { ok: true } : { ok: false, error: res.error ?? `HTTP ${res.status}` };
    },

    async sync(ctx: ConnectorContext, pool: Pool, actorId: string | null): Promise<PosSyncOutcome> {
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
          error: "POS yapılandırması (baseUrl / kimlik bilgisi) eksik",
          permanent: true,
        };
      }

      const sinceDays = typeof ctx.config.sinceDays === "number" ? ctx.config.sinceDays : 7;
      const sinceISO = new Date(Date.parse(`${ctx.asOfISO}T00:00:00Z`) - sinceDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const settlementsPath =
        typeof ctx.config.settlementsPath === "string"
          ? ctx.config.settlementsPath
          : "/settlements";
      const sep = settlementsPath.includes("?") ? "&" : "?";
      const endpointUrl = `${base}${settlementsPath.startsWith("/") ? settlementsPath : `/${settlementsPath}`}${sep}from=${sinceISO}&to=${ctx.asOfISO}`;

      const res = await ctx.http.send({
        url: endpointUrl,
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/csv;q=0.9",
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

      let batches: ParsedPosSettlementBatch[];
      try {
        batches = parsePosSettlementPayload(
          res.body,
          normalizedProvider.toUpperCase(),
          res.headers?.["content-type"] ?? null,
        );
      } catch (e) {
        return {
          ok: false,
          imported: null,
          skipped: null,
          error: (e as Error).message,
          permanent: true,
        };
      }

      return persistPosSettlementBatches(pool, {
        provider: normalizedProvider,
        batches,
        cashAccountId:
          typeof ctx.config.cashAccountId === "string" ? ctx.config.cashAccountId : null,
        connectionId: ctx.connectionId,
        asOfISO: ctx.asOfISO,
        actorId,
      });
    },
  };
}

/**
 * Fetches POS settlement batches over `HttpClient` and syncs them into `public.pos_settlement_batches`.
 */
export async function fetchAndSyncPosSettlements(
  pool: Pool,
  options: {
    provider: string;
    endpointUrl: string;
    credential?: string | null;
    credentialEnvVar?: string | null;
    cashAccountId?: string | null;
    asOfISO: string;
    actorId: string | null;
  },
  httpClient: HttpClient = defaultHttpClient,
): Promise<PosSyncOutcome> {
  const token =
    options.credential ??
    (options.credentialEnvVar ? readCredential(options.credentialEnvVar) : null);
  if (!token) {
    throw new DomainError("VALIDATION", "POS entegrasyonu kimlik bilgisi tanımlı değil.");
  }
  const res = await httpClient.send({
    url: options.endpointUrl,
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/csv;q=0.9",
    },
  });
  if (!res.ok) {
    throw new DomainError(
      res.status === 401 || res.status === 403 ? "FORBIDDEN" : "CONFLICT",
      res.error ?? `POS entegrasyonu HTTP ${res.status}`,
    );
  }
  const batches = parsePosSettlementPayload(
    res.body,
    options.provider.toUpperCase(),
    res.headers?.["content-type"] ?? null,
  );
  return persistPosSettlementBatches(pool, {
    provider: options.provider,
    batches,
    cashAccountId: options.cashAccountId,
    asOfISO: options.asOfISO,
    actorId: options.actorId,
  });
}
