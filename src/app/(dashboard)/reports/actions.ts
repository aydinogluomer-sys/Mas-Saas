"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { answerReportQuestion } from "@/lib/ai/engine";
import { generateDaily, generateMonthly, generateWeekly } from "@/lib/reports/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { refreshMetricSnapshots } from "@/lib/analytics/snapshots";
import { requireSession } from "@/lib/auth";

export async function generateReportAction(formData: FormData): Promise<void> {
  const session = await requireSession();
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
  const session = await requireSession();
  const reportId = String(formData.get("reportId") ?? "");
  if (!reportId) return;
  const { id } = await answerReportQuestion(getPool(), reportId, session.id);
  revalidatePath(`/insights/reports/${reportId}`);
  redirect(`/insights/reports/${reportId}?ai=${id}`);
}
