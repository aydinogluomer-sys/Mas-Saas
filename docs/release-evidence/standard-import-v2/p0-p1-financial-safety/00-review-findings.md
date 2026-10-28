# 00 — İnceleme bulguları ve kapanış durumu

Tarih: 2026-09-04 · Dal: `feature/standard-import-v2` · Temel: `12d322fe15c25f5aef1e377c03b0f85b1b3e7c71`

Bağımsız inceleme, V2 import motorunda üç doğruluk sorunu ve bir migration hijyeni bulgusu
raporladı. Hepsi bu turda kapatıldı; her biri için **negatif kontrol** üretildi — yani
düzeltmeden önce sorunun gerçekten oluştuğu ölçüldü.

| # | Sınıf | Bulgu | Durum |
|---|---|---|---|
| 1 | **P0** | checks/loans para birimi saklanıyor ama finans okuma modelleri para birimi gözetmeden `sum(amount)` yapıyor | KAPANDI — TRY-only import sözleşmesi |
| 2 | **P1** | `external_id` defteri eşzamanlı import altında mükerrer domain kaydı üretebiliyor | KAPANDI — işlem kapsamlı anahtar kilidi |
| 3 | **P1** | Bayat defter bağlaması sessiz başarı üretebiliyor | KAPANDI — fail-closed, tipli hata |
| 4 | Hijyen | 0090'daki kısıt varlık kontrolleri yalnız `conname` ile | KAPANDI — `conrelid` ile kimliğe bağlandı |

Ek olarak, bu bulguları kapatırken **üç yeni kusur** ortaya çıktı ve düzeltildi:

| # | Nasıl bulundu | Kusur |
|---|---|---|
| 5 | Para birimi testinin beklediği inceleme sayısı tutmadı | Her satır sorunu inceleme kuyruğuna **iki kez** yazılıyordu — biri satırsız |
| 6 | Sıfırdan kurulan DB'de E2E ikinci import'ta düştü | Yeni bayat-bağlama kontrolü `bank_accounts` için kırıktı (o tablonun `id` kolonu yok) |
| 7 | Önizleme/yazma sayım karşılaştırması | Önizleme inceleme sayısını gerçek yazmadan farklı hesaplıyordu |

---

## 1 · P0 — para birimi bulaşması

### Sorun

`checks` ve `loans` tabloları üzerinde çalışan finans okuma modelleri — vade akışı, `due30`,
kalan tutar, aylık finans toplamları ve anlık görüntü tüketicileri — `sum(amount)` kullanıyor
ve **para birimi boyutu taşımıyor**. `src/lib/financing/engine.ts` içindeki `loadFinanceDashboard`
sorgusu bunun kaynağı.

Migration 0090 ile para birimi kolonu eklenmişti. **Bu, problemi çözmez**: depolama desteği ile
toplama desteği ayrı şeylerdir. Kolon var diye USD bir çek TRY toplamına girmekten kurtulmaz.

### Ölçüm (negatif kontrol)

Importer atlanarak doğrudan veritabanına iki çek yazıldı:

```
10.000 TRY  outflow  vade 2026-09-20
 1.000 USD  outflow  vade 2026-09-20
```

`loadFinanceDashboard` sonucu:

```
due30 = 11000
```

İki farklı para birimi tek sayıda toplandı. Tehlike varsayımsal değil.

### Kapanış

Ayrıntı: `01-currency-policy.md`. Sonuç: TRY dışı çek/kredi satırları domain'e alınmıyor,
kaynakta korunuyor, yüksek şiddetli inceleme açılıyor. Karışık kaynakla TRY-only kaynağın
finans KPI'ları **birebir aynı** ölçüldü.

---

## 2 · P1 — eşzamanlı import mükerrer üretiyor

### Sorun

Kilitsiz akış:

```
defterde ara → bulunamadı → domain INSERT → defter INSERT
```

İki import aynı anda koştuğunda ikisi de "bulunamadı" görür, ikisi de kayıt yaratır.

### Ölçüm (negatif kontrol)

İki bağımsız `PoolClient`, aynı `external_id`, aramadan sonra bir kapıyla senkronize edilerek
düzeltmeden önceki sıra tekrarlandı:

```
payments = 2 · defter = 1 · sahipsiz kayıt = 1
```

Vaat ("aynı kodla tekrar import mükerrer üretmez") tam burada kırılıyordu.

### Kapanış

`pg_advisory_xact_lock(hashtext(entity_table), hashtext(external_id))` alınır ve defter
**kilit altında yeniden okunur**. Kilidin kendisi doğruluğun kaynağı değil; kilit altında
tekrarlanan arama doğruluğun kaynağı.

Aynı harness düzeltilmiş kodla:

```
DOMAIN_ROWS = 1 · LEDGER_ROWS = 1 · DISTINCT_ENTITY_IDS = 1 · ORPHAN_DUPLICATES = 0
biri yarattı (inserted=1), diğeri güncelledi (updated=1)
```

Unique violation kabul edilen bir sonuç değil — **her iki import da başarıyla bitti**.

---

## 3 · P1 — bayat bağlama sessiz başarı

### Sorun

`UPDATE ... WHERE id = $1` hiçbir satırı etkilemediğinde PostgreSQL **hata vermez**; sessizce
0 satır günceller. Kod "güncelledim" diye dönüyordu, rapor "1 kayıt güncellendi" yazıyordu ve
ortada güncellenmiş bir şey yoktu.

### Kapanış

İki katmanlı:

1. **Açık kontrol.** Defter bir kayda işaret ediyorsa, yazmadan önce ve kilit altında o kaydın
   varlığı sorulur. Yoksa `STALE_EXTERNAL_KEY_BINDING` — hangi kod, hangi tablo, hangi kayıt
   bilgisiyle.
2. **Değişmez kontrolü.** `upsertRow` her UPDATE'in tam olarak 1 satır etkilediğini doğrular.
   0 satır kimlik zinciri kopukluğudur; 1'den fazlası birincil anahtar yüzünden mümkün
   olmamalı — yine de kontrol ediliyor, çünkü "mümkün değil" varsayımı sessizce yanlış çıkarsa
   bunu öğrenmenin tek yolu budur.

**Otomatik iyileştirme bilerek yapılmıyor.** Yeni bir kayıt yaratıp deftere bağlamak kopuk
zinciri gizler ve kullanıcının güncellediğini sandığı kayıt sessizce ikinci bir kayda dönüşür.

Ölçüm: kayıt silinip bağlama bırakıldığında import durdu, **yeni domain kaydı yaratılmadı**,
**defter yeniden atanmadı**.

Ayrıca `(entity_table, external_id) → TEK entity_id` değişmezi sertleştirildi: çakışmada
`EXTERNAL_KEY_BINDING_CONFLICT` ve mevcut bağlama **değişmiyor**.

---

## 4 · Migration hijyeni

`0090` kısıt varlık kontrolleri yalnız `conname` ile yapılıyordu. PostgreSQL'de kısıt adları
veritabanı genelinde eşsiz değildir.

Canlı ölçüm — hedef tabloda kısıt yokken başka bir tabloda aynı adla kısıt varken:

```
ESKI HAL   : ERROR: constraint "loans_currency_check" of relation "loans" does not exist
DUZELTILMIS: DO   → kısıt public.loans üzerinde doğru kuruldu
```

Ayrıntı: `07-migration-hygiene.json`.

---

## Kapanmayanlar (bilerek)

| Konu | Durum |
|---|---|
| `15_MALIYET` domain eşlemesi | `STAGED_ONLY_BY_DESIGN` — şekil uyuşmazlığı |
| Çoklu para birimi finans analitiği | `MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED` |
| Şablon indirme / önizleme / production import UI | Bu turda açılmadı |
| Release promotion | YAPILMADI |
| Gerçek DB'ye V2 import | `REAL_V2_IMPORT_EXECUTED = NO` |
