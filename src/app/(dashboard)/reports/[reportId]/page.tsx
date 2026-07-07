import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { loadAiResponse, listAiResponses } from "@/lib/ai/engine";
import { loadReport } from "@/lib/reports/engine";
import { generateReportCommentaryAction } from "@/app/(dashboard)/reports/actions";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = { daily: "Gunluk", weekly: "Haftalik", monthly: "Aylik", strategic: "Stratejik", data_quality: "Veri Kalitesi" };

export default async function ReportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ reportId: string }>;
  searchParams: Promise<{ ai?: string }>;
}) {
  const { reportId } = await params;
  const { ai } = await searchParams;
  const pool = getPool();
  const [r, selectedAi, aiHistory] = await Promise.all([
    loadReport(pool, reportId),
    ai ? loadAiResponse(pool, ai) : Promise.resolve(undefined),
    listAiResponses(pool, 5, reportId),
  ]);
  if (!r) notFound();
  const prompt = (r.meta && typeof r.meta.commentary_prompt === "string" ? r.meta.commentary_prompt : null) as string | null;

  return (
    <>
      <Panel
        title={`${TYPE_LABEL[r.report_type] ?? r.report_type} RAPOR - ${r.period_start}${r.period_end !== r.period_start ? ` -> ${r.period_end}` : ""}`}
        right={
          <span className="flex items-center gap-2">
            <Badge tone="green">salt-okunur</Badge>
            <Link href="/reports" className="font-mono text-[10px] uppercase text-zinc-400 underline underline-offset-2">
              {"<-"} raporlar
            </Link>
          </span>
        }
      >
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-zinc-200">
          {r.body_md}
        </pre>
        <div className="mt-2 font-mono text-[10px] text-zinc-600">uretim: {r.created_at} (Europe/Istanbul)</div>
      </Panel>

      {prompt && (
        <Panel
          title="AI RAPOR YORUMU"
          right={
            <form action={generateReportCommentaryAction}>
              <input type="hidden" name="reportId" value={reportId} />
              <button
                type="submit"
                className="border px-2 py-1 font-mono text-[10px] uppercase tracking-wider"
                style={{ borderColor: "var(--accent)", color: "var(--accent)", borderRadius: "var(--radius)" }}
              >
                yorum uret
              </button>
            </form>
          }
        >
          <p className="mb-2 font-mono text-[10px] text-amber-400">
            Yorum yalniz deterministik facts ve rapor promptunu aciklar; finansal kayit degistirmez.
          </p>
          {selectedAi ? (
            <pre className="overflow-x-auto whitespace-pre-wrap border p-2 font-mono text-[11px]" style={{ borderColor: "var(--line)", color: "var(--text-1)", background: "var(--surface-2)" }}>
              {selectedAi.answer_md}
            </pre>
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap border p-2 font-mono text-[11px]" style={{ borderColor: "var(--line)", color: "var(--text-4)", background: "var(--surface-2)" }}>
              {prompt}
            </pre>
          )}
          {aiHistory.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {aiHistory.map((a) => (
                <Link key={a.id} href={`/reports/${reportId}?ai=${a.id}`} className="font-mono text-[10px] underline underline-offset-2" style={{ color: "var(--accent)" }}>
                  {a.created_at} / {a.response_mode}
                </Link>
              ))}
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
