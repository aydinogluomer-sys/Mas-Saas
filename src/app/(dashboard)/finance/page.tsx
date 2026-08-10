import Link from "next/link";
import { getPool } from "@/lib/db";
import { loadChecks, loadLoans, loadMaturityItems } from "@/lib/financing/engine";
import { debtServiceByMonth, maturityWindows } from "@/lib/financing/rules";
import { istanbulDateISO } from "@/lib/reports/rules";
import { fmtTL, Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { debtServiceModel } from "@/lib/analytics/models";

export const dynamic = "force-dynamic";

export default async function FinanceSummaryPage() {
  const pool = getPool();
  const today = istanbulDateISO();
  const [checks, loans, maturities] = await Promise.all([loadChecks(pool), loadLoans(pool), loadMaturityItems(pool)]);
  const window30 = maturityWindows(maturities, today, [30])[0];
  const debt = debtServiceByMonth(maturities).filter((row)=>row.monthStart.slice(0,7)>=today.slice(0,7)).slice(0, 6);
  const remaining = loans.reduce((sum, loan) => sum + (loan.remainingAmount ?? 0), 0);
  // "Açık çek" means still outstanding. Until 0034 no check could leave 'planned', so
  // checks.length happened to be right; now that cleared/bounced/cancelled are reachable,
  // counting every row would overstate the open position.
  const openChecks = checks.filter((c) => c.status === "planned" || c.status === "unknown").length;
  return <>
    <PageHeader title="Finansman Özeti" subtitle="Borç servisi, yaklaşan vadeler ve toplam finansman yükü" action={<Link className="button-accent px-3 py-2" href="/scenarios?from=finance">Senaryoda dene</Link>} />
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <KpiCard label="Kalan kredi borcu" value={fmtTL(remaining)} tone="neg" emphasize />
      <KpiCard label="30 günlük ödeme" value={fmtTL(window30?.knownOutflow)} tone="warn" emphasize />
      <KpiCard label="Açık çek" value={openChecks} />
      <KpiCard label="Aktif kredi" value={loans.length} />
    </div>
    <AnalyticsChart model={debtServiceModel(maturities, today)} kind="bar" defaultPeriod="12m" />
    <Panel title="Önümüzdeki altı ay borç servisi">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{debt.map((row) => <Link key={row.monthStart} href="/finance/maturities" className="border border-line p-3 hover:border-line-strong"><div className="font-mono text-xs text-tone-3">{row.monthStart.slice(0, 7)}</div><div className="mt-1 font-mono text-sm text-neg">{fmtTL(row.knownOutflow)}</div><div className="text-xs text-tone-3">{row.count} vade</div></Link>)}</div>
    </Panel>
  </>;
}
