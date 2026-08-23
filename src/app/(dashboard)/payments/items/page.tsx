import Link from "next/link";
import { getPool } from "@/lib/db";
import { moneyOrNull } from "@/lib/money";
import { Num, Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { Badge } from "@/components/ui/badge";
import { PaymentItemsTable, type PaymentItemRow } from "@/components/payments/payment-items-table";

export const dynamic = "force-dynamic";

export default async function PaymentItems({ searchParams }: { searchParams: Promise<{ mapped?: string; skipped?: string; excluded?: string }> }) {
  const sp = await searchParams;
  const pool = getPool();
  const { rows } = await pool.query(`select p.id,p.name,p.recurrence_type,p.due_day,p.default_amount,p.amount_confidence,p.status,p.flexibility_class,c.name as category,pr.name as provider,ow.name as owner,(p.source_row_id is not null) as from_source from public.payments p left join public.categories c on c.id=p.category_id left join public.parties pr on pr.id=p.provider_party_id left join public.parties ow on ow.id=p.owner_party_id where p.status<>'archived' order by p.name`);
  const data: PaymentItemRow[] = rows.map((p) => ({
    id: p.id,
    name: p.name,
    recurrence_type: p.recurrence_type,
    due_day: p.due_day,
    default_amount: moneyOrNull(p.default_amount),
    amount_confidence: p.amount_confidence,
    status: p.status,
    flexibility_class: p.flexibility_class,
    category: p.category,
    provider: p.provider,
    owner: p.owner,
    from_source: p.from_source,
  }));
  return (
    <>
      {/* Faz 36: this page carried no PageHeader while every comparable screen did — the sampled
          consistency check found it. A module where one screen announces itself differently is
          how a product starts feeling assembled rather than designed. */}
      <PageHeader
        title="Ödeme Kalemleri"
        subtitle="Düzenli ve tek seferlik ödeme tanımları"
        meta={<Badge tone="neutral" dot>{data.length} kalem</Badge>}
        action={<Link href="/payments/new" className="button-accent px-3 py-2">Ödeme ekle</Link>}
      />
      {sp.mapped != null && (
        <Panel title="Eşleme sonucu">
          <p className="text-sm"><Num>{sp.mapped}</Num> kalem aktarıldı · <Num>{sp.skipped}</Num> zaten eşliydi · <Num>{sp.excluded}</Num> inceleme nedeniyle hariç.</p>
        </Panel>
      )}
      <Panel title="Ödeme kalemleri">
        <PaymentItemsTable rows={data} />
      </Panel>
    </>
  );
}
