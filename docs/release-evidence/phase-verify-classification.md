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
