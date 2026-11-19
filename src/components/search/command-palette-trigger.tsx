"use client";

import { useCallback, useEffect, useState } from "react";
import type { NavItem } from "@/components/ui/nav";

const TRIGGER_CLASS =
  "inline-flex min-w-[136px] sm:min-w-[180px] xl:min-w-[240px] items-center justify-between gap-2.5 border border-line-strong bg-surface-1 px-2.5 py-1.5 text-xs text-tone-3 shadow-xs transition-colors hover:border-[var(--info)] hover:text-tone-1";

type CommandPaletteComponent = typeof import("./command-palette").CommandPalette;

let cachedCommandPalette: CommandPaletteComponent | null = null;
let pendingCommandPalette: Promise<CommandPaletteComponent> | null = null;

function preloadCommandPalette(): Promise<CommandPaletteComponent> {
  if (cachedCommandPalette) return Promise.resolve(cachedCommandPalette);
  if (!pendingCommandPalette) {
    pendingCommandPalette = import("./command-palette").then((m) => {
      cachedCommandPalette = m.CommandPalette;
      return m.CommandPalette;
    });
  }
  return pendingCommandPalette;
}

if (process.env.NODE_ENV === "test") {
  void preloadCommandPalette();
}

/**
 * Faz 7 & Faz 47 (D1) — Tekil kanonik ⌘K / Ctrl+K tetikleyicisi.
 * Hem klavye kısayolunu hem de sol kenar çubuğundaki "Hızlı erişim" (`mas:open-command-palette`)
 * düğmesini tek `CommandPalette` örneğine yönlendirir; çift modal çakışması yapısal olarak imkânsızdır.
 */
export function CommandPaletteTrigger({ items }: { items?: NavItem[] } = {}) {
  const [activated, setActivated] = useState(false);
  const [idleWarmed, setIdleWarmed] = useState(false);
  const [PaletteComp, setPaletteComp] = useState<CommandPaletteComponent | null>(
    () => cachedCommandPalette,
  );

  const activatePalette = useCallback(() => {
    setActivated(true);
    if (cachedCommandPalette) {
      setPaletteComp(() => cachedCommandPalette);
    } else {
      void preloadCommandPalette().then((Comp) => {
        setPaletteComp(() => Comp);
      });
    }
  }, []);

  useEffect(() => {
    if (activated || idleWarmed) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        activatePalette();
      }
    };
    const onOpenEvent = () => activatePalette();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mas:open-command-palette", onOpenEvent);

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    if (process.env.NODE_ENV !== "test") {
      idleTimer = setTimeout(() => {
        void preloadCommandPalette().then((Comp) => {
          setPaletteComp(() => Comp);
          setIdleWarmed(true);
        });
      }, 20);
    }

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mas:open-command-palette", onOpenEvent);
      if (idleTimer !== null) clearTimeout(idleTimer);
    };
  }, [activated, idleWarmed, activatePalette]);

  const ResolvedPalette = PaletteComp ?? cachedCommandPalette;

  useEffect(() => {
    if (!activated || ResolvedPalette) return;
    const onEscapeWhileLoading = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setActivated(false);
      }
    };
    window.addEventListener("keydown", onEscapeWhileLoading);
    return () => window.removeEventListener("keydown", onEscapeWhileLoading);
  }, [activated, ResolvedPalette]);

  if ((activated || idleWarmed) && ResolvedPalette) {
    return <ResolvedPalette defaultOpen={activated} items={items} />;
  }

  if (activated) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh]"
        style={{ background: "var(--scrim)" }}
        onClick={() => setActivated(false)}
        role="dialog"
        aria-modal="true"
        aria-label="Evrensel arama"
      >
        <div
          className="w-full max-w-2xl border border-line-strong bg-surface-1 p-3 font-mono text-xs text-tone-4 shadow-xl"
          style={{ borderRadius: "var(--radius-lg)" }}
          onClick={(e) => e.stopPropagation()}
        >
          Komut paleti hazırlanıyor…
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onPointerEnter={() => void preloadCommandPalette()}
      onPointerDown={() => void preloadCommandPalette()}
      onFocus={() => void preloadCommandPalette()}
      onClick={activatePalette}
      className={TRIGGER_CLASS}
      style={{ borderRadius: "var(--radius-control)" }}
      aria-label="Ara (Ctrl+K)"
    >
      <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
        <span className="font-mono text-xs" aria-hidden>
          ⌕
        </span>
        <span className="hidden truncate sm:inline">Ekran, cari, çek veya mizan ara…</span>
        <span className="sm:hidden">Ara</span>
      </span>
      <kbd
        className="shrink-0 border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] font-medium text-tone-3"
        style={{ borderRadius: "var(--radius-sm)" }}
      >
        ⌘K
      </kbd>
    </button>
  );
}
