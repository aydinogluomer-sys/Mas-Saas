import { requireRouteAccess } from "@/lib/authz/route-guard";
import { PaymentForm } from "@/components/radar/payment-form";
import { createPaymentAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewPaymentPage({
  searchParams,
}: { searchParams: Promise<{ error?: string }> }) {
  const denied = await requireRouteAccess("/payments/new");
  if (denied) return denied;
  const sp = await searchParams;
  return <PaymentForm action={createPaymentAction} values={{}} error={sp.error} title="YENİ ÖDEME KALEMİ" />;
}
