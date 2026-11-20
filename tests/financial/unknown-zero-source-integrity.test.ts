import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  loadHybridCashMonths,
  loadHybridMonthDetail,
} from "@/lib/cashflow/live-hybrid";
import { DomainError } from "@/lib/domain-error";
import {
  loadCanonicalKpis,
  loadCanonicalTreasuryCashKpi,
} from "@/lib/metrics/canonical-kpis";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("Agent 04 V2 — F-03 Canonical Cash UNKNOWN != 0 & F-14 Live-Hybrid Schema Integrity", () => {
  describe("F-03: Canonical Treasury Cash KPI (UNKNOWN != 0)", () => {
    it("(a) 42703 missing unknown_opening_count column returns availableNowTry = null, legacyUnverified = true, cashSourceStatus = LEGACY_UNVERIFIED", async () => {
      let summaryCalls = 0;
      const mockDb = {
        async query(sql: string) {
          if (sql.includes("from public.treasury_position_summary")) {
            summaryCalls += 1;
            if (sql.includes("unknown_opening_count") && !sql.includes("0::int as unknown_opening_count")) {
              throw pgError("42703", 'column "unknown_opening_count" does not exist');
            }
            return {
              rows: [
                { currency: "TRY", account_count: 6, unknown_opening_count: 0, available_now: "0.00" },
                { currency: "USD", account_count: 1, unknown_opening_count: 0, available_now: "5000.00" },
              ],
            };
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      const kpi = await loadCanonicalTreasuryCashKpi(mockDb);
      expect(summaryCalls).toBe(2);
      expect(kpi.availableNowTry).toBeNull();
      expect(kpi.legacyUnverified).toBe(true);
      expect(kpi.cashSourceStatus).toBe("LEGACY_UNVERIFIED");
      expect(kpi.foreignBuckets[0]?.availableNow).toBeNull();

      const fullSnapshot = await loadCanonicalKpis(mockDb, "2026-11-20");
      expect(fullSnapshot.treasuryCash.availableNowTry).toBeNull();
      expect(fullSnapshot.treasuryCash.legacyUnverified).toBe(true);
      expect(fullSnapshot.treasuryCash.cashSourceStatus).toBe("LEGACY_UNVERIFIED");
    });

    it("(b) 42P01 missing treasury_position_summary view returns availableNowTry = null and cashSourceStatus = SCHEMA_INCOMPATIBLE", async () => {
      const mockDb = {
        async query(sql: string) {
          if (sql.includes("from public.treasury_position_summary")) {
            throw pgError("42P01", 'relation "public.treasury_position_summary" does not exist');
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      const kpi = await loadCanonicalTreasuryCashKpi(mockDb);
      expect(kpi.availableNowTry).toBeNull();
      expect(kpi.cashSourceStatus).toBe("SCHEMA_INCOMPATIBLE");
      expect(kpi.legacyUnverified).toBe(false);
    });

    it("(c) TRY row with available_now: null and unknown_opening_count: 0 returns availableNowTry = null (never coerced via ?? 0)", async () => {
      const mockDb = {
        async query(sql: string) {
          if (sql.includes("from public.treasury_position_summary")) {
            return {
              rows: [
                { currency: "TRY", account_count: 1, unknown_opening_count: 0, available_now: null },
              ],
            };
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      const kpi = await loadCanonicalTreasuryCashKpi(mockDb);
      expect(kpi.availableNowTry).toBeNull();
      expect(kpi.accountCountTry).toBe(1);
      expect(kpi.unknownOpeningCountTry).toBe(0);
      expect(kpi.cashSourceStatus).toBe("SOURCE_UNAVAILABLE");
    });

    it("(d) TRY row with numeric available_now but unknown_opening_count > 0 returns availableNowTry = null and PARTIAL_MISSING_OPENING", async () => {
      const mockDb = {
        async query(sql: string) {
          if (sql.includes("from public.treasury_position_summary")) {
            return {
              rows: [
                {
                  currency: "TRY",
                  account_count: 6,
                  unknown_opening_count: 2,
                  available_now: "125000.50",
                },
              ],
            };
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      const kpi = await loadCanonicalTreasuryCashKpi(mockDb);
      expect(kpi.availableNowTry).toBeNull();
      expect(kpi.unknownOpeningCountTry).toBe(2);
      expect(kpi.unknownCashAccountCount).toBeGreaterThanOrEqual(2);
      expect(kpi.cashSourceStatus).toBe("PARTIAL_MISSING_OPENING");
    });

    it("(e) missing TRY row returns null unless 0 active TRY accounts are explicitly proven on intact schema", async () => {
      // (e.1) Unverified empty view (no explicit cash_accounts verification row) -> null
      const unverifiedEmptyDb = {
        async query() {
          return { rows: [] };
        },
      } as unknown as Pool;
      const unverifiedRes = await loadCanonicalTreasuryCashKpi(unverifiedEmptyDb);
      expect(unverifiedRes.availableNowTry).toBeNull();
      expect(unverifiedRes.cashSourceStatus).toBe("SOURCE_UNAVAILABLE");

      // (e.2) Only USD row in view, while cash_accounts has active TRY accounts with NULL opening -> null
      const usdOnlyWithNullTryDb = {
        async query(sql: string) {
          if (sql.includes("from public.treasury_position_summary")) {
            return {
              rows: [
                { currency: "USD", account_count: 1, unknown_opening_count: 0, available_now: "15000.50" },
              ],
            };
          }
          if (sql.includes("from public.cash_accounts")) {
            return {
              rows: [{ active_try_count: 6, unknown_try_count: 6 }],
            };
          }
          return { rows: [] };
        },
      } as unknown as Pool;
      const usdOnlyNullTryRes = await loadCanonicalTreasuryCashKpi(usdOnlyWithNullTryDb);
      expect(usdOnlyNullTryRes.availableNowTry).toBeNull();
      expect(usdOnlyNullTryRes.unknownOpeningCountTry).toBe(6);
      expect(usdOnlyNullTryRes.unknownCashAccountCount).toBeGreaterThanOrEqual(6);
      expect(usdOnlyNullTryRes.cashSourceStatus).toBe("PARTIAL_MISSING_OPENING");
      expect(usdOnlyNullTryRes.foreignBuckets[0]?.availableNow).toBe(15000.5);

      // (e.3) Missing TRY row and cash_accounts throws 42P01 -> null + SCHEMA_INCOMPATIBLE
      const missingCashAccountsDb = {
        async query(sql: string) {
          if (sql.includes("from public.treasury_position_summary")) {
            return { rows: [] };
          }
          if (sql.includes("from public.cash_accounts")) {
            throw pgError("42P01", 'relation "public.cash_accounts" does not exist');
          }
          return { rows: [] };
        },
      } as unknown as Pool;
      const missingSchemaRes = await loadCanonicalTreasuryCashKpi(missingCashAccountsDb);
      expect(missingSchemaRes.availableNowTry).toBeNull();
      expect(missingSchemaRes.cashSourceStatus).toBe("SCHEMA_INCOMPATIBLE");

      // (e.4) Explicitly proven 0 active TRY accounts with complete schema -> 0 + NO_ACTIVE_ACCOUNTS_VERIFIED
      const verifiedZeroAccountsDb = {
        async query(sql: string) {
          if (sql.includes("from public.treasury_position_summary")) {
            return {
              rows: [
                { currency: "USD", account_count: 1, unknown_opening_count: 0, available_now: "2500.00" },
              ],
            };
          }
          if (sql.includes("from public.cash_accounts")) {
            return {
              rows: [{ active_try_count: 0, unknown_try_count: 0 }],
            };
          }
          return { rows: [] };
        },
      } as unknown as Pool;
      const verifiedEmptyRes = await loadCanonicalTreasuryCashKpi(verifiedZeroAccountsDb);
      expect(verifiedEmptyRes.availableNowTry).toBe(0);
      expect(verifiedEmptyRes.accountCountTry).toBe(0);
      expect(verifiedEmptyRes.unknownOpeningCountTry).toBe(0);
      expect(verifiedEmptyRes.cashSourceStatus).toBe("NO_ACTIVE_ACCOUNTS_VERIFIED");
    });

    it("(f) positive verified-zero control: TRY row with available_now: '0.00', account_count: 2, unknown_opening_count: 0 returns 0 and COMPLETE", async () => {
      const mockDb = {
        async query(sql: string) {
          if (sql.includes("from public.treasury_position_summary")) {
            return {
              rows: [
                { currency: "TRY", account_count: 2, unknown_opening_count: 0, available_now: "0.00" },
              ],
            };
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      const kpi = await loadCanonicalTreasuryCashKpi(mockDb);
      expect(kpi.availableNowTry).toBe(0);
      expect(kpi.accountCountTry).toBe(2);
      expect(kpi.unknownOpeningCountTry).toBe(0);
      expect(kpi.unknownCashAccountCount).toBe(0);
      expect(kpi.cashSourceStatus).toBe("COMPLETE");
      expect(kpi.legacyUnverified).toBe(false);
    });
  });

  describe("F-14: Live-Hybrid Cashflow Schema Drift Explicit Status (42P01 / 42703)", () => {
    it("(a) surfaces sourceStatus = SCHEMA_INCOMPATIBLE, schemaIncompatibleSources, openingBalance = null, and non-actual epistemic markers when cash_accounts, bank_transactions, or payment_instances fail with 42P01/42703", async () => {
      // 1. cash_accounts throws 42P01 (even if cashflow_months has an imported 0 opening)
      const missingCashAccountsPool = {
        async query(sql: string) {
          if (sql.includes("from public.cash_accounts")) {
            throw pgError("42P01", 'relation "public.cash_accounts" does not exist');
          }
          if (sql.includes("from public.cashflow_months")) {
            return {
              rows: [
                {
                  id: "cm-1",
                  month_start: "2026-11-01",
                  opening: "0.00",
                  income: "10000.00",
                  expense: "4000.00",
                  closing: "6000.00",
                  status: "draft",
                  sheetId: "sh-1",
                  workbookId: "wb-1",
                },
              ],
            };
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      const caDrift = await loadHybridCashMonths(missingCashAccountsPool, "2026-11-20");
      expect(caDrift.sourceStatus).toBe("SCHEMA_INCOMPATIBLE");
      expect(caDrift.schemaIncompatibleSources).toContain("cash_accounts");
      expect(caDrift.openingBalance).toBeNull();
      expect(caDrift.epistemicBasis).toBe("UNKNOWN");
      expect(caDrift.months.every((m) => m.opening === null && m.closing === null)).toBe(true);

      // 2. bank_transactions throws 42703 while cash_accounts has known opening 100,000 TRY
      const missingBankTxPool = {
        async query(sql: string) {
          if (sql.includes("from public.cash_accounts")) {
            return {
              rows: [{ total_opening: "100000.00", known_count: 1, unknown_count: 0 }],
            };
          }
          if (sql.includes("from public.bank_transactions")) {
            throw pgError("42703", 'column "counterparty_name_raw" does not exist');
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      const btDrift = await loadHybridCashMonths(missingBankTxPool, "2026-11-20");
      expect(btDrift.sourceStatus).toBe("SCHEMA_INCOMPATIBLE");
      expect(btDrift.schemaIncompatibleSources).toContain("bank_transactions");
      expect(btDrift.openingBalance).toBeNull();
      expect(btDrift.epistemicBasis).toBe("UNKNOWN");
      expect(btDrift.confidence).toBe("SCHEMA_INCOMPATIBLE");
      for (const m of btDrift.months) {
        expect(m.opening).toBeNull();
        expect(m.closing).toBeNull();
        expect(m.income).toBeNull();
        expect(m.expense).toBeNull();
        expect(m.sourceLabel).not.toContain("Actual");
      }

      // 3. liquidity_forecast_daily throws 42P01 due to missing payment_instances / checks / loan_installments
      const missingPaymentInstancesPool = {
        async query(sql: string) {
          if (sql.includes("from public.cash_accounts")) {
            return {
              rows: [{ total_opening: "50000.00", known_count: 1, unknown_count: 0 }],
            };
          }
          if (sql.includes("from public.liquidity_forecast_daily")) {
            throw pgError("42P01", 'relation "public.payment_instances" does not exist');
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      const piDrift = await loadHybridCashMonths(missingPaymentInstancesPool, "2026-11-20");
      expect(piDrift.sourceStatus).toBe("SCHEMA_INCOMPATIBLE");
      expect(piDrift.schemaIncompatibleSources).toContain("payment_instances");
      expect(piDrift.schemaIncompatibleSources).toContain("liquidity_forecast_daily");
      expect(piDrift.openingBalance).toBeNull();
      expect(piDrift.epistemicBasis).toBe("UNKNOWN");

      // 4. loadHybridMonthDetail also surfaces SCHEMA_INCOMPATIBLE and never claims live_tms7 actuals
      const detailDrift = await loadHybridMonthDetail(missingBankTxPool, "2026-11", "2026-11-20");
      expect(detailDrift).not.toBeNull();
      expect(detailDrift!.sourceStatus).toBe("SCHEMA_INCOMPATIBLE");
      expect(detailDrift!.schemaIncompatibleSources).toContain("bank_transactions");
      expect(detailDrift!.opening).toBeNull();
      expect(detailDrift!.closing).toBeNull();
      expect(detailDrift!.epistemicBasis).toBe("UNKNOWN");
      expect(detailDrift!.confidence).toBe("SCHEMA_INCOMPATIBLE");
    });

    it("(b) throws explicit DomainError(CONFLICT, SCHEMA_INCOMPATIBLE) when failOnSchemaDrift / failClosedOnSchemaError is enabled, and preserves verified 0 opening when schema is COMPLETE", async () => {
      const driftingPool = {
        async query(sql: string) {
          if (sql.includes("from public.bank_transactions")) {
            throw pgError("42P01", 'relation "public.bank_transactions" does not exist');
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      await expect(
        loadHybridCashMonths(driftingPool, "2026-11-20", { failOnSchemaDrift: true }),
      ).rejects.toThrow(DomainError);
      await expect(
        loadHybridCashMonths(driftingPool, "2026-11-20", { failClosedOnSchemaError: true }),
      ).rejects.toThrow(/SCHEMA_INCOMPATIBLE/);
      await expect(
        loadHybridMonthDetail(driftingPool, "2026-11", "2026-11-20", { failOnSchemaDrift: true }),
      ).rejects.toThrow(/SCHEMA_INCOMPATIBLE/);

      // Positive healthy control: verified 0.00 TRY opening balance on complete schema
      const healthyZeroPool = {
        async query(sql: string) {
          if (sql.includes("from public.cash_accounts")) {
            return {
              rows: [{ total_opening: "0.00", known_count: 1, unknown_count: 0 }],
            };
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      const healthy = await loadHybridCashMonths(healthyZeroPool, "2026-11-20", {
        failOnSchemaDrift: true,
      });
      expect(healthy.sourceStatus).toBe("COMPLETE");
      expect(healthy.schemaIncompatibleSources).toEqual([]);
      expect(healthy.openingBalance).toBe(0);
    });
  });
});
