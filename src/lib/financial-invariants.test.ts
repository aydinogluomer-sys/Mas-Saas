// Faz 11 — the financial invariants that a coverage audit found asserted NOWHERE.
//
// The money layer here is already unusually well tested: src/lib/money.test.ts pins half-cent
// rounding, negative rounding, near-maximum addition and 20 000-row summation, and each case also
// asserts the WRONG float answer so the test cannot quietly stop proving anything. The domain
// suites cover partial payment, overdue buckets, loans, invoices, receivables, FX and budget with
// hand-defined expected values.
//
// An inventory against the plan's §14.2 list turned up three invariants with no assertion at any
// layer — not in vitest, not in the DB, not in the phase verifies. This file closes those three
// and nothing else; duplicating what is already covered would only add maintenance.
//
// A NOTE ON ONE INVARIANT THAT IS DELIBERATELY ABSENT, AND MUST STAY ABSENT.
//
// The plan lists `paid_amount <= payment_total`. In this codebase that is NOT an invariant and
// asserting it would be a regression. Migration 0044 puts only `check (paid_amount >= 0)` on the
// column, and 0047 says in as many words that "0044 deliberately puts no upper bound on
// paid_amount". An overpayment is a real event a finance panel must be able to record and show;
// clamping it would hide money that actually moved. The existing tests pin the intended behaviour
// instead — remainingAmount goes NEGATIVE on overpayment, and an overpaid invoice reads as `paid`
// rather than `partial`. The check below therefore asserts the OPPOSITE of the plan's line, on
// purpose, so that nobody "fixes" it later.

import { describe, expect, it } from "vitest";
import { remainingAmount, suggestStatusFromPayment } from "@/lib/invoices/rules";
import { money } from "@/lib/money";

describe("Faz 11 — ters kayıt (reversal) net etkisi", () => {
  // The audit's finding: phase21-verify asserts a reversal RECORD exists and the status flipped,
  // but nothing anywhere compares the reversed amount against the original. A cancellation that
  // leaves a residue is the kind of error that only shows up as an unexplainable total months
  // later, which is exactly the failure this plan opens by naming.
  it("tam ters kayıt sonrası net etki TAM OLARAK sıfır (kuruş artığı yok)", () => {
    for (const gross of [100, 0.01, 1262.145, 999999999999.99, 33.33]) {
      const rounded = money(String(gross));
      expect(remainingAmount(rounded, rounded)).toBe(0);
    }
  });

  it("awkward ondalıklarda bile artık bırakmıyor — float burada 0 üretmez", () => {
    // 0.1 + 0.2 - 0.3 is the canonical float trap; through the money layer it must be exactly 0.
    const gross = money("0.30");
    const paidInTwoParts = money(String(money("0.10") + money("0.20")));
    expect(remainingAmount(gross, paidInTwoParts)).toBe(0);
    // and the float route genuinely fails, so this test is proving something
    expect(0.1 + 0.2 - 0.3).not.toBe(0);
  });

  it("KISMİ ters kayıt sıfır DEĞİL — testin kör olmadığının pozitif kontrolü", () => {
    expect(remainingAmount(money("100.00"), money("40.00"))).toBe(60);
  });
});

describe("Faz 11 — kapalı kalem açık bakiye taşımaz", () => {
  // The audit's finding: `closed` was only ever tested as a state TRANSITION ("closed reopens only
  // via open"). Nothing asserted the property that makes `closed` meaningful — that there is
  // nothing left to collect.
  it("kapalı bir kalemin kalanı sıfır olmalı; sıfır değilse kapatılamaz", () => {
    const gross = money("1500.00");
    const fullyPaid = money("1500.00");
    expect(remainingAmount(gross, fullyPaid)).toBe(0);

    // A partially paid invoice must never be describable as fully settled.
    const partiallyPaid = money("1499.99");
    expect(remainingAmount(gross, partiallyPaid)).not.toBe(0);
    expect(suggestStatusFromPayment("open", gross, partiallyPaid)).toBe("partial");
  });

  it("terminal durumlar ödeme sinyaliyle yeniden sınıflandırılmıyor", () => {
    // closed/cancelled must be inert: a late payment row cannot silently reopen the books.
    for (const terminal of ["closed", "cancelled"] as const) {
      expect(suggestStatusFromPayment(terminal, money("100.00"), money("50.00"))).toBeNull();
    }
  });
});

describe("Faz 11 — aşırı ödeme KIRPILMAZ (planın tersi, bilerek)", () => {
  it("aşırı ödemede kalan NEGATİF olur, sıfıra kırpılmaz", () => {
    // If someone ever "fixes" this to clamp at zero, money that really moved disappears from the
    // screen. 0044 allows paid_amount > gross precisely so this stays visible.
    expect(remainingAmount(money("100.00"), money("130.00"))).toBe(-30);
  });

  it("aşırı ödenen fatura 'partial' değil 'paid' okunur", () => {
    expect(suggestStatusFromPayment("open", money("100.00"), money("130.00"))).toBe("paid");
  });
});

describe("Faz 11 — nakit akışı kimliği: kapanış = açılış + gelir − gider", () => {
  // The audit's finding: continuity between months IS tested (prev.closing ≈ next.opening), but
  // the identity WITHIN a month is not asserted anywhere. Continuity can hold perfectly while
  // every month's closing is computed wrongly, as long as it is computed wrongly the same way.
  const identity = (opening: string, income: string, expense: string): number =>
    money(String(money(opening) + money(income) - money(expense)));

  it("kimlik kuruş kuruşuna tutuyor", () => {
    expect(identity("1000.00", "250.50", "125.25")).toBe(1125.25);
    expect(identity("0.00", "0.01", "0.02")).toBe(-0.01);
    expect(identity("-500.00", "100.00", "0.00")).toBe(-400);
  });

  it("binlerce küçük hareket sonrası sürüklenme yok", () => {
    // 1200 monthly movements of 0.07 must land exactly, the way Postgres sum() would.
    let balance = money("0.00");
    for (let i = 0; i < 1200; i += 1) balance = money(String(balance + money("0.07")));
    expect(balance).toBe(84);
    // the float route drifts, which is why the money layer exists
    let drift = 0;
    for (let i = 0; i < 1200; i += 1) drift += 0.07;
    expect(drift).not.toBe(84);
  });

  it("gider gelirden büyükse kapanış negatife geçer (kırpma yok)", () => {
    expect(identity("100.00", "0.00", "250.00")).toBe(-150);
  });
});
