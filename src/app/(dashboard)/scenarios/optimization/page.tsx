import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Num, Panel } from "@/components/ui/panel";
import { EmptyState, PageHeader } from "@/components/ui/shell";
import { getPool } from "@/lib/db";
import { formatMoney } from "@/lib/money-format";
import { loadOptimizationRuns, loadRecommendations } from "@/lib/optimization/engine";
import { RULE_LABEL, type RuleCode } from "@/lib/optimization/rules";
import { estimateOptimizationCandidates } from "@/lib/scenarios/engine";
import {
  requestOptimizationApprovalAction,
  runLiquidityOptimizationAction,
  runOptimizationCandidateAction,
} from "../actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const OBJECTIVE_LABEL_TR: Record<string, string> = {
  max_liquidity_buffer: "Maksimum likidite tamponu",
  min_financing_cost: "Minimum finansman maliyeti",
  min_late_payment: "Minimum gecikmeli ödeme",
};

const ACTION_KIND_LABEL_TR: Record<string, string> = {
  defer_payment: "Ödeme erteleme önerisi",
  advance_payment: "Erken ödeme önerisi",
  draw_facility: "Rotatif kredi limiti çekimi",
  repay_facility: "Fazla nakit ile kredi geri ödemesi",
  hold_buffer: "Tampon / sert vade uyarısı",
};

export default async function OptimizationPage({
  searchParams,
}: {
  searchParams: Promise<{ runId?: string }>;
}) {
  const denied = await requireRouteAccess("/scenarios/optimization");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const todayISO = new Date().toISOString().slice(0, 10);

  const [rows, solverRuns] = await Promise.all([
    estimateOptimizationCandidates(pool),
    loadOptimizationRuns(pool, 20).catch(() => []),
  ]);

  const activeRunId = sp.runId ?? solverRuns[0]?.runId ?? null;
  const activeRecs = activeRunId
    ? await loadRecommendations(pool, activeRunId).catch(() => [])
    : [];
  const activeRun = solverRuns.find((r) => r.runId === activeRunId) ?? null;

  return (
    <>
      <PageHeader
        title="Likidite Optimizasyonu & Senaryo Adayları"
        subtitle="Deterministik nakit tabanı çözücüsü (Faz 29/46) ve makro senaryo adayları; kaynak kayıtları doğrudan değiştirmez, onay kuyruğuna öneri üretir."
      />

      <Panel
        title="DETERMİNİSTİK LİKİDİTE OPTİMİZASYON ÇÖZÜCÜSÜ (FAZ 29 / FAZ 46)"
        subtitle="Ödeme takvimi, çek vadeleri, kredi taksitleri, açık alım faturaları ve kullanılabilir rotatif limitleri birlikte tarayarak asgari nakit tabanını koruyacak öneriler üretir."
      >
        <form action={runLiquidityOptimizationAction} className="grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="sm:col-span-2">
            <label className="block font-mono text-[10px] uppercase text-tone-3">Çalışma Adı</label>
            <input
              type="text"
              name="name"
              defaultValue={`90G Likidite Çözücü (${todayISO})`}
              className="mt-0.5 w-full border border-line bg-ink px-2 py-1.5 font-mono text-xs text-tone-1"
            />
          </div>
          <div>
            <label className="block font-mono text-[10px] uppercase text-tone-3">Amaç Fonksiyonu</label>
            <select
              name="objective"
              defaultValue="max_liquidity_buffer"
              className="mt-0.5 w-full border border-line bg-ink px-2 py-1.5 font-mono text-xs text-tone-1"
            >
              <option value="max_liquidity_buffer">Maksimum likidite tamponu</option>
              <option value="min_financing_cost">Minimum finansman maliyeti</option>
              <option value="min_late_payment">Minimum gecikmeli ödeme</option>
            </select>
          </div>
          <div>
            <label className="block font-mono text-[10px] uppercase text-tone-3">Başlangıç Tarihi</label>
            <input
              type="date"
              name="anchorDate"
              defaultValue={todayISO}
              className="mt-0.5 w-full border border-line bg-ink px-2 py-1.5 font-mono text-xs text-tone-1"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block font-mono text-[10px] uppercase text-tone-3">Ufuk (Gün)</label>
              <input
                type="number"
                name="horizonDays"
                min={7}
                max={365}
                defaultValue={90}
                className="mt-0.5 w-full border border-line bg-ink px-2 py-1.5 font-mono text-xs text-tone-1"
              />
            </div>
            <div>
              <label className="block font-mono text-[10px] uppercase text-tone-3">Döviz</label>
              <select
                name="currency"
                defaultValue="TRY"
                className="mt-0.5 w-full border border-line bg-ink px-2 py-1.5 font-mono text-xs text-tone-1"
              >
                <option value="TRY">TRY</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </div>
          </div>
          <div className="flex items-end">
            <button type="submit" className="button-accent w-full px-3 py-1.5 text-xs">
              Çözücüyü Çalıştır
            </button>
          </div>
        </form>

        {solverRuns.length === 0 ? (
          <div className="mt-3">
            <EmptyState>
              Henüz kayıtlı deterministik optimizasyon çalışması yok. Yukarıdan amaç fonksiyonunu seçip çözücüyü çalıştırabilirsiniz.
            </EmptyState>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-tone-3">
                Son Optimizasyon Çalışmaları ({solverRuns.length})
              </div>
              <div className="divide-y divide-line-faint border border-line">
                {solverRuns.map((run) => {
                  const selected = run.runId === activeRunId;
                  return (
                    <div
                      key={run.runId}
                      className={`flex items-center justify-between gap-2 px-2.5 py-2 text-xs ${
                        selected ? "bg-accent/10" : "hover:bg-surface-2"
                      }`}
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/scenarios/optimization?runId=${run.runId}`}
                          className="block truncate font-mono font-medium text-tone-1 hover:text-accent"
                        >
                          {run.name}
                        </Link>
                        <div className="mt-0.5 font-mono text-[11px] text-tone-3">
                          {OBJECTIVE_LABEL_TR[run.objective] ?? run.objective} · {run.anchorDate} · {run.horizonDays}g
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Badge tone={run.recommendationCount > 0 ? "amber" : "green"}>
                          {run.recommendationCount} öneri
                        </Badge>
                        {run.approvalStatus && (
                          <Badge tone={run.approvalStatus === "approved" ? "green" : "blue"}>
                            {run.approvalStatus}
                          </Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="lg:col-span-7">
              {activeRun ? (
                <div className="border border-line bg-surface-2 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
                    <div>
                      <div className="font-mono text-xs font-semibold text-tone-1">{activeRun.name}</div>
                      <div className="font-mono text-[11px] text-tone-3">
                        {OBJECTIVE_LABEL_TR[activeRun.objective] ?? activeRun.objective} · Toplam Etki:{" "}
                        {formatMoney(activeRun.totalExpectedEffect, activeRun.currency)} · Digest:{" "}
                        {activeRun.resultDigest?.slice(0, 24) ?? "—"}
                      </div>
                    </div>
                    {activeRun.recommendationCount > 0 && !activeRun.approvalStatus && (
                      <form action={requestOptimizationApprovalAction}>
                        <input type="hidden" name="runId" value={activeRun.runId} />
                        <button type="submit" className="button-accent px-2.5 py-1 text-xs">
                          Onay Kuyruğuna Gönder
                        </button>
                      </form>
                    )}
                  </div>

                  {activeRecs.length === 0 ? (
                    <p className="py-3 font-mono text-xs text-tone-2">
                      {activeRun.resultDigest === "halted:unknown_opening_balance"
                        ? "Açılış bakiyesi bilinmeyen aktif hesap bulunduğu için simülasyon durduruldu (FIN-03 koruması)."
                        : "Ufuk boyunca nakit tabanı ihlali tespit edilmedi; erteleme veya kredi çekimi önerisi gerekmiyor."}
                    </p>
                  ) : (
                    <table className="mt-2 w-full text-xs">
                      <thead>
                        <tr className="border-b border-line text-left font-mono text-[10px] uppercase text-tone-3">
                          <th className="py-1 pr-2">#</th>
                          <th className="py-1 pr-2">Aksiyon</th>
                          <th className="py-1 pr-2">Kalem / Limit</th>
                          <th className="py-1 pr-2">Mevcut → Önerilen</th>
                          <th className="py-1 pr-2 text-right">Tutar</th>
                          <th className="py-1">Gerekçe Kuralı</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeRecs.map((rec) => (
                          <tr key={rec.id} className="border-b border-line-faint align-top">
                            <td className="py-1.5 pr-2 font-mono"><Num>{rec.rank}</Num></td>
                            <td className="py-1.5 pr-2">
                              <Badge
                                tone={
                                  rec.actionKind === "defer_payment"
                                    ? "amber"
                                    : rec.actionKind === "draw_facility"
                                      ? "blue"
                                      : rec.actionKind === "repay_facility"
                                        ? "green"
                                        : "red"
                                }
                              >
                                {ACTION_KIND_LABEL_TR[rec.actionKind] ?? rec.actionKind}
                              </Badge>
                            </td>
                            <td className="py-1.5 pr-2 font-mono text-tone-1">
                              {rec.subjectLabel ?? "—"}
                            </td>
                            <td className="py-1.5 pr-2 font-mono text-tone-2">
                              {rec.currentDate ?? "—"} → {rec.proposedDate ?? "—"}
                              {rec.shiftDays != null ? ` (+${rec.shiftDays}g)` : ""}
                            </td>
                            <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                              {rec.amount != null ? formatMoney(rec.amount, rec.currency) : "—"}
                            </td>
                            <td className="py-1.5 text-[11px] text-tone-2">
                              <div>
                                {rec.rationaleCodes
                                  .map((c) => RULE_LABEL[c as RuleCode] ?? c)
                                  .join(" · ")}
                              </div>
                              {rec.rationaleNote && (
                                <div className="mt-0.5 text-tone-3">{rec.rationaleNote}</div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </Panel>

      <div className="mt-4 mb-2 font-mono text-xs uppercase tracking-wider text-tone-3">
        Makro Senaryo Optimizasyon Adayları ({rows.length})
      </div>
      {rows.map((r, i) => (
        <Panel
          key={r.key}
          title={`${i + 1}. ${r.label}`}
          right={<span className="text-xs">güven: {r.confidence}</span>}
        >
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <span>
              Final nakit
              <br />
              <b>{fmtTL(r.finalCash)}</b>
            </span>
            <span>
              Final fark
              <br />
              <b>{fmtTL(r.finalDelta)}</b>
            </span>
            <span>
              Maksimum açık
              <br />
              <b className="text-neg">{fmtTL(r.maxCashGap)}</b>
            </span>
            <span>
              İlk negatif
              <br />
              <b>{r.firstNegative?.slice(0, 7) ?? "yok"}</b>
            </span>
          </div>
          <details className="mt-3 border-t border-line-faint pt-2">
            <summary className="cursor-pointer text-xs text-info">Varsayımları göster</summary>
            <pre className="mt-2 whitespace-pre-wrap text-xs text-tone-3">
              {JSON.stringify(r.assumptions, null, 2)}
            </pre>
          </details>
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={runOptimizationCandidateAction}>
              <input type="hidden" name="candidateKey" value={r.key} />
              <button className="button-accent px-2 py-1">Çalıştır ve kaydet</button>
            </form>
            <Link className="button-ghost px-2 py-1" href={`/scenarios?candidate=${r.key}`}>
              Varsayımları düzenle
            </Link>
            <Link className="button-ghost px-2 py-1" href="/scenarios/compare">
              Karşılaştırmaya ekle
            </Link>
          </div>
        </Panel>
      ))}
    </>
  );
}
