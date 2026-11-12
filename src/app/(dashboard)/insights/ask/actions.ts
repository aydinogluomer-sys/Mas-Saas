"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { ask } from "@/lib/assistant/engine";
import { requireActionPermission } from "@/lib/auth";
import { DomainError } from "@/lib/domain-error";
import { formObject, parseOrThrow } from "@/lib/validation";

const askActionFormSchema = z.object({
  question: z.string().trim().min(1, "Soru metni gerekli").max(800, "Soru en fazla 800 karakter olabilir"),
  conversationId: z.string().trim().optional(),
  forceDeterministic: z.string().optional(),
});

export async function askQuestionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("ai_response_snapshots", "insert", "/insights/ask");
  let conversationIdOut: string;
  let responseIdOut: string;
  try {
    const parsed = parseOrThrow(askActionFormSchema, formObject(formData), "Asistan sorusu");
    const conversationId =
      parsed.conversationId && parsed.conversationId.length > 0 ? parsed.conversationId : null;
    const forceDeterministic = parsed.forceDeterministic === "on" || parsed.forceDeterministic === "true";
    const ans = await ask(
      getPool(),
      {
        question: parsed.question,
        conversationId,
        forceDeterministic,
      },
      session.id,
      session.role,
    );
    conversationIdOut = ans.conversationId;
    responseIdOut = ans.responseId;
  } catch (e) {
    if (e instanceof DomainError) {
      redirect(`/insights/ask?error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidatePath("/insights/ask");
  redirect(
    `/insights/ask?conversationId=${encodeURIComponent(conversationIdOut)}&responseId=${encodeURIComponent(responseIdOut)}`,
  );
}


