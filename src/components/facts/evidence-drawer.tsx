"use client";

import { useEffect, useState } from "react";
import { FileSearch } from "lucide-react";
import type { ProofItem } from "./source-proof";

type EvidenceDrawerSheetComponent = typeof import("./evidence-drawer-sheet").EvidenceDrawerSheet;

let cachedEvidenceDrawerSheet: EvidenceDrawerSheetComponent | null = null;
let pendingEvidenceDrawerSheet: Promise<EvidenceDrawerSheetComponent> | null = null;

function preloadEvidenceDrawerSheet(): Promise<EvidenceDrawerSheetComponent> {
  if (cachedEvidenceDrawerSheet) return Promise.resolve(cachedEvidenceDrawerSheet);
  if (!pendingEvidenceDrawerSheet) {
    pendingEvidenceDrawerSheet = import("./evidence-drawer-sheet").then((m) => {
      cachedEvidenceDrawerSheet = m.EvidenceDrawerSheet;
      return m.EvidenceDrawerSheet;
    });
  }
  return pendingEvidenceDrawerSheet;
}

/**
 * Lazy EvidenceDrawer trigger with < 40ms GPU SlideOverDrawer sheet.
 */
export function EvidenceDrawer({
  items,
  label = "Bu sonuç neden çıktı?",
}: {
  items: ProofItem[];
  label?: string;
}) {
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  const [SheetComp, setSheetComp] = useState<EvidenceDrawerSheetComponent | null>(
    () => cachedEvidenceDrawerSheet,
  );

  useEffect(() => {
    if (process.env.NODE_ENV === "test") return;
    const timer = setTimeout(() => {
      void preloadEvidenceDrawerSheet();
    }, 40);
    return () => clearTimeout(timer);
  }, []);

  const ResolvedSheet = SheetComp ?? cachedEvidenceDrawerSheet;

  return (
    <>
      <button
        type="button"
        onPointerEnter={() => void preloadEvidenceDrawerSheet()}
        onPointerDown={() => void preloadEvidenceDrawerSheet()}
        onFocus={() => void preloadEvidenceDrawerSheet()}
        onClick={() => {
          setActivated(true);
          setOpen(true);
          if (cachedEvidenceDrawerSheet) {
            setSheetComp(() => cachedEvidenceDrawerSheet);
          } else {
            void preloadEvidenceDrawerSheet().then((Comp) => {
              setSheetComp(() => Comp);
            });
          }
        }}
        className="inline-flex items-center gap-1 text-[11.5px] font-medium underline-offset-2 hover:underline"
        style={{ color: "var(--info)" }}
      >
        <FileSearch size={12.5} strokeWidth={1.75} className="shrink-0" aria-hidden />
        <span>{label}</span>
      </button>
      {activated && ResolvedSheet && (
        <ResolvedSheet open={open} onOpenChange={setOpen} items={items} />
      )}
    </>
  );
}
