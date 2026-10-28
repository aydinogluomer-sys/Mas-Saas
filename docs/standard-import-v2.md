# Standart Import V2 — veri sözleşmesi

Tek kaynak: `src/lib/importers/v2/contract.ts`. Şablon üreteci de parser da oradan okur;
bu doküman o sözleşmenin insan tarafından okunabilir hâlidir.

```
schema_name      MAS_NAKIT_RADAR_STANDARD_IMPORT
schema_version   2
template_version 2.0.0
template_id      mas-standard-import-v2
```

Legacy `TEMİZ.xlsx` importer'ı `legacy/v1` olarak **değişmeden** çalışmaya devam eder.
V2 tespiti yalnız sayfa adına bakarak yapılmaz — gizli `_MAS_META` sayfasındaki metadata
doğrulanır.

## Neden yeni format

Legacy formatta anlam hücre koordinatında saklıydı:

| kavram | legacy konum | V2 |
|---|---|---|
| kredi anaparası | `faiz hesaplama!B4` | `03_KREDILER.anapara` |
| aylık kasa | her ay sayfasında `J1` | `05_NAKIT_AKISI` satırlarından **hesaplanır** |
| ödeme tutarı | `ödeme tablosu!AG` sütunu | `01_ODEMELER.tutar` |
| vade günü | B..AF arası bir hücrede `"X"` işareti | `01_ODEMELER.vade_gunu` (1–31 sayı) |

Bir sütun kayarsa legacy format sessizce yanlış veri üretir. V2'de kolon adı taşındığı için
kayma tespit edilir ve `unknown_header` incelemesi açılır.

## Sayfa → domain eşlemesi

| sayfa | domain tablosu | zorunlu kolonlar | referans |
|---|---|---|---|
| `01_ODEMELER` | `payments` | aciklama, tekrar_tipi | — |
| `02_CEKLER` | `checks` | vade_tarihi, signed_tutar, para_birimi | — |
| `03_KREDILER` | `loans` | kredi_adi, anapara, para_birimi, vade_ay | — |
| `04_KREDI_TAKSITLERI` | `loan_installments` | loan_external_id, taksit_no, vade_tarihi, toplam_tutar | → `03` |
| `05_NAKIT_AKISI` | `cashflow_lines` → `cashflow_months` | donem, satir_tipi, yon, para_birimi | — |
| `06_BANKA_HESAPLARI` | `bank_accounts` | banka, para_birimi | — |
| `07_BANKA_HAREKETLERI` | `bank_transactions` | account_external_id, islem_tarihi, yon, tutar, para_birimi | → `06` |
| `08_FATURALAR` | `invoices` | fatura_tipi, duzenleme_tarihi, karsi_taraf, toplam_tutar, para_birimi | → `11` (ops.) |
| `09_SIPARISLER` | `orders` | siparis_tipi, siparis_tarihi, karsi_taraf, toplam_tutar, para_birimi | → `11` (ops.) |
| `10_URUNLER` | `products` | urun_adi | — |
| `11_PROJELER` | `projects` | proje_adi | — |
| `12_BUTCE` | `budget_lines` | donem, kategori, yon, tutar, para_birimi, senaryo | — |
| `13_FX_POZISYONU` | `fx_positions` | tarih, para_birimi, pozisyon_tipi, doviz_tutari | — |
| `14_KAPASITE` | `production_parts` | parca_kodu | — |
| `15_MALIYET` | `cost_models` | senaryo, maliyet_kategorisi, aylik_tutar, para_birimi | — |
| `16_MAKINE_ROI` | `machine_assets` + `machine_roi_snapshots` | makine_adi | — |

Toplam **187 kolon**, bunların **53'ü zorunlu**, **34'ü enum** (Excel açılır listesiyle).
Şablon 2.0.0 hepsini sunar. Phase 5'in `REMOVED_FROM_FUTURE_TEMPLATE` kararı uygulanmadı: onaylı
sayım 9 kolon derken matris 10 kolonu işaretliyor ve hangisinin dışarıda kaldığı belgenin
tarihçesinden belirlenemiyor (`docs/release-evidence/v3/phase5-product-decisions.md`, Wave 0 notu).

`16_MAKINE_ROI` yalnız `machine_assets` tablosuna yazar; ROI rakamları `machine_roi_snapshots`
YILLIK tuttuğu, şablon ise AYLIK sorduğu için eşlenmez (gerekçe: `domain-map.ts`).
`15_MALIYET` bilerek eşlenmez — şablon uzun, `cost_models` geniş biçimde.

## V2.0 para birimi sınırı — çek ve kredi yalnız TRY

**Bu geçici bir sürüm sınırıdır ve depolama sınırı DEĞİLDİR.**

`checks.currency` ve `loans.currency` kolonları var (migration 0090) ve satırın para birimini
saklayabiliyor. Sorun **toplamada**: bu iki tablo üzerinde çalışan finans okuma modelleri —
vade akışı, `due30`, kalan tutar, aylık finans toplamları ve anlık görüntü tüketicileri —
para birimine göre ayırmadan ve belirlenmiş bir kur dönüşümü yapmadan `sum(amount)` kullanıyor.

Ölçüldü (`pnpm import:currency-safety:v2`): 10.000 TRY'lik ve 1.000 USD'lik iki çek doğrudan
veritabanına yazıldığında `due30` **11.000** döndü. Böyle bir sayı finansal olarak geçersizdir
ve yanlış olduğu ekranda görünmez.

Bu yüzden V2.0 sözleşmesi:

```
Checks and loans are imported into the finance domain only when currency = TRY.
Non-TRY rows are preserved in staging and require review.
Multi-currency finance aggregation/conversion is NOT implemented in V2.0.
```

Uygulanışı:

| | davranış |
|---|---|
| TRY satır | `checks` / `loans` tablolarına yazılır |
| TRY dışı satır | **domain'e yazılmaz** |
| TRY dışı satır | ham hâliyle `import_rows` içinde **korunur** (sessiz düşürme yok) |
| TRY dışı satır | `unsupported_currency_for_finance_aggregation` türünde **yüksek şiddetli** inceleme açılır |
| şablon | bu iki sayfada açılır listede yalnız `TRY` sunar |
| parser | USD/EUR/GBP değerlerini yine de OKUR — dışarıdan gelen dosya sessizce "okunamadı" sayılmasın diye |

Kullanıcıya gösterilen gerekçe: *"Bu sürüm çek ve kredi toplamlarını yalnız TRY için güvenli
biçimde hesaplar. TRY dışı kayıt kaynakta korunmuştur ancak finans KPI'larına
aktarılmamıştır."*

Sınır **yalnız** `02_CEKLER` ve `03_KREDILER` için geçerlidir. Diğer sayfaların para birimi
sözlükleri değişmedi.

### Açık teknik borç

```
MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED
```

Kalıcı çözüm kur tarihçesi + belirlenmiş bir dönüşüm politikası + okuma modellerinin para
birimi boyutuyla yeniden yazılması. Bu, import katmanının işi değil.

## NULL / ZERO sözleşmesi

Bu bir sürüm kuralıdır, tercih değil.

```
boş hücre       → NULL   "bilinmiyor" · toplamlara KATILMAZ · eksik veri sayacına girer
0 yazılmış      → 0      "gerçekten sıfır" · hesaplamaya sıfır olarak girer
"-"             → NULL
formül hatası   → NULL   "hesaplanamadı" · formula_error incelemesi (yüksek) · satır REDDEDİLİR
(#REF!, #DIV/0!,          0 DEĞİL, boş DEĞİL — her kolon tipinde (sayı, tarih, metin, enum…)
 #N/A, #VALUE!…)          ham hücre ({"error":"#REF!"}) import_rows.row_json'da olduğu gibi kalır
```

Hiçbir parser `Number(v) || 0` yazamaz — bu ifade boş hücreyi sıfıra çevirir. Her parser
testinde `BLANK ≠ ZERO` kanıtı bulunur.

Formül hatası satırı neden **reddedilir** (incelemeye düşmez): düzeltilecek şey yazılan bir değer
değil, kaynak dosyadaki kırık formüldür; sistem o değeri saklayamaz ve tahmin etmez. İncelenmemiş
katman (46541d8) bu hücreleri sayı kolonlarında `0`, metin ve enum kolonlarında sessiz boş
yapıyordu — 0 aile kurallarına (vade günü, fatura aritmetiği, mükerrer gruplaması) sahte bir sayı
olarak giriyor, boş ise isteğe bağlı `durum`'u yazıcının varsayılanına düşürüyordu. Wave 0 / S5
bunu kaldırdı (`values.ts` `formulaErrorToken`). OOXML hata hücresini arayüz dilinden bağımsız
İngilizce belirteçle saklar; Türkçe karşılıklar (`#BAŞV!`, `#SAYI/0!`, `#DEĞER!`, `#YOK`, `#AD?`,
`#SAYI!`, `#BOŞ!`) yalnız metin hücrede tanınır.

Somut örnek: `14_KAPASITE.torna_dk` boşsa "süre ölçülmemiş" demektir ve kapasite hesabı bu
parçayı eksik sayar; `0` yazılırsa "bu parçada torna işlemi yok" demektir ve hesap 0 dakika
kullanır. İkisi farklı başabaş noktası üretir.

## İşaret sözleşmesi

`02_CEKLER.signed_tutar` işareti anlamlıdır ve **korunur**:

```
eksi (−) → outflow  (sizin ödeyeceğiniz çek)
artı (+) → inflow   (tahsil edeceğiniz çek)
```

`amount` alanı mutlak değer olabilir, ama `signed_amount` kaynaktaki işareti taşır.
Mutlak değere çevirme veya "pozitif-only" semantiği uygulanmaz.

## Başlık normalizasyonu

Yalnız **açıkça tanımlanmış** alias'lar kabul edilir (`normalizeHeader`). Bulanık eşleme,
mesafe hesabı veya model tahmini kullanılmaz: yanlış eşlenmiş bir tutar sütunu, hiç
eşlenmemiş bir sütundan tehlikelidir. Tanınmayan başlık → `unknown_header` incelemesi.

Tanınmayan sütun **domain'e aktarılmaz ama ham hâli kaybolmaz**: hücre değeri
`raw.__unknown__["<başlık metni>"]` altında saklanır ve `import_rows.row_json`'a olduğu gibi
yazılır (`UNKNOWN_COLUMNS_KEY`). `values`'a asla geçmez — hangi alan olduğu tahmin edilmez.
Boş hücre için anahtar açılmaz. Sözleşme dışı bir hücreden ibaret satır veri satırı sayılmaz
ve okunmaz (boş satır kuralı yalnız sözleşme kolonlarına bakar).

## Idempotency ve mükerrer politikası

```
external_id VAR  → aynı kodla tekrar import kaydı GÜNCELLER, kopya üretmez
external_id YOK  → sistem "bu aynı iş kaydı" İDDİASINDA BULUNMAZ
```

Mükerrer **tespiti** ile mükerrer **silmesi** ayrı şeylerdir. Şüpheli benzerlikler
`duplicate_check` incelemesi açar; otomatik birleştirme veya silme **yoktur**. TEMİZ.xlsx
denetiminde bulunan AKR −45.000 ×2 ve Çağdaş −100.000 ×3 gibi durumlar kullanıcı kararı
verilene kadar `BUSINESS_DEDUPLICATION_UNRESOLVED` olarak kalır.

## Formül politikası

V2 ham veri formatıdır. Kullanıcı formül yazmışsa formülün **son hesaplanmış değeri** okunur;
Excel çalıştırılmaz, formül finansal doğruluk kaynağı sayılmaz. Türev finansal değerler
(kasa, başabaş, ROI) uygulamanın deterministik motoru tarafından hesaplanır.

```
sonucu olan formül            → sonuç okunur (formül metni asla değer değildir)
sonucu OLMAYAN formül         → NULL "bilinmiyor" (paylaşılan formül kopyası dahil)
sonucu HATA olan formül       → NULL + formula_error (yüksek), satır reddedilir — 0 değil
```

## Birleştirilmiş hücre politikası

Şablon düz sayfa üretir; sözleşmede "aşağı doğru doldur" diye bir kural yoktur. Excel bir
birleştirmede yalnız aralığın sol üst (ana) hücresinin değerini saklar, ama ExcelJS aralığın
diğer hücrelerinde de ana hücrenin değerini döndürür. `af210fd` de incelenmemiş katman da bu
değeri okuyordu: iki seri numaralı satıra birleştirilmiş tek bir −45.000 çek tutarı **iki kez**
yazılıyordu. Wave 0 / S5 kuralı:

```
ana hücre               → değeri okunur
aralığın diğer hücresi  → NULL; raw[__merged__][kolon] = ana hücre adresi (provenance)
aralığa değen her       → merged_cell incelemesi (ORTA) → satır domain'e insan kararı
sözleşme hücresi           olmadan girmez
zorunlu kolonun diğer   → boş hücreyle aynı yol: missing_required_field, satır reddedilir
hücresi
birleştirilmiş başlık   → ikinci sütun aynı alana eşlenmez; sayfa düzeyinde merged_cell,
                          hücreleri raw.__unknown__ altında korunur
```

Hiçbir kolon istisna değildir. `__merged__` anahtarı `__unknown__` gibi sözleşme anahtarlarıyla
çakışamaz (`parser.ts` `MERGED_CELLS_KEY`). Önizleme ekranı formül hatalarını ve birleştirilmiş
hücreleri onaydan ÖNCE kendi listelerinde gösterir.

## Asenkron önizleme (Wave 0 / S5)

`POST /api/imports/v2/async` dosyayı sahneler ve `excel_import` türünde bir **önizleme** işi
kuyruğa alır; `scripts/ops/process-import-jobs.ts` işçisi dry-run önizlemeyi koşturur ve raporu
(listeler en çok 50 satır, gerçek uzunluklar `listTotals`'ta) iş satırına yazar;
`GET /api/imports/v2/async?jobId=` raporu yalnız işin sahibine (finans yöneticisi/yönetici
herkesinkine) döndürür. **Asenkron yol hiçbir finansal kayıt yazmaz.** İçe aktarmak için dosya
`/data/imports/v2`'de yeniden yüklenir ve senkron onay akışından geçer (önizleme SHA'sı eşleşmek
zorunda). Kimlik iş yükünden değil işi kuyruğa alan oturumdan (`created_by`) gelir ve işlenirken
`public.users`'tan yeniden doğrulanır; önizleme o kişinin veritabanı katmanında koşar. Sahnelenen
dosya (gerçek veri) her terminal sonuçta silinir; sahipsiz kalanlar 24 saat sonra süpürülür.
İşçi henüz zamanlanmış bir görevle çalıştırılmıyor (açık iş).

## Provenance

Her domain satırı için hedef zincir:

```
domain row → import_rows → source_sheets → source_workbooks
                        ↘ external_id
```

Mevcut tabloların bir kısmında `source_workbook_id` / `source_sheet_id` / `source_row_id`
kolonları var; olmayanlar için bağ `import_rows.mapped_entity_table` +
`mapped_entity_id` üzerinden kurulur. Ayrıntı ve boşluk listesi:
`docs/release-evidence/standard-import-v2/00-domain-inventory.md`.

### Ham satır biçimi ve kaynaktan geri okuma

`import_rows.row_json` iki biçimde bulunur ve ikisi de geçerlidir:

```
legacy : {"A":{"v":"MT-100","t":"s"}, ..., "I":{"v":130000,"t":"n"}}   kolon harfi + {v,t}
V2     : {"parca_kodu":"MT-100", "adet":500, "satis_fiyati":260, ...}   sözleşme anahtarı
```

Domain'e alınmayan ama kaynakta korunan bir değeri geri okuyan her tüketici İKİ biçimi de
tanımak zorundadır. Somut örnek: `14_KAPASITE.satis_fiyati` `production_parts`'a yazılmaz;
parça kârlılığı geliri `src/lib/production/source-revenue.ts` ile kaynak satırdan okur.
Biçim tahmin edilmez, anahtarın varlığından bilinir: `satis_fiyati` varsa V2 (birim fiyat ×
adet), yoksa legacy `I.v` (adet için toplam FİYAT). İkisi de yoksa gelir bilinmiyor (null).
SQL'de `::numeric` cast kullanılmaz — V2 ham hücre metin ya da formül nesnesi olabilir.

## Kimlik zinciri ve eşzamanlılık

Aynı `external_id` ile ikinci import mükerrer üretmez. Bu vaat üç kuralla korunuyor:

1. **İşlem kapsamlı anahtar kilidi.** `pg_advisory_xact_lock(hashtext(tablo), hashtext(kod))`
   alınır, defter kilit ALTINDA yeniden okunur. Kilitsiz sırada iki eşzamanlı import da
   "kayıt yok" görüp ikişer kayıt yaratabiliyordu (ölçüldü: 2 kayıt, 1 sahipsiz).
2. **Bağlama değişmezi.** `(entity_table, external_id) → TEK entity_id`. Bir kodun işaret
   ettiği kayıt sessizce değiştirilemez; denenirse `EXTERNAL_KEY_BINDING_CONFLICT`.
3. **Bayat bağlama fail-closed.** Defterin işaret ettiği kayıt yoksa import DURUR
   (`STALE_EXTERNAL_KEY_BINDING`). Otomatik "iyileştirme" (yeni kayıt yaratıp bağlamak)
   bilerek yapılmaz: o, kopuk kimlik zincirini gizler.
4. **Üst kayıt kabulü dosya-yereldir.** Alt kayıt (taksit → kredi, hareket → hesap,
   fatura/sipariş → proje) üst kaydını defterden bulur; defter geçmişi bilir, bu dosyayı
   bilmez. Üst kaydın satırı **bu dosyada** kabul edilmediyse (reddedildi ya da incelemeye
   düştü) alt kayıt `blocked_by_parent` olur ve yazılmaz — defterde aynı kodla eski bir
   kayıt dursa bile ona bağlanmaz. Sebep inceleme kuyruğuna satırına bağlı yazılır;
   `import_rows.mapping_status = 'blocked_by_parent'` (migration 0091). Karar parser'da
   verildiği için önizleme ile gerçek yazma aynı sayıyı verir. Kullanıcının işi bu satırı
   değil üst kaydı düzeltip dosyayı yeniden yüklemektir.

Kanıt: `pnpm import:concurrency:v2` — negatif kontrol dahil 18 ölçüm.

## Bu turda tamamlanmayanlar

- `15_MALIYET` domain eşlemesi — `STAGED_ONLY_BY_DESIGN` (şekil uyuşmazlığı)
- Şablon indirme ucu, önizleme ekranı ve production import akışı
- Çoklu para birimi finans analitiği

Durum raporu: `docs/release-evidence/standard-import-v2/`.
