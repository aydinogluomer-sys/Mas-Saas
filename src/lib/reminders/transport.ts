// Reminder & Telegram polling transports — Faz 25, Faz 40 (A2), Faz 42 (B2) & Phase E (Agent 06).
//
// `@/lib/env` is loaded LAZILY inside transport methods so pure verify scripts and tests can import
// `mockTransport`, `transportFor`, `splitTelegramMessage`, and `pollTelegramUpdates` without
// requiring `DATABASE_URL` at module load.

import type { ExternalOperationOutcomeKind } from "@/lib/contracts/remediation-contracts";

async function readEnv() {
  const { env } = await import("@/lib/env");
  return env;
}

export function redactBotToken(text: string): string {
  return text
    .replace(/bot[0-9A-Za-z:_-]+/g, "bot[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
}

/**
 * Single-pass HTML escaper for Telegram `parse_mode: "HTML"`.
 * Escapes ONLY `&`, `<`, and `>` in a single pass — never escapes `[`, `]`, or `_`.
 */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;",
  );
}

/**
 * Masks accidental raw Turkish IBANs (`TR` + 24 alphanumeric chars with optional whitespace/hyphens)
 * to `TR** **** **** **** **** **XX` and strips bot/bearer tokens before outbound Telegram egress.
 */
export function scrubSensitiveTelegramText(text: string): string {
  return redactBotToken(text).replace(
    /\bTR\d{2}[\s-]?(?:[0-9A-Z]{4}[\s-]?){5}([0-9A-Z]{2})\b/gi,
    (_match, lastTwo: string) => `TR** **** **** **** **** **${lastTwo.toUpperCase()}`,
  );
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripInlineMarkdownPlain(raw: string): string {
  return raw
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .trim();
}

function renderEmailMarkdownLineHtml(rawLine: string): { isHeading: boolean; html: string } {
  const trimmed = rawLine.trim();
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const cleanHeading = headingMatch[2].replace(/\*\*(.+?)\*\*/g, "$1").trim();
    return {
      isHeading: true,
      html: `<div style="margin:14px 0 6px 0;font-size:15px;font-weight:700;color:#0F172A;">${escapeHtml(cleanHeading)}</div>`,
    };
  }
  const escaped = escapeHtml(rawLine);
  const withBold = escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*\*/g, "");
  return { isHeading: false, html: withBold };
}

export function normalizeEmailRecipients(
  to: string | readonly string[] | null | undefined,
): string[] {
  if (!to) return [];
  const rawItems = typeof to === "string" ? to.split(/[,;]+/) : to;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawItems) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

export interface FolioEmailTemplateInput {
  title: string;
  preheader?: string;
  bodyText: string;
  rows?: ReadonlyArray<{ label: string; value: string }>;
  footerNote?: string;
}

/**
 * Builds a clean warm-parchment HTML table folio wrapper compatible with major email clients.
 * All dynamic strings are HTML-escaped to prevent injection.
 */
export function buildFolioEmailHtml(input: FolioEmailTemplateInput): string {
  const safeTitle = escapeHtml(stripInlineMarkdownPlain(input.title));
  const safePreheader = input.preheader
    ? escapeHtml(stripInlineMarkdownPlain(input.preheader))
    : safeTitle;
  const paragraphs = input.bodyText
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((block) => {
      const renderedLines = block.split(/\r?\n/).map(renderEmailMarkdownLineHtml);
      if (renderedLines.length === 1 && renderedLines[0].isHeading) {
        return renderedLines[0].html;
      }
      const combined = renderedLines
        .map((r) =>
          r.isHeading
            ? r.html
            : r.html,
        )
        .join("<br/>")
        .replace(/(<\/div>)<br\/>/g, "$1");
      return `<p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#1E293B;">${combined}</p>`;
    })
    .join("");

  const detailRowsHtml =
    input.rows && input.rows.length > 0
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse;background-color:#FAF6EE;border:1px solid #E5DEC9;border-radius:6px;">
          ${input.rows
            .map(
              (row) =>
                `<tr>
                  <td style="padding:8px 12px;border-bottom:1px solid #EDE6D6;font-size:12px;font-weight:600;color:#64748B;width:38%;">${escapeHtml(row.label)}</td>
                  <td style="padding:8px 12px;border-bottom:1px solid #EDE6D6;font-size:13px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums;">${escapeHtml(row.value)}</td>
                </tr>`,
            )
            .join("")}
        </table>`
      : "";

  const footer = escapeHtml(
    input.footerNote ?? "MAS Nakit Radar · Otomatik Finansal Bildirim Servisi",
  );

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:24px 12px;background-color:#F5EFE4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${safePreheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background-color:#FFFDF9;border:1px solid #E2D9C5;border-radius:8px;overflow:hidden;">
    <tr>
      <td style="padding:18px 24px;background-color:#FAF3E3;border-bottom:2px solid #B45309;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#92400E;margin-bottom:4px;">MAS NAKİT RADAR</div>
        <div style="font-size:18px;font-weight:700;color:#1E293B;">${safeTitle}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:24px;">
        ${paragraphs}
        ${detailRowsHtml}
      </td>
    </tr>
    <tr>
      <td style="padding:14px 24px;background-color:#FAF6EE;border-top:1px solid #E5DEC9;font-size:11px;color:#64748B;">
        ${footer}
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Telegram Bot API hard limit is 4096 UTF-16 code units per sendMessage call. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/**
 * Splits a long Telegram reply into safe chunks (`<= maxLen <= 4096`) without losing content.
 * Prefers paragraph (`\n\n`), line (`\n`), then word (` `) boundaries before falling back to a hard cut.
 */
export function splitTelegramMessage(text: string, maxLen = 4000): string[] {
  const limit = Math.max(1, Math.min(TELEGRAM_MAX_MESSAGE_CHARS, Math.floor(maxLen)));
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const minBreak = Math.max(1, Math.floor(limit * 0.3));

    let splitAt = -1;
    let consumeNewlineCount = 0;

    const paraIdx = window.lastIndexOf("\n\n");
    if (paraIdx >= minBreak) {
      splitAt = paraIdx;
      consumeNewlineCount = 2;
    } else {
      const lineIdx = window.lastIndexOf("\n");
      if (lineIdx >= minBreak) {
        splitAt = lineIdx;
        consumeNewlineCount = 1;
      } else {
        const spaceIdx = window.lastIndexOf(" ");
        if (spaceIdx >= minBreak) {
          splitAt = spaceIdx;
          consumeNewlineCount = 1;
        }
      }
    }

    if (splitAt <= 0) {
      chunks.push(window);
      remaining = remaining.slice(limit);
    } else {
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt + consumeNewlineCount);
    }
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

export const TELEGRAM_HTML_SAFE_MAX_CHARS = 3900;

const TRACKED_TELEGRAM_HTML_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "code",
  "pre",
]);

function computeUnclosedHtmlTagStack(fragment: string): Array<{ tag: string; openRaw: string }> {
  const stack: Array<{ tag: string; openRaw: string }> = [];
  const tagRe = /<(\/?)([a-zA-Z0-9]+)(?:\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(fragment)) !== null) {
    const isClose = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (!TRACKED_TELEGRAM_HTML_TAGS.has(tag)) continue;
    if (!isClose) {
      stack.push({ tag, openRaw: m[0] });
    } else {
      for (let idx = stack.length - 1; idx >= 0; idx--) {
        if (stack[idx].tag === tag) {
          stack.splice(idx, 1);
          break;
        }
      }
    }
  }
  return stack;
}

function adjustHtmlCutPosition(text: string, proposedPos: number): number {
  let pos = Math.max(1, Math.min(text.length, proposedPos));
  const slice = text.slice(0, pos);
  const lastOpenLt = slice.lastIndexOf("<");
  const lastCloseGt = slice.lastIndexOf(">");
  if (lastOpenLt > lastCloseGt && lastOpenLt > 0) {
    pos = lastOpenLt;
  }
  const entityTail = text.slice(0, pos).match(/&[a-zA-Z0-9#]{0,8}$/);
  if (entityTail && entityTail.index && entityTail.index > 0) {
    pos = entityTail.index;
  }
  return pos;
}

/**
 * Splits a Telegram HTML message into tag-safe chunks (`<= 3900` chars),
 * never slicing inside `<...>` or `&...;` and balancing open `<b>`/`<i>`/`<code>`/`<pre>` tags across chunks.
 */
export function splitTelegramHtmlMessage(html: string, maxLen = TELEGRAM_HTML_SAFE_MAX_CHARS): string[] {
  const limit = Math.max(64, Math.min(TELEGRAM_HTML_SAFE_MAX_CHARS, Math.floor(maxLen)));
  if (html.length <= limit) return [html];

  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > limit) {
    const safeWindowLen = Math.max(32, limit - 96);
    const window = remaining.slice(0, safeWindowLen);
    const minBreak = Math.max(1, Math.floor(safeWindowLen * 0.25));

    let splitAt = -1;
    let consumeNewlineCount = 0;

    const paraIdx = window.lastIndexOf("\n\n");
    if (paraIdx >= minBreak) {
      splitAt = paraIdx;
      consumeNewlineCount = 2;
    } else {
      const lineIdx = window.lastIndexOf("\n");
      if (lineIdx >= minBreak) {
        splitAt = lineIdx;
        consumeNewlineCount = 1;
      } else {
        const spaceIdx = window.lastIndexOf(" ");
        if (spaceIdx >= minBreak) {
          splitAt = spaceIdx;
          consumeNewlineCount = 1;
        }
      }
    }

    let rawChunk: string;
    if (splitAt <= 0) {
      const safeCut = adjustHtmlCutPosition(remaining, safeWindowLen);
      rawChunk = remaining.slice(0, safeCut);
      remaining = remaining.slice(safeCut);
    } else {
      const safeCut = adjustHtmlCutPosition(remaining, splitAt);
      rawChunk = remaining.slice(0, safeCut);
      remaining = remaining.slice(safeCut + (safeCut === splitAt ? consumeNewlineCount : 0));
    }

    const openStack = computeUnclosedHtmlTagStack(rawChunk);
    if (openStack.length > 0) {
      const closingSuffix = [...openStack].reverse().map((x) => `</${x.tag}>`).join("");
      const reopenPrefix = openStack.map((x) => x.openRaw).join("");
      chunks.push(`${rawChunk}${closingSuffix}`);
      if (remaining.length > 0) {
        remaining = `${reopenPrefix}${remaining}`;
      }
    } else {
      chunks.push(rawChunk);
    }
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

export interface DeliveryResult {
  ok: boolean;
  error?: string;
  /** Faz 40 (A2): True when an optional channel (e.g. email) is unconfigured and should record `'skipped'`. */
  skippedUnconfigured?: boolean;
  retryAfterSeconds?: number | null;
  uncertainOutcome?: boolean;
  failureKind?: ExternalOperationOutcomeKind;
  providerMessageIds?: string[];
  providerMessageId?: string | number | null;
  messageIds?: readonly (string | number)[];
}

function classifyFetchTransportException(
  fetchErr: unknown,
  chunksSentCount: number,
): { uncertainOutcome: boolean; failureKind: ExternalOperationOutcomeKind; safeMessage: string } {
  const errObj = fetchErr as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: { name?: unknown; code?: unknown; message?: unknown };
  } | null;
  const errName = typeof errObj?.name === "string" ? errObj.name : "";
  const causeName = typeof errObj?.cause?.name === "string" ? errObj.cause.name : "";
  const errCode = typeof errObj?.code === "string" ? errObj.code : "";
  const causeCode = typeof errObj?.cause?.code === "string" ? errObj.cause.code : "";
  const rawMsg =
    typeof errObj?.message === "string" ? errObj.message : String(fetchErr ?? "unknown error");
  const causeMsg = typeof errObj?.cause?.message === "string" ? errObj.cause.message : "";
  const combinedCode = `${errCode} ${causeCode}`;
  const combinedMsg = `${rawMsg} ${causeMsg}`;

  const definitelyPreConnect =
    /\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_INVALID_URL)\b/i.test(combinedCode) ||
    /\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_INVALID_URL)\b/i.test(combinedMsg);

  const isTimeout =
    errName === "TimeoutError" ||
    errName === "AbortError" ||
    causeName === "TimeoutError" ||
    causeName === "AbortError" ||
    /\b(?:ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b/i.test(combinedCode) ||
    /\b(?:ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b|timeout|timed\s*out|aborted/i.test(
      combinedMsg,
    );

  const isAmbiguousSocketReset =
    /\b(?:ECONNRESET|EPIPE|UND_ERR_SOCKET|ERR_SOCKET_CLOSED)\b/i.test(combinedCode) ||
    /\b(?:ECONNRESET|EPIPE|UND_ERR_SOCKET|ERR_SOCKET_CLOSED)\b|socket hang up|other side closed|connection reset/i.test(
      combinedMsg,
    );

  const safeMessage = redactBotToken(rawMsg);

  if (chunksSentCount > 0) {
    return {
      uncertainOutcome: true,
      failureKind: isTimeout ? "timeout" : "unknown_outcome",
      safeMessage,
    };
  }

  if (definitelyPreConnect && !isTimeout && !isAmbiguousSocketReset) {
    return {
      uncertainOutcome: false,
      failureKind: "temporary_infra_failure",
      safeMessage,
    };
  }

  if (isTimeout) {
    return {
      uncertainOutcome: true,
      failureKind: "timeout",
      safeMessage,
    };
  }

  if (isAmbiguousSocketReset) {
    return {
      uncertainOutcome: true,
      failureKind: "unknown_outcome",
      safeMessage,
    };
  }

  return {
    uncertainOutcome: false,
    failureKind: "temporary_infra_failure",
    safeMessage,
  };
}

export type NotificationChannel = "telegram" | "email" | "sms" | "whatsapp";

export interface TransportSendOptions {
  parseMode?: "HTML";
  subject?: string;
}

export interface Transport {
  channel: NotificationChannel;
  send(message: string, opts?: TransportSendOptions): Promise<DeliveryResult>;
}

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

function parseAllowedChatIdsSet(
  explicitAllowed: string | readonly string[] | undefined,
  envObj: { telegramChatId?: string; telegramAllowedChatIds?: string } | null,
): Set<string> {
  if (explicitAllowed !== undefined) {
    const rawList = typeof explicitAllowed === "string" ? explicitAllowed.split(",") : explicitAllowed;
    return new Set(rawList.map((s) => s.trim()).filter(Boolean));
  }
  const combined = [envObj?.telegramAllowedChatIds, envObj?.telegramChatId]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(",");
  if (!combined) return new Set();
  return new Set(combined.split(",").map((s) => s.trim()).filter(Boolean));
}

async function extractTelegramRetryAfterSeconds(res: Response): Promise<number | null> {
  try {
    const rawText = typeof res.text === "function" ? await res.text() : "";
    if (rawText) {
      const parsed = JSON.parse(rawText) as {
        parameters?: { retry_after?: unknown };
      };
      const bodyRetry = Number(parsed?.parameters?.retry_after);
      if (Number.isFinite(bodyRetry) && bodyRetry > 0) {
        return bodyRetry;
      }
    }
  } catch {
    // Fall back to Retry-After HTTP header when body is empty or non-JSON.
  }

  const headerVal = res.headers?.get?.("retry-after");
  if (headerVal) {
    const headerRetry = Number(headerVal.trim());
    if (Number.isFinite(headerRetry) && headerRetry > 0) {
      return headerRetry;
    }
  }
  return null;
}

export async function sendTelegramChatMessage(
  chatId: string,
  message: string,
  opts: {
    token?: string;
    fetchImpl?: typeof fetch;
    maxLen?: number;
    parseMode?: "HTML";
    allowedChatIds?: string | readonly string[];
  } = {},
): Promise<DeliveryResult> {
  try {
    const env = await readEnv();
    const token = opts.token ?? env.telegramBotToken;
    const normalizedChatId = String(chatId ?? "").trim();
    if (!token || !normalizedChatId) {
      return {
        ok: false,
        uncertainOutcome: false,
        failureKind: "permanent_config_failure",
        error: "TELEGRAM_BOT_TOKEN/CHAT_ID tanımlı değil",
      };
    }

    const allowedChats = parseAllowedChatIdsSet(
      opts.allowedChatIds,
      env as { telegramChatId?: string; telegramAllowedChatIds?: string },
    );
    if (allowedChats.size > 0) {
      if (!allowedChats.has(normalizedChatId)) {
        return {
          ok: false,
          uncertainOutcome: false,
          failureKind: "permission_failure",
          error: "telegram hedef chat_id izin listesinde değil",
        };
      }
    } else if (!opts.token) {
      return {
        ok: false,
        uncertainOutcome: false,
        failureKind: "permanent_config_failure",
        error: "TELEGRAM_BOT_TOKEN/CHAT_ID tanımlı değil",
      };
    }

    const scrubbedMessage = scrubSensitiveTelegramText(message);
    const fetchFn = opts.fetchImpl ?? fetch;
    const chunks =
      opts.parseMode === "HTML"
        ? splitTelegramHtmlMessage(scrubbedMessage, opts.maxLen ?? TELEGRAM_HTML_SAFE_MAX_CHARS)
        : splitTelegramMessage(scrubbedMessage, opts.maxLen ?? 4000);

    let chunksSentCount = 0;
    const providerMessageIds: string[] = [];

    for (const chunk of chunks) {
      const bodyPayload: Record<string, unknown> = {
        chat_id: normalizedChatId,
        text: chunk,
      };
      if (opts.parseMode === "HTML") {
        bodyPayload.parse_mode = "HTML";
      }

      let res: Response;
      try {
        res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bodyPayload),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (fetchErr) {
        const classified = classifyFetchTransportException(fetchErr, chunksSentCount);
        return {
          ok: false,
          uncertainOutcome: classified.uncertainOutcome,
          failureKind: classified.failureKind,
          providerMessageIds,
          providerMessageId: providerMessageIds[0] ?? null,
          messageIds: [...providerMessageIds],
          error: `telegram erişilemedi: ${classified.safeMessage}`,
        };
      }

      if (!res.ok) {
        if (res.status === 429) {
          const extractedRetry = await extractTelegramRetryAfterSeconds(res);
          return {
            ok: false,
            // Only schedule retry backoff when 0 chunks were delivered; partial multi-chunk 429 is uncertain!
            retryAfterSeconds: chunksSentCount === 0 ? extractedRetry : null,
            uncertainOutcome: chunksSentCount > 0,
            failureKind: "rate_limited",
            providerMessageIds,
            providerMessageId: providerMessageIds[0] ?? null,
            messageIds: [...providerMessageIds],
            error: `telegram HTTP 429`,
          };
        }
        const isGatewayTimeout = res.status === 504;
        const failureKind: ExternalOperationOutcomeKind =
          res.status === 401 || res.status === 403
            ? "permission_failure"
            : isGatewayTimeout
              ? "timeout"
              : res.status >= 500
                ? "temporary_infra_failure"
                : "permanent_config_failure";
        return {
          ok: false,
          uncertainOutcome: chunksSentCount > 0 || isGatewayTimeout,
          failureKind,
          providerMessageIds,
          providerMessageId: providerMessageIds[0] ?? null,
          messageIds: [...providerMessageIds],
          error: `telegram HTTP ${res.status}`,
        };
      }

      try {
        const rawText = typeof res.text === "function" ? await res.text() : "";
        if (rawText) {
          const parsed = JSON.parse(rawText) as {
            ok?: boolean;
            description?: string;
            result?: { message_id?: number | string };
          };
          if (parsed && parsed.ok === false) {
            return {
              ok: false,
              uncertainOutcome: chunksSentCount > 0,
              failureKind: "permanent_config_failure",
              providerMessageIds,
              providerMessageId: providerMessageIds[0] ?? null,
              messageIds: [...providerMessageIds],
              error: redactBotToken(parsed.description ?? "telegram API ok=false"),
            };
          }
          const msgId = parsed?.result?.message_id;
          if (
            (typeof msgId === "number" && Number.isFinite(msgId)) ||
            (typeof msgId === "string" && msgId.trim().length > 0)
          ) {
            providerMessageIds.push(String(msgId));
          }
        }
      } catch {
        // Ignore empty or non-JSON 200 OK responses in unit mocks.
      }
      chunksSentCount += 1;
    }

    return {
      ok: true,
      uncertainOutcome: false,
      failureKind: "success",
      providerMessageIds,
      providerMessageId: providerMessageIds[0] ?? null,
      messageIds: [...providerMessageIds],
    };
  } catch (e) {
    const classified = classifyFetchTransportException(e, 0);
    return {
      ok: false,
      uncertainOutcome: classified.uncertainOutcome,
      failureKind: classified.failureKind,
      error: `telegram erişilemedi: ${classified.safeMessage}`,
    };
  }
}

export function telegramTransport(defaultOpts: { parseMode?: "HTML" } = {}): Transport {
  return {
    channel: "telegram",
    async send(message: string, sendOpts?: TransportSendOptions): Promise<DeliveryResult> {
      try {
        const env = await readEnv();
        const token = env.telegramBotToken;
        const chatId = env.telegramChatId;
        if (!token || !chatId) {
          return {
            ok: false,
            uncertainOutcome: false,
            failureKind: "permanent_config_failure",
            error: "TELEGRAM_BOT_TOKEN/CHAT_ID tanımlı değil",
          };
        }
        return await sendTelegramChatMessage(chatId, message, {
          token,
          parseMode: sendOpts?.parseMode ?? defaultOpts.parseMode,
        });
      } catch (e) {
        const classified = classifyFetchTransportException(e, 0);
        return {
          ok: false,
          uncertainOutcome: classified.uncertainOutcome,
          failureKind: classified.failureKind,
          error: `telegram erişilemedi: ${classified.safeMessage}`,
        };
      }
    },
  };
}

export interface TelegramIncomingMessage {
  message_id: number;
  chat: {
    id: number | string;
    type?: string;
  };
  from?: {
    id?: number;
    is_bot?: boolean;
  };
  date?: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramIncomingMessage;
}

export type TelegramPollResult =
  | { ok: true; updates: TelegramUpdate[] }
  | { ok: false; status?: number; error: string };

/**
 * Long-polls Telegram `getUpdates` without dropping pending updates (`offset` is caller-managed).
 * Kept in `src/lib/reminders/transport.ts` so all Telegram egress stays behind the single
 * `boundary-verify.ts` allow-listed module.
 */
export async function pollTelegramUpdates(
  offset: number,
  timeoutSec = 25,
  signal?: AbortSignal,
  opts: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<TelegramPollResult> {
  try {
    const token = opts.token ?? (await readEnv()).telegramBotToken;
    if (!token) {
      return { ok: false, error: "TELEGRAM_BOT_TOKEN tanımlı değil" };
    }
    const clampedTimeout = Math.max(0, Math.min(50, Math.floor(timeoutSec)));
    const timeoutSignal = AbortSignal.timeout((clampedTimeout + 10) * 1_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const fetchFn = opts.fetchImpl ?? fetch;

    const res = await fetchFn(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offset: Math.max(0, Math.floor(offset)),
        timeout: clampedTimeout,
        allowed_updates: ["message"],
      }),
      signal: combinedSignal,
    });

    if (!res.ok) {
      return { ok: false, status: res.status, error: `telegram getUpdates HTTP ${res.status}` };
    }

    const payload = (await res.json()) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
    };

    if (!payload || payload.ok !== true || !Array.isArray(payload.result)) {
      return {
        ok: false,
        error: redactBotToken(payload?.description ?? "telegram getUpdates geçersiz yanıt döndürdü"),
      };
    }

    const updates: TelegramUpdate[] = [];
    for (const raw of payload.result) {
      if (!raw || typeof raw !== "object") continue;
      const u = raw as Record<string, unknown>;
      if (typeof u.update_id !== "number" || !Number.isInteger(u.update_id)) continue;
      let msg: TelegramIncomingMessage | undefined;
      if (u.message && typeof u.message === "object") {
        const m = u.message as Record<string, unknown>;
        const chat = m.chat && typeof m.chat === "object" ? (m.chat as Record<string, unknown>) : null;
        if (chat && (typeof chat.id === "number" || typeof chat.id === "string")) {
          const rawFrom = m.from && typeof m.from === "object" ? (m.from as Record<string, unknown>) : null;
          const parsedFrom =
            rawFrom && (typeof rawFrom.id === "number" || typeof rawFrom.is_bot === "boolean")
              ? {
                  ...(typeof rawFrom.id === "number" ? { id: rawFrom.id } : {}),
                  ...(typeof rawFrom.is_bot === "boolean" ? { is_bot: rawFrom.is_bot } : {}),
                }
              : undefined;
          msg = {
            message_id: typeof m.message_id === "number" ? m.message_id : 0,
            chat: {
              id: chat.id,
              type: typeof chat.type === "string" ? chat.type : undefined,
            },
            ...(parsedFrom ? { from: parsedFrom } : {}),
            date: typeof m.date === "number" ? m.date : undefined,
            text: typeof m.text === "string" ? m.text : undefined,
          };
        }
      }
      updates.push({ update_id: u.update_id, message: msg });
    }

    return { ok: true, updates };
  } catch (e) {
    return { ok: false, error: `telegram getUpdates erişilemedi: ${redactBotToken((e as Error).message)}` };
  }
}

async function validateOutboundHttpsUrl(
  rawUrl: string,
  label: string,
): Promise<string | null> {
  const { isPrivateOrLoopbackHost } = await import("@/lib/env");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `${label} geçerli bir HTTPS URL olmalı`;
  }
  if (parsed.protocol !== "https:") {
    return `${label} yalnız 'https://' protokolünü kullanabilir`;
  }
  if (parsed.username || parsed.password) {
    return `${label} kullanıcı adı veya parola içeremez`;
  }
  if (isPrivateOrLoopbackHost(parsed.hostname.toLowerCase())) {
    return `${label} yerel veya özel ağ adresine (SSRF) işaret edemez`;
  }
  return null;
}

export interface TransactionalEmailPayload {
  to: string | readonly string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
  rows?: ReadonlyArray<{ label: string; value: string }>;
  footerNote?: string;
}

export interface TransactionalEmailOptions {
  apiUrl?: string;
  apiKey?: string;
  from?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Sends a multi-recipient transactional email with a warm-parchment HTML folio wrapper.
 * Falls back cleanly to `{ ok: false, skippedUnconfigured: true }` when `EMAIL_API_URL` is unset.
 */
export async function sendTransactionalEmail(
  payload: TransactionalEmailPayload,
  opts: TransactionalEmailOptions = {},
): Promise<DeliveryResult> {
  try {
    const env = await readEnv();
    const url = opts.apiUrl ?? env.emailApiUrl;
    const recipients = normalizeEmailRecipients(payload.to);
    if (!url || recipients.length === 0) {
      return {
        ok: false,
        skippedUnconfigured: true,
        error: !url
          ? "skipped_unconfigured: EMAIL_API_URL tanımlı değil"
          : "skipped_unconfigured: alıcı e-posta adresi tanımlı değil",
      };
    }
    const urlErr = await validateOutboundHttpsUrl(url, "EMAIL_API_URL");
    if (urlErr) {
      return { ok: false, error: urlErr };
    }
    const apiKey = opts.apiKey ?? env.emailApiKey;
    const senderFrom = payload.from ?? opts.from ?? env.emailFrom;
    const html =
      payload.html ??
      buildFolioEmailHtml({
        title: payload.subject,
        bodyText: payload.text,
        rows: payload.rows,
        footerNote: payload.footerNote,
      });
    const fetchFn = opts.fetchImpl ?? fetch;
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...(senderFrom ? { from: senderFrom } : {}),
        to: recipients,
        subject: payload.subject,
        text: payload.text,
        html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `e-posta HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `e-posta erişilemedi: ${redactBotToken((e as Error).message)}` };
  }
}

export function emailTransport(
  opts: {
    to?: string | readonly string[];
    apiUrl?: string;
    apiKey?: string;
    from?: string;
    subject?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Transport {
  return {
    channel: "email",
    async send(message: string): Promise<DeliveryResult> {
      try {
        const env = await readEnv();
        const url = opts.apiUrl ?? env.emailApiUrl;
        const recipients = normalizeEmailRecipients(opts.to ?? env.emailTo);
        if (!url || recipients.length === 0) {
          return {
            ok: false,
            skippedUnconfigured: true,
            error: "skipped_unconfigured: EMAIL_API_URL/EMAIL_TO tanımlı değil",
          };
        }
        return await sendTransactionalEmail(
          {
            to: recipients,
            subject: opts.subject ?? "MAS Nakit Radar hatırlatma",
            text: message,
          },
          {
            apiUrl: url,
            apiKey: opts.apiKey ?? env.emailApiKey,
            from: opts.from ?? env.emailFrom,
            fetchImpl: opts.fetchImpl,
          },
        );
      } catch (e) {
        return { ok: false, error: `e-posta erişilemedi: ${redactBotToken((e as Error).message)}` };
      }
    },
  };
}

export function smsTransport(
  opts: {
    to?: string;
    apiUrl?: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Transport {
  return {
    channel: "sms",
    async send(message: string): Promise<DeliveryResult> {
      try {
        const env = await readEnv();
        const url = opts.apiUrl ?? env.smsApiUrl;
        const to = (opts.to ?? env.smsRecipient ?? "").trim();
        if (!url || !to) {
          return {
            ok: false,
            skippedUnconfigured: true,
            error: "skipped_unconfigured: SMS_API_URL/SMS_RECIPIENT tanımlı değil",
          };
        }
        const urlErr = await validateOutboundHttpsUrl(url, "SMS_API_URL");
        if (urlErr) {
          return { ok: false, error: urlErr };
        }
        const apiKey = opts.apiKey ?? env.smsApiKey;
        const fetchFn = opts.fetchImpl ?? fetch;
        const res = await fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ to, message }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { ok: false, error: `SMS HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `SMS erişilemedi: ${redactBotToken((e as Error).message)}` };
      }
    },
  };
}

export function whatsappTransport(
  opts: {
    to?: string;
    apiUrl?: string;
    apiToken?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Transport {
  return {
    channel: "whatsapp",
    async send(message: string): Promise<DeliveryResult> {
      try {
        const env = await readEnv();
        const url = opts.apiUrl ?? env.whatsappApiUrl;
        const to = (opts.to ?? env.whatsappRecipient ?? "").trim();
        if (!url || !to) {
          return {
            ok: false,
            skippedUnconfigured: true,
            error: "skipped_unconfigured: WHATSAPP_API_URL/WHATSAPP_RECIPIENT tanımlı değil",
          };
        }
        const urlErr = await validateOutboundHttpsUrl(url, "WHATSAPP_API_URL");
        if (urlErr) {
          return { ok: false, error: urlErr };
        }
        const apiToken = opts.apiToken ?? env.whatsappApiToken;
        const fetchFn = opts.fetchImpl ?? fetch;
        const res = await fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: { body: message },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { ok: false, error: `WhatsApp HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `WhatsApp erişilemedi: ${redactBotToken((e as Error).message)}` };
      }
    },
  };
}

export interface CounterpartyReminderInput {
  partyName: string;
  email?: string | readonly string[] | null;
  phone?: string | null;
  whatsappPhone?: string | null;
  invoiceNo?: string | null;
  dueDate?: string | null;
  amountFormatted?: string | null;
  currency?: string | null;
  customMessage?: string | null;
  channels?: ReadonlyArray<"email" | "sms" | "whatsapp">;
}

export interface CounterpartyReminderTransportOpts {
  emailApiUrl?: string;
  emailApiKey?: string;
  emailFrom?: string;
  smsApiUrl?: string;
  smsApiKey?: string;
  whatsappApiUrl?: string;
  whatsappApiToken?: string;
  fetchImpl?: typeof fetch;
}

export interface CounterpartyReminderOutcome {
  results: Partial<Record<"email" | "sms" | "whatsapp", DeliveryResult>>;
  anySent: boolean;
}

/**
 * Multi-channel counterparty payment/collection reminder helper.
 * Dispatches warm-parchment folio email, SMS, and/or WhatsApp messages to a specific counterparty,
 * returning honest `skippedUnconfigured: true` per channel when unconfigured without throwing.
 */
export async function sendCounterpartyReminder(
  input: CounterpartyReminderInput,
  opts: CounterpartyReminderTransportOpts = {},
): Promise<CounterpartyReminderOutcome> {
  const channels: ReadonlyArray<"email" | "sms" | "whatsapp"> =
    input.channels && input.channels.length > 0 ? input.channels : ["email", "sms", "whatsapp"];

  const summaryRows: Array<{ label: string; value: string }> = [
    { label: "Cari Ünvan", value: input.partyName },
  ];
  if (input.invoiceNo) {
    summaryRows.push({ label: "Belge / Fatura No", value: input.invoiceNo });
  }
  if (input.dueDate) {
    summaryRows.push({ label: "Vade Tarihi", value: input.dueDate });
  }
  if (input.amountFormatted) {
    const ccy = input.currency ? ` ${input.currency}` : "";
    summaryRows.push({ label: "Tutar", value: `${input.amountFormatted}${ccy}` });
  }

  const defaultBodyParts = [`Sayın ${input.partyName},`];
  if (input.invoiceNo && input.amountFormatted) {
    const ccy = input.currency ? ` ${input.currency}` : "";
    const duePart = input.dueDate ? ` (${input.dueDate} vadeli)` : "";
    defaultBodyParts.push(
      `${input.invoiceNo} numaralı${duePart} ${input.amountFormatted}${ccy} tutarındaki bakiyenize ilişkin hatırlatmamızı bilgilerinize sunarız.`,
    );
  } else {
    defaultBodyParts.push("Cari hesap bakiyenize ilişkin ödeme hatırlatmamızı bilgilerinize sunarız.");
  }
  const messageText = input.customMessage?.trim() || defaultBodyParts.join("\n\n");
  const subject = input.invoiceNo
    ? `Ödeme Hatırlatması — ${input.invoiceNo} (${input.partyName})`
    : `Ödeme Hatırlatması — ${input.partyName}`;

  const results: Partial<Record<"email" | "sms" | "whatsapp", DeliveryResult>> = {};

  for (const ch of channels) {
    if (ch === "email") {
      results.email = await sendTransactionalEmail(
        {
          to: input.email ?? [],
          subject,
          text: messageText,
          rows: summaryRows,
        },
        {
          apiUrl: opts.emailApiUrl,
          apiKey: opts.emailApiKey,
          from: opts.emailFrom,
          fetchImpl: opts.fetchImpl,
        },
      );
    } else if (ch === "sms") {
      results.sms = await smsTransport({
        to: input.phone ?? undefined,
        apiUrl: opts.smsApiUrl,
        apiKey: opts.smsApiKey,
        fetchImpl: opts.fetchImpl,
      }).send(messageText.replace(/\s+/g, " ").trim());
    } else if (ch === "whatsapp") {
      results.whatsapp = await whatsappTransport({
        to: input.whatsappPhone ?? input.phone ?? undefined,
        apiUrl: opts.whatsappApiUrl,
        apiToken: opts.whatsappApiToken,
        fetchImpl: opts.fetchImpl,
      }).send(messageText);
    }
  }

  const anySent = Object.values(results).some((r) => r?.ok === true);
  return { results, anySent };
}

export function transportFor(channel: Transport["channel"]): Transport {
  switch (channel) {
    case "email":
      return emailTransport();
    case "sms":
      return smsTransport();
    case "whatsapp":
      return whatsappTransport();
    case "telegram":
    default:
      return telegramTransport();
  }
}
