"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { NavItem } from "@/components/ui/nav";

const TRIGGER_CLASS =
  "border border-line-strong px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-tone-3";

const LazyCommandPalette = dynamic(
  () => import("./command-palette").then((m) => m.CommandPalette),
  {
    ssr: false,
    loading: () => (
      <button type="button" className={TRIGGER_CLASS} aria-label="Ara (Ctrl+K)">
        ara ⌘K
      </button>
    ),
  },
);

/**
 * Faz 7 & Faz 47 (D1) — Tekil kanonik ⌘K / Ctrl+K tetikleyicisi.
 * Hem klavye kısayolunu hem de sol kenar çubuğundaki "Hızlı erişim" (`mas:open-command-palette`)
 * düğmesini tek `CommandPalette` örneğine yönlendirir; çift modal çakışması yapısal olarak imkânsızdır.
 */
export function CommandPaletteTrigger({ items }: { items?: NavItem[] } = {}) {
  const [activated, setActivated] = useState(false);

  useEffect(() => {
    if (activated) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setActivated(true);
      }
    };
    const onOpenEvent = () => setActivated(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mas:open-command-palette", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mas:open-command-palette", onOpenEvent);
    };
  }, [activated]);

  if (activated) {
    return <LazyCommandPalette defaultOpen items={items} />;
  }

  return (
    <button
      type="button"
      onClick={() => setActivated(true)}
      className={TRIGGER_CLASS}
      aria-label="Ara (Ctrl+K)"
    >
      ara ⌘K
    </button>
  );
}
