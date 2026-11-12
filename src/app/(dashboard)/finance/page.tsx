import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { getPool } from "@/lib/db";
import { loadFinanceDashboard } from "@/lib/financing/engine";
import { intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { loadUnknownOpeningAccountCount } from "@/lib/treasury/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { fmtTL, Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import type { ChartModel } from "@/lib/analytics/chart";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

export default async function FinanceSummaryPage() {
  const denied = await requireRouteAccess("/finance");
  if (denied) return denied;
  const pool = getPool();
  const today = istanbulDateISO();
  const [{ summary, months }, unknownOpening, wcRes] = await Promise.all([
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
  ]);
  const workingCapitalRows = wcRes.rows.map((r) => ({
    ym: r.ym,
    periodStart: r.period_start,
    receivablesOpen: moneyOrNull(r.receivables_open) ?? 0,
    payablesOpen: moneyOrNull(r.payables_open) ?? 0,
    netWorkingCapital: moneyOrNull(r.net_working_capital_ex_inventory) ?? 0,
    dsoDays: rateOrNull(r.dso_days),
    dpoDays: rateOrNull(r.dpo_days),
    dioDays: rateOrNull(r.dio_days),
    cccExInventory: rateOrNull(r.cash_cycle_excluding_inventory),
    cashInflowTry: moneyOrNull(r.cash_inflow_try) ?? 0,
    cashOutflowTry: moneyOrNull(r.cash_outflow_try) ?? 0,
    cashNetTry: moneyOrNull(r.cash_net_try) ?? 0,
    foreignInvoiceCount: intOrNull(r.foreign_invoice_count) ?? 0,
    foreignCashTxCount: intOrNull(r.foreign_cash_tx_count) ?? 0,
  }));
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

    <Panel
      title="Aylık İşletme Sermayesi (DSO / DPO / CCC)"
      subtitle="Aylık açık alacak/borç, stok hariç net işletme sermayesi ve tahsilat-ödeme çevrim süresi (TRY bazında; dövizli işlem adedi ayrıca gösterilir)"
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
                <th className="text-right">DSO (Gün)</th>
                <th className="text-right">DPO (Gün)</th>
                <th className="text-right">CCC (Stok Hariç)</th>
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
                    {wc.dsoDays == null ? "—" : `${wc.dsoDays.toFixed(1)}g`}
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {wc.dpoDays == null ? "—" : `${wc.dpoDays.toFixed(1)}g`}
                  </td>
                  <td
                    className={`text-right font-mono font-semibold tabular-nums ${
                      wc.cccExInventory != null && wc.cccExInventory > 45 ? "text-warn" : ""
                    }`}
                  >
                    {wc.cccExInventory == null ? "—" : `${wc.cccExInventory.toFixed(1)}g`}
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
  </>;
}
