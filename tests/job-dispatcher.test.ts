import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatcher } from "@/lib/jobs/dispatcher";
import * as queue from "@/lib/jobs/queue";

vi.mock("@/lib/jobs/queue", () => ({
  claimNextJob: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  reportProgress: vi.fn(),
}));

// Wave 0: the dispatcher no longer drops cache tags after a job (the in-process read cache was
// removed), so these cases cover only the claim → run → complete/fail flow it keeps — plus the two
// properties S6 added: the actor must be a real uuid (audit_logs.actor is a users FK), and only a
// HANDLER failure may call failJob.
const SYSTEM_ACTOR = "5f3c2a10-9b7e-4d21-8c44-0a1b2c3d4e5f";

function runningJob(id: string, jobType: queue.JobRow["jobType"]): queue.JobRow {
  return {
    id,
    jobType,
    status: "running",
    priority: 100,
    attempts: 1,
    maxAttempts: 5,
    payload: {},
    progressDone: 0,
    progressTotal: 10,
    progressPercent: 0,
    lastError: null,
    deadLetterReason: null,
    createdAt: new Date().toISOString(),
    nextRunAt: new Date().toISOString(),
  };
}

describe("Background Job Dispatcher", () => {
  const dummyPool = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
    dispatcher.clearHandlers();
  });

  describe("aktör — rezerve 'system' hesabının uuid'si, zorunlu", () => {
    // The first value is the layer's old default, built from parts so the Wave 0 leftover grep
    // (which forbids that literal anywhere in the tree) does not match this regression test.
    for (const bad of ["worker" + "-daemon", "", "system", "00000000-0000-0000-0000-00000000000g"]) {
      it(`'${bad}' kuyruğa dokunmadan reddedilir`, async () => {
        dispatcher.register("fx_rate_sync", async () => ({ success: true }));
        await expect(dispatcher.processNext(dummyPool, bad)).rejects.toThrow(/aktör/);
        await expect(dispatcher.processBatch(dummyPool, bad, 3)).rejects.toThrow(/aktör/);
        expect(queue.claimNextJob).not.toHaveBeenCalled();
      });
    }

    it("null (tip dışı çağrı) de reddedilir — 'kimse' bir denetim aktörü değil", async () => {
      dispatcher.register("fx_rate_sync", async () => ({ success: true }));
      await expect(dispatcher.processNext(dummyPool, null as unknown as string)).rejects.toThrow(/aktör/);
      expect(queue.claimNextJob).not.toHaveBeenCalled();
    });

    it("geçerli uuid claim/complete satırlarının aktörü olur", async () => {
      dispatcher.register("fx_rate_sync", async () => ({ success: true }));
      vi.mocked(queue.claimNextJob).mockResolvedValueOnce(runningJob("job-1", "fx_rate_sync"));

      await dispatcher.processNext(dummyPool, SYSTEM_ACTOR);

      expect(queue.claimNextJob).toHaveBeenCalledWith(dummyPool, ["fx_rate_sync"], SYSTEM_ACTOR);
      expect(queue.completeJob).toHaveBeenCalledWith(dummyPool, "job-1", SYSTEM_ACTOR);
    });
  });

  it("handler kaydı yoksa kuyruk hiç sorgulanmaz", async () => {
    const result = await dispatcher.processNext(dummyPool, SYSTEM_ACTOR);
    expect(result.processed).toBe(false);
    expect(queue.claimNextJob).not.toHaveBeenCalled();
  });

  it("yalnız handler'ı KAYITLI türler sahiplenilir", async () => {
    dispatcher.register("fx_rate_sync", async () => ({ success: true }));
    dispatcher.register("report_generation", async () => ({ success: true }));
    vi.mocked(queue.claimNextJob).mockResolvedValueOnce(null);

    await dispatcher.processNext(dummyPool, SYSTEM_ACTOR);

    const [, types] = vi.mocked(queue.claimNextJob).mock.calls[0];
    expect([...(types ?? [])].sort()).toEqual(["fx_rate_sync", "report_generation"]);
  });

  it("kayıtlı handler olduğunda ama kuyruk boşken processed: false döner", async () => {
    dispatcher.register("fx_rate_sync", async () => ({ success: true }));
    vi.mocked(queue.claimNextJob).mockResolvedValueOnce(null);

    const result = await dispatcher.processNext(dummyPool, SYSTEM_ACTOR);
    expect(result.processed).toBe(false);
    expect(queue.claimNextJob).toHaveBeenCalled();
  });

  it("kayıtlı handler çalıştığında ilerlemeyi raporlar ve işi tamamlar", async () => {
    dispatcher.register("fx_rate_sync", async (ctx) => {
      await ctx.reportProgress(10, 10);
      return { success: true };
    });
    vi.mocked(queue.claimNextJob).mockResolvedValueOnce(runningJob("job-101", "fx_rate_sync"));

    const result = await dispatcher.processNext(dummyPool, SYSTEM_ACTOR);

    expect(result.processed).toBe(true);
    expect(result.status).toBe("succeeded");
    expect(queue.completeJob).toHaveBeenCalledWith(dummyPool, "job-101", SYSTEM_ACTOR);
    expect(queue.reportProgress).toHaveBeenCalledWith(dummyPool, "job-101", 10, 10);
    expect(queue.failJob).not.toHaveBeenCalled();
  });

  it("handler hata fırlattığında failJob çağrılır ve status: failed döner", async () => {
    dispatcher.register("excel_import", async () => {
      throw new Error("Bozuk Excel formatı");
    });
    vi.mocked(queue.claimNextJob).mockResolvedValueOnce(runningJob("job-102", "excel_import"));

    const result = await dispatcher.processNext(dummyPool, SYSTEM_ACTOR);

    expect(result.processed).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Bozuk Excel formatı");
    expect(queue.failJob).toHaveBeenCalledWith(dummyPool, "job-102", "Bozuk Excel formatı", SYSTEM_ACTOR);
    expect(queue.completeJob).not.toHaveBeenCalled();
  });

  it("handler success:false döndürürse failJob çağrılır, completeJob çağrılmaz", async () => {
    dispatcher.register("report_generation", async () => ({ success: false }));
    vi.mocked(queue.claimNextJob).mockResolvedValueOnce(runningJob("job-103", "report_generation"));

    const result = await dispatcher.processNext(dummyPool, SYSTEM_ACTOR);

    expect(result.status).toBe("failed");
    expect(queue.failJob).toHaveBeenCalledWith(dummyPool, "job-103", "İş başarısız olarak raporlandı.", SYSTEM_ACTOR);
    expect(queue.completeJob).not.toHaveBeenCalled();
  });

  it("handler başarılıysa completeJob'un HATASI failJob'a dönmez — yukarı çıkar", async () => {
    // The layer kept handler and completeJob in one try: a completion failure after real work was
    // recorded as a FAILED job and retried after backoff, i.e. finished work ran twice.
    const ran = vi.fn(async () => ({ success: true }));
    dispatcher.register("fx_rate_sync", ran);
    vi.mocked(queue.claimNextJob).mockResolvedValueOnce(runningJob("job-104", "fx_rate_sync"));
    vi.mocked(queue.completeJob).mockRejectedValueOnce(new Error("bağlantı koptu"));

    await expect(dispatcher.processNext(dummyPool, SYSTEM_ACTOR)).rejects.toThrow("bağlantı koptu");

    expect(ran).toHaveBeenCalledTimes(1);
    expect(queue.failJob).not.toHaveBeenCalled();
  });

  it("processBatch aktörü her işe taşır ve kuyruk boşalınca durur", async () => {
    dispatcher.register("fx_rate_sync", async () => ({ success: true }));
    vi.mocked(queue.claimNextJob)
      .mockResolvedValueOnce(runningJob("job-a", "fx_rate_sync"))
      .mockResolvedValueOnce(runningJob("job-b", "fx_rate_sync"))
      .mockResolvedValueOnce(null);

    const results = await dispatcher.processBatch(dummyPool, SYSTEM_ACTOR, 10);

    expect(results.map((r) => r.jobId)).toEqual(["job-a", "job-b"]);
    expect(queue.claimNextJob).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(queue.claimNextJob).mock.calls) expect(call[2]).toBe(SYSTEM_ACTOR);
  });
});
