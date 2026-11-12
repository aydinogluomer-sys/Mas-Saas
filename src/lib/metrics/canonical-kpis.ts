// Faz 47 (D1) — Kanonik KPI Yükleyicisi (`src/lib/metrics/canonical-kpis.ts`).
//
// Ekranlar arası 4 metrik çelişkisini (sayfalanmış 50/100 satırdan toplam alma,
// `partial` ödemede tam tutar sayma, 2028 projeksiyon kasasını bugünkü nakit sanma,
// yabancı para toplamlarını TRY'ye karıştırma veya yutma) tek kaynaktan sıfırlar.

import type { Pool, PoolClient } from "pg";
import { intOrNull, moneyOrNull } from "@/lib/money";
import { istanbulDateISO } from "@/lib/reports/rules";
import type { CurrencyAmountBucket } from "@/lib/money-format";
import { gather } from "@/lib/pg-concurrency";

type DbQueryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

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
   * `FIN-03`: Herhangi bir aktif TRY hesabının açılış bakiyesi belirsizse (`unknownOpeningCountTry > 0`)
   * `null` döner — uydurma bakiye üretilmez!
   */
  availableNowTry: number | null;
  accountCountTry: number;
  unknownOpeningCountTry: number;
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

export async function loadCanonicalTreasuryCashKpi(db: DbQueryable): Promise<CanonicalTreasuryCashKpi> {
  const r = await db.query<{
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
  ).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42703") {
      return db.query<{
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
      );
    }
    throw err;
  });

  let availableNowTry: number | null = 0;
  let accountCountTry = 0;
  let unknownOpeningCountTry = 0;
  let sawTry = false;
  const foreignBuckets: CanonicalTreasuryCashKpi["foreignBuckets"] = [];

  for (const row of r.rows) {
    const accountCount = intOrNull(row.account_count) ?? 0;
    const unknownCount = intOrNull(row.unknown_opening_count) ?? 0;
    const available = unknownCount > 0 ? null : moneyOrNull(row.available_now);
    if (row.currency === "TRY") {
      sawTry = true;
      accountCountTry = accountCount;
      unknownOpeningCountTry = unknownCount;
      availableNowTry = unknownCount > 0 ? null : (available ?? 0);
    } else {
      foreignBuckets.push({
        currency: row.currency,
        availableNow: available,
        accountCount,
        unknownOpeningCount: unknownCount,
      });
    }
  }

  if (!sawTry) {
    availableNowTry = 0;
  }

  return {
    availableNowTry,
    accountCountTry,
    unknownOpeningCountTry,
    foreignBuckets,
  };
}

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
): Promise<CanonicalKpiSnapshot> {
  const [treasuryCash, openReceivables, openPayables, outflow7d] = await gather(db, [
    () => loadCanonicalTreasuryCashKpi(db),
    () => loadCanonicalReceivablesKpi(db),
    () => loadCanonicalPayablesKpi(db),
    () => loadCanonicalOutflow7dKpi(db, todayISO),
  ]);
  return {
    todayISO,
    treasuryCash,
    openReceivables,
    openPayables,
    outflow7d,
  };
}

