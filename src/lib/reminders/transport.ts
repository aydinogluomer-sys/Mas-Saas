// Reminder transports. The Telegram token/chat id are read from SERVER-ONLY env vars
// and never leave the server (this module must not be imported client-side).
// api.telegram.org is unreachable in this environment, so the engine is written
// against the Transport interface and driven by mockTransport in tests/verify.

export interface DeliveryResult {
  ok: boolean;
  error?: string;
}

export interface Transport {
  channel: "telegram" | "email";
  send(message: string): Promise<DeliveryResult>;
}

/** Deterministic transport for tests/verify. Records nothing external. */
export function mockTransport(opts: { failOn?: (msg: string) => boolean } = {}): Transport & { sent: string[] } {
  const sent: string[] = [];
  return {
    channel: "telegram",
    sent,
    async send(message: string): Promise<DeliveryResult> {
      if (opts.failOn?.(message)) return { ok: false, error: "mock forced failure" };
      sent.push(message);
      return { ok: true };
    },
  };
}

/**
 * Real Telegram transport. Token + chat id come from env only. If unset (or the
 * host is unreachable, as here), send() returns a failed result — logged, never thrown,
 * and never exposing the token.
 */
export function telegramTransport(): Transport {
  return {
    channel: "telegram",
    async send(message: string): Promise<DeliveryResult> {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!token || !chatId) return { ok: false, error: "TELEGRAM_BOT_TOKEN/CHAT_ID tanımlı değil" };
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: message }),
        });
        if (!res.ok) return { ok: false, error: `telegram HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `telegram erişilemedi: ${(e as Error).message}` };
      }
    },
  };
}
