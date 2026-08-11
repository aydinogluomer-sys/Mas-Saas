import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { loadAiResponse, listAiResponses } from "@/lib/ai/engine";
import { loadReport } from "@/lib/reports/engine";
import { generateReportCommentaryAction } from "@/app/(dashboard)/reports/actions";
import { createActionFromAiResponseAction, createActionFromReportAction } from "@/app/(dashboard)/data-quality/actions";
import { Badge } from "@/components/ui/badge";
import { SourceProofDisclosure, aggregateConfidence, confidenceLabel, confidenceTone, type ProofItem } from "@/components/facts/source-proof";
import { Panel } from "@/components/ui/panel";
import { loadDecisionFacts } from "@/lib/facts/engine";

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
  const [r, selectedAi, aiHistory, facts] = await Promise.all([
    loadReport(pool, reportId),
    ai ? loadAiResponse(pool, ai) : Promise.resolve(undefined),
    listAiResponses(pool, 5, reportId),
    loadDecisionFacts(pool),
  ]);
  if (!r) notFound();
  const prompt = (r.meta && typeof r.meta.commentary_prompt === "string" ? r.meta.commentary_prompt : null) as string | null;
  const selectedProofs: ProofItem[] = selectedAi
    ? selectedAi.source_fact_keys.map((key) => {
        const fact = facts.find((f) => f.key === key);
        return fact
          ? {
              key: fact.key,
              title: fact.title,
              value: fact.value,
              confidence: fact.confidence,
              freshness: fact.freshness,
              explanation: fact.explanation,
              sourceHref: fact.sourceHref,
            }
          : { key, title: key, confidence: "unknown", sourceHref: selectedAi.source_hrefs[0] };
      })
    : [];
  const selectedConfidence = aggregateConfidence(selectedProofs);

  return (
    <>
      <Panel
        title={`${TYPE_LABEL[r.report_type] ?? r.report_type} RAPOR - ${r.period_start}${r.period_end !== r.period_start ? ` -> ${r.period_end}` : ""}`}
        right={
          <span className="flex items-center gap-2">
            <Badge tone="green">salt-okunur</Badge>
            <form action={createActionFromReportAction}>
              <input type="hidden" name="reportId" value={reportId} />
              <input type="hidden" name="backTo" value={`/insights/reports/${reportId}`} />
              <button type="submit" className="border px-2 py-1 font-mono text-[10px] uppercase tracking-wider" style={{ borderColor: "var(--line-faint)", color: "var(--text-3)", borderRadius: "var(--radius)" }}>
                gorev
              </button>
            </form>
            <Link href="/insights/reports" className="font-mono text-[10px] uppercase text-tone-2 underline underline-offset-2">
              {"<-"} raporlar
            </Link>
          </span>
        }
      >
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-tone-1">
          {r.body_md}
        </pre>
        <div className="mt-2 font-mono text-[10px] text-tone-4">uretim: {r.created_at} (Europe/Istanbul)</div>
      </Panel>

      {prompt && (
        <Panel
          title="AI RAPOR YORUMU"
          right={
            <span className="flex items-center gap-2">
              {selectedAi && (
                <Badge tone={confidenceTone(selectedConfidence)}>{confidenceLabel(selectedConfidence)}</Badge>
              )}
              {selectedAi && (
                <form action={createActionFromAiResponseAction}>
                  <input type="hidden" name="aiResponseId" value={selectedAi.id} />
                  <input type="hidden" name="backTo" value={`/insights/reports/${reportId}?ai=${selectedAi.id}`} />
                  <button type="submit" className="border px-2 py-1 font-mono text-[10px] uppercase tracking-wider" style={{ borderColor: "var(--line-faint)", color: "var(--text-3)", borderRadius: "var(--radius)" }}>
                    gorev
                  </button>
                </form>
              )}
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
            </span>
          }
        >
          <p className="mb-2 font-mono text-[10px] text-warn">
            Yorum yalniz deterministik facts ve rapor promptunu aciklar; finansal kayit degistirmez.
          </p>
          {selectedAi ? (
            <>
              <pre className="overflow-x-auto whitespace-pre-wrap border p-2 font-mono text-[11px]" style={{ borderColor: "var(--line)", color: "var(--text-1)", background: "var(--surface-2)" }}>
                {selectedAi.answer_md}
              </pre>
              <div className="mt-3">
                <SourceProofDisclosure label="yorumun kanit paketi" items={selectedProofs} defaultOpen />
              </div>
            </>
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap border p-2 font-mono text-[11px]" style={{ borderColor: "var(--line)", color: "var(--text-4)", background: "var(--surface-2)" }}>
              {prompt}
            </pre>
          )}
          {aiHistory.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {aiHistory.map((a) => (
                <Link key={a.id} href={`/insights/reports/${reportId}?ai=${a.id}`} className="font-mono text-[10px] underline underline-offset-2" style={{ color: "var(--accent)" }}>
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
