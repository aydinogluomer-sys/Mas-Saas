// Faz 38 — follow-up context and conversation shaping.
//
// Pure: no database, no LLM, no clock. A follow-up is resolved by TEXT, deterministically, before
// anything reaches the model — so "peki ya geçen ay?" becomes a complete question this system can
// answer and audit, rather than a fragment a model has to guess at.
//
// ═══ THE MUTATION GUARD IS RE-APPLIED AFTER EXPANSION, AND THAT IS THE POINT ═══
//
// Expanding a follow-up CREATES A NEW QUESTION STRING. If the guard ran only on what the user
// typed, a harmless-looking follow-up could be stitched onto a previous turn to produce something
// the guard would have refused. src/lib/assistant/engine.ts therefore runs mutationIntent() on the
// EXPANDED text, and phase38:verify proves that with a two-turn attack.

import { mutationIntent, sanitizeQuestion } from "@/lib/ai/rules";

export interface ConversationTurn {
  turnIndex: number;
  question: string;
  answerMd: string;
  responseMode: string;
  factKeys: readonly string[];
}

/** Turkish openers that mark a fragment as a continuation rather than a fresh question. */
const FOLLOW_UP_MARKERS = [
  /^peki\b/i, /^ya\b/i, /^peki ya\b/i, /^ondan\b/i, /^bunun\b/i, /^onun\b/i,
  /^neden\b/i, /^niye\b/i, /^ne kadar\b/i, /^kaç\b/i, /^detay/i, /^ayrıntı/i,
  /^aynısı/i, /^bir de\b/i, /^peki ne\b/i,
];

const norm = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/ı/g, "i").replace(/İ/g, "i").toLowerCase();

/**
 * Does this look like a follow-up rather than a standalone question?
 *
 * Deliberately conservative: a short fragment starting with a continuation word. Treating a full
 * question as a follow-up would silently graft the previous turn's subject onto it and answer
 * something nobody asked.
 */
export function isFollowUp(question: string): boolean {
  const q = norm(sanitizeQuestion(question));
  if (q.length === 0) return false;
  // A long question carries its own subject; it is not a fragment.
  if (q.split(/\s+/).length > 8) return false;
  return FOLLOW_UP_MARKERS.some((rx) => rx.test(q));
}

export interface ExpansionResult {
  /** The question actually answered. Equal to the input when it was not a follow-up. */
  expanded: string;
  /** True when previous context was folded in. */
  usedContext: boolean;
  /** The turn the context came from, for traceability. */
  contextTurnIndex: number | null;
}

/**
 * Turn a follow-up fragment into a complete question by prefixing the previous turn's subject.
 *
 * The previous QUESTION is used, never the previous ANSWER. An answer can contain model prose,
 * and folding that back into the next prompt is how a small hallucination becomes the premise of
 * every later turn in the thread.
 */
export function expandFollowUp(
  question: string, history: readonly ConversationTurn[],
): ExpansionResult {
  const clean = sanitizeQuestion(question);
  if (!isFollowUp(clean) || history.length === 0) {
    return { expanded: clean, usedContext: false, contextTurnIndex: null };
  }
  const previous = [...history].sort((a, b) => b.turnIndex - a.turnIndex)[0];
  return {
    expanded: sanitizeQuestion(`${previous.question} — takip sorusu: ${clean}`),
    usedContext: true,
    contextTurnIndex: previous.turnIndex,
  };
}

/**
 * Whether an expansion is safe to answer.
 *
 * Re-checks the mutation guard on the EXPANDED text. Returns the reason so the caller can record
 * why a turn was forced onto the deterministic path instead of silently downgrading it.
 */
export function expansionIsSafe(expansion: ExpansionResult): { safe: boolean; reason: string | null } {
  if (mutationIntent(expansion.expanded)) {
    return { safe: false, reason: "Genişletilmiş soru mutasyon niyeti taşıyor" };
  }
  return { safe: true, reason: null };
}

/**
 * Trim history to the most recent N turns.
 *
 * Bounded because an unbounded thread would grow the prompt without limit — and because a
 * question from forty turns ago is rarely the context for this one. Newest first is NOT used:
 * turns are returned in order so a reader can follow the thread.
 */
export function recentHistory(
  history: readonly ConversationTurn[], maxTurns = 5,
): ConversationTurn[] {
  return [...history]
    .sort((a, b) => a.turnIndex - b.turnIndex)
    .slice(-Math.max(1, maxTurns));
}

/** A conversation title derived from its first question. Never model-generated. */
export function titleFor(firstQuestion: string): string {
  const clean = sanitizeQuestion(firstQuestion);
  return clean.length <= 80 ? clean || "Adsız konuşma" : `${clean.slice(0, 77)}…`;
}
