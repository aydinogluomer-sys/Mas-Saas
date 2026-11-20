// Faz 47 (D1) — Kanonik KPI Yükleyicisi (`src/lib/metrics/canonical-kpis.ts`).
//
// Ekranlar arası 4 metrik çelişkisini (sayfalanmış 50/100 satırdan toplam alma,
// `partial` ödemede tam tutar sayma, 2028 projeksiyon kasasını bugünkü nakit sanma,
// yabancı para toplamlarını TRY'ye karıştırma veya yutma) tek kaynaktan sıfırlar.

import type { Pool, PoolClient } from "pg";
import type { SourceCompletenessStatus } from "@/lib/contracts/remediation-contracts";
import { DomainError } from "@/lib/domain-error";
import { intOrNull, moneyOrNull } from "@/lib/money";
import { istanbulDateISO } from "@/lib/reports/rules";
import type { CurrencyAmountBucket } from "@/lib/money-format";
import { gather } from "@/lib/pg-concurrency";

type DbQueryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export interface CanonicalKpiLoadOptions {
  failClosedOnSchemaError?: boolean;
  failOnSchemaDrift?: boolean;
}

export interface CanonicalOpenLedgerKpi {
  /** Yalnız `currency = 'TRY'` açık kayıtların sayfalanmamış tam DB toplamı. */
  tryTotal: number;
  /** Yalnız `currency = 'TRY'` açık kayıt adedi. */
  tryCount: number;
  /** Para biriminden bağımsız toplam açık kayıt adedi. */
  totalCount: number;
  /** `days_overdue > 0` olan toplam gecikmiş açık kayıt adedi. */
  overdueCount: number;
  /** Yalnız `currency = 'TRY'` gecikmiş açık tutar toplamı. */
  overdueTryTotal: number;
  /** TRY-dışı (veya `currency is null`) para birimi kovaları — asla TRY toplamına karıştırılmaz. */
  foreignBuckets: CurrencyAmountBucket[];
}

export interface CanonicalTreasuryCashKpi {
  /**
   * `treasury_position_summary` üzerinden gerçek `TRY` `available_now` bakiyesi.
   * `FIN-03` & `F-03`: Herhangi bir aktif TRY hesabının açılış bakiyesi belirsizse,
   * şema eksikse (`42703`/`42P01`), `available_now` NULL ise veya doğrulanmamış boş görünüm
   * dönüyorsa `null` döner — uydurma `0` üretilmez (`UNKNOWN != 0`)!
   */
  availableNowTry: number | null;
  accountCountTry: number;
  unknownOpeningCountTry: number;
  unknownCashAccountCount: number;
  cashSourceStatus: SourceCompletenessStatus;
  legacyUnverified: boolean;
  foreignBuckets: Array<{
    currency: string;
    availableNow: number | null;
    accountCount: number;
    unknownOpeningCount: number;
  }>;
}

export interface CanonicalOutflow7dKpi {
  /** Önümüzdeki 7 günün (`[today, today+6]`) kalan (`amount - paid_amount`) TRY açık çıkışı. */
  tryRemainingTotal: number;
  tryOpenCount: number;
  totalOpenCount: number;
  missingAmountCount: number;
  foreignBuckets: CurrencyAmountBucket[];
}

export interface CanonicalKpiSnapshot {
  todayISO: string;
  treasuryCash: CanonicalTreasuryCashKpi;
  cashSourceStatus: SourceCompletenessStatus;
  legacyUnverified: boolean;
  openReceivables: CanonicalOpenLedgerKpi;
  openPayables: CanonicalOpenLedgerKpi;
  outflow7d: CanonicalOutflow7dKpi;
}

async function loadOpenLedgerFromView(
  db: DbQueryable,
  view: "receivables_open" | "payables_open",
): Promise<CanonicalOpenLedgerKpi> {
  const r = await db.query<{
    currency: string | null;
    total_open: string;
    item_count: number;
    overdue_count: number;
    overdue_open: string;
  }>(
    `select
       currency,
       coalesce(sum(open_amount), 0)::text as total_open,
       count(*)::int as item_count,
       count(*) filter (where coalesce(days_overdue, 0) > 0)::int as overdue_count,
       coalesce(sum(open_amount) filter (where coalesce(days_overdue, 0) > 0), 0)::text as overdue_open
     from public.${view}
     group by currency
     order by (currency = 'TRY') desc nulls last, currency nulls last`,
  );

  let tryTotal = 0;
  let tryCount = 0;
  let totalCount = 0;
  let overdueCount = 0;
  let overdueTryTotal = 0;
  const foreignBuckets: CurrencyAmountBucket[] = [];

  for (const row of r.rows) {
    const count = intOrNull(row.item_count) ?? 0;
    const ovdCount = intOrNull(row.overdue_count) ?? 0;
    const openAmt = moneyOrNull(row.total_open) ?? 0;
    const ovdAmt = moneyOrNull(row.overdue_open) ?? 0;
    totalCount += count;
    overdueCount += ovdCount;

    if (row.currency === "TRY") {
      tryTotal = openAmt;
      tryCount = count;
      overdueTryTotal = ovdAmt;
    } else if (count > 0) {
      foreignBuckets.push({
        currency: row.currency,
        total: openAmt,
        count,
      });
    }
  }

  return {
    tryTotal,
    tryCount,
    totalCount,
    overdueCount,
    overdueTryTotal,
    foreignBuckets,
  };
}

export async function loadCanonicalReceivablesKpi(db: DbQueryable): Promise<CanonicalOpenLedgerKpi> {
  return loadOpenLedgerFromView(db, "receivables_open");
}

export async function loadCanonicalPayablesKpi(db: DbQueryable): Promise<CanonicalOpenLedgerKpi> {
  return loadOpenLedgerFromView(db, "payables_open");
}

export async function loadCanonicalTreasuryCashKpi(
  db: DbQueryable,
  opts?: CanonicalKpiLoadOptions,
): Promise<CanonicalTreasuryCashKpi> {
  const strictSchema = Boolean(opts?.failClosedOnSchemaError || opts?.failOnSchemaDrift);
  let legacyFallback = false;
  let schemaIncompatible = false;

  const r = await db
    .query<{
      currency: string;
      account_count: number;
      unknown_opening_count: number;
      available_now: string | null;
    }>(
      `select
         currency,
         account_count::int as account_count,
         coalesce(unknown_opening_count, 0)::int as unknown_opening_count,
         available_now::text as available_now
       from public.treasury_position_summary
       order by (currency = 'TRY') desc, currency`,
    )
    .catch(async (err: unknown) => {
      const code = (err as { code?: string })?.code;
      if (code === "42P01") {
        if (strictSchema) {
          throw new DomainError(
            "CONFLICT",
            "SCHEMA_INCOMPATIBLE: treasury_position_summary görünümü mevcut değil.",
          );
        }
        schemaIncompatible = true;
        return { rows: [] };
      }
      if (code === "42703") {
        if (strictSchema) {
          throw new DomainError(
            "CONFLICT",
            "SCHEMA_INCOMPATIBLE: treasury_position_summary.unknown_opening_count kolonu eksik.",
          );
        }
        legacyFallback = true;
        return db
          .query<{
            currency: string;
            account_count: number;
            unknown_opening_count: number;
            available_now: string | null;
          }>(
            `select
               currency,
               account_count::int as account_count,
               0::int as unknown_opening_count,
               available_now::text as available_now
             from public.treasury_position_summary
             order by (currency = 'TRY') desc, currency`,
          )
          .catch((fallbackErr: unknown) => {
            const fbCode = (fallbackErr as { code?: string })?.code;
            if (fbCode === "42P01" || fbCode === "42703") {
              schemaIncompatible = true;
              return { rows: [] };
            }
            throw fallbackErr;
          });
      }
      throw err;
    });

  if (schemaIncompatible) {
    return {
      availableNowTry: null,
      accountCountTry: 0,
      unknownOpeningCountTry: 0,
      unknownCashAccountCount: 0,
      cashSourceStatus: "SCHEMA_INCOMPATIBLE",
      legacyUnverified: false,
      foreignBuckets: [],
    };
  }

  let availableNowTry: number | null = null;
  let accountCountTry = 0;
  let unknownOpeningCountTry = 0;
  let tryAvailableParsed: number | null = null;
  let sawTry = false;
  const foreignBuckets: CanonicalTreasuryCashKpi["foreignBuckets"] = [];

  for (const row of r.rows) {
    const accountCount = intOrNull(row.account_count) ?? 0;
    const unknownCount = intOrNull(row.unknown_opening_count) ?? 0;
    const rawAvailable =
      row.available_now !== undefined
        ? row.available_now
        : ((row as { available?: string | null }).available ?? null);
    const parsedAvailable = moneyOrNull(rawAvailable);

    if (row.currency === "TRY") {
      sawTry = true;
      accountCountTry = accountCount;
      unknownOpeningCountTry = unknownCount;
      tryAvailableParsed = parsedAvailable;
    } else {
      const foreignAvailable =
        !legacyFallback &&
        unknownCount === 0 &&
        accountCount > 0 &&
        parsedAvailable !== null &&
        Number.isFinite(parsedAvailable)
          ? parsedAvailable
          : null;
      foreignBuckets.push({
        currency: row.currency,
        availableNow: foreignAvailable,
        accountCount,
        unknownOpeningCount: unknownCount,
      });
    }
  }

  if (legacyFallback) {
    const unknownCashAccountCount =
      unknownOpeningCountTry +
      foreignBuckets.reduce((sum, b) => sum + b.unknownOpeningCount, 0);
    return {
      availableNowTry: null,
      accountCountTry,
      unknownOpeningCountTry,
      unknownCashAccountCount,
      cashSourceStatus: "LEGACY_UNVERIFIED",
      legacyUnverified: true,
      foreignBuckets,
    };
  }

  let cashSourceStatus: SourceCompletenessStatus;

  if (sawTry && unknownOpeningCountTry > 0) {
    availableNowTry = null;
    cashSourceStatus = "PARTIAL_MISSING_OPENING";
  } else if (sawTry && accountCountTry > 0) {
    if (tryAvailableParsed !== null && Number.isFinite(tryAvailableParsed)) {
      availableNowTry = tryAvailableParsed;
      cashSourceStatus = "COMPLETE";
    } else {
      availableNowTry = null;
      cashSourceStatus = "SOURCE_UNAVAILABLE";
    }
  } else {
    // No TRY row (or accountCountTry <= 0): never fabricate 0 unless 0 active TRY accounts are explicitly proven on intact schema.
    const verifyRes = await db
      .query<{
        active_try_count: number | string | null;
        unknown_try_count: number | string | null;
      }>(
        `select
           count(*)::int as active_try_count,
           count(*) filter (where opening_balance is null)::int as unknown_try_count
         from public.cash_accounts
         where is_active = true
           and archived_at is null
           and coalesce(currency, 'TRY') = 'TRY'`,
      )
      .catch((verifyErr: unknown) => {
        const vCode = (verifyErr as { code?: string })?.code;
        if (vCode === "42P01" || vCode === "42703") {
          if (strictSchema) {
            throw new DomainError(
              "CONFLICT",
              "SCHEMA_INCOMPATIBLE: cash_accounts şeması doğrulanamadı.",
            );
          }
          return { kind: "schema_error" as const, rows: [] };
        }
        return { kind: "unavailable_error" as const, rows: [] };
      });

    if ("kind" in verifyRes && verifyRes.kind === "schema_error") {
      availableNowTry = null;
      cashSourceStatus = "SCHEMA_INCOMPATIBLE";
    } else if (
      ("kind" in verifyRes && verifyRes.kind === "unavailable_error") ||
      !Array.isArray(verifyRes.rows) ||
      verifyRes.rows.length !== 1
    ) {
      availableNowTry = null;
      cashSourceStatus = "SOURCE_UNAVAILABLE";
    } else {
      const vRow = verifyRes.rows[0];
      const hasExplicitCounts =
        vRow != null &&
        Object.prototype.hasOwnProperty.call(vRow, "active_try_count") &&
        Object.prototype.hasOwnProperty.call(vRow, "unknown_try_count");
      const activeTryCount = hasExplicitCounts ? intOrNull(vRow.active_try_count) : null;
      const unknownTryCount = hasExplicitCounts ? intOrNull(vRow.unknown_try_count) : null;

      if (activeTryCount === null || unknownTryCount === null) {
        availableNowTry = null;
        cashSourceStatus = "SOURCE_UNAVAILABLE";
      } else if (activeTryCount === 0 && unknownTryCount === 0) {
        accountCountTry = 0;
        unknownOpeningCountTry = 0;
        availableNowTry = 0;
        cashSourceStatus = "NO_ACTIVE_ACCOUNTS_VERIFIED";
      } else if (unknownTryCount > 0) {
        accountCountTry = Math.max(accountCountTry, activeTryCount);
        unknownOpeningCountTry = unknownTryCount;
        availableNowTry = null;
        cashSourceStatus = "PARTIAL_MISSING_OPENING";
      } else {
        accountCountTry = Math.max(accountCountTry, activeTryCount);
        availableNowTry = null;
        cashSourceStatus = "SOURCE_UNAVAILABLE";
      }
    }
  }

  const unknownCashAccountCount =
    unknownOpeningCountTry +
    foreignBuckets.reduce((sum, b) => sum + b.unknownOpeningCount, 0);

  return {
    availableNowTry,
    accountCountTry,
    unknownOpeningCountTry,
    unknownCashAccountCount,
    cashSourceStatus,
    legacyUnverified: false,
    foreignBuckets,
  };
}

export const loadLiveCashPosition = loadCanonicalTreasuryCashKpi;

export async function loadCanonicalOutflow7dKpi(
  db: DbQueryable,
  todayISO = istanbulDateISO(),
): Promise<CanonicalOutflow7dKpi> {
  const r = await db.query<{
    currency: string | null;
    open_count: number;
    missing_count: number;
    remaining_sum: string | null;
  }>(
    `select
       i.currency,
       count(*)::int as open_count,
       count(*) filter (where i.amount is null)::int as missing_count,
       sum(greatest(i.amount - coalesce(i.paid_amount, 0), 0))
         filter (where i.amount is not null and i.amount > 0)::text as remaining_sum
     from public.payment_instances i
     where i.due_date >= $1::date
       and i.due_date <= ($1::date + 6)
       and i.status in ('unpaid', 'partial', 'planned', 'late')
       and i.status <> 'cancelled'
       and i.cancelled_at is null
     group by i.currency
     order by (i.currency = 'TRY') desc nulls last, i.currency nulls last`,
    [todayISO],
  );

  let tryRemainingTotal = 0;
  let tryOpenCount = 0;
  let totalOpenCount = 0;
  let missingAmountCount = 0;
  const foreignBuckets: CurrencyAmountBucket[] = [];

  for (const row of r.rows) {
    const count = intOrNull(row.open_count) ?? 0;
    const missing = intOrNull(row.missing_count) ?? 0;
    const rem = moneyOrNull(row.remaining_sum) ?? 0;
    totalOpenCount += count;
    missingAmountCount += missing;

    if (row.currency === "TRY") {
      tryRemainingTotal = rem;
      tryOpenCount = count;
    } else if (count > 0) {
      foreignBuckets.push({
        currency: row.currency,
        total: count === missing ? null : rem,
        count,
      });
    }
  }

  return {
    tryRemainingTotal,
    tryOpenCount,
    totalOpenCount,
    missingAmountCount,
    foreignBuckets,
  };
}

export async function loadCanonicalKpis(
  db: DbQueryable,
  todayISO = istanbulDateISO(),
  opts?: CanonicalKpiLoadOptions,
): Promise<CanonicalKpiSnapshot> {
  const [treasuryCash, openReceivables, openPayables, outflow7d] = await gather(db, [
    () => loadCanonicalTreasuryCashKpi(db, opts),
    () => loadCanonicalReceivablesKpi(db),
    () => loadCanonicalPayablesKpi(db),
    () => loadCanonicalOutflow7dKpi(db, todayISO),
  ]);
  return {
    todayISO,
    treasuryCash,
    cashSourceStatus: treasuryCash.cashSourceStatus,
    legacyUnverified: treasuryCash.legacyUnverified,
    openReceivables,
    openPayables,
    outflow7d,
  };
}

