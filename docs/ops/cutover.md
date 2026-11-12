# RUNBOOK — cutover (gerçek veritabanına geçiş ve sürüm yükseltme) — operatör giriş kapısı

> **Kime:** MAS operatörüne.
> **Bu belge cutover'ı tek başına ANLATMAZ.** Cutover kontrol listesi tek yerde yazılıdır:
>
> ### `docs/release-evidence/cutover-checklist.md` — A'dan L'ye, kopyala-yapıştır
>
> Bu belge o listeye girmeden önce bilmeniz gereken **dört şeyi** söyler: sıra, kararlar,
> tuzaklar, durma koşulları.

---

## PURPOSE

Uygulamayı yerel Windows PostgreSQL 16 üzerindeki gerçek veritabanı (`mas_radar_dev`, kanonik şema **0113** — `113` migration `0001..0113`, `106` `public` tablo `%100` RLS, `87` görünüm `%100` `security_invoker = true`) üzerinde planlı, geri dönülebilir ve kanıtlı biçimde yükseltmek ve çalıştırmak.

Yardımcı belgeler:

| Belge | Ne için |
|---|---|
| `docs/release-evidence/cutover-checklist.md` | **Asıl liste** — A–L adımları, komutlar, beklenen çıktılar |
| `docs/release-evidence/v5-readiness-board.md` | v5 / Faz 59 hazırlık ve canlıya geçiş tahtası |
| `docs/real-db-cutover-runbook.md` | Adımların ardındaki gerekçe ve şema ayrıntısı |
| `docs/release-evidence/env-local-cutover-steps.md` | `.env.local` değişikliğinin tam hâli |
| [failed-migration.md](failed-migration.md) | D adımı düşerse |
| [restore.md](restore.md) | `"DB RESTORE"` kararı verilirse |

---

## PRECONDITIONS

Cutover **başlamaz** eğer bunlardan biri sağlanmıyorsa:

| # | Ön koşul | Kanıt |
|---|---|---|
| 1 | Açık **P0 yok** | `docs/MAS_360_SYNTHESIS_REPORT.md` & `docs/release-evidence/v5-readiness-board.md` |
| 2 | Doğrulanmış yedek + geri yükleme tatbikatı yapıldı | `pnpm release:stage07-backup-gate` ve `pnpm backup:offdevice:verify` |
| 3 | Off-device yedek hedefi bağlı | [backup-schedule.md](backup-schedule.md) §1 (`pnpm backup:offdevice:verify -- --strict-offdevice`) |
| 4 | Hedef commit belli ve kod o commit'te olacak | C2 adımı |
| 5 | Bakım penceresi ilan edildi, `MAS-Background-Worker` duraklatıldı | [stop.md](stop.md) |
| 6 | Geri dönüş için `.env.local`'in eski hâli güvenli biçimde not edildi | L adımı |
| 7 | Uygulama durdurulmuş ve açık bağlantı `0` | [stop.md](stop.md) |

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : PRODUCTION_WRITE
WRITE EXPECTED? : YES — bekleyen migration'lar (0113'e kadar) uygulanır, mas_radar_app rolü doğrulanır.
```

Bu, `mas_radar_dev`'in şema düzeyinde **PRODUCTION_WRITE** olarak kullanıldığı **tek** penceredir (`pnpm db:migrate` uygulama öncesi otomatik yedek de alır).

---

## COMMANDS

### Sıra — bölünemez, atlanamaz, yeri değiştirilemez

```text
A  →  B  →  C  →  C1  →  C2  →  D  →  E  →  F  →  G  →  H  →  I  →  J  →  K  →  L
```

| Adım | Ne | Bir cümlede neden burada |
|---|---|---|
| **A** | Doğrulanmış yedek | Geri dönülecek nokta olmadan hiçbir şey başlamaz |
| **B** | Bakım / yazma dondurma (`stop.md` + `MAS-Background-Worker` duraklatma) | Migration sırasında yazan bir süreç tutarsızlık üretir |
| **C** | Yerel PostgreSQL 16 owner bağlantısı | Şema değişikliğini yalnız `MIGRATION_DATABASE_URL` (owner) yapar |
| **C1** | **Ortam hijyeni** (`pnpm db:env:source`) | Kabukta kalmış bayat bir değişken yanlış veritabanını hedef yapar |
| **C2** | **Kod sürümünü hedef commit'e geçir** | Şema ile kod aynı sürümde olmalı — D'den ÖNCE |
| **D** | Migration geçişi (`pnpm db:migrate` → `0113`) | Asıl şema geçişi |
| **E** | Ledger + parmak izi | Satır sayısı ve parasal parmak izi kontrol edilir |
| **F** | `mas_radar_app` rolüne parola + `LOGIN` | Düşük yetkili çalışma zamanı kimliği |
| **G** | `.env.local` → `DATABASE_URL` + `MAS_LOCAL_PASSWORDLESS=0` | Uygulama düşük yetkiyle ve parolalı kimlik doğrulamayla bağlanır |
| **H** | `pnpm build` / `pnpm start` / `/health` | Uygulama ayağa kalkar ve `MAS-Background-Worker` etkinleştirilir |
| **I** | Çalışma zamanı kimliği (`pnpm db:roles:verify`) | Gerçekten `mas_radar_app` ile mi bağlandı |
| **J** | RLS & görünüm (`security_invoker`) negatif sondaları | Yetkisiz erişim gerçekten reddediliyor mu |
| **K** | Gerçek uygulama duman testi | Ekranlar ve tutarlar doğru mu |
| **L** | Kapanış veya geri dönüş kararı | Kanıt kaydı |

#### C1 ve C2 neden ayrı ve neden tam burada

- **C1 — ortam hijyeni:**

  ```powershell
  pnpm db:env:source
  ```

  Beklenen son satır: `ENV SOURCE: gölgeleme yok.` `GÖLGELEME` görürseniz **cutover BURADA durur**; yeni bir PowerShell açılır.

- **C2 — kod sürümü:** **Yeni kod + eski şema** ve **eski kod + yeni şema** desteklenmez. C2, D'den hemen önce ve D'ye kilitlidir.

### Cutover'ı başlatmadan önceki son dört komut

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
pnpm db:ensure                                              # Yerel PostgreSQL 16 hazır mı
pnpm db:env:source                                          # C1'in kapısı
git rev-parse HEAD; git status --porcelain                  # C2'nin girdisi
pnpm release:stage07-backup-gate                            # A'nın kanıtı
```

---

## EXPECTED

Cutover başarılı sayılır ancak şunların **tamamı** doğruysa:

```text
E  ledger                 ->  113 satır, en son 0113
E  katalog                ->  106 public tablo (%100 RLS), 87 görünüm (%100 security_invoker=true)
E  agregalar              ->  parmak izi eşleşiyor
F  rol                    ->  rolcanlogin=t  rolsuper=f  rolbypassrls=f
H  /health                ->  {"status":"ok","app":"up","db":"up",...}
I  kimlik                 ->  Hedef: db=mas_radar_dev user=mas_radar_app
I  db:roles:verify        ->  8/8 kontrol geçti.
J  RLS negatif sondaları  ->  reddedildi (beklenen)
K  ekranlar               ->  kritik rotalar açılıyor, tutarlar doğru
```

---

## FAILURE SIGNALS

| Belirti | Nereye |
|---|---|
| D adımı checksum veya SQL hatasıyla düştü | [failed-migration.md](failed-migration.md) |
| `git status` silinmiş/gizlenmiş migration gösteriyor | [failed-migration.md](failed-migration.md) ARIZA 1 (`OPS-01`) |
| Yedek `pg_restore --list` ile okunamıyor | [backup.md](backup.md) — **cutover başlamaz** |
| Disk hatası | [db-full.md](db-full.md) |
| Yerel PostgreSQL 16 hizmeti düştü | [postgres-service.md](postgres-service.md) |

---

## STOP CONDITION

Cutover **derhal durur** ve bir sonraki adıma geçilmez:

1. `pnpm db:env:source` gölgeleme bildiriyorsa (C1).
2. A adımındaki yedek okunamıyorsa ya da makbuz alanları eşleşmiyorsa.
3. B adımında açık veritabanı bağlantısı **0'a inmiyorsa**.
4. E adımında satır sayıları ya da agregalar yedekle **eşleşmiyorsa** (migration'ın kasıtlı şema emekliliği dışında).
5. `system_identifier` beklenen kümeyle eşleşmiyorsa.
6. Kod sürümü ile hedef commit farklıysa (C2 tamamlanmadıysa).
7. Herhangi bir adımda ne olduğunu **anlamadığınız** bir çıktı gördüyseniz.

Durduğunuzda: [incident.md](incident.md) ile kanıt toplayın, sonra aşağıdaki beş karardan birini verin.

---

## ROLLBACK

| Karar | Ne zaman | Ne yapılır | Maliyet |
|---|---|---|---|
| **STOP** | Belirsizlik var, sebep bilinmiyor | Hiçbir şey yapma, olduğu yerde bırak, kanıt topla | Kesinti sürer |
| **RETRY** | Geçici arıza (kilit, zaman aşımı, kapalı hizmet) | Hizmeti kontrol et ([postgres-service.md](postgres-service.md)), adımı tekrarla | Dakikalar |
| **CONFIG ROLLBACK** | Şema ve parmak izi **sağlam**, sorun ayar/rol/ortamda | `.env.local` eski satırına döner, yeniden başlatılır | Saniyeler — **şemaya dokunmaz** |
| **DB RESTORE** | Şema/veri **bütünlüğü bozuk** (yalnız D/E sinyalleri) | A adımındaki yedekten kontrollü geri yükleme (sahip onayıyla) | Saatler |
| **ESCALATE** | STOP koşullarından biri sürüyor | Kanıt paketiyle sahibine bildir | — |

### Değişmez kural

```text
Ayar (config) problemi için veritabanı geri yüklenmez.
```

---

## EVIDENCE

```text
tarih/saat (başlangıç - bitiş) :
operatör                       :
hedef commit (C2)              :
A yedek yolu + sha256 + makbuz :
B açık bağlantı sayısı         :  0
C1 env:source çıktısı          :  gölgeleme yok
D migration raporu             :  state / 0113 uygulandı / ön-yedek
E ledger + katalog + agrega    :  113/0113 · 106 tablo · 87 görünüm · parmak izi
F rol nitelikleri              :  rolcanlogin/rolsuper/rolbypassrls
H /health /ready /version      :
I kimlik satırı                :  Hedef: db=mas_radar_dev user=mas_radar_app
J RLS negatif sonda sonuçları  :
K ekran duman testi            :
L verilen karar                :  tamamlandı / CONFIG ROLLBACK / DB RESTORE
```

---

## SECRET HANDLING

- **Hiçbir bağlantı dizesi loglanmaz, yapıştırılmaz, ekran görüntüsüne alınmaz.**
- F adımındaki rol parolası maskeli olarak verilir ve hiçbir kanıt dosyasına yazılmaz ([password-rotation.md](password-rotation.md)).
- Cutover yedekleri gerçek finansal veri içerir; `backups/` `.gitignore`'dadır ve dışarı çıkarılmaz.
