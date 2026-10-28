# RUNBOOK — docker restart (PostgreSQL konteynerini yeniden başlat)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`

---

## PURPOSE

Veritabanı konteynerini (`mas-radar-pg`) güvenle yeniden başlatmak.

Ne zaman gerekir:

- `/health` → `"db":"down"`
- `pg_isready` cevap vermiyor
- Docker Desktop yeniden başlatıldı ve konteyner kalkmadı
- Konteyner "unhealthy" görünüyor

### Önce şunu bilin: veri konteynerde DEĞİL

Veri `mas_radar_pgdata` adlı **kalıcı bir Docker volume**'unda durur. Konteyneri durdurmak,
yeniden başlatmak, hatta silip yeniden oluşturmak veriyi kaybettirmez.

**Veriyi silen tek komut şudur ve bu belgede yer almaz:**

```text
docker compose down -v      <-- ASLA ÇALIŞTIRMAYIN (-v volume'u siler)
```

`-v` olmadan `docker compose down` veriyi silmez, ama yine de gerekmez; `stop`/`start` yeterlidir.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Docker Desktop çalışıyor | `docker ps` bir tablo yazdırıyor |
| 2 | Devam eden içe aktarım / rapor üretimi yok | Uygulama ekranlarından bakın |
| 3 | Doğru konteynere bakıyorsunuz | aşağıdaki uyarı |

### Bu makinede birden fazla PostgreSQL konteyneri var

`docker ps` çıktısında MAS'a ait olmayan konteynerler de görünür (başka projelerin
veritabanları, geçici sandbox'lar). **Yalnız `mas-radar-pg` adlı konteynere dokunun.**

```powershell
docker ps --format "{{.Names}}`t{{.Image}}`t{{.Status}}`t{{.Ports}}"
```

MAS'ın konteyneri şu satırdır:

```text
mas-radar-pg    postgres:16    Up ...    127.0.0.1:5432->5432/tcp
```

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : REAL_READ_ONLY
WRITE EXPECTED? : NO
```

Konteyner yaşam döngüsü verinin mantıksal içeriğini değiştirmez. Yeniden başlatma sırasında
**açık işlemler geri alınır** (rollback) — yarıda kalmış bir yazma yarım kalmaz, hiç olmamış
sayılır. Bu doğru davranıştır.

---

## COMMANDS

### 1) Önce durumu ölçün

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
docker ps -a --filter "name=mas-radar-pg" --format "{{.Names}}`t{{.Status}}"
docker exec mas-radar-pg pg_isready -U postgres
docker logs --tail 50 mas-radar-pg
```

### 2) Uygulamayı önce durdurun (önerilir)

Veritabanı altından çekilirse uygulama hata verir. Sıra: **uygulama dur → veritabanı yeniden
başlat → uygulama başlat.**

`docs/ops/stop.md`

### 3) Yeniden başlatma — en hafiften ağıra

```powershell
# a) En hafif: yalnız yeniden başlat
docker compose restart postgres

# b) Kalkmadıysa: durdur, başlat
docker compose stop
docker compose up -d

# c) Konteyner hiç yoksa (silinmişse): compose yeniden oluşturur, VERİ VOLUME'DA DURUR
docker compose up -d
```

### 4) Hazır olmasını bekleyin

```powershell
docker exec mas-radar-pg pg_isready -U postgres
```

Hemen cevap vermeyebilir; 5–10 saniye arayla birkaç kez deneyin.

### 5) Doğrulayın

```powershell
docker exec mas-radar-pg psql -U postgres -t -A -c "select version();"
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -t -A -c "select count(*) from public.schema_migrations;" -c "select count(*) from public.payments;" -c "select count(*) from public.users;"
```

### 6) Uygulamayı başlatın

`docs/ops/start.md`

---

## EXPECTED

```text
docker ps                ->  mas-radar-pg  Up ...  127.0.0.1:5432->5432/tcp
pg_isready               ->  accepting connections
select version()         ->  PostgreSQL 16.x
schema_migrations        ->  87
payments / users         ->  20 / 17
/health (uygulama açınca)->  {"status":"ok","app":"up","db":"up",...}
```

Volume yerinde mi (yeniden oluşturmadan sonra kontrol etmeye değer):

```powershell
docker volume ls --filter "name=mas_radar_pgdata"
```

**Beklenen:** `mas_radar_pgdata` satırı görünür.

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `docker: error during connect` | Docker Desktop kapalı/başlıyor | Docker Desktop'ı açın, 1–2 dk bekleyin |
| Konteyner sürekli yeniden başlıyor (`Restarting`) | Açılışta hata | `docker logs --tail 100 mas-radar-pg` |
| `could not write to file ... No space left on device` | **Disk doldu** | `docs/ops/db-full.md` |
| `port is already allocated` | 5432'yi başka bir şey tutuyor | `Get-NetTCPConnection -LocalPort 5432 -State Listen` — hangi süreç? |
| `database system was not properly shut down; automatic recovery in progress` | Normal kurtarma | Bekleyin; `pg_isready` yeşile döner |
| `pg_isready` iyi ama `psql` "database does not exist" | **Yanlış konteyner/küme** | `docker ps` çıktısını tekrar okuyun — `mas-radar-pg` mi? |
| Satır sayıları beklenenden farklı | Yanlış veritabanı ya da veri kaybı | **DURUN** — `docs/ops/incident.md` |
| Volume listede yok | Volume silinmiş | **P0** — `docs/ops/restore.md` ile yedekten kurtarma |

---

## STOP CONDITION

1. `mas_radar_pgdata` volume'u listede yoksa → **P0**. Hiçbir şey oluşturmayın, hemen
   `docs/ops/incident.md` + `docs/ops/restore.md`.
2. Yeniden başlatma sonrası satır sayıları düşükse → **DURUN**, `docs/ops/incident.md`.
3. `docker logs` disk hatası gösteriyorsa → yeniden başlatmayı tekrarlamayın, önce
   `docs/ops/db-full.md`.
4. Elinizde güncel bir yedek yoksa ve konteyner açılmıyorsa → önce `docs/ops/incident.md`
   ile kanıt toplayın; deneme yanılma yapmayın.

---

## ROLLBACK

Yeniden başlatmanın geri alınması yoktur — durum ya düzelir ya düzelmez.

Konteyneri yeniden oluşturduysanız ve bir şey ters gittiyse:

```powershell
docker compose stop
docker volume ls --filter "name=mas_radar_pgdata"   # volume yerinde mi?
docker compose up -d
```

Volume duruyorsa veri de duruyordur. Durmuyorsa bu artık bir kurtarma olayıdır:
`docs/ops/restore.md`.

---

## EVIDENCE

```text
tarih/saat            :
belirti               :
docker ps (önce)      :
docker logs (son 50)  :  (dosyaya kaydedin)
uygulanan komut       :  restart / stop+up / up -d
pg_isready (sonra)    :
select version()      :
ledger / payments / users : 87 / 20 / 17 bekleniyor -> ...
volume var mı         :  EVET/HAYIR
uygulama /health      :
```

---

## SECRET HANDLING

- Bu runbook'ta parola geçmez. `-U postgres` yalnız bir kullanıcı adıdır; bağlantı konteyner
  içinden kurulduğu için parola gerekmez.
- `docker logs` çıktısında bağlantı dizeleri **görünmez**, ama kullanıcı adları görünebilir;
  paylaşmadan önce okuyun.
- `docker compose` dosyası parolayı ortam değişkeninden alır (`POSTGRES_PASSWORD`); dosyayı
  ekran görüntüsüyle paylaşmayın.
