"use server";
import {redirect} from "next/navigation";import {revalidatePath} from "next/cache";import {getPool} from "@/lib/db";import {refreshMetricSnapshots} from "@/lib/analytics/snapshots";import {requireSession} from "@/lib/auth";
export async function refreshMetricsAction(){const session=await requireSession();const count=await refreshMetricSnapshots(getPool(),session.id);revalidatePath("/system");revalidatePath("/overview");revalidatePath("/data/quality");redirect(`/system?metrics=${count}`)}
