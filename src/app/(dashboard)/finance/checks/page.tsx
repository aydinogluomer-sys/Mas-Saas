import Link from "next/link";
import { getPool } from "@/lib/db";
import { loadChecks } from "@/lib/financing/engine";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { ChecksTable, type CheckRow } from "@/components/finance/checks-table";

export const dynamic = "force-dynamic";

export default async function ChecksPage() {
  const rows = await loadChecks(getPool());
  const data: CheckRow[] = rows.map((r) => ({
    id: r.id,
    maturityDate: r.maturityDate,
    direction: r.direction,
    counterparty: r.payee ?? r.payer ?? "—",
    bank: r.bank ?? null,
    serial: r.serial ?? null,
    amount: r.amount,
    status: r.status,
  }));
  return (
    <>
      <PageHeader
        title="Çekler"
        subtitle="Çek defteri, yön, karşı taraf, banka ve kaynak kaydı"
        action={<Link href="/finance/checks/new" className="button-accent px-3 py-2">Yeni çek</Link>}
      />
      <Panel title={`${data.length} çek`}>
        <ChecksTable rows={data} />
      </Panel>
    </>
  );
}
