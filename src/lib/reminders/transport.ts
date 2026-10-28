// Reminder transports. The Telegram token/chat id are read from SERVER-ONLY env vars
// and never leave the server (this module must not be imported client-side).
// api.telegram.org is unreachable in this environment, so the engine is written
// against the Transport interface and driven by mockTransport in tests/verify.
//
// ── WHY @/lib/env IS LOADED LAZILY (Faz 25 düzeltmesi) ────────────────────────────────
//
// This module used to `import { env } from "@/lib/env"` at the top. env.ts validates on module
// LOAD by design (Faz 15) and DATABASE_URL is required, so merely importing a transport pulled
// in a hard database requirement — for values this file only reads when send() is actually
// called.
//
// The consequence was absurd in exactly the way that proves it was wrong: `mockTransport`, the
// dependency-free test double whose entire purpose is to stand in without configuration, could
// not be imported without a DATABASE_URL. scripts/phase6b-verify.ts has imported nothing but
// mockTransport since Faz 6B and crashed on startup without one; phase25-verify.ts inherited
// the same failure and it was found only when the gate was run the way its own header documents.
//
// So the env read moved inside send(). Nothing is weakened: env.ts is still the single validated
// source (this file never touches process.env — that is the rule Faz 15 exists to enforce), and
// startup validation still happens, because @/lib/db imports env statically and every server
// path goes through the pool. What changes is that a transport is now importable by anything
// that only wants the interface or the mock, which is what a transport module should always
// have been.
//
// The import is inside each send()'s try block on purpose: a misconfigured environment must
// surface as a reported DeliveryResult failure, never as a throw, which is the property
// reminder_deliveries' 'failed' status depends on.
async function readEnv() {
  const { env } = await import("@/lib/env");
  return env;
}

export interface DeliveryResult {
  ok: boolean;
  error?: string;
}

export interface Transport {
  channel: "telegram" | "email";
  send(message: string): Promise<DeliveryResult>;
}

/**
 * Deterministic transport for tests/verify. Records nothing external.
 *
 * Faz 25 made the channel a parameter. It was hardcoded to "telegram", which was harmless while
 * telegram was the only implementation and would have made the email path untestable the moment
 * one existed — the mock would have claimed to be the wrong channel while standing in for it.
 */
export function mockTransport(
  opts: { failOn?: (msg: string) => boolean; channel?: Transport["channel"] } = {},
): Transport & { sent: string[] } {
  const sent: string[] = [];
  return {
    channel: opts.channel ?? "telegram",
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
      try {
        const env = await readEnv();
        const token = env.telegramBotToken;
        const chatId = env.telegramChatId;
        if (!token || !chatId) return { ok: false, error: "TELEGRAM_BOT_TOKEN/CHAT_ID tanımlı değil" };
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: message }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { ok: false, error: `telegram HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `telegram erişilemedi: ${(e as Error).message}` };
      }
    },
  };
}

/**
 * Email transport — Faz 25.
 *
 * DELIBERATELY NOT AN SMTP CLIENT. This repository makes no outbound network calls that work in
 * this environment, and adding nodemailer plus a credential set would introduce a dependency and
 * a secret to leak for a code path that cannot be exercised here. It follows the Telegram shape
 * instead: an HTTP endpoint named by env, a failed DeliveryResult when unset or unreachable, and
 * the real behaviour exercised through mockTransport({ channel: "email" }).
 *
 * The failure is reported, never thrown, and never contains the API key — a reminder that could
 * not be sent is a recorded outcome, not a crash, which is the same rule the Telegram transport
 * follows and the reason reminder_deliveries has a 'failed' status at all.
 */
export function emailTransport(): Transport {
  return {
    channel: "email",
    async send(message: string): Promise<DeliveryResult> {
      try {
        const env = await readEnv();
        const url = env.emailApiUrl;
        const to = env.emailTo;
        if (!url || !to) return { ok: false, error: "EMAIL_API_URL/EMAIL_TO tanımlı değil" };
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(env.emailApiKey ? { authorization: `Bearer ${env.emailApiKey}` } : {}),
          },
          body: JSON.stringify({ to, subject: "MAS Nakit Radar hatırlatma", text: message }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { ok: false, error: `e-posta HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `e-posta erişilemedi: ${(e as Error).message}` };
      }
    },
  };
}

/** Pick the transport for a channel. One place, so a new channel cannot be half-wired. */
export function transportFor(channel: Transport["channel"]): Transport {
  return channel === "email" ? emailTransport() : telegramTransport();
}
