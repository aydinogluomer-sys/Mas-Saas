# 00 — Domain envanteri (gerçek `mas_radar_dev`, salt okunur)

Kod yazmadan önce çıkarıldı. Amaç: aynı kavram için ikinci bir paralel tablo kurmamak.

Ölçüm salt-okunur; gerçek veritabanına yazılmadı.

## Sınıflandırma

| aile | tablo | satır | wb | sheet | row | external_id | currency | sınıf |
|---|---|---:|:--:|:--:|:--:|:--:|:--:|---|
| Ödemeler | `payments` | 19 | Y | Y | Y | — | Y | EXISTING_AND_READY |
| Ödeme örnekleri | `payment_instances` | 502 | Y | Y | Y | — | Y | EXISTING_AND_READY |
| Çekler | `checks` | 7 | Y | Y | Y | — | — | EXISTING_AND_READY |
| Parçalar | `production_parts` | 68 | Y | Y | Y | — | — | EXISTING_AND_READY |
| Banka hareketleri | `bank_transactions` | 0 | Y | Y | Y | — | Y | EXISTING_BUT_UNUSED |
| Faturalar | `invoices` | 0 | Y | Y | Y | — | Y | EXISTING_BUT_UNUSED |
| Makine ROI | `machine_roi_snapshots` | 0 | Y | Y | — | — | — | EXISTING_BUT_UNUSED |
| Krediler | `loans` | 1 | Y | Y | — | — | — | EXISTING_NEEDS_EXTENSION |
| Nakit akışı ayları | `cashflow_months` | 35 | Y | Y | — | — | — | EXISTING_NEEDS_EXTENSION |
| Nakit akışı satırları | `cashflow_lines` | 1968 | — | — | Y | — | — | EXISTING_NEEDS_EXTENSION |
| Kapasite modeli | `capacity_models` | 1 | Y | Y | — | — | — | EXISTING_NEEDS_EXTENSION |
| Maliyet modeli | `cost_models` | 2 | Y | Y | — | — | — | EXISTING_NEEDS_EXTENSION |
| Kredi taksitleri | `loan_installments` | 48 | — | — | — | — | — | EXISTING_NEEDS_EXTENSION |
| Banka hesapları | `bank_accounts` | 0 | — | — | — | — | — | EXISTING_NEEDS_EXTENSION |
| Siparişler | `orders` | 0 | — | — | — | — | — | EXISTING_NEEDS_EXTENSION |
| Ürünler | `products` | 0 | — | — | — | — | — | EXISTING_NEEDS_EXTENSION |
| Projeler | `projects` | 0 | — | — | — | — | — | EXISTING_NEEDS_EXTENSION |
| Bütçe | `budgets` / `budget_lines` | 0 / 0 | — | — | — | — | Y | EXISTING_NEEDS_EXTENSION |
| Tahmin | `forecasts` / `forecast_lines` | 0 / 0 | — | — | — | — | Y | EXISTING_NEEDS_EXTENSION |
| FX | `fx_positions` / `fx_rate_snapshots` | 0 / 0 | — | — | — | — | Y | EXISTING_NEEDS_EXTENSION |
| Makine varlıkları | `machine_assets` | 4 | — | — | — | — | — | EXISTING_NEEDS_EXTENSION |
| Taraflar | `parties` | 16 | — | — | — | — | — | EXISTING_AND_READY |

## Sonuçlar

**MISSING_DOMAIN_MODEL: yok.** V2'nin on altı veri sayfasının hepsinin domain karşılığı zaten
var. Yeni paralel model kurulmayacak; mevcut tablolar kullanılacak.

**En büyük yapısal boşluk: `external_id` hiçbir tabloda yok.** §27'nin idempotency sözleşmesi
bunu gerektiriyor. Seçenekler:

1. Her hedef tabloya `external_id text` eklemek (additive migration, 16 tablo).
2. Mevcut `import_rows` ilişkisini kullanmak — `import_rows.row_json` içinde external_id
   taşınır, `mapped_entity_table` + `mapped_entity_id` domain'e bağlar.

**Öneri: (2) + dar bir (1).** `import_rows` zaten domain'e bağlanıyor ve provenance'ı taşıyor;
external_id'yi orada indekslemek 16 tabloyu değiştirmeden idempotency sağlar. Yalnız
`import_rows` üzerine `(workbook_id, sheet_id, external_id)` için kısmi indeks gerekir. Bu
karar §48 migration politikası altında ayrıca ele alınacak — bu turda migration yazılmadı.

**Provenance boşluğu:** `loan_installments`, `bank_accounts`, `orders`, `products`, `projects`,
`budget_lines`, `forecast_lines`, `fx_positions`, `machine_assets` tablolarında hiçbir source
kolonu yok. Bunlar için domain→kaynak izlenebilirliği yine `import_rows` üzerinden kurulacak.

**`machine_assets` özel not:** kaynak bağı olmadığı için bugünkü 4 satırın (ikisi
`purchase_cost = 0.00`) 0'ı gerçek mi yoksa eksik mi olduğu **belirlenemiyor**. V2'de
`16_MAKINE_ROI` sayfası bu belirsizliği kapatır.
