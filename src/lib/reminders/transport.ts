// Reminder & Telegram polling transports — Faz 25, Faz 40 (A2) & Faz 42 (B2).
//
// `@/lib/env` is loaded LAZILY inside transport methods so pure verify scripts and tests can import
// `mockTransport`, `transportFor`, `splitTelegramMessage`, and `pollTelegramUpdates` without
// requiring `DATABASE_URL` at module load.

async function readEnv() {
  const { env } = await import("@/lib/env");
  return env;
}

export function redactBotToken(text: string): string {
  return text.replace(/bot[0-9A-Za-z:_-]+/g, "bot[REDACTED]");
}

/** Telegram Bot API hard limit is 4096 UTF-16 code units per sendMessage call. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/**
 * Splits a long Telegram reply into safe chunks (`<= maxLen <= 4096`) without losing content.
 * Prefers paragraph (`\n\n`), line (`\n`), then word (` `) boundaries before falling back to a hard cut.
 */
export function splitTelegramMessage(text: string, maxLen = 4000): string[] {
  const limit = Math.max(1, Math.min(TELEGRAM_MAX_MESSAGE_CHARS, Math.floor(maxLen)));
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const minBreak = Math.max(1, Math.floor(limit * 0.3));

    let splitAt = -1;
    let consumeNewlineCount = 0;

    const paraIdx = window.lastIndexOf("\n\n");
    if (paraIdx >= minBreak) {
      splitAt = paraIdx;
      consumeNewlineCount = 2;
    } else {
      const lineIdx = window.lastIndexOf("\n");
      if (lineIdx >= minBreak) {
        splitAt = lineIdx;
        consumeNewlineCount = 1;
      } else {
        const spaceIdx = window.lastIndexOf(" ");
        if (spaceIdx >= minBreak) {
          splitAt = spaceIdx;
          consumeNewlineCount = 1;
        }
      }
    }

    if (splitAt <= 0) {
      chunks.push(window);
      remaining = remaining.slice(limit);
    } else {
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt + consumeNewlineCount);
    }
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

export interface DeliveryResult {
  ok: boolean;
  error?: string;
  /** Faz 40 (A2): True when an optional channel (e.g. email) is unconfigured and should record `'skipped'`. */
  skippedUnconfigured?: boolean;
}

export interface Transport {
  channel: "telegram" | "email";
  send(message: string): Promise<DeliveryResult>;
}

export function mockTransport(
  opts: { failOn?: (msg: string) => boolean; channel?: Transport["channel"] } = {},
): Transport & { sent: string[] } {
  const sent: string[] = [];
  return {
    channel: opts.channel ?? "telegram",
    sent,
    async send(message: string): Promise<DeliveryResult> {
      if (opts.failOn?.(message)) return { ok: false, error: "mock forced failure" };
      sent.push(message);
      return { ok: true };
    },
  };
}

export async function sendTelegramChatMessage(
  chatId: string,
  message: string,
  opts: { token?: string; fetchImpl?: typeof fetch; maxLen?: number } = {},
): Promise<DeliveryResult> {
  try {
    const token = opts.token ?? (await readEnv()).telegramBotToken;
    if (!token || !chatId) {
      return { ok: false, error: "TELEGRAM_BOT_TOKEN/CHAT_ID tanımlı değil" };
    }
    const fetchFn = opts.fetchImpl ?? fetch;
    const chunks = splitTelegramMessage(message, opts.maxLen ?? 4000);
    for (const chunk of chunks) {
      const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `telegram HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `telegram erişilemedi: ${redactBotToken((e as Error).message)}` };
  }
}

export function telegramTransport(): Transport {
  return {
    channel: "telegram",
    async send(message: string): Promise<DeliveryResult> {
      try {
        const env = await readEnv();
        const token = env.telegramBotToken;
        const chatId = env.telegramChatId;
        if (!token || !chatId) return { ok: false, error: "TELEGRAM_BOT_TOKEN/CHAT_ID tanımlı değil" };
        return await sendTelegramChatMessage(chatId, message, { token });
      } catch (e) {
        return { ok: false, error: `telegram erişilemedi: ${redactBotToken((e as Error).message)}` };
      }
    },
  };
}

export interface TelegramIncomingMessage {
  message_id: number;
  chat: {
    id: number | string;
    type?: string;
  };
  date?: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramIncomingMessage;
}

export type TelegramPollResult =
  | { ok: true; updates: TelegramUpdate[] }
  | { ok: false; status?: number; error: string };

/**
 * Long-polls Telegram `getUpdates` without dropping pending updates (`offset` is caller-managed).
 * Kept in `src/lib/reminders/transport.ts` so all Telegram egress stays behind the single
 * `boundary-verify.ts` allow-listed module.
 */
export async function pollTelegramUpdates(
  offset: number,
  timeoutSec = 25,
  signal?: AbortSignal,
  opts: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<TelegramPollResult> {
  try {
    const token = opts.token ?? (await readEnv()).telegramBotToken;
    if (!token) {
      return { ok: false, error: "TELEGRAM_BOT_TOKEN tanımlı değil" };
    }
    const clampedTimeout = Math.max(0, Math.min(50, Math.floor(timeoutSec)));
    const timeoutSignal = AbortSignal.timeout((clampedTimeout + 10) * 1_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const fetchFn = opts.fetchImpl ?? fetch;

    const res = await fetchFn(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offset: Math.max(0, Math.floor(offset)),
        timeout: clampedTimeout,
        allowed_updates: ["message"],
      }),
      signal: combinedSignal,
    });

    if (!res.ok) {
      return { ok: false, status: res.status, error: `telegram getUpdates HTTP ${res.status}` };
    }

    const payload = (await res.json()) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
    };

    if (!payload || payload.ok !== true || !Array.isArray(payload.result)) {
      return {
        ok: false,
        error: redactBotToken(payload?.description ?? "telegram getUpdates geçersiz yanıt döndürdü"),
      };
    }

    const updates: TelegramUpdate[] = [];
    for (const raw of payload.result) {
      if (!raw || typeof raw !== "object") continue;
      const u = raw as Record<string, unknown>;
      if (typeof u.update_id !== "number" || !Number.isInteger(u.update_id)) continue;
      let msg: TelegramIncomingMessage | undefined;
      if (u.message && typeof u.message === "object") {
        const m = u.message as Record<string, unknown>;
        const chat = m.chat && typeof m.chat === "object" ? (m.chat as Record<string, unknown>) : null;
        if (chat && (typeof chat.id === "number" || typeof chat.id === "string")) {
          msg = {
            message_id: typeof m.message_id === "number" ? m.message_id : 0,
            chat: {
              id: chat.id,
              type: typeof chat.type === "string" ? chat.type : undefined,
            },
            date: typeof m.date === "number" ? m.date : undefined,
            text: typeof m.text === "string" ? m.text : undefined,
          };
        }
      }
      updates.push({ update_id: u.update_id, message: msg });
    }

    return { ok: true, updates };
  } catch (e) {
    return { ok: false, error: `telegram getUpdates erişilemedi: ${redactBotToken((e as Error).message)}` };
  }
}

export function emailTransport(): Transport {
  return {
    channel: "email",
    async send(message: string): Promise<DeliveryResult> {
      try {
        const env = await readEnv();
        const url = env.emailApiUrl;
        const to = env.emailTo;
        if (!url || !to) {
          return {
            ok: false,
            skippedUnconfigured: true,
            error: "skipped_unconfigured: EMAIL_API_URL/EMAIL_TO tanımlı değil",
          };
        }
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(env.emailApiKey ? { authorization: `Bearer ${env.emailApiKey}` } : {}),
          },
          body: JSON.stringify({ to, subject: "MAS Nakit Radar hatırlatma", text: message }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { ok: false, error: `e-posta HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `e-posta erişilemedi: ${redactBotToken((e as Error).message)}` };
      }
    },
  };
}

export function transportFor(channel: Transport["channel"]): Transport {
  return channel === "email" ? emailTransport() : telegramTransport();
}
