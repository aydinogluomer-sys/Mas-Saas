"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import {
  activeFilterCount,
  DATE_PRESET_LABEL,
  DATE_PRESETS,
  describeFilters,
  type GlobalFilters,
} from "@/lib/ui/filters";
import {
  buildSavedViewHrefPreservingContext,
  extractPreservedContextParams,
  pickDefaultSavedView,
  type ModuleKey,
  type RawQueryParamMap,
  type SavedView,
} from "@/lib/ui/saved-views";
import { describeSelection, EMPTY_SELECTION, PAGE_SIZES } from "@/lib/ui/table";
import {
  applyDefaultSavedViewAction,
  applySavedViewAction,
  deleteSavedViewAction,
  saveCurrentViewAction,
} from "@/app/(dashboard)/saved-views-actions";

export interface SavedViewsBarProps {
  moduleKey: ModuleKey;
  basePath: string;
  views: SavedView[];
  currentFilters: GlobalFilters;
  todayISO: string;
  totalRows?: number;
  contextParams?: RawQueryParamMap;
}

function SavedViewsBarInner({
  moduleKey,
  basePath,
  views,
  currentFilters,
  todayISO,
  totalRows,
  mergedContext,
}: Omit<SavedViewsBarProps, "contextParams"> & {
  mergedContext: Record<string, string>;
}) {
  const count = activeFilterCount(currentFilters);
  const summary = describeFilters(currentFilters, todayISO);
  const returnPath = buildSavedViewHrefPreservingContext(basePath, mergedContext, currentFilters);
  const resetHref = buildSavedViewHrefPreservingContext(basePath, mergedContext, null);
  const defaultView = pickDefaultSavedView(views);
  const cleanPathname = (basePath.includes("?") ? basePath.slice(0, basePath.indexOf("?")) : basePath) || "/";
  const serializedContext = JSON.stringify(mergedContext);

  const scopeLabel = describeSelection(
    totalRows != null ? { ...EMPTY_SELECTION, allMatching: true } : EMPTY_SELECTION,
    totalRows ?? null,
  );

  const inputSurfaceStyle = {
    background: "var(--surface-1)",
    borderColor: "var(--line)",
    color: "var(--text-1)",
  } as const;

  return (
    <div
      style={{
        background: "var(--surface-1)",
        borderColor: "var(--line)",
      }}
      className="mb-3 border px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-wider text-tone-3">
            Kayıtlı Görünümler & Filtreler
          </span>
          <Badge tone={count > 0 ? "amber" : "neutral"}>{summary}</Badge>
          {totalRows != null && (
            <span className="font-mono text-[11px] text-tone-3">· {scopeLabel}</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <a
            href={resetHref}
            className={`border px-2 py-0.5 font-mono text-[11px] transition-colors ${
              count === 0
                ? "border-accent bg-accent/10 text-tone-1"
                : "border-line text-tone-2 hover:border-line-strong"
            }`}
          >
            Tümü (Varsayılan)
          </a>

          {defaultView && count === 0 ? (
            <form action={applyDefaultSavedViewAction} className="inline">
              <input type="hidden" name="module_key" value={moduleKey} />
              <input type="hidden" name="base_path" value={cleanPathname} />
              <input type="hidden" name="context_json" value={serializedContext} />
              <button
                type="submit"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--line)",
                  color: "var(--text-1)",
                }}
                className="border px-2 py-0.5 font-mono text-[11px] hover:border-accent"
                title={`Varsayılan görünümü uygula: ${describeFilters(defaultView.filters, todayISO)}`}
              >
                ★ Varsayılanı Uygula ({defaultView.name})
              </button>
            </form>
          ) : null}

          {views.map((v) => {
            const href = buildSavedViewHrefPreservingContext(basePath, mergedContext, v.filters);
            return (
              <div
                key={v.id}
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--line)",
                }}
                className="inline-flex items-center border"
              >
                <form action={applySavedViewAction} className="inline">
                  <input type="hidden" name="view_id" value={v.id} />
                  <input type="hidden" name="module_key" value={moduleKey} />
                  <input type="hidden" name="base_path" value={cleanPathname} />
                  <input type="hidden" name="context_json" value={serializedContext} />
                  <button
                    type="submit"
                    data-href={href}
                    className="px-2 py-0.5 font-mono text-[11px] text-tone-1 hover:text-accent"
                    title={describeFilters(v.filters, todayISO)}
                  >
                    {v.isDefault ? "★ " : ""}
                    {v.name}
                    {v.isShared ? " (paylaşılan)" : ""}
                  </button>
                </form>
                {v.isMine && (
                  <form action={deleteSavedViewAction} className="inline">
                    <input type="hidden" name="view_id" value={v.id} />
                    <input type="hidden" name="return_path" value={returnPath} />
                    <button
                      type="submit"
                      className="border-l border-line px-1.5 py-0.5 font-mono text-[10px] text-tone-3 hover:text-neg"
                      title="Görünümü sil"
                    >
                      ×
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <details className="mt-2 border-t border-line-faint pt-2">
        <summary className="cursor-pointer font-mono text-[11px] text-tone-2 hover:text-tone-1">
          Filtre uygula veya mevcut görünümü kaydet ({views.length} kayıtlı görünüm · sayfa boyutları:{" "}
          {PAGE_SIZES.join("/")})
        </summary>
        <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <form method="get" action={cleanPathname} className="flex flex-wrap items-end gap-2 border border-line p-2">
            {Object.entries(mergedContext).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <div>
              <label className="block font-mono text-[10px] uppercase text-tone-3">Tarih Aralığı</label>
              <select
                name="dp"
                defaultValue={currentFilters.datePreset}
                style={inputSurfaceStyle}
                className="mt-0.5 border px-2 py-1 font-mono text-xs"
              >
                {DATE_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {DATE_PRESET_LABEL[preset]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-mono text-[10px] uppercase text-tone-3">Para Birimi</label>
              <select
                name="cur"
                defaultValue={currentFilters.currency ?? ""}
                style={inputSurfaceStyle}
                className="mt-0.5 border px-2 py-1 font-mono text-xs"
              >
                <option value="">Tümü</option>
                <option value="TRY">TRY</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </div>
            <div className="min-w-40 flex-1">
              <label className="block font-mono text-[10px] uppercase text-tone-3">Metin Arama</label>
              <input
                type="text"
                name="q"
                defaultValue={currentFilters.q}
                placeholder="Ünvan, açıklama veya belge no..."
                style={inputSurfaceStyle}
                className="mt-0.5 w-full border px-2 py-1 font-mono text-xs"
              />
            </div>
            <button type="submit" className="button-ghost px-2.5 py-1 text-xs">
              Filtrele
            </button>
          </form>

          <form action={saveCurrentViewAction} className="flex flex-wrap items-end gap-2 border border-line p-2">
            <input type="hidden" name="module_key" value={moduleKey} />
            <input type="hidden" name="return_path" value={returnPath} />
            <input type="hidden" name="dp" value={currentFilters.datePreset} />
            <input type="hidden" name="df" value={currentFilters.dateFrom ?? ""} />
            <input type="hidden" name="dt" value={currentFilters.dateTo ?? ""} />
            <input type="hidden" name="cur" value={currentFilters.currency ?? ""} />
            <input type="hidden" name="q" value={currentFilters.q} />
            <div className="min-w-40 flex-1">
              <label className="block font-mono text-[10px] uppercase text-tone-3">Yeni Görünüm Adı</label>
              <input
                type="text"
                name="name"
                required
                maxLength={120}
                placeholder="Örn: USD Kritik Ödemeler"
                style={inputSurfaceStyle}
                className="mt-0.5 w-full border px-2 py-1 font-mono text-xs"
              />
            </div>
            <label className="flex items-center gap-1 font-mono text-[11px] text-tone-2">
              <input type="checkbox" name="is_default" /> Varsayılan
            </label>
            <label className="flex items-center gap-1 font-mono text-[11px] text-tone-2">
              <input type="checkbox" name="is_shared" /> Paylaş
            </label>
            <button type="submit" className="button-accent px-2.5 py-1 text-xs">
              Görünümü Kaydet
            </button>
          </form>
        </div>
      </details>
    </div>
  );
}

function SavedViewsBarWithUrl(props: SavedViewsBarProps) {
  const searchParams = useSearchParams();
  const baseQuery = props.basePath.includes("?")
    ? new URLSearchParams(props.basePath.slice(props.basePath.indexOf("?") + 1))
    : null;
  const mergedContext = {
    ...extractPreservedContextParams(baseQuery),
    ...extractPreservedContextParams(searchParams),
    ...extractPreservedContextParams(props.contextParams),
  };
  return <SavedViewsBarInner {...props} mergedContext={mergedContext} />;
}

export function SavedViewsBar(props: SavedViewsBarProps) {
  const baseQuery = props.basePath.includes("?")
    ? new URLSearchParams(props.basePath.slice(props.basePath.indexOf("?") + 1))
    : null;
  const fallbackContext = {
    ...extractPreservedContextParams(baseQuery),
    ...extractPreservedContextParams(props.contextParams),
  };
  return (
    <Suspense fallback={<SavedViewsBarInner {...props} mergedContext={fallbackContext} />}>
      <SavedViewsBarWithUrl {...props} />
    </Suspense>
  );
}

