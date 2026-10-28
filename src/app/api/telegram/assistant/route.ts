import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, withApiHandler } from "@/lib/api-response";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { getPool, runAsSystem } from "@/lib/db";
import { env } from "@/lib/env";
import { istanbulDateISO } from "@/lib/reports/rules";
import { answerTelegramQuestion } from "@/lib/telegram/assistant";

export const dynamic = "force-dynamic";

const inputSchema = z.object({
  chatId: z.union([z.string(), z.number().int()]).transform(String),
  message: z.string().trim().min(1).max(1_000),
});

function secretMatches(received: string, expected: string): boolean {
  const actual = Buffer.from(received);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function isLoopback(request: Request): boolean {
  const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export async function POST(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    if (!isLoopback(request)) {
      return apiError(403, "Bu servis yalnız yerel makineden kullanılabilir.", {
        code: "local_only",
        requestId,
      });
    }

    const expectedKey = env.telegramInternalApiKey;
    const allowedChatId = env.telegramChatId;
    const receivedKey = request.headers.get("x-telegram-internal-key") ?? "";
    if (!expectedKey || !secretMatches(receivedKey, expectedKey)) {
      return apiError(401, "Yetkisiz.", { code: "unauthorized", requestId });
    }
    if (!allowedChatId) {
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

    const result = await runAsSystem(() =>
      answerTelegramQuestion(getPool(), parsed.data.message, istanbulDateISO()),
    );
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { [CORRELATION_HEADER]: requestId } },
    );
  });
}
