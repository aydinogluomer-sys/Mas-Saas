import { getPool } from "@/lib/db";
import { Panel } from "@/components/ui/panel";
import { archivePaymentAction } from "@/app/(dashboard)/payments/actions";

interface Dict { id: string; name: string }
export interface PaymentFormValues {
  id?: string;
  name?: string;
  recurrence_type?: string;
  due_day?: number | null;
  due_date?: string | null;
  default_amount?: number | null;
  amount_confidence?: string;
  direction?: string;
  priority?: string;
  status?: string;
  category_id?: string | null;
  provider_party_id?: string | null;
  owner_party_id?: string | null;
  cash_account_id?: string | null;
  description?: string | null;
}

const L = ({ children }: { children: React.ReactNode }) => (
  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">{children}</label>
);
const inputCls = "w-full border border-zinc-800 bg-black/40 px-2 py-2 text-sm";

function Select({ name, value, options, allowEmpty = true }: {
  name: string; value: string | null | undefined; options: Array<[string, string]>; allowEmpty?: boolean;
}) {
  return (
    <select name={name} defaultValue={value ?? ""} className={inputCls}>
      {allowEmpty && <option value="">(atanmadı)</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export async function PaymentForm({
  action, values, error, title,
}: {
  action: (formData: FormData) => Promise<void>;
  values: PaymentFormValues;
  error?: string;
  title: string;
}) {
  const pool = getPool();
  const [cats, parties, accounts] = await Promise.all([
    pool.query<Dict>(`select id, name from public.categories where is_active order by sort_order`),
    pool.query<Dict & { party_type: string }>(`select id, name, party_type from public.parties where is_active order by name`),
    pool.query<Dict>(`select id, name from public.cash_accounts where is_active order by name`),
  ]);
  const providers = parties.rows.filter((p) => ["bank", "provider", "vendor"].includes(p.party_type));
  const owners = parties.rows.filter((p) => ["company", "person", "internal_owner"].includes(p.party_type));

  return (
    <Panel title={title}>
      {error && <div className="mb-3 border border-red-900 bg-red-950/40 p-2 font-mono text-xs text-red-300">{error}</div>}
      <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {values.id && <input type="hidden" name="id" value={values.id} />}
        <div className="sm:col-span-2">
          <L>Ödeme adı *</L>
          <input name="name" defaultValue={values.name ?? ""} required className={inputCls} placeholder="örn. MAS Elektrik" />
        </div>
        <div>
          <L>Tekrar</L>
          <Select name="recurrence_type" value={values.recurrence_type ?? "monthly"} allowEmpty={false}
            options={[["monthly", "Her ay"], ["irregular", "Düzensiz (günsüz)"], ["one_off", "Tek seferlik"]]} />
        </div>
        <div>
          <L>Son ödeme günü (aylıkta zorunlu, 1-31)</L>
          <input name="due_day" inputMode="numeric" defaultValue={values.due_day ?? ""} className={`${inputCls} font-mono`} placeholder="boş = günsüz" />
        </div>
        <div>
          <L>Tek seferlik tarih</L>
          <input type="date" name="due_date" defaultValue={values.due_date ?? ""} className={inputCls} />
        </div>
        <div>
          <L>Varsayılan tutar (TL) — boş bırakılabilir, 0 SAYILMAZ</L>
          <input name="default_amount" inputMode="numeric" defaultValue={values.default_amount ?? ""} className={`${inputCls} font-mono`} placeholder="bilinmiyor" />
        </div>
        <div>
          <L>Tutar güveni</L>
          <Select name="amount_confidence" value={values.amount_confidence ?? "known"} allowEmpty={false}
            options={[["known", "Bilinen"], ["variable", "Değişken (KK ekstresi)"], ["estimated", "Tahmini"], ["unknown", "Bilinmiyor"]]} />
        </div>
        <div>
          <L>Öncelik</L>
          <Select name="priority" value={values.priority ?? "normal"} allowEmpty={false}
            options={[["low", "Düşük"], ["normal", "Normal"], ["high", "Yüksek"], ["critical", "Kritik"]]} />
        </div>
        <div>
          <L>Durum</L>
          <Select name="status" value={values.status ?? "active"} allowEmpty={false}
            options={[["active", "Aktif"], ["paused", "Duraklatıldı"]]} />
        </div>
        <input type="hidden" name="direction" value={values.direction ?? "outflow"} />
        <div>
          <L>Kategori</L>
          <Select name="category_id" value={values.category_id} options={cats.rows.map((c) => [c.id, c.name])} />
        </div>
        <div>
          <L>Banka / Sağlayıcı</L>
          <Select name="provider_party_id" value={values.provider_party_id} options={providers.map((p) => [p.id, p.name])} />
        </div>
        <div>
          <L>Kime ait</L>
          <Select name="owner_party_id" value={values.owner_party_id} options={owners.map((p) => [p.id, p.name])} />
        </div>
        <div>
          <L>Hesap</L>
          <Select name="cash_account_id" value={values.cash_account_id} options={accounts.rows.map((a) => [a.id, a.name])} />
        </div>
        <div className="sm:col-span-2">
          <L>Not</L>
          <input name="description" defaultValue={values.description ?? ""} className={inputCls} />
        </div>
        <div className="flex items-center justify-between sm:col-span-2">
          {values.id ? (
            <div className="flex items-center gap-2">
              <input name="archive_reason" placeholder="arşivleme nedeni"
                className="border border-zinc-700 bg-zinc-900 px-2 py-2 font-mono text-[10px] text-zinc-200" />
              <button formAction={archivePaymentAction}
                className="border border-red-800 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-red-400">
                arşivle
              </button>
            </div>
          ) : <span />}
          <button type="submit"
            className="border border-zinc-200 bg-zinc-200 px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-zinc-950">
            kaydet
          </button>
        </div>
        {values.id && (
          <p className="text-[11px] text-zinc-500 sm:col-span-2">
            Not: değişiklikler geçmiş ve bu ay üretilmiş kayıtları değiştirmez; yeni aylar yeni değerlerle üretilir.
            Eksik tutarı bu aya özel girmek için Radar &gt; Eksik Veri panelini kullanın.
          </p>
        )}
      </form>
    </Panel>
  );
}
