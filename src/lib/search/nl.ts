// Faz 35 — natural-language search: intent extraction only, never SQL.
//
// ═══ THE BOUNDARY, WHICH IS THE SAME ONE ai/engine.ts ALREADY DRAWS ═══
//
// A language model may contribute exactly one thing: a STRUCTURED INTENT — which entities to look
// in, a date window, an amount floor, and the literal text to match. That object is validated by
// Zod against enums built from the registry, then handed to a query builder that emits
// parameterised SQL from literals it already had.
//
// The model never sees a table name it could echo back, never produces a fragment that reaches a
// query, and cannot widen its own scope: an entity key that is not in the registry fails Zod
// validation, and the search runs on the deterministic parse instead.
//
// This is not a new architecture. ai/engine.ts already computes a deterministic answer FIRST and
// only then lets a model rephrase it, refusing outright on mutation intent. The same shape is
// reused here: parse deterministically first, treat the model as an optional refinement, and keep
// `mutationIntent()` as the hard gate.
//
// Pure: no database, no network, no LLM call in this file. It defines the contract and the
// deterministic parser; the (optional) model call lives in the engine behind this schema.

import { z } from "zod";
import { SEARCH_ENTITY_KEYS, type SearchEntityKey } from "./registry";

/** What a model is allowed to return. Anything else is rejected, not sanitised. */
export const searchIntentSchema = z.object({
  /** Which registry entries to search. Enum — an unknown key cannot survive parsing. */
  entities: z.array(z.enum(SEARCH_ENTITY_KEYS as [SearchEntityKey, ...SearchEntityKey[]]))
    .max(SEARCH_ENTITY_KEYS.length).default([]),
  /** Literal text to match. Bound as a parameter; never concatenated. */
  text: z.string().trim().max(200).default(""),
  /** Inclusive ISO day bounds. */
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  /** Minimum absolute amount. */
  amountMin: z.number().finite().nonnegative().nullable().default(null),
});
export type SearchIntent = z.infer<typeof searchIntentSchema>;

const norm = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/ı/g, "i").replace(/İ/g, "i").toLowerCase();

// Turkish entity words, matched as STEMS with an optional suffix.
//
// Turkish is agglutinative: "fatura", "faturalar", "faturaları", "faturalarında" are all the same
// word for our purposes. An exact-word list looked right and matched none of them — the first
// version of this parser returned no entities for "akon faturaları", which is the single most
// obvious query anyone would type.
const ENTITY_STEMS: Array<[RegExp, SearchEntityKey]> = [
  [/^fatura\w*$/, "invoices"],
  [/^cek(ler)?\w*$/, "checks"],
  [/^kredi\w*$/, "loans"],
  [/^(banka\w*|ekstre\w*|hareket\w*)$/, "bank_transactions"],
  [/^(musteri\w*|tedarikci\w*|cari\w*)$/, "parties"],
  [/^(odeme\w*|taksit\w*)$/, "payment_instances"],
  [/^(soz|sozu|sozler\w*|taahhut\w*)$/, "promise_to_pay"],
  [/^(dokuman\w*|belge\w*|sozlesme\w*|evrak\w*)$/, "documents"],
  [/^(denetim\w*|log\w*)$/, "audit_logs"],
];

/** Tokens that belong to a date phrase and must not survive as free-text search terms. */
const DATE_WORD = /^(son|gecen|onceki|bir)$/;
const DATE_UNIT = /^(gun\w*|hafta\w*|ay\w*|yil\w*|ceyrek\w*)$/;
const AMOUNT_WORD = /^(tl|try|uzeri|uzerinde|ustu|ustunde|buyuk)$/;
const NUMBER_TOKEN = /^[\d.,]+$/;

/**
 * Parse a Turkish query deterministically.
 *
 * Runs FIRST and always. The model is an optional refinement on top of this, never a
 * prerequisite: search that stops working when an API key expires is not search.
 */
export function parseSearchQuery(raw: string, todayISO: string): SearchIntent {
  // Token-based, not regex-over-the-whole-string.
  //
  // The first version matched against the NORMALISED text but then stripped consumed words from
  // the RAW text with the same patterns — so "son 30 gün" was detected and then left in the
  // search terms, because the raw string says "gün" and the pattern says "gun". Working token by
  // token keeps the original characters (which the ILIKE needs) while deciding on the normalised
  // form (which the matching needs).
  const rawTokens = raw.split(/\s+/).filter(Boolean);
  const tokens = rawTokens.map((t) => ({ raw: t, norm: norm(t), consumed: false }));

  const entities: SearchEntityKey[] = [];
  for (const token of tokens) {
    for (const [rx, key] of ENTITY_STEMS) {
      if (rx.test(token.norm)) {
        entities.push(key);
        token.consumed = true;
        break;
      }
    }
  }

  // Date phrase: a unit word ("gün", "ay", "yıl", "hafta", "çeyrek") anchors it; a preceding
  // number and any "son/geçen/bir" around it belong to the same phrase.
  let days: number | null = null;
  for (let i = 0; i < tokens.length; i++) {
    if (!DATE_UNIT.test(tokens[i].norm)) continue;
    const unit = tokens[i].norm;
    const prev = tokens[i - 1];
    const count = prev && /^\d+$/.test(prev.norm) ? Number(prev.norm) : 1;
    const perUnit = unit.startsWith("gun") ? 1
      : unit.startsWith("hafta") ? 7
      : unit.startsWith("ay") ? 30
      : unit.startsWith("ceyrek") ? 90
      : 365;
    days = count * perUnit;
    tokens[i].consumed = true;
    if (prev && /^\d+$/.test(prev.norm)) prev.consumed = true;
    for (const near of [tokens[i - 2], tokens[i - 1], tokens[i + 1]]) {
      if (near && DATE_WORD.test(near.norm)) near.consumed = true;
    }
    break;
  }
  const dateFrom = days == null
    ? null
    : new Date(Date.parse(`${todayISO}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);

  // "10.000 TL üzeri" — Turkish thousands separator is '.', decimal ','.
  let amountMin: number | null = null;
  for (let i = 0; i < tokens.length; i++) {
    if (!AMOUNT_WORD.test(tokens[i].norm) || tokens[i].norm === "tl" || tokens[i].norm === "try") continue;
    // Walk back over "TL"/"TRY" to the number that the comparison word refers to.
    let j = i - 1;
    while (j >= 0 && (tokens[j].norm === "tl" || tokens[j].norm === "try")) {
      tokens[j].consumed = true;
      j--;
    }
    if (j >= 0 && NUMBER_TOKEN.test(tokens[j].norm)) {
      const numeric = Number(tokens[j].norm.replace(/\./g, "").replace(",", "."));
      if (Number.isFinite(numeric) && numeric >= 0) {
        amountMin = numeric;
        tokens[j].consumed = true;
        tokens[i].consumed = true;
      }
    }
    break;
  }

  const text = tokens.filter((t) => !t.consumed).map((t) => t.raw).join(" ").trim();

  return searchIntentSchema.parse({
    entities: [...new Set(entities)],
    text,
    dateFrom,
    dateTo: null,
    amountMin,
  });
}

/**
 * Validate whatever a model returned, and INTERSECT it with what the deterministic parse allowed
 * to search.
 *
 * Intersecting rather than replacing is the safety property: a model can NARROW a search or add
 * a date it spotted, but it can never make the search reach entities the user's own words did not
 * name — so a prompt-injected "search everything" cannot widen scope. When the deterministic
 * parse named nothing, the model's entity list is accepted, because "nothing" is not a
 * restriction to preserve.
 */
export function reconcileModelIntent(
  deterministic: SearchIntent, rawModelOutput: unknown,
): { intent: SearchIntent; accepted: boolean; reason: string } {
  const parsed = searchIntentSchema.safeParse(rawModelOutput);
  if (!parsed.success) {
    return {
      intent: deterministic, accepted: false,
      reason: "Model çıktısı şemaya uymadı; deterministik ayrıştırma kullanıldı.",
    };
  }
  const model = parsed.data;
  const entities = deterministic.entities.length === 0
    ? model.entities
    : model.entities.filter((e) => deterministic.entities.includes(e));

  return {
    intent: {
      entities: entities.length ? entities : deterministic.entities,
      // Free text always comes from the USER, never from the model: letting a model rewrite the
      // search string would let it search for something the user did not ask for.
      text: deterministic.text,
      dateFrom: model.dateFrom ?? deterministic.dateFrom,
      dateTo: model.dateTo ?? deterministic.dateTo,
      amountMin: model.amountMin ?? deterministic.amountMin,
    },
    accepted: true,
    reason: "Model niyeti kabul edildi (kapsam yalnızca daraltılabilir).",
  };
}

/** Nothing to search on: no text, no filters. Used to avoid returning the whole database. */
export function isEmptyIntent(intent: SearchIntent): boolean {
  return intent.text.length === 0 && intent.dateFrom == null
    && intent.dateTo == null && intent.amountMin == null;
}
