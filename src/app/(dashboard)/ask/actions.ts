"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { answerQuestion } from "@/lib/ai/engine";
import { requireSession } from "@/lib/auth";

export async function askQuestionAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const question = String(formData.get("question") ?? "");
  if (!question.trim()) return;
  const forceDeterministic = formData.get("forceDeterministic") === "on";
  const { id } = await answerQuestion(getPool(), { question, forceDeterministic }, session.id);
  revalidatePath("/insights/ask");
  redirect(`/insights/ask/${id}`);
}
