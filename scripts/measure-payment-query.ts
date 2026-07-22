import { performance } from "node:perf_hooks";
import { getPool } from "../src/lib/db";
import { paymentOverviewInstances } from "../src/lib/radar/queries";
import { loadThresholds } from "../src/lib/radar/engine";
import { istanbulDateISO } from "../src/lib/reports/rules";

async function main() {
  const pool = getPool();
  const today = istanbulDateISO();
  const anchor = new Date(`${today}T00:00:00Z`);
  const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 24, anchor.getUTCDate()))
    .toISOString().slice(0, 10);

  for (let run = 1; run <= 6; run += 1) {
    const started = performance.now();
    const [rows] = await Promise.all([paymentOverviewInstances(pool, today, end), loadThresholds(pool)]);
    console.log(`run=${run} rows=${rows.length} ms=${(performance.now() - started).toFixed(1)}`);
  }
  await pool.end();
}

void main();
