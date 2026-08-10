"use server";
import { revalidatePath } from "next/cache";import { redirect } from "next/navigation";import { getPool } from "@/lib/db";import { addMonths } from "@/lib/radar/rules";import { requireSession } from "@/lib/auth";import { DomainError } from "@/lib/domain-error";import { markCheckBounced, markCheckCleared, markInstallmentPaid } from "@/lib/financing/engine";
const number=(v:FormDataEntryValue|null)=>{const n=Number(v);return Number.isFinite(n)?n:null};
export async function createCheckAction(formData:FormData){const session=await requireSession();const date=String(formData.get("maturityDate")??"");const amount=number(formData.get("amount"));const direction=String(formData.get("direction")??"outflow");if(!date)throw new Error("Vade tarihi zorunlu");const signed=amount==null?null:direction==='outflow'?-Math.abs(amount):Math.abs(amount);const pool=getPool();const result=await pool.query(`insert into public.checks(maturity_date,serial_no,counterparty_label,amount,signed_amount,direction,status,notes) values($1,$2,$3,$4,$5,$6,'planned',$7) returning id`,[date,String(formData.get("serial")??"")||null,String(formData.get("counterparty")??"")||null,amount,signed,direction,String(formData.get("notes")??"")||null]);await pool.query(`insert into public.audit_logs(actor,action,entity_table,entity_id,after_data) values($1,'create_check','checks',$2,$3)`,[session.id,result.rows[0].id,JSON.stringify({date,amount,direction})]);revalidatePath('/finance');redirect('/finance/checks')}
export async function createLoanAction(formData:FormData){const session=await requireSession();const name=String(formData.get("name")??"").trim();const principal=number(formData.get("principal"));const count=number(formData.get("installmentCount"));const installment=number(formData.get("installmentAmount"));const first=String(formData.get("firstPaymentDate")??"");if(!name||principal==null||!count||installment==null||!first)throw new Error("Kredi temel alanları zorunlu");const pool=getPool(),client=await pool.connect();try{await client.query('begin');const total=installment*count;const loan=await client.query(`insert into public.loans(name,principal,installment_count,first_payment_date,installment_amount,total_payment,total_finance_cost,status) values($1,$2,$3,$4,$5,$6,$7,'active') returning id`,[name,principal,count,first,installment,total,total-principal]);for(let i=0;i<count;i++){const month=addMonths(first.slice(0,7)+'-01',i).slice(0,7);await client.query(`insert into public.loan_installments(loan_id,installment_no,due_date,amount,status) values($1,$2,$3,$4,'planned')`,[loan.rows[0].id,i+1,`${month}-${first.slice(8,10)}`,installment])}await client.query(`insert into public.audit_logs(actor,action,entity_table,entity_id,after_data) values($1,'create_loan','loans',$2,$3)`,[session.id,loan.rows[0].id,JSON.stringify({name,principal,count})]);await client.query('commit')}catch(error){await client.query('rollback');throw error}finally{client.release()}revalidatePath('/finance');redirect('/finance/loans')}

/* ── settlement actions (Bulgu #1) ── DomainError carries a message written for the user
   (wrong source status), so it becomes a redirect the page can show; anything else is an
   unexpected fault and must propagate. Mirrors src/app/(dashboard)/radar/actions.ts. */
function backOf(formData: FormData, fallback: string): string {
  const path = String(formData.get("backTo") ?? fallback);
  return path.startsWith("/") && !path.startsWith("//") ? path : fallback;
}
function errorRedirect(backTo: string, message: string): never {
  redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

export async function markCheckClearedAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const backTo = backOf(formData, "/finance/checks");
  try {
    await markCheckCleared(getPool(), id, session.id);
  } catch (e) {
    if (e instanceof DomainError) errorRedirect(backTo, e.message);
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/finance");
}

export async function markCheckBouncedAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const backTo = backOf(formData, "/finance/checks");
  try {
    await markCheckBounced(getPool(), id, session.id);
  } catch (e) {
    if (e instanceof DomainError) errorRedirect(backTo, e.message);
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/finance");
}

export async function markInstallmentPaidAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  // Empty means "paid now" — the engine resolves null to now(); an empty string must never
  // be passed through as a date.
  const raw = String(formData.get("paidAt") ?? "").trim();
  const backTo = backOf(formData, "/financing");
  try {
    await markInstallmentPaid(getPool(), id, raw === "" ? null : raw, session.id);
  } catch (e) {
    if (e instanceof DomainError) errorRedirect(backTo, e.message);
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/finance");
}
