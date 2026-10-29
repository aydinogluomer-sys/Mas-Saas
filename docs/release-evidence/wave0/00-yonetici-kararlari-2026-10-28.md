# Dalga 0 — Yönetici kararları (2026-10-28)

**Durum:** ONAYLANDI (sahip, 2026-10-28)
**Kapsam:** CFO yol haritası Dalga 0–5. Bu belge sahibin sekiz kararını, nasıl yorumlandığını ve neye yol açtığını kayda geçirir.
**İlgili:** `implementation.md` §0 ve §17A, `docs/todo.md` (Dalga 0), `01-native-postgres-restore.md`, `02-wave0-kod-karantinasi.md`.

---

## Kararlar

| # | Konu | Karar | Uygulamadaki karşılığı |
|---|---|---|---|
| 1 | Veritabanı konumu | Yerel/kapalı devre PostgreSQL (Windows servisi) tek kanonik veritabanıdır. Supabase bağlantısı devre dışı, `.env.local` yerele sabit, bulut parolası iptal. Bulutta korunacak gerçek iş verisi yok. | Native PostgreSQL 16.14 `C:\MAS` altında kuruldu, gerçek veri geri yüklendi (bkz. `01-…`). Supabase betik ve kod dalları kaldırıldı. Parola iptali ve projenin silinmesi sahipte. |
| 2 | Muhasebe kapsamı | **B — hibrit yönetim defteri** seçildi; ilk adım **C — yalnız okuma**. Yasal defter ve beyanname mali müşavirin programında kalır. | `implementation.md` §0'daki "double-entry accounting sistemi değildir" sınırı daraltıldı: MAS yasal defter değildir, ama çift taraflı bir **yönetim defteri** ve mutabakat fark raporu tutabilir (Dalga 3). |
| 3 | Muhasebe programı | Paraşüt. Ön muhasebe için tek birincil kaynak **Paraşüt API v4**. Mali müşavir mizanı için standart Excel/XML içe aktarımı. | Dalga 4 entegrasyonu Paraşüt'e göre tasarlanacak. ERP köprüsü taslağı (katman 46541d8) kaldırıldı, genişletilmedi. |
| 4 | e-Fatura entegratörü | Ayrı entegratör yok. Fatura verisi Paraşüt API v4'ten (`sales_invoices`, `purchase_bills`). | Dalga 4. |
| 5 | Bankalar | Tek tek banka API'si yok. Paraşüt banka entegrasyonu (`/v4/{company_id}/accounts`, `/transactions`) ve gerektiğinde Paraşüt banka Excel çıktısı. | Dalga 2–4: banka eşleştirme Paraşüt hareketleri üzerinden. |
| 6 | Donanım | Harici yedek diski (`MAS_OFFDEVICE_BACKUP_DIR`) hemen bağlanacak. Hedef 16–32 GB RAM mini sunucu + UPS. Geçişe kadar mevcut makinede native PostgreSQL + otomatik başlayan Windows servisi. | Servis kurulum betiği: `scripts/ops/install-postgres-service.ps1` (sahip bir kez yönetici olarak çalıştırır). Disk takılana kadar harici yedek kapısı bilinçli olarak kırmızı kalır. |
| 7 | Karantina | **Seçici karantina.** Korunanlar: 0095 zorunlu parola değişimi, asenkron V2 import, iş dağıtıcı, salt-okunur Telegram/PWA. Hemen kapatılanlar: girişsiz yazma kapıları, `SET ROLE` hata yutma, uydurma rakamlı zincir ve kokpit, rol-kör önbellek, 60 rota önyüklemesi, `#REF!→0`. | Ön-karantina master `quarantine/pre-wave0-2026-10-28` etiketinde saklı. Uygulama `wave0/stabilize` dalında (bkz. `02-…`). |
| 8 | Bekleyen eski kararlar | **Phase 5:** 40 SOURCE_ONLY_PRESERVED / 9 REMOVED_FROM_FUTURE_TEMPLATE onaylandı. **P24B:** harici doğrulanmış yedekten sonra, `atilla` ve `audit_logs` korunarak yalnız fixture satırlarının silinmesi onaylandı. **Sesli soru:** kapsam dışı, Dalga 5 sonrasına ertelendi. | Phase 5: belgedeki matris 10 REMOVED gösteriyor, uygulamaya bkz. `02-…`. P24B: koşullar sağlanınca (aşağıda). |

## Yorumlar (orkestratör kararları, sahip itiraz edebilir)

Onay listesinde açıkça adı geçmeyen katman özellikleri "seçici karantina" ilkesine göre karantinaya alındı. Hepsi etikette duruyor; istenirse Dalga 1+ içinde incelenip geri alınabilir.

- **Telegram mini-app:** tamamen kaldırıldı. Telegram WebApp'ler herkese açık bir HTTPS adresi ister; bu, kapalı devre kararıyla bağdaşmaz. Salt-okunur görünümler normal web uygulamasında zaten var.
- **Telegram webhook ve onay düğmeleri:** kaldırıldı. Onay düğmeleri yazma yapıyordu, varsayılan bir sırla imzalanıyordu ve webhook da herkese açık HTTPS ister.
- **"Salt-okunur Telegram" olarak kalanlar:** `bot.py` (uzun yoklama, yalnız dışa giden bağlantı) ve `/api/telegram/assistant`. Bu uç, paylaşılan anahtar ve sohbet izin listesi ister; ikisinden biri eksikse kapalı kalır.
- **CFO copilot widget'ı:** karantinaya alındı. Finansal veriyi dış bir yapay zekâ servisine gönderiyordu ve dayanak kontrolü yoktu.
- **Onay "gatekeeper" kuralı:** karantinaya alındı. İncelenmemiş yeni bir iş kuralı.
- **Asenkron V2 import:** yalnız önizleme yapar. Kayıt işleme, mevcut senkron onay akışında kalır; böylece incelenmiş-aktarım kuralı korunur.
- **Görsel restyle:** geri alındı. Yoğunluk kuralı ve 23 ekran görüntüsü tabanı korunsun diye.

## Uygulama sırasında ortaya çıkan düzeltmeler (2026-10-29)

- **P24B zaten yapılmış.** Karar 25 Ağustos tarihli geçiş panosuna dayanıyordu; pano güncel değildi. Kanonik veritabanında hiçbir P24B fixture satırı yok:
  - `p24b%` kullanıcı 0, `7b300bfe…` ödemesi 0, bağlı taksit 0, `p24b` ayarı 0;
  - temizliğin denetim satırı var;
  - kanıt dosyası: `final-production-readiness/p24b-real-cleanup/FINAL-REAL-CLEANUP-DOSSIER.md` ("COMMITTED — 42/42", USB yedeği işlem anında doğrulanmış).

  Karar 8'in P24B kısmında yapılacak iş kalmadı.
- **Phase 5:** Git geçmişi, onaylanan dokuz kolonun hangisi olduğunu belirlemiyor. Belge tek commit'te 40/9 sayımı ve 10 satırlık matrisle birlikte yazılmış. R9'un temkinli kuralıyla şablondan hiçbir kolon çıkarılmadı (şablon 2.0.0 değişmedi). Dokuz kolonu sahip adlandırınca uygulanır.
- **Yapay zekâ çıkışı:** `.env.local`'de `OPENAI_API_KEY` tanımlı ve `AI_FORCE_DETERMINISTIC=0`. İncelenmiş `/insights/ask` yolu karar özetlerini OpenAI'ye gönderebilir. Bu sahibin daha önceki bilinçli ayarı olduğu için değiştirilmedi. Karar 1'deki "kapalı devre" ile çelişip çelişmediği sahibe soruldu.

## Koşullu / bekleyen işler

| İş | Koşul | Sahip eylemi |
|---|---|---|
| Harici yedek (P0-1) | `D:` diskinin takılı olması | Diski takın; günlük yedek (03:00) ya da `pnpm ops:backup:offdevice` kopyalar. O zamana kadar günlük yedek bilerek "çıkış 3" (tek kopya) verir. |
| P24B fixture silme (P0-2) | — | **Yapılacak iş yok** (yukarıda). |
| CI (GitHub Actions) | Hesap faturalama sorunu çözülmeli | GitHub → Settings → Billing & plans. |
| Supabase "Mas-Saas" projesi | Proje duraklatılmış ama silinmemiş | Dashboard'dan projeyi silin ya da veritabanı parolasını sıfırlayın. |
| Windows servisi | Yönetici yetkisi gerekiyor | `install-postgres-service.ps1`'i yönetici PowerShell'den bir kez çalıştırın (`docs/ops/postgres-service.md`). |
| `admin` / `atilla` parolaları | 15 Ekim'de kaynağı belirsiz bir süreçle değişmişler | Etkileşimli terminalde `pnpm exec tsx scripts/ops/rotate-passwords.ts`. Geçici parolalar yalnız sizin ekranınıza yazılır; ilk girişte kendi parolanızı seçersiniz. |
| Phase 5 sayım tutarsızlığı | Belgede 40/9, matriste 10 REMOVED | Şablondan çıkacak dokuz kolonu adlandırın. |
| OpenAI'ye karar özeti gönderimi | Sahip kararı | Kapalı devre isteniyorsa `AI_FORCE_DETERMINISTIC=1`. |
