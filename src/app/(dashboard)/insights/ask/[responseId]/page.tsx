import Link from "@/components/ui/app-link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { loadAiResponse } from "@/lib/ai/engine";
import type { ToolEvidenceRecord } from "@/lib/ai/tools";
import { loadDecisionFacts } from "@/lib/facts/engine";
import { createActionFromAiResponseAction } from "@/app/(dashboard)/data/quality/actions";
import {
  SourceProofDisclosure,
  aggregateConfidence,
  confidenceLabel,
  confidenceTone,
  type ProofItem,
} from "@/components/facts/source-proof";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader, TableShell } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

export default async function AnswerPage({
  params,
}: {
  params: Promise<{ responseId: string }>;
}) {
  const denied = await requireRouteAccess("/insights/ask/[responseId]");
  if (denied) return denied;
  const { responseId } = await params;
  const p = getPool();
  const [a, facts] = await Promise.all([loadAiResponse(p, responseId), loadDecisionFacts(p)]);
  if (!a) notFound();

  const toolEvidence: ToolEvidenceRecord[] = Array.isArray(a.meta?.toolEvidence)
    ? (a.meta?.toolEvidence as ToolEvidenceRecord[])
    : [];

  const proofs: ProofItem[] = a.source_fact_keys.map((key) => {
    const f = facts.find((x) => x.key === key);
    if (f) {
      return {
        key: f.key,
        title: f.title,
        value: f.value,
        confidence: f.confidence,
        freshness: f.freshness,
        explanation: f.explanation,
        sourceHref: f.sourceHref,
      };
    }
    const matchingTool = toolEvidence.find((ev) => key.includes(ev.tool.replace(/^query/, "").toLowerCase()) || key.startsWith("sql_"));
    if (matchingTool) {
      return {
        key,
        title: `SQL Kanıtı (${matchingTool.tool})`,
        value: `${matchingTool.count} kayıt`,
        confidence: "source",
        freshness: matchingTool.asOf,
        explanation: matchingTool.headline,
        sourceHref: matchingTool.sourceHref,
      };
    }
    return { key, title: key, confidence: "unknown", sourceHref: a.source_hrefs[0] };
  });
  const conf = aggregateConfidence(proofs);

  return (
    <>
      <PageHeader
        title="Finansal Cevap & SQL Kanıt İzi"
        subtitle={a.question}
        meta={
          <>
            <Badge tone={a.response_mode === "openai" ? "green" : a.response_mode === "fallback" ? "amber" : "neutral"}>
              {a.response_mode}
            </Badge>
            <Badge tone={confidenceTone(conf)}>{confidenceLabel(conf)}</Badge>
            {toolEvidence.length > 0 && <Badge tone="blue">{toolEvidence.length} SQL aracı</Badge>}
            {a.model && <Badge tone="neutral">{a.model}</Badge>}
          </>
        }
      />

      <Panel
        title="Analitik Cevap"
        right={
          <form action={createActionFromAiResponseAction}>
            <input type="hidden" name="aiResponseId" value={a.id} />
            <input type="hidden" name="backTo" value={`/insights/ask/${a.id}`} />
            <button className="button-ghost px-2 py-1">Göreve dönüştür</button>
          </form>
        }
      >
        <pre className="whitespace-pre-wrap font-sans text-sm leading-6" style={{ color: "var(--text-1)" }}>
          {a.answer_md}
        </pre>
        {a.safety_notes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {a.safety_notes.map((n) => (
              <Badge key={n} tone="amber">
                {n}
              </Badge>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Link className="button-accent px-2.5 py-1.5" href={`/scenarios?from=ai-${a.id}`}>
            Senaryoda dene
          </Link>
          <Link className="button-ghost px-2.5 py-1.5" href="/insights/ask">
            Yeni soru sor
          </Link>
        </div>
      </Panel>

      {toolEvidence.length > 0 && (
        <Panel
          title="SALT-OKUNUR SQL SORGU KANIT İZİ"
          subtitle="Asistanın yanıt üretirken çalıştırdığı parametrik SELECT sorguları, tablo adları ve kayıt sayıları"
        >
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left font-mono text-[10px] uppercase" style={{ borderColor: "var(--line)", color: "var(--text-3)" }}>
                  <th className="py-1.5 pr-2">Araç</th>
                  <th className="py-1.5 pr-2">Tablo / Görünüm</th>
                  <th className="py-1.5 pr-2 text-right">Kayıt Sayısı</th>
                  <th className="py-1.5 pr-2">Baz Tarihi</th>
                  <th className="py-1.5 pr-2">Özet Bulgu</th>
                  <th className="py-1.5 text-right">Kaynak Ekran</th>
                </tr>
              </thead>
              <tbody>
                {toolEvidence.map((ev) => (
                  <tr key={`${ev.tool}-${ev.table}`} className="border-b last:border-0" style={{ borderColor: "var(--line-faint)" }}>
                    <td className="py-1.5 pr-2 font-mono font-semibold">{ev.tool}</td>
                    <td className="py-1.5 pr-2 font-mono" style={{ color: "var(--text-2)" }}>{ev.table}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{ev.count}</td>
                    <td className="py-1.5 pr-2 font-mono">{ev.asOf}</td>
                    <td className="py-1.5 pr-2">{ev.headline}</td>
                    <td className="py-1.5 text-right font-mono">
                      <Link href={ev.sourceHref} className="underline" style={{ color: "var(--info)" }}>
                        {ev.sourceHref} →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      )}

      <SourceProofDisclosure label="Cevabın kanıt paketi" items={proofs} defaultOpen />
    </>
  );
}
