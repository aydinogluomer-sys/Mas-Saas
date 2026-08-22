import { describe, expect, it } from "vitest";
import { sumDecimal } from "@/lib/money";
import {
  explain, firingRules, inScope, requestKindFor, ruleFires, type ApprovalRuleConfig,
} from "./rules";

const amountRule: ApprovalRuleConfig = {
  code: "amount_over_100k", description: "100.000 TL ve üzeri",
  triggerKind: "amount_threshold", thresholdAmount: 100000, appliesTo: ["invoices", "payment_instances"],
  isActive: true,
};
const ibanRule: ApprovalRuleConfig = {
  code: "new_iban_requires_approval", description: "Yeni IBAN",
  triggerKind: "new_iban", thresholdAmount: null, appliesTo: ["ibans"], isActive: true,
};
const inactiveRule: ApprovalRuleConfig = {
  code: "payment_requires_approval", description: "Her ödeme",
  triggerKind: "payment", thresholdAmount: null, appliesTo: [], isActive: false,
};

describe("ruleFires — amount thresholds", () => {
  it("fires exactly AT the threshold, not only above it", () => {
    expect(ruleFires(amountRule, { subjectTable: "invoices", amount: 100000 })).toBe(true);
  });

  it("fires on a numeric STRING exactly at the threshold, without a float ever existing", () => {
    // pg returns numeric as a string. Comparing it directly is the whole reason RuleInput.amount
    // is NumericInput rather than number.
    expect(ruleFires(amountRule, { subjectTable: "invoices", amount: "100000.00" })).toBe(true);
    expect(ruleFires(amountRule, { subjectTable: "invoices", amount: "99999.99" })).toBe(false);
  });

  it("documents WHY money must not be float-summed before it reaches the rule", () => {
    // These three amounts are exactly 100.000,00 TL. Added as floats they come to
    // 99999.999999999985, which is genuinely below the threshold — so the rule correctly does not
    // fire, and a 100.000 TL payment would slip past its checker. The defect is upstream, in the
    // addition, not here: by the time a corrupted float arrives no comparison can recover the
    // lost value. Summed through money.ts the same parts clear the threshold.
    const parts = ["99999.98", "0.01", "0.01"];
    const floatTotal = parts.reduce((a, b) => a + Number(b), 0);
    expect(ruleFires(amountRule, { subjectTable: "invoices", amount: floatTotal })).toBe(false);
    expect(ruleFires(amountRule, { subjectTable: "invoices", amount: sumDecimal(parts) })).toBe(true);
  });

  it("does not fire one kuruş below the threshold", () => {
    expect(ruleFires(amountRule, { subjectTable: "invoices", amount: 99999.99 })).toBe(false);
  });

  it("treats a large negative amount as equally consequential", () => {
    // Signed outflows are normal in this schema; a -250.000 TL movement is not 'below' a threshold.
    expect(ruleFires(amountRule, { subjectTable: "invoices", amount: -250000 })).toBe(true);
  });

  it("does NOT fire on an unknown amount — null is unknown, not zero", () => {
    expect(ruleFires(amountRule, { subjectTable: "invoices", amount: null })).toBe(false);
    expect(ruleFires(amountRule, { subjectTable: "invoices" })).toBe(false);
  });

  it("fires on an explicit zero only when the threshold is zero", () => {
    expect(ruleFires(amountRule, { subjectTable: "invoices", amount: 0 })).toBe(false);
    const everything = { ...amountRule, code: "all", thresholdAmount: 0 };
    expect(ruleFires(everything, { subjectTable: "invoices", amount: 0 })).toBe(true);
  });

  it("handles TL amounts far beyond float's safe integer range for kuruş", () => {
    expect(ruleFires(amountRule, { subjectTable: "invoices", amount: 987654321987.65 })).toBe(true);
  });
});

describe("ruleFires — scope and kind", () => {
  it("ignores subjects outside its scope", () => {
    expect(ruleFires(amountRule, { subjectTable: "parties", amount: 500000 })).toBe(false);
  });

  it("an empty scope means every subject table", () => {
    expect(inScope({ ...ibanRule, appliesTo: [] }, "anything")).toBe(true);
  });

  it("a kind rule fires only on its own kind", () => {
    expect(ruleFires(ibanRule, { subjectTable: "ibans", triggerKind: "new_iban" })).toBe(true);
    expect(ruleFires(ibanRule, { subjectTable: "ibans", triggerKind: "new_counterparty" })).toBe(false);
  });

  it("a kind rule does not fire on an amount alone", () => {
    expect(ruleFires(ibanRule, { subjectTable: "ibans", amount: 999999 })).toBe(false);
  });

  it("an inactive rule never fires, whatever the input", () => {
    expect(ruleFires(inactiveRule, { subjectTable: "payment_instances", triggerKind: "payment" })).toBe(false);
  });
});

describe("firingRules / explain", () => {
  const all = [amountRule, ibanRule, inactiveRule];

  it("returns a stable order for the same input", () => {
    const a = firingRules(all, { subjectTable: "invoices", amount: 200000 }).map((r) => r.code);
    const b = firingRules([...all].reverse(), { subjectTable: "invoices", amount: 200000 }).map((r) => r.code);
    expect(a).toEqual(b);
  });

  it("names the rule codes rather than summarising", () => {
    const fired = firingRules(all, { subjectTable: "invoices", amount: 200000 });
    expect(explain(fired)).toContain("amount_over_100k");
  });

  it("says plainly when nothing fired", () => {
    expect(explain([])).toBe("Onay kuralı tetiklenmedi.");
    expect(requestKindFor([])).toBe("other");
  });

  it("derives the request kind from what actually fired", () => {
    expect(requestKindFor([ibanRule])).toBe("new_iban");
    expect(requestKindFor([amountRule])).toBe("amount_threshold");
  });
});
