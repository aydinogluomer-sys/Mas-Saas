import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import {
  AgingBucketsBarSvg,
  EditorialDonutChartSvg,
  type AgingBucketItem,
  type DonutSlice,
} from "@/components/charts/editorial-cockpit-charts";
import { fmtTL, Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import type { ChartModel } from "@/lib/analytics/chart";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { loadFinanceDashboard } from "@/lib/financing/engine";
import { loadLatestTryFxRateMap } from "@/lib/financing/fx-consolidation";
import { isMissingSchemaError } from "@/lib/ledger/accounts";
import { decimal, intOrNull, money, moneyOrNull, rateOrNull } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";
import { istanbulDateISO } from "@/lib/reports/rules";
import { loadUnknownOpeningAccountCount } from "@/lib/treasury/engine";

export const dynamic = "force-dynamic";

function forwardSixMonthStarts(todayISO: string): string[] {
  const [yStr, mStr] = todayISO.split("-");
  const baseYear = Number(yStr);
  const baseMonthZero = Number(mStr) - 1;
  return Array.from({ length: 6 }, (_, idx) => {
    const totalM = baseYear * 12 + baseMonthZero + idx;
    const y = Math.floor(totalM / 12);
    const m = (totalM % 12) + 1;
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
  });
}

function compactCenterTry(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000_000) {
    const mr = decimal(abs).div(1_000_000_000).round(1).toFixed(1).replace(".", ",");
    return `${sign}${mr} Mr TL`;
  }
  if (abs >= 100_000_000) {
    const mn = decimal(abs).div(1_000_000).round(1).toFixed(1).replace(".", ",");
    return `${sign}${mn} Mn TL`;
  }
  return fmtTL(amount);
}

export default async function FinanceSummaryPage() {
  const denied = await requireRouteAccess("/finance");
  if (denied) return denied;
  const pool = getPool();
  const today = istanbulDateISO();
  const [{ summary, months }, unknownOpening, wcRes, liveWcRes, facilitiesRes, covenantsRes, fxMap] =
    await Promise.all([
      loadFinanceDashboard(pool, today),
      loadUnknownOpeningAccountCount(pool),
      pool.query<{
        ym: string;
        period_start: string;
        receivables_open: string;
        payables_open: string;
        net_working_capital_ex_inventory: string;
        dso_days: string | null;
        dpo_days: string | null;
        dio_days: string | null;
        cash_cycle_excluding_inventory: string | null;
        cash_inflow_try: string;
        cash_outflow_try: string;
        cash_net_try: string;
        foreign_invoice_count: number;
        foreign_cash_tx_count: number;
      }>(
        `select to_char(period_start, 'YYYY-MM') as ym,
                to_char(period_start, 'YYYY-MM-DD') as period_start,
                receivables_open::text,
                payables_open::text,
                net_working_capital_ex_inventory::text,
                dso_days::text,
                dpo_days::text,
                dio_days::text,
                cash_cycle_excluding_inventory::text,
                cash_inflow_try::text,
                cash_outflow_try::text,
                cash_net_try::text,
                foreign_invoice_count,
                foreign_cash_tx_count
           from public.working_capital_monthly_v
          order by period_start desc
          limit 12`,
      ),
      pool
        .query<{
          dso_days: string | null;
          dpo_days: string | null;
          dio_days: string | null;
          cash_conversion_cycle_days: string | null;
        }>(
          `select dso_days::text,
                  dpo_days::text,
                  dio_days::text,
                  cash_conversion_cycle_days::text
             from public.working_capital_metrics
            limit 1`,
        )
        .catch((err: unknown) => {
          if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
          throw err;
        }),
      pool
        .query<{
          currency: string;
          status: string;
          limit_amount: string;
          drawn_amount: string;
          available_amount: string;
        }>(
          `select currency,
                  status,
                  limit_amount::text,
                  drawn_amount::text,
                  available_amount::text
             from public.credit_facility_utilization
            where status = 'active'`,
        )
        .catch((err: unknown) => {
          if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
          throw err;
        }),
      pool
        .query<{
          status: string;
          last_test_result: string | null;
        }>(
          `select status, last_test_result
             from public.covenant_records
            where status = 'active'`,
        )
        .catch((err: unknown) => {
          if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
          throw err;
        }),
      loadLatestTryFxRateMap(pool, today).catch(() => new Map()),
    ]);

  const liveWc = liveWcRes.rows[0] ?? null;
  const liveDsoDays = rateOrNull(liveWc?.dso_days);
  const liveDpoDays = rateOrNull(liveWc?.dpo_days);
  const liveDioDays = rateOrNull(liveWc?.dio_days);
  const liveCccDays = rateOrNull(liveWc?.cash_conversion_cycle_days);

  const workingCapitalRows = wcRes.rows.map((r) => {
    const dso = rateOrNull(r.dso_days);
    const dpo = rateOrNull(r.dpo_days);
    const dio = rateOrNull(r.dio_days) ?? liveDioDays;
    const cccExInv = rateOrNull(r.cash_cycle_excluding_inventory);
    const fullCcc =
      dio != null && dso != null && dpo != null
        ? Number(decimal(dio).plus(dso).minus(dpo).round(1).toFixed(1))
        : cccExInv;
    return {
      ym: r.ym,
      periodStart: r.period_start,
      receivablesOpen: moneyOrNull(r.receivables_open) ?? 0,
      payablesOpen: moneyOrNull(r.payables_open) ?? 0,
      netWorkingCapital: moneyOrNull(r.net_working_capital_ex_inventory) ?? 0,
      dsoDays: dso,
      dpoDays: dpo,
      dioDays: dio,
      cccExInventory: cccExInv,
      fullCccDays: fullCcc,
      cashInflowTry: moneyOrNull(r.cash_inflow_try) ?? 0,
      cashOutflowTry: moneyOrNull(r.cash_outflow_try) ?? 0,
      cashNetTry: moneyOrNull(r.cash_net_try) ?? 0,
      foreignInvoiceCount: intOrNull(r.foreign_invoice_count) ?? 0,
      foreignCashTxCount: intOrNull(r.foreign_cash_tx_count) ?? 0,
    };
  });

  const forwardMonths6 = forwardSixMonthStarts(today);
  const rawMonthKeys = [...new Set(months.map((row) => row.monthStart))].sort();
  const chartMonthKeys = rawMonthKeys.length > 0 ? rawMonthKeys : forwardMonths6;
  const sixMonthKeys =
    rawMonthKeys.length >= 6
      ? rawMonthKeys.slice(0, 6)
      : [...new Set([...rawMonthKeys, ...forwardMonths6])].sort().slice(0, 6);

  const debt = sixMonthKeys.map((monthStart) => {
    const rows = months.filter(
      (row) => row.monthStart === monthStart && row.direction === "outflow",
    );
    const outflowDec = rows.reduce((acc, row) => acc.plus(row.knownAmount), decimal(0));
    return {
      monthStart,
      knownOutflow: money(outflowDec),
      count: rows.reduce((sum, row) => sum + row.count, 0),
    };
  });

  const maxSixMonthOutflow = debt.reduce(
    (mx, row) => (row.knownOutflow > mx ? row.knownOutflow : mx),
    0,
  );
  const sixMonthTotalTry = money(
    debt.reduce((acc, row) => acc.plus(row.knownOutflow), decimal(0)),
  );

  const maturityBuckets: AgingBucketItem[] = debt.map((row, idx) => ({
    key: `mat-${row.monthStart}`,
    label: row.monthStart.slice(0, 7),
    amount: row.knownOutflow,
    formattedAmount: fmtTL(row.knownOutflow),
    count: row.count,
    tone:
      row.knownOutflow <= 0
        ? "pos"
        : maxSixMonthOutflow > 0 && row.knownOutflow === maxSixMonthOutflow
          ? "neg"
          : idx === 0
            ? "warn"
            : "info",
  }));

  const chart: ChartModel = {
    title: "Borç servisi (Konsolide TRY Karşılığı)",
    description:
      "Çek ve kredi taksitlerinin bugünden ileri aylık bilinen ödeme yükü (yabancı paralar TCMB son kuru ile konsolide edilir).",
    asOf: today,
    timeDirection: "forward",
    preferredView: "stacked",
    summaryMode: "sum",
    minimumVisibleSeries: ["check", "loan_installment"],
    sourceLabel: "Çekler ve kredi taksitleri",
    sourceHref: "/finance/maturities",
    unknownCount: months.reduce((sum, row) => sum + row.missingCount + (row.missingFxCount ?? 0), 0),
    annotations: [],
    series: (["check", "loan_installment"] as const).map((kind) => ({
      id: kind,
      label: kind === "check" ? "Çek / Senet" : "Kredi taksiti",
      tone: kind === "check" ? "warning" : "negative",
      format: "currency",
      points: chartMonthKeys.map((month) => ({
        key: month.slice(0, 7),
        label: month.slice(0, 7),
        value: money(
          months
            .filter((row) => row.kind === kind && row.direction === "outflow" && row.monthStart === month)
            .reduce((acc, row) => acc.plus(row.knownAmount), decimal(0)),
        ),
        href: "/finance/maturities",
      })),
    })),
  };

  const fxRemBreakdown = summary.remainingByCurrency
    .filter((c) => c.currency !== "TRY")
    .map((c) => formatMoney(c.nativeAmount, c.currency))
    .join(" · ");
  const due30FxBreakdown = summary.due30ByCurrency
    .filter((c) => c.currency !== "TRY")
    .map((c) => formatMoney(c.nativeAmount, c.currency))
    .join(" · ");

  const latestWc = workingCapitalRows[0] ?? null;
  const checkOutflowTotal = months
    .filter((r) => r.kind === "check" && r.direction === "outflow")
    .reduce((acc, r) => acc.plus(r.knownAmount), decimal(0));
  const checkOutflowTry = money(checkOutflowTotal);

  const arOpenVal = latestWc ? latestWc.receivablesOpen : 0;
  const apOpenVal = latestWc ? latestWc.payablesOpen : 0;
  const portfolioTotalTry = money(
    decimal(arOpenVal)
      .plus(apOpenVal)
      .plus(checkOutflowTry)
      .plus(summary.remainingConsolidatedTry),
  );

  const portfolioSlices: DonutSlice[] = [
    {
      key: "ar-open",
      label: "Açık Alacak",
      value: arOpenVal,
      formattedValue: latestWc ? fmtTL(arOpenVal) : "—",
      sublabel: latestWc ? `${latestWc.ym} dönemi` : "Dönem verisi bekleniyor",
      tone: "pos",
    },
    {
      key: "ap-open",
      label: "Açık Ticari Borç",
      value: apOpenVal,
      formattedValue: latestWc ? fmtTL(apOpenVal) : "—",
      sublabel: latestWc ? `${latestWc.ym} dönemi` : "Dönem verisi bekleniyor",
      tone: "warn",
    },
    {
      key: "checks-open",
      label: "Vadeli Çek/Senet",
      value: checkOutflowTry,
      formattedValue: fmtTL(checkOutflowTry),
      sublabel: `${summary.openChecks} açık çek/senet`,
      tone: "accent",
    },
    {
      key: "loans-remaining",
      label: "Kalan Kredi Borcu",
      value: summary.remainingConsolidatedTry,
      formattedValue: fmtTL(summary.remainingConsolidatedTry),
      sublabel: `${summary.activeLoans} aktif kredi`,
      tone: "neg",
    },
  ];

  // Kredi Limit Kullanımı vs Boşluk (Headroom) — Konsolide TRY (Asla 1:1 toplanmaz)
  let drawnTryTotal = decimal(0);
  let headroomTryTotal = decimal(0);
  let missingFacilityFxCount = 0;
  for (const fac of facilitiesRes.rows) {
    const ccy = (fac.currency || "TRY").toUpperCase();
    const fxInfo = ccy === "TRY" ? { rate: 1 } : fxMap.get(ccy);
    if (!fxInfo || !(fxInfo.rate > 0)) {
      missingFacilityFxCount += 1;
      continue;
    }
    const drawnNative = moneyOrNull(fac.drawn_amount);
    const availNative = moneyOrNull(fac.available_amount);
    if (drawnNative != null && drawnNative > 0) {
      drawnTryTotal = drawnTryTotal.plus(decimal(drawnNative).times(fxInfo.rate));
    }
    if (availNative != null && availNative > 0) {
      headroomTryTotal = headroomTryTotal.plus(decimal(availNative).times(fxInfo.rate));
    }
  }
  const drawnTry = money(drawnTryTotal);
  const headroomTry = money(headroomTryTotal);

  // İşletme Sermayesi Köprüsü (DIO + DSO − DPO = CCC) & Kovenant Sağlığı
  const bridgeDio = liveDioDays ?? latestWc?.dioDays ?? null;
  const bridgeDso = liveDsoDays ?? latestWc?.dsoDays ?? null;
  const bridgeDpo = liveDpoDays ?? latestWc?.dpoDays ?? null;
  const bridgeCcc = liveCccDays ?? latestWc?.fullCccDays ?? null;

  const cccNoteParts: string[] = [];
  if (bridgeCcc != null) cccNoteParts.push(`CCC ${bridgeCcc.toFixed(1)}g`);
  if (bridgeDso != null) cccNoteParts.push(`DSO ${bridgeDso.toFixed(1)}g`);
  if (bridgeDpo != null) cccNoteParts.push(`DPO ${bridgeDpo.toFixed(1)}g`);
  const cccConciseNote =
    cccNoteParts.length > 0
      ? cccNoteParts.join(" · ")
      : bridgeDio != null
        ? `DIO ${bridgeDio.toFixed(1)}g · DSO/DPO bekleniyor`
        : "CCC / DSO / DPO verisi bekleniyor";

  const testedCovenants = covenantsRes.rows.filter(
    (c) =>
      c.last_test_result === "compliant" ||
      c.last_test_result === "breached" ||
      c.last_test_result === "waived",
  );
  const compliantCovenantCount = testedCovenants.filter(
    (c) => c.last_test_result === "compliant" || c.last_test_result === "waived",
  ).length;
  const covenantCompliancePct =
    testedCovenants.length > 0
      ? Number(
          decimal(compliantCovenantCount)
            .times(100)
            .div(testedCovenants.length)
            .round(1)
            .toFixed(1),
        )
      : null;

  return (
    <>
      <PageHeader
        title="Finansman Özeti"
        subtitle="Çoklu döviz konsolide borç servisi (TCMB son kur), yaklaşan vadeler ve canlı DIO/DSO/DPO işletme sermayesi çevrimi"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link className="button-ghost px-3 py-1.5 text-xs" href="/finance/exposure">
              Konsantrasyon &amp; Risk Matrisi
            </Link>
            <Link className="button-accent px-3 py-1.5 text-xs" href="/scenarios?from=finance">
              13H Senaryoda Dene
            </Link>
          </div>
        }
      />

      {unknownOpening.totalUnknown > 0 ? (
        <div
          role="status"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            color: "var(--text-2)",
          }}
          className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="amber" dot>
              FIN-03
            </Badge>
            <span>{`Açılış bakiyesi tanımsız ${unknownOpening.totalUnknown} aktif hesap var — kullanılabilir nakit yalnız hareketlerden hesaplanıyor.`}</span>
          </div>
          {unknownOpening.byCurrency.length > 0 ? (
            <span className="font-mono text-[11px]">
              {unknownOpening.byCurrency.map((c) => `${c.currency}: ${c.count}`).join(" · ")}
            </span>
          ) : null}
        </div>
      ) : null}

      {summary.missingFxCurrencies.length > 0 ? (
        <div
          role="status"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--warn)",
            color: "var(--text-1)",
          }}
          className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="amber" dot>
              TCMB Kuru Bekleniyor
            </Badge>
            <span>
              {`TCMB kuru bulunamayan dövizler (${summary.missingFxCurrencies.join(", ")}) konsolide TRY toplamına 1:1 eklenmedi.`}
            </span>
          </div>
          <Link href="/finance/fx" className="button-ghost px-2 py-1 text-[11px]">
            Kur gir / güncelle
          </Link>
        </div>
      ) : null}

      {/* Row 1: Compact 4-Card KPI Row — crisp, non-truncating titles */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Kalan Kredi Borcu"
          value={fmtTL(summary.remainingConsolidatedTry)}
          note={
            fxRemBreakdown
              ? `Konsolide TRY · ${fmtTL(summary.remainingAmount)} saf TRY · ${fxRemBreakdown}`
              : `Konsolide TRY · ${fmtTL(summary.remainingAmount)} saf TRY`
          }
          tone="neg"
          emphasize
          href="/finance/loans"
        />
        <KpiCard
          label="30 Günlük Borç Servisi"
          value={fmtTL(summary.due30ConsolidatedTry)}
          note={
            due30FxBreakdown
              ? `Yaklaşan çek + kredi taksiti · ${due30FxBreakdown}`
              : "Yaklaşan çek + kredi taksiti"
          }
          tone="warn"
          emphasize
          href="/finance/maturities"
        />
        <KpiCard
          label="Açık Çek & Senet"
          value={`${summary.openChecks} adet`}
          note={`Vadeli çıkış yükü: ${fmtTL(checkOutflowTry)}`}
          tone={summary.openChecks > 0 ? "info" : "neutral"}
          href="/finance/checks"
        />
        <KpiCard
          label="Aktif Kredi & İşletme Çevrimi"
          value={`${summary.activeLoans} aktif kredi`}
          note={cccConciseNote}
          tone={bridgeCcc != null && bridgeCcc > 60 ? "warn" : "neutral"}
        />
      </div>

      {/* Row 2: HERO VISUAL COCKPIT ON SCREEN #1 */}
      <div className="grid gap-3.5 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-7">
          <AnalyticsChart model={chart} kind="bar" defaultPeriod="12m" height={295} />
        </div>

        <div className="min-w-0 xl:col-span-5">
          <Panel
            title="Hazine & Yükümlülük Portföy Dağılımı"
            subtitle="Alacak, borç, çek ve kredi ağırlıkları ile 6 aylık vade profili (Konsolide TRY)"
            right={
              <Link
                href="/finance/maturities"
                className="text-[11px] font-semibold text-info hover:underline"
              >
                Vade Merdiveni →
              </Link>
            }
          >
            <div className="space-y-3.5">
              <EditorialDonutChartSvg
                size={142}
                slices={portfolioSlices}
                centerLabel="PORTFÖY HACMİ"
                centerValue={compactCenterTry(portfolioTotalTry)}
                centerSubtext={
                  summary.remainingByCurrency.length > 1
                    ? `${summary.remainingByCurrency.length} döviz konsolide`
                    : "Konsolide TRY"
                }
                ariaLabel="Hazine ve yükümlülük portföy dağılımı: açık alacak, açık ticari borç, vadeli çek/senet ve kalan kredi borcu"
              />

              <div className="border-t border-line-faint pt-3">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-tone-3">
                    6 Aylık Borç Servisi Vade Sütunları
                  </span>
                  <span className="tnum font-mono text-[11px] font-semibold text-tone-2">
                    6A Toplam: {fmtTL(sixMonthTotalTry)}
                  </span>
                </div>
                <AgingBucketsBarSvg
                  buckets={maturityBuckets}
                  ariaLabel="Önümüzdeki 6 aylık konsolide TRY borç servisi vade dağılımı"
                />
              </div>
            </div>
          </Panel>
        </div>
      </div>

      {/* Row 3: Compact 1-Row Credit Limit / Covenant / CCC Summary Strip */}
      <section
        aria-label="Kredi limiti, kovenant uyumu ve nakit çevrim özeti"
        className="command-surface grid grid-cols-1 gap-3 border px-3.5 py-2.5 md:grid-cols-3 md:divide-x"
        style={{
          borderColor: "var(--line-card)",
          borderRadius: "var(--radius-md)",
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="min-w-0">
            <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-tone-3">
              Kredi Limit &amp; Headroom
            </div>
            {facilitiesRes.rows.length > 0 ? (
              <div className="tnum mt-0.5 text-[12px] text-tone-1">
                Kullanılan: <strong className="font-semibold text-warn">{fmtTL(drawnTry)}</strong> ·
                Boşluk: <strong className="font-semibold text-pos">{fmtTL(headroomTry)}</strong>
                {missingFacilityFxCount > 0 ? (
                  <span className="ml-1 text-[11px] text-warn">
                    ({missingFacilityFxCount} YP kur bekliyor)
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="mt-0.5 text-[12px] text-tone-3">
                Aktif banka kredi limiti tanımlanmadı
              </div>
            )}
          </div>
          <Link
            href="/finance/facilities"
            className="shrink-0 font-mono text-[11px] font-semibold text-info hover:underline"
          >
            {facilitiesRes.rows.length > 0 ? "Limit Masası →" : "Limit Tanımla →"}
          </Link>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs md:pl-3.5">
          <div className="min-w-0">
            <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-tone-3">
              Aktif Kovenant Sağlığı
            </div>
            {testedCovenants.length > 0 && covenantCompliancePct != null ? (
              <div className="tnum mt-0.5 flex items-center gap-2 text-[12px] text-tone-1">
                <strong
                  className={
                    covenantCompliancePct >= 90 ? "font-semibold text-pos" : "font-semibold text-warn"
                  }
                >
                  %{covenantCompliancePct.toFixed(1)} uyumlu
                </strong>
                <span className="text-tone-3">
                  ({compliantCovenantCount}/{testedCovenants.length} rasyo)
                </span>
              </div>
            ) : (
              <div className="mt-0.5 text-[12px] text-tone-3">
                {covenantsRes.rows.length > 0
                  ? `${covenantsRes.rows.length} aktif kovenant · Test bekleniyor`
                  : "Kovenant rasyosu tanımlanmadı"}
              </div>
            )}
          </div>
          <Link
            href="/finance/facilities"
            className="shrink-0 font-mono text-[11px] font-semibold text-info hover:underline"
          >
            {covenantsRes.rows.length > 0 ? "Rasyoları Gör →" : "Limit Tanımla →"}
          </Link>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs md:pl-3.5">
          <div className="min-w-0">
            <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-tone-3">
              İşletme Çevrimi (DIO + DSO − DPO)
            </div>
            <div className="tnum mt-0.5 text-[12px] text-tone-1">
              <span>DIO: {bridgeDio != null ? `${bridgeDio.toFixed(1)}g` : "—"}</span>
              {" · "}
              <span>DSO: {bridgeDso != null ? `${bridgeDso.toFixed(1)}g` : "—"}</span>
              {" · "}
              <span>DPO: {bridgeDpo != null ? `${bridgeDpo.toFixed(1)}g` : "—"}</span>
              {" · "}
              <strong
                className={
                  bridgeCcc != null && bridgeCcc > 60 ? "font-semibold text-warn" : "font-semibold"
                }
              >
                CCC: {bridgeCcc != null ? `${bridgeCcc.toFixed(1)}g` : "—"}
              </strong>
            </div>
          </div>
          {bridgeDio == null ? (
            <Link
              href="/production?tab=inventory"
              className="shrink-0 font-mono text-[11px] font-semibold text-info hover:underline"
            >
              Stok Gir →
            </Link>
          ) : (
            <Link
              href="/finance/receivables"
              className="shrink-0 font-mono text-[11px] font-semibold text-info hover:underline"
            >
              Alacaklar →
            </Link>
          )}
        </div>
      </section>

      <Panel
        title="Aylık İşletme Sermayesi & Nakit Çevrim Süresi (DIO + DSO − DPO = CCC)"
        subtitle="Aylık açık alacak/borç, 150/151/152 stok devir süresi (DIO) ve tam nakit çevrim süresi (TRY bazında; dövizli işlem adedi ayrıca gösterilir)"
        right={
          <Link
            href="/finance/maturities"
            className="text-xs font-medium text-info hover:underline"
          >
            6 Aylık Vade Detayı →
          </Link>
        }
      >
        {workingCapitalRows.length === 0 ? (
          <p className="py-2 text-sm" style={{ color: "var(--text-2)" }}>
            Henüz aylık işletme sermayesi verisi oluşmadı.
          </p>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1.5">Dönem</th>
                  <th className="text-right">Açık Alacak</th>
                  <th className="text-right">Açık Borç</th>
                  <th className="text-right">Net İşletme Sermayesi</th>
                  <th className="text-right">DIO (Stok)</th>
                  <th className="text-right">DSO (Alacak)</th>
                  <th className="text-right">DPO (Borç)</th>
                  <th className="text-right">CCC (Tam Çevrim)</th>
                  <th className="text-right">Nakit Net (TRY)</th>
                  <th className="text-right">Dövizli Kayıt</th>
                </tr>
              </thead>
              <tbody>
                {workingCapitalRows.map((wc) => (
                  <tr
                    key={wc.periodStart}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-1.5 font-mono font-medium">{wc.ym}</td>
                    <td className="text-right font-mono tabular-nums text-pos">
                      {fmtTL(wc.receivablesOpen)}
                    </td>
                    <td className="text-right font-mono tabular-nums text-neg">
                      {fmtTL(wc.payablesOpen)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {fmtTL(wc.netWorkingCapital)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {wc.dioDays == null ? "—" : `${wc.dioDays.toFixed(1)}g`}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {wc.dsoDays == null ? "—" : `${wc.dsoDays.toFixed(1)}g`}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {wc.dpoDays == null ? "—" : `${wc.dpoDays.toFixed(1)}g`}
                    </td>
                    <td
                      className={`text-right font-mono font-semibold tabular-nums ${
                        wc.fullCccDays != null && wc.fullCccDays > 45 ? "text-warn" : ""
                      }`}
                    >
                      {wc.fullCccDays == null ? "—" : `${wc.fullCccDays.toFixed(1)}g`}
                    </td>
                    <td
                      className={`text-right font-mono tabular-nums ${
                        wc.cashNetTry < 0 ? "text-neg" : wc.cashNetTry > 0 ? "text-pos" : ""
                      }`}
                    >
                      {fmtTL(wc.cashNetTry)}
                    </td>
                    <td className="text-right font-mono text-[11px]" style={{ color: "var(--text-2)" }}>
                      {wc.foreignInvoiceCount + wc.foreignCashTxCount > 0
                        ? `${wc.foreignInvoiceCount}f · ${wc.foreignCashTxCount}h`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>
    </>
  );
}
