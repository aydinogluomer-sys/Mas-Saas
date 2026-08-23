// Faz 36 — the table standard: pagination, sorting, selection.
//
// Pure. Every module's tables behaved slightly differently before this — some sorted client-side,
// some had no page size, some lost the sort on navigation. This module is the one definition, so
// "page 2 of the invoices table" and "page 2 of the payments table" mean the same thing.

import { z } from "zod";

export const PAGE_SIZES = [25, 50, 100, 250] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 50;

/**
 * Hard ceiling on rows per request.
 *
 * Not a UI nicety: an unbounded table is how a finance screen becomes a 200.000-row response that
 * times out for everyone. Faz 33 measured what large result sets cost; this is the same lesson
 * applied at the edge.
 */
export const MAX_ROWS_PER_REQUEST = 250;

export const tableStateSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.union([z.literal(25), z.literal(50), z.literal(100), z.literal(250)])
    .default(DEFAULT_PAGE_SIZE),
  sortKey: z.string().trim().max(64).nullable().default(null),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});
export type TableState = z.infer<typeof tableStateSchema>;

export const DEFAULT_TABLE_STATE: TableState = tableStateSchema.parse({});

export function parseTableState(
  params: URLSearchParams | Record<string, string | undefined>,
): TableState {
  const get = (k: string) =>
    params instanceof URLSearchParams ? params.get(k) ?? undefined : params[k];
  const parsed = tableStateSchema.safeParse({
    page: get("page") ? Number(get("page")) : undefined,
    pageSize: get("ps") ? Number(get("ps")) : undefined,
    sortKey: get("sk") ?? null,
    sortDir: get("sd"),
  });
  return parsed.success ? parsed.data : DEFAULT_TABLE_STATE;
}

export interface Page<T> {
  rows: T[];
  page: number;
  pageSize: number;
  /** Null when the caller did not count. Null is NOT zero — "unknown total" is a real state. */
  totalRows: number | null;
  totalPages: number | null;
  hasPrev: boolean;
  hasNext: boolean;
}

/** SQL offset/limit for a state. Clamped, so a hand-edited `?page=99999` cannot ask for the moon. */
export function pageBounds(state: TableState): { limit: number; offset: number } {
  const pageSize = Math.min(state.pageSize, MAX_ROWS_PER_REQUEST);
  return { limit: pageSize, offset: (Math.max(1, state.page) - 1) * pageSize };
}

export function buildPage<T>(rows: T[], state: TableState, totalRows: number | null): Page<T> {
  const pageSize = Math.min(state.pageSize, MAX_ROWS_PER_REQUEST);
  const totalPages = totalRows == null ? null : Math.max(1, Math.ceil(totalRows / pageSize));
  return {
    rows, page: state.page, pageSize, totalRows, totalPages,
    hasPrev: state.page > 1,
    // Without a total we can still tell there is a next page: a full page means there may be more.
    hasNext: totalPages == null ? rows.length === pageSize : state.page < totalPages,
  };
}

/**
 * Turn a requested sort key into a SAFE `order by` fragment.
 *
 * `allowed` is a whitelist of real column names supplied by the caller — the same discipline as
 * the Faz 35 search registry. A sort key is user input arriving from a query string, and the only
 * safe way to put it next to `order by` is to refuse anything that is not already known.
 *
 * The tiebreaker is not optional: `order by due_date desc` over rows sharing a date returns them
 * in whatever order the plan produced, so page 2 can repeat a row page 1 already showed. Appending
 * a unique column makes paging stable.
 */
export function orderByClause(
  state: TableState, allowed: Readonly<Record<string, string>>, tiebreaker = "id",
): string {
  const column = state.sortKey ? allowed[state.sortKey] : undefined;
  if (!column) return `order by ${tiebreaker} desc`;
  if (!/^[a-z_][a-z0-9_.]*$/.test(column) || !/^[a-z_][a-z0-9_.]*$/.test(tiebreaker)) {
    throw new Error(`orderByClause: güvenli olmayan kolon adı (${column})`);
  }
  const dir = state.sortDir === "asc" ? "asc" : "desc";
  // nulls last in both directions: an unknown amount is not the smallest amount, and letting it
  // sort to the top of an ascending list makes it look like one.
  return `order by ${column} ${dir} nulls last, ${tiebreaker} desc`;
}

/** Toggle helper for a column header click. */
export function nextSort(state: TableState, key: string): TableState {
  if (state.sortKey !== key) return { ...state, sortKey: key, sortDir: "desc", page: 1 };
  return { ...state, sortDir: state.sortDir === "desc" ? "asc" : "desc", page: 1 };
}

export function tableStateToParams(state: TableState): URLSearchParams {
  const p = new URLSearchParams();
  if (state.page !== 1) p.set("page", String(state.page));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) p.set("ps", String(state.pageSize));
  if (state.sortKey) { p.set("sk", state.sortKey); p.set("sd", state.sortDir); }
  return p;
}

/* ── bulk selection ─────────────────────────────────────────────────────────────────────── */

export interface BulkSelection {
  /** Explicitly ticked ids. */
  ids: readonly string[];
  /**
   * True when the user ticked "select all matching", which means rows they have not seen.
   *
   * Kept distinct from a full page of ticks on purpose: a bulk action over 12 visible rows and one
   * over 40.000 unseen rows are different decisions, and the confirmation must be able to say
   * which one is about to happen.
   */
  allMatching: boolean;
}

export const EMPTY_SELECTION: BulkSelection = { ids: [], allMatching: false };

export function selectionSize(selection: BulkSelection, totalRows: number | null): number | null {
  if (!selection.allMatching) return selection.ids.length;
  return totalRows; // null when unknown — and the UI must say "tümü" rather than invent a count.
}

/** Wording for the confirmation. Refuses to be vague about scope. */
export function describeSelection(selection: BulkSelection, totalRows: number | null): string {
  if (selection.allMatching) {
    return totalRows == null
      ? "Filtreye uyan TÜM kayıtlar (sayısı bilinmiyor)"
      : `Filtreye uyan ${totalRows} kaydın tamamı`;
  }
  return `Seçili ${selection.ids.length} kayıt`;
}
