"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { archiveRecord, restoreRecord } from "@/lib/archive/engine";

const safeBack = (value:FormDataEntryValue|null) => { const path=String(value??"/system/archive"); return path.startsWith("/")&&!path.startsWith("//")?path:"/system/archive"; };
export async function archiveRecordAction(formData:FormData){const entity=String(formData.get("entity")??"");const id=String(formData.get("id")??"");const back=safeBack(formData.get("backTo"));await archiveRecord(getPool(),entity,id,String(formData.get("reason")??""));revalidatePath(back);revalidatePath("/system/archive");redirect(back)}
export async function restoreRecordAction(formData:FormData){const entity=String(formData.get("entity")??"");const id=String(formData.get("id")??"");const back=safeBack(formData.get("backTo"));await restoreRecord(getPool(),entity,id);revalidatePath(back);revalidatePath("/system/archive");redirect(back)}
