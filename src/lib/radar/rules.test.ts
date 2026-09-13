import { describe, it, expect } from "vitest";
import {
  addMonths, computeRisk, dayFlags, dayFlagsFromAggregate, dueDateFor, riskLevelOf,
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
  it("PHASE 2.2: unsupported_currency geciken'in altında, orta'nın üstünde — kesin olgu kazanır, bilinmeyen eşik ortayı geçer", () => {
    expect(riskLevelOf(["unsupported_currency"])).toBe("unsupported_currency");
    expect(riskLevelOf(["unsupported_currency", "same_day_cluster"])).toBe("unsupported_currency");
    expect(riskLevelOf(["unsupported_currency", "overdue"])).toBe("high");
    expect(riskLevelOf(["unsupported_currency", "overpaid"])).toBe("unsupported_currency");
  });
});

describe("computeRisk — gerçek örüntüler", () => {
  const today = "2026-07-05";
  it("9'una yığılma (3 açık) + 120k kritik; ödenen risk almaz", () => {
    const r = computeRisk(
      [
        { id: "a", dueDate: "2026-07-09", amount: null, status: "unpaid", currency: "TRY" },
        { id: "b", dueDate: "2026-07-09", amount: null, status: "unpaid", currency: "TRY" },
        { id: "c", dueDate: "2026-07-09", amount: 120_000, status: "unpaid", currency: "TRY" },
        { id: "d", dueDate: "2026-07-09", amount: 999_999, status: "paid", currency: "TRY" },
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
      [{ id: "g", dueDate: "2026-07-04", amount: null, status: "unpaid", currency: "TRY" }],
      today, T,
    );
    expect(r.get("g")!.reasons).toEqual(expect.arrayContaining(["overdue", "missing_amount"]));
    expect(r.get("g")!.level).toBe("high");
  });
  it("büyük eşik sınırı: 50k dahil, 49.999 değil", () => {
    const r = computeRisk(
      [
        { id: "x", dueDate: "2026-07-10", amount: 50_000, status: "unpaid", currency: "TRY" },
        { id: "y", dueDate: "2026-07-11", amount: 49_999, status: "unpaid", currency: "TRY" },
      ],
      today, T,
    );
    expect(r.get("x")!.reasons).toContain("large_payment");
    expect(r.get("y")!.reasons).toEqual([]);
  });
});

/**
 * PHASE 2.2 (T1-b) — para birimi karışık kalemler. Beklenenler ELLE yazıldı.
 * Eşikler TRY; TRY-dışı kalem eşikle KARŞILAŞTIRILMAZ (ne kritik ne büyük), sessizce de geçmez:
 * 'unsupported_currency' gerekçesi ve seviyesi DB'ye iner. Yığılma/gecikme para biriminden
 * bağımsız kalır; tutar null / negatif dalları para biriminden ÖNCE gelir.
 */
describe("computeRisk — TRY-dışı kalem eşikle tartılmaz, ayrı işaretlenir", () => {
  const today = "2026-07-05";
  it("120k USD açık kalem: critical_payment DEĞİL, unsupported_currency; TRY 120k aynı gün kritik", () => {
    const r = computeRisk(
      [
        { id: "usd", dueDate: "2026-07-09", amount: 120_000, status: "unpaid", currency: "USD" },
        { id: "try", dueDate: "2026-07-09", amount: 120_000, status: "unpaid", currency: "TRY" },
      ],
      today, T,
    );
    expect(r.get("usd")).toEqual({ reasons: ["unsupported_currency"], level: "unsupported_currency" });
    expect(r.get("try")).toEqual({ reasons: ["critical_payment"], level: "critical" });
  });
  it("küçük EUR tutar da işaretlenir: eşik ALTI olduğu da bilinemez (kur yok)", () => {
    const r = computeRisk(
      [{ id: "eur", dueDate: "2026-07-09", amount: 10, status: "unpaid", currency: "EUR" }],
      today, T,
    );
    expect(r.get("eur")).toEqual({ reasons: ["unsupported_currency"], level: "unsupported_currency" });
  });
  it("para birimi null (bilinmiyor): TRY varsayılmaz, unsupported_currency", () => {
    const r = computeRisk(
      [{ id: "n", dueDate: "2026-07-09", amount: 75_000, status: "unpaid", currency: null }],
      today, T,
    );
    expect(r.get("n")).toEqual({ reasons: ["unsupported_currency"], level: "unsupported_currency" });
  });
  it("geciken USD: overdue kesin olgu → high; gerekçelerde ikisi de var", () => {
    const r = computeRisk(
      [{ id: "g", dueDate: "2026-07-04", amount: 500_000, status: "unpaid", currency: "USD" }],
      today, T,
    );
    expect(r.get("g")).toEqual({ reasons: ["unsupported_currency", "overdue"], level: "high" });
  });
  it("yığılma para biriminden bağımsız: 2 USD + 1 TRY aynı gün → üçü de same_day_cluster", () => {
    const r = computeRisk(
      [
        { id: "a", dueDate: "2026-07-09", amount: 1_000, status: "unpaid", currency: "USD" },
        { id: "b", dueDate: "2026-07-09", amount: 1_000, status: "unpaid", currency: "USD" },
        { id: "c", dueDate: "2026-07-09", amount: 1_000, status: "unpaid", currency: "TRY" },
      ],
      today, T,
    );
    expect(r.get("a")).toEqual({ reasons: ["unsupported_currency", "same_day_cluster"], level: "unsupported_currency" });
    expect(r.get("c")).toEqual({ reasons: ["same_day_cluster"], level: "medium" });
  });
  it("tutar null veya negatif TRY-dışı kalem: eksik/negatif gerekçesi öncelikli, unsupported_currency yazılmaz", () => {
    const r = computeRisk(
      [
        { id: "nul", dueDate: "2026-07-09", amount: null, status: "unpaid", currency: "USD" },
        { id: "neg", dueDate: "2026-07-09", amount: -500, status: "unpaid", currency: "USD" },
      ],
      today, T,
    );
    expect(r.get("nul")).toEqual({ reasons: ["missing_amount"], level: "low" });
    expect(r.get("neg")).toEqual({ reasons: ["negative_amount"], level: "medium" });
  });
  it("ödenmiş TRY-dışı kalem hiç gerekçe almaz (açık değil); overpaid aynı satır içi karşılaştırmadır", () => {
    const r = computeRisk(
      [
        { id: "p", dueDate: "2026-07-09", amount: 900_000, status: "paid", paidAmount: 900_000, currency: "USD" },
        { id: "o", dueDate: "2026-07-09", amount: 1_000, status: "paid", paidAmount: 1_200, currency: "USD" },
      ],
      today, T,
    );
    expect(r.get("p")).toEqual({ reasons: [], level: "none" });
    expect(r.get("o")).toEqual({ reasons: ["overpaid"], level: "medium" });
  });
});

describe("computeRisk — overpaid (paid/partial, null/negatif güvenli)", () => {
  const today = "2026-07-05";
  it("paid + paidAmount>amount → overpaid, medium", () => {
    const r = computeRisk(
      [{ id: "p", dueDate: "2026-07-09", amount: 1000, paidAmount: 1200, status: "paid", currency: "TRY" }],
      today, T,
    );
    expect(r.get("p")!.reasons).toContain("overpaid");
    expect(r.get("p")!.level).toBe("medium");
  });
  it("partial + paidAmount>amount → overpaid de değerlendirilir (open dallarıyla birlikte)", () => {
    const r = computeRisk(
      [{ id: "q", dueDate: "2026-07-09", amount: 1000, paidAmount: 1500, status: "partial", currency: "TRY" }],
      today, T,
    );
    expect(r.get("q")!.reasons).toContain("overpaid");
  });
  it("amount null veya paidAmount null iken hiç tetiklenmez (bilinmeyen ≠ sıfır)", () => {
    const r1 = computeRisk(
      [{ id: "n1", dueDate: "2026-07-09", amount: null, paidAmount: 500, status: "paid", currency: "TRY" }],
      today, T,
    );
    expect(r1.get("n1")!.reasons).not.toContain("overpaid");
    const r2 = computeRisk(
      [{ id: "n2", dueDate: "2026-07-09", amount: 500, paidAmount: null, status: "paid", currency: "TRY" }],
      today, T,
    );
    expect(r2.get("n2")!.reasons).not.toContain("overpaid");
  });
  it("negatif amount'ta asla overpaid üretilmez (negative_amount zaten ayrı sinyal)", () => {
    const r = computeRisk(
      [{ id: "neg", dueDate: "2026-07-09", amount: -100, paidAmount: 50, status: "paid", currency: "TRY" }],
      today, T,
    );
    expect(r.get("neg")!.reasons).not.toContain("overpaid");
  });
  it("paidAmount<=amount iken overpaid üretilmez", () => {
    const r = computeRisk(
      [{ id: "ok", dueDate: "2026-07-09", amount: 1000, paidAmount: 1000, status: "paid", currency: "TRY" }],
      today, T,
    );
    expect(r.get("ok")!.reasons).not.toContain("overpaid");
  });
});

describe("dayFlags", () => {
  it("bilinen toplam kritik eşiği aşarsa gün kritik; null'lar toplamda yok ama sayımda var", () => {
    const f = dayFlags(
      [
        { id: "1", dueDate: "d", amount: 60_000, status: "unpaid", currency: "TRY" },
        { id: "2", dueDate: "d", amount: 60_000, status: "unpaid", currency: "TRY" },
        { id: "3", dueDate: "d", amount: null, status: "unpaid", currency: "TRY" },
      ],
      T,
    );
    expect(f.count).toBe(3);
    expect(f.cluster).toBe(true);
    expect(f.knownSum).toBe(120_000);
    expect(f.critical).toBe(true);
    expect(f.large).toBe(true);
    expect(f.foreignCount).toBe(0);
  });
});

/**
 * PHASE 2.2 (T1-a) — para birimi karışık günler.
 *
 * Eşikler `*_threshold_try`; kur çevirimi YOK (plan §2.1). Beklenenler ELLE yazıldı:
 * TRY-dışı kalem toplama ve eşik kararına GİRMEZ, ama `foreignCount` ile SAYILIR; yığılma
 * (`count`/`cluster`) sayım kuralı olduğu için para biriminden bağımsız her açık kalemi sayar.
 */
describe("dayFlags — para birimi karışık gün (TRY eşikleri yalnız TRY kalemlere uygulanır)", () => {
  it("120k USD tek başına günü kritik yapmaz; TRY 30k toplamı 30k, 1 kalem TRY-dışı", () => {
    const f = dayFlags(
      [
        { id: "u", dueDate: "d", amount: 120_000, status: "unpaid", currency: "USD" },
        { id: "t", dueDate: "d", amount: 30_000, status: "unpaid", currency: "TRY" },
      ],
      T,
    );
    // count = 2 açık kalem (para biriminden bağımsız); cluster 2 < 3 → false.
    // knownSum = yalnız TRY: 30.000. large: 30.000 < 50.000 → false. critical: false.
    // foreignCount = 1 (USD kalemi eşik dışı bırakıldı ama sayıldı).
    expect(f).toEqual({ count: 2, knownSum: 30_000, cluster: false, large: false, critical: false, foreignCount: 1 });
  });

  it("TRY toplamı tek başına eşiği aşıyorsa gün kritiktir; EUR kalem toplamı şişirmez", () => {
    const f = dayFlags(
      [
        { id: "e", dueDate: "d", amount: 5_000, status: "unpaid", currency: "EUR" },
        { id: "a", dueDate: "d", amount: 60_000, status: "unpaid", currency: "TRY" },
        { id: "b", dueDate: "d", amount: 40_000, status: "unpaid", currency: "TRY" },
      ],
      T,
    );
    // knownSum = 60.000 + 40.000 = 100.000 (EUR 5.000 girmez) → critical (>= 100.000) true.
    // large: 60.000 >= 50.000 → true. count = 3 → cluster true. foreignCount = 1.
    expect(f).toEqual({ count: 3, knownSum: 100_000, cluster: true, large: true, critical: true, foreignCount: 1 });
  });

  it("para birimi null (bilinmiyor) TRY VARSAYILMAZ: eşik dışı ve sayılır", () => {
    const f = dayFlags(
      [{ id: "n", dueDate: "d", amount: 500_000, status: "unpaid", currency: null }],
      T,
    );
    expect(f).toEqual({ count: 1, knownSum: 0, cluster: false, large: false, critical: false, foreignCount: 1 });
  });

  it("ödenmiş TRY-dışı kalem hiçbir sayıma girmez (açık değil)", () => {
    const f = dayFlags(
      [{ id: "p", dueDate: "d", amount: 900_000, status: "paid", currency: "USD" }],
      T,
    );
    expect(f).toEqual({ count: 0, knownSum: 0, cluster: false, large: false, critical: false, foreignCount: 0 });
  });

  it("yalnız TRY-dışı kalemlerden oluşan 3'lük gün: yığılma VAR, tutar bayrağı YOK, 3 TRY-dışı", () => {
    const f = dayFlags(
      [
        { id: "1", dueDate: "d", amount: 200_000, status: "unpaid", currency: "USD" },
        { id: "2", dueDate: "d", amount: 200_000, status: "unpaid", currency: "USD" },
        { id: "3", dueDate: "d", amount: 200_000, status: "late", currency: "GBP" },
      ],
      T,
    );
    expect(f).toEqual({ count: 3, knownSum: 0, cluster: true, large: false, critical: false, foreignCount: 3 });
  });
});

describe("dayFlagsFromAggregate — toplanmış girdi foreignCount'u olduğu gibi taşır", () => {
  it("SQL tarafında TRY süzülmüş toplam: 30k / max 30k / 1 TRY-dışı → dayFlags ile aynı cevap", () => {
    const f = dayFlagsFromAggregate({ openCount: 2, knownSum: 30_000, maxAmount: 30_000, foreignCount: 1 }, T);
    expect(f).toEqual({ count: 2, knownSum: 30_000, cluster: false, large: false, critical: false, foreignCount: 1 });
  });

  it("yalnız TRY-dışı gün: maxAmount null, knownSum 0, openCount 3 → yığılma var, tutar bayrağı yok", () => {
    const f = dayFlagsFromAggregate({ openCount: 3, knownSum: 0, maxAmount: null, foreignCount: 3 }, T);
    expect(f).toEqual({ count: 3, knownSum: 0, cluster: true, large: false, critical: false, foreignCount: 3 });
  });
});
