import Link from "@/components/ui/app-link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { loadScenarioRun, loadUnifiedScenarioWeeks } from "@/lib/scenarios/engine";
import { buildScenarioInsights, type ScenarioAssumptions, type ScenarioComparison } from "@/lib/scenarios/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { SourceProofDisclosure } from "@/components/facts/source-proof";
import { Panel, fmtTL } from "@/components/ui/panel";
import { ChartShell, Disclaimer, KpiCard, TableShell } from "@/components/ui/shell";
import { ScenarioChart, type ScenarioLine } from "@/components/scenarios/chart";
import { deleteScenarioRunAction } from "../actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const CONF_TONE: Record<string, Tone> = { high: "green", medium: "amber", low: "red" };
const fmt0 = (v: number | null) =>
  v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) + " ₺" : "—";
const ym = (v: string | null) => (v ? v.slice(0, 10) : "yok");

export default async function ScenarioRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const denied = await requireRouteAccess("/scenarios/[runId]");
  if (denied) return denied;
  const { runId } = await params;
  const pool = getPool();
  const [data, weeks] = await Promise.all([
    loadScenarioRun(pool, runId),
    loadUnifiedScenarioWeeks(pool, runId),
  ]);
  if (!data) notFound();
  const { run, lines, assumptions } = data;
  const isUnified =
    weeks.length > 0 || (run.assumptions as { engine?: string } | null)?.engine === "unified_13w";
  const minCashBuffer =
    typeof (run.assumptions as { minCashBufferTry?: unknown } | null)?.minCashBufferTry === "number"
      ? ((run.assumptions as { minCashBufferTry: number }).minCashBufferTry ?? null)
      : null;

  const comparison: ScenarioComparison = {
    baselineFinalCash: run.base_final,
    scenarioFinalCash: run.scen_final,
    finalDelta: run.final_delta,
    baselineFirstNegative: run.base_first_neg,
    scenarioFirstNegative: run.scen_first_neg,
    worstMonth: run.worst_month,
    worstBalance: run.worst_balance,
    maxCashGap: run.max_gap,
    recoveryMonth: run.recovery_month,
    monthCount: run.month_count,
    nullMonthCount: run.null_month_count,
  };
  const insights = isUnified && run.notes
    ? String(run.notes).split(/(?<=\.)\s+/).filter(Boolean)
    : buildScenarioInsights(comparison, run.assumptions as ScenarioAssumptions);

  const chartLines: ScenarioLine[] =
    weeks.length > 0
      ? weeks.map((w) => ({
          month_start: w.weekStart,
          base_close: w.baselineClosingCash,
          scen_close: w.scenarioClosingCash,
        }))
      : lines;

  const cards: Array<[string, string, boolean?]> = [
    ["Final Kasa (Baz)", fmt0(run.base_final)],
    ["Final Kasa (Senaryo)", fmt0(run.scen_final)],
    [
      "Net Fark (Δ)",
      (run.final_delta != null && run.final_delta > 0 ? "+" : "") + fmt0(run.final_delta),
      run.final_delta != null && run.final_delta < 0,
    ],
    ["İlk Eksi / İhlal Tarihi", ym(run.scen_first_neg), !!run.scen_first_neg],
    [
      "En Düşük Kasa",
      `${ym(run.worst_month)} · ${fmt0(run.worst_balance)}`,
      run.worst_balance != null && run.worst_balance < 0,
    ],
    ["Maks. Nakit Açığı", fmt0(run.max_gap), run.max_gap != null && run.max_gap > 0],
    ["Toparlanma Tarihi", ym(run.recovery_month)],
  ];

  return (
    <>
      <Disclaimer tone="accent">
        Senaryo çıktısı simülasyondur; muhasebe defteri ve banka bakiyelerini değiştirmez.
      </Disclaimer>

      <Panel
        title={run.name}
        right={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={isUnified ? "blue" : "neutral"}>
              {isUnified ? "13H Birleşik Dinamik" : "Aylık Klasik"}
            </Badge>
            <Badge tone={CONF_TONE[run.confidence] ?? "neutral"}>güven: {run.confidence}</Badge>
            <Link
              href={`/scenarios/compare?a=${run.id}`}
              className="button-ghost px-2.5 py-1 text-xs"
            >
              Karşılaştır →
            </Link>
            <Link
              href="/scenarios"
              className="text-xs font-medium underline underline-offset-2"
              style={{ color: "var(--text-2)" }}
            >
              ← Senaryolar
            </Link>
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {cards.map(([k, v, bad]) => (
            <KpiCard key={k} label={k} value={v} tone={bad ? "neg" : "neutral"} />
          ))}
        </div>

        {isUnified ? (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <KpiCard
              label="Otomatik BCH Çekimi"
              value={fmtTL(run.total_auto_facility_draw ?? 0)}
              tone={(run.total_auto_facility_draw ?? 0) > 0 ? "warn" : "pos"}
            />
            <KpiCard
              label="Ek 780 Faiz + BSMV + KKDF"
              value={fmtTL(run.total_incremental_interest_tax ?? 0)}
              tone={(run.total_incremental_interest_tax ?? 0) > 0 ? "neg" : "pos"}
            />
            <KpiCard
              label="Ufuk Sonu Devreden Alacak"
              value={fmtTL(run.deferred_receivables_carryover ?? 0)}
              tone="info"
              note="Buharlaşmayan devir"
            />
            <KpiCard
              label="Proforma Yıllık EBITDA"
              value={run.projected_ebitda_try != null ? fmtTL(run.projected_ebitda_try) : "—"}
              tone="neutral"
            />
            <KpiCard
              label="Min Proforma DSCR"
              value={run.projected_min_dscr != null ? `${run.projected_min_dscr.toFixed(2)}x` : "—"}
              tone={
                run.projected_min_dscr != null && run.projected_min_dscr < 1.2
                  ? "neg"
                  : "pos"
              }
            />
            <KpiCard
              label="Kovenant İhlal Sayısı"
              value={run.covenant_breach_count}
              tone={run.covenant_breach_count > 0 ? "neg" : "pos"}
            />
          </div>
        ) : null}

        <div className="mt-2 font-mono text-[11px]" style={{ color: "var(--text-3)" }}>
          Baz: {run.baseline_label ?? "Canlı 13H Likidite"} · {isUnified ? `${weeks.length} hafta` : `${run.month_count} ay`}
          {run.null_month_count > 0 ? ` · ${run.null_month_count} belirsiz dönem` : ""} · {run.run_at}
        </div>
        <div className="mt-3">
          <SourceProofDisclosure
            label="senaryo kanıt paketi"
            items={[
              {
                key: run.id,
                title: isUnified ? "13H Birleşik Nakit + BCH + DSCR Simülasyonu" : "Baz nakit akış + açık varsayımlar",
                value: `${isUnified ? `${weeks.length} hafta` : `${run.month_count} ay`} / güven ${run.confidence}`,
                confidence: run.confidence === "low" ? "needs_review" : "calculated",
                freshness: run.run_at,
                explanation:
                  "Senaryo kaynak kayıtları değiştirmez; baz likidite projeksiyonu üzerine kur, vade, BCH ve kovenant katmanlarını uygular.",
                sourceHref: isUnified ? "/cashflow/13-week" : "/cashflow",
              },
            ]}
          />
        </div>
      </Panel>

      <Panel title="VARSAYIMLAR (AÇIK BEYAN)">
        {assumptions.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-3)" }}>
            Varsayım uygulanmadı — senaryo baz projeksiyona eşittir.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {assumptions.map((a, i) => (
              <li key={i} className="text-xs" style={{ color: "var(--text-2)" }}>
                • {a.description}:{" "}
                <span className="font-mono font-semibold" style={{ color: "var(--accent)" }}>
                  {a.unit === "oran"
                    ? `%${((a.value ?? 0) * 100).toFixed(1)}`
                    : a.unit === "bayrak"
                      ? "evet"
                      : a.unit === "TRY"
                        ? fmtTL(a.value ?? 0)
                        : `${a.value ?? 0} ${a.unit}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="ANALİTİK İÇGÖRÜ (DETERMİNİSTİK)">
        <ul className="space-y-1">
          {insights.map((s, i) => (
            <li key={i} className="text-xs" style={{ color: "var(--text-2)" }}>
              • {s}
            </li>
          ))}
        </ul>
      </Panel>

      <ChartShell
        title={isUnified ? "Baz vs Senaryo — 13 Haftalık Kasa ve Tampon Yörüngesi" : "Baz vs Senaryo — Kasa"}
        hint="kesikli: baz · düz: senaryo · kehribar çizgi: asgari kasa tamponu"
        source="Baz projeksiyon değiştirilmez; senaryo yalnız simülasyon katmanıdır."
        summary={`Baz final kasa ${fmt0(run.base_final)}, senaryo final kasa ${fmt0(run.scen_final)}, fark ${fmt0(run.final_delta)}.`}
      >
        <ScenarioChart lines={chartLines} minCashBuffer={minCashBuffer} />
      </ChartShell>

      {weeks.length > 0 ? (
        <Panel
          title={`13 HAFTALIK BİRLEŞİK LİKİDİTE, BCH LİMİT VE DSCR KIRILIMI — ${weeks.length} HAFTA`}
          subtitle="Haftalık baz/senaryo nakit akışı, otomatik rotatif kredi çekimi, ek 780 faiz+vergi yükü ve kalan kredi limiti boşluğu"
        >
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left uppercase" style={{ borderColor: "var(--line)", color: "var(--text-3)" }}>
                  <th className="py-1.5 pr-2">Hafta</th>
                  <th className="py-1.5 pr-2 text-right">Baz Giriş</th>
                  <th className="py-1.5 pr-2 text-right">Senaryo Giriş</th>
                  <th className="py-1.5 pr-2 text-right">Senaryo Çıkış</th>
                  <th className="py-1.5 pr-2 text-right">Oto. BCH Çekim</th>
                  <th className="py-1.5 pr-2 text-right">Ek Faiz+Vergi</th>
                  <th className="py-1.5 pr-2 text-right">Baz Kasa</th>
                  <th className="py-1.5 pr-2 text-right">Senaryo Kasa</th>
                  <th className="py-1.5 pr-2 text-right">Kalan Limit</th>
                  <th className="py-1.5 text-right">DSCR / Kovenant</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => (
                  <tr
                    key={w.weekIndex}
                    className="border-b"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  >
                    <td className="py-1.5 pr-2 font-mono">
                      H{w.weekIndex} · {w.weekStart}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{fmtTL(w.baselineInflow)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{fmtTL(w.scenarioInflow)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{fmtTL(w.scenarioOutflow)}</td>
                    <td
                      className="py-1.5 pr-2 text-right font-mono tabular-nums"
                      style={{ color: w.autoFacilityDraw > 0 ? "var(--warn)" : "var(--text-3)" }}
                    >
                      {w.autoFacilityDraw > 0 ? fmtTL(w.autoFacilityDraw) : "—"}
                    </td>
                    <td
                      className="py-1.5 pr-2 text-right font-mono tabular-nums"
                      style={{ color: w.incrementalInterestTax > 0 ? "var(--neg)" : "var(--text-3)" }}
                    >
                      {w.incrementalInterestTax > 0 ? fmtTL(w.incrementalInterestTax) : "—"}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                      {w.baselineClosingCash != null ? fmtTL(w.baselineClosingCash) : "—"}
                    </td>
                    <td
                      className={`py-1.5 pr-2 text-right font-mono font-semibold tabular-nums ${
                        (w.scenarioClosingCash ?? 0) < 0 ? "text-neg" : ""
                      }`}
                    >
                      {w.scenarioClosingCash != null ? fmtTL(w.scenarioClosingCash) : "—"}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                      {fmtTL(w.remainingFacilityHeadroom)}
                    </td>
                    <td className="py-1.5 text-right">
                      {w.covenantBreach ? (
                        <Badge tone="red">İhlal ({w.projectedDscr != null ? `${w.projectedDscr.toFixed(2)}x` : "—"})</Badge>
                      ) : (
                        <span className="font-mono tabular-nums" style={{ color: "var(--pos)" }}>
                          {w.projectedDscr != null ? `${w.projectedDscr.toFixed(2)}x` : "OK"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

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
                  <td className={`py-1 pr-2 text-right font-mono tabular-nums ${v != null && v < 0 ? "text-neg" : ""}`}>
                    {v != null ? fmt0(v) : "—"}
                  </td>
                );
                return (
                  <tr key={l.month_start} className="border-b border-line-faint">
                    <td className="py-1 pr-2 font-mono text-xs">{l.month_start.slice(0, 7)}</td>
                    {cell(l.base_inc)}
                    {cell(l.scen_inc)}
                    {cell(l.base_exp)}
                    {cell(l.scen_exp)}
                    {cell(l.base_close)}
                    {cell(l.scen_close)}
                    <td
                      className={`py-1 text-right font-mono tabular-nums ${
                        l.delta != null && l.delta < 0
                          ? "text-neg"
                          : l.delta != null && l.delta > 0
                            ? "text-pos"
                            : "text-tone-3"
                      }`}
                    >
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
        <button
          type="submit"
          className="border px-3 py-1.5 text-xs font-medium hover:text-neg"
          style={{
            borderColor: "var(--line-strong)",
            background: "var(--surface-2)",
            color: "var(--text-2)",
          }}
        >
          Bu çalıştırmayı sil (yalnız senaryo kaydı)
        </button>
      </form>
    </>
  );
}
