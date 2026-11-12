# P24B — kontrollü gerçek runtime yeniden başlatma · ATTEMPT 04

**Runtime clean `c71366a` RC'den ayağa kalktı ve açık bırakıldı.**

Ölçülebilen her kapı geçti. İki kapı — kimlikli core smoke ve tier bazlı RBAC — **kısmi**
kaldı; sebebini aşağıda tam olarak yazıyorum, PASS diye göstermiyorum.

```
RUNTIME_CODE_SHA  c71366a775be079e61d9f842a8659cbc2caa9499
ÇALIŞAN SÜREÇ     PID 7132 · başlangıç 2026-09-03 13:27:13
BINARY            C:\Users\Trade Bilisim\Mas-Saas-RC-c71366a\node_modules\...\next start
```

## Startup deltası — sözleşmeyle birebir

```
audit_logs          788 → 814      +26, tamamı generate_instances
payment_instances   502 → 502      INSERT 0 · UPDATE 0
users               13  → 13
payments / action_items / approvals / settings / metric_snapshots   hepsi 0
P24B                0/42 → 0/42    fixture ödemesi yok
```

86 tablo karşılaştırıldı, **tam 1 tanesi değişti**:

```
public.audit_logs   788:7891790aa6eb4005…  →  814:2ca0bf190659b61f…
BEKLENMEYEN DEĞİŞEN TABLO: 0
```

Motorun kendi sayacı da aynı şeyi söylüyor:

```
tup_inserted 71 → 97   (+26 = tam olarak audit satırları)
tup_updated  40 → 40   (+0)
tup_deleted  42 → 42   (+0)
```

Sözleşme `payment_instances` üzerinde deterministik bir risk-flag UPDATE'ine izin veriyordu
("tercihen 0"). Ölçülen **0** — update sayacı hiç kımıldamadı.

## Ön kapılar

```
REMOTE SHA        c71366a… EŞLEŞTİ
CLEAN RC          HEAD c71366a… · detached · git status BOŞ · tracked diff 0
BUILD PROVENANCE  BUILD_ID tb2-ettRZ5LMTU5279w98 · bu RC'de, bu SHA'da üretildi
                  başka worktree'den taşınmadı · .env.local sha'sı build'den beri aynı
QUIESCENCE        3000/3001/3110/3210/3310 boş · Next 0 · prepare-runtime 0
                  bot/worker/scheduler 0 · beklenmeyen yazıcı 0
USB ROLLBACK      disk 1 · USB · boot false · system false · Online
                  samePhysicalDisk false · 1.413.949 bayt · sha fe63481887b7937d…
                  harf yine fiziksel aygıttan çözüldü, makbuz yeniden yazılmadı
```

### Yetkilendirdiğiniz baseline, start öncesi doğrulandı

```
                       YETKİLENDİRİLEN                ÖLÇÜLEN
payment_instances      502                            502        ✓
audit_logs             788                            788        ✓
WHOLE_DB_FP            283e5daa…                      283e5daa…  ✓
ayrıca: ledger 0087/87 · 86 tablo · P24B 0/42 · 6/68/19/13/7
        task.open 4 · unpaid 13.595.000 · atilla md5 3dfbb36e…   hepsi ✓
YETKİDEN BU YANA SAPMA: 0
```

## Sağlık

```
/ready 200 · /login 200 · /version 200
Ready in 34.8s · fatal 0 · uncaught 0 · DB auth hatası 0 · migration hatası 0 · 5xx 0
```

## Core read smoke — KISMİ, ve nedenini saklamıyorum

Ölçülen ve **kanıtlanan**:

```
15 rota yanıt verdi · 5xx: 0 · bozuk rota: 0 · yönlendirme döngüsü: 0
korumalı rotaların hepsi 1–2 hop içinde /login?next=… adresine indi, orada 200
/overview → /login?next=%2Foverview          /calendar → /login?next=%2Fpayments%2Fcalendar
/data-quality → /login?next=%2Fdata%2Fquality  /admin → /login?next=%2Fsystem
```

308'ler hata değil: uygulamanın kanonik modül yollarına normalizasyonu.

Ölçül**me**yen: sayfaların **kimlikli** halde render edilmesi, yani gerçek dashboard içeriği.

Neden yapmadım: bu production build'de `MAS_QA_BYPASS_AUTH` etkisiz (`NODE_ENV=production`).
Kanonik görsel harness kimlikli oturum üretmek için `users` tablosuna beş hesap **yazar** —
ve zaten `mas_radar_dev` disposable olmadığı için reddeder. Elimde gerçek bir hesap kimliği
yok. Kimlikli smoke'u tamamlamanın tek yolu gerçek veritabanına yazmaktı; yapmadım.

## RBAC smoke — KISMİ

```
kimliksiz erişim reddi     15/15 rota doğru reddetti · sızan 200: 0
tier bazlı erişim (runtime) ÖLÇÜLMEDİ — yukarıdaki aynı kimlik engeli
birim kapsamı              authz/matrix.test.ts + authz/route-access.test.ts PASS
                           (pinlenmiş RC, vitest 66 dosya / 1428 test)
```

Birim kapsamını runtime kanıtı gibi göstermiyorum; ikisi ayrı şeyler.

## Smoke veritabanına dokunmadı

```
sayaçlar smoke öncesi 97/40/42 · smoke sonrası 97/40/42
audit 814 sabit · payment_instances 502 sabit
```

Kimliksiz istekler middleware katmanında yönlendirildiği için `ensureWindow` çağıran sayfa
gövdelerine hiç ulaşmadı.

## Ortamda kaydedilen risk

VS Code'un Playwright uzantısına ait iki test-server süreci açık:

```
PID 24972  MAS  (node_modules/.pnpm/@playwright+test@1.61.1)  13:11:41
PID 11800  MAS dışı (npm node_modules/@playwright/test)       10:45:34
```

Sonlandırmadım — bu turun yetkisi kontrollü start; VS Code uzantı süreçlerini kapatma yetkisi
verilmedi. İkisi de Next runtime / prepare-runtime / bot / worker / scheduler değil ve
`pg_stat_activity` içinde yazıcı olarak görünmüyorlar. Azaltma: start öncesi 86 tablonun
parmak izi alındı, start sonrası tablo bazında sınıflandırıldı — beklenmeyen bir yazma olsaydı
ölçülürdü, olmadı.

## Attempt-03'teki bir bulgumu düzelttim

Attempt-03'te `tests/visual/global-setup.ts:167`'deki `?? process.env.DATABASE_URL`
fallback'ini "gerçek DB'ye yazabilir" diye P1 adayı olarak işaretlemiştim. **Fazla ağırdı.**
14 satır sonra (`:181`) `isDisposableDatabaseName()` kapısı var; `mas_radar_dev`
`PROTECTED_DB_NAMES` içinde olduğu için `Pool` açılmadan hata fırlıyor. Gerçek şiddet düşük,
kod değişikliği gerekmiyor. Attempt-03 dosyaları düzeltildi.

## Operasyon durumu

```
P1_AUDIT_AMPLIFICATION   OPEN  (kod değiştirilmedi — §22)
VISUAL_BASELINE          PENDING MANUAL REVIEW (§23, snapshot güncellenmedi)
USB_BACKUP_RETAINED      YES
RUNTIME_LEFT_RUNNING     YES — PID 7132, clean c71366a RC
ANA WORKTREE             dokunulmadı (dosya hash'leri ve HEAD aynı)
GERÇEK DB YAZMASI        yalnız sözleşmedeki +26 audit satırı
```
