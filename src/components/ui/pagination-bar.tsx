import Link from "@/components/ui/app-link";

export const DEFAULT_PAGE_SIZE = 50;

export interface ParsedPage {
  page: number;
  limit: number;
  offset: number;
}

export function parsePageParam(
  raw?: string | string[] | null,
  pageSize = DEFAULT_PAGE_SIZE,
): ParsedPage {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number.parseInt(String(first ?? "1"), 10);
  const page = Number.isFinite(parsed) && parsed >= 1 ? Math.min(100_000, parsed) : 1;
  const limit = Math.max(1, Math.min(200, Math.trunc(pageSize)));
  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

export function buildPageHref(
  basePath: string,
  targetPage: number,
  params?: Record<string, string | undefined>,
): string {
  const sp = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") {
        sp.set(k, v);
      }
    }
  }
  if (targetPage > 1) {
    sp.set("page", String(targetPage));
  }
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * Faz 8 — Server-side pagination bar.
 * Link labels strictly match tests/interaction/manifest.ts (`table/pagination`: /^(← Önceki|Sonraki →)$/).
 */
export function PaginationBar({
  basePath,
  page,
  pageSize = DEFAULT_PAGE_SIZE,
  totalCount,
  params,
}: {
  basePath: string;
  page: number;
  pageSize?: number;
  totalCount: number;
  params?: Record<string, string | undefined>;
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  if (totalCount <= pageSize && page <= 1) return null;

  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const fromRow = totalCount === 0 ? 0 : Math.min(totalCount, (page - 1) * pageSize + 1);
  const toRow = Math.min(totalCount, page * pageSize);

  return (
    <nav
      aria-label="Sayfalama"
      data-testid="pagination-bar"
      className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-faint pt-2.5 text-xs"
    >
      <span className="font-mono text-[11px] text-tone-3">
        {fromRow}–{toRow} / {totalCount} kayıt · Sayfa {page}/{totalPages}
      </span>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Link
            href={buildPageHref(basePath, page - 1, params)}
            className="button-ghost px-2.5 py-1 font-mono text-xs"
          >
            ← Önceki
          </Link>
        ) : (
          <span
            aria-disabled="true"
            className="border border-line-faint px-2.5 py-1 font-mono text-xs text-tone-4 opacity-50"
          >
            ← Önceki
          </span>
        )}
        {hasNext ? (
          <Link
            href={buildPageHref(basePath, page + 1, params)}
            className="button-ghost px-2.5 py-1 font-mono text-xs"
          >
            Sonraki →
          </Link>
        ) : (
          <span
            aria-disabled="true"
            className="border border-line-faint px-2.5 py-1 font-mono text-xs text-tone-4 opacity-50"
          >
            Sonraki →
          </span>
        )}
      </div>
    </nav>
  );
}

