"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import { refreshMetricSnapshots } from "@/lib/analytics/snapshots";
import { requireActionPermission } from "@/lib/auth";

export async function refreshMetricsAction() {
  const session = await requireActionPermission("metric_snapshots", "insert", "/system");
  const count = await refreshMetricSnapshots(getPool(), session.id);
  revalidatePath("/system");
  revalidatePath("/");
  revalidatePath("/data/quality");
  redirect(`/system?metrics=${count}`);
}
