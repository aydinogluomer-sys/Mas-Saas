/**
 * MAS Nakit Radar — Salt-Okunur TypeScript Telegram Asistan İşçisi (Faz 42 / B2).
 *
 * `bot.py` Python yan sürecinin ve `/api/telegram/assistant` çerezsiz HTTP köprüsünün yerini alır:
 * - Tek-örnek kilidi (`.runtime/telegram-worker.lock`, ölü PID tespitiyle)
 * - Atomik `update_id` ofset kalıcılığı (`.runtime/telegram-offset.json`, bekleyen mesajlar asla silinmez)
 * - Yetkisiz `chat_id` mesajlarına **sıfır dış HTTP yanıtı** (429 DoS koruması) + hız-sınırlı sayaç
 * - Doğrudan `runAsReadOnlySystem` (`mas_radar_viewer` rolü — hiçbir tabloya yazma yetkisi yok)
 *   üzerinden `answerTelegramQuestion` çağrısı
 * - `splitTelegramMessage` (<= 4000 karakter) ile uzun yanıtları güvenli parçalama
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DeliveryResult,
  TelegramPollResult,
  TelegramUpdate,
} from "../../src/lib/reminders/transport";
import type { TelegramAnswer } from "../../src/lib/telegram/assistant";

export const DEFAULT_RUNTIME_DIR = path.resolve(process.cwd(), ".runtime");
export const DEFAULT_TELEGRAM_LOCK_PATH = path.join(DEFAULT_RUNTIME_DIR, "telegram-worker.lock");
export const DEFAULT_TELEGRAM_OFFSET_PATH = path.join(DEFAULT_RUNTIME_DIR, "telegram-offset.json");
export const DEFAULT_TELEGRAM_UNAUTH_PATH = path.join(DEFAULT_RUNTIME_DIR, "telegram-unauthorized.json");
export const MAX_INCOMING_TEXT_CHARS = 1_000;
export const UNAUTHORIZED_LOG_WINDOW_MS = 60_000;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists under another OS user; ESRCH means it does not exist.
    return code === "EPERM";
  }
}

export interface ProcessLockHandle {
  lockPath: string;
  pid: number;
  release: () => void;
}

/**
 * Acquires an exclusive single-instance file lock, automatically reclaiming stale dead-PID locks.
 */
export function acquireSingleInstanceLock(
  lockPath = DEFAULT_TELEGRAM_LOCK_PATH,
  pid = process.pid,
  aliveCheck: (candidatePid: number) => boolean = isProcessAlive,
): ProcessLockHandle {
  const resolved = path.resolve(lockPath);
  mkdirSync(path.dirname(resolved), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(resolved, "wx");
      try {
        writeFileSync(
          fd,
          JSON.stringify({ pid, startedAt: new Date().toISOString() }, null, 2),
          "utf8",
        );
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        lockPath: resolved,
        pid,
        release: () => {
          if (released) return;
          released = true;
          try {
            if (!existsSync(resolved)) return;
            const current = JSON.parse(readFileSync(resolved, "utf8")) as { pid?: number };
            if (current?.pid === pid) {
              unlinkSync(resolved);
            }
          } catch {
            // Best-effort cleanup on shutdown.
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        const raw = readFileSync(resolved, "utf8");
        const parsed = JSON.parse(raw) as { pid?: number };
        const holderPid = typeof parsed?.pid === "number" ? parsed.pid : -1;
        if (holderPid > 0 && holderPid !== pid && aliveCheck(holderPid)) {
          throw new Error(`İşçi zaten çalışıyor (kilit: ${resolved}, PID: ${holderPid}).`);
        }
        // Stale lock from a dead process — reclaim and retry once.
        unlinkSync(resolved);
      } catch (innerErr) {
        if (innerErr instanceof Error && innerErr.message.startsWith("İşçi zaten çalışıyor")) {
          throw innerErr;
        }
        if (attempt === 1) throw err;
      }
    }
  }

  throw new Error(`İşçi kilidi alınamadı: ${resolved}`);
}

export async function readTelegramOffset(offsetPath = DEFAULT_TELEGRAM_OFFSET_PATH): Promise<number> {
  try {
    const raw = await readFile(offsetPath, "utf8");
    const parsed = JSON.parse(raw) as { nextOffset?: unknown };
    if (typeof parsed?.nextOffset === "number" && Number.isInteger(parsed.nextOffset) && parsed.nextOffset >= 0) {
      return parsed.nextOffset;
    }
    return 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    return 0;
  }
}

export async function writeTelegramOffsetAtomic(
  offsetPath: string,
  nextOffset: number,
): Promise<void> {
  if (!Number.isInteger(nextOffset) || nextOffset < 0) {
    throw new Error(`Geçersiz Telegram update ofseti: ${nextOffset}`);
  }
  const resolved = path.resolve(offsetPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const tmpPath = `${resolved}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(
    { nextOffset, updatedAt: new Date().toISOString() },
    null,
    2,
  );
  await writeFile(tmpPath, payload, "utf8");
  await rename(tmpPath, resolved);
}

export interface UnauthorizedDropTracker {
  totalDropped: number;
  windowDropped: number;
  lastLoggedAtMs: number;
}

export function createUnauthorizedRateLimiter(windowMs = UNAUTHORIZED_LOG_WINDOW_MS) {
  const state: UnauthorizedDropTracker = {
    totalDropped: 0,
    windowDropped: 0,
    lastLoggedAtMs: 0,
  };
  return {
    state,
    recordDrop(
      chatId: string | number,
      nowMs = Date.now(),
    ): { shouldEmitAuditLog: boolean; chatHash: string; windowDropped: number; totalDropped: number } {
      state.totalDropped += 1;
      state.windowDropped += 1;
      const chatHash = createHash("sha256").update(String(chatId), "utf8").digest("hex").slice(0, 12);
      if (state.lastLoggedAtMs === 0 || nowMs - state.lastLoggedAtMs >= windowMs) {
        const emittedCount = state.windowDropped;
        state.windowDropped = 0;
        state.lastLoggedAtMs = nowMs;
        return {
          shouldEmitAuditLog: true,
          chatHash,
          windowDropped: emittedCount,
          totalDropped: state.totalDropped,
        };
      }
      return {
        shouldEmitAuditLog: false,
        chatHash,
        windowDropped: state.windowDropped,
        totalDropped: state.totalDropped,
      };
    },
  };
}

export function parseAllowedTelegramUserIds(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const ids = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

function normalizeAllowedUserSet(
  input: ReadonlySet<string> | readonly (string | number)[] | null | undefined,
): Set<string> | null {
  if (input === undefined) {
    return parseAllowedTelegramUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
  }
  if (input === null) return null;
  if (input instanceof Set) {
    return input.size > 0 ? new Set([...input].map((v) => String(v).trim()).filter(Boolean)) : null;
  }
  const arr = [...(input as readonly (string | number)[])]
    .map((v) => String(v).trim())
    .filter(Boolean);
  return arr.length > 0 ? new Set(arr) : null;
}

export interface TelegramWorkerDeps {
  allowedChatId: string;
  allowedUserIds?: ReadonlySet<string> | readonly (string | number)[] | null;
  offsetPath: string;
  todayISO: () => string;
  pollUpdates: (offset: number, timeoutSec: number, signal?: AbortSignal) => Promise<TelegramPollResult>;
  answerReadOnly: (message: string, todayISO: string) => Promise<TelegramAnswer>;
  sendReply: (chatId: string, text: string) => Promise<DeliveryResult>;
  onUnauthorizedDrop?: (info: {
    chatHash: string;
    windowDropped: number;
    totalDropped: number;
  }) => Promise<void> | void;
}

export interface TelegramCycleResult {
  polledOk: boolean;
  nextOffset: number;
  answered: number;
  unauthorizedDropped: number;
  ignoredEmpty: number;
  haltedOnSendError: boolean;
  error?: string;
}

/**
 * Processes a batch of Telegram updates sequentially, persisting `nextOffset` atomically
 * after each handled update so crashes neither drop pending owner questions nor double-answer.
 */
export async function processTelegramUpdatesBatch(
  updates: readonly TelegramUpdate[],
  initialOffset: number,
  deps: Pick<
    TelegramWorkerDeps,
    | "allowedChatId"
    | "allowedUserIds"
    | "offsetPath"
    | "todayISO"
    | "answerReadOnly"
    | "sendReply"
    | "onUnauthorizedDrop"
  >,
  rateLimiter = createUnauthorizedRateLimiter(),
): Promise<Omit<TelegramCycleResult, "polledOk">> {
  const allowedChats = new Set(
    deps.allowedChatId
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (allowedChats.size === 0) {
    throw new Error("TELEGRAM_CHAT_ID yapılandırılmamış; Telegram işçisi başlatılamaz.");
  }

  const allowedUsers = normalizeAllowedUserSet(deps.allowedUserIds);

  let nextOffset = initialOffset;
  let answered = 0;
  let unauthorizedDropped = 0;
  let ignoredEmpty = 0;

  const ordered = [...updates].sort((a, b) => a.update_id - b.update_id);

  for (const upd of ordered) {
    if (upd.update_id < nextOffset) continue;

    const msg = upd.message;
    if (!msg || msg.from?.is_bot === true) {
      ignoredEmpty += 1;
      nextOffset = upd.update_id + 1;
      await writeTelegramOffsetAtomic(deps.offsetPath, nextOffset);
      continue;
    }

    const incomingChatId = String(msg.chat.id).trim();
    if (!allowedChats.has(incomingChatId)) {
      // Faz 42 (B2): ZERO outbound HTTP reply to unauthorized chats (eliminates 429 DoS & probing).
      unauthorizedDropped += 1;
      const dropInfo = rateLimiter.recordDrop(incomingChatId);
      if (dropInfo.shouldEmitAuditLog && deps.onUnauthorizedDrop) {
        await deps.onUnauthorizedDrop({
          chatHash: dropInfo.chatHash,
          windowDropped: dropInfo.windowDropped,
          totalDropped: dropInfo.totalDropped,
        });
      }
      nextOffset = upd.update_id + 1;
      await writeTelegramOffsetAtomic(deps.offsetPath, nextOffset);
      continue;
    }

    if (allowedUsers && allowedUsers.size > 0) {
      const senderUserId = msg.from?.id != null ? String(msg.from.id).trim() : "";
      if (!senderUserId || !allowedUsers.has(senderUserId)) {
        unauthorizedDropped += 1;
        const dropInfo = rateLimiter.recordDrop(`${incomingChatId}:user:${senderUserId || "missing"}`);
        if (dropInfo.shouldEmitAuditLog && deps.onUnauthorizedDrop) {
          await deps.onUnauthorizedDrop({
            chatHash: dropInfo.chatHash,
            windowDropped: dropInfo.windowDropped,
            totalDropped: dropInfo.totalDropped,
          });
        }
        nextOffset = upd.update_id + 1;
        await writeTelegramOffsetAtomic(deps.offsetPath, nextOffset);
        continue;
      }
    }

    const text = (msg.text ?? "").trim();
    if (!text) {
      ignoredEmpty += 1;
      nextOffset = upd.update_id + 1;
      await writeTelegramOffsetAtomic(deps.offsetPath, nextOffset);
      continue;
    }

    const boundedText = text.slice(0, MAX_INCOMING_TEXT_CHARS);
    const response = await deps.answerReadOnly(boundedText, deps.todayISO());
    const delivery = await deps.sendReply(incomingChatId, response.answer);

    if (!delivery.ok) {
      // Do NOT advance offset past an unanswered owner question on transient outbound network errors.
      return {
        nextOffset,
        answered,
        unauthorizedDropped,
        ignoredEmpty,
        haltedOnSendError: true,
        error: delivery.error ?? "Telegram yanıtı gönderilemedi",
      };
    }

    answered += 1;
    nextOffset = upd.update_id + 1;
    await writeTelegramOffsetAtomic(deps.offsetPath, nextOffset);
  }

  return {
    nextOffset,
    answered,
    unauthorizedDropped,
    ignoredEmpty,
    haltedOnSendError: false,
  };
}

export async function runTelegramWorkerCycle(
  deps: TelegramWorkerDeps,
  opts: { timeoutSec?: number; signal?: AbortSignal; rateLimiter?: ReturnType<typeof createUnauthorizedRateLimiter> } = {},
): Promise<TelegramCycleResult> {
  const currentOffset = await readTelegramOffset(deps.offsetPath);
  const poll = await deps.pollUpdates(currentOffset, opts.timeoutSec ?? 25, opts.signal);
  if (!poll.ok) {
    return {
      polledOk: false,
      nextOffset: currentOffset,
      answered: 0,
      unauthorizedDropped: 0,
      ignoredEmpty: 0,
      haltedOnSendError: false,
      error: poll.error,
    };
  }

  const batch = await processTelegramUpdatesBatch(
    poll.updates,
    currentOffset,
    deps,
    opts.rateLimiter,
  );
  return {
    polledOk: true,
    ...batch,
  };
}

async function persistUnauthorizedSummary(
  unauthPath: string,
  info: { chatHash: string; windowDropped: number; totalDropped: number },
): Promise<void> {
  const resolved = path.resolve(unauthPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const tmpPath = `${resolved}.tmp.${process.pid}`;
  await writeFile(
    tmpPath,
    JSON.stringify(
      {
        lastSeenAt: new Date().toISOString(),
        lastChatHash: info.chatHash,
        windowDropped: info.windowDropped,
        totalDropped: info.totalDropped,
      },
      null,
      2,
    ),
    "utf8",
  );
  await rename(tmpPath, resolved);
}

async function main(): Promise<void> {
  process.env.PGAPPNAME = process.env.PGAPPNAME || "mas_telegram_worker";
  const { loadEnvConfig } = await import("@next/env");
  loadEnvConfig(process.cwd());

  const once = process.argv.includes("--once");
  const lock = acquireSingleInstanceLock(DEFAULT_TELEGRAM_LOCK_PATH);

  const abortController = new AbortController();
  const requestStop = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  const [
    { env },
    { getPool, runAsReadOnlySystem },
    { log },
    { pollTelegramUpdates, sendTelegramChatMessage },
    { istanbulDateISO },
    { answerTelegramQuestion },
  ] = await Promise.all([
    import("../../src/lib/env"),
    import("../../src/lib/db"),
    import("../../src/lib/logger"),
    import("../../src/lib/reminders/transport"),
    import("../../src/lib/reports/rules"),
    import("../../src/lib/telegram/assistant"),
  ]);

  const pool = getPool();
  try {
    const token = env.telegramBotToken?.trim();
    const allowedChatId = env.telegramChatId?.trim();
    if (!token || !allowedChatId) {
      log.warn("telegram_worker_unconfigured", {
        hasToken: Boolean(token),
        hasChatId: Boolean(allowedChatId),
      });
      if (once) return;
      throw new Error("TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID tanımlanmadan Telegram işçisi başlatılamaz.");
    }

    const rateLimiter = createUnauthorizedRateLimiter();
    const deps: TelegramWorkerDeps = {
      allowedChatId,
      allowedUserIds: parseAllowedTelegramUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS),
      offsetPath: DEFAULT_TELEGRAM_OFFSET_PATH,
      todayISO: () => istanbulDateISO(),
      pollUpdates: (offset, timeoutSec, signal) => pollTelegramUpdates(offset, timeoutSec, signal),
      // Strictly viewer tier (`mas_radar_viewer`) — zero write privileges on any database table.
      answerReadOnly: (message, today) =>
        runAsReadOnlySystem(() => answerTelegramQuestion(pool, message, today)),
      sendReply: (chatId, text) => sendTelegramChatMessage(chatId, text),
      onUnauthorizedDrop: async (info) => {
        log.warn("telegram_unauthorized_chat_dropped", info);
        await persistUnauthorizedSummary(DEFAULT_TELEGRAM_UNAUTH_PATH, info);
      },
    };

    log.info("telegram_worker_started", { mode: once ? "once" : "daemon" });

    if (once) {
      const cycle = await runTelegramWorkerCycle(deps, {
        timeoutSec: 0,
        signal: abortController.signal,
        rateLimiter,
      });
      log.info("telegram_worker_once_completed", {
        polledOk: cycle.polledOk,
        answered: cycle.answered,
        unauthorizedDropped: cycle.unauthorizedDropped,
        nextOffset: cycle.nextOffset,
      });
      return;
    }

    let consecutiveErrors = 0;
    while (!abortController.signal.aborted) {
      const cycle = await runTelegramWorkerCycle(deps, {
        timeoutSec: 25,
        signal: abortController.signal,
        rateLimiter,
      });
      if (abortController.signal.aborted) break;

      if (!cycle.polledOk || cycle.haltedOnSendError) {
        consecutiveErrors += 1;
        const backoffMs = Math.min(30_000, 1_000 * 2 ** Math.min(5, consecutiveErrors));
        log.warn("telegram_worker_cycle_backoff", {
          consecutiveErrors,
          backoffMs,
          error: cycle.error ?? "unknown",
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backoffMs);
          abortController.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      } else {
        consecutiveErrors = 0;
      }
    }

    log.info("telegram_worker_stopped", { clean: true });
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    lock.release();
    await pool.end().catch(() => undefined);
  }
}

const isDirectCli =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCli) {
  main().catch((err) => {
    console.error("Telegram işçisi hatası:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

