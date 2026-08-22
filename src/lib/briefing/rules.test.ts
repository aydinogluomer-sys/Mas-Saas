import { describe, expect, it } from "vitest";
import { headline, renderBriefing, summariseDay, todaysActions, type BriefingFacts } from "./rules";
import { buildWidgets, widgetsNeedingAttention, type CockpitWidgetFacts } from "@/lib/home/cockpit";

const base: BriefingFacts = {
  todayISO: "2099-03-01",
  availableCash: 500000,
  minCashFloor: 100000,
  liquidityGap7: 0,
  liquidityGap30: 0,
  projectedContracted7: 500000,
  todayOutflowKnown: 0,
  todayInflowKnown: 0,
  todayCount: 0,
  todayUnknownAmountCount: 0,
  overdueCount: 0,
  overdueKnownOutflow: 0,
  criticalControls: [],
  openAlertCount: 0,
  newCriticalAlerts: [],
  promisesDueToday: 0,
  overduePromises: 0,
  dsoDays: 60,
  dpoDays: 30,
  cycleExcludingInventory: 30,
};

describe("summariseDay — unknown amounts stay visible", () => {
  it("counts an unknown amount separately instead of adding zero", () => {
    // "40.000 TL today" and "40.000 TL plus one of unknown size" are different briefings.
    const s = summariseDay([
      { amount: 30000, direction: "outflow" },
      { amount: 10000, direction: "outflow" },
      { amount: null, direction: "outflow" },
    ]);
    expect(s.knownOutflow).toBe(40000);
    expect(s.unknownCount).toBe(1);
  });

  it("separates inflow from outflow", () => {
    const s = summariseDay([
      { amount: 100, direction: "inflow" },
      { amount: 250, direction: "outflow" },
    ]);
    expect(s.knownInflow).toBe(100);
    expect(s.knownOutflow).toBe(250);
  });

  it("treats a missing direction as outflow (the conservative reading)", () => {
    expect(summariseDay([{ amount: 500 }]).knownOutflow).toBe(500);
  });

  it("accumulates in decimal", () => {
    const rows = Array.from({ length: 300 }, () => ({ amount: "0.01", direction: "outflow" }));
    expect(summariseDay(rows).knownOutflow).toBe(3);
  });
});

describe("headline — fixed priority, predictable", () => {
  it("puts a liquidity gap above everything else", () => {
    const h = headline({ ...base, liquidityGap7: 250000, criticalControls: ["x"], overdueCount: 9 });
    expect(h.text).toContain("likidite açığı");
    expect(h.tone).toBe("neg");
  });

  it("puts critical controls above overdue items", () => {
    const h = headline({ ...base, criticalControls: ["Yinelenen fatura"], overdueCount: 9 });
    expect(h.text).toContain("kritik kontrol");
  });

  it("reports cash below the floor when nothing worse is happening", () => {
    const h = headline({ ...base, availableCash: 50000, minCashFloor: 100000 });
    expect(h.text).toContain("tabanının altında");
  });

  it("falls through to overdue, then today, then all-clear", () => {
    expect(headline({ ...base, overdueCount: 3 }).text).toContain("gecikmiş");
    expect(headline({ ...base, todayCount: 2 }).text).toContain("Bugün");
    expect(headline(base).tone).toBe("pos");
  });

  it("does not claim a floor breach when the floor is unknown", () => {
    // NULL floor must not be read as zero, which would make any positive cash look compliant —
    // or any cash look breaching, depending on the comparison.
    expect(headline({ ...base, availableCash: 10, minCashFloor: null }).tone).toBe("pos");
  });
});

describe("todaysActions", () => {
  it("only lists triggered items", () => {
    expect(todaysActions(base)).toEqual([]);
  });

  it("caps the list so a briefing stays actionable", () => {
    const many = {
      ...base, liquidityGap7: 1, overdueCount: 1, overduePromises: 1,
      todayUnknownAmountCount: 1, promisesDueToday: 1,
      newCriticalAlerts: ["a", "b", "c", "d"],
    };
    expect(todaysActions(many)).toHaveLength(5);
  });

  it("names the missing-amount problem explicitly", () => {
    const a = todaysActions({ ...base, todayUnknownAmountCount: 2 });
    expect(a.some((x) => x.includes("tutarı eksik"))).toBe(true);
  });
});

describe("renderBriefing", () => {
  it("renders every section", () => {
    const md = renderBriefing(base);
    for (const s of ["Nakit", "Bugün", "Gecikmiş", "Kontroller", "İşletme sermayesi", "Bugünün aksiyonları"]) {
      expect(md).toContain(s);
    }
  });

  it("renders an unknown figure as — rather than 0 TL", () => {
    const md = renderBriefing({ ...base, availableCash: null, dsoDays: null });
    expect(md).toContain("Kullanılabilir nakit: —");
    expect(md).toContain("DSO: —");
    expect(md).not.toContain("Kullanılabilir nakit: 0 TL");
  });

  it("says the totals are incomplete when an amount is missing", () => {
    const md = renderBriefing({ ...base, todayCount: 3, todayUnknownAmountCount: 1 });
    expect(md).toContain("Tutarı bilinmeyen");
    expect(md).toContain("toplamlar eksik");
  });

  it("names the cycle for what it excludes", () => {
    expect(renderBriefing(base)).toContain("envanter hariç");
  });

  it("is deterministic — same facts, same text", () => {
    expect(renderBriefing(base)).toBe(renderBriefing(base));
  });
});

/* ── cockpit widgets ─────────────────────────────────────────────────────────────────── */

const wf: CockpitWidgetFacts = {
  availableCash: 500000, minCashFloor: 100000,
  liquidityGap7: 0, liquidityGap30: 0,
  receivablesOpen: 200000, payablesOpen: 150000, dsoDays: 60, dpoDays: 30,
  netDebt: 0, facilityAvailable: 1000000, debtDue30: 0,
  fxWorstCase20: null,
  budgetVarianceOverCount: 0,
  cycleExcludingInventory: 30,
  criticalControlCount: 0, openAlertCount: 0,
  topConcentrationRatio: 0.2,
};

describe("buildWidgets — unknown is rendered, never zeroed", () => {
  it("shows — and a reason when a value is unknown", () => {
    const w = buildWidgets({ ...wf, availableCash: null });
    const cash = w.find((x) => x.key === "cash");
    expect(cash?.value).toBe("—");
    expect(cash?.tone).toBe("neutral");
    expect(cash?.note.length).toBeGreaterThan(0);
  });

  it("flags cash below the configured floor", () => {
    const cash = buildWidgets({ ...wf, availableCash: 50000 }).find((x) => x.key === "cash");
    expect(cash?.tone).toBe("neg");
  });

  it("does not flag a floor breach when the floor is unknown", () => {
    const cash = buildWidgets({ ...wf, availableCash: 1, minCashFloor: null }).find((x) => x.key === "cash");
    expect(cash?.tone).toBe("pos");
  });

  it("treats a liquidity gap as bad news and no gap as good", () => {
    expect(buildWidgets({ ...wf, liquidityGap7: 5000 }).find((x) => x.key === "liquidity")?.tone).toBe("neg");
    expect(buildWidgets(wf).find((x) => x.key === "liquidity")?.tone).toBe("pos");
  });

  it("always produces one tile per widget key, unknown or not", () => {
    const full = buildWidgets(wf);
    const empty = buildWidgets({
      availableCash: null, minCashFloor: null, liquidityGap7: null, liquidityGap30: null,
      receivablesOpen: null, payablesOpen: null, dsoDays: null, dpoDays: null,
      netDebt: null, facilityAvailable: null, debtDue30: null, fxWorstCase20: null,
      budgetVarianceOverCount: null, cycleExcludingInventory: null,
      criticalControlCount: 0, openAlertCount: 0, topConcentrationRatio: null,
    });
    expect(empty.map((x) => x.key)).toEqual(full.map((x) => x.key));
  });

  it("names the cycle tile for what it omits", () => {
    expect(buildWidgets(wf).find((x) => x.key === "ccc")?.note).toContain("Envanter verisi yok");
  });
});

describe("widgetsNeedingAttention", () => {
  it("returns only warn/neg tiles, worst first", () => {
    const w = buildWidgets({ ...wf, liquidityGap7: 5000, budgetVarianceOverCount: 2 });
    const a = widgetsNeedingAttention(w);
    expect(a.every((x) => x.tone === "neg" || x.tone === "warn")).toBe(true);
    expect(a[0].tone).toBe("neg");
  });

  it("is empty when everything is fine", () => {
    expect(widgetsNeedingAttention(buildWidgets(wf))).toEqual([]);
  });

  it("is deterministic for equal tones (key tiebreak)", () => {
    const w = buildWidgets({ ...wf, budgetVarianceOverCount: 1, debtDue30: 5 });
    expect(widgetsNeedingAttention(w).map((x) => x.key))
      .toEqual(widgetsNeedingAttention([...w].reverse()).map((x) => x.key));
  });
});
