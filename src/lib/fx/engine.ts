// Faz 27 — FX engine: recording observed rates and reading the exposure.
//
// The one mutation is inserting rate snapshots, and it is an INSERT only — fx_rate_snapshots is
// append-only by trigger (0066), so this module could not update a rate even if it tried. That is
// the intended shape: a recorded rate is an observation, and observations are not edited.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { moneyOrNull, rateOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import type { RateProvider } from "./provider";
import { revalue, type FxRevaluation } from "./rules";

export const recordRateSchema = z.object({
  baseCurrency: z.string().trim().length(3).toUpperCase(),
  quoteCurrency: z.string().trim().length(3).toUpperCase().default("TRY"),
  rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Kur tarihi YYYY-AA-GG olmalı"),
  rate: z.number().positive("Kur sıfırdan büyük olmalı"),
  source: z.enum(["tcmb", "manual", "bank", "other"]).default("manual"),
  sourceRef: z.string().trim().max(300).optional(),
});

export interface RateImportResult {
  ok: boolean;
  rateDate: string | null;
  inserted: number;
  skipped: number;
  error?: string;
}

/**
 * Fetch rates from a provider and record them.
 *
 * A FAILED FETCH RECORDS NOTHING. It returns ok:false with the reason rather than writing a
 * partial or empty day — a half-imported bulletin would leave some pairs current and others
 * stale, and the revaluation built on top could not tell the difference.
 *
 * Re-running is safe: the unique (base, quote, date, source) constraint means a second import of
 * the same bulletin inserts nothing, and `skipped` reports how many were already present rather
 * than pretending they were new.
 */
export async function importRates(
  pool: Pool,
  provider: RateProvider,
  dateISO: string,
  actorId: string,
  onlyCurrencies?: string[],
): Promise<RateImportResult> {
  const fetched = await provider.fetchRates(dateISO);
  if (!fetched.ok || fetched.rateDate === null) {
    return { ok: false, rateDate: null, inserted: 0, skipped: 0, error: fetched.error };
  }

  const wanted = onlyCurrencies && onlyCurrencies.length > 0
    ? new Set(onlyCurrencies.map((c) => c.toUpperCase()))
    : null;

  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;
  try {
    await client.query("begin");
    for (const r of fetched.rates) {
      if (wanted && !wanted.has(r.baseCurrency)) continue;
      const res = await client.query(
        `insert into public.fx_rate_snapshots
           (base_currency, quote_currency, rate_date, rate, forex_buying, forex_selling,
            banknote_buying, banknote_selling, source, source_ref, created_by)
         values ($1,'TRY',$2::date,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (base_currency, quote_currency, rate_date, source) do nothing
         returning id`,
        [r.baseCurrency, fetched.rateDate, r.rate, r.forexBuying, r.forexSelling,
         r.banknoteBuying, r.banknoteSelling, provider.source,
         `unit=${r.unit}`, actorId]);
      if ((res.rowCount ?? 0) > 0) inserted += 1; else skipped += 1;
    }

    await audit(client, {
      actor: actorId, action: "import_fx_rates",
      entityTable: "fx_rate_snapshots", entityId: null,
      after: {
        source: provider.source, rateDate: fetched.rateDate,
        inserted, skipped,
        // Recorded explicitly: this reads a published bulletin, it does not open a live feed.
        liveFeed: false, automated: false,
      },
    });
    await client.query("commit");
    return { ok: true, rateDate: fetched.rateDate, inserted, skipped };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Record a single rate by hand — the manual half of the integration. */
export async function recordRate(pool: Pool, raw: unknown, actorId: string): Promise<string> {
  const input = parseOrThrow(recordRateSchema, raw, "Kur kaydı");
  if (input.baseCurrency === input.quoteCurrency) {
    throw new DomainError("Baz ve karşı para birimi aynı olamaz.");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      `insert into public.fx_rate_snapshots
         (base_currency, quote_currency, rate_date, rate, source, source_ref, created_by)
       values ($1,$2,$3::date,$4,$5,$6,$7)
       on conflict (base_currency, quote_currency, rate_date, source) do nothing
       returning id`,
      [input.baseCurrency, input.quoteCurrency, input.rateDate, input.rate,
       input.source, input.sourceRef ?? null, actorId]);
    if (res.rowCount === 0) {
      // The table is append-only, so "already recorded" cannot be resolved by overwriting. Saying
      // so is the honest answer; the operator can record a correction under a different source.
      throw new DomainError(
        "Bu tarih ve kaynak için kur zaten kayıtlı. Kur kayıtları salt-ekleme olduğu için " +
        "üzerine yazılamaz; düzeltme farklı bir kaynak olarak kaydedilmelidir.");
    }
    await audit(client, {
      actor: actorId, action: "record_fx_rate",
      entityTable: "fx_rate_snapshots", entityId: res.rows[0].id,
      after: {
        pair: `${input.baseCurrency}/${input.quoteCurrency}`, rateDate: input.rateDate,
        rate: input.rate, source: input.source, automated: false,
      },
    });
    await client.query("commit");
    return res.rows[0].id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── reads ────────────────────────────────────────────────────────────────────────────── */

export async function loadLatestRates(pool: Pool) {
  const r = await pool.query(
    `select base_currency, quote_currency, to_char(rate_date,'YYYY-MM-DD') as rate_date,
            rate, source
     from public.fx_latest_rates order by base_currency`);
  return r.rows.map((x) => ({
    baseCurrency: x.base_currency,
    quoteCurrency: x.quote_currency,
    rateDate: x.rate_date,
    rate: rateOrNull(x.rate),
    source: x.source,
  }));
}

export async function loadExposureSummary(pool: Pool) {
  const r = await pool.query(
    `select currency, position_count, net_amount_fx, net_value_try, net_unrealized_gain_loss,
            worst_case_20_delta, to_char(rate_date,'YYYY-MM-DD') as rate_date,
            positions_without_rate, positions_without_entry_rate
     from public.fx_exposure_summary order by currency`);
  return r.rows.map((x) => ({
    currency: x.currency,
    positionCount: Number(x.position_count),
    netAmountFx: moneyOrNull(x.net_amount_fx),
    netValueTry: moneyOrNull(x.net_value_try),
    netUnrealizedGainLoss: moneyOrNull(x.net_unrealized_gain_loss),
    worstCase20Delta: moneyOrNull(x.worst_case_20_delta),
    rateDate: x.rate_date,
    // Surfaced, never hidden: a summary resting on missing rates must say so.
    positionsWithoutRate: Number(x.positions_without_rate),
    positionsWithoutEntryRate: Number(x.positions_without_entry_rate),
  }));
}

/**
 * Positions revalued IN THE APPLICATION from the same raw figures the SQL view uses.
 *
 * Computed twice on purpose. `phase27:verify` runs both over identical fixtures and fails if they
 * disagree — the same two-independent-computations check Faz 26 used for the treasury
 * reconciliation, and the reason a rounding change in either layer cannot pass unnoticed.
 */
export async function loadRevaluations(pool: Pool): Promise<FxRevaluation[]> {
  const r = await pool.query(
    `select p.currency, p.amount, p.entry_rate, l.rate as current_rate
     from public.fx_positions p
     left join public.fx_latest_rates l
       on l.base_currency = p.currency and l.quote_currency = 'TRY'
     where p.is_active
     order by p.currency, p.id`);
  return r.rows.map((x) => revalue({
    currency: x.currency,
    amount: x.amount,
    entryRate: x.entry_rate,
    currentRate: x.current_rate,
  }));
}
