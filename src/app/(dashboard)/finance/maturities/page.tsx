import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { EmptyState, PageHeader, TableShell } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { loadMaturityItems } from "@/lib/financing/engine";
import { groupMaturities } from "@/lib/financing/rules";
import { intOrNull, moneyOrNull } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";

export const dynamic = "force-dynamic";

export default async function MaturitiesPage() {
  const denied = await requireRouteAccess("/finance/maturities");
  if (denied) return denied;

  const pool = getPool();
  const [items, ladderRes] = await Promise.all([
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

  return (
    <>
      <PageHeader
        title="Vade Takvimi"
        subtitle="Döviz bazlı borç vade merdiveni ile çek ve kredi taksitlerinin birleşik haftalık görünümü"
      />

      <Panel
        title="Döviz Bazlı Borç Vade Merdiveni"
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

      {groups.map((g) => (
        <Panel
          key={g.key}
          title={`${g.key} · ${g.from} — ${g.to}`}
          right={<span className="text-xs">{g.count} vade</span>}
        >
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <span>
              Ödenecek
              <br />
              <b className="text-neg">{fmtTL(g.knownOutflow)}</b>
            </span>
            <span>
              Tahsil
              <br />
              <b className="text-pos">{fmtTL(g.knownInflow)}</b>
            </span>
            <span>
              Eksik tutar
              <br />
              <b>{g.missingCount}</b>
            </span>
            <span>
              Yönü belirsiz
              <br />
              <b>{g.unknownDirectionCount}</b>
            </span>
          </div>
        </Panel>
      ))}
    </>
  );
}
