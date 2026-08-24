# Cutover kontrol listesi — A'dan L'ye, sırayla yapıştırılır

**Bu listeyi Claude ÇALIŞTIRMADI ve çalıştırmayacak.** Gerçek `mas_radar_dev`'e yazma yetkisi
yok ve bu onun görevi değil. Aşağıdakiler kullanıcının kendi terminalinde, kendi kimlik
bilgisiyle çalıştıracağı komutlardır.

**Hazırlık durumu:** L adımının (rollback) provası disposable klonda **koşuldu ve geçti**
(bölüm L). A adımının komutları yazıldı ama **çalıştırılmadı** — gerçek DB gerektiriyor.

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

## D — Migration 0035 → 0087

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

## Karar özeti — tek cümle

> **Şemaya dokunulmadıysa CONFIG ROLLBACK. Kesinti ise önce RETRY.
> Şema değişti ve doğrulanamıyorsa DB RESTORE. Sınıflandırılamıyorsa ESCALATE.**

Ayrıntılı sinyal→karar tablosu: `docs/release-evidence/faz7-cutover-rehearsal.md` §1.
