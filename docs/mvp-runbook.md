# MAS Nakit Radar — MVP Runbook

Özel, tek-şirket / tek-operatör dahili finans-operasyon paneli. Phase 0–8 tamamlandı;
implementation.md §0'daki 7 inşa adımının tamamı bitti.

## Ne yapar (modüller)

| Modül | Route | Ne sağlar |
|---|---|---|
| Ödeme radarı | `/radar`, `/calendar`, `/payments` | Bugün/yarın/7 gün, geciken, eksik tutar, riskli günler, ödeme takvimi, paid/unpaid |
| Nakit akış radarı | `/cashflow`, `/cashflow/[monthId]` | 35 ay devir/gelir/gider/fark/kasa, ilk negatif ay, en kötü ay, konsantrasyon, borç-servisi overlay |
| Finansman radarı | `/financing`, `/financing/loans/[id]` | Çek defteri (işaretli tutar=yön), vade takvimi, banka exposure, kredi+taksit planı |
| Raporlar | `/reports`, `/reports/[id]` | Günlük/haftalık/aylık salt-okunur özet + AI yorum promptu (model çağrılmaz) |
| Hatırlatma | `/reminders` | Eligibility (offset 7/3/1/0/−1, Istanbul tz), teslimat kaydı, mock/Telegram transport (server-only token) |
| Üretim analitiği | `/production` | Başabaş TL/dk, normal vs mesaili, parça kârlılığı, kapasite kullanımı, makine ROI (needs_review) |
| Senaryo motoru | `/scenarios`, `/scenarios/[runId]` | "What-if?" salt-okunur overlay: gelir/gider/gecikme/kapasite/verim/borç-servisi; baz vs senaryo |
| İçe aktarım | `/imports`, `/imports/[id]`, `/reviews` | Ham workbook koruma + sekme sınıflandırma + mapping review + modül aktarım butonları |

## Değişmez ilkeler (tüm modüllerde uygulanır)

1. **Null asla sıfır değildir** — bilinmeyen tutar "TUTAR EKSİK" olarak gösterilir, hesaplara girmez.
2. **Sessiz düzeltme yasağı** — validator'lar bayrak koyar, değer değiştirmez (continuity, reconciliation, stale-rate, missing-op).
3. **Kaynak-of-truth veritabanıdır** — AI yalnız yorum promptu üretir; hiçbir modül AI ile mali kaydı değiştirmez.
4. **Kaynak izlenebilirlik** — her eşlenen kayıt kaynak workbook/sheet/row'a döner.
5. **Read-only analitik/senaryo** — üretim ve senaryo motorları mali tabloları değiştirmez (fingerprint before==after kanıtlı).
6. **Idempotent aktarım** — tüm mapping'ler DB-seviyesinde tekrar-güvenli.

## Kurulum (yerel)

```bash
# PostgreSQL 16 (Docker container mas-radar-pg, 127.0.0.1:5432) — scripts otomatik ayağa kaldırır
pnpm install
bash scripts/db/dev-reset.sh     # migrations 0001-0011 + seed
# Gerçek veri (gitignore'lu): data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx
pnpm dev                          # http://localhost:3000
```

Ortam değişkenleri (opsiyonel, server-only): `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

## Tam gate (commit öncesi)

```bash
pnpm lint && pnpm typecheck && pnpm test    # 138 test
pnpm db:verify                               # şema/kısıt/RLS + 13 assertion grubu
pnpm import:real                             # gerçek TEMİZ staging import
pnpm phase3:verify && pnpm phase4:verify && pnpm phase5:verify
pnpm phase6:verify && pnpm phase6b:verify && pnpm phase7:verify && pnpm phase8:verify
pnpm build
```

Her `phaseN:verify` gerçek TEMİZ verisi üzerinde çalışır ve iddiaları SQL cross-check ile kanıtlar
(mutabakat, idempotency, no-silent-discard, mali bütünlük). Hepsi yeşil olmadan commit atılmaz.

## Bilinen sınırlar (MVP)

- **Bulut yok:** doğrulama tamamen yerel PostgreSQL'de; remote Supabase'e migration uygulanmadı (kullanıcı talimatı).
- **Telegram erişilemez:** bu ortamda api.telegram.org kapalı → gerçek gönderim 'failed' loglar; mock transport ile test edilir.
- **Kapasite oranları 2023 (stale):** kullanıcı güncelleyene dek üretim analitiği "tahmin" etiketli.
- **Makine ROI:** `tablo` sekmesi kişisel/şirket karışık → confidence needs_review, otomatik map edilmez.
- **Senaryo granülerliği:** aylık; müşteri gecikmesi ay bazında kaydırılır (gün→ay yuvarlama).
- **AI yorum katmanı:** yalnız prompt üretir; bağlı bir model çağrısı MVP kapsamında değildir.
- **Tek operatör:** RLS `to authenticated using(true)`; çok-kullanıcı/rol MVP dışı.
