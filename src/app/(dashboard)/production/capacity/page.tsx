import Link from "@/components/ui/app-link";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { EmptyState, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { capacityModel } from "@/lib/analytics/models";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import {
  loadActualMonthlyIncome,
  loadCapacityDemand,
  loadCapacityModels,
  loadMachineMinuteAllocations,
} from "@/lib/production/engine";
import {
  loadWorkCenters,
  loadWorkOrdersAndOee,
  OPERATION_TYPE_LABEL,
  type WorkCenterOperationType,
} from "@/lib/production/erp-lite";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

type ShiftMode = "work_centers" | "normal" | "overtime";

export default async function CapacityPage({
  searchParams,
}: {
  searchParams?: Promise<{ mode?: string; modelId?: string }>;
}) {
  const denied = await requireRouteAccess("/production/capacity");
  if (denied) return denied;
  const sp = searchParams ? await searchParams : {};

  const pool = getPool();
  const [models, demand, allocations, actualIncome, workCenters, woOverview] = await Promise.all([
    loadCapacityModels(pool),
    loadCapacityDemand(pool),
    loadMachineMinuteAllocations(pool),
    loadActualMonthlyIncome(pool),
    loadWorkCenters(pool),
    loadWorkOrdersAndOee(pool),
  ]);

  const normalModels = models.filter((m) => m.scenarioType === "normal");
  const overtimeModels = models.filter((m) => m.scenarioType === "overtime");

  const defaultMode: ShiftMode =
    workCenters.activeCount > 0
      ? "work_centers"
      : normalModels.length > 0
        ? "normal"
        : overtimeModels.length > 0
          ? "overtime"
          : "normal";

  const requestedMode = sp.mode;
  const activeMode: ShiftMode =
    requestedMode === "work_centers" || requestedMode === "normal" || requestedMode === "overtime"
      ? requestedMode
      : defaultMode;

  // CRITICAL M-46 FIX: NEVER sum alternative shift scenarios (`normal` + `overtime`) together!
  // Pick ONLY the active scenario's model (or selected `modelId`), or live `work_centers` capacity.
  const selectedModel =
    sp.modelId && models.some((m) => m.id === sp.modelId)
      ? models.find((m) => m.id === sp.modelId) ?? null
      : activeMode === "overtime"
        ? overtimeModels[0] ?? models[0] ?? null
        : normalModels[0] ?? models[0] ?? null;

  const useLiveWorkCenters = activeMode === "work_centers" && workCenters.activeCount > 0;

  const availableMonthlyMinutes: number | null = useLiveWorkCenters
    ? workCenters.totalTargetEffectiveMinutes
    : selectedModel?.monthlyMinutes ?? null;

  const theoreticalMonthlyRevenue: number | null = useLiveWorkCenters
    ? workCenters.totalTheoreticalMonthlyRevenueTry
    : selectedModel?.theoreticalMonthlyRevenue ?? null;

  const isStaleSelected = !useLiveWorkCenters && Boolean(selectedModel?.isStaleRate);
  const realizedWorkOrderRevenueTry = woOverview.plantOee.totalRealizedWorkOrderRevenueTry;
  const activeOrdersCount = woOverview.plantOee.activeOrCompletedOrders;
  const scheduledWoMinutes = woOverview.plantOee.totalPlannedMinutes;
  const plantOeePct = woOverview.plantOee.oeePct;

  const activeModeLabel = useLiveWorkCenters
    ? `Canlı İş İstasyonları (${workCenters.activeCount} istasyon · ${workCenters.totalMachineCount} tezgâh)`
    : selectedModel
      ? `${selectedModel.name} (${selectedModel.scenarioType === "overtime" ? "Fazla Mesaili" : "Normal Vardiya"})`
      : "Tanımlı kapasite modeli yok";

  const filteredAllocations = selectedModel
    ? allocations.filter((a) => a.capacity_model_name === selectedModel.name)
    : allocations;
  const chartAllocations = filteredAllocations.length > 0 ? filteredAllocations : allocations;

  return (
    <>
      <PageHeader
        title="Kapasite, Vardiya Rejimi ve Canlı OEE"
        subtitle="Alternatif vardiya modelleri çift sayılmaz; Teorik Kapasite Potansiyeli ile Fiili İş Emri (OEE) Doluluğu ayrı izlenir"
        meta={
          <span className="text-xs" style={{ color: "var(--warn)" }}>
            Analitik kapasite & canlı atölye yükü
          </span>
        }
      />

      <div
        className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-xs"
        style={{
          borderColor: "var(--line)",
          background: "var(--surface-1)",
          color: "var(--text-2)",
        }}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono font-semibold" style={{ color: "var(--text-1)" }}>
            Aktif Vardiya / Kapasite Rejimi:
          </span>
          <Link
            href="/production/capacity?mode=work_centers"
            className="rounded border px-2.5 py-1 font-mono"
            style={{
              borderColor: activeMode === "work_centers" ? "var(--text-1)" : "var(--line)",
              background: activeMode === "work_centers" ? "var(--surface-2)" : "transparent",
              color: "var(--text-1)",
            }}
          >
            İş İstasyonları Canlı Kapasite ({workCenters.activeCount})
          </Link>
          <Link
            href="/production/capacity?mode=normal"
            className="rounded border px-2.5 py-1 font-mono"
            style={{
              borderColor: activeMode === "normal" ? "var(--text-1)" : "var(--line)",
              background: activeMode === "normal" ? "var(--surface-2)" : "transparent",
              color: "var(--text-1)",
            }}
          >
            Normal Vardiya Modeli
          </Link>
          <Link
            href="/production/capacity?mode=overtime"
            className="rounded border px-2.5 py-1 font-mono"
            style={{
              borderColor: activeMode === "overtime" ? "var(--text-1)" : "var(--line)",
              background: activeMode === "overtime" ? "var(--surface-2)" : "transparent",
              color: "var(--text-1)",
            }}
          >
            Fazla Mesaili Vardiya Modeli
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="blue">{activeModeLabel}</Badge>
          <Link
            href="/production?tab=stations"
            className="font-mono text-[11px] underline"
            style={{ color: "var(--text-1)" }}
          >
            İstasyon & İş Emri Yönetimi →
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Seçili Rejim Etkin Dakika (Aylık)"
          value={availableMonthlyMinutes == null ? "—" : availableMonthlyMinutes.toLocaleString("tr-TR")}
          note={`Yıllık parça talebi: ${demand.demandMinutesPerYear.toLocaleString("tr-TR")} dk (${demand.partCount} parça)`}
        />
        <KpiCard
          label="Teorik Maksimum Kapasite Gelir Potansiyeli"
          value={theoreticalMonthlyRevenue == null ? "—" : fmtTL(theoreticalMonthlyRevenue)}
          tone="info"
          badge={
            theoreticalMonthlyRevenue == null ? (
              <Badge tone="amber">tarife eksik</Badge>
            ) : isStaleSelected ? (
              <Badge tone="amber">eski tarife ({selectedModel?.rateYear})</Badge>
            ) : (
              <Badge tone="blue">%100 Tam Yük Potansiyeli</Badge>
            )
          }
          note="Tek vardiya rejimi bazlı tavan potansiyel (normal+mesaili toplanmaz)"
        />
        <KpiCard
          label="Fiili İş Emri Gerçekleşen Gelir & OEE"
          value={activeOrdersCount > 0 ? fmtTL(realizedWorkOrderRevenueTry) : "—"}
          tone={plantOeePct != null && plantOeePct < 65 ? "warn" : "pos"}
          badge={
            plantOeePct != null ? (
              <Badge tone={plantOeePct >= 75 ? "green" : "amber"}>OEE %{plantOeePct.toFixed(1)}</Badge>
            ) : (
              <Badge tone="neutral">{woOverview.plantOee.totalOrders} iş emri</Badge>
            )
          }
          note={
            woOverview.plantOee.totalOrders > 0
              ? `Planlanan yük: ${scheduledWoMinutes.toLocaleString("tr-TR")} dk · Fiili çalışma: ${woOverview.plantOee.totalActualRunMinutes.toLocaleString("tr-TR")} dk`
              : "Henüz aktif/tamamlanan iş emri yok"
          }
        />
        <KpiCard
          label="Nakit Akış Aylık Tahsilat Ortalaması"
          value={actualIncome == null ? "—" : fmtTL(actualIncome)}
          tone={
            actualIncome == null
              ? "neutral"
              : theoreticalMonthlyRevenue != null && actualIncome < theoreticalMonthlyRevenue
                ? "warn"
                : "pos"
          }
          note="Nakit akış projeksiyonu aylık ortalaması"
        />
      </div>

      <Panel
        title="CANLI İŞ İSTASYONU DOLULUK, OEE (KULLANILABİLİRLİK × PERFORMANS × KALİTE) VE DARBOĞAZ ANALİZİ"
        subtitle="Teorik istasyon kapasitesi ile sahadaki iş emirlerinden (work_orders) gelen gerçek yük ve OEE bileşenleri"
        right={
          woOverview.plantOee.bottleneckWorkCenterCode ? (
            <Badge tone="red">
              Darboğaz: {woOverview.plantOee.bottleneckWorkCenterCode} ({woOverview.plantOee.bottleneckReason})
            </Badge>
          ) : (
            <Badge tone="green">Kritik darboğaz yok</Badge>
          )
        }
      >
        {woOverview.stationOee.length === 0 ? (
          <EmptyState>
            Henüz aktif iş istasyonu (`work_centers`) tanımlanmamış.{" "}
            <Link href="/production?tab=stations" className="underline">
              Üretim Operasyonları → İş İstasyonları
            </Link>{" "}
            sekmesinden tezgâh gruplarını tanımlayarak istasyon bazlı canlı kapasite ve OEE takibini başlatabilirsiniz.
          </EmptyState>
        ) : (
          <TableShell>
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr
                  className="border-b font-mono text-[10px] uppercase"
                  style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                >
                  <th className="py-2 pr-2">İstasyon</th>
                  <th className="py-2 px-2">Operasyon</th>
                  <th className="py-2 px-2 text-right">Hedef Etkin Dk/Ay</th>
                  <th className="py-2 px-2 text-right">İş Emri Yükü (Dk)</th>
                  <th className="py-2 px-2 text-right">Doluluk %</th>
                  <th className="py-2 px-2 text-right">Kullanılabilirlik</th>
                  <th className="py-2 px-2 text-right">Performans</th>
                  <th className="py-2 px-2 text-right">Kalite</th>
                  <th className="py-2 px-2 text-right">Canlı OEE</th>
                  <th className="py-2 pl-2 text-right">Fiili İş Emri Geliri</th>
                </tr>
              </thead>
              <tbody>
                {woOverview.stationOee.map((st) => {
                  const opLabel =
                    OPERATION_TYPE_LABEL[st.operationType as WorkCenterOperationType] ?? st.operationType;
                  return (
                    <tr
                      key={st.workCenterId}
                      className="border-b"
                      style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                    >
                      <td className="py-2 pr-2 font-mono font-semibold">
                        {st.workCenterCode} · {st.workCenterName}{" "}
                        {st.isBottleneck ? <Badge tone="red">Darboğaz</Badge> : null}
                      </td>
                      <td className="py-2 px-2">{opLabel}</td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {st.targetEffectiveMinutes.toLocaleString("tr-TR")}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {st.scheduledPlannedMinutes.toLocaleString("tr-TR")} ({st.orderCount} emir)
                      </td>
                      <td
                        className="py-2 px-2 text-right font-mono tabular-nums"
                        style={{
                          color:
                            st.capacityLoadPct != null && st.capacityLoadPct > 90
                              ? "var(--neg)"
                              : st.capacityLoadPct != null && st.capacityLoadPct > 70
                                ? "var(--warn)"
                                : "var(--text-1)",
                        }}
                      >
                        {st.capacityLoadPct == null ? "—" : `%${st.capacityLoadPct.toFixed(1)}`}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {st.availabilityPct == null ? "—" : `%${st.availabilityPct.toFixed(1)}`}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {st.performancePct == null ? "—" : `%${st.performancePct.toFixed(1)}`}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {st.qualityPct == null ? "—" : `%${st.qualityPct.toFixed(1)}`}
                      </td>
                      <td className="py-2 px-2 text-right font-mono font-semibold tabular-nums">
                        {st.oeePct == null ? (
                          <span style={{ color: "var(--text-3)" }}>Hedef %{st.targetOeePct.toFixed(0)}</span>
                        ) : (
                          <span
                            style={{
                              color: st.oeePct < st.targetOeePct ? "var(--warn)" : "var(--pos)",
                            }}
                          >
                            %{st.oeePct.toFixed(1)}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pl-2 text-right font-mono tabular-nums">
                        {st.realizedWorkOrderRevenueTry > 0 ? fmtTL(st.realizedWorkOrderRevenueTry) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <AnalyticsChart model={capacityModel(chartAllocations, istanbulDateISO())} kind="bar" defaultPeriod="all" />

      <Panel
        title="Kapasite Modeli Makine-Dakika Tahsisi (Seçili Vardiya Modeli)"
        subtitle="Çalışma kitabından veya manuel modelden türetilen yıllık talep / mevcut dakika karşılaştırması"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs" style={{ color: "var(--text-3)" }}>
                <th>Model</th>
                <th>Operasyon</th>
                <th className="text-right">Makine</th>
                <th className="text-right">Yıllık Talep (Dk)</th>
                <th className="text-right">Yıllık Mevcut (Dk)</th>
                <th className="text-right">Kullanım</th>
              </tr>
            </thead>
            <tbody>
              {chartAllocations.map((row, index) => (
                <tr
                  key={`${row.capacity_model_name}-${row.operation_type}-${index}`}
                  className="border-t"
                  style={{ borderColor: "var(--line-faint)" }}
                >
                  <td className="py-2">{row.capacity_model_name}</td>
                  <td>{row.operation_type}</td>
                  <td className="text-right font-mono tabular-nums">{row.machine_count ?? "—"}</td>
                  <td className="text-right font-mono tabular-nums">
                    {row.demand_minutes?.toLocaleString("tr-TR") ?? "—"}
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {row.available_minutes?.toLocaleString("tr-TR") ?? "—"}
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {row.utilization_rate == null ? "—" : `%${(row.utilization_rate * 100).toFixed(1)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
