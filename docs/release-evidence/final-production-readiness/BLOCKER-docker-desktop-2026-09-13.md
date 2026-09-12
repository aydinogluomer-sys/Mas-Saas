# BLOCKER — Docker Desktop kurulumu bozuk (2026-09-13)

**Etkilenen fazlar:** 2.7 (Phase5 verify), 3 (Import V2 core — DB testleri), 6 (Disposable acceptance), 7.1–7.3 (backup/restore), 8 (Cutover). Kod-yalnız işler (2.4, 4, 5, 7.4, 7.5) etkilenmiyor.

## Ölçülen durum

| Kontrol | Sonuç |
|---|---|
| `docker info` | bağlanamıyor — `npipe:////./pipe/dockerDesktopLinuxEngine` yok |
| WSL `docker-desktop` dağıtımı | **Stopped** |
| Docker Desktop süreçleri | çalışıyor (backend 90 MB + 6 GUI süreci) ama VM'i açamıyor |
| Registry `HKLM\SOFTWARE\Docker Inc.\Docker Desktop` | **YOK** |
| Registry `HKCU\...` | **YOK** |
| `resources\wsl\docker-wsl-cli.iso` | **YOK** |
| `resources\linuxkit\docker-desktop.iso` | **YOK** |
| `Docker Desktop.exe` | var, 4.86.0.236216 |
| Hata (backend log, 2026-09-12 22:19) | `initializing engine paths: getting WSL CLI image path: cannot find registry key "SOFTWARE\Docker Inc.\Docker Desktop"` |
| GUI diyaloğu | "An unexpected error occurred" — seçenekler: **Quit** / **Reset to factory defaults** |

**Teşhis:** yarım kalmış güncelleme veya disk temizliği. Program dosyalarının bir kısmı ve registry kaydı gitmiş; exe kalmış. **Bellek sorunu DEĞİL** (ilk varsayımım yanlıştı — 0,26 GB boş RAM ayrı bir kısıt ama Docker'ı durduran bu değil).

## GERÇEK DB VERİSİ SAĞLAM

```text
C:\Users\Trade Bilisim\AppData\Local\Docker\wsl\disk\docker_data.vhdx
  23,8 GB · son yazım 2026-09-05 14:41:36
```

`mas-radar-pg` konteynerinin volume'u bu dosyanın içinde. Docker 5 Eylül'den beri hiç
başarıyla çalışmamış — 6 Eylül yedek başarısızlığının ("DB bağlantısı") sebebi bu.

## ⚠️ YAPILMAMASI GEREKEN

**Docker diyaloğunda "Reset to factory defaults" seçilmemeli.** Bu seçenek `docker_data.vhdx`'i
siler — 23,8 GB, 5 Eylül'den sonraki tüm değişikliklerle birlikte gerçek `mas_radar_dev`.
Yalnız **"Quit"** güvenli.

## Güvenlik ağı

| | |
|---|---|
| Son geçerli yedek | `backups/daily-2026-09-05T00-00-26-552Z.dump` — 1,38 MB, sha256 `ff66a352…` makbuzla eşleşiyor, ledger 87/0087, pg_dump 16.14 |
| Yaş | **8 gün** — plan §7.3 36 saat eşiğini aşıyor → **BACKUP STALE** |
| Off-device kopya | D: (USB) **takılı değil** — son off-device kopya 31 Ağustos (7 Eylül denetimi) |
| VHDX'in kopyası | **YOK** — C: 11 GB boş, dosya 23,8 GB; D: yok. Şu an kopyalanamıyor. |

## Kullanıcının yapması gerekenler — sırayla

1. **USB diski (D:) takın.** Önce `docker_data.vhdx`'in bir kopyasını D:'ye alacağım (23,8 GB — sigortadır).
2. Docker diyaloğunda **"Quit"** basın.
3. Docker Desktop 4.86.0'ı **onarım kurulumu** ile yeniden kurun (https://docs.docker.com/desktop/release-notes/ — aynı sürüm). Kurulum `docker_data.vhdx`'e dokunmaz; yalnız program dosyalarını ve registry'yi geri yazar. **Kaldırıp yeniden kurma** — kaldırma VHDX'i silebilir.
4. Docker açılınca ben doğrularım: `mas-radar-pg` konteyneri, `mas_radar_dev` ledger 87/0087, satır sayıları 5 Eylül makbuzuyla karşılaştırma.

Bu adımlar sistem düzeyinde kurulum gerektirdiği için ben yapmıyorum.

## Bu blokajın kapanma kriteri

```text
docker info               = motor sürümü döner
mas-radar-pg              = Up
mas_radar_dev ledger      = 87/0087
users/payments/checks     = 5 Eylül makbuzu ile tutarlı (± açıklanabilir delta)
docker_data.vhdx kopyası  = D:'de, sha256 eşleşiyor
```
