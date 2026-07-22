import Link from "next/link";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { PageHeader, TableShell } from "@/components/ui/shell";
import { incomeExpenseModel } from "@/lib/analytics/models";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { getPool } from "@/lib/db";
import { loadDebtOverlay } from "@/lib/reports/engine";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";
export default async function MonthlyCashflow() {
  const pool = getPool();
  const [months, debt] = await Promise.all([loadCashMonths(pool), loadDebtOverlay(pool)]);
  const debtOf = new Map(debt.map((row) => [row.monthStart, row]));
  return <>
    <PageHeader title="Aylık nakit akışı" subtitle="Gelir, gider, devir, kapanış ve borç servisi ay bazında." meta={<Badge tone="neutral" dot>{months.length} ay</Badge>} />
    <AnalyticsChart model={incomeExpenseModel(months, istanbulDateISO())} kind="bar" defaultPeriod="12m" />
    <Panel title="AYLIK DETAY"><TableShell><table className="w-full min-w-[880px] text-sm"><thead><tr><th>Ay</th><th className="text-right">Devir</th><th className="text-right">Gelir</th><th className="text-right">Gider</th><th className="text-right">Net hareket</th><th className="text-right">Kapanış</th><th className="text-right">Borç servisi</th></tr></thead><tbody>{months.map((month) => { const debtRow = debtOf.get(month.monthStart); return <tr key={month.id}><td><Link href={`/cashflow/${month.id}`} className="underline underline-offset-2">{month.monthStart.slice(0, 7)}</Link></td><td className="tnum text-right">{fmtTL(month.opening)}</td><td className="tnum text-right">{fmtTL(month.income)}</td><td className="tnum text-right">{fmtTL(month.expense)}</td><td className="tnum text-right">{fmtTL(month.income != null && month.expense != null ? month.income - month.expense : null)}</td><td className={`tnum text-right ${month.closing != null && month.closing < 0 ? "text-neg" : ""}`}>{fmtTL(month.closing)}</td><td className="tnum text-right">{fmtTL(debtRow?.debtOutflow ?? null)}</td></tr>; })}</tbody></table></TableShell></Panel>
  </>;
}
