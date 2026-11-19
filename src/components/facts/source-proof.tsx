import { ArrowUpRight } from "lucide-react";
import Link from "@/components/ui/app-link";
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
  if (confidence === "calculated") return "hesaplanmış";
  if (confidence === "needs_review") return "inceleme gerekli";
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
  label = "Kanıtı göster",
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
        <p className="text-[12.5px]" style={{ color: "var(--text-3)" }}>
          Kaynak izi yok. Bu karar doğrudan gösterilecek bir kanıta bağlanmamış.
        </p>
      ) : (
        <div className="space-y-2">
          {visible.map((item, i) => (
            <div
              key={`${item.key ?? item.title}-${i}`}
              className="border px-3 py-2.5"
              style={{
                borderColor: "var(--line-card)",
                borderRadius: "var(--radius-md)",
                background: "var(--surface-0)",
              }}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-semibold tracking-[-0.005em]" style={{ color: "var(--text-2)" }}>
                    {item.title}
                  </div>
                  {item.value != null && (
                    <div className="mt-0.5 text-[15px] font-bold tabular-nums" style={{ color: "var(--text-1)" }}>
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
                <p className="mt-1 text-[11.5px] leading-snug" style={{ color: "var(--text-3)" }}>
                  {item.explanation}
                </p>
              )}
              {item.sourceHref && (
                <Link
                  href={item.sourceHref}
                  className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-semibold underline-offset-2 hover:underline"
                  style={{ color: "var(--info)" }}
                >
                  <span>{item.sourceLabel ?? "Kaynak ekranı"}</span>
                  <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden />
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </DetailsDisclosure>
  );
}
