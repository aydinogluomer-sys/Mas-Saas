# P24B — kontrollü runtime yeniden başlatma · ATTEMPT 03

**Yetkilendirilen iki işten biri yapıldı, ikincisi bloke edildi.**

```
YETKİ 1  unpinned runtime'ı kontrollü durdur      → YAPILDI, PASS
YETKİ 2  clean c71366a RC'den tek kontrollü start → YAPILMADI (§5 DRIFT)
```

Bu operasyon gerçek `mas_radar_dev` üzerine **hiçbir şey yazmadı**.

## §2–§4 · Unpinned runtime durduruldu — PASS

Sonlandırmadan hemen önce kimlik yeniden kanıtlandı; PID geri dönüşümü olmadığı gösterildi.

```
PID 18996 · node.exe · başlangıç 2026-09-03 12:28:16 (önceki gözlemle AYNI)
port 3000 sahibi = 18996 ✓   komut: next start (ana worktree node_modules)
ağaç: 14924 pnpm start → 29856 cmd → 18996 next start   (başka üye yok)
sınır: 14924'ün üstü PID 12680 = VS Code terminaliniz → DOKUNULMADI
```

Önce graceful denendi ve **reddedildi** — konsol sürecinde beklenen davranış:

```
taskkill /PID 14924 /T        exit 128
  "This process can only be terminated forcefully (with /F option)"
```

Ardından yalnız doğrulanmış ağaca, **açık PID'lerle** (isim/joker yok) force:

```
18996 → SUCCESS    29856 → not found (çocuğu ölünce kendi çıkmıştı)    14924 → SUCCESS
port 3000/3001/3110/3210/3310 → dinleyici YOK
Next runtime 0 · prepare-runtime 0 · bot/worker/scheduler 0
hayatta kalan node süreci 18 · terminaliniz 12680 ayakta · Postgres konteyneri açık
YAN HASAR: YOK
```

## §8 · USB rollback — PASS

```
disk 1 · USB · IsBoot false · IsSystem false · Online · 'Min Yi U YZWY_TECH'
kaynak disk 0 (RAID, boot, system) → samePhysicalDisk false
D:\MAS-Backups\p24b-final\mas_radar_dev-p24b-final-2026-08-31T10-01-14-531Z.dump
1.413.949 bayt EŞLEŞTİ · sha256 fe63481887b7937d… EŞLEŞTİ
pg_restore --list exit 0 · 1387 TOC girdisi
```

Harf yine fiziksel aygıttan çözüldü; makbuz ve binding yeniden yazılmadı.

## §9–§10 · Clean RC ve build provenance — PASS

```
C:\Users\Trade Bilisim\Mas-Saas-RC-c71366a
HEAD c71366a… · detached · git status BOŞ · tracked diff 0 · remote EŞLEŞTİ
BUILD_ID tb2-ettRZ5LMTU5279w98
üretildiği yer: bu RC · üretildiği SHA: c71366a · başka worktree'den TAŞINMADI
attempt-01'den bu yana HEAD, git status ve .env.local sha'sı değişmedi
```

## §5 · Baseline doğrulaması — DRIFT (engel)

Pinlediğiniz 13 değerin **12'si birebir tuttu**. Bir tanesi tutmadı:

```
                          BEKLENEN     ÖLÇÜLEN
LEDGER                    0087/87      0087/87      ✓
BASE_TABLE_COUNT          86           86           ✓
P24B                      0/42         0/42         ✓
action_items              6            6            ✓
approvals                 68           68           ✓
payment_instances         502          502          ✓
payments                  19           19           ✓
users                     13           13           ✓
settings                  7            7            ✓
task_status.open          4            4            ✓
payment_status.unpaid     13.595.000   13.595.000   ✓
audit_logs                762          788          ✗  (+26)
WHOLE_DB_FP               43da2d0d…    283e5daa…    ✗  (yalnız audit_logs yüzünden)
```

§5 açıkça *"yeni baseline'i otomatik güncelleme, exact drift raporla ve DUR"* diyor.
Baseline'ı kendiliğimden kabul etmedim ve runtime'ı başlatmadım.

### Sapmanın kaynağı

```
2026-09-03 10:07:07–10:07:10 UTC (13:07 yerel)
26 satır · action=generate_instances · actor=system · payment_instances etkisi 0
```

26 satırlık imza `ensureWindow(..., 24)` döngüsüne (delta −1..24) aittir. Repoda bu imzayı
üreten yalnız iki çağrı var: `scripts/prepare-runtime.ts:32` ve `scripts/seed-demo.ts:90`.

- **seed-demo elendi** — başka tablolara da yazardı; 86 tablodan yalnız `audit_logs` değişti.
- **Sayfa görüntülemesi elendi** — uygulama sayfaları `ensureWindow`'u varsayılan
  `futureMonths = 1` ile çağırır (3 satır) ve audit aktörü olarak `session.id` geçer.
  Bu parti 26 satır ve `actor = system`.

Yani: **bir `prepare-runtime` çalıştırması.** Kimin başlattığını uydurmuyorum — mevcut
kanıtla kesinleştiremedim. O anda port 3000 PID 18996'daydı ve `runtime-port-guard` bu
durumda zinciri keser; dolayısıyla çağrı ya guard atlanarak (`MAS_ALLOW_PARALLEL_RUNTIME=1`)
ya da doğrudan `tsx scripts/prepare-runtime.ts` ile yapılmış olmalı. **Bu operasyon yapmadı**:
bu turda çalışan her şey ya salt-okunur ölçüm ya da yetkilendirilmiş `taskkill`.

Zaman örtüşmesi olarak kaydediyorum, nedensellik iddia etmiyorum: aynı dakikada (13:07:00)
VS Code Playwright uzantısının **MAS için** açtığı bir test-server süreci başladı
(PID 12788, `@playwright/test@1.61.1` — MAS'ın sürümü). Sonradan kendiliğinden kapandı.

## §6–§7 · Yeni verinin meşruiyeti — PASS

Baseline kabul edilmese de, içindeki yeni verinin temiz olduğunu ölçtüm.

```
§6  17 satır · tek ay 2028-09 · vade 2028-09-03 .. 2028-09-30
    17 AYRI yinelenen ödeme · kaynak ödemelerin 17/17'si 'active'
    hepsi 'unpaid' · fixture bağı 0 · (payment_id, instance_month) mükerreri 0
§7  09:28 partisi 26 satır, tamamı generate_instances
    10:07 partisi 26 satır, tamamı generate_instances
    cleanup'tan bu yana generate_instances DIŞINDA audit olayı: 0
```

P24B hâlâ 0/42, hedef parmak izi `5e846346…` değişmedi, ATILLA satır hash'i
`3dfbb36eecd822aad1aefbf34a736b21` cleanup sonrasıyla aynı.

## ~~Ayrıca bulundu — ayrı bir P1 adayı~~ → DÜZELTİLDİ (attempt-04)

> **Bu bölümdeki ilk değerlendirme fazla ağırdı ve geri alındı.** Aşağıdaki fallback gerçekten
> var, ama gerçek veritabanına yazamaz.

`tests/visual/global-setup.ts:167`

```js
const dbUrl = process.env.MAS_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
```

İlk raporda bunu "MAS_E2E_DATABASE_URL yoksa gerçek `mas_radar_dev`'e düşer ve users
tablosuna yazar" diye P1 adayı olarak işaretledim. **Yanlıştı.** Aynı dosyada, 14 satır
sonra ikinci bir kapı var:

```js
// global-setup.ts:181
if (!isDisposableDatabaseName(databaseNameFromUrl(dbUrl))) {
  throw new Error("GÜVENLİK DURDURMASI: … disposable görünmüyor.");
}
```

`mas_radar_dev`, `scripts/db/owner-url.ts` içindeki `PROTECTED_DB_NAMES` listesindedir;
`isDisposableDatabaseName` false döner ve hata **`Pool` açılmadan önce** fırlar. Tek satır
yazılamaz. Gerçek şiddet: **düşük, fail-closed korunuyor, kod değişikliği gerekmiyor.**

Geriye kalan tek nokta kozmetik: fallback zinciri okuyana "gerçek DB'ye yazabilir"
izlenimi veriyor, asıl koruma aşağıda. Bu bir davranış kusuru değil, okunabilirlik notu.

## Bu turda yapılmayanlar

```
kontrollü runtime başlatma       HAYIR (§5 DRIFT)
baseline'ı otomatik kabul etme   HAYIR (§5 açıkça yasaklıyor)
gerçek DB'ye yazma               HAYIR
manuel DB düzeltme / cleanup     HAYIR
code patch (P1'ler dahil)        HAYIR
görsel baseline güncelleme       HAYIR
yedeği/makbuzu değiştirme        HAYIR
attempt-01/02 kanıtını ezme      HAYIR
ana worktree'ye müdahale         HAYIR
hedef ağaç dışında süreç öldürme HAYIR
```

## Çözüm

Kalıcı çözüm sapmanın kaynağını kapatmaktan geçiyor — yoksa her turda baseline yeniden kayar:

```
1. Gerçek mas_radar_dev'e prepare-runtime çalıştırabilen ikinci bir yolu kapatın
   (VS Code Playwright test-server / açık terminal / MAS_ALLOW_PARALLEL_RUNTIME).
2. Yeni baseline'ı yetkilendirin:
   payment_instances 502 · audit_logs 788
   WHOLE_DB_FP 283e5daaf36b1f26293a1a6d6a7cbce435b64767fcaf8afbaaee626893bc4b42
3. Turu yeniden yetkilendirin. Beklenen delta: audit 788 → 814 (+26), yeni instance 0.
```

```
RUNTIME_CODE_SHA        c71366a775be079e61d9f842a8659cbc2caa9499 (başlatılmadı)
UNPINNED_RUNTIME        STOPPED
CONTROLLED_RUNTIME      NOT STARTED
REAL_DB_WRITES_BY_OP    0
P1_AUDIT_AMPLIFICATION  OPEN
VISUAL_BASELINE         PENDING MANUAL REVIEW
```
