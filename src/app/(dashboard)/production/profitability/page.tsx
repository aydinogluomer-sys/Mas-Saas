import Link from "@/components/ui/app-link";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import { ProfitabilityTable, type ProfitabilityRow } from "@/components/production/profitability-table";
import { profitabilityModel } from "@/lib/analytics/models";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { loadCostModels, loadPartProfitability } from "@/lib/production/engine";
import { loadLatestSpotRatesToTry } from "@/lib/production/fx-rates";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

export default async function ProfitabilityPage({
  searchParams,
}: {
  searchParams?: Promise<{ modelId?: string }>;
}) {
  const denied = await requireRouteAccess("/production/profitability");
  if (denied) return denied;
  const sp = searchParams ? await searchParams : {};
  const pool = getPool();

  const [costModels, spotRates] = await Promise.all([
    loadCostModels(pool),
    loadLatestSpotRatesToTry(pool),
  ]);

  const activeModelId =
    sp.modelId && costModels.some((m) => m.id === sp.modelId) ? sp.modelId : null;
  const rows = await loadPartProfitability(pool, 300, activeModelId);

  const data: ProfitabilityRow[] = rows.map((row) => ({
    part_code: row.part_code,
    part_name: row.part_name,
    quantity: row.quantity ?? null,
    currency: row.currency ?? "TRY",
    unit_sale_price: row.unit_sale_price ?? null,
    scenario_type: row.scenario_type ?? null,
    revenue: row.revenue,
    cost: row.cost,
    margin: row.margin,
    margin_rate: row.margin_rate,
    confidence: row.confidence,
    missing_operation_time: row.missing_operation_time,
  }));

  const exportPartCount = data.filter((d) => d.currency && d.currency !== "TRY").length;
  const lossPartCount = data.filter((d) => d.margin != null && d.margin < 0).length;
  const totalMarginTry = data.reduce((acc, d) => acc + (d.margin ?? 0), 0);
  const usdRate = spotRates.USD?.rate ?? null;
  const eurRate = spotRates.EUR?.rate ?? null;

  return (
    <>
      <PageHeader
        title="Parça Kârlılığı (İhracat Kur Çevrimli & Tekilleştirilmiş)"
        subtitle="USD/EUR ihracat satışları ve ithal 710 BOM girdileri güncel TCMB kurlarıyla TL'ye çevrilir; mükerrer içe aktarım satırları parça bazında tekilleştirilir"
        meta={
          <span className="text-xs" style={{ color: "var(--warn)" }}>
            Analitik tahmin · TCMB Spot Kur
          </span>
        }
      />

      <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiCard label="Tekil Parça Sayısı" value={data.length.toLocaleString("tr-TR")} note="Parça kodu / ID bazında tekil" />
        <KpiCard
          label="Zararına Üretilen Parça"
          value={lossPartCount.toLocaleString("tr-TR")}
          tone={lossPartCount > 0 ? "neg" : "pos"}
          note={lossPartCount > 0 ? "Negatif birim marj" : "Zararda parça yok"}
        />
        <KpiCard
          label="Toplam Tahmini Marj"
          value={data.length === 0 ? "—" : fmtTL(totalMarginTry)}
          tone={totalMarginTry < 0 ? "neg" : "pos"}
        />
        <KpiCard
          label="TCMB Referans Kur & İhracat"
          value={
            usdRate != null || eurRate != null
              ? `${usdRate != null ? `$ ${usdRate.toFixed(2)}` : "—"} · ${eurRate != null ? `€ ${eurRate.toFixed(2)}` : "—"}`
              : "Kur bekleniyor"
          }
          tone="info"
          note={`${exportPartCount} dövizli parça (1:1 TL sayılmaz)`}
        />
      </div>

      {costModels.length > 0 ? (
        <div
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--line)",
            background: "var(--surface-1)",
            color: "var(--text-2)",
          }}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono font-semibold" style={{ color: "var(--text-1)" }}>
              Baz Maliyet Modeli:
            </span>
            <Link
              href="/production/profitability"
              className="rounded border px-2 py-0.5 font-mono"
              style={{
                borderColor: !activeModelId ? "var(--text-1)" : "var(--line)",
                background: !activeModelId ? "var(--surface-2)" : "transparent",
                color: "var(--text-1)",
              }}
            >
              Otomatik (Normal Öncelikli)
            </Link>
            {costModels.map((cm) => {
              const active = activeModelId === cm.id;
              return (
                <Link
                  key={cm.id}
                  href={`/production/profitability?modelId=${encodeURIComponent(cm.id)}`}
                  className="rounded border px-2 py-0.5 font-mono"
                  style={{
                    borderColor: active ? "var(--text-1)" : "var(--line)",
                    background: active ? "var(--surface-2)" : "transparent",
                    color: "var(--text-1)",
                  }}
                >
                  {cm.name} ({cm.scenario})
                </Link>
              );
            })}
          </div>
          <Badge tone="blue">710 BOM + Diğer Op. Dk Dahil</Badge>
        </div>
      ) : null}

      <AnalyticsChart model={profitabilityModel(rows, istanbulDateISO())} kind="bar" defaultPeriod="all" />
      <Panel
        title={`${data.length} tekilleştirilmiş parça`}
        subtitle="En düşük marj oranından başlayarak sıralanır; dövizli satışlarda güncel TCMB kur çevrimi uygulanmıştır"
      >
        <ProfitabilityTable rows={data} />
      </Panel>
    </>
  );
}
