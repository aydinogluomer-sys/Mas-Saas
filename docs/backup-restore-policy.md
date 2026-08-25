# Yedekleme ve geri yükleme politikası

**Faz 6 çıktısı.** "Backup alındı" bir iddia değildir; bu belge hangi iddiaların kanıtlanması
gerektiğini ve yedeklerin nerede, ne kadar süreyle tutulacağını tanımlar.

---

## 1. Yedi kapı — yedek ancak hepsi YES ise yedektir

```text
BACKUP EXISTS            dump üretildi, boyutu ve sha256'sı var
BACKUP READABLE          pg_restore arşivi AYRIŞTIRABİLİYOR (ls yetmez)
BACKUP RESTORABLE        boş bir veritabanına gerçekten yükleniyor
RESTORED DATA MATCHES    counts + aggregates + satır hash'leri kaynakla aynı
APP CAN START ON RESTORE uygulama o kopyaya karşı ayağa kalkıyor ve kritik ekranlar çalışıyor
```

AŞAMA 07 bu listeye iki kapı daha ekledi — çünkü ilk beşi geçen bir yedek hâlâ tek kopya
olabilir ve saklanan kopyanın kendisi hiç denenmemiş olabilir:

```text
OFF_DEVICE COPY          kopya İKİNCİ bir depolama hedefinde ve orada sha256'sı doğrulandı
OPERATIONAL SCHEDULE     yedek elle değil, zamanlanmış bir işle alınıyor
```

Tek komut (yedi kapının tamamı):

```bash
MAS_OFFDEVICE_BACKUP_DIR=E:\mas-yedek \
  pnpm exec tsx scripts/release/stage07-backup-gate.ts
```

Kapı kaynağa (`mas_radar_dev`) yalnız `pg_dump` ve SELECT uygular, iki harcanabilir hedefe
restore eder ve ikisini de koşu sonunda düşürür. **`pnpm db:app-role:password` çağırmaz**
(o script rolü cluster genelinde değiştirir ve çalışan production örneğinin kimliğini bozar);
uygulamayı ayrı bir `distDir` ve ayrı bir portla başlatır, canlı `.next`e ve port 3000'deki
örneğe dokunmaz.

Daha eski `pnpm release:restore-drill` ilk beş kapıyı sorar ama beşinci adımında
`pnpm db:app-role:password` çağırır; bu makinede **kullanılmamalıdır**.

Beşinci kapı atlanan kapıdır ve önemli olan odur. **Bu depoda bir kez gerçekten düştü:** veri
birebir eşleşiyordu (85 tablo, bütün hash'ler aynı) ama uygulama
`permission denied for table users` ile açılmadı — çünkü restore `--no-acl` ile yapılmıştı ve
GRANT'lar geri gelmemişti. Satır sayısına bakan bir kontrol bunu asla görmez.

## 2. Retention — en az üç sınıf (§9.4)

| Sınıf | Ne zaman | Saklama | Değiştirilebilir mi |
|---|---|---|---|
| **pre-cutover immutable** | her cutover'dan HEMEN önce | en az 1 yıl | **HAYIR** — write-once, silinemez |
| **post-cutover** | cutover başarıyla bittikten sonra | en az 1 yıl | hayır |
| **rolling operational** | günlük | daily 7 · weekly 4 · monthly 3 | budanır |

**Pre-cutover yedek immutable olmalı**, çünkü geri dönülecek tek nokta odur. Cutover sırasında bir
şey ters gittiğinde, o yedeği "yer açmak için" silmiş olmak veya üzerine yazmış olmak, geri dönüşü
olmayan tek hatadır.

### 2.1 Politikayı UYGULAYAN kod (AŞAMA 07)

Bu tablo uzun süre yalnız bir niyetti: hiçbir kod onu uygulamıyordu ve ölçüldüğünde `backups/`
içinde **857 dump / ~973 MB** birikmişti. Artık uygulayan bir araç var:

```bash
pnpm exec tsx scripts/ops/backup-prune.ts             # KURU KOŞU (varsayılan)
pnpm exec tsx scripts/ops/backup-prune.ts --verbose   # her dosyanın kararı
pnpm exec tsx scripts/ops/backup-prune.ts --apply     # gerçekten sil
pnpm exec tsx scripts/ops/backup-prune.ts --dir E:\mas-yedek --daily 7 --weekly 4 --monthly 3
```

Seçim **grandfather-father-son**'dur: son 7 GÜNÜN, son 4 HAFTANIN ve son 3 AYIN en yeni dump'ı
tutulur. Dosya sayısına değil zamana bakmasının nedeni ölçülmüş bir tuzaktır: `db:migrate` her
koşuda yedek alıyor ve tek bir günde 20 dump oluşabiliyor — "en yeni 7 dosya" kuralı o günün 20
kopyasını tutup önceki altı günü silerdi, yani en çok ihtiyaç duyulan şeyi (zamanda geriye
gidebilmeyi) yok ederdi.

**IMMUTABLE sınıfına hiçbir koşulda dokunulmaz.** Sınıf dosya adından belirlenir
(`cutover_*`, `*pre-cutover*`, `*post-cutover*`, `stage07_real*`, `release_*`, `*immutable*`)
ya da dump'ın yanına konan `<dump>.immutable` işaret dosyasından. `mas_radar_dev` adını taşıyan
her dump da immutable'dır — bu kural kuru koşunun bir bulgusudur: `mas_radar_dev-20260706-181434.dump`,
yani gerçek üretim veritabanının bir yedeği, ilk çalıştırmada budanacaklar listesine düşmüştü.
Koruma hem planlama hem de silme anında ikinci kez kontrol edilir.

Silinen bir dump'ın yan dosyaları (`.receipt.json`, `.stage07.json`, `.offdevice.json`) onunla
birlikte silinir; makbuzsuz bir dump ya da dump'sız bir makbuz geride bırakılmaz.

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

### 3.1 Araç kurulu, HEDEF eksik (AŞAMA 07 durumu)

Kopyalama ve **hedefte doğrulama** artık koda döküldü:

```bash
setx MAS_OFFDEVICE_BACKUP_DIR "E:\mas-yedek"          # harici disk
setx MAS_OFFDEVICE_BACKUP_DIR "\\nas\mas-yedek"       # NAS / ağ paylaşımı
pnpm exec tsx scripts/ops/offdevice-copy.ts --dry-run  # hedefi sınıflandır, kopyalama
pnpm exec tsx scripts/ops/offdevice-copy.ts            # kopyala + HEDEFTE sha256 doğrula
```

Araç "copy komutu 0 döndü" ile yetinmez: hedefteki dosyayı yeniden okuyup sha256'sını ve
boyutunu kaynakla karşılaştırır, kopyayı container'a geri okutup `pg_restore --list` ile
hâlâ geçerli bir arşiv olduğunu doğrular, makbuz yan dosyalarını da taşır ve sonucu hedefte
`<dump>.offdevice.json` olarak kaydeder. Eşleşme tutmazsa kopya **silinir** — bozuk bir dosya
"yedek" adıyla ortalıkta bırakılmaz.

Araç ayrıca hedefi **sınıflandırır** ve yerel bir klasörü off-device saymaz:

| Sınıf | Nasıl belirlenir | Off-device sayılır mı |
|---|---|---|
| `UNC_NETWORK_SHARE` | yol `\\` ile başlıyor | evet |
| `REMOVABLE_VOLUME` | Win32_LogicalDisk DriveType = 2 | evet |
| `NETWORK_DRIVE` | DriveType = 4 | evet |
| `OPERATOR_ATTESTED` | `MAS_OFFDEVICE_DECLARED_KIND` + `MAS_OFFDEVICE_OPERATOR_ATTESTATION` | evet (beyan, ölçüm değil) |
| `FIXED_SEPARATE_VOLUME` | DriveType = 3, kaynaktan farklı bölüm | **hayır** — ayrı bölüm ayrı aygıt değildir |
| `LOCAL_STANDIN` | DriveType = 3, aynı disk | **hayır** (§30.5) |

```text
OFF_DEVICE TOOLING         = VERIFIED
OFF_DEVICE PHYSICAL TARGET = BLOCKED — bu makinede ayrı bir aygıt yok
```

Ölçüldü (2026-08-25): makinede yalnız `C:` var (DriveType 3, sabit disk); takılı çıkarılabilir
sürücü, bağlı ağ paylaşımı ya da eşitleme klasörü yok. **Operatör adımı:** harici disk takın, NAS
paylaşımı bağlayın ya da şifreli nesne depolaması yapılandırın; sonra `MAS_OFFDEVICE_BACKUP_DIR`i
ayarlayın. Bu yapılana kadar off-device kopya **kurulmuş sayılmaz** ve günlük yedek işi bunu
sessizce geçmez — exit 3 ile "TEK KOPYA" der.

> Gerçek finansal veri hiçbir dış servise tünellenmez. Şirket dışı kopya alınacaksa şifreleme ve
> erişim kaydı zorunludur; bu karar operatörün, aracın değil.

## 4. Zamanlama — kurulum, kaldırma, doğrulama

Günlük yedek işi ve onu Windows Görev Zamanlayıcı'ya kaydeden araç **hazır**. Görev bilinçli
olarak **kaydedilmedi**: tekrarlayan bir görev kullanıcının makinesinde kalıcı, dışa dönük bir
değişikliktir ve kararı operatörün olmalıdır.

```bash
# durum (salt okunur)
pnpm exec tsx scripts/ops/schedule-windows.ts status

# kurulum — önce what-if (ön koşullar + birebir komut, KAYIT YOK)
pnpm exec tsx scripts/ops/schedule-windows.ts install
# gerçekten kaydet
pnpm exec tsx scripts/ops/schedule-windows.ts install --apply --at 03:00

# elle tetikle / kaldır
pnpm exec tsx scripts/ops/schedule-windows.ts run-once --apply
pnpm exec tsx scripts/ops/schedule-windows.ts uninstall --apply
```

Kaydedilen komut birebir şudur:

```text
schtasks /Create /TN MAS-Nakit-Radar-Gunluk-Yedek /TR "<repo>\scripts\ops\mas-daily-backup.cmd" \
         /SC DAILY /ST 03:00 /RL LIMITED /F
```

`/RL LIMITED` bilinçli: yedek almak yönetici hakkı gerektirmiyor ve gereksiz yükseltme,
zamanlanmış bir görevin en kolay kötüye kullanılan yanıdır.

Görevin çalıştırdığı iş `scripts/ops/backup-daily.ts`: dump → makbuz → off-device kopya +
hedefte doğrulama → retention kuru koşusu, ve her koşuyu `backups/daily-runs.jsonl`e yazar.
Çıkış kodları zamanlayıcıda görünür:

```text
0  yedek + doğrulama + off-device kopya tamam
1  yedek alınamadı / doğrulama düştü      → P0
3  yedek tamam ama off-device hedef yok   → tek kopya yedek değildir (§3)
   (bilinçli kabul: MAS_OFFDEVICE_ACKNOWLEDGED_MISSING=1)
```

Retention'ı görev içinde gerçekten uygulatmak için `MAS_BACKUP_PRUNE_APPLY=1` gerekir; varsayılan
kuru koşudur. Silme kararı, ilk kuru koşu çıktısı okunmadan verilmemelidir.

**Linux/NAS için:** aynı iş `cron` ile koşar —
`0 3 * * * cd /opt/mas && pnpm exec tsx scripts/ops/backup-daily.ts >> backups/daily-backup.log 2>&1`.

Ayrım önemli: **yedek almak günlük**, **restore drill'i periyodik**. Her gün tam drill koşturmak
pahalıdır; hiç koşturmamak ise yedeğin geri yüklenebilir olduğunu hiç bilmemektir. Önerilen:
yedek günlük, tam kapı (`scripts/release/stage07-backup-gate.ts`) en az ayda bir ve **her
cutover'dan önce mutlaka**.

## 5. Her yedeğin makbuzu olmalı (§9.1)

Her yedeğin yanına **dokuz alanlı** bir makbuz yazılır (`<dump>.stage07.json`):

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
şema sürümüne geri döneceğinizi söyler. `pg_version` / `pg_dump_version` üçüncü sırada gelir ve
kurtarma gününe kadar önemsiz görünür: 16.14 ile yazılmış bir arşivin daha eski bir `pg_restore`
ile yükleneceği garanti değildir ve o an makbuz elinizdeki tek kayıttır.

### 5.1 İki makbuz, iki farklı garanti

| Dosya | Üreten | Ne garanti eder |
|---|---|---|
| `<dump>.receipt.json` | `scripts/db/backup-receipt.ts` | **Katı**: TCP bağlantısı ile container'ın AYNI cluster olduğu (dump öncesi ve sonrası), git branch/HEAD eşleşmesi ve **temiz çalışma ağacı**, tam dayanıklılık zinciri. Temiz ağaç şartının bypass'ı yoktur. |
| `<dump>.stage07.json` | `scripts/ops/backup-daily.ts` ve AŞAMA 07 kapısı | Rehber §12'nin **dokuz alanı**, artı git ağacının o an temiz olup olmadığı (`git_tree_clean`) ve varsa katı makbuzun sha256'sı. |

Ayrım bilinçlidir. Zamanlanmış bir gece işi, çalışma ağacının temiz olduğunu **varsayamaz**; öyle
bir şart günlük yedeği "bugün alınmadı"ya çevirirdi. Bu yüzden günlük iş aynı dayanıklılık
zincirini kullanır ama git durumunu gizlemek yerine makbuza olduğu gibi yazar. **Cutover
yedekleri için katı makbuz zorunludur** — orada temiz ağaç, geri dönülecek noktanın hangi kod
sürümüne ait olduğunun tek kanıtıdır.

## 6. Güvenlik kuralları (script'e gömülü)

- Kaynağa yalnız `pg_dump` dokunur — okur, yazmaz.
- Restore hedefinin adı **harcanabilir işaret** taşımak zorunda; `mas_radar_dev` açıkça reddedilir.
  Doğrulandı: `RESTORE_DB=mas_radar_dev` → `GÜVENLİK DURDURMASI`, exit 1.
- Hedef her koşuda düşürülüp yeniden yaratılır — bayat bir kopya sessizce "doğrulanamaz".
- Kaynak URL hiçbir çıktıya yazılmaz (parola taşır).
- **`pnpm db:app-role:password` çağrılmaz.** O script `mas_radar_app` rolünü CLUSTER genelinde
  değiştirir; çağrıldığı an çalışan production örneğinin `.env.local` kimliği geçersizleşir.
  Klonun uygulama bağlantısı bunun yerine mevcut `.env.local` DATABASE_URL'inden **yalnız
  veritabanı adı değiştirilerek** türetilir — hem güvenli hem daha güçlü bir test, çünkü gerçek
  runtime kimliğiyle bağlanılır.
- Kapı düz `pnpm build` koşmaz: canlı `.next` ezilmez, hazır bir derleme ayrı bir `distDir` ve
  ayrı bir portla başlatılır ve yalnız kapının KENDİ başlattığı süreç öldürülür.
- Budama varsayılan olarak kuru koşudur; `--apply` olmadan hiçbir dosya silinmez ve `--apply`
  bile IMMUTABLE sınıfına dokunamaz.

## 7. Restore ederken `--no-acl` KULLANMAYIN

`pg_restore --no-owner` doğru (geri yükleyen kullanıcı sahibi olur), **`--no-acl` yanlış**.
Ölçüldü, aynı arşiv, aynı hedef:

```text
--no-owner            : app SELECT users = true   INSERT users = true   SELECT payments = true
--no-owner --no-acl   : app SELECT users = false  INSERT users = false  SELECT payments = false
```

GRANT'lar yedeğin bir parçasıdır. Uygulamayı dışarıda bırakan bir kurtarma, hiçbir şeyi
kurtarmamıştır.
