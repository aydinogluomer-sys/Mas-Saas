import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { ProfitabilityTable, type ProfitabilityRow } from "@/components/production/profitability-table";
import { profitabilityModel } from "@/lib/analytics/models";
import { getPool } from "@/lib/db";
import { loadPartProfitability } from "@/lib/production/engine";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

export default async function ProfitabilityPage() {
  const rows = await loadPartProfitability(getPool(), 250);
  const data: ProfitabilityRow[] = rows.map((row) => ({
    part_code: row.part_code,
    part_name: row.part_name,
    revenue: row.revenue,
    cost: row.cost,
    margin: row.margin,
    margin_rate: row.margin_rate,
    confidence: row.confidence,
    missing_operation_time: row.missing_operation_time,
  }));
  return (
    <>
      <PageHeader title="Parça Kârlılığı" subtitle="En düşük marjlı parçalar önce; eksik operasyon süresi açıkça gösterilir" meta={<span className="text-xs text-warn">Analitik tahmin</span>} />
      <AnalyticsChart model={profitabilityModel(rows, istanbulDateISO())} kind="bar" defaultPeriod="all" />
      <Panel title={`${data.length} parça`}>
        <ProfitabilityTable rows={data} />
      </Panel>
    </>
  );
}
