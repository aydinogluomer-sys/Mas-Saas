# Phase verify classification — what may run on a clean CI runner, and what may not

**Faz 1 çıktısı.** Bu belge `package.json`'daki **43** `phase*:verify` script'inin tamamını
sınıflandırır. Amaç tek bir kararı savunulabilir kılmak: *hangileri CI'da çalışır?*

Plan bu tabloyu şu cümleyle zorunlu kılıyor: **"kör biçimde loop'a eklenmez"** ve **"CI-safe
olmayan script fake fixture ile yapay şekilde yeşil yapılmaz"**. Aşağıdaki sınıflandırma
tahmine değil, her script üzerinde çalıştırılan ölçümlere dayanıyor:

- `pg` istemcisi import ediyor mu? (`grep -c 'from "pg"'`)
- `requireDisposableOwnerDatabaseUrl()` çağırıyor mu?
- yazma ifadesi sayısı (`insert into|delete from|truncate|update … set`)
- `TRUNCATE` var mı?
- `data/source/…xlsx` (özel iş verisi) okuyor mu?
- çalışan bir HTTP sunucusu gerektiriyor mu? (`spawn` + `fetch`)

---

## Özet

| Sınıf | Adet | CI'da çalışır mı? |
|---|---:|---|
| **A-source** — bağlantı dizesi yok, DB yok | 2 | EVET |
| **A-db** — taze migrate edilmiş disposable DB | 26 | EVET |
| **A-server** — build + çalışan sunucu | 1 | EVET (build job'undan sonra) |
| **B** — özel workbook bağımlı (`LOCAL_PRIVATE_DATA_GATE`) | 14 | HAYIR |
| **Toplam** | **43** | |

---

## Sınıf A-source — kaynak ağacı kontrolü, veritabanı yok

Bağlantı dizesi istemez, hiçbir şeye yazmaz, `pg` import etmez. CI'daki en ucuz ve en güvenli
gate'ler; onlar için veritabanı hazırlamak tiyatro olurdu.

| Verify | DB yazar? | TRUNCATE? | Workbook? | Fresh DB? | CI-safe? |
|---|---|---|---|---|---|
| `phase17:verify` | HAYIR | HAYIR | HAYIR | gerekmez | **EVET** |
| `phase18:verify` | HAYIR | HAYIR | HAYIR | gerekmez | **EVET** |

`phase18` kaynağında "TRUNCATE" kelimesi geçer, ama bir **yorum** içinde: 0022'den beri
`audit_logs` üzerindeki BEFORE trigger'ların UPDATE/DELETE/TRUNCATE'i superuser için bile
reddettiğini anlatır. Yazma ifadesi sayacının `phase18` için 2 göstermesinin nedeni de aynı:
script, `src/` içinde doğrudan audit insert'i **aramak** için o kalıpları string olarak taşır.
Her ikisi de `pg` import etmez — ölçüldü, `from "pg"` sayısı 0.

## Sınıf A-db — taze, migrate edilmiş disposable veritabanı

Hepsi `requireDisposableOwnerDatabaseUrl()` üzerinden bağlanır (adı disposable işareti
taşımayan hedefi reddeder) ve hepsi fixture yazar. **Her biri kendi taze veritabanını ister**:
`audit_logs` 0022'den beri append-only olduğu için art arda aynı veritabanında çalıştırıldığında
bir sonraki script bir öncekinin audit satırlarını sayar ve kod ile ilgisi olmayan bir nedenle
kırmızıya döner.

| Verify | DB yazar? | TRUNCATE? | Workbook? | Fresh DB? | CI-safe? |
|---|---|---|---|---|---|
| `phase11b:verify` | EVET | EVET | HAYIR | EVET | **EVET** |
| `phase13b:verify` | EVET | EVET | HAYIR | EVET | **EVET** |
| `phase14b:verify` | EVET | EVET | HAYIR | EVET | **EVET** |
| `phase14c:verify` | EVET | EVET | HAYIR | EVET | **EVET** |
| `phase14d:verify` | EVET | EVET | HAYIR | EVET | **EVET** |
| `phase14e:verify` | EVET | EVET | HAYIR | EVET | **EVET** |
| `phase19:verify` | EVET | EVET | HAYIR | EVET | **EVET** |
| `phase20:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase21:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase22:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase23:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase24a:verify` | EVET | EVET | HAYIR | EVET | **EVET** |
| `phase25:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase26:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase27:verify` | EVET | EVET | HAYIR | EVET | **EVET** |
| `phase28:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase29:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase30:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase31:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase32:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase33:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase34:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase35:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase36:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase37:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |
| `phase38:verify` | EVET | HAYIR | HAYIR | EVET | **EVET** |

TRUNCATE sütunu "HAYIR" olan script'ler yine de **yazar** (insert/delete ile); sütun yalnızca
hangi temizleme yönteminin kullanıldığını söyler, "zararsız" anlamına gelmez. Hepsi disposable
kapısının arkasındadır.

## Sınıf A-server — build edilmiş uygulama ve çalışan sunucu ister

| Verify | DB yazar? | TRUNCATE? | Workbook? | Fresh DB? | CI-safe? |
|---|---|---|---|---|---|
| `phase16:verify` | dolaylı (sunucu üzerinden) | HAYIR | HAYIR | HAYIR | **EVET** |

`phase16` tek başına `pg` import etmez; `next start`'ı kendi `spawn` eder ve HTTP üzerinden
`/health`, `/ready`, rate limit, CSRF ve hata zarfını sınar. Bu yüzden `build` job'undan
**sonra** ve `DATABASE_URL` ayarlıyken çalışmalıdır — kendi job'unda değil, build çıktısının
bulunduğu yerde.

## Sınıf B — özel workbook bağımlı → `LOCAL_PRIVATE_DATA_GATE`

Hepsi `data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx` dosyasını okur. `data/`
gitignore'dadır çünkü gerçek finansal veridir; temiz bir checkout'ta bu dosya **yoktur**.

| Verify | DB yazar? | TRUNCATE? | Workbook? | Fresh DB? | CI-safe? |
|---|---|---|---|---|---|
| `phase3:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase4:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase5:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase6:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase6b:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase7:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase8:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase9a:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase9b:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase9c:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase9d:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase12a:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase13a:verify` | EVET | EVET | EVET | EVET | HAYIR |
| `phase14a:verify` | EVET | EVET | EVET | EVET | HAYIR |

Ayrıca `import:real` aynı sınıftadır (aynı workbook'u ve bozuk varyantını okur).

### Neden sentetik bir fixture ile "yeşil" yapılmıyor

Çünkü yeşil olurlar ve hiçbir şey kanıtlamazlar. Bu script'ler gerçek dosyadaki **kesin
rakamları** doğrular (43 sayfa, 9.817 hücre, TİJEN −60.000 gibi). Fixture üretmek demek,
beklenen değeri de fixture'dan üretmek demektir; o noktada assertion bir totolojiye dönüşür —
"ürettiğim sayı ürettiğim sayıya eşit". Gerçek workbook'un mapping'i bozulduğunda bu testler
artık uyarı vermez. Plan bunu açıkça yasaklıyor, ve yasak doğru.

### Nasıl kayıt altına alınıyor

Her release candidate öncesi operatör bunları `data/` mevcutken lokal çalıştırır ve makbuzu
release evidence'a ekler. CI'da **çalışmazlar**; CI'da "atlandı" diye sessizce geçilmezler de —
bu belge onların var olduğunu ve nerede çalıştıklarını söyleyen kayıttır.

---

## CI'da NE çalışmadığının açık listesi

Bir sonraki okuyucunun "neden 43 script var ama CI 29 tanesini çalıştırıyor?" sorusuna cevabı:

- 14 script özel workbook ister → Sınıf B, `LOCAL_PRIVATE_DATA_GATE`.
- Kalan 29'un tamamı CI'da çalışır: 2 kaynak kontrolü + 26 veritabanı + 1 sunucu.

`phase-verifies` job'u 28'ini çalıştırır (2 + 26); `phase16:verify` build çıktısına bağlı
olduğu için `build` job'unda kalır.

---

## p0b-managed-baseline gate — `db:*-verify` script'leri (2026-08-25 eklendi)

Yukarıdaki tablo `phase*:verify` ailesini sınıflar. `database-migration` job'u ayrıca bir grup
`db:*-verify` script'i çalıştırıyordu; bunlar farklı bir kaynak-of-truth'a — **donmuş bir özel
dump'a** — bağlı ve aynı `LOCAL_PRIVATE_DATA_GATE` mantığına giriyorlar. Bu, temiz CI klonunda
`database-migration` job'unun neden her koşuda kırmızı olduğunun kök nedeniydi (ENOENT, hiçbir
assertion çalışmadan).

İki özel dump vardır, ikisi de `backups/` altında (gitignore'lu, `*.dump` de öyle) ve **repoya
asla girmez**:

- **`p0c-checkpoint-*.dump`** — gerçek `mas_radar_dev`'in Slice 5 legacy-repair öncesi donmuş
  pg_dump'ı; bilinen `payment_instances` anomalisini (`LEGACY_ANOMALY_INSTANCE_ID`) taşır.
- **`p0b-managed-baseline-*.dump`** — aynı ailenin managed-baseline (ledger-yönetimli) hâli;
  aynı anomaliyi taşır.

| Script | CI adımı (eski) | Dump | Yapı | CI'da? | Neden |
|---|---|---|---|---|---|
| `db:migrate:verify` | database-migration #5 | p0c-checkpoint | **KARMA** | **EVET (kısmi)** | 4 checkpoint-bağımsız test (file-set / EMPTY / ledger-empty-recovery / cluster-identity) CI'da koşar; 3 checkpoint-bağımlı test (`hasCheckpointDump()` ile) yüksek sesle SKIP-LOCAL sınıflanır |
| `db:constraints:verify` | database-migration #7 | p0b-managed-baseline | tam bağımlı | **HAYIR** | main ilk satırda `restoreManagedFixtureInto` — tüm suite dump'a bağlı |
| `db:transitions:verify` | database-migration #8 | p0b-managed-baseline | tam bağımlı | **HAYIR** | aynı |
| `db:reconciliation:verify` | database-migration #9 | p0b-managed-baseline | tam bağımlı | **HAYIR** | aynı |
| `db:legacy-repair:verify` | database-migration #10 | p0b-managed-baseline | tam bağımlı | **HAYIR** | aynı |

**Yapılan (2026-08-25):** dört tam-bağımlı adım `database-migration` job'undan **çıkarıldı** (bkz.
`.github/workflows/ci.yml`, `db:reconciliation:verify` bloğunun yerindeki yorum). `db:migrate:verify`
CI'da **kalır** çünkü gerçek checkpoint-bağımsız ledger güvenlik testleri var; `migrate-verify.ts`
dump yokluğunu kendi tespit eder ve yalnız o testleri koşar, cikis kodu yalnız KOŞAN testleri
yansıtır.

### Neden sentetik bir baseline üretilmiyor

`phase*` sınıfı B ile birebir aynı gerekçe: bu suite'lerin assertion'ları migrate.ts'in 0030'da
**gerçek donmuş anomaliye** takılıp durmasına dayanır. Sentetik bir baseline üretmek, önce anomaliyi
kendim yazıp sonra "migrate.ts onda duruyor" demek olurdu — assertion, gerçek veriyi değil kendi
fixture'ımı test eder. Bu totoloji, `phase-verifies` job başlığının ve bu belgenin açıkça
reddettiği şeydir.

### CI bu konuda NE'yi hâlâ kanıtlıyor

Constraint/RLS **tanımlarının** kendisi CI'da hâlâ doğrulanıyor: `database-migration` #4 adımı
(`db:verify` → `assertions.sql`) taze migrate edilmiş bir veritabanında tüm invariant assertion'ları
koşar (payment_due_rule, paid⇒paid_at, çek işaret tutarlılığı, RLS+policy her tabloda, append-only
audit, vb.). Çıkarılan dört adımın eklediği şey, bu tanımların **gerçek legacy veri üzerindeki
davranışıdır** — o da yerelde, dump varken, `pnpm db:constraints:verify` vb. ile koşulur.

### Nasıl kayıt altına alınıyor

`p0b`/`p0c` dump'ları mevcut bir makinede (bugün: maintainer'ın makinesi, `backups/` dolu) operatör
release candidate öncesi bu dördünü çalıştırır. CI'da **çalışmazlar**; ama "sessizce atlandı" da
değiller — bu bölüm onların var olduğunu, neyi kanıtladığını ve nerede koştuğunu söyleyen kayıttır.
