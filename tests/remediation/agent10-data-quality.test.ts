import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_VALID_IMPORT_STALE_DAYS,
  buildCheckBusinessSignature,
  buildPaymentTemplateBusinessSignature,
  evaluateCashAccountCompleteness,
  evaluateCompletenessDimension,
  evaluateConsistencyDimension,
  evaluateInstanceCompleteness,
  evaluateLineageDimension,
  evaluateRemediationDataQuality,
  evaluateTemplateCompleteness,
  evaluateTimelinessDimension,
  evaluateUniquenessDimension,
  evaluateValidImportFreshnessFromDb,
  evaluateValidityDimension,
  hasDemoOrSeedLineage,
  isValidObligationCurrency,
  isWorkbookValidImport,
  normalizeBusinessSignatureToken,
  type CashAccountCompletenessRow,
  type CheckUniquenessCandidate,
  type PaymentInstanceCompletenessRow,
  type QueryablePool,
  type WorkbookImportRecord,
} from "@/lib/data-quality/remediation-metrics";
import { computeObligationAmounts } from "@/lib/contracts/remediation-contracts";
import { DomainError } from "@/lib/domain-error";
import { mapAcceptedChecks } from "@/lib/financing/engine";
import { extractChecks } from "@/lib/importers/extractors";
import type { CellVal, SheetRow } from "@/lib/importers/row-utils";
import { readEnvLocal } from "../../scripts/db/app-url";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

interface DatabaseLineageDigest {
  wb_count: number;
  sheets_count: number;
  ir_count: number;
  mr_count: number;
  payments_count: number;
  pi_count: number;
  pi_amount_sum: string;
  checks_count: number;
  checks_amount_sum: string;
  ea_count: number;
  scenarios_count: number;
  actions_count: number;
  check_events_count: number;
  ca_count: number;
  ca_null_opening_count: number;
}

function resolveOwnerReadOnlyUrl(): string {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = readEnvLocal();
  } catch {
    // Fallback to environment when .env.local is absent.
  }
  const url =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    fileEnv.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    fileEnv.DATABASE_URL?.trim() ||
    "";
  if (!url) {
    throw new Error("MIGRATION_DATABASE_URL / DATABASE_URL tanımlı değil.");
  }
  return url;
}

async function captureDatabaseDigest(pool: Pool): Promise<DatabaseLineageDigest> {
  const res = await pool.query<DatabaseLineageDigest>(`
    select
      (select count(*)::int from public.source_workbooks) as wb_count,
      (select count(*)::int from public.source_sheets) as sheets_count,
      (select count(*)::int from public.import_rows) as ir_count,
      (select count(*)::int from public.mapping_reviews) as mr_count,
      (select count(*)::int from public.payments) as payments_count,
      (select count(*)::int from public.payment_instances) as pi_count,
      (select coalesce(sum(amount), 0)::numeric(16,2)::text from public.payment_instances) as pi_amount_sum,
      (select count(*)::int from public.checks) as checks_count,
      (select coalesce(sum(amount), 0)::numeric(16,2)::text from public.checks) as checks_amount_sum,
      (select count(*)::int from public.external_assumptions) as ea_count,
      (select count(*)::int from public.scenarios) as scenarios_count,
      (select count(*)::int from public.action_items) as actions_count,
      (select count(*)::int from public.check_events) as check_events_count,
      (select count(*)::int from public.cash_accounts) as ca_count,
      (select count(*) filter (where opening_balance is null)::int from public.cash_accounts where is_active = true and archived_at is null) as ca_null_opening_count
  `);
  return res.rows[0]!;
}

function hasLiveDbConfig(): boolean {
  if (process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim()) return true;
  try {
    const envLocal = readEnvLocal();
    return Boolean(envLocal.MIGRATION_DATABASE_URL?.trim() || envLocal.DATABASE_URL?.trim());
  } catch {
    return false;
  }
}

describe("Agent 10 — Deterministic Valid-Import Freshness, Blank!=Zero, Grain & Duplicate Invariants (RG-09, F-15, F-16)", () => {
  it("1. enforces strict boundary & read-only source invariants on src/lib/data-quality/remediation-metrics.ts", () => {
    const metricsFile = path.resolve(
      process.cwd(),
      "src",
      "lib",
      "data-quality",
      "remediation-metrics.ts",
    );
    const src = readFileSync(metricsFile, "utf8");

    expect(src).not.toMatch(/\bprocess\.env\b/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bnew\s+WebSocket\b/);
    expect(src).not.toMatch(
      /\b(insert\s+into|update\s+public\.|delete\s+from|truncate\s+|alter\s+table|drop\s+table)\b/i,
    );
  });

  it("2. proves empty workbooks (0 import_rows) and failed workbooks NEVER reset latestValidImportAgeDays (I-005)", async () => {
    const asOf = "2026-11-18T15:14:51.000Z";

    expect(isWorkbookValidImport({ status: "parsed", importRowCount: 1_601 })).toBe(true);
    expect(isWorkbookValidImport({ status: "mapped", importRowCount: 1 })).toBe(true);
    expect(isWorkbookValidImport({ status: "parsed", importRowCount: 0 })).toBe(false);
    expect(isWorkbookValidImport({ status: "mapped", importRowCount: 0 })).toBe(false);
    expect(isWorkbookValidImport({ status: "failed", importRowCount: 250 })).toBe(false);
    expect(isWorkbookValidImport({ status: "pending", importRowCount: 50 })).toBe(false);

    const baseValidWorkbook: WorkbookImportRecord = {
      id: "f7af8764-2249-4a41-abf6-ebed7198c2f1",
      originalFilename: "TEMİZ.xlsx",
      status: "parsed",
      importedAt: "2026-07-17T13:14:28.804Z",
      importRowCount: 1_601,
      inValidWorkbookImportsView: true,
    };

    // Baseline: 124 days old (> 45-day threshold) -> stale
    const baseline = evaluateTimelinessDimension([baseValidWorkbook], { asOf });
    expect(baseline.staleThresholdDays).toBe(DEFAULT_VALID_IMPORT_STALE_DAYS);
    expect(baseline.latestValidImportAgeDays).toBe(124);
    expect(baseline.isStale).toBe(true);

    // Today's empty ('parsed' / 'mapped' with 0 import_rows) and 'failed' / 'pending' workbooks MUST NOT reset freshness!
    const withEmptyAndFailed: WorkbookImportRecord[] = [
      baseValidWorkbook,
      {
        id: "wb-empty-parsed-today",
        originalFilename: "bos_calisma_kitabi.xlsx",
        status: "parsed",
        importedAt: "2026-11-18T14:00:00.000Z",
        importRowCount: 0,
        inValidWorkbookImportsView: false,
      },
      {
        id: "wb-empty-mapped-today",
        originalFilename: "bos_v2_sablon.xlsx",
        status: "mapped",
        importedAt: "2026-11-18T14:30:00.000Z",
        importRowCount: 0,
        inValidWorkbookImportsView: false,
      },
      {
        id: "wb-failed-today",
        originalFilename: "bozuk_dosya.xlsx",
        status: "failed",
        importedAt: "2026-11-18T15:00:00.000Z",
        importRowCount: 42,
        inValidWorkbookImportsView: false,
      },
      {
        id: "wb-pending-today",
        originalFilename: "yarim_kalan.xlsx",
        status: "pending",
        importedAt: "2026-11-18T15:10:00.000Z",
        importRowCount: 10,
        inValidWorkbookImportsView: false,
      },
    ];

    const afterBadUploads = evaluateTimelinessDimension(withEmptyAndFailed, { asOf });
    expect(afterBadUploads.totalWorkbookCount).toBe(5);
    expect(afterBadUploads.validWorkbookCount).toBe(1);
    expect(afterBadUploads.emptyWorkbooksExcludedCount).toBe(2);
    expect(afterBadUploads.failedOrPendingWorkbooksExcludedCount).toBe(2);
    expect(afterBadUploads.latestValidWorkbookId).toBe(baseValidWorkbook.id);
    expect(afterBadUploads.latestValidFilename).toBe("TEMİZ.xlsx");
    expect(afterBadUploads.latestValidImportAgeDays).toBe(124);
    expect(afterBadUploads.latestRawWorkbookId).toBe("wb-pending-today");
    expect(afterBadUploads.latestRawWorkbookStatus).toBe("pending");
    expect(afterBadUploads.isStale).toBe(true);
    expect(afterBadUploads.viewParityVerified).toBe(true);

    // Only a genuinely non-empty parsed/mapped workbook resets latestValidImportAgeDays
    const withFreshValid = evaluateTimelinessDimension(
      [
        ...withEmptyAndFailed,
        {
          id: "wb-fresh-v2",
          originalFilename: "kasim_2026_v2.xlsx",
          status: "mapped",
          importedAt: "2026-11-16T15:14:51.000Z",
          importRowCount: 85,
          inValidWorkbookImportsView: true,
        },
      ],
      { asOf },
    );
    expect(withFreshValid.validWorkbookCount).toBe(2);
    expect(withFreshValid.latestValidWorkbookId).toBe("wb-fresh-v2");
    expect(withFreshValid.latestValidImportAgeDays).toBe(2);
    expect(withFreshValid.isStale).toBe(false);

    // Zero valid workbooks -> ageDays === null, isStale === true
    const noneValid = evaluateTimelinessDimension(withEmptyAndFailed.slice(1), { asOf });
    expect(noneValid.validWorkbookCount).toBe(0);
    expect(noneValid.latestValidImportAgeDays).toBeNull();
    expect(noneValid.isStale).toBe(true);

    // DB helper verifies view parity against public.valid_workbook_imports
    const mockDbPool: QueryablePool = {
      async query() {
        return {
          rows: [
            {
              id: "wb-failed-today",
              original_filename: "bozuk_dosya.xlsx",
              status: "failed",
              imported_at: "2026-11-18T15:00:00.000Z",
              import_row_count: 12,
              in_valid_view: false,
            },
            {
              id: "wb-empty-today",
              original_filename: "bos.xlsx",
              status: "parsed",
              imported_at: "2026-11-18T14:00:00.000Z",
              import_row_count: 0,
              in_valid_view: false,
            },
            {
              id: baseValidWorkbook.id,
              original_filename: "TEMİZ.xlsx",
              status: "parsed",
              imported_at: "2026-07-17T13:14:28.804Z",
              import_row_count: 1_601,
              in_valid_view: true,
            },
          ],
          rowCount: 3,
        } as never;
      },
    };
    const dbFreshness = await evaluateValidImportFreshnessFromDb(mockDbPool, { asOf });
    expect(dbFreshness.latestValidImportAgeDays).toBe(124);
    expect(dbFreshness.emptyWorkbooksExcludedCount).toBe(1);
    expect(dbFreshness.failedOrPendingWorkbooksExcludedCount).toBe(1);
    expect(dbFreshness.isStale).toBe(true);
    expect(dbFreshness.viewParityVerified).toBe(true);
  });

  it("3. separates template grain vs instance grain completeness (19 vs 20 cardinality — I-011), preserves Blank != Zero, and detects join multiplication", () => {
    // 19 templates (18 active outflow + 1 archived; 1 active has defaultAmount = 0 which is NOT missing, 2 have null)
    const templates = Array.from({ length: 19 }, (_, idx) => {
      const n = idx + 1;
      if (n === 19) {
        return {
          id: `tpl-${n}`,
          name: `Arşiv Kalemi ${n}`,
          status: "archived",
          direction: "outflow",
          defaultAmount: 30_000,
          providerPartyId: null,
          categoryId: null,
          ownerPartyId: null,
          archivedAt: "2026-08-01T00:00:00Z",
        };
      }
      return {
        id: `tpl-${n}`,
        name: `Ödeme Şablonu ${n}`,
        status: "active",
        direction: "outflow",
        // tpl-1 has 0 (known zero — NEVER missing!), tpl-2 & tpl-3 have null (missing!)
        defaultAmount: n === 1 ? 0 : n <= 3 ? null : 10_000 * n,
        providerPartyId: n <= 5 ? null : `party-${n}`,
        categoryId: n <= 4 ? null : `cat-${n}`,
        ownerPartyId: n <= 6 ? null : `owner-${n}`,
        archivedAt: null,
      };
    });

    // 20 active monthly instances in 2026-11 + 1 cancelled instance (21 total rows in 2026-11)
    const instances = [
      ...Array.from({ length: 20 }, (_, idx) => {
        const n = idx + 1;
        return {
          id: `inst-nov-${n}`,
          paymentId: `tpl-${Math.min(n, 18)}`,
          instanceMonth: "2026-11-01",
          status: n === 20 ? "paid" : "unpaid",
          direction: "outflow",
          // inst-1 has 0 (known zero), inst-2..inst-5 (4 instances) have null (missing!)
          amount: n === 1 ? "0.00" : n <= 5 ? null : "15000.00",
          cancelledAt: null,
          providerPartyId: n <= 7 ? null : "party-ok",
          categoryId: n <= 6 ? null : "cat-ok",
          ownerPartyId: n <= 8 ? null : "owner-ok",
        };
      }),
      {
        id: "inst-nov-cancelled",
        paymentId: "tpl-19",
        instanceMonth: "2026-11-01",
        status: "cancelled",
        direction: "outflow",
        amount: null,
        cancelledAt: "2026-11-02T10:00:00Z",
        providerPartyId: null,
        categoryId: null,
        ownerPartyId: null,
      },
    ];

    const comp = evaluateCompletenessDimension({
      templates,
      instances,
      instanceMonthScope: "2026-11-01",
    });

    // Template grain (19 total, 18 active) vs Instance grain (21 total, 20 active) — zero conflation!
    expect(comp.templateGrain.grain).toBe("payments_template");
    expect(comp.templateGrain.totalTemplates).toBe(19);
    expect(comp.templateGrain.activeOutflowTemplates).toBe(18);
    expect(comp.templateGrain.archivedTemplates).toBe(1);
    expect(comp.templateGrain.missingAmountCount).toBe(2); // tpl-2, tpl-3 (`0` on tpl-1 is NOT missing)
    expect(comp.templateGrain.missingProviderCount).toBe(5);
    expect(comp.templateGrain.missingCategoryCount).toBe(4);
    expect(comp.templateGrain.missingOwnerCount).toBe(6);

    expect(comp.instanceGrain.grain).toBe("payment_instances");
    expect(comp.instanceGrain.totalInstances).toBe(21);
    expect(comp.instanceGrain.activeOutflowInstances).toBe(20);
    expect(comp.instanceGrain.openOutflowInstances).toBe(19);
    expect(comp.instanceGrain.paidOutflowInstances).toBe(1);
    expect(comp.instanceGrain.cancelledOutflowInstances).toBe(1);
    expect(comp.instanceGrain.missingAmountCount).toBe(4); // inst-2..inst-5 (`0.00` on inst-1 and cancelled row excluded)
    expect(comp.instanceGrain.openMissingAmountCount).toBe(4);
    expect(comp.instanceGrain.missingProviderCount).toBe(7);
    expect(comp.instanceGrain.missingCategoryCount).toBe(6);
    expect(comp.instanceGrain.missingOwnerCount).toBe(8);

    expect(comp.scopedMonthInstanceGrain).toEqual({
      ...comp.instanceGrain,
      monthScope: "2026-11-01",
    });
    expect(evaluateTemplateCompleteness(templates)).toEqual(comp.templateGrain);
    expect(evaluateInstanceCompleteness(instances, "2026-12-01").totalInstances).toBe(0);

    // Consistency: detect SQL join fan-out and bucket mismatch when present
    const badConsistency = evaluateConsistencyDimension({
      monthSnapshots: [
        {
          monthStartISO: "2026-11-01",
          summaryTotalCount: 20,
          summaryMissingCount: 4,
          summaryCancelledCount: 1,
          summaryUnexplainedGapTry: 0,
          paidCount: 1,
          partialCount: 0,
          unpaidCount: 18, // 1 + 18 = 19 !== 20!
          plannedCount: 0,
          lateCount: 0,
          unknownStatusCount: 0,
          cancelledOutflowCount: 1,
          activeMissingAmountCount: 4,
        },
      ],
      joinCardinality: {
        rawInstanceCount: 21,
        joinedInstanceCount: 23, // 2 multiplied rows!
        distinctInstanceIdCount: 21,
        templateBackedInstanceCount: 21,
        distinctTemplateMonthPairCount: 21,
      },
    });
    expect(badConsistency.mismatchedMonthCount).toBe(1);
    expect(badConsistency.joinMultipliedRowCount).toBe(2);
    expect(badConsistency.hasZeroJoinMultiplication).toBe(false);
    expect(badConsistency.isConsistent).toBe(false);

    // Clean consistency
    const goodConsistency = evaluateConsistencyDimension({
      monthSnapshots: [
        {
          monthStartISO: "2026-11-01",
          summaryTotalCount: 20,
          summaryMissingCount: 4,
          summaryCancelledCount: 1,
          summaryUnexplainedGapTry: 0,
          paidCount: 1,
          partialCount: 0,
          unpaidCount: 19,
          plannedCount: 0,
          lateCount: 0,
          unknownStatusCount: 0,
          cancelledOutflowCount: 1,
          activeMissingAmountCount: 4,
        },
      ],
      joinCardinality: {
        rawInstanceCount: 21,
        joinedInstanceCount: 21,
        distinctInstanceIdCount: 21,
        templateBackedInstanceCount: 21,
        distinctTemplateMonthPairCount: 21,
      },
    });
    expect(goodConsistency.mismatchedMonthCount).toBe(0);
    expect(goodConsistency.hasZeroJoinMultiplication).toBe(true);
    expect(goodConsistency.isConsistent).toBe(true);
  });

  it("4. evaluates Validity dimension: rejected/error import_rows, open/rejected mapping_reviews, and currency/status validity", () => {
    expect(isValidObligationCurrency("TRY")).toBe(true);
    expect(isValidObligationCurrency("USD")).toBe(true);
    expect(isValidObligationCurrency("EUR")).toBe(true);
    expect(isValidObligationCurrency("TL")).toBe(false);
    expect(isValidObligationCurrency("")).toBe(false);
    expect(isValidObligationCurrency("XYZ")).toBe(false);
    expect(isValidObligationCurrency(null)).toBe(false);

    const validityWithErrors = evaluateValidityDimension({
      stagingCounts: [
        { mappingStatus: "mapped", count: 100 },
        { mappingStatus: "needs_review", count: 10 },
        { mappingStatus: "rejected", count: 3 },
        { mappingStatus: "error", count: 2 },
        { mappingStatus: "blocked_by_parent", count: 4 },
      ],
      reviewCounts: [
        { status: "open", count: 8 },
        { status: "rejected", count: 3 },
        { status: "accepted", count: 2 },
        { status: "resolved", count: 5 },
      ],
      domainRows: [
        { entityTable: "payments", currency: "TRY", status: "active" },
        { entityTable: "payment_instances", currency: "TL", status: "unpaid" }, // invalid currency 'TL'
        { entityTable: "checks", currency: "USD", status: "bogus_state" }, // invalid status
      ],
    });

    expect(validityWithErrors.totalImportRows).toBe(119);
    expect(validityWithErrors.rejectedOrErrorImportRows).toBe(5);
    expect(validityWithErrors.blockedByParentImportRows).toBe(4);
    expect(validityWithErrors.totalMappingReviews).toBe(18);
    expect(validityWithErrors.blockingMappingReviews).toBe(11);
    expect(validityWithErrors.invalidCurrencyCount).toBe(1);
    expect(validityWithErrors.invalidStatusCount).toBe(1);
    expect(validityWithErrors.isDomainCurrencyAndStatusValid).toBe(false);
  });

  it("5. flags apparent duplicate Çağdaş obligations by Turkish-normalized signature without auto-merging, while mapAcceptedChecks rejects 'resolved' duplicate reviews (Scenario 12 / I-011)", async () => {
    expect(normalizeBusinessSignatureToken("ÇAĞDAŞ")).toBe("çağdaş");
    expect(normalizeBusinessSignatureToken("  çağdaş  ")).toBe("çağdaş");
    expect(normalizeBusinessSignatureToken("IŞIK İNŞAAT")).toBe("ışık inşaat");

    const sigLower = buildCheckBusinessSignature({
      counterparty: "çağdaş",
      maturityDate: "2026-08-31",
      amount: "100000.00",
      currency: "TRY",
      direction: "outflow",
    });
    const sigUpper = buildCheckBusinessSignature({
      counterparty: "ÇAĞDAŞ",
      maturityDate: "2026-08-31",
      amount: 100_000,
      currency: "TRY",
      direction: "outflow",
    });
    expect(sigLower).toBe("çağdaş|2026-08-31|100000.00|TRY|outflow");
    expect(sigUpper).toBe(sigLower);

    expect(
      buildPaymentTemplateBusinessSignature({
        name: "KİRA",
        providerPartyId: null,
        recurrenceType: "monthly",
        dueDay: 5,
        defaultAmount: 35_000,
        currency: "TRY",
      }),
    ).toBe("kira||monthly|5|35000.00|TRY");

    // 3 active Çağdaş checks on 2026-08-31 + 1 archived Çağdaş check on 2026-10-31
    const uniqueness = evaluateUniquenessDimension({
      checks: [
        {
          id: "chk-cagdas-1",
          counterparty: "çağdaş",
          maturityDate: "2026-08-31",
          amount: "100000.00",
          currency: "TRY",
          direction: "outflow",
          status: "planned",
          archivedAt: null,
        },
        {
          id: "chk-cagdas-2",
          counterparty: "çağdaş",
          maturityDate: "2026-08-31",
          amount: "100000.00",
          currency: "TRY",
          direction: "outflow",
          status: "planned",
          archivedAt: null,
        },
        {
          id: "chk-cagdas-3",
          counterparty: "ÇAĞDAŞ",
          maturityDate: "2026-08-31",
          amount: "100000.00",
          currency: "TRY",
          direction: "outflow",
          status: "planned",
          archivedAt: null,
        },
        {
          id: "chk-cagdas-oct-archived",
          counterparty: "ÇAĞDAŞ",
          maturityDate: "2026-10-31",
          amount: "100000.00",
          currency: "TRY",
          direction: "outflow",
          status: "planned",
          archivedAt: "2026-07-22T08:02:07.815Z",
        },
      ],
    });

    expect(uniqueness.totalCheckCount).toBe(4);
    expect(uniqueness.activeCheckCount).toBe(3);
    expect(uniqueness.archivedCheckCount).toBe(1);
    expect(uniqueness.autoMergedCount).toBe(0);
    expect(uniqueness.controlDuplicateCheckPairCount).toBe(3);
    expect(uniqueness.duplicateCheckSignatureClusters).toHaveLength(1);
    expect(uniqueness.duplicateCheckSignatureClusters[0]).toEqual({
      signature: "çağdaş|2026-08-31|100000.00|TRY|outflow",
      counterpartyNormalized: "çağdaş",
      maturityDate: "2026-08-31",
      amount: 100_000,
      currency: "TRY",
      direction: "outflow",
      memberIds: ["chk-cagdas-1", "chk-cagdas-2", "chk-cagdas-3"],
      count: 3,
    });

    // Scenario 12 verification: mapAcceptedChecks excludes 'resolved' duplicate_check reviews, imports all 3 on 'accepted'
    const cell = (v: string | number): CellVal => ({ v, t: typeof v === "number" ? "n" : "s" });
    const sheetRows: SheetRow[] = [
      { rowIndex: 1, cells: { A: cell("TARİH"), B: cell("KİME"), C: cell("TUTAR") } },
      { rowIndex: 2, cells: { A: cell("2026-08-31"), B: cell("Çağdaş"), C: cell(-100_000) } },
      { rowIndex: 3, cells: { A: cell("2026-08-31"), B: cell("Çağdaş"), C: cell(-100_000) } },
      { rowIndex: 4, cells: { A: cell("2026-08-31"), B: cell("Çağdaş"), C: cell(-100_000) } },
    ];

    const extracted = extractChecks(sheetRows);
    expect(extracted.candidates).toHaveLength(3);
    expect(extracted.candidates.every((c) => c.flags.includes("duplicate_check"))).toBe(true);

    function createChecksMapperPool(dupReviewStatus: "resolved" | "accepted"): {
      pool: Pool;
      insertedRowIds: string[];
    } {
      const insertedRowIds: string[] = [];
      const reviews = new Map<string, { issue_type: string; status: string }>([
        ["ir-3", { issue_type: "duplicate_check", status: dupReviewStatus }],
        ["ir-4", { issue_type: "duplicate_check", status: dupReviewStatus }],
      ]);

      const client = {
        async query(sql: string, params: unknown[] = []) {
          const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (norm === "begin" || norm === "commit" || norm === "rollback") {
            return { rows: [], rowCount: 0 };
          }
          if (norm.includes("from public.source_sheets")) {
            return { rows: [{ id: "sheet-cekler", sheet_name: "ÇEKLER" }], rowCount: 1 };
          }
          if (norm.includes("from public.import_rows ir")) {
            expect(norm).toContain("duplicate_check");
            expect(norm).toContain("'resolved'");
            const rows = sheetRows.map((sr) => {
              const id = `ir-${sr.rowIndex}`;
              const rev = reviews.get(id);
              const blocked =
                rev != null &&
                (rev.status === "open" ||
                  rev.status === "rejected" ||
                  (rev.issue_type === "duplicate_check" && rev.status === "resolved"));
              const resolvedDuplicate =
                rev != null && rev.issue_type === "duplicate_check" && rev.status === "resolved";
              return {
                id,
                row_index: sr.rowIndex,
                row_json: sr.cells,
                mapping_status: "pending",
                blocked,
                resolved_duplicate: resolvedDuplicate,
              };
            });
            return { rows, rowCount: rows.length };
          }
          if (norm.includes("from public.parties")) {
            return { rows: [{ id: "party-cagdas" }], rowCount: 1 };
          }
          if (norm.startsWith("insert into public.checks")) {
            insertedRowIds.push(String(params[2]));
            return { rows: [{ id: `chk-${insertedRowIds.length}` }], rowCount: 1 };
          }
          if (
            norm.startsWith("insert into public.check_events") ||
            norm.startsWith("update public.import_rows") ||
            norm.startsWith("insert into public.audit_logs")
          ) {
            return { rows: [{ id: "ok" }], rowCount: 1 };
          }
          throw new Error(`Beklenmeyen SQL: ${sql}`);
        },
        release() {},
      };

      return {
        pool: { async connect() { return client; } } as unknown as Pool,
        insertedRowIds,
      };
    }

    const resolvedRun = createChecksMapperPool("resolved");
    const resolvedOut = await mapAcceptedChecks(resolvedRun.pool, "wb-1", "actor-1");
    expect(resolvedOut.created).toBe(1);
    expect(resolvedOut.excluded).toHaveLength(2);
    expect(resolvedOut.excluded.every((e) => e.reason.includes("resolved"))).toBe(true);

    const acceptedRun = createChecksMapperPool("accepted");
    const acceptedOut = await mapAcceptedChecks(acceptedRun.pool, "wb-1", "actor-1");
    expect(acceptedOut.created).toBe(3);
    expect(acceptedRun.insertedRowIds).toEqual(["ir-2", "ir-3", "ir-4"]);
  });

  it("6. classifies workbook-traced, generated recurring, untraced manual, and Demo/seed lineage transparently without mutations (I-016)", () => {
    expect(hasDemoOrSeedLineage({ name: "Demo Tedarikçi Ödemesi" })).toBe(true);
    expect(hasDemoOrSeedLineage({ name: "KİRA", notes: ["seed fixture row"] })).toBe(true);
    expect(
      hasDemoOrSeedLineage({
        name: "VAKIF KREDİ 2",
        notes: [null, "Demo: arşiv ekranını göstermek için arşivlendi."],
      }),
    ).toBe(true);
    expect(hasDemoOrSeedLineage({ name: "MAS ELEKTRİK", notes: ["normal fatura"] })).toBe(false);

    const lineage = evaluateLineageDimension({
      payments: [
        {
          id: "p-wb-1",
          name: "KİRA",
          sourceWorkbookId: "wb-1",
          sourceRowId: "ir-1",
        },
        {
          id: "p-demo-1",
          name: "Demo Kira Şablonu",
          sourceWorkbookId: null,
          sourceRowId: null,
          description: "seed data",
        },
      ],
      paymentInstances: [
        {
          id: "pi-direct-1",
          paymentName: "KİRA",
          sourceWorkbookId: "wb-1",
          sourceRowId: "ir-1",
          templateSourceWorkbookId: "wb-1",
          templateSourceRowId: "ir-1",
          amountSource: "workbook",
        },
        {
          id: "pi-gen-1",
          paymentName: "KİRA",
          sourceWorkbookId: null,
          sourceRowId: null,
          templateSourceWorkbookId: "wb-1",
          templateSourceRowId: "ir-1",
          amountSource: "generated",
        },
        {
          id: "pi-demo-1",
          paymentName: "Demo Kira Şablonu",
          sourceWorkbookId: null,
          sourceRowId: null,
          templateSourceWorkbookId: null,
          templateSourceRowId: null,
          amountSource: "generated",
          note: "Demo yaşam döngüsü",
        },
      ],
      checks: [
        {
          id: "chk-wb-1",
          counterpartyLabel: "ÇAĞDAŞ",
          sourceWorkbookId: "wb-1",
          sourceRowId: "ir-10",
          archiveReason: "Demo: arşiv ekranını göstermek için arşivlendi.",
        },
      ],
      auxiliaryDemoOrSeed: {
        externalAssumptionsDemoCount: 6,
        scenariosDemoCount: 4,
        actionItemsDemoCount: 3,
        checkEventsDemoCount: 3,
      },
    });

    expect(lineage.mutationsPerformed).toBe(0);
    expect(lineage.payments).toEqual({
      totalCount: 2,
      workbookTracedCount: 1,
      untracedManualCount: 1,
      demoOrSeedCount: 1,
      demoOrSeedIds: ["p-demo-1"],
    });
    expect(lineage.paymentInstances).toEqual({
      totalCount: 3,
      directWorkbookTracedCount: 1,
      templateInheritedWorkbookTracedCount: 1,
      generatedRecurringCount: 2,
      nonGeneratedAmountSourceCount: 1,
      untracedCount: 1,
      demoOrSeedCount: 1,
      demoOrSeedIds: ["pi-demo-1"],
    });
    expect(lineage.checks).toEqual({
      totalCount: 1,
      workbookTracedCount: 1,
      untracedManualCount: 0,
      demoOrSeedCount: 1,
      demoOrSeedIds: ["chk-wb-1"],
    });
  });

  it("7. [V2 F-15 / RG-09] fails closed on 42P01 / 42703 / unreadable valid_workbook_imports view (isStale: true, freshnessStatus: SCHEMA_INCOMPATIBLE | UNKNOWN — NEVER treats missing view as fresh)", async () => {
    const asOf = "2026-11-20T05:00:00.000Z";

    // (a) 42P01 undefined_table on valid_workbook_imports -> fail-closed SCHEMA_INCOMPATIBLE
    const missingViewPool: QueryablePool = {
      async query() {
        throw Object.assign(new Error('relation "public.valid_workbook_imports" does not exist'), {
          code: "42P01",
        });
      },
    };
    const missingViewRes = await evaluateValidImportFreshnessFromDb(missingViewPool, { asOf });
    expect(missingViewRes.isStale).toBe(true);
    expect(missingViewRes.freshnessStatus).toBe("SCHEMA_INCOMPATIBLE");
    expect(missingViewRes.errorCode).toBe("42P01");
    expect(missingViewRes.latestValidImport).toBeNull();
    expect(missingViewRes.latestValidWorkbookId).toBeNull();
    expect(missingViewRes.latestValidImportAgeDays).toBeNull();
    expect(missingViewRes.viewParityVerified).toBe(false);

    // Strict mode throws DomainError('CONFLICT', 'SCHEMA_INCOMPATIBLE: ...')
    await expect(
      evaluateValidImportFreshnessFromDb(missingViewPool, { asOf, failOnSchemaDrift: true }),
    ).rejects.toThrow(DomainError);

    // (b) 42703 undefined_column on valid_workbook_imports / import_rows -> fail-closed SCHEMA_INCOMPATIBLE
    const missingColumnPool: QueryablePool = {
      async query() {
        throw Object.assign(new Error('column "imported_at" does not exist'), {
          code: "42703",
        });
      },
    };
    const missingColRes = await evaluateValidImportFreshnessFromDb(missingColumnPool, { asOf });
    expect(missingColRes.isStale).toBe(true);
    expect(missingColRes.freshnessStatus).toBe("SCHEMA_INCOMPATIBLE");
    expect(missingColRes.errorCode).toBe("42703");
    expect(missingColRes.latestValidImport).toBeNull();
    expect(missingColRes.latestValidImportAgeDays).toBeNull();
    expect(missingColRes.viewParityVerified).toBe(false);

    // (c) Unreadable view / permission failure (42501) -> fail-closed UNKNOWN
    const unreadablePool: QueryablePool = {
      async query() {
        throw Object.assign(new Error("permission denied for view valid_workbook_imports"), {
          code: "42501",
        });
      },
    };
    const unreadableRes = await evaluateValidImportFreshnessFromDb(unreadablePool, { asOf });
    expect(unreadableRes.isStale).toBe(true);
    expect(unreadableRes.freshnessStatus).toBe("UNKNOWN");
    expect(unreadableRes.errorCode).toBe("42501");
    expect(unreadableRes.latestValidImport).toBeNull();
    expect(unreadableRes.latestValidImportAgeDays).toBeNull();
    expect(unreadableRes.viewParityVerified).toBe(false);

    // (d) Unverified view parity (in_valid_view = null / mismatched) -> fail-closed UNKNOWN, isStale: true
    const brokenParityPool: QueryablePool = {
      async query() {
        return {
          rows: [
            {
              id: "wb-fresh-unverified",
              original_filename: "synthetic_v2.xlsx",
              status: "mapped",
              imported_at: "2026-11-19T12:00:00.000Z",
              import_row_count: 25,
              in_valid_view: null,
            },
          ],
          rowCount: 1,
        } as never;
      },
    };
    const brokenParityRes = await evaluateValidImportFreshnessFromDb(brokenParityPool, { asOf });
    expect(brokenParityRes.viewParityVerified).toBe(false);
    expect(brokenParityRes.freshnessStatus).toBe("UNKNOWN");
    expect(brokenParityRes.isStale).toBe(true);
    expect(brokenParityRes.latestValidImport).toBeNull();
  });

  it("8. [V2 F-15 / RG-09] enforces >= 45d stale threshold boundary (44d fresh vs 45d stale) and excludes all-rejected or null-timestamp workbooks from latestValidImport", () => {
    const asOf = "2026-11-20T12:00:00.000Z";

    // Exact 44 days ago -> fresh (< 45d)
    const fresh44d = evaluateTimelinessDimension(
      [
        {
          id: "wb-44d",
          originalFilename: "ok_44d.xlsx",
          status: "mapped",
          importedAt: "2026-10-07T12:00:00.000Z",
          importRowCount: 40,
          inValidWorkbookImportsView: true,
        },
      ],
      { asOf },
    );
    expect(fresh44d.latestValidImportAgeDays).toBe(44);
    expect(fresh44d.isStale).toBe(false);
    expect(fresh44d.freshnessStatus).toBe("FRESH");
    expect(fresh44d.latestValidImport?.id).toBe("wb-44d");

    // Exact 45 days ago -> >= 45d stale alarm MUST remain open (isStale: true, freshnessStatus: STALE)!
    // Plus today's all-rejected workbook (importRowCount: 12, nonRejectedImportRowCount: 0) and failed null-timestamp workbook MUST NOT advance latestValidImport!
    const stale45dWithAdversarialUploads = evaluateTimelinessDimension(
      [
        {
          id: "wb-45d",
          originalFilename: "stale_45d.xlsx",
          status: "parsed",
          importedAt: "2026-10-06T12:00:00.000Z",
          importRowCount: 120,
          inValidWorkbookImportsView: true,
        },
        {
          id: "wb-all-rejected-today",
          originalFilename: "all_rejected_rows.xlsx",
          status: "parsed",
          importedAt: "2026-11-20T11:00:00.000Z",
          importRowCount: 12,
          nonRejectedImportRowCount: 0,
        },
        {
          id: "wb-corrupt-ts",
          originalFilename: "failed_no_ts.xlsx",
          status: "failed",
          importedAt: "",
          importRowCount: 0,
        },
      ],
      { asOf },
    );
    expect(stale45dWithAdversarialUploads.latestValidWorkbookId).toBe("wb-45d");
    expect(stale45dWithAdversarialUploads.latestValidImportAgeDays).toBe(45);
    expect(stale45dWithAdversarialUploads.isStale).toBe(true);
    expect(stale45dWithAdversarialUploads.freshnessStatus).toBe("STALE");
    expect(stale45dWithAdversarialUploads.latestValidImport?.id).toBe("wb-45d");

    // Parsed non-empty workbook with corrupt/missing timestamp fails closed to UNKNOWN
    const unreadableCandidate = evaluateTimelinessDimension(
      [
        {
          id: "wb-44d",
          originalFilename: "ok_44d.xlsx",
          status: "mapped",
          importedAt: "2026-10-07T12:00:00.000Z",
          importRowCount: 40,
          inValidWorkbookImportsView: true,
        },
        {
          id: "wb-parsed-bad-ts",
          originalFilename: "corrupt_ts.xlsx",
          status: "parsed",
          importedAt: "not-a-date",
          importRowCount: 15,
        },
      ],
      { asOf },
    );
    expect(unreadableCandidate.isStale).toBe(true);
    expect(unreadableCandidate.freshnessStatus).toBe("UNKNOWN");
    expect(unreadableCandidate.latestValidImport).toBeNull();
  });

  it("9. [V2 F-15 / RG-09] preserves BLANK != ZERO across amount_status='missing' obligations and cash_accounts.opening_balance IS NULL", () => {
    const nullObligation = computeObligationAmounts({
      originalAmount: null,
      paidAmount: null,
      status: "unpaid",
    });
    expect(nullObligation.originalAmount).toBeNull();
    expect(nullObligation.outstandingAmount).toBeNull();

    const instances: PaymentInstanceCompletenessRow[] = [
      {
        id: "pi-known-zero",
        paymentId: "tpl-1",
        instanceMonth: "2026-11-01",
        status: "unpaid",
        direction: "outflow",
        amount: "0.00",
        amountStatus: "known",
        providerPartyId: "p-1",
        categoryId: "c-1",
        ownerPartyId: "o-1",
      },
      {
        id: "pi-status-missing",
        paymentId: "tpl-2",
        instanceMonth: "2026-11-01",
        status: "unpaid",
        direction: "outflow",
        // Even if raw string is "0.00", explicit amount_status = 'missing' MUST surface as missing!
        amount: "0.00",
        amountStatus: "missing",
        providerPartyId: null,
        categoryId: null,
        ownerPartyId: null,
      },
      {
        id: "pi-null-amount",
        paymentId: "tpl-3",
        instanceMonth: "2026-11-01",
        status: "planned",
        direction: "outflow",
        amount: null,
        providerPartyId: null,
        categoryId: null,
        ownerPartyId: null,
      },
    ];

    const cashAccounts: CashAccountCompletenessRow[] = [
      { id: "ca-null-1", currency: "TRY", accountType: "bank_account", isActive: true, openingBalance: null },
      { id: "ca-null-2", currency: "TRY", accountType: "cash", isActive: true, openingBalance: "" },
      { id: "ca-zero-known", currency: "TRY", accountType: "bank_account", isActive: true, openingBalance: "0.00" },
      { id: "ca-positive", currency: "TRY", accountType: "bank_account", isActive: true, openingBalance: "25000.50" },
      { id: "ca-archived-null", currency: "TRY", accountType: "credit_card", isActive: false, archivedAt: "2026-09-01T00:00:00Z", openingBalance: null },
    ];

    const comp = evaluateCompletenessDimension({
      templates: [],
      instances,
      cashAccounts,
    });

    expect(comp.instanceGrain.activeOutflowInstances).toBe(3);
    expect(comp.instanceGrain.missingAmountCount).toBe(2);
    expect(comp.instanceGrain.openMissingAmountCount).toBe(2);

    const caGrain = comp.cashAccountGrain;
    expect(caGrain).not.toBeNull();
    expect(caGrain!.grain).toBe("cash_accounts");
    expect(caGrain!.totalAccounts).toBe(5);
    expect(caGrain!.activeAccounts).toBe(4);
    expect(caGrain!.archivedOrInactiveAccounts).toBe(1);
    expect(caGrain!.missingOpeningBalanceCount).toBe(2);
    expect(caGrain!.knownOpeningBalanceCount).toBe(2);
    expect(caGrain!.knownZeroOpeningBalanceCount).toBe(1);
    expect(caGrain!.sourceStatus).toBe("PARTIAL_MISSING_OPENING");

    expect(evaluateCashAccountCompleteness([]).sourceStatus).toBe("NO_ACTIVE_ACCOUNTS_VERIFIED");
    expect(
      evaluateCashAccountCompleteness([{ id: "ca-ok", isActive: true, openingBalance: "0.00" }])
        .sourceStatus,
    ).toBe("COMPLETE");
    expect(evaluateCashAccountCompleteness([], { schemaIncompatible: true }).sourceStatus).toBe(
      "SCHEMA_INCOMPATIBLE",
    );
  });

  it("10. [V2 F-16] flags duplicate check candidates matching (party_id, amount, maturity_date) for human review with 0 auto-merges and 0 mutations, while keeping distinct serial numbers separate", () => {
    const checks: CheckUniquenessCandidate[] = [
      {
        id: "chk-p1-a",
        partyId: "party-vendor-alpha",
        counterparty: "TEDARİKÇİ ALPHA A.Ş.",
        maturityDate: "2026-09-30",
        amount: "75000.00",
        currency: "TRY",
        direction: "outflow",
        status: "planned",
        serialNo: null,
      },
      {
        id: "chk-p1-b",
        partyId: "party-vendor-alpha",
        // Differing free-text label, same canonical (party_id, amount, maturity_date)
        counterparty: "Tedarikci Alpha",
        maturityDate: "2026-09-30",
        amount: 75_000,
        currency: "TRY",
        direction: "outflow",
        status: "planned",
        serialNo: null,
      },
      {
        id: "chk-distinct-serial-1",
        partyId: "party-vendor-beta",
        counterparty: "TEDARİKÇİ BETA",
        maturityDate: "2026-10-15",
        amount: "50000.00",
        currency: "TRY",
        direction: "outflow",
        status: "issued_to_vendor",
        serialNo: "SER-9001",
      },
      {
        id: "chk-distinct-serial-2",
        partyId: "party-vendor-beta",
        counterparty: "TEDARİKÇİ BETA",
        maturityDate: "2026-10-15",
        amount: "50000.00",
        currency: "TRY",
        direction: "outflow",
        status: "issued_to_vendor",
        serialNo: "SER-9002",
      },
    ];

    const u = evaluateUniquenessDimension({ checks });
    expect(u.autoMergedCount).toBe(0);
    expect(u.autoDeletedCount).toBe(0);
    expect(u.mutationsPerformed).toBe(0);
    expect(u.duplicateCheckSignatureClusters).toHaveLength(1);
    expect(u.duplicateCheckSignatureClusters[0]!.memberIds).toEqual(["chk-p1-a", "chk-p1-b"]);
    expect(u.humanReviewRequiredCount).toBe(1);
    expect(u.duplicateCheckHumanReviewCandidates).toHaveLength(1);
    expect(u.duplicateCheckHumanReviewCandidates[0]).toMatchObject({
      partyId: "party-vendor-alpha",
      memberIds: ["chk-p1-a", "chk-p1-b"],
      count: 2,
      missingSerialCount: 2,
      reviewStatus: "PENDING_HUMAN_DOCUMENT_REVIEW",
      requiresHumanReview: true,
    });
  });
});

describe.skipIf(!hasLiveDbConfig())("Agent 10 — Live Read-Only PostgreSQL 6-Dimension Data Quality Verification (prod_db_writes = 0)", () => {
  let ownerReadOnlyPool: Pool;
  let preTestDigest: DatabaseLineageDigest;
  let dbName = "";

  beforeAll(async () => {
    ownerReadOnlyPool = new Pool({
      connectionString: resolveOwnerReadOnlyUrl(),
      max: 1,
      connectionTimeoutMillis: 30_000,
      options: "-c default_transaction_read_only=on",
    });
    const roRes = await ownerReadOnlyPool.query<{
      transaction_read_only: string;
      db_name: string;
    }>("SELECT current_setting('transaction_read_only') AS transaction_read_only, current_database() AS db_name");
    expect(roRes.rows[0]?.transaction_read_only).toBe("on");
    dbName = roRes.rows[0]?.db_name ?? "";

    // Enforce SQLSTATE 25006 negative write probe: session MUST reject any mutation attempt
    await expect(
      ownerReadOnlyPool.query("DELETE FROM public.source_workbooks WHERE false"),
    ).rejects.toMatchObject({ code: "25006" });

    preTestDigest = await captureDatabaseDigest(ownerReadOnlyPool);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (ownerReadOnlyPool) {
      const postTestDigest = await captureDatabaseDigest(ownerReadOnlyPool);
      expect(postTestDigest).toEqual(preTestDigest);
      await ownerReadOnlyPool.end();
    }
  });

  it(
    "11. evaluates all 6 dimensions live against read-only PostgreSQL (zero DB mutations; verifies mas_radar_dev telemetry when connected to mas_radar_dev)",
    async () => {
      const report = await evaluateRemediationDataQuality(ownerReadOnlyPool, {
        asOf: "2026-11-18T15:14:51.000Z",
        instanceMonthScope: "2026-11-01",
      });

      // Universal structural invariants that hold on both disposable CI DBs and live mas_radar_dev
      expect(report.mutationsPerformed).toBe(0);
      expect(report.uniqueness.autoMergedCount).toBe(0);
      expect(report.uniqueness.autoDeletedCount).toBe(0);
      expect(report.uniqueness.mutationsPerformed).toBe(0);
      expect(report.sourceTraceability.mutationsPerformed).toBe(0);
      expect(report.consistency.hasZeroJoinMultiplication).toBe(true);
      expect(report.consistency.isConsistent).toBe(true);
      expect(report.validity.isDomainCurrencyAndStatusValid).toBe(true);
      expect(report.timeliness.viewParityVerified).toBe(true);
      expect(report.completeness.cashAccountGrain).not.toBeNull();

      if (dbName !== "mas_radar_dev" || preTestDigest.ir_count !== 1_601) {
        return;
      }

      // Dimension 1: Completeness (Template grain vs Instance grain vs CashAccount grain — I-011 & F-15)
      expect(report.completeness.templateGrain).toEqual({
        grain: "payments_template",
        totalTemplates: 19,
        activeOutflowTemplates: 18,
        archivedTemplates: 1,
        missingAmountCount: 12,
        missingProviderCount: 18,
        missingCategoryCount: 18,
        missingOwnerCount: 18,
        fullyCompleteActiveTemplates: 0,
        amountCompletenessRatio: report.completeness.templateGrain.amountCompletenessRatio,
      });
      expect(report.completeness.templateGrain.amountCompletenessRatio).toBeCloseTo(6 / 18, 8);

      const liveCashGrain = report.completeness.cashAccountGrain!;
      expect(liveCashGrain.grain).toBe("cash_accounts");
      expect(liveCashGrain.activeAccounts).toBe(6);
      expect(liveCashGrain.missingOpeningBalanceCount).toBe(6);
      expect(liveCashGrain.knownOpeningBalanceCount).toBe(0);
      expect(liveCashGrain.sourceStatus).toBe("PARTIAL_MISSING_OPENING");

      expect(report.completeness.instanceGrain.grain).toBe("payment_instances");
      expect(report.completeness.instanceGrain.monthScope).toBe("all");
      expect(report.completeness.instanceGrain.totalInstances).toBe(536);
      expect(report.completeness.instanceGrain.activeOutflowInstances).toBe(511);
      expect(report.completeness.instanceGrain.openOutflowInstances).toBe(509);
      expect(report.completeness.instanceGrain.paidOutflowInstances).toBe(2);
      expect(report.completeness.instanceGrain.cancelledOutflowInstances).toBe(25);
      expect(report.completeness.instanceGrain.missingAmountCount).toBe(330);
      expect(report.completeness.instanceGrain.openMissingAmountCount).toBe(330);
      expect(report.completeness.instanceGrain.missingProviderCount).toBe(511);
      expect(report.completeness.instanceGrain.missingCategoryCount).toBe(511);
      expect(report.completeness.instanceGrain.missingOwnerCount).toBe(511);

      expect(report.completeness.scopedMonthInstanceGrain).not.toBeNull();
      expect(report.completeness.scopedMonthInstanceGrain!.monthScope).toBe("2026-11-01");
      expect(report.completeness.scopedMonthInstanceGrain!.totalInstances).toBe(18);
      expect(report.completeness.scopedMonthInstanceGrain!.activeOutflowInstances).toBe(17);
      expect(report.completeness.scopedMonthInstanceGrain!.cancelledOutflowInstances).toBe(1);
      expect(report.completeness.scopedMonthInstanceGrain!.missingAmountCount).toBe(11);

      // Dimension 2: Validity (1,601 import_rows, 62 mapping_reviews, 100% domain currency/status valid)
      expect(report.validity.totalImportRows).toBe(1_601);
      expect(report.validity.mappedImportRows).toBe(1_021);
      expect(report.validity.unmappedImportRows).toBe(525);
      expect(report.validity.needsReviewImportRows).toBe(55);
      expect(report.validity.rejectedOrErrorImportRows).toBe(0);
      expect(report.validity.totalMappingReviews).toBe(62);
      expect(report.validity.openMappingReviews).toBe(52);
      expect(report.validity.rejectedMappingReviews).toBe(1);
      expect(report.validity.blockingMappingReviews).toBe(53);
      expect(report.validity.acceptedMappingReviews).toBe(2);
      expect(report.validity.resolvedMappingReviews).toBe(7);
      expect(report.validity.invalidCurrencyCount).toBe(0);
      expect(report.validity.invalidStatusCount).toBe(0);
      expect(report.validity.isDomainCurrencyAndStatusValid).toBe(true);
      expect(report.validity.stagingAcceptanceRatio).toBe(1);

      // Dimension 3: Uniqueness (2 active duplicate clusters = 5 active candidate checks, 0 auto-merges)
      expect(report.uniqueness.totalCheckCount).toBe(7);
      expect(report.uniqueness.activeCheckCount).toBe(6);
      expect(report.uniqueness.archivedCheckCount).toBe(1);
      expect(report.uniqueness.autoMergedCount).toBe(0);
      expect(report.uniqueness.controlDuplicateCheckPairCount).toBe(4);
      expect(report.uniqueness.controlDuplicateCheckInvolvedIds).toHaveLength(5);
      expect(report.uniqueness.controlDuplicatePaymentPairCount).toBe(0);
      expect(report.uniqueness.humanReviewRequiredCount).toBe(2);

      const cagdasCluster = report.uniqueness.duplicateCheckSignatureClusters.find(
        (c) => c.counterpartyNormalized === "çağdaş",
      );
      expect(cagdasCluster).toBeDefined();
      expect(cagdasCluster!.maturityDate).toBe("2026-08-31");
      expect(cagdasCluster!.amount).toBe(100_000);
      expect(cagdasCluster!.count).toBe(3);

      const akrCluster = report.uniqueness.duplicateCheckSignatureClusters.find(
        (c) => c.counterpartyNormalized === "akr",
      );
      expect(akrCluster).toBeDefined();
      expect(akrCluster!.maturityDate).toBe("2026-07-31");
      expect(akrCluster!.amount).toBe(45_000);
      expect(akrCluster!.count).toBe(2);

      // Dimension 4: Consistency (30 months reconciled, 0 join multiplication)
      expect(report.consistency.evaluatedMonthCount).toBe(30);
      expect(report.consistency.mismatchedMonthCount).toBe(0);
      expect(report.consistency.rawInstanceCount).toBe(536);
      expect(report.consistency.joinedInstanceCount).toBe(536);
      expect(report.consistency.distinctInstanceIdCount).toBe(536);
      expect(report.consistency.templateBackedInstanceCount).toBe(536);
      expect(report.consistency.distinctTemplateMonthPairCount).toBe(536);
      expect(report.consistency.joinMultipliedRowCount).toBe(0);
      expect(report.consistency.hasZeroJoinMultiplication).toBe(true);
      expect(report.consistency.isConsistent).toBe(true);

      // Dimension 5: Timeliness / Valid-Import Freshness (124 days old -> isStale = true, freshnessStatus = STALE)
      expect(report.timeliness.totalWorkbookCount).toBe(1);
      expect(report.timeliness.validWorkbookCount).toBe(1);
      expect(report.timeliness.emptyWorkbooksExcludedCount).toBe(0);
      expect(report.timeliness.failedOrPendingWorkbooksExcludedCount).toBe(0);
      expect(report.timeliness.latestValidFilename).toBe("TEMİZ.xlsx");
      expect(report.timeliness.latestValidImportAgeDays).toBe(124);
      expect(report.timeliness.staleThresholdDays).toBe(45);
      expect(report.timeliness.isStale).toBe(true);
      expect(report.timeliness.freshnessStatus).toBe("STALE");
      expect(report.timeliness.viewParityVerified).toBe(true);

      // Dimension 6: Source Traceability & Demo/Seed Lineage (I-016)
      expect(report.sourceTraceability.mutationsPerformed).toBe(0);
      expect(report.sourceTraceability.payments.totalCount).toBe(19);
      expect(report.sourceTraceability.payments.workbookTracedCount).toBe(19);
      expect(report.sourceTraceability.payments.untracedManualCount).toBe(0);
      expect(report.sourceTraceability.payments.demoOrSeedCount).toBe(1);

      expect(report.sourceTraceability.paymentInstances.totalCount).toBe(536);
      expect(report.sourceTraceability.paymentInstances.directWorkbookTracedCount).toBe(0);
      expect(report.sourceTraceability.paymentInstances.templateInheritedWorkbookTracedCount).toBe(536);
      expect(report.sourceTraceability.paymentInstances.generatedRecurringCount).toBe(68);
      expect(report.sourceTraceability.paymentInstances.nonGeneratedAmountSourceCount).toBe(468);
      expect(report.sourceTraceability.paymentInstances.untracedCount).toBe(0);
      expect(report.sourceTraceability.paymentInstances.demoOrSeedCount).toBeGreaterThanOrEqual(2);

      expect(report.sourceTraceability.checks.totalCount).toBe(7);
      expect(report.sourceTraceability.checks.workbookTracedCount).toBe(7);
      expect(report.sourceTraceability.checks.untracedManualCount).toBe(0);
      expect(report.sourceTraceability.checks.demoOrSeedCount).toBe(1);

      expect(report.sourceTraceability.auxiliaryDemoOrSeed).toEqual({
        externalAssumptionsDemoCount: 6,
        scenariosDemoCount: 4,
        actionItemsDemoCount: 3,
        checkEventsDemoCount: 3,
      });
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});
