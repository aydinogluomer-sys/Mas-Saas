# Calculation Rules — v1 (Phase 0)

Deterministic rules. AI never computes source-of-truth values (CLAUDE.md). Every rule below must have a corresponding test before the module that uses it ships.

## Amount semantics

| Value | Meaning | Handling |
|---|---|---|
| `null` | unknown | excluded from sums; **counted and displayed** ("n kalem tutarı eksik"); never rendered as 0 |
| `0` | explicit zero | included in sums as 0 |
| negative | signed source value | context decides: checks/cashflow-balances = direction; ödeme tablosu = anomaly → review |

## Monthly cash-flow continuity

```
closing_balance = opening_balance + projected_income − projected_expense (+ adjustments)
next_month.opening_balance == previous_month.closing_balance
```

Mismatch ⇒ flag `continuity_break` (severity high). Known history: the original workbook had two breaks (haziran 2026 opening blank; ARALIK 2028 chained to EKİM 2028, skipping KASIM). Repaired in TEMİZ; validator still checks every import.

## Due-day normalization

- due_day 1–28 → direct date in instance month.
- due_day 29–31 in a shorter month → **last day of month** + flag `short_month_adjustment` (Şubat 2027→28, Şubat 2028→29 artık yıl, 30-day months→30).

## Instance generation

- Idempotency key: `(payment_id, instance_month)` — DB-level unique; regeneration never duplicates.
- Generation only for months ≥ payment creation month unless the row originates from a source workbook (then source month applies).
- Monthly recurrence **requires** `due_day` (DB constraint `payment_due_rule`).

## Payment status

- `paid` ⇒ `paid_at` not null (DB constraint `paid_requires_paid_at`).
- Overdue: `due_date < today` AND status ∈ {unpaid, partial}.
- Timezone for "today", reminder eligibility and reports: **Europe/Istanbul**.

## Risk thresholds (defaults; overridable in `settings`)

```
large_payment_threshold_try      = 50_000
critical_payment_threshold_try   = 100_000
same_day_cluster_count           = 3
negative_cash_threshold_try      = 0
high_customer_concentration_ratio = 0.40
high_bank_exposure_ratio          = 0.40
```

Day risk flags: cluster (count ≥ 3 pending same day), large (any known ≥ 50k), critical (any known ≥ 100k OR known day-sum ≥ 100k).

## Cash-flow analytics definitions

- **First negative month**: earliest month with `closing_balance < negative_cash_threshold_try`.
- **Worst month**: minimum `closing_balance` over horizon.
- **Consecutive negatives**: ≥3 sequential months with closing < 0 ⇒ escalate severity.
- **Concentration**: party share of period income (or expense) > 0.40 ⇒ flag; unknown-amount lines excluded from the ratio and disclosed.

## Loan calculations

- `total_finance_cost = total_payment − principal` (source: B11 = B10 − B4).
- Installment source formula: `PMT(rate_adj, term, −principal) × 1.0543084` — preserved as *source formula*, reconciled (±1 TL) against imported values; divergence ⇒ `loan_reconciliation` review, source value wins until reviewed.
- Debt-service monthly load = Σ installments due in month; overlay on cash-flow deficit months.

## Checks

- `direction = signed_amount < 0 ? outflow : inflow`; `amount = |signed_amount|`.
- Maturity grouping: ISO week and calendar month, Europe/Istanbul.
- Duplicate suspicion: same counterparty (KİMDEN if present, else KİME; TR-normalized so case variants like çağdaş/ÇAĞDAŞ match) + same |amount| within ±3 days ⇒ review, never auto-merge. (Real ÇEKLER sheet: KİMDEN empty; duplicates keyed by KİME.)

## Capacity / cost (analytics-only)

- Break-even TL/dk = allocated monthly fixed cost ÷ effective monthly minutes (minutes × efficiency).
- Normal vs overtime compared on identical part mix; outputs labeled *analytics, not accounting truth*.
- 2023 tariff rates in `kapasite` are stale ⇒ every derived figure carries `stale_rate` badge until user updates rates.

## Risk ladder (instance level — Phase 3)

`critical_payment → critical` · `overdue → high` · `large/cluster/negative → medium` · yalnız `missing_amount → low` · aksi `none`. Ödenmiş/iptal kayıtlar risk almaz. Yığılma sayımı aynı vade gününe düşen AÇIK kayıtlar üzerinden.

## Review-status semantics (mapping eligibility)

- inceleme yok (temiz satır) → aktarılabilir
- tüm incelemeler ∈ {accepted, resolved} → aktarılabilir (accepted = "bu haliyle doğru, aktar")
- herhangi biri ∈ {open, rejected} → AKTARILMAZ
- isimsiz satır → inceleme kabul edilse bile ASLA aktarılmaz (ad zorunlu)
- kabul edilen günsüz kalem → recurrence='irregular' olarak aktarılır; takvime giremez, Radar "günsüz" raporunda görünür
- kabul edilen negatif tutar → olduğu gibi korunur (confidence=variable), instance'ta negative_amount risk bayrağı sürer

## Horizon cards (Phase 4)

Çapa ay = bugünün ayı (veri aralığındaysa), değilse ilk veri ayı. Ufuklar 3/6/12/24/36 ay; pencere veri sonunu aşarsa kart "veri sonu" rozetiyle kesilir (uydurma projeksiyon yapılmaz). Pencere toplamları yalnız bilinen tutarlarla; eksik ay sayısı kartta beyan edilir.

## `FIN-03` Bilinmeyen Açılış Bakiyesi ve Döviz Kova Ayrımı (Faz 44 — Migration 0099)

- **`BLANK ≠ ZERO` (`FIN-03`):** Bir aktif kasa/banka hesabında `opening_balance IS NULL` ise türetilen bakiye (`derived_balance`) **asla `0 + hareketler` olarak uydurulmaz**; `derived_balance = NULL`, `available_now = NULL`, `projected_contracted = NULL` ve `financing_need = NULL` (`status = 'unknown_opening_balance'`) olarak taşınır. Hareket bazlı net değişim (`movement_net` / `movements_only_total`) ayrı yardımcı satırda gösterilir.
- **Hazine ↔ Nakit Akışı Mutabakatı:** Aktif `TRY` banka hesaplarından herhangi birinin `opening_balance` değeri `NULL` ise `treasury_cashflow_reconciliation` sahte `'divergent'` P0 alarmı üretmez; `'incomplete_opening_balance'` döndürür.
- **Sıfır Sessiz Döviz Karışımı:** Kredi taksitleri (`loans.currency`), çekler (`checks.currency`), faturalar (`invoices.currency`), 13 haftalık tahmin (`cash_forecast_13w`) ve optimizasyon özetleri (`optimization_run_summary`) kendi para birimi kovalarında toplanır; `payment_instances.currency IS NULL` olan satırlar `'TRY'` varsayılmaz, `unknown_currency_count` olarak ayrı sayılır.
- **Çapraz-Döviz Fatura Tahsisi Yasağı:** Kur çevrim kaydı olmadan farklı para birimli bir kaynak (`USD` banka hareketi / çek / ödeme) `TRY` faturaya tahsis edilemez (`ERRCODE = '23514'`, `cross_currency_allocation_forbidden` ve uygulama katmanı `DomainError("VALIDATION", ...)`).
- **Fatura ↔ Çek / Ödeme Çift Sayım Engeli:** `settled_by_check_id` veya `linked_invoice_id` ile aktif bir çek ya da ödeme kalemine bağlanmış faturalar `liquidity_forecast_daily`, `financial_calendar` ve `payment_priority_queue` içinde ikinci kez sayılmaz.
- **Yıllık Bütçe 12-Ay Dağılımı:** `period_kind = 'annual'` bütçe satırları ilk 11 aya `round(amount / 12, 2)`, 12. aya `amount - 11 * round(amount / 12, 2)` kuralıyla kuruş kaybı olmadan dağıtılır.

## Çekirdek Finans Motorları Kuralları (Faz 46 — `C3`)

- **5 Katmanlı Deterministik Davranışsal Tahsilat Tarihi (`expectedCollectionDateV2`):**
  1. `badDebtFlagged === true` → `projectedDate: null, bucket: "doubtful_excluded"` (şüpheli alacak 7/30 günlük likidite girişine asla eklenmez).
  2. Aktif ve kırılmamış ödeme sözü (`status = 'open' AND promised_date >= todayISO`) → `promised_date` (`bucket: "promised"`).
  3. Müşterinin geçmiş kapanmış faturalarından (`invoice_allocations`) en az 3 örneklem varsa medyan `DBT` (`days_beyond_terms`, ihtiyatlı modda `P75`): `dueDate + dbt >= todayISO` ise o tarih (`bucket: "behavioral_dbt"`).
  4. Henüz vadesi gelmemiş fatura (`dueDate >= todayISO`) → `dueDate + defaultLag` (`bucket: "scheduled"`).
  5. Vadesi geçmiş ve beklenen tahsilat tarihi `todayISO` öncesinde kalan açık fatura → **asla `todayISO` üzerine yığılmaz ("Today Cliff" yasak)**; `projectedDate: null, bucket: "overdue_unscheduled"` olarak ayrı **"Takvime Bağlanmamış Gecikmiş Alacak"** kovasında gösterilir.
- **Alacak Yoğunlaşması (`loadReceivableRisk`):** Açık `TRY` alacaklar için `concentrationRatio` hesaplanır; dövizli açık alacaklar para birimi bazında (`currencyConcentrationRatio`) ayrı döndürülür.
- **Ufuk-İçi En Düşük Kasa ve 90 Takvim Günü Taban Böleni (`treasury`):**
  - Likidite tabanı ihlali (`breachesFloor`) ve finansman ihtiyacı (`financingNeed`) yalnızca ufuk sonu kapanışına (`projectedContracted`) değil, `[todayISO .. todayISO + N]` aralığındaki **en düşük kümülatif günlük sözleşmeli bakiyeye (`minIntraHorizonBalance`, `worstDayISO`)** göre hesaplanır.
  - Dinamik nakit tabanı (`bufferDays`), son 90 takvim günündeki toplam nakit çıkışının aktif işlem gün sayısına değil sabit **`90` takvim gününe** (`Big(total90dOutflow).div(90)`) bölünmesiyle bulunur.
- **Çapası Korunan Kredi Taksit Vadeleri (`addMonthsPreservingAnchorDay`):**
  - `2026-01-31` başlangıçlı taksit takviminde Şubat taksiti `2026-02-28` (artık yılda `29`), Mart taksiti tekrar **`2026-03-31`**, Nisan taksiti **`2026-04-30`** olur; Şubat nedeniyle 28'e kalıcı kilitlenme yapılmaz.
  - Açık `0` KKDF + `0` BSMV toplamı `null` değil `0` olarak korunur.
- **Canlı TCMB XML Bülten Tarihi (`parseTcmbBulletinDate`):**
  - Gerçek TCMB kök etiketi `<Tarih_Date Tarih="DD.MM.YYYY" Date="MM/DD/YYYY" ...>` ayrıştırılır; hafta sonu/tatil sorgularında `bulletin_date` (TCMB bülten tarihi) ile `queried_date` ayrımı korunur.
- **Banka Eşleştirici Yön ve Döviz Zorunluluğu (`scoreMatch`):**
  - `tx.amount > 0` yalnız `inflow/sales`, `tx.amount < 0` yalnız `outflow/purchase` adaylarıyla ve yalnız `tx.currency === candidate.currency` olduğunda eşleşir; açık `0,00` borç/alacak satırları `null` yapılmaz, `0` olarak korunur.
- **Likidite Optimizasyon Çözücüsü (`optimization`):**
  - `openingCash === null` (`FIN-03`) olduğunda çözücü uydurma `0` kasa ile çalışmaz; açık durdurma gerekçesiyle durur.
  - Günlük yüklemeler para birimi bazında (`currency = $1`) `payment_instances`, `checks`, `loan_installments` ve şablonsuz açık `purchase` faturalarını kapsar; `credit_facility_utilization` üzerinden gerçek `drawn_amount` okunur; üç amaç fonksiyonu (`max_liquidity_buffer`, `min_financing_cost`, `min_late_payment`) deterministik olarak farklı aksiyon sıralaması üretir.
- **Türkiye Resmi Tatil ve Vergi/SGK Takvimi (`tr-holidays.ts`, `tr-tax-calendar.ts`):**
  - **VUK Md. 18/4** uyarınca hafta sonuna veya resmi/dini bayram tatiline (arife yarım günü sonrası tam tatil günleri dahil) denk gelen son ödeme günleri takip eden ilk iş gününe (`nextTurkishBusinessDay`) kaydırılır.
  - Takvim kalemleri: **KDV-2** (25'i), **MPHB** (26'sı), **KDV-1** (28'i), **SGK 4/a** (ay sonu), **Kurumlar Geçici Vergi** (**7566 Sayılı Kanun** uyumlu 4 dönem: Q1 17 Mayıs, Q2 17 Ağustos, Q3 17 Kasım, Q4 17 Şubat), **Kurumlar Vergisi Yıllık** (30 Nisan), **MTV 1. ve 2. Taksit** (31 Ocak, 31 Temmuz). Yürürlükten kaldırılan **BA/BS formları üretilmez**.

## Ödeme Paketi (`payment_runs`), Çek Bordrosu, Paraşüt v4, Yönetim Defteri, Yasal Mizan Köprüsü, 13-Hafta Varyans ve CFO Zekâsı Kuralları (Faz 48–56)

- **14 Günlük Kasa Alt Limiti Bariyeri (`payment_runs` — Faz 48 / `0101`):**
  - Ödeme paketi toplamı (`total_amount`), paketin yürütme tarihini izleyen 14 gün içindeki en düşük kümülatif sözleşmeli kasayı (`projected_14d_min_cash`) aktif `min_cash` politikası (`min_cash_floor`) altına düşürüyorsa `breaches_cash_floor = true` işaretlenir ve onay kademesi yükseltilir.
  - Yeni eklenen veya değiştirilen tedarikçi IBAN'ı 48 saatlik BEC soğuma süresini (`verified_at`) ve ikinci göz onayını tamamlamadan ödeme paketine dahil edilemez.
- **Türkiye Çek/Senet Bordrosu ve Ciro Rücu Riski (`check_bordros` — Faz 49 / `0102`):**
  - Tedarikçiye ciro edilen müşteri çeki (`status = 'endorsed'`), tedarikçi borcunu kapattığı ve şirket kasasına nakit girmeyeceği için `liquidity_forecast_daily` nakit girişlerinden düşer; ancak çekin vadesi geçip `'cleared'` olana dek **`900 / 901` nazım hesaplarında ve `contingent_recourse_amount` alanında şarta bağlı ciro rücu riski** olarak izlenir.
  - Bankaya teminata verilen çeklerde (`in_bank_collateral`) kullanılabilir kredi marjı `amount * collateral_ltv_ratio` ile hesaplanır.
- **Paraşüt API v4 (`S-1..S-10`) ve Hibrit Banka Tekilleştirme Kuralları (Faz 51 / `0104`):**
  - `TRL` para birimi kodu kanonik `'TRY'` olarak normalize edilir; KDV tevkifatlı satış faturalarında nakit tahsilat beklentisi `gross_total` değil **`payable_amount = net_total_after_withholding`** üzerinden izlenir.
  - Kendi banka hesaplarımız arasındaki virmanlar (`transaction_kind = 'own_transfer'`) hesap bazlı `bank_cash_position` bakiyesini günceller, ancak konsolide şirket nakit giriş/çıkış toplamlarına (`daily_cash_movement`, `working_capital_monthly_v`, `forecast_13w_variance_v`) dahil edilmez.
  - Aynı gün, aynı kasa/banka hesabı, aynı işaretli kuruş tutarı ve VKN/IBAN/fatura no kesişimi taşıyan MT940 / `camt.053` / Paraşüt API banka hareketleri `cross_channel_dedupe_hash` ile tekilleştirilir; ikinci kanal satırı çift sayılmaz, mevcut satırın banka referansını zenginleştirir.
- **Çift Taraflı TDHP Yönetim Defteri ve Yönetim EBITDA (Faz 52 / `0105`):**
  - Kesinleşmiş (`posted`) her yönetim yevmiye fişinde `sum(debit_try) == sum(credit_try)` eşitliği PostgreSQL `DEFERRABLE INITIALLY DEFERRED` tetikleyicisiyle zorlanır; kuruş farkı `0,00`'dan farklı hiçbir fiş `COMMIT` edilemez.
  - **Yönetim Bilançosu (`management_balance_sheet_v`):** Cari dönem net kâr/zararı dinamik olarak `590.DYN` / `591.DYN` özkaynak kalemine yansıtılır; her tarihte `Aktif Toplamı == Pasif (Yabancı Kaynak + Özkaynak) Toplamı` (`discrepancy_try = 0.00`).
  - **Yönetim EBITDA (`management_income_statement_v`):** `Brüt Satışlar (600) - Satış İndirimleri (610/611) = Net Satışlar - SMM (620/621/622) = Brüt Kâr - Faaliyet Giderleri (630/631/632, 770) = Faaliyet Kârı (EBIT) + Amortisman Geri Eklemesi (257 / 770.99 D&A) = Yönetim EBITDA`. Kredi anapara ödemeleri (`300`) asla gider yazılmaz; yalnız faiz + BSMV + KKDF (`780`) finansman gideridir ve EBITDA sonrasında düşülür.
- **12 Kök Nedenli Mali Müşavir Yasal Mizan Mutabakatı (Faz 53 / `0106`):**
  - Luca/Logo hiyerarşik mizanlarında alt hesabı bulunan üst satırlar (`120`, `120.01`) `is_leaf = false` işaretlenir ve çift sayılmaz; mutabakat yalnız `is_leaf = true` yaprak satırlar üzerinden yürütülür.
- **Otomatik 13-Hafta Tahmin ve Zamanlama Kayması vs. Kalıcı Varyans Şelalesi (Faz 54 / `0107`):**
  - Dondurulmuş haftalık baz çizgi (`forecast_snapshots_13w`) ile gerçekleşen banka hareketleri karşılaştırılırken, beklenen hafta içinde tahsil edilmeyip açık kalan veya ileri haftaya ötelenen belgeler **`TIMING_SLIP` (Zamanlama Kayması)**; iptal edilen, tutarı değişen veya planda hiç olmayan nakit hareketleri **`PERMANENT_VARIANCE` (Kalıcı Varyans)** olarak ayrıştırılır.
- **Gece Nakit/Gap7 Değişim Atfı, Nakit DSCR/CFADS, İkili Runway ve Başabaş Goal-Seek (Faz 55 / `F2`):**
  - **Gece Nakit Özdeşliği:** `currentAvailableCash - previousAvailableCash == bankInflows + bankOutflows + fxValuationDelta + unexplainedResidual` (`cashIdentityDrift = 0.00`).
  - **Nakit DSCR & CFADS:** `CFADS = Esas Faaliyet Nakit Girişleri - Esas Faaliyet Nakit Çıkışları - Ödenen Vergi/SGK - Bakım CapEx`; `Nakit DSCR = CFADS / (Kredi Anapara Servisi [300] + Faiz/BSMV/KKDF Servisi [780])`.
  - **İkili Nakit Ömrü (Dual Runway):** Tarihsel brüt/net yanma hızı (`historicalRunwayDays`) ile ileri 13 haftalık tahminden türetilen 30 günlük ileri net yanma hızı (`forward13wRunwayDays`) yan yana hesaplanır ve en erken nakit tabanı ihlal tarihi (`firstFloorBreachDate`) raporlanır.
  - **Deterministik Başabaş Goal-Seek:** Kümülatif nakit açığını tam `0,00` yapacak 4 bağımsız kaldıraç (1: İhtiyari gider kesintisi `%`, 2: Tedarikçi ödeme vadesi uzatımı `+DPO gün`, 3: Alacak tahsilat hızlandırması `-DSO gün`, 4: Ek net satış/tahsilat `TRY`) kapalı form `Big.js` denklemleriyle (`residualDeficitTry = 0.00`) çözülür.

## Kuyruk Zarfı Değişmezliği, Kapalı Çevrim Otomasyon ve `v6` Derin CFO Zekâsı Kuralları (Faz 57–58 / Migration 0108)

- **Arka Plan İş Kuyruğu Zarf Değişmezliği (`background_jobs` — Faz 57 / `0108`):**
  - İş girdisi (`payload`) ile iş çıktısı (`result jsonb`) fiziksel olarak ayrılmıştır; `completeJob` hiçbir koşulda `payload` sütununu ezmez veya birleştirmez.
  - `enforce_background_jobs_immutable_envelope()` (`BEFORE UPDATE`) tetikleyicisi `id`, `job_type`, `created_by`, `payload`, `dedupe_key` ve `created_at` zarf alanlarının sonradan değiştirilmesini `ERRCODE = '23514'` ile reddeder.
- **Kapalı Çevrim Günlük Finansal Otomasyon Zinciri (`sync-pipeline.ts`):**
  - Deterministik sıra: `Paraşüt v4 Senkronu (S-1..S-10)` → `TCMB Günlük Resmi Kur Senkronu` → `TDHP Yönetim Defteri Artımlı Senkronu + provisional_fx Yeniden Değerleme` → `13 Haftalık Nakit Tahmin Baz Çizgisi Dondurma` → `Sabah CFO Özeti & Denetim Kontrolleri`. Sıfır yeni belge geldiğinde (`syncedCount = 0`) dahi daha önce geçici kurla bekleyen (`provisional_fx`) belgelerin resmi TCMB kuruyla kesinleşmesi için yönetim defteri senkronu atlanmaz.
- **TDHP `7xx` Fiili Gider ↔ Tezgâh Dakika (`TL/dk`) Canlı Başabaş Köprüsü (`actual-cost-bridge.ts`):**
  - Onaylı (`posted`, ters kayıt netleştirilmiş) yönetim yevmiye satırlarından son `N` aylık ortalama fiili giderler üç katmanda ayrıştırılır: **Nakit İşletme `7xx`** (`710–779`, amortisman hariç), **Tam İşletme `7xx`** (`+ 730.99 / 770.99` amortisman payı) ve **Finansman `780`** (işletme başabaşından ayrı izlenir).
  - **`BLANK ≠ ZERO`:** Yeterli `7xx` fiili yevmiye verisi yoksa (`status = 'insufficient_ledger_actuals'`) veya kapasite senaryosunda efektif dakika bilinmiyorsa (`<= 0` / `null`, `status = 'unknown_effective_minutes'`), fiili `TL/dk` başabaş değerleri **asla `0,00 TL/dk` olarak üretilmez** (`null` döner).
  - **Gizli Marj Erimesi (`hiddenMarginErosion`):** Statik defter maliyet modelinde kârlı görünen (`fiyat > defter başabaş`) ancak canlı `7xx` tam maliyet başabaşının altında kalan (`fiyat < fiili tam başabaş`) müşteri tarife ve parça satırları deterministik olarak işaretlenir.
- **TCMB Kur Şoku (`+%10 / +%20 / +%30`), Doğal Hedge ve Kovenant Kırılma Stres Motoru (`fx-stress.ts`):**
  - Her yabancı para birimi (`USD`, `EUR`, `GBP` vb.) kendi yerel para birimi kovasında (`fxAssets`, `fxLiabilities`, `netNativePosition`, `naturalHedgeRatio = min(1, fxAssets / fxLiabilities)`) ayrı tutulur; farklı döviz birimleri asla birbirine toplanmaz.
  - **`BLANK ≠ ZERO` & Sıfır Sahte `1.0` Kur:** Açık pozisyonu bulunan herhangi bir yabancı para için resmi TCMB kuru (`fx_rate_snapshots`) eksikse `status = 'missing_fx_rates'` ve `consolidatedShockDeltaTry = null` döner; hiçbir koşulda `1.0` yedek kuru kullanılmaz. `FIN-03` kapsamında kasa açılış bakiyesi bilinmiyorsa `hasUnknownCashOpening = true` korunur.
  - Şoklanmış gelecek 12 aylık döviz borç servisi ve şoklanmış Net Borç doğrudan `computeCashDscrWindow` ve `evaluateCovenantThreshold` motorlarına beslenerek hangi kur şoku bandında `min_dscr`, `max_net_debt_to_ebitda` veya `min_cash_balance` sözleşme taahhüdünün (kovenant) kırıldığı hesaplanır.
- **Karşı Taraf Davranışsal Çalışma Sermayesi ve Tahsilat Güvenilirlik Karnesi (`scorecard.ts`):**
  - **`BLANK ≠ ZERO` (İnce Geçmiş Koruması):** Kapanmış fatura sayısı `< 3` olan karşı taraflarda medyan ve P75 `DBT` (`days beyond terms`) **asla `0 gün` sayılmaz** (`null` taşınır). Kapanmış ödeme sözü (`kept + broken === 0`) bulunmayan karşı taraflarda `promiseKeptRatio = null` taşınır. Yeterli geçmişi ve aktif çek/rücu sinyali olmayan yeni cariler `'insufficient_history'` (`Belirsiz — Yetersiz Geçmiş`) olarak sınıflandırılır.
  - Portföydeki çekler (`activeCheckPortfolioByCurrency`), tedarikçiye ciro edilen müşteri çeklerinden doğan şarta bağlı rücu riski (`contingentRecourseByCurrency`) ve karşılıksız çekler (`bouncedByCurrency`) her para biriminin kendi kovasında (`Big.js`) tutulur.
  - Deterministik davranışsal kademelendirme (`A` / `B` / `C` / `D` / `Belirsiz`) eşikleri ekranda açıkça `"Varsayım (Model Sabiti)"` olarak beyan edilir.


## 360° Canlı Denetim Kapanışı — Tekil Kalan Borç, `500.99` Açılış Köprüsü, `103/102` Tek-Kaynak Yevmiye ve `0109..0113` Kuralları (Faz 59)

- **Birleşik Fatura Kalan Tutar Formülü (`0110` & `0113` + Tüm Motorlar):**
  - KDV tevkifatlı ve parçalı tahsisatlı faturalarda kalan açık bakiye tüm SQL görünümlerinde (`liquidity_forecast_daily`, `financial_calendar`, `payment_priority_queue`, `ar_open_items`) ve TypeScript motorlarında (`collections`, `rolling-13w-engine`, `optimization`) tek kanonik formülle hesaplanır:
    `remaining_amount = greatest(0, coalesce(payable_amount, gross_amount) - greatest(coalesce(paid_amount, 0), coalesce(allocated_amount, 0)))`.
  - Hem `invoice_allocations` (`source_type in ('check', 'payment_instance')`) hem de açık ödeme sözleri (`promised_payments.invoice_id`, `status = 'open'`) ile kapsanan faturalar `liquidity_forecast_daily` içinde düşülerek fatura + çek / ödeme sözü çift sayımı sıfırlanır (`0110`, `0113`).
- **`FIN-03` Çift Katmanlı Kasa/Banka Açılış Bakiyesi ve `500.99` Denkleştirme Köprüsü (`0111` + `treasury/engine.ts`):**
  - Her kasa/banka hesabı (`cash_accounts`) `opening_balance`, `opening_balance_date` ve `opening_journal_entry_id` alanlarını taşır; `opening_balance IS NULL` iken `BLANK ≠ ZERO` kuralı gereği bakiye `NULL` kalır.
  - Operatör `/finance/treasury` üzerinden sıfır-dışı bir açılış bakiyesi kaydettiğinde sistem aynı veritabanı işleminde (`source_type = 'opening_balance'`) pozitif bakiye için **`Borç 100 Kasa / 102 Bankalar — Alacak 500.99 Açılış Bilançosu Denkleştirme Hesabı`** (negatif bakiye için ters yönlü) yevmiye fişi keser.
  - Açılış tutarı, tarihi, para birimi veya varlık sınıfı (`100` ↔ `102`) sonradan güncellenirse, kesinleşmiş (`posted`) eski açılış fişi yerinde silinmez; önce `reverseManagementEntryWithClient` ile ters kayıt (`reversal_of_entry_id`) üretilir, ardından yeni açılış fişi kesilir.
- **Verilen Çek (`103`), Tek-Kaynak `102 Bankalar` Tekilleştirmesi ve Otomatik Storno (`posting-engine.ts`):**
  - Tedarikçiye keşide edilen çek (`outflow`) ilk kayıtta `Borç 320 Satıcılar / Alacak 103 Verilen Çekler ve Ödeme Emirleri`, bankadan ödendiğinde (`cleared`) **`Borç 103 / Alacak 102 Bankalar`** yönüyle kapatılır (`102` asla ters yönde borçlandırılmaz).
  - Bir banka hareketi (`bank_transactions`) fatura, ödeme veya çek kapamasına bağlandığında (`matched_entity_table` dolu) `102 Bankalar` bacağı tek kanonik kaynaktan üretilir (hem kapama fişinden hem ham banka hareketinden çift `102` bacağı atılmaz).
  - Yoksayılan banka satırları (`bt.status = 'ignored'`) hiçbir yevmiye, nakit akışı veya DSCR hesabına dahil edilmez (`bt.status <> 'ignored'`). Eşleştirmesi kaldırılan (`unmatched`) veya iptal edilen kaynak belgelerin `posted` yönetim fişleri `reverseManagementEntryWithClient` ile otomatik ters kayıtla kapatılır.
- **13 Haftalık Nakit Tahmininde KDV Tevkifatı (`KDV_2` ve `KDV_1`) Ayrıştırması (`rolling-13w-engine.ts`):**
  - `TRY` faturalardan dönem (`YYYY-MM`) bazında `KDV_1` (izleyen ayın 28'i, VUK Md. 18 tatil kaydırmalı) `max(0, sum(sales.tax_amount - sales.vat_withholding_amount) - sum(purchase.tax_amount))` olarak; `KDV_2` sorumlu sıfatıyla tevkif edilen KDV (izleyen ayın 25'i) ise `sum(purchase.vat_withholding_amount)` olarak ayrı resmi vergi nakit çıkışı üretir.
- **Kovenant ve DSCR Motorunda Yatay Gelir Tablosu ve Özkaynak Okuması (`covenants-and-dscr.ts`):**
  - Yönetim EBITDA değeri `management_income_statement_v` yatay görünümündeki `ebit_try` ve `da_addback_try` sütunlarından (`257`/`268` birikmiş amortisman alacak bakiyesi `credit_total_try - debit_total_try` kontrolüyle); Toplam Özkaynak (`totalEquity`) ise `management_balance_sheet_v` (`where section = 'equity'`, özkaynak normal alacak yönü `credit_total_try - debit_total_try` + dinamik dönem net kâr/zararı `590.DYN`/`591.DYN`) üzerinden okunur.
- **Canlı Kapalı Çevrim Otomasyon Orkestratörü (`runClosedLoopFinancialPipeline` — `sync-pipeline.ts`):**
  - Hem `scripts/ops/background-worker.ts` (`MAS-Background-Worker`) hem de `/data/integrations` manuel tetikleyicisi üzerinden aktif olarak çalışır: `enqueueDueSyncs` → `importRates` (TCMB) → `rebuildOrSyncManagementLedger` → `freezeWeekly13wSnapshot` (Pazartesi veya eksik hafta baz çizgisi).
