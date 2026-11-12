import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  runAsUser: vi.fn((_user: unknown, fn: () => Promise<unknown>) => fn()),
}));
import {
  TELEGRAM_MAX_MESSAGE_CHARS,
  pollTelegramUpdates,
  redactBotToken,
  sendTelegramChatMessage,
  splitTelegramMessage,
  type TelegramUpdate,
} from "@/lib/reminders/transport";
import { JobDispatcher } from "@/lib/jobs/dispatcher";
import {
  acquireSingleInstanceLock,
  createUnauthorizedRateLimiter,
  processTelegramUpdatesBatch,
  readTelegramOffset,
  runTelegramWorkerCycle,
  writeTelegramOffsetAtomic,
} from "../../scripts/ops/telegram-assistant-worker";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "mas-faz42-ops-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Faz 42 (B2) — splitTelegramMessage & Telegram transport", () => {
  it("4096 karakter sınırını aşan raporları satır/paragraf sınırlarından kayıpsız böler", () => {
    const lines = Array.from(
      { length: 180 },
      (_, idx) => `• 2026-11-01 — FAT-${String(idx + 1).padStart(4, "0")}: ₺12.450,00 satış faturası (alacak)`,
    );
    const hugeMessage = ["Akon Endüstri — kapsamlı hareket dökümü", "", ...lines].join("\n");
    expect(hugeMessage.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE_CHARS * 2);

    const chunks = splitTelegramMessage(hugeMessage, 4000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
    }

    const joined = chunks.join("\n");
    expect(joined).toContain("FAT-0001");
    expect(joined).toContain("FAT-0090");
    expect(joined).toContain("FAT-0180");
  });

  it("sendTelegramChatMessage uzun mesajı parçalı gönderir ve hata metninde bot token'ı maskeler", async () => {
    const sentBodies: Array<{ chat_id: string; text: string }> = [];
    const fakeFetch: typeof fetch = (async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const longText = "A".repeat(3800) + "\n" + "B".repeat(3800);
    const okRes = await sendTelegramChatMessage("777001", longText, {
      token: "123456:SECRET_TOKEN_XYZ",
      fetchImpl: fakeFetch,
      maxLen: 4000,
    });

    expect(okRes.ok).toBe(true);
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0].chat_id).toBe("777001");
    expect(sentBodies[0].text.length).toBe(3800);
    expect(sentBodies[1].text.length).toBe(3800);

    const failingFetch: typeof fetch = (async (url) => {
      throw new Error(`Bağlantı koptu: ${String(url)}`);
    }) as typeof fetch;

    const errRes = await sendTelegramChatMessage("777001", "Merhaba", {
      token: "123456:SECRET_TOKEN_XYZ",
      fetchImpl: failingFetch,
    });
    expect(errRes.ok).toBe(false);
    expect(errRes.error).toContain("bot[REDACTED]");
    expect(errRes.error).not.toContain("SECRET_TOKEN_XYZ");
  });

  it("pollTelegramUpdates bekleyen güncellemeleri drop etmeden verilen offset ile okur", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fakeFetch: typeof fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 501,
              message: { message_id: 9, chat: { id: 4242, type: "private" }, text: "/cari Akon" },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const polled = await pollTelegramUpdates(501, 20, undefined, {
      token: "999:TEST_TOKEN",
      fetchImpl: fakeFetch,
    });

    expect(polled.ok).toBe(true);
    expect(capturedBody).toEqual({
      offset: 501,
      timeout: 20,
      allowed_updates: ["message"],
    });
    if (polled.ok) {
      expect(polled.updates).toHaveLength(1);
      expect(polled.updates[0].update_id).toBe(501);
      expect(polled.updates[0].message?.text).toBe("/cari Akon");
    }
    expect(redactBotToken("https://api.telegram.org/bot999:TEST_TOKEN/getUpdates")).not.toContain("TEST_TOKEN");
  });
});

describe("Faz 42 (B2) — Telegram işçisi: yetkisiz chat_id sessiz düşürme, ofset devamlılığı ve tek-örnek kilidi", () => {
  it("yetkisiz chat_id mesajlarına SIFIR dış HTTP yanıtı gönderir ve hız-sınırlı denetim sayacı üretir", async () => {
    const offsetPath = path.join(tempDir, "telegram-offset.json");
    const sendReply = vi.fn().mockResolvedValue({ ok: true });
    const answerReadOnly = vi.fn().mockResolvedValue({
      kind: "receivable_total",
      answer: "Toplam açık alacak (yalnız TRY): ₺1.250.000",
    });
    const unauthLogs: Array<{ chatHash: string; windowDropped: number; totalDropped: number }> = [];

    const updates: TelegramUpdate[] = [
      { update_id: 100, message: { message_id: 1, chat: { id: "999001" }, text: "/cari Gizli" } },
      { update_id: 101, message: { message_id: 2, chat: { id: "999002" }, text: "Toplam açık alacak" } },
      { update_id: 102, message: { message_id: 3, chat: { id: 999003 }, text: "Merhaba" } },
      { update_id: 103, message: { message_id: 4, chat: { id: "777888" }, text: "Toplam açık alacak ne kadar?" } },
      { update_id: 104, message: { message_id: 5, chat: { id: "999004" }, text: "/hareket Akon" } },
    ];

    const limiter = createUnauthorizedRateLimiter(60_000);
    const res = await processTelegramUpdatesBatch(
      updates,
      100,
      {
        allowedChatId: "777888",
        offsetPath,
        todayISO: () => "2026-11-01",
        answerReadOnly,
        sendReply,
        onUnauthorizedDrop: (info) => {
          unauthLogs.push(info);
        },
      },
      limiter,
    );

    expect(res.unauthorizedDropped).toBe(4);
    expect(res.answered).toBe(1);
    expect(res.haltedOnSendError).toBe(false);
    expect(res.nextOffset).toBe(105);

    // CRITICAL: Zero replies sent to any unauthorized chat_id!
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith("777888", "Toplam açık alacak (yalnız TRY): ₺1.250.000");
    expect(answerReadOnly).toHaveBeenCalledTimes(1);

    // Rate-limited audit emission: 4 unauthorized messages inside 60s window emit only 1 log entry.
    expect(unauthLogs).toHaveLength(1);
    expect(unauthLogs[0].totalDropped).toBe(1);
    expect(await readTelegramOffset(offsetPath)).toBe(105);
  });

  it("atomik ofset dosyasından kaldığı yerden devam eder; gönderim hatasında ofseti ilerletmeyip mesajı korur", async () => {
    const offsetPath = path.join(tempDir, "offset.json");
    await writeTelegramOffsetAtomic(offsetPath, 310);
    expect(await readTelegramOffset(offsetPath)).toBe(310);

    let failOutbound = true;
    const polledOffsets: number[] = [];

    const deps = {
      allowedChatId: "555111",
      offsetPath,
      todayISO: () => "2026-11-01",
      pollUpdates: async (offset: number) => {
        polledOffsets.push(offset);
        return {
          ok: true as const,
          updates: [
            { update_id: 310, message: { message_id: 10, chat: { id: "555111" }, text: "/cari Akon" } },
            { update_id: 311, message: { message_id: 11, chat: { id: "555111" }, text: "/hareket Akon" } },
          ],
        };
      },
      answerReadOnly: async (msg: string) => ({ kind: "current_account" as const, answer: `Yanıt: ${msg}` }),
      sendReply: async () => (failOutbound ? { ok: false, error: "geçici ağ hatası" } : { ok: true }),
    };

    // First cycle fails to deliver update 310 -> offset MUST stay at 310.
    const first = await runTelegramWorkerCycle(deps, { timeoutSec: 0 });
    expect(first.haltedOnSendError).toBe(true);
    expect(first.answered).toBe(0);
    expect(await readTelegramOffset(offsetPath)).toBe(310);

    // Second cycle recovers -> resumes from 310 and processes both 310 and 311!
    failOutbound = false;
    const second = await runTelegramWorkerCycle(deps, { timeoutSec: 0 });
    expect(polledOffsets).toEqual([310, 310]);
    expect(second.haltedOnSendError).toBe(false);
    expect(second.answered).toBe(2);
    expect(second.nextOffset).toBe(312);
    expect(await readTelegramOffset(offsetPath)).toBe(312);
  });

  it("tek-örnek kilidi canlı ikinci süreci reddeder, ölü PID kilidini otomatik devralır", async () => {
    const lockPath = path.join(tempDir, "worker.lock");

    // Stale lock from dead PID 999999
    await writeFile(lockPath, JSON.stringify({ pid: 999999, startedAt: "2026-10-01T00:00:00Z" }), "utf8");
    const reclaimed = acquireSingleInstanceLock(lockPath, 1001, () => false);
    expect(existsSync(lockPath)).toBe(true);

    // Second live instance must be refused while PID 1001 is alive
    expect(() => acquireSingleInstanceLock(lockPath, 1002, (pid) => pid === 1001)).toThrow(
      /İşçi zaten çalışıyor/,
    );

    reclaimed.release();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("Faz 42 (B2) — JobDispatcher resultPayload kalıcılığı ve Import V2 kuyruk kurtarma", () => {
  it("JobDispatcher.processNext başarılı işleyicinin resultPayload çıktısını completeJob'a iletir (backlog #8)", async () => {
    const actorId = "99999999-9999-4999-8999-999999999999";
    const jobId = "33333333-3333-4333-8333-333333333333";

    const sqlCalls: Array<{ text: string; values?: unknown[] }> = [];
    const fakeClient = {
      async query(text: string, values?: unknown[]) {
        sqlCalls.push({ text, values });
        if (text.includes("for update skip locked")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: jobId,
                job_type: "report_generation",
                status: "running",
                priority: 100,
                payload: { scope: "daily" },
                dedupe_key: null,
                attempts: 1,
                max_attempts: 3,
                progress_done: 0,
                progress_total: null,
                next_run_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
                finished_at: null,
                last_error: null,
                dead_lettered_at: null,
                dead_letter_reason: null,
                created_by: actorId,
                created_at: new Date().toISOString(),
              },
            ],
          };
        }
        return { rowCount: 1, rows: [{ id: jobId }] };
      },
      release() {},
    };
    const fakePool = {
      async connect() {
        return fakeClient;
      },
      async query(text: string, values?: unknown[]) {
        sqlCalls.push({ text, values });
        return { rowCount: 1, rows: [] };
      },
    };

    const localDispatcher = new JobDispatcher();
    localDispatcher.register("report_generation", async ({ reportProgress }) => {
      await reportProgress(1, 1);
      return {
        success: true,
        resultPayload: { reportId: "rep-2026-11-01", generatedRows: 14 },
      };
    });

    const outcome = await localDispatcher.processNext(fakePool as never, actorId);
    expect(outcome.processed).toBe(true);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.resultPayload).toEqual({ reportId: "rep-2026-11-01", generatedRows: 14 });

    const completeUpdate = sqlCalls.find(
      (c) => c.text.includes("update public.background_jobs") && c.text.includes("status = 'succeeded'"),
    );
    expect(completeUpdate).toBeDefined();
    expect(completeUpdate?.text).toContain("result = $2::jsonb");
    expect(completeUpdate?.values).toEqual([
      jobId,
      JSON.stringify({ reportId: "rep-2026-11-01", generatedRows: 14 }),
    ]);
  });

  it("processPendingImportJobs geçici hatalı (failed) ve takılı (running) işleri claim öncesi kuyruğa döndürür (backlog #7)", async () => {
    const { processPendingImportJobs } = await import("../../scripts/ops/process-import-jobs");
    const actorId = "99999999-9999-4999-8999-999999999999";
    const executedSql: string[] = [];

    const fakeClient = {
      async query(text: string) {
        executedSql.push(text);
        // claimNextJob finds no queued jobs after requeue/reap
        return { rowCount: 0, rows: [] };
      },
      release() {},
    };
    const fakePool = {
      async connect() {
        return fakeClient;
      },
      async query(text: string) {
        executedSql.push(text);
        if (text.includes("where status = 'failed' and next_run_at <= now()")) {
          return { rowCount: 2, rows: [{ id: "j1" }, { id: "j2" }] };
        }
        if (text.includes("where status = 'running'") && text.includes("started_at < now()")) {
          return { rowCount: 1, rows: [{ id: "j3" }] };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    const summary = await processPendingImportJobs(
      {
        pool: fakePool as never,
        identityPool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
        systemActorId: actorId,
        stagingDir: tempDir,
      },
      { quiet: true, sweepStaging: true },
    );

    expect(summary.requeued).toBe(2);
    expect(summary.reaped).toBe(1);
    expect(summary.processed).toBe(0);

    const requeueIdx = executedSql.findIndex((s) => s.includes("where status = 'failed' and next_run_at <= now()"));
    const reapIdx = executedSql.findIndex((s) => s.includes("where status = 'running'"));
    const claimIdx = executedSql.findIndex((s) => s.includes("for update skip locked"));
    expect(requeueIdx).toBeGreaterThanOrEqual(0);
    expect(reapIdx).toBeGreaterThan(requeueIdx);
    expect(claimIdx).toBeGreaterThan(reapIdx);
  });
});
