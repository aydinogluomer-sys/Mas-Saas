import Link from "next/link";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { CashflowWaterfall } from "@/components/charts/cashflow-waterfall";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { KpiCard, ModuleEmptyState, PageHeader } from "@/components/ui/shell";
import type { AnalyticsPeriod } from "@/lib/analytics/chart";
import { cashTrendModel } from "@/lib/analytics/models";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { getPool } from "@/lib/db";
import { buildProjection, horizonCards } from "@/lib/radar/rules";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";
const ym = (value: string | null) => value ? value.slice(0, 7) : "yok";

const VALID_PERIODS: AnalyticsPeriod[] = ["3m", "6m", "12m", "24m", "all"];
const PERIOD_BY_HORIZON: Record<number, AnalyticsPeriod> = { 3: "3m", 6: "6m", 12: "12m", 24: "24m", 36: "all" };

export default async function CashflowOverview({ searchParams }: { searchParams?: Promise<{ chartPeriod?: string }> }) {
  const requested = (await searchParams)?.chartPeriod;
  const period: AnalyticsPeriod = VALID_PERIODS.includes(requested as AnalyticsPeriod) ? requested as AnalyticsPeriod : "12m";
  const months = await loadCashMonths(getPool());
  if (!months.length) return <><PageHeader title="Nakit akışı özeti" subtitle="Aylık nakit verisi bekleniyor." /><ModuleEmptyState eyebrow="Veri bekleniyor" title="Nakit akışı aktarılınca özet burada oluşur." body="Kaynak Excel kayıtları korunarak aylık projeksiyona aktarılır." primaryHref="/data/imports" primaryLabel="İçe aktarımları aç" /></>;
  const projection = buildProjection(months);
  const cards = horizonCards(months, `${istanbulDateISO().slice(0, 7)}-01`);
  return <>
    <PageHeader title="Nakit akışı özeti" subtitle={`${months.length} aylık karar görünümü`} meta={projection.firstNegativeMonth ? <Badge tone="red">ilk negatif {ym(projection.firstNegativeMonth)}</Badge> : <Badge tone="green" dot>negatif ay yok</Badge>} action={<Link href="/scenarios" className="button-accent px-3 py-2">Senaryoda dene</Link>} />
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <KpiCard label="Runway" value={projection.firstNegativeMonth ? ym(projection.firstNegativeMonth) : "Ufuk boyunca pozitif"} tone={projection.firstNegativeMonth ? "neg" : "pos"} />
      <KpiCard label="En kötü ay" value={ym(projection.worstMonth)} tone="neg" note={fmtTL(projection.worstBalance)} />
      <KpiCard label="Negatif ay" value={months.filter((month) => month.closing != null && month.closing < 0).length} />
      <KpiCard label="Ardışık negatif" value={projection.longestNegativeRun.length} />
    </div>
    <AnalyticsChart key={period} model={cashTrendModel(months, istanbulDateISO())} defaultPeriod={period} />
    <CashflowWaterfall months={months} />
    <Panel title="DÖNEM UFUKLARI"><div className="grid grid-cols-2 gap-2 lg:grid-cols-5">{cards.map((card) => {
      const cardPeriod = PERIOD_BY_HORIZON[card.horizonMonths];
      const active = cardPeriod != null && cardPeriod === period;
      const tile = <KpiCard label={`${card.horizonMonths} ay`} value={fmtTL(card.endClosing)} tone={card.endClosing != null && card.endClosing < 0 ? "neg" : "neutral"} note={active ? "Grafikte gösteriliyor" : "Grafikte göster"} />;
      return cardPeriod == null
        ? <div key={card.horizonMonths}>{tile}</div>
        : <Link key={card.horizonMonths} href={`/cashflow?chartPeriod=${cardPeriod}`} scroll={false} aria-current={active ? "true" : undefined} className="block" style={active ? { borderRadius: "var(--radius)", outline: "2px solid var(--accent)", outlineOffset: "1px" } : undefined}>{tile}</Link>;
    })}</div></Panel>
  </>;
}
