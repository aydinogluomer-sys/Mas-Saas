-- Standart Import V2 — hazırlık (staging) katmanının iki CHECK'ini genişletir.
--
-- 0041'in koyduğu kural burada da geçerli: `source_sheets.detected_type` CHECK'i ile
-- `src/lib/importers/workbook-parser.ts` içindeki `SheetDetectedType` union'ı BİRLİKTE hareket
-- eder. İkisi ayrı düşerse ilk import INSERT'te patlar. Bu migration o değişikliğin veritabanı
-- yarısıdır; TypeScript yarısı aynı commit'te.

-- ── 1. Sayfa türü: V2 sayfaları 'unknown' değildir ──────────────────────────────────────
--
-- V2'de sayfa türü TESPİT EDİLMEZ, BEYAN EDİLİR: dosya gizli `_MAS_META` sayfasında hangi şema
-- olduğunu söyler ve sayfa adı sözleşmede sabittir. Böyle bir sayfaya 'unknown' yazmak yanlış
-- olurdu — "tespit edici anlayamadı" demek, oysa hiç tahmin etmek gerekmedi.
--
-- ONALTI AİLE ADI EKLENMEDİ, TEK DEĞER EKLENDİ. `detected_type`'ın kelime dağarcığı legacy
-- tespit edicinin tahminleri için yazılmış; oraya V2'nin on altı ailesini doldurmak legacy
-- union'ı da şişirirdi. Ailenin kendisi kaybolmuyor: sayfa düzeyinde `sheet_name_normalized`
-- (CHECK'siz) ve satır düzeyinde `import_rows.detected_entity_type` (CHECK'siz) taşıyor.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.source_sheets'::regclass and conname = 'source_sheets_detected_type_check'
  ) then
    alter table public.source_sheets drop constraint source_sheets_detected_type_check;
  end if;

  alter table public.source_sheets
    add constraint source_sheets_detected_type_check check (detected_type in (
      'loan_calculation', 'capacity', 'machine_roi', 'payment_day_matrix', 'checks',
      'cost_model_normal', 'cost_model_overtime', 'monthly_cashflow',
      'bank_statement',
      -- Faz V2.
      'standard_import_v2',
      'unknown'
    ));
end $$;

-- ── 2. Satır durumu: 'reddedildi' ile 'incelenmeli' aynı şey değildir ───────────────────
--
-- Parser üç sonuç üretir: hazır, incelenmeli, reddedildi. İlk ikisinin karşılığı vardı
-- ('mapped', 'needs_review'); üçüncüsünün yoktu.
--
-- Fark operasyonel ve önemli: INCELENMELİ bir satır insanın bakıp KABUL EDEBİLECEĞİ bir
-- satırdır (mükerrer şüphesi, eksik ölçüm). REDDEDİLMİŞ satır kabul edilemez — dosyanın
-- düzeltilip yeniden yüklenmesi gerekir (olmayan krediye referans, çözülemeyen tarih,
-- sözleşme dışı enum). İkisini 'needs_review' altında birleştirmek, inceleme kuyruğuna asla
-- kabul edilemeyecek satırlar doldurup kuyruğu işe yaramaz hâle getirirdi.
--
-- 'ignored' de doğru değil: o "insan bilerek atladı" demek, oysa burada kimse karar vermedi —
-- satır sözleşmeye uymadığı için hiç yazılmadı.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.import_rows'::regclass and conname = 'import_rows_mapping_status_check'
  ) then
    alter table public.import_rows drop constraint import_rows_mapping_status_check;
  end if;

  alter table public.import_rows
    add constraint import_rows_mapping_status_check check (mapping_status in (
      'unmapped', 'mapped', 'ignored', 'needs_review',
      -- Faz V2. Sözleşmeye uymadığı için hiç yazılmamış satır.
      'rejected'
    ));
end $$;

-- ── 3. İnceleme kuyruğunun okunabilir kalması için indeks ───────────────────────────────
--
-- Kuyruk her zaman "şu dosyanın açık kayıtları" diye okunur; 0001'deki indeks yalnız `status`
-- üzerindeydi ve tek bir dosyanın kayıtlarını bulmak tüm tabloyu tarıyordu.
create index if not exists mapping_reviews_workbook_open_idx
  on public.mapping_reviews (workbook_id, status, severity);
