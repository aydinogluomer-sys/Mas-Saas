import { Badge, type Tone } from "@/components/ui/badge";
import { fmtTL } from "@/components/ui/panel";
import type { InstanceRow } from "@/lib/radar/queries";
import { markPaidAction, markUnpaidAction, setAmountAction } from "@/app/(dashboard)/radar/actions";

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

export function InstanceRowView({ r, backTo, showDate = false }: { r: InstanceRow; backTo: string; showDate?: boolean }) {
  const paid = r.status === "paid";
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-900 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate">{r.name}</span>
          {showDate && <span className="font-mono text-[10px] text-zinc-500">{r.due_date.slice(8)}.{r.due_date.slice(5, 7)}</span>}
          {r.note === "short_month_adjustment" && <Badge tone="neutral">ay-sonu kırpma</Badge>}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className={`font-mono text-xs tabular-nums ${r.amount != null && r.amount < 0 ? "text-red-400" : paid ? "text-emerald-400" : "text-zinc-300"}`}>
            {paid && r.paid_amount != null ? fmtTL(r.paid_amount) : fmtTL(r.amount)}
          </span>
          <RiskBadges reasons={r.risk_reasons} />
          {paid && <Badge tone="green">ödendi</Badge>}
        </div>
      </div>
      {r.amount == null && !paid && (
        <form action={setAmountAction} className="flex items-center gap-1">
          <input type="hidden" name="id" value={r.id} />
          <input type="hidden" name="backTo" value={backTo} />
          <input name="amount" inputMode="numeric" placeholder="tutar" required
            className="w-24 border border-zinc-800 bg-black/40 px-2 py-1 font-mono text-xs" />
          <button className="border border-zinc-700 px-2 py-1 font-mono text-[10px] uppercase text-zinc-300">kaydet</button>
        </form>
      )}
      {paid ? (
        <form action={markUnpaidAction}>
          <input type="hidden" name="id" value={r.id} />
          <input type="hidden" name="backTo" value={backTo} />
          <button className="border border-zinc-700 px-2 py-1 font-mono text-[10px] uppercase text-zinc-400">geri al</button>
        </form>
      ) : (
        <form action={markPaidAction} className="flex items-center gap-1">
          <input type="hidden" name="id" value={r.id} />
          <input type="hidden" name="backTo" value={backTo} />
          {r.amount == null && (
            <input name="paidAmount" inputMode="numeric" placeholder="ödenen?"
              className="w-24 border border-zinc-800 bg-black/40 px-2 py-1 font-mono text-xs" />
          )}
          <button className="border border-zinc-200 bg-zinc-200 px-2 py-1 font-mono text-[10px] font-semibold uppercase text-zinc-950">ödendi</button>
        </form>
      )}
    </div>
  );
}
