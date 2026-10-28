# PHASE 5 — Ürün kapsamı kararları

**Plan:** `implementation(20260912-211920).md` §PHASE 5
**Tarih:** 2026-09-13 · **Kaynak:** `src/lib/importers/v2/domain-map.ts` @ `feature/standard-import-v2` (187 kolon kararı, 49'u `not_persisted`)
**Durum:** ÖNERİ — kullanıcı onayı bekliyor. Bu belgedeki hiçbir karar uygulanmadı.

> Plan §5.1: her kolon yalnız **A** (domain'e bağlanacak) / **B** (source-only saklanacak ve
> görüntülenecek) / **C** (V2 contract'tan çıkarılacak). `UNRESOLVED` kalamaz.
> Plan kuralı: "İş kararını gerektiren anlamı uydurma." — Bu yüzden aşağıdakiler **öneridir**,
> her biri için gerekçe ve alternatif yazıldı.

---

## 5.1 — 49 source-only kolon, beş grupta

### Grup 1 — `para_birimi` kolonları, para birimi olmayan tablolarda (7 kolon)

| Kolon | Tablo | Tablo currency taşıyor mu |
|---|---|---|
| `05_NAKIT_AKISI.para_birimi` | cashflow_lines | hayır |
| `09_SIPARISLER.para_birimi` | orders | hayır |
| `10_URUNLER.para_birimi` | products | hayır |
| `11_PROJELER.para_birimi` | projects | hayır |
| `14_KAPASITE.para_birimi` | production_parts | hayır |
| `15_MALIYET.para_birimi` | cost_models | hayır |
| `16_MAKINE_ROI.para_birimi` | machine_assets | hayır |

**Öneri: B + doğrulama kapısı.** Plan §2.1 TRY-only politikasıyla tutarlı: değer `raw`'da korunur;
parser `TRY` dışı bir değer görürse satır **yüksek öncelikli inceleme**ye düşer ve domain'e
yazılmaz. Bu, checks/loans için V2 WIP'te (`f8eede7`) zaten yapılan davranışın aynısı — yedi
tabloya genişletilmesi kod değişikliği ister ama şema değişikliği istemez.
**Alternatif C** (kolonu şablondan çıkarmak): kullanıcının Excel'inde bu kolon varsa "kolon
tanınmadı" uyarısı üretir; kabul edilebilir ama B daha az sürtünmeli.

### Grup 2 — serbest metin notlar (5 kolon)

`04_KREDI_TAKSITLERI.notlar` · `13_FX_POZISYONU.notlar` · `14_KAPASITE.notlar` ·
`15_MALIYET.notlar` · `15_MALIYET.aciklama`

**Öneri: B.** Finansal anlamı yok; provenance'ta (`import_rows.row_json`) korunur, kaynak satır
görünümünde gösterilir. Domain tablosuna `notes` kolonu eklemek şema değişikliği ister ve
kazanımı yok.

### Grup 3 — domain'de karşılığı olmayan iş alanları (17 kolon)

| Kolon | Neden domain'de yok | Öneri | Gerekçe |
|---|---|---|---|
| `01_ODEMELER.baslangic_tarihi` | payments'ta yok | **B**, A-adayı | Tekrarlayan ödemenin "ne zaman biter" bilgisi ileride takvim üretimini etkileyebilir. Controlled-use için kaynak-only yeterli; A'ya geçiş ayrı migration. |
| `01_ODEMELER.bitis_tarihi` | aynı | **B**, A-adayı | aynı |
| `09_SIPARISLER.beklenen_tarih` | orders'ta yok | **B** | Sipariş modülü ikincil; tahsilat tahmini `invoices` üzerinden yürüyor. |
| `09_SIPARISLER.durum` | yalnız `is_active` var | **B** | aynı |
| `09_SIPARISLER.siparis_tipi` | yok | **B** | aynı |
| `09_SIPARISLER.toplam_tutar` | (dosya notu) | **B** | Satır kalemlerinden türetilebilir; ayrıca saklamak çift kayıt riski. |
| `10_URUNLER.kategori` | products'ta yok | **B** | Raporlama boyutu, hesap girdisi değil. |
| `10_URUNLER.satis_fiyati` | tarihli fiyat modeli yok | **B** (raw sözleşmesiyle TÜKETİLİYOR) | 2.4a düzeltmesi (`88247d6`) kârlılık motorunun bunu `row_json`'dan okumasını sağladı. Domain'e taşımak tarihli fiyat tablosu ister — ayrı tasarım. |
| `10_URUNLER.standart_maliyet` | aynı | **B** | aynı |
| `11_PROJELER.baslangic_tarihi` | projects'te yok | **B** | Proje modülü ikincil. |
| `11_PROJELER.bitis_tarihi` | aynı | **B** | |
| `11_PROJELER.butce_maliyeti` | budget_lines üzerinden | **C** | Aynı bilgi `12_BUTCE`'de proje kırılımıyla var; iki yerden girmek çift kayıt. Şablondan çıkarılmalı. |
| `11_PROJELER.durum` | yalnız `is_active` | **B** | |
| `11_PROJELER.sozlesme_degeri` | yok | **B**, A-adayı | Alacak tahmini için anlamlı olabilir; şimdilik kaynak-only. |
| `12_BUTCE.karsi_taraf` | budget_lines taraf taşımıyor | **B** | Bütçe kategori/kırılım üzerinden; taraf bilgisi raporlama notu. |
| `13_FX_POZISYONU.try_karsiligi` | tutar × kur olarak hesaplanır | **C** | Türetilmiş değer. Kaynakta saklamak, hesaplanan değerle **sapmaya davet**. Şablondan çıkarılmalı; ekranda hesaplanan gösterilir. |
| `12_BUTCE` dışı bütçe alanları | — | — | (yok) |

### Grup 4 — atölye özelliği olan alanlar, satır seviyesinde tekrarlanmış (7 kolon)

| Kolon | Gerçek sahibi |
|---|---|
| `14_KAPASITE.calisma_gunu` | `capacity_models.work_days_per_month` |
| `14_KAPASITE.vardiya_sayisi` | (atölye) |
| `14_KAPASITE.verim_orani` | `capacity_models.efficiency_rate` |
| `14_KAPASITE.diger_operasyon_dk` | (dosya notu) |
| `15_MALIYET.aylik_calisma_saati` | `capacity_models.monthly_hours` |
| `15_MALIYET.personel_sayisi` | `capacity_models.staff_count` |
| `15_MALIYET.verim_orani` | `capacity_models.efficiency_rate` |

**Öneri: C — şablondan çıkar, `capacity_models` başlığına taşı.** Bu alanlar parçanın ya da
maliyet satırının özelliği değil, **atölyenin** özelliği. Her satırda tekrarlanması (a) tutarsız
değer girilmesine izin verir (satır 5'te verim %80, satır 6'da %85 — hangisi doğru?), (b) plan
§5.2 "Kapasite/personel/saat/verim tutarlılığını kontrol et" kuralını ihlal eder.
**Alternatif B:** satırlarda kalır, parser tüm satırlarda aynı değer olduğunu doğrular, farklıysa
inceleme. Daha az şablon değişikliği ama sürekli bir tutarlılık kontrolü gerektirir.
**Karar etkisi:** C seçilirse şablon sürümü değişir (`v2.1`), README/ÖRNEKLER güncellenir.

### Grup 5 — `15_MALIYET` çekirdeği (3 kolon) → §5.2'ye bağlı

`15_MALIYET.maliyet_kategorisi` · `15_MALIYET.aylik_tutar` · `15_MALIYET.senaryo`

**Öneri: A — ama geniş `cost_models`'e değil, yeni normalize `cost_lines` tablosuna.**
Bu, aşağıdaki §5.2 tasarımına ve iş kararı #7'ye bağlı. #7 "hayır" ise bu üçü **B** kalır
(`STAGED_ONLY_BY_DESIGN` — V2 WIP'in mevcut kararı).

### Grup 6 — makine ROI (8 kolon)

| Kolon | Öneri | Gerekçe |
|---|---|---|
| `16_MAKINE_ROI.makine_kodu` | **B**, A-adayı | Kimlik kolonu; `machine_assets`'e `code` eklemek idempotent import için faydalı. Şema değişikliği. |
| `16_MAKINE_ROI.alis_tarihi` | **B** | Amortisman modeli yokken hesap girdisi değil. |
| `16_MAKINE_ROI.faydali_omur_ay` | **B** | aynı — amortisman modeli yok. |
| `16_MAKINE_ROI.kullanim_orani` | **B** | Raporlama. |
| `16_MAKINE_ROI.aktif` | **B** | |
| `16_MAKINE_ROI.yillik_bakim_maliyeti` | **B**, A-adayı | `machine_roi_snapshots` ayrı bakım kalemi taşımıyor; eklenirse ROI hesabına girer. |
| `16_MAKINE_ROI.aylik_gelir` | **C** | Model YILLIK tutuyor; aylık×12 "sayı uydurmak" (domain-map notu haklı). Şablon **yıllık** istemeli. |
| `16_MAKINE_ROI.aylik_operasyon_maliyeti` | **C** | aynı |

### Özet dağılım (öneri)

| Karar | Kolon sayısı |
|---|---|
| **A** (domain'e bağla) | 3 — yalnız 15_MALIYET çekirdeği, §5.2 + karar #7'ye bağlı |
| **B** (source-only, göster) | 33 — 7'si TRY doğrulama kapısıyla |
| **C** (şablondan çıkar) | 13 — 7 atölye alanı + 3 türetilmiş/uyumsuz + `butce_maliyeti` + 2 aylık ROI |
| **UNRESOLVED** | **0** — her satırın önerisi var; onay bekliyor |

---

## 5.2 — `15_MALIYET` normalize yapı

Plan önerdiği `CostLine` arayüzü doğru; mevcut `cost_models` **geniş** (sabit kolonlar), şablon
**uzun** (kategori + tutar satırları). Tahminle eşlemek yasak (domain-map notu ve plan aynı fikirde).

**Önerilen migration `0092_cost_lines.sql` (forward-only, uygulanmadı):**

```sql
create table public.cost_lines (
  id              uuid primary key default gen_random_uuid(),
  cost_model_id   uuid not null references public.cost_models(id),
  period          text not null,           -- 'YYYY-MM'; yoksa satır REDDEDİLİR (plan)
  scenario        text not null check (scenario in ('normal','overtime')),
  currency        text not null default 'TRY' check (currency = 'TRY'),  -- §2.1
  category        text not null,           -- SERBEST — tahminle sabit kolona map EDİLMEZ
  amount          numeric(14,2) not null,
  amount_basis    text not null check (amount_basis in ('monthly','daily','per_unit')),
  is_subtotal     boolean not null default false,  -- TOPLAM/ARA TOPLAM: aggregation'a GİRMEZ
  source_row_id   uuid references public.import_rows(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- Aynı model+dönem+senaryo+kategori tek satır (idempotent import):
create unique index cost_lines_natural_key
  on public.cost_lines (cost_model_id, period, scenario, category)
  where source_row_id is not null;
```

**Kurallar (plan §5.2 → kod):**
- `period` boş → `mapping_status = rejected`, sebep `MISSING_PERIOD`.
- `category` `TOPLAM`/`ARA TOPLAM`/`SUBTOTAL` içeriyorsa → `is_subtotal = true`, hiçbir `sum()` bunları saymaz (view'larda `where not is_subtotal`).
- `aylik_tutar` **yalnız** `amount_basis = 'monthly'` ile yazılır; günlük alana asla çevrilmez.
- Bilinmeyen kategori korunur (`category` serbest metin).
- Break-even: `capacity_models.efficiency_rate` veya `monthly_hours` yoksa `not_applicable`, uydurma yok.
- `source_sheet_id` üzerindeki legacy `ON CONFLICT` bozulmaz — `cost_lines` yeni tablo, `cost_models`'e dokunmuyor.

**Kapsam kararı #7'ye bağlı.** "Hayır" ise bu migration yazılmaz; 15_MALIYET `STAGED_ONLY` kalır.

---

## 5.3 — Açık iş kararları (7) — SİZİN CEVABINIZ GEREKİYOR

| # | Soru | Bağlam | Cevap seçenekleri |
|---|---|---|---|
| 1 | **AKR `−45.000 ×2`** ayrı iki çek mi, tek çekin iki satırı mı? | Kaynak Excel'de aynı tutar iki satırda. Çek modülü şu an ikisini ayrı sayıyor. | (a) iki ayrı çek / (b) tek çek, mükerrer satır / (c) bilinmiyor → inceleme |
| 2 | **Çağdaş `−100.000 ×3`** ayrı üç çek mi? | aynı desen | aynı |
| 3 | **Çek toplamı için provisional gerçek tutar** nedir? | `−245.000 … −590.000` aralığı PROVISIONAL kaydedilmiş; #1 ve #2'nin cevabına göre kesinleşir | rakam ya da "#1/#2 sonrası hesaplansın" |
| 4 | **Açılış bakiyesi kaynağı** nedir? | `cashflow_months.opening_balance` Excel'den olduğu gibi alınıyor; ilk ayın açılışı nereden geliyor? V2 şablonu artık `opening_balance` kabul etmiyor. | (a) banka ekstresi / (b) önceki dönem kapanışı / (c) elle girilen tek değer |
| 5 | **TRY-only politika controlled-use için kabul mü?** | Plan §2.1 önerisi. Kabulse: TRY dışı satır inceleme, toplama girmez. Redse: FX motoru gerekir (plan STOP listesinde). | EVET / HAYIR |
| 6 | **49 kolonun A/B/C kararı** — yukarıdaki öneri tablosu kabul mü? | Özet: A=3, B=33, C=13 | tümü kabul / şu satırlar farklı: … |
| 7 | **`15_MALIYET` controlled-use kapsamına dahil mi?** | Dahilse `0092_cost_lines` + yazıcı + ekran gerekir (tahmini iş: orta). Değilse staged-only kalır, kârlılık motoru mevcut `cost_models`'i kullanmaya devam eder. | EVET / HAYIR |

**Gate:** `UNRESOLVED_PRODUCT_DECISIONS = 0` ancak bu yedi cevap geldikten sonra.
Cevaplar gelmeden: 49 kolon **önerili-bekliyor**, `cost_lines` **tasarlandı-yazılmadı**.
