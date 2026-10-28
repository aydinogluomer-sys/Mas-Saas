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
      ...(options.key ? { "x-telegram-internal-key": options.key } : {}),
    },
    body: JSON.stringify({
      chatId: options.chatId ?? "5784804791",
      message: options.message ?? "/cari Akon",
    }),
  });
}

describe("POST /api/telegram/assistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.answer.mockResolvedValue({ kind: "current_account", answer: "Akon cari özet" });
  });

  it("yanlış servis anahtarını reddeder", async () => {
    const response = await POST(request({ key: "wrong" }));
    expect(response.status).toBe(401);
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("yetkisiz Chat ID'yi reddeder", async () => {
    const response = await POST(request({ key: "a".repeat(32), chatId: "999" }));
    expect(response.status).toBe(403);
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("loopback olmayan isteği anahtardan önce reddeder", async () => {
    const response = await POST(request({
      key: "a".repeat(32),
      url: "http://192.168.1.10:3000/api/telegram/assistant",
    }));
    expect(response.status).toBe(403);
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("doğrulanmış yerel isteği sistemin salt-okunur asistanına iletir", async () => {
    const response = await POST(request({ key: "a".repeat(32) }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, kind: "current_account", answer: "Akon cari özet" });
    expect(mocks.runAsSystem).toHaveBeenCalledOnce();
    expect(mocks.answer).toHaveBeenCalledOnce();
  });
});
