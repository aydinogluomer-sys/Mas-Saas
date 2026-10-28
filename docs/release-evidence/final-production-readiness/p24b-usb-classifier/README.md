# Off-device sınıflandırıcı — USB fiziksel disk tespiti

Temel: `92bcd7cef547dec316511725f983d181d19bdf4b`. Gerçek `mas_radar_dev` üzerinde bu turda
**INSERT / UPDATE / DELETE / DDL / DROP yok** — veritabanı motoru zaten kapalı (aşağıda).

## Sorun

Bağlanan harici SSD `D:` reddediliyordu:

```
Win32_LogicalDisk : DeviceID=D:  DriveType=3
Get-Disk          : Number=1  BusType=USB  IsBoot=False  IsSystem=False
                    OperationalStatus=Online  Size=240 GB  "Min Yi U YZWY_TECH"
```

`classifyOffDeviceTarget()` yalnız `DriveType`'a bakıyordu. **DriveType=2 çıkarılabilir ORTAM
içindir** (flash bellek, kart okuyucu); USB ile bağlı bir SSD/HDD Windows'ta DriveType=3 —
"sabit disk" — döner. Yani ölçüt yanlış soruyu soruyordu: sonuç `FIXED_SEPARATE_VOLUME`,
`offDeviceSatisfied=false`, gerçek bir off-device hedef varken.

## Düzeltme

Karar artık mantıksal etikete değil **fiziksel disk kimliğine** dayanıyor. DriveType=3 son söz
olmaktan çıktı; o dalda `Get-Partition -DriveLetter X | Get-Disk` ile hem hedef hem **kaynak**
için disk numarası, BusType, IsBoot, IsSystem ve OperationalStatus ölçülüyor.

`USB_PHYSICAL_VOLUME` yalnız **yedi koşulun tamamı** sağlanırsa üretilir:

| # | koşul | ölçüldüğü yer |
|---|---|---|
| 1 | hedef topolojisi ölçülebiliyor | `parsePhysicalDiskJson` ≠ null |
| 2 | kaynak topolojisi ölçülebiliyor | aynı |
| 3 | `BusType = USB` | `Get-Disk` |
| 4 | hedef disk numarası ≠ kaynak disk numarası | `Get-Disk` |
| 5 | `IsBoot = false` | `Get-Disk` |
| 6 | `IsSystem = false` | `Get-Disk` |
| 7 | disk Online **ve** volume kaynaktan farklı | `Get-Disk` + kök karşılaştırması |

**Fail-closed.** Ölçülemeyen her şey RED'dir; "bilinmiyor" ile "güvenli" burada aynı şey değil.
Eksik bir bayrak `false` sayılmaz — ölçülmemiş olmak, olumlu ölçüm değildir.

**Gevşetilmeyenler.** `FIXED_SEPARATE_VOLUME` aynen duruyor: *farklı sürücü harfi tek başına
ASLA yetmez.* `OPERATOR_ATTESTED` cleanup-grade değil ve olmadı — üstelik artık ölçüm başarılı
olup **reddettiyse** beyan onu geçersiz kılamaz; beyan yalnız ölçümün ulaşamadığı hedefler için.

```ts
CLEANUP_GRADE_TARGET_KINDS = { REMOVABLE_VOLUME, NETWORK_DRIVE, UNC_NETWORK_SHARE,
                               USB_PHYSICAL_VOLUME }
```

### Karar, ölçümden ayrı tutuldu

`offdevice-topology.ts` saf: PowerShell çağırmaz, ortam okumaz. Bu, v2.3.1'de ölçülen dersin
uygulanması — orada 15 µs'lik bir yüklemi subprocess'lerle sınamak 11–22 saniye sürüyordu ve
kırılganlık güvenlik kodundan değil harness'tan geliyordu. Buradaki on iki vakalık matris aynı
process'te koşuyor.

## Gerçek ölçüm (salt okunur prob)

`scripts/ops/offdevice-classify-probe.ts` hiçbir dizin oluşturmaz, dosya kopyalamaz, DB'ye
dokunmaz.

```
D:\MAS-Backups                          C:\MAS-Backups
LOGICAL_DRIVE_TYPE          3           3
PHYSICAL_DISK_NUMBER        1           0
BUS_TYPE                    USB         RAID
IS_BOOT                     false       true
IS_SYSTEM                   false       true
SOURCE_PHYSICAL_DISK_NUMBER 0           0
SAME_PHYSICAL_DISK          false       true
TARGET_KIND       USB_PHYSICAL_VOLUME   LOCAL_STANDIN
OFF_DEVICE_SATISFIED        true        false
CLEANUP_GRADE               true        false
```

`C:` beş bağımsız engelle düşüyor (BusType, IsBoot, IsSystem, aynı fiziksel disk, aynı volume) —
tek bir kurala bağlı değil. Beyanla üretilen üçüncü prob `OPERATOR_ATTESTED` /
`OFF_DEVICE_SATISFIED=true` / **`CLEANUP_GRADE=false`** döndürüyor: beyan yıkıcı işlem açamıyor.

## Testler

`tests/offdevice-usb-topology.test.ts` (35) + `tests/offdevice-cleanup-gate.test.ts` (20) —
**55/55 yeşil**.

PASS: DriveType=2 · DriveType=4 · UNC · DriveType=3 + USB + farklı disk + boot/system false.
FAIL: SATA · NVMe · RAID · USB ama aynı fiziksel disk · IsBoot=true · IsSystem=true · disk
çevrimdışı · hedef topolojisi ölçülemedi · kaynak topolojisi ölçülemedi · farklı bölüm ama aynı
fiziksel disk · LOCAL_STANDIN · OPERATOR_ATTESTED yetkilendirmesi · ayrıştırılamayan `Get-Disk`
çıktısının on iki biçimi (birden çok diske yayılan volume dâhil).

```
TYPECHECK  tsc --noEmit      exit 0
LINT       eslint (tüm depo) exit 0
TEST       vitest run        69 dosya / 1438 test / exit 0
```

## Bu turda yapılmayanlar

Yeni dump alınmadı, restore smoke çalıştırılmadı, binding üretilmedi, cleanup çalıştırılmadı.

```
REAL_DB_WRITES          = 0   (Docker motoru kapalı — mas_radar_dev erişilebilir değil;
                               kural gereği başlatılmadı)
P24B_CLEANUP_AUTHORIZED = NO
```

## Dosyalar

`00-real-probe-D.txt` · `01-real-probe-C.txt` · `02-attestation-negative-control.txt`
