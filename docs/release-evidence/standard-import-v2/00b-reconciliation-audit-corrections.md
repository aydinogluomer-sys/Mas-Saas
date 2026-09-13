# 00b — Önceki mutabakat raporunun düzeltmeleri

Bir önceki turda ürettiğim `IMPORT → DOMAIN → UI RECONCILIATION AUDIT` raporu bazı yerlerde
**olduğundan kesin** konuşuyordu. Bu dosya o iddiaları düzeltir. Ölçümler değişmedi; değişen,
ölçümden çıkardığım sonucun gücü.

## 1. `IMPORT_TO_UI_RECONCILIATION` tek bir puana indirgenemez

Eski rapor tek bir `PARTIAL` veriyordu. Bu, birbirinden bağımsız üç şeyi tek kutuya koyuyordu.
Doğrusu üç ayrı eksen:

```
STRUCTURAL_IMPORT       = EXACT
    Kaynak hücre → import satırı → domain satırı taşıması hatasız.
    0 mapping hatası, 0 hesaplama hatası, 0 kayıp kaynak satırı,
    0 açıklanamayan domain satırı.

BUSINESS_DEDUPLICATION  = UNRESOLVED
    Yapısal taşıma doğru, ama İŞ ANLAMINDA kaç çek olduğu belirlenmedi.

UI_RENDER_ERRORS        = NOT_MEASURED
    Ölçülmedi. "0" değil.
```

## 2. `CHECKS_SIGNED_TOTAL = PROVISIONAL`

Eski rapor domain toplamı **−590.000**'i doğru gibi sunup workbook'un kendi toplamı
**−245.000**'i "kaynak hatası" diye niteledi. Bu, benim veremeyeceğim bir karardı.

Ölçülen gerçekler:

```
kaynak satır 3  31-Jul  AKR      −45.000   (I sütununda blok formülü VAR)
kaynak satır 7  31-Aug  çağdaş  −100.000   (I sütununda blok formülü VAR)
kaynak satır 11 31-Aug  çağdaş  −100.000   (I sütununda blok formülü VAR)
kaynak satır 17 31-Jul  AKR      −45.000   (I sütununda formül YOK)
kaynak satır 18 31-Aug  ÇAĞDAŞ  −100.000   (I sütununda formül YOK)
kaynak satır 19 19-Sep  EGE G.  −100.000   (I sütununda formül YOK)
kaynak satır 20 31-Oct  ÇAĞDAŞ  −100.000   (I sütununda formül YOK)

workbook I1 = SUM(I3:I142) = −245.000   → yalnız 3, 7, 11
domain (7 satırın tümü)    = −590.000
```

İki okuma da tutarlı:

- **17 ve 18 mükerrer ise** (3 ve 7/11'in kopyası), gerçek toplam −245.000'e yakındır ve
  19–20 formül aralığına eklenmeyi bekleyen yeni çeklerdir.
- **17–20 ayrı gerçek çekler ise**, gerçek toplam −590.000'dir ve workbook'un formülü eksiktir.

Hangisinin doğru olduğunu **veri söylemiyor** — seri numarası yok, external_id yok.
`mapping_reviews` bu belirsizliği zaten 4 `duplicate_check` kaydıyla işaretlemiş
(3↔17, 7↔11, 7↔18, 11↔18) ve bunlar "resolved" işaretli olsa da toplamın hangisi olduğu
kayıt altına alınmamış.

**Karar kullanıcınındır.** Bu yüzden:

```
CHECKS_SIGNED_TOTAL = −590.000  (PROVISIONAL)
belirsizlik aralığı = −245.000 … −590.000
karar için gereken  = çek seri numaraları veya external_id
```

V2'nin `02_CEKLER` sayfası `seri_no` ve `external_id` kolonlarıyla bu belirsizliği kaynağında
kapatır; ayrıca §28 gereği otomatik birleştirme/silme yapılmaz.

## 3. `metric_snapshots` — "bayat" demek yetmez

Eski rapor "dashboard canlı okuyor, snapshot bayat ama etkilenmiyor" dedi. Kanıtladığım şey
daha dardı: dashboard sayfasının **import listesinde** canlı engine fonksiyonları var.
`metric_snapshots`'ı **hangi ekranın okuduğunu taramadım**.

Doğru ifade:

```
Snapshot data product is stale (2026-08-27; ölçüm günü 2026-09-04).
Active UI consumer not proven — snapshot'ı okuyan ekran olup olmadığı taranmadı.
```

Ölçülen fark (aynı gün, aynı DB):

```
                        snapshot      canlı
payment_status/unpaid   13.595.000    14.105.000
bilinmeyen adedi               295           306
```

## 4. `308 + 12` ile `314` aynı şey değil — toplanamaz

Eski rapor bu üç sayıyı yan yana koyup okuyucuya toplama izlenimi verdi. Düzeltme:

| sayı | ne ölçüyor | tarih |
|---:|---|---|
| **314** | `metric_snapshots.data_missing_amounts` — ürünün kendi eksik-veri sayacı | 2026-08-27 (bayat) |
| **308** | `payment_instances` içinde `amount IS NULL` olan satır | 2026-09-04 (canlı) |
| **12** | `payments` içinde `default_amount IS NULL` olan satır | 2026-09-04 (canlı) |

Bunlar **farklı popülasyonlar**: 12 ödeme şablonu, 308 örnek üretir/üretmiştir; bir ödemenin
tutarı bilinmiyorsa ondan doğan örneklerin de tutarı bilinmez. Yani 308 ile 12 örtüşen
kümelerdir, `308 + 12 = 320` diye bir büyüklük yoktur. 314 ise bambaşka bir tarihin sayacıdır.

Doğru sunum:

```
MISSING_SOURCE_DATA (canlı)  = 308 ödeme örneği · 12 ödeme şablonu  (örtüşen kümeler)
MISSING_SOURCE_DATA (ürünün kendi sayacı, bayat) = 314
```

## 5. Düzeltilmiş final tablo

```
SOURCE_ROWS_CHECKED           1.796
DOMAIN_ROWS_CHECKED           2.587
ENGINE_VALUES_RECOMPUTED         32
UI_VALUES_OBSERVED                0   ← ölçülmedi

STRUCTURAL_IMPORT             EXACT
  mapping errors                  0
  calculation errors              0
  lost source rows                0
  unexplained domain rows         0
  rounding-only                   2   (kredi çizelgesi 0,18 TL · kasa ≤0,01 TL)

BUSINESS_DEDUPLICATION        UNRESOLVED   (4 açık çek mükerrer şüphesi)
CHECKS_SIGNED_TOTAL           PROVISIONAL  (−245.000 … −590.000)
UI_RENDER_ERRORS              NOT_MEASURED
SNAPSHOT_PRODUCT              STALE, active consumer not proven
EXPECTED_REVIEW_EXCLUSIONS       62   (53'ü açık)
```

Değişmeyen sonuç: **taşıma katmanında hata bulunmadı.** Değişen: hangi iddiaların kanıtlanmış,
hangilerinin kullanıcı kararına bağlı olduğu artık ayrılmış durumda.
