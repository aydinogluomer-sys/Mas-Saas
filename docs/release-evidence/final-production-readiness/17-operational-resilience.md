# 17 — Operational resilience ve bus factor (AŞAMA 20)

**WORKING COMMIT (çalışmanın başladığı HEAD):** `0e3e595`
**BRANCH:** `release/production-readiness-hardening`
**TARİH:** 2026-08-26

**TARGET DATABASE CLASS:** `REAL_READ_ONLY` (kanıt koşuları) · `DISPOSABLE_CLONE` (iki kapı)
**TARGET DATABASE NAME:** `mas_radar_dev` (yalnız okuma) · `mas_radar_e2e_verify` (harcanabilir)
**REAL DB WRITE USED:** **NO**

> `mas_radar_dev` üzerinde tek bir satır yazılmadı. `db:roles:verify` tasarımı gereği
> `schema_migrations` tablosuna bir INSERT **denemesi** yapar; bu deneme her zaman
> `rollback` edilen bir işlemin içindedir ve gerçekte SQLSTATE **42501 (permission denied)**
> ile reddedilir — çıktıda `PASS schema_migrations'a INSERT reddedilir` satırı bunun kanıtıdır.
> Fixture yazan iki kapı (`db:roles-rls:verify`, `db:security-matrix:verify`) gerçek
> veritabanına değil, harcanabilir `mas_radar_e2e_verify` hedefine yöneltildi.

**ORIGINAL PLAN REFERENCE**
- section: Gap Closure Rehberi **§25 — AŞAMA 20 "Operational Resilience ve Bus Factor"** (L2219–L2298)
- upstream: Aggressive Plan §16 Faz 13 — L1520–L1562
- ayrıca: §29 (database-class enforcement, L2475–L2524), §30.6 ("runbook exists" anti-pattern, L2614–L2630)
- acceptance criterion (birebir):
  1. On iki runbook'un tamamı, on bölümlük zorunlu formatla yazılmış olacak.
  2. **İkinci bir kişi**, yalnız runbook'a bakarak şunları yapabilecek: start · stop · backup ·
     restore disposable target · lock/deactivate user · collect incident evidence.
  3. Secret rotation prosedürü: DB owner password · app DB password · session secret ·
     integration credentials için rotate → restart → smoke → rollback.
  4. Gerçek secret hiçbir evidence dosyasına girmeyecek.

**CURRENT STATUS:** **PARTIAL**

Gerekçe, §30.6'nın kendi kelimeleriyle: *markdown written → operation ready* yanlıştır; doğrusu
*runbook executed successfully + evidence receipt + second operator where required*'dır. Bu
turda 1., 3. ve 4. kriter karşılandı; **2. kriter karşılanmadı ve bir ajan tarafından
karşılanamaz** — ikinci operatör drill'i tanımı gereği ikinci bir **insan** gerektirir.

---

## CHANGES

| Dosya | Ne |
|---|---|
| `docs/ops/start.md` | **YENİ** — uygulamayı başlat; tek Next sunucusu kuralı, ortam hijyeni kapısı, kimlik doğrulaması |
| `docs/ops/stop.md` | **YENİ** — kontrollü durdurma; süreci kimliğiyle doğrulama, açık bağlantı kanıtı |
| `docs/ops/backup.md` | **YENİ** — yedek alma; dört soru (exists/readable/off-device/restorable), üç yol, makbuz |
| `docs/ops/restore.md` | **YENİ** — harcanabilir hedefe geri yükleme; ad kuralı, tatbikat, temizlik |
| `docs/ops/cutover.md` | **YENİ** — operatör giriş kapısı; A→L sırası, C1/C2 gerekçesi, beş karar |
| `docs/ops/password-rotation.md` | **YENİ** — dört kimlik sınıfı; küme-geneli rol uyarısı en üstte |
| `docs/ops/user-creation.md` | **YENİ** — hesap açma (arayüz + `seed-admin` yedek yolu) |
| `docs/ops/role-change.md` | **YENİ** — rol değiştir · **hesap kapat** · kilit aç · parola sıfırla |
| `docs/ops/incident.md` | **YENİ** — kanıt toplama (10 adım, hepsi salt okuma) + beş karar |
| `docs/ops/db-full.md` | **YENİ** — disk darlığı; ölçüm, güvenli sıra, IMMUTABLE koruması |
| `docs/ops/docker-restart.md` | **YENİ** — konteyner yaşam döngüsü; volume ayrımı |
| `docs/ops/failed-migration.md` | **YENİ** — dört arıza biçimi; OPS-01 kurtarması |
| `scripts/db/env-source.ts` | `connectionTargetParts` (ayrıştırma tek yerde), `formatTargetIdentity`, `formatIntendedTargetIdentity`. `connectionTargetLabel` davranışı **değişmedi**, artık ortak ayrıştırıcıyı kullanıyor |
| `scripts/db/roles-verify.ts` | İlk satırda ölçülen kimlik; bağlanamama kolunda niyet edilen hedef. Assertion'lar ve çıkış kodları **değişmedi** |
| `scripts/db/roles-rls-verify.ts` | İlk satırda app + owner kimliği. Assertion'lar **değişmedi** |
| `scripts/db/security-matrix-verify.ts` | İlk satırda ölçülen kimlik. Assertion'lar **değişmedi** |
| `tests/env-source.test.ts` | Kimlik satırı için 5 yeni birim testi (16 → 22 test) |

---

## RUNBOOK ENVANTERİ — 12/12

| # | Dosya | DATA CLASS | WRITE? | 10 bölüm | Komutları koşuldu mu? |
|---|---|---|---|---|---|
| 1 | `docs/ops/start.md` | `PRODUCTION_WRITE` | YES | ✅ | **KISMEN** — sağlık/kimlik komutları koşuldu; `pnpm start`/`build` koşulmadı (canlı sunucu zaten çalışıyor, tek-sunucu kuralı) |
| 2 | `docs/ops/stop.md` | `REAL_READ_ONLY` | NO | ✅ | **KISMEN** — süreç teşhis komutları koşuldu; durdurma **koşulmadı** (canlı üretim örneği) |
| 3 | `docs/ops/backup.md` | `REAL_READ_ONLY` | NO | ✅ | **KISMEN** — sayım/ölçüm komutları koşuldu; dump alan komutlar koşulmadı (disk %95) |
| 4 | `docs/ops/restore.md` | `DISPOSABLE_CLONE` | YES (yalnız harcanabilir hedefe) | ✅ | **HAYIR** — tatbikat bu turda koşulmadı (disk + zaman); ad kuralı ve gate davranışı kaynaktan doğrulandı |
| 5 | `docs/ops/cutover.md` | `PRODUCTION_WRITE` | YES | ✅ | **KISMEN** — ön kapı `pnpm db:env:source` koşuldu; A–L koşulmadı (cutover ertelendi, iki açık P0) |
| 6 | `docs/ops/password-rotation.md` | `PRODUCTION_WRITE` | YES | ✅ | **HAYIR** — bilinçli. Rol parolası küme genelindedir; komut canlı örneği düşürür |
| 7 | `docs/ops/user-creation.md` | `PRODUCTION_WRITE` | YES | ✅ | **KISMEN** — doğrulama sorguları koşuldu; hesap **açılmadı** |
| 8 | `docs/ops/role-change.md` | `PRODUCTION_WRITE` | YES | ✅ | **KISMEN** — doğrulama sorguları koşuldu; rol/durum **değiştirilmedi** |
| 9 | `docs/ops/incident.md` | `REAL_READ_ONLY` | NO | ✅ | **EVET** — 10 adımın tamamı koşuldu (aşağıda çıktılar) |
| 10 | `docs/ops/db-full.md` | `REAL_READ_ONLY` | NO | ✅ | **KISMEN** — ölçüm + budama **kuru koşusu** koşuldu; `--apply` ve `dropdb` koşulmadı |
| 11 | `docs/ops/docker-restart.md` | `REAL_READ_ONLY` | NO | ✅ | **KISMEN** — durum/kimlik komutları koşuldu; yeniden başlatma **koşulmadı** |
| 12 | `docs/ops/failed-migration.md` | `PRODUCTION_WRITE` | YES | ✅ | **KISMEN** — üç teşhis kontrolü koşuldu; kurtarma senaryosu **tetiklenmedi** |

**On bölümlük format:** her dosyada `PURPOSE · PRECONDITIONS · DATA CLASS · COMMANDS · EXPECTED ·
FAILURE SIGNALS · STOP CONDITION · ROLLBACK · EVIDENCE · SECRET HANDLING` — 12/12 tam.

---

## COMMANDS ACTUALLY RUN — gerçek çıktılarla

### 1. `pnpm db:env:source` — cutover C1 kapısı · exit 0

```text
BAĞLANTI ORTAMI KAYNAK RAPORU (.env.local okundu)
Değerler yazdırılmaz — yalnız kaynak ve kullanıcı@veritabanı etiketi.

  MIGRATION_DATABASE_URL: yalnız .env.local (postgres@mas_radar_dev) — DİKKAT: tsx script'leri .env.local'ı OKUMAZ, bu değeri görmezler.
  DATABASE_URL: yalnız .env.local (mas_radar_app@mas_radar_dev) — DİKKAT: tsx script'leri .env.local'ı OKUMAZ, bu değeri görmezler.

ENV SOURCE: gölgeleme yok.
```

### 2. `pnpm db:roles:verify` — gerçek DB, salt okuma · exit 0 · 8/8

```text
Hedef: db=mas_radar_dev user=mas_radar_app

PASS  current_user = mas_radar_app — current_user='mas_radar_app'
PASS  rol superuser DEĞİL ve bypassrls DEĞİL — rolsuper=false rolbypassrls=false
PASS  schema_migrations'a INSERT reddedilir — permission denied (42501) — beklenen
PASS  public.payments okunabilir — select başarılı
PASS  public.users okunabilir (login için şart) — select başarılı
PASS  public.sessions okunabilir (login için şart) — select başarılı
PASS  users satırları RLS üzerinden GERÇEKTEN görünüyor — 17 kullanıcı satırı görülebiliyor
PASS  users/sessions'ta hem deny_all hem app_runtime policy'si duruyor — ...

8/8 kontrol geçti.
```

**İlk satır bu turun P2 düzeltmesidir.** AŞAMA 11 / B5-2'de aynı kapı YANLIŞ bir veritabanına
karşı `8/8 kontrol geçti` demiş ve `18 kullanıcı satırı` bildirmişti; gerçek hedefte **17**
var. O yanlışı yalnız dışarıdan alınan bir satır sayımı ortaya çıkarmıştı. Artık kapı hedefi
kendi söylüyor.

### 3. Bağlanamama kolu — niyet edilen hedef yine yazılır · exit 1

```text
Hedef (bağlanılamadı): db=mas_radar_olmayan_probe user=mas_radar_app
database "mas_radar_olmayan_probe" does not exist
```

### 4. `pnpm db:roles-rls:verify` — `mas_radar_e2e_verify` (DISPOSABLE) · exit 0 · 29/29

```text
Hedef: db=mas_radar_e2e_verify user=mas_radar_app (owner bağlantısı: db=mas_radar_e2e_verify user=postgres)

PASS  her canlı tablo kod matrisinde sınıflandırılmış — 85 tablo
...
29/29 kontrol geçti.
ROLES-RLS VERIFY: ALL PASS
```

### 5. `pnpm db:security-matrix:verify` — `mas_radar_e2e_verify` (DISPOSABLE) · exit 0 · 17/17

```text
Hedef: db=mas_radar_e2e_verify user=postgres
...
17/17 kontrol geçti.
SECURITY MATRIX VERIFY: ALL PASS
```

### 6. `pnpm ops:telemetry` — 21 sinyal · exit 0

```text
  ok   probe_liveness      HTTP 200 (1578ms)  — /ready
  ok   probe_dependency    HTTP 200 (136ms)   — /health
  ok   db_connections      2
  ok   db_size             21 MB
  ok   backup_age_hours    1.7  — eşik 36s
  ok   runtime_user        mas_radar_app
  ok   schema_ledger       87/0087  — beklenen 87/0087
  ok   auth_locked_accounts 0

21/21 sinyal normal.
TELEMETRY: ALL CLEAR
TELEMETRY DELIVERY: OK
```

### 7. `pnpm ops:backup:prune` — **kuru koşu**, hiçbir dosya silinmedi · exit 0

```text
IMMUTABLE (dokunulmaz): 8
Tutulacak          : 33
Budanacak          : 833 (642.0 MB)
...
IMMUTABLE (asla silinmez):
  KEEP   stage07_real-2026-08-25T13-47-36-546Z.dump — IMMUTABLE — ad kalıbı /^stage\d+_real/i
  KEEP   migrate-mas_radar_dev-2026-08-25T09-43-53-637Z.dump — IMMUTABLE — ad kalıbı /mas_radar_dev/i
  KEEP   cutover_A_20260825-1211.dump — IMMUTABLE — ad kalıbı /^cutover_/i

KURU KOŞU — hiçbir dosya silinmedi. Gerçekten budamak için: --apply
```

### 8. Sağlık uçları (root seviyesi, `/api` altında değil)

```text
GET /health   {"status":"ok","app":"up","db":"up","latencyMs":1032,"time":"..."}
GET /ready    {"status":"ready","app":"up","time":"..."}
GET /version  {"name":"mas-nakit-radar","version":"0.1.0","commit":"unknown",...}
```

### 9. Gerçek DB sayımları (salt okuma) — runbook'lardaki beklenen değerlerin kaynağı

```text
schema_migrations = 87      max(version) = 0087
payments          = 20
users             = 17
```

### 10. Disk / migration bütünlüğü ölçümleri

```text
C:                238G toplam · 13G boş  (%95)
backups/          874 dosya · 981 MB
docker images     19.81 GB (16.26 GB geri kazanılabilir)
docker volumes    2.495 GB (1.857 GB geri kazanılabilir)
pg_database       20 veritabanı · toplam 346 MB · mas_radar_dev 21 MB
konteyner içi df  /var/lib/postgresql/data → 1007G, 934G boş (%3) — YANILTICI
```

Son satır `db-full.md`'de açıkça uyarı olarak duruyor: konteynerin gördüğü bolluk sanal
diskin kendisidir ve o sanal disk C: üzerinde büyür. Karar C:'ye bakarak verilir.

---

## COMMANDS DOCUMENTED BUT NOT RUN — ve her biri için sebep

| Komut | Neden koşulmadı |
|---|---|
| `pnpm db:app-role:password` | **Roller küme genelindedir.** Koşulsaydı port 3000'deki canlı üretim örneğinin `.env.local` parolası anında geçersizleşir ve uygulama düşerdi |
| `docker exec -it mas-radar-pg psql -U postgres` → `\password postgres` | Owner kimliğini döndürür; planlı bakım penceresi gerektirir |
| `update public.sessions set revoked_at = now() ...` | Gerçek veritabanına **yazar**; herkesi dışarı atar |
| `pnpm start` / `pnpm build` | Canlı sunucu port 3000'i ve `.next` dizinini kullanıyor; ikinci bir derleme onu bozardı (tek Next sunucusu kuralı) |
| `Stop-Process -Id <pid>` / `docker compose stop` / `restart` | Canlı üretim örneğini ve veritabanını düşürürdü |
| `pnpm ops:backup:daily`, `backup-db.sh`, `backup-receipt.ts` | Yeni dump üretir; C: %95 dolu ve `backups/` zaten 981 MB |
| `pnpm exec tsx scripts/ops/backup-prune.ts --apply` | **Geri alınamaz silme.** Kuru koşu 833 dosya / 642 MB silineceğini söylüyor; bu karar operatörün |
| `pnpm ops:backup:offdevice` | Off-device fiziksel hedef yok (açık P0, donanım) |
| `pnpm exec tsx scripts/ops/schedule-windows.ts install --apply` | Kullanıcının makinesine **kalıcı** zamanlanmış görev kaydeder; operatör kararı |
| `pnpm release:restore-drill`, `stage07-backup-gate.ts` | Disk + süre; ayrıca kendi derleme dizinlerini üretir |
| `docker exec ... dropdb` | Harcanabilir klonlar başka çalışmalarca kullanımda olabilir |
| `pnpm db:migrate` (gerçek DB) | Cutover penceresi dışında gerçek veritabanında migration çalıştırılmaz (§29) |
| `pnpm exec tsx scripts/db/seed-admin.ts` | Gerçek `public.users` tablosuna yazar |
| `/system/security` arayüz işlemleri | Gerçek hesapları değiştirir |
| `pnpm db:legacy-repair:verify` | OPS-01'in **kaynağı**; 10 dakikadan uzun sürer ve yarıda kesilirse 58 migration'ı gizli bırakır |

---

## PART B — kimlik satırı (Aşama 11'den devreden P2)

**Bulgu:** doğrulama kapıları hangi veritabanına bağlandıklarını yazmıyordu. B5-2'nin sahte
yeşili tam olarak bu yüzden görünmezdi.

**Değişen kapılar:** `scripts/db/roles-verify.ts`, `scripts/db/roles-rls-verify.ts`,
`scripts/db/security-matrix-verify.ts`.

**Örnek satır:**

```text
Hedef: db=mas_radar_dev user=mas_radar_app
```

**Tasarım kararları:**

1. Satır **ölçülür**, bağlantı dizesinden türetilmez: `select current_database(), current_user`.
   Niyet edilen hedef ile gerçekten bağlanılan hedef ayrı şeylerdir; sahte yeşili yaratan da
   bu ayrımdı.
2. Yalnız **ad**. Host, port, parola ve tam URL hiçbir kolda yazdırılmaz.
3. Bağlantı hiç açılamazsa satır yine yazılır — `Hedef (bağlanılamadı): db=… user=…` — ve
   değeri `connectionTargetParts` üzerinden alınır, ham dize asla dönmez.
4. Ayrıştırma mantığı **kopyalanmadı**: `connectionTargetLabel` yeniden yazıldı ve artık aynı
   `connectionTargetParts` fonksiyonunu çağırıyor.

**Assertion ve çıkış kodu sözleşmesi değişmedi — kanıt:**

| Kapı | Assertion sayısı | Exit | Not |
|---|---|---|---|
| `db:roles:verify` (gerçek DB) | **8/8** | 0 | Aşama 11'deki sayıyla aynı |
| `db:roles:verify` (bağlanamama) | — | **1** | Hata kolu korunmuş |
| `db:roles-rls:verify` (harcanabilir) | **29/29** | 0 | — |
| `db:security-matrix:verify` (harcanabilir) | **17/17** | 0 | — |
| `tests/env-source.test.ts` | 16 → **22** | 0 | 5 yeni test + parçalayıcı tutarlılık testi |

---

## GERÇEK OLAYLARIN RUNBOOK'LARA EŞLENMESİ

| Olay | Nerede anlatılıyor |
|---|---|
| **OPS-01** — yarıda kesilen `legacy-repair:verify` 58 migration'ı gizler; `git checkout` **yanlış** kurtarmadır | `failed-migration.md` (ARIZA 1, tam kurtarma + üç kanıt) · `incident.md` (belirti B) |
| **Env shadowing** — kabuktaki bayat değişken `.env.local`'ı ezer; kapı yanlış DB'ye karşı 8/8 der | `start.md` (ön koşul kapısı) · `incident.md` (belirti A, 18≠17 dâhil) · `cutover.md` (C1 gerekçesi) |
| **Kod/şema eşleşmezliği** — yeni kod + eski şema ve tersi, ikisi de desteklenmez; C2 bu yüzden var | `failed-migration.md` (ARIZA 3) · `cutover.md` (C2 gerekçesi ve D'ye kilitliliği) |
| **Küme-geneli rol parolası** — `db:app-role:password` canlıyı düşürür | `password-rotation.md` (belgenin en üstünde, uyarı olarak) |
| **`tsx` `.env.local`'ı okumaz** | `start.md` · `incident.md` · `cutover.md` · `failed-migration.md` |

---

## EXPECTED vs ACTUAL

| # | Beklenen | Gerçekleşen |
|---|---|---|
| 1 | 12 runbook, 10 bölümlük format | **12/12 yazıldı, 10/10 bölüm** |
| 2 | İkinci operatör drill'i | **YAPILMADI — ikinci bir insan gerekiyor** |
| 3 | Secret rotation prosedürü (4 sınıf) | **Yazıldı**; koşulmadı (canlıyı düşürür) |
| 4 | Kanıt dosyasında gerçek secret yok | **Yok** — hedefler yalnız `db=<ad> user=<ad>` |
| 5 | Kimlik satırı (P2) | **3 kapıya eklendi**, iki kolda da kanıtlandı |
| 6 | Atıf yapılan her komut var olmalı | **Doğrulandı** — `package.json` ve `scripts/` üzerinden |

---

## PASS

- 12/12 runbook, zorunlu 10 bölümle yazıldı; her birinde §29 veri sınıfı ve `WRITE EXPECTED?` var.
- Runbook'larda geçen her komut `package.json` scriptlerine ya da `scripts/` altındaki gerçek
  bir dosyaya karşılık geliyor. Uydurulmuş komut yok.
- Kimlik satırı üç kapıya eklendi; assertion sayıları ve çıkış kodları değişmedi.
- Gerçek üç olay (OPS-01, env shadowing, kod/şema eşleşmezliği) ilgili runbook'lara işlendi.
- Salt okuma kanıt koşuları geçti: `db:env:source` 0 · `db:roles:verify` 8/8 · `ops:telemetry`
  21/21 · `ops:backup:prune` kuru koşu 0.
- Harcanabilir hedefte: `db:roles-rls:verify` 29/29 · `db:security-matrix:verify` 17/17.
- Depo kapıları: `typecheck` 0 · `lint` 0 hata · `boundary:verify` 8/8 · `test` 55 dosya /
  1286 test, 0 başarısız.

## FAIL

Yok.

## NOT VERIFIED

- **Second-operator drill — NOT VERIFIED, requires a second person.** Rehber §25 açıkça
  "ikinci bir kişi veya owner dışındaki kontrollü operatör" diyor. Bir ajanın kendi yazdığı
  runbook'u okuyup "anlaşılır" demesi bu kriteri karşılamaz; ölçülmek istenen şey tam olarak
  **yazarın bildiği ama yazmadığı** şeylerdir. Bu kalem kapatılamaz.
- **Runbook'ların yıkıcı yolları** — durdurma, yeniden başlatma, parola rotasyonu, `--apply`
  budama, gerçek restore, zamanlanmış görev kaydı — koşulmadı. §30.6 gereği bunlar
  "belgelendi" sayılır, "kanıtlandı" sayılmaz.
- **Restore tatbikatı** bu turda koşulmadı; en son kanıt Aşama 07'ye ait
  (`05-real-backup-restore.md`).
- **Off-device fiziksel hedef** hâlâ BLOCKED (donanım yok) — açık P0, bu aşamanın kapsamında
  değil.

---

## P0 / P1 / P2

**P0** (bu aşamadan yeni doğan): yok. Devam eden iki P0 (off-device fiziksel hedef,
`p24b_*` fixture satırlarının gerçek DB'de bulunması) bu turda **dokunulmadan** bırakıldı.

**P1**
- Second-operator drill yapılmadı. Bus factor hâlâ **1**. Aşama 20 bu kalem kapanmadan
  DONE olamaz.

**P2**
- `docs/ops/` altındaki 12 runbook'un yıkıcı adımları koşulmadı; her biri bir bakım
  penceresinde en az bir kez koşturulup makbuzu bu dosyaya eklenmeli.
- `restore.md` tatbikatı ayda bir koşulmalı ve tarihi kaydedilmeli.

---

## EVIDENCE FILES

- `docs/ops/start.md`, `stop.md`, `backup.md`, `restore.md`, `cutover.md`,
  `password-rotation.md`, `user-creation.md`, `role-change.md`, `incident.md`, `db-full.md`,
  `docker-restart.md`, `failed-migration.md`
- Mevcut ve atıf yapılan: `docs/ops/backup-schedule.md`, `docs/ops/telemetry-alerting.md`,
  `docs/ops/incident-recovery-notes.md`, `docs/backup-restore-policy.md`,
  `docs/real-db-cutover-runbook.md`, `docs/release-evidence/cutover-checklist.md`,
  `docs/release-evidence/env-local-cutover-steps.md`
- Bu dosya: `docs/release-evidence/final-production-readiness/17-operational-resilience.md`

## NEXT GATE

1. **Second-operator drill** — owner dışında bir kişi, yalnız runbook'lara bakarak:
   start · stop · backup · restore disposable target · lock/deactivate user · incident
   evidence. Takıldığı her nokta runbook'un kusurudur ve düzeltilir.
2. Bir bakım penceresinde yıkıcı yolların makbuzlu koşusu.
3. Aşama 21 (final scorecard) bu iki kalem olmadan Aşama 20'yi DONE sayamaz.

---

## FINAL

**PARTIAL.**

Runbook seti tamam ve komutları gerçek. Ama rehber §30.6 bir runbook'un varlığını operasyona
hazırlık saymayı açıkça reddediyor ve §25 ikinci operatörü **isim vererek** şart koşuyor.
İkinci operatör bir insandır; bu aşama o kişi drill'i yapana kadar PARTIAL kalır.
