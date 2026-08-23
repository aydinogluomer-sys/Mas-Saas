// Faz 37 — the four connectors.
//
// Each one is INDEPENDENTLY deliverable: nothing here imports another connector, and
// phase37:verify gates the four separately so a gap in one cannot block the other three (the
// plan's own requirement).
//
// None of them has been run against a live endpoint. This environment has no outbound network;
// the request-construction logic is real and is verified by asserting what each connector WOULD
// send, through mockHttpClient. That is the honest limit of what can be proven from here.

import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { moneyOrNull } from "@/lib/money";
import { importRates } from "@/lib/fx/engine";
import { providerFor } from "@/lib/fx/provider";
import { parseTcmbXml } from "@/lib/fx/rules";
import type {
  ConnectorContext, HttpClient, IntegrationConnector, SyncOutcome,
} from "./types";

/* ═══ 1. TCMB exchange rates ════════════════════════════════════════════════════════════ */
//
// The parsing was NOT written here. Faz 27 already shipped `parseTcmbXml`, `tcmbProvider` and
// `importRates`, with tests against the real bulletin schema — including the awkward parts
// (comma decimals, the Unit multiplier for JPY, the bulletin carrying its own date). Rebuilding
// any of that would have produced a second parser to keep in step with the first.
//
// What Faz 37 adds is the scheduled half the plan asked for: the same reader, driven by the job
// queue on an interval, instead of a person clicking import.

export function tcmbConnector(): IntegrationConnector {
  return {
    kind: "fx_rate",
    provider: "TCMB",
    async authenticate() {
      // The daily bulletin is public: no credential, so nothing can be wrong with one.
      return { ok: true };
    },
    async sync(ctx: ConnectorContext, pool: Pool, actorId: string | null): Promise<SyncOutcome> {
      const url = typeof ctx.config.baseUrl === "string" ? ctx.config.baseUrl : undefined;
      const currencies = Array.isArray(ctx.config.currencies)
        ? (ctx.config.currencies as string[]) : undefined;
      // providerFor() is Faz 27's single wiring point, reused so a new source cannot be half-wired.
      const provider = providerFor("tcmb", url);
      const result = await importRates(pool, provider, ctx.asOfISO, actorId ?? "", currencies);
      return {
        ok: result.ok,
        imported: result.ok ? result.inserted : null,
        skipped: result.ok ? result.skipped : null,
        error: result.error,
        // A weekend/holiday bulletin is empty. That is not a bug and must not dead-letter: the
        // next scheduled run on a business day will succeed.
        permanent: false,
      };
    },
  };
}

/**
 * Parse a TCMB bulletin from an already-fetched body.
 *
 * Exposed so the gate can prove the schema handling end-to-end through mockHttpClient without
 * touching the network, and without duplicating Faz 27's parser.
 */
export function parseTcmbBody(xml: string) {
  return parseTcmbXml(xml);
}

/* ═══ 2. Bank API ═══════════════════════════════════════════════════════════════════════ */
//
// The live extension of Faz 20's statement import. Turkish banks do not share one API, so the
// shape below is the common denominator every one of them offers: a dated transaction list per
// account. `provider` names which bank a connection is for; the request construction is real and
// unverified against any live service.

export interface BankTransactionPayload {
  externalId: string;
  date: string;
  amount: number | null;
  description: string | null;
  counterparty: string | null;
  currency: string;
}

/**
 * Narrow an untrusted JSON field to something money.ts will accept.
 *
 * moneyOrNull deliberately takes `string | number | Decimal | null` and NOT `unknown`, so casting
 * would have defeated the point: a bank could send `amount: { value: 5 }` or `amount: true`, and
 * an unchecked cast would turn either into a number nobody chose. Anything that is not a plain
 * numeric string or number becomes null — unknown, which is not zero.
 */
function numericOrNull(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return value;
  return null;
}

/** Map a bank's JSON to the shape Faz 20's importer already understands. */
export function mapBankPayload(raw: unknown): BankTransactionPayload[] {
  if (!raw || typeof raw !== "object") return [];
  const list = Array.isArray((raw as { transactions?: unknown }).transactions)
    ? (raw as { transactions: unknown[] }).transactions : [];
  const out: BankTransactionPayload[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : typeof r.reference === "string" ? r.reference : null;
    const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.date)
      ? r.date.slice(0, 10) : null;
    // A transaction with no id or no date cannot be deduplicated or placed in time, so it is
    // DROPPED rather than imported with a guess. Faz 20's dedupe_hash depends on both.
    if (!id || !date) continue;
    out.push({
      externalId: id,
      date,
      // Unknown amount stays null — never 0. A statement line whose amount did not parse is not
      // a zero-lira movement.
      amount: moneyOrNull(numericOrNull(r.amount)),
      description: typeof r.description === "string" ? r.description : null,
      counterparty: typeof r.counterparty === "string" ? r.counterparty : null,
      currency: typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency) ? r.currency : "TRY",
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
        // Permanent: retrying a rejected credential five times just delays every other job.
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
        .toISOString().slice(0, 10);
      const res = await ctx.http.send({
        url: `${base.replace(/\/$/, "")}/transactions?from=${since}&to=${ctx.asOfISO}`,
        headers: { authorization: `Bearer ${ctx.credential}`, accept: "application/json" },
      });
      if (!res.ok) {
        return {
          ok: false, imported: null, skipped: null,
          error: res.error ?? `HTTP ${res.status}`,
          permanent: res.status === 401 || res.status === 403,
        };
      }
      let payload: unknown;
      try { payload = JSON.parse(res.body); }
      catch { return { ok: false, imported: null, skipped: null, error: "Geçersiz JSON", permanent: true }; }

      const rows = mapBankPayload(payload);
      // Written through bank_transactions with the SAME dedupe_hash discipline Faz 20 uses, so a
      // re-run imports nothing twice. Nothing here re-implements matching or categorisation —
      // those already exist and stay where they are.
      let imported = 0, skipped = 0;
      const client = await pool.connect();
      try {
        await client.query("begin");
        const acct = await client.query(`select cash_account_id from public.bank_accounts limit 1`);
        const accountId = acct.rows[0]?.cash_account_id as string | undefined;
        if (!accountId) {
          await client.query("rollback");
          return {
            ok: false, imported: null, skipped: null,
            error: "Tanımlı banka hesabı yok — önce hesap tanımlanmalı", permanent: true,
          };
        }
        for (const row of rows) {
          // `bank_transactions.amount` is NOT NULL (0042), and this row's amount could not be
          // parsed. Both available answers are wrong except one: inserting 0 would fabricate a
          // zero-lira movement that never happened, and inserting null crashes the sync (which is
          // how the gate found this). So it is SKIPPED and counted — the operator can see that a
          // line was offered and refused, and chase the bank for it.
          if (row.amount == null) { skipped++; continue; }
          const hash = `api:${provider}:${row.externalId}`;
          const ins = await client.query(
            `insert into public.bank_transactions
               (bank_account_id, txn_date, amount, currency, description,
                counterparty_name_raw, status, dedupe_hash)
             values ($1,$2::date,$3,$4,$5,$6,'unmatched',$7)
             on conflict do nothing returning id`,
            [accountId, row.date, row.amount, row.currency, row.description,
             row.counterparty, hash]);
          if (ins.rowCount) imported++; else skipped++;
        }
        await audit(client, {
          actor: actorId, action: "bank_api_sync",
          entityTable: "bank_transactions", entityId: null,
          after: { provider, since, to: ctx.asOfISO, imported, skipped, offered: rows.length,
                   liveTested: false },
        });
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        return { ok: false, imported: null, skipped: null, error: (e as Error).message };
      } finally { client.release(); }

      return { ok: true, imported, skipped };
    },
  };
}

/* ═══ 3. e-Fatura / e-Arşiv ═════════════════════════════════════════════════════════════ */
//
// Bound to Faz 21's `invoices` entity. Incoming e-invoices become `direction='purchase'` rows;
// nothing here invents an outgoing-invoice submission flow, because submitting a legal e-invoice
// has consequences this codebase must not trigger on a schedule.

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
    ? (raw as { invoices: unknown[] }).invoices : [];
  const out: EInvoicePayload[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const uuid = typeof r.uuid === "string" ? r.uuid : null;
    const invoiceNo = typeof r.invoiceNumber === "string" ? r.invoiceNumber : null;
    const issueDate = typeof r.issueDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.issueDate)
      ? r.issueDate.slice(0, 10) : null;
    // Same rule as the bank mapper: no identity or no date means it cannot be filed safely.
    if (!uuid || !invoiceNo || !issueDate) continue;
    out.push({
      uuid, invoiceNo, issueDate,
      supplierName: typeof r.supplierName === "string" ? r.supplierName : "(bilinmeyen tedarikçi)",
      grossAmount: moneyOrNull(numericOrNull(r.payableAmount ?? r.grossAmount)),
      currency: typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency) ? r.currency : "TRY",
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
          ok: false, imported: null, skipped: null, error: res.error ?? `HTTP ${res.status}`,
          permanent: res.status === 401 || res.status === 403,
        };
      }
      let payload: unknown;
      try { payload = JSON.parse(res.body); }
      catch { return { ok: false, imported: null, skipped: null, error: "Geçersiz JSON", permanent: true }; }

      const rows = mapEInvoicePayload(payload);
      let imported = 0, skipped = 0, unknownSupplier = 0;
      const client = await pool.connect();
      try {
        await client.query("begin");
        for (const row of rows) {
          // An e-invoice with no amount is NOT imported as zero: Faz 21 requires gross = net + tax
          // and a null gross would either violate that or fabricate a figure. It is skipped and
          // counted, so the operator can chase it.
          if (row.grossAmount == null) { skipped++; continue; }
          // LOOK UP the supplier; never create one.
          //
          // Faz 19 made counterparty creation an explicit operator action in exactly one module
          // (counterparties/engine.ts), and its gate enforces that no other file writes to
          // `parties`. The rule is right, and this connector is precisely the reason it exists: an
          // e-invoice feed that auto-created parties from supplier-name strings would fill the
          // counterparty list with duplicates from typos and legal-name variants, and nobody would
          // trust it again.
          //
          // So an invoice from an unknown supplier is SKIPPED and counted. `invoices.party_id` is
          // NOT NULL, so there is no half-import to offer, and a human deciding who a new supplier
          // is remains the correct workflow (Faz 24A already has a 'new_counterparty' approval).
          const party = await client.query(
            `select id from public.parties
              where normalized_name = lower(btrim($1)) and party_type in ('vendor','company','customer')
              limit 1`, [row.supplierName]);
          if (party.rowCount === 0) { skipped++; unknownSupplier++; continue; }
          const ins = await client.query(
            `insert into public.invoices
               (direction, invoice_no, party_id, issue_date, currency,
                net_amount, tax_amount, gross_amount, status, dedupe_hash)
             values ('purchase',$1,$2,$3::date,$4,$5,0,$5,'open',$6)
             on conflict do nothing returning id`,
            [row.invoiceNo, party.rows[0].id, row.issueDate, row.currency,
             row.grossAmount, `efatura:${row.uuid}`]);
          if (ins.rowCount) imported++; else skipped++;
        }
        await audit(client, {
          actor: actorId, action: "einvoice_sync",
          entityTable: "invoices", entityId: null,
          after: { provider, date: ctx.asOfISO, imported, skipped, offered: rows.length,
                   // Surfaced separately: "skipped" alone would hide that the reason was a
                   // supplier nobody has created yet, which is an operator action, not a bug.
                   unknownSupplier, liveTested: false },
        });
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        return { ok: false, imported: null, skipped: null, error: (e as Error).message };
      } finally { client.release(); }

      return { ok: true, imported, skipped };
    },
  };
}

/* ═══ 4. Accounting software — INTERFACE ONLY ═══════════════════════════════════════════ */
//
// ═══ NO VENDOR HAS BEEN CHOSEN, AND THIS CODEBASE MUST NOT CHOOSE ONE ═══
//
// The plan says one accounting vendor (Paraşüt / Logo / Mikro / Luca) and says the choice is made
// "when the phase starts". That choice cannot be derived from this repository: it depends on which
// package the company already pays for, what their accountant uses, and which contract they hold.
// No amount of reading the schema answers it, and guessing would produce a vendor-shaped
// integration nobody asked for — with a real risk of pushing ledger data into the wrong system.
//
// So this is a CONTRACT with no implementation. `syncNotConfigured` is a real connector that
// refuses cleanly and permanently, which is the correct behaviour for "not decided yet": the job
// dead-letters immediately with a readable reason instead of retrying a stub five times.
//
// docs/status-notes.md records this as awaiting the owner's decision. The other three
// integrations do not depend on it — each is gated separately.

export const ACCOUNTING_VENDOR_CANDIDATES = ["parasut", "logo", "mikro", "luca"] as const;
export type AccountingVendorCandidate = (typeof ACCOUNTING_VENDOR_CANDIDATES)[number];

export const ACCOUNTING_PENDING_REASON =
  "Muhasebe yazılımı seçimi kullanıcı onayı bekliyor — vendor seçilmeden senkron çalıştırılmaz.";

export function accountingConnector(provider = "unselected"): IntegrationConnector {
  return {
    kind: "accounting",
    provider,
    async authenticate() {
      return { ok: false, error: ACCOUNTING_PENDING_REASON, permanent: true };
    },
    async sync(): Promise<SyncOutcome> {
      return {
        ok: false, imported: null, skipped: null,
        error: ACCOUNTING_PENDING_REASON,
        // Permanent on purpose: retrying an undecided business question is not going to resolve it.
        permanent: true,
      };
    },
  };
}

/* ── registry ───────────────────────────────────────────────────────────────────────────── */

export function connectorFor(kind: string, provider?: string): IntegrationConnector | null {
  switch (kind) {
    case "fx_rate": return tcmbConnector();
    case "bank_api": return bankApiConnector(provider ?? "generic");
    case "einvoice": return eInvoiceConnector(provider ?? "generic");
    case "accounting": return accountingConnector(provider ?? "unselected");
    default: return null;
  }
}

/** Exposed so the gate can assert no connector reaches the network except through ctx.http. */
export const NETWORK_SEAM: keyof ConnectorContext = "http";
export type { HttpClient };
