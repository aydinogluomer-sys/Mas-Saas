# Cutover kontrol listesi — A'dan L'ye, sırayla yapıştırılır

**Bu listeyi Claude ÇALIŞTIRMADI ve çalıştırmayacak.** Gerçek `mas_radar_dev`'e yazma yetkisi
yok ve bu onun görevi değil. Aşağıdakiler kullanıcının kendi terminalinde, kendi kimlik
bilgisiyle çalıştıracağı komutlardır.

**Hazırlık durumu:** L adımının (rollback) provası disposable klonda **koşuldu ve geçti**
(bölüm L). A adımının komutları yazıldı ama **çalıştırılmadı** — gerçek DB gerektiriyor.

---

## ⚠ SIRA BOZULAMAZ — bugün gerçekten yanlış sıralandı (2026-08-25)

**F ve G adımları, D adımı (gerçek migration) TAMAMLANMADAN tek başına DENENMEZ.**

Bu bir teori değil: bugün canlı ortamda tam olarak bu sıra bozuldu ve üç ayrı gerçek hata çıktı
(ayrıntı: "Bilinen tuzaklar" bölümü). Gerçek veritabanı zarar görmedi, ama uygulama açılmadı ve
geri dönüş gerekti.

Cutover **tek bir koordineli oturumda A'dan L'ye** yürütülür. Yarım bırakılmış bir cutover —
"kimliği bugün çevirelim, migration'ı hafta sonu yaparız" — çalışmayan bir kurulum bırakır,
çünkü kod ile veritabanı birbirine bağlıdır (bkz. **C2**).

---

## Ön koşullar — başlamadan önce

```bash
export MIGRATION_DATABASE_URL='postgres://postgres:<POSTGRES_PAROLASI>@127.0.0.1:5432/mas_radar_dev'
```

| Kontrol | Komut | Başarı |
|---|---|---|
| Kod 0056 düzeltmesini içeriyor | `git log --oneline -1` | hardening branch'i checkout edilmiş |
| Gerçek ledger 0034'te | `psql "$MIGRATION_DATABASE_URL" -c "select count(*), max(version) from schema_migrations;"` | `34 \| 0034` |
| Taşınacak hesap sayısı | `psql "$MIGRATION_DATABASE_URL" -c "select count(*) from users where role='operator';"` | sayı **not edilir** (E'de doğrulanacak) |
| En az bir aktif admin | `psql "$MIGRATION_DATABASE_URL" -c "select count(*) from users where role='admin' and is_active;"` | **≥ 1** |

**Aktif admin 0 ise:** 0056 haklı olarak `GÜVENLİK DURDURMASI: en az bir aktif admin hesabı
kalmalı.` ile durur. Bu bir hata değil, korumanın çalışmasıdır — önce bir admin aktifleştirilir.

---

## A — Doğrulanmış yedek

```bash
# A1 — makbuzlu yedek
mkdir -p backups
docker exec mas-radar-pg pg_dump -Fc -f /tmp/cutover_A.dump \
  -d "$MIGRATION_DATABASE_URL"
docker cp mas-radar-pg:/tmp/cutover_A.dump backups/cutover_A_$(date +%Y%m%d-%H%M).dump

# A2 — dump OKUNABİLİR mi (varlığı yeterli değil)
docker exec mas-radar-pg pg_restore --list /tmp/cutover_A.dump | grep -vc '^;'

# A3 — makbuz alanları
docker exec mas-radar-pg sh -c 'stat -c "file_size=%s" /tmp/cutover_A.dump; sha256sum /tmp/cutover_A.dump'
psql "$MIGRATION_DATABASE_URL" -c "select system_identifier from pg_control_system();"
git rev-parse HEAD
```

| | |
|---|---|
| **Başarı böyle görünür** | dump boyutu > 0, `pg_restore --list` yüzlerce TOC girdisi döndürür, sha256 hesaplanır, `system_identifier` gerçek küme ile eşleşir |
| **Başarısızlık böyle görünür** | `pg_restore --list` hata verir ya da 0 girdi döner → **STOP**, cutover **başlamaz** |

> Tek komutlu alternatif: `pnpm release:restore-drill` A adımının tamamını (yedek + makbuz +
> okunabilirlik + ayrı DB'ye restore + karşılaştırma + uygulama açılışı) otomatik yapar.
> Cutover'dan önce **bir kez** çalıştırılması önerilir.

---

## B — Bakım / yazma dondurma

```bash
# B1 — uygulamayı durdur (tek Next sunucusu kuralı)
#      Windows: çalışan `next start` süreci sonlandırılır
# B2 — durduğunun kanıtı
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/ready   # bağlantı YOK bekleniyor
# B3 — açık bağlantı kalmadığının kanıtı
psql "$MIGRATION_DATABASE_URL" -c \
  "select count(*) from pg_stat_activity where datname='mas_radar_dev' and pid <> pg_backend_pid();"
```

| | |
|---|---|
| **Başarı** | `/ready` bağlantı vermiyor, açık bağlantı sayısı **0** |
| **Başarısızlık** | bağlantı kapanmıyor → **STOP**, cutover **ertelenir** |

---

## C — Owner bağlantısı

```bash
psql "$MIGRATION_DATABASE_URL" -c "select current_user, current_database();"
```

| | |
|---|---|
| **Başarı** | `postgres` \| `mas_radar_dev` |
| **Başarısızlık** | beklenen owner değil → **STOP**, bağlantı düzeltilir |

`DATABASE_URL` bu adımda **bilerek ayarlanmaz**: `migrate.ts` `MIGRATION_DATABASE_URL`'i tercih
eder ve yalnız o yoksa `DATABASE_URL`'e düşer. İkisini birden vermek, hangisinin kazandığını
hatırlamayı gerektirir.

---

## C2 — Kod sürümünü hedef commit'e geçir  ⚠ D'DEN ÖNCE, B'DEN HEMEN SONRA

Bugüne kadar bu adım listede **yoktu** ve eksikliği bugün pahalıya patladı.

```bash
git status --porcelain          # temiz olmalı
git checkout release/production-readiness-hardening    # ya da o günün hedef commit'i
pnpm install
git rev-parse --short HEAD      # not edilir — E'de ve olay kaydında lazım
```

| | |
|---|---|
| **Başarı** | çalışma ağacı temiz, `pnpm install` sorunsuz, HEAD hedef commit'te |
| **Başarısızlık** | `Module not found: Can't resolve '@/components/data/reconciliation-table'` → **Bilinen tuzak 4** |

### Neden bu adım D'den ÖNCE ve neden D'ye kilitli

Kod ile veritabanı **birbirine kilitlidir** ve kilit çift yönlüdür:

- **Yeni kod + eski DB = çalışmaz.** `release/...` dalındaki `scripts/db/seed-system-actor.ts`
  beş katmanlı rol modelini (`finance_manager` …) varsayar; migration **0056** uygulanmamış bir
  veritabanının `users_role_check` kısıtı yalnız `admin|operator` kabul eder ve satırı reddeder:

  ```text
  new row for relation "users" violates check constraint "users_role_check"
  ```

  Bu hata **hangi DB kimliğiyle bağlanıldığından tamamen bağımsızdır** — `.env.local`'ı,
  rolü, parolayı ne yaparsanız yapın ortaya çıkar. Bugün tam olarak böyle çıktı.

- **Eski kod + yeni DB** de hedeflenen durum değildir (0087 şemasını 0034 kodu bilmez).

Dolayısıyla sıra: **B (dondur) → C (owner bağlantısı) → C2 (kodu hedefe geçir) → D
(migration) → E …** Kod geçişi D'den sonraya bırakılırsa uygulama ayağa kalkmaz; D'den çok önce
yapılırsa (uygulama çalışır hâldeyken) yine kalkmaz. İkisi **aynı oturumda, bu sırayla** olur.

---

## D — Migration 0035 → 0087

> **⚠ PowerShell oturum değişkeni tuzağı (bugün yaşandı).** `tsx` script'leri — `migrate.ts`,
> `prepare-runtime.ts` ve diğerleri — `.env.local`'ı **otomatik OKUMAZ**. Her yeni PowerShell
> penceresinde bağlantı değişkenleri **açıkça** tanımlanmalıdır:
>
> ```powershell
> $env:MIGRATION_DATABASE_URL = "postgres://postgres:<PAROLA>@127.0.0.1:5432/mas_radar_dev"
> ```
>
> Daha tehlikelisi tersidir: **eski bir oturumda elle tanımlanmış `$env:DATABASE_URL`, sonradan
> `.env.local`'da yaptığınız düzeltmeyi SESSİZCE geçersiz kılar.** Bugün CONFIG ROLLBACK
> uygulandıktan sonra bile hata sürdü; sebebi buydu. Şüphe varsa **yeni bir PowerShell penceresi**
> açın ve değişkeni orada tanımlayın:
>
> ```powershell
> echo $env:DATABASE_URL          # ne olduğunu GÖR, varsaymayın
> echo $env:MIGRATION_DATABASE_URL
> ```

```bash
pnpm db:migrate
```

| | |
|---|---|
| **Başarı** | `pending uygulandı: 0035 … 0087`, exit **0**, ve `yedek: backups/…dump` satırı (zorunlu yedek alındı) |
| **Checksum drift** | `MIGRATION BAŞARISIZ … checksum` → **STOP**. Hiç SQL çalışmadı, **geri yükleme gerekmez**. Ledger ile dosya setinin neden ayrıştığı incelenir. |
| **Yedek hedefi yok** | `Backup hedefi bulunamadı` → **STOP**. migrate.ts yedekleyemediğini migrate etmiyor (doğru davranış). |
| **Ortada patladı** | bir migration hata verdi → **DB RESTORE** (L). Durak noktası saptanır, klonda çözülür. |
| **Süreç kesildi** (kapandı/öldü) | → **RETRY**: `pnpm db:migrate` tekrar çalıştırılır. Provada ölçüldü: kesinti `56/0056`'da tutarlı kaldı, tekrar çalıştırınca `87/0087`'ye devam etti. |

---

## E — Ledger + parmak izi

```bash
psql "$MIGRATION_DATABASE_URL" -c "select count(*), max(version) from schema_migrations;"
psql "$MIGRATION_DATABASE_URL" -c "select to_regclass('public.assistant_conversations');"
psql "$MIGRATION_DATABASE_URL" -c "select role, count(*) from users group by role order by role;"
```

| | |
|---|---|
| **Başarı** | `87 \| 0087`; `assistant_conversations` **NULL değil**; `operator` satırı **yok**; `finance_manager` artışı = ön koşulda not edilen operator sayısı |
| **Başarısızlık** | ledger ≠ 87/0087, ya da 0087 nesnesi yok → uygulama **başlatılmaz**, **DB RESTORE** (L) |
| **Başarısızlık** | `users` dışında sayı/aggregate değişmiş → **DB RESTORE**, fark klonda incelenir |

---

## F, G, H — runtime kimliği ve yeniden başlatma

> **⚠ D TAMAMLANMADAN BU ADIMLARA GEÇİLMEZ.** F/G, migration uygulanmamış bir veritabanında
> `permission denied for table users` verir: `mas_radar_app` rolüne GRANT'ları veren migration
> **0035** hiç çalışmamıştır, dolayısıyla rol vardır ama hiçbir tabloya erişemez. Bugün yaşandı.
>
> **⚠ `.env.local` tek başına yetmez.** `tsx` script'leri onu okumaz; ayrıca eski bir PowerShell
> oturumundaki `$env:DATABASE_URL` `.env.local`'ı sessizce geçersiz kılar. G adımından sonra
> **yeni bir PowerShell penceresi** açmak en güvenlisidir.

Tam komut listesi ayrı belgede: **`docs/release-evidence/env-local-cutover-steps.md`**

Özet:

| Adım | Ne | Başarısızlıkta |
|---|---|---|
| F | `pnpm db:app-role:password` → `rolcanlogin=t, rolsuper=f, rolbypassrls=f` | `rolsuper`/`rolbypassrls`=t → **STOP**, `alter role … nologin` |
| G | `.env.local`: `DATABASE_URL` → `mas_radar_app`, `MIGRATION_DATABASE_URL` **eklenir** | **CONFIG ROLLBACK** (tek satır, saniyeler) |
| H | `pnpm build && pnpm start` → `/ready` 200, `/health` 200 `db:"up"` | `/health` 503 → **CONFIG ROLLBACK** |

---

## I, J, K — yetki, red ve ekran doğrulaması

```bash
pnpm db:roles:verify            # beklenen: 8/8
pnpm db:roles-rls:verify        # beklenen: 29/29, ALL PASS
pnpm db:export-leakage:verify   # beklenen: 36/36, ALL PASS
pnpm db:security-matrix:verify  # beklenen: 17/17, ALL PASS
```

| | |
|---|---|
| **Başarı** | dördü de tam sayıyla geçer |
| **"app fazla yetkili"** | → **CONFIG ROLLBACK**: G geri alınır **ve** F'deki LOGIN kapatılır |
| **"app yetersiz"** | → **CONFIG ROLLBACK**: G geri alınır; eksik GRANT **ayrı migration** ile eklenir |
| **RLS verify FAIL** | → **STOP** + CONFIG ROLLBACK. Provada ölçüldü: RLS bir tabloda kapatıldığında verify `RLS KAPALI: <tablo>` diyerek exit 1 verir |
| **K'da 5xx / boş veri** | önce **CONFIG ROLLBACK**; owner ile düzeliyorsa I/J'ye dön, düzelmiyorsa **DB RESTORE** |

---

## L — Geri dönüş

### Yapılandırma geri dönüşü (saniyeler, şemaya dokunmaz)

```bash
# 1) .env.local'daki DATABASE_URL eski owner satırına döndürülür
# 2) gerekirse rol kapatılır
psql "$MIGRATION_DATABASE_URL" -c "alter role mas_radar_app nologin;"
# 3) yeniden başlat
pnpm build && pnpm start
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/health
```

### Veri geri dönüşü (yalnız D/E sinyallerinde)

**Uygulama DURMUŞ olmalı (B).**

```bash
psql "$MIGRATION_DATABASE_URL" -d postgres -c \
  "select pg_terminate_backend(pid) from pg_stat_activity
    where datname='mas_radar_dev' and pid <> pg_backend_pid();"
docker exec mas-radar-pg dropdb -U postgres --force mas_radar_dev
docker exec mas-radar-pg createdb -U postgres mas_radar_dev
docker exec mas-radar-pg pg_restore -U postgres -d mas_radar_dev --no-owner /tmp/cutover_A.dump
psql "$MIGRATION_DATABASE_URL" -c "select count(*), max(version) from schema_migrations;"
```

> **`--no-acl` KULLANMAYIN.** Faz 6'da ölçüldü: aynı arşiv, `--no-acl` ile geri yüklendiğinde
> veri birebir doğru gelir ama `mas_radar_app` hiçbir tabloda yetkisiz kalır ve uygulama
> `permission denied for table users` ile açılmaz. GRANT'lar yedeğin parçasıdır.

| | |
|---|---|
| **Başarı** | ledger **0034**'e dönmüş, satır sayıları A adımındakiyle **aynı** |
| **Başarısızlık** | sayılar tutmuyor → **ESCALATE**, ikinci bir yedek/kopya aranır |

### L provası — disposable klonda KOŞULDU

| Aşama | Ölçülen |
|---|---|
| A yedeği | 1.378.292 bayt, `pg_restore --list` **1.387** TOC girdisi |
| Yedek öncesi durum | `payments=19 checks=7 payment_instances=468 ledger=87/0087` |
| Hasar enjekte edildi | `checks 7→1`, `payment_instances 468→268` |
| L uygulandı (terminate → dropdb → createdb → pg_restore) | — |
| **Geri yüklenen durum** | `payments=19 checks=7 payment_instances=468 ledger=87/0087` ✅ **birebir** |

Yan bulgu: ilk hasar denemesi `payments_archived_immutability_guard` tarafından reddedildi
(`... is archived and immutable`) ve toplu ifade geri alındı — arşivlenmiş ödemeler trigger ile
korunuyor.

---

## Bilinen tuzaklar — bugün (2026-08-25) canlı ortamda yaşandı

Kullanıcı, F/G adımlarını **D olmadan** denedi. Gerçek veritabanı **hiç zarar görmedi**
(ledger=0034, payments=19, checks=7, loans=1, cashflow_months=35, users=12 — baştan sona
değişmedi, bağımsız doğrulandı), ama uygulama açılmadı ve üç aşamalı bir arıza zinciri çıktı.
Dördüncü tuzak, eski koda dönerken yüzeye çıktı.

### Tuzak 1 — F/G, D'den önce: `permission denied for table users`

`mas_radar_app` rolü gerçek DB'de **hiç GRANT almamış**, çünkü GRANT'ları veren migration 0035 o
veritabanına hiç uygulanmamış (ledger hâlâ 0034). Rol var, LOGIN açık, ama hiçbir tabloyu
göremiyor.

**Karar:** CONFIG ROLLBACK — `.env.local` eski `postgres` bağlantısına döndürülür. Şemaya
dokunulmaz. (Uygulandı, doğru sonuç verdi.)

### Tuzak 2 — Rollback'ten SONRA bile aynı hata: PowerShell oturum değişkeni

`.env.local` geri alınmasına rağmen hata sürdü. Kök neden: kullanıcının o PowerShell
penceresinde daha önce elle tanımlanmış `$env:DATABASE_URL` (mas_radar_app bağlantısı) hâlâ
aktifti ve dosyadaki değeri geçersiz kılıyordu — **çünkü `tsx scripts/prepare-runtime.ts`
`.env.local`'ı zaten hiç okumuyor.**

Bu, cutover'dan bağımsız **kendi başına gerçek bir bulgudur**: bu depoda bağlantı değişkenleri
oturum düzeyinde açıkça verilmelidir; `.env.local`'ı düzeltmek çalışan bir kabuğu düzeltmez.

**Karar:** **yeni PowerShell penceresi** + doğru `$env:DATABASE_URL`. (Çözdü.)

### Tuzak 3 — EN KRİTİK: kod veritabanının çok ilerisinde

`users_role_check` ihlali:

```text
new row for relation "users" violates check constraint "users_role_check"
```

`release/production-readiness-hardening` dalındaki `seed-system-actor.ts` beş katmanlı rol
modelini varsayıyor; gerçek DB'nin kısıtı (migration 0056 uygulanmadığı için) hâlâ yalnız
`admin|operator` kabul ediyor.

**Bu hata `.env.local`'dan, rolden ve parolalardan TAMAMEN BAĞIMSIZDIR.** Hangi kimlikle
bağlanılırsa bağlanılsın çıkar. Kod ile şema arasındaki uyumsuzluğun kendisidir.

**Karar:** ya D tamamlanır (şema kodu yakalar), ya da kod geri alınır (bugün yapılan).
Bu tuzak **C2 adımının** var olma sebebidir.

### Tuzak 4 — eski koda dönerken: `.gitignore`'un `data/` deseni

`git checkout ef00970` sonrası build kırıldı:

```text
Module not found: Can't resolve '@/components/data/reconciliation-table'
```

Sebep: `.gitignore`'daki `data/` deseni köke sabitlenmemişti, bu yüzden `src/components/data/`
de eşleşiyor ve o dizindeki kaynak dosyalar depoya hiç girmiyordu. Düzeltme (`d8b7650`,
`/data/` olarak köke sabitleme) **yalnız `release/production-readiness-hardening` dalında**;
`ef00970` dâhil **eski commit'lerde bu düzeltme YOK**.

**"Eski koda dönmek gerekirse" senaryosu için kalıcı not:** eski bir commit'e dönüldüğünde
`src/components/data/` altındaki dosyalar eksik olabilir. Elle geri alma:

```bash
git show release/production-readiness-hardening:src/components/data/reconciliation-table.tsx > src/components/data/reconciliation-table.tsx
```

(Bugün böyle yapıldı; `pnpm build && pnpm start` başarılı oldu, `/health` → `{"status":"ok",
"app":"up","db":"up"}`.)

### Olayın özeti

| | |
|---|---|
| Gerçek DB'ye verilen zarar | **YOK** — ledger 0034, bütün satır sayıları değişmedi |
| Kaybedilen veri | **YOK** |
| Uygulamanın son durumu | `ef00970` üzerinde çalışıyor, `/health` yeşil |
| Alınan ders | Cutover **bölünemez**: A→L tek oturumda, kod geçişi (C2) D'den hemen önce |

---

## Karar özeti — tek cümle

> **Şemaya dokunulmadıysa CONFIG ROLLBACK. Kesinti ise önce RETRY.
> Şema değişti ve doğrulanamıyorsa DB RESTORE. Sınıflandırılamıyorsa ESCALATE.**

Ayrıntılı sinyal→karar tablosu: `docs/release-evidence/faz7-cutover-rehearsal.md` §1.
