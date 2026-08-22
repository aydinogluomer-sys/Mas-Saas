# MAS Nakit Radar — Implementation Plan v3

> 14 fazli uygulama yol haritasi. Bu bolum guncel kaynak-of-truth planidir.
> Eski v2 plan asagida tarihsel detay ve domain referansi olarak korunur.

---

## 0. Product Boundary

MAS Nakit Radar, MAS'in gercek Excel calisma seklini kaybetmeden; odeme,
nakit akis, cek/kredi, uretim maliyeti, senaryo, rapor ve AI destekli
yorum/cevap katmanina donusturen ozel bir finans-operasyon panelidir.

Urun degildir:

- public SaaS
- ERP
- muhasebe defteri / double-entry accounting sistemi
- AI muhasebeci
- cok kiracili platform
- public landing / pricing / subscription urunu

Degismez kurallar:

- Ham Excel verisi once korunur; sonra staging/review; sonra domain tablolarina aktarilir.
- Null tutar asla 0 sayilmaz.
- Negatif tutar baglama gore yorumlanir; ceklerde yon, odeme tablosunda anomali olabilir.
- Sessiz duzeltme yoktur; validator bayrak koyar, degeri degistirmez.
- Her domain kaydi mumkun oldugunca source workbook/sheet/row izine doner.
- AI kaynak-of-truth degildir; sadece deterministik hesaplari aciklar, soru cevaplar ve aksiyon onerir.
- Senaryo/analitik ciktilari muhasebe gercegi degil, planlama katmanidir.

---

## 1. Faz Durumu

| Faz | Baslik | Durum |
|---:|---|---|
| 1 | Kaynak veri haritasi ve parser foundation | DONE |
| 2 | Veritabani foundation | DONE |
| 3 | Import, raw viewer ve mapping review UI | DONE |
| 4 | Odeme radari MVP | DONE |
| 5 | Nakit akis radari | DONE |
| 6 | Cek/kredi finansman radari | DONE |
| 7 | Raporlar ve hatirlatmalar | DONE |
| 8 | Uretim kapasite/maliyet analitigi | DONE |
| 9 | Salt-okunur senaryo motoru MVP | DONE |
| 10 | Excel coverage close-out: 9A/9B/9C/9D | DONE |
| 11 | Decision facts / metrics katmani | DONE |
| 12 | AI soru-cevap ve rapor yorum katmani | DONE (12A; phase12a:verify PASS) |
| 13 | Senaryo v2 ve finansman optimizasyonu | DONE (13A+13B; phase13a/13b:verify PASS) |
| 14 | Veri kalite merkezi, disgoru ve aksiyon workflow | DONE (14A-14E; phase14a-14e:verify PASS) |
| P0-A | Gercek cok-kullanicili auth + kullanici yonetimi | DONE |

Mevcut git gercegi:

- Faz 10A / 9A commitli: `feat(production): surface cost breakdown and Akon price margin (Phase 9A)`.
- Faz 10B / 9B commitli: `feat(cashflow): surface monthly expense breakdown (Phase 9B)`.
- Faz 10C / 9C commitli: `feat(production): add machine ROI mapping (Phase 9C)`.
- Faz 10D / 9D commitli: `feat(production): allocate machine minutes and finance cost (Phase 9D)`.

---

## 2. Faz 1 — Kaynak Veri Haritasi ve Parser Foundation

Amac: Excel dosyasinin gercek yapisini kanitli bicimde okumak, bozuk dosyayi
ayirt etmek ve hicbir sekmeyi sessizce atmamak.

Teslimatlar:

- Safe workbook parser.
- Sheet classifier: loan, capacity, machine ROI, payment matrix, checks, cost models, monthly cashflow, unknown.
- `docs/data-map.md`, `docs/import-mapping.md`, `docs/calculation-rules.md`.
- Bozuk XLSX/ZIP signature failure yolu.

Gate:

- Tum sekmeler listelenir.
- Typecheck, lint, unit tests.
- Parse report guncellenir.

---

## 3. Faz 2 — Veritabani Foundation

Amac: ham kaynak, staging ve normalize domain katmanlarini kurmak.

Teslimatlar:

- `source_workbooks`, `source_sheets`, `source_cells`, `import_rows`, `mapping_reviews`.
- `parties`, `categories`, `cash_accounts`, `settings`, `audit_logs`.
- Payments, cashflow, checks, loans, reminders, reports tablolari.
- RLS ve seed verileri.

Gate:

- `pnpm db:verify`.
- Constraints: null tutar korunur, paid status `paid_at` ister, idempotency unique'leri calisir.
- Generated DB types guncel tutulur.

Not: `src/types/database.ts` yeni production/scenario/cost tablolarini da kapsayacak sekilde guncellenmelidir.

---

## 4. Faz 3 — Import, Raw Viewer ve Mapping Review UI

Amac: Excel'i domain tablolara dogrudan yazmadan once ham veriyi korumak ve
insan onayi gereken satirlari review'a dusurmek.

Teslimatlar:

- Workbook upload.
- Sheet listesi ve detected type rozetleri.
- Raw row/cell viewer.
- Payment/cashflow/check/loan/capacity/cost preview'lari.
- Mapping review filtreleri ve kabul/ret/cozuldu aksiyonlari.

Gate:

- `pnpm import:real`.
- Hucre ve satir sayisi source ile mutabik.
- Anomaliler review'a duser.
- Failed workbook partial row yazmaz.

---

## 5. Faz 4 — Odeme Radari MVP

Amac: gunluk operasyon icin odemeleri gorunur ve aksiyonlanabilir yapmak.

Teslimatlar:

- Payment CRUD.
- Idempotent monthly instance generation.
- Bugun / yarin / 7 gun gorunumu.
- Aylik takvim, riskli gunler, gecikenler, eksik tutar raporu.
- Paid/unpaid ve tutar girisi.
- Audit log.

Gate:

- `pnpm phase3:verify`.
- Due-day 29/30/31 kisa-ay kurali.
- Eksik tutar 0 olmaz.
- Duplicate instance DB seviyesinde engellenir.

---

## 6. Faz 5 — Nakit Akis Radari

Amac: 35 aylik Excel nakit akis sekmelerini projeksiyon ve karar ekranina cevirmek.

Teslimatlar:

- `cashflow_months`, `cashflow_lines`, `cashflow_snapshots`.
- Devir/gelir/gider/fark/kasa kartlari.
- Ilk negatif ay, en kotu ay, negatif seri.
- Gelir/gider yogunlasma analizi.
- Borc servisi overlay icin hazir temel.

Gate:

- `pnpm phase4:verify`.
- Header hucreleri source ile +-0,5 TL mutabik.
- Continuity break bayraklanir, deger degistirilmez.

---

## 7. Faz 6 — Cek/Kredi Finansman Radari

Amac: cek vadeleri, kredi taksitleri, banka/karsi taraf exposure ve borc
servisi yukunu nakit akisla birlikte gorunur yapmak.

Teslimatlar:

- Checks ledger.
- Check events.
- Loans ve loan installments.
- Vade pencereleri 7/14/30 gun.
- Banka/karsi taraf exposure.
- Aylik borc servisi.

Gate:

- `pnpm phase5:verify`.
- Negatif cek tutari anomali degil, outflow yonudur.
- Cift kayit adaylari otomatik merge edilmez.
- Loan total/payment/cost source ile mutabik.

---

## 8. Faz 7 — Raporlar ve Hatirlatmalar

Amac: gunluk/haftalik/aylik ozetleri ve hatirlatma akisini karar destegine cevirmek.

Teslimatlar:

- Daily/weekly/monthly report builders.
- Report snapshots.
- AI commentary prompt template; model cagrisi yok.
- Reminder rules: 7/3/1/0/-1 offset.
- Mock ve Telegram transport.
- Delivery log.

Gate:

- `pnpm phase6:verify`.
- `pnpm phase6b:verify`.
- Report/reminder finansal kayitlari mutasyona ugratmaz.
- Istanbul timezone kullanilir.

---

## 9. Faz 8 — Uretim Kapasite/Maliyet Analitigi

Amac: kapasite, maliyet, basabas TL/dk, parca karliligi ve normal/mesaili
karsilastirmasini analitik katmana almak.

Teslimatlar:

- `machine_assets`, `production_parts`, `capacity_models`, `cost_models`,
  `part_profitability_runs`, `machine_roi_snapshots`.
- Normal vs mesaili.
- Basabas TL/dk.
- Parca karliligi.
- Stale-rate ve missing operation time bayraklari.

Gate:

- `pnpm phase7:verify`.
- Uretim analitigi finans cekirdegini degistirmez.
- 2023 stale rate gorunur kalir.

---

## 10. Faz 9 — Salt-Okunur Senaryo Motoru MVP

Amac: baseline nakit akis uzerinde varsayimlari uygulamak, source-of-truth'u
degistirmeden baz vs senaryo karsilastirmasi uretmek.

Teslimatlar:

- `scenarios`, `scenario_runs`, `scenario_run_lines`,
  `scenario_assumptions`, `scenario_comparisons`.
- Gelir %, gider %, tum tahsilat gecikmesi, kapasite/verim proxy, borc servisi.
- Baseline vs scenario chart/table.
- Acik varsayim paneli.

Gate:

- `pnpm phase8:verify`.
- Baseline row-hash ve finance/production fingerprint degismez.
- Scenario sadece `scenario_*` tablolarina yazar.

---

## 11. Faz 10 — Excel Coverage Close-Out

Amac: Excel'de MVP'nin yuzeysel kaldigi alanlari domain'e daha derin ve
guvenli bicimde tasimak.

### 10A / 9A — Maliyet Detayi ve Akon Kar Marji

Durum: DONE, commitli.

Teslimatlar:

- `priceMargin` saf fonksiyon ve test.
- `cost_breakdown_lines`.
- `cost_models.akon_freze_tl_per_min`, `akon_torna_tl_per_min`.
- `extractCostModel` gider dokumu + Akon oranlari.
- `/production` kar marji paneli.
- Ana Ekran uretim seridi.

Gate:

- `pnpm phase9a:verify`.
- Tam gate ve commit.

### 10B / 9B — Aylik Gider Dokumu

Durum: DONE, commitli.

Teslimatlar:

- Aylik nakit akis sekmelerinde borclar, standart giderler, personel ve genel gider leaf satirlari.
- `cashflow_lines` gider kompozisyonu.
- `/cashflow/[monthId]` isletme gideri / vergi-SGK / kredi-finansman gruplari.

Gate:

- `pnpm phase9b:verify`.
- Ay toplamlarini degistirmeden kompozisyonu acma.
- Tam gate ve commit.

### 10C / 9C — Makine ROI + Ekipman

Durum: DONE, commitli.

Teslimatlar:

- `tablo` sekmesinden yalniz makine ROI ve ekipman maliyeti cikarilir.
- Kisisel/aile giderleri domain tablolara yazilmaz.
- `personal_data_mixed` review cozulmeden ROI map edilmez.
- `machine_assets.purchase_cost` guncellenir.
- Per-machine ve aggregate ROI snapshot yazilir.
- ROI confidence `needs_review` kalir.
- `/production` ROI paneli bu veriyi gosterir.
- `phase9c-verify.ts`.

Gate:

- `pnpm phase9c:verify`.
- Privacy leak testi.
- Idempotency testi.
- Financial integrity before/after testi.
- Tam gate ve commit.

### 10D / 9D — Kapasite Makine-Dakika + Faiz Makine-Tahsis

Durum: DONE, commitli.

Amac:

- Kapasite sekmesindeki parca/dakika bilgisini makine tipi ve mumkunse makine varligi seviyesine indirmek.
- Kredi/faiz maliyetini kapasite veya makine bazli tahsis edilebilir analitik yuke cevirmek.

Teslimatlar:

- Yeni tablolar veya kolonlar:
  - machine-minute allocation
  - machine utilization snapshots
  - finance cost allocation snapshots
- Extractor:
  - kapasite parca satirlarindan torna/freze dakika toplamlarini makine tipi seviyesine ayirir.
  - faiz hesaplama kredi maliyetini tahsis edilebilir toplam finansman maliyeti olarak alir.
- Engine:
  - makine tipi basina dakika, kapasite, kullanim, atil/asiri yuk.
  - finansman maliyeti / dakika veya finansman maliyeti / makine tahmini.
- UI:
  - `/production` icinde makine-dakika paneli.
  - finansman tahsis paneli: "bu makine/kaynak maliyeti uretim fiyatina ne kadar bindiriyor?"

Gate:

- `pnpm phase9d:verify`.
- Tahsis analitik olarak etiketlenir; muhasebe gercegi gibi sunulmaz.
- Finance/cashflow source tablolarini degistirmez.
- Tam gate ve commit.

---

## 12. Faz 11 — Decision Facts / Metrics Katmani

Durum: DONE. 11A ile `src/lib/facts` registry, `/api/facts` ve Ana Ekran karar sinyalleri eklendi.
11B ile `cash_runway` fact'i tamamlandi ve rapor promptlari decision facts katmanini kullanmaya basladi.

Amac: Dashboard, AI ve raporlar icin guvenli, deterministik, tekil bir facts API'si
olusturmak. AI ham SQL'e veya ham Excel'e gitmez; sadece bu facts katmanindan
cevap uretir.

Teslimatlar:

- `src/lib/facts/` modulu.
- Fact registry:
  - first negative month
  - worst cash month
  - cash runway
  - debt pressure months
  - top customer concentration
  - missing amount count
  - overdue payment load
  - check maturity load
  - loan debt service
  - production margin loss
  - stale-rate flags
  - unresolved review count
- Her fact icin:
  - value
  - severity
  - explanation
  - source links
  - freshness timestamp
  - confidence
- `/api/facts` veya server-only loader.
- Ana Ekran ve raporlar bu facts katmanini kullanmaya baslar.

Gate:

- Unit tests: fact hesaplari mevcut engine'lerle mutabik.
- No mutation.
- Source trace zorunlu.

---

## 13. Faz 12 — AI Soru-Cevap ve Rapor Yorum Katmani

Durum: DONE (12A). `phase12a:verify` PASS. 12A ile `/ask`, `ai_response_snapshots`, optional OpenAI Responses API provider,
deterministik fallback, rapor AI yorumu ve mutation guard eklendi.

Amac: Kullanici sorularini dogrudan cevaplamak ve cevabi tablo/grafik/kaynak linkiyle gostermek.

Ornek sorular:

- "Eylul 2026 neden eksiye dusuyor?"
- "Onumuzdeki 3 ay en riskli odeme hangisi?"
- "Hangi musterinin gecikmesi kasayi bozuyor?"
- "Bu ay hangi cek/kredi yukleri ust uste biniyor?"
- "Akon fiyatlari basabasi karsiliyor mu?"

Teslimatlar:

- `/ask` veya Ana Ekran icinde soru-cevap paneli.
- AI tool contract:
  - facts oku
  - scenario calistir
  - rapor oku
  - source row linki getir
  - finansal kayit mutasyonu yasak
- Cevap formatlari:
  - kisa cevap
  - nedenler
  - kaynak satir/sekme linkleri
  - onerilen aksiyon
  - ilgili grafik/table view
- Raporlarda "AI yorum uret" butonu.
- AI response snapshot ve audit.

Gate:

- AI hicbir payment/check/loan/cashflow kaydini degistiremez.
- Prompt injection ve source-content safety.
- Model cevaplari deterministik facts ile sinirlandirilir.
- Unit/integration tests: tool whitelist ve mutation guard.

---

## 14. Faz 13 — Senaryo v2 ve Finansman Optimizasyonu

Durum: DONE (13A+13B). `phase13a:verify` ve `phase13b:verify` PASS. 13A ile hedefli gelir gecikmesi, hedefli gider/odeme ertelemesi,
faktoring/iskonto overlay'i ve minimum finansman ihtiyaci metrigi scenario motoruna eklendi.
13B ile desteklenen mudahale adaylarini salt-okunur siralayan finansman optimizasyon paneli eklendi.

Amac: "what-if" motorunu karar motoruna yaklastirmak.

Teslimatlar:

- Musteri bazli gecikme:
  - "Hpt 30 gun gecikirse"
  - "Akon tahsilati 2 ay kayarsa"
- Tek odeme/cek/kredi taksit erteleme:
  - "Garanti kredi 2 ay otelenirse"
  - "Cagdas cekleri 30 gun kayarsa"
- Cek iskonto/faktoring senaryosu:
  - nakit girisi bugune cekilir
  - iskonto maliyeti gider olarak eklenir
- Minimum finansman ihtiyaci:
  - "Kasayi hic eksiye dusurmemek icin hangi ay ne kadar lazim?"
- Finansman optimizasyonu:
  - en az maliyetli mudahale kombinasyonu
  - odeme erteleme vs kredi vs cek iskonto karsilastirmasi
- Production -> cash link:
  - kapasite/verim degisiminin gelir/gider proxy'si acik varsayimla nakit akisa baglanir

Gate:

- Scenario output read-only kalir.
- Her varsayim `scenario_assumptions` satiri olarak acik beyan edilir.
- Baseline degismez.
- SQL cross-check ve before/after fingerprint.

---

## 15. Faz 14 — Veri Kalite Merkezi, Disgoru ve Aksiyon Workflow

Durum: DONE (14A-14E). `phase14a:verify` … `phase14e:verify` PASS. 14A ile `/data-quality`, `action_items`, review/home-action gorevlestirme,
gorev status akisi, ozel Excel sekme tanima paneli ve read-only action gate eklendi.
14B ile `/assumptions`, `external_assumptions`, kaynak/tarih/review status akisi ve
internet kaynaklari icin user-reviewed gate eklendi.
14C ile rapor ve AI cevaplarindan auditli action_items gorevi olusturma eklendi.
14D ile onayli dis varsayimlar facts/AI/senaryo baglamina salt-okunur ve kaynakli olarak baglandi.
14E ile Excel A/B surum farki, ozel dashboard/rehber sekme sinyali ve cashflow baslik mutabakati
veri kalite merkezinde gorunur hale getirildi.

Amac: Sistemin sadece gostermesini degil, karar almayi engelleyen sorunlari
yonetmesini ve dis varsayimlarla projeksiyonu zenginlestirmesini saglamak.

Teslimatlar:

### Veri kalite merkezi

- `/data-quality` veya Yonetim altinda yeni merkez.
- "Karar almayi engelleyen 5 veri sorunu".
- Eksik tutar tamamlama akisi.
- Negatif/anomali onay-ret.
- Excel versiyon farki:
  - workbook A vs workbook B
  - degisen aylar
  - degisen odeme kalemleri
  - degisen formuller
- `01_DASHBOARD`, `02_AYLIK OZET`, `00_REHBER` sekmelerinin ozel taninmasi.
- Excel dashboard degerleri ile uygulama hesaplari arasinda mutabakat paneli.

### Disgoru katmani

- Varsayim tablolari:
  - faiz oranlari
  - kur
  - enflasyon
  - personel/asgari ucret
  - enerji maliyeti
  - kredi oranlari
- Dis veri her zaman source ve tarih ile kaydedilir.
- Otomatik internet verisi varsa user-reviewed status ister.
- Disgoru, kaynak-of-truth'u degistirmez; sadece scenario/report/AI yorum katmanini besler.

### Aksiyon workflow

- Ana Ekran "Ne yapmaliyim?" listesi gorevlesir.
- Gorev alanlari:
  - title
  - severity
  - owner
  - due date
  - status
  - source fact
  - related entity
  - note
- Rapor ve AI cevaplari gorev olusturabilir; finansal kayit degistiremez.

Gate:

- Data-quality actionlari audit log yazar.
- Dis veri finansal source tablolarini degistirmez.
- Gorev workflow'u payment/check/loan mutasyonu yapmaz.
- AI task creation varsa onayli ve auditli olur.

---

## 16. Commit ve Gate Kurali

Her faz veya alt-faz ayri commitlenir.

Minimum gate:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm db:verify
pnpm db:roles:verify   # Faz 15'ten sonra: uygulama gercekten dusuk-yetkili rolle mi bagli
pnpm import:real
pnpm phase3:verify
pnpm phase4:verify
pnpm phase5:verify
pnpm phase6:verify
pnpm phase6b:verify
pnpm phase7:verify
pnpm phase8:verify
pnpm phase9a:verify
pnpm phase9b:verify
pnpm phase9c:verify   # Faz 10C tamamlaninca
pnpm phase9d:verify   # Faz 10D tamamlaninca
pnpm phase17:verify   # Faz 17'den sonra: kaynak taramasi, DB gerektirmez
pnpm phase18:verify   # Faz 18'den sonra: kaynak taramasi, DB gerektirmez
pnpm phase19:verify   # Faz 19'dan sonra: yeni tablo/view/trigger davranisi, DB gerektirir
pnpm phase20:verify   # Faz 20'den sonra: banka merkezi + TAM durum-gecisi matrisi, DB gerektirir
pnpm phase21:verify   # Faz 21'den sonra: fatura merkezi + 36 ciftlik durum matrisi, DB gerektirir
pnpm phase22:verify   # Faz 22'den sonra: dagitim tavani + alacak/borc read-model, DB gerektirir
pnpm phase23:verify   # Faz 23'ten sonra: tahsilat riski + elle bad-debt bayragi, DB gerektirir
pnpm phase24a:verify  # Faz 24A'dan sonra: onay varligi + 12 ciftlik gecis matrisi + legacy kopru regresyonu, DB gerektirir
pnpm db:roles-rls:verify # Faz 24B'den sonra: bes katmanli rol matrisi, GERCEK mas_radar_app baglantisiyla + SET ROLE, DB gerektirir
pnpm phase25:verify   # Faz 25'ten sonra: odeme sozu + kirilan soz tespiti + tahsilat puani, DB gerektirir
pnpm build
pnpm phase16:verify   # Faz 16'dan sonra: build'i gerektirir, bu yuzden build'den SONRA
```

Gerekirse phase-specific verify script'i once eklenir, sonra implementasyon yapilir.

---

## 17. Implementation Plan v4 — Faz 15-38 Kurumsal Genisleme Yol Haritasi

> Kaynak: kullanici-saglanan `MAS_Nakit_Radar_Revize_Mimari_Listesi.md` (34 bolum, ~700 madde),
> kod tabaninin gercek durumuna gore mutabakatlandirilmis. v3'un Faz 1-14 + P0-A/B/C bolumleri
> (yukarida) degismedi; bu bolum onlarin uzerine gelen genisleme yol haritasidir. Plan icindeki
> alt basliklar bir seviye indirilmistir (bu bolumun altinda yer alsinlar diye); metin aynidir.

### 1. Mutabakat (Reconciliation) — listeyi kör kopyalamamak için

#### 1a. Zaten büyük ölçüde yapılmış — yeniden inşa etme

| Liste maddesi | Gerçek karşılığı |
|---|---|
| "LLM finansal çekirdekten ayrık, sıfır DB yazma, sıfır SQL" (§1/§28, 40+ kez tekrarlanıyor) | `src/lib/ai/engine.ts` (179 satır) — tek LLM çağrı noktası, ham `fetch`, SDK yok. DB'ye hiç dokunmuyor. Yalnız önceden hesaplanmış `DecisionFact[]` görüyor. `mutationIntent()` regex koruması mutasyon niyetinde modeli hiç çağırmıyor. Deterministik cevap her zaman önce hesaplanıyor, model isteğe bağlı iyileştirme; hata `try/catch` ile deterministik cevaba dönüyor. Her yanıt `response_mode` (`deterministic\|openai\|fallback`) + `source_fact_keys`/`source_hrefs` ile izlenebilir. `AI_FORCE_DETERMINISTIC=1` sert kapatma anahtarı var. |
| "Deterministik sorgu + allowlist" (§24/§28) | `src/lib/facts/engine.ts` (262 satır) — `loadDecisionFacts()`, tamamen SQL/TS, 12 sabit fact + onaylı her dış varsayım için bir tane, `/api/facts` ile dışa açık. Çalışan bir prototip. |
| "Finansal invariant test gate'leri" (CI altyapısı, §1) | 26 faz/DB doğrulama script'i (`scripts/phase{3..14e}-verify.ts` + `scripts/db/{constraints,legacy-repair,migrate,reconciliation,transitions}-verify.ts`) + 17 saf `rules.ts` birim test dosyası + implementation.md §16'da belgeli pnpm gate zinciri. Bu zaten istenen desen — CI onu sarmalamalı, paralel bir tane icat etmemeli. |
| "Audit log kapsamı" (temel) | `audit_logs`, BEFORE-trigger'larla (migration 0022) append-only — superuser dahil UPDATE/DELETE/TRUNCATE engelleniyor. Gerçek boşluk yokluk değil, tekrar (13 bağımsız `audit()` kopyası — bkz. 1b). |
| "Immutable finansal kayıt", "correction/reversal modeli" (kısmi, §2) | `archived_immutability_trigger` (0024), `cancellation_fields` (0026), `payment_instance_amount_source` (0028/0029) zaten iptal-et-ve-koru desenini kuruyor. |
| Loan schedule (§2) | `loan_installments`, gerçek. |
| Check lifecycle (§2) | `checks`+`check_events` — settlement (cleared/bounced/paid) DB'de yalnız migration 0034'ten SONRA fiilen çalışır hâle geldi. Bu "yapıldı, unut" değil, "yapıldı, ve bu sınıf hatanın bu repoda bir kez gerçekten yaşandığının kanıtı" (bkz. §2 madde 3). |
| Machine (§2) | `machine_assets`, gerçek, üretim kârlılığına zaten bağlı. |
| Data lineage / Source evidence (§2/§23) | `source_workbooks/source_sheets/source_cells/import_rows` — şemanın en olgun parçası. **Her yeni entity'nin lineage ihtiyacı bu deseni tekrar kullanmalı, ikinci bir mekanizma icat edilmemeli.** |
| Financial period (yumuşak, §2/§21) | `cashflow_months.status` (`draft/review_needed/reviewed/locked`) — Dönem Kapatma'nın gerçek alt yapısı. |
| Management Cockpit (§26) | `src/lib/home/cockpit.ts` — `overview/` sayfasını zaten besliyor (doğrulandı: `page.tsx` içe aktarıyor). Genişlet, sıfırdan kurma. |
| Forecast/Scenario (kısmi, §11/§12) | `scenarios/scenario_runs/scenario_run_lines/scenario_assumptions/scenario_comparisons` (Faz 9/13, DONE) — "what-if overlay"e "rolling forecast"tan daha yakın ama sağlam bir temel. |
| CFO Morning Brief (kısmi, §25) | `reports/engine.ts` + Telegram hatırlatmaları (Faz 6) zaten günlük/haftalık özet + AI yorumu üretiyor. |
| Notification & Action (kısmi, §30) | `action_items` (Faz 14) + `reminders`/`reminder_deliveries` — owner/severity/due-date/status alanları var, dar kapsamlı. |
| Financial Control / Anomaly (kısmi, §18/§19) | `mapping_reviews` + `metric_snapshots` + `action_items` bugünkü veri kalite merkezinde (Faz 14) ince yayılmış hâlde var. |
| "RLS enabled" (§1) | Zaten her tabloda blanket `0007_rls.sql` deseniyle (`for all to authenticated using(true) with check(true)`, 11 dosyada 25 kez) + 3 kasıtlı istisna (schema_migrations, users/sessions, audit_logs). **Bu, CLAUDE.md'nin "tek şirket iç paneli" ilkesine göre bilinçli bir tasarım — ama kullanıcı tam rol matrisi + satır-seviyesi RLS istedi (bkz. Çözülen Kararlar #3), yani Faz 24B'de GERÇEKTEN yeniden işlenecek.** |
| Chart/analitik altyapısı (§1) | `analytics/chart.ts` (202 satır, ChartModel sözleşmesi) + `analytics/models.ts` (~8 model builder) + `analytics-chart.tsx` (241 satır, el yazımı SVG, line/bar/stacked-bar). Üzerine inşa edilecek gerçek bir temel, yıkılacak bir duvar değil. |

#### 1b. Kısmen var, gerçekten genişletilecek

| Liste entity'si | Mevcut tablo/dosya | Gerçekte eksik olan |
|---|---|---|
| Counterparty/Customer/Supplier/Contact | `parties` (0002) | Tek polimorfik tablo, adres/vergi-no/IBAN kolonu yok. Çekler/krediler bilinçli olarak ham `counterparty_label` metni tutuyor çünkü **uygulama mapping sırasında sessizce parties satırı YARATMIYOR** — bu kural korunmalı. |
| Bank account | `cash_accounts` | Genel defter hesabı, IBAN/şube-farkında değil. |
| Credit facility | `loans` | Sabit-planlı tek kredi modeli, revolving limit/draw değil. |
| Approval / Approval step | İki bağımsız tekrar: `mapping_reviews` + `external_assumptions.review_status` | Gerçek bir Approval entity yok — üçüncü bir özel varyant eklemek yerine ikisi birleştirilmeli. |
| Notification/alert | `reminders`+`reminder_deliveries` | Yalnız 3 hedef türü, 2 kanal — genişletilecek. |
| Anomaly/Control result | `mapping_reviews`+`metric_snapshots`+`action_items`'a ince yayılmış | Skorlama/durumlu ayrık tablo yok. |
| Forecast/Forecast line | `scenario_runs`/`scenario_run_lines` | What-if'e yakın; kaynak sınıflandırması (contracted/scheduled/historical/manual/estimated), güven skoru, forecast-vs-actual eksik. |
| Financial period | `cashflow_months.status` | Kavram var, kapanış checklist/blocker akışı yok. |
| Chart registry | `analytics/chart.ts`+`analytics-chart.tsx` | Yalnız line/bar/stacked-bar; liste ~40 tip istiyor — gerçek yeni iş. |

#### 1c. Gerçekten yeni (greenfield)

Bank transaction, Invoice/Invoice line, Collection/Payable/Receivable (ayrık entity olarak), Payment/Collection allocation, Cost center/Department/Project, Order, Product (production_parts yalnız işleme-odaklı dar bir analog), genel Document/Attachment, Budget/Budget line, FX position/FX rate snapshot tablosu, kalıcı Reconciliation entity'si (bugün yalnız uygulama içi kod), Promise-to-pay, Integration connection/sync job, Universal Search, CSRF koruması, rate limiting, çerez-varlığı ötesi oturum sertleştirmesi, migration-vs-runtime DB kullanıcı ayrımı, `.github/workflows` (hiç yok), secret rotation aracı, GitHub repo görünürlüğü aksiyonu.

#### 1d. Kod tabanına uymayan tek madde, düzeltilmiş hâliyle

**Liste diyor ki:** "float8'i kaldır → NUMERIC/decimal'e geç" (paranın float8 olarak saklandığını varsayıyor).
**Gerçek:** 41 tablonun, 34 migrasyonun TAMAMINDA her para kolonu `numeric(p,s)`. Sıfır float8/double precision/real kolonu var — **bizzat doğrulandı** (`grep -rc "::float8"` ve tablo taraması). Bu haliyle iddia yanlış.
**Gerçek, farklı risk:** **141 adet `::float8` SQL cast'i, 25 dosyada** (bizzat doğrulandı — en yoğun: `production/engine.ts` 45, `scenarios/engine.ts` 11, `financing/engine.ts` 10, `radar/queries.ts` 9). node-postgres `numeric`'i varsayılan olarak string döndürüyor, kod bunu SQL içinde JS'e vermeden önce `double precision`'a cast ediyor. Paylaşılan "money" yardımcı modülü yok, `decimal.js`/`big.js` bağımlılığı yok. `radar/queries.ts:152-153` aynı ifadede hem `::numeric` hem `::float8` kullanıyor. **Risk depoda değil, SQL/JS sınırında.**

---

### 2. Her fazda geçerli, tek seferlik değil, standart kurallar

1. **Migration ledger disiplini.** `scripts/db/migrate.ts`'in checksum/anchor kontrollü 4-durumlu mekanizması her yeni migration için aynen işler — asla elle şema değişikliği yok.
2. **Yeni her tabloya kendi migration'ında blanket RLS politikası** (`for all to authenticated using(true) with check(true)`) — Faz 24B'den SONRA bu, gerçek rol-bazlı politikalarla değiştirilecek; o ana kadar mevcut desen aynen sürer.
3. **Status-transition-guard doğruluğu gün-1'den.** Yaşam döngüsü olan HER yeni entity (Invoice, Approval, Reconciliation, Period, Bank transaction eşleşme durumu, Budget/Forecast versiyon durumu) allow-list'ini CHECK constraint'le AYNI migration'da, doğru kurmalı. **Bu genel bir temkin değil — migration 0027, checks/loan_installments'ı yalnız `planned→cancelled` ile açtı, halbuki `cleared/bounced/paid` 0005'ten beri CHECK constraint'te geçerliydi; gerçek dev DB'de 7/7 çek ve 48/48 taksit `planned`de SIKIŞIP KALDI, 0034'e kadar (8 migration sonra) düzelmedi.** Aşağıdaki her fazın gate'i bunu kendi maddesi olarak tekrar eder.
4. **Tek paylaşılan `audit()`, tek `DomainError` kuralı, tek Zod sınırı** — Faz 18'de kurulur, Faz 19'dan itibaren ZORUNLU (opsiyonel değil).
5. **`docs/database-schema.md` şema değişen HER fazda güncellenir** — bugün ~migration 0021'den sonrası eksik; Faz 18 yakalar, sonraki her faz kendi definition-of-done'ında tutar.
6. **Para matematiği Faz 17'nin decimal-safe katmanından geçer** — Faz 17'den sonra yeni `::float8` cast'i YASAK, standing `phase17:verify` grep kontrolüyle.
7. **Gate zinciri genişler, yerini almaz.** implementation.md §16'daki mevcut pnpm zincirine (`lint && typecheck && test && db:verify && import:real && phase3:verify ... phase14e:verify && build`) `phase15:verify`...`phase38:verify` sırayla eklenir, `scripts/phaseN-verify.ts` adlandırma deseni aynen sürer.

---

### 3. Çözülen kararlar (kullanıcı onayladı — artık açık soru değil)

1. **Kapsam: tam 24 faz, hepsi bu belgede detaylı.** Hiçbir faz "sonra detaylandırılır" özetine indirgenmedi.
2. **Python runtime: YOK.** Faz 29 (Senaryo/Optimizasyon) ve Faz 34 (Agresif Analiz) dahil tüm deterministik hesaplama TypeScript/SQL'de kalır — mevcut mimariyle birebir tutarlı, yeni bir servis/süreç eklenmez.
3. **Tam 5 katmanlı rol matrisi (Viewer/Finance-Operator/Finance-Approver/Finance-Manager/Admin) + satır-seviyesi RLS uygulanacak.** Bu, Faz 24'ü ikiye ayırmayı gerektirdi: **24A** (Approval entity + basit workflow, küçük kapsam) ve **24B** (tam rol matrisi + RLS'in bugünkü blanket-allow politikasından gerçek rol-bazlı politikalara geçirilmesi — TÜM tabloları etkileyen büyük, kendi başına bir faz).
4. **Entegrasyon Merkezi (Faz 37) kapsamı onaylandı:** Banka API'si (canlı hesap hareketi), e-Fatura/e-Arşiv, bir muhasebe yazılımı (Paraşüt/Logo/Mikro/Luca — **hangisi olduğu Faz 37 başlarken netleştirilecek**, kullanıcı henüz tek bir vendor seçmedi), TCMB kur entegrasyonu (Faz 27'nin FX çalışmasıyla kesişiyor — Faz 27 manuel/anlık-kayıt sürümünü yapar, canlı bağlantı Faz 37/38'de).

#### Hâlâ açık, faz başlarken sorulacak (kullanıcı şimdi karar vermek istemedi/gerek yok)

1. Tam self-servis parola sıfırlama + MFA + oturum rotasyonu derinliği (Faz 15/16).
2. Monte Carlo simülasyon altyapısı gerçekten gerekli mi (Faz 34).
3. ~40 chart tipi / ~40 analiz tipinin tam listesi mi, ilk dilim mi (Faz 34 — ilk dilim olarak 5-8 analiz tipi + birkaç yeni chart tipiyle scoped, onaylanırsa genişler).
4. WhatsApp entegrasyon iskeleti (Faz 25).
5. Sesli soru sorma modalitesi (Faz 38).
6. n8n bağlantısı — kullanıcı zaten n8n kullanıyor mu, yoksa aspirasyonel mi (Faz 37/38).
7. Doküman Merkezi depolama arka ucu — yerel disk/Postgres large object/harici obje depolama (Faz 35).
8. CI/CD'nin amacı — yalnız pre-merge gate runner mı (öneri), yoksa sürekli-açık bir hosting hedefi de ima ediyor mu (Faz 16; `docs/local-production-deploy.md` remote deploy'u zaten "bilinçli kapsam dışı" diyor).
9. Order/Product'ın tam sipariş-yönetimi derinliği mi, yalnız referans veri mi (Faz 19 — öneri: minimal referans, CLAUDE.md'nin "muhasebe programını yeniden yazma" sınırına saygıyla).

---

### 4. Faz yol haritası — Faz 15 ile Faz 38 arası (24 faz numarası, Faz 24 iki alt-faza bölündü)

#### Faz 15 — Acil Güvenlik ve Repo Hijyeni

**Aciliyet notu:** Bu repo bu oturumda İLK KEZ GitHub'a push edildi (`aydinogluomer-sys/Mas-Saas`). Bu fazın ilk maddesi, planın geri kalanından bağımsız olarak, plan onaylanır onaylanmaz HEMEN yapılmalı.

**Amaç:** Bu oturumdaki ilk push'un yarattığı açığı, başka hiçbir çalışma başlamadan kapatmak.

**Teslimatlar:**
- GitHub repo görünürlüğünü private yap/doğrula — **planın en ucuz, en acil maddesi.**
- Secret rotation: DB parolası, `SEED_ADMIN_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY` yenilenir; git geçmişinde secret taraması yapılır.
- Dağınık `process.env.X` okumaları yerine tek, Zod-doğrulamalı `src/lib/env.ts`.
- Migration/runtime rolünden ayrı, gerçek düşük-yetkili bir runtime DB rolü (örn. `mas_radar_app`) — migrasyonlar hâlâ owner rolüyle çalışır, Next.js sunucusu artık `BYPASSRLS`'siz, superuser olmayan bu rolle bağlanır. RLS bundan sonra fiilen bir şey engellemeye başlar.
- `README.md`'yi (bugün varsayılan create-next-app şablonu) gerçek proje tanıtımıyla değiştir.
- `.env.example` eksiksizlik denetimi.

**Gate:** `pnpm typecheck/lint/test/db:verify` yeni runtime rolüne karşı geçer; yeni `db:roles:verify` runtime rolünün BYPASSRLS/superuser taşımadığını ve RLS'in tek başına erişimi kapadığını doğrular; repo-private + secret-rotation elle onayı `docs/status-notes.md`'ye kaydedilir.

---

#### Faz 16 — CI/CD, Gözlemlenebilirlik, API/Oturum Güvenliği Temeli

**16A — CI/CD + Observability:**
- `.github/workflows/ci.yml`: mevcut pnpm gate zincirini (lint/typecheck/test/db:verify/phase3-14e:verify/build) geçici Postgres konteynerine karşı sarmalar + sıfırdan migration testi.
- `/health`, `/ready`, `/version` route handler'ları (`.env.example`'da zaten var olan `APP_COMMIT_SHA`/`APP_BUILD_TIME`'ı devreye sokar).
- Structured logging + correlation ID; `DomainError`'ın etrafına paylaşılan bir global hata-yanıt biçimi.
- `system/` altında admin diagnostics ekranı (mevcut `system/{actions,archive,audit,backup,features,security}` desenine uygun).

**16B — API sözleşmesi + oturum sertleştirme:**
- Route handler'lar için API yanıt/hata zarfı standardı.
- Auth ve mutasyon endpoint'lerinde rate limiting.
- CSRF doğrulaması (bugün doğrulanmış şekilde YOK).
- Oturum sertleştirme (yetki değişiminde rotasyon, boşta-kalma zaman aşımı).

**Gate:** yeni `phase16:verify` — `/health`/`/ready`/`/version` doğru yanıt veriyor, sahte bir CSRF/rate-limit isteği reddediliyor mu kontrol eder; CI yeşili artık sonraki her fazın gate'inin parçası.

---

#### Faz 17 — Para Hassasiyeti: Uçtan Uca Numeric Katmanı

**Amaç:** ~20 yeni para-taşıyan entity kendi float8 cast'ini eklemeden önce, doğrulanmış 141 cast'i ortadan kaldırmak.

**Teslimatlar:**
- Paylaşılan `src/lib/money.ts`: tipli decimal yardımcıları (`decimal.js` veya `big.js` bağımlılığı eklenir — bugün yok), Postgres `numeric` string'lerinin güvenli ayrıştırılması.
- İsteğe bağlı: `numeric` OID için özel `pg` type parser'ı — sorgu-başına `::float8` yerine standart string-giriş/decimal-çıkış davranışı.
- 141 mevcut çağrı noktasını öncelik sırasına göre taşı: `production/engine.ts` (45), `scenarios/engine.ts` (11), `financing/engine.ts` (10), `radar/queries.ts` (9, `152-153`'teki karışık `::numeric`/`::float8` dahil), `data-quality/engine.ts` (6), kalan 20 dosya.
- Büyük TL tutarları ve yüzde-üstü-yüzde hesaplamalarında hassasiyet kaybı olmadığını kanıtlayan birim testleri.

**Gate:** yeni `phase17:verify`, izin-listesi dışında hiç `::float8` kalmadığını doğrular (küçük, gerekçeli bir istisna dosyası kabul edilir, her satır yorumlu); mevcut phase3-14e zinciri değişmeden geçmeli (çıktı değerleri yalnız yuvarlama toleransı içinde kalabilir, bu ayrıca test edilir).

---

#### Faz 18 — Paylaşılan `audit()`/`DomainError`/Zod Sınırı + Şema Dokümanı Yenilemesi

**Amaç:** 13 bağımsız `audit()` kopyasını (bizzat doğrulandı) ~20 yeni entity 14'üncü bir varyant eklemeden konsolide etmek; `docs/database-schema.md`'yi ~migration 0021'den yakalamak.

**Teslimatlar:**
- `src/lib/audit.ts`: tek kanonik `audit(client, {actor, action, entityTable, entityId, before, after, ...})` — `radar/engine.ts`'in en eksiksiz imzası (opsiyonel legacy-repair zaman damgası override'ı dahil) temel alınır. 13 çağrı noktası (ai, analytics/snapshots, archive, cashflow, data-quality, external-assumptions, financing, payments, production, radar, reports, scenarios, users) taşınır.
- `DomainError` kuralı (bugün 14 engine.ts'in yalnız birkaçında) bu fazdan itibaren tüm yeni kod için ZORUNLU olarak belgelenir (mevcut kodun toptan retrofit'i kapsam dışı — istenirse ayrı bir temizlik fazı önerilir).
- `src/lib/validation/` gerçek Zod sınırına dönüşür: `parseOrThrow` tarzı yardımcı + server-action-başına-şema kuralı, bu fazdan itibaren tüm yeni kod için.
- `docs/database-schema.md`, migration 0022-0034'ü (audit append-only, archived immutability, payment-instance amount-source, cancellation fields, status-transition guard'lar, users/sessions, actor-FK repoint, check/loan settlement) + "yeni tablo eklerken checklist" (RLS politikası, yaşam-döngüsü varsa transition guard, `audit()` çağrısı, migration-ledger anchor) ile güncellenir.

**Gate:** yeni `phase18:verify` — `audit.ts` dışında hiçbir yerde `insert into public.audit_logs` olmadığını grep ile doğrular; mevcut zincir geçer; `docs/database-schema.md` gözden geçirmesi elle işaretlenir.

---

#### Faz 19 — Karşı Taraf (Cari Hesap) ve Organizasyonel Boyutlar Çekirdek Veri Modeli

**Bağımlılık:** Faz 17, 18.
**Amaç:** Bu yol haritasındaki en büyük paylaşılan bağımlılık — Banka Merkezi, Cari Hesap, Fatura Merkezi, Alacak/Borç, Tahsilat hepsi bundan önce başlayamaz.

**Teslimatlar:**
- `parties`'e 1:1 `counterparty_profiles` tablosu (adres, vergi no, kredi limiti) — `parties`'i değiştirmek/yeniden adlandırmak yerine, mevcut FK grafiğini (checks/loans/payments'taki payee/payer/bank_party_id) bozmadan.
- `ibans` tablosu, per-counterparty append-only değişiklik-audit trigger'ıyla (0024'ün immutability deseni).
- "Mapping sırasında sessizce parties yaratma" kuralı yeni counterparty-oluşturma UI/action'ında açıkça korunur.
- Counterparty exposure/risk skoru bir SQL view olarak (ikinci, sessizce bayatlayabilecek bir kaynak yaratmamak için stored mutable kolon değil).
- **Minimal** referans tabloları: `cost_centers`, `departments`, `projects`, `products`, `orders` — yalnız ad/kod/opsiyonel counterparty bağlantısı, henüz tahsis mantığı veya sipariş-yaşam-döngüsü yok (§3'teki açık soru #9 uyarınca minimal tutuldu).

**Gate:** `phase19:verify`; `db:constraints:verify` yeni FK'lar için genişletilir; ham `counterparty_label` taşıyan eski çek/kredi satırları zorla geri-doldurulmaz. Yaşam-döngüsü kolonu yok, transition-guard maddesi bilinçli olarak N/A.

---

#### Faz 20 — Banka Merkezi (çekirdek)

**Bağımlılık:** Faz 19, 17, 18.
**Amaç:** Bugün zaten var olan entity'lere (payments/checks/loan_installments) karşı eşleşen gerçek banka hesabı/hareketi. Fatura/tahsilat eşleşmesi Faz 22'ye ertelendi.

**Teslimatlar:**
- Gerçek banka hesabı modeli: `cash_accounts`'a IBAN/şube/kullanılabilir/bloke/KMH kolonları eklemek veya ayrık `bank_accounts` tablosu — **faz başlarken netleştirilecek açık bir mimari karar.**
- `bank_transactions` (ham içe aktarılan satırlar), Faz 2'nin source-lineage desenini tekrar kullanarak.
- CSV/XLSX ekstre import pipeline'ı, mevcut workbook-import desenlerini tekrar kullanarak.
- Deterministik kural-tabanlı otomatik sınıflandırma.
- Mevcut `payments`/`checks`/`loan_installments`'a karşı mutabakat eşleştirme (fatura/tahsilat eşleştirmesi Faz 22'de eklenir), eşleşme-güven skoru, önerilen-eşleşme, eşleşmemiş-işlem kuyruğu, duplicate tespiti.
- Banka API entegrasyon iskeleti **açıkça Faz 37'ye ertelendi** — bu faz yalnız ekstre-importu.

**Gate:** `phase20:verify`; **transition-guard zorunluluğu:** `bank_transactions.status` (`unmatched→suggested→matched→reconciled` + red yolu) allow-list'i, sütunla AYNI migration'da, CHECK constraint'in izin verdiği her değerle eşleşerek kurulmalı — 0027→0034 emsali bu fazın kendi gate maddesi olarak tekrarlanır.

---

#### Faz 21 — Fatura Merkezi

**Bağımlılık:** Faz 19.
**Teslimatlar:**
- `invoices`+`invoice_lines`, `parties` (müşteri/tedarikçi) ve nullable `cost_centers`/`projects` FK'ları.
- Fatura durum yaşam döngüsü (`draft/open/partial/paid/closed/cancelled`).
- Duplicate-fatura tespiti (counterparty+numara+tutar+tarih sezgisi).
- İptal/reversal, sessiz durum değişimi değil bağlı bir reversal kaydı (Faz 18 audit kuralı + 0024/0026 immutable-kayıt emsaliyle uyumlu).

**Gate:** `phase21:verify`; **transition-guard zorunluluğu** (§2 madde 3): fatura durum allow-list unit testi merge öncesi zorunlu gate maddesi.

---

#### Faz 22 — Tahsilat/Ödeme Eşleme ve Cari Hesap Hareketleri

**Bağımlılık:** Faz 19, 20, 21.
**Teslimatlar:**
- `payment_allocations`/`collection_allocations` (çok-faturaya-çok-ödeme bağlantısı — bugünkü `payment_instances` yalnız tek-örnek kısmi ödemeyi kapsıyor).
- Receivables/Payables önce fatura+allocation üzerinde SQL view olarak; bağımsız bir yaşam döngüsü gerekirse gerçek tabloya terfi ettirilir — **faz başlarken netleştirilecek açık tasarım kararı.**
- Cari Hesap müşteri/tedarikçi kartı: bakiye, hareket geçmişi, açık alacak/borç, ortalama ödeme/tahsilat süresi — Faz 19-21 üzerine read-model sorguları, yeni kaynak veri değil.
- Faz 20'nin banka-işlemi mutabakatı artık fatura/tahsilata karşı da eşleşir.
- Yaşlandırma kovaları (1-7/8-30/31-60/60+), DSO/DPO temel hesapları.

**Gate:** `phase22:verify`; §18'in "ödenen>fatura", "tahsilat>alacak" invariant'larının ilk gerçek testi — allocation toplamı fatura tutarını asla aşamaz, PostgreSQL CHECK/trigger olarak burada uygulanır ve `db:constraints:verify`'e eklenir.

---

#### Faz 23 — Alacak/Borç Yönetimi Genişletme

**Bağımlılık:** Faz 22.
**Teslimatlar:**
- Gecikme/risk bayrağı hesaplama, expected-collection-date, collection-probability deterministik sezgiyle (ML değil).
- Ödeme önceliklendirme/cash-aware scheduling view'ı, mevcut payments modülünü besler.
- Ödeme takvimi genişletmesi.
- Bad-debt işaretleme yalnız elle, denetlenen bir bayrak — asla otomatik silme.

**Gate:** `phase23:verify`; mevcut `phase4:verify`/`phase5:verify`'ın (ödeme/nakit akış radarı) değişmeden geçtiği regresyon zorunluluğu — bu faz mevcut vade/gecikme mantığını genişletir, bozmaz.

---

#### Faz 24A — Onay/Maker-Checker Entity ve Basit Workflow

**Bağımlılık:** Faz 21, 22, 23.
**Amaç:** Bugün var olan iki bağımsız tekrarı (mapping_reviews + external_assumptions.review_status) tek gerçek entity'de birleştirmek.

**Teslimatlar:**
- `approvals`+`approval_steps`, iki mevcut çağrı noktası buraya taşınır (üçüncü özel bir varyant BIRAKILMAZ).
- Onay-kuralı yapılandırması: tutar-eşiği, yeni-IBAN, yeni-tedarikçi, fatura/ödeme tetikleyicileri (bütçe/forecast/senaryo tetikleyicileri Faz 28/29'da eklenir).

**Gate:** `phase24a:verify`; **transition-guard zorunluluğu:** `approvals.status` (`pending→approved/rejected/reworked`) allow-list'i gün-1'den doğru.

---

#### Faz 24B — Tam Rol Matrisi + Satır-Seviyesi RLS Uygulaması

**Bağımlılık:** Faz 24A, Faz 15 (BYPASSRLS/superuser kaldırılmış olmalı — yoksa RLS politikaları hiçbir şeyi engellemez).
**Amaç:** Kullanıcının onayladığı büyük genişleme — bugünkü blanket-allow RLS politikasını (`using(true)`, 11 dosyada 25 kez) gerçek 5-katmanlı rol-bazlı politikalarla değiştirmek. **Bu, planın en geniş kapsamlı tek fazı — neredeyse her tabloya dokunur.**

**Teslimatlar:**
- `users.role` enum'unu (bugün yalnız `admin|operator`) `viewer|finance_operator|finance_approver|finance_manager|admin` olarak genişlet — mevcut `admin`/`operator` değerlerinin yeni enum'a güvenli migration'ı (veri kaybı yok, açık bir eşleme tablosuyla).
- Permission matrix: her rolün hangi tablo/aksiyon üzerinde ne yapabileceğinin merkezi tanımı (kod içi sabit + doğrulanabilir).
- 41 mevcut tablo + Faz 19-24A'da eklenen yenilerin HER BİRİ için, bugünkü tek blanket politika yerine role-farkında RLS politikaları — örn. `viewer` yalnız SELECT, `finance_operator` kendi girdiği kayıtları INSERT/UPDATE edebilir ama onaylayamaz, `finance_approver`/`finance_manager` Faz 24A'nın approval adımlarını yürütebilir, yalnız `admin` şema-seviyesi işlemler.
- Role-based navigation'ın backend tarafı (UI tarafı Faz 36'da).
- Mevcut `authenticated`-all politikalarının HİÇBİRİ sessizce bırakılmaz — her biri ya rol-bazlı bir politikayla değiştirilir ya da (view/reference tablolar gibi düşük riskli olanlar için) neden blanket kaldığı açıkça yorumla belgelenir.

**Gate:** yeni `db:roles-rls:verify` — her rol için "şunu yapabilmeli/yapamamalı" matrisini gerçek DB bağlantılarıyla test eder (ör. `viewer` rolüyle bağlanan bir oturumun bir ödeme INSERT etmeye çalışması reddedilmeli); mevcut phase3-23 zincirinin YENİ rol modeliyle de değişmeden geçtiği ayrıca doğrulanır (regresyon riski yüksek, bu fazın en kritik testi budur); `db:constraints:verify`/`db:transitions:verify` yeniden çalıştırılır.

---

#### Faz 25 — Tahsilat Merkezi

**Bağımlılık:** Faz 22, 23.
**Teslimatlar:**
- `promise_to_pay` tablosu, tarih takibi + broken-promise tespit işi.
- Tahsilat notları/aksiyon geçmişi — mevcut `action_items` deseni tekrar kullanılır, ikinci bir görev modeli icat edilmez.
- Tahsilat KPI'ları (customer collection score) hesaplanan view olarak.
- `reminders`/`reminder_deliveries` hedef-türü genişletilir (bugün 3 tür/Telegram+1 kanal); e-posta kanalı eklenir.
- **WhatsApp iskeleti §3 açık soru #4 — varsayılan olarak ertelenir.**

**Gate:** `phase25:verify`; mevcut hatırlatma duplicate-önleme testi yeni hedef türlerini kapsayacak şekilde genişletilir.

---

#### Faz 26 — Hazine/Likidite Merkezi (Treasury)

**Bağımlılık:** Faz 20, 17.
**Teslimatlar:**
- Günlük/banka-bazlı/para-birimi-bazlı cash position view'ı, `bank_accounts`+`bank_transactions`+mevcut `cashflow_months` üzerine.
- 7/30/90 günlük likidite tahmini — mevcut cashflow-forecast motorunu (Faz 5) genişletir, paralel bir tahmin motoru değil.
- Minimum-cash/likidite-açığı/finansman-ihtiyacı tespiti, yapılandırılabilir cash-buffer politika eşiği.
- `finance/` altında yeni treasury dashboard'u (mevcut rota ağacına göre doğal ev).

**Gate:** `phase26:verify`; yeni treasury cash position'ın `cashflow_months`'un mevcut closing-balance rakamından hiç sessizce sapmadığını doğrulayan tutarlılık testi.

---

#### Faz 27 — Finansman Merkezi Genişletme + FX/Kur Riski

**Bağımlılık:** Faz 19, 20.
**Teslimatlar:**
- `credit_facilities` (limit/kullanılan/kullanılabilir/çekim) — bugünkü sabit-planlı `loans`'tan ayrık, gerçek yeni bir kavram.
- `collateral_records`, `covenant_records`.
- Debt-maturity ladder (30/90/180/365 gün), `loan_installments`+`credit_facilities` üzerine hesaplanan view.
- `fx_positions`+`fx_rate_snapshots` (gerçek yeni tablolar).
- TCMB kur entegrasyonu bu fazda MANUEL/programlı-çekim+kayıt olarak (canlı akış değil) — canlı/otomatik bağlantı Faz 37/38'e ertelenir.
- FX revaluation, gain/loss, stres testleri (±%5/10/20) — deterministik SQL/TS.

**Gate:** `phase27:verify`; tüm yeni FX/finansman matematiği gün-1'den Faz 17'nin para yardımcısından geçer (yeni `::float8` cast'i yasak, standing kontrol).

---

#### Faz 28 — Bütçe ve Rolling Forecast

**Bağımlılık:** Faz 21-27.
**Teslimatlar:**
- `budgets`+`budget_lines` (yıllık/aylık/departman/cost-center/proje — Faz 19'un boyut tablolarını kullanarak).
- Bütçe-vs-gerçekleşen, varyans analizi (deterministik SQL; açıklamalar mevcut AI-yorum desenini [Faz 12] tekrar kullanır — yeni LLM matematiği yok, sınır zaten doğru).
- `scenario_runs`/`scenario_run_lines`'ı (veya paralel `forecasts`/`forecast_lines`'ı) kaynak sınıflandırması (contracted/scheduled/historical/manual/estimated), güven skoru, forecast-vs-actual, doğruluk KPI'larıyla gerçek bir rolling forecast'e genişletir — mevcut senaryo motorunun ciddi bir genişlemesi, basit bir yeniden kullanım değil.
- 13 haftalık cash forecast, adlandırılmış bir ufuk view'ı olarak.
- **Pekiştirme, yeni iş değil:** forecast matematiği TS/SQL'de kalır (Çözülen Karar #2); LLM forecast zincirinin dışında kalır — `ai/engine.ts`'in mevcut mimarisi zaten bunu sağlıyor, bu faz onu bozmamalı.

**Gate:** `phase28:verify`; **transition-guard zorunluluğu:** `budget_lines`/`forecast_lines` versiyon-durum kolonu (`draft/approved/superseded`) allow-list'i gün-1'den doğru.

---

#### Faz 29 — Senaryo/Optimizasyon Genişletme

**Bağımlılık:** Faz 28, 22, 27.
**Teslimatlar:**
- Optimal ödeme zamanlaması/finansman karması/cash-buffer önerisi, **deterministik TypeScript/SQL çözücü mantığıyla (Çözülen Karar #2 — Python YOK)**.
- Çok-değişkenli senaryo karşılaştırma/versiyonlama, Faz 24A'nın Approval entity'sine senaryo-onayı için bağlanır (ters yönde değil).

**Gate:** `phase29:verify`; Faz 8/13'te kurulan baseline-korunur/salt-okunur-overlay invariant'ı her yeni senaryo tipine karşı yeniden test edilir — bu asla bozulmamalı.

---

#### Faz 30 — Maliyet Merkezi + Kârlılık Motoru + İşletme Sermayesi

**Bağımlılık:** Faz 19, 21, mevcut `production/engine.ts` (kârlılık emsali zaten orada var).
**Teslimatlar:**
- Masraf-dağıtım kuralları (ortak/makine/personel/enerji/proje) `cost_centers`/`departments`/`projects` üzerine.
- Kârlılık view'ları: şirket/departman/cost-center/müşteri/tedarikçi/proje/ürün/sipariş/makine — `production/engine.ts`'in mevcut kârlılık-hesaplama desenini şablon olarak tekrar kullanır, yeniden icat etmez.
- Working-capital dashboard: AR/AP analizi, cash-conversion cycle, DSO/DPO/DIO trendi — Faz 22/23/26 read-model'lerinden çekilir, yeni kaynak veri yok.

**Gate:** `phase30:verify`; tüm para matematiği Faz 17'nin yardımcısından geçer (standing kontrol).

---

#### Faz 31 — Finansal Kontrol Merkezi + Anomali/Fraud Tespiti + Bildirim/Eskalasyon

**Bağımlılık:** Faz 19-30 (neredeyse tamamı) — bu, tüm entity'ler arası bir sentez katmanı.
**Teslimatlar:**
- Finansal invariant motoru: duplicate fatura/ödeme/banka-işlemi, ödenen>fatura, tahsilat>alacak, faturasız-ödeme, eşleşmemiş-banka-işlemi, bilinmeyen-counterparty/IBAN, yeni/değişmiş-IBAN, büyük/olağandışı-ödeme, kapalı-dönem-mutasyonu (Faz 24B'nin dönem-kilidini gerektirir), eksik-doküman kontrolleri — PostgreSQL CHECK + SQL view + TS kural fonksiyonu olarak, mevcut `db/constraints-verify.ts`+`phaseN-verify` altyapısı üzerinden.
- PASS/WARNING/CRITICAL kontrol dashboard'u (`data/` veya `system/` altında doğal ev).
- Anomali tespiti (tutar/frekans/counterparty/IBAN, duplicate/split-payment, round-number, olağandışı-saat, yeni-alıcı, tarihsel-baseline karşılaştırması, approval-bypass [Faz 24A'nın Approval entity'sini gerektirir]) — yalnız TS/SQL'de deterministik istatistiksel kurallar. **Pekiştirme:** LLM kontrol/anomali sonucu üretiminin dışında kalır — `ai/engine.ts`'in mevcut sınırı zaten bunu sağlıyor.
- Anomali skorlama + inceleme workflow'u + false-positive geri bildirimi, yine `action_items` deseniyle.
- §30 bildirim genişletmesi: alert acknowledge/resolve/snooze, eskalasyon kuralları — bu fazın ürettiği uyarılar buradan yönlenir.

**Gate:** `phase31:verify`; her yeni CHECK constraint kendi `db:constraints:verify` girdisini alır (mevcut script'i genişletir, değiştirmez).

---

#### Faz 32 — CFO Sabah Brifingi + Yönetim Kokpiti + Finansal Takvim

**Bağımlılık:** Faz 26, 30, 31.
**Teslimatlar:**
- `cockpit.ts`'i (zaten `overview/`'u besliyor) net-borç, AR/AP, EBITDA, işletme sermayesi, DSO/DPO, kapasite kullanımı, bütçe/forecast varyansı, borç vadesi, FX exposure, konsantrasyon widget'larıyla genişlet.
- CFO Sabah Brifingi: deterministik SQL/TS özet (güncel nakit, bugünkü ödeme/tahsilat, gecikmiş, kritik kalemler, Faz 31'in yeni anomalileri, 7/30 günlük min. nakit, likidite açığı, bugünün aksiyonları) — `reports/engine.ts` + mevcut Telegram + Faz 25'in yeni e-posta kanalını tekrar kullanır.
- Birleşik finansal-takvim read-model view'ı, mevcut vade/taksit/promise-to-pay tarihlerini toplar — var olan için yeni kaynak-of-truth tablosu yok; maaş/SGK/vergi/kira/sigorta/CapEx tarihlerinin yeni hafif tekrar-eden-yükümlülük kaydı mı gerektirdiği, yoksa mevcut payments modülüne mi oturduğu faz başlarken netleştirilir.

**Gate:** `phase32:verify`; brifing rakamlarının alttaki dashboard rakamlarıyla tutarlılık çaprazlaması — özet ile detay arasında sapma yasak.

---

#### Faz 33 — Performans, Ölçeklenebilirlik ve Arka Plan İşleri

**Bağımlılık:** Faz 20 (import hacmi), Faz 34/35 (export hacmi).
**Teslimatlar:**
- Büyük Excel/CSV importları (özellikle Faz 20'nin banka ekstreleri) için job queue + retry policy + dead-letter queue.
- Faz 22-32'de eklenen en ağır read-model sorguları için materialized view/aggregate table.
- Query optimizasyonu/index audit/N+1 audit/slow-query logging.
- Rapor-üretim kuyruğu, büyük-export kuyruğu, import-progress takibi.

**Gate:** `phase33:verify`; en yavaş N sorgu için önce/sonra query-plan karşılaştırması.

---

#### Faz 34 — Agresif Analiz + Görselleştirme Motoru (ilk dilim)

**Bağımlılık:** Faz 30, 31, 32.
**Amaç:** Wishlist'in ~150 satırlık kapsamlı listesinden, "en küçük güvenli dilim" ilkesiyle bilinçli olarak daraltılmış gerçek, genişletilebilir bir kayıt (registry) altyapısı.

**Teslimatlar:**
- Metric/dimension/calculation registry — mevcut `facts/engine.ts`+`analytics/models.ts` desenini bağımlılık grafiği + reproducibility metadata'sıyla (input snapshot/hesap versiyonu/zaman damgası/kaynak lineage — Faz 2'nin olgun lineage desenini tekrar kullanarak) gerçek bir registry'ye dönüştürür.
- Rolling 7/30/90/365 gün + MoM/QoQ/YoY analiz fonksiyonları (mevcut `analytics/chart.ts`'teki dönem-filtrelemeyi genişletir).
- İlk 5-8 adlandırılmış analiz tipi (§3 açık soru #3 uyarınca, tam ~40 değil) — varyans decomposition, konsantrasyon/Pareto, DSO/DPO/DIO decomposition en güçlü ilk adaylar (mevcut veriye göre).
- Chart registry: `ChartModel`/`analytics-chart.tsx`'i birkaç yeni tiple genişlet — waterfall, heatmap, treemap (wishlist'in en çok vurguladığı tipler) — tam ~40 tip listesi değil. PNG/SVG/PDF/XLSX export.
- **Python YOK (Çözülen Karar #2)** — tüm istatistiksel hesaplama TS'de.

**Gate:** `phase34:verify`; bu fazdan itibaren standing bir "LLM-bağımsızlığı" kontrolü (analytics/chart hesaplama modülü `src/lib/ai`'yi import etmiyor) tek seferlik değil kalıcı bir repo-geneli kontrole dönüşür.

---

#### Faz 35 — Evrensel Arama + Doküman Merkezi

**Bağımlılık:** Faz 20-31.
**Teslimatlar:**
- `documents`+`attachments` (checksum, versiyonlama, etiketleme) — **depolama arka ucu §3 açık soru #7, faz başlarken çözülecek; bugünkü yerel-Docker-Postgres-yalnız yığında obje depolama yok.**
- Doküman-işlem bağlantısı, Faz 2'nin source-lineage FK desenini tekrar kullanarak.
- Müşteri/tedarikçi/fatura/ödeme/tahsilat/banka-işlemi/çek/kredi/doküman/audit-log genel arama; ⌘K komut paleti.
- Doğal-dil arama, `ai/engine.ts`'in mevcut sınırıyla birebir aynı şekilde scoped: LLM yalnız niyet/entity/tarih/filtre çıkarımı yapar, deterministik bir query builder çalıştırır, LLM'den sıfır doğrudan SQL — Faz 18'in Zod sınırı + mevcut `mutationIntent()`-tarzı korumayı tekrar kullanır, yeni bir LLM mimarisi gerekmez.

**Gate:** `phase35:verify`; arama sonuçlarının Faz 24B'nin RLS/rol kapsamını asla atlamadığını doğrulayan kontrol.

---

#### Faz 36 — UX Standardizasyon Süpürmesi

**Bağımlılık:** Faz 19-35 (çoğu, gezinecek modül olarak).
**Teslimatlar:**
- Sidebar bilgi mimarisi yeniden düzenlemesi, rol-bazlı navigasyon (Faz 24B'nin backend'ini UI'ye bağlar), global filtre sistemi (tarih aralığı/para birimi/entity/cost-center/proje/müşteri-tedarikçi), saved views.
- Tablo pagination/filtre/sort standardı, toplu işlemler, CSV/XLSX/PDF export standardı, klavye kısayolları.
- Loading/error/empty-state standardizasyonu, erişilebilirlik denetimi, performans denetimi.

**Gate:** `phase36:verify`; örneklenen bir çapraz-modül UI tutarlılık kontrol listesi (her sayfa değil, örneklem).

---

#### Faz 37 — Entegrasyon Merkezi (Integration Hub)

**Bağımlılık:** Faz 20-36'nın büyük çoğunluğu (senkronize edilecek gerçek iç veri gerekiyor).
**Amaç (Çözülen Karar #4 ile netleşti):** Banka API'si, e-Fatura/e-Arşiv, bir muhasebe yazılımı, TCMB kur entegrasyonu — dördü de gerçek kapsam.

**Teslimatlar:**
- **Banka API'si:** Faz 20'nin ekstre-import akışının canlı/otomatik uzantısı.
- **e-Fatura/e-Arşiv:** Faz 21'in Invoice entity'sine bağlı, resmi e-fatura sistemine entegrasyon.
- **TCMB kur entegrasyonu:** Faz 27'nin manuel/anlık-kayıt sürümünün canlı/otomatik uzantısı.
- **Muhasebe yazılımı** (Paraşüt/Logo/Mikro/Luca — **hangisi olduğu faz başlarken netleştirilecek**, tek bir vendor'a odaklanılacak, dördü birden değil).
- Excel/CSV import-export (bugün zaten büyük ölçüde kapsanıyor — genişletilir, yeniden kurulmaz).
- Programlı senkronizasyon + durum + retry + dead-letter kuyruğu (Faz 33'ün job-queue altyapısını tekrar kullanır).
- Entegrasyon audit trail'i (Faz 18'in `audit()`'ini tekrar kullanır).

**Gate:** `phase37:verify`; dört entegrasyon ayrı ayrı, birbirinden bağımsız teslim edilebilir olacak şekilde gate'lenir — biri diğerini bloklamaz.

---

#### Faz 38 — Konuşma Tabanlı Finans Asistanı Genişletme (son faz, her şeyin ince arayüzü)

**Bağımlılık:** Faz 35 (query builder); Faz 37'den faydalanır ama zorunlu bağımlı değil.
**Amaç:** Zaten büyük ölçüde kurulmuş `ai/engine.ts`/`facts/engine.ts` sınırını (bkz. 1a), zaten çalışan mimariyi yeniden kurmadan tam konuşmalı asistana genişletmek.

**Teslimatlar:**
- Faz 34'ün artık çok daha büyük fact/metric registry'si üzerinde Türkçe doğal-dil soru-cevap.
- Takip-sorusu bağlamı, konuşma geçmişi, rol-bazlı veri görünürlüğü (Faz 24B'ye bağlı derinlik).
- Drill-down bağlantıları, chat→dashboard/rapor görünümü çağırma.
- Her yanıt için tam kaynak/sorgu izlenebilirliği (Faz 2'nin lineage deseni + Faz 34'ün reproducibility metadata'sını tekrar kullanır).
- LLM hatasında deterministik-yalnız-fact fallback — zaten mevcut mimari, bozulmamalı.
- **Sesli soru sorma §3 açık soru #5 — flag'lenir, sessizce kurulmaz.**

**Gate:** `phase38:verify`; prompt-injection/tool-abuse test paketi; genişlemiş fact yüzeyine karşı mevcut `mutationIntent()` koruması ve `AI_FORCE_DETERMINISTIC` kapatma anahtarının hâlâ çalıştığının yeniden teyidi.

---

### 5. Kapsam kontrolü (34 bölümün hiçbiri sessizce düşürülmedi)

§1→Faz15/16/17/18 · §2→Faz19/20/21/22/24A/24B/27/28/31/35 · §3→Faz20/22 · §4→Faz19/22/23 · §5→Faz21 · §6/§7→Faz23 · §8→Faz25 · §9→Faz26 · §10/§11→Faz28 · §12→Faz29 · §13/§14→Faz27 · §15/§16/§17→Faz30 · §18/§19→Faz31 · §20/§21→Faz24A/24B · §22→Faz35 · §23→zaten-yapılmış grubu, Faz31/35/38'de genişler · §24→Faz35 · §25/§26/§27→Faz32 · §28→Faz38 · §29→Faz37 (tam kapsam, Çözülen Karar #4) · §30→Faz25/31 · §31→Faz36 · §32→Faz33 · §33→Faz16 · §34/35 (analiz+görsel)→Faz34.

---

### Doğrulama (uçtan uca nasıl test edilir)

Bu bir dokümantasyon değişikliği — kod değişikliği yok, bu yüzden doğrulama iki katmanlı:

1. **Belge tutarlılığı:** `implementation.md`'ye eklenen v4 bölümü, mevcut v3'ün 14 fazlık biçimini (amaç/teslimat/gate) birebir taklit ediyor mu; `## 16. Commit ve Gate Kurali`'ndeki pnpm zinciri `phase15:verify`...`phase38:verify` ile genişletiliyor mu (yerine geçmiyor mu) — elle gözden geçirme.
2. **Faz 15'in aciliyeti ayrıca doğrulanır:** plan onaylandıktan hemen sonra, GitHub repo görünürlüğü GERÇEKTEN kontrol edilip private yapılmalı — bu, planın geri kalanının uygulanmasını beklemeden yapılacak tek adım.
3. **Her fazın kendi gate'i o faz fiilen uygulanmaya başladığında çalışır** — bu roadmap dokümanının kendisi hiçbir `pnpm` script'i çalıştırmaz; CLAUDE.md'nin "en küçük güvenli dilimi belirle → uygula → doğrula → dokümanı güncelle → o fazdan sonra dur" akışı Faz 15'ten başlayarak, bu belge onaylandıktan sonra, HER FAZ İÇİN AYRI AYRI ve sırayla işletilir — plan onayı, 24 fazın hepsinin tek seferde uygulanacağı anlamına gelmez, yalnız yol haritasının kabul edildiği anlamına gelir.

---

## 18. Legacy v2 Plan

Asagidaki v2 plan, domain kararlarini ve tarihsel baglami korumak icin saklanmistir.

# MAS Nakit Radar — Implementation Plan v2

> Product type: private, single-company, single-operator internal finance/operations SaaS.  
> Product name: **MAS Nakit Radar**.  
> Updated scope: payment radar + cash-flow forecast + check maturity tracking + loan/interest tracking + production capacity/cost analytics.  
> Non-goal: public SaaS, multi-tenant accounting system, subscription product, ERP clone, bank/e-invoice automation-first project, public landing page, pricing page, onboarding flow, marketplace, or AI accountant.

---

## 0. Executive Decision — What Changed After the New Data

The first implementation plan treated the product mainly as a **payment calendar / payment radar**. The new workbook inspection data expands the real domain. The app should now be designed as a **private MAS finance and operations control panel** with four major analytical pillars:

1. **Payment radar** — recurring due-day payments, overdue items, missing amounts, critical days, reminders.
2. **Cash-flow radar** — monthly projected income, expenses, devir/kasa, cumulative deficit/surplus, bank/card balances from May 2026 to March 2029.
3. **Financing radar** — loans, interest, BSMV/KKDF, installments, checks, maturity concentration, bank/provider exposure.
4. **Production economics radar** — capacity, machine time, normal vs overtime/mesaili cost model, TL/minute break-even, part-level profitability, machine ROI.

The product should **not** become a generic ERP. It should remain a private MAS tool. But the data model must now be broader than `payments` and `payment_instances`.

### Scope impact

| Area | Original plan | v2 change |
|---|---|---|
| Payment tracking | Core | Still core, first vertical slice |
| Cash-flow months | Light monthly summary | Now first-class model: `cashflow_months`, `cashflow_lines`, `cashflow_snapshots` |
| Checks | Generic payment instance | Now first-class model: `checks`, `check_events`, maturity calendar |
| Loans | Generic recurring payment | Now first-class model: `loans`, `loan_installments`, finance-cost analytics |
| Capacity/cost | Out of scope | Add as analytics module, not v1 blocking workflow |
| Machine ROI/tax | Out of scope | Add as strategic analytics module after payment/cash-flow is stable |
| AI | Report commentary | Still commentary only; never source of truth |

### Build priority remains strict

Do **not** start with the shiny analytics. Start with source preservation and the payment/cash-flow backbone.

Correct order:

1. Raw workbook preservation and mapping.
2. Payment calendar/radar.
3. Monthly cash-flow projection.
4. Checks and loan modules.
5. Risk engine and reports.
6. Capacity/cost analytics.
7. Scenario engine.

---

## 1. Source File Reality and Data Evidence

### 1.1 Current uploaded binary workbook status

The currently mounted workbook path is:

```txt
/mnt/data/mesaili_nakit_akış_tek_vardiya_TEMİZ-4.xlsx
```

Technical check in the active environment still shows this file cannot be parsed as a valid Excel workbook because it does not expose a valid XLSX/ZIP signature. Therefore the app must still be designed to support a real workbook upload/import later.

### 1.2 New user-provided inspection outputs

The new text files contain pandas inspection outputs from a workbook named:

```txt
mesaili_nakit akış_tek vardiya.xlsx
```

These outputs should be treated as **data-map evidence** for implementation planning. They show the workbook contains:

- financing and loan worksheets
- capacity and production worksheets
- machine/ROI/tax worksheet
- payment-day matrix worksheet
- checks worksheet
- normal and overtime cost models
- monthly cash-flow sheets from **May 2026 through March 2029**

### 1.3 Sheet families discovered

The workbook contains these major sheet groups:

#### A. Finance / loan / payment tracking

- `faiz hesaplama`
- `ödeme tablosu`
- `ÇEKLER`

#### B. Operations / capacity / cost

- `kapasite`
- `tablo`
- `maliyet-mastechnicmesaili`
- `maliyet-mastechnic`

#### C. Monthly forecast sheets

- `mayıs 2026` through `mart 2029`
- mixed casing is present, for example `ARALIK 2026`, `OCAK 2027`, `ŞUBAT 2028`, `EKİM 2028`, `KASIM 2028`, `ARALIK 2028`

### 1.4 Crucial import rule

Sheet names, row positions, headers, casing, merged-table style, and sign conventions are inconsistent. The importer must never assume clean rectangular tables. The app must preserve raw cells first, then map detected regions into typed domain tables.

---

## 2. Product Definition v2

Build:

> **MAS Nakit Radar** — MAS’a özel ödeme, nakit akış, finansman, çek, maliyet ve kapasite kontrol paneli.

The app must answer these operational questions:

### Payment questions

- Bugün hangi ödemeler var?
- Yarın hangi ödemeler var?
- Önümüzdeki 7 gün hangi ödemeler var?
- Hangi ödemelerin tutarı eksik?
- Hangi ödemeler gecikti?
- Aynı güne sıkışan ödeme kümeleri nerede?
- 50.000 TL / 100.000 TL üstü kritik ödemeler hangileri?

### Cash-flow questions

- Bu ay gelir, gider, fark aylık ve kasa/devir durumu nedir?
- Önümüzdeki 3, 6, 12, 24, 36 ayda kasa ne yöne gidiyor?
- İlk eksi kasa hangi ay başlıyor?
- Kümülatif nakit açığı hangi hızla büyüyor?
- Hangi aylar finansman müdahalesi gerektiriyor?
- Cari müşteri gelirlerinin hangi firmalara bağımlılığı var?

### Financing/check questions

- Hangi çekler hangi tarihte vadesine geliyor?
- Çekler hangi bankalarda yoğunlaşıyor?
- Aynı ay/hafta çek ve ödeme yükü çakışıyor mu?
- Kredi toplam geri ödeme, finansman maliyeti ve taksit yükü nedir?
- Banka/kredi kartı/çek exposure dağılımı nedir?

### Production/cost questions

- Normal tek vardiya ve mesaili modelde başabaş TL/dk nedir?
- Mesai kapasiteyi artırıyor mu, yoksa verim düşüşü maliyeti yiyor mu?
- Parça bazında torna/freze süreleri ve maliyetler ne gösteriyor?
- Hangi parçalar kârlı/kârsız görünüyor?
- Hangi tezgah daha yüksek ROI üretiyor?

---

## 3. Hard Scope Boundaries

### Never build in v1/v2 unless explicitly approved

- Multi-tenant organization model
- External customer accounts
- Pricing, subscription, billing, trial, Stripe, iyzico
- Public marketing landing page
- Public SaaS onboarding
- Marketplace
- Full ERP
- Full double-entry accounting ledger
- Payroll module
- Stock/inventory module
- E-invoice integration
- Live bank integration
- OCR-first automation
- AI chatbot as the primary interface
- AI-powered mutation of financial records
- Mobile native app
- Complex RBAC beyond one admin/operator role

### Must build

- Secure login
- Single-company settings
- Raw workbook import/audit layer
- Payment template and payment instance model
- Monthly cash-flow model
- Check ledger
- Loan/financing model
- Data-quality and mapping review screens
- Risk engine
- Dashboard and reporting
- Telegram reminder engine
- Audit log
- Deterministic calculations with tests

---

## 4. Recommended Stack

### Application

- Next.js App Router
- TypeScript strict mode
- Tailwind CSS
- shadcn/ui
- TanStack Table
- TanStack Query where server-state handling is needed
- React Hook Form
- Zod validation
- Recharts
- date-fns
- Lucide icons

### Backend / database

- Supabase
- PostgreSQL
- Supabase Auth
- Supabase Storage for source workbooks and receipts/dekont/fatura attachments
- Supabase migrations
- SQL views for dashboard summaries
- SQL functions for instance generation, risk flags, and monthly rollups
- RLS enabled even for single-company mode

### Automation

- Supabase Edge Functions, Vercel Route Handlers, or server-only scheduled scripts
- Supabase scheduled functions / pg_cron / Vercel Cron
- Telegram Bot API for reminders
- Optional Resend/SMTP for email reports

### AI layer

AI is a commentary layer only.

AI may:

- explain weekly/monthly risk
- write executive summaries
- highlight data anomalies already detected deterministically
- generate “what to check next” action lists

AI must not:

- calculate source-of-truth amounts
- mark anything paid
- alter due dates
- delete or merge records
- infer final truth from ambiguous Excel rows without user review

---

## 5. Repository / Package Map

Use these as references/dependencies. Do not blindly clone generic SaaS starters because most include billing, organizations, onboarding, or public marketing baggage.

| Area | Repo / Package | Use |
|---|---|---|
| Framework | https://github.com/vercel/next.js | App Router, server components, route handlers |
| Backend | https://github.com/supabase/supabase | Auth, Postgres, storage, edge functions |
| Supabase examples | https://github.com/supabase-community/supabase-by-example | Reference patterns only |
| UI | https://github.com/shadcn-ui/ui | Dashboard components, forms, dialogs, tables |
| Charts | https://github.com/recharts/recharts | Cash-flow, payment load, capacity charts |
| Tables | https://github.com/TanStack/table | Payment ledger, check ledger, import review, cost tables |
| Server state | https://github.com/TanStack/query | Optional client caching/mutations |
| Forms | https://github.com/react-hook-form/react-hook-form | Create/edit forms |
| Validation | https://github.com/colinhacks/zod | Runtime validation and DTO schemas |
| Excel parsing | https://github.com/SheetJS/sheetjs | Workbook parsing and raw sheet extraction |
| Alternative Excel parsing | https://github.com/exceljs/exceljs | Styles/formulas/worksheet metadata when needed |
| ORM optional | https://github.com/drizzle-team/drizzle-orm | Optional typed SQL layer; avoid if it slows MVP |
| Email | https://github.com/resend/resend-node | Optional email summaries |
| Email templates | https://github.com/resend/react-email | Optional structured email reports |
| Telegram | https://github.com/yagop/node-telegram-bot-api | Telegram reminders |
| Starter reference | https://github.com/t3-oss/create-t3-app | TypeScript discipline only; do not import SaaS baggage |
| React architecture | https://github.com/alan2207/bulletproof-react | Folder structure inspiration only |

### Install command set

```bash
pnpm create next-app mas-nakit-radar --ts --tailwind --eslint --app --src-dir
cd mas-nakit-radar
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button card table badge calendar dialog dropdown-menu form input label select textarea tabs sheet separator alert switch skeleton toast command popover
pnpm add @supabase/supabase-js @supabase/ssr zod react-hook-form @hookform/resolvers @tanstack/react-table @tanstack/react-query recharts date-fns lucide-react
pnpm add xlsx exceljs node-telegram-bot-api resend @react-email/components
pnpm add -D vitest @testing-library/react @testing-library/jest-dom playwright eslint-config-prettier prettier tsx
```

---

## 6. Claude Code Setup

Create and maintain:

```txt
CLAUDE.md
implementation.md
docs/
  data-map.md
  database-schema.md
  todo.md
  risk-register.md
  repo-map.md
  import-mapping.md
  calculation-rules.md
.claude/
  skills/
    mas-excel-data-auditor/
      SKILL.md
    mas-db-architect/
      SKILL.md
    mas-payment-risk-engine/
      SKILL.md
    mas-dashboard-ux/
      SKILL.md
    mas-reminder-engine/
      SKILL.md
    mas-report-writer/
      SKILL.md
    mas-qa-gate/
      SKILL.md
    mas-implementation-slicer/
      SKILL.md
    mas-cashflow-forecaster/
      SKILL.md
    mas-loan-check-analyst/
      SKILL.md
    mas-cost-capacity-analyst/
      SKILL.md
```

### Claude operating rule

Claude must never jump straight into broad coding.

Every phase must follow:

1. inspect current files and docs
2. update data map and assumptions
3. write migration/types/tests first where applicable
4. implement the smallest vertical slice
5. run typecheck/lint/tests
6. document changes
7. stop for review after phase completion

---

## 7. Domain Model Overview

The app must have three data layers:

1. **Raw source layer** — every workbook/sheet/cell/row preserved.
2. **Mapped staging layer** — candidate entities extracted from messy Excel regions, awaiting review.
3. **Normalized domain layer** — clean entities used by dashboard, reminders, reports, and analytics.

### Why three layers?

The workbook is not a clean accounting export. It is an operational planning workbook with multiple embedded mini-tables. Some headers are in rows, some in columns, some are numeric values, and some sheets mix operational and financial data. A direct import into final tables would create silent errors.

---

## 8. Raw Source and Import Tables

### `source_workbooks`

```sql
create table public.source_workbooks (
  id uuid primary key default gen_random_uuid(),
  original_filename text not null,
  storage_path text,
  file_sha256 text,
  imported_by uuid references auth.users(id),
  imported_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','parsed','mapped','failed')),
  parse_error text,
  notes text
);
```

### `source_sheets`

```sql
create table public.source_sheets (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_name text not null,
  sheet_name_normalized text,
  sheet_index int not null,
  used_range text,
  row_count int,
  column_count int,
  detected_type text check (detected_type in (
    'loan_calculation','capacity','machine_roi','payment_day_matrix','checks',
    'cost_model_normal','cost_model_overtime','monthly_cashflow','unknown'
  )),
  parse_confidence text not null default 'unknown' check (parse_confidence in ('high','medium','low','unknown')),
  created_at timestamptz not null default now(),
  unique(workbook_id, sheet_index)
);
```

### `source_cells`

```sql
create table public.source_cells (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_id uuid not null references public.source_sheets(id) on delete cascade,
  row_index int not null,
  column_index int not null,
  address text not null,
  raw_value text,
  normalized_value text,
  inferred_type text,
  formula text,
  style_json jsonb,
  created_at timestamptz not null default now(),
  unique(sheet_id, row_index, column_index)
);
```

### `import_rows`

```sql
create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_id uuid not null references public.source_sheets(id) on delete cascade,
  row_index int not null,
  row_json jsonb not null,
  row_hash text,
  detected_entity_type text,
  mapping_status text not null default 'unmapped' check (mapping_status in ('unmapped','mapped','ignored','needs_review')),
  mapped_entity_table text,
  mapped_entity_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  unique(sheet_id, row_index)
);
```

### `mapping_reviews`

```sql
create table public.mapping_reviews (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_id uuid references public.source_sheets(id) on delete cascade,
  import_row_id uuid references public.import_rows(id) on delete cascade,
  issue_type text not null,
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  message text not null,
  suggested_mapping jsonb,
  status text not null default 'open' check (status in ('open','accepted','rejected','resolved')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
```

---

## 9. Shared Reference Tables

### `parties`

Use `parties` for customers, vendors, persons, banks, providers, and internal owners. Avoid splitting too early.

```sql
create table public.parties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null,
  party_type text not null default 'unknown' check (party_type in (
    'company','person','bank','provider','customer','vendor','internal_owner','unknown'
  )),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(normalized_name, party_type)
);
```

Seed examples from the workbook evidence:

- Internal/company: `MAS`
- Customers/cari gelir: `Akon`, `Metsan`, `Hpt`, `Egemet`
- Vendors/cari ödemeler: `Elit`, `Çağdaş`, `Akbaş`
- Banks/providers: `Halk`, `Deniz`, `Vinov`, `Telekom`, `Süperbox`, `Pronet`
- Persons/owners: `Armağan`, `Esma`, plus manually reviewed names

### `categories`

```sql
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  domain text not null default 'payment' check (domain in ('payment','cashflow','check','loan','cost','capacity','tax','other')),
  sort_order int not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
```

Seed examples:

- `Kredi`
- `Kredi Kartı`
- `Çek`
- `Kira`
- `Telefon`
- `İnternet`
- `Elektrik/Su`
- `Alarm/Güvenlik`
- `Cari Ödeme`
- `Cari Gelir`
- `Banka/Hesap`
- `Yemek`
- `Yol`
- `Personel`
- `Sigorta`
- `Vergi`
- `Diğer`
- `Bilinmiyor`

### `cash_accounts`

```sql
create table public.cash_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  provider_party_id uuid references public.parties(id),
  account_type text not null default 'unknown' check (account_type in ('cash','bank_account','credit_card','loan','check_account','other','unknown')),
  currency text not null default 'TRY',
  opening_balance numeric(14,2),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);
```

Seed examples:

- `Kasa`
- `HESAP Halk`
- `Halk Business`
- `Halk KK - Paraf`
- `Deniz`
- `Vinov`

---

## 10. Payment Radar Model

### `payments`

```sql
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  category_id uuid references public.categories(id),
  provider_party_id uuid references public.parties(id),
  owner_party_id uuid references public.parties(id),
  cash_account_id uuid references public.cash_accounts(id),

  recurrence_type text not null default 'monthly' check (recurrence_type in ('one_off','monthly','weekly','yearly','irregular')),
  due_day int check (due_day between 1 and 31),
  due_date date,

  default_amount numeric(14,2),
  currency text not null default 'TRY',
  amount_confidence text not null default 'known' check (amount_confidence in ('known','unknown','estimated','variable')),

  direction text not null default 'outflow' check (direction in ('inflow','outflow','transfer','unknown')),
  priority text not null default 'normal' check (priority in ('low','normal','high','critical')),
  status text not null default 'active' check (status in ('active','paused','archived')),

  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),
  source_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payment_due_rule check (
    (recurrence_type = 'monthly' and due_day is not null)
    or (recurrence_type <> 'monthly')
  )
);
```

### `payment_instances`

```sql
create table public.payment_instances (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references public.payments(id) on delete set null,
  instance_month date not null,
  due_date date not null,
  due_day int generated always as (extract(day from due_date)::int) stored,

  amount numeric(14,2),
  currency text not null default 'TRY',
  amount_status text not null default 'known' check (amount_status in ('known','missing','estimated','variable')),
  direction text not null default 'outflow' check (direction in ('inflow','outflow','transfer','unknown')),

  status text not null default 'unpaid' check (status in ('planned','unpaid','partial','paid','late','cancelled','unknown')),
  paid_amount numeric(14,2),
  paid_at timestamptz,
  paid_from_account_id uuid references public.cash_accounts(id),

  risk_level text not null default 'none' check (risk_level in ('none','low','medium','high','critical')),
  risk_reasons text[] not null default '{}',

  note text,
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint paid_requires_paid_at check (
    status <> 'paid' or paid_at is not null
  )
);
```

---

## 11. Monthly Cash-Flow Model

The monthly sheets are first-class. They should not be forced into payment instances only.

### `cashflow_months`

```sql
create table public.cashflow_months (
  id uuid primary key default gen_random_uuid(),
  month_start date not null unique,
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),

  opening_balance numeric(14,2), -- devir
  projected_income numeric(14,2), -- gelir
  projected_expense numeric(14,2), -- gider
  monthly_delta numeric(14,2), -- fark aylık
  closing_balance numeric(14,2), -- kasa
  confidence text not null default 'source_imported' check (confidence in ('source_imported','calculated','reviewed','estimated')),

  status text not null default 'draft' check (status in ('draft','review_needed','reviewed','locked')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `cashflow_lines`

```sql
create table public.cashflow_lines (
  id uuid primary key default gen_random_uuid(),
  cashflow_month_id uuid not null references public.cashflow_months(id) on delete cascade,
  source_row_id uuid references public.import_rows(id),

  line_type text not null check (line_type in (
    'customer_income','vendor_payment','bank_balance','credit_card','loan_payment','check_payment',
    'operational_cost','tax','transfer','adjustment','unknown'
  )),
  direction text not null default 'unknown' check (direction in ('inflow','outflow','balance','transfer','unknown')),
  party_id uuid references public.parties(id),
  account_id uuid references public.cash_accounts(id),
  label text not null,
  amount numeric(14,2),
  amount_status text not null default 'known' check (amount_status in ('known','missing','estimated','variable')),
  date_value date,
  notes text,
  created_at timestamptz not null default now()
);
```

### `cashflow_snapshots`

```sql
create table public.cashflow_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null default current_date,
  horizon_months int not null,
  total_projected_income numeric(14,2),
  total_projected_expense numeric(14,2),
  final_projected_balance numeric(14,2),
  first_negative_month date,
  worst_month date,
  worst_balance numeric(14,2),
  created_at timestamptz not null default now()
);
```

### Required cash-flow analytics

- month-by-month opening/devir → income → expense → delta → closing/kasa
- cumulative cash burn
- first negative month
- worst projected month
- 3/6/12/24/36-month forecast cards
- income concentration by customer
- expense concentration by vendor/category
- bank/card exposure trend
- cash rescue threshold alerts

---

## 12. Checks / Çekler Model

The `ÇEKLER` sheet uses dated rows, parties, banks, and negative signed amounts. Do not treat all negative numbers as anomalies here. In the checks module, sign must be interpreted as direction.

### `checks`

```sql
create table public.checks (
  id uuid primary key default gen_random_uuid(),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),

  maturity_date date not null,
  serial_no text,
  payee_party_id uuid references public.parties(id), -- kime
  payer_party_id uuid references public.parties(id), -- kimden
  bank_party_id uuid references public.parties(id),
  account_id uuid references public.cash_accounts(id),

  amount numeric(14,2),
  signed_amount numeric(14,2),
  direction text not null default 'outflow' check (direction in ('inflow','outflow','unknown')),
  status text not null default 'planned' check (status in ('planned','cleared','bounced','cancelled','unknown')),

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `check_events`

```sql
create table public.check_events (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references public.checks(id) on delete cascade,
  event_type text not null check (event_type in ('created','reminded','cleared','bounced','cancelled','note')),
  event_at timestamptz not null default now(),
  event_note text,
  created_by uuid references auth.users(id)
);
```

### Required check analytics

- maturity calendar
- bank-by-bank check exposure
- payee/payer concentration
- weekly/monthly check load
- overlap with payment instances
- check-heavy month warning
- duplicate-looking checks review

---

## 13. Loan / Financing Model

The `faiz hesaplama` sheet includes credit principal, maturity, interest, taxes, installment, total payment, and difference/finance cost. These need dedicated tables.

### `loans`

```sql
create table public.loans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  lender_party_id uuid references public.parties(id),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),

  principal numeric(14,2) not null,
  term_months int,
  installment_count int,
  first_payment_date date,
  simple_interest_rate numeric(8,4),
  applied_interest_rate numeric(8,4),
  monthly_cost_rate numeric(8,4),
  annual_cost_rate numeric(8,4),
  bsmv_rate numeric(8,4),
  kkdf_rate numeric(8,4),
  installment_amount numeric(14,2),
  total_payment numeric(14,2),
  total_finance_cost numeric(14,2),

  status text not null default 'active' check (status in ('active','closed','planned','unknown')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `loan_installments`

```sql
create table public.loan_installments (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete cascade,
  installment_no int,
  due_date date not null,
  amount numeric(14,2) not null,
  principal_component numeric(14,2),
  interest_component numeric(14,2),
  tax_component numeric(14,2),
  status text not null default 'planned' check (status in ('planned','unpaid','partial','paid','late','cancelled')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique(loan_id, installment_no)
);
```

### Required loan analytics

- total principal
- total repayment
- total finance cost
- monthly installment load
- remaining installments
- paid/unpaid schedule
- debt service pressure by month
- overlap with cash-flow deficit months

---

## 14. Production Capacity and Cost Model

This module is important but should not block the payment radar MVP. It should be implemented after the finance backbone.

### `machine_assets`

```sql
create table public.machine_assets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  machine_type text check (machine_type in ('torna','freze','other','unknown')),
  purchase_cost numeric(14,2),
  notes text,
  created_at timestamptz not null default now()
);
```

Seed candidates: `Awea`, `Arion`, `Sister`, `Doosan`.

### `production_parts`

```sql
create table public.production_parts (
  id uuid primary key default gen_random_uuid(),
  part_code text,
  part_name text not null,
  quantity int,
  torna_minutes numeric(14,4),
  freze_minutes numeric(14,4),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),
  created_at timestamptz not null default now()
);
```

### `capacity_models`

```sql
create table public.capacity_models (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scenario_type text not null check (scenario_type in ('normal','overtime','custom')),
  monthly_hours numeric(10,2),
  monthly_minutes numeric(14,2),
  work_days_per_month numeric(10,2),
  efficiency_rate numeric(8,4),
  staff_count numeric(10,2),
  apprentice_count numeric(10,2),
  notes text,
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  created_at timestamptz not null default now()
);
```

### `cost_models`

```sql
create table public.cost_models (
  id uuid primary key default gen_random_uuid(),
  capacity_model_id uuid references public.capacity_models(id),
  model_name text not null,
  model_month date,
  food_daily_cost numeric(14,2),
  transport_staff_daily_cost numeric(14,2),
  transport_apprentice_daily_cost numeric(14,2),
  health_insurance_cost numeric(14,2),
  machine_insurance_cost numeric(14,2),
  total_fixed_cost numeric(14,2),
  monthly_allocated_cost numeric(14,2),
  break_even_torna_tl_per_min numeric(14,4),
  break_even_freze_tl_per_min numeric(14,4),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  created_at timestamptz not null default now()
);
```

### `part_profitability_runs`

```sql
create table public.part_profitability_runs (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null references public.production_parts(id) on delete cascade,
  cost_model_id uuid not null references public.cost_models(id) on delete cascade,
  estimated_torna_cost numeric(14,2),
  estimated_freze_cost numeric(14,2),
  estimated_total_cost numeric(14,2),
  estimated_revenue numeric(14,2),
  estimated_margin numeric(14,2),
  margin_rate numeric(8,4),
  created_at timestamptz not null default now()
);
```

### Required production analytics

- normal vs overtime TL/minute comparison
- efficiency sensitivity
- part-level cost/profit estimate
- machine utilization
- capacity equivalent of monthly revenue
- break-even price floor
- low-margin / negative-margin part flags

---

## 15. Machine ROI / Strategic Table Model

The `tablo` sheet appears to compare machine economics, net remaining amounts, costs, taxes, and possibly personal/company allocations. This must be treated as review-needed strategic data, not blindly normalized in MVP.

### `machine_roi_snapshots`

```sql
create table public.machine_roi_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  machine_asset_id uuid references public.machine_assets(id),
  snapshot_year int,
  revenue numeric(14,2),
  cost numeric(14,2),
  remaining numeric(14,2),
  tax numeric(14,2),
  net_after_tax numeric(14,2),
  confidence text not null default 'needs_review' check (confidence in ('needs_review','reviewed','calculated')),
  notes text,
  created_at timestamptz not null default now()
);
```

### Required ROI analytics

- machine-level gross/net outcome
- tax burden
- payback period approximation
- risk: low confidence until reviewed

---

## 16. Risk Engine v2

Risk must be deterministic. AI only explains already-computed risks.

### Payment risks

- Missing amount
- Missing due date/due day
- Overdue unpaid
- Partial paid after due date
- Large payment above `large_payment_threshold_try`, default 50,000 TRY
- Critical payment above `critical_payment_threshold_try`, default 100,000 TRY
- Same-day cluster, default 3+ payments
- Due day 29/30/31 short-month edge case

### Cash-flow risks

- Closing balance below zero
- First negative month
- Three consecutive negative months
- Monthly delta below threshold
- Expense spike month
- Income concentration above threshold
- Vendor/payment concentration above threshold
- Forecast confidence low because source row is ambiguous

### Check risks

- Check maturity in next 7/14/30 days
- Check maturity overlaps with high payment week
- Bank exposure concentration
- Duplicate-looking checks
- Negative signed amount without direction mapping

### Loan risks

- Loan installment overlaps with deficit month
- Financing cost ratio high
- Remaining debt-service load high
- Missing lender/payment schedule

### Production/cost risks

- Break-even TL/minute above quoted or assumed price
- Overtime scenario increases capacity but worsens margin
- Efficiency sensitivity causes margin collapse
- Part with missing operation time
- Machine ROI confidence low

---

## 17. Dashboard v2

### Global dashboard top cards

1. Today due
2. Tomorrow due
3. Next 7 days known outflow
4. Missing amount count
5. Overdue count
6. Current month projected closing balance
7. First negative forecast month
8. Checks due in next 30 days
9. Loan installments this month
10. Highest-risk day/month

### Main dashboard sections

#### A. Payment Radar

- Today/tomorrow/7-day list
- Monthly calendar day grid
- Risk-day heatmap
- Missing-data panel

#### B. Cash-Flow Radar

- Month-by-month devir/gelir/gider/fark/kasa table
- Cash balance line chart
- Monthly income/expense bar chart
- Worst months list
- First negative month banner

#### C. Checks and Financing

- Check maturity table
- Bank exposure chart
- Loan summary cards
- Installment schedule

#### D. Production Economics

- Normal vs overtime model cards
- Break-even TL/min chart
- Part-level profitability table
- Capacity utilization estimate

#### E. Reports

- Daily checklist
- Weekly finance action summary
- Monthly executive summary
- Data-quality report

---

## 18. UX Rules

- Dense but readable.
- Serious internal finance tone.
- No landing-page aesthetic.
- No animated marketing sections.
- Mobile responsive enough for quick checks.
- Unknown amount is always visible, never treated as zero.
- Negative amount is not always an error; context decides whether it is signed direction or anomaly.
- High-risk months and days must be visually dominant.
- Cash deficit must be impossible to miss.
- Every imported row must be traceable back to source sheet/row.

---

## 19. Reports v2

### Daily report

- Due today
- Due tomorrow
- Next 7 days known outflow
- Missing amount list
- Check maturities in next 7 days
- Overdue payments
- Action checklist

### Weekly report

- Payment load this week
- Check load this week
- Loan installments this week/month
- Risk-day clusters
- Missing data
- Bank/provider concentration
- Cash readiness checklist

### Monthly report

- Opening/devir
- Income
- Expense
- Monthly delta
- Closing/kasa
- Top 10 outflows
- Customer concentration
- Vendor concentration
- Checks maturing
- Loan burden
- First/worst forecast risk
- Data quality issues

### Strategic report

- 3/6/12/24/36-month cash runway
- First negative month and deficit growth
- Normal vs mesaili cost comparison
- Part-level margin warnings
- Machine ROI snapshot

---

## 20. Implementation Phases

### Phase 0 — Data-map and project setup

Goal: confirm workbook structure and update docs before coding business logic.

Deliverables:

- `docs/data-map.md`
- `docs/import-mapping.md`
- `docs/calculation-rules.md`
- `docs/risk-register.md`
- confirmed source sheet categories
- source file parser spike using `xlsx` and/or `exceljs`

Verification:

- list all sheets
- classify each sheet as loan/capacity/roi/payment/checks/cost/monthly_cashflow/unknown
- no silent discard
- invalid workbook failure documented

### Phase 1 — Database foundation

Goal: create raw source layer and normalized finance skeleton.

Deliverables:

- Supabase migrations for:
  - source tables
  - parties/categories/accounts
  - payments/payment_instances
  - cashflow_months/cashflow_lines
  - checks
  - loans/loan_installments
  - reminders/reports/audit_logs/settings
- seed data
- RLS policies
- generated database types

Verification:

- migration reset works
- constraints pass
- null amount remains null
- paid requires paid_at
- RLS enabled

### Phase 2 — Import review and mapping UI

Goal: preserve workbook data and map candidates safely.

Deliverables:

- workbook upload screen
- sheet list screen
- raw row/cell viewer
- detected sheet type badges
- mapping review table
- payment-day matrix extraction preview
- monthly cash-flow extraction preview
- check extraction preview

Verification:

- every source row can be traced
- ambiguous rows go to review
- no direct write into final tables without mapped status

### Phase 3 — Payment radar MVP

Goal: operational payment tool usable daily.

Deliverables:

- payment CRUD
- monthly instance generation
- today/tomorrow/next 7 days
- monthly payment calendar
- paid/unpaid marking
- missing data report
- overdue report
- payment risk flags

Verification:

- due-day 31 edge cases tested
- duplicate instance generation prevented
- missing amount visible
- overdue visible

### Phase 4 — Cash-flow radar

Goal: turn monthly sheets into forecast dashboard.

Deliverables:

- monthly cash-flow table
- devir/gelir/gider/fark/kasa cards
- cash balance trend
- first negative month detection
- worst month detection
- customer/vendor concentration

Verification:

- monthly rollups match imported values
- closing balance continuity checked
- negative cash months flagged

### Phase 5 — Checks and financing

Goal: track check maturities and loan pressure.

Deliverables:

- checks ledger
- check maturity calendar
- bank exposure chart
- loan summary
- installment schedule
- debt-service monthly load

Verification:

- signed amounts mapped with direction
- negative checks not blindly flagged as errors
- duplicate-looking check rows reviewed
- loan totals reconcile with source values

### Phase 6 — Reminders and reports

Goal: operational alerting and decision summaries.

Deliverables:

- Telegram reminders
- reminder delivery log
- daily/weekly/monthly reports
- AI commentary prompt templates

Verification:

- duplicate reminder prevention
- Istanbul timezone handling
- AI cannot mutate records

### Phase 7 — Production cost/capacity analytics

Goal: add management insight without breaking finance core.

Deliverables:

- capacity model import
- normal vs overtime comparison
- cost model cards
- part-level profitability table
- break-even TL/minute charts

Verification:

- low-confidence data remains marked
- calculations have tests
- outputs are labeled as analytics, not accounting truth

### Phase 8 — Scenario engine

Goal: safe what-if analysis.

Deliverables:

- scenario runs
- adjustable income/expense/capacity assumptions
- no mutation of source-of-truth data
- compare baseline vs scenario

Verification:

- scenarios are read-only overlays
- baseline preserved
- changes auditable

---

## 21. Routes

```txt
/app
  /(auth)
    /login
  /(dashboard)
    /dashboard
    /payments
    /payments/calendar
    /payments/missing-data
    /cashflow
    /cashflow/months
    /cashflow/forecast
    /checks
    /loans
    /capacity
    /reports
    /imports
    /imports/[workbookId]
    /imports/[workbookId]/sheets/[sheetId]
    /settings
```

---

## 22. File Structure

```txt
src/
  app/
  components/
    dashboard/
    payments/
    cashflow/
    checks/
    loans/
    capacity/
    imports/
    reports/
    shared/
  lib/
    supabase/
    validation/
    calculations/
    risk/
    importers/
    reminders/
    reports/
    ai/
  server/
    actions/
    queries/
    jobs/
  types/
supabase/
  migrations/
  seed.sql
docs/
  data-map.md
  database-schema.md
  import-mapping.md
  calculation-rules.md
  risk-register.md
  todo.md
```

---

## 23. Calculation Rules

### Amount semantics

- `null` amount means unknown.
- `0` amount means explicitly zero.
- Negative amount means signed source value; context determines inflow/outflow/anomaly.
- Checks may use negative signed amount for outgoing obligations.
- Cash-flow sheets may use negative values for bank/card balances.

### Monthly continuity

For monthly cash-flow:

```txt
closing_balance = opening_balance + projected_income - projected_expense + adjustments
next_month.opening_balance should equal previous_month.closing_balance unless there is a manual correction.
```

Mismatch must be flagged as `continuity_break`.

### Due-day normalization

- due_day 1-28: direct mapping
- due_day 29-31: if month has fewer days, map to last day of month and flag `short_month_adjustment`

### Risk thresholds defaults

```txt
large_payment_threshold_try = 50_000
critical_payment_threshold_try = 100_000
same_day_cluster_count = 3
negative_cash_threshold_try = 0
high_customer_concentration_ratio = 0.40
high_bank_exposure_ratio = 0.40
```

---

## 24. Tests Required

### Unit tests

- due-date generation
- due-day 31 February mapping
- null vs zero amount
- negative amount semantics
- risk-level assignment
- cash-flow continuity
- first negative month detection
- loan finance cost calculation
- check maturity grouping
- capacity/cost calculation

### Integration tests

- import workbook → source tables
- source rows → mapping review
- payment matrix → payment templates
- monthly cashflow sheet → cashflow_months and lines
- checks sheet → checks ledger
- loan sheet → loan and installments
- reminder job → delivery log

### E2E tests

- login
- view dashboard
- mark payment paid
- view missing data
- upload workbook
- review mapped rows
- view cash-flow forecast
- view checks calendar

---

## 25. Risk Register

| Risk | Severity | Mitigation |
|---|---:|---|
| Workbook format is inconsistent | Critical | Preserve raw cells, map through review layer |
| Binary workbook upload is invalid | High | Import UI must show technical parse failure and allow re-upload |
| Negative values misread as errors | High | Add direction/signed amount semantics |
| Monthly cash-flow row labels shift | High | Detect by sheet type + candidate labels + review screen |
| AI gives misleading financial interpretation | High | AI commentary only, deterministic calculations are source of truth |
| Scope creep into ERP | High | Keep module gates; no inventory/payroll/accounting ledger |
| User builds analytics before payment workflow | Medium | Phase-gate: payment/cashflow first, capacity later |
| Multi-year forecast gives false confidence | Medium | Show source/import confidence and last review date |
| Check duplicate rows | Medium | Duplicate detection + manual review |
| Cash continuity mismatch | Medium | Continuity validation rules |

---

## 26. Claude Initial Prompt v2

Use this after uploading the updated package:

```text
You are Claude Code acting as a senior full-stack product architect, database architect, QA lead, and implementation engineer.

I uploaded the MAS Nakit Radar package. Read implementation.md first.

Important update:
This is no longer only a payment calendar. The workbook evidence shows four pillars:
1. payment radar
2. monthly cash-flow forecast
3. checks + loans + financing radar
4. production capacity/cost analytics

Still, this is NOT a public SaaS and NOT an ERP.
Do not build multi-tenant features, subscriptions, pricing pages, public landing pages, Stripe/iyzico, onboarding, marketplace logic, or generic SaaS features.

Start by inspecting all docs and the .claude skills.
Then provide:
1. what the app is now
2. what changed from the previous payment-only scope
3. the safest Phase 0 and Phase 1 plan
4. exact files you will create/modify
5. what you will not build yet

Do not start Phase 2 or broad UI polish.
Implement Phase 0 and Phase 1 only after confirming the plan.
```

---

## 27. Final Product Boundary

The correct final product is not:

- a public SaaS
- an ERP
- a bookkeeping/accounting replacement
- an AI accountant
- a generic dashboard template

The correct final product is:

> MAS’ın gerçek Excel çalışma şeklini güvenli, izlenebilir, hatırlatmalı, raporlu ve analiz edilebilir bir iç operasyon paneline dönüştüren özel finans-operasyon sistemi.

MVP mantra:

> Önce veriyi kaybetme. Sonra ödeme ve nakit riskini görünür yap. En son stratejik kapasite/maliyet zekasını ekle.
