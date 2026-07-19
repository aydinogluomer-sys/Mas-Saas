import { describe, expect, it } from "vitest";
import { assertISODateString, istanbulDateISO } from "./istanbul";

describe("istanbulDateISO", () => {
  it("shifts civil date to Europe/Istanbul (UTC+3)", () => {
    // 2026-07-06 22:30 UTC = 2026-07-07 01:30 Istanbul → next civil day
    expect(istanbulDateISO(new Date("2026-07-06T22:30:00Z"))).toBe("2026-07-07");
    // 2026-07-06 00:30 UTC = 2026-07-06 03:30 Istanbul → same day
    expect(istanbulDateISO(new Date("2026-07-06T00:30:00Z"))).toBe("2026-07-06");
  });

  it("shifts civil date across a month boundary", () => {
    // 2026-07-31 22:00 UTC = 2026-08-01 01:00 Istanbul → next month
    expect(istanbulDateISO(new Date("2026-07-31T22:00:00Z"))).toBe("2026-08-01");
  });

  it("shifts civil date across a year boundary", () => {
    // 2026-12-31 22:00 UTC = 2027-01-01 01:00 Istanbul → next year
    expect(istanbulDateISO(new Date("2026-12-31T22:00:00Z"))).toBe("2027-01-01");
  });

  it("throws a controlled error for an invalid Date", () => {
    expect(() => istanbulDateISO(new Date("not-a-date"))).toThrow(/geçersiz Date/);
  });
});

describe("assertISODateString", () => {
  it("accepts a well-formed YYYY-MM-DD string", () => {
    expect(() => assertISODateString("2026-07-19")).not.toThrow();
  });

  it("rejects malformed strings", () => {
    expect(() => assertISODateString("")).toThrow(/geçersiz ISO tarih/);
    expect(() => assertISODateString("2026-7-19")).toThrow(/geçersiz ISO tarih/);
    expect(() => assertISODateString("19-07-2026")).toThrow(/geçersiz ISO tarih/);
    expect(() => assertISODateString("2026-07-19T00:00:00Z")).toThrow(/geçersiz ISO tarih/);
  });

  it("rejects calendar-invalid dates that still match the shape (regex alone is not enough)", () => {
    expect(() => assertISODateString("2026-02-31")).toThrow(/takvimsel/); // Şubat 31 çekmez
    expect(() => assertISODateString("2026-13-01")).toThrow(/takvimsel/); // ay 13 yok
    expect(() => assertISODateString("2026-00-10")).toThrow(/takvimsel/); // ay 00 yok
    expect(() => assertISODateString("2025-02-29")).toThrow(/takvimsel/); // 2025 artık yıl değil
  });

  it("accepts Feb 29 in a real leap year", () => {
    expect(() => assertISODateString("2024-02-29")).not.toThrow();
  });
});
