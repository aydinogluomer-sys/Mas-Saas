# MAS Nakit Radar v5 — Nihai Sürüm Hazırlık ve Klon Göç Provası Panosu (`Faz 39` – `Faz 56`)

```text
WORKING COMMIT         : 9bc77bc (9bc77bc52cfa7714d2c053c990803e8652fe2b74)
TARGET DATABASE CLASS  : DISPOSABLE_CLONE (gerçek üretim yedeği geri yüklemesi)
CLONE DATABASE NAME    : mas_radar_v5_rc_clone (prova sonunda düşürüldü)
CANONICAL DB TOUCHED   : NO — mas_radar_dev'e hiç bağlanılmadı
APP ROLE PASSWORD RESET: NO — 'mas_radar_app' kimliği korundu
ISOLATED BUILD DIR     : .next-v5-rehearsal
SOURCE SNAPSHOT        : backups\daily-2026-11-11T00-00-20-222Z.dump (2359161e90a471f9dbaf6d43e0210b7841cdf5da76db69eebb3ffb6f18a46d10)
SCHEMA MIGRATION PATH  : 96/0096 -> 108/0108
RUN STARTED            : 2026-11-11T15:54:22.900Z
RUN FINISHED           : 2026-11-11T15:57:00.582Z
OVERALL STATUS         : VERIFIED PASS (18/18 FAZ TAMAMLANDI)
```

## 1. Klon Göç Provası (`v5-clone-rehearsal.ts`) Kontrol Sonuçları

| Aşama | Kontrol | Beklenen | Gerçek | Sonuç |
|---|---|---|---|---|
| `step0` | mas_radar_app küme parolası sıfırlanmadı (mevcut runtime kimliği korundu) | `pnpm db:app-role:password çağrılmaz` | `mas_radar_app@mas_radar_v5_rc_clone` | **PASS** |
| `step0` | hedef veritabanı harcanabilir klon (mas_radar_dev'e sıfır bağlantı) | `mas_radar_v5_rc_clone (disposable)` | `mas_radar_v5_rc_clone` | **PASS** |
| `step1` | gerçek yedek arşivi diskte mevcut | `backups\daily-2026-11-11T00-00-20-222Z.dump` | `mevcut` | **PASS** |
| `step1` | yedek arşivi SHA-256 bütünlüğü | `2359161e90a471f9dbaf6d43e0210b7841cdf5da76db69eebb3ffb6f18a46d10` | `2359161e90a471f9dbaf6d43e0210b7841cdf5da76db69eebb3ffb6f18a46d10 (1440906 bayt)` | **PASS** |
| `step1` | pg_restore --list TOC doğrulaması | `> 0 TOC girdisi` | `1406 TOC girdisi` | **PASS** |
| `step1` | göç öncesi şema defteri (96/0096) | `96/0096` | `96/0096` | **PASS** |
| `step2` | scripts/db/migrate.ts çıkış kodu = 0 | `0` | `0` | **PASS** |
| `step2` | göç sonrası şema defteri = 108 / 0108 | `108/0108` | `108/0108` | **PASS** |
| `step2` | temel iş tablosu korunumu: payments | `19 satır, hash=b57642e6e2` | `19 satır, hash=b57642e6e2` | **PASS** |
| `step2` | temel iş tablosu korunumu: payment_instances | `519 satır, hash=f7f0d44878` | `519 satır, hash=f7f0d44878` | **PASS** |
| `step2` | temel iş tablosu korunumu: checks | `7 satır, hash=5e05e1fdce` | `7 satır, hash=5e05e1fdce` | **PASS** |
| `step2` | temel iş tablosu korunumu: loans | `1 satır, hash=25a974fbbb` | `1 satır, hash=25a974fbbb` | **PASS** |
| `step2` | temel iş tablosu korunumu: loan_installments | `48 satır, hash=6ea1679b9b` | `48 satır, hash=6ea1679b9b` | **PASS** |
| `step2` | temel iş tablosu korunumu: cashflow_months | `35 satır, hash=e1aee2583a` | `35 satır, hash=e1aee2583a` | **PASS** |
| `step2` | tüm public görünümlerde security_invoker = true | `87/87 (≥ 87)` | `87/87` | **PASS** |
| `step3` | db:roles-rls:verify (87 görünüm + tüm tablolar + 5 katman RLS) | `exit 0` | `exit 0` | **PASS** |
| `step3` | db:constraints:verify (tüm CHECK/FK/tetikleyici kısıtları) | `exit 0` | `exit 0` | **PASS** |
| `step4` | kritik CFO ve Yönetim Defteri görünümleri gerçek veri klonunda hatasız çalışıyor | `9/9 görünüm OK` | `9/9 görünüm OK` | **PASS** |
| `step4` | Birleşik Altın Finansal Doğruluk Paketi (golden-end-to-end-cfo-suite.test.ts) | `exit 0 (0.00 kuruş sapma)` | `exit 0` | **PASS** |
| `step5` | harcanabilir klon 'mas_radar_v5_rc_clone' düşürüldü ve temizlendi | `klon silindi` | `silindi` | **PASS** |

## 2. Temel İş Tabloları Satır Korunumu (Göç Öncesi vs. `0108` Göç Sonrası)

| Tablo | Göç Öncesi Satır (`0096`) | Göç Sonrası Satır (`0108` — Golden Suite Öncesi) | Veri Hash Korunumu |
|---|---:|---:|---|
| `public.payments` | 19 | 19 | **EVET (Birebir Aynı)** |
| `public.payment_instances` | 519 | 519 | **EVET (Birebir Aynı)** |
| `public.checks` | 7 | 7 | **EVET (Birebir Aynı)** |
| `public.loans` | 1 | 1 | **EVET (Birebir Aynı)** |
| `public.loan_installments` | 48 | 48 | **EVET (Birebir Aynı)** |
| `public.cashflow_months` | 35 | 35 | **EVET (Birebir Aynı)** |

## 3. Canlıya Geçiş (`mas_radar_dev`) Kontrol Listesi ve `backup:offdevice:verify` Doğrulaması

1. **Harici Yedek Doğrulama Betiği (`P0-1` / `F-72` — `package.json` Bağlantısı Tamamlandı):**
   - `scripts/ops/verify-offdevice-backup.ts` (`pnpm backup:offdevice:verify`) salt-okunur doğrulayıcısı devreye alındı (veritabanına hiçbir SQL yazmaz; en güncel `.dump` dosyasının boyutunu `> 0`, yaşını `<= 48 saat` ve `pg_restore --list` TOC okunabilirliğini denetler):
     - Günlük yerel sağlık ve geri-dönüş kontrolü: `pnpm backup:offdevice:verify` (`MAS_OFFDEVICE_BACKUP_DIR` takılı değilse `backups/` üzerindeki en taze yedeği doğrular ve `offDeviceConfigured` / `offDeviceReachable` / `offDeviceSatisfied` bayraklarını açıkça raporlar).
     - Fiziksel USB/NAS sürücüsü takılıyken katı harici disk makbuzu: `pnpm backup:offdevice:verify -- --strict-offdevice`.
2. **Windows PostgreSQL Servisi ve Arka Plan İşçisi:** Yerel Windows PostgreSQL 16 servisi (`postgresql-x64-16` / `MAS-PostgreSQL16`) ve `MAS-Background-Worker` zamanlanmış görevi (`pnpm ops:worker:schedule`) aktif olarak çalışmaktadır.
3. **Düz Metin Yedek ve Üretim Kilitleri:** Kök dizindeki eski `.env.local.bak-*` kalıntıları temizlendi (`pnpm exec tsx scripts/check-env.ts` -> `0` hata); `.env.local` içinde `MAS_LOCAL_PASSWORDLESS=0` ve `AI_FORCE_DETERMINISTIC=1` kilitleri doğrulandı.
4. **Aktif Kasa/Banka Açılış Bakiyeleri (`FIN-03`):** `/finance/treasury` ekranında kasa/banka + IBAN CRUD ve otomatik `100/102 ↔ 500.99 Açılış Bilançosu Denkleştirme` yevmiye köprüsü (`0111`) devreye alındı.
5. **Canlı Göç (`0096 -> 0115`):** Göç öncesi tam `.dump` yedeği alınarak `pnpm db:migrate` ile kanonik `mas_radar_dev` veritabanı **`0115`** sürümüne yükseltildi.

## 4. Faz 59 Canlı 360° Denetim Kapanışı (`Migrations 0109..0115`) Özeti

| Doğrulama Kalemi | Canlı / Kod Durumu (`2026-11-12`) | Sonuç |
|---|---|---|
| Kanonik `mas_radar_dev` şema sürümü | `115 / 0115` (`0001..0115` eksiksiz uygulandı) | **PASS** |
| Canlı `public` tablo sayısı ve RLS kapsamı | `106` `public` tablo (`%100` RLS etkin; 3 zombi tablo `0112` ile emekli edildi) | **PASS** |
| Canlı `public` görünüm sayısı ve `security_invoker` | `87 / 87` görünüm (`%100` `security_invoker = true`, `0` açık görünüm) | **PASS** |
| Katı Etkileşim Kapsam Kapısı (`pnpm interaction:gate:strict`) | `2.699 / 2.699 PASS` (`UNTESTED = 0`, `FAIL = 0`, `manifestosuz = 0`) | **PASS** |
| Yedek okunabilirlik doğrulaması (`pnpm backup:offdevice:verify`) | `pg_restore --list` OK (`1871` TOC girdisi, yaş `< 48s`, boyut `> 0`) | **PASS** |
| Operasyon runbook'ları (`docs/ops/*.md` — `17/17` dosya) | Yerel Windows PG16 + Görev Zamanlayıcı (`rg -i "docker exec" docs/ops/` -> `0` eşleşme) | **PASS** |
| Tekil yazıcı yüzeyi kapısı (`tests/writer-surface.test.ts`) | `12 / 12` test başarılı (`verify-offdevice-backup.ts` salt-okunur) | **PASS** |
