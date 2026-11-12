import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { getPool } from "@/lib/db";
import { loadFinanceDashboard } from "@/lib/financing/engine";
import { loadUnknownOpeningAccountCount } from "@/lib/treasury/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { fmtTL, Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import type { ChartModel } from "@/lib/analytics/chart";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

export default async function FinanceSummaryPage() {
  const denied = await requireRouteAccess("/finance");
  if (denied) return denied;
  const pool = getPool();
  const today = istanbulDateISO();
  const [{ summary, months }, unknownOpening] = await Promise.all([
    loadFinanceDashboard(pool, today),
    loadUnknownOpeningAccountCount(pool),
  ]);
  const monthKeys = [...new Set(months.map((row) => row.monthStart))].sort();
  const debt = monthKeys.slice(0, 6).map((monthStart) => {
    const rows = months.filter((row) => row.monthStart === monthStart);
    return {
      monthStart,
      knownOutflow: rows.filter((row) => row.direction === "outflow").reduce((sum, row) => sum + row.knownAmount, 0),
      count: rows.reduce((sum, row) => sum + row.count, 0),
    };
  });
  const chart: ChartModel = {
    title: "Borç servisi", description: "Çek ve kredi taksitlerinin bugünden ileri aylık bilinen ödeme yükü.",
    asOf: today, timeDirection: "forward", preferredView: "stacked", summaryMode: "sum",
    minimumVisibleSeries: ["check", "loan_installment"], sourceLabel: "Çekler ve kredi taksitleri",
    sourceHref: "/finance/maturities", unknownCount: months.reduce((sum, row) => sum + row.missingCount, 0), annotations: [],
    series: (["check", "loan_installment"] as const).map((kind) => ({
      id: kind, label: kind === "check" ? "Çek" : "Kredi taksiti", tone: kind === "check" ? "warning" : "negative", format: "currency",
      points: monthKeys.map((month) => ({
        key: month.slice(0, 7), label: month.slice(0, 7),
        value: months.filter((row) => row.kind === kind && row.direction === "outflow" && row.monthStart === month)
          .reduce((sum, row) => sum + row.knownAmount, 0),
        href: "/finance/maturities",
      })),
    })),
  };
  return <>
    <PageHeader title="Finansman Özeti" subtitle="Borç servisi, yaklaşan vadeler ve toplam finansman yükü" action={<Link className="button-accent px-3 py-2" href="/scenarios?from=finance">Senaryoda dene</Link>} />
    {unknownOpening.totalUnknown > 0 ? (
      <div
        role="status"
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--line)",
          color: "var(--text-2)",
        }}
        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="amber" dot>FIN-03</Badge>
          <span>{`Açılış bakiyesi tanımsız ${unknownOpening.totalUnknown} aktif hesap var — kullanılabilir nakit yalnız hareketlerden hesaplanıyor (FIN-03).`}</span>
        </div>
        {unknownOpening.byCurrency.length > 0 ? (
          <span className="font-mono text-[11px]">
            {unknownOpening.byCurrency.map((c) => `${c.currency}: ${c.count}`).join(" · ")}
          </span>
        ) : null}
      </div>
    ) : null}
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <KpiCard label="Kalan kredi borcu" value={fmtTL(summary.remainingAmount)} tone="neg" emphasize />
      <KpiCard label="30 günlük ödeme" value={fmtTL(summary.due30)} tone="warn" emphasize />
      <KpiCard label="Açık çek" value={summary.openChecks} />
      <KpiCard label="Aktif kredi" value={summary.activeLoans} />
    </div>
    <AnalyticsChart model={chart} kind="bar" defaultPeriod="12m" />
    <Panel title="Önümüzdeki altı ay borç servisi">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{debt.map((row) => <Link key={row.monthStart} href="/finance/maturities" className="border border-line p-3 hover:border-line-strong"><div className="font-mono text-xs text-tone-3">{row.monthStart.slice(0, 7)}</div><div className="mt-1 font-mono text-sm text-neg">{fmtTL(row.knownOutflow)}</div><div className="text-xs text-tone-3">{row.count} vade</div></Link>)}</div>
    </Panel>
  </>;
}
