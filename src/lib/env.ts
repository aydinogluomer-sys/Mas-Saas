// Faz 15 & Faz 40 (A2) — single validated server-side environment module.
import { z } from "zod";

if (typeof window !== "undefined") {
  throw new Error("@/lib/env yalnız sunucu tarafına aittir; client bileşeninden import edilemez.");
}

function optional(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

import {
  isLoopbackHostname,
  isPrivateOrLoopbackHost,
  validateEmailApiUrl,
} from "./env-validators";

export { isLoopbackHostname, isPrivateOrLoopbackHost, validateEmailApiUrl };

function validateHttpsNotificationUrl(envName: string, rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return `${envName} geçerli bir HTTPS URL olmalı.`;
  }
  if (parsedUrl.protocol !== "https:") {
    return `${envName} yalnız 'https://' protokolünü kullanabilir.`;
  }
  if (parsedUrl.username || parsedUrl.password) {
    return `${envName} kullanıcı adı veya parola içeremez.`;
  }
  if (isPrivateOrLoopbackHost(parsedUrl.hostname.toLowerCase())) {
    return `${envName} yerel veya özel ağ adresine (SSRF) işaret edemez.`;
  }
  return null;
}

const schema = z
  .object({
    DATABASE_URL: z
      .string({ error: "DATABASE_URL zorunlu." })
      .min(1, "DATABASE_URL boş olamaz.")
      .refine(
        (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
        "DATABASE_URL 'postgres://' veya 'postgresql://' ile başlamalı.",
      ),
    MIGRATION_DATABASE_URL: z
      .string()
      .refine(
        (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
        "MIGRATION_DATABASE_URL 'postgres://' veya 'postgresql://' ile başlamalı.",
      )
      .optional(),
    DATABASE_POOL_MAX: z.string().optional(),
    DATABASE_STATEMENT_TIMEOUT_MS: z.string().optional(),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
    TELEGRAM_INTERNAL_API_KEY: z.string().min(32).optional(),
    MAS_APP_BASE_URL: z.string().url().optional(),
    EMAIL_API_URL: z.string().optional(),
    MAS_ALLOWED_EMAIL_HOSTS: z.string().optional(),
    EMAIL_API_KEY: z.string().optional(),
    EMAIL_TO: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    SMS_API_URL: z.string().optional(),
    SMS_API_KEY: z.string().optional(),
    SMS_RECIPIENT: z.string().optional(),
    WHATSAPP_API_URL: z.string().optional(),
    WHATSAPP_API_TOKEN: z.string().optional(),
    WHATSAPP_RECIPIENT: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().optional(),
    AI_FORCE_DETERMINISTIC: z.string().optional(),
    MAS_TRUST_PROXY: z.string().optional(),
    MAS_QA_BYPASS_AUTH: z.string().optional(),
    MAS_LOCAL_PASSWORDLESS: z.string().optional(),
    MAS_LOCAL_WORKSTATION_AUTOLOGIN: z.string().optional(),
    APP_COMMIT_SHA: z.string().optional(),
    APP_BUILD_TIME: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    const emailErr = validateEmailApiUrl(val.EMAIL_API_URL, val.MAS_ALLOWED_EMAIL_HOSTS);
    if (emailErr) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["EMAIL_API_URL"], message: emailErr });
    }
    const smsErr = validateHttpsNotificationUrl("SMS_API_URL", val.SMS_API_URL);
    if (smsErr) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SMS_API_URL"], message: smsErr });
    }
    const waErr = validateHttpsNotificationUrl("WHATSAPP_API_URL", val.WHATSAPP_API_URL);
    if (waErr) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["WHATSAPP_API_URL"], message: waErr });
    }
  });

const parsed = schema.safeParse({
  DATABASE_URL:
    process.env.DATABASE_URL ||
    (process.env.VITEST === "true"
      ? "postgresql://unit_test_no_connect:x@127.0.0.1:5432/mas_radar_unit_dummy"
      : undefined),
  MIGRATION_DATABASE_URL: optional(process.env.MIGRATION_DATABASE_URL),
  DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
  DATABASE_STATEMENT_TIMEOUT_MS: optional(process.env.DATABASE_STATEMENT_TIMEOUT_MS),
  TELEGRAM_BOT_TOKEN: optional(process.env.TELEGRAM_BOT_TOKEN),
  TELEGRAM_CHAT_ID: optional(process.env.TELEGRAM_CHAT_ID),
  TELEGRAM_INTERNAL_API_KEY: optional(process.env.TELEGRAM_INTERNAL_API_KEY),
  MAS_APP_BASE_URL: optional(process.env.MAS_APP_BASE_URL),
  EMAIL_API_URL: optional(process.env.EMAIL_API_URL),
  MAS_ALLOWED_EMAIL_HOSTS: optional(process.env.MAS_ALLOWED_EMAIL_HOSTS),
  EMAIL_API_KEY: optional(process.env.EMAIL_API_KEY),
  EMAIL_TO: optional(process.env.EMAIL_TO),
  EMAIL_FROM: optional(process.env.EMAIL_FROM),
  SMS_API_URL: optional(process.env.SMS_API_URL),
  SMS_API_KEY: optional(process.env.SMS_API_KEY),
  SMS_RECIPIENT: optional(process.env.SMS_RECIPIENT),
  WHATSAPP_API_URL: optional(process.env.WHATSAPP_API_URL),
  WHATSAPP_API_TOKEN: optional(process.env.WHATSAPP_API_TOKEN),
  WHATSAPP_RECIPIENT: optional(process.env.WHATSAPP_RECIPIENT),
  OPENAI_API_KEY: optional(process.env.OPENAI_API_KEY),
  OPENAI_MODEL: optional(process.env.OPENAI_MODEL),
  AI_FORCE_DETERMINISTIC: optional(process.env.AI_FORCE_DETERMINISTIC),
  MAS_TRUST_PROXY: optional(process.env.MAS_TRUST_PROXY),
  MAS_QA_BYPASS_AUTH: optional(process.env.MAS_QA_BYPASS_AUTH),
  MAS_LOCAL_PASSWORDLESS: optional(process.env.MAS_LOCAL_PASSWORDLESS),
  MAS_LOCAL_WORKSTATION_AUTOLOGIN: optional(process.env.MAS_LOCAL_WORKSTATION_AUTOLOGIN),
  APP_COMMIT_SHA: optional(process.env.APP_COMMIT_SHA),
  APP_BUILD_TIME: optional(process.env.APP_BUILD_TIME),
});

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(kök)"}: ${i.message}`);
  throw new Error(`Ortam değişkeni doğrulaması başarısız (${lines.length} sorun):\n${lines.join("\n")}`);
}

const raw = parsed.data;

function resolvePoolMax(value: string | undefined): number {
  const configured = Number(value ?? 10);
  return Number.isFinite(configured) ? Math.min(20, Math.max(2, configured)) : 10;
}

function resolveStatementTimeoutMs(value: string | undefined): number {
  const configured = Number(value ?? 30_000);
  return Number.isFinite(configured) && configured >= 500 ? Math.min(60_000, Math.round(configured)) : 30_000;
}

export const env = Object.freeze({
  databaseUrl: raw.DATABASE_URL,
  migrationDatabaseUrl: raw.MIGRATION_DATABASE_URL ?? raw.DATABASE_URL,
  databasePoolMax: resolvePoolMax(raw.DATABASE_POOL_MAX),
  databaseStatementTimeoutMs: resolveStatementTimeoutMs(raw.DATABASE_STATEMENT_TIMEOUT_MS),
  telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
  telegramChatId: raw.TELEGRAM_CHAT_ID,
  telegramInternalApiKey: raw.TELEGRAM_INTERNAL_API_KEY,
  masAppBaseUrl: raw.MAS_APP_BASE_URL,
  emailApiUrl: raw.EMAIL_API_URL,
  masAllowedEmailHosts: raw.MAS_ALLOWED_EMAIL_HOSTS,
  emailApiKey: raw.EMAIL_API_KEY,
  emailTo: raw.EMAIL_TO,
  emailFrom: raw.EMAIL_FROM,
  smsApiUrl: raw.SMS_API_URL,
  smsApiKey: raw.SMS_API_KEY,
  smsRecipient: raw.SMS_RECIPIENT,
  whatsappApiUrl: raw.WHATSAPP_API_URL,
  whatsappApiToken: raw.WHATSAPP_API_TOKEN,
  whatsappRecipient: raw.WHATSAPP_RECIPIENT,
  openaiApiKey: raw.OPENAI_API_KEY,
  openaiModel: raw.OPENAI_MODEL ?? "gpt-5.5",

  /**
   * Faz 40 (A2): Closed-circuit default is `"1"` (`true`).
   * External LLM calls stay disabled unless an operator explicitly sets `AI_FORCE_DETERMINISTIC=0`.
   */
  get aiForceDeterministic(): boolean {
    const v = process.env.AI_FORCE_DETERMINISTIC;
    if (v === undefined || v === "") return true;
    return v === "1" || v.toLowerCase() === "true";
  },
  /** Faz 40 (A2): Trust `X-Forwarded-For` / `X-Real-IP` only behind a trusted reverse proxy. */
  get masTrustProxy(): boolean {
    const v = process.env.MAS_TRUST_PROXY;
    return v === "1" || v?.toLowerCase() === "true";
  },
  get qaBypassAuth(): boolean {
    return process.env.MAS_QA_BYPASS_AUTH === "1";
  },
  get localPasswordless(): boolean {
    if (process.env.NODE_ENV === "production") {
      return false;
    }
    if (process.env.NODE_ENV === "test" && process.env.MAS_ALLOW_PASSWORDLESS_IN_TEST !== "1") {
      return false;
    }
    if (process.env.MAS_LOCAL_PASSWORDLESS !== "1") {
      return false;
    }
    try {
      const dbUrl = process.env.DATABASE_URL || raw.DATABASE_URL;
      return isLoopbackHostname(new URL(dbUrl).hostname);
    } catch {
      return false;
    }
  },
  get localWorkstationAutologin(): boolean {
    if (process.env.NODE_ENV === "test") {
      return false;
    }
    if (process.env.MAS_LOCAL_WORKSTATION_AUTOLOGIN !== "1") {
      return false;
    }
    try {
      const dbUrl = process.env.DATABASE_URL || raw.DATABASE_URL;
      const parsedUrl = new URL(dbUrl);
      if (!isLoopbackHostname(parsedUrl.hostname)) {
        return false;
      }
      const dbName = parsedUrl.pathname.replace(/^\/+/, "");
      if (!dbName || /(_verify|_clone|_smoke|_drill|_e2e|_test|_tmp|testsprite|unit_dummy)/i.test(dbName)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  },
  get perfProbeEnabled(): boolean {
    return process.env.MAS_PERF_PROBE === "1";
  },
  appCommitSha: raw.APP_COMMIT_SHA ?? "unknown",
  appBuildTime: raw.APP_BUILD_TIME ?? "unknown",
});

export type Env = typeof env;

export interface EnvPresence {
  name: string;
  required: boolean;
  set: boolean;
  note: string;
}

export function envPresence(): EnvPresence[] {
  const isSet = (v: string | undefined): boolean => v !== undefined && v !== "";
  return [
    { name: "DATABASE_URL", required: true, set: isSet(process.env.DATABASE_URL), note: "Uygulama runtime bağlantısı (mas_radar_app)" },
    { name: "MIGRATION_DATABASE_URL", required: false, set: isSet(process.env.MIGRATION_DATABASE_URL), note: "Owner bağlantısı; yoksa DATABASE_URL'e düşer" },
    { name: "DATABASE_POOL_MAX", required: false, set: isSet(process.env.DATABASE_POOL_MAX), note: "Havuz boyutu; varsayılan 10" },
    { name: "TELEGRAM_BOT_TOKEN", required: false, set: isSet(process.env.TELEGRAM_BOT_TOKEN), note: "Hatırlatma gönderimi; yoksa dürüstçe 'failed' loglanır" },
    { name: "TELEGRAM_CHAT_ID", required: false, set: isSet(process.env.TELEGRAM_CHAT_ID), note: "Hatırlatma hedefi ve Telegram asistanının izin verdiği tek sohbet; yoksa asistan kapalı" },
    { name: "TELEGRAM_INTERNAL_API_KEY", required: false, set: isSet(process.env.TELEGRAM_INTERNAL_API_KEY), note: "Yerel Telegram asistanı servis kimliği (en az 32 karakter); yoksa asistan kapalı" },
    { name: "MAS_APP_BASE_URL", required: false, set: isSet(process.env.MAS_APP_BASE_URL), note: "Telegram worker için yerel MAS SaaS adresi" },
    { name: "EMAIL_API_URL", required: false, set: isSet(process.env.EMAIL_API_URL), note: "HTTPS e-posta API ucu (MAS_ALLOWED_EMAIL_HOSTS ile doğrulanır)" },
    { name: "EMAIL_FROM", required: false, set: isSet(process.env.EMAIL_FROM), note: "Giden e-posta gönderici adresi (opsiyonel)" },
    { name: "SMS_API_URL", required: false, set: isSet(process.env.SMS_API_URL), note: "HTTPS SMS ağ geçidi ucu; yoksa dürüstçe 'skipped' döner" },
    { name: "WHATSAPP_API_URL", required: false, set: isSet(process.env.WHATSAPP_API_URL), note: "HTTPS WhatsApp Business API ucu; yoksa dürüstçe 'skipped' döner" },
    { name: "OPENAI_API_KEY", required: false, set: isSet(process.env.OPENAI_API_KEY), note: "Yoksa AI yanıtları deterministik olgulara düşer" },
    { name: "OPENAI_MODEL", required: false, set: isSet(process.env.OPENAI_MODEL), note: `Varsayılan: ${env.openaiModel}` },
    { name: "AI_FORCE_DETERMINISTIC", required: false, set: isSet(process.env.AI_FORCE_DETERMINISTIC), note: "Varsayılan 1 (kapalı devre); yalnız 0 iken harici model çağrılabilir" },
    { name: "MAS_TRUST_PROXY", required: false, set: isSet(process.env.MAS_TRUST_PROXY), note: "Varsayılan kapalı; yalnız güvenilir ters vekil arkasında 1 yapılır" },
    { name: "MAS_QA_BYPASS_AUTH", required: false, set: isSet(process.env.MAS_QA_BYPASS_AUTH), note: "Yalnız TestSprite; production'da etkisiz" },
    { name: "MAS_LOCAL_PASSWORDLESS", required: false, set: isSet(process.env.MAS_LOCAL_PASSWORDLESS), note: "Yalnız loopback (127.0.0.1/localhost/::1) yerel geliştirme; varsayılan kapalı" },
    { name: "MAS_PERF_PROBE", required: false, set: isSet(process.env.MAS_PERF_PROBE), note: "Yalnız route SLO ölçüm sunucusu; 1 değilse /api/perf-probe 404" },
    { name: "APP_COMMIT_SHA", required: false, set: isSet(process.env.APP_COMMIT_SHA), note: "Sürüm izlenebilirliği" },
    { name: "APP_BUILD_TIME", required: false, set: isSet(process.env.APP_BUILD_TIME), note: "Sürüm izlenebilirliği" },
  ];
}
