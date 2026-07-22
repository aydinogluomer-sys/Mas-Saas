import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { loadLoanInstallments, loadLoans } from "@/lib/financing/engine";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";

export const dynamic = "force-dynamic";

const fmt0 = (v: number | null) =>
  v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—";

export default async function LoanDetailPage({
  params,
}: {
  params: Promise<{ loanId: string }>;
}) {
  const { loanId } = await params;
  const pool = getPool();
  const loans = await loadLoans(pool);
  const loan = loans.find((l) => l.id === loanId);
  if (!loan) notFound();
  const installments = await loadLoanInstallments(pool, loanId);

  const today = new Date().toISOString().slice(0, 10);
  const head: Array<[string, string]> = [
    ["ANAPARA", fmt0(loan.principal)],
    ["TOPLAM ÖDEME", fmt0(loan.totalPayment)],
    ["FİNANSMAN MALİYETİ", fmt0(loan.totalFinanceCost)],
    ["TAKSİT", fmt0(loan.installmentAmount)],
    ["VADE", `${loan.termMonths ?? "—"} ay`],
  ];

  return (
    <>
      <Panel
        title={loan.name}
        right={
          <Link href="/financing" className="font-mono text-[10px] uppercase text-tone-2 underline underline-offset-2">
            ← çek/kredi
          </Link>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {head.map(([k, v]) => (
            <div key={k} className="border border-line bg-black/40 p-2">
              <div className="font-mono text-[9px] uppercase tracking-wider text-tone-3">{k}</div>
              <div className="font-mono text-sm tabular-nums text-tone-1">{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-tone-3">
          <span>
            ilk ödeme: {loan.firstPaymentDate ?? "—"} · uygulanan faiz %{loan.appliedRate ?? "—"} · aylık maliyet %
            {loan.monthlyCostRate ?? "—"}
          </span>
          <span>
            kalan: {loan.remainingCount}/{loan.installmentsLoaded} taksit · {fmtTL(loan.remainingAmount)}
          </span>
          {loan.sourceWorkbookId && loan.sourceSheetId && (
            <Link
              className="underline decoration-line-strong underline-offset-2"
              href={`/imports/${loan.sourceWorkbookId}/sheets/${loan.sourceSheetId}`}
            >
              kaynak: faiz hesaplama →
            </Link>
          )}
        </div>
      </Panel>

      <Panel title={`TAKSİT PLANI — ${installments.length} (vadeler türetildi)`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                <th className="py-1 pr-2">#</th>
                <th className="py-1 pr-2">vade</th>
                <th className="py-1 pr-2 text-right">taksit</th>
                <th className="py-1 pr-2 text-right">anapara</th>
                <th className="py-1 pr-2 text-right">faiz</th>
                <th className="py-1 pr-2 text-right">vergi (KKDF+BSMV)</th>
                <th className="py-1">durum</th>
              </tr>
            </thead>
            <tbody>
              {installments.map((i) => {
                const overdue = i.status !== "paid" && i.dueDate < today;
                return (
                  <tr key={i.id} className="border-b border-line-faint">
                    <td className="py-1 pr-2 font-mono text-xs text-tone-3">{i.no}</td>
                    <td className={`py-1 pr-2 font-mono text-xs ${overdue ? "text-neg" : ""}`}>{i.dueDate}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums">{fmt0(i.amount)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-tone-2">{fmt0(i.principal)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-tone-2">{fmt0(i.interest)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-tone-2">{fmt0(i.tax)}</td>
                    <td className="py-1">
                      <Badge tone={STATUS_TONE[i.status] ?? "neutral"}>{overdue ? "gecikmiş" : i.status}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
