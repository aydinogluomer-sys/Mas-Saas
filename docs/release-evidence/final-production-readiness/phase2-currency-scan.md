# PHASE 2.2 — Para birimi toplama noktaları taraması

**Plan:** `implementation(20260912-211920).md` §2.2 "Tüm aggregation noktalarını tara"
**Tarih:** 2026-09-13 · **HEAD:** `864908d` · **Yöntem:** salt-okunur kaynak taraması (Explore ajanı, 60 araç çağrısı). Gerçek DB'ye dokunulmadı.

---

## Ana bulgu — şema iki dünyaya bölünmüş

| Dünya | Tablolar | Para birimi kolonu | Toplamların durumu |
|---|---|---|---|
| **Yapısal TRY** | `checks`, `loans`, `loan_installments`, `cashflow_months`, `cashflow_lines`, `bank_accounts`, tüm production/costing | **YOK** | Karışamaz — **SAFE by construction** |
| **Para birimi taşıyan** | `payments`, `payment_instances`, `cash_accounts`, `bank_transactions`, `invoices`, `promise_to_pay`, `credit_facilities`, `facility_drawdowns`, `budget*`, `forecast*`, `approvals`, `approval_rules`, `treasury_policies` | `text not null default 'TRY'`, **CHECK yok** | Yalnız treasury (0063), calendar (0080), budget (0070), profitability (0075) view'ları ve optimization motoru para birimine göre gruplar; **geri kalanı kör toplar** |

`0090_check_loan_currency.sql` (checks/loans CHECK) yalnız `feature/standard-import-v2` dalında; release'te yok.

---

## 73 nokta — kapanış sınıfına göre

### SAFE — yapısal olarak tek para birimi (21 nokta) — aksiyon yok
#18–#29 cashflow/checks/loans/financing · #51–#52 tek fatura içi · #66 costing · #67 production · #69–#70 FX (TRY-değerli)

### GUARDED — para birimine göre filtreli/gruplu (9 nokta) — aksiyon yok
#38–#39, #41–#42, #44 treasury · #61 budget views · #65 profitability · #68 fx_exposure · #71 financial_calendar · #73 briefing TRY seçimi

### UNGUARDED — kapanması gereken (43 nokta)

**Tier 1 — Eşik/risk kararları (kalıcı yazılan, alarm üreten) — EN YÜKSEK ÖNCELİK**

| # | Yer | Sorun |
|---|---|---|
| 4 | `radar/rules.ts:136-155` `dayFlags` | `knownSum >= t.critical` — eşik `*_threshold_try`, tutar para birimi kontrolsüz |
| 5 | `radar/rules.ts:200-213` `dayFlagsFromAggregate` | aynı |
| 6 | `radar/rules.ts:88-124` `computeRisk` → `engine.ts:481-494` | `risk_level` **DB'ye yazılıyor**, sorgu currency seçmiyor |
| 15 | `0078:255-276` `anomaly_split_payments` | `sum(i.amount) >= critical_payment_threshold_try` |
| 17 | `approvals/rules.ts:51-61` + `engine.ts:71-81` | `approval_rules.currency` kolonu VAR ama **SELECT bile edilmiyor** |
| 60 | `0039:136-143` counterparty | kör toplam vs `credit_limit` (kendi `credit_limit_currency`'si var) |

**Tier 2 — Kullanıcıya gösterilen toplamlar (28 nokta)**

Radar/home KPI: #1 (`page.tsx:27-36` "Bugün çıkış / 7 günde / Geciken"), #2, #3, #7, #8, #9, #10, #11, #12, #13, #14
Faturalar/alacaklar: #45, #46, #47, #48, #49, #50, #53, #54, #55, #56, #57, #58
Kredi limitleri: #32, #33, #34
Sayfa seviyesinde çökertme: #63 (`cashflow/budget/page.tsx:36` — SQL view para birimine göre gruplu, **TSX reduce tekrar birleştiriyor**), #72 (`finance/calendar/page.tsx:35` — aynı desen)

**Tier 3 — SQL view'ları (9 nokta) — forward-only migration**

| # | View | Sorun |
|---|---|---|
| 30 | `0067:12-45` `credit_facility_utilization` | `d.currency = f.currency` doğrulanmıyor |
| 31 | `0067:57-103` `debt_maturity_ladder` | TRY taksit + çok-para-birimli facility karışık |
| 35 | `0043:99-120` `bank_reconciliation_summary` | `bt.currency` göz ardı |
| 37 | `0063:25-56` `bank_cash_position` | hesap para birimine göre gruplu ama işlem para birimi kontrolsüz |
| **40** | **`0063:132` `liquidity_forecast_daily`** | **fatura ayağı `'TRY'` literal — `v.currency` atılıyor.** `financial_calendar` (0080:66) ise doğru kullanıyor → iki "aynı yükümlülük" view'ı TRY-dışı faturada **çelişiyor** |
| 43 | `0063:214-252` `treasury_cashflow_reconciliation` | `month_start` join'inde para birimi yok → yabancı hesap sahte "divergent" üretir |
| 59 | `0039:29-131` `counterparty_exposure` | UNION `i.currency`'yi düşürüyor |
| 62 | `0070:158-183` `forecast_accuracy` | para birimine göre gruplu değil |

---

## Yedi soru — cevaplar

1. **Currency kolonu olan tablolar:** 22 tablo (liste yukarıda). Olmayan: checks, loans, loan_installments, cashflow_*, bank_accounts, invoice_lines, invoice_allocations, production/costing.
2. **0090 CHECK:** release'te **yok**; V2 dalında. checks/loans TRY-only **eksiklikten** dolayı, CHECK'ten değil.
3. **payments/payment_instances:** `currency text not null default 'TRY'`, CHECK yok. Dashboard yabancı satırı **sayıyor** (`queries.ts:207`) ama toplamdan **çıkarmıyor**.
4. **cashflow_months:** currency yok. `closing_balance` hesaplanmıyor, Excel'den olduğu gibi alınıyor (`cashflow/engine.ts:79-89`).
5. **FX motoru:** revaluation var (`fx/rules.ts`), genel "X → TRY çevir" fonksiyonu **yok**, hiçbir toplama kullanmıyor. `0063:9-12`: "CURRENCIES ARE NEVER NETTED".
6. **`sumMoney`/`sumDecimal`:** para birimi parametresi **yok**, kör. `money.ts:81`: "every money column is numeric(14,2)" — TL varsayımı.
7. **Home KPI'ları:** `BASE` sorgusu (`queries.ts:32-42`) `i.currency` **seçiyor** ama filtrelemiyor; `knownOutflow` `total += r.amount` kör. **Filtresiz.** Ek: `page.tsx:224` `row.amount ?? 0` — null→0 (CLAUDE.md ihlali, ayrıca).

---

## Kapanış stratejisi — plan §2.1 ile uyumlu

Plan açıkça diyor: `MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED` **açık teknik borçtur**; controlled-use için politika **TRY-only**. Bu yüzden 43 noktayı FX motoruyla değil, **kör toplamayı imkânsız kılarak** kapatıyoruz:

1. **Gerçek DB ölçümü (salt-okunur):** her currency kolonunda `<> 'TRY'` satır sayısı. Sıfırsa bugünkü toplamlar doğru; risk yalnız gelecek import'ta — o da V2 TRY-only sözleşmesiyle kapalı.
2. **Tier 1 (6 nokta):** eşik karşılaştırması yalnız `currency = 'TRY'` satırlarda; TRY-dışı satır `risk_level = 'unsupported_currency'` gibi ayrı işaretle, sessizce atlanmaz.
3. **Tier 2 (28 nokta):** ortak `BASE` sorgusuna ve view'lara `currency = 'TRY'` filtresi + hariç tutulan satır sayısı ayrı döner; UI "**n kalem TRY-dışı, toplamda yok**" gösterir (plan §2.3 UI kuralı).
4. **Tier 3 (9 nokta):** forward-only migration ile view'lar düzeltilir; **#40 en kritik** (iki view çelişiyor).
5. **`payments` vb. için DB CHECK eklenmez** — bu, plan §5.3 madde 5'teki **açık iş kararı** ("TRY-only politika controlled-use için kabul mü?"). Kod filtreler, şema kullanıcı kararını bekler.

`CROSS_CURRENCY_INVALID_SUMS = 0` kabulü: (1) + (2) + (3) + (4) tamamlanınca.
