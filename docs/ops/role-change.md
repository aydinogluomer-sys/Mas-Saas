# RUNBOOK — role change (rol değiştir · hesap kapat · kilit aç)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (komut gerekiyorsa):** `C:\Users\Trade Bilisim\Mas Saas`
> **Yeni hesap açma:** [user-creation.md](user-creation.md)

---

## PURPOSE

Var olan bir kullanıcı hesabı üzerinde dört işlemden birini yapmak:

| İşlem | Ne işe yarar | Aciliyet |
|---|---|---|
| **Hesabı kapat** (pasifleştir) | Kişi ayrıldı, hesap ele geçirildi, erişim derhal kesilmeli | **ACİL — en üstte** |
| **Rolü değiştir** | Yetki artırma/azaltma | Normal |
| **Kilidi aç** | 5 hatalı girişten sonra 15 dakikalık kilit | Normal |
| **Yeniden aktifleştir** | Kapatılmış hesabı geri açmak | Normal |

**Kullanıcı silinmez.** Denetim izi (`audit_logs`) ve geçmiş kayıtların sahipliği korunmalıdır.

---

## ACİL — hesabı hemen kapat

Şüpheli erişim, ayrılan personel, kaybolan cihaz:

1. Yönetici hesabıyla `http://127.0.0.1:3000/system/security` adresini açın.
2. İlgili kullanıcının satırını bulun.
3. **pasifleştir** düğmesine basın.

Bu tek işlem hem girişi kapatır hem de `public.sessions` üzerindeki admin RLS politikası (Migration `0098`) sayesinde o kullanıcının **açık oturumlarını anında iptal eder**.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Uygulama ayakta | `curl.exe -s http://127.0.0.1:3000/health` |
| 2 | **Yönetici (`admin`)** hesabıyla girişlisiniz | `/system/security` açılıyor |
| 3 | Hangi kullanıcı, hangi hedef rol — karar verildi | — |
| 4 | Güncel yedek var | `pnpm backup:offdevice:verify` ([backup.md](backup.md)) |

Roller:

```text
viewer            izleyici           — hiçbir tabloya yazamaz
finance_operator  finans operatörü
finance_approver  finans onaylayıcı
finance_manager   finans yöneticisi
admin             yönetici           — kullanıcı yönetimi + tam erişim
```

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : PRODUCTION_WRITE
WRITE EXPECTED? : YES — public.users güncellenir, public.sessions iptal edilir, audit_logs yazılır
```

---

## COMMANDS

Bütün işlemler tek ekrandadır: **Sistem → Güvenlik** (`/system/security`), kullanıcının satırındaki düğmeler:

| İşlem | Düğme | Yan etki |
|---|---|---|
| Hesabı kapat | **pasifleştir** | Açık oturumlar iptal edilir |
| Hesabı aç | **aktifleştir** | — |
| Rol değiştir | rol listesini seçin → **rolü değiştir** | Yeni yetki bir sonraki istekte geçerli |
| Kilidi aç | **kilidi aç** | Hatalı giriş sayacı sıfırlanır |
| Parola sıfırla | parola kutusu → **sıfırla** | Açık oturumlar iptal edilir |

### Yönetici arayüze giremiyorsa (yalnız o zaman)

Ortada giriş yapabilen bir yönetici yoksa, komut satırından bir yönetici hesabı yeniden kurulur:

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
$env:MIGRATION_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')
pnpm exec tsx scripts/db/seed-admin.ts --username <mevcut-kullanici> --display-name "<Ad Soyad>" --role admin
Remove-Item Env:MIGRATION_DATABASE_URL -ErrorAction SilentlyContinue
```

> **`psql.exe` ile `public.users` tablosunu elle GÜNCELLEMEYİN.** Arayüz üzerinden yapılan her değişiklik denetim kaydına gerçek kimlikle yazılır ve oturumları iptal eder.

---

## EXPECTED

Ekranda yeşil bildirim ve satırın güncellenmiş hâli görünür.

Yerel PostgreSQL 16 üzerinden salt-okunur doğrulama:

```powershell
$kullanici = "<kullanici-adi>"
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -v usr="$kullanici" -c "SET default_transaction_read_only = on; select username, role, is_active, locked_until from public.users where username = :'usr';"
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -v usr="$kullanici" -c "SET default_transaction_read_only = on; select count(*) as acik_oturum from public.sessions s join public.users u on u.id = s.user_id where u.username = :'usr' and s.revoked_at is null and s.expires_at > now();"
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -c "SET default_transaction_read_only = on; select created_at, action, entity_table from public.audit_logs order by created_at desc limit 5;"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

- **Beklenen (kapatma sonrası `acik_oturum`):** `0`.
- **Beklenen (`audit_logs`):** `set_user_role` / `deactivate_user` / `activate_user` / `unlock_user` / `reset_user_password` satırlarından biri.

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| "kendi hesabınız" uyarısı | Kendinizi pasifleştiremez / kendi rolünüzü düşüremezsiniz | Başka bir yönetici yapsın |
| Son yöneticiyi kapatma reddedildi | Veritabanı en az bir aktif yönetici şart koşar | Önce başka bir yöneticiyi aktifleştirin |
| Düğmeler görünmüyor | Hesabınız `admin` değil | Bir yönetici ile yapın |
| `permission denied for table users` | Şema/rol uyumsuz | **DURUN** — [failed-migration.md](failed-migration.md) |

---

## STOP CONDITION

1. Kimlik satırı (`Hedef: db=...`) `mas_radar_dev` dışını gösteriyorsa → hiçbir değişiklik yapmayın, [incident.md](incident.md).
2. `admin` rolü verme talebinin sahibi belirsizse → **vermeyin**, doğrulayın.
3. Aktif yönetici sayısı 1'e düştüyse → başka bir değişiklik yapmadan önce aktif yönetici sayısını kontrol edin:
   ```powershell
   $u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
   $env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
   try {
     & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -t -A -c "SET default_transaction_read_only = on; select count(*) from public.users where role='admin' and is_active;"
   } finally {
     Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
   }
   ```
4. Güncel yedek yoksa → önce [backup.md](backup.md).

---

## ROLLBACK

| Yapıldı | Geri alma |
|---|---|
| pasifleştir | **aktifleştir** |
| rol değiştirildi | rolü eski değerine geri seçip **rolü değiştir** |
| kilidi açıldı | Geri alınmaz |
| parola sıfırlandı | Geri alınmaz; yeni parola belirleyip kullanıcıya güvenli kanaldan iletin |

---

## EVIDENCE

```text
tarih/saat                    :
işlemi yapan                  :  (yönetici kullanıcı adı)
etkilenen hesap               :
işlem                         :  kapat / aç / rol değiştir / kilit aç / parola sıfırla
önceki -> yeni değer          :
açık oturum (kapatma sonrası) :  0
audit_logs kaydı              :  EVET
```

---

## SECRET HANDLING

- Parola sıfırlarken yeni parola **hiçbir yere yazılmaz**; kullanıcıya ayrı güvenli bir kanaldan iletilir.
- `psql.exe` sorguları `password_hash` sütununu asla seçmez.
