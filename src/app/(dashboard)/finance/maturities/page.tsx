import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, PageHeader, TableShell } from "@/components/ui/shell";
import type { ChartModel } from "@/lib/analytics/chart";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { loadMaturityItems } from "@/lib/financing/engine";
import { loadLatestTryFxRateMap, convertSingleAmountToTry } from "@/lib/financing/fx-consolidation";
import { groupMaturities } from "@/lib/financing/rules";
import { decimal, intOrNull, moneyOrNull } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

export default async function MaturitiesPage() {
  const denied = await requireRouteAccess("/finance/maturities");
  if (denied) return denied;

  const pool = getPool();
  const today = istanbulDateISO();
  const [items, ladderRes, rateMap] = await Promise.all([
    loadMaturityItems(pool),
    pool.query<{
      currency: string;
      sort_order: number;
      bucket_label: string;
      bucket_days: number;
      installment_due: string;
      installment_count: string;
      facility_drawn_expiring: string;
      facility_limit_expiring: string;
      facility_count: string;
      total_cash_exposure: string;
    }>(
      `select currency,
              sort_order,
              bucket_label,
              bucket_days,
              installment_due::text,
              installment_count::text,
              facility_drawn_expiring::text,
              facility_limit_expiring::text,
              facility_count::text,
              total_cash_exposure::text
         from public.debt_maturity_ladder_by_currency
        order by currency, sort_order`,
    ),
    loadLatestTryFxRateMap(pool, today),
  ]);

  const groups = groupMaturities(items, "week");
  const ladderRows = ladderRes.rows.map((r) => ({
    currency: r.currency || "TRY",
    sortOrder: intOrNull(r.sort_order) ?? 0,
    bucketLabel: r.bucket_label,
    bucketDays: intOrNull(r.bucket_days) ?? 0,
    installmentDue: moneyOrNull(r.installment_due) ?? 0,
    installmentCount: intOrNull(r.installment_count) ?? 0,
    facilityDrawnExpiring: moneyOrNull(r.facility_drawn_expiring) ?? 0,
    facilityLimitExpiring: moneyOrNull(r.facility_limit_expiring) ?? 0,
    facilityCount: intOrNull(r.facility_count) ?? 0,
    totalCashExposure: moneyOrNull(r.total_cash_exposure) ?? 0,
  }));

  const uniqueBuckets = [...new Map(ladderRows.map((r) => [r.bucketLabel, r.sortOrder])).entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([label]) => label);
  const ladderCurrencies = [...new Set(ladderRows.map((r) => r.currency))];

  const ladderChart: ChartModel = {
    title: "Borç Vade Merdiveni (Konsolide TRY Karşılığı)",
    description:
      "Kredi taksitleri ve vadesi dolan kredi limit kullanımlarının vade dilimlerine göre dağılımı (dövizler TCMB son kur ile çevrilir).",
    asOf: today,
    timeDirection: "forward",
    preferredView: "stacked",
    summaryMode: "sum",
    minimumVisibleSeries: ladderCurrencies.length > 0 ? ladderCurrencies : ["TRY"],
    sourceLabel: "Borç vade merdiveni",
    sourceHref: "/finance/maturities",
    unknownCount: 0,
    annotations: [],
    series: (ladderCurrencies.length > 0 ? ladderCurrencies : ["TRY"]).map((ccy, idx) => ({
      id: ccy,
      label: `${ccy} Nakit Maruziyeti (TL Karşılığı)`,
      tone: idx === 0 ? "negative" : idx === 1 ? "warning" : "info",
      format: "currency",
      points: uniqueBuckets.map((bucket) => {
        const match = ladderRows.find((r) => r.currency === ccy && r.bucketLabel === bucket);
        const tryVal = match
          ? convertSingleAmountToTry(match.totalCashExposure, ccy, rateMap).tryEquivalent ?? 0
          : 0;
        return {
          key: bucket,
          label: bucket,
          value: tryVal,
        };
      }),
    })),
  };

  return (
    <>
      <PageHeader
        title="Vade Takvimi & Borç Vade Merdiveni"
        subtitle="Döviz bazlı borç vade merdiveni grafiği ile çek/senet ve kredi taksitlerinin para birimi ayrıştırılmış haftalık görünümü"
      />

      {ladderRows.length > 0 ? <AnalyticsChart model={ladderChart} kind="bar" defaultPeriod="all" /> : null}

      <Panel
        title="Döviz Bazlı Borç Vade Merdiveni Tablosu"
        subtitle="Kredi taksitleri ve vadesi dolan rotatif/spot kredi limit kullanımları para birimleri birbirine karıştırılmadan vade dilimlerinde izlenir"
      >
        {ladderRows.length === 0 ? (
          <EmptyState>Aktif kredi taksiti veya vadesi yaklaşan kredi limiti bulunmuyor.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1.5">Döviz</th>
                  <th>Vade Dilimi</th>
                  <th className="text-right">Kredi Taksitleri</th>
                  <th className="text-right">Taksit Adedi</th>
                  <th className="text-right">Vadesi Dolan Limit Kullanımı</th>
                  <th className="text-right">Vadesi Dolan Toplam Limit</th>
                  <th className="text-right">Toplam Nakit Maruziyeti</th>
                </tr>
              </thead>
              <tbody>
                {ladderRows.map((row) => (
                  <tr
                    key={`${row.currency}-${row.sortOrder}-${row.bucketLabel}`}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-1.5 font-mono font-semibold">
                      <Badge tone="neutral">{row.currency}</Badge>
                    </td>
                    <td>{row.bucketLabel}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatMoney(row.installmentDue, row.currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-2)" }}>
                      {row.installmentCount}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {formatMoney(row.facilityDrawnExpiring, row.currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-2)" }}>
                      {formatMoney(row.facilityLimitExpiring, row.currency)}
                      {row.facilityCount > 0 ? ` (${row.facilityCount})` : ""}
                    </td>
                    <td className="text-right font-mono font-semibold tabular-nums text-neg">
                      {formatMoney(row.totalCashExposure, row.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      {groups.map((g) => {
        const outByCcy = new Map<string, ReturnType<typeof decimal>>();
        const inByCcy = new Map<string, ReturnType<typeof decimal>>();
        for (const it of g.items) {
          if (it.amount == null) continue;
          const ccy = (it.currency ?? "TRY").toUpperCase();
          if (it.direction === "outflow") {
            outByCcy.set(ccy, (outByCcy.get(ccy) ?? decimal(0)).plus(it.amount));
          } else if (it.direction === "inflow") {
            inByCcy.set(ccy, (inByCcy.get(ccy) ?? decimal(0)).plus(it.amount));
          }
        }
        const outText =
          outByCcy.size > 0
            ? [...outByCcy.entries()]
                .map(([ccy, d]) => formatMoney(Number(d.round(2).toFixed(2)), ccy))
                .join(" · ")
            : "—";
        const inText =
          inByCcy.size > 0
            ? [...inByCcy.entries()]
                .map(([ccy, d]) => formatMoney(Number(d.round(2).toFixed(2)), ccy))
                .join(" · ")
            : "—";

        return (
          <Panel
            key={g.key}
            title={`${g.key} · ${g.from} — ${g.to}`}
            right={<span className="font-mono text-xs">{g.count} vade</span>}
          >
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <span>
                Ödenecek (Orijinal Döviz)
                <br />
                <b className="font-mono text-neg">{outText}</b>
              </span>
              <span>
                Tahsil (Orijinal Döviz)
                <br />
                <b className="font-mono text-pos">{inText}</b>
              </span>
              <span>
                Eksik tutar
                <br />
                <b className="font-mono">{g.missingCount}</b>
              </span>
              <span>
                Yönü belirsiz
                <br />
                <b className="font-mono">{g.unknownDirectionCount}</b>
              </span>
            </div>
          </Panel>
        );
      })}
    </>
  );
}
