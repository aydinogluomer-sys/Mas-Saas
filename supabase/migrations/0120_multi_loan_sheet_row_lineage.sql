-- Faz 60 / Karar 2 (0120): V2 Çoklu Kredi Sayfası (`03_KREDILER`) Satır Bazlı İzlenebilirlik
--
-- `0008_financing_idempotency.sql` V1 tek-kredi sayfası (`faiz hesaplama`) döneminden kalma
-- `loans_source_sheet_uq (source_sheet_id)` kısıtını taşıyordu ve kendi yorumunda açıkça:
-- "relax deliberately (documented migration) if a multi-loan sheet ever appears" notunu
-- düşmüştü. V2 standart şablonundaki `03_KREDILER` sayfası çoklu kredi ve çoklu döviz (TRY,
-- EUR, USD) satırlarını tek sayfada tutar; `FINANCE_TRY_ONLY` kilidi kaldırıldığında aynı
-- sayfadan birden fazla kredi satırı yazılır.
--
-- Bu migrasyon:
--   1. `public.loans` tablosuna `source_row_id` yabancı anahtarını ekler (§26 satır izlenebilirliği).
--   2. Eski sayfa-başına-tek-kredi indeksini kaldırıp V2 satır bazlı eşsizlik (`loans_source_row_uq`)
--      ile V1 geriye dönük sayfa bazlı eşsizliği (`loans_source_sheet_legacy_uq`, `source_row_id is null`)
--      birlikte korur.

alter table public.loans
  add column if not exists source_row_id uuid references public.import_rows(id) on delete set null;

drop index if exists public.loans_source_sheet_uq;

create unique index if not exists loans_source_row_uq
  on public.loans(source_row_id)
  where source_row_id is not null;

create unique index if not exists loans_source_sheet_legacy_uq
  on public.loans(source_sheet_id)
  where source_sheet_id is not null and source_row_id is null;

