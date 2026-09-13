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
  /**
   * PHASE 2.2 (T1-e). `approval_rules.currency` (0054, `not null default 'TRY'`) — eşiğin para
   * birimi. Kolon şemada baştan beri vardı ama SELECT bile edilmiyordu; 100.000 TRY eşiği
   * 60.000 USD'lik bir kalemle karşılaştırılıp "tetiklenmedi" diyebiliyordu.
   */
  currency: string;
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
  /**
   * Tutarın para birimi. `undefined`/`null` = BİLİNMİYOR, TRY varsayılmaz (CLAUDE.md / plan §2.1).
   * Kural para birimiyle eşleşmiyorsa ya da bilinmiyorsa eşik DEĞERLENDİRİLEMEZ — bkz.
   * `thresholdVerdict`: bu durumda kural TETİKLENİR (onay kapısı kapalı kalır), atlanmaz.
   */
  currency?: string | null;
}

/**
 * Eşik kuralının bir girdi karşısındaki hükmü — `ruleFires`'ın açıklanabilir hâli.
 *
 *   met / not_met         para birimleri eşleşti, ondalık karşılaştırma yapıldı
 *   amount_unknown        tutar null: eşik aşılamaz, kural tetiklenmez (veri kalitesi sorunu)
 *   currency_mismatch     tutar var ama para birimi kuralınkinden farklı: karşılaştırma YAPILAMAZ
 *   currency_unknown      tutar var, para birimi verilmemiş: TRY varsayılmaz, karşılaştırma YAPILAMAZ
 *   not_amount_rule       kural tutar kuralı değil
 *
 * NEDEN mismatch/unknown TETİKLER (fail-closed). Bu bir risk rozeti değil, maker-checker kapısıdır.
 * Radar tarafında TRY-dışı kalem ayrı işaretlenir (`unsupported_currency`), çünkü orada yanlış
 * yön "sahte alarm"dır. Burada yanlış yön "kontrolsüz ödeme"dir: para birimi alanını değiştirerek
 * bir eşiğin etrafından dolaşılamamalı. Değerlendirilemeyen eşik = ikinci göz gerekli.
 */
export type ThresholdVerdict =
  | "met" | "not_met" | "amount_unknown" | "currency_mismatch" | "currency_unknown" | "not_amount_rule";

export function thresholdVerdict(rule: ApprovalRuleConfig, input: RuleInput): ThresholdVerdict {
  if (rule.triggerKind !== "amount_threshold" || rule.thresholdAmount == null) return "not_amount_rule";
  if (input.amount == null || input.amount === "") return "amount_unknown";
  if (input.currency == null || input.currency === "") return "currency_unknown";
  if (input.currency !== rule.currency) return "currency_mismatch";
  return decimal(input.amount).abs().gte(decimal(rule.thresholdAmount)) ? "met" : "not_met";
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
    switch (thresholdVerdict(rule, input)) {
      case "met": return true;
      case "not_met": return false;
      case "amount_unknown": return false;
      // PHASE 2.2 (T1-e): değerlendirilemeyen eşik kapıyı AÇMAZ.
      case "currency_mismatch": return true;
      case "currency_unknown": return true;
      case "not_amount_rule": return false;
    }
  }
  return rule.triggerKind === input.triggerKind;
}

/** Every rule that fires, in a stable order so the same input always reads the same way. */
export function firingRules(rules: ApprovalRuleConfig[], input: RuleInput): ApprovalRuleConfig[] {
  return rules.filter((r) => ruleFires(r, input)).sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * A sentence naming why a checker is required — the rule codes, never a summary.
 *
 * `input` verilirse, para birimi yüzünden tetiklenen eşik kuralları AÇIKÇA söylenir: onaylayıcı
 * "100.000 TL ve üzeri" diye okuyup 60.000 USD'yi eşik altı sanmamalı.
 */
export function explain(fired: ApprovalRuleConfig[], input?: RuleInput): string {
  if (fired.length === 0) return "Onay kuralı tetiklenmedi.";
  return fired.map((r) => {
    const base = `${r.code}: ${r.description}`;
    if (!input) return base;
    const v = thresholdVerdict(r, input);
    if (v === "currency_mismatch") {
      return `${base} (eşik ${r.currency}, kayıt ${input.currency} — karşılaştırılamadı, onay gerekli)`;
    }
    if (v === "currency_unknown") {
      return `${base} (eşik ${r.currency}, kaydın para birimi bilinmiyor — karşılaştırılamadı, onay gerekli)`;
    }
    return base;
  }).join(" · ");
}

/** The request_kind an approval should carry, given what fired. */
export function requestKindFor(fired: ApprovalRuleConfig[]): string {
  if (fired.length === 0) return "other";
  const first = fired[0];
  return first.triggerKind === "amount_threshold" ? "amount_threshold" : first.triggerKind;
}
