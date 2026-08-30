// P24B v2.2 — collectMetricSnapshots execution-path benchmark.
//
// The deterministic proof that the two paths differ lives in tests/pg-concurrency.test.ts, which
// asserts ORDERING rather than timing. This script exists for a narrower question that ordering
// cannot answer: does the Pool path actually still get the parallelism back?
//
// v2.1 made collectMetricSnapshots unconditionally sequential to silence pg's concurrent-query
// deprecation on a PoolClient, which also removed the fan-out on the Pool path the product uses.
// v2.2 routes both through gather(). A benchmark is the only way to show the difference is real
// work and not just a code shape.
//
// This is a measurement, not a gate — a slow machine must never fail a correctness run. Read it
// alongside the ordering test, not instead of it.
//
// Usage: MIGRATION_DATABASE_URL=<disposable> node --import tsx scripts/qa/p24b-snapshot-bench.ts [out.json]
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { ownerDatabaseUrl, isDisposableDatabaseName, databaseNameFromUrl } from "../db/owner-url";
import { collectMetricSnapshots } from "../../src/lib/analytics/snapshots";

const SNAPSHOT_DATE = "2026-08-27";
const ITERATIONS = 7;

interface Timing { label: string; medianMs: number; minMs: number; maxMs: number }

async function bench(label: string, run: () => Promise<unknown>): Promise<Timing> {
  await run(); // warm: first touch measures cache state, not the code
  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    label,
    medianMs: Number(times[Math.floor(ITERATIONS / 2)].toFixed(1)),
    minMs: Number(times[0].toFixed(1)),
    maxMs: Number(times[ITERATIONS - 1].toFixed(1)),
  };
}

async function main(): Promise<void> {
  const url = ownerDatabaseUrl();
  if (!url) { console.error("MIGRATION_DATABASE_URL gerekli"); process.exit(1); }
  const db = databaseNameFromUrl(url);
  // Read-only work, but it runs many queries; keep it off the real database regardless.
  if (!db || !isDisposableDatabaseName(db)) {
    console.error(`GÜVENLİK DURDURMASI: benchmark yalnız harcanabilir bir veritabanında koşar; '${db}' değil.`);
    process.exit(9);
  }

  const pool = new Pool({ connectionString: url, max: 10 });
  const client = await pool.connect();
  try {
    const poolPath = await bench("Pool → gather → Promise.all", () => collectMetricSnapshots(pool, SNAPSHOT_DATE));
    const clientPath = await bench("PoolClient → gather → sequential", () => collectMetricSnapshots(client, SNAPSHOT_DATE));

    // Same inputs, same numbers: the concurrency choice must not change a single metric.
    const viaPool = await collectMetricSnapshots(pool, SNAPSHOT_DATE);
    const viaClient = await collectMetricSnapshots(client, SNAPSHOT_DATE);
    const identical = JSON.stringify(viaPool) === JSON.stringify(viaClient);

    const out = {
      generatedAtUtc: new Date().toISOString(),
      database: db,
      iterations: ITERATIONS,
      poolPath,
      clientPath,
      speedup: Number((clientPath.medianMs / poolPath.medianMs).toFixed(2)),
      resultsIdentical: identical,
      metricCount: (viaPool as unknown[]).length,
      note: "Sıralama kanıtı tests/pg-concurrency.test.ts'te; bu yalnız farkın gerçek iş olduğunu gösterir.",
    };
    console.log(`  Pool       medyan ${poolPath.medianMs} ms  (min ${poolPath.minMs} / max ${poolPath.maxMs})`);
    console.log(`  PoolClient medyan ${clientPath.medianMs} ms  (min ${clientPath.minMs} / max ${clientPath.maxMs})`);
    console.log(`  hızlanma ${out.speedup}× · sonuçlar birebir aynı: ${identical} · ${out.metricCount} metrik`);
    if (process.argv[2]) { writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n", "utf8"); console.log(`artifact: ${process.argv[2]}`); }
    if (!identical) process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
