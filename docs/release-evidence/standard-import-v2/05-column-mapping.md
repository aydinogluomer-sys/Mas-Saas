# 05 — Kolon eşlemesi: 187 kolonun tamamı karara bağlandı

Tarih: 2026-09-04 · Dal: `feature/standard-import-v2` · Hedef: `mas_radar_import_v2_verify` (harcanabilir)

## Sonuç

| | Önce | Sonra |
|---|---|---|
| Hedef kolonu tanımlı | 28 / 187 | **187 / 187** |
| Domain yazıcısı olan aile | 3 / 16 | **15 / 16** |
| Uçtan uca kontrol | 20 | **69** |
| Migration | 0088–0089 | + **0090** |

Kararlar `src/lib/importers/v2/domain-map.ts` içinde **tek yerde**:

```
domain          116   doğrudan bir domain kolonuna yazılır
parent            7   üst kayda (cash_accounts, budgets, cashflow_months)
ledger           15   external_id → import_external_keys (0088)
not_persisted    49   veritabanında karşılığı YOK — gerekçesi yazılı
```

`assertComplete()` eksik ya da fazla kaydı hata olarak veriyor; bir kolon eklenip kararı
yazılmazsa süit kırmızı olur. Eşleme daha önce `contract.ts` içinde dağınıktı ve asıl
gizlediği şey hangi kolonun **hiçbir yere gitmediğiydi**.

## Eşlemeyi yazarken çıkan gerçek hatalar

Bunların hepsi kullanıcı verisini sessizce bozardı. Hiçbiri tip denetiminden ya da satır
sayımından yakalanmazdı.

### 1. Banka hareketlerinde yön ters kaydedilecekti

`bank_transactions.direction` **üretilmiş** bir kolon: değerini `amount`'un işaretinden alıyor
(`amount < 0 → outflow`). Şablon ise işaretsiz tutar + ayrı yön kolonu kullanıyor.

Uzlaştırılmasaydı 35.000 TL'lik bir **kira ödemesi**, artı yazıldığı için veritabanınca
**tahsilat** sayılacaktı. Nakit akışı, banka mutabakatı ve açık hesabı o hareketi ters yönde
toplardı — ve kullanıcı dosyasına doğru yönü yazmış olurdu.

Yazıcı artık yönü işarete çeviriyor; `direction` hiç yazılmıyor. E2E bunu değer düzeyinde
doğruluyor (`çıkış hareketi eksi işaretle yazıldı` / `yönü 'outflow' hesaplandı`).

### 2. Çek ve kredi para birimi saklanamıyordu → migration 0090

`public.checks` ve `public.loans` tablolarında para birimi kolonu **yoktu**. Şablon ise ikisinde
de TRY/USD/EUR/GBP soruyordu. Bir USD çek TRY gibi kaydedilirdi; vade takvimi ve risk
yoğunlaşması onu 1 USD = 1 TRY sayardı.

Şema bugüne kadar örtük olarak "her şey TRY" varsayıyordu. 0090 o varsayımı kolona çevirdi:
`not null default 'TRY'` — mevcut davranış aynen korunuyor, yeni satırlar gerçek para birimini
yazabiliyor.

### 3. Şablonun sunduğu beş değer veritabanınca reddedilirdi

`scripts/import/v2-enum-parity.ts` artık 14 enum kolonunu doğruluyor (önce 6). Bulunanlar:

| Sayfa | Sunulan | Veritabanının kelimesi |
|---|---|---|
| 04 taksit durumu | `overdue` | `late` |
| 08 fatura durumu | `issued` | `open` |
| 13 pozisyon tipi | `asset`, `liability`, `hedge` | `bank_balance`, `loan`, `facility`, `forward` |
| 06 hesap tipi | `vadesiz`, `vadeli`, `pos`, `diger` | `bank_account`, `credit_card`, `check_account`, `cash` |
| 12 bütçe yönü | `inflow` / `outflow` | `income` / `expense` |

Ayrıca sözlük biçiminde olmadığı için araç tarafından görülemeyen üç kısıt elle yansıtıldı:

- `fx_positions.currency <> 'TRY'` → 13. sayfa artık TRY sunmuyor (döviz pozisyonu tanım
  gereği yabancı para).
- `invoices` iptal/kapatma zaman damgası **ve gerekçe** istiyor → `cancelled` ve `closed`
  şablondan çıkarıldı. Bir faturayı iptal etmek gerekçesi kaydedilen bir karardır; toplu
  import'ta sessizce yapılmaz.
- `loan_installments` iptali de gerekçe istiyor → `cancelled` çıkarıldı.

### 4. Parser'ın şiddet kuralı tutarsızdı

Geçersiz bir enum, kolon **zorunluysa** satırı reddediyor, **isteğe bağlıysa** incelemeye
düşürüyordu. İkincisi iki sebeple yanlıştı: (a) sistem o değeri saklayamaz, yani kabul
edildiğinde veritabanı kısıtına çarpacak bir satır kuyruğa girer; (b) tek alternatif hücreyi
NULL yazmaktı — kullanıcının yazdığını sessizce silmek.

Artık **çözülemeyen her değer yüksek şiddetli**: satır reddedilir, kullanıcı tek hücreyi
düzeltip yeniden yükler. Belirsiz (`ambiguous`) değer farklıdır; onun çözüm kuralı var.

### 5. Veritabanı kısıtları satır düzeyine taşındı

Dört kural parser'a eklendi. Hepsi INSERT anında zaten patlardı; fark şu: orada patlarsa
**tüm import düşer** ve kullanıcı hangi satırın suçlu olduğunu göremez.

- **Fatura üçlüsü.** `gross = net + tax` ve üçü de NOT NULL. Eksik olan biri diğer ikisinden
  çıkarılır (aritmetik, tahmin değil); ikiden azı varsa satır reddedilir.
- **Bütçe tutarı ≥ 0.** Gider satırı da artı yazılır; yönü `income/expense` söyler.
- **Ödenmiş taksit ödeme tarihi ister.** Tarihi bugüne çekmek, ödemenin ne zaman yapıldığını
  kaybetmek olurdu.
- **Döviz kuru > 0.** Sıfır ya da eksi kur ölçüm değil, hatadır.

### 6. İkinci import bazı ailelerde patlıyordu

04_KREDI_TAKSITLERI sayfasında `external_id` kolonu **yok**, yani defter o satırı tanıyamıyor
ve ikinci import `(loan_id, installment_no)` eşsizlik kısıtına çarpıyordu.

Çözüm kod eklemek değil, **kimliğin zaten tanımlı olduğunu görmek** oldu: "şu kredinin şu
numaralı taksidi". `findByNaturalKey` yalnız veritabanının kendi eşsizlik kısıtlarıyla birebir
örtüşen alanlarla sorgular — tahmin etmez. Aynı yol ürün/proje/sipariş kodu ve banka
hareketinin parmak izi için de kullanılıyor.

### 7. Rapor "yaratıldı" derken güncelliyordu

Sayaç, defterde kod olup olmamasından **tahmin ediyordu**. Doğal anahtardan bulunup güncellenen
satırlar rapora "yaratıldı" diye yazılıyordu: sayı doğru, açıklama yanlış — kullanıcıya
"2 yeni taksit eklendi" denecekti. Yazıcılar artık ne yaptıklarını (`created`) kendileri
söylüyor.

Önizlemede aynı dürüstlük ayrı çözüldü: kullanıcı kodu olmayan satır için "yeni mi güncelleme
mi" **bilinemez** ve tahmin edilmiyor — `rowsUndetermined` olarak ayrı sayılıyor.

## Uçtan uca — 69/69

`pnpm import:e2e:v2`, fixture'ı yazar, sonra **aynı dosyayı ikinci kez** yükler.

- 15 ailenin her birinde yazılan kayıt sayısı = o sayfanın "hazır" satır sayısı
- ikinci geçiş: **0 yaratma, 36 güncelleme**, defter 34 → 34
- reddedilen 10 satırın hiçbiri domain'e yazılmadı, hepsi hazırlıkta ham hâliyle duruyor
- değer düzeyinde: işaret, boş≠sıfır, üçlü tutar, para birimi, bütçe başlığı

Sayfalar artık **bağımlılık sırasında** yazılıyor (`SHEET_WRITE_ORDER`), numara sırasında
değil: 08_FATURALAR projeye atıf yapıyor ama projeler 11. sayfada. Sıraya yazılmamış bir sayfa
sessizce atlanmaz — sona alınır ve `unorderedSheets` ile raporlanır.

## Kalan tek boşluk: 15_MALIYET

Bu ailenin yazıcısı **bilerek yok** ve bu bir gecikme değil, bir karar.

Şablon **uzun** biçimde: her satır bir maliyet kalemi ("yemek", "servis", "sigorta").
`cost_models` ise **geniş** biçimde: ayda tek satır, her kalem ayrı kolon
(`food_daily_cost`, `transport_staff_daily_cost`, `health_insurance_cost`…).

Uzunu genişe çevirmek, serbest metin olan `maliyet_kategorisi`'ni kolon adına eşlemeyi
gerektirir. "Yemek", "yemek gideri", "YEMEK" hepsi gelir; yanlış tahmin maliyeti yanlış kolona
yazar ve **başabaş fiyatını sessizce bozar**. Doğru çözüm sabit kategori sözlüğü olan bir sayfa
ya da uzun biçimi kabul eden bir maliyet tablosu — ikisi de tasarım işi.

Bir test bu kararın sessiz bir boşluğa dönüşmemesini sağlıyor: yazıcısı olmayan tek ailenin
`cost` olduğunu ve tüm kolonlarının gerekçeli olduğunu doğruluyor.

## Karşılığı olmayan 49 kolon

Sayfa bazında: 16_MAKINE_ROI 9, 15_MALIYET 9, 14_KAPASITE 7, 11_PROJELER 6, 09_SIPARISLER 5,
10_URUNLER 4, 05_NAKIT_AKISI 3, 01_ODEMELER 2, 13_FX_POZISYONU 2, 04 ve 12 birer.

Bunlar **kaybolmuyor**: `import_rows.row_json` içinde ham hâliyle duruyor. Her birinin gerekçesi
`domain-map.ts` içinde yazılı ve bir test gerekçesiz karar bırakılmasını engelliyor. Başlıca
sebepler:

- **Şema başka türlü modelliyor.** Verim/çalışma günü/vardiya parçanın değil atölyenin özelliği
  (`capacity_models`); devir satır tipi değil ay kolonu; sipariş tutarı faturadan gelir.
- **Tasarlanmamış model.** Ürün fiyatı zamanla değişir ve tarihli bir fiyat tablosu yok; makine
  ROI'si yıllık anlık görüntü tutuyor, şablon aylık soruyor — aylığı 12 ile çarpmak ölçülmemiş
  bir sayı uydurmak olurdu.
- **Hesaplanan değer.** Dövizin TRY karşılığı saklanmaz; saklansaydı kur değiştiğinde ikisi
  çelişir ve hangisinin doğru olduğu bilinemezdi.

## Durum

- Birim testleri: **128** (5 dosya) · tam seri süit: **72 dosya / 1560 test**, hepsi geçer
- `tsc --noEmit` temiz, `eslint` temiz
- Enum paritesi: 14 kolon doğrulandı, **0 uyuşmazlık**
- `REAL_V2_IMPORT_EXECUTED = NO` — gerçek `mas_radar_dev` veritabanına hiçbir yazma yapılmadı
