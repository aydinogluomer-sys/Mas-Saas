// Faz 12 / Faz 62 — the pure alert predicates behind scripts/ops/telemetry-snapshot.ts.
//
// WHY THESE LIVE APART FROM THE SNAPSHOT SCRIPT.
//
// A fail-closed alert is only worth anything if something proves it actually fires when it should
// AND stays quiet when it should not. The snapshot reads live signals (a pg pool, the backups
// directory, pg_stat_activity) and cannot be unit-tested without standing all of that up. These
// predicates take the value that was ALREADY read and only decide — so every threshold boundary
// and, more importantly, every "cannot determine" case can be asserted in vitest with zero I/O.
// telemetry-snapshot.ts imports these, so the tool and its test share one definition and the gate
// cannot silently drift from the thing it guards.
//
// THE ONE INVARIANT EVERY PREDICATE HERE OBEYS: "cannot determine" is an ALERT, never "probably
// fine". A signal whose own data source broke must fail loud — an alert that goes quiet when it
// goes blind reports health it cannot see, which is worse than no alert at all. Each function's
// doc says exactly how its unknown/malformed input maps to `true`.
//
// The SQL-backed signals arrive as text because scripts/ops/telemetry-snapshot.ts reads them with
// a `select … ::text` helper; "?" is that helper's marker for a query that threw.

/** Backup age in hours. `ageHours` is +Infinity when no dump exists and NaN when a stat failed;
 *  both satisfy `!(x <= threshold)`, so both alert. A genuinely fresh backup (age ≤ threshold) is
 *  the only value that clears. */
export function backupAgeAlert(ageHours: number, thresholdHours: number): boolean {
  return !(ageHours <= thresholdHours);
}

export interface OffDeviceRunStatus {
  value: string;
  alert: boolean;
  note: string;
}

/**
 * Evaluates the latest daily backup run record (`backups/daily-runs.jsonl`) and optional
 * off-device copy receipt (`<dump>.offdevice.json`) so an `exit 3` ("single copy / off-device
 * missing") or failed nightly backup run can NEVER report a fake `TELEMETRY: ALL CLEAR` (Faz 43 / B3).
 *
 * Faz 62: Inspects `rawJsonl` FIRST when present so an operational failure such as
 * `ENOENT: no such file or directory, mkdir 'D:\...'` (`offDeviceOk === false`) is surfaced in
 * `note` instead of being masked by generic `.offdevice.json makbuzu yok`.
 */
export function evaluateOffDeviceRunLog(
  rawJsonl: string | null,
  offDeviceReceipt?: { exists: boolean; offDeviceSatisfied?: boolean; sha256VerifiedAtDestination?: boolean } | null,
): OffDeviceRunStatus {
  if (rawJsonl !== null && rawJsonl.trim() !== "") {
    const lines = rawJsonl
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const lastLine = lines[lines.length - 1]!;
    let parsed: Record<string, unknown>;
    try {
      const candidate = JSON.parse(lastLine) as unknown;
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return {
          value: "BOZUK KOŞU KAYDI",
          alert: true,
          note: "daily-runs.jsonl son satırı JSON nesnesi değil",
        };
      }
      parsed = candidate as Record<string, unknown>;
    } catch {
      return {
        value: "BOZUK KOŞU KAYDI",
        alert: true,
        note: "daily-runs.jsonl son satırı ayrıştırılamadı (fail-closed)",
      };
    }

    const exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : null;
    const ok = parsed.ok === true;
    const offDeviceOk = parsed.offDeviceOk === true;
    const offDeviceNote =
      typeof parsed.offDeviceNote === "string" && parsed.offDeviceNote.trim() !== ""
        ? parsed.offDeviceNote.trim().slice(0, 220)
        : null;
    const errorNote =
      typeof parsed.error === "string" && parsed.error.trim() !== ""
        ? parsed.error.trim().slice(0, 220)
        : null;

    if (exitCode === 3) {
      return {
        value: "TEK KOPYA (exit 3)",
        alert: true,
        note: offDeviceNote ?? errorNote ?? "harici (off-device) yedek kopyası doğrulanamadı",
      };
    }
    if (!ok || (exitCode !== null && exitCode !== 0)) {
      const stage = typeof parsed.stage === "string" ? parsed.stage : "bilinmiyor";
      const cause = offDeviceNote ?? errorNote;
      return {
        value: `SON KOŞU BAŞARISIZ (exit ${exitCode ?? "?"})`,
        alert: true,
        note: cause ? `stage=${stage} · ${cause}` : `stage=${stage}`,
      };
    }

    if (offDeviceReceipt) {
      if (!offDeviceReceipt.exists) {
        return {
          value: "HARİCİ KOPYA EKSİK",
          alert: true,
          note:
            !offDeviceOk && offDeviceNote
              ? `${offDeviceNote} (.offdevice.json makbuzu yok)`
              : "MAS_OFFDEVICE_BACKUP_DIR tanımlı ama en yeni dump için .offdevice.json makbuzu yok",
        };
      }
      if (
        offDeviceReceipt.offDeviceSatisfied !== true ||
        offDeviceReceipt.sha256VerifiedAtDestination !== true
      ) {
        return {
          value: "HARİCİ KOPYA DOĞRULANMADI",
          alert: true,
          note: `offDeviceSatisfied=${String(offDeviceReceipt.offDeviceSatisfied)} sha256Verified=${String(offDeviceReceipt.sha256VerifiedAtDestination)}`,
        };
      }
    }

    if (offDeviceOk) {
      return {
        value: "DOĞRULANDI",
        alert: false,
        note: offDeviceNote ?? "harici kopya doğrulandı",
      };
    }
    return {
      value: "KABUL EDİLDİ (exit 0)",
      alert: false,
      note: offDeviceNote ?? "MAS_OFFDEVICE_ACKNOWLEDGED_MISSING=1 ile bilinçli kabul",
    };
  }

  if (offDeviceReceipt) {
    if (!offDeviceReceipt.exists) {
      return {
        value: "HARİCİ KOPYA EKSİK",
        alert: true,
        note: "MAS_OFFDEVICE_BACKUP_DIR tanımlı ama en yeni dump için .offdevice.json makbuzu yok",
      };
    }
    if (
      offDeviceReceipt.offDeviceSatisfied !== true ||
      offDeviceReceipt.sha256VerifiedAtDestination !== true
    ) {
      return {
        value: "HARİCİ KOPYA DOĞRULANMADI",
        alert: true,
        note: `offDeviceSatisfied=${String(offDeviceReceipt.offDeviceSatisfied)} sha256Verified=${String(offDeviceReceipt.sha256VerifiedAtDestination)}`,
      };
    }
  }

  return {
    value: "(henüz günlük koşu kaydı yok)",
    alert: false,
    note: "daily-runs.jsonl henüz oluşmadı",
  };
}

/** Background jobs stuck in 'running' past the reaper window. `runningTooLong` is the count as
 *  text; "?" marks a failed query and alerts. Only an explicit "0" clears. */
export function jobsStuckAlert(runningTooLong: string): boolean {
  return runningTooLong === "?" || Number(runningTooLong) > 0;
}

/** Age in days of the most recent imported workbook. "?" = query failed, "İÇE AKTARIM YOK" =
 *  no workbook has ever been imported; both alert, as does any age past the threshold. */
export function importStaleAlert(ageDays: string, thresholdDays: number): boolean {
  return ageDays === "?" || ageDays === "İÇE AKTARIM YOK" || Number(ageDays) > thresholdDays;
}

/** Treasury↔cashflow reconciliation. `mismatchCount` is the number of rows whose difference is
 *  non-zero, as text. Any non-zero count — or a failed query ("?") — alerts; only "0" clears. */
export function reconciliationAlert(mismatchCount: string): boolean {
  return mismatchCount === "?" || Number(mismatchCount) !== 0;
}

/** Runtime database identity. Anything other than the low-privilege application role alerts —
 *  including a null/undefined because DATABASE_URL was absent or the connection failed. This is
 *  the exact signal that was silently wrong on the real machine (P0-2: the app still connected as
 *  the `postgres` superuser, so every RLS policy written since Faz 15 was inert). */
export function runtimeIdentityAlert(currentUser: string | null | undefined): boolean {
  return currentUser !== "mas_radar_app";
}

/** Schema migration ledger. `actual` and `expected` are "count/maxVersion" strings (e.g.
 *  "87/0087"); "?" marks a read that failed on the DB side (actual) or the migrations-directory
 *  side (expected). Strictly fail-closed: a "?" on EITHER side alerts — including the both-"?"
 *  corner a plain `actual !== expected` would let through — because two blind reads agreeing is
 *  not evidence the ledger is intact. */
export function ledgerAlert(actual: string, expected: string): boolean {
  return actual === "?" || expected === "?" || actual !== expected;
}
