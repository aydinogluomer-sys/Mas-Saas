// Reminder domain rules (Phase 6B + Faz 25 + M-59 + Phase D Agent 05). Pure & deterministic —
// zero process.env, zero fetch, zero DB. Reminders never mutate financial records.
// null amount stays "tutar eksik", never 0.

import {
  computeObligationAmounts,
  type CanonicalEscalationStage,
  type EscalationDecisionContract,
} from "@/lib/contracts/remediation-contracts";
import { addDaysISO } from "@/lib/financing/rules";

export type ReminderTargetKind =
  | "payment_instance"
  | "check"
  | "loan_installment"
  | "invoice"
  | "promise_to_pay"
  | "covenant_record";

export interface ReminderRule {
  id: string;
  name: string;
  targetKind: ReminderTargetKind;
  offsetDays: number; // +N days before due; 0 on due date; -N days overdue (-1, -8, -31)
  channel: "telegram" | "email";
  minAmount: number | null;
  isActive: boolean;
}

export interface ReminderTarget {
  entityTable: string;
  entityId: string;
  name: string;
  dueDate: string; // ISO YYYY-MM-DD
  amount: number | null;
  originalAmount?: number | null;
  paidAmount?: number | null;
  paid_amount?: number | null;
  allocatedPaidAmount?: number | null;
  outstandingAmount?: number | null;
  rescheduledFromDate?: string | null;
  status: string;
  owner: string | null;
  provider: string | null;
  riskReasons: string[];
}

export type EscalationBucketKey =
  | "upcoming"
  | "overdue_1_7"
  | "overdue_8_30"
  | "overdue_30_plus";

export const ESCALATION_BUCKET_LABELS: Record<EscalationBucketKey, string> = {
  upcoming: "Vadesi Yaklaşan",
  overdue_1_7: "1-7 Gün Gecikmiş",
  overdue_8_30: "8-30 Gün İhtar",
  overdue_30_plus: "31+ Gün Üst Eskalasyon (İç İnceleme)",
};

/**
 * Pure calendar validation for `YYYY-MM-DD` strings.
 * Rejects empty strings, malformed tokens, and non-existent calendar dates
 * such as `"2026-13-45"` or non-leap `"2026-02-29"` that `Date.UTC` would roll over.
 */
export function isValidISODate(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(utc.getTime())) return false;
  const normalized =
    `${String(utc.getUTCFullYear()).padStart(4, "0")}-` +
    `${String(utc.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(utc.getUTCDate()).padStart(2, "0")}`;
  return normalized === value;
}

export function daysOverdue(dueDateISO: string, todayISO: string): number {
  if (!isValidISODate(dueDateISO) || !isValidISODate(todayISO)) return 0;
  const diffMs = Date.parse(`${todayISO}T00:00:00Z`) - Date.parse(`${dueDateISO}T00:00:00Z`);
  const days = Math.round(diffMs / 86_400_000);
  return days === 0 ? 0 : days;
}

export function classifyEscalationBucket(
  dueDateISO: string,
  todayISO: string,
): EscalationBucketKey {
  const lateDays = daysOverdue(dueDateISO, todayISO);
  if (lateDays <= 0) return "upcoming";
  if (lateDays <= 7) return "overdue_1_7";
  if (lateDays <= 30) return "overdue_8_30";
  return "overdue_30_plus";
}

export function stageForOverdueDays(overdueDays: number): CanonicalEscalationStage {
  if (overdueDays <= 0) return "NOT_DUE";
  if (overdueDays <= 7) return "OVERDUE_1_7";
  if (overdueDays <= 30) return "OVERDUE_8_30";
  return "OVERDUE_31_PLUS";
}

export function bucketToCanonicalStage(bucket: EscalationBucketKey): CanonicalEscalationStage {
  switch (bucket) {
    case "upcoming":
      return "NOT_DUE";
    case "overdue_1_7":
      return "OVERDUE_1_7";
    case "overdue_8_30":
      return "OVERDUE_8_30";
    case "overdue_30_plus":
      return "OVERDUE_31_PLUS";
  }
}

const OPEN_BY_KIND: Record<ReminderTargetKind, ReadonlySet<string>> = {
  payment_instance: new Set(["planned", "unpaid", "partial", "late"]),
  check: new Set([
    "unpaid",
    "partial",
    "planned",
    "in_portfolio",
    "in_bank_collection",
    "in_bank_collateral",
    "issued_to_vendor",
  ]),
  loan_installment: new Set(["planned", "unpaid", "partial", "late"]),
  invoice: new Set(["open", "partial"]),
  promise_to_pay: new Set(["pending"]),
  covenant_record: new Set(["compliant", "warning", "breach", "breached", "pending"]),
};

const CLOSED_STATUSES: ReadonlySet<string> = new Set([
  "paid",
  "cancelled",
  "cleared",
  "collected",
  "kept",
  "draft",
]);

const DEFAULT_HISTORICAL_OVERDUE_DAYS = 90;

export interface EvaluateEscalationDecisionInput {
  obligationId: string;
  entityTable: string;
  dueDateISO: string;
  /** Business date in `Europe/Istanbul` (`YYYY-MM-DD`). */
  asOfDateISO: string;
  /** Optional status (`unpaid`, `partial`, `late`, `paid`, `cancelled`, ...). */
  status?: string;
  /** Optional rule `offsetDays` (`+N`, `0`, `-1`, `-8`, `-31`) to check exact rule eligibility. */
  offsetDays?: number;
  /** Optional explicit prior stage if known from persistence/outbox. */
  previousStage?: CanonicalEscalationStage | null;
  /** Optional prior evaluation business date (`YYYY-MM-DD`) when `previousStage` is omitted. */
  previousAsOfDateISO?: string | null;
  /** Optional stage already notified to suppress duplicate steady-stage notifications when desired. */
  lastNotifiedStage?: CanonicalEscalationStage | null;
  /** Optional prior due date (`YYYY-MM-DD`) before an approved reschedule/deferment. */
  rescheduledFromDateISO?: string | null;
  /** Overdue days beyond which the obligation is flagged as a historical backlog item (default: 90). */
  historicalThresholdDays?: number;
}

/**
 * Authoritative Contract B evaluator (`EscalationDecisionContract`).
 * Guarantees mutually exclusive stage assignment (`NOT_DUE`, `OVERDUE_1_7`, `OVERDUE_8_30`, `OVERDUE_31_PLUS`)
 * at `asOfDateISO`, preserves `rescheduled` transition semantics, and fails closed (`eligible: false`) on invalid dates.
 */
export function evaluateEscalationDecision(
  input: EvaluateEscalationDecisionInput,
): EscalationDecisionContract {
  const {
    obligationId,
    entityTable,
    dueDateISO,
    asOfDateISO,
    status,
    offsetDays,
    previousStage: explicitPreviousStage,
    previousAsOfDateISO,
    lastNotifiedStage,
    rescheduledFromDateISO,
    historicalThresholdDays = DEFAULT_HISTORICAL_OVERDUE_DAYS,
  } = input;

  if (!isValidISODate(dueDateISO) || !isValidISODate(asOfDateISO)) {
    return {
      obligationId,
      entityTable,
      asOfDateISO,
      overdueDays: 0,
      currentStage: "NOT_DUE",
      previousStage: explicitPreviousStage ?? null,
      transitionReason: "not_yet_due",
      eligibleForCurrentNotification: false,
      isHistoricalEvent: false,
    };
  }

  const overdueDays = daysOverdue(dueDateISO, asOfDateISO);
  const currentStage = stageForOverdueDays(overdueDays);
  const isRescheduled =
    isValidISODate(rescheduledFromDateISO) && rescheduledFromDateISO !== dueDateISO;

  let previousStage: CanonicalEscalationStage | null;
  if (explicitPreviousStage !== undefined) {
    previousStage = explicitPreviousStage;
  } else if (isRescheduled) {
    const refAsOf =
      previousAsOfDateISO && isValidISODate(previousAsOfDateISO)
        ? previousAsOfDateISO
        : asOfDateISO;
    previousStage = stageForOverdueDays(daysOverdue(rescheduledFromDateISO, refAsOf));
  } else if (previousAsOfDateISO && isValidISODate(previousAsOfDateISO)) {
    previousStage = stageForOverdueDays(daysOverdue(dueDateISO, previousAsOfDateISO));
  } else if (overdueDays <= 0) {
    previousStage = null;
  } else {
    previousStage = stageForOverdueDays(overdueDays - 1);
  }

  let transitionReason: EscalationDecisionContract["transitionReason"];
  if (isRescheduled) {
    transitionReason = "rescheduled";
  } else if (currentStage === "NOT_DUE") {
    transitionReason = "not_yet_due";
  } else if (previousStage === currentStage) {
    transitionReason = "steady_in_stage";
  } else if (currentStage === "OVERDUE_1_7") {
    transitionReason = "entered_overdue_1_7";
  } else if (currentStage === "OVERDUE_8_30") {
    transitionReason = "escalated_to_8_30";
  } else {
    transitionReason = "escalated_to_31_plus";
  }

  let statusOpen = true;
  if (status !== undefined) {
    const normalizedStatus = status.trim().toLowerCase();
    const kind = targetKindOf(entityTable);
    if (kind !== null) {
      statusOpen = (OPEN_BY_KIND[kind] ?? new Set<string>()).has(normalizedStatus);
    } else {
      statusOpen = !CLOSED_STATUSES.has(normalizedStatus);
    }
  }

  const alreadyNotifiedSameStage =
    !isRescheduled && lastNotifiedStage != null && lastNotifiedStage === currentStage;

  let eligibleForCurrentNotification = false;
  if (statusOpen && !alreadyNotifiedSameStage) {
    if (offsetDays !== undefined) {
      eligibleForCurrentNotification = matchesReminderOffset(offsetDays, dueDateISO, asOfDateISO);
    } else {
      eligibleForCurrentNotification = overdueDays >= 0;
    }
  }

  const isHistoricalEvent = overdueDays > historicalThresholdDays;

  return {
    obligationId,
    entityTable,
    asOfDateISO,
    overdueDays,
    currentStage,
    previousStage,
    transitionReason,
    eligibleForCurrentNotification,
    isHistoricalEvent,
  };
}

export interface ResolvedReminderAmounts {
  originalAmount: number | null;
  paidAmount: number | null;
  outstandingAmount: number | null;
  hasPartialBreakdown: boolean;
}

/**
 * Pure helper resolving `originalAmount`, `paidAmount`, and `outstandingAmount` via Contract A
 * (`computeObligationAmounts`). Preserves `null` (`BLANK != ZERO`) and prevents overstating
 * partially paid obligations at their full original face value.
 */
export function resolveReminderAmounts(target: {
  amount: number | null;
  originalAmount?: number | null;
  paidAmount?: number | null;
  paid_amount?: number | null;
  allocatedPaidAmount?: number | null;
  outstandingAmount?: number | null;
  status: string;
}): ResolvedReminderAmounts {
  const rawPaid =
    target.paidAmount ?? target.allocatedPaidAmount ?? target.paid_amount ?? null;
  const paid = rawPaid != null && Number.isFinite(rawPaid) ? rawPaid : null;

  const rawOrig = target.originalAmount !== undefined ? target.originalAmount : target.amount;
  const orig = rawOrig != null && Number.isFinite(rawOrig) ? rawOrig : null;

  const normalizedStatus = target.status.trim().toLowerCase();

  if (orig == null) {
    const explicitRem =
      target.outstandingAmount != null && Number.isFinite(target.outstandingAmount)
        ? target.outstandingAmount
        : null;
    return {
      originalAmount: null,
      paidAmount: paid,
      outstandingAmount: explicitRem,
      hasPartialBreakdown: false,
    };
  }

  const computed = computeObligationAmounts({
    originalAmount: orig,
    paidAmount: paid,
    status: normalizedStatus,
  });

  const rem =
    target.outstandingAmount != null && Number.isFinite(target.outstandingAmount)
      ? target.outstandingAmount
      : paid != null && (normalizedStatus === "partial" || paid > 0)
        ? computed.outstandingAmount
        : orig;

  const hasPartialBreakdown =
    rem != null &&
    ((normalizedStatus === "partial" && (paid != null || orig !== rem)) ||
      (paid != null && paid > 0 && orig !== rem));

  const effectivePaid = hasPartialBreakdown
    ? (paid ?? Math.max(0, Math.round((orig - rem) * 100) / 100))
    : paid;

  return {
    originalAmount: orig,
    paidAmount: effectivePaid,
    outstandingAmount: rem,
    hasPartialBreakdown,
  };
}

const STATUS_LABELS_TR: Readonly<Record<string, string>> = {
  unpaid: "Ödenmedi",
  planned: "Planlandı",
  partial: "Kısmi ödendi",
  late: "Gecikmiş",
  open: "Açık",
  pending: "Bekliyor",
  in_portfolio: "Portföyde",
  issued_to_vendor: "Tedarikçiye verildi",
  endorsed_to_vendor: "Ciro edildi",
  in_bank_collection: "Banka tahsilde",
  in_bank_collateral: "Banka teminatta",
  paid: "Ödendi",
  cancelled: "İptal edildi",
  cleared: "Tahsil edildi",
  collected: "Tahsil edildi",
  bounced: "Karşılıksız",
  returned: "İade edildi",
  compliant: "Uyumlu",
  warning: "Uyarı",
  breach: "Kovenant ihlali",
  breached: "Kovenant ihlali",
  not_tested: "Test edilmedi",
  broken: "Söz tutulmadı",
  kept: "Tutuldu",
  draft: "Taslak",
  unknown: "Bilinmiyor",
};

const RISK_REASON_LABELS_TR: Readonly<Record<string, string>> = {
  missing_amount: "Tutar eksik",
  overdue: "Vadesi geçmiş",
  critical_payment: "Kritik ödeme",
  large_payment: "Yüksek tutarlı ödeme",
  same_day_cluster: "Aynı gün yığılması",
  negative_amount: "Negatif tutar",
  overpaid: "Fazla ödeme",
  kovenant_ihlali: "Kovenant ihlali",
  short_month_adjustment: "Kısa ay uyarlaması",
  variable_amount: "Değişken tutar",
  fx_unconverted: "Kur çevrimi bekliyor",
};

export function formatStatusLabelTr(status: string): string {
  const key = status.trim().toLowerCase();
  const mapped = STATUS_LABELS_TR[key];
  if (mapped) return mapped;
  return status.replace(/_/g, " ").trim();
}

export function formatRiskReasonTr(reason: string): string {
  const trimmed = reason.trim();
  const mapped = RISK_REASON_LABELS_TR[trimmed.toLowerCase()];
  if (mapped) return mapped;
  return trimmed.replace(/_/g, " ");
}

/** Date a reminder should fire = due_date shifted back by offset (offset 7 -> 7 days before; -8 -> 8 days after due). */
export function scheduledForDate(dueDateISO: string, offsetDays: number): string {
  if (!isValidISODate(dueDateISO) || !Number.isFinite(offsetDays)) return "";
  return addDaysISO(dueDateISO, -offsetDays);
}

/**
 * min_amount threshold. null amount is UNKNOWN, never treated as 0 or excluded.
 */
export function thresholdPasses(minAmount: number | null, amount: number | null): boolean {
  if (minAmount == null) return true;
  if (amount == null) return true;
  return amount >= minAmount;
}

/**
 * Disjoint date matching for upcoming (`offsetDays >= 0`) and overdue (`offsetDays < 0`) tiers:
 *  - `offsetDays >= 0`: exact match `scheduledForDate(dueDateISO, offsetDays) === todayISO`
 *  - `offsetDays === -1`: `1 <= lateDays <= 7`
 *  - `offsetDays === -8`: `8 <= lateDays <= 30`
 *  - `offsetDays === -31`: `lateDays >= 31`
 *  - Other negative `-N`: exact `lateDays === N` so custom rules never overlap `-1 / -8 / -31`
 */
export function matchesReminderOffset(
  offsetDays: number,
  dueDateISO: string,
  todayISO: string,
): boolean {
  if (!isValidISODate(dueDateISO) || !isValidISODate(todayISO) || !Number.isFinite(offsetDays)) {
    return false;
  }
  if (offsetDays >= 0) {
    return scheduledForDate(dueDateISO, offsetDays) === todayISO;
  }
  const lateDays = daysOverdue(dueDateISO, todayISO);
  if (lateDays <= 0) return false;
  if (offsetDays === -1) return lateDays >= 1 && lateDays <= 7;
  if (offsetDays === -8) return lateDays >= 8 && lateDays <= 30;
  if (offsetDays === -31) return lateDays >= 31;
  return lateDays === -offsetDays;
}

/**
 * True when this rule fires for this target on todayISO (Europe/Istanbul date).
 * Overdue rules (`-1`, `-8`, `-31`) evaluate into mutually exclusive disjoint buckets,
 * and partial obligations are tested against their remaining unpaid exposure.
 */
export function isEligible(rule: ReminderRule, target: ReminderTarget, todayISO: string): boolean {
  if (!rule.isActive) return false;
  if (!isValidISODate(target.dueDate) || !isValidISODate(todayISO)) return false;
  const kind = targetKindOf(target.entityTable);
  if (kind === null) return false;
  if (rule.targetKind !== kind) return false;
  if (!(OPEN_BY_KIND[kind] ?? new Set<string>()).has(target.status.trim().toLowerCase())) {
    return false;
  }
  if (!matchesReminderOffset(rule.offsetDays, target.dueDate, todayISO)) return false;
  const resolved = resolveReminderAmounts(target);
  return thresholdPasses(rule.minAmount, resolved.outstandingAmount);
}

const KIND_BY_TABLE: Record<string, ReminderTargetKind> = {
  payment_instances: "payment_instance",
  checks: "check",
  loan_installments: "loan_installment",
  invoices: "invoice",
  promise_to_pay: "promise_to_pay",
  covenant_records: "covenant_record",
};

export function targetKindOf(entityTable: string): ReminderTargetKind | null {
  return KIND_BY_TABLE[entityTable] ?? null;
}

export interface EligibleDelivery {
  ruleId: string;
  ruleName: string;
  entityTable: string;
  entityId: string;
  scheduledFor: string;
  message: string;
  escalationBucket: EscalationBucketKey;
}

/** All (rule × target) pairs eligible on todayISO. Dedupe happens at insert time (DB unique). */
export function eligibleDeliveries(
  rules: ReminderRule[],
  targets: ReminderTarget[],
  todayISO: string,
): EligibleDelivery[] {
  const out: EligibleDelivery[] = [];
  for (const rule of rules) {
    for (const target of targets) {
      if (!isEligible(rule, target, todayISO)) continue;
      const fireDate =
        rule.offsetDays >= 0 ? todayISO : scheduledForDate(target.dueDate, rule.offsetDays);
      out.push({
        ruleId: rule.id,
        ruleName: rule.name,
        entityTable: target.entityTable,
        entityId: target.entityId,
        scheduledFor: fireDate,
        message: buildReminderMessage(rule, target, todayISO),
        escalationBucket: classifyEscalationBucket(target.dueDate, todayISO),
      });
    }
  }
  return out;
}

const fmtTL = (n: number | null): string =>
  n == null ? "tutar eksik" : new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";

function formatReminderAmountDisplay(resolved: ResolvedReminderAmounts): string {
  if (
    resolved.hasPartialBreakdown &&
    resolved.outstandingAmount != null &&
    resolved.originalAmount != null
  ) {
    return `kalan ${fmtTL(resolved.outstandingAmount)} (asıl: ${fmtTL(resolved.originalAmount)} · ödenen: ${fmtTL(resolved.paidAmount ?? 0)})`;
  }
  return fmtTL(resolved.outstandingAmount);
}

const OFFSET_HEAD: Record<number, string> = {
  14: "📋 14 gün sonra kovenant / vade testi",
  7: "🗓 7 gün sonra ödeme — hazırlık",
  3: "💰 3 gün sonra — nakit hazır mı?",
  1: "⏰ Yarın ödeme",
  0: "🔔 Bugün ödeme",
  [-1]: "⚠ 1-7 Gün Gecikmiş ödeme kontrolü",
  [-8]: "🚨 8-30 Gün İhtar kademesi",
  [-31]: "⚖ 31+ Gün Üst Eskalasyon (İç İnceleme) kademesi",
};

const ESCALATION_BUCKET_HEADERS: Record<Exclude<EscalationBucketKey, "upcoming">, string> = {
  overdue_1_7: "⚠ 1-7 Gün Gecikmiş ödeme kontrolü",
  overdue_8_30: "🚨 8-30 Gün İhtar kademesi",
  overdue_30_plus: "⚖ 31+ Gün Üst Eskalasyon (İç İnceleme) kademesi",
};

function maskSensitiveLabel(raw: string, idHint?: string): string {
  const scrubbedIban = raw.replace(
    /\bTR\d{2}[\s-]?(?:[0-9A-Z]{4}[\s-]?){5}([0-9A-Z]{2})\b/gi,
    (_m, tail: string) => `TR** **** **** **** **** **${tail.toUpperCase()}`,
  );
  const bracketMatch = scrubbedIban.match(/^(\[[^\]]+\]\s*)(.+)$/);
  const prefix = bracketMatch ? bracketMatch[1] : "";
  const rest = (bracketMatch ? bracketMatch[2] : scrubbedIban).trim();
  if (!rest) return prefix.trim() || "(maskeli kalem)";
  const words = rest.split(/\s+/).filter(Boolean);
  const maskedWords = words.slice(0, 3).map((w) => {
    const clean = w.replace(/[()]/g, "");
    if (clean.length <= 1) return "*";
    return `${clean[0]}***`;
  });
  const suffix = idHint ? ` (#${idHint.slice(0, 6)})` : "";
  return `${prefix}${maskedWords.join(" ")}${suffix}`;
}

function escapeDigestHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;",
  );
}

export interface BuildReminderMessageOptions {
  masked?: boolean;
}

export function buildReminderMessage(
  rule: ReminderRule,
  target: ReminderTarget,
  todayISO?: string,
  opts: BuildReminderMessageOptions = {},
): string {
  const masked = Boolean(opts.masked);
  const validDates = isValidISODate(todayISO) && isValidISODate(target.dueDate);
  let head: string;
  let bucket: EscalationBucketKey | null = null;

  if (validDates && target.dueDate < todayISO) {
    bucket = classifyEscalationBucket(target.dueDate, todayISO);
    head =
      bucket === "upcoming"
        ? (OFFSET_HEAD[rule.offsetDays] ?? rule.name)
        : ESCALATION_BUCKET_HEADERS[bucket];
  } else if (validDates && rule.offsetDays < 0) {
    const daysUntil = -daysOverdue(target.dueDate, todayISO);
    head = OFFSET_HEAD[daysUntil] ?? "📋 Vadesi Yaklaşan ödeme";
  } else {
    head = OFFSET_HEAD[rule.offsetDays] ?? rule.name;
  }

  const displayName = masked
    ? maskSensitiveLabel(target.name, target.entityId)
    : target.name.replace(
        /\bTR\d{2}[\s-]?(?:[0-9A-Z]{4}[\s-]?){5}([0-9A-Z]{2})\b/gi,
        (_m, tail: string) => `TR** **** **** **** **** **${tail.toUpperCase()}`,
      );

  const resolvedAmounts = resolveReminderAmounts(target);

  const parts = [
    `${head}`,
    `${displayName} · ${target.dueDate}`,
    `tutar: ${formatReminderAmountDisplay(resolvedAmounts)}`,
    `durum: ${formatStatusLabelTr(target.status)}`,
  ];

  if (validDates && target.dueDate < todayISO && bucket && bucket !== "upcoming") {
    parts.push(`kademe: ${ESCALATION_BUCKET_LABELS[bucket]} (${daysOverdue(target.dueDate, todayISO)} gün)`);
  }
  if (
    target.rescheduledFromDate &&
    isValidISODate(target.rescheduledFromDate) &&
    target.rescheduledFromDate !== target.dueDate
  ) {
    parts.push(`ertelenen vade: ${target.rescheduledFromDate} → ${target.dueDate}`);
  }
  if (target.owner) {
    parts.push(`sahip: ${masked ? maskSensitiveLabel(target.owner) : target.owner}`);
  }
  if (target.provider) {
    parts.push(`sağlayıcı: ${masked ? maskSensitiveLabel(target.provider) : target.provider}`);
  }
  if (target.riskReasons.length > 0) {
    const translatedReasons = target.riskReasons.map(formatRiskReasonTr);
    parts.push(`risk: ${translatedReasons.join(", ")}`);
  }
  return parts.join("\n");
}

export interface ReminderDigestItem {
  entityTable?: string;
  entityId?: string;
  name: string;
  dueDate: string;
  amount: number | null;
  originalAmount?: number | null;
  paidAmount?: number | null;
  paid_amount?: number | null;
  allocatedPaidAmount?: number | null;
  outstandingAmount?: number | null;
  rescheduledFromDate?: string | null;
  status: string;
  owner?: string | null;
  provider?: string | null;
  riskReasons?: readonly string[];
}

export interface BuildReminderDigestOptions {
  masked?: boolean;
  maxItemsPerTier?: number;
}

/**
 * Consolidates multiple simultaneous due/overdue reminders into a single structured HTML digest
 * (`<= 1` consolidated message per dispatch batch), preventing 98-message outbound bursts.
 * Null amounts remain explicit (`tutar eksik`), never coerced to 0; partial items sum remaining exposure.
 */
export function buildReminderDigestHtml(
  items: readonly ReminderDigestItem[],
  todayISO: string,
  opts: BuildReminderDigestOptions = {},
): string {
  if (items.length === 0) {
    return `<b>MAS Nakit Radar — Günlük Hatırlatma Özeti (${escapeDigestHtml(todayISO)})</b>\nBekleyen hatırlatma yok.`;
  }

  const masked = Boolean(opts.masked);
  const maxPerTier = Math.max(1, opts.maxItemsPerTier ?? 8);

  const tierOrder: EscalationBucketKey[] = [
    "overdue_30_plus",
    "overdue_8_30",
    "overdue_1_7",
    "upcoming",
  ];
  const tierIcons: Record<EscalationBucketKey, string> = {
    overdue_30_plus: "⚖",
    overdue_8_30: "🚨",
    overdue_1_7: "⚠",
    upcoming: "🔔",
  };

  const byTier = new Map<EscalationBucketKey, ReminderDigestItem[]>(
    tierOrder.map((k) => [k, []]),
  );

  let totalKnownTry = 0;
  let totalMissingCount = 0;

  for (const item of items) {
    const b = classifyEscalationBucket(item.dueDate, todayISO);
    byTier.get(b)!.push(item);
    const resolved = resolveReminderAmounts(item);
    if (resolved.outstandingAmount == null) {
      totalMissingCount += 1;
    } else if (Number.isFinite(resolved.outstandingAmount)) {
      totalKnownTry = Math.round((totalKnownTry + resolved.outstandingAmount) * 100) / 100;
    }
  }

  const lines: string[] = [
    `<b>MAS Nakit Radar — Toplu Hatırlatma Özeti (${escapeDigestHtml(todayISO)})</b>`,
    `Toplam: <b>${items.length}</b> kalem · bilinen tutar: <b>${escapeDigestHtml(fmtTL(totalKnownTry))}</b>${
      totalMissingCount > 0 ? ` · tutar eksik: <b>${totalMissingCount}</b> kalem` : ""
    }`,
  ];

  for (const tier of tierOrder) {
    const group = byTier.get(tier)!;
    if (group.length === 0) continue;

    const sorted = [...group].sort((a, b) => {
      const lateDiff = daysOverdue(b.dueDate, todayISO) - daysOverdue(a.dueDate, todayISO);
      if (lateDiff !== 0) return lateDiff;
      const remB = resolveReminderAmounts(b).outstandingAmount ?? 0;
      const remA = resolveReminderAmounts(a).outstandingAmount ?? 0;
      return remB - remA;
    });

    let groupKnown = 0;
    let groupMissing = 0;
    for (const g of sorted) {
      const resolved = resolveReminderAmounts(g);
      if (resolved.outstandingAmount == null) {
        groupMissing += 1;
      } else if (Number.isFinite(resolved.outstandingAmount)) {
        groupKnown = Math.round((groupKnown + resolved.outstandingAmount) * 100) / 100;
      }
    }

    lines.push("");
    lines.push(
      `<b>${tierIcons[tier]} ${escapeDigestHtml(ESCALATION_BUCKET_LABELS[tier])} (${sorted.length} kalem · ${escapeDigestHtml(fmtTL(groupKnown))}${
        groupMissing > 0 ? ` + ${groupMissing} tutar eksik` : ""
      })</b>`,
    );

    for (const row of sorted.slice(0, maxPerTier)) {
      const rawLabel = masked ? maskSensitiveLabel(row.name, row.entityId) : row.name;
      const safeLabel = escapeDigestHtml(
        rawLabel.replace(
          /\bTR\d{2}[\s-]?(?:[0-9A-Z]{4}[\s-]?){5}([0-9A-Z]{2})\b/gi,
          (_m, tail: string) => `TR** **** **** **** **** **${tail.toUpperCase()}`,
        ),
      );
      const lateDays = daysOverdue(row.dueDate, todayISO);
      const ageTag = lateDays > 0 ? ` (${lateDays}g gecikmiş)` : "";
      const rowResolved = resolveReminderAmounts(row);
      lines.push(
        `• ${safeLabel} · <code>${escapeDigestHtml(row.dueDate)}</code>${escapeDigestHtml(ageTag)} — tutar: ${escapeDigestHtml(formatReminderAmountDisplay(rowResolved))} · durum: ${escapeDigestHtml(formatStatusLabelTr(row.status))}`,
      );
    }

    if (sorted.length > maxPerTier) {
      lines.push(`<i>… ve ${sorted.length - maxPerTier} kalem daha</i>`);
    }
  }

  return lines.join("\n");
}

export { fmtTL as reminderFmtTL };
