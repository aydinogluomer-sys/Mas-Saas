import { Badge } from "@/components/ui/badge";
import {
  activeFilterCount,
  DATE_PRESET_LABEL,
  DATE_PRESETS,
  describeFilters,
  filtersToParams,
  type GlobalFilters,
} from "@/lib/ui/filters";
import { type ModuleKey, type SavedView } from "@/lib/ui/saved-views";
import { describeSelection, EMPTY_SELECTION, PAGE_SIZES } from "@/lib/ui/table";
import { deleteSavedViewAction, saveCurrentViewAction } from "@/app/(dashboard)/saved-views-actions";

export interface SavedViewsBarProps {
  moduleKey: ModuleKey;
  basePath: string;
  views: SavedView[];
  currentFilters: GlobalFilters;
  todayISO: string;
  totalRows?: number;
}

export function SavedViewsBar({
  moduleKey,
  basePath,
  views,
  currentFilters,
  todayISO,
  totalRows,
}: SavedViewsBarProps) {
  const count = activeFilterCount(currentFilters);
  const summary = describeFilters(currentFilters, todayISO);
  const currentQuery = filtersToParams(currentFilters).toString();
  const returnPath = currentQuery ? `${basePath}?${currentQuery}` : basePath;
  const scopeLabel = describeSelection(
    totalRows != null ? { ...EMPTY_SELECTION, allMatching: true } : EMPTY_SELECTION,
    totalRows ?? null,
  );

  return (
    <div className="mb-3 border border-line bg-surface px-3 py-2.5">
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
            href={basePath}
            className={`border px-2 py-0.5 font-mono text-[11px] transition-colors ${
              count === 0
                ? "border-accent bg-accent/10 text-tone-1"
                : "border-line text-tone-2 hover:border-line-strong"
            }`}
          >
            Tümü (Varsayılan)
          </a>
          {views.map((v) => {
            const qs = filtersToParams(v.filters).toString();
            const href = qs ? `${basePath}?${qs}` : basePath;
            return (
              <div key={v.id} className="inline-flex items-center border border-line bg-surface-2">
                <a
                  href={href}
                  className="px-2 py-0.5 font-mono text-[11px] text-tone-1 hover:text-accent"
                  title={describeFilters(v.filters, todayISO)}
                >
                  {v.isDefault ? "★ " : ""}
                  {v.name}
                  {v.isShared ? " (paylaşılan)" : ""}
                </a>
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
          <form method="get" action={basePath} className="flex flex-wrap items-end gap-2 border border-line p-2">
            <div>
              <label className="block font-mono text-[10px] uppercase text-tone-3">Tarih Aralığı</label>
              <select
                name="dp"
                defaultValue={currentFilters.datePreset}
                className="mt-0.5 border border-line bg-ink px-2 py-1 font-mono text-xs text-tone-1"
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
                className="mt-0.5 border border-line bg-ink px-2 py-1 font-mono text-xs text-tone-1"
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
                className="mt-0.5 w-full border border-line bg-ink px-2 py-1 font-mono text-xs text-tone-1"
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
                className="mt-0.5 w-full border border-line bg-ink px-2 py-1 font-mono text-xs text-tone-1"
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

