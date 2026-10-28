import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  getPool: vi.fn(),
  refreshMetricSnapshots: vi.fn(),
}));

vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: mocks.enqueueJob,
  claimNextJob: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  reportProgress: vi.fn(),
}));

vi.mock("@/lib/analytics/snapshots", () => ({
  refreshMetricSnapshots: mocks.refreshMetricSnapshots,
}));

import { enqueueAsyncWorkbookImport, getAsyncImportJobStatus } from "./async-runner";

describe("Standart Import V2 — Asenkron Kuyruk Yöneticisi", () => {
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("geçersiz dosya uzantısını kuyruğa almadan reddeder", async () => {
    const res = await enqueueAsyncWorkbookImport(
      pool,
      Buffer.from("dummy"),
      "test.pdf",
      "user-1",
      "admin",
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rejection.code).toBe("BAD_EXTENSION");
    }
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it("boş dosyayı kuyruğa almadan reddeder", async () => {
    const res = await enqueueAsyncWorkbookImport(
      pool,
      Buffer.alloc(0),
      "test.xlsx",
      "user-1",
      "admin",
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rejection.code).toBe("EMPTY_FILE");
    }
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it("geçerli XLSX dosyasını sahneleyip background_jobs kuyruğuna yazar", async () => {
    mocks.enqueueJob.mockResolvedValue({
      job: {
        id: "job-12345",
        status: "queued",
      },
      created: true,
    });

    const buf = Buffer.from("PK fake xlsx content");
    const res = await enqueueAsyncWorkbookImport(
      pool,
      buf,
      "satislar.xlsx",
      "user-1",
      "admin",
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.jobId).toBe("job-12345");
      expect(res.result.status).toBe("queued");
      expect(res.result.filename).toBe("satislar.xlsx");
      expect(res.result.sha256).toHaveLength(64);
    }
    expect(mocks.enqueueJob).toHaveBeenCalledOnce();
  });

  it("getAsyncImportJobStatus mevcut iş durumunu döndürür", async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          id: "job-12345",
          job_type: "excel_import",
          status: "running",
          progress_done: 30,
          progress_total: 100,
          last_error: null,
          created_at: "2026-10-16 04:00:00",
          finished_at: null,
        },
      ],
    });

    const testPool = { query: mockQuery } as never;
    const status = await getAsyncImportJobStatus(testPool, "job-12345");

    expect(status).not.toBeNull();
    expect(status?.id).toBe("job-12345");
    expect(status?.status).toBe("running");
    expect(status?.progressPercent).toBe(30);
  });
});
