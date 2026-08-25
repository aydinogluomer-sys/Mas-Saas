# Restore drill — 2026-08-25

## Faz 6 PASS kapıları

```text
BACKUP EXISTS = YES
BACKUP READABLE = YES
BACKUP RESTORABLE = YES
RESTORED DATA MATCHES = YES
APP CAN START ON RESTORE = YES
```

## Backup receipt (§9.1)

```yaml
backup_receipt:
  timestamp: "2026-08-25T19:54:19.027Z"
  source_db: "mas_radar_dev"
  system_identifier: "7659286466006216743"
  git_sha: "5883b5e047108049896a5f91eb314cb3107fee51"
  schema_ledger: "87/0087"
  file_size: 1393293
  sha256: "18640d693cb7f27e850a2163d69ef5caf33f1998c769191baf9008cd7fd96457"
  pg_version: "PostgreSQL 16.14"
  pg_dump_version: "pg_dump (PostgreSQL) 16.14 (Debian 16.14-1.pgdg13+1)"
```

## Restore receipt (§9.2)

```yaml
restore_receipt:
  timestamp: "2026-08-25T19:54:45.890Z"
  restored_into: "mas_radar_stage11_restore_drill"
  from_backup_sha256: "18640d693cb7f27e850a2163d69ef5caf33f1998c769191baf9008cd7fd96457"
  tables: 85
  schema_ledger: "87/0087"
  counts_match: true
  aggregates_match: true
  hashes_match: true
  owner_read_rows: 20
```

## Kontroller

| Kontrol | Sonuç | Ayrıntı |
|---|---|---|
| BACKUP EXISTS — dosya var, boyutu ve sha256'sı ölçüldü | PASS | 1393293 bayt · sha256 18640d693cb7f27e… |
| BACKUP READABLE — pg_restore arşivi ayrıştırabiliyor | PASS | 1387 TOC girdisi |
| BACKUP RESTORABLE — arşiv boş bir veritabanına yüklendi | PASS | 85 tablo |
| satır sayıları eşleşiyor | PASS | 85 tablo |
| parasal toplamlar eşleşiyor | PASS | 6 toplam |
| satır hash'leri eşleşiyor | PASS | 85 tablo |
| owner ile login gerekmeyen okuma testi | PASS | payments=20 (kaynak 20) |
| uygulama restore edilen veritabanıyla ayağa kalktı | PASS | http://127.0.0.1:3290/ready = 200 |
| kritik smoke restore edilen veri üzerinde geçiyor | PASS | tests/visual/golden-ui-smoke.spec.ts geçti |

## Çalışma zamanı kimliği ve derleme yalıtımı (AŞAMA 11)

- Runtime kimliği: .env.local runtime kimliği (parola SIFIRLANMADI) — `pnpm db:app-role:password` **çağrılmadı**, küme genelindeki
  `mas_radar_app` parolası değişmedi, canlı örnek etkilenmedi.
- Derleme dizini: `.next-restore-drill` — canlı `.next` ezilmedi.

---

Yeniden üretim:

```bash
SOURCE_DATABASE_URL=postgres://…/mas_radar_dev \
RESTORE_DB=mas_radar_stage11_restore_drill \
  pnpm release:restore-drill
```

Kaynağa yalnız `pg_dump` dokunur; hedef her koşuda düşürülüp yeniden yaratılır.
