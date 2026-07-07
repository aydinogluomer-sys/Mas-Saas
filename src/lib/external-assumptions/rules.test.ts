import { describe, expect, it } from "vitest";
import {
  defaultReviewStatus,
  normalizeAssumptionType,
  normalizeReviewStatus,
  normalizeSourceKind,
  sourceLabel,
} from "./rules";

describe("external assumption rules", () => {
  it("defaults internet inputs to pending review", () => {
    expect(defaultReviewStatus("internet")).toBe("pending_review");
    expect(defaultReviewStatus("manual")).toBe("approved");
  });

  it("normalizes unknown types and statuses conservatively", () => {
    expect(normalizeAssumptionType("energy_cost")).toBe("energy_cost");
    expect(normalizeAssumptionType("mystery")).toBe("other");
    expect(normalizeSourceKind("internet")).toBe("internet");
    expect(normalizeSourceKind("api")).toBe("manual");
    expect(normalizeReviewStatus("approved")).toBe("approved");
    expect(normalizeReviewStatus("paid")).toBeNull();
  });

  it("keeps source and date visible together", () => {
    expect(sourceLabel("TCMB", "2026-07-08")).toBe("TCMB / 2026-07-08");
  });
});
