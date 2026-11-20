import Link from "@/components/ui/app-link";
import { ConcentrationBars } from "@/components/cashflow/charts";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { moneyOrNull } from "@/lib/money";
import { concentration } from "@/lib/radar/rules";

export const dynamic = "force-dynamic";

const asLines = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => ({
    key: (r.key as string | null) ?? null,
    amount: moneyOrNull(r.amount as string | number | null),
  }));

export default async function CashflowConcentration() {
  const denied = await requireRouteAccess("/cashflow/concentration");
  if (denied) return denied;

  const pool = getPool();

  const [liveIncomeRes, liveVendorRes] = await Promise.all([
    pool.query(
      `with latest_fx as (
         select distinct on (base_currency) base_currency, rate
           from public.fx_rate_snapshots
          where quote_currency = 'TRY' and rate > 0
          order by base_currency, rate_date desc, fetched_at desc
       )
       select coalesce(p.name, 'Bilinmeyen Müşteri') as key,
              (case
                 when inv.currency = 'TRY' then inv.net_amount
                 else inv.net_amount * coalesce(fx.rate, 1)
               end)::numeric(14,2)::text as amount
         from public.invoices inv
         left join public.parties p on p.id = inv.party_id
         left join latest_fx fx on fx.base_currency = inv.currency
        where inv.direction = 'sales'
          and inv.status <> 'cancelled'
          and inv.archived_at is null
          and (inv.currency = 'TRY' or fx.rate is not null)
       union all
       select coalesce(bt.counterparty_name_raw, bt.description, 'Eşleşmemiş Banka Girişi') as key,
              (case
                 when ca.currency = 'TRY' then bt.amount
                 else bt.amount * coalesce(fx.rate, 1)
               end)::numeric(14,2)::text as amount
         from public.bank_transactions bt
         join public.cash_accounts ca on ca.id = bt.bank_account_id
         left join latest_fx fx on fx.base_currency = ca.currency
        where bt.amount > 0
          and bt.status = 'unmatched'
          and coalesce(bt.transaction_kind, '') <> 'own_transfer'
          and (ca.currency = 'TRY' or fx.rate is not null)`,
    ),
    pool.query(
      `with latest_fx as (
         select distinct on (base_currency) base_currency, rate
           from public.fx_rate_snapshots
          where quote_currency = 'TRY' and rate > 0
          order by base_currency, rate_date desc, fetched_at desc
       )
       select coalesce(p.name, 'Bilinmeyen Tedarikçi') as key,
              (case
                 when inv.currency = 'TRY' then inv.net_amount
                 else inv.net_amount * coalesce(fx.rate, 1)
               end)::numeric(14,2)::text as amount
         from public.invoices inv
         left join public.parties p on p.id = inv.party_id
         left join latest_fx fx on fx.base_currency = inv.currency
        where inv.direction = 'purchase'
          and inv.status <> 'cancelled'
          and inv.archived_at is null
          and (inv.currency = 'TRY' or fx.rate is not null)
       union all
       select coalesce(bt.counterparty_name_raw, bt.description, 'Eşleşmemiş Banka Çıkışı') as key,
              (case
                 when ca.currency = 'TRY' then abs(bt.amount)
                 else abs(bt.amount) * coalesce(fx.rate, 1)
               end)::numeric(14,2)::text as amount
         from public.bank_transactions bt
         join public.cash_accounts ca on ca.id = bt.bank_account_id
         left join latest_fx fx on fx.base_currency = ca.currency
        where bt.amount < 0
          and bt.status = 'unmatched'
          and coalesce(bt.transaction_kind, '') <> 'own_transfer'
          and (ca.currency = 'TRY' or fx.rate is not null)`,
    ),
  ]);

  let incomeRows = liveIncomeRes.rows;
  let vendorRows = liveVendorRes.rows;
  let sourceMode = "Canlı Faturalar + Eşleşmemiş Banka Hareketleri (KDV Hariç, TCMB Konsolide TRY)";

  if (incomeRows.length === 0 && vendorRows.length === 0) {
    const [fallbackInc, fallbackVen] = await Promise.all([
      pool.query(
        `select coalesce(p.name, cl.label) as key, cl.amount::text as amount
           from public.cashflow_lines cl
           left join public.parties p on p.id = cl.party_id
          where cl.line_type = 'customer_income'`,
      ),
      pool.query(
        `select coalesce(p.name, cl.label) as key, cl.amount::text as amount
           from public.cashflow_lines cl
           left join public.parties p on p.id = cl.party_id
          where cl.line_type = 'vendor_payment'`,
      ),
    ]);
    incomeRows = fallbackInc.rows;
    vendorRows = fallbackVen.rows;
    sourceMode = "Tarihsel Nakit Akış Satırları (Canlı fatura/banka kaydı bulunamadığında yedek)";
  }

  const income = concentration(asLines(incomeRows));
  const vendor = concentration(asLines(vendorRows));
  const topCustomer = income.entries[0] ?? null;
  const topVendor = vendor.entries[0] ?? null;
  const hasCritical = income.entries.some((e) => e.flagged) || vendor.entries.some((e) => e.flagged);

  return (
    <>
      <PageHeader
        title="Nakit ve Cari Yoğunlaşma Analizi"
        subtitle="Müşteri gelirlerinin ve tedarikçi harcamalarının tekil karşı taraf bağımlılık riski (%25 izleme, %40 kritik eşik)"
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="blue">{sourceMode}</Badge>
            <Badge tone={hasCritical ? "amber" : "green"} dot>
              {hasCritical ? "Kritik yoğunlaşma tespit edildi" : "Dengeli dağılım"}
            </Badge>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiCard label="Toplam Müşteri Hacmi" value={fmtTL(income.knownTotal)} tone="info" />
        <KpiCard
          label="En Büyük Müşteri Payı"
          value={topCustomer ? `%${(topCustomer.ratio * 100).toFixed(1)}` : "—"}
          note={topCustomer ? topCustomer.key : "Kayıt yok"}
          tone={topCustomer?.flagged ? "neg" : "pos"}
        />
        <KpiCard label="Toplam Tedarikçi Hacmi" value={fmtTL(vendor.knownTotal)} tone="neutral" />
        <KpiCard
          label="En Büyük Tedarikçi Payı"
          value={topVendor ? `%${(topVendor.ratio * 100).toFixed(1)}` : "—"}
          note={topVendor ? topVendor.key : "Kayıt yok"}
          tone={topVendor?.flagged ? "neg" : "pos"}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          title="MÜŞTERİ GELİR YOĞUNLAŞMASI"
          subtitle="KDV hariç satış faturaları ve eşleşmemiş banka tahsilatları (virmanlar hariç)"
          right={
            <Link href="/finance/receivables" className="text-xs underline" style={{ color: "var(--accent)" }}>
              Alacaklar →
            </Link>
          }
        >
          <ConcentrationBars entries={income.entries} unknownCount={income.unknownCount} />
        </Panel>
        <Panel
          title="TEDARİKÇİ GİDER YOĞUNLAŞMASI"
          subtitle="KDV hariç alış faturaları ve eşleşmemiş banka ödemeleri (virmanlar hariç)"
          right={
            <Link href="/finance/invoices" className="text-xs underline" style={{ color: "var(--accent)" }}>
              Faturalar →
            </Link>
          }
        >
          <ConcentrationBars entries={vendor.entries} unknownCount={vendor.unknownCount} />
        </Panel>
      </div>
    </>
  );
}
