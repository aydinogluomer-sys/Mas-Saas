import { describe, expect, it } from "vitest";
import { countSeverity, ratioSeverity, sortBySeverity } from "./rules";

describe("facts severity helpers", () => {
  it("grades counts without treating zero as risk", () => {
    expect(countSeverity(0, 1, 5)).toBe("low");
    expect(countSeverity(1, 1, 5)).toBe("high");
    expect(countSeverity(5, 1, 5)).toBe("critical");
  });

  it("grades ratios with explicit null handling", () => {
    expect(ratioSeverity(null, 0.4, 0.6)).toBe("low");
    expect(ratioSeverity(0.2, 0.4, 0.6)).toBe("medium");
    expect(ratioSeverity(0.45, 0.4, 0.6)).toBe("high");
    expect(ratioSeverity(0.7, 0.4, 0.6)).toBe("critical");
  });

  it("sorts facts by decision severity", () => {
    const sorted = sortBySeverity([
      { severity: "low" as const, key: "routine" },
      { severity: "critical" as const, key: "overdue" },
      { severity: "high" as const, key: "cash" },
    ]);
    expect(sorted.map((x) => x.key)).toEqual(["overdue", "cash", "routine"]);
  });
});
