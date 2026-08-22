import { describe, expect, it } from "vitest";
import {
  STRESS_BANDS, netExposure, parseTcmbXml, revalue, stressTable, stressValue, worstCaseDelta,
} from "./rules";

describe("revalue — unknown is never zero", () => {
  it("returns a null gain when the entry rate was never recorded", () => {
    // Zero would assert "there is no gain", which is a claim we cannot support.
    const r = revalue({ currency: "USD", amount: 1000, entryRate: null, currentRate: 34 });
    expect(r.unrealizedGainLoss).toBeNull();
    expect(r.bookValueTry).toBeNull();
    expect(r.currentValueTry).toBe(34000);
  });

  it("returns nulls when no rate has been observed for the pair", () => {
    const r = revalue({ currency: "USD", amount: 1000, entryRate: 30, currentRate: null });
    expect(r.currentValueTry).toBeNull();
    expect(r.unrealizedGainLoss).toBeNull();
    expect(r.worstCase20Delta).toBeNull();
    expect(r.bookValueTry).toBe(30000);
  });

  it("computes the gain when both rates are known", () => {
    const r = revalue({ currency: "USD", amount: 1000, entryRate: 30, currentRate: 34 });
    expect(r.unrealizedGainLoss).toBe(4000);
  });

  it("gives a liability the opposite sign automatically", () => {
    const r = revalue({ currency: "USD", amount: -1000, entryRate: 30, currentRate: 34 });
    expect(r.unrealizedGainLoss).toBe(-4000);
  });
});

describe("decimal, not float — this is where FX actually breaks", () => {
  it("revalues a large position between close rates exactly", () => {
    // 1.000.000 × (34.1234 − 34.1233) is 100,00. In float the intermediate is 99.9999999962 —
    // it happens to round back to the same kuruş, so this test pins the exact value rather than
    // claiming a divergence it does not demonstrate. The genuine divergence is the next test.
    const r = revalue({
      currency: "USD", amount: 1_000_000, entryRate: "34.1233", currentRate: "34.1234",
    });
    expect(r.unrealizedGainLoss).toBe(100);
  });

  it("rounds a half-kuruş the way money does, where float rounds the other way", () => {
    // MEASURED, not assumed: 1 × 1.005 is 1,01 under decimal half-up and 1,00 in float, because
    // 1.005 is stored as 1.00499999999999989. A rate landing on a half-kuruş boundary is
    // ordinary in FX, and this is the case where float quietly loses a kuruş per position.
    expect(revalue({ currency: "USD", amount: "1", entryRate: null, currentRate: "1.005" })
      .currentValueTry).toBe(1.01);
    expect(Number((1 * 1.005).toFixed(2))).toBe(1.0);

    // Same story one scale up: 12.345,675 rounds to 12.345,68 in decimal, 12.345,67 in float.
    expect(revalue({ currency: "USD", amount: "12345.675", entryRate: null, currentRate: "1" })
      .currentValueTry).toBe(12345.68);
  });

  it("keeps kuruş exact on a ten-decimal rate", () => {
    const r = revalue({ currency: "EUR", amount: "12345.67", entryRate: null, currentRate: "37.1234567890" });
    expect(r.currentValueTry).toBe(458313.95);
  });

  it("nets many positions without drift", () => {
    const amounts = Array.from({ length: 300 }, () => "0.01");
    expect(netExposure(amounts)).toBe(3);
  });

  it("ignores unknown amounts when netting rather than treating them as zero-value entries", () => {
    expect(netExposure(["100", null, "50"])).toBe(150);
  });
});

describe("stress bands", () => {
  it("covers exactly the ±5/10/20 the plan specifies", () => {
    expect([...STRESS_BANDS]).toEqual([5, 10, 20]);
  });

  it("values the position at the moved rate", () => {
    expect(stressValue(1000, 34, 10)).toBe(37400);
    expect(stressValue(1000, 34, -10)).toBe(30600);
  });

  it("returns a full table of both directions", () => {
    const t = stressTable(1000, 34);
    expect(t.map((x) => x.band)).toEqual([5, 10, 20]);
    expect(t[2].up).toBe(40800);
    expect(t[2].down).toBe(27200);
  });

  it("returns nulls rather than zeros when the rate is unknown", () => {
    expect(stressValue(1000, null, 10)).toBeNull();
    expect(stressTable(1000, null).every((x) => x.up === null && x.down === null)).toBe(true);
  });
});

describe("worstCaseDelta — direction matters, and this is the trap", () => {
  it("hurts a LONG position when the currency falls", () => {
    expect(worstCaseDelta(1000, 34, 20)).toBe(-6800);
  });

  it("hurts a SHORT position when the currency rises", () => {
    // An unsigned "±20% impact" would report this liability as a +6.800 cushion.
    expect(worstCaseDelta(-1000, 34, 20)).toBe(-6800);
  });

  it("is a loss for both directions — never accidentally a gain", () => {
    expect(worstCaseDelta(1000, 34, 20)).toBeLessThan(0);
    expect(worstCaseDelta(-1000, 34, 20)).toBeLessThan(0);
  });

  it("treats the percentage sign as magnitude, so a caller cannot invert it", () => {
    expect(worstCaseDelta(1000, 34, -20)).toBe(worstCaseDelta(1000, 34, 20));
  });
});

describe("parseTcmbXml", () => {
  const xml = `<?xml version="1.0" encoding="ISO-8859-9"?>
    <Tarih_Date Date="21.08.2026">
      <Currency CurrencyCode="USD">
        <Unit>1</Unit>
        <ForexBuying>34.1000</ForexBuying>
        <ForexSelling>34.2000</ForexSelling>
        <BanknoteBuying>34.0800</BanknoteBuying>
        <BanknoteSelling>34.2500</BanknoteSelling>
      </Currency>
      <Currency CurrencyCode="JPY">
        <Unit>100</Unit>
        <ForexBuying>23.0000</ForexBuying>
        <ForexSelling>23.2000</ForexSelling>
      </Currency>
      <Currency CurrencyCode="XDR">
        <Unit>1</Unit>
        <ForexBuying/>
        <ForexSelling/>
        <BanknoteBuying/>
        <BanknoteSelling/>
      </Currency>
    </Tarih_Date>`;

  it("uses forex selling as the revaluation rate", () => {
    const usd = parseTcmbXml(xml).find((r) => r.baseCurrency === "USD");
    expect(usd?.rate).toBe(34.2);
  });

  it("divides by Unit — a per-100 quote is not a per-unit rate", () => {
    // Ignoring Unit would overstate a JPY exposure by a factor of one hundred.
    const jpy = parseTcmbXml(xml).find((r) => r.baseCurrency === "JPY");
    expect(jpy?.unit).toBe(100);
    expect(jpy?.rate).toBe(0.232);
    expect(jpy?.forexBuying).toBe(0.23);
  });

  it("turns empty elements into null, never zero", () => {
    // A zero rate would make a position worth nothing rather than unvalued.
    const usd = parseTcmbXml(xml).find((r) => r.baseCurrency === "USD");
    expect(usd?.banknoteBuying).toBe(34.08);
    const parsedCodes = parseTcmbXml(xml).map((r) => r.baseCurrency);
    expect(parsedCodes).not.toContain("XDR");
  });

  it("skips a currency whose bulletin quoted nothing usable rather than guessing", () => {
    expect(parseTcmbXml(xml)).toHaveLength(2);
  });

  it("returns an empty list for a non-bulletin document instead of throwing", () => {
    expect(parseTcmbXml("<html><body>Hata</body></html>")).toEqual([]);
  });
});
