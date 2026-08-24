# Yedekleme ve geri yükleme politikası

**Faz 6 çıktısı.** "Backup alındı" bir iddia değildir; bu belge hangi iddiaların kanıtlanması
gerektiğini ve yedeklerin nerede, ne kadar süreyle tutulacağını tanımlar.

---

## 1. Beş kapı — yedek ancak hepsi YES ise yedektir

```text
BACKUP EXISTS            dump üretildi, boyutu ve sha256'sı var
BACKUP READABLE          pg_restore arşivi AYRIŞTIRABİLİYOR (ls yetmez)
BACKUP RESTORABLE        boş bir veritabanına gerçekten yükleniyor
RESTORED DATA MATCHES    counts + aggregates + satır hash'leri kaynakla aynı
APP CAN START ON RESTORE uygulama o kopyaya karşı ayağa kalkıyor ve kritik ekranlar çalışıyor
```

Tek komut:

```bash
SOURCE_DATABASE_URL=postgres://…/mas_radar_dev \
RESTORE_DB=mas_radar_restore_drill \
  pnpm release:restore-drill
```

Beşinci kapı atlanan kapıdır ve önemli olan odur. **Bu depoda bir kez gerçekten düştü:** veri
birebir eşleşiyordu (85 tablo, bütün hash'ler aynı) ama uygulama
`permission denied for table users` ile açılmadı — çünkü restore `--no-acl` ile yapılmıştı ve
GRANT'lar geri gelmemişti. Satır sayısına bakan bir kontrol bunu asla görmez.

## 2. Retention — en az üç sınıf (§9.4)

| Sınıf | Ne zaman | Saklama | Değiştirilebilir mi |
|---|---|---|---|
| **pre-cutover immutable** | her cutover'dan HEMEN önce | en az 1 yıl | **HAYIR** — write-once, silinemez |
| **post-cutover** | cutover başarıyla bittikten sonra | en az 1 yıl | hayır |
| **rolling operational** | günlük | 30 gün pencere | üzerine yazılır |

**Pre-cutover yedek immutable olmalı**, çünkü geri dönülecek tek nokta odur. Cutover sırasında bir
şey ters gittiğinde, o yedeği "yer açmak için" silmiş olmak veya üzerine yazmış olmak, geri dönüşü
olmayan tek hatadır.

## 3. Tek kopya yedek değildir

**Yerel disk tek kopya olamaz.** En az bir kopya **fiziksel olarak farklı bir depolama hedefinde**
bulunmalı. Aynı makinedeki ikinci bir klasör kopya sayılmaz: diski, makineyi ya da şifreleyen bir
yazılımı kaybeden senaryo ikisini birden kaybeder.

Bu kurulum tek operatörlü ve şirket içi olduğu için önerilen asgari yaklaşım:

1. **Birincil:** operatör makinesinde `backups/` (rolling, 30 gün).
2. **İkincil:** ayrı fiziksel ortam — harici disk ya da NAS. Elle kopyalanacaksa cutover
   kontrol listesine ADIM olarak yazılmalı, "unutulmazsa yapılır" olarak değil.
3. **Üçüncül (pre/post-cutover için):** şirket dışı bir kopya (şifreli). Finansal veri olduğu için
   şifreleme ve erişim kaydı zorunlu.

**Bu ortamda gerçek bir uzak hedef kurulmadı** — gereksinim ve yaklaşım belgelendi, uygulaması
operatörün kendi depolama kararına bağlı.

## 4. Zamanlama — nasıl kurulur

Gerçek bir zamanlanmış görev bu çalışmada **kurulmadı**. Kurulacağı zaman:

- **Windows:** Task Scheduler → günlük tetikleyici → `pnpm release:restore-drill` değil,
  yalnız yedek alma adımı (drill haftalık/aylık koşmalı, çünkü build + smoke dakikalar sürer).
- **Linux/NAS:** cron.

Ayrım önemli: **yedek almak günlük**, **restore drill'i periyodik**. Her gün tam drill koşturmak
pahalıdır; hiç koşturmamak ise yedeğin geri yüklenebilir olduğunu hiç bilmemektir. Önerilen:
yedek günlük, drill en az ayda bir ve **her cutover'dan önce mutlaka**.

## 5. Her yedeğin makbuzu olmalı (§9.1)

`pnpm release:restore-drill` her koşuda şu alanları üretir:

```yaml
backup_receipt:
  timestamp:          # ne zaman alındı
  source_db:          # hangi veritabanından
  system_identifier:  # hangi PostgreSQL kümesinden (yanlış küme kanıtı)
  git_sha:            # hangi kod sürümü çalışıyordu
  schema_ledger:      # migration durumu (ör. 87/0087)
  file_size:          # boyut
  sha256:             # bütünlük
  pg_version:         # sunucu sürümü
  pg_dump_version:    # araç sürümü (restore uyumluluğu)
```

`system_identifier` ve `schema_ledger` en çok işe yarayan ikisidir: birincisi yedeğin **hangi
kümeden** geldiğini kanıtlar (yanlış ortamdan alınmış bir yedek en sinsi hatadır), ikincisi hangi
şema sürümüne geri döneceğinizi söyler.

## 6. Güvenlik kuralları (script'e gömülü)

- Kaynağa yalnız `pg_dump` dokunur — okur, yazmaz.
- Restore hedefinin adı **harcanabilir işaret** taşımak zorunda; `mas_radar_dev` açıkça reddedilir.
  Doğrulandı: `RESTORE_DB=mas_radar_dev` → `GÜVENLİK DURDURMASI`, exit 1.
- Hedef her koşuda düşürülüp yeniden yaratılır — bayat bir kopya sessizce "doğrulanamaz".
- Kaynak URL hiçbir çıktıya yazılmaz (parola taşır).

## 7. Restore ederken `--no-acl` KULLANMAYIN

`pg_restore --no-owner` doğru (geri yükleyen kullanıcı sahibi olur), **`--no-acl` yanlış**.
Ölçüldü, aynı arşiv, aynı hedef:

```text
--no-owner            : app SELECT users = true   INSERT users = true   SELECT payments = true
--no-owner --no-acl   : app SELECT users = false  INSERT users = false  SELECT payments = false
```

GRANT'lar yedeğin bir parçasıdır. Uygulamayı dışarıda bırakan bir kurtarma, hiçbir şeyi
kurtarmamıştır.
