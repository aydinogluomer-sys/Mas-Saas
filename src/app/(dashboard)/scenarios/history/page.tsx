import Link from "@/components/ui/app-link";
import { archiveRecordAction } from "@/app/(dashboard)/system/archive/actions";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, PageHeader, TableShell } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { listScenarioRuns } from "@/lib/scenarios/engine";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const denied = await requireRouteAccess("/scenarios/history");
  if (denied) return denied;

  const rows = await listScenarioRuns(getPool());

  return (
    <>
      <PageHeader
        title="Senaryo Çalıştırma Geçmişi"
        subtitle="Kaydedilmiş tüm 13H birleşik dinamik stres testleri ve aylık senaryo simülasyonları"
        meta={
          <div className="flex items-center gap-2">
            <Link href="/scenarios/compare" className="button-ghost px-2.5 py-1 text-xs">
              Matriste Kıyasla →
            </Link>
            <Link href="/scenarios" className="button-accent px-2.5 py-1 text-xs">
              + Yeni Senaryo
            </Link>
          </div>
        }
      />

      <Panel title={`KAYITLI ÇALIŞMALAR (${rows.length})`}>
        {rows.length === 0 ? (
          <EmptyState>Henüz kaydedilmiş senaryo çalışması yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left uppercase" style={{ borderColor: "var(--line)", color: "var(--text-3)" }}>
                  <th className="py-2 pr-2">Senaryo Adı</th>
                  <th className="py-2 px-2">Motor</th>
                  <th className="py-2 px-2">Tarih</th>
                  <th className="py-2 px-2 text-right">Final Fark (Δ)</th>
                  <th className="py-2 px-2 text-right">Oto. BCH Çekimi</th>
                  <th className="py-2 px-2 text-right">Min DSCR</th>
                  <th className="py-2 px-2">Kovenant</th>
                  <th className="py-2 pl-2 text-right">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const compareHref =
                    idx === 0 && rows[1]
                      ? `/scenarios/compare?a=${r.id}&b=${rows[1].id}`
                      : rows[0] && rows[0].id !== r.id
                        ? `/scenarios/compare?a=${rows[0].id}&b=${r.id}`
                        : `/scenarios/compare?a=${r.id}`;
                  return (
                    <tr
                      key={r.id}
                      className="border-b"
                      style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                    >
                      <td className="py-2 pr-2 font-medium">
                        <Link href={`/scenarios/${r.id}`} className="underline" style={{ color: "var(--accent)" }}>
                          {r.name}
                        </Link>
                      </td>
                      <td className="py-2 px-2">
                        <Badge tone={r.is_unified_13w ? "blue" : "neutral"}>
                          {r.is_unified_13w ? "13H Birleşik" : "Aylık"}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 font-mono tabular-nums" style={{ color: "var(--text-3)" }}>
                        {r.run_at}
                      </td>
                      <td
                        className={`py-2 px-2 text-right font-mono tabular-nums ${
                          (r.final_delta ?? 0) < 0 ? "text-neg" : "text-pos"
                        }`}
                      >
                        {fmtTL(r.final_delta)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {r.total_auto_facility_draw != null ? fmtTL(r.total_auto_facility_draw) : "—"}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        {r.projected_min_dscr != null ? `${r.projected_min_dscr.toFixed(2)}x` : "—"}
                      </td>
                      <td className="py-2 px-2">
                        {r.covenant_breach_count > 0 ? (
                          <Badge tone="red">{r.covenant_breach_count} ihlal</Badge>
                        ) : (
                          <Badge tone="green">Korunuyor</Badge>
                        )}
                      </td>
                      <td className="py-2 pl-2 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <Link href={compareHref} className="button-ghost px-2 py-1 text-[11px]">
                            Kıyasla
                          </Link>
                          <form action={archiveRecordAction}>
                            <input type="hidden" name="entity" value="scenario_runs" />
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="backTo" value="/scenarios/history" />
                            <input type="hidden" name="reason" value="Senaryo geçmişinden arşivlendi" />
                            <button className="button-ghost px-2 py-1 text-[11px]">Arşivle</button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>
    </>
  );
}
