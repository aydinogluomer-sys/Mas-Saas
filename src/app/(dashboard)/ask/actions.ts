"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { answerQuestion } from "@/lib/ai/engine";

export async function askQuestionAction(formData: FormData): Promise<void> {
  const question = String(formData.get("question") ?? "");
  if (!question.trim()) return;
  const forceDeterministic = formData.get("forceDeterministic") === "on";
  const { id } = await answerQuestion(getPool(), { question, forceDeterministic });
  revalidatePath("/ask");
  redirect(`/ask?response=${id}`);
}
