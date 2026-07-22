import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { loadScenarioRun } from "@/lib/scenarios/engine";
import { buildScenarioInsights, type ScenarioAssumptions, type ScenarioComparison } from "@/lib/scenarios/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { SourceProofDisclosure } from "@/components/facts/source-proof";
import { Panel } from "@/components/ui/panel";
import { ChartShell, Disclaimer, KpiCard } from "@/components/ui/shell";
import { ScenarioChart } from "@/components/scenarios/chart";
import { deleteScenarioRunAction } from "../actions";

export const dynamic = "force-dynamic";

const CONF_TONE: Record<string, Tone> = { high: "green", medium: "amber", low: "red" };
const fmt0 = (v: number | null) =>
  v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—";
const ym = (v: string | null) => (v ? v.slice(0, 7) : "yok");

export default async function ScenarioRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const pool = getPool();
  const data = await loadScenarioRun(pool, runId);
  if (!data) notFound();
  const { run, lines, assumptions } = data;

  const comparison: ScenarioComparison = {
    baselineFinalCash: run.base_final, scenarioFinalCash: run.scen_final, finalDelta: run.final_delta,
    baselineFirstNegative: run.base_first_neg, scenarioFirstNegative: run.scen_first_neg,
    worstMonth: run.worst_month, worstBalance: run.worst_balance, maxCashGap: run.max_gap,
    recoveryMonth: run.recovery_month, monthCount: run.month_count, nullMonthCount: run.null_month_count,
  };
  const insights = buildScenarioInsights(comparison, run.assumptions as ScenarioAssumptions);

  const cards: Array<[string, string, boolean?]> = [
    ["final kasa (baz)", fmt0(run.base_final)],
    ["final kasa (senaryo)", fmt0(run.scen_final)],
    ["fark (Δ)", (run.final_delta != null && run.final_delta > 0 ? "+" : "") + fmt0(run.final_delta), run.final_delta != null && run.final_delta < 0],
    ["ilk negatif (senaryo)", ym(run.scen_first_neg), !!run.scen_first_neg],
    ["en kötü ay", `${ym(run.worst_month)} · ${fmt0(run.worst_balance)}`, run.worst_balance != null && run.worst_balance < 0],
    ["maks. nakit açığı", fmt0(run.max_gap), run.max_gap != null && run.max_gap > 0],
    ["toparlanma ayı", ym(run.recovery_month)],
  ];

  return (
    <>
      <Disclaimer tone="accent">⚠ Senaryo çıktısı tahmindir; muhasebe gerçeği değildir. Kaynak kayıtları değiştirmez.</Disclaimer>

      <Panel
        title={run.name}
        right={
          <span className="flex items-center gap-2">
            <Badge tone={CONF_TONE[run.confidence] ?? "neutral"}>güven: {run.confidence}</Badge>
            <Link href="/scenarios" className="font-mono text-[10px] uppercase text-tone-2 underline underline-offset-2">← senaryolar</Link>
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {cards.map(([k, v, bad]) => (
            <KpiCard key={k} label={k} value={v} tone={bad ? "neg" : "neutral"} />
          ))}
        </div>
        <div className="mt-2 font-mono text-[10px]" style={{ color: "var(--text-3)" }}>
          baz: {run.baseline_label ?? "—"} · {run.month_count} ay{run.null_month_count > 0 ? ` · ${run.null_month_count} belirsiz ay` : ""} · {run.run_at}
        </div>
        <div className="mt-3">
          <SourceProofDisclosure
            label="senaryo kanit paketi"
            items={[{
              key: run.id,
              title: "Baz nakit akis + acik varsayimlar",
              value: `${run.month_count} ay / guven ${run.confidence}`,
              confidence: run.confidence === "low" ? "needs_review" : "calculated",
              freshness: run.run_at,
              explanation: "Senaryo kaynak kayitlari degistirmez; baz cashflow uzerine acik overlay uygular.",
              sourceHref: "/cashflow",
            }]}
          />
        </div>
      </Panel>

      <Panel title="VARSAYIMLAR (açık beyan)">
        {assumptions.length === 0 ? (
          <p className="text-sm text-tone-3">Varsayım uygulanmadı — senaryo baz senaryoya eşittir.</p>
        ) : (
          <ul className="space-y-1">
            {assumptions.map((a, i) => (
              <li key={i} className="font-mono text-[11px] text-tone-2">
                • {a.description}: <span className="text-violet-300">{a.unit === "oran" ? `%${(a.value! * 100).toFixed(0)}` : a.unit === "bayrak" ? "evet" : `${a.value} ${a.unit}`}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="ANALİTİK İÇGÖRÜ (deterministik, AI değil)">
        <ul className="space-y-1">
          {insights.map((s, i) => <li key={i} className="font-mono text-[12px] text-tone-2">• {s}</li>)}
        </ul>
      </Panel>

      <ChartShell
        title="Baz vs Senaryo — Kasa"
        hint="kesikli: baz · düz: senaryo"
        source="Baz senaryo değiştirilmez; senaryo yalnız overlay'dir."
        summary={`Baz final kasa ${fmt0(run.base_final)}, senaryo final kasa ${fmt0(run.scen_final)}, fark ${fmt0(run.final_delta)}.`}
      >
        <ScenarioChart lines={lines} />
      </ChartShell>

      <Panel title={`AYLIK KARŞILAŞTIRMA — ${lines.length}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                <th className="py-1 pr-2">ay</th>
                <th className="py-1 pr-2 text-right">baz gelir</th>
                <th className="py-1 pr-2 text-right">senaryo gelir</th>
                <th className="py-1 pr-2 text-right">baz gider</th>
                <th className="py-1 pr-2 text-right">senaryo gider</th>
                <th className="py-1 pr-2 text-right">baz kasa</th>
                <th className="py-1 pr-2 text-right">senaryo kasa</th>
                <th className="py-1 text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const cell = (v: number | null) => (
                  <td className={`py-1 pr-2 text-right font-mono tabular-nums ${v != null && v < 0 ? "text-neg" : ""}`}>{v != null ? fmt0(v) : "—"}</td>
                );
                return (
                  <tr key={l.month_start} className="border-b border-line-faint">
                    <td className="py-1 pr-2 font-mono text-xs">{l.month_start.slice(0, 7)}</td>
                    {cell(l.base_inc)}{cell(l.scen_inc)}{cell(l.base_exp)}{cell(l.scen_exp)}{cell(l.base_close)}{cell(l.scen_close)}
                    <td className={`py-1 text-right font-mono tabular-nums ${l.delta != null && l.delta < 0 ? "text-neg" : l.delta != null && l.delta > 0 ? "text-pos" : "text-tone-3"}`}>
                      {l.delta != null ? (l.delta > 0 ? "+" : "") + fmt0(l.delta) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <form action={deleteScenarioRunAction}>
        <input type="hidden" name="runId" value={run.id} />
        <button type="submit" className="border border-line-strong bg-surface-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-tone-2 hover:text-neg">
          bu çalıştırmayı sil (yalnız senaryo kaydı)
        </button>
      </form>
    </>
  );
}
