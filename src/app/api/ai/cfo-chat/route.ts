import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { apiError, withApiHandler } from "@/lib/api-response";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { askCfoCopilot, type ChatMessage } from "@/lib/ai/copilot-engine";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  message: z.string().trim().min(1, "Mesaj boş olamaz.").max(1_500, "Mesaj çok uzun."),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().max(2_000),
      })
    )
    .optional(),
  currentPath: z.string().optional(),
  forceDeterministic: z.boolean().optional(),
});

export async function POST(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    // 1. Kimlik Doğrulama
    const user = await getCurrentUser();
    if (!user) {
      return apiError(401, "Oturum açmanız gerekiyor.", { code: "unauthorized", requestId });
    }

    // 2. İstek Gövdesi Doğrulama
    const body = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(400, "Geçersiz istek formatı.", {
        code: "bad_request",
        requestId,
      });
    }

    const { message, history, currentPath, forceDeterministic } = parsed.data;

    // 3. CFO Copilot Yanıtı Üret
    const response = await askCfoCopilot(getPool(), {
      message,
      history: history as ChatMessage[] | undefined,
      currentPath,
      forceDeterministic,
    });

    return NextResponse.json(
      {
        success: true,
        ...response,
      },
      {
        headers: { [CORRELATION_HEADER]: requestId },
      }
    );
  });
}
