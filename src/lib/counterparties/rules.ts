// Faz 19 — counterparty domain rules. Pure & deterministic, no DB, no IO.
//
// The house rule this module exists to protect, stated once so it is not lost in the code:
// AN IMPORT NEVER CREATES A COUNTERPARTY. src/lib/financing/engine.ts's partyIdByName looks a
// name up and returns null when it does not match; the raw text is preserved in
// checks.counterparty_label and the FK stays empty. Faz 19 does not change that, and nothing
// here infers a party from a label. What this module provides is the vocabulary for a HUMAN to
// make that link deliberately — normalisation for comparison, a similarity hint for a suggest
// list, and validation for what they type.

import { normalizeTr } from "@/lib/importers/workbook-parser";

/* ── IBAN ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Whitespace-stripped, uppercased.
 *
 * Must stay byte-identical to the `iban_normalized` generated column in migration 0037
 * (`upper(regexp_replace(iban, '\s', '', 'g'))`), because the database's uniqueness index is
 * built on that expression. If these two ever disagree, the application would offer to save an
 * IBAN the index then rejects — or worse, treat two spellings of one account as two accounts.
 */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s/g, "").toUpperCase();
}

/**
 * ISO 13616 / ISO 7064 MOD-97-10 check.
 *
 * This is a checksum, not a proof of existence: it catches transposed digits and typos, which
 * is the realistic failure when someone retypes an IBAN from an invoice. It cannot tell you the
 * account is open, or that it belongs to who you think — which is why 0037 keeps an immutable
 * change history rather than trusting validation alone.
 *
 * BigInt-free: a 30+ digit number would overflow float64, so the modulus is folded chunk by
 * chunk, the standard technique.
 */
export function isValidIbanChecksum(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  if (iban.length < 5 || iban.length > 34) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    // A-Z become 10-35; digits stay digits. Anything else was excluded by the regex above.
    const piece = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of piece) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/** Turkish IBANs are exactly 26 characters and start with TR. */
export function isTurkishIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  return iban.startsWith("TR") && iban.length === 26;
}

export interface IbanCheck {
  normalized: string;
  wellFormed: boolean;
  checksumValid: boolean;
  turkish: boolean;
  /** Non-blocking observations for the operator; an invalid checksum is reported, not silently
   * corrected, in keeping with the flag-never-fix rule. */
  warnings: string[];
}

export function inspectIban(raw: string): IbanCheck {
  const normalized = normalizeIban(raw);
  const wellFormed = /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(normalized);
  const checksumValid = wellFormed && isValidIbanChecksum(normalized);
  const turkish = isTurkishIban(normalized);
  const warnings: string[] = [];
  if (!wellFormed) warnings.push("IBAN biçimi tanınmadı (ülke kodu + 2 kontrol hanesi bekleniyor).");
  else if (!checksumValid) warnings.push("IBAN kontrol hanesi tutmuyor — rakamlar yer değiştirmiş olabilir.");
  if (wellFormed && normalized.startsWith("TR") && normalized.length !== 26) {
    warnings.push(`TR IBAN 26 karakter olmalı, ${normalized.length} karakter girildi.`);
  }
  return { normalized, wellFormed, checksumValid, turkish, warnings };
}

/** Display grouping in fours, the way IBANs are printed on invoices. */
export function formatIban(raw: string): string {
  return normalizeIban(raw).replace(/(.{4})/g, "$1 ").trim();
}

/* ── counterparty matching (SUGGESTION ONLY — never an automatic link) ─────────────────── */

/**
 * How close two counterparty names are, 0..1.
 *
 * Deliberately a *suggestion* input and nothing more. It is used to offer an operator a
 * shortlist when they resolve a raw label; it must never be wired to a threshold that links
 * automatically. The importer's own matcher is exact-on-normalized-name for precisely this
 * reason, and Faz 19 does not loosen it.
 *
 * Dice coefficient over character bigrams: cheap, order-insensitive enough for "ACME LTD" vs
 * "ACME LIMITED", and it does not pretend to understand Turkish morphology.
 */
export function nameSimilarity(a: string, b: string): number {
  const left = normalizeTr(a);
  const right = normalizeTr(b);
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const lb = bigrams(left);
  const rb = bigrams(right);
  let shared = 0;
  let leftTotal = 0;
  for (const n of lb.values()) leftTotal += n;
  let rightTotal = 0;
  for (const n of rb.values()) rightTotal += n;
  for (const [g, n] of lb) {
    const other = rb.get(g);
    if (other) shared += Math.min(n, other);
  }
  return (2 * shared) / (leftTotal + rightTotal);
}

export interface MatchSuggestion {
  partyId: string;
  name: string;
  score: number;
}

/**
 * Ranked shortlist for a raw label.
 *
 * Returns an empty list rather than a bad guess when nothing clears `minScore`. The caller is
 * expected to render these as choices a person clicks, never to take `[0]` automatically —
 * `autoLinkable` is intentionally NOT part of this return type, so there is no field a future
 * caller can mistake for permission.
 */
export function suggestCounterparties(
  rawLabel: string,
  candidates: Array<{ id: string; name: string }>,
  minScore = 0.5,
  limit = 5,
): MatchSuggestion[] {
  if (!rawLabel.trim()) return [];
  return candidates
    .map((c) => ({ partyId: c.id, name: c.name, score: nameSimilarity(rawLabel, c.name) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "tr"))
    .slice(0, limit);
}

/* ── exposure banding ─────────────────────────────────────────────────────────────────── */

export type ExposureBand = "none" | "low" | "watch" | "high" | "over_limit";

export interface ExposureInput {
  totalExposure: number;
  /** null = no limit recorded, which is NOT a limit of zero. */
  creditLimit: number | null;
  /** Share of total counterparty exposure, 0..1; null when there is no total to divide by. */
  exposureRatio: number | null;
  unknownAmountCount: number;
}

export interface ExposureAssessment {
  band: ExposureBand;
  reasons: string[];
  /** True when any figure feeding the band is missing — the band is then a floor, not a fact. */
  incomplete: boolean;
}

/**
 * Band a counterparty's exposure.
 *
 * Two rules worth stating because they are easy to get wrong:
 *
 * 1. An unknown amount makes the assessment INCOMPLETE, and incompleteness never lowers a
 *    band. A counterparty with one 5 TL check and four unpriced ones is not "low".
 * 2. Concentration is judged on the same 0.40 threshold the rest of this codebase already uses
 *    for cash concentration (docs/calculation-rules.md, `concentration`/`exposureBy`), rather
 *    than inventing a second number that means almost the same thing.
 */
export function assessExposure(input: ExposureInput, concentrationThreshold = 0.4): ExposureAssessment {
  const reasons: string[] = [];
  const incomplete = input.unknownAmountCount > 0;
  if (incomplete) {
    reasons.push(`${input.unknownAmountCount} kalemin tutarı bilinmiyor — risk en az bu seviyede.`);
  }

  if (input.creditLimit != null && input.totalExposure > input.creditLimit) {
    reasons.push(`Risk ${input.totalExposure} TL, tanımlı limit ${input.creditLimit} TL'yi aşıyor.`);
    return { band: "over_limit", reasons, incomplete };
  }

  let band: ExposureBand = input.totalExposure > 0 ? "low" : "none";
  if (input.totalExposure === 0 && !incomplete) {
    return { band: "none", reasons, incomplete };
  }

  if (input.exposureRatio != null && input.exposureRatio > concentrationThreshold) {
    reasons.push(`Toplam karşı taraf riskinin %${Math.round(input.exposureRatio * 100)}'i bu tarafta.`);
    band = "high";
  } else if (input.creditLimit != null && input.creditLimit > 0 && input.totalExposure / input.creditLimit >= 0.8) {
    reasons.push("Kredi limitinin %80'i veya üzeri kullanılmış.");
    band = "watch";
  }

  // Rule 1: unknown amounts can raise a band but never lower it.
  if (incomplete && band === "none") band = "low";
  return { band, reasons, incomplete };
}
