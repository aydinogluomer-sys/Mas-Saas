import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { SubmitButton } from "@/components/ui/submit-button";
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
import { loadCostModels, loadMachineRoiAggregate, loadPartProfitability } from "@/lib/production/engine";
import { loadSourceRevenueSummary } from "@/lib/production/source-revenue";
import { upsertCapacityParameterAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function ProductionSummary({
  searchParams,
}: { searchParams?: Promise<{ error?: string; result?: string }> }) {
  const denied = await requireRouteAccess("/production");
  if (denied) return denied;
  const session = await getRequestUser();
  const canEditCapacity = can(session?.role ?? "viewer", "capacity_models", "insert");
  const sp = searchParams ? await searchParams : {};

  const p = getPool();
  const [costs, parts, roi, revSummary, bridge] = await Promise.all([
    loadCostModels(p),
    loadPartProfitability(p, 5),
    loadMachineRoiAggregate(p),
    loadSourceRevenueSummary(p),
    loadActualCostBridge(p),
  ]);
  const lowest = parts[0];
  const normalModel = costs.find((x) => x.scenario === "normal");
  const hasErosionAlert =
    bridge.hiddenErosionRateCount > 0 || bridge.hiddenErosionPartCount > 0;
  const roiTone =
    roi?.net !== null && roi?.net !== undefined && roi.net < 0 ? "neg" : "pos";

  return (
    <>
      <PageHeader
        title="Üretim Özeti"
        subtitle="Başabaş ve zararına satış sinyalleri"
        meta={
          <span className="text-xs" style={{ color: "var(--warn)" }}>
            Analitik tahmin · muhasebe kaydı değildir
          </span>
        }
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

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        <KpiCard label="Normal başabaş" value={fmtTlPerMin(normalModel?.breakEven)} />
        <KpiCard
          label="En düşük parça marjı"
          value={lowest?.margin == null ? "—" : fmtTL(lowest.margin)}
          tone="warn"
        />
        <KpiCard label="ROI net sonucu" value={fmtTL(roi?.net)} tone={roiTone} />
      </div>

      <Panel
        title="TDHP 7xx Fiili Gider ↔ Tezgâh Dakika (TL/dk) Canlı Başabaş Köprüsü"
        subtitle="Yönetim defterindeki kesinleşmiş 7xx giderlerinden tezgâh dakikası başına nakit/tam başabaş özeti"
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
            <Link
              href="/production/costs"
              className="font-mono text-[11px] underline"
              style={{ color: "var(--text-1)" }}
            >
              Maliyet Detayı →
            </Link>
          </div>
        }
      >
        {bridge.status === "insufficient_ledger_actuals" ? (
          <EmptyState>
            Fiili 7xx yönetim defteri verisi yetersiz — ölçülemez (son {bridge.lookbackMonths} ayda kesinleşmiş 710–770 gider tahakkuku yok; boş veri asla 0,00 TL/dk olarak gösterilmez).
          </EmptyState>
        ) : bridge.status === "unknown_effective_minutes" ? (
          <EmptyState>
            Fiili 7xx yönetim defteri verisi yetersiz — ölçülemez: aylık tam 7xx gideri ({fmtTL(bridge.avgMonthlyFull7xxInclDaTry)}) mevcut ancak etkin tezgâh dakikası tanımlı olmadığı için TL/dk başabaş hesaplanamıyor.
          </EmptyState>
        ) : (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <KpiCard
                label="Kitabi (Model) Başabaş"
                value={fmtTlPerMin(bridge.bookBreakEvenTlPerMin)}
                note={`Senaryo: ${bridge.primaryScenario ?? "—"}`}
              />
              <KpiCard
                label="Fiili Nakit (7xx Amortisman Hariç)"
                value={fmtTlPerMin(bridge.actualCashBreakEvenTlPerMin)}
                tone="info"
                note={`${bridge.monthCount} ay ort. ${fmtTL(bridge.avgMonthlyOperating7xxExclDaTry)}`}
              />
              <KpiCard
                label="Fiili Tam (7xx + Amortisman)"
                value={fmtTlPerMin(bridge.actualFullBreakEvenTlPerMin)}
                tone={hasErosionAlert ? "warn" : "neutral"}
                note={`D&A dahil ${fmtTL(bridge.avgMonthlyFull7xxInclDaTry)}/ay`}
              />
              <KpiCard
                label="Sapma (Δ TL/dk)"
                value={fmtSignedTlPerMin(bridge.rateDriftTlPerMin)}
                tone={
                  bridge.rateDriftTlPerMin !== null && bridge.rateDriftTlPerMin > 0
                    ? "neg"
                    : bridge.rateDriftTlPerMin !== null && bridge.rateDriftTlPerMin < 0
                      ? "pos"
                      : "neutral"
                }
                note={`${fmtSignedPct(bridge.rateDriftPct)} · Gizli erime: ${bridge.hiddenErosionPartCount} parça / ${bridge.hiddenErosionRateCount} tarife`}
              />
            </div>

            {hasErosionAlert ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 border px-3 py-2 text-xs"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "color-mix(in srgb, var(--neg) 45%, var(--line))",
                  borderRadius: "var(--radius)",
                  color: "var(--text-1)",
                }}
              >
                <span className="font-mono">
                  <b style={{ color: "var(--neg)" }}>Gizli Marj Erimesi:</b>{" "}
                  Kitabi başabaşta kârlı görünen{" "}
                  <b>{bridge.hiddenErosionRateCount}</b> Akon tarifesi ve{" "}
                  <b>{bridge.hiddenErosionPartCount}</b> parça fiili 7xx tam başabaşı altında zarara dönüyor.
                </span>
                <Link
                  href="/production/costs"
                  className="font-mono text-[11px] underline"
                  style={{ color: "var(--neg)" }}
                >
                  Eriyen parçaları incele →
                </Link>
              </div>
            ) : null}
          </div>
        )}
      </Panel>

      {canEditCapacity ? (
        <Panel title="KAPASİTE PARAMETRESİ GÜNCELLE">
          <details className="rounded border p-2" style={{ borderColor: "var(--line-faint)" }}>
            <summary className="cursor-pointer font-mono text-xs font-semibold" style={{ color: "var(--text-1)" }}>
              + Kapasite / vardiya parametresi ekle
            </summary>
            <form action={upsertCapacityParameterAction} className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-4">
              <input type="hidden" name="backTo" value="/production" />
              <input
                name="name"
                required
                placeholder="Model adı (örn. 2026 Normal Atölye)"
                className="rounded border bg-transparent px-2 py-1 sm:col-span-2"
                style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
              />
              <select
                name="scenarioType"
                defaultValue="normal"
                className="rounded border bg-transparent px-2 py-1"
                style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
              >
                <option value="normal">normal</option>
                <option value="overtime">overtime (mesaili)</option>
                <option value="custom">custom</option>
              </select>
              <input
                name="rateYear"
                type="number"
                min="2000"
                max="2100"
                defaultValue={new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric" }).format(new Date())}
                placeholder="Tarife yılı"
                className="rounded border bg-transparent px-2 py-1"
                style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
              />
              <input
                name="workDaysPerMonth"
                type="number"
                min="1"
                max="31"
                defaultValue="22"
                required
                placeholder="Çalışma günü/ay"
                className="rounded border bg-transparent px-2 py-1"
                style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
              />
              <input
                name="hoursPerDay"
                type="number"
                step="0.5"
                min="1"
                max="24"
                defaultValue="8"
                required
                placeholder="Saat/gün"
                className="rounded border bg-transparent px-2 py-1"
                style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
              />
              <input
                name="efficiencyRate"
                type="number"
                step="0.01"
                min="0.05"
                max="2"
                defaultValue="0.85"
                required
                placeholder="Verim (0.85 = %85)"
                className="rounded border bg-transparent px-2 py-1"
                style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
              />
              <input
                name="tornaRateTLPerMin"
                type="number"
                step="0.01"
                min="0"
                placeholder="Torna TL/dk"
                className="rounded border bg-transparent px-2 py-1"
                style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
              />
              <input
                name="frezeRateTLPerMin"
                type="number"
                step="0.01"
                min="0"
                placeholder="Freze TL/dk"
                className="rounded border bg-transparent px-2 py-1"
                style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
              />
              <input
                name="notes"
                placeholder="Not (opsiyonel)"
                className="rounded border bg-transparent px-2 py-1 sm:col-span-2"
                style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
              />
              <SubmitButton
                pendingLabel="Kaydediliyor…"
                className="rounded border px-2 py-1 disabled:opacity-60"
                style={{
                  borderColor: "var(--line)",
                  background: "var(--surface-2)",
                  color: "var(--text-1)",
                }}
              >
                Parametreyi kaydet
              </SubmitButton>
            </form>
          </details>
        </Panel>
      ) : null}

      <Panel
        title="KAYNAK GELİR DAĞILIMI"
        subtitle="Kapasite ve V2 sözleşme satırlarından okunan parça bazlı kaynak gelir özeti"
        right={
          <Badge tone={revSummary.unknownRevenueCount > 0 ? "amber" : "neutral"}>
            {revSummary.totalPartCount} parça
          </Badge>
        }
      >
        {revSummary.totalPartCount === 0 ? (
          <EmptyState>
            Henüz kaynak gelir verisi içeren üretim parçası yok — kapasite çalışma kitabı içe aktarıldığında V2 ve klasik gelir dağılımı burada gösterilir.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <KeyStat
                label="Toplam Bilinen Kaynak Gelir"
                value={fmtTL(revSummary.totalKnownRevenueTry)}
                tone="pos"
              />
              <KeyStat
                label="V2 Sözleşme Geliri"
                value={fmtTL(revSummary.v2RevenueTry)}
                sub={`${revSummary.v2Count} parça (satis_fiyati × adet)`}
                tone="info"
              />
              <KeyStat
                label="Klasik Kapasite Geliri"
                value={fmtTL(revSummary.legacyRevenueTry)}
                sub={`${revSummary.legacyCount} parça (I sütunu)`}
                tone="neutral"
              />
              <KeyStat
                label="Geliri Bilinmeyen Parça"
                value={`${revSummary.unknownRevenueCount} / ${revSummary.totalPartCount}`}
                tone={revSummary.unknownRevenueCount > 0 ? "warn" : "pos"}
              />
            </div>
            {revSummary.topParts.length > 0 ? (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th>Parça Kodu</th>
                      <th>Parça Adı</th>
                      <th className="text-right">Adet</th>
                      <th>Kaynak Biçimi</th>
                      <th className="text-right">Kaynak Gelir (TRY)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revSummary.topParts.map((pt) => (
                      <tr key={pt.partId}>
                        <td className="font-mono text-xs">{pt.partCode ?? "—"}</td>
                        <td className="text-xs">{pt.partName}</td>
                        <td className="text-right font-mono text-xs">{pt.quantity ?? "—"}</td>
                        <td>
                          <Badge tone={pt.source === "v2" ? "blue" : pt.source === "legacy" ? "green" : "neutral"}>
                            {pt.source}
                          </Badge>
                        </td>
                        <td className="text-right font-mono text-xs">{fmtTL(pt.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            ) : null}
          </div>
        )}
      </Panel>

      <Panel title="Analiz alanları">
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            ["/production/capacity", "Kapasite", "Aylık etkin dakika ve yıllık talebi incele"],
            ["/production/costs", "Maliyet", "Normal ve mesaili başabaş hesabını incele"],
            ["/production/profitability", "Parça Kârlılığı", "Düşük marjlı parçaları ayrıntılı gör"],
            ["/production/roi", "Makine ve ROI", "Yatırım ve finansman tahsisini incele"],
          ].map((x) => (
            <Link
              key={x[0]}
              href={x[0]}
              className="border p-3"
              style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
            >
              <b>{x[1]}</b>
              <p className="mt-1 text-xs" style={{ color: "var(--text-3)" }}>
                {x[2]}
              </p>
            </Link>
          ))}
        </div>
      </Panel>
    </>
  );
}
