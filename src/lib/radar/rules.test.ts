import { describe, it, expect } from "vitest";
import {
  addMonths, computeRisk, dayFlags, dueDateFor, riskLevelOf,
} from "./rules";

const T = { large: 50_000, critical: 100_000, clusterCount: 3 };

describe("dueDateFor — 29/30/31 edge cases (rule: last day + flag)", () => {
  it("day 31: Şubat 2027→28, Şubat 2028→29 (artık), Nisan→30, Temmuz→31", () => {
    expect(dueDateFor("2027-02-01", 31)).toEqual({ dueDate: "2027-02-28", shortMonthAdjusted: true });
    expect(dueDateFor("2028-02-01", 31)).toEqual({ dueDate: "2028-02-29", shortMonthAdjusted: true });
    expect(dueDateFor("2026-04-01", 31)).toEqual({ dueDate: "2026-04-30", shortMonthAdjusted: true });
    expect(dueDateFor("2026-07-01", 31)).toEqual({ dueDate: "2026-07-31", shortMonthAdjusted: false });
  });
  it("day 30: Şubat kırpılır, 30-günlü aylar dokunulmaz", () => {
    expect(dueDateFor("2027-02-01", 30).dueDate).toBe("2027-02-28");
    expect(dueDateFor("2026-06-01", 30)).toEqual({ dueDate: "2026-06-30", shortMonthAdjusted: false });
  });
  it("day 29: yalnız artık-olmayan Şubat kırpılır", () => {
    expect(dueDateFor("2027-02-01", 29).dueDate).toBe("2027-02-28");
    expect(dueDateFor("2028-02-01", 29)).toEqual({ dueDate: "2028-02-29", shortMonthAdjusted: false });
  });
  it("addMonths yıl sınırını aşar", () => {
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
  });
});

describe("risk ladder", () => {
  it("kritik > geciken > büyük/yığılma/negatif > eksik > yok", () => {
    expect(riskLevelOf(["critical_payment", "overdue"])).toBe("critical");
    expect(riskLevelOf(["overdue", "large_payment"])).toBe("high");
    expect(riskLevelOf(["same_day_cluster"])).toBe("medium");
    expect(riskLevelOf(["negative_amount"])).toBe("medium");
    expect(riskLevelOf(["missing_amount"])).toBe("low");
    expect(riskLevelOf([])).toBe("none");
  });
});

describe("computeRisk — gerçek örüntüler", () => {
  const today = "2026-07-05";
  it("9'una yığılma (3 açık) + 120k kritik; ödenen risk almaz", () => {
    const r = computeRisk(
      [
        { id: "a", dueDate: "2026-07-09", amount: null, status: "unpaid" },
        { id: "b", dueDate: "2026-07-09", amount: null, status: "unpaid" },
        { id: "c", dueDate: "2026-07-09", amount: 120_000, status: "unpaid" },
        { id: "d", dueDate: "2026-07-09", amount: 999_999, status: "paid" },
      ],
      today, T,
    );
    expect(r.get("a")!.reasons).toEqual(["missing_amount", "same_day_cluster"]);
    expect(r.get("a")!.level).toBe("medium");
    expect(r.get("c")!.reasons).toContain("critical_payment");
    expect(r.get("c")!.level).toBe("critical");
    expect(r.get("d")!.reasons).toEqual([]);
    expect(r.get("d")!.level).toBe("none");
  });
  it("geciken: dün vadeli açık → high; eksik tutar null kalır (0 sayılmaz)", () => {
    const r = computeRisk(
      [{ id: "g", dueDate: "2026-07-04", amount: null, status: "unpaid" }],
      today, T,
    );
    expect(r.get("g")!.reasons).toEqual(expect.arrayContaining(["overdue", "missing_amount"]));
    expect(r.get("g")!.level).toBe("high");
  });
  it("büyük eşik sınırı: 50k dahil, 49.999 değil", () => {
    const r = computeRisk(
      [
        { id: "x", dueDate: "2026-07-10", amount: 50_000, status: "unpaid" },
        { id: "y", dueDate: "2026-07-11", amount: 49_999, status: "unpaid" },
      ],
      today, T,
    );
    expect(r.get("x")!.reasons).toContain("large_payment");
    expect(r.get("y")!.reasons).toEqual([]);
  });
});

describe("computeRisk — overpaid (paid/partial, null/negatif güvenli)", () => {
  const today = "2026-07-05";
  it("paid + paidAmount>amount → overpaid, medium", () => {
    const r = computeRisk(
      [{ id: "p", dueDate: "2026-07-09", amount: 1000, paidAmount: 1200, status: "paid" }],
      today, T,
    );
    expect(r.get("p")!.reasons).toContain("overpaid");
    expect(r.get("p")!.level).toBe("medium");
  });
  it("partial + paidAmount>amount → overpaid de değerlendirilir (open dallarıyla birlikte)", () => {
    const r = computeRisk(
      [{ id: "q", dueDate: "2026-07-09", amount: 1000, paidAmount: 1500, status: "partial" }],
      today, T,
    );
    expect(r.get("q")!.reasons).toContain("overpaid");
  });
  it("amount null veya paidAmount null iken hiç tetiklenmez (bilinmeyen ≠ sıfır)", () => {
    const r1 = computeRisk(
      [{ id: "n1", dueDate: "2026-07-09", amount: null, paidAmount: 500, status: "paid" }],
      today, T,
    );
    expect(r1.get("n1")!.reasons).not.toContain("overpaid");
    const r2 = computeRisk(
      [{ id: "n2", dueDate: "2026-07-09", amount: 500, paidAmount: null, status: "paid" }],
      today, T,
    );
    expect(r2.get("n2")!.reasons).not.toContain("overpaid");
  });
  it("negatif amount'ta asla overpaid üretilmez (negative_amount zaten ayrı sinyal)", () => {
    const r = computeRisk(
      [{ id: "neg", dueDate: "2026-07-09", amount: -100, paidAmount: 50, status: "paid" }],
      today, T,
    );
    expect(r.get("neg")!.reasons).not.toContain("overpaid");
  });
  it("paidAmount<=amount iken overpaid üretilmez", () => {
    const r = computeRisk(
      [{ id: "ok", dueDate: "2026-07-09", amount: 1000, paidAmount: 1000, status: "paid" }],
      today, T,
    );
    expect(r.get("ok")!.reasons).not.toContain("overpaid");
  });
});

describe("dayFlags", () => {
  it("bilinen toplam kritik eşiği aşarsa gün kritik; null'lar toplamda yok ama sayımda var", () => {
    const f = dayFlags(
      [
        { id: "1", dueDate: "d", amount: 60_000, status: "unpaid" },
        { id: "2", dueDate: "d", amount: 60_000, status: "unpaid" },
        { id: "3", dueDate: "d", amount: null, status: "unpaid" },
      ],
      T,
    );
    expect(f.count).toBe(3);
    expect(f.cluster).toBe(true);
    expect(f.knownSum).toBe(120_000);
    expect(f.critical).toBe(true);
    expect(f.large).toBe(true);
  });
});
