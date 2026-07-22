"use server";
import {redirect} from "next/navigation";import {revalidatePath} from "next/cache";import {getPool} from "@/lib/db";import {refreshMetricSnapshots} from "@/lib/analytics/snapshots";
export async function refreshMetricsAction(){const count=await refreshMetricSnapshots(getPool());revalidatePath("/system");revalidatePath("/overview");revalidatePath("/data/quality");redirect(`/system?metrics=${count}`)}
