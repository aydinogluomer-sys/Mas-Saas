# RUNBOOK — cutover (gerçek veritabanına geçiş) — operatör giriş kapısı

> **Kime:** MAS operatörüne.
> **Bu belge cutover'ı ANLATMAZ.** Cutover'ın kendisi tek bir yerde yazılıdır:
>
> ### 👉 `docs/release-evidence/cutover-checklist.md` — A'dan L'ye, kopyala-yapıştır
>
> Bu belge o listeye girmeden önce bilmeniz gereken **dört şeyi** söyler: sıra, kararlar,
> tuzaklar, durma koşulları. Adımların kendisini burada tekrar etmiyoruz — iki kopya
> arasındaki en küçük fark, cutover gecesi hangisinin doğru olduğunu bilememek demektir.

---

## PURPOSE

Uygulamayı gerçek veritabanı (`mas_radar_dev`, şema 0035 → 0087) üzerinde çalışır hâle
getirmek — planlı, geri dönülebilir ve kanıtlı biçimde.

Yardımcı belgeler:

| Belge | Ne için |
|---|---|
| `docs/release-evidence/cutover-checklist.md` | **Asıl liste** — A–L adımları, komutlar, beklenen çıktılar |
| `docs/real-db-cutover-runbook.md` | Adımların ardındaki gerekçe ve şema ayrıntısı |
| `docs/release-evidence/env-local-cutover-steps.md` | `.env.local` değişikliğinin tam hâli |
| `docs/ops/failed-migration.md` | D adımı düşerse |
| `docs/ops/restore.md` | "DB RESTORE" kararı verilirse |

---

## PRECONDITIONS

Cutover **başlamaz** eğer bunlardan biri sağlanmıyorsa:

| # | Ön koşul | Kanıt |
|---|---|---|
| 1 | Açık **P0 yok** | `PROGRESS.md` → aşama defteri |
| 2 | Doğrulanmış yedek + geri yükleme tatbikatı yapıldı | `pnpm exec tsx scripts/release/stage07-backup-gate.ts` |
| 3 | Off-device yedek hedefi bağlı | `docs/ops/backup-schedule.md` §1 |
| 4 | Hedef commit belli ve kod o commit'te olacak | C2 adımı |
| 5 | Bakım penceresi ilan edildi, kullanıcılar bilgilendirildi | — |
| 6 | Geri dönüş için `.env.local`'in eski hâli kaydedildi | L adımı |
| 7 | Uygulama durdurulabilir durumda | `docs/ops/stop.md` |

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : PRODUCTION_WRITE
WRITE EXPECTED? : YES — şema 0035 -> 0087 uygulanır, rol LOGIN'e açılır, runtime kimliği çevrilir.
```

Bu, `mas_radar_dev`'in **PRODUCTION_WRITE** olarak kullanıldığı **tek** penceredir. Bu pencere
dışında gerçek veritabanı `REAL_READ_ONLY / BACKUP SOURCE`'tur ve öyle davranılır.

---

## COMMANDS

### Sıra — bölünemez, atlanamaz, yeri değiştirilemez

```text
A  →  B  →  C  →  C1  →  C2  →  D  →  E  →  F  →  G  →  H  →  I  →  J  →  K  →  L
```

| Adım | Ne | Bir cümlede neden burada |
|---|---|---|
| **A** | Doğrulanmış yedek | Geri dönülecek nokta olmadan hiçbir şey başlamaz |
| **B** | Bakım / yazma dondurma | Migration sırasında yazan bir uygulama tutarsızlık üretir |
| **C** | Owner bağlantısı | Şema değişikliğini yalnız owner yapar |
| **C1** | **Ortam hijyeni** | Kabukta kalmış bayat bir değişken yanlış veritabanını hedef yapar |
| **C2** | **Kod sürümünü hedef commit'e geçir** | Şema ile kod aynı sürümde olmalı — D'den ÖNCE |
| **D** | Migration 0035 → 0087 | Asıl şema geçişi |
| **E** | Ledger + parmak izi | Sayı aynı ama tutar değişmiş olabilir; ikisi de kontrol edilir |
| **F** | `mas_radar_app` rolüne parola + LOGIN | Çalışma zamanı kimliği |
| **G** | `.env.local` → `DATABASE_URL` çevrilir | Uygulama artık düşük yetkiyle bağlanır |
| **H** | Build / start / health | Uygulama ayağa kalkar |
| **I** | Çalışma zamanı kimliği | Gerçekten `mas_radar_app` ile mi bağlandı |
| **J** | RLS negatif sondaları | Yetkisiz erişim gerçekten reddediliyor mu |
| **K** | Gerçek uygulama duman testi | Ekranlar ve tutarlar doğru mu |
| **L** | Geri dönüş kararı | Kapanış |

#### C1 ve C2 neden ayrı ve neden tam burada

Bu iki adım listeye **sonradan** eklendi, çünkü ikisinin de eksikliği bu makinede canlı
ortamda patladı.

- **C1 — ortam hijyeni.** `.env.local` düzeltildi, hata sürdü; sebep, eski bir PowerShell
  oturumunda kalmış `DATABASE_URL` idi. Daha kötüsü: doğrulama kapısı **yanlış veritabanına**
  karşı `8/8 kontrol geçti` dedi ve `18 kullanıcı satırı` bildirdi — gerçek veritabanında
  **17** var. Bu adım gözle değil, kapıyla yapılır:

  ```powershell
  pnpm db:env:source
  ```

  Beklenen son satır: `ENV SOURCE: gölgeleme yok.` `GÖLGELEME` görürseniz **cutover BURADA
  durur**; yeni bir PowerShell açılır.

  > `tsx` ile çalışan komutlar `.env.local`'ı **okumaz**. Cutover adımlarını çalıştıracak
  > kabukta değişkenler **açıkça** tanımlanmalıdır. Yukarıdaki kapı bunu da söyler.

- **C2 — kod sürümü.** **Yeni kod + eski şema** ve **eski kod + yeni şema** — ikisi de
  desteklenmeyen durumdur. C2, D'den hemen önce ve D'ye kilitlidir. Sıra bozulursa çıkan
  belirti `permission denied for table users` olur ve migration'ın kendisiyle ilgisi yoktur.

### Cutover'ı başlatmadan önceki son üç komut

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
pnpm db:env:source                                          # C1'in kapısı
git rev-parse HEAD; git status --porcelain                  # C2'nin girdisi
pnpm exec tsx scripts/release/stage07-backup-gate.ts        # A'nın kanıtı
```

Üçü de temizse `docs/release-evidence/cutover-checklist.md` dosyasını açın ve **A adımından**
başlayın.

---

## EXPECTED

Cutover başarılı sayılır ancak şunların **tamamı** doğruysa:

```text
E  ledger                 ->  87 satır, en son 0087
E  veri sayıları          ->  A adımındaki yedekle AYNI (payments 20, users 17, ...)
E  agregalar              ->  parmak izi eşleşiyor (sayı aynı ama TUTAR değişmiş olabilir)
F  rol                    ->  rolcanlogin=t  rolsuper=f  rolbypassrls=f
H  /health                ->  {"status":"ok","app":"up","db":"up",...}
I  kimlik                 ->  Hedef: db=mas_radar_dev user=mas_radar_app
I  db:roles:verify        ->  8/8 kontrol geçti.
J  RLS negatif sondaları  ->  reddedildi (beklenen)
K  ekranlar               ->  kritik rotalar açılıyor, tutarlar doğru
```

Her adımın kendi "başarı böyle görünür / başarısızlık böyle görünür" tablosu **kontrol
listesindedir**.

---

## FAILURE SIGNALS

Bu makinede gerçekten yaşanmış dört tuzak. Ayrıntısı kontrol listesinin sonundadır.

| # | Tuzak | Belirti | Kök sebep |
|---|---|---|---|
| 1 | **F/G, D'den önce** | `permission denied for table users` | Rol/şema sırası bozuldu |
| 2 | **Oturum değişkeni** | Geri döndükten sonra bile aynı hata | Kabukta bayat `DATABASE_URL` (→ C1) |
| 3 | **Kod veritabanının çok ilerisinde** | Ekranlar boş, sütun yok | Kod/şema eşleşmezliği (→ C2) |
| 4 | **`.gitignore`'un `data/` deseni** | Eski koda dönerken dosyalar kayboluyor | Geri dönüş sırasında dikkat |

Diğer sinyaller:

| Belirti | Nereye |
|---|---|
| D adımı checksum hatasıyla düştü | `docs/ops/failed-migration.md` ARIZA 2 |
| `git status` 58 silinmiş migration | `docs/ops/failed-migration.md` ARIZA 1 (OPS-01) |
| Yedek `pg_restore --list` ile okunamıyor | `docs/ops/backup.md` — **cutover başlamaz** |
| Disk hatası | `docs/ops/db-full.md` |
| Konteyner düştü | `docs/ops/docker-restart.md` |

---

## STOP CONDITION

Cutover **derhal durur** ve bir sonraki adıma geçilmez:

1. `pnpm db:env:source` gölgeleme bildiriyorsa (C1).
2. A adımındaki yedek okunamıyorsa ya da makbuz alanları eşleşmiyorsa.
3. B adımında açık veritabanı bağlantısı **0'a inmiyorsa**.
4. E adımında satır sayıları ya da agregalar yedekle **eşleşmiyorsa**.
5. `system_identifier` beklenen kümeyle eşleşmiyorsa.
6. Kod sürümü ile hedef commit farklıysa (C2 tamamlanmadıysa).
7. Herhangi bir adımda ne olduğunu **anlamadığınız** bir çıktı gördüyseniz.

Durduğunuzda: `docs/ops/incident.md` ile kanıt toplayın, sonra aşağıdaki beş karardan birini
verin.

---

## ROLLBACK

Her arıza için **tek** ve **belirlenmiş** bir karar vardır. Tahminle seçilmez.

| Karar | Ne zaman | Ne yapılır | Maliyet |
|---|---|---|---|
| **STOP** | Belirsizlik var, sebep bilinmiyor | Hiçbir şey yapma, olduğu yerde bırak, kanıt topla | Kesinti sürer |
| **RETRY** | Geçici arıza (kilit, zaman aşımı, kapalı konteyner) | Aynı adımı tekrarla | Dakikalar |
| **CONFIG ROLLBACK** | Şema ve parmak izi **sağlam**, sorun ayar/rol/ortamda | `.env.local` eski satırına döner, gerekirse rol kapatılır, yeniden başlatılır | Saniyeler — **şemaya dokunmaz** |
| **DB RESTORE** | Şema/veri **bütünlüğü bozuk** (yalnız D/E sinyalleri) | A adımındaki yedekten geri yükleme | Saatler |
| **ESCALATE** | STOP koşullarından biri sürüyor | Kanıt paketiyle sahibine bildir | — |

### Değişmez kural

```text
Ayar (config) problemi için veritabanı geri yüklenmez.
```

Bu kural pahalıya öğrenildi. "Ne olur ne olmaz" diye yapılan bir DB restore, ayarla
çözülebilecek bir sorunu saatlerce süren bir kurtarma işine çevirir ve o sırada alınan
kararlar yeni hatalar üretir.

**Config rollback'in tam komutları** kontrol listesinin L bölümündedir
(`docs/release-evidence/cutover-checklist.md` → "L — Geri dönüş").

---

## EVIDENCE

Cutover'ın kanıt paketi zorunludur ve şunları içerir:

```text
tarih/saat (başlangıç - bitiş) :
operatör                       :
hedef commit (C2)              :
A yedek yolu + sha256 + makbuz :
B açık bağlantı sayısı         :  0
C1 env:source çıktısı          :  gölgeleme yok
D migration raporu             :  state / pending uygulandı / yedek
E ledger + sayı + agrega       :  87/0087 · 20 · 17 · parmak izi
F rol nitelikleri              :  rolcanlogin/rolsuper/rolbypassrls
H /health /ready /version      :
I kimlik satırı                :  Hedef: db=mas_radar_dev user=mas_radar_app
J RLS negatif sonda sonuçları  :
K ekran duman testi            :
L verilen karar                :  tamamlandı / CONFIG ROLLBACK / DB RESTORE
```

Dosyalar:

- `docs/release-evidence/final-production-readiness/09-cutover-rehearsal.md` (prova)
- `docs/release-evidence/final-production-readiness/10-ready-for-cutover-board.md` (karar tahtası)
- Cutover sonrası: `docs/release-evidence/final-production-readiness/` altında ilgili slot

---

## SECRET HANDLING

- **Hiçbir bağlantı dizesi loglanmaz, yapıştırılmaz, ekran görüntüsüne alınmaz.** Bu, kontrol
  listesinin C1 adımının açık talebidir.
- Cutover kabuğunda değişkenler `.env.local`'den değeri ekrana yazmadan alınır; kapılar hedefi
  yalnız `db=<ad> user=<ad>` olarak söyler.
- F adımındaki rol parolası maskeli olarak verilir ve hiçbir kanıt dosyasına yazılmaz — yalnız
  "verildi" olgusu kaydedilir (`docs/ops/password-rotation.md`).
- Cutover yedekleri gerçek finansal veri içerir; `backups/` `.gitignore`'dadır ve dışarı
  çıkarılmaz.
- Cutover gecesi ekran paylaşımı yapılacaksa **terminal paylaşılmaz**; yalnız uygulama
  penceresi paylaşılır.
