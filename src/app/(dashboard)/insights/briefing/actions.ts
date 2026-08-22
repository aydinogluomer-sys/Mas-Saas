"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { generateCfoBriefing } from "@/lib/briefing/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { requireSession } from "@/lib/auth";

/**
 * Generate today's CFO briefing on an explicit click.
 *
 * Deliberately not automatic on page load: a briefing is a stored `reports` row with an audit
 * entry, and generating one as a side effect of somebody opening a screen would fill the history
 * with records nobody asked for. Reading the screen is free; producing a document is an action.
 */
export async function generateBriefingAction(): Promise<void> {
  const session = await requireSession();
  const { reportId } = await generateCfoBriefing(getPool(), istanbulDateISO(), session.id);
  revalidatePath("/insights/briefing");
  redirect(`/insights/reports/${reportId}`);
}
