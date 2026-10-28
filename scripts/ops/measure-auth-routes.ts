import fs from "fs";
import { Pool } from "pg";
import { createHash, randomBytes } from "node:crypto";

async function main() {
  const env = fs.readFileSync(".env.local", "utf8");
  const match = env.match(/MIGRATION_DATABASE_URL=([^\r\n]+)/);
  if (!match) throw new Error("MIGRATION_DATABASE_URL not found");
  const pool = new Pool({ connectionString: match[1].trim() });

  let cookieHeader = "";
  try {
    const userRes = await pool.query("SELECT id FROM public.users WHERE username = 'admin'");
    if (userRes.rowCount === 0) throw new Error("admin user not found");
    const adminId = userRes.rows[0].id;

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    await pool.query(
      `INSERT INTO public.sessions (user_id, token_hash, expires_at, last_seen_at)
       VALUES ($1, $2, $3, now())`,
      [adminId, tokenHash, expiresAt]
    );

    cookieHeader = `mas_session=${token}`;
    console.log("Admin session token minted successfully via owner connection.");
  } finally {
    await pool.end();
  }

  const routes = [
    "/overview",
    "/cashflow",
    "/radar",
    "/payments",
    "/production",
    "/production/capacity",
    "/scenarios",
    "/data",
    "/data/quality",
    "/insights",
    "/insights/ask",
    "/finance",
    "/finance/loans",
    "/finance/facilities",
    "/finance/fx",
    "/finance/cockpit",
    "/system"
  ];

  console.log("\n=== AUTHENTICATED BENCHMARK (Target: < 300ms) ===");
  const results: Array<{ route: string; status: number; durationMs: number; ok: boolean }> = [];

  for (const route of routes) {
    const start = performance.now();
    try {
      const res = await fetch("http://localhost:3000" + route, {
        headers: {
          Cookie: cookieHeader,
          "User-Agent": "MAS-Benchmark/1.0"
        }
      });
      const durationMs = Math.round(performance.now() - start);
      const ok = durationMs < 300;
      console.log(
        `${route.padEnd(25)} -> Status: ${res.status} | TTFB: ${durationMs}ms | ${ok ? "PASS (<300ms) ✅" : "FAIL (>=300ms) ⚠️"}`
      );
      results.push({ route, status: res.status, durationMs, ok });
    } catch (err: any) {
      console.log(`${route.padEnd(25)} -> ERROR: ${err.message}`);
    }
  }

  const passed = results.filter(r => r.ok).length;
  console.log(`\n=========================================`);
  console.log(`BENCHMARK SUMMARY: ${passed}/${results.length} routes under 300ms.`);
  console.log(`=========================================`);
}

main().catch(console.error);
