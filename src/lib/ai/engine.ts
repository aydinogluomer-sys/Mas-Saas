import type { Pool } from "pg";
import { cache } from "@/lib/cache/engine";
import { loadDecisionFacts, type DecisionFact } from "@/lib/facts/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { audit } from "@/lib/audit";
import {
  buildDeterministicAnswer,
  buildModelPrompt,
  mutationIntent,
  sanitizeQuestion,
  selectFactsForQuestion,
  type AiResponseMode,
} from "./rules";

function extractOutputText(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as { output_text?: unknown; output?: unknown };
  if (typeof obj.output_text === "string" && obj.output_text.trim()) return obj.output_text.trim();
  if (!Array.isArray(obj.output)) return null;
  const parts: string[] = [];
  for (const item of obj.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const text = (c as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("").trim() || null;
}

/**
 * Read env lazily — the Faz 25 fix, applied to the same trap in a second place.
 *
 * `import { env }` at module scope made this file (and therefore facts/engine, and therefore any
 * gate that touches the assistant) unimportable without a DATABASE_URL, because env.ts validates
 * at module load. phase38:verify hit exactly that and could not run under its own documented
 * command. Startup validation still happens — @/lib/db imports env statically and every server
 * path goes through the pool.
 *
 * BEHAVIOUR IS UNCHANGED: the same two values are read, in the same place, before any request.
 * The kill switch below is evaluated exactly as before.
 */
async function readEnv() {
  const { env } = await import("@/lib/env");
  return env;
}

const OPENAI_TIMEOUT_MS = 15_000;

async function callOpenAI(question: string, facts: DecisionFact[]): Promise<{ text: string; model: string } | null> {
  const env = await readEnv();
  const apiKey = env.openaiApiKey;
  if (!apiKey || env.aiForceDeterministic) return null;
  const model = env.openaiModel;
  const prompt = buildModelPrompt(question, facts);
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      instructions: "Yaniti yalniz verilen facts'e dayandir. Finansal kayit mutasyonu onerme veya yaptigini soyleme.",
      input: prompt,
    }),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OpenAI HTTP ${res.status}: ${res.statusText}`);
  }
  const text = extractOutputText(await res.json());
  return text ? { text, model } : null;
}

export interface AskAnswerResult {
  id: string;
  question: string;
  answerMd: string;
  responseMode: AiResponseMode;
  model: string | null;
  sourceFactKeys: string[];
  sourceHrefs: string[];
  safetyNotes: string[];
}

export async function answerQuestion(
  pool: Pool,
  input: { question: string; reportId?: string | null; forceDeterministic?: boolean },
  actorId: string,
): Promise<AskAnswerResult> {
  const question = sanitizeQuestion(input.question);
  const facts = await loadDecisionFacts(pool, istanbulDateISO());
  const selectedFacts = selectFactsForQuestion(question, facts);
  const draft = buildDeterministicAnswer(question, facts);
  const safetyNotes = [...draft.safetyNotes];
  let answerMd = draft.answerMd;
  let responseMode: AiResponseMode = "deterministic";
  let model: string | null = null;

  if (!mutationIntent(question) && !input.forceDeterministic) {
    try {
      const modelAnswer = await callOpenAI(question, selectedFacts);
      if (modelAnswer) {
        answerMd = modelAnswer.text;
        responseMode = "openai";
        model = modelAnswer.model;
      }
    } catch (e) {
      responseMode = "fallback";
      safetyNotes.push(`Model cagrisi basarisiz; deterministik cevaba donuldu: ${(e as Error).message}`);
    }
  }

  const sourceFactKeys = selectedFacts.map((f) => f.key);
  const sourceHrefs = [...new Set(selectedFacts.map((f) => f.sourceHref))];
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query<{ id: string }>(
      `insert into public.ai_response_snapshots
         (question, answer_md, response_mode, model, source_fact_keys, source_hrefs, report_id, safety_notes, meta)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [
        question,
        answerMd,
        responseMode,
        model,
        sourceFactKeys,
        sourceHrefs,
        input.reportId ?? null,
        safetyNotes,
        JSON.stringify({ selectedFactCount: selectedFacts.length }),
      ],
    );
    const id = ins.rows[0].id;
    await audit(client, {
      actor: actorId, action: "answer_question", entityTable: "ai_response_snapshots", entityId: id,
      after: { responseMode, model, reportId: input.reportId ?? null, sourceFactKeys },
    });
    await client.query("commit");
    return { id, question, answerMd, responseMode, model, sourceFactKeys, sourceHrefs, safetyNotes };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function answerReportQuestion(pool: Pool, reportId: string, actorId: string): Promise<AskAnswerResult> {
  const report = await pool.query<{ report_type: string; body_md: string; meta: Record<string, unknown> | null }>(
    `select report_type, body_md, meta from public.reports where id=$1`,
    [reportId],
  );
  const r = report.rows[0];
  const prompt =
    typeof r?.meta?.commentary_prompt === "string"
      ? r.meta.commentary_prompt
      : "Bu raporu karar verici icin yorumla; yalniz deterministik facts'e dayan.";
  return answerQuestion(pool, {
    question: `Rapor yorumu (${r?.report_type ?? "rapor"}): ${prompt}`,
    reportId,
  }, actorId);
}

export async function loadAiResponse(pool: Pool, id: string) {
  const r = await pool.query(
    `select id, question, answer_md, response_mode, model, source_fact_keys, source_hrefs,
            report_id, safety_notes, meta,
            to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
     from public.ai_response_snapshots where id=$1`,
    [id],
  );
  return r.rows[0] as
    | {
        id: string; question: string; answer_md: string; response_mode: AiResponseMode; model: string | null;
        source_fact_keys: string[]; source_hrefs: string[]; report_id: string | null; safety_notes: string[];
        meta: Record<string, unknown> | null; created_at: string;
      }
    | undefined;
}

export async function listAiResponses(pool: Pool, limit = 20, reportId?: string) {
  return cache.withCache(
    `ai:responses:${reportId ?? "all"}:${limit}`,
    async () => {
      const r = await pool.query(
        reportId
          ? `select id, question, response_mode, model, source_fact_keys, source_hrefs,
                    to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
             from public.ai_response_snapshots where report_id=$1 order by created_at desc limit $2`
          : `select id, question, response_mode, model, source_fact_keys, source_hrefs,
                    to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
             from public.ai_response_snapshots order by created_at desc limit $1`,
        reportId ? [reportId, limit] : [limit],
      );
      return r.rows as Array<{ id: string; question: string; response_mode: AiResponseMode; model: string | null; source_fact_keys: string[]; source_hrefs: string[]; created_at: string }>;
    },
    { ttlSeconds: 60 }
  );
}
