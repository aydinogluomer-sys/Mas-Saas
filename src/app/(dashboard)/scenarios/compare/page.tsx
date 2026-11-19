import Link from "@/components/ui/app-link";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, PageHeader, TableShell } from "@/components/ui/shell";
import type { ChartModel, ChartTone } from "@/lib/analytics/chart";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { listScenarioRuns, loadScenarioComparisonMatrix } from "@/lib/scenarios/engine";

export const dynamic = "force-dynamic";

type SP = { a?: string; b?: string; c?: string; d?: string };

const SERIES_TONES: ChartTone[] = ["info", "positive", "warning", "negative"];

export default async function ComparePage({ searchParams }: { searchParams: Promise<SP> }) {
  const denied = await requireRouteAccess("/scenarios/compare");
  if (denied) return denied;

  const sp = await searchParams;
  const pool = getPool();
  const runs = await listScenarioRuns(pool);

  const defaultA = sp.a ?? runs[0]?.id ?? "";
  const defaultB = sp.b ?? (runs[1]?.id && runs[1].id !== defaultA ? runs[1].id : "");
  const selectedIds = [defaultA, defaultB, sp.c ?? "", sp.d ?? ""].filter(Boolean);

  const matrix = await loadScenarioComparisonMatrix(pool, selectedIds);
  const compared = matrix.runs;
  const todayIso = new Date().toISOString().slice(0, 10);

  const useWeeklyAxis = compared.some((r) => r.weeks.length > 0);
  const compareChartModel: ChartModel = {
    title: "Çoklu Senaryo Kapanış Kasa Yörüngesi",
    description: "Seçilen 2–4 senaryonun dönem sonu kasa bakiyesi karşılaştırma eğrileri (TRY).",
    sourceLabel: "scenario_comparison_matrix + scenario_run_weeks",
    sourceHref: "/scenarios/compare",
    asOf: todayIso,
    timeDirection: "forward",
    availableGranularities: useWeeklyAxis ? ["week", "month"] : ["month"],
    defaultGranularityByPeriod: useWeeklyAxis
      ? { "3m": "week", "6m": "week", "12m": "month", "24m": "month", all: "week" }
      : { "3m": "month", "6m": "month", "12m": "month", "24m": "month", all: "month" },
    summaryMode: "endpoint",
    currencyCode: "TRY",
    series: compared.map((col, idx) => ({
      id: `scen_${col.runId.slice(0, 8)}`,
      label: `${String.fromCharCode(65 + idx)}: ${col.name}`,
      tone: SERIES_TONES[idx % SERIES_TONES.length],
      format: "currency",
      projectionKind: "projected",
      points:
        col.weeks.length > 0
          ? col.weeks.map((w) => ({
              key: w.weekStart,
              label: `H${w.weekIndex} (${w.weekStart})`,
              value: w.scenarioClosingCash,
              projectionKind: "projected",
            }))
          : col.monthlyLines.map((m) => ({
              key: m.monthStart,
              label: m.monthStart.slice(0, 7),
              value: m.scenarioClosing,
              projectionKind: "projected",
            })),
    })),
  };

  const allPeriodKeys = Array.from(
    new Set(
      compared.flatMap((c) =>
        useWeeklyAxis && c.weeks.length > 0
          ? c.weeks.map((w) => w.weekStart)
          : c.monthlyLines.map((m) => m.monthStart),
      ),
    ),
  ).sort();

  return (
    <>
      <PageHeader
        title="Çoklu Senaryo Karşılaştırma Matrisi (2–4 Senaryo)"
        subtitle="Kaydedilmiş klasik ve 13H birleşik senaryoları kapanış kasası, otomatik BCH çekimi, ek finansman maliyeti ve DSCR kovenant bazında yan yana kıyaslayın"
        meta={
          <Link href="/scenarios" className="button-ghost px-2.5 py-1 text-xs">
            + Yeni Senaryo Çalıştır
          </Link>
        }
      />

      <Panel title="KARŞILAŞTIRILACAK SENARYOLARI SEÇİN (EN FAZLA 4 ÇALIŞMA)">
        <form method="get" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {(["a", "b", "c", "d"] as const).map((slot, idx) => {
            const defVal = slot === "a" ? defaultA : slot === "b" ? defaultB : sp[slot] ?? "";
            return (
              <select key={slot} name={slot} defaultValue={defVal} className="field-control p-2 text-xs">
                <option value="">{`${String.fromCharCode(65 + idx)} Senaryosu (${idx < 2 ? "Ana" : "Opsiyonel"})`}</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.is_unified_13w ? "13H" : "Aylık"} · {r.run_at}
                  </option>
                ))}
              </select>
            );
          })}
          <button type="submit" className="button-accent px-3 py-2 text-xs font-semibold">
            Matrisi Güncelle
          </button>
        </form>
      </Panel>

      {compared.length === 0 ? (
        <Panel title="SENARYO SEÇİLMEDİ">
          <EmptyState>
            Karşılaştırma matrisi için yukarıdan en az bir senaryo seçin veya{" "}
            <Link href="/scenarios" className="underline">
              /scenarios
            </Link>{" "}
            üzerinden yeni bir simülasyon başlatın.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel
            title="ÇOKLU SENARYO KASA YÖRÜNGESİ GRAFİĞİ"
            subtitle="Seçili senaryoların zaman içindeki kapanış kasası eğrileri"
          >
            <AnalyticsChart model={compareChartModel} kind="line" defaultPeriod="all" height={290} />
          </Panel>

          <Panel
            title={`BİRLEŞİK KPI KARŞILAŞTIRMA MATRİSİ — ${compared.length} SENARYO`}
            subtitle="Likidite, otomatik BCH kullanımı, ek finansman gideri, devreden alacak ve DSCR kovenant özeti"
          >
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left uppercase" style={{ borderColor: "var(--line)", color: "var(--text-3)" }}>
                    <th className="py-2 pr-3">Metrik</th>
                    {compared.map((col, idx) => (
                      <th key={col.runId} className="py-2 px-2 text-right">
                        <Link href={`/scenarios/${col.runId}`} className="underline" style={{ color: "var(--text-1)" }}>
                          {String.fromCharCode(65 + idx)}: {col.name}
                        </Link>
                        <div className="mt-0.5">
                          <Badge tone={col.isUnified13w ? "blue" : "neutral"}>
                            {col.isUnified13w ? "13H Birleşik" : "Aylık"}
                          </Badge>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      label: "Baz Final Kasa",
                      render: (c: (typeof compared)[number]) => fmtTL(c.baselineFinalCash),
                    },
                    {
                      label: "Senaryo Final Kasa",
                      render: (c: (typeof compared)[number]) => fmtTL(c.scenarioFinalCash),
                    },
                    {
                      label: "Net Kasa Farkı (Δ)",
                      render: (c: (typeof compared)[number]) => (
                        <span className={(c.finalDelta ?? 0) < 0 ? "text-neg font-semibold" : "text-pos font-semibold"}>
                          {fmtTL(c.finalDelta)}
                        </span>
                      ),
                    },
                    {
                      label: "En Düşük Bakiye",
                      render: (c: (typeof compared)[number]) => fmtTL(c.worstBalance),
                    },
                    {
                      label: "Maksimum Nakit Açığı",
                      render: (c: (typeof compared)[number]) => (
                        <span className={(c.maxCashGap ?? 0) > 0 ? "text-neg" : ""}>{fmtTL(c.maxCashGap)}</span>
                      ),
                    },
                    {
                      label: "İlk Negatif / İhlal Tarihi",
                      render: (c: (typeof compared)[number]) => c.firstNegative ?? "Yok",
                    },
                    {
                      label: "Otomatik BCH Kredi Çekimi",
                      render: (c: (typeof compared)[number]) =>
                        c.totalAutoFacilityDraw != null ? fmtTL(c.totalAutoFacilityDraw) : "—",
                    },
                    {
                      label: "Ek 780 Faiz + BSMV + KKDF",
                      render: (c: (typeof compared)[number]) =>
                        c.totalIncrementalInterestTax != null ? fmtTL(c.totalIncrementalInterestTax) : "—",
                    },
                    {
                      label: "Ufuk Sonu Devreden Alacak",
                      render: (c: (typeof compared)[number]) =>
                        c.deferredReceivablesCarryover != null ? fmtTL(c.deferredReceivablesCarryover) : "—",
                    },
                    {
                      label: "Min Proforma DSCR",
                      render: (c: (typeof compared)[number]) =>
                        c.projectedMinDscr != null ? `${c.projectedMinDscr.toFixed(2)}x` : "—",
                    },
                    {
                      label: "Kovenant İhlal Sayısı",
                      render: (c: (typeof compared)[number]) => (
                        <Badge tone={c.covenantBreachCount > 0 ? "red" : "green"}>
                          {c.covenantBreachCount}
                        </Badge>
                      ),
                    },
                  ].map((row) => (
                    <tr
                      key={row.label}
                      className="border-b"
                      style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                    >
                      <td className="py-2 pr-3 font-medium">{row.label}</td>
                      {compared.map((col) => (
                        <td key={col.runId} className="py-2 px-2 text-right font-mono tabular-nums">
                          {row.render(col)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          </Panel>

          {allPeriodKeys.length > 0 ? (
            <Panel
              title={`DÖNEM BAZLI KAPANIŞ KASA TABLOSU (${allPeriodKeys.length} DÖNEM)`}
              subtitle={useWeeklyAxis ? "Haftalık senaryo kapanış kasaları" : "Aylık senaryo kapanış kasaları"}
            >
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left uppercase" style={{ borderColor: "var(--line)", color: "var(--text-3)" }}>
                      <th className="py-1.5 pr-3">Dönem</th>
                      {compared.map((col, idx) => (
                        <th key={col.runId} className="py-1.5 px-2 text-right">
                          {String.fromCharCode(65 + idx)} Kapanış
                        </th>
                      ))}
                      {compared.length >= 2 ? <th className="py-1.5 pl-2 text-right">B − A Farkı</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {allPeriodKeys.map((pk) => {
                      const vals = compared.map((c) => {
                        if (useWeeklyAxis && c.weeks.length > 0) {
                          return c.weeks.find((w) => w.weekStart === pk)?.scenarioClosingCash ?? null;
                        }
                        return c.monthlyLines.find((m) => m.monthStart === pk)?.scenarioClosing ?? null;
                      });
                      const diffBA =
                        vals.length >= 2 && vals[0] != null && vals[1] != null ? vals[1] - vals[0] : null;
                      return (
                        <tr
                          key={pk}
                          className="border-b"
                          style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                        >
                          <td className="py-1.5 pr-3 font-mono">{useWeeklyAxis ? pk : pk.slice(0, 7)}</td>
                          {vals.map((v, idx) => (
                            <td key={compared[idx].runId} className="py-1.5 px-2 text-right font-mono tabular-nums">
                              {v == null ? "—" : fmtTL(v)}
                            </td>
                          ))}
                          {compared.length >= 2 ? (
                            <td
                              className={`py-1.5 pl-2 text-right font-mono tabular-nums ${
                                diffBA != null && diffBA < 0 ? "text-neg" : diffBA != null && diffBA > 0 ? "text-pos" : ""
                              }`}
                            >
                              {diffBA == null ? "—" : fmtTL(diffBA)}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableShell>
            </Panel>
          ) : null}
        </>
      )}
    </>
  );
}
