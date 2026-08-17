# MAS Nakit Radar — Final Regresyon Raporu (2026-08-12)

Bu tur, `qa-report-2026-08-10.md`'den bu yana yapılan **8 bulguluk düzeltme dizisinin** ardından
güncel koda karşı yapılan doğrulamadır. Kaynak kod değiştirilmedi; bu bir doğrulama turudur.

Ortam: `mas_radar_dev`'in atılabilir kopyası, gerçek admin oturumu, **production build**
(`next build && next start`).

## Neden iki ayrı geçiş

Önceki tarama yalnız `page.goto()` kullanıyordu — bu "sayfa çöküyor mu" sorusunu cevaplar.
Ama **Bulgu #7, #8 ve PageHeader-CSS'in üçü de gerçek link tıklamasıyla** bulundu; `page.goto()`
bu sınıfı hiç yakalamaz. İkisi de çalıştırıldı.

---

## GEÇİŞ 1 — tam rota taraması (`browser_crawl.py`, `page.goto()`)

| Ölçüt | Sonuç |
|---|---|
| Ziyaret edilen sayfa | **150** |
| HTTP ≥400 veya 0 | **0** |
| Konsol hatası | **0** |
| Durum kodu dağılımı | `{200: 150}` |
| Oturumsuz istekte middleware yönlendirmesi | PASS |
| Giriş | PASS |

Crawler'ın `DYNAMIC_TEMPLATES` listesine üç **kanonik** şablon eklendi
(`/data/imports/{workbook_id}`, `.../reviews`, `.../sheets/{sheet_id}`) — Bulgu #5/#7 turlarında
gerçek içerik oraya taşındığı hâlde tarama yalnız legacy yolları kapsıyordu. Yalnız yol şablonu
eklendi, script mantığına dokunulmadı.

### Form testlerinden biri FAIL — ama uygulama regresyonu DEĞİL
`Yeni dış varsayım ekle` testi "form alanları bulunamadı" diyor. Crawler `description` ve `url`
adlı alanlar arıyor; `/data/assumptions` sayfasında bu adlar **hiç var olmamış**
(`git log -S'name="description"'` boş döndü). Sayfadaki gerçek alanlar: `label`, `assumptionType`,
`valueNumeric`, `sourceKind`, `sourceUrl`, `periodStart`, `notes` …

Yani crawler baştan yanlış seçiciyle yazılmış. **Bu turda düzeltilmedi** (test beklentisini
uygulamaya uydurmak, gerçek bir regresyonu maskeleme riski taşır) — bkz. Bulgu #9.

---

## GEÇİŞ 2 — gerçek link tıklamasıyla kritik yollar

| # | Kontrol | Sonuç |
|---|---|---|
| 1 | PageHeader `action` butonu görünür **ve** tıklanabilir (8 sayfa) | **8/8 PASS** |
| 2 | `data-hard-nav` linkleri çalışıyor **ve** gerçekten tam sayfa yüklüyor (4 link) | **4/4 PASS** |
| 3 | Hiçbir geçiş "yükleniyor"da takılı kalmıyor (10 modül-içi geçiş, tıklamadan 5 sn sonra) | **10/10 PASS** |
| 4 | Bulgu #1/#2/#6 fonksiyonel doğruluğu | **4/4 PASS** |
| 5 | Legacy rota yönlendirmeleri (6 örnek) | **6/6 PASS** (308 + doğru hedef) |
| — | Konsol hatası (filtresiz, tüm adımlar) | **0** |

### Madde 1 — PageHeader action (global CSS düzeltmesinin regresyonu)
`/system` · `/payments` · `/finance` · `/finance/loans` · `/finance/checks` · `/cashflow` ·
`/payments/history` · `/payments/archive` — sekizinde de buton görünür, `force` olmadan
tıklanabilir ve doğru hedefe gitti.

### Madde 2 — `data-hard-nav`
`/data/imports` → workbook detay · workbook detay → incelemeler · `/finance/loans` → kredi adı ·
`/finance/loans` → "Taksit planı". Dördü de vardı **ve** `load` olayı fırladı (gerçek tam sayfa
yüklemesi, yani kaçış kapısı fiilen devrede).

"Taksit planı" ilk denemede FAIL göründü; sebep testin `ActionMenu` dropdown'ını açmamasıydı.
Menü açılarak tekrarlandı: link `data-hard-nav`'lı, çalışıyor, tam sayfa yüklüyor.

### Madde 3 — Bulgu #8 regresyonu
10 farklı modül-içi geçişte, tıklamadan 5 sn sonra `navigation-pending` ve `aria-busy`
**hepsinde temiz**. Kalıcı "yükleniyor" durumu yeniden üretilemedi.

### Madde 4 — özelliklerin fonksiyonel doğruluğu
- **Bulgu #1** — bir çek "tahsil edildi" işaretlendi, liste güncellendi ✓
- **Bulgu #1** — bir kredi taksiti "ödendi" işaretlendi, liste güncellendi ✓
- **Bulgu #6** — `/production/capacity`'de "ETKİN DAKİKA (AYLIK)" ve "TALEP DAKİKA (YILLIK)" ayrı
  kartlar; "AÇIK / FAZLA" kartı **yok** ✓
- **Bulgu #2** — "TEORİK AYLIK GELİR" ve "GERÇEK AYLIK GELİR" kartları mevcut ✓

---

## 2026-08-10'dan bu yana kapanan bulgular

| Bulgu | Durum | Referans |
|---|---|---|
| #1 çek/taksit yerleşimi hiç işaretlenemiyordu | **çözüldü** | f6a05ff, 37d2aa4 |
| #2 teorik vs gerçek gelir paneli kayıptı | **çözüldü** | 66ed07c |
| #3 `calculateMachineRoiSnapshot` ölü kod | **çözüldü** (seçenek B) | 2185d03 + veri temizliği 43cadea |
| #4 ek kurulum adımı gereken özellikler | **doğrulandı** (kod değişikliği gerekmedi) | dc67b58 |
| #5 eski rotalar kanoniğe yönlenmiyordu | **çözüldü** | a4a8d1e, c0f9c1c, 890f619 |
| #6 kapasite yıl/ay birim uyumsuzluğu | **çözüldü** (ayrı KPI'lar) | 7bc9a13 + 4ecaea7 |
| PageHeader `action` erişilemiyordu | **çözüldü** | c5f688e, ddaf39d |
| #8 başarısız navigasyon arayüzü kilitliyordu | **çözüldü** | b39852e |
| #7 istemci navigasyonu sessizce iptal oluyor | **kullanıcıya görünmez** (`data-hard-nav` + 3 sn kurtarma) · **kök neden hâlâ bilinmiyor** | 6542b36 |

---

## Yeni bulgu

Bu turda **uygulamada yeni bir sorun bulunamadı.** Tek yeni kayıt, test altyapısına ait olan
Bulgu #9'dur (aşağıda ve `findings-fix-guide.md`'de) — kod düzeltmesi yapılmadı, karar kullanıcıya.
