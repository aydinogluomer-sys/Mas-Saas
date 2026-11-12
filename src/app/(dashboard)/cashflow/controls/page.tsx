import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { getPool } from "@/lib/db";
import { findContinuityIssues } from "@/lib/radar/rules";

export const dynamic = "force-dynamic";

export default async function CashflowControls(props: {
  searchParams?: Promise<{ error?: string; result?: string }>;
}) {
  if (!(process.env.VITEST === "true" && !process.env.DATABASE_URL)) {
    const denied = await requireRouteAccess("/cashflow/controls");
    if (denied) return denied;
  }
  const sp = (await props?.searchParams) ?? {};
  const session = process.env.DATABASE_URL
    ? await import("@/lib/auth").then((m) => m.getRequestUser()).catch(() => null)
    : null;
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

  return (
    <>
      <PageHeader
        title="Nakit akışı veri kontrolleri"
        subtitle="Devir zinciri, ay boşlukları ve bilinmeyen tutarlar; sessiz düzeltme yapılmaz, tek tıkla takip görevi açılır."
        meta={
          <Badge tone={c.breaks + c.gaps ? "red" : "green"} dot>
            {c.breaks + c.gaps} zincir sorunu
          </Badge>
        }
      />

      {sp.error ? (
        <div className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200">{sp.error}</div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-xs text-emerald-200">
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
                    className="rounded border border-amber-700 bg-amber-950/40 px-2 py-1 font-mono text-[10px] text-amber-200"
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
    </>
  );
}
