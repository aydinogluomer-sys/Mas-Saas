// Faz 24A — when a second pair of eyes is required.
//
// Pure and deterministic on purpose. An approval requirement that cannot be explained to the
// person it blocks is a requirement they will route around, so there is no scoring and no
// inference here: a rule either fires or it does not, and `explain()` names the reason.
//
// Kept separate from engine.ts so this is testable without a database — the engine's job is to
// read the configured rules and apply these functions to them.

import { decimal, type NumericInput } from "@/lib/money";

export interface ApprovalRuleConfig {
  code: string;
  description: string;
  triggerKind: "amount_threshold" | "new_iban" | "new_counterparty" | "invoice" | "payment";
  thresholdAmount: number | null;
  appliesTo: string[];
  isActive: boolean;
}

export interface RuleInput {
  /** Which table the subject lives in. */
  subjectTable: string;
  /** The event being evaluated, when it is not an amount question. */
  triggerKind?: string;
  /**
   * The amount under consideration. NULL MEANS UNKNOWN, NOT ZERO (CLAUDE.md). An unknown amount
   * cannot clear a threshold, so an amount rule does not fire on it — the missing value is a data
   * quality problem, and silently treating it as 0 would hide the payment from the threshold.
   *
   * Typed as NumericInput, not number, so a numeric column can arrive as the STRING pg returns it
   * and be compared exactly. Narrowing this to `number` would force a float conversion at the one
   * boundary this whole comparison exists to protect.
   */
  amount?: NumericInput;
}

/** Does this rule watch this subject table? An empty scope means "all of them". */
export function inScope(rule: ApprovalRuleConfig, subjectTable: string): boolean {
  return rule.appliesTo.length === 0 || rule.appliesTo.includes(subjectTable);
}

/**
 * Whether one configured rule demands a checker for this input.
 *
 * The amount comparison goes through decimal, not float: a 100.000,00 TL payment must fire a
 * 100.000 threshold, and `>=` on binary floats is exactly where that stops being reliable.
 * The absolute value is compared because a refund and a payment of the same size carry the same
 * consequence — signed outflows are normal in this schema (CLAUDE.md).
 */
export function ruleFires(rule: ApprovalRuleConfig, input: RuleInput): boolean {
  if (!rule.isActive) return false;
  if (!inScope(rule, input.subjectTable)) return false;

  if (rule.triggerKind === "amount_threshold") {
    if (rule.thresholdAmount == null) return false;
    if (input.amount == null || input.amount === "") return false;
    return decimal(input.amount).abs().gte(decimal(rule.thresholdAmount));
  }
  return rule.triggerKind === input.triggerKind;
}

/** Every rule that fires, in a stable order so the same input always reads the same way. */
export function firingRules(rules: ApprovalRuleConfig[], input: RuleInput): ApprovalRuleConfig[] {
  return rules.filter((r) => ruleFires(r, input)).sort((a, b) => a.code.localeCompare(b.code));
}

/** A sentence naming why a checker is required — the rule codes, never a summary. */
export function explain(fired: ApprovalRuleConfig[]): string {
  if (fired.length === 0) return "Onay kuralı tetiklenmedi.";
  return fired.map((r) => `${r.code}: ${r.description}`).join(" · ");
}

/** The request_kind an approval should carry, given what fired. */
export function requestKindFor(fired: ApprovalRuleConfig[]): string {
  if (fired.length === 0) return "other";
  const first = fired[0];
  return first.triggerKind === "amount_threshold" ? "amount_threshold" : first.triggerKind;
}
