import Link from "next/link";
import { Badge, type Tone } from "@/components/ui/badge";
import { DetailsDisclosure } from "@/components/ui/shell";

export type ProofConfidence = "source" | "calculated" | "needs_review" | string;

export interface ProofItem {
  key?: string | null;
  title: string;
  value?: string | number | null;
  confidence?: ProofConfidence | null;
  freshness?: string | null;
  explanation?: string | null;
  sourceHref?: string | null;
  sourceLabel?: string | null;
}

export function confidenceLabel(confidence?: ProofConfidence | null): string {
  if (confidence === "source") return "kaynak";
  if (confidence === "calculated") return "hesaplanmis";
  if (confidence === "needs_review") return "review gerekli";
  return confidence ? String(confidence) : "belirsiz";
}

export function confidenceTone(confidence?: ProofConfidence | null): Tone {
  if (confidence === "source") return "green";
  if (confidence === "calculated") return "blue";
  if (confidence === "needs_review") return "amber";
  return "neutral";
}

export function aggregateConfidence(items: ProofItem[]): ProofConfidence {
  if (items.some((i) => i.confidence === "needs_review")) return "needs_review";
  if (items.some((i) => i.confidence === "calculated")) return "calculated";
  if (items.some((i) => i.confidence === "source")) return "source";
  return "unknown";
}

export function SourceProofDisclosure({
  label = "kaniti goster",
  items,
  defaultOpen = false,
}: {
  label?: string;
  items: ProofItem[];
  defaultOpen?: boolean;
}) {
  const visible = items.filter((i) => i.title || i.sourceHref || i.explanation);
  return (
    <DetailsDisclosure label={label} defaultOpen={defaultOpen}>
      {visible.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-3)" }}>
          Kaynak izi yok. Bu karar dogrudan gosterilecek bir fact&apos;e baglanmamis.
        </p>
      ) : (
        <div className="space-y-2">
          {visible.map((item, i) => (
            <div
              key={`${item.key ?? item.title}-${i}`}
              className="border px-2.5 py-2"
              style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--text-3)" }}>
                    {item.title}
                  </div>
                  {item.value != null && (
                    <div className="mt-0.5 font-mono text-sm tabular-nums" style={{ color: "var(--text-1)" }}>
                      {item.value}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  <Badge tone={confidenceTone(item.confidence)}>{confidenceLabel(item.confidence)}</Badge>
                  {item.freshness && <Badge tone="neutral">{item.freshness}</Badge>}
                </div>
              </div>
              {item.explanation && (
                <p className="mt-1 text-[11px]" style={{ color: "var(--text-4)" }}>
                  {item.explanation}
                </p>
              )}
              {item.sourceHref && (
                <Link href={item.sourceHref} className="mt-1.5 inline-block font-mono text-[10px] underline underline-offset-2" style={{ color: "var(--accent)" }}>
                  {item.sourceLabel ?? "kaynak ekrani"} -&gt;
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </DetailsDisclosure>
  );
}
