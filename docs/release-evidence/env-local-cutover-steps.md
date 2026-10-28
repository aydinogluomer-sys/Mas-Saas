# `.env.local` — runtime kimliğini superuser'dan `mas_radar_app`'e çevirme (F ve G adımları)

**Durum: KULLANICI EYLEMİ BEKLENİYOR.** Bu adımları Claude uygulayamaz ve uygulamamalıdır:
`.env.local` gerçek sır içerir, kullanıcının dosyasıdır ve bu çalışma boyunca **hiç açılmadı**.
Aşağıdaki komutlar kullanıcının kendi terminalinde, kendi parolasıyla çalıştırılır.

**Claude parola üretmez, tahmin etmez, hiçbir yere yazmaz.** Aşağıda parola her yerde
`<PAROLA>` yer tutucusudur.

---

## Neden bu adım P0-2

Salt-okunur olarak doğrulandı (dosyaya yazılmadı):

- `.env.local` içindeki `DATABASE_URL` hâlâ **`user=postgres`** — yani superuser.
- `MIGRATION_DATABASE_URL` satırı **hiç yok**.

Sonuç: uygulama gerçek yerel kurulumda **superuser olarak** bağlanıyor. Superuser RLS'i
tamamen baypas eder, dolayısıyla Faz 15'ten beri yazılan bütün satır-seviyesi politikaları
**fiilen devre dışı**. CI'da ve disposable klonlarda düşük yetkili kimlik kanıtlanmış durumda;
eksik olan yalnız gerçek kurulumun bu hâle getirilmesi.

Bu, Faz 4'ün `reminders/actions.ts` düzeltmesinin gerekçesiyle de bağlantılı: oradaki "RLS zaten
engeller" savunması **ancak bu adım tamamlandıktan sonra** geçerli olur.

---

## Ön koşul

```bash
# Owner bağlantısı elde hazır olmalı (bu satır .env.local'daki MEVCUT DATABASE_URL'dir)
export MIGRATION_DATABASE_URL='postgres://postgres:<POSTGRES_PAROLASI>@127.0.0.1:5432/mas_radar_dev'

# Rol bugün nasıl duruyor? (0035'ten beri NOLOGIN olması beklenir)
psql "$MIGRATION_DATABASE_URL" -c \
  "select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname='mas_radar_app';"
```

Beklenen: `rolcanlogin=f`, `rolsuper=f`, `rolbypassrls=f`.

---

## F — `mas_radar_app` rolüne gerçek parola + LOGIN

Roller **cluster kapsamlıdır**: bu adım cluster başına bir kez yapılır, veritabanı başına değil.

```bash
# 1) Parolayı ortam değişkenine koy (komut satırı ARGÜMANI olarak verme:
#    argv hem kabuk geçmişinde hem süreç listesinde görünür)
export MAS_RADAR_APP_DB_PASSWORD='<GÜÇLÜ-RASTGELE-PAROLA>'

# 2) Rolü aç
pnpm db:app-role:password

# 3) Ortamdan hemen sil
unset MAS_RADAR_APP_DB_PASSWORD
```

**Başarı böyle görünür:**

```text
OK — 'mas_radar_app' rolüne parola atandı ve LOGIN açıldı.
OK — doğrulama bağlantısı başarılı (current_user=mas_radar_app, select 1 çalıştı).
```

**F1 — doğrulama:**

```bash
psql "$MIGRATION_DATABASE_URL" -c \
  "select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname='mas_radar_app';"
```

Beklenen: `rolcanlogin=t`, `rolsuper=f`, `rolbypassrls=f`.

**DURDURMA ÖLÇÜTÜ (F):** `rolsuper` veya `rolbypassrls` `t` ise **derhal durulur** ve G adımı
yapılmaz. O kimlikle çalışan bir uygulama RLS'i tamamen baypas eder. Geri alma:

```bash
psql "$MIGRATION_DATABASE_URL" -c "alter role mas_radar_app nologin;"
```

---

## G — `.env.local` düzenlemesi

Bu adım **tek satırlık ve anında geri alınabilir** olan yerdir.

```bash
# ÖNCE: mevcut satırı bir yere NOT ET — geri dönüş bunu gerektirir
#   DATABASE_URL=postgres://postgres:<POSTGRES_PAROLASI>@127.0.0.1:5432/mas_radar_dev
```

`.env.local` **sonrası** şöyle olmalı (iki satır: biri değişti, biri **eklendi**):

```dotenv
DATABASE_URL=postgres://mas_radar_app:<F'DE-BELIRLENEN-PAROLA>@127.0.0.1:5432/mas_radar_dev
MIGRATION_DATABASE_URL=postgres://postgres:<POSTGRES_PAROLASI>@127.0.0.1:5432/mas_radar_dev
```

`MIGRATION_DATABASE_URL` **ayrı kalır**: `getPool()` uygulamayı dar kimlikle çalıştırırken,
migration ve bakım script'leri owner kimliğine ihtiyaç duyar. İkisini tek değişkene indirmek,
Faz 15'in ayırdığı şeyi geri birleştirmek olur.

---

## H — yeniden başlat ve doğrula

```bash
pnpm build && pnpm start
```

```bash
# H1 — süreç ayakta mı (canlılık; DB'ye bakmaz, her zaman 200)
curl -sS http://127.0.0.1:3000/ready

# H2 — veritabanı erişimi sağlıklı mı (bağımlılık; DB kopuksa 503)
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/health
```

**Başarı böyle görünür:** `/ready` → 200, `/health` → **200** ve gövdesinde `"db":"up"`.

**Başarısızlık böyle görünür ve ne anlama gelir:**

| Gördüğün | Anlamı | Yapılacak |
|---|---|---|
| `password authentication failed for user "mas_radar_app"` | G'deki parola F'dekiyle aynı değil | **CONFIG ROLLBACK** — G satırını düzelt |
| `permission denied for table users` (prepare-runtime) | GRANT'lar eksik | **CONFIG ROLLBACK** — G geri alınır, şemaya dokunulmaz |
| `/health` = 503, `db:"down"` | Uygulama ayakta, DB erişimi kopuk | **CONFIG ROLLBACK** |
| `/ready` 200 ama `/health` 503 | Süreç sağlıklı, bağımlılık değil | Süreci yeniden başlatmak **çözmez** — G'ye bak |

Bu dört sinyalin dördü de Faz 7 provasında **gerçekten üretildi**; tahmin değil, ölçüm.

---

## Yapılandırma geri dönüşü (saniyeler)

```bash
# 1) .env.local'daki DATABASE_URL eski owner satırına döndürülür (yukarıda not edilen satır)
# 2) gerekiyorsa rol tekrar kapatılır
psql "$MIGRATION_DATABASE_URL" -c "alter role mas_radar_app nologin;"
# 3) yeniden başlat
pnpm build && pnpm start
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/health
```

Şemaya **dokunulmaz**; veri geri yüklemesi **gerekmez**.

---

## Yapıldığında nasıl doğrulanır (kabul kriteri)

```bash
# 1) Rol doğru nitelikte
psql "$MIGRATION_DATABASE_URL" -c \
  "select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname='mas_radar_app';"
#    beklenen: t | f | f

# 2) Uygulama gerçekten o kimlikle bağlanıyor
pnpm db:roles:verify
#    beklenen: 8/8 kontrol geçti

# 3) RLS davranışı gerçek kurulumda da geçerli
pnpm db:roles-rls:verify
#    beklenen: 29/29, ROLES-RLS VERIFY: ALL PASS
```

Üçü de geçtiğinde **P0-2 kapanmış** olur ve `reminders/actions.ts`'teki RLS-yedekli savunma
gerçek ortamda da geçerli hâle gelir.

---

## Runbook ile tutarlılık

Bu belge `docs/real-db-cutover-runbook.md`'nin **F**, **G** ve **H** bölümlerinin komut listesine
çevrilmiş hâlidir. İçerik birebir aynıdır; tek fark sunum:

- Runbook `node --import tsx scripts/db/set-app-role-password.ts` yazıyor; burada aynı script'in
  kayıtlı kısayolu (`pnpm db:app-role:password`) kullanıldı — `package.json`'da bire bir aynı
  script'e işaret eder.
- Runbook'un F/G bölümlerinde bulunmayan tek ekleme: yukarıdaki "Yapıldığında nasıl doğrulanır"
  kabul kriteri (üç verify komutu). Bu, runbook'un **I** bölümündeki doğrulamaların özetidir.
