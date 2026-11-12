"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { ProofItem } from "./source-proof";

const LazyEvidenceDrawerSheet = dynamic(
  () => import("./evidence-drawer-sheet").then((m) => m.EvidenceDrawerSheet),
  { ssr: false },
);

/**
 * Faz 7 — Lazy EvidenceDrawer trigger.
 * Keeps Radix Dialog (@radix-ui/react-dialog + focus-trap + scroll-lock) out of the initial
 * client hydration path until the user clicks "Bu sonuç neden çıktı?".
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

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setActivated(true);
          setOpen(true);
        }}
        className="font-mono text-[10px] underline underline-offset-2 text-info"
      >
        {label}
      </button>
      {activated && (
        <LazyEvidenceDrawerSheet open={open} onOpenChange={setOpen} items={items} />
      )}
    </>
  );
}
