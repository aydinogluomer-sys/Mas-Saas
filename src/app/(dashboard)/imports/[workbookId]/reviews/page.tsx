import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { Badge, SEVERITY_TONE, STATUS_TONE } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { setReviewStatusAction } from "../../actions";

export const dynamic = "force-dynamic";

const FILTERS = ["open", "accepted", "rejected", "resolved", "all"] as const;

export default async function ReviewsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workbookId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { workbookId } = await params;
  const sp = await searchParams;
  const filter = FILTERS.includes(sp.status as (typeof FILTERS)[number])
    ? (sp.status as (typeof FILTERS)[number])
    : "open";

  const pool = getPool();
  const wb = await pool.query(
    `select id, original_filename from public.source_workbooks where id=$1`,
    [workbookId],
  );
  if (wb.rowCount === 0) notFound();

  const reviews = await pool.query(
    `select m.id, m.issue_type, m.severity, m.message, m.status,
            s.sheet_name, s.id as sheet_id,
            r.row_index
     from public.mapping_reviews m
     join public.source_sheets s on s.id = m.sheet_id
     left join public.import_rows r on r.id = m.import_row_id
     where m.workbook_id = $1 and ($2 = 'all' or m.status = $2)
     order by case m.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
              s.sheet_index, r.row_index nulls last`,
    [workbookId, filter],
  );

  const backTo = `/imports/${workbookId}/reviews?status=${filter}`;
  const counts = await pool.query(
    `select status, count(*)::int as n from public.mapping_reviews where workbook_id=$1 group by status`,
    [workbookId],
  );
  const countOf = (s: string) => counts.rows.find((r) => r.status === s)?.n ?? 0;

  return (
    <>
      <Panel
        title={`EŞLEME İNCELEMELERİ — ${wb.rows[0].original_filename}`}
        right={
          <Link href={`/data/imports/${workbookId}`} className="font-mono text-[10px] uppercase text-tone-2 underline underline-offset-2">
            ← workbook
          </Link>
        }
      >
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Link key={f} href={`/data/imports/${workbookId}/reviews?status=${f}`}
              className={f === filter ? "button-primary px-2 py-1" : "button-ghost px-2 py-1"}>
              {f}{f !== "all" ? ` (${countOf(f)})` : ""}
            </Link>
          ))}
        </div>
        <p className="mt-2 text-xs text-tone-3">
          Kural: belirsiz satırlar nihai tablolara YAZILMAZ — burada karar verilir. Kabul/ret yalnız inceleme
          durumunu değiştirir ve denetim kaydına işlenir; alan eşlemesi Faz 3+ işidir.
        </p>
      </Panel>

      <Panel title={`${reviews.rowCount} kayıt`}>
        {reviews.rowCount === 0 ? (
          <p className="text-sm text-tone-3">Bu filtrede kayıt yok.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                <th className="py-1 pr-2">önem</th>
                <th className="py-1 pr-2">tip</th>
                <th className="py-1 pr-2">sekme / satır</th>
                <th className="py-1 pr-2">mesaj</th>
                <th className="py-1 pr-2">durum</th>
                <th className="py-1">işlem</th>
              </tr>
            </thead>
            <tbody>
              {reviews.rows.map((m) => (
                <tr key={m.id} className="border-b border-line-faint align-top">
                  <td className="py-1.5 pr-2"><Badge tone={SEVERITY_TONE[m.severity]}>{m.severity}</Badge></td>
                  <td className="py-1.5 pr-2 font-mono text-xs">{m.issue_type}</td>
                  <td className="py-1.5 pr-2 text-xs">
                    <Link className="underline decoration-line-strong underline-offset-2"
                      href={`/data/imports/${workbookId}/sheets/${m.sheet_id}`}>
                      {m.sheet_name}
                    </Link>
                    {m.row_index != null ? <span className="font-mono text-tone-3"> · r{m.row_index}</span> : null}
                  </td>
                  <td className="max-w-[360px] py-1.5 pr-2 text-xs">{m.message}</td>
                  <td className="py-1.5 pr-2"><Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status}</Badge></td>
                  <td className="py-1.5">
                    <div className="flex gap-1">
                      {(["accepted", "rejected", "resolved"] as const).map((s) => (
                        <form key={s} action={setReviewStatusAction}>
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="status" value={s} />
                          <input type="hidden" name="backTo" value={backTo} />
                          <button type="submit"
                            className="border border-line-strong px-1.5 py-0.5 font-mono text-[9px] uppercase text-tone-2 hover:border-line-strong">
                            {s === "accepted" ? "kabul" : s === "rejected" ? "ret" : "çözüldü"}
                          </button>
                        </form>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
