# RUNBOOK — user creation (yeni kullanıcı hesabı aç)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (komut gerekiyorsa):** `C:\Users\Trade Bilisim\Mas Saas`
> **Rol değiştirme, hesap kapatma, kilit açma:** `docs/ops/role-change.md`
> **ACİL — bir hesabı hemen kapatmanız gerekiyorsa:** doğrudan `docs/ops/role-change.md` §"Hesabı
> kapat".

---

## PURPOSE

Sisteme yeni bir adlandırılmış kullanıcı hesabı eklemek.

Bu üründe **kayıt olma (signup) ekranı yoktur ve olmayacaktır.** Hesaplar yalnız iki yoldan
açılır:

| Yol | Ne zaman | Kim |
|---|---|---|
| **Uygulama içi** — `/system/security` | Normal durum | Giriş yapmış bir **yönetici (admin)** |
| **Komut satırı** — `seed-admin.ts` | Ortada hiç yönetici yoksa (ilk kurulum / kilitlenme) | Makineye erişimi olan operatör |

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Uygulama ayakta | `curl.exe -s http://127.0.0.1:3000/health` → `"status":"ok"` |
| 2 | Elinizde **yönetici** hesabı var | `/system/security` sayfası açılıyor |
| 3 | Yeni hesap için kullanıcı adı, görünen ad ve **rol** kararlaştırıldı | — |
| 4 | Parola en az **12 karakter** ve kullanıcı adıyla aynı değil | — |
| 5 | Yedek güncel (hesap açmak veritabanına yazar) | `docs/ops/backup.md` |

Roller (en az yetkiliden en yetkiliye):

```text
viewer            izleyici            — yalnız görüntüler, hiçbir tabloya yazamaz
finance_operator  finans operatörü    — günlük operasyon
finance_approver  finans onaylayıcı   — onay yetkisi
finance_manager   finans yöneticisi   — finansal yönetim
admin             yönetici            — kullanıcı yönetimi + tam erişim
```

**Kural:** ne yapacağı belli değilse `viewer` verin. Yetki sonradan yükseltilir; geri almak
her zaman daha zordur.

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

1. Yönetici hesabıyla giriş yapın.
2. **Sistem → Güvenlik** (`http://127.0.0.1:3000/system/security`).
3. Sayfanın alt bölümündeki formu doldurun:
   - **Kullanıcı adı** (örn. `mehmet`)
   - **Görünen ad** (örn. `Mehmet Yılmaz`)
   - **Rol** (yukarıdaki listeden)
   - **Parola (en az 12)**
4. **kullanıcı oluştur** düğmesine basın.
5. Parolayı kullanıcıya **ağızdan ya da ayrı bir kanaldan** iletin ve ilk girişte
   değiştirmesini söyleyin (değiştirme, aynı sayfadan yöneticinin "sıfırla" düğmesiyle yapılır).

### Yol 2 — hiç yönetici kalmadıysa (komut satırı)

Parola **argüman olarak verilmez**; bu bilinçlidir — argümanlar kabuk geçmişinde ve görev
yöneticisindeki süreç listesinde görünür. İki kanal vardır: `SEED_ADMIN_PASSWORD` ortam
değişkeni ya da maskeli soru.

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

$env:MIGRATION_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')

pnpm exec tsx scripts/db/seed-admin.ts --username omer --display-name "Omer Aydinoglu" --role admin
```

Komut parolayı **maskeli** olarak sorar (her karakter için `*`). Aynı kullanıcı adıyla tekrar
çalıştırmak hesabı **günceller ve yeniden aktif eder** — unutulmuş parolayı sıfırlamanın
belgeli yolu budur.

> `--password` bayrağı bilerek reddedilir. Denerseniz komut açıklamalı bir hatayla durur.

### Doğrulama (yalnız okuma)

```powershell
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -c "select username, display_name, role, is_active from public.users order by created_at desc limit 5;"
```

---

## EXPECTED

```text
Uygulama içi   ->  yeşil bildirim: kullanıcı oluşturuldu; satır listede görünür
seed-admin     ->  hesabın oluşturulduğunu/güncellendiğini bildiren satır, exit 0
psql sorgusu   ->  yeni kullanıcı: is_active = t, role = verdiğiniz rol
users toplamı  ->  önceki sayı + 1   (bu belgenin yazıldığı gün: 17 -> 18)
audit_logs     ->  create_user kaydı, gerçek yönetici kimliğiyle
```

Denetim kaydını görmek:

```powershell
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -c "select created_at, action, entity_table from public.audit_logs order by created_at desc limit 5;"
```

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| Sayfa açılmıyor / giriş ekranına atıyor | Hesabınız **admin** değil | Bir yönetici ile yapın |
| "Parola en az 12 karakter olmalı." | Parola kısa | Uzatın |
| Parola kullanıcı adıyla aynı | Reddedilir | Farklı parola |
| Kullanıcı adı zaten var | Çakışma | Farklı ad seçin ya da mevcut hesabı `docs/ops/role-change.md` ile düzenleyin |
| `permission denied for table users` | Şema/rol uyumsuz | **DURUN** — `docs/ops/failed-migration.md` |
| `seed-admin` "TTY gerekli" diyor | Maskeli soru sorulamıyor | Aynı pencerede `$env:SEED_ADMIN_PASSWORD` tanımlayıp tekrar deneyin, sonra **`Remove-Item Env:SEED_ADMIN_PASSWORD`** ile silin |
| `DATABASE_URL tanımlı değil` | `tsx` `.env.local`'ı okumaz | Yukarıdaki atama satırını çalıştırın |
| Yeni kullanıcı listede yok ama hata da yok | Yanlış veritabanına bakıyor olabilirsiniz | `pnpm db:roles:verify` ilk satırındaki `db=` adını kontrol edin |

---

## STOP CONDITION

1. `admin` rolü vermeniz istendi ama talebin sahibi belirsizse → **açmayın**, sorun.
2. `pnpm db:roles:verify` kimlik satırı `mas_radar_dev` dışında bir ad gösteriyorsa → hiçbir
   hesap açmayın, `docs/ops/incident.md`.
3. Aynı kişi için ikinci bir hesap açmanız isteniyorsa → açmayın; mevcut hesabın rolünü
   değiştirmek doğru yoldur (`docs/ops/role-change.md`).
4. Güncel bir yedek yoksa → önce `docs/ops/backup.md`.

---

## ROLLBACK

**Kullanıcı silinmez.** Yanlış açılan hesap **pasifleştirilir**:

`/system/security` → ilgili satır → **pasifleştir**

Bu, hesabın açık oturumlarını da geçersiz kılar. Ayrıntı ve komut satırı karşılığı:
`docs/ops/role-change.md`.

Silme yerine pasifleştirmenin sebebi: denetim izi (`audit_logs`) ve geçmiş kayıtların
kime ait olduğu korunmalıdır.

> Veritabanı **en az bir aktif yönetici** kalmasını zorunlu tutar; bu kural arayüzde değil,
> veritabanı seviyesinde bir tetikleyicidir. Son yöneticiyi pasifleştirme denemesi reddedilir.

---

## EVIDENCE

```text
tarih/saat        :
işlemi yapan      :  (yönetici kullanıcı adı)
açılan hesap      :  kullanıcı adı / görünen ad
verilen rol       :
yol               :  uygulama içi / seed-admin
users sayısı      :  önce ... sonra ...
audit_logs kaydı  :  görüldü EVET/HAYIR
```

Parola **kanıt dosyasına yazılmaz.**

---

## SECRET HANDLING

- **Parola hiçbir yere yazılmaz:** kanıt dosyasına, sohbete, e-postaya, ekran görüntüsüne.
- Parola komut satırı argümanı olarak **kabul edilmez** — argümanlar kabuk geçmişinde ve süreç
  listesinde görünür. İki kanal vardır: ortam değişkeni ya da maskeli soru.
- `SEED_ADMIN_PASSWORD` kullandıysanız işiniz bitince aynı pencerede silin:
  `Remove-Item Env:SEED_ADMIN_PASSWORD`
- Parolalar veritabanında argon2id ile hash'lenir; düz metin hiçbir yerde saklanmaz — kimse,
  yönetici dâhil, bir kullanıcının parolasını **okuyamaz**, yalnız sıfırlayabilir.
- Denetim kaydı parolanın kendisini değil, "parola değişti" olgusunu yazar.
