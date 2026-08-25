// Faz 12 — proof that the six fail-closed telemetry alerts are not tautologies.
//
// For each predicate: it CLEARS on a healthy value, it FIRES past the boundary, and — the property
// that matters most for an operational alert — it FIRES when the value cannot be determined. An
// alert that stayed quiet on "?" would report health it could not see; every "cannot determine"
// case below is asserted to be true (alert).

import { describe, expect, it } from "vitest";
import {
  backupAgeAlert,
  jobsStuckAlert,
  importStaleAlert,
  reconciliationAlert,
  runtimeIdentityAlert,
  ledgerAlert,
} from "@/lib/ops/telemetry-alerts";

describe("backupAgeAlert", () => {
  it("clears when a backup is within the threshold", () => {
    expect(backupAgeAlert(0, 36)).toBe(false);
    expect(backupAgeAlert(35.9, 36)).toBe(false);
    expect(backupAgeAlert(36, 36)).toBe(false); // exactly at threshold still counts as fresh
  });
  it("fires just past the threshold", () => {
    expect(backupAgeAlert(36.1, 36)).toBe(true);
  });
  it("fires fail-closed when no backup exists (Infinity) or a stat failed (NaN)", () => {
    expect(backupAgeAlert(Number.POSITIVE_INFINITY, 36)).toBe(true);
    expect(backupAgeAlert(Number.NaN, 36)).toBe(true);
  });
});

describe("jobsStuckAlert", () => {
  it("clears only on an explicit zero", () => {
    expect(jobsStuckAlert("0")).toBe(false);
  });
  it("fires on any stuck job", () => {
    expect(jobsStuckAlert("1")).toBe(true);
    expect(jobsStuckAlert("7")).toBe(true);
  });
  it("fires fail-closed when the query failed", () => {
    expect(jobsStuckAlert("?")).toBe(true);
  });
});

describe("importStaleAlert", () => {
  it("clears when the latest import is recent", () => {
    expect(importStaleAlert("0", 45)).toBe(false);
    expect(importStaleAlert("45", 45)).toBe(false); // at threshold, still fresh
  });
  it("fires once the import is older than the threshold", () => {
    expect(importStaleAlert("46", 45)).toBe(true);
  });
  it("fires fail-closed on a failed query or an empty table", () => {
    expect(importStaleAlert("?", 45)).toBe(true);
    expect(importStaleAlert("İÇE AKTARIM YOK", 45)).toBe(true);
  });
});

describe("reconciliationAlert", () => {
  it("clears only when zero rows diverge", () => {
    expect(reconciliationAlert("0")).toBe(false);
  });
  it("fires on any divergent row", () => {
    expect(reconciliationAlert("1")).toBe(true);
    expect(reconciliationAlert("12")).toBe(true);
  });
  it("fires fail-closed when the count could not be read", () => {
    expect(reconciliationAlert("?")).toBe(true);
  });
});

describe("runtimeIdentityAlert", () => {
  it("clears only for the low-privilege app role", () => {
    expect(runtimeIdentityAlert("mas_radar_app")).toBe(false);
  });
  it("fires for the superuser — the exact P0-2 regression", () => {
    expect(runtimeIdentityAlert("postgres")).toBe(true);
  });
  it("fires fail-closed when the identity is unknown (no DATABASE_URL / connect failed)", () => {
    expect(runtimeIdentityAlert(null)).toBe(true);
    expect(runtimeIdentityAlert(undefined)).toBe(true);
    expect(runtimeIdentityAlert("")).toBe(true);
    expect(runtimeIdentityAlert("BAĞLANAMADI: …")).toBe(true);
  });
});

describe("ledgerAlert", () => {
  it("clears only when the ledger matches the migrations on disk", () => {
    expect(ledgerAlert("87/0087", "87/0087")).toBe(false);
  });
  it("fires on a count or version mismatch", () => {
    expect(ledgerAlert("86/0086", "87/0087")).toBe(true);
    expect(ledgerAlert("88/9999", "87/0087")).toBe(true);
  });
  it("fires fail-closed when either side could not be read — including both being unknown", () => {
    expect(ledgerAlert("?", "87/0087")).toBe(true);
    expect(ledgerAlert("87/0087", "?")).toBe(true);
    // Two blind reads agreeing is NOT evidence the ledger is intact.
    expect(ledgerAlert("?", "?")).toBe(true);
  });
});
