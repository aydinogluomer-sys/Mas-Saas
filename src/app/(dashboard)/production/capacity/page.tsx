import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import { capacityModel } from "@/lib/analytics/models";
import { getPool } from "@/lib/db";
import { loadCapacityDemand, loadCapacityModels, loadMachineMinuteAllocations } from "@/lib/production/engine";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";
export default async function CapacityPage() {
  const pool = getPool();
  const [models, demand, allocations] = await Promise.all([loadCapacityModels(pool), loadCapacityDemand(pool), loadMachineMinuteAllocations(pool)]);
  const available = models.reduce((sum, model) => sum + (model.monthlyMinutes ?? 0), 0);
  const gap = available - demand.demandMinutes;
  return <>
    <PageHeader title="Kapasite" subtitle="Etkin dakika, üretim talebi ve makine bazlı kapasite açığı" meta={<span className="text-xs text-warn">Analitik tahmin</span>} />
    <div className="grid grid-cols-3 gap-2"><KpiCard label="Etkin dakika" value={available.toLocaleString("tr-TR")} /><KpiCard label="Talep dakika" value={demand.demandMinutes.toLocaleString("tr-TR")} /><KpiCard label="Açık / fazla" value={gap.toLocaleString("tr-TR")} tone={gap < 0 ? "neg" : "pos"} /></div>
    <AnalyticsChart model={capacityModel(allocations, istanbulDateISO())} kind="bar" defaultPeriod="all" />
    <Panel title="Makine dakika tahsisi"><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-tone-3"><th>Model</th><th>Operasyon</th><th className="text-right">Makine</th><th className="text-right">Talep</th><th className="text-right">Mevcut</th><th className="text-right">Kullanım</th></tr></thead><tbody>{allocations.map((row, index) => <tr key={`${row.capacity_model_name}-${row.operation_type}-${index}`} className="border-t border-line-faint"><td className="py-2">{row.capacity_model_name}</td><td>{row.operation_type}</td><td className="text-right">{row.machine_count ?? "—"}</td><td className="text-right">{row.demand_minutes?.toLocaleString("tr-TR") ?? "—"}</td><td className="text-right">{row.available_minutes?.toLocaleString("tr-TR") ?? "—"}</td><td className="text-right">{row.utilization_rate == null ? "—" : `%${(row.utilization_rate * 100).toFixed(1)}`}</td></tr>)}</tbody></table></div></Panel>
  </>;
}
