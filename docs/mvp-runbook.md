# MAS Nakit Radar — MVP Runbook

> **WAVE 0 (2026-10-28) — DOCKER KALDIRILDI.** `docker-compose.yml` ve `scripts/deploy/*.sh`
> silindi; bu belgedeki docker komutları ARTIK GEÇERSİZ. Veritabanı:
> [`ops/postgres-service.md`](ops/postgres-service.md) · günlük yedek:
> [`ops/backup-schedule.md`](ops/backup-schedule.md).

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

## Kurulum (yerel dev)

```bash
# PostgreSQL 16 (Docker container mas-radar-pg, 127.0.0.1:5432) — scripts otomatik ayağa kaldırır
pnpm install
bash scripts/db/dev-reset.sh     # migrations 0001-0011 + seed
# Gerçek veri (gitignore'lu): data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx
pnpm dev                          # http://localhost:3000
```

## Yerel özel production (Option A)

Kalıcı volume + build + serve için: **`docs/local-production-deploy.md`**.

```bash
cp .env.example .env.local        # DATABASE_URL + (ops.) TELEGRAM_*
bash scripts/deploy/local-start.sh   # compose up + ilk-kurulum + build + start
# ilk (ve tek seferlik) admin hesabı — parola argv'den DEĞİL, maskeli girişten ya da
# SEED_ADMIN_PASSWORD ortam değişkeninden okunur:
npx tsx scripts/db/seed-admin.ts --username omer --display-name "Ömer"
npx tsx scripts/db/seed-system-actor.ts   # otomatik araçların denetim kimliği (bir kez)
bash scripts/deploy/backup-db.sh mas_radar_dev              # yedek → backups/ (gitignore)
bash scripts/deploy/restore-db.sh <dump> mas_radar_restored # taze DB'ye geri yükle
```

Sağlık/sürüm: `GET /health` (DB erişilebilirlik, secret yok), `GET /version` (commit/build, secret yok).

Ortam değişkenleri (tümü server-only): `DATABASE_URL` (zorunlu), `SEED_ADMIN_PASSWORD` (ops., yalnız
ilk admin bootstrap'ı için), `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (ops. gönderim),
`APP_COMMIT_SHA`/`APP_BUILD_TIME` (ops. /version). `.env.local`, `data/`, `backups/` git dışı.

### Kimlik doğrulama (P0-A)
Gerçek çok-kullanıcılı auth: adlandırılmış hesaplar (`public.users`), argon2id parola özeti,
admin/operatör rolleri, DB-destekli oturum (rastgele opak token; DB'de yalnız SHA-256'sı durur),
5 hatalı girişte 15 dk kilit. `src/middleware.ts` **default-deny** matcher'ı `/login`, `/health`,
`/version` dışında her rotayı kapsar — sonradan eklenen rotalar otomatik korunur.
Hesap yönetimi uygulama içinde: **`/system/security`** (yalnız admin) — kullanıcı oluşturma,
parola sıfırlama, rol değiştirme, pasifleştirme, kilit açma; hepsi audit'li. Parola hiçbir zaman
denetim kaydına yazılmaz. En az bir aktif admin kalması DB constraint trigger'ı ile zorunludur.

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
