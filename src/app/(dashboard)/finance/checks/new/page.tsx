import Link from "@/components/ui/app-link";
import { createCheckAction } from "../../actions";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { formatMoney } from "@/lib/money-format";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

const field = "field-control mt-1 w-full p-2 text-xs";

export default async function NewCheck() {
  const denied = await requireRouteAccess("/finance/checks/new");
  if (denied) return denied;

  const pool = getPool();
  const todayISO = istanbulDateISO();

  const [partiesRes, openInvoicesRes] = await Promise.all([
    pool
      .query<{ id: string; name: string; party_type: string; tax_no: string | null }>(
        `select id::text as id, name, party_type, tax_no
           from public.parties
          where is_active = true
          order by name asc
          limit 300`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query<{
        id: string;
        invoice_no: string;
        direction: string;
        currency: string;
        due_date: string | null;
        party_name: string | null;
        open_amount: string;
      }>(
        `select v.id::text as id,
                coalesce(v.invoice_no, left(v.id::text, 8)) as invoice_no,
                v.direction,
                coalesce(v.currency, 'TRY') as currency,
                to_char(v.due_date, 'YYYY-MM-DD') as due_date,
                p.name as party_name,
                greatest(
                  0,
                  coalesce(v.payable_amount, v.gross_amount) -
                  greatest(coalesce(v.paid_amount, 0), coalesce(v.allocated_amount, 0))
                )::numeric(14,2)::text as open_amount
           from public.invoices v
           left join public.parties p on p.id = v.party_id
          where v.status in ('open', 'partial')
            and v.archived_at is null
          order by v.due_date asc nulls last, v.issue_date desc
          limit 200`,
      )
      .catch(() => ({ rows: [] })),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Yeni Çek / Senet (TTK m.780 & Cari Fatura Bağlantılı)"
        subtitle="Portföye müşteri çeki/senedi girişi (101/121 ↔ 120) veya tedarikçiye borç çeki/senedi keşidesi (320 ↔ 103/321) kaydedin."
        actions={
          <Link href="/finance/checks" className="button-ghost px-3 py-1.5 text-xs">
            ← Çek / Senet Portföyü
          </Link>
        }
      />
      <Panel
        title="Kıymetli Evrak & Cari Mahsup Bilgileri"
        subtitle="Açık fatura seçildiğinde invoice_allocations üzerinden fatura bakiyesi otomatik düşülür ve TDHP yevmiyesi üretilir."
      >
        <form action={createCheckAction} className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-medium text-tone-2">
            Evrak türü
            <select name="instrumentType" defaultValue="check" className={field}>
              <option value="check">Çek (101 / 103)</option>
              <option value="promissory_note">Senet / Bono (121 / 321)</option>
            </select>
          </label>
          <label className="text-xs font-medium text-tone-2">
            Yön
            <select name="direction" defaultValue="inflow" className={field}>
              <option value="inflow">Tahsil edilecek (Müşteri Portföy Çeki/Senedi — 101/121)</option>
              <option value="outflow">Ödenecek (Keşide Borç Çeki/Senedi — 103/321)</option>
              <option value="unknown">Belirsiz (Sınıflandırma Bekleyen)</option>
            </select>
          </label>
          <label className="text-xs font-medium text-tone-2">
            Vade tarihi
            <input required name="maturityDate" type="date" className={field} />
          </label>

          <label className="text-xs font-medium text-tone-2">
            Tutar
            <input
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              placeholder="Örn: 125000.00"
              className={`${field} font-mono`}
            />
          </label>
          <label className="text-xs font-medium text-tone-2">
            Para birimi
            <select name="currency" defaultValue="TRY" className={field}>
              <option value="TRY">TRY</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
            </select>
          </label>
          <label className="text-xs font-medium text-tone-2">
            Seri / Evrak No
            <input name="serial" placeholder="Örn: ÇEK-2026-00412" className={`${field} font-mono`} />
          </label>

          <label className="text-xs font-medium text-tone-2">
            Kayıtlı Cari (Müşteri / Tedarikçi)
            <select name="partyId" defaultValue="" className={field}>
              <option value="">— Serbest metin kullan veya cari seçin —</option>
              {partiesRes.rows.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.party_type}){p.tax_no ? ` · VKN: ${p.tax_no}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-tone-2">
            Karşı taraf (Serbest etiket / Keşideci adı)
            <input name="counterparty" placeholder="Cari seçilmediyse ünvan" className={field} />
          </label>
          <label className="text-xs font-medium text-tone-2">
            Keşideci VKN / TCKN (TTK m.780)
            <input
              name="drawerTaxNo"
              maxLength={20}
              placeholder="10 veya 11 haneli vergi/TC no"
              className={`${field} font-mono`}
            />
          </label>

          <label className="text-xs font-medium text-tone-2">
            Düzenleme (Keşide) Tarihi
            <input name="issueDate" type="date" defaultValue={todayISO} className={field} />
          </label>
          <label className="text-xs font-medium text-tone-2">
            Düzenleme Yeri (TTK m.780)
            <input name="issuePlace" defaultValue="İstanbul" placeholder="Örn: İstanbul" className={field} />
          </label>
          <label className="text-xs font-medium text-tone-2">
            Kapatılacak Açık Fatura (120 / 320 Mahsubu — İsteğe Bağlı)
            <select name="settledInvoiceId" defaultValue="" className={field}>
              <option value="">— Fatura bağlamadan kaydet —</option>
              {openInvoicesRes.rows.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  [{inv.direction === "sales" ? "120 Satış" : "320 Alış"}] {inv.invoice_no}
                  {inv.party_name ? ` · ${inv.party_name}` : ""} · Açık:{" "}
                  {formatMoney(inv.open_amount, inv.currency)}
                  {inv.due_date ? ` · Vade: ${inv.due_date}` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-tone-2 sm:col-span-3">
            Not / Bordro açıklaması
            <input name="notes" placeholder="Örn: Sözleşme avans senedi / 90 gün vadeli müşteri çeki" className={field} />
          </label>

          <div className="sm:col-span-3 flex items-center justify-end gap-2">
            <button type="submit" className="button-accent px-4 py-2 text-xs font-medium">
              Çeki / Senedi Kaydet
            </button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
