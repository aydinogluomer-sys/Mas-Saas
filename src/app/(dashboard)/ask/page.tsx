import Link from "next/link";
import { askQuestionAction } from "@/app/(dashboard)/ask/actions";
import { createActionFromAiResponseAction } from "@/app/(dashboard)/data-quality/actions";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { getPool } from "@/lib/db";
import { listAiResponses, loadAiResponse } from "@/lib/ai/engine";

export const dynamic = "force-dynamic";

const SAMPLE_QUESTIONS = [
  "Eylul 2026 neden eksiye dusuyor?",
  "Onumuzdeki 30 gunde cek ve kredi yuku ne kadar?",
  "Akon fiyatlari basabasi karsiliyor mu?",
  "Hangi sinyal bugun en kritik?",
];

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ response?: string }>;
}) {
  const { response } = await searchParams;
  const pool = getPool();
  const [selected, recent] = await Promise.all([
    response ? loadAiResponse(pool, response) : Promise.resolve(undefined),
    listAiResponses(pool, 10),
  ]);

  return (
    <>
      <PageHeader
        title="Soru-Cevap"
        subtitle="Facts / rapor / senaryo kaynakli salt-okunur finans yaniti"
        meta={<Badge tone="amber">mutasyon yok</Badge>}
      />

      <Panel title="SOR">
        <form action={askQuestionAction} className="space-y-2">
          <textarea
            name="question"
            rows={3}
            required
            className="w-full border bg-black/30 p-2 text-sm outline-none"
            style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", color: "var(--text-1)" }}
            placeholder="Onumuzdeki 30 gunde cek ve kredi yuku ne kadar?"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="border px-3 py-2 font-mono text-[10px] uppercase tracking-wider"
              style={{ borderColor: "var(--accent)", color: "var(--accent)", borderRadius: "var(--radius)", background: "color-mix(in srgb, var(--accent) 10%, transparent)" }}
            >
              cevapla
            </button>
            <label className="flex items-center gap-1.5 font-mono text-[10px]" style={{ color: "var(--text-3)" }}>
              <input name="forceDeterministic" type="checkbox" className="h-3 w-3" />
              deterministic
            </label>
          </div>
        </form>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {SAMPLE_QUESTIONS.map((q) => (
            <span key={q} className="border px-2 py-1 text-[11px]" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", color: "var(--text-3)" }}>
              {q}
            </span>
          ))}
        </div>
      </Panel>

      {selected && (
        <Panel
          title="CEVAP"
          right={
            <span className="flex items-center gap-2">
              <Badge tone={selected.response_mode === "openai" ? "green" : selected.response_mode === "fallback" ? "amber" : "neutral"}>{selected.response_mode}</Badge>
              <form action={createActionFromAiResponseAction}>
                <input type="hidden" name="aiResponseId" value={selected.id} />
                <input type="hidden" name="backTo" value={`/ask?response=${selected.id}`} />
                <button type="submit" className="border px-2 py-1 font-mono text-[10px] uppercase tracking-wider" style={{ borderColor: "var(--line-faint)", color: "var(--text-3)", borderRadius: "var(--radius)" }}>
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
