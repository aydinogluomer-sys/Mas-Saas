# RUNBOOK — user creation (yeni kullanıcı hesabı aç)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (komut gerekiyorsa):** `C:\Users\Trade Bilisim\Mas Saas`
> **Rol değiştirme, hesap kapatma, kilit açma:** [role-change.md](role-change.md)

---

## PURPOSE

Sisteme yeni bir adlandırılmış kullanıcı hesabı eklemek.

Bu üründe **kayıt olma (signup) ekranı yoktur ve olmayacaktır.** Hesaplar yalnız iki yoldan açılır:

| Yol | Ne zaman | Kim |
|---|---|---|
| **Uygulama içi** — `/system/security` | Normal durum | Giriş yapmış bir **yönetici (`admin`)** |
| **Komut satırı** — `seed-admin.ts` | Ortada hiç yönetici yoksa (ilk kurulum / kilitlenme) | Makineye erişimi olan operatör |

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Uygulama ayakta | `curl.exe -s http://127.0.0.1:3000/health` → `"status":"ok"` |
| 2 | Elinizde **yönetici** hesabı var | `/system/security` sayfası açılıyor |
| 3 | Yeni hesap için kullanıcı adı, görünen ad ve **rol** kararlaştırıldı | — |
| 4 | Parola en az **12 karakter** ve kullanıcı adıyla aynı değil | — |
| 5 | Yedek güncel | `pnpm backup:offdevice:verify` ([backup.md](backup.md)) |

Roller (en az yetkiliden en yetkiliye):

```text
viewer            izleyici            — yalnız görüntüler, hiçbir tabloya yazamaz
finance_operator  finans operatörü    — günlük operasyon
finance_approver  finans onaylayıcı   — onay yetkisi
finance_manager   finans yöneticisi   — finansal yönetim
admin             yönetici            — kullanıcı yönetimi + tam erişim
```

**Kural:** ne yapacağı kesinleşmemişse `viewer` verin. Yetki sonradan yükseltilebilir ([role-change.md](role-change.md)).

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : PRODUCTION_WRITE
WRITE EXPECTED? : YES — public.users tablosuna bir satır eklenir + audit_logs kaydı
```

---

## COMMANDS

### Yol 1 — uygulama içinden (normal yol)

1. Yönetici hesabıyla giriş yapın (`MAS_LOCAL_PASSWORDLESS=0` üretim kilidi altında gerçek kullanıcı/parolayla).
2. **Sistem → Güvenlik** (`http://127.0.0.1:3000/system/security`).
3. Yeni kullanıcı formunu doldurun:
   - **Kullanıcı adı** (örn. `mehmet`)
   - **Görünen ad** (örn. `Mehmet Yılmaz`)
   - **Rol** (yukarıdaki listeden)
   - **Parola (en az 12 karakter)**
4. **kullanıcı oluştur** düğmesine basın.
5. Parolayı kullanıcıya ayrı güvenli bir kanaldan iletin; kullanıcı ilk girişte kendi parolasını `/system/security` üzerinden değiştirebilir (Migration `0108` `changeOwnPassword` denetim iziyle).

### Yol 2 — hiç yönetici kalmadıysa (komut satırı)

Parola **argüman olarak verilmez** (`--password` bayrağı bilerek reddedilir). İki meşru kanal vardır: maskeli soru ya da geçici `SEED_ADMIN_PASSWORD` ortam değişkeni.

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

$env:MIGRATION_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')

pnpm exec tsx scripts/db/seed-admin.ts --username omer --display-name "Omer Aydinoglu" --role admin

Remove-Item Env:MIGRATION_DATABASE_URL -ErrorAction SilentlyContinue
```

### Doğrulama (yalnız okuma)

```powershell
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -c "SET default_transaction_read_only = on; select username, display_name, role, is_active from public.users order by created_at desc limit 5;"
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -c "SET default_transaction_read_only = on; select created_at, action, entity_table from public.audit_logs order by created_at desc limit 5;"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

---

## EXPECTED

```text
Uygulama içi   ->  yeşil bildirim: kullanıcı oluşturuldu; satır listede görünür
seed-admin     ->  hesabın oluşturulduğunu/güncellendiğini bildiren satır, exit 0
psql.exe       ->  yeni kullanıcı: is_active = t, role = verdiğiniz rol
audit_logs     ->  create_user kaydı, gerçek yönetici kimliğiyle
```

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| Sayfa açılmıyor / giriş ekranına atıyor | Hesabınız **admin** değil | Bir yönetici ile yapın |
| "Parola en az 12 karakter olmalı." | Parola kısa | En az 12 karakter kullanın |
| Parola kullanıcı adıyla aynı | Reddedilir | Farklı bir parola seçin |
| Kullanıcı adı zaten var | Çakışma | Farklı ad seçin ya da mevcut hesabı [role-change.md](role-change.md) ile düzenleyin |
| `permission denied for table users` | Şema/rol uyumsuz | **DURUN** — [failed-migration.md](failed-migration.md) |
| `seed-admin` "TTY gerekli" diyor | Etkileşimsiz kabuk | Aynı pencerede `$env:SEED_ADMIN_PASSWORD` tanımlayıp çalıştırın, hemen ardından `Remove-Item Env:SEED_ADMIN_PASSWORD` ile silin |

---

## STOP CONDITION

1. `admin` rolü vermeniz istendi ama talebin sahibi belirsizse → **açmayın**, doğrulayın.
2. `pnpm db:roles:verify` kimlik satırı `mas_radar_dev` dışında bir ad gösteriyorsa → hiçbir hesap açmayın, [incident.md](incident.md).
3. Aynı kişi için ikinci bir hesap açmanız isteniyorsa → açmayın; mevcut hesabın rolünü değiştirmek doğru yoldur ([role-change.md](role-change.md)).
4. Güncel bir yedek yoksa → önce [backup.md](backup.md).

---

## ROLLBACK

**Kullanıcı silinmez.** Yanlış açılan hesap `/system/security` ekranından **pasifleştirilir** ([role-change.md](role-change.md)). Veritabanı tetikleyicisi en az bir aktif `admin` kalmasını zorunlu tutar.

---

## EVIDENCE

```text
tarih/saat        :
işlemi yapan      :  (yönetici kullanıcı adı)
açılan hesap      :  kullanıcı adı / görünen ad
verilen rol       :
yol               :  uygulama içi / seed-admin
audit_logs kaydı  :  EVET
```

---

## SECRET HANDLING

- **Parola hiçbir yere yazılmaz:** kanıt dosyasına, sohbete, e-postaya, ekran görüntüsüne.
- Parolalar veritabanında Argon2id ile hash'lenir; düz metin hiçbir yerde saklanmaz.
