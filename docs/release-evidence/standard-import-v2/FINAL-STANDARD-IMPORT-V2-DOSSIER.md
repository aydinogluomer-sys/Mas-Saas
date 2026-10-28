# Standart Import V2 — durum dosyası (1. artım)

**Bu, 53 bölümlük özelliğin tamamı değil.** Sözleşme, şablon ve dokümantasyon katmanı bitti;
parser, doğrulama, UI ve testler yazılmadı. Aşağıda ne bitti ne bitmedi tek tek yazılı.

Gerçek `mas_radar_dev` üzerine bu turda **hiçbir şey yazılmadı**; import da yapılmadı.

## Biten

| § | iş | durum | kanıt |
|---|---|---|---|
| 0 | ayrı dal + worktree, ana ağaca dokunmama | ✅ | `feature/standard-import-v2`, base `2e07b3c` |
| 1 | domain envanteri, sınıflandırma | ✅ | `00-domain-inventory.md` |
| 2 | legacy importer korundu | ✅ | legacy dosyalarda 0 değişiklik |
| 3 | V2 workbook kimliği (`_MAS_META`, veryHidden) | ✅ | geri okundu: `MAS_NAKIT_RADAR_STANDARD_IMPORT v2` |
| 4 | şablon üreteci (kodla, ExcelJS) | ✅ | `pnpm import:template:v2` |
| 5 | 16 veri sayfası + README + örnekler + meta | ✅ | 19 sayfa |
| 6–21 | her sayfanın kolon sözleşmesi | ✅ | 187 kolon / 53 zorunlu / 34 enum |
| 22 | başlık normalizasyonu (açık alias, bulanık eşleme yok) | ✅ | 187/187 başlık geri dönüşte doğru |
| 23 | NULL/ZERO sözleşmesi (sözleşme + şablon notları) | ✅ | `contract.ts`, `00_README` |
| 33 | sözleşme dokümanı | ✅ | `docs/standard-import-v2.md` |
| 36 | önceki mutabakat raporunun düzeltmeleri | ✅ | `00b-reconciliation-audit-corrections.md` |
| 44 | gerçek DB no-write kapısı | ✅ | aşağıda |
| 45 | typecheck / lint | ✅ | ikisi de PASS |

## Bitmeyen — dürüst liste

| § | iş | neden bu turda değil |
|---|---|---|
| 24–25 | para/sayı ve tarih normalizasyon parser'ları | parser katmanı hiç yazılmadı |
| 26–27 | provenance yazımı, external_id idempotency | migration kararı bekliyor (envanterde öneri var) |
| 28–29 | mükerrer şüphesi kuralları, review entegrasyonu | parser'a bağlı |
| 30–31 | import önizleme akışı, şablon indirme UI | parser'a bağlı |
| 32 | formül politikası uygulaması | sözleşmede yazılı, kodda değil |
| 34 | dashboard input coverage matrisi | ayrı tarama gerektiriyor |
| 35 | sıfır/boş UX semantiği | UI değişikliği |
| 37–43 | fixture, birim testler, legacy regresyon, disposable E2E, engine mutabakatı, UI smoke | parser'a bağlı |
| 46–48 | performans, güvenlik, migration | parser'a bağlı |
| 49 | kalan evidence dosyaları | ilgili iş bitince |
| 51 | kullanım rehberi | şablon README'de özet var, ayrı doküman yazılmadı |

## Ölçülen kanıt

**Şablon** — 19 sayfa, 91.169 bayt, 187 kolon (53 zorunlu, 34 enum açılır listeli).
Donmuş başlık satırı, otomatik filtre, tarih/para/yüzde biçimleri, her başlıkta "boş
bırakırsan ne olur" notu. Örnekler ayrı sayfada — importer onları veri sanmaz.

**Geri okuma** — üretilen dosya ExcelJS ile açıldı, 187 başlığın 187'si
`contract.normalizeHeader` üzerinden doğru kanonik anahtara döndü, 0 uyuşmazlık.

**Determinizm — kısmi, ve bunu saklamıyorum.** İki üretimin XML içeriği **birebir aynı**
(`diff -r` farksız). Ama zip sha'ları farklı: ExcelJS zip girdi başlıklarına üretim anının
zaman damgasını yazıyor. Yani üreteç **içerik-deterministik**, **byte-deterministik değil**.
§4 "deterministic generator" istiyordu; byte seviyesi için sabit zaman damgalı zip repack
gerekir, bu turda yapılmadı.

**Legacy** — legacy importer dosyalarına 0 dokunuş; V2 kodu ayrı dizinde
(`src/lib/importers/v2/`). Legacy regresyon süiti bu turda **çalıştırılmadı** çünkü henüz
davranışı değiştirebilecek bir kod yok; parser geldiğinde §39 zorunlu olacak.

**Gerçek DB (§44)** — yalnız salt-okunur envanter sorguları çalıştırıldı.

## Bir sonraki artım için öneri

Sıra önemli: parser olmadan §28–§43'ün hiçbiri ölçülemez.

```
1. §24–25  değer normalizasyonu (para/tarih/sayı) + BLANK≠ZERO birim testleri
2. §37     kanonik fixture workbook (kodla üretilen, hardcoded test oracle)
3. §26–29  parser + doğrulama + review entegrasyonu + provenance
4. §39     legacy regresyon (TEMİZ.xlsx: 19 ödeme, 7 çek, 35 ay, kredi çıpaları)
5. §40–42  disposable DB E2E + idempotency + engine mutabakatı
6. §30–31  önizleme ve şablon indirme UI
7. §34–35  coverage matrisi ve sıfır/boş UX
```

```
STANDARD_IMPORT_V2        PARTIAL — sözleşme + şablon katmanı hazır
LEGACY_COMPATIBILITY      KORUNDU (0 dosya değişti)
REAL_V2_IMPORT_EXECUTED   NO
READY_FOR_REAL_IMPORT     NO — parser yok
READY_FOR_CODE_REVIEW     YES (bu artım için)
```
