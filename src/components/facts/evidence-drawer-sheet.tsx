"use client";

import { ArrowUpRight, Clock3, FileCheck2 } from "lucide-react";
import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { SlideOverDrawer } from "@/components/ui/slide-over-drawer";
import { confidenceLabel, confidenceTone, type ProofItem } from "./source-proof";

export function EvidenceDrawerSheet({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ProofItem[];
}) {
  return (
    <SlideOverDrawer
      open={open}
      onOpenChange={onOpenChange}
      eyebrow="Hesaplama ve Kaynak İzi"
      title="Bu sonuç neden çıktı?"
      subtitle="Rakamın türetildiği kanonik tablolar, güncellik zamanı ve doğrudan kayıt bağlantıları."
      badge={<Badge tone="blue">{items.length} kanıt</Badge>}
    >
      <div className="space-y-3">
        {items.length ? (
          items.map((item, index) => (
            <article
              key={`${item.key ?? item.title}-${index}`}
              className="border p-3.5"
              style={{
                background: "var(--surface-0)",
                borderColor: "var(--line-card)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-card)",
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileCheck2 size={15} strokeWidth={1.75} className="shrink-0" style={{ color: "var(--info)" }} aria-hidden />
                  <strong className="truncate text-[13.5px] font-semibold tracking-[-0.01em]" style={{ color: "var(--text-1)" }}>
                    {item.title}
                  </strong>
                </div>
                <Badge tone={confidenceTone(item.confidence)}>{confidenceLabel(item.confidence)}</Badge>
              </div>
              {item.value != null && (
                <div
                  className="mt-2 text-[20px] font-bold tracking-[-0.02em] tabular-nums"
                  style={{ color: "var(--text-1)" }}
                >
                  {item.value}
                </div>
              )}
              {item.explanation && (
                <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--text-2)" }}>
                  {item.explanation}
                </p>
              )}
              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                {item.freshness ? (
                  <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: "var(--text-3)" }}>
                    <Clock3 size={12} strokeWidth={1.75} aria-hidden />
                    <span>Güncellik: {item.freshness}</span>
                  </span>
                ) : (
                  <span />
                )}
                {item.sourceHref && (
                  <Link
                    href={item.sourceHref}
                    className="inline-flex items-center gap-1 text-[12px] font-semibold transition-colors hover:underline"
                    style={{ color: "var(--info)" }}
                  >
                    <span>{item.sourceLabel ?? "Kaynak kayda git"}</span>
                    <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden />
                  </Link>
                )}
              </div>
            </article>
          ))
        ) : (
          <p className="text-[13px]" style={{ color: "var(--text-3)" }}>
            Bu sinyal için doğrudan kaynak paketi bulunamadı.
          </p>
        )}
      </div>
    </SlideOverDrawer>
  );
}
