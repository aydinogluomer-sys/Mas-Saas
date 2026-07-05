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
| api.telegram.org erişilemez | Medium | Reminder motoru deterministik + delivery log; gönderim testleri mock fetch ile |
| Kaynak xlsx'ler repo dışı (data/ gitignored) | Low | Gizlilik: finansal ham veri commit edilmez; sha256 kanıtı raporda |
| Bulut DB hedefi belirsiz (4 ilgisiz proje) | Medium | Faz 1 lokalde doğrulandı; kullanıcı hedef seçince MCP apply_migration ile uygulanır |
| Kalem düzenlemesi mevcut ay kayıtlarını geriye dönük değiştirmiyor | Low | Bilinçli tasarım (audit bütünlüğü); ay-içi değişiklik instance-tutar girişiyle |
| /radar GET'inde ensureWindow (idempotent yazma) | Low | Tek operatör MVP kabulü; çok kullanıcıda cron'a taşınır (Faz 6) |
| RSC streaming metni böldüğü için curl-grep smoke yanıltıcı olabilir | Low | Sayısal kanıt phaseN-verify'da; smoke payload-farkındalıklı |
| /cashflow GET'i continuity+snapshot yazar (idempotent) | Low | Radar'la aynı tek-operatör kabulü; Faz 6'da cron |
