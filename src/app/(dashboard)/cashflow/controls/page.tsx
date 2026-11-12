import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { loadBudgetVarianceSummary } from "@/lib/budget/engine";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { getPool } from "@/lib/db";
import { formatMoney } from "@/lib/money-format";
import { findContinuityIssues } from "@/lib/radar/rules";

export const dynamic = "force-dynamic";

export default async function CashflowControls(props: {
  searchParams?: Promise<{ error?: string; result?: string }>;
}) {
  const denied = await requireRouteAccess("/cashflow/controls");
  if (denied) return denied;
  const sp = (await props?.searchParams) ?? {};
  const session = await import("@/lib/auth").then((m) => m.getRequestUser()).catch(() => null);
  const canTask = session ? can(session.role, "action_items", "insert") : false;
  const createReconciliationTaskAction = canTask
    ? (await import("@/app/(dashboard)/data/reconciliation/actions")).createReconciliationTaskAction
    : null;

  const pool = getPool();
  const months = await loadCashMonths(pool);
  const rawIssues = findContinuityIssues(months);
  const c = { breaks: rawIssues.breaks.length, gaps: rawIssues.gaps.length };
  const missing = months.filter((m) => [m.opening, m.income, m.expense, m.closing].some((v) => v == null));
  const reviews = await pool.query(
    `select id, issue_type, severity, message, status
       from public.mapping_reviews
      where issue_type in ('continuity_break','month_gap')
      order by created_at desc
      limit 50`,
  );
  const budgetVariances = await loadBudgetVarianceSummary(pool);

  return (
    <>
      <PageHeader
        title="Nakit akışı veri kontrolleri"
        subtitle="Devir zinciri, ay boşlukları, bilinmeyen tutarlar ve bütçe sapma kontrolleri; sessiz düzeltme yapılmaz, tek tıkla takip görevi açılır."
        meta={
          <Badge tone={c.breaks + c.gaps ? "red" : "green"} dot>
            {c.breaks + c.gaps} zincir sorunu
          </Badge>
        }
      />

      {sp.error ? (
        <div className="rounded border border-neg/40 bg-neg/10 px-3 py-2 text-xs text-neg">{sp.error}</div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-pos/40 bg-pos/10 px-3 py-2 text-xs text-pos">
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        <KpiCard label="Devir kırığı" value={c.breaks} tone={c.breaks ? "neg" : "pos"} />
        <KpiCard label="Ay boşluğu" value={c.gaps} tone={c.gaps ? "warn" : "pos"} />
        <KpiCard label="Eksik tutarlı ay" value={missing.length} tone={missing.length ? "warn" : "pos"} />
      </div>

      <Panel title="KONTROL KAYITLARI">
        {reviews.rows.length ? (
          reviews.rows.map((r) => (
            <div key={r.id} className="row-hover flex items-center justify-between gap-2 border-b border-line-faint py-2">
              <div>
                <div className="flex gap-2">
                  <Badge tone={r.severity === "critical" || r.severity === "high" ? "red" : "amber"}>
                    {r.severity}
                  </Badge>
                  <Badge tone="neutral">{r.status}</Badge>
                  <span className="font-mono text-xs">{r.issue_type}</span>
                </div>
                <p className="mt-1 text-xs text-tone-3">{r.message}</p>
              </div>
              {canTask && createReconciliationTaskAction ? (
                <form action={createReconciliationTaskAction}>
                  <input type="hidden" name="returnTo" value="/cashflow/controls" />
                  <input type="hidden" name="title" value={`[${r.issue_type}] ${String(r.message ?? "").slice(0, 120)}`} />
                  <input
                    type="hidden"
                    name="severity"
                    value={r.severity === "critical" ? "critical" : r.severity === "high" ? "high" : "medium"}
                  />
                  <input type="hidden" name="relatedEntityTable" value="mapping_reviews" />
                  <input type="hidden" name="relatedEntityId" value={r.id} />
                  <input type="hidden" name="note" value={r.message ?? ""} />
                  <button
                    type="submit"
                    className="rounded border px-2 py-1 font-mono text-[10px]"
                    style={{
                      background: "var(--surface-2)",
                      borderColor: "var(--line)",
                      color: "var(--text-1)",
                    }}
                  >
                    Takip görevi aç
                  </button>
                </form>
              ) : null}
            </div>
          ))
        ) : (
          <p className="text-sm text-tone-3">Açık zincir kontrol kaydı yok.</p>
        )}
      </Panel>

      <Panel
        title={`BÜTÇE SAPMA ÖZETİ (KONTROL GÖRÜNÜMÜ) — ${budgetVariances.length}`}
        subtitle="Onaylı bütçelerin döviz ve yön bazında toplulaştırılmış sapma, aşım kalemi ve ölçülmemiş satır kontrolü"
      >
        {budgetVariances.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-2)" }}>
            Henüz onaylı bütçe sapma özeti kaydı bulunmuyor.
          </p>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1.5">Bütçe</th>
                  <th>Yıl</th>
                  <th>Yön</th>
                  <th>Döviz</th>
                  <th className="text-right">Satır</th>
                  <th className="text-right">Bütçe Toplamı</th>
                  <th className="text-right">Gerçekleşen</th>
                  <th className="text-right">Sapma</th>
                  <th className="text-right">Aşım</th>
                  <th className="text-right">Ölçülmemiş</th>
                </tr>
              </thead>
              <tbody>
                {budgetVariances.map((bv) => (
                  <tr
                    key={`${bv.budgetId}-${bv.direction}-${bv.currency}`}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-1.5 font-medium">{bv.budgetName}</td>
                    <td className="font-mono tabular-nums">{bv.fiscalYear}</td>
                    <td>{bv.direction === "income" ? "Gelir" : "Gider"}</td>
                    <td className="font-mono">{bv.currency}</td>
                    <td className="text-right font-mono tabular-nums">{bv.lineCount}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatMoney(bv.budgetTotal, bv.currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {bv.actualTotal == null ? "—" : formatMoney(bv.actualTotal, bv.currency)}
                    </td>
                    <td
                      className={`text-right font-mono tabular-nums ${
                        bv.varianceTotal != null && bv.varianceTotal < 0 ? "text-neg" : ""
                      }`}
                    >
                      {bv.varianceTotal == null ? "—" : formatMoney(bv.varianceTotal, bv.currency)}
                    </td>
                    <td className="text-right">
                      {bv.overBudgetLines > 0 ? (
                        <Badge tone="red">{bv.overBudgetLines} kalem</Badge>
                      ) : (
                        <span className="font-mono text-pos">0</span>
                      )}
                    </td>
                    <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-2)" }}>
                      {bv.notMeasuredLines}
                      {bv.departmentLinesUnmeasurable > 0
                        ? ` (${bv.departmentLinesUnmeasurable} dep.)`
                        : ""}
                    </td>
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
