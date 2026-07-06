import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { loadScenarioRun } from "@/lib/scenarios/engine";
import { buildScenarioInsights, type ScenarioAssumptions, type ScenarioComparison } from "@/lib/scenarios/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
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
      <div className="border border-violet-800 bg-violet-950/25 px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-violet-300">
          ⚠ Senaryo çıktısı tahmindir; muhasebe gerçeği değildir. Kaynak kayıtları değiştirmez.
        </span>
      </div>

      <Panel
        title={run.name}
        right={
          <span className="flex items-center gap-2">
            <Badge tone={CONF_TONE[run.confidence] ?? "neutral"}>güven: {run.confidence}</Badge>
            <Link href="/scenarios" className="font-mono text-[10px] uppercase text-zinc-400 underline underline-offset-2">← senaryolar</Link>
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {cards.map(([k, v, bad]) => (
            <div key={k} className="border border-zinc-800 bg-black/40 p-2">
              <div className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">{k}</div>
              <div className={`font-mono text-sm tabular-nums ${bad ? "text-red-400" : "text-zinc-200"}`}>{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 font-mono text-[10px] text-zinc-500">
          baz: {run.baseline_label ?? "—"} · {run.month_count} ay{run.null_month_count > 0 ? ` · ${run.null_month_count} belirsiz ay` : ""} · {run.run_at}
        </div>
      </Panel>

      <Panel title="VARSAYIMLAR (açık beyan)">
        {assumptions.length === 0 ? (
          <p className="text-sm text-zinc-500">Varsayım uygulanmadı — senaryo baz senaryoya eşittir.</p>
        ) : (
          <ul className="space-y-1">
            {assumptions.map((a, i) => (
              <li key={i} className="font-mono text-[11px] text-zinc-300">
                • {a.description}: <span className="text-violet-300">{a.unit === "oran" ? `%${(a.value! * 100).toFixed(0)}` : a.unit === "bayrak" ? "evet" : `${a.value} ${a.unit}`}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="ANALİTİK İÇGÖRÜ (deterministik, AI değil)">
        <ul className="space-y-1">
          {insights.map((s, i) => <li key={i} className="font-mono text-[12px] text-zinc-300">• {s}</li>)}
        </ul>
      </Panel>

      <Panel title="BAZ vs SENARYO — KASA">
        <ScenarioChart lines={lines} />
      </Panel>

      <Panel title={`AYLIK KARŞILAŞTIRMA — ${lines.length}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
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
                  <td className={`py-1 pr-2 text-right font-mono tabular-nums ${v != null && v < 0 ? "text-red-400" : ""}`}>{v != null ? fmt0(v) : "—"}</td>
                );
                return (
                  <tr key={l.month_start} className="border-b border-zinc-900">
                    <td className="py-1 pr-2 font-mono text-xs">{l.month_start.slice(0, 7)}</td>
                    {cell(l.base_inc)}{cell(l.scen_inc)}{cell(l.base_exp)}{cell(l.scen_exp)}{cell(l.base_close)}{cell(l.scen_close)}
                    <td className={`py-1 text-right font-mono tabular-nums ${l.delta != null && l.delta < 0 ? "text-red-400" : l.delta != null && l.delta > 0 ? "text-emerald-400" : "text-zinc-500"}`}>
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
        <button type="submit" className="border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400 hover:text-red-300">
          bu çalıştırmayı sil (yalnız senaryo kaydı)
        </button>
      </form>
    </>
  );
}
