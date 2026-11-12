import Link from "@/components/ui/app-link";
import { getCurrentUser } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { moneyOrNull } from "@/lib/money";
import { Num, Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { Badge } from "@/components/ui/badge";
import { SavedViewsBar } from "@/components/ui/saved-views-bar";
import { PaymentItemsTable, type PaymentItemRow } from "@/components/payments/payment-items-table";
import { parseFilters } from "@/lib/ui/filters";
import { listSavedViews } from "@/lib/ui/saved-views";

export const dynamic = "force-dynamic";

export default async function PaymentItems({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const currentFilters = parseFilters(sp);
  const pool = getPool();
  const user = await getCurrentUser();
  const [{ rows }, savedViews] = await Promise.all([
    pool.query(`select p.id,p.name,p.recurrence_type,p.due_day,p.default_amount,p.amount_confidence,p.status,p.flexibility_class,c.name as category,pr.name as provider,ow.name as owner,(p.source_row_id is not null) as from_source from public.payments p left join public.categories c on c.id=p.category_id left join public.parties pr on pr.id=p.provider_party_id left join public.parties ow on ow.id=p.owner_party_id where p.status<>'archived' order by p.name`),
    listSavedViews(pool, "payments", user?.id ?? null).catch(() => []),
  ]);
  const allData: PaymentItemRow[] = rows.map((p) => ({
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
  const qLower = currentFilters.q.trim().toLowerCase();
  const data = qLower
    ? allData.filter(
        (item) =>
          item.name.toLowerCase().includes(qLower) ||
          (item.provider ?? "").toLowerCase().includes(qLower) ||
          (item.category ?? "").toLowerCase().includes(qLower),
      )
    : allData;
  const todayISO = new Date().toISOString().slice(0, 10);
  return (
    <>
      <PageHeader
        title="Ödeme Kalemleri"
        subtitle="Düzenli ve tek seferlik ödeme tanımları"
        meta={<Badge tone="neutral" dot>{data.length} kalem</Badge>}
        action={<Link href="/payments/new" className="button-accent px-3 py-2">Ödeme ekle</Link>}
      />
      <SavedViewsBar
        moduleKey="payments"
        basePath="/payments/items"
        views={savedViews}
        currentFilters={currentFilters}
        todayISO={todayISO}
        totalRows={data.length}
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
