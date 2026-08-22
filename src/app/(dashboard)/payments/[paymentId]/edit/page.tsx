import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { moneyOrNull } from "@/lib/money";
import { PaymentForm, type PaymentFormValues } from "@/components/radar/payment-form";
import { updatePaymentAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditPaymentPage({
  params, searchParams,
}: {
  params: Promise<{ paymentId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { paymentId } = await params;
  const sp = await searchParams;
  const r = await getPool().query(
    `select id, name, recurrence_type, due_day, to_char(due_date,'YYYY-MM-DD') as due_date,
            default_amount, amount_confidence, direction, priority, flexibility_class, status,
            category_id, provider_party_id, owner_party_id, cash_account_id, description
     from public.payments where id=$1`,
    [paymentId],
  );
  if (r.rowCount === 0) notFound();
  // The form posts this value straight back into a numeric(14,2) column, so it must be the
  // exact stored amount rather than a float8 approximation of it.
  const v = { ...r.rows[0], default_amount: moneyOrNull(r.rows[0].default_amount) } as PaymentFormValues;
  return <PaymentForm action={updatePaymentAction} values={v} error={sp.error} title={`DÜZENLE — ${v.name}`} />;
}
