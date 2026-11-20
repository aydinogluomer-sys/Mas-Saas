/**
 * MAS Nexus — Cross-Agent Remediation & Production Hardening Contracts (Section 4, 6 & 7).
 *
 * Pure TypeScript domain contracts shared across Agents 00–11.
 * BOUNDARY INVARIANT: Zero `process.env`, zero `fetch`, zero database side effects.
 */

// ── Section 6: Standardized External Failure Classification ──────────────────

export type ExternalOperationOutcomeKind =
  | "success"
  | "business_rule_failure"
  | "temporary_infra_failure"
  | "permanent_config_failure"
  | "permission_failure"
  | "timeout"
  | "rate_limited"
  | "unknown_outcome";

export interface ClassifiedExternalOutcome {
  ok: boolean;
  outcomeKind: ExternalOperationOutcomeKind;
  retryable: boolean;
  /** True when the outbound side effect may have succeeded before acknowledgment was lost. */
  uncertainOutcome: boolean;
  retryAfterSeconds?: number | null;
  redactedError?: string | null;
}

// ── Section 7: Conceptual Telegram Operations Categories ─────────────────────

export type TelegramConceptualCategory =
  | "CRITICAL_SYSTEM_INCIDENT"
  | "FINANCIAL_RISK_CHANGE"
  | "PAYMENT_DUE_SOON"
  | "PAYMENT_OVERDUE"
  | "INCIDENT_RESOLVED_VERIFIED"
  | "DAILY_CFO_SUMMARY"
  | "MONTHLY_FINANCIAL_REPORT"
  | "CONFIGURED_REMINDER";

// ── Contract A: Financial Obligation ─────────────────────────────────────────

export type ObligationStatus =
  | "planned"
  | "unpaid"
  | "partial"
  | "late"
  | "paid"
  | "cancelled"
  | "unknown";

export type ObligationReconciliationStatus =
  | "unreconciled"
  | "matched"
  | "reconciled"
  | "disputed"
  | "unknown";

export interface FinancialObligationContract {
  obligationId: string;
  entityTable: "payment_instances" | "loan_installments" | "checks" | "invoices";
  legalEntityId: string | null;
  name: string;
  /** Original contractual/scheduled obligation amount (`null` = missing/unknown, NEVER coerced to 0). */
  originalAmount: number | null;
  currency: string | null;
  /** Verified cumulative paid/allocated amount (`0` when unpaid; `null` when unknown). */
  allocatedPaidAmount: number | null;
  /** Remaining unpaid exposure (`null` when `originalAmount === null`). */
  outstandingAmount: number | null;
  /** Non-zero when `allocatedPaidAmount > originalAmount` or explicit settlement adjustment exists. */
  overpaymentOrAdjustmentAmount: number;
  dueDateISO: string;
  status: ObligationStatus | string;
  reconciliationStatus: ObligationReconciliationStatus | string;
  provenanceSource: string | null;
  updatedAtISO: string | null;
}

/**
 * Pure helper computing `originalAmount`, `allocatedPaidAmount`, and `outstandingAmount`
 * without ever converting `null` (unknown) into `0` (`BLANK != ZERO`).
 */
export function computeObligationAmounts(input: {
  originalAmount: number | null;
  paidAmount?: number | null;
  status: string;
}): {
  originalAmount: number | null;
  allocatedPaidAmount: number | null;
  outstandingAmount: number | null;
  overpaymentAmount: number;
} {
  const { originalAmount, paidAmount, status } = input;
  if (originalAmount == null || !Number.isFinite(originalAmount)) {
    return {
      originalAmount: null,
      allocatedPaidAmount: paidAmount != null && Number.isFinite(paidAmount) ? paidAmount : null,
      outstandingAmount: null,
      overpaymentAmount: 0,
    };
  }
  const normalizedStatus = status.trim().toLowerCase();
  if (normalizedStatus === "cancelled") {
    return {
      originalAmount,
      allocatedPaidAmount: paidAmount != null && Number.isFinite(paidAmount) ? paidAmount : 0,
      outstandingAmount: 0,
      overpaymentAmount: 0,
    };
  }
  if (normalizedStatus === "paid" || normalizedStatus === "cleared" || normalizedStatus === "collected") {
    const settled = paidAmount != null && Number.isFinite(paidAmount) ? paidAmount : originalAmount;
    const overpaid = Math.max(0, Math.round((settled - originalAmount) * 100) / 100);
    return {
      originalAmount,
      allocatedPaidAmount: settled,
      outstandingAmount: 0,
      overpaymentAmount: overpaid,
    };
  }
  const paid = paidAmount != null && Number.isFinite(paidAmount) ? Math.max(0, paidAmount) : 0;
  const remaining = Math.max(0, Math.round((originalAmount - paid) * 100) / 100);
  const overpaid = Math.max(0, Math.round((paid - originalAmount) * 100) / 100);
  return {
    originalAmount,
    allocatedPaidAmount: paid,
    outstandingAmount: remaining,
    overpaymentAmount: overpaid,
  };
}

// ── Contract B: Escalation Decision ──────────────────────────────────────────

export type CanonicalEscalationStage =
  | "NOT_DUE"
  | "OVERDUE_1_7"
  | "OVERDUE_8_30"
  | "OVERDUE_31_PLUS";

export interface EscalationDecisionContract {
  obligationId: string;
  entityTable: string;
  /** Business date in `Europe/Istanbul` (`YYYY-MM-DD`). */
  asOfDateISO: string;
  /** Signed or positive calendar-day difference (`asOfDateISO - dueDateISO`). */
  overdueDays: number;
  currentStage: CanonicalEscalationStage;
  previousStage: CanonicalEscalationStage | null;
  transitionReason:
    | "not_yet_due"
    | "entered_overdue_1_7"
    | "escalated_to_8_30"
    | "escalated_to_31_plus"
    | "steady_in_stage"
    | "rescheduled";
  eligibleForCurrentNotification: boolean;
  isHistoricalEvent: boolean;
}

// ── Contract C: Notification Event ───────────────────────────────────────────

export type NotificationDeliveryState =
  | "pending"
  | "claiming"
  | "sent"
  | "failed_retryable"
  | "delivery_uncertain"
  | "dead_letter"
  | "skipped";

export interface NotificationEventContract {
  idempotencyKey: string;
  legalEntityId: string | null;
  recipientTarget: string;
  entityTable: string;
  entityId: string;
  ruleId: string;
  escalationStage: string;
  stateVersion: string;
  cadenceSlot: string;
  conceptualCategory: TelegramConceptualCategory;
  deliveryStatus: NotificationDeliveryState;
  deliveryAttempts: number;
  deduplicated: boolean;
  providerMessageIds: readonly string[];
  correlationId?: string | null;
}

// ── Contract D: Telemetry Observation & Incident Lifecycle ───────────────────

export type IncidentLifecycleState =
  | "OK"
  | "OPEN"
  | "ACKNOWLEDGED"
  | "RESOLVED"
  | "UNKNOWN"
  | "SUPPRESSED";

export type IncidentSeverityLevel = "P0" | "P1" | "P2";

export interface IncidentResolutionEvidence {
  whatChanged: string;
  verifiedByCheck: string;
  verifiedAtISO: string;
  measuredValue: string;
  evidenceSource: string;
}

export interface TelemetryObservationContract {
  signalKey: string;
  measuredAtISO: string;
  measurementSucceeded: boolean;
  value: string;
  threshold: string;
  severity: IncidentSeverityLevel;
  incidentState: IncidentLifecycleState;
  lastCheckedAtISO: string;
  lastSuccessAtISO: string | null;
  resolutionEvidence: IncidentResolutionEvidence | null;
  correlationId: string | null;
}

// ── Contract E: Financial Report Snapshot ────────────────────────────────────

export type MonetaryEpistemicBasis =
  | "ACTUAL"
  | "PLANNED"
  | "FORECAST"
  | "RECONCILED"
  | "UNKNOWN";

export type ReportConfidenceGrade =
  | "VERIFIED_COMPLETE"
  | "PARTIAL_MISSING_INPUTS"
  | "STALE_SOURCE_WARNING"
  | "UNVERIFIED_CASH_BASIS";

export interface FinancialReportSnapshotContract {
  snapshotId: string;
  businessDateISO: string;
  snapshotCreatedAtISO: string;
  schemaVersion: string;
  calculationVersion: string;
  sourceFreshnessDays: number | null;
  monetaryBasisByMetric: Readonly<Record<string, MonetaryEpistemicBasis>>;
  missingMaterialInputs: readonly string[];
  reconciliationAligned: boolean;
  controlAlertsOpenCount: number;
  confidenceGrade: ReportConfidenceGrade;
  contentSha256: string;
}

// ── V2 Hardening Contracts: Source Completeness, Durable Send Phase & Release Verdict ──

export type SourceCompletenessStatus =
  | "COMPLETE"
  | "NO_ACTIVE_ACCOUNTS_VERIFIED"
  | "PARTIAL_MISSING_OPENING"
  | "LEGACY_UNVERIFIED"
  | "SCHEMA_INCOMPATIBLE"
  | "SOURCE_UNAVAILABLE";

/**
 * Durable pre-send phase stored in `notification_outbox.metadata.dispatchPhase`
 * and `reminder_deliveries.payload.dispatchPhase` to separate pre-network `claimed`
 * from post-intent `sending` (`F-08`, `F-09`).
 */
export type OutboxDurableDispatchPhase =
  | "prepared"
  | "claimed"
  | "sending"
  | "sent"
  | "failed_retryable"
  | "delivery_uncertain"
  | "dead_letter"
  | "skipped";

export type ReleaseGateCanonicalStatus =
  | "PASS"
  | "FAIL"
  | "BLOCKED"
  | "UNKNOWN"
  | "NOT_VERIFIED"
  | "NOT_APPLICABLE";

export type GlobalReleaseConditionId =
  | "G-01"
  | "G-02"
  | "G-03"
  | "G-04"
  | "G-05"
  | "G-06"
  | "G-07";

export interface ReleaseGateManifestEntry {
  id: string;
  title: string;
  status: ReleaseGateCanonicalStatus;
  evidence: string;
  scope: "ci_and_host" | "host_physical_only" | "operational_steward";
}

export interface ReleaseVerdictManifest {
  schemaVersion: "mas-release-verdict-v2";
  generatedAtISO: string;
  baseAuditCommitSha: string;
  parentHeadCommitSha: string;
  verifiedCommitSha: string;
  branch: string;
  githubCiRunId: number | null;
  githubCiRunUrl: string | null;
  githubCiJobsPassed: number;
  githubCiJobsTotal: number;
  ci8of8SameShaPass: boolean;
  liveDbMutations: number;
  realExternalSends: number;
  releaseGates: readonly ReleaseGateManifestEntry[];
  globalConditions: Readonly<Record<GlobalReleaseConditionId, {
    title: string;
    status: ReleaseGateCanonicalStatus;
    evidence: string;
  }>>;
  openBlockers: readonly string[];
  verdict: "GO" | "NO-GO";
  verdictReason: string;
}

/**
 * Computes `GO` vs `NO-GO` strictly from the worst open gate (`F-19`):
 * Any `FAIL`, `BLOCKED`, `UNKNOWN`, `NOT_VERIFIED`, non-8/8 GitHub CI on the same SHA,
 * or non-zero live DB mutation forces `NO-GO`.
 */
export function computeUnifiedReleaseVerdict(input: {
  ci8of8SameShaPass: boolean;
  liveDbMutations: number;
  realExternalSends: number;
  releaseGates: readonly { id: string; status: ReleaseGateCanonicalStatus }[];
  globalConditions: Readonly<Record<GlobalReleaseConditionId, { status: ReleaseGateCanonicalStatus }>>;
}): { verdict: "GO" | "NO-GO"; blockingIds: string[] } {
  const blockingIds: string[] = [];
  if (!input.ci8of8SameShaPass) {
    blockingIds.push("CI_NOT_8_OF_8_SAME_SHA");
  }
  if (input.liveDbMutations !== 0) {
    blockingIds.push("LIVE_DB_MUTATION_NON_ZERO");
  }
  if (input.realExternalSends !== 0) {
    blockingIds.push("REAL_EXTERNAL_SENDS_NON_ZERO");
  }
  for (const g of input.releaseGates) {
    if (g.status !== "PASS" && g.status !== "NOT_APPLICABLE") {
      blockingIds.push(`${g.id}:${g.status}`);
    }
  }
  for (const [id, cond] of Object.entries(input.globalConditions)) {
    if (cond.status !== "PASS" && cond.status !== "NOT_APPLICABLE") {
      blockingIds.push(`${id}:${cond.status}`);
    }
  }
  return {
    verdict: blockingIds.length === 0 ? "GO" : "NO-GO",
    blockingIds,
  };
}

