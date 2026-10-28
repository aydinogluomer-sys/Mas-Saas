# 07 — `db:roles-rls:verify` invocation path

**Soru.** Script'in fixture yazdığı biliniyordu. Kanıtlanmamış olan şuydu: **onu kim, hangi yolla
çalıştırdı?** "Script bu satırları üretiyor, demek ki o koştu" bir korelasyondur, provenance değil.

**Sonuç: `ROLES_RLS_INVOCATION_PATH = VERIFIED`** — üç bağımsız kanıt hattıyla.

## Hat 1 — Otomatik çağrı YOK (eleme)

| aranan | sonuç |
|---|---|
| npm lifecycle hook (`pre*`/`post*`) | **0** (105 package script içinde) |
| Windows Task Scheduler eşleşmesi | **0** |
| watcher / cron / scheduler | **0** |
| `predev` / `prestart` / `pretest` | **yok** |

Yani hiçbir otomatik mekanizma bu script'i çağırmıyor. Geriye elle çalıştırma ve CI kalıyor.

## Hat 2 — CI güvenli (eleme)

`.github/workflows/ci.yml:220`:

```yaml
- name: RLS behaviour per role
  env:
    DATABASE_URL: ${{ env.APP_URL }}
    MIGRATION_DATABASE_URL: ${{ env.OWNER_URL }}
  run: pnpm db:roles-rls:verify
```

Hedef, aynı job'ın `scripts/ci/provision-verify-db.sh mas_radar_roles_verify` adımıyla kurulan
`mas_radar_roles_verify` veritabanıdır. Ad `verify` işaretini taşır, kapıdan geçer, gerçek DB
değildir. **CI bu olayların kaynağı değil.**

## Hat 3 — Elle çalıştırma (pozitif kanıt)

PSReadLine geçmişi (`ConsoleHost_history.txt`), 908 satır. İlgili blok — **bağlantı dizeleri
maskelenmiştir**:

```
582  $env:DATABASE_URL           = "postgres://***@127.0.0.1:5432/mas_radar_dev"
583  pnpm build
584  pnpm start
585  curl.exe http://127.0.0.1:3000/ready
586  pnpm db:roles:verify
587  pnpm db:roles-rls:verify                       <-- gerçek DB hedefli koşu
588  pnpm db:export-leakage:verify
589  pnpm db:security-matrix:verify
590  $env:DATABASE_URL           = "postgres://***@127.0.0.1:5432/mas_radar_dev"
591  $env:MIGRATION_DATABASE_URL = "postgres://***@127.0.0.1:5432/mas_radar_dev"
592  pnpm db:roles:verify
593  pnpm db:roles-rls:verify                       <-- gerçek DB hedefli koşu
594  pnpm db:security-matrix:verify
595  $env:DATABASE_URL           = "postgres://***@127.0.0.1:5432/mas_radar_dev"
596  $env:MIGRATION_DATABASE_URL = "postgres://***@127.0.0.1:5432/mas_radar_dev"
597  pnpm db:roles:verify
598  pnpm db:roles-rls:verify                       <-- gerçek DB hedefli koşu
599  pnpm db:security-matrix:verify
600  npx tsx scripts/db/seed-admin.ts --username atilla --display-name "..." --role admin
606  npm run dev                                    <-- amplifikatör (bkz. 08)
614  Get-Content .env.local | ForEach-Object { Set-Item -Path "Env:$($Matches[1])" ... }
620  pnpm db:env:source
621  pnpm db:roles:verify
622  pnpm db:roles-rls:verify                       <-- .env.local'dan yüklenen env ile
```

Satır 590-591 ve 595-596 belirleyicidir: **her iki URL de açıkça `mas_radar_dev`'e** —
yani gerçek veritabanına — atanmış, hemen ardından fixture yazıcısı çalıştırılmıştır.
Satır 614-618 aynı değişkenleri `.env.local`'dan yükler; `.env.local` da her iki URL'yi
`mas_radar_dev`'e işaret ettirir.

## Fixture çıktısıyla korelasyon

`roles-rls-verify.ts` sabit adlı satırları `where not exists` ile idempotent yazar; yalnız
rastgele son ekli kullanıcı çiftleri (`p24b_mk_*` / `p24b_op_*`) her koşuda birikir. Ölçülen:

| olay | zaman (UTC) | üretilen satırlar |
|---|---|---|
| **I1** | `2026-08-25 10:09:08.377` | `payments` "P24B fixture" |
| | `2026-08-25 10:09:08.427/.438` | `users` `p24b_fixture_a`, `p24b_fixture_b` (sabit ad) |
| | `2026-08-25 10:10:38.789/.837` | `users` `p24b_mk_mujyy6`, `p24b_op_9bcmx5` (rastgele) |
| | `2026-08-25 10:10:38.837` | `action_items` "P24B mine" (created_by set), "P24B theirs" (created_by NULL) |
| **I2** | `2026-08-26 15:16:19.226/.285` | `users` `p24b_mk_rqn3yj`, `p24b_op_ds1xmv` (rastgele) |
| | `2026-08-26 15:16:19.285` | `action_items` "P24B mine", "P24B theirs" |

İki rastgele çift = RLS bölümüne ulaşan **iki** koşu; sabit adlı satırların tek kopya olması
idempotent `where not exists` ile tutarlıdır. `settings.p24b_fixture_setting` tabloda
`created_at` kolonu bulunmadığı için zamana bağlanamaz.

## Runbook bağlantısı — neden elle ve neden iki kez

`docs/real-db-cutover-runbook.md` Bölüm I, düzeltilmeden önce şu komutu **cutover hedefine karşı**
veriyordu:

```bash
DATABASE_URL="<mas_radar_app bağlantısı>" \
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" pnpm db:roles-rls:verify
```

Cutover bağlamında bu değişkenler gerçek veritabanını gösterir. Yani operatör keyfî davranmadı;
**yazılı prosedürü uyguladı** ve prosedür yanlıştı. Aynı talimat iki kez izlendiği için kaza iki
kez tekrarlandı. Düzeltme: `11-runbook-contract-fix.md`.
