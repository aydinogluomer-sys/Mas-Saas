// Faz 20 — bank statement domain rules. Pure & deterministic, no DB, no IO.
//
// EXPLICITLY NOT MACHINE LEARNING. Classification and match scoring are both named rules with
// fixed weights, evaluated in a stated order, and every verdict carries the name of the rule
// that produced it. That is a design constraint from CLAUDE.md ("AI is only a commentary
// layer... never infer final truth from ambiguous rows"), not a temporary shortcut: an
// operator accepting a suggested match must be able to see WHY it was suggested, and a wrong
// suggestion must be fixable by editing a rule rather than retraining something.

import { normalizeTr } from "@/lib/importers/workbook-parser";
import { decimal, isNumericString, moneyOrNull, type Decimal } from "@/lib/money";

/* ── amounts ──────────────────────────────────────────────────────────────────────────── */

/**
 * Parse a statement amount into an exact decimal string, or null.
 *
 * Bank exports are inconsistent in exactly the way that breaks naive parsing: Turkish files
 * write 1.234,56 and English ones 1,234.56, and the same institution changes format between
 * its CSV and XLSX exports. The rule used here resolves the ambiguity by looking at the LAST
 * separator, which is the decimal one in both conventions:
 *
 *   "1.234,56"  → last sep ','  → '.' is thousands → 1234.56
 *   "1,234.56"  → last sep '.'  → ',' is thousands → 1234.56
 *   "1.234"     → no decimal marker follows; '.' with 3 trailing digits is thousands → 1234
 *   "1,23"      → 2 trailing digits, single separator → decimal → 1.23
 *
 * Returns a STRING, not a number: the caller hands it to @/lib/money, and going through a JS
 * float here would undo Faz 17 at the point of entry.
 */
export function parseStatementAmount(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return String(raw);
  }
  let s = String(raw).trim();
  if (s === "") return null;

  // Trailing/leading currency noise and the TR thousands space.
  s = s.replace(/\s/g, "").replace(/(?:TL|TRY|₺|USD|\$|EUR|€)/gi, "");
  // Accounting negatives: (1.234,56) means -1234.56
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (s === "") return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized: string;
  if (lastComma === -1 && lastDot === -1) {
    normalized = s;
  } else if (lastComma > lastDot) {
    // comma is the decimal separator
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    const decimals = s.length - lastDot - 1;
    // A lone '.' with exactly three following digits and no comma anywhere is a thousands
    // separator ("1.234"), not a decimal point — the one genuinely ambiguous case, resolved
    // the way every Turkish bank export means it.
    if (lastComma === -1 && decimals === 3 && (s.match(/\./g)?.length ?? 0) >= 1) {
      normalized = s.replace(/\./g, "");
    } else {
      normalized = s.replace(/,/g, "");
    }
  } else {
    normalized = s;
  }

  if (!isNumericString(normalized)) return null;
  return (negative ? "-" : "") + normalized;
}

/**
 * Resolve a statement row's signed amount.
 *
 * Three layouts exist in the wild and all three appear in Turkish bank exports:
 *   1. one signed `amount` column
 *   2. separate `borç` (debit) and `alacak` (credit) columns
 *   3. an unsigned amount plus a direction word
 *
 * Sign convention matches checks.signed_amount: negative leaves the account.
 */
export function resolveSignedAmount(input: {
  amount?: unknown;
  debit?: unknown;
  credit?: unknown;
  directionHint?: string | null;
}): string | null {
  const debit = parseStatementAmount(input.debit);
  const credit = parseStatementAmount(input.credit);
  // Debit/credit columns win when present: they are unambiguous about direction, whereas a
  // single column's sign may or may not have survived the export.
  if (debit != null && decimal(debit).abs().gt(0)) return decimal(debit).abs().times(-1).toString();
  if (credit != null && decimal(credit).abs().gt(0)) return decimal(credit).abs().toString();

  const amount = parseStatementAmount(input.amount);
  if (amount == null) return null;
  const d = decimal(amount);
  const hint = input.directionHint ? normalizeTr(input.directionHint) : "";
  if (hint) {
    const outflow = ["borç", "borc", "çıkış", "cikis", "gider", "ödeme", "odeme", "debit", "dr"];
    const inflow = ["alacak", "giriş", "giris", "gelir", "tahsil", "credit", "cr"];
    if (outflow.some((w) => hint.includes(w))) return d.abs().times(-1).toString();
    if (inflow.some((w) => hint.includes(w))) return d.abs().toString();
  }
  return d.toString();
}

/* ── dates ────────────────────────────────────────────────────────────────────────────── */

/** Excel serial → ISO. Same 1899-12-30 base the rest of the importer uses. */
function serialToISO(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000).toISOString().slice(0, 10);
}

/**
 * Parse a statement date to ISO, or null.
 *
 * Day-first is assumed for the dotted/slashed forms because these are Turkish bank exports;
 * an ISO-looking value (yyyy-mm-dd) is taken at face value. An impossible date is rejected
 * rather than rolled over — JS Date would happily turn 31.02.2026 into 3 March, which is the
 * kind of silent correction this codebase refuses to make to financial data.
 */
export function parseStatementDate(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Excel serials for real statement dates are far above 1000 (1902+).
    return raw > 1000 ? serialToISO(raw) : null;
  }
  const s = String(raw).trim();
  if (s === "") return null;

  let y: number, m: number, d: number;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  const dmyShort = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2})$/);
  if (iso) {
    [, y, m, d] = [0, Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (dmy) {
    [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  } else if (dmyShort) {
    [d, m] = [Number(dmyShort[1]), Number(dmyShort[2])];
    y = 2000 + Number(dmyShort[3]);
  } else {
    return null;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject rather than roll over: new Date(2026,1,31) silently becomes 3 March.
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > daysInMonth) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/* ── column detection ─────────────────────────────────────────────────────────────────── */

export type StatementField =
  | "txn_date" | "value_date" | "description" | "amount" | "debit" | "credit"
  | "balance" | "counterparty" | "counterparty_iban" | "reference" | "channel" | "direction";

/**
 * Header synonyms, Turkish first. Longest match wins so "işlem tutarı" is not stolen by
 * "tutar", and `debit`/`credit` are tested before `amount` for the same reason.
 */
const HEADER_SYNONYMS: Array<[StatementField, string[]]> = [
  ["value_date", ["valör", "valor", "value date", "valör tarihi"]],
  ["txn_date", ["işlem tarihi", "islem tarihi", "tarih", "date", "transaction date"]],
  ["debit", ["borç", "borc", "debit", "çıkan", "cikan"]],
  ["credit", ["alacak", "credit", "giren"]],
  ["balance", ["bakiye", "balance", "kalan"]],
  ["amount", ["işlem tutarı", "islem tutari", "tutar", "amount", "meblağ", "meblag"]],
  ["counterparty_iban", ["karşı iban", "karsi iban", "iban", "hesap no", "counterparty iban"]],
  ["counterparty", ["karşı taraf", "karsi taraf", "alıcı", "alici", "gönderen", "gonderen", "unvan", "counterparty", "payee"]],
  ["reference", ["referans", "dekont", "reference", "fiş no", "fis no", "işlem no", "islem no"]],
  ["channel", ["kanal", "channel", "işlem tipi", "islem tipi", "tür", "tur", "type"]],
  ["direction", ["yön", "yon", "borç/alacak", "b/a", "direction"]],
  ["description", ["açıklama", "aciklama", "description", "detay", "izahat", "narrative"]],
];

/**
 * Map header cells to canonical fields.
 *
 * Unrecognised headers are simply not mapped — never guessed at by position. A statement whose
 * amount column cannot be identified must fail loudly at import rather than silently attach
 * numbers to the wrong field.
 */
export function detectStatementColumns(header: Record<string, string>): Partial<Record<StatementField, string>> {
  const out: Partial<Record<StatementField, string>> = {};
  const taken = new Set<string>();
  for (const [field, synonyms] of HEADER_SYNONYMS) {
    for (const [col, rawText] of Object.entries(header)) {
      if (taken.has(col) || out[field]) continue;
      const text = normalizeTr(String(rawText ?? ""));
      if (!text) continue;
      if (synonyms.some((syn) => text === syn || text.includes(syn))) {
        out[field] = col;
        taken.add(col);
        break;
      }
    }
  }
  return out;
}

/** A statement is usable when we can date a row and know how much moved. */
export function statementColumnsUsable(cols: Partial<Record<StatementField, string>>): boolean {
  return Boolean(cols.txn_date) && Boolean(cols.amount || cols.debit || cols.credit);
}

/* ── deduplication ────────────────────────────────────────────────────────────────────── */

/**
 * Stable fingerprint of a statement line.
 *
 * Re-importing an overlapping window is NORMAL — operators download "last 30 days" every week
 * — so the same line must collapse onto the same row instead of doubling the account's
 * turnover. Built only from fields a bank actually keeps stable across exports: date, exact
 * amount, normalized description, and the bank's own reference when it gives one.
 *
 * Deliberately NOT including the running balance: it shifts when a back-dated entry lands
 * before it, which would make an identical transaction look new.
 */
export function dedupeKey(input: {
  txnDate: string;
  amount: string;
  description?: string | null;
  reference?: string | null;
}): string {
  const desc = normalizeTr(input.description ?? "").replace(/\s+/g, " ").trim();
  const ref = normalizeTr(input.reference ?? "").trim();
  // The amount is normalized through decimal so "100" and "100.00" cannot produce two rows.
  const amount = decimal(input.amount).round(2).toFixed(2);
  return [input.txnDate, amount, ref, desc].join("|");
}

/* ── deterministic classification ─────────────────────────────────────────────────────── */

export type TxnCategory =
  | "bank_fee" | "interest_paid" | "interest_earned" | "tax" | "salary"
  | "loan_payment" | "check_settlement" | "card_payment" | "own_transfer"
  | "incoming_payment" | "outgoing_payment" | "unknown";

export interface ClassificationRule {
  name: string;
  category: TxnCategory;
  /** All keywords are matched against the TR-normalized description + counterparty. */
  keywords: string[];
  /** When set, the rule only fires for that direction. */
  direction?: "inflow" | "outflow";
}

/**
 * Ordered rule table. FIRST MATCH WINS, so the specific rules precede the generic ones —
 * "kredi kartı" must be tested before "kredi", or every card payment becomes a loan payment.
 * Order here IS the specification; do not sort this array.
 */
export const CLASSIFICATION_RULES: ClassificationRule[] = [
  { name: "eft_havale_fee", category: "bank_fee", keywords: ["eft ücret", "havale ücret", "işlem ücret", "masraf", "komisyon", "hesap işletim"], direction: "outflow" },
  { name: "bsmv_kkdf", category: "tax", keywords: ["bsmv", "kkdf", "damga vergisi", "stopaj"] },
  { name: "tax_payment", category: "tax", keywords: ["vergi", "sgk", "gib", "muhtasar", "kdv"], direction: "outflow" },
  { name: "card_payment", category: "card_payment", keywords: ["kredi kartı", "kredi karti", "kart borç", "kart borc", "pos"] },
  { name: "loan_installment", category: "loan_payment", keywords: ["kredi taksit", "kredi ödeme", "kredi odeme", "taksit tahsil", "kredi geri"], direction: "outflow" },
  { name: "check_settlement", category: "check_settlement", keywords: ["çek", "cek tahsil", "çek ödeme"] },
  { name: "salary", category: "salary", keywords: ["maaş", "maas", "bordro", "personel ödeme"], direction: "outflow" },
  { name: "interest_earned", category: "interest_earned", keywords: ["faiz", "vadeli hesap"], direction: "inflow" },
  { name: "interest_paid", category: "interest_paid", keywords: ["faiz"], direction: "outflow" },
  { name: "own_transfer", category: "own_transfer", keywords: ["virman", "kendi hesab", "hesaplar arası", "hesaplar arasi"] },
  { name: "incoming_transfer", category: "incoming_payment", keywords: ["havale", "eft", "gelen", "tahsilat"], direction: "inflow" },
  { name: "outgoing_transfer", category: "outgoing_payment", keywords: ["havale", "eft", "giden", "ödeme", "odeme"], direction: "outflow" },
];

export interface Classification {
  category: TxnCategory;
  /** Name of the rule that fired, or null when nothing matched. Always explainable. */
  rule: string | null;
}

/**
 * Classify one statement line.
 *
 * Returns `unknown` with a null rule when nothing matches — never a best guess. An unknown
 * category is a visible prompt for a human; a wrong confident one is a lie.
 */
export function classifyTransaction(input: {
  description: string | null;
  counterparty?: string | null;
  amount: string;
}): Classification {
  const haystack = normalizeTr([input.description ?? "", input.counterparty ?? ""].join(" "));
  if (!haystack.trim()) return { category: "unknown", rule: null };
  const direction = decimal(input.amount).lt(0) ? "outflow" : "inflow";

  for (const rule of CLASSIFICATION_RULES) {
    if (rule.direction && rule.direction !== direction) continue;
    if (rule.keywords.some((k) => haystack.includes(normalizeTr(k)))) {
      return { category: rule.category, rule: rule.name };
    }
  }
  return { category: "unknown", rule: null };
}

/* ── match scoring ────────────────────────────────────────────────────────────────────── */

export interface MatchTarget {
  // Faz 22 added "invoices" here in step with migration 0049, which widened the matching
  // CHECK on both bank_transactions and bank_transaction_match_candidates.
  table: "payment_instances" | "checks" | "loan_installments" | "invoices";
  id: string;
  /** Expected amount, unsigned. null = unknown, which is NOT zero. */
  amount: number | null;
  dueDate: string | null;
  label: string | null;
}

export interface MatchScore {
  confidence: number;
  reasons: string[];
}

/**
 * Weights are named constants so a tuning change is a visible, reviewable diff.
 *
 * They are also CONSTRAINED by the two-signal rule below, and that constraint is not
 * decorative: the first version of this table used amountExact = 0.6, which on its own cleared
 * SUGGESTION_THRESHOLD (0.5) and would have put single-signal amount coincidences straight in
 * front of an operator — the precise failure the doc comment claimed to prevent. The unit test
 * caught it. Any future edit must keep every individual weight BELOW the threshold, and
 * `rules.test.ts` asserts exactly that for the amount and date signals.
 */
export const MATCH_WEIGHTS = {
  amountExact: 0.45,
  amountWithinOneLira: 0.35,
  dateSameDay: 0.25,
  dateWithin3Days: 0.18,
  dateWithin7Days: 0.1,
  labelStrong: 0.15,
  labelWeak: 0.07,
} as const;

/** Suggestions below this are not worth an operator's attention. */
export const SUGGESTION_THRESHOLD = 0.5;

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
}

/**
 * Score a statement line against one candidate record.
 *
 * An amount match alone can reach 0.60 and a date match alone 0.25 — deliberately, neither
 * clears SUGGESTION_THRESHOLD by itself. Two independent signals are required before anything
 * is put in front of a person, because a lone amount match on a round number like 10.000 TL is
 * exactly the coincidence that produces a confidently wrong reconciliation.
 *
 * A candidate with an UNKNOWN amount scores no amount points at all — it does not get partial
 * credit for being unfalsifiable (CLAUDE.md: null is unknown, not zero).
 */
export function scoreMatch(
  txn: { amount: number; txnDate: string; description: string | null; counterparty: string | null },
  target: MatchTarget,
): MatchScore {
  const reasons: string[] = [];
  let confidence = 0;

  const txnAbs = Math.abs(txn.amount);
  if (target.amount != null) {
    const diff = Math.abs(txnAbs - Math.abs(target.amount));
    if (diff === 0) {
      confidence += MATCH_WEIGHTS.amountExact;
      reasons.push("amount_exact");
    } else if (diff <= 1) {
      // ±1 TL absorbs the rounding differences that appear between a planned instalment and
      // what the bank actually moved; the same 1 TL tolerance reconcileLoan already uses.
      confidence += MATCH_WEIGHTS.amountWithinOneLira;
      reasons.push("amount_within_1_try");
    }
  } else {
    reasons.push("target_amount_unknown");
  }

  if (target.dueDate) {
    const d = daysBetween(txn.txnDate, target.dueDate);
    if (d === 0) {
      confidence += MATCH_WEIGHTS.dateSameDay;
      reasons.push("date_same_day");
    } else if (d <= 3) {
      confidence += MATCH_WEIGHTS.dateWithin3Days;
      reasons.push("date_within_3d");
    } else if (d <= 7) {
      confidence += MATCH_WEIGHTS.dateWithin7Days;
      reasons.push("date_within_7d");
    }
  }

  if (target.label) {
    const hay = normalizeTr([txn.description ?? "", txn.counterparty ?? ""].join(" "));
    const needle = normalizeTr(target.label);
    if (needle.length >= 4 && hay.includes(needle)) {
      confidence += MATCH_WEIGHTS.labelStrong;
      reasons.push("label_contained");
    } else {
      const token = needle.split(/\s+/).find((t) => t.length >= 4);
      if (token && hay.includes(token)) {
        confidence += MATCH_WEIGHTS.labelWeak;
        reasons.push("label_token");
      }
    }
  }

  // Clamp: weights could otherwise sum past 1 and a "confidence" above 100% is nonsense.
  confidence = Math.min(1, Math.round(confidence * 10000) / 10000);
  return { confidence, reasons };
}

/** Candidates worth showing, best first. */
export function rankCandidates(
  txn: { amount: number; txnDate: string; description: string | null; counterparty: string | null },
  targets: MatchTarget[],
  threshold = SUGGESTION_THRESHOLD,
): Array<MatchTarget & MatchScore> {
  return targets
    .map((t) => ({ ...t, ...scoreMatch(txn, t) }))
    .filter((t) => t.confidence >= threshold)
    .sort((a, b) => b.confidence - a.confidence || (a.label ?? "").localeCompare(b.label ?? "", "tr"));
}

/** Convenience for callers that hand amounts straight from a numeric column. */
export function toAmountNumber(value: unknown): number | null {
  return moneyOrNull(value as string | number | null);
}

export type { Decimal };
