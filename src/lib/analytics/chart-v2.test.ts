import { describe, expect, it } from "vitest";
import {
  aggregateChartGranularity,
  chartDomain,
  extractOverdueSummary,
  filterChartPeriod,
  formatChartValue,
  type ChartModel,
} from "./chart";

function makeForwardPressureModel(): ChartModel {
  return {
    title: "Ödeme Yükü Projeksiyonu",
    description: "İleri vadeli ödeme yükü",
    sourceLabel: "payment_instances",
    asOf: "2026-04-01",
    timeDirection: "forward",
    preferredView: "stacked",
    minimumVisibleSeries: ["overdue"],
    series: [
      {
        id: "overdue",
        label: "Vadesi Geçmiş",
        tone: "negative",
        format: "currency",
        points: [
          { key: "2026-02-15", label: "Şub 15", value: 9_000_000, meta: { overdueCount: 4 } },
        ],
      },
      {
        id: "confirmed",
        label: "Kesinleşmiş Yükümlülük",
        tone: "warning",
        format: "currency",
        projectionKind: "confirmed",
        points: [
          { key: "2026-04-10", label: "Nis 10", value: 120_000 },
          { key: "2026-05-15", label: "May 15", value: 180_000 },
          { key: "2026-08-20", label: "Ağu 20", value: 650_000 },
          { key: "2027-01-10", label: "Oca 10", value: 1_400_000 },
        ],
      },
      {
        id: "projected",
        label: "Şablon Tahmini",
        tone: "neutral",
        format: "currency",
        projectionKind: "projected",
        dashed: true,
        points: [
          { key: "2026-04-10", label: "Nis 10", value: 80_000, projectionKind: "projected" },
          { key: "2026-08-20", label: "Ağu 20", value: 100_000, projectionKind: "projected" },
        ],
      },
    ],
  };
}

describe("MasChartEngine v2 — Dinamik Y-Ekseni, Vadesi Geçmiş Yalıtımı ve Granülarite", () => {
  it("3A -> 6A -> 12A pencere geçişlerinde vadesi geçmiş pik Y-eksenini kilitlemez; dikey ölçek dinamik değişir", () => {
    const model = makeForwardPressureModel();

    const overdue = extractOverdueSummary(model);
    expect(overdue).not.toBeNull();
    expect(overdue?.total).toBe(9_000_000);
    expect(overdue?.count).toBe(4);

    const view3m = filterChartPeriod(model, "3m", "day", { excludeOverdue: true });
    const view6m = filterChartPeriod(model, "6m", "day", { excludeOverdue: true });
    const view12m = filterChartPeriod(model, "12m", "day", { excludeOverdue: true });

    const dom3m = chartDomain(view3m, { scaleMode: "window", excludeOverdue: true, headroomPct: 0.15 });
    const dom6m = chartDomain(view6m, { scaleMode: "window", excludeOverdue: true, headroomPct: 0.15 });
    const dom12m = chartDomain(view12m, { scaleMode: "window", excludeOverdue: true, headroomPct: 0.15 });

    // 3m peak: 2026-04-10 stacked 120k + 80k = 200k -> * 1.15 = 230k (NOT 9M!)
    expect(dom3m.min).toBe(0);
    expect(dom3m.max).toBeCloseTo(230_000, 2);

    // 6m peak: 2026-08-20 stacked 650k + 100k = 750k -> * 1.15 = 862.5k
    expect(dom6m.max).toBeCloseTo(862_500, 2);
    expect(dom6m.max).toBeGreaterThan(dom3m.max);

    // 12m peak: 2027-01-10 1.4M -> * 1.15 = 1.61M
    expect(dom12m.max).toBeCloseTo(1_610_000, 2);
    expect(dom12m.max).toBeGreaterThan(dom6m.max);
  });

  it("Global Ufuk Ölçeği (scaleMode: 'global') tüm pencerelerde sabit referans tavanı korur", () => {
    const model = makeForwardPressureModel();
    const view3m = filterChartPeriod(model, "3m", "day", { excludeOverdue: true });
    const globalDom = chartDomain(view3m, {
      scaleMode: "global",
      globalModel: model,
      excludeOverdue: true,
      headroomPct: 0.15,
    });
    expect(globalDom.max).toBeCloseTo(1_610_000, 2);
  });

  it("Tarihsel (historical) akış ve bakiye (endpoint) serilerinde haftalık ve aylık toplulaştırma doğru çalışır", () => {
    const historicalFlow: ChartModel = {
      title: "Banka Tahsilat Akışı",
      description: "Günlük tahsilat",
      sourceLabel: "bank_transactions",
      asOf: "2026-04-30",
      timeDirection: "historical",
      summaryMode: "sum",
      series: [
        {
          id: "inflow",
          label: "Tahsilat",
          tone: "positive",
          format: "currency",
          points: [
            { key: "2026-04-01", label: "1 Nis", value: 100_000 },
            { key: "2026-04-15", label: "15 Nis", value: 250_000 },
            { key: "2026-03-10", label: "10 Mar", value: 90_000 },
          ],
        },
      ],
    };

    const monthlyFlow = aggregateChartGranularity(historicalFlow, "month");
    expect(monthlyFlow.series[0].points).toHaveLength(2);
    expect(monthlyFlow.series[0].points[0]).toMatchObject({ key: "2026-03", value: 90_000 });
    expect(monthlyFlow.series[0].points[1]).toMatchObject({ key: "2026-04", value: 350_000 });

    const historicalBalance: ChartModel = {
      ...historicalFlow,
      summaryMode: "endpoint",
    };
    const monthlyBalance = aggregateChartGranularity(historicalBalance, "month");
    // Endpoint mode takes closing balance (250_000 on Apr 15), NOT sum (350_000)
    expect(monthlyBalance.series[0].points[1]).toMatchObject({ key: "2026-04", value: 250_000 });
  });

  it("Çoklu para birimi biçimlendirmesi USD, EUR, GBP ve TL soneklerini doğru üretir", () => {
    expect(formatChartValue(12500, "currency", "USD")).toContain("USD");
    expect(formatChartValue(12500, "currency", "EUR")).toContain("EUR");
    expect(formatChartValue(12500, "currency", "TRY")).toContain("TL");
    expect(formatChartValue(null, "currency", "TRY")).toBe("TUTAR EKSİK");
  });
});

