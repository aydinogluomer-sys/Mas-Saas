# Faz 5 — Migration evidence, tek komutla yeniden üretilebilir

**Tarih:** 2026-08-24 · **Branch:** `release/production-readiness-hardening`
**Komut:** `pnpm release:golden-fingerprint` · **Script:** `scripts/release/golden-fingerprint.ts`

---

## 1. Bu faz neyi değiştiriyor

Golden exact-clone koşusu **zaten yapıldı ve geçti** (orkestratör, gerçek DB erişimiyle):
fresh dump → `pg_restore --list` → fresh restore → parmak izi → gerçek `pnpm db:migrate`
(0034→0087, exit 0) → parmak izi; dört ana finansal tablonun whole-row hash'i pre/post birebir.

Eksik olan kanıt değil, **tekrarlanabilirlikti**. Elle yapılmış bir prosedür release gate olamaz:
bir sonraki cutover'dan önce birebir tekrarlanamaz, ikinci bir operatöre devredilemez ve iş bittikten
sonra hangi assertion'ların gerçekten kontrol edildiği anlaşılamaz. Faz 5 o koşuyu tek komuda
çevirir.

## 2. Operatör prosedürü

```bash
SOURCE_DATABASE_URL=postgres://…@…/mas_radar_dev \
CLONE_DB=mas_radar_cutover_clone \
  pnpm release:golden-fingerprint
```

Script sırayla (§8.1):

```text
kaynak DB → fresh pg_dump → pg_restore --list → fresh restore → ÖNCE parmak izi
          → gerçek pnpm db:migrate → SONRA parmak izi → 14 değişmez → manifest
```

Çıktı: `docs/release-evidence/cutover-fingerprint-<tarih>.md` — counts, aggregates, whole-row
hash'ler, rol sayıları, ledger durumu; hepsi öncesi/sonrası yan yana.

### Güvenlik kuralları script'e gömülü

- **Kaynağa asla yazılmaz.** Ona dokunan tek şey `pg_dump`, o da yalnız okur.
- **Clone adı harcanabilir işaret taşımak zorunda.** Script hedefi DROP ettiği için bu kapı ilk
  çalışan şey. Doğrulandı: `CLONE_DB=mas_radar_dev` → `GÜVENLİK DURDURMASI`, exit 1, bağlantı
  açılmadan.
- **"Eski clone tekrar kullanılmaz" (§8.1) tavsiye değil, zorunluluk:** clone her koşuda düşürülüp
  yeniden yaratılır, yani bayat bir clone sessizce yeniden parmaklanamaz.
- Kaynak URL hiçbir yere yazdırılmaz — parola taşır.

### İki URL, iki bakış açısı (tek ayak kapanı)

`SOURCE_DATABASE_URL` **konteynerin içinden** çözülür (`pg_dump` orada çalışır) — yani
konteyner-içi port, yayınlanan host portu değil. `MAS_PG_PORT` ise host'tan kullanılır (bu süreç ve
`pnpm db:migrate`). Tek konteynerli standart kurulumda ikisi de 5432'dir ve fark görünmez; ayrı
porta yayınlanmış bir sandbox'ta ayrışırlar — yani yanlış veritabanına sessizce bağlanmanın en
pahalı olacağı anda.

## 3. Doğrulanan değişmezler (§8.3)

Script'in ürettiği 14 kontrol — hepsi sandbox koşusunda PASS:

| # | Değişmez | Ölçülen |
|---|---|---|
| 1 | fresh dump alındı | 1.378.527 bayt |
| 2 | `pg_restore --list` arşivi okuyabiliyor | 1.387 TOC girdisi |
| 3 | öncesi parmak izi | 85 tablo · ledger 87/0087 |
| 4 | ledger satır sayısı | **87** (diskten türetiliyor, sabit değil) |
| 5 | ledger son sürüm | **0087** (diskten türetiliyor) |
| 6 | bayat `operator` rolü = 0 | 0 satır |
| 7 | finance_manager artışı = önceki operator sayısı | 1 → 1 (operator 0) |
| 8 | en az bir aktif admin | 1 |
| 9 | `users_role_check` beş katmanı sayıyor, `operator` yok | CHECK doğrulandı |
| 10 | FK hedefleri çözülüyor | 170 FK, hedefsiz 0 |
| 11 | blanket `authenticated_all` RLS yok | 0 |
| 12 | assistant arşiv tutarlılık kısıtı | status↔archived_at↔archive_reason |
| 13 | migration checksum drift = 0 | 87 ledger satırı diskle uyumlu |
| 14 | **legacy finansal tabloların veri hash'i değişmedi** | 6 tablo, pre=post |

4 ve 5 kasten **diskten türetiliyor**: 87'yi koda gömmek, 0088 geldiği gün doğru bir veritabanında
kırmızı verir ve "düzeltmenin" doğal yolu sayıyı büyütmektir — kapı böyle formaliteye dönüşür.

## 4. Hash neden `t::text` değil, açık kolon projeksiyonu

§8.2 whitelist'i şema eklemelerine izin veriyor. Bir migration kolon eklediğinde satırın metin
temsili değişir, dolayısıyla whole-row hash "bütün veri değişti" der — **hiçbir veri
değişmemişken**. Bunu bir kez gören operatör uyarıyı yok saymayı öğrenir.

Bu yüzden hash, **migration'dan ÖNCE var olan kolonlar** üzerinden hesaplanıyor: şema eklemeleri
(whitelist) sessizce geçer, oynayan herhangi bir değer geçmez. Hash ayrıca sıra bağımsız
(`string_agg(… order by h)`), yani restore sonrası farklı fiziksel satır sırası veri değişikliği
sanılmaz.

## 5. Kanıt: detektör gerçekten görüyor

Bir hash karşılaştırması, değişikliği yakaladığı gösterilmeden bir şey ifade etmez.
`payment_instances` üzerinde ölçüldü:

```text
hash_before             = 925ced529ff75d1c98219eadfbb83845
tek satırın amount'u  1.00 yapıldı
hash_after              = cd14951b300ee3a9d5db6fa6a5363b91   ← değişti
```

**İlk denemem yanlış negatif verdi ve nedeni kayda değer:** hedef satırın `amount` değeri `NULL`'dı,
`NULL + 1 = NULL`, yani `UPDATE 1` raporlanmasına rağmen hiçbir şey değişmemişti. Projenin kendi
"null bilinmeyendir, sıfır değildir" kuralı testi yazana çarptı. Gerçek bir değer üzerinde
tekrarlandığında hash beklendiği gibi döndü.

## 6. Sandbox koşusunun sınırı — dürüstçe

Bu doğrulama **izole sandbox'ta** (`mas-radar-pg-faz5-sandbox`, port 55436) yapıldı; "kaynak"
`seed:demo` ile üretilmiş `mas_radar_faz5_source_fixture` veritabanıdır ve **zaten 0087'dedir**.
Dolayısıyla `pnpm db:migrate` adımı bu koşuda `state=LEDGER_MANAGED / Değişiklik yok` ile döndü —
akışın tamamı, bütün assertion'lar ve manifest üretimi çalıştı, ama migration **iş yapmadı**.

Gerçek 0034→0087 geçişi orkestratörün gerçek DB koşusudur; bu script o koşuyu **kodlar**, yerine
geçmez. Aynı nedenle 7 numaralı değişmez (`finance_manager artışı = önceki operator sayısı`) burada
yalnız boş hâliyle (operator=0) sınandı: 0087 şemasındaki `users_role_check` `operator` değerini
kabul etmediği için gerçek `operator` satırı ancak 0034 kaynakta bulunabilir.

## 7. Faz 5 PASS

> Plan: "Migration evidence **tek komutla** yeniden üretilebilir."

`pnpm release:golden-fingerprint` — tek komut, 14/14 PASS, manifest dosyası üretiliyor,
kaynak salt-okunur, clone her koşuda taze. **PASS.**
