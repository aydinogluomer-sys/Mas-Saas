import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The chat id below is deliberately fake and obviously so (100000001). The previous fixture was a
// real-looking Telegram id; a test has no business carrying one.
const CHAT = "100000001";
const KEY = "a".repeat(32);

const mocks = vi.hoisted(() => ({
  env: {
    telegramInternalApiKey: undefined as string | undefined,
    telegramChatId: undefined as string | undefined,
  },
  runAsReadOnlySystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runAsSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  answer: vi.fn(),
}));

// The handler reads env per request, so each test can reconfigure this object.
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/db", () => ({
  getPool: vi.fn(() => ({})),
  runAsReadOnlySystem: mocks.runAsReadOnlySystem,
  runAsSystem: mocks.runAsSystem,
}));
vi.mock("@/lib/telegram/assistant", () => ({
  answerTelegramQuestion: mocks.answer,
}));

import { POST } from "./route";

function request(options: {
  key?: string;
  chatId?: string;
  message?: string;
  url?: string;
} = {}) {
  return new Request(options.url ?? "http://127.0.0.1:3000/api/telegram/assistant", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.key !== undefined ? { "x-telegram-internal-key": options.key } : {}),
    },
    body: JSON.stringify({
      chatId: options.chatId ?? CHAT,
      message: options.message ?? "/cari Akon",
    }),
  });
}

let stderr: ReturnType<typeof vi.spyOn>;

describe("POST /api/telegram/assistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.telegramInternalApiKey = KEY;
    mocks.env.telegramChatId = CHAT;
    mocks.answer.mockResolvedValue({ kind: "current_account", answer: "Akon cari özet" });
    // The not-configured paths log a warning for the operator; keep the suite output quiet.
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
  });

  it("anahtar başlığı hiç yoksa 401 döner — loopback adresinden gelse bile", async () => {
    // A loopback URL is not an access control: Next builds request.url from its own server name.
    const response = await POST(request({ url: "http://127.0.0.1:3000/api/telegram/assistant" }));
    expect(response.status).toBe(401);
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("yanlış servis anahtarını reddeder (kısa, uzun ve aynı uzunlukta yanlış)", async () => {
    for (const key of ["wrong", "a".repeat(64), "b".repeat(32), ""]) {
      const response = await POST(request({ key }));
      expect(response.status, `anahtar uzunluğu ${key.length}`).toBe(401);
    }
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("TELEGRAM_INTERNAL_API_KEY tanımsızsa her isteği reddeder (kapalı başarısızlık)", async () => {
    mocks.env.telegramInternalApiKey = undefined;
    for (const key of [undefined, "", KEY]) {
      const response = await POST(request({ key }));
      expect(response.status).toBe(401);
    }
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("TELEGRAM_CHAT_ID tanımsızsa doğru anahtarla bile yanıt vermez (izin listesi boş = kimse)", async () => {
    mocks.env.telegramChatId = undefined;
    const response = await POST(request({ key: KEY }));
    expect(response.status).toBe(503);
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("izin listesinde olmayan Chat ID'yi reddeder", async () => {
    const response = await POST(request({ key: KEY, chatId: "100000002" }));
    expect(response.status).toBe(403);
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("geçersiz gövdeyi 400 ile reddeder", async () => {
    const response = await POST(request({ key: KEY, message: "" }));
    expect(response.status).toBe(400);
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("doğrulanmış isteği VIEWER kimliğiyle salt-okunur asistana iletir (finance_manager değil)", async () => {
    const response = await POST(request({ key: KEY }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, kind: "current_account", answer: "Akon cari özet" });
    expect(mocks.runAsReadOnlySystem).toHaveBeenCalledOnce();
    expect(mocks.runAsSystem).not.toHaveBeenCalled();
    expect(mocks.answer).toHaveBeenCalledOnce();
  });

  it("ana makine adı bir erişim kontrolü değildir: anahtar doğruysa adres sonucu değiştirmez", async () => {
    const response = await POST(request({ key: KEY, url: "http://192.168.1.10:3000/api/telegram/assistant" }));
    expect(response.status).toBe(200);
  });
});
