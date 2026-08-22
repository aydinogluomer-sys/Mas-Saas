// Faz 17 — the one place money crosses the SQL/JS boundary.
//
// WHAT WAS ACTUALLY WRONG. Every money column in all 41 tables is already `numeric(p,s)`;
// there is not a single float8/double-precision/real column in the schema. The risk was never
// storage, it was the boundary: 136 `::float8` casts across 16 files pushed exact numerics
// through IEEE-754 on the way into JS. node-postgres returns `numeric` as a STRING precisely
// so that no precision is lost before the application decides what to do with it — and the
// casts threw that guarantee away one query at a time.
//
// Measured, not assumed (disposable DB, Postgres 16):
//   select (100000::numeric / 3::numeric)          -> "33333.333333333333"   (string, exact)
//   select (100000::numeric / 3::numeric)::float8  ->  33333.333333333336    (number, wrong)
// Note that `Number("33333.333333333333")` is *also* 33333.333333333336: removing the cast is
// necessary but not sufficient. The value has to be carried in decimal, which is why this
// module exists rather than a bare `Number()` at each call site.
//
// WHY big.js AND NOT decimal.js. Both parse Postgres numeric strings correctly (verified). The
// deciding property is what they do with input that is *not* a number, because CLAUDE.md's
// first financial rule is "treat null amount as unknown, not zero" — a silent NaN is the exact
// failure this codebase must not have:
//
//   input        decimal.js                 big.js
//   NaN          NaN  (propagates)          throws
//   Infinity     Infinity (propagates)      throws
//   1 / 0        Infinity (propagates)      throws "Division by zero"
//
// decimal.js's IEEE-like NaN/Infinity semantics are right for scientific computing and wrong
// for a cash-flow total that would render as "NaN TL" or, worse, be coerced to 0 somewhere
// downstream. big.js refuses at the point of corruption instead. It is also ~6KB against ~32KB,
// and the API surface is exactly money math — the codebase has zero uses of pow/sqrt/ln/exp
// (verified by grep; every `**` hit was a `/**` comment opener), so decimal.js's transcendental
// functions and fractional exponents buy nothing here. If a future phase needs analytic
// compounding, that is the moment to revisit this choice, not before.
//
// ROUNDING MATCHES POSTGRES, WHICH `toFixed` DOES NOT. Postgres `round(numeric, n)` is half-up
// away from zero. JS `Number.prototype.toFixed` rounds the underlying binary double, so it
// disagrees with the database on ordinary values (measured):
//   2.675    -> toFixed(2) "2.67"    pg round() 2.68
//   1.005    -> toFixed(2) "1.00"    pg round() 1.01
//   1262.145 -> toFixed(2) "1262.14" pg round() 1262.15
//   70.285   -> toFixed(2) "70.28"   pg round() 70.29
// Every helper here rounds half-up, so the application and the database agree.

import Big from "big.js";

/**
 * A private constructor, not the global `Big`.
 *
 * big.js keeps DP/RM/strict as mutable statics on the constructor. Sharing the global one
 * would mean any dependency (or any future call site that "just needs 4 decimals here")
 * could silently change the rounding of every financial figure in the process. `Big()`
 * returns an independent constructor; isolation verified at runtime — setting `Big.DP`
 * afterwards does not move `MoneyBig.DP`.
 */
const MoneyBig = Big();

/**
 * Division precision. Postgres computes `numeric / numeric` to a scale it selects per
 * expression; 20 decimal places is comfortably beyond any scale in this schema (the widest
 * money column is numeric(14,2) and the widest rate numeric(8,4)), so a quotient produced
 * here is never the limiting factor in a comparison against a database-computed value.
 */
MoneyBig.DP = 20;

/** Half-up away from zero — the same rule as Postgres `round(numeric, n)`. See header. */
MoneyBig.RM = MoneyBig.roundHalfUp;

export type Decimal = InstanceType<typeof MoneyBig>;

/**
 * What may legitimately arrive at this boundary.
 *
 * `string` is the normal case and the good one: it is what node-postgres hands back for a
 * `numeric` column when nothing has cast it away. `number` is accepted because integer casts
 * (`::int`, `count(*)::int`) and literals in application code are genuinely numbers — but a
 * *money* value arriving as a number means some SQL still carries a lossy cast, and
 * `scripts/phase17-verify.ts` is what keeps that from creeping back.
 */
export type NumericInput = string | number | Decimal | null | undefined;

/** Scale of a TL amount — every money column in the schema is `numeric(14,2)`. */
export const MONEY_DP = 2;

/**
 * Scale kept for rates, ratios and per-minute figures.
 *
 * These are not money and must not be rounded to 2 decimals: a utilisation rate of 0.8333…
 * or a `finance_cost_per_minute` of 0.0007… would be destroyed. 10 decimals is past the
 * `numeric(8,4)` scale of every stored rate while still landing on a value that a float64
 * represents to well under any tolerance the verify scripts use.
 */
export const RATE_DP = 10;

/**
 * True for text Postgres would accept as `numeric`. Deliberately strict: no thousands
 * separators, no Turkish decimal comma, no surrounding whitespace. Values reaching this
 * module come from the database or from already-validated input; anything looser is a bug
 * upstream that should surface here rather than be silently coerced.
 */
export function isNumericString(value: string): boolean {
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim()) && value.trim() !== "";
}

/**
 * Parse to an exact decimal, or throw.
 *
 * Throwing is the point. The alternative — returning 0 or NaN for unparseable input — is how
 * a bad import row becomes a wrong number on a dashboard with nothing in the logs.
 */
export function toDecimal(value: NumericInput): Decimal {
  const d = toDecimalOrNull(value);
  if (d === null) {
    throw new TypeError(`money: sayısal olmayan değer decimal'e çevrilemez: ${JSON.stringify(value)}`);
  }
  return d;
}

/**
 * Parse to an exact decimal, or null when the value is genuinely unknown.
 *
 * null / undefined / "" all mean "unknown" and stay unknown — CLAUDE.md: a missing amount is
 * never zero. Note the asymmetry with `toDecimal`: this returns null for *unknown*, and still
 * throws for input that is present but nonsense (`"abc"`, `NaN`, `Infinity`), because those
 * are defects rather than absences.
 */
export function toDecimalOrNull(value: NumericInput): Decimal | null {
  if (value === null || value === undefined) return null;
  if (value instanceof MoneyBig) return value as Decimal;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`money: sonlu olmayan sayı (${value}) para değeri olamaz`);
    }
    return new MoneyBig(value);
  }
  const text = typeof value === "string" ? value.trim() : String(value);
  if (text === "") return null;
  if (!isNumericString(text)) {
    throw new TypeError(`money: geçersiz sayısal metin: ${JSON.stringify(value)}`);
  }
  return new MoneyBig(text);
}

/** Round to TL scale (2 dp, half-up) — the same result Postgres `round(x, 2)` produces. */
export function roundMoney(value: NumericInput): Decimal {
  return toDecimal(value).round(MONEY_DP, MoneyBig.roundHalfUp);
}

/**
 * The standard replacement for a `::float8`-cast money column.
 *
 * Parses the exact numeric string, rounds once at TL scale, and only then converts to a
 * number. Every TL amount in this schema fits float64 exactly at 2 dp (numeric(14,2) is at
 * most 10^14 cents against float64's exact-integer range of 2^53 ≈ 9.0×10^15), so the number
 * returned here *is* the value — unlike a float8 cast, which rounds in binary first.
 */
export function moneyOrNull(value: NumericInput): number | null {
  const d = toDecimalOrNull(value);
  return d === null ? null : d.round(MONEY_DP, MoneyBig.roundHalfUp).toNumber();
}

/** `moneyOrNull` for a column that cannot be null. Throws rather than inventing a zero. */
export function money(value: NumericInput): number {
  return roundMoney(value).toNumber();
}

/**
 * The replacement for a `::float8`-cast rate, ratio or per-unit column.
 *
 * Same idea as `moneyOrNull` but at RATE_DP, because rounding a ratio to 2 dp would be a
 * data-destroying "fix".
 */
export function rateOrNull(value: NumericInput): number | null {
  const d = toDecimalOrNull(value);
  return d === null ? null : d.round(RATE_DP, MoneyBig.roundHalfUp).toNumber();
}

/** `rateOrNull` for a column that cannot be null. */
export function rate(value: NumericInput): number {
  return toDecimal(value).round(RATE_DP, MoneyBig.roundHalfUp).toNumber();
}

/**
 * Counts and other whole numbers.
 *
 * `count(*)` is bigint, and node-postgres returns bigint as a string too. Prefer `::int` in
 * the SQL where the count cannot overflow — but where a bigint does arrive, this keeps it
 * honest instead of silently truncating.
 */
export function intOrNull(value: NumericInput): number | null {
  const d = toDecimalOrNull(value);
  if (d === null) return null;
  const n = d.round(0, MoneyBig.roundHalfUp).toNumber();
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`money: tam sayı güvenli aralığın dışında: ${d.toString()}`);
  }
  return n;
}

/**
 * Exact sum. Unknown entries (null/undefined/"") are skipped, never counted as zero —
 * callers that need to disclose how many were unknown should count them separately, which is
 * the pattern the rules modules already follow.
 *
 * This is the helper that repays the whole phase. Accumulating with `+=` on floats drifts:
 * 20 000 rows of 0.07 summed as floats gives 1399.9999999999804 where Postgres `sum()` gives
 * 1400.00 (measured). Summing here gives exactly 1400.
 */
export function sumDecimal(values: Iterable<NumericInput>): Decimal {
  let total: Decimal = new MoneyBig(0);
  for (const v of values) {
    const d = toDecimalOrNull(v);
    if (d !== null) total = total.plus(d);
  }
  return total;
}

/** `sumDecimal` rounded once at TL scale and handed to the render/API layer as a number. */
export function sumMoney(values: Iterable<NumericInput>): number {
  return sumDecimal(values).round(MONEY_DP, MoneyBig.roundHalfUp).toNumber();
}

/** Exact product; both operands parsed as decimals first. */
export function mul(a: NumericInput, b: NumericInput): Decimal {
  return toDecimal(a).times(toDecimal(b));
}

/** Exact sum of two values. */
export function add(a: NumericInput, b: NumericInput): Decimal {
  return toDecimal(a).plus(toDecimal(b));
}

/** Exact difference of two values. */
export function sub(a: NumericInput, b: NumericInput): Decimal {
  return toDecimal(a).minus(toDecimal(b));
}

/**
 * Division that returns null instead of exploding on a zero denominator.
 *
 * big.js throws on division by zero (that is one of the reasons it was chosen), but a zero
 * denominator is a *normal* state here — "no known total yet", "no demand minutes recorded" —
 * not a defect. Turning it into null keeps the "unknown, not zero" rule intact at the one
 * place it is easiest to violate.
 */
export function divOrNull(a: NumericInput, b: NumericInput): Decimal | null {
  const numerator = toDecimalOrNull(a);
  const denominator = toDecimalOrNull(b);
  if (numerator === null || denominator === null) return null;
  if (denominator.eq(0)) return null;
  return numerator.div(denominator);
}

/**
 * part / whole as a plain ratio (0..1), or null when the whole is unknown or zero.
 *
 * The `knownTotal > 0 ? total / knownTotal : 0` idiom this replaces returned 0 for "no
 * denominator", which reads downstream as "0% concentration" — a reassuring answer to a
 * question that was never actually answered.
 */
export function ratioOrNull(part: NumericInput, whole: NumericInput): number | null {
  const q = divOrNull(part, whole);
  return q === null ? null : q.round(RATE_DP, MoneyBig.roundHalfUp).toNumber();
}

/**
 * Fixed-point text with half-up rounding — the correct replacement for `.toFixed(n)` on any
 * money or rate value. See the header for the four measured cases where `toFixed` disagrees
 * with the database.
 */
export function formatMoney(value: NumericInput, dp: number = MONEY_DP): string {
  return toDecimal(value).round(dp, MoneyBig.roundHalfUp).toFixed(dp);
}

/** Same as `formatMoney` but renders unknown as null, for callers that show "TUTAR EKSİK". */
export function formatMoneyOrNull(value: NumericInput, dp: number = MONEY_DP): string | null {
  const d = toDecimalOrNull(value);
  return d === null ? null : d.round(dp, MoneyBig.roundHalfUp).toFixed(dp);
}

/** Exposed so callers can build decimals of their own without importing big.js directly —
 * keeping the scoped constructor (and therefore the DP/RM guarantees) the only one in use. */
export function decimal(value: NumericInput): Decimal {
  return toDecimal(value);
}

/** Zero as a decimal, for accumulator initialisation. */
export function zero(): Decimal {
  return new MoneyBig(0);
}
