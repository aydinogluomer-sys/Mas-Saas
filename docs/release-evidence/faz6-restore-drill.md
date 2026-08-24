# Faz 6 — Backup / restore readiness kanıtı

**Tarih:** 2026-08-24 · **Branch:** `release/production-readiness-hardening`
**Komut:** `pnpm release:restore-drill` · **Script:** `scripts/release/restore-drill.ts`
**DB sınıfı:** `DISPOSABLE_SYNTHETIC` — izole cluster (`mas-radar-pg-faz6-sandbox`, port 55437).
Gerçek `mas_radar_dev`'e bağlantı **yok**.

---

## 1. Faz 6 PASS kapıları — 5/5 YES

```text
BACKUP EXISTS            = YES   1.380.380 bayt · sha256 90afec4d…
BACKUP READABLE          = YES   pg_restore --list, 1.387 TOC girdisi
BACKUP RESTORABLE        = YES   boş veritabanına yüklendi, 85 tablo
RESTORED DATA MATCHES    = YES   85 tablo sayı + 6 parasal toplam + 85 satır hash'i birebir
APP CAN START ON RESTORE = YES   /ready = 200 · golden-ui-smoke 36/36
```

**9/9 kontrol, exit 0.**

## 2. Faz 5'in üzerine kuruldu, yeniden icat edilmedi

Dump / `pg_restore --list` / fresh restore / fingerprint makinesi Faz 5'in. Ortak ölçüm
`scripts/release/lib/fingerprint.ts`'e çıkarıldı ve iki script de onu kullanıyor — bir hash
tanımının iki kopyası, uyuşması gereken iki cevabın sessizce ayrışma yoludur. Refactor sonrası
Faz 5 regresyon testi: `golden-fingerprint` **14/14**, değişmedi.

Faz 6'nın eklediği: **makbuzlar** (§9.1, §9.2) ve **uygulama fazı** (§9.3).

## 3. Beşinci kapı gerçekten düştü — ve bulduğu şey gerçekti

İlk koşuda dört kapı YES, beşinci NO:

```text
RESTORED DATA MATCHES    = YES   (85 tablo, bütün hash'ler birebir)
APP CAN START ON RESTORE = NO
```

Veritabanı kusursuzdu. Uygulama açılmadı:

```text
Çalışma zamanı hazırlığı başarısız: error: permission denied for table users
```

Sebep: restore'u `pg_restore --no-owner --no-acl` ile yapıyordum (golden-fingerprint.ts'ten
kopyalanmıştı). `--no-acl` **GRANT ifadelerini atar**, yani `mas_radar_app` hiçbir tablo üzerinde
yetkisiz geri geldi. Aynı arşiv, aynı hedef, yan yana ölçüm:

```text
--no-owner            : app SELECT users = true   INSERT users = true   SELECT payments = true
--no-owner --no-acl   : app SELECT users = false  INSERT users = false  SELECT payments = false
```

`golden-fingerprint.ts`'te ACL'leri atmak **savunulabilir**: o clone'a yalnız owner dokunur ve eski
grant'ları devralmak eksik bir grant'ı maskeleyebilir. Ama bir **restore'da grant'lar geri gelmesi
gereken şeyin parçasıdır** — uygulamayı dışarıda bırakan bir kurtarma hiçbir şeyi kurtarmamıştır.
İki script artık farklı bayraklar kullanıyor ve nedeni ikisinde de yazılı.

**Satır sayısına bakan bir restore kontrolü bunu asla göremezdi.** Beşinci kapının varlık sebebi
tam olarak budur.

### İkinci bulgu: sessiz düşen drill

İlk başarısızlık yalnız "sunucu hazır olmadı" diyordu; gerçek sebep `stdio: "ignore"` ile atılmıştı.
Sunucu çıktısı artık `test-results/restore-drill-server.log`'a yazılıyor ve başarısızlıkta son
satırları rapora giriyor. **Neden düştüğünü söyleyemeyen bir prova, provanın yarısıdır.**

## 4. §9.1 backup receipt (üretilen)

```yaml
backup_receipt:
  timestamp: "2026-08-24T18:32:48.112Z"
  source_db: "mas_radar_faz6_source_fixture"
  system_identifier: "7677664607988314150"
  git_sha: "df8674eabf93d59b062152b91a8480b108effb8e"
  schema_ledger: "87/0087"
  file_size: 1380380
  sha256: "90afec4d6552be5dbe4ff160bb36c01d16afe5bc2073c767eee2ce5ddfd882d5"
  pg_version: "PostgreSQL 16.14"
  pg_dump_version: "pg_dump (PostgreSQL) 16.14 (Debian 16.14-1.pgdg13+1)"
```

Planın istediği dokuz alanın tamamı. `system_identifier` yedeğin **hangi kümeden** geldiğini
kanıtlar — yanlış ortamdan alınmış bir yedek en sinsi hatadır; `schema_ledger` hangi şema sürümüne
geri döneceğinizi söyler.

## 5. §9.2 restore proof

1. **ayrı DB'ye restore** — `mas_radar_restore_drill`, her koşuda düşürülüp yeniden yaratılıyor
2. **counts** — 85 tablo, birebir
3. **aggregates** — 6 parasal toplam, birebir
4. **hash** — 85 tablonun satır hash'i, birebir
5. **owner ile login gerekmeyen read test** — `payments=19` (kaynak 19)
6. **restore receipt** — üretildi

## 6. §9.3 restore drill — tam prova

```text
backup → hedefi düşür → oluştur → restore → doğrula
       → app-role parolası + system actor → pnpm build
       → pnpm start (restore edilen DB'ye karşı, mas_radar_app kimliğiyle)
       → /ready = 200 → kritik smoke
```

Smoke olarak **`golden-ui-smoke.spec.ts`** seçildi (varsayılan; `SMOKE_SPEC` ile değiştirilebilir),
çünkü restore edilen kopya veri taşıyor: 24 kritik ekran + **12 parasal mutabakat** artık
**restore edilmiş veri** üzerinde doğrulanıyor. Sonuç **36/36**. Yani "restore edilen veri gerçekten
uygulama tarafından kullanılabilir mi" sorusu ekran ve para düzeyinde cevaplandı, yalnız satır
sayısı düzeyinde değil.

## 7. §9.4 retention

`docs/backup-restore-policy.md` — üç sınıf (pre-cutover **immutable**, post-cutover, rolling
operational), tek kopya yasağı, en az bir kopyanın fiziksel olarak farklı depolama hedefinde
bulunması, zamanlama önerisi (yedek günlük, drill periyodik ve **her cutover'dan önce**).

**Gerçek bir zamanlanmış görev veya uzak depolama hedefi kurulmadı** — gereksinim ve yaklaşım
belgelendi; uygulaması operatörün depolama kararına bağlı.

## 8. Güvenlik kapıları (doğrulandı)

- `RESTORE_DB=mas_radar_dev` → `GÜVENLİK DURDURMASI`, exit 1, bağlantı açılmadan.
- Kaynağa yalnız `pg_dump` dokunur.
- Hedef her koşuda taze.
- Kaynak URL hiçbir çıktıya yazılmaz.

## 9. Sınır — dürüstçe

Prova **sentetik-ama-gerçekçi** bir kaynak üzerinde koşuldu (`seed:demo`, payments=19 checks=7
loans=1 cashflow_months=35, ledger 87/0087). Gerçek `mas_radar_dev` yedeği bu harness'ta
alınamaz — kimlik bilgisi kasten yok. Script gerçek kaynak için hazırdır ve tek komutla koşar;
gerçek çalıştırma kimlik bilgisine sahip operatörün işidir.
