# P1 — prepare-runtime `generate_instances` audit amplification · düzeltme

**Kusur kapandı. Gerçek `mas_radar_dev` üzerine bu turda tek satır yazılmadı.**

Değişen yüzey tek bir koşul: `created > 0`.

## Yetim runtime durduruldu

PID 7132 supervision sahibinden kopmuştu (ağacın kökü olan sarmalayıcı zaten yoktu).
Sonlandırmadan hemen önce kimlik yeniden kanıtlandı:

```
PID 7132 · node.exe · başlangıç 2026-09-03 13:27:13 (önceki gözlemle AYNI → recycle yok)
binary   C:\Users\Trade Bilisim\Mas-Saas-RC-c71366a\...\next start   → clean RC
port 3000 sahibi = 7132 ✓
ağaç: 26548 sh → 12488 pnpm → 15436 cmd → 7132 next   (başka üye yok)
```

Önce graceful denendi ve reddedildi (konsol süreci, `/F` gerekiyor). Ardından yalnız bu ağaca,
açık PID'lerle force:

```
7132 SUCCESS · 15436 zaten çıkmış · 12488 SUCCESS · 26548 zaten çıkmış
port 3000/3110/3210/3310 → dinleyici YOK · Next 0 · prepare-runtime 0 · beklenmeyen yazıcı 0
PostgreSQL/Docker açık bırakıldı · başka hiçbir süreç öldürülmedi
DURDURMANIN ÜRETTİĞİ YAZMA: 0
```

Baseline durdurma sonrası birebir doğrulandı: `502 / 814 / 85358cfd… / 0087/87 / 0-42`.

## Kök neden — çağrı grafiğiyle

```
pnpm start
└─ scripts/prepare-runtime.ts:32   ensureWindow(pool, bugün, actorId, 24)
   └─ engine.ts:434                for (delta = -1; delta <= 24)   → 26 ay
      └─ engine.ts:410             generateInstancesForMonth
         └─ engine.ts:354          generateInstancesForMonthWithClient
            └─ engine.ts:397       audit(...)  ← KOŞULSUZ
```

Gerçek ölçüm (Attempt-04, `mas_radar_dev`): `payment_instances 502 → 502` (INSERT 0, UPDATE 0)
iken `audit_logs 788 → 814`. **İş mutasyonu 0, denetim mutasyonu 26.**

## Düzeltme — §7'nin tercih ettiği minimal semantik

```ts
if (created > 0) {
  await audit(client, { ...aynı payload... });
}
```

`created = 0` → kayıt yok. `created > 0` → kayıt ve payload **bit-bazında eskisiyle aynı**.
§8'deki tek-özet-olay alternatifine gerek kalmadı.

Dokunulmayanlar: ufuk (24 ay), üretim mantığı, risk-flag, tarih/ay semantiği, `audit()`
yardımcısı, aktör kimliği, `runAsSystem`, RLS, P24B kodu.

Kırılabilecek bir sözleşme arandı: `generate_instances` audit **sayısına** bağlı hiçbir test
veya script yok.

## Testin dişleri var — negatif kontrolle kanıtlandı

```
düzeltme YOKKEN (git stash):   3 düştü / 1 geçti
  CASE A  FAIL — beklenen [], gelen 1
  CASE C  FAIL — beklenen [], gelen 26      ← kusurun kendisi
  CASE D  FAIL — beklenen 1, gelen 26
  CASE B  PASS — doğrusu bu; düzeltme denetimi susturmamalı
düzeltme VARKEN:               4/4 geçti
```

Sahte client bilinmeyen SQL görürse fırlatıyor, yani üretim yolu yeni bir sorgu eklerse test
sessizce yanlış bir şey ölçmeye devam etmez.

## Harcanabilir klonlarda kanıt

Guard'lı runner kullanıldı; negatif kontrol olarak `mas_radar_dev` hedeflendiğinde **exit 3 ile
reddedildi**.

```
KLON  mas_radar_p1_audit_fix_verify   (create database ... template mas_radar_dev)
      baseline  pi=502  audit=814

RUN 1  pi 502 → 502 · audit 814 → 814 · yeni instance 0 · AUDIT DELTA 0
RUN 2  pi 502 → 502 · audit 814 → 814 · yeni instance 0 · AUDIT DELTA 0

86 tablo karşılaştırıldı (klon, iki koşudan sonra  vs  gerçek mas_radar_dev):
DEĞİŞEN: 0        klon digest = 85358cfd… = gerçek DB digest
```

İki `prepare-runtime` koşusu klonu kaynak durumundan **bit-bazında ayırt edilemez** bıraktı.
`PREPARE_RUNTIME_FULLY_IDEMPOTENT_FOR_STABLE_STATE = PASS`.

### Pozitif üretim kontrolü — en kritik test

P1'in en büyük riski denetimi tamamen kapatmaktı. Ayrı bir klonda pencerenin son ayı silindi:

```
2028-09-01 ayının 17 satırı silindi → pi 502 → 485
prepare-runtime çalıştırıldı
pi 485 → 502 (17 satır geri üretildi)
audit 814 → 815 = TAM 1 satır          (26 değil, 0 değil)
payload: {"total": 17, "created": 17, "monthStart": "2028-09-01"}
```

Düzeltme denetimi susturmuyor — dürüstleştiriyor.

## Kalite

```
pnpm install --frozen-lockfile   exit 0
typecheck PASS · lint PASS · build PASS
vitest 67 dosya / 1432 test PASS   (öncesi 66 / 1428 → +1 dosya, +4 test = tam olarak P1)
regresyon: 0
güvenlik matrisi (harcanabilir klonda): 17/17 PASS
  RLS 47 tabloda açık · oturum/rol semantiği · getRawPool sınırlaması
  30/30 server action kimlik doğrulaması · mutasyon yapan rotalarda checkOrigin
aktör kimliği / runAsSystem / RLS semantiği: DEĞİŞMEDİ
```

## Gerçek kaynak, tur sonu

```
payment_instances 502 · audit_logs 814 · P24B 0/42 · ledger 0087/87 · 86 tablo
task.open 4 · unpaid 13.595.000 · WHOLE_DB_FP 85358cfd27767001a3…
motor sayaçları tur başı 97/40/42  ==  tur sonu 97/40/42
REAL_DB_WRITES_THIS_FIX_TURN = 0
```

Port 3000'de bir dinleyici var ama **MAS değil**: `Elementis-SOTD` projesinin `next dev`
sunucusu (PID 6816). `mas_radar_dev`'e dokunmuyor — motor sayaçları ve `pg_stat_activity`
bunu gösteriyor. Farklı bir proje olduğu için müdahale edilmedi.

## Bu turda yapılmayanlar

```
gerçek runtime yeniden başlatma   HAYIR (§19)
gerçek DB'ye yazma                HAYIR
manuel DB düzeltme / cleanup      HAYIR
ana worktree'ye dokunma           HAYIR
RC runtime worktree'sinde patch   HAYIR (ayrı temiz worktree kullanıldı)
release branch'ini güncelleme     HAYIR (ayrı dal)
yedek/makbuz silme                HAYIR
```

```
P1_AUDIT_AMPLIFICATION   FIXED
MAS_RUNTIME_RESTARTED    NO
READY_FOR_CODE_REVIEW    YES
```
