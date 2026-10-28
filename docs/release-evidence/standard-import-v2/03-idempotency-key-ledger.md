# 03 — İdempotency anahtar defteri (§27)

Tarih: 2026-09-04 · Dal: `feature/standard-import-v2` · Migration: `0088_import_external_keys.sql`

## Bulgu: idempotency vaadinin dayanacağı kolon yoktu

V2 sözleşmesi her sayfada isteğe bağlı bir **Kayıt Kodu (external_id)** sütunu tanımlıyor ve
şablonun hücre notu şunu vaat ediyor:

> "Aynı kodla tekrar import ederseniz kayıt GÜNCELLENİR, ikinci kopya oluşmaz."

Şemayı denetlediğimde bu vaadin karşılığı çıkmadı. 16 hedef tablonun **hiçbirinde** `external_id`
kolonu yok:

```
grep 'external' <16 tablonun CREATE TABLE gövdesi>
→ yalnız source_workbook_id / source_sheet_id / source_row_id
```

Yani:

| Gereklilik | Şemada durumu (0088 öncesi) |
|---|---|
| §26 provenance (satır → kaynak dosya/sayfa/satır) | **Zaten vardı** — `source_workbook_id`, `source_sheet_id`, `source_row_id` |
| §27 idempotency (aynı kod → aynı kayıt) | **Yoktu** — anahtarlanacak kolon ve eşsizlik kısıtı mevcut değildi |

Bu, "yazılmamış özellik" değil, **çalıştığı sanılabilecek bir vaat**: kod olmadan da import
başarılı görünür, ikinci import sessizce ikinci kopyayı yaratırdı.

## Karar: 16 tabloya kolon eklemek yerine ayrı defter

`public.import_external_keys` tablosu eklendi. Gerekçe:

1. **Risk.** O 16 tablonun üzerinde append-only audit tetikleyicisi (0022), arşiv değişmezlik
   tetikleyicisi (0024) ve durum geçiş muhafızı (0027) çalışıyor. Onaltı `ALTER TABLE`, bu
   koruma katmanlarının her biriyle ayrı ayrı yüzleşmek demekti — karşılığı olmayan bir risk.
2. **Anlam.** `external_id` finansal bir özellik değil, bir **import ad alanı**. Ödemenin tutarı
   ve vadesi şirketin verisidir; `ODM-ELEKTRIK` ise kullanıcının kendi dosyasındaki etiket.
   Finansal tablonun dışında tutmak, bu etiketin domain kısıtlarına karışmasını ya da motor
   tarafından iş anahtarı sanılmasını engeller.

## Doğrulama — harcanabilir DB üzerinde

Hedef: `mas_radar_import_v2_verify` (ad `verify` işareti taşıyor; `mas_radar_dev` korunan
listede). Bağlantı dizesi hiçbir çıktıya yazılmadı; `.env.local`'daki owner kimliğinden yalnız
veritabanı adı değiştirilerek türetildi.

Tüm ledger sıfırdan uygulandı: `0001 … 0088`, hepsi hatasız.

### Kısıtların işlevsel sınavı

| # | Senaryo | Beklenen | Sonuç |
|---|---|---|---|
| 1 | İlk kayıt yazılır | KABUL | ✅ |
| 2 | Aynı tablo + aynı kod ikinci kayıt yaratamaz | RED | ✅ |
| 3 | Aynı kayıt ikinci bir kodla sahiplenilemez | RED | ✅ |
| 4 | Boş/boşluklu kod, kod sayılmaz | RED | ✅ |
| 5 | Sözleşme dışı tablo adı reddedilir | RED | ✅ |
| 6 | **Farklı** tabloda aynı kod serbesttir | KABUL | ✅ |
| 7 | `updated_at` tetikleyicisi çalışır | tetiklenir | ✅ |

3 numara özellikle önemli: onsuz `ODM-A` ve `ODM-B` aynı ödemeye bağlanabilir ve ikinci import
hangisini güncelleyeceğini bilemezdi.

### Güvenlik yüzeyi

| Kontrol | Sonuç |
|---|---|
| RLS açık | ✅ `relrowsecurity = t` |
| Politika sayısı | 4 (SELECT / INSERT / UPDATE / DELETE) |
| viewer yazma izni | ❌ yok — Faz 24B değişmezi korunuyor |
| approver yazma izni | ❌ yok — `operational` sınıfı gereği yalnız okur |
| DELETE yetkisi | yalnız `finance_manager` + `admin` |

`DELETE`'in operatörden alınmasının sebebi: bir kaydı defterden düşürmek, sonraki import'ta o
kodun **yeni** bir kayıt yaratması demektir — yani mükerrer üretir.

**Not.** `authenticated` rolü tabloda tam yetkili görünüyor. Bunun kaynağı bu migration değil;
küme genelinde tanımlı `ALTER DEFAULT PRIVILEGES` (`pg_default_acl`) her yeni tabloya aynı
grant'i veriyor ve 0087 dahil tüm tablolarda aynı. RLS politikalarım `authenticated`'a hiçbir
izin tanımadığı için o yol fail-closed kapalı.

## Kayma koruması

`src/lib/importers/v2/migration-contract.test.ts`, migration'daki `entity_table` CHECK listesini
`contract.ts`'teki `domainTable` kümesiyle karşılaştırır. Sözleşmeye sayfa eklenip migration
güncellenmezse hata sessiz olurdu: import çalışır, o ailenin kayıtları deftere yazılamaz ve
idempotency **yalnız o aile için** çöker.

Negatif kontrol: `fx_positions` CHECK listesinden çıkarıldığında 2 test düştü; geri konduğunda
hepsi geçti.

## Sınırlar — bu tablo ne YAPMAZ

- Mükerrer **silmez** ve **birleştirmez**. Yalnız "bu kod daha önce şu kaydı yarattı" der.
- `external_id`'si olmayan satırlar buraya hiç girmez. Onlar için sistem iki satırın aynı iş
  kaydı olduğunu varsaymaz; benzerlik şüphesi parser'da `duplicate_check` olarak işaretlenir ve
  karar kullanıcıya kalır (§28).

## Durum

`REAL_V2_IMPORT_EXECUTED = NO` — gerçek `mas_radar_dev` veritabanına hiçbir yazma yapılmadı.
0088 yalnız harcanabilir doğrulama veritabanına uygulandı.

`docs/release-evidence/migration-manifest.txt` bilinçli olarak güncellenmedi: o dosya
`093573e` release'ine sabitlenmiş bir kanıt anlık görüntüsü ve onu doğrulayan otomatik bir
kontrol yok. Sonraki release kesitinde yeniden üretilmesi gerekir.
