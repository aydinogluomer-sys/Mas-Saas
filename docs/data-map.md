# MAS Nakit Radar — Data Map v3 (Phase 0, evidence-confirmed)

Supersedes v2's "workbook not parseable" assumption: Phase 0 spike parsed the real files. Full sheet-by-sheet table with ranges: `docs/phase0-parse-report.md` (generated, committed as evidence).

## Source files audited

| File | sha256(16) | Size | Status | Sheets |
|---|---|---:|---|--:|
| mesaili_nakit_akış_tek_vardiya.xlsx (orijinal) | 68bd56bf0e8b2ff4… | 362.040 B | parsed | 42 |
| …_TEMİZ.xlsx (onarılmış türev) | (raporda) | 315.861 B | parsed | 43 |
| …_TEMİZ-4.xlsx (bozuk yükleme) | (raporda) | 315.861 B | **failed** — no valid XLSX/ZIP signature (all zero bytes) | — |

## Classification result (spike, no silent discard)

Original: loan_calculation 1 · capacity 1 · machine_roi 1 · payment_day_matrix 1 · checks 1 · cost_model_overtime 1 · cost_model_normal 1 · monthly_cashflow 35. TEMİZ adds `DEĞİŞİKLİK NOTLARI` → unknown (listed, ignorable-with-record).

## Sheet families (unchanged from v2, now confirmed)

- **faiz hesaplama** — principal 1.500.000 · 48 taksit · %3,63 · ilk ödeme 2024-10-18 · PMT taksit ≈71.744 · BSMV/KKDF %10 · amortisman satırları 14..105.
- **ödeme tablosu** — A adı · B..AF = gün 1..31 (X işaretleri) · AG tutar adayı · A1:AG30.
- **ÇEKLER** — tarih/seri/kime/kimden/banka(HALK-DENİZ-VİNOV)/işaretli tutar · A1:I144.
- **kapasite** — 2023 TL/dk oranları (C1 freze, C2 torna) · verim B3=0,75 · parça satırları 10..113 · toplam I8≈18,57M · A1:P219.
- **maliyet-mastechnic / -mesaili** — normal ve mesaili sabit maliyet + başabaş modelleri · 96 satır.
- **tablo** — makine/ROI/vergi + **kişisel giderler karışık** (ev, tiyatro, harçlık) · A1:BV49 · needs_review.
- **aylık nakit akış ×35** — mayıs 2026 → mart 2029, karışık büyük/küçük harf; şablon hücre haritası import-mapping.md §4.

## Anomalies register (import edilirken mapping_reviews'a düşecekler)

1. ödeme tablosu: MAS TELEFON TİJEN tutarı **−60.000** (negatif).
2. ödeme tablosu: **AG25 = 120.000 etiketsiz** tutar.
3. ödeme tablosu: MAS ALARM-PRONET satırında **gün işareti yok**.
4. ödeme tablosu: telefon satırlarında 45k/90k — AG hizalama şüphesi.
5. ÇEKLER: AKR −45.000 ve çağdaş −100.000 **ardışık çift kayıt** görünümü.
6. Aylık sekmeler: satır 17 **etiketsiz yan takip**; J19 etiketi 3,5M↔2,8M gidip geliyor.
7. Orijinalde devir zinciri kırıkları (haziran 2026, ARALIK 2028→EKİM) ve K17:K21 zincir hataları — TEMİZ'de onarıldı; importer yine de continuity_break doğrulaması yapar.
8. EKİM 2028+ H18 (ÜCRET) donmuş referans `='ağustos 2028'!H18`, Şubat 2029'da ×1,25.
9. kapasite oranları 2023 tarifesi — stale_rate.
10. tablo sekmesi kişisel/şirket gider karışımı — personal_data_mixed.

## Mapping recommendation

Katman akışı: `source_workbooks/sheets/cells/import_rows` → yukarıdaki anomaliler `mapping_reviews` → onaylılar `payments`, `payment_instances`, `cashflow_months/lines`, `checks`, `loans/loan_installments`, `production_parts`, `capacity_models`, `cost_models`, `machine_roi_snapshots`. Kural detayları: `docs/import-mapping.md`.
