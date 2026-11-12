import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ runAsUser: vi.fn() }));

import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  listJobs,
  loadJobWithResult,
  reapStuckJobs,
  replayDeadLetter,
  reportProgress,
  requeueDueFailures,
} from "@/lib/jobs/queue";
import { getAsyncPreviewJobStatus } from "@/lib/importers/v2/async-runner";

const ROOT = process.cwd();
const MIGRATION_0108_PATH = path.join(
  ROOT,
  "supabase",
  "migrations",
  "0108_background_jobs_result_and_immutability.sql",
);
const CONSTRAINTS_VERIFY_PATH = path.join(ROOT, "scripts", "db", "constraints-verify.ts");

/** Same comment/literal/dollar-quote stripper as scripts/db/migration-lib.ts. */
function stripSqlNoise(sql: string): string {
  let result = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      result += "\n";
      continue;
    }
    if (sql[i] === "$") {
      const m = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          i = end + tag.length;
          result += "\n";
          continue;
        }
      }
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      i = j;
      result += "\n";
      continue;
    }
    result += sql[i];
    i++;
  }
  return result;
}

describe("Migration 0108 — SQL yapısı, hijyen ve değişmezlik sözleşmesi", () => {
  const sql = readFileSync(MIGRATION_0108_PATH, "utf8");
  const stripped = stripSqlNoise(sql);

  it("migration-lib kurallarına tam uyar ve sıfır SECURITY DEFINER içerir", () => {
    expect(path.basename(MIGRATION_0108_PATH)).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    expect(stripped).not.toMatch(/^[ \t]*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im);
    expect(stripped).not.toMatch(/CREATE\s+INDEX\s+CONCURRENTLY/i);
    expect(sql).not.toMatch(/security\s+definer/i);
  });

  it("result jsonb kolonunu ekler, tetikleyiciden ÖNCE payload->'result' verisini taşır ve temizler", () => {
    const addColIdx = sql.search(
      /alter\s+table\s+public\.background_jobs\s+add\s+column\s+if\s+not\s+exists\s+result\s+jsonb\s*;/i,
    );
    const backfillIdx = sql.search(
      /update\s+public\.background_jobs[\s\S]*?set\s+result\s*=\s*payload\s*->\s*'result'\s*,\s*payload\s*=\s*payload\s*-\s*'result'[\s\S]*?where\s+result\s+is\s+null[\s\S]*?jsonb_typeof\(payload\)\s*=\s*'object'[\s\S]*?payload\s*\?\s*'result'/i,
    );
    const createTriggerIdx = sql.search(
      /create\s+trigger\s+enforce_background_jobs_immutable_envelope[\s\S]*?before\s+update\s+on\s+public\.background_jobs/i,
    );

    expect(addColIdx).toBeGreaterThanOrEqual(0);
    expect(backfillIdx).toBeGreaterThan(addColIdx);
    expect(createTriggerIdx).toBeGreaterThan(backfillIdx);
  });

  it("enforce_background_jobs_immutable_envelope zarf kolonlarını ERRCODE 23514 ile kilitler", () => {
    expect(sql).toMatch(
      /create\s+or\s+replace\s+function\s+public\.enforce_background_jobs_immutable_envelope\(\)\s*returns\s+trigger\s+language\s+plpgsql/i,
    );
    for (const col of ["id", "job_type", "created_by", "payload", "dedupe_key", "created_at"]) {
      expect(sql, `zarf kolonu eksik: ${col}`).toMatch(
        new RegExp(`new\\.${col}\\s+is\\s+distinct\\s+from\\s+old\\.${col}`, "i"),
      );
    }
    expect(sql).toMatch(/raise\s+exception\s+'background_jobs_envelope_immutable'[\s\S]*?using\s+errcode\s*=\s*'23514'/i);
    expect(sql).toMatch(
      /create\s+trigger\s+enforce_background_jobs_immutable_envelope\s+before\s+update\s+on\s+public\.background_jobs\s+for\s+each\s+row\s+execute\s+function\s+public\.enforce_background_jobs_immutable_envelope\(\)/i,
    );
  });

  it("constraints-verify.ts 0108 tetikleyicisini ve 23514 redlerini doğrular", () => {
    const verifySrc = readFileSync(CONSTRAINTS_VERIFY_PATH, "utf8");
    expect(verifySrc).toContain("enforce_background_jobs_immutable_envelope");
    expect(verifySrc).toContain("background_jobs_envelope_immutable");
    expect(verifySrc).toContain('e.code === "23514"');
    expect(verifySrc).toContain("runFaz57QueueImmutabilityAssertions");
  });
});

interface StoredJob {
  id: string;
  job_type: string;
  status: string;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  dedupe_key: string | null;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  progress_total: number | null;
  progress_done: number;
  dead_lettered_at: string | null;
  dead_letter_reason: string | null;
  created_by: string | null;
  created_at: string;
}

function createImmutabilityEnforcingMockPool() {
  const jobs = new Map<string, StoredJob>();
  const audits: Array<{ action: string; actor: unknown; after: Record<string, unknown> }> = [];
  let seq = 0;

  const throw23514 = (): never => {
    const err = new Error("background_jobs_envelope_immutable") as Error & { code: string };
    err.code = "23514";
    throw err;
  };

  const assertUpdateDoesNotTouchEnvelope = (sqlText: string) => {
    const setMatch = /update\s+public\.background_jobs(?:\s+\w+)?\s+set\s+([\s\S]*?)\s+where\b/i.exec(sqlText);
    if (!setMatch) return;
    const setClause = setMatch[1];
    for (const immutableCol of ["id", "job_type", "created_by", "payload", "dedupe_key", "created_at"]) {
      if (new RegExp(`(^|,)\\s*${immutableCol}\\s*=`, "i").test(setClause)) {
        throw23514();
      }
    }
  };

  const execQuery = async (text: string, values: unknown[] = []) => {
    const trimmed = text.trim();
    if (/^(begin|commit|rollback)$/i.test(trimmed)) {
      return { rowCount: 0, rows: [] };
    }

    if (/insert\s+into\s+public\.audit_logs/i.test(trimmed)) {
      audits.push({
        actor: values[0],
        action: String(values[1]),
        after: JSON.parse(String(values[5] ?? "{}")),
      });
      return { rowCount: 1, rows: [{ id: `aud-${audits.length}` }] };
    }

    if (/update\s+public\.background_jobs/i.test(trimmed)) {
      assertUpdateDoesNotTouchEnvelope(trimmed);

      // claimNextJob
      if (/for\s+update\s+skip\s+locked/i.test(trimmed)) {
        const allowedTypes = (values[0] as string[] | null) ?? null;
        const candidate = [...jobs.values()].find(
          (j) => j.status === "queued" && (allowedTypes === null || allowedTypes.includes(j.job_type)),
        );
        if (!candidate) return { rowCount: 0, rows: [] };
        candidate.status = "running";
        candidate.started_at = "2026-11-11T12:00:01Z";
        candidate.attempts += 1;
        return { rowCount: 1, rows: [{ ...candidate }] };
      }

      // reportProgress
      if (/set\s+progress_done\s*=\s*\$2/i.test(trimmed)) {
        const j = jobs.get(String(values[0]));
        if (!j || j.status !== "running") return { rowCount: 0, rows: [] };
        j.progress_done = Number(values[1]);
        if (values[2] != null) j.progress_total = Number(values[2]);
        return { rowCount: 1, rows: [] };
      }

      // completeJob
      if (/set\s+status\s*=\s*'succeeded'/i.test(trimmed)) {
        const j = jobs.get(String(values[0]));
        if (!j || j.status !== "running") return { rowCount: 0, rows: [] };
        j.status = "succeeded";
        j.finished_at = "2026-11-11T12:00:05Z";
        j.last_error = null;
        if (/result\s*=\s*\$2::jsonb/i.test(trimmed)) {
          j.result = JSON.parse(String(values[1])) as Record<string, unknown>;
        }
        return { rowCount: 1, rows: [{ id: j.id }] };
      }

      // failJob -> dead_letter
      if (/set\s+status\s*=\s*'dead_letter'/i.test(trimmed)) {
        const j = jobs.get(String(values[0]));
        if (!j) return { rowCount: 0, rows: [] };
        j.status = "dead_letter";
        j.finished_at = "2026-11-11T12:00:06Z";
        j.last_error = String(values[1]);
        j.dead_lettered_at = "2026-11-11T12:00:06Z";
        j.dead_letter_reason = String(values[2]);
        return { rowCount: 1, rows: [] };
      }

      // failJob -> failed
      if (/set\s+status\s*=\s*'failed'/i.test(trimmed)) {
        const j = jobs.get(String(values[0]));
        if (!j) return { rowCount: 0, rows: [] };
        j.status = "failed";
        j.finished_at = "2026-11-11T12:00:06Z";
        j.last_error = String(values[1]);
        return { rowCount: 1, rows: [] };
      }

      // requeueDueFailures
      if (/where\s+status\s*=\s*'failed'/i.test(trimmed)) {
        const due = [...jobs.values()].filter((j) => j.status === "failed" && j.attempts < j.max_attempts);
        for (const j of due) {
          j.status = "queued";
          j.finished_at = null;
        }
        return { rowCount: due.length, rows: due.map((j) => ({ id: j.id })) };
      }

      // replayDeadLetter
      if (/where\s+id\s*=\s*\$1\s+and\s+status\s*=\s*'dead_letter'/i.test(trimmed)) {
        const j = jobs.get(String(values[0]));
        if (!j || j.status !== "dead_letter") return { rowCount: 0, rows: [] };
        j.status = "queued";
        j.attempts = 0;
        j.finished_at = null;
        j.dead_lettered_at = null;
        j.dead_letter_reason = null;
        return { rowCount: 1, rows: [{ id: j.id }] };
      }

      // reapStuckJobs
      if (/where\s+status\s*=\s*'running'/i.test(trimmed)) {
        const running = [...jobs.values()].filter((j) => j.status === "running");
        for (const j of running) {
          j.status = "queued";
          j.last_error = "İşçi yanıt vermedi, iş kuyruğa geri alındı";
        }
        return { rowCount: running.length, rows: running.map((j) => ({ id: j.id })) };
      }
    }

    if (/insert\s+into\s+public\.background_jobs/i.test(trimmed)) {
      seq += 1;
      const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
      const row: StoredJob = {
        id,
        job_type: String(values[0]),
        payload: JSON.parse(String(values[1])) as Record<string, unknown>,
        result: null,
        priority: Number(values[2]),
        dedupe_key: (values[3] as string | null) ?? null,
        attempts: 0,
        max_attempts: Number(values[4]),
        next_run_at: "2026-11-11T12:00:00Z",
        started_at: null,
        finished_at: null,
        last_error: null,
        progress_total: null,
        progress_done: 0,
        dead_lettered_at: null,
        dead_letter_reason: null,
        created_by: (values[5] as string | null) ?? null,
        created_at: "2026-11-11T12:00:00Z",
        status: "queued",
      };
      jobs.set(id, row);
      return { rowCount: 1, rows: [{ ...row }] };
    }

    if (/select\s+attempts,\s*max_attempts\s+from\s+public\.background_jobs/i.test(trimmed)) {
      const j = jobs.get(String(values[0]));
      if (!j || j.status !== "running") return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ attempts: j.attempts, max_attempts: j.max_attempts }] };
    }

    if (/where\s+dedupe_key\s*=\s*\$1/i.test(trimmed)) {
      const found = [...jobs.values()].find(
        (j) => j.dedupe_key === values[0] && ["queued", "running", "failed"].includes(j.status),
      );
      return found ? { rowCount: 1, rows: [{ ...found }] } : { rowCount: 0, rows: [] };
    }

    if (/coalesce\(result,\s*payload\s*->\s*'result'\)\s+as\s+result/i.test(trimmed)) {
      const j = jobs.get(String(values[0]));
      if (!j || j.job_type !== values[1]) return { rowCount: 0, rows: [] };
      if (!values[3] && j.created_by !== values[2]) return { rowCount: 0, rows: [] };
      const legacyResult = (j.payload.result as Record<string, unknown> | undefined) ?? null;
      return {
        rowCount: 1,
        rows: [{
          id: j.id,
          job_type: j.job_type,
          status: j.status,
          progress_done: j.progress_done,
          progress_total: j.progress_total,
          last_error: j.last_error,
          created_at: j.created_at,
          finished_at: j.finished_at,
          result: j.result ?? legacyResult,
        }],
      };
    }

    if (/,\s*result\s+from\s+public\.background_jobs\s+where\s+id\s*=\s*\$1/i.test(trimmed)) {
      const j = jobs.get(String(values[0]));
      return j ? { rowCount: 1, rows: [{ ...j }] } : { rowCount: 0, rows: [] };
    }

    if (/payload\s*-\s*'result'\s+as\s+payload/i.test(trimmed)) {
      const list = [...jobs.values()].slice(0, Number(values[0] ?? 100)).map((j) => {
        const restPayload = { ...j.payload };
        delete restPayload.result;
        return {
          id: j.id,
          job_type: j.job_type,
          status: j.status,
          priority: j.priority,
          attempts: j.attempts,
          max_attempts: j.max_attempts,
          payload: restPayload,
          progress_done: j.progress_done,
          progress_total: j.progress_total,
          last_error: j.last_error,
          dead_letter_reason: j.dead_letter_reason,
          created_at: j.created_at,
          next_run_at: j.next_run_at,
        };
      });
      return { rowCount: list.length, rows: list };
    }

    throw new Error(`Beklenmeyen SQL: ${trimmed}`);
  };

  const client = {
    query: execQuery,
    release() {},
  };

  const pool = {
    async connect() {
      return client;
    },
    query: execQuery,
  };

  return { pool: pool as never, rawQuery: execQuery, jobs, audits };
}

describe("0108 tetikleyici simülasyonu — zarf değişmezliği altında tam kuyruk yaşam döngüsü", () => {
  const ACTOR = "11111111-1111-4111-8111-111111111111";
  const SYSTEM = "99999999-9999-4999-8999-999999999999";

  it("zarf kolonlarına (payload/created_by/job_type/dedupe_key/created_at) yapılan her UPDATE 23514 ile reddedilir", async () => {
    const { pool, rawQuery } = createImmutabilityEnforcingMockPool();
    const { job } = await enqueueJob(
      pool,
      { jobType: "excel_import", payload: { filename: "test.xlsx" }, dedupeKey: "dk-1" },
      ACTOR,
    );

    const forbiddenUpdates = [
      `update public.background_jobs set payload = '{"evil":1}'::jsonb where id = $1`,
      `update public.background_jobs set created_by = null where id = $1`,
      `update public.background_jobs set job_type = 'report_generation' where id = $1`,
      `update public.background_jobs set dedupe_key = 'dk-2' where id = $1`,
      `update public.background_jobs set created_at = now() where id = $1`,
    ];

    for (const sql of forbiddenUpdates) {
      await expect(rawQuery(sql, [job.id])).rejects.toMatchObject({
        code: "23514",
        message: "background_jobs_envelope_immutable",
      });
    }
  });

  it("completeJob sonucu ayrı `result` kolonuna yazar; payload zarfı hiç değişmez ve listJobs sonucu taşımaz", async () => {
    const { pool, jobs, audits } = createImmutabilityEnforcingMockPool();
    const originalPayload = {
      filename: "büyük.xlsx",
      fileSha256: "a".repeat(64),
      stagedFile: "22222222-2222-4222-8222-222222222222",
    };

    const { job } = await enqueueJob(
      pool,
      { jobType: "excel_import", payload: originalPayload, priority: 50, dedupeKey: "dk-v2" },
      ACTOR,
    );
    const claimed = await claimNextJob(pool, ["excel_import"], SYSTEM);
    expect(claimed?.id).toBe(job.id);

    await reportProgress(pool, job.id, 2, 3);
    await completeJob(pool, job.id, SYSTEM, { counters: { create: 9, reject: 0 } });

    const stored = jobs.get(job.id)!;
    expect(stored.status).toBe("succeeded");
    expect(stored.payload).toEqual(originalPayload);
    expect(stored.result).toEqual({ counters: { create: 9, reject: 0 } });

    const loaded = await loadJobWithResult(pool, job.id);
    expect(loaded?.result).toEqual({ counters: { create: 9, reject: 0 } });
    expect(loaded?.payload).toEqual(originalPayload);

    const listed = await listJobs(pool, 20);
    expect(listed).toHaveLength(1);
    expect(listed[0].payload).toEqual(originalPayload);
    expect("result" in listed[0]).toBe(false);

    const previewStatus = await getAsyncPreviewJobStatus(pool, job.id, { id: ACTOR, seeAll: false });
    expect(previewStatus?.previewReport).toEqual({ counters: { create: 9, reject: 0 } });

    const completeAudit = audits.find((a) => a.action === "complete_job");
    expect(completeAudit).toEqual({
      actor: SYSTEM,
      action: "complete_job",
      after: { automated: true, resultStored: true },
    });
  });

  it("failJob, requeueDueFailures, reapStuckJobs ve replayDeadLetter zarf kilidine çarpmadan çalışır", async () => {
    const { pool } = createImmutabilityEnforcingMockPool();
    const { job } = await enqueueJob(
      pool,
      { jobType: "report_generation", payload: { scope: "daily" }, maxAttempts: 3 },
      ACTOR,
    );

    await claimNextJob(pool, ["report_generation"], SYSTEM);
    const f1 = await failJob(pool, job.id, "geçici hata", SYSTEM, false);
    expect(f1?.status).toBe("failed");

    expect(await requeueDueFailures(pool)).toBe(1);
    await claimNextJob(pool, ["report_generation"], SYSTEM);
    expect(await reapStuckJobs(pool, 30)).toBe(1);

    await claimNextJob(pool, ["report_generation"], SYSTEM);
    const f2 = await failJob(pool, job.id, "kalıcı hata", SYSTEM, true);
    expect(f2?.status).toBe("dead_letter");

    expect(await replayDeadLetter(pool, job.id, ACTOR)).toBe(true);
  });
});
