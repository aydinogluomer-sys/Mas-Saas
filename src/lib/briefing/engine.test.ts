/**
 * The briefing's cash tile judges cash against the floor of the SAME currency, and only against
 * a floor that is actually configured.
 *
 * rules.test.ts proves buildWidgets() answers correctly for a given minCashFloor. What it could not
 * see is which floor the engine handed it: gatherWidgetFacts took the first 7-day gap row with no
 * currency filter. loadLiquidityGap orders by currency, so with a EUR account that row was EUR's —
 * floor 0, because the view coalesces "no policy" to 0 — and TRY cash below a 1.000.000 TRY floor
 * was shown as a green "Taban korunuyor" next to a red liquidity tile. These tests run the real
 * engine over the loaders' row shapes; only the loaders themselves are replaced.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const loaders = vi.hoisted(() => ({
  loadPositionSummary: vi.fn(),
  loadLiquidityGap: vi.fn(),
  loadConfiguredFloorCurrencies: vi.fn(),
  loadWorkingCapital: vi.fn(),
  loadControlDashboard: vi.fn(),
  loadAlerts: vi.fn(),
  loadOpenPromises: vi.fn(),
  instancesOn: vi.fn(),
  overdueOpen: vi.fn(),
}));

vi.mock("@/lib/treasury/engine", () => ({
  loadPositionSummary: loaders.loadPositionSummary,
  loadLiquidityGap: loaders.loadLiquidityGap,
  loadConfiguredFloorCurrencies: loaders.loadConfiguredFloorCurrencies,
}));
vi.mock("@/lib/costing/engine", () => ({ loadWorkingCapital: loaders.loadWorkingCapital }));
vi.mock("@/lib/controls/engine", () => ({
  loadControlDashboard: loaders.loadControlDashboard,
  loadAlerts: loaders.loadAlerts,
}));
vi.mock("@/lib/collections/promises-engine", () => ({ loadOpenPromises: loaders.loadOpenPromises }));
vi.mock("@/lib/radar/queries", () => ({ instancesOn: loaders.instancesOn, overdueOpen: loaders.overdueOpen }));

import { loadBriefingDashboard, loadWidgetFacts } from "./engine";
import { renderBriefing } from "./rules";

const TODAY = "2099-03-01";

/** The five small aggregate queries gatherWidgetFacts issues itself; one neutral row serves all. */
const pool = {
  query: vi.fn(async () => ({ rows: [{ due30: "0", available: "0", drawn: "0", worst: null, n: 0, top: null }] })),
} as unknown as Pool;

function position(currency: string, availableNow: number) {
  return {
    currency, accountCount: 1, totalDerived: availableNow, totalStated: null, totalBlocked: 0,
    totalOverdraftLimit: 0, availableNow, availableWithOverdraft: availableNow, accountsWithGap: 0,
  };
}

/** One currency's 7/30/90 rows exactly as treasury_liquidity_gap computes them (0063). */
function gapRows(currency: string, availableNow: number, floor: number) {
  return [7, 30, 90].map((horizonDays) => ({
    horizonDays, currency, availableNow,
    contractedNetFlow: 0, expectedNetFlow: 0,
    projectedContracted: availableNow, projectedExpected: availableNow,
    minCashFloor: floor,
    financingNeed: Math.max(0, floor - availableNow),
    breachesFloor: availableNow < floor,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  loaders.loadWorkingCapital.mockResolvedValue(null);
  loaders.loadControlDashboard.mockResolvedValue([]);
  loaders.loadAlerts.mockResolvedValue([]);
  loaders.loadOpenPromises.mockResolvedValue([]);
  loaders.instancesOn.mockResolvedValue([]);
  loaders.overdueOpen.mockResolvedValue([]);
});

/**
 * TRY cash 600.000 against an admin-set TRY floor of 1.000.000, plus an active EUR account. EUR
 * has no policy, so its rows carry the view's coalesced floor of 0 — and sort BEFORE TRY.
 */
function eurAndBreachedTry() {
  loaders.loadPositionSummary.mockResolvedValue([position("EUR", 20_000), position("TRY", 600_000)]);
  loaders.loadLiquidityGap.mockResolvedValue([...gapRows("EUR", 20_000, 0), ...gapRows("TRY", 600_000, 1_000_000)]);
  loaders.loadConfiguredFloorCurrencies.mockResolvedValue(new Set(["TRY"]));
}

describe("brifing nakit kutusu — taban, nakdin KENDİ para biriminden", () => {
  it("EUR hesabı varken TRY tabanı delinmişse kutu kırmızı 'Taban … altında' der, 'Taban korunuyor' DEMEZ", async () => {
    eurAndBreachedTry();

    const { facts, widgets } = await loadBriefingDashboard(pool, TODAY);
    const cash = widgets.find((w) => w.key === "cash");

    expect(facts.availableCash).toBe(600_000);
    expect(facts.minCashFloor).toBe(1_000_000);
    expect(cash?.tone).toBe("neg");
    expect(cash?.note).toContain("altında");
    expect(cash?.note).not.toContain("korunuyor");
    // The tile, the liquidity figure and the briefing text now tell one story.
    expect(facts.liquidityGap7).toBe(400_000);
    expect(widgets.find((w) => w.key === "liquidity")?.tone).toBe("neg");
    expect(renderBriefing(facts)).toContain("Asgari kasa tabanı: 1.000.000 TL");
  });

  it("kokpit kutularının tabanı brifing gerçeğinin tabanıyla aynıdır (iki ayrı seçim yok)", async () => {
    eurAndBreachedTry();

    const widgetFacts = await loadWidgetFacts(pool, TODAY);

    expect(widgetFacts.minCashFloor).toBe(1_000_000);
    expect(widgetFacts.availableCash).toBe(600_000);
    // The tile no longer re-reads the gap rows on its own: one read, inside the briefing facts.
    expect(loaders.loadLiquidityGap).toHaveBeenCalledTimes(1);
  });
});

describe("brifing nakit kutusu — tanımlı taban yoksa hüküm de yok (Wave 0, R10)", () => {
  it("aktif asgari kasa politikası yoksa taban null: 'Taban tanımlı değil', briefing '—'", async () => {
    // The view still reports 0 for TRY (coalesce); only the policy table knows there is none.
    loaders.loadPositionSummary.mockResolvedValue([position("TRY", 600_000)]);
    loaders.loadLiquidityGap.mockResolvedValue(gapRows("TRY", 600_000, 0));
    loaders.loadConfiguredFloorCurrencies.mockResolvedValue(new Set());

    const { facts, widgets } = await loadBriefingDashboard(pool, TODAY);
    const cash = widgets.find((w) => w.key === "cash");

    expect(facts.minCashFloor).toBeNull();
    expect(cash?.value).toBe("600.000 TL");
    expect(cash?.tone).toBe("neutral");
    expect(cash?.note).toBe("Taban tanımlı değil");
    expect(renderBriefing(facts)).toContain("Asgari kasa tabanı: —");
  });

  it("bilerek 0 olan tanımlı taban bilinen bir tabandır (sıfır bilinmeyen değildir)", async () => {
    loaders.loadPositionSummary.mockResolvedValue([position("TRY", 600_000)]);
    loaders.loadLiquidityGap.mockResolvedValue(gapRows("TRY", 600_000, 0));
    loaders.loadConfiguredFloorCurrencies.mockResolvedValue(new Set(["TRY"]));

    const { facts, widgets } = await loadBriefingDashboard(pool, TODAY);

    expect(facts.minCashFloor).toBe(0);
    expect(widgets.find((w) => w.key === "cash")?.note).toBe("Taban korunuyor");
  });

  it("yalnız BAŞKA bir para biriminin politikası varsa TRY tabanı yine tanımsızdır", async () => {
    loaders.loadPositionSummary.mockResolvedValue([position("EUR", 20_000), position("TRY", 600_000)]);
    loaders.loadLiquidityGap.mockResolvedValue([...gapRows("EUR", 20_000, 5_000), ...gapRows("TRY", 600_000, 0)]);
    loaders.loadConfiguredFloorCurrencies.mockResolvedValue(new Set(["EUR"]));

    const { facts } = await loadBriefingDashboard(pool, TODAY);

    expect(facts.minCashFloor).toBeNull();
  });
});
