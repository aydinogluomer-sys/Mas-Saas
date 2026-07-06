"use server";
import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import { dispatchPending, scheduleReminders } from "@/lib/reminders/engine";
import { telegramTransport } from "@/lib/reminders/transport";
import { istanbulDateISO } from "@/lib/reports/rules";

export async function scheduleRemindersAction(): Promise<void> {
  const pool = getPool();
  await scheduleReminders(pool, istanbulDateISO());
  revalidatePath("/reminders");
}

export async function dispatchRemindersAction(): Promise<void> {
  const pool = getPool();
  // Real transport: Telegram token/chat id are server-only env vars. Unreachable here,
  // so failures are logged on the delivery row (never thrown) — honest operator state.
  await dispatchPending(pool, telegramTransport(), istanbulDateISO());
  revalidatePath("/reminders");
}
