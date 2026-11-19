"use client";

// Faz 35, Faz 47 (D1) & Wave 2A — Tekil birleşik ⌘K / Ctrl+K komut ve evrensel arama paleti.
//
// Hem sunucuda rol-süzülmüş 78+ rota/iş-akışı geçişini (`items` + Türkçe eş anlamlılar)
// hem de `/api/search` tam metin PostgreSQL RLS varlık aramasını tek pencerede birleştirir.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { NavItem } from "@/components/ui/nav";
import { formatMoney } from "@/lib/money-format";
import {
  OPERATIONAL_INTENTS,
  enrichAndExpandPaletteItems,
  normalizeTurkishSearch,
  type OperationalIntentKey,
  type PaletteCommandItem,
} from "@/lib/navigation/intent-index";

interface Hit {
  entityKey: string;
  entityLabel: string;
  id: string;
  title: string;
  amount: number | null;
  currency?: string | null;
  date: string | null;
  href: string;
}

interface Group {
  key: string;
  label: string;
  hits: Hit[];
}

interface EnrichedQuickCommand {
  href: string;
  label: string;
  hint: string;
  moduleLabel: string;
  stageLabel?: string;
  intentCategory?: OperationalIntentKey;
  searchBlobTr: string;
  searchBlobAscii: string;
}

export function CommandPalette({
  defaultOpen = false,
  items = [],
}: {
  defaultOpen?: boolean;
  items?: Array<NavItem & Partial<PaletteCommandItem>>;
} = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [activeIntent, setActiveIntent] = useState<OperationalIntentKey | "all">("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [groups, setGroups] = useState<Group[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    const onOpenEvent = () => setOpen(true);
    const onNavStart = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mas:open-command-palette", onOpenEvent);
    window.addEventListener("mas:navigation-start", onNavStart);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mas:open-command-palette", onOpenEvent);
      window.removeEventListener("mas:navigation-start", onNavStart);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const catalog = useMemo<EnrichedQuickCommand[]>(() => {
    const enriched = enrichAndExpandPaletteItems(items);
    return enriched.map((item) => {
      const rawText = [
        item.label,
        item.description ?? "",
        item.moduleLabel ?? "",
        item.stageLabel ?? "",
        item.href,
        ...(item.keywords ?? []),
      ].join(" ");
      const norm = normalizeTurkishSearch(rawText);
      return {
        href: item.href,
        label: item.label,
        hint: item.description ?? "Çalışma alanına git",
        moduleLabel: item.moduleLabel ?? "Çalışma Alanları",
        stageLabel: item.stageLabel,
        intentCategory: item.intentCategory,
        searchBlobTr: norm.tr,
        searchBlobAscii: norm.ascii,
      };
    });
  }, [items]);

  const quickCommands = useMemo(() => {
    const filteredByIntent =
      activeIntent === "all"
        ? catalog
        : catalog.filter((cmd) => cmd.intentCategory === activeIntent);

    const trimmed = query.trim();
    if (!trimmed) {
      return activeIntent === "all" ? filteredByIntent.slice(0, 12) : filteredByIntent;
    }

    const tokens = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((tok) => normalizeTurkishSearch(tok));

    const scored: Array<{ cmd: EnrichedQuickCommand; score: number }> = [];
    for (const cmd of filteredByIntent) {
      const matchesAll = tokens.every(
        (tok) =>
          cmd.searchBlobTr.includes(tok.tr) || cmd.searchBlobAscii.includes(tok.ascii),
      );
      if (!matchesAll) continue;

      const labelNorm = normalizeTurkishSearch(cmd.label);
      let score = 10;
      for (const tok of tokens) {
        if (labelNorm.tr.startsWith(tok.tr) || labelNorm.ascii.startsWith(tok.ascii)) {
          score += 30;
        } else if (labelNorm.tr.includes(tok.tr) || labelNorm.ascii.includes(tok.ascii)) {
          score += 15;
        }
      }
      scored.push({ cmd, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.cmd);
  }, [catalog, activeIntent, query]);

  const groupedQuickCommands = useMemo(() => {
    const buckets: Array<{ groupLabel: string; commands: EnrichedQuickCommand[] }> = [];
    for (const cmd of quickCommands) {
      const key = cmd.moduleLabel || "Çalışma Alanları";
      let bucket = buckets.find((b) => b.groupLabel === key);
      if (!bucket) {
        bucket = { groupLabel: key, commands: [] };
        buckets.push(bucket);
      }
      bucket.commands.push(cmd);
    }
    return buckets;
  }, [quickCommands]);

  const navigableTargets = useMemo(() => {
    const list: Array<{ key: string; href: string }> = [];
    for (const section of groupedQuickCommands) {
      for (const cmd of section.commands) {
        list.push({ key: `cmd:${cmd.href}:${cmd.label}`, href: cmd.href });
      }
    }
    for (const group of groups) {
      for (const hit of group.hits) {
        list.push({ key: `hit:${hit.entityKey}:${hit.id}`, href: hit.href });
      }
    }
    return list;
  }, [groupedQuickCommands, groups]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, activeIntent]);

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setGroups([]);
      setRefused(null);
      return;
    }
    // Sequence guard: a slow earlier request must never overwrite a newer result.
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) {
        if (mine === seq.current) {
          setGroups([]);
          setRefused(null);
        }
        return;
      }
      const data = (await res.json()) as { groups: Group[]; refused: boolean; message?: string };
      if (mine !== seq.current) return;
      setGroups(data.groups ?? []);
      setRefused(data.refused ? (data.message ?? "Arama reddedildi.") : null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void search(query), 200);
    return () => clearTimeout(t);
  }, [query, search]);

  const handleDialogKeyDown = (e: React.KeyboardEvent) => {
    if (navigableTargets.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % navigableTargets.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + navigableTargets.length) % navigableTargets.length);
    } else if (e.key === "Enter") {
      const target = navigableTargets[selectedIndex];
      if (target) {
        e.preventDefault();
        setOpen(false);
        window.dispatchEvent(new CustomEvent("mas:navigation-start"));
        router.push(target.href);
      }
    }
  };

  const activeTargetKey = open ? (navigableTargets[selectedIndex]?.key ?? null) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-w-[190px] sm:min-w-[260px] items-center justify-between gap-3 border border-line-strong bg-surface-1 px-3 py-1.5 text-xs text-tone-3 shadow-xs transition-colors hover:border-[var(--info)] hover:text-tone-1"
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
      <div
        hidden={!open}
        className={open ? "fixed inset-0 z-50 flex items-start justify-center p-4 pt-[8vh]" : "hidden"}
        style={{ background: "var(--scrim)" }}
        onClick={() => setOpen(false)}
        onKeyDown={handleDialogKeyDown}
        role="dialog"
        aria-modal={open ? "true" : undefined}
        aria-label="Evrensel arama"
      >
      <div
        className="w-full max-w-2xl overflow-hidden border border-line-strong"
        style={{
          background: "var(--surface-overlay)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-overlay)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top search input */}
        <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5">
          <span className="font-mono text-xs text-tone-3" aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Sayfa, işlem veya kayıt ara: mizan, karşılıksız çek, kovenant, oee, pain.001, fatura…"
            aria-label="Komut ve kayıt ara"
            className="min-w-0 flex-1 bg-transparent text-sm text-tone-1 outline-none placeholder:text-tone-4"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="border border-line bg-surface-1 px-1.5 py-0.5 font-mono text-[10px] text-tone-3 hover:bg-surface-2"
              style={{ borderRadius: "var(--radius-sm)" }}
              aria-label="Aramayı temizle"
            >
              Temizle
            </button>
          )}
          <kbd
            className="hidden border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-tone-4 sm:inline-block"
            style={{ borderRadius: "var(--radius-sm)" }}
          >
            Esc
          </kbd>
        </div>

        {/* 4 Operational Intent filter chips (DESIGN.md Law 2, concentric 6px radius inside 12px dialog) */}
        <div
          className="flex flex-wrap items-center gap-1.5 border-b border-line-faint px-3.5 py-2"
          style={{ background: "var(--surface-1)" }}
          aria-label="Operasyonel amaç filtreleri"
        >
          <button
            type="button"
            onClick={() => setActiveIntent("all")}
            aria-pressed={activeIntent === "all"}
            className="border px-2.5 py-1 text-[11px] font-semibold transition-colors"
            style={{
              borderRadius: "var(--radius-control, 6px)",
              borderColor:
                activeIntent === "all" ? "var(--info)" : "var(--line)",
              background:
                activeIntent === "all"
                  ? "color-mix(in srgb, var(--info) 10%, var(--surface-1))"
                  : "var(--surface-overlay)",
              color: activeIntent === "all" ? "var(--info)" : "var(--text-2)",
            }}
          >
            Tüm Akışlar
          </button>
          {OPERATIONAL_INTENTS.map((intent) => {
            const active = activeIntent === intent.key;
            return (
              <button
                key={intent.key}
                type="button"
                onClick={() => setActiveIntent(active ? "all" : intent.key)}
                aria-pressed={active}
                className="border px-2.5 py-1 text-[11px] font-medium transition-colors"
                style={{
                  borderRadius: "var(--radius-control, 6px)",
                  borderColor: active ? "var(--info)" : "var(--line)",
                  background: active
                    ? "color-mix(in srgb, var(--info) 10%, var(--surface-1))"
                    : "var(--surface-overlay)",
                  color: active ? "var(--info)" : "var(--text-2)",
                }}
              >
                <span className="tnum mr-1 font-mono text-[10px] text-tone-4">
                  {intent.stepBadge}
                </span>
                {intent.shortLabel}
              </button>
            );
          })}
        </div>

        {/* Results scroll pane */}
        <div className="max-h-[56vh] overflow-y-auto p-1.5" role="listbox" aria-label="Arama sonuçları">
          {groupedQuickCommands.map((section) => (
            <div key={section.groupLabel} className="mb-1 border-b border-line-faint pb-1 last:mb-0 last:border-0">
              <div className="flex items-center justify-between px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-tone-3">
                <span>{section.groupLabel}</span>
                <span className="tnum font-mono text-[10px] text-tone-4">
                  {section.commands.length} ekran
                </span>
              </div>
              {section.commands.map((cmd) => {
                const itemKey = `cmd:${cmd.href}:${cmd.label}`;
                const isSelected = activeTargetKey === itemKey;
                const itemIdx = navigableTargets.findIndex((t) => t.key === itemKey);
                return (
                  <a
                    key={itemKey}
                    href={cmd.href}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => {
                      if (itemIdx >= 0) setSelectedIndex(itemIdx);
                    }}
                    onClick={() => setOpen(false)}
                    className="flex items-center justify-between gap-3 px-2.5 py-1.5 transition-colors"
                    style={{
                      borderRadius: "var(--radius-control, 6px)",
                      background: isSelected ? "var(--surface-hover)" : "transparent",
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-tone-1">
                        {cmd.label}
                      </span>
                      <span className="block truncate text-[11.5px] text-tone-3">
                        {cmd.hint}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {cmd.stageLabel && (
                        <span
                          className="tnum hidden border border-line bg-surface-1 px-1.5 py-0.5 text-[10px] font-medium text-tone-3 sm:inline-block"
                          style={{ borderRadius: "var(--radius-sm)" }}
                        >
                          {cmd.stageLabel}
                        </span>
                      )}
                      <span className="font-mono text-[11px] text-tone-3" aria-hidden>
                        →
                      </span>
                    </span>
                  </a>
                );
              })}
            </div>
          ))}

          {refused && <p className="p-3 font-mono text-xs text-warn">{refused}</p>}
          {!refused && loading && groups.length === 0 && (
            <p className="p-3 font-mono text-[11px] text-tone-4">kayıtlar aranıyor…</p>
          )}
          {!refused &&
            !loading &&
            query.trim().length >= 2 &&
            groups.length === 0 &&
            quickCommands.length === 0 && (
              <p className="p-4 text-center text-xs text-tone-3">
                “{query.trim()}” için eşleşen ekran veya kayıt bulunamadı.
              </p>
            )}

          {groups.map((group) => (
            <div key={group.key} className="mb-1 border-b border-line-faint pb-1 last:mb-0 last:border-0">
              <div className="px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-tone-3">
                {group.label}
              </div>
              {group.hits.map((hit) => {
                const hitKey = `hit:${hit.entityKey}:${hit.id}`;
                const isSelected = activeTargetKey === hitKey;
                const hitIdx = navigableTargets.findIndex((t) => t.key === hitKey);
                return (
                  <a
                    key={hitKey}
                    href={hit.href}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => {
                      if (hitIdx >= 0) setSelectedIndex(hitIdx);
                    }}
                    onClick={() => setOpen(false)}
                    className="flex items-center justify-between gap-3 px-2.5 py-1.5 transition-colors"
                    style={{
                      borderRadius: "var(--radius-control, 6px)",
                      background: isSelected ? "var(--surface-hover)" : "transparent",
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-tone-1">
                      {hit.title}
                    </span>
                    <span className="tnum shrink-0 font-mono text-[11px] text-tone-3">
                      {/* R10: Unknown amount renders empty, never coerced to 0 TL. */}
                      {hit.amount != null
                        ? formatMoney(hit.amount, hit.currency ?? "TRY", {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 0,
                          })
                        : ""}{" "}
                      {hit.date ?? ""}
                    </span>
                  </a>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer guidance */}
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3.5 py-2 text-[11px] text-tone-4"
          style={{ background: "var(--surface-1)" }}
        >
          <span>
            Sonuçlar rolünüzün görebildikleriyle sınırlıdır (PostgreSQL RLS).
          </span>
          <span className="font-mono text-[10px]">
            ↑↓ Seç · Enter Aç · Esc Kapat
          </span>
        </div>
      </div>
    </div>
    </>
  );
}
