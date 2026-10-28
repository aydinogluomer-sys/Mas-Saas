# PHASE 4 — Import V2 Product Flow (2026-09-13)

Dal: `feature/standard-import-v2`, commit'ler `c6b16d0` (akış) → `30489af` (canlı kanıt + iki düzeltme) → `aa61115`.
Rota: `/data/imports/v2` · şablon: `/data/imports/v2/template` · Veri Merkezi sekmesi "Standart aktarım (V2)".

## 4.6 Kabul tablosu

| Kabul | Kanıt | Sonuç |
|---|---|---|
| DOWNLOAD_TEMPLATE | canlı: operator → 200, `application/vnd.openxmlformats…sheet`, `Content-Disposition: attachment; filename="MAS_Nakit_Radar_Standart_Import_v2.xlsx"`, `X-Template-SHA256 = f965a1ba…` = gövdenin sha256'sı; iki indirme byte-aynı; viewer/approver → **403** | PASS |
| UPLOAD | canlı: fixture (21 KB) yüklendi, `serverActions.bodySizeLimit=52mb` (uygulama sınırı 50 MB açık mesajla) | PASS |
| SCHEMA_DETECTION | canlı: `_MAS_META`'sız çalışma kitabı → `NOT_V2_SCHEMA`; fixture → "şema MAS_NAKIT_RADAR_STANDARD_IMPORT v2 · şablon 2.0.0" | PASS |
| PREVIEW | canlı: sayaçlar YARATILACAK/GÜNCELLENECEK/İNCELEME/REDDEDİLECEK/BELİRLENEMEDİ (fixture: 34/0/3/12/2; ikinci geçiş 0/34/…); listeler DESTEKLENMEYEN ALANLAR, TRY-DIŞI FİNANS KAYITLARI, MÜKERRER ŞÜPHELİLER, MISSING REQUIRED FIELD; **önizleme hiçbir şey yazmadı** (bağımsız bağlantıyla before == after) | PASS |
| REVIEW | `mapping_reviews` kullanılır (mapper openReview); fixture için 16 inceleme açıldı; `/data/reviews` bağlantısı | PASS |
| CONFIRM_IMPORT | canlı (finance_manager): ONAYLA → `source_workbooks +1`, `import_rows +54` (= okunan satır), domain kayıtları yazıldı | PASS |
| TRANSACTIONAL_WRITE | service.test: begin → INSERT hata → **rollback**, commit yok, bağlantı bırakıldı; concurrency proof: "hatadan önceki kısmi güncelleme geri alındı"; canlı: operator'ün RLS'e takılan denemesi tam geri alındı (aşağıda) | PASS |
| PROVENANCE_VISIBLE | canlı: sonuç panelinde workbook id + sha256 + dosya + zaman; `source_workbooks.file_sha256` = ekrandaki sha; `audit_logs` `import_v2_map` satırı: `actor = imported_by`, `after_data.fileSha256` = sha, `schema`; mapped satırların hepsi `mapped_entity_id` taşıyor (orphan 0) | PASS |
| RBAC | sayfa: `requireRouteAccess` (16. korumalı rota; 5×16 tablo, 10 ret); eylem: `canPerform(import_workbook_v2)` bağımsız; route: 401/403; canlı: viewer/approver sayfa reddi + sekme yok + 403. **Katman × sayfa**: operator referans-sınıfı sayfaları (ürün/proje/hesap/makine/parça) yazamaz → önizlemede "YETKİ DIŞI SAYFALAR", onay `FORBIDDEN_SHEETS` ile DB'ye gitmeden durur (canlı, DB değişmedi) | PASS |
| FILE_SAFETY | >50 MB red, >100k satır red (parse'tan önce), yalnız .xlsx, path traversal/`..`/kontrol karakteri **reddedilir**, ZIP olmayan/bozuk arşiv temiz red, formül asla yürütülmez (values.ts `unwrapCell` yalnız önbellek `result`); canlı: .csv → BAD_EXTENSION, bozuk → CORRUPT_XLSX, DB değişmedi | PASS |

Önizleme ile onayın aynı dosya olduğu **oturum durumuyla değil sha256 ile** kanıtlanır: onay isteği dosyayı yeniden gönderir + önizlemenin sha'sını taşır; eşleşmezse `SHA_MISMATCH`, bağlanılmaz.

## Canlı kanıt ortamı

Üretim derlemesi (`MAS_NEXT_DIST_DIR=.next-v2-verify`, `Compiled successfully`) → `next start :3310` → harcanabilir
PostgreSQL 16.14 `mas_radar_verify_fresh_v2` (0001–0093) → `tests/interaction/import-v2.spec.ts` (Playwright, gerçek
/login ile beş katman) **8/8 GEÇTİ** (41,5 sn). JSON: `docs/release-evidence/standard-import-v2/04-product-flow-interaction.json`.

## Bu kapının yakaladığı iki gerçek hata (kod-yalnız testler yakalayamazdı)

1. **React 19 form sıfırlama.** `<input type=file>` önizleme formunun içindeydi; eylem bitince React formu sıfırlar,
   ONAYLA tıklanınca dosya yoktu ve **hiçbir şey olmuyordu** (sessiz başarısızlık). Dosya artık React durumunda ve
   formların dışında; her form gönderilirken gizli alanına takılır.
2. **Operator + referans verisi.** Operator fixture'ı onayladı → `products` RLS (reference: operator READ) → `WRITE_FAILED`
   + tam rollback. Doğru sonuç, yanlış zaman: yetki artık **önizlemede** sayfa adıyla ve gereken katmanla söyleniyor,
   onay veritabanına gitmeden duruyor. Karar aynı matris (`can()`), ikinci fikir yok.

## Gate

`IMPORT_V2_PRODUCT_FLOW = PASS` (V2 dalında; birleşme sonrası birleşik dalda spec'in yeniden koşması Phase 8 ön koşulu).

## Bilinen sınırlar (açık)

- `bank_accounts_iban_uq`: farklı adla aynı IBAN → 23505 ile tüm import geri alınır (temiz red ama mesaj teknik). Ürün kararı: aynı IBAN'ı mevcut hesaba bağlamak mı, reddetmek mi — phase5-product-decisions §5.3'e eklenmeli.
- `15_MALIYET` (cost) yazıcısı yok — bilinçli (`cost_lines` tasarımı Phase 5, karar bekliyor); satırlar hazırlık katmanına yazılır ve `stagedOnlyFamilies` ile raporlanır.
