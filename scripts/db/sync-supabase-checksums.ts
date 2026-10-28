import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { Pool } from "pg";
import { validateFileSet, checksumContent } from "./migration-lib";

async function main() {
  const connectionString =
    process.env.SUPABASE_DB_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not defined");
  }

  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    console.log("Checking public.schema_migrations structure...");
    await client.query("ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum text;");

    const { files } = validateFileSet();
    console.log(`Found ${files.length} migration files on disk.`);

    let updated = 0;
    for (const f of files) {
      const hash = checksumContent(f.content);
      const res = await client.query(
        "UPDATE public.schema_migrations SET checksum = $1, name = $2 WHERE version = $3",
        [hash, f.name, f.version],
      );
      if (res.rowCount && res.rowCount > 0) {
        updated++;
      }
    }
    console.log(`Updated checksum for ${updated}/${files.length} migrations in public.schema_migrations.`);

    // Verify
    const checkRes = await client.query(
      "SELECT count(*)::int as count FROM public.schema_migrations WHERE checksum IS NOT NULL",
    );
    console.log(`Migrations with non-null checksum: ${checkRes.rows[0].count}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
