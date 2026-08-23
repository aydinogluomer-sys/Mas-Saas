import { getPool } from "@/lib/db";
import {
  FACILITY_STATUS_LABEL, FACILITY_TYPE_LABEL,
  type FacilityStatus, type FacilityType,
} from "@/lib/financing/facilities";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<FacilityStatus, Tone> = {
  active: "green", suspended: "amber", expired: "red", closed: "neutral",
};

export default async function FacilitiesPage() {
  // Faz 17-38 denetimi — sayfa seviyesi rol kapisi. Navigasyonun kullandigi AYNI karar
  // (canSeeRoute); ikinci bir liste, ikinci bir fikir ve kacinilmaz bir kayma demekti.
  const denied = await requireRouteAccess("/finance/facilities");
  if (denied) return denied;
  const pool = getPool();
  const [facilities, ladder, collateral, covenants] = await Promise.all([
    pool.query(
      `select facility_id, facility_name, facility_type, currency, status, lender_name,
              limit_amount, drawn_amount, available_amount, utilization_ratio, over_limit,
              to_char(expiry_date,'YYYY-MM-DD') as expiry_date, days_to_expiry
       from public.credit_facility_utilization
       order by status, expiry_date nulls last, facility_name`),
    pool.query(
      `select bucket_label, installment_due, installment_count, facility_drawn_expiring,
              facility_limit_expiring, facility_count, total_cash_exposure
       from public.debt_maturity_ladder order by sort_order`),
    pool.query(
      `select c.id, c.collateral_type, c.description, c.value_amount, c.currency,
              to_char(c.valuation_date,'YYYY-MM-DD') as valuation_date, c.valuation_source,
              coalesce(l.name, f.name) as subject_name, c.released_at
       from public.collateral_records c
       left join public.loans l on l.id = c.loan_id
       left join public.credit_facilities f on f.id = c.facility_id
       order by c.created_at desc limit 50`),
    pool.query(
      `select v.id, v.covenant_type, v.description, v.comparison, v.threshold_value, v.status,
              to_char(v.last_test_date,'YYYY-MM-DD') as last_test_date,
              v.last_test_value, v.last_test_result,
              coalesce(l.name, f.name) as subject_name
       from public.covenant_records v
       left join public.loans l on l.id = v.loan_id
       left join public.credit_facilities f on f.id = v.facility_id
       order by v.status, v.covenant_type limit 50`),
  ]);

  const active = facilities.rows.filter((f) => f.status === "active");
  const totalLimit = active.reduce((s, f) => s + Number(f.limit_amount ?? 0), 0);
  const totalDrawn = active.reduce((s, f) => s + Number(f.drawn_amount ?? 0), 0);
  const totalAvailable = active.reduce((s, f) => s + Number(f.available_amount ?? 0), 0);
  const breached = covenants.rows.filter((c) => c.last_test_result === "breached");
  const expiringSoon = facilities.rows.filter(
    (f) => f.days_to_expiry != null && Number(f.days_to_expiry) >= 0 && Number(f.days_to_expiry) <= 90
      && f.status === "active");

  return (
    <>
      <PageHeader
        title="Kredi Limitleri"
        subtitle="Rotatif limitler, çekimler, teminatlar ve kovenantlar"
        meta={<Badge tone={breached.length > 0 ? "red" : "green"} dot>
          {breached.length > 0 ? `${breached.length} kovenant ihlali` : "kovenant ihlali yok"}
        </Badge>}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Toplam limit (aktif)" value={fmtTL(totalLimit)} tone="info" />
        <KeyStat label="Kullanılan" value={fmtTL(totalDrawn)} tone={totalDrawn > 0 ? "warn" : "neutral"} />
        {/* Available liquidity that exists without being borrowed — the number a facility
            register exists to surface. */}
        <KeyStat label="Kullanılabilir" value={fmtTL(totalAvailable)} tone="pos" />
        <KeyStat label="90 günde vadesi dolan" value={expiringSoon.length}
          tone={expiringSoon.length > 0 ? "warn" : "pos"} />
      </div>

      <Panel title="LİMİTLER" subtitle="limit / kullanılan / kullanılabilir">
        {facilities.rows.length === 0 ? (
          <EmptyState>Kayıtlı kredi limiti yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Limit adı</th><th>Tür</th><th>Banka</th>
                  <th className="text-right">Limit</th><th className="text-right">Kullanılan</th>
                  <th className="text-right">Kullanılabilir</th><th className="text-right">Doluluk</th>
                  <th>Vade</th><th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {facilities.rows.map((f) => (
                  <tr key={f.facility_id} className="border-t border-neutral-800">
                    <td className="py-2">{f.facility_name}</td>
                    <td className="text-xs">{FACILITY_TYPE_LABEL[f.facility_type as FacilityType] ?? f.facility_type}</td>
                    <td className="text-xs text-neutral-400">{f.lender_name ?? "—"}</td>
                    <td className="text-right tabular-nums">{fmtTL(Number(f.limit_amount))}</td>
                    <td className="text-right tabular-nums">{fmtTL(Number(f.drawn_amount))}</td>
                    <td className="text-right tabular-nums">{fmtTL(Number(f.available_amount))}</td>
                    <td className="text-right tabular-nums">
                      {f.utilization_ratio == null
                        ? "—"
                        : `%${(Number(f.utilization_ratio) * 100).toFixed(1)}`}
                      {/* Over-limit is reported separately rather than as negative headroom. */}
                      {f.over_limit ? <span className="ml-1 text-red-400">aşım</span> : null}
                    </td>
                    <td className="text-xs tabular-nums">
                      {f.expiry_date ?? "—"}
                      {f.days_to_expiry != null && Number(f.days_to_expiry) >= 0 && Number(f.days_to_expiry) <= 90
                        ? <span className="block text-amber-400">{f.days_to_expiry} gün</span> : null}
                    </td>
                    <td><Badge tone={STATUS_TONE[f.status as FacilityStatus] ?? "neutral"}>
                      {FACILITY_STATUS_LABEL[f.status as FacilityStatus] ?? f.status}
                    </Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="BORÇ VADE MERDİVENİ" subtitle="30 / 90 / 180 / 365 gün">
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-1">Vade aralığı</th>
                <th className="text-right">Taksit</th>
                <th className="text-right">Vadesi dolan limit (çekilen)</th>
                <th className="text-right">Vadesi dolan limit (toplam)</th>
                <th className="text-right">Nakit maruziyeti</th>
              </tr>
            </thead>
            <tbody>
              {ladder.rows.map((b) => (
                <tr key={b.bucket_label} className="border-t border-neutral-800">
                  <td className="py-2">{b.bucket_label}
                    <span className="block text-xs text-neutral-600">
                      {b.installment_count} taksit · {b.facility_count} limit
                    </span>
                  </td>
                  <td className="text-right tabular-nums">{fmtTL(Number(b.installment_due))}</td>
                  <td className="text-right tabular-nums">{fmtTL(Number(b.facility_drawn_expiring))}</td>
                  {/* Shown for context but NOT counted as an outflow: an unused limit that
                      expires costs nothing, it just stops being available. */}
                  <td className="text-right tabular-nums text-neutral-500">
                    {fmtTL(Number(b.facility_limit_expiring))}
                  </td>
                  <td className="text-right tabular-nums font-medium">{fmtTL(Number(b.total_cash_exposure))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </Panel>

      <Panel title="TEMİNATLAR">
        {collateral.rows.length === 0 ? (
          <EmptyState>Kayıtlı teminat yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Tür</th><th>Konu</th><th className="text-right">Değer</th>
                  <th>Değerleme</th><th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {collateral.rows.map((c) => (
                  <tr key={c.id} className="border-t border-neutral-800">
                    <td className="py-2">{c.collateral_type}
                      {c.description ? <span className="block text-xs text-neutral-600">{c.description}</span> : null}
                    </td>
                    <td className="text-xs">{c.subject_name ?? "—"}</td>
                    <td className="text-right tabular-nums">
                      {/* Unvalued is not worthless — never rendered as 0,00. */}
                      {c.value_amount == null
                        ? <span className="text-amber-400">değerlenmedi</span>
                        : fmtTL(Number(c.value_amount))}
                    </td>
                    <td className="text-xs text-neutral-400">
                      {c.valuation_date ?? "—"}
                      {c.valuation_source ? ` · ${c.valuation_source}` : ""}
                    </td>
                    <td><Badge tone={c.released_at ? "neutral" : "green"}>
                      {c.released_at ? "serbest" : "bağlı"}
                    </Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="KOVENANTLAR" subtitle="madde ve son ölçüm — ölçüm sonucu yaşam döngüsü değildir">
        {covenants.rows.length === 0 ? (
          <EmptyState>Kayıtlı kovenant yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Kovenant</th><th>Konu</th><th className="text-right">Eşik</th>
                  <th className="text-right">Son ölçüm</th><th>Sonuç</th><th>Madde durumu</th>
                </tr>
              </thead>
              <tbody>
                {covenants.rows.map((v) => (
                  <tr key={v.id} className="border-t border-neutral-800">
                    <td className="py-2">{v.description}
                      <span className="block text-xs text-neutral-600">{v.covenant_type}</span>
                    </td>
                    <td className="text-xs">{v.subject_name ?? "—"}</td>
                    <td className="text-right tabular-nums text-xs">
                      {v.comparison} {Number(v.threshold_value)}
                    </td>
                    <td className="text-right tabular-nums text-xs">
                      {v.last_test_value == null ? "—" : Number(v.last_test_value)}
                      {v.last_test_date ? <span className="block text-neutral-600">{v.last_test_date}</span> : null}
                    </td>
                    <td>
                      {v.last_test_result == null
                        ? <span className="text-xs text-neutral-600">ölçülmedi</span>
                        : <Badge tone={v.last_test_result === "breached" ? "red"
                            : v.last_test_result === "compliant" ? "green" : "neutral"}>
                            {v.last_test_result}
                          </Badge>}
                    </td>
                    <td><Badge tone={v.status === "active" ? "green" : "neutral"}>{v.status}</Badge></td>
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
