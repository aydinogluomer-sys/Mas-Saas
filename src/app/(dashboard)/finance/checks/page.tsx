import Link from "next/link";
import { getPool } from "@/lib/db";
import { countChecks, loadChecks } from "@/lib/financing/engine";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { ChecksTable, type CheckRow } from "@/components/finance/checks-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 500;

export default async function ChecksPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const requestedPage = Number((await searchParams).page ?? "1");
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pool = getPool();
  const [rows, total] = await Promise.all([
    loadChecks(pool, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countChecks(pool),
  ]);
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
      <Panel title={`${total} çek · ${Math.min((page - 1) * PAGE_SIZE + 1, total)}–${Math.min(page * PAGE_SIZE, total)}`}>
        <ChecksTable rows={data} />
        <div className="mt-3 flex items-center justify-between text-xs">
          {page > 1 ? <Link href={`/finance/checks?page=${page - 1}`} className="button-ghost px-3 py-2">Önceki 500</Link> : <span />}
          <span className="text-tone-3">Sayfa {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
          {page * PAGE_SIZE < total ? <Link href={`/finance/checks?page=${page + 1}`} className="button-ghost px-3 py-2">Sonraki 500</Link> : <span />}
        </div>
      </Panel>
    </>
  );
}
