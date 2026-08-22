import { describe, expect, it } from "vitest";
import { heatmapModel, treemapModel, waterfallModel } from "./chart-types";
import { buildStamp, sameComputation, stableDigest } from "./reproducibility";

const base = { title: "T", description: "D", asOf: "2026-03-31", sourceLabel: "test" } as const;

describe("waterfallModel", () => {
  it("floats movement bars between running totals", () => {
    const m = waterfallModel({
      ...base, format: "currency",
      steps: [
        { key: "s", label: "Start", value: 100, kind: "start" },
        { key: "a", label: "A", value: 50, kind: "increase" },
        { key: "b", label: "B", value: -30, kind: "decrease" },
        { key: "e", label: "End", value: 120, kind: "end" },
      ],
    });
    const a = m.bars.find((b) => b.key === "a");
    expect(a?.from).toBe(100);
    expect(a?.to).toBe(150);
    const b = m.bars.find((x) => x.key === "b");
    expect(b?.from).toBe(120);
    expect(b?.to).toBe(150);
  });

  it("always includes zero in the axis range", () => {
    // An axis that excludes the baseline exaggerates every bar.
    const m = waterfallModel({
      ...base, format: "currency",
      steps: [{ key: "s", label: "S", value: 500, kind: "start" }],
    });
    expect(m.min).toBeLessThanOrEqual(0);
    expect(m.max).toBeGreaterThanOrEqual(500);
  });

  it("tones increases and decreases differently", () => {
    const m = waterfallModel({
      ...base, format: "currency",
      steps: [
        { key: "s", label: "S", value: 0, kind: "start" },
        { key: "up", label: "U", value: 10, kind: "increase" },
        { key: "dn", label: "D", value: -10, kind: "decrease" },
      ],
    });
    expect(m.bars.find((b) => b.key === "up")?.tone).toBe("positive");
    expect(m.bars.find((b) => b.key === "dn")?.tone).toBe("negative");
  });
});

describe("heatmapModel", () => {
  it("normalises intensity across the known range", () => {
    const m = heatmapModel({
      ...base, format: "count",
      rows: [{ key: "r1", label: "R1" }],
      columns: [{ key: "c1", label: "C1" }, { key: "c2", label: "C2" }],
      values: [
        { rowKey: "r1", columnKey: "c1", value: 0 },
        { rowKey: "r1", columnKey: "c2", value: 10 },
      ],
    });
    expect(m.cells.find((c) => c.columnKey === "c1")?.intensity).toBe(0);
    expect(m.cells.find((c) => c.columnKey === "c2")?.intensity).toBe(1);
  });

  it("gives a missing cell a NULL intensity, not the coldest colour", () => {
    // The coldest colour means "smallest value"; painting missing data that way asserts a fact.
    const m = heatmapModel({
      ...base, format: "count",
      rows: [{ key: "r1", label: "R1" }],
      columns: [{ key: "c1", label: "C1" }, { key: "c2", label: "C2" }],
      values: [{ rowKey: "r1", columnKey: "c1", value: 5 }],
    });
    const missing = m.cells.find((c) => c.columnKey === "c2");
    expect(missing?.value).toBeNull();
    expect(missing?.intensity).toBeNull();
    expect(m.unknownCount).toBe(1);
  });

  it("maps a flat grid to mid-scale instead of inventing a hottest cell", () => {
    const m = heatmapModel({
      ...base, format: "count",
      rows: [{ key: "r", label: "R" }],
      columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      values: [
        { rowKey: "r", columnKey: "a", value: 7 },
        { rowKey: "r", columnKey: "b", value: 7 },
      ],
    });
    expect(m.cells.every((c) => c.intensity === 0.5)).toBe(true);
  });

  it("produces exactly rows x columns cells", () => {
    const m = heatmapModel({
      ...base, format: "count",
      rows: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      columns: [{ key: "x", label: "X" }, { key: "y", label: "Y" }, { key: "z", label: "Z" }],
      values: [],
    });
    expect(m.cells).toHaveLength(6);
  });
});

describe("treemapModel", () => {
  const items = [
    { key: "a", label: "A", value: 50 },
    { key: "b", label: "B", value: 30 },
    { key: "c", label: "C", value: 20 },
  ];

  it("tiles the unit square exactly — total area is 1", () => {
    const m = treemapModel({ ...base, format: "currency", items });
    const area = m.tiles.reduce((s, t) => s + t.width * t.height, 0);
    expect(area).toBeCloseTo(1, 9);
  });

  it("gives each tile an area proportional to its share", () => {
    const m = treemapModel({ ...base, format: "currency", items });
    for (const t of m.tiles) expect(t.width * t.height).toBeCloseTo(t.share, 9);
  });

  it("produces tiles that do not overlap", () => {
    const m = treemapModel({ ...base, format: "currency", items });
    for (let i = 0; i < m.tiles.length; i++) {
      for (let j = i + 1; j < m.tiles.length; j++) {
        const a = m.tiles[i], b = m.tiles[j];
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(1e-9);
      }
    }
  });

  it("keeps every tile inside the unit square", () => {
    const m = treemapModel({ ...base, format: "currency", items });
    for (const t of m.tiles) {
      expect(t.x).toBeGreaterThanOrEqual(-1e-9);
      expect(t.y).toBeGreaterThanOrEqual(-1e-9);
      expect(t.x + t.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(t.y + t.height).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("collapses a long tail into one honest 'other' tile", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: `K${i}`, value: 30 - i }));
    const m = treemapModel({ ...base, format: "currency", items: many, maxTiles: 5 });
    expect(m.tiles).toHaveLength(5);
    expect(m.tiles.some((t) => t.key === "__other")).toBe(true);
    expect(m.tiles.reduce((s, t) => s + t.width * t.height, 0)).toBeCloseTo(1, 9);
  });

  it("REFUSES negative values — area cannot represent a negative quantity", () => {
    expect(() => treemapModel({
      ...base, format: "currency", items: [{ key: "a", label: "A", value: -5 }],
    })).toThrow();
  });

  it("counts unknown values and leaves them out of the layout", () => {
    const m = treemapModel({
      ...base, format: "currency",
      items: [{ key: "a", label: "A", value: 10 }, { key: "b", label: "B", value: null }],
    });
    expect(m.unknownCount).toBe(1);
    expect(m.tiles).toHaveLength(1);
  });

  it("returns no tiles rather than dividing by zero on an empty total", () => {
    const m = treemapModel({ ...base, format: "currency", items: [] });
    expect(m.tiles).toHaveLength(0);
    expect(m.total).toBe(0);
  });
});

describe("reproducibility stamp", () => {
  const input = { rowCounts: { invoices: 10 }, asOf: "2026-03-31", sourceCutoff: null };

  it("is identical for the same computation at different clock times", () => {
    // The clock must not enter the digest, or every run looks like a different computation.
    const a = buildStamp("pareto_concentration", input, "2026-03-31T08:00:00Z");
    const b = buildStamp("pareto_concentration", input, "2026-04-01T22:15:00Z");
    expect(sameComputation(a, b)).toBe(true);
  });

  it("changes when the inputs change", () => {
    const a = buildStamp("pareto_concentration", input, "2026-03-31T08:00:00Z");
    const b = buildStamp("pareto_concentration",
      { ...input, rowCounts: { invoices: 11 } }, "2026-03-31T08:00:00Z");
    expect(sameComputation(a, b)).toBe(false);
  });

  it("carries lineage and a version fingerprint", () => {
    const s = buildStamp("working_capital_decomposition", input, "2026-03-31T08:00:00Z");
    expect(s.lineage).toContain("working_capital_metrics");
    expect(s.versionFingerprint).toContain("dso_days@1");
  });

  it("digests deterministically regardless of key order", () => {
    const a = buildStamp("cash_bridge",
      { rowCounts: { a: 1, b: 2 }, asOf: "2026-01-01", sourceCutoff: null }, "t");
    const b = buildStamp("cash_bridge",
      { rowCounts: { b: 2, a: 1 }, asOf: "2026-01-01", sourceCutoff: null }, "t");
    expect(a.digest).toBe(b.digest);
  });

  it("stableDigest is stable and differs for different input", () => {
    expect(stableDigest("abc")).toBe(stableDigest("abc"));
    expect(stableDigest("abc")).not.toBe(stableDigest("abd"));
    expect(stableDigest("")).toHaveLength(8);
  });
});
