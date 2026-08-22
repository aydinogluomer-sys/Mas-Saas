import { getPool } from "@/lib/db";
import {
  loadBudgetVsActual, loadCashForecast13w, loadForecastAccuracy, loadForecastCoverage,
} from "@/lib/budget/engine";
import { SOURCE_LABEL, VERDICT_LABEL, type SourceKind } from "@/lib/budget/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

const VERDICT_TONE: Record<string, Tone> = {
  over_budget: "red",
  within_budget: "green",
  under_target: "amber",
  on_or_above_target: "green",
  not_measured: "neutral",
};

export default async function BudgetPage() {
  const pool = getPool();
  const [rows, weeks, accuracy, coverage] = await Promise.all([
    loadBudgetVsActual(pool),
    loadCashForecast13w(pool),
    loadForecastAccuracy(pool),
    loadForecastCoverage(pool),
  ]);

  const overBudget = rows.filter((r) => r.verdict === "over_budget");
  const notMeasured = rows.filter((r) => r.verdict === "not_measured");
  const budgetTotal = rows.reduce((s, r) => s + r.budgetAmount, 0);
  const actualTotal = rows.reduce((s, r) => s + (r.actualAmount ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Bütçe ve Rolling Forecast"
        subtitle="Bütçe-gerçekleşen varyansı, 13 haftalık nakit ufku ve tahmin doğruluğu"
        meta={<Badge tone={overBudget.length > 0 ? "red" : "green"} dot>
          {overBudget.length > 0 ? `${overBudget.length} kalemde aşım` : "bütçe içinde"}
        </Badge>}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Bütçe (onaylı)" value={fmtTL(budgetTotal)} tone="info" />
        <KeyStat label="Gerçekleşen" value={fmtTL(actualTotal)} tone={actualTotal > budgetTotal ? "warn" : "pos"} />
        <KeyStat label="Aşım kalemi" value={overBudget.length} tone={overBudget.length > 0 ? "neg" : "pos"} />
        {/* Never folded into the totals: an unmeasured line is not a zero-variance line. */}
        <KeyStat label="Ölçülmemiş kalem" value={notMeasured.length}
          tone={notMeasured.length > 0 ? "warn" : "pos"} />
      </div>

      <Panel title="BÜTÇE / GERÇEKLEŞEN" subtitle="yalnız ONAYLI satırlar ölçülür — taslak ve eski versiyonlar hariç">
        {rows.length === 0 ? (
          <EmptyState>Onaylı bütçe satırı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Dönem</th><th>Yön</th><th>Boyut</th>
                  <th className="text-right">Bütçe</th><th className="text-right">Gerçekleşen</th>
                  <th className="text-right">Fark</th><th className="text-right">Oran</th><th>Karar</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lineId} className="border-t border-neutral-800">
                    <td className="py-2 tabular-nums">{r.periodStart.slice(0, 7)}</td>
                    <td className="text-xs">{r.direction === "income" ? "gelir" : "gider"}</td>
                    <td className="text-xs text-neutral-400">
                      {r.costCenterName ?? r.projectName ?? r.departmentName ?? "—"}
                      {/* Explains a missing actual instead of leaving a blank cell: no
                          transaction table carries a department, so it cannot be measured. */}
                      {r.departmentScoped && r.actualAmount == null
                        ? <span className="block text-amber-400">departman gerçekleşeni izlenemiyor</span>
                        : null}
                    </td>
                    <td className="text-right tabular-nums">{fmtTL(r.budgetAmount)}</td>
                    <td className="text-right tabular-nums">
                      {r.actualAmount == null
                        ? <span className="text-neutral-600">ölçülmedi</span>
                        : fmtTL(r.actualAmount)}
                    </td>
                    <td className={`text-right tabular-nums ${r.verdict === "over_budget" ? "text-red-400" : ""}`}>
                      {r.varianceAmount == null ? "—" : fmtTL(r.varianceAmount)}
                    </td>
                    <td className="text-right tabular-nums text-neutral-500">
                      {r.varianceRatio == null ? "—" : `%${(r.varianceRatio * 100).toFixed(1)}`}
                    </td>
                    <td><Badge tone={VERDICT_TONE[r.verdict] ?? "neutral"}>
                      {VERDICT_LABEL[r.verdict as keyof typeof VERDICT_LABEL] ?? r.verdict}
                    </Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="13 HAFTALIK NAKİT UFKU" subtitle="boş haftalar dahil — eksik hafta sessizce düşmez">
        {weeks.length === 0 ? (
          <EmptyState>Aktif 13 haftalık tahmin yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Hafta</th><th>Aralık</th>
                  <th className="text-right">Giriş</th><th className="text-right">Çıkış</th>
                  <th className="text-right">Net</th>
                  <th className="text-right">Net (yalnız sözleşmeli)</th>
                  <th className="text-right">Net (güven ağırlıklı)</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => (
                  <tr key={`${w.forecastId}-${w.weekNo}`} className="border-t border-neutral-800">
                    <td className="py-2 tabular-nums">{w.weekNo}</td>
                    <td className="text-xs tabular-nums">{w.weekStart} → {w.weekEnd}</td>
                    <td className="text-right tabular-nums">{fmtTL(w.inflow)}</td>
                    <td className="text-right tabular-nums">{fmtTL(w.outflow)}</td>
                    <td className={`text-right tabular-nums ${w.netFlow < 0 ? "text-red-400" : ""}`}>
                      {fmtTL(w.netFlow)}
                    </td>
                    {/* The conservative number, kept beside the headline rather than instead of
                        it: what survives if every estimate turns out wrong. */}
                    <td className="text-right tabular-nums text-neutral-500">{fmtTL(w.netFlowContracted)}</td>
                    <td className="text-right tabular-nums text-neutral-500">
                      {fmtTL(w.netFlowConfidenceWeighted)}
                      {w.estimatedLineCount > 0
                        ? <span className="block text-[10px] text-amber-400">{w.estimatedLineCount} tahmini</span>
                        : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="TAHMİN DOĞRULUĞU" subtitle="yalnız ölçülmüş satırlar — ölçülmemiş satır mükemmel sayılmaz">
        {accuracy.length === 0 ? (
          <EmptyState>Henüz gerçekleşen kaydedilmiş tahmin satırı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Tahmin</th><th>Kaynak</th>
                  <th className="text-right">Ölçülen satır</th>
                  <th className="text-right">Tahmin</th><th className="text-right">Gerçekleşen</th>
                  <th className="text-right">Sapma (işaretli)</th><th className="text-right">MAPE</th>
                </tr>
              </thead>
              <tbody>
                {accuracy.map((a) => (
                  <tr key={`${a.forecastId}-${a.sourceKind}`} className="border-t border-neutral-800">
                    <td className="py-2">{a.forecastName}
                      <span className="block text-xs text-neutral-600">{a.horizonKind}</span>
                    </td>
                    <td className="text-xs">{SOURCE_LABEL[a.sourceKind as SourceKind] ?? a.sourceKind}</td>
                    <td className="text-right tabular-nums">{a.measuredLineCount}</td>
                    <td className="text-right tabular-nums">{a.forecastTotal == null ? "—" : fmtTL(a.forecastTotal)}</td>
                    <td className="text-right tabular-nums">{a.actualTotal == null ? "—" : fmtTL(a.actualTotal)}</td>
                    <td className="text-right tabular-nums">{a.biasTotal == null ? "—" : fmtTL(a.biasTotal)}</td>
                    <td className="text-right tabular-nums">
                      {a.mape == null
                        ? <span className="text-neutral-600">hesaplanamaz</span>
                        : `%${(a.mape * 100).toFixed(1)}`}
                      {a.zeroForecastLines > 0
                        ? <span className="block text-[10px] text-neutral-600">{a.zeroForecastLines} sıfır tahmin hariç</span>
                        : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="TAHMİN KAPSAMI" subtitle="rahat bir tahmin sözleşmelere mi tahminlere mi dayanıyor">
        {coverage.length === 0 ? (
          <EmptyState>Kayıtlı tahmin yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Tahmin</th><th className="text-right">Satır</th>
                  <th className="text-right">Onaylı</th><th className="text-right">Taslak</th>
                  <th className="text-right">Ölçülen</th><th className="text-right">Sözleşmeli</th>
                  <th className="text-right">Tahmini</th>
                </tr>
              </thead>
              <tbody>
                {coverage.map((c) => (
                  <tr key={c.forecastId} className="border-t border-neutral-800">
                    <td className="py-2">{c.forecastName}</td>
                    <td className="text-right tabular-nums">{c.lineCount}</td>
                    <td className="text-right tabular-nums">{c.approvedCount}</td>
                    <td className="text-right tabular-nums text-neutral-500">{c.draftCount}</td>
                    <td className="text-right tabular-nums">
                      {c.measuredCount}
                      {c.measuredRatio != null
                        ? <span className="block text-[10px] text-neutral-600">%{(c.measuredRatio * 100).toFixed(0)}</span>
                        : null}
                    </td>
                    <td className="text-right tabular-nums text-emerald-400">{c.contractedCount}</td>
                    <td className="text-right tabular-nums text-amber-400">{c.estimatedCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>
    </>
  );
}
