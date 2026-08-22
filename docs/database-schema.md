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

## Karşı taraf (cari hesap) ve organizasyonel boyutlar (Faz 19, migration 0036-0039)

Faz 19'un tamamı `parties`'in ÜZERİNE eklenir; `parties` tablosu değiştirilmedi, yeniden
adlandırılmadı, anahtarı değişmedi. Sebebi ölçüldü: `parties.id`'ye **6 tabloda 8 foreign key**
işaret ediyor (`cash_accounts.provider_party_id`, `cashflow_lines.party_id`,
`checks.payee_party_id`, `checks.payer_party_id`, `checks.bank_party_id`,
`loans.lender_party_id`, `payments.owner_party_id`, `payments.provider_party_id`) — şemadaki en
çok referans verilen tablo. `phase19:verify` bu sekizinin hâlâ yerinde olduğunu her koşuda
kontrol eder.

### 0036 — counterparty_profiles (1:1 sidecar)

- **1:1 yapısal olarak zorlanır:** `party_id` birincil anahtardır. İkinci bir profil ifade
  edilemez (sonradan eklenmiş bir unique index değil).
- `ON DELETE CASCADE` — bir gevşetme DEĞİL: yukarıdaki 8 FK'nın hepsi `NO ACTION`, yani mali
  kaydı olan bir parti zaten silinemez; cascade yalnız hiç geçmişi olmayan bir parti için
  çalışır ve orada öksüz profil bırakmak yanlış olurdu.
- Vergi no/dairesi **format doğrulaması YOK** — kaynak çalışma kitapları yabancı karşı taraf,
  boşluk ve yazım hatası taşıyor; bunlar korunup işaretlenir, reddedilmez (CLAUDE.md). Yalnız
  "boşluktan ibaret" reddedilir.
- `credit_limit`: sıfır **gerçek bir değerdir** ("peşin"), null ise "limit kaydedilmemiş" —
  ikisi aynı şey değildir.
- `tax_number` index'i unique DEĞİL: `parties` (normalized_name, party_type) üzerinden unique
  olduğu için aynı firma bir kez `customer` bir kez `vendor` olarak var olabilir ve aynı vergi
  numarasını taşır. Unique yapmak doğru bir içe aktarmayı başarısız kılardı.

### 0037 — ibans + append-only değişiklik geçmişi

- **Neden yalnız bu tabloya geçmiş:** IBAN değişikliği bu uygulamadaki en yüksek sonuçlu düzenleme
  — parayı sessizce başka hesaba yönlendirir ve klasik fatura dolandırıcılığı vektörüdür. Diğer
  her alan kaynak kitaptan yeniden kurulabilir; yanlış hesaba giden ödeme kurulamaz.
- `iban_normalized` **generated column** (`upper(regexp_replace(iban,'\s','','g'))`); uniqueness
  onun üzerinde. `src/lib/counterparties/rules.ts`'in `normalizeIban()`'ı birebir aynı olmak
  zorunda — `phase19:verify` ikisini karşılaştırır. Aksi halde uygulama, index'in reddedeceği
  bir IBAN'ı kaydetmeyi teklif ederdi.
- **Uniqueness parti-kapsamlı, global DEĞİL** (`unique(party_id, iban_normalized)`): aynı firma
  iki `party_type` satırı olarak var olabildiği için global unique doğru bir durumu ifade
  edilemez kılardı. Farklı karşı taraflarda aynı IBAN bir **sinyaldir**, engel değil — 0039'un
  `iban_shared_across_parties` view'i raporlar.
- `ibans_one_primary_per_party` partial unique index: parti başına en fazla bir birincil hesap.
- **`iban_change_events` salt-ekleme**, 0022'nin `audit_logs` deseniyle birebir: REVOKE savunma
  derinliği, asıl zorlayıcı BEFORE trigger'ları — UPDATE/DELETE/TRUNCATE **superuser için de**
  reddedilir.
- `iban_id`/`party_id` **kasıtlı olarak FK DEĞİL**: satır, tarif ettiği IBAN'dan uzun yaşamalı.
  `ON DELETE CASCADE` olsaydı, saklanmaya en değer olay olan silme, tam da ilginçleştiği anda
  kanıtını silerdi.
- Recorder AFTER trigger'dır ve `to_jsonb(row)` kullanır: ileride eklenecek bir kolon, bu
  fonksiyona dokunulmadan var olduğu andan itibaren kaydedilir. No-op UPDATE geçmişe satır
  yazmaz (`to_jsonb(new) - 'updated_at'` karşılaştırması).
- **audit_logs'un yerini ALMAZ:** engine ayrıca Faz 18'in `audit()`'ini çağırır. İkisi farklı
  soruları yanıtlar — `audit_logs` "hangi operatör ne yaptı" (uygulama yazar),
  `iban_change_events` "bu IBAN ne dedi" (veritabanı yazar, değişiklik uygulamadan mı script'ten
  mi psql'den mi geldiğine bakmadan).

### 0038 — cost_centers / departments / projects / products / orders (MİNİMAL)

Kapsam implementation.md §3 açık soru #9 ile sınırlandı: yalnız kod/ad referans verisi. Tahsis
mantığı, sipariş yaşam döngüsü, satır kalemi, tutar **yok** — ve bunlar "var ama kullanılmıyor"
değil, hiç eklenmedi; boş bir kolon ikinci ve çelişkili bir gerçek kaynağı davet eder.

- `departments.parent_department_id` self-FK, `ON DELETE RESTRICT` — üst birimi silmek alt
  birimleri sessizce silmemeli.
- `projects.party_id` / `orders.party_id` opsiyonel ve `NO ACTION` (parties'e giden diğer her FK
  gibi).
- `products`, `production_parts`'ın yerine GEÇMEZ: o süreç-odaklı (torna/freze dakikaları), bu
  ticari referans verisi. Kaynak kitaplar bir eşleme ifade etmediği için bağ kurulmadı.

### Statü/yaşam döngüsü kolonu neden YOK (§17 kural 3 gerçekten N/A)

Faz 19'un **hiçbir** tablosunda `status` enum'u yok; yalnız `is_active` boolean'ları var ve
boolean'ın kısıtlanacak geçişi yoktur. Bu, kuraldan kaçış değil kurala uyumdur: §17 kural 3,
yaşam döngüsü olan her yeni entity'nin geçiş izin listesini AYNI migration'da ve **eksiksiz**
kurmasını şart koşar, çünkü 0027 üç eksik izin listesiyle çıktı ve 7/7 çeki, 48/48 taksiti sekiz
migration boyunca `planned`de kilitledi. Yarım tasarlanmış bir yaşam döngüsünü kötü korumaktansa
hiç eklememek doğru olan. Sipariş yaşam döngüsü gerçekten gerektiğinde, guard'ıyla aynı
migration'da gelir. `phase19:verify` bu iddiayı her koşuda doğrular (yeni tablolarda
`status`/`state`/`lifecycle` kolonu aranır).

### 0039 — dört VIEW (kalıcı kolon değil)

- **`counterparty_exposure`** — parti başına açık çek + ödenmemiş taksit + açık ödeme kalemi,
  yoğunlaşma payı, kredi limiti kullanımı. **Materialized DEĞİL, stored kolon DEĞİL:** ikinci bir
  gerçek kaynak sessizce bayatlar; bu şemada zaten yaşanmış bir yara var (0027/0034 öncesi
  `paid_count` KPI'ı Faz 5'ten beri 0 dönüyordu). View girdilerinden sapamaz.
- **Bilinmeyen tutarlar SAYILIR, sıfır olarak toplanmaz** (`unknown_amount_count`) — üç tutarsız
  çeki olan bir karşı taraf "sıfır risk" olarak okunmamalı.
- `exposure_ratio` ve `credit_limit_utilization` bölecek bir şey yoksa **null**, sıfır değil —
  "bilinen toplam yok" ile "%0 yoğunlaşma" farklı ifadelerdir (money.ts'in `ratioOrNull`'ıyla
  aynı ayrım). Sıfır limit ise gerçek bir değerdir: aşım işaretlenir ama bölme yapılmaz.
- Çek ataması payee/payer üzerinden, **banka üzerinden DEĞİL**: `bank_party_id` "hangi bankaya
  keşide" demektir ve katılsaydı bankanın riskini çok abartırdı.
- **`counterparty_unresolved`** — geri-doldurmanın yerine geçen görünürlük yüzeyi (aşağıda).
- **`iban_shared_across_parties`** — 0037'nin bilerek engellemediği çakışmayı raporlar.

### Geri-doldurma neden YAPILMADI

İçe aktarma bir ismi çözemediğinde ham metni saklar ve FK'yı boş bırakır
(`src/lib/financing/engine.ts` → `partyIdByName`: "Never creates parties silently"). Faz 19 bu
satırları **geri doldurmaz**: serbest metni bir karşı tarafa eşlemek bir yargıdır ve CLAUDE.md
yargıyı incelenmiş, açık bir insan eylemine ayırır.

Karar veriye dayandırıldı (gerçek veritabanında salt-okunur ölçüm): **7 çekin 7'si zaten bir
partiye çözülmüş, 0'ı çözümsüz etiket taşıyor**; tek çözümsüz karşı taraf 1 kredinin
`lender_party_id`'si. Üstelik **`loans`'ta `counterparty_label` kolonu YOK** (introspection ile
doğrulandı — yalnız `checks`'te var); kredinin karşı tarafı ancak `loans.name`'den, yani kredinin
kendi adından tahmin edilebilirdi ki bu tam da kuralın yasakladığı çıkarım. Yani reddedilen
geri-doldurma bugün `checks`'te zaten hiçbir şeye dokunmayacaktı ve `loans`'ta dokunamazdı.

Bunun yerine eklenen: `counterparty_unresolved` view'i + `/finance/counterparties` sayfasındaki
öneri listesi. Öneriler bigram benzerliğiyle **sıralanır ama asla otomatik bağlanmaz**;
`suggestCounterparties()` dönüş tipinde bilerek `autoLinkable` benzeri bir alan yoktur.
Eşleştirme yapıldığında `counterparty_label` **SİLİNMEZ** — ham metin kaynak kanıtıdır, çözülen
FK onun üzerine eklenen bir yorumdur.

## Banka Merkezi (Faz 20, migration 0040-0043)

### Mimari karar: ayrık `bank_accounts`, `cash_accounts` genişletilmedi

implementation.md bu kararı bilerek açık bırakmıştı ("cash_accounts'a IBAN/şube kolonu eklemek
**veya** ayrık bank_accounts tablosu — faz başlarında netleştirilecek"). Karar verinin kendisine
bakılarak verildi. Gerçek `cash_accounts` içeriği:

| name | account_type |
| --- | --- |
| Deniz | bank_account |
| HESAP Halk | bank_account |
| Kasa | **cash** — kasa kutusu; IBAN'ı, şubesi, KMH'si yok |
| Vinov | check_account |
| Halk Business | **credit_card** — IBAN'ı, şubesi yok |
| Halk KK - Paraf | **credit_card** |

**Altı satırın yalnız ikisi banka hesabı.** `cash_accounts`'ı genişletmek, satırların üçte
ikisinde kalıcı olarak null ve anlamsız beş kolon eklemek ve tablonun ne anlama geldiğini
sessizce değiştirmek olurdu — oysa bu belge onu "genel defter nakit pozisyonu" diye tanımlıyor
ve `cashflow_lines`, `payments`, `payment_instances`, `checks` tam olarak buna bağlı.

Ayrıca `cash_accounts`'a **4 FK** işaret ediyor (`payments.cash_account_id`,
`payment_instances.paid_from_account_id`, `cashflow_lines.account_id`, `checks.account_id`).
Faz 19'un `parties` için kurduğu emsal aynen geçerli: referans verilen tabloyu yeniden
şekillendirme, detayı yanına as.

`bank_accounts.cash_account_id` **birincil anahtardır**, yani banka hesabı aynı paranın ikinci
bir kimliği değil, bir kasa hesabının banka detayıdır. `phase20:verify` `cash_accounts`'a
banka-özel kolon sızmadığını her koşuda kontrol eder.

### 0040 — bank_accounts

- IBAN, şube kodu/adı, hesap no, SWIFT/BIC, kullanılabilir/bloke bakiye, **KMH limiti**
  (`overdraft_limit`), `balance_as_of`, `last_statement_date`.
- Bakiyeler nullable: "henüz içe aktarılmadı" gerçek bir durum ve sıfır olarak okunmamalı.
  `overdraft_limit` sıfır olabilir ("KMH yok"), negatif olamaz.
- `iban_normalized` generated column, 0037'yle aynı teknik.
- **IBAN GLOBAL unique** — ve bu 0037'yle bilinçli bir KARŞITLIK. 0037 karşı taraf IBAN'ını
  parti-kapsamlı unique yapar, çünkü aynı firma `parties`'te iki kez bulunabilir. O gerekçe
  burada geçmez: bunlar MAS'ın **kendi** hesapları. Bir IBAN bir hesaptır; iki kasa hesabının
  aynı IBAN'ı iddia etmesi, o hesabın ekstresini ikiye bölen bir veri hatasıdır.

### 0041 — `source_sheets.detected_type`'a `bank_statement`

`workbook-parser.ts`'in `SheetDetectedType` union'ı ile bu CHECK birbirinin aynası olmak zorunda
(dosyanın kendi başlığı "Do not drift" diyor). Ekstre importu eklemek bu yüzden saf uygulama işi
değil; iki taraf birlikte hareket etmezse ilk import INSERT'te patlar. Genişletme olduğu için
(kabul edilen küme büyüyor, daralmıyor) mevcut her satır yeni constraint'i inşaen sağlar —
"NOT VALID ekle, ayrı dilimde VALIDATE" kuralı burada geçerli değildir.

**`classifySheetName` bu türü ASLA döndürmez.** Ekstre importu, operatörün hangi banka hesabına
aktardığını seçtiği açık bir eylemdir; tür sayfa adından tahmin edilmez. Tahmin etmek burada
ayrıca tehlikeliydi: gerçek çalışma kitabında **"faiz hesaplama"** adlı bir sayfa var ve makul
görünen bir "hesap" anahtar kelimesi onu `loan_calculation`'dan çalardı.

### 0042 — bank_transactions ve TAM durum izin listesi

Ham ekstre satırları. Faz 2'nin staging deseni yeniden kullanılır: her satır
`source_workbook_id`/`source_sheet_id`/`source_row_id` taşır, yani ham hücrelere kadar izlenir.
İkinci bir lineage mekanizması icat edilmedi.

- `amount` **NOT NULL** ve işaretli (negatif = hesaptan çıkış, `checks.signed_amount` ile aynı
  sözleşme). Planlanmış bir ödemeden farklı olarak, tutarsız bir ekstre satırı zaten ekstre
  satırı değildir.
- `direction` generated column — elle yanlış yazılamaz.
- `dedupe_hash` + `unique(bank_account_id, dedupe_hash)`: örtüşen dönemi tekrar indirmek
  NORMALDİR; aynı satır çoğalmak yerine mevcut satıra düşer. Hash'e **yürüyen bakiye dahil
  edilmez** — geriye tarihli bir kayıt araya girdiğinde kayar ve aynı işlemi yeni gösterirdi.
- İki tutarlılık CHECK'i: `matched`/`reconciled` eşleştiği kaydı adlandırmak ZORUNDA;
  `ignored` **gerekçesiz olamaz** (sessiz bir "beni ilgilendirmiyor", gerçek bir ödemenin
  kaybolma yoludur).

#### Durum izin listesi — 0027'nin dersinin uygulanışı

CHECK'in kabul ettiği değerler: `unmatched · suggested · matched · reconciled · ignored`.
İzin verilen geçişler, **kolonla aynı migration'da**:

| Geçiş | Anlamı |
| --- | --- |
| unmatched → suggested | eşleştirici aday buldu |
| unmatched → matched | operatör doğrudan eşleştirdi |
| unmatched → ignored | eşleşme gerekmiyor (banka masrafı, kendi virmanı) |
| suggested → matched | öneri kabul edildi |
| **suggested → unmatched** | **öneri REDDEDİLDİ — red yolu** |
| suggested → ignored | öneri yerine yok sayıldı |
| matched → reconciled | dönem kapatıldı |
| matched → unmatched | yanlış eşleşme geri alındı |
| matched → ignored | "eşleşme" aslında masrafmış |
| reconciled → matched | kapanmış mutabakat düzeltme için yeniden açıldı |
| ignored → unmatched | yok sayma geri alındı |

Aynı-durum güncellemesi HER değer için no-op (0027'nin doğru olan kısmı).

**Erişilebilirlik** — 0027'nin kırdığı özellik: `unmatched` başlangıç; `suggested` unmatched'ten;
`matched` unmatched/suggested/reconciled'dan; `reconciled` matched'ten; `ignored`
unmatched/suggested/matched'ten. **Beşi de erişilebilir, ölü değer yok.**

Bilerek yasaklananlar (ihmal değil, gerekçeli): `unmatched→reconciled` (mutabakata alınacak bir
eşleşme yok), `suggested→reconciled` (öneri kabul değildir), `reconciled→unmatched` ve
`reconciled→ignored` (önce `matched`'e dönülür, böylece yeniden açma kendi başına denetlenir),
`ignored→suggested/matched/reconciled` (önce yok sayma geri alınır).

**Kanıt okumayla değil SAYIMLA yapılır:** `scripts/phase20-verify.ts` izin verilen durumları
canlı CHECK constraint'inden **türetir**, 5×5 = **25 çiftin tamamını** gerçek bir satır üzerinde
dener ve gözlenen kabul/ret matrisini beyanla karşılaştırır. CHECK'e geçişleri olmayan bir durum
eklenirse gate "ÖLÜ DURUM" diyerek düşer. 0027'de başarısız olan şey tam olarak migration'ı
okuyup doğru sanmaktı.

### 0043 — eşleşme adayları ve üç view

`bank_transaction_match_candidates`'ın **statü enum'u YOKTUR** — bilinçli. Bir aday ya vardır ya
reddedilmiştir; bunu statü olarak modellemek İKİNCİ bir durum makinesi ve ikinci bir tam guard
gerektirirdi. `rejected_at` nullable bir zaman damgasıdır; kısıtlanacak geçişi yoktur. Kabul,
ait olduğu yerde — hareketin kendisinde — kaydedilir. **Redler silinmez, hatırlanır**, yoksa
eşleştirici aynı adayı her koşuda yeniden önerirdi.

View'ler (kalıcı kolon değil, 0039'la aynı gerekçe):
- `bank_unmatched_queue` — insanın karar vermesi gereken her şey, açık aday sayısı ve en iyi
  güven skoruyla.
- `bank_reconciliation_summary` — hesap başına mutabakat sağlığı.
- `bank_match_conflicts` — **iki farklı ekstre satırının aynı mali kaydı iddia etmesi.** 0042'nin
  unique index'i aynı satırın iki kez içe aktarılmasını durdurur; gerçekten farklı iki satırın
  tek bir ödemeye eşleştirilmesini hiçbir şey durdurmaz ve asıl ilginç hata odur — bu yüzden
  engellenmez, **bildirilir**.

### Sınıflandırma ve eşleştirme: kural, model değil

`src/lib/bank/rules.ts` saf ve test edilebilir. Sınıflandırma sıralı bir kural tablosudur, **ilk
eşleşen kazanır** (sıra spesifikasyonun kendisidir: "kredi kartı" mutlaka "kredi taksit"ten önce
gelmeli). Her satır hangi kuralın çalıştığını (`category_rule`) saklar; eşleşme yoksa `unknown`
ve **null kural** — en iyi tahmin üretilmez.

Eşleştirme skoru adlandırılmış sinyallerin toplamıdır (`amount_exact`, `date_same_day`,
`label_contained`…) ve `reasons` olarak saklanır. **İki bağımsız sinyal şarttır:** hiçbir tek
ağırlık öneri eşiğini (0.5) tek başına geçemez, çünkü 10.000 TL gibi yuvarlak bir tutarın tek
başına tutması tam da güvenle yanlış mutabakat üreten rastlantıdır. Bu kural bir birim testiyle
yapısal olarak korunuyor — ilk ağırlık tablosu bunu ihlal ediyordu ve test yakaladı.

**Bir eşleşmeyi kabul etmek mali kaydı DEĞİŞTİRMEZ.** Ekstre planla ilişkilendirilir; ödemeyi
"ödendi" yapmak ayrı ve ayrıca denetlenen bir işlemdir. Denetim satırı bunu
`financial_record_mutated: false` alanıyla açıkça kaydeder.

### CSV desteği ve §1.1 korumasının bozulmaması

`safeParseWorkbookBuffer` ZIP/CFB imzası olmayan her şeyi reddeder ve bu **belirtilmiş, testli**
bir davranıştır (implementation.md §1.1: tamamı sıfır bayt olan bozuk yükleme "ayrıştırılmış"
sayılmamalı). Ekstreler sık sık CSV geldiği için destek şart — ama imza kontrolünü gevşetmek,
uygulamadaki HER workbook importu için bozuk-dosya deliğini yeniden açardı.

Bu yüzden workbook yoluna **dokunulmadı**; CSV kendi kapısını ve kendi korumasını aldı
(`src/lib/importers/statement-parser.ts`): boş dosya, NUL bayt içeren (aslında ikili) içerik ve
ayırıcısı olmayan metin reddedilir. UTF-8 BOM striplenir — aksi halde ilk başlık hücresi
"﻿İşlem Tarihi" olur ve sütun tanıma başarısız olurdu. Ayırıcı ilk satırdan sayılarak bulunur;
Türkçe CSV'ler `;` kullanır çünkü `,` ondalık ayırıcıdır.

### Banka API'si YOK

implementation.md canlı banka bağlantısını Faz 37'ye erteler. Bu faz yalnız dosya importudur ve
`phase20:verify` `src/lib/bank/engine.ts` içinde ağ çağrısı olmadığını kontrol eder — kapsam
kaymasını başka hiçbir gate yakalamazdı.
