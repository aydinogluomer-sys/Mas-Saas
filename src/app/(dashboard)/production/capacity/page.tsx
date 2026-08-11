import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import { capacityModel } from "@/lib/analytics/models";
import { getPool } from "@/lib/db";
import { loadActualMonthlyIncome, loadCapacityDemand, loadCapacityModels, loadMachineMinuteAllocations } from "@/lib/production/engine";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";
export default async function CapacityPage() {
  const pool = getPool();
  const [models, demand, allocations, actualIncome] = await Promise.all([loadCapacityModels(pool), loadCapacityDemand(pool), loadMachineMinuteAllocations(pool), loadActualMonthlyIncome(pool)]);
  const available = models.reduce((sum, model) => sum + (model.monthlyMinutes ?? 0), 0);
  // UNIT MISMATCH, flagged not fixed: demand comes from production_parts (the source's
  // G5/H5 minute sums, which I8 totals as a YEARLY figure ≈18,57M) while `available` is
  // capacity_models.monthly_minutes (K8, MONTHLY). Subtracting them overstates the gap by
  // roughly 12x. Which normalisation is correct — divide demand by 12, multiply capacity
  // by 12, or surface yearly and monthly demand as separate KPIs — is a product/data
  // decision, so the number is left exactly as it was and the card says so instead of
  // silently changing it (docs rule: flag, never silently correct).
  const gap = available - demand.demandMinutes;

  // "null asla 0 sayılmaz": a model whose rate never resolved has no theoretical revenue,
  // and summing it as 0 would quietly understate the total. One missing model is enough to
  // make the whole sum unreportable — it is shown as "—" with the count surfaced instead.
  // Zero models is the same case: there is nothing to total, not a total of zero.
  const missingRateCount = models.filter((model) => model.theoreticalMonthlyRevenue == null).length;
  const theoreticalRevenue = models.length > 0 && missingRateCount === 0
    ? models.reduce((sum, model) => sum + (model.theoreticalMonthlyRevenue as number), 0)
    : null;
  // Stale rates are flagged, never silently corrected (docs/database-schema.md) — a
  // theoretical figure derived from a 2023 rate must not read as a current one.
  const staleRateCount = models.filter((model) => model.isStaleRate).length;
  const belowCapacity = actualIncome != null && theoreticalRevenue != null && actualIncome < theoreticalRevenue;
  return <>
    <PageHeader title="Kapasite" subtitle="Etkin dakika, üretim talebi ve makine bazlı kapasite açığı" meta={<span className="text-xs text-warn">Analitik tahmin</span>} />
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
      <KpiCard label="Etkin dakika" value={available.toLocaleString("tr-TR")} />
      <KpiCard label="Talep dakika" value={demand.demandMinutes.toLocaleString("tr-TR")} />
      <KpiCard
        label="Açık / fazla"
        value={gap.toLocaleString("tr-TR")}
        tone={gap < 0 ? "neg" : "pos"}
        badge={<Badge tone="amber">birim uyumsuz</Badge>}
        note="talep yıllık toplam, etkin dakika aylık — birebir kıyaslanamaz"
      />
      <KpiCard
        label="Teorik aylık gelir"
        value={theoreticalRevenue == null ? "—" : fmtTL(theoreticalRevenue)}
        badge={
          missingRateCount > 0
            ? <Badge tone="amber">{missingRateCount} model eksik oranlı</Badge>
            : staleRateCount > 0
              ? <Badge tone="amber">eski oran</Badge>
              : undefined
        }
        note={models.length === 0 ? "kapasite modeli yok" : undefined}
      />
      <KpiCard
        label="Gerçek aylık gelir (ortalama)"
        value={actualIncome == null ? "—" : fmtTL(actualIncome)}
        tone={actualIncome == null ? "neutral" : belowCapacity ? "warn" : "pos"}
        note="nakit akış aylarının ortalaması"
      />
    </div>
    <AnalyticsChart model={capacityModel(allocations, istanbulDateISO())} kind="bar" defaultPeriod="all" />
    <Panel title="Makine dakika tahsisi"><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-tone-3"><th>Model</th><th>Operasyon</th><th className="text-right">Makine</th><th className="text-right">Talep</th><th className="text-right">Mevcut</th><th className="text-right">Kullanım</th></tr></thead><tbody>{allocations.map((row, index) => <tr key={`${row.capacity_model_name}-${row.operation_type}-${index}`} className="border-t border-line-faint"><td className="py-2">{row.capacity_model_name}</td><td>{row.operation_type}</td><td className="text-right">{row.machine_count ?? "—"}</td><td className="text-right">{row.demand_minutes?.toLocaleString("tr-TR") ?? "—"}</td><td className="text-right">{row.available_minutes?.toLocaleString("tr-TR") ?? "—"}</td><td className="text-right">{row.utilization_rate == null ? "—" : `%${(row.utilization_rate * 100).toFixed(1)}`}</td></tr>)}</tbody></table></div></Panel>
  </>;
}
