# MAS Nakit Radar — Database Schema v2 Summary

See `implementation.md` for complete SQL snippets.

## Raw source

- source_workbooks
- source_sheets
- source_cells
- import_rows
- mapping_reviews

## Shared references

- parties
- categories
- cash_accounts
- settings
- audit_logs

## Payment radar

- payments
- payment_instances
- reminders
- reminder_deliveries
- reports

## Cash-flow radar

- cashflow_months
- cashflow_lines
- cashflow_snapshots

## Financing radar (Phase 5 — active)

- checks — `+counterparty_label` (0009): ham KİME/KİMDEN korunur, parti FK null olsa da isim kaybolmaz. `source_row_id` partial-unique (0008, idempotency). signed→direction + `amount=|signed_amount|` (DB check).
- check_events — mapping'de 'created' olayı yazılır.
- loans — `source_sheet_id` partial-unique (0008). total_payment/total_finance_cost/installment_amount kaynaktan birebir (mutabakat sapmasında bile kaynak kazanır).
- loan_installments — vadeler kaynakta satır-tarihi olmadığından `first_payment_date`'ten TÜRETİLİR (aynı gün + kısa-ay kırpma); `unique(loan_id, installment_no)` idempotent.

## Operations analytics (Phase 7 — active, migration 0010)

- machine_assets — 4 aday seed (Awea/Arion/Sister/Doosan); name unique.
- production_parts — kapasite parçaları; `source_row_id` partial-unique (idempotency); kaynak-satır izli.
- capacity_models — kapasite modeli + Phase-7 kolonları (freze/torna TL/dk, rate_year, is_stale_rate, theoretical_monthly/total_revenue, effective_monthly_minutes); `source_sheet_id` partial-unique.
- cost_models — normal/mesaili; break_even_tl_per_min (=aylık maliyet÷etkin dk, kaynak G6 birebir), effective_monthly_minutes; `source_sheet_id` partial-unique.
- part_profitability_runs — `unique(part_id, cost_model_id)`; süre-eksik→confidence needs_review + maliyet NULL.
- machine_roi_snapshots — `confidence` **default needs_review** (tablo sekmesi kişisel/şirket karışık; insan onayı olmadan güvenilmez); `unique(machine_asset_id, snapshot_year)`.

**Analitik-only:** bu tablolara yazım payments/instances/cashflow/checks/loans/reminders/reports'u DEĞİŞTİRMEZ (phase7-verify before==after). Stale-rate (2023) ve missing-operation-time bayraklıdır, sessizce düzeltilmez.

## Scenario engine (Phase 8 — active, migration 0011)

- scenarios — senaryo tanımı (name, scenario_type, baseline_label/month_count).
- scenario_runs — bir çalıştırma + özet metrikler (final baz/senaryo/Δ, ilk negatif baz/senaryo, en kötü ay/bakiye, maks nakit açığı, toparlanma ayı, güven, açık `assumptions jsonb`).
- scenario_run_lines — ay-bazlı baz vs senaryo (income/expense/closing + Δ); `unique(run_id, month_start)`.
- scenario_assumptions — **açık beyan** edilen varsayım satırları (key/value/unit/description).
- scenario_comparisons — metrik-bazlı baz/senaryo/Δ; `unique(run_id, metric)`.

**Salt-okunur:** senaryo motoru baseline'ı (cashflow_months) ve tüm mali/üretim tablolarını OKUR, yalnız scenario_* + audit_logs'a yazar (phase8-verify baseline row-hash + fingerprint before==after). Silme yalnız scenario_* cascade.

## Core invariants

- Null amount is unknown, not zero.
- Negative signed amount is contextual.
- Paid status requires paid_at.
- Every mapped record should preserve source workbook/sheet/row where possible.
- Monthly cash-flow continuity must be validated.
- AI is commentary only.

## Phase 1 additions (designed here, verified locally)

- **settings**(key pk, value jsonb, description, updated_at) — eşikler + timezone.
- **audit_logs**(actor→auth.users, action, entity_table, entity_id, before_data, after_data) — her mutasyon izlenebilir.
- **reminders**(target_kind: payment_instance|check|loan_installment, offset_days 7/3/1/0/−1, channel, min_amount, unique(target_kind,offset_days,channel)) — **Phase 6B aktif** (payment_instance kuralları).
- **reminder_deliveries** — **Phase 6B aktif**: scheduleReminders 'pending' yazar (unique(reminder_id, entity_table, entity_id, scheduled_for) → duplicate önleme DB'de), dispatchPending her denemeyi satıra loglar (sent+sent_at | failed+error). Telegram token server-only env; gönderim mali kaydı değiştirmez.
- **reports**(report_type: daily|weekly|monthly|strategic|data_quality, period, body_md, meta) — **Phase 6A aktif**: daily/weekly/monthly snapshot'ları yazılır; `meta.commentary_prompt` = AI yorum prompt string'i (model çağrılmaz). Rapor üretimi mali tablolara **hiçbir yazma yapmaz** (before==after fingerprint, phase6-verify).

Schema hardening beyond spec snippets: `payment_instances` idempotency partial-unique (payment_id, instance_month); `instance_month`/`month_start` first-of-month check'leri; `checks.amount = |signed_amount|` tutarlılığı; `loan_installments` paid⇒paid_at; updated_at trigger'ları; sorgu indexleri. Faz 5 eki (0008/0009): `checks.source_row_id` + `loans.source_sheet_id` partial-unique (mapping idempotency, DB-seviyesinde kanıtlı); `checks.counterparty_label`. Dashboard view'ları ihtiyaç duyan dikey dilimle birlikte (slicer kuralı).

## Roller ve RLS modeli (Faz 15, migration 0035)

İki veritabanı rolü vardır ve bu ayrım RLS'in çalışması için şarttır:

- **`mas_radar_app`** — Next.js runtime'ının bağlandığı rol (`DATABASE_URL`). `NOSUPERUSER`,
  `NOBYPASSRLS`. `authenticated` rolüne üyedir; policy'ler rol **üyeliği** üzerinden eşleştiği
  için 0007'nin `to authenticated` politikaları bu role uygulanır.
- **`postgres`** (owner) — yalnız şema/rol/seed değiştiren script'ler (`MIGRATION_DATABASE_URL`).

Faz 15'ten önce tek rol vardı (`postgres`) ve PostgreSQL superuser'ları RLS'i **her zaman**
bypass ettiği için buradaki politikaların hiçbiri fiilen devrede değildi.

Politika modeli:

- Çoğu public tablosunda: RLS enabled + `to authenticated using(true) with check(true)`
  (tek-operatör modu, CLAUDE.md).
- **İstisna — `schema_migrations`**: RLS açık, policy yok, `revoke all ... from authenticated`
  (0020 + 0035). Ledger yalnız owner'a aittir.
- **İstisna — `users` / `sessions`**: 0031'in `users_deny_all` / `sessions_deny_all`
  (`using(false)`) politikaları duruyor; 0035 bunların yanına `mas_radar_app` hedefli
  `users_app_runtime` / `sessions_app_runtime` (`using(true)`) ekler. PERMISSIVE politikalar
  OR'landığı için uygulama kendi auth tablolarına erişir, `authenticated`'ın diğer üyeleri
  erişemez. Bu ek olmadan giriş yapmak imkânsız olurdu.
- **İstisna — `audit_logs`**: ek REVOKE yok; 0022'den beri BEFORE trigger'larla append-only.
- `TRUNCATE` hiçbir tabloda `authenticated`'e verilmez. Uygulama hiç TRUNCATE kullanmaz;
  yalnız operatör/gate script'leri kullanır ve onlar owner bağlantısıyla çalışır.

**Bilinen açık:** 0007'nin döngüsü yalnız o an var olan tabloları kapsadığı için sonradan
eklenen 11 tabloda RLS hiç açılmamıştır (`capacity_models`, `cost_models`, `machine_assets`,
`machine_roi_snapshots`, `part_profitability_runs`, `production_parts`, `scenario_assumptions`,
`scenario_comparisons`, `scenario_run_lines`, `scenario_runs`, `scenarios`). Bunlarda erişimi
yalnız GRANT'ler yönetir; kırılma değil, savunma derinliği eksiğidir. Faz 15 kapsamına
alınmadı, ayrı bir dilim olarak kapatılmalıdır.

## Migration ledger (P0-C, migration 0020/0021)

- **schema_migrations**(version pk, name, checksum, applied_at, applied_by) — hangi `supabase/migrations/*.sql` dosyasının hangi checksum ile uygulandığını izler. `applied_by`: `baseline-backfill` (0001-0019, `scripts/db/legacy-baseline-0019.json` manifest'i ile doğrulanıp yalnız kayıt edildi, SQL'i tekrar çalıştırılmadı) veya `migrate-script` (gerçekten çalıştırıldı). RLS açık, `authenticated`'e policy verilmez (0007'nin blanket-authenticated döngüsünden istisna) — `revoke all ... from public, anon, authenticated`.
- Runner: `scripts/db/migrate.ts` (`npm run db:migrate`) — dört durumlu state machine (EMPTY / LEGACY_COMPLETE / LEDGER_MANAGED / LEDGER_EMPTY_RECOVERY), tek advisory lock, checksum her zaman yeni SQL'den önce doğrulanır, var olan DB'ye pending migration'ları atomik+yedekli uygular. `scripts/db/migrate-verify.ts` (`npm run db:migrate:verify`) disposable DB'lerde 8 senaryoyu doğrular.
- `mas_radar_dev` 2026-07-18'de `LEGACY_COMPLETE` yoluyla migre edildi: 0001-0019 backfill, 0020-0021 gerçek çalıştırma, 21 satır, veri değişmedi (payments=19, cashflow_months=35, checks=7).

## Kayıt bütünlüğü ve yaşam döngüsü sertleştirmesi (migration 0022-0034)

Bu bölüm Faz 18'de yazıldı: belge ~0021'de donmuştu, oysa 0022-0034 arası on üç migration
şemanın mali güvenlik davranışını belirleyen kısmını ekledi. Kronolojik değil, konu bazlı.

### Denetim izi dokunulmazlığı (0022)

- **audit_logs append-only.** `revoke update, delete, truncate` savunma derinliği; asıl
  zorlayıcı `public.audit_logs_block_mutation()` BEFORE trigger'ları — UPDATE/DELETE/TRUNCATE
  **superuser için de** reddedilir. Bu yüzden denetim izi yalnız tek yönde yanlış olabilir:
  satır en baştan hatalı yazılmışsa. Faz 18'in `src/lib/audit.ts` konsolidasyonunun sebebi bu.
- Migration idempotent (0020/0021 konvansiyonu, `LEDGER_EMPTY_RECOVERY` için şart).

### Arşiv yaşam döngüsü (0023, 0024)

- **0023 — arşiv tutarlılığı** altı tabloda `NOT VALID` CHECK ile: `payments` için
  `status='archived'` ⇔ `archived_at` ⇔ `archive_reason` ⇔ `archived_by_label`. Ön kontrol
  (2026-07-18, gerçek `mas_radar_dev`) sıfır ihlal buldu; **VALIDATE bilerek ayrı bir dilime
  bırakıldı** — ev kuralı: constraint ekleyen migration onu aynı anda doğrulamaz.
- **0024 — arşivlenmiş kayıt dokunulmazlığı** trigger'ları: herhangi bir arşiv sinyali taşıyan
  satır dondurulur; tek istisna eksik arşiv meta verisinin sonradan tamamlanması ("legacy
  metadata completion"). **Arşivden çıkarma yolu YOK** — kayıt yeniden açma kapsam dışı ve
  kısmi bir UPDATE ile sessizce olmamalı. `updated_at` muaf (`set_updated_at()` sahibi).

### Ödeme kalemi alan tutarlılığı (0025, 0028, 0029)

- **0025** — `paid_at`/`paid_amount` yalnız `paid`/`partial` statülerinde bulunabilir
  (zorunlu değil, izinli); diğer her statüde ikisi de null olmalı. 0003'ün
  `paid_requires_paid_at` ileri yönünü tamamlar, ona dokunmaz. `loan_installments`'ta
  `paid_amount` kolonu yok (0005), yalnız `paid_at`.
- **0028 — `payment_instances.amount_source`** (`generated` / `manual` / `legacy_unknown`):
  bir kalemin tutarının şablonundan otomatik mutabakata **güvenli** olup olmadığını sınıflar.
  Mevcut satırlar ayırt edilemediği için muhafazakâr `legacy_unknown` varsayılanına düşer,
  asla `generated`'a değil. Migration `add column if not exists`le yetinmez: kolonun diskteki
  gerçek tanımını (tip, nullability, default) doğrular ve yanlışsa **yüksek sesle** durur.
- **0029** — 0028'in CHECK'ini VALIDATE eder. Doğrulamadan önce constraint'in *doğru* olanı
  olduğunu (tablo, `contype='c'`, beklenen ifade) teyit eder; yanlışlıkla aynı adı taşıyan
  farklı bir constraint asla sessizce onaylanmaz. Bu fail-closed deseni 0030/0032'de tekrarlanır.

### İptal (cancellation) meta verisi (0026, 0030)

- **0026** — statü enum'unda `cancelled` bulunan üç tabloya (`payment_instances`, `checks`,
  `loan_installments`) `cancelled_at` + `cancel_reason` ekler; çift yönlü tutarlılık +
  boş-olmayan gerekçe CHECK'i, `NOT VALID`. `payments`/`loans` hariç — enum'larında
  `cancelled` yok.
- **0030** — 0026'nın üç CHECK'ini VALIDATE eder. Arada Faz 5'in legacy-repair'i, `NOT VALID`
  ile grandfather edilmiş tek ihlalli satırın (`77815c3d-…`) meta verisini geri doldurdu.

### Statü geçiş guard'ları (0027, 0033, 0034) — bu deponun en pahalı dersi

- **0027** üç ayrı, tabloya özgü trigger fonksiyonu kurar (tek paylaşılan fonksiyon DEĞİL —
  böylece hiçbir tablonun izin listesi kendisi için geçersiz bir statü sabitine atıfta
  bulunamaz). Yalnız `status` kolonunu korur; satırın kalanını kilitlemez. Aynı-statü
  güncellemeleri her zaman no-op. `loans`'ta trigger yok (enum'unda `cancelled` yok).
- **0027 izin listeleri EKSİK ÇIKTI ve bu üretimde gerçekten kırdı:**
  - `checks` ve `loan_installments` yalnız `planned → cancelled` ile açıldı. Oysa
    `checks.status` 0005'ten beri `cleared`/`bounced`, `loan_installments.status` `paid`/`late`
    kabul ediyordu. Sonuç: **hiçbir çek tahsil/karşılıksız, hiçbir taksit ödenmiş olarak
    kaydedilemedi.** Gerçek `mas_radar_dev`'de 7/7 çek ve 48/48 taksit `planned`de sıkıştı;
    `financing/engine.ts`'in `paid_count` KPI'ı Faz 5'ten beri 0 döndürdü. **0034** düzeltti.
  - `payment_instances` için `→ partial` girdileri hiç eklenmemişti; `markInstancePartial` ve
    onu besleyen UI, 0027'den beri **hiçbir** kalemde kısmi ödeme kaydedemiyordu.
    `scripts/seed-demo.ts` taze bir DB'de bunu yakaladı. **0033** düzeltti
    (`unpaid`/`planned`/`late` → `partial`; `paid → partial` bilinçli olarak eklenmedi).
- **Ders (implementation.md §17 kural 3):** yaşam döngüsü olan her yeni entity, izin listesini
  CHECK/enum ile AYNI migration'da ve **eksiksiz** kurmalıdır. Bu genel bir temkin değil, bu
  depoda sekiz migration boyunca sürmüş gerçek bir veri kaybı sınıfıdır.

### Kimlik ve aktör (0031, 0032)

- **0031** — `public.users` + `public.sessions`. Ayrıca `users_deny_all` / `sessions_deny_all`
  (`using(false)`) politikaları; bunlar uygulamanın superuser olduğu varsayımıyla yazılmıştı ve
  Faz 15 o varsayımı kaldırdığı için orada `mas_radar_app` hedefli `app_runtime` politikalarıyla
  tamamlandı (bkz. yukarıdaki "Roller ve RLS modeli").
- **0032** — "bunu kim yaptı" FK'larının sekizi tek kullanımlık `auth.users` stub'ından gerçek
  `public.users`'a taşınır. `auth.users` stub'ına dokunulmaz. Fail-closed: her constraint'in
  gerçekten `auth.users`'ı hedeflediği ve kolonun canlı DB'de sıfır non-null satır taşıdığı
  önce doğrulanır.

---

## Yeni tablo eklerken checklist (Faz 18'den itibaren zorunlu)

Aşağıdaki beş madde, bu şemanın geçmişte gerçekten kırıldığı beş yerdir. Yeni bir tablo (ya da
yeni bir yaşam döngüsü) eklerken hepsi AYNI migration'da düşünülmeli:

1. **RLS politikası.** Yeni tablo kendi migration'ında blanket `for all to authenticated
   using(true) with check(true)` politikasını almalı. 0007'nin döngüsü yalnız o an var olan
   tabloları kapsadı; sonradan eklenen 11 tabloda RLS hiç açılmadı (yukarıdaki "Bilinen açık").
   Faz 24B gerçek rol-bazlı politikalara geçirene kadar desen budur.
2. **Statü geçiş guard'ı — EKSİKSİZ.** Yaşam döngüsü varsa izin listesi, statü enum'unun kabul
   ettiği HER gerçek geçişi içermeli. 0027 → 0033/0034 dersi: eksik bir izin listesi tabloyu
   sessizce kullanılamaz hale getirir ve aylarca fark edilmez.
3. **`audit()` çağrısı.** Her mutasyon `src/lib/audit.ts`'in tek kanonik `audit()`'ini
   çağırmalı; tabloya özel bir kopya yazılmamalı (`pnpm phase18:verify` bunu zorlar).
   Denetim satırı, tarif ettiği mutasyonla **aynı transaction'da** yazılmalı.
4. **Migration ledger uyumu.** Migration idempotent olmalı (`if not exists` / `create or
   replace`), checksum disiplinine uymalı, ve constraint ekleyen bir migration onu aynı anda
   VALIDATE etmemeli — doğrulama ayrı, açıkça onaylanmış bir dilimdir (0023/0025/0026 → 0029/0030).
5. **Zod sınırı.** Tabloyu yazan her server action/route handler girdisini `src/lib/validation`'ın
   `parseOrThrow`'undan geçirmeli (aksiyon başına bir şema). Ham `ZodError.message` asla
   `DomainError`'a gömülmemeli — Zod v4'te o bir JSON dökümüdür ve `api-response.ts` DomainError
   mesajını istemciye aynen geçirir; `formatIssues` bunun için var.
