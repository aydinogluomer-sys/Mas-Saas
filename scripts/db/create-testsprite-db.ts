import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const container = "mas-radar-pg";
const sourceDb = "mas_radar_dev";
const targetDb = "mas_radar_testsprite";

function docker(args: string[], options: { input?: string; quiet?: boolean } = {}) {
  return execFileSync("docker", args, {
    input: options.input,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: options.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "inherit"],
  });
}

console.log("Creating isolated synthetic TestSprite database…");
docker(["exec", container, "dropdb", "-U", "postgres", "--if-exists", targetDb]);
docker(["exec", container, "createdb", "-U", "postgres", targetDb]);
docker([
  "exec", container, "sh", "-c",
  `pg_dump -U postgres -d ${sourceDb} --no-owner --no-acl | psql -q -v ON_ERROR_STOP=1 -U postgres -d ${targetDb}`,
]);
docker(
  ["exec", "-i", container, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", targetDb],
  { input: readFileSync("scripts/db/sanitize-testsprite.sql", "utf8") },
);

const proof = docker([
  "exec", container, "psql", "-U", "postgres", "-d", targetDb, "-At", "-c",
  `select 'payments='||count(*) from payments
   union all select 'cash_months='||count(*) from cashflow_months
   union all select 'checks='||count(*) from checks
   union all select 'loans='||count(*) from loans
   union all select 'parts='||count(*) from production_parts
   union all select 'private_markers='||(
     (select count(*) from source_cells where coalesce(raw_value,'') !~ '^(SYNTHETIC|100)$') +
     (select count(*) from audit_logs where before_data::text !~ 'synthetic' or after_data::text !~ 'synthetic')
   );`,
], { quiet: true });
console.log(proof.trim());
console.log("Synthetic TestSprite database ready.");

