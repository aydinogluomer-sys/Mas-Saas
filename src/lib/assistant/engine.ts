// Faz 38 — the conversational assistant.
//
// ═══ WHAT THIS MODULE DOES NOT DO ═══
//
// It does not call a model. It does not build a prompt. It does not decide whether an answer may
// go to a model. All three live in src/lib/ai — the most security-critical boundary in this
// repository — and this phase extends AROUND that boundary rather than through it:
//
//   * `answerQuestion()` still owns the deterministic-first flow, the mutationIntent() gate and
//     the try/catch that degrades to a deterministic answer when the model is unreachable.
//   * `AI_FORCE_DETERMINISTIC` still short-circuits inside callOpenAI, untouched.
//
// What Faz 38 adds is on either side of that call: role-scoped fact visibility BEFORE it, and
// conversation/traceability AFTER it.
//
// ═══ THE GUARD RUNS TWICE, ON PURPOSE ═══
//
// Expanding a follow-up produces a NEW question string. Checking only what the user typed would
// let a benign fragment be stitched onto an earlier turn to form something the guard would have
// refused. So mutationIntent() is applied to the EXPANDED text here, and answerQuestion applies
// it again to what it receives. Two checks on two different strings, not one check twice.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { answerQuestion, type AskAnswerResult } from "@/lib/ai/engine";
import { mutationIntent, sanitizeQuestion } from "@/lib/ai/rules";
import { loadDecisionFacts, type DecisionFact } from "@/lib/facts/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import type { AppRole } from "@/lib/authz/matrix";
import { scopeFactsForRole, withheldNotice, factRoute } from "./visibility";
import {
  expandFollowUp, expansionIsSafe, recentHistory, titleFor,
  type ConversationTurn,
} from "./context";

export const askSchema = z.object({
  question: z.string().trim().min(1).max(800),
  conversationId: z.string().uuid().nullable().default(null),
  forceDeterministic: z.boolean().optional().default(false),
});
export type AskInput = z.infer<typeof askSchema>;

export interface DrillDown {
  label: string;
  href: string;
}

export interface AssistantAnswer {
  conversationId: string;
  turnIndex: number;
  responseId: string;
  question: string;
  /** The question actually answered, after follow-up expansion. */
  answeredQuestion: string;
  answerMd: string;
  responseMode: string;
  /** Screens the reader can open to check the answer themselves. */
  drillDowns: DrillDown[];
  /** Full provenance: which facts, from which screens, as of when. */
  trace: {
    factKeys: string[];
    sources: string[];
    asOf: string;
    withheldCount: number;
    usedContextFromTurn: number | null;
    forcedDeterministicReason: string | null;
  };
  safetyNotes: string[];
}

/** `42P01` (`undefined_table`) veya `42703` (`undefined_column`) şema geçiş koruması. */
export function isMissingSchemaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "42P01" || code === "42703";
}

/** Turns of one conversation, oldest first. */
export async function loadHistory(pool: Pool, conversationId: string): Promise<ConversationTurn[]> {
  try {
    const res = await pool.query(
      `select turn_index, question, answer_md, response_mode, source_fact_keys
         from public.ai_response_snapshots
        where conversation_id = $1 and turn_index is not null
        order by turn_index`, [conversationId]);
    return res.rows.map((r) => ({
      turnIndex: Number(r.turn_index),
      question: r.question as string,
      answerMd: r.answer_md as string,
      responseMode: r.response_mode as string,
      factKeys: (r.source_fact_keys as string[] | null) ?? [],
    }));
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

export interface ConversationTurnDetail extends ConversationTurn {
  responseId: string;
  createdAt: string | null;
}

export interface ConversationThreadDetail {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  turns: ConversationTurnDetail[];
}

export async function loadConversationDetail(
  pool: Pool,
  conversationId: string,
): Promise<ConversationThreadDetail | null> {
  try {
    const convRes = await pool.query(
      `select id, title, status,
              to_char(updated_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as updated_at
         from public.assistant_conversations
        where id = $1
        limit 1`,
      [conversationId],
    );
    if ((convRes.rowCount ?? 0) === 0) return null;
    const turnRes = await pool.query(
      `select id, turn_index, question, answer_md, response_mode, source_fact_keys,
              to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
         from public.ai_response_snapshots
        where conversation_id = $1 and turn_index is not null
        order by turn_index asc`,
      [conversationId],
    );
    const row = convRes.rows[0];
    return {
      id: row.id as string,
      title: row.title as string,
      status: row.status as string,
      updatedAt: row.updated_at as string,
      turns: turnRes.rows.map((r) => ({
        responseId: r.id as string,
        turnIndex: Number(r.turn_index),
        question: r.question as string,
        answerMd: r.answer_md as string,
        responseMode: r.response_mode as string,
        factKeys: (r.source_fact_keys as string[] | null) ?? [],
        createdAt: (r.created_at as string | null) ?? null,
      })),
    };
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function listConversations(pool: Pool, limit = 50) {
  // No ownership predicate: RLS (0087) decides what this connection may see. A second filter in
  // application code would be a second, drifting opinion about visibility.
  try {
    const res = await pool.query(
      `select c.id, c.title, c.status,
              to_char(c.updated_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as updated_at,
              (select count(*)::int from public.ai_response_snapshots s
                where s.conversation_id = c.id) as turn_count
         from public.assistant_conversations c
        order by c.updated_at desc limit $1`, [limit]);
    return res.rows.map((r) => ({
      id: r.id as string, title: r.title as string, status: r.status as string,
      updatedAt: r.updated_at as string, turnCount: Number(r.turn_count),
    }));
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

export interface FinancialContextSummary {
  asOf: string;
  role: AppRole;
  visibleFactCount: number;
  withheldFactCount: number;
  withheldNoticeText: string | null;
  sourceRoutes: string[];
  sampleTitles: string[];
}

/**
 * Salt-okunur, sıfır-LLM finansal bağlam özeti.
 * Kullanıcının rolüne göre hangi karar gerçeklerinin (DecisionFact) ve hangi kanonik ekranların
 * asistan bağlamına dahil edildiğini deterministik olarak raporlar.
 */
export async function buildFinancialContext(
  pool: Pool,
  role: AppRole,
  todayISO = istanbulDateISO(),
): Promise<FinancialContextSummary> {
  let allFacts: DecisionFact[] = [];
  try {
    allFacts = await loadDecisionFacts(pool, todayISO);
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    allFacts = [];
  }
  const scoped = scopeFactsForRole(role, allFacts);
  const sourceRoutes = [...new Set(scoped.visible.map(factRoute))].sort();
  return {
    asOf: todayISO,
    role,
    visibleFactCount: scoped.visible.length,
    withheldFactCount: scoped.withheld.length,
    withheldNoticeText: withheldNotice(scoped),
    sourceRoutes,
    sampleTitles: scoped.visible.slice(0, 6).map((f) => f.title),
  };
}

/** Drill-downs come from the facts that were actually used — never invented for the answer. */
function drillDownsFor(facts: readonly DecisionFact[]): DrillDown[] {
  const seen = new Map<string, string>();
  for (const fact of facts) {
    const href = fact.sourceHref;
    if (href && !seen.has(href)) seen.set(href, fact.title);
  }
  return [...seen.entries()].map(([href, label]) => ({ href, label })).slice(0, 6);
}

/**
 * Ask the assistant.
 *
 * Order matters and is deliberate:
 *   1. expand the follow-up (deterministic, text only)
 *   2. re-apply the mutation guard to the EXPANDED text
 *   3. scope facts to the caller's role BEFORE anything could reach a model
 *   4. delegate to answerQuestion(), which owns the model boundary
 *   5. record the turn and its provenance
 */
export async function ask(
  pool: Pool, raw: unknown, actorId: string, role: AppRole,
  todayISO = istanbulDateISO(),
): Promise<AssistantAnswer> {
  const input = askSchema.parse(raw);
  const question = sanitizeQuestion(input.question);

  const history = input.conversationId ? await loadHistory(pool, input.conversationId) : [];
  const expansion = expandFollowUp(question, recentHistory(history));
  const safety = expansionIsSafe(expansion);

  // Role scoping happens here, before the question is answered, so a fact this tier may not see
  // is never selected, never summarised and never put in a prompt.
  const allFacts = await loadDecisionFacts(pool, todayISO);
  const scoped = scopeFactsForRole(role, allFacts);

  // `forceDeterministic` is passed through to the EXISTING engine rather than reimplemented. When
  // the expanded question trips the guard, the model is not consulted at all — same outcome the
  // guard already produces for a directly-typed mutation request, reached one step earlier.
  const forceDet = Boolean(input.forceDeterministic) || !safety.safe || mutationIntent(expansion.expanded);
  const result: AskAnswerResult = await answerQuestion(
    pool,
    {
      question: expansion.expanded,
      forceDeterministic: forceDet,
      preScopedFacts: scoped.visible,
      role,
    },
    actorId,
  );

  const candidateUsedFacts = scopeFactsForRole(role, [
    ...(result.selectedFacts ?? []),
    ...scoped.visible,
  ]).visible;
  const seenUsedKeys = new Set<string>();
  const visibleUsed = candidateUsedFacts.filter((f) => {
    if (!result.sourceFactKeys.includes(f.key) || seenUsedKeys.has(f.key)) return false;
    seenUsedKeys.add(f.key);
    return true;
  });

  const notice = withheldNotice(scoped);
  const safetyNotes = [...result.safetyNotes];
  if (notice) safetyNotes.push(notice);
  if (!safety.safe && safety.reason) safetyNotes.push(safety.reason);

  const client = await pool.connect();
  try {
    await client.query("begin");

    let conversationId = input.conversationId;
    if (!conversationId) {
      const created = await client.query(
        `insert into public.assistant_conversations (title, created_by) values ($1,$2) returning id`,
        [titleFor(question), actorId]);
      conversationId = created.rows[0].id as string;
    } else {
      await client.query(
        `update public.assistant_conversations set updated_at = now() where id = $1`,
        [conversationId]);
    }

    const nextTurn = history.length === 0
      ? 1
      : Math.max(...history.map((t) => t.turnIndex)) + 1;

    await client.query(
      `update public.ai_response_snapshots set conversation_id = $1, turn_index = $2 where id = $3`,
      [conversationId, nextTurn, result.id]);

    await audit(client, {
      actor: actorId, action: "assistant_ask",
      entityTable: "assistant_conversations", entityId: conversationId,
      after: {
        turnIndex: nextTurn,
        responseMode: result.responseMode,
        role,
        withheldFactCount: scoped.withheld.length,
        usedContextFromTurn: expansion.contextTurnIndex,
        forcedDeterministic: !safety.safe,
        // Recorded explicitly: asking a question changes no financial record.
        mutatedFinancialRecords: false,
      },
    });
    await client.query("commit");

    return {
      conversationId,
      turnIndex: nextTurn,
      responseId: result.id,
      question,
      answeredQuestion: expansion.expanded,
      answerMd: result.answerMd,
      responseMode: result.responseMode,
      drillDowns: drillDownsFor(visibleUsed),
      trace: {
        factKeys: visibleUsed.map((f) => f.key),
        // Faz 2's lineage idea applied to an answer: the screens the numbers came from, so a
        // reader can reproduce the answer instead of believing it.
        sources: [...new Set(visibleUsed.map(factRoute))].sort(),
        asOf: todayISO,
        withheldCount: scoped.withheld.length,
        usedContextFromTurn: expansion.contextTurnIndex,
        forcedDeterministicReason: safety.reason,
      },
      safetyNotes,
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
