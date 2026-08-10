"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { archiveRecord, restoreRecord } from "@/lib/archive/engine";
import { requireSession } from "@/lib/auth";

const safeBack = (value:FormDataEntryValue|null) => { const path=String(value??"/system/archive"); return path.startsWith("/")&&!path.startsWith("//")?path:"/system/archive"; };
export async function archiveRecordAction(formData:FormData){
  const session = await requireSession();
  const entity=String(formData.get("entity")??"");const id=String(formData.get("id")??"");const back=safeBack(formData.get("backTo"));
  const reason=String(formData.get("reason")??"").trim();
  if(!reason) redirect(`${back}${back.includes("?")?"&":"?"}error=${encodeURIComponent("Arşivleme nedeni zorunlu.")}`);
  await archiveRecord(getPool(),entity,id,reason,session.id,session.displayName);revalidatePath(back);revalidatePath("/system/archive");redirect(back)
}
export async function restoreRecordAction(formData:FormData){
  const session = await requireSession();
  const entity=String(formData.get("entity")??"");const id=String(formData.get("id")??"");const back=safeBack(formData.get("backTo"));
  await restoreRecord(getPool(),entity,id,session.id);revalidatePath(back);revalidatePath("/system/archive");redirect(back)
}
