import { Client } from "pg";
import { createHash } from "node:crypto";

const routes = [
  "/overview",
  "/cashflow",
  "/payments/calendar",
  "/payments",
  "/production",
  "/production/capacity",
  "/production/costs",
  "/scenarios",
  "/scenarios/compare",
  "/scenarios/history",
  "/data",
  "/data/quality",
  "/insights",
  "/finance",
  "/finance/loans",
  "/finance/facilities",
  "/finance/fx",
  "/system"
];

async function ensureBenchmarkToken(): Promise<string> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const rawToken = "benchmark_secret_token_12345";
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  try {
    await client.query("set role mas_radar_admin");
    const adminRes = await client.query("select id from public.users where username = 'admin' limit 1");
    const userId = adminRes.rows[0]?.id;
    if (!userId) throw new Error("admin user not found");
    await client.query(
      `insert into public.sessions (id, user_id, token_hash, last_seen_at, expires_at)
       values ('fcc1f775-b875-4087-ba77-aa295d993ef1', $1, $2, now(), now() + interval '30 days')
       on conflict (id) do update set
         user_id = excluded.user_id,
         token_hash = excluded.token_hash,
         last_seen_at = now(),
         revoked_at = null,
         expires_at = now() + interval '30 days'`,
      [userId, tokenHash]
    );
    return rawToken;
  } finally {
    await client.end();
  }
}

async function measure() {
  const token = await ensureBenchmarkToken();
  const headers = {
    "User-Agent": "MAS-Benchmark/1.0",
    "Cookie": `mas_session=${token}`
  };

  console.log("=== WARMING UP ALL AUTHENTICATED ROUTES (1st pass) ===");
  for (const r of routes) {
    try {
      const res = await fetch("http://localhost:3000" + r, { headers, redirect: "manual" });
      console.log(`Warmup ${r.padEnd(25)} -> Status: ${res.status}`);
    } catch (e: any) {
      console.log(`Warmup error ${r}: ${e.message}`);
    }
  }

  console.log("\n=== BENCHMARKING WARM AUTHENTICATED ROUTES (Target: < 300ms) ===");
  const results: Array<{ route: string; status: number; durationMs: number; okUnder300: boolean }> = [];

  for (const route of routes) {
    const start = performance.now();
    try {
      const res = await fetch("http://localhost:3000" + route, { headers, redirect: "manual" });
      const durationMs = Math.round(performance.now() - start);
      const is200 = res.status === 200;
      const okUnder300 = is200 && durationMs < 300;
      const statusIcon = okUnder300 ? "PASS (<300ms) ✅" : (is200 ? "SLOW (>=300ms) ⚠️" : `REDIRECT/FAIL (${res.status}) ❌`);
      console.log(
        `${route.padEnd(25)} -> Status: ${res.status} | Time: ${durationMs}ms | ${statusIcon}`
      );
      results.push({ route, status: res.status, durationMs, okUnder300 });
    } catch (e: any) {
      console.log(`${route.padEnd(25)} -> ERROR: ${e.message}`);
    }
  }

  const passed = results.filter(r => r.okUnder300).length;
  console.log(`\n=========================================`);
  console.log(`AUTHENTICATED BENCHMARK SUMMARY: ${passed}/${results.length} routes under 300ms.`);
  console.log(`=========================================`);
}

measure().catch(console.error);
