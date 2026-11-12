"use client";

// Faz 35 & Faz 47 (D1) — Tekil birleşik ⌘K / Ctrl+K komut ve evrensel arama paleti.
//
// Hem sunucuda rol-süzülmüş sayfa/komut geçişini (`items`) hem de `/api/search` tam metin
// varlık aramasını tek pencerede birleştirir. İstemcide sabit rota listesi tutulmaz;
// `/api/search` sonuçları da sunucuda oturumun PostgreSQL RLS katmanıyla çalışır.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "@/components/ui/app-link";
import type { NavItem } from "@/components/ui/nav";
import { formatMoney } from "@/lib/money-format";

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
interface Group { key: string; label: string; hits: Hit[] }

interface QuickCommand {
  label: string;
  hint: string;
  href: string;
}

export function CommandPalette({
  defaultOpen = false,
  items = [],
}: {
  defaultOpen?: boolean;
  items?: NavItem[];
} = {}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
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

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const quickCommands = useMemo(() => {
    const all: QuickCommand[] = items.map((item) => ({
      label: item.label,
      hint: item.description ?? "Çalışma alanına git",
      href: item.href,
    }));
    const needle = query.trim().toLocaleLowerCase("tr-TR");
    if (!needle) return all;
    return all.filter((cmd) =>
      `${cmd.label} ${cmd.hint}`.toLocaleLowerCase("tr-TR").includes(needle),
    );
  }, [items, query]);

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setGroups([]); setRefused(null); return; }
    // Sequence guard: a slow earlier request must never overwrite a newer result.
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) { if (mine === seq.current) { setGroups([]); setRefused(null); } return; }
      const data = await res.json() as { groups: Group[]; refused: boolean; message?: string };
      if (mine !== seq.current) return;
      setGroups(data.groups ?? []);
      setRefused(data.refused ? (data.message ?? "Arama reddedildi.") : null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void search(query), 220);
    return () => clearTimeout(t);
  }, [query, search]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border border-line-strong px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-tone-3"
        aria-label="Ara (Ctrl+K)"
      >
        ara ⌘K
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Evrensel arama"
    >
      <div
        className="w-full max-w-2xl border border-line-strong bg-surface-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Sayfa, işlem veya kayıt ara: fatura, çek, kredi, banka, belge…"
          aria-label="Komut ve kayıt ara"
          className="field-control w-full border-0 border-b border-line-faint bg-transparent p-3 text-sm"
        />
        <div className="max-h-[60vh] overflow-y-auto">
          {quickCommands.length > 0 && (
            <div className="border-b border-line-faint">
              <div className="px-3 pt-2 font-mono text-[10px] uppercase tracking-wider text-tone-4">
                Hızlı geçiş ve işlemler
              </div>
              {quickCommands.map((cmd) => (
                <Link
                  key={`${cmd.href}-${cmd.label}`}
                  href={cmd.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {cmd.label}
                    <span className="ml-2 text-[10px] text-tone-4">{cmd.hint}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-tone-3" aria-hidden>→</span>
                </Link>
              ))}
            </div>
          )}

          {refused && (
            <p className="p-3 font-mono text-xs text-warn">{refused}</p>
          )}
          {!refused && loading && groups.length === 0 && (
            <p className="p-3 font-mono text-[11px] text-tone-4">aranıyor…</p>
          )}
          {!refused && !loading && query.trim().length >= 2 && groups.length === 0 && quickCommands.length === 0 && (
            <p className="p-3 font-mono text-[11px] text-tone-4">Sonuç yok.</p>
          )}
          {groups.map((group) => (
            <div key={group.key} className="border-b border-line-faint last:border-0">
              <div className="px-3 pt-2 font-mono text-[10px] uppercase tracking-wider text-tone-4">
                {group.label}
              </div>
              {group.hits.map((hit) => (
                <Link
                  key={`${hit.entityKey}-${hit.id}`}
                  href={hit.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{hit.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-tone-3">
                    {/* Unknown amount renders as empty/dash, never as 0 TL. */}
                    {hit.amount != null
                      ? formatMoney(hit.amount, hit.currency ?? "TRY", { minimumFractionDigits: 0, maximumFractionDigits: 0 })
                      : ""}{" "}
                    {hit.date ?? ""}
                  </span>
                </Link>
              ))}
            </div>
          ))}
        </div>
        <p className="border-t border-line-faint p-2 font-mono text-[10px] text-tone-4">
          Sonuçlar rolünüzün görebildikleriyle sınırlıdır — arama ayrıcalıklı bir bağlantı
          kullanmaz. Esc ile kapatın.
        </p>
      </div>
    </div>
  );
}
