// Faz 15 — the single place server-side environment variables are read and validated.
//
// Before this module, seven files reached into `process.env` directly, each with its own
// ad-hoc fallback, and a typo in a variable name surfaced as a confusing runtime symptom
// (a silent deterministic AI answer, a reminder that "failed" honestly, a pool of 2
// connections) rather than as an error at startup. Validation happens once, at module load,
// and reports every problem at once instead of one per restart.
//
// SERVER ONLY. There is no `server-only` package in this project's dependencies, so the
// guard is explicit: importing this from a client component throws as the module loads,
// which is exactly the failure a build-time marker would produce.
//
// NODE_ENV is deliberately NOT part of this module. Next.js inlines `process.env.NODE_ENV`
// at build time and it is read from a client component too
// (src/components/ui/navigation-feedback.tsx), so routing it through here would break that
// inlining. The three call sites that need it keep reading `process.env.NODE_ENV` directly.
import { z } from "zod";

if (typeof window !== "undefined") {
  throw new Error("@/lib/env yalnız sunucu tarafına aittir; client bileşeninden import edilemez.");
}

/** Every optional variable below treats an empty string exactly like an unset one. This is
 * not cosmetic: .env.example ships several keys with empty values (TELEGRAM_BOT_TOKEN=,
 * MAS_QA_BYPASS_AUTH=, ...), and the previous direct reads all handled "" as "off". A strict
 * schema would instead turn a stock .env.local into a fatal boot error. */
function optional(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

const schema = z.object({
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
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_INTERNAL_API_KEY: z.string().min(32).optional(),
  MAS_APP_BASE_URL: z.string().url().optional(),
  // Faz 25 — the email channel. Optional exactly like the Telegram pair: unset means the
  // transport reports an honest failure, never a silent success. No SMTP client is introduced;
  // this posts to a configured HTTP endpoint, the same shape the Telegram transport uses.
  EMAIL_API_URL: z.string().optional(),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_TO: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  // Left as a loose string rather than z.enum(["0","1"]) on purpose: the original reads were
  // `=== "1"` comparisons, so any other value simply meant "off". Tightening this to an enum
  // would convert a harmless typo into a boot failure — a behaviour change, not a fix.
  AI_FORCE_DETERMINISTIC: z.string().optional(),
  MAS_QA_BYPASS_AUTH: z.string().optional(),
  APP_COMMIT_SHA: z.string().optional(),
  APP_BUILD_TIME: z.string().optional(),
});

const parsed = schema.safeParse({
  DATABASE_URL: process.env.DATABASE_URL,
  MIGRATION_DATABASE_URL: optional(process.env.MIGRATION_DATABASE_URL),
  DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
  TELEGRAM_BOT_TOKEN: optional(process.env.TELEGRAM_BOT_TOKEN),
  TELEGRAM_CHAT_ID: optional(process.env.TELEGRAM_CHAT_ID),
  TELEGRAM_INTERNAL_API_KEY: optional(process.env.TELEGRAM_INTERNAL_API_KEY),
  MAS_APP_BASE_URL: optional(process.env.MAS_APP_BASE_URL),
  EMAIL_API_URL: optional(process.env.EMAIL_API_URL),
  EMAIL_API_KEY: optional(process.env.EMAIL_API_KEY),
  EMAIL_TO: optional(process.env.EMAIL_TO),
  OPENAI_API_KEY: optional(process.env.OPENAI_API_KEY),
  OPENAI_MODEL: optional(process.env.OPENAI_MODEL),
  AI_FORCE_DETERMINISTIC: optional(process.env.AI_FORCE_DETERMINISTIC),
  MAS_QA_BYPASS_AUTH: optional(process.env.MAS_QA_BYPASS_AUTH),
  APP_COMMIT_SHA: optional(process.env.APP_COMMIT_SHA),
  APP_BUILD_TIME: optional(process.env.APP_BUILD_TIME),
});

if (!parsed.success) {
  // Every problem at once. Restarting to discover the next missing variable is the exact
  // experience this module exists to prevent.
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(kök)"}: ${i.message}`);
  throw new Error(`Ortam değişkeni doğrulaması başarısız (${lines.length} sorun):\n${lines.join("\n")}`);
}

const raw = parsed.data;

/** Preserved verbatim from the previous src/lib/db.ts:14-15, including its edge cases:
 * a non-numeric value falls back to 10, and — deliberately kept — an explicitly empty
 * DATABASE_POOL_MAX parses as 0 and therefore clamps to 2, not to 10. Faz 15 moves this
 * code, it does not change what it computes. */
function resolvePoolMax(value: string | undefined): number {
  const configured = Number(value ?? 10);
  return Number.isFinite(configured) ? Math.min(20, Math.max(2, configured)) : 10;
}

export const env = Object.freeze({
  /** The application runtime credential. Since Faz 15 this points at the low-privilege
   * `mas_radar_app` role, never at the owner. Required: the old silent fallback to a
   * superuser localhost URL would have quietly undone this phase's whole point. */
  databaseUrl: raw.DATABASE_URL,
  /** Owner/superuser credential, used only by scripts that create or alter schema. Falls
   * back to DATABASE_URL so a cluster that has not split its env vars yet still works. */
  migrationDatabaseUrl: raw.MIGRATION_DATABASE_URL ?? raw.DATABASE_URL,
  databasePoolMax: resolvePoolMax(raw.DATABASE_POOL_MAX),
  telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
  telegramChatId: raw.TELEGRAM_CHAT_ID,
  telegramInternalApiKey: raw.TELEGRAM_INTERNAL_API_KEY,
  masAppBaseUrl: raw.MAS_APP_BASE_URL,
  emailApiUrl: raw.EMAIL_API_URL,
  emailApiKey: raw.EMAIL_API_KEY,
  emailTo: raw.EMAIL_TO,
  openaiApiKey: raw.OPENAI_API_KEY,
  openaiModel: raw.OPENAI_MODEL ?? "gpt-5.5",

  // ── Live reads, deliberately not snapshotted ──────────────────────────────────────────
  // Everything above is captured once at module load, which is correct for values that are
  // fixed before the process does any work. These two are different: they are switches the
  // test harnesses flip *during* a run, and a snapshot silently ignores the flip.
  //
  //   scripts/db/transitions-verify.ts sets MAS_QA_BYPASS_AUTH="1" around one block only and
  //   restores it in a finally, on purpose, so the rest of the script stays fail-closed.
  //   scripts/phase12a-verify.ts and phase14d-verify.ts set AI_FORCE_DETERMINISTIC="1" in
  //   their module body — which runs *after* their static imports have already loaded this
  //   module, so a snapshot would always miss it and the verify would call the real API.
  //
  // Both were caught by an actual failing run, not by reasoning: freezing them turned
  // transitions-verify from 167/167 into 163/167.

  /** True when AI answers must stay deterministic (no model call). */
  get aiForceDeterministic(): boolean {
    return process.env.AI_FORCE_DETERMINISTIC === "1";
  },
  /** True only for the narrowly-scoped TestSprite QA bypass. The caller still has to check
   * NODE_ENV separately — this flag alone never grants anything in production. */
  get qaBypassAuth(): boolean {
    return process.env.MAS_QA_BYPASS_AUTH === "1";
  },
  /**
   * AŞAMA 10 — per-route DB query accounting probe.
   *
   * Off by default and read live, exactly like the two switches above, because the route-SLO
   * harness starts a dedicated measurement server with it set and nothing else ever should.
   * When it is unset, `src/app/api/perf-probe/route.ts` answers 404 and
   * `src/lib/perf/request-metrics.ts` never installs a sink — so the accounting path is not
   * merely quiet in production, it is never armed. The probe exposes query SHAPES and counts,
   * never parameter values.
   */
  get perfProbeEnabled(): boolean {
    return process.env.MAS_PERF_PROBE === "1";
  },
  /** One fallback string for both /version and the admin footer. They previously disagreed
   * ("unknown" vs "commit unknown") for the same missing variable. */
  appCommitSha: raw.APP_COMMIT_SHA ?? "unknown",
  appBuildTime: raw.APP_BUILD_TIME ?? "unknown",
});

export type Env = typeof env;

export interface EnvPresence {
  name: string;
  required: boolean;
  set: boolean;
  /** Why it exists, for the diagnostics screen. Never a value. */
  note: string;
}

/**
 * Faz 16 — which variables are configured, for src/app/(dashboard)/system/diagnostics.
 *
 * Returns booleans ONLY. Not the values, not a prefix, not a masked form, not a length: a
 * "first four characters" hint is still a leak, and a length narrows a brute force. The
 * screen is admin-only anyway; this function is written so that even if that ever regressed,
 * there would be nothing here worth stealing.
 */
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
    { name: "OPENAI_API_KEY", required: false, set: isSet(process.env.OPENAI_API_KEY), note: "Yoksa AI yanıtları deterministik olgulara düşer" },
    { name: "OPENAI_MODEL", required: false, set: isSet(process.env.OPENAI_MODEL), note: `Varsayılan: ${env.openaiModel}` },
    { name: "AI_FORCE_DETERMINISTIC", required: false, set: isSet(process.env.AI_FORCE_DETERMINISTIC), note: "1 ise model hiç çağrılmaz" },
    { name: "MAS_QA_BYPASS_AUTH", required: false, set: isSet(process.env.MAS_QA_BYPASS_AUTH), note: "Yalnız TestSprite; production'da etkisiz" },
    { name: "MAS_PERF_PROBE", required: false, set: isSet(process.env.MAS_PERF_PROBE), note: "Yalnız route SLO ölçüm sunucusu; 1 değilse /api/perf-probe 404" },
    { name: "APP_COMMIT_SHA", required: false, set: isSet(process.env.APP_COMMIT_SHA), note: "Sürüm izlenebilirliği" },
    { name: "APP_BUILD_TIME", required: false, set: isSet(process.env.APP_BUILD_TIME), note: "Sürüm izlenebilirliği" },
  ];
}
