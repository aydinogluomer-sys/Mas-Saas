// Faz 37 & Faz 51 (E1) — the four integration connectors (TCMB, Bank API, e-Fatura, Paraşüt API v4).
//
// Each one is INDEPENDENTLY deliverable and reaches the network ONLY via ConnectorContext.http.

import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { importRates } from "@/lib/fx/engine";
import { providerFor } from "@/lib/fx/provider";
import { parseTcmbXml } from "@/lib/fx/rules";
import { moneyOrNull } from "@/lib/money";
import {
  computeCrossChannelDedupeHash,
  normalizeParasutCurrency,
  parasutConnector,
} from "./parasut/mappers";
import type {
  ConnectorContext,
  HttpClient,
  IntegrationConnector,
  SyncOutcome,
} from "./types";

/* ═══ 1. TCMB exchange rates ════════════════════════════════════════════════════════════ */

export function tcmbConnector(): IntegrationConnector {
  return {
    kind: "fx_rate",
    provider: "TCMB",
    async authenticate() {
      return { ok: true };
    },
    async sync(ctx: ConnectorContext, pool: Pool, actorId: string | null): Promise<SyncOutcome> {
      const url = typeof ctx.config.baseUrl === "string" ? ctx.config.baseUrl : undefined;
      const currencies = Array.isArray(ctx.config.currencies)
        ? (ctx.config.currencies as string[])
        : undefined;
      const provider = providerFor("tcmb", url);
      const result = await importRates(pool, provider, ctx.asOfISO, actorId ?? "", currencies);
      return {
        ok: result.ok,
        imported: result.ok ? result.inserted : null,
        skipped: result.ok ? result.skipped : null,
        error: result.error,
        permanent: false,
      };
    },
  };
}

export function parseTcmbBody(xml: string) {
  return parseTcmbXml(xml);
}

/* ═══ 2. Bank API ═══════════════════════════════════════════════════════════════════════ */

export interface BankTransactionPayload {
  externalId: string;
  date: string;
  amount: number | null;
  description: string | null;
  counterparty: string | null;
  currency: string;
  externalAccountId?: string | null;
}

function numericOrNull(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return value;
  return null;
}

export function mapBankPayload(raw: unknown): BankTransactionPayload[] {
  if (!raw || typeof raw !== "object") return [];
  const list = Array.isArray((raw as { transactions?: unknown }).transactions)
    ? (raw as { transactions: unknown[] }).transactions
    : [];
  const out: BankTransactionPayload[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : typeof r.reference === "string" ? r.reference : null;
    const date =
      typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.date) ? r.date.slice(0, 10) : null;
    if (!id || !date) continue;
    out.push({
      externalId: id,
      date,
      amount: moneyOrNull(numericOrNull(r.amount)),
      description: typeof r.description === "string" ? r.description : null,
      counterparty: typeof r.counterparty === "string" ? r.counterparty : null,
      currency: normalizeParasutCurrency(r.currency),
      externalAccountId: typeof r.accountId === "string" ? r.accountId : null,
    });
  }
  return out;
}

export function bankApiConnector(provider = "generic"): IntegrationConnector {
  return {
    kind: "bank_api",
    provider,
    async authenticate(ctx: ConnectorContext) {
      if (!ctx.credential) {
        return { ok: false, error: "Kimlik bilgisi tanımlı değil", permanent: true };
      }
      const base = typeof ctx.config.baseUrl === "string" ? ctx.config.baseUrl : null;
      if (!base) return { ok: false, error: "baseUrl yapılandırılmamış", permanent: true };
      const res = await ctx.http.send({
        url: `${base.replace(/\/$/, "")}/accounts`,
        headers: { authorization: `Bearer ${ctx.credential}`, accept: "application/json" },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `Kimlik doğrulama reddedildi (${res.status})`, permanent: true };
      }
      return res.ok ? { ok: true } : { ok: false, error: res.error ?? `HTTP ${res.status}` };
    },
    async sync(ctx: ConnectorContext, pool: Pool, actorId: string | null): Promise<SyncOutcome> {
      const base = typeof ctx.config.baseUrl === "string" ? ctx.config.baseUrl : null;
      if (!base || !ctx.credential) {
        return { ok: false, imported: null, skipped: null, error: "Yapılandırma eksik", permanent: true };
      }
      const sinceDays = typeof ctx.config.sinceDays === "number" ? ctx.config.sinceDays : 7;
      const since = new Date(Date.parse(`${ctx.asOfISO}T00:00:00Z`) - sinceDays * 86400000)
        .toISOString()
        .slice(0, 10);
      const res = await ctx.http.send({
        url: `${base.replace(/\/$/, "")}/transactions?from=${since}&to=${ctx.asOfISO}`,
        headers: { authorization: `Bearer ${ctx.credential}`, accept: "application/json" },
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
      let payload: unknown;
      try {
        payload = JSON.parse(res.body);
      } catch {
        return { ok: false, imported: null, skipped: null, error: "Geçersiz JSON", permanent: true };
      }

      const rows = mapBankPayload(payload);
      let imported = 0;
      let skipped = 0;
      const client = await pool.connect();
      try {
        await client.query("begin");
        const mappedAcct = await client.query<{ bank_account_id: string }>(
          `select bank_account_id::text
             from public.integration_account_mappings
            where provider = $1 and bank_account_id is not null
            order by updated_at desc limit 1`,
          [provider],
        );
        const acct = mappedAcct.rows[0]?.bank_account_id
          ? { rows: [{ cash_account_id: mappedAcct.rows[0].bank_account_id }] }
          : await client.query(`select cash_account_id from public.bank_accounts order by created_at asc limit 1`);
        const accountId = acct.rows[0]?.cash_account_id as string | undefined;
        if (!accountId) {
          await client.query("rollback");
          return {
            ok: false,
            imported: null,
            skipped: null,
            error: "Tanımlı banka hesabı yok — önce hesap tanımlanmalı",
            permanent: true,
          };
        }
        for (const row of rows) {
          if (row.amount == null) {
            skipped++;
            continue;
          }
          const hash = `api:${provider}:${row.externalId}`;
          const crossHash = computeCrossChannelDedupeHash({
            bankAccountId: accountId,
            txnDate: row.date,
            amount: row.amount,
            currency: row.currency,
            reference: row.externalId,
          });
          const ins = await client.query(
            `insert into public.bank_transactions
               (bank_account_id, txn_date, amount, currency, description,
                counterparty_name_raw, status, dedupe_hash, cross_channel_dedupe_hash)
             values ($1,$2::date,$3,$4,$5,$6,'unmatched',$7,$8)
             on conflict do nothing returning id`,
            [
              accountId,
              row.date,
              row.amount,
              row.currency,
              row.description ?? "",
              row.counterparty,
              hash,
              crossHash,
            ],
          );
          if (ins.rowCount) imported++;
          else skipped++;
        }
        await audit(client, {
          actor: actorId,
          action: "bank_api_sync",
          entityTable: "bank_transactions",
          entityId: null,
          after: {
            provider,
            since,
            to: ctx.asOfISO,
            imported,
            skipped,
            offered: rows.length,
            liveTested: false,
          },
        });
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        return { ok: false, imported: null, skipped: null, error: (e as Error).message };
      } finally {
        client.release();
      }

      return { ok: true, imported, skipped };
    },
  };
}

/* ═══ 3. e-Fatura / e-Arşiv ═════════════════════════════════════════════════════════════ */

export interface EInvoicePayload {
  uuid: string;
  invoiceNo: string;
  issueDate: string;
  supplierName: string;
  grossAmount: number | null;
  currency: string;
}

export function mapEInvoicePayload(raw: unknown): EInvoicePayload[] {
  if (!raw || typeof raw !== "object") return [];
  const list = Array.isArray((raw as { invoices?: unknown }).invoices)
    ? (raw as { invoices: unknown[] }).invoices
    : [];
  const out: EInvoicePayload[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const uuid = typeof r.uuid === "string" ? r.uuid : null;
    const invoiceNo = typeof r.invoiceNumber === "string" ? r.invoiceNumber : null;
    const issueDate =
      typeof r.issueDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.issueDate)
        ? r.issueDate.slice(0, 10)
        : null;
    if (!uuid || !invoiceNo || !issueDate) continue;
    out.push({
      uuid,
      invoiceNo,
      issueDate,
      supplierName: typeof r.supplierName === "string" ? r.supplierName : "(bilinmeyen tedarikçi)",
      grossAmount: moneyOrNull(numericOrNull(r.payableAmount ?? r.grossAmount)),
      currency: normalizeParasutCurrency(r.currency),
    });
  }
  return out;
}

export function eInvoiceConnector(provider = "generic"): IntegrationConnector {
  return {
    kind: "einvoice",
    provider,
    async authenticate(ctx: ConnectorContext) {
      if (!ctx.credential) {
        return { ok: false, error: "Kimlik bilgisi tanımlı değil", permanent: true };
      }
      const base = typeof ctx.config.baseUrl === "string" ? ctx.config.baseUrl : null;
      if (!base) return { ok: false, error: "baseUrl yapılandırılmamış", permanent: true };
      const res = await ctx.http.send({
        url: `${base.replace(/\/$/, "")}/status`,
        headers: { authorization: `Bearer ${ctx.credential}`, accept: "application/json" },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `Kimlik doğrulama reddedildi (${res.status})`, permanent: true };
      }
      return res.ok ? { ok: true } : { ok: false, error: res.error ?? `HTTP ${res.status}` };
    },
    async sync(ctx: ConnectorContext, pool: Pool, actorId: string | null): Promise<SyncOutcome> {
      const base = typeof ctx.config.baseUrl === "string" ? ctx.config.baseUrl : null;
      if (!base || !ctx.credential) {
        return { ok: false, imported: null, skipped: null, error: "Yapılandırma eksik", permanent: true };
      }
      const res = await ctx.http.send({
        url: `${base.replace(/\/$/, "")}/inbox?date=${ctx.asOfISO}`,
        headers: { authorization: `Bearer ${ctx.credential}`, accept: "application/json" },
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
      let payload: unknown;
      try {
        payload = JSON.parse(res.body);
      } catch {
        return { ok: false, imported: null, skipped: null, error: "Geçersiz JSON", permanent: true };
      }

      const rows = mapEInvoicePayload(payload);
      let imported = 0;
      let skipped = 0;
      let unknownSupplier = 0;
      const client = await pool.connect();
      try {
        await client.query("begin");
        for (const row of rows) {
          if (row.grossAmount == null) {
            skipped++;
            continue;
          }
          const party = await client.query(
            `select id from public.parties
              where normalized_name = lower(btrim($1)) and party_type in ('vendor','company','customer')
              limit 1`,
            [row.supplierName],
          );
          if (party.rowCount === 0) {
            skipped++;
            unknownSupplier++;
            continue;
          }
          const extKey = `efatura:${row.uuid}`;
          const ins = await client.query(
            `insert into public.invoices
               (direction, invoice_no, party_id, issue_date, currency,
                net_amount, tax_amount, gross_amount, status, dedupe_hash, external_key)
             values ('purchase',$1,$2,$3::date,$4,$5,0,$5,'open',$6,$6)
             on conflict (external_key) where external_key is not null do nothing
             returning id`,
            [
              row.invoiceNo,
              party.rows[0].id,
              row.issueDate,
              row.currency,
              row.grossAmount,
              extKey,
            ],
          );
          if (ins.rowCount) imported++;
          else skipped++;
        }
        await audit(client, {
          actor: actorId,
          action: "einvoice_sync",
          entityTable: "invoices",
          entityId: null,
          after: {
            provider,
            date: ctx.asOfISO,
            imported,
            skipped,
            offered: rows.length,
            unknownSupplier,
            liveTested: false,
          },
        });
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        return { ok: false, imported: null, skipped: null, error: (e as Error).message };
      } finally {
        client.release();
      }

      return { ok: true, imported, skipped };
    },
  };
}

/* ═══ 4. Accounting software — Paraşüt API v4 (Read-Only) + unselected guard ════════════ */

export const ACCOUNTING_VENDOR_CANDIDATES = ["parasut", "logo", "mikro", "luca"] as const;
export type AccountingVendorCandidate = (typeof ACCOUNTING_VENDOR_CANDIDATES)[number];

export const ACCOUNTING_PENDING_REASON =
  "Muhasebe yazılımı seçimi kullanıcı onayı bekliyor — vendor seçilmeden senkron çalıştırılmaz.";

export function accountingConnector(provider = "unselected"): IntegrationConnector {
  if (provider.trim().toLowerCase() === "parasut") {
    return parasutConnector();
  }
  return {
    kind: "accounting",
    provider,
    async authenticate() {
      return { ok: false, error: ACCOUNTING_PENDING_REASON, permanent: true };
    },
    async sync(): Promise<SyncOutcome> {
      return {
        ok: false,
        imported: null,
        skipped: null,
        error: ACCOUNTING_PENDING_REASON,
        permanent: true,
      };
    },
  };
}

/* ── registry ───────────────────────────────────────────────────────────────────────────── */

export function connectorFor(kind: string, provider?: string): IntegrationConnector | null {
  switch (kind) {
    case "fx_rate":
      return tcmbConnector();
    case "bank_api":
      return bankApiConnector(provider ?? "generic");
    case "einvoice":
      return eInvoiceConnector(provider ?? "generic");
    case "accounting":
      return accountingConnector(provider ?? "unselected");
    default:
      return null;
  }
}

export const NETWORK_SEAM: keyof ConnectorContext = "http";
export type { HttpClient };
