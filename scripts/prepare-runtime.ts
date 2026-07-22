import { getPool } from "../src/lib/db";
import { ensureWindow } from "../src/lib/radar/engine";
import { istanbulDateISO } from "../src/lib/reports/rules";

async function main() {
  const pool = getPool();
  try {
    await ensureWindow(pool, istanbulDateISO(), 24);
    console.log("Ödeme penceresi 24 aylık ufukla hazır.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Çalışma zamanı hazırlığı başarısız:", error);
  process.exit(1);
});
