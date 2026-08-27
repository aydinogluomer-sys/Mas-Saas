# Etkileşim ve Aksiyon Denetimi

**Soru:** MAS Nakit Radar arayüzünde kullanıcıya aktif olarak gösterilen bütün dahili buton ve
aksiyonlar, vaat ettikleri işi gerçekten yapıyor mu?

**Kapsam:** 66 rota, 5 rol, 2122 ayrık (rota, kontrol) çifti.
**Ortam:** production derlemesi (`pnpm build && pnpm start`), harcanabilir veritabanı
(`mas_radar_interaction_verify`), gerçek `/login` oturumları, `MAS_QA_BYPASS_AUTH` **kapalı**.

---

## Executive summary

Denetim **5 gerçek kusur** buldu ve düzeltti. Beşi de üretim derlemesinde yeniden üretildi,
düzeltildi ve düzeltmeden sonra yeniden ölçüldü.

| # | Kusur | Sınıf | Durum |
|---|---|---|---|
| 1 | `viewer`/`finance_approver` için `/payments`, `/payments/calendar`, `/payments/missing` **çöküyordu** | P0 | Düzeltildi |
| 2 | `admin` için `/system/diagnostics` **çöküyordu** | P0 | Düzeltildi |
| 3 | Reddedilen mutasyonlar **sessizce** başarısız oluyordu (hata URL'e yazılıp hiç gösterilmiyordu) | P1 | Düzeltildi |
| 4 | Yetki reddi **"instance not found"** diye yanlış teşhis ediliyordu | P1 | Düzeltildi |
| 5 | Salt-okur rollere **etkin ama imkânsız** aksiyon düğmeleri gösteriliyordu | P1 | Düzeltildi |

Bunun yanında kalıcı bir **etkileşim kapısı** kuruldu: keşif (tarama) × sözleşme (manifesto) ×
kanıt (gerçek tıklama + DB before/after). Kapı, test edilmemiş bir kontrol kaldığında CI'ı
kırmızıya çevirir.

**Dürüst sınır:** kapı bugün 2122 kontrolün **1561'ini** kanıtlanmış sayıyor, **0 FAIL** ile. Kalan
**561** kontrol için doğrulama sınıfı ve hangi testin karşılayacağı manifestoda YAZILI, ama
testleri henüz yazılmadı. Bu sayı gizlenmiyor — kapı onları `UNTESTED` olarak raporluyor ve bu
yüzden kapı şu an **KIRMIZI**. Ayrıntı: [Kalan iş](#remaining-blockers).

---

## Initial failures

Temiz checkout üzerinde ilk ölçüm:

```
pnpm install --frozen-lockfile   PASS
pnpm lint                        PASS  (0 uyarı)
pnpm typecheck                   PASS
pnpm test                        PASS  (56 dosya, 1304 test)
pnpm build                       PASS
```

Görev tanımında bildirilen `TS2307` (`@/components/data/reconciliation-table` bulunamıyor)
**yeniden üretilemedi**: modül hem diskte hem git'te mevcut ve `pnpm typecheck` temiz geçiyor.
Kök nedeni zaten `d8b7650` ("fix(ci): üç kırmızı job'ın kök nedenini gider") kapatmış.

`src/components/charts/analytics-chart.tsx` içindeki `useEffect` bağımlılık uyarısı da kapalı:
`normalizeGranularity` körlemesine bağımlılık eklenerek değil, `useCallback` ile gerçek
bağımlılıklarına (`granularityOptions`, `model.defaultGranularityByPeriod`) sabitlenerek çözülmüş.

### Ölçüm yolunda bulunan iki ortam sorunu (ürün değil)

Bunlar rapora giriyor çünkü ikisi de "derleme bozuk" gibi görünüp saatler yiyebilir:

- **`next build` sessizce exit -1 veriyordu.** Sebep OOM: makinede 7.9 GB RAM var, editör +
  Docker + WSL 5+ GB tutuyor ve worker'lar "Collecting page data" adımında öldürülüyor. Süreç
  kendi hatasını yazamadan gittiği için **log boş kalıyor**. `next.config.ts`'e `MAS_NEXT_CPUS`
  eklendi (varsayılan davranış değişmedi).
- **`.next` yarışı.** Aynı dizinde çalışan ikinci bir Next süreci `pages-manifest.json`'ı derleme
  ortasında yeniden yazıyor ve `ENOENT` üretiyor. Repo bunun için zaten `MAS_NEXT_DIST_DIR`
  taşıyor.

---

## Fixed defects

### 1 · Salt-okur katmanlar render sırasında çöküyordu (P0)

`/payments`, `/payments/calendar` ve `/payments/missing` **render sırasında yazma** yapıyordu:
`ensureWindow()` eksik ayları üretir, `refreshRiskFlags()` bayrağı değişmiş satırları UPDATE eder.
İkisi de bakım işidir ama render yolunda oldukları için **sayfayı açan kişinin yetkisiyle**
çalışıyordu.

`viewer` ve `finance_approver` `payment_instances` üzerinde yalnız SELECT'e sahip. Ölçülen:

```
viewer            /payments/calendar  → 42501 new row violates row-level security policy
finance_approver  /payments/missing   → 42501 new row violates row-level security policy
```

**Aralıklı görünmesinin sebebi:** UPDATE yalnız bayrak *gerçekten* değiştiyse satır etkiler
(`where … risk_level is distinct from $2 …`). Bayraklar tazeyken hata çıkmıyordu. Yani salt-okur
kullanıcı, bayraklar bayatladığı her an (gün dönümü, herhangi bir veri değişikliği) çöken bir
ekranla karşılaşıyordu — bazen de karşılaşmıyordu.

**Elenen iki alternatif:**
- `runAsSystem()` ile yükseltmek — okuma isteğini yazma yetkisine yükseltmek olurdu; `/calendar`
  ayı `?ym=` ile geldiği için salt-okur bir kullanıcı istediği ay için üretim tetikleyebilirdi.
- 42501'i yakalayıp yutmak — gerçek bir yetki regresyonunu da sessizce gizlerdi.

**Seçilen:** bakım yazımı, çağıranın katmanı yazabiliyorsa yapılır; yazamıyorsa atlanır. İzin
listesi authz matrisinden **türetilir**, elle yazılmaz.

Kanıt (üretim sunucusu, gerçek oturum):

```
NEGATİF  viewer            render=ok  instances 0 → 0    (üretmiyor, çökmüyor)
POZİTİF  finance_operator  render=ok  instances 0 → 17   (yazma yolu sağlam)
NEGATİF  finance_approver  render=ok                     (çökmüyor)
```

### 2 · `/system/diagnostics` admin için çöküyordu (P0)

```
admin  /system/diagnostics  → permission denied for table schema_migrations
```

Bu bir yetki regresyonu **değil**, bilinçli bir karardır: `matrix.ts` defteri "owner connection
only" olarak işaretler ve `matrix.test.ts` her rol için erişimin kapalı olduğunu doğrular. Yanlış
olan politika değil, **sayfaydı** — uygulama katmanının hiçbir zaman okuyamayacağı bir tabloyu
koşulsuz sorguluyordu.

Mevcut `to_regclass(...) is not null` koruması yalnız "tablo YOK" hâlini düşünmüştü; "tablo VAR ama
bu katmana KAPALI" hâlini değil. İkisini aynı göstermek 87 migration'ı uygulanmış bir veritabanı
için yanlış bilgi olurdu.

**Kanıt:** KPI "okunamıyor", panelde gerekçe ve owner komutu yazılı, yanlış "defter yok" gösterimi
**0 kez**. Yalnız 42501 yutulur; başka her hata yükselir.

### 3 · Sessiz başarısızlık (P1)

`radar/actions.ts` reddedilen mutasyonu `errorRedirect(backTo, mesaj)` ile bitirir ve mesajı URL'e
yazar. **`backTo` hedeflerinin hiçbiri o parametreyi okumuyordu.** Repoda 28 yerde `?error=`
üretiliyor, yalnız 13 sayfa okuyordu.

Ölçülen (viewer, `/payments/missing`, "ödendi"):

```
POST yanıtı              303 /payments/missing
varılan URL              /payments/missing?error=instance%20not%20found
main metni değişti mi    HAYIR
toast / alert            yok
konsol hatası            yok
```

Kullanıcı düğmeye basıyor, sayfa yenileniyor, hiçbir şey söylenmiyor.

**Çözüm:** `src/components/ui/action-feedback.tsx` — sunucuda render edilen kalıcı şerit. Toast
değil: bu reddedilmiş bir **finansal** işlemdir, kaybolmamalı ve sayfa yenilendiğinde de
görünmeli.

### 4 · Yanlış teşhis (P1)

`select … for update`, RLS altında SELECT değil **UPDATE** politikasını uygular. Salt-okur
katmanların UPDATE politikası olmadığı için sorgu sıfır satır döner — satır orada olmasına rağmen.
Kod bunu "bulunamadı" diye okuyup kullanıcıya öyle söylüyordu.

Bir finans kullanıcısı için bu mesaj yanlış ve tehlikelidir: kaydın silindiğini düşündürür. Yanlış
teşhis, sessiz başarısızlıktan bir adım daha kötüdür — kullanıcıyı olmayan bir sorunu kovalamaya
yollar.

**Çözüm:** `instanceMissingReason()` — kilit boş dönünce satırın SELECT ile görünüp görünmediğine
bakar. 6 çağrı yerinde uygulandı.

### 5 · Yapılamayan işlem vaadi (P1)

Salt-okur roller "ödendi", "kısmi", "iptal", "kaydet" düğmelerini **etkin** görüyordu. Güvenlik
sağlamdı (DB değişmiyor, audit yazılmıyor) ama **vaat** yanlıştı.

**Çözüm:** `InstanceRowView`'a `canMutate` **zorunlu** prop. Varsayılanı yok, bilerek:
`canMutate?: boolean = true` yeni bir çağrı yerinin sessizce "herkes değiştirebilir" varsayımına
düşmesine izin verirdi. TypeScript 9 çağrı yerini de işaretledi.

---

## Full interaction inventory

Envanter **iki taraflıdır**, çünkü ikisi de tek başına eksiktir:

| Taraf | Araç | Ne bilir | Ne bilemez |
|---|---|---|---|
| Kaynak | `scripts/qa/interaction-inventory.ts` (TypeScript AST) | Kontrolün var olduğunu | Hangi rol/veri durumunda görüneceğini |
| Çalışma zamanı | `scripts/qa/runtime-interaction-crawl.ts` (5 rol, canlı sunucu) | Gerçekten görüneni | Görünmeyenin var olup olmadığını |

```
Kaynak taraması       270 kontrol tanımı, 0 orphan, 93 rota
Çalışma zamanı        2122 ayrık (rota, kontrol) çifti, 66 rota, 5 rol, 0 sorun
```

Doğrulama sınıfına göre dağılım:

```
1554  navigation    gerçek click → beklenen rota + 200 + sıfır konsol/5xx
 414  ui-state      gözlenebilir ve isimlendirilmiş UI durumu değişikliği
 131  mutation      DB before/after + audit + reload kalıcılığı
  23  export        dosya indirilir, açılır, içeriği doğrulanır
```

Önceki araç (`.testsprite/button-inventory.mjs`) **16 rota** tarıyordu; uygulamada 66 rota var.
Aradaki 50 rotanın kontrolleri hiçbir zaman "eksik" diye raporlanmadı, çünkü hiç keşfedilmediler.

---

### Gezinme süpürmesi — ölçülen

```
78 ayrık href ŞEKLİ gerçek click ile denendi   →  78/78 başarılı
7684 birim kanıtlandı                          →  0 başarısız
süre 22.3 dk (bu makinede, MAS_IX_SLOW=1 ile)
```

**Neden 78 ve 244 değil:** `/payments/<uuid>/edit` ile `/payments/<başka-uuid>/edit` iki ayrı
kontrol değildir — aynı tablo hücresinin iki satırıdır. UUID segmentleri `:id`'ye indirgenerek
gruplanır ve her şekil için ekranda o an duran bir örnek tıklanır. Bu hem maliyeti düşürür hem de
gerçek bir hatayı önler: satır kimlikleri tarama ile test arasında değişebiliyor ve süpürme
"href bulunamadı" diye ürünü haksız yere suçluyordu.

---

## Core actions verified end-to-end

Her mutasyon testinin zorunlu iskeleti: **DB'den before → gerçek click → UI → DB'den after →
audit → reload → kalıcılık.** Doğrulama bağlantısı uygulamanın havuzu değil, ayrı bir `pg.Client`
(owner) — katman rolüyle okumak RLS yüzünden yazılmış bir satırı görmeyebilir ve test "yazılmamış"
diye yanlış FAIL verirdi.

### ÖDEMEYİ ÖDENDİ İŞARETLE

```
Route:              /payments/missing
Role:               finance_operator
Browser click:      PASS  (gerçek 'ödendi' düğmesi)
DB state change:    PASS  status unpaid → paid, paid_at not null
audit_logs:         PASS  satır sayısı arttı
reload persistence: PASS  yeniden yükleme sonrası hâlâ paid
undo:               PASS  (aşağıda)
```

### GERİ AL (tersinirlik)

```
Route:              /payments/calendar?date=<vade>
Role:               finance_operator
Browser click:      PASS
DB state change:    PASS  status paid → unpaid, paid_at → null
audit_logs:         PASS  geri alma da iz bıraktı
reload persistence: PASS
```

> **Not — geri almanın yeri ölçüldü, tahmin edilmedi.** Ödenmiş bir örneği `InstanceRowView` ile
> render eden tek yol takvimin **gün** görünümüdür. Ay ızgarası satır listelemez:
> `/payments/calendar` → 0 satır, `/payments/calendar?date=2026-08-05` → 2 satır, 1 'geri al'.
> `/payments?view=history` ve `/payments/history` bu satırı göstermez. Bir ara "geri alma UI'da
> yok" sanıldı; yanlıştı.

### EKSİK TUTARI KAYDET

```
Route:              /payments/missing
Role:               finance_operator
DB state change:    PASS  amount NULL → 12345  (bilinmeyen sıfır sayılmadı)
reload persistence: PASS
```

### ÖDEME OLUŞTUR (pozitif + negatif)

```
Route:              /payments/new
Role:               finance_operator
NEGATİF: boş form → payments sayısı DEĞİŞMEDİ, kullanıcıya hata gösterildi, 500 yok
POZİTİF: payments 1 satır (due_day=15, default_amount=7500)
POZİTİF: payment_instances üretildi — "oluştur"un vaadi yalnız satır değil, takvimdir
```

### ÇIKIŞ YAP

```
Route:              /overview
Role:               viewer (kendi taze oturumu)
DB state change:    PASS  sessions.revoked_at set edildi, canlı oturum sayısı azaldı
backend enforcement: PASS  /overview → /login  (UI gizleme değil, gerçek reddediş)
```

---

## Permission/role results

Test edilen roller: `viewer`, `finance_operator`, `finance_approver`, `finance_manager`, `admin`.
Hepsi gerçek `/login` formundan geçirilerek oturum açar; `MAS_QA_BYPASS_AUTH` kullanılmaz.

Her mutasyon kontrolü için **iki soru ayrı ayrı** sorulur:

**S1 — Kontrol gösteriliyor mu?**

```
viewer            /payments/missing 'ödendi'  → hiç render edilmiyor
finance_approver  /payments/missing 'ödendi'  → hiç render edilmiyor
```

**S2 — Gizleme yetki değildir: server action doğrudan çağrılırsa?**

Yetkili rolün ekranından gerçek form alınır (action kimliği + gizli alanlar) ve **aynı istek**
yetkisiz rolün çerezleriyle gönderilir. `$ACTION_ID_…` alanlı urlencoded gövde, Next'in JS'siz form
gönderim yolunun aynısıdır — uydurma bir POST reddedilseydi Next'in action doğrulamasını ölçmüş
olurduk, yetki katmanını değil.

```
viewer            → HTTP 307, DB değişmedi, audit yazılmadı
finance_approver  → HTTP 307, DB değişmedi, audit yazılmadı
```

Ayrıca `/system/diagnostics` admin dışındaki rollerde `/overview`'a yönlendirilir (rota kapısı),
ve `/payments`, `/payments/calendar`, `/payments/missing` beş rolde de **çökmeden** render olur.

---

## External integrations

Bu denetimde `EXTERNAL_NOT_LIVE_VERIFIABLE` işaretlenen kontrol **yok** — çünkü çalışma zamanı
taramasında dış servise bağlı, canlı doğrulanamayan bir kontrol keşfedilmedi.

`tests/interaction/manifest.ts` içindeki `EXTERNAL_ALLOWLIST` boş ve kasıtlı olarak **katıdır**:
bir satır eklenecekse dört alanı da doldurmak zorunludur (`reason`, `ownerDecisionNeeded`,
`proofOfImplementation`, `mockTest`). Herhangi biri boş bırakılırsa kapı kırılır. Amaç tek:
"çalışıyor" kelimesinin dürüst kullanılmasını sağlamak. Mock HTTP istemcisiyle geçen bir buton
production-ready entegrasyon değildir.

---

## Controls intentionally unavailable

| Kontrol | Rol | Gerekçe |
|---|---|---|
| `ödendi`, `kısmi`, `iptal`, `kaydet` (ödeme örneği) | `viewer`, `finance_approver` | Katman `payment_instances` üzerinde salt-okur. Gösterilmiyor **ve** backend reddediyor (ikisi ayrı doğrulandı). |
| `/system/*` rotaları | `finance_operator` ve altı | `canSeeModule` rota kapısı; `/overview`'a yönlendiriliyor. |
| Migration defteri değerleri | tüm roller | `schema_migrations` tasarım gereği owner-only. Ekran bunu "okunamıyor" + gerekçe olarak **söylüyor**, "defter yok" diye yanlış göstermiyor. |

---

## Test methodology

**Ne kanıt sayılmaz** (hepsi bu repoda daha önce "PASS" saymıştı):

- butonda `onClick`/`formAction` bulunması · route'un 200 dönmesi · toast görünmesi
- URL'nin değişmesi · form submit'in hata vermemesi · TypeScript'in derlenmesi
- DOM'un değişmesi (optimistic render buna yeter)

**Ne kanıt sayılır:** mutasyonlar için uygulamadan bağımsız bir bağlantıyla okunan DB before/after
farkı, audit izi ve reload sonrası kalıcılık.

**Kapı üç girdiyi birleştirir** ve üçü de zorunludur:

| Girdi | Eksikse üretilen yanılsama |
|---|---|
| Keşif (`runtime-inventory.json`) | "6 test geçti" — 6'nın 2122'nin neresi olduğu bilinmez |
| Sözleşme (`manifest.ts`) | Kontrol "test edildi" sayılırken aslında yalnız 200 dönüp dönmediğine bakılmış olabilir |
| Kanıt (`evidence-*.json`) | Sözleşme yazılır, test yazılmaz; kağıt üstünde kapsam %100 |

Çalıştırma:

```bash
pnpm build
DATABASE_URL=…/mas_radar_interaction_verify PORT=3310 pnpm start   # QA bypass KAPALI
BASE_URL=http://127.0.0.1:3310 MAS_E2E_DATABASE_URL=…/mas_radar_interaction_verify \
  pnpm interaction:crawl && pnpm interaction:test && pnpm interaction:gate
```

CI'da aynı sıra `interaction-gate` job'ı olarak koşar (`.github/workflows/ci.yml`).

### Ölçüm yolunda düzeltilen dört harness kusuru

Bunlar rapora giriyor çünkü dördü de **ürün hatası gibi görünüyordu**:

1. **Bayat çerez kavanozu kapsamı sessizce sıfıra indiriyordu.** `.auth`'daki beş tokenin sha256'sı
   canlı oturumların hiçbiriyle eşleşmiyordu; `manager` ve `admin` 67 rotanın 67'sinde `/login`'e
   düştü ve tarama yine **"0 sorun"** raporladı — çünkü `/login` de geçerli bir sayfadır ve üstünde
   bir buton vardır. Tarama artık oturumunu kendi kurar.
2. **Çıkış testi paylaşılan oturumu harcıyordu.** Spec'ler alfabetik koşar; çıkış testi gezinme
   süpürmesinden önce `viewer` oturumunu öldürüyor, süpürme kaynak rotalarda `/login` görüyor ve
   244 href'in 244'ü kırmızı oluyordu. Test artık çerezsiz bir bağlamda kendi oturumunu açar.
   (`browser.newContext()` config'teki `use.storageState`'i **devralıyor** — bu ölçülerek bulundu.)
3. **Testler kendi fixture'ını tüketiyordu.** İkinci koşuda `/payments/missing` boşalıyor ve paket,
   ürün sağlamken kırmızı veriyordu. Testler artık ihtiyaç duydukları satırı garanti altına alır.
4. **Bellek.** Beş rolün tarayıcı bağlamı aynı anda açık tutulunca boş RAM 0.35 GB'a indi ve 2.5
   dakikalık süpürme 30 dakikada bitmedi. Artık rol başına tek bağlam açılıp kapatılıyor.

---

## Mutation-test evidence

"Test geçti" tek başına yeterli değildir; testin **bozuk davranışı yakalayabildiği** ayrıca
kanıtlandı. Üç aksiyon geçici olarak bozuldu, kapı koşturuldu, sonra geri alındı:

| Sabotaj | Kapının tepkisi |
|---|---|
| `markInstancePaid` UPDATE'i etkisizleştirildi (`and false`) | **KIRMIZI** — `Expected: "paid", Received: "unpaid"` |
| `logout` oturum iptali etkisizleştirildi (`and false`) | **KIRMIZI** — `Expected: < 12, Received: 12` |
| `createPaymentAction` `commit` → `rollback` | **KIRMIZI** — `Expected: 1, Received: 0` |

**Üçünde de UI başarılı görünüyordu**: redirect gerçekleşti, hata çıkmadı, toast yoktu. Yalnız DB
iddiası yakaladı. "Toast çıktı / form hata vermedi" neden kanıt sayılmadığının ölçülmüş gerekçesi
budur.

Öğretici bir dördüncü deneme: `createPaymentAction`'ın INSERT'ini bir `delete` ile geri almayı
denedim, test **yakalamadı** — çünkü RLS `finance_operator`'ün DELETE'ini sessizce 0 satıra
indiriyor. Sabotaj no-op'tu; test zayıf değildi. Sabotajın gerçekten bozduğunu da doğrulamak
gerekiyor.

Üç sabotaj da geri alındı; `grep -rn "MUTASYON TESTİ" src/` boş döner.

---

## Remaining blockers

Kapı şu an **KIRMIZI** ve sebebi açıkça raporlanıyor: `UNTESTED > 0`.

```
Interactive controls discovered: 2122
PASS:                          1561
EXPECTED DISABLED:                0
EXTERNAL NOT LIVE-VERIFIABLE:     0
FAIL:                             0
UNTESTED:                       561
```

Sınıf × yargı kırılımı (ölçülen):

```
navigation   1554 PASS      0 UNTESTED
mutation        5 PASS    126 UNTESTED
ui-state        2 PASS    412 UNTESTED
export          0 PASS     23 UNTESTED
```

`UNTESTED` olan 561 kontrolün tamamı manifestoda **sınıflandırılmış** (hangi doğrulama sınıfına
girdiği ve hangi testin karşılayacağı yazılı); eksik olan şey testlerin kendisi:

| Sınıf | Kalan | Yazılacak test |
|---|---|---|
| `ui-state` | 412 | `shell.spec.ts` — komut paleti, kenar çubuğu, grafik zoom/dönem/seri, tablo sıralama, sayfalama, kolon seçici, filtreler |
| `mutation` | 126 | `flows.spec.ts` genişletmesi — çek tahsil/karşılıksız, kredi oluştur, senaryo çalıştır, brifing/rapor üret, hatırlatıcı planla/gönder, görev yaşam döngüsü, varsayım onay/ret, onay akışı, içe aktarım, kullanıcı/rol yönetimi |
| `export` | 23 | `exports.spec.ts` — CSV parse, XLSX programatik açma, PNG/SVG/PDF imza doğrulaması |

Ayrıca **yazılmamış** olanlar (görev tanımında istenmişti, bu turda yetişmedi):

- Çift tıklama / hızlı submit / idempotency testleri (import, rapor üretimi, senaryo koşusu)
- Hata durumu UX testleri (DB kesintisi, 401/403/404/409, bozuk dış yük)
- Statik envanter ↔ manifesto CI karşılaştırması (şu an yalnız çalışma zamanı envanteri kapıya bağlı)

Bunlar "unutuldu" değil, **ölçülü kalan iş**: kapı her koşuda sayılarını basar ve azalmadıkça
yeşile dönmez.

---

## Kapı iki seviyeli: ratchet (PR) ve strict (release/cutover)

Kapı tek bir eşikle çalışıyordu ve UNTESTED > 0 olduğu için HER PR'ı kırmızıya boyuyordu. Bu,
uygulamada iki kötü sonuçtan birine götürür: ya kapı devre dışı bırakılır, ya da sayı gizlenir.
İkisi de güvenceyi yok eder. Bu yüzden kapı ikiye ayrıldı — **güvence düşürülmeden**.

| | `pnpm interaction:gate` (ratchet) | `pnpm interaction:gate:strict` |
|---|---|---|
| Kullanım | Günlük PR kapısı | Release / cutover |
| `FAIL > 0` | **KIRMIZI** | **KIRMIZI** |
| Manifestosuz kontrol | **KIRMIZI** | **KIRMIZI** |
| `UNTESTED > baseline` | **KIRMIZI** | — |
| `PASS < baseline` (kapsam gerilemesi) | **KIRMIZI** | — |
| `UNTESTED > 0` | hoş görülür (baseline'da kayıtlı) | **KIRMIZI** |
| Eksik allowlist beyanı | **KIRMIZI** | **KIRMIZI** |

**Ratchet'in verdiği söz "kapsam GERİLEMEZ"dir**, "her şey test edildi" değil. 561 birimlik test
borcunu tek PR'da kapatmak gerçekçi değil; her PR'ın borcu **büyütmemesi** gerçekçi.

**Baseline** `docs/interaction-audit/baseline.json` — küçük, elle okunabilir, git'te izlenen tek
dosya. Büyük runtime kanıt dosyaları baseline OLAMAZ: bir insanın PR diff'inde "bu sayı neden
yükseldi?" diye bakabileceği tek şey budur.

- **Düşürmek her zaman serbest** ve teşvik edilir — borç azaldığında kapı bunu söyler
  ("Baseline'ı bu değere ÇEKİN") ki kazanım kilitlensin.
- **Yükseltmek `raisedBecause` olmadan mümkün değil.** Boş bırakılırsa kapı kırmızı verir. Bu kural
  olmasaydı kapı kendi kendini etkisizleştirirdi: kırmızı görünce tavanı bir tık yukarı çekmek
  yeterli olurdu.

CI'da ikisi de koşar: ratchet PR'ı bloklar, strict `continue-on-error: true` ile **bloklamadan**
release hazırlığını her koşuda görünür kılar. Strict'in bugün kırmızı olması beklenen sonuçtur;
yeşile çevirmenin tek yolu testleri yazmaktır — sayı gizlemek, allowlist'e taşımak veya testi
gevşetmek değil.

Karar kuralları saf bir fonksiyonda (`scripts/qa/interaction-gate-rules.ts`) ve 13 deterministik
birim testiyle doğrulanıyor (`tests/interaction-gate-rules.test.ts`, <1 sn): FAIL mevcut,
manifestosuz kontrol mevcut, UNTESTED baseline üstünde/altında, strict'te UNTESTED > 0, gerekçeli
ve gerekçesiz baseline yükseltme, boşluktan ibaret gerekçe, düşürme.

---

## Final gate results

```
pnpm lint                         PASS   (0 uyarı)
pnpm typecheck                    PASS
pnpm test                         PASS   (56 dosya, 1304 test)
pnpm build                        PASS
production-server browser smoke   PASS   (66 rota × 5 rol, 0 sorun)
console errors                    0
page errors                       0
HTTP 5xx                          0
unmapped interactive controls     0      (2122/2122 manifestoda sınıflandırıldı)
untested internal controls        561    ← kapı bu yüzden KIRMIZI
full interaction gate             KIRMIZI
```

### Sorunun cevabı

> **"MAS Nakit Radar UI'ında kullanıcıya aktif olarak gösterilen bütün dahili buton ve aksiyonlar,
> vaat ettikleri işi gerçekten yapıyor mu?"**

**Henüz tam olarak kanıtlanmadı — ama artık ölçülüyor ve eksik kısım sayıyla biliniyor.**

Kanıtlanan: 2122 kontrolün **1561'i**, gerçek tıklama ile ve — mutasyonlarda — veritabanı
before/after farkıyla doğrulandı. **0 FAIL.** Bulunan 5 gerçek kusur düzeltildi ve düzeltmeler
yeniden ölçüldü.

Kanıtlanmayan: **561** kontrol. Hepsi keşfedilmiş, hepsi sınıflandırılmış, hiçbiri gizlenmemiş.
Kapı bunlar için yeşil vermiyor ve vermeyecek.

Bu denetimin asıl kazancı sayı değil, **sayının artık var olması**: önceki araç 16 rota tarıyor ve
"konsola hata düşmedi" ölçütüyle PASS veriyordu — bugün bozulan `markPaid`, `logout` ve
`createPayment` aksiyonlarının üçünü de yeşil geçirirdi.
