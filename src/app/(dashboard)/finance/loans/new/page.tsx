import Link from "@/components/ui/app-link";
import { createLoanAction } from "../../actions";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

const field = "field-control mt-1 w-full p-2 text-xs";

export default async function NewLoan({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const denied = await requireRouteAccess("/finance/loans/new");
  if (denied) return denied;

  const sp = (await searchParams) ?? {};
  const pool = getPool();
  const todayISO = istanbulDateISO();

  const [lendersRes, accountsRes] = await Promise.all([
    pool
      .query<{ id: string; name: string }>(
        `select id::text as id, name
           from public.parties
          where is_active = true
            and party_type in ('lender', 'bank', 'vendor', 'company', 'other')
          order by name asc
          limit 200`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query<{ id: string; name: string; currency: string; account_type: string }>(
        `select id::text as id, name, currency, account_type
           from public.cash_accounts
          where is_active = true
          order by name asc`,
      )
      .catch(() => ({ rows: [] })),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Yeni Ticari Kredi / Finansal Kiralama (Leasing) Planı"
        subtitle="Eşit taksit (annuity), eşit anapara, tek vadeli spot veya 301/302 finansal kiralama ödeme planını BSMV/KKDF ve 102/300 açılış yevmiyesiyle deterministik üretin."
        actions={
          <Link href="/finance/loans" className="button-ghost px-3 py-1.5 text-xs">
            ← Krediler Listesi
          </Link>
        }
      />

      {sp.error ? (
        <div
          className="rounded border px-3 py-2 text-xs"
          style={{
            borderColor: "color-mix(in oklab, var(--neg) 35%, var(--line))",
            background: "var(--neg-soft)",
            color: "var(--neg)",
          }}
        >
          {sp.error}
        </div>
      ) : null}

      <Panel
        title="Kredi & Amortisman Parametreleri"
        subtitle="Ondalık motoru (big.js) kuruş yuvarlama farklarını son taksitte kapatır; kayan nokta hatası oluşmaz."
      >
        <form action={createLoanAction} className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-medium text-tone-2 sm:col-span-2">
            Kredi / Sözleşme Adı
            <input
              required
              name="name"
              placeholder="Örn: İş Bankası Ticari Taksitli Kredi — CNC Yatırımı"
              className={field}
            />
          </label>
          <label className="text-xs font-medium text-tone-2">
            Banka / Leasing Kurumu (300 / 301 Cari)
            <select name="lenderPartyId" defaultValue="" className={field}>
              <option value="">— Finansör seçin (isteğe bağlı) —</option>
              {lendersRes.rows.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-tone-2">
            Kredi Türü
            <select name="loanKind" defaultValue="installment" className={field}>
              <option value="installment">Taksitli Ticari Kredi (300 / 400)</option>
              <option value="spot">Tek Vadeli Spot Kredi (300)</option>
              <option value="revolving">Rotatif Kredi Planı (300)</option>
              <option value="leasing">Finansal Kiralama / Leasing (253 + 302 / 301)</option>
            </select>
          </label>
          <label className="text-xs font-medium text-tone-2">
            Amortisman Yöntemi
            <select name="scheduleMethod" defaultValue="annuity" className={field}>
              <option value="annuity">Eşit Taksitli (Annuity — Sabit Aylık Ödeme)</option>
              <option value="equal_principal">Eşit Anaparalı (Azalan Taksitli)</option>
              <option value="spot">Tek Vadeli Spot (Vade Sonu Anapara + Faiz)</option>
              <option value="leasing">Finansal Kiralama (301 Kira Borcu / 302 Ertelenmiş Maliyet)</option>
            </select>
          </label>
          <label className="text-xs font-medium text-tone-2">
            Faiz Endeksi
            <select name="interestType" defaultValue="fixed" className={field}>
              <option value="fixed">Sabit Oranlı</option>
              <option value="floating_tlref">Değişken — TLREF + Spread (bps)</option>
              <option value="floating_sofr">Değişken — SOFR + Spread (bps)</option>
              <option value="floating_euribor">Değişken — EURIBOR + Spread (bps)</option>
            </select>
          </label>

          <label className="text-xs font-medium text-tone-2">
            Anapara Tutarı
            <input
              required
              name="principal"
              type="number"
              step="0.01"
              min="0.01"
              placeholder="Örn: 2500000.00"
              className={`${field} font-mono`}
            />
          </label>
          <label className="text-xs font-medium text-tone-2">
            Para Birimi
            <select name="currency" defaultValue="TRY" className={field}>
              <option value="TRY">TRY</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
            </select>
          </label>
          <label className="text-xs font-medium text-tone-2">
            Vade / Taksit Sayısı (Ay)
            <input
              required
              name="installmentCount"
              type="number"
              min="1"
              max="360"
              defaultValue="12"
              className={`${field} font-mono`}
            />
          </label>

          <label className="text-xs font-medium text-tone-2">
            Yıllık Nominal Faiz % (Sabit ise)
            <input
              required
              name="annualInterestRatePct"
              type="number"
              step="0.01"
              min="0"
              max="500"
              defaultValue="48.00"
              className={`${field} font-mono`}
            />
          </label>
          <label className="text-xs font-medium text-tone-2">
            Referans Endeks % (TLREF / SOFR / EURIBOR)
            <input
              name="referenceRatePct"
              type="number"
              step="0.01"
              min="0"
              placeholder="Sabit faizde boş bırakın"
              className={`${field} font-mono`}
            />
          </label>
          <label className="text-xs font-medium text-tone-2">
            Marj / Spread (bps — 100 bps = %1,00)
            <input
              name="spreadBps"
              type="number"
              step="1"
              min="0"
              placeholder="Örn: 350 (+%3,50)"
              className={`${field} font-mono`}
            />
          </label>

          <label className="text-xs font-medium text-tone-2">
            BSMV Oranı (Ticari varsayılan: 0.05 = %5)
            <input
              name="bsmvRate"
              type="number"
              step="0.005"
              min="0"
              max="1"
              defaultValue="0.05"
              className={`${field} font-mono`}
            />
          </label>
          <label className="text-xs font-medium text-tone-2">
            KKDF Oranı (Ticari TRY varsayılan: 0)
            <input
              name="kkdfRate"
              type="number"
              step="0.005"
              min="0"
              max="1"
              defaultValue="0"
              className={`${field} font-mono`}
            />
          </label>
          <label className="text-xs font-medium text-tone-2">
            Kullanım (Disbursement) Tarihi
            <input name="disbursementDate" type="date" defaultValue={todayISO} className={field} />
          </label>

          <label className="text-xs font-medium text-tone-2">
            İlk Taksit Vade Tarihi
            <input required name="firstPaymentDate" type="date" className={field} />
          </label>
          <label className="text-xs font-medium text-tone-2 sm:col-span-2">
            Anaparanın Yattığı Banka Hesabı (Seçilirse 102 / 300 açılış fişi + banka hareketi üretilir)
            <select name="disbursementAccountId" defaultValue="" className={field}>
              <option value="">— Geçmiş kredi devri (banka girişi üretme) —</option>
              {accountsRes.rows.map((ca) => (
                <option key={ca.id} value={ca.id}>
                  {ca.name} · {ca.currency} ({ca.account_type})
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-tone-2 sm:col-span-3">
            Sözleşme / Teminat Notu
            <input
              name="notes"
              placeholder="Örn: KGF kefaletli yatırım kredisi, erken kapama komisyonu %2"
              className={field}
            />
          </label>

          <div className="sm:col-span-3 flex items-center justify-end gap-2">
            <button type="submit" className="button-accent px-4 py-2 text-xs font-medium">
              Krediyi ve Amortisman Planını Oluştur
            </button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
