import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { EmptyState, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { SubmitButton } from "@/components/ui/submit-button";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { loadFinanceCostAllocations, loadMachineRoi, loadMachineRoiAggregate } from "@/lib/production/engine";
import { loadCapexRoiSnapshots } from "@/lib/production/erp-lite";
import { simulateCapexRoiAction, upsertMachineRoiParameterAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function RoiPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; result?: string }>;
}) {
  const denied = await requireRouteAccess("/production/roi");
  if (denied) return denied;
  const session = await getRequestUser();
  const canEditMachines = can(session?.role ?? "viewer", "machine_assets", "insert");
  const sp = searchParams ? await searchParams : {};

  const p = getPool();
  const [machines, total, finance, capexSnapshots] = await Promise.all([
    loadMachineRoi(p),
    loadMachineRoiAggregate(p),
    loadFinanceCostAllocations(p),
    loadCapexRoiSnapshots(p),
  ]);

  const totalNpvTry =
    capexSnapshots.some((s) => s.npvTry != null)
      ? capexSnapshots.reduce((acc, s) => acc + (s.npvTry ?? 0), 0)
      : null;
  const totalTaxShieldTry =
    capexSnapshots.some((s) => s.taxShieldAmountTry != null)
      ? capexSnapshots.reduce((acc, s) => acc + (s.taxShieldAmountTry ?? 0), 0)
      : null;
  const totalDeprTry =
    capexSnapshots.some((s) => s.annualDepreciationTry != null)
      ? capexSnapshots.reduce((acc, s) => acc + (s.annualDepreciationTry ?? 0), 0)
      : null;

  return (
    <>
      <PageHeader
        title="Makine Yatırım Fizibilitesi (CAPEX NPV · IRR · 253/257 Vergi Kalkanı)"
        subtitle="TDHP 253/257 doğrusal amortisman, %25 kurumlar vergisi kalkanı, WACC/TLREF bazlı NPV, IRR ve iskontolu geri ödeme analizi"
        meta={
          <span className="text-xs" style={{ color: "var(--warn)" }}>
            Analitik CAPEX & ROI modeli
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

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiCard
          label="Toplam Net Bugünkü Değer (NPV)"
          value={totalNpvTry == null ? "—" : fmtTL(totalNpvTry)}
          tone={totalNpvTry == null ? "neutral" : totalNpvTry >= 0 ? "pos" : "neg"}
          note="WACC / TLREF ile iskontolanmış değer"
        />
        <KpiCard
          label="Yıllık Amortisman (TDHP 253/257)"
          value={totalDeprTry == null ? "—" : fmtTL(totalDeprTry)}
          tone="info"
          note="Alış bedeli / ekonomik ömür"
        />
        <KpiCard
          label="Yıllık %25 Vergi Kalkanı"
          value={totalTaxShieldTry == null ? "—" : fmtTL(totalTaxShieldTry)}
          tone="pos"
          note="Amortisman × %25 kurumlar vergisi"
        />
        <KpiCard
          label="Klasik ROI Vergi Sonrası Net"
          value={fmtTL(total?.net)}
          tone={(total?.net ?? 0) < 0 ? "neg" : "pos"}
          note={total?.snapshot_year ? `Baz yıl: ${total.snapshot_year}` : "Toplam anlık görüntü"}
        />
      </div>

      {canEditMachines ? (
        <Panel
          title="CAPEX FİZİBİLİTE SİMÜLATÖRÜ (NPV · IRR · İSKONTOLU GERİ ÖDEME)"
          subtitle="Yeni tezgâh / otomasyon yatırımını TDHP 253/257 amortismanı ve %25 kurumlar vergisi kalkanı ile simüle edip kaydedin"
        >
          <form action={simulateCapexRoiAction} className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-4">
            <input type="hidden" name="backTo" value="/production/roi" />
            <input
              name="machineName"
              required
              placeholder="Tezgâh / Yatırım adı (örn. 5 Eksen CNC İşleme Merkezi)"
              className="rounded border px-2 py-1.5 sm:col-span-2"
              style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
            />
            <input
              name="machineCode"
              placeholder="Makine kodu (örn. CNC-05)"
              className="rounded border px-2 py-1.5"
              style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
            />
            <input
              name="purchaseDate"
              type="date"
              className="rounded border px-2 py-1.5"
              style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
            />
            <input
              name="purchaseCostTry"
              type="number"
              step="0.01"
              min="1"
              required
              placeholder="253 Yatırım Bedeli CAPEX (TL)"
              className="rounded border px-2 py-1.5"
              style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
            />
            <input
              name="usefulLifeYears"
              type="number"
              min="1"
              max="50"
              defaultValue="5"
              required
              placeholder="Ekonomik ömür (Yıl, örn. 5)"
              className="rounded border px-2 py-1.5"
              style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
            />
            <input
              name="discountRatePct"
              type="number"
              step="0.1"
              min="0"
              max="300"
              defaultValue="35"
              required
              placeholder="WACC / TLREF İskonto % (örn. 35)"
              className="rounded border px-2 py-1.5"
              style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
            />
            <input
              name="snapshotYear"
              type="number"
              min="2000"
              max="2100"
              defaultValue={new Date().getFullYear()}
              placeholder="Simülasyon Yılı"
              className="rounded border px-2 py-1.5"
              style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
            />
            <input
              name="annualRevenueTry"
              type="number"
              step="0.01"
              min="0"
              required
              placeholder="Yıllık Beklenen Brüt Katkı / Gelir (TL)"
              className="rounded border px-2 py-1.5"
              style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
            />
            <input
              name="annualOperatingCostTry"
              type="number"
              step="0.01"
              min="0"
              required
              placeholder="Yıllık İşletme / Enerji / Bakım Gideri (TL)"
              className="rounded border px-2 py-1.5"
              style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
            />
            <input
              name="notes"
              placeholder="Fizibilite notu (opsiyonel)"
              className="rounded border px-2 py-1.5"
              style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
            />
            <SubmitButton
              pendingLabel="Hesaplanıyor…"
              className="rounded border px-3 py-1.5 font-mono text-xs font-semibold disabled:opacity-60"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface-2)",
                color: "var(--text-1)",
              }}
            >
              NPV / IRR Hesapla ve Kaydet
            </SubmitButton>
          </form>

          <details className="mt-3 rounded border p-2" style={{ borderColor: "var(--line-faint)" }}>
            <summary className="cursor-pointer font-mono text-xs font-semibold" style={{ color: "var(--text-2)" }}>
              + Klasik makine / yıllık ROI kaydı ekle veya güncelle
            </summary>
            <form action={upsertMachineRoiParameterAction} className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-4">
              <input type="hidden" name="backTo" value="/production/roi" />
              <input
                name="name"
                required
                placeholder="Makine adı (örn. Awea)"
                className="rounded border px-2 py-1"
                style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
              />
              <input
                name="machineCode"
                placeholder="Makine kodu (örn. FR-01)"
                className="rounded border px-2 py-1"
                style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
              />
              <input
                name="purchaseDate"
                type="date"
                className="rounded border px-2 py-1"
                style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
              />
              <input
                name="purchaseCost"
                type="number"
                step="0.01"
                min="0"
                placeholder="Alış bedeli (TL)"
                className="rounded border px-2 py-1"
                style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
              />
              <input
                name="monthlyRevenue"
                type="number"
                step="0.01"
                min="0"
                placeholder="Aylık gelir (TL)"
                className="rounded border px-2 py-1"
                style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
              />
              <input
                name="monthlyOperatingCost"
                type="number"
                step="0.01"
                min="0"
                placeholder="Aylık op. maliyeti (TL)"
                className="rounded border px-2 py-1"
                style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
              />
              <input
                name="usefulLifeMonths"
                type="number"
                min="1"
                placeholder="Faydalı ömür (ay)"
                className="rounded border px-2 py-1"
                style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
              />
              <input
                name="snapshotYear"
                type="number"
                min="2000"
                max="2100"
                defaultValue={new Date().getFullYear()}
                placeholder="ROI yılı"
                className="rounded border px-2 py-1"
                style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
              />
              <input
                name="annualRevenue"
                type="number"
                step="0.01"
                min="0"
                placeholder="Yıllık gelir (TL)"
                className="rounded border px-2 py-1"
                style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
              />
              <input
                name="annualCost"
                type="number"
                step="0.01"
                min="0"
                placeholder="Yıllık maliyet (TL)"
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
                Makineyi kaydet
              </button>
            </form>
          </details>
        </Panel>
      ) : null}

      <Panel
        title="CAPEX YATIRIM FİZİBİLİTE TABLOSU (253/257 AMORTİSMAN · VERGİ KALKANI · NPV · IRR)"
        subtitle="Makine varlıkları için hesaplanan sermaye bütçelemesi metrikleri"
        right={<Badge tone="neutral">{capexSnapshots.length} analiz</Badge>}
      >
        {capexSnapshots.length === 0 ? (
          <EmptyState>
            Henüz CAPEX fizibilite simülasyonu bulunmuyor. Yukarıdaki simülatörden yatırım bedeli, ekonomik ömür ve WACC/TLREF iskonto oranını girerek NPV ve IRR hesaplayabilirsiniz.
          </EmptyState>
        ) : (
          <TableShell>
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr
                  className="border-b font-mono text-[10px] uppercase"
                  style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                >
                  <th className="py-2 pr-2">Tezgâh / Yatırım</th>
                  <th className="py-2 px-2 text-right">CAPEX (253)</th>
                  <th className="py-2 px-2 text-right">Ömür / WACC</th>
                  <th className="py-2 px-2 text-right">257 Amortisman/Yıl</th>
                  <th className="py-2 px-2 text-right">%25 Vergi Kalkanı</th>
                  <th className="py-2 px-2 text-right">Net Nakit/Yıl</th>
                  <th className="py-2 px-2 text-right">NPV (TL)</th>
                  <th className="py-2 px-2 text-right">IRR (%)</th>
                  <th className="py-2 px-2 text-right">Basit / İsk. Geri Ödeme</th>
                  <th className="py-2 pl-2">Karar</th>
                </tr>
              </thead>
              <tbody>
                {capexSnapshots.map((s) => {
                  const npvPositive = s.npvTry != null && s.npvTry > 0;
                  return (
                    <tr
                      key={s.snapshotId}
                      className="border-b"
                      style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                    >
                      <td className="py-2 pr-2">
                        <span className="font-semibold">{s.machineName}</span>
                        {s.machineCode ? (
                          <span className="ml-1 font-mono text-[11px]" style={{ color: "var(--text-3)" }}>
                            ({s.machineCode})
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {fmtTL(s.purchaseCostTry)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {s.usefulLifeYears != null ? `${s.usefulLifeYears} yıl` : "—"}
                        {s.discountRatePct != null ? ` · %${s.discountRatePct.toFixed(1)}` : ""}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {fmtTL(s.annualDepreciationTry)}
                      </td>
                      <td
                        className="py-2 px-2 text-right font-mono tabular-nums"
                        style={{ color: "var(--pos)" }}
                      >
                        {fmtTL(s.taxShieldAmountTry)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {fmtTL(s.netAfterTaxTry)}
                      </td>
                      <td
                        className="py-2 px-2 text-right font-mono font-semibold tabular-nums"
                        style={{
                          color:
                            s.npvTry == null
                              ? "var(--text-3)"
                              : npvPositive
                                ? "var(--pos)"
                                : "var(--neg)",
                        }}
                      >
                        {fmtTL(s.npvTry)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {s.irrPct == null ? "—" : `%${s.irrPct.toFixed(2)}`}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {s.paybackMonths != null ? `${s.paybackMonths.toFixed(1)} ay` : "—"}
                        {" / "}
                        {s.discountedPaybackMonths != null
                          ? `${s.discountedPaybackMonths.toFixed(1)} ay`
                          : "Ömür aşımı"}
                      </td>
                      <td className="py-2 pl-2">
                        {s.npvTry == null ? (
                          <Badge tone="neutral">{s.confidence}</Badge>
                        ) : npvPositive ? (
                          <Badge tone="green">Yatırım Uygun</Badge>
                        ) : (
                          <Badge tone="red">NPV Negatif</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="Klasik Makine ROI Özeti">
        {machines.length === 0 ? (
          <p className="py-2 text-sm" style={{ color: "var(--text-3)" }}>
            Kayıtlı makine yok.
          </p>
        ) : (
          machines.map((m, i) => (
            <div
              key={`${m.name}-${i}`}
              className="grid grid-cols-2 gap-2 border-b py-2 text-sm sm:grid-cols-5"
              style={{ borderColor: "var(--line-faint)" }}
            >
              <b>{m.name}</b>
              <span>Alım {fmtTL(m.purchase_cost)}</span>
              <span>Gelir {fmtTL(m.revenue)}</span>
              <span>Maliyet {fmtTL(m.cost)}</span>
              <span style={{ color: (m.net ?? 0) < 0 ? "var(--neg)" : "var(--pos)" }}>
                Net {fmtTL(m.net)}
              </span>
            </div>
          ))
        )}
      </Panel>

      <Panel title="Finansman tahsisi">
        {finance.length === 0 ? (
          <p className="py-2 text-sm" style={{ color: "var(--text-3)" }}>
            Finansman tahsis kaydı yok.
          </p>
        ) : (
          finance.map((r, i) => (
            <div
              key={`${r.loan_name}-${r.operation_type}-${i}`}
              className="grid grid-cols-2 gap-2 border-b py-2 text-sm sm:grid-cols-4"
              style={{ borderColor: "var(--line-faint)" }}
            >
              <b>{r.loan_name}</b>
              <span>{r.operation_type}</span>
              <span>{fmtTL(r.allocated_finance_cost)}</span>
              <span>
                {r.finance_cost_per_minute == null ? "—" : `${r.finance_cost_per_minute.toFixed(2)} TL/dk`}
              </span>
            </div>
          ))
        )}
      </Panel>
    </>
  );
}
