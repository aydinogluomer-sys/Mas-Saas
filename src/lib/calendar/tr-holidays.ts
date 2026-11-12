// Faz 46 (C3) — Turkish official public holidays (2429 Sayılı Kanun) and VUK Md. 18
// business-day roll-forward engine (2026–2030 deterministic table, pure TypeScript, zero IO).

export interface TrHolidayInfo {
  isoDate: string;
  name: string;
  kind: "fixed_national" | "religious" | "arife";
  halfDay: boolean;
}

export interface BusinessDayShiftResult {
  effectiveDate: string;
  shiftedFrom: string | null;
  reason: string | null;
}

const FIXED_HOLIDAYS: ReadonlyArray<{ mmdd: string; name: string; kind: TrHolidayInfo["kind"]; halfDay: boolean }> = [
  { mmdd: "01-01", name: "Yılbaşı", kind: "fixed_national", halfDay: false },
  { mmdd: "04-23", name: "Ulusal Egemenlik ve Çocuk Bayramı", kind: "fixed_national", halfDay: false },
  { mmdd: "05-01", name: "Emek ve Dayanışma Günü", kind: "fixed_national", halfDay: false },
  { mmdd: "05-19", name: "Atatürk'ü Anma, Gençlik ve Spor Bayramı", kind: "fixed_national", halfDay: false },
  { mmdd: "07-15", name: "Demokrasi ve Millî Birlik Günü", kind: "fixed_national", halfDay: false },
  { mmdd: "08-30", name: "Zafer Bayramı", kind: "fixed_national", halfDay: false },
  { mmdd: "10-28", name: "Cumhuriyet Bayramı Arifesi", kind: "arife", halfDay: true },
  { mmdd: "10-29", name: "Cumhuriyet Bayramı", kind: "fixed_national", halfDay: false },
];

/**
 * Diyanet İşleri Başkanlığı 2026–2030 religious holiday table (Ramazan & Kurban Bayramı + Arife).
 */
export const RELIGIOUS_HOLIDAYS_2026_2030: ReadonlyArray<TrHolidayInfo> = [
  // 2026 — Ramazan Bayramı
  { isoDate: "2026-03-19", name: "Ramazan Bayramı Arifesi", kind: "arife", halfDay: true },
  { isoDate: "2026-03-20", name: "Ramazan Bayramı 1. Gün", kind: "religious", halfDay: false },
  { isoDate: "2026-03-21", name: "Ramazan Bayramı 2. Gün", kind: "religious", halfDay: false },
  { isoDate: "2026-03-22", name: "Ramazan Bayramı 3. Gün", kind: "religious", halfDay: false },
  // 2026 — Kurban Bayramı
  { isoDate: "2026-05-26", name: "Kurban Bayramı Arifesi", kind: "arife", halfDay: true },
  { isoDate: "2026-05-27", name: "Kurban Bayramı 1. Gün", kind: "religious", halfDay: false },
  { isoDate: "2026-05-28", name: "Kurban Bayramı 2. Gün", kind: "religious", halfDay: false },
  { isoDate: "2026-05-29", name: "Kurban Bayramı 3. Gün", kind: "religious", halfDay: false },
  { isoDate: "2026-05-30", name: "Kurban Bayramı 4. Gün", kind: "religious", halfDay: false },

  // 2027 — Ramazan Bayramı
  { isoDate: "2027-03-08", name: "Ramazan Bayramı Arifesi", kind: "arife", halfDay: true },
  { isoDate: "2027-03-09", name: "Ramazan Bayramı 1. Gün", kind: "religious", halfDay: false },
  { isoDate: "2027-03-10", name: "Ramazan Bayramı 2. Gün", kind: "religious", halfDay: false },
  { isoDate: "2027-03-11", name: "Ramazan Bayramı 3. Gün", kind: "religious", halfDay: false },
  // 2027 — Kurban Bayramı
  { isoDate: "2027-05-15", name: "Kurban Bayramı Arifesi", kind: "arife", halfDay: true },
  { isoDate: "2027-05-16", name: "Kurban Bayramı 1. Gün", kind: "religious", halfDay: false },
  { isoDate: "2027-05-17", name: "Kurban Bayramı 2. Gün", kind: "religious", halfDay: false },
  { isoDate: "2027-05-18", name: "Kurban Bayramı 3. Gün", kind: "religious", halfDay: false },
  { isoDate: "2027-05-19", name: "Kurban Bayramı 4. Gün", kind: "religious", halfDay: false },

  // 2028 — Ramazan Bayramı
  { isoDate: "2028-02-25", name: "Ramazan Bayramı Arifesi", kind: "arife", halfDay: true },
  { isoDate: "2028-02-26", name: "Ramazan Bayramı 1. Gün", kind: "religious", halfDay: false },
  { isoDate: "2028-02-27", name: "Ramazan Bayramı 2. Gün", kind: "religious", halfDay: false },
  { isoDate: "2028-02-28", name: "Ramazan Bayramı 3. Gün", kind: "religious", halfDay: false },
  // 2028 — Kurban Bayramı
  { isoDate: "2028-05-04", name: "Kurban Bayramı Arifesi", kind: "arife", halfDay: true },
  { isoDate: "2028-05-05", name: "Kurban Bayramı 1. Gün", kind: "religious", halfDay: false },
  { isoDate: "2028-05-06", name: "Kurban Bayramı 2. Gün", kind: "religious", halfDay: false },
  { isoDate: "2028-05-07", name: "Kurban Bayramı 3. Gün", kind: "religious", halfDay: false },
  { isoDate: "2028-05-08", name: "Kurban Bayramı 4. Gün", kind: "religious", halfDay: false },

  // 2029 — Ramazan Bayramı
  { isoDate: "2029-02-13", name: "Ramazan Bayramı Arifesi", kind: "arife", halfDay: true },
  { isoDate: "2029-02-14", name: "Ramazan Bayramı 1. Gün", kind: "religious", halfDay: false },
  { isoDate: "2029-02-15", name: "Ramazan Bayramı 2. Gün", kind: "religious", halfDay: false },
  { isoDate: "2029-02-16", name: "Ramazan Bayramı 3. Gün", kind: "religious", halfDay: false },
  // 2029 — Kurban Bayramı
  { isoDate: "2029-04-23", name: "Kurban Bayramı Arifesi", kind: "arife", halfDay: true },
  { isoDate: "2029-04-24", name: "Kurban Bayramı 1. Gün", kind: "religious", halfDay: false },
  { isoDate: "2029-04-25", name: "Kurban Bayramı 2. Gün", kind: "religious", halfDay: false },
  { isoDate: "2029-04-26", name: "Kurban Bayramı 3. Gün", kind: "religious", halfDay: false },
  { isoDate: "2029-04-27", name: "Kurban Bayramı 4. Gün", kind: "religious", halfDay: false },

  // 2030 — Ramazan Bayramı
  { isoDate: "2030-02-03", name: "Ramazan Bayramı Arifesi", kind: "arife", halfDay: true },
  { isoDate: "2030-02-04", name: "Ramazan Bayramı 1. Gün", kind: "religious", halfDay: false },
  { isoDate: "2030-02-05", name: "Ramazan Bayramı 2. Gün", kind: "religious", halfDay: false },
  { isoDate: "2030-02-06", name: "Ramazan Bayramı 3. Gün", kind: "religious", halfDay: false },
  // 2030 — Kurban Bayramı
  { isoDate: "2030-04-12", name: "Kurban Bayramı Arifesi", kind: "arife", halfDay: true },
  { isoDate: "2030-04-13", name: "Kurban Bayramı 1. Gün", kind: "religious", halfDay: false },
  { isoDate: "2030-04-14", name: "Kurban Bayramı 2. Gün", kind: "religious", halfDay: false },
  { isoDate: "2030-04-15", name: "Kurban Bayramı 3. Gün", kind: "religious", halfDay: false },
  { isoDate: "2030-04-16", name: "Kurban Bayramı 4. Gün", kind: "religious", halfDay: false },
];

const RELIGIOUS_BY_DATE = new Map<string, TrHolidayInfo>(
  RELIGIOUS_HOLIDAYS_2026_2030.map((h) => [h.isoDate, h]),
);

function addDaysUtc(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Look up Turkish official holiday metadata for an ISO date (`YYYY-MM-DD`).
 * Full-day national holidays take precedence when overlapping a half-day religious Arife (e.g. 2029-04-23).
 */
export function getTurkishHoliday(
  isoDate: string,
  options: { includeHalfDayArife?: boolean } = {},
): TrHolidayInfo | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const includeHalfDay = options.includeHalfDayArife ?? true;
  const mmdd = isoDate.slice(5, 10);

  const fixed = FIXED_HOLIDAYS.find((f) => f.mmdd === mmdd) ?? null;
  const religious = RELIGIOUS_BY_DATE.get(isoDate) ?? null;

  // Prefer full-day holiday over half-day arife if both fall on the same date.
  const candidates = [
    fixed ? { isoDate, name: fixed.name, kind: fixed.kind, halfDay: fixed.halfDay } : null,
    religious,
  ].filter((x): x is TrHolidayInfo => x !== null);

  if (candidates.length === 0) return null;
  const fullDay = candidates.find((c) => !c.halfDay);
  if (fullDay) return fullDay;
  return includeHalfDay ? candidates[0] : null;
}

export function isTurkishHoliday(
  isoDate: string,
  options: { includeHalfDayArife?: boolean } = {},
): boolean {
  return getTurkishHoliday(isoDate, options) !== null;
}

export function listTurkishHolidaysForYear(year: number): TrHolidayInfo[] {
  const fixedForYear: TrHolidayInfo[] = FIXED_HOLIDAYS.map((f) => ({
    isoDate: `${year}-${f.mmdd}`,
    name: f.name,
    kind: f.kind,
    halfDay: f.halfDay,
  }));
  const religiousForYear = RELIGIOUS_HOLIDAYS_2026_2030.filter((h) =>
    h.isoDate.startsWith(`${year}-`),
  );
  const byDate = new Map<string, TrHolidayInfo>();
  for (const h of [...fixedForYear, ...religiousForYear]) {
    const existing = byDate.get(h.isoDate);
    if (!existing) {
      byDate.set(h.isoDate, h);
    } else if (existing.halfDay && !h.halfDay) {
      byDate.set(h.isoDate, h);
    }
  }
  return [...byDate.values()].sort((a, b) => a.isoDate.localeCompare(b.isoDate));
}

function nonBusinessDayReason(
  isoDate: string,
  includeHalfDayArife: boolean,
): string | null {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  const weekendName = dow === 6 ? "Cumartesi" : dow === 0 ? "Pazar" : null;
  const holiday = getTurkishHoliday(isoDate, { includeHalfDayArife });
  if (holiday && weekendName) return `${holiday.name} (${weekendName})`;
  if (holiday) return holiday.name;
  if (weekendName) return `Hafta sonu (${weekendName})`;
  return null;
}

/**
 * VUK Md. 18/4 statutory deadline roll-forward:
 * When the final day of a statutory period falls on a weekend or Turkish official holiday
 * (including half-day official holiday afternoons where end-of-business-hours is closed per GİB practice),
 * the deadline shifts forward to the first Turkish business day.
 */
export function nextTurkishBusinessDay(
  isoDate: string,
  options: { includeHalfDayArife?: boolean } = {},
): BusinessDayShiftResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(`Geçersiz ISO tarih formatı: ${isoDate}`);
  }
  const includeHalfDayArife = options.includeHalfDayArife ?? true;
  const reasons: string[] = [];
  let cursor = isoDate;

  for (let guard = 0; guard < 20; guard += 1) {
    const reason = nonBusinessDayReason(cursor, includeHalfDayArife);
    if (!reason) {
      return reasons.length === 0
        ? { effectiveDate: cursor, shiftedFrom: null, reason: null }
        : {
            effectiveDate: cursor,
            shiftedFrom: isoDate,
            reason: `VUK Md. 18 kaydırması: ${reasons.join(" → ")}`,
          };
    }
    if (!reasons.includes(reason)) reasons.push(reason);
    cursor = addDaysUtc(cursor, 1);
  }

  return {
    effectiveDate: cursor,
    shiftedFrom: isoDate,
    reason: `VUK Md. 18 kaydırması: ${reasons.join(" → ")}`,
  };
}

