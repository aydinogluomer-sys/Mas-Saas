"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import type { AppRole } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { dispatchPending, scheduleReminders } from "@/lib/reminders/engine";
import { telegramTransport } from "@/lib/reminders/transport";
import { istanbulDateISO } from "@/lib/reports/rules";

/**
 * Where a refusal is shown, and what gets revalidated.
 *
 * These two are not the same path, which is a wrinkle worth writing down. The form that calls
 * these actions lives in src/app/(dashboard)/reminders/page.tsx, but next.config.ts permanently
 * redirects /reminders to /insights/reminders, so the LIVE screen is the latter and the former is
 * unreachable by URL. The error redirect therefore targets the live page (a redirect to /reminders
 * would 301 again and drop the query string), while both paths are revalidated so the cache is
 * correct whichever of the two survives the eventual cleanup.
 */
const PAGE = "/insights/reminders";
const LEGACY_PAGE = "/reminders";

/**
 * Tiers allowed to run reminder maintenance.
 *
 * WHY THESE TWO, AND WHY A GATE AT ALL WHEN RLS EXISTS.
 *
 * Both actions below used to call neither requireSession() nor any role check. The Faz 4 audit
 * measured what actually stood between an unauthorised caller and a state change and found the
 * database holding the line on its own: getPool() resolves the tier through getDbContext(), which
 * returns EMPTY for an absent, revoked, expired or inactive session, and no tier can write
 * `reminder_deliveries` unless the matrix says so. That is why this was filed P2 rather than P1.
 *
 * It is still not enough, for two reasons.
 *
 * FIRST, THE BACKSTOP IS CONDITIONAL. The RLS argument only holds while the runtime really
 * connects as the low-privilege `mas_radar_app` identity. That is proven in CI and in the
 * disposable clones, but it is deliberately NOT yet true of the real deployment — runtime identity
 * is a cutover step. Until then these two actions have no guard at all in the one environment that
 * matters, and "the database would have stopped it" is a claim about a configuration that is not
 * in place yet.
 *
 * SECOND, RLS CANNOT REACH THE SIDE EFFECT. dispatchPending() sends Telegram messages. Row-level
 * security governs rows; it has nothing to say about an outbound message. Reads on the pending set
 * are permitted to lower tiers, so a viewer could plausibly cause sends whose delivery rows are
 * then refused — messages that went out and were never recorded, which is the worst of both.
 *
 * finance_manager is the floor rather than admin because this is operational work, and it matches
 * the identity the codebase already assigns to unattended jobs: runAsSystem() in @/lib/db runs as
 * finance_manager precisely so a background task can generate and record work without being able
 * to change settings or accounts.
 */
const REMINDER_OPERATORS: readonly AppRole[] = ["finance_manager", "admin"];

async function requireReminderOperator(): Promise<void> {
  const session = await requireSession();
  if (!REMINDER_OPERATORS.includes(session.role)) {
    throw new DomainError("Hatırlatma bakımı için finans yöneticisi veya yönetici yetkisi gerekir.");
  }
}

/** A refusal is an answer the operator must read, not a stack trace — same shape as system/controls. */
function fail(e: unknown): never {
  if (e instanceof DomainError) {
    redirect(`${PAGE}?error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

export async function scheduleRemindersAction(): Promise<void> {
  try {
    await requireReminderOperator();
  } catch (e) {
    fail(e);
  }
  const pool = getPool();
  await scheduleReminders(pool, istanbulDateISO());
  revalidatePath(PAGE);
  revalidatePath(LEGACY_PAGE);
}

export async function dispatchRemindersAction(): Promise<void> {
  try {
    await requireReminderOperator();
  } catch (e) {
    fail(e);
  }
  const pool = getPool();
  // Real transport: Telegram token/chat id are server-only env vars. Unreachable here,
  // so failures are logged on the delivery row (never thrown) — honest operator state.
  await dispatchPending(pool, telegramTransport(), istanbulDateISO());
  revalidatePath(PAGE);
  revalidatePath(LEGACY_PAGE);
}
