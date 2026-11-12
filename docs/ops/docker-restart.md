# ARŞİV BİLDİRİMİ (EMEKLİYE AYRILDI / DEPRECATED) — Eski Konteyner Yeniden Başlatma Kılavuzu

> [!WARNING]
> **BU KILAVUZ KULLANIM DIŞIDIR (RETIRED ARCHIVE NOTICE — Faz 39 / Faz 59).**
>
> MAS Nakit Radar mimarisinden konteyner katmanı tamamen kaldırılmıştır. Kanonik veritabanı,
> doğrudan Windows üzerinde yerel olarak çalışan **PostgreSQL 16** kümesidir (`C:\MAS\pgsql16\bin`,
> veri dizini `C:\MAS\pgdata16`, port `127.0.0.1:5432`, Windows hizmeti `MAS-PostgreSQL16` /
> `postgresql-x64-16`).
>
> Bu dosya yalnızca geçmiş sürüm kanıt belgelerindeki dosya bağlantılarının kırılmaması amacıyla
> salt-okunur yönlendirme sayfası olarak korunmaktadır ve hiçbir konteyner komutu içermez.

---

## Geçerli Operasyon Kılavuzları

Veritabanı hizmetini kontrol etmek, başlatmak, durdurmak veya uygulamayı ayağa kaldırmak için aşağıdaki güncel kılavuzları kullanın:

1. **Yerel PostgreSQL 16 Hizmet Yönetimi (`MAS-PostgreSQL16` / `postgresql-x64-16`):**
   - [postgres-service.md](postgres-service.md)
2. **Uygulamayı ve Arka Plan İşçisini Başlatma:**
   - [start.md](start.md)
3. **Uygulamayı Güvenle Durdurma:**
   - [stop.md](stop.md)
4. **Yedek Alma ve Harici Yedek Doğrulama (`pnpm ops:backup:daily`, `pnpm backup:offdevice:verify`):**
   - [backup.md](backup.md) · [backup-schedule.md](backup-schedule.md)
5. **Acil Durum ve Geri Yükleme:**
   - [incident.md](incident.md) · [restore.md](restore.md)
