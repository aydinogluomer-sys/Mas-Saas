# Final supervised MAS runtime start — release `f076431`

**Runtime ayakta, supervised, kalıcı loglarla — ve gerçek veritabanına TEK BİR SATIR yazmadan.**

Bu turun asıl kanıtı budur: P1 düzeltmesinden sonra ilk gerçek açılış **sıfır delta** üretti.
Düzeltme öncesinde aynı açılış +26 `generate_instances` satırı yazıyordu.

```
RUNTIME_RELEASE_SHA   f076431152127dc4a337e0bb55b73ade3f85821b
APPLICATION_FIX_SHA   9e23ad78ee65adc9beafb6cf58f6e477b26765bc
RUNTIME_PID           4640   ·   SUPERVISOR_PID 24868   ·   başlangıç 22:08:01
BUILD_ID              Cohj3w6Ho71WHFNjyzJlU  (bu RC içinde taze üretildi)
```

## Release provenance

```
origin/release   f076431…  EŞLEŞTİ
parent(f076431)  9e23ad7…  EŞLEŞTİ
9e23ad7 → f076431 arasında src/ + scripts/ farkı:  BOŞ
toplam değişiklik: 9 dosya, 756 ekleme — hepsi docs/release-evidence altında
```

Yani çalışan kod davranışı `9e23ad7` ile aynı; deployment provenance yine de `f076431`
olarak tutuldu ve build bu SHA'nın worktree'sinde sıfırdan üretildi.

## Clean RC ve build

```
C:\Users\Trade Bilisim\Mas-Saas-RC-f076431
HEAD f076431… · detached · git status BOŞ · tracked diff 0 · untracked app code 0
ana ağaçtan kod TAŞINMADI (yalnız .env.local, gitignored)
eski 9e23ad7 RC deployment için KULLANILMADI
.next silinip yeniden üretildi → BUILD_ID Cohj3w6Ho71WHFNjyzJlU

typecheck PASS · lint PASS · build PASS
P1 hedefli test 4/4 PASS
vitest SERİ: 67/67 dosya · 1432/1432 test PASS
```

## Supervision — Attempt-04'ün hatası tekrarlanmadı

Attempt-04'te runtime bir arka plan görevinin kabuk sarmalayıcısı altında başlatılmıştı;
görev sonlandırılınca Next süreci yetim kaldı ve log akışı koptu.

Bu kez reponun kendi `mas-daily-backup.cmd` desenini izleyen bir `.cmd` sarmalayıcı
kullanıldı: **yönlendirmeyi cmd.exe'nin kendisi yapıyor**, dosya tanıtıcıları sürecin
kendisine ait, araya log okuyan ayrı bir süreç girmiyor.

**Mekanizmayı gerçek runtime'dan ÖNCE kanıtladım.** Zararsız bir probe süreçle:

```
launcher PowerShell 17232  →  probe 37636
launcher öldükten sonra probe:  YAŞIYOR
probe logu:  16 satır → 20 satır  (akış devam etti)
probe temizlendi
```

Gerçek runtime'da aynı davranış:

```
launcher 38852   ÖLDÜ
supervisor 24868 YAŞIYOR   (log tanıtıcılarını tutan süreç)
runtime 4640     YAŞIYOR   binary: Mas-Saas-RC-f076431\node_modules\...\next start
üst süreç 21544  cmd — port-guard && prepare-runtime && next start
```

`pnpm start` semantiği aynen korundu: port guard atlanmadı, prepare-runtime atlanmadı,
`MAS_ALLOW_PARALLEL_RUNTIME` kullanılmadı.

Loglar (gitignored, `/logs/` kuralı):

```
logs\runtime\mas-runtime.out.log
logs\runtime\mas-runtime.err.log
logs\runtime\mas-runtime.supervisor.pid
logs\runtime\mas-runtime.next.pid
```

Kontrollü durdurma prosedürü `05-supervision.json` içinde adım adım yazılı. Supervisor
çıkarken stdout'a `MAS runtime END exit=<kod>` satırını yazar — durdurmanın kanıtı budur.

## Startup — SIFIR DELTA

```
prepare-runtime : "Ödeme penceresi 24 aylık ufukla hazır."
next start      : Next.js 15.5.20 · Ready in 2.4s
```

```
                        ÖNCE      SONRA     DELTA
audit_logs              814       814        0
payment_instances       502       502        0   (INSERT 0, UPDATE 0)
users                    13        13        0
payments                 19        19        0
action_items              6         6        0
approvals                68        68        0
settings                  7         7        0
metric_snapshots        208       208        0

86 TABLO KARŞILAŞTIRILDI · DEĞİŞEN: 0
WHOLE_DB_FP  85358cfd27767001a3cdf00e1c5979a05d471a409876afc2586567a38432a929
             ÖNCE == SONRA
P24B         0/42 → 0/42 · fixture dirilmesi yok
```

Kendi sayımıma güvenmiyorum; motorun kendi sayacı da aynı şeyi söylüyor:

```
pg_stat_database   ins=97 upd=40 del=42   →   ins=97 upd=40 del=42
HİÇ KIMILDAMADI — tek bir tuple bile eklenmedi, güncellenmedi, silinmedi
```

**P1 düzeltmesi gerçek runtime üzerinde doğrulandı.**

## Sağlık ve anonim smoke

```
/ready 200 · /login 200 · /version 200
5xx 0 · fatal 0 · uncaught 0 · DB auth hatası 0 · migration hatası 0
stderr'de yalnız pnpm komut yankısı var — hata değil

16 korumalı rota · 16'sı da doğru şekilde /login?next=… adresine indi ve orada 200
sızan 200: 0 · yönlendirme döngüsü: 0 · en fazla 2 hop
smoke'un ürettiği DB yazması: 0
```

308'ler hata değil, kanonik modül yollarına normalizasyon
(`/data-quality → /data/quality`, `/admin → /system`, `/radar → /payments`).

**Kimlikli tarafı ölçmedim ve PASS diye raporlamıyorum.** `ANONYMOUS_HEALTH = PASS`
ayrı tutuldu.

## Bir eksiği saklamıyorum — `/version` provenance taşımıyor

§15, `/version` üzerinden release ilişkilendirilebilirliği istiyordu. Şu an mümkün değil:

```json
{"commit":"unknown","buildTime":"unknown","env":"production"}
```

Sebep: `APP_COMMIT_SHA` ve `APP_BUILD_TIME` opsiyonel env değişkenleri tanımlı değil, bu
yüzden `env.ts` varsayılan `"unknown"` döndürüyor. Düzeltmek bu değişkenler set edilerek
**yeniden başlatma** gerektirirdi; prompt tek startup istiyor, o yüzden dokunmadım.

Provenance bunun yerine dışarıdan kanıtlandı: sürecin binary yolu `Mas-Saas-RC-f076431`
altında, `BUILD_ID` bu RC'de taze üretildi, worktree HEAD `f076431`. Ayrı bir operasyonel
takip maddesi olarak açık bırakıldı.

## Kimlikli smoke — kullanıcı bekliyor

```
gerçek DB'ye test kullanıcısı eklendi mi   HAYIR
credential istendi / yazıldı / loglandı    HAYIR
```

Checklist `10-manual-smoke-checklist.md` içinde: kendi hesabınızla giriş, on adımlık
salt-okuma turu, her adımda OPENED / NO_5XX / NO_INFINITE_LOADING / DATA_VISIBLE.
Yıkıcı işlem istenmiyor.

## Operasyon durumu

```
P24B                          CLOSED / CLEAN
P1_AUDIT_AMPLIFICATION        CLOSED — gerçek runtime'da doğrulandı
P2_TEST_TIMEOUT_RELIABILITY   OPEN (paralel süitte alt-süreç testleri 5000 ms sınırına takılıyor)
P3_VERSION_PROVENANCE         OPEN (APP_COMMIT_SHA / APP_BUILD_TIME set edilmemiş)
VISUAL_BASELINE               PENDING_MANUAL_REVIEW
USB_BACKUP_RETAINED           YES (sha/bayt/1387 TOC doğrulandı)
RUNTIME_LEFT_RUNNING          YES
FINAL_PRODUCTION_ACCEPTANCE   PENDING_MANUAL_AUTH_SMOKE
```
