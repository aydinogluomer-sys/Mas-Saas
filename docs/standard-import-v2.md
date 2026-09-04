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

## NULL / ZERO sözleşmesi

Bu bir sürüm kuralıdır, tercih değil.

```
boş hücre   → NULL   "bilinmiyor" · toplamlara KATILMAZ · eksik veri sayacına girer
0 yazılmış  → 0      "gerçekten sıfır" · hesaplamaya sıfır olarak girer
"-"         → NULL
```

Hiçbir parser `Number(v) || 0` yazamaz — bu ifade boş hücreyi sıfıra çevirir. Her parser
testinde `BLANK ≠ ZERO` kanıtı bulunur.

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

## Bu turda tamamlanmayanlar

Sözleşme, şablon üreteci ve şablon hazır. Parser, doğrulama katmanı, domain eşleyici,
önizleme akışı, UI ve testler **henüz yazılmadı** — durum raporu
`FINAL-STANDARD-IMPORT-V2-DOSSIER.md` içinde.
