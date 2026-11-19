import Link from "@/components/ui/app-link";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { PageHeader, TableShell } from "@/components/ui/shell";
import { incomeExpenseModel } from "@/lib/analytics/models";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { loadHybridCashMonths } from "@/lib/cashflow/live-hybrid";
import { getPool } from "@/lib/db";
import { decimal, round2 } from "@/lib/money";
import { loadDebtOverlay } from "@/lib/reports/engine";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

export default async function MonthlyCashflow() {
  const denied = await requireRouteAccess("/cashflow/monthly");
  if (denied) return denied;
  const pool = getPool();
  const today = istanbulDateISO();
  const [{ months, sourceMode }, debt] = await Promise.all([
    loadHybridCashMonths(pool, today),
    loadDebtOverlay(pool),
  ]);
  const debtOf = new Map(debt.map((row) => [row.monthStart, row]));

  return (
    <>
      <PageHeader
        title="Aylık nakit akışı"
        subtitle="Gelir, gider, devir, kapanış, TMS 7 faaliyet ayrımı ve borç servisi ay bazında (önbelleksiz canlı okuma)."
        meta={
          <span className="flex items-center gap-1.5">
            <Badge tone="blue">
              {sourceMode === "hybrid" ? "Hibrit" : sourceMode === "imported" ? "Excel" : "Canlı TMS 7"}
            </Badge>
            <Badge tone="neutral" dot>
              {months.length} ay
            </Badge>
          </span>
        }
        action={
          <Link href="/cashflow/close" className="button-ghost px-3 py-2">
            Dönem kapanışı →
          </Link>
        }
      />
      <AnalyticsChart model={incomeExpenseModel(months, today)} kind="bar" defaultPeriod="12m" />
      <Panel title="AYLIK DETAY (CANLI BANKA + LİKİDİTE TAHMİNİ + EXCEL)">
        <TableShell>
          <table className="w-full min-w-220 text-sm">
            <thead>
              <tr>
                <th>Ay</th>
                <th>Kaynak</th>
                <th>Durum</th>
                <th className="text-right">Devir</th>
                <th className="text-right">Gelir</th>
                <th className="text-right">Gider</th>
                <th className="text-right">Net hareket</th>
                <th className="text-right">İşletme Net</th>
                <th className="text-right">Kapanış</th>
                <th className="text-right">Borç servisi</th>
              </tr>
            </thead>
            <tbody>
              {months.map((month) => {
                const debtRow = debtOf.get(month.monthStart);
                const netMove =
                  month.income != null && month.expense != null
                    ? round2(decimal(month.income).minus(month.expense))
                    : null;
                return (
                  <tr key={month.ym}>
                    <td>
                      <Link href={`/cashflow/${month.ym}`} className="font-mono underline underline-offset-2">
                        {month.ym}
                      </Link>
                    </td>
                    <td>
                      <Badge
                        tone={
                          month.sourceKind === "live"
                            ? "green"
                            : month.sourceKind === "hybrid"
                              ? "blue"
                              : "neutral"
                        }
                      >
                        {month.sourceKind === "live"
                          ? "Canlı"
                          : month.sourceKind === "hybrid"
                            ? "Hibrit"
                            : "Excel"}
                      </Badge>
                    </td>
                    <td>
                      {month.status === "locked" ? (
                        <Badge tone="green">Kilitli</Badge>
                      ) : (
                        <Badge tone="neutral">{month.status}</Badge>
                      )}
                    </td>
                    <td className="tnum text-right">{fmtTL(month.opening)}</td>
                    <td className="tnum text-right">{fmtTL(month.income)}</td>
                    <td className="tnum text-right">{fmtTL(month.expense)}</td>
                    <td className={`tnum text-right ${netMove != null && netMove < 0 ? "text-neg" : ""}`}>
                      {fmtTL(netMove)}
                    </td>
                    <td
                      className={`tnum text-right ${
                        month.tms7.operatingNet < 0 ? "text-neg" : "text-tone-2"
                      }`}
                    >
                      {fmtTL(month.tms7.operatingNet)}
                    </td>
                    <td className={`tnum text-right ${month.closing != null && month.closing < 0 ? "text-neg" : ""}`}>
                      {fmtTL(month.closing)}
                    </td>
                    <td className="tnum text-right">{fmtTL(debtRow?.debtOutflow ?? null)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableShell>
      </Panel>
    </>
  );
}
