import { requireRouteAccess } from "@/lib/authz/route-guard";
import { PaymentForm } from "@/components/radar/payment-form";
import { istanbulDateISO } from "@/lib/time/istanbul";
import { createPaymentAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewPaymentPage({
  searchParams,
}: { searchParams: Promise<{ error?: string }> }) {
  const denied = await requireRouteAccess("/payments/new");
  if (denied) return denied;
  const sp = await searchParams;
  const today = istanbulDateISO();
  return (
    <PaymentForm
      action={createPaymentAction}
      values={{ due_date: today }}
      error={sp.error}
      title="YENİ ÖDEME KALEMİ"
    />
  );
}
