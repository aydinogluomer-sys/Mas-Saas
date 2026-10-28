# 04 — Eşleyici ve uçtan uca import kanıtı (§26, §27, §29, §40–42)

Tarih: 2026-09-04 · Dal: `feature/standard-import-v2` · Hedef: `mas_radar_import_v2_verify` (harcanabilir)

## Ne yapıldı

`src/lib/importers/v2/mapper.ts` — çözümlenmiş workbook'u veritabanına yazan katman. Sıra:

```
source_workbooks → source_sheets → import_rows → mapping_reviews → domain → import_external_keys
```

`import_rows` adımı domain adımından **önce** gelir ve koşulsuzdur: reddedilmiş satır bile ham
hâliyle saklanır. Aksi hâlde kullanıcı *"dosyamda 49 satır vardı, sistemde 6 var, kalanı
nerede?"* sorusunu soramazdı.

## Uçtan uca sonuç — 20/20

`pnpm import:e2e:v2`, fixture workbook'u gerçek PostgreSQL'e yazar, sonra **aynı dosyayı ikinci
kez** yükler.

| Kontrol | Sonuç |
|---|---|
| Hazırlığa yazılan satır = oracle (49) | ✅ |
| Reddedilen (7) / incelemeye düşen (3) = oracle | ✅ |
| **Hiçbir satır boş ham veriyle yazılmadı** | ✅ |
| Reddedilen satırlar hazırlıkta duruyor | ✅ |
| Reddedilen hiçbir satır domain'e yazılmadı | ✅ |
| payments = 01_ODEMELER hazır satır sayısı (3) | ✅ |
| checks = 02_CEKLER hazır satır sayısı (2) | ✅ |
| loans = 03_KREDILER hazır satır sayısı (1) | ✅ |
| Her domain kaydı kaynak satırına bağlı (§26) | ✅ |
| **İkinci import mükerrer üretmedi** | ✅ |
| İkinci geçişte 0 yaratma, 6 güncelleme | ✅ |
| Defter ikinci import'ta büyümedi (6 → 6) | ✅ |
| Hazırlık katmanı her import'u ayrı saklar (49 → 98) | ✅ |

### Negatif kontrol — idempotency gerçekten defterden geliyor mu?

`lookupExternalKey` geçici olarak `null` döndürecek şekilde kırıldı:

```
1. import → payments=3 checks=2 loans=1
2. import → payments=6 checks=4 loans=2      ← MÜKERRER
Kontrol: 21 · geçti: 16 · düştü: 5
```

Defter geri açıldığında 20/20. Yani vaat ölçülüyor, varsayılmıyor.

## Kapsam — dürüst hâli

**16 ailenin 3'ünün domain yazıcısı var: `payments`, `checks`, `loans`.**

Kalan 13 aile (`bank_accounts`, `bank_transactions`, `budget`, `capacity`, `cashflow`, `cost`,
`fx`, `invoices`, `loan_installments`, `machine_roi`, `orders`, `products`, `projects`) şu an
**yalnız hazırlık katmanına** yazılıyor: satırları `import_rows` içinde ham ve tam duruyor,
domain tablolarına geçmiyor. Fixture'da bu 33 satıra denk geliyor.

Sebep teknik değil, sözleşmesel: `contract.ts` içindeki 187 kolonun yalnız 28'inde
`domainField` (hedef kolon) tanımlı, ve bu 28'in tamamı o üç ailede. Kalan 159 kolonun hedef
kolonu henüz belirlenmedi. Tahmin edilmedi — yanlış kolona yazmak, yazmamaktan kötüdür.

Bu eksiklik **sessiz değil**:

- `MapperResult.stagedOnlyFamilies` her aileyi adıyla döndürür,
- `MapperResult.rowsStagedOnly` kaç satırın beklediğini sayar,
- audit kaydına ikisi de yazılır,
- `mapper.test.ts` bu listenin sözleşmeyle birebir örtüştüğünü doğrular; bir aileye yazıcı
  eklendiğinde liste kendiliğinden küçülür.

## Yazıcıların taşıdığı finansal kurallar

| Kural | Nerede |
|---|---|
| Boş tutar 0'a çevrilmez; `amount_confidence='unknown'` yazılır | `writePayment` |
| Çekin işareti korunur, `amount = abs(signed_amount)` | `writeCheck` |
| Yön işaretten türetilir; **sıfır** ne giriş ne çıkıştır → `unknown` | `writeCheck` |
| `loans.principal` NOT NULL ve boşsa **hata fırlatılır** — 0 yazmak "bedelsiz kredi" demekti | `writeLoan` |
| Benzer isimli taraflar **birleştirilmez**; yalnız birebir aynı normalize ad eşleşir | `resolveParty` |

`resolveParty` Türkçe'ye duyarlı küçültme kullanır (`toLocaleLowerCase("tr-TR")`); düz
`toLowerCase()` noktalı İ'yi bozup aynı bankayı iki ayrı taraf olarak kaydederdi.

## Önizleme (§30)

`dryRun: true` her şeyi hesaplar, hiçbir şey yazmaz. Ayrı bir "tahmin" fonksiyonu **yazılmadı**:
önizleme ile gerçeğin zamanla ayrışmaması için ikisi aynı koddur.

Birim testi bunu yazma sayısıyla değil, **yazma denemesinde patlayan** sahte istemciyle ölçer —
"0 yazma" ölçümü, yazma kodunun çalışıp sessizce başarısız olduğu durumu da yeşil gösterirdi.

## Durum

- Birim testleri: 119 geçer (4 dosya)
- `tsc --noEmit` temiz, `eslint` temiz
- `REAL_V2_IMPORT_EXECUTED = NO` — gerçek `mas_radar_dev` veritabanına hiçbir yazma yapılmadı;
  tüm import'lar `mas_radar_import_v2_verify` üzerinde koştu.
