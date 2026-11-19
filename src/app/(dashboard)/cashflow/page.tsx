import Link from "@/components/ui/app-link";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import {
  CashflowWaterfallSvg,
  EditorialDonutChartSvg,
  type DonutSlice,
  type WaterfallStep,
} from "@/components/charts/editorial-cockpit-charts";
import { BulletBarSvg } from "@/components/charts/folio-visuals";
import { ActionFeedback } from "@/components/ui/action-feedback";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import type { AnalyticsPeriod } from "@/lib/analytics/chart";
import { cashTrendModel } from "@/lib/analytics/models";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { loadHybridCashMonths } from "@/lib/cashflow/live-hybrid";
import { getPool } from "@/lib/db";
import { decimal, money, sub, sumMoney } from "@/lib/money";
import { buildProjection, horizonCards } from "@/lib/radar/rules";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";
const ym = (value: string | null) => (value ? value.slice(0, 7) : "yok");

const VALID_PERIODS: AnalyticsPeriod[] = ["3m", "6m", "12m", "24m", "all"];
const PERIOD_BY_HORIZON: Record<number, AnalyticsPeriod> = {
  3: "3m",
  6: "6m",
  12: "12m",
  24: "24m",
  36: "all",
};

export default async function CashflowOverview({
  searchParams,
}: {
  searchParams?: Promise<{ chartPeriod?: string; error?: string; notice?: string }>;
}) {
  const denied = await requireRouteAccess("/cashflow");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const requested = sp.chartPeriod;
  const period: AnalyticsPeriod = VALID_PERIODS.includes(requested as AnalyticsPeriod)
    ? (requested as AnalyticsPeriod)
    : "12m";

  const today = istanbulDateISO();
  const { months, sourceMode, tms7Total } = await loadHybridCashMonths(getPool(), today);
  const projection = buildProjection(months);
  const cards = horizonCards(months, `${today.slice(0, 7)}-01`);

  const modeLabel =
    sourceMode === "hybrid"
      ? "Canlı Banka + Tahmin + Excel Hibrit"
      : sourceMode === "imported"
        ? "Excel İçe Aktarım"
        : "Canlı Banka & Likidite Tahmini (TMS 7)";

  const lockedCount = months.filter((m) => m.status === "locked").length;
  const negativeMonthCount = months.filter(
    (month) => month.closing != null && month.closing < 0,
  ).length;
  const unknownFlowMonthCount = months.filter(
    (m) => m.income == null || m.expense == null,
  ).length;

  /* ── Exact TMS 7 Cash Bridge Waterfall & Activity Donut (strictly TRY via @/lib/money) ── */
  const totalInflowsTry = sumMoney([
    tms7Total.operatingInflow,
    tms7Total.investingInflow,
    tms7Total.financingInflow,
  ]);
  const opOutflowTry = money(tms7Total.operatingOutflow);
  const invOutflowTry = money(tms7Total.investingOutflow);
  const finOutflowTry = money(tms7Total.financingOutflow);
  const netCashflowTry = money(
    decimal(totalInflowsTry)
      .minus(opOutflowTry)
      .minus(invOutflowTry)
      .minus(finOutflowTry),
  );

  const waterfallSteps: WaterfallStep[] = [
    {
      key: "inflows",
      label: "Nakit Girişleri (+)",
      amount: totalInflowsTry,
      formattedAmount: fmtTL(totalInflowsTry),
      tone: "pos",
    },
    {
      key: "op-out",
      label: "İşletme Çıkışları (−)",
      amount: -opOutflowTry,
      formattedAmount: opOutflowTry > 0 ? `−${fmtTL(opOutflowTry)}` : fmtTL(0),
      tone: "neg",
    },
    {
      key: "inv-out",
      label: "Yatırım CAPEX (−)",
      amount: -invOutflowTry,
      formattedAmount: invOutflowTry > 0 ? `−${fmtTL(invOutflowTry)}` : fmtTL(0),
      tone: "warn",
    },
    {
      key: "fin-out",
      label: "Finansman/Kredi (−)",
      amount: -finOutflowTry,
      formattedAmount: finOutflowTry > 0 ? `−${fmtTL(finOutflowTry)}` : fmtTL(0),
      tone: "accent",
    },
    {
      key: "net-cf",
      label: "Net Nakit Akışı (=)",
      amount: netCashflowTry,
      formattedAmount: fmtTL(netCashflowTry),
      isTotal: true,
      tone: netCashflowTry < 0 ? "neg" : "info",
    },
  ];

  const tms7DonutSlices: DonutSlice[] = [
    {
      key: "inflow",
      label: "Nakit Girişleri",
      value: totalInflowsTry,
      formattedValue: fmtTL(totalInflowsTry),
      sublabel: "Tahsilat & finansman girişi",
      tone: "pos",
    },
    {
      key: "op-outflow",
      label: "İşletme Çıkışı",
      value: opOutflowTry,
      formattedValue: fmtTL(opOutflowTry),
      sublabel: "Tedarikçi, bordro & vergi",
      tone: "neg",
    },
    {
      key: "fin-outflow",
      label: "Finansman Çıkışı",
      value: finOutflowTry,
      formattedValue: fmtTL(finOutflowTry),
      sublabel:
        invOutflowTry > 0
          ? `Kredi itfa · CAPEX ${fmtTL(invOutflowTry)}`
          : "Kredi anapara & faiz",
      tone: "accent",
    },
    ...(invOutflowTry > 0
      ? [
          {
            key: "inv-outflow",
            label: "Yatırım CAPEX",
            value: invOutflowTry,
            formattedValue: fmtTL(invOutflowTry),
            sublabel: "Makine & sabit kıymet",
            tone: "warn" as const,
          },
        ]
      : []),
  ];
  const grossActivityTry = sumMoney(tms7DonutSlices.map((s) => s.value));

  // Window of representative months around today for the monthly summary table
  const currentYm = today.slice(0, 7);
  const currentIdx = months.findIndex((m) => m.ym >= currentYm);
  const windowStart = Math.max(0, (currentIdx >= 0 ? currentIdx : 0) - 2);
  const summaryMonths = months.slice(windowStart, windowStart + 12);

  return (
    <div className="space-y-3.5">
      <PageHeader
        title="Nakit akışı özeti"
        subtitle={`${months.length} aylık karar görünümü · ${modeLabel}`}
        meta={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone="blue">{modeLabel}</Badge>
            {lockedCount > 0 && <Badge tone="green">{lockedCount} dönem kilitli</Badge>}
            {projection.firstNegativeMonth ? (
              <Badge tone="red">ilk negatif {ym(projection.firstNegativeMonth)}</Badge>
            ) : (
              <Badge tone="green" dot>
                negatif ay yok
              </Badge>
            )}
          </span>
        }
        action={
          <span className="flex flex-wrap items-center gap-1.5">
            <Link href="/cashflow/13-week" className="button-ghost px-2.5 py-1.5 text-xs">
              13 Haftalık Likidite
            </Link>
            <Link href="/scenarios" className="button-accent px-3 py-1.5 text-xs">
              Senaryoda dene
            </Link>
          </span>
        }
      />
      <ActionFeedback error={sp.error} success={sp.notice} />

      {/* Row 1: Compact 4-Card KPI Strip */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <KpiCard
          label="Runway"
          value={
            projection.firstNegativeMonth
              ? ym(projection.firstNegativeMonth)
              : "Ufuk boyunca pozitif"
          }
          tone={projection.firstNegativeMonth ? "neg" : "pos"}
          href="/cashflow/13-week"
        />
        <KpiCard
          label="En kötü ay"
          value={ym(projection.worstMonth)}
          tone="neg"
          note={fmtTL(projection.worstBalance)}
          href="/cashflow/monthly"
        />
        <KpiCard
          label="Negatif ay"
          value={negativeMonthCount}
          tone={negativeMonthCount > 0 ? "warn" : "pos"}
          note={`${months.length} dönem içinde`}
        />
        <KpiCard
          label="Ardışık negatif"
          value={projection.longestNegativeRun.length}
          tone={projection.longestNegativeRun.length > 0 ? "neg" : "neutral"}
          note={
            projection.longestNegativeRun.from
              ? `Başlangıç: ${ym(projection.longestNegativeRun.from)}`
              : "Kesintisiz negatif seri yok"
          }
        />
      </div>

      {/* Row 2: FIRST-SCREEN VISUAL COCKPIT (Interactive Projection + TMS 7 Waterfall & Donut Side-by-Side) */}
      <section
        aria-label="Nakit projeksiyon eğrisi ve TMS 7 nakit köprüsü şelalesi"
        className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-12"
      >
        {/* Left (7 cols): Interactive 35-Month Cashflow Curve Right Above the Fold */}
        <div className="min-w-0 xl:col-span-7">
          <AnalyticsChart
            key={period}
            model={cashTrendModel(months, today)}
            defaultPeriod={period}
            height={300}
          />
        </div>

        {/* Right (5 cols): Real TMS 7 Cashflow Waterfall + Activity Donut */}
        <div className="min-w-0 xl:col-span-5">
          <Panel
            title="TMS 7 Nakit Köprüsü Şelalesi &amp; Faaliyet Dağılımı"
            subtitle="Nakit girişlerinden işletme, yatırım ve finansman çıkışlarına geçiş (TRY)"
            right={
              <Link href="/cashflow/monthly" className="button-ghost px-2 py-1 text-[11px]">
                Aylık Tablo →
              </Link>
            }
          >
            <div className="space-y-3">
              <CashflowWaterfallSvg
                steps={waterfallSteps}
                ariaLabel="TMS 7 nakit girişleri, işletme, yatırım ve finansman çıkışları şelale grafiği"
                height={186}
              />

              <div className="border-t border-line-faint pt-2.5">
                <EditorialDonutChartSvg
                  slices={tms7DonutSlices}
                  centerLabel="NET AKIŞ"
                  centerValue={fmtTL(netCashflowTry)}
                  centerSubtext={
                    grossActivityTry > 0 ? "TMS 7 Doğrudan" : "Hareket bekleniyor"
                  }
                  ariaLabel="Nakit girişleri, işletme çıkışı ve finansman çıkışı oransal karşılaştırması"
                  size={138}
                />
              </div>

              {unknownFlowMonthCount > 0 && (
                <div className="tnum rounded-[var(--radius-control)] border border-line-faint bg-surface-2 px-2.5 py-1.5 text-[11px] text-warn">
                  {unknownFlowMonthCount} belirsiz ay toplam dışı tutuldu — eksik veri asla 0 TL sayılmaz.
                </div>
              )}
            </div>
          </Panel>
        </div>
      </section>

      {/* Row 3: TMS 7 Detail Cards, Horizon Selector & Monthly Summary Table */}
      <Panel
        title="TMS 7 DOĞRUDAN YÖNTEM NAKİT AKIŞ ÖZETİ (TRY)"
        subtitle="Banka hareketleri ve açık vadeli tahsilat/ödemelerin faaliyet sınıfına göre dağılımı (iç transferler hariç)"
      >
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <div className="rounded-[var(--radius-md)] border border-line-faint bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.055em] text-tone-3">
                İşletme Faaliyetleri (Operating)
              </div>
              <BulletBarSvg
                actual={tms7Total.operatingInflow}
                target={tms7Total.operatingOutflow}
                width={78}
                label="İşletme nakit girişi vs çıkışı"
                status={tms7Total.operatingNet < 0 ? "neg" : "pos"}
              />
            </div>
            <div
              className={`mt-1.5 text-base font-bold tabular-nums ${
                tms7Total.operatingNet < 0 ? "text-neg" : "text-pos"
              }`}
            >
              {fmtTL(tms7Total.operatingNet)}
            </div>
            <div className="mt-1 text-[11.5px] tabular-nums text-tone-3">
              Giriş {fmtTL(tms7Total.operatingInflow)} · Çıkış {fmtTL(tms7Total.operatingOutflow)}
            </div>
          </div>

          <div className="rounded-[var(--radius-md)] border border-line-faint bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.055em] text-tone-3">
                Yatırım Faaliyetleri (Investing / CAPEX)
              </div>
              <BulletBarSvg
                actual={tms7Total.investingInflow}
                target={tms7Total.investingOutflow}
                width={78}
                label="Yatırım nakit girişi vs çıkışı"
                status={tms7Total.investingNet < 0 ? "warn" : "pos"}
              />
            </div>
            <div
              className={`mt-1.5 text-base font-bold tabular-nums ${
                tms7Total.investingNet < 0 ? "text-neg" : "text-tone-1"
              }`}
            >
              {fmtTL(tms7Total.investingNet)}
            </div>
            <div className="mt-1 text-[11.5px] tabular-nums text-tone-3">
              Giriş {fmtTL(tms7Total.investingInflow)} · Çıkış {fmtTL(tms7Total.investingOutflow)}
            </div>
          </div>

          <div className="rounded-[var(--radius-md)] border border-line-faint bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.055em] text-tone-3">
                Finansman Faaliyetleri (Financing)
              </div>
              <BulletBarSvg
                actual={tms7Total.financingInflow}
                target={tms7Total.financingOutflow}
                width={78}
                label="Finansman nakit girişi vs çıkışı"
                status={tms7Total.financingNet < 0 ? "warn" : "info"}
              />
            </div>
            <div
              className={`mt-1.5 text-base font-bold tabular-nums ${
                tms7Total.financingNet < 0 ? "text-neg" : "text-tone-1"
              }`}
            >
              {fmtTL(tms7Total.financingNet)}
            </div>
            <div className="mt-1 text-[11.5px] tabular-nums text-tone-3">
              Giriş {fmtTL(tms7Total.financingInflow)} · Çıkış {fmtTL(tms7Total.financingOutflow)}
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="DÖNEM UFUKLARI" subtitle="Grafik penceresini doğrudan hedef ufka odaklayın">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          {cards.map((card) => {
            const cardPeriod = PERIOD_BY_HORIZON[card.horizonMonths];
            const active = cardPeriod != null && cardPeriod === period;
            const tile = (
              <KpiCard
                label={`${card.horizonMonths} ay`}
                value={fmtTL(card.endClosing)}
                tone={card.endClosing != null && card.endClosing < 0 ? "neg" : "neutral"}
                note={active ? "Grafikte gösteriliyor" : "Grafikte göster"}
              />
            );
            return cardPeriod == null ? (
              <div key={card.horizonMonths}>{tile}</div>
            ) : (
              <Link
                key={card.horizonMonths}
                href={`/cashflow?chartPeriod=${cardPeriod}`}
                scroll={false}
                aria-current={active ? "true" : undefined}
                className="block"
                style={
                  active
                    ? {
                        borderRadius: "var(--radius)",
                        outline: "2px solid var(--accent)",
                        outlineOffset: "1px",
                      }
                    : undefined
                }
              >
                {tile}
              </Link>
            );
          })}
        </div>
      </Panel>

      {summaryMonths.length > 0 && (
        <Panel
          title="AYLIK NAKİT ÖZETİ TABLOSU"
          subtitle="Açılış, nakit girişi, nakit çıkışı, dönem neti ve kapanış bakiyeleri (R10 dürüstlük kuralı: belirsiz hücreler TUTAR EKSİK olarak gösterilir)"
          right={
            <Link href="/cashflow/monthly" className="button-ghost px-2.5 py-1 text-xs">
              Tüm {months.length} Dönem →
            </Link>
          }
        >
          <TableShell>
            <table className="w-full min-w-[680px] text-xs">
              <thead>
                <tr className="text-left text-[11px] uppercase text-tone-3">
                  <th className="py-1.5">Dönem</th>
                  <th>Durum</th>
                  <th className="text-right">Açılış</th>
                  <th className="text-right">Giriş (+)</th>
                  <th className="text-right">Çıkış (−)</th>
                  <th className="text-right">Net Değişim</th>
                  <th className="text-right">Kapanış</th>
                </tr>
              </thead>
              <tbody>
                {summaryMonths.map((m) => {
                  const netMonth =
                    m.income != null && m.expense != null
                      ? money(sub(m.income, m.expense))
                      : null;
                  const isCurrent = m.ym === currentYm;
                  return (
                    <tr
                      key={m.id}
                      className="border-t border-line-faint"
                      style={
                        isCurrent
                          ? {
                              background:
                                "color-mix(in srgb, var(--accent) 5%, var(--surface-1))",
                            }
                          : undefined
                      }
                    >
                      <td className="py-2 font-mono font-semibold tabular-nums">
                        <Link
                          href={`/cashflow/${encodeURIComponent(m.id)}`}
                          className="underline underline-offset-2"
                        >
                          {m.ym}
                        </Link>
                        {isCurrent && (
                          <span className="ml-1.5 font-sans text-[10px] font-semibold text-accent-tone">
                            Cari
                          </span>
                        )}
                      </td>
                      <td>
                        <Badge tone={m.status === "locked" ? "green" : "neutral"}>
                          {m.status === "locked" ? "Kilitli" : "Açık"}
                        </Badge>
                      </td>
                      <td className="text-right tabular-nums text-tone-2">
                        {fmtTL(m.opening)}
                      </td>
                      <td className="text-right tabular-nums text-pos">
                        {fmtTL(m.income)}
                      </td>
                      <td className="text-right tabular-nums text-neg">
                        {fmtTL(m.expense)}
                      </td>
                      <td
                        className={`text-right font-semibold tabular-nums ${
                          netMonth == null
                            ? "text-warn"
                            : netMonth < 0
                              ? "text-neg"
                              : "text-pos"
                        }`}
                      >
                        {fmtTL(netMonth)}
                      </td>
                      <td
                        className={`text-right font-bold tabular-nums ${
                          m.closing == null
                            ? "text-warn"
                            : m.closing < 0
                              ? "text-neg"
                              : "text-tone-1"
                        }`}
                      >
                        {fmtTL(m.closing)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      )}
    </div>
  );
}
