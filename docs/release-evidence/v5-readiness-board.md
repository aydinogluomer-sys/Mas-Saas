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

## 3. Canlıya Geçiş (`mas_radar_dev`) Öncesi Sahip Eylemleri Kontrol Listesi

1. **Harici Yedek Diski (`P0-1`):** Harici USB/NAS diskini takıp `.env.local` içine `MAS_OFFDEVICE_BACKUP_DIR` yolunu tanımlayın ve `pnpm backup:offdevice:verify` ile doğrulanmış makbuz alın.
2. **Windows PostgreSQL Servisi:** Yönetici PowerShell üzerinden `scripts\ops\install-postgres-service.ps1` betiğini çalıştırarak `MAS-PostgreSQL16` servisini otomatik kurtarmaya alın.
3. **Eski Düz Metin Yedek ve Bulut Temizliği:** `.env.local.bak-20261029-092503` dosyasını güvenli biçimde silin, eski Supabase bulut projesini kapatın ve `.env.local` içinde `AI_FORCE_DETERMINISTIC=1` ayarını doğrulayın.
4. **Aktif Kasa/Banka Açılış Bakiyeleri (`FIN-03`):** Gerçek veritabanındaki aktif kasa/banka hesaplarının başlangıç açılış bakiyelerini girin.
5. **Canlı Göç Komutu:** Yukarıdaki 4 adım tamamlandıktan sonra `pnpm db:migrate` komutuyla `0097..0108` migration zincirini canlı `mas_radar_dev` üzerine uygulayın.
