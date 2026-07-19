// Shared Europe/Istanbul civil-date helper. Payment-domain code (payments/radar) must
// import from here directly, never from the reports domain — reports/rules.ts re-exports
// this for its existing callers only. Turkey has used a fixed UTC+3 offset with no DST
// since 2016, so the only edge case is the daily UTC/Istanbul civil-day boundary shift,
// not a repeated/skipped-hour DST transition.

/** Civil (calendar) date in Europe/Istanbul for `now`, as YYYY-MM-DD. Uses
 * formatToParts() rather than relying on a locale's .format() output shape. */
export function istanbulDateISO(now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) throw new Error("istanbulDateISO: geçersiz Date girdisi");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`istanbulDateISO: '${type}' parçası üretilemedi`);
    return part.value;
  };
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Guards engine functions that receive a todayISO/monthStartISO parameter from a
 * caller instead of computing it themselves — rejects a malformed value before any
 * SQL runs, rather than letting it silently mismatch or error deep in a query.
 * Shape alone (regex) is not enough — "2026-02-31" and "2026-13-01" match the shape
 * but aren't real calendar dates. Date.UTC() silently rolls invalid y/m/d over into
 * the next valid date (e.g. Feb 31 -> Mar 3); reconstructing the string from that
 * rolled-over date and requiring it to equal the input catches exactly that drift,
 * without relying on any locale-dependent formatting. */
export function assertISODateString(s: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) {
    throw new Error(`geçersiz ISO tarih parametresi: ${JSON.stringify(s)}`);
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const d = new Date(Date.UTC(year, month - 1, day));
  const normalized =
    `${String(d.getUTCFullYear()).padStart(4, "0")}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")}`;
  if (normalized !== s) {
    throw new Error(`geçersiz ISO tarih parametresi (takvimsel olarak geçersiz): ${JSON.stringify(s)}`);
  }
}
