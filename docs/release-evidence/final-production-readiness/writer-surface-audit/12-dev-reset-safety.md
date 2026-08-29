# 12 — P1 düzeltmesi: `scripts/db/dev-reset.sh` fail-closed yıkım kapısı

## Kusur

Önceki hâli, 13 satırın tamamı:

```bash
set -euo pipefail
bash "$(dirname "$0")/ensure.sh"
CONTAINER=mas-radar-pg
DB=mas_radar_dev
docker exec "$CONTAINER" dropdb -U postgres --if-exists "$DB"
docker exec "$CONTAINER" createdb -U postgres "$DB"
...
```

`bash scripts/db/dev-reset.sh` — ya da `pnpm db:dev:reset`, ya da geçmişten tab ile tamamlanan
bir satır — **gerçek, veri taşıyan geliştirme veritabanını ve içindeki her şeyi siliyordu.**
Bayrak yok, onay yok, dry-run yok, ölçülen kimlik raporu yok.

Bu, denetimin kendi güvenlik standardıyla çelişiyordu: denetimin geri kalanı fixture
script'lerinin `mas_radar_dev`'e **yanlışlıkla yönlendirilememesini** kanıtlamakla geçti; oysa
depodaki en yıkıcı script `mas_radar_dev`'i **hardcoded** taşıyor ve kimseye bir şey sormuyordu.

### Riski yükselten üç etken

1. `.claude/settings.json:10` bu script'i Bash izin listesinde taşıyor:
   `"Bash(bash scripts/db/dev-reset.sh)"` — yani bir ajan onu **izin istemeden** çalıştırabilirdi.
2. `docs/mvp-runbook.md:33` onu kurulum adımı olarak öneriyor.
3. Adı zararsız görünüyor: "dev reset", "drop the real database" gibi okunmuyor.

## Neden disposable-ad kapısı burada işe yaramaz

`requireDisposableOwnerDatabaseUrl()` hedefi **ortamdan** gelen script'leri korur: adı inceler ve
korunan adları reddeder. Bu script'in hedefi env'den gelmez — `mas_radar_dev`'i yok etmek onun
**işidir**. Bir ad kontrolü ya etkisiz kalır ya da aracı bozar.

Bu yüzden koruma farklı bir şekle sahip: *"bu hedef güvenli mi?"* değil,
**"bir insan bu tam yıkımı bilerek mi istedi?"**

## Uygulanan model

Varsayılan: **hiçbir şey silinmez.** Gerçek reset için birbirinden bağımsız **iki** onay şart:

| # | onay | neden kazara verilemez |
|---|---|---|
| A | argüman `--i-understand-this-destroys-mas-radar-dev` | sonucu cümle olarak yazıyor; kopyalanan bir komut satırı tek başına yetmez |
| B | ortam değişkeni `MAS_ALLOW_DEV_DB_RESET=mas_radar_dev` | hedefi adıyla söyler; unutulmuş bir export tek başına silahlandıramaz |

İkisi birden yoksa **ilk yıkıcı komuttan önce** `exit 9` — hatta `ensure.sh`'tan da önce, yani
tek bir `docker` çağrısı bile yapılmaz.

Onaylar verildiğinde, yıkımdan **önce** ölçülen kimlik raporlanır:

```
== YIKIM ÖNCESİ ÖLÇÜLEN KİMLİK ==
  container      : mas-radar-pg
  current_database: mas_radar_dev
  payment_instances = 511
  cashflow_lines = 1968
  ...
  (yukarıdaki satırların TAMAMI silinecek)
```

`current_database()` sunucudan **ölçülür**; beklenenden farklıysa yine `exit 9`.

Üçüncü katman: TTY varsa operatörün veritabanı adını **elle yazması** istenir. Bu katman
bilinçli olarak taşıyıcı değildir — CI ve ajanların TTY'si yoktur ve onlar zaten A+B ile
korunur.

## Doğrulama — `tests/dev-reset-safety.test.ts` (9 test)

Testler PATH'e **sahte bir `docker`** koyar: her çağrıyı log'lar, 0 döner. `ensure.sh` de yalnız
docker çağırdığı için tamamen etkisizleşir. Böylece **komut dizisi** ölçülür ve hiçbir gerçek
veritabanına dokunulmaz.

Negatif vakalarda aranan şey yalnız çıkış kodu değil — log'da **`dropdb` geçmemesi**. Yanlış
sırayla yazılmış bir kapı doğru kodu döndürüp yine de silmiş olabilirdi.

| senaryo | exit | `dropdb` çağrıldı mı |
|---|---|---|
| çıplak çağrı | **9** | hayır — hiç docker çağrısı yok |
| yalnız bayrak | **9** | hayır |
| yalnız env | **9** | hayır |
| bayrak + `MAS_ALLOW_DEV_DB_RESET=yes` (yanlış değer) | **9** | hayır |
| `--force --yes -f` (benzer bayraklar) | **9** | hayır |
| **bayrak + doğru env** | ≠ 9 | **evet** — kapı geçti |

Pozitif vaka, sahte docker'ı `dropdb`de durduracak biçimde koşar: kapının kararı ("yıkıcı komuta
ulaşıldı") ölçülür, 87 migration dosyası boşuna oynatılmaz. **Gerçek `mas_radar_dev` hiçbir
testte DROP EDİLMEDİ** — bu tur boyunca alınan beş quiescence snapshot'ının hepsi birebir aynı.

Ayrıca iki kaynak-sözleşmesi iddiası: `exit 9` satırı hem ilk `dropdb`den hem `ensure.sh`
çağrısından önce gelmeli.

## DEV_RESET_CALLERS

| çağrı yeri | tür |
|---|---|
| `package.json:19` → `db:dev:reset` | elle |
| `docs/mvp-runbook.md:33` | doküman talimatı, elle |
| `.claude/settings.json:10` | ajan Bash izni (ön-onaylı) |
| `scripts/db/migrate-verify.ts:563` | yalnız yorumda geçiyor, çağrı değil |

**Otomatik lifecycle / CI çağrısı: YOK.** `pre*`/`post*` hook yok, `.github/workflows` içinde
geçmiyor. Yani `DEV_RESET_CALLERS = manuel-only`; ajan izni de artık A+B onayına takılır.

`DEV_RESET_SAFETY = PASS`
