/**
 * Background Import Job Processor CLI (Faz 3)
 *
 * Scans `public.background_jobs` for pending `excel_import` tasks,
 * claims them using `for update skip locked`, and executes them.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  const [
    { getPool },
    { claimNextJob },
    { processAsyncWorkbookImportJob },
  ] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/jobs/queue"),
    import("../../src/lib/importers/v2/async-runner"),
  ]);

  const pool = getPool();
  console.log("=== Arka Plan Excel İçe Aktarma İşçisi Başlatıldı ===");

  let processedCount = 0;

  while (true) {
    const job = await claimNextJob(pool, ["excel_import"], "system-worker");
    if (!job) {
      if (processedCount === 0) {
        console.log("Kuyrukta bekleyen 'excel_import' işi yok.");
      }
      break;
    }

    console.log(`\nİş devralındı: ID=${job.id}, Tür=${job.jobType}, Öncelik=${job.priority}`);
    const outcome = await processAsyncWorkbookImportJob(pool, job.id, "system-worker");

    if (outcome.success) {
      console.log(`BAŞARILI: İş tamamlandı (${job.id}).`);
      if (outcome.outcome?.result) {
        const res = outcome.outcome.result;
        console.log(`  Oluşturulan Workbook ID: ${outcome.outcome.workbookId}`);
        console.log(`  Sahnelenen Satır: ${res.rowsStaged}, Yazılan Satır: ${res.rowsMapped}, İnceleme Açılan: ${res.reviewsOpened}`);
      }
    } else {
      console.error(`BAŞARISIZ: İş hata verdi (${job.id}): ${outcome.error}`);
    }
    processedCount++;
  }

  console.log(`\nToplam işlenen iş sayısı: ${processedCount}`);
  await pool.end();
}

main().catch((err) => {
  console.error("Worker hatası:", err);
  process.exit(1);
});
