import { getRequestUser } from "@/lib/auth";
import { can, canApprovePlanningLines } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import {
  loadBudgetsCatalog,
  loadBudgetVarianceSummary,
  loadBudgetVsActual,
  loadCashForecast13w,
  loadForecastAccuracy,
  loadForecastCoverage,
} from "@/lib/budget/engine";
import { SOURCE_LABEL, VERDICT_LABEL, type SourceKind } from "@/lib/budget/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { isReportingCurrency } from "@/lib/currency-policy";
import { getPool } from "@/lib/db";
import { formatMoney } from "@/lib/money-format";
import {
  addBudgetLineAction,
  approveBudgetVersionAction,
  createBudgetAction,
  createForecastAction,
  createForecastLineAction,
  recordActualAction,
  setLineVersionAction,
  submitBudgetForApprovalAction,
} from "./actions";

export const dynamic = "force-dynamic";

const VERDICT_TONE: Record<string, Tone> = {
  over_budget: "red",
  within_budget: "green",
  under_target: "amber",
  on_or_above_target: "green",
  not_measured: "neutral",
};

const VERSION_TONE: Record<string, Tone> = {
  draft: "amber",
  approved: "green",
  superseded: "neutral",
};

const VERSION_TR: Record<string, string> = {
  draft: "taslak",
  approved: "onaylı",
  superseded: "eski versiyon",
};

const INPUT_STYLE = {
  background: "var(--surface-1)",
  borderColor: "var(--line)",
  color: "var(--text-1)",
} as const;

const CARD_STYLE = {
  background: "var(--surface-2)",
  borderColor: "var(--line)",
  color: "var(--text-1)",
} as const;

export default async function BudgetPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; result?: string }>;
}) {
  const denied = await requireRouteAccess("/cashflow/budget");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const session = await getRequestUser();
  const canEnter = session ? can(session.role, "budgets", "insert") : false;
  const canUpdateBudgetLines = session ? can(session.role, "budget_lines", "update") : false;
  const canUpdateForecastLines = session ? can(session.role, "forecast_lines", "update") : false;
  const canApprove = session ? canApprovePlanningLines(session.role) : false;

  const pool = getPool();
  const [rows, varianceSummaries, weeks, accuracy, coverage, catalog] = await Promise.all([
    loadBudgetVsActual(pool),
    loadBudgetVarianceSummary(pool),
    loadCashForecast13w(pool),
    loadForecastAccuracy(pool),
    loadForecastCoverage(pool),
    loadBudgetsCatalog(pool),
  ]);

  const overBudget = rows.filter((r) => r.verdict === "over_budget");
  const notMeasured = rows.filter((r) => r.verdict === "not_measured");
  const tryRows = rows.filter((r) => isReportingCurrency(r.currency));
  const foreignRows = rows.length - tryRows.length;
  const budgetTotal = tryRows.reduce((s, r) => s + r.budgetAmount, 0);
  const actualTotal = tryRows.reduce((s, r) => s + (r.actualAmount ?? 0), 0);
  const currentYear = new Date().getFullYear();
  const todayIso = new Date().toISOString().slice(0, 10);
  const monthStartIso = `${todayIso.slice(0, 7)}-01`;

  return (
    <>
      <PageHeader
        title="Bütçe ve Rolling Forecast"
        subtitle="Bütçe tanımlama, maker-checker versiyon onayı, gerçekleşen varyansı ve 13 haftalık nakit ufku"
        meta={
          <Badge tone={overBudget.length > 0 ? "red" : "green"} dot>
            {overBudget.length > 0 ? `${overBudget.length} kalemde aşım` : "bütçe içinde"}
          </Badge>
        }
      />

      {sp.error ? (
        <div className="rounded border border-neg/40 bg-neg/10 px-3 py-2 text-xs text-neg">{sp.error}</div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-pos/40 bg-pos/10 px-3 py-2 text-xs text-pos">
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat
          label="Bütçe (onaylı, TRY)"
          value={fmtTL(budgetTotal)}
          tone="info"
          sub={foreignRows > 0 ? `${foreignRows} satır TRY-dışı — toplamda yok` : undefined}
        />
        <KeyStat
          label="Gerçekleşen (TRY)"
          value={fmtTL(actualTotal)}
          tone={actualTotal > budgetTotal ? "warn" : "pos"}
        />
        <KeyStat label="Aşım kalemi" value={overBudget.length} tone={overBudget.length > 0 ? "neg" : "pos"} />
        <KeyStat
          label="Ölçülmemiş kalem"
          value={notMeasured.length}
          tone={notMeasured.length > 0 ? "warn" : "pos"}
        />
      </div>

      <Panel
        title={`BÜTÇE SAPMA ÖZETİ — ${varianceSummaries.length}`}
        subtitle="Bütçe kabı, yön ve döviz bazında toplulaştırılmış bütçe / gerçekleşen / sapma ve aşım özeti"
      >
        {varianceSummaries.length === 0 ? (
          <EmptyState>Henüz onaylı bütçe sapma özeti kaydı bulunmuyor.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1.5">Bütçe</th>
                  <th>Yıl</th>
                  <th>Yön</th>
                  <th>Döviz</th>
                  <th className="text-right">Satır</th>
                  <th className="text-right">Bütçe Toplamı</th>
                  <th className="text-right">Gerçekleşen</th>
                  <th className="text-right">Sapma</th>
                  <th className="text-right">Aşım Kalemi</th>
                  <th className="text-right">Ölçülmemiş</th>
                </tr>
              </thead>
              <tbody>
                {varianceSummaries.map((vs) => (
                  <tr
                    key={`${vs.budgetId}-${vs.direction}-${vs.currency}`}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-2 font-medium">{vs.budgetName}</td>
                    <td className="font-mono tabular-nums">{vs.fiscalYear}</td>
                    <td className="text-xs">{vs.direction === "income" ? "gelir" : "gider"}</td>
                    <td className="font-mono text-xs">{vs.currency}</td>
                    <td className="text-right font-mono tabular-nums">{vs.lineCount}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatMoney(vs.budgetTotal, vs.currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {vs.actualTotal == null ? "—" : formatMoney(vs.actualTotal, vs.currency)}
                    </td>
                    <td
                      className={`text-right font-mono tabular-nums ${
                        vs.varianceTotal != null && vs.varianceTotal < 0 ? "text-neg" : ""
                      }`}
                    >
                      {vs.varianceTotal == null ? "—" : formatMoney(vs.varianceTotal, vs.currency)}
                    </td>
                    <td className="text-right">
                      {vs.overBudgetLines > 0 ? (
                        <Badge tone="red">{vs.overBudgetLines} kalem</Badge>
                      ) : (
                        <span className="font-mono text-xs text-pos">0</span>
                      )}
                    </td>
                    <td className="text-right font-mono text-xs tabular-nums" style={{ color: "var(--text-2)" }}>
                      {vs.notMeasuredLines}
                      {vs.departmentLinesUnmeasurable > 0
                        ? ` (${vs.departmentLinesUnmeasurable} dep.)`
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      {(canEnter || canApprove || canUpdateBudgetLines || canUpdateForecastLines) ? (
        <Panel
          title="BÜTÇE VE TAHMİN YÖNETİMİ"
          subtitle="taslak bütçe/tahmin satırı girin, onaya gönderin, versiyon geçişi yapın (draft → approved / superseded) veya gerçekleşen tutar kaydedin"
        >
          <div className="grid gap-3 lg:grid-cols-2">
            {canEnter ? (
              <details className="rounded border p-3" style={CARD_STYLE} open={catalog.budgets.length === 0}>
                <summary className="cursor-pointer text-xs font-medium" style={{ color: "var(--text-1)" }}>
                  + Yeni Bütçe Kabı Oluştur
                </summary>
                <form action={createBudgetAction} className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <input
                    name="name"
                    required
                    placeholder={`Bütçe adı (ör. ${currentYear} Ana Bütçe)`}
                    className="col-span-2 rounded border px-2 py-1.5"
                    style={INPUT_STYLE}
                  />
                  <input
                    name="fiscalYear"
                    type="number"
                    min={2000}
                    max={2100}
                    defaultValue={currentYear}
                    required
                    className="rounded border px-2 py-1.5"
                    style={INPUT_STYLE}
                  />
                  <select name="periodKind" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                    <option value="monthly">Aylık (monthly)</option>
                    <option value="annual">Yıllık — 12 aya dağıtılır (annual)</option>
                  </select>
                  <select name="currency" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                    <option value="TRY">TRY</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                  <input
                    name="notes"
                    placeholder="Not (opsiyonel)"
                    className="rounded border px-2 py-1.5"
                    style={INPUT_STYLE}
                  />
                  <button className="button-accent col-span-2 px-3 py-1.5 font-medium">
                    Bütçe oluştur
                  </button>
                </form>
              </details>
            ) : null}

            {canEnter && catalog.budgets.length > 0 ? (
              <details className="rounded border p-3" style={CARD_STYLE} open={catalog.lines.length === 0}>
                <summary className="cursor-pointer text-xs font-medium" style={{ color: "var(--text-1)" }}>
                  + Taslak Bütçe Satırı Ekle
                </summary>
                <form action={addBudgetLineAction} className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <select
                    name="budgetId"
                    required
                    className="col-span-2 rounded border px-2 py-1.5"
                    style={INPUT_STYLE}
                  >
                    {catalog.budgets.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.fiscalYear} · {b.periodKind} · {b.currency})
                      </option>
                    ))}
                  </select>
                  <input
                    name="periodStart"
                    type="date"
                    defaultValue={monthStartIso}
                    required
                    className="rounded border px-2 py-1.5"
                    style={INPUT_STYLE}
                  />
                  <select name="direction" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                    <option value="expense">Gider (expense)</option>
                    <option value="income">Gelir (income)</option>
                  </select>
                  <input
                    name="amount"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    placeholder="Bütçe tutarı"
                    className="rounded border px-2 py-1.5"
                    style={INPUT_STYLE}
                  />
                  <select name="currency" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                    <option value="TRY">TRY</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                  <select name="costCenterId" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                    <option value="">Masraf merkezi (tümü)</option>
                    {catalog.costCenters.map((cc) => (
                      <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                    ))}
                  </select>
                  <select name="departmentId" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                    <option value="">Departman (tümü)</option>
                    {catalog.departments.map((d) => (
                      <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
                    ))}
                  </select>
                  <select name="projectId" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                    <option value="">Proje (tümü)</option>
                    {catalog.projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                    ))}
                  </select>
                  <select name="categoryId" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                    <option value="">Kategori (opsiyonel)</option>
                    {catalog.categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>{cat.name}</option>
                    ))}
                  </select>
                  <input
                    name="notes"
                    placeholder="Açıklama (opsiyonel)"
                    className="col-span-2 rounded border px-2 py-1.5"
                    style={INPUT_STYLE}
                  />
                  <button className="button-accent col-span-2 px-3 py-1.5 font-medium">
                    Taslak satır ekle
                  </button>
                </form>
              </details>
            ) : null}

            {canEnter ? (
              <details className="rounded border p-3" style={CARD_STYLE}>
                <summary className="cursor-pointer text-xs font-medium" style={{ color: "var(--text-1)" }}>
                  + 13 Haftalık Tahmin Kabı ve Satırı Ekle
                </summary>
                <div className="mt-3 space-y-3">
                  <form action={createForecastAction} className="grid grid-cols-2 gap-2 text-xs">
                    <input
                      name="name"
                      required
                      placeholder="Tahmin adı (ör. Q4 13H Nakit Tahmini)"
                      className="col-span-2 rounded border px-2 py-1.5"
                      style={INPUT_STYLE}
                    />
                    <input
                      name="anchorDate"
                      type="date"
                      defaultValue={todayIso}
                      required
                      className="rounded border px-2 py-1.5"
                      style={INPUT_STYLE}
                    />
                    <select name="horizonKind" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                      <option value="weekly_13">13 Haftalık (weekly_13)</option>
                      <option value="monthly_12">12 Aylık (monthly_12)</option>
                    </select>
                    <select name="currency" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                      <option value="TRY">TRY</option>
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                    </select>
                    <button className="rounded border px-3 py-1.5 font-medium" style={INPUT_STYLE}>
                      Tahmin kabı aç
                    </button>
                  </form>

                  {catalog.forecasts.length > 0 ? (
                    <form
                      action={createForecastLineAction}
                      className="grid grid-cols-2 gap-2 border-t pt-3 text-xs"
                      style={{ borderColor: "var(--line)" }}
                    >
                      <select
                        name="forecastId"
                        required
                        className="col-span-2 rounded border px-2 py-1.5"
                        style={INPUT_STYLE}
                      >
                        {catalog.forecasts.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name} ({f.anchorDate} · {f.currency})
                          </option>
                        ))}
                      </select>
                      <input
                        name="periodStart"
                        type="date"
                        defaultValue={todayIso}
                        required
                        className="rounded border px-2 py-1.5"
                        style={INPUT_STYLE}
                      />
                      <input
                        name="periodEnd"
                        type="date"
                        defaultValue={todayIso}
                        required
                        className="rounded border px-2 py-1.5"
                        style={INPUT_STYLE}
                      />
                      <select name="direction" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                        <option value="inflow">Giriş (inflow)</option>
                        <option value="outflow">Çıkış (outflow)</option>
                      </select>
                      <input
                        name="amount"
                        type="number"
                        step="0.01"
                        min="0"
                        required
                        placeholder="Tahmin tutarı"
                        className="rounded border px-2 py-1.5"
                        style={INPUT_STYLE}
                      />
                      <select name="sourceKind" className="rounded border px-2 py-1.5" style={INPUT_STYLE}>
                        <option value="contracted">Sözleşmeli (contracted)</option>
                        <option value="scheduled">Planlı (scheduled)</option>
                        <option value="historical">Tarihsel (historical)</option>
                        <option value="manual">Manuel (manual)</option>
                        <option value="estimated">Tahmini (estimated)</option>
                      </select>
                      <button className="button-accent px-3 py-1.5 font-medium">
                        Tahmin satırı ekle
                      </button>
                    </form>
                  ) : null}
                </div>
              </details>
            ) : null}

            {canApprove && catalog.budgets.some((b) => b.draftLines > 0) ? (
              <div className="rounded border p-3 text-xs" style={CARD_STYLE}>
                <div className="font-medium" style={{ color: "var(--text-1)" }}>
                  Toplu Bütçe Versiyonu Onayı (Maker ≠ Checker)
                </div>
                <p className="mt-1" style={{ color: "var(--text-2)" }}>
                  Başka bir kullanıcı tarafından girilmiş tüm taslak satırları onaylayarak varyans raporunu aktifleştirir.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {catalog.budgets
                    .filter((b) => b.draftLines > 0)
                    .map((b) => (
                      <form key={b.id} action={approveBudgetVersionAction}>
                        <input type="hidden" name="table" value="budget_lines" />
                        <input type="hidden" name="budgetId" value={b.id} />
                        <button className="button-accent px-2.5 py-1 font-medium">
                          {b.name} ({b.draftLines} taslak) onayla
                        </button>
                      </form>
                    ))}
                </div>
              </div>
            ) : null}
          </div>

          {catalog.lines.length > 0 ? (
            <div className="mt-4">
              <div className="mb-1 text-xs font-medium uppercase" style={{ color: "var(--text-2)" }}>
                Bütçe Satırları ve Versiyon Akışı ({catalog.lines.length})
              </div>
              <TableShell>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                      <th className="py-1">Bütçe</th>
                      <th>Dönem</th>
                      <th>Yön</th>
                      <th>Boyut</th>
                      <th className="text-right">Tutar</th>
                      <th>Durum</th>
                      <th className="text-right">İşlem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.lines.map((l) => {
                      const isOwnDraft = Boolean(session && l.createdBy === session.id);
                      return (
                        <tr key={l.id} className="border-t" style={{ borderColor: "var(--line)" }}>
                          <td className="py-1.5 text-xs">{l.budgetName}</td>
                          <td className="tabular-nums text-xs">{l.periodStart.slice(0, 7)}</td>
                          <td className="text-xs">{l.direction === "income" ? "gelir" : "gider"}</td>
                          <td className="text-xs" style={{ color: "var(--text-2)" }}>{l.dimensionLabel}</td>
                          <td className="text-right font-mono tabular-nums">{formatMoney(l.amount, l.currency)}</td>
                          <td>
                            <Badge tone={VERSION_TONE[l.versionStatus] ?? "neutral"}>
                              v{l.versionNo} · {VERSION_TR[l.versionStatus] ?? l.versionStatus}
                            </Badge>
                            {l.approvalQueueStatus === "pending" && l.versionStatus === "draft" ? (
                              <span className="ml-1 text-[10px] text-info">onay kuyruğunda</span>
                            ) : null}
                          </td>
                          <td className="text-right">
                            <div className="inline-flex flex-wrap items-center justify-end gap-1">
                              {l.versionStatus === "draft" ? (
                                <>
                                  {canEnter && l.approvalQueueStatus !== "pending" ? (
                                    <form action={submitBudgetForApprovalAction}>
                                      <input type="hidden" name="table" value="budget_lines" />
                                      <input type="hidden" name="lineId" value={l.id} />
                                      <button className="rounded border px-2 py-0.5 text-xs" style={INPUT_STYLE}>
                                        Onaya gönder
                                      </button>
                                    </form>
                                  ) : null}
                                  {canApprove && !isOwnDraft ? (
                                    <form action={approveBudgetVersionAction}>
                                      <input type="hidden" name="table" value="budget_lines" />
                                      <input type="hidden" name="lineId" value={l.id} />
                                      <button className="button-accent px-2 py-0.5 text-xs">
                                        Versiyonu onayla
                                      </button>
                                    </form>
                                  ) : null}
                                  {canApprove && isOwnDraft ? (
                                    <span className="text-[10px]" style={{ color: "var(--text-2)" }}>
                                      ikinci göz gerekli
                                    </span>
                                  ) : null}
                                </>
                              ) : null}
                              {canUpdateBudgetLines && l.versionStatus !== "superseded" ? (
                                <form action={setLineVersionAction}>
                                  <input type="hidden" name="table" value="budget_lines" />
                                  <input type="hidden" name="lineId" value={l.id} />
                                  <input type="hidden" name="status" value="superseded" />
                                  <button
                                    type="submit"
                                    className="rounded border px-2 py-0.5 text-xs"
                                    style={INPUT_STYLE}
                                  >
                                    Eski versiyona al
                                  </button>
                                </form>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableShell>
            </div>
          ) : null}

          {catalog.forecastLines.length > 0 ? (
            <div className="mt-4">
              <div className="mb-1 text-xs font-medium uppercase" style={{ color: "var(--text-2)" }}>
                Tahmin Satırları — Versiyon Geçişi ve Gerçekleşen Tutar Kaydı ({catalog.forecastLines.length})
              </div>
              <TableShell>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                      <th className="py-1">Tahmin</th>
                      <th>Aralık</th>
                      <th>Yön</th>
                      <th>Kaynak</th>
                      <th className="text-right">Tahmin</th>
                      <th className="text-right">Gerçekleşen</th>
                      <th>Durum</th>
                      <th className="text-right">Versiyon / Gerçekleşen İşlemi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.forecastLines.map((fl) => {
                      const isOwnDraft = Boolean(session && fl.createdBy === session.id);
                      return (
                        <tr key={fl.id} className="border-t" style={{ borderColor: "var(--line)" }}>
                          <td className="py-1.5 text-xs">{fl.forecastName}</td>
                          <td className="tabular-nums text-xs">{fl.periodStart} → {fl.periodEnd}</td>
                          <td className="text-xs">{fl.direction === "inflow" ? "giriş" : "çıkış"}</td>
                          <td className="text-xs">{SOURCE_LABEL[fl.sourceKind] ?? fl.sourceKind}</td>
                          <td className="text-right font-mono tabular-nums">{formatMoney(fl.amount, fl.currency)}</td>
                          <td className="text-right font-mono tabular-nums">
                            {fl.actualAmount == null ? (
                              <span className="text-xs" style={{ color: "var(--text-2)" }}>—</span>
                            ) : (
                              formatMoney(fl.actualAmount, fl.currency)
                            )}
                          </td>
                          <td>
                            <Badge tone={VERSION_TONE[fl.versionStatus] ?? "neutral"}>
                              {VERSION_TR[fl.versionStatus] ?? fl.versionStatus}
                            </Badge>
                          </td>
                          <td className="py-1.5 text-right">
                            <div className="inline-flex flex-wrap items-center justify-end gap-1">
                              {fl.versionStatus === "draft" ? (
                                <>
                                  {canEnter && fl.approvalQueueStatus !== "pending" ? (
                                    <form action={submitBudgetForApprovalAction}>
                                      <input type="hidden" name="table" value="forecast_lines" />
                                      <input type="hidden" name="lineId" value={fl.id} />
                                      <button className="rounded border px-2 py-0.5 text-xs" style={INPUT_STYLE}>
                                        Onaya gönder
                                      </button>
                                    </form>
                                  ) : null}
                                  {canApprove && !isOwnDraft ? (
                                    <form action={approveBudgetVersionAction}>
                                      <input type="hidden" name="table" value="forecast_lines" />
                                      <input type="hidden" name="lineId" value={fl.id} />
                                      <button className="button-accent px-2 py-0.5 text-xs">
                                        Onayla
                                      </button>
                                    </form>
                                  ) : null}
                                </>
                              ) : null}
                              {canUpdateForecastLines && fl.versionStatus !== "superseded" ? (
                                <form action={setLineVersionAction}>
                                  <input type="hidden" name="table" value="forecast_lines" />
                                  <input type="hidden" name="lineId" value={fl.id} />
                                  <input type="hidden" name="status" value="superseded" />
                                  <button
                                    type="submit"
                                    className="rounded border px-2 py-0.5 text-xs"
                                    style={INPUT_STYLE}
                                  >
                                    Eski versiyona al
                                  </button>
                                </form>
                              ) : null}
                              {canUpdateForecastLines ? (
                                <form action={recordActualAction} className="inline-flex items-center gap-1">
                                  <input type="hidden" name="lineId" value={fl.id} />
                                  <input
                                    name="actualAmount"
                                    type="number"
                                    step="0.01"
                                    defaultValue={fl.actualAmount != null ? String(fl.actualAmount) : ""}
                                    required
                                    placeholder="gerçekleşen"
                                    className="w-24 rounded border px-1.5 py-0.5 font-mono text-xs"
                                    style={INPUT_STYLE}
                                  />
                                  <button
                                    type="submit"
                                    className="rounded border px-2 py-0.5 text-xs font-medium"
                                    style={CARD_STYLE}
                                  >
                                    Kaydet
                                  </button>
                                </form>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableShell>
            </div>
          ) : null}
        </Panel>
      ) : null}

      <Panel title="BÜTÇE / GERÇEKLEŞEN" subtitle="yalnız ONAYLI satırlar ölçülür — taslak ve eski versiyonlar hariç">
        {rows.length === 0 ? (
          <EmptyState>Onaylı bütçe satırı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Dönem</th>
                  <th>Yön</th>
                  <th>Boyut</th>
                  <th className="text-right">Bütçe</th>
                  <th className="text-right">Gerçekleşen</th>
                  <th className="text-right">Fark</th>
                  <th className="text-right">Oran</th>
                  <th>Karar</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.lineId}-${r.periodStart}`} className="border-t" style={{ borderColor: "var(--line)" }}>
                    <td className="py-2 tabular-nums">{r.periodStart.slice(0, 7)}</td>
                    <td className="text-xs">{r.direction === "income" ? "gelir" : "gider"}</td>
                    <td className="text-xs" style={{ color: "var(--text-2)" }}>
                      {r.departmentName ?? r.projectName ?? r.costCenterName ?? "Şirket geneli"}
                      {r.departmentScoped && r.actualAmount == null ? (
                        <span className="block text-warn">bu departmanda fatura kaydı yok</span>
                      ) : null}
                    </td>
                    <td className="text-right font-mono tabular-nums">{formatMoney(r.budgetAmount, r.currency)}</td>
                    <td className="text-right font-mono tabular-nums">
                      {r.actualAmount == null ? (
                        <span style={{ color: "var(--text-2)" }}>ölçülmedi</span>
                      ) : (
                        formatMoney(r.actualAmount, r.currency)
                      )}
                    </td>
                    <td className={`text-right font-mono tabular-nums ${r.verdict === "over_budget" ? "text-neg" : ""}`}>
                      {r.varianceAmount == null ? "—" : formatMoney(r.varianceAmount, r.currency)}
                    </td>
                    <td className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                      {r.varianceRatio == null ? "—" : `%${(r.varianceRatio * 100).toFixed(1)}`}
                    </td>
                    <td>
                      <Badge tone={VERDICT_TONE[r.verdict] ?? "neutral"}>
                        {VERDICT_LABEL[r.verdict as keyof typeof VERDICT_LABEL] ?? r.verdict}
                      </Badge>
                    </td>
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
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Hafta</th>
                  <th>Aralık</th>
                  <th className="text-right">Giriş</th>
                  <th className="text-right">Çıkış</th>
                  <th className="text-right">Net</th>
                  <th className="text-right">Net (yalnız sözleşmeli)</th>
                  <th className="text-right">Net (güven ağırlıklı)</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => (
                  <tr key={`${w.forecastId}-${w.currency}-${w.weekNo}`} className="border-t" style={{ borderColor: "var(--line)" }}>
                    <td className="py-2 tabular-nums">{w.weekNo}</td>
                    <td className="text-xs tabular-nums">{w.weekStart} → {w.weekEnd}</td>
                    <td className="text-right font-mono tabular-nums">{formatMoney(w.inflow, w.currency)}</td>
                    <td className="text-right font-mono tabular-nums">{formatMoney(w.outflow, w.currency)}</td>
                    <td className={`text-right font-mono tabular-nums ${w.netFlow < 0 ? "text-neg" : ""}`}>
                      {formatMoney(w.netFlow, w.currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-2)" }}>
                      {formatMoney(w.netFlowContracted, w.currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-2)" }}>
                      {formatMoney(w.netFlowConfidenceWeighted, w.currency)}
                      {w.estimatedLineCount > 0 ? (
                        <span className="block text-[10px] text-warn">{w.estimatedLineCount} tahmini</span>
                      ) : null}
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
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Tahmin</th>
                  <th>Kaynak</th>
                  <th className="text-right">Ölçülen satır</th>
                  <th className="text-right">Tahmin</th>
                  <th className="text-right">Gerçekleşen</th>
                  <th className="text-right">Sapma (işaretli)</th>
                  <th className="text-right">MAPE</th>
                </tr>
              </thead>
              <tbody>
                {accuracy.map((a) => (
                  <tr key={`${a.forecastId}-${a.sourceKind}`} className="border-t" style={{ borderColor: "var(--line)" }}>
                    <td className="py-2">
                      {a.forecastName}
                      <span className="block text-xs" style={{ color: "var(--text-2)" }}>{a.horizonKind}</span>
                    </td>
                    <td className="text-xs">{SOURCE_LABEL[a.sourceKind as SourceKind] ?? a.sourceKind}</td>
                    <td className="text-right tabular-nums">{a.measuredLineCount}</td>
                    <td className="text-right tabular-nums">{a.forecastTotal == null ? "—" : fmtTL(a.forecastTotal)}</td>
                    <td className="text-right tabular-nums">{a.actualTotal == null ? "—" : fmtTL(a.actualTotal)}</td>
                    <td className="text-right tabular-nums">{a.biasTotal == null ? "—" : fmtTL(a.biasTotal)}</td>
                    <td className="text-right tabular-nums">
                      {a.mape == null ? (
                        <span style={{ color: "var(--text-2)" }}>hesaplanamaz</span>
                      ) : (
                        `%${(a.mape * 100).toFixed(1)}`
                      )}
                      {a.zeroForecastLines > 0 ? (
                        <span className="block text-[10px]" style={{ color: "var(--text-2)" }}>{a.zeroForecastLines} sıfır tahmin hariç</span>
                      ) : null}
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
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Tahmin</th>
                  <th className="text-right">Satır</th>
                  <th className="text-right">Onaylı</th>
                  <th className="text-right">Taslak</th>
                  <th className="text-right">Ölçülen</th>
                  <th className="text-right">Sözleşmeli</th>
                  <th className="text-right">Tahmini</th>
                </tr>
              </thead>
              <tbody>
                {coverage.map((c) => (
                  <tr key={c.forecastId} className="border-t" style={{ borderColor: "var(--line)" }}>
                    <td className="py-2">{c.forecastName}</td>
                    <td className="text-right tabular-nums">{c.lineCount}</td>
                    <td className="text-right tabular-nums">{c.approvedCount}</td>
                    <td className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>{c.draftCount}</td>
                    <td className="text-right tabular-nums">
                      {c.measuredCount}
                      {c.measuredRatio != null ? (
                        <span className="block text-[10px]" style={{ color: "var(--text-2)" }}>%{(c.measuredRatio * 100).toFixed(0)}</span>
                      ) : null}
                    </td>
                    <td className="text-right tabular-nums text-pos">{c.contractedCount}</td>
                    <td className="text-right tabular-nums text-warn">{c.estimatedCount}</td>
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
