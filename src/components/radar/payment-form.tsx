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
  currency?: string | null;
  amount_confidence?: string;
  direction?: string;
  priority?: string;
  flexibility_class?: string | null;
  status?: string;
  category_id?: string | null;
  provider_party_id?: string | null;
  owner_party_id?: string | null;
  cash_account_id?: string | null;
  cost_center_id?: string | null;
  project_id?: string | null;
  department_id?: string | null;
  description?: string | null;
  iban?: string | null;
  tdhp_expense_code?: string | null;
  auto_match_vkn?: string | null;
}

const L = ({ children }: { children: React.ReactNode }) => (
  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-tone-3">{children}</label>
);
const inputCls = "field-control w-full px-2 py-2 text-sm";

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

export function PaymentFormFields({
  action,
  values,
  cats,
  providers,
  owners,
  accounts,
  costCenters = [],
  projects = [],
  departments = [],
}: {
  action: (formData: FormData) => Promise<void>;
  values: PaymentFormValues;
  cats: Dict[];
  providers: Dict[];
  owners: Dict[];
  accounts: Dict[];
  costCenters?: Dict[];
  projects?: Dict[];
  departments?: Dict[];
}) {
  return (
    <>
      <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="payment-edit-form">
        {values.id && <input type="hidden" name="id" value={values.id} />}
        <div className="sm:col-span-2">
          <L>Ödeme adı *</L>
          <input name="name" defaultValue={values.name ?? ""} required className={inputCls} placeholder="örn. MAS Elektrik" />
        </div>
        <div>
          <L>Tekrar</L>
          <Select name="recurrence_type" value={values.recurrence_type ?? "monthly"} allowEmpty={false}
            options={[
              ["monthly", "Her ay"],
              ["weekly", "Her hafta (aylık 4/5 hafta toplamı)"],
              ["quarterly", "Üç ayda bir (Çeyreklik)"],
              ["yearly", "Yıllık"],
              ["irregular", "Düzensiz (günsüz)"],
              ["one_off", "Tek seferlik"],
            ]} />
        </div>
        <div>
          <L>Son ödeme günü (aylıkta zorunlu, 1-31)</L>
          <input name="due_day" inputMode="numeric" defaultValue={values.due_day ?? ""} className={`${inputCls} font-mono`} placeholder="boş = günsüz" />
        </div>
        <div>
          <L>Başlangıç / Tek seferlik vade tarihi</L>
          <input type="date" name="due_date" defaultValue={values.due_date ?? ""} className={inputCls} />
        </div>
        <div>
          <L>Varsayılan tutar — boş bırakılabilir, 0 SAYILMAZ</L>
          <input name="default_amount" inputMode="numeric" defaultValue={values.default_amount ?? ""} className={`${inputCls} font-mono`} placeholder="bilinmiyor" />
        </div>
        <div>
          <L>Döviz cinsi</L>
          <Select name="currency" value={values.currency ?? "TRY"} allowEmpty={false}
            options={[
              ["TRY", "TRY — Türk Lirası"],
              ["USD", "USD — ABD Doları"],
              ["EUR", "EUR — Euro"],
              ["GBP", "GBP — İngiliz Sterlini"],
            ]} />
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
        <div>
          <L>Ödeme esnekliği</L>
          <Select name="flexibility_class" value={values.flexibility_class} options={[["critical", "Kritik · ertelenemez"], ["flexible", "Esnek · müzakere edilebilir"], ["optional", "İsteğe bağlı · durdurulabilir"]]} />
        </div>
        <input type="hidden" name="direction" value={values.direction ?? "outflow"} />
        <div>
          <L>Kategori</L>
          <Select name="category_id" value={values.category_id} options={cats.map((c) => [c.id, c.name])} />
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
          <Select name="cash_account_id" value={values.cash_account_id} options={accounts.map((a) => [a.id, a.name])} />
        </div>
        <div>
          <L>Alacaklı IBAN (isteğe bağlı)</L>
          <input name="iban" defaultValue={values.iban ?? ""} className={`${inputCls} font-mono`} placeholder="TR00..." />
        </div>
        <div>
          <L>TDHP Gider / Yükümlülük Hesap Kodu</L>
          <Select name="tdhp_expense_code" value={values.tdhp_expense_code ?? "770"} allowEmpty={false}
            options={[
              ["770", "770 — Genel Yönetim Giderleri"],
              ["760", "760 — Pazarlama Satış Dağıtım"],
              ["740", "740 — Hizmet Üretim Maliyeti"],
              ["730", "730 — Genel Üretim Giderleri"],
              ["320", "320 — Satıcılar (Fatura Kapama)"],
              ["335", "335 — Personele Borçlar"],
              ["360", "360 — Ödenecek Vergi ve Fonlar"],
              ["361", "361 — Ödenecek Sosyal Güvenlik Kesintileri"],
            ]} />
        </div>
        <div>
          <L>Otomatik Fatura Eşleme VKN/TCKN</L>
          <input name="auto_match_vkn" defaultValue={values.auto_match_vkn ?? ""} className={`${inputCls} font-mono`} placeholder="10 veya 11 hane" />
        </div>
        <div>
          <L>Proje</L>
          <Select name="project_id" value={values.project_id} options={projects.map((p) => [p.id, p.name])} />
        </div>
        <div>
          <L>Masraf Merkezi</L>
          <Select name="cost_center_id" value={values.cost_center_id} options={costCenters.map((c) => [c.id, c.name])} />
        </div>
        <div>
          <L>Departman</L>
          <Select name="department_id" value={values.department_id} options={departments.map((d) => [d.id, d.name])} />
        </div>
        <div className="sm:col-span-2">
          <L>Not</L>
          <input name="description" defaultValue={values.description ?? ""} className={inputCls} />
        </div>
        <div className="flex items-center justify-end sm:col-span-2">
          <button type="submit" className="button-primary px-3 py-2 text-xs">
            kaydet
          </button>
        </div>
        {values.id && (
          <p className="text-[11px] text-tone-3 sm:col-span-2">
            Not: tutar, döviz ve gün güncellemeleri henüz ödenmemiş ileri tarihli şablon örneklerine yansıtılır;
            geçmiş dönem veya elle değiştirilmiş tutarlara dokunulmaz.
          </p>
        )}
      </form>

      {values.id && (
        <form
          action={archivePaymentAction}
          data-testid="payment-archive-form"
          className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line-faint pt-3"
        >
          <input type="hidden" name="id" value={values.id} />
          <div className="flex flex-wrap items-center gap-2">
            <input
              required
              name="archive_reason"
              placeholder="arşivleme nedeni"
              className="field-control px-2 py-2 font-mono text-[10px] text-tone-2"
            />
            <button
              type="submit"
              className="border border-neg px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-neg"
            >
              Arşivle
            </button>
          </div>
          <span className="text-[11px] text-tone-4">
            Arşivleme kalemi pasife alır; geçmiş ödeme örnekleri ve denetim izi korunur.
          </span>
        </form>
      )}
    </>
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
  const [cats, parties, accounts, costCenters, projects, departments] = await Promise.all([
    pool.query<Dict>(`select id, name from public.categories where is_active order by sort_order`),
    pool.query<Dict & { party_type: string }>(`select id, name, party_type from public.parties where is_active order by name`),
    pool.query<Dict>(`select id, name from public.cash_accounts where is_active order by name`),
    pool.query<Dict>(`select id, concat(code, ' · ', name) as name from public.cost_centers where is_active order by code`),
    pool.query<Dict>(`select id, concat(code, ' · ', name) as name from public.projects where is_active order by code`),
    pool.query<Dict>(`select id, concat(code, ' · ', name) as name from public.departments where is_active order by code`),
  ]);
  const providers = parties.rows.filter((p) => ["bank", "provider", "vendor"].includes(p.party_type));
  const owners = parties.rows.filter((p) => ["company", "person", "internal_owner"].includes(p.party_type));

  return (
    <Panel title={title}>
      {error && <div className="mb-3 border border-neg tint-neg p-2 font-mono text-xs text-neg">{error}</div>}
      <PaymentFormFields
        action={action}
        values={values}
        cats={cats.rows}
        providers={providers}
        owners={owners}
        accounts={accounts.rows}
        costCenters={costCenters.rows}
        projects={projects.rows}
        departments={departments.rows}
      />
    </Panel>
  );
}
