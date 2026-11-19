import Link from "@/components/ui/app-link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { loadLoanInstallments, loadLoans } from "@/lib/financing/engine";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { markInstallmentPaidAction } from "@/app/(dashboard)/finance/actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { formatMoney } from "@/lib/money-format";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

const PAYABLE_FROM = new Set(["planned", "late", "unpaid", "partial"]);

const LOAN_KIND_LABELS: Record<string, string> = {
  installment: "Taksitli Kredi (300/400)",
  spot: "Spot Kredi (300)",
  revolving: "Rotatif Kredi (300)",
  leasing: "Finansal Kiralama (301/302)",
};

const INTEREST_TYPE_LABELS: Record<string, string> = {
  fixed: "Sabit Faiz",
  floating_tlref: "TLREF + Spread",
  floating_sofr: "SOFR + Spread",
  floating_euribor: "EURIBOR + Spread",
};

export default async function LoanDetailPage({
  params,
}: {
  params: Promise<{ loanId: string }>;
}) {
  const denied = await requireRouteAccess("/finance/loans/[loanId]");
  if (denied) return denied;
  const { loanId } = await params;
  const pool = getPool();
  const loans = await loadLoans(pool);
  const loan = loans.find((l) => l.id === loanId);
  if (!loan) notFound();
  const installments = await loadLoanInstallments(pool, loanId);

  const cur = loan.currency || "TRY";
  const fmt = (v: number | null | undefined) => (v != null ? formatMoney(v, cur) : "—");

  const today = istanbulDateISO();
  const head: Array<[string, string]> = [
    ["ANAPARA", fmt(loan.principal)],
    ["TOPLAM ÖDEME", fmt(loan.totalPayment)],
    ["FİNANSMAN MALİYETİ", fmt(loan.totalFinanceCost)],
    ["TEMSİLİ TAKSİT", fmt(loan.installmentAmount)],
    ["VADE / DÖVİZ", `${loan.termMonths ?? loan.installmentCount ?? "—"} ay · ${cur}`],
  ];

  return (
    <div className="space-y-4">
      <Panel
        title={loan.name}
        right={
          <div className="flex items-center gap-2">
            <Badge tone="blue">{LOAN_KIND_LABELS[loan.loanKind ?? "installment"] ?? loan.loanKind ?? "installment"}</Badge>
            <Badge tone="neutral">{INTEREST_TYPE_LABELS[loan.interestType ?? "fixed"] ?? loan.interestType ?? "fixed"}</Badge>
            <Link
              href="/finance/loans"
              className="font-mono text-[10px] uppercase text-tone-2 underline underline-offset-2"
            >
              ← krediler
            </Link>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {head.map(([k, v]) => (
            <div
              key={k}
              className="rounded border p-2"
              style={{ borderColor: "var(--line)", background: "var(--surface-2)" }}
            >
              <div className="font-mono text-[9px] uppercase tracking-wider text-tone-3">{k}</div>
              <div className="font-mono text-sm tabular-nums text-tone-1">{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-tone-3">
          <span>
            ilk ödeme: {loan.firstPaymentDate ?? "—"} · aylık faiz:{" "}
            {loan.appliedRate != null ? `%${(loan.appliedRate * 100).toFixed(2)}` : "—"} · aylık maliyet:{" "}
            {loan.monthlyCostRate != null ? `%${(loan.monthlyCostRate * 100).toFixed(2)}` : "—"}
          </span>
          {loan.bsmvRate != null || loan.kkdfRate != null ? (
            <span>
              BSMV: %{((loan.bsmvRate ?? 0) * 100).toFixed(1)} · KKDF: %
              {((loan.kkdfRate ?? 0) * 100).toFixed(1)}
            </span>
          ) : null}
          <span>
            kalan: {loan.remainingCount}/{loan.installmentsLoaded} taksit · {fmt(loan.remainingAmount)}
          </span>
          {loan.sourceWorkbookId && loan.sourceSheetId && (
            <Link
              className="underline decoration-line-strong underline-offset-2"
              href={`/data/imports/${loan.sourceWorkbookId}/sheets/${loan.sourceSheetId}`}
            >
              kaynak: faiz hesaplama →
            </Link>
          )}
        </div>
      </Panel>

      <Panel title={`AMORTİSMAN & TAKSİT PLANI — ${installments.length} TAKSİT (${cur})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                <th className="py-1 pr-2">#</th>
                <th className="py-1 pr-2">vade</th>
                <th className="py-1 pr-2 text-right">taksit</th>
                <th className="py-1 pr-2 text-right">anapara</th>
                <th className="py-1 pr-2 text-right">faiz (780)</th>
                <th className="py-1 pr-2 text-right">BSMV</th>
                <th className="py-1 pr-2 text-right">KKDF</th>
                <th className="py-1 pr-2 text-right">toplam vergi</th>
                <th className="py-1">durum</th>
                <th className="py-1 pl-2">işlem</th>
              </tr>
            </thead>
            <tbody>
              {installments.map((i) => {
                const overdue = i.status !== "paid" && i.dueDate < today;
                return (
                  <tr key={i.id} className="border-b border-line-faint">
                    <td className="py-1 pr-2 font-mono text-xs text-tone-3">{i.no}</td>
                    <td className={`py-1 pr-2 font-mono text-xs ${overdue ? "text-neg" : ""}`}>{i.dueDate}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmt(i.amount)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-tone-2">{fmt(i.principal)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-tone-2">{fmt(i.interest)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-tone-3">{fmt(i.bsmv)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-tone-3">{fmt(i.kkdf)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-tone-2">{fmt(i.tax)}</td>
                    <td className="py-1">
                      <Badge tone={STATUS_TONE[i.status] ?? "neutral"}>{overdue ? "gecikmiş" : i.status}</Badge>
                    </td>
                    <td className="py-1 pl-2">
                      {PAYABLE_FROM.has(i.status) && (
                        <form action={markInstallmentPaidAction} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={i.id} />
                          <input type="hidden" name="backTo" value={`/finance/loans/${loanId}`} />
                          <input
                            type="date"
                            name="paidAt"
                            defaultValue={i.dueDate <= today ? i.dueDate : undefined}
                            className="field-control px-1.5 py-0.5 font-mono text-[11px]"
                          />
                          <button className="button-ghost px-2 py-0.5 text-pos">ödendi</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
