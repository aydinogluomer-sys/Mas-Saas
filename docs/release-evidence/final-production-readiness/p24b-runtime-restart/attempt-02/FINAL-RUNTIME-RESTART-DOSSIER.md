# P24B — kontrollü gerçek runtime yeniden başlatma · ATTEMPT 02

**Sonuç: BLOKE. Kontrollü runtime BAŞLATILMADI.**

USB engeli kalktı — §1–§5'in tamamı geçti. Ama başlatma anına gelindiğinde iki yeni kapı
düştü ve ikisi de aynı kökten geliyor: **ana kirli worktree'den bir runtime zaten
başlatılmış ve gerçek veritabanına yazmış.**

Bu operasyon gerçek `mas_radar_dev` üzerine **hiçbir şey yazmadı**.

## §1–§5 · USB rollback aygıtı — PASS

Sürücü harfine güvenilmedi; aygıt fiziksel kimliğinden çözüldü.

```
disk 1 · BusType USB · IsBoot false · IsSystem false · Online
240057409536 bayt · 'Min Yi U YZWY_TECH' · seri 020987654321
harf→disk eşlemesi ÖLÇÜLDÜ:  C: → disk 0 (RAID, boot, system)   D: → disk 1 (USB)
nitelikli USB adayı: 1        samePhysicalDisk: false
classifier: USB_PHYSICAL_VOLUME · offDeviceSatisfied true · cleanupGrade true
```

Yedek, göreli konumdan (`MAS-Backups\p24b-final`) fiziksel olarak doğrulanmış birim
üzerinde bulundu:

```
D:\MAS-Backups\p24b-final\mas_radar_dev-p24b-final-2026-08-31T10-01-14-531Z.dump
1.413.949 bayt EŞLEŞTİ · sha256 fe63481887b7937d… EŞLEŞTİ
üç bağımsız okuma: coreutils · PowerShell Get-FileHash · konteyner içi (kopya sonrası)
pg_restore --list exit 0 · 1387 TOC girdisi (makbuzdaki sayıyla birebir)
```

Makbuz ve binding **yeniden yazılmadı**. Kimlik kapısı içerik (sha256 + bayt); fiziksel
konum ise yeniden ölçüldü. Bu turda harf yine `D:` çıktı, ama karar harften türetilmedi.
C:'deki staging kopya bu kapıyı açmak için **kullanılmadı**.

## §6–§7 · Clean RC — PASS

```
C:\Users\Trade Bilisim\Mas-Saas-RC-c71366a
HEAD c71366a… · detached · git status BOŞ · tracked diff 0 · remote EŞLEŞTİ
env dosyası sha attempt-01 ile aynı (2d71fcf8…) → §7 gereği kalite sonuçları yeniden kullanıldı
typecheck PASS · lint PASS · vitest 66/1428 PASS · build PASS
```

## §9 · Quiescence — FAIL

```
port 3000  DİNLİYOR   PID 18996 · node.exe · başlangıç 2026-09-03 12:28:16
komut      next start
binary     C:\Users\Trade Bilisim\Mas Saas altındaki node_modules
üst süreç  cmd /c tsx runtime-port-guard --start && tsx prepare-runtime && next start
büyük üst  pnpm start
```

> Bu runtime **ana kirli worktree'den** başlatılmış, yetkilendirilmiş RC'den değil. Yani
> `c71366a`'yı değil, commit edilmemiş Telegram / middleware / env değişikliklerinizi içeren
> ağacı çalıştırıyor. Bu operasyon onu başlatmadı ve **sonlandırmadı** — sizin başlattığınız
> bir sunucuyu sormadan kapatmak bu mesajın yetkisi dışında.

## §8 · Pre-start baseline — DRIFT

Yukarıdaki startup gerçek veritabanına yazdı:

```
                      BEKLENEN     ŞİMDİ
payment_instances     485          502     (+17)
audit_logs            736          762     (+26)
WHOLE_DB_FP           a8f90e34…    43da2d0d…
```

### Kapsam: 86 tablodan 2'si

```
DEĞİŞEN            audit_logs · payment_instances
DEĞİŞMEYEN         payments · action_items · approvals · users · settings · metric_snapshots
BEKLENMEYEN        yok (0)
P24B kalıntı       0/42 — DEĞİŞMEDİ · TARGET_FP 5e846346… aynı
```

Motorun kendi sayacı da aynı hikâyeyi anlatıyor:

```
tup_inserted 2 → 45   (+43 = 26 audit + 17 instance)
tup_updated 24 → 40   (+16 = refreshRiskFlags bakımı)
tup_deleted 42 → 42   (+0)
```

## +17 neden oldu — ve neden sizin sözleşmeniz bayattı

Sözleşme *"payment_instances 485 kalmalı, yeni instance 0"* diyordu. Bu beklenti klon
ölçümünden geliyordu; klon ölçümü **ay dönüşünden önce** yapılmıştı.

`ensureWindow` (src/lib/radar/engine.ts:434):

```
m0 = bugünün ayının 1'i;  delta = -1 … 24;  her ay için generate_instances
→ 26 iterasyon = 26 audit satırı (bilinen P1)
```

```
klon RUN1+RUN2   2026-08-31 → m0 2026-08-01 → ufuk 2028-08 → veri zaten doluydu → 0 yeni
gerçek startup   2026-09-03 → m0 2026-09-01 → ufuk 2028-09 → bu ay hiç üretilmemişti → 17 yeni
```

17 satırın tamamı `2028-09-03 .. 2028-09-30` vadeli, 17 ayrı yinelenen ödemeye ait, hepsi
`unpaid`. Önceki en büyük vade `2028-08-30` idi.

> Bunu kusur olarak raporlamıyorum: **deterministik, doğru takvim davranışı.** Fixture
> dirilmesi değil, veri bozulması değil. Bayat olan şey beklenen sayıydı, veritabanı değil.

## Bu turda yapılmayanlar

```
kontrollü runtime başlatma   HAYIR (§8 drift + §9 quiescence)
çalışan runtime'ı sonlandırma HAYIR (yetki dışı — karar sizin)
gerçek DB'ye yazma            HAYIR (bu operasyondan 0 DML)
yedeği/makbuzu değiştirme     HAYIR
sahte makbuz üretme           HAYIR
yeni cleanup / manuel SQL     HAYIR
code patch (P1 dahil)         HAYIR
görsel baseline güncelleme    HAYIR
attempt-01 kanıtını ezme      HAYIR
ana worktree'ye müdahale      HAYIR
```

## Üretilmeyen kanıt dosyaları

`03-startup-log-sanitized.txt` · `05-health.json` · `06-core-smoke.json` ·
`07-rbac-smoke.json` · `08-post-start-p24b.json` · `09-final-state.json` — hepsi kontrollü
runtime'ın açılmış olmasını gerektiriyor. Tahmini sürüm yazmak kanıt zincirini kirletirdi.

## Çözüm

```
1. Ana worktree'den başlatılan runtime'ı durdurun (PID 18996 / 'pnpm start' terminali).
2. Yeni baseline'ı kabul edin:
   payment_instances 502 · audit_logs 762
   WHOLE_DB_FP 43da2d0d7d041f21f43d713b676691376ffab470a6ad614ceef5657546f7cd85
3. Kontrollü turu yeniden yetkilendirin. prepare-runtime 2026-09 penceresini dolu bulacağı
   için beklenen delta yeniden 'audit +26, yeni instance 0' olur.
```

```
RUNTIME_CODE_SHA        c71366a775be079e61d9f842a8659cbc2caa9499 (başlatılmadı)
CONTROLLED_RUNTIME      NOT STARTED
REAL_DB_WRITES_BY_OP    0
P1_AUDIT_AMPLIFICATION  OPEN
VISUAL_BASELINE         PENDING MANUAL REVIEW
```
