# Gerçek veritabanı cutover runbook'u (`mas_radar_dev`, şema 0034 → 0087)

> **Bu belge yalnızca YAZILMIŞTIR, UYGULANMAMIŞTIR.** Aşağıdaki hiçbir adım
> `mas_radar_dev` üzerinde çalıştırılmadı; `.env.local` açılmadı, `mas_radar_app`
> rolüne LOGIN verilmedi. Belgeyi hazırlayan çalışmanın tüm kanıtı `mas_radar_p0_*`
> ve `mas_radar_*_verify` önekli disposable veritabanlarında üretildi.

## 0. Bu cutover neden ayrı bir belge hak ediyor

İki şey aynı anda değişiyor ve ikisi de geri alınabilirlik açısından farklı sınıflarda:

| Değişen | Sınıf | Geri alma |
|---|---|---|
| Şema 0034 → 0087 (53 migration) | **Veri** | Yalnız yedekten geri yükleme |
| Runtime kimliği `postgres` → `mas_radar_app` | **Yapılandırma** | `.env.local` geri alınır, yeniden başlatılır |

İkincisi saniyeler içinde geri alınır, birincisi alınmaz. Bu yüzden sıra
**önce şema, sonra kimlik**: kimlik değişimi başarısız olursa şema yerinde kalır ve
tek yapılacak bağlantı dizesini geri çevirmektir. Ters sırada, kimlik doğruyken şema
başarısız olsaydı, geri dönüş iki ayrı işlem olurdu.

## 0.1 Ön koşullar ve bilinen mayın

**Bilinen mayın — Faz 17-38 denetiminde bulundu ve düzeltildi.** Migration 0056,
`public.users` üzerindeki `users_require_active_admin` DEFERRABLE INITIALLY DEFERRED
constraint trigger'ı yüzünden, `role='operator'` satırı bulunan **her** veritabanında
`cannot ALTER TABLE "users" because it has pending trigger events` ile patlıyordu.
`mas_radar_dev`'de bugün 2 adet `role='operator'` satırı var, yani düzeltme
olmadan bu cutover **kesinlikle** 0056'da dururdu. Düzeltme (`set constraints
users_require_active_admin immediate;`) commit `12d5b7d` içinde; 0055→0087 provası
disposable bir klonda uçtan uca koşuldu.

**Cutover'a başlamadan önce doğrulanacaklar:**

```bash
# 1) Çalışılan kod gerçekten düzeltilmiş 0056'yı içeriyor mu?
grep -n "set constraints users_require_active_admin immediate" \
  supabase/migrations/0056_role_enum_expansion.sql   # 1 satır dönmeli

# 2) Gerçek DB'nin ledger'ında 0056 SATIRI OLMAMALI.
#    Varsa: dosya içeriği değiştiği için checksum drift'i oluşur ve migrate.ts
#    HARD-FAIL eder. Bu doğru davranıştır; o durumda cutover DURDURULUR ve
#    ledger ile dosya setinin neden ayrıştığı incelenir.
psql "$MIGRATION_DATABASE_URL" -c \
  "select version, name from public.schema_migrations order by version desc limit 5;"

# 3) Kaç hesap taşınacak? (0056'nın operator -> finance_manager eşlemesi)
psql "$MIGRATION_DATABASE_URL" -c \
  "select role, count(*), count(*) filter (where is_active) as aktif
     from public.users group by role order by 1;"
#    'admin' + is_active satır sayısı EN AZ 1 olmalı. Sıfırsa 0056 haklı olarak
#    "GÜVENLİK DURDURMASI: en az bir aktif admin hesabı kalmalı." ile duracaktır —
#    bu bir hata değil, korumanın çalışmasıdır; önce bir admin aktifleştirilir.
```

Ayrıca hazır olmalı: Docker konteyneri (`mas-radar-pg`) erişilebilir, disk üzerinde
yedek için yer, ve `MIGRATION_DATABASE_URL` (owner/superuser) elde.

---

## A. Doğrulanmış yedek

Migration runner'ın kendi otomatik yedeği **bu adımın yerine geçmez**: o, migrate
işlemi başladıktan sonra alınır ve aynı süreç içindedir. Buradaki yedek bağımsız,
önceden alınmış ve **geri yüklenebilirliği kanıtlanmış** olandır.

```bash
# A1 — makbuzlu yedek (git provenance + system_identifier eşleşmesi zorunlu)
node --import tsx scripts/db/backup-receipt.ts \
  --expected-database-name mas_radar_dev \
  --expected-system-identifier "<pg_control_system().system_identifier>" \
  --expected-git-branch phase17-38-review \
  --expected-git-head "<40 karakterlik HEAD SHA>" \
  --container mas-radar-pg \
  --label pre-cutover \
  --out-dir backups

# A2 — dump'ın OKUNABİLİR olduğu (varlığı yeterli değil)
docker exec -i mas-radar-pg pg_restore --list < backups/<dump> | head -40
docker exec -i mas-radar-pg pg_restore --list < backups/<dump> | wc -l
```

**Beklenen:** `pg_restore --list` hatasız çalışır ve boş olmayan bir içindekiler
tablosu basar. Bayt sayısı sıfırdan büyüktür ve makbuz dosyası yazılmıştır.

**A3 — geri yüklemenin GERÇEKTEN çalıştığı (atlanmaz).** Bir dump'ın listelenebilmesi
geri yüklenebildiğini kanıtlamaz. Yedek, ayrı ve harcanabilir bir veritabanına geri
yüklenip satır sayıları karşılaştırılır:

```bash
docker exec mas-radar-pg createdb -U postgres mas_radar_restore_probe
docker exec -i mas-radar-pg pg_restore -U postgres -d mas_radar_restore_probe \
  --no-owner --role=postgres < backups/<dump>
# kritik tabloların satır sayıları iki tarafta da AYNI olmalı
for t in payments payment_instances checks loans loan_installments cashflow_months \
         cashflow_lines invoices users audit_logs; do
  echo -n "$t "
  docker exec mas-radar-pg psql -qtA -U postgres -d mas_radar_dev -c "select count(*) from public.$t"
  docker exec mas-radar-pg psql -qtA -U postgres -d mas_radar_restore_probe -c "select count(*) from public.$t"
done
```

**GERİ DÖNÜŞ ÖLÇÜTÜ (A):** `pg_restore --list` hata verirse, dump 0 bayt ise, ya da
A3'teki satır sayılarından **herhangi biri** tutmuyorsa — **cutover başlamaz**.
Yedeği olmayan bir migration, geri alınamayan bir migration'dır.

---

## B. Bakım / yazma dondurma

Şema değişirken uygulama yazmaya devam ederse, migration'ın gördüğü veri ile
yedeğin içindeki veri ayrışır; başarısızlık hâlinde geri yükleme bu aradaki işlemleri
sessizce yok eder.

```bash
# B1 — uygulamayı durdur (tek Next sunucusu kuralı: paralel süreç kalmamalı)
#      Windows: çalışan `next start` süreci sonlandırılır.
# B2 — durduğunun kanıtı
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/ready   # bağlanamamalı
# B3 — açık oturum/bağlantı kalmadığının kanıtı
psql "$MIGRATION_DATABASE_URL" -c \
  "select pid, usename, application_name, state
     from pg_stat_activity where datname='mas_radar_dev' and pid <> pg_backend_pid();"
```

**Beklenen:** `/ready` cevap vermez; `pg_stat_activity` yalnızca kendi yönetim
oturumunuzu gösterir. Uygulamaya ait `mas_radar_app`/`postgres` bağlantısı kalmamalı.

**GERİ DÖNÜŞ ÖLÇÜTÜ (B):** Kapatılamayan bir uygulama bağlantısı varsa cutover
ertelenir. Yarı kapalı bir sistemde migrate etmek, `ALTER TABLE`'ın kilit beklemesi ve
belirsiz bir zaman aşımı demektir.

---

## C. Owner/superuser ile migration bağlantısı

```bash
export MIGRATION_DATABASE_URL='postgres://postgres:<parola>@127.0.0.1:5432/mas_radar_dev'
# DATABASE_URL bu adımda BİLEREK ayarlanmaz: migrate.ts owner-url.ts üzerinden
# MIGRATION_DATABASE_URL'i tercih eder ve yalnız o yoksa DATABASE_URL'e düşer.
# İkisini birden vermek, hangisinin kazandığını hatırlamayı gerektirir.
psql "$MIGRATION_DATABASE_URL" -c "select current_database(), current_user;"
```

**Beklenen:** `mas_radar_dev` / `postgres`.

> **Parola disipline dahildir.** Bağlantı dizesi hiçbir log'a, hiçbir komut çıktısına
> ve hiçbir makbuza yazılmaz. Tanı komutlarında `process.env` nesnesi **asla**
> `JSON.stringify` ile basılmaz.

**GERİ DÖNÜŞ ÖLÇÜTÜ (C):** `current_user` beklenen owner değilse durulur. Yanlış
kimlikle çalışan bir migration ya yetkisizlikten yarıda kalır ya da nesneleri yanlış
sahiple yaratır.

---

## D. 0035 → 0087 migration'ı

```bash
node --import tsx scripts/db/migrate.ts
```

`migrate.ts` durumu kendisi tespit eder ve `mas_radar_dev` için beklenen durum
**LEDGER_MANAGED**'dır (ledger 0034'e kadar dolu). Bu yolda runner:

1. diskteki dosyaların checksum'larını ledger'daki kayıtlarla karşılaştırır — **tek
   bir uyuşmazlıkta hiçbir SQL çalıştırmadan durur**;
2. pending migration varsa **zorunlu bir yedek** alır (`verifyBackupTarget` ile hedefin
   doğru veritabanı olduğunu `system_identifier` üzerinden bağımsız doğrular);
3. her migration'ı **kendi transaction'ında** uygular. Bu, kısmi başarı anlamına gelir:
   0056 patlarsa 0035-0055 commit olmuş olur, 0056 ve sonrası olmaz.

**Beklenen çıktı:**

```
Bağlantı: db=mas_radar_dev user=postgres system_identifier=<id>
state=LEDGER_MANAGED
pending uygulandı: 0035, 0036, …, 0087
yedek: backups/migrate-mas_radar_dev-<zaman>.dump (<bayt>, system_identifier=<id>)
Ledger (87 satır):
```

**GERİ DÖNÜŞ ÖLÇÜTÜ (D) — üç ayrı durum, üç ayrı cevap:**

* **Checksum drift ile durdu (hiçbir SQL çalışmadı).** Veri güvende. Cutover durur;
  ledger ile dosya setinin neden ayrıştığı çözülür. Geri yükleme **gerekmez**.
* **Bir migration ortada patladı.** O migration'ın kendi transaction'ı geri alınmıştır,
  ama ondan öncekiler commit olmuştur. Veritabanı artık ne 0034 ne 0087. Bu, tek
  başına "tekrar dene" ile geçilecek bir durum değildir:
  1. hata mesajı ve durduğu versiyon kaydedilir,
  2. `select max(version) from public.schema_migrations;` ile gerçek durak noktası
     belirlenir,
  3. hatanın sebebi veriden kaynaklıysa (0056'nın deferred trigger vakası gibi) önce
     **disposable bir klonda** yeniden üretilip düzeltilir — asla doğrudan gerçek
     veritabanında denenmez,
  4. düzeltme kanıtlanana kadar sistem A'daki yedekten geri yüklenerek 0034'e
     döndürülür ve bakım modundan çıkılır.
* **Başarılı ama ledger 87 satır değil.** Aşağıdaki E adımı bunu yakalar.

---

## E. Ledger + parmak izi doğrulaması

Migration'ın "başarılı" demesi yetmez; **veri sayılarının değişmediği** ayrıca
ölçülür. 0035-0087 arası migration'lar tablo ekler ve rol/RLS kurar; mevcut finansal
satırları silmemeleri gerekir. 0056 bir istisnadır ve **beklenen** tek veri
değişimidir: `role='operator'` satırları `finance_manager` olur.

```bash
# E1 — ledger tam mı?
psql "$MIGRATION_DATABASE_URL" -c \
  "select count(*) as satir, max(version) as son from public.schema_migrations;"
#   beklenen: satir=87, son=0087

# E2 — 0087 gerçekten uygulandı mı (ledger satırı değil, NESNE kanıtı)?
psql "$MIGRATION_DATABASE_URL" -c \
  "select to_regclass('public.assistant_conversations') is not null as var;"

# E3 — veri sayıları A adımındaki yedekle AYNI mı?
for t in payments payment_instances checks loans loan_installments cashflow_months \
         cashflow_lines invoices invoice_lines parties audit_logs source_workbooks; do
  echo -n "$t "
  docker exec mas-radar-pg psql -qtA -U postgres -d mas_radar_dev -c "select count(*) from public.$t"
  docker exec mas-radar-pg psql -qtA -U postgres -d mas_radar_restore_probe -c "select count(*) from public.$t"
done

# E4 — aggregate parmak izi (sayı aynı ama TUTAR değişmiş olabilir)
psql "$MIGRATION_DATABASE_URL" -c \
  "select coalesce(sum(amount),0) as instance_toplam,
          count(*) filter (where amount is null) as bilinmeyen
     from public.payment_instances;"
psql "$MIGRATION_DATABASE_URL" -c \
  "select coalesce(sum(closing_balance),0) from public.cashflow_months;"

# E5 — 0056'nın BEKLENEN tek veri değişimi gerçekleşti mi?
psql "$MIGRATION_DATABASE_URL" -c "select role, count(*) from public.users group by role;"
#   'operator' SATIRI KALMAMALI; eski operator sayısı kadar finance_manager artmalı.
```

**GERİ DÖNÜŞ ÖLÇÜTÜ (E):** E1/E2 tutmuyorsa, ya da E3/E4'te **`users` dışında**
herhangi bir sayı/aggregate değiştiyse — bu bir veri kaybı sinyalidir. Uygulama
başlatılmaz, `.env.local`'a dokunulmaz, sistem A'daki yedekten geri yüklenir ve
fark disposable bir klonda incelenir.

---

## F. `mas_radar_app` rolüne gerçek parola + LOGIN

Rol 0035'ten beri **NOLOGIN** olarak duruyor; bu adım onu kullanılabilir hâle getirir.
Roller cluster kapsamlıdır: **cluster başına bir kez**, veritabanı başına değil.

```bash
export MAS_RADAR_APP_DB_PASSWORD='<güçlü, rastgele parola>'   # ya da maskeli prompt kullan
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" \
  node --import tsx scripts/db/set-app-role-password.ts
unset MAS_RADAR_APP_DB_PASSWORD
```

> Parola **asla** komut satırı argümanı olarak verilmez (argv hem kabuk geçmişinde hem
> süreç listesinde görünür) ve **asla** bir migration dosyasına yazılmaz (migration'lar
> git'e commit edilir). Script bu iki kanalı bilerek kapatır.

```bash
# F1 — rol artık giriş yapabiliyor mu?
psql "$MIGRATION_DATABASE_URL" -c \
  "select rolname, rolcanlogin, rolsuper, rolbypassrls
     from pg_roles where rolname='mas_radar_app';"
#   beklenen: rolcanlogin=t, rolsuper=f, rolbypassrls=f
```

**GERİ DÖNÜŞ ÖLÇÜTÜ (F):** `rolsuper` veya `rolbypassrls` `t` ise **derhal durulur**:
o kimlikle çalışan bir uygulama RLS'i tamamen baypas eder ve Faz 24B'nin tüm katman
modeli kâğıt üzerinde kalır. Rol `alter role mas_radar_app nologin;` ile geri kapatılır.

---

## G. `.env.local` içindeki `DATABASE_URL`'in çevrilmesi

```
# ÖNCE (yedeklenecek satır — bir yere not edilir, geri dönüş bunu gerektirir)
DATABASE_URL=postgres://postgres:<parola>@127.0.0.1:5432/mas_radar_dev

# SONRA
DATABASE_URL=postgres://mas_radar_app:<F'de belirlenen parola>@127.0.0.1:5432/mas_radar_dev
MIGRATION_DATABASE_URL=postgres://postgres:<parola>@127.0.0.1:5432/mas_radar_dev
```

`MIGRATION_DATABASE_URL` ayrı kalır: `getPool()` uygulamayı dar kimlikle çalıştırırken,
migration ve bakım script'leri owner kimliğine ihtiyaç duyar. İkisini tek değişkene
indirmek, Faz 15'in ayırdığı şeyi geri birleştirmek olur.

**GERİ DÖNÜŞ ÖLÇÜTÜ (G):** Bu adım **tek satırlık ve anında geri alınabilir** olan
yerdir. Sonraki adımların herhangi birinde sorun çıkarsa ilk yapılacak şey bu satırı
eski owner bağlantısına döndürüp H'yi tekrarlamaktır; şemaya dokunulmaz.

---

## H. Runtime'ı yeniden başlat

```bash
pnpm build
pnpm start        # prepare-runtime.ts + next start
```

`prepare-runtime.ts` ilk istekten önce ödeme penceresini üretir ve bir audit satırı
yazar; bunu `runAsSystem()` altında `mas_radar_finance_manager` olarak yapar — yani
bu adım aynı zamanda "dar kimlik gerçekten yeterli mi" sorusunun ilk pratik cevabıdır.

```bash
# H1 — sağlık
curl -sS http://127.0.0.1:<port>/ready
curl -sS http://127.0.0.1:<port>/health
```

**Beklenen:** iki uç da olumlu cevap verir; başlatma log'unda `prepare-runtime`
hatasız tamamlanır.

**GERİ DÖNÜŞ ÖLÇÜTÜ (H):** `prepare-runtime` yetkisizlikten (`42501`) düşerse ya da
`/ready` kırmızıysa: G geri alınır (owner bağlantısına dönülür), uygulama yeniden
başlatılır — sistem çalışır durumda kalır — ve eksik GRANT disposable bir klonda
bulunur. **Şema geri yüklenmez**; bu bir yapılandırma sorunudur, veri sorunu değil.

---

## I. `db:roles:verify` — artık gerçek kimlikle

```bash
DATABASE_URL="<mas_radar_app bağlantısı>" pnpm db:roles:verify
```

Bu gate, **uygulamanın kullandığı bağlantının aynısıyla** bağlanır ve ayrımın iki
yönde birden tuttuğunu ölçer: `mas_radar_app` owner işlerini (superuser, bypassrls,
ledger yazma) yapamamalı, ama uygulamanın meşru olarak ihtiyaç duyduğu her şeyi
yapabilmelidir.

```bash
DATABASE_URL="<mas_radar_app bağlantısı>" \
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" pnpm db:roles-rls:verify
```

**Beklenen:** ikisi de ALL PASS.

**GERİ DÖNÜŞ ÖLÇÜTÜ (I):** FAIL varsa uygulama **kullanıma açılmaz**. FAIL'in yönü
kararı belirler:
* *"app fazla yetkili"* (superuser/bypassrls/ledger yazabiliyor) → **G geri alınır ve
  F'deki LOGIN kapatılır**; bu, hiç açılmaması gereken bir kapıdır.
* *"app yetersiz"* (meşru bir işi yapamıyor) → G geri alınır, sistem owner kimliğiyle
  çalışmaya devam eder, eksik GRANT klonda bulunup ayrı bir migration ile eklenir.

---

## J. RLS negatif testleri — gerçek ortamda

Gate'ler yeşil olabilir ve yine de canlı sistemde bir düşük katman göremeyeceği bir
şeyi görebilir. Bu adım o soruyu doğrudan sorar. **Yalnız okur; hiçbir satır
yazılmaz** — her sonda transaction içinde çalışır ve geri alınır.

```sql
-- Gerçek uygulama bağlantısıyla (mas_radar_app), owner ile DEĞİL:
begin;
set role mas_radar_viewer;
select current_user, (select rolsuper from pg_roles where rolname=current_user);
--   beklenen: mas_radar_viewer / f   ← bu doğrulanmadan aşağıdakiler bir şey kanıtlamaz

-- J1: ledger hiçbir katmana açık değil
select count(*) from public.schema_migrations;      -- beklenen: permission denied

-- J2: izleyici HİÇBİR tabloya yazamaz
insert into public.payments default values;         -- beklenen: 42501

-- J3: oturum jetonları okunamaz
select token_hash from public.sessions limit 1;     -- beklenen: 0 satır ya da denied
rollback;

begin;
set role mas_radar_finance_operator;
select set_config('app.user_id','<BAŞKA bir kullanıcının id'si>', true);
-- J4: sahiplik kapsamlı satır, KİMLİĞİ BİLİNSE BİLE görünmemeli
select count(*) from public.saved_views where id = '<o kullanıcıya ait olmayan bir view id>';
--   beklenen: 0
rollback;
```

**POZİTİF KONTROL ZORUNLU.** Reddedilmiş bir SELECT ile boş bir tablo birbirinden
ayırt edilemez. Her negatiften önce, aynı satırın owner bağlantısında **var olduğu**
doğrulanır; yoksa "0 satır" hiçbir şey kanıtlamaz.

**GERİ DÖNÜŞ ÖLÇÜTÜ (J):** Beklenen bir red gerçekleşmiyorsa (özellikle J1/J2), bu bir
yetki sızıntısıdır: G geri alınır, F'deki LOGIN kapatılır ve sistem eski kimliğiyle
çalışmaya döndürülür. Veri geri yüklenmez — sorun politikalarda, veride değil.

---

## K. Uygulama smoke testi

Gerçek bir tarayıcıda, **gerçek login akışıyla** (QA bypass kapalı):

1. `/login` → geçerli bir hesapla giriş.
2. `/overview` — bugün / yarın / 7 gün kartları dolu geliyor mu?
3. `/payments` — kalemler listeleniyor, tutarlar boş değil.
4. `/cashflow` — devir/gelir/gider/fark/kasa zinciri görünüyor, süreklilik uyarısı
   beklenmedik şekilde artmamış.
5. `/finance/checks` ve `/finance/loans` — vade ve taksitler geliyor.
6. **Faz 17-38'in yeni ekranlarından en az üçü** — `/finance/treasury`,
   `/system/jobs`, `/data/approvals`.
7. Bir yazma işlemi: bir ödeme kalemini "ödendi" işaretle, sonra **geri al**. Amaç,
   dar kimliğin gerçekten yazabildiğini görmek; kalıcı bir değişiklik bırakmamak.
8. Katman kontrolü: düşük yetkili bir hesapla `/system/jobs` **açıkça** "bu sayfaya
   erişim yetkiniz yok" göstermeli — boş sayfa değil, yönlendirme değil.

Her sayfada tarayıcı konsolunda `console.error` ve ağ sekmesinde 5xx **olmamalı**.

**GERİ DÖNÜŞ ÖLÇÜTÜ (K):** Bir sayfa 5xx veriyor ya da veri beklenmedik biçimde boşsa:
önce G geri alınır ve yeniden başlatılır. Sayfa owner kimliğiyle **düzeliyorsa** sorun
GRANT/RLS'tir (I/J'ye dönülür). Owner kimliğiyle de **bozuksa** sorun şemadadır ve
A'daki yedekten geri yükleme gündeme gelir.

---

## L. Geri dönüş (rollback) ölçütleri — toplu tablo

| Sinyal | Sınıf | Yapılacak |
|---|---|---|
| A'da `pg_restore --list` hata veriyor / satır sayıları tutmuyor | Ön koşul | Cutover **başlamaz** |
| B'de uygulama bağlantısı kapanmıyor | Ön koşul | Cutover **ertelenir** |
| C'de `current_user` beklenen owner değil | Ön koşul | Durulur, bağlantı düzeltilir |
| D'de checksum drift (hiç SQL çalışmadı) | Nötr | Durulur; **geri yükleme gerekmez** |
| D'de bir migration ortada patladı | **Veri** | Durak noktası saptanır → klonda çözülür → gerekirse A'dan geri yükleme |
| E'de ledger ≠ 87 / 0087 nesnesi yok | **Veri** | Uygulama başlatılmaz; A'dan geri yükleme |
| E'de `users` dışında sayı/aggregate değişmiş | **Veri** | A'dan geri yükleme; fark klonda incelenir |
| F'de `rolsuper`/`rolbypassrls` = t | Yapılandırma | `alter role mas_radar_app nologin;`, G yapılmaz |
| H'de `prepare-runtime` 42501 / `/ready` kırmızı | Yapılandırma | **G geri alınır**, yeniden başlatılır; şemaya dokunulmaz |
| I'de "app fazla yetkili" | Yapılandırma | G geri alınır **ve** F'deki LOGIN kapatılır |
| I'de "app yetersiz" | Yapılandırma | G geri alınır; eksik GRANT ayrı migration ile |
| J'de beklenen red gerçekleşmiyor | Yapılandırma | G geri alınır, LOGIN kapatılır |
| K'da 5xx / boş veri | Önce yapılandırma | G geri alınır; owner ile düzeliyorsa I/J, düzelmiyorsa A |

### Yapılandırma geri dönüşü (saniyeler)

```bash
# 1) .env.local'daki DATABASE_URL eski owner bağlantısına döndürülür
# 2) (gerekiyorsa) rol tekrar kapatılır
psql "$MIGRATION_DATABASE_URL" -c "alter role mas_radar_app nologin;"
# 3) yeniden başlat
pnpm build && pnpm start
curl -sS http://127.0.0.1:<port>/ready
```

### Veri geri dönüşü (yalnız D/E sinyallerinde)

```bash
# uygulama DURMUŞ olmalı (B)
docker exec mas-radar-pg psql -U postgres -c \
  "select pg_terminate_backend(pid) from pg_stat_activity where datname='mas_radar_dev' and pid <> pg_backend_pid();"
docker exec mas-radar-pg dropdb -U postgres mas_radar_dev
docker exec mas-radar-pg createdb -U postgres mas_radar_dev
docker exec -i mas-radar-pg pg_restore -U postgres -d mas_radar_dev \
  --no-owner --role=postgres < backups/<A adımındaki dump>
# doğrulama: ledger 0034'e dönmüş ve satır sayıları A ile aynı olmalı
docker exec mas-radar-pg psql -qtA -U postgres -d mas_radar_dev -c \
  "select count(*), max(version) from public.schema_migrations;"
```

### Post-mortem — bir migration ortada patladığında

Transaction geri alınır, ama **soru geri alınmaz**. Sıra:

1. **Kanıtı dondur.** Hata mesajı, durduğu versiyon, `select max(version) from
   public.schema_migrations`, ve `migrate.ts`'in aldığı yedeğin yolu kaydedilir.
2. **Gerçek veritabanında hiçbir şey denenmez.** Hiçbir "hızlı düzeltme", hiçbir elle
   `ALTER`. Faz 17-38 denetiminin 0056 bulgusu bu kuralın neden var olduğunun kanıtı:
   sorun ancak izole bir klonda yeniden üretilince görüldü.
3. **Klonda yeniden üret.** Yedekten harcanabilir bir veritabanına geri yükle
   (adı `verify`/`clone`/`restore` işaretlerinden birini taşımalı — fixture gate'leri
   bunu şart koşuyor), aynı migration'ı çalıştır, aynı hatayı **gör**.
4. **En küçük düzeltmeyi yap ve iki yönlü kanıtla.** Düzeltmenin geçmesi yetmez;
   koruma haklıyken **hâlâ reddettiği** de gösterilmelidir. 0056'nın negatif kontrolü
   ("aktif admin yok → migration yine durmalı") tam olarak bu yüzden var.
5. **Senaryo matrisiyle tekrarla.** Veriye bağlı bir kusur, tek bir fixture'da bir daha
   yakalanmaz. 0056 için yedi senaryo koşuldu; bu bir tavsiye değil, o bulgunun
   doğrudan dersidir.
6. **Ancak sonra** cutover A'dan itibaren yeniden planlanır.

---

## Bu runbook'un kapsamadıkları

* **TestSprite / demo veritabanları.** `mas_radar_testsprite` ve `mas_radar_*_verify`
  ayrı yaşam döngüleridir; buradaki hiçbir adım onlara uygulanmaz.
* **`origin/master`.** Bu çalışmanın hiçbir parçası `origin/master`'a dokunmaz;
  Faz 17-38 `phase17-38-review` dalında durur.
* **Uygulama kodunun dağıtımı.** Bu belge yalnız veritabanı ve kimlik cutover'ıdır.
