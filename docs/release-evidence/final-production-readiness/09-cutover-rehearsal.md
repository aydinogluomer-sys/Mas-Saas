# AŞAMA 11 — Final RC cutover rehearsal

**WORKING COMMIT:** `5883b5e` (`release/production-readiness-hardening`) + bu aşamanın değişiklikleri
**TARGET DATABASE CLASS:** `DISPOSABLE_CLONE` (yazma) · `PROTECTED_REAL_READONLY` (yalnız `pg_dump` + `SELECT`)
**TARGET DATABASE NAME:** `mas_radar_stage11_clone`, `mas_radar_stage11_restore_drill`,
`mas_radar_b6_oldschema_probe`, `mas_radar_b6_newschema_probe` — kaynak: `mas_radar_dev` ve
`backups/cutover_A_20260825-1211.dump`
**REAL DB WRITE USED:** **NO** — `mas_radar_dev`'e yalnız `pg_dump` ve `select` ile dokunuldu.

**ORIGINAL PLAN REFERENCE**
- section: §16 (AŞAMA 11 — Final RC cutover rehearsal); §20 (A–L, C2); orijinal §10 Faz 7 L1048–L1076
- acceptance criterion: success path final RC'de **yeniden** koşmalı; failure injection listesi
  `wrong password · migration interruption · RLS failure · app/DB health failure ·
  **stale environment variable** · **wrong code/schema pairing**` olmalı; her failure için karar
  (`STOP / RETRY / CONFIG ROLLBACK / DB RESTORE / ESCALATE`) **deterministik** olmalı.

**CURRENT STATUS:** VERIFIED PASS

---

## 0. Bu belge bir DELTA'dır

Önceki prova `docs/release-evidence/faz7-cutover-rehearsal.md`'de duruyor ve **korunmuştur**:
14 satırlık operatör karar tablosu, success path (14/14 + 9/9) ve **B1–B4** failure injection
(yanlış parola · migrate kesintisi · RLS verify hatası · app health hatası). Hiçbiri silinmedi,
hiçbir assertion zayıflatılmadı.

Rehber §16'nın eklediği ve burada kapatılan üç boşluk:

| # | Delta | Neden zorunlu |
|---|---|---|
| 1 | **B5 — environment shadowing** | Rehberin zorunlu kıldığı yeni failure. 2026-08-25 canlı denemesinde **gerçekten yaşandı**. |
| 2 | **B6 — code/schema pairing** | Rehberin zorunlu kıldığı yeni failure ve §20-C2 adımının varlık sebebi. Aynı gün **gerçekten yaşandı**. |
| 3 | **Success path'in final RC'de tekrarı** | Önceki prova `685c20b`'de koştu. RC o günden beri 6 commit ilerledi ve `src/lib/db.ts`, `src/lib/env.ts`, `next.config.ts`, CI ile `src/app/api/perf-probe` değişti. |

---

## 1. Success path — final RC'de YENİDEN koşuldu

### 1.1 `pnpm release:golden-fingerprint` — **14/14 PASS, exit 0**

Kaynak `mas_radar_real_snapshot_0034` (gerçek üretim verisinin migration ÖNCESİ hâli,
`backups/cutover_A_20260825-1211.dump` sha256 `f121cd49…330d`), hedef her koşuda düşürülüp
yeniden yaratılan `mas_radar_stage11_clone`.

Bu koşu bilerek **0034 → 0087** yönünde yapıldı: `mas_radar_dev` artık 0087'de olduğu için ondan
alınan bir klonda migration **no-op** olurdu ve "final RC kodu gerçek veriyi migrate edebiliyor
mu" sorusunu hiç sormazdı. 0034 snapshot'ı bu soruyu sordurur.

```text
Ledger: öncesi 34/0034 → sonrası 87/0087
fresh dump alındı                                     869575 bayt
pg_restore --list arşivi okuyabiliyor                 391 TOC girdisi
öncesi parmak izi alındı                              43 tablo · ledger 34/0034 · operator=2
ledger satır sayısı = 87                              87
ledger son sürüm = 0087                               0087
bayat 'operator' rolü kalmadı                         0 satır
finance_manager artışı = önceki operator sayısı       önce 0 → sonra 2 (operator 2)
en az bir aktif admin                                 1 aktif admin
users_role_check beş katmanı sayıyor                  viewer/finance_operator/finance_approver/finance_manager/admin
FK hedefleri çözülüyor                                170 FK, hedefsiz 0
blanket 'authenticated_all' RLS politikası yok        0 adet
assistant arşiv tutarlılık kısıtı yerinde             status↔archived_at↔archive_reason bağlı
migration checksum drift = 0                          87 ledger satırı diskle uyumlu
legacy finansal tabloların veri hash'i DEĞİŞMEDİ      payments=b57642e6 payment_instances=2194273f
                                                      checks=c1ce99d2 loans=1bba5c47
                                                      loan_installments=6ea1679b cashflow_months=e1aee258

14/14 kontrol geçti.   GOLDEN FINGERPRINT: ALL PASS
```

Manifest: `docs/release-evidence/final-production-readiness/09-cutover-fingerprint-rc.md`

**Tek izinli mutation gerçekleşti ve sınırında kaldı:** `operator 2 → 0`, `finance_manager 0 → 2`,
`admin 10 → 10`. Altı legacy finansal tablonun veri hash'i **birebir aynı**.

### 1.2 `pnpm release:restore-drill` — **9/9 PASS, exit 0, beş kapı YES**

Kaynak **gerçek `mas_radar_dev`** (yalnız `pg_dump` — salt okunur), hedef
`mas_radar_stage11_restore_drill`, uygulama portu 3290, derleme dizini `.next-restore-drill`.
`SKIP_APP_SMOKE` **kullanılmadı**: uygulama gerçekten başlatıldı ve Golden UI smoke koştu.

```text
BACKUP EXISTS            = YES   1.393.293 bayt · sha256 18640d693cb7f27e…
BACKUP READABLE          = YES   1.387 TOC girdisi
BACKUP RESTORABLE        = YES   85 tablo
RESTORED DATA MATCHES    = YES   85 tablo satır sayısı + 6 parasal toplam + 85 satır hash'i birebir
                                 owner okuması payments=20 (kaynak 20)
APP CAN START ON RESTORE = YES   http://127.0.0.1:3290/ready = 200 · golden-ui-smoke 36 passed

9/9 kontrol geçti.   RESTORE DRILL: ALL PASS
```

Makbuz alanları: `source_db=mas_radar_dev`, `system_identifier=7659286466006216743`,
`git_sha=5883b5e047108049896a5f91eb314cb3107fee51`, `schema_ledger=87/0087`,
`pg_dump (PostgreSQL) 16.14`.
Dosya: `docs/release-evidence/final-production-readiness/09-restore-drill-rc.md`

#### Drill'in kendisinde bulunan ve kapatılan iki üretim riski

Bu koşu, drill'i **değiştirmeden** yapılamazdı; ikisi de gerçek kesinti üretecek kusurlardı:

1. **`pnpm db:app-role:password` — küme geneli parola sıfırlaması.** Adım 5 runtime kimliğini
   "yeniden kurmak" için onu çağırıyordu. PostgreSQL'de **roller küme genelindedir**: hedef
   veritabanı ne olursa olsun `alter role mas_radar_app password …` **bütün** veritabanları için
   parolayı değiştirir. Port 3000'deki canlı üretim örneğinin `.env.local` parolası o anda
   geçersizleşir ve uygulama düşerdi. Çağrı **kaldırıldı**; runtime kimliği artık
   `scripts/db/app-url.ts` deseniyle `.env.local`'den alınıp **yalnız veritabanı adı**
   değiştiriliyor. Bu aynı zamanda **daha güçlü** bir test: sentetik bir parolayla değil,
   uygulamanın gerçekten kullandığı rolle bağlanılıyor, dolayısıyla "restore edilen kopyada
   GRANT'lar geri geldi mi" sorusu gerçek kimlik üzerinden cevaplanıyor.

2. **`pnpm build` varsayılan `.next`'e yazıyordu** ve çalışan üretim sunucusunun derlemesini
   eziyordu. Artık `MAS_NEXT_DIST_DIR` (varsayılan `.next-restore-drill`) kullanılıyor.

Ek olarak `SMOKE_PORT` çakışma kapısı eklendi (dolu portta **durur**, kimsenin sunucusunu
öldürmez) ve `next build`'in yeniden yazdığı `tsconfig.json` birebir geri alınıyor.
**Beş kapının hiçbiri zayıflatılmadı; assertion sayısı 9'da kaldı.**

**Kanıt:** koşu bittikten sonra canlı örnek hâlâ ayakta —
`http://127.0.0.1:3000/health → {"status":"ok","app":"up","db":"up"}`. Parola sıfırlansaydı bu
satır `db:"down"` olurdu.

### 1.3 Daha önceki commit'ten alıntılanan kanıt

`pnpm release:real-clone-gate` **gerçek veri** üzerinde backup→restore→migrate→app-start→Golden UI
zincirini kanıtladı. **Bu kanıt `5ea4945` commit'ine aittir**, bu aşamada tekrar koşulmadı;
kanıt dosyaları `docs/release-evidence/final-production-readiness/02-real-clone-migration.md` ve
`03-real-clone-golden-ui.md`. Yukarıdaki 1.1 ve 1.2 koşuları `5883b5e`'dedir.

---

## 2. B5 — environment shadowing (Windows / PowerShell) · **ZORUNLU, YENİ**

**Ne bozuldu:** `.env.local` tamamen doğruyken proses ortamında (kabukta) `DATABASE_URL` /
`MIGRATION_DATABASE_URL` bayat bir değer taşıyor. Rehber §16'nın istediği senaryo; 2026-08-25'te
bu makinede yaşandı ve CONFIG ROLLBACK uygulandıktan **sonra bile** hata sürdü.

Dört ayrı kolun hepsi **gerçekten çalıştırıldı**. Hiçbiri simüle edilmedi.

### B5-1 — `.env.local` doğru, kabuk boş: dosyanın script'ler üzerinde HİÇBİR etkisi yok

`.env.local` içinde `DATABASE_URL=mas_radar_app@mas_radar_dev` **tanımlı**, kabuk temiz:

```text
$ pnpm exec tsx scripts/db/roles-verify.ts
DATABASE_URL tanımlı değil — bu script uygulamanın gerçek runtime bağlantısını test eder.
exit 1
```

Depoda **hiçbir `dotenv` bağımlılığı yok** (`package.json` doğrulandı) ve hiçbir `tsx` script'i
`.env.local` okumuyor. Yani "dosyayı düzelttim" bir script için **hiçbir şey ifade etmiyor**.

**Karar: STOP** — bağlantı değişkeni cutover kabuğunda AÇIKÇA tanımlanır.

### B5-2 — kabukta YANLIŞ ama GEÇERLİ hedef: kapı **yeşil yanıyor** ⚠ en tehlikelisi

`.env.local` → `mas_radar_dev`. Kabuk → aynı kimlik, **başka veritabanı**
(`mas_radar_final_rc_clone`).

```text
PASS  current_user = mas_radar_app — current_user='mas_radar_app'
PASS  rol superuser DEĞİL ve bypassrls DEĞİL — rolsuper=false rolbypassrls=false
PASS  schema_migrations'a INSERT reddedilir — permission denied (42501) — beklenen
PASS  public.payments okunabilir — select başarılı
PASS  public.users okunabilir (login için şart) — select başarılı
PASS  public.sessions okunabilir (login için şart) — select başarılı
PASS  users satırları RLS üzerinden GERÇEKTEN görünüyor — 18 kullanıcı satırı görülebiliyor
PASS  users/sessions'ta hem deny_all hem app_runtime policy'si duruyor — …

8/8 kontrol geçti.
exit 0
```

**Bu çıktı bir yalandır ve ölçülebilir biçimde yalandır.** Gerçek `mas_radar_dev`'de
**17** kullanıcı var; kapı **18** raporladı — yani `mas_radar_final_rc_clone`'u ölçtü. Çıktının
hiçbir yerinde veritabanı adı, kimlik kaynağı ya da uyarı geçmiyor. Operatör yeşil bir kapı
görüyor ve **yanlış veritabanı** için görüyor.

**Karar: STOP.** Bu, "sinyale bakıp karar ver" kuralının kırıldığı tek yer: **sinyal yok**.
Bu yüzden B5 bir gözlem değil, bir **kapı** olmak zorundadır (bkz. §2.5).

### B5-3 — bayat kabuk değeri D girişini (migration) yanlış hedefe sürüyor

`.env.local` doğru; kabukta yalnız bayat bir app-rol `DATABASE_URL` var.
`scripts/db/owner-url.ts` `MIGRATION_DATABASE_URL` yoksa `DATABASE_URL`'e düşer — yani **owner**
işi **app** kimliğiyle çalışır:

```text
$ pnpm db:migrate
Bağlantı: db=mas_radar_b6_newschema_probe user=mas_radar_app system_identifier=7659286466006216743

MIGRATION BAŞARISIZ:
permission denied for schema auth
exit 1
```

`migrate.ts` **kısmi bir bağışıklığa sahipmiş**: hangi veritabanına, hangi kimlikle bağlandığını
yazdırıyor. Ama **neden** oraya bağlandığını söylemiyor — `.env.local`'ı yeni düzeltmiş bir
operatör bu satırı okuyup hiçbir şey anlamıyor. 2026-08-25'te olan tam olarak buydu.

**Karar: CONFIG ROLLBACK** — şemaya dokunulmadı (`permission denied`, hiç SQL çalışmadı);
temiz kabuk + açık değişken, ardından **RETRY**.

### B5-4 — Next runtime'ında `.env.local` **sessizce kaybediyor**

Uygulamanın gerçekten kullandığı yükleyici (`@next/env` 15.5.20 `loadEnvConfig`) doğrudan
çalıştırıldı:

```text
loadEnvConfig ONCESI  DATABASE_URL db = KABUKTAN_GELEN_YANLIS_DB
loadEnvConfig SONRASI DATABASE_URL db = KABUKTAN_GELEN_YANLIS_DB
.env.local KAZANDI MI? HAYIR — kabuk degeri sessizce kazandi, uyari yok
```

Next zaten tanımlı bir proses değişkenini **ezmez**. Yani `.env.local`'ı düzeltip uygulamayı
aynı kabuktan yeniden başlatmak **hiçbir şeyi değiştirmez** ve bunu söyleyen tek bir satır yok.

**Karar: CONFIG ROLLBACK** + yeni kabuk.

### 2.5 Depo bugün uyarıyor mu? **HAYIR — ve bu aşamada bir kapı eklendi**

Ölçülen durum (değişiklikten önce):

| Yol | Bugünkü davranış |
|---|---|
| `tsx` script'leri | `.env.local`'ı hiç okumaz; kaynak hakkında tek kelime etmez |
| `roles-verify` gibi kapılar | yanlış hedefte **8/8 PASS, exit 0** |
| `migrate.ts` | db + user yazdırır (kısmi), **kaynağı** yazdırmaz |
| Next runtime | kabuk sessizce kazanır, uyarı yok |

**Eklenen kapı** (§20-C1 "environment hygiene" adımının çalıştırılabilir hâli):

- `scripts/db/env-source.ts` — saf yüklemler: `classifyEnvSource`, `connectionTargetLabel`,
  `inspectEnvSource(s)`, `describeEnvSource`, `shadowedNames`.
  **Değer asla yazdırılmaz**; yalnız değişken adı, kaynağı ve `kullanıcı@veritabanı` etiketi.
- `scripts/db/env-source-check.ts` → `pnpm db:env:source`. Gölgeleme varsa **exit 1**.
- `scripts/db/migrate.ts` — D girişinde uyarı; `MAS_ENV_SHADOW_STRICT=1` ile **hard fail**.
  Varsayılan öldürmez, çünkü release kapıları (golden-fingerprint, real-clone-gate) hedefi
  **bilerek** çocuk ortamda değiştirir ve o gölgeleme kasıtlıdır.
- `tests/env-source.test.ts` — 17 birim testi; parolanın hiçbir kolda sızmadığı ayrıca
  test ediliyor (yüzde-kaçışlı parola dâhil).

Kapı, B5-2'nin sessiz kaldığı durumu artık **adıyla** söylüyor:

```text
$ pnpm db:env:source          # kabukta B5-2 ile AYNI bayat değer
  MIGRATION_DATABASE_URL: yalnız .env.local (postgres@mas_radar_dev) — DİKKAT: tsx script'leri
                          .env.local'ı OKUMAZ, bu değeri görmezler.
  DATABASE_URL: GÖLGELEME — kabuk (mas_radar_app@mas_radar_final_rc_clone) .env.local'ı
                (mas_radar_app@mas_radar_dev) geçersiz kılıyor. Kazanan KABUK değeridir.

ENV SHADOWING: DATABASE_URL — kabuktaki değer .env.local'ı geçersiz kılıyor.
exit 1
```

`pnpm db:migrate` aynı koşulda artık:

```text
ENV SHADOWING UYARISI — kabuk değeri .env.local'ı geçersiz kılıyor:
  DATABASE_URL: GÖLGELEME — kabuk (mas_radar_app@mas_radar_b6_newschema_probe) .env.local'ı
                (mas_radar_app@mas_radar_dev) geçersiz kılıyor. Kazanan KABUK değeridir.
  Kasıtlı değilse: yeni bir kabuk açın. Ayrıntı: pnpm db:env:source
Bağlantı: db=mas_radar_b6_newschema_probe user=mas_radar_app …
```

`MAS_ENV_SHADOW_STRICT=1` ile **bağlantı bile açılmaz**:

```text
MIGRATION BAŞARISIZ:
MAS_ENV_SHADOW_STRICT=1 ve gölgelenen değişken var (DATABASE_URL). Hiçbir SQL çalıştırılmadı.
exit 1
```

### 2.6 Kurtarma **kanıtlandı**

```text
=== KURTARMA 1/2: kabuk .env.local ile AYNI değeri taşıyor ===
  MIGRATION_DATABASE_URL: kabuk = .env.local (postgres@mas_radar_dev) — gölgeleme yok.
  DATABASE_URL: kabuk = .env.local (mas_radar_app@mas_radar_dev) — gölgeleme yok.
ENV SOURCE: gölgeleme yok.          exit 0

=== KURTARMA 2/2: AYNI salt-okunur SELECT, iki kaynak ===
GÖLGELENMİŞ kabuk          -> db=mas_radar_final_rc_clone   users=18
TEMİZ kabuk (.env.local)   -> db=mas_radar_dev              users=17
```

Kurtarma sözde değil **ölçülü**: aynı sorgu, temiz kabukta gerçek hedefe iniyor ve gerçek sayıyı
(17) döndürüyor.

---

## 3. B6 — code/schema pairing · **ZORUNLU, YENİ**

**Ne bozuldu:** kod ile veritabanı farklı sürümlerde. Rehber §16 **iki yönün de** desteklenmeyen
state olduğunun belgelenmesini istiyor. Her iki yön de **harcanabilir** klonlarda gerçekten
çalıştırıldı.

### B6-1 — yeni kod + eski şema (0034)

`backups/cutover_A_20260825-1211.dump` (sha256 doğrulandı) `mas_radar_b6_oldschema_probe`'a
restore edildi:

```text
ledger           = 34/0034
users_role_check = CHECK ((role = ANY (ARRAY['admin'::text, 'operator'::text])))
roller           = admin=10  operator=2
```

Final RC kodu (`5883b5e`) o veritabanına karşı:

```text
$ pnpm exec tsx scripts/db/seed-system-actor.ts
new row for relation "users" violates check constraint "users_role_check"
exit 1
```

2026-08-25'te canlı ortamda görülen hatanın **birebir aynısı**. `seed-system-actor.ts` beş katmanlı
rol modelini varsayıyor; 0056 uygulanmamış bir şemanın kısıtı yalnız `admin|operator` kabul ediyor.

**Bu hata bağlantı kimliğinden TAMAMEN bağımsızdır** — `.env.local`, rol ya da parola ne olursa
olsun çıkar. Kod ile şema arasındaki uyumsuzluğun kendisidir.

**Karar: STOP.** Şemaya dokunulmadı, hiçbir satır yazılmadı — **DB RESTORE gerekmez**.
Çıkış tek: ya D tamamlanır (şema kodu yakalar) ya da kod hedefe geri alınır.

### B6-2 — eski kod + yeni şema (0087)

"Eski kod" uydurulmadı: **`ef00970`** kullanıldı — 2026-08-25'te operatörün gerçekten geri
döndüğü commit ve `supabase/migrations` altında tam **34** SQL dosyası taşıyor (son dosya
`0034_check_installment_settlement.sql`). Dosyalar `git archive ef00970 scripts/db
supabase/migrations` ile depo içinde ayrı bir dizine çıkarıldı ve **oradan çalıştırıldı**
(göreli import'lar o dizinde kaldı; üçüncü parti bağımlılıklar deponun `node_modules`'ından
çözüldü). Hedef: `mas_radar_stage11_clone`'dan kopyalanan `mas_radar_b6_newschema_probe`
(ledger 87/0087).

**(a) D girişi — eski `migrate.ts`:**

```text
$ node --import tsx scripts/db/migrate.ts        # cwd = eski kod ağacı
Bağlantı: db=mas_radar_b6_newschema_probe user=postgres system_identifier=7659286466006216743

MIGRATION BAŞARISIZ:
LEDGER_MANAGED checksum doğrulaması başarısız, hiçbir yeni SQL çalıştırılmadı:
  0035: ledger'da var, diskte dosya yok (0035_app_runtime_role.sql).
  0036: ledger'da var, diskte dosya yok (0036_counterparty_profiles.sql).
  …
  0087: ledger'da var, diskte dosya yok (0087_assistant_conversations.sql).
exit 1
```

**53 satırın tamamı** listelendi (0035–0087). Kritik ifade: **"hiçbir yeni SQL çalıştırılmadı"**.

**(b) Veri yolu — eski `seed-admin.ts`, eski rol sözlüğüyle:**

```text
$ node --import tsx scripts/db/seed-admin.ts --username stage11probe \
      --display-name "Stage11 Probe" --role operator
new row for relation "users" violates check constraint "users_role_check"
exit 1
```

Eski kod `--role operator`'ü **geçerli** sayıyor (`role !== "admin" && role !== "operator"`
kontrolünü geçiyor); yeni şema onu **reddediyor**. B6-1 ile **aynı kısıt adı, ters yön** —
simetri tesadüf değil, kilidin çift yönlü olduğunun kanıtı.

Ek ölçüm (kod okumasıyla, çalıştırma değil — bu yüzden ayrı işaretleniyor): `ef00970`'te
`src/lib/auth.ts` `export type UserRole = "admin" | "operator"` **yalnız derleme zamanı** bir
tiptir, çalışma zamanı doğrulaması yoktur; `src/lib/users/engine.ts` ise
`z.enum(["admin","operator"])` taşır. Yani 0087 verisi eski uygulamada ya sessizce yanlış
sınıflandırılır (`if (user.role !== "admin")` → `finance_manager` admin sayılmaz) ya da kullanıcı
yönetimi ekranında reddedilir. Bu **NOT VERIFIED** olarak işaretlenmiştir: eski uygulamanın
tamamı ayağa kaldırılmadı.

**Karar: STOP.** Yine hiçbir SQL çalışmadı; **DB RESTORE gerekmez**.

### 3.3 C2 bunu neden önler

Rehber §20 sırayı **A → B → C → C1 → C2 → D → E …** olarak sabitledi. C2, runtime **hâlâ
durmuşken** kodu hedef commit'e geçirir ve **uygulamayı başlatmaz**.

| Sıra | Sonuç |
|---|---|
| C2 **yok**, kod D'den sonra geçilirse | D boyunca eski kod + yeni şema → B6-2 |
| C2 **var** ama uygulama başlatılırsa | yeni kod + henüz eski şema → B6-1 |
| C2 **var**, uygulama başlatılmaz, hemen D | pencere **sıfır**: kod ve şema aynı anda hedefe varır |

B6-1 ve B6-2'nin ikisi de "kod ile şema arasındaki pencere"nin ürünüdür. C2 o pencereyi
**başlatılmamış bir runtime** ile kapatır — kodu D'nin hemen öncesine koyar ve arada uygulamanın
her iki uyumsuz state'i de görmesini engeller. Cutover bu yüzden **bölünemez**: "kimliği bugün
çevirelim, migration'ı hafta sonu yaparız" tam olarak B6-1'i üretir.

---

## 4. Birleşik operatör karar tablosu — B1–B6

`faz7-cutover-rehearsal.md` §1 tablosunun **genişletilmiş** hâli. İlk 14 satır oradan aynen
gelir (silinmedi, değiştirilmedi); son altı satır bu aşamada eklendi.

| # | Gördüğün sinyal | Sınıf | KARAR | Neden |
|---|---|---|---|---|
| 1 | `pg_restore --list` hata veriyor / satır tutmuyor | Ön koşul | **STOP** | Yedek güvenilir değilse geri dönüş yolu yok. |
| 2 | `password authentication failed for user "mas_radar_app"` | Yapılandırma | **CONFIG ROLLBACK** | Şemaya dokunulmadı; yalnız bağlantı dizesi/parola yanlış. |
| 3 | `permission denied for table users` (prepare-runtime) | Yapılandırma | **CONFIG ROLLBACK** | GRANT eksik. Veri sağlam; G geri alınır. |
| 4 | `/health` = 503, `db: "down"` | Yapılandırma | **CONFIG ROLLBACK** | Uygulama ayakta, DB erişimi kopuk. |
| 5 | `/ready` = 200 ama `/health` = 503 | Yapılandırma | **CONFIG ROLLBACK** | Süreç sağlıklı, bağımlılık değil. Restart **çözmez**. |
| 6 | `rolsuper` / `rolbypassrls` = `t` | Yapılandırma | **CONFIG ROLLBACK** | `alter role mas_radar_app nologin;` — G yapılmaz. |
| 7 | RLS verify FAIL (`RLS KAPALI: payments`) | Yapılandırma | **STOP** + CONFIG ROLLBACK | Veri sağlam ama güvenlik duvarı delik. |
| 8 | Migration **kesintiye uğradı** (süreç öldü) | Veri | **RETRY** | Ölçüldü: `56/0056`'da tutarlı kaldı, tekrar koşunca `87/0087`. |
| 9 | Migration **hata ile durdu** (dosya ortada patladı) | Veri | **DB RESTORE** | Durak noktası klonda çözülür; çözülmezse A yedeği. |
| 10 | Checksum drift (hiç SQL çalışmadı) | Nötr | **STOP** | Kod ile ledger ayrışmış; **geri yükleme gerekmez**. |
| 11 | `Backup hedefi bulunamadı` | Ön koşul | **STOP** | migrate.ts yedekleyemediğini migrate etmiyor. |
| 12 | ledger ≠ 87/0087 ya da 0087 nesnesi yok | Veri | **DB RESTORE** | Uygulama başlatılmaz. |
| 13 | `users` dışında sayı/aggregate/hash değişmiş | Veri | **DB RESTORE** | Beklenen mutation whitelist dışı. |
| 14 | Sınıflandırılamayan davranış | — | **ESCALATE** | Tahmin edilerek yönetilmez. |
| **15** | **B5-1** `DATABASE_URL tanımlı değil` — oysa `.env.local` dolu | Ortam | **STOP** | `tsx` `.env.local` okumaz. Değişken kabukta AÇIKÇA tanımlanır; dosyayı düzeltmek script'i düzeltmez. |
| **16** | **B5-2** Kapı **yeşil** ama sayı/hedef beklenenden farklı (ör. `users=18`, beklenen 17) | Ortam | **STOP** | Sinyal **yok**; yeşil kapı yanlış veritabanını ölçüyor olabilir. `pnpm db:env:source` **koşulmadan** ilerlenmez. |
| **17** | **B5-2/3** `pnpm db:env:source` → `ENV SHADOWING: <değişken>` | Ortam | **CONFIG ROLLBACK** | Şemaya dokunulmadı. Yeni kabuk + açık değişken, ardından **RETRY**. |
| **18** | **B5-3** `Bağlantı: db=<beklenmeyen>` ya da `user=<beklenmeyen>` | Ortam | **CONFIG ROLLBACK** | Owner işi app kimliğiyle koşuyor. Hiç SQL çalışmadı. C'ye dön. |
| **19** | **B6-1** `new row for relation "users" violates check constraint "users_role_check"` | Kod↔şema | **STOP** | Yeni kod + eski şema. Hiçbir satır yazılmadı — **DB RESTORE gerekmez**. D tamamlanır ya da kod C2 hedefine alınır. |
| **20** | **B6-2** `ledger'da var, diskte dosya yok (00xx_….sql)` | Kod↔şema | **STOP** | Eski kod + yeni şema. `hiçbir yeni SQL çalıştırılmadı` — **DB RESTORE gerekmez**. Kod C2 hedefine alınır. |

**Karar kuralı, B5/B6 ile genişletilmiş hâliyle:**

> **Önce ortamı sor:** hedef ve kimlik beklenen mi? Değilse **STOP/CONFIG ROLLBACK** — hiçbir
> şeye dokunulmamıştır.
> **Sonra kodu sor:** kod ile şema aynı sürümde mi? Değilse **STOP** — yine hiçbir şeye
> dokunulmamıştır.
> **Sonra şemayı sor:** dokunulmadıysa **CONFIG ROLLBACK**; kesinti ise önce **RETRY**;
> değişti ve doğrulanamıyorsa **DB RESTORE**; sınıflandırılamıyorsa **ESCALATE**.

Yeni satırların hepsi tabloya **STOP / CONFIG ROLLBACK** olarak giriyor ve bu tesadüf değil:
B5 ve B6'nın altı kolunun **hiçbiri** veritabanını değiştirmiyor. İkisi de **ucuz** hatalar —
yeter ki fark edilsinler. Fark edilmemeleri pahalıya patlıyor; B5-2 bunun kanıtı.

---

## §28 kapanış alanları

**CHANGES**
- `scripts/db/env-source.ts` (yeni) — bağlantı değişkeninin kaynağını sınıflandıran saf yüklemler.
- `scripts/db/env-source-check.ts` (yeni) — `pnpm db:env:source`, §20-C1 kapısı, gölgelemede exit 1.
- `tests/env-source.test.ts` (yeni) — 17 birim testi (parola sızıntısı testleri dâhil).
- `scripts/db/migrate.ts` — D girişinde env-shadow uyarısı; `MAS_ENV_SHADOW_STRICT=1` ile hard fail.
- `scripts/release/restore-drill.ts` — `pnpm db:app-role:password` çağrısı **kaldırıldı**
  (küme geneli parola sıfırlaması canlı örneği düşürüyordu); runtime kimliği `.env.local`'den
  türetiliyor; derleme ayrı `MAS_NEXT_DIST_DIR`'e gidiyor; `SMOKE_PORT` çakışma kapısı eklendi;
  `RESTORE_DRILL_SKIP_BUILD` eklendi. **Beş kapı aynen korundu.**
- `package.json` — tek satır: `db:env:source`.
- `eslint.config.mjs` — `ignores` listesindeki tek tek `.next-*` adları **sınıfın tamamıyla**
  (`.next-*/**`) değiştirildi; `.stage11-oldcode/**` eklendi. Sebep ölçüldü: yeni
  `.next-restore-drill` dizini listede olmadığı için `pnpm lint` **4459 hata** verdi. Aynı
  kusur daha önce `.next-real-clone-gate` ve `.next-stage10-perf` için iki kez yaşanmış ve iki
  kez ada özel bir satırla yamanmıştı; bu üçüncü tekrar, listenin yanlış soyutlama düzeyinde
  olduğunu gösterdi. Wildcard'dan sonra: **0 hata**, 1 önceden var olan uyarı.
- `.gitignore` — `/.next-restore-drill/` ve `/.stage11-oldcode/`.
- Bu belge + `09-cutover-fingerprint-rc.md` + `09-restore-drill-rc.md`.
- `docs/release-evidence/cutover-checklist.md` — C1 adımı çalıştırılabilir kapıya bağlandı,
  C2'ye B6 ölçümleri eklendi.

**COMMANDS ACTUALLY RUN / EXIT CODES**

| Komut | Exit |
|---|---|
| `pnpm release:golden-fingerprint` (SOURCE=`mas_radar_real_snapshot_0034`, CLONE=`mas_radar_stage11_clone`) | **0** |
| `pnpm release:restore-drill` (SOURCE=`mas_radar_dev` salt-okunur, RESTORE=`mas_radar_stage11_restore_drill`, SMOKE_PORT=3290) | **0** |
| `pnpm exec tsx scripts/db/roles-verify.ts` (temiz kabuk) | 1 (B5-1) |
| `pnpm exec tsx scripts/db/roles-verify.ts` (gölgelenmiş kabuk) | **0 — yanlış hedefte yeşil** (B5-2) |
| `pnpm db:migrate` (bayat kabuk değeri) | 1 (B5-3) |
| `pnpm db:migrate` (+ `MAS_ENV_SHADOW_STRICT=1`) | 1 — bağlantı bile açılmadı |
| `@next/env loadEnvConfig` doğrudan | — (B5-4, ölçüm) |
| `pnpm db:env:source` (temiz / gölgelenmiş) | **0 / 1** |
| `pnpm exec tsx scripts/db/seed-system-actor.ts` → 0034 klonu | 1 (B6-1) |
| `node --import tsx scripts/db/migrate.ts` (ef00970 ağacı) → 0087 klonu | 1 (B6-2a) |
| `node --import tsx scripts/db/seed-admin.ts --role operator` (ef00970) → 0087 klonu | 1 (B6-2b) |
| `pnpm typecheck` / `pnpm lint` / `pnpm boundary:verify` / `pnpm test` | **0 / 0 hata / 8-8 / 1281-1281** |

**ASSERTION COUNTS**
- golden-fingerprint: **14/14**
- restore-drill: **9/9** + beş kapı YES + golden-ui-smoke **36 passed**
- env-source birim testleri: **17/17**
- toplam süit: **1281/1281**, 55 dosya (önceki taban 1264/1264, 54 dosya)

**EXPECTED** — success path final RC'de yeşil; B5 ve B6'nın altı kolu da gerçekten enjekte
edilmiş, gözlemlenmiş ve her biri deterministik bir karara bağlanmış; `mas_radar_dev`
değişmemiş.

**ACTUAL** — hepsi karşılandı. Ek olarak iki **gerçek kusur** ölçüldü ve kapatıldı: (1) hiçbir
giriş noktası env shadowing'i bildirmiyordu, (2) `restore-drill` küme geneli parola sıfırlaması
ve canlı `.next` ezmesiyle üretim örneğini düşürebiliyordu.

**TEMİZLİK** — bu turda yaratılan dört harcanabilir veritabanı (`mas_radar_stage11_clone`,
`mas_radar_stage11_restore_drill`, `mas_radar_b6_oldschema_probe`, `mas_radar_b6_newschema_probe`),
`.stage11-oldcode/` ağacı ve `.next-restore-drill/` derlemesi **düşürüldü/silindi**.
Koşu sonrası gerçek veritabanı doğrulaması (salt okunur):
`ledger=87/0087 · payments=20 checks=7 loans=1 cashflow_months=35 users=17` — başlangıçtaki
değerlerle **birebir aynı**. Canlı örnek: `/health → {"status":"ok","app":"up","db":"up"}`.

**PASS**
- Success path (golden-fingerprint 14/14 + restore-drill 9/9) final RC'de yeniden koştu.
- B5 dört kol — gerçekten enjekte edildi, kurtarma ölçüldü.
- B6 iki yön — gerçekten enjekte edildi, ikisi de desteklenmeyen state olarak belgelendi.
- B1–B6 için deterministik karar tablosu (20 satır).
- B1–B4 kanıtı bozulmadan duruyor.

**FAIL** — yok.

**NOT VERIFIED**
- Eski uygulamanın (`ef00970`) 0087 şemasına karşı **tam ayağa kaldırılmış** hâli. B6-2'nin veri
  ve migration yolları çalıştırıldı; UI katmanı çalıştırılmadı (eski ağaç için ayrı bir
  `pnpm install` + `next build` gerekirdi; bu makine bellek ve disk sınırında). Kod okumasıyla
  saptanan sessiz yanlış sınıflandırma riski §3.2'de işaretlendi.
- Gerçek `mas_radar_dev` üzerinde A–L cutover: **AŞAMA 15**'in konusu, bu aşamanın değil.

**P0** — yok.
**P1** — yok.
**P2**
- `roles-verify` ve benzeri kapılar bağlandıkları veritabanının adını **yazdırmıyor**. B5-2'nin
  yalanını görünür kılan tek şey harici bir sayım oldu. `pnpm db:env:source` bunu C1'de kapatıyor,
  ama kapıların kendi çıktısına `db=…` satırı eklemek ucuz ve doğru bir iyileştirme olur.

**EVIDENCE FILES**
```text
docs/release-evidence/final-production-readiness/09-cutover-rehearsal.md      (bu belge)
docs/release-evidence/final-production-readiness/09-cutover-fingerprint-rc.md (14/14)
docs/release-evidence/final-production-readiness/09-restore-drill-rc.md
docs/release-evidence/faz7-cutover-rehearsal.md                               (B1–B4, korundu)
docs/release-evidence/cutover-checklist.md                                    (A–L, C1/C2 güncellendi)
```

**NEXT GATE** — AŞAMA 12: `release/production-readiness-hardening` → `master` PR promotion
(rehber §17). Önkoşul listesindeki "rehearsal green" bu belgeyle karşılanmıştır.

**FINAL:** **PASS**
