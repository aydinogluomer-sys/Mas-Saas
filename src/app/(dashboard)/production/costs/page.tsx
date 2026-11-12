import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { EmptyState, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import {
  fmtSignedPct,
  fmtSignedTlPerMin,
  fmtTlPerMin,
  loadActualCostBridge,
} from "@/lib/production/actual-cost-bridge";
import {
  loadCapacityModels,
  loadCatalogProducts,
  loadCostBreakdown,
  loadCostModels,
  loadProductionParts,
} from "@/lib/production/engine";
import {
  recalculateProfitabilityAction,
  upsertCatalogProductAction,
  upsertCostModelItemAction,
  upsertOperationRatesAction,
  upsertProductionPartAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function CostsPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; result?: string; editPart?: string }>;
}) {
  const denied = await requireRouteAccess("/production/costs");
  if (denied) return denied;
  const session = await getRequestUser();
  const role = session?.role ?? "viewer";
  const canEditCosts = can(role, "cost_models", "insert");
  const canEditRates = can(role, "cost_models", "update");
  const canEditParts = can(role, "production_parts", "insert");
  const canEditProducts = can(role, "products", "insert");
  const canRecalculate = can(role, "part_profitability_runs", "insert");
  const sp = searchParams ? await searchParams : {};

  const p = getPool();
  const [models, bridge, parts, catalogProducts, capacityModels] = await Promise.all([
    loadCostModels(p),
    loadActualCostBridge(p),
    loadProductionParts(p, 200),
    loadCatalogProducts(p, 200),
    loadCapacityModels(p),
  ]);
  const details = await Promise.all(
    models.map(async (m) => ({ m, lines: await loadCostBreakdown(p, m.id) })),
  );
  const selectedPart = sp.editPart ? parts.find((pt) => pt.id === sp.editPart) ?? null : null;
  const primaryCap = capacityModels[0] ?? null;
  const primaryModel = models.find((m) => m.scenario === "normal") ?? models[0] ?? null;

  const hasErosionAlert =
    bridge.hiddenErosionRateCount > 0 || bridge.hiddenErosionPartCount > 0;
  const driftTone =
    bridge.rateDriftTlPerMin !== null && bridge.rateDriftTlPerMin > 0
      ? "neg"
      : bridge.rateDriftTlPerMin !== null && bridge.rateDriftTlPerMin < 0
        ? "pos"
        : "neutral";

  return (
    <>
      <PageHeader
        title="Maliyet ve Başabaş"
        subtitle="Normal ve mesaili senaryolarda aylık maliyet ile TL/dk başabaş"
        meta={<span className="text-xs" style={{ color: "var(--warn)" }}>Analitik tahmin</span>}
      />

      {sp.error ? (
        <div
          className="mb-3 rounded border p-2 text-xs"
          style={{
            borderColor: "color-mix(in srgb, var(--neg) 40%, var(--line))",
            background: "color-mix(in srgb, var(--neg) 10%, var(--surface-1))",
            color: "var(--neg)",
          }}
        >
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div
          className="mb-3 rounded border p-2 text-xs"
          style={{
            borderColor: "color-mix(in srgb, var(--pos) 40%, var(--line))",
            background: "color-mix(in srgb, var(--pos) 10%, var(--surface-1))",
            color: "var(--pos)",
          }}
        >
          {sp.result}
        </div>
      ) : null}

      <Panel
        title="TDHP 7xx Fiili Gider ↔ Tezgâh Dakika (TL/dk) Canlı Başabaş Köprüsü"
        subtitle="Çift taraflı yönetim defterindeki kesinleşmiş 7xx giderlerinden canlı nakit/tam başabaş ve gizli marj erimesi denetimi"
        accent={
          bridge.status !== "ready"
            ? "warn"
            : hasErosionAlert
              ? "neg"
              : "pos"
        }
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="amber">Varsayım (Model Sabiti)</Badge>
            <Badge
              tone={
                bridge.status !== "ready"
                  ? "amber"
                  : hasErosionAlert
                    ? "red"
                    : "green"
              }
            >
              {bridge.status === "ready"
                ? `${bridge.monthCount} ay · ${bridge.totalPosted7xxEntries} fiş`
                : "Ölçülemez"}
            </Badge>
          </div>
        }
      >
        <div className="space-y-3">
          <div
            className="flex flex-wrap items-center justify-between gap-2 border px-3 py-2 text-xs"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--line)",
              borderRadius: "var(--radius)",
              color: "var(--text-3)",
            }}
          >
            <span>
              Son <b>{bridge.lookbackMonths}</b> kesinleşmiş (<code className="font-mono">posted</code>) 7xx dönem ortalaması baz alınır:{" "}
              <code className="font-mono">710–770</code> (amortisman hariç) nakit işletme başabaşını,{" "}
              <code className="font-mono">+ 770.99 / da_addback</code> tam başabaşı oluşturur;{" "}
              <code className="font-mono">780</code> finansman giderleri ayrı raporlanır.
            </span>
            <Badge tone="amber">Varsayım (Model Sabiti)</Badge>
          </div>

          {bridge.status === "insufficient_ledger_actuals" ? (
            <EmptyState>
              Fiili 7xx yönetim defteri verisi yetersiz — ölçülemez. Yönetim defterinde kesinleşmiş (posted) 710–770 gider tahakkuku oluştuğunda nakit ve tam TL/dk başabaş burada hesaplanır; eksik veri asla 0,00 TL/dk olarak gösterilmez.
            </EmptyState>
          ) : bridge.status === "unknown_effective_minutes" ? (
            <EmptyState>
              Fiili 7xx yönetim defteri verisi yetersiz — ölçülemez: aylık ortalama tam 7xx gideri ({fmtTL(bridge.avgMonthlyFull7xxInclDaTry)}) okundu ancak etkin tezgâh dakikası tanımlı veya pozitif olmadığı için TL/dk başabaş hesaplanamıyor.
            </EmptyState>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard
                  label="Kitabi (Model) Başabaş TL/dk"
                  value={fmtTlPerMin(bridge.bookBreakEvenTlPerMin)}
                  note={`Baz senaryo: ${bridge.primaryScenario ?? "—"}`}
                />
                <KpiCard
                  label="Fiili Nakit (7xx Amortisman Hariç) TL/dk"
                  value={fmtTlPerMin(bridge.actualCashBreakEvenTlPerMin)}
                  tone="info"
                  note={`Aylık ort. ${fmtTL(bridge.avgMonthlyOperating7xxExclDaTry)} (710–770 nakit)`}
                />
                <KpiCard
                  label="Fiili Tam (7xx + Amortisman) TL/dk"
                  value={fmtTlPerMin(bridge.actualFullBreakEvenTlPerMin)}
                  tone={hasErosionAlert ? "warn" : "neutral"}
                  emphasize
                  note={`Aylık ort. ${fmtTL(bridge.avgMonthlyFull7xxInclDaTry)} (D&A: ${fmtTL(bridge.avgMonthlyDepreciationDaTry)})`}
                />
                <KpiCard
                  label="Sapma (Δ TL/dk)"
                  value={fmtSignedTlPerMin(bridge.rateDriftTlPerMin)}
                  tone={driftTone}
                  badge={
                    bridge.rateDriftPct !== null ? (
                      <Badge tone={driftTone === "neg" ? "red" : driftTone === "pos" ? "green" : "neutral"}>
                        {fmtSignedPct(bridge.rateDriftPct)}
                      </Badge>
                    ) : undefined
                  }
                  note={`780 Finansman (ayrı): ${fmtTL(bridge.avgMonthlyFinancing780Try)}/ay`}
                />
              </div>

              {bridge.models.length > 0 ? (
                <TableShell>
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr
                        className="border-b font-mono text-[10px] uppercase"
                        style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                      >
                        <th className="py-2 pr-3">Model / Senaryo</th>
                        <th className="py-2 px-2 text-right">Etkin Dk</th>
                        <th className="py-2 px-2 text-right">Kitabi TL/dk</th>
                        <th className="py-2 px-2 text-right">Fiili Nakit TL/dk</th>
                        <th className="py-2 px-2 text-right">Fiili Tam TL/dk</th>
                        <th className="py-2 px-2 text-right">Sapma (Δ TL/dk)</th>
                        <th className="py-2 pl-2">Akon Tarife Kontrolü</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bridge.models.map((row) => (
                        <tr
                          key={row.modelId}
                          className="border-b"
                          style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                        >
                          <td className="py-2 pr-3 font-mono">
                            <span className="font-semibold">{row.modelName}</span>{" "}
                            <span style={{ color: "var(--text-3)" }}>({row.scenario})</span>
                          </td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums">
                            {row.effectiveMinutes !== null
                              ? row.effectiveMinutes.toLocaleString("tr-TR")
                              : "—"}
                          </td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums">
                            {fmtTlPerMin(row.bookBreakEvenTlPerMin)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums">
                            {fmtTlPerMin(row.actualCashBreakEvenTlPerMin)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono font-semibold tabular-nums">
                            {fmtTlPerMin(row.actualFullBreakEvenTlPerMin)}
                          </td>
                          <td
                            className="py-2 px-2 text-right font-mono tabular-nums"
                            style={{
                              color:
                                row.rateDriftTlPerMin !== null && row.rateDriftTlPerMin > 0
                                  ? "var(--neg)"
                                  : row.rateDriftTlPerMin !== null && row.rateDriftTlPerMin < 0
                                    ? "var(--pos)"
                                    : "var(--text-3)",
                            }}
                          >
                            {fmtSignedTlPerMin(row.rateDriftTlPerMin)}
                            {row.rateDriftPct !== null ? ` (${fmtSignedPct(row.rateDriftPct)})` : ""}
                          </td>
                          <td className="py-2 pl-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {row.customerRates.map((cr) => {
                                if (cr.priceTlPerMin === null) {
                                  return (
                                    <span
                                      key={cr.operation}
                                      className="font-mono text-[11px]"
                                      style={{ color: "var(--text-3)" }}
                                    >
                                      {cr.label}: —
                                    </span>
                                  );
                                }
                                if (cr.hiddenMarginErosion) {
                                  return (
                                    <Badge key={cr.operation} tone="red">
                                      {cr.label} {fmtTlPerMin(cr.priceTlPerMin)} · Gizli Erime (
                                      {fmtSignedTlPerMin(cr.actualFullMarginTlPerMin)})
                                    </Badge>
                                  );
                                }
                                if (cr.actualFullLoss) {
                                  return (
                                    <Badge key={cr.operation} tone="amber">
                                      {cr.label} {fmtTlPerMin(cr.priceTlPerMin)} · Zararına (
                                      {fmtSignedTlPerMin(cr.actualFullMarginTlPerMin)})
                                    </Badge>
                                  );
                                }
                                return (
                                  <Badge key={cr.operation} tone="green">
                                    {cr.label} {fmtTlPerMin(cr.priceTlPerMin)} · Pozitif (
                                    {fmtSignedTlPerMin(cr.actualFullMarginTlPerMin)})
                                  </Badge>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableShell>
              ) : null}

              {hasErosionAlert ? (
                <div
                  className="space-y-2 border p-3"
                  style={{
                    background: "var(--surface-2)",
                    borderColor: "color-mix(in srgb, var(--neg) 45%, var(--line))",
                    borderRadius: "var(--radius)",
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold" style={{ color: "var(--neg)" }}>
                      GİZLİ MARJ ERİMESİ UYARISI: Kitabi başabaşa göre kârlı görünen{" "}
                      {bridge.hiddenErosionRateCount} müşteri tarifesi ve{" "}
                      {bridge.hiddenErosionPartCount} parça fiili 7xx başabaşı altında zarara dönüyor
                    </span>
                    {bridge.hiddenErosionTotalLossTry !== null &&
                    bridge.hiddenErosionTotalLossTry < 0 ? (
                      <Badge tone="red">
                        Toplam Fiili Zarar: {fmtTL(bridge.hiddenErosionTotalLossTry)}
                      </Badge>
                    ) : null}
                  </div>

                  {bridge.hiddenErosionParts.length > 0 ? (
                    <TableShell>
                      <table className="w-full border-collapse text-left text-xs">
                        <thead>
                          <tr
                            className="border-b font-mono text-[10px] uppercase"
                            style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                          >
                            <th className="py-1.5 pr-2">Parça Kodu</th>
                            <th className="py-1.5 px-2">Parça Adı</th>
                            <th className="py-1.5 px-2 text-right">Toplam Dk</th>
                            <th className="py-1.5 px-2 text-right">Zımni Satış TL/dk</th>
                            <th className="py-1.5 px-2 text-right">Kitabi Marj</th>
                            <th className="py-1.5 pl-2 text-right">Fiili Tam 7xx Marj</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bridge.hiddenErosionParts.map((pt, idx) => (
                            <tr
                              key={pt.partId ?? `${pt.partCode ?? pt.partName}-${idx}`}
                              className="border-b"
                              style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                            >
                              <td className="py-1.5 pr-2 font-mono">{pt.partCode ?? "—"}</td>
                              <td className="py-1.5 px-2">{pt.partName}</td>
                              <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                                {pt.totalMinutes.toLocaleString("tr-TR")}
                              </td>
                              <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                                {fmtTlPerMin(pt.impliedPriceTlPerMin)}
                              </td>
                              <td
                                className="py-1.5 px-2 text-right font-mono tabular-nums"
                                style={{ color: "var(--pos)" }}
                              >
                                {fmtTL(pt.bookMarginTry)}
                              </td>
                              <td
                                className="py-1.5 pl-2 text-right font-mono font-semibold tabular-nums"
                                style={{ color: "var(--neg)" }}
                              >
                                {fmtTL(pt.actualFullMarginTry)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableShell>
                  ) : null}
                </div>
              ) : (
                <div
                  className="border px-3 py-2 font-mono text-xs"
                  style={{
                    background: "var(--surface-2)",
                    borderColor: "var(--line)",
                    borderRadius: "var(--radius)",
                    color: "var(--text-3)",
                  }}
                >
                  Değerlendirilen {bridge.evaluatedPartCount} parça ve tanımlı Akon tarifelerinde kitabi kârdan fiili 7xx zararına dönen gizli marj erimesi saptanmadı.
                </div>
              )}
            </>
          )}
        </div>
      </Panel>

      {canEditCosts || canEditRates || canEditParts || canRecalculate ? (
        <Panel
          title="MALİYET, DAKİKA TARİFESİ VE TEKİL PARÇA PARAMETRELERİ"
          subtitle="Kaydedilen her maliyet, tezgâh tarifesi veya parça güncellemesi /production/profitability kârlılık tablosunu anında yeniden hesaplar"
          right={
            canRecalculate ? (
              <form action={recalculateProfitabilityAction}>
                <input type="hidden" name="backTo" value="/production/costs" />
                <button
                  type="submit"
                  className="rounded border px-2.5 py-1 font-mono text-[11px] font-medium"
                  style={{
                    borderColor: "var(--line)",
                    background: "var(--surface-2)",
                    color: "var(--text-1)",
                  }}
                >
                  Kârlılığı Şimdi Yeniden Hesapla
                </button>
              </form>
            ) : undefined
          }
        >
          <div className="space-y-3">
            {canEditCosts ? (
              <details className="rounded border p-2.5" style={{ borderColor: "var(--line-faint)", background: "var(--surface-1)" }}>
                <summary className="cursor-pointer font-mono text-xs font-semibold" style={{ color: "var(--text-1)" }}>
                  + Sabit maliyet kalemi ekle / güncelle
                </summary>
                <form action={upsertCostModelItemAction} className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-4">
                  <input type="hidden" name="backTo" value="/production/costs" />
                  <select
                    name="scenarioType"
                    defaultValue="normal"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  >
                    <option value="normal">normal</option>
                    <option value="overtime">overtime (mesaili)</option>
                    <option value="custom">custom</option>
                  </select>
                  <input
                    name="costCategory"
                    required
                    placeholder="Kategori (örn. Yemek, Elektrik)"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="monthlyAmount"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    placeholder="Aylık tutar (TL)"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="staffCount"
                    type="number"
                    min="0"
                    placeholder="Personel sayısı"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="monthlyWorkHours"
                    type="number"
                    step="0.5"
                    min="1"
                    placeholder="Aylık çalışma saati (örn. 176)"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="efficiencyRate"
                    type="number"
                    step="0.01"
                    min="0.05"
                    max="2"
                    placeholder="Verim oranı (örn. 0.85)"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="description"
                    placeholder="Açıklama (opsiyonel)"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <button
                    type="submit"
                    className="rounded border px-2 py-1 font-medium"
                    style={{
                      borderColor: "var(--line)",
                      background: "var(--surface-2)",
                      color: "var(--text-1)",
                    }}
                  >
                    Maliyet kalemini kaydet
                  </button>
                </form>
              </details>
            ) : null}

            {canEditRates ? (
              <details className="rounded border p-2.5" style={{ borderColor: "var(--line-faint)", background: "var(--surface-1)" }}>
                <summary className="cursor-pointer font-mono text-xs font-semibold" style={{ color: "var(--text-1)" }}>
                  + Tezgâh / müşteri dakika tarifesi (TL/dk) güncelle
                </summary>
                <form action={upsertOperationRatesAction} className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-4">
                  <input type="hidden" name="backTo" value="/production/costs" />
                  <select
                    name="scenarioType"
                    defaultValue="normal"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  >
                    <option value="normal">normal</option>
                    <option value="overtime">overtime (mesaili)</option>
                    <option value="custom">custom</option>
                  </select>
                  <input
                    name="tornaRateTLPerMin"
                    type="number"
                    step="0.0001"
                    min="0"
                    defaultValue={primaryCap?.tornaRateTLPerMin ?? ""}
                    placeholder="Torna maliyet TL/dk"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="frezeRateTLPerMin"
                    type="number"
                    step="0.0001"
                    min="0"
                    defaultValue={primaryCap?.frezeRateTLPerMin ?? ""}
                    placeholder="Freze maliyet TL/dk"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="effectiveMonthlyMinutes"
                    type="number"
                    step="1"
                    min="1"
                    defaultValue={primaryModel?.effectiveMinutes ?? primaryCap?.monthlyMinutes ?? ""}
                    placeholder="Etkin aylık dakika"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="akonTornaTLPerMin"
                    type="number"
                    step="0.0001"
                    min="0"
                    defaultValue={primaryModel?.akonTorna ?? ""}
                    placeholder="Müşteri (Akon) Torna TL/dk"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="akonFrezeTLPerMin"
                    type="number"
                    step="0.0001"
                    min="0"
                    defaultValue={primaryModel?.akonFreze ?? ""}
                    placeholder="Müşteri (Akon) Freze TL/dk"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="rateYear"
                    type="number"
                    min="2000"
                    max="2100"
                    defaultValue={primaryCap?.rateYear ?? new Date().getFullYear()}
                    placeholder="Tarife yılı (örn. 2026)"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <button
                    type="submit"
                    className="rounded border px-2 py-1 font-medium"
                    style={{
                      borderColor: "var(--line)",
                      background: "var(--surface-2)",
                      color: "var(--text-1)",
                    }}
                  >
                    Tarifeyi kaydet ve kârlılığı yenile
                  </button>
                </form>
              </details>
            ) : null}

            {canEditParts ? (
              <details
                open={Boolean(selectedPart)}
                className="rounded border p-2.5"
                style={{ borderColor: "var(--line-faint)", background: "var(--surface-1)" }}
              >
                <summary className="cursor-pointer font-mono text-xs font-semibold" style={{ color: "var(--text-1)" }}>
                  {selectedPart
                    ? `Parça düzenle: ${selectedPart.partCode ? `${selectedPart.partCode} · ` : ""}${selectedPart.partName}`
                    : "+ Tekil üretim parçası (süre / birim satış fiyatı) ekle veya güncelle"}
                </summary>
                <form
                  key={selectedPart?.id ?? "new-part"}
                  action={upsertProductionPartAction}
                  className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-4"
                >
                  <input type="hidden" name="backTo" value="/production/costs" />
                  <input type="hidden" name="id" value={selectedPart?.id ?? ""} />
                  <input
                    name="partCode"
                    defaultValue={selectedPart?.partCode ?? ""}
                    placeholder="Parça kodu (örn. PRT-101)"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="partName"
                    required
                    defaultValue={selectedPart?.partName ?? ""}
                    placeholder="Parça adı"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="quantity"
                    type="number"
                    min="1"
                    step="1"
                    required
                    defaultValue={selectedPart?.quantity ?? 1}
                    placeholder="Üretim adedi"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="unitSalePrice"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={selectedPart?.unitSalePrice ?? ""}
                    placeholder="Birim satış fiyatı (TL)"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="tornaMinutes"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={selectedPart?.tornaMinutes ?? ""}
                    placeholder="Torna dk / adet"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="frezeMinutes"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={selectedPart?.frezeMinutes ?? ""}
                    placeholder="Freze dk / adet"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="otherOperationMinutes"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={selectedPart?.otherOperationMinutes ?? ""}
                    placeholder="Diğer op. dk / adet"
                    className="rounded border px-2 py-1"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      type="submit"
                      className="flex-1 rounded border px-2 py-1 font-medium"
                      style={{
                        borderColor: "var(--line)",
                        background: "var(--surface-2)",
                        color: "var(--text-1)",
                      }}
                    >
                      {selectedPart ? "Parçayı güncelle" : "Parçayı kaydet"}
                    </button>
                    {selectedPart ? (
                      <Link
                        href="/production/costs"
                        className="rounded border px-2 py-1 text-center"
                        style={{
                          borderColor: "var(--line)",
                          background: "var(--surface-1)",
                          color: "var(--text-2)",
                        }}
                      >
                        İptal
                      </Link>
                    ) : null}
                  </div>
                </form>
              </details>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <Panel
        title="ÜRETİM PARÇALARI VE BİRİM MALİYET GİRDİLERİ"
        subtitle="Parça başı torna/freze operasyon süreleri ve birim satış fiyatları"
        right={<Badge tone="neutral">{parts.length} parça</Badge>}
      >
        {parts.length === 0 ? (
          <EmptyState>
            Henüz kayıtlı üretim parçası yok. Yukarıdaki formdan tekil parça ekleyebilir veya kapasite çalışma kitabını içe aktarabilirsiniz.
          </EmptyState>
        ) : (
          <TableShell>
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr
                  className="border-b font-mono text-[10px] uppercase"
                  style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                >
                  <th className="py-2 pr-2">Kod</th>
                  <th className="py-2 px-2">Parça Adı</th>
                  <th className="py-2 px-2 text-right">Adet</th>
                  <th className="py-2 px-2 text-right">Torna Dk</th>
                  <th className="py-2 px-2 text-right">Freze Dk</th>
                  <th className="py-2 px-2 text-right">Birim Satış</th>
                  <th className="py-2 px-2">Kaynak</th>
                  {canEditParts ? <th className="py-2 pl-2 text-right">İşlem</th> : null}
                </tr>
              </thead>
              <tbody>
                {parts.slice(0, 50).map((pt) => (
                  <tr
                    key={pt.id}
                    className="border-b"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  >
                    <td className="py-1.5 pr-2 font-mono">{pt.partCode ?? "—"}</td>
                    <td className="py-1.5 px-2">{pt.partName}</td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                      {pt.quantity?.toLocaleString("tr-TR") ?? "—"}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                      {pt.tornaMinutes != null ? pt.tornaMinutes.toLocaleString("tr-TR") : "—"}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                      {pt.frezeMinutes != null ? pt.frezeMinutes.toLocaleString("tr-TR") : "—"}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                      {pt.unitSalePrice != null ? fmtTL(pt.unitSalePrice) : "—"}
                    </td>
                    <td className="py-1.5 px-2">
                      <Badge tone={pt.isManual ? "blue" : "neutral"}>
                        {pt.isManual ? "Manuel" : "Çalışma Kitabı"}
                      </Badge>
                    </td>
                    {canEditParts ? (
                      <td className="py-1.5 pl-2 text-right">
                        <Link
                          href={`/production/costs?editPart=${encodeURIComponent(pt.id)}`}
                          className="font-mono text-[11px] underline"
                          style={{ color: "var(--text-2)" }}
                        >
                          Düzenle
                        </Link>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel
        title="Katalog Ürünleri (Products)"
        subtitle="Fatura kalemleri ve üretim maliyet takibinde referans alınan ürün kataloğu (public.products)"
        right={<Badge tone="neutral">{catalogProducts.length} ürün</Badge>}
      >
        <div className="space-y-3">
          {canEditProducts ? (
            <details className="rounded border p-2.5" style={{ borderColor: "var(--line-faint)", background: "var(--surface-1)" }}>
              <summary className="cursor-pointer font-mono text-xs font-semibold" style={{ color: "var(--text-1)" }}>
                + Katalog ürünü ekle / güncelle
              </summary>
              <form action={upsertCatalogProductAction} className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-5">
                <input type="hidden" name="backTo" value="/production/costs" />
                <input
                  name="code"
                  required
                  placeholder="Ürün kodu (örn. URN-001)"
                  className="rounded border px-2 py-1"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="name"
                  required
                  placeholder="Ürün adı"
                  className="rounded border px-2 py-1"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="unit"
                  placeholder="Birim (örn. Adet, Kg, Saat)"
                  className="rounded border px-2 py-1"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="notes"
                  placeholder="Not (opsiyonel)"
                  className="rounded border px-2 py-1"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <button
                  type="submit"
                  className="rounded border px-2 py-1 font-medium"
                  style={{
                    borderColor: "var(--line)",
                    background: "var(--surface-2)",
                    color: "var(--text-1)",
                  }}
                >
                  Ürünü kaydet
                </button>
              </form>
            </details>
          ) : null}

          {catalogProducts.length === 0 ? (
            <EmptyState>
              Katalogda kayıtlı ürün bulunmuyor. Ürün kataloğuna kayıt eklendiğinde kod, birim ve durum bilgileri burada listelenir.
            </EmptyState>
          ) : (
            <TableShell>
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr
                    className="border-b font-mono text-[10px] uppercase"
                    style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                  >
                    <th className="py-2 pr-3">Ürün Kodu</th>
                    <th className="py-2 px-2">Ürün Adı</th>
                    <th className="py-2 px-2">Birim</th>
                    <th className="py-2 px-2">Durum</th>
                    <th className="py-2 px-2">Notlar</th>
                    <th className="py-2 pl-2 text-right">Güncelleme</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogProducts.map((prod) => (
                    <tr
                      key={prod.id}
                      className="border-b"
                      style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                    >
                      <td className="py-1.5 pr-3 font-mono font-semibold">{prod.code}</td>
                      <td className="py-1.5 px-2">{prod.name}</td>
                      <td className="py-1.5 px-2 font-mono" style={{ color: "var(--text-2)" }}>
                        {prod.unit ?? "—"}
                      </td>
                      <td className="py-1.5 px-2">
                        <Badge tone={prod.isActive ? "green" : "neutral"}>
                          {prod.isActive ? "Aktif" : "Pasif"}
                        </Badge>
                      </td>
                      <td className="py-1.5 px-2" style={{ color: "var(--text-2)" }}>
                        {prod.notes ?? "—"}
                      </td>
                      <td className="py-1.5 pl-2 text-right font-mono" style={{ color: "var(--text-3)" }}>
                        {prod.updatedAt ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          )}
        </div>
      </Panel>

      {details.length === 0 ? (
        <Panel title="MALİYET MODELLERİ">
          <p className="py-2 text-sm" style={{ color: "var(--text-3)" }}>
            Henüz tanımlı maliyet modeli yok.
          </p>
        </Panel>
      ) : (
        details.map(({ m, lines }) => (
          <Panel
            key={m.id}
            title={`${m.name} · ${m.scenario}`}
            right={<b>{fmtTlPerMin(m.breakEven)}</b>}
          >
            <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
              <span>
                Aylık maliyet
                <br />
                <b>{fmtTL(m.monthlyCost)}</b>
              </span>
              <span>
                Etkin dakika
                <br />
                <b>{m.effectiveMinutes?.toLocaleString("tr-TR") ?? "—"}</b>
              </span>
            </div>
            {lines.map((l, i) => (
              <div
                key={`${l.block}-${l.label}-${i}`}
                className="grid grid-cols-[100px_1fr_auto] border-t py-1 text-xs"
                style={{ borderColor: "var(--line-faint)" }}
              >
                <span style={{ color: "var(--text-3)" }}>{l.block}</span>
                <span>{l.label}</span>
                <span>{fmtTL(l.amount)}</span>
              </div>
            ))}
          </Panel>
        ))
      )}
    </>
  );
}
