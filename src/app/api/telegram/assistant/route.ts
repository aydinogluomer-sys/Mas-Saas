// POST /api/telegram/assistant — the read-only question endpoint behind bot.py.
//
// bot.py runs on this machine, long-polls Telegram and forwards the owner's questions here. It has
// no browser session, so this is the ONE route src/middleware.ts lets through without the cookie
// gate, and everything that makes it safe lives in this handler:
//
//   1. A shared secret (TELEGRAM_INTERNAL_API_KEY, at least 32 characters per @/lib/env), compared
//      in constant time. Unset means nobody can authenticate: every request is refused.
//   2. A chat allow-list of exactly one entry, TELEGRAM_CHAT_ID — the owner chat that is also the
//      only accepted outbound channel. Unset means nobody is allowed: every request is refused.
//   3. Read-only by construction: answerTelegramQuestion() imports nothing but `load*` readers and
//      refuses mutation phrasing, and it runs as the VIEWER tier (runAsReadOnlySystem), which the
//      database itself forbids from writing anything.
//
// What is deliberately NOT here any more: the layer's `isLoopback(request)` check. It read the
// hostname from request.url, which Next builds from its own server name ('localhost' under
// `next start` without -H), not from the caller's address — so it was true for every caller on the
// network and only looked like a control. The secret is the control.
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, withApiHandler } from "@/lib/api-response";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { getPool, runAsReadOnlySystem } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { istanbulDateISO } from "@/lib/reports/rules";
import { answerTelegramQuestion } from "@/lib/telegram/assistant";

export const dynamic = "force-dynamic";

const inputSchema = z.object({
  chatId: z.union([z.string(), z.number().int()]).transform(String),
  message: z.string().trim().min(1).max(1_000),
});

/**
 * Constant-time comparison of the shared secret.
 *
 * Both sides are hashed first because timingSafeEqual() only accepts equal-length buffers: the
 * previous version returned early on a length mismatch, which told a prober the configured key's
 * length. Two SHA-256 digests are always 32 bytes, so neither the content nor the length of the
 * key influences how long the comparison takes.
 */
function secretMatches(received: string, expected: string): boolean {
  const actual = createHash("sha256").update(received, "utf8").digest();
  const wanted = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actual, wanted);
}

export async function POST(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    const expectedKey = env.telegramInternalApiKey;
    if (!expectedKey) {
      // Fail closed. Logged for the operator (names only, never values); the caller learns
      // nothing about the configuration it could not authenticate against.
      log.warn("telegram_assistant_not_configured", { requestId, missing: "TELEGRAM_INTERNAL_API_KEY" });
      return apiError(401, "Yetkisiz.", { code: "unauthorized", requestId });
    }
    const receivedKey = request.headers.get("x-telegram-internal-key") ?? "";
    if (!secretMatches(receivedKey, expectedKey)) {
      return apiError(401, "Yetkisiz.", { code: "unauthorized", requestId });
    }

    // Only an authenticated caller (bot.py) gets to learn that the allow-list is missing.
    const allowedChatId = env.telegramChatId;
    if (!allowedChatId) {
      log.warn("telegram_assistant_not_configured", { requestId, missing: "TELEGRAM_CHAT_ID" });
      return apiError(503, "Telegram Chat ID yapılandırılmamış.", {
        code: "telegram_not_configured",
        requestId,
      });
    }

    const body = await request.json().catch(() => null);
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(400, "Geçersiz istek.", { code: "bad_request", requestId });
    }
    if (parsed.data.chatId !== allowedChatId) {
      return apiError(403, "Bu Telegram hesabı yetkili değil.", {
        code: "forbidden",
        requestId,
      });
    }

    const result = await runAsReadOnlySystem(() =>
      answerTelegramQuestion(getPool(), parsed.data.message, istanbulDateISO()),
    );
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { [CORRELATION_HEADER]: requestId } },
    );
  });
}
