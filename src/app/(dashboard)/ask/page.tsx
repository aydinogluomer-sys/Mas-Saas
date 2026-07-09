import Link from "next/link";
import { askQuestionAction } from "@/app/(dashboard)/ask/actions";
import { createActionFromAiResponseAction } from "@/app/(dashboard)/data-quality/actions";
import { Badge } from "@/components/ui/badge";
import { SourceProofDisclosure, aggregateConfidence, confidenceLabel, confidenceTone, type ProofItem } from "@/components/facts/source-proof";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { getPool } from "@/lib/db";
import { listAiResponses, loadAiResponse } from "@/lib/ai/engine";
import { loadDecisionFacts } from "@/lib/facts/engine";

export const dynamic = "force-dynamic";

const SAMPLE_QUESTIONS = [
  "Bugun ne odenecek?",
  "7 gunde ne kadar cikis var?",
  "Geciken odeme var mi?",
  "Kasa ne zaman negatife dusuyor?",
  "En kotu ay hangisi?",
  "En buyuk yogunlasma nerede?",
  "Hangi aksiyon oncelikli?",
];

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ response?: string }>;
}) {
  const { response } = await searchParams;
  const pool = getPool();
  const [selected, recent, facts] = await Promise.all([
    response ? loadAiResponse(pool, response) : Promise.resolve(undefined),
    listAiResponses(pool, 10),
    loadDecisionFacts(pool),
  ]);
  const selectedProofs: ProofItem[] = selected
    ? selected.source_fact_keys.map((key) => {
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
          : { key, title: key, confidence: "unknown", sourceHref: selected.source_hrefs[0] };
      })
    : [];
  const selectedConfidence = aggregateConfidence(selectedProofs);

  return (
    <>
      <PageHeader
        title="Soru-Cevap"
        subtitle="Facts / rapor / senaryo kaynakli salt-okunur finans yaniti"
        meta={<Badge tone="amber">mutasyon yok</Badge>}
      />

      <Panel title="KARAR SORUSU" subtitle="Cevap deterministik facts ile kanıtlanır; AI yalnız açıklar.">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <form action={askQuestionAction} className="min-w-0 space-y-2">
            <textarea
              name="question"
              rows={4}
              required
              className="field-control min-h-28 resize-y p-3 text-sm"
              placeholder="Önümüzdeki 30 günde çek ve kredi yükü ne kadar?"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className="button-accent px-3 py-2">
                cevapla
              </button>
              <label className="button-ghost cursor-pointer px-2.5 py-2">
                <input name="forceDeterministic" type="checkbox" className="h-3 w-3 accent-violet-400" />
                deterministic
              </label>
              <span className="font-mono text-[10px]" style={{ color: "var(--text-4)" }}>
                kaynak: facts / rapor / senaryo
              </span>
            </div>
          </form>
          <div className="border-t pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0" style={{ borderColor: "var(--line-faint)" }}>
            <div className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--text-3)" }}>
              Hazır karar soruları
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SAMPLE_QUESTIONS.map((q) => (
                <form key={q} action={askQuestionAction}>
                  <input type="hidden" name="question" value={q} />
                  <button type="submit" className="button-ghost px-2 py-1.5 text-left">
                    {q}
                  </button>
                </form>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      {selected && (
        <Panel
          title="CEVAP"
          right={
            <span className="flex items-center gap-2">
              <Badge tone={selected.response_mode === "openai" ? "green" : selected.response_mode === "fallback" ? "amber" : "neutral"}>{selected.response_mode}</Badge>
              <Badge tone={confidenceTone(selectedConfidence)}>{confidenceLabel(selectedConfidence)}</Badge>
              <form action={createActionFromAiResponseAction}>
                <input type="hidden" name="aiResponseId" value={selected.id} />
                <input type="hidden" name="backTo" value={`/ask?response=${selected.id}`} />
                <button type="submit" className="button-ghost px-2 py-1">
                  gorev
                </button>
              </form>
            </span>
          }
        >
          <div className="mb-2 text-[11px]" style={{ color: "var(--text-4)" }}>
            {selected.created_at}{selected.model ? ` / ${selected.model}` : ""}
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed" style={{ color: "var(--text-1)" }}>
            {selected.answer_md}
          </pre>
          {selected.source_hrefs.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {selected.source_hrefs.map((href) => (
                <Link key={href} href={href} className="font-mono text-[10px] underline underline-offset-2" style={{ color: "var(--accent)" }}>
                  {href}
                </Link>
              ))}
            </div>
          )}
          {selected.safety_notes.length > 0 && (
            <div className="mt-2">
              {selected.safety_notes.map((n) => <Badge key={n} tone="amber">{n}</Badge>)}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={`/scenarios?from=ask-${selected.id}`} className="button-accent px-2 py-1">
              senaryo calistir
            </Link>
            {selected.source_hrefs[0] && (
              <Link href={selected.source_hrefs[0]} className="button-ghost px-2 py-1">
                ilk kaniti ac
              </Link>
            )}
          </div>
          <div className="mt-3">
            <SourceProofDisclosure label="cevabin kanit paketi" items={selectedProofs} defaultOpen />
          </div>
        </Panel>
      )}

      <Panel title={`GECMIS CEVAPLAR - ${recent.length}`}>
        {recent.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-3)" }}>Henuz cevap yok.</p>
        ) : (
          <div className="space-y-1">
            {recent.map((r) => (
              <Link
                key={r.id}
                href={`/ask?response=${r.id}`}
                className="card-hover flex items-center justify-between gap-2 border px-2.5 py-2"
                style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}
              >
                <span className="truncate text-sm" style={{ color: "var(--text-1)" }}>{r.question}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone={r.response_mode === "openai" ? "green" : r.response_mode === "fallback" ? "amber" : "neutral"}>{r.response_mode}</Badge>
                  <span className="font-mono text-[10px]" style={{ color: "var(--text-4)" }}>{r.created_at}</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
