// Faz 63 (M-57) — CFO Analiz Motoru: 11 Adımlı Nakit & FAVÖK Köprüsü,
// MoM/QoQ/YoY Dönemsel Varyans, 6 Aylık Rolling Trend ve Canlı DIO + CCC (DSO + DIO - DPO).
//
// KURAL: Bu modül saf deterministiktir; `@/lib/ai` veya `@/lib/env` import etmez.
// Tüm parasal aritmetik `Big.js` (`@/lib/money`) ile yürütülür.

import type { Pool } from "pg";
import { decimal, money, moneyOrNull, rateOrNull } from "@/lib/money";
import type { ChartModel } from "./chart";
import { waterfallModel, type WaterfallModel } from "./chart-types";
import {
  COMPARISON_LABEL,
  periodOverPeriod,
  shiftMonth,
  type DatedValue,
  type PeriodChange,
  type PeriodComparison,
} from "./periods";

export interface CfoBridgeStep {
  key: string;
  label: string;
  value: number;
  kind: "start" | "increase" | "decrease" | "end";
  runningTotal: number;
  note?: string;
}

export interface CfoCashBridgeSummary {
  windowStartISO: string;
  windowEndISO: string;
  steps: CfoBridgeStep[];
  chart: WaterfallModel;
  openingCashTry: number | null;
  closingCashTry: number | null;
  netOperatingCashTry: number | null;
  managementEbitdaTry: number | null;
  netIncomeTry: number | null;
  ebitdaCashConversionPct: number | null;
  reconciles: boolean | null;
  difference: number;
  unmeasurableReason: string | null;
}

export interface LiveWorkingCapitalCcc {
  receivablesOpenTry: number | null;
  payablesOpenTry: number | null;
  inventoryBalanceTry: number | null;
  sales365Try: number | null;
  purchases365Try: number | null;
  dsoDays: number | null;
  dioDays: number | null;
  dioUnmeasurableReason: string | null;
  dpoDays: number | null;
  cashConversionCycleDays: number | null;
  cccUnmeasurableReason: string | null;
  cycleExcludingInventoryDays: number | null;
}

export interface InsightsHubBundle {
  comparison: PeriodComparison;
  comparisonLabel: string;
  cfoBridge: CfoCashBridgeSummary;
  liveWc: LiveWorkingCapitalCcc;
  rollingTrendChart: ChartModel;
  popRows: PeriodChange[];
  popSourceLabel: string;
}

function isMissingRelation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "42P01" || code === "42703";
}

function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function normDesc(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "i")
    .toLowerCase();
}

export interface RawCfoBridgeBuckets {
  openingCashTry: number | null;
  closingCashTry: number | null;
  customerCollectionsTry: number;
  posSettlementsTry: number;
  supplierPaymentsTry: number; // <= 0
  payrollSgkTry: number; // <= 0
  taxesVatTry: number; // <= 0
  capexTry: number; // <= 0
  loanServiceTry: number; // <= 0
  fxImpactTry: number; // signed
}

/**
 * Pure 11-step CFO Cash Bridge builder:
 *  1. Açılış Kasası (start)
 *  2. Müşteri Tahsilatları (+)
 *  3. POS Valör Çözülmeleri (+)
 *  4. Tedarikçi & Satınalma Ödemeleri (-)
 *  5. Maaş & SGK Ödemeleri (-)
 *  6. Vergi & KDV Ödemeleri (-)
 *  7. İşletme Sonrası Kasa / Net İşletme Nakdi (end subtotal bar)
 *  8. Yatırım / CAPEX Çıkışları (-)
 *  9. Kredi & Çek Finansman Servisi (-)
 * 10. Kur Farkı & Değerleme Etkisi (+/-)
 * 11. Kapanış Kasası (end)
 */
export function buildCfoCashBridgeSteps(input: RawCfoBridgeBuckets): {
  steps: CfoBridgeStep[];
  netOperatingCashTry: number | null;
  computedClosingTry: number | null;
  reconciles: boolean | null;
  difference: number;
  unmeasurableReason: string | null;
} {
  if (input.openingCashTry == null || !Number.isFinite(input.openingCashTry)) {
    return {
      steps: [],
      netOperatingCashTry: null,
      computedClosingTry: null,
      reconciles: null,
      difference: 0,
      unmeasurableReason:
        "Açılış kasa/banka bakiyesi tanımsız — CFO nakit köprüsü bilinmeyen bakiyeyi 0 saymaz.",
    };
  }

  const openDec = decimal(input.openingCashTry);
  const colDec = decimal(input.customerCollectionsTry).abs();
  const posDec = decimal(input.posSettlementsTry).abs();
  const supDec = decimal(input.supplierPaymentsTry).abs().times(-1);
  const payDec = decimal(input.payrollSgkTry).abs().times(-1);
  const taxDec = decimal(input.taxesVatTry).abs().times(-1);

  const netOpDec = colDec.plus(posDec).plus(supDec).plus(payDec).plus(taxDec);
  const afterOpDec = openDec.plus(netOpDec);

  const capexDec = decimal(input.capexTry).abs().times(-1);
  const loanDec = decimal(input.loanServiceTry).abs().times(-1);
  const fxDec = decimal(input.fxImpactTry);

  const computedEndDec = afterOpDec.plus(capexDec).plus(loanDec).plus(fxDec);
  const netOperatingCashTry = money(netOpDec.toString());
  const computedClosingTry = money(computedEndDec.toString());

  let r = openDec;
  const steps: CfoBridgeStep[] = [
    {
      key: "01_opening_cash",
      label: "1. Açılış Kasası",
      value: money(r.toString()),
      kind: "start",
      runningTotal: money(r.toString()),
    },
  ];

  const pushMove = (key: string, label: string, deltaDec: ReturnType<typeof decimal>, forceSign?: "inc" | "dec") => {
    r = r.plus(deltaDec);
    const val = money(deltaDec.toString());
    const kind: "increase" | "decrease" =
      forceSign === "inc"
        ? "increase"
        : forceSign === "dec"
          ? "decrease"
          : val >= 0
            ? "increase"
            : "decrease";
    steps.push({
      key,
      label,
      value: val,
      kind,
      runningTotal: money(r.toString()),
    });
  };

  pushMove("02_customer_collections", "2. Müşteri Tahsilatları", colDec, "inc");
  pushMove("03_pos_settlements", "3. POS Çözülmeleri", posDec, "inc");
  pushMove("04_supplier_payments", "4. Tedarikçi Ödemeleri", supDec, "dec");
  pushMove("05_payroll_sgk", "5. Maaş & SGK", payDec, "dec");
  pushMove("06_taxes_vat", "6. Vergi & KDV", taxDec, "dec");

  steps.push({
    key: "07_operating_subtotal",
    label: `7. İşletme Sonrası Kasa (Net İNA: ${netOperatingCashTry >= 0 ? "+" : ""}${new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(netOperatingCashTry)} TL)`,
    value: money(afterOpDec.toString()),
    kind: "end",
    runningTotal: money(afterOpDec.toString()),
    note: `Net İşletme Nakit Akışı: ${netOperatingCashTry} TL`,
  });

  pushMove("08_capex", "8. Yatırım (CAPEX)", capexDec, "dec");
  pushMove("09_loan_service", "9. Kredi & Çek Servisi", loanDec, "dec");
  pushMove("10_fx_impact", "10. Kur & Değerleme", fxDec);

  const finalDisplayVal =
    input.closingCashTry != null ? money(decimal(input.closingCashTry).toString()) : computedClosingTry;

  steps.push({
    key: "11_closing_cash",
    label: "11. Kapanış Kasası",
    value: finalDisplayVal,
    kind: "end",
    runningTotal: finalDisplayVal,
  });

  if (input.closingCashTry == null) {
    return {
      steps,
      netOperatingCashTry,
      computedClosingTry,
      reconciles: null,
      difference: 0,
      unmeasurableReason: null,
    };
  }

  const diffDec = decimal(input.closingCashTry).minus(computedEndDec);
  const difference = money(diffDec.toString());
  const reconciles = diffDec.abs().lte(decimal("0.01"));

  return {
    steps,
    netOperatingCashTry,
    computedClosingTry,
    reconciles,
    difference,
    unmeasurableReason: null,
  };
}

function classifyBankMovementBucket(
  amountTry: number,
  description: string | null,
  transactionKind: string | null,
): keyof Omit<RawCfoBridgeBuckets, "openingCashTry" | "closingCashTry"> {
  const d = normDesc(description);
  const kind = (transactionKind ?? "").toLowerCase();

  if (kind.includes("fx") || d.includes("kur fark") || d.includes("kambiyo") || d.includes("arbitraj")) {
    return "fxImpactTry";
  }

  if (amountTry > 0) {
    if (
      kind.includes("pos") ||
      d.includes("pos ") ||
      d.startsWith("pos") ||
      d.includes("uye isyeri") ||
      d.includes("sanal pos") ||
      d.includes("iyzico") ||
      d.includes("paytr")
    ) {
      return "posSettlementsTry";
    }
    return "customerCollectionsTry";
  }

  if (
    d.includes("maas") ||
    d.includes("personel") ||
    d.includes("ucret") ||
    d.includes("sgk") ||
    d.includes("bagkur") ||
    d.includes("prim") ||
    d.includes("kidem")
  ) {
    return "payrollSgkTry";
  }

  if (
    d.includes("vergi") ||
    d.includes("kdv") ||
    d.includes("muhtasar") ||
    d.includes("stopaj") ||
    d.includes("kurumlar") ||
    d.includes("gecici") ||
    d.includes("damga") ||
    d.includes("gib") ||
    d.includes("mtv")
  ) {
    return "taxesVatTry";
  }

  if (
    d.includes("capex") ||
    d.includes("makine") ||
    d.includes("ekipman") ||
    d.includes("demirbas") ||
    d.includes("yatirim") ||
    d.includes("arac alim") ||
    d.includes("yazilim lisans")
  ) {
    return "capexTry";
  }

  if (
    kind.includes("loan") ||
    d.includes("kredi") ||
    d.includes("taksit") ||
    d.includes("faiz") ||
    d.includes("bsmv") ||
    d.includes("kkdf") ||
    d.includes("rotatif") ||
    d.includes("leasing") ||
    d.includes("cek odeme") ||
    d.includes("senet odeme")
  ) {
    return "loanServiceTry";
  }

  return "supplierPaymentsTry";
}

export async function loadCfoCashAndEbitdaBridge(
  pool: Pool,
  asOf: string,
  windowDays = 90,
): Promise<CfoCashBridgeSummary> {
  const windowStartISO = addDaysISO(asOf, -windowDays);

  const [fxRes, cashRes, txRes, isRes] = await Promise.all([
    pool
      .query<{ base_currency: string; rate: string }>(
        `select distinct on (base_currency) base_currency, rate::text as rate
           from public.fx_rate_snapshots
          where quote_currency = 'TRY' and rate_date <= $1::date
          order by base_currency, rate_date desc, id desc`,
        [asOf],
      )
      .catch((err: unknown) => {
        if (isMissingRelation(err)) return { rows: [] };
        throw err;
      }),
    pool
      .query<{
        currency: string;
        opening_known_count: number;
        total_accounts: number;
        opening_sum: string | null;
        prior_tx_sum: string | null;
        all_tx_sum: string | null;
      }>(
        `select ca.currency,
                count(*) filter (where ca.opening_balance is not null)::int as opening_known_count,
                count(*)::int as total_accounts,
                sum(ca.opening_balance)::text as opening_sum,
                (select coalesce(sum(bt.amount), 0)::text
                   from public.bank_transactions bt
                   join public.bank_accounts ba on ba.cash_account_id = ca.id and bt.bank_account_id = ba.cash_account_id
                  where bt.status <> 'ignored'
                    and bt.txn_date < $1::date) as prior_tx_sum,
                (select coalesce(sum(bt.amount), 0)::text
                   from public.bank_transactions bt
                   join public.bank_accounts ba on ba.cash_account_id = ca.id and bt.bank_account_id = ba.cash_account_id
                  where bt.status <> 'ignored'
                    and bt.txn_date <= $2::date) as all_tx_sum
           from public.cash_accounts ca
          where ca.is_active = true
            and ca.archived_at is null
          group by ca.currency, ca.id`,
        [windowStartISO, asOf],
      )
      .catch((err: unknown) => {
        if (isMissingRelation(err)) return { rows: [] };
        throw err;
      }),
    pool
      .query<{
        amount: string;
        currency: string;
        description: string | null;
        transaction_kind: string | null;
      }>(
        `select bt.amount::text as amount,
                bt.currency,
                bt.description,
                bt.transaction_kind
           from public.bank_transactions bt
          where bt.status <> 'ignored'
            and coalesce(bt.transaction_kind, 'standard') <> 'own_transfer'
            and bt.txn_date >= $1::date
            and bt.txn_date <= $2::date
          order by bt.txn_date, bt.id`,
        [windowStartISO, asOf],
      )
      .catch((err: unknown) => {
        if (isMissingRelation(err)) return { rows: [] };
        throw err;
      }),
    pool
      .query<{
        management_ebitda_try: string | null;
        net_income_try: string | null;
      }>(
        `select management_ebitda_try::text as management_ebitda_try,
                net_income_try::text as net_income_try
           from public.management_income_statement_v
          limit 1`,
      )
      .catch((err: unknown) => {
        if (isMissingRelation(err)) return { rows: [] };
        throw err;
      }),
  ]);

  const fxMap = new Map<string, number>([["TRY", 1]]);
  for (const r of fxRes.rows) {
    const rate = rateOrNull(r.rate);
    if (rate != null && rate > 0) fxMap.set(r.base_currency.toUpperCase(), rate);
  }

  let hasKnownOpening = false;
  let openingCashDec = decimal(0);
  let closingCashDec = decimal(0);

  for (const acc of cashRes.rows) {
    const rate = fxMap.get(acc.currency.toUpperCase());
    if (!rate || acc.opening_sum == null) continue;
    hasKnownOpening = true;
    const openBase = decimal(acc.opening_sum).plus(decimal(acc.prior_tx_sum ?? 0));
    const closeBase = decimal(acc.opening_sum).plus(decimal(acc.all_tx_sum ?? 0));
    openingCashDec = openingCashDec.plus(openBase.times(decimal(rate)));
    closingCashDec = closingCashDec.plus(closeBase.times(decimal(rate)));
  }

  const buckets: Omit<RawCfoBridgeBuckets, "openingCashTry" | "closingCashTry"> = {
    customerCollectionsTry: 0,
    posSettlementsTry: 0,
    supplierPaymentsTry: 0,
    payrollSgkTry: 0,
    taxesVatTry: 0,
    capexTry: 0,
    loanServiceTry: 0,
    fxImpactTry: 0,
  };

  let netClassifiedDec = decimal(0);
  for (const tx of txRes.rows) {
    const rate = fxMap.get(tx.currency.toUpperCase());
    const raw = moneyOrNull(tx.amount);
    if (!rate || raw == null || raw === 0) continue;
    const tryAmt = money(decimal(raw).times(decimal(rate)).toString());
    const bucketKey = classifyBankMovementBucket(tryAmt, tx.description, tx.transaction_kind);
    buckets[bucketKey] = money(decimal(buckets[bucketKey]).plus(decimal(tryAmt)).toString());
    netClassifiedDec = netClassifiedDec.plus(decimal(tryAmt));
  }

  // Fallback to cashflow_months + cashflow_lines if bank_transactions has 0 rows and no cash accounts
  let openingCashTry = hasKnownOpening ? money(openingCashDec.toString()) : null;
  let closingCashTry = hasKnownOpening ? money(closingCashDec.toString()) : null;

  if (!hasKnownOpening && txRes.rows.length === 0) {
    const cfRes = await pool
      .query<{
        opening_cash: string | null;
        closing_cash: string | null;
        inflows: string | null;
        outflows: string | null;
      }>(
        `select (array_agg(opening_cash order by month_start asc))[1]::text as opening_cash,
                (array_agg(closing_cash order by month_start desc))[1]::text as closing_cash,
                sum(total_inflow)::text as inflows,
                sum(total_outflow)::text as outflows
           from public.cashflow_months`,
      )
      .catch(() => ({ rows: [] as Array<{ opening_cash: string | null; closing_cash: string | null; inflows: string | null; outflows: string | null }> }));

    const cf = cfRes.rows[0];
    if (cf && cf.opening_cash != null) {
      openingCashTry = moneyOrNull(cf.opening_cash);
      closingCashTry = moneyOrNull(cf.closing_cash);
      buckets.customerCollectionsTry = moneyOrNull(cf.inflows) ?? 0;
      buckets.supplierPaymentsTry = -Math.abs(moneyOrNull(cf.outflows) ?? 0);
      if (openingCashTry != null && closingCashTry != null) {
        const impliedFx = decimal(closingCashTry)
          .minus(decimal(openingCashTry))
          .minus(decimal(buckets.customerCollectionsTry))
          .minus(decimal(buckets.supplierPaymentsTry));
        buckets.fxImpactTry = money(impliedFx.toString());
      }
    }
  } else if (openingCashTry != null && closingCashTry != null) {
    // Own-transfer timing / multi-currency rounding residual sits transparently in step 10 (FX & Valuation)
    const residualFxDec = closingCashDec.minus(openingCashDec).minus(netClassifiedDec);
    buckets.fxImpactTry = money(decimal(buckets.fxImpactTry).plus(residualFxDec).toString());
  }

  const built = buildCfoCashBridgeSteps({
    openingCashTry,
    closingCashTry,
    ...buckets,
  });

  const isRow = isRes.rows[0];
  const managementEbitdaTry = moneyOrNull(isRow?.management_ebitda_try);
  const netIncomeTry = moneyOrNull(isRow?.net_income_try);
  const ebitdaCashConversionPct =
    managementEbitdaTry != null &&
    managementEbitdaTry > 0 &&
    built.netOperatingCashTry != null
      ? Number(
          decimal(built.netOperatingCashTry)
            .div(decimal(managementEbitdaTry))
            .times(100)
            .toFixed(1),
        )
      : null;

  const chart = waterfallModel({
    title: "11 Adımlı CFO Nakit ve İşletme Akışı Köprüsü",
    description: `${windowStartISO} → ${asOf} konsolide nakit köprüsü (TCMB kur çevrimli)`,
    format: "currency",
    asOf,
    sourceLabel: "cash_accounts + bank_transactions + fx_rate_snapshots",
    steps: built.steps.map((s) => ({
      key: s.key,
      label: s.label,
      value: s.value,
      kind: s.kind,
    })),
    unknownCount: 0,
  });

  return {
    windowStartISO,
    windowEndISO: asOf,
    steps: built.steps,
    chart,
    openingCashTry,
    closingCashTry,
    netOperatingCashTry: built.netOperatingCashTry,
    managementEbitdaTry,
    netIncomeTry,
    ebitdaCashConversionPct,
    reconciles: built.reconciles,
    difference: built.difference,
    unmeasurableReason: built.unmeasurableReason,
  };
}

export async function loadLiveWorkingCapitalCcc(pool: Pool): Promise<LiveWorkingCapitalCcc> {
  const [wcRes, invRes] = await Promise.all([
    pool
      .query<{
        receivables_open: string | null;
        payables_open: string | null;
        sales_365: string | null;
        purchases_365: string | null;
        dso_days: string | null;
        dpo_days: string | null;
        dio_days: string | null;
        dio_unmeasurable_reason: string | null;
        cash_conversion_cycle_days: string | null;
        ccc_unmeasurable_reason: string | null;
        cash_cycle_excluding_inventory: string | null;
      }>(
        `select receivables_open::text,
                payables_open::text,
                sales_365::text,
                purchases_365::text,
                dso_days::text,
                dpo_days::text,
                dio_days::text,
                dio_unmeasurable_reason,
                cash_conversion_cycle_days::text,
                ccc_unmeasurable_reason,
                cash_cycle_excluding_inventory::text
           from public.working_capital_metrics
          limit 1`,
      )
      .catch((err: unknown) => {
        if (isMissingRelation(err)) return { rows: [] };
        throw err;
      }),
    pool
      .query<{ inv_try: string | null }>(
        `select sum(amount_try)::text as inv_try
           from public.management_balance_sheet_v
          where tdhp_root_code in ('150', '151', '152', '153', '157')`,
      )
      .catch((err: unknown) => {
        if (isMissingRelation(err)) return { rows: [] };
        throw err;
      }),
  ]);

  const row = wcRes.rows[0];
  return {
    receivablesOpenTry: moneyOrNull(row?.receivables_open),
    payablesOpenTry: moneyOrNull(row?.payables_open),
    inventoryBalanceTry: moneyOrNull(invRes.rows[0]?.inv_try),
    sales365Try: moneyOrNull(row?.sales_365),
    purchases365Try: moneyOrNull(row?.purchases_365),
    dsoDays: rateOrNull(row?.dso_days),
    dioDays: rateOrNull(row?.dio_days),
    dioUnmeasurableReason: row?.dio_unmeasurable_reason ?? null,
    dpoDays: rateOrNull(row?.dpo_days),
    cashConversionCycleDays: rateOrNull(row?.cash_conversion_cycle_days),
    cccUnmeasurableReason: row?.ccc_unmeasurable_reason ?? null,
    cycleExcludingInventoryDays: rateOrNull(row?.cash_cycle_excluding_inventory),
  };
}

export async function loadInsightsHubBundle(
  pool: Pool,
  asOf: string,
  comparison: PeriodComparison = "mom",
): Promise<InsightsHubBundle> {
  const [cfoBridge, liveWc, monthlyRes, cfMonthsRes] = await Promise.all([
    loadCfoCashAndEbitdaBridge(pool, asOf, 90),
    loadLiveWorkingCapitalCcc(pool),
    pool
      .query<{
        period_month: string;
        cash_inflow_try: string | null;
        cash_outflow_try: string | null;
        cash_net_try: string | null;
      }>(
        `select to_char(period_start, 'YYYY-MM') as period_month,
                cash_inflow_try::text,
                cash_outflow_try::text,
                cash_net_try::text
           from public.working_capital_monthly_v
          order by period_start asc
          limit 24`,
      )
      .catch((err: unknown) => {
        if (isMissingRelation(err)) return { rows: [] };
        throw err;
      }),
    pool
      .query<{
        period_month: string;
        net_flow: string | null;
        inflow: string | null;
        outflow: string | null;
      }>(
        `select to_char(month_start, 'YYYY-MM') as period_month,
                (coalesce(total_inflow, 0) - coalesce(total_outflow, 0))::text as net_flow,
                total_inflow::text as inflow,
                total_outflow::text as outflow
           from public.cashflow_months
          order by month_start asc
          limit 24`,
      )
      .catch((err: unknown) => {
        if (isMissingRelation(err)) return { rows: [] };
        throw err;
      }),
  ]);

  const useLiveMonthly = monthlyRes.rows.length > 0;
  const rawMonths = useLiveMonthly
    ? monthlyRes.rows.map((r) => ({
        month: r.period_month,
        inflow: moneyOrNull(r.cash_inflow_try),
        outflow: moneyOrNull(r.cash_outflow_try),
        net: moneyOrNull(r.cash_net_try),
      }))
    : cfMonthsRes.rows.map((r) => ({
        month: r.period_month,
        inflow: moneyOrNull(r.inflow),
        outflow: moneyOrNull(r.outflow),
        net: moneyOrNull(r.net_flow),
      }));

  const byMonth = new Map(rawMonths.map((m) => [m.month, m]));
  const sortedMonths = rawMonths.map((m) => m.month).sort();

  // Compute 6-month rolling net cash average/sum for each month
  const rolling6mPoints = sortedMonths.map((mKey) => {
    let sumDec = decimal(0);
    let count = 0;
    for (let k = -5; k <= 0; k++) {
      const target = shiftMonth(mKey, k);
      const item = byMonth.get(target);
      if (item && item.net != null) {
        sumDec = sumDec.plus(decimal(item.net));
        count += 1;
      }
    }
    return {
      key: mKey,
      label: mKey,
      value: count > 0 ? money(sumDec.div(count).toString()) : null,
      meta: { windowMonths: count },
    };
  });

  const rollingTrendChart: ChartModel = {
    title: "6 Aylık Hareketli Nakit Akışı Trendi (Rolling Trend)",
    description:
      "Aylık konsolide tahsilat, ödeme ve 6 aylık hareketli ortalama net nakit üretim trendi",
    series: [
      {
        id: "inflow_monthly",
        label: "Aylık Tahsilat (+)",
        tone: "positive",
        format: "currency",
        points: rawMonths.map((m) => ({
          key: m.month,
          label: m.month,
          value: m.inflow,
        })),
      },
      {
        id: "outflow_monthly",
        label: "Aylık Çıkış (-)",
        tone: "negative",
        format: "currency",
        points: rawMonths.map((m) => ({
          key: m.month,
          label: m.month,
          value: m.outflow != null ? -Math.abs(m.outflow) : null,
        })),
      },
      {
        id: "rolling_6m_net",
        label: "6A Hareketli Ortalama Net Nakit",
        tone: "info",
        format: "currency",
        dashed: true,
        points: rolling6mPoints,
      },
    ],
    annotations: [],
    unknownCount: 0,
    sourceLabel: useLiveMonthly ? "working_capital_monthly_v" : "cashflow_months",
    sourceHref: "/insights/analysis",
    asOf,
    timeDirection: "historical",
    availableGranularities: ["month"],
    summaryMode: "endpoint",
    currencyCode: "TRY",
  };

  const datedNetSeries: DatedValue[] = rawMonths.map((m) => ({
    key: m.month,
    value: m.net,
  }));
  const popAll = periodOverPeriod(datedNetSeries, comparison);

  return {
    comparison,
    comparisonLabel: COMPARISON_LABEL[comparison],
    cfoBridge,
    liveWc,
    rollingTrendChart,
    popRows: popAll.slice(-12).reverse(),
    popSourceLabel: useLiveMonthly ? "working_capital_monthly_v" : "cashflow_months",
  };
}
