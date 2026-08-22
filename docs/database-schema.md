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

## Fatura Merkezi (Faz 21, migration 0044-0047)

Faz 19'un `parties`/`cost_centers`/`projects`/`orders`/`products` referans verisi üzerine kurulu.
Gerçek kolon adları migration yazılmadan ÖNCE introspection'la doğrulandı (`projects.party_id`,
`projects.cost_center_id`, `orders.party_id` — plandan tahmin edilmedi).

### 0044 — invoices ve ALTI durumlu yaşam döngüsü

Kolonlar: yön (`sales`/`purchase`), fatura no, karşı taraf (NOT NULL), opsiyonel
masraf merkezi / proje / sipariş, düzenleme+vade tarihi, para birimi, net/KDV/brüt, ödenen tutar,
durum, 0026 desenli iptal alanları, kapatma alanları, Faz 2 lineage üçlüsü, dedupe_hash.

**Zorlanan mali değişmez:** `gross_amount = net_amount + tax_amount`. Parçaları toplamayan bir
fatura, aylar sonra nakit-akış tahmininde açıklanamayan bir fark olarak ortaya çıkacak bir
veri-giriş hatasıdır; yazma anında düşer.

**`paid_amount`'a üst sınır YOK** — fazla ödeme gerçekte oluyor (mükerrer transfer, bankada kur
yuvarlaması) ve engellemek operatörü kaydı çarpıtmaya zorlardı. `invoice_overpaid` view'i
raporluyor. Flag, never fix.

#### Durum izin listesi (CHECK ile AYNI migration'da)

CHECK: `draft · open · partial · paid · closed · cancelled`. On dört geçiş:

| | |
| --- | --- |
| draft → open | fatura düzenlendi |
| draft → cancelled | hiç ticarileşmemiş taslak iptali |
| open → partial / paid | kısmen / tamamen tahsil |
| open → closed | tam tahsil olmadan kapatma (iskonto, zarar yazma) |
| open → cancelled | DÜZENLENMİŞ faturanın iptali — reversal kaydı şart |
| partial → paid / open / closed / cancelled | kalan tahsil / tek ödeme geri alındı / kalan silindi / iptal |
| paid → partial / open | ödeme(ler) geri alındı |
| paid → closed | tahsil sonrası arşiv |
| closed → open | düzeltme için yeniden açma |

**Erişilebilirlik:** altı durumun altısı da `draft`'tan erişilebilir. Bilerek yasaklananlar:
- **hiçbir şey → draft** — düzenlenmiş fatura "düzenlenmemiş" yapılamaz; bu, karşı tarafın
  eline geçtiği gerçeğini silmek ve içerik dokunulmazlığını yeniden açmak olurdu.
- draft → partial/paid/closed — düzenlenmeden tahsil olmaz.
- closed → partial/paid/cancelled — önce `open`'a dönülür, böylece yeniden açma kendi başına
  denetlenen bir eylem olur (Faz 20'nin `reconciled → matched` kurgusuyla aynı).
- **cancelled → hiçbir şey (TERMİNAL)** — iptal, 0046'daki reversal kaydıyla belgelenir; çare
  yeni fatura düzenlemektir, iptal edilmiş bir faturayı diriltmek değil. Denetim izi ile
  yeniden yazma arasındaki fark budur.

`phase21:verify` bunu **36 çiftin tamamını gerçek satırlar üzerinde deneyerek** kanıtlıyor;
yorumu okumuyor.

#### İçerik dokunulmazlığı (0024 deseni)

**`draft` tek düzenlenebilir durumdur.** Fatura düzenlendikten sonra kimin için olduğu, numarası,
tarihleri ve tutarları donar. Bu temkin değil, faturanın ne OLDUĞUdur: karşı tarafın elindeki bir
belge. Düzeltme iptal+yeniden düzenleme ya da iade faturasıyla yapılır.

**Bilerek DONMAYAN:** `status`, `paid_amount`, iptal/kapatma meta verisi, `notes`, `updated_at`.
Düzenlenmiş faturaya tahsilat işlenebilmeli — guard'ı buraya kadar genişletmek, 0027'nin
"satır kullanılamaz hale geldi" hatasını başka kılıkta tekrarlamak olurdu. `phase21:verify`
guard'ın çok geniş OLMADIĞINI ayrıca test ediyor.

### 0045 — invoice_lines

Miktar ve birim fiyat `numeric(_,4)` (talaşlı imalatta 12,3456 TL birim fiyat olağan; kalem
düzeyinde kuruşa yuvarlamak tedarikçinin kendi belgesiyle uyuşmazlık yaratır), kalem tutarları
TL ölçeğinde ve aynı `gross = net + tax` değişmezi.

Kalemler başlığın dokunulmazlığını izler: başlığı dondurup kalemleri serbest bırakmak tiyatro
olurdu — toplam sabit kalırken altındaki detay değişirdi. Tek fonksiyon INSERT/UPDATE/DELETE'i
birlikte kapsıyor ki arada boşluk kalmasın. Parent satır yoksa (ON DELETE CASCADE çalışıyordur)
guard geçit veriyor, aksi halde taslak fatura bile silinemezdi.

**Düzenlenmiş fatura SİLİNEMEZ** (ayrı trigger): iptal reversal kaydı bırakır, DELETE hiçbir şey
bırakmaz — denetim izinin atlatamayacağı tek sonuç budur. Taslaklar silinebilir kalır.

### 0046 — invoice_reversals: iptal = bağlı kayıt, sessiz durum değişimi DEĞİL

`status='cancelled'` yalnız "geçersiz mi" sorusunu yanıtlar; kimin, ne zaman, neden iptal
ettiğini ve — asıl önemlisi — **faturanın iptal anında NE DEDİĞİNİ** yanıtlayamaz. Bu yüzden her
iptal, faturanın ve kalemlerinin dondurulmuş JSON kopyasını taşıyan bir kayıt yazar.

- 0022'nin **salt-ekleme** kurgusu (UPDATE/DELETE/TRUNCATE superuser dahil reddedilir).
- Fatura başına **en fazla bir `cancellation`** (partial unique index); iade faturası birden
  fazla olabilir.
- **`invoices_require_reversal_record`** — DEFERRABLE constraint trigger: bağlı kaydı olmayan bir
  `cancelled` fatura COMMIT edilemez. Bu olmasaydı tasarım tavsiye niteliğinde kalırdı; bir kod
  yolu 0044'ün CHECK'ini sağlayıp arkasında hiçbir kayıt bırakmayabilirdi.

#### `invoice_id` neden FK DEĞİL — ve bunu ne ortaya çıkardı

İlk taslak `references public.invoices(id) on delete restrict` diyordu ve **`pnpm import:real`
anında düştü**. `scripts/import-real.ts` `truncate public.source_workbooks cascade` çalıştırıyor;
faturalar `source_workbook_id` lineage kolonu taşıyor; ve **TRUNCATE CASCADE, ON DELETE
eylemine bakmaksızın referans veren HER tabloyu izliyor** — böylece cascade bu tabloya ulaştı ve
salt-ekleme trigger'ı meşru bir geliştirme sıfırlamasını iptal etti.

Normal işleyişi bozacak kadar geniş çizilmiş bir guard, 0027 hatasının başka kılığıdır.

FK'yı kaldırmak bunu yan etki olarak çözüyor ama bağımsız olarak da doğru şekil — ve bu depoda
zaten emsali var: 0037'nin `iban_change_events.iban_id`'si aynı gerekçeyle FK değil. **Bir
append-only kanıt tablosuna cascade edebilen her tablo, o kanıtı yok edebilir.** Bütünlük ait
olduğu yerde korunuyor: engine faturayı yazmadan önce çözüp kilitliyor, ve yukarıdaki deferred
trigger kayıtsız bir iptali reddediyor.

### 0047 — beş view

`invoice_open_items` (yaşlandırma kovalarıyla), `invoice_duplicate_suspects`,
`invoice_line_mismatches`, `invoice_overpaid`, `invoice_party_summary`. Kalıcı kolon değil —
0039/0043 ile aynı gerekçe.

**Duplicate tespiti** (karşı taraf + numara + tutar + tarih) iki ayrı sinyal olarak raporlanıyor:
`same_number` (neredeyse her zaman gerçek duplicate) ve `near_match` (aynı tutar, 7 gün içinde,
FARKLI numara — tedarikçinin yeni numarayla yeniden gönderdiği durumu yakalar). İptal edilen
faturalar listeden düşüyor, çünkü birini iptal etmek duplicate'i çözmenin ta kendisidir.

**Duplicate ENGELLENMEZ.** `bank_transactions.dedupe_hash` unique'tir çünkü örtüşen ekstre
dönemini yeniden indirmek mekanik ve beklenen bir iştir; doğru cevap "mevcut satıra düş"tür.
Fatura duplicate'i başka bir hayvandır: insan ya da tedarikçi hatasıdır, iki satır anlamlı
şekilde farklı olabilir, ve ikincisini reddetmek operatörü ya rakamı çarpıtmaya ya içe aktarmayı
bırakmaya zorlar. Tespit edilir ve bildirilir; sessizce birleştirilmez de engellenmez de.

**Başlık/kalem uyuşmazlığı** da raporlanır, engellenmez: kalemler zorunlu olarak başlıktan SONRA
yazılır, dolayısıyla engelleyen bir trigger ya deferred olmak (ve tek bozuk satır için tüm içe
aktarma transaction'ını düşürmek) ya da normal ekleme sırasını yasaklamak zorunda kalırdı. Bu
sınıf için deponun yerleşik cevabı nakit-akış kimlik kontrolüdür: hesapla, göster, insan karar
versin.

## Tahsilat/Ödeme Eşleme ve Cari Hesap (Faz 22, migration 0048-0050)

### 0048 — invoice_allocations ve §18'in ilk gerçek testi

**Zorlanan değişmez:** `Σ(açık dağıtım) ≤ invoices.gross_amount` — her zaman, istisnasız.
implementation.md §18 bunu "ödenen > fatura, tahsilat > alacak hiç aşılmamalı" diye yazıyor ve
uygulama-seviyesi kontrolün yetmeyeceğini açıkça söylüyor. Bu yüzden **trigger**, konvansiyon
değil.

**Neden CHECK değil trigger:** CHECK tek satır görür. Bu değişmez, BAŞKA bir tablodaki bir
değere karşı ÇOK satırın toplamı hakkındadır; hiçbir CHECK bunu ifade edemez.
`allocations_enforce_invoice_ceiling()` INSERT/UPDATE/DELETE'in üçünde de çalışır — arada boşluk
kalmasın diye.

**Tek tablo, iki değil.** Plan `payment_allocations`/`collection_allocations` diyor. İkisi
kolon kolon aynı olurdu (yön zaten `invoices.direction`'dan belli) ve ayırmak, tavan
değişmezinin İKİ tablo üzerinden İKİ trigger'la toplanmasını gerektirirdi — sonsuza dek
birbiriyle uyumlu kalmaları gereken iki trigger. Tek tablo = tek trigger = değişmezin yaşadığı
tek yer. Planın istediği iki isim 0050'de **filtrelenmiş view** olarak sağlanıyor, yani söz
dağarcığı korunuyor.

**Status kolonu YOK.** Bir dağıtım ya vardır ya iptal edilmiştir; `reversed_at` nullable bir
zaman damgasıdır ve kısıtlanacak geçişi yoktur. Faz 20 (`match_candidates`) ve Faz 19 (boyut
tabloları) ile aynı karar: §17 kural 3 her yeni yaşam döngüsü için EKSİKSİZ bir guard şart
koşuyor, ve gerekmeyen bir fazda ona uymanın yolu yaşam döngüsü icat etmemektir.

#### `paid_amount` ile `allocated_amount` farkı — muhasebe farkı, ayrıntıcılık değil

| kolon | anlamı | tavan |
| --- | --- | --- |
| `paid_amount` (Faz 21) | bu faturaya karşı **kaydedilmiş** para | YOK — fazla tahsilat gerçektir (mükerrer transfer, bankada kur farkı) ve engellemek operatörü kaydı çarpıtmaya zorlar |
| `allocated_amount` (Faz 22) | bu paranın faturaya **resmen atanmış** kısmı | fatura tutarı — 120'lik faturaya 130 atamak fazla tahsilat değil, 10'unun **başka yere ait olması**dır |

Sonuç: fazla tahsilat `paid_amount > gross`, `allocated_amount = gross` olarak görünür ve
dağıtılmamış kalan **kaynak tarafında** (`settlement_unallocated`) durur.

#### CASCADE burada güvenli — ve 0046'nın hatası değil

`invoice_allocations.invoice_id` FK'sı `ON DELETE CASCADE`. Bu tabloda salt-ekleme trigger'ı
YOK, dolayısıyla staging'den gelen bir `TRUNCATE CASCADE` onu temizler ki geliştirme sıfırlaması
için doğru davranış budur. 0046'nın yaşadığı sorun tam olarak append-only bir kanıt tablosuna
cascade edilmesiydi; burada öyle bir tablo yok.

Trigger, fatura satırı yoksa (cascade/truncate çalışıyordur) sessizce geçiyor — orada hata
vermek meşru bir sıfırlamayı imkânsız kılardı, 0046'nın öğrendiği ders.

**Yaşam döngüsü kapısı:** dağıtım yalnız `open`/`partial`/`paid` faturaya yapılabilir. `draft`
düzenlenmemiştir, `cancelled` geçersizdir, `closed` kapatılmıştır (önce açılmalı). Kontrol
yalnız dağıtım kümesi BÜYÜRKEN uygulanıyor; iptal/temizlik kapalı veya iptal edilmiş faturada da
mümkün kalıyor — temizliği engelleyen bir guard, çok geniş çizilmiş bir guard'dır.

### 0049 — bank_transactions eşleşme hedefinin GENİŞLETİLMESİ

Faz 20 `matched_entity_table` CHECK'ini o gün var olan üç entity ile göndermişti; 0043'ün notu
"invoices/collections Faz 22'de kendi migration'ında bu CHECK'i genişletecek" diyordu. Bu, o
migration.

`bank_transactions` üzerinde `matched_entity_table` geçen **iki** CHECK var
(`..._matched_entity_table_check` = değer listesi, `..._match_consistency` = null eşleşmesi).
Yalnız birincisi değiştirildi ve **adıyla** hedeflendi — metin aramasıyla değil. Faz 20'nin gate
dersi DDL için de geçerli: `like '%matched_entity_table%'` ikisini de bulur ve "bulduğunu
düşüreni" değiştiren bir migration, tutarlılık kuralını sessizce silebilirdi.

`bank_transaction_match_candidates.target_table` CHECK'i **aynı anda** genişletildi. Birini
genişletip diğerini bırakmak, eşleştiricinin artık eşleşmesine izin verilen şeyi hiç
ÖNEREMEMESİ demekti — tam olarak 0027'nin biçimi.

**Genişletme, daraltma değil:** mevcut her satır yeni constraint'i inşaen sağlıyor, doğrulanacak
bir şey yok. "NOT VALID ekle, ayrı dilimde VALIDATE" kuralı (0023/0026 → 0029/0030) mevcut veriyi
REDDEDEBİLECEK constraint'ler içindir; 0041'in `detected_type` genişletmesiyle aynı gerekçe.

### 0050 — receivables/payables VIEW olarak (açık tasarım kararı, kapatıldı)

implementation.md bunu açık bırakmıştı. Uygulanan test basitti: bir alacağın BUGÜN, faturasının
zaten taşımadığı tek bir özniteliği var mı?

| | |
| --- | --- |
| karşı taraf, tutar, para birimi, düzenleme/vade tarihi | faturada |
| ne kadarı hâlâ borçlu | `gross − allocated` (0048) |
| yaşlandırma kovası | `due_date`'ten türetilir |
| tahsil / zarar yazıldı / iptal | `invoices.status` |

Geriye hiçbir şey kalmıyor. Bugün bir receivables TABLOSU bu kolonların her birini kopyalar ve
faturada yaşayan tutarlar için **anında ikinci bir gerçek kaynak** olurdu — bu şemanın zaten
ısırıldığı bayatlama (0034 öncesi `paid_count` KPI'ı Faz 5'ten beri 0 dönüyordu; 0039/0043/0047
hep aynı sebeple view).

Tabloyu haklı çıkaracak şeyler gerçek ama bu fazda yok: **promise-to-pay** tarihi
(implementation.md §1c ayrı bir gelecek entity olarak listeliyor), dunning/tahsilat durumu,
alacak-bazlı sorumluluk ataması. Bunlar geldiğinde kendi öznitelikleriyle ve kendi yaşam
döngüleriyle gelir — terfi anı O'dur, kendi migration'ı ve kendi eksiksiz transition-guard'ıyla.
Şimdi terfi ettirmek, içine koyacak bir şey olmadan yaşam döngüsü icat etmek olurdu; §17 kural 3
tam da bunu önlemek için var.

#### Yaşlandırma: Faz 22'nin kovaları Faz 21'den FARKLI, kasıtlı

0047'nin `invoice_open_items`'ı 1-30/31-60/61-90/90+ kullanıyor — klasik AR **raporlama**
yaşlandırması. Faz 22 ise 1-7/8-30/31-60/60+ istiyor: bu bir **tahsilat-aciliyeti**
yaşlandırmasıdır. İlk ayı böler çünkü müşterinin üç gün mü üç hafta mı geciktiği bugün ne
yapacağını değiştirir; 60'tan sonra bölmeyi bırakır çünkü orada aksiyon zaten aynıdır. İkisi de
amacına göre doğru, ikisi de korunuyor, ve `phase22:verify` TS ile SQL uygulamasını aynı
satırlara karşı karşılaştırıyor ki birbirinden ayrılmasınlar.

#### DSO/DPO: view bileşenleri verir, oranı DEĞİL

Bir view parametre alamaz ve bir dönemi SQL'e gömmek, herkesin alıntıladığı ama pek azının aynı
tanımladığı bir metrikte en kritik varsayımı gizlemek olurdu. `dso_dpo_components` ham sayıları
verir; `src/lib/receivables/rules.ts` oranı formülü yazılı ve birim-testli biçimde hesaplar.

    DSO = (açık alacak / dönem satışı) × dönem günü

Dönemde satış yoksa sonuç **null**, sıfır değil: sıfır, hiçbir şey satmamış bir şirket için
"müşteriler anında ödüyor" demektir — mümkün olan en kötü çeyreğin en pohpohlayıcı okuması.

#### Cari hesap kartı: alacak ve borç NETLEŞTİRİLMEZ

`current_account_summary` ikisini ayrı tutar. Mahsup, iki taraf arasında **hukuki** bir işlemdir,
aritmetik bir işlem değil; burada netlemek var olmayan bir anlaşmayı sessizce varsaymak olurdu.

`counterparty_settlement_speed` **gerçekleşmiş** süredir: yalnız tahsil edilmiş faturaları sayar.
Ödenmemiş bir faturanın tahsilat süresi yoktur, ve onu sıfır (ya da bugün−düzenleme) saymak karşı
tarafı olmadığı kadar iyi ya da kötü gösterirdi.

## Alacak/Borç Yönetimi Genişletme (Faz 23, migration 0051-0052)

Faz 19-22'nin üzerine read-model; yeni kaynak veri yok. Tek yazılabilir ekleme, elle konulan
şüpheli-alacak bayrağı.

### 0051 — bad-debt: ELLE konulan, DENETLENEN bayrak

**Bu fazda bu kolonları yazan hiçbir kural, trigger veya zamanlanmış iş YOK.** "90 günü geçerse
işaretle" türü hiçbir sezgi eklenmedi. CLAUDE.md'nin kaynak-doğruluk kuralı açık — AI hiçbir
kaydı ödendi işaretleyemez, silemez, belirsiz satırdan nihai gerçeği çıkaramaz — ve bir alacağı
zarar yazmak tam olarak o kuralın insan elinde tutmak istediği yargıdır. 0052'nin skorları bir
faturanın tahsil edilemez göründüğünü söyleyebilir; **o görüşe göre hareket edemez.**

Kolonları yazan tek kod yolu `src/lib/collections/engine.ts`'in `markBadDebt()`/`clearBadDebt()`
fonksiyonları: tipli bir gerekçe şart ve kanonik `audit()` üzerinden kaydediliyor.
`phase23:verify` bunu iki yönden doğruluyor — `src/` içinde başka yazar olmadığını grep'le, ve
`bad_debt_at`'i güncelleyen bir PL/pgSQL fonksiyonu olmadığını katalogdan.

**Neden bayrak, neden durum değil.** `invoices.status` zaten zarar yazma için `closed`, iptal
için `cancelled` taşıyor. Şüpheli alacak ikisi de değil: hâlâ **açık** olan ve hâlâ tahsil
edilebilecek bir faturanın üzerine konan bir **değerlendirme**. Firmalar işaretli alacağı
düzenli olarak tahsil eder; görüşü kaydetmek için faturayı `open`'dan çıkarmak, o tahsilatı bir
diriliş gibi gösterirdi. Dolayısıyla nullable bir zaman damgası — 0048'in `reversed_at`'i ve
0037'nin `is_active`'iyle aynı şekil — ve §17 kural 3 N/A kalıyor çünkü ortada yaşam döngüsü yok.

Kısıtlar: üç kolon (`bad_debt_at`/`bad_debt_reason`/`bad_debt_by`) birlikte hareket eder ve
gerekçe boş olamaz — **gerekçesi ve yazarı olmayan bir zarar yazma, imzasız bir suçlamadır.**
Ayrıca iptal edilmiş faturaya bayrak konamaz (ortada borç yok); iki bayrağın farklı kod
yollarından gelip çelişmesi tam da böyle olur.

Bu kolonlar 0044'ün içerik-dokunulmazlık listesinde **bilerek yok**: düzenlenmiş faturanın
ticari içeriği donmuştur, ama tahsil edilebilirliğe dair bir değerlendirme o içeriğin parçası
değildir ve belgenin ömrü boyunca yazılabilir kalmalıdır.

### 0052 — dört read-model view

**Yalnız OLGU üretirler.** Gün cinsinden gecikme, bu karşı tarafın geçmişte gerçekte ne yaptığı,
ne kadarının açık olduğu, bir insanın bayrak koyup koymadığı. Olasılık ya da skor
hesaplamazlar — skorlama `src/lib/collections/rules.ts`'te adlandırılmış kurallar tablosu
olarak duruyor ki her sonuç onu üreten kurala kadar izlenebilsin ve o kural düzeltilerek
düzeltilebilsin. implementation.md "deterministik sezgi (ML değil)" istiyor; bir model bir mali
operatöre "neden" sorusunu yanıtlayamaz ve birini kovalayıp kovalamamaya karar verirken önemli
olan tek soru odur.

- **`receivable_collection_signals`** — açık alacak başına ham girdi. Karşı tarafın geçmişi Faz
  22'nin gerçekleşmiş tahsilat hızından geliyor (GÖZLENMİŞ değer, tahmin değil) ve bu karşı
  taraf hiç bir şey ödememişse **null** — skorlayıcı bunu "bilinmiyor" saymak zorunda, "hızlı"
  değil. `late_ratio` da gözlemdir: vadesi olmayan faturalar hesaba **katılmaz**, çünkü tarihsiz
  bir fatura geç kalamaz ve onu "zamanında" saymak karşı tarafı pohpohlardı.
- **`payment_priority_queue`** — ödeme kalemleri + alış faturaları + kredi taksitleri + çıkış
  çekleri tek listede. **MEVCUT payments modülünü besler**: sıralama girdileri `payments`'ın
  zaten taşıdığı `flexibility_class` ve `priority` kolonları, burada icat edilmiş yeni bir
  taksonomi değil — paralel bir öncelik şeması "önce neyi ödeyeceğiz" sorusuna iki cevap demek
  olurdu. View bir **SIRA** üretir, bir karar değil: nakit bakiyesini bilmez, kesme noktası
  okuma anında TypeScript'te uygulanır. Hangi tedarikçinin ödenmeyeceğine SQL'de sessizce karar
  veren bir view, iş kararını yanlış yerde vermiş olurdu.
- **`payment_calendar_extended`** — gün bazında toplam; **tutarı bilinmeyen yükümlülükler
  SAYILIR, sıfır olarak toplanmaz.** Dört tutarsız yükümlülüğü olan gün ucuz bir gün değildir.
- **`counterparty_collection_profile`** — karşı taraf karnesi; her kolon olmuş bir şeyin sayımı
  veya ortalaması, hiçbiri öngörü değil.

### Deterministik skorlama (`src/lib/collections/rules.ts`)

**Beklenen tahsilat tarihi**, ilk eşleşen kural kazanır:
1. Karşı taraf **en az 3** fatura tahsil etmişse → düzenleme tarihi + gerçekleşmiş ortalaması.
   Üç bilinçli bir alt sınır: tek faturalık ortalama bir anekdottur ve onu tahmin diye sunmak
   tam da bu fazın kaçınması gereken sahte güvendir.
2. Vade varsa → vade (karşı tarafın kendi sözü, elde kalan en iyi kanıt).
3. Hiçbiri yoksa → düzenleme + 30, **açıkça "fallback" etiketiyle**.
Sonuç ödenmemiş bir fatura için asla geçmişte olamaz; geçmişteki bir "beklenen" tarih beklenti
değil gecikme ihbarıdır. `basis` her zaman hangi kuralın çalıştığını söyler.

**Tahsilat olasılığı** taban 0.95'ten adlandırılmış ayarlamalarla iniyor; her sonuç **onu üreten
sinyalleri** birlikte döndürür. Gerekçesiz bir sayı eyleme dönüştürülemez — operatör 0.45'in
"bu müşteri yavaş" mı yoksa "geçen hafta işaretledik" mi demek olduğunu ayırt edemez ve ikisi
zıt tepkiler gerektirir. Şüpheli-alacak bayrağı her şeyi bastırır ama **sıfıra indirmez**:
işaretli alacak da tahsil edilir ve sert bir sıfır, tahsilat listesine "denemeyi bırak" derdi.

**Risk bayrakları** yalnız olgudan; yoğunlaşma eşiği deponun başka yerlerinde zaten kullanılan
**0.40** (radar/rules.ts, financing/rules.ts), neredeyse aynı şeyi ifade eden ikinci bir sayı
değil.

**Nakde duyarlı sıralama** bir öneridir: hiçbir kalem atlanmaz, karşılanamayan kalem **düşürülmez
işaretlenir** — liste operatörün pazarlık edeceği şeydir ve sığmayan kalemleri gizlemek asıl
sorunu gizlerdi. **Tutarı bilinmeyen kalemler sıralanır ama kümülatif toplama katılmaz** ve asla
"karşılanıyor" sayılmaz; onları sıfır saymak nakdin gittiğinden daha uzağa gittiğini
göstermek olurdu — bu uygulamanın yapabileceği en tehlikeli yuvarlama.

### Faz 4/5 regresyon yüzeyi

Bu faz mevcut vade/gecikme mantığını **genişletir, değiştirmez**: `payment_instances` ve
`cashflow_months` şemasına dokunulmadı, `payments`'ın öncelik kolonları olduğu gibi okundu.
`phase23:verify` radar kolonlarının yerinde olduğunu yapısal olarak kontrol ediyor;
`phase4:verify` ve `phase5:verify` gate zincirinde değişmeden koşuyor.

---

## Onay / Maker-Checker (Faz 24A, migration 0053-0055)

Bu faz **yeni bir iş alanı açmıyor**; var olan iki bağımsız inceleme sistemini tek bir Onay
varlığında topluyor. Faz 24A'nın asıl teslimatı `approvals` tablosu değil, **hiçbir eski yazım
yolunun davranışının değişmemiş olması**.

### Önce ölçüldü: ortada tam olarak ne vardı

| Sistem | Kolon | Değerler | Guard | Yazan |
|---|---|---|---|---|
| `mapping_reviews` | `status` | open · accepted · rejected · resolved | **yok** | `imports/actions.ts` + 6 gate scripti |
| `external_assumptions` | `review_status` | pending_review · approved · rejected | **yok** | `external-assumptions/engine.ts` |

İki ayrıntı taşımayı tümüyle belirledi:

1. **Hiçbirinde transition guard yok** ve altı gate scripti (`phase3`, `phase4`, `phase5`,
   `phase12a`, `phase13a`) statüyü keyfî olarak sıçratıyor — `update mapping_reviews set
   status='resolved'` satırın o an ne olduğuna bakmadan yazılıyor. Bu kolonlara guard eklemek
   altı doğrulanmış gate'i ilk keyfî sıçramada kırardı; yani 0027 hatasının bilerek tekrarı olurdu.
2. `external_assumptions.reviewed_at` **yalnız `approved`'da** taşınıyor, diğer durumlarda
   korunuyor. Bu yük taşıyan bir semantik: `external_assumptions_check1` kısıtı
   "internet kaynaklı + approved ⇒ reviewed_at dolu" diyor.

Bu yüzden **legacy kolonların hiçbiri değiştirilmedi**: guard eklenmedi, değer yeniden yazılmadı,
varsayılan oynatılmadı.

### 0053 — `approvals` + `approval_steps`

`approvals` polimorfik özneli tek onay varlığı (`subject_table` + `subject_id`); iki legacy sistem
ilk günden üye. Statü izin listesi CHECK ile **aynı migration'da**:

| Eski | Yeni | Anlam |
|---|---|---|
| pending | approved | kontrolör onayladı |
| pending | rejected | kontrolör reddetti |
| pending | reworked | düzeltilmek üzere geri |
| reworked | pending | talep eden yeniden gönderdi |
| reworked | rejected | yeniden gönderilmeden bırakıldı |

`approved` ve `rejected` **terminal**. Sessizce geri alınabilen bir karar, karar değildir; yeniden
açmak yeni bir **tur**dur (`round_no`). `phase24a:verify` 12 sıralı çiftin tamamını gerçek satırlar
üstünde deniyor: 5 kabul, 7 ret.

**`approvals_maker_is_not_checker`** — talep eden ile karar veren aynı kişi olamaz, ve bu kural
veritabanında duruyor. Yalnız server action'da duran bir maker-checker kontrolü, bir refactor
uzaklıktadır.

**`approvals_decision_consistency` neden `decided_by`'ı ZORUNLU TUTMUYOR** — bu, ölçtükten sonra
yapılmış bir düzeltme. İlk sürüm her karar için isimli bir karar verici istiyordu; 0055'in köprüsü
o zaman **legacy yazımları iptal etti**, çünkü altı gate scripti `mapping_reviews`'ı anonim
çözüyor (`set status='resolved', reviewed_at=now()`, kullanıcı yok) ve P0-A öncesi geçmiş de aynı
biçimde. Seçim, bu geçmişi boş bir karar vericiyle **doğru** temsil etmek ile kısıtı sağlamak için
bir aktör **uydurmak** arasındaydı. Faz 19'un arşiv motorundan sabit kodlanmış "Yerel kullanıcı"
fallback'i tam da bunun için kaldırılmıştı. Boş `decided_by` artık "bu karar maker-checker akışını
öncelemiş ya da atlamıştır" demek; `src/lib/approvals/engine.ts` üzerinden verilen her karar
vericisini isimlendiriyor ve `phase24a:verify` bunu **tablodan değil motordan** talep ediyor.

`approval_steps` salt-ekleme (0022 deseni: BEFORE UPDATE/DELETE/TRUNCATE trigger + REVOKE).
`audit_logs`'tan ayrı ve ikisi de korunuyor: `audit_logs` "hangi operatör ne yaptı", `approval_steps`
"BU onay buraya nasıl geldi". `approval_id` **kasıtlı olarak FK değil** — 0037 ve 0046'nın kaydettiği
gerekçe: TRUNCATE CASCADE, ON DELETE ne olursa olsun FK'ları izler ve salt-ekleme kanıtını yok eder
(`pnpm import:real` bunu Faz 21'de fiilen yaşattı).

### 0054 — `approval_rules`

Hangi durumun ikinci göz istediği **veri**, engine'lere serpiştirilmiş `if` değil. Beş varsayılan
kural yükleniyor; `amount_over_100k` eşiği `public.settings.critical_payment_threshold_try` ile
**aynı sayı** (ikinci bir eşik icat edilmedi ve `phase24a:verify` bu eşitliği kontrol ediyor).
`invoice_requires_approval` ve `payment_requires_approval` **pasif** geliyor: küçük bir ekipte her
faturayı iki kişiye bağlamak akışı durdurur ve toptan kapatılan bir kontrol panelinden kötüsü yoktur.

`approval_rules_threshold_scope` CHECK'i iki yönlü: `amount_threshold` eşiksiz olamaz, eşik de
tutara bakmayan bir kurala iliştirilemez. Sıfır eşik geçerli ("her şey onay ister"); `0` ile `null`
farklı ifadeler (CLAUDE.md).

**Statü kolonu YOK.** Bir kural aktiftir ya da değildir; `is_active` boolean'ının kısıtlanacak
geçişi yok, §17 kural 3 burada gerçekten N/A.

### 0055 — legacy köprüsü

Yön: **legacy → approvals**, AFTER trigger ile. Mevcut her yazım yolu — UI action'ı, altı gate
scripti, elle açılmış bir psql oturumu — bu tablonun varlığından habersiz onay kaydı üretiyor.
Ters yön (bir onayı karara bağlamak legacy kolonu geri yazar) `src/lib/approvals/engine.ts`
içinde ve **yalnız yeni bir yol**; daha önce çalışan hiçbir şeye dokunmuyor.

AFTER seçimi tasarımın kendisi: BEFORE trigger bir legacy yazımını düşürebilir, ki bu köprünün var
olma sebebi tam olarak bunu imkânsız kılmak.

Guard'ın reddedeceği bir legacy sıçraması (`resolved` → `open`, yani approved → pending) geldiğinde
köprü **yeni bir tur açıyor**. Bu bir kaçamak değil: çözülmüş bir incelemeyi yeniden açmak gerçekten
ikinci bir onay turudur, ve böyle modellemek hem geçmişi hem guard'ı sağlam bırakıyor.

`approval_queue` view'i tek çalışma listesi. **View, tablo değil** — ikinci bir doğruluk kaynağı
üretmemek için (Faz 22'nin `receivables/payables` kararıyla aynı gerekçe).

### Bu fazın gerçek regresyon yüzeyi

`phase24a:verify`'ın en ağır kontrolleri `approvals` hakkında değil: legacy'nin **hâlâ eskisi gibi
davrandığı** hakkında. Anonim `resolved` yazımının legacy'de başarılı olduğu, yasak sıçramanın
legacy yazımını öldürmediği, `reviewed_at` koruma semantiğinin bozulmadığı ve legacy kolonlara
guard **eklenmediği** ayrı ayrı kontrol ediliyor. Köprünün ilk iki sürümü legacy yazımlarını iptal
etti; her ikisinde de yalnız `approvals`'a bakan bir doğrulama memnun kalırdı.

---

## Tam rol matrisi ve satır-seviyesi RLS (Faz 24B, migration 0056-0058)

Planın en geniş kapsamlı fazı: 58 tablonun blanket `for all to authenticated using(true)`
politikası, beş katmanlı gerçek bir rol matrisiyle değiştirildi. Hiçbir blanket politika sessizce
bırakılmadı — `db:roles-rls:verify` kalan sayısının **sıfır** olduğunu kontrol ediyor.

### Mimari karar: GUC değil, GERÇEK veritabanı rolleri

Uygulama tek bir login rolüyle bağlanıyor (`mas_radar_app`, Faz 15), dolayısıyla veritabanı kendi
başına bir izleyicinin isteğini bir yöneticininkinden ayıramaz. İki seçenek vardı: politikaların
okuduğu bir oturum değişkeni (GUC) ya da bağlantının içine geçtiği gerçek roller. Gerçek roller
seçildi, çünkü `to <role>` PostgreSQL'in politika eşleştiricisinin zaten üzerine kurulu olduğu
mekanizma: kontrol planlayıcıda, her ifadede, gelecekteki bir politika yazarının eklemeyi
unutabileceği bir ifade olmadan yapılıyor.

**Kalıtım tuzağı ve onu çözen PG16 özelliği.** Politikalar bağlanılan kimliğe değil rol
**üyeliğine** göre eşleşiyor. Düz bir `grant mas_radar_viewer to mas_radar_app` uygulamayı beş
katmanın da üyesi yapardı; yani her katmanın politikalarının **birleşimini** sağlardı — kalıcı
olarak admin. PostgreSQL 16 üyeliğin iki yarısını ayırıyor:

    grant mas_radar_viewer to mas_radar_app with inherit false, set true;

Tasarıma bağlanmadan önce bu kümede ölçüldü: `SET ROLE` yapılmamış bir uygulama bağlantısı,
yalnız katman politikaları taşıyan bir tablodan **sıfır** satır görüyor; `set role` sonrası
katmanın politikaları tam olarak uygulanıyor; `reset role` sonrası yine sıfıra dönüyor. Son
özellik havuzlanmış bağlantıda güvenliğin temeli: sızan bir rol checkout'u aşamaz, çünkü reset
bağlantıyı hiçbir şey okuyamayan bir kimliğe geri bırakıyor.

**Bunun bedeli, açıkça:** 0058'den sonra katmana geçmemiş `mas_radar_app` iş tablolarını
okuyamaz. Bu kasıtlı. Meşru olarak geçişsiz çalışan tek yol giriş/oturum sorguları; onlar Faz
15'in users/sessions üzerindeki `mas_radar_app` hedefli politikalarını kullanmaya devam ediyor.

### 0056 — `users.role` beş katmana genişledi

| Eski | Yeni | Gerekçe |
|---|---|---|
| `admin` | `admin` | Değişmedi. |
| `operator` | **`finance_manager`** | `finance_operator` DEĞİL. |

İsim benzerliği `operator → finance_operator` diyor ama bu **yanlış** olurdu. Bugün `operator`
"admin sayfaları dışında her şey": ödeme girme, inceleme çözme, senaryo çalıştırma ve Faz 24A'nın
onaylarını karara bağlama. Yeni matriste `finance_operator` **onaylayamaz**. Bu eşleme, her mevcut
hesabın günlük kullandığı bir yetkiyi sessizce **geri alırdı**; ilk belirti kendi onay kuyruğunu
temizleyemeyen bir operatör olurdu. Bir migration operatörün seçtiği kısıtlamaları ekleyebilir;
bir hesabın zaten sahip olduğunu sessizce alamaz. `finance_manager` bugünkü davranışı birebir
koruyor. Daha dar olması gereken herkes güvenlik ekranından **bilinçli** olarak indirilebilir —
denetim kaydına düşen, insanın verdiği bir karar.

Yeni hesap varsayılanı `operator`'dan **`viewer`**'a düştü (en az yetki); mevcut hiçbir satırı
değiştirmez.

### 0057 — katman başına bir PostgreSQL rolü

Beş rol (`mas_radar_viewer` … `mas_radar_admin`), hepsi **NOLOGIN**: kimse bir katman *olarak*
bağlanmaz, katmanlar yalnız içine geçilmek ve politikalarca adlandırılmak için var. Hepsi
`authenticated` üyesi olduğundan 0035'in tablo GRANT'lerini devralıyorlar — GRANT komutun
denenebilir olup olmadığına, politika hangi satıra dokunabileceğine karar veriyor; ikisi de gerekli.

İki yardımcı fonksiyon: `current_app_user()` (`app.user_id` GUC'undan; satır-seviyesi kurallar
kişiyi bilmek zorunda, SET ROLE yalnız katmanı söyler) ve `current_app_role()`. İkisi de
`current_setting(..., true)` kullanıyor: ayar yoksa **NULL** döner, ve politikalar NULL'ı "hiçbir
şeyle eşleşmez" olarak okur, asla joker olarak değil.

### 0058 — sınıf bazlı politikalar

61 tablo × 5 katman × 4 komut = binden fazla karar. Hepsini tek tek yazan bir migration
incelenemez olurdu — yanlış hücrenin saklanacağı yer tam olarak orasıdır. Bunun yerine her tablo
**tek bir erişim sınıfına** atandı, politikalar bu atamadan üretiliyor:

| Sınıf | Tablo | viewer | finance_operator | finance_approver | finance_manager | admin |
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
| `ledger` (`schema_migrations`) | 1 | — | — | — | — | — |

(S=select, I=insert, U=update, D=delete)

Dikkat çeken hücreler ve gerekçeleri:

- **`evidence` hiç kimseye UPDATE/DELETE vermiyor, admin dahil.** Bu tablolar 0022 deseniyle
  zaten salt-ekleme; RLS'in trigger ile aynı şeyi söylemesi, reddin iki katmandan hangisinin
  değiştiğine bağlı kalmamasını sağlıyor.
- **`finance_approver` `approvals`'a INSERT edemiyor** — talep açmak veri girişidir; kararını
  verdiği talepleri kendisi açabilen bir onaylayıcı, yalnız isimde bir maker-checker ayrımıdır.
  Bunu **gate yakaladı**: kod matrisi başta `ENTER` diyordu, migration doğruyu söylüyordu.
- **`approval_rules` yalnız admin'e yazılıyor, manager'a değil.** Kendi onaylarını yöneten eşiği
  indirebilen bir yönetici, maker-checker tasarımını bir ayar ekranından çözerdi.
- **`sessions`'a hiçbir katman yazamıyor**, admin dahil. Oturumları giriş yolu yazıyor (geçişsiz,
  `sessions_app_runtime` üzerinden); yazabilen bir katman başka bir hesap adına oturum basabilirdi.
- **`schema_migrations` politikasız** (0020/0035, değişmedi) — ledger yalnız owner'ındır.

### Satır seviyesi: dürüstçe kapsanmış

Plan `finance_operator`'ın "kendi girdiği kayıtları" düzenlemesini öneriyor. Bu bir sahiplik
kolonu gerektiriyor ve **61 tablonun yalnız 8'inde** var — varsayılmadı, ölçüldü. Diğer 53'e
`created_by` ekleyip NULL doldurmak, sahiplik politikası altında **hiçbir operatörün hiçbir
geçmiş kaydı düzenleyememesi** demekti: sıkılaştırmanın değerinden çok daha büyük bir erişim
kaybı ve mali geçmişin yazarlığının sessizce yeniden yazılması. Bu yüzden sahiplik, verinin
desteklediği yerde uygulanıyor:

- `action_items`, `invoice_allocations`, `scenarios` — operatörün UPDATE'i `created_by =
  current_app_user()` ile sınırlı; manager/admin sınırsız (yazarı ayrılmış bir kaydı birinin
  düzeltebilmesi gerekir).
- `approvals` — onaylayıcı **kendi talebini** güncelleyemiyor (`requested_by is distinct from
  current_app_user()`). Faz 24A bunu bir CHECK'e koymuştu; bu, aynı kuralı bir katman altta
  tekrarlıyor: kısıt geçerli satırın neye benzediğini, politika satıra kimin ulaşabileceğini
  söyler. NULL `requested_by` (24A'nın anonim legacy geçmişi) güncellenebilir kalıyor.
- `users`/`sessions` — katman yalnız **kendi** satırını görüyor (`users_self_read`).

### Faz 15'in giriş akışı: genişletildi, değiştirilmedi

`users_deny_all`/`sessions_deny_all` (0031) ve `users_app_runtime`/`sessions_app_runtime` (0035)
**aynen** duruyor; gate dördünü de hedef rolleriyle birlikte kontrol ediyor. Eklenen tek şey
isteğin diğer yarısı: runtime bir katmana geçtikten sonra `current_user` artık `mas_radar_app`
değil, dolayısıyla `app_runtime` eşleşmeyi bırakıyor ve aynı istekteki sonraki her
`requireSession()` okunabilir kullanıcı satırı bulamazdı. `users_self_read`/`sessions_self_read`
tam olarak bu kadarını geri veriyor: tabloyu değil, **kendi satırını**.

Uygulama tarafında `src/lib/db.ts` artık iki havuz tutuyor — `getPool()` (her checkout'ta katmana
geçer) ve `getRawPool()` (giriş/oturum, geçişsiz). Ayrı örnekler olmaları güvenlik argümanının
kendisi: scoped havuzdaki fiziksel bağlantı checkout'lar arasında katman rolünü taşıyabilir,
raw havuzdaki asla taşıyamaz.

### `migrate.ts` ANCHORS: 0007 çapası ONARILDI (eklenmedi)

0007 çapası `payments_authenticated_all` politikasını arıyordu; 0058 o politikayı kasıtlı olarak
düşürüyor. Sonuç: 0058'den sonra çapa, 0007'nin açıkça çalıştığı bir veritabanında "çalışmamış"
diyordu. Bu kozmetik değil — `LEDGER_EMPTY_RECOVERY` ledger'ı boş bir veritabanının
legacy-complete olup olmadığına çapalara bakarak karar veriyor ve on dokuz geçen çapa arasında
bir tanesinin kalması tam olarak hard-fail eden `INCONSISTENT_PARTIAL` durumu. Herhangi bir 24B
veritabanının ham geri yüklemesi migrate etmeyi reddederdi.

0007 iki şey yapıyor: her tabloda RLS'i **açıyor** ve blanket politikaları yaratıyor. 24B yalnız
ikincisinin yerine geçiyor. Çapa artık kalıcı yarıyı parmak izi alıyor
(`payments.relrowsecurity`) — aynı soruyu soruyor, ve hem 24B öncesinde hem sonrasında doğru
cevaplıyor. **Dizi uzamadı**: aynı sayıda, aynı versiyonlar.

---

## Tahsilat Merkezi (Faz 25, migration 0059-0061)

Bu faz tek bir ayrımın üzerine kurulu: **bir söz, bir alacak değildir.** `invoices` bir
yükümlülüğü kaydeder; `promise_to_pay` bir telefon görüşmesinde söylenmiş bir cümleyi kaydeder.
Ayrı tablolarda durmalarının sebebi tam olarak budur — söz muhasebe ağırlığı taşımaz, üzerine
dağıtım yapılamaz, hiçbir faturanın bakiyesini değiştirmez. Var olma sebebi, ikisi arasındaki
farkın ölçülebilmesidir.

### 0059 — `promise_to_pay`

Neden `action_items` üzerine binmedi: plan tahsilat **notlarının** mevcut görev modelini
kullanmasını ve ikinci bir görev modeli icat edilmemesini şart koşuyor, ve bu faz buna uyuyor —
kırılan sözün doğurduğu takip işi bir `action_item` (0060 `source_type`'ı bunun için genişletiyor).
Ama sözün kendisi bir görev değil: karşı tarafı, tutarı, gerçekle karşılaştırılan bir **tarihi** ve
bir puana beslenen bir sonucu var. `action_item` olarak modellemek bunların hepsini `note` alanına
sıkıştırmak ve serbest metne kaybetmek olurdu.

Kolonların taşıdığı kararlar:

- **`promised_amount` NULL olabilir** — "haftaya bir şeyler gönderirim" gerçek bir sözdür ve
  0,00 TL olarak kaydetmek bu kolonu toplayan her view'da maruziyeti olduğundan küçük gösterirdi.
  NULL = bilinmiyor, 0 = açıkça hiç (CLAUDE.md).
- **`promised_date` NOT NULL** — tablonun tamamı bu kolonu bugünle karşılaştırmak için var;
  tarihsiz bir söz ne tutulabilir ne kırılabilir.
- **`invoice_id` NULL olabilir** — müşteriler rutin olarak belge adı vermeden bakiye üzerine söz
  verir; zorunlu kılmak ya bunu engeller ya da yanlış bir tahmine davet ederdi.
- **`resolved_by` NULL olabilir** — Faz 24A dersinin tekrarı: kırılan söz tespit işinin arkasında
  oturum açmış bir kullanıcı yok. Aktör zorunlu olsaydı iş bir tane **uydurmak** zorunda kalırdı.
  NULL burada "bunu bir insan kararlaştırmadı" demek; `resolution_source` hangi mekanizmanın
  kararlaştırdığını söylüyor (`manual` / `auto_detection`).

#### Durum izin listesi (CHECK ile AYNI migration'da)

| Eski | Yeni | Anlam |
|---|---|---|
| pending | kept | para geldi |
| pending | broken | tarih geçti, para gelmedi |
| pending | cancelled | söz tarihinden önce geri çekildi |
| **broken** | **kept** | **geç ödeme — atlanması en kolay olan** |

`broken → kept` gerçekten önemli: geç ödeme, kırılan bir sözün **olağan** sonucudur, istisnası
değil. Bu geçiş olmasaydı üç gün geç ödeyen müşteri sonsuza kadar `broken` olarak donar ve bu
tabloya dayanan her puan onu kalıcı olarak olduğundan kötü gösterirdi.

`kept` ve `cancelled` terminal. Karara bağlanmış bir sözü yeniden açmak tahsilat geçmişini
sessizce yeniden yazmak olurdu; dürüst yol **yeni bir söz** kaydetmektir — ki puanın görmesi
gereken de zaten budur.

Guard 0027'nin dersiyle yazıldı: izin listesi CHECK'in tamamına karşı kuruldu, bugün işe yarayan
geçişlere göre değil. `phase25:verify` 12 sıralı çiftin tamamını gerçek satırlar üstünde deniyor
(4 kabul, 8 ret) ve ayrıca koddaki `canTransition` ile birebir aynı olduğunu kanıtlıyor.

#### `promise_to_pay_open_unique` ve NULLS NOT DISTINCT

Aynı cari + aynı tarih için ikinci bir **açık** söz engelleniyor. `nulls not distinct` burada
kozmetik değil: sözlerin çoğunda `invoice_id` NULL ve varsayılan kuralda her NULL benzersiz
sayıldığı için indeks **en yaygın durumda hiçbir şeyi korumazdı**.

#### RLS: Faz 24B'nin `operational` sınıfı

Yeni tablo blanket politikayla değil, 24B'nin beş katmanlı modeliyle yazıldı: `viewer` okur,
`finance_operator` girer ve düzeltir, `finance_manager`/`admin` ayrıca siler. Sınıf 0058'in kendi
mantığından seçildi (payments/invoices ile aynı sınıf) ve `src/lib/authz/matrix.ts` aynı
sınıflandırmayı taşıyor — `db:roles-rls:verify` ikisini canlı veritabanında çalıştırıp
uyuştuklarını kanıtlıyor.

**Kasıtlı olarak owner-scoped DEĞİL**, `action_items`'ın aksine: tahsilat ekip işidir, para
geldiğinde telefonu kim açtıysa sözü "tutuldu" işaretleyebilmeli — sözü meslektaşı kaydetmiş
olsa bile. Düzenlemeyi kaydı girene kilitlemek, biri izinliyken sözlerin `pending` takılı
kalması demekti; erişim maliyeti sıkılaştırmanın değerinden büyük.

### 0060 — iki CHECK enum'unun genişletilmesi (başka hiçbir şey yapmayan bir migration)

Faz 22'nin kuralı: enum CHECK genişletmesi kendi açık migration'ını alır. Gerekçe denetlenebilirlik
— bu iki ifade şemanın **geri kalanının** bundan sonra neyi kabul edeceğini değiştiriyor.

- `reminders.target_kind`: 3 → 5 (`invoice`, `promise_to_pay` eklendi).
- `action_items.source_type`: 6 → 7 (`collection` eklendi). **Tek değer**, üç değil:
  `related_entity_table`/`related_entity_id` çifti zaten neyle ilgili olduğunu, `severity` zaten
  aciliyeti söylüyor; sınıflandırmayı enum'a itmek her değişikliği bir migration'a bağlardı.
- `reminders.channel` **zaten** 0006'dan beri `('telegram','email')` içeriyordu — ölçüldü,
  varsayılmadı. Faz 25 kanal değerini değil **taşıyıcıyı** ekliyor, bu yüzden burada bilerek ALTER
  yok; yokluğun bir bulgu olarak okunması için migration içinde açıkça yazılı.

İki genişletme de eski değer kümesinin **üst kümesi**, dolayısıyla mevcut hiçbir satırı
geçersizleştiremez — dolu bir veritabanında güvenle çalışmalarının ve NOT VALID + sonradan
doğrulama yerine doğrudan değiştirilmelerinin sebebi bu.

### 0061 — üç read-model, hepsi VIEW

Faz 19/22/23'ün kaydettiği gerekçe aynen geçerli: saklanmış bir puan, bir fatura kapandığı anda
bayatlayan ikinci bir doğruluk kaynağıdır ve bayatlığı görünmez, çünkü sayı hâlâ sayı gibi durur.

- `promise_to_pay_open` — açık sözler + `days_late`. Kolon adı bilerek `days_overdue` değil:
  faturanın gecikmesiyle karıştırılmamalı, ekran ikisini birlikte gösteriyor.
- `party_promise_history` — cari başına tutulan/kırılan sayıları ve `kept_ratio`.
  **`cancelled` orandan dışlanıyor**: geri çekilmiş bir söz, müşterinin ödeyip ödemediği hakkında
  hiçbir şey söylemez. **Hiç çözülmemişse oran NULL**, 0 değil — hiç söz vermemiş müşteri, sözünü
  tutmayan müşteri değildir.
- `customer_collection_score` — 100'den başlayıp **adlandırılmış** kurallarla düşen puan.

#### Puan: deterministik ve adlandırılmış, asla öğrenilmiş değil

Her düşüş bir kuraldır ve adı `score_reasons` içinde sayıyla birlikte taşınır. Bu Faz 23'ün
kuralı ve sebebi şu: tahsilat puanı bir müşteriye karşı bir kararı gerekçelendirmek için
kullanılır. "82, çünkü iki söz kırıldı ve en eski fatura 47 gün gecikmiş" savunulabilir; çıplak
bir 82 savunulamaz.

| Kural | Ceza |
|---|---|
| `gecikmis_fatura_yasi` | 90+ gün 30 · 60+ 20 · 30+ 12 · 1+ 5 |
| `suepheli_alacak` | 25 |
| `tutulmayan_odeme_sozu` | oran <0.34 → 25 · <0.67 → 15 · <1.00 → 7 |
| `gec_odeme_aliskanligi` | late_ratio ≥0.75 → 15 · ≥0.50 → 10 · ≥0.25 → 5 |

Bantlar: ≥85 `good`, ≥60 `watch`, ≥35 `risk`, altı `critical` — eşikler tek yerde, ekran kendi
renklendirmesini icat edemesin diye. Aritmetik baştan sona `numeric`; hiçbir yerde `::float8` yok
(Faz 17).

**Söz geçmişi olmayan cari cezalandırılmıyor**: `kept_ratio` NULL ise ceza 0. Yeni bir karşı
tarafı geçmişi olmadığı için cezalandırmak, kanıt yokluğunu kanıt saymak olurdu.

### Kırılan söz tespit işi

`detectBrokenPromises(pool, todayISO, actorId)` — vadesi geçmiş bekleyen sözleri `broken`
işaretler ve her biri için bir `action_item` açar.

**Neden bu otomatik olabiliyor da şüpheli alacak olamıyor** (CLAUDE.md sınırı): ikisi farklı türde
olgu kaydediyor. Şüpheli alacak paranın **asla gelmeyeceği yargısıdır** ve bir insan ister. Kırılan
söz, **bir tarihin geçtiği ve paranın gelmediği gözlemidir** — kimsenin görüşü işin içinde değil ve
altta yatan olgu bu iş çalışsa da çalışmasa da zaten doğru. İş yine de hiçbir mali kaydı
değiştirmiyor: faturaya, tutara, vadeye, ödemeye dokunmuyor; söz tablosuna bir durum yazıyor ve
bir insana görev açıyor. Her kayıt `automated: true` ile denetleniyor.

**İdempotent, iki bağımsız yolla**: söz UPDATE'i `status='pending'` filtreliyor, ve action_item
INSERT'i 0015'in kısmi unique indeksine dayanıyor (açık görev varken aynı kayda ikincisi açılamaz).

**Sınır `<`, `<=` değil**: bugün vadesi olan söz kırılmış sayılmaz — paranın günün geri kalanı
var. Sabah 09:00'da kırılmış diyen bir iş, henüz olmamış bir başarısızlığı kaydederdi. İşin tüm
doğruluğu bu tek karakterde.

`todayISO` içeriden saatten okunmuyor, parametre — gate'in tarihi sürüp kesin davranış iddia
edebilmesi için.

### Hatırlatma hedef türleri ve e-posta kanalı

`targetKindOf()` artık **açık bir eşleme**: tanımadığı tablo için `null` döner. Önceden tanımadığı
her şey için `'loan_installment'` dönüyordu — üç tür varken zararsız, dördüncü eklendiği anda her
faturayı ve her sözü sessizce kredi taksiti diye dosyalayacak bir fallthrough.

`OPEN` tek bir küme (`unpaid`/`partial`) idi; artık **tür başına**. Bu kelimeler fatura ve söz
sözlüğünde yok (açık fatura `open`, bekleyen söz `pending`), dolayısıyla tek kümeyi korumak her
faturayı ve her sözü kalıcı olarak uygunsuz yapardı — hiçbir şey hatırlatmayan bir hatırlatma
motoru, fark edilmesi en zor arıza.

**Bulunduğu gibi bırakılan, sessizce yarım düzeltilmeyen bir eksik**: `check` ve
`loan_installment` türleri 0006'dan beri CHECK'te izinli ama hiçbir zaman hedef yükleyicileri
olmadı, yani bu türdeki kurallar her zaman sıfır teslimat üretti. Faz 25 tahsilatın ihtiyaç
duyduğu iki türü ekliyor; çek ve kredi taksiti bağlamak finansman işidir ve buraya kaçak
sokulmaz.

**E-posta taşıyıcısı kasıtlı olarak SMTP istemcisi DEĞİL.** Bu depo bu ortamda çalışan dış ağ
çağrısı yapmıyor; nodemailer + bir kimlik kümesi eklemek, burada hiç çalıştırılamayacak bir kod
yolu için bir bağımlılık ve sızacak bir sır eklemek olurdu. Telegram deseni birebir izlendi: env
ile adlandırılmış HTTP uç noktası, tanımsız/erişilemezken **fırlatmayan** başarısız
`DeliveryResult`, ve gerçek davranışın `mockTransport({ channel: "email" })` ile sınanması.
`mockTransport` artık kanalı parametre alıyor — `"telegram"` sabit kodluydu ve e-posta yolu var
olduğu anda onu test edilemez kılardı.

---

## Hazine / Likidite Merkezi (Faz 26, migration 0062-0063)

Hazine yeni bir defter değil, mevcut veriye bakan bir **mercek**. 0063 hiçbir yeni kaynak veri
üretmiyor: Faz 20'nin `bank_accounts`/`bank_transactions`'ı, üzerine oturdukları `cash_accounts`,
tarihli yükümlülükler (`payment_instances`, `checks`, `loan_installments`, `invoices`,
`promise_to_pay`) ve Faz 4/5'in `cashflow_months`'u — hepsi zaten var.

### 0062 — `treasury_policies`: eşik kod değil VERİ

Plan "yapılandırılabilir nakit tamponu eşiği" istiyor ve belirleyici kelime *yapılandırılabilir*.
TypeScript sabitine gömülü bir taban, yalnız bir geliştiricinin değiştirebileceği bir sayıdır —
hazine kararı için yanlış sahip. Faz 24A'nın `approval_rules` emsali izlendi: kural bir satırda
durur, motor okur, değiştirmek denetlenen bir operatör işlemidir.

**İkinci bir sayı icat EDİLMEDİ.** `settings.negative_cash_threshold_try = 0` zaten var — Faz 4/5
projeksiyonunun "kasa eksiye düştü" saydığı taban. Tohumlanan varsayılan `min_cash` politikası bu
yüzden 0 ve `phase26:verify` bu eşitliği kontrol ediyor (Faz 24A'nın `amount_over_100k` ↔
`critical_payment_threshold_try` kontrolüyle aynı desen). Tabanı sıfırın üstüne çıkarmak zaten
tampon politikasının varlık sebebi, ve artık bir satır düzenlemesi.

İki tür, fazlası değil: `min_cash` (mutlak taban) ve `buffer_days` (ortalama giderin N günü).
Konsantrasyon limiti bilinçli olarak yok — Faz 23 karşı taraf konsantrasyonunu zaten puanlıyor ve
buraya eklemek aynı soruya ikinci bir cevap yeri açardı.

**Yaşam döngüsü kolonu YOK ve bu ölçülerek iddia ediliyor.** §17 kural 3 (her yaşam döngüsü
varlığına gün-1'den transition guard) burada gerçekten N/A: politika ya aktiftir ya değildir,
`is_active` boolean'ının kısıtlanacak ara durumu yok. 0054'ün `approval_rules` için kaydettiği
gerekçenin aynısı; `phase26:verify` `status`/`state`/`lifecycle` kolonu olmadığını **yapısal
olarak** kontrol ediyor, yalnız yorumda iddia etmiyor.

Kapsam CHECK'i iki yönlü (`treasury_policies_kind_scope`): `min_cash` tutarsız, `buffer_days`
günsüz olamaz; eşik onu okumayan bir türe iliştirilemez. **Sıfır taban geçerli** ("sıfırın altına
inme") — 0 ile NULL farklı ifadeler ve varsayılan tam olarak sıfırdır.

`treasury_policies_active_unique` (NULLS NOT DISTINCT): aynı kur+hesap için ikinci bir **aktif**
politika olamaz. Olsaydı view hangi tabanı seçeceğini bilemez, planlayıcının döndürdüğü ilk satırı
sessizce kullanırdı.

**RLS: `config` sınıfı** — `settings` ile aynı. Her katman okur (taban, bir uyarının neden
göründüğünü açıklar), yalnız admin yazar. Bilerek yöneticiye açık değil: kendi likidite
uyarılarını yöneten tabanı indirebilen bir yönetici, soruyu cevaplamak yerine alarmı kapatıyor
olurdu — 0058'in `approval_rules`'u admin'e sabitlerken kullandığı argümanın aynısı.

### 0063 — altı read-model, hepsi VIEW

**Para birimleri ASLA netleştirilmiyor.** Her pozisyon kur bazında gruplanıyor ve hiçbir view
kurlar arası toplama yapmıyor. Faz 27'ye kadar kur tablosu yok; burada TRY ile EUR'yu toplamak bir
kur **icat etmeyi** gerektirirdi ve sessizce kur icat eden bir hazine ekranı, iki satır gösteren
ekrandan kötüdür.

1. **`bank_cash_position`** — "bu hesapta ne kadar var" sorusunun **iki dürüst cevabı** yan yana:
   `stated_balance` (bankanın son ekstrede söylediği) ve `derived_balance` (açılış + içe
   aktarılmış hareketler). Farkı `stated_minus_derived` olarak açıkça hesaplanıyor. Birini sessizce
   seçmek, bu fazın uyarıldığı arıza türünün ta kendisi olurdu. `ignored` hareketler türetilen
   bakiyeye girmiyor (0042: onlar açıkça para değil), ama `unmatched` giriyor — eşleştirme bir
   belgeye bağlamakla ilgilidir, hareketin gerçekleşip gerçekleşmediğiyle değil.
2. **`daily_cash_movement`** — günlük giriş/çıkış/net ve kur bazında pencere fonksiyonuyla
   yürüyen pozisyon (saklanan kolon değil: sayı, hesaplandığı satırlardan sapamamalı).
3. **`treasury_position_summary`** — kur bazında toplamlar, `available_now` (bloke düşülmüş) ve
   `available_with_overdraft`.
4. **`liquidity_forecast_daily`** — her satır zaten başka bir yerde kayıtlı, **tarihli, bilinen**
   bir yükümlülük ya da beklenti. Trend uydurmuyor. `certainty` sütunu sözleşmeli yükümlülüğü
   müşterinin beyanından ayırıyor: Faz 25'in ödeme sözü dahil, çünkü hazineci onunla plan yapar —
   ama imzalı bir taksitle aynı ağırlıkta toplanmamalı. **Tutarı bilinmeyen söz tahmine hiç
   girmiyor**, sıfır olarak değil.
5. **`treasury_liquidity_gap`** — 7/30/90 **GÜN**. İki projeksiyon birden döndürüyor:
   `projected_contracted` (yalnız yükümlülükler, muhafazakâr) ve `projected_expected` (sözlere de
   inanan). **Taban ihlali SÖZLEŞMELİ rakamla yargılanıyor** — bir müşteri sözü alarmı
   susturamamalı. `financing_need` asla negatif değil (taban aşılmışsa fark, değilse 0), böylece
   toplanabilir.
6. **`treasury_cashflow_reconciliation`** — aşağıya bakın.

### Tutarlılık kuralı: sapma **bildirilir**, düzeltilmez

Planın gate şartı burada tek seferlik bir assertion değil, birinci sınıf bir read-model:
hazine pozisyonu `cashflow_months.closing_balance`'tan **sessizce sapmamalı**.

İki rakam gerçekten farklı yerlerden geliyor — biri gözden geçirilmiş aylık workbook projeksiyonu,
diğeri içe aktarılmış banka hareketlerinin toplamı — dolayısıyla **farklı olabilirler ve sık sık
meşru şekilde olurlar** (ekstresi henüz aktarılmamış bir ay, ayın tamamı kadar farklı çıkar).

View bu yüzden onları **mutabık kılmıyor**: ortalamıyor, birini tercih etmiyor, "düzeltmiyor".
Yan yana koyuyor, farkı ve dört durumdan birini (`aligned` / `divergent` / `cashflow_missing` /
`no_bank_movement`) veriyor. Başka her davranış, CLAUDE.md'nin doğrudan yasakladığı şey olurdu:
belirsiz satırlardan nihai gerçeği çıkarmak.

Tolerans 1,00 TL ve `findContinuityIssues`'un mevcut yuvarlama payıyla **aynı** — hazine "yeterince
yakın"ın ikinci bir tanımını icat etmiyor. Aynı karar `src/lib/treasury/rules.ts` içindeki
`reconciliationVerdict` ile TypeScript tarafında da hesaplanıyor; `phase26:verify` ikisini aynı
fixture üstünde çalıştırıp **birebir aynı** olduklarını kanıtlıyor (üç ay: uyumlu, sapan,
hareketsiz).

### Faz 5 motoru GENİŞLETİLDİ, çatallanmadı

`src/lib/treasury/rules.ts` aylık primitifleri `@/lib/radar/rules`'tan **içe aktarıyor** —
`buildProjection` hâlâ "hangi ayda bakiye ilk kez eksiye düşer" sorusunu cevaplıyor; bu modül
hazinenin gerçekten sorduğu kısa ufuk sorusunu ekliyor: "önümüzdeki 7, 30, 90 **GÜN**de tabanı
koruyacak mıyım". Aynı yükümlülükler, bilinmeyen değerler için aynı kurallar, farklı pencere.

Bölüm bilinçli:
- `radar/rules.ts` → **aylar**, `cashflow_months`'tan (gözden geçirilmiş workbook projeksiyonu)
- `treasury/rules.ts` → **günler**, tarihli yükümlülüklerden (fiilen hareket etmesi planlanan)

Örtüştükleri yerde aynı fikirde olmalılar, ve `reconciliationVerdict` anlaşmazlığın **düzeltilmek
yerine bildirilme** biçimi. `phase26:verify` `treasury/rules.ts`'in `radar/rules`'tan import
ettiğini kaynak seviyesinde kontrol ediyor — "paralel motor icat etme" kuralı böylece iddia değil,
test.

Ufuk penceresi **yarı açık**: `[bugün, bugün+N)`. Tam N gün sonraki bir akış bir sonraki ufka ait,
iki kez sayılmaz; bugünkü akış **dahil** (bu sabah hareket eden para bugünün likiditesidir).

`bufferDaysFloor` gider geçmişi yoksa **null** döndürüyor, 0 değil: 0 "tampon gerekmiyor" diye
okunur ve ikisinden tehlikeli olanı odur. İki taban da aktifse `effectiveFloor` **yükseğini**
seçiyor — ikisi de asgari, düşüğü sağlamak diğerini ihlal bırakır.

---

## Finansman Genişletme ve Kur Riski (Faz 27, migration 0064-0067)

### 0064 — `credit_facilities`: borçlanma **izni**, borcun kendisi değil

Tasarımdan önce ölçüldü. `loans` **sabit planlı** bir enstrüman: `principal`, `term_months`,
`installment_count`, `first_payment_date` ve tek bir `installment_amount` taşıyor, ve 0005 tüm
amortismanı yaratıldığı anda `loan_installments`'a materyalize ediyor. Bu kolonların hepsi
**paranın zaten alındığını ve geri ödeme tarihlerinin bilindiğini** varsayıyor.

Bir limit bunların hiçbirini varsaymaz. O bir **tavan** — bankanın çekim yapma izni — ve
tanımlayıcı durumları "ne kadar alabiliriz" ile "ne kadar aldık". Bir limit bir yıl boyunca sıfır
kullanımda durabilir ve yine de hazine ekranındaki en önemli sayı olabilir, çünkü **henüz
borçlanılmadan var olan likidite**dir. Bunu bir kredi olarak modellemek, kimsenin çekmediği para
için sahte bir anapara ve sahte bir taksit planı uydurmayı gerektirirdi.

İkisi buluşuyor: rotatif bir limitten çekim yapmak çoğu zaman kendi planı olan bir **kredi
yaratır**. Bu ilişki `facility_drawdowns.loan_id` (nullable FK) — birleştirilmiş tablo değil.

**Kasıtlı olarak SAKLANMAYAN:** `drawn`, `available`. İkisi de çekim satırları üzerinde toplam ve
0067'de view kolonu olarak veriliyor. Saklanan bir kullanım rakamı bir sonraki çekimde bayatlar ve
yanlışken gayet makul görünür.

Türler arasında `guarantee_letter` (teminat mektubu) ve `letter_of_credit` **gayrinakdî**: hiç
nakit üretmeden limit tüketirler, ki aynı tavana karşı izlenmelerinin sebebi tam olarak budur.

#### Durum izin listesi (CHECK ile AYNI migration'da, 0027 dersi)

Sekiz geçiş; ikisi atlanması kolay olduğu için ayrıca yazılıyor:

| Eski | Yeni | Neden önemli |
|---|---|---|
| suspended | expired | **Dondurulmuş limit de yaşlanır.** Bu olmasaydı her donmuş hat, vadesi geçtiğinde sonsuza kadar `suspended` kalırdı. |
| expired | active | **Yenileme.** Bankalar yıllık limitleri rutin olarak yeniler; bunun yerine yeni satır açmak limiti kendi çekim geçmişinden koparırdı. |

`closed` terminal; `expired → suspended` reddediliyor (çoktan sona ermiş bir şeyi dondurmak kimsenin
aksiyon alamayacağı bir durum). Gate 12 sıralı çiftin tamamını gerçek satırlarda deniyor: 8 kabul,
4 ret, ve koddaki `canTransition` ile birebir aynı olduğu ayrıca kanıtlanıyor.

`facility_drawdowns.signed_amount` **generated**: işareti `movement_type` taşıyor, operatörün elle
eksi yazmasına bırakılmıyor.

### 0065 — teminat ve kovenantlar

İkisi de **ya bir krediye ya bir limite** bağlanıyor ve bağ, tam olarak birinin dolu olmasını
zorlayan CHECK ile **iki nullable FK** — polimorfik (tablo, id) çifti değil. 0053 approvals'ta
polimorfizm kullandı çünkü yedi ilgisiz tabloyu kapsıyordu ve hiçbir FK bunu yapamazdı. Burada tam
iki hedef var ve ikisi de gerçek tablo, yani gerçek FK mümkün — ve gerçek bir FK simetriden değerli:
artık var olmayan bir krediyi işaret eden kovenantı engeller.

`collateral_records.value_amount` NULL olabilir: **değerlenmemiş, değersiz değil**. Değerlemeyi kimin
yaptığı da kayıtlı (`valuation_source`) — bankanın ekspertizi ile sahibin tahmini aynı iddia değildir.

**Kovenant kaydı MADDEnin kendisi, ölçüm değil.** Yaşam döngüsü bu yüzden üç durumlu: madde
yürürlükte, banka tarafından muaf tutulmuş, ya da kalkmış. Uyumlu olup olmadığımız bir **test
sonucudur** ve test sonuçları veri kolonu (`last_test_date` / `last_test_result`), yaşam döngüsü
durumu değil — aksi hâlde rutin aylık bir testin geçip kalması, maddeyi sahibi olmadığı bir durum
makinesinde sürüklerdi. `waived → active` izinli: **muafiyetler süreli verilir**, ve bu geçiş
olmasaydı madde kalıcı olarak muaf görünürdü — ki unutulan kovenant tam olarak odur.

### 0066 — FX: gözlemlenen kurlar ve taşınan pozisyon

İki tablo, bilinçli olarak farklı karakterde:

- **`fx_rate_snapshots` bir GÖZLEM.** "21.08.2026'da TCMB USD/TRY satış kuru X idi." Bu tarihsel bir
  olgudur ve **SALT-EKLEME** (0022 deseni: trigger + REVOKE + Faz 24B `evidence` sınıfı). Sonradan
  düzenlenebilen bir kur, üzerine kurulan her değerlemeyi **çürütülemez** yapar — geçen çeyreğin
  kârını her zaman istediğiniz gibi gösterebilirsiniz. Aynı gün + aynı kaynak için ikinci kayıt
  reddediliyor; **düzeltme farklı bir kaynaktır**, üzerine yazma değil.
- **`fx_positions` bir MARUZİYET** — kaydettiğimiz ve revize ettiğimiz sıradan operasyonel veri.

TCMB dört rakam yayımlıyor ve bunlar birbirinin yerine geçmez (alışta biri, satışta diğeri).
Dördü de kaydediliyor; `rate` değerlemenin kullandığıdır. `fx_positions.amount` **işaretli**:
pozitif varlık, negatif yükümlülük — tek işaretli kolon, net pozisyonu düz toplama çeviriyor ve
hiçbir tüketicinin işareti unutmasına izin vermiyor. `entry_rate` olmadan kazanç **hesaplanamaz**,
tahmin edilebilir; bu yüzden NULL entry_rate NULL kazanç verir.

### 0067 — read-model'ler

**`credit_facility_utilization`** — limit/çekilen/kullanılabilir. `available` sıfırda sabitleniyor
ve **aşım ayrıca bildiriliyor** (`over_limit`): negatif bir başlık, aşağı akan her toplamda grup
likiditesini birinin kredi aşımı kadar sessizce azaltırdı.

**`debt_maturity_ladder` (30/90/180/365)** — iki gerçekten farklı yükümlülük aynı merdivende ama
**etiketli, birleştirilmemiş**: taksit hesaptan çıkacak bir tutardır; limit vadesi ise yenilenmesi
ya da kapatılması gereken bir tavandır. İkisini tek "vadesi gelen tutar"a toplamak, **kullanılmayan
her lira kadar** çıkışı şişirirdi. Bu yüzden nakit maruziyeti sütunu yalnız **çekilen** kısmı
sayıyor; kullanılmadan sona eren limit hiçbir şeye mal olmaz, sadece kullanılabilir olmaktan çıkar.

**`fx_position_revaluation`** — deterministik. Her rakam kayıtlı bir kur ve kayıtlı bir pozisyon
üzerinde aritmetik; model, volatilite tahmini, dağılım yok. ±%5/10/20 bantları tam olarak şudur:
aynı pozisyonun, sabit bir yüzde oynatılmış kurla değeri — okuyan biri her hücreyi hesap makinesiyle
yeniden üretebilir, ki sahibe gösterilmeye değer tek stres rakamı türü budur.

`worst_case_20_delta` **pozisyonun yönüne göre**: uzun pozisyon kur düşünce, kısa pozisyon kur
yükselince zarar eder. İşaretsiz tek bir "±%20 etkisi" yayımlamak, hazineciye **en büyük
yükümlülüğünün en büyük tamponu olduğunu** söylerdi.

### Para: gün-1'den decimal

Bu fazın tüm FX/finansman matematiği `money.ts` üzerinden geçiyor ve dört migration ile üç motorun
hiçbirinde `::float8` yok (`phase27:verify` bunu **kod üzerinde**, yorumları ayıklayarak kontrol
ediyor). Sebep somut: gerçekleşmemiş kazanç, birbirine çok yakın iki büyük sayının farkıdır
(`tutar × kur_şimdi − tutar × kur_giriş`) — ikili kayan noktanın cevabı kaybettiği aritmetiğin ta
kendisi. Birim test yarım-kuruş sınırında **ölçülmüş** bir sapma çiviliyor: `1 × 1,005` decimal
half-up ile 1,01, float'ta 1,00 (çünkü 1.005 aslında 1.00499999999999989).

### TCMB: manuel/talep üzerine, canlı akış DEĞİL

Plan canlı bağlantıyı Faz 37/38'e koyuyor. Bu faz Faz 20/25'in taşıyıcı desenini izliyor: bir
arayüz, erişilemezken **dürüst bir hata** dönen (asla fırlatmayan) gerçek bir uygulama, ve testlerin
sürdüğü deterministik bir mock. Zamanlayıcı/polling yok — gate bunu da kod üzerinde kontrol ediyor.

**Ortam değişkeni YOK:** uç nokta belgelenmiş varsayılanı olan bir **parametre**. Bu bilinçli — modül
yüklenirken `@/lib/env` import etmek, `phase25-verify` ve `phase6b-verify`'ı kendi belgeledikleri
komutla çalışamaz hâle getiren şeydi. Bir kur sağlayıcısının veritabanıyla işi yoktur, dolayısıyla
buradaki hiçbir şey bir veritabanı talep edebilmemeli.

İki incelik `parseTcmbXml`'de, ikisi de makul ama yanlış sayı üretirdi:
1. **`Unit`.** TCMB bazı kurları 100 birim üzerinden kotalıyor; birim başı kur yayımlanan rakamın
   `Unit`'e bölümüdür. Yok saymak JPY maruziyetini **yüz kat** şişirirdi.
2. **Boş elemanlar.** Bülten kotasyonu olmayan kurlar için `<ForexBuying/>` gönderiyor. Bunlar
   **NULL** olmalı, 0 değil — sıfır kur pozisyonu değersiz gösterirdi, değerlenmemiş değil.

`importRates` **başarısız çekimde hiçbir şey kaydetmiyor**: yarım aktarılmış bir bülten bazı
pariteleri güncel bazılarını bayat bırakır ve üzerine kurulan değerleme ikisini ayırt edemez.
Yeniden çalıştırmak güvenli (unique kısıt), ve `skipped` zaten var olanları **yeni gibi göstermeden**
raporluyor.

---

## Bütçe ve Rolling Forecast (Faz 28, migration 0068-0070)

### 0068 — `budgets` + `budget_lines`

Boyutlar Faz 19'un tablolarından (`cost_centers`, `departments`, `projects`) ve mevcut
`categories`'den geliyor; gerçek kolon adları yazmadan önce introspection'la doğrulandı — hepsi
`(id, code, name, is_active)`, dolayısıyla satır adlandırdığı boyuttan sapabilecek bir kod metni
yerine düz nullable FK taşıyor.

**ÖLÇÜLMÜŞ BİR SINIR, üstü örtülmek yerine kaydedildi:** bu boyutlardan yalnız `cost_center` ve
`project` herhangi bir işlem tablosuna bağlı (`invoices`/`invoice_lines`), `category` ise yalnız
`payments`'a. **Hiçbir tablo departmanı bir işleme bağlamıyor.** Yani bir departman bütçesi
yazılabilir ama karşılaştırılacak gerçekleşeni yoktur — 0070'in varyans view'ı var olan boyutlar
için gerçekleşen üretiyor ve departman gerçekleşenini **NULL bırakıyor**, tahsis kuralı icat
etmiyor. Uydurmak, bu veritabanında hiçbir satırın kaydetmediği "bu parayı hangi departman
harcadı" sorusunu cevaplamak olurdu. `phase28:verify` bu boşluğu yapısal olarak doğruluyor.

**Başlıkta yaşam döngüsü kolonu YOK, bilerek.** Plan versiyon döngüsünü SATIRLARA koyuyor
(`draft/approved/superseded`) ve bütçe revizyonu gerçekten orada oluyor: finans ekibi tek tek
satırları yeniden keser, bir yılı atomik olarak taslaktan onaya çevirmez. Başlığa ayrı bir statü
vermek, kendi satırlarıyla çelişebilecek ikinci bir yaşam döngüsü yaratırdı — taslak satırlarla
dolu "onaylı" bir bütçe. §17 kural 3 versiyonun fiilen yaşadığı tabloda karşılanıyor.

`amount` NOT NULL: bu şemada null'ın "bilinmiyor ama geçerli" olmadığı tek yer — satırın tüm amacı
ölçülecek bir sayı beyan etmek. Sıfır geçerli ("bu kaleme ödenek yok").

### 0069 — `forecasts` + `forecast_lines`

#### Neden `scenario_runs`'ı genişletmek yerine yeni tablolar (plan iki seçeneği de açık bırakıyor)

Önce mevcut tabloları introspect ettim; şekil kararı veriyor:

`scenario_run_lines` = `(month_start, baseline_income, scenario_income, baseline_expense,
scenario_expense, baseline_closing, scenario_closing, delta)`.

**Her değer kolonu bir baseline/senaryo ÇİFTİ.** O tablo tek bir soruyu cevaplıyor — "bu iki dünya
nasıl farklılaşıyor" — ve iyi cevaplıyor. Rolling forecast iki dünyanın karşılaştırması değil;
revize edilen, kaynağına göre sınıflanan, güven skoru verilen ve sonradan gerçekleşenle ölçülen
**TEK** bir projeksiyon. Oraya koymak her satırın yarısını anlamsız bırakır (bir tahmin satırının
baseline'ı ne?) ve "bu run aslında what-if değil" diyen bir ayırt edici kolon gerektirirdi.

Üç somut uyumsuzluk daha:
1. **Granülerlik.** `scenario_run_lines.month_start` kesin olarak aylık. Bu fazın teslim etmesi
   gereken 13 haftalık nakit tahmini **HAFTALIK**. Hafta başlangıçlarını `month_start` adlı bir
   kolona yazmak, sonraki her okuyucunun devraldığı bir yalan olurdu.
2. **Yaşam döngüsü.** `scenario_runs` arşivsel — `archived_at`/`archive_reason` ve triplet
   tutarlılık kısıtı taşıyor, yani bir hesaplamanın **değişmez ÇIKTISI**. Bu faz tahmin
   satırlarında versiyon döngüsü istiyor; `scenario_runs`'a versiyonlama takmak mevcut her senaryo
   satırının anlamını değiştirirdi.
3. **Kimlik.** Senaryo koşusu bir kez üretilir ve okunur; tahmin **sürdürülür** — haftalık revize
   edilir, yeniden onaylanır ve sonradan doğruluğu ölçülür.

**Kopyalanmak yerine yeniden kullanılan:** `forecasts.scenario_run_id` nullable FK — bir what-if
koşusundan üretilen tahmin, kendisini üreten mekanizmayla bağını koruyor. Senaryo motoru
**bağlanarak** genişletiliyor, aşırı yüklenerek değil.

#### Kaynak sınıflandırması ve güven

`source_kind`: `contracted` / `scheduled` / `historical` / `manual` / `estimated` — sayının
**NEREDEN GELDİĞİNİN** özelliği, birinin ona ne kadar güvendiğinin değil; kolon olmasının sebebi
bu. Varsayılan güven skorları (0,95 → 0,50) sabit bir tablo, öğrenilmiş ağırlık değil; kolonda
**fiilen kullanılan** değer saklanıyor, böylece varsayılanların sonradan değişmesi geçmiş güveni
sessizce yeniden yazamıyor.

`actual_amount` NULL = dönem henüz ölçülmedi, "hiçbir şey olmadı" DEĞİL — doğruluk view'ının yalnız
ölçülmüş satırları saymasının sebebi tam olarak bu.

#### Versiyon geçiş guard'ı (CHECK ile AYNI migration'da, her iki tabloda)

Altı sıralı çiftten üçü izinli: `draft→approved`, `draft→superseded`, `approved→superseded`.

**`approved → draft` REDDEDİLİYOR** ve guard'ın bütün mesele bu: onaylanmış bir satırı yeniden
açmak, birinin imzaladığı rakamı sessizce yeniden yazardı ve üzerine kurulu her varyans raporu
okuyucularının altında, hiçbir kayıt bırakmadan değişirdi. Revizyon, eskisini **supersede eden yeni
bir satırdır** — `superseded_by_line_id`'nin varlık sebebi de bu. `superseded` terminal.

Tutarlılık kısıtı imalar yığını yerine **tüketici**: her durum hangi damgaları taşıyabileceğini
tek tek söylüyor. Superseded bir satır önce onaylanmış da olabilir, taslaktan doğrudan da
supersede edilmiş olabilir — `approved_at` yalnız o dalda serbest bırakılmasının sebebi bu.

### 0070 — read-model'ler

**ÇİFT SAYMA TUZAĞI, açıkça kaçınıldı:** aynı para hem fatura hem onu kapatan ödeme olarak görünür.
İkisini toplamak gerçekleşen gideri kabaca iki katına çıkarır ve sayı yine makul görünürdü.
Gerçekleşen **yalnız FATURALARDAN** geliyor; ödeme tarafı bilerek katılmıyor.

`budget_vs_actual` yalnız **ONAYLI** satırları ölçüyor. Taslak satırlar çalışma notu, superseded
satırlar geçmiştir; ikisine karşı varyans raporlamak, birileri hâlâ düzenlerken bir sayının
değişmesine izin vermek olurdu — versiyon döngüsünün var olma sebebi.

**Karar YÖN duyarlı:** gider bütçesini aşmak ile gelir hedefini aşmak zıt sonuçlardır; işaretsiz
tek bir "varyans" iyi bir ayı kırmızıya boyardı. Gerçekleşen yoksa sonuç **NULL ve
`not_measured`**, sıfır değil — sıfır "hiç harcanmadı" iddiasıdır.

`cash_forecast_13w` haftaları **üretiyor**, var olan satırlardan türetmiyor: ufuk her zaman tam 13
kova. Tahmin satırı olmayan bir hafta boş hafta olarak görünmeli — nakit tahmininden sessizce
düşen bir hafta, boşluğun görünmez hâle gelme biçimidir. Yanında iki alternatif net akış:
**yalnız sözleşmeli** (her tahmin yanlış çıkarsa ayakta kalan) ve **güven ağırlıklı**.

`forecast_accuracy` yalnız ölçülmüş satırları sayıyor — ölçülmemiş bir satırı dahil etmek,
tahmini ne kadar az kontrol edilmişse o kadar doğru göstermek olurdu; tam tersi. MAPE'de sıfır
tahminli satırlar hariç (sıfıra bölme tanımsız, %100 hata saymak tek satırın KPI'yı domine etmesine
yol açardı) ve **hariç tutulan sayı ayrıca raporlanıyor**.

### Pekiştirme: LLM forecast zincirinin tamamen dışında

`src/lib/budget/{rules,engine}.ts` **`@/lib/ai`'yi hiç import etmiyor** ve `phase28:verify` bunu
kod üzerinde (yorumlar ayıklanarak) kontrol ediyor — negatif kontrolle kanıtlandı: gerçek bir
import enjekte edildiğinde gate 46/46'dan 45/46'ya düşüyor, dosyadaki açıklama yorumları ise
tetiklemiyor.

Bağımlılık tek yönlü: AI katmanı bu modüllerin **çıktısını** herhangi bir olgu gibi okuyabilir,
tersi olamaz. Bir dil modelinden geçmiş varyans rakamı yeniden üretilemez olurdu ve varyans
raporunun bütün anlamı, iki kişinin aynı sayıyı bulmasıdır. `ai/engine.ts`'in "önce deterministik,
LLM yalnız yorum" sınırı (Faz 12) olduğu gibi duruyor.

---

## Senaryo/Optimizasyon Genişletme (Faz 29, migration 0071-0073)

### 0071 — `optimization_runs` + `optimization_recommendations`

**Bir öneri ÖNERİDİR, mutasyon değil.** Bu fazın yük taşıyan kuralı. CLAUDE.md otomasyonun ödemeyi
ödendi işaretlemesini, vade değiştirmesini, tutar değiştirmesini yasaklıyor. Optimizatör bu yüzden
`payment_instances`, `invoices`, `checks`, `loans`, `cashflow_months` tablolarına **hiç yazmıyor**.
Onları okuyor ve BURAYA bir insanın seçebileceği eylemleri tarif eden satırlar yazıyor. Bir öneriye
göre hareket etmek insan eylemi olarak kalıyor ve Faz 24A'nın onay varlığı bunu kapıda tutuyor.

**Yaşam döngüsü kolonu YOK, bilerek.** İlk içgüdü bir `status` (draft/approved/applied) kolonu;
yanlış içgüdü. Bir optimizasyon çalışmasının onay durumu `approvals`'a ait — Faz 24A tam olarak
üçüncü bir özel inceleme varyantı olmasın diye kuruldu. 0072 polimorfik `subject_table`'a
`optimization_runs` ekliyor, yani bu **bağlanıyor**, çatallamıyor. Buraya bir statü koymak,
bir öneri kümesinin onaylı olup olmadığı hakkında **ikinci bir doğruluk kaynağı** yaratırdı ve
ikisi er ya da geç ayrışırdı — Faz 24A'nın bir fazını harcayarak ortadan kaldırdığı arıza.
§17 kural 3 uygulanmıyor çünkü korunacak bir yaşam döngüsü yok; gate bunu yorumda iddia etmek
yerine **yapısal olarak** doğruluyor.

`rationale_codes` NOT NULL ve en az bir kural adı taşımak zorunda (Faz 23 konvansiyonu: karar
her zaman onu üreten kural adlarıyla birlikte gezer). Sorgulanamayan bir optimizasyon önerisi,
hazinecinin haklı olarak yok sayacağı bir öneridir.

#### `coalesce(array_length(...), 0)` — gate'in yakaladığı gerçek bir hata

Kısıt önce `array_length(rationale_codes, 1) >= 1` yazılmıştı. **Boş bir dizide `array_length()`
0 değil NULL döner**, dolayısıyla `'{}'` için ifade NULL'a düşer — ve **NULL'a düşen bir CHECK
GEÇER**. Kısıt tam olarak engellemek için var olduğu satırları kabul ediyordu, üstelik çalışıyormuş
gibi okunuyordu. Kümede ölçüldü:

```
array_length('{}',1) is null            -> t
(array_length('{}',1) >= 1) is null     -> t     (CHECK geçiyor)
coalesce(array_length('{}',1),0) >= 1   -> f     (doğru reddediyor)
```

Yön kısıtları da aynı sınıftan: `defer_payment` ileri, `advance_payment` geri gitmek zorunda. Yön
ters olsaydı her öneri sessizce tersine döner ve bütün sayılar yine makul görünürdü.

### 0072 — `approvals.subject_table` genişletmesi (başka hiçbir şey yapmayan migration)

Faz 22/25 emsali: enum CHECK genişletmesi kendi açık migration'ını alır. **Bu bağlantıdır,
çatallama değil** — Faz 24A `approvals`'ı polimorfik `(subject_table, subject_id)` ile tam olarak
yeni bir onaylanabilir şeyin bir enum değerine mal olması için kurdu. Senaryo/optimizasyon onayı
bu yüzden bir değer ekliyor ve `requestApproval`/`decideApproval`'ı değiştirmeden kullanıyor.

#### Tipin yakalayamadığı çalışma-zamanı hatası

`requestApprovalSchema` `raw: unknown` alıyor, dolayısıyla koddaki Zod enum'u ile veritabanı
CHECK'i arasındaki **sürüklenme derleyiciye görünmez**. Faz 29 tam olarak buna çarptı: önce CHECK
genişletildi, `SUBJECT_TABLES` genişletilmedi; typecheck temiz geçti ve hata ancak
`requestOptimizationApproval` çağrıldığında bir Zod doğrulama hatası olarak çıkardı.
`phase29:verify` artık iki listeyi **doğrudan karşılaştırıyor** (yalnız-DB / yalnız-kod farkını
adıyla bildiriyor), böylece bir sonraki genişletme yarım kalamaz.

### 0073 — view'lar

`scenario_comparisons` tablosu **çalışma başına**: (run_id, metric, baseline_value,
scenario_value, delta) — "bu tek koşu tabandan nasıl ayrıldı" sorusunu cevaplıyor. Birkaç koşuyu
birbiriyle karşılaştırmak farklı bir soru ve **tablo eklemeden** view olarak cevaplanıyor, çünkü
ihtiyaç duyduğu her sayı zaten mevcut.

`optimization_run_summary` onay durumunu `approvals`'tan **JOIN ediyor**, kopyalamıyor. Faz 24A'nın
varlığına bağlanmanın bütün anlamı bu: bir şeyin onaylı olup olmadığını bilen tam olarak tek bir
yer var.

### Deterministik çözücü (`src/lib/optimization/rules.ts`)

Açık, kural tabanlı bir sezgisel çözücü. LP/MIP kütüphanesi yok, istatistiksel optimizatör yok,
öğrenilmiş ağırlık yok, Python yok (Çözülen Karar #2). Her öneri adlandırılmış bir kural tarafından
üretiliyor, o kuralın adını taşıyor ve girdilerden elle yeniden türetilebiliyor.

Sıra sabit: (1) bakiyeleri projekte et ve tabanın ilk ihlal edildiği günü bul; (2) o günün açığını
**ertelenebilir** ödemeleri kaydırarak kapatmayı dene, büyükten küçüğe; (3) kalan açık için en
düşük maliyetli limitten çekim öner; (4) hiç ihlal yoksa ve nakit tabanın rahatça üzerindeyse,
gereksiz yere faiz ödenmesin diye geri ödeme öner.

**Sert vadeli ödemeler hiçbir zaman ertelenmeye önerilmiyor** ve bu bir girdi, çözücünün kararı
değil. Ertelenemeyeceği ayrıca `sert_vade_ertelenemez` koduyla **bildiriliyor** — sessizce atlamak,
kalan açığın neden zamanlama ile kapanamadığını okunamaz kılardı.

**Kapatılamayan açık raporlanıyor** (`limit_yetersiz`). Sessiz bir kısmi cevap "çözüldü" diye
okunurdu.

#### Determinizm bir gereklilik, umut değil

Çalışma bir `result_digest` saklıyor ve gate optimizatörü yeniden koşup karşılaştırıyor. Bu, her
sıralamanın **tam sıra** olmasını zorunlu kılıyor: her karşılaştırıcı bir id eşitlik-bozucuyla
bitiyor, böylece iş anahtarlarında eşit iki aday bile sabit ve tekrarlanabilir bir sıra alıyor.
Eşitliği çözmeyen bir karşılaştırıcı çıktıyı girdi sırasına bağımlı kılardı — Faz 23'ün sıralama
dersi. Gate hem tekrarlanabilirliği hem de **girdi sırasından bağımsızlığı** ayrı ayrı kanıtlıyor.

#### Bir birim testin yakaladığı çözücü hatası

İlk sürüm ertelenen ödemeyi **ihlalden bir gün sonrasına** taşıyordu. Test gösterdi ki bu çoğu
zaman hiçbir şey başarmıyor: kapatıcı giriş üç gün sonraysa bakiye yeni tarihte de tabanın altında
kalıyor ve "düzeltme" en kötü bakiyeyi hiç değiştirmiyor (−400 → −400). Hedef artık ödemenin
**gerçekten karşılanabildiği ilk gün**: bu ödeme hariç hesaplanan bakiyenin, ödemeyi tabanın
üzerinde taşıyabildiği en erken tarih. Ufuk içinde böyle bir gün yoksa öneri **üretilmiyor** —
yalnızca ilerleme gibi görünen bir hamle yapmaktansa hiçbir şey önermemek doğru.

### Baseline korunur invariant'ı (Faz 8/13), yeni çalışma tipine karşı yeniden kanıtlandı

Plan bu invariant'ın her yeni senaryo tipine karşı yeniden test edilmesini şart koşuyor.
`phase29:verify` bunu **alt küme kontrolüyle değil, tam satır karşılaştırmasıyla** yapıyor:

1. bir baseline `scenario_run`'ın **her kolonu**, `scenario_comparisons` satırları, **tüm**
   `cashflow_months` satırları ve **tüm** `payment_instances` satırları anlık görüntüye alınıyor;
2. optimizatör uçtan uca çalıştırılıyor (`runOptimization` + `requestOptimizationApproval`);
3. anlık görüntüler `JSON.stringify` ile birebir karşılaştırılıyor.

İlk sürümde `payment_instances` **sıfır satırla** karşılaştırılıyordu — hiçbir şey kanıtlamayan
boş bir kontrol. Artık fixture iki gerçek taksit kuruyor (biri `normal`, biri `critical`
öncelikli), yani optimizatörün gerçekten mutasyona uğratabileceği adaylar var ve kontrol boş küme
olduğunda **başarısız oluyor**.

Ayrıca kaynak seviyesinde: motorun mali/senaryo tablolarına yazan hiçbir ifadesi olmadığı
(yorumlar ayıklanarak) ve çözücü kurallarının veritabanına **hiç erişmediği** — yani yapısal olarak
mutasyon yapamayacağı — kontrol ediliyor.

### `hardDeadline` iki sinyalden okunuyor

`priority` `payments`'ta, `risk_level` `payment_instances`'ta — introspection'la doğrulandı, çünkü
ilk sürüm `payment_instances`'ta olmayan bir `priority` kolonunu okuyordu. İkisinden biri
`critical` ise ödeme taşınamaz sayılıyor. Muhafazakâr okuma bilinçli: taşınamaz bir şeyi yanlışlıkla
ertelemeyi önermek, operatörün sonraki her öneriye olan güvenini götürür — kaçırılan bir
optimizasyondan çok daha pahalı.

---

## Maliyet Merkezi, Kârlılık ve İşletme Sermayesi (Faz 30, migration 0074-0075)

### 0074 — `cost_allocation_rules`: dağıtım tabanı kod değil VERİ

`approval_rules` (0054) ve `treasury_policies` (0062) emsali: kural bir satırda durur, view'lar
okur, genel giderin nasıl dağıtıldığını değiştirmek bir yeniden dağıtım değil **denetlenen bir
operatör işlemi**dir. Bir SQL view'ının içine gömülü dağıtım tabanı, yalnız bir geliştiricinin
değiştirebileceği bir sayıdır — maliyet kararı için yanlış sahip.

Planın beş gider türü (`common`/`machine`/`personnel`/`energy`/`project`) ve beş dağıtım tabanı.
Her taban bu veritabanının **gerçekten ölçebildiği** bir sürücüye karşılık geliyor:
`machine_minutes` → `machine_minute_allocations`, `revenue_share` → faturalar. Sürücüsü olmayan
bir taban, sessizce hiçbir şey dağıtmayan bir kural olurdu.

**Yaşam döngüsü kolonu YOK ve §17 kural 3 gerçekten N/A** — `phase30:verify` bunu yorumda iddia
etmek yerine `status`/`state`/`version_status`/`lifecycle`/`approved_at` kolonlarının yokluğunu
sorgulayarak **yapısal olarak** doğruluyor (Faz 26/28 deseni). Kural aktiftir ya da değildir;
`is_active` boolean'ının transition guard'ın koruyacağı bir ara durumu yok.

Kapsam CHECK'i iki yönlü (`fixed_percent` yalnız ve ancak taban `fixed_percent` ise), pay 0..1
aralığında, **sıfır pay geçerli** ("buraya bir şey dağıtma" — 0 ile null farklı ifadeler). Aynı
hedef için ikinci **aktif** kural `NULLS NOT DISTINCT` kısmi unique indeksle engelleniyor; olsaydı
view hangi tabanı seçeceğini bilemez, planlayıcının döndürdüğü ilk satırı sessizce kullanırdı.

Personel ve enerji kuralları **pasif** geliyor: bunları açmak ekrandaki her marjı değiştirir ve bu
operatörün bilinçli kararı olmalı, migration'ın onun yerine verdiği bir karar değil.

**RLS: `config` sınıfı** — her katman okur (taban, bir marjın neden öyle göründüğünü açıklar),
yalnız **admin** yazar. Bilerek yöneticiye kapalı: dağıtımı yeniden tabanlayabilen bir yönetici,
hiçbir mali kayıt değişmeden maliyeti kendi merkezinden başkasınınkine kaydırabilirdi.

### 0075 — kârlılık ve işletme sermayesi view'ları

#### Kârlılık deseni kopyalandı, yeniden icat edilmedi

`src/lib/production/rules.ts:partProfitability` bu depoda marjın nasıl hesaplandığını zaten
belirlemişti; view'lar birebir onu izliyor:

- `margin = revenue − cost`, ve **iki taraftan biri bilinmiyorsa NULL** (asla 0)
- `margin_rate = margin / revenue`, ve ciro 0 ya da bilinmiyorsa **NULL** (asla 0, asla ∞)
- eksik girdi bir `confidence` bayrağıyla söyleniyor

Gerekçe estetik değil: maliyeti kaydedilmediği için 0 görünen bir marj, **gerçek bir başabaştan
ayırt edilemez** — ve bu depo "bilinmeyen bilinmeyen kalır" kararını zaten vermişti. Birim test
iki hesabın aynı sayıyı verdiğini `partProfitability`'yi içe aktararak çiviliyor.

**Açık sıfır ciro ölçülmüş sayılıyor:** para harcayıp hiç satmamış bir merkezde marj gerçek bir
negatif sayıdır, yalnız yüzdesi tanımsızdır.

#### Tek kaynak — çift sayma yok

Ciro ve maliyetin ikisi de **yalnız faturalardan** geliyor. Aynı para ödemeler ve banka
hareketleri olarak da var; faturayı onu kapatan ödemeyle birlikte toplamak rakamı kabaca iki
katına çıkarır ve sayı yine makul görünürdü. Faz 28 bu tuzağı bütçe gerçekleşeni için kaydetmişti;
burada aynı kural aynı sebeple geçerli.

#### `profitability_by_party` — rol iddia değil gözlem

Müşteri ve tedarikçi için iki ayrı view yerine tek view: aynı cari çoğu zaman ikisidir ve ayrı
raporlamak net ilişkiyi görünmez kılardı. `observed_role` verinin **gösterdiği** rolü söylüyor
(`customer`/`supplier`/`both`/`no_activity`), `party_type` kolonunun iddia ettiğini değil.

#### Departman: ölçülemiyor, ve nedeni satırla birlikte geziyor

**Ölçüldü, varsayılmadı:** bu şemada hiçbir işlem tablosu `department_id` taşımıyor (Faz 28 aynı
bulguyu bütçe gerçekleşeni için kaydetmişti). View her departmanı NULL rakamlar ve
`unmeasurable_reason = 'no_transaction_link'` ile listeliyor; tahsis kuralı **icat etmiyor**.
Uydurmak, "bu parayı hangi departman kazandı" sorusunu kimsenin savunamayacağı bir sayıyla
cevaplamak olurdu. Ekran nedeni yazıyor, böylece boşluk "kâr sıfır" diye okunmuyor.

#### Makine kârlılığı: doğru tabloya bağlandı

İlk taslak `machine_minute_allocations`'ı join ediyordu; introspection o tablonun
`(capacity_model_id, operation_type)` ile anahtarlandığını ve **hiç makine taşımadığını** gösterdi
— o tablo **kapasite kullanımını** ölçüyor, farklı bir eksen. Kullanmak, atölye geneli dakikaları
tek tek makinelere atfetmek olurdu. View artık zaten makine başına ciro/maliyet ve kendi
`confidence` kolonunu taşıyan `machine_roi_snapshots` üzerine kurulu — bu fazın şablon alması
söylenen kârlılık emsalinin ta kendisi.

### İşletme sermayesi: DSO/DPO hesaplanıyor, DIO ve CCC **dürüstçe** hesaplanmıyor

Faz 22 `dso_dpo_components`'ı bilerek **oransız** bırakmıştı ("view bileşenleri verir, oranı
DEĞİL"); bölme işte bu fazda yapılıyor — 365 gün üzerinden ve cevabı dürüst kılan korumalarla:

- **sıfır ya da NULL payda → NULL**, 0 değil ve sonsuz değil. DSO 0, "müşteriler anında ödüyor"
  diye okunur; gerçek ise "satış geçmişimiz yok".
- **DIO HER ZAMAN NULL** ve bu ölçülmüş bir olgu: şemada envanter **yok** — stok tablosu yok,
  eldeki-miktar kolonu yok, tutulan malı kaydeden hiçbir şey yok.
- **CCC de NULL**, çünkü `DSO + DIO − DPO` üç terimden ikisiyle hesaplanamaz.

Cazip kısayol DIO'yu 0 saymaktı. Bu, döngüyü bu işletmenin malzeme tuttuğu gün sayısı kadar
**kısaltır** — yani işletme sermayesini olduğundan **İYİ** gösterir, ki bu metrik için yanlış
olmanın en tehlikeli yönü budur. Onun yerine `cash_cycle_excluding_inventory` ayrıca veriliyor ve
**tam olarak neyi dışladığıyla adlandırılıyor**, böylece hesaplanabilir kısım hiçbir şey CCC
taklidi yapmadan kullanılabiliyor.

`working_capital_trend` her ay için kendi 365 günlük kayan paydasını kullanıyor — noktasal
`dso_dpo_components` "bugünü" cevaplıyor, trend ise her ayın kendi pozisyonunu gerektiriyor.

### Dağıtımda kaybolan kuruş (`allocate`)

100,00'ü üçe bölmek 33,33 veriyor ve 33,33 × 3 = 99,99. Bir kuruşun bir yere gitmesi gerekiyor,
yoksa dağıtım sessizce para kaybeder — bir yıllık aylık genel gider koşusunda bu, her maliyet
merkezinde açıklanamayan gerçek bir sapmadır. Artık kalan **en büyük paya** veriliyor (eşitlikler
id ile çözülüyor, yani seçim tekrarlanabilir) ve `allocate` parçaların girdiye **tam olarak**
eşit toplandığını garanti ediyor. Birim test bunu 100 / 0,01 / 1 / 999,99 / 1234,56 tutarlarını
3, 6, 7 ve 11 hedefe bölerek doğruluyor.

Sıfır ya da negatif toplam sürücüde dağıtım **boş** dönüyor — NaN üretmek yerine "hiçbir şey
dağıtılamadı" bilgisi veriliyor.

---

## Finansal Kontrol Merkezi ve Anomali Tespiti (Faz 31, migration 0076-0078)

Bu bir **sentez** fazı, ve en önemli disiplin zaten tutan bir invariant'ı ikinci kez zorlamamak.
Her kontrol yazılmadan ÖNCE ilgili mevcut mekanizma okundu ve sınıflandırıldı; sınıflandırma
`control_registry.enforcement` kolonunda **veri olarak** duruyor, yorumda iddia olarak değil.

### Kontrol envanteri — hangisi zaten var, hangisi gerçekten yeni

| Kontrol | Sınıf | Gerekçe |
|---|---|---|
| `allocation_over_invoice` | **zaten zorlanıyor** | Faz 22'nin `allocations_enforce_invoice_ceiling()` trigger'ı engelliyor. İkinci bir CHECK, ilkiyle çelişebilecek bir yetki olurdu. |
| `near_duplicate_bank_txn` | **zaten zorlanıyor** | `bank_transactions_dedupe_uq` **UNIQUE** (doğrulandı). Birebir kopya imkânsız; bu yüzden kontrol hash'in göremediği **yakın** kopyaları arıyor. |
| `iban_changed` | **zaten zorlanıyor** | Faz 19'un `iban_change_events`'i her değişimi salt-ekleme kaydediyor. Yeniden icat edilmedi. |
| `unknown_counterparty` | **zaten zorlanıyor** | Faz 19 kararı: uygulama eşleme sırasında sessizce `parties` satırı YARATMIYOR; ham `counterparty_label` kasıtlı. |
| `duplicate_invoice` | **gerçekten yeni** | `invoices_dedupe_idx` **unique DEĞİL** (doğrulandı) — banka tarafının aksine. Bunu yalnız bu kontrol yakalıyor. |
| `payment_without_invoice` | **gerçekten yeni** | Hiçbir mekanizma engellemiyor. |
| `approval_bypass` | **gerçekten yeni** | Faz 24A onay varlığını kurdu; eşiği aşan kaydın onayı olup olmadığını kimse kontrol etmiyordu. |
| `closed_period_mutation` | **gerçekten yeni** | Çıpa var, kontrol yoktu (aşağıya bakın). |
| `missing_source_document` | **gerçekten yeni** | Kaynak soyağacı Faz 2'den beri var; eksikliği bulgu olarak raporlanmıyordu. |
| `unmatched_bank_txn_aged` | **gerçekten yeni** | `status='unmatched'` bir veri durumu; **yaşlanması** bir bulgu. |
| `large_payment` | **gerçekten yeni** | Eşik `settings.critical_payment_threshold_try`'den okunuyor — ikinci bir sayı icat edilmedi. |

`phase31:verify` "zaten zorlanıyor" iddialarının her birini **mekanizmayı çalıştırarak kanıtlıyor**:
banka indeksinin gerçekten unique olduğu, fatura indeksinin gerçekten olmadığı, Faz 22 trigger'ının
fatura üstü dağıtımı hâlâ reddettiği. Sınıflandırma iddia değil, test.

### Planın bir atfı düzeltildi

Plan kapalı-dönem kontrolünün "Faz 24B'nin dönem-kilidini gerektirdiğini" söylüyor. Faz 24B
aslında rol-tabanlı RLS teslim etti; **dönem kilidi kavramı ondan önce zaten vardı**:
`cashflow_months.status` erken fazlardan beri `'locked'` değerini taşıyor. Kontrol o çıpaya
bağlandı. Kontrolün dayanağı olduğu için kaydedildi.

### 0076 — `control_alerts` ve `alert_escalation_rules`

Bu fazın **tek yeni durumu**. Bir bulgunun onaylanacak bir yere ihtiyacı var ve mevcut tabloların
hiçbiri bunu taşımıyor.

Yaşam döngüsü beş durumlu, yirmi sıralı çiftin **on biri** izinli. İkisi ayrıca yazılmayı hak
ediyor:

- **`snoozed → open`** — erteleme **süresi dolar**. Bu geçiş olmasaydı ertelenen her uyarı kalıcı
  susturulurdu; kimsenin güvenmediği bir alarm sisteminin tam olarak arıza biçimi budur.
- **`resolved`/`false_positive` terminal** — kapatılmış bir bulguyu yeniden açmak, var olma
  sebebi olan kontrol geçmişini yeniden yazmak olurdu. Tekrar ederse **yeni bir uyarı** açılır,
  ki kısmi unique indeks de tam olarak buna izin veriyor.

**`false_positive` `resolved`'ın bir çeşidi değil, birinci sınıf bir sonuç.** Ayrı tutulması,
kural başına yanlış-alarm oranını hesaplanabilir kılan şey — planın istediği geri bildirim
sinyali. Hangi kontrolün kurt masalı anlattığını ancak böyle görebilirsiniz.

Kısıtlar tüketici biçimde yazıldı (Faz 28 deseni): her durum hangi damgaları taşıyabileceğini tek
tek söylüyor. `control_alerts_has_rules` **`coalesce(array_length(...), 0) >= 1`** kullanıyor —
Faz 29'un zor yoldan öğrendiği ders baştan uygulandı: boş dizide `array_length()` NULL döner ve
NULL'a düşen CHECK **geçer**.

Kapatma **gerekçe zorunlu** kılıyor: "kimse tarafından, sebepsiz çözüldü" bir kontrolün sessizce
kapatılma biçimidir.

Kısmi unique indeks canlı uyarıları kapsıyor, yani **tekrar koşu liste şişirmiyor** —
`occurrence_count` artıyor. Her çalıştırmada büyüyen bir uyarı listesi, kimsenin okumadığı listedir.

`alert_escalation_rules` yapılandırma; yaşam döngüsü kolonu yok ve §17 kural 3'ün N/A olduğu
**yapısal olarak** doğrulanıyor. İki kural tohumlanıyor ve **ikisi de aktif** — pasif gelen bir
eskalasyon kuralı, hiç yükseltmeyen bir alarm demek olurdu.

### 0078 — kontroller ve anomali dedektörleri

**Kontrol kaydı (`control_registry`)** her denetimi listeliyor, bulgu bulmasa bile. Temizken
kaybolan bir kontrol, bozulduğu fark edilmeyen kontroldür. `control_dashboard` bunun üzerine
PASS/WARNING/CRITICAL veriyor.

Anomali dedektörleri **deterministik**: adlandırılmış eşikler, sabit ağırlıklar, öğrenilmiş hiçbir
şey yok. Öne çıkan iki tanesi:

- **Bölünmüş ödeme** — aynı karşı tarafa aynı gün, her biri onay eşiğinin **altında** ama toplamı
  **üstünde**. Onay kapısının etrafından dolaşmanın klasik yolu, ve Faz 24A'nın eşiğini okuyarak
  tespit ediliyor.
- **Geçmiş ortalamaya göre tutar** — taban, karşı tarafın **kendi** ortalaması, yani büyük bir
  tedarikçi büyük olduğu için işaretlenmiyor. **Dört gözlemin altındaki geçmiş taban sayılmıyor**:
  ince geçmişten sinyal değil gürültü üretirdi.

**Olağandışı saat kontrolü dürüstçe adlandırıldı.** Ölçüldü: `bank_transactions`'ta **işlem saati
yok** — yalnız `txn_date` (tarih). Dolayısıyla "gece 3'te yapılan ödeme" tespit **edilemiyor**;
tespit edilen, **gece 3'te kaydedilen** satır. Bu da gerçek bir sinyal ama farklı bir sinyal, ve
view'ın kolon adı ile `caveat` alanı bunu söylüyor. İşlem saati demek, verinin desteklemediği bir
iddiada bulunmak olurdu.

### İnceleme iş akışı — ikinci görev modeli yok

Takip görevi bir `action_item` (Faz 14 modeli, Faz 25'in tahsilat için yaptığı gibi). 0077 tek bir
`source_type` değeri ekliyor (`'control'`), birkaç tane değil: bulgu türünü zaten
`control_alerts.check_code`, neyle ilgili olduğunu zaten `related_entity_*` söylüyor.

### Motor neyi yazar, neyi yazmayı reddeder

`control_alerts`, `action_items` ve `audit_logs` yazar. **Hiçbir mali kayda yazmaz**: bulduğunu
"düzeltebilen" bir kontrol, otomasyonun tutar ve vade değiştirmesi olurdu — CLAUDE.md'nin
doğrudan yasakladığı şey. Bulgu bir insanın önüne konur; kararı insan verir. Gate bunu kaynak
seviyesinde (yorumlar ayıklanarak) kontrol ediyor.

### LLM kontrol zincirinin tamamen dışında

`src/lib/controls/*` `@/lib/ai`'yi import etmiyor ve gate bunu negatif kontrolle kanıtlıyor.
Gerekçe politika değil pratik: bir kontrol bulgusunun, aynı kuralları aynı satırlara uygulayan
ikinci bir kişi tarafından **yeniden üretilebilmesi** gerekir. Bir dil modelinden çıkmış ciddiyet
derecesi denetçiye savunulamaz ve "model tuhaf buldu" bir kontrol değildir.

### `db:constraints:verify` genişletildi (değiştirilmedi)

Planın şartı gereği her yeni CHECK kendi girdisini aldı: `runFaz31ConstraintAssertions()` eklendi,
mevcut `runFaz19`/`runFaz22` fonksiyonlarına dokunulmadı. Script 65 → **75** teste çıktı.

## CFO Brifingi, Yönetim Kokpiti ve Finansal Takvim (Faz 32, migration 0079-0080)

Bu faz **iki migration** ekliyor ve **hiç yeni tablo** açmıyor. Sebebi aşağıda; kısaca: bu fazın
işi yeni bir gerçeklik üretmek değil, var olan gerçekliği **tek ekranda** ve **tek dille**
göstermek.

### 0079 — `reports.report_type` bir değer genişliyor

`reports` tablosuna `'cfo_briefing'` eklendi. Paralel bir `briefings` tablosu **açılmadı**:
brifing, `body_md`'si, dönemi, geçmişi ve denetim izi olan bir rapordur — `reports` tam olarak
bunu modelliyor. İkinci bir tablo, aynı şeyin iki ayrı yaşam döngüsü, iki ayrı RLS sınıfı ve iki
ayrı arşivleme kuralı demek olurdu.

> Sonraki fazlar için not: bu kümenin **boyutunu** sabitleyen bir gate, bir sonraki genişlemede
> kırılır (Faz 31'in `action_items.source_type` dersi). Faz 32'nin gate'i bu yüzden **üst-küme**
> iddiası kuruyor: `'cfo_briefing'` var **ve** eski beş değer duruyor.

### 0080 — `financial_calendar` + `financial_calendar_daily` (VIEW)

#### Planın açık bıraktığı soru, kapatıldı: yeni tekrar-eden-yükümlülük tablosu YOK

implementation.md §3, maaş/SGK/vergi/kira/sigorta/CapEx tarihlerinin **yeni hafif bir
tekrar-eden-yükümlülük kaydı** mı gerektirdiğini, yoksa mevcut payments modülüne mi oturduğunu bu
faz başlarken netleştirmemizi istiyordu. Karar: **mevcut modül**.

Karar iddiaya değil ölçüme dayanıyor — `public.payments` zaten şunları taşıyor:

| Kolon | Ne modelliyor |
| --- | --- |
| `recurrence_type` | `one_off / monthly / weekly / yearly / irregular` |
| `due_day` | ayın kaçında (monthly ise CHECK ile zorunlu) |
| `category_id` | maaş / SGK / vergi / kira / sigorta ayrımı |
| `provider_party_id` | kime ödendiği |

ve `payment_instances` her tekrarı zaten **maddeleştiriyor**. Aylık bordro, SGK primi, üç aylık
vergi ve kira tam olarak bu şekil: kategorili, tekrar eden ödeme. İkinci bir tablo, `payments`'ın
var olma sebebi olan tek şey için **rakip bir doğruluk kaynağı** kurardı; her ekran "hangisine
inanayım" diye sormak, birileri de aradaki mutabakatı sürdürmek zorunda kalırdı.

Gate bu kararı iki yönden kilitliyor: adında `recurring`/`obligation` geçen yeni tablo
**olmadığını** ve `payments.recurrence_type` CHECK'inin tekrar modelini **gerçekten** taşıdığını
doğruluyor.

#### View ne topluyor

Altı kaynak, tek tarih ekseninde: `payment_instances`, `loan_installments`, `checks`, `invoices`,
`promise_to_pay`, `credit_facilities` (vade).

**İşaret tek kolonda.** `amount_signed` negatifse para çıkıyor. Yön ayrı bir kolonda dursaydı, bir
tüketicinin onu unutup toplaması an meselesiydi. `checks` zaten işaretli tutar taşıdığı için (0009)
işareti yeniden hesaplanmıyor, **alınıyor**.

**Kesinlik ayrı bir eksen.** `contracted` (imzalı yükümlülük) / `expected` (ödeme sözü) /
`renewal` (limit vadesi). Faz 25'in ödeme sözü `expected` sayılıyor: söz verilmiş bir tahsilat,
imzalı bir taksitle **aynı ağırlıkta** takvime girerse, taahhüt edilmiş olanı olduğundan güçlü
gösterir.

**Limit vadesi bir tarihtir, nakit hareketi değildir.** `credit_facilities.expiry_date` satırının
`amount_signed`'ı `0` değil **NULL**. Sıfır olsaydı günün netine sessizce karışırdı; NULL olduğu
için toplanamaz. Vadesi gelen limitte olan şey, çekilen bakiyenin muaccel olması ve kullanılmayan
başlığın **var olmayı bırakması** — ikisi de o günkü çıkış değil. Faz 27'nin vade merdiveninin
yaptığı ayrımın aynısı.

**Tutarı bilinmeyen satır dışarıda.** Tutarsız bir ödeme sözü takvime `0` olarak girmiyor;
girmiyor. Bilinmeyen bir rakam bir toplama eklenemez ve `0,00` yazmak hiçbir şeyi eksik
göstermezken **kesinliği** olduğundan yüksek gösterirdi.

`financial_calendar_daily` bunu güne indirger ve `net_contracted` ile `net_expected`'ı **ayrı
kolonlarda** verir — iyimser rakam sessizce manşet olamasın diye.

### Neden VIEW, neden tablo değil

Her iki read-model de VIEW. Faz 22-31 boyunca uygulanan kural: türetilmiş rakam saklanmaz, çünkü
saklandığı anda kaynağıyla ayrışabilen ikinci bir doğruluk kaynağı olur. Bu faz özellikle
"özet ile detay **sapamaz**" şartı taşıdığı için, kuralın gevşetilmesi en son burada düşünülebilirdi.

## Arka Plan İşleri ve Ölçülmüş Performans (Faz 33, migration 0081-0082)

Bu faz yeni bir iş alanı (domain) eklemiyor — altyapı işi. İki migration: biri kuyruk, biri
**ölçümle gerekçelendirilmiş** optimizasyon.

### 0081 — `background_jobs`: TEK kuyruk, dört teslimat

Plan dört şey sayıyor: büyük Excel/CSV importları için kuyruk, rapor-üretim kuyruğu,
büyük-export kuyruğu, import-progress takibi. Bunlar **tek mekanizma**. Bir iş, "istekten uzun
süren, başarısız olabilen, sınırlı sayıda yeniden denenmesi gereken ve ilerleme bildiren iş"tir;
bu tanım yük banka ekstresi yerine PDF export olduğunda değişmiyor.

Dört tablo demek, dört durum sözlüğü, birbirinden sürüklenen dört retry politikası, dört RLS
sınıflandırması ve bir şey takıldığında bakılacak dört yer demekti. `job_type` bir kolondur.

| Alan | Neden var |
| --- | --- |
| `status` | queued/running/succeeded/failed/dead_letter/cancelled — CHECK + geçiş koruyucusu |
| `attempts` / `max_attempts` | retry politikası satırın kendisinde, işçinin aklında değil |
| `next_run_at` | geri çekilme (backoff) — bekleyen iş "henüz uygun değil"dir, herkes sebebini görür |
| `progress_done` / `progress_total` | import ilerlemesi |
| `dead_lettered_at` / `dead_letter_reason` | ölü mektup, ayrı tablo değil ayrı **durum** |
| `dedupe_key` | kısmi unique: yalnız CANLI işler arasında |

**Ölü mektup neden ayrı tablo değil.** Ölü mektuba düşen iş, geçmişi yerinde duran **aynı
satırdır**: harcadığı denemeler, onu öldüren hata, sebep olan payload. Ayrı tabloya taşımak ya bu
geçmişi kopyalardı (iki kaynak) ya da kaybederdi. `dead_letter` durumundan tek çıkış var ve
koruyucu buna izin veriyor: **elle tekrar oynatma**.

**Kısmi unique, düz unique değil.** `dedupe_key` yalnız `queued/running/failed` satırları arasında
tekil. Düz bir unique olsaydı her aylık import, geçen ayınki başarılı olduğu için başarısız
olurdu.

**NULL yine sıfır değil.** `progress_total` NULL olabilir: sayfaları henüz açılmamış bir Excel
dosyasının toplamı **bilinmiyordur**, ve 0 yazmak ekranda "0/0 — tamamlandı" diye okunur.
`progress_done` ise 0 varsayılan, çünkü "henüz satır işlenmedi" gerçek bir sıfırdır.

**Geçiş koruyucusu, CHECK ile AYNI migration'da** (0027 dersi). İzinli dokuz hamle ve reddedilen
ikisi:

- `succeeded → herhangi bir şey` **REDDEDİLİR** — tamamlanmış bir iş geri alınamaz. Olmasaydı bir
  retry döngüsü bitmiş bir importu yeniden çalıştırıp yazdığı her satırı ikiye katlardı.
- `cancelled → herhangi bir şey` **REDDEDİLİR** — birinin bilerek geri çektiği iş için aynısı.

TS tarafındaki `ALLOWED_TRANSITIONS` listesi aynı kümeyi tarif ediyor ve **gate ikisini
karşılaştırıyor** (Faz 29'un Zod/DB sürüklenme dersi): SQL'e hamle eklenip TS'e eklenmezse gate
düşer, üretimde değil.

`background_job_queue_health` bir VIEW — türetilmiş sayı saklanmaz.

### 0082 — ölçülmüş optimizasyon

**Önce ölçüldü, sonra yazıldı.** 77 read model gerçekçi hacimde (24.000 fatura, 60.000 banka
hareketi, 12.500 taksit, 6.000 çek) üçer kez çalıştırılıp medyanla sıralandı. Sıralama, dosyaları
okuyup tahmin edilecek şeyle uyuşmadı:

```
5.995 ms      37 satır   working_capital_trend      <- 77 view'ın TOPLAMININ %55'i
  708 ms  60.000 satır   anomaly_unusual_record_hour
  650 ms  60.000 satır   bank_unmatched_queue
  477 ms       0 satır   invoice_duplicate_suspects
  291 ms      11 satır   control_dashboard
```

60.000 satırlıkların maliyeti 60.000 satırı taşımak; hiçbir sayfa onları filtresiz çekmiyor.
Gerçekten **patolojik** olan `working_capital_trend`: 37 satır için altı saniye, üstelik gerçek
bir ekranı besliyor (`costing/engine.ts` → kârlılık sayfası).

`EXPLAIN (ANALYZE, BUFFERS)` sebebi tam olarak söyledi: dört bağıntılı alt sorgu, her biri
faturaları **ay başına** yeniden tarıyor — 37 satır üretmek için **234.882 shared buffer hit**.

**Dört aday kuruldu ve ölçüldü:**

| | ms | buffer |
| --- | ---: | ---: |
| A eski view, indekssiz | 6.478 | 234.879 |
| B eski view + kapsayan indeks | 2.185 | |
| D tek geçişli yeniden yazım, indeksiz | 969 | |
| **C yeniden yazım + indeks (uygulanan)** | **683** | **5.247** |

**9,5× hız, 45× daha az buffer.** İki değişiklik de bağımsız katkı veriyor.

> **Ölçüm için VACUUM şart, yalnız ANALYZE yetmez.** Bir index-only scan heap'i yalnızca
> görünürlük haritasının "tümü görünür" işaretlediği sayfalar için atlayabilir ve o haritayı yalnız
> VACUUM kurar. Toplu insert'ten hemen sonra hiçbir sayfa öyle değildir; gate bunu yaşadı —
> aynı veritabanında önce 455.011 buffer ve index-only scan yok, autovacuum'dan sonra 7.185 ve var.
> Plan her iki seferde de tablonun o anki durumu için doğruydu. `scripts/perf/volume.ts` ve
> `phase33:verify` bu yüzden `vacuum analyze` çalıştırıyor.

**Reddedilen aday.** Kümülatif toplam + as-of arama ile beşinci bir yeniden yazım da yazıldı,
çıktısının birebir aynı olduğu kanıtlandı ve **3.225 ms ölçüldü** — yerine geçtiği şeyden yavaş.
Atıldı. Ölçülmeseydi "optimizasyon" diye girecekti, çünkü zekice görünüyordu.

**Materialized view neden YOK.** Plan bunu öneriyor; bilerek kullanılmadı. Faz 19/22/23/26'nın
tekrar tekrar vardığı sebep: materialized view **saklanmış türetilmiş veridir**. Buradaki girdiler
faturalar ve sürekli değişiyorlar — bugün girilen bir tahsilat, iki yıl önceki bir ayın
`receivables_open`'ını değiştirir — yani tazelemeler arasında bayat kalırdı. Altındaki faturalarla
sessizce çelişen bir işletme sermayesi trendi, bu sistemin her fazda kaçındığı ikinci doğruluk
kaynağının ta kendisi. Ve **gerek kalmadı**: 9,5× hiçbir rakamı değiştirmeyen bir yeniden yazım ve
bir indeksten geldi.

**Hiçbir rakam değişmedi — söz değil, kanıt.** DSO/DPO gerçek kararları besliyor. Yeniden yazım,
önceki tanımla tam sonuç kümesi üzerinde simetrik `EXCEPT` ile karşılaştırıldı: iki yönde de sıfır
fark. Eski tanım `working_capital_trend_reference` olarak **birebir korundu** — hiçbir katmana
grant verilmedi, hiçbir sayfa okumuyor; tek işi gate'in **her koşuda** eşdeğerliği yeniden
doğrulaması. Yalnız yeniden yazım günü karşılaştıran bir gate, bir sonraki düzenlemeyi kaçırırdı.

Korunan zor ayrıntı: 365 günlük pencere `issue_date > (period_start - 365 gün)` — ay sınırına
**oturmuyor**. Aya yuvarlayan bir taslak, yılda bir güne denk gelen faturaları sessizce düşürürdü.

### İndeks denetimi: 110 aday, 1 indeks

`scripts/perf/index-audit.ts` üç soruyu katalogdan yanıtlıyor: indekssiz yabancı anahtarlar
(**110** bulundu), gereksiz ön-ek indeksleri (**0**), hiç kullanılmamış indeksler (yalnız bilgi —
taze migrate edilmiş bir DB'de hepsi sıfırdır, gate bunun üzerine hata **vermez**).

110'unun hepsini indekslemek bu fazın kendi disiplinine aykırı olurdu: her indeks, her insert'e
ölçülmemiş bir yazma maliyeti bindirir. Ölçüm neyi haklı çıkardıysa o eklendi — bir tane.

## Doküman Merkezi (Faz 35, migration 0083)

Üç tablo (`documents`, `attachments`, `document_links`) ve bir VIEW
(`document_current_version`). Yeni bir depolama geleneği kurmuyor — Faz 2'ninkini sürdürüyor.

### Açık soru #7 kapatıldı: YEREL DİSK

Karar mevcut koda dayanıyor. `source_workbooks` (0001) zaten `storage_path` + `file_sha256`
taşıyor: baytlar diskte, veritabanında yol ve sağlama. `attachments` bilerek **aynı iki kolon**.

| Reddedilen | Sebep |
| --- | --- |
| Obje depolama (S3 vb.) | CLAUDE.md'nin "tek şirket, özel, yerel" konumlandırmasına harici bulut bağımlılığı eklerdi; dokümanları sahibinin dosya yöneticisiyle açamayacağı bir yere koyardı. |
| Postgres'te bayt (bytea / large object) | Her taranmış sözleşme yedeğe girerdi. **Faz 33 ölçtü**: 24.000 faturada pg_dump zaten yedek doğrulamasını kırıyordu. Zorunlu migration-öncesi yedek pratik kalmalı. |

**Bedeli açıkça:** veritabanı yedeği tek başına geri yükleme değildir; doküman dizini de
yedeklenmeli. Karşılığında iki koruma:

- `attachments.file_sha256` **NOT NULL** (0001'de nullable) — geri yükleme hangi dosyanın eksik
  veya bozuk olduğunu **kanıtlayabilir**.
- Okuma sırasında yeniden sağlama alınır; uyuşmazlık hata verir. Sessizce bozulmuş dosya sunan bir
  arşiv, kapalı olandan kötüdür — bozulma dosyalanır, e-postayla dolaşır ve güvenilir sanılır.

**İçerik adresli yerleşim:** `<kök>/aa/bb/<sha256>`. Aynı baytlar bir kez saklanır, dosyanın adı
kendi bütünlük kontrolüdür, ve **yola hiç kullanıcı metni girmediği için** dizin dışına çıkma
yapısal olarak imkânsızdır.

### `documents` — mantıksal doküman

`status`: `active / archived / superseded`. `superseded` ile `archived` bilerek ayrı: ilki
**yeni bir doküman bunun yerine geçti** (ve hangisi olduğunu söyler), ikincisi yalnız aktif
kullanımdan çıktı. Birleştirmek sebebi kaybederdi.

Geçiş koruyucusu CHECK ile **aynı migration'da** (0027 dersi). İzinli dört hamle; reddedilen:
`superseded → herhangi bir şey`. Canlandırılan bir doküman, ikisi de güncel olduğunu iddia eden
iki doküman bırakır ve her bağlantı sessizce belirsizleşir.

`tags text[]` — join tablosu değil: etiketlerin özniteliği yok ve hiçbir şey onlara referans
vermiyor. Ayrı tablo, "kira etiketli dokümanlar" sorusunu üç join'e çevirirdi. GIN indeksi var.

### `attachments` — fiziksel dosyalar ve SÜRÜM geçmişi

Versiyonlama burada, `documents`'ta değil: değişen şey dosyadır. Aynı sözleşmenin yeniden
taranması yeni bir **sürüm**dür, yeni bir doküman değil.

**Append-only** (0022 deseni, BEFORE UPDATE/DELETE tetikleyicileri): düzeltilebilen bir sürüm
geçmişi geçmiş değildir. Hatalı bir yüklemenin düzeltmesi sürüm N+1 eklemektir — zaten olan da
budur. Faz 24B sınıfı **evidence**: hiçbir katmanda UPDATE/DELETE policy'si yok.

`unique (document_id, file_sha256)`: birebir aynı baytları "sürüm 2" diye kaydetmek, **olmayan
bir değişikliği** kaydeder. Aynı baytlar iki farklı dokümanda meşru olabileceği için sha256
**global olarak tekil değil**.

### `document_links` — polimorfik bağlantı

`entity_table` + `entity_id`, tam olarak `approvals` (0053) ve `audit_logs` gibi. Bu şema zaten
"varlıklardan birine işaret et"i böyle yapıyor; üçüncü bir gelenek öğrenilecek üçüncü şey olurdu.
Kapalı liste güvenlik özelliği: açık bir metin kolonu, hiçbir zaman çözülemeyecek bir bağlantıyı
bir yazım hatasıyla yaratmaya izin verirdi.

### `document_current_version` — VIEW, kolon değil

Güncel sürüm `max(version_no)` ile türetilir. `current_attachment_id` kolonu, zaten cevaplanan bir
soru için **ikinci kaynak** olurdu ve biri onu güncellemeden sürüm eklediği ilk gün bayatlardı.
