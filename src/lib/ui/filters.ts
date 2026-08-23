// Faz 36 — the global filter vocabulary, shared by every module.
//
// Pure: no database, no React, no LLM. Filters are a VALUE — parsed from a URL, validated, passed
// around, and saved. Keeping them out of component state is what makes a saved view possible at
// all: a filter that only exists inside a `useState` cannot be named, shared or linked to.
//
// THE URL IS THE SOURCE OF TRUTH. Every filter round-trips through the query string, so a
// filtered screen can be bookmarked, sent to a colleague, and reopened tomorrow showing the same
// question (against tomorrow's data). A filter held only in memory produces the classic support
// conversation where two people are looking at different numbers and neither can tell.

import { z } from "zod";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Named relative ranges, so "last 30 days" survives being saved and reopened next month. */
export const DATE_PRESETS = [
  "today", "last_7", "last_30", "last_90", "last_365", "this_month", "this_year", "custom", "all",
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const DATE_PRESET_LABEL: Record<DatePreset, string> = {
  today: "Bugün", last_7: "Son 7 gün", last_30: "Son 30 gün", last_90: "Son 90 gün",
  last_365: "Son 365 gün", this_month: "Bu ay", this_year: "Bu yıl",
  custom: "Özel aralık", all: "Tümü",
};

export const globalFilterSchema = z.object({
  datePreset: z.enum(DATE_PRESETS).default("all"),
  /** Only meaningful when datePreset is "custom". */
  dateFrom: z.string().regex(ISO_DAY).nullable().default(null),
  dateTo: z.string().regex(ISO_DAY).nullable().default(null),
  /** ISO 4217, uppercase. Null means "every currency", which is not the same as TRY. */
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  counterpartyId: z.string().uuid().nullable().default(null),
  costCenterId: z.string().uuid().nullable().default(null),
  projectId: z.string().uuid().nullable().default(null),
  /** Free-text narrowing, bound as a parameter by whoever runs the query. */
  q: z.string().trim().max(200).default(""),
});
export type GlobalFilters = z.infer<typeof globalFilterSchema>;

export const EMPTY_FILTERS: GlobalFilters = globalFilterSchema.parse({});

/**
 * Resolve a preset into concrete bounds.
 *
 * `today` is passed in rather than read from the clock so the result is testable and so every
 * caller in one request agrees on what "today" means — a page that resolves the date twice can
 * straddle midnight and show two different windows in the same render.
 */
export function resolveDateRange(
  filters: GlobalFilters, todayISO: string,
): { from: string | null; to: string | null } {
  const minus = (days: number) =>
    new Date(Date.parse(`${todayISO}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  switch (filters.datePreset) {
    case "today": return { from: todayISO, to: todayISO };
    case "last_7": return { from: minus(6), to: todayISO };
    case "last_30": return { from: minus(29), to: todayISO };
    case "last_90": return { from: minus(89), to: todayISO };
    case "last_365": return { from: minus(364), to: todayISO };
    case "this_month": return { from: `${todayISO.slice(0, 7)}-01`, to: todayISO };
    case "this_year": return { from: `${todayISO.slice(0, 4)}-01-01`, to: todayISO };
    case "custom": return { from: filters.dateFrom, to: filters.dateTo };
    case "all":
    default:
      // Null, not a sentinel like 1970-01-01: "no lower bound" and "since 1970" are different
      // statements, and only one of them is true.
      return { from: null, to: null };
  }
}

/** Parse filters out of a URL query string, discarding anything invalid rather than throwing. */
export function parseFilters(params: URLSearchParams | Record<string, string | undefined>): GlobalFilters {
  const get = (k: string) =>
    params instanceof URLSearchParams ? params.get(k) ?? undefined : params[k];
  const raw = {
    datePreset: get("dp"), dateFrom: get("df") ?? null, dateTo: get("dt") ?? null,
    currency: get("cur") ?? null, counterpartyId: get("cp") ?? null,
    costCenterId: get("cc") ?? null, projectId: get("pr") ?? null, q: get("q"),
  };
  // safeParse per field would be verbose; instead try the whole object and fall back field-wise,
  // so ONE bad parameter in a shared link does not blank every other filter the sender chose.
  const whole = globalFilterSchema.safeParse(raw);
  if (whole.success) return whole.data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const single = globalFilterSchema.pick({ [key]: true } as never).safeParse({ [key]: value });
    if (single.success) Object.assign(out, single.data);
  }
  return globalFilterSchema.parse(out);
}

/** Serialise back to a query string. Defaults are omitted, so a clean URL stays clean. */
export function filtersToParams(filters: GlobalFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.datePreset !== "all") p.set("dp", filters.datePreset);
  if (filters.dateFrom) p.set("df", filters.dateFrom);
  if (filters.dateTo) p.set("dt", filters.dateTo);
  if (filters.currency) p.set("cur", filters.currency);
  if (filters.counterpartyId) p.set("cp", filters.counterpartyId);
  if (filters.costCenterId) p.set("cc", filters.costCenterId);
  if (filters.projectId) p.set("pr", filters.projectId);
  if (filters.q) p.set("q", filters.q);
  return p;
}

export function isEmptyFilters(filters: GlobalFilters): boolean {
  return filters.datePreset === "all" && filters.currency == null
    && filters.counterpartyId == null && filters.costCenterId == null
    && filters.projectId == null && filters.q === "";
}

/** How many filters are actually narrowing the view — the number a badge shows. */
export function activeFilterCount(filters: GlobalFilters): number {
  let n = 0;
  if (filters.datePreset !== "all") n++;
  if (filters.currency) n++;
  if (filters.counterpartyId) n++;
  if (filters.costCenterId) n++;
  if (filters.projectId) n++;
  if (filters.q) n++;
  return n;
}

/**
 * A human sentence describing the active filters.
 *
 * Shown above every filtered table, and included in every export. An exported spreadsheet that
 * does not say it was filtered is the single easiest way to circulate a wrong total: the
 * recipient sees "Toplam" and has no idea it covers one cost centre and one quarter.
 */
export function describeFilters(filters: GlobalFilters, todayISO: string): string {
  if (isEmptyFilters(filters)) return "Filtre yok — tüm kayıtlar";
  const parts: string[] = [];
  if (filters.datePreset !== "all") {
    const range = resolveDateRange(filters, todayISO);
    parts.push(`${DATE_PRESET_LABEL[filters.datePreset]}` +
      (range.from || range.to ? ` (${range.from ?? "…"} → ${range.to ?? "…"})` : ""));
  }
  if (filters.currency) parts.push(`Para birimi: ${filters.currency}`);
  if (filters.counterpartyId) parts.push("Karşı taraf filtresi");
  if (filters.costCenterId) parts.push("Masraf merkezi filtresi");
  if (filters.projectId) parts.push("Proje filtresi");
  if (filters.q) parts.push(`Metin: "${filters.q}"`);
  return parts.join(" · ");
}
