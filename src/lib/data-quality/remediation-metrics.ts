/**
 * MAS Nexus — Data Pipeline & 6-Dimension Data Quality Evaluator (Phase D · Agent 10).
 *
 * Covers remediation items I-005 (Valid-Import Freshness), I-011 (Template vs Instance Grain &
 * Non-Destructive Duplicate Surfacing), and I-016 (Source Traceability & Demo/Seed Lineage).
 *
 * INVARIANTS:
 *  - Strictly read-only (`SELECT` only) and deterministic: never deletes, merges, or mutates rows.
 *  - Blank != Zero: missing obligation amounts (`null`) are counted explicitly, never coerced to `0`.
 *  - Boundary compliant: zero environment reads and zero network calls.
 */

import type { Pool, PoolClient } from "pg";
import type { SourceCompletenessStatus } from "@/lib/contracts/remediation-contracts";
import { DomainError } from "@/lib/domain-error";
import { formatMoneyOrNull, intOrNull, moneyOrNull, ratioOrNull } from "@/lib/money";
import { monthSummary } from "@/lib/radar/queries";

export const DEFAULT_VALID_IMPORT_STALE_DAYS = 45 as const;

export type QueryablePool = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export const VALID_OBLIGATION_CURRENCIES: ReadonlySet<string> = new Set([
  "TRY",
  "USD",
  "EUR",
  "GBP",
  "CHF",
  "JPY",
  "CAD",
  "AUD",
  "SEK",
  "NOK",
  "DKK",
  "SAR",
  "AED",
  "QAR",
  "KWD",
  "RUB",
  "CNY",
]);

export const VALID_PAYMENT_TEMPLATE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "paused",
  "archived",
  "completed",
  "cancelled",
]);

export const VALID_PAYMENT_INSTANCE_STATUSES: ReadonlySet<string> = new Set([
  "planned",
  "unpaid",
  "partial",
  "late",
  "paid",
  "cancelled",
  "unknown",
]);

export const VALID_CHECK_STATUSES: ReadonlySet<string> = new Set([
  "planned",
  "unknown",
  "in_portfolio",
  "endorsed_to_vendor",
  "endorsed",
  "in_bank_collection",
  "in_bank_collateral",
  "issued_to_vendor",
  "cleared",
  "collected",
  "paid",
  "bounced",
  "returned",
  "discounted",
  "cancelled",
]);

const OPEN_INSTANCE_STATUSES: ReadonlySet<string> = new Set([
  "unpaid",
  "partial",
  "planned",
  "late",
]);

/* ── Shared Normalization & Lineage Helpers ─────────────────────────────────────────── */

/**
 * Turkish-aware deterministic normalization for counterparty and template business signatures.
 * Ensures "ÇAĞDAŞ", "çağdaş", and "  Çağdaş  " produce the identical key "çağdaş",
 * while dotless "I" maps to "ı" rather than ASCII "i".
 */
export function normalizeBusinessSignatureToken(raw: string | null | undefined): string {
  if (raw == null) return "";
  return raw
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .toLocaleLowerCase("tr-TR")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Deterministic check duplicate signature (`counterparty + maturity_date + amount + currency + direction`).
 * Used to flag suspicious duplicate obligations without auto-merging legitimate independent instruments.
 */
export function buildCheckBusinessSignature(input: {
  counterparty: string | null | undefined;
  maturityDate: string | null | undefined;
  amount: string | number | null | undefined;
  currency?: string | null | undefined;
  direction?: string | null | undefined;
}): string {
  const cp = normalizeBusinessSignatureToken(input.counterparty) || "(lehtar yok)";
  const datePart = (input.maturityDate ?? "").trim().slice(0, 10) || "unknown_date";
  const amountPart = formatMoneyOrNull(input.amount ?? null) ?? "unknown_amount";
  const currPart = (input.currency ?? "TRY").trim().toUpperCase() || "TRY";
  const dirPart = (input.direction ?? "outflow").trim().toLowerCase() || "outflow";
  return `${cp}|${datePart}|${amountPart}|${currPart}|${dirPart}`;
}

/**
 * Deterministic payment template duplicate signature (`name + provider + recurrence + due_day + amount + currency`).
 */
export function buildPaymentTemplateBusinessSignature(input: {
  name: string | null | undefined;
  providerPartyId?: string | null | undefined;
  recurrenceType?: string | null | undefined;
  dueDay?: number | null | undefined;
  defaultAmount?: string | number | null | undefined;
  currency?: string | null | undefined;
}): string {
  const namePart = normalizeBusinessSignatureToken(input.name) || "(adsız ödeme)";
  const providerPart = (input.providerPartyId ?? "").trim().toLowerCase();
  const recurrencePart = (input.recurrenceType ?? "monthly").trim().toLowerCase() || "monthly";
  const dueDayPart = input.dueDay == null ? "-1" : String(input.dueDay);
  const amountPart = formatMoneyOrNull(input.defaultAmount ?? null) ?? "unknown_amount";
  const currPart = (input.currency ?? "TRY").trim().toUpperCase() || "TRY";
  return `${namePart}|${providerPart}|${recurrencePart}|${dueDayPart}|${amountPart}|${currPart}`;
}

/**
 * Pure detector for demo or seed lineage markers (`name ILIKE 'Demo %'` or notes/reasons containing
 * `'seed'` / `'demo'`). Classifies records transparently without mutating or deleting canonical rows.
 */
export function hasDemoOrSeedLineage(input: {
  name?: string | null | undefined;
  notes?: ReadonlyArray<string | null | undefined>;
}): boolean {
  const trimmedName = (input.name ?? "").trim();
  if (/^demo(?:\b|[\s:_-])/i.test(trimmedName)) {
    return true;
  }
  for (const rawNote of input.notes ?? []) {
    if (!rawNote) continue;
    const text = rawNote.trim();
    if (!text) continue;
    if (/seed/i.test(text) || /(?:^|\b)demo(?:\b|[\s:_-])/i.test(text)) {
      return true;
    }
  }
  return false;
}

export function isValidObligationCurrency(currency: string | null | undefined): boolean {
  if (typeof currency !== "string") return false;
  const normalized = currency.trim();
  return VALID_OBLIGATION_CURRENCIES.has(normalized);
}

/* ── Dimension 1: Completeness (Template Grain vs Instance Grain — I-011) ───────────── */

export interface PaymentTemplateCompletenessRow {
  id: string;
  name: string;
  status: string;
  direction?: string | null;
  currency?: string | null;
  defaultAmount: number | string | null;
  providerPartyId: string | null;
  categoryId: string | null;
  ownerPartyId: string | null;
  archivedAt?: string | null;
}

export interface PaymentInstanceCompletenessRow {
  id: string;
  paymentId: string | null;
  instanceMonth: string;
  status: string;
  direction?: string | null;
  currency?: string | null;
  amount: number | string | null;
  amountStatus?: string | null;
  cancelledAt?: string | null;
  providerPartyId: string | null;
  categoryId: string | null;
  ownerPartyId: string | null;
}

export interface CashAccountCompletenessRow {
  id: string;
  name?: string | null;
  currency?: string | null;
  accountType?: string | null;
  isActive?: boolean | null;
  archivedAt?: string | null;
  openingBalance: number | string | null;
}

export interface TemplateGrainCompletenessMetrics {
  grain: "payments_template";
  totalTemplates: number;
  activeOutflowTemplates: number;
  archivedTemplates: number;
  missingAmountCount: number;
  missingProviderCount: number;
  missingCategoryCount: number;
  missingOwnerCount: number;
  fullyCompleteActiveTemplates: number;
  amountCompletenessRatio: number | null;
}

export interface InstanceGrainCompletenessMetrics {
  grain: "payment_instances";
  monthScope: string;
  totalInstances: number;
  activeOutflowInstances: number;
  openOutflowInstances: number;
  paidOutflowInstances: number;
  cancelledOutflowInstances: number;
  missingAmountCount: number;
  openMissingAmountCount: number;
  missingProviderCount: number;
  missingCategoryCount: number;
  missingOwnerCount: number;
  fullyCompleteActiveInstances: number;
  amountCompletenessRatio: number | null;
}

export interface CashAccountCompletenessMetrics {
  grain: "cash_accounts";
  totalAccounts: number;
  activeAccounts: number;
  archivedOrInactiveAccounts: number;
  knownOpeningBalanceCount: number;
  missingOpeningBalanceCount: number;
  knownZeroOpeningBalanceCount: number;
  openingBalanceCompletenessRatio: number | null;
  sourceStatus: SourceCompletenessStatus;
}

export interface CompletenessDimensionMetrics {
  templateGrain: TemplateGrainCompletenessMetrics;
  instanceGrain: InstanceGrainCompletenessMetrics;
  scopedMonthInstanceGrain: InstanceGrainCompletenessMetrics | null;
  cashAccountGrain: CashAccountCompletenessMetrics | null;
}

export function evaluateTemplateCompleteness(
  templates: readonly PaymentTemplateCompletenessRow[],
): TemplateGrainCompletenessMetrics {
  let activeOutflowTemplates = 0;
  let archivedTemplates = 0;
  let missingAmountCount = 0;
  let missingProviderCount = 0;
  let missingCategoryCount = 0;
  let missingOwnerCount = 0;
  let fullyCompleteActiveTemplates = 0;

  for (const tpl of templates) {
    const isArchived = tpl.archivedAt != null || tpl.status === "archived";
    if (isArchived) {
      archivedTemplates += 1;
      continue;
    }
    const direction = (tpl.direction ?? "outflow").trim().toLowerCase() || "outflow";
    if (tpl.status !== "active" || direction !== "outflow") {
      continue;
    }
    activeOutflowTemplates += 1;

    // Blank != Zero: `0` is a known zero amount; only `null` / empty is missing.
    const parsedAmount = moneyOrNull(tpl.defaultAmount);
    const missingAmount = parsedAmount === null;
    const missingProvider = !tpl.providerPartyId;
    const missingCategory = !tpl.categoryId;
    const missingOwner = !tpl.ownerPartyId;

    if (missingAmount) missingAmountCount += 1;
    if (missingProvider) missingProviderCount += 1;
    if (missingCategory) missingCategoryCount += 1;
    if (missingOwner) missingOwnerCount += 1;
    if (!missingAmount && !missingProvider && !missingCategory && !missingOwner) {
      fullyCompleteActiveTemplates += 1;
    }
  }

  return {
    grain: "payments_template",
    totalTemplates: templates.length,
    activeOutflowTemplates,
    archivedTemplates,
    missingAmountCount,
    missingProviderCount,
    missingCategoryCount,
    missingOwnerCount,
    fullyCompleteActiveTemplates,
    amountCompletenessRatio: ratioOrNull(
      activeOutflowTemplates - missingAmountCount,
      activeOutflowTemplates,
    ),
  };
}

export function evaluateInstanceCompleteness(
  instances: readonly PaymentInstanceCompletenessRow[],
  monthScope = "all",
): InstanceGrainCompletenessMetrics {
  const scoped =
    monthScope === "all"
      ? instances
      : instances.filter((inst) => inst.instanceMonth.slice(0, 10) === monthScope);

  let activeOutflowInstances = 0;
  let openOutflowInstances = 0;
  let paidOutflowInstances = 0;
  let cancelledOutflowInstances = 0;
  let missingAmountCount = 0;
  let openMissingAmountCount = 0;
  let missingProviderCount = 0;
  let missingCategoryCount = 0;
  let missingOwnerCount = 0;
  let fullyCompleteActiveInstances = 0;

  for (const inst of scoped) {
    const direction = (inst.direction ?? "outflow").trim().toLowerCase() || "outflow";
    if (direction !== "outflow") continue;

    const isCancelled = inst.status === "cancelled" || inst.cancelledAt != null;
    if (isCancelled) {
      cancelledOutflowInstances += 1;
      continue;
    }

    activeOutflowInstances += 1;
    const isOpen = OPEN_INSTANCE_STATUSES.has(inst.status);
    if (isOpen) openOutflowInstances += 1;
    if (inst.status === "paid") paidOutflowInstances += 1;

    const parsedAmount = moneyOrNull(inst.amount);
    const normalizedAmountStatus = (inst.amountStatus ?? "").trim().toLowerCase();
    const missingAmount = parsedAmount === null || normalizedAmountStatus === "missing";
    const missingProvider = !inst.providerPartyId;
    const missingCategory = !inst.categoryId;
    const missingOwner = !inst.ownerPartyId;

    if (missingAmount) {
      missingAmountCount += 1;
      if (isOpen) openMissingAmountCount += 1;
    }
    if (missingProvider) missingProviderCount += 1;
    if (missingCategory) missingCategoryCount += 1;
    if (missingOwner) missingOwnerCount += 1;
    if (!missingAmount && !missingProvider && !missingCategory && !missingOwner) {
      fullyCompleteActiveInstances += 1;
    }
  }

  return {
    grain: "payment_instances",
    monthScope,
    totalInstances: scoped.length,
    activeOutflowInstances,
    openOutflowInstances,
    paidOutflowInstances,
    cancelledOutflowInstances,
    missingAmountCount,
    openMissingAmountCount,
    missingProviderCount,
    missingCategoryCount,
    missingOwnerCount,
    fullyCompleteActiveInstances,
    amountCompletenessRatio: ratioOrNull(
      activeOutflowInstances - missingAmountCount,
      activeOutflowInstances,
    ),
  };
}

export function evaluateCashAccountCompleteness(
  accounts: readonly CashAccountCompletenessRow[],
  options: { schemaIncompatible?: boolean } = {},
): CashAccountCompletenessMetrics {
  if (options.schemaIncompatible) {
    return {
      grain: "cash_accounts",
      totalAccounts: 0,
      activeAccounts: 0,
      archivedOrInactiveAccounts: 0,
      knownOpeningBalanceCount: 0,
      missingOpeningBalanceCount: 0,
      knownZeroOpeningBalanceCount: 0,
      openingBalanceCompletenessRatio: null,
      sourceStatus: "SCHEMA_INCOMPATIBLE",
    };
  }

  let activeAccounts = 0;
  let archivedOrInactiveAccounts = 0;
  let knownOpeningBalanceCount = 0;
  let missingOpeningBalanceCount = 0;
  let knownZeroOpeningBalanceCount = 0;

  for (const acc of accounts) {
    const isArchivedOrInactive = acc.isActive === false || acc.archivedAt != null;
    if (isArchivedOrInactive) {
      archivedOrInactiveAccounts += 1;
      continue;
    }
    activeAccounts += 1;

    // Blank != Zero: `opening_balance IS NULL` (or blank string) stays missing, NEVER coerced to `0`.
    const parsedOpening = moneyOrNull(acc.openingBalance);
    if (parsedOpening === null) {
      missingOpeningBalanceCount += 1;
    } else {
      knownOpeningBalanceCount += 1;
      if (parsedOpening === 0) {
        knownZeroOpeningBalanceCount += 1;
      }
    }
  }

  let sourceStatus: SourceCompletenessStatus;
  if (activeAccounts === 0) {
    sourceStatus = "NO_ACTIVE_ACCOUNTS_VERIFIED";
  } else if (missingOpeningBalanceCount > 0) {
    sourceStatus = "PARTIAL_MISSING_OPENING";
  } else {
    sourceStatus = "COMPLETE";
  }

  return {
    grain: "cash_accounts",
    totalAccounts: accounts.length,
    activeAccounts,
    archivedOrInactiveAccounts,
    knownOpeningBalanceCount,
    missingOpeningBalanceCount,
    knownZeroOpeningBalanceCount,
    openingBalanceCompletenessRatio: ratioOrNull(knownOpeningBalanceCount, activeAccounts),
    sourceStatus,
  };
}

export function evaluateCompletenessDimension(input: {
  templates: readonly PaymentTemplateCompletenessRow[];
  instances: readonly PaymentInstanceCompletenessRow[];
  instanceMonthScope?: string | null;
  cashAccounts?: readonly CashAccountCompletenessRow[] | null;
  cashAccountGrainOverride?: CashAccountCompletenessMetrics | null;
}): CompletenessDimensionMetrics {
  return {
    templateGrain: evaluateTemplateCompleteness(input.templates),
    instanceGrain: evaluateInstanceCompleteness(input.instances, "all"),
    scopedMonthInstanceGrain: input.instanceMonthScope
      ? evaluateInstanceCompleteness(input.instances, input.instanceMonthScope)
      : null,
    cashAccountGrain:
      input.cashAccountGrainOverride !== undefined
        ? input.cashAccountGrainOverride
        : input.cashAccounts
          ? evaluateCashAccountCompleteness(input.cashAccounts)
          : null,
  };
}

/* ── Dimension 2: Validity (Staging Rejections, Blocking Reviews, Domain Enums) ────── */

export interface StagingStatusCountInput {
  mappingStatus: string;
  count: number;
}

export interface MappingReviewStatusCountInput {
  status: string;
  count: number;
}

export interface DomainValiditySampleRow {
  entityTable: "payments" | "payment_instances" | "checks";
  currency: string | null | undefined;
  status: string | null | undefined;
}

export interface ValidityDimensionMetrics {
  totalImportRows: number;
  mappedImportRows: number;
  unmappedImportRows: number;
  needsReviewImportRows: number;
  rejectedOrErrorImportRows: number;
  blockedByParentImportRows: number;
  totalMappingReviews: number;
  openMappingReviews: number;
  rejectedMappingReviews: number;
  blockingMappingReviews: number;
  acceptedMappingReviews: number;
  resolvedMappingReviews: number;
  invalidCurrencyCount: number;
  invalidStatusCount: number;
  isDomainCurrencyAndStatusValid: boolean;
  stagingAcceptanceRatio: number | null;
}

export function evaluateValidityDimension(input: {
  stagingCounts: readonly StagingStatusCountInput[];
  reviewCounts: readonly MappingReviewStatusCountInput[];
  domainRows?: readonly DomainValiditySampleRow[];
  precomputedDomainInvalid?: { invalidCurrencyCount: number; invalidStatusCount: number };
}): ValidityDimensionMetrics {
  let totalImportRows = 0;
  let mappedImportRows = 0;
  let unmappedImportRows = 0;
  let needsReviewImportRows = 0;
  let rejectedOrErrorImportRows = 0;
  let blockedByParentImportRows = 0;

  for (const item of input.stagingCounts) {
    const n = Math.max(0, Math.trunc(item.count));
    totalImportRows += n;
    const st = item.mappingStatus.trim().toLowerCase();
    if (st === "mapped") mappedImportRows += n;
    else if (st === "unmapped" || st === "pending") unmappedImportRows += n;
    else if (st === "needs_review") needsReviewImportRows += n;
    else if (st === "rejected" || st === "error") rejectedOrErrorImportRows += n;
    else if (st === "blocked_by_parent") blockedByParentImportRows += n;
  }

  let totalMappingReviews = 0;
  let openMappingReviews = 0;
  let rejectedMappingReviews = 0;
  let acceptedMappingReviews = 0;
  let resolvedMappingReviews = 0;

  for (const rev of input.reviewCounts) {
    const n = Math.max(0, Math.trunc(rev.count));
    totalMappingReviews += n;
    const st = rev.status.trim().toLowerCase();
    if (st === "open") openMappingReviews += n;
    else if (st === "rejected") rejectedMappingReviews += n;
    else if (st === "accepted") acceptedMappingReviews += n;
    else if (st === "resolved") resolvedMappingReviews += n;
  }

  let invalidCurrencyCount = input.precomputedDomainInvalid?.invalidCurrencyCount ?? 0;
  let invalidStatusCount = input.precomputedDomainInvalid?.invalidStatusCount ?? 0;

  if (input.domainRows) {
    for (const r of input.domainRows) {
      if (!isValidObligationCurrency(r.currency)) {
        invalidCurrencyCount += 1;
      }
      const st = (r.status ?? "").trim();
      const statusValid =
        r.entityTable === "payments"
          ? VALID_PAYMENT_TEMPLATE_STATUSES.has(st)
          : r.entityTable === "payment_instances"
            ? VALID_PAYMENT_INSTANCE_STATUSES.has(st)
            : VALID_CHECK_STATUSES.has(st);
      if (!statusValid) {
        invalidStatusCount += 1;
      }
    }
  }

  const blockingMappingReviews = openMappingReviews + rejectedMappingReviews;

  return {
    totalImportRows,
    mappedImportRows,
    unmappedImportRows,
    needsReviewImportRows,
    rejectedOrErrorImportRows,
    blockedByParentImportRows,
    totalMappingReviews,
    openMappingReviews,
    rejectedMappingReviews,
    blockingMappingReviews,
    acceptedMappingReviews,
    resolvedMappingReviews,
    invalidCurrencyCount,
    invalidStatusCount,
    isDomainCurrencyAndStatusValid: invalidCurrencyCount === 0 && invalidStatusCount === 0,
    stagingAcceptanceRatio: ratioOrNull(
      totalImportRows - rejectedOrErrorImportRows,
      totalImportRows,
    ),
  };
}

/* ── Dimension 3: Uniqueness (Duplicate Surfacing Without Auto-Merging — I-011) ────── */

export interface CheckUniquenessCandidate {
  id: string;
  partyId?: string | null;
  counterparty: string | null;
  maturityDate: string | null;
  amount: number | string | null;
  currency?: string | null;
  direction?: string | null;
  status: string;
  serialNo?: string | null;
  mappingReviewStatus?: string | null;
  archivedAt?: string | null;
}

export interface PaymentUniquenessCandidate {
  id: string;
  name: string;
  providerPartyId: string | null;
  recurrenceType: string;
  dueDay: number | null;
  defaultAmount: number | string | null;
  currency?: string | null;
  status: string;
  archivedAt?: string | null;
}

export interface DuplicateCheckCluster {
  signature: string;
  counterpartyNormalized: string;
  maturityDate: string;
  amount: number | null;
  currency: string;
  direction: string;
  memberIds: string[];
  count: number;
}

export type DuplicateHumanReviewStatus =
  | "PENDING_HUMAN_DOCUMENT_REVIEW"
  | "OPEN_MAPPING_REVIEW"
  | "ACCEPTED_DISTINCT_INSTRUMENT"
  | "RESOLVED_EXCLUDED_DUPLICATE";

export interface DuplicateCheckHumanReviewCandidate {
  signature: string;
  partyId: string | null;
  counterpartyNormalized: string;
  maturityDate: string;
  amount: number | null;
  currency: string;
  direction: string;
  memberIds: string[];
  count: number;
  missingSerialCount: number;
  reviewStatus: DuplicateHumanReviewStatus;
  requiresHumanReview: boolean;
  auditReason: string;
}

export interface DuplicatePaymentCluster {
  signature: string;
  nameNormalized: string;
  dueDay: number | null;
  defaultAmount: number | null;
  currency: string;
  memberIds: string[];
  count: number;
}

export interface UniquenessDimensionMetrics {
  totalCheckCount: number;
  activeCheckCount: number;
  archivedCheckCount: number;
  controlDuplicateCheckPairCount: number;
  controlDuplicateCheckInvolvedIds: string[];
  duplicateCheckSignatureClusters: DuplicateCheckCluster[];
  humanReviewRequiredCount: number;
  duplicateCheckHumanReviewCandidates: DuplicateCheckHumanReviewCandidate[];
  controlDuplicatePaymentPairCount: number;
  controlDuplicatePaymentInvolvedIds: string[];
  duplicatePaymentSignatureClusters: DuplicatePaymentCluster[];
  /** Explicit non-destructive invariant: suspicious duplicates are flagged, NEVER auto-merged. */
  autoMergedCount: 0;
  /** Explicit non-destructive invariant: suspicious duplicates are NEVER auto-deleted. */
  autoDeletedCount: 0;
  /** Explicit read-only guarantee: uniqueness evaluation performs zero mutations. */
  mutationsPerformed: 0;
}

interface InternalCheckBucketMember {
  id: string;
  partyId: string | null;
  serialNorm: string | null;
  mappingReviewStatus: string | null;
}

export function evaluateUniquenessDimension(input: {
  checks: readonly CheckUniquenessCandidate[];
  payments?: readonly PaymentUniquenessCandidate[];
  controlDuplicateCheckPairs?: ReadonlyArray<{ checkId: string; duplicateOfCheckId: string }>;
  controlDuplicatePaymentPairs?: ReadonlyArray<{
    paymentId: string;
    duplicateOfPaymentId: string;
  }>;
}): UniquenessDimensionMetrics {
  let activeCheckCount = 0;
  let archivedCheckCount = 0;

  // Canonicalize counterparty token across checks sharing the same `partyId` (`F-16`: `(party_id, amount, maturity_date)`).
  const canonicalLabelByPartyKey = new Map<string, { partyId: string; label: string }>();
  for (const chk of input.checks) {
    if (chk.archivedAt != null || chk.status === "cancelled" || chk.status === "returned") {
      continue;
    }
    const rawPartyId = (chk.partyId ?? "").trim();
    if (!rawPartyId) continue;
    const partyKey = rawPartyId.toLowerCase();
    const normCp = normalizeBusinessSignatureToken(chk.counterparty);
    const existing = canonicalLabelByPartyKey.get(partyKey);
    if (!existing) {
      canonicalLabelByPartyKey.set(partyKey, {
        partyId: rawPartyId,
        label: normCp || `party:${partyKey}`,
      });
    } else if (existing.label.startsWith("party:") && normCp) {
      existing.label = normCp;
    }
  }

  const checkBuckets = new Map<
    string,
    {
      signature: string;
      partyId: string | null;
      counterpartyNormalized: string;
      maturityDate: string;
      amount: number | null;
      currency: string;
      direction: string;
      members: InternalCheckBucketMember[];
    }
  >();

  for (const chk of input.checks) {
    if (chk.archivedAt != null) {
      archivedCheckCount += 1;
      continue;
    }
    if (chk.status === "cancelled" || chk.status === "returned") {
      continue;
    }
    activeCheckCount += 1;

    const rawPartyId = (chk.partyId ?? "").trim() || null;
    const partyKey = rawPartyId ? rawPartyId.toLowerCase() : null;
    const partyMeta = partyKey ? canonicalLabelByPartyKey.get(partyKey) : undefined;
    const counterpartyNormalized =
      (partyMeta ? partyMeta.label : normalizeBusinessSignatureToken(chk.counterparty)) ||
      "(lehtar yok)";

    const signature = buildCheckBusinessSignature({
      counterparty: counterpartyNormalized,
      maturityDate: chk.maturityDate,
      amount: chk.amount,
      currency: chk.currency,
      direction: chk.direction,
    });

    let bucket = checkBuckets.get(signature);
    if (!bucket) {
      bucket = {
        signature,
        partyId: partyMeta?.partyId ?? rawPartyId,
        counterpartyNormalized,
        maturityDate: (chk.maturityDate ?? "").trim().slice(0, 10) || "unknown_date",
        amount: moneyOrNull(chk.amount),
        currency: (chk.currency ?? "TRY").trim().toUpperCase() || "TRY",
        direction: (chk.direction ?? "outflow").trim().toLowerCase() || "outflow",
        members: [],
      };
      checkBuckets.set(signature, bucket);
    }
    const serialNorm = (chk.serialNo ?? "").trim().toLowerCase() || null;
    const reviewNorm = (chk.mappingReviewStatus ?? "").trim().toLowerCase() || null;
    bucket.members.push({
      id: chk.id,
      partyId: rawPartyId,
      serialNorm,
      mappingReviewStatus: reviewNorm,
    });
  }

  const duplicateCheckSignatureClusters: DuplicateCheckCluster[] = [];
  const duplicateCheckHumanReviewCandidates: DuplicateCheckHumanReviewCandidate[] = [];

  for (const bucket of checkBuckets.values()) {
    if (bucket.members.length < 2) continue;

    // Mirror `public.control_duplicate_checks`: two checks with the same `(party, amount, maturity_date)`
    // are duplicate candidates iff at least one lacks `serial_no` OR their normalized `serial_no` matches.
    const compatibleMemberIndexes = new Set<number>();
    for (let i = 0; i < bucket.members.length; i += 1) {
      for (let j = i + 1; j < bucket.members.length; j += 1) {
        const a = bucket.members[i]!;
        const b = bucket.members[j]!;
        const serialCompatible =
          a.serialNorm === null || b.serialNorm === null || a.serialNorm === b.serialNorm;
        if (serialCompatible) {
          compatibleMemberIndexes.add(i);
          compatibleMemberIndexes.add(j);
        }
      }
    }

    if (compatibleMemberIndexes.size < 2) continue;

    const involvedMembers = [...compatibleMemberIndexes].map((idx) => bucket.members[idx]!);
    const sortedIds = involvedMembers.map((m) => m.id).sort();
    const missingSerialCount = involvedMembers.filter((m) => m.serialNorm === null).length;

    duplicateCheckSignatureClusters.push({
      signature: bucket.signature,
      counterpartyNormalized: bucket.counterpartyNormalized,
      maturityDate: bucket.maturityDate,
      amount: bucket.amount,
      currency: bucket.currency,
      direction: bucket.direction,
      memberIds: sortedIds,
      count: sortedIds.length,
    });

    const reviewStates = involvedMembers
      .map((m) => m.mappingReviewStatus)
      .filter((s): s is string => s !== null);

    let reviewStatus: DuplicateHumanReviewStatus = "PENDING_HUMAN_DOCUMENT_REVIEW";
    let requiresHumanReview = true;
    if (reviewStates.length > 0 && reviewStates.every((s) => s === "accepted")) {
      reviewStatus = "ACCEPTED_DISTINCT_INSTRUMENT";
      requiresHumanReview = false;
    } else if (reviewStates.some((s) => s === "open" || s === "rejected")) {
      reviewStatus = "OPEN_MAPPING_REVIEW";
      requiresHumanReview = true;
    } else if (reviewStates.length > 0 && reviewStates.every((s) => s === "resolved")) {
      reviewStatus = "RESOLVED_EXCLUDED_DUPLICATE";
      requiresHumanReview = false;
    }

    duplicateCheckHumanReviewCandidates.push({
      signature: bucket.signature,
      partyId: bucket.partyId,
      counterpartyNormalized: bucket.counterpartyNormalized,
      maturityDate: bucket.maturityDate,
      amount: bucket.amount,
      currency: bucket.currency,
      direction: bucket.direction,
      memberIds: sortedIds,
      count: sortedIds.length,
      missingSerialCount,
      reviewStatus,
      requiresHumanReview,
      auditReason:
        "Matching (party/counterparty, amount, maturity_date) without distinct verified check serial numbers; flagged for human voucher review — zero auto-merge permitted.",
    });
  }

  duplicateCheckSignatureClusters.sort(
    (a, b) => b.count - a.count || a.signature.localeCompare(b.signature),
  );
  duplicateCheckHumanReviewCandidates.sort(
    (a, b) => b.count - a.count || a.signature.localeCompare(b.signature),
  );

  const paymentGroups = new Map<string, DuplicatePaymentCluster>();
  for (const pay of input.payments ?? []) {
    if (pay.archivedAt != null || pay.status !== "active") continue;
    const signature = buildPaymentTemplateBusinessSignature({
      name: pay.name,
      providerPartyId: pay.providerPartyId,
      recurrenceType: pay.recurrenceType,
      dueDay: pay.dueDay,
      defaultAmount: pay.defaultAmount,
      currency: pay.currency,
    });
    let group = paymentGroups.get(signature);
    if (!group) {
      group = {
        signature,
        nameNormalized: normalizeBusinessSignatureToken(pay.name) || "(adsız ödeme)",
        dueDay: pay.dueDay,
        defaultAmount: moneyOrNull(pay.defaultAmount),
        currency: (pay.currency ?? "TRY").trim().toUpperCase() || "TRY",
        memberIds: [],
        count: 0,
      };
      paymentGroups.set(signature, group);
    }
    group.memberIds.push(pay.id);
    group.count += 1;
  }

  const duplicatePaymentSignatureClusters = [...paymentGroups.values()]
    .filter((g) => g.count >= 2)
    .map((g) => ({ ...g, memberIds: [...g.memberIds].sort() }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));

  // Derive pairwise counts when DB control view rows are not explicitly provided (unit tests).
  let controlDuplicateCheckPairCount: number;
  const checkInvolvedSet = new Set<string>();
  if (input.controlDuplicateCheckPairs) {
    controlDuplicateCheckPairCount = input.controlDuplicateCheckPairs.length;
    for (const pair of input.controlDuplicateCheckPairs) {
      checkInvolvedSet.add(pair.checkId);
      checkInvolvedSet.add(pair.duplicateOfCheckId);
    }
  } else {
    controlDuplicateCheckPairCount = duplicateCheckSignatureClusters.reduce(
      (sum, c) => sum + (c.count * (c.count - 1)) / 2,
      0,
    );
    for (const c of duplicateCheckSignatureClusters) {
      for (const id of c.memberIds) checkInvolvedSet.add(id);
    }
  }

  let controlDuplicatePaymentPairCount: number;
  const paymentInvolvedSet = new Set<string>();
  if (input.controlDuplicatePaymentPairs) {
    controlDuplicatePaymentPairCount = input.controlDuplicatePaymentPairs.length;
    for (const pair of input.controlDuplicatePaymentPairs) {
      paymentInvolvedSet.add(pair.paymentId);
      paymentInvolvedSet.add(pair.duplicateOfPaymentId);
    }
  } else {
    controlDuplicatePaymentPairCount = duplicatePaymentSignatureClusters.reduce(
      (sum, c) => sum + (c.count * (c.count - 1)) / 2,
      0,
    );
    for (const c of duplicatePaymentSignatureClusters) {
      for (const id of c.memberIds) paymentInvolvedSet.add(id);
    }
  }

  const humanReviewRequiredCount = duplicateCheckHumanReviewCandidates.filter(
    (c) => c.requiresHumanReview,
  ).length;

  return {
    totalCheckCount: input.checks.length,
    activeCheckCount,
    archivedCheckCount,
    controlDuplicateCheckPairCount,
    controlDuplicateCheckInvolvedIds: [...checkInvolvedSet].sort(),
    duplicateCheckSignatureClusters,
    humanReviewRequiredCount,
    duplicateCheckHumanReviewCandidates,
    controlDuplicatePaymentPairCount,
    controlDuplicatePaymentInvolvedIds: [...paymentInvolvedSet].sort(),
    duplicatePaymentSignatureClusters,
    autoMergedCount: 0,
    autoDeletedCount: 0,
    mutationsPerformed: 0,
  };
}

/* ── Dimension 4: Consistency (Month Bucket Sum & Zero Join Multiplication) ────────── */

export interface MonthStatusBucketSnapshot {
  monthStartISO: string;
  summaryTotalCount: number;
  summaryMissingCount: number;
  summaryCancelledCount: number;
  summaryUnexplainedGapTry: number;
  paidCount: number;
  partialCount: number;
  unpaidCount: number;
  plannedCount: number;
  lateCount: number;
  unknownStatusCount: number;
  cancelledOutflowCount: number;
  activeMissingAmountCount: number;
}

export interface EvaluatedMonthConsistency {
  monthStartISO: string;
  summaryTotalCount: number;
  statusBucketSum: number;
  summaryMissingCount: number;
  activeMissingAmountCount: number;
  summaryCancelledCount: number;
  cancelledOutflowCount: number;
  unexplainedGapTry: number;
  aligned: boolean;
}

export interface JoinCardinalitySnapshot {
  rawInstanceCount: number;
  joinedInstanceCount: number;
  distinctInstanceIdCount: number;
  templateBackedInstanceCount: number;
  distinctTemplateMonthPairCount: number;
}

export interface ConsistencyDimensionMetrics {
  evaluatedMonthCount: number;
  mismatchedMonthCount: number;
  months: EvaluatedMonthConsistency[];
  rawInstanceCount: number;
  joinedInstanceCount: number;
  distinctInstanceIdCount: number;
  templateBackedInstanceCount: number;
  distinctTemplateMonthPairCount: number;
  joinMultipliedRowCount: number;
  hasZeroJoinMultiplication: boolean;
  isConsistent: boolean;
}

export function evaluateConsistencyDimension(input: {
  monthSnapshots: readonly MonthStatusBucketSnapshot[];
  joinCardinality: JoinCardinalitySnapshot;
}): ConsistencyDimensionMetrics {
  const months: EvaluatedMonthConsistency[] = input.monthSnapshots.map((m) => {
    const statusBucketSum =
      m.paidCount +
      m.partialCount +
      m.unpaidCount +
      m.plannedCount +
      m.lateCount +
      m.unknownStatusCount;
    const aligned =
      m.summaryTotalCount === statusBucketSum &&
      m.summaryMissingCount === m.activeMissingAmountCount &&
      m.summaryCancelledCount === m.cancelledOutflowCount &&
      m.summaryUnexplainedGapTry === 0;
    return {
      monthStartISO: m.monthStartISO,
      summaryTotalCount: m.summaryTotalCount,
      statusBucketSum,
      summaryMissingCount: m.summaryMissingCount,
      activeMissingAmountCount: m.activeMissingAmountCount,
      summaryCancelledCount: m.summaryCancelledCount,
      cancelledOutflowCount: m.cancelledOutflowCount,
      unexplainedGapTry: m.summaryUnexplainedGapTry,
      aligned,
    };
  });

  const mismatchedMonthCount = months.filter((m) => !m.aligned).length;
  const jc = input.joinCardinality;
  const joinMultipliedRowCount = jc.joinedInstanceCount - jc.rawInstanceCount;
  const hasZeroJoinMultiplication =
    joinMultipliedRowCount === 0 &&
    jc.distinctInstanceIdCount === jc.rawInstanceCount &&
    jc.distinctTemplateMonthPairCount === jc.templateBackedInstanceCount;

  return {
    evaluatedMonthCount: months.length,
    mismatchedMonthCount,
    months,
    rawInstanceCount: jc.rawInstanceCount,
    joinedInstanceCount: jc.joinedInstanceCount,
    distinctInstanceIdCount: jc.distinctInstanceIdCount,
    templateBackedInstanceCount: jc.templateBackedInstanceCount,
    distinctTemplateMonthPairCount: jc.distinctTemplateMonthPairCount,
    joinMultipliedRowCount,
    hasZeroJoinMultiplication,
    isConsistent: mismatchedMonthCount === 0 && hasZeroJoinMultiplication,
  };
}

/* ── Dimension 5: Timeliness / Valid-Import Freshness (I-005) ──────────────────────── */

export type ValidImportFreshnessStatus =
  | "FRESH"
  | "STALE"
  | "NO_VALID_IMPORTS"
  | "SCHEMA_INCOMPATIBLE"
  | "UNKNOWN";

export interface ValidWorkbookImportSummary {
  id: string;
  originalFilename: string;
  status: string;
  importedAtISO: string;
  importRowCount: number;
  ageDays: number;
}

export interface WorkbookImportRecord {
  id: string;
  originalFilename: string;
  status: string;
  importedAt: Date | string;
  importRowCount: number;
  nonRejectedImportRowCount?: number | null;
  inValidWorkbookImportsView?: boolean | null;
}

export interface TimelinessDimensionMetrics {
  totalWorkbookCount: number;
  validWorkbookCount: number;
  emptyWorkbooksExcludedCount: number;
  failedOrPendingWorkbooksExcludedCount: number;
  latestValidImport: ValidWorkbookImportSummary | null;
  latestValidWorkbookId: string | null;
  latestValidFilename: string | null;
  latestValidImportedAtISO: string | null;
  latestValidImportAgeDays: number | null;
  latestRawWorkbookId: string | null;
  latestRawWorkbookStatus: string | null;
  staleThresholdDays: number;
  isStale: boolean;
  freshnessStatus: ValidImportFreshnessStatus;
  viewParityVerified: boolean;
  errorCode?: string | null;
}

function parseTimestampMsOrNull(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function toTimestampMs(value: Date | string): number {
  const ms = parseTimestampMsOrNull(value);
  if (ms === null) {
    throw new RangeError(`remediation-metrics: geçersiz tarih/zaman değeri: ${String(value)}`);
  }
  return ms;
}

const SCHEMA_INCOMPATIBLE_SQLSTATES: ReadonlySet<string> = new Set([
  "42P01", // undefined_table / missing view
  "42703", // undefined_column
  "42883", // undefined_function
  "42804", // datatype_mismatch
]);

function extractPgErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const raw = (err as { code?: unknown }).code;
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim().toUpperCase();
    }
  }
  return null;
}

export function isWorkbookValidImport(wb: {
  status: string | null | undefined;
  importRowCount: number;
  nonRejectedImportRowCount?: number | null;
  importedAt?: Date | string | null;
}): boolean {
  if (typeof wb.status !== "string") return false;
  const normalizedStatus = wb.status.trim().toLowerCase();
  if (normalizedStatus !== "parsed" && normalizedStatus !== "mapped") {
    return false;
  }
  if (!Number.isFinite(wb.importRowCount) || wb.importRowCount < 1) {
    return false;
  }
  if (
    wb.nonRejectedImportRowCount !== undefined &&
    wb.nonRejectedImportRowCount !== null &&
    (!Number.isFinite(wb.nonRejectedImportRowCount) || wb.nonRejectedImportRowCount < 1)
  ) {
    return false;
  }
  if (wb.importedAt !== undefined && parseTimestampMsOrNull(wb.importedAt) === null) {
    return false;
  }
  return true;
}

/**
 * Evaluates I-005 / F-15 valid-import freshness:
 *  - Requires `status in ('parsed', 'mapped')`, `importRowCount >= 1`, and `>= 1` non-rejected row when tracked.
 *  - Empty (`0`-row), all-rejected, or failed/pending workbooks NEVER advance `latestValidImport`.
 *  - `isStale` is `true` whenever `ageDays === null || ageDays >= staleThresholdDays || !viewParityVerified`.
 */
export function evaluateTimelinessDimension(
  workbooks: readonly WorkbookImportRecord[],
  options: { asOf?: Date | string; staleThresholdDays?: number } = {},
): TimelinessDimensionMetrics {
  const asOfMs = toTimestampMs(options.asOf ?? new Date());
  const staleThresholdDays = options.staleThresholdDays ?? DEFAULT_VALID_IMPORT_STALE_DAYS;

  let emptyWorkbooksExcludedCount = 0;
  let failedOrPendingWorkbooksExcludedCount = 0;
  let viewParityVerified = true;
  let hasUnreadableValidCandidate = false;

  const sortedAll = [...workbooks].sort((a, b) => {
    const msA = parseTimestampMsOrNull(a.importedAt) ?? Number.NEGATIVE_INFINITY;
    const msB = parseTimestampMsOrNull(b.importedAt) ?? Number.NEGATIVE_INFINITY;
    return msB - msA;
  });
  const validList: WorkbookImportRecord[] = [];

  for (const wb of sortedAll) {
    const pureValid = isWorkbookValidImport(wb);
    if (wb.inValidWorkbookImportsView === null) {
      viewParityVerified = false;
    } else if (
      wb.inValidWorkbookImportsView !== undefined &&
      wb.inValidWorkbookImportsView !== pureValid
    ) {
      viewParityVerified = false;
    }

    const normalizedStatus = typeof wb.status === "string" ? wb.status.trim().toLowerCase() : "";
    const statusAllowed = normalizedStatus === "parsed" || normalizedStatus === "mapped";
    if (!statusAllowed) {
      failedOrPendingWorkbooksExcludedCount += 1;
      continue;
    }

    const allRowsRejected =
      wb.nonRejectedImportRowCount !== undefined &&
      wb.nonRejectedImportRowCount !== null &&
      wb.nonRejectedImportRowCount < 1;
    if (!Number.isFinite(wb.importRowCount) || wb.importRowCount < 1 || allRowsRejected) {
      emptyWorkbooksExcludedCount += 1;
      continue;
    }

    if (parseTimestampMsOrNull(wb.importedAt) === null) {
      hasUnreadableValidCandidate = true;
      viewParityVerified = false;
      continue;
    }

    if (wb.inValidWorkbookImportsView === false) {
      continue;
    }
    validList.push(wb);
  }

  const latestValid = validList[0] ?? null;
  const latestRaw = sortedAll[0] ?? null;

  let latestValidImportedAtISO: string | null = null;
  let latestValidImportAgeDays: number | null = null;
  let latestValidImport: ValidWorkbookImportSummary | null = null;

  if (latestValid && viewParityVerified && !hasUnreadableValidCandidate) {
    const importedMs = toTimestampMs(latestValid.importedAt);
    latestValidImportedAtISO = new Date(importedMs).toISOString();
    latestValidImportAgeDays = Math.max(0, Math.round((asOfMs - importedMs) / 86_400_000));
    latestValidImport = {
      id: latestValid.id,
      originalFilename: latestValid.originalFilename,
      status: latestValid.status,
      importedAtISO: latestValidImportedAtISO,
      importRowCount: latestValid.importRowCount,
      ageDays: latestValidImportAgeDays,
    };
  }

  const isStale =
    !viewParityVerified ||
    hasUnreadableValidCandidate ||
    latestValidImportAgeDays === null ||
    latestValidImportAgeDays >= staleThresholdDays;

  let freshnessStatus: ValidImportFreshnessStatus;
  if (!viewParityVerified || hasUnreadableValidCandidate) {
    freshnessStatus = "UNKNOWN";
  } else if (latestValidImport === null || latestValidImportAgeDays === null) {
    freshnessStatus = "NO_VALID_IMPORTS";
  } else if (isStale) {
    freshnessStatus = "STALE";
  } else {
    freshnessStatus = "FRESH";
  }

  return {
    totalWorkbookCount: workbooks.length,
    validWorkbookCount: viewParityVerified && !hasUnreadableValidCandidate ? validList.length : 0,
    emptyWorkbooksExcludedCount,
    failedOrPendingWorkbooksExcludedCount,
    latestValidImport,
    latestValidWorkbookId: latestValidImport?.id ?? null,
    latestValidFilename: latestValidImport?.originalFilename ?? null,
    latestValidImportedAtISO,
    latestValidImportAgeDays,
    latestRawWorkbookId: latestRaw?.id ?? null,
    latestRawWorkbookStatus: latestRaw?.status ?? null,
    staleThresholdDays,
    isStale,
    freshnessStatus,
    viewParityVerified,
    errorCode: null,
  };
}

/* ── Dimension 6: Source Traceability & Demo/Seed Lineage (I-016) ──────────────────── */

export interface PaymentTemplateLineageRow {
  id: string;
  name: string;
  sourceWorkbookId: string | null;
  sourceRowId: string | null;
  description?: string | null;
  sourceNotes?: string | null;
  archiveReason?: string | null;
}

export interface PaymentInstanceLineageRow {
  id: string;
  paymentName?: string | null;
  sourceWorkbookId: string | null;
  sourceRowId: string | null;
  templateSourceWorkbookId?: string | null;
  templateSourceRowId?: string | null;
  amountSource: string | null;
  note?: string | null;
  cancelReason?: string | null;
}

export interface CheckLineageRow {
  id: string;
  counterpartyLabel: string | null;
  sourceWorkbookId: string | null;
  sourceRowId: string | null;
  notes?: string | null;
  archiveReason?: string | null;
  cancelReason?: string | null;
}

export interface AuxiliaryDemoLineageSummary {
  externalAssumptionsDemoCount: number;
  scenariosDemoCount: number;
  actionItemsDemoCount: number;
  checkEventsDemoCount: number;
}

export interface SourceTraceabilityDimensionMetrics {
  payments: {
    totalCount: number;
    workbookTracedCount: number;
    untracedManualCount: number;
    demoOrSeedCount: number;
    demoOrSeedIds: string[];
  };
  paymentInstances: {
    totalCount: number;
    directWorkbookTracedCount: number;
    templateInheritedWorkbookTracedCount: number;
    generatedRecurringCount: number;
    nonGeneratedAmountSourceCount: number;
    untracedCount: number;
    demoOrSeedCount: number;
    demoOrSeedIds: string[];
  };
  checks: {
    totalCount: number;
    workbookTracedCount: number;
    untracedManualCount: number;
    demoOrSeedCount: number;
    demoOrSeedIds: string[];
  };
  auxiliaryDemoOrSeed: AuxiliaryDemoLineageSummary;
  /** Explicit read-only guarantee: lineage classification never mutates or deletes rows. */
  mutationsPerformed: 0;
}

export function evaluateLineageDimension(input: {
  payments: readonly PaymentTemplateLineageRow[];
  paymentInstances: readonly PaymentInstanceLineageRow[];
  checks: readonly CheckLineageRow[];
  auxiliaryDemoOrSeed?: Partial<AuxiliaryDemoLineageSummary>;
}): SourceTraceabilityDimensionMetrics {
  let payTraced = 0;
  let payUntraced = 0;
  const payDemoIds: string[] = [];

  for (const p of input.payments) {
    if (p.sourceWorkbookId != null || p.sourceRowId != null) payTraced += 1;
    else payUntraced += 1;

    if (
      hasDemoOrSeedLineage({
        name: p.name,
        notes: [p.description, p.sourceNotes, p.archiveReason],
      })
    ) {
      payDemoIds.push(p.id);
    }
  }

  let piDirectTraced = 0;
  let piTemplateInherited = 0;
  let piGenerated = 0;
  let piNonGenerated = 0;
  let piUntraced = 0;
  const piDemoIds: string[] = [];

  for (const pi of input.paymentInstances) {
    const hasDirect = pi.sourceWorkbookId != null || pi.sourceRowId != null;
    const hasInherited = pi.templateSourceWorkbookId != null || pi.templateSourceRowId != null;
    if (hasDirect) {
      piDirectTraced += 1;
    } else if (hasInherited) {
      piTemplateInherited += 1;
    } else {
      piUntraced += 1;
    }

    if ((pi.amountSource ?? "").trim().toLowerCase() === "generated") {
      piGenerated += 1;
    } else {
      piNonGenerated += 1;
    }

    if (
      hasDemoOrSeedLineage({
        name: pi.paymentName,
        notes: [pi.note, pi.cancelReason],
      })
    ) {
      piDemoIds.push(pi.id);
    }
  }

  let chkTraced = 0;
  let chkUntraced = 0;
  const chkDemoIds: string[] = [];

  for (const c of input.checks) {
    if (c.sourceWorkbookId != null || c.sourceRowId != null) chkTraced += 1;
    else chkUntraced += 1;

    if (
      hasDemoOrSeedLineage({
        name: c.counterpartyLabel,
        notes: [c.notes, c.archiveReason, c.cancelReason],
      })
    ) {
      chkDemoIds.push(c.id);
    }
  }

  return {
    payments: {
      totalCount: input.payments.length,
      workbookTracedCount: payTraced,
      untracedManualCount: payUntraced,
      demoOrSeedCount: payDemoIds.length,
      demoOrSeedIds: payDemoIds.sort(),
    },
    paymentInstances: {
      totalCount: input.paymentInstances.length,
      directWorkbookTracedCount: piDirectTraced,
      templateInheritedWorkbookTracedCount: piTemplateInherited,
      generatedRecurringCount: piGenerated,
      nonGeneratedAmountSourceCount: piNonGenerated,
      untracedCount: piUntraced,
      demoOrSeedCount: piDemoIds.length,
      demoOrSeedIds: piDemoIds.sort(),
    },
    checks: {
      totalCount: input.checks.length,
      workbookTracedCount: chkTraced,
      untracedManualCount: chkUntraced,
      demoOrSeedCount: chkDemoIds.length,
      demoOrSeedIds: chkDemoIds.sort(),
    },
    auxiliaryDemoOrSeed: {
      externalAssumptionsDemoCount: input.auxiliaryDemoOrSeed?.externalAssumptionsDemoCount ?? 0,
      scenariosDemoCount: input.auxiliaryDemoOrSeed?.scenariosDemoCount ?? 0,
      actionItemsDemoCount: input.auxiliaryDemoOrSeed?.actionItemsDemoCount ?? 0,
      checkEventsDemoCount: input.auxiliaryDemoOrSeed?.checkEventsDemoCount ?? 0,
    },
    mutationsPerformed: 0,
  };
}

/* ── Full 6-Dimension Database Evaluator (`Pool`-Accepting, Read-Only `SELECT`) ────── */

export interface EvaluateValidImportFreshnessOptions {
  asOf?: Date | string;
  staleThresholdDays?: number;
  failOnSchemaDrift?: boolean;
  failClosedOnSchemaError?: boolean;
}

export interface EvaluateRemediationDataQualityOptions {
  asOf?: Date | string;
  staleThresholdDays?: number;
  instanceMonthScope?: string | null;
  consistencyMonths?: readonly string[];
  failOnSchemaDrift?: boolean;
  failClosedOnSchemaError?: boolean;
}

export interface RemediationDataQualityReport {
  evaluatedAtISO: string;
  completeness: CompletenessDimensionMetrics;
  validity: ValidityDimensionMetrics;
  uniqueness: UniquenessDimensionMetrics;
  consistency: ConsistencyDimensionMetrics;
  timeliness: TimelinessDimensionMetrics;
  sourceTraceability: SourceTraceabilityDimensionMetrics;
  /** Explicit read-only guarantee across all 6 dimensions: zero database writes performed. */
  mutationsPerformed: 0;
}

function buildFailClosedTimelinessMetrics(
  staleThresholdDays: number,
  freshnessStatus: "SCHEMA_INCOMPATIBLE" | "UNKNOWN",
  errorCode: string,
): TimelinessDimensionMetrics {
  return {
    totalWorkbookCount: 0,
    validWorkbookCount: 0,
    emptyWorkbooksExcludedCount: 0,
    failedOrPendingWorkbooksExcludedCount: 0,
    latestValidImport: null,
    latestValidWorkbookId: null,
    latestValidFilename: null,
    latestValidImportedAtISO: null,
    latestValidImportAgeDays: null,
    latestRawWorkbookId: null,
    latestRawWorkbookStatus: null,
    staleThresholdDays,
    isStale: true,
    freshnessStatus,
    viewParityVerified: false,
    errorCode,
  };
}

/**
 * Evaluates I-005 / F-15 valid-import freshness directly against `public.valid_workbook_imports`
 * and `public.source_workbooks` + `public.import_rows` using read-only `SELECT` queries.
 * Fails closed (`isStale: true`, `freshnessStatus: 'SCHEMA_INCOMPATIBLE' | 'UNKNOWN'`) on `42P01`,
 * `42703`, or unreadable view/table responses — never silently treats a missing view as fresh.
 */
export async function evaluateValidImportFreshnessFromDb(
  pool: QueryablePool,
  options: EvaluateValidImportFreshnessOptions = {},
): Promise<TimelinessDimensionMetrics> {
  // Validate `asOf` upfront so invalid caller timestamps fail deterministically.
  if (options.asOf !== undefined) {
    toTimestampMs(options.asOf);
  }
  const staleThresholdDays = options.staleThresholdDays ?? DEFAULT_VALID_IMPORT_STALE_DAYS;
  const strictSchemaMode =
    options.failOnSchemaDrift === true || options.failClosedOnSchemaError === true;

  let res: {
    rows?: Array<{
      id: string;
      original_filename: string;
      status: string;
      imported_at: Date | string;
      import_row_count: number | string;
      non_rejected_row_count?: number | string | null;
      in_valid_view: boolean | null | undefined;
    }>;
  };

  try {
    res = await pool.query<{
      id: string;
      original_filename: string;
      status: string;
      imported_at: Date | string;
      import_row_count: number | string;
      non_rejected_row_count?: number | string | null;
      in_valid_view: boolean | null | undefined;
    }>(`
      select sw.id::text as id,
             sw.original_filename,
             sw.status,
             sw.imported_at,
             (select count(*)::int from public.import_rows ir where ir.workbook_id = sw.id) as import_row_count,
             (select count(*)::int
                from public.import_rows ir
               where ir.workbook_id = sw.id
                 and coalesce(ir.mapping_status, '') not in ('rejected', 'error')) as non_rejected_row_count,
             exists (
               select 1
                 from public.valid_workbook_imports vw
                where vw.id = sw.id
                  and vw.imported_at is not null
                  and vw.status in ('parsed', 'mapped')
             ) as in_valid_view
        from public.source_workbooks sw
       order by sw.imported_at desc, sw.id desc
    `);
  } catch (err: unknown) {
    const pgCode = extractPgErrorCode(err);
    const isSchemaError = pgCode !== null && SCHEMA_INCOMPATIBLE_SQLSTATES.has(pgCode);
    if (isSchemaError) {
      const msg = err instanceof Error ? err.message : String(err);
      if (strictSchemaMode) {
        throw new DomainError(
          "CONFLICT",
          `SCHEMA_INCOMPATIBLE: valid_workbook_imports freshness check failed (${pgCode}): ${msg}`,
        );
      }
      return buildFailClosedTimelinessMetrics(staleThresholdDays, "SCHEMA_INCOMPATIBLE", pgCode);
    }
    return buildFailClosedTimelinessMetrics(
      staleThresholdDays,
      "UNKNOWN",
      pgCode ?? "UNREADABLE_SOURCE",
    );
  }

  if (!res || !Array.isArray(res.rows)) {
    return buildFailClosedTimelinessMetrics(staleThresholdDays, "UNKNOWN", "MALFORMED_QUERY_RESULT");
  }

  const workbooks: WorkbookImportRecord[] = res.rows.map((r) => ({
    id: r.id,
    originalFilename: r.original_filename,
    status: r.status,
    importedAt: r.imported_at,
    importRowCount: intOrNull(r.import_row_count) ?? 0,
    nonRejectedImportRowCount:
      r.non_rejected_row_count !== undefined ? (intOrNull(r.non_rejected_row_count) ?? 0) : undefined,
    inValidWorkbookImportsView: typeof r.in_valid_view === "boolean" ? r.in_valid_view : null,
  }));

  return evaluateTimelinessDimension(workbooks, options);
}

/**
 * Evaluates all 6 required data-quality dimensions against PostgreSQL using strictly
 * read-only `SELECT` statements (`0` writes, `0` deletes, `0` merges).
 */
export async function evaluateRemediationDataQuality(
  pool: QueryablePool,
  options: EvaluateRemediationDataQualityOptions = {},
): Promise<RemediationDataQualityReport> {
  const evaluatedAt = options.asOf ? new Date(toTimestampMs(options.asOf)) : new Date();
  const strictSchemaMode =
    options.failOnSchemaDrift === true || options.failClosedOnSchemaError === true;

  let cashAccountsSchemaIncompatible = false;
  const cashAccountsPromise = pool
    .query<{
      id: string;
      name: string | null;
      currency: string | null;
      account_type: string | null;
      is_active: boolean | null;
      archived_at: string | null;
      opening_balance: string | null;
    }>(`
      select id::text as id,
             name,
             currency,
             account_type,
             is_active,
             archived_at::text as archived_at,
             opening_balance::text as opening_balance
        from public.cash_accounts
       order by id
    `)
    .catch((err: unknown) => {
      const pgCode = extractPgErrorCode(err);
      if (pgCode !== null && SCHEMA_INCOMPATIBLE_SQLSTATES.has(pgCode)) {
        if (strictSchemaMode) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new DomainError(
            "CONFLICT",
            `SCHEMA_INCOMPATIBLE: cash_accounts completeness check failed (${pgCode}): ${msg}`,
          );
        }
        cashAccountsSchemaIncompatible = true;
        return {
          rows: [] as Array<{
            id: string;
            name: string | null;
            currency: string | null;
            account_type: string | null;
            is_active: boolean | null;
            archived_at: string | null;
            opening_balance: string | null;
          }>,
        };
      }
      throw err;
    });

  const [
    timeliness,
    paymentsRes,
    instancesRes,
    checksRes,
    cashAccountsRes,
    stagingCountsRes,
    reviewCountsRes,
    dupChecksRes,
    dupPaymentsRes,
    joinCardRes,
    monthBucketsRes,
    auxDemoRes,
  ] = await Promise.all([
    evaluateValidImportFreshnessFromDb(pool, {
      asOf: evaluatedAt,
      staleThresholdDays: options.staleThresholdDays,
      failOnSchemaDrift: options.failOnSchemaDrift,
      failClosedOnSchemaError: options.failClosedOnSchemaError,
    }),
    pool.query<{
      id: string;
      name: string;
      status: string;
      direction: string | null;
      currency: string | null;
      default_amount: string | null;
      recurrence_type: string;
      due_day: number | null;
      provider_party_id: string | null;
      category_id: string | null;
      owner_party_id: string | null;
      archived_at: string | null;
      source_workbook_id: string | null;
      source_row_id: string | null;
      description: string | null;
      source_notes: string | null;
      archive_reason: string | null;
    }>(`
      select id::text as id,
             name,
             status,
             direction,
             currency,
             default_amount::text as default_amount,
             recurrence_type,
             due_day,
             provider_party_id::text as provider_party_id,
             category_id::text as category_id,
             owner_party_id::text as owner_party_id,
             archived_at::text as archived_at,
             source_workbook_id::text as source_workbook_id,
             source_row_id::text as source_row_id,
             description,
             source_notes,
             archive_reason
        from public.payments
       order by id
    `),
    pool.query<{
      id: string;
      payment_id: string | null;
      payment_name: string | null;
      instance_month: string;
      status: string;
      direction: string | null;
      currency: string | null;
      amount: string | null;
      amount_status: string | null;
      cancelled_at: string | null;
      amount_source: string | null;
      note: string | null;
      cancel_reason: string | null;
      source_workbook_id: string | null;
      source_row_id: string | null;
      tpl_source_workbook_id: string | null;
      tpl_source_row_id: string | null;
      provider_party_id: string | null;
      category_id: string | null;
      owner_party_id: string | null;
    }>(`
      select i.id::text as id,
             i.payment_id::text as payment_id,
             p.name as payment_name,
             to_char(i.instance_month, 'YYYY-MM-DD') as instance_month,
             i.status,
             i.direction,
             i.currency,
             i.amount::text as amount,
             i.amount_status,
             i.cancelled_at::text as cancelled_at,
             i.amount_source,
             i.note,
             i.cancel_reason,
             i.source_workbook_id::text as source_workbook_id,
             i.source_row_id::text as source_row_id,
             p.source_workbook_id::text as tpl_source_workbook_id,
             p.source_row_id::text as tpl_source_row_id,
             p.provider_party_id::text as provider_party_id,
             p.category_id::text as category_id,
             p.owner_party_id::text as owner_party_id
        from public.payment_instances i
        left join public.payments p on p.id = i.payment_id
       order by i.instance_month, i.id
    `),
    pool.query<{
      id: string;
      party_id: string | null;
      counterparty_label: string | null;
      resolved_counterparty: string | null;
      maturity_date: string | null;
      amount: string | null;
      currency: string | null;
      direction: string | null;
      status: string;
      serial_no: string | null;
      archived_at: string | null;
      source_workbook_id: string | null;
      source_row_id: string | null;
      notes: string | null;
      archive_reason: string | null;
      cancel_reason: string | null;
    }>(`
      select c.id::text as id,
             coalesce(c.payee_party_id::text, c.payer_party_id::text) as party_id,
             c.counterparty_label,
             coalesce(pe.name, pa.name, c.counterparty_label) as resolved_counterparty,
             to_char(c.maturity_date, 'YYYY-MM-DD') as maturity_date,
             c.amount::text as amount,
             c.currency,
             c.direction,
             c.status,
             c.serial_no,
             c.archived_at::text as archived_at,
             c.source_workbook_id::text as source_workbook_id,
             c.source_row_id::text as source_row_id,
             c.notes,
             c.archive_reason,
             c.cancel_reason
        from public.checks c
        left join public.parties pe on pe.id = c.payee_party_id
        left join public.parties pa on pa.id = c.payer_party_id
       order by c.maturity_date nulls last, c.id
    `),
    cashAccountsPromise,
    pool.query<{ mapping_status: string; cnt: number }>(`
      select mapping_status, count(*)::int as cnt
        from public.import_rows
       group by mapping_status
    `),
    pool.query<{ status: string; cnt: number }>(`
      select status, count(*)::int as cnt
        from public.mapping_reviews
       group by status
    `),
    pool.query<{ check_id: string; duplicate_of_check_id: string }>(`
      select check_id::text as check_id,
             duplicate_of_check_id::text as duplicate_of_check_id
        from public.control_duplicate_checks
    `),
    pool.query<{ payment_id: string; duplicate_of_payment_id: string }>(`
      select payment_id::text as payment_id,
             duplicate_of_payment_id::text as duplicate_of_payment_id
        from public.control_duplicate_payments
    `),
    pool.query<{
      raw_instance_count: number;
      joined_instance_count: number;
      distinct_instance_id_count: number;
      template_backed_instance_count: number;
      distinct_template_month_pair_count: number;
    }>(`
      select
        (select count(*)::int from public.payment_instances) as raw_instance_count,
        (select count(*)::int
           from public.payment_instances i
           left join public.payments p on p.id = i.payment_id
           left join public.categories c on c.id = p.category_id
           left join public.parties pr on pr.id = p.provider_party_id
           left join public.parties ow on ow.id = p.owner_party_id) as joined_instance_count,
        (select count(distinct id)::int from public.payment_instances) as distinct_instance_id_count,
        (select count(*)::int from public.payment_instances where payment_id is not null) as template_backed_instance_count,
        (select count(distinct (payment_id, instance_month))::int
           from public.payment_instances
          where payment_id is not null) as distinct_template_month_pair_count
    `),
    pool.query<{
      month_start: string;
      paid_cnt: number;
      partial_cnt: number;
      unpaid_cnt: number;
      planned_cnt: number;
      late_cnt: number;
      unknown_cnt: number;
      cancelled_cnt: number;
      active_missing_amt: number;
    }>(`
      select to_char(instance_month, 'YYYY-MM-DD') as month_start,
             count(*) filter (
               where status = 'paid' and cancelled_at is null and coalesce(direction, 'outflow') = 'outflow'
             )::int as paid_cnt,
             count(*) filter (
               where status = 'partial' and cancelled_at is null and coalesce(direction, 'outflow') = 'outflow'
             )::int as partial_cnt,
             count(*) filter (
               where status = 'unpaid' and cancelled_at is null and coalesce(direction, 'outflow') = 'outflow'
             )::int as unpaid_cnt,
             count(*) filter (
               where status = 'planned' and cancelled_at is null and coalesce(direction, 'outflow') = 'outflow'
             )::int as planned_cnt,
             count(*) filter (
               where status = 'late' and cancelled_at is null and coalesce(direction, 'outflow') = 'outflow'
             )::int as late_cnt,
             count(*) filter (
               where status not in ('paid','partial','unpaid','planned','late','cancelled')
                 and cancelled_at is null
                 and coalesce(direction, 'outflow') = 'outflow'
             )::int as unknown_cnt,
             count(*) filter (
               where (status = 'cancelled' or cancelled_at is not null)
                 and coalesce(direction, 'outflow') = 'outflow'
             )::int as cancelled_cnt,
             count(*) filter (
               where status <> 'cancelled'
                 and cancelled_at is null
                 and coalesce(direction, 'outflow') = 'outflow'
                 and amount is null
             )::int as active_missing_amt
        from public.payment_instances
       group by instance_month
       order by instance_month
    `),
    pool.query<{
      ea_demo: number;
      sc_demo: number;
      ai_demo: number;
      ce_demo: number;
    }>(`
      select
        (select count(*)::int
           from public.external_assumptions
          where label ilike 'Demo %'
             or coalesce(notes, '') ilike '%demo%'
             or coalesce(notes, '') ilike '%seed%') as ea_demo,
        (select count(*)::int
           from public.scenarios
          where name ilike 'Demo %'
             or coalesce(description, '') ilike '%demo%'
             or coalesce(description, '') ilike '%seed%') as sc_demo,
        (select count(*)::int
           from public.action_items
          where title ilike 'Demo%'
             or coalesce(owner, '') ilike 'Demo%'
             or coalesce(note, '') ilike '%demo%'
             or coalesce(note, '') ilike '%seed%') as ai_demo,
        (select count(*)::int
           from public.check_events
          where coalesce(event_note, '') ilike 'Demo%'
             or coalesce(event_note, '') ilike '%seed%') as ce_demo
    `),
  ]);

  const cashAccountRows: CashAccountCompletenessRow[] = cashAccountsRes.rows.map((ca) => ({
    id: ca.id,
    name: ca.name,
    currency: ca.currency,
    accountType: ca.account_type,
    isActive: ca.is_active,
    archivedAt: ca.archived_at,
    openingBalance: ca.opening_balance,
  }));

  // 1) Completeness
  const completeness = evaluateCompletenessDimension({
    templates: paymentsRes.rows.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      direction: p.direction,
      currency: p.currency,
      defaultAmount: p.default_amount,
      providerPartyId: p.provider_party_id,
      categoryId: p.category_id,
      ownerPartyId: p.owner_party_id,
      archivedAt: p.archived_at,
    })),
    instances: instancesRes.rows.map((i) => ({
      id: i.id,
      paymentId: i.payment_id,
      instanceMonth: i.instance_month,
      status: i.status,
      direction: i.direction,
      currency: i.currency,
      amount: i.amount,
      amountStatus: i.amount_status,
      cancelledAt: i.cancelled_at,
      providerPartyId: i.provider_party_id,
      categoryId: i.category_id,
      ownerPartyId: i.owner_party_id,
    })),
    instanceMonthScope: options.instanceMonthScope ?? null,
    cashAccountGrainOverride: cashAccountsSchemaIncompatible
      ? evaluateCashAccountCompleteness([], { schemaIncompatible: true })
      : evaluateCashAccountCompleteness(cashAccountRows),
  });

  // 2) Validity
  const domainRows: DomainValiditySampleRow[] = [
    ...paymentsRes.rows.map((p) => ({
      entityTable: "payments" as const,
      currency: p.currency,
      status: p.status,
    })),
    ...instancesRes.rows.map((i) => ({
      entityTable: "payment_instances" as const,
      currency: i.currency,
      status: i.status,
    })),
    ...checksRes.rows.map((c) => ({
      entityTable: "checks" as const,
      currency: c.currency,
      status: c.status,
    })),
  ];

  const validity = evaluateValidityDimension({
    stagingCounts: stagingCountsRes.rows.map((r) => ({
      mappingStatus: r.mapping_status,
      count: Number(r.cnt),
    })),
    reviewCounts: reviewCountsRes.rows.map((r) => ({
      status: r.status,
      count: Number(r.cnt),
    })),
    domainRows,
  });

  // 3) Uniqueness
  const uniqueness = evaluateUniquenessDimension({
    checks: checksRes.rows.map((c) => ({
      id: c.id,
      partyId: c.party_id,
      counterparty: c.resolved_counterparty ?? c.counterparty_label,
      maturityDate: c.maturity_date,
      amount: c.amount,
      currency: c.currency,
      direction: c.direction,
      status: c.status,
      serialNo: c.serial_no,
      archivedAt: c.archived_at,
    })),
    payments: paymentsRes.rows.map((p) => ({
      id: p.id,
      name: p.name,
      providerPartyId: p.provider_party_id,
      recurrenceType: p.recurrence_type,
      dueDay: p.due_day,
      defaultAmount: p.default_amount,
      currency: p.currency,
      status: p.status,
      archivedAt: p.archived_at,
    })),
    controlDuplicateCheckPairs: dupChecksRes.rows.map((r) => ({
      checkId: r.check_id,
      duplicateOfCheckId: r.duplicate_of_check_id,
    })),
    controlDuplicatePaymentPairs: dupPaymentsRes.rows.map((r) => ({
      paymentId: r.payment_id,
      duplicateOfPaymentId: r.duplicate_of_payment_id,
    })),
  });

  // 4) Consistency (`monthSummary` vs status bucket sums + SQL join cardinality)
  const bucketMap = new Map(monthBucketsRes.rows.map((r) => [r.month_start, r]));
  const targetMonths = options.consistencyMonths
    ? [...options.consistencyMonths]
    : monthBucketsRes.rows.map((r) => r.month_start);

  const monthSnapshots: MonthStatusBucketSnapshot[] = await Promise.all(
    targetMonths.map(async (monthStartISO) => {
      const s = await monthSummary(pool, monthStartISO);
      const b = bucketMap.get(monthStartISO);
      return {
        monthStartISO,
        summaryTotalCount: s.total_count,
        summaryMissingCount: s.missing_count,
        summaryCancelledCount: s.cancelledCount,
        summaryUnexplainedGapTry: s.unexplainedGapTry,
        paidCount: b?.paid_cnt ?? 0,
        partialCount: b?.partial_cnt ?? 0,
        unpaidCount: b?.unpaid_cnt ?? 0,
        plannedCount: b?.planned_cnt ?? 0,
        lateCount: b?.late_cnt ?? 0,
        unknownStatusCount: b?.unknown_cnt ?? 0,
        cancelledOutflowCount: b?.cancelled_cnt ?? 0,
        activeMissingAmountCount: b?.active_missing_amt ?? 0,
      };
    }),
  );

  const jcRow = joinCardRes.rows[0] ?? {
    raw_instance_count: 0,
    joined_instance_count: 0,
    distinct_instance_id_count: 0,
    template_backed_instance_count: 0,
    distinct_template_month_pair_count: 0,
  };
  const consistency = evaluateConsistencyDimension({
    monthSnapshots,
    joinCardinality: {
      rawInstanceCount: Number(jcRow.raw_instance_count),
      joinedInstanceCount: Number(jcRow.joined_instance_count),
      distinctInstanceIdCount: Number(jcRow.distinct_instance_id_count),
      templateBackedInstanceCount: Number(jcRow.template_backed_instance_count),
      distinctTemplateMonthPairCount: Number(jcRow.distinct_template_month_pair_count),
    },
  });

  // 6) Source Traceability & Demo/Seed Lineage
  const auxRow = auxDemoRes.rows[0] ?? { ea_demo: 0, sc_demo: 0, ai_demo: 0, ce_demo: 0 };
  const sourceTraceability = evaluateLineageDimension({
    payments: paymentsRes.rows.map((p) => ({
      id: p.id,
      name: p.name,
      sourceWorkbookId: p.source_workbook_id,
      sourceRowId: p.source_row_id,
      description: p.description,
      sourceNotes: p.source_notes,
      archiveReason: p.archive_reason,
    })),
    paymentInstances: instancesRes.rows.map((i) => ({
      id: i.id,
      paymentName: i.payment_name,
      sourceWorkbookId: i.source_workbook_id,
      sourceRowId: i.source_row_id,
      templateSourceWorkbookId: i.tpl_source_workbook_id,
      templateSourceRowId: i.tpl_source_row_id,
      amountSource: i.amount_source,
      note: i.note,
      cancelReason: i.cancel_reason,
    })),
    checks: checksRes.rows.map((c) => ({
      id: c.id,
      counterpartyLabel: c.resolved_counterparty ?? c.counterparty_label,
      sourceWorkbookId: c.source_workbook_id,
      sourceRowId: c.source_row_id,
      notes: c.notes,
      archiveReason: c.archive_reason,
      cancelReason: c.cancel_reason,
    })),
    auxiliaryDemoOrSeed: {
      externalAssumptionsDemoCount: Number(auxRow.ea_demo),
      scenariosDemoCount: Number(auxRow.sc_demo),
      actionItemsDemoCount: Number(auxRow.ai_demo),
      checkEventsDemoCount: Number(auxRow.ce_demo),
    },
  });

  return {
    evaluatedAtISO: evaluatedAt.toISOString(),
    completeness,
    validity,
    uniqueness,
    consistency,
    timeliness,
    sourceTraceability,
    mutationsPerformed: 0,
  };
}
