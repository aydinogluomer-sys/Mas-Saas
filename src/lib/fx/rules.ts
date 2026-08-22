// Faz 27 — FX rules. Pure, deterministic, decimal throughout.
//
// EVERY figure here goes through @/lib/money. That is not a style preference in this module: an
// unrealised gain is the difference between two nearly-equal large numbers (amount × rate_now
// minus amount × rate_entry), which is precisely the arithmetic where binary floating point
// destroys the answer. A 1.000.000 USD position revalued between two rates four decimals apart
// can land kuruş-wrong in float and be perfectly right in decimal, and the wrong number is the
// one that would appear in a report to the owner.
//
// There is no model here. The stress bands are the same position valued at a rate moved by a
// fixed percentage — reproducible with a calculator, which is the only kind of stress figure
// worth showing.

import { decimal, moneyOrNull, rateOrNull, type NumericInput } from "@/lib/money";

/** The stress bands the plan specifies. Percent moves, applied symmetrically. */
export const STRESS_BANDS = [5, 10, 20] as const;
export type StressBand = (typeof STRESS_BANDS)[number];

export interface FxPositionInput {
  currency: string;
  /** Signed FOREIGN-currency exposure: positive = asset, negative = liability. */
  amount: NumericInput;
  /** Rate at which the exposure entered the books. NULL = unknown. */
  entryRate: NumericInput;
  /** Latest observed rate. NULL = no rate recorded for this pair. */
  currentRate: NumericInput;
}

export interface FxRevaluation {
  currency: string;
  amountFx: number;
  bookValueTry: number | null;
  currentValueTry: number | null;
  /** NULL when either rate is unknown — never 0. */
  unrealizedGainLoss: number | null;
  /** The worst outcome of a ±20% move FOR THIS POSITION's direction. */
  worstCase20Delta: number | null;
}

/**
 * Revalue one position.
 *
 * A missing rate yields NULL, not zero, on every derived figure. Zero would assert "there is no
 * gain", which is a claim; NULL says "we cannot know", which is the truth when nobody recorded
 * the rate. Faz 26 made the same distinction for a month with no bank movement.
 */
export function revalue(input: FxPositionInput): FxRevaluation {
  const amount = moneyOrNull(input.amount) ?? 0;
  const entry = rateOrNull(input.entryRate);
  const current = rateOrNull(input.currentRate);

  const bookValueTry = entry === null ? null : round2(decimal(amount).times(decimal(entry)));
  const currentValueTry = current === null ? null : round2(decimal(amount).times(decimal(current)));
  const unrealizedGainLoss =
    entry === null || current === null
      ? null
      : round2(decimal(amount).times(decimal(current).minus(decimal(entry))));

  return {
    currency: input.currency,
    amountFx: amount,
    bookValueTry,
    currentValueTry,
    unrealizedGainLoss,
    worstCase20Delta: current === null ? null : worstCaseDelta(amount, current, 20),
  };
}

/**
 * Value of the position if the rate moves by `percent` (signed).
 *
 * Returns the VALUE, not the change — a caller wanting the delta subtracts the current value, and
 * making that explicit stops the two being confused in a table header.
 */
export function stressValue(
  amount: NumericInput, currentRate: NumericInput, percent: number,
): number | null {
  const amt = moneyOrNull(amount);
  const rate = rateOrNull(currentRate);
  if (amt === null || rate === null) return null;
  const factor = decimal(1).plus(decimal(percent).div(decimal(100)));
  return round2(decimal(amt).times(decimal(rate)).times(factor));
}

/**
 * The loss a move of `percent` in the ADVERSE direction produces.
 *
 * Direction depends on the sign of the position: a long position (asset) is hurt when the
 * currency falls, a short one (liability) when it rises. Reporting a single unsigned "±20%
 * impact" would tell a treasurer their largest liability was their largest cushion — which is the
 * mistake this function exists to make impossible.
 */
export function worstCaseDelta(
  amount: NumericInput, currentRate: NumericInput, percent: number,
): number | null {
  const amt = moneyOrNull(amount);
  const rate = rateOrNull(currentRate);
  if (amt === null || rate === null) return null;
  const adverse = amt >= 0 ? -Math.abs(percent) : Math.abs(percent);
  const factor = decimal(adverse).div(decimal(100));
  return round2(decimal(amt).times(decimal(rate)).times(factor));
}

/** Every band, both directions, for one position. */
export function stressTable(
  amount: NumericInput, currentRate: NumericInput,
): Array<{ band: StressBand; up: number | null; down: number | null }> {
  return STRESS_BANDS.map((band) => ({
    band,
    up: stressValue(amount, currentRate, band),
    down: stressValue(amount, currentRate, -band),
  }));
}

/**
 * Net exposure across positions in one currency.
 *
 * Positions in DIFFERENT currencies are never netted — the caller groups first. Adding a USD
 * exposure to a EUR one requires a cross rate, and inventing one silently is the failure Faz 26
 * refused for cash positions.
 */
export function netExposure(amounts: NumericInput[]): number {
  let total = decimal(0);
  for (const a of amounts) {
    const v = moneyOrNull(a);
    if (v !== null) total = total.plus(decimal(v));
  }
  return round2(total);
}

function round2(d: ReturnType<typeof decimal>): number {
  return Number(d.toFixed(2));
}

/* ── TCMB bulletin parsing ────────────────────────────────────────────────────────────── */

export interface TcmbRate {
  baseCurrency: string;
  rate: number;
  forexBuying: number | null;
  forexSelling: number | null;
  banknoteBuying: number | null;
  banknoteSelling: number | null;
  unit: number;
}

/**
 * Parse the TCMB daily bulletin XML.
 *
 * TWO SUBTLETIES THAT ARE EASY TO GET WRONG, and both would produce plausible wrong numbers:
 *
 *   1. `Unit`. TCMB quotes some currencies per 100 units (JPY historically). The published
 *      ForexSelling for such a currency is the price of 100, so the per-unit rate is that divided
 *      by Unit. Ignoring it overstates JPY exposure by a factor of a hundred.
 *   2. Empty elements. The bulletin ships `<ForexBuying/>` for currencies with no forex quote.
 *      Those must become NULL, not 0 — a zero rate would make a position worth nothing rather
 *      than unvalued.
 *
 * `rate` is the FOREX SELLING price per unit, because that is what it costs us to buy the
 * currency to settle a liability, and it is the figure Turkish corporate practice revalues at.
 * Falls back to forex buying, then banknote selling, and returns null if the bulletin quoted
 * nothing usable — never a guess.
 */
export function parseTcmbXml(xml: string): TcmbRate[] {
  const out: TcmbRate[] = [];
  const currencyBlocks = xml.match(/<Currency[\s\S]*?<\/Currency>/g) ?? [];

  for (const block of currencyBlocks) {
    const code = block.match(/CurrencyCode="([A-Z]{3})"/)?.[1];
    if (!code) continue;

    const unitRaw = tag(block, "Unit");
    const unit = unitRaw === null ? 1 : Number(unitRaw);
    if (!Number.isFinite(unit) || unit <= 0) continue;

    const perUnit = (value: string | null): number | null => {
      if (value === null) return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return null;
      return rateOrNull(decimal(n).div(decimal(unit)));
    };

    const forexSelling = perUnit(tag(block, "ForexSelling"));
    const forexBuying = perUnit(tag(block, "ForexBuying"));
    const banknoteSelling = perUnit(tag(block, "BanknoteSelling"));
    const banknoteBuying = perUnit(tag(block, "BanknoteBuying"));

    const rate = forexSelling ?? forexBuying ?? banknoteSelling;
    if (rate === null) continue; // nothing usable was published — skip, never guess

    out.push({
      baseCurrency: code,
      rate,
      forexBuying,
      forexSelling,
      banknoteBuying,
      banknoteSelling,
      unit,
    });
  }
  return out;
}

/** Inner text of an element, or null when absent/empty. */
function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  const v = m?.[1]?.trim();
  return v === undefined || v === "" ? null : v;
}
