// Reminder domain rules (Phase 6B). Pure & deterministic — sources:
// .claude/skills/mas-reminder-engine + docs/calculation-rules.md. Eligibility is
// computed here; duplicate prevention is enforced at the DB (unique delivery key).
// Reminders never mutate financial records. null amount stays "tutar eksik", not 0.

import { addDaysISO } from "@/lib/financing/rules";

/* ── shapes (plain data → unit-testable without a DB) ── */

export interface ReminderRule {
  id: string;
  name: string;
  targetKind: "payment_instance" | "check" | "loan_installment" | "invoice" | "promise_to_pay";
  offsetDays: number; // 7,3,1,0 before due; -1 = overdue check
  channel: "telegram" | "email";
  minAmount: number | null;
  isActive: boolean;
}

export interface ReminderTarget {
  entityTable: string; // 'payment_instances'
  entityId: string;
  name: string;
  dueDate: string; // ISO
  amount: number | null;
  status: string;
  owner: string | null;
  provider: string | null;
  riskReasons: string[];
}

/**
 * Which statuses still deserve a reminder, PER TARGET KIND — Faz 25.
 *
 * This was a single set (`unpaid`/`partial`) written when every target was a payment. Those two
 * words do not exist in the invoice or promise vocabularies: an open invoice is 'open', an
 * outstanding promise is 'pending'. Keeping the single set and adding the new kinds would have
 * made every invoice and every promise permanently ineligible — a reminder engine that silently
 * reminds about nothing, which is the failure mode hardest to notice because nothing errors.
 *
 * A 'draft' invoice is deliberately absent: chasing a customer for a document that has not been
 * issued would be chasing them for nothing.
 */
const OPEN_BY_KIND: Record<ReminderRule["targetKind"], ReadonlySet<string>> = {
  payment_instance: new Set(["unpaid", "partial"]),
  check: new Set(["unpaid", "partial"]),
  loan_installment: new Set(["unpaid", "partial"]),
  invoice: new Set(["open", "partial"]),
  promise_to_pay: new Set(["pending"]),
};

/** Date a reminder should fire = due_date shifted back by offset (offset 7 → 7 days before). */
export function scheduledForDate(dueDateISO: string, offsetDays: number): string {
  return addDaysISO(dueDateISO, -offsetDays);
}

/**
 * min_amount threshold. null amount is UNKNOWN, never treated as 0 or excluded:
 * an unknown amount could be large, so it always passes (operator must still be
 * reminded to check). Only a KNOWN amount below the threshold is filtered out.
 */
export function thresholdPasses(minAmount: number | null, amount: number | null): boolean {
  if (minAmount == null) return true;
  if (amount == null) return true; // unknown ⇒ cannot exclude
  return amount >= minAmount;
}

/** True when this rule fires for this target on todayISO (Europe/Istanbul date). */
export function isEligible(rule: ReminderRule, target: ReminderTarget, todayISO: string): boolean {
  if (!rule.isActive) return false;
  const kind = targetKindOf(target.entityTable);
  // An unrecognised table matches NOTHING. Before Faz 25 this function fell through to
  // 'loan_installment' for anything it did not recognise, which was harmless while three kinds
  // existed and would have silently filed every invoice and every promise under loans the moment
  // a fourth appeared. Unknown now means unknown.
  if (kind === null) return false;
  if (rule.targetKind !== kind) return false;
  if (!(OPEN_BY_KIND[kind] ?? new Set<string>()).has(target.status)) return false;
  if (scheduledForDate(target.dueDate, rule.offsetDays) !== todayISO) return false;
  return thresholdPasses(rule.minAmount, target.amount);
}

/** Explicit table -> kind map. Returns null for anything not listed; never guesses. */
const KIND_BY_TABLE: Record<string, ReminderRule["targetKind"]> = {
  payment_instances: "payment_instance",
  checks: "check",
  loan_installments: "loan_installment",
  invoices: "invoice",
  promise_to_pay: "promise_to_pay",
};

export function targetKindOf(entityTable: string): ReminderRule["targetKind"] | null {
  return KIND_BY_TABLE[entityTable] ?? null;
}

export interface EligibleDelivery {
  ruleId: string;
  ruleName: string;
  entityTable: string;
  entityId: string;
  scheduledFor: string;
  message: string;
}

/** All (rule × target) pairs eligible today. Dedupe happens at insert time (DB unique). */
export function eligibleDeliveries(
  rules: ReminderRule[],
  targets: ReminderTarget[],
  todayISO: string,
): EligibleDelivery[] {
  const out: EligibleDelivery[] = [];
  for (const rule of rules) {
    for (const target of targets) {
      if (!isEligible(rule, target, todayISO)) continue;
      out.push({
        ruleId: rule.id,
        ruleName: rule.name,
        entityTable: target.entityTable,
        entityId: target.entityId,
        scheduledFor: todayISO,
        message: buildReminderMessage(rule, target),
      });
    }
  }
  return out;
}

/* ── message (skill: name, due date, owner, provider, amount|tutar eksik, status, risk) ── */

const fmtTL = (n: number | null): string =>
  n == null ? "tutar eksik" : new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";

const OFFSET_HEAD: Record<number, string> = {
  7: "🗓 7 gün sonra ödeme — hazırlık",
  3: "💰 3 gün sonra — nakit hazır mı?",
  1: "⏰ Yarın ödeme",
  0: "🔔 Bugün ödeme",
  [-1]: "⚠ Gecikmiş ödeme kontrolü",
};

export function buildReminderMessage(rule: ReminderRule, target: ReminderTarget): string {
  const head = OFFSET_HEAD[rule.offsetDays] ?? rule.name;
  const parts = [
    `${head}`,
    `${target.name} · ${target.dueDate}`,
    `tutar: ${fmtTL(target.amount)}`,
    `durum: ${target.status}`,
  ];
  if (target.owner) parts.push(`sahip: ${target.owner}`);
  if (target.provider) parts.push(`sağlayıcı: ${target.provider}`);
  if (target.riskReasons.length) parts.push(`risk: ${target.riskReasons.join(", ")}`);
  return parts.join("\n");
}

export { fmtTL as reminderFmtTL };
