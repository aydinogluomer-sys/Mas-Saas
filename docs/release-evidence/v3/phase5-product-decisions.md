# PHASE 5 — Controlled-Use v1 Ürün Kapsamı Kararları (canonical, 2026-09-13)

Bu belge `final-production-readiness/phase5-product-decisions.md`'deki **öneriyi** release kapsamı için
**karara** çevirir. Kural: kodun güvenli davranışı zaten "kaynakta koru + inceleme + otomatik birleştirme yok"
ise controlled-use, iş gerçeğini otomatik çözmeye zorlanmaz; iş gerçeği gerektiren maddeler açıkça
`USER_DECISION_REQUIRED` olarak ayrılır ve `UNRESOLVED_IMPLEMENTATION` sayılmaz.

## Karar tablosu

| Decision | State | Kanıt / not |
|---|---|---|
| TRY-only controlled-use | **CLOSED** | §4.1; Phase 2 kapanışı (0092–0094, `currency-policy.ts`); V2 parser `no implicit TRY` (`4ca2b42`) |
| Multi-currency conversion | **DEFERRED** (post-v1) | FX motoru yok; `MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED`; storage multi-currency'ye açık (yeni CHECK eklenmedi) |
| AKR duplicate (−45.000 ×2, 2026-07-31) | **USER_DECISION_REQUIRED** | veri gerçeği; kod: `duplicate_check` inceleme, otomatik birleştirme YOK |
| Çağdaş duplicate (−100.000 ×3, 2026-08-31) | **USER_DECISION_REQUIRED** | aynı |
| Checks signed total | **PROVISIONAL** | gerçek DB'de `sum(checks.amount) = 590.000` (7 çek; 09-cutover-fingerprint-rc) — üst sınır yorumu ("hepsi gerçek"); AKR ×2 → tek ve Çağdaş ×3 → tek sayılırsa 590.000 − 45.000 − 200.000 = **345.000** (önceki belgedeki "245.000…590.000" aralığı bu aritmetikle örtüşmüyor; doğru alt sınır 345.000) |
| Opening balance policy | **CLOSED** | §4.3 sözleşmesi; kod uydurmaz (`cashflow/engine.ts` kaynaktan alır, süreklilik kırığı inceleme) |
| 49 source-only columns | **CLASSIFIED** | aşağıdaki matris: 40 SOURCE_ONLY_PRESERVED · 9 REMOVED_FROM_FUTURE_TEMPLATE · 0 DOMAIN_MAPPED · 0 USER_DECISION_REQUIRED |
| 15_MALIYET | **DEFERRED_TO_V1_1** | source/staging only; `cost_lines` migration yazılmadı; önizleme metni politikayı söylüyor |

### Provisional değerin görünürlüğü (açıkça)

Çek toplamı (590.000) `/finance`, `/finance/checks`, banka maruziyeti (Deniz %100) ve vade pencerelerinde
**PROVISIONAL etiketi olmadan** kullanılıyor. Görünürlük yalnız inceleme geçmişinde (`mapping_reviews`
`duplicate_check` → `resolved`, "hepsini tut" kararı). Bu bir kod kusuru değil, kullanıcı kararının
bekliyor olmasıdır; M5 el kontrolünde (Phase 6.5) kullanıcı AKR/Çağdaş kararını verene kadar ekrandaki
çek toplamı **üst sınır** olarak okunmalıdır. Bu turda UI'a etiket eklenmedi (yeni özellik yok).

## 4.1 TRY-only controlled-use — CLOSED

```text
SUPPORTED_FINANCE_AGGREGATION_CURRENCY = TRY
TRY dışı: source preserved · staging preserved · review visible · TRY totals excluded
          · no silent conversion · no implicit TRY
Multi-currency FX conversion: DEFERRED_TO_POST_V1
Schema: yeni currency CHECK EKLENMEDİ (storage ileride multi-currency taşıyabilir)
```

Uygulama: Tier 1/2/3 (0092–0094, `currency-policy.ts`); V2 parser checks/loans + para birimi kolonu olmayan
7 aile (cashflow, orders, products, projects, capacity, cost, machine_roi) için TRY-dışı satır domain'e
yazılmaz, incelemeye düşer, kaynakta korunur (`4ca2b42`).

## 4.2 Duplicate checks — USER_DECISION_REQUIRED

```text
AUTO_DEDUP = FORBIDDEN
BUSINESS_DEDUPLICATION = UNRESOLVED   (iş gerçeği: kullanıcı)
CHECKS_SIGNED_TOTAL = PROVISIONAL     (bugün 590.000; karara göre 345.000…590.000)
```

Kod davranışı (değişmedi): ardışık aynı tutar → `duplicate_check` incelemesi; import hazırlığa yazar,
deftere yalnız insan kararıyla girer; hiçbir domain kaydı silinmez/birleştirilmez. Kullanıcıdan istenen
karar paketi: **AKR** (a) iki ayrı çek / (b) tek çek mükerrer satır; **Çağdaş** aynı üç seçenek.

## 4.3 Opening balance — CLOSED (sözleşme)

```text
FIRST_PERIOD : açık opening balance gerekir ya da açıkça "bilinmiyor"
NEXT_PERIOD  : beklenen opening = önceki closing
kaynak opening varsa: kaynak opening vs önceki closing karşılaştır
uyuşmazlık : inceleme / süreklilik uyarısı
asla        : opening balance UYDURMA
```

Mevcut kod bu sözleşmeyle uyumlu: `cashflow_months.opening_balance` kaynaktan alınır (hesaplanmaz),
`findContinuityIssues` |closing−opening| > 1 → inceleme, değer değiştirilmez (phase4-verify: TEMİZ 0 kırık,
enjekte kırık → flag, değer DEĞİŞMEDİ). V2 şablonu `opening_balance` kabul etmez → ilk dönem açılışı bugün
legacy TEMİZ'den gelir; yeni bir ilk dönem girilirse "açıkça bilinmiyor" yolu geçerlidir. Veri mutasyonu yok.

## 4.4 / 5.1 — 49 source-only kolon: final matris

Kural: v1 varsayılanı `SOURCE_ONLY_PRESERVED`; `DOMAIN_MAPPED` yalnız kanıtlı ekran/KPI/domain tüketicisi
varsa. Şablonda bulunmak tek başına domain gerekçesi değildir. Ham hücreler `import_rows.row_json`'da
korunur (2.4b), kaynak satır ekranında görünür.

| Kolon | Karar | Gerekçe | Tüketici (varsa) | Gelecek aksiyon |
|---|---|---|---|---|
| 01_ODEMELER.baslangic_tarihi | SOURCE_ONLY_PRESERVED | payments tarih aralığı taşımıyor; controlled-use için gerekmiyor | — | v1.1: takvim üretimine bağlanabilir (A-adayı) |
| 01_ODEMELER.bitis_tarihi | SOURCE_ONLY_PRESERVED | aynı | — | aynı |
| 04_KREDI_TAKSITLERI.notlar | SOURCE_ONLY_PRESERVED | finansal anlamı yok | kaynak satır görünümü | — |
| 05_NAKIT_AKISI.kategori | SOURCE_ONLY_PRESERVED | ayrım `line_type` ile | — | — |
| 05_NAKIT_AKISI.para_birimi | SOURCE_ONLY_PRESERVED | cashflow_lines currency taşımaz; TRY-dışı → inceleme, **yazılmaz** (`4ca2b42`) | parser doğrulama kapısı | multi-currency post-v1 |
| 05_NAKIT_AKISI.gerceklesen_planlanan | SOURCE_ONLY_PRESERVED | ayrım ay düzeyinde (`cashflow_months.confidence`) | — | — |
| 09_SIPARISLER.siparis_tipi | SOURCE_ONLY_PRESERVED | orders kolonu yok; sipariş modülü ikincil | — | — |
| 09_SIPARISLER.beklenen_tarih | SOURCE_ONLY_PRESERVED | aynı | — | — |
| 09_SIPARISLER.toplam_tutar | SOURCE_ONLY_PRESERVED | parasal karşılık faturada; ayrı saklamak çift kayıt | — | — |
| 09_SIPARISLER.para_birimi | SOURCE_ONLY_PRESERVED | orders currency taşımaz; TRY-dışı → inceleme | parser kapısı | — |
| 09_SIPARISLER.durum | SOURCE_ONLY_PRESERVED | yalnız `is_active` | — | — |
| 10_URUNLER.kategori | SOURCE_ONLY_PRESERVED | raporlama boyutu | — | — |
| 10_URUNLER.standart_maliyet | SOURCE_ONLY_PRESERVED | tarihli fiyat modeli yok | — | v1.1 fiyat tarihçesi tasarımı |
| 10_URUNLER.satis_fiyati | SOURCE_ONLY_PRESERVED | aynı | — | aynı |
| 10_URUNLER.para_birimi | SOURCE_ONLY_PRESERVED | products currency taşımaz; TRY-dışı → inceleme | parser kapısı | — |
| 11_PROJELER.baslangic_tarihi | SOURCE_ONLY_PRESERVED | projects tarih aralığı yok | — | — |
| 11_PROJELER.bitis_tarihi | SOURCE_ONLY_PRESERVED | aynı | — | — |
| 11_PROJELER.durum | SOURCE_ONLY_PRESERVED | yalnız `is_active` | — | — |
| 11_PROJELER.sozlesme_degeri | SOURCE_ONLY_PRESERVED | domain kolonu yok | — | v1.1: alacak tahmini (A-adayı) |
| 11_PROJELER.butce_maliyeti | REMOVED_FROM_FUTURE_TEMPLATE | aynı bilgi `12_BUTCE` proje kırılımında; iki giriş = çift kayıt | — | şablon v2.1'de kaldır; v1'de kaynakta korunur |
| 11_PROJELER.para_birimi | SOURCE_ONLY_PRESERVED | projects currency taşımaz; TRY-dışı → inceleme | parser kapısı | — |
| 12_BUTCE.karsi_taraf | SOURCE_ONLY_PRESERVED | budget_lines taraf taşımaz | — | — |
| 13_FX_POZISYONU.try_karsiligi | REMOVED_FROM_FUTURE_TEMPLATE | türetilmiş (tutar × kur); kaynakta saklamak sapmaya davet | ekran hesaplananı gösterir | şablon v2.1'de kaldır |
| 13_FX_POZISYONU.notlar | SOURCE_ONLY_PRESERVED | finansal anlamı yok | kaynak satır görünümü | — |
| 14_KAPASITE.diger_operasyon_dk | SOURCE_ONLY_PRESERVED | production_parts yalnız torna+freze | — | v1.1 operasyon modeli |
| 14_KAPASITE.satis_fiyati | SOURCE_ONLY_PRESERVED (raw sözleşmesiyle TÜKETİLİYOR) | domain'de fiyat yok; kârlılık motoru `row_json`'dan okur (2.4a `88247d6`, `source-revenue.ts`) | `src/lib/production/source-revenue.ts` | v1.1: tarihli fiyat tablosu |
| 14_KAPASITE.para_birimi | SOURCE_ONLY_PRESERVED | production_parts currency taşımaz; TRY-dışı → inceleme | parser kapısı | — |
| 14_KAPASITE.verim_orani | REMOVED_FROM_FUTURE_TEMPLATE | atölye özelliği (`capacity_models.efficiency_rate`); satırda tekrar tutarsızlık üretir | — | şablon v2.1: kapasite başlığına taşı |
| 14_KAPASITE.calisma_gunu | REMOVED_FROM_FUTURE_TEMPLATE | atölye özelliği (`work_days_per_month`) | — | aynı |
| 14_KAPASITE.vardiya_sayisi | REMOVED_FROM_FUTURE_TEMPLATE | atölye özelliği | — | aynı |
| 14_KAPASITE.notlar | SOURCE_ONLY_PRESERVED | finansal anlamı yok | kaynak satır görünümü | — |
| 15_MALIYET.senaryo | SOURCE_ONLY_PRESERVED | 15_MALIYET v1'de staging-only (§5) | — | v1.1 `cost_lines.scenario` |
| 15_MALIYET.maliyet_kategorisi | SOURCE_ONLY_PRESERVED | serbest metin; sabit kolona tahminle eşlenmez | — | v1.1 `cost_lines.category` |
| 15_MALIYET.aciklama | SOURCE_ONLY_PRESERVED | açıklama | kaynak satır görünümü | — |
| 15_MALIYET.aylik_tutar | SOURCE_ONLY_PRESERVED | kategoriye bağlı kolon tahmini yasak | — | v1.1 `cost_lines.amount` |
| 15_MALIYET.para_birimi | SOURCE_ONLY_PRESERVED | cost_models currency taşımaz; TRY-dışı → inceleme | parser kapısı | — |
| 15_MALIYET.personel_sayisi | REMOVED_FROM_FUTURE_TEMPLATE | atölye özelliği (`capacity_models.staff_count`) | — | şablon v2.1 |
| 15_MALIYET.aylik_calisma_saati | REMOVED_FROM_FUTURE_TEMPLATE | atölye özelliği (`monthly_hours`) | — | şablon v2.1 |
| 15_MALIYET.verim_orani | REMOVED_FROM_FUTURE_TEMPLATE | atölye özelliği (`efficiency_rate`) | — | şablon v2.1 |
| 15_MALIYET.notlar | SOURCE_ONLY_PRESERVED | finansal anlamı yok | kaynak satır görünümü | — |
| 16_MAKINE_ROI.makine_kodu | SOURCE_ONLY_PRESERVED | machine_assets kod kolonu yok; kimlik şimdilik `name` (doğal anahtar, `aa61115`) | — | v1.1: `code` kolonu (idempotency) |
| 16_MAKINE_ROI.alis_tarihi | SOURCE_ONLY_PRESERVED | amortisman modeli yok | — | — |
| 16_MAKINE_ROI.para_birimi | SOURCE_ONLY_PRESERVED | machine_assets currency taşımaz; TRY-dışı → inceleme (**purchase_cost örtük TRY yazılmaz**) | parser kapısı | — |
| 16_MAKINE_ROI.aylik_gelir | REMOVED_FROM_FUTURE_TEMPLATE | model yıllık; aylık×12 sayı uydurmak | — | şablon v2.1: yıllık iste |
| 16_MAKINE_ROI.aylik_operasyon_maliyeti | REMOVED_FROM_FUTURE_TEMPLATE | aynı | — | aynı |
| 16_MAKINE_ROI.yillik_bakim_maliyeti | SOURCE_ONLY_PRESERVED | snapshot ayrı bakım kalemi taşımıyor | — | v1.1: ROI'ye bakım kalemi (A-adayı) |
| 16_MAKINE_ROI.kullanim_orani | SOURCE_ONLY_PRESERVED | raporlama | — | — |
| 16_MAKINE_ROI.faydali_omur_ay | SOURCE_ONLY_PRESERVED | amortisman modeli yok | — | — |
| 16_MAKINE_ROI.aktif | SOURCE_ONLY_PRESERVED | kolon yok | — | — |

Sayım: 49 satır · SOURCE_ONLY_PRESERVED 40 · REMOVED_FROM_FUTURE_TEMPLATE 9 · DOMAIN_MAPPED 0 · USER_DECISION_REQUIRED 0 ·
UNCLASSIFIED **0**. `REMOVED_FROM_FUTURE_TEMPLATE` kararı v1 şablonunu (v2.0, sha `f965a1ba…`) değiştirmez;
şablon v2.1 ayrı bir sürümdür ve bu turda üretilmedi.

### Wave 0 notu (2026-10-28) — sayım/matris tutarsızlığı; şablondan HİÇBİR kolon kaldırılmadı

Yukarıdaki sayım ve onay **40 SOURCE_ONLY_PRESERVED · 9 REMOVED_FROM_FUTURE_TEMPLATE** diyor; matrisin
kendi satırları ise **39 · 10** veriyor. REMOVED işaretli on satır: `11_PROJELER.butce_maliyeti`,
`13_FX_POZISYONU.try_karsiligi`, `14_KAPASITE.verim_orani`, `14_KAPASITE.calisma_gunu`,
`14_KAPASITE.vardiya_sayisi`, `15_MALIYET.personel_sayisi`, `15_MALIYET.aylik_calisma_saati`,
`15_MALIYET.verim_orani`, `16_MAKINE_ROI.aylik_gelir`, `16_MAKINE_ROI.aylik_operasyon_maliyeti`.

Hangi kolonun onaylı dokuzun dışında kaldığı belgenin tarihçesinden **belirlenemiyor**:

- Bu belgenin tek commit'i var (`93cddfc`, 2026-09-13); sayımı, on satırlık matrisi ve aynı 40/9
  tallysini taşıyan commit mesajını AYNI ANDA yazdı. Sayım yazıldıktan SONRA sınıfı değişen bir satır
  tarihçede yok. `git log --all -S REMOVED_FROM_FUTURE_TEMPLATE` yalnız bu commit'i buluyor.
- Öncül öneri belgesi (`final-production-readiness/phase5-product-decisions.md`, `ad8a354`) farklı bir
  sayım taşıyor (A=3 / B=33 / C=13) ve 40/9'u açıklamıyor; öneriden karara geçerken
  `14_KAPASITE.diger_operasyon_dk` C'den SOURCE_ONLY'ye geçti, ama bu matrisin 10'u verdiği hâli
  değiştirmez.

Muhafazakâr karar (Wave 0 kararı R9): dokuzu tahmin etmek yerine **hiçbir kolon
kaldırılmadı**. Şablon 2.0.0 ve sha'sı (`f965a1ba…`) değişmedi; 49 kolonun tamamı parser tarafından
tanınmaya ve ham değerleri `import_rows.row_json`'da korunmaya devam ediyor (SOURCE_ONLY_PRESERVED
yarısı zaten uygulanmış durumda: `domain-map.ts` 49 `not_persisted`). Uygulamak için gereken tek şey
sahibin dokuz kolonu ADIYLA teyit etmesi; o zaman: `ColumnSpec.removedFromTemplate`, şablon üretecinde
filtre, `missingColumns` hariç tutma, `TEMPLATE_VERSION` 2.1.0, şablonun yeniden üretimi ve bu
belgenin sayımının düzeltilmesi aynı sürümde yapılır (Wave 0 / S5 README satırları — formül hatası ve
birleştirilmiş hücre kuralları — da o sürüme bırakıldı). "Kapasite başlığına taşı" ve "yıllık iste"
gelecek aksiyonları o değişikliğin parçası değildir.

## 5 — 15_MALIYET v1 kapsam kararı: SOURCE/STAGING ONLY

```text
15_MALIYET = SOURCE/STAGING ONLY (v1)
domain finansal KPI'lara bağlanmaz · serbest metin kategori → wide cost_models tahmini YAPILMAZ
cost_lines normalize model = POST_V1 / V1.1 backlog (tasarım: final-production-readiness/phase5-product-decisions.md §5.2)
```

Önizleme metni (`4ca2b42`): "n satır (cost) kaynak/hazırlık katmanında KORUNUR ama controlled-use v1 finans
hesaplarına DAHİL DEĞİLDİR (15_MALIYET → v1.1 backlog)". Kârlılık motoru mevcut `cost_models`'i kullanmaya devam eder.

## Kullanıcıya kalan minimal karar paketi

1. **AKR −45.000 ×2 (2026-07-31):** (a) iki ayrı çek · (b) tek çek, mükerrer satır
2. **Çağdaş −100.000 ×3 (2026-08-31):** (a) üç ayrı çek · (b) tek çek, mükerrer satırlar · (c) iki gerçek + bir mükerrer

Bu iki cevap gelene kadar çek toplamı **üst sınır (590.000)** olarak okunur; kod hiçbir şeyi otomatik
birleştirmez. Diğer altı Phase 5 başlığı bu turda kapatıldı.
