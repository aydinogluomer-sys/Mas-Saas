// Sentetik TestSprite veritabanı hazırlayıcı — gerçek `mas_radar_dev` veritabanına ASLA dokunmaz.
// Sıfırdan harcanabilir `mas_radar_testsprite` veritabanı kurar, migration + seed + sanitize uygular.
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assertLocalPgReachable,
  createDisposableLocalDb,
  dropDisposableLocalDb,
  psqlLocalFile,
  psqlLocalSql,
  resolveLocalOwnerUrl,
} from "./pg-local-admin";

const targetDb = "mas_radar_testsprite";
const root = process.cwd();
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

assertLocalPgReachable();
console.log("Creating isolated synthetic TestSprite database (zero real data copied)…");
dropDisposableLocalDb(targetDb);
createDisposableLocalDb(targetDb);
psqlLocalFile(targetDb, "scripts/db/local-bootstrap.sql");

const targetOwnerUrl = resolveLocalOwnerUrl(targetDb);
execFileSync(process.execPath, [tsxCli, path.join(root, "scripts", "db", "migrate.ts")], {
  cwd: root,
  env: {
    ...process.env,
    MIGRATION_DATABASE_URL: targetOwnerUrl,
    DATABASE_URL: targetOwnerUrl,
  },
  stdio: "inherit",
});

psqlLocalFile(targetDb, "supabase/seed.sql");
execFileSync(process.execPath, [tsxCli, path.join(root, "scripts", "seed-demo.ts")], {
  cwd: root,
  env: {
    ...process.env,
    MIGRATION_DATABASE_URL: targetOwnerUrl,
    DATABASE_URL: targetOwnerUrl,
  },
  stdio: "inherit",
});
psqlLocalFile(targetDb, "scripts/db/sanitize-testsprite.sql");

const proof = psqlLocalSql(
  targetDb,
  `select 'payments='||count(*) from payments
   union all select 'cash_months='||count(*) from cashflow_months
   union all select 'checks='||count(*) from checks
   union all select 'loans='||count(*) from loans
   union all select 'parts='||count(*) from production_parts
   union all select 'private_markers='||(
     (select count(*) from source_cells where coalesce(raw_value,'') !~ '^(SYNTHETIC|100)$') +
     (select count(*) from audit_logs where before_data::text !~ 'synthetic' or after_data::text !~ 'synthetic')
   );`,
);
console.log(proof.trim());
console.log("Synthetic TestSprite database ready.");
