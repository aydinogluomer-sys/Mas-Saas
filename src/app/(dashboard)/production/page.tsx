import Link from "next/link";
import { getPool } from "@/lib/db";
import {
  loadActualMonthlyIncome,
  loadCapacityDemand,
  loadCapacityModels,
  loadCostBreakdown,
  loadCostModels,
  loadMachineRoi,
  loadPartProfitability,
} from "@/lib/production/engine";
import {
  buildInsights,
  compareScenarios,
  priceMargin,
  revenueGap,
  utilizationRate,
  type ScenarioModel,
} from "@/lib/production/rules";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { DetailsDisclosure, Disclaimer, PageHeader } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

const fmt0 = (v: number | null) =>
  v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—";
const fmt2 = (v: number | null) =>
  v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(v) : "—";

export default async function ProductionPage() {
  const pool = getPool();
  const [caps, costs, parts, roi, demand, actualIncome] = await Promise.all([
    loadCapacityModels(pool),
    loadCostModels(pool),
    loadPartProfitability(pool, 20),
    loadMachineRoi(pool),
    loadCapacityDemand(pool),
    loadActualMonthlyIncome(pool),
  ]);

  if (caps.length === 0 && costs.length === 0) {
    return (
      <Panel title="ÜRETİM — KAPASİTE / MALİYET">
        <p className="text-sm text-zinc-500">
          Henüz kapasite/maliyet modeli yok.{" "}
          <Link className="underline underline-offset-2" href="/imports">İçe aktarım</Link>{" "}
          sayfasından workbook detayına girip &quot;üretim analitiğini aktar&quot; ile başlayın.
        </p>
      </Panel>
    );
  }

  const cap = caps[0] as unknown as {
    id: string; name: string; efficiency: number | null; frezeRateTLPerMin: number | null;
    tornaRateTLPerMin: number | null; rateYear: number | null; isStaleRate: boolean;
    theoreticalMonthlyRevenue: number | null; theoreticalTotalRevenue: number | null;
    partCount: number; missingPartCount: number; sheetId: string | null; workbookId: string | null;
  };
  const normal = costs.find((c) => c.scenario === "normal");
  const overtime = costs.find((c) => c.scenario === "overtime");

  const normalModel: ScenarioModel = {
    scenario: "normal", effMinutes: normal?.effectiveMinutes ?? null,
    monthlyCost: normal?.monthlyCost ?? null, breakEvenTLPerMin: normal?.breakEven ?? null, efficiency: cap?.efficiency ?? null,
  };
  const overtimeModel: ScenarioModel = {
    scenario: "overtime", effMinutes: overtime?.effectiveMinutes ?? null,
    monthlyCost: overtime?.monthlyCost ?? null, breakEvenTLPerMin: overtime?.breakEven ?? null, efficiency: null,
  };
  const comparison = normal && overtime ? compareScenarios(normalModel, overtimeModel) : null;

  // Phase 9A: margin of the customer (Akon) price over each scenario's OWN break-even.
  // Each cost sheet carries its own Akon TL/dk assumption — use per-model rates.
  const marginRows = costs
    .filter((c) => c.breakEven != null && (c.akonFreze != null || c.akonTorna != null))
    .map((c) => ({
      scenario: c.scenario,
      freze: priceMargin(c.breakEven, c.akonFreze),
      torna: priceMargin(c.breakEven, c.akonTorna),
    }));
  const anyLoss = marginRows.some((m) => m.freze.loss || m.torna.loss);
  // fixed-cost breakdown of the normal model (primary) for the detail section
  const breakdown = normal ? await loadCostBreakdown(pool, normal.id) : [];

  // annual effective minutes (normal single shift) vs total part demand
  const annualEff = normal?.effectiveMinutes != null ? normal.effectiveMinutes * 12 : null;
  const utilization = utilizationRate(demand.demandMinutes, annualEff);
  const rGap = revenueGap(cap?.theoreticalMonthlyRevenue ?? null, actualIncome);
  const insights = buildInsights({
    utilization,
    comparison,
    revenueGapRatio: rGap.ratio,
    isStaleRate: cap?.isStaleRate ?? false,
    missingPartCount: cap?.missingPartCount ?? 0,
    totalPartCount: cap?.partCount ?? 0,
  });

  return (
    <>
      <PageHeader
        title="Üretim Analitiği"
        subtitle="Kapasite · başabaş TL/dk · normal vs mesaili · parça kârlılığı · makine ROI"
        meta={
          <>
            {cap?.isStaleRate && <Badge tone="amber" dot>{cap.rateYear} stale-rate</Badge>}
            <Badge tone="neutral">{cap?.partCount ?? 0} parça</Badge>
            {(cap?.missingPartCount ?? 0) > 0 && <Badge tone="amber">{cap!.missingPartCount} süre eksik</Badge>}
          </>
        }
        action={
          <Link
            href="/scenarios?from=production"
            className="border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider"
            style={{ color: "var(--accent)", borderColor: "var(--accent)", borderRadius: "var(--radius)", background: "color-mix(in srgb, var(--accent) 10%, transparent)" }}
          >
            kapasite senaryosu →
          </Link>
        }
      />

      <Disclaimer>⚠ Analitik tahmindir; muhasebe gerçeği değildir.</Disclaimer>

      {/* capacity overview cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card k="verim" v={cap?.efficiency != null ? `%${(cap.efficiency * 100).toFixed(0)}` : "—"} />
        <Card k="etkin dk/ay (normal)" v={fmt0(normal?.effectiveMinutes ?? null)} />
        <Card k="teorik aylık gelir" v={fmt0(cap?.theoreticalMonthlyRevenue ?? null)} />
        <Card
          k="TL/dk oranları"
          v={`freze ${fmt2(cap?.frezeRateTLPerMin ?? null)} · torna ${fmt2(cap?.tornaRateTLPerMin ?? null)}`}
          badge={cap?.isStaleRate ? <Badge tone="amber">{cap.rateYear} stale</Badge> : undefined}
        />
      </div>

      {/* KÂR MARJI — Akon fiyatı vs başabaş (decision-first) */}
      {marginRows.length > 0 && (
        <Panel
          title="KÂR MARJI — AKON FİYATI vs BAŞABAŞ"
          right={anyLoss ? <Badge tone="red">zararına satış var</Badge> : <Badge tone="green" dot>marj pozitif</Badge>}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {marginRows.map((m) => (
              <div key={m.scenario} className="border p-2.5" style={{ background: "var(--surface-2)", borderColor: "var(--line)", borderRadius: "var(--radius)" }}>
                <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
                  {m.scenario === "normal" ? "Normal vardiya" : "Mesaili"} · başabaş {fmt2(m.freze.breakEven)} TL/dk
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  <MarginCell op="Freze" m={m.freze} />
                  <MarginCell op="Torna" m={m.torna} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px]" style={{ color: "var(--text-4)" }}>
            Marj = Akon TL/dk fiyatı − başabaş. Negatif marj = o operasyonu zararına yapıyorsun. Belirsiz oran 0 sayılmaz.
          </p>
        </Panel>
      )}

      {/* insights */}
      <Panel title="ANALİTİK İÇGÖRÜ (deterministik, AI değil)">
        <ul className="space-y-1">
          {insights.map((s, i) => (
            <li key={i} className="font-mono text-[12px] text-zinc-300">• {s}</li>
          ))}
        </ul>
      </Panel>

      {/* normal vs mesaili */}
      {comparison && (
        <Panel
          title="NORMAL vs MESAİLİ"
          right={
            <Badge tone={comparison.verdict === "mesaili_iyilestiriyor" ? "green" : comparison.verdict === "mesaili_kotulestiriyor" ? "red" : "neutral"}>
              {comparison.verdict === "mesaili_iyilestiriyor" ? "mesaili iyileştiriyor" : comparison.verdict === "mesaili_kotulestiriyor" ? "mesaili kötüleştiriyor" : "belirsiz"}
            </Badge>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="py-1 pr-2">senaryo</th>
                  <th className="py-1 pr-2 text-right">etkin dk/ay</th>
                  <th className="py-1 pr-2 text-right">aylık maliyet</th>
                  <th className="py-1 text-right">başabaş TL/dk</th>
                </tr>
              </thead>
              <tbody>
                {[["normal", normal], ["mesaili", overtime]].map(([label, m]) => {
                  const cm = m as typeof normal;
                  return (
                    <tr key={label as string} className="border-b border-zinc-900">
                      <td className="py-1 pr-2 font-mono text-xs">{label as string}</td>
                      <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmt0(cm?.effectiveMinutes ?? null)}</td>
                      <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmt0(cm?.monthlyCost ?? null)}</td>
                      <td className="py-1 text-right font-mono tabular-nums text-sky-300">{fmt2(cm?.breakEven ?? null)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 font-mono text-[10px] text-zinc-500">
            Δ dakika {fmt0(comparison.minutesDelta)} · Δ maliyet {fmt0(comparison.costDelta)} · Δ başabaş {fmt2(comparison.breakEvenDelta)} TL/dk
          </p>
        </Panel>
      )}

      {/* utilization + revenue gap */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Panel
          title="KAPASİTE KULLANIMI"
          right={utilization != null && utilization > 1 ? <Badge tone="red">aşırı yük</Badge> : utilization != null && utilization < 0.6 ? <Badge tone="amber">atıl</Badge> : undefined}
        >
          <div className="space-y-1 font-mono text-[12px]">
            <Row k="toplam parça talebi (dk)" v={fmt0(demand.demandMinutes)} />
            <Row k="yıllık etkin kapasite (normal, dk)" v={fmt0(annualEff)} />
            <Row k="kullanım oranı" v={utilization != null ? `%${(utilization * 100).toFixed(0)}` : "—"} tone={utilization != null && utilization > 1 ? "red" : undefined} />
          </div>
          <p className="mt-2 font-mono text-[10px] text-zinc-600">
            Talep = Σ(adet × (torna+freze)); parça adetlerinin yıllık kabulü varsayımdır.
          </p>
        </Panel>
        <Panel
          title="TEORİK vs GERÇEK GELİR (aylık)"
          right={rGap.flagged ? <Badge tone="red">büyük fark</Badge> : undefined}
        >
          <div className="space-y-1 font-mono text-[12px]">
            <Row k="teorik (kapasite)" v={fmtTL(cap?.theoreticalMonthlyRevenue ?? null)} />
            <Row k="gerçek (nakit akış ort.)" v={fmtTL(actualIncome)} />
            <Row k="fark / gerçekleşme" v={`${fmt0(rGap.gap)} · ${rGap.ratio != null ? `%${(rGap.ratio * 100).toFixed(0)}` : "—"}`} tone={rGap.flagged ? "red" : undefined} />
          </div>
        </Panel>
      </div>

      {/* cost model table */}
      <Panel title="MALİYET MODELLERİ">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="py-1 pr-2">model</th>
                <th className="py-1 pr-2 text-right">aylık maliyet</th>
                <th className="py-1 pr-2 text-right">etkin dk/ay</th>
                <th className="py-1 pr-2 text-right">başabaş TL/dk</th>
                <th className="py-1">kaynak</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((c) => (
                <tr key={c.id} className="border-b border-zinc-900">
                  <td className="py-1 pr-2 font-mono text-xs">{c.name}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmt0(c.monthlyCost)}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmt0(c.effectiveMinutes)}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums text-sky-300">{fmt2(c.breakEven)}</td>
                  <td className="py-1 font-mono text-[10px] text-zinc-600">
                    {c.workbookId && c.sheetId ? (
                      <Link className="underline decoration-zinc-800 underline-offset-2" href={`/imports/${c.workbookId}/sheets/${c.sheetId}`}>
                        kaynak →
                      </Link>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* fixed-cost breakdown (technical detail, collapsed) */}
      {breakdown.length > 0 && (
        <DetailsDisclosure label={`Sabit gider dökümü — ${breakdown.length} kalem (normal model, kaynak kayıt)`}>
          <table className="w-full text-sm">
            <tbody>
              {breakdown.map((b, i) => (
                <tr key={i} className="border-b" style={{ borderColor: "var(--line-faint)" }}>
                  <td className="py-1 pr-2 font-mono text-[10px] uppercase" style={{ color: "var(--text-4)" }}>{b.block}</td>
                  <td className="py-1 pr-2">{b.label}</td>
                  <td className="py-1 text-right font-mono tabular-nums">
                    {b.amount != null ? fmt0(b.amount) : <Badge tone="amber">TUTAR EKSİK</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px]" style={{ color: "var(--text-4)" }}>
            Kaynak: maliyet sekmesi sabit gider defteri + genel/personel blokları. Bilinmeyen tutar 0 sayılmaz.
          </p>
        </DetailsDisclosure>
      )}

      {/* part profitability */}
      <Panel title={`PARÇA KÂRLILIĞI — en düşük 20 marj (${parts.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="py-1 pr-2">parça</th>
                <th className="py-1 pr-2 text-right">tahmini maliyet</th>
                <th className="py-1 pr-2 text-right">gelir</th>
                <th className="py-1 pr-2 text-right">marj</th>
                <th className="py-1 pr-2">güven</th>
                <th className="py-1">kaynak</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p, i) => (
                <tr key={i} className="border-b border-zinc-900">
                  <td className="py-1 pr-2 text-xs">
                    {p.part_code ?? "—"} <span className="text-zinc-500">{p.part_name}</span>
                  </td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmt0(p.cost)}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmt0(p.revenue)}</td>
                  <td className={`py-1 pr-2 text-right font-mono tabular-nums ${p.margin != null && p.margin < 0 ? "text-red-400" : ""}`}>
                    {p.margin != null ? fmt0(p.margin) : <Badge tone="amber">HESAPLANAMADI</Badge>}
                  </td>
                  <td className="py-1 pr-2">
                    {p.missing_operation_time ? <Badge tone="amber">süre eksik</Badge> : <span className="font-mono text-[10px] text-zinc-500">{p.confidence}</span>}
                  </td>
                  <td className="py-1 font-mono text-[10px] text-zinc-600">
                    {p.source_workbook_id && p.source_sheet_id ? (
                      <Link className="underline decoration-zinc-800 underline-offset-2" href={`/imports/${p.source_workbook_id}/sheets/${p.source_sheet_id}`}>
                        {p.row_index != null ? `r${p.row_index}` : "kaynak"} →
                      </Link>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 font-mono text-[10px] text-zinc-600">
          Marj = gelir − (dakika × başabaş TL/dk). &quot;süre eksik&quot; parçalarda maliyet hesaplanmaz (null asla 0 sayılmaz).
        </p>
      </Panel>

      {/* machine ROI */}
      <Panel title="MAKİNE ROI" right={<Badge tone="amber">inceleme gerekli</Badge>}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="py-1 pr-2">makine</th>
              <th className="py-1 pr-2 text-right">gelir</th>
              <th className="py-1 pr-2 text-right">maliyet</th>
              <th className="py-1 pr-2 text-right">net (vergi sonrası)</th>
              <th className="py-1">güven</th>
            </tr>
          </thead>
          <tbody>
            {roi.map((m, i) => (
              <tr key={i} className="border-b border-zinc-900">
                <td className="py-1 pr-2 font-mono text-xs">{m.name}</td>
                <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmt0(m.revenue)}</td>
                <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmt0(m.cost)}</td>
                <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmt0(m.net)}</td>
                <td className="py-1">{m.confidence ? <Badge tone="amber">{m.confidence}</Badge> : <span className="text-zinc-600">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 font-mono text-[10px] text-zinc-600">
          ROI verisi &quot;tablo&quot; sekmesinden gelir (kişisel/şirket karışık) — insan incelemesi olmadan güvenilir sayılmaz.
        </p>
      </Panel>
    </>
  );
}

function MarginCell({ op, m }: { op: string; m: ReturnType<typeof priceMargin> }) {
  const color = m.margin == null ? "var(--text-4)" : m.loss ? "var(--neg)" : "var(--pos)";
  return (
    <div className="border p-1.5" style={{ borderColor: "var(--line-faint)", borderRadius: "var(--radius)" }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-3)" }}>{op}</div>
      <div className="font-mono text-sm tabular-nums" style={{ color }}>
        {m.margin == null ? "—" : `${m.margin > 0 ? "+" : ""}${fmt2(m.margin)} TL/dk`}
      </div>
      <div className="text-[10px]" style={{ color: "var(--text-4)" }}>
        fiyat {fmt2(m.price)}{m.marginRate != null ? ` · %${(m.marginRate * 100).toFixed(0)}` : ""}{m.loss ? " · zarar" : ""}
      </div>
    </div>
  );
}

function Card({ k, v, badge }: { k: string; v: string; badge?: React.ReactNode }) {
  return (
    <div className="border border-zinc-800 bg-black/40 p-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">{k}</span>
        {badge}
      </div>
      <div className="mt-1 font-mono text-sm tabular-nums text-zinc-200">{v}</div>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: "red" }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-500">{k}</span>
      <span className={`tabular-nums ${tone === "red" ? "text-red-400" : "text-zinc-200"}`}>{v}</span>
    </div>
  );
}
