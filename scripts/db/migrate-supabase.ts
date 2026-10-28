import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { Pool } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

async function main() {
  const connectionString =
    process.env.SUPABASE_DB_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL;

  if (!connectionString) {
    console.error("HATA: SUPABASE_DB_URL veya DATABASE_URL tanımlı değil!");
    console.error("Lütfen .env.local dosyasına Supabase bağlantı dizginizi ekleyin:");
    console.error("Örnek: SUPABASE_DB_URL=postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
      ? false
      : { rejectUnauthorized: false },
    max: 1,
  });

  const client = await pool.connect();
  try {
    const identRes = await client.query<{ current_database: string; current_user: string }>(
      "select current_database(), current_user",
    );
    console.log(`\n✅ Supabase veritabanına bağlanıldı: db=${identRes.rows[0].current_database} user=${identRes.rows[0].current_user}`);

    // schema_migrations tablosunu garantiye al
    await client.query(`
      create table if not exists public.schema_migrations (
        version text primary key,
        name text not null,
        applied_at timestamptz not null default now(),
        applied_by text not null default 'supabase-runner'
      );
    `);

    // Mevcut kayıtlı versiyonları al
    const existingRes = await client.query<{ version: string }>(
      "select version from public.schema_migrations",
    );
    const appliedVersions = new Set(existingRes.rows.map((r) => r.version));

    // migration dosyalarını oku ve sırala
    const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const pending = files.filter((f) => {
      const version = f.slice(0, 4);
      return !appliedVersions.has(version);
    });

    console.log(`Toplam dosya: ${files.length} | Zaten uygulanan: ${appliedVersions.size} | Bekleyen: ${pending.length}\n`);

    if (pending.length === 0) {
      console.log("🎉 Tüm SQL migration'ları zaten Supabase üzerinde eksiksiz uygulanmış durumda!");
      return;
    }

    let count = 0;
    for (const file of pending) {
      count++;
      const version = file.slice(0, 4);
      const filePath = path.join(migrationsDir, file);
      const sql = readFileSync(filePath, "utf8");

      process.stdout.write(`[${count}/${pending.length}] Uygulanıyor: ${file} ... `);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "insert into public.schema_migrations(version, name, applied_by) values ($1, $2, $3)",
          [version, file, "supabase-runner"],
        );
        await client.query("COMMIT");
        console.log("TAMAMLANDI ✅");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.log("HATA ❌");
        console.error(`\n🚨 '${file}' dosyasında hata oluştu:\n`, err instanceof Error ? err.message : err);
        process.exit(1);
      }
    }

    console.log("\n🎉 TEBRİKLER! Tüm 95 migration dosyası Supabase'e başarıyla uygulandı!");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Beklenmeyen hata:", err);
  process.exit(1);
});
