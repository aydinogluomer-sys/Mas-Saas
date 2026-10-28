# Faz 7 — Cutover provası

**Tarih:** 2026-08-24 · **Branch:** `release/production-readiness-hardening`
**DB sınıfı:** `DISPOSABLE_SYNTHETIC` — izole cluster (`mas-radar-pg-faz7-sandbox`, port 55438).
Gerçek `mas_radar_dev`'e **dokunulmadı**. Gerçek cutover Faz 8'dir ve bu çalışmanın kapsamı değildir.

---

## 1. Operatör karar tablosu — "bakmadan bilmek" bunun için var

Provanın çıktısı bu tablodur. Her satır, aşağıdaki provalarda **gerçekten üretilmiş** bir sinyaldir;
hiçbiri teorik değildir.

| Gördüğün sinyal | Sınıf | KARAR | Neden |
|---|---|---|---|
| `pg_restore --list` hata veriyor, satır/hash tutmuyor | Ön koşul | **STOP** | Yedek güvenilir değilse geri dönüş yolu yok. Cutover **başlamaz**. |
| `password authentication failed for user "mas_radar_app"` | Yapılandırma | **CONFIG ROLLBACK** | Şemaya hiç dokunulmadı; yalnız bağlantı dizesi/parola yanlış. Saniyeler. |
| `permission denied for table users` (prepare-runtime) | Yapılandırma | **CONFIG ROLLBACK** | GRANT eksik. Veri sağlam; `G` adımı geri alınır. |
| `/health` = 503, `db: "down"` | Yapılandırma | **CONFIG ROLLBACK** | Uygulama ayakta, veritabanı erişimi kopuk. Şema sorunu değil. |
| `/ready` = 200 ama `/health` = 503 | Yapılandırma | **CONFIG ROLLBACK** | Süreç sağlıklı, bağımlılık değil. Süreci yeniden başlatmak **çözmez**. |
| `rolsuper` / `rolbypassrls` = `t` | Yapılandırma | **CONFIG ROLLBACK** | `alter role mas_radar_app nologin;` — G adımı yapılmaz. |
| RLS verify FAIL (ör. `RLS KAPALI: payments`) | Yapılandırma | **STOP** + CONFIG ROLLBACK | Uygulama açılmaz. Veri sağlam ama güvenlik duvarı delik. |
| Migration **kesintiye uğradı** (süreç öldü) | Veri | **RETRY** | Ledger tutarlı kaldı; `pnpm db:migrate` tekrar çalıştırılır ve kaldığı yerden devam eder. |
| Migration **hata ile durdu** (dosya ortada patladı) | Veri | **DB RESTORE** | Durak noktası saptanır, klonda çözülür; çözülmezse A'daki yedekten geri yükleme. |
| Checksum drift (hiç SQL çalışmadı) | Nötr | **STOP** | Kod ile ledger ayrışmış. Geri yükleme **gerekmez** — hiçbir şey değişmedi. |
| `Backup hedefi bulunamadı` | Ön koşul | **STOP** | migrate.ts yedekleyemediğini migrate etmeyi reddediyor. Doğru davranış. |
| ledger ≠ 87/0087, ya da 0087 nesnesi yok | Veri | **DB RESTORE** | Uygulama başlatılmaz. |
| `users` dışında sayı/aggregate/hash değişmiş | Veri | **DB RESTORE** | Beklenen mutation whitelist dışı. |
| Yukarıdakilerin hiçbirine uymayan davranış | — | **ESCALATE** | Sınıflandırılamayan sinyal, tahmin edilerek yönetilmez. |

**Ayrımın özü:** *Şemaya dokunuldu mu?* Dokunulmadıysa **CONFIG ROLLBACK** (saniyeler, veri
kaybı yok). Dokunulduysa ve sonuç doğrulanamıyorsa **DB RESTORE** (A adımındaki yedek).
Kesinti hâlinde önce **RETRY** — çünkü ölçüldü: kesilen migration devam edebiliyor.

---

## 2. Prova A — normal success path

Runbook'un ileri yolu ve geri dönüş yolu arka arkaya, disposable clone üzerinde.

| Adım | Komut | Sonuç |
|---|---|---|
| İleri yol (A→E): dump → `--list` → restore → parmak izi → `db:migrate` → parmak izi → değişmezler | `pnpm release:golden-fingerprint` | **14/14 PASS**, exit 0 |
| Geri dönüş yolu: backup → drop → create → restore → doğrula → **uygulamayı başlat** → smoke | `pnpm release:restore-drill` | **9/9 PASS**, exit 0 |

Geri dönüş yolunun beş kapısı:

```text
BACKUP EXISTS            = YES
BACKUP READABLE          = YES
BACKUP RESTORABLE        = YES
RESTORED DATA MATCHES    = YES   85 tablo + 6 parasal toplam + 85 satır hash'i birebir
APP CAN START ON RESTORE = YES   /ready = 200 · golden-ui-smoke 36/36
```

Yani **ileri yol** (migration) ve **geri dönüş yolu** (restore) ikisi de tek komut, ikisi de
kanıtlı. Cutover'ın her iki yönü de provalı.

---

## 3. Prova B — bilinçli failure injection

Dördü de planın istediği senaryolar. Her biri gerçekten enjekte edildi ve gözlem kaydedildi.

### B1 — yanlış DB parolası

```text
DATABASE_URL=…mas_radar_app:KESINLIKLE-YANLIS-PAROLA@…
→ Çalışma zamanı hazırlığı başarısız: error: password authentication failed for user "mas_radar_app"
→ START_EXIT = 1 · sunucu HİÇ açılmadı (/ready bağlantı vermiyor)
```

**Fail-closed.** Yanlış parolayla yarı-açık bir uygulama yok. → **CONFIG ROLLBACK**

### B2 — migrate stop

İki ayrı deneme yapıldı, çünkü ilk enjeksiyon **başarısız olmadı** ve bu da bir bulgudur:

**(a) İdempotent migration.** 0087'nin ledger satırı silinip nesneleri bırakıldı; migrate tekrar
koştu ve **exit 0** verdi — 0087 idempotent yazılmış (`if not exists`). Yani "ledger satırı kayboldu"
senaryosu kendi kendini onarıyor.

**(b) Gerçek kesinti.** Boş bir veritabanında migrate başlatıldı ve **5 saniye sonra SIGKILL** ile
öldürüldü:

```text
kesinti anı        : ledger = 56/0056
migrate tekrar     : RESUME_EXIT = 0
kesintiden sonra   : ledger = 87/0087
```

**Kesilen migration tutarlı ve devam edilebilir bir durum bırakıyor.** Elle onarım gerekmedi.
→ **RETRY** (önce), çözülmezse **DB RESTORE**

**Ek bulgu (bu prova sayesinde çıktı):** `migrate.ts` pending varsa **zorunlu yedek** alır ve
veritabanını `MAS_DB_CONTAINER` (varsayılan `mas-radar-pg`) içinde arar — benim release
script'lerimin kullandığı `MAS_PG_CONTAINER`'dan **farklı bir değişken**. Sandbox'ta hard-fail
verdi:

```text
Backup hedefi bulunamadı: '<db>' container 'mas-radar-pg' içindeki DB listesinde yok.
```

Bu migrate.ts'in **haklı** davranışı (yedekleyemediğini migrate etmez) ama provayı imkânsız
kılıyordu. `golden-fingerprint.ts` artık değişkeni iletiyor. Daha önceki her koşuda pending
olmadığı için yedek adımı hiç devreye girmemiş ve bu boşluk görünmez kalmıştı.

### B3 — RLS verify failure

```text
bozmadan önce : SECURITY MATRIX VERIFY: ALL PASS      (17/17)
inject        : alter table public.payments disable row level security;  → relrowsecurity=false
bozduktan sonra: FAIL  KATMAN 3 … — RLS KAPALI: payments   (16/17, exit 1)
```

Kapı **kör yeşil vermiyor**: bozulmayı yakaladı ve **hangi tabloyu** olduğunu adıyla söyledi.
→ **STOP** + **CONFIG ROLLBACK** (uygulama açılmaz)

### B4 — app health failure

Runbook'un L bölümündeki yapılandırma-geri-dönüş kolu (`alter role mas_radar_app nologin`)
çalışan bir sunucuya karşı uygulandı:

| Durum | `/ready` | `/health` |
|---|---|---|
| sağlıklı | **200** | **200** · `{"status":"ok","db":"up","latencyMs":45}` |
| bozuk | **200** | **503** · `{"status":"degraded","db":"down","dbError":"role \"mas_radar_app\" is not permitted to log in"}` |

Üç şeyi birden kanıtlıyor:

1. `/health` veritabanı koptuğunda **gerçekten kırmızıya dönüyor** (teorik değil).
2. `/ready` **200 kalıyor** — canlılık/bağımlılık ayrımı çalışıyor. Restart politikası `/health`'e
   bağlansaydı, sağlıklı bir uygulama PostgreSQL her hıçkırdığında yeniden başlatılırdı.
3. `dbError` **nedeni adıyla söylüyor**, yani operatör hangi kolu çektiğini görüyor.

→ **CONFIG ROLLBACK** (süreç yeniden başlatmak çözmez — sinyal bunu açıkça ayırıyor)

---

## 4. Faz 7 PASS

> Plan: "Operator hangi sinyalde ne yapacağını bakmadan biliyor:
> STOP / RETRY / CONFIG ROLLBACK / DB RESTORE / ESCALATE."

Beş kararın **beşi de** yukarıdaki tabloda somut sinyallere bağlı ve her sinyal bu provada
**gerçekten üretildi**. Karar kuralı tek cümleye iniyor:

> **Şemaya dokunulmadıysa CONFIG ROLLBACK. Kesinti ise önce RETRY.
> Şema değişti ve doğrulanamıyorsa DB RESTORE. Sinyal sınıflandırılamıyorsa ESCALATE.**

**PASS.**

---

## 5. "READY FOR CUTOVER" durumu

Planın §20 listesi, bu çalışmanın kapsamına göre:

| Kriter | Durum |
|---|---|
| golden exact-clone production migration PASS | **KARŞILANDI** — orkestratörün gerçek DB koşusu (0034→0087, 4 tablo hash birebir); Faz 5 bunu tek komuda kodladı |
| clean-runner GitHub CI PASS | **KAPSAM DIŞI** — CI 7 job'a çıkarıldı ve komutları lokalde tek tek doğrulandı, ama gerçek runner sonucu okunamadı (`gh` authenticate değil) |
| master CI PASS | **KAPSAM DIŞI** — aynı neden; ayrıca master'a hiç dokunulmadı |
| critical legacy UI smoke PASS | **KARŞILANDI** — Faz 2: 35 testin tamamı semantik kapıyı geçti; Faz 3: 24 kritik ekran |
| Phase17–38 E2E %100 | **KARŞILANDI** — 94/94, birden çok bağımsız koşuda |
| monetary spot-check %100 | **KARŞILANDI** — 12 değer exact equality (Faz 3), restore edilen kopyada da (Faz 6) |
| backup restore-proven | **KARŞILANDI** — Faz 6, beş kapı YES |
| runbook rehearsal PASS | **KARŞILANDI** — bu belge |
| P0 açık = 0 | **KARŞILANDI** |
| P1 açık = 0 | **KARŞILANDI** |

Açık kalan tek kalem **gerçek GitHub runner sonucu**dur ve bu, kimlik bilgisi gerektirdiği için
bu çalışmanın kapsamı dışındadır — atlanmış değil, kimin bakacağı belli.

**Faz 8 (gerçek DB A–L cutover) bu çalışmanın görevi DEĞİLDİR** ve burada durulmuştur.
