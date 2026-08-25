# RUNBOOK — incident (olay: kanıt topla, karar ver)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Yaşanmış arıza biçimleri ve çıkış yolları:** `docs/ops/incident-recovery-notes.md`

---

## PURPOSE

Bir şeyler ters gittiğinde **önce kanıt toplamak**, sonra karar vermek.

Bu runbook'un tek amacı budur ve sırası tersine çevrilemez. Panikle atılan bir düzeltme adımı
(en sık: `git checkout`, konteyner silme, veritabanı düşürme) çoğu zaman olayın kendisinden
daha büyük zarar verir ve **kanıtı yok eder**.

### Altın kural

```text
1. DUR   — düzeltmeye çalışma
2. TOPLA — aşağıdaki komutları sırayla çalıştır, çıktıları kaydet
3. KARAR — beş karardan birini ver
4. UYGULA— ilgili runbook'a git
```

---

## PRECONDITIONS

Yok. Bu runbook her koşulda çalıştırılabilir; komutların tamamı **yalnız okumadır**.

Uygulama çökmüş, veritabanı kapalı, disk dolmuş olabilir — komutlar yine de denenebilir ve
çalışmayan komutun kendisi bir bulgudur. **Çalışmayan komutun çıktısını da kaydedin.**

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : REAL_READ_ONLY
WRITE EXPECTED? : NO
```

Bu belgedeki hiçbir komut veri değiştirmez. Değiştiren her adım başka bir runbook'a
devredilmiştir.

---

## COMMANDS

Sırayla çalıştırın. Her komutun çıktısını, çalışmasa bile, kopyalayıp saklayın.

### 1) Zaman ve kod sürümü

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
Get-Date -Format "yyyy-MM-dd HH:mm:ss K"
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
git status --porcelain
```

### 2) Süreçler ve portlar

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess
docker ps --format "{{.Names}}`t{{.Status}}`t{{.Ports}}"
```

### 3) Uygulama sağlığı

```powershell
curl.exe -s -m 5 http://127.0.0.1:3000/health
curl.exe -s -m 5 http://127.0.0.1:3000/ready
curl.exe -s -m 5 http://127.0.0.1:3000/version
```

### 4) Ortam hijyeni — en sık yanlış teşhis edilen nokta

```powershell
pnpm db:env:source
```

### 5) Veritabanı kimliği ve büyüklükleri (yalnız okuma)

```powershell
docker exec mas-radar-pg pg_isready -U postgres
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -t -A -c "select current_database(), current_user;" -c "select count(*) from public.schema_migrations;" -c "select max(version) from public.schema_migrations;" -c "select count(*) from public.payments;" -c "select count(*) from public.users;"
docker exec mas-radar-pg psql -U postgres -c "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database order by pg_database_size(datname) desc limit 10;"
```

### 6) Çalışma zamanı kimliği kapısı

```powershell
$env:DATABASE_URL = ((Select-String -Path .env.local -Pattern '^DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^DATABASE_URL=','')
pnpm db:roles:verify
```

İlk satır hedefi söyler: `Hedef: db=... user=...`

### 7) Telemetri anlık görüntüsü (21 sinyal tek ekranda)

```powershell
$env:MIGRATION_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')
$env:MAS_APP_BASE_URL = "http://127.0.0.1:3000"
pnpm ops:telemetry
```

### 8) Disk

```powershell
Get-PSDrive C | Select-Object Used, Free
docker system df
```

### 9) Kayıt dosyaları

```powershell
Get-Content logs\alerts.jsonl -Tail 20 -ErrorAction SilentlyContinue
Get-Content logs\telemetry-runs.jsonl -Tail 5 -ErrorAction SilentlyContinue
Get-Content backups\daily-runs.jsonl -Tail 5 -ErrorAction SilentlyContinue
docker logs --tail 50 mas-radar-pg
```

### 10) Migration dizini bütünlüğü (kesilmiş bir doğrulama koşusundan sonra ZORUNLU)

```powershell
(Get-ChildItem supabase\migrations\*.sql).Count
(Get-ChildItem supabase\migrations\ | Where-Object { $_.Name -like "*hidden-for*" }).Count
git status --porcelain supabase/migrations/
```

---

## EXPECTED

Sağlıklı bir sistemde:

```text
/health                       ->  {"status":"ok","app":"up","db":"up",...}
/ready                        ->  {"status":"ready",...}
pnpm db:env:source            ->  ENV SOURCE: gölgeleme yok.
roles:verify ilk satır        ->  Hedef: db=mas_radar_dev user=mas_radar_app
roles:verify son satır        ->  8/8 kontrol geçti.
schema_migrations             ->  87   ·   en son 0087
payments / users              ->  20   ·   17
pnpm ops:telemetry            ->  21/21 sinyal normal · TELEMETRY: ALL CLEAR
migrations *.sql sayısı       ->  87
*hidden-for* sayısı           ->  0
git status supabase/migrations->  boş
port 3000 dinleyici           ->  tam olarak 1 (uygulama çalışıyorsa)
```

Bu değerlerden **sapan her satır bir bulgudur** ve kayda geçer.

---

## FAILURE SIGNALS

### Üç gerçekten yaşanmış arıza — önce bunlara bakın

#### A) Ortam gölgelemesi — "dosyayı düzelttim, hâlâ olmuyor"

**Belirti:** `.env.local` doğru, hata sürüyor. Daha kötüsü: doğrulama kapıları **yeşil yanıyor**.

**Ölçülmüş hâli:** kabukta kalmış eski bir `DATABASE_URL` yüzünden `db:roles:verify` **yanlış
veritabanına** karşı `8/8 kontrol geçti` dedi ve `18 kullanıcı satırı` bildirdi. Gerçek
veritabanında **17** var. Yanlışlığı yalnız bu sayı ortaya çıkardı.

**Teşhis:**
```powershell
pnpm db:env:source          # GÖLGELEME satırı var mı?
pnpm db:roles:verify        # ilk satırdaki db= adı beklenen mi?
```

**Çözüm:** bu pencereyi kapatın, **yeni** bir PowerShell açın. Ya da:
```powershell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:MIGRATION_DATABASE_URL -ErrorAction SilentlyContinue
```

> **Not:** `tsx` ile çalışan komutlar (`migrate`, `seed`, `verify`) `.env.local` dosyasını
> **okumaz**. Next runtime okur. Bu yüzden dosyayı düzeltmek bir script'i düzeltmez.

#### B) OPS-01 — yarıda kesilen `legacy-repair:verify` 58 migration'ı "silinmiş" gösterir

**Belirti:** `git status` `supabase/migrations/` altında **58 silinmiş dosya** gösteriyor;
`pnpm db:migrate` ve CI düşüyor.

**Mekanizma:** doğrulama koşusu bazı migration dosyalarını geçici olarak
`....sql.hidden-for-legacy-repair-verify-<pid>-<epoch>` adına çevirir ve sonunda geri alır.
Süreç arada öldürülürse dosyalar gizli kalır.

**YANLIŞ kurtarma:** `git checkout -- supabase/migrations/` — bu, gizlenmiş kopyaları
**yerinde bırakır** ve 87 gerçek + 58 artık dosya üretir.

**DOĞRU kurtarma ve kanıtı:** `docs/ops/failed-migration.md` → "OPS-01".

**En önemli kural:** `supabase/migrations/` kirliyken **commit almayın.**

#### C) Kod / şema eşleşmezliği

**Belirti:** `permission denied for table users`, ekranlarda "column does not exist", giriş
yapılamıyor.

**Anlamı:** çalışan kod ile veritabanı şeması farklı sürümlerde. **Yeni kod + eski şema** ve
**eski kod + yeni şema** — ikisi de desteklenmeyen durumdur.

**Teşhis:**
```powershell
git rev-parse HEAD
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -t -A -c "select count(*), max(version) from public.schema_migrations;"
```

**Çözüm:** `docs/ops/failed-migration.md`.

### Diğer belirtiler

| Belirti | Muhtemel yer | Gidilecek runbook |
|---|---|---|
| `/health` → `"db":"down"` | PostgreSQL kapalı | `docs/ops/docker-restart.md` |
| `no space left on device` | Disk | `docs/ops/db-full.md` |
| Port 3000'de **iki** dinleyici | İki Next sunucusu | `docs/ops/stop.md` |
| `backup_age_hours` uyarısı | Yedek alınmıyor | `docs/ops/backup.md` |
| `jobs_stuck > 0` | Yarıda kesilmiş iş | Bu belge → EVIDENCE, sonra karar |
| `auth_locked_accounts > 0` | Hesap kilitli | `docs/ops/role-change.md` |
| Beklenmedik kullanıcı / rol | Yetki olayı | `docs/ops/role-change.md` (kapat) + `docs/ops/password-rotation.md` |
| `system_identifier` uyuşmuyor | Yanlış PostgreSQL kümesi | **DURUN**, kimseye komut çalıştırmayın |

---

## STOP CONDITION

Aşağıdakilerden biri varsa **hiçbir düzeltme yapmayın**; kanıtı toplayıp durun ve durumu
sahibine bildirin (ESCALATE):

1. Finansal satır sayıları beklenenden **düşük** (`payments` < 20, `users` < 17) ve sebebi
   bilinmiyor.
2. Kimlik satırı beklenen veritabanını göstermiyor.
3. `system_identifier` beklenen kümeyle eşleşmiyor.
4. Elinizdeki **son iki** yedek de geri yüklenemiyor.
5. `supabase/migrations/` kirli ve `*hidden-for*` dosyalar var — **commit almayın.**
6. Yetkisiz erişim şüphesi var.

---

## ROLLBACK

Bu runbook değişiklik yapmadığı için geri alınacak bir şey yoktur.

Kanıt toplandıktan sonra **beş karardan biri** verilir. Bu beş karar, cutover'daki operatör
kararlarıyla aynı kelimelerdir:

| Karar | Ne zaman | Nereye gidilir |
|---|---|---|
| **STOP** | Veri bütünlüğü şüpheli, sebep bilinmiyor | Hiçbir şey yapma, sahibine bildir |
| **RETRY** | Geçici arıza (kilit, zaman aşımı, kapalı konteyner) | `docs/ops/docker-restart.md`, `docs/ops/start.md` |
| **CONFIG ROLLBACK** | Şema sağlam, sorun ayar/rol/ortamda | `docs/ops/cutover.md` → "CONFIG ROLLBACK" |
| **DB RESTORE** | Şema/veri bütünlüğü gerçekten bozuk | `docs/ops/restore.md` + `docs/ops/cutover.md` → "DB RESTORE" |
| **ESCALATE** | Yukarıdaki STOP koşullarından biri | Kanıt paketini teslim et |

**Ayar sorunu için veritabanı geri yüklenmez.** Bu kural pahalıya öğrenildi ve değiştirilmez.

---

## EVIDENCE

Olayı `docs/ops/incident-recovery-notes.md` altına yeni bir başlık olarak ekleyin. Şablon:

```text
## OLAY <sıra no> — <tek cümlelik belirti>

sınıf (P0/P1/P2)    :
ilk gözlem (tarih)  :
gözlemleyen         :

TOPLANAN KANIT
  git HEAD / branch :
  git status        :
  port 3000         :
  docker ps         :
  /health /ready    :
  db:env:source     :
  kimlik satırı     : Hedef: db=... user=...
  ledger / payments / users :
  telemetri         : n/21
  disk (C: boş)     :
  logs/alerts.jsonl :
  migrations sayımı : *.sql=...  hidden-for=...

MEKANİZMA (ne oldu)  :
YANLIŞ KURTARMA      :  (denendiyse)
DOĞRU KURTARMA       :
VERİLEN KARAR        :  STOP / RETRY / CONFIG ROLLBACK / DB RESTORE / ESCALATE
ÖNLEME               :
```

Toplanan çıktıları düz metin olarak saklayın. **Ekran görüntüsü yerine metin tercih edin** —
aranabilir ve içinde ne olduğu görülebilir olur.

---

## SECRET HANDLING

- Kanıt paketine **bağlantı dizesi, parola, token yapıştırılmaz.** Hedef yalnız
  `db=<ad> user=<ad>` biçiminde adlandırılır.
- `pnpm db:env:source` ve doğrulama kapıları bilinçli olarak yalnız adı yazar — çıktılarını
  olduğu gibi kopyalayabilirsiniz.
- `logs/alerts.jsonl` iki katmanlı maskeleme uygular (parolalı bağlantı dizesi, `/bot<token>/`,
  `Bearer ...`), ama yine de **operasyonel veri** içerir; `logs/` `.gitignore`'dadır ve
  paylaşılmadan önce gözden geçirilir.
- `docker logs` çıktısında kullanıcı adları görünebilir; parola görünmez. Paylaşmadan önce
  yine de okuyun.
- Bir sır kazayla ekrana geldiyse olay **yetki olayına** dönüşür: `docs/ops/password-rotation.md`.
