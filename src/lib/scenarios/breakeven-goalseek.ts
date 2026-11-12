/**
 * Faz 55 (F2) — Deterministik Başabaş Kaldıraç Çözücü (`solveBreakevenLevers` / Goal-Seek Engine).
 *
 * Seçilen ufukta (`14d` / `13w` / `12m`) ilk eksi kasa veya kasa tabanı (`minCashFloor`) ihlalini
 * sıfırlamak için tek başına yeterli olan 4 somut kaldıracı deterministik ikili-arama ve
 * kapalı-form `Big` matematiğiyle hesaplar:
 *   ① Tahsilatlarda gereken gün hızlandırması (`-X gün DSO`)
 *   ② İhtiyari (`low`/`normal` öncelikli) giderlerde gereken kesinti yüzdesi ve tutarı (`-%Y`)
 *   ③ Kullanılabilir rotatif kredi limitinden gereken minimum çekim tutarı (`Z TL`)
 *      - Eğer `availableHeadroom < shortfall` ise zorunlu dürüst mesajı üretir:
 *        `"Mevcut kredi limiti açığı tek başına kapatmaya yetmiyor; ek X TL finansman veya gider ertelemesi gerekli"`
 *   ④ Üretim parça başabaş taban fiyatı (`TL/dk`)
 *
 * Tüm bölme işlemlerinde `0`'a bölünme `null` ile korunur; hiçbir yerde `NaN` veya `Infinity` üretilmez.
 * Bu modül `@/lib/ai` veya `@/lib/env` import etmez.
 */

import type { Pool, PoolClient } from "pg";
import { decimal, money, moneyOrNull } from "@/lib/money";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type GoalSeekHorizon = "14d" | "13w" | "12m";

export interface GoalSeekDatedFlow {
  dateISO: string;
  direction: "inflow" | "outflow";
  amount: number;
  isDiscretionary?: boolean;
  label?: string;
}

export interface GoalSeekOpenReceivable {
  invoiceNo?: string;
  dueDate: string;
  amount: number;
}

export interface BreakevenGoalSeekInput {
  horizon: GoalSeekHorizon;
  asOfDate: string;
  currency?: string;
  openingCash: number | null;
  minCashFloor?: number | null;
  flows: ReadonlyArray<GoalSeekDatedFlow>;
  openReceivables: ReadonlyArray<GoalSeekOpenReceivable>;
  availableCreditHeadroom: number;
  productionCostModel?: {
    monthlyTotalCost: number | null;
    effectiveMonthlyMinutes: number | null;
    currentRateTlPerMin?: number | null;
  } | null;
}

export interface BreakevenGoalSeekResult {
  horizon: GoalSeekHorizon;
  asOfDate: string;
  horizonEndDate: string;
  currency: string;
  status: "unknown_opening_balance" | "no_deficit" | "deficit_detected";
  openingCash: number | null;
  targetFloor: number;
  firstBreachDate: string | null;
  worstDate: string | null;
  worstProjectedCash: number | null;
  /** İlk/en derin ihlali hedef tabana (`targetFloor`) çıkarmak için gereken toplam nakit açığı (>= 0) */
  requiredShortfall: number | null;
  levers: {
    /** ① Tahsilat DSO hızlandırma kaldıracı (-X gün) */
    collectionDsoAcceleration: {
      feasible: boolean;
      requiredDaysAcceleration: number | null;
      acceleratedInflowAmount: number;
      totalEligibleFutureReceivables: number;
      summary: string;
    };
    /** ② İhtiyari (low/normal öncelikli) gider kesintisi kaldıracı (-%Y) */
    discretionaryExpenseCut: {
      feasible: boolean;
      requiredCutPct: number | null;
      requiredCutAmount: number;
      discretionaryPoolAmount: number;
      unfundedGapAfterFullCut: number;
      summary: string;
    };
    /** ③ Rotatif kredi çekim kaldıracı (Z TL) */
    revolvingCreditDrawdown: {
      feasible: boolean;
      requiredDrawdownAmount: number;
      availableHeadroom: number;
      additionalFinancingNeeded: number;
      summary: string;
    };
    /** ④ Üretim parça başabaş taban fiyatı (TL/dk) */
    productionFloorRate: {
      baseBreakevenTlPerMin: number | null;
      cashGapAdjustedBreakevenTlPerMin: number | null;
      currentRateTlPerMin: number | null;
      requiredRateIncreaseTlPerMin: number | null;
      effectiveMonthlyMinutes: number | null;
      summary: string;
    };
  };
}

function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function horizonDaysOf(h: GoalSeekHorizon): number {
  if (h === "14d") return 14;
  if (h === "13w") return 91;
  return 365;
}

function fmtPlainTl(amount: number): string {
  return new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Saf (pure) deterministik başabaş kaldıraç çözücüsü (`solveBreakevenLevers`).
 */
export function solveBreakevenLevers(input: BreakevenGoalSeekInput): BreakevenGoalSeekResult {
  const currency = (input.currency ?? "TRY").trim().toUpperCase();
  const hDays = horizonDaysOf(input.horizon);
  const horizonEndDate = addDaysISO(input.asOfDate, hDays);
  const targetFloor = money(decimal(input.minCashFloor ?? 0).toString());

  // 4. Kaldıraç (Üretim TL/dk) baz hesabı açılış bakiyesinden bağımsız olarak da çalışır
  const computeProdLever = (shortfallAmount: number) => {
    const pm = input.productionCostModel;
    const mins = pm?.effectiveMonthlyMinutes ?? null;
    const cost = pm?.monthlyTotalCost ?? null;
    const currRate = pm?.currentRateTlPerMin ?? null;

    if (mins == null || mins <= 0 || cost == null || cost < 0) {
      return {
        baseBreakevenTlPerMin: null,
        cashGapAdjustedBreakevenTlPerMin: null,
        currentRateTlPerMin: currRate,
        requiredRateIncreaseTlPerMin: null,
        effectiveMonthlyMinutes: mins,
        summary: "Etkin aylık dakika veya maliyet modeli verisi eksik olduğu için TL/dk başabaş hesaplanamadı.",
      };
    }

    const minsDec = decimal(mins);
    const costDec = decimal(cost);
    const baseRateDec = costDec.div(minsDec);
    const adjRateDec = costDec.plus(decimal(shortfallAmount)).div(minsDec);

    const baseBreakevenTlPerMin = Number(baseRateDec.toFixed(4));
    const cashGapAdjustedBreakevenTlPerMin = Number(adjRateDec.toFixed(4));
    const requiredRateIncreaseTlPerMin =
      currRate == null
        ? null
        : Number(
            (adjRateDec.gt(decimal(currRate))
              ? adjRateDec.minus(decimal(currRate))
              : decimal(0)
            ).toFixed(4),
          );

    return {
      baseBreakevenTlPerMin,
      cashGapAdjustedBreakevenTlPerMin,
      currentRateTlPerMin: currRate,
      requiredRateIncreaseTlPerMin,
      effectiveMonthlyMinutes: mins,
      summary:
        shortfallAmount > 0
          ? `Maliyet başabaş tabanı ${baseBreakevenTlPerMin.toFixed(2)} TL/dk; nakit açığını kapatacak başabaş tabanı ${cashGapAdjustedBreakevenTlPerMin.toFixed(2)} TL/dk.`
          : `Maliyet başabaş taban fiyatı ${baseBreakevenTlPerMin.toFixed(2)} TL/dk.`,
    };
  };

  if (input.openingCash === null || !Number.isFinite(input.openingCash)) {
    return {
      horizon: input.horizon,
      asOfDate: input.asOfDate,
      horizonEndDate,
      currency,
      status: "unknown_opening_balance",
      openingCash: null,
      targetFloor,
      firstBreachDate: null,
      worstDate: null,
      worstProjectedCash: null,
      requiredShortfall: null,
      levers: {
        collectionDsoAcceleration: {
          feasible: false,
          requiredDaysAcceleration: null,
          acceleratedInflowAmount: 0,
          totalEligibleFutureReceivables: 0,
          summary: "Açılış bakiyesi bilinmediği için tahsilat hızlandırma kaldıracı hesaplanamadı.",
        },
        discretionaryExpenseCut: {
          feasible: false,
          requiredCutPct: null,
          requiredCutAmount: 0,
          discretionaryPoolAmount: 0,
          unfundedGapAfterFullCut: 0,
          summary: "Açılış bakiyesi bilinmediği için gider kesintisi kaldıracı hesaplanamadı.",
        },
        revolvingCreditDrawdown: {
          feasible: false,
          requiredDrawdownAmount: 0,
          availableHeadroom: money(decimal(Math.max(0, input.availableCreditHeadroom)).toString()),
          additionalFinancingNeeded: 0,
          summary: "Açılış bakiyesi bilinmediği için kredi çekim kaldıracı hesaplanamadı.",
        },
        productionFloorRate: computeProdLever(0),
      },
    };
  }

  // Gün bazlı net akışları sırala ve kümülatif bakiye eğrisini oluştur
  const inHorizonFlows = input.flows
    .filter((f) => f.dateISO >= input.asOfDate && f.dateISO <= horizonEndDate && f.amount > 0)
    .sort((a, b) => (a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : 0));

  const distinctDates = Array.from(new Set([input.asOfDate, ...inHorizonFlows.map((f) => f.dateISO)])).sort();
  const targetFloorDec = decimal(targetFloor);
  let runningDec = decimal(input.openingCash);
  let firstBreachDate: string | null = null;
  let worstDate: string = input.asOfDate;
  let worstCashDec = runningDec;

  if (runningDec.lt(targetFloorDec)) {
    firstBreachDate = input.asOfDate;
  }

  for (const dt of distinctDates) {
    const dayFlows = inHorizonFlows.filter((f) => f.dateISO === dt);
    for (const f of dayFlows) {
      const amtDec = decimal(f.amount).abs();
      if (f.direction === "inflow") {
        runningDec = runningDec.plus(amtDec);
      } else {
        runningDec = runningDec.minus(amtDec);
      }
    }
    if (runningDec.lt(targetFloorDec) && firstBreachDate === null) {
      firstBreachDate = dt;
    }
    if (runningDec.lt(worstCashDec)) {
      worstCashDec = runningDec;
      worstDate = dt;
    }
  }

  const worstProjectedCash = money(worstCashDec.toString());
  const shortfallDec = worstCashDec.lt(targetFloorDec)
    ? targetFloorDec.minus(worstCashDec)
    : decimal(0);
  const requiredShortfall = money(shortfallDec.toString());
  const availHeadroomDec = decimal(Math.max(0, input.availableCreditHeadroom));
  const availHeadroom = money(availHeadroomDec.toString());

  if (shortfallDec.lte(0)) {
    return {
      horizon: input.horizon,
      asOfDate: input.asOfDate,
      horizonEndDate,
      currency,
      status: "no_deficit",
      openingCash: input.openingCash,
      targetFloor,
      firstBreachDate: null,
      worstDate,
      worstProjectedCash,
      requiredShortfall: 0,
      levers: {
        collectionDsoAcceleration: {
          feasible: true,
          requiredDaysAcceleration: 0,
          acceleratedInflowAmount: 0,
          totalEligibleFutureReceivables: 0,
          summary: "Seçilen ufukta nakit açığı veya taban ihlali yok (0 gün hızlandırma).",
        },
        discretionaryExpenseCut: {
          feasible: true,
          requiredCutPct: 0,
          requiredCutAmount: 0,
          discretionaryPoolAmount: 0,
          unfundedGapAfterFullCut: 0,
          summary: "Seçilen ufukta nakit açığı yok (%0 gider kesintisi).",
        },
        revolvingCreditDrawdown: {
          feasible: true,
          requiredDrawdownAmount: 0,
          availableHeadroom: availHeadroom,
          additionalFinancingNeeded: 0,
          summary: "Seçilen ufukta kredi çekim ihtiyacı yok (0,00 TL).",
        },
        productionFloorRate: computeProdLever(0),
      },
    };
  }

  const cutoffDate = worstDate;

  // ① Tahsilat DSO Hızlandırma Kaldıracı (Binary Search 1..180 gün)
  // `cutoffDate` sonrasında vadesi gelen açık alacakları X gün öne çektiğimizde `dueDate - X <= cutoffDate` olanların toplamı
  const futureReceivables = input.openReceivables.filter(
    (r) => r.dueDate > cutoffDate && r.amount > 0,
  );
  let totalFutureArDec = decimal(0);
  for (const r of futureReceivables) {
    totalFutureArDec = totalFutureArDec.plus(decimal(r.amount));
  }
  const totalEligibleFutureReceivables = money(totalFutureArDec.toString());

  const acceleratedSumForDays = (days: number) => {
    let acc = decimal(0);
    for (const r of futureReceivables) {
      const shiftedDate = addDaysISO(r.dueDate, -days);
      if (shiftedDate <= cutoffDate) {
        acc = acc.plus(decimal(r.amount));
      }
    }
    return acc;
  };

  let dsoFeasible = false;
  let requiredDaysAcceleration: number | null = null;
  let acceleratedInflowAmount = 0;

  if (acceleratedSumForDays(180).gte(shortfallDec)) {
    let lo = 1;
    let hi = 180;
    let best = 180;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (acceleratedSumForDays(mid).gte(shortfallDec)) {
        best = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    dsoFeasible = true;
    requiredDaysAcceleration = best;
    acceleratedInflowAmount = money(acceleratedSumForDays(best).toString());
  } else {
    dsoFeasible = false;
    requiredDaysAcceleration = null;
    acceleratedInflowAmount = totalEligibleFutureReceivables;
  }

  const dsoSummary = dsoFeasible
    ? `Tahsilatları -${requiredDaysAcceleration} gün DSO hızlandırmak (${fmtPlainTl(acceleratedInflowAmount)} TL öne çekim) açığı tek başına kapatır.`
    : `Gelecek vadeli tüm açık alacakların (${fmtPlainTl(totalEligibleFutureReceivables)} TL) öne çekilmesi ${fmtPlainTl(requiredShortfall)} TL açığı tek başına kapatmaya yetmiyor.`;

  // ② İhtiyari (low/normal öncelikli) Gider Kesintisi Kaldıracı
  let discPoolDec = decimal(0);
  for (const f of inHorizonFlows) {
    if (f.direction === "outflow" && f.isDiscretionary && f.dateISO <= cutoffDate) {
      discPoolDec = discPoolDec.plus(decimal(f.amount).abs());
    }
  }
  const discretionaryPoolAmount = money(discPoolDec.toString());

  let discFeasible = false;
  let requiredCutPct: number | null = null;
  let requiredCutAmount = 0;
  let unfundedGapAfterFullCut = 0;

  if (discPoolDec.lte(0)) {
    discFeasible = false;
    requiredCutPct = null;
    requiredCutAmount = 0;
    unfundedGapAfterFullCut = requiredShortfall;
  } else if (discPoolDec.gte(shortfallDec)) {
    discFeasible = true;
    requiredCutPct = Number(shortfallDec.div(discPoolDec).times(100).toFixed(2));
    requiredCutAmount = requiredShortfall;
    unfundedGapAfterFullCut = 0;
  } else {
    discFeasible = false;
    requiredCutPct = 100;
    requiredCutAmount = discretionaryPoolAmount;
    unfundedGapAfterFullCut = money(shortfallDec.minus(discPoolDec).toString());
  }

  const discSummary = discFeasible
    ? `İhtiyari giderlerde -%${requiredCutPct?.toFixed(2)} kesinti (${fmtPlainTl(requiredCutAmount)} TL) açığı tek başına kapatır.`
    : discPoolDec.lte(0)
      ? `Darboğaz tarihine kadar kesilebilecek ihtiyari (düşük/normal öncelikli) gider bulunmuyor (${fmtPlainTl(requiredShortfall)} TL açık).`
      : `İhtiyari giderlerin tamamı (%100 = ${fmtPlainTl(discretionaryPoolAmount)} TL) kesilse dahi ek ${fmtPlainTl(unfundedGapAfterFullCut)} TL açık kalıyor.`;

  // ③ Rotatif Kredi Çekim Kaldıracı (Zorunlu dürüst mesaj kuralı — implementation.md:915)
  const creditFeasible = availHeadroomDec.gte(shortfallDec);
  const additionalFinancingNeeded = creditFeasible
    ? 0
    : money(shortfallDec.minus(availHeadroomDec).toString());

  const creditSummary = creditFeasible
    ? `Kullanılabilir rotatif kredi limitinden ${fmtPlainTl(requiredShortfall)} TL çekim (${fmtPlainTl(availHeadroom)} TL kullanılabilir boşluk içinden) açığı tek başına kapatır.`
    : `Mevcut kredi limiti açığı tek başına kapatmaya yetmiyor; ek ${fmtPlainTl(additionalFinancingNeeded)} TL finansman veya gider ertelemesi gerekli`;

  return {
    horizon: input.horizon,
    asOfDate: input.asOfDate,
    horizonEndDate,
    currency,
    status: "deficit_detected",
    openingCash: input.openingCash,
    targetFloor,
    firstBreachDate,
    worstDate,
    worstProjectedCash,
    requiredShortfall,
    levers: {
      collectionDsoAcceleration: {
        feasible: dsoFeasible,
        requiredDaysAcceleration,
        acceleratedInflowAmount,
        totalEligibleFutureReceivables,
        summary: dsoSummary,
      },
      discretionaryExpenseCut: {
        feasible: discFeasible,
        requiredCutPct,
        requiredCutAmount,
        discretionaryPoolAmount,
        unfundedGapAfterFullCut,
        summary: discSummary,
      },
      revolvingCreditDrawdown: {
        feasible: creditFeasible,
        requiredDrawdownAmount: requiredShortfall,
        availableHeadroom: availHeadroom,
        additionalFinancingNeeded,
        summary: creditSummary,
      },
      productionFloorRate: computeProdLever(requiredShortfall),
    },
  };
}

/**
 * Veritabanından canlı nakit pozisyonu, asgari kasa tabanı, planlı/fatura/çek/kredi akışları,
 * rotatif kredi boşluğu ve üretim maliyet modelini okuyup `solveBreakevenLevers` çalıştırır.
 */
export async function loadAndSolveBreakevenLevers(
  client: Queryable,
  options: {
    horizon?: GoalSeekHorizon;
    asOfDate?: string;
    currency?: string;
  } = {},
): Promise<BreakevenGoalSeekResult> {
  const horizon = options.horizon ?? "13w";
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const currency = (options.currency ?? "TRY").trim().toUpperCase();
  const horizonEnd = addDaysISO(asOfDate, horizonDaysOf(horizon));
  const arHorizonEnd = addDaysISO(horizonEnd, 180);

  const { gather } = await import("@/lib/pg-concurrency");
  const [posRes, floorRes, facRes, costRes, arRes, flowsRes] = await gather(client, [
    () => client.query<{ available_now: string | null; unknown_opening_count: number | string }>(
      `select available_now, unknown_opening_count
         from public.treasury_position_summary
        where currency = $1`,
      [currency],
    ).catch((err: unknown) => {
      const code = (err as { code?: string })?.code;
      if (code === "42703") {
        return client.query<{ available_now: string | null; unknown_opening_count: number | string }>(
          `select available_now, 0::int as unknown_opening_count
             from public.treasury_position_summary
            where currency = $1`,
          [currency],
        );
      }
      throw err;
    }),
    () => client.query<{ threshold_amount: string | null }>(
      `select threshold_amount
         from public.treasury_policies
        where policy_kind = 'min_cash'
          and is_active
          and cash_account_id is null
          and currency = $1
        limit 1`,
      [currency],
    ),
    () => client.query<{ available: string }>(
      `select coalesce(sum(available_amount), 0)::numeric(14,2) as available
         from public.credit_facility_utilization
        where status = 'active'
          and currency = $1`,
      [currency],
    ).catch((err: unknown) => {
      const code = (err as { code?: string })?.code;
      if (code === "42P01" || code === "42703") {
        return { rows: [{ available: "0.00" }], rowCount: 1 };
      }
      throw err;
    }),
    () => client.query<{
      break_even_tl_per_min: string | null;
      effective_monthly_minutes: string | null;
    }>(
      `select break_even_tl_per_min::text, effective_monthly_minutes::text
         from public.cost_models
        order by created_at desc
        limit 1`,
    ),
    () => client.query<{
      invoice_no: string;
      due_date: string;
      open_amount: string;
    }>(
      `select
         v.invoice_no,
         to_char(v.due_date, 'YYYY-MM-DD') as due_date,
         (v.gross_amount - coalesce(v.allocated_amount, 0))::numeric(14,2) as open_amount
       from public.invoices v
       where v.direction = 'sales'
         and v.status in ('open', 'partial')
         and v.bad_debt_at is null
         and v.currency = $1
         and v.due_date is not null
         and v.due_date >= $2::date
         and v.due_date <= $3::date
         and v.gross_amount > coalesce(v.allocated_amount, 0)
       order by v.due_date, v.id`,
      [currency, asOfDate, arHorizonEnd],
    ),
    () => client.query<{
      flow_date: string;
      direction: "inflow" | "outflow";
      amount: string;
      is_discretionary: boolean;
      label: string;
    }>(
      `select * from (
         select
           to_char(pi.due_date, 'YYYY-MM-DD') as flow_date,
           case when coalesce(pi.direction, 'outflow') = 'inflow' then 'inflow' else 'outflow' end as direction,
           greatest(0, case when pi.status = 'partial' then pi.amount - coalesce(pi.paid_amount, 0) else pi.amount end)::numeric(14,2) as amount,
           (coalesce(p.priority, 'normal') in ('low', 'normal')) as is_discretionary,
           coalesce(p.name, 'Planlı Ödeme') as label
         from public.payment_instances pi
         left join public.payments p on p.id = pi.payment_id
         where pi.status in ('planned', 'unpaid', 'partial', 'late')
           and (p.id is null or (p.status = 'active' and p.archived_at is null))
           and coalesce(pi.direction, 'outflow') <> 'transfer'
           and pi.currency = $1
           and pi.due_date between $2::date and $3::date
           and pi.amount is not null

         union all

         select
           to_char(v.due_date, 'YYYY-MM-DD') as flow_date,
           case when v.direction = 'sales' then 'inflow' else 'outflow' end as direction,
           (v.gross_amount - coalesce(v.allocated_amount, 0))::numeric(14,2) as amount,
           (v.direction = 'purchase') as is_discretionary,
           ('Fatura ' || v.invoice_no) as label
         from public.invoices v
         where v.status in ('open', 'partial')
           and v.bad_debt_at is null
           and v.currency = $1
           and v.due_date between $2::date and $3::date
           and v.gross_amount > coalesce(v.allocated_amount, 0)
           and v.settled_by_check_id is null

         union all

         select
           to_char(c.maturity_date, 'YYYY-MM-DD') as flow_date,
           case when c.direction = 'inflow' then 'inflow' else 'outflow' end as direction,
           abs(c.amount)::numeric(14,2) as amount,
           false as is_discretionary,
           ('Çek/Senet ' || coalesce(c.counterparty_label, '')) as label
         from public.checks c
         where c.archived_at is null
           and c.status in ('planned', 'in_portfolio', 'in_bank_collection', 'issued_to_vendor')
           and c.currency = $1
           and c.maturity_date between $2::date and $3::date
           and c.amount > 0

         union all

         select
           to_char(li.due_date, 'YYYY-MM-DD') as flow_date,
           'outflow'::text as direction,
           li.amount::numeric(14,2) as amount,
           false as is_discretionary,
           (coalesce(l.name, 'Kredi') || ' Taksit') as label
         from public.loan_installments li
         join public.loans l on l.id = li.loan_id
         where l.archived_at is null
           and li.status in ('planned', 'unpaid', 'partial', 'late')
           and l.currency = $1
           and li.due_date between $2::date and $3::date
           and li.amount > 0
       ) q
       order by flow_date, direction`,
      [currency, asOfDate, horizonEnd],
    ).catch((err: unknown) => {
      const code = (err as { code?: string })?.code;
      if (code === "42703") {
        return client.query<{
          flow_date: string;
          direction: "inflow" | "outflow";
          amount: string;
          is_discretionary: boolean;
          label: string;
        }>(
          `select * from (
             select
               to_char(pi.due_date, 'YYYY-MM-DD') as flow_date,
               case when coalesce(pi.direction, 'outflow') = 'inflow' then 'inflow' else 'outflow' end as direction,
               greatest(0, case when pi.status = 'partial' then pi.amount - coalesce(pi.paid_amount, 0) else pi.amount end)::numeric(14,2) as amount,
               (coalesce(p.priority, 'normal') in ('low', 'normal')) as is_discretionary,
               coalesce(p.name, 'Planlı Ödeme') as label
             from public.payment_instances pi
             left join public.payments p on p.id = pi.payment_id
             where pi.status in ('planned', 'unpaid', 'partial', 'late')
               and (p.id is null or (p.status = 'active' and p.archived_at is null))
               and coalesce(pi.direction, 'outflow') <> 'transfer'
               and pi.currency = $1
               and pi.due_date between $2::date and $3::date
               and pi.amount is not null

             union all

             select
               to_char(v.due_date, 'YYYY-MM-DD') as flow_date,
               case when v.direction = 'sales' then 'inflow' else 'outflow' end as direction,
               (v.gross_amount - coalesce(v.allocated_amount, 0))::numeric(14,2) as amount,
               (v.direction = 'purchase') as is_discretionary,
               ('Fatura ' || v.invoice_no) as label
             from public.invoices v
             where v.status in ('open', 'partial')
               and v.bad_debt_at is null
               and v.currency = $1
               and v.due_date between $2::date and $3::date
               and v.gross_amount > coalesce(v.allocated_amount, 0)

             union all

             select
               to_char(c.maturity_date, 'YYYY-MM-DD') as flow_date,
               case when c.direction = 'inflow' then 'inflow' else 'outflow' end as direction,
               abs(c.amount)::numeric(14,2) as amount,
               false as is_discretionary,
               ('Çek/Senet ' || coalesce(c.counterparty_label, '')) as label
             from public.checks c
             where c.archived_at is null
               and c.status in ('planned', 'in_portfolio', 'in_bank_collection', 'issued_to_vendor')
               and ($1 = 'TRY')
               and c.maturity_date between $2::date and $3::date
               and c.amount > 0

             union all

             select
               to_char(li.due_date, 'YYYY-MM-DD') as flow_date,
               'outflow'::text as direction,
               li.amount::numeric(14,2) as amount,
               false as is_discretionary,
               (coalesce(l.name, 'Kredi') || ' Taksit') as label
             from public.loan_installments li
             join public.loans l on l.id = li.loan_id
             where l.archived_at is null
               and li.status in ('planned', 'unpaid', 'partial', 'late')
               and ($1 = 'TRY')
               and li.due_date between $2::date and $3::date
               and li.amount > 0
           ) q
           order by flow_date, direction`,
          [currency, asOfDate, horizonEnd],
        );
      }
      throw err;
    }),
  ]);

  const posRow = posRes.rows[0];
  const unknownOpeningCount = posRes.rowCount === 0 ? 0 : Number(posRow?.unknown_opening_count ?? 0);
  const openingCash: number | null =
    posRes.rowCount === 0
      ? 0
      : unknownOpeningCount > 0
        ? null
        : moneyOrNull(posRow?.available_now) ?? 0;

  const minCashFloor = floorRes.rowCount ? moneyOrNull(floorRes.rows[0]?.threshold_amount) : 0;
  const availableCreditHeadroom = moneyOrNull(facRes.rows[0]?.available) ?? 0;

  const costRow = costRes.rows[0];
  const effMins = costRow?.effective_monthly_minutes ? Number(costRow.effective_monthly_minutes) : null;
  const breakEvenRate = costRow?.break_even_tl_per_min ? Number(costRow.break_even_tl_per_min) : null;
  const monthlyTotalCost =
    effMins != null && effMins > 0 && breakEvenRate != null
      ? money(decimal(effMins).times(decimal(breakEvenRate)).toString())
      : null;

  return solveBreakevenLevers({
    horizon,
    asOfDate,
    currency,
    openingCash,
    minCashFloor,
    flows: flowsRes.rows.map((r) => ({
      dateISO: r.flow_date,
      direction: r.direction === "inflow" ? "inflow" : "outflow",
      amount: moneyOrNull(r.amount) ?? 0,
      isDiscretionary: Boolean(r.is_discretionary),
      label: r.label,
    })),
    openReceivables: arRes.rows.map((r) => ({
      invoiceNo: r.invoice_no,
      dueDate: r.due_date,
      amount: moneyOrNull(r.open_amount) ?? 0,
    })),
    availableCreditHeadroom,
    productionCostModel:
      monthlyTotalCost != null && effMins != null
        ? {
            monthlyTotalCost,
            effectiveMonthlyMinutes: effMins,
            currentRateTlPerMin: breakEvenRate,
          }
        : null,
  });
}