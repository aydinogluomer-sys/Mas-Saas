import { describe, expect, it } from "vitest";
import {
  ANALYSES, DIMENSIONS, METRICS, RegistryError,
  analysisVersionFingerprint, dependentsOf, lineageOf, resolveDependencies, topologicalOrder,
} from "./registry";

describe("registry integrity", () => {
  it("every metric id matches its key", () => {
    for (const [key, def] of Object.entries(METRICS)) expect(def.id).toBe(key);
    for (const [key, def] of Object.entries(DIMENSIONS)) expect(def.id).toBe(key);
    for (const [key, def] of Object.entries(ANALYSES)) expect(def.id).toBe(key);
  });

  it("every declared dependency exists — no dangling edges", () => {
    for (const def of Object.values(METRICS)) {
      for (const dep of def.dependsOn) expect(METRICS[dep], `${def.id} -> ${dep}`).toBeDefined();
    }
  });

  it("every analysis input is a real metric", () => {
    for (const analysis of Object.values(ANALYSES)) {
      for (const input of analysis.inputs) {
        expect(METRICS[input], `${analysis.id} <- ${input}`).toBeDefined();
      }
    }
  });

  it("keeps the first slice deliberately small (5-8 analyses, not ~40)", () => {
    const count = Object.keys(ANALYSES).length;
    expect(count).toBeGreaterThanOrEqual(5);
    expect(count).toBeLessThanOrEqual(8);
  });

  it("every metric declares a calculation version and lineage", () => {
    for (const def of Object.values(METRICS)) {
      expect(def.calculationVersion).toBeGreaterThanOrEqual(1);
      expect(def.lineage.owningPhase.length).toBeGreaterThan(0);
    }
  });

  it("records DIO as a real metric with no sources, so its absence is visible", () => {
    // Deleting dio_days would make DSO − DPO look like the full cash conversion cycle.
    expect(METRICS.dio_days).toBeDefined();
    expect(METRICS.dio_days.nullable).toBe(true);
    expect(METRICS.dio_days.lineage.sources).toHaveLength(0);
  });
});

describe("resolveDependencies", () => {
  it("returns dependencies before dependents", () => {
    const order = resolveDependencies("dso_days");
    expect(order.indexOf("receivables_open")).toBeLessThan(order.indexOf("dso_days"));
    expect(order.indexOf("sales_365")).toBeLessThan(order.indexOf("dso_days"));
  });

  it("resolves transitively", () => {
    const order = resolveDependencies("cash_cycle_days");
    expect(order).toContain("receivables_open");
    expect(order).toContain("purchases_365");
    expect(order[order.length - 1]).toBe("cash_cycle_days");
  });

  it("throws on an unknown id rather than returning an empty list", () => {
    // Silently returning [] would let a typo look like a metric with no dependencies.
    expect(() => resolveDependencies("no_such_metric")).toThrow(RegistryError);
  });

  it("has no cycles anywhere in the registry", () => {
    for (const id of Object.keys(METRICS)) expect(() => resolveDependencies(id)).not.toThrow();
  });
});

describe("topologicalOrder", () => {
  it("lists every metric exactly once", () => {
    const order = topologicalOrder();
    expect(new Set(order).size).toBe(order.length);
    expect(new Set(order)).toEqual(new Set(Object.keys(METRICS)));
  });

  it("places every dependency before its dependent", () => {
    const order = topologicalOrder();
    for (const def of Object.values(METRICS)) {
      for (const dep of def.dependsOn) {
        expect(order.indexOf(dep)).toBeLessThan(order.indexOf(def.id));
      }
    }
  });
});

describe("dependentsOf", () => {
  it("finds the blast radius of a change", () => {
    const dependents = dependentsOf("receivables_open");
    expect(dependents).toContain("dso_days");
    expect(dependents).toContain("cash_cycle_days"); // transitive
    expect(dependents).not.toContain("receivables_open");
  });
});

describe("lineageOf", () => {
  it("names the real source tables behind an analysis", () => {
    expect(lineageOf("working_capital_decomposition")).toContain("working_capital_metrics");
    expect(lineageOf("pareto_concentration")).toContain("invoices");
  });

  it("is sorted and deduplicated", () => {
    const l = lineageOf("working_capital_decomposition");
    expect([...l].sort()).toEqual(l);
    expect(new Set(l).size).toBe(l.length);
  });

  it("throws on an unknown analysis", () => {
    expect(() => lineageOf("nope")).toThrow(RegistryError);
  });
});

describe("analysisVersionFingerprint", () => {
  it("includes the analysis and every transitively consumed metric", () => {
    const fp = analysisVersionFingerprint("working_capital_decomposition");
    expect(fp).toContain("working_capital_decomposition@1");
    expect(fp).toContain("dso_days@1");
    expect(fp).toContain("receivables_open@1"); // transitive
  });

  it("is deterministic", () => {
    const a = analysisVersionFingerprint("pareto_concentration");
    const b = analysisVersionFingerprint("pareto_concentration");
    expect(a).toBe(b);
  });

  it("differs between analyses", () => {
    expect(analysisVersionFingerprint("cash_bridge"))
      .not.toBe(analysisVersionFingerprint("ageing_distribution"));
  });
});
