"use client";

// Faz 35 — the ⌘K command palette.
//
// It renders whatever /api/search returns and nothing else. There is no client-side filtering of
// results, deliberately: filtering in the browser would imply the server had sent rows the user
// should not see, and the entire security design of this phase is that it never does.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface Hit {
  entityKey: string;
  entityLabel: string;
  id: string;
  title: string;
  amount: number | null;
  date: string | null;
  href: string;
}
interface Group { key: string; label: string; hits: Hit[] }

const tl = (n: number | null) =>
  n == null ? "—" : new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

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
      <button onClick={() => setOpen(true)}
        className="border border-line-strong px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-tone-3"
        aria-label="Ara (Ctrl+K)">
        ara ⌘K
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]"
         onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Evrensel arama">
      <div className="w-full max-w-2xl border border-line-strong bg-surface-1 shadow-xl"
           onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ara: fatura, çek, kredi, banka, belge… (örn. 'akon faturaları son 30 gün')"
          className="field-control w-full border-0 border-b border-line-faint bg-transparent p-3 text-sm"
        />
        <div className="max-h-[60vh] overflow-y-auto">
          {refused && (
            <p className="p-3 font-mono text-xs text-warn">{refused}</p>
          )}
          {!refused && loading && groups.length === 0 && (
            <p className="p-3 font-mono text-[11px] text-tone-4">aranıyor…</p>
          )}
          {!refused && !loading && query.trim().length >= 2 && groups.length === 0 && (
            <p className="p-3 font-mono text-[11px] text-tone-4">Sonuç yok.</p>
          )}
          {groups.map((group) => (
            <div key={group.key} className="border-b border-line-faint last:border-0">
              <div className="px-3 pt-2 font-mono text-[10px] uppercase tracking-wider text-tone-4">
                {group.label}
              </div>
              {group.hits.map((hit) => (
                <Link key={`${hit.entityKey}-${hit.id}`} href={hit.href}
                      onClick={() => setOpen(false)}
                      className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-surface-2">
                  <span className="min-w-0 flex-1 truncate text-xs">{hit.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-tone-3">
                    {/* Unknown amount renders as a dash, never as 0 TL. */}
                    {hit.amount != null ? tl(hit.amount) : ""} {hit.date ?? ""}
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
