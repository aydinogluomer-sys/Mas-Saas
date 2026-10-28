# P1 promotion + clean RC hazırlığı

**P1 düzeltmesi release dalına fast-forward ile alındı. Clean RC hazır. Gerçek MAS start,
port 3000'i tutan ilgisiz bir proje yüzünden BLOKE — o sürece dokunulmadı.**

## Promotion

Fast-forward'dan önce iki şey kanıtlandı:

```
parent(9e23ad7) = c71366a   ·  tek parent  ·  merge commit değil
c71366a, 9e23ad7'nin ATASI  →  fast-forward mümkün
```

Release dalı ana worktree'de checkout ve orada sizin 20 kirli girdiniz var. Bu yüzden
FF'ten önce kesişim ölçüldü:

```
fix'in dokunduğu yol   13
sizin kirli yolunuz    20
ÇAKIŞAN                 0     → FF sizin dosyalarınıza dokunamaz
```

```
git merge --ff-only 9e23ad7
c71366a → 9e23ad7 · parent sayısı 1 (merge commit üretilmedi)
push: c71366a..9e23ad7  (normal, force yok, rebase yok, history rewrite yok)

origin/release  9e23ad78ee65adc9beafb6cf58f6e477b26765bc
local  release  9e23ad78ee65adc9beafb6cf58f6e477b26765bc
ahead/behind    0/0
origin/fix      9e23ad78ee65adc9beafb6cf58f6e477b26765bc
```

FF sonrası kullanıcı dosyalarının hash'leri değişmedi: `.env.example`, `module-tabs.tsx`,
`env.ts`, `middleware.ts`, `bot.py`, `middleware.test.ts`. Kirli girdi sayısı 20 → 20.

## Clean RC

```
C:\Users\Trade Bilisim\Mas-Saas-RC-9e23ad7
HEAD 9e23ad7… · detached · git status BOŞ · tracked diff 0 · untracked app code 0
ana ağaçtan kod TAŞINMADI — yalnız .env.local (gitignored), kopyadan sonra status hâlâ boş
```

## P1 statik sözleşmesi, yeni release kodunda

```
engine.ts:412   if (created > 0) { await audit(...) }          ✓
engine.ts:459   for (delta = -1; delta <= Math.max(1, futureMonths))   ufuk DEĞİŞMEDİ
prepare-runtime.ts:32   ensureWindow(..., 24)                   DEĞİŞMEDİ

c71366a → 9e23ad7 arasında src/ + scripts/ altındaki TÜM fark:
  src/lib/radar/engine.ts                        +27 / −5
  src/lib/radar/generate-instances-audit.test.ts  yeni
risk / RLS / aktör / tarih semantiği: el değmemiş
```

Hedefli P1 testi yeni RC'de **4/4 PASS**.

## Kalite

```
install --frozen-lockfile  exit 0
typecheck PASS · lint PASS · build PASS
vitest SERİ  (--no-file-parallelism):  67/67 dosya · 1432/1432 test · exit 0  → PASS
vitest PARALEL (yüklü makinede):       2 test düşüyor
```

### Düşen iki testi geçiştirmiyorum — ölçtüm

```
tests/dev-reset-safety.test.ts  "bayrak + env: yıkıcı komuta ULAŞILIR…"   timeout 5000ms, süre 9218ms
tests/writer-surface.test.ts    "gerçek veritabanı hedefi --seed ile…"     timeout 5000ms, süre 10926ms
```

İkisi de **assertion değil, zaman aşımı**. Mekanizma: her iki dosya `execFileSync` ile alt
süreç (bash/node script) açıyor ve vitest'in **varsayılan 5000 ms** sınırı altında koşuyor;
`vitest.config.ts`'de veya dosyalarda açık bir `testTimeout` yok. Paralel worker çekişmesi
altında alt süreç açılışı 5 saniyeyi aşıyor.

Kanıt zinciri:

```
1. İki dosya c71366a ile 9e23ad7 arasında BİREBİR AYNI (git diff boş) — P1 dokunmadı
2. İkisi de radar/engine veya audit yolunu hiç kullanmıyor
3. Yalnız bu iki dosya koşulduğunda: her iki worktree'de 21/21 PASS
4. AYNI SHA, P1 worktree'sinde, aynı anlık yük altında: 3 düşme (2 değil)
   → sayının değişmesi zamanlama imzasıdır
5. Seri koşu: 67/67 · 1432/1432 · exit 0
```

Aynı süit bir saat önce, makine boştayken, aynı SHA'da 1432/1432 geçmişti. Şu anda makinede
Elementis-SOTD `next dev` + Playwright/Chrome süreçleri çalışıyor.

**Sonuç: P1'den kaynaklanan bir regresyon değil; `c71366a`'da da var olan bir harness
kırılganlığı.** Takip adayı olarak kaydedildi (o iki dosyanın alt-süreç vakalarına açık bir
`testTimeout` verilmesi). Bu turda yamalanmadı — kod değişikliği yetkisi yok.

## Gerçek veritabanı — salt okunur

```
ledger 0087/87 · 86 tablo · P24B 0/42
action_items 6 · approvals 68 · payment_instances 502 · payments 19 · users 13 · settings 7
task.open 4 · unpaid 13.595.000 TRY · audit_logs 814
WHOLE_DB_FP 85358cfd27767001a3cdf00e1c5979a05d471a409876afc2586567a38432a929
13 beklenen değerin 13'ü tuttu · SAPMA 0
motor sayaçları ins=97 upd=40 del=42 — Attempt-04'ten beri değişmedi
REAL_DB_WRITES_THIS_TURN = 0
```

## USB rollback

```
disk 1 · USB · boot false · system false · Online · 'Min Yi U YZWY_TECH'
kaynak disk 0 (RAID) → samePhysicalDisk false        (harf fiziksel aygıttan çözüldü)
D:\MAS-Backups\p24b-final\mas_radar_dev-p24b-final-2026-08-31T10-01-14-531Z.dump
1.413.949 bayt EŞLEŞTİ · sha fe63481887b7937d… EŞLEŞTİ · pg_restore --list exit 0 · 1387 TOC
```

## Port envanteri

```
3000  DOLU   PID 9640 · node.exe · 2026-09-03 20:06:36
             C:\Program Files\nodejs\node.exe
             <Elementis-SOTD>\node_modules\next\dist\server\lib\start-server.js
             üst süreç PID 37920 — "next dev" (Elementis-SOTD)
             MAS PROJESİ Mİ: HAYIR
3001  BOŞ    3110 BOŞ    3210 BOŞ    3310 BOŞ

MAS runtime süreci: 0
mas_radar_dev bağlantısı: yalnız ölçümün kendi psql'i
```

`runtime-port-guard.ts` her durumda 3000 ve 3001'i kontrol ediyor, dolayısıyla
**REAL MAS START = BLOCKED**.

```
yabancı süreç sonlandırıldı        HAYIR  (§10 — bu prompt o yetkiyi vermiyor)
MAS_ALLOW_PARALLEL_RUNTIME         KULLANILMADI
port-guard kodu değiştirildi       HAYIR
guard bypass yazıldı               HAYIR
```

## Sonraki tur için başlatma planı

```
worktree   C:\Users\Trade Bilisim\Mas-Saas-RC-9e23ad7
code SHA   9e23ad78ee65adc9beafb6cf58f6e477b26765bc
komut      pnpm start

supervision:
  · stdout/stderr kalıcı bir dosyaya sanitize edilerek yazılır; log akışı sürecin ömrü
    boyunca kaybolmaz (Attempt-04'te supervision sahibi ölünce log akışı kesilmişti)
  · başlatılan sürecin PID'i, başlangıç zamanı ve binary yolu kaydedilir
  · start öncesi ve sonrası 86 tablo parmak izi alınır

BEKLENEN STARTUP DELTA — P1 sonrası ilk gerçek açılış:
  payment_instances  502 → 502, INSERT 0
  audit_logs         814 → 814, DELTA 0        (düzeltme öncesinde +26 olurdu)

ön koşul: port 3000 ve 3001 boş olmalı. Yabancı süreci durdurmak SİZİN kararınız.
```

## Kimlikli smoke planı

```
gerçek DB'ye test kullanıcısı eklenmedi        credential istenmedi
A) kendi tarayıcınızda manuel login + salt-okunur smoke, sonuç checklist'e kaydedilir
B) kimlik yalnız yerel geçici bir mekanizmayla verilir; secret evidence/log/sohbete YAZILMAZ
```

## Görsel baseline

```
8 screenshot diff: PENDING MANUAL REVIEW · --update-snapshots kullanılmadı
```
