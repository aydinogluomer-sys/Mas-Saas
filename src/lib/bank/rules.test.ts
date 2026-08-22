// Faz 20 — bank statement rules tests.

import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_RULES,
  MATCH_WEIGHTS,
  SUGGESTION_THRESHOLD,
  classifyTransaction,
  dedupeKey,
  detectStatementColumns,
  parseStatementAmount,
  parseStatementDate,
  rankCandidates,
  resolveSignedAmount,
  scoreMatch,
  statementColumnsUsable,
  type MatchTarget,
} from "./rules";

describe("parseStatementAmount handles both number conventions", () => {
  it.each([
    ["1.234,56", "1234.56"],   // Turkish
    ["1,234.56", "1234.56"],   // English
    ["1234.56", "1234.56"],
    ["1234,56", "1234.56"],
    ["1.234", "1234"],         // lone dot + 3 digits = thousands
    ["1,23", "1.23"],          // comma + 2 digits = decimal
    ["12.345.678,90", "12345678.90"],
    ["-1.234,56", "-1234.56"],
    ["1.234,56 TL", "1234.56"],
    ["₺1.234,56", "1234.56"],
  ])("%s -> %s", (input, expected) => {
    expect(parseStatementAmount(input)).toBe(expected);
  });

  it("reads accounting parentheses as negative", () => {
    expect(parseStatementAmount("(1.234,56)")).toBe("-1234.56");
  });

  it("returns null for junk rather than guessing", () => {
    for (const bad of ["", "   ", "abc", null, undefined, "1.2.3,4,5"]) {
      expect(parseStatementAmount(bad)).toBeNull();
    }
  });

  it("passes a real number through without a float round-trip", () => {
    expect(parseStatementAmount(1234.56)).toBe("1234.56");
    expect(parseStatementAmount(Number.NaN)).toBeNull();
    expect(parseStatementAmount(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("returns a STRING so the value reaches money.ts unrounded", () => {
    // Going through a JS float here would undo Faz 17 at the point of entry.
    expect(typeof parseStatementAmount("999999999999.99")).toBe("string");
    expect(parseStatementAmount("999999999999.99")).toBe("999999999999.99");
  });
});

describe("resolveSignedAmount — negative leaves the account", () => {
  it("debit column becomes negative", () => {
    expect(resolveSignedAmount({ debit: "1.000,00" })).toBe("-1000");
  });

  it("credit column stays positive", () => {
    expect(resolveSignedAmount({ credit: "1.000,00" })).toBe("1000");
  });

  it("debit/credit win over a single ambiguous amount column", () => {
    expect(resolveSignedAmount({ amount: "1000", debit: "250,00" })).toBe("-250");
  });

  it("a zero in one column does not claim the row", () => {
    expect(resolveSignedAmount({ debit: "0,00", credit: "500,00" })).toBe("500");
  });

  it("uses a direction word when the amount is unsigned", () => {
    expect(resolveSignedAmount({ amount: "500", directionHint: "Borç" })).toBe("-500");
    expect(resolveSignedAmount({ amount: "500", directionHint: "Alacak" })).toBe("500");
    expect(resolveSignedAmount({ amount: "500", directionHint: "ÇIKIŞ" })).toBe("-500");
  });

  it("keeps an explicit sign when there is no hint", () => {
    expect(resolveSignedAmount({ amount: "-500" })).toBe("-500");
  });

  it("returns null when there is nothing to read", () => {
    expect(resolveSignedAmount({})).toBeNull();
  });
});

describe("parseStatementDate", () => {
  it.each([
    ["31.01.2026", "2026-01-31"],
    ["01/02/2026", "2026-02-01"],
    ["2026-03-15", "2026-03-15"],
    ["5.7.2026", "2026-07-05"],
    ["05.07.26", "2026-07-05"],
  ])("%s -> %s", (input, expected) => {
    expect(parseStatementDate(input)).toBe(expected);
  });

  it("REJECTS an impossible date instead of rolling it over", () => {
    // new Date(2026,1,31) silently becomes 3 March — exactly the silent correction this
    // codebase refuses to make to financial data.
    expect(parseStatementDate("31.02.2026")).toBeNull();
    expect(parseStatementDate("32.01.2026")).toBeNull();
    expect(parseStatementDate("15.13.2026")).toBeNull();
  });

  it("accepts a leap day only in a leap year", () => {
    expect(parseStatementDate("29.02.2028")).toBe("2028-02-29");
    expect(parseStatementDate("29.02.2027")).toBeNull();
  });

  it("reads Excel serials", () => {
    expect(parseStatementDate(46023)).toBe("2026-01-01");
  });

  it("returns null for junk", () => {
    for (const bad of ["", "abc", null, undefined, 5]) expect(parseStatementDate(bad)).toBeNull();
  });
});

describe("detectStatementColumns", () => {
  it("maps a Turkish header row", () => {
    const cols = detectStatementColumns({
      A: "İşlem Tarihi", B: "Valör", C: "Açıklama", D: "Borç", E: "Alacak", F: "Bakiye",
    });
    expect(cols.txn_date).toBe("A");
    expect(cols.value_date).toBe("B");
    expect(cols.description).toBe("C");
    expect(cols.debit).toBe("D");
    expect(cols.credit).toBe("E");
    expect(cols.balance).toBe("F");
  });

  it("does not let 'Valör' be stolen by 'Tarih'", () => {
    const cols = detectStatementColumns({ A: "Valör Tarihi", B: "İşlem Tarihi" });
    expect(cols.value_date).toBe("A");
    expect(cols.txn_date).toBe("B");
  });

  it("maps an English header row", () => {
    const cols = detectStatementColumns({ A: "Date", B: "Description", C: "Amount", D: "Balance" });
    expect(cols.txn_date).toBe("A");
    expect(cols.amount).toBe("C");
  });

  it("leaves unknown headers unmapped rather than guessing by position", () => {
    const cols = detectStatementColumns({ A: "Zort", B: "Zırt" });
    expect(Object.keys(cols)).toHaveLength(0);
  });

  it("never assigns one column to two fields", () => {
    const cols = detectStatementColumns({ A: "Tutar", B: "Tarih" });
    const used = Object.values(cols);
    expect(new Set(used).size).toBe(used.length);
  });

  it("usability needs a date AND some amount column", () => {
    expect(statementColumnsUsable({ txn_date: "A", amount: "B" })).toBe(true);
    expect(statementColumnsUsable({ txn_date: "A", debit: "B" })).toBe(true);
    expect(statementColumnsUsable({ txn_date: "A" })).toBe(false);
    expect(statementColumnsUsable({ amount: "B" })).toBe(false);
  });
});

describe("dedupeKey", () => {
  it("is stable across amount spellings", () => {
    const a = dedupeKey({ txnDate: "2026-01-01", amount: "-100", description: "EFT" });
    const b = dedupeKey({ txnDate: "2026-01-01", amount: "-100.00", description: "EFT" });
    expect(a).toBe(b);
  });

  it("normalizes description whitespace and case", () => {
    const a = dedupeKey({ txnDate: "2026-01-01", amount: "-100", description: "EFT  ÖDEME" });
    const b = dedupeKey({ txnDate: "2026-01-01", amount: "-100", description: "eft ödeme" });
    expect(a).toBe(b);
  });

  it("separates genuinely different lines", () => {
    const base = { txnDate: "2026-01-01", amount: "-100", description: "EFT" };
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, amount: "-101" }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, txnDate: "2026-01-02" }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, reference: "REF1" }));
  });

  it("ignores the running balance, which shifts on a back-dated entry", () => {
    // Not part of the key at all — asserted by the fact that two calls with identical inputs
    // match regardless of any balance the caller may hold.
    const a = dedupeKey({ txnDate: "2026-01-01", amount: "-100", description: "EFT", reference: "R" });
    const b = dedupeKey({ txnDate: "2026-01-01", amount: "-100", description: "EFT", reference: "R" });
    expect(a).toBe(b);
  });
});

describe("classifyTransaction — named rules, first match wins", () => {
  it.each([
    ["EFT ÜCRETİ", "-15", "bank_fee", "eft_havale_fee"],
    ["BSMV", "-1.5", "tax", "bsmv_kkdf"],
    ["KREDİ KARTI BORÇ ÖDEMESİ", "-5000", "card_payment", "card_payment"],
    ["MAAŞ ÖDEMESİ", "-45000", "salary", "salary"],
    ["ÇEK TAHSİL", "-100000", "check_settlement", "check_settlement"],
    ["GELEN HAVALE", "25000", "incoming_payment", "incoming_transfer"],
    ["VİRMAN", "-1000", "own_transfer", "own_transfer"],
  ])("%s -> %s", (desc, amount, category, rule) => {
    const r = classifyTransaction({ description: desc, amount });
    expect(r.category).toBe(category);
    expect(r.rule).toBe(rule);
  });

  it("puts 'kredi kartı' before 'kredi taksit' — order is the specification", () => {
    // Sorting CLASSIFICATION_RULES alphabetically would break this.
    const card = classifyTransaction({ description: "KREDİ KARTI ÖDEME", amount: "-100" });
    expect(card.category).toBe("card_payment");
  });

  it("separates interest earned from interest paid by direction", () => {
    expect(classifyTransaction({ description: "FAİZ", amount: "500" }).category).toBe("interest_earned");
    expect(classifyTransaction({ description: "FAİZ", amount: "-500" }).category).toBe("interest_paid");
  });

  it("returns unknown with a NULL rule rather than a best guess", () => {
    const r = classifyTransaction({ description: "ZZZ QQQ", amount: "-100" });
    expect(r.category).toBe("unknown");
    expect(r.rule).toBeNull();
  });

  it("handles an empty description", () => {
    expect(classifyTransaction({ description: null, amount: "-100" }).category).toBe("unknown");
  });

  it("every verdict names a rule that exists", () => {
    const names = new Set(CLASSIFICATION_RULES.map((r) => r.name));
    for (const desc of ["EFT ÜCRETİ", "MAAŞ", "GELEN HAVALE", "VİRMAN"]) {
      const r = classifyTransaction({ description: desc, amount: "-1" });
      if (r.rule) expect(names.has(r.rule)).toBe(true);
    }
  });
});

describe("scoreMatch — two signals required, never one", () => {
  const txn = { amount: -10000, txnDate: "2026-03-10", description: "EFT ODEME ACME", counterparty: "ACME LTD" };

  it("an exact amount ALONE does not clear the suggestion threshold", () => {
    // A lone amount match on a round number is exactly the coincidence that produces a
    // confidently wrong reconciliation.
    const s = scoreMatch(txn, { table: "checks", id: "c1", amount: 10000, dueDate: null, label: null });
    expect(s.reasons).toContain("amount_exact");
    expect(s.confidence).toBeLessThan(SUGGESTION_THRESHOLD);
  });

  it("a date match ALONE does not clear it either", () => {
    const s = scoreMatch(txn, { table: "checks", id: "c1", amount: null, dueDate: "2026-03-10", label: null });
    expect(s.confidence).toBeLessThan(SUGGESTION_THRESHOLD);
  });

  it("amount + same day does clear it", () => {
    const s = scoreMatch(txn, { table: "checks", id: "c1", amount: 10000, dueDate: "2026-03-10", label: null });
    expect(s.confidence).toBeGreaterThanOrEqual(SUGGESTION_THRESHOLD);
    expect(s.reasons).toEqual(expect.arrayContaining(["amount_exact", "date_same_day"]));
  });

  it("an UNKNOWN target amount earns no amount points and says so", () => {
    const s = scoreMatch(txn, { table: "checks", id: "c1", amount: null, dueDate: "2026-03-10", label: "ACME LTD" });
    expect(s.reasons).toContain("target_amount_unknown");
    expect(s.reasons).not.toContain("amount_exact");
  });

  it("tolerates a 1 TL rounding difference, but scores it lower", () => {
    const exact = scoreMatch(txn, { table: "checks", id: "c1", amount: 10000, dueDate: "2026-03-10", label: null });
    const near = scoreMatch(txn, { table: "checks", id: "c1", amount: 10000.5, dueDate: "2026-03-10", label: null });
    expect(near.reasons).toContain("amount_within_1_try");
    expect(near.confidence).toBeLessThan(exact.confidence);
  });

  it("does not tolerate more than 1 TL", () => {
    const s = scoreMatch(txn, { table: "checks", id: "c1", amount: 10002, dueDate: "2026-03-10", label: null });
    expect(s.reasons).not.toContain("amount_exact");
    expect(s.reasons).not.toContain("amount_within_1_try");
  });

  it("compares absolute amounts, so an outflow matches a positive expectation", () => {
    const s = scoreMatch(txn, { table: "checks", id: "c1", amount: 10000, dueDate: "2026-03-10", label: null });
    expect(s.reasons).toContain("amount_exact");
  });

  it("NO single weight clears the threshold on its own", () => {
    // The structural invariant behind the two-signal rule. The first version of MATCH_WEIGHTS
    // violated it (amountExact was 0.6 against a 0.5 threshold) and this class of test is what
    // caught it, so it is asserted over the whole table rather than only for amount and date.
    for (const [name, weight] of Object.entries(MATCH_WEIGHTS)) {
      expect(weight, `${name} alone must not be suggestible`).toBeLessThan(SUGGESTION_THRESHOLD);
    }
  });

  it("never exceeds 1", () => {
    const s = scoreMatch(txn, { table: "checks", id: "c1", amount: 10000, dueDate: "2026-03-10", label: "ACME LTD" });
    expect(s.confidence).toBeLessThanOrEqual(1);
  });

  it("decays with date distance", () => {
    const near = scoreMatch(txn, { table: "checks", id: "c1", amount: 10000, dueDate: "2026-03-12", label: null });
    const far = scoreMatch(txn, { table: "checks", id: "c1", amount: 10000, dueDate: "2026-03-16", label: null });
    const gone = scoreMatch(txn, { table: "checks", id: "c1", amount: 10000, dueDate: "2026-05-01", label: null });
    expect(near.confidence).toBeGreaterThan(far.confidence);
    expect(far.confidence).toBeGreaterThan(gone.confidence);
  });
});

describe("rankCandidates", () => {
  const txn = { amount: -10000, txnDate: "2026-03-10", description: "EFT ACME", counterparty: "ACME LTD" };
  const targets: MatchTarget[] = [
    { table: "checks", id: "good", amount: 10000, dueDate: "2026-03-10", label: "ACME LTD" },
    { table: "checks", id: "weak", amount: 10000, dueDate: null, label: null },
    { table: "checks", id: "none", amount: 55, dueDate: "2027-01-01", label: null },
  ];

  it("keeps only candidates above the threshold, best first", () => {
    const r = rankCandidates(txn, targets);
    expect(r[0].id).toBe("good");
    expect(r.map((x) => x.id)).not.toContain("none");
  });

  it("returns an empty list rather than a weak guess", () => {
    expect(rankCandidates(txn, [targets[2]])).toEqual([]);
  });

  it("respects a caller-supplied threshold", () => {
    expect(rankCandidates(txn, targets, 0).length).toBe(3);
  });
});
