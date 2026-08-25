# RUNBOOK — role change (rol değiştir · hesap kapat · kilit aç)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (komut gerekiyorsa):** `C:\Users\Trade Bilisim\Mas Saas`
> **Yeni hesap açma:** `docs/ops/user-creation.md`

---

## PURPOSE

Var olan bir hesap üzerinde dört işlemden birini yapmak:

| İşlem | Ne işe yarar | Aciliyet |
|---|---|---|
| **Hesabı kapat** (pasifleştir) | Kişi ayrıldı, hesap ele geçirildi, erişim derhal kesilmeli | **ACİL — en üstte** |
| **Rolü değiştir** | Yetki artırma/azaltma | Normal |
| **Kilidi aç** | 5 hatalı girişten sonra 15 dakikalık kilit | Normal |
| **Yeniden aktifleştir** | Kapatılmış hesabı geri açmak | Normal |

**Kullanıcı silinmez.** Denetim izi ve geçmiş kayıtların sahipliği korunmalıdır.

---

## ACİL — hesabı hemen kapat

Şüpheli erişim, ayrılan personel, kaybolan cihaz:

1. Yönetici hesabıyla `http://127.0.0.1:3000/system/security` adresini açın.
2. İlgili kullanıcının satırını bulun.
3. **pasifleştir** düğmesine basın.

Bu tek işlem hem girişi kapatır hem de o kullanıcının **açık oturumlarını iptal eder** —
kişi o anda ekranda olsa bile bir sonraki isteğinde dışarı düşer.

Sonra bu belgenin **EXPECTED** bölümündeki doğrulamayı yapın ve **EVIDENCE** bölümünü doldurun.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Uygulama ayakta | `curl.exe -s http://127.0.0.1:3000/health` |
| 2 | **Yönetici (admin)** hesabıyla girişlisiniz | `/system/security` açılıyor |
| 3 | Hangi kullanıcı, hangi hedef rol — karar verildi | — |
| 4 | Güncel yedek var | `docs/ops/backup.md` |

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

Dördü de tek ekrandadır: **Sistem → Güvenlik** (`/system/security`), kullanıcının satırındaki
düğmeler.

| İşlem | Düğme | Yan etki |
|---|---|---|
| Hesabı kapat | **pasifleştir** | Açık oturumlar iptal edilir |
| Hesabı aç | **aktifleştir** | — |
| Rol değiştir | rol listesini seçin → **rolü değiştir** | Yeni yetki bir sonraki istekte geçerli |
| Kilidi aç | **kilidi aç** | Hatalı giriş sayacı sıfırlanır |
| Parola sıfırla | parola kutusu → **sıfırla** | Açık oturumlar iptal edilir |

### Yönetici arayüze giremiyorsa (yalnız o zaman)

Ortada giriş yapabilen bir yönetici yoksa, komut satırından bir yönetici hesabı **yeniden
kurulur** (yeni parola belirlenir, hesap aktifleştirilir):

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
$env:MIGRATION_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')
pnpm exec tsx scripts/db/seed-admin.ts --username <mevcut-kullanici> --display-name "<Ad Soyad>" --role admin
```

Sonrasında bütün rol/kapatma işlemleri **yine arayüzden** yapılır.

> **`psql` ile `public.users` tablosunu elle GÜNCELLEMEYİN.** Arayüz üzerinden yapılan her
> değişiklik denetim kaydına gerçek kimlikle yazılır ve oturumları iptal eder; elle yapılan bir
> `update` bunların ikisini de atlar ve sistemi izi olmayan bir duruma sokar.

---

## EXPECTED

Ekranda: yeşil bildirim ve satırın güncellenmiş hâli (rol etiketi / "pasif" rozeti / kilit
rozetinin kalkması).

Veritabanından doğrulama (yalnız okuma):

```powershell
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -c "select username, role, is_active, locked_until from public.users where username = '<kullanici-adi>';"
```

```text
Hesap kapatıldıysa   ->  is_active = f
Rol değiştiyse       ->  role = yeni rol
Kilit açıldıysa      ->  locked_until = (boş)
```

Oturumların gerçekten iptal edildiğinin kanıtı:

```powershell
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -c "select count(*) as acik_oturum from public.sessions s join public.users u on u.id = s.user_id where u.username = '<kullanici-adi>' and s.revoked_at is null and s.expires_at > now();"
```

**Beklenen (kapatma sonrası):** `0`

Denetim kaydı:

```powershell
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -c "select created_at, action, entity_table from public.audit_logs order by created_at desc limit 5;"
```

**Beklenen:** yaptığınız işleme göre `set_user_role` / `deactivate_user` / `activate_user` /
`unlock_user` / `reset_user_password` satırlarından biri.

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| "kendi hesabınız" uyarısı | Kendinizi pasifleştiremez / kendi rolünüzü düşüremezsiniz | Başka bir yönetici yapsın — bu koruma bilinçlidir |
| Son yöneticiyi kapatma reddedildi | Veritabanı en az bir aktif yönetici şart koşuyor | Önce başka bir yöneticiyi aktifleştirin |
| Düğmeler görünmüyor | Hesabınız admin değil | Bir yönetici ile yapın |
| Kapatıldı ama kullanıcı hâlâ içeride | Sayfa önbelleği | Kullanıcı bir sonraki istekte düşer; `acik_oturum` sorgusu `0` ise iş tamamdır |
| `permission denied for table users` | Şema/rol uyumsuz | **DURUN** — `docs/ops/failed-migration.md` |
| Sorgu beklenen kullanıcıyı bulamıyor | Yanlış veritabanı olabilir | `pnpm db:roles:verify` ilk satırındaki `db=` adına bakın |

---

## STOP CONDITION

1. Kimlik satırı (`Hedef: db=...`) `mas_radar_dev` dışını gösteriyorsa → hiçbir değişiklik
   yapmayın, `docs/ops/incident.md`.
2. `admin` rolü verme talebinin sahibi belirsizse → **vermeyin**, sorun.
3. Aktif yönetici sayısı 1'e düştüyse → başka bir değişiklik yapmadan önce ikinci bir yönetici
   sağlayın:
   ```powershell
   docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -t -A -c "select count(*) from public.users where role='admin' and is_active;"
   ```
4. Güncel yedek yoksa → önce `docs/ops/backup.md`.

---

## ROLLBACK

Her işlemin karşılığı aynı ekrandadır:

| Yapıldı | Geri alma |
|---|---|
| pasifleştir | **aktifleştir** |
| rol yükseltildi | rolü eski değerine geri seçip **rolü değiştir** |
| kilidi açıldı | Geri alınmaz ve alınmamalıdır — kilit yalnız bir sayaçtır |
| parola sıfırlandı | Geri alınmaz. Yeni bir parola belirleyin ve kullanıcıya iletin |

Geri alma **yeni bir denetim kaydı üretir**; eski kayıt silinmez. Doğru olan budur.

---

## EVIDENCE

```text
tarih/saat            :
işlemi yapan          :  (yönetici kullanıcı adı)
etkilenen hesap       :
işlem                 :  kapat / aç / rol değiştir / kilit aç / parola sıfırla
önceki değer          :
yeni değer            :
açık oturum (kapatma sonrası): 0 bekleniyor -> ...
audit_logs kaydı      :  görüldü EVET/HAYIR
```

---

## SECRET HANDLING

- Parola sıfırlarken yeni parola **hiçbir yere yazılmaz**; kullanıcıya ayrı bir kanaldan
  iletilir.
- Denetim kaydı parolayı değil, "parola değişti" olgusunu tutar.
- `psql` sorguları `password_hash` sütununu **seçmez**; yukarıdaki sorgular bilinçli olarak
  yalnız kimlik/durum alanlarını okur.
- Ekran görüntüsü paylaşırken kullanıcı listesi kabul edilebilir; bağlantı dizesi içeren
  hiçbir kare paylaşılmaz.
