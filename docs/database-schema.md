# MAS Nakit Radar â€” VeritabanÄ± ÅemasÄ± Kanonik ReferansÄ± (`Migration 0125`)

> **Kanonik CanlÄ± Katalog Ã–zeti (`mas_radar_dev` â€” Yerel Windows PostgreSQL 16.14):**
> - **Uygulanan Migration AralÄ±ÄŸÄ±:** `0001..0124` (**`124` migration** â€” `supabase/migrations/*.sql`, `public.schema_migrations` `max(version) = '0124'`)
> - **Tablo SayÄ±sÄ±:** **`132` `public` tablo** (`131` iÅŸ/operasyon/gÃ¼venlik tablosu + `schema_migrations`) + **`1` `auth` tablosu** (`auth.users`) = **`133` toplam tablo** (`0112` ile zombi tablolar emekliye ayrÄ±ldÄ±; `0116..0123` ile grup ÅŸirket/ÅŸube, hazine, tam Ã¼retim, birleÅŸik senaryo, grup iÃ§i eliminasyon, parola sÄ±fÄ±rlama/SSO/yorum, `notification_outbox`, `ops_incidents` ve `user_legal_entities` tablolarÄ± eklendi)
> - **SatÄ±r DÃ¼zeyi GÃ¼venlik (RLS):** **`132 / 132` (`%100`)** `public` tabloda `relrowsecurity = true`
> - **GÃ¶rÃ¼nÃ¼m (View) SayÄ±sÄ±:** **`91` `public` gÃ¶rÃ¼nÃ¼m**, **`91 / 91` (`%100`)** `WITH (security_invoker = true)` ve yazma yetkileri iptal edilmiÅŸ (`0` materialized view; `0124` ile `public.valid_workbook_imports` eklendi)
> - **Mimari TarihÃ§e Notu:** AÅŸaÄŸÄ±daki bÃ¶lÃ¼mler ÅŸemanÄ±n `0001` baÅŸlangÄ±cÄ±ndan `0124` kanonik durumuna evrimini kronolojik olarak belgeler; eski faz baÅŸlÄ±klarÄ±ndaki ara tablo sayÄ±larÄ± (Ã¶rn. Faz 1 `22`, Faz 24B `58`, Faz 59 `106`) tarihsel baÄŸlam iÃ§indir ve gÃ¼ncel canlÄ± gerÃ§ek yukarÄ±daki **`0124` (`132` `public` tablo / `91` gÃ¶rÃ¼nÃ¼m)** Ã¶zetidir.

Tam uygulama fazlarÄ± iÃ§in bkz. `implementation.md`.

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

## Financing radar (Phase 5 â€” active)

- checks â€” `+counterparty_label` (0009): ham KÄ°ME/KÄ°MDEN korunur, parti FK null olsa da isim kaybolmaz. `source_row_id` partial-unique (0008, idempotency). signedâ†’direction + `amount=|signed_amount|` (DB check).
- check_events â€” mapping'de 'created' olayÄ± yazÄ±lÄ±r.
- loans â€” `source_sheet_id` partial-unique (0008). total_payment/total_finance_cost/installment_amount kaynaktan birebir (mutabakat sapmasÄ±nda bile kaynak kazanÄ±r).
- loan_installments â€” vadeler kaynakta satÄ±r-tarihi olmadÄ±ÄŸÄ±ndan `first_payment_date`'ten TÃœRETÄ°LÄ°R (aynÄ± gÃ¼n + kÄ±sa-ay kÄ±rpma); `unique(loan_id, installment_no)` idempotent.

## Operations analytics (Phase 7 â€” active, migration 0010)

- machine_assets â€” 4 aday seed (Awea/Arion/Sister/Doosan); name unique.
- production_parts â€” kapasite parÃ§alarÄ±; `source_row_id` partial-unique (idempotency); kaynak-satÄ±r izli.
- capacity_models â€” kapasite modeli + Phase-7 kolonlarÄ± (freze/torna TL/dk, rate_year, is_stale_rate, theoretical_monthly/total_revenue, effective_monthly_minutes); `source_sheet_id` partial-unique.
- cost_models â€” normal/mesaili; break_even_tl_per_min (=aylÄ±k maliyetÃ·etkin dk, kaynak G6 birebir), effective_monthly_minutes; `source_sheet_id` partial-unique.
- part_profitability_runs â€” `unique(part_id, cost_model_id)`; sÃ¼re-eksikâ†’confidence needs_review + maliyet NULL.
- machine_roi_snapshots â€” `confidence` **default needs_review** (tablo sekmesi kiÅŸisel/ÅŸirket karÄ±ÅŸÄ±k; insan onayÄ± olmadan gÃ¼venilmez); `unique(machine_asset_id, snapshot_year)`.

**Analitik-only:** bu tablolara yazÄ±m payments/instances/cashflow/checks/loans/reminders/reports'u DEÄÄ°ÅTÄ°RMEZ (phase7-verify before==after). Stale-rate (2023) ve missing-operation-time bayraklÄ±dÄ±r, sessizce dÃ¼zeltilmez.

## Scenario engine (Phase 8 â€” active, migration 0011)

- scenarios â€” senaryo tanÄ±mÄ± (name, scenario_type, baseline_label/month_count).
- scenario_runs â€” bir Ã§alÄ±ÅŸtÄ±rma + Ã¶zet metrikler (final baz/senaryo/Î”, ilk negatif baz/senaryo, en kÃ¶tÃ¼ ay/bakiye, maks nakit aÃ§Ä±ÄŸÄ±, toparlanma ayÄ±, gÃ¼ven, aÃ§Ä±k `assumptions jsonb`).
- scenario_run_lines â€” ay-bazlÄ± baz vs senaryo (income/expense/closing + Î”); `unique(run_id, month_start)`.
- scenario_assumptions â€” **aÃ§Ä±k beyan** edilen varsayÄ±m satÄ±rlarÄ± (key/value/unit/description).
- scenario_comparisons â€” metrik-bazlÄ± baz/senaryo/Î”; `unique(run_id, metric)`.

**Salt-okunur:** senaryo motoru baseline'Ä± (cashflow_months) ve tÃ¼m mali/Ã¼retim tablolarÄ±nÄ± OKUR, yalnÄ±z scenario_* + audit_logs'a yazar (phase8-verify baseline row-hash + fingerprint before==after). Silme yalnÄ±z scenario_* cascade.

## Core invariants

- Null amount is unknown, not zero.
- Negative signed amount is contextual.
- Paid status requires paid_at.
- Every mapped record should preserve source workbook/sheet/row where possible.
- Monthly cash-flow continuity must be validated.
- AI is commentary only.

## Phase 1 additions (designed here, verified locally)

- **settings**(key pk, value jsonb, description, updated_at) â€” eÅŸikler + timezone.
- **audit_logs**(actorâ†’auth.users, action, entity_table, entity_id, before_data, after_data) â€” her mutasyon izlenebilir.
- **reminders**(target_kind: payment_instance|check|loan_installment, offset_days 7/3/1/0/âˆ’1, channel, min_amount, unique(target_kind,offset_days,channel)) â€” **Phase 6B aktif** (payment_instance kurallarÄ±).
- **reminder_deliveries** â€” **Phase 6B aktif**: scheduleReminders 'pending' yazar (unique(reminder_id, entity_table, entity_id, scheduled_for) â†’ duplicate Ã¶nleme DB'de), dispatchPending her denemeyi satÄ±ra loglar (sent+sent_at | failed+error). Telegram token server-only env; gÃ¶nderim mali kaydÄ± deÄŸiÅŸtirmez.
- **reports**(report_type: daily|weekly|monthly|strategic|data_quality, period, body_md, meta) â€” **Phase 6A aktif**: daily/weekly/monthly snapshot'larÄ± yazÄ±lÄ±r; `meta.commentary_prompt` = AI yorum prompt string'i (model Ã§aÄŸrÄ±lmaz). Rapor Ã¼retimi mali tablolara **hiÃ§bir yazma yapmaz** (before==after fingerprint, phase6-verify).

Schema hardening beyond spec snippets: `payment_instances` idempotency partial-unique (payment_id, instance_month); `instance_month`/`month_start` first-of-month check'leri; `checks.amount = |signed_amount|` tutarlÄ±lÄ±ÄŸÄ±; `loan_installments` paidâ‡’paid_at; updated_at trigger'larÄ±; sorgu indexleri. Faz 5 eki (0008/0009): `checks.source_row_id` + `loans.source_sheet_id` partial-unique (mapping idempotency, DB-seviyesinde kanÄ±tlÄ±); `checks.counterparty_label`. Dashboard view'larÄ± ihtiyaÃ§ duyan dikey dilimle birlikte (slicer kuralÄ±).

## Roller ve RLS modeli (Faz 15, migration 0035)

Ä°ki veritabanÄ± rolÃ¼ vardÄ±r ve bu ayrÄ±m RLS'in Ã§alÄ±ÅŸmasÄ± iÃ§in ÅŸarttÄ±r:

- **`mas_radar_app`** â€” Next.js runtime'Ä±nÄ±n baÄŸlandÄ±ÄŸÄ± rol (`DATABASE_URL`). `NOSUPERUSER`,
  `NOBYPASSRLS`. `authenticated` rolÃ¼ne Ã¼yedir; policy'ler rol **Ã¼yeliÄŸi** Ã¼zerinden eÅŸleÅŸtiÄŸi
  iÃ§in 0007'nin `to authenticated` politikalarÄ± bu role uygulanÄ±r.
- **`postgres`** (owner) â€” yalnÄ±z ÅŸema/rol/seed deÄŸiÅŸtiren script'ler (`MIGRATION_DATABASE_URL`).

Faz 15'ten Ã¶nce tek rol vardÄ± (`postgres`) ve PostgreSQL superuser'larÄ± RLS'i **her zaman**
bypass ettiÄŸi iÃ§in buradaki politikalarÄ±n hiÃ§biri fiilen devrede deÄŸildi.

Politika modeli:

- Ã‡oÄŸu public tablosunda: RLS enabled + `to authenticated using(true) with check(true)`
  (tek-operatÃ¶r modu, CLAUDE.md).
- **Ä°stisna â€” `schema_migrations`**: RLS aÃ§Ä±k, policy yok, `revoke all ... from authenticated`
  (0020 + 0035). Ledger yalnÄ±z owner'a aittir.
- **Ä°stisna â€” `users` / `sessions`**: 0031'in `users_deny_all` / `sessions_deny_all`
  (`using(false)`) politikalarÄ± duruyor; 0035 bunlarÄ±n yanÄ±na `mas_radar_app` hedefli
  `users_app_runtime` / `sessions_app_runtime` (`using(true)`) ekler. PERMISSIVE politikalar
  OR'landÄ±ÄŸÄ± iÃ§in uygulama kendi auth tablolarÄ±na eriÅŸir, `authenticated`'Ä±n diÄŸer Ã¼yeleri
  eriÅŸemez. Bu ek olmadan giriÅŸ yapmak imkÃ¢nsÄ±z olurdu.
- **Ä°stisna â€” `audit_logs`**: ek REVOKE yok; 0022'den beri BEFORE trigger'larla append-only.
- `TRUNCATE` hiÃ§bir tabloda `authenticated`'e verilmez. Uygulama hiÃ§ TRUNCATE kullanmaz;
  yalnÄ±z operatÃ¶r/gate script'leri kullanÄ±r ve onlar owner baÄŸlantÄ±sÄ±yla Ã§alÄ±ÅŸÄ±r.

**KapatÄ±lan geÃ§miÅŸ aÃ§Ä±k (`0058` & `0098` ile kapatÄ±ldÄ± â€” artÄ±k `106/106` = `%100` RLS aktif):** 0007'nin dÃ¶ngÃ¼sÃ¼ yalnÄ±z o an var olan tablolarÄ± kapsadÄ±ÄŸÄ± iÃ§in Faz 15'te aÃ§Ä±k kalan
eklenen 11 tabloda RLS hiÃ§ aÃ§Ä±lmamÄ±ÅŸtÄ±r (`capacity_models`, `cost_models`, `machine_assets`,
`machine_roi_snapshots`, `part_profitability_runs`, `production_parts`, `scenario_assumptions`,
`scenario_comparisons`, `scenario_run_lines`, `scenario_runs`, `scenarios`). Bunlarda eriÅŸimi
yalnÄ±z GRANT'ler yÃ¶netir; kÄ±rÄ±lma deÄŸil, savunma derinliÄŸi eksiÄŸidir. Faz 15 kapsamÄ±na
alÄ±nmadÄ±, ayrÄ± bir dilim olarak kapatÄ±lmalÄ±dÄ±r.

## Migration ledger (P0-C, migration 0020/0021)

- **schema_migrations**(version pk, name, checksum, applied_at, applied_by) â€” hangi `supabase/migrations/*.sql` dosyasÄ±nÄ±n hangi checksum ile uygulandÄ±ÄŸÄ±nÄ± izler. `applied_by`: `baseline-backfill` (0001-0019, `scripts/db/legacy-baseline-0019.json` manifest'i ile doÄŸrulanÄ±p yalnÄ±z kayÄ±t edildi, SQL'i tekrar Ã§alÄ±ÅŸtÄ±rÄ±lmadÄ±) veya `migrate-script` (gerÃ§ekten Ã§alÄ±ÅŸtÄ±rÄ±ldÄ±). RLS aÃ§Ä±k, `authenticated`'e policy verilmez (0007'nin blanket-authenticated dÃ¶ngÃ¼sÃ¼nden istisna) â€” `revoke all ... from public, anon, authenticated`.
- Runner: `scripts/db/migrate.ts` (`npm run db:migrate`) â€” dÃ¶rt durumlu state machine (EMPTY / LEGACY_COMPLETE / LEDGER_MANAGED / LEDGER_EMPTY_RECOVERY), tek advisory lock, checksum her zaman yeni SQL'den Ã¶nce doÄŸrulanÄ±r, var olan DB'ye pending migration'larÄ± atomik+yedekli uygular. `scripts/db/migrate-verify.ts` (`npm run db:migrate:verify`) disposable DB'lerde 8 senaryoyu doÄŸrular.
- `mas_radar_dev` 2026-07-18'de `LEGACY_COMPLETE` yoluyla migre edildi: 0001-0019 backfill, 0020-0021 gerÃ§ek Ã§alÄ±ÅŸtÄ±rma, 21 satÄ±r, veri deÄŸiÅŸmedi (payments=19, cashflow_months=35, checks=7).

## KayÄ±t bÃ¼tÃ¼nlÃ¼ÄŸÃ¼ ve yaÅŸam dÃ¶ngÃ¼sÃ¼ sertleÅŸtirmesi (migration 0022-0034)

Bu bÃ¶lÃ¼m Faz 18'de yazÄ±ldÄ±: belge ~0021'de donmuÅŸtu, oysa 0022-0034 arasÄ± on Ã¼Ã§ migration
ÅŸemanÄ±n mali gÃ¼venlik davranÄ±ÅŸÄ±nÄ± belirleyen kÄ±smÄ±nÄ± ekledi. Kronolojik deÄŸil, konu bazlÄ±.

### Denetim izi dokunulmazlÄ±ÄŸÄ± (0022)

- **audit_logs append-only.** `revoke update, delete, truncate` savunma derinliÄŸi; asÄ±l
  zorlayÄ±cÄ± `public.audit_logs_block_mutation()` BEFORE trigger'larÄ± â€” UPDATE/DELETE/TRUNCATE
  **superuser iÃ§in de** reddedilir. Bu yÃ¼zden denetim izi yalnÄ±z tek yÃ¶nde yanlÄ±ÅŸ olabilir:
  satÄ±r en baÅŸtan hatalÄ± yazÄ±lmÄ±ÅŸsa. Faz 18'in `src/lib/audit.ts` konsolidasyonunun sebebi bu.
- Migration idempotent (0020/0021 konvansiyonu, `LEDGER_EMPTY_RECOVERY` iÃ§in ÅŸart).

### ArÅŸiv yaÅŸam dÃ¶ngÃ¼sÃ¼ (0023, 0024)

- **0023 â€” arÅŸiv tutarlÄ±lÄ±ÄŸÄ±** altÄ± tabloda `NOT VALID` CHECK ile: `payments` iÃ§in
  `status='archived'` â‡” `archived_at` â‡” `archive_reason` â‡” `archived_by_label`. Ã–n kontrol
  (2026-07-18, gerÃ§ek `mas_radar_dev`) sÄ±fÄ±r ihlal buldu; **VALIDATE bilerek ayrÄ± bir dilime
  bÄ±rakÄ±ldÄ±** â€” ev kuralÄ±: constraint ekleyen migration onu aynÄ± anda doÄŸrulamaz.
- **0024 â€” arÅŸivlenmiÅŸ kayÄ±t dokunulmazlÄ±ÄŸÄ±** trigger'larÄ±: herhangi bir arÅŸiv sinyali taÅŸÄ±yan
  satÄ±r dondurulur; tek istisna eksik arÅŸiv meta verisinin sonradan tamamlanmasÄ± ("legacy
  metadata completion"). KÄ±smi UPDATE ile sessiz arÅŸivden Ã§Ä±karma yasaktÄ±r; **kontrollÃ¼ arÅŸivden Ã§Ä±karma yolu Faz 59 (`0109`)** ile iÅŸlem-yerel `app.allow_archive_restore = 'true'` GUC kilidi + zorunlu gerekÃ§e + `audit_logs` iziyle aÃ§Ä±lmÄ±ÅŸtÄ±r ve
  kÄ±smi bir UPDATE ile sessizce olmamalÄ±. `updated_at` muaf (`set_updated_at()` sahibi).

### Ã–deme kalemi alan tutarlÄ±lÄ±ÄŸÄ± (0025, 0028, 0029)

- **0025** â€” `paid_at`/`paid_amount` yalnÄ±z `paid`/`partial` statÃ¼lerinde bulunabilir
  (zorunlu deÄŸil, izinli); diÄŸer her statÃ¼de ikisi de null olmalÄ±. 0003'Ã¼n
  `paid_requires_paid_at` ileri yÃ¶nÃ¼nÃ¼ tamamlar, ona dokunmaz. `loan_installments`'ta
  `paid_amount` kolonu yok (0005), yalnÄ±z `paid_at`.
- **0028 â€” `payment_instances.amount_source`** (`generated` / `manual` / `legacy_unknown`):
  bir kalemin tutarÄ±nÄ±n ÅŸablonundan otomatik mutabakata **gÃ¼venli** olup olmadÄ±ÄŸÄ±nÄ± sÄ±nÄ±flar.
  Mevcut satÄ±rlar ayÄ±rt edilemediÄŸi iÃ§in muhafazakÃ¢r `legacy_unknown` varsayÄ±lanÄ±na dÃ¼ÅŸer,
  asla `generated`'a deÄŸil. Migration `add column if not exists`le yetinmez: kolonun diskteki
  gerÃ§ek tanÄ±mÄ±nÄ± (tip, nullability, default) doÄŸrular ve yanlÄ±ÅŸsa **yÃ¼ksek sesle** durur.
- **0029** â€” 0028'in CHECK'ini VALIDATE eder. DoÄŸrulamadan Ã¶nce constraint'in *doÄŸru* olanÄ±
  olduÄŸunu (tablo, `contype='c'`, beklenen ifade) teyit eder; yanlÄ±ÅŸlÄ±kla aynÄ± adÄ± taÅŸÄ±yan
  farklÄ± bir constraint asla sessizce onaylanmaz. Bu fail-closed deseni 0030/0032'de tekrarlanÄ±r.

### Ä°ptal (cancellation) meta verisi (0026, 0030)

- **0026** â€” statÃ¼ enum'unda `cancelled` bulunan Ã¼Ã§ tabloya (`payment_instances`, `checks`,
  `loan_installments`) `cancelled_at` + `cancel_reason` ekler; Ã§ift yÃ¶nlÃ¼ tutarlÄ±lÄ±k +
  boÅŸ-olmayan gerekÃ§e CHECK'i, `NOT VALID`. `payments`/`loans` hariÃ§ â€” enum'larÄ±nda
  `cancelled` yok.
- **0030** â€” 0026'nÄ±n Ã¼Ã§ CHECK'ini VALIDATE eder. Arada Faz 5'in legacy-repair'i, `NOT VALID`
  ile grandfather edilmiÅŸ tek ihlalli satÄ±rÄ±n (`77815c3d-â€¦`) meta verisini geri doldurdu.

### StatÃ¼ geÃ§iÅŸ guard'larÄ± (0027, 0033, 0034) â€” bu deponun en pahalÄ± dersi

- **0027** Ã¼Ã§ ayrÄ±, tabloya Ã¶zgÃ¼ trigger fonksiyonu kurar (tek paylaÅŸÄ±lan fonksiyon DEÄÄ°L â€”
  bÃ¶ylece hiÃ§bir tablonun izin listesi kendisi iÃ§in geÃ§ersiz bir statÃ¼ sabitine atÄ±fta
  bulunamaz). YalnÄ±z `status` kolonunu korur; satÄ±rÄ±n kalanÄ±nÄ± kilitlemez. AynÄ±-statÃ¼
  gÃ¼ncellemeleri her zaman no-op. `loans`'ta trigger yok (enum'unda `cancelled` yok).
- **0027 izin listeleri EKSÄ°K Ã‡IKTI ve bu Ã¼retimde gerÃ§ekten kÄ±rdÄ±:**
  - `checks` ve `loan_installments` yalnÄ±z `planned â†’ cancelled` ile aÃ§Ä±ldÄ±. Oysa
    `checks.status` 0005'ten beri `cleared`/`bounced`, `loan_installments.status` `paid`/`late`
    kabul ediyordu. SonuÃ§: **hiÃ§bir Ã§ek tahsil/karÅŸÄ±lÄ±ksÄ±z, hiÃ§bir taksit Ã¶denmiÅŸ olarak
    kaydedilemedi.** GerÃ§ek `mas_radar_dev`'de 7/7 Ã§ek ve 48/48 taksit `planned`de sÄ±kÄ±ÅŸtÄ±;
    `financing/engine.ts`'in `paid_count` KPI'Ä± Faz 5'ten beri 0 dÃ¶ndÃ¼rdÃ¼. **0034** dÃ¼zeltti.
  - `payment_instances` iÃ§in `â†’ partial` girdileri hiÃ§ eklenmemiÅŸti; `markInstancePartial` ve
    onu besleyen UI, 0027'den beri **hiÃ§bir** kalemde kÄ±smi Ã¶deme kaydedemiyordu.
    `scripts/seed-demo.ts` taze bir DB'de bunu yakaladÄ±. **0033** dÃ¼zeltti
    (`unpaid`/`planned`/`late` â†’ `partial`; `paid â†’ partial` bilinÃ§li olarak eklenmedi).
- **Ders (implementation.md Â§17 kural 3):** yaÅŸam dÃ¶ngÃ¼sÃ¼ olan her yeni entity, izin listesini
  CHECK/enum ile AYNI migration'da ve **eksiksiz** kurmalÄ±dÄ±r. Bu genel bir temkin deÄŸil, bu
  depoda sekiz migration boyunca sÃ¼rmÃ¼ÅŸ gerÃ§ek bir veri kaybÄ± sÄ±nÄ±fÄ±dÄ±r.

### Kimlik ve aktÃ¶r (0031, 0032)

- **0031** â€” `public.users` + `public.sessions`. AyrÄ±ca `users_deny_all` / `sessions_deny_all`
  (`using(false)`) politikalarÄ±; bunlar uygulamanÄ±n superuser olduÄŸu varsayÄ±mÄ±yla yazÄ±lmÄ±ÅŸtÄ± ve
  Faz 15 o varsayÄ±mÄ± kaldÄ±rdÄ±ÄŸÄ± iÃ§in orada `mas_radar_app` hedefli `app_runtime` politikalarÄ±yla
  tamamlandÄ± (bkz. yukarÄ±daki "Roller ve RLS modeli").
- **0032** â€” "bunu kim yaptÄ±" FK'larÄ±nÄ±n sekizi tek kullanÄ±mlÄ±k `auth.users` stub'Ä±ndan gerÃ§ek
  `public.users`'a taÅŸÄ±nÄ±r. `auth.users` stub'Ä±na dokunulmaz. Fail-closed: her constraint'in
  gerÃ§ekten `auth.users`'Ä± hedeflediÄŸi ve kolonun canlÄ± DB'de sÄ±fÄ±r non-null satÄ±r taÅŸÄ±dÄ±ÄŸÄ±
  Ã¶nce doÄŸrulanÄ±r.

---

## Yeni tablo eklerken checklist (Faz 18'den itibaren zorunlu)

AÅŸaÄŸÄ±daki beÅŸ madde, bu ÅŸemanÄ±n geÃ§miÅŸte gerÃ§ekten kÄ±rÄ±ldÄ±ÄŸÄ± beÅŸ yerdir. Yeni bir tablo (ya da
yeni bir yaÅŸam dÃ¶ngÃ¼sÃ¼) eklerken hepsi AYNI migration'da dÃ¼ÅŸÃ¼nÃ¼lmeli:

1. **RLS politikasÄ±.** Yeni tablo kendi migration'Ä±nda blanket `for all to authenticated
   using(true) with check(true)` politikasÄ±nÄ± almalÄ±. 0007'nin dÃ¶ngÃ¼sÃ¼ yalnÄ±z o an var olan
   tablolarÄ± kapsadÄ±; sonradan eklenen 11 tabloda RLS hiÃ§ aÃ§Ä±lmadÄ± (yukarÄ±daki "Bilinen aÃ§Ä±k").
   Faz 24B gerÃ§ek rol-bazlÄ± politikalara geÃ§irene kadar desen budur.
2. **StatÃ¼ geÃ§iÅŸ guard'Ä± â€” EKSÄ°KSÄ°Z.** YaÅŸam dÃ¶ngÃ¼sÃ¼ varsa izin listesi, statÃ¼ enum'unun kabul
   ettiÄŸi HER gerÃ§ek geÃ§iÅŸi iÃ§ermeli. 0027 â†’ 0033/0034 dersi: eksik bir izin listesi tabloyu
   sessizce kullanÄ±lamaz hale getirir ve aylarca fark edilmez.
3. **`audit()` Ã§aÄŸrÄ±sÄ±.** Her mutasyon `src/lib/audit.ts`'in tek kanonik `audit()`'ini
   Ã§aÄŸÄ±rmalÄ±; tabloya Ã¶zel bir kopya yazÄ±lmamalÄ± (`pnpm phase18:verify` bunu zorlar).
   Denetim satÄ±rÄ±, tarif ettiÄŸi mutasyonla **aynÄ± transaction'da** yazÄ±lmalÄ±.
4. **Migration ledger uyumu.** Migration idempotent olmalÄ± (`if not exists` / `create or
   replace`), checksum disiplinine uymalÄ±, ve constraint ekleyen bir migration onu aynÄ± anda
   VALIDATE etmemeli â€” doÄŸrulama ayrÄ±, aÃ§Ä±kÃ§a onaylanmÄ±ÅŸ bir dilimdir (0023/0025/0026 â†’ 0029/0030).
5. **Zod sÄ±nÄ±rÄ±.** Tabloyu yazan her server action/route handler girdisini `src/lib/validation`'Ä±n
   `parseOrThrow`'undan geÃ§irmeli (aksiyon baÅŸÄ±na bir ÅŸema). Ham `ZodError.message` asla
   `DomainError`'a gÃ¶mÃ¼lmemeli â€” Zod v4'te o bir JSON dÃ¶kÃ¼mÃ¼dÃ¼r ve `api-response.ts` DomainError
   mesajÄ±nÄ± istemciye aynen geÃ§irir; `formatIssues` bunun iÃ§in var.

## KarÅŸÄ± taraf (cari hesap) ve organizasyonel boyutlar (Faz 19, migration 0036-0039)

Faz 19'un tamamÄ± `parties`'in ÃœZERÄ°NE eklenir; `parties` tablosu deÄŸiÅŸtirilmedi, yeniden
adlandÄ±rÄ±lmadÄ±, anahtarÄ± deÄŸiÅŸmedi. Sebebi Ã¶lÃ§Ã¼ldÃ¼: `parties.id`'ye **6 tabloda 8 foreign key**
iÅŸaret ediyor (`cash_accounts.provider_party_id`, `cashflow_lines.party_id`,
`checks.payee_party_id`, `checks.payer_party_id`, `checks.bank_party_id`,
`loans.lender_party_id`, `payments.owner_party_id`, `payments.provider_party_id`) â€” ÅŸemadaki en
Ã§ok referans verilen tablo. `phase19:verify` bu sekizinin hÃ¢lÃ¢ yerinde olduÄŸunu her koÅŸuda
kontrol eder.

### 0036 â€” counterparty_profiles (1:1 sidecar)

- **1:1 yapÄ±sal olarak zorlanÄ±r:** `party_id` birincil anahtardÄ±r. Ä°kinci bir profil ifade
  edilemez (sonradan eklenmiÅŸ bir unique index deÄŸil).
- `ON DELETE CASCADE` â€” bir gevÅŸetme DEÄÄ°L: yukarÄ±daki 8 FK'nÄ±n hepsi `NO ACTION`, yani mali
  kaydÄ± olan bir parti zaten silinemez; cascade yalnÄ±z hiÃ§ geÃ§miÅŸi olmayan bir parti iÃ§in
  Ã§alÄ±ÅŸÄ±r ve orada Ã¶ksÃ¼z profil bÄ±rakmak yanlÄ±ÅŸ olurdu.
- Vergi no/dairesi **format doÄŸrulamasÄ± YOK** â€” kaynak Ã§alÄ±ÅŸma kitaplarÄ± yabancÄ± karÅŸÄ± taraf,
  boÅŸluk ve yazÄ±m hatasÄ± taÅŸÄ±yor; bunlar korunup iÅŸaretlenir, reddedilmez (CLAUDE.md). YalnÄ±z
  "boÅŸluktan ibaret" reddedilir.
- `credit_limit`: sÄ±fÄ±r **gerÃ§ek bir deÄŸerdir** ("peÅŸin"), null ise "limit kaydedilmemiÅŸ" â€”
  ikisi aynÄ± ÅŸey deÄŸildir.
- `tax_number` index'i unique DEÄÄ°L: `parties` (normalized_name, party_type) Ã¼zerinden unique
  olduÄŸu iÃ§in aynÄ± firma bir kez `customer` bir kez `vendor` olarak var olabilir ve aynÄ± vergi
  numarasÄ±nÄ± taÅŸÄ±r. Unique yapmak doÄŸru bir iÃ§e aktarmayÄ± baÅŸarÄ±sÄ±z kÄ±lardÄ±.

### 0037 â€” ibans + append-only deÄŸiÅŸiklik geÃ§miÅŸi

- **Neden yalnÄ±z bu tabloya geÃ§miÅŸ:** IBAN deÄŸiÅŸikliÄŸi bu uygulamadaki en yÃ¼ksek sonuÃ§lu dÃ¼zenleme
  â€” parayÄ± sessizce baÅŸka hesaba yÃ¶nlendirir ve klasik fatura dolandÄ±rÄ±cÄ±lÄ±ÄŸÄ± vektÃ¶rÃ¼dÃ¼r. DiÄŸer
  her alan kaynak kitaptan yeniden kurulabilir; yanlÄ±ÅŸ hesaba giden Ã¶deme kurulamaz.
- `iban_normalized` **generated column** (`upper(regexp_replace(iban,'\s','','g'))`); uniqueness
  onun Ã¼zerinde. `src/lib/counterparties/rules.ts`'in `normalizeIban()`'Ä± birebir aynÄ± olmak
  zorunda â€” `phase19:verify` ikisini karÅŸÄ±laÅŸtÄ±rÄ±r. Aksi halde uygulama, index'in reddedeceÄŸi
  bir IBAN'Ä± kaydetmeyi teklif ederdi.
- **Uniqueness parti-kapsamlÄ±, global DEÄÄ°L** (`unique(party_id, iban_normalized)`): aynÄ± firma
  iki `party_type` satÄ±rÄ± olarak var olabildiÄŸi iÃ§in global unique doÄŸru bir durumu ifade
  edilemez kÄ±lardÄ±. FarklÄ± karÅŸÄ± taraflarda aynÄ± IBAN bir **sinyaldir**, engel deÄŸil â€” 0039'un
  `iban_shared_across_parties` view'i raporlar.
- `ibans_one_primary_per_party` partial unique index: parti baÅŸÄ±na en fazla bir birincil hesap.
- **`iban_change_events` salt-ekleme**, 0022'nin `audit_logs` deseniyle birebir: REVOKE savunma
  derinliÄŸi, asÄ±l zorlayÄ±cÄ± BEFORE trigger'larÄ± â€” UPDATE/DELETE/TRUNCATE **superuser iÃ§in de**
  reddedilir.
- `iban_id`/`party_id` **kasÄ±tlÄ± olarak FK DEÄÄ°L**: satÄ±r, tarif ettiÄŸi IBAN'dan uzun yaÅŸamalÄ±.
  `ON DELETE CASCADE` olsaydÄ±, saklanmaya en deÄŸer olay olan silme, tam da ilginÃ§leÅŸtiÄŸi anda
  kanÄ±tÄ±nÄ± silerdi.
- Recorder AFTER trigger'dÄ±r ve `to_jsonb(row)` kullanÄ±r: ileride eklenecek bir kolon, bu
  fonksiyona dokunulmadan var olduÄŸu andan itibaren kaydedilir. No-op UPDATE geÃ§miÅŸe satÄ±r
  yazmaz (`to_jsonb(new) - 'updated_at'` karÅŸÄ±laÅŸtÄ±rmasÄ±).
- **audit_logs'un yerini ALMAZ:** engine ayrÄ±ca Faz 18'in `audit()`'ini Ã§aÄŸÄ±rÄ±r. Ä°kisi farklÄ±
  sorularÄ± yanÄ±tlar â€” `audit_logs` "hangi operatÃ¶r ne yaptÄ±" (uygulama yazar),
  `iban_change_events` "bu IBAN ne dedi" (veritabanÄ± yazar, deÄŸiÅŸiklik uygulamadan mÄ± script'ten
  mi psql'den mi geldiÄŸine bakmadan).

### 0038 â€” cost_centers / departments / projects / products / orders (MÄ°NÄ°MAL)

Kapsam implementation.md Â§3 aÃ§Ä±k soru #9 ile sÄ±nÄ±rlandÄ±: yalnÄ±z kod/ad referans verisi. Tahsis
mantÄ±ÄŸÄ±, sipariÅŸ yaÅŸam dÃ¶ngÃ¼sÃ¼, satÄ±r kalemi, tutar **yok** â€” ve bunlar "var ama kullanÄ±lmÄ±yor"
deÄŸil, hiÃ§ eklenmedi; boÅŸ bir kolon ikinci ve Ã§eliÅŸkili bir gerÃ§ek kaynaÄŸÄ± davet eder.

- `departments.parent_department_id` self-FK, `ON DELETE RESTRICT` â€” Ã¼st birimi silmek alt
  birimleri sessizce silmemeli.
- `projects.party_id` / `orders.party_id` opsiyonel ve `NO ACTION` (parties'e giden diÄŸer her FK
  gibi).
- `products`, `production_parts`'Ä±n yerine GEÃ‡MEZ: o sÃ¼reÃ§-odaklÄ± (torna/freze dakikalarÄ±), bu
  ticari referans verisi. Kaynak kitaplar bir eÅŸleme ifade etmediÄŸi iÃ§in baÄŸ kurulmadÄ±.

### StatÃ¼/yaÅŸam dÃ¶ngÃ¼sÃ¼ kolonu neden YOK (Â§17 kural 3 gerÃ§ekten N/A)

Faz 19'un **hiÃ§bir** tablosunda `status` enum'u yok; yalnÄ±z `is_active` boolean'larÄ± var ve
boolean'Ä±n kÄ±sÄ±tlanacak geÃ§iÅŸi yoktur. Bu, kuraldan kaÃ§Ä±ÅŸ deÄŸil kurala uyumdur: Â§17 kural 3,
yaÅŸam dÃ¶ngÃ¼sÃ¼ olan her yeni entity'nin geÃ§iÅŸ izin listesini AYNI migration'da ve **eksiksiz**
kurmasÄ±nÄ± ÅŸart koÅŸar, Ã§Ã¼nkÃ¼ 0027 Ã¼Ã§ eksik izin listesiyle Ã§Ä±ktÄ± ve 7/7 Ã§eki, 48/48 taksiti sekiz
migration boyunca `planned`de kilitledi. YarÄ±m tasarlanmÄ±ÅŸ bir yaÅŸam dÃ¶ngÃ¼sÃ¼nÃ¼ kÃ¶tÃ¼ korumaktansa
hiÃ§ eklememek doÄŸru olan. SipariÅŸ yaÅŸam dÃ¶ngÃ¼sÃ¼ gerÃ§ekten gerektiÄŸinde, guard'Ä±yla aynÄ±
migration'da gelir. `phase19:verify` bu iddiayÄ± her koÅŸuda doÄŸrular (yeni tablolarda
`status`/`state`/`lifecycle` kolonu aranÄ±r).

### 0039 â€” dÃ¶rt VIEW (kalÄ±cÄ± kolon deÄŸil)

- **`counterparty_exposure`** â€” parti baÅŸÄ±na aÃ§Ä±k Ã§ek + Ã¶denmemiÅŸ taksit + aÃ§Ä±k Ã¶deme kalemi,
  yoÄŸunlaÅŸma payÄ±, kredi limiti kullanÄ±mÄ±. **Materialized DEÄÄ°L, stored kolon DEÄÄ°L:** ikinci bir
  gerÃ§ek kaynak sessizce bayatlar; bu ÅŸemada zaten yaÅŸanmÄ±ÅŸ bir yara var (0027/0034 Ã¶ncesi
  `paid_count` KPI'Ä± Faz 5'ten beri 0 dÃ¶nÃ¼yordu). View girdilerinden sapamaz.
- **Bilinmeyen tutarlar SAYILIR, sÄ±fÄ±r olarak toplanmaz** (`unknown_amount_count`) â€” Ã¼Ã§ tutarsÄ±z
  Ã§eki olan bir karÅŸÄ± taraf "sÄ±fÄ±r risk" olarak okunmamalÄ±.
- `exposure_ratio` ve `credit_limit_utilization` bÃ¶lecek bir ÅŸey yoksa **null**, sÄ±fÄ±r deÄŸil â€”
  "bilinen toplam yok" ile "%0 yoÄŸunlaÅŸma" farklÄ± ifadelerdir (money.ts'in `ratioOrNull`'Ä±yla
  aynÄ± ayrÄ±m). SÄ±fÄ±r limit ise gerÃ§ek bir deÄŸerdir: aÅŸÄ±m iÅŸaretlenir ama bÃ¶lme yapÄ±lmaz.
- Ã‡ek atamasÄ± payee/payer Ã¼zerinden, **banka Ã¼zerinden DEÄÄ°L**: `bank_party_id` "hangi bankaya
  keÅŸide" demektir ve katÄ±lsaydÄ± bankanÄ±n riskini Ã§ok abartÄ±rdÄ±.
- **`counterparty_unresolved`** â€” geri-doldurmanÄ±n yerine geÃ§en gÃ¶rÃ¼nÃ¼rlÃ¼k yÃ¼zeyi (aÅŸaÄŸÄ±da).
- **`iban_shared_across_parties`** â€” 0037'nin bilerek engellemediÄŸi Ã§akÄ±ÅŸmayÄ± raporlar.

### Geri-doldurma neden YAPILMADI

Ä°Ã§e aktarma bir ismi Ã§Ã¶zemediÄŸinde ham metni saklar ve FK'yÄ± boÅŸ bÄ±rakÄ±r
(`src/lib/financing/engine.ts` â†’ `partyIdByName`: "Never creates parties silently"). Faz 19 bu
satÄ±rlarÄ± **geri doldurmaz**: serbest metni bir karÅŸÄ± tarafa eÅŸlemek bir yargÄ±dÄ±r ve CLAUDE.md
yargÄ±yÄ± incelenmiÅŸ, aÃ§Ä±k bir insan eylemine ayÄ±rÄ±r.

Karar veriye dayandÄ±rÄ±ldÄ± (gerÃ§ek veritabanÄ±nda salt-okunur Ã¶lÃ§Ã¼m): **7 Ã§ekin 7'si zaten bir
partiye Ã§Ã¶zÃ¼lmÃ¼ÅŸ, 0'Ä± Ã§Ã¶zÃ¼msÃ¼z etiket taÅŸÄ±yor**; tek Ã§Ã¶zÃ¼msÃ¼z karÅŸÄ± taraf 1 kredinin
`lender_party_id`'si. Ãœstelik **`loans`'ta `counterparty_label` kolonu YOK** (introspection ile
doÄŸrulandÄ± â€” yalnÄ±z `checks`'te var); kredinin karÅŸÄ± tarafÄ± ancak `loans.name`'den, yani kredinin
kendi adÄ±ndan tahmin edilebilirdi ki bu tam da kuralÄ±n yasakladÄ±ÄŸÄ± Ã§Ä±karÄ±m. Yani reddedilen
geri-doldurma bugÃ¼n `checks`'te zaten hiÃ§bir ÅŸeye dokunmayacaktÄ± ve `loans`'ta dokunamazdÄ±.

Bunun yerine eklenen: `counterparty_unresolved` view'i + `/finance/counterparties` sayfasÄ±ndaki
Ã¶neri listesi. Ã–neriler bigram benzerliÄŸiyle **sÄ±ralanÄ±r ama asla otomatik baÄŸlanmaz**;
`suggestCounterparties()` dÃ¶nÃ¼ÅŸ tipinde bilerek `autoLinkable` benzeri bir alan yoktur.
EÅŸleÅŸtirme yapÄ±ldÄ±ÄŸÄ±nda `counterparty_label` **SÄ°LÄ°NMEZ** â€” ham metin kaynak kanÄ±tÄ±dÄ±r, Ã§Ã¶zÃ¼len
FK onun Ã¼zerine eklenen bir yorumdur.

## Banka Merkezi (Faz 20, migration 0040-0043)

### Mimari karar: ayrÄ±k `bank_accounts`, `cash_accounts` geniÅŸletilmedi

implementation.md bu kararÄ± bilerek aÃ§Ä±k bÄ±rakmÄ±ÅŸtÄ± ("cash_accounts'a IBAN/ÅŸube kolonu eklemek
**veya** ayrÄ±k bank_accounts tablosu â€” faz baÅŸlarÄ±nda netleÅŸtirilecek"). Karar verinin kendisine
bakÄ±larak verildi. GerÃ§ek `cash_accounts` iÃ§eriÄŸi:

| name | account_type |
| --- | --- |
| Deniz | bank_account |
| HESAP Halk | bank_account |
| Kasa | **cash** â€” kasa kutusu; IBAN'Ä±, ÅŸubesi, KMH'si yok |
| Vinov | check_account |
| Halk Business | **credit_card** â€” IBAN'Ä±, ÅŸubesi yok |
| Halk KK - Paraf | **credit_card** |

**AltÄ± satÄ±rÄ±n yalnÄ±z ikisi banka hesabÄ±.** `cash_accounts`'Ä± geniÅŸletmek, satÄ±rlarÄ±n Ã¼Ã§te
ikisinde kalÄ±cÄ± olarak null ve anlamsÄ±z beÅŸ kolon eklemek ve tablonun ne anlama geldiÄŸini
sessizce deÄŸiÅŸtirmek olurdu â€” oysa bu belge onu "genel defter nakit pozisyonu" diye tanÄ±mlÄ±yor
ve `cashflow_lines`, `payments`, `payment_instances`, `checks` tam olarak buna baÄŸlÄ±.

AyrÄ±ca `cash_accounts`'a **4 FK** iÅŸaret ediyor (`payments.cash_account_id`,
`payment_instances.paid_from_account_id`, `cashflow_lines.account_id`, `checks.account_id`).
Faz 19'un `parties` iÃ§in kurduÄŸu emsal aynen geÃ§erli: referans verilen tabloyu yeniden
ÅŸekillendirme, detayÄ± yanÄ±na as.

`bank_accounts.cash_account_id` **birincil anahtardÄ±r**, yani banka hesabÄ± aynÄ± paranÄ±n ikinci
bir kimliÄŸi deÄŸil, bir kasa hesabÄ±nÄ±n banka detayÄ±dÄ±r. `phase20:verify` `cash_accounts`'a
banka-Ã¶zel kolon sÄ±zmadÄ±ÄŸÄ±nÄ± her koÅŸuda kontrol eder.

### 0040 â€” bank_accounts

- IBAN, ÅŸube kodu/adÄ±, hesap no, SWIFT/BIC, kullanÄ±labilir/bloke bakiye, **KMH limiti**
  (`overdraft_limit`), `balance_as_of`, `last_statement_date`.
- Bakiyeler nullable: "henÃ¼z iÃ§e aktarÄ±lmadÄ±" gerÃ§ek bir durum ve sÄ±fÄ±r olarak okunmamalÄ±.
  `overdraft_limit` sÄ±fÄ±r olabilir ("KMH yok"), negatif olamaz.
- `iban_normalized` generated column, 0037'yle aynÄ± teknik.
- **IBAN GLOBAL unique** â€” ve bu 0037'yle bilinÃ§li bir KARÅITLIK. 0037 karÅŸÄ± taraf IBAN'Ä±nÄ±
  parti-kapsamlÄ± unique yapar, Ã§Ã¼nkÃ¼ aynÄ± firma `parties`'te iki kez bulunabilir. O gerekÃ§e
  burada geÃ§mez: bunlar MAS'Ä±n **kendi** hesaplarÄ±. Bir IBAN bir hesaptÄ±r; iki kasa hesabÄ±nÄ±n
  aynÄ± IBAN'Ä± iddia etmesi, o hesabÄ±n ekstresini ikiye bÃ¶len bir veri hatasÄ±dÄ±r.

### 0041 â€” `source_sheets.detected_type`'a `bank_statement`

`workbook-parser.ts`'in `SheetDetectedType` union'Ä± ile bu CHECK birbirinin aynasÄ± olmak zorunda
(dosyanÄ±n kendi baÅŸlÄ±ÄŸÄ± "Do not drift" diyor). Ekstre importu eklemek bu yÃ¼zden saf uygulama iÅŸi
deÄŸil; iki taraf birlikte hareket etmezse ilk import INSERT'te patlar. GeniÅŸletme olduÄŸu iÃ§in
(kabul edilen kÃ¼me bÃ¼yÃ¼yor, daralmÄ±yor) mevcut her satÄ±r yeni constraint'i inÅŸaen saÄŸlar â€”
"NOT VALID ekle, ayrÄ± dilimde VALIDATE" kuralÄ± burada geÃ§erli deÄŸildir.

**`classifySheetName` bu tÃ¼rÃ¼ ASLA dÃ¶ndÃ¼rmez.** Ekstre importu, operatÃ¶rÃ¼n hangi banka hesabÄ±na
aktardÄ±ÄŸÄ±nÄ± seÃ§tiÄŸi aÃ§Ä±k bir eylemdir; tÃ¼r sayfa adÄ±ndan tahmin edilmez. Tahmin etmek burada
ayrÄ±ca tehlikeliydi: gerÃ§ek Ã§alÄ±ÅŸma kitabÄ±nda **"faiz hesaplama"** adlÄ± bir sayfa var ve makul
gÃ¶rÃ¼nen bir "hesap" anahtar kelimesi onu `loan_calculation`'dan Ã§alardÄ±.

### 0042 â€” bank_transactions ve TAM durum izin listesi

Ham ekstre satÄ±rlarÄ±. Faz 2'nin staging deseni yeniden kullanÄ±lÄ±r: her satÄ±r
`source_workbook_id`/`source_sheet_id`/`source_row_id` taÅŸÄ±r, yani ham hÃ¼crelere kadar izlenir.
Ä°kinci bir lineage mekanizmasÄ± icat edilmedi.

- `amount` **NOT NULL** ve iÅŸaretli (negatif = hesaptan Ã§Ä±kÄ±ÅŸ, `checks.signed_amount` ile aynÄ±
  sÃ¶zleÅŸme). PlanlanmÄ±ÅŸ bir Ã¶demeden farklÄ± olarak, tutarsÄ±z bir ekstre satÄ±rÄ± zaten ekstre
  satÄ±rÄ± deÄŸildir.
- `direction` generated column â€” elle yanlÄ±ÅŸ yazÄ±lamaz.
- `dedupe_hash` + `unique(bank_account_id, dedupe_hash)`: Ã¶rtÃ¼ÅŸen dÃ¶nemi tekrar indirmek
  NORMALDÄ°R; aynÄ± satÄ±r Ã§oÄŸalmak yerine mevcut satÄ±ra dÃ¼ÅŸer. Hash'e **yÃ¼rÃ¼yen bakiye dahil
  edilmez** â€” geriye tarihli bir kayÄ±t araya girdiÄŸinde kayar ve aynÄ± iÅŸlemi yeni gÃ¶sterirdi.
- Ä°ki tutarlÄ±lÄ±k CHECK'i: `matched`/`reconciled` eÅŸleÅŸtiÄŸi kaydÄ± adlandÄ±rmak ZORUNDA;
  `ignored` **gerekÃ§esiz olamaz** (sessiz bir "beni ilgilendirmiyor", gerÃ§ek bir Ã¶demenin
  kaybolma yoludur).

#### Durum izin listesi â€” 0027'nin dersinin uygulanÄ±ÅŸÄ±

CHECK'in kabul ettiÄŸi deÄŸerler: `unmatched Â· suggested Â· matched Â· reconciled Â· ignored`.
Ä°zin verilen geÃ§iÅŸler, **kolonla aynÄ± migration'da**:

| GeÃ§iÅŸ | AnlamÄ± |
| --- | --- |
| unmatched â†’ suggested | eÅŸleÅŸtirici aday buldu |
| unmatched â†’ matched | operatÃ¶r doÄŸrudan eÅŸleÅŸtirdi |
| unmatched â†’ ignored | eÅŸleÅŸme gerekmiyor (banka masrafÄ±, kendi virmanÄ±) |
| suggested â†’ matched | Ã¶neri kabul edildi |
| **suggested â†’ unmatched** | **Ã¶neri REDDEDÄ°LDÄ° â€” red yolu** |
| suggested â†’ ignored | Ã¶neri yerine yok sayÄ±ldÄ± |
| matched â†’ reconciled | dÃ¶nem kapatÄ±ldÄ± |
| matched â†’ unmatched | yanlÄ±ÅŸ eÅŸleÅŸme geri alÄ±ndÄ± |
| matched â†’ ignored | "eÅŸleÅŸme" aslÄ±nda masrafmÄ±ÅŸ |
| reconciled â†’ matched | kapanmÄ±ÅŸ mutabakat dÃ¼zeltme iÃ§in yeniden aÃ§Ä±ldÄ± |
| ignored â†’ unmatched | yok sayma geri alÄ±ndÄ± |

AynÄ±-durum gÃ¼ncellemesi HER deÄŸer iÃ§in no-op (0027'nin doÄŸru olan kÄ±smÄ±).

**EriÅŸilebilirlik** â€” 0027'nin kÄ±rdÄ±ÄŸÄ± Ã¶zellik: `unmatched` baÅŸlangÄ±Ã§; `suggested` unmatched'ten;
`matched` unmatched/suggested/reconciled'dan; `reconciled` matched'ten; `ignored`
unmatched/suggested/matched'ten. **BeÅŸi de eriÅŸilebilir, Ã¶lÃ¼ deÄŸer yok.**

Bilerek yasaklananlar (ihmal deÄŸil, gerekÃ§eli): `unmatchedâ†’reconciled` (mutabakata alÄ±nacak bir
eÅŸleÅŸme yok), `suggestedâ†’reconciled` (Ã¶neri kabul deÄŸildir), `reconciledâ†’unmatched` ve
`reconciledâ†’ignored` (Ã¶nce `matched`'e dÃ¶nÃ¼lÃ¼r, bÃ¶ylece yeniden aÃ§ma kendi baÅŸÄ±na denetlenir),
`ignoredâ†’suggested/matched/reconciled` (Ã¶nce yok sayma geri alÄ±nÄ±r).

**KanÄ±t okumayla deÄŸil SAYIMLA yapÄ±lÄ±r:** `scripts/phase20-verify.ts` izin verilen durumlarÄ±
canlÄ± CHECK constraint'inden **tÃ¼retir**, 5Ã—5 = **25 Ã§iftin tamamÄ±nÄ±** gerÃ§ek bir satÄ±r Ã¼zerinde
dener ve gÃ¶zlenen kabul/ret matrisini beyanla karÅŸÄ±laÅŸtÄ±rÄ±r. CHECK'e geÃ§iÅŸleri olmayan bir durum
eklenirse gate "Ã–LÃœ DURUM" diyerek dÃ¼ÅŸer. 0027'de baÅŸarÄ±sÄ±z olan ÅŸey tam olarak migration'Ä±
okuyup doÄŸru sanmaktÄ±.

### 0043 â€” eÅŸleÅŸme adaylarÄ± ve Ã¼Ã§ view

`bank_transaction_match_candidates`'Ä±n **statÃ¼ enum'u YOKTUR** â€” bilinÃ§li. Bir aday ya vardÄ±r ya
reddedilmiÅŸtir; bunu statÃ¼ olarak modellemek Ä°KÄ°NCÄ° bir durum makinesi ve ikinci bir tam guard
gerektirirdi. `rejected_at` nullable bir zaman damgasÄ±dÄ±r; kÄ±sÄ±tlanacak geÃ§iÅŸi yoktur. Kabul,
ait olduÄŸu yerde â€” hareketin kendisinde â€” kaydedilir. **Redler silinmez, hatÄ±rlanÄ±r**, yoksa
eÅŸleÅŸtirici aynÄ± adayÄ± her koÅŸuda yeniden Ã¶nerirdi.

View'ler (kalÄ±cÄ± kolon deÄŸil, 0039'la aynÄ± gerekÃ§e):
- `bank_unmatched_queue` â€” insanÄ±n karar vermesi gereken her ÅŸey, aÃ§Ä±k aday sayÄ±sÄ± ve en iyi
  gÃ¼ven skoruyla.
- `bank_reconciliation_summary` â€” hesap baÅŸÄ±na mutabakat saÄŸlÄ±ÄŸÄ±.
- `bank_match_conflicts` â€” **iki farklÄ± ekstre satÄ±rÄ±nÄ±n aynÄ± mali kaydÄ± iddia etmesi.** 0042'nin
  unique index'i aynÄ± satÄ±rÄ±n iki kez iÃ§e aktarÄ±lmasÄ±nÄ± durdurur; gerÃ§ekten farklÄ± iki satÄ±rÄ±n
  tek bir Ã¶demeye eÅŸleÅŸtirilmesini hiÃ§bir ÅŸey durdurmaz ve asÄ±l ilginÃ§ hata odur â€” bu yÃ¼zden
  engellenmez, **bildirilir**.

### SÄ±nÄ±flandÄ±rma ve eÅŸleÅŸtirme: kural, model deÄŸil

`src/lib/bank/rules.ts` saf ve test edilebilir. SÄ±nÄ±flandÄ±rma sÄ±ralÄ± bir kural tablosudur, **ilk
eÅŸleÅŸen kazanÄ±r** (sÄ±ra spesifikasyonun kendisidir: "kredi kartÄ±" mutlaka "kredi taksit"ten Ã¶nce
gelmeli). Her satÄ±r hangi kuralÄ±n Ã§alÄ±ÅŸtÄ±ÄŸÄ±nÄ± (`category_rule`) saklar; eÅŸleÅŸme yoksa `unknown`
ve **null kural** â€” en iyi tahmin Ã¼retilmez.

EÅŸleÅŸtirme skoru adlandÄ±rÄ±lmÄ±ÅŸ sinyallerin toplamÄ±dÄ±r (`amount_exact`, `date_same_day`,
`label_contained`â€¦) ve `reasons` olarak saklanÄ±r. **Ä°ki baÄŸÄ±msÄ±z sinyal ÅŸarttÄ±r:** hiÃ§bir tek
aÄŸÄ±rlÄ±k Ã¶neri eÅŸiÄŸini (0.5) tek baÅŸÄ±na geÃ§emez, Ã§Ã¼nkÃ¼ 10.000 TL gibi yuvarlak bir tutarÄ±n tek
baÅŸÄ±na tutmasÄ± tam da gÃ¼venle yanlÄ±ÅŸ mutabakat Ã¼reten rastlantÄ±dÄ±r. Bu kural bir birim testiyle
yapÄ±sal olarak korunuyor â€” ilk aÄŸÄ±rlÄ±k tablosu bunu ihlal ediyordu ve test yakaladÄ±.

**Bir eÅŸleÅŸmeyi kabul etmek mali kaydÄ± DEÄÄ°ÅTÄ°RMEZ.** Ekstre planla iliÅŸkilendirilir; Ã¶demeyi
"Ã¶dendi" yapmak ayrÄ± ve ayrÄ±ca denetlenen bir iÅŸlemdir. Denetim satÄ±rÄ± bunu
`financial_record_mutated: false` alanÄ±yla aÃ§Ä±kÃ§a kaydeder.

### CSV desteÄŸi ve Â§1.1 korumasÄ±nÄ±n bozulmamasÄ±

`safeParseWorkbookBuffer` ZIP/CFB imzasÄ± olmayan her ÅŸeyi reddeder ve bu **belirtilmiÅŸ, testli**
bir davranÄ±ÅŸtÄ±r (implementation.md Â§1.1: tamamÄ± sÄ±fÄ±r bayt olan bozuk yÃ¼kleme "ayrÄ±ÅŸtÄ±rÄ±lmÄ±ÅŸ"
sayÄ±lmamalÄ±). Ekstreler sÄ±k sÄ±k CSV geldiÄŸi iÃ§in destek ÅŸart â€” ama imza kontrolÃ¼nÃ¼ gevÅŸetmek,
uygulamadaki HER workbook importu iÃ§in bozuk-dosya deliÄŸini yeniden aÃ§ardÄ±.

Bu yÃ¼zden workbook yoluna **dokunulmadÄ±**; CSV kendi kapÄ±sÄ±nÄ± ve kendi korumasÄ±nÄ± aldÄ±
(`src/lib/importers/statement-parser.ts`): boÅŸ dosya, NUL bayt iÃ§eren (aslÄ±nda ikili) iÃ§erik ve
ayÄ±rÄ±cÄ±sÄ± olmayan metin reddedilir. UTF-8 BOM striplenir â€” aksi halde ilk baÅŸlÄ±k hÃ¼cresi
"ï»¿Ä°ÅŸlem Tarihi" olur ve sÃ¼tun tanÄ±ma baÅŸarÄ±sÄ±z olurdu. AyÄ±rÄ±cÄ± ilk satÄ±rdan sayÄ±larak bulunur;
TÃ¼rkÃ§e CSV'ler `;` kullanÄ±r Ã§Ã¼nkÃ¼ `,` ondalÄ±k ayÄ±rÄ±cÄ±dÄ±r.

### Banka API'si YOK

implementation.md canlÄ± banka baÄŸlantÄ±sÄ±nÄ± Faz 37'ye erteler. Bu faz yalnÄ±z dosya importudur ve
`phase20:verify` `src/lib/bank/engine.ts` iÃ§inde aÄŸ Ã§aÄŸrÄ±sÄ± olmadÄ±ÄŸÄ±nÄ± kontrol eder â€” kapsam
kaymasÄ±nÄ± baÅŸka hiÃ§bir gate yakalamazdÄ±.

## Fatura Merkezi (Faz 21, migration 0044-0047)

Faz 19'un `parties`/`cost_centers`/`projects`/`orders`/`products` referans verisi Ã¼zerine kurulu.
GerÃ§ek kolon adlarÄ± migration yazÄ±lmadan Ã–NCE introspection'la doÄŸrulandÄ± (`projects.party_id`,
`projects.cost_center_id`, `orders.party_id` â€” plandan tahmin edilmedi).

### 0044 â€” invoices ve ALTI durumlu yaÅŸam dÃ¶ngÃ¼sÃ¼

Kolonlar: yÃ¶n (`sales`/`purchase`), fatura no, karÅŸÄ± taraf (NOT NULL), opsiyonel
masraf merkezi / proje / sipariÅŸ, dÃ¼zenleme+vade tarihi, para birimi, net/KDV/brÃ¼t, Ã¶denen tutar,
durum, 0026 desenli iptal alanlarÄ±, kapatma alanlarÄ±, Faz 2 lineage Ã¼Ã§lÃ¼sÃ¼, dedupe_hash.

**Zorlanan mali deÄŸiÅŸmez:** `gross_amount = net_amount + tax_amount`. ParÃ§alarÄ± toplamayan bir
fatura, aylar sonra nakit-akÄ±ÅŸ tahmininde aÃ§Ä±klanamayan bir fark olarak ortaya Ã§Ä±kacak bir
veri-giriÅŸ hatasÄ±dÄ±r; yazma anÄ±nda dÃ¼ÅŸer.

**`paid_amount`'a Ã¼st sÄ±nÄ±r YOK** â€” fazla Ã¶deme gerÃ§ekte oluyor (mÃ¼kerrer transfer, bankada kur
yuvarlamasÄ±) ve engellemek operatÃ¶rÃ¼ kaydÄ± Ã§arpÄ±tmaya zorlardÄ±. `invoice_overpaid` view'i
raporluyor. Flag, never fix.

#### Durum izin listesi (CHECK ile AYNI migration'da)

CHECK: `draft Â· open Â· partial Â· paid Â· closed Â· cancelled`. On dÃ¶rt geÃ§iÅŸ:

| | |
| --- | --- |
| draft â†’ open | fatura dÃ¼zenlendi |
| draft â†’ cancelled | hiÃ§ ticarileÅŸmemiÅŸ taslak iptali |
| open â†’ partial / paid | kÄ±smen / tamamen tahsil |
| open â†’ closed | tam tahsil olmadan kapatma (iskonto, zarar yazma) |
| open â†’ cancelled | DÃœZENLENMÄ°Å faturanÄ±n iptali â€” reversal kaydÄ± ÅŸart |
| partial â†’ paid / open / closed / cancelled | kalan tahsil / tek Ã¶deme geri alÄ±ndÄ± / kalan silindi / iptal |
| paid â†’ partial / open | Ã¶deme(ler) geri alÄ±ndÄ± |
| paid â†’ closed | tahsil sonrasÄ± arÅŸiv |
| closed â†’ open | dÃ¼zeltme iÃ§in yeniden aÃ§ma |

**EriÅŸilebilirlik:** altÄ± durumun altÄ±sÄ± da `draft`'tan eriÅŸilebilir. Bilerek yasaklananlar:
- **hiÃ§bir ÅŸey â†’ draft** â€” dÃ¼zenlenmiÅŸ fatura "dÃ¼zenlenmemiÅŸ" yapÄ±lamaz; bu, karÅŸÄ± tarafÄ±n
  eline geÃ§tiÄŸi gerÃ§eÄŸini silmek ve iÃ§erik dokunulmazlÄ±ÄŸÄ±nÄ± yeniden aÃ§mak olurdu.
- draft â†’ partial/paid/closed â€” dÃ¼zenlenmeden tahsil olmaz.
- closed â†’ partial/paid/cancelled â€” Ã¶nce `open`'a dÃ¶nÃ¼lÃ¼r, bÃ¶ylece yeniden aÃ§ma kendi baÅŸÄ±na
  denetlenen bir eylem olur (Faz 20'nin `reconciled â†’ matched` kurgusuyla aynÄ±).
- **cancelled â†’ hiÃ§bir ÅŸey (TERMÄ°NAL)** â€” iptal, 0046'daki reversal kaydÄ±yla belgelenir; Ã§are
  yeni fatura dÃ¼zenlemektir, iptal edilmiÅŸ bir faturayÄ± diriltmek deÄŸil. Denetim izi ile
  yeniden yazma arasÄ±ndaki fark budur.

`phase21:verify` bunu **36 Ã§iftin tamamÄ±nÄ± gerÃ§ek satÄ±rlar Ã¼zerinde deneyerek** kanÄ±tlÄ±yor;
yorumu okumuyor.

#### Ä°Ã§erik dokunulmazlÄ±ÄŸÄ± (0024 deseni)

**`draft` tek dÃ¼zenlenebilir durumdur.** Fatura dÃ¼zenlendikten sonra kimin iÃ§in olduÄŸu, numarasÄ±,
tarihleri ve tutarlarÄ± donar. Bu temkin deÄŸil, faturanÄ±n ne OLDUÄUdur: karÅŸÄ± tarafÄ±n elindeki bir
belge. DÃ¼zeltme iptal+yeniden dÃ¼zenleme ya da iade faturasÄ±yla yapÄ±lÄ±r.

**Bilerek DONMAYAN:** `status`, `paid_amount`, iptal/kapatma meta verisi, `notes`, `updated_at`.
DÃ¼zenlenmiÅŸ faturaya tahsilat iÅŸlenebilmeli â€” guard'Ä± buraya kadar geniÅŸletmek, 0027'nin
"satÄ±r kullanÄ±lamaz hale geldi" hatasÄ±nÄ± baÅŸka kÄ±lÄ±kta tekrarlamak olurdu. `phase21:verify`
guard'Ä±n Ã§ok geniÅŸ OLMADIÄINI ayrÄ±ca test ediyor.

### 0045 â€” invoice_lines

Miktar ve birim fiyat `numeric(_,4)` (talaÅŸlÄ± imalatta 12,3456 TL birim fiyat olaÄŸan; kalem
dÃ¼zeyinde kuruÅŸa yuvarlamak tedarikÃ§inin kendi belgesiyle uyuÅŸmazlÄ±k yaratÄ±r), kalem tutarlarÄ±
TL Ã¶lÃ§eÄŸinde ve aynÄ± `gross = net + tax` deÄŸiÅŸmezi.

Kalemler baÅŸlÄ±ÄŸÄ±n dokunulmazlÄ±ÄŸÄ±nÄ± izler: baÅŸlÄ±ÄŸÄ± dondurup kalemleri serbest bÄ±rakmak tiyatro
olurdu â€” toplam sabit kalÄ±rken altÄ±ndaki detay deÄŸiÅŸirdi. Tek fonksiyon INSERT/UPDATE/DELETE'i
birlikte kapsÄ±yor ki arada boÅŸluk kalmasÄ±n. Parent satÄ±r yoksa (ON DELETE CASCADE Ã§alÄ±ÅŸÄ±yordur)
guard geÃ§it veriyor, aksi halde taslak fatura bile silinemezdi.

**DÃ¼zenlenmiÅŸ fatura SÄ°LÄ°NEMEZ** (ayrÄ± trigger): iptal reversal kaydÄ± bÄ±rakÄ±r, DELETE hiÃ§bir ÅŸey
bÄ±rakmaz â€” denetim izinin atlatamayacaÄŸÄ± tek sonuÃ§ budur. Taslaklar silinebilir kalÄ±r.

### 0046 â€” invoice_reversals: iptal = baÄŸlÄ± kayÄ±t, sessiz durum deÄŸiÅŸimi DEÄÄ°L

`status='cancelled'` yalnÄ±z "geÃ§ersiz mi" sorusunu yanÄ±tlar; kimin, ne zaman, neden iptal
ettiÄŸini ve â€” asÄ±l Ã¶nemlisi â€” **faturanÄ±n iptal anÄ±nda NE DEDÄ°ÄÄ°NÄ°** yanÄ±tlayamaz. Bu yÃ¼zden her
iptal, faturanÄ±n ve kalemlerinin dondurulmuÅŸ JSON kopyasÄ±nÄ± taÅŸÄ±yan bir kayÄ±t yazar.

- 0022'nin **salt-ekleme** kurgusu (UPDATE/DELETE/TRUNCATE superuser dahil reddedilir).
- Fatura baÅŸÄ±na **en fazla bir `cancellation`** (partial unique index); iade faturasÄ± birden
  fazla olabilir.
- **`invoices_require_reversal_record`** â€” DEFERRABLE constraint trigger: baÄŸlÄ± kaydÄ± olmayan bir
  `cancelled` fatura COMMIT edilemez. Bu olmasaydÄ± tasarÄ±m tavsiye niteliÄŸinde kalÄ±rdÄ±; bir kod
  yolu 0044'Ã¼n CHECK'ini saÄŸlayÄ±p arkasÄ±nda hiÃ§bir kayÄ±t bÄ±rakmayabilirdi.

#### `invoice_id` neden FK DEÄÄ°L â€” ve bunu ne ortaya Ã§Ä±kardÄ±

Ä°lk taslak `references public.invoices(id) on delete restrict` diyordu ve **`pnpm import:real`
anÄ±nda dÃ¼ÅŸtÃ¼**. `scripts/import-real.ts` `truncate public.source_workbooks cascade` Ã§alÄ±ÅŸtÄ±rÄ±yor;
faturalar `source_workbook_id` lineage kolonu taÅŸÄ±yor; ve **TRUNCATE CASCADE, ON DELETE
eylemine bakmaksÄ±zÄ±n referans veren HER tabloyu izliyor** â€” bÃ¶ylece cascade bu tabloya ulaÅŸtÄ± ve
salt-ekleme trigger'Ä± meÅŸru bir geliÅŸtirme sÄ±fÄ±rlamasÄ±nÄ± iptal etti.

Normal iÅŸleyiÅŸi bozacak kadar geniÅŸ Ã§izilmiÅŸ bir guard, 0027 hatasÄ±nÄ±n baÅŸka kÄ±lÄ±ÄŸÄ±dÄ±r.

FK'yÄ± kaldÄ±rmak bunu yan etki olarak Ã§Ã¶zÃ¼yor ama baÄŸÄ±msÄ±z olarak da doÄŸru ÅŸekil â€” ve bu depoda
zaten emsali var: 0037'nin `iban_change_events.iban_id`'si aynÄ± gerekÃ§eyle FK deÄŸil. **Bir
append-only kanÄ±t tablosuna cascade edebilen her tablo, o kanÄ±tÄ± yok edebilir.** BÃ¼tÃ¼nlÃ¼k ait
olduÄŸu yerde korunuyor: engine faturayÄ± yazmadan Ã¶nce Ã§Ã¶zÃ¼p kilitliyor, ve yukarÄ±daki deferred
trigger kayÄ±tsÄ±z bir iptali reddediyor.

### 0047 â€” beÅŸ view

`invoice_open_items` (yaÅŸlandÄ±rma kovalarÄ±yla), `invoice_duplicate_suspects`,
`invoice_line_mismatches`, `invoice_overpaid`, `invoice_party_summary`. KalÄ±cÄ± kolon deÄŸil â€”
0039/0043 ile aynÄ± gerekÃ§e.

**Duplicate tespiti** (karÅŸÄ± taraf + numara + tutar + tarih) iki ayrÄ± sinyal olarak raporlanÄ±yor:
`same_number` (neredeyse her zaman gerÃ§ek duplicate) ve `near_match` (aynÄ± tutar, 7 gÃ¼n iÃ§inde,
FARKLI numara â€” tedarikÃ§inin yeni numarayla yeniden gÃ¶nderdiÄŸi durumu yakalar). Ä°ptal edilen
faturalar listeden dÃ¼ÅŸÃ¼yor, Ã§Ã¼nkÃ¼ birini iptal etmek duplicate'i Ã§Ã¶zmenin ta kendisidir.

**Duplicate ENGELLENMEZ.** `bank_transactions.dedupe_hash` unique'tir Ã§Ã¼nkÃ¼ Ã¶rtÃ¼ÅŸen ekstre
dÃ¶nemini yeniden indirmek mekanik ve beklenen bir iÅŸtir; doÄŸru cevap "mevcut satÄ±ra dÃ¼ÅŸ"tÃ¼r.
Fatura duplicate'i baÅŸka bir hayvandÄ±r: insan ya da tedarikÃ§i hatasÄ±dÄ±r, iki satÄ±r anlamlÄ±
ÅŸekilde farklÄ± olabilir, ve ikincisini reddetmek operatÃ¶rÃ¼ ya rakamÄ± Ã§arpÄ±tmaya ya iÃ§e aktarmayÄ±
bÄ±rakmaya zorlar. Tespit edilir ve bildirilir; sessizce birleÅŸtirilmez de engellenmez de.

**BaÅŸlÄ±k/kalem uyuÅŸmazlÄ±ÄŸÄ±** da raporlanÄ±r, engellenmez: kalemler zorunlu olarak baÅŸlÄ±ktan SONRA
yazÄ±lÄ±r, dolayÄ±sÄ±yla engelleyen bir trigger ya deferred olmak (ve tek bozuk satÄ±r iÃ§in tÃ¼m iÃ§e
aktarma transaction'Ä±nÄ± dÃ¼ÅŸÃ¼rmek) ya da normal ekleme sÄ±rasÄ±nÄ± yasaklamak zorunda kalÄ±rdÄ±. Bu
sÄ±nÄ±f iÃ§in deponun yerleÅŸik cevabÄ± nakit-akÄ±ÅŸ kimlik kontrolÃ¼dÃ¼r: hesapla, gÃ¶ster, insan karar
versin.

## Tahsilat/Ã–deme EÅŸleme ve Cari Hesap (Faz 22, migration 0048-0050)

### 0048 â€” invoice_allocations ve Â§18'in ilk gerÃ§ek testi

**Zorlanan deÄŸiÅŸmez:** `Î£(aÃ§Ä±k daÄŸÄ±tÄ±m) â‰¤ invoices.gross_amount` â€” her zaman, istisnasÄ±z.
implementation.md Â§18 bunu "Ã¶denen > fatura, tahsilat > alacak hiÃ§ aÅŸÄ±lmamalÄ±" diye yazÄ±yor ve
uygulama-seviyesi kontrolÃ¼n yetmeyeceÄŸini aÃ§Ä±kÃ§a sÃ¶ylÃ¼yor. Bu yÃ¼zden **trigger**, konvansiyon
deÄŸil.

**Neden CHECK deÄŸil trigger:** CHECK tek satÄ±r gÃ¶rÃ¼r. Bu deÄŸiÅŸmez, BAÅKA bir tablodaki bir
deÄŸere karÅŸÄ± Ã‡OK satÄ±rÄ±n toplamÄ± hakkÄ±ndadÄ±r; hiÃ§bir CHECK bunu ifade edemez.
`allocations_enforce_invoice_ceiling()` INSERT/UPDATE/DELETE'in Ã¼Ã§Ã¼nde de Ã§alÄ±ÅŸÄ±r â€” arada boÅŸluk
kalmasÄ±n diye.

**Tek tablo, iki deÄŸil.** Plan `payment_allocations`/`collection_allocations` diyor. Ä°kisi
kolon kolon aynÄ± olurdu (yÃ¶n zaten `invoices.direction`'dan belli) ve ayÄ±rmak, tavan
deÄŸiÅŸmezinin Ä°KÄ° tablo Ã¼zerinden Ä°KÄ° trigger'la toplanmasÄ±nÄ± gerektirirdi â€” sonsuza dek
birbiriyle uyumlu kalmalarÄ± gereken iki trigger. Tek tablo = tek trigger = deÄŸiÅŸmezin yaÅŸadÄ±ÄŸÄ±
tek yer. PlanÄ±n istediÄŸi iki isim 0050'de **filtrelenmiÅŸ view** olarak saÄŸlanÄ±yor, yani sÃ¶z
daÄŸarcÄ±ÄŸÄ± korunuyor.

**Status kolonu YOK.** Bir daÄŸÄ±tÄ±m ya vardÄ±r ya iptal edilmiÅŸtir; `reversed_at` nullable bir
zaman damgasÄ±dÄ±r ve kÄ±sÄ±tlanacak geÃ§iÅŸi yoktur. Faz 20 (`match_candidates`) ve Faz 19 (boyut
tablolarÄ±) ile aynÄ± karar: Â§17 kural 3 her yeni yaÅŸam dÃ¶ngÃ¼sÃ¼ iÃ§in EKSÄ°KSÄ°Z bir guard ÅŸart
koÅŸuyor, ve gerekmeyen bir fazda ona uymanÄ±n yolu yaÅŸam dÃ¶ngÃ¼sÃ¼ icat etmemektir.

#### `paid_amount` ile `allocated_amount` farkÄ± â€” muhasebe farkÄ±, ayrÄ±ntÄ±cÄ±lÄ±k deÄŸil

| kolon | anlamÄ± | tavan |
| --- | --- | --- |
| `paid_amount` (Faz 21) | bu faturaya karÅŸÄ± **kaydedilmiÅŸ** para | YOK â€” fazla tahsilat gerÃ§ektir (mÃ¼kerrer transfer, bankada kur farkÄ±) ve engellemek operatÃ¶rÃ¼ kaydÄ± Ã§arpÄ±tmaya zorlar |
| `allocated_amount` (Faz 22) | bu paranÄ±n faturaya **resmen atanmÄ±ÅŸ** kÄ±smÄ± | fatura tutarÄ± â€” 120'lik faturaya 130 atamak fazla tahsilat deÄŸil, 10'unun **baÅŸka yere ait olmasÄ±**dÄ±r |

SonuÃ§: fazla tahsilat `paid_amount > gross`, `allocated_amount = gross` olarak gÃ¶rÃ¼nÃ¼r ve
daÄŸÄ±tÄ±lmamÄ±ÅŸ kalan **kaynak tarafÄ±nda** (`settlement_unallocated`) durur.

#### CASCADE burada gÃ¼venli â€” ve 0046'nÄ±n hatasÄ± deÄŸil

`invoice_allocations.invoice_id` FK'sÄ± `ON DELETE CASCADE`. Bu tabloda salt-ekleme trigger'Ä±
YOK, dolayÄ±sÄ±yla staging'den gelen bir `TRUNCATE CASCADE` onu temizler ki geliÅŸtirme sÄ±fÄ±rlamasÄ±
iÃ§in doÄŸru davranÄ±ÅŸ budur. 0046'nÄ±n yaÅŸadÄ±ÄŸÄ± sorun tam olarak append-only bir kanÄ±t tablosuna
cascade edilmesiydi; burada Ã¶yle bir tablo yok.

Trigger, fatura satÄ±rÄ± yoksa (cascade/truncate Ã§alÄ±ÅŸÄ±yordur) sessizce geÃ§iyor â€” orada hata
vermek meÅŸru bir sÄ±fÄ±rlamayÄ± imkÃ¢nsÄ±z kÄ±lardÄ±, 0046'nÄ±n Ã¶ÄŸrendiÄŸi ders.

**YaÅŸam dÃ¶ngÃ¼sÃ¼ kapÄ±sÄ±:** daÄŸÄ±tÄ±m yalnÄ±z `open`/`partial`/`paid` faturaya yapÄ±labilir. `draft`
dÃ¼zenlenmemiÅŸtir, `cancelled` geÃ§ersizdir, `closed` kapatÄ±lmÄ±ÅŸtÄ±r (Ã¶nce aÃ§Ä±lmalÄ±). Kontrol
yalnÄ±z daÄŸÄ±tÄ±m kÃ¼mesi BÃœYÃœRKEN uygulanÄ±yor; iptal/temizlik kapalÄ± veya iptal edilmiÅŸ faturada da
mÃ¼mkÃ¼n kalÄ±yor â€” temizliÄŸi engelleyen bir guard, Ã§ok geniÅŸ Ã§izilmiÅŸ bir guard'dÄ±r.

### 0049 â€” bank_transactions eÅŸleÅŸme hedefinin GENÄ°ÅLETÄ°LMESÄ°

Faz 20 `matched_entity_table` CHECK'ini o gÃ¼n var olan Ã¼Ã§ entity ile gÃ¶ndermiÅŸti; 0043'Ã¼n notu
"invoices/collections Faz 22'de kendi migration'Ä±nda bu CHECK'i geniÅŸletecek" diyordu. Bu, o
migration.

`bank_transactions` Ã¼zerinde `matched_entity_table` geÃ§en **iki** CHECK var
(`..._matched_entity_table_check` = deÄŸer listesi, `..._match_consistency` = null eÅŸleÅŸmesi).
YalnÄ±z birincisi deÄŸiÅŸtirildi ve **adÄ±yla** hedeflendi â€” metin aramasÄ±yla deÄŸil. Faz 20'nin gate
dersi DDL iÃ§in de geÃ§erli: `like '%matched_entity_table%'` ikisini de bulur ve "bulduÄŸunu
dÃ¼ÅŸÃ¼reni" deÄŸiÅŸtiren bir migration, tutarlÄ±lÄ±k kuralÄ±nÄ± sessizce silebilirdi.

`bank_transaction_match_candidates.target_table` CHECK'i **aynÄ± anda** geniÅŸletildi. Birini
geniÅŸletip diÄŸerini bÄ±rakmak, eÅŸleÅŸtiricinin artÄ±k eÅŸleÅŸmesine izin verilen ÅŸeyi hiÃ§
Ã–NEREMEMESÄ° demekti â€” tam olarak 0027'nin biÃ§imi.

**GeniÅŸletme, daraltma deÄŸil:** mevcut her satÄ±r yeni constraint'i inÅŸaen saÄŸlÄ±yor, doÄŸrulanacak
bir ÅŸey yok. "NOT VALID ekle, ayrÄ± dilimde VALIDATE" kuralÄ± (0023/0026 â†’ 0029/0030) mevcut veriyi
REDDEDEBÄ°LECEK constraint'ler iÃ§indir; 0041'in `detected_type` geniÅŸletmesiyle aynÄ± gerekÃ§e.

### 0050 â€” receivables/payables VIEW olarak (aÃ§Ä±k tasarÄ±m kararÄ±, kapatÄ±ldÄ±)

implementation.md bunu aÃ§Ä±k bÄ±rakmÄ±ÅŸtÄ±. Uygulanan test basitti: bir alacaÄŸÄ±n BUGÃœN, faturasÄ±nÄ±n
zaten taÅŸÄ±madÄ±ÄŸÄ± tek bir Ã¶zniteliÄŸi var mÄ±?

| | |
| --- | --- |
| karÅŸÄ± taraf, tutar, para birimi, dÃ¼zenleme/vade tarihi | faturada |
| ne kadarÄ± hÃ¢lÃ¢ borÃ§lu | `gross âˆ’ allocated` (0048) |
| yaÅŸlandÄ±rma kovasÄ± | `due_date`'ten tÃ¼retilir |
| tahsil / zarar yazÄ±ldÄ± / iptal | `invoices.status` |

Geriye hiÃ§bir ÅŸey kalmÄ±yor. BugÃ¼n bir receivables TABLOSU bu kolonlarÄ±n her birini kopyalar ve
faturada yaÅŸayan tutarlar iÃ§in **anÄ±nda ikinci bir gerÃ§ek kaynak** olurdu â€” bu ÅŸemanÄ±n zaten
Ä±sÄ±rÄ±ldÄ±ÄŸÄ± bayatlama (0034 Ã¶ncesi `paid_count` KPI'Ä± Faz 5'ten beri 0 dÃ¶nÃ¼yordu; 0039/0043/0047
hep aynÄ± sebeple view).

Tabloyu haklÄ± Ã§Ä±karacak ÅŸeyler gerÃ§ek ama bu fazda yok: **promise-to-pay** tarihi
(implementation.md Â§1c ayrÄ± bir gelecek entity olarak listeliyor), dunning/tahsilat durumu,
alacak-bazlÄ± sorumluluk atamasÄ±. Bunlar geldiÄŸinde kendi Ã¶znitelikleriyle ve kendi yaÅŸam
dÃ¶ngÃ¼leriyle gelir â€” terfi anÄ± O'dur, kendi migration'Ä± ve kendi eksiksiz transition-guard'Ä±yla.
Åimdi terfi ettirmek, iÃ§ine koyacak bir ÅŸey olmadan yaÅŸam dÃ¶ngÃ¼sÃ¼ icat etmek olurdu; Â§17 kural 3
tam da bunu Ã¶nlemek iÃ§in var.

#### YaÅŸlandÄ±rma: Faz 22'nin kovalarÄ± Faz 21'den FARKLI, kasÄ±tlÄ±

0047'nin `invoice_open_items`'Ä± 1-30/31-60/61-90/90+ kullanÄ±yor â€” klasik AR **raporlama**
yaÅŸlandÄ±rmasÄ±. Faz 22 ise 1-7/8-30/31-60/60+ istiyor: bu bir **tahsilat-aciliyeti**
yaÅŸlandÄ±rmasÄ±dÄ±r. Ä°lk ayÄ± bÃ¶ler Ã§Ã¼nkÃ¼ mÃ¼ÅŸterinin Ã¼Ã§ gÃ¼n mÃ¼ Ã¼Ã§ hafta mÄ± geciktiÄŸi bugÃ¼n ne
yapacaÄŸÄ±nÄ± deÄŸiÅŸtirir; 60'tan sonra bÃ¶lmeyi bÄ±rakÄ±r Ã§Ã¼nkÃ¼ orada aksiyon zaten aynÄ±dÄ±r. Ä°kisi de
amacÄ±na gÃ¶re doÄŸru, ikisi de korunuyor, ve `phase22:verify` TS ile SQL uygulamasÄ±nÄ± aynÄ±
satÄ±rlara karÅŸÄ± karÅŸÄ±laÅŸtÄ±rÄ±yor ki birbirinden ayrÄ±lmasÄ±nlar.

#### DSO/DPO: view bileÅŸenleri verir, oranÄ± DEÄÄ°L

Bir view parametre alamaz ve bir dÃ¶nemi SQL'e gÃ¶mmek, herkesin alÄ±ntÄ±ladÄ±ÄŸÄ± ama pek azÄ±nÄ±n aynÄ±
tanÄ±mladÄ±ÄŸÄ± bir metrikte en kritik varsayÄ±mÄ± gizlemek olurdu. `dso_dpo_components` ham sayÄ±larÄ±
verir; `src/lib/receivables/rules.ts` oranÄ± formÃ¼lÃ¼ yazÄ±lÄ± ve birim-testli biÃ§imde hesaplar.

    DSO = (aÃ§Ä±k alacak / dÃ¶nem satÄ±ÅŸÄ±) Ã— dÃ¶nem gÃ¼nÃ¼

DÃ¶nemde satÄ±ÅŸ yoksa sonuÃ§ **null**, sÄ±fÄ±r deÄŸil: sÄ±fÄ±r, hiÃ§bir ÅŸey satmamÄ±ÅŸ bir ÅŸirket iÃ§in
"mÃ¼ÅŸteriler anÄ±nda Ã¶dÃ¼yor" demektir â€” mÃ¼mkÃ¼n olan en kÃ¶tÃ¼ Ã§eyreÄŸin en pohpohlayÄ±cÄ± okumasÄ±.

#### Cari hesap kartÄ±: alacak ve borÃ§ NETLEÅTÄ°RÄ°LMEZ

`current_account_summary` ikisini ayrÄ± tutar. Mahsup, iki taraf arasÄ±nda **hukuki** bir iÅŸlemdir,
aritmetik bir iÅŸlem deÄŸil; burada netlemek var olmayan bir anlaÅŸmayÄ± sessizce varsaymak olurdu.

`counterparty_settlement_speed` **gerÃ§ekleÅŸmiÅŸ** sÃ¼redir: yalnÄ±z tahsil edilmiÅŸ faturalarÄ± sayar.
Ã–denmemiÅŸ bir faturanÄ±n tahsilat sÃ¼resi yoktur, ve onu sÄ±fÄ±r (ya da bugÃ¼nâˆ’dÃ¼zenleme) saymak karÅŸÄ±
tarafÄ± olmadÄ±ÄŸÄ± kadar iyi ya da kÃ¶tÃ¼ gÃ¶sterirdi.

## Alacak/BorÃ§ YÃ¶netimi GeniÅŸletme (Faz 23, migration 0051-0052)

Faz 19-22'nin Ã¼zerine read-model; yeni kaynak veri yok. Tek yazÄ±labilir ekleme, elle konulan
ÅŸÃ¼pheli-alacak bayraÄŸÄ±.

### 0051 â€” bad-debt: ELLE konulan, DENETLENEN bayrak

**Bu fazda bu kolonlarÄ± yazan hiÃ§bir kural, trigger veya zamanlanmÄ±ÅŸ iÅŸ YOK.** "90 gÃ¼nÃ¼ geÃ§erse
iÅŸaretle" tÃ¼rÃ¼ hiÃ§bir sezgi eklenmedi. CLAUDE.md'nin kaynak-doÄŸruluk kuralÄ± aÃ§Ä±k â€” AI hiÃ§bir
kaydÄ± Ã¶dendi iÅŸaretleyemez, silemez, belirsiz satÄ±rdan nihai gerÃ§eÄŸi Ã§Ä±karamaz â€” ve bir alacaÄŸÄ±
zarar yazmak tam olarak o kuralÄ±n insan elinde tutmak istediÄŸi yargÄ±dÄ±r. 0052'nin skorlarÄ± bir
faturanÄ±n tahsil edilemez gÃ¶rÃ¼ndÃ¼ÄŸÃ¼nÃ¼ sÃ¶yleyebilir; **o gÃ¶rÃ¼ÅŸe gÃ¶re hareket edemez.**

KolonlarÄ± yazan tek kod yolu `src/lib/collections/engine.ts`'in `markBadDebt()`/`clearBadDebt()`
fonksiyonlarÄ±: tipli bir gerekÃ§e ÅŸart ve kanonik `audit()` Ã¼zerinden kaydediliyor.
`phase23:verify` bunu iki yÃ¶nden doÄŸruluyor â€” `src/` iÃ§inde baÅŸka yazar olmadÄ±ÄŸÄ±nÄ± grep'le, ve
`bad_debt_at`'i gÃ¼ncelleyen bir PL/pgSQL fonksiyonu olmadÄ±ÄŸÄ±nÄ± katalogdan.

**Neden bayrak, neden durum deÄŸil.** `invoices.status` zaten zarar yazma iÃ§in `closed`, iptal
iÃ§in `cancelled` taÅŸÄ±yor. ÅÃ¼pheli alacak ikisi de deÄŸil: hÃ¢lÃ¢ **aÃ§Ä±k** olan ve hÃ¢lÃ¢ tahsil
edilebilecek bir faturanÄ±n Ã¼zerine konan bir **deÄŸerlendirme**. Firmalar iÅŸaretli alacaÄŸÄ±
dÃ¼zenli olarak tahsil eder; gÃ¶rÃ¼ÅŸÃ¼ kaydetmek iÃ§in faturayÄ± `open`'dan Ã§Ä±karmak, o tahsilatÄ± bir
diriliÅŸ gibi gÃ¶sterirdi. DolayÄ±sÄ±yla nullable bir zaman damgasÄ± â€” 0048'in `reversed_at`'i ve
0037'nin `is_active`'iyle aynÄ± ÅŸekil â€” ve Â§17 kural 3 N/A kalÄ±yor Ã§Ã¼nkÃ¼ ortada yaÅŸam dÃ¶ngÃ¼sÃ¼ yok.

KÄ±sÄ±tlar: Ã¼Ã§ kolon (`bad_debt_at`/`bad_debt_reason`/`bad_debt_by`) birlikte hareket eder ve
gerekÃ§e boÅŸ olamaz â€” **gerekÃ§esi ve yazarÄ± olmayan bir zarar yazma, imzasÄ±z bir suÃ§lamadÄ±r.**
AyrÄ±ca iptal edilmiÅŸ faturaya bayrak konamaz (ortada borÃ§ yok); iki bayraÄŸÄ±n farklÄ± kod
yollarÄ±ndan gelip Ã§eliÅŸmesi tam da bÃ¶yle olur.

Bu kolonlar 0044'Ã¼n iÃ§erik-dokunulmazlÄ±k listesinde **bilerek yok**: dÃ¼zenlenmiÅŸ faturanÄ±n
ticari iÃ§eriÄŸi donmuÅŸtur, ama tahsil edilebilirliÄŸe dair bir deÄŸerlendirme o iÃ§eriÄŸin parÃ§asÄ±
deÄŸildir ve belgenin Ã¶mrÃ¼ boyunca yazÄ±labilir kalmalÄ±dÄ±r.

### 0052 â€” dÃ¶rt read-model view

**YalnÄ±z OLGU Ã¼retirler.** GÃ¼n cinsinden gecikme, bu karÅŸÄ± tarafÄ±n geÃ§miÅŸte gerÃ§ekte ne yaptÄ±ÄŸÄ±,
ne kadarÄ±nÄ±n aÃ§Ä±k olduÄŸu, bir insanÄ±n bayrak koyup koymadÄ±ÄŸÄ±. OlasÄ±lÄ±k ya da skor
hesaplamazlar â€” skorlama `src/lib/collections/rules.ts`'te adlandÄ±rÄ±lmÄ±ÅŸ kurallar tablosu
olarak duruyor ki her sonuÃ§ onu Ã¼reten kurala kadar izlenebilsin ve o kural dÃ¼zeltilerek
dÃ¼zeltilebilsin. implementation.md "deterministik sezgi (ML deÄŸil)" istiyor; bir model bir mali
operatÃ¶re "neden" sorusunu yanÄ±tlayamaz ve birini kovalayÄ±p kovalamamaya karar verirken Ã¶nemli
olan tek soru odur.

- **`receivable_collection_signals`** â€” aÃ§Ä±k alacak baÅŸÄ±na ham girdi. KarÅŸÄ± tarafÄ±n geÃ§miÅŸi Faz
  22'nin gerÃ§ekleÅŸmiÅŸ tahsilat hÄ±zÄ±ndan geliyor (GÃ–ZLENMÄ°Å deÄŸer, tahmin deÄŸil) ve bu karÅŸÄ±
  taraf hiÃ§ bir ÅŸey Ã¶dememiÅŸse **null** â€” skorlayÄ±cÄ± bunu "bilinmiyor" saymak zorunda, "hÄ±zlÄ±"
  deÄŸil. `late_ratio` da gÃ¶zlemdir: vadesi olmayan faturalar hesaba **katÄ±lmaz**, Ã§Ã¼nkÃ¼ tarihsiz
  bir fatura geÃ§ kalamaz ve onu "zamanÄ±nda" saymak karÅŸÄ± tarafÄ± pohpohlardÄ±.
- **`payment_priority_queue`** â€” Ã¶deme kalemleri + alÄ±ÅŸ faturalarÄ± + kredi taksitleri + Ã§Ä±kÄ±ÅŸ
  Ã§ekleri tek listede. **MEVCUT payments modÃ¼lÃ¼nÃ¼ besler**: sÄ±ralama girdileri `payments`'Ä±n
  zaten taÅŸÄ±dÄ±ÄŸÄ± `flexibility_class` ve `priority` kolonlarÄ±, burada icat edilmiÅŸ yeni bir
  taksonomi deÄŸil â€” paralel bir Ã¶ncelik ÅŸemasÄ± "Ã¶nce neyi Ã¶deyeceÄŸiz" sorusuna iki cevap demek
  olurdu. View bir **SIRA** Ã¼retir, bir karar deÄŸil: nakit bakiyesini bilmez, kesme noktasÄ±
  okuma anÄ±nda TypeScript'te uygulanÄ±r. Hangi tedarikÃ§inin Ã¶denmeyeceÄŸine SQL'de sessizce karar
  veren bir view, iÅŸ kararÄ±nÄ± yanlÄ±ÅŸ yerde vermiÅŸ olurdu.
- **`payment_calendar_extended`** â€” gÃ¼n bazÄ±nda toplam; **tutarÄ± bilinmeyen yÃ¼kÃ¼mlÃ¼lÃ¼kler
  SAYILIR, sÄ±fÄ±r olarak toplanmaz.** DÃ¶rt tutarsÄ±z yÃ¼kÃ¼mlÃ¼lÃ¼ÄŸÃ¼ olan gÃ¼n ucuz bir gÃ¼n deÄŸildir.
- **`counterparty_collection_profile`** â€” karÅŸÄ± taraf karnesi; her kolon olmuÅŸ bir ÅŸeyin sayÄ±mÄ±
  veya ortalamasÄ±, hiÃ§biri Ã¶ngÃ¶rÃ¼ deÄŸil.

### Deterministik skorlama (`src/lib/collections/rules.ts`)

**Beklenen tahsilat tarihi**, ilk eÅŸleÅŸen kural kazanÄ±r:
1. KarÅŸÄ± taraf **en az 3** fatura tahsil etmiÅŸse â†’ dÃ¼zenleme tarihi + gerÃ§ekleÅŸmiÅŸ ortalamasÄ±.
   ÃœÃ§ bilinÃ§li bir alt sÄ±nÄ±r: tek faturalÄ±k ortalama bir anekdottur ve onu tahmin diye sunmak
   tam da bu fazÄ±n kaÃ§Ä±nmasÄ± gereken sahte gÃ¼vendir.
2. Vade varsa â†’ vade (karÅŸÄ± tarafÄ±n kendi sÃ¶zÃ¼, elde kalan en iyi kanÄ±t).
3. HiÃ§biri yoksa â†’ dÃ¼zenleme + 30, **aÃ§Ä±kÃ§a "fallback" etiketiyle**.
SonuÃ§ Ã¶denmemiÅŸ bir fatura iÃ§in asla geÃ§miÅŸte olamaz; geÃ§miÅŸteki bir "beklenen" tarih beklenti
deÄŸil gecikme ihbarÄ±dÄ±r. `basis` her zaman hangi kuralÄ±n Ã§alÄ±ÅŸtÄ±ÄŸÄ±nÄ± sÃ¶yler.

**Tahsilat olasÄ±lÄ±ÄŸÄ±** taban 0.95'ten adlandÄ±rÄ±lmÄ±ÅŸ ayarlamalarla iniyor; her sonuÃ§ **onu Ã¼reten
sinyalleri** birlikte dÃ¶ndÃ¼rÃ¼r. GerekÃ§esiz bir sayÄ± eyleme dÃ¶nÃ¼ÅŸtÃ¼rÃ¼lemez â€” operatÃ¶r 0.45'in
"bu mÃ¼ÅŸteri yavaÅŸ" mÄ± yoksa "geÃ§en hafta iÅŸaretledik" mi demek olduÄŸunu ayÄ±rt edemez ve ikisi
zÄ±t tepkiler gerektirir. ÅÃ¼pheli-alacak bayraÄŸÄ± her ÅŸeyi bastÄ±rÄ±r ama **sÄ±fÄ±ra indirmez**:
iÅŸaretli alacak da tahsil edilir ve sert bir sÄ±fÄ±r, tahsilat listesine "denemeyi bÄ±rak" derdi.

**Risk bayraklarÄ±** yalnÄ±z olgudan; yoÄŸunlaÅŸma eÅŸiÄŸi deponun baÅŸka yerlerinde zaten kullanÄ±lan
**0.40** (radar/rules.ts, financing/rules.ts), neredeyse aynÄ± ÅŸeyi ifade eden ikinci bir sayÄ±
deÄŸil.

**Nakde duyarlÄ± sÄ±ralama** bir Ã¶neridir: hiÃ§bir kalem atlanmaz, karÅŸÄ±lanamayan kalem **dÃ¼ÅŸÃ¼rÃ¼lmez
iÅŸaretlenir** â€” liste operatÃ¶rÃ¼n pazarlÄ±k edeceÄŸi ÅŸeydir ve sÄ±ÄŸmayan kalemleri gizlemek asÄ±l
sorunu gizlerdi. **TutarÄ± bilinmeyen kalemler sÄ±ralanÄ±r ama kÃ¼mÃ¼latif toplama katÄ±lmaz** ve asla
"karÅŸÄ±lanÄ±yor" sayÄ±lmaz; onlarÄ± sÄ±fÄ±r saymak nakdin gittiÄŸinden daha uzaÄŸa gittiÄŸini
gÃ¶stermek olurdu â€” bu uygulamanÄ±n yapabileceÄŸi en tehlikeli yuvarlama.

### Faz 4/5 regresyon yÃ¼zeyi

Bu faz mevcut vade/gecikme mantÄ±ÄŸÄ±nÄ± **geniÅŸletir, deÄŸiÅŸtirmez**: `payment_instances` ve
`cashflow_months` ÅŸemasÄ±na dokunulmadÄ±, `payments`'Ä±n Ã¶ncelik kolonlarÄ± olduÄŸu gibi okundu.
`phase23:verify` radar kolonlarÄ±nÄ±n yerinde olduÄŸunu yapÄ±sal olarak kontrol ediyor;
`phase4:verify` ve `phase5:verify` gate zincirinde deÄŸiÅŸmeden koÅŸuyor.

---

## Onay / Maker-Checker (Faz 24A, migration 0053-0055)

Bu faz **yeni bir iÅŸ alanÄ± aÃ§mÄ±yor**; var olan iki baÄŸÄ±msÄ±z inceleme sistemini tek bir Onay
varlÄ±ÄŸÄ±nda topluyor. Faz 24A'nÄ±n asÄ±l teslimatÄ± `approvals` tablosu deÄŸil, **hiÃ§bir eski yazÄ±m
yolunun davranÄ±ÅŸÄ±nÄ±n deÄŸiÅŸmemiÅŸ olmasÄ±**.

### Ã–nce Ã¶lÃ§Ã¼ldÃ¼: ortada tam olarak ne vardÄ±

| Sistem | Kolon | DeÄŸerler | Guard | Yazan |
|---|---|---|---|---|
| `mapping_reviews` | `status` | open Â· accepted Â· rejected Â· resolved | **yok** | `imports/actions.ts` + 6 gate scripti |
| `external_assumptions` | `review_status` | pending_review Â· approved Â· rejected | **yok** | `external-assumptions/engine.ts` |

Ä°ki ayrÄ±ntÄ± taÅŸÄ±mayÄ± tÃ¼mÃ¼yle belirledi:

1. **HiÃ§birinde transition guard yok** ve altÄ± gate scripti (`phase3`, `phase4`, `phase5`,
   `phase12a`, `phase13a`) statÃ¼yÃ¼ keyfÃ® olarak sÄ±Ã§ratÄ±yor â€” `update mapping_reviews set
   status='resolved'` satÄ±rÄ±n o an ne olduÄŸuna bakmadan yazÄ±lÄ±yor. Bu kolonlara guard eklemek
   altÄ± doÄŸrulanmÄ±ÅŸ gate'i ilk keyfÃ® sÄ±Ã§ramada kÄ±rardÄ±; yani 0027 hatasÄ±nÄ±n bilerek tekrarÄ± olurdu.
2. `external_assumptions.reviewed_at` **yalnÄ±z `approved`'da** taÅŸÄ±nÄ±yor, diÄŸer durumlarda
   korunuyor. Bu yÃ¼k taÅŸÄ±yan bir semantik: `external_assumptions_check1` kÄ±sÄ±tÄ±
   "internet kaynaklÄ± + approved â‡’ reviewed_at dolu" diyor.

Bu yÃ¼zden **legacy kolonlarÄ±n hiÃ§biri deÄŸiÅŸtirilmedi**: guard eklenmedi, deÄŸer yeniden yazÄ±lmadÄ±,
varsayÄ±lan oynatÄ±lmadÄ±.

### 0053 â€” `approvals` + `approval_steps`

`approvals` polimorfik Ã¶zneli tek onay varlÄ±ÄŸÄ± (`subject_table` + `subject_id`); iki legacy sistem
ilk gÃ¼nden Ã¼ye. StatÃ¼ izin listesi CHECK ile **aynÄ± migration'da**:

| Eski | Yeni | Anlam |
|---|---|---|
| pending | approved | kontrolÃ¶r onayladÄ± |
| pending | rejected | kontrolÃ¶r reddetti |
| pending | reworked | dÃ¼zeltilmek Ã¼zere geri |
| reworked | pending | talep eden yeniden gÃ¶nderdi |
| reworked | rejected | yeniden gÃ¶nderilmeden bÄ±rakÄ±ldÄ± |

`approved` ve `rejected` **terminal**. Sessizce geri alÄ±nabilen bir karar, karar deÄŸildir; yeniden
aÃ§mak yeni bir **tur**dur (`round_no`). `phase24a:verify` 12 sÄ±ralÄ± Ã§iftin tamamÄ±nÄ± gerÃ§ek satÄ±rlar
Ã¼stÃ¼nde deniyor: 5 kabul, 7 ret.

**`approvals_maker_is_not_checker`** â€” talep eden ile karar veren aynÄ± kiÅŸi olamaz, ve bu kural
veritabanÄ±nda duruyor. YalnÄ±z server action'da duran bir maker-checker kontrolÃ¼, bir refactor
uzaklÄ±ktadÄ±r.

**`approvals_decision_consistency` neden `decided_by`'Ä± ZORUNLU TUTMUYOR** â€” bu, Ã¶lÃ§tÃ¼kten sonra
yapÄ±lmÄ±ÅŸ bir dÃ¼zeltme. Ä°lk sÃ¼rÃ¼m her karar iÃ§in isimli bir karar verici istiyordu; 0055'in kÃ¶prÃ¼sÃ¼
o zaman **legacy yazÄ±mlarÄ± iptal etti**, Ã§Ã¼nkÃ¼ altÄ± gate scripti `mapping_reviews`'Ä± anonim
Ã§Ã¶zÃ¼yor (`set status='resolved', reviewed_at=now()`, kullanÄ±cÄ± yok) ve P0-A Ã¶ncesi geÃ§miÅŸ de aynÄ±
biÃ§imde. SeÃ§im, bu geÃ§miÅŸi boÅŸ bir karar vericiyle **doÄŸru** temsil etmek ile kÄ±sÄ±tÄ± saÄŸlamak iÃ§in
bir aktÃ¶r **uydurmak** arasÄ±ndaydÄ±. Faz 19'un arÅŸiv motorundan sabit kodlanmÄ±ÅŸ "Yerel kullanÄ±cÄ±"
fallback'i tam da bunun iÃ§in kaldÄ±rÄ±lmÄ±ÅŸtÄ±. BoÅŸ `decided_by` artÄ±k "bu karar maker-checker akÄ±ÅŸÄ±nÄ±
Ã¶ncelemiÅŸ ya da atlamÄ±ÅŸtÄ±r" demek; `src/lib/approvals/engine.ts` Ã¼zerinden verilen her karar
vericisini isimlendiriyor ve `phase24a:verify` bunu **tablodan deÄŸil motordan** talep ediyor.

`approval_steps` salt-ekleme (0022 deseni: BEFORE UPDATE/DELETE/TRUNCATE trigger + REVOKE).
`audit_logs`'tan ayrÄ± ve ikisi de korunuyor: `audit_logs` "hangi operatÃ¶r ne yaptÄ±", `approval_steps`
"BU onay buraya nasÄ±l geldi". `approval_id` **kasÄ±tlÄ± olarak FK deÄŸil** â€” 0037 ve 0046'nÄ±n kaydettiÄŸi
gerekÃ§e: TRUNCATE CASCADE, ON DELETE ne olursa olsun FK'larÄ± izler ve salt-ekleme kanÄ±tÄ±nÄ± yok eder
(`pnpm import:real` bunu Faz 21'de fiilen yaÅŸattÄ±).

### 0054 â€” `approval_rules`

Hangi durumun ikinci gÃ¶z istediÄŸi **veri**, engine'lere serpiÅŸtirilmiÅŸ `if` deÄŸil. BeÅŸ varsayÄ±lan
kural yÃ¼kleniyor; `amount_over_100k` eÅŸiÄŸi `public.settings.critical_payment_threshold_try` ile
**aynÄ± sayÄ±** (ikinci bir eÅŸik icat edilmedi ve `phase24a:verify` bu eÅŸitliÄŸi kontrol ediyor).
`invoice_requires_approval` ve `payment_requires_approval` **pasif** geliyor: kÃ¼Ã§Ã¼k bir ekipte her
faturayÄ± iki kiÅŸiye baÄŸlamak akÄ±ÅŸÄ± durdurur ve toptan kapatÄ±lan bir kontrol panelinden kÃ¶tÃ¼sÃ¼ yoktur.

`approval_rules_threshold_scope` CHECK'i iki yÃ¶nlÃ¼: `amount_threshold` eÅŸiksiz olamaz, eÅŸik de
tutara bakmayan bir kurala iliÅŸtirilemez. SÄ±fÄ±r eÅŸik geÃ§erli ("her ÅŸey onay ister"); `0` ile `null`
farklÄ± ifadeler (CLAUDE.md).

**StatÃ¼ kolonu YOK.** Bir kural aktiftir ya da deÄŸildir; `is_active` boolean'Ä±nÄ±n kÄ±sÄ±tlanacak
geÃ§iÅŸi yok, Â§17 kural 3 burada gerÃ§ekten N/A.

### 0055 â€” legacy kÃ¶prÃ¼sÃ¼

YÃ¶n: **legacy â†’ approvals**, AFTER trigger ile. Mevcut her yazÄ±m yolu â€” UI action'Ä±, altÄ± gate
scripti, elle aÃ§Ä±lmÄ±ÅŸ bir psql oturumu â€” bu tablonun varlÄ±ÄŸÄ±ndan habersiz onay kaydÄ± Ã¼retiyor.
Ters yÃ¶n (bir onayÄ± karara baÄŸlamak legacy kolonu geri yazar) `src/lib/approvals/engine.ts`
iÃ§inde ve **yalnÄ±z yeni bir yol**; daha Ã¶nce Ã§alÄ±ÅŸan hiÃ§bir ÅŸeye dokunmuyor.

AFTER seÃ§imi tasarÄ±mÄ±n kendisi: BEFORE trigger bir legacy yazÄ±mÄ±nÄ± dÃ¼ÅŸÃ¼rebilir, ki bu kÃ¶prÃ¼nÃ¼n var
olma sebebi tam olarak bunu imkÃ¢nsÄ±z kÄ±lmak.

Guard'Ä±n reddedeceÄŸi bir legacy sÄ±Ã§ramasÄ± (`resolved` â†’ `open`, yani approved â†’ pending) geldiÄŸinde
kÃ¶prÃ¼ **yeni bir tur aÃ§Ä±yor**. Bu bir kaÃ§amak deÄŸil: Ã§Ã¶zÃ¼lmÃ¼ÅŸ bir incelemeyi yeniden aÃ§mak gerÃ§ekten
ikinci bir onay turudur, ve bÃ¶yle modellemek hem geÃ§miÅŸi hem guard'Ä± saÄŸlam bÄ±rakÄ±yor.

`approval_queue` view'i tek Ã§alÄ±ÅŸma listesi. **View, tablo deÄŸil** â€” ikinci bir doÄŸruluk kaynaÄŸÄ±
Ã¼retmemek iÃ§in (Faz 22'nin `receivables/payables` kararÄ±yla aynÄ± gerekÃ§e).

### Bu fazÄ±n gerÃ§ek regresyon yÃ¼zeyi

`phase24a:verify`'Ä±n en aÄŸÄ±r kontrolleri `approvals` hakkÄ±nda deÄŸil: legacy'nin **hÃ¢lÃ¢ eskisi gibi
davrandÄ±ÄŸÄ±** hakkÄ±nda. Anonim `resolved` yazÄ±mÄ±nÄ±n legacy'de baÅŸarÄ±lÄ± olduÄŸu, yasak sÄ±Ã§ramanÄ±n
legacy yazÄ±mÄ±nÄ± Ã¶ldÃ¼rmediÄŸi, `reviewed_at` koruma semantiÄŸinin bozulmadÄ±ÄŸÄ± ve legacy kolonlara
guard **eklenmediÄŸi** ayrÄ± ayrÄ± kontrol ediliyor. KÃ¶prÃ¼nÃ¼n ilk iki sÃ¼rÃ¼mÃ¼ legacy yazÄ±mlarÄ±nÄ± iptal
etti; her ikisinde de yalnÄ±z `approvals`'a bakan bir doÄŸrulama memnun kalÄ±rdÄ±.

---

## Tam rol matrisi ve satÄ±r-seviyesi RLS (Faz 24B, migration 0056-0058)

PlanÄ±n en geniÅŸ kapsamlÄ± fazÄ±: 58 tablonun blanket `for all to authenticated using(true)`
politikasÄ±, beÅŸ katmanlÄ± gerÃ§ek bir rol matrisiyle deÄŸiÅŸtirildi. HiÃ§bir blanket politika sessizce
bÄ±rakÄ±lmadÄ± â€” `db:roles-rls:verify` kalan sayÄ±sÄ±nÄ±n **sÄ±fÄ±r** olduÄŸunu kontrol ediyor.

### Mimari karar: GUC deÄŸil, GERÃ‡EK veritabanÄ± rolleri

Uygulama tek bir login rolÃ¼yle baÄŸlanÄ±yor (`mas_radar_app`, Faz 15), dolayÄ±sÄ±yla veritabanÄ± kendi
baÅŸÄ±na bir izleyicinin isteÄŸini bir yÃ¶neticininkinden ayÄ±ramaz. Ä°ki seÃ§enek vardÄ±: politikalarÄ±n
okuduÄŸu bir oturum deÄŸiÅŸkeni (GUC) ya da baÄŸlantÄ±nÄ±n iÃ§ine geÃ§tiÄŸi gerÃ§ek roller. GerÃ§ek roller
seÃ§ildi, Ã§Ã¼nkÃ¼ `to <role>` PostgreSQL'in politika eÅŸleÅŸtiricisinin zaten Ã¼zerine kurulu olduÄŸu
mekanizma: kontrol planlayÄ±cÄ±da, her ifadede, gelecekteki bir politika yazarÄ±nÄ±n eklemeyi
unutabileceÄŸi bir ifade olmadan yapÄ±lÄ±yor.

**KalÄ±tÄ±m tuzaÄŸÄ± ve onu Ã§Ã¶zen PG16 Ã¶zelliÄŸi.** Politikalar baÄŸlanÄ±lan kimliÄŸe deÄŸil rol
**Ã¼yeliÄŸine** gÃ¶re eÅŸleÅŸiyor. DÃ¼z bir `grant mas_radar_viewer to mas_radar_app` uygulamayÄ± beÅŸ
katmanÄ±n da Ã¼yesi yapardÄ±; yani her katmanÄ±n politikalarÄ±nÄ±n **birleÅŸimini** saÄŸlardÄ± â€” kalÄ±cÄ±
olarak admin. PostgreSQL 16 Ã¼yeliÄŸin iki yarÄ±sÄ±nÄ± ayÄ±rÄ±yor:

    grant mas_radar_viewer to mas_radar_app with inherit false, set true;

TasarÄ±ma baÄŸlanmadan Ã¶nce bu kÃ¼mede Ã¶lÃ§Ã¼ldÃ¼: `SET ROLE` yapÄ±lmamÄ±ÅŸ bir uygulama baÄŸlantÄ±sÄ±,
yalnÄ±z katman politikalarÄ± taÅŸÄ±yan bir tablodan **sÄ±fÄ±r** satÄ±r gÃ¶rÃ¼yor; `set role` sonrasÄ±
katmanÄ±n politikalarÄ± tam olarak uygulanÄ±yor; `reset role` sonrasÄ± yine sÄ±fÄ±ra dÃ¶nÃ¼yor. Son
Ã¶zellik havuzlanmÄ±ÅŸ baÄŸlantÄ±da gÃ¼venliÄŸin temeli: sÄ±zan bir rol checkout'u aÅŸamaz, Ã§Ã¼nkÃ¼ reset
baÄŸlantÄ±yÄ± hiÃ§bir ÅŸey okuyamayan bir kimliÄŸe geri bÄ±rakÄ±yor.

**Bunun bedeli, aÃ§Ä±kÃ§a:** 0058'den sonra katmana geÃ§memiÅŸ `mas_radar_app` iÅŸ tablolarÄ±nÄ±
okuyamaz. Bu kasÄ±tlÄ±. MeÅŸru olarak geÃ§iÅŸsiz Ã§alÄ±ÅŸan tek yol giriÅŸ/oturum sorgularÄ±; onlar Faz
15'in users/sessions Ã¼zerindeki `mas_radar_app` hedefli politikalarÄ±nÄ± kullanmaya devam ediyor.

### 0056 â€” `users.role` beÅŸ katmana geniÅŸledi

| Eski | Yeni | GerekÃ§e |
|---|---|---|
| `admin` | `admin` | DeÄŸiÅŸmedi. |
| `operator` | **`finance_manager`** | `finance_operator` DEÄÄ°L. |

Ä°sim benzerliÄŸi `operator â†’ finance_operator` diyor ama bu **yanlÄ±ÅŸ** olurdu. BugÃ¼n `operator`
"admin sayfalarÄ± dÄ±ÅŸÄ±nda her ÅŸey": Ã¶deme girme, inceleme Ã§Ã¶zme, senaryo Ã§alÄ±ÅŸtÄ±rma ve Faz 24A'nÄ±n
onaylarÄ±nÄ± karara baÄŸlama. Yeni matriste `finance_operator` **onaylayamaz**. Bu eÅŸleme, her mevcut
hesabÄ±n gÃ¼nlÃ¼k kullandÄ±ÄŸÄ± bir yetkiyi sessizce **geri alÄ±rdÄ±**; ilk belirti kendi onay kuyruÄŸunu
temizleyemeyen bir operatÃ¶r olurdu. Bir migration operatÃ¶rÃ¼n seÃ§tiÄŸi kÄ±sÄ±tlamalarÄ± ekleyebilir;
bir hesabÄ±n zaten sahip olduÄŸunu sessizce alamaz. `finance_manager` bugÃ¼nkÃ¼ davranÄ±ÅŸÄ± birebir
koruyor. Daha dar olmasÄ± gereken herkes gÃ¼venlik ekranÄ±ndan **bilinÃ§li** olarak indirilebilir â€”
denetim kaydÄ±na dÃ¼ÅŸen, insanÄ±n verdiÄŸi bir karar.

Yeni hesap varsayÄ±lanÄ± `operator`'dan **`viewer`**'a dÃ¼ÅŸtÃ¼ (en az yetki); mevcut hiÃ§bir satÄ±rÄ±
deÄŸiÅŸtirmez.

### 0057 â€” katman baÅŸÄ±na bir PostgreSQL rolÃ¼

BeÅŸ rol (`mas_radar_viewer` â€¦ `mas_radar_admin`), hepsi **NOLOGIN**: kimse bir katman *olarak*
baÄŸlanmaz, katmanlar yalnÄ±z iÃ§ine geÃ§ilmek ve politikalarca adlandÄ±rÄ±lmak iÃ§in var. Hepsi
`authenticated` Ã¼yesi olduÄŸundan 0035'in tablo GRANT'lerini devralÄ±yorlar â€” GRANT komutun
denenebilir olup olmadÄ±ÄŸÄ±na, politika hangi satÄ±ra dokunabileceÄŸine karar veriyor; ikisi de gerekli.

Ä°ki yardÄ±mcÄ± fonksiyon: `current_app_user()` (`app.user_id` GUC'undan; satÄ±r-seviyesi kurallar
kiÅŸiyi bilmek zorunda, SET ROLE yalnÄ±z katmanÄ± sÃ¶yler) ve `current_app_role()`. Ä°kisi de
`current_setting(..., true)` kullanÄ±yor: ayar yoksa **NULL** dÃ¶ner, ve politikalar NULL'Ä± "hiÃ§bir
ÅŸeyle eÅŸleÅŸmez" olarak okur, asla joker olarak deÄŸil.

### 0058 â€” sÄ±nÄ±f bazlÄ± politikalar

61 tablo Ã— 5 katman Ã— 4 komut = binden fazla karar. Hepsini tek tek yazan bir migration
incelenemez olurdu â€” yanlÄ±ÅŸ hÃ¼crenin saklanacaÄŸÄ± yer tam olarak orasÄ±dÄ±r. Bunun yerine her tablo
**tek bir eriÅŸim sÄ±nÄ±fÄ±na** atandÄ±, politikalar bu atamadan Ã¼retiliyor:

| SÄ±nÄ±f | Tablo | viewer | finance_operator | finance_approver | finance_manager | admin |
|---|---|---|---|---|---|---|
| `reference` | 16 | S | S | S | SIUD | SIUD |
| `operational` | 21 | S | SIU | S | SIUD | SIUD |
| `evidence` | 7 | S | SI | SI | SI | SI |
| `derived` | 11 | S | SIU | S | SIUD | SIUD |
| `config` (`settings`) | 1 | S | S | S | S | SIUD |
| `approval` (`approvals`) | 1 | S | SI | SU | SIU | SIU |
| `approval_config` (`approval_rules`) | 1 | S | S | S | S | SIUD |
| `auth_users` (`users`) | 1 | S(kendi) | S(kendi) | S(kendi) | S(kendi) | SIUD |
| `auth_sessions` (`sessions`) | 1 | S(kendi) | S(kendi) | S(kendi) | S(kendi) | S(kendi) |
| `ledger` (`schema_migrations`) | 1 | â€” | â€” | â€” | â€” | â€” |

(S=select, I=insert, U=update, D=delete)

Dikkat Ã§eken hÃ¼creler ve gerekÃ§eleri:

- **`evidence` hiÃ§ kimseye UPDATE/DELETE vermiyor, admin dahil.** Bu tablolar 0022 deseniyle
  zaten salt-ekleme; RLS'in trigger ile aynÄ± ÅŸeyi sÃ¶ylemesi, reddin iki katmandan hangisinin
  deÄŸiÅŸtiÄŸine baÄŸlÄ± kalmamasÄ±nÄ± saÄŸlÄ±yor.
- **`finance_approver` `approvals`'a INSERT edemiyor** â€” talep aÃ§mak veri giriÅŸidir; kararÄ±nÄ±
  verdiÄŸi talepleri kendisi aÃ§abilen bir onaylayÄ±cÄ±, yalnÄ±z isimde bir maker-checker ayrÄ±mÄ±dÄ±r.
  Bunu **gate yakaladÄ±**: kod matrisi baÅŸta `ENTER` diyordu, migration doÄŸruyu sÃ¶ylÃ¼yordu.
- **`approval_rules` yalnÄ±z admin'e yazÄ±lÄ±yor, manager'a deÄŸil.** Kendi onaylarÄ±nÄ± yÃ¶neten eÅŸiÄŸi
  indirebilen bir yÃ¶netici, maker-checker tasarÄ±mÄ±nÄ± bir ayar ekranÄ±ndan Ã§Ã¶zerdi.
- **`sessions`'a hiÃ§bir katman yazamÄ±yor**, admin dahil. OturumlarÄ± giriÅŸ yolu yazÄ±yor (geÃ§iÅŸsiz,
  `sessions_app_runtime` Ã¼zerinden); yazabilen bir katman baÅŸka bir hesap adÄ±na oturum basabilirdi.
- **`schema_migrations` politikasÄ±z** (0020/0035, deÄŸiÅŸmedi) â€” ledger yalnÄ±z owner'Ä±ndÄ±r.

### SatÄ±r seviyesi: dÃ¼rÃ¼stÃ§e kapsanmÄ±ÅŸ

Plan `finance_operator`'Ä±n "kendi girdiÄŸi kayÄ±tlarÄ±" dÃ¼zenlemesini Ã¶neriyor. Bu bir sahiplik
kolonu gerektiriyor ve **61 tablonun yalnÄ±z 8'inde** var â€” varsayÄ±lmadÄ±, Ã¶lÃ§Ã¼ldÃ¼. DiÄŸer 53'e
`created_by` ekleyip NULL doldurmak, sahiplik politikasÄ± altÄ±nda **hiÃ§bir operatÃ¶rÃ¼n hiÃ§bir
geÃ§miÅŸ kaydÄ± dÃ¼zenleyememesi** demekti: sÄ±kÄ±laÅŸtÄ±rmanÄ±n deÄŸerinden Ã§ok daha bÃ¼yÃ¼k bir eriÅŸim
kaybÄ± ve mali geÃ§miÅŸin yazarlÄ±ÄŸÄ±nÄ±n sessizce yeniden yazÄ±lmasÄ±. Bu yÃ¼zden sahiplik, verinin
desteklediÄŸi yerde uygulanÄ±yor:

- `action_items`, `invoice_allocations`, `scenarios` â€” operatÃ¶rÃ¼n UPDATE'i `created_by =
  current_app_user()` ile sÄ±nÄ±rlÄ±; manager/admin sÄ±nÄ±rsÄ±z (yazarÄ± ayrÄ±lmÄ±ÅŸ bir kaydÄ± birinin
  dÃ¼zeltebilmesi gerekir).
- `approvals` â€” onaylayÄ±cÄ± **kendi talebini** gÃ¼ncelleyemiyor (`requested_by is distinct from
  current_app_user()`). Faz 24A bunu bir CHECK'e koymuÅŸtu; bu, aynÄ± kuralÄ± bir katman altta
  tekrarlÄ±yor: kÄ±sÄ±t geÃ§erli satÄ±rÄ±n neye benzediÄŸini, politika satÄ±ra kimin ulaÅŸabileceÄŸini
  sÃ¶yler. NULL `requested_by` (24A'nÄ±n anonim legacy geÃ§miÅŸi) gÃ¼ncellenebilir kalÄ±yor.
- `users`/`sessions` â€” katman yalnÄ±z **kendi** satÄ±rÄ±nÄ± gÃ¶rÃ¼yor (`users_self_read`).

### Faz 15'in giriÅŸ akÄ±ÅŸÄ±: geniÅŸletildi, deÄŸiÅŸtirilmedi

`users_deny_all`/`sessions_deny_all` (0031) ve `users_app_runtime`/`sessions_app_runtime` (0035)
**aynen** duruyor; gate dÃ¶rdÃ¼nÃ¼ de hedef rolleriyle birlikte kontrol ediyor. Eklenen tek ÅŸey
isteÄŸin diÄŸer yarÄ±sÄ±: runtime bir katmana geÃ§tikten sonra `current_user` artÄ±k `mas_radar_app`
deÄŸil, dolayÄ±sÄ±yla `app_runtime` eÅŸleÅŸmeyi bÄ±rakÄ±yor ve aynÄ± istekteki sonraki her
`requireSession()` okunabilir kullanÄ±cÄ± satÄ±rÄ± bulamazdÄ±. `users_self_read`/`sessions_self_read`
tam olarak bu kadarÄ±nÄ± geri veriyor: tabloyu deÄŸil, **kendi satÄ±rÄ±nÄ±**.

Uygulama tarafÄ±nda `src/lib/db.ts` artÄ±k iki havuz tutuyor â€” `getPool()` (her checkout'ta katmana
geÃ§er) ve `getRawPool()` (giriÅŸ/oturum, geÃ§iÅŸsiz). AyrÄ± Ã¶rnekler olmalarÄ± gÃ¼venlik argÃ¼manÄ±nÄ±n
kendisi: scoped havuzdaki fiziksel baÄŸlantÄ± checkout'lar arasÄ±nda katman rolÃ¼nÃ¼ taÅŸÄ±yabilir,
raw havuzdaki asla taÅŸÄ±yamaz.

### `migrate.ts` ANCHORS: 0007 Ã§apasÄ± ONARILDI (eklenmedi)

0007 Ã§apasÄ± `payments_authenticated_all` politikasÄ±nÄ± arÄ±yordu; 0058 o politikayÄ± kasÄ±tlÄ± olarak
dÃ¼ÅŸÃ¼rÃ¼yor. SonuÃ§: 0058'den sonra Ã§apa, 0007'nin aÃ§Ä±kÃ§a Ã§alÄ±ÅŸtÄ±ÄŸÄ± bir veritabanÄ±nda "Ã§alÄ±ÅŸmamÄ±ÅŸ"
diyordu. Bu kozmetik deÄŸil â€” `LEDGER_EMPTY_RECOVERY` ledger'Ä± boÅŸ bir veritabanÄ±nÄ±n
legacy-complete olup olmadÄ±ÄŸÄ±na Ã§apalara bakarak karar veriyor ve on dokuz geÃ§en Ã§apa arasÄ±nda
bir tanesinin kalmasÄ± tam olarak hard-fail eden `INCONSISTENT_PARTIAL` durumu. Herhangi bir 24B
veritabanÄ±nÄ±n ham geri yÃ¼klemesi migrate etmeyi reddederdi.

0007 iki ÅŸey yapÄ±yor: her tabloda RLS'i **aÃ§Ä±yor** ve blanket politikalarÄ± yaratÄ±yor. 24B yalnÄ±z
ikincisinin yerine geÃ§iyor. Ã‡apa artÄ±k kalÄ±cÄ± yarÄ±yÄ± parmak izi alÄ±yor
(`payments.relrowsecurity`) â€” aynÄ± soruyu soruyor, ve hem 24B Ã¶ncesinde hem sonrasÄ±nda doÄŸru
cevaplÄ±yor. **Dizi uzamadÄ±**: aynÄ± sayÄ±da, aynÄ± versiyonlar.

---

## Tahsilat Merkezi (Faz 25, migration 0059-0061)

Bu faz tek bir ayrÄ±mÄ±n Ã¼zerine kurulu: **bir sÃ¶z, bir alacak deÄŸildir.** `invoices` bir
yÃ¼kÃ¼mlÃ¼lÃ¼ÄŸÃ¼ kaydeder; `promise_to_pay` bir telefon gÃ¶rÃ¼ÅŸmesinde sÃ¶ylenmiÅŸ bir cÃ¼mleyi kaydeder.
AyrÄ± tablolarda durmalarÄ±nÄ±n sebebi tam olarak budur â€” sÃ¶z muhasebe aÄŸÄ±rlÄ±ÄŸÄ± taÅŸÄ±maz, Ã¼zerine
daÄŸÄ±tÄ±m yapÄ±lamaz, hiÃ§bir faturanÄ±n bakiyesini deÄŸiÅŸtirmez. Var olma sebebi, ikisi arasÄ±ndaki
farkÄ±n Ã¶lÃ§Ã¼lebilmesidir.

### 0059 â€” `promise_to_pay`

Neden `action_items` Ã¼zerine binmedi: plan tahsilat **notlarÄ±nÄ±n** mevcut gÃ¶rev modelini
kullanmasÄ±nÄ± ve ikinci bir gÃ¶rev modeli icat edilmemesini ÅŸart koÅŸuyor, ve bu faz buna uyuyor â€”
kÄ±rÄ±lan sÃ¶zÃ¼n doÄŸurduÄŸu takip iÅŸi bir `action_item` (0060 `source_type`'Ä± bunun iÃ§in geniÅŸletiyor).
Ama sÃ¶zÃ¼n kendisi bir gÃ¶rev deÄŸil: karÅŸÄ± tarafÄ±, tutarÄ±, gerÃ§ekle karÅŸÄ±laÅŸtÄ±rÄ±lan bir **tarihi** ve
bir puana beslenen bir sonucu var. `action_item` olarak modellemek bunlarÄ±n hepsini `note` alanÄ±na
sÄ±kÄ±ÅŸtÄ±rmak ve serbest metne kaybetmek olurdu.

KolonlarÄ±n taÅŸÄ±dÄ±ÄŸÄ± kararlar:

- **`promised_amount` NULL olabilir** â€” "haftaya bir ÅŸeyler gÃ¶nderirim" gerÃ§ek bir sÃ¶zdÃ¼r ve
  0,00 TL olarak kaydetmek bu kolonu toplayan her view'da maruziyeti olduÄŸundan kÃ¼Ã§Ã¼k gÃ¶sterirdi.
  NULL = bilinmiyor, 0 = aÃ§Ä±kÃ§a hiÃ§ (CLAUDE.md).
- **`promised_date` NOT NULL** â€” tablonun tamamÄ± bu kolonu bugÃ¼nle karÅŸÄ±laÅŸtÄ±rmak iÃ§in var;
  tarihsiz bir sÃ¶z ne tutulabilir ne kÄ±rÄ±labilir.
- **`invoice_id` NULL olabilir** â€” mÃ¼ÅŸteriler rutin olarak belge adÄ± vermeden bakiye Ã¼zerine sÃ¶z
  verir; zorunlu kÄ±lmak ya bunu engeller ya da yanlÄ±ÅŸ bir tahmine davet ederdi.
- **`resolved_by` NULL olabilir** â€” Faz 24A dersinin tekrarÄ±: kÄ±rÄ±lan sÃ¶z tespit iÅŸinin arkasÄ±nda
  oturum aÃ§mÄ±ÅŸ bir kullanÄ±cÄ± yok. AktÃ¶r zorunlu olsaydÄ± iÅŸ bir tane **uydurmak** zorunda kalÄ±rdÄ±.
  NULL burada "bunu bir insan kararlaÅŸtÄ±rmadÄ±" demek; `resolution_source` hangi mekanizmanÄ±n
  kararlaÅŸtÄ±rdÄ±ÄŸÄ±nÄ± sÃ¶ylÃ¼yor (`manual` / `auto_detection`).

#### Durum izin listesi (CHECK ile AYNI migration'da)

| Eski | Yeni | Anlam |
|---|---|---|
| pending | kept | para geldi |
| pending | broken | tarih geÃ§ti, para gelmedi |
| pending | cancelled | sÃ¶z tarihinden Ã¶nce geri Ã§ekildi |
| **broken** | **kept** | **geÃ§ Ã¶deme â€” atlanmasÄ± en kolay olan** |

`broken â†’ kept` gerÃ§ekten Ã¶nemli: geÃ§ Ã¶deme, kÄ±rÄ±lan bir sÃ¶zÃ¼n **olaÄŸan** sonucudur, istisnasÄ±
deÄŸil. Bu geÃ§iÅŸ olmasaydÄ± Ã¼Ã§ gÃ¼n geÃ§ Ã¶deyen mÃ¼ÅŸteri sonsuza kadar `broken` olarak donar ve bu
tabloya dayanan her puan onu kalÄ±cÄ± olarak olduÄŸundan kÃ¶tÃ¼ gÃ¶sterirdi.

`kept` ve `cancelled` terminal. Karara baÄŸlanmÄ±ÅŸ bir sÃ¶zÃ¼ yeniden aÃ§mak tahsilat geÃ§miÅŸini
sessizce yeniden yazmak olurdu; dÃ¼rÃ¼st yol **yeni bir sÃ¶z** kaydetmektir â€” ki puanÄ±n gÃ¶rmesi
gereken de zaten budur.

Guard 0027'nin dersiyle yazÄ±ldÄ±: izin listesi CHECK'in tamamÄ±na karÅŸÄ± kuruldu, bugÃ¼n iÅŸe yarayan
geÃ§iÅŸlere gÃ¶re deÄŸil. `phase25:verify` 12 sÄ±ralÄ± Ã§iftin tamamÄ±nÄ± gerÃ§ek satÄ±rlar Ã¼stÃ¼nde deniyor
(4 kabul, 8 ret) ve ayrÄ±ca koddaki `canTransition` ile birebir aynÄ± olduÄŸunu kanÄ±tlÄ±yor.

#### `promise_to_pay_open_unique` ve NULLS NOT DISTINCT

AynÄ± cari + aynÄ± tarih iÃ§in ikinci bir **aÃ§Ä±k** sÃ¶z engelleniyor. `nulls not distinct` burada
kozmetik deÄŸil: sÃ¶zlerin Ã§oÄŸunda `invoice_id` NULL ve varsayÄ±lan kuralda her NULL benzersiz
sayÄ±ldÄ±ÄŸÄ± iÃ§in indeks **en yaygÄ±n durumda hiÃ§bir ÅŸeyi korumazdÄ±**.

#### RLS: Faz 24B'nin `operational` sÄ±nÄ±fÄ±

Yeni tablo blanket politikayla deÄŸil, 24B'nin beÅŸ katmanlÄ± modeliyle yazÄ±ldÄ±: `viewer` okur,
`finance_operator` girer ve dÃ¼zeltir, `finance_manager`/`admin` ayrÄ±ca siler. SÄ±nÄ±f 0058'in kendi
mantÄ±ÄŸÄ±ndan seÃ§ildi (payments/invoices ile aynÄ± sÄ±nÄ±f) ve `src/lib/authz/matrix.ts` aynÄ±
sÄ±nÄ±flandÄ±rmayÄ± taÅŸÄ±yor â€” `db:roles-rls:verify` ikisini canlÄ± veritabanÄ±nda Ã§alÄ±ÅŸtÄ±rÄ±p
uyuÅŸtuklarÄ±nÄ± kanÄ±tlÄ±yor.

**KasÄ±tlÄ± olarak owner-scoped DEÄÄ°L**, `action_items`'Ä±n aksine: tahsilat ekip iÅŸidir, para
geldiÄŸinde telefonu kim aÃ§tÄ±ysa sÃ¶zÃ¼ "tutuldu" iÅŸaretleyebilmeli â€” sÃ¶zÃ¼ meslektaÅŸÄ± kaydetmiÅŸ
olsa bile. DÃ¼zenlemeyi kaydÄ± girene kilitlemek, biri izinliyken sÃ¶zlerin `pending` takÄ±lÄ±
kalmasÄ± demekti; eriÅŸim maliyeti sÄ±kÄ±laÅŸtÄ±rmanÄ±n deÄŸerinden bÃ¼yÃ¼k.

### 0060 â€” iki CHECK enum'unun geniÅŸletilmesi (baÅŸka hiÃ§bir ÅŸey yapmayan bir migration)

Faz 22'nin kuralÄ±: enum CHECK geniÅŸletmesi kendi aÃ§Ä±k migration'Ä±nÄ± alÄ±r. GerekÃ§e denetlenebilirlik
â€” bu iki ifade ÅŸemanÄ±n **geri kalanÄ±nÄ±n** bundan sonra neyi kabul edeceÄŸini deÄŸiÅŸtiriyor.

- `reminders.target_kind`: 3 â†’ 5 (`invoice`, `promise_to_pay` eklendi).
- `action_items.source_type`: 6 â†’ 7 (`collection` eklendi). **Tek deÄŸer**, Ã¼Ã§ deÄŸil:
  `related_entity_table`/`related_entity_id` Ã§ifti zaten neyle ilgili olduÄŸunu, `severity` zaten
  aciliyeti sÃ¶ylÃ¼yor; sÄ±nÄ±flandÄ±rmayÄ± enum'a itmek her deÄŸiÅŸikliÄŸi bir migration'a baÄŸlardÄ±.
- `reminders.channel` **zaten** 0006'dan beri `('telegram','email')` iÃ§eriyordu â€” Ã¶lÃ§Ã¼ldÃ¼,
  varsayÄ±lmadÄ±. Faz 25 kanal deÄŸerini deÄŸil **taÅŸÄ±yÄ±cÄ±yÄ±** ekliyor, bu yÃ¼zden burada bilerek ALTER
  yok; yokluÄŸun bir bulgu olarak okunmasÄ± iÃ§in migration iÃ§inde aÃ§Ä±kÃ§a yazÄ±lÄ±.

Ä°ki geniÅŸletme de eski deÄŸer kÃ¼mesinin **Ã¼st kÃ¼mesi**, dolayÄ±sÄ±yla mevcut hiÃ§bir satÄ±rÄ±
geÃ§ersizleÅŸtiremez â€” dolu bir veritabanÄ±nda gÃ¼venle Ã§alÄ±ÅŸmalarÄ±nÄ±n ve NOT VALID + sonradan
doÄŸrulama yerine doÄŸrudan deÄŸiÅŸtirilmelerinin sebebi bu.

### 0061 â€” Ã¼Ã§ read-model, hepsi VIEW

Faz 19/22/23'Ã¼n kaydettiÄŸi gerekÃ§e aynen geÃ§erli: saklanmÄ±ÅŸ bir puan, bir fatura kapandÄ±ÄŸÄ± anda
bayatlayan ikinci bir doÄŸruluk kaynaÄŸÄ±dÄ±r ve bayatlÄ±ÄŸÄ± gÃ¶rÃ¼nmez, Ã§Ã¼nkÃ¼ sayÄ± hÃ¢lÃ¢ sayÄ± gibi durur.

- `promise_to_pay_open` â€” aÃ§Ä±k sÃ¶zler + `days_late`. Kolon adÄ± bilerek `days_overdue` deÄŸil:
  faturanÄ±n gecikmesiyle karÄ±ÅŸtÄ±rÄ±lmamalÄ±, ekran ikisini birlikte gÃ¶steriyor.
- `party_promise_history` â€” cari baÅŸÄ±na tutulan/kÄ±rÄ±lan sayÄ±larÄ± ve `kept_ratio`.
  **`cancelled` orandan dÄ±ÅŸlanÄ±yor**: geri Ã§ekilmiÅŸ bir sÃ¶z, mÃ¼ÅŸterinin Ã¶deyip Ã¶demediÄŸi hakkÄ±nda
  hiÃ§bir ÅŸey sÃ¶ylemez. **HiÃ§ Ã§Ã¶zÃ¼lmemiÅŸse oran NULL**, 0 deÄŸil â€” hiÃ§ sÃ¶z vermemiÅŸ mÃ¼ÅŸteri, sÃ¶zÃ¼nÃ¼
  tutmayan mÃ¼ÅŸteri deÄŸildir.
- `customer_collection_score` â€” 100'den baÅŸlayÄ±p **adlandÄ±rÄ±lmÄ±ÅŸ** kurallarla dÃ¼ÅŸen puan.

#### Puan: deterministik ve adlandÄ±rÄ±lmÄ±ÅŸ, asla Ã¶ÄŸrenilmiÅŸ deÄŸil

Her dÃ¼ÅŸÃ¼ÅŸ bir kuraldÄ±r ve adÄ± `score_reasons` iÃ§inde sayÄ±yla birlikte taÅŸÄ±nÄ±r. Bu Faz 23'Ã¼n
kuralÄ± ve sebebi ÅŸu: tahsilat puanÄ± bir mÃ¼ÅŸteriye karÅŸÄ± bir kararÄ± gerekÃ§elendirmek iÃ§in
kullanÄ±lÄ±r. "82, Ã§Ã¼nkÃ¼ iki sÃ¶z kÄ±rÄ±ldÄ± ve en eski fatura 47 gÃ¼n gecikmiÅŸ" savunulabilir; Ã§Ä±plak
bir 82 savunulamaz.

| Kural | Ceza |
|---|---|
| `gecikmis_fatura_yasi` | 90+ gÃ¼n 30 Â· 60+ 20 Â· 30+ 12 Â· 1+ 5 |
| `suepheli_alacak` | 25 |
| `tutulmayan_odeme_sozu` | oran <0.34 â†’ 25 Â· <0.67 â†’ 15 Â· <1.00 â†’ 7 |
| `gec_odeme_aliskanligi` | late_ratio â‰¥0.75 â†’ 15 Â· â‰¥0.50 â†’ 10 Â· â‰¥0.25 â†’ 5 |

Bantlar: â‰¥85 `good`, â‰¥60 `watch`, â‰¥35 `risk`, altÄ± `critical` â€” eÅŸikler tek yerde, ekran kendi
renklendirmesini icat edemesin diye. Aritmetik baÅŸtan sona `numeric`; hiÃ§bir yerde `::float8` yok
(Faz 17).

**SÃ¶z geÃ§miÅŸi olmayan cari cezalandÄ±rÄ±lmÄ±yor**: `kept_ratio` NULL ise ceza 0. Yeni bir karÅŸÄ±
tarafÄ± geÃ§miÅŸi olmadÄ±ÄŸÄ± iÃ§in cezalandÄ±rmak, kanÄ±t yokluÄŸunu kanÄ±t saymak olurdu.

### KÄ±rÄ±lan sÃ¶z tespit iÅŸi

`detectBrokenPromises(pool, todayISO, actorId)` â€” vadesi geÃ§miÅŸ bekleyen sÃ¶zleri `broken`
iÅŸaretler ve her biri iÃ§in bir `action_item` aÃ§ar.

**Neden bu otomatik olabiliyor da ÅŸÃ¼pheli alacak olamÄ±yor** (CLAUDE.md sÄ±nÄ±rÄ±): ikisi farklÄ± tÃ¼rde
olgu kaydediyor. ÅÃ¼pheli alacak paranÄ±n **asla gelmeyeceÄŸi yargÄ±sÄ±dÄ±r** ve bir insan ister. KÄ±rÄ±lan
sÃ¶z, **bir tarihin geÃ§tiÄŸi ve paranÄ±n gelmediÄŸi gÃ¶zlemidir** â€” kimsenin gÃ¶rÃ¼ÅŸÃ¼ iÅŸin iÃ§inde deÄŸil ve
altta yatan olgu bu iÅŸ Ã§alÄ±ÅŸsa da Ã§alÄ±ÅŸmasa da zaten doÄŸru. Ä°ÅŸ yine de hiÃ§bir mali kaydÄ±
deÄŸiÅŸtirmiyor: faturaya, tutara, vadeye, Ã¶demeye dokunmuyor; sÃ¶z tablosuna bir durum yazÄ±yor ve
bir insana gÃ¶rev aÃ§Ä±yor. Her kayÄ±t `automated: true` ile denetleniyor.

**Ä°dempotent, iki baÄŸÄ±msÄ±z yolla**: sÃ¶z UPDATE'i `status='pending'` filtreliyor, ve action_item
INSERT'i 0015'in kÄ±smi unique indeksine dayanÄ±yor (aÃ§Ä±k gÃ¶rev varken aynÄ± kayda ikincisi aÃ§Ä±lamaz).

**SÄ±nÄ±r `<`, `<=` deÄŸil**: bugÃ¼n vadesi olan sÃ¶z kÄ±rÄ±lmÄ±ÅŸ sayÄ±lmaz â€” paranÄ±n gÃ¼nÃ¼n geri kalanÄ±
var. Sabah 09:00'da kÄ±rÄ±lmÄ±ÅŸ diyen bir iÅŸ, henÃ¼z olmamÄ±ÅŸ bir baÅŸarÄ±sÄ±zlÄ±ÄŸÄ± kaydederdi. Ä°ÅŸin tÃ¼m
doÄŸruluÄŸu bu tek karakterde.

`todayISO` iÃ§eriden saatten okunmuyor, parametre â€” gate'in tarihi sÃ¼rÃ¼p kesin davranÄ±ÅŸ iddia
edebilmesi iÃ§in.

### HatÄ±rlatma hedef tÃ¼rleri ve e-posta kanalÄ±

`targetKindOf()` artÄ±k **aÃ§Ä±k bir eÅŸleme**: tanÄ±madÄ±ÄŸÄ± tablo iÃ§in `null` dÃ¶ner. Ã–nceden tanÄ±madÄ±ÄŸÄ±
her ÅŸey iÃ§in `'loan_installment'` dÃ¶nÃ¼yordu â€” Ã¼Ã§ tÃ¼r varken zararsÄ±z, dÃ¶rdÃ¼ncÃ¼ eklendiÄŸi anda her
faturayÄ± ve her sÃ¶zÃ¼ sessizce kredi taksiti diye dosyalayacak bir fallthrough.

`OPEN` tek bir kÃ¼me (`unpaid`/`partial`) idi; artÄ±k **tÃ¼r baÅŸÄ±na**. Bu kelimeler fatura ve sÃ¶z
sÃ¶zlÃ¼ÄŸÃ¼nde yok (aÃ§Ä±k fatura `open`, bekleyen sÃ¶z `pending`), dolayÄ±sÄ±yla tek kÃ¼meyi korumak her
faturayÄ± ve her sÃ¶zÃ¼ kalÄ±cÄ± olarak uygunsuz yapardÄ± â€” hiÃ§bir ÅŸey hatÄ±rlatmayan bir hatÄ±rlatma
motoru, fark edilmesi en zor arÄ±za.

**BulunduÄŸu gibi bÄ±rakÄ±lan, sessizce yarÄ±m dÃ¼zeltilmeyen bir eksik**: `check` ve
`loan_installment` tÃ¼rleri 0006'dan beri CHECK'te izinli ama hiÃ§bir zaman hedef yÃ¼kleyicileri
olmadÄ±, yani bu tÃ¼rdeki kurallar her zaman sÄ±fÄ±r teslimat Ã¼retti. Faz 25 tahsilatÄ±n ihtiyaÃ§
duyduÄŸu iki tÃ¼rÃ¼ ekliyor; Ã§ek ve kredi taksiti baÄŸlamak finansman iÅŸidir ve buraya kaÃ§ak
sokulmaz.

**E-posta taÅŸÄ±yÄ±cÄ±sÄ± kasÄ±tlÄ± olarak SMTP istemcisi DEÄÄ°L.** Bu depo bu ortamda Ã§alÄ±ÅŸan dÄ±ÅŸ aÄŸ
Ã§aÄŸrÄ±sÄ± yapmÄ±yor; nodemailer + bir kimlik kÃ¼mesi eklemek, burada hiÃ§ Ã§alÄ±ÅŸtÄ±rÄ±lamayacak bir kod
yolu iÃ§in bir baÄŸÄ±mlÄ±lÄ±k ve sÄ±zacak bir sÄ±r eklemek olurdu. Telegram deseni birebir izlendi: env
ile adlandÄ±rÄ±lmÄ±ÅŸ HTTP uÃ§ noktasÄ±, tanÄ±msÄ±z/eriÅŸilemezken **fÄ±rlatmayan** baÅŸarÄ±sÄ±z
`DeliveryResult`, ve gerÃ§ek davranÄ±ÅŸÄ±n `mockTransport({ channel: "email" })` ile sÄ±nanmasÄ±.
`mockTransport` artÄ±k kanalÄ± parametre alÄ±yor â€” `"telegram"` sabit kodluydu ve e-posta yolu var
olduÄŸu anda onu test edilemez kÄ±lardÄ±.

---

## Hazine / Likidite Merkezi (Faz 26, migration 0062-0063)

Hazine yeni bir defter deÄŸil, mevcut veriye bakan bir **mercek**. 0063 hiÃ§bir yeni kaynak veri
Ã¼retmiyor: Faz 20'nin `bank_accounts`/`bank_transactions`'Ä±, Ã¼zerine oturduklarÄ± `cash_accounts`,
tarihli yÃ¼kÃ¼mlÃ¼lÃ¼kler (`payment_instances`, `checks`, `loan_installments`, `invoices`,
`promise_to_pay`) ve Faz 4/5'in `cashflow_months`'u â€” hepsi zaten var.

### 0062 â€” `treasury_policies`: eÅŸik kod deÄŸil VERÄ°

Plan "yapÄ±landÄ±rÄ±labilir nakit tamponu eÅŸiÄŸi" istiyor ve belirleyici kelime *yapÄ±landÄ±rÄ±labilir*.
TypeScript sabitine gÃ¶mÃ¼lÃ¼ bir taban, yalnÄ±z bir geliÅŸtiricinin deÄŸiÅŸtirebileceÄŸi bir sayÄ±dÄ±r â€”
hazine kararÄ± iÃ§in yanlÄ±ÅŸ sahip. Faz 24A'nÄ±n `approval_rules` emsali izlendi: kural bir satÄ±rda
durur, motor okur, deÄŸiÅŸtirmek denetlenen bir operatÃ¶r iÅŸlemidir.

**Ä°kinci bir sayÄ± icat EDÄ°LMEDÄ°.** `settings.negative_cash_threshold_try = 0` zaten var â€” Faz 4/5
projeksiyonunun "kasa eksiye dÃ¼ÅŸtÃ¼" saydÄ±ÄŸÄ± taban. Tohumlanan varsayÄ±lan `min_cash` politikasÄ± bu
yÃ¼zden 0 ve `phase26:verify` bu eÅŸitliÄŸi kontrol ediyor (Faz 24A'nÄ±n `amount_over_100k` â†”
`critical_payment_threshold_try` kontrolÃ¼yle aynÄ± desen). TabanÄ± sÄ±fÄ±rÄ±n Ã¼stÃ¼ne Ã§Ä±karmak zaten
tampon politikasÄ±nÄ±n varlÄ±k sebebi, ve artÄ±k bir satÄ±r dÃ¼zenlemesi.

Ä°ki tÃ¼r, fazlasÄ± deÄŸil: `min_cash` (mutlak taban) ve `buffer_days` (ortalama giderin N gÃ¼nÃ¼).
Konsantrasyon limiti bilinÃ§li olarak yok â€” Faz 23 karÅŸÄ± taraf konsantrasyonunu zaten puanlÄ±yor ve
buraya eklemek aynÄ± soruya ikinci bir cevap yeri aÃ§ardÄ±.

**YaÅŸam dÃ¶ngÃ¼sÃ¼ kolonu YOK ve bu Ã¶lÃ§Ã¼lerek iddia ediliyor.** Â§17 kural 3 (her yaÅŸam dÃ¶ngÃ¼sÃ¼
varlÄ±ÄŸÄ±na gÃ¼n-1'den transition guard) burada gerÃ§ekten N/A: politika ya aktiftir ya deÄŸildir,
`is_active` boolean'Ä±nÄ±n kÄ±sÄ±tlanacak ara durumu yok. 0054'Ã¼n `approval_rules` iÃ§in kaydettiÄŸi
gerekÃ§enin aynÄ±sÄ±; `phase26:verify` `status`/`state`/`lifecycle` kolonu olmadÄ±ÄŸÄ±nÄ± **yapÄ±sal
olarak** kontrol ediyor, yalnÄ±z yorumda iddia etmiyor.

Kapsam CHECK'i iki yÃ¶nlÃ¼ (`treasury_policies_kind_scope`): `min_cash` tutarsÄ±z, `buffer_days`
gÃ¼nsÃ¼z olamaz; eÅŸik onu okumayan bir tÃ¼re iliÅŸtirilemez. **SÄ±fÄ±r taban geÃ§erli** ("sÄ±fÄ±rÄ±n altÄ±na
inme") â€” 0 ile NULL farklÄ± ifadeler ve varsayÄ±lan tam olarak sÄ±fÄ±rdÄ±r.

`treasury_policies_active_unique` (NULLS NOT DISTINCT): aynÄ± kur+hesap iÃ§in ikinci bir **aktif**
politika olamaz. OlsaydÄ± view hangi tabanÄ± seÃ§eceÄŸini bilemez, planlayÄ±cÄ±nÄ±n dÃ¶ndÃ¼rdÃ¼ÄŸÃ¼ ilk satÄ±rÄ±
sessizce kullanÄ±rdÄ±.

**RLS: `config` sÄ±nÄ±fÄ±** â€” `settings` ile aynÄ±. Her katman okur (taban, bir uyarÄ±nÄ±n neden
gÃ¶rÃ¼ndÃ¼ÄŸÃ¼nÃ¼ aÃ§Ä±klar), yalnÄ±z admin yazar. Bilerek yÃ¶neticiye aÃ§Ä±k deÄŸil: kendi likidite
uyarÄ±larÄ±nÄ± yÃ¶neten tabanÄ± indirebilen bir yÃ¶netici, soruyu cevaplamak yerine alarmÄ± kapatÄ±yor
olurdu â€” 0058'in `approval_rules`'u admin'e sabitlerken kullandÄ±ÄŸÄ± argÃ¼manÄ±n aynÄ±sÄ±.

### 0063 â€” altÄ± read-model, hepsi VIEW

**Para birimleri ASLA netleÅŸtirilmiyor.** Her pozisyon kur bazÄ±nda gruplanÄ±yor ve hiÃ§bir view
kurlar arasÄ± toplama yapmÄ±yor. Faz 27'ye kadar kur tablosu yok; burada TRY ile EUR'yu toplamak bir
kur **icat etmeyi** gerektirirdi ve sessizce kur icat eden bir hazine ekranÄ±, iki satÄ±r gÃ¶steren
ekrandan kÃ¶tÃ¼dÃ¼r.

1. **`bank_cash_position`** â€” "bu hesapta ne kadar var" sorusunun **iki dÃ¼rÃ¼st cevabÄ±** yan yana:
   `stated_balance` (bankanÄ±n son ekstrede sÃ¶ylediÄŸi) ve `derived_balance` (aÃ§Ä±lÄ±ÅŸ + iÃ§e
   aktarÄ±lmÄ±ÅŸ hareketler). FarkÄ± `stated_minus_derived` olarak aÃ§Ä±kÃ§a hesaplanÄ±yor. Birini sessizce
   seÃ§mek, bu fazÄ±n uyarÄ±ldÄ±ÄŸÄ± arÄ±za tÃ¼rÃ¼nÃ¼n ta kendisi olurdu. `ignored` hareketler tÃ¼retilen
   bakiyeye girmiyor (0042: onlar aÃ§Ä±kÃ§a para deÄŸil), ama `unmatched` giriyor â€” eÅŸleÅŸtirme bir
   belgeye baÄŸlamakla ilgilidir, hareketin gerÃ§ekleÅŸip gerÃ§ekleÅŸmediÄŸiyle deÄŸil.
2. **`daily_cash_movement`** â€” gÃ¼nlÃ¼k giriÅŸ/Ã§Ä±kÄ±ÅŸ/net ve kur bazÄ±nda pencere fonksiyonuyla
   yÃ¼rÃ¼yen pozisyon (saklanan kolon deÄŸil: sayÄ±, hesaplandÄ±ÄŸÄ± satÄ±rlardan sapamamalÄ±).
3. **`treasury_position_summary`** â€” kur bazÄ±nda toplamlar, `available_now` (bloke dÃ¼ÅŸÃ¼lmÃ¼ÅŸ) ve
   `available_with_overdraft`.
4. **`liquidity_forecast_daily`** â€” her satÄ±r zaten baÅŸka bir yerde kayÄ±tlÄ±, **tarihli, bilinen**
   bir yÃ¼kÃ¼mlÃ¼lÃ¼k ya da beklenti. Trend uydurmuyor. `certainty` sÃ¼tunu sÃ¶zleÅŸmeli yÃ¼kÃ¼mlÃ¼lÃ¼ÄŸÃ¼
   mÃ¼ÅŸterinin beyanÄ±ndan ayÄ±rÄ±yor: Faz 25'in Ã¶deme sÃ¶zÃ¼ dahil, Ã§Ã¼nkÃ¼ hazineci onunla plan yapar â€”
   ama imzalÄ± bir taksitle aynÄ± aÄŸÄ±rlÄ±kta toplanmamalÄ±. **TutarÄ± bilinmeyen sÃ¶z tahmine hiÃ§
   girmiyor**, sÄ±fÄ±r olarak deÄŸil.
5. **`treasury_liquidity_gap`** â€” 7/30/90 **GÃœN**. Ä°ki projeksiyon birden dÃ¶ndÃ¼rÃ¼yor:
   `projected_contracted` (yalnÄ±z yÃ¼kÃ¼mlÃ¼lÃ¼kler, muhafazakÃ¢r) ve `projected_expected` (sÃ¶zlere de
   inanan). **Taban ihlali SÃ–ZLEÅMELÄ° rakamla yargÄ±lanÄ±yor** â€” bir mÃ¼ÅŸteri sÃ¶zÃ¼ alarmÄ±
   susturamamalÄ±. `financing_need` asla negatif deÄŸil (taban aÅŸÄ±lmÄ±ÅŸsa fark, deÄŸilse 0), bÃ¶ylece
   toplanabilir.
6. **`treasury_cashflow_reconciliation`** â€” aÅŸaÄŸÄ±ya bakÄ±n.

### TutarlÄ±lÄ±k kuralÄ±: sapma **bildirilir**, dÃ¼zeltilmez

PlanÄ±n gate ÅŸartÄ± burada tek seferlik bir assertion deÄŸil, birinci sÄ±nÄ±f bir read-model:
hazine pozisyonu `cashflow_months.closing_balance`'tan **sessizce sapmamalÄ±**.

Ä°ki rakam gerÃ§ekten farklÄ± yerlerden geliyor â€” biri gÃ¶zden geÃ§irilmiÅŸ aylÄ±k workbook projeksiyonu,
diÄŸeri iÃ§e aktarÄ±lmÄ±ÅŸ banka hareketlerinin toplamÄ± â€” dolayÄ±sÄ±yla **farklÄ± olabilirler ve sÄ±k sÄ±k
meÅŸru ÅŸekilde olurlar** (ekstresi henÃ¼z aktarÄ±lmamÄ±ÅŸ bir ay, ayÄ±n tamamÄ± kadar farklÄ± Ã§Ä±kar).

View bu yÃ¼zden onlarÄ± **mutabÄ±k kÄ±lmÄ±yor**: ortalamÄ±yor, birini tercih etmiyor, "dÃ¼zeltmiyor".
Yan yana koyuyor, farkÄ± ve dÃ¶rt durumdan birini (`aligned` / `divergent` / `cashflow_missing` /
`no_bank_movement`) veriyor. BaÅŸka her davranÄ±ÅŸ, CLAUDE.md'nin doÄŸrudan yasakladÄ±ÄŸÄ± ÅŸey olurdu:
belirsiz satÄ±rlardan nihai gerÃ§eÄŸi Ã§Ä±karmak.

Tolerans 1,00 TL ve `findContinuityIssues`'un mevcut yuvarlama payÄ±yla **aynÄ±** â€” hazine "yeterince
yakÄ±n"Ä±n ikinci bir tanÄ±mÄ±nÄ± icat etmiyor. AynÄ± karar `src/lib/treasury/rules.ts` iÃ§indeki
`reconciliationVerdict` ile TypeScript tarafÄ±nda da hesaplanÄ±yor; `phase26:verify` ikisini aynÄ±
fixture Ã¼stÃ¼nde Ã§alÄ±ÅŸtÄ±rÄ±p **birebir aynÄ±** olduklarÄ±nÄ± kanÄ±tlÄ±yor (Ã¼Ã§ ay: uyumlu, sapan,
hareketsiz).

### Faz 5 motoru GENÄ°ÅLETÄ°LDÄ°, Ã§atallanmadÄ±

`src/lib/treasury/rules.ts` aylÄ±k primitifleri `@/lib/radar/rules`'tan **iÃ§e aktarÄ±yor** â€”
`buildProjection` hÃ¢lÃ¢ "hangi ayda bakiye ilk kez eksiye dÃ¼ÅŸer" sorusunu cevaplÄ±yor; bu modÃ¼l
hazinenin gerÃ§ekten sorduÄŸu kÄ±sa ufuk sorusunu ekliyor: "Ã¶nÃ¼mÃ¼zdeki 7, 30, 90 **GÃœN**de tabanÄ±
koruyacak mÄ±yÄ±m". AynÄ± yÃ¼kÃ¼mlÃ¼lÃ¼kler, bilinmeyen deÄŸerler iÃ§in aynÄ± kurallar, farklÄ± pencere.

BÃ¶lÃ¼m bilinÃ§li:
- `radar/rules.ts` â†’ **aylar**, `cashflow_months`'tan (gÃ¶zden geÃ§irilmiÅŸ workbook projeksiyonu)
- `treasury/rules.ts` â†’ **gÃ¼nler**, tarihli yÃ¼kÃ¼mlÃ¼lÃ¼klerden (fiilen hareket etmesi planlanan)

Ã–rtÃ¼ÅŸtÃ¼kleri yerde aynÄ± fikirde olmalÄ±lar, ve `reconciliationVerdict` anlaÅŸmazlÄ±ÄŸÄ±n **dÃ¼zeltilmek
yerine bildirilme** biÃ§imi. `phase26:verify` `treasury/rules.ts`'in `radar/rules`'tan import
ettiÄŸini kaynak seviyesinde kontrol ediyor â€” "paralel motor icat etme" kuralÄ± bÃ¶ylece iddia deÄŸil,
test.

Ufuk penceresi **yarÄ± aÃ§Ä±k**: `[bugÃ¼n, bugÃ¼n+N)`. Tam N gÃ¼n sonraki bir akÄ±ÅŸ bir sonraki ufka ait,
iki kez sayÄ±lmaz; bugÃ¼nkÃ¼ akÄ±ÅŸ **dahil** (bu sabah hareket eden para bugÃ¼nÃ¼n likiditesidir).

`bufferDaysFloor` gider geÃ§miÅŸi yoksa **null** dÃ¶ndÃ¼rÃ¼yor, 0 deÄŸil: 0 "tampon gerekmiyor" diye
okunur ve ikisinden tehlikeli olanÄ± odur. Ä°ki taban da aktifse `effectiveFloor` **yÃ¼kseÄŸini**
seÃ§iyor â€” ikisi de asgari, dÃ¼ÅŸÃ¼ÄŸÃ¼ saÄŸlamak diÄŸerini ihlal bÄ±rakÄ±r.

---

## Finansman GeniÅŸletme ve Kur Riski (Faz 27, migration 0064-0067)

### 0064 â€” `credit_facilities`: borÃ§lanma **izni**, borcun kendisi deÄŸil

TasarÄ±mdan Ã¶nce Ã¶lÃ§Ã¼ldÃ¼. `loans` **sabit planlÄ±** bir enstrÃ¼man: `principal`, `term_months`,
`installment_count`, `first_payment_date` ve tek bir `installment_amount` taÅŸÄ±yor, ve 0005 tÃ¼m
amortismanÄ± yaratÄ±ldÄ±ÄŸÄ± anda `loan_installments`'a materyalize ediyor. Bu kolonlarÄ±n hepsi
**paranÄ±n zaten alÄ±ndÄ±ÄŸÄ±nÄ± ve geri Ã¶deme tarihlerinin bilindiÄŸini** varsayÄ±yor.

Bir limit bunlarÄ±n hiÃ§birini varsaymaz. O bir **tavan** â€” bankanÄ±n Ã§ekim yapma izni â€” ve
tanÄ±mlayÄ±cÄ± durumlarÄ± "ne kadar alabiliriz" ile "ne kadar aldÄ±k". Bir limit bir yÄ±l boyunca sÄ±fÄ±r
kullanÄ±mda durabilir ve yine de hazine ekranÄ±ndaki en Ã¶nemli sayÄ± olabilir, Ã§Ã¼nkÃ¼ **henÃ¼z
borÃ§lanÄ±lmadan var olan likidite**dir. Bunu bir kredi olarak modellemek, kimsenin Ã§ekmediÄŸi para
iÃ§in sahte bir anapara ve sahte bir taksit planÄ± uydurmayÄ± gerektirirdi.

Ä°kisi buluÅŸuyor: rotatif bir limitten Ã§ekim yapmak Ã§oÄŸu zaman kendi planÄ± olan bir **kredi
yaratÄ±r**. Bu iliÅŸki `facility_drawdowns.loan_id` (nullable FK) â€” birleÅŸtirilmiÅŸ tablo deÄŸil.

**KasÄ±tlÄ± olarak SAKLANMAYAN:** `drawn`, `available`. Ä°kisi de Ã§ekim satÄ±rlarÄ± Ã¼zerinde toplam ve
0067'de view kolonu olarak veriliyor. Saklanan bir kullanÄ±m rakamÄ± bir sonraki Ã§ekimde bayatlar ve
yanlÄ±ÅŸken gayet makul gÃ¶rÃ¼nÃ¼r.

TÃ¼rler arasÄ±nda `guarantee_letter` (teminat mektubu) ve `letter_of_credit` **gayrinakdÃ®**: hiÃ§
nakit Ã¼retmeden limit tÃ¼ketirler, ki aynÄ± tavana karÅŸÄ± izlenmelerinin sebebi tam olarak budur.

#### Durum izin listesi (CHECK ile AYNI migration'da, 0027 dersi)

Sekiz geÃ§iÅŸ; ikisi atlanmasÄ± kolay olduÄŸu iÃ§in ayrÄ±ca yazÄ±lÄ±yor:

| Eski | Yeni | Neden Ã¶nemli |
|---|---|---|
| suspended | expired | **DondurulmuÅŸ limit de yaÅŸlanÄ±r.** Bu olmasaydÄ± her donmuÅŸ hat, vadesi geÃ§tiÄŸinde sonsuza kadar `suspended` kalÄ±rdÄ±. |
| expired | active | **Yenileme.** Bankalar yÄ±llÄ±k limitleri rutin olarak yeniler; bunun yerine yeni satÄ±r aÃ§mak limiti kendi Ã§ekim geÃ§miÅŸinden koparÄ±rdÄ±. |

`closed` terminal; `expired â†’ suspended` reddediliyor (Ã§oktan sona ermiÅŸ bir ÅŸeyi dondurmak kimsenin
aksiyon alamayacaÄŸÄ± bir durum). Gate 12 sÄ±ralÄ± Ã§iftin tamamÄ±nÄ± gerÃ§ek satÄ±rlarda deniyor: 8 kabul,
4 ret, ve koddaki `canTransition` ile birebir aynÄ± olduÄŸu ayrÄ±ca kanÄ±tlanÄ±yor.

`facility_drawdowns.signed_amount` **generated**: iÅŸareti `movement_type` taÅŸÄ±yor, operatÃ¶rÃ¼n elle
eksi yazmasÄ±na bÄ±rakÄ±lmÄ±yor.

### 0065 â€” teminat ve kovenantlar

Ä°kisi de **ya bir krediye ya bir limite** baÄŸlanÄ±yor ve baÄŸ, tam olarak birinin dolu olmasÄ±nÄ±
zorlayan CHECK ile **iki nullable FK** â€” polimorfik (tablo, id) Ã§ifti deÄŸil. 0053 approvals'ta
polimorfizm kullandÄ± Ã§Ã¼nkÃ¼ yedi ilgisiz tabloyu kapsÄ±yordu ve hiÃ§bir FK bunu yapamazdÄ±. Burada tam
iki hedef var ve ikisi de gerÃ§ek tablo, yani gerÃ§ek FK mÃ¼mkÃ¼n â€” ve gerÃ§ek bir FK simetriden deÄŸerli:
artÄ±k var olmayan bir krediyi iÅŸaret eden kovenantÄ± engeller.

`collateral_records.value_amount` NULL olabilir: **deÄŸerlenmemiÅŸ, deÄŸersiz deÄŸil**. DeÄŸerlemeyi kimin
yaptÄ±ÄŸÄ± da kayÄ±tlÄ± (`valuation_source`) â€” bankanÄ±n ekspertizi ile sahibin tahmini aynÄ± iddia deÄŸildir.

**Kovenant kaydÄ± MADDEnin kendisi, Ã¶lÃ§Ã¼m deÄŸil.** YaÅŸam dÃ¶ngÃ¼sÃ¼ bu yÃ¼zden Ã¼Ã§ durumlu: madde
yÃ¼rÃ¼rlÃ¼kte, banka tarafÄ±ndan muaf tutulmuÅŸ, ya da kalkmÄ±ÅŸ. Uyumlu olup olmadÄ±ÄŸÄ±mÄ±z bir **test
sonucudur** ve test sonuÃ§larÄ± veri kolonu (`last_test_date` / `last_test_result`), yaÅŸam dÃ¶ngÃ¼sÃ¼
durumu deÄŸil â€” aksi hÃ¢lde rutin aylÄ±k bir testin geÃ§ip kalmasÄ±, maddeyi sahibi olmadÄ±ÄŸÄ± bir durum
makinesinde sÃ¼rÃ¼klerdi. `waived â†’ active` izinli: **muafiyetler sÃ¼reli verilir**, ve bu geÃ§iÅŸ
olmasaydÄ± madde kalÄ±cÄ± olarak muaf gÃ¶rÃ¼nÃ¼rdÃ¼ â€” ki unutulan kovenant tam olarak odur.

### 0066 â€” FX: gÃ¶zlemlenen kurlar ve taÅŸÄ±nan pozisyon

Ä°ki tablo, bilinÃ§li olarak farklÄ± karakterde:

- **`fx_rate_snapshots` bir GÃ–ZLEM.** "21.08.2026'da TCMB USD/TRY satÄ±ÅŸ kuru X idi." Bu tarihsel bir
  olgudur ve **SALT-EKLEME** (0022 deseni: trigger + REVOKE + Faz 24B `evidence` sÄ±nÄ±fÄ±). Sonradan
  dÃ¼zenlenebilen bir kur, Ã¼zerine kurulan her deÄŸerlemeyi **Ã§Ã¼rÃ¼tÃ¼lemez** yapar â€” geÃ§en Ã§eyreÄŸin
  kÃ¢rÄ±nÄ± her zaman istediÄŸiniz gibi gÃ¶sterebilirsiniz. AynÄ± gÃ¼n + aynÄ± kaynak iÃ§in ikinci kayÄ±t
  reddediliyor; **dÃ¼zeltme farklÄ± bir kaynaktÄ±r**, Ã¼zerine yazma deÄŸil.
- **`fx_positions` bir MARUZÄ°YET** â€” kaydettiÄŸimiz ve revize ettiÄŸimiz sÄ±radan operasyonel veri.

TCMB dÃ¶rt rakam yayÄ±mlÄ±yor ve bunlar birbirinin yerine geÃ§mez (alÄ±ÅŸta biri, satÄ±ÅŸta diÄŸeri).
DÃ¶rdÃ¼ de kaydediliyor; `rate` deÄŸerlemenin kullandÄ±ÄŸÄ±dÄ±r. `fx_positions.amount` **iÅŸaretli**:
pozitif varlÄ±k, negatif yÃ¼kÃ¼mlÃ¼lÃ¼k â€” tek iÅŸaretli kolon, net pozisyonu dÃ¼z toplama Ã§eviriyor ve
hiÃ§bir tÃ¼keticinin iÅŸareti unutmasÄ±na izin vermiyor. `entry_rate` olmadan kazanÃ§ **hesaplanamaz**,
tahmin edilebilir; bu yÃ¼zden NULL entry_rate NULL kazanÃ§ verir.

### 0067 â€” read-model'ler

**`credit_facility_utilization`** â€” limit/Ã§ekilen/kullanÄ±labilir. `available` sÄ±fÄ±rda sabitleniyor
ve **aÅŸÄ±m ayrÄ±ca bildiriliyor** (`over_limit`): negatif bir baÅŸlÄ±k, aÅŸaÄŸÄ± akan her toplamda grup
likiditesini birinin kredi aÅŸÄ±mÄ± kadar sessizce azaltÄ±rdÄ±.

**`debt_maturity_ladder` (30/90/180/365)** â€” iki gerÃ§ekten farklÄ± yÃ¼kÃ¼mlÃ¼lÃ¼k aynÄ± merdivende ama
**etiketli, birleÅŸtirilmemiÅŸ**: taksit hesaptan Ã§Ä±kacak bir tutardÄ±r; limit vadesi ise yenilenmesi
ya da kapatÄ±lmasÄ± gereken bir tavandÄ±r. Ä°kisini tek "vadesi gelen tutar"a toplamak, **kullanÄ±lmayan
her lira kadar** Ã§Ä±kÄ±ÅŸÄ± ÅŸiÅŸirirdi. Bu yÃ¼zden nakit maruziyeti sÃ¼tunu yalnÄ±z **Ã§ekilen** kÄ±smÄ±
sayÄ±yor; kullanÄ±lmadan sona eren limit hiÃ§bir ÅŸeye mal olmaz, sadece kullanÄ±labilir olmaktan Ã§Ä±kar.

**`fx_position_revaluation`** â€” deterministik. Her rakam kayÄ±tlÄ± bir kur ve kayÄ±tlÄ± bir pozisyon
Ã¼zerinde aritmetik; model, volatilite tahmini, daÄŸÄ±lÄ±m yok. Â±%5/10/20 bantlarÄ± tam olarak ÅŸudur:
aynÄ± pozisyonun, sabit bir yÃ¼zde oynatÄ±lmÄ±ÅŸ kurla deÄŸeri â€” okuyan biri her hÃ¼creyi hesap makinesiyle
yeniden Ã¼retebilir, ki sahibe gÃ¶sterilmeye deÄŸer tek stres rakamÄ± tÃ¼rÃ¼ budur.

`worst_case_20_delta` **pozisyonun yÃ¶nÃ¼ne gÃ¶re**: uzun pozisyon kur dÃ¼ÅŸÃ¼nce, kÄ±sa pozisyon kur
yÃ¼kselince zarar eder. Ä°ÅŸaretsiz tek bir "Â±%20 etkisi" yayÄ±mlamak, hazineciye **en bÃ¼yÃ¼k
yÃ¼kÃ¼mlÃ¼lÃ¼ÄŸÃ¼nÃ¼n en bÃ¼yÃ¼k tamponu olduÄŸunu** sÃ¶ylerdi.

### Para: gÃ¼n-1'den decimal

Bu fazÄ±n tÃ¼m FX/finansman matematiÄŸi `money.ts` Ã¼zerinden geÃ§iyor ve dÃ¶rt migration ile Ã¼Ã§ motorun
hiÃ§birinde `::float8` yok (`phase27:verify` bunu **kod Ã¼zerinde**, yorumlarÄ± ayÄ±klayarak kontrol
ediyor). Sebep somut: gerÃ§ekleÅŸmemiÅŸ kazanÃ§, birbirine Ã§ok yakÄ±n iki bÃ¼yÃ¼k sayÄ±nÄ±n farkÄ±dÄ±r
(`tutar Ã— kur_ÅŸimdi âˆ’ tutar Ã— kur_giriÅŸ`) â€” ikili kayan noktanÄ±n cevabÄ± kaybettiÄŸi aritmetiÄŸin ta
kendisi. Birim test yarÄ±m-kuruÅŸ sÄ±nÄ±rÄ±nda **Ã¶lÃ§Ã¼lmÃ¼ÅŸ** bir sapma Ã§iviliyor: `1 Ã— 1,005` decimal
half-up ile 1,01, float'ta 1,00 (Ã§Ã¼nkÃ¼ 1.005 aslÄ±nda 1.00499999999999989).

### TCMB: manuel/talep Ã¼zerine, canlÄ± akÄ±ÅŸ DEÄÄ°L

Plan canlÄ± baÄŸlantÄ±yÄ± Faz 37/38'e koyuyor. Bu faz Faz 20/25'in taÅŸÄ±yÄ±cÄ± desenini izliyor: bir
arayÃ¼z, eriÅŸilemezken **dÃ¼rÃ¼st bir hata** dÃ¶nen (asla fÄ±rlatmayan) gerÃ§ek bir uygulama, ve testlerin
sÃ¼rdÃ¼ÄŸÃ¼ deterministik bir mock. ZamanlayÄ±cÄ±/polling yok â€” gate bunu da kod Ã¼zerinde kontrol ediyor.

**Ortam deÄŸiÅŸkeni YOK:** uÃ§ nokta belgelenmiÅŸ varsayÄ±lanÄ± olan bir **parametre**. Bu bilinÃ§li â€” modÃ¼l
yÃ¼klenirken `@/lib/env` import etmek, `phase25-verify` ve `phase6b-verify`'Ä± kendi belgeledikleri
komutla Ã§alÄ±ÅŸamaz hÃ¢le getiren ÅŸeydi. Bir kur saÄŸlayÄ±cÄ±sÄ±nÄ±n veritabanÄ±yla iÅŸi yoktur, dolayÄ±sÄ±yla
buradaki hiÃ§bir ÅŸey bir veritabanÄ± talep edebilmemeli.

Ä°ki incelik `parseTcmbXml`'de, ikisi de makul ama yanlÄ±ÅŸ sayÄ± Ã¼retirdi:
1. **`Unit`.** TCMB bazÄ± kurlarÄ± 100 birim Ã¼zerinden kotalÄ±yor; birim baÅŸÄ± kur yayÄ±mlanan rakamÄ±n
   `Unit`'e bÃ¶lÃ¼mÃ¼dÃ¼r. Yok saymak JPY maruziyetini **yÃ¼z kat** ÅŸiÅŸirirdi.
2. **BoÅŸ elemanlar.** BÃ¼lten kotasyonu olmayan kurlar iÃ§in `<ForexBuying/>` gÃ¶nderiyor. Bunlar
   **NULL** olmalÄ±, 0 deÄŸil â€” sÄ±fÄ±r kur pozisyonu deÄŸersiz gÃ¶sterirdi, deÄŸerlenmemiÅŸ deÄŸil.

`importRates` **baÅŸarÄ±sÄ±z Ã§ekimde hiÃ§bir ÅŸey kaydetmiyor**: yarÄ±m aktarÄ±lmÄ±ÅŸ bir bÃ¼lten bazÄ±
pariteleri gÃ¼ncel bazÄ±larÄ±nÄ± bayat bÄ±rakÄ±r ve Ã¼zerine kurulan deÄŸerleme ikisini ayÄ±rt edemez.
Yeniden Ã§alÄ±ÅŸtÄ±rmak gÃ¼venli (unique kÄ±sÄ±t), ve `skipped` zaten var olanlarÄ± **yeni gibi gÃ¶stermeden**
raporluyor.

---

## BÃ¼tÃ§e ve Rolling Forecast (Faz 28, migration 0068-0070)

### 0068 â€” `budgets` + `budget_lines`

Boyutlar Faz 19'un tablolarÄ±ndan (`cost_centers`, `departments`, `projects`) ve mevcut
`categories`'den geliyor; gerÃ§ek kolon adlarÄ± yazmadan Ã¶nce introspection'la doÄŸrulandÄ± â€” hepsi
`(id, code, name, is_active)`, dolayÄ±sÄ±yla satÄ±r adlandÄ±rdÄ±ÄŸÄ± boyuttan sapabilecek bir kod metni
yerine dÃ¼z nullable FK taÅŸÄ±yor.

**Ã–LÃ‡ÃœLMÃœÅ BÄ°R SINIR, Ã¼stÃ¼ Ã¶rtÃ¼lmek yerine kaydedildi:** bu boyutlardan yalnÄ±z `cost_center` ve
`project` herhangi bir iÅŸlem tablosuna baÄŸlÄ± (`invoices`/`invoice_lines`), `category` ise yalnÄ±z
`payments`'a. **HiÃ§bir tablo departmanÄ± bir iÅŸleme baÄŸlamÄ±yor.** Yani bir departman bÃ¼tÃ§esi
yazÄ±labilir ama karÅŸÄ±laÅŸtÄ±rÄ±lacak gerÃ§ekleÅŸeni yoktur â€” 0070'in varyans view'Ä± var olan boyutlar
iÃ§in gerÃ§ekleÅŸen Ã¼retiyor ve departman gerÃ§ekleÅŸenini **NULL bÄ±rakÄ±yor**, tahsis kuralÄ± icat
etmiyor. Uydurmak, bu veritabanÄ±nda hiÃ§bir satÄ±rÄ±n kaydetmediÄŸi "bu parayÄ± hangi departman
harcadÄ±" sorusunu cevaplamak olurdu. `phase28:verify` bu boÅŸluÄŸu yapÄ±sal olarak doÄŸruluyor.

**BaÅŸlÄ±kta yaÅŸam dÃ¶ngÃ¼sÃ¼ kolonu YOK, bilerek.** Plan versiyon dÃ¶ngÃ¼sÃ¼nÃ¼ SATIRLARA koyuyor
(`draft/approved/superseded`) ve bÃ¼tÃ§e revizyonu gerÃ§ekten orada oluyor: finans ekibi tek tek
satÄ±rlarÄ± yeniden keser, bir yÄ±lÄ± atomik olarak taslaktan onaya Ã§evirmez. BaÅŸlÄ±ÄŸa ayrÄ± bir statÃ¼
vermek, kendi satÄ±rlarÄ±yla Ã§eliÅŸebilecek ikinci bir yaÅŸam dÃ¶ngÃ¼sÃ¼ yaratÄ±rdÄ± â€” taslak satÄ±rlarla
dolu "onaylÄ±" bir bÃ¼tÃ§e. Â§17 kural 3 versiyonun fiilen yaÅŸadÄ±ÄŸÄ± tabloda karÅŸÄ±lanÄ±yor.

`amount` NOT NULL: bu ÅŸemada null'Ä±n "bilinmiyor ama geÃ§erli" olmadÄ±ÄŸÄ± tek yer â€” satÄ±rÄ±n tÃ¼m amacÄ±
Ã¶lÃ§Ã¼lecek bir sayÄ± beyan etmek. SÄ±fÄ±r geÃ§erli ("bu kaleme Ã¶denek yok").

### 0069 â€” `forecasts` + `forecast_lines`

#### Neden `scenario_runs`'Ä± geniÅŸletmek yerine yeni tablolar (plan iki seÃ§eneÄŸi de aÃ§Ä±k bÄ±rakÄ±yor)

Ã–nce mevcut tablolarÄ± introspect ettim; ÅŸekil kararÄ± veriyor:

`scenario_run_lines` = `(month_start, baseline_income, scenario_income, baseline_expense,
scenario_expense, baseline_closing, scenario_closing, delta)`.

**Her deÄŸer kolonu bir baseline/senaryo Ã‡Ä°FTÄ°.** O tablo tek bir soruyu cevaplÄ±yor â€” "bu iki dÃ¼nya
nasÄ±l farklÄ±laÅŸÄ±yor" â€” ve iyi cevaplÄ±yor. Rolling forecast iki dÃ¼nyanÄ±n karÅŸÄ±laÅŸtÄ±rmasÄ± deÄŸil;
revize edilen, kaynaÄŸÄ±na gÃ¶re sÄ±nÄ±flanan, gÃ¼ven skoru verilen ve sonradan gerÃ§ekleÅŸenle Ã¶lÃ§Ã¼len
**TEK** bir projeksiyon. Oraya koymak her satÄ±rÄ±n yarÄ±sÄ±nÄ± anlamsÄ±z bÄ±rakÄ±r (bir tahmin satÄ±rÄ±nÄ±n
baseline'Ä± ne?) ve "bu run aslÄ±nda what-if deÄŸil" diyen bir ayÄ±rt edici kolon gerektirirdi.

ÃœÃ§ somut uyumsuzluk daha:
1. **GranÃ¼lerlik.** `scenario_run_lines.month_start` kesin olarak aylÄ±k. Bu fazÄ±n teslim etmesi
   gereken 13 haftalÄ±k nakit tahmini **HAFTALIK**. Hafta baÅŸlangÄ±Ã§larÄ±nÄ± `month_start` adlÄ± bir
   kolona yazmak, sonraki her okuyucunun devraldÄ±ÄŸÄ± bir yalan olurdu.
2. **YaÅŸam dÃ¶ngÃ¼sÃ¼.** `scenario_runs` arÅŸivsel â€” `archived_at`/`archive_reason` ve triplet
   tutarlÄ±lÄ±k kÄ±sÄ±tÄ± taÅŸÄ±yor, yani bir hesaplamanÄ±n **deÄŸiÅŸmez Ã‡IKTISI**. Bu faz tahmin
   satÄ±rlarÄ±nda versiyon dÃ¶ngÃ¼sÃ¼ istiyor; `scenario_runs`'a versiyonlama takmak mevcut her senaryo
   satÄ±rÄ±nÄ±n anlamÄ±nÄ± deÄŸiÅŸtirirdi.
3. **Kimlik.** Senaryo koÅŸusu bir kez Ã¼retilir ve okunur; tahmin **sÃ¼rdÃ¼rÃ¼lÃ¼r** â€” haftalÄ±k revize
   edilir, yeniden onaylanÄ±r ve sonradan doÄŸruluÄŸu Ã¶lÃ§Ã¼lÃ¼r.

**Kopyalanmak yerine yeniden kullanÄ±lan:** `forecasts.scenario_run_id` nullable FK â€” bir what-if
koÅŸusundan Ã¼retilen tahmin, kendisini Ã¼reten mekanizmayla baÄŸÄ±nÄ± koruyor. Senaryo motoru
**baÄŸlanarak** geniÅŸletiliyor, aÅŸÄ±rÄ± yÃ¼klenerek deÄŸil.

#### Kaynak sÄ±nÄ±flandÄ±rmasÄ± ve gÃ¼ven

`source_kind`: `contracted` / `scheduled` / `historical` / `manual` / `estimated` â€” sayÄ±nÄ±n
**NEREDEN GELDÄ°ÄÄ°NÄ°N** Ã¶zelliÄŸi, birinin ona ne kadar gÃ¼vendiÄŸinin deÄŸil; kolon olmasÄ±nÄ±n sebebi
bu. VarsayÄ±lan gÃ¼ven skorlarÄ± (0,95 â†’ 0,50) sabit bir tablo, Ã¶ÄŸrenilmiÅŸ aÄŸÄ±rlÄ±k deÄŸil; kolonda
**fiilen kullanÄ±lan** deÄŸer saklanÄ±yor, bÃ¶ylece varsayÄ±lanlarÄ±n sonradan deÄŸiÅŸmesi geÃ§miÅŸ gÃ¼veni
sessizce yeniden yazamÄ±yor.

`actual_amount` NULL = dÃ¶nem henÃ¼z Ã¶lÃ§Ã¼lmedi, "hiÃ§bir ÅŸey olmadÄ±" DEÄÄ°L â€” doÄŸruluk view'Ä±nÄ±n yalnÄ±z
Ã¶lÃ§Ã¼lmÃ¼ÅŸ satÄ±rlarÄ± saymasÄ±nÄ±n sebebi tam olarak bu.

#### Versiyon geÃ§iÅŸ guard'Ä± (CHECK ile AYNI migration'da, her iki tabloda)

AltÄ± sÄ±ralÄ± Ã§iftten Ã¼Ã§Ã¼ izinli: `draftâ†’approved`, `draftâ†’superseded`, `approvedâ†’superseded`.

**`approved â†’ draft` REDDEDÄ°LÄ°YOR** ve guard'Ä±n bÃ¼tÃ¼n mesele bu: onaylanmÄ±ÅŸ bir satÄ±rÄ± yeniden
aÃ§mak, birinin imzaladÄ±ÄŸÄ± rakamÄ± sessizce yeniden yazardÄ± ve Ã¼zerine kurulu her varyans raporu
okuyucularÄ±nÄ±n altÄ±nda, hiÃ§bir kayÄ±t bÄ±rakmadan deÄŸiÅŸirdi. Revizyon, eskisini **supersede eden yeni
bir satÄ±rdÄ±r** â€” `superseded_by_line_id`'nin varlÄ±k sebebi de bu. `superseded` terminal.

TutarlÄ±lÄ±k kÄ±sÄ±tÄ± imalar yÄ±ÄŸÄ±nÄ± yerine **tÃ¼ketici**: her durum hangi damgalarÄ± taÅŸÄ±yabileceÄŸini
tek tek sÃ¶ylÃ¼yor. Superseded bir satÄ±r Ã¶nce onaylanmÄ±ÅŸ da olabilir, taslaktan doÄŸrudan da
supersede edilmiÅŸ olabilir â€” `approved_at` yalnÄ±z o dalda serbest bÄ±rakÄ±lmasÄ±nÄ±n sebebi bu.

### 0070 â€” read-model'ler

**Ã‡Ä°FT SAYMA TUZAÄI, aÃ§Ä±kÃ§a kaÃ§Ä±nÄ±ldÄ±:** aynÄ± para hem fatura hem onu kapatan Ã¶deme olarak gÃ¶rÃ¼nÃ¼r.
Ä°kisini toplamak gerÃ§ekleÅŸen gideri kabaca iki katÄ±na Ã§Ä±karÄ±r ve sayÄ± yine makul gÃ¶rÃ¼nÃ¼rdÃ¼.
GerÃ§ekleÅŸen **yalnÄ±z FATURALARDAN** geliyor; Ã¶deme tarafÄ± bilerek katÄ±lmÄ±yor.

`budget_vs_actual` yalnÄ±z **ONAYLI** satÄ±rlarÄ± Ã¶lÃ§Ã¼yor. Taslak satÄ±rlar Ã§alÄ±ÅŸma notu, superseded
satÄ±rlar geÃ§miÅŸtir; ikisine karÅŸÄ± varyans raporlamak, birileri hÃ¢lÃ¢ dÃ¼zenlerken bir sayÄ±nÄ±n
deÄŸiÅŸmesine izin vermek olurdu â€” versiyon dÃ¶ngÃ¼sÃ¼nÃ¼n var olma sebebi.

**Karar YÃ–N duyarlÄ±:** gider bÃ¼tÃ§esini aÅŸmak ile gelir hedefini aÅŸmak zÄ±t sonuÃ§lardÄ±r; iÅŸaretsiz
tek bir "varyans" iyi bir ayÄ± kÄ±rmÄ±zÄ±ya boyardÄ±. GerÃ§ekleÅŸen yoksa sonuÃ§ **NULL ve
`not_measured`**, sÄ±fÄ±r deÄŸil â€” sÄ±fÄ±r "hiÃ§ harcanmadÄ±" iddiasÄ±dÄ±r.

`cash_forecast_13w` haftalarÄ± **Ã¼retiyor**, var olan satÄ±rlardan tÃ¼retmiyor: ufuk her zaman tam 13
kova. Tahmin satÄ±rÄ± olmayan bir hafta boÅŸ hafta olarak gÃ¶rÃ¼nmeli â€” nakit tahmininden sessizce
dÃ¼ÅŸen bir hafta, boÅŸluÄŸun gÃ¶rÃ¼nmez hÃ¢le gelme biÃ§imidir. YanÄ±nda iki alternatif net akÄ±ÅŸ:
**yalnÄ±z sÃ¶zleÅŸmeli** (her tahmin yanlÄ±ÅŸ Ã§Ä±karsa ayakta kalan) ve **gÃ¼ven aÄŸÄ±rlÄ±klÄ±**.

`forecast_accuracy` yalnÄ±z Ã¶lÃ§Ã¼lmÃ¼ÅŸ satÄ±rlarÄ± sayÄ±yor â€” Ã¶lÃ§Ã¼lmemiÅŸ bir satÄ±rÄ± dahil etmek,
tahmini ne kadar az kontrol edilmiÅŸse o kadar doÄŸru gÃ¶stermek olurdu; tam tersi. MAPE'de sÄ±fÄ±r
tahminli satÄ±rlar hariÃ§ (sÄ±fÄ±ra bÃ¶lme tanÄ±msÄ±z, %100 hata saymak tek satÄ±rÄ±n KPI'yÄ± domine etmesine
yol aÃ§ardÄ±) ve **hariÃ§ tutulan sayÄ± ayrÄ±ca raporlanÄ±yor**.

### PekiÅŸtirme: LLM forecast zincirinin tamamen dÄ±ÅŸÄ±nda

`src/lib/budget/{rules,engine}.ts` **`@/lib/ai`'yi hiÃ§ import etmiyor** ve `phase28:verify` bunu
kod Ã¼zerinde (yorumlar ayÄ±klanarak) kontrol ediyor â€” negatif kontrolle kanÄ±tlandÄ±: gerÃ§ek bir
import enjekte edildiÄŸinde gate 46/46'dan 45/46'ya dÃ¼ÅŸÃ¼yor, dosyadaki aÃ§Ä±klama yorumlarÄ± ise
tetiklemiyor.

BaÄŸÄ±mlÄ±lÄ±k tek yÃ¶nlÃ¼: AI katmanÄ± bu modÃ¼llerin **Ã§Ä±ktÄ±sÄ±nÄ±** herhangi bir olgu gibi okuyabilir,
tersi olamaz. Bir dil modelinden geÃ§miÅŸ varyans rakamÄ± yeniden Ã¼retilemez olurdu ve varyans
raporunun bÃ¼tÃ¼n anlamÄ±, iki kiÅŸinin aynÄ± sayÄ±yÄ± bulmasÄ±dÄ±r. `ai/engine.ts`'in "Ã¶nce deterministik,
LLM yalnÄ±z yorum" sÄ±nÄ±rÄ± (Faz 12) olduÄŸu gibi duruyor.

---

## Senaryo/Optimizasyon GeniÅŸletme (Faz 29, migration 0071-0073)

### 0071 â€” `optimization_runs` + `optimization_recommendations`

**Bir Ã¶neri Ã–NERÄ°DÄ°R, mutasyon deÄŸil.** Bu fazÄ±n yÃ¼k taÅŸÄ±yan kuralÄ±. CLAUDE.md otomasyonun Ã¶demeyi
Ã¶dendi iÅŸaretlemesini, vade deÄŸiÅŸtirmesini, tutar deÄŸiÅŸtirmesini yasaklÄ±yor. OptimizatÃ¶r bu yÃ¼zden
`payment_instances`, `invoices`, `checks`, `loans`, `cashflow_months` tablolarÄ±na **hiÃ§ yazmÄ±yor**.
OnlarÄ± okuyor ve BURAYA bir insanÄ±n seÃ§ebileceÄŸi eylemleri tarif eden satÄ±rlar yazÄ±yor. Bir Ã¶neriye
gÃ¶re hareket etmek insan eylemi olarak kalÄ±yor ve Faz 24A'nÄ±n onay varlÄ±ÄŸÄ± bunu kapÄ±da tutuyor.

**YaÅŸam dÃ¶ngÃ¼sÃ¼ kolonu YOK, bilerek.** Ä°lk iÃ§gÃ¼dÃ¼ bir `status` (draft/approved/applied) kolonu;
yanlÄ±ÅŸ iÃ§gÃ¼dÃ¼. Bir optimizasyon Ã§alÄ±ÅŸmasÄ±nÄ±n onay durumu `approvals`'a ait â€” Faz 24A tam olarak
Ã¼Ã§Ã¼ncÃ¼ bir Ã¶zel inceleme varyantÄ± olmasÄ±n diye kuruldu. 0072 polimorfik `subject_table`'a
`optimization_runs` ekliyor, yani bu **baÄŸlanÄ±yor**, Ã§atallamÄ±yor. Buraya bir statÃ¼ koymak,
bir Ã¶neri kÃ¼mesinin onaylÄ± olup olmadÄ±ÄŸÄ± hakkÄ±nda **ikinci bir doÄŸruluk kaynaÄŸÄ±** yaratÄ±rdÄ± ve
ikisi er ya da geÃ§ ayrÄ±ÅŸÄ±rdÄ± â€” Faz 24A'nÄ±n bir fazÄ±nÄ± harcayarak ortadan kaldÄ±rdÄ±ÄŸÄ± arÄ±za.
Â§17 kural 3 uygulanmÄ±yor Ã§Ã¼nkÃ¼ korunacak bir yaÅŸam dÃ¶ngÃ¼sÃ¼ yok; gate bunu yorumda iddia etmek
yerine **yapÄ±sal olarak** doÄŸruluyor.

`rationale_codes` NOT NULL ve en az bir kural adÄ± taÅŸÄ±mak zorunda (Faz 23 konvansiyonu: karar
her zaman onu Ã¼reten kural adlarÄ±yla birlikte gezer). Sorgulanamayan bir optimizasyon Ã¶nerisi,
hazinecinin haklÄ± olarak yok sayacaÄŸÄ± bir Ã¶neridir.

#### `coalesce(array_length(...), 0)` â€” gate'in yakaladÄ±ÄŸÄ± gerÃ§ek bir hata

KÄ±sÄ±t Ã¶nce `array_length(rationale_codes, 1) >= 1` yazÄ±lmÄ±ÅŸtÄ±. **BoÅŸ bir dizide `array_length()`
0 deÄŸil NULL dÃ¶ner**, dolayÄ±sÄ±yla `'{}'` iÃ§in ifade NULL'a dÃ¼ÅŸer â€” ve **NULL'a dÃ¼ÅŸen bir CHECK
GEÃ‡ER**. KÄ±sÄ±t tam olarak engellemek iÃ§in var olduÄŸu satÄ±rlarÄ± kabul ediyordu, Ã¼stelik Ã§alÄ±ÅŸÄ±yormuÅŸ
gibi okunuyordu. KÃ¼mede Ã¶lÃ§Ã¼ldÃ¼:

```
array_length('{}',1) is null            -> t
(array_length('{}',1) >= 1) is null     -> t     (CHECK geÃ§iyor)
coalesce(array_length('{}',1),0) >= 1   -> f     (doÄŸru reddediyor)
```

YÃ¶n kÄ±sÄ±tlarÄ± da aynÄ± sÄ±nÄ±ftan: `defer_payment` ileri, `advance_payment` geri gitmek zorunda. YÃ¶n
ters olsaydÄ± her Ã¶neri sessizce tersine dÃ¶ner ve bÃ¼tÃ¼n sayÄ±lar yine makul gÃ¶rÃ¼nÃ¼rdÃ¼.

### 0072 â€” `approvals.subject_table` geniÅŸletmesi (baÅŸka hiÃ§bir ÅŸey yapmayan migration)

Faz 22/25 emsali: enum CHECK geniÅŸletmesi kendi aÃ§Ä±k migration'Ä±nÄ± alÄ±r. **Bu baÄŸlantÄ±dÄ±r,
Ã§atallama deÄŸil** â€” Faz 24A `approvals`'Ä± polimorfik `(subject_table, subject_id)` ile tam olarak
yeni bir onaylanabilir ÅŸeyin bir enum deÄŸerine mal olmasÄ± iÃ§in kurdu. Senaryo/optimizasyon onayÄ±
bu yÃ¼zden bir deÄŸer ekliyor ve `requestApproval`/`decideApproval`'Ä± deÄŸiÅŸtirmeden kullanÄ±yor.

#### Tipin yakalayamadÄ±ÄŸÄ± Ã§alÄ±ÅŸma-zamanÄ± hatasÄ±

`requestApprovalSchema` `raw: unknown` alÄ±yor, dolayÄ±sÄ±yla koddaki Zod enum'u ile veritabanÄ±
CHECK'i arasÄ±ndaki **sÃ¼rÃ¼klenme derleyiciye gÃ¶rÃ¼nmez**. Faz 29 tam olarak buna Ã§arptÄ±: Ã¶nce CHECK
geniÅŸletildi, `SUBJECT_TABLES` geniÅŸletilmedi; typecheck temiz geÃ§ti ve hata ancak
`requestOptimizationApproval` Ã§aÄŸrÄ±ldÄ±ÄŸÄ±nda bir Zod doÄŸrulama hatasÄ± olarak Ã§Ä±kardÄ±.
`phase29:verify` artÄ±k iki listeyi **doÄŸrudan karÅŸÄ±laÅŸtÄ±rÄ±yor** (yalnÄ±z-DB / yalnÄ±z-kod farkÄ±nÄ±
adÄ±yla bildiriyor), bÃ¶ylece bir sonraki geniÅŸletme yarÄ±m kalamaz.

### 0073 â€” view'lar

`scenario_comparisons` tablosu **Ã§alÄ±ÅŸma baÅŸÄ±na**: (run_id, metric, baseline_value,
scenario_value, delta) â€” "bu tek koÅŸu tabandan nasÄ±l ayrÄ±ldÄ±" sorusunu cevaplÄ±yor. BirkaÃ§ koÅŸuyu
birbiriyle karÅŸÄ±laÅŸtÄ±rmak farklÄ± bir soru ve **tablo eklemeden** view olarak cevaplanÄ±yor, Ã§Ã¼nkÃ¼
ihtiyaÃ§ duyduÄŸu her sayÄ± zaten mevcut.

`optimization_run_summary` onay durumunu `approvals`'tan **JOIN ediyor**, kopyalamÄ±yor. Faz 24A'nÄ±n
varlÄ±ÄŸÄ±na baÄŸlanmanÄ±n bÃ¼tÃ¼n anlamÄ± bu: bir ÅŸeyin onaylÄ± olup olmadÄ±ÄŸÄ±nÄ± bilen tam olarak tek bir
yer var.

### Deterministik Ã§Ã¶zÃ¼cÃ¼ (`src/lib/optimization/rules.ts`)

AÃ§Ä±k, kural tabanlÄ± bir sezgisel Ã§Ã¶zÃ¼cÃ¼. LP/MIP kÃ¼tÃ¼phanesi yok, istatistiksel optimizatÃ¶r yok,
Ã¶ÄŸrenilmiÅŸ aÄŸÄ±rlÄ±k yok, Python yok (Ã‡Ã¶zÃ¼len Karar #2). Her Ã¶neri adlandÄ±rÄ±lmÄ±ÅŸ bir kural tarafÄ±ndan
Ã¼retiliyor, o kuralÄ±n adÄ±nÄ± taÅŸÄ±yor ve girdilerden elle yeniden tÃ¼retilebiliyor.

SÄ±ra sabit: (1) bakiyeleri projekte et ve tabanÄ±n ilk ihlal edildiÄŸi gÃ¼nÃ¼ bul; (2) o gÃ¼nÃ¼n aÃ§Ä±ÄŸÄ±nÄ±
**ertelenebilir** Ã¶demeleri kaydÄ±rarak kapatmayÄ± dene, bÃ¼yÃ¼kten kÃ¼Ã§Ã¼ÄŸe; (3) kalan aÃ§Ä±k iÃ§in en
dÃ¼ÅŸÃ¼k maliyetli limitten Ã§ekim Ã¶ner; (4) hiÃ§ ihlal yoksa ve nakit tabanÄ±n rahatÃ§a Ã¼zerindeyse,
gereksiz yere faiz Ã¶denmesin diye geri Ã¶deme Ã¶ner.

**Sert vadeli Ã¶demeler hiÃ§bir zaman ertelenmeye Ã¶nerilmiyor** ve bu bir girdi, Ã§Ã¶zÃ¼cÃ¼nÃ¼n kararÄ±
deÄŸil. ErtelenemeyeceÄŸi ayrÄ±ca `sert_vade_ertelenemez` koduyla **bildiriliyor** â€” sessizce atlamak,
kalan aÃ§Ä±ÄŸÄ±n neden zamanlama ile kapanamadÄ±ÄŸÄ±nÄ± okunamaz kÄ±lardÄ±.

**KapatÄ±lamayan aÃ§Ä±k raporlanÄ±yor** (`limit_yetersiz`). Sessiz bir kÄ±smi cevap "Ã§Ã¶zÃ¼ldÃ¼" diye
okunurdu.

#### Determinizm bir gereklilik, umut deÄŸil

Ã‡alÄ±ÅŸma bir `result_digest` saklÄ±yor ve gate optimizatÃ¶rÃ¼ yeniden koÅŸup karÅŸÄ±laÅŸtÄ±rÄ±yor. Bu, her
sÄ±ralamanÄ±n **tam sÄ±ra** olmasÄ±nÄ± zorunlu kÄ±lÄ±yor: her karÅŸÄ±laÅŸtÄ±rÄ±cÄ± bir id eÅŸitlik-bozucuyla
bitiyor, bÃ¶ylece iÅŸ anahtarlarÄ±nda eÅŸit iki aday bile sabit ve tekrarlanabilir bir sÄ±ra alÄ±yor.
EÅŸitliÄŸi Ã§Ã¶zmeyen bir karÅŸÄ±laÅŸtÄ±rÄ±cÄ± Ã§Ä±ktÄ±yÄ± girdi sÄ±rasÄ±na baÄŸÄ±mlÄ± kÄ±lardÄ± â€” Faz 23'Ã¼n sÄ±ralama
dersi. Gate hem tekrarlanabilirliÄŸi hem de **girdi sÄ±rasÄ±ndan baÄŸÄ±msÄ±zlÄ±ÄŸÄ±** ayrÄ± ayrÄ± kanÄ±tlÄ±yor.

#### Bir birim testin yakaladÄ±ÄŸÄ± Ã§Ã¶zÃ¼cÃ¼ hatasÄ±

Ä°lk sÃ¼rÃ¼m ertelenen Ã¶demeyi **ihlalden bir gÃ¼n sonrasÄ±na** taÅŸÄ±yordu. Test gÃ¶sterdi ki bu Ã§oÄŸu
zaman hiÃ§bir ÅŸey baÅŸarmÄ±yor: kapatÄ±cÄ± giriÅŸ Ã¼Ã§ gÃ¼n sonraysa bakiye yeni tarihte de tabanÄ±n altÄ±nda
kalÄ±yor ve "dÃ¼zeltme" en kÃ¶tÃ¼ bakiyeyi hiÃ§ deÄŸiÅŸtirmiyor (âˆ’400 â†’ âˆ’400). Hedef artÄ±k Ã¶demenin
**gerÃ§ekten karÅŸÄ±lanabildiÄŸi ilk gÃ¼n**: bu Ã¶deme hariÃ§ hesaplanan bakiyenin, Ã¶demeyi tabanÄ±n
Ã¼zerinde taÅŸÄ±yabildiÄŸi en erken tarih. Ufuk iÃ§inde bÃ¶yle bir gÃ¼n yoksa Ã¶neri **Ã¼retilmiyor** â€”
yalnÄ±zca ilerleme gibi gÃ¶rÃ¼nen bir hamle yapmaktansa hiÃ§bir ÅŸey Ã¶nermemek doÄŸru.

### Baseline korunur invariant'Ä± (Faz 8/13), yeni Ã§alÄ±ÅŸma tipine karÅŸÄ± yeniden kanÄ±tlandÄ±

Plan bu invariant'Ä±n her yeni senaryo tipine karÅŸÄ± yeniden test edilmesini ÅŸart koÅŸuyor.
`phase29:verify` bunu **alt kÃ¼me kontrolÃ¼yle deÄŸil, tam satÄ±r karÅŸÄ±laÅŸtÄ±rmasÄ±yla** yapÄ±yor:

1. bir baseline `scenario_run`'Ä±n **her kolonu**, `scenario_comparisons` satÄ±rlarÄ±, **tÃ¼m**
   `cashflow_months` satÄ±rlarÄ± ve **tÃ¼m** `payment_instances` satÄ±rlarÄ± anlÄ±k gÃ¶rÃ¼ntÃ¼ye alÄ±nÄ±yor;
2. optimizatÃ¶r uÃ§tan uca Ã§alÄ±ÅŸtÄ±rÄ±lÄ±yor (`runOptimization` + `requestOptimizationApproval`);
3. anlÄ±k gÃ¶rÃ¼ntÃ¼ler `JSON.stringify` ile birebir karÅŸÄ±laÅŸtÄ±rÄ±lÄ±yor.

Ä°lk sÃ¼rÃ¼mde `payment_instances` **sÄ±fÄ±r satÄ±rla** karÅŸÄ±laÅŸtÄ±rÄ±lÄ±yordu â€” hiÃ§bir ÅŸey kanÄ±tlamayan
boÅŸ bir kontrol. ArtÄ±k fixture iki gerÃ§ek taksit kuruyor (biri `normal`, biri `critical`
Ã¶ncelikli), yani optimizatÃ¶rÃ¼n gerÃ§ekten mutasyona uÄŸratabileceÄŸi adaylar var ve kontrol boÅŸ kÃ¼me
olduÄŸunda **baÅŸarÄ±sÄ±z oluyor**.

AyrÄ±ca kaynak seviyesinde: motorun mali/senaryo tablolarÄ±na yazan hiÃ§bir ifadesi olmadÄ±ÄŸÄ±
(yorumlar ayÄ±klanarak) ve Ã§Ã¶zÃ¼cÃ¼ kurallarÄ±nÄ±n veritabanÄ±na **hiÃ§ eriÅŸmediÄŸi** â€” yani yapÄ±sal olarak
mutasyon yapamayacaÄŸÄ± â€” kontrol ediliyor.

### `hardDeadline` iki sinyalden okunuyor

`priority` `payments`'ta, `risk_level` `payment_instances`'ta â€” introspection'la doÄŸrulandÄ±, Ã§Ã¼nkÃ¼
ilk sÃ¼rÃ¼m `payment_instances`'ta olmayan bir `priority` kolonunu okuyordu. Ä°kisinden biri
`critical` ise Ã¶deme taÅŸÄ±namaz sayÄ±lÄ±yor. MuhafazakÃ¢r okuma bilinÃ§li: taÅŸÄ±namaz bir ÅŸeyi yanlÄ±ÅŸlÄ±kla
ertelemeyi Ã¶nermek, operatÃ¶rÃ¼n sonraki her Ã¶neriye olan gÃ¼venini gÃ¶tÃ¼rÃ¼r â€” kaÃ§Ä±rÄ±lan bir
optimizasyondan Ã§ok daha pahalÄ±.

---

## Maliyet Merkezi, KÃ¢rlÄ±lÄ±k ve Ä°ÅŸletme Sermayesi (Faz 30, migration 0074-0075)

### 0074 â€” `cost_allocation_rules`: daÄŸÄ±tÄ±m tabanÄ± kod deÄŸil VERÄ°

`approval_rules` (0054) ve `treasury_policies` (0062) emsali: kural bir satÄ±rda durur, view'lar
okur, genel giderin nasÄ±l daÄŸÄ±tÄ±ldÄ±ÄŸÄ±nÄ± deÄŸiÅŸtirmek bir yeniden daÄŸÄ±tÄ±m deÄŸil **denetlenen bir
operatÃ¶r iÅŸlemi**dir. Bir SQL view'Ä±nÄ±n iÃ§ine gÃ¶mÃ¼lÃ¼ daÄŸÄ±tÄ±m tabanÄ±, yalnÄ±z bir geliÅŸtiricinin
deÄŸiÅŸtirebileceÄŸi bir sayÄ±dÄ±r â€” maliyet kararÄ± iÃ§in yanlÄ±ÅŸ sahip.

PlanÄ±n beÅŸ gider tÃ¼rÃ¼ (`common`/`machine`/`personnel`/`energy`/`project`) ve beÅŸ daÄŸÄ±tÄ±m tabanÄ±.
Her taban bu veritabanÄ±nÄ±n **gerÃ§ekten Ã¶lÃ§ebildiÄŸi** bir sÃ¼rÃ¼cÃ¼ye karÅŸÄ±lÄ±k geliyor:
`machine_minutes` â†’ `machine_minute_allocations`, `revenue_share` â†’ faturalar. SÃ¼rÃ¼cÃ¼sÃ¼ olmayan
bir taban, sessizce hiÃ§bir ÅŸey daÄŸÄ±tmayan bir kural olurdu.

**YaÅŸam dÃ¶ngÃ¼sÃ¼ kolonu YOK ve Â§17 kural 3 gerÃ§ekten N/A** â€” `phase30:verify` bunu yorumda iddia
etmek yerine `status`/`state`/`version_status`/`lifecycle`/`approved_at` kolonlarÄ±nÄ±n yokluÄŸunu
sorgulayarak **yapÄ±sal olarak** doÄŸruluyor (Faz 26/28 deseni). Kural aktiftir ya da deÄŸildir;
`is_active` boolean'Ä±nÄ±n transition guard'Ä±n koruyacaÄŸÄ± bir ara durumu yok.

Kapsam CHECK'i iki yÃ¶nlÃ¼ (`fixed_percent` yalnÄ±z ve ancak taban `fixed_percent` ise), pay 0..1
aralÄ±ÄŸÄ±nda, **sÄ±fÄ±r pay geÃ§erli** ("buraya bir ÅŸey daÄŸÄ±tma" â€” 0 ile null farklÄ± ifadeler). AynÄ±
hedef iÃ§in ikinci **aktif** kural `NULLS NOT DISTINCT` kÄ±smi unique indeksle engelleniyor; olsaydÄ±
view hangi tabanÄ± seÃ§eceÄŸini bilemez, planlayÄ±cÄ±nÄ±n dÃ¶ndÃ¼rdÃ¼ÄŸÃ¼ ilk satÄ±rÄ± sessizce kullanÄ±rdÄ±.

Personel ve enerji kurallarÄ± **pasif** geliyor: bunlarÄ± aÃ§mak ekrandaki her marjÄ± deÄŸiÅŸtirir ve bu
operatÃ¶rÃ¼n bilinÃ§li kararÄ± olmalÄ±, migration'Ä±n onun yerine verdiÄŸi bir karar deÄŸil.

**RLS: `config` sÄ±nÄ±fÄ±** â€” her katman okur (taban, bir marjÄ±n neden Ã¶yle gÃ¶rÃ¼ndÃ¼ÄŸÃ¼nÃ¼ aÃ§Ä±klar),
yalnÄ±z **admin** yazar. Bilerek yÃ¶neticiye kapalÄ±: daÄŸÄ±tÄ±mÄ± yeniden tabanlayabilen bir yÃ¶netici,
hiÃ§bir mali kayÄ±t deÄŸiÅŸmeden maliyeti kendi merkezinden baÅŸkasÄ±nÄ±nkine kaydÄ±rabilirdi.

### 0075 â€” kÃ¢rlÄ±lÄ±k ve iÅŸletme sermayesi view'larÄ±

#### KÃ¢rlÄ±lÄ±k deseni kopyalandÄ±, yeniden icat edilmedi

`src/lib/production/rules.ts:partProfitability` bu depoda marjÄ±n nasÄ±l hesaplandÄ±ÄŸÄ±nÄ± zaten
belirlemiÅŸti; view'lar birebir onu izliyor:

- `margin = revenue âˆ’ cost`, ve **iki taraftan biri bilinmiyorsa NULL** (asla 0)
- `margin_rate = margin / revenue`, ve ciro 0 ya da bilinmiyorsa **NULL** (asla 0, asla âˆ)
- eksik girdi bir `confidence` bayraÄŸÄ±yla sÃ¶yleniyor

GerekÃ§e estetik deÄŸil: maliyeti kaydedilmediÄŸi iÃ§in 0 gÃ¶rÃ¼nen bir marj, **gerÃ§ek bir baÅŸabaÅŸtan
ayÄ±rt edilemez** â€” ve bu depo "bilinmeyen bilinmeyen kalÄ±r" kararÄ±nÄ± zaten vermiÅŸti. Birim test
iki hesabÄ±n aynÄ± sayÄ±yÄ± verdiÄŸini `partProfitability`'yi iÃ§e aktararak Ã§iviliyor.

**AÃ§Ä±k sÄ±fÄ±r ciro Ã¶lÃ§Ã¼lmÃ¼ÅŸ sayÄ±lÄ±yor:** para harcayÄ±p hiÃ§ satmamÄ±ÅŸ bir merkezde marj gerÃ§ek bir
negatif sayÄ±dÄ±r, yalnÄ±z yÃ¼zdesi tanÄ±msÄ±zdÄ±r.

#### Tek kaynak â€” Ã§ift sayma yok

Ciro ve maliyetin ikisi de **yalnÄ±z faturalardan** geliyor. AynÄ± para Ã¶demeler ve banka
hareketleri olarak da var; faturayÄ± onu kapatan Ã¶demeyle birlikte toplamak rakamÄ± kabaca iki
katÄ±na Ã§Ä±karÄ±r ve sayÄ± yine makul gÃ¶rÃ¼nÃ¼rdÃ¼. Faz 28 bu tuzaÄŸÄ± bÃ¼tÃ§e gerÃ§ekleÅŸeni iÃ§in kaydetmiÅŸti;
burada aynÄ± kural aynÄ± sebeple geÃ§erli.

#### `profitability_by_party` â€” rol iddia deÄŸil gÃ¶zlem

MÃ¼ÅŸteri ve tedarikÃ§i iÃ§in iki ayrÄ± view yerine tek view: aynÄ± cari Ã§oÄŸu zaman ikisidir ve ayrÄ±
raporlamak net iliÅŸkiyi gÃ¶rÃ¼nmez kÄ±lardÄ±. `observed_role` verinin **gÃ¶sterdiÄŸi** rolÃ¼ sÃ¶ylÃ¼yor
(`customer`/`supplier`/`both`/`no_activity`), `party_type` kolonunun iddia ettiÄŸini deÄŸil.

#### Departman: Ã¶lÃ§Ã¼lemiyor, ve nedeni satÄ±rla birlikte geziyor

**Ã–lÃ§Ã¼ldÃ¼, varsayÄ±lmadÄ±:** bu ÅŸemada hiÃ§bir iÅŸlem tablosu `department_id` taÅŸÄ±mÄ±yor (Faz 28 aynÄ±
bulguyu bÃ¼tÃ§e gerÃ§ekleÅŸeni iÃ§in kaydetmiÅŸti). View her departmanÄ± NULL rakamlar ve
`unmeasurable_reason = 'no_transaction_link'` ile listeliyor; tahsis kuralÄ± **icat etmiyor**.
Uydurmak, "bu parayÄ± hangi departman kazandÄ±" sorusunu kimsenin savunamayacaÄŸÄ± bir sayÄ±yla
cevaplamak olurdu. Ekran nedeni yazÄ±yor, bÃ¶ylece boÅŸluk "kÃ¢r sÄ±fÄ±r" diye okunmuyor.

#### Makine kÃ¢rlÄ±lÄ±ÄŸÄ±: doÄŸru tabloya baÄŸlandÄ±

Ä°lk taslak `machine_minute_allocations`'Ä± join ediyordu; introspection o tablonun
`(capacity_model_id, operation_type)` ile anahtarlandÄ±ÄŸÄ±nÄ± ve **hiÃ§ makine taÅŸÄ±madÄ±ÄŸÄ±nÄ±** gÃ¶sterdi
â€” o tablo **kapasite kullanÄ±mÄ±nÄ±** Ã¶lÃ§Ã¼yor, farklÄ± bir eksen. Kullanmak, atÃ¶lye geneli dakikalarÄ±
tek tek makinelere atfetmek olurdu. View artÄ±k zaten makine baÅŸÄ±na ciro/maliyet ve kendi
`confidence` kolonunu taÅŸÄ±yan `machine_roi_snapshots` Ã¼zerine kurulu â€” bu fazÄ±n ÅŸablon almasÄ±
sÃ¶ylenen kÃ¢rlÄ±lÄ±k emsalinin ta kendisi.

### Ä°ÅŸletme sermayesi: DSO/DPO hesaplanÄ±yor, DIO ve CCC **dÃ¼rÃ¼stÃ§e** hesaplanmÄ±yor

Faz 22 `dso_dpo_components`'Ä± bilerek **oransÄ±z** bÄ±rakmÄ±ÅŸtÄ± ("view bileÅŸenleri verir, oranÄ±
DEÄÄ°L"); bÃ¶lme iÅŸte bu fazda yapÄ±lÄ±yor â€” 365 gÃ¼n Ã¼zerinden ve cevabÄ± dÃ¼rÃ¼st kÄ±lan korumalarla:

- **sÄ±fÄ±r ya da NULL payda â†’ NULL**, 0 deÄŸil ve sonsuz deÄŸil. DSO 0, "mÃ¼ÅŸteriler anÄ±nda Ã¶dÃ¼yor"
  diye okunur; gerÃ§ek ise "satÄ±ÅŸ geÃ§miÅŸimiz yok".
- **DIO HER ZAMAN NULL** ve bu Ã¶lÃ§Ã¼lmÃ¼ÅŸ bir olgu: ÅŸemada envanter **yok** â€” stok tablosu yok,
  eldeki-miktar kolonu yok, tutulan malÄ± kaydeden hiÃ§bir ÅŸey yok.
- **CCC de NULL**, Ã§Ã¼nkÃ¼ `DSO + DIO âˆ’ DPO` Ã¼Ã§ terimden ikisiyle hesaplanamaz.

Cazip kÄ±sayol DIO'yu 0 saymaktÄ±. Bu, dÃ¶ngÃ¼yÃ¼ bu iÅŸletmenin malzeme tuttuÄŸu gÃ¼n sayÄ±sÄ± kadar
**kÄ±saltÄ±r** â€” yani iÅŸletme sermayesini olduÄŸundan **Ä°YÄ°** gÃ¶sterir, ki bu metrik iÃ§in yanlÄ±ÅŸ
olmanÄ±n en tehlikeli yÃ¶nÃ¼ budur. Onun yerine `cash_cycle_excluding_inventory` ayrÄ±ca veriliyor ve
**tam olarak neyi dÄ±ÅŸladÄ±ÄŸÄ±yla adlandÄ±rÄ±lÄ±yor**, bÃ¶ylece hesaplanabilir kÄ±sÄ±m hiÃ§bir ÅŸey CCC
taklidi yapmadan kullanÄ±labiliyor.

`working_capital_trend` her ay iÃ§in kendi 365 gÃ¼nlÃ¼k kayan paydasÄ±nÄ± kullanÄ±yor â€” noktasal
`dso_dpo_components` "bugÃ¼nÃ¼" cevaplÄ±yor, trend ise her ayÄ±n kendi pozisyonunu gerektiriyor.

### DaÄŸÄ±tÄ±mda kaybolan kuruÅŸ (`allocate`)

100,00'Ã¼ Ã¼Ã§e bÃ¶lmek 33,33 veriyor ve 33,33 Ã— 3 = 99,99. Bir kuruÅŸun bir yere gitmesi gerekiyor,
yoksa daÄŸÄ±tÄ±m sessizce para kaybeder â€” bir yÄ±llÄ±k aylÄ±k genel gider koÅŸusunda bu, her maliyet
merkezinde aÃ§Ä±klanamayan gerÃ§ek bir sapmadÄ±r. ArtÄ±k kalan **en bÃ¼yÃ¼k paya** veriliyor (eÅŸitlikler
id ile Ã§Ã¶zÃ¼lÃ¼yor, yani seÃ§im tekrarlanabilir) ve `allocate` parÃ§alarÄ±n girdiye **tam olarak**
eÅŸit toplandÄ±ÄŸÄ±nÄ± garanti ediyor. Birim test bunu 100 / 0,01 / 1 / 999,99 / 1234,56 tutarlarÄ±nÄ±
3, 6, 7 ve 11 hedefe bÃ¶lerek doÄŸruluyor.

SÄ±fÄ±r ya da negatif toplam sÃ¼rÃ¼cÃ¼de daÄŸÄ±tÄ±m **boÅŸ** dÃ¶nÃ¼yor â€” NaN Ã¼retmek yerine "hiÃ§bir ÅŸey
daÄŸÄ±tÄ±lamadÄ±" bilgisi veriliyor.

---

## Finansal Kontrol Merkezi ve Anomali Tespiti (Faz 31, migration 0076-0078)

Bu bir **sentez** fazÄ±, ve en Ã¶nemli disiplin zaten tutan bir invariant'Ä± ikinci kez zorlamamak.
Her kontrol yazÄ±lmadan Ã–NCE ilgili mevcut mekanizma okundu ve sÄ±nÄ±flandÄ±rÄ±ldÄ±; sÄ±nÄ±flandÄ±rma
`control_registry.enforcement` kolonunda **veri olarak** duruyor, yorumda iddia olarak deÄŸil.

### Kontrol envanteri â€” hangisi zaten var, hangisi gerÃ§ekten yeni

| Kontrol | SÄ±nÄ±f | GerekÃ§e |
|---|---|---|
| `allocation_over_invoice` | **zaten zorlanÄ±yor** | Faz 22'nin `allocations_enforce_invoice_ceiling()` trigger'Ä± engelliyor. Ä°kinci bir CHECK, ilkiyle Ã§eliÅŸebilecek bir yetki olurdu. |
| `near_duplicate_bank_txn` | **zaten zorlanÄ±yor** | `bank_transactions_dedupe_uq` **UNIQUE** (doÄŸrulandÄ±). Birebir kopya imkÃ¢nsÄ±z; bu yÃ¼zden kontrol hash'in gÃ¶remediÄŸi **yakÄ±n** kopyalarÄ± arÄ±yor. |
| `iban_changed` | **zaten zorlanÄ±yor** | Faz 19'un `iban_change_events`'i her deÄŸiÅŸimi salt-ekleme kaydediyor. Yeniden icat edilmedi. |
| `unknown_counterparty` | **zaten zorlanÄ±yor** | Faz 19 kararÄ±: uygulama eÅŸleme sÄ±rasÄ±nda sessizce `parties` satÄ±rÄ± YARATMIYOR; ham `counterparty_label` kasÄ±tlÄ±. |
| `duplicate_invoice` | **gerÃ§ekten yeni** | `invoices_dedupe_idx` **unique DEÄÄ°L** (doÄŸrulandÄ±) â€” banka tarafÄ±nÄ±n aksine. Bunu yalnÄ±z bu kontrol yakalÄ±yor. |
| `payment_without_invoice` | **gerÃ§ekten yeni** | HiÃ§bir mekanizma engellemiyor. |
| `approval_bypass` | **gerÃ§ekten yeni** | Faz 24A onay varlÄ±ÄŸÄ±nÄ± kurdu; eÅŸiÄŸi aÅŸan kaydÄ±n onayÄ± olup olmadÄ±ÄŸÄ±nÄ± kimse kontrol etmiyordu. |
| `closed_period_mutation` | **gerÃ§ekten yeni** | Ã‡Ä±pa var, kontrol yoktu (aÅŸaÄŸÄ±ya bakÄ±n). |
| `missing_source_document` | **gerÃ§ekten yeni** | Kaynak soyaÄŸacÄ± Faz 2'den beri var; eksikliÄŸi bulgu olarak raporlanmÄ±yordu. |
| `unmatched_bank_txn_aged` | **gerÃ§ekten yeni** | `status='unmatched'` bir veri durumu; **yaÅŸlanmasÄ±** bir bulgu. |
| `large_payment` | **gerÃ§ekten yeni** | EÅŸik `settings.critical_payment_threshold_try`'den okunuyor â€” ikinci bir sayÄ± icat edilmedi. |

`phase31:verify` "zaten zorlanÄ±yor" iddialarÄ±nÄ±n her birini **mekanizmayÄ± Ã§alÄ±ÅŸtÄ±rarak kanÄ±tlÄ±yor**:
banka indeksinin gerÃ§ekten unique olduÄŸu, fatura indeksinin gerÃ§ekten olmadÄ±ÄŸÄ±, Faz 22 trigger'Ä±nÄ±n
fatura Ã¼stÃ¼ daÄŸÄ±tÄ±mÄ± hÃ¢lÃ¢ reddettiÄŸi. SÄ±nÄ±flandÄ±rma iddia deÄŸil, test.

### PlanÄ±n bir atfÄ± dÃ¼zeltildi

Plan kapalÄ±-dÃ¶nem kontrolÃ¼nÃ¼n "Faz 24B'nin dÃ¶nem-kilidini gerektirdiÄŸini" sÃ¶ylÃ¼yor. Faz 24B
aslÄ±nda rol-tabanlÄ± RLS teslim etti; **dÃ¶nem kilidi kavramÄ± ondan Ã¶nce zaten vardÄ±**:
`cashflow_months.status` erken fazlardan beri `'locked'` deÄŸerini taÅŸÄ±yor. Kontrol o Ã§Ä±paya
baÄŸlandÄ±. KontrolÃ¼n dayanaÄŸÄ± olduÄŸu iÃ§in kaydedildi.

### 0076 â€” `control_alerts` ve `alert_escalation_rules`

Bu fazÄ±n **tek yeni durumu**. Bir bulgunun onaylanacak bir yere ihtiyacÄ± var ve mevcut tablolarÄ±n
hiÃ§biri bunu taÅŸÄ±mÄ±yor.

YaÅŸam dÃ¶ngÃ¼sÃ¼ beÅŸ durumlu, yirmi sÄ±ralÄ± Ã§iftin **on biri** izinli. Ä°kisi ayrÄ±ca yazÄ±lmayÄ± hak
ediyor:

- **`snoozed â†’ open`** â€” erteleme **sÃ¼resi dolar**. Bu geÃ§iÅŸ olmasaydÄ± ertelenen her uyarÄ± kalÄ±cÄ±
  susturulurdu; kimsenin gÃ¼venmediÄŸi bir alarm sisteminin tam olarak arÄ±za biÃ§imi budur.
- **`resolved`/`false_positive` terminal** â€” kapatÄ±lmÄ±ÅŸ bir bulguyu yeniden aÃ§mak, var olma
  sebebi olan kontrol geÃ§miÅŸini yeniden yazmak olurdu. Tekrar ederse **yeni bir uyarÄ±** aÃ§Ä±lÄ±r,
  ki kÄ±smi unique indeks de tam olarak buna izin veriyor.

**`false_positive` `resolved`'Ä±n bir Ã§eÅŸidi deÄŸil, birinci sÄ±nÄ±f bir sonuÃ§.** AyrÄ± tutulmasÄ±,
kural baÅŸÄ±na yanlÄ±ÅŸ-alarm oranÄ±nÄ± hesaplanabilir kÄ±lan ÅŸey â€” planÄ±n istediÄŸi geri bildirim
sinyali. Hangi kontrolÃ¼n kurt masalÄ± anlattÄ±ÄŸÄ±nÄ± ancak bÃ¶yle gÃ¶rebilirsiniz.

KÄ±sÄ±tlar tÃ¼ketici biÃ§imde yazÄ±ldÄ± (Faz 28 deseni): her durum hangi damgalarÄ± taÅŸÄ±yabileceÄŸini tek
tek sÃ¶ylÃ¼yor. `control_alerts_has_rules` **`coalesce(array_length(...), 0) >= 1`** kullanÄ±yor â€”
Faz 29'un zor yoldan Ã¶ÄŸrendiÄŸi ders baÅŸtan uygulandÄ±: boÅŸ dizide `array_length()` NULL dÃ¶ner ve
NULL'a dÃ¼ÅŸen CHECK **geÃ§er**.

Kapatma **gerekÃ§e zorunlu** kÄ±lÄ±yor: "kimse tarafÄ±ndan, sebepsiz Ã§Ã¶zÃ¼ldÃ¼" bir kontrolÃ¼n sessizce
kapatÄ±lma biÃ§imidir.

KÄ±smi unique indeks canlÄ± uyarÄ±larÄ± kapsÄ±yor, yani **tekrar koÅŸu liste ÅŸiÅŸirmiyor** â€”
`occurrence_count` artÄ±yor. Her Ã§alÄ±ÅŸtÄ±rmada bÃ¼yÃ¼yen bir uyarÄ± listesi, kimsenin okumadÄ±ÄŸÄ± listedir.

`alert_escalation_rules` yapÄ±landÄ±rma; yaÅŸam dÃ¶ngÃ¼sÃ¼ kolonu yok ve Â§17 kural 3'Ã¼n N/A olduÄŸu
**yapÄ±sal olarak** doÄŸrulanÄ±yor. Ä°ki kural tohumlanÄ±yor ve **ikisi de aktif** â€” pasif gelen bir
eskalasyon kuralÄ±, hiÃ§ yÃ¼kseltmeyen bir alarm demek olurdu.

### 0078 â€” kontroller ve anomali dedektÃ¶rleri

**Kontrol kaydÄ± (`control_registry`)** her denetimi listeliyor, bulgu bulmasa bile. Temizken
kaybolan bir kontrol, bozulduÄŸu fark edilmeyen kontroldÃ¼r. `control_dashboard` bunun Ã¼zerine
PASS/WARNING/CRITICAL veriyor.

Anomali dedektÃ¶rleri **deterministik**: adlandÄ±rÄ±lmÄ±ÅŸ eÅŸikler, sabit aÄŸÄ±rlÄ±klar, Ã¶ÄŸrenilmiÅŸ hiÃ§bir
ÅŸey yok. Ã–ne Ã§Ä±kan iki tanesi:

- **BÃ¶lÃ¼nmÃ¼ÅŸ Ã¶deme** â€” aynÄ± karÅŸÄ± tarafa aynÄ± gÃ¼n, her biri onay eÅŸiÄŸinin **altÄ±nda** ama toplamÄ±
  **Ã¼stÃ¼nde**. Onay kapÄ±sÄ±nÄ±n etrafÄ±ndan dolaÅŸmanÄ±n klasik yolu, ve Faz 24A'nÄ±n eÅŸiÄŸini okuyarak
  tespit ediliyor.
- **GeÃ§miÅŸ ortalamaya gÃ¶re tutar** â€” taban, karÅŸÄ± tarafÄ±n **kendi** ortalamasÄ±, yani bÃ¼yÃ¼k bir
  tedarikÃ§i bÃ¼yÃ¼k olduÄŸu iÃ§in iÅŸaretlenmiyor. **DÃ¶rt gÃ¶zlemin altÄ±ndaki geÃ§miÅŸ taban sayÄ±lmÄ±yor**:
  ince geÃ§miÅŸten sinyal deÄŸil gÃ¼rÃ¼ltÃ¼ Ã¼retirdi.

**OlaÄŸandÄ±ÅŸÄ± saat kontrolÃ¼ dÃ¼rÃ¼stÃ§e adlandÄ±rÄ±ldÄ±.** Ã–lÃ§Ã¼ldÃ¼: `bank_transactions`'ta **iÅŸlem saati
yok** â€” yalnÄ±z `txn_date` (tarih). DolayÄ±sÄ±yla "gece 3'te yapÄ±lan Ã¶deme" tespit **edilemiyor**;
tespit edilen, **gece 3'te kaydedilen** satÄ±r. Bu da gerÃ§ek bir sinyal ama farklÄ± bir sinyal, ve
view'Ä±n kolon adÄ± ile `caveat` alanÄ± bunu sÃ¶ylÃ¼yor. Ä°ÅŸlem saati demek, verinin desteklemediÄŸi bir
iddiada bulunmak olurdu.

### Ä°nceleme iÅŸ akÄ±ÅŸÄ± â€” ikinci gÃ¶rev modeli yok

Takip gÃ¶revi bir `action_item` (Faz 14 modeli, Faz 25'in tahsilat iÃ§in yaptÄ±ÄŸÄ± gibi). 0077 tek bir
`source_type` deÄŸeri ekliyor (`'control'`), birkaÃ§ tane deÄŸil: bulgu tÃ¼rÃ¼nÃ¼ zaten
`control_alerts.check_code`, neyle ilgili olduÄŸunu zaten `related_entity_*` sÃ¶ylÃ¼yor.

### Motor neyi yazar, neyi yazmayÄ± reddeder

`control_alerts`, `action_items` ve `audit_logs` yazar. **HiÃ§bir mali kayda yazmaz**: bulduÄŸunu
"dÃ¼zeltebilen" bir kontrol, otomasyonun tutar ve vade deÄŸiÅŸtirmesi olurdu â€” CLAUDE.md'nin
doÄŸrudan yasakladÄ±ÄŸÄ± ÅŸey. Bulgu bir insanÄ±n Ã¶nÃ¼ne konur; kararÄ± insan verir. Gate bunu kaynak
seviyesinde (yorumlar ayÄ±klanarak) kontrol ediyor.

### LLM kontrol zincirinin tamamen dÄ±ÅŸÄ±nda

`src/lib/controls/*` `@/lib/ai`'yi import etmiyor ve gate bunu negatif kontrolle kanÄ±tlÄ±yor.
GerekÃ§e politika deÄŸil pratik: bir kontrol bulgusunun, aynÄ± kurallarÄ± aynÄ± satÄ±rlara uygulayan
ikinci bir kiÅŸi tarafÄ±ndan **yeniden Ã¼retilebilmesi** gerekir. Bir dil modelinden Ã§Ä±kmÄ±ÅŸ ciddiyet
derecesi denetÃ§iye savunulamaz ve "model tuhaf buldu" bir kontrol deÄŸildir.

### `db:constraints:verify` geniÅŸletildi (deÄŸiÅŸtirilmedi)

PlanÄ±n ÅŸartÄ± gereÄŸi her yeni CHECK kendi girdisini aldÄ±: `runFaz31ConstraintAssertions()` eklendi,
mevcut `runFaz19`/`runFaz22` fonksiyonlarÄ±na dokunulmadÄ±. Script 65 â†’ **75** teste Ã§Ä±ktÄ±.

## CFO Brifingi, YÃ¶netim Kokpiti ve Finansal Takvim (Faz 32, migration 0079-0080)

Bu faz **iki migration** ekliyor ve **hiÃ§ yeni tablo** aÃ§mÄ±yor. Sebebi aÅŸaÄŸÄ±da; kÄ±saca: bu fazÄ±n
iÅŸi yeni bir gerÃ§eklik Ã¼retmek deÄŸil, var olan gerÃ§ekliÄŸi **tek ekranda** ve **tek dille**
gÃ¶stermek.

### 0079 â€” `reports.report_type` bir deÄŸer geniÅŸliyor

`reports` tablosuna `'cfo_briefing'` eklendi. Paralel bir `briefings` tablosu **aÃ§Ä±lmadÄ±**:
brifing, `body_md`'si, dÃ¶nemi, geÃ§miÅŸi ve denetim izi olan bir rapordur â€” `reports` tam olarak
bunu modelliyor. Ä°kinci bir tablo, aynÄ± ÅŸeyin iki ayrÄ± yaÅŸam dÃ¶ngÃ¼sÃ¼, iki ayrÄ± RLS sÄ±nÄ±fÄ± ve iki
ayrÄ± arÅŸivleme kuralÄ± demek olurdu.

> Sonraki fazlar iÃ§in not: bu kÃ¼menin **boyutunu** sabitleyen bir gate, bir sonraki geniÅŸlemede
> kÄ±rÄ±lÄ±r (Faz 31'in `action_items.source_type` dersi). Faz 32'nin gate'i bu yÃ¼zden **Ã¼st-kÃ¼me**
> iddiasÄ± kuruyor: `'cfo_briefing'` var **ve** eski beÅŸ deÄŸer duruyor.

### 0080 â€” `financial_calendar` + `financial_calendar_daily` (VIEW)

#### PlanÄ±n aÃ§Ä±k bÄ±raktÄ±ÄŸÄ± soru, kapatÄ±ldÄ±: yeni tekrar-eden-yÃ¼kÃ¼mlÃ¼lÃ¼k tablosu YOK

implementation.md Â§3, maaÅŸ/SGK/vergi/kira/sigorta/CapEx tarihlerinin **yeni hafif bir
tekrar-eden-yÃ¼kÃ¼mlÃ¼lÃ¼k kaydÄ±** mÄ± gerektirdiÄŸini, yoksa mevcut payments modÃ¼lÃ¼ne mi oturduÄŸunu bu
faz baÅŸlarken netleÅŸtirmemizi istiyordu. Karar: **mevcut modÃ¼l**.

Karar iddiaya deÄŸil Ã¶lÃ§Ã¼me dayanÄ±yor â€” `public.payments` zaten ÅŸunlarÄ± taÅŸÄ±yor:

| Kolon | Ne modelliyor |
| --- | --- |
| `recurrence_type` | `one_off / monthly / weekly / yearly / irregular` |
| `due_day` | ayÄ±n kaÃ§Ä±nda (monthly ise CHECK ile zorunlu) |
| `category_id` | maaÅŸ / SGK / vergi / kira / sigorta ayrÄ±mÄ± |
| `provider_party_id` | kime Ã¶dendiÄŸi |

ve `payment_instances` her tekrarÄ± zaten **maddeleÅŸtiriyor**. AylÄ±k bordro, SGK primi, Ã¼Ã§ aylÄ±k
vergi ve kira tam olarak bu ÅŸekil: kategorili, tekrar eden Ã¶deme. Ä°kinci bir tablo, `payments`'Ä±n
var olma sebebi olan tek ÅŸey iÃ§in **rakip bir doÄŸruluk kaynaÄŸÄ±** kurardÄ±; her ekran "hangisine
inanayÄ±m" diye sormak, birileri de aradaki mutabakatÄ± sÃ¼rdÃ¼rmek zorunda kalÄ±rdÄ±.

Gate bu kararÄ± iki yÃ¶nden kilitliyor: adÄ±nda `recurring`/`obligation` geÃ§en yeni tablo
**olmadÄ±ÄŸÄ±nÄ±** ve `payments.recurrence_type` CHECK'inin tekrar modelini **gerÃ§ekten** taÅŸÄ±dÄ±ÄŸÄ±nÄ±
doÄŸruluyor.

#### View ne topluyor

AltÄ± kaynak, tek tarih ekseninde: `payment_instances`, `loan_installments`, `checks`, `invoices`,
`promise_to_pay`, `credit_facilities` (vade).

**Ä°ÅŸaret tek kolonda.** `amount_signed` negatifse para Ã§Ä±kÄ±yor. YÃ¶n ayrÄ± bir kolonda dursaydÄ±, bir
tÃ¼keticinin onu unutup toplamasÄ± an meselesiydi. `checks` zaten iÅŸaretli tutar taÅŸÄ±dÄ±ÄŸÄ± iÃ§in (0009)
iÅŸareti yeniden hesaplanmÄ±yor, **alÄ±nÄ±yor**.

**Kesinlik ayrÄ± bir eksen.** `contracted` (imzalÄ± yÃ¼kÃ¼mlÃ¼lÃ¼k) / `expected` (Ã¶deme sÃ¶zÃ¼) /
`renewal` (limit vadesi). Faz 25'in Ã¶deme sÃ¶zÃ¼ `expected` sayÄ±lÄ±yor: sÃ¶z verilmiÅŸ bir tahsilat,
imzalÄ± bir taksitle **aynÄ± aÄŸÄ±rlÄ±kta** takvime girerse, taahhÃ¼t edilmiÅŸ olanÄ± olduÄŸundan gÃ¼Ã§lÃ¼
gÃ¶sterir.

**Limit vadesi bir tarihtir, nakit hareketi deÄŸildir.** `credit_facilities.expiry_date` satÄ±rÄ±nÄ±n
`amount_signed`'Ä± `0` deÄŸil **NULL**. SÄ±fÄ±r olsaydÄ± gÃ¼nÃ¼n netine sessizce karÄ±ÅŸÄ±rdÄ±; NULL olduÄŸu
iÃ§in toplanamaz. Vadesi gelen limitte olan ÅŸey, Ã§ekilen bakiyenin muaccel olmasÄ± ve kullanÄ±lmayan
baÅŸlÄ±ÄŸÄ±n **var olmayÄ± bÄ±rakmasÄ±** â€” ikisi de o gÃ¼nkÃ¼ Ã§Ä±kÄ±ÅŸ deÄŸil. Faz 27'nin vade merdiveninin
yaptÄ±ÄŸÄ± ayrÄ±mÄ±n aynÄ±sÄ±.

**TutarÄ± bilinmeyen satÄ±r dÄ±ÅŸarÄ±da.** TutarsÄ±z bir Ã¶deme sÃ¶zÃ¼ takvime `0` olarak girmiyor;
girmiyor. Bilinmeyen bir rakam bir toplama eklenemez ve `0,00` yazmak hiÃ§bir ÅŸeyi eksik
gÃ¶stermezken **kesinliÄŸi** olduÄŸundan yÃ¼ksek gÃ¶sterirdi.

`financial_calendar_daily` bunu gÃ¼ne indirger ve `net_contracted` ile `net_expected`'Ä± **ayrÄ±
kolonlarda** verir â€” iyimser rakam sessizce manÅŸet olamasÄ±n diye.

### Neden VIEW, neden tablo deÄŸil

Her iki read-model de VIEW. Faz 22-31 boyunca uygulanan kural: tÃ¼retilmiÅŸ rakam saklanmaz, Ã§Ã¼nkÃ¼
saklandÄ±ÄŸÄ± anda kaynaÄŸÄ±yla ayrÄ±ÅŸabilen ikinci bir doÄŸruluk kaynaÄŸÄ± olur. Bu faz Ã¶zellikle
"Ã¶zet ile detay **sapamaz**" ÅŸartÄ± taÅŸÄ±dÄ±ÄŸÄ± iÃ§in, kuralÄ±n gevÅŸetilmesi en son burada dÃ¼ÅŸÃ¼nÃ¼lebilirdi.

## Arka Plan Ä°ÅŸleri ve Ã–lÃ§Ã¼lmÃ¼ÅŸ Performans (Faz 33, migration 0081-0082)

Bu faz yeni bir iÅŸ alanÄ± (domain) eklemiyor â€” altyapÄ± iÅŸi. Ä°ki migration: biri kuyruk, biri
**Ã¶lÃ§Ã¼mle gerekÃ§elendirilmiÅŸ** optimizasyon.

### 0081 â€” `background_jobs`: TEK kuyruk, dÃ¶rt teslimat

Plan dÃ¶rt ÅŸey sayÄ±yor: bÃ¼yÃ¼k Excel/CSV importlarÄ± iÃ§in kuyruk, rapor-Ã¼retim kuyruÄŸu,
bÃ¼yÃ¼k-export kuyruÄŸu, import-progress takibi. Bunlar **tek mekanizma**. Bir iÅŸ, "istekten uzun
sÃ¼ren, baÅŸarÄ±sÄ±z olabilen, sÄ±nÄ±rlÄ± sayÄ±da yeniden denenmesi gereken ve ilerleme bildiren iÅŸ"tir;
bu tanÄ±m yÃ¼k banka ekstresi yerine PDF export olduÄŸunda deÄŸiÅŸmiyor.

DÃ¶rt tablo demek, dÃ¶rt durum sÃ¶zlÃ¼ÄŸÃ¼, birbirinden sÃ¼rÃ¼klenen dÃ¶rt retry politikasÄ±, dÃ¶rt RLS
sÄ±nÄ±flandÄ±rmasÄ± ve bir ÅŸey takÄ±ldÄ±ÄŸÄ±nda bakÄ±lacak dÃ¶rt yer demekti. `job_type` bir kolondur.

| Alan | Neden var |
| --- | --- |
| `status` | queued/running/succeeded/failed/dead_letter/cancelled â€” CHECK + geÃ§iÅŸ koruyucusu |
| `attempts` / `max_attempts` | retry politikasÄ± satÄ±rÄ±n kendisinde, iÅŸÃ§inin aklÄ±nda deÄŸil |
| `next_run_at` | geri Ã§ekilme (backoff) â€” bekleyen iÅŸ "henÃ¼z uygun deÄŸil"dir, herkes sebebini gÃ¶rÃ¼r |
| `progress_done` / `progress_total` | import ilerlemesi |
| `dead_lettered_at` / `dead_letter_reason` | Ã¶lÃ¼ mektup, ayrÄ± tablo deÄŸil ayrÄ± **durum** |
| `dedupe_key` | kÄ±smi unique: yalnÄ±z CANLI iÅŸler arasÄ±nda |

**Ã–lÃ¼ mektup neden ayrÄ± tablo deÄŸil.** Ã–lÃ¼ mektuba dÃ¼ÅŸen iÅŸ, geÃ§miÅŸi yerinde duran **aynÄ±
satÄ±rdÄ±r**: harcadÄ±ÄŸÄ± denemeler, onu Ã¶ldÃ¼ren hata, sebep olan payload. AyrÄ± tabloya taÅŸÄ±mak ya bu
geÃ§miÅŸi kopyalardÄ± (iki kaynak) ya da kaybederdi. `dead_letter` durumundan tek Ã§Ä±kÄ±ÅŸ var ve
koruyucu buna izin veriyor: **elle tekrar oynatma**.

**KÄ±smi unique, dÃ¼z unique deÄŸil.** `dedupe_key` yalnÄ±z `queued/running/failed` satÄ±rlarÄ± arasÄ±nda
tekil. DÃ¼z bir unique olsaydÄ± her aylÄ±k import, geÃ§en ayÄ±nki baÅŸarÄ±lÄ± olduÄŸu iÃ§in baÅŸarÄ±sÄ±z
olurdu.

**NULL yine sÄ±fÄ±r deÄŸil.** `progress_total` NULL olabilir: sayfalarÄ± henÃ¼z aÃ§Ä±lmamÄ±ÅŸ bir Excel
dosyasÄ±nÄ±n toplamÄ± **bilinmiyordur**, ve 0 yazmak ekranda "0/0 â€” tamamlandÄ±" diye okunur.
`progress_done` ise 0 varsayÄ±lan, Ã§Ã¼nkÃ¼ "henÃ¼z satÄ±r iÅŸlenmedi" gerÃ§ek bir sÄ±fÄ±rdÄ±r.

**GeÃ§iÅŸ koruyucusu, CHECK ile AYNI migration'da** (0027 dersi). Ä°zinli dokuz hamle ve reddedilen
ikisi:

- `succeeded â†’ herhangi bir ÅŸey` **REDDEDÄ°LÄ°R** â€” tamamlanmÄ±ÅŸ bir iÅŸ geri alÄ±namaz. OlmasaydÄ± bir
  retry dÃ¶ngÃ¼sÃ¼ bitmiÅŸ bir importu yeniden Ã§alÄ±ÅŸtÄ±rÄ±p yazdÄ±ÄŸÄ± her satÄ±rÄ± ikiye katlardÄ±.
- `cancelled â†’ herhangi bir ÅŸey` **REDDEDÄ°LÄ°R** â€” birinin bilerek geri Ã§ektiÄŸi iÅŸ iÃ§in aynÄ±sÄ±.

TS tarafÄ±ndaki `ALLOWED_TRANSITIONS` listesi aynÄ± kÃ¼meyi tarif ediyor ve **gate ikisini
karÅŸÄ±laÅŸtÄ±rÄ±yor** (Faz 29'un Zod/DB sÃ¼rÃ¼klenme dersi): SQL'e hamle eklenip TS'e eklenmezse gate
dÃ¼ÅŸer, Ã¼retimde deÄŸil.

`background_job_queue_health` bir VIEW â€” tÃ¼retilmiÅŸ sayÄ± saklanmaz.

**Wave 0 / S5 â€” iÅŸ sonucu `payload.result`'ta (geÃ§ici, migration'sÄ±z).** Asenkron Import V2
Ã¶nizlemesi (`excel_import`) raporunu iÅŸi kuyruÄŸa alan kiÅŸiye geri vermek zorunda ve tabloda bunun
iÃ§in kolon yok. DoÄŸru yer ayrÄ± bir `result jsonb` kolonu; Wave 0'da tek yeni migration'a izin var ve
o baÅŸka bir dilimin. Bu yÃ¼zden `completeJob(â€¦, result)` sonucu durum deÄŸiÅŸikliÄŸiyle AYNI `UPDATE`'te
`payload || jsonb_build_object('result', â€¦)` olarak yazar (iÅŸ sonuÃ§suz 'succeeded' olmaz); denetim
satÄ±rÄ± yalnÄ±z `resultStored: true` der, raporu kopyalamaz; `listJobs()` anahtarÄ± `payload - 'result'`
ile dÄ±ÅŸarÄ±da bÄ±rakÄ±r. `excel_import` yÃ¼kÃ¼ yalnÄ±z `{filename, fileSha256, stagedFile}` taÅŸÄ±r: rol ve
aktÃ¶r yÃ¼kten OKUNMAZ (aktÃ¶r `created_by`, rol `public.users`'tan iÅŸlenirken yeniden okunur), dosya
yolu yÃ¼kte yoktur (`stagedFile` bir uuid; yol sahneleme klasÃ¶rÃ¼nde kurulur). AÃ§Ä±k iÅŸ: `result`
kolonu + `payload`/`created_by`/`job_type` iÃ§in deÄŸiÅŸmezlik tetikleyicisi (operatÃ¶r katmanÄ±
`background_jobs_update_enter` ile her satÄ±rÄ± gÃ¼ncelleyebiliyor).

### 0082 â€” Ã¶lÃ§Ã¼lmÃ¼ÅŸ optimizasyon

**Ã–nce Ã¶lÃ§Ã¼ldÃ¼, sonra yazÄ±ldÄ±.** 77 read model gerÃ§ekÃ§i hacimde (24.000 fatura, 60.000 banka
hareketi, 12.500 taksit, 6.000 Ã§ek) Ã¼Ã§er kez Ã§alÄ±ÅŸtÄ±rÄ±lÄ±p medyanla sÄ±ralandÄ±. SÄ±ralama, dosyalarÄ±
okuyup tahmin edilecek ÅŸeyle uyuÅŸmadÄ±:

```
5.995 ms      37 satÄ±r   working_capital_trend      <- 77 view'Ä±n TOPLAMININ %55'i
  708 ms  60.000 satÄ±r   anomaly_unusual_record_hour
  650 ms  60.000 satÄ±r   bank_unmatched_queue
  477 ms       0 satÄ±r   invoice_duplicate_suspects
  291 ms      11 satÄ±r   control_dashboard
```

60.000 satÄ±rlÄ±klarÄ±n maliyeti 60.000 satÄ±rÄ± taÅŸÄ±mak; hiÃ§bir sayfa onlarÄ± filtresiz Ã§ekmiyor.
GerÃ§ekten **patolojik** olan `working_capital_trend`: 37 satÄ±r iÃ§in altÄ± saniye, Ã¼stelik gerÃ§ek
bir ekranÄ± besliyor (`costing/engine.ts` â†’ kÃ¢rlÄ±lÄ±k sayfasÄ±).

`EXPLAIN (ANALYZE, BUFFERS)` sebebi tam olarak sÃ¶yledi: dÃ¶rt baÄŸÄ±ntÄ±lÄ± alt sorgu, her biri
faturalarÄ± **ay baÅŸÄ±na** yeniden tarÄ±yor â€” 37 satÄ±r Ã¼retmek iÃ§in **234.882 shared buffer hit**.

**DÃ¶rt aday kuruldu ve Ã¶lÃ§Ã¼ldÃ¼:**

| | ms | buffer |
| --- | ---: | ---: |
| A eski view, indekssiz | 6.478 | 234.879 |
| B eski view + kapsayan indeks | 2.185 | |
| D tek geÃ§iÅŸli yeniden yazÄ±m, indeksiz | 969 | |
| **C yeniden yazÄ±m + indeks (uygulanan)** | **683** | **5.247** |

**9,5Ã— hÄ±z, 45Ã— daha az buffer.** Ä°ki deÄŸiÅŸiklik de baÄŸÄ±msÄ±z katkÄ± veriyor.

> **Ã–lÃ§Ã¼m iÃ§in VACUUM ÅŸart, yalnÄ±z ANALYZE yetmez.** Bir index-only scan heap'i yalnÄ±zca
> gÃ¶rÃ¼nÃ¼rlÃ¼k haritasÄ±nÄ±n "tÃ¼mÃ¼ gÃ¶rÃ¼nÃ¼r" iÅŸaretlediÄŸi sayfalar iÃ§in atlayabilir ve o haritayÄ± yalnÄ±z
> VACUUM kurar. Toplu insert'ten hemen sonra hiÃ§bir sayfa Ã¶yle deÄŸildir; gate bunu yaÅŸadÄ± â€”
> aynÄ± veritabanÄ±nda Ã¶nce 455.011 buffer ve index-only scan yok, autovacuum'dan sonra 7.185 ve var.
> Plan her iki seferde de tablonun o anki durumu iÃ§in doÄŸruydu. `scripts/perf/volume.ts` ve
> `phase33:verify` bu yÃ¼zden `vacuum analyze` Ã§alÄ±ÅŸtÄ±rÄ±yor.

**Reddedilen aday.** KÃ¼mÃ¼latif toplam + as-of arama ile beÅŸinci bir yeniden yazÄ±m da yazÄ±ldÄ±,
Ã§Ä±ktÄ±sÄ±nÄ±n birebir aynÄ± olduÄŸu kanÄ±tlandÄ± ve **3.225 ms Ã¶lÃ§Ã¼ldÃ¼** â€” yerine geÃ§tiÄŸi ÅŸeyden yavaÅŸ.
AtÄ±ldÄ±. Ã–lÃ§Ã¼lmeseydi "optimizasyon" diye girecekti, Ã§Ã¼nkÃ¼ zekice gÃ¶rÃ¼nÃ¼yordu.

**Materialized view neden YOK.** Plan bunu Ã¶neriyor; bilerek kullanÄ±lmadÄ±. Faz 19/22/23/26'nÄ±n
tekrar tekrar vardÄ±ÄŸÄ± sebep: materialized view **saklanmÄ±ÅŸ tÃ¼retilmiÅŸ veridir**. Buradaki girdiler
faturalar ve sÃ¼rekli deÄŸiÅŸiyorlar â€” bugÃ¼n girilen bir tahsilat, iki yÄ±l Ã¶nceki bir ayÄ±n
`receivables_open`'Ä±nÄ± deÄŸiÅŸtirir â€” yani tazelemeler arasÄ±nda bayat kalÄ±rdÄ±. AltÄ±ndaki faturalarla
sessizce Ã§eliÅŸen bir iÅŸletme sermayesi trendi, bu sistemin her fazda kaÃ§Ä±ndÄ±ÄŸÄ± ikinci doÄŸruluk
kaynaÄŸÄ±nÄ±n ta kendisi. Ve **gerek kalmadÄ±**: 9,5Ã— hiÃ§bir rakamÄ± deÄŸiÅŸtirmeyen bir yeniden yazÄ±m ve
bir indeksten geldi.

**HiÃ§bir rakam deÄŸiÅŸmedi â€” sÃ¶z deÄŸil, kanÄ±t.** DSO/DPO gerÃ§ek kararlarÄ± besliyor. Yeniden yazÄ±m,
Ã¶nceki tanÄ±mla tam sonuÃ§ kÃ¼mesi Ã¼zerinde simetrik `EXCEPT` ile karÅŸÄ±laÅŸtÄ±rÄ±ldÄ±: iki yÃ¶nde de sÄ±fÄ±r
fark. Eski tanÄ±m `working_capital_trend_reference` olarak **birebir korundu** â€” hiÃ§bir katmana
grant verilmedi, hiÃ§bir sayfa okumuyor; tek iÅŸi gate'in **her koÅŸuda** eÅŸdeÄŸerliÄŸi yeniden
doÄŸrulamasÄ±. YalnÄ±z yeniden yazÄ±m gÃ¼nÃ¼ karÅŸÄ±laÅŸtÄ±ran bir gate, bir sonraki dÃ¼zenlemeyi kaÃ§Ä±rÄ±rdÄ±.

Korunan zor ayrÄ±ntÄ±: 365 gÃ¼nlÃ¼k pencere `issue_date > (period_start - 365 gÃ¼n)` â€” ay sÄ±nÄ±rÄ±na
**oturmuyor**. Aya yuvarlayan bir taslak, yÄ±lda bir gÃ¼ne denk gelen faturalarÄ± sessizce dÃ¼ÅŸÃ¼rÃ¼rdÃ¼.

### Ä°ndeks denetimi: 110 aday, 1 indeks

`scripts/perf/index-audit.ts` Ã¼Ã§ soruyu katalogdan yanÄ±tlÄ±yor: indekssiz yabancÄ± anahtarlar
(**110** bulundu), gereksiz Ã¶n-ek indeksleri (**0**), hiÃ§ kullanÄ±lmamÄ±ÅŸ indeksler (yalnÄ±z bilgi â€”
taze migrate edilmiÅŸ bir DB'de hepsi sÄ±fÄ±rdÄ±r, gate bunun Ã¼zerine hata **vermez**).

110'unun hepsini indekslemek bu fazÄ±n kendi disiplinine aykÄ±rÄ± olurdu: her indeks, her insert'e
Ã¶lÃ§Ã¼lmemiÅŸ bir yazma maliyeti bindirir. Ã–lÃ§Ã¼m neyi haklÄ± Ã§Ä±kardÄ±ysa o eklendi â€” bir tane.

## DokÃ¼man Merkezi (Faz 35, migration 0083)

ÃœÃ§ tablo (`documents`, `attachments`, `document_links`) ve bir VIEW
(`document_current_version`). Yeni bir depolama geleneÄŸi kurmuyor â€” Faz 2'ninkini sÃ¼rdÃ¼rÃ¼yor.

### AÃ§Ä±k soru #7 kapatÄ±ldÄ±: YEREL DÄ°SK

Karar mevcut koda dayanÄ±yor. `source_workbooks` (0001) zaten `storage_path` + `file_sha256`
taÅŸÄ±yor: baytlar diskte, veritabanÄ±nda yol ve saÄŸlama. `attachments` bilerek **aynÄ± iki kolon**.

| Reddedilen | Sebep |
| --- | --- |
| Obje depolama (S3 vb.) | CLAUDE.md'nin "tek ÅŸirket, Ã¶zel, yerel" konumlandÄ±rmasÄ±na harici bulut baÄŸÄ±mlÄ±lÄ±ÄŸÄ± eklerdi; dokÃ¼manlarÄ± sahibinin dosya yÃ¶neticisiyle aÃ§amayacaÄŸÄ± bir yere koyardÄ±. |
| Postgres'te bayt (bytea / large object) | Her taranmÄ±ÅŸ sÃ¶zleÅŸme yedeÄŸe girerdi. **Faz 33 Ã¶lÃ§tÃ¼**: 24.000 faturada pg_dump zaten yedek doÄŸrulamasÄ±nÄ± kÄ±rÄ±yordu. Zorunlu migration-Ã¶ncesi yedek pratik kalmalÄ±. |

**Bedeli aÃ§Ä±kÃ§a:** veritabanÄ± yedeÄŸi tek baÅŸÄ±na geri yÃ¼kleme deÄŸildir; dokÃ¼man dizini de
yedeklenmeli. KarÅŸÄ±lÄ±ÄŸÄ±nda iki koruma:

- `attachments.file_sha256` **NOT NULL** (0001'de nullable) â€” geri yÃ¼kleme hangi dosyanÄ±n eksik
  veya bozuk olduÄŸunu **kanÄ±tlayabilir**.
- Okuma sÄ±rasÄ±nda yeniden saÄŸlama alÄ±nÄ±r; uyuÅŸmazlÄ±k hata verir. Sessizce bozulmuÅŸ dosya sunan bir
  arÅŸiv, kapalÄ± olandan kÃ¶tÃ¼dÃ¼r â€” bozulma dosyalanÄ±r, e-postayla dolaÅŸÄ±r ve gÃ¼venilir sanÄ±lÄ±r.

**Ä°Ã§erik adresli yerleÅŸim:** `<kÃ¶k>/aa/bb/<sha256>`. AynÄ± baytlar bir kez saklanÄ±r, dosyanÄ±n adÄ±
kendi bÃ¼tÃ¼nlÃ¼k kontrolÃ¼dÃ¼r, ve **yola hiÃ§ kullanÄ±cÄ± metni girmediÄŸi iÃ§in** dizin dÄ±ÅŸÄ±na Ã§Ä±kma
yapÄ±sal olarak imkÃ¢nsÄ±zdÄ±r.

### `documents` â€” mantÄ±ksal dokÃ¼man

`status`: `active / archived / superseded`. `superseded` ile `archived` bilerek ayrÄ±: ilki
**yeni bir dokÃ¼man bunun yerine geÃ§ti** (ve hangisi olduÄŸunu sÃ¶yler), ikincisi yalnÄ±z aktif
kullanÄ±mdan Ã§Ä±ktÄ±. BirleÅŸtirmek sebebi kaybederdi.

GeÃ§iÅŸ koruyucusu CHECK ile **aynÄ± migration'da** (0027 dersi). Ä°zinli dÃ¶rt hamle; reddedilen:
`superseded â†’ herhangi bir ÅŸey`. CanlandÄ±rÄ±lan bir dokÃ¼man, ikisi de gÃ¼ncel olduÄŸunu iddia eden
iki dokÃ¼man bÄ±rakÄ±r ve her baÄŸlantÄ± sessizce belirsizleÅŸir.

`tags text[]` â€” join tablosu deÄŸil: etiketlerin Ã¶zniteliÄŸi yok ve hiÃ§bir ÅŸey onlara referans
vermiyor. AyrÄ± tablo, "kira etiketli dokÃ¼manlar" sorusunu Ã¼Ã§ join'e Ã§evirirdi. GIN indeksi var.

### `attachments` â€” fiziksel dosyalar ve SÃœRÃœM geÃ§miÅŸi

Versiyonlama burada, `documents`'ta deÄŸil: deÄŸiÅŸen ÅŸey dosyadÄ±r. AynÄ± sÃ¶zleÅŸmenin yeniden
taranmasÄ± yeni bir **sÃ¼rÃ¼m**dÃ¼r, yeni bir dokÃ¼man deÄŸil.

**Append-only** (0022 deseni, BEFORE UPDATE/DELETE tetikleyicileri): dÃ¼zeltilebilen bir sÃ¼rÃ¼m
geÃ§miÅŸi geÃ§miÅŸ deÄŸildir. HatalÄ± bir yÃ¼klemenin dÃ¼zeltmesi sÃ¼rÃ¼m N+1 eklemektir â€” zaten olan da
budur. Faz 24B sÄ±nÄ±fÄ± **evidence**: hiÃ§bir katmanda UPDATE/DELETE policy'si yok.

`unique (document_id, file_sha256)`: birebir aynÄ± baytlarÄ± "sÃ¼rÃ¼m 2" diye kaydetmek, **olmayan
bir deÄŸiÅŸikliÄŸi** kaydeder. AynÄ± baytlar iki farklÄ± dokÃ¼manda meÅŸru olabileceÄŸi iÃ§in sha256
**global olarak tekil deÄŸil**.

### `document_links` â€” polimorfik baÄŸlantÄ±

`entity_table` + `entity_id`, tam olarak `approvals` (0053) ve `audit_logs` gibi. Bu ÅŸema zaten
"varlÄ±klardan birine iÅŸaret et"i bÃ¶yle yapÄ±yor; Ã¼Ã§Ã¼ncÃ¼ bir gelenek Ã¶ÄŸrenilecek Ã¼Ã§Ã¼ncÃ¼ ÅŸey olurdu.
KapalÄ± liste gÃ¼venlik Ã¶zelliÄŸi: aÃ§Ä±k bir metin kolonu, hiÃ§bir zaman Ã§Ã¶zÃ¼lemeyecek bir baÄŸlantÄ±yÄ±
bir yazÄ±m hatasÄ±yla yaratmaya izin verirdi.

### `document_current_version` â€” VIEW, kolon deÄŸil

GÃ¼ncel sÃ¼rÃ¼m `max(version_no)` ile tÃ¼retilir. `current_attachment_id` kolonu, zaten cevaplanan bir
soru iÃ§in **ikinci kaynak** olurdu ve biri onu gÃ¼ncellemeden sÃ¼rÃ¼m eklediÄŸi ilk gÃ¼n bayatlardÄ±.

## KayÄ±tlÄ± GÃ¶rÃ¼nÃ¼mler ve Sahiplik FK DÃ¼zeltmesi (Faz 36, migration 0084-0085)

### 0084 â€” `saved_views`

AdlandÄ±rÄ±lmÄ±ÅŸ, tekrar kullanÄ±labilir bir global filtre kÃ¼mesi. **Filtre saklar, sonuÃ§ saklamaz** â€”
bir soru olduÄŸu iÃ§in bayatlayamaz; yeniden aÃ§Ä±ldÄ±ÄŸÄ±nda bugÃ¼nÃ¼n verisine karÅŸÄ± Ã§alÄ±ÅŸÄ±r. EÅŸleÅŸtiÄŸi
satÄ±rlarÄ± saklamak, defterin sessizce yaÅŸlanan ikinci bir kopyasÄ±nÄ± yaratÄ±rdÄ±.

| Alan | Neden |
| --- | --- |
| `module_key` | Bir filtre kÃ¼mesi yalnÄ±z kolonlarÄ±nÄ± adlandÄ±rdÄ±ÄŸÄ± ekranda anlamlÄ±; sÃ¼sleme deÄŸil, Ã¶deme filtresinin fatura ekranÄ±nda sessizce hiÃ§bir ÅŸeyle eÅŸleÅŸmesini engelleyen ÅŸey |
| `filters jsonb` | Filtre sÃ¶zlÃ¼ÄŸÃ¼nÃ¼n bÃ¼yÃ¼mesi bekleniyor; her yeni filtre iÃ§in migration, Ã¶zelliÄŸin geniÅŸletilmeyi bÄ±rakacaÄŸÄ±nÄ±n garantisi olurdu |
| `is_shared` | VarsayÄ±lan **Ã¶zel**: biri kaydettiÄŸi anda Ã§alÄ±ÅŸma filtresinin tÃ¼m ÅŸirkete gÃ¶rÃ¼nÃ¼r olmasÄ± sÃ¼rprizdir |
| `is_default` | KiÅŸi+modÃ¼l baÅŸÄ±na en fazla bir tane â€” kÄ±smi unique indeks |

**Sahiplik RLS'i, 0058'in `c_owned` ÅŸekliyle.** SELECT/UPDATE/DELETE sahiplik kapsamlÄ±, INSERT
deÄŸil â€” Ã¶lÃ§Ã¼lerek: INSERT'i de kapsayan ilk sÃ¼rÃ¼mde `db:roles-rls:verify` dÃ¼ÅŸtÃ¼, Ã§Ã¼nkÃ¼ sÄ±nÄ±f
matrisi operatÃ¶rÃ¼n insert edebilmesini bekliyor ve politika, uygulama kimliÄŸi ayarlanmamÄ±ÅŸ her
istekte reddediyordu. 0058 zaten diÄŸer sahiplik tablolarÄ±nÄ± bÃ¶yle ele alÄ±yor.

**`personal` eriÅŸim sÄ±nÄ±fÄ± eklendi.** KayÄ±tlÄ± gÃ¶rÃ¼nÃ¼m kiÅŸisel Ã§alÄ±ÅŸma tercihi; `operational`
finansal kayÄ±tlar iÃ§in yazÄ±lmÄ±ÅŸtÄ±. SÄ±nÄ±f ayÄ±rmanÄ±n precedent'i var: Faz 24B `auth_users` ile
`auth_sessions`'Ä± tam da bu sebeple ayÄ±rmÄ±ÅŸtÄ±.

**Ä°zleyici burada da salt-okunur.** Ä°lk sÃ¼rÃ¼m izleyiciye de kendi gÃ¶rÃ¼nÃ¼mlerini veriyordu;
`db:roles-rls:verify` Faz 24B'nin aÃ§Ä±kÃ§a yazdÄ±ÄŸÄ± invariant'Ä± dÃ¼ÅŸÃ¼rdÃ¼: *izleyici hiÃ§bir tabloya
yazamaz*. Ä°nvariant, kolaylÄ±ktan deÄŸerli â€” herkesin tek cÃ¼mlede kontrol edebileceÄŸi bir kural, ilk
istisnasÄ±nÄ± kazandÄ±ÄŸÄ± anda her okuyucu kendi vakasÄ±nÄ±n istisna mÄ± kural mÄ± olduÄŸunu yeniden
tÃ¼retmek zorunda kalÄ±r.

**Politika adÄ± yÃ¼k taÅŸÄ±yor.** 0058, adÄ± `_select_all_tiers` ile biten bir politikasÄ± olmayan her
tabloda migration'Ä± dÃ¼ÅŸÃ¼ren bir koruyucuyla bitiyor. Son ek, politikanÄ±n **kime** verildiÄŸini
(beÅŸ katmanÄ±n tamamÄ±) anlatÄ±r; hangi satÄ±rlarÄ± gÃ¶rdÃ¼ÄŸÃ¼nÃ¼ deÄŸil â€” o kural `using` iÃ§inde. DoÄŸru ama
son eki tutmayan `saved_views_select_own_or_shared` adÄ±, ledger-kurtarma provasÄ±nda bu koruyucuyu
dÃ¼ÅŸÃ¼rdÃ¼; ad artÄ±k iki bilgiyi de taÅŸÄ±yor.

YaÅŸam-dÃ¶ngÃ¼sÃ¼ kolonu **yok** â€” kayÄ±tlÄ± gÃ¶rÃ¼nÃ¼m oluÅŸur, dÃ¼zenlenir, silinir; arada durumu yoktur.
CHECK+guard disiplini burada atlanmadÄ±, **yapÄ±sal olarak N/A** ve gate bunu introspection ile
kanÄ±tlÄ±yor.

### 0085 â€” sahiplik FK'lerini `public.users`'a Ã§evirme

**YayÄ±nlanmÄ±ÅŸ gerÃ§ek bir hata, okuyarak deÄŸil Ã‡ALIÅTIRARAK bulundu.**

`auth.users` bu kurulumda **boÅŸ** â€” local-bootstrap.sql ÅŸemayÄ± Supabase tarzÄ± migration'lar
beklediÄŸi iÃ§in yaratÄ±yor, ama iÃ§ine hiÃ§bir ÅŸey yazÄ±lmÄ±yor. UygulamanÄ±n hesaplarÄ± `public.users`'ta
(Faz 15) ve `session.id` bir `public.users` id'si.

Buna raÄŸmen dÃ¶rt kolon `references auth.users(id)` diyordu:

```
background_jobs.created_by     (Faz 33)
documents.created_by           (Faz 35)
attachments.uploaded_by        (Faz 35)
document_links.created_by      (Faz 35)
```

Ã–lÃ§Ã¼m:

```
insert into public.documents (title, doc_type, created_by) values ('x','other', <oturum id>)
ERROR: violates foreign key constraint "documents_created_by_fkey"
```

Yani `createDocument()` â€” bir dokÃ¼manÄ± dosyalamanÄ±n tek yolu â€” **her giriÅŸ yapmÄ±ÅŸ kullanÄ±cÄ± iÃ§in
baÅŸarÄ±sÄ±z**, ve `enqueueJob()` gerÃ§ek bir aktÃ¶r verildiÄŸinde baÅŸarÄ±sÄ±z. Ä°kisi de yayÄ±nlanmÄ±ÅŸtÄ±.

**Neden hiÃ§bir gate yakalamadÄ±.** phase33:verify `enqueueJob(pool, â€¦, null)` Ã§aÄŸÄ±rÄ±yordu,
phase35:verify dokÃ¼manlarÄ± `created_by` iÃ§ermeyen ham SQL ile yazÄ±yordu. Ä°kisi de test edilen alanÄ±
**kÄ±rÄ±k bir FK'yi saÄŸlayan tek deÄŸerle** â€” NULL ile â€” geÃ§ti. Test edilen alandan kaÃ§Ä±nan bir
fixture, o alanÄ±n testi deÄŸildir.

DoÄŸru hedef `public.users`; zaten Ã§alÄ±ÅŸan sahiplik tablolarÄ±nÄ±n (`action_items.created_by`,
`scenarios.created_by`) baÅŸtan beri kullandÄ±ÄŸÄ± tablo. Veri taÅŸÄ±ma gerekmedi: bu kolonlarÄ±n hepsi
her yerde NULL'dÄ±, Ã§Ã¼nkÃ¼ non-null bir deÄŸer imkÃ¢nsÄ±zdÄ±.

`phase36:verify` artÄ±k ÅŸema genelinde, hiÃ§bir sahiplik kolonunun boÅŸ `auth.users`'Ä±
gÃ¶stermediÄŸini doÄŸruluyor â€” bu hatayÄ± yapan bir sonraki tablo yazÄ±ldÄ±ÄŸÄ± gÃ¼n dÃ¼ÅŸecek.

## Entegrasyon Merkezi (Faz 37, migration 0086)

Bir tablo (`integration_connections`), bir VIEW (`integration_health`) ve Faz 33'Ã¼n kuyruÄŸuna
**dÃ¶rt yeni iÅŸ tÃ¼rÃ¼**. Yeni kuyruk yok.

### Kimlik bilgisi bu veritabanÄ±nda DURMAZ

Tablo bir baÄŸlantÄ±nÄ±n **var olduÄŸunu** ve nasÄ±l yapÄ±landÄ±rÄ±ldÄ±ÄŸÄ±nÄ± kaydeder â€” token, parola veya
client secret'Ä± asla. Onlar ortam deÄŸiÅŸkenlerinde kalÄ±r (Faz 6/25'in Telegram token'Ä±na uyguladÄ±ÄŸÄ±
kuralÄ±n aynÄ±sÄ±) ve `credential_env_var` deÄŸerin kendisini deÄŸil **adÄ±nÄ±** taÅŸÄ±r. Bu projenin her
migration Ã¶ncesi aldÄ±ÄŸÄ± pg_dump, aksi hÃ¢lde bir kimlik sÄ±zÄ±ntÄ±sÄ± olurdu.

Gate bunu iki yÃ¶nden doÄŸruluyor: tabloda `password/token/secret/api_key` ile biten kolon yok, ve
konnektÃ¶rler `process.env`'e hiÃ§ dokunmuyor (kimlik bilgisi `ConnectorContext` ile geliyor â€” kendi
yapÄ±landÄ±rmasÄ±nÄ± loglayan bir konnektÃ¶r token sÄ±zdÄ±rÄ±r).

### `provider` neden KAPALI LÄ°STE deÄŸil

Muhasebe yazÄ±lÄ±mÄ± seÃ§imi (ParaÅŸÃ¼t / Logo / Mikro / Luca) bu depodan tÃ¼retilemeyen bir iÅŸ kararÄ± ve
**kullanÄ±cÄ± onayÄ± bekliyor**. BugÃ¼n bir CHECK listesi yazmak ya onlar adÄ±na tahmin etmek ya da
karar gÃ¼nÃ¼ migration yazmak olurdu. HiÃ§bir kod bu deÄŸere gÃ¶re dallanmÄ±yor â€” satÄ±ra iliÅŸtirilmiÅŸ
bir belgedir.

### Durum ve geÃ§iÅŸ koruyucusu

`disabled / enabled / error / revoked`, CHECK ile **aynÄ± migration'da** sekiz hamlelik koruyucu.
Reddedilen ikisi:

- `revoked â†’ herhangi bir ÅŸey`: geri alÄ±nmÄ±ÅŸ bir kimlik bilgisiyle veri Ã§ekmeyi sessizce
  sÃ¼rdÃ¼rmek. Yeniden yapÄ±landÄ±rma **yeni bir baÄŸlantÄ±dÄ±r** â€” zaten olan da budur.
- `disabled â†’ error`: hiÃ§ Ã§alÄ±ÅŸmamÄ±ÅŸ bir baÄŸlantÄ± baÅŸarÄ±sÄ±z olamaz.

`error` durumu **sebepsiz olamaz** (CHECK): mesajsÄ±z bir hata, kimsenin baÅŸlayamayacaÄŸÄ± bir destek
kaydÄ±dÄ±r.

### `integration_health` â€” VIEW

`minutes_since_success` hiÃ§ baÅŸarÄ±lÄ± senkron yoksa **NULL**; "0 dakika Ã¶nce" deÄŸil. `is_overdue`
yalnÄ±z zamanlanmÄ±ÅŸ ve aÃ§Ä±k bir baÄŸlantÄ± iÃ§in anlamlÄ±. Ã–lÃ¼ mektup sayÄ±sÄ± Faz 33'Ã¼n
`background_jobs`'undan okunuyor â€” ikinci bir sayaÃ§ tutulmuyor.

### Kuyruk: GENÄ°ÅLETÄ°LDÄ°, kopyalanmadÄ±

`background_jobs.job_type` dÃ¶rt deÄŸer aldÄ± (`bank_api_sync`, `einvoice_sync`, `fx_rate_sync`,
`accounting_sync`). Retry, geri Ã§ekilme, Ã¶lÃ¼ mektup ve geÃ§iÅŸ koruyucusu Faz 33'te zaten var.

> Sonraki fazlar iÃ§in: bu kÃ¼menin **boyutunu** sabitleyen bir gate bir sonraki geniÅŸlemede kÄ±rÄ±lÄ±r
> (Faz 31 dersi). `phase37:verify` **Ã¼st-kÃ¼me** iddia ediyor, ve ayrÄ±ca TS `JOB_TYPES` listesiyle
> DB CHECK'ini **karÅŸÄ±laÅŸtÄ±rÄ±yor** â€” Ã§Ã¼nkÃ¼ bu fazda tam olarak o sÃ¼rÃ¼klenme yaÅŸandÄ±: DB geniÅŸledi,
> TS enum'u geniÅŸlemedi, `enqueueJob()` veritabanÄ±nÄ±n kabul edeceÄŸi bir iÅŸ tÃ¼rÃ¼nÃ¼ reddetti.

### RLS

`config` sÄ±nÄ±fÄ±: herkes hangi entegrasyonlarÄ±n var olduÄŸunu ve saÄŸlÄ±klÄ± olup olmadÄ±klarÄ±nÄ±
gÃ¶rebilir; yalnÄ±z **admin** yapÄ±landÄ±rabilir. CanlÄ± bir banka akÄ±ÅŸÄ±nÄ± aÃ§mak yÃ¶netim iÅŸidir, finans
veri giriÅŸi deÄŸil â€” bu sistemde harici bir sisteme eriÅŸim vermeye en yakÄ±n ÅŸey.

## Asistan KonuÅŸmalarÄ± (Faz 38, migration 0087)

Bir tablo (`assistant_conversations`) ve `ai_response_snapshots`'a iki kolon. **Cevap Ã¼retme
hattÄ±na dokunulmadÄ±.**

### Mevcut hat deÄŸiÅŸmedi

`ai_response_snapshots` zaten her cevabÄ± sorusu, yanÄ±t modu, modeli, kaynak fact anahtarlarÄ± ve
kaynak href'leriyle saklÄ±yordu. 0087 onu deÄŸiÅŸtirmiyor; takip sorusunun ihtiyaÃ§ duyduÄŸu iki
kolonu ekliyor: bir turn'Ã¼n hangi konuÅŸmaya ait olduÄŸu ve sÄ±radaki yeri.

AsistanÄ± gÃ¼venli kÄ±lan her ÅŸey `src/lib/ai`'de kalÄ±yor â€” `mutationIntent()`, deterministik-Ã¶nce
akÄ±ÅŸ, `AI_FORCE_DETERMINISTIC`. HiÃ§biri buraya taÅŸÄ±nmadÄ±.

### `conversation_id` neden NULLABLE

BugÃ¼ne kadar kaydedilmiÅŸ her cevap konuÅŸmalardan Ã¶nce Ã¼retildi. NOT NULL bir kolon ya o geÃ§miÅŸi
reddederdi ya da uydurulmuÅŸ bir ipliÄŸe zorlardÄ±. NULL `conversation_id` **"tek seferlik soru"**
demek â€” o cevaplarÄ±n gerÃ§ekte olduÄŸu ÅŸey.

`ai_response_snapshots_turn_consistency`: ikisi birlikte var ya da birlikte yok, ve `turn_index >= 1`.

### Durum ve geÃ§iÅŸ koruyucusu

`active / archived`, CHECK ile **aynÄ± migration'da** koruyucu. Ä°ki yÃ¶n de izinli: bir konuÅŸmayÄ±
arÅŸivlemek toplamaktÄ±r, sonucu olan bir karar deÄŸil; hÃ¢lÃ¢ ihtiyaÃ§ duyulan birini geri almak da
normal. ÃœÃ§Ã¼ncÃ¼ bir durum yok â€” koruyucunun buradaki dar iÅŸi, ileride bir durum eklenirse ona giren
ve Ã§Ä±kan hamlelere birinin karar vermesini zorunlu kÄ±lmak.

### RLS: sahiplik, Faz 36'nÄ±n `personal` sÄ±nÄ±fÄ±

Bir konuÅŸma kiÅŸinin kendi Ã§alÄ±ÅŸma ipliÄŸi â€” finansal kayÄ±ttan Ã§ok kayÄ±tlÄ± gÃ¶rÃ¼nÃ¼me yakÄ±n. AynÄ±
sebeple sahiplik kapsamlÄ±: birinin asistana ne sorduÄŸu ve hangi sÄ±rayla sorduÄŸu **kendisine ait**.

Ä°zleyici yine **yalnÄ±z okur** (Faz 36'da yerleÅŸen karar): Faz 24B "izleyici hiÃ§bir tabloya yazamaz"
invariant'Ä±nÄ± iddia ediyor. Ä°zleyici yine de **soru sorabilir** â€” cevap `ai_response_snapshots`'a
uygulama yolu tarafÄ±ndan yazÄ±lÄ±r, ki bu katman-kapsamlÄ± bir yazma deÄŸildir.

## Standart Ä°Ã§e AktarÄ±m v2 ve Ã‡oklu DÃ¶viz GÃ¼venliÄŸi (migration 0088â€“0094)

Standart 17 sekmeli ÅŸablon (`Standard Import v2`) ve sessiz Ã§apraz dÃ¶viz toplamlarÄ±nÄ± engelleyen TRY-yalnÄ±z gÃ¶rÃ¼nÃ¼m dÃ¼zeltmeleri:

- **0088 (`0088_import_external_keys.sql`):** TekrarlÄ± iÃ§e aktarÄ±mda idempotent upsert iÃ§in iÅŸ tablolarÄ±na (`counterparties`, `bank_accounts`, `invoices`, `payments`, `payment_instances`, `bank_transactions`, `checks_notes`, `loans`, `loan_installments`, `tax_obligations`, `fx_rates`, `budget_lines`, `external_assumptions`) deterministik `external_key` tekil indeksleri ekler.
- **0089 (`0089_standard_import_v2_staging.sql`):** Ä°ki aÅŸamalÄ± Ã¶nizleme/onay hattÄ± iÃ§in `import_jobs`, `import_job_sheets` ve `import_job_rows` hazÄ±rlÄ±k (staging) tablolarÄ±nÄ±, yaÅŸam dÃ¶ngÃ¼sÃ¼ kÄ±sÄ±tlarÄ±nÄ± ve 5 katmanlÄ± RLS politikalarÄ±nÄ± kurar.
- **0090 (`0090_check_loan_currency.sql`):** `checks_notes` ve `loans` / `loan_installments` tablolarÄ±na aÃ§Ä±k para birimi (`currency`) doÄŸrulamasÄ± ekler.
- **0091 (`0091_import_rows_blocked_by_parent.sql`):** Ãœst kayÄ±t hatasÄ± nedeniyle engellenen alt satÄ±rlarÄ± (`blocked_by_parent`) `import_job_rows` durum kÃ¼mesine ekler.
- **0092 (`0092_risk_level_unsupported_currency.sql`):** Desteklenmeyen dÃ¶viz satÄ±rlarÄ±nÄ±n risk sÄ±nÄ±flandÄ±rmasÄ±nda sessizce TRY sayÄ±lmasÄ±nÄ± Ã¶nleyen `unsupported_currency` iÅŸaretini ekler.
- **0093 (`0093_tier1_try_threshold_views.sql`):** Kademe-1 eÅŸik ve anomali gÃ¶rÃ¼nÃ¼mlerinde dÃ¶viz karÄ±ÅŸtÄ±rmasÄ±nÄ± Ã¶nleyerek TRY filtrelemesi uygular.
- **0094 (`0094_tier2_tier3_try_only_views.sql`):** Kademe-2 ve Kademe-3 analitik/kontrol gÃ¶rÃ¼nÃ¼mlerini TRY-yalnÄ±z toplamlara sÄ±nÄ±rlar.

## Zorunlu Parola DeÄŸiÅŸikliÄŸi (migration 0095-0096; Wave 0 / S6)

Ä°ncelenmemiÅŸ `46541d8` katmanÄ±nÄ±n getirdiÄŸi ve sahibin KEEP listesinde tuttuÄŸu Ã¶zellik: yÃ¶netici
bir hesabÄ± oluÅŸturunca, parolasÄ±nÄ± sÄ±fÄ±rlayÄ±nca ya da aÃ§Ä±kÃ§a istediÄŸinde kullanÄ±cÄ± bir sonraki
isteÄŸinde kendi parolasÄ±nÄ± belirlemek zorundadÄ±r. 0095 katmanla geldi ve olduÄŸu gibi kaldÄ±; 0096
Wave 0'da, deÄŸiÅŸikliÄŸin her katman iÃ§in **denetlenebilmesi** iÃ§in eklendi.

### 0095 â€” `users.must_change_password`

`boolean not null default false` â€” `add column if not exists`; sabit varsayÄ±lan olduÄŸu iÃ§in tablo
yeniden yazÄ±lmaz. Kolon dÃ¼zeyinde grant yok; 0035 tablo grant'leri ve 0031/0035/0058 satÄ±r
politikalarÄ± aynen geÃ§erli.

- **Kim `true` yapar:** `createUser` (varsayÄ±lan; form bayrak gÃ¶ndermez), `resetUserPassword`
  (varsayÄ±lan), `forcePasswordChange` (yÃ¶netici dÃ¼ÄŸmesi "ÅŸifre deÄŸiÅŸimi zorla"),
  `scripts/ops/rotate-passwords.ts`.
- **Kim `false` yapar:** yalnÄ±z kullanÄ±cÄ±nÄ±n kendi deÄŸiÅŸikliÄŸi (`changeOwnPassword`,
  `src/lib/auth.ts`).
- **Nerede uygulanÄ±r:** `getCurrentUser()` bayraÄŸÄ± her istekte canlÄ± okur (oturum Ã¶nbelleÄŸi yok);
  `requireSession()` sayfalarÄ± `/change-password`'a yÃ¶nlendirir, `requireApiSession()` JSON
  rotalarÄ±nda 401 dÃ¶ner, giriÅŸte `loginAction` doÄŸrudan `/change-password`'a gÃ¶nderir.
- Bayrak bir **kimlik** durumudur, finansal kayÄ±t deÄŸil; denetim satÄ±rlarÄ±nÄ±n `before`/`after`
  izdÃ¼ÅŸÃ¼mÃ¼nde (`users/engine.ts` `loadForAudit`) Wave 0'dan beri yer alÄ±r.

### 0096 â€” `audit_logs_insert_own_password_change` (izleyicinin tek yazma yolu)

**Sorun.** KullanÄ±cÄ±nÄ±n kendi deÄŸiÅŸikliÄŸi bir denetim satÄ±rÄ± bÄ±rakmak zorunda ve bu satÄ±r tek
yazÄ±cÄ±dan (`@/lib/audit`), kullanÄ±cÄ±nÄ±n **kendi katmanÄ±nda** yazÄ±lÄ±yor. OperatÃ¶r, onaylayÄ±cÄ±,
yÃ¶netici ve admin bunu 0058'in `audit_logs_insert_record` politikasÄ±yla zaten yapabiliyordu;
izleyicinin hiÃ§bir tabloda INSERT politikasÄ± yoktu â†’ izleyicinin deÄŸiÅŸikliÄŸi denetlenemez, dolayÄ±sÄ±yla
hiÃ§ yapÄ±lamazdÄ±.

**Eklenen, en dar hÃ¢liyle:** yalnÄ±z `mas_radar_viewer` iÃ§in tek bir INSERT politikasÄ±:

```sql
with check (
  action = 'change_own_password'
  and entity_table = 'users'
  and actor = public.current_app_user()
  and entity_id = public.current_app_user()
)
```

`current_app_user()` kimlik taÅŸÄ±mayan baÄŸlantÄ±da (betikler, giriÅŸ yolu, salt-okunur Telegram
kimliÄŸi) NULL'dÄ±r ve `=` NULL'a karÅŸÄ± hiÃ§bir satÄ±rla eÅŸleÅŸmez. UPDATE/DELETE yolu yok; `audit_logs`
yine ekleme-yalnÄ±z (0022 tetikleyicileri + 0058 `evidence` sÄ±nÄ±fÄ±). Kod matrisinde (`@/lib/authz/
matrix`) izleyici `evidence` sÄ±nÄ±fÄ±nda hÃ¢lÃ¢ READ; bu istisna orada ve `db.ts` `runAsReadOnlySystem`
yanÄ±nda aÃ§Ä±kÃ§a yazÄ±lÄ±. `default values` sondasÄ± izleyici iÃ§in yine reddedilir (eylem NULL).

**Neden SECURITY DEFINER fonksiyon deÄŸil:** ÅŸemada Ã¶rneÄŸi yok, sahibinin haklarÄ±yla ve sabitlenmesi
gereken bir `search_path` ile koÅŸardÄ±, ve denetim satÄ±rÄ±nÄ± isteÄŸi kaydedilen katman deÄŸil sahip
yazardÄ±. Politika mevcut modeli korur: users/sessions satÄ±rlarÄ± Ã§alÄ±ÅŸma zamanÄ± rolÃ¼yle (0035),
kanÄ±t kiÅŸinin katmanÄ±yla.

**DeÄŸiÅŸikliÄŸin SQL sÄ±rasÄ±** (`changeOwnPassword`, ham â€” katmansÄ±z â€” havuzda, tek transaction):
kendi satÄ±rÄ±nÄ± kilitle (`for update`) â†’ bu oturum hÃ¢lÃ¢ canlÄ± mÄ± (arada yÃ¶netici sÄ±fÄ±rladÄ±ysa ya da
pasifleÅŸtirdiyse yazma yok) â†’ `before` GÃœNCELLEMEDEN Ã–NCE okunur â†’ `users` gÃ¼ncellemesi
(`users_app_runtime`) â†’ DÄ°ÄER oturumlar iptal (`sessions_app_runtime`; mevcut oturum aÃ§Ä±k kalÄ±r) â†’
`set_config('app.user_id', <kullanÄ±cÄ±>, true)` â†’ `set local role <kendi katmanÄ±>` â†’ `audit()` â†’
commit. Ä°ki ayar da transaction'a yereldir; hata yolunda baÄŸlantÄ± havuza dÃ¶nmez, imha edilir. Eski
parola `attemptLogin` ile doÄŸrulanÄ±r: sabit sÃ¼reli, beÅŸ yanlÄ±ÅŸ deneme hesabÄ± 15 dakika kilitler.
`set local role` COMMIT'e kadar sÃ¼rdÃ¼ÄŸÃ¼ iÃ§in ertelenmiÅŸ tetikleyiciler de katmanda koÅŸar; `users`'taki tek
ertelenmiÅŸ tetikleyici (`users_require_active_admin`, 0031) yalnÄ±z `role`/`is_active` gÃ¼ncellemesinde
ateÅŸlenir ve bu deÄŸiÅŸiklik ikisine de dokunmaz.

**Migration'Ä±n kendi kontrolÃ¼:** beÅŸ katmanÄ±n her birinin `audit_logs` Ã¼zerinde bir INSERT yolu
olduÄŸunu ve izleyicinin bu tablodaki tek yazma politikasÄ±nÄ±n 0096'nÄ±nki olduÄŸunu doÄŸrular; aksi
hÃ¢lde migration dÃ¼ÅŸer. `db:roles-rls:verify` (H bÃ¶lÃ¼mÃ¼) aynÄ± akÄ±ÅŸÄ± gerÃ§ek `mas_radar_app`
kimliÄŸiyle beÅŸ katman iÃ§in oynatÄ±r (geri alÄ±nÄ±r), izleyicinin beÅŸ sapmasÄ±nÄ±n (baÅŸka aktÃ¶r, baÅŸka
hesap, baÅŸka eylem, baÅŸka tablo, kimliksiz baÄŸlantÄ±) reddedildiÄŸini ve izleyicinin ÅŸemadaki TEK
yazma politikasÄ±nÄ±n bu olduÄŸunu Ã¶lÃ§er. VeritabanÄ± gerektirmeyen yerel koruma
`tests/own-password-audit-migration.test.ts`: koÅŸucu dosya kÃ¼mesini kabul ediyor, tek politika / yalnÄ±z
INSERT / yalnÄ±z izleyici, dÃ¶rt koÅŸul (gevÅŸeÄŸi yok), Ã¶nce `drop â€¦ if exists`, grant/SECURITY DEFINER yok,
kod matrisinde izleyici `evidence` sÄ±nÄ±fÄ±nda yine yalnÄ±z okur.

**KatmanÄ±n kÄ±rÄ±k hÃ¢li (kayÄ±t iÃ§in):** deÄŸiÅŸiklik `getPool()` Ã¼zerinden, yani kullanÄ±cÄ±nÄ±n katmanÄ±nda
koÅŸuyordu; `users`'Ä± yalnÄ±z admin katmanÄ± gÃ¼ncelleyebildiÄŸi iÃ§in diÄŸer dÃ¶rt katmanÄ±n `select â€¦ for
update`'i satÄ±r bulamÄ±yor ve kullanÄ±cÄ± `/change-password`'ta kalÄ±cÄ± olarak kilitli kalÄ±yordu.
`before` gÃ¼ncellemeden SONRA okunuyor, yeni durum eski durum diye kaydediliyordu.

## SÄ±cak Okuma YollarÄ± KÄ±smi ve BileÅŸik Ä°ndeksleri (migration 0097)

Salt indeks eklemesi (`0097_hot_path_partial_indexes.sql`); hiÃ§bir tablo kolonu, kÄ±sÄ±t, gÃ¶rÃ¼nÃ¼m, fonksiyon, GRANT ya da RLS politikasÄ± deÄŸiÅŸtirilmez:

- `idx_sessions_active_token_hash`: `public.sessions (token_hash) include (user_id, id, expires_at, last_seen_at, created_at) where revoked_at is null` â€” oturum doÄŸrulama sÄ±cak yolu (`src/lib/auth.ts`).
- `idx_payment_instances_open_due_date`: `public.payment_instances (due_date, amount desc nulls last) include (id, status, currency) where status in ('unpaid', 'partial', 'planned', 'late')` â€” aÃ§Ä±k Ã¶deme Ã¶rnekleri ve gecikmiÅŸ vadeler (`src/lib/home/overview-snapshot.ts`, `src/lib/radar/queries.ts`).
- `idx_invoices_open_direction_due_date`: `public.invoices (direction, due_date) include (id, invoice_no, party_id, issue_date, currency, gross_amount, paid_amount, status) where status in ('open', 'partial')` â€” aÃ§Ä±k faturalar ve yaÅŸlandÄ±rma sorgularÄ±.
- `idx_bank_transactions_queue_date`: `public.bank_transactions (txn_date desc, (abs(amount)) desc, id desc) where status in ('unmatched', 'suggested')` â€” `bank_unmatched_queue` `LIMIT 50` Ã¶n-sÄ±ralÄ± sayfalama yolu (`src/lib/bank/engine.ts`).
- `idx_audit_logs_created_id_desc`: `public.audit_logs (created_at desc, id desc)` â€” `/system/audit` zaman sÄ±ralÄ± sunucu sayfalamasÄ±.
- `idx_mapping_reviews_active_sev_created`: `public.mapping_reviews (severity, created_at) include (status, issue_type) where status in ('open', 'rejected')` â€” Ana Ekran veri kalitesi sayÄ±mÄ± ve `/data/reviews` kuyruÄŸu.


## PostgreSQL GÃ¶rÃ¼nÃ¼m (`security_invoker`) KalkanÄ± ve RLS SertleÅŸtirmesi (Faz 39, migration 0098)

`0098_view_security_invoker_and_rls_hardening.sql` PostgreSQL katmanÄ±ndaki beÅŸ yetki sÄ±nÄ±rÄ±nÄ± sertleÅŸtirir:

1. **81/81 GÃ¶rÃ¼nÃ¼mde `security_invoker = true` ve Yazma Yetkisi Ä°ptali:** `public` ÅŸemasÄ±ndaki tÃ¼m gÃ¶rÃ¼nÃ¼mlerde (`pg_class.relkind = 'v'`) `ALTER VIEW ... SET (security_invoker = true)` uygulanÄ±r ve `INSERT, UPDATE, DELETE, TRUNCATE` yetkileri `PUBLIC`, `anon`, `authenticated`, `mas_radar_app` ve beÅŸ katman rolÃ¼nden tamamen geri alÄ±nÄ±r; bÃ¶ylece tek tablolu otomatik gÃ¼ncellenebilir gÃ¶rÃ¼nÃ¼mler (`costing_invoice_facts`, `profitability_by_department`, `control_unmatched_bank_aged`, `anomaly_unusual_record_hour`) Ã¼zerinden RLS baypasÄ± kapatÄ±lÄ±r. `public.approval_queue` gÃ¶rÃ¼nÃ¼mÃ¼, `public.users` tablosuna doÄŸrudan join yapmak yerine yalnÄ±z `display_name` dÃ¶ndÃ¼ren dar `public.user_display_label(uuid)` yardÄ±mcÄ±sÄ±nÄ± kullanarak `security_invoker = true` altÄ±nda tÃ¼m katmanlarda Ã§alÄ±ÅŸÄ±r.
2. **VarsayÄ±lan Yazma Yetkisi TemizliÄŸi ve `mas_radar_app` `NOINHERIT`:** `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM authenticated` ve `ALTER ROLE mas_radar_app NOINHERIT` ile katman deÄŸiÅŸtirmemiÅŸ baÄŸlantÄ±nÄ±n iÅŸ tablolarÄ±nda yazma yetkisi miras almasÄ± kapatÄ±lÄ±r.
3. **`public.sessions` YÃ¶netici Okuma ve Ä°ptal PolitikalarÄ± (`sessions_admin_read`, `sessions_admin_revoke`):** `public.session_password_ready()` kontrolÃ¼ altÄ±nda `mas_radar_admin` rolÃ¼nÃ¼n aktif oturumlarÄ± saymasÄ± ve `revoked_at IS NULL -> NOT NULL` geÃ§iÅŸiyle iptal etmesi saÄŸlanÄ±r (`sessions_revoked >= 1`).
4. **Sahiplik SahteciliÄŸi ve Kuyruk KorumasÄ±:** `saved_views` ve `assistant_conversations` `INSERT` politikalarÄ± `created_by is not distinct from public.current_app_user()` koÅŸuluyla baÅŸka kullanÄ±cÄ± adÄ±na kayÄ±t aÃ§Ä±lmasÄ±nÄ± reddeder; `background_jobs` gÃ¼ncellemesi `finance_manager`/`admin` ve yalnÄ±z kendi `queued` iÅŸini `cancelled` yapan `finance_operator` ile sÄ±nÄ±rlandÄ±rÄ±lÄ±r.
5. **Maker-Checker Geri YazÄ±mÄ± ve BÃ¼tÃ§e/Tahmin Onay RolÃ¼ KapÄ±sÄ±:** `mapping_reviews` ve `external_assumptions` Ã¼zerinde `mas_radar_finance_approver` yalnÄ±z inceleme durumu kolonlarÄ±nÄ± (`enforce_approver_legacy_writeback_columns()`) gÃ¼ncelleyebilir; `budget_lines` ve `forecast_lines` Ã¼zerinde `enforce_planning_approval_role()` tetikleyicisi `version_status = 'approved'` geÃ§iÅŸini yalnÄ±z `approver+` rollerine aÃ§ar.


## GÃ¶rÃ¼nÃ¼m MatematiÄŸi OnarÄ±mÄ±, `FIN-03` Bilinmeyen AÃ§Ä±lÄ±ÅŸ Bakiyesi, KÄ±sÄ±t DoÄŸrulama ve SÄ±cak FK Ä°ndeksleri (Faz 44, migration 0099)

`0099_view_math_fin03_constraints_and_indexes.sql` tÃ¼m yeniden tanÄ±mlanan 20 gÃ¶rÃ¼nÃ¼mde `WITH (security_invoker = true)` ve yazma yetkisi iptalini (`REVOKE INSERT, UPDATE, DELETE, TRUNCATE`) koruyarak finansal gÃ¶rÃ¼nÃ¼m matematiÄŸini, `FIN-03` kuralÄ±nÄ± ve ÅŸema kÄ±sÄ±tlarÄ±nÄ± tamamlar:

1. **Kredi Taksiti, Ã–deme ve Ã‡ek StatÃ¼ / DÃ¶viz / KÄ±smi Kalan Tutar / Ã‡ift SayÄ±m OnarÄ±mÄ±:**
   - `loan_installments.paid_amount`, `payment_instances.linked_invoice_id`, `checks.linked_invoice_id` ve `invoices.settled_by_check_id` kolonlarÄ± (ve kÄ±smi B-tree indeksleri) eklenir.
   - `counterparty_exposure_items`, `debt_maturity_ladder` (ve para birimi kÄ±rÄ±lÄ±mlÄ± `debt_maturity_ladder_by_currency`), `liquidity_forecast_daily`, `financial_calendar` ve `financial_calendar_daily` gÃ¶rÃ¼nÃ¼mlerinde `'planned'` / `'late'` kredi taksitleri kapsama alÄ±nÄ±r; Ã§ek ve kredi taksitleri sabit `'TRY'` yerine gerÃ§ek `c.currency` / `l.currency` deÄŸerleriyle ayrÄ±ÅŸtÄ±rÄ±lÄ±r; `payment_instances` iÃ§in `coalesce(pi.currency, 'TRY')` kaldÄ±rÄ±larak `currency IS NULL` satÄ±rlar `unknown_currency_count` altÄ±nda ayrÄ±ca raporlanÄ±r; `settled_by_check_id` / `linked_invoice_id` ile baÄŸlanmÄ±ÅŸ faturalar nakit tahmininde ikinci kez sayÄ±lmaz.
2. **`FIN-03` Bilinmeyen AÃ§Ä±lÄ±ÅŸ Bakiyesi ve Hazine MutabakatÄ±:**
   - `bank_cash_position`: `ca.opening_balance IS NULL` olduÄŸunda `coalesce(ca.opening_balance, 0)` kullanÄ±lmaz; doÄŸal SQL `NULL` yayÄ±lÄ±mÄ±yla `derived_balance = NULL`, `opening_known = false` ve `movement_net` ayrÄ± kolon olarak dÃ¶ner.
   - `treasury_position_summary` ve `treasury_liquidity_gap`: Bir para biriminde `unknown_opening_count > 0` ise `available_now`, `projected_contracted`, `projected_expected`, `financing_need` ve `breaches_floor` alanlarÄ± `NULL` (`status = 'unknown_opening_balance'`) dÃ¶ner; `movements_only_total` ayrÄ± taÅŸÄ±nÄ±r.
   - `treasury_cashflow_reconciliation`: Aktif `TRY` banka hesaplarÄ±nÄ±n `opening_balance` toplamÄ±nÄ± iÃ§erir; herhangi birinde `opening_balance IS NULL` ise sahte `'divergent'` P0 alarmÄ± yerine `'incomplete_opening_balance'` dÃ¶ndÃ¼rÃ¼r.
3. **Cari Defter, Ã‡apraz-DÃ¶viz KÄ±sÄ±tÄ±, FX EÅŸik Kontrolleri ve YÄ±llÄ±k BÃ¼tÃ§e DaÄŸÄ±lÄ±mÄ±:**
   - `current_account_ledger`: SatÄ±ÅŸ faturasÄ± (`sales`) `+debit` / tahsilat `+credit`, alÄ±ÅŸ faturasÄ± (`purchase`) `+credit` / tedarikÃ§i Ã¶demesi `+debit` muhasebe iÅŸaretiyle ve `(party_id, currency)` bazÄ±nda `running_balance` ile Ã¼retilir.
   - `enforce_invoice_allocation_currency()` (`BEFORE INSERT OR UPDATE ON public.invoice_allocations`): Kaynak banka hareketi / Ã¶deme / Ã§ek para birimi ile hedef fatura para birimi farklÄ±ysa `ERRCODE = '23514'` (`cross_currency_allocation_forbidden`) fÄ±rlatÄ±r.
   - `control_large_payments` ve `control_approval_bypass`: YabancÄ± para Ã¶demelerde `fx_rate_snapshots` (`rate_date <= due_date`) Ã¼zerinden `try_equivalent` hesaplar; kur yoksa `needs_fx_review = true` olarak iÅŸaretler.
   - `cash_forecast_13w` ve `optimization_run_summary`: Para birimi bazÄ±nda (`currency`) gruplanarak dÃ¶viz karÄ±ÅŸÄ±mÄ± Ã¶nlenir.
   - `budget_vs_actual` ve `budget_variance_summary`: YÄ±llÄ±k (`period_kind = 'annual'`) onaylÄ± bÃ¼tÃ§e satÄ±rlarÄ± ilgili mali yÄ±lÄ±n 12 ayÄ±na kuruÅŸ-tam daÄŸÄ±tÄ±lÄ±r (12. ay yuvarlama farkÄ±nÄ± taÅŸÄ±r); gerÃ§ekleÅŸen tutarlar `LATERAL` iÃ§inde Ã¶nceden toplanarak Ã§arpÄ±lma (`fan-out`) sÄ±fÄ±rlanÄ±r.
   - `payment_priority_queue` (`p.status = 'active'` ve `outflow` zorunlu) ve `control_dashboard` (tek taramalÄ± CTE `UNION ALL` sayÄ±mÄ±) gÃ¼ncellenir.
4. **Åema TutarlÄ±lÄ±ÄŸÄ±, Durum Makinesi, 8 KÄ±sÄ±t DoÄŸrulama ve SÄ±cak Ä°ndeksler:**
   - `0083` Ã§atÄ±ÅŸmasÄ±: `public.attachments.document_id` yabancÄ± anahtarÄ± `ON DELETE RESTRICT` yapÄ±lÄ±r.
   - `0034` geÃ§iÅŸ bekÃ§ileri: `payment_instances` iÃ§in `unpaid â†’ late` ve `planned â†’ late`; `checks` iÃ§in `bounced â†’ cleared` ve `bounced â†’ cancelled` geÃ§iÅŸleri aÃ§Ä±lÄ±r.
   - `0023` ve `0025` iÃ§indeki 8 `NOT VALID` kÄ±sÄ±t (`payments_archive_consistency`, `checks_archive_triplet_consistency`, `loans_archive_triplet_consistency`, `scenario_runs_archive_triplet_consistency`, `external_assumptions_archive_triplet_consistency`, `action_items_archive_triplet_consistency`, `payment_instances_paid_fields_scoped`, `loan_installments_paid_fields_scoped`) `VALIDATE CONSTRAINT` ile doÄŸrulanÄ±r; serbest `currency` kolonlarÄ±na ISO-4217 (`^[A-Z]{3}$`) CHECK kÄ±sÄ±tÄ± ve 7 sÄ±cak FK/bileÅŸik B-tree indeksi eklenir.


## VeritabanÄ± Seviyesinde Sert DÃ¶nem Kilidi ve KapanÄ±ÅŸ Kontrol KapÄ±sÄ± (Faz 45, migration 0100)

`0100_hard_period_lock_enforcement.sql` kapanmÄ±ÅŸ (`status = 'locked'`) bir finansal aya geÃ§miÅŸe dÃ¶nÃ¼k kayÄ±t eklenmesini, deÄŸiÅŸtirilmesini, silinmesini veya dÃ¶nemler arasÄ± tarih kaydÄ±rmasÄ±nÄ± doÄŸrudan PostgreSQL `BEFORE` tetikleyicisiyle engeller:

1. **`public.cashflow_months` Kilit ve Yeniden AÃ§ma KolonlarÄ±:** `locked_at`, `locked_by`, `reopened_at`, `reopened_by`, `reopen_reason` ve `lock_fingerprint` kolonlarÄ± eklenir; mevcut `'locked'` satÄ±rlarda `locked_at` geri doldurulur.
2. **Rol-KorumalÄ± DÃ¶nem GeÃ§iÅŸ BekÃ§isi (`enforce_cashflow_month_lock_transition`):**
   - `status = 'locked'` iÃ§ine veya iÃ§inden yapÄ±lan geÃ§iÅŸlerde `current_user NOT IN ('mas_radar_finance_manager', 'mas_radar_admin', 'postgres')` ise `ERRCODE = '42501'` (`period_lock_requires_manager`) fÄ±rlatÄ±lÄ±r; bÃ¶ylece `mas_radar_finance_operator` rolÃ¼nÃ¼n kilit aÃ§ma aÃ§Ä±ÄŸÄ± veritabanÄ±nda kapatÄ±lÄ±r.
   - Kilitli dÃ¶nemden Ã§Ä±kÄ±ÅŸ (`reopen`) yalnÄ±z `'reviewed'` statÃ¼sÃ¼ne ve en az 10 karakterlik `reopen_reason` ile yapÄ±labilir (`ERRCODE = '23514'`, `period_reopen_reason_required` / `period_reopen_target_invalid`).
   - Kilitli dÃ¶nemde baÅŸlÄ±k rakamlarÄ±nÄ±n (`opening_balance`, `projected_income`, `projected_expense`, `monthly_delta`, `closing_balance`, `locked_at`, `month_start`) deÄŸiÅŸtirilmesi veya dÃ¶nem satÄ±rÄ±nÄ±n silinmesi `ERRCODE = 'P0001'` (`period_locked`) ile reddedilir.
3. **8 Finansal Tabloda `enforce_closed_period_lock()` (`BEFORE INSERT OR UPDATE OR DELETE`):**
   - `payment_instances` (`due_date`, `instance_month`, `paid_at`), `payments` (`due_date`), `cashflow_lines` (`cashflow_month_id`, `date_value`), `invoices` (`issue_date`, `due_date`), `invoice_allocations` (`allocated_on`), `checks` (`maturity_date`), `loan_installments` (`due_date`, `paid_at`) ve `bank_transactions` (`txn_date`) Ã¼zerinde hem `OLD` hem `NEW` tarihleri denetlenir; etkilenen ay `cashflow_months` tablosunda `'locked'` ise `ERRCODE = 'P0001'` (`period_locked`) fÄ±rlatÄ±lÄ±r.
   - AÃ§Ä±k bir dÃ¶nemde yapÄ±lan tahsilat/Ã¶deme daÄŸÄ±tÄ±mÄ± (`invoice_allocations` â†’ `0048` `allocations_enforce_invoice_ceiling()`, `pg_trigger_depth() > 1`) geÃ§miÅŸ dÃ¶nemde dÃ¼zenlenmiÅŸ aÃ§Ä±k bir faturanÄ±n yalnÄ±z `allocated_amount` Ã¶nbelleÄŸini gÃ¼ncellediÄŸinde izin verilir; doÄŸrudan yapÄ±lan her tÃ¼rlÃ¼ fatura gÃ¼ncellemesi veya geÃ§miÅŸ dÃ¶neme tarihli daÄŸÄ±tÄ±m reddedilir.
4. **SarsÄ±lmaz `control_closed_period_mutations` (`WITH (security_invoker = true)`):** `cm.updated_at` yerine deÄŸiÅŸtirilemez `coalesce(cm.locked_at, cm.updated_at)` zaman damgasÄ±nÄ± Ã§Ä±pa alÄ±r ve `control_registry` kaydÄ± `'enforced_elsewhere'` olarak gÃ¼ncellenir.


## CanlÄ± Maker-Checker Onay DÃ¶ngÃ¼sÃ¼, Ã–deme Ã‡alÄ±ÅŸtÄ±rma Paketi (`payment_runs`) ve Banka Otomatik KapanÄ±ÅŸ BaÄŸlantÄ±larÄ± (Faz 48, migration 0101)

`0101_payment_runs_and_bank_settlement_links.sql` uÃ§tan uca **Fatura / Ã–deme / IBAN â†’ Maker-Checker OnayÄ± + BEC KalkanÄ± â†’ 14 GÃ¼nlÃ¼k Kasa TabanÄ± SimÃ¼lasyonlu Ã–deme Paketi (`payment_runs`) â†’ `pain.001` / 4 BÃ¼yÃ¼k TÃ¼rk BankasÄ± EFT Ä°hracÄ± â†’ Banka Hareketi EÅŸleÅŸtirme â†’ Otomatik KapanÄ±ÅŸ** zincirini veritabanÄ±nda gÃ¼vence altÄ±na alÄ±r:

1. **`approvals` ve `approval_rules` Kapsam GeniÅŸletmesi:** `approvals_subject_table_check` (`payments`, `payment_runs`, `budgets`, `budget_lines`, `forecast_lines`) ve `approvals_request_kind_check` / `approval_rules_trigger_kind_check` (`payment_run`, `budget`) yapÄ±sal `conkey` hedeflemesiyle geniÅŸletilir; `0054` iÃ§indeki 5 varsayÄ±lan kural satÄ±rÄ± deÄŸiÅŸtirilmeden korunur.
2. **CanlÄ± Onay, IBAN BEC DoÄŸrulama ve Banka KapanÄ±ÅŸ KolonlarÄ±:**
   - `invoices` ve `payment_instances`: `approval_status` (`not_required | pending_approval | approved | rejected`), `approval_id`, `approved_by`, `approved_at`.
   - `ibans` ve `parties`: `approval_status` (`pending_approval | approved | rejected`; mevcut kayÄ±tlar varsayÄ±lan `'approved'`), `approval_id` ve `ibans.verified_by` / `ibans.verified_at` (BEC dolandÄ±rÄ±cÄ±lÄ±k kalkanÄ±: `new_iban_requires_approval` tetiklendiÄŸinde yeni IBAN ikinci gÃ¶z onayÄ±na kadar `'pending_approval'` kalÄ±r ve EFT / `pain.001` ihracÄ±nda bloklanÄ±r).
   - `bank_transactions`: `settled_allocation_id`, `settled_at`, `settled_by` ve kÄ±smi B-tree indeksi (`idx_bank_transactions_settled_allocation`).
3. **`0048` Fatura DaÄŸÄ±tÄ±m TavanÄ± + Otomatik `paid_amount` / `status` KapanÄ±ÅŸÄ± ve `0100` AÃ§Ä±k DÃ¶nem TahsilatÄ± Uyumu:**
   - `allocations_enforce_invoice_ceiling()` artÄ±k `allocated_amount` Ã¶nbelleÄŸinin yanÄ± sÄ±ra `paid_amount` ve `status` (`open <-> partial <-> paid`) alanlarÄ±nÄ± da aynÄ± atomik tetikleyicide gÃ¼nceller (varsa `paid_amount > allocated_amount` fazla Ã¶deme farkÄ±nÄ± korur).
   - `enforce_closed_period_lock()` iÃ§indeki `pg_trigger_depth() > 1` dalÄ±, geÃ§miÅŸte kilitlenmiÅŸ bir ayda dÃ¼zenlenmiÅŸ aÃ§Ä±k faturanÄ±n aÃ§Ä±k bir dÃ¶nemde yapÄ±lan banka/tahsilat daÄŸÄ±tÄ±mÄ±yla `paid_amount` ve `status` kapanÄ±ÅŸÄ±na geÃ§mesine izin verirken faturanÄ±n ticari baÅŸlÄ±k alanlarÄ±nÄ± ve doÄŸrudan (`pg_trigger_depth() = 1`) gÃ¼ncellemeleri kilitlemeye devam eder.
4. **`public.payment_runs` ve `public.payment_run_items` TablolarÄ±:**
   - `payment_runs`: `run_code`, `planned_execution_date`, `source_bank_account_id` (`REFERENCES public.bank_accounts(cash_account_id) ON DELETE RESTRICT`), `currency`, `total_amount`, `item_count`, 14 gÃ¼nlÃ¼k kasa alt limiti simÃ¼lasyon alanlarÄ± (`pre_run_cash`, `projected_14d_min_cash`, `min_cash_floor`, `breaches_cash_floor`), durum makinesi (`draft -> pending_approval -> approved -> exported -> settled`, artÄ± `cancelled`; `payment_runs_status_transition_guard()`), veritabanÄ± seviyesinde `approved_by <> created_by` maker-checker kÄ±sÄ±tÄ± ve yalnÄ±z `approver+` rollerine aÃ§Ä±k `'approved'` geÃ§iÅŸ kapÄ±sÄ±.
   - `payment_run_items`: hedef kalem (`invoice | payment_instance | check | loan_installment`), alÄ±cÄ± cari/IBAN anlÄ±k gÃ¶rÃ¼ntÃ¼sÃ¼, `iban_verified`, `settled_bank_tx_id` ve aynÄ± aÃ§Ä±k yÃ¼kÃ¼mlÃ¼lÃ¼ÄŸÃ¼n aynÄ± anda iki aktif pakete girmesini engelleyen kÄ±smi benzersiz indeks (`payment_run_items_active_target_uq WHERE status = 'included'`).
   - 5-katmanlÄ± `operational` RLS politikalarÄ± ve `mas_radar_finance_approver` iÃ§in yalnÄ±z onay durumu kolonlarÄ±yla sÄ±nÄ±rlÄ± (`enforce_approver_subject_writeback_columns()`) dar Maker-Checker geri yazÄ±m politikalarÄ± tanÄ±mlanÄ±r.


## TÃ¼rkiye Ã‡ek/Senet Bordrosu YaÅŸam DÃ¶ngÃ¼sÃ¼ ve KarÅŸÄ±lÄ±ksÄ±z RÃ¼cu Riski (Faz 49, migration 0102)

`0102_turkish_check_bordro_lifecycle.sql` TÃ¼rkiye ticari finansmanÄ±ndaki mÃ¼ÅŸteri Ã§eki/senedi portfÃ¶yÃ¼, tedarikÃ§iye ciro, bankaya tahsile verme, kredi karÅŸÄ±lÄ±ÄŸÄ± bankaya teminata verme, keÅŸide Ã§ek ve karÅŸÄ±lÄ±ksÄ±z (`bounced`) rÃ¼cu riskini veritabanÄ±nda modeller:

1. **`public.check_bordros` Tablosu:**
   - `bordro_no` (`UNIQUE`), `bordro_type` (`customer_receipt | vendor_endorsement | bank_collection | bank_collateral | own_issue | settlement | bounce_return`), `bordro_date`, `target_party_id`, `target_bank_account_id` (`REFERENCES public.bank_accounts(cash_account_id)`), `target_facility_id` (`REFERENCES public.credit_facilities(id)`), `currency`, `total_amount` ve hedef alan tutarlÄ±lÄ±k kÄ±sÄ±tlarÄ± (`check_bordros_endorsement_party_required`, `check_bordros_collection_bank_required`, `check_bordros_collateral_facility_required`).
   - 5-katmanlÄ± `operational` RLS politikalarÄ± ve `0100` dÃ¶nem kilidine baÄŸlÄ± `check_bordros_closed_period_lock` tetikleyicisi.
2. **`public.checks` ve `public.check_events` Bordro GeniÅŸletmeleri:**
   - `checks`: `instrument_type` (`check | promissory_note`), `endorsed_to_party_id`, `collection_bank_account_id`, `collateral_facility_id`, `collateral_record_id`, `collateral_ltv_ratio`, `settled_invoice_id`, `last_bordro_id`.
   - `checks.status` CHECK kÄ±sÄ±tÄ± (`conkey` Ã¼zerinden) ve `checks_status_transition_guard()` eski `'planned'` durumuyla geriye uyumlu olarak `'in_portfolio'`, `'endorsed_to_vendor'`, `'in_bank_collection'`, `'in_bank_collateral'`, `'issued_to_vendor'`, `'cleared'`, `'bounced'`, `'returned'`, `'cancelled'`, `'unknown'` geÃ§iÅŸ matrisini eksiksiz kapsar; `check_events` tablosuna `bordro_id` yabancÄ± anahtarÄ± ve bordro olay tipleri eklenir.
3. **Likidite Ã‡ift SayÄ±m KalkanÄ± ve `check_portfolio_and_recourse_summary` (`WITH (security_invoker = true)`):**
   - `endorsed_to_vendor` durumundaki mÃ¼ÅŸteri Ã§eki tedarikÃ§i faturasÄ±nÄ± `invoice_allocations` Ã¼zerinden kapattÄ±ÄŸÄ± ve nakit kasaya girmeyeceÄŸi iÃ§in `liquidity_forecast_daily` ile `financial_calendar` gÃ¶rÃ¼nÃ¼mlerinden otomatik dÃ¼ÅŸer; `in_bank_collateral` durumundaki teminat Ã§ekleri kapsama dahil edilir.
   - `check_portfolio_and_recourse_summary` para birimi kÄ±rÄ±lÄ±mÄ±nda portfÃ¶y, tahsil, teminat (ve LTV borÃ§lanma deÄŸeri), keÅŸide borÃ§ Ã§ekleri, karÅŸÄ±lÄ±ksÄ±z Ã§ekler ve Ã§ek vadesinde `cleared` olana dek taÅŸÄ±nan ÅŸarta baÄŸlÄ± ciro rÃ¼cu riskini (`contingent_recourse_amount`) raporlar.


## Operasyonel DÃ¶ngÃ¼lerin KapatÄ±lmasÄ±, Kredi Hareketleri, Mutabakat Ä°mzalama ve Ãœretim V2 Tam Alan KalÄ±cÄ±lÄ±ÄŸÄ± (Faz 50, migration 0103)

`0103_close_operational_loops_and_reconciliation_signoffs.sql` arayÃ¼zÃ¼ mevcut olup veri giriÅŸi, maker-checker onayÄ± veya V2 ÅŸablon baÄŸlantÄ±sÄ± eksik kalan tÃ¼m modÃ¼lleri uÃ§tan uca kapatÄ±r ve zombi ÅŸema yapÄ±larÄ±nÄ± temizler:

1. **Rotatif Kredi KullanÄ±m / Geri Ã–deme / Limit Revizyonu (`public.facility_movements` & `credit_facilities.drawn_amount`):**
   - `credit_facilities` tablosuna negatif bakiye korumalÄ± `drawn_amount` kolonu eklenir ve mevcut `facility_drawdowns` verisinden geri doldurulur.
   - `facility_movements` (`operational` sÄ±nÄ±fÄ±; `drawdown | repayment | limit_revision`) `0100` sert dÃ¶nem kilidiyle (`facility_movements_closed_period_lock`) ve `AFTER INSERT` atomik senkronizasyon tetikleyicisiyle (`facility_movements_sync_facility`) donatÄ±lÄ±r: limit aÅŸÄ±mÄ±, negatif kullanÄ±m ve para birimi uyumsuzluÄŸu veritabanÄ±nda reddedilir; `credit_facility_utilization` gÃ¶rÃ¼nÃ¼mÃ¼ hem eski `facility_drawdowns` hem yeni `facility_movements` hareketlerini tek doÄŸruluk kaynaÄŸÄ±nda birleÅŸtirir.
2. **DÃ¶nem Mutabakat Ä°mzalama KanÄ±t Defteri (`public.reconciliation_signoffs`):**
   - `evidence` sÄ±nÄ±fÄ±nda salt-ekleme (`append-only` tetikleyicili) dÃ¶nem mutabakat imza tablosu (`period_month`, `scope` âˆˆ `bank_cash | ar_ap | workbook_source | trial_balance`, `status` âˆˆ `signed_clean | signed_with_exceptions`, `open_exception_count`, `notes`, `signed_by`, `signed_at`); `signed_clean` iÃ§in `open_exception_count = 0` ve `signed_with_exceptions` iÃ§in boÅŸ olmayan `notes` kÄ±sÄ±tÄ± zorunludur.
3. **Organizasyonel Boyutlar (`department_id`), Tahsilat SÃ¶zÃ¼, DokÃ¼man KasasÄ± ve Zombi GÃ¶rÃ¼nÃ¼m TemizliÄŸi:**
   - `invoices`, `invoice_lines` ve `payments` tablolarÄ±na `department_id` (ve `payments` Ã¼zerine `cost_center_id`, `project_id`) yabancÄ± anahtarlarÄ± ile kÄ±smi B-tree indeksleri eklenir; `budget_actuals_monthly`, `budget_vs_actual` (`0099` yÄ±llÄ±k 12-ay kuruÅŸ-tam daÄŸÄ±lÄ±mÄ± korunarak) ve `profitability_by_department` gÃ¶rÃ¼nÃ¼mleri departman etiketli faturalarÄ± Ã¶lÃ§er, veri yoksa `BLANK â‰  ZERO` disipliniyle `NULL` dÃ¶ndÃ¼rÃ¼r.
   - `promise_to_pay` Ã¼zerinde `invoice_id` indeksi ve `currency` ISO-4217 CHECK kÄ±sÄ±tÄ± kesinleÅŸtirilir; `documents.original_filename` eklenir ve `document_links.entity_table` CHECK listesi `check_bordros`, `credit_facilities`, `reconciliation_signoffs` ile geniÅŸletilir; `counterparty_unresolved` gÃ¶rÃ¼nÃ¼mÃ¼ne Ã§ek yÃ¶nÃ¼ (`direction`) eklenir.
   - Zombi `working_capital_trend_reference` gÃ¶rÃ¼nÃ¼mÃ¼ kaldÄ±rÄ±larak aylÄ±k AR/AP, DSO/DPO ve TRY banka nakit akÄ±ÅŸÄ±nÄ± birleÅŸtiren `working_capital_monthly_v` (`WITH (security_invoker = true)`) okuma modeliyle deÄŸiÅŸtirilir.
4. **Ãœretim Ekonomisi V2 Tam Alan KalÄ±cÄ±lÄ±ÄŸÄ± (`public.cost_model_items`, `production_parts`, `machine_assets`):**
   - `production_parts` ve `machine_assets` tablolarÄ±na V2 ÅŸablonundaki ek operasyon, fiyat, verimlilik ve aylÄ±k gelir/gider kolonlarÄ± eklenir; senaryo bazlÄ± maliyet kalemleri iÃ§in `public.cost_model_items` (`operational` sÄ±nÄ±fÄ±) oluÅŸturulur ve `import_external_keys.entity_table` CHECK kÄ±sÄ±tÄ± `cost_model_items` ile `credit_facilities` (`17_KREDI_LIMITLERI`) tablolarÄ±nÄ± kapsayacak ÅŸekilde geniÅŸletilir.


## ParaÅŸÃ¼t API v4 Kaynak SoykÃ¼tÃ¼ÄŸÃ¼, 10 Saplama OnarÄ±mÄ± ve Hibrit Banka TekilleÅŸtirmesi (Faz 51, migration 0104)

`0104_parasut_v4_lineage_and_hybrid_bank.sql` ParaÅŸÃ¼t API v4 (`https://api.parasut.com/v4/{company_id}/...`) Ã¼zerinden Ã§ekilen verilerin SHA-256 ham JSON kanÄ±tlarÄ±yla izlenmesini, `S-1..S-10` saplama kusurlarÄ±nÄ±n kapatÄ±lmasÄ±nÄ± ve MT940 / ISO 20022 `camt.053` / Excel banka hareketleriyle API hareketlerinin Ã§apraz-kanal tekilleÅŸtirilmesini saÄŸlar:

1. **API SoykÃ¼tÃ¼ÄŸÃ¼, Hesap EÅŸleme ve Cari Ä°nceleme TablolarÄ±:**
   - `public.integration_sync_runs` (`operational`): Senkron koÅŸu makbuzlarÄ± (`integration_id`, `started_at`, `finished_at`, `watermark_from`, `watermark_to`, `status`, `fetched_count`, `upserted_count`, `staged_party_count`, `error_summary`).
   - `public.integration_raw_payloads` (`evidence` â€” `append-only` tetikleyicili): Her Ã§ekilen API kaydÄ±nÄ±n `payload_sha256` ve `payload_json` kanÄ±t kasasÄ± (`UNIQUE (resource_type, external_id, payload_sha256)`).
   - `public.integration_entity_links` (`operational`): Harici `(provider, resource_type, external_id)` anahtarÄ±nÄ± kanonik `(entity_table, entity_id)` satÄ±rÄ±na ve son `last_payload_id` kanÄ±tÄ±na baÄŸlar.
   - `public.integration_account_mappings` (`operational`): Harici kasa/banka hesaplarÄ±nÄ± (`external_account_id`, `external_iban`, `external_currency`) MAS `cash_accounts` ve `bank_accounts` kayÄ±tlarÄ±yla eÅŸler.
   - `public.integration_staged_parties` (`operational`): Kanonik `public.parties` tablosunda bulunmayan yeni ParaÅŸÃ¼t carilerini (`S-10` kalkanÄ±) `status = 'pending'` ile bekletir; operatÃ¶r onayÄ±yla yalnÄ±z `createCounterparty` kapÄ±sÄ±ndan cari aÃ§Ä±lÄ±r veya mevcut cariye baÄŸlanÄ±r.
2. **`public.invoices` GeniÅŸletmeleri (`S-1`, `S-4`, `S-5`, `S-6`, `S-7`):**
   - SatÄ±rsÄ±z basit gider fiÅŸlerinde (`BLANK â‰  ZERO`) `net_amount` ve `tax_amount` kolonlarÄ±nÄ±n birlikte `NULL` kalabilmesi iÃ§in `invoices_gross_is_net_plus_tax` kÄ±sÄ±tÄ± `((net_amount IS NULL AND tax_amount IS NULL) OR (net_amount IS NOT NULL AND tax_amount IS NOT NULL AND gross_amount = net_amount + tax_amount))` olarak gÃ¼ncellenir.
   - `withholding_amount`, `vat_withholding_amount`, `payable_amount`, `external_status`, `external_key`, `spender_employee_name` kolonlarÄ± ve `invoices_external_key_uq` (`WHERE external_key IS NOT NULL`) benzersiz indeksi eklenir; `invoices_content_immutability_guard()` dÃ¼zenlenmiÅŸ faturalarda (`old.status <> 'draft'`) yeni ticari tutar kolonlarÄ±nÄ± da dondurur.
   - `liquidity_forecast_daily` ve `financial_calendar` gÃ¶rÃ¼nÃ¼mleri (`WITH (security_invoker = true)`) aÃ§Ä±k fatura nakit projeksiyonunda `coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0))` formÃ¼lÃ¼nÃ¼ kullanÄ±r.
3. **`public.bank_transactions` GeniÅŸletmeleri (`S-8`, `S-9`, Ã‡apraz-Kanal TekilleÅŸtirme):**
   - `transaction_kind` (`standard | own_transfer | bank_fee | tax_payment | payroll`) ve `cross_channel_dedupe_hash` (`idx_bank_transactions_cross_channel`) eklenir.
   - `daily_cash_movement` ve `working_capital_monthly_v` gÃ¶rÃ¼nÃ¼mleri (`WITH (security_invoker = true)`) kendi hesaplarÄ±mÄ±z arasÄ± virmanlarÄ± (`transaction_kind = 'own_transfer'`) konsolide ÅŸirket nakit giriÅŸ/Ã§Ä±kÄ±ÅŸ toplamlarÄ±ndan dÃ¼ÅŸerken hesap bazlÄ± `bank_cash_position` bakiyelerini tam korur.


## Ã‡ift TaraflÄ± YÃ¶netim Defteri, TDHP Hesap PlanÄ±, `DEFERRABLE` Denge BekÃ§isi ve YÃ¶netim EBITDA (Faz 52, migration 0105)

`0105_double_entry_management_ledger.sql` MAS Nakit Radar iÃ§inde **TekdÃ¼zen Hesap PlanÄ± (TDHP)** uyumlu, veritabanÄ± seviyesinde borÃ§ = alacak (`sum(debit_try) = sum(credit_try)`) dengesi zorunlu ve kesinleÅŸmiÅŸ (`posted`) fiÅŸleri deÄŸiÅŸmez (`immutable` + ters kayÄ±tlÄ±) Ã§ift taraflÄ± yÃ¶netim defterini kurar:

1. **TDHP YÃ¶netim Hesap PlanÄ± (`public.management_accounts` â€” `reference` sÄ±nÄ±fÄ±):**
   - `code` (`UNIQUE`), `name`, `parent_code`, `account_class` (`asset | liability | equity | revenue | contra_revenue | cogs | opex | finance_expense | other_income_expense | off_balance`), `normal_side` (`debit | credit`), `ebitda_bucket` (`revenue | cogs | opex | da_addback | financing | tax | non_operating | balance_sheet`), `tdhp_root_code`, `is_active`.
   - `100 Kasa`, `101 AlÄ±nan Ã‡ekler` (`101.01 PortfÃ¶y`, `101.02 Tahsil`, `101.03 Teminat`), `102 Bankalar`, `103 Verilen Ã‡ekler (-)` , `120 AlÄ±cÄ±lar`, `191 Ä°ndirilecek KDV`, `193 PeÅŸin Ã–denen Vergiler`, `253 Tesis/Makine`, `257 BirikmiÅŸ Amortismanlar (-)`, `300 Banka Kredileri`, `320 SatÄ±cÄ±lar`, `335 Personele BorÃ§lar`, `360 Ã–denecek Vergi`, `361 Ã–denecek SGK`, `391 Hesaplanan KDV`, `400 Uzun Vadeli Krediler`, `500 Sermaye`, `590/591 DÃ¶nem Net KÃ¢rÄ±/ZararÄ±`, `600â€“691` gelir tablosu hesaplarÄ±, `730/770/770.99 (Amortisman D&A)/780 (Finansman)` ve `900/901` ciro rÃ¼cu riski nazÄ±m hesaplarÄ±yla tohumlanÄ±r.
2. **Yevmiye FiÅŸleri ve SatÄ±rlarÄ± (`public.management_journal_entries`, `public.management_journal_lines` â€” `operational` sÄ±nÄ±fÄ±):**
   - `management_journal_entries`: `entry_no` (`IDENTITY`), `entry_date`, `period_month` (`STORED`), `source_type` (`invoice | bank_transaction | check_bordro | loan_installment | payment_instance | manual_adjustment | fx_revaluation | reversal`), `source_id`, `idempotency_key` (`UNIQUE`), `status` (`draft | provisional_fx | posted | reversed`), `needs_tax_split_review`, `reversal_of_entry_id`, `reversed_by_entry_id`, `approved_by`, `approved_at`, `created_by`.
   - `management_journal_lines`: `entry_id`, `line_no`, `account_id`, boyut yabancÄ± anahtarlarÄ± (`party_id`, `project_id`, `cost_center_id`, `department_id`), `native_currency`, `debit_native`, `credit_native`, `fx_rate`, `debit_try`, `credit_try` ve tek yÃ¶nlÃ¼ bakiye (`management_journal_lines_single_sided`) kÄ±sÄ±tlarÄ±.
3. **VeritabanÄ± Garantileri (`DEFERRABLE` Denge BekÃ§isi, DeÄŸiÅŸmezlik ve `0100` DÃ¶nem Kilidi):**
   - `assert_management_journal_balanced()` (`DEFERRABLE INITIALLY DEFERRED` constraint trigger): `'posted'` ve `'reversed'` fiÅŸlerde satÄ±r sayÄ±sÄ± `< 2`, `debit_try IS NULL OR credit_try IS NULL` veya `sum(debit_try) <> sum(credit_try)` olduÄŸunda `COMMIT` anÄ±nda `ERRCODE = '23514'` (`unbalanced_management_journal_entry`) fÄ±rlatÄ±r.
   - `enforce_management_journal_entry_immutability()` ve `enforce_management_journal_line_immutability()`: KesinleÅŸmiÅŸ (`posted`) fiÅŸlerin ve satÄ±rlarÄ±nÄ±n silinmesini veya doÄŸrudan deÄŸiÅŸtirilmesini reddeder; yalnÄ±z ters kayÄ±t (`reverseManagementEntry` â†’ `status = 'reversed'` ve `reversed_by_entry_id`) geÃ§iÅŸine izin verir.
   - `enforce_closed_period_lock()` (`0100`): Kilitli (`status = 'locked'`) finansal aylara `entry_date` ile yÃ¶netim fiÅŸi eklenmesini veya deÄŸiÅŸtirilmesini `period_locked` (`P0001`) ile engeller.
4. **CanlÄ± YÃ¶netim MizanÄ±, Gelir Tablosu / EBITDA ve Dinamik BilanÃ§o GÃ¶rÃ¼nÃ¼mleri (`WITH (security_invoker = true)`):**
   - `public.management_trial_balance_v`: Her aktif TDHP hesabÄ± iÃ§in `debit_total_try`, `credit_total_try`, `debit_balance_try`, `credit_balance_try` ve `net_balance_try`.
   - `public.management_income_statement_v`: `Net SatÄ±ÅŸlar â†’ BrÃ¼t KÃ¢r â†’ Faaliyet Giderleri â†’ Faaliyet KÃ¢rÄ± (EBIT) + Amortisman (770.99 D&A) = YÃ¶netim EBITDA â†’ Finansman Giderleri (780) â†’ Vergi Ã–ncesi YÃ¶netim KÃ¢rÄ± (690) â†’ DÃ¶nem Net KÃ¢rÄ±` ÅŸelalesi.
   - `public.management_balance_sheet_v`: Cari dÃ¶nem net kÃ¢r/zararÄ±nÄ± dinamik olarak `590.DYN` / `591.DYN` Ã¶zkaynak satÄ±rÄ±na yansÄ±tarak her tarihte `Aktif ToplamÄ± = Pasif (YabancÄ± Kaynak + Ã–zkaynak) ToplamÄ±` kuruÅŸ eÅŸitliÄŸini korur.


## Mali MÃ¼ÅŸavir Yasal Mizan Ä°Ã§e AktarÄ±mÄ± ve 12 KÃ¶k Nedenli YÃ¶netim â†” Yasal Mizan Mutabakat KÃ¶prÃ¼sÃ¼ (Faz 53, migration 0106)

`0106_statutory_trial_balance_reconciliation.sql` Luca, Logo, Mikro, Zirve, Eta ve ParaÅŸÃ¼t standart yasal mizanlarÄ±nÄ±n (`.xlsx`, `.csv`, `.xml`) Ã§ift sayÄ±m korumalÄ± (`is_leaf`) olarak iÃ§eri aktarÄ±lmasÄ±nÄ± ve Faz 52 MAS YÃ¶netim Defteri MizanÄ± ile 12 deterministik kÃ¶k nedene gÃ¶re kuruÅŸu kuruÅŸuna karÅŸÄ±laÅŸtÄ±rÄ±lmasÄ±nÄ± saÄŸlar:

1. **Yasal Mizan BaÅŸlÄ±k ve SatÄ±r TablolarÄ± (`public.statutory_trial_balances`, `public.statutory_trial_balance_lines` â€” `operational` sÄ±nÄ±fÄ±):**
   - `statutory_trial_balances`: `as_of_date`, `period_label`, `source_software`, `original_filename`, `file_sha256`, `total_debit_try`, `total_credit_try`, `is_self_balanced` (`GENERATED ALWAYS AS (total_debit_try = total_credit_try) STORED`), `imported_by`, `imported_at`.
   - `statutory_trial_balance_lines`: `trial_balance_id` (`ON DELETE CASCADE`), `account_code`, `tdhp_root_code` (`100`..`999`), `account_name`, `is_leaf` (`boolean`), `debit_total_try`, `credit_total_try`, `debit_balance_try`, `credit_balance_try` ve `UNIQUE (trial_balance_id, account_code)`.
   - HiyerarÅŸik mizanlarda (`120` + `120.01` + `120.01.005`) alt hesabÄ± bulunan Ã¼st satÄ±rlar `is_leaf = false` iÅŸaretlenir; mizan toplamlarÄ± ve mutabakat karÅŸÄ±laÅŸtÄ±rmalarÄ± **yalnÄ±z `is_leaf = true` yaprak satÄ±rlardan** hesaplanÄ±r.
2. **Mutabakat KoÅŸularÄ± ve 12 KÃ¶k Nedenli Fark Kalemleri (`public.trial_balance_reconciliation_runs`, `public.trial_balance_reconciliation_items` â€” `operational` sÄ±nÄ±fÄ±):**
   - `trial_balance_reconciliation_runs`: YÃ¶netim ve yasal mizan borÃ§/alacak toplamlarÄ±, `management_ebitda_try`, `statutory_690_ebt_try`, `ebitda_to_690_bridge_json` (YÃ¶netim EBITDA â†’ Amortisman `770.99` â†’ EBIT â†’ Finansman `780` â†’ YÃ¶netim `690` â†’ Gelir/Gider dÃ¶nemsellik farklarÄ± â†’ Yasal `690`), `matched_group_count`, `discrepancy_group_count`.
   - `trial_balance_reconciliation_items`: Her TDHP kÃ¶k grubu (`100`, `101`, `102`, `103`, `120`, `131/331`, `190/191/391`, `300/400`, `320`, `335`, `360/361`, `EBITDA_690`) iÃ§in `management_net_try`, `statutory_net_try`, `delta_try`, 12 kÃ¶k neden kodu (`CASH_100_INFLATION`, `CHECK_ENDORSEMENT_OR_CLEARING_LAG`, `UNBOOKED_BANK_TXN_OR_FX`, `ISSUED_CHECK_NOT_DELIVERED_TO_CPA`, `CUTOFF_UNBILLED_OR_UNALLOCATED_CASH`, `PARTNER_ACCOUNT_PLUG`, `VAT_TAHAKKUK_UNCLOSED`, `LOAN_PRINCIPAL_VS_GROSS_INSTALLMENT`, `MISSING_PURCHASE_INVOICE`, `PAYROLL_ADVANCE_OR_EXPENSE_GAP`, `UNPAID_OR_RESTRUCTURED_TAX_DEBT`, `MANAGEMENT_EBITDA_TO_STATUTORY_690_BRIDGE`), `severity` (`match | info | warning | critical`), `candidate_evidence_json` ve `action_item_id`.
   - **DeÄŸiÅŸmez Kural:** HiÃ§bir yÃ¶netim fiÅŸini veya yasal mizan satÄ±rÄ±nÄ± otomatik deÄŸiÅŸtirmez (*bayrakla, asla sessiz dÃ¼zeltme*).


## Otomatik Beslenen 13 HaftalÄ±k DoÄŸrudan Nakit Tahmini ve DondurulmuÅŸ Varyans Åelalesi (Faz 54, migration 0107)

`0107_forecast_13w_snapshots_and_variance.sql` her Pazartesi dondurulan 13 haftalÄ±k doÄŸrudan nakit tahmini baz Ã§izgisini (`forecast_snapshots_13w`) ve belge bazlÄ± kaynak satÄ±rlarÄ±nÄ± (`forecast_snapshot_13w_lines`) saklayarak gerÃ§ekleÅŸen banka hareketleriyle **Zamanlama KaymasÄ± (`Timing Slip`)** vs. **KalÄ±cÄ± Sapma (`Permanent Variance`)** ÅŸelale analizini mÃ¼mkÃ¼n kÄ±lar:

1. **HaftalÄ±k Tahmin AnlÄ±k GÃ¶rÃ¼ntÃ¼leri (`public.forecast_snapshots_13w`, `public.forecast_snapshot_13w_lines` â€” `operational` sÄ±nÄ±fÄ±):**
   - `forecast_snapshots_13w`: `snapshot_week_start`, `as_of_date`, `currency` (`ISO-4217`), `opening_cash` (`FIN-03` uyumlu `NULL` veya sayÄ±), `unknown_opening_count`, `frozen_by`, `frozen_at`, `UNIQUE (snapshot_week_start, currency)`.
   - `forecast_snapshot_13w_lines`: `snapshot_id` (`ON DELETE CASCADE`), `week_index` (`1..13`), `week_start`, `direction` (`inflow | outflow`), `category_bucket` (`contracted_ar | behavioral_ar | scheduled_payment | open_ap | check_maturity | loan_installment | statutory_tax_sgk | manual_override`), `source_classification` (`promised | behavioral_dbt | scheduled | statutory_tax | manual_override`), `source_entity_table`, `source_entity_id`, `party_id`, `label`, `amount`.
2. **Tahmin vs. GerÃ§ekleÅŸen Varyans Ã–zeti GÃ¶rÃ¼nÃ¼mÃ¼ (`public.forecast_13w_variance_v` â€” `WITH (security_invoker = true)`):**
   - Her dondurulmuÅŸ hafta iÃ§in `forecast_inflow`, `forecast_outflow`, `forecast_net` toplamlarÄ±nÄ±, kendi hesaplarÄ±mÄ±z arasÄ± virmanlar (`transaction_kind = 'own_transfer'`) ve yoksayÄ±lan hareketler (`status = 'ignored'`) hariÃ§ gerÃ§ekleÅŸen `bank_transactions` (`actual_inflow`, `actual_outflow`, `actual_net`) ile karÅŸÄ±laÅŸtÄ±rÄ±r.
3. **YabancÄ± Anahtar (FK) Ä°ndeks Hijyeni (`Faz 56 / F3`):**
   - `checks`, `check_bordros`, `check_events`, `payment_runs`, `payment_run_items`, `import_external_keys`, `payments`, `loans`, `covenant_records` ve `facility_drawdowns` Ã¼zerindeki 20 yabancÄ± anahtar kolonu kÄ±smi/Ã¶ncÃ¼l B-tree indeksleriyle Ã¶rtÃ¼lerek `perf-gate` indekssiz FK cÄ±rcÄ±rÄ± (`113 <= 115`) ve `redundantIndexes = 0` garantisi korunur.


## Arka Plan Ä°ÅŸ Sonucu AyrÄ±mÄ± ve Zarf DeÄŸiÅŸmezlik BekÃ§isi (Faz 57, migration 0108)

`0108_background_jobs_result_and_immutability.sql` Wave 0 / S5 sÄ±rasÄ±nda geÃ§ici olarak `payload->'result'` altÄ±nda tutulan iÅŸ Ã§Ä±ktÄ±sÄ±nÄ± ayrÄ± `result jsonb` kolonuna taÅŸÄ±r ve iÅŸ zarfÄ±nÄ± veritabanÄ± seviyesinde kilitler:

1. **AyrÄ± `public.background_jobs.result` (`jsonb`) Kolonu ve Ä°dempotent TaÅŸÄ±ma:**
   - `background_jobs` tablosuna `result jsonb` eklenir; mevcut satÄ±rlarda `payload ? 'result'` olan Ã§Ä±ktÄ±lar tetikleyici kurulmadan Ã¶nce `result` kolonuna taÅŸÄ±nÄ±r ve `payload` iÃ§inden `'result'` anahtarÄ± temizlenir (`payload - 'result'`).
   - `completeJob` artÄ±k `payload` kolonuna dokunmadan doÄŸrudan `result = $2::jsonb` yazar; `listJobs` hafif kalmak iÃ§in `result` kolonunu okuma listesinden dÄ±ÅŸlar.
2. **Zarf DeÄŸiÅŸmezlik BekÃ§isi (`public.enforce_background_jobs_immutable_envelope` â€” `BEFORE UPDATE`):**
   - Ã‡aÄŸÄ±ranÄ±n kendi RLS katmanÄ±nda (`prosecdef = false`) Ã§alÄ±ÅŸan tetikleyici, `INSERT` sonrasÄ±nda `id`, `job_type`, `created_by`, `payload`, `dedupe_key` veya `created_at` kolonlarÄ±ndan herhangi birinin deÄŸiÅŸtirilmesini `ERRCODE = '23514'` (`background_jobs_envelope_immutable`) ile reddeder.
   - `background_job_queue_health` (`0081`) ve `integration_health` (`0086`) gÃ¶rÃ¼nÃ¼mlerinin `WITH (security_invoker = true)` kalkanÄ± migration sonundaki `$verify$` bloÄŸuyla doÄŸrulanÄ±r.


## KontrollÃ¼ ArÅŸivden Ã‡Ä±karma GUC Kilidi ve Tek-OperatÃ¶r 4-GÃ¶z Ä°stisna YÃ¶netiÅŸimi (Faz 59, migration 0109)

`0109_controlled_archive_restore_and_single_operator_policy.sql` yanlÄ±ÅŸlÄ±kla arÅŸivlenen finansal kayÄ±tlarÄ±n denetimli geri alÄ±nmasÄ±nÄ± (`F-54`) ve tek-operatÃ¶r/CFO iÅŸ istasyonunda maker-checker kilitlenmesini Ã¶nleyen ÅŸeffaf istisna politikasÄ±nÄ± (`F-38`) kurar:

1. **KontrollÃ¼ ArÅŸivden Ã‡Ä±karma (`public.enforce_archive_monotonic` gÃ¼ncellemesi):**
   - VarsayÄ±lan olarak arÅŸivlenmiÅŸ satÄ±rlarda (`payments`, `cashflow_lines`, `checks`, `loans`, `parties`, `categories`, `cash_accounts`) rastgele `UPDATE` yine `ERRCODE = 'P0001'` ile reddedilir.
   - YalnÄ±z aynÄ± veritabanÄ± iÅŸlemi iÃ§inde `SET LOCAL app.allow_archive_restore = 'true'` ayarlandÄ±ÄŸÄ±nda ve tÃ¼m arÅŸiv kolonlarÄ± (`archived_at`, `archive_reason`, `archived_by_label` ve varsa `status = 'active'`) birlikte temizlendiÄŸinde geÃ§iÅŸe izin verilir; uygulama katmanÄ± (`restoreArchivedEntity`) dÃ¶nem kilidini denetler ve zorunlu gerekÃ§eyle `audit_logs` (`restore_archived`) satÄ±rÄ± yazar.
2. **Tek-OperatÃ¶r 4-GÃ¶z YÃ¶netiÅŸimi (`public.approval_actions` & `public.approval_policies`):**
   - `approval_actions.decision` CHECK kÄ±sÄ±tÄ± `'approved' | 'rejected' | 'cancelled' | 'self_approved_override'` deÄŸerlerini kapsayacak ÅŸekilde geniÅŸletilir ve en az 12 karakterlik `self_approval_justification` zorunluluÄŸu (`approval_actions_self_override_justification_chk`) eklenir.
   - `settings` tablosuna varsayÄ±lan `false` olan `allow_single_operator_self_approval` anahtarÄ± tohumlanÄ±r; Ã§ok kullanÄ±cÄ±lÄ± modda sÄ±kÄ± `approver_id <> requested_by` 4-gÃ¶z kuralÄ± korunurken, tek-operatÃ¶r modunda yalnÄ±z aÃ§Ä±k politika ve gerekÃ§eyle `self_approved_override` kararÄ±na izin verilir.


## Durum Makinesi Kilit AÃ§ma (`untrap`) ve Likidite Ã–deme SÃ¶zÃ¼ TekilleÅŸtirmesi (Faz 59, migration 0110)

`0110_state_machine_untrap_and_forecast_fixes.sql` operasyonel durum makinelerindeki geri dÃ¶nÃ¼ÅŸ kilitlerini (`F-49`, `F-50`) aÃ§ar ve 13-hafta / gÃ¼nlÃ¼k likidite gÃ¶rÃ¼nÃ¼mÃ¼ndeki Ã¶deme sÃ¶zÃ¼ Ã§ift sayÄ±mÄ±nÄ± (`F-27`) temizler:

1. **Ã–deme Paketi ve DÃ¶nem Kilidi Geri DÃ¶nÃ¼ÅŸleri:**
   - `enforce_payment_run_transition()` gÃ¼ncellenerek henÃ¼z dÄ±ÅŸa aktarÄ±lmamÄ±ÅŸ `'approved'` Ã¶deme paketlerinin `'cancelled'` durumuna Ã§ekilebilmesine izin verilir (`exported` ve `settled` paketler kilitli kalÄ±r).
   - `cashflow_months` tablosunda yÃ¶netici onaylÄ± dÃ¶nem kilidi aÃ§ma (`locked -> reviewed`) denetim iziyle desteklenir.
2. **`public.liquidity_forecast_daily` Ã–deme SÃ¶zÃ¼ (`promised_payments`) TekilleÅŸtirmesi:**
   - AÃ§Ä±k bir satÄ±ÅŸ faturasÄ±na baÄŸlÄ± aktif Ã¶deme sÃ¶zÃ¼ (`promised_payments.status = 'open'`, `invoice_id IS NOT NULL`) bulunduÄŸunda nakit giriÅŸi Ã¶deme sÃ¶zÃ¼ vadesinde zaten sayÄ±ldÄ±ÄŸÄ± iÃ§in aynÄ± tutar fatura vadesinde ikinci kez sayÄ±lmaz (`WITH (security_invoker = true)` korunur).


## TDHP `500.99` AÃ§Ä±lÄ±ÅŸ BilanÃ§osu DenkleÅŸtirme HesabÄ± ve `FIN-03` Kasa/Banka AÃ§Ä±lÄ±ÅŸ KÃ¶prÃ¼sÃ¼ (Faz 59, migration 0111)

`0111_cfo_views_and_opening_equity_bridge.sql` hazine kasa/banka aÃ§Ä±lÄ±ÅŸ bakiyelerini (`FIN-03`) Ã§ift taraflÄ± TDHP YÃ¶netim Defteriyle birleÅŸtirir (`F-16`, `F-45`):

1. **TDHP `500.99` HesabÄ± ve `opening_balance` Yevmiye Kaynak Tipi:**
   - `public.management_accounts` tablosuna `'500.99'` (`AÃ§Ä±lÄ±ÅŸ BilanÃ§osu DenkleÅŸtirme HesabÄ±`, `parent_code = '500'`, `account_class = 'equity'`, `normal_side = 'credit'`, `ebitda_bucket = 'balance_sheet'`) tohumlanÄ±r.
   - `public.management_journal_entries.source_type` CHECK kÄ±sÄ±tÄ±na `'opening_balance'` eklenir.
2. **`public.cash_accounts` GeniÅŸletmeleri:**
   - `opening_balance_date date NOT NULL DEFAULT current_date` ve `opening_journal_entry_id uuid REFERENCES public.management_journal_entries(id) ON DELETE SET NULL` (+ kÄ±smi B-tree indeks `idx_cash_accounts_opening_journal_entry_id`) eklenir.


## KullanÄ±lmayan Eski ("Zombie") TablolarÄ±n Veri KayÄ±psÄ±z EmekliliÄŸi (Faz 59, migration 0112)

`0112_retire_legacy_zombie_tables.sql` yeni okuma modelleri ve hareket tablolarÄ±yla deÄŸiÅŸtirilmiÅŸ olan Ã¼Ã§ eski ÅŸema nesnesini (`F-36`) sÄ±fÄ±r veri kaybÄ±yla emekliye ayÄ±rÄ±r:

1. **`public.facility_drawdowns` â†’ `public.facility_movements` GÃ¶Ã§Ã¼ ve EmekliliÄŸi:**
   - Varsa `facility_drawdowns` iÃ§indeki tÃ¼m satÄ±rlar idempotent biÃ§imde `facility_movements` tablosuna aktarÄ±lÄ±r; `credit_facility_utilization` gÃ¶rÃ¼nÃ¼mÃ¼ (`WITH (security_invoker = true)`) yalnÄ±z kanonik `facility_movements` kaynaÄŸÄ±nÄ± okuyacak ÅŸekilde yenilenir ve ardÄ±ndan `facility_drawdowns` dÃ¼ÅŸÃ¼rÃ¼lÃ¼r.
2. **`public.working_capital_trend_reference` ve `public.forecast_accuracy_log` EmekliliÄŸi:**
   - Yerlerini `working_capital_monthly_v` (`0103`) ve `forecast_13w_variance_v` (`0107`) gÃ¶rÃ¼nÃ¼mlerine bÄ±rakan `working_capital_trend_reference` ve `forecast_accuracy_log` tablolarÄ± kaldÄ±rÄ±lÄ±r; kanonik katalog **`106` `public` tablo** ve **`87` `public` gÃ¶rÃ¼nÃ¼m** olarak netleÅŸir.


## `liquidity_forecast_daily` Ã‡ek ve Ã–deme TahsisatÄ± (`invoice_allocations`) Tam TekilleÅŸtirmesi (Faz 59, migration 0113)

`0113_forecast_check_allocation_dedup_guard.sql` `0110` gÃ¶rÃ¼nÃ¼m yenilemesi sÄ±rasÄ±nda daralan `invoice_allocations` alt sorgusunu geri kazandÄ±rarak hem Ã¶deme sÃ¶zlerini (`promised_payments`) hem de Ã§ek/Ã¶deme tahsisatlarÄ±nÄ± (`invoice_allocations` iÃ§inde `source_type IN ('check', 'payment_instance')`) aÃ§Ä±k fatura bakiyesinden birlikte dÃ¼ÅŸer:

- AÃ§Ä±k fatura nakit akÄ±ÅŸÄ± katkÄ±sÄ±: `greatest(0, coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)) - coalesce(ca.non_cash_alloc, 0) - coalesce(pp.promised_open, 0))`.
- GÃ¶rÃ¼nÃ¼m `WITH (security_invoker = true)` ve salt-okunur yetki kalkanÄ±yla (`REVOKE INSERT, UPDATE, DELETE, TRUNCATE`) korunur; `$verify$` bloÄŸu `reloptions` iÃ§inde `security_invoker=true` varlÄ±ÄŸÄ±nÄ± zorunlu doÄŸrular.


## Admin Tek-OperatÃ¶r Ã–z-Onay RLS HizalamasÄ± ve Banka EÅŸleÅŸtirmesi Geri Alma (`unmatch`) GeÃ§iÅŸ KorumalarÄ± (Faz 59, migration 0114)

`0114_approvals_admin_single_operator_rls.sql` tek-operatÃ¶r onay yÃ¶netiÅŸiminin RLS katmanÄ±nÄ± (`F-46`) ve banka eÅŸleÅŸtirmesi geri alma (`unmatchTransaction` â€” `F-56`) durum geÃ§iÅŸlerini hizalar:

1. **`public.approvals` Ã¼zerinde `approvals_decide_admin_single_operator` RLS PolitikasÄ±:**
   - `mas_radar_finance_approver` ve `mas_radar_finance_manager` katmanlarÄ±nda sÄ±kÄ± `requested_by IS DISTINCT FROM current_app_user()` 4-gÃ¶z kuralÄ± korunurken, `mas_radar_admin` rolÃ¼ne yalnÄ±z `public.approval_governance_settings.allow_single_operator_self_approval = true` ve `self_approved_override = true` koÅŸuluyla karar gÃ¼ncelleme izni verilir.
2. **Ã–deme Paketi ve Ã‡ek Geri Alma Durum GeÃ§iÅŸleri (`F-56`):**
   - `payment_run_items_status_transition_guard()` iÃ§ine `('settled', 'included')`, `payment_runs_status_transition_guard()` iÃ§ine `('settled', 'exported')` ve `('settled', 'approved')` geÃ§iÅŸleri eklenir (`settled -> approved` geri dÃ¶nÃ¼ÅŸÃ¼nde rol kÄ±sÄ±tÄ± korunur).
   - `checks_status_transition_guard()` iÃ§ine banka eÅŸleÅŸtirmesiyle kapanan Ã§eklerin geri alÄ±nabilmesi iÃ§in `('cleared', 'in_portfolio')`, `('cleared', 'in_bank_collection')` ve `('cleared', 'issued_to_vendor')` geÃ§iÅŸleri eklenir.


## HatÄ±rlatÄ±cÄ± GÃ¶nderim KuyruÄŸu (`public.reminder_deliveries`) Operasyonel RLS HizalamasÄ± (Faz 59, migration 0115)

`0115_reminder_deliveries_operational_rls.sql` hatÄ±rlatÄ±cÄ± gÃ¶nderim kuyruÄŸunun yaÅŸam dÃ¶ngÃ¼sÃ¼ (`pending -> sent | skipped | failed`) iÃ§in RLS sÄ±nÄ±fÄ±nÄ± dÃ¼zeltir (`F-52`, `F-69`):

- `0058` iÃ§inde yanlÄ±ÅŸlÄ±kla salt-eklenir `evidence` sÄ±nÄ±fÄ±na konulan `public.reminder_deliveries` tablosu, `dispatchPending()` fonksiyonunun durum ve zaman damgasÄ± (`status`, `sent_at`, `error`) gÃ¼ncelleyebilmesi iÃ§in Ã¼st tablosu `public.reminders` ile uyumlu biÃ§imde `operational` RLS sÄ±nÄ±fÄ±na (`reminder_deliveries_insert_enter`, `reminder_deliveries_update_enter`, `reminder_deliveries_delete_manage`) geÃ§irilir.



## Grup Ä°Ã§i Ã‡oklu TÃ¼zel KiÅŸilik (`legal_entities` / `branches`) ve BaÄŸÄ±msÄ±z Muhasebe DÃ¶nem Otoritesi (Faz 60, migration 0116)

`0116_group_entities_and_period_authority.sql` grup iÃ§i holding/Ã§oklu ÅŸirket mimarisini ve Excel `cashflow_months` tablosundan baÄŸÄ±msÄ±z dÃ¶nem kilidi otoritesini kurar:

1. **Grup Ä°Ã§i TÃ¼zel KiÅŸilikler ve Åubeler (`public.legal_entities`, `public.branches` â€” `reference` sÄ±nÄ±fÄ±):**
   - VKN (`tax_id_vkn`), Mersis (`mersis_no`), vergi dairesi ve baz dÃ¶viz (`base_currency`) alanlarÄ±yla birden fazla tÃ¼zel kiÅŸilik ve ÅŸube tanÄ±mlanÄ±r; iÅŸlem-yerel `current_legal_entity_id()` GUC fonksiyonu aktif ÅŸirket baÄŸlamÄ±nÄ± taÅŸÄ±r.
   - Ã‡ekirdek operasyonel tablolara (`cash_accounts`, `payments`, `invoices`, `checks`, `loans`, `credit_facilities`, `management_journal_entries`, `budgets`, `cost_centers`, `projects`) geriye dÃ¶nÃ¼k uyumlu `legal_entity_id` ve `branch_id` yabancÄ± anahtarlarÄ± + kÄ±smi indeksler eklenir.
2. **BaÄŸÄ±msÄ±z DÃ¶nem Kilidi Otoritesi (`public.accounting_periods` â€” `operational` sÄ±nÄ±fÄ±):**
   - `enforce_accounting_period_lock_transition()` tetikleyicisi ile `open -> reviewed -> locked` ve gerekÃ§eli `locked -> reviewed` geÃ§iÅŸlerini yÃ¶netir; `assert_date_not_in_locked_period()` fonksiyonu hem `cashflow_months` hem `accounting_periods` kilitlerini denetler.


## Hazine POS/Kart/Vadeli/Virman, Vergi Tahakkuku, Ã‡ek/Senet (`121/321`), Kredi Amortisman ve CanlÄ± DÃ¶viz GÃ¶rÃ¼nÃ¼mÃ¼ (Faz 60, migration 0117)

`0117_treasury_tax_checks_loans_and_ledger_closure.sql` hazine, finansman, TDHP hesap planÄ± ve KDV hariÃ§ bÃ¼tÃ§e/kÃ¢rlÄ±lÄ±k gÃ¶rÃ¼nÃ¼mlerini tamamlar:

1. **TDHP Hesap PlanÄ± ve Yevmiye Kaynak TÃ¼rleri:**
   - `102.05`, `102.99`, `108`, `121`, `128`, `129`, `150`, `151`, `152`, `253`, `257`, `301`, `302`, `309`, `321`, `654`, `910`, `911` hesaplarÄ± tohumlanÄ±r; `management_journal_entries.source_type` kÄ±sÄ±tÄ± kredi aÃ§Ä±lÄ±ÅŸÄ±, limit hareketi, virman, cari mahsup, ÅŸÃ¼pheli karÅŸÄ±lÄ±k, dÃ¶nem kapanÄ±ÅŸÄ±, bordro/vergi ve Ã¼retim hareketlerini kapsar.
2. **Hazine, Vergi, Ã‡ek/Kredi ve Teminat TablolarÄ± (`operational` sÄ±nÄ±fÄ±):**
   - `pos_settlement_batches` (`108` POS valÃ¶r), `corporate_card_statements` (`309` ekstre kesim/Ã¶deme), `payroll_tax_accruals` (`NET_MAAS`, `MPHB_STOPAJ`, `SGK_4A`, `KURUMLAR_GECICI_VERGI`), `term_deposits`, `interbank_transfers`, `letter_of_guarantees` ve `facility_interest_accruals` (gÃ¼nlÃ¼k adat); `loans` ve `loan_installments` Ã¼zerinde `loan_kind`, `interest_type`, `bsmv_rate`, `kkdf_rate`, `bsmv_component`, `kkdf_component`.
3. **`public.live_fx_exposure_v` ve KDV HariÃ§ GÃ¶rÃ¼nÃ¼mler (`WITH (security_invoker = true)`):**
   - YabancÄ± para kasa/banka, aÃ§Ä±k faturalar, Ã§ek/senet, kredi taksitleri ve forward kayÄ±tlarÄ±nÄ± TCMB spot kurlarÄ±yla birleÅŸtirir; `costing_invoice_facts`, `budget_actuals_monthly` ve `budget_vs_actual` gÃ¶rÃ¼nÃ¼mlerini KDV hariÃ§ `net_amount` esasÄ±na geÃ§irir.


## Tam KapsamlÄ± Ãœretim ModÃ¼lÃ¼: Ä°ÅŸ Ä°stasyonlarÄ±, `150/151/152` Stok (`DIO`), BOM, Ä°ÅŸ Emirleri (`OEE`) ve Tarife KartlarÄ± (Faz 60, migration 0118)

`0118_full_production_bom_inventory_workorders_oee.sql` Ã¼retim modÃ¼lÃ¼nÃ¼ tam kapsamlÄ± maliyet/operasyon yapÄ±sÄ±na kavuÅŸturur:

1. **Referans ve Operasyon TablolarÄ±:**
   - `work_centers`, `inventory_items` (`150/151/152` stok kartlarÄ±) ve `customer_rate_cards` (`reference` sÄ±nÄ±fÄ±; tarihsel `cost_models` tarifelerini Ã§oklu mÃ¼ÅŸteri/dÃ¶viz yapÄ±sÄ±na taÅŸÄ±r).
   - `bom_headers`, `bom_lines` (hammadde miktarÄ± + `scrap_pct` + operasyon rotasÄ±), `work_orders` (`work_orders_status_transition_guard()` ile tam yaÅŸam dÃ¶ngÃ¼sÃ¼, fiili sÃ¼re, duruÅŸ ve hurda) ve `inventory_movements` (`operational` sÄ±nÄ±fÄ±); `machine_roi_snapshots` Ã¼zerinde `npv_try`, `irr_pct`, `tax_shield_amount`, `discounted_payback_months`.
2. **CanlÄ± `DIO` ve `CCC` (`public.working_capital_metrics` â€” `WITH (security_invoker = true)`):**
   - Aktif stok kaydÄ± yokken `BLANK != ZERO` kuralÄ±yla `dio_days = NULL` (`no_inventory_data`) kalÄ±r; stok girildiÄŸinde canlÄ± `dio_days` ve `cash_conversion_cycle_days = DSO + DIO - DPO` hesaplanÄ±r.


## BirleÅŸik Dinamik Senaryo HaftalÄ±k KÄ±rÄ±lÄ±mÄ±, Split-Brain Kapatma KolonlarÄ±, MFA/Ä°ÅŸ KuyruÄŸu ve V2 KalÄ±cÄ±lÄ±ÄŸÄ± (Faz 60, migration 0119)

`0119_scenarios_approvals_jobs_security_and_v2_columns.sql` senaryo, Ã¶deme/fatura bÃ¼tÃ¼nlÃ¼ÄŸÃ¼, gÃ¼venlik ve V2 veri merkezi ÅŸema gereksinimlerini tamamlar:

1. **`public.scenario_run_weeks` (`derived` sÄ±nÄ±fÄ±) & `scenario_runs` GeniÅŸletmeleri:**
   - HaftalÄ±k baz vs senaryo kasa, otomatik BCH limit Ã§ekimi (`auto_facility_draw`), ek `780` faiz+vergi, kalan limit boÅŸluÄŸu ve proforma DSCR / kovenant ihlali kolonlarÄ±.
2. **Ã–deme/Fatura, ArÅŸiv, GÃ¶rev, GÃ¼venlik ve V2 KolonlarÄ±:**
   - `payment_instances` (`linked_invoice_id`, `bank_transaction_id`, `journal_entry_id`), `invoices` & `invoice_lines` (iskonto, gelir vergisi stopajÄ±, `ubl_uuid`, ÅŸÃ¼pheli alacak karÅŸÄ±lÄ±k fiÅŸi ve arÅŸiv metaverisi), `action_items.owner_user_id`, `reminders.target_kind` (`invoice`, `covenant_record`), `users` (`email`, `totp_secret_encrypted`, `totp_enabled_at`), `sessions` (`ip_address`, `user_agent`), `background_jobs` (`heartbeat_at`, `artifact_document_id`), `documents` (`extracted_metadata`, `storage_backend`) ve V2 `orders` (`fulfillment_stage`, `order_amount`, `currency`), `products`, `projects`, `cashflow_lines.currency` kalÄ±cÄ±lÄ±k kolonlarÄ±.



## V2 Ã‡oklu Kredi SayfasÄ± (`03_KREDILER`) SatÄ±r BazlÄ± Ä°zlenebilirlik ve Tekillik (Faz 60, migration 0120)

`0120_multi_loan_sheet_row_lineage.sql`, `0008_financing_idempotency.sql` iÃ§inde belgelenmiÅŸ olan tek-kredi-sayfasÄ± varsayÄ±mÄ±nÄ± Ã§oklu kredi ve Ã§oklu dÃ¶viz (`TRY`, `EUR`, `USD`) iÃ§eren V2 `03_KREDILER` sayfasÄ± iÃ§in satÄ±r dÃ¼zeyine taÅŸÄ±r:

1. **`public.loans.source_row_id`:** `public.import_rows(id)` referansÄ± eklenerek V2 `03_KREDILER` satÄ±rlarÄ±nÄ±n her biri kaynak satÄ±rÄ±na birebir baÄŸlanÄ±r.
2. **Ã‡ift KatmanlÄ± Ä°dempotensi Ä°ndeksleri:** `loans_source_row_uq` (`source_row_id IS NOT NULL`) V2 Ã§oklu kredi satÄ±rlarÄ±nda tekilliÄŸi korurken, `loans_source_sheet_legacy_uq` (`source_sheet_id IS NOT NULL AND source_row_id IS NULL`) tarihsel sayfa-bazlÄ± kredi kayÄ±tlarÄ±nÄ±n idempotensisini bozmadan sÃ¼rdÃ¼rÃ¼r.


## Grup Ä°Ã§i Konsolidasyon Eliminasyonu, Parola SÄ±fÄ±rlama, SSO SaÄŸlayÄ±cÄ±larÄ±, Ä°ÅŸbirliÄŸi YorumlarÄ± ve AtÃ¶lye Kiosk KolonlarÄ± (Faz 61, migration 0121)

`0121_enterprise_gaps_kiosk_intercompany_reset_comments.sql` kurumsal Ã§oklu-ÅŸirket konsolidasyonu, self-servis kimlik kurtarma, SSO/Passkey yÃ¶netimi, kayÄ±t Ã¼stÃ¼ `@mention` iÅŸbirliÄŸi ve atÃ¶lye kiosk duruÅŸ takibini ÅŸema dÃ¼zeyinde tamamlar:

1. **Grup Ä°Ã§i Konsolidasyon Eliminasyonu (`public.intercompany_elimination_runs`, `public.intercompany_elimination_lines` â€” `operational` sÄ±nÄ±fÄ±):**
   - Solo ÅŸirket defterlerini bozmadan `120 â†” 320` cari bakiye (`ar_ap_120_320`) ve `600 â†” 770/730` gelir-gider (`rev_exp_600_7xx`) eliminasyon fiÅŸlerini `numeric(18,2)` kesinliÄŸi ve `intercompany_elimination_runs_status_transition_guard()` geÃ§iÅŸ bekÃ§isiyle kaydeder.
2. **Self-Servis Parola SÄ±fÄ±rlama ve Kurumsal SSO (`public.password_reset_tokens` â€” `auth_users` + `app_runtime`, `public.sso_identity_providers` â€” `config` sÄ±nÄ±fÄ±):**
   - `password_reset_tokens` yalnÄ±z SHA-256 Ã¶zeti (`token_sha256`), 30 dakikalÄ±k `expires_at` ve tek-kullanÄ±mlÄ±k `consumed_at` tutar; katmansÄ±z `/login` akÄ±ÅŸÄ± iÃ§in `mas_radar_app` Ã§alÄ±ÅŸma politikasÄ±yla (`sessions_app_runtime` simetriÄŸi) korunur.
   - `sso_identity_providers` (`entra_id`, `google_workspace`, `custom_oidc`, `webauthn_passkey`) kurumsal OIDC ve Passkey yapÄ±landÄ±rmasÄ±nÄ± sÄ±r saklamadan yÃ¶netir.
3. **KayÄ±t ÃœstÃ¼ Ä°ÅŸbirliÄŸi YorumlarÄ± ve AtÃ¶lye Kiosk KolonlarÄ± (`public.entity_comments` â€” `personal` / owner-scoped, `public.work_orders` geniÅŸletmesi):**
   - `entity_comments` tablosu ve GIN indeksli `mentioned_usernames` dizisi tÃ¼m kayÄ±tlar Ã¼zerinde `@kullanici` bildirim akÄ±ÅŸÄ±nÄ± saÄŸlar; `public.user_username_label(uuid)` yardÄ±mcÄ±sÄ± hassas alanlarÄ± aÃ§madan katmanlar arasÄ± yazar etiketini Ã§Ã¶zer.
   - `public.work_orders` tablosu atÃ¶lye operatÃ¶r kiosku iÃ§in `downtime_reason`, `last_kiosk_event_at` ve `operator_note` kolonlarÄ±yla geniÅŸletilir.


## Teknik & Finansal Denetim SertleÅŸtirmesi: Åema Uyum RPC, Bildirim KuyruÄŸu, Olay Durum Makinesi, MÃ¼kerrer Kontrol, Ã‡Ä±kÄ±ÅŸ Onay Tetikleyicisi ve KÄ±sÄ±tlayÄ±cÄ± TÃ¼zel KiÅŸilik RLS (Faz 62, migration 0122)

`0122_audit_hardening_schema_outbox_controls_entity_rls.sql` baÄŸÄ±msÄ±z teknik ve finansal denetimde belirlenen altyapÄ±, mutabakat, bildirim tekilliÄŸi, onay gÃ¼venliÄŸi ve Ã§oklu-ÅŸirket izolasyon katmanlarÄ±nÄ± veritabanÄ± dÃ¼zeyinde mÃ¼hÃ¼rler:

1. **Ã‡alÄ±ÅŸma RolÃ¼ Hijyeni ve Åema Uyum Ã–zeti (`public.get_schema_ledger_summary()` â€” `SECURITY DEFINER`):**
   - `mas_radar_app` Ã¼zerindeki artÄ±k `authenticated` Ã¼yeliÄŸi temizlenir; `public.schema_migrations` tablosunu doÄŸrudan aÃ§madan `(migration_count, latest_version, checksum_digest, last_applied_at)` Ã¶zetini dÃ¶ndÃ¼ren gÃ¼venli RPC tanÄ±mlanÄ±r.
2. **Ä°dempotent Bildirim KuyruÄŸu ve Durumlu Operasyon OlaylarÄ± (`public.notification_outbox`, `public.ops_incidents` â€” `operational` sÄ±nÄ±fÄ±):**
   - `notification_outbox` (`idempotency_key UNIQUE`, `claim_token`, `attempt_count`, `next_retry_at`) tÃ¼m Telegram/e-posta bildirimlerinde mÃ¼kerrer gÃ¶nderimi engeller; `ops_incidents` (`OK`, `OPEN`, `ACKNOWLEDGED`, `RESOLVED`, `UNKNOWN`) P0/P1 telemetri sinyallerinin sessizce kaybolmasÄ±nÄ± Ã¶nler; `control_alerts` eskalasyon sayaÃ§larÄ± ve `-1/-8/-31` gecikme kurallarÄ± tamamlanÄ±r.
3. **MÃ¼kerrer Ã‡ek/Åablon Kontrolleri, DSO GÃ¶zlem Penceresi KorumasÄ± ve Ã–deme Ã‡Ä±kÄ±ÅŸ Onay Tetikleyicisi:**
   - `public.control_duplicate_checks` ve `public.control_duplicate_payments` (`WITH (security_invoker = true)`) gÃ¶rÃ¼nÃ¼mleri `control_dashboard`'a eklenir; `control_iban_changes` onaylanmÄ±ÅŸ IBAN'larÄ± aktif kritik uyarÄ±dan ayÄ±rÄ±r; `control_approval_bypass` ve `enforce_outflow_settlement_approval_gate()` tetikleyicisi eÅŸik Ã¼stÃ¼ onaysÄ±z Ã¶deme kapamalarÄ±nÄ± veritabanÄ± seviyesinde reddeder.
   - `public.dso_dpo_components` ve `public.working_capital_metrics` taslak/arÅŸiv faturalarÄ± dÄ±ÅŸlar ve tek faturalÄ±k `< 14` gÃ¼nlÃ¼k geÃ§miÅŸte cebirsel `365.0 gÃ¼n` sapmasÄ±nÄ± engeller.
4. **KÄ±sÄ±tlayÄ±cÄ± (`AS RESTRICTIVE`) TÃ¼zel KiÅŸilik RLS Ä°zolasyonu ve KullanÄ±cÄ±-Åirket EÅŸlemesi (`public.user_legal_entities` â€” `config` sÄ±nÄ±fÄ±):**
   - `accounting_periods` dÃ¶nem kilidi ÅŸirket bazlÄ± tekilleÅŸtirilir (`accounting_periods_entity_month_uq`) ve 20 operasyon/rapor tablosunda `public.matches_active_legal_entity(legal_entity_id)` kÄ±sÄ±tlayÄ±cÄ± RLS politikasÄ± devreye alÄ±nÄ±r.


## Ã–deme Ã‡Ä±kÄ±ÅŸ Onay Tetikleyicisi `approval_rules.trigger_kind` HizalamasÄ± (Faz 62, migration 0123)

`0123_fix_settlement_approval_trigger_column.sql`, `public.enforce_outflow_settlement_approval_gate()` tetikleyicisindeki kural sorgusunu `0054_approval_rules.sql` ÅŸemasÄ±ndaki `trigger_kind = 'amount_threshold'` ve `applies_to` kapsamÄ±yla hizalar; bÃ¶ylece eÅŸik altÄ± normal Ã¶demeler kesintisiz kapanÄ±rken eÅŸik Ã¼stÃ¼ onaysÄ±z Ã§Ä±kÄ±ÅŸlar `42501` (`APPROVAL_REQUIRED`) ile veritabanÄ± seviyesinde reddedilir.


## Belirsiz GÃ¶nderim KorumasÄ±, Atomik HatÄ±rlatÄ±cÄ± Kilitleme, Olay BastÄ±rma/KanÄ±t KolonlarÄ±, GeÃ§erli Ä°Ã§e AktarÄ±m GÃ¶rÃ¼nÃ¼mÃ¼ ve `31+` Eskalasyon AdlandÄ±rmasÄ± (Faz 63, migration 0124)

`0124_remediation_outbox_incidents_import_freshness.sql` hiÃ§bir tarihsel satÄ±r veya teslimat izini silmeden (`%100` eklemeli ve idempotent) bildirim tekilliÄŸi, olay yaÅŸam dÃ¶ngÃ¼sÃ¼, geÃ§erli Ã§alÄ±ÅŸma kitabÄ± tazeliÄŸi ve gecikme eskalasyon adlandÄ±rmasÄ±nÄ± ÅŸema katmanÄ±nda tamamlar (`I-002`, `I-005`, `I-006`, `I-007`, `I-013`):

1. **`public.notification_outbox` Belirsiz Teslimat (`delivery_uncertain`) ve Ä°zlenebilirlik KolonlarÄ±:**
   - `notification_outbox_status_check` kÄ±sÄ±tÄ± `('pending', 'claiming', 'sent', 'failed_retryable', 'delivery_uncertain', 'dead_letter', 'skipped')` durumlarÄ±nÄ± kapsayacak biÃ§imde geniÅŸletilir; zaman aÅŸÄ±mÄ± veya Ã§ok parÃ§alÄ± kÄ±smi gÃ¶nderim durumlarÄ± iÃ§in `uncertain_at timestamptz` ve uÃ§tan uca izleme iÃ§in `correlation_id text` kolonlarÄ± eklenir.
2. **`public.reminder_deliveries` Atomik SatÄ±r Sahiplenme (`claiming`) ve KÄ±smi Ä°ndeks:**
   - `reminder_deliveries_status_check` kÄ±sÄ±tÄ± `('pending', 'claiming', 'sent', 'failed', 'skipped', 'delivery_uncertain')` durumlarÄ±nÄ± kapsayacak ÅŸekilde geniÅŸletilir; eÅŸzamanlÄ± `FOR UPDATE SKIP LOCKED` iÅŸÃ§ileri iÃ§in `claim_token uuid`, `claimed_at timestamptz` kolonlarÄ± ve `reminder_deliveries_pending_sched_idx` (`ON public.reminder_deliveries (status, scheduled_for, id) WHERE status IN ('pending', 'claiming')`) kÄ±smi B-tree indeksi eklenir.
3. **`public.ops_incidents` BastÄ±rma (`SUPPRESSED`) ve DoÄŸrulanmÄ±ÅŸ KapanÄ±ÅŸ KanÄ±tÄ± KolonlarÄ±:**
   - `ops_incidents_state_check` kÄ±sÄ±tÄ± `('OK', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'UNKNOWN', 'SUPPRESSED')` durumlarÄ±nÄ± kapsayacak biÃ§imde geniÅŸletilir; `suppressed_until timestamptz`, `suppression_reason text`, `last_checked_at timestamptz`, `last_success_at timestamptz`, `resolution_evidence jsonb` ve `correlation_id text` kolonlarÄ± eklenir.
4. **GeÃ§erli Ã‡alÄ±ÅŸma KitabÄ± Ä°Ã§e AktarÄ±m GÃ¶rÃ¼nÃ¼mÃ¼ (`public.valid_workbook_imports` â€” `WITH (security_invoker = true)`, `I-005`):**
   - `public.source_workbooks sw` Ã¼zerinde yalnÄ±z `sw.status IN ('parsed', 'mapped')` olan ve `public.import_rows ir` (`ir.workbook_id = sw.id`) iÃ§inde en az bir satÄ±r barÄ±ndÄ±ran geÃ§erli iÃ§e aktarÄ±mlarÄ± dÃ¶ndÃ¼rÃ¼r; beÅŸ uygulama katmanÄ±na yalnÄ±z `SELECT` verilirken tÃ¼m yazma yetkileri iptal edilir (`91 / 91` gÃ¶rÃ¼nÃ¼mde `security_invoker = true` `%100` korunur).
5. **`-31` Gecikme KuralÄ± AdlandÄ±rma Standardizasyonu (`I-006` / BÃ¶lÃ¼m 7):**
   - `public.reminders` tablosunda `offset_days = -31` olan kurallarda `'30+'` ifadesi `'31+'` olarak, yasal iÅŸlem iddiasÄ± taÅŸÄ±yan `'hukuki eskalasyon'` ifadesi ise `'Ã¼st eskalasyon (iÃ§ inceleme)'` olarak gÃ¼ncellenir; kural kimlikleri (`id`) ve `reminder_deliveries` geÃ§miÅŸi korunur.


## TÃ¼zel KiÅŸilik ve Operasyon OlaylarÄ± YabancÄ± Anahtar (FK) Ã–rtÃ¼cÃ¼ Ä°ndeksleri (Faz 64, migration 0125)

`0125_perf_fk_covering_indexes.sql`, `0122..0124` ile eklenen `legal_entity_id` ve `ops_incidents.acknowledged_by` yabancÄ± anahtarlarÄ± iÃ§in eksik kalan 10 Ã¶rtÃ¼cÃ¼ B-tree indeksini (`idx_approvals_legal_entity_id`, `idx_audit_logs_legal_entity_id`, `idx_bank_transactions_legal_entity_id`, `idx_control_alerts_legal_entity_id`, `idx_notification_outbox_legal_entity_id`, `idx_ops_incidents_acknowledged_by`, `idx_payment_instances_legal_entity_id`, `idx_payment_runs_legal_entity_id`, `idx_reports_legal_entity_id`, `idx_user_legal_entities_legal_entity_id`) idempotent (`IF NOT EXISTS`) olarak tanÄ±mlar; bÃ¶ylece kÄ±sÄ±tlayÄ±cÄ± `matches_active_legal_entity` RLS sorgularÄ± ve FK referans kontrolleri dizin taramasÄ±yla Ã§alÄ±ÅŸÄ±r ve Faz 14 `perf:gate` indekssiz FK tavanÄ± korunur.


