"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { answerReportQuestion } from "@/lib/ai/engine";
import { generateDaily, generateMonthly, generateWeekly } from "@/lib/reports/engine";
import { istanbulDateISO } from "@/lib/reports/rules";

export async function generateReportAction(formData: FormData): Promise<void> {
  const type = String(formData.get("type") ?? "");
  const pool = getPool();
  const today = istanbulDateISO();
  let id: string;
  if (type === "daily") ({ id } = await generateDaily(pool, today));
  else if (type === "weekly") ({ id } = await generateWeekly(pool, today));
  else if (type === "monthly") ({ id } = await generateMonthly(pool, today.slice(0, 7) + "-01"));
  else return;
  revalidatePath("/reports");
  redirect(`/reports/${id}`);
}

export async function generateReportCommentaryAction(formData: FormData): Promise<void> {
  const reportId = String(formData.get("reportId") ?? "");
  if (!reportId) return;
  const { id } = await answerReportQuestion(getPool(), reportId);
  revalidatePath(`/reports/${reportId}`);
  redirect(`/reports/${reportId}?ai=${id}`);
}
