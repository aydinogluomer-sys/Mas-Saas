-- Standart Import V2 — kullanıcının kendi kayıt kodu (external_id) için kimlik defteri.
--
-- ═══ NEDEN AYRI BİR TABLO, 16 TABLOYA KOLON EKLEMEK YERİNE ═══
--
-- V2 sözleşmesi her sayfada isteğe bağlı bir "Kayıt Kodu (external_id)" sütunu tanımlıyor ve
-- vaadi şu: aynı kodla tekrar import edersen kayıt GÜNCELLENİR, ikinci kopya oluşmaz. Şemayı
-- denetlediğimde bu vaadin dayanacağı hiçbir yer olmadığı çıktı: 16 hedef tablonun HİÇBİRİNDE
-- external_id kolonu yok. Yani idempotency iddiası, kolonu olmayan bir anahtar üzerine
-- kuruluydu.
--
-- İki seçenek vardı. Kolonu 16 finansal tabloya tek tek eklemek, ya da eşlemeyi ayrı bir
-- deftere almak. İkincisi seçildi:
--
--   1. O 16 tablonun üzerinde append-only audit (0022), arşiv değişmezlik tetikleyicisi (0024)
--      ve durum geçiş muhafızı (0027) çalışıyor. Onaltı ALTER TABLE, bu koruma katmanlarının
--      hepsiyle tek tek yüzleşmek demek — kazancı olmayan bir risk.
--
--   2. external_id bir FİNANSAL ÖZELLİK DEĞİL, bir import ad alanıdır. Ödemenin tutarı,
--      vadesi, para birimi şirketin verisidir; "ODM-ELEKTRIK" ise kullanıcının kendi dosyasında
--      kullandığı etiket. Finansal tablonun dışında tutmak, bu etiketin yanlışlıkla domain
--      kısıtlarına karışmasını ya da motor tarafından iş anahtarı sanılmasını engeller.
--
-- ═══ NE YAPMAZ ═══
--
-- Bu tablo MÜKERRER SİLMEZ ve BİRLEŞTİRMEZ. Yalnız "bu kod daha önce şu kaydı yarattı" der.
-- external_id'si OLMAYAN satırlar buraya hiç girmez; onlar için sistem iki satırın aynı iş
-- kaydı olduğunu VARSAYMAZ — benzerlik şüphesi parser'da `duplicate_check` olarak işaretlenir
-- ve karar kullanıcıya kalır (§28).

create table if not exists public.import_external_keys (
  id uuid primary key default gen_random_uuid(),

  -- Hangi domain tablosunda. Serbest metin değil: yalnız V2 sözleşmesinin hedeflediği 16 tablo.
  -- Yazım hatası bir kaydı sessizce görünmez kılacağı için CHECK ile kapatıldı.
  entity_table text not null check (entity_table in (
    'payments', 'checks', 'loans', 'loan_installments',
    'cashflow_lines', 'bank_accounts', 'bank_transactions',
    'invoices', 'orders', 'products', 'projects',
    'budget_lines', 'fx_positions',
    'production_parts', 'cost_models', 'machine_assets'
  )),

  -- Kullanıcının kendi kodu, dosyada yazdığı gibi. Boş dize kod sayılmaz — boş bırakmak
  -- "kodum yok" demektir ve o satır bu deftere hiç yazılmaz.
  external_id text not null check (btrim(external_id) <> ''),

  -- Bu kodun yarattığı domain kaydı. Kasıtlı olarak FK DEĞİL: hedef 16 farklı tablo olabilir,
  -- tek bir FK ile ifade edilemez. Bütünlük, entity_table CHECK'i + aşağıdaki eşsizlikler +
  -- uygulama katmanındaki eşleyici ile korunur.
  entity_id uuid not null,

  -- İzlenebilirlik: kodu ilk hangi dosya getirdi, en son hangisi güncelledi.
  first_seen_workbook_id uuid references public.source_workbooks(id) on delete set null,
  last_seen_workbook_id  uuid references public.source_workbooks(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- İdempotency'nin dayandığı kısıt. Aynı tabloda aynı kod ikinci bir kayıt yaratamaz.
  constraint import_external_keys_unique unique (entity_table, external_id)
);

-- Ters yön de eşsiz: bir domain kaydı iki farklı kod tarafından sahiplenilemez. Bu olmadan
-- "ODM-A" ve "ODM-B" aynı ödemeye bağlanabilir ve ikinci import hangisinin güncelleneceğini
-- bilemezdi.
create unique index if not exists import_external_keys_entity_idx
  on public.import_external_keys (entity_table, entity_id);

drop trigger if exists import_external_keys_updated_at on public.import_external_keys;
create trigger import_external_keys_updated_at before update on public.import_external_keys
  for each row execute function public.set_updated_at();

-- ── RLS: import hattının geri kalanıyla aynı sınıf ──────────────────────────────────────
--
-- `source_workbooks`, `source_sheets`, `import_rows` ve `mapping_reviews` matriste
-- `operational`. Bu defter onlarla aynı işin parçası ve aynı sınıfı alır: viewer HİÇBİR
-- yere yazmaz (Faz 24B değişmezi), operatör import edebilir, onaylayan yalnız okur,
-- yönetici ve admin tam yetkilidir.
alter table public.import_external_keys enable row level security;

drop policy if exists import_external_keys_select_all_tiers on public.import_external_keys;
create policy import_external_keys_select_all_tiers on public.import_external_keys
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists import_external_keys_insert_enter on public.import_external_keys;
create policy import_external_keys_insert_enter on public.import_external_keys
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (true);

drop policy if exists import_external_keys_update_enter on public.import_external_keys;
create policy import_external_keys_update_enter on public.import_external_keys
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);

-- Silme yalnız yönetici ve admin. Bir kaydı defterden düşürmek, sonraki import'ta o kodun
-- YENİ bir kayıt yaratması demektir — yani mükerrer üretir. Operatör bunu yanlışlıkla
-- yapabilmemeli.
drop policy if exists import_external_keys_delete_manager on public.import_external_keys;
create policy import_external_keys_delete_manager on public.import_external_keys
  for delete to mas_radar_finance_manager, mas_radar_admin
  using (true);

grant select on public.import_external_keys to mas_radar_viewer, mas_radar_finance_approver;
grant select, insert, update on public.import_external_keys to mas_radar_finance_operator;
grant select, insert, update, delete on public.import_external_keys
  to mas_radar_finance_manager, mas_radar_admin;
