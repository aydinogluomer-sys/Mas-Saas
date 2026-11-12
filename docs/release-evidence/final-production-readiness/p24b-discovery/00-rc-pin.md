# RC PIN — normalizasyon oncesi (P24B kesfi)

Bu pin normalize karsilastirma BASLAMADAN once alindi. "ayni final RC" sozlu bir ifade
degil, asagidaki olculmus degerlerdir.

```text
PINNED_AT              : 2026-08-26T11:49:26Z
BRANCH                 : release/production-readiness-hardening
RC_SHA                 : 640f8536cf7a184d018b02bd301060dcca07c7e6
MIGRATION_COUNT        : 87
MIGRATION_LATEST       : 0087_assistant_conversations.sql
MIGRATION_SET_SHA      : 5f66696a1c66094e989dfd49541819f6162d6aee161edf0c09defa27bb045bca
MIGRATIONS_VS_MASTER   : 0 dosya
CUTOVER_A_SHA256       : f121cd49545f6b060d6bb1bce689ebcac023aa076981dfbd0ac102b80467330d

SOURCE_WORKTREE_CHANGES   : 0
EVIDENCE_WORKTREE_CHANGES : 1
SOURCE TREE   = CLEAN
EVIDENCE TREE = DIRTY AS EXPECTED (kanit dosyalari uretiliyor)

CLUSTER_ROLE_PREREQ:
  anon          = PRESENT
  authenticated = PRESENT
  service_role  = PRESENT
  COUNT         = 3/3   (salt okunur pg_roles sorgusu; workflow rol YARATMAYACAK)

CURRENT_HEAD_CI        : NOT VERIFIED / NOT YET EVIDENCED
REAL_DB_READONLY_ENFORCEMENT : PASS (negatif kontrol harcanabilir klonda:
  'cannot execute UPDATE in a read-only transaction'; SELECT calisiyor)
  (yerel typecheck PASS var; bu commit icin GitHub combined status kaniti YOK.
   'CLEAN CI = VERIFIED PASS' YAZILAMAZ.)
```

## Kapsam ayrimi

`SOURCE_WORKTREE_CHANGES` hesabindan su klasor HARIC tutuldu ve bu gizlenmedi:

```text
docs/release-evidence/final-production-readiness/p24b-discovery/
```

Gerekce: kesif ajanlari kendi kanit dosyalarini bu klasore yazar; bu, kaynak kodun
kirli olmasiyla ayni sey degildir. Kaynak kodda commit'lenmemis degisiklik olsaydi
SOURCE TREE = DIRTY olur ve RC PIN GECERSIZ sayilirdi.

## Golden restore yolu (olculdu, varsayilmadi)

`scripts/db/migrate.ts:135` `checkAuthPrereqs()` cagirir ve `anon`/`authenticated`/
`service_role` rolleri + `auth.users` + `auth.uid()` arar. `pg_restore` kume seviyesindeki
rolleri OLUSTURMAZ — restore -> migrate zinciri DOGRUDAN calismaz.

```text
restore -> cluster-role 3/3 precheck -> local-bootstrap.sql (YALNIZ probe DB) -> pnpm db:migrate
SEED YOK · FIXTURE YOK · VERIFY SCRIPT YOK
```

Roller zaten 3/3 mevcut oldugu icin `local-bootstrap.sql` bu kosuda yeni CLUSTER rolu
yaratmayacak; yalniz probe DB icinde `auth` semasini kuracak.
