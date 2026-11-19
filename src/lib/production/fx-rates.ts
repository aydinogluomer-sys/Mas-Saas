import type { Pool, PoolClient } from "pg";
import { decimal, money, rateOrNull } from "@/lib/money";

const round2 = money;
const numOrNull = rateOrNull;

export type Queryable = Pick<Pool | PoolClient, "query">;

export interface SpotRateEntry {
  currency: string;
  rate: number;
  rateDate: string | null;
}

export type SpotRateMap = Record<string, SpotRateEntry>;

export interface FxConversionResult {
  amountTry: number | null;
  fxRateUsed: number | null;
  rateDate: string | null;
  missingFxRate: boolean;
  currency: string;
}

export function normalizeCurrency(raw: string | null | undefined): string {
  const ccy = String(raw ?? "TRY").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(ccy) ? ccy : "TRY";
}

/**
 * Converts a monetary amount into TRY using TCMB spot rate snapshots (`quote_currency = 'TRY'`).
 * Never assumes 1:1 for foreign currencies and never substitutes 0 when an FX rate is missing.
 */
export function convertAmountToTry(
  amount: number | string | null | undefined,
  currencyRaw: string | null | undefined,
  spotRates: SpotRateMap,
): FxConversionResult {
  const currency = normalizeCurrency(currencyRaw);
  if (amount == null || amount === "") {
    return {
      amountTry: null,
      fxRateUsed: currency === "TRY" ? 1 : spotRates[currency]?.rate ?? null,
      rateDate: currency === "TRY" ? null : spotRates[currency]?.rateDate ?? null,
      missingFxRate: false,
      currency,
    };
  }

  const parsed = typeof amount === "number" ? (Number.isFinite(amount) ? amount : null) : numOrNull(amount);
  if (parsed == null) {
    return {
      amountTry: null,
      fxRateUsed: null,
      rateDate: null,
      missingFxRate: false,
      currency,
    };
  }

  if (currency === "TRY") {
    return {
      amountTry: round2(decimal(parsed)),
      fxRateUsed: 1,
      rateDate: null,
      missingFxRate: false,
      currency: "TRY",
    };
  }

  const entry = spotRates[currency];
  if (!entry || !(entry.rate > 0)) {
    return {
      amountTry: null,
      fxRateUsed: null,
      rateDate: null,
      missingFxRate: true,
      currency,
    };
  }

  return {
    amountTry: round2(decimal(parsed).times(decimal(entry.rate))),
    fxRateUsed: entry.rate,
    rateDate: entry.rateDate,
    missingFxRate: false,
    currency,
  };
}

/**
 * Converts a per-minute rate or unit price into TRY with 4-decimal precision when needed,
 * plus 2-decimal rounded TRY equivalent.
 */
export function convertRateToTry(
  rate: number | string | null | undefined,
  currencyRaw: string | null | undefined,
  spotRates: SpotRateMap,
): { rateTry: number | null; fxRateUsed: number | null; missingFxRate: boolean; currency: string } {
  const currency = normalizeCurrency(currencyRaw);
  if (rate == null || rate === "") {
    return {
      rateTry: null,
      fxRateUsed: currency === "TRY" ? 1 : spotRates[currency]?.rate ?? null,
      missingFxRate: false,
      currency,
    };
  }
  const parsed = typeof rate === "number" ? (Number.isFinite(rate) ? rate : null) : numOrNull(rate);
  if (parsed == null) {
    return { rateTry: null, fxRateUsed: null, missingFxRate: false, currency };
  }
  if (currency === "TRY") {
    return {
      rateTry: Number(decimal(parsed).round(4, 1).toFixed(4)),
      fxRateUsed: 1,
      missingFxRate: false,
      currency: "TRY",
    };
  }
  const entry = spotRates[currency];
  if (!entry || !(entry.rate > 0)) {
    return {
      rateTry: null,
      fxRateUsed: null,
      missingFxRate: true,
      currency,
    };
  }
  return {
    rateTry: Number(decimal(parsed).times(decimal(entry.rate)).round(4, 1).toFixed(4)),
    fxRateUsed: entry.rate,
    missingFxRate: false,
    currency,
  };
}

/**
 * Loads latest TCMB FX spot rates (`quote_currency = 'TRY'`) per currency.
 * Fails gracefully with `{}` if table does not exist in unit-test mocks.
 */
export async function loadLatestSpotRatesToTry(client: Queryable): Promise<SpotRateMap> {
  try {
    const res = await client.query<{
      base_currency: string;
      rate: string;
      rate_date: string | null;
    }>(
      `select distinct on (base_currency)
         base_currency,
         rate::text as rate,
         to_char(rate_date, 'YYYY-MM-DD') as rate_date
       from public.fx_rate_snapshots
       where quote_currency = 'TRY'
         and rate > 0
       order by base_currency, rate_date desc, fetched_at desc`,
    );
    const map: SpotRateMap = {
      TRY: { currency: "TRY", rate: 1, rateDate: null },
    };
    for (const row of res.rows ?? []) {
      const ccy = normalizeCurrency(row.base_currency);
      const r = numOrNull(row.rate);
      if (r != null && r > 0) {
        map[ccy] = {
          currency: ccy,
          rate: r,
          rateDate: row.rate_date ?? null,
        };
      }
    }
    return map;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "42P01" || code === "42703") {
      return { TRY: { currency: "TRY", rate: 1, rateDate: null } };
    }
    throw err;
  }
}
