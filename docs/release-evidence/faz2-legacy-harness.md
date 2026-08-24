# Faz 2 — legacy Playwright harness kanıtı

**Tarih:** 2026-08-24 · **Branch:** `release/production-readiness-hardening`
**Hedef DB sınıfı:** `DISPOSABLE_SYNTHETIC` — `mas_radar_visual_verify`, izole sandbox cluster
(`mas-radar-pg-faz2-sandbox`, port 55433). Gerçek `mas_radar_dev`'e bağlantı **yok**.

---

## 1. Kök sorun ve çözüm

Eski paket `MAS_QA_BYPASS_AUTH=1` arkasında çalışıyordu. Bypass `getCurrentUser()` içinde
(Node, DB'li) onurlandırılıyor ve **çerezsiz** bir kullanıcı döndürüyor; `src/middleware.ts` ise
Edge tarafında **yalnız çerez varlığına** bakıyor. İkisi birbirini görmüyor:

```text
GET /overview -> middleware çerez yok      -> 307 /login
GET /login    -> sayfa getCurrentUser()'ı  -> redirect(next) -> /overview
                 bypass cevapladı
GET /overview -> middleware hâlâ çerez yok -> 307 /login      ... sonsuz
```

Ayrıca `getQaBypassUser()` `NODE_ENV === "production"` iken `null` döner — bu paketin hedefi zaten
production build olduğu için bypass orada yapısal olarak ölü.

**Çözüm:** `tests/visual/global-setup.ts` beş rolü disposable DB'ye seed eder, her birini
**gerçek `/login` formundan** giriş yaptırır ve `storageState` kaydeder:
`viewer.json`, `operator.json`, `approver.json`, `manager.json`, `admin.json`.
Doğrulama: her rol için giriş sonrası `mas_session` çerezi aranır; yoksa sert hata verir.

Sunucunun gerçekten kapalı olduğu ölçüldü:

```text
curl /overview (çerezsiz) -> 307 -> /login?next=%2Foverview
```

## 2. Faz 2 PASS kriterleri

| Kriter | Durum | Kanıt |
|---|---|---|
| legacy harness auth loop yok | **PASS** | 5 storageState üretildi; 35 testin hiçbiri `/login`'e düşmedi |
| hard-coded port 0 | **PASS** | `grep -R "127.0.0.1:31" tests/visual` → **0 sonuç** |
| critical semantic smoke green | **PASS** | 35/35 semantik kapıyı geçti; `legacy-semantic-smoke` 10/10 |
| visual failures 0 veya açıklanmış delta | **AÇIKLANMIŞ** | 20 pixel deltası (bölüm 4) + 1 performans bulgusu (bölüm 7) |
| ürün ↔ harness regresyonu ayrılabiliyor | **PASS** | 21 başarısızlığın 20'si yalnız `toHaveScreenshot`, 1'i adlandırılmış performans iddiası |

## 3. Spec sonuçları (izole sandbox, gerçek oturum, `workers: 1`)

Son tam koşu — 35 test, **14 PASS / 21 FAIL**:

| Spec | Sonuç |
|---|---|
| `payment-iteration-15.spec.ts` | **8/8 PASS** (4 assertion düzeltildi, bölüm 5) |
| `navigation-visual.spec.ts` | **3/3 PASS** (ekran görüntüleri dâhil) |
| `navigation-performance.spec.ts` | **3/4 PASS** — kalan 1: bölüm 7 |
| `dashboard.spec.ts` | 8/8 semantik PASS · 8/8 pixel FAIL |
| `analytics.spec.ts` | 12/12 semantik PASS · 12/12 pixel FAIL |

Başarısızlıkların sınıf dağılımı (son koşu, birebir çıktı):

```text
20  Error: expect(page).toHaveScreenshot     -> baseline deltası (bölüm 4)
 1  Error: 200ms içinde ne iskelet ne varış  -> performans bulgusu (bölüm 7)
```

**Hiçbir auth hatası, hiçbir semantik hata, hiçbir harness flake'i kalmadı.**

Faz 1 paketleri aynı yapılandırmada regresyona uğramadı:
`legacy-semantic-smoke` **10/10**, `phase17-38-routes` **94/94**.

## 4. 20 pixel farkının kök nedenleri

Hiçbiri "ekran bozuk" değil; hepsi baseline'ın artık farklı bir şeyi resmetmesi.

**(a) `data-vr` mekanizması hiç çalışmamış.** Üç spec'in init script'i
`document.documentElement` henüz yokken çalışıp patlıyordu; `data-vr` **hiç set edilmedi** ve
`[data-volatile]` düğümleri her karede görünür kaldı. Yani mevcut baseline'lar zaman damgası
içeriyor ve takvimle birlikte kayıyor. Ölçüm:

```text
BROKEN : data-vr=null  pageerrors=1  [data-volatile] firstVisible=true
FIXED  : data-vr=1     pageerrors=0  [data-volatile] firstVisible=false
```

**(b) Dört baseline artık başka bir sayfanın resmi.** `next.config.ts` kalıcı 301 uygular:
`/radar→/payments`, `/financing→/finance`, `/reports→/insights/reports`,
`/reminders→/insights/reminders`. `radar.png` bugün `/payments` ekranını gösteriyor; dosya adından
bunu anlamak mümkün değildi. Spec artık `expected` sütunuyla hedefi açıkça yazıyor.

**(c) Sayfa yükseklikleri değişmiş.** Ölçülen farklar 0,19–0,75 pixel oranı aralığında; birkaçında
beklenen/gerçek yükseklik belirgin biçimde farklı (ör. beklenen 2620px, gerçek 720px).

**Baseline'lar GÜNCELLENMEDİ.** `docs/visual-snapshot-policy.md` altı koşul sayıyor; bunlardan
"screenshot bir insan tarafından incelendi" ve "PR'da before/after görsel kanıt" karşılanamaz —
onları karşılayacak olan insandır, ajan değil. Kök neden yazıldı, karar insana bırakıldı.

## 5. `payment-iteration-15.spec.ts` — hiç yeşil olmamış dört assertion

Gerçek oturum kurulduktan sonra sayfalar açıldı ve dört kontrol hâlâ kırmızıydı. Her biri çalışan
sunucuya ve git geçmişine karşı incelendi; **dördünde de spec yanılıyordu**:

| Assertion | Gerçek | Kanıt |
|---|---|---|
| `age=91-plus` | kova anahtarları `1-30 / 31-90 / 91+` | `git log -S "91-plus" -- src/` **boş**; `?age=91%2B` "91+ gün gecikmiş" render ediyor |
| `/arşivlenmiş ödeme/` | panel "1 ARŞİVLENMİŞ KALEM" | `git log -S "arşivlenmiş ödeme" -- src/` **boş** |
| `getByText("Yarın").first()` | 3 eşleşme, **ilki gizli** | `.first()` görünmez düğümü seçip "görünür" iddia ediyordu |
| `a[href="…status=paid"]` | 2 eşleşme (sekme + "Temizle") | strict mode ihlali; `[aria-current="page"]` ile tekilleşti |
| period link döngüsü (`3A/6A/12A/24A`) | `a[href*="period="]` **hiç yok** | `git log -S 'period=' -- src/app` **boş** |
| `Ödeme Arşivi` başlığı görünür | kasten **gizli** | `globals.css:417` `.module-content > header:first-child{display:none}` |

Son satırın kronolojisi sınıflandırmayı kesinleştiriyor: spec `8f068b1` ile **19:23**'te eklendi,
dokuz-modül yeniden yapılandırması `5deed68` `ModuleFrame`'i ve o CSS kuralını **19:24**'te getirdi.
Assertion yazıldığında doğruydu; bir dakika sonra **bilinçli bir bilgi mimarisi değişikliğiyle**
geçersiz kaldı ve kimse geri dönüp güncellemedi. Regresyon değil.

Düzeltmelerde hiçbir assertion zayıflatılmadı: kova etiketi, arşiv sayacı, KPI etiketi ve aktif
sekme işareti hâlâ gerçekten doğrulanıyor. Gizli başlık için hem **var olduğu** hem de
**görünmediği** iddia ediliyor, böylece görünür hâle getirilmesi de yakalanır.

## 6. Yol boyunca düzeltilen iki harness kırılganlığı

- **Giriş oran sınırı.** `RATE_RULES.login` 60 saniyede 10 deneme. Beş rol = beş giriş; paketi
  arka arkaya çalıştırmak sınırı aşıp `/login?error=rate` üretiyordu ve mesaj yalnız "30s
  navigation timeout" diyordu. globalSetup artık durumu tanıyıp pencereyi bekliyor. Sınır
  **gevşetilmedi** — çalışıyor olması doğru.
- **Giriş sonrası yarış.** `waitForLoadState("load")` tıklamadan önce zaten yüklü sayfaya karşı
  çözülüp gönderim öncesi URL'i okuyabiliyordu. `loginAction` her durumda redirect ettiği için
  (başarı → `next`, hata → `?error=1|rate`) beklenti artık bu üç sonucu birden kapsayan bir
  predicate.
- **`analytics.spec.ts` serial modu.** İlk başarısızlık diğer 11 testi "did not run" yapıyordu;
  testler durum paylaşmadığı için kaldırıldı (çalıştırma yine sıralı: `fullyParallel: false`).

## 7. Kalan tek başarısızlık — gerçek bir performans bulgusu, harness kusuru değil

`navigation-performance.spec.ts › a delayed route reveals its skeleton within 200ms`.

Bu test önce **yanlış nedenle** kırmızıydı. Eski hâli 200 ms içinde koşulsuz bir iskelet istiyordu.
Ölçüldü (tıklama etrafındaki `/cashflow` istekleri sayılarak):

```text
skeleton=false  tıklamadan önce=1 (prefetch)  tıklamadan sonra=0   -> cache'ten geldi
skeleton=false  tıklamadan önce=1 (prefetch)  tıklamadan sonra=0   -> cache'ten geldi
skeleton=true   tıklamadan önce=0             tıklamadan sonra=1   -> 68 ms
```

Next, `/overview` yerleşince kenar çubuğundaki `<Link>` hedeflerini prefetch ediyor. Prefetch
yarışı kazandığında rota istemci cache'inden geliyor, **bekleyen bir navigasyon yok**, dolayısıyla
iskelet de olmamalı — test ürünü hızlı olduğu için başarısız sayıyordu.

Denenip **reddedilen** iki yol: `route.abort()` (iptal edilen fetch "Failed to fetch" konsol hatası
üretiyor, §5.3 kapısı haklı olarak sayfayı düşürüyor) ve prefetch'i açık tutmak (bir artefaktı
başkasıyla değiştiriyor — bağlantı meşgul kalıyor).

Şimdi ürünün gerçekten verdiği söz doğrulanıyor: **200 ms içinde kullanıcı ya varmıştır ya da bir
iskelet görüyordur.** Prefetch yarışını kim kazanırsa kazansın deterministik; "ikisi de değil" hâlâ
kırmızı veriyor.

Ve bu makinede "ikisi de değil" üç koşunun ikisinde gerçekleşiyor. Yani kalan kırmızı **gerçek bir
gözlem**: gecikmeli bir rotada kullanıcı bazen 200 ms boyunca ne geri bildirim ne varış alıyor.
Maskelenmedi. Sınıflandırma: **P2 performans** (planın Faz 14 performans kapısının konusu), Faz 2
harness kriterinin ihlali değil — çünkü artık ürün gözlemi ile harness kusuru birbirinden
ayrılabiliyor, ki Faz 2'nin istediği tam olarak buydu.

Ölçüm ortamı dürüstlük payı hak ediyor: aynı makinede Postgres konteyneri, Next production sunucusu
ve Chromium eşzamanlı çalışıyor. Temiz bir performans ortamı değil.

## 8. Yol boyunca düzeltilen üçüncü kırılganlık — `workers: 1`

`fullyParallel: false` **tek başına yetmiyor**: yalnız dosya İÇİNDEKİ testleri sıralar, ayrı dosyalar
worker'lar arasında paralel koşmaya devam eder (varsayılan = CPU/2). Ölçüldü: spec'ler tek tek
koşturulduğunda her şey geçiyordu; beşi birlikte koşturulduğunda üç zamanlama iddiası düşüyordu
(`.navigation-progress` gizli, "Route skeleton did not appear within 200ms") — ekran görüntüsü
başarısızlıkları ise birebir aynı kalıyordu. Yani ölçülen şey ürün değil, işletim sistemi
zamanlayıcısıydı. `workers: 1` paketi gerçekten sıralı hâle getirdi ve bu iki flake kayboldu.
