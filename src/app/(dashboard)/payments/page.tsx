import Link from "next/link";
import { getPool } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Num, Panel, fmtTL } from "@/components/ui/panel";

export const dynamic = "force-dynamic";

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ mapped?: string; skipped?: string; excluded?: string }>;
}) {
  const sp = await searchParams;
  const pool = getPool();
  const { rows } = await pool.query(`
    select p.id, p.name, p.recurrence_type, p.due_day, p.default_amount::float8 as default_amount,
           p.amount_confidence, p.status, p.priority,
           c.name as category, pr.name as provider, ow.name as owner,
           (p.source_row_id is not null) as from_source
    from public.payments p
    left join public.categories c on c.id = p.category_id
    left join public.parties pr on pr.id = p.provider_party_id
    left join public.parties ow on ow.id = p.owner_party_id
    where p.status <> 'archived'
    order by p.name
  `);

  return (
    <>
      {sp.mapped != null && (
        <Panel title="EŞLEME SONUCU">
          <p className="text-sm">
            <Num>{sp.mapped}</Num> kalem aktarıldı · <Num>{sp.skipped}</Num> zaten eşliydi ·{" "}
            <Num>{sp.excluded}</Num> hariç (açık/ret inceleme veya isimsiz).
          </p>
        </Panel>
      )}
      <Panel title={`ÖDEME KALEMLERİ — ${rows.length}`}
        right={
          <Link href="/payments/new"
            className="border border-zinc-200 bg-zinc-200 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-950">
            + yeni kalem
          </Link>
        }>
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Henüz kalem yok. İçe aktarımdan &quot;kabul edilenleri aktar&quot; ile ya da + yeni kalem ile başlayın.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="py-1 pr-2">ad</th>
                <th className="py-1 pr-2">gün</th>
                <th className="py-1 pr-2">varsayılan tutar</th>
                <th className="py-1 pr-2">güven</th>
                <th className="py-1 pr-2">etiketler</th>
                <th className="py-1">kaynak</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-zinc-900">
                  <td className="py-1.5 pr-2">
                    <Link className="underline decoration-zinc-700 underline-offset-2 hover:text-white"
                      href={`/payments/${p.id}/edit`}>{p.name}</Link>
                    {p.status === "paused" && <Badge tone="neutral">duraklatıldı</Badge>}
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-xs">
                    {p.recurrence_type === "monthly"
                      ? <>{p.due_day}. gün</>
                      : <Badge tone="amber">{p.recurrence_type === "irregular" ? "günsüz" : p.recurrence_type}</Badge>}
                  </td>
                  <td className={`py-1.5 pr-2 font-mono tabular-nums ${p.default_amount != null && p.default_amount < 0 ? "text-red-400" : ""}`}>
                    {p.default_amount == null ? <Badge tone="amber">EKSİK</Badge> : fmtTL(p.default_amount)}
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-xs text-zinc-400">{p.amount_confidence}</td>
                  <td className="py-1.5 pr-2 text-xs text-zinc-400">
                    {[p.category, p.provider, p.owner].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="py-1.5">{p.from_source ? <Badge tone="blue">excel</Badge> : <Badge tone="neutral">manuel</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
