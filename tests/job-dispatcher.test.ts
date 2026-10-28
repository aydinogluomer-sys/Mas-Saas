import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatcher } from "@/lib/jobs/dispatcher";
import * as queue from "@/lib/jobs/queue";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";

vi.mock("@/lib/jobs/queue", () => ({
  claimNextJob: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  reportProgress: vi.fn(),
}));

describe("Background Job Dispatcher & Cache Invalidation", () => {
  const dummyPool = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
    dispatcher.clearHandlers();
  });

  it("kayıtlı handler olduğunda ama kuyruk boşken processed: false döner", async () => {
    dispatcher.register("fx_rate_sync", async () => ({ success: true }));
    vi.mocked(queue.claimNextJob).mockResolvedValueOnce(null);

    const result = await dispatcher.processNext(dummyPool, "test-actor");
    expect(result.processed).toBe(false);
    expect(queue.claimNextJob).toHaveBeenCalled();
  });

  it("kayıtlı handler çalıştığında işi tamamlar ve ilişkili cache tag'lerini invalidate eder", async () => {
    const mockJob: queue.JobRow = {
      id: "job-101",
      jobType: "fx_rate_sync",
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

    dispatcher.register("fx_rate_sync", async (ctx) => {
      await ctx.reportProgress(10, 10);
      return { success: true, cacheTagsToInvalidate: [CACHE_TAGS.FX_RATES] };
    });

    vi.mocked(queue.claimNextJob).mockResolvedValueOnce(mockJob);

    // Cache'e bir döviz değeri koyalım
    await cache.set("fx:usd", { rate: 38.5 }, { tags: [CACHE_TAGS.FX_RATES] });
    expect(await cache.get("fx:usd")).toEqual({ rate: 38.5 });

    const result = await dispatcher.processNext(dummyPool, "test-actor");

    expect(result.processed).toBe(true);
    expect(result.status).toBe("succeeded");
    expect(queue.completeJob).toHaveBeenCalledWith(dummyPool, "job-101", "test-actor");
    expect(queue.reportProgress).toHaveBeenCalledWith(dummyPool, "job-101", 10, 10);

    // İş tamamlandıktan sonra döviz cache'i otomatik silinmiş olmalı
    expect(await cache.get("fx:usd")).toBeNull();
  });

  it("handler hata fırlattığında failJob çağrılır ve status: failed döner", async () => {
    const mockJob: queue.JobRow = {
      id: "job-102",
      jobType: "excel_import",
      status: "running",
      priority: 100,
      attempts: 1,
      maxAttempts: 3,
      payload: {},
      progressDone: 0,
      progressTotal: 100,
      progressPercent: 0,
      lastError: null,
      deadLetterReason: null,
      createdAt: new Date().toISOString(),
      nextRunAt: new Date().toISOString(),
    };

    dispatcher.register("excel_import", async () => {
      throw new Error("Bozuk Excel formatı");
    });

    vi.mocked(queue.claimNextJob).mockResolvedValueOnce(mockJob);

    const result = await dispatcher.processNext(dummyPool, "test-actor");

    expect(result.processed).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Bozuk Excel formatı");
    expect(queue.failJob).toHaveBeenCalledWith(dummyPool, "job-102", "Bozuk Excel formatı", "test-actor");
  });
});
