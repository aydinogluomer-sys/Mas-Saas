"use client";

import Link from "next/link";
import type { ProofItem } from "./source-proof";
import { confidenceLabel, confidenceTone } from "./source-proof";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/primitives/sheet";

export function EvidenceDrawer({ items, label = "Bu sonuç neden çıktı?" }: { items: ProofItem[]; label?: string }) {
  return (
    <Sheet>
      <SheetTrigger className="font-mono text-[10px] underline underline-offset-2 text-info">{label}</SheetTrigger>
      <SheetContent aria-describedby={undefined}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="module-eyebrow">Hesaplama ve kaynak</div>
            <SheetTitle className="text-lg font-semibold">Bu sonuç neden çıktı?</SheetTitle>
          </div>
          <SheetClose className="button-ghost px-3 py-2">Kapat</SheetClose>
        </div>
        <div className="mt-5 space-y-3">
          {items.length ? (
            items.map((item, index) => (
              <article key={`${item.key ?? item.title}-${index}`} className="border border-line p-3">
                <div className="flex items-start justify-between gap-2">
                  <strong className="text-sm">{item.title}</strong>
                  <Badge tone={confidenceTone(item.confidence)}>{confidenceLabel(item.confidence)}</Badge>
                </div>
                {item.value != null && <div className="mt-1 font-mono text-base">{item.value}</div>}
                {item.explanation && <p className="mt-2 text-xs text-tone-3">{item.explanation}</p>}
                {item.freshness && <p className="mt-2 text-[10px] text-tone-3">Güncellik: {item.freshness}</p>}
                {item.sourceHref && <Link href={item.sourceHref} className="mt-3 inline-block text-xs text-info underline">Kaynak kayda git →</Link>}
              </article>
            ))
          ) : (
            <p className="text-sm text-tone-3">Bu sinyal için doğrudan kaynak paketi bulunamadı.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
