// Faz 38 — role-scoped fact visibility for the assistant.
//
// ═══ THE ASSISTANT MUST NOT BECOME A SIDE DOOR ═══
//
// Faz 24B decides which modules a tier may see; Faz 36 wired that into the navigation and the
// tabs. An assistant that answered from every fact regardless of role would undo both: a viewer
// who cannot open /system would simply ASK for what is on it, and the answer would arrive in
// prose with a link they cannot follow.
//
// So every fact is filtered through the SAME `canSeeRoute` the navigation uses — not a second
// list of "sensitive facts" that would drift from it. A fact's `sourceHref` already names the
// screen it came from, which is exactly the question canSeeRoute answers.
//
// Pure: no database, no LLM. The filtering happens before a question ever reaches the model, so a
// fact a tier may not see is never put in a prompt in the first place.

import type { DecisionFact } from "@/lib/facts/engine";
import { canSeeRoute, type AppRole } from "@/lib/authz/matrix";

export interface VisibilityDecision {
  visible: DecisionFact[];
  /** Facts withheld from this tier, kept so the count can be disclosed rather than hidden. */
  withheld: DecisionFact[];
}

/** The route a fact's evidence lives on. `sourceHref` may carry a query string; strip it. */
export function factRoute(fact: DecisionFact): string {
  const href = fact.sourceHref || "/";
  const q = href.indexOf("?");
  return q === -1 ? href : href.slice(0, q);
}

/**
 * Split facts into what this tier may see and what it may not.
 *
 * Withheld facts are COUNTED, not silently dropped. An assistant that quietly answers from less
 * information than it had is worse than one that says so: the reader cannot tell a thin answer
 * from a complete one, and would reasonably assume the latter.
 */
export function scopeFactsForRole(role: AppRole, facts: readonly DecisionFact[]): VisibilityDecision {
  const visible: DecisionFact[] = [];
  const withheld: DecisionFact[] = [];
  for (const fact of facts) {
    if (canSeeRoute(role, factRoute(fact))) visible.push(fact);
    else withheld.push(fact);
  }
  return { visible, withheld };
}

/**
 * The sentence appended to an answer when facts were withheld.
 *
 * Names the count and the reason, never the content — telling a viewer "3 facts about /system
 * were hidden" is disclosure; telling them what those facts said would be the leak this module
 * exists to prevent.
 */
export function withheldNotice(decision: VisibilityDecision): string | null {
  if (decision.withheld.length === 0) return null;
  return `Rolünüzün erişemediği ${decision.withheld.length} bulgu bu cevaba dahil edilmedi.`;
}
