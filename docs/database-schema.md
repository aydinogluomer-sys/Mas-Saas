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
