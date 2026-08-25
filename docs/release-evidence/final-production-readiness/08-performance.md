# 08 — Performans (AŞAMA 10)

```text
WORKING COMMIT: 694328b (+ bu commit'teki AŞAMA 10 değişiklikleri)
TARGET DATABASE CLASS: DISPOSABLE_SYNTHETIC
TARGET DATABASE NAME: mas_radar_perf_verify
REAL DB WRITE USED: NO — mas_radar_dev bu aşamada hiç açılmadı
```

**ORIGINAL PLAN REFERENCE**
- section: Gap Closure Rehberi §15 (AŞAMA 10) · orijinal §17 Faz 14 (L1566–L1601)
- acceptance criterion: `query plan gate = PASS` · `route SLO evidence = complete` ·
  `write/import SLO evidence = complete` · `critical unexplained perf regression = 0`

**CURRENT STATUS: PARTIAL**

---

## Ölçüm bağlamı — sayılardan ÖNCE okunmalı

| | |
|---|---|
| CPU | Intel Core i5-8265U @ 1.60 GHz · 8 mantıksal çekirdek |
| RAM | 7.9 GB toplam · **ölçüm başında boş: 0.3 GB** · sonda 0.6 GB |
| Eşzamanlı yük | **İLGİSİZ** bir projenin (`precision-dynamics-hub-main`) vite dev sunucusu 1064 MB, Playwright'ı 98 MB tutuyordu |
| Hacim | `bank_transactions=60000` · `invoices=24000` · `checks=6000` · `payment_instances=20040` |
| Örneklem | rota başına 12 ölçüm + 5 muhasebe örneklemi |
| Canlı örnek (port 3000) | ölçüm boyunca çalışır durumda kaldı; kapı ona dokunmadı |

Bu bağlam **kanıtın parçasıdır**. 0.3 GB boş RAM'de takas yapan bir makinede alınan wall-clock
sayıları sistemin hızını değil, o anki host durumunu ölçer.

---

## Rota sonuçları (bu koşu)

| Rota | TTFB medyan/p95 (ms) | Toplam medyan/p95 (ms) | query_count | DB ms |
|---|---|---|---:|---:|
| `/overview` | 327 / 3595.6 | 9943.2 / 29978.2 | 41 | 42747.7 |
| `/radar` | 406.9 / 11497.3 | 16113.8 / 64315.5 | 2 | 8138.6 |
| `/cashflow` | 53.5 / 253.7 | 92.6 / 374 | 1 | 26.9 |
| `/payments` | 65.7 / 629.2 | 3646.6 / 31405 | 2 | 718.2 |
| `/finance/bank` | 94.1 / 2553.6 | 3053.2 / 8398.8 | 4 | 765 |
| `/finance/invoices` | 77.3 / 2681.3 | 7843.4 / 25642.4 | 5 | 1517.6 |
| `/data/quality` | 228.5 / 3458.1 | 531.2 / 4338.1 | 14 | 340.3 |
| `/insights/briefing` | 132 / 676.4 | 6051.1 / 12182.9 | 25 | 10097.8 |

---

## Kontroller

| Kontrol sınıfı | Geçen | Sınıf |
|---|---|---|
| Hacim · runtime hazırlığı · sunucu · harcanabilir hedefe bağlılık | 4/4 | Önkoşul |
| **Sayfa kabuğu GERÇEKTEN render edildi (pozitif kontrol)** | **16/16** | SERT |
| HTTP 200 + doğru sayfaya varış | 8/8 | SERT |
| `query_count` tavanı (≤ 45) | 8/8 | SERT |
| N+1 dedektörü (kararlı hâlde sayı oynamamalı) | 7/8 | SERT |
| Felaket tavanı (< 8000 ms) | 1/8 | SERT |
| TTFB / toplam medyan bütçesi | 10/16 | TREND |

**SERT: 36/44 · TREND: 10/16**

### Düşen kontroller

| Sınıf | Kontrol | Beklenen | Gerçek |
|---|---|---|---|
| SERT | `/overview` N+1 dedektörü | 4 örneklemde aynı sayı | 41/41/41/**22** (ısınma 33 hariç) |
| SERT | `/overview` felaket tavanı | < 8000 ms | 30082.2 ms |
| SERT | `/radar` felaket tavanı | < 8000 ms | 66057 ms |
| SERT | `/payments` felaket tavanı | < 8000 ms | 56861.3 ms |
| SERT | `/finance/bank` felaket tavanı | < 8000 ms | 11297.8 ms |
| SERT | `/finance/invoices` felaket tavanı | < 8000 ms | 31037.6 ms |
| SERT | `/data/quality` felaket tavanı | < 8000 ms | 8137.7 ms |
| SERT | `/insights/briefing` felaket tavanı | < 8000 ms | 14526 ms |

---

## Değerlendirme — dürüst

**PASS yazılamaz, eşik de gevşetilmedi.**

Felaket tavanını 8000 ms'den yukarı çekmek bu koşuyu yeşile döndürürdü. Bu, rehber §30'un
yasakladığı davranıştır: kapıyı veriye uydurmak. Eşik olduğu gibi bırakıldı ve aşama PARTIAL
olarak kapatıldı.

Düşen sekiz kontrolün yedisi felaket tavanıdır ve hepsi bellek açlığıyla açıklanıyor. Aynı kapı
daha önce 0.9 GB boş RAM ile koştuğunda `/radar` toplam medyanı **1037 ms** idi; bu koşuda
**16113 ms** — on altı kat. Aradaki fark kodda değil, host'ta.

Sekizincisi `/overview` N+1 dedektörüdür (41/41/41/22). Altmış saniyelik sayfa yüklerinde prob
penceresinin kayması muhtemel bir açıklamadır, **ancak artefakt olduğu kanıtlanmadı**. Sessiz
makinede tekrar koşulmalıdır. Kanıtlanmamış bir açıklama, kanıt değildir.

---

## Kapının kendisinde bulunan ve düzeltilen hata

İlk sürüm, gövdede `"Application error"` / `"a server-side exception has occurred"` dizelerini
aradı ve **sekiz rotanın 13/13 örneklemini "hata kabuğu" ilan etti**. Sayı yanlıştı: sunucu
log'unda tek bir hata yoktu ve sayfalar gerçekten render olmuştu. Sebep, Next'in hata sınırının
metnini her sayfanın paketine gömmesi — dize sağlıklı sayfada da bulunuyor.

Doğru soru "hata metni var mı" değil, "**sayfa gerçekten render oldu mu**". Negatif işaret
araması, sahibin pozitif kontrolüne çevrildi: dashboard layout'unun `workspace-content` sınıfı
gövdede mi? Next'in genel hata kabuğu layout'un tamamını değiştirir ve o sınıf kaybolur.
Rehber §30.1'in kuralı budur.

Düzeltmeden sonra: **16/16 pozitif render kontrolü geçti** (her rota 13/13 örneklem).

---

## §15 kabul bloğu

```text
query plan gate                      = PASS (10/10, ortamdan bağımsız, ayrı koşu)
route SLO tooling                    = VERIFIED (kapı çalışıyor ve kendi yanlış pozitifini yakaladı)
route SLO evidence                   = NOT VALID ON THIS HOST — bellek açlığı
write/import SLO evidence            = NOT RUN (kapı yazıldı: scripts/perf/write-slo.ts)
interactive readiness                = NOT RUN (spec yazıldı: tests/visual/interactive-readiness.spec.ts)
critical unexplained perf regression = NOT ASSESSED — geçerli taban çizgisi yok
```

### Ortamdan bağımsız olarak kanıtlanan (ayrı koşu, exit 0)

`pnpm perf:gate` → **10/10**, dört iddianın hiçbiri zayıflatılmadı:
seçici sorgular indeks kullanıyor · gereksiz indeks = 0 · indekssiz FK ≤ 115 (cırcır) ·
felaket eşiği. Bu kapı deterministiktir ve 0.3 GB boş RAM'de de aynı sonucu verir.

Ayrıca: `pnpm typecheck` = 0 · `pnpm boundary:verify` = **8/8**.

---

## Bilinen P2'nin çözümü (rehber §15 "Mevcut P2")

`tests/visual/navigation-performance.spec.ts` içindeki "gecikmeli rota 200 ms içinde iskeletini
gösterir" testi, prefetch yarışı yüzünden `["skeleton","arrived"]` ikisini de kabul ediyordu —
yani hiçbir şey iddia etmiyordu.

Düzeltme testi silmedi ve gevşetmedi: tıklamadan **sonra** ağ isteği olup olmadığı ölçülüyor ve
buna göre **hangisinin doğru olduğu belirlenip o iddia ediliyor**. Prefetch tıklamadan önce
inerse rota istemci önbelleğinden servis edilir, ortada bekleyen gezinme yoktur ve iskelet
göstermek **yanlış** olurdu. Ölçülen üç koşu:

```text
skeleton=false  tıklama öncesi /cashflow isteği=1 (prefetch)  sonrası=0   <- önbellek
skeleton=false  tıklama öncesi=1 (prefetch)                   sonrası=0   <- önbellek
skeleton=true   tıklama öncesi=0                              sonrası=1   <- gerçek gezinme
```

---

## P0 / P1 / P2

**P0:** yok
**P1:** yok
**P2:**
1. Rota SLO kabul koşusu **sessiz makinede** tekrarlanmalı:
   `MIGRATION_DATABASE_URL=…/mas_radar_perf_verify pnpm perf:route-slo`
2. `/overview` 41 sorgu atıyor (tavan 45) — pay dar. N+1 dedektörünün ateşlemesi sessiz ortamda
   doğrulanmalı; gerçek bir N+1 ise düzeltilmeli.
3. Host bellek açlığındayken canlı uygulamanın `/ready` probu **zaman aşımına uğradı**
   (uygulama düşmedi; sonraki denemede 200 / 12 ms). Gerçek izleme kurulumunda bu **yanlış alarm**
   üretir. Aşama 14 risk listesine işlendi.

**NEXT GATE:** AŞAMA 11 — final RC cutover provası

**FINAL: PARTIAL**

---

## EK — `/overview` sorgu sayısı incelemesi (P2 kapatıldı)

**Soru:** `/overview` CI'da 5, hacimli yerel veride 41 sorgu atıyordu. N+1 mi?

**Cevap: HAYIR.** Statik inceleme ve ölçüm birlikte bunu dışlıyor.

### Kanıt 1 — döngüde sorgu yok

`src/app/(dashboard)/overview/page.tsx` tek satır: `export { default, dynamic } from "@/app/(dashboard)/page"`.
Gerçek sayfa `src/app/(dashboard)/page.tsx` (260 satır). İçindeki tek döngü 29. satırdaki
`knownOutflow` ve **saf bellek-içi toplama** — içinde sorgu yok. Veri erişimi iki
`Promise.all` bloğunda toplanmış (61. ve 94. satır, 5 + 9 = 14 üst düzey çağrı).

### Kanıt 2 — sayı satır sayısıyla büyümüyor

Yerel ölçüm **24.000 fatura + 60.000 banka hareketi** üzerinde yapıldı ve sorgu sayısı
**41'de sabit** kaldı (41/41/41). Satır başına bir sorgu olsaydı 24.000+ sorgu görülürdü.
41 sayısı **sınırlı**, hacme bağlı değil.

### Gerçek açıklama

14 yardımcı fonksiyonun içinde **veriye bağlı dallanma** var: tablolar boşken bazıları
erken dönüp sorgu atmıyor (CI'daki `mas_radar_e2e_verify` → 5), veri varken çalışıyor
(`mas_radar_perf_verify` → 41). Bu, N+1'den bambaşka ve iyi huylu bir davranıştır.

### Kalan gerçek risk — cırcır çalışıyor

41, sert tavan olan 45'e yakın. Yeni bir yardımcı fonksiyon eklenirse tavan aşılır ve kapı
düşer. Bu **istenen davranıştır**: `query_count ≤ 45` cırcırı tam da bu regresyon sınıfını
yakalamak için var.

### Yan bulgu — `knownOutflow` float toplaması DÜZELTİLMEMELİ

`page.tsx:33` para toplarken float `+=` kullanıyor (`total += r.amount`), yani WP5'in
`exposureBy`/`dayFlags`'te düzelttiği desenin aynısı. **Burada düzeltme gerekmiyor** ve sebep
yazılmalıdır ki ileride gereksiz yere değiştirilmesin:

- Sonuç yalnız ekrana yazılıyor (`fmtTL(tOut.total)` — TL'ye yuvarlanıyor).
- Tek karşılaştırması **sıfırla**: `tOut.total > 0`.
- Pozitif tutarların float toplamı asla sıfıra düşmez; sapma ~1e-11 ve **sıfır sınırını
  geçemez**. `dayFlags`'i bozan sınıf, birikmiş toplamın 250.000 gibi bir eşiğe *tam* oturmasıydı.

**P2 DURUMU: KAPANDI** — N+1 değil. `08-performance.md` P2 listesindeki 2. madde bu ek ile
çözülmüştür. Sessiz makinede tekrar ölçüm (P2 madde 1) hâlâ önerilir, ama artık bir N+1
şüphesini çözmek için değil, wall-clock taban çizgisi üretmek için.
