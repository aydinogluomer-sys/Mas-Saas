import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

describe("Telegram assistant middleware sınırı", () => {
  it("yalnız tam Telegram assistant yolunu servis kimlik doğrulamasına bırakır", () => {
    const response = middleware(new NextRequest("http://127.0.0.1:3000/api/telegram/assistant"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("tam Telegram webhook yolunu servis kimlik doğrulamasına bırakır", () => {
    const response = middleware(new NextRequest("http://127.0.0.1:3000/api/telegram/webhook"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("komşu Telegram API yollarını oturum kapısından kaçırmaz", () => {
    const response = middleware(new NextRequest("http://127.0.0.1:3000/api/telegram/other"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });
});
