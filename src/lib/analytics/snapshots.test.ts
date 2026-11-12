import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/data-quality/engine", () => ({
  loadDataQualityCenter: vi.fn(async () => ({
    decisionConfidence: 90,
    openReviewCount: 0,
    highOpenCount: 0,
    missingAmountCount: 0,
    externalPendingCount: 0,
  })),
}));

const loadCashMonthsMock = vi.fn();
vi.mock("@/lib/cashflow/engine", () => ({
  loadCashMonths: (...args: unknown[]) => loadCashMonthsMock(...args),
}));

vi.mock("@/lib/financing/engine", () => ({
  loadLoans: vi.fn(async () => []),
  loadMaturityItems: vi.fn(async () => []),
}));

vi.mock("@/lib/production/engine", () => ({
  loadPartProfitability: vi.fn(async () => []),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
}));

import { collectMetricSnapshots, writeMetricSnapshotsWithClient } from "./snapshots";

function makeFakeClient() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [] };
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { client, queries };
}

describe("metric snapshots — metric_snapshots_check invariant", () => {
  it("emits valueText='none' for cash_first_negative when all months have positive closings and zero unknowns", async () => {
    loadCashMonthsMock.mockResolvedValueOnce([
      { month: "2026-11", opening: 1000, inflow: 500, outflow: 200, net: 300, closing: 1300 },
      { month: "2026-12", opening: 1300, inflow: 400, outflow: 100, net: 300, closing: 1600 },
    ]);

    const { client } = makeFakeClient();
    const items = await collectMetricSnapshots(client, "2026-11-12");
    const firstNeg = items.find((i) => i.metricKey === "cash_first_negative");

    expect(firstNeg).toBeDefined();
    expect(firstNeg?.unknownCount).toBe(0);
    expect(firstNeg?.valueNumeric ?? null).toBeNull();
    expect(firstNeg?.valueText).toBe("none");
  });

  it("emits valueText='no_data' for cash_first_negative when cashflow_months is empty", async () => {
    loadCashMonthsMock.mockResolvedValueOnce([]);

    const { client } = makeFakeClient();
    const items = await collectMetricSnapshots(client, "2026-11-12");
    const firstNeg = items.find((i) => i.metricKey === "cash_first_negative");

    expect(firstNeg?.unknownCount).toBe(0);
    expect(firstNeg?.valueNumeric ?? null).toBeNull();
    expect(firstNeg?.valueText).toBe("no_data");
  });

  it("falls back to value_text='no_data' without fabricating numeric zero when numeric, text, and unknownCount are all empty", async () => {
    const { client, queries } = makeFakeClient();

    await writeMetricSnapshotsWithClient(
      client,
      "2026-11-12",
      [
        { metricKey: "part_margin_average", valueNumeric: null, valueText: null, unknownCount: 0, confidence: "high" },
        { metricKey: "part_margin_min", valueNumeric: null, valueText: null, unknownCount: 2, confidence: "medium" },
      ],
      "actor-1",
    );

    expect(queries).toHaveLength(2);
    // ($1 date, $2 metric_key, $3 dimension_key, $4 value_numeric, $5 value_text, $6 unknown_count, ...)
    expect(queries[0].params[3]).toBeNull();
    expect(queries[0].params[4]).toBe("no_data");
    expect(queries[0].params[5]).toBe(0);

    // When unknownCount > 0, metric_snapshots_check is already satisfied; keep value_text null.
    expect(queries[1].params[3]).toBeNull();
    expect(queries[1].params[4]).toBeNull();
    expect(queries[1].params[5]).toBe(2);
  });
});

