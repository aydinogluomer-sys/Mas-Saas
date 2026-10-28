# PHASE 2 — FINANCIAL CORRECTNESS FINAL CLOSURE: Tier 2 + Tier 3 (2026-09-13)

Kaynak tarama: [`phase2-currency-scan.md`](phase2-currency-scan.md) (73 nokta) · Tier 1: [`phase2-tier1-closure.md`](phase2-tier1-closure.md)
Commit: `e248f98` (release) · Migration: **0094** · Politika modülü: `src/lib/currency-policy.ts`

## Tek kural, tek yer

```text
currency === undefined  → alan hiç yok (checks/loans/cashflow…)  → YAPISAL TRY, toplanır
currency === null       → bilinmiyor                              → toplanmaz, SAYILIR (TRY varsayılmaz)
currency === "TRY"      → toplanır
başka                   → toplanmaz, SAYILIR → ekran: "n kalem TRY-dışı — toplamda yok"
```

`partitionByCurrency` / `sumKnownReporting` / `isComparableCurrency` / `foreignNote` — Tier 1'in
`THRESHOLD_CURRENCY` ile aynı sabit. Kur çevirimi hâlâ YOK (`MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED`).

## 73 nokta — kapanış durumu

| Sınıf | Noktalar | Durum |
|---|---|---|
| SAFE (yapısal tek para birimi) | #18–#29, #51–#52, #66–#67, #69–#70 (21) | değişiklik yok |
| GUARDED (zaten para birimine göre) | #38*, #39, #41–#42, #44, #61, #65, #68, #71, #73 (9) | değişiklik yok (*#38 ek olarak hesap≠hareket para birimi süzgeci aldı) |
| Tier 1 | #4 #5 #6 #15 #17 #60 | **kapalı** (önceki tur, 0092/0093) |
| Tier 3 — SQL view (0094) | #30 #31 #35 #36 #37 #40 #43 #45 #46 #47 #48 #55 #56 #58 #62 + tarama-dışı #16 | **kapalı** |
| Tier 2 — TS/UI | #1 #2 #3 #7 #8 #9 #10 #11 #12 #13 #14 #32 #33 #34 #49 #50 #53 #54 #57 #63 #64 #72 | **kapalı** |
| #59 counterparty_exposure UNION | 0093 (Tier 1 turunda) | **kapalı** |

Her Tier 2/3 noktasının ne yapıldığı `e248f98` commit mesajında ve kaynak dosyalardaki `PHASE 2.2 (#n)` yorumlarında satır satır yazılı.

### Öne çıkan düzeltmeler

- **#40 çelişki kapandı:** `liquidity_forecast_daily` fatura ayağı `'TRY'` literal yerine `v.currency`. Fonksiyonel senaryoda `financial_calendar` ile `liquidity_forecast_daily` aynı USD faturayı aynı para biriminde veriyor (calendar USD 5000 = liquidity USD 5000).
- **#43:** `treasury_cashflow_reconciliation` artık yalnız TRY banka koşusunu TRY `cashflow_months` ile karşılaştırır; yabancı hesap sahte "divergent" üretemez.
- **#1 ek ihlal:** ana sayfa MiniTrend `row.amount ?? 0` (null→0, CLAUDE.md ihlali) kaldırıldı — eksik/TRY-dışı kalem seriye girmez, sayısı alt yazıda.
- **#10 eşik:** günlük raporun "kritik ödeme" listesi TRY-dışı kaleme TRY eşiği uygulamaz (Tier 1 kuralı raporlara da taşındı).
- **#57 nakit sırası:** TRY-dışı ödeme kalemi TRY nakitle "karşılandı" sayılmaz, kümülatife girmez, `foreignCount` ile bildirilir.
- **#33/#32:** kredi limitleri: USD limit TRY limitle toplanmaz; facility para biriminden farklı çekiş kullanıma girmez (`foreign_drawdown_count`).

## Doğrulama

| Kanıt | Sonuç |
|---|---|
| 0094 fresh release DB (`local-bootstrap` → 0001–0087 → 0092 → 0093 → 0094 → seed) | uygulandı, 81 view |
| 0094 birleşik sıra (V2 fresh DB 0001–0093 + 0094) | uygulandı; `counterparty_exposure_items` kolon sırası korundu, `currency` sonda |
| 13 view fonksiyonel senaryo (USD fatura 5000, EUR hareket TL hesapta, USD facility + TRY çekiş, USD söz) — transaction içinde, ROLLBACK | **tümü beklenen**: TL hesap derived=1300 foreign_txn=1; receivable_open=1000 foreign=1; dso 1000/400; USD KMH drawn=4000 foreign_drawdown=1; ladder foreign_facility=1; pending_amount=300 foreign_pending=1; calendar==liquidity |
| Gerçek 5 Eylül yedeğinin klonu: 0088–0094 + V2 fixture provası (`real-clone-v2-rehearsal.ts`) | **7/7 PASS**, 6 legacy finansal tablo birebir |
| `scripts/db/tier2-loaders-smoke.ts` gerçek klonda (13 değiştirilmiş yükleyici, salt-okur) | **13/13** — SQL çalışır, `foreign*` alanları döner |
| `tests/financial/currency-policy-tier2.test.ts` (9 modül × karışık para birimi girdisi) | **9/9** |
| Release: tsc 0 · eslint 0 · vitest **1477/1477** (1468 + 9 yeni) | PASS |
| Gerçek veri (5 Eylül klonu): 25 currency kolonunda non-TRY = 0 (Tier 1 belgesi) | bugünkü sayılar değişmez; kapanış gelecek importları korur |

## 2.8 Kabul tablosu

| Kabul | Durum | Kanıt |
|---|---|---|
| `FINANCIAL_MAPPING_ERRORS = 0` | PASS | phase3/4/5-verify TEMİZ ile ALL PASS; V2 e2e 69/69 |
| `CALCULATION_ERRORS = 0` | PASS | golden fixture 96+; phase4 final kasa −3.064.607,57 literal; kredi = kaynak B10 exact |
| `UNKNOWN_AS_ZERO = 0` | PASS | `sumKnownReporting.missing`, MiniTrend null→0 kaldırıldı, tüm loader'larda `unknown_count` ayrı |
| `CROSS_CURRENCY_INVALID_SUMS = 0` | **PASS** | Tier 1+2+3 kapalı; 43+2 nokta; gerçek veride non-TRY=0; karışık-para-birimi testleri 9/9 + 13 view senaryosu |
| `DOUBLE_COUNT_CASES = 0` | PASS (ölçüldü) | Tek-kaynak kuralı (`database-schema.md` "Tek kaynak — çift sayma yok": ciro/maliyet yalnız faturadan); gerçek klonda `payment_priority_queue` içinde aynı gün+aynı tutar+farklı tür çakışması **0**; `invoice_allocations(source_table='payment_instances')` 0 (fatura↔ödeme bağı açıkça modellenir, ikisi de toplama girmez) |
| `PARENT_CASCADE_ERRORS = 0` | PASS | `blocked_by_parent` (2.4c), önizleme == yazma, e2e/prova |
| `RAW_VALUE_LOSS = 0` | PASS | `__unknown__` ham hücreler (2.4b), source_cells/import_rows; V2 e2e "ham hâliyle durur" |

### Gate

**`FINANCIAL_CORRECTNESS = PASS`** — koşul: 0092/0093/0094 gerçek DB'ye kod deploy'undan ÖNCE uygulanır (Phase 8.2), Docker onarımı sonrası `pnpm db:migrate` ledger'ı ilerletir.

## Açık kalan (bilinçli, kapsam dışı)

- Şemada `payments`/`invoices` vb. için `currency = 'TRY'` CHECK **eklenmedi** — plan §5.3 madde 5 iş kararı (TRY-only politikanın şemaya yazılması kullanıcı onayı bekler). Kod ve view'lar süzer; şema karar bekler.
- `checks.currency`/`loans.currency` kolonları 0090 ile (import-v2 dalı) gelir; birleşme sonrası `counterparty_exposure_items` gerçek kolonu okur (0093 DO bloğu iki durumu da kapsar).
