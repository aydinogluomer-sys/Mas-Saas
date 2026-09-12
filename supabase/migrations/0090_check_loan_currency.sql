-- Çek ve kredi kayıtlarına para birimi.
--
-- ═══ NEDEN ═══
--
-- V2 kolon eşlemesini yazarken çıktı: `public.checks` ve `public.loans` tablolarında para
-- birimi kolonu YOK. Şablon ise ikisinde de "Para Birimi" soruyor ve TRY/USD/EUR/GBP sunuyor.
--
-- Sonucu sessiz ve ağır: bir USD çek TRY gibi kaydedilirdi. Vade takvimi, risk yoğunlaşması
-- ve nakit açığı hesapları o satırı 1 TRY = 1 USD sayarak toplardı. Kullanıcı hiçbir hata
-- görmezdi — dosyasına doğru para birimini yazmış olurdu.
--
-- Şema bugüne kadar örtük olarak "her şey TRY" varsayıyordu. Bu migration o varsayımı
-- kolona dönüştürüyor: varsayılan hâlâ TRY, ama artık YAZILI ve değiştirilebilir.
--
-- ═══ NEDEN `default 'TRY'` VE `not null` ═══
--
-- Mevcut satırların para birimi bilinmiyor değil — sistem onları zaten TRY sayıp hesapladı.
-- NULL bırakmak, geçmişi olduğundan belirsiz göstermek olurdu. `not null default 'TRY'`
-- mevcut davranışı aynen korur ve yeni satırlara gerçek para birimini yazma imkânı verir.

alter table public.checks
  add column if not exists currency text not null default 'TRY';
alter table public.loans
  add column if not exists currency text not null default 'TRY';

-- Sözlük, sözleşmedeki `CURRENCIES` ile birebir. Serbest metin bırakmak "TL", "tl", "₺" gibi
-- üç ayrı para birimi üretirdi.
--
-- ═══ VARLIK KONTROLÜ TABLOYA BAĞLI ═══
--
-- İlk yazımda kontrol yalnız `conname` ile yapılıyordu. PostgreSQL'de kısıt adları veritabanı
-- genelinde EŞSİZ DEĞİLDİR — yalnız tablo içinde eşsizdir. Başka bir tabloda aynı adı taşıyan
-- bir kısıt bulunsaydı `if exists` doğru döner, ardından `alter table public.checks drop
-- constraint` "böyle bir kısıt yok" diyerek migration'ı düşürürdü.
--
-- Bu yüzden kontrol `conrelid` ile GERÇEK TABLOYA bağlandı: aranan şey "şu adda bir kısıt"
-- değil, "ŞU TABLODA şu adda bir kısıt".
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.checks'::regclass and conname = 'checks_currency_check'
  ) then
    alter table public.checks drop constraint checks_currency_check;
  end if;
  alter table public.checks
    add constraint checks_currency_check check (currency in ('TRY', 'USD', 'EUR', 'GBP'));

  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.loans'::regclass and conname = 'loans_currency_check'
  ) then
    alter table public.loans drop constraint loans_currency_check;
  end if;
  alter table public.loans
    add constraint loans_currency_check check (currency in ('TRY', 'USD', 'EUR', 'GBP'));
end $$;

-- Vade/risk ekranları para birimine göre ayrıştığında bu indeks olmadan tam tarama yapılırdı.
create index if not exists checks_currency_maturity_idx
  on public.checks (currency, maturity_date);
