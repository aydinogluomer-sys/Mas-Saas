import Link from "next/link";
import { getPool } from "@/lib/db";
import { loadLoans } from "@/lib/financing/engine";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { LoansTable, type LoanRow } from "@/components/finance/loans-table";

export const dynamic = "force-dynamic";

export default async function LoansPage() {
  const rows = await loadLoans(getPool());
  const data: LoanRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    principal: r.principal,
    totalPayment: r.totalPayment,
    totalFinanceCost: r.totalFinanceCost,
    remainingAmount: r.remainingAmount,
  }));
  return (
    <>
      <PageHeader
        title="Krediler"
        subtitle="Anapara, toplam maliyet, kalan borç ve taksit planları"
        action={<Link href="/finance/loans/new" className="button-accent px-3 py-2">Yeni kredi</Link>}
      />
      <Panel title={`${data.length} kredi`}>
        <LoansTable rows={data} />
      </Panel>
    </>
  );
}
