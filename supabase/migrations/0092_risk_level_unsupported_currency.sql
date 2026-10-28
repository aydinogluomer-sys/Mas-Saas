-- PHASE 2.2 (T1-b) — payment_instances.risk_level CHECK'ine altıncı üye: 'unsupported_currency'.
--
-- ═══ UYGULANMADI — DİKKAT ═══
--
-- Bu migration yazıldığı anda HİÇBİR veritabanına uygulanmadı (Docker/DB yoktu). Terfi öncesi
-- tek kullanımlık bir veritabanında `pnpm db:migrate:verify` ile geçmek ZORUNDADIR.
--
-- NUMARALANDIRMA: 0088–0091 yalnız `feature/standard-import-v2` dalında (0088 external_keys,
-- 0089 staging, 0090 check/loan currency, 0091 blocked_by_parent). Bu dosya o dalın ARDINA
-- 0092 olarak numaralandı; `scripts/db/migration-lib.ts`'in `validateFileSet`i boşluk kabul
-- etmediği için import-v2 birleşmeden bu dalda `pnpm db:migrate` "Versiyon sırasında boşluk"
-- diyerek duracaktır. Bu bilinçli bir sıralama kararıdır, hata değil — birleşme sırası
-- değişirse dosya yeniden numaralanır.
--
-- ═══ NEDEN ═══
--
-- `src/lib/radar/rules.ts` `computeRisk()` her açık kalemi `large_payment_threshold_try` ve
-- `critical_payment_threshold_try` ile karşılaştırıyor ve sonucu `refreshRiskFlags()` ile
-- `payment_instances.risk_level` kolonuna YAZIYORDU — kalemin para birimine bakmadan. Kolon
-- `currency text not null default 'TRY'` ve CHECK'siz; yani bir USD kalem TRY eşiğiyle tartılıp
-- "kritik değil" diye kalıcı olarak etiketlenebilirdi (60.000 USD ≈ 2 milyon TRY iken).
--
-- Plan §2.1: `MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED` kabul edilmiş borçtur; kur
-- çevirimi YOK ve burada yazılmıyor. Kural: "Farklı para birimleri doğrudan karşılaştırmaya
-- giremez. Politika yoksa tutarı TRY varsayma; açıkça eksik/inceleme gerekli göster."
--
-- Dolayısıyla TRY-dışı açık bir kalem için dürüst sonuç ne 'none' (risk yok — bilmiyoruz) ne de
-- 'critical' (aşıyor — bilmiyoruz); AYRI bir değer: 'unsupported_currency' = "eşik bu tutara
-- uygulanamadı, inceleme gerekli". Gerekçe dizisi (`risk_reasons text[]`) aynı adı taşır ki UI
-- açıklayabilsin (instance-row.tsx: "TRY-dışı" rozeti).
--
-- ═══ NEDEN 0003 DÜZENLENMİYOR ═══
--
-- Yayımlanmış migration yeniden yazılmaz (ledger ilkesi; 0079 ve 0041 aynı deseni izler).
-- Bu, kümeyi GENİŞLETEN bir değişikliktir: eski beş üye olduğu gibi duruyor, hiçbir mevcut satır
-- geçersiz olmuyor; bu yüzden `not valid` + ayrı `validate` dilimi gerekmez (0041'in gerekçesi).
--
-- ═══ KISIT ADI TABLOYA BAĞLI ARANIR ═══
--
-- 0003'te CHECK satır içinde, adsız yazıldı; PostgreSQL ona `payment_instances_risk_level_check`
-- adını verir. Ad yalnız tablo içinde eşsiz olduğundan arama `conrelid` ile tabloya bağlanır
-- (0041/0090 deseni). Ad bir şekilde farklıysa da yakalansın diye kısıt, tanımında `risk_level`
-- geçen tek-sütunlu CHECK olarak da aranır; bulunan her biri düşürülüp adlı kısıt eklenir.

do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.payment_instances'::regclass
       and contype = 'c'
       and (conname = 'payment_instances_risk_level_check'
            or pg_get_constraintdef(oid) ~ '^CHECK \(\(risk_level = ANY')
  loop
    execute format('alter table public.payment_instances drop constraint %I', c.conname);
  end loop;

  alter table public.payment_instances
    add constraint payment_instances_risk_level_check
    check (risk_level in (
      'none', 'low', 'medium', 'high', 'critical',
      -- PHASE 2.2 (T1-b): eşik TRY-dışı tutara uygulanamadı — inceleme gerekli, "risk yok" değil.
      'unsupported_currency'
    ));
end $$;

-- Sonraki fazlar için not (Faz 31 dersi): bu kümenin BOYUTUNU sabitleyen bir kapı, küme bir
-- sonraki genişletmede kırılır. Önemsediğiniz değerlerin VAR olduğunu doğrulayın, toplamın N
-- olduğunu değil.
