// Wave 0 — the two queue changes the async Import V2 preview needs, pinned without a database.
//
// completeJob() may now carry a RESULT (the stored preview report). It must be written in the same
// UPDATE that marks the job succeeded — a job is never 'succeeded' without it, nor the reverse —
// and the audit row must record only that a result was stored, never the report itself. The
// result-less call must stay exactly what it was. listJobs() must not drag stored reports into
// the queue screen.
import { describe, expect, it } from "vitest";
import { JOB_RESULT_KEY, completeJob, listJobs } from "./queue";

interface Call { text: string; values?: unknown[] }

function fakePool(rowCount = 1) {
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
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as never, calls };
}

const JOB = "33333333-3333-4333-8333-333333333333";

describe("completeJob — sonuç, durum değişikliğiyle AYNI güncellemede", () => {
  it("sonuç verilirse payload'a JOB_RESULT_KEY altında birleştirilir; denetim yalnız 'saklandı' der", async () => {
    const { pool, calls } = fakePool();
    await completeJob(pool, JOB, null, { counters: { create: 1 } });

    const update = calls.find((c) => c.text.includes("update public.background_jobs"))!;
    expect(update.text).toMatch(/set status = 'succeeded'/);
    expect(update.text).toMatch(/payload = payload \|\| jsonb_build_object\(\$2::text, \$3::jsonb\)/);
    expect(update.text).toMatch(/where id = \$1 and status = 'running'/);
    expect(update.values).toEqual([JOB, JOB_RESULT_KEY, JSON.stringify({ counters: { create: 1 } })]);

    const auditRow = calls.find((c) => c.text.includes("audit_logs"))!;
    const after = JSON.parse(String(auditRow.values![5]));
    expect(after).toEqual({ automated: true, resultStored: true });
    expect(JSON.stringify(auditRow.values)).not.toContain("counters");

    expect(calls.map((c) => c.text.trim().split(/\s+/)[0])).toEqual(["begin", "update", "insert", "commit"]);
  });

  it("sonuçsuz çağrı eskisiyle birebir: payload'a dokunmaz, denetim { automated: true }", async () => {
    const { pool, calls } = fakePool();
    await completeJob(pool, JOB, null);

    const update = calls.find((c) => c.text.includes("update public.background_jobs"))!;
    expect(update.text).not.toMatch(/payload/);
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
  it("payload, sonuç anahtarı çıkarılmış olarak seçilir", async () => {
    const { pool, calls } = fakePool();
    await listJobs(pool, 10);
    expect(calls[0].text).toContain(`payload - '${JOB_RESULT_KEY}' as payload`);
    expect(calls[0].text).not.toMatch(/max_attempts, payload,/);
  });
});
