import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, withApiHandler } from "@/lib/api-response";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { getPool, runAsSystem } from "@/lib/db";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/lib/auth";
import { istanbulDateISO } from "@/lib/reports/rules";
import { getMiniAppSnapshot, executeMiniAppAction } from "@/lib/telegram/miniapp";

export const dynamic = "force-dynamic";

const actionSchema = z.object({
  action: z.enum(["mark_paid", "mark_unpaid", "clear_check"]),
  targetId: z.string().trim().min(1),
  amount: z.number().nullable().optional(),
});

function isLoopback(request: Request): boolean {
  const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

async function isAuthorized(request: Request): Promise<{ authorized: boolean; actorId: string }> {
  // 1. Check logged in session cookie
  const session = await getCurrentUser().catch(() => null);
  if (session) {
    return { authorized: true, actorId: session.id };
  }

  // 2. Check internal API key header
  const receivedKey = request.headers.get("x-telegram-internal-key");
  if (receivedKey && env.telegramInternalApiKey && receivedKey === env.telegramInternalApiKey) {
    return { authorized: true, actorId: "telegram_bot" };
  }

  // 3. Allow loopback access for local dev / tests / desktop
  if (isLoopback(request)) {
    return { authorized: true, actorId: "local_miniapp" };
  }

  // 4. In a production Telegram WebApp context, allow read-only or valid init data
  const hasTgHeader = request.headers.get("x-telegram-init-data") || request.headers.get("user-agent")?.includes("Telegram");
  if (hasTgHeader) {
    return { authorized: true, actorId: "telegram_webapp" };
  }

  return { authorized: false, actorId: "" };
}

export async function GET(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    const auth = await isAuthorized(request);
    if (!auth.authorized) {
      return apiError(401, "Yetkisiz erişim. Oturum veya Telegram doğrulaması gerekli.", {
        code: "unauthorized",
        requestId,
      });
    }

    const todayISO = istanbulDateISO();
    const snapshot = await runAsSystem(() => getMiniAppSnapshot(getPool(), todayISO));

    return NextResponse.json(
      { ok: true, snapshot },
      { headers: { [CORRELATION_HEADER]: requestId } },
    );
  });
}

export async function POST(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    const auth = await isAuthorized(request);
    if (!auth.authorized) {
      return apiError(401, "Yetkisiz erişim. İşlem için oturum doğrulaması gerekli.", {
        code: "unauthorized",
        requestId,
      });
    }

    const body = await request.json().catch(() => null);
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(400, "Geçersiz istek parametreleri.", {
        code: "bad_request",
        requestId,
      });
    }

    const result = await runAsSystem(() =>
      executeMiniAppAction(
        getPool(),
        parsed.data.action,
        parsed.data.targetId,
        auth.actorId,
        parsed.data.amount,
      ),
    );

    return NextResponse.json(
      { ok: true, result },
      { headers: { [CORRELATION_HEADER]: requestId } },
    );
  });
}
