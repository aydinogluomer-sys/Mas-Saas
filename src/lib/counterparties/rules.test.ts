// Faz 19 — counterparty rules tests.

import { describe, expect, it } from "vitest";
import {
  assessExposure,
  formatIban,
  inspectIban,
  isTurkishIban,
  isValidIbanChecksum,
  nameSimilarity,
  normalizeIban,
  suggestCounterparties,
} from "./rules";

describe("normalizeIban matches migration 0037's generated column", () => {
  // The DB computes upper(regexp_replace(iban, '\s', '', 'g')) and builds a UNIQUE index on
  // it. If this function drifts, the app offers to save what the index then rejects.
  it("strips every kind of whitespace and uppercases", () => {
    expect(normalizeIban("tr33 0006 1005 1978 6457 8413 26")).toBe("TR330006100519786457841326");
    expect(normalizeIban("  TR33\t0006\n1005 1978 6457 8413 26 ")).toBe("TR330006100519786457841326");
  });

  it("is idempotent", () => {
    const once = normalizeIban("tr33 0006 1005 1978 6457 8413 26");
    expect(normalizeIban(once)).toBe(once);
  });
});

describe("IBAN checksum (ISO 7064 MOD-97-10)", () => {
  it("accepts valid IBANs", () => {
    expect(isValidIbanChecksum("TR330006100519786457841326")).toBe(true);
    expect(isValidIbanChecksum("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(isValidIbanChecksum("DE89 3704 0044 0532 0130 00")).toBe(true);
  });

  it("rejects a transposed digit — the realistic retyping error", () => {
    // TR33...4132|6 with the last two digits swapped
    expect(isValidIbanChecksum("TR330006100519786457841362")).toBe(false);
  });

  it("rejects a wrong check digit", () => {
    expect(isValidIbanChecksum("TR340006100519786457841326")).toBe(false);
  });

  it("rejects malformed input instead of throwing", () => {
    expect(isValidIbanChecksum("")).toBe(false);
    expect(isValidIbanChecksum("not an iban")).toBe(false);
    expect(isValidIbanChecksum("33TR0006100519786457841326")).toBe(false);
  });

  it("does not overflow on a maximum-length IBAN", () => {
    // 34 chars is the ISO maximum; a naive Number() implementation loses precision here.
    expect(() => isValidIbanChecksum("MT84MALT011000012345MTLCAST001S")).not.toThrow();
    expect(isValidIbanChecksum("MT84MALT011000012345MTLCAST001S")).toBe(true);
  });
});

describe("inspectIban reports, never corrects", () => {
  it("flags a bad checksum but still returns the normalized value", () => {
    const r = inspectIban("TR330006100519786457841362");
    expect(r.checksumValid).toBe(false);
    expect(r.normalized).toBe("TR330006100519786457841362");
    expect(r.warnings.join(" ")).toContain("kontrol hanesi");
  });

  it("flags a TR IBAN of the wrong length", () => {
    const r = inspectIban("TR3300061005197864578413");
    expect(r.warnings.some((w) => w.includes("26 karakter"))).toBe(true);
  });

  it("is clean for a valid Turkish IBAN", () => {
    const r = inspectIban("tr33 0006 1005 1978 6457 8413 26");
    expect(r.wellFormed).toBe(true);
    expect(r.checksumValid).toBe(true);
    expect(r.turkish).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("recognises non-Turkish IBANs without complaining", () => {
    const r = inspectIban("GB82 WEST 1234 5698 7654 32");
    expect(r.checksumValid).toBe(true);
    expect(r.turkish).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("isTurkishIban needs both the prefix and the length", () => {
    expect(isTurkishIban("TR330006100519786457841326")).toBe(true);
    expect(isTurkishIban("TR3300061005")).toBe(false);
    expect(isTurkishIban("GB82WEST12345698765432")).toBe(false);
  });
});

describe("formatIban", () => {
  it("groups in fours for display", () => {
    expect(formatIban("TR330006100519786457841326")).toBe("TR33 0006 1005 1978 6457 8413 26");
  });

  it("re-formats an already-spaced value consistently", () => {
    expect(formatIban("TR33 000610051978 64578413 26")).toBe("TR33 0006 1005 1978 6457 8413 26");
  });
});

describe("nameSimilarity is a hint, with sane bounds", () => {
  it("is 1 for the same normalized name", () => {
    expect(nameSimilarity("ACME LTD", "acme ltd")).toBe(1);
  });

  it("scores an abbreviation expansion above an unrelated name", () => {
    const related = nameSimilarity("ACME LTD", "ACME LIMITED");
    const unrelated = nameSimilarity("ACME LTD", "ZORLU ENERJI");
    expect(related).toBeGreaterThan(unrelated);
  });

  it("stays within 0..1", () => {
    for (const [a, b] of [["ACME", "ACME"], ["A", "B"], ["EGE GÜNEŞ", "EGE GUNES"], ["", "x"]]) {
      const s = nameSimilarity(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("handles single characters without dividing by zero", () => {
    expect(nameSimilarity("A", "A")).toBe(1); // equal short-circuits
    expect(nameSimilarity("A", "B")).toBe(0);
  });
});

describe("suggestCounterparties never auto-links", () => {
  const candidates = [
    { id: "p1", name: "ACME LIMITED" },
    { id: "p2", name: "ZORLU ENERJI" },
    { id: "p3", name: "ACME LTD" },
  ];

  it("ranks the exact normalized match first", () => {
    const s = suggestCounterparties("acme ltd", candidates);
    expect(s[0].partyId).toBe("p3");
    expect(s[0].score).toBe(1);
  });

  it("returns an empty list rather than a bad guess", () => {
    expect(suggestCounterparties("TOTALLY UNRELATED FIRM", candidates)).toEqual([]);
  });

  it("returns nothing for a blank label", () => {
    expect(suggestCounterparties("   ", candidates)).toEqual([]);
  });

  it("exposes no field that could be read as permission to link", () => {
    const s = suggestCounterparties("acme ltd", candidates);
    expect(Object.keys(s[0]).sort()).toEqual(["name", "partyId", "score"]);
  });

  it("respects the limit", () => {
    expect(suggestCounterparties("acme", candidates, 0, 1)).toHaveLength(1);
  });
});

describe("assessExposure", () => {
  const base = { totalExposure: 0, creditLimit: null, exposureRatio: null, unknownAmountCount: 0 };

  it("is 'none' only when there is genuinely nothing", () => {
    expect(assessExposure(base).band).toBe("none");
  });

  it("an unknown amount never leaves the band at 'none'", () => {
    // A counterparty whose only items are unpriced is not risk-free.
    const r = assessExposure({ ...base, unknownAmountCount: 4 });
    expect(r.band).toBe("low");
    expect(r.incomplete).toBe(true);
    expect(r.reasons.join(" ")).toContain("tutarı bilinmiyor");
  });

  it("over_limit wins over everything else", () => {
    const r = assessExposure({ totalExposure: 150, creditLimit: 100, exposureRatio: 0.9, unknownAmountCount: 2 });
    expect(r.band).toBe("over_limit");
    expect(r.incomplete).toBe(true);
  });

  it("a zero credit limit is a real value, not 'no limit'", () => {
    // "cash only" — any exposure at all breaches it.
    expect(assessExposure({ ...base, totalExposure: 1, creditLimit: 0 }).band).toBe("over_limit");
  });

  it("a null credit limit is not treated as zero", () => {
    expect(assessExposure({ ...base, totalExposure: 1_000_000, creditLimit: null }).band).not.toBe("over_limit");
  });

  it("flags concentration on the same 0.40 threshold the rest of the app uses", () => {
    expect(assessExposure({ ...base, totalExposure: 100, exposureRatio: 0.41 }).band).toBe("high");
    expect(assessExposure({ ...base, totalExposure: 100, exposureRatio: 0.39 }).band).toBe("low");
  });

  it("watches an 80%-utilised limit", () => {
    const r = assessExposure({ ...base, totalExposure: 80, creditLimit: 100 });
    expect(r.band).toBe("watch");
    expect(r.reasons.join(" ")).toContain("%80");
  });

  it("does not divide by a zero limit when banding utilisation", () => {
    expect(() => assessExposure({ ...base, totalExposure: 0, creditLimit: 0 })).not.toThrow();
  });
});
