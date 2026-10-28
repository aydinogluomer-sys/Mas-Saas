import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, withApiHandler } from "@/lib/api-response";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { getPool, runAsSystem } from "@/lib/db";
import { env } from "@/lib/env";
import { istanbulDateISO } from "@/lib/reports/rules";
import { answerTelegramQuestion } from "@/lib/telegram/assistant";
import { loadBriefingFacts } from "@/lib/briefing/engine";
import { loadApprovalQueue } from "@/lib/approvals/engine";
import {
  renderCfoBriefingTelegram,
  handleTelegramApprovalCallback,
} from "@/lib/telegram/cfo-bot";

export const dynamic = "force-dynamic";

const telegramUpdateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number().optional(),
      chat: z.object({
        id: z.union([z.string(), z.number().int()]).transform(String),
      }),
      text: z.string().optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({
        id: z.union([z.string(), z.number().int()]).transform(String),
        first_name: z.string().optional(),
      }),
      message: z
        .object({
          message_id: z.number().optional(),
          chat: z.object({
            id: z.union([z.string(), z.number().int()]).transform(String),
          }),
        })
        .optional(),
      data: z.string().optional(),
    })
    .optional(),
});

function secretMatches(received: string, expected: string): boolean {
  const actual = Buffer.from(received);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function POST(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    const expectedKey = env.telegramInternalApiKey;
    const allowedChatId = env.telegramChatId;

    // Telegram webhook sends secret token in 'x-telegram-bot-api-secret-token'
    const receivedSecret =
      request.headers.get("x-telegram-bot-api-secret-token") ??
      request.headers.get("x-telegram-internal-key") ??
      "";

    if (expectedKey && !secretMatches(receivedSecret, expectedKey)) {
      return apiError(401, "Yetkisiz webhook isteği.", { code: "unauthorized", requestId });
    }

    if (!allowedChatId) {
      return apiError(503, "Telegram Chat ID yapılandırılmamış.", {
        code: "telegram_not_configured",
        requestId,
      });
    }

    const body = await request.json().catch(() => null);
    const parsed = telegramUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(400, "Geçersiz Telegram güncellemesi.", { code: "bad_request", requestId });
    }

    // ── 1. İNTERAKTİF BUTON CALLBACK İŞLEYİCİSİ (CFO ONAY / RED) ──
    const callbackQuery = parsed.data.callback_query;
    if (callbackQuery && callbackQuery.data) {
      const chatId = callbackQuery.message?.chat.id ?? allowedChatId;
      if (chatId !== allowedChatId) {
        return NextResponse.json(
          {
            method: "answerCallbackQuery",
            callback_query_id: callbackQuery.id,
            text: "Yetkisiz işlem.",
            show_alert: true,
          },
          { headers: { [CORRELATION_HEADER]: requestId } },
        );
      }

      const pool = getPool();
      const secret = expectedKey || "mas-radar-default-secret";
      let result;
      try {
        result = await runAsSystem(() =>
          handleTelegramApprovalCallback(pool, callbackQuery.data!, "telegram-cfo-bot", secret),
        );
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result = {
          ok: false,
          approvalId: "",
          decision: "rejected" as const,
          message: errorMsg,
        };
      }

      return NextResponse.json(
        {
          method: "answerCallbackQuery",
          callback_query_id: callbackQuery.id,
          text: result.message,
          show_alert: !result.ok,
        },
        { headers: { [CORRELATION_HEADER]: requestId } },
      );
    }

    // ── 2. STANDART METİN MESAJI İŞLEYİCİSİ ──
    const messageObj = parsed.data.message;
    if (!messageObj || !messageObj.text) {
      return NextResponse.json({ ok: true, ignored: true }, { headers: { [CORRELATION_HEADER]: requestId } });
    }

    const chatId = messageObj.chat.id;
    if (chatId !== allowedChatId) {
      return NextResponse.json(
        {
          method: "sendMessage",
          chat_id: chatId,
          text: "Bu botu kullanma yetkiniz bulunmuyor.",
        },
        { headers: { [CORRELATION_HEADER]: requestId } },
      );
    }

    const text = messageObj.text.trim();

    if (text === "/start") {
      return NextResponse.json(
        {
          method: "sendMessage",
          chat_id: allowedChatId,
          text:
            "Merhaba!\n\nMAS SaaS Telegram asistanı aktif.\n\nKomutlar:\n• /brifing — CFO Sabah Brifingi ve Onay Bekleyenler\n• /durum — Sistem sağlık durumu\n• /cari Firma Adı — Cari bakiye\n• /hareket Firma Adı — Son hareketler\n• Toplam açık alacak ne kadar?\n• Toplam açık borç ne kadar?",
        },
        { headers: { [CORRELATION_HEADER]: requestId } },
      );
    }

    if (text === "/durum") {
      return NextResponse.json(
        {
          method: "sendMessage",
          chat_id: allowedChatId,
          text: "🟢 MAS SaaS çalışıyor.\nVeritabanı: aktif\nMod: webhook\nİnteraktif Onay: aktif",
        },
        { headers: { [CORRELATION_HEADER]: requestId } },
      );
    }

    // ── 3. /brifing KOMUTU (CANLI CFO SABAH BRİFİNGİ VE BUTONLAR) ──
    if (text === "/brifing" || text === "/cfo") {
      const pool = getPool();
      const todayISO = istanbulDateISO();
      const secret = expectedKey || "mas-radar-default-secret";

      const [facts, pending] = await runAsSystem(() =>
        Promise.all([
          loadBriefingFacts(pool, todayISO),
          loadApprovalQueue(pool, { status: "pending", limit: 3 }),
        ]),
      );

      const executiveMsg = renderCfoBriefingTelegram(facts, pending, secret);

      return NextResponse.json(
        {
          method: "sendMessage",
          chat_id: allowedChatId,
          text: executiveMsg.text,
          parse_mode: executiveMsg.parse_mode,
          reply_markup: executiveMsg.reply_markup,
        },
        { headers: { [CORRELATION_HEADER]: requestId } },
      );
    }

    const result = await runAsSystem(() =>
      answerTelegramQuestion(getPool(), text, istanbulDateISO()),
    );

    return NextResponse.json(
      {
        method: "sendMessage",
        chat_id: allowedChatId,
        text: result.answer,
      },
      { headers: { [CORRELATION_HEADER]: requestId } },
    );
  });
}
