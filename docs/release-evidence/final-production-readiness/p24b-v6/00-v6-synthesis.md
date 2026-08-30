# V6 — P24B kesin ayak izi (READ-ONLY discovery)

**Koşum:** RC worktree `C:/Users/Trade Bilisim/Mas-Saas-RC`, pin `1675c92`, source tree CLEAN.
**Erişim:** yalnız `scripts/db/p24b-readonly-psql.sh` — hedef adı sabit, oturum
`default_transaction_read_only=on` ve bu pozitif kontrolle kanıtlanıyor.
**Yazma:** V6 öncesi/sonrası parmak izi birebir aynı → **gerçek DB yazması = 0**.

> Bu tur yalnız **keşif**tir. Hiçbir satır silinmedi, değiştirilmedi.
> `P24B_CLEANUP_AUTHORIZED = NO` olarak kalır.

---

## KESİN MANİFEST — 42 satır / 6 tablo

| tablo | n | nasıl bulundu |
|---|---|---|
| `users` | 6 | metin (`p24b*`) |
| `action_items` | 4 | metin (**2'si `created_by = NULL`**) |
| `payments` | 1 | metin ("P24B fixture") |
| `settings` | 1 | metin (`p24b_fixture_setting`) |
| `approvals` | **4** | 2'si UUID referansıyla, **2'si YALNIZ olay-penceresi süpürmesiyle** |
| `payment_instances` | 26 | FK (`payment_id`) |
| **TOPLAM** | **42** | |

Tam kimlikler: `01-exact-manifest.json`.

### Üç yöntemin de gerekli olduğunun kanıtı

Bu ayak izi tek bir yöntemle çıkarılamazdı — her yöntem diğerlerinin kaçırdığını yakaladı:

| satır | metin | UUID/FK | zaman süpürmesi |
|---|---|---|---|
| `action_items 12d7532f` "P24B theirs" (`created_by=NULL`) | ✅ | ❌ | ✅ |
| `payment_instances` ×26 (metin taşımaz) | ❌ | ✅ | ✅ |
| `approvals 1fc76c28` / `8f656a4d` (metin taşımaz) | ❌ | ✅ | ✅ |
| **`approvals 62cd196c` / `f4d7db30`** (`requested_by=NULL`, metin yok, referans yok) | ❌ | ❌ | ✅ |

Son satır kritiktir: **iki approval kaydı ne P24B metni taşıyor ne de bilinen bir UUID'ye
referans veriyor.** Yalnızca olay penceresinde yaratılmış olmalarıyla yakalandılar. Sabit
listeye ya da FK closure'a güvenen bir tarama bunları kaçırırdı — v5'in "exact 10 fixture"
varsayımının neden iptal edildiğinin doğrudan kanıtı.

---

## Olay modeli — dört olay, iki sınıf

| # | zaman (UTC) | aktör | ne |
|---|---|---|---|
| **I1** | 2026-08-25 10:09:08 – 10:10:38 | operatör (elle) | `roles-rls-verify` → payments·settings·users·action_items·approvals |
| **A1** | 2026-08-25 10:19:27 – 10:19:55 | **`atilla`** | uygulama içi eylem → 3 `payment_instances` (kısa pencere) |
| **A2** | 2026-08-26 12:02:37 – 12:02:38 | **`system`** | `prepare-runtime` → `ensureWindow(…,24)` → 23 `payment_instances` |
| **I2** | 2026-08-26 15:16:19 | operatör (elle) | `roles-rls-verify` → users·action_items·approvals |

### Amplifikatör hakkında düzeltme

Önceki rapor **A1 ve A2'nin ikisini de** `prepare-runtime`'a atfediyordu. `audit_logs`
aktörleri bunu çürütüyor: **A1'in aktörü `atilla`**, yani bir insanın uygulamayı kullanması.
`prepare-runtime` yalnız A2'yi üretti.

Bu, risk ifadesini **genişletir**: fixture şablonu `payments`'ta durdukça yalnız `dev`/`start`
değil, **sıradan uygulama kullanımı da** yeni satır üretebilir.

`generate_instances` denemelerinin tam dökümü — 25 koşudan yalnız **ikisi** satır üretti,
gerisi pencere zaten dolu olduğu için 0 üretti (idempotent davranış, sayının 511'de
sabitlenmesinin sebebi):

```
2026-08-09 21:37  system  26 audit  -> 17 uretildi   (kirlilik ONCESI, mesru)
2026-08-25 10:19  atilla   4 audit  ->  3 uretildi   A1
2026-08-26 12:02  system  26 audit  -> 23 uretildi   A2
… diger 22 kosu                     ->  0 uretildi
```

---

## Kirlilik OLMAYAN — silinmemeli

| şey | neden dokunulmaz |
|---|---|
| `audit_logs` `generate_instances` satırları (pencerelerde 30) | **Ay başına** yazılıyor, tüm ödemeleri kapsıyor (`{"total": 18, "created": 0, "monthStart": …}`). Fixture olmasa da var olurlardı. |
| `invoices` `7a8f5051`, `70b7f2ae`, `5e91aa49`, `48b3eceb` | **Sarkan referanslar.** `invoices` tablosu boş (0 satır); approval'ların `subject_id`'leri hiç var olmamış kayıtlara işaret ediyor. Silinecek bir şey yok. |
| `cashflow_months` / `cashflow_lines` / `cashflow_snapshots` | Tamamı 2026-07-17'de bir kez yazılmış, olaylardan **önce**. Sızıntı yok. |

---

## TÜREV KİRLİLİK — silmekle düzelmez

`metric_snapshots`, **2026-08-27 01:31:28**'de 24 satır yazmış — her iki olaydan ve her iki
amplifikasyondan **sonra**. Değerler kirli veri üzerinden hesaplanmış:

| metrik | kayıtlı değer | fixture'sız gerçek | fark |
|---|---|---|---|
| `task_status.open` | **8** | **4** | +4 (P24B action_items) |
| `payment_status.unpaid` | **13.621.000,00** | **13.595.000,00** | **+26.000,00 TRY** (26 × 1000) |

42 satırın silinmesi bu 24 kaydı **düzeltmez** — yeniden hesaplanmaları gerekir. Temizlik
planı bunu ayrı bir adım olarak taşımalıdır.

---

## Taban yokluğu (normalized 0087)

42 adayın hiçbiri temiz taban veya release klonlarında yok:

| veritabanı | ledger | P24B eşleşmesi |
|---|---|---|
| `mas_radar_verify_empty` | 0087/87 | **0** |
| `mas_radar_final_rc_clone` | 0087/87 | **0** |
| `mas_radar_preflight_clone` | 0087/87 | **0** |

→ 42 satır taban/seed verisi değil, kirliliktir. **Release klonları temiz** — kirlilik
release artefaktlarına yayılmamış.

## Kapsam: ikinci bir veritabanı

`mas_radar_audit_empty` **de** P24B taşıyor: 4 users, 2 action_items, 1 payment, 1 setting —
ama **farklı UUID'ler** ve **2026-08-23 04:46:32**, yani her iki olaydan da **önce** ve guard
commit'inden (`9844dd3`) önce. Ayrı bir `roles-rls-verify` koşusudur, `mas_radar_dev`
klonu değil.

O DB'de fixture ödemesinin `payment_instances`'ı **0**'dır — amplifikasyonun yalnız
uygulamanın çalıştığı veritabanında olduğunu bağımsız olarak doğrular.

> ⚠️ `mas_radar_audit_empty` adı **bugünün kapısından geçmez**: `DISPOSABLE_MARKERS` içinde
> "empty" yok. Bu ad bugün `requireDisposableOwnerDatabaseUrl` tarafından reddedilirdi.

## Başka kirlilik sınıfı yok

| aranan | bulunan |
|---|---|
| `PERF …` ödemeler / çekler / faturalar / parties / bank_tx (perf/volume) | **0** |
| `perf_seed` audit kaydı | **0** |
| `KIYMETLI-URETIM-KAYDI` (owner-url.ts test satırı) | **0** |
| `roles-verify-probe` ledger satırı | **0** ← `roles-verify`'ın rollback'inin pozitif kontrolü |

`perf:measure --seed` gerçek DB'ye **hiç yazmamış** — P0 ateşlenmeden kapatıldı.

---

## Sabit nokta ve bütünlük

- **İterasyon 1:** 11 seed UUID → `approvals` (2) ve `payment_instances` (26) eklendi
- **İterasyon 2:** 30 yeni seed → **yeni satır yok** → sabit nokta
- **Polimorfik referanslar:** `approvals.subject_table/subject_id` izlendi, hedefler yok (dangling)
- **Olay penceresi süpürmesi:** `created_at` taşıyan 77 tablo tarandı → 2 ek `approvals` satırı
- **Quiescence:** V6 öncesi/sonrası parmak izi aynı; `mas_radar_dev` yazması **0**

`V6_FOOTPRINT = COMPLETE` · `P24B_CLEANUP_AUTHORIZED = NO`
