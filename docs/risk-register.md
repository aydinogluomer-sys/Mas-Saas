# Risk Register

| Risk | Severity | Mitigation |
|---|---:|---|
| Excel source is corrupt/unreadable | Critical | Re-export valid XLSX; import parser must store failed status clearly |
| Null amount accidentally treated as zero | Critical | DB and UI rule: null = unknown; tests required |
| Duplicate monthly instances | High | Unique/idempotent generation by payment_id + instance_month |
| Reminder duplicates | High | Unique delivery key by instance + rule + channel |
| Service role key leaked to client | Critical | Server-only env and route handlers only |
| Payment marked paid without audit | High | All mutations write audit_events |
| AI changes financial data | Critical | AI is commentary-only, no mutation access |
| Scope creep into public SaaS | High | CLAUDE.md explicitly blocks billing/tenant/landing features |
| Over-polished UI before data correctness | Medium | Finish Phase 1–3 before UI polish |
| OCR/import automation delays MVP | Medium | Manual mapping first; OCR later |
| shadcn CLI (ui.shadcn.com) bu ortamdan erişilemez | Medium | Radix paketleri npm'den kurulur, shadcn bileşenleri elle vendorlanır (Faz 2+) |
| supabase.co ağı konteynerden erişilemez | High | Migration doğrulaması lokal PostgreSQL'de; buluta uygulama Supabase MCP veya kullanıcı CLI'ı ile |
| api.telegram.org erişilemez | Medium | **Phase 6B:** Transport arayüzü + mockTransport ile test; telegramTransport token yoksa/erişilemezse fırlatmaz→'failed' loglar; phase6b-verify success+failure yollarını mock ile kanıtlar |
| Telegram token client'a sızması | Critical | Token yalnız server-only env (TELEGRAM_BOT_TOKEN/CHAT_ID); transport.ts client'a import edilmez; token asla payload/log/mesaja yazılmaz |
| Aynı hatırlatmanın tekrar gönderilmesi | High | reminder_deliveries unique(reminder_id,entity,scheduled_for) + ON CONFLICT do nothing; 'sent' yeniden gönderilmez; phase6b-verify DB-unique + idempotent dispatch kanıtı |
| Bilinmeyen tutarlı kalem eşik filtresiyle sessizce atlanır | Medium | thresholdPasses: min_amount varsa bile null tutar HARİÇ TUTULMAZ (bilinmeyen büyük olabilir); yalnız bilinen-düşük tutar filtrelenir; birim test |
| Kaynak xlsx'ler repo dışı (data/ gitignored) | Low | Gizlilik: finansal ham veri commit edilmez; sha256 kanıtı raporda |
| Bulut DB hedefi belirsiz (4 ilgisiz proje) | Medium | Faz 1 lokalde doğrulandı; kullanıcı hedef seçince MCP apply_migration ile uygulanır |
| Kalem düzenlemesi mevcut ay kayıtlarını geriye dönük değiştirmiyor | Low | Bilinçli tasarım (audit bütünlüğü); ay-içi değişiklik instance-tutar girişiyle |
| /radar GET'inde ensureWindow (idempotent yazma) | Low | Tek operatör MVP kabulü; çok kullanıcıda cron'a taşınır (Faz 6) |
| RSC streaming metni böldüğü için curl-grep smoke yanıltıcı olabilir | Low | Sayısal kanıt phaseN-verify'da; smoke payload-farkındalıklı |
| /cashflow GET'i continuity+snapshot yazar (idempotent) | Low | Radar'la aynı tek-operatör kabulü; Faz 6'da cron |
| Geliştirme Windows'a taşındı; PostgreSQL artık Docker (`mas-radar-pg`) | Low | `scripts/db/*.sh` docker exec'e uyarlandı, davranış birebir; container restart-unless-stopped; verify ×reset idempotent |
| GERÇEK TEMİZ.xlsx (43 sekme) bu makinede yok; iki TEMİZ-4 indirmesi sıfır-bayt bozuk | High | Kod ÇEKLER/faiz-özdeş orijinalle dry-run edildi (ALL PASS); import:real/phase3/phase4/phase5 gerçek gate'i TEMİZ gelince çalışır, öncesinde commit yok |
| Çek karşı-tarafı seed'de yoksa isim kaybı riski | Low | 0009 counterparty_label ham KİME/KİMDEN saklar; parti sessiz YARATILMAZ (Phase 4 deseni), FK insan bağlayana dek null |
| Kredi taksit vadeleri kaynakta satır-tarihi taşımıyor | Medium | first_payment_date'ten deterministik türetim (aynı gün + kısa-ay kırpma); scheduleDueDates birim-test + phase5-verify DB cross-check |
| faiz hesaplama F1 "kredi taksit sayısı"=25 ≠ B5 vade=48 | Medium | loan_field_ambiguous review (insan kararı); çözülene dek kredi aktarılmaz — sessiz varsayım yok |
| Banka adı Türkçe uppercase round-trip'i eşleşmeyi bozuyor (DENIZ→denız) | Low | Banka tokenları ASCII lowercase ile eşlenir (bankPartyId); phase5-verify bank-resolved sayısını doğrular |
| Rapor/AI katmanının mali kaydı değiştirmesi (kaynak-of-truth ihlali) | Critical | Rapor engine yalnız reports+audit'e yazar; phase6-verify before==after fingerprint ile hiçbir mali tablonun değişmediğini kanıtlar; AI yalnız prompt-string üretir, model çağrılmaz, promptta update/insert/delete yasak |
| "Bugün" UTC hesaplanırsa Istanbul gece yarısında yanlış gün | Medium | istanbulDateISO (Europe/Istanbul, en-CA) + phase6-verify tz sınır testi; raporlar/eligibility Istanbul tarihi kullanır |
| Borç-servisi projeksiyon penceresi dışında (taksitler 2024-10'dan) | Low | Overlay yalnız cashflow ay aralığına bindirilir; pencere dışı borç gösterilmez (kasıt); phase6-verify overlay-yönlü SQL cross-check |
| Kapasite parça bloğu gruplar/boşluklarla bölünmüş → sessiz parça atlama | High | extractCapacity gap-toleranslı (quantity=parça, başlık/boşluk atla, 20-satır boşlukta bitir); phase7-verify talep=kaynak G5+H5 birebir ile 68 parçanın tamamının yakalandığını kanıtlar |
| Üretim analitiğinin muhasebe gerçeği sanılması | High | /production disclaimer "Analitik tahmindir; muhasebe gerçeği değildir."; çıktılar analitik etiketli; ROI needs_review; stale-rate bayraklı |
| Kapasite 2023 tarifesi eski (stale-rate) | Medium | rate_year + is_stale_rate kolonu + mapping_review(stale_rate); UI stale rozeti; kullanıcı güncelleyene dek "tahmin" |
| Makine ROI kişisel/şirket veri karışımı (tablo sekmesi) | High | machine_roi_snapshots confidence default needs_review; tablo sekmesi otomatik map edilmez; ROI insan onayı olmadan dashboard'a güvenilir girmez |
| Parça işlem süresi eksikse maliyet 0 sanılabilir | Medium | partProfitability: torna+freze ikisi de null→missing_operation_time bayrağı + confidence needs_review + maliyet/marj NULL (asla 0); phase7-verify null-kalır kanıtı |
| Üretim analitiği mali kaydı değiştirir | Critical | Engine yalnız üretim tablolarına+audit'e yazar; phase7-verify finance fingerprint before==after (payments/cashflow/checks/loans/reminders/reports değişmez) |
| Senaryo motoru baseline'ı/mali kaydı değiştirir | Critical | Read-only engine; baseline cashflow OKUNUR, yalnız scenario_* + audit'e yazılır; phase8-verify baseline row-hash + tüm mali/üretim tablo fingerprint before==after; silme yalnız scenario_* cascade |
| Senaryo çıktısının muhasebe gerçeği sanılması | High | /scenarios disclaimer "Senaryo çıktısı tahmindir; muhasebe gerçeği değildir. Kaynak kayıtları değiştirmez."; her run confidence (belirsiz-ay oranına göre); varsayımlar açık beyan |
| Senaryo belirsiz tutarı 0 sayar / gecikmede tutar uydurur | High | applyScenario: null gelir/gider ölçeklenmez (null kalır, closing null); gecikme yalnız zamanlamayı kaydırır, tutar korunur; phase8-verify null-handling + delay-timing kanıtı |
| Senaryo varsayımı gizli/örtük kalır | Medium | scenario_assumptions tablosuna açık satır + run.assumptions jsonb; UI "VARSAYIMLAR (açık beyan)" paneli |
