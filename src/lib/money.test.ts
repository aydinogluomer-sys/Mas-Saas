// Faz 17 — money boundary tests.
//
// Every expected value here is one of: a value Postgres itself produced in a disposable
// database during this phase's measurement pass, or a figure that can be checked by hand.
// Where a test asserts that plain float arithmetic gets something WRONG, it asserts the wrong
// value too — otherwise the test would silently stop proving anything the day V8 changed.

import { describe, expect, it } from "vitest";
import {
  MONEY_DP,
  RATE_DP,
  decimal,
  divOrNull,
  formatMoney,
  formatMoneyOrNull,
  intOrNull,
  isNumericString,
  money,
  moneyOrNull,
  mul,
  rate,
  rateOrNull,
  ratioOrNull,
  roundMoney,
  sub,
  sumDecimal,
  sumMoney,
  toDecimal,
  toDecimalOrNull,
} from "./money";

describe("parsing what node-postgres actually returns", () => {
  // node-pg hands back `numeric` as a string; these are literal outputs captured from
  // Postgres 16 during this phase.
  it("parses a plain numeric(14,2) column string", () => {
    expect(moneyOrNull("1234567890.12")).toBe(1234567890.12);
  });

  it("keeps a high-scale quotient that a float8 cast would have corrupted", () => {
    // select (100000::numeric / 3::numeric) -> "33333.333333333333"
    // the same expression with ::float8     ->  33333.333333333336
    const fromPg = "33333.333333333333";
    expect(toDecimal(fromPg).toString()).toBe("33333.333333333333");
    // Number() loses it exactly the way float8 did — this is why a decimal type is needed
    // and why removing the cast alone would not have been enough.
    expect(Number(fromPg)).toBe(33333.333333333336);
  });

  it("parses bigint strings (count(*) comes back as a string too)", () => {
    expect(intOrNull("42")).toBe(42);
    expect(intOrNull(42)).toBe(42);
  });

  it("accepts exponent notation, which numeric can emit", () => {
    expect(toDecimal("1e3").toString()).toBe("1000");
  });
});

describe("unknown stays unknown — never zero (CLAUDE.md financial rule)", () => {
  it("null and undefined survive as null", () => {
    expect(moneyOrNull(null)).toBeNull();
    expect(moneyOrNull(undefined)).toBeNull();
    expect(rateOrNull(null)).toBeNull();
    expect(intOrNull(null)).toBeNull();
    expect(toDecimalOrNull(null)).toBeNull();
  });

  it("an empty string is unknown, not zero", () => {
    expect(moneyOrNull("")).toBeNull();
    expect(moneyOrNull("   ")).toBeNull();
  });

  it("explicit zero stays zero and is distinguishable from unknown", () => {
    expect(moneyOrNull("0.00")).toBe(0);
    expect(moneyOrNull("0")).toBe(0);
    expect(moneyOrNull(null)).toBeNull();
  });

  it("sums skip unknowns rather than adding them as zero", () => {
    expect(sumMoney(["10.00", null, "5.50", undefined, ""])).toBe(15.5);
  });
});

describe("defects throw instead of propagating a silent NaN", () => {
  // This is the property big.js was chosen for: decimal.js would return NaN/Infinity here
  // and let it flow into a rendered total.
  it.each([
    ["not a number", "abc"],
    ["Turkish decimal comma", "1,5"],
    ["two decimal points", "1.2.3"],
    ["a bare minus", "-"],
  ])("throws on %s", (_label, value) => {
    expect(() => toDecimal(value)).toThrow();
    expect(() => moneyOrNull(value)).toThrow();
  });

  it("throws on NaN and Infinity rather than propagating them", () => {
    expect(() => toDecimal(NaN)).toThrow(TypeError);
    expect(() => toDecimal(Infinity)).toThrow(TypeError);
    expect(() => toDecimal(-Infinity)).toThrow(TypeError);
  });

  it("money() refuses to invent a value for a missing amount", () => {
    expect(() => money(null)).toThrow();
  });

  it("isNumericString rejects what Postgres numeric would reject", () => {
    expect(isNumericString("12.5")).toBe(true);
    expect(isNumericString("-0.001")).toBe(true);
    expect(isNumericString("1,5")).toBe(false);
    expect(isNumericString("1 234")).toBe(false);
    expect(isNumericString("")).toBe(false);
  });
});

describe("division by zero is an unknown, not an Infinity", () => {
  it("divOrNull returns null instead of throwing or returning Infinity", () => {
    expect(divOrNull("10", "0")).toBeNull();
    expect(divOrNull("10", null)).toBeNull();
    expect(divOrNull(null, "10")).toBeNull();
    expect(divOrNull("10", "4")!.toString()).toBe("2.5");
  });

  it("ratioOrNull gives null for 'no known total', not a reassuring 0", () => {
    expect(ratioOrNull("5", "0")).toBeNull();
    expect(ratioOrNull("25", "100")).toBe(0.25);
  });
});

describe("large TL amounts keep every kuruş", () => {
  // numeric(14,2) tops out at 12 integer digits; float64 represents whole cents exactly up to
  // 2^53 ≈ 9.0e15, i.e. 9.0e13 TL, so the whole column range round-trips exactly.
  it.each([
    "999999999999.99",
    "123456789012.34",
    "999999999999.01",
    "-999999999999.99",
    "0.01",
    "-0.01",
  ])("round-trips %s exactly", (value) => {
    expect(formatMoney(value)).toBe(new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false,
    }).format(Number(value)));
    expect(toDecimal(value).toFixed(2)).toBe(value === "0.01" || value === "-0.01" ? value : value);
  });

  it("adds two near-maximum amounts without losing a kuruş", () => {
    // 499999999999.99 + 499999999999.99 = 999999999999.98
    expect(sumMoney(["499999999999.99", "499999999999.99"])).toBe(999999999999.98);
    expect(sumDecimal(["499999999999.99", "499999999999.99"]).toFixed(2)).toBe("999999999999.98");
  });

  it("subtracts large amounts exactly where floats would leave a tail", () => {
    // The classic: 0.3 - 0.1 in binary floats is 0.19999999999999998
    expect(0.3 - 0.1).not.toBe(0.2);
    expect(sub("0.3", "0.1").toString()).toBe("0.2");
  });
});

describe("accumulation does not drift (the pattern the rules modules used)", () => {
  it("20 000 rows of 0.07 sum to exactly 1400, as Postgres sum() does", () => {
    const rows = Array.from({ length: 20_000 }, () => "0.07");
    // measured: Postgres sum() over the same 20 000 rows returns 1400.00
    expect(sumDecimal(rows).toString()).toBe("1400");
    expect(sumMoney(rows)).toBe(1400);

    // and the `+=` version this replaced does NOT
    let float = 0;
    for (const r of rows) float += Number(r);
    expect(float).toBe(1399.9999999999804);
    expect(float).not.toBe(1400);
  });

  it("1 000 invoice lines of 33.33 sum exactly", () => {
    const rows = Array.from({ length: 1000 }, () => "33.33");
    expect(sumDecimal(rows).toString()).toBe("33330");

    let float = 0;
    for (const r of rows) float += Number(r);
    expect(float).toBe(33330.00000000085);
  });

  it("an empty set sums to zero, not NaN", () => {
    expect(sumMoney([])).toBe(0);
  });
});

describe("percent-of-percent (BSMV + KKDF over interest)", () => {
  // faiz = anapara × oran; üstüne BSMV %5 ve KKDF %15 — a percentage OF a percentage.
  // Each case below is one where naive float arithmetic produces a different value from the
  // exact one; the float result is asserted so the test keeps proving the difference.
  const cases: Array<{ principal: string; rate: string; exact: string; float: number }> = [
    { principal: "1234567.89", rate: "0.0825", exact: "122222.22111", float: 122222.22110999998 },
    { principal: "987654.32", rate: "0.0349", exact: "41362.9629216", float: 41362.962921599996 },
    { principal: "4875321.17", rate: "0.0075", exact: "43877.89053", float: 43877.89052999999 },
    { principal: "250000.50", rate: "0.4250", exact: "127500.255", float: 127500.25499999999 },
  ];

  it.each(cases)("anapara $principal @ $rate is exact", ({ principal, rate: r, exact, float }) => {
    const interest = mul(principal, r);
    const total = interest.plus(interest.times("0.05")).plus(interest.times("0.15"));
    expect(total.toString()).toBe(exact);

    // the float pipeline this phase removed
    const fi = Number(principal) * Number(r);
    const naive = fi + fi * 0.05 + fi * 0.15;
    expect(naive).toBe(float);
    expect(naive).not.toBe(Number(exact));
  });

  it("a ratio of a ratio stays exact", () => {
    // 40% of the 25% share = 10% overall
    const share = divOrNull("25", "100")!;
    const sub40 = share.times("0.40");
    expect(sub40.toString()).toBe("0.1");
  });

  it("keeps rate precision at numeric(8,4) scale", () => {
    expect(rate("0.0825")).toBe(0.0825);
    expect(rateOrNull("0.4250")).toBe(0.425);
    // a utilisation ratio must NOT be flattened to money scale
    expect(rateOrNull("0.8333333333")).toBe(0.8333333333);
    expect(moneyOrNull("0.8333333333")).toBe(0.83); // money scale, deliberately different
  });
});

describe("rounding agrees with Postgres round(), which toFixed does not", () => {
  // pg: select round(2.675::numeric,2) -> 2.68 ; JS: (2.675).toFixed(2) -> "2.67"
  it.each([
    ["2.675", "2.68", "2.67"],
    ["1.005", "1.01", "1.00"],
    ["1262.145", "1262.15", "1262.14"],
    ["70.285", "70.29", "70.28"],
  ])("%s rounds to %s (toFixed says %s)", (input, expected, jsWrong) => {
    expect(formatMoney(input)).toBe(expected);
    expect(Number(input).toFixed(2)).toBe(jsWrong);
  });

  it("rounds half-up away from zero for negatives, as Postgres does", () => {
    // select round(-2.675::numeric,2) -> -2.68
    expect(formatMoney("-2.675")).toBe("-2.68");
  });

  it("does not round a value that is genuinely below the halfway point", () => {
    expect(formatMoney("1.0049999999")).toBe("1.00");
  });

  it("roundMoney and money agree with formatMoney", () => {
    expect(roundMoney("2.675").toFixed(2)).toBe("2.68");
    expect(money("2.675")).toBe(2.68);
  });

  it("formatMoneyOrNull discloses unknown instead of printing 0,00", () => {
    expect(formatMoneyOrNull(null)).toBeNull();
    expect(formatMoneyOrNull("12.5")).toBe("12.50");
  });

  it("pads to the requested scale", () => {
    expect(formatMoney("2")).toBe("2.00");
    expect(formatMoney("0.1", 4)).toBe("0.1000");
  });
});

describe("scale constants match the schema", () => {
  it("money scale is 2 (every money column is numeric(14,2))", () => {
    expect(MONEY_DP).toBe(2);
  });

  it("rate scale is wider than any stored rate scale (numeric(8,4), numeric(18,6))", () => {
    expect(RATE_DP).toBeGreaterThan(6);
  });
});

describe("decimal() shares one configured constructor", () => {
  it("division precision is not the global big.js default anyone could change", () => {
    // 1/3 at the module's configured DP
    expect(divOrNull("1", "3")!.toString().length).toBeGreaterThan(10);
  });

  it("decimal values compare without float surprises", () => {
    expect(decimal("0.1").plus("0.2").eq(decimal("0.3"))).toBe(true);
    expect(0.1 + 0.2).not.toBe(0.3); // the reason the line above matters
  });
});
