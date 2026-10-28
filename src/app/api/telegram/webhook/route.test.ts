import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAsSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  answer: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  env: {
    telegramInternalApiKey: "a".repeat(32),
    telegramChatId: "5784804791",
  },
}));
vi.mock("@/lib/db", () => ({
  getPool: vi.fn(() => ({})),
  runAsSystem: mocks.runAsSystem,
}));
vi.mock("@/lib/telegram/assistant", () => ({
  answerTelegramQuestion: mocks.answer,
}));

import { POST } from "./route";

function webhookRequest(options: {
  secret?: string;
  chatId?: string | number;
  text?: string;
} = {}) {
  return new Request("https://nakit.example.com/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.secret ? { "x-telegram-bot-api-secret-token": options.secret } : {}),
    },
    body: JSON.stringify({
      update_id: 123456,
      message: {
        message_id: 1,
        chat: { id: options.chatId ?? "5784804791" },
        text: options.text ?? "/cari Akon",
      },
    }),
  });
}

describe("POST /api/telegram/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.answer.mockResolvedValue({ kind: "current_account", answer: "Akon cari özet" });
  });

  it("yanlış webhook gizli anahtarını 401 ile reddeder", async () => {
    const response = await POST(webhookRequest({ secret: "wrong-secret" }));
    expect(response.status).toBe(401);
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("yetkisiz Chat ID'yi reddeder ve yetki yok mesajı döner", async () => {
    const response = await POST(
      webhookRequest({ secret: "a".repeat(32), chatId: 999999999 }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.text).toContain("yetkiniz bulunmuyor");
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("/start komutunu karşılar ve selamlama metni döner", async () => {
    const response = await POST(
      webhookRequest({ secret: "a".repeat(32), text: "/start" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.method).toBe("sendMessage");
    expect(body.text).toContain("MAS SaaS Telegram asistanı aktif");
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("finansal soruyu sistem asistanına iletir ve cevabı webhook yanıtıyla döner", async () => {
    const response = await POST(
      webhookRequest({ secret: "a".repeat(32), text: "/cari Akon" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      method: "sendMessage",
      chat_id: "5784804791",
      text: "Akon cari özet",
    });
    expect(mocks.runAsSystem).toHaveBeenCalledOnce();
    expect(mocks.answer).toHaveBeenCalledOnce();
  });

  it("callback_query geldiğinde onay/red işlemini yürütür ve answerCallbackQuery döner", async () => {
    const callbackReq = new Request("https://nakit.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "a".repeat(32),
      },
      body: JSON.stringify({
        update_id: 999,
        callback_query: {
          id: "query-123",
          from: { id: "5784804791", first_name: "CFO" },
          message: {
            message_id: 10,
            chat: { id: "5784804791" },
          },
          data: "app:11111111-2222-3333-4444-555555555555:a:invalid_sig",
        },
      }),
    });

    const response = await POST(callbackReq);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.method).toBe("answerCallbackQuery");
    expect(body.callback_query_id).toBe("query-123");
  });
});

