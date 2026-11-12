// Wave 3C (v6 Deep CFO Intelligence) — Counterparty Behavioral Working-Capital Scorecard.
//
// Combines three observed operational dimensions into a single deterministic, auditable
// working-capital tier per counterparty:
//   1. DBT (Days Beyond Terms = allocated_on - due_date) settlement discipline.
//   2. Promise-to-Pay (Ödeme Sözü) reliability (kept vs broken vs pending).
//   3. Turkish Check & Contingent Endorsement Recourse exposure (migration 0102 `public.checks`),
//      strictly separated by native currency (`TRY`, `USD`, `EUR`, ...) with Big.js arithmetic.
//
// Core invariants enforced here:
//   - BLANK != ZERO: `< 3` settled sales invoices => `medianDbtDays = null` and `p75DbtDays = null`
//     (never `0` days). `0` settled invoices => `lateRatio = null`. `0` closed promises =>
//     `promiseKeptRatio = null` (never `0%` or `100%`). Empty history => `"insufficient_history"`
//     (never fabricated Tier A).
//   - Native currency separation: check and recourse exposures are grouped per ISO currency code
//     and never summed across currencies without explicit FX conversion.
//   - Read-only / non-mutating: produces deterministic working-capital recommendations and named
//     rule signals; never alters credit limits, terms, invoices, or checks.

import type { Pool } from "pg";
import { computeDbtPercentileDays, LATE_RATIO_THRESHOLD } from "@/lib/collections/rules";
import {
  intOrNull,
  money,
  moneyOrNull,
  rateOrNull,
  ratioOrNull,
  toDecimalOrNull,
  zero,
  type Decimal,
  type NumericInput,
} from "@/lib/money";

/* ── explicit model constants (disclosed on UI as Varsayım / Model Sabiti) ────────────── */

export const COUNTERPARTY_SCORECARD_MODEL_CONSTANTS = {
  isModelConstant: true as const,
  /** Minimum settled sales invoices with a due date required to emit DBT percentiles. */
  minSettledInvoicesForDbt: 3,
  /** Minimum kept promises (with zero broken) required to qualify for Tier A without 3+ invoices. */
  minKeptPromisesForReliable: 2,
  /** Median DBT strictly above 10 days escalates counterparty to Tier C (strained). */
  watchMedianDbtDays: 10,
  /** P75 DBT strictly above 30 days escalates counterparty to Tier D (critical). */
  criticalP75DbtDays: 30,
  /** Broken promises >= 2 combined with kept ratio < 0.50 escalates to Tier D (critical). */
  criticalBrokenPromiseCount: 2,
  /** Promise kept ratio ceiling (< 0.50) for repeated broken-promise Tier D escalation. */
  criticalPromiseKeptRatioCeiling: 0.5,
  /** Share of late settled invoices (>= 0.40) that escalates a >=3-invoice counterparty to Tier C. */
  strainedLateRatioThreshold: LATE_RATIO_THRESHOLD,
  /** Promise kept ratio floor (>= 0.85) qualifying for Tier A when other risk signals are clean. */
  reliablePromiseKeptRatioFloor: 0.85,
} as const;

/* ── types ────────────────────────────────────────────────────────────────────────────── */

export type CounterpartyBehavioralTier =
  | "tier_a_reliable"
  | "tier_b_watch"
  | "tier_c_strained"
  | "tier_d_critical"
  | "insufficient_history";

export const COUNTERPARTY_TIER_LABEL: Record<CounterpartyBehavioralTier, string> = {
  tier_a_reliable: "A — Zamanında & Güvenilir",
  tier_b_watch: "B — İzlemede",
  tier_c_strained: "C — Gecikmeli / Söz Kırımı",
  tier_d_critical: "D — Kritik / Karşılıksız veya Ağır İhlal",
  insufficient_history: "Belirsiz — Yetersiz Geçmiş",
};

const TIER_SORT_ORDER: Record<CounterpartyBehavioralTier, number> = {
  tier_d_critical: 0,
  tier_c_strained: 1,
  tier_b_watch: 2,
  tier_a_reliable: 3,
  insufficient_history: 4,
};

export type CounterpartyScorecardSignal =
  | "bounced_check_recorded"
  | "p75_dbt_exceeds_critical_cutoff"
  | "repeated_broken_promises_low_ratio"
  | "median_dbt_exceeds_watch_cutoff"
  | "promise_broken_recorded"
  | "late_settlement_ratio_high"
  | "median_dbt_positive"
  | "contingent_endorsement_recourse_open"
  | "promise_pending_open"
  | "active_check_exposure_thin_history"
  | "settled_invoices_on_time"
  | "promises_kept_reliably"
  | "insufficient_behavioral_history";

export type CounterpartyCheckBucket =
  | "active_portfolio"
  | "contingent_recourse"
  | "endorsed_received"
  | "bounced";

export interface CounterpartyCheckExposureItem {
  bucket: CounterpartyCheckBucket;
  currency: string | null | undefined;
  /** null = unknown amount; counted, never coerced to zero. */
  amount: NumericInput;
  count?: number;
  unknownAmountCount?: number;
}

export interface CounterpartyScorecardInput {
  partyId: string;
  partyName: string;
  partyType?: string;
  isActive?: boolean;

  /** Settled sales invoice DBT samples (`allocated_on - due_date` in integer days). */
  dbtSamples?: readonly number[];
  /** Number of settled sales invoices; defaults to finite `dbtSamples.length` when omitted. */
  settledInvoiceCount?: number;
  /** Optional fallback average DBT days when raw samples are unavailable (requires `settledInvoiceCount >= 3`). */
  fallbackAvgDbtDays?: NumericInput;
  /** Optional observed late settlement ratio (0..1); ignored/null when `settledInvoiceCount === 0`. */
  lateRatio?: NumericInput;

  /** Promise-to-Pay (`public.promise_to_pay`) counts. */
  promiseKeptCount?: number;
  promiseBrokenCount?: number;
  promisePendingCount?: number;

  /** Check & recourse exposure items (`0102` `public.checks`). */
  checks?: readonly CounterpartyCheckExposureItem[];
  activeCheckPortfolioByCurrency?: Readonly<Record<string, NumericInput>>;
  contingentRecourseByCurrency?: Readonly<Record<string, NumericInput>>;
  endorsedReceivedByCurrency?: Readonly<Record<string, NumericInput>>;
  bouncedByCurrency?: Readonly<Record<string, NumericInput>>;
  activeCheckCount?: number;
  contingentRecourseCount?: number;
  endorsedReceivedCount?: number;
  bouncedCheckCount?: number;
  unknownCheckAmountCount?: number;
}

export interface CounterpartyScorecard {
  partyId: string;
  partyName: string;
  partyType: string;
  isActive: boolean;

  // 1) DBT (Days Beyond Terms) Discipline
  settledInvoiceCount: number;
  medianDbtDays: number | null;
  p75DbtDays: number | null;
  lateRatio: number | null;

  // 2) Promise-to-Pay (PTP) Reliability
  promiseKeptCount: number;
  promiseBrokenCount: number;
  promisePendingCount: number;
  promiseKeptRatio: number | null;

  // 3) Turkish Check & Contingent Recourse Exposure (native currency buckets)
  activeCheckCount: number;
  activeCheckPortfolioByCurrency: Record<string, number>;
  contingentRecourseCount: number;
  contingentRecourseByCurrency: Record<string, number>;
  endorsedReceivedCount: number;
  endorsedReceivedByCurrency: Record<string, number>;
  bouncedCheckCount: number;
  bouncedByCurrency: Record<string, number>;
  unknownCheckAmountCount: number;

  // 4) Deterministic Tier & Working-Capital Recommendation
  tier: CounterpartyBehavioralTier;
  tierLabel: string;
  signals: CounterpartyScorecardSignal[];
  recommendedTermsAction: string;
  hasBehavioralSignal: boolean;
}

/* ── pure helpers ─────────────────────────────────────────────────────────────────────── */

function nonNegativeInt(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeSignedZero(value: number | null): number | null {
  if (value === null) return null;
  return Object.is(value, -0) ? 0 : value;
}

function normalizeCurrencyCode(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim().toUpperCase();
  return trimmed !== "" ? trimmed : "TRY";
}

function compareCurrencyKeys(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "TRY") return -1;
  if (b === "TRY") return 1;
  return a.localeCompare(b, "en");
}

interface AggregatedCheckBucket {
  byCurrency: Record<string, number>;
  count: number;
  unknownCount: number;
}

function aggregateCheckBucket(
  bucket: CounterpartyCheckBucket,
  items: readonly CounterpartyCheckExposureItem[] | undefined,
  directMap: Readonly<Record<string, NumericInput>> | undefined,
  explicitCount: number | undefined,
): AggregatedCheckBucket {
  const sums = new Map<string, Decimal>();
  let itemCountFromArray = 0;
  let unknownFromArray = 0;
  let hadItemsForBucket = false;

  if (items) {
    for (const item of items) {
      if (item.bucket !== bucket) continue;
      hadItemsForBucket = true;
      const c = item.count !== undefined ? nonNegativeInt(item.count) : 1;
      itemCountFromArray += c;

      const parsedAmt = toDecimalOrNull(item.amount);
      if (parsedAmt === null) {
        const u = item.unknownAmountCount !== undefined ? nonNegativeInt(item.unknownAmountCount) : c;
        unknownFromArray += u;
      } else {
        if (item.unknownAmountCount !== undefined) {
          unknownFromArray += nonNegativeInt(item.unknownAmountCount);
        }
        if (parsedAmt.gt(0)) {
          const cur = normalizeCurrencyCode(item.currency);
          const prev = sums.get(cur) ?? zero();
          sums.set(cur, prev.plus(parsedAmt));
        }
      }
    }
  }

  if (directMap) {
    for (const [rawCur, rawVal] of Object.entries(directMap)) {
      const d = toDecimalOrNull(rawVal);
      if (d !== null && d.gt(0)) {
        const cur = normalizeCurrencyCode(rawCur);
        const prev = sums.get(cur) ?? zero();
        sums.set(cur, prev.plus(d));
      }
    }
  }

  const byCurrency: Record<string, number> = {};
  const sortedCurrencies = [...sums.keys()].sort(compareCurrencyKeys);
  for (const cur of sortedCurrencies) {
    const dec = sums.get(cur);
    if (dec && dec.gt(0)) {
      const rounded = money(dec);
      if (rounded > 0) {
        byCurrency[cur] = rounded;
      }
    }
  }

  const currencyKeyCount = Object.keys(byCurrency).length;
  let count: number;
  if (explicitCount !== undefined) {
    count = itemCountFromArray + nonNegativeInt(explicitCount);
  } else if (hadItemsForBucket) {
    count = Math.max(itemCountFromArray, currencyKeyCount);
  } else {
    count = currencyKeyCount;
  }

  return {
    byCurrency,
    count,
    unknownCount: unknownFromArray,
  };
}

function buildRecommendedAction(
  tier: CounterpartyBehavioralTier,
  ctx: {
    bouncedCheckCount: number;
    hasContingentRecourse: boolean;
    promisePendingCount: number;
  },
): string {
  switch (tier) {
    case "tier_d_critical":
      if (ctx.bouncedCheckCount > 0) {
        return "Karşılıksız çek kaydı var — açık hesap ve çek kabulünü durdurun; yalnız peşin veya banka teminatlı çalışın.";
      }
      return "Açık hesap yerine teminat / avans veya onaylı çek şartı değerlendirin; sevkiyat öncesi mutabakat isteyin.";
    case "tier_c_strained":
      return "Vade uzatmayın; açık hesap limitini daraltın ve kırılan ödeme sözü veya gecikme kapanmadan ek risk açmayın.";
    case "tier_b_watch":
      if (ctx.hasContingentRecourse) {
        return "Ciro rücu tavanını izleyin; ciro edilen müşteri çekleri tahsil olana kadar açık hesap limitini kontrollü tutun.";
      }
      if (ctx.promisePendingCount > 0) {
        return "Bekleyen ödeme sözünü vade gününde doğrulayın; tahsilat gerçekleşene kadar standart vadeyi koruyun.";
      }
      return "Sınırlı gecikme / izleme sinyali — standart vadeyi koruyun, vade öncesi tahsilat hatırlatmasını açık tutun.";
    case "tier_a_reliable":
      return "Standart vade korunabilir; erken ödeme iskontosu veya tedarikçi finansmanı adayı.";
    case "insufficient_history":
      return "Yetersiz geçmiş — otomatik vade puanı üretilmedi; standart başlangıç limiti ve yakın vade takibi uygulayın.";
  }
}

/* ── pure deterministic scorecard calculator ──────────────────────────────────────────── */

export function computeCounterpartyScorecard(
  input: CounterpartyScorecardInput,
): CounterpartyScorecard {
  const C = COUNTERPARTY_SCORECARD_MODEL_CONSTANTS;
  const cleanSamples = (input.dbtSamples ?? []).filter((n) => Number.isFinite(n));
  const settledInvoiceCount =
    input.settledInvoiceCount !== undefined
      ? nonNegativeInt(input.settledInvoiceCount)
      : cleanSamples.length;

  // 1) DBT Discipline — strict BLANK != ZERO when settledInvoiceCount < 3
  let medianDbtDays: number | null = null;
  let p75DbtDays: number | null = null;
  if (settledInvoiceCount >= C.minSettledInvoicesForDbt) {
    if (cleanSamples.length >= C.minSettledInvoicesForDbt) {
      medianDbtDays = normalizeSignedZero(computeDbtPercentileDays(cleanSamples, "median"));
      p75DbtDays = normalizeSignedZero(computeDbtPercentileDays(cleanSamples, "p75"));
    } else {
      const fallbackAvg = rateOrNull(input.fallbackAvgDbtDays);
      if (fallbackAvg !== null) {
        const roundedLag = normalizeSignedZero(Math.round(fallbackAvg));
        medianDbtDays = roundedLag;
        p75DbtDays = roundedLag;
      }
    }
  }

  let lateRatio: number | null = null;
  if (settledInvoiceCount > 0) {
    if (input.lateRatio !== undefined) {
      lateRatio = rateOrNull(input.lateRatio);
    } else if (cleanSamples.length > 0) {
      const lateCount = cleanSamples.filter((d) => d > 0).length;
      lateRatio = ratioOrNull(lateCount, cleanSamples.length);
    }
  }

  // 2) Promise-to-Pay Reliability — strict BLANK != ZERO when closed promises === 0
  const promiseKeptCount = nonNegativeInt(input.promiseKeptCount);
  const promiseBrokenCount = nonNegativeInt(input.promiseBrokenCount);
  const promisePendingCount = nonNegativeInt(input.promisePendingCount);
  const closedPromiseCount = promiseKeptCount + promiseBrokenCount;
  const promiseKeptRatio: number | null =
    closedPromiseCount === 0 ? null : ratioOrNull(promiseKeptCount, closedPromiseCount);

  // 3) Turkish Check & Contingent Recourse Exposure (native currency buckets via Big.js)
  const activeBucket = aggregateCheckBucket(
    "active_portfolio",
    input.checks,
    input.activeCheckPortfolioByCurrency,
    input.activeCheckCount,
  );
  const recourseBucket = aggregateCheckBucket(
    "contingent_recourse",
    input.checks,
    input.contingentRecourseByCurrency,
    input.contingentRecourseCount,
  );
  const endorsedReceivedBucket = aggregateCheckBucket(
    "endorsed_received",
    input.checks,
    input.endorsedReceivedByCurrency,
    input.endorsedReceivedCount,
  );
  const bouncedBucket = aggregateCheckBucket(
    "bounced",
    input.checks,
    input.bouncedByCurrency,
    input.bouncedCheckCount,
  );

  const unknownCheckAmountCount =
    activeBucket.unknownCount +
    recourseBucket.unknownCount +
    endorsedReceivedBucket.unknownCount +
    bouncedBucket.unknownCount +
    nonNegativeInt(input.unknownCheckAmountCount);

  const hasContingentRecourse =
    Object.keys(recourseBucket.byCurrency).length > 0 || recourseBucket.count > 0;
  const hasActiveCheckPortfolio =
    Object.keys(activeBucket.byCurrency).length > 0 || activeBucket.count > 0;

  // 4) Deterministic Tier Evaluation (D -> C -> B -> A -> insufficient_history)
  const signals: CounterpartyScorecardSignal[] = [];

  const isTierD = (() => {
    let match = false;
    if (bouncedBucket.count > 0) {
      signals.push("bounced_check_recorded");
      match = true;
    }
    if (p75DbtDays !== null && p75DbtDays > C.criticalP75DbtDays) {
      signals.push("p75_dbt_exceeds_critical_cutoff");
      match = true;
    }
    if (
      promiseBrokenCount >= C.criticalBrokenPromiseCount &&
      promiseKeptRatio !== null &&
      promiseKeptRatio < C.criticalPromiseKeptRatioCeiling
    ) {
      signals.push("repeated_broken_promises_low_ratio");
      match = true;
    }
    return match;
  })();

  let tier: CounterpartyBehavioralTier;

  if (isTierD) {
    tier = "tier_d_critical";
  } else {
    const isTierC = (() => {
      let match = false;
      if (medianDbtDays !== null && medianDbtDays > C.watchMedianDbtDays) {
        signals.push("median_dbt_exceeds_watch_cutoff");
        match = true;
      }
      if (promiseBrokenCount >= 1) {
        signals.push("promise_broken_recorded");
        match = true;
      }
      if (
        settledInvoiceCount >= C.minSettledInvoicesForDbt &&
        lateRatio !== null &&
        lateRatio >= C.strainedLateRatioThreshold
      ) {
        signals.push("late_settlement_ratio_high");
        match = true;
      }
      return match;
    })();

    if (isTierC) {
      tier = "tier_c_strained";
    } else {
      const hasSufficientInvoiceTrackRecord =
        settledInvoiceCount >= C.minSettledInvoicesForDbt &&
        medianDbtDays !== null &&
        medianDbtDays <= 0;
      const hasSufficientPromiseTrackRecord =
        promiseKeptCount >= C.minKeptPromisesForReliable &&
        promiseBrokenCount === 0 &&
        promiseKeptRatio !== null &&
        promiseKeptRatio >= C.reliablePromiseKeptRatioFloor;
      const qualifiesForTierA =
        bouncedBucket.count === 0 &&
        (hasSufficientInvoiceTrackRecord || hasSufficientPromiseTrackRecord);

      let isTierB = false;
      if (medianDbtDays !== null && medianDbtDays > 0) {
        signals.push("median_dbt_positive");
        isTierB = true;
      }
      if (hasContingentRecourse) {
        signals.push("contingent_endorsement_recourse_open");
        isTierB = true;
      }
      if (promisePendingCount > 0) {
        signals.push("promise_pending_open");
        isTierB = true;
      }
      if (!qualifiesForTierA && hasActiveCheckPortfolio) {
        signals.push("active_check_exposure_thin_history");
        isTierB = true;
      }

      if (isTierB) {
        tier = "tier_b_watch";
      } else if (qualifiesForTierA) {
        if (hasSufficientInvoiceTrackRecord) {
          signals.push("settled_invoices_on_time");
        }
        if (hasSufficientPromiseTrackRecord) {
          signals.push("promises_kept_reliably");
        }
        tier = "tier_a_reliable";
      } else {
        signals.push("insufficient_behavioral_history");
        tier = "insufficient_history";
      }
    }
  }

  const recommendedTermsAction = buildRecommendedAction(tier, {
    bouncedCheckCount: bouncedBucket.count,
    hasContingentRecourse,
    promisePendingCount,
  });

  const hasBehavioralSignal =
    tier !== "insufficient_history" ||
    settledInvoiceCount > 0 ||
    closedPromiseCount > 0 ||
    promisePendingCount > 0 ||
    activeBucket.count > 0 ||
    recourseBucket.count > 0 ||
    endorsedReceivedBucket.count > 0 ||
    bouncedBucket.count > 0;

  return {
    partyId: input.partyId,
    partyName: input.partyName,
    partyType: input.partyType ?? "unknown",
    isActive: input.isActive ?? true,
    settledInvoiceCount,
    medianDbtDays,
    p75DbtDays,
    lateRatio,
    promiseKeptCount,
    promiseBrokenCount,
    promisePendingCount,
    promiseKeptRatio,
    activeCheckCount: activeBucket.count,
    activeCheckPortfolioByCurrency: activeBucket.byCurrency,
    contingentRecourseCount: recourseBucket.count,
    contingentRecourseByCurrency: recourseBucket.byCurrency,
    endorsedReceivedCount: endorsedReceivedBucket.count,
    endorsedReceivedByCurrency: endorsedReceivedBucket.byCurrency,
    bouncedCheckCount: bouncedBucket.count,
    bouncedByCurrency: bouncedBucket.byCurrency,
    unknownCheckAmountCount,
    tier,
    tierLabel: COUNTERPARTY_TIER_LABEL[tier],
    signals,
    recommendedTermsAction,
    hasBehavioralSignal,
  };
}

/* ── DB read-model loader (graceful 42P01 / 42703 fallback, strict error rethrow) ────── */

function isMissingSchemaObjectError(err: unknown): boolean {
  const pgCode = (err as { code?: string } | null)?.code;
  return pgCode === "42P01" || pgCode === "42703";
}

export interface LoadCounterpartyScorecardsOptions {
  limit?: number;
  activeOnly?: boolean;
  partyIds?: readonly string[];
}

interface PartyBaseRow {
  party_id: string;
  party_name: string;
  party_type: string;
  is_active: boolean;
}

interface DbtQueryRow {
  party_id: string;
  settled_invoice_count: string | number | null;
  late_invoice_count: string | number | null;
  dbt_samples: unknown;
  profile_late_ratio: string | number | null;
}

interface PromiseQueryRow {
  party_id: string;
  promise_kept_count?: string | number | null;
  promise_broken_count?: string | number | null;
  promise_pending_count?: string | number | null;
  promise_kept_ratio?: string | number | null;
}

interface CheckQueryRow {
  party_id: string;
  bucket: string;
  currency: string | null;
  item_count: string | number | null;
  unknown_amount_count: string | number | null;
  known_amount: string | number | null;
}

async function queryParties(
  pool: Pool,
  opts: LoadCounterpartyScorecardsOptions,
): Promise<PartyBaseRow[]> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const activeOnly = opts.activeOnly ?? false;

  if (opts.partyIds !== undefined) {
    if (opts.partyIds.length === 0) return [];
    const r = await pool.query<PartyBaseRow>(
      `select
         p.id::text as party_id,
         p.name as party_name,
         p.party_type,
         p.is_active
       from public.parties p
       where p.id = any($1::uuid[])
         and ($2::boolean is not true or p.is_active = true)
       order by p.is_active desc, p.name asc
       limit $3`,
      [opts.partyIds, activeOnly, limit],
    );
    return r.rows;
  }

  try {
    const r = await pool.query<PartyBaseRow>(
      `select
         p.id::text as party_id,
         p.name as party_name,
         p.party_type,
         p.is_active
       from public.parties p
       left join public.counterparty_exposure ce on ce.party_id = p.id
       where ($1::boolean is not true or p.is_active = true)
       order by coalesce(ce.total_exposure, 0) desc, p.name asc
       limit $2`,
      [activeOnly, limit],
    );
    return r.rows;
  } catch (err) {
    if (!isMissingSchemaObjectError(err)) throw err;
    const r = await pool.query<PartyBaseRow>(
      `select
         p.id::text as party_id,
         p.name as party_name,
         p.party_type,
         p.is_active
       from public.parties p
       where ($1::boolean is not true or p.is_active = true)
       order by p.is_active desc, p.name asc
       limit $2`,
      [activeOnly, limit],
    );
    return r.rows;
  }
}

async function queryDbtByParty(
  pool: Pool,
  partyIds: readonly string[],
): Promise<Map<string, { settledCount: number; dbtSamples: number[]; lateRatio: number | null }>> {
  let rows: DbtQueryRow[] = [];
  try {
    const r = await pool.query<DbtQueryRow>(
      `with party_dbt as (
         select
           s.party_id,
           count(*)::int as settled_invoice_count,
           count(*) filter (where s.dbt_days > 0)::int as late_invoice_count,
           array_agg(s.dbt_days order by s.dbt_days) as dbt_samples
         from (
           select
             inv.party_id,
             inv.id,
             (max(a.allocated_on) - inv.due_date)::int as dbt_days
           from public.invoices inv
           join public.invoice_allocations a
             on a.invoice_id = inv.id and a.reversed_at is null
           where inv.party_id = any($1::uuid[])
             and inv.direction = 'sales'
             and inv.status in ('paid', 'closed')
             and inv.due_date is not null
           group by inv.party_id, inv.id, inv.due_date
         ) s
         group by s.party_id
       )
       select
         coalesce(d.party_id, ccp.party_id)::text as party_id,
         coalesce(d.settled_invoice_count, 0)::int as settled_invoice_count,
         d.late_invoice_count,
         d.dbt_samples,
         ccp.late_ratio as profile_late_ratio
       from party_dbt d
       full outer join (
         select party_id, late_ratio
         from public.counterparty_collection_profile
         where party_id = any($1::uuid[])
       ) ccp on ccp.party_id = d.party_id`,
      [partyIds],
    );
    rows = r.rows;
  } catch (err) {
    if (!isMissingSchemaObjectError(err)) throw err;
    try {
      const r2 = await pool.query<DbtQueryRow>(
        `select
           s.party_id::text as party_id,
           count(*)::int as settled_invoice_count,
           count(*) filter (where s.dbt_days > 0)::int as late_invoice_count,
           array_agg(s.dbt_days order by s.dbt_days) as dbt_samples,
           null::numeric as profile_late_ratio
         from (
           select
             inv.party_id,
             inv.id,
             (max(a.allocated_on) - inv.due_date)::int as dbt_days
           from public.invoices inv
           join public.invoice_allocations a
             on a.invoice_id = inv.id and a.reversed_at is null
           where inv.party_id = any($1::uuid[])
             and inv.direction = 'sales'
             and inv.status in ('paid', 'closed')
             and inv.due_date is not null
           group by inv.party_id, inv.id, inv.due_date
         ) s
         group by s.party_id`,
        [partyIds],
      );
      rows = r2.rows;
    } catch (err2) {
      if (!isMissingSchemaObjectError(err2)) throw err2;
      rows = [];
    }
  }

  const out = new Map<string, { settledCount: number; dbtSamples: number[]; lateRatio: number | null }>();
  for (const row of rows) {
    const settledCount = intOrNull(row.settled_invoice_count) ?? 0;
    const rawSamples = Array.isArray(row.dbt_samples) ? row.dbt_samples : [];
    const dbtSamples = rawSamples
      .map((n: unknown) => intOrNull(n as NumericInput))
      .filter((n): n is number => n !== null);
    const lateCount = intOrNull(row.late_invoice_count);
    const computedLateRatio =
      settledCount > 0 && lateCount !== null
        ? ratioOrNull(lateCount, settledCount)
        : settledCount > 0
          ? rateOrNull(row.profile_late_ratio)
          : null;
    out.set(row.party_id, {
      settledCount,
      dbtSamples,
      lateRatio: computedLateRatio,
    });
  }
  return out;
}

async function queryPromisesByParty(
  pool: Pool,
  partyIds: readonly string[],
): Promise<Map<string, { kept: number; broken: number; pending: number }>> {
  const out = new Map<string, { kept: number; broken: number; pending: number }>();
  try {
    const r = await pool.query<PromiseQueryRow>(
      `select
         p.party_id::text as party_id,
         count(*) filter (where p.status = 'kept')::int as promise_kept_count,
         count(*) filter (where p.status = 'broken')::int as promise_broken_count,
         count(*) filter (where p.status = 'pending')::int as promise_pending_count
       from public.promise_to_pay p
       where p.party_id = any($1::uuid[])
       group by p.party_id`,
      [partyIds],
    );
    for (const row of r.rows) {
      out.set(row.party_id, {
        kept: intOrNull(row.promise_kept_count) ?? 0,
        broken: intOrNull(row.promise_broken_count) ?? 0,
        pending: intOrNull(row.promise_pending_count) ?? 0,
      });
    }
    return out;
  } catch (err) {
    if (!isMissingSchemaObjectError(err)) throw err;
    try {
      const r2 = await pool.query<PromiseQueryRow>(
        `select
           s.party_id::text as party_id,
           s.promise_pending_count,
           s.promise_broken_count,
           s.promise_kept_ratio
         from public.customer_collection_score s
         where s.party_id = any($1::uuid[])`,
        [partyIds],
      );
      for (const row of r2.rows) {
        const broken = intOrNull(row.promise_broken_count) ?? 0;
        const pending = intOrNull(row.promise_pending_count) ?? 0;
        const ratio = rateOrNull(row.promise_kept_ratio);
        let kept = 0;
        if (ratio !== null) {
          if (ratio >= 1) {
            kept = broken === 0 ? 1 : 0;
          } else if (ratio > 0 && broken > 0) {
            kept = Math.max(0, Math.round((broken * ratio) / (1 - ratio)));
          }
        }
        out.set(row.party_id, { kept, broken, pending });
      }
      return out;
    } catch (err2) {
      if (!isMissingSchemaObjectError(err2)) throw err2;
      return out;
    }
  }
}

function isCheckBucket(value: string): value is CounterpartyCheckBucket {
  return (
    value === "active_portfolio" ||
    value === "contingent_recourse" ||
    value === "endorsed_received" ||
    value === "bounced"
  );
}

async function queryChecksByParty(
  pool: Pool,
  partyIds: readonly string[],
): Promise<Map<string, CounterpartyCheckExposureItem[]>> {
  let rows: CheckQueryRow[] = [];
  try {
    const r = await pool.query<CheckQueryRow>(
      `select
         u.party_id::text as party_id,
         u.bucket,
         coalesce(u.currency, 'TRY') as currency,
         count(*)::int as item_count,
         count(*) filter (where u.amount is null)::int as unknown_amount_count,
         sum(u.amount) filter (where u.amount is not null) as known_amount
       from (
         select
           c.payer_party_id as party_id,
           'active_portfolio'::text as bucket,
           c.currency,
           c.amount
         from public.checks c
         where c.archived_at is null
           and c.payer_party_id = any($1::uuid[])
           and c.status in ('in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'planned')

         union all

         select
           c.payer_party_id as party_id,
           'contingent_recourse'::text as bucket,
           c.currency,
           c.amount
         from public.checks c
         where c.archived_at is null
           and c.payer_party_id = any($1::uuid[])
           and c.status = 'endorsed_to_vendor'

         union all

         select
           c.endorsed_to_party_id as party_id,
           'endorsed_received'::text as bucket,
           c.currency,
           c.amount
         from public.checks c
         where c.archived_at is null
           and c.endorsed_to_party_id = any($1::uuid[])
           and c.status = 'endorsed_to_vendor'

         union all

         select
           bp.party_id,
           'bounced'::text as bucket,
           c.currency,
           c.amount
         from public.checks c
         cross join lateral (
           select distinct x.pid as party_id
           from (values (c.payer_party_id), (c.payee_party_id)) as x(pid)
           where x.pid is not null and x.pid = any($1::uuid[])
         ) bp
         where c.archived_at is null
           and c.status = 'bounced'
       ) u
       group by u.party_id, u.bucket, coalesce(u.currency, 'TRY')`,
      [partyIds],
    );
    rows = r.rows;
  } catch (err) {
    if (!isMissingSchemaObjectError(err)) throw err;
    // Pre-0102 schema fallback (`endorsed_to_party_id` or `currency` column not yet migrated)
    try {
      const r2 = await pool.query<CheckQueryRow>(
        `select
           u.party_id::text as party_id,
           u.bucket,
           'TRY'::text as currency,
           count(*)::int as item_count,
           count(*) filter (where u.amount is null)::int as unknown_amount_count,
           sum(u.amount) filter (where u.amount is not null) as known_amount
         from (
           select
             c.payer_party_id as party_id,
             'active_portfolio'::text as bucket,
             c.amount
           from public.checks c
           where c.archived_at is null
             and c.payer_party_id = any($1::uuid[])
             and c.status = 'planned'

           union all

           select
             bp.party_id,
             'bounced'::text as bucket,
             c.amount
           from public.checks c
           cross join lateral (
             select distinct x.pid as party_id
             from (values (c.payer_party_id), (c.payee_party_id)) as x(pid)
             where x.pid is not null and x.pid = any($1::uuid[])
           ) bp
           where c.archived_at is null
             and c.status = 'bounced'
         ) u
         group by u.party_id, u.bucket`,
        [partyIds],
      );
      rows = r2.rows;
    } catch (err2) {
      if (!isMissingSchemaObjectError(err2)) throw err2;
      rows = [];
    }
  }

  const out = new Map<string, CounterpartyCheckExposureItem[]>();
  for (const row of rows) {
    if (!isCheckBucket(row.bucket)) continue;
    const itemCount = intOrNull(row.item_count) ?? 0;
    if (itemCount <= 0) continue;
    const unknownCount = intOrNull(row.unknown_amount_count) ?? 0;
    const knownAmount = moneyOrNull(row.known_amount);

    const list = out.get(row.party_id) ?? [];
    list.push({
      bucket: row.bucket,
      currency: row.currency,
      amount: knownAmount,
      count: itemCount,
      unknownAmountCount: unknownCount,
    });
    out.set(row.party_id, list);
  }
  return out;
}

export async function loadCounterpartyScorecards(
  pool: Pool,
  options: LoadCounterpartyScorecardsOptions = {},
): Promise<CounterpartyScorecard[]> {
  const parties = await queryParties(pool, options);
  if (parties.length === 0) return [];

  const partyIds = parties.map((p) => p.party_id);
  const dbtByParty = await queryDbtByParty(pool, partyIds);
  const ptpByParty = await queryPromisesByParty(pool, partyIds);
  const checksByParty = await queryChecksByParty(pool, partyIds);

  const scorecards = parties.map((party) => {
    const dbt = dbtByParty.get(party.party_id);
    const ptp = ptpByParty.get(party.party_id);
    const checks = checksByParty.get(party.party_id);

    return computeCounterpartyScorecard({
      partyId: party.party_id,
      partyName: party.party_name,
      partyType: party.party_type,
      isActive: Boolean(party.is_active),
      dbtSamples: dbt?.dbtSamples,
      settledInvoiceCount: dbt?.settledCount ?? 0,
      lateRatio: dbt !== undefined ? dbt.lateRatio : undefined,
      promiseKeptCount: ptp?.kept ?? 0,
      promiseBrokenCount: ptp?.broken ?? 0,
      promisePendingCount: ptp?.pending ?? 0,
      checks,
    });
  });

  return scorecards.sort((a, b) => {
    const tierDiff = TIER_SORT_ORDER[a.tier] - TIER_SORT_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff;
    if (b.bouncedCheckCount !== a.bouncedCheckCount) {
      return b.bouncedCheckCount - a.bouncedCheckCount;
    }
    if (b.promiseBrokenCount !== a.promiseBrokenCount) {
      return b.promiseBrokenCount - a.promiseBrokenCount;
    }
    if (b.contingentRecourseCount !== a.contingentRecourseCount) {
      return b.contingentRecourseCount - a.contingentRecourseCount;
    }
    if (b.settledInvoiceCount !== a.settledInvoiceCount) {
      return b.settledInvoiceCount - a.settledInvoiceCount;
    }
    return a.partyName.localeCompare(b.partyName, "tr");
  });
}
