# 11 — P0 düzeltmesi: cutover runbook sözleşmesi

## Çelişki

`9844dd3`, `db:roles-rls:verify`'a makine-zorlamalı disposable kapısı ekledi. Ama
`docs/real-db-cutover-runbook.md` Bölüm I hâlâ şunu söylüyordu:

```bash
DATABASE_URL="<mas_radar_app bağlantısı>" \
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" pnpm db:roles-rls:verify
```

Cutover bağlamında bu değişkenler **gerçek veritabanını** gösterir. Dolayısıyla runbook,
fixture yazıcısını gerçek DB'ye yönlendiriyordu — ve `07-invocation-path.md`'de gösterildiği gibi
iki olay tam olarak bu talimat izlendiği için gerçekleşti.

Kapı eklendikten sonra çelişki yön değiştirdi ama kaybolmadı: komut artık `exit 1` verir.
**Çalıştırılamayan bir runbook adımı bırakmak, operatörü kapıyı aşmanın yolunu aramaya iter** —
en tehlikeli sonuç budur.

## Düzeltme

Bölüm I ikiye ayrıldı:

| hedef | ne çalışır | neden güvenli |
|---|---|---|
| **Gerçek DB** | `db:roles:verify` + Bölüm J salt-okunur RLS sondaları | `db:roles:verify`'ın tek INSERT probu `begin`/`rollback` içinde (`rollback` bir `finally` bloğunda); Bölüm J'nin tamamı transaction içinde geri alınır |
| **Disposable klon** | `db:roles-rls:verify`, tam fixture matrisiyle | ad `verify` işaretini taşır, kapı geçer; klon bu release candidate'tan üretilir |

Yeni komut bloğu:

```bash
CLONE_URL="postgres://…@127.0.0.1:5432/mas_radar_cutover_clone_verify"
DATABASE_URL="$CLONE_URL" MIGRATION_DATABASE_URL="$CLONE_URL" pnpm db:roles-rls:verify
```

Bölüm I'ye ayrıca, olayları ve amplifikasyonu ölçülen zaman damgalarıyla anlatan bir uyarı
bloğu eklendi; gelecekte biri komutu "kolaylık olsun diye" geri koymak istediğinde neyin
olduğunu okuyabilsin.

## Kapsam taraması

Aynı komutun başka bir yerde çalıştırılabilir talimat olarak kalmadığı doğrulandı:

```
docs/*.md içinde çalıştırılabilir "pnpm db:roles-rls:verify" satırı: 1
  -> docs/real-db-cutover-runbook.md:371  (disposable klon hedefli, düzeltilmiş satır)
```

`docs/database-schema.md` ve `docs/status-notes.md`'deki geçişler komut değil, gate'in ne
ölçtüğünü anlatan **betimleyici** metinlerdir; hedef belirtmezler ve değiştirilmemiştir.

## Sonuç

`CUTOVER_RUNBOOK_CONTRACT = FIXED`. Runbook ile kod yeniden aynı sözleşmeyi anlatıyor:
gerçek veritabanında fixture yazan hiçbir gate çalıştırılmaz.
