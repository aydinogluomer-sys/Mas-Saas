import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS, activeFilterCount, describeFilters, filtersToParams, globalFilterSchema,
  isEmptyFilters, parseFilters, resolveDateRange,
} from "./filters";
import {
  DEFAULT_TABLE_STATE, EMPTY_SELECTION, buildPage, describeSelection, nextSort,
  orderByClause, pageBounds, parseTableState, selectionSize, tableStateToParams,
} from "./table";

const TODAY = "2026-03-15";

describe("resolveDateRange", () => {
  it("resolves each preset to concrete bounds", () => {
    const at = (dp: string) => resolveDateRange(globalFilterSchema.parse({ datePreset: dp }), TODAY);
    expect(at("today")).toEqual({ from: "2026-03-15", to: "2026-03-15" });
    expect(at("last_7")).toEqual({ from: "2026-03-09", to: "2026-03-15" });
    expect(at("last_30").from).toBe("2026-02-14");
    expect(at("this_month")).toEqual({ from: "2026-03-01", to: "2026-03-15" });
    expect(at("this_year").from).toBe("2026-01-01");
  });

  it("returns NULL bounds for 'all', not a sentinel date", () => {
    // "since 1970" and "no lower bound" are different statements; only one is true.
    expect(resolveDateRange(EMPTY_FILTERS, TODAY)).toEqual({ from: null, to: null });
  });

  it("passes custom bounds through unchanged", () => {
    const f = globalFilterSchema.parse({ datePreset: "custom", dateFrom: "2026-01-01", dateTo: "2026-02-01" });
    expect(resolveDateRange(f, TODAY)).toEqual({ from: "2026-01-01", to: "2026-02-01" });
  });
});

describe("parseFilters", () => {
  it("round-trips through the query string", () => {
    const f = globalFilterSchema.parse({
      datePreset: "last_30", currency: "USD", q: "akon",
      // A real v4 UUID: Zod v4 checks the version and variant nibbles, so a row of 1s is REJECTED.
      // The first version of this test used one and failed — the schema was right, the fixture wrong.
      counterpartyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(parseFilters(filtersToParams(f))).toEqual(f);
  });

  it("keeps the VALID filters when ONE parameter in a shared link is broken", () => {
    // A colleague's link with one bad parameter must not silently blank every other choice.
    const parsed = parseFilters({ dp: "last_30", cur: "not-a-currency", q: "akon" });
    expect(parsed.datePreset).toBe("last_30");
    expect(parsed.q).toBe("akon");
    expect(parsed.currency).toBeNull();
  });

  it("rejects a non-uuid entity id rather than passing it to a query", () => {
    expect(parseFilters({ cp: "1; drop table invoices" }).counterpartyId).toBeNull();
  });

  it("omits defaults from the query string so a clean URL stays clean", () => {
    expect(filtersToParams(EMPTY_FILTERS).toString()).toBe("");
  });
});

describe("activeFilterCount / describeFilters", () => {
  it("counts only filters that narrow the view", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(isEmptyFilters(EMPTY_FILTERS)).toBe(true);
    expect(activeFilterCount(globalFilterSchema.parse({ datePreset: "last_7", currency: "TRY" }))).toBe(2);
  });

  it("says plainly when nothing is filtered", () => {
    expect(describeFilters(EMPTY_FILTERS, TODAY)).toContain("Filtre yok");
  });

  it("describes the active window, so an export can never look unfiltered", () => {
    const text = describeFilters(globalFilterSchema.parse({ datePreset: "last_7", currency: "USD" }), TODAY);
    expect(text).toContain("Son 7 gün");
    expect(text).toContain("2026-03-09");
    expect(text).toContain("USD");
  });
});

describe("table state", () => {
  it("falls back to defaults on rubbish input", () => {
    expect(parseTableState({ page: "-4", ps: "9999", sd: "sideways" })).toEqual(DEFAULT_TABLE_STATE);
  });

  it("round-trips", () => {
    const s = parseTableState({ page: "3", ps: "100", sk: "due_date", sd: "asc" });
    expect(parseTableState(tableStateToParams(s))).toEqual(s);
  });

  it("clamps the offset so a hand-edited page cannot ask for the moon", () => {
    expect(pageBounds({ ...DEFAULT_TABLE_STATE, page: 0 })).toEqual({ limit: 50, offset: 0 });
    expect(pageBounds({ ...DEFAULT_TABLE_STATE, page: 3, pageSize: 25 })).toEqual({ limit: 25, offset: 50 });
  });
});

describe("orderByClause", () => {
  const allowed = { due: "due_date", amount: "amount" };

  it("maps a whitelisted key to its real column", () => {
    expect(orderByClause({ ...DEFAULT_TABLE_STATE, sortKey: "due", sortDir: "asc" }, allowed))
      .toBe("order by due_date asc nulls last, id desc");
  });

  it("IGNORES a key that is not whitelisted", () => {
    // A sort key arrives from a query string; anything not already known is refused, not escaped.
    expect(orderByClause({ ...DEFAULT_TABLE_STATE, sortKey: "amount; drop table invoices" }, allowed))
      .toBe("order by id desc");
  });

  it("always appends a tiebreaker so paging cannot repeat a row", () => {
    expect(orderByClause({ ...DEFAULT_TABLE_STATE, sortKey: "due" }, allowed)).toContain(", id desc");
  });

  it("puts nulls last in BOTH directions", () => {
    for (const dir of ["asc", "desc"] as const) {
      expect(orderByClause({ ...DEFAULT_TABLE_STATE, sortKey: "amount", sortDir: dir }, allowed))
        .toContain("nulls last");
    }
  });

  it("throws if the whitelist itself contains something unsafe", () => {
    expect(() => orderByClause({ ...DEFAULT_TABLE_STATE, sortKey: "x" }, { x: "a; drop table t" }))
      .toThrow();
  });
});

describe("nextSort", () => {
  it("starts descending on a new column and then toggles", () => {
    const a = nextSort(DEFAULT_TABLE_STATE, "due");
    expect(a).toMatchObject({ sortKey: "due", sortDir: "desc", page: 1 });
    expect(nextSort(a, "due").sortDir).toBe("asc");
  });

  it("resets to page 1, so a re-sort cannot land on an empty page", () => {
    expect(nextSort({ ...DEFAULT_TABLE_STATE, page: 7 }, "due").page).toBe(1);
  });
});

describe("buildPage", () => {
  it("computes totals when the caller counted", () => {
    const p = buildPage([1, 2, 3], { ...DEFAULT_TABLE_STATE, page: 2, pageSize: 25 }, 60);
    expect(p.totalPages).toBe(3);
    expect(p.hasPrev).toBe(true);
    expect(p.hasNext).toBe(true);
  });

  it("keeps an UNKNOWN total as null rather than guessing zero", () => {
    const p = buildPage([1, 2], DEFAULT_TABLE_STATE, null);
    expect(p.totalRows).toBeNull();
    expect(p.totalPages).toBeNull();
  });

  it("infers hasNext from a full page when the total is unknown", () => {
    expect(buildPage(new Array(25).fill(0), { ...DEFAULT_TABLE_STATE, pageSize: 25 }, null).hasNext).toBe(true);
    expect(buildPage([1], { ...DEFAULT_TABLE_STATE, pageSize: 25 }, null).hasNext).toBe(false);
  });
});

describe("bulk selection", () => {
  it("distinguishes ticked rows from 'all matching'", () => {
    expect(selectionSize({ ids: ["a", "b"], allMatching: false }, 900)).toBe(2);
    expect(selectionSize({ ids: [], allMatching: true }, 900)).toBe(900);
  });

  it("says 'unknown' rather than inventing a count for an uncounted select-all", () => {
    expect(selectionSize({ ids: [], allMatching: true }, null)).toBeNull();
    expect(describeSelection({ ids: [], allMatching: true }, null)).toContain("bilinmiyor");
  });

  it("names the real scope in the confirmation wording", () => {
    expect(describeSelection(EMPTY_SELECTION, 10)).toContain("0");
    expect(describeSelection({ ids: [], allMatching: true }, 40000)).toContain("40000");
  });
});
