"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { answerReportQuestion } from "@/lib/ai/engine";
import { generateDaily, generateMonthly, generateWeekly } from "@/lib/reports/engine";
import { dispatchBriefing, generateCfoBriefing } from "@/lib/briefing/engine";
import { transportFor } from "@/lib/reminders/transport";
import { istanbulDateISO } from "@/lib/reports/rules";
import { refreshMetricSnapshots } from "@/lib/analytics/snapshots";
import { requireActionPermission } from "@/lib/auth";
import { formObject, parseOrThrow } from "@/lib/validation";

const DispatchBriefingFormSchema = z.object({
  channel: z.enum(["telegram", "email"]).default("telegram"),
  reportId: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined))
    .pipe(z.string().uuid("Geçerli rapor kimliği gerekli").optional()),
});

export async function generateReportAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("reports", "insert", "/insights/reports");
  const type = String(formData.get("type") ?? "");
  const pool = getPool();
  const today = istanbulDateISO();
  let id: string;
  if (type === "daily") ({ id } = await generateDaily(pool, today, session.id));
  else if (type === "weekly") ({ id } = await generateWeekly(pool, today, session.id));
  else if (type === "monthly") ({ id } = await generateMonthly(pool, today.slice(0, 7) + "-01", session.id));
  else return;
  if (type === "daily") await refreshMetricSnapshots(pool, session.id, today).catch(() => undefined);
  revalidatePath("/insights/reports");
  redirect(`/insights/reports/${id}`);
}

export async function generateReportCommentaryAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("ai_response_snapshots", "insert", "/insights/reports");
  const reportId = String(formData.get("reportId") ?? "");
  if (!reportId) return;
  const { id } = await answerReportQuestion(getPool(), reportId, session.id, session.role);
  revalidatePath(`/insights/reports/${reportId}`);
  redirect(`/insights/reports/${reportId}?ai=${id}`);
}

export async function dispatchBriefingAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("reports", "insert", "/insights/reports");
  const parsed = parseOrThrow(DispatchBriefingFormSchema, formObject(formData), "Brifing gönderim formu");
  const pool = getPool();
  const today = istanbulDateISO();

  let targetReportId = parsed.reportId;
  let bodyMd = "";

  if (targetReportId) {
    const existing = await pool.query<{ id: string; body_md: string }>(
      `select id, body_md from public.reports where id = $1 limit 1`,
      [targetReportId],
    );
    if (existing.rows[0]) {
      bodyMd = existing.rows[0].body_md;
    } else {
      targetReportId = undefined;
    }
  }

  if (!targetReportId) {
    const todayBriefing = await pool.query<{ id: string; body_md: string }>(
      `select id, body_md
         from public.reports
        where report_type = 'cfo_briefing'
          and period_start = $1::date
        order by created_at desc
        limit 1`,
      [today],
    );
    if (todayBriefing.rows[0]) {
      targetReportId = todayBriefing.rows[0].id;
      bodyMd = todayBriefing.rows[0].body_md;
    } else {
      const generated = await generateCfoBriefing(pool, today, session.id);
      targetReportId = generated.reportId;
      bodyMd = generated.bodyMd;
    }
  }

  const res = await dispatchBriefing(
    pool,
    transportFor(parsed.channel),
    bodyMd,
    targetReportId,
    session.id,
  );
  revalidatePath("/insights/reports");
  if (res.ok) {
    redirect(`/insights/reports?dispatched=${encodeURIComponent(parsed.channel)}`);
  }
  redirect(`/insights/reports?dispatchError=${encodeURIComponent(res.error ?? "Kanal gönderimi başarısız")}`);
}

