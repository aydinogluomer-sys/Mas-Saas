// Faz 33 / Faz 57 (0108) — queue result column & immutable envelope contract, pinned without a DB.
//
// Migration 0108 moved finished job results out of `payload.result` into the dedicated
// `background_jobs.result` (`jsonb`) column and locked `payload` with
// `enforce_background_jobs_immutable_envelope`. `completeJob()` must write `result = $2::jsonb` in
// the same atomic UPDATE that marks the job `'succeeded'`, never mutating `payload`, while the
// audit row records only that a result was stored. `listJobs()` omits `result` and defensively
// strips any legacy `payload.result`. `loadJobWithResult()` / `extractJobResult()` read `row.result`
// first with a defensive fallback to `row.payload.result`.
import { describe, expect, it } from "vitest";
import {
  JOB_RESULT_KEY,
  completeJob,
  extractJobResult,
  listJobs,
  loadJobWithResult,
} from "./queue";

interface Call { text: string; values?: unknown[] }

function fakePool(rowCount = 1, queryRows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return { rows: [{ id: "x" }], rowCount };
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return { rows: queryRows, rowCount: queryRows.length };
    },
  };
  return { pool: pool as never, calls };
}

const JOB = "33333333-3333-4333-8333-333333333333";

describe("completeJob — sonuç ayrı `result` kolonuna, durum değişikliğiyle AYNI güncellemede", () => {
  it("sonuç verilirse result = $2::jsonb yazılır ve payload'a DOKUNULMAZ; denetim yalnız 'saklandı' der", async () => {
    const { pool, calls } = fakePool();
    await completeJob(pool, JOB, null, { counters: { create: 1 } });

    const update = calls.find((c) => c.text.includes("update public.background_jobs"))!;
    expect(update.text).toMatch(/set status = 'succeeded'/);
    expect(update.text).toMatch(/result = \$2::jsonb/);
    expect(update.text).not.toMatch(/payload/);
    expect(update.text).toMatch(/where id = \$1 and status = 'running'/);
    expect(update.values).toEqual([JOB, JSON.stringify({ counters: { create: 1 } })]);

    const auditRow = calls.find((c) => c.text.includes("audit_logs"))!;
    const after = JSON.parse(String(auditRow.values![5]));
    expect(after).toEqual({ automated: true, resultStored: true });
    expect(JSON.stringify(auditRow.values)).not.toContain("counters");

    expect(calls.map((c) => c.text.trim().split(/\s+/)[0])).toEqual(["begin", "update", "insert", "commit"]);
  });

  it("sonuçsuz çağrı eskisiyle birebir: ne payload'a ne result'a dokunur, denetim { automated: true }", async () => {
    const { pool, calls } = fakePool();
    await completeJob(pool, JOB, null);

    const update = calls.find((c) => c.text.includes("update public.background_jobs"))!;
    expect(update.text).not.toMatch(/payload/);
    expect(update.text).not.toMatch(/result/);
    expect(update.values).toEqual([JOB]);
    const auditRow = calls.find((c) => c.text.includes("audit_logs"))!;
    expect(JSON.parse(String(auditRow.values![5]))).toEqual({ automated: true });
  });

  it("iş 'running' değilse hiçbir şey yazılmaz (denetim satırı da yok)", async () => {
    const { pool, calls } = fakePool(0);
    await completeJob(pool, JOB, null, { a: 1 });
    expect(calls.some((c) => c.text.includes("audit_logs"))).toBe(false);
  });
});

describe("listJobs — saklanan sonuç kuyruk ekranına taşınmaz", () => {
  it("result kolonunu seçmez ve eski payload.result anahtarını savunma amaçlı dışarıda bırakır", async () => {
    const { pool, calls } = fakePool();
    await listJobs(pool, 10);
    expect(calls[0].text).toContain(`payload - '${JOB_RESULT_KEY}' as payload`);
    expect(calls[0].text).not.toMatch(/,\s*result\b/);
    expect(calls[0].text).not.toMatch(/max_attempts, payload,/);
  });
});

describe("loadJobWithResult & extractJobResult — birincil `result` kolonu + savunma amaçlı `payload.result` yedeği", () => {
  const baseDbRow = {
    id: JOB,
    job_type: "excel_import",
    status: "succeeded",
    priority: 50,
    attempts: 1,
    max_attempts: 3,
    payload: { filename: "a.xlsx" },
    progress_done: 3,
    progress_total: 3,
    last_error: null,
    dead_letter_reason: null,
    created_at: "2026-11-11T10:00:00Z",
    next_run_at: "2026-11-11T10:00:00Z",
  };

  it("extractJobResult önce row.result kolonunu okur, null ise eski row.payload.result yedeğine düşer", () => {
    expect(
      extractJobResult({ result: { primary: 1 }, payload: { result: { legacy: 2 } } }),
    ).toEqual({ primary: 1 });
    expect(
      extractJobResult({ result: null, payload: { filename: "a.xlsx", result: { legacy: 2 } } }),
    ).toEqual({ legacy: 2 });
    expect(extractJobResult({ result: null, payload: { filename: "a.xlsx" } })).toBeNull();
  });

  it("loadJobWithResult hem yeni `result` kolonunu hem eski `payload.result` satırını çözer", async () => {
    const primaryPool = fakePool(1, [{ ...baseDbRow, result: { rows: 12 } }]);
    const loadedPrimary = await loadJobWithResult(primaryPool.pool, JOB);
    expect(primaryPool.calls[0].text).toMatch(/,\s*result\s+from\s+public\.background_jobs/i);
    expect(loadedPrimary?.result).toEqual({ rows: 12 });

    const legacyPool = fakePool(1, [{
      ...baseDbRow,
      payload: { filename: "a.xlsx", result: { rows: 7 } },
      result: null,
    }]);
    const loadedLegacy = await loadJobWithResult(legacyPool.pool, JOB);
    expect(loadedLegacy?.result).toEqual({ rows: 7 });

    const emptyPool = fakePool(0, []);
    expect(await loadJobWithResult(emptyPool.pool, JOB)).toBeNull();
  });
});
