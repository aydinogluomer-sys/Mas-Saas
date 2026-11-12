"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { dispatchBriefing, generateCfoBriefing } from "@/lib/briefing/engine";
import { transportFor } from "@/lib/reminders/transport";
import { istanbulDateISO } from "@/lib/reports/rules";
import { requireActionPermission } from "@/lib/auth";
import { formObject, parseOrThrow } from "@/lib/validation";

const DispatchMorningBriefingSchema = z.object({
  channel: z.enum(["telegram", "email"]).default("telegram"),
});

/**
 * Generate today's CFO briefing on an explicit click.
 *
 * Deliberately not automatic on page load: a briefing is a stored `reports` row with an audit
 * entry, and generating one as a side effect of somebody opening a screen would fill the history
 * with records nobody asked for. Reading the screen is free; producing a document is an action.
 */
export async function generateBriefingAction(): Promise<void> {
  const session = await requireActionPermission("reports", "insert", "/insights/briefing");
  const { reportId } = await generateCfoBriefing(getPool(), istanbulDateISO(), session.id);
  revalidatePath("/insights/briefing");
  redirect(`/insights/reports/${reportId}`);
}

export async function dispatchMorningBriefingAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("reports", "insert", "/insights/briefing");
  const parsed = parseOrThrow(DispatchMorningBriefingSchema, formObject(formData), "Brifing kanal formu");
  const pool = getPool();
  const today = istanbulDateISO();

  const existing = await pool.query<{ id: string; body_md: string }>(
    `select id, body_md
       from public.reports
      where report_type = 'cfo_briefing'
        and period_start = $1::date
      order by created_at desc
      limit 1`,
    [today],
  );

  let reportId: string;
  let bodyMd: string;
  if (existing.rows[0]) {
    reportId = existing.rows[0].id;
    bodyMd = existing.rows[0].body_md;
  } else {
    const generated = await generateCfoBriefing(pool, today, session.id);
    reportId = generated.reportId;
    bodyMd = generated.bodyMd;
  }

  const res = await dispatchBriefing(pool, transportFor(parsed.channel), bodyMd, reportId, session.id);
  revalidatePath("/insights/briefing");
  revalidatePath("/insights/reports");
  if (res.ok) {
    redirect(`/insights/briefing?dispatched=${encodeURIComponent(parsed.channel)}`);
  }
  redirect(`/insights/briefing?dispatchError=${encodeURIComponent(res.error ?? "Kanal gönderimi başarısız")}`);
}
