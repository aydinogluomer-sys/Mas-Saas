"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { answerQuestion } from "@/lib/ai/engine";
import { requireActionPermission } from "@/lib/auth";

export async function askQuestionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("ai_response_snapshots", "insert", "/insights/ask");
  const question = String(formData.get("question") ?? "");
  if (!question.trim()) return;
  const forceDeterministic = formData.get("forceDeterministic") === "on";
  const { id } = await answerQuestion(getPool(), { question, forceDeterministic, role: session.role }, session.id);
  revalidatePath("/insights/ask");
  redirect(`/insights/ask/${id}`);
}

