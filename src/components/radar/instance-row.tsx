import { Badge, type Tone } from "@/components/ui/badge";
import { fmtTL } from "@/components/ui/panel";
import type { InstanceRow } from "@/lib/radar/queries";
import { cancelInstanceAction, markPaidAction, markPartialAction, markUnpaidAction, setAmountAction } from "@/app/(dashboard)/radar/actions";

const REASON_TONE: Record<string, Tone> = {
  missing_amount: "amber", negative_amount: "red", large_payment: "amber",
  critical_payment: "red", same_day_cluster: "violet", overdue: "red",
};
const REASON_TR: Record<string, string> = {
  missing_amount: "eksik", negative_amount: "negatif", large_payment: "büyük",
  critical_payment: "kritik", same_day_cluster: "yığılma", overdue: "gecikti",
};

export function RiskBadges({ reasons }: { reasons: string[] }) {
  if (!reasons?.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {reasons.map((r) => (
        <Badge key={r} tone={REASON_TONE[r] ?? "neutral"}>{REASON_TR[r] ?? r}</Badge>
      ))}
    </span>
  );
}

// Must match src/lib/radar/engine.ts's PAYABLE_FROM/CANCELLABLE_FROM — the sets of statuses
// markInstancePaid/cancelInstance actually accept. Showing a button outside its set (e.g. for
// cancelled/unknown) would offer an action whose click always fails with a domain error.
const PAYABLE_FROM = new Set(["unpaid", "planned", "late", "partial"]);
const CANCELLABLE_FROM = new Set(["unpaid", "planned", "late"]);

export function InstanceRowView({ r, backTo, showDate = false }: { r: InstanceRow; backTo: string; showDate?: boolean }) {
  const paid = r.status === "paid";
  const payable = PAYABLE_FROM.has(r.status);
  const cancellable = CANCELLABLE_FROM.has(r.status);
  return (
    <div className="payment-instance-row row-hover grid grid-cols-1 gap-2 border-b border-line-faint px-1 py-2 sm:grid-cols-[minmax(180px,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate">{r.name}</span>
          {showDate && <span className="font-mono text-[10px] text-tone-3">{r.due_date.slice(8)}.{r.due_date.slice(5, 7)}</span>}
          {r.note === "short_month_adjustment" && <Badge tone="neutral">ay-sonu kırpma</Badge>}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className={`font-mono text-xs tabular-nums ${r.amount != null && r.amount < 0 ? "text-neg" : paid ? "text-pos" : "text-tone-2"}`}>
            {paid && r.paid_amount != null ? fmtTL(r.paid_amount) : fmtTL(r.amount)}
          </span>
          <RiskBadges reasons={r.risk_reasons} />
          {paid && <Badge tone="green">ödendi</Badge>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
      {r.amount == null && !paid && (
        <form action={setAmountAction} className="flex min-w-0 flex-1 items-center gap-1 sm:flex-initial">
          <input type="hidden" name="id" value={r.id} />
          <input type="hidden" name="backTo" value={backTo} />
          <input name="amount" inputMode="numeric" placeholder="tutar" required
            className="min-w-0 flex-1 border border-line bg-black/40 px-2 py-1 font-mono text-xs sm:w-24 sm:flex-initial" />
          <button className="button-ghost px-2 py-1">kaydet</button>
        </form>
      )}
      {paid ? (
        <form action={markUnpaidAction}>
          <input type="hidden" name="id" value={r.id} />
          <input type="hidden" name="backTo" value={backTo} />
          <button className="button-ghost px-2 py-1">geri al</button>
        </form>
      ) : payable ? (
        <>
          <form action={markPaidAction} className="flex items-center gap-1">
            <input type="hidden" name="id" value={r.id} />
            <input type="hidden" name="backTo" value={backTo} />
            {r.amount == null && (
              <input name="paidAmount" inputMode="numeric" placeholder="ödenen?"
                className="min-w-0 flex-1 border border-line bg-black/40 px-2 py-1 font-mono text-xs sm:w-24 sm:flex-initial" />
            )}
            <button className="button-primary px-2 py-1">ödendi</button>
          </form>
          {r.amount != null && (
            <form action={markPartialAction} className="flex items-center gap-1">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="backTo" value={backTo} />
              <input required name="paidAmount" inputMode="numeric" placeholder="kısmi tutar"
                className="w-24 border border-line bg-black/40 px-2 py-1 font-mono text-xs" />
              <button className="button-ghost px-2 py-1">kısmi</button>
            </form>
          )}
          {cancellable && (
            <form action={cancelInstanceAction} className="flex items-center gap-1">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="backTo" value={backTo} />
              <input required name="reason" placeholder="iptal nedeni"
                className="w-28 border border-line bg-black/40 px-2 py-1 font-mono text-xs" />
              <button className="button-ghost px-2 py-1 text-neg">iptal</button>
            </form>
          )}
        </>
      ) : null}
      </div>
    </div>
  );
}
