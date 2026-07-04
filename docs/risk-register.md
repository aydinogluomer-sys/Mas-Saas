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
