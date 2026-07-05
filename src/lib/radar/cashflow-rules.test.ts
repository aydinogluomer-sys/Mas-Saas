import { describe, it, expect } from "vitest";
import {
  buildProjection, concentration, findContinuityIssues, horizonCards, type CashMonth,
} from "./rules";

const M = (monthStart: string, opening: number | null, income: number | null, expense: number | null, closing: number | null): CashMonth =>
  ({ monthStart, opening, income, expense, closing });

describe("findContinuityIssues", () => {
  it("kırık zincir: prev.closing ≠ next.opening (±1 tolerans) → flag, değer DEĞİŞMEZ", () => {
    const months = [M("2026-05-01", 0, 100, 50, 50), M("2026-06-01", 50, 10, 5, 55), M("2026-07-01", 999, 0, 0, 999)];
    const r = findContinuityIssues(months);
    expect(r.breaks).toHaveLength(1);
    expect(r.breaks[0]).toMatchObject({ prevMonth: "2026-06-01", nextMonth: "2026-07-01", diff: 944 });
    expect(months[2].opening).toBe(999); // silently-fix yok
  });
  it("±1 yuvarlama toleransı kırık sayılmaz; null taraf kırık sayılır (diff null)", () => {
    const ok = findContinuityIssues([M("2026-05-01", 0, 0, 0, 100), M("2026-06-01", 101, 0, 0, 0)]);
    expect(ok.breaks).toHaveLength(0);
    const nul = findContinuityIssues([M("2026-05-01", 0, 0, 0, null), M("2026-06-01", 100, 0, 0, 0)]);
    expect(nul.breaks).toHaveLength(1);
    expect(nul.breaks[0].diff).toBeNull();
  });
  it("ay boşluğu gap olarak raporlanır, zincir karşılaştırması yapılmaz", () => {
    const r = findContinuityIssues([M("2026-05-01", 0, 0, 0, 10), M("2026-08-01", 999, 0, 0, 0)]);
    expect(r.gaps).toEqual([{ afterMonth: "2026-05-01", expected: "2026-06-01" }]);
    expect(r.breaks).toHaveLength(0);
  });
});

describe("buildProjection", () => {
  const series = [
    M("2026-05-01", 0, 100, 50, 480_000),
    M("2026-06-01", 0, 0, 0, 118_000),
    M("2026-07-01", 0, 0, 0, -50_000),
    M("2026-08-01", 0, 0, 0, -725_000),
    M("2026-09-01", 0, 0, 0, 10_000),
    M("2026-10-01", 0, 0, 0, -3_064_000),
  ];
  it("ilk negatif ay + en kötü ay + en uzun negatif seri", () => {
    const p = buildProjection(series);
    expect(p.firstNegativeMonth).toBe("2026-07-01");
    expect(p.worstMonth).toBe("2026-10-01");
    expect(p.worstBalance).toBe(-3_064_000);
    expect(p.longestNegativeRun).toEqual({ length: 2, from: "2026-07-01" });
  });
  it("null kasa negatif seriyi bozar (bilinmeyen üstünden süreklilik iddiası yok)", () => {
    const p = buildProjection([M("a-01-01",0,0,0,-1), M("a-02-01",0,0,0,null), M("a-03-01",0,0,0,-1)].map((m,i)=>({...m, monthStart:`2027-0${i+1}-01`})));
    expect(p.longestNegativeRun.length).toBe(1);
  });
});

describe("horizonCards", () => {
  const months = Array.from({ length: 10 }, (_, i) =>
    M(`2026-${String(i + 1).padStart(2, "0")}-01`, 0, 100, 60, i === 4 ? -5 : 10 * (i + 1)));
  it("3/6/12: pencere toplamları, min, ilk-negatif, veri biterse truncated", () => {
    const [h3, h6, h12] = horizonCards(months, "2026-01-01", [3, 6, 12]);
    expect(h3.toMonth).toBe("2026-03-01");
    expect(h3.knownIncome).toBe(300);
    expect(h3.truncated).toBe(false);
    expect(h6.firstNegativeInside).toBe("2026-05-01");
    expect(h6.minClosing).toBe(-5);
    expect(h12.truncated).toBe(true);
    expect(h12.toMonth).toBe("2026-10-01");
  });
  it("anchor veri aralığının dışında geriye düşerse ilk aydan başlar; eksik ay sayacı", () => {
    const withNull = [...months]; withNull[2] = M("2026-03-01", 0, null, 60, 30);
    const [h6] = horizonCards(withNull, "2000-01-01", [6]);
    expect(h6.fromMonth).toBe("2026-01-01");
    expect(h6.missingCount).toBe(1);
  });
});

describe("concentration", () => {
  it(">0.40 bayraklı; null'lar payda dışı ve sayılı; negatifler katılmaz", () => {
    const r = concentration([
      { key: "akon", amount: 800 },
      { key: "metsan", amount: 150 },
      { key: "hpt", amount: 50 },
      { key: null, amount: 100 },
      { key: "x", amount: null },
      { key: "neg", amount: -500 },
    ]);
    expect(r.knownTotal).toBe(1100);
    expect(r.unknownCount).toBe(1);
    expect(r.entries[0]).toMatchObject({ key: "akon", flagged: true });
    expect(r.entries.find((e) => e.key === "metsan")!.flagged).toBe(false);
    expect(r.entries.find((e) => e.key === "neg")).toBeUndefined();
  });
});
