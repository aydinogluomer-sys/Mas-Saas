/**
 * Standart Import V2 — asenkron ÖNİZLEME işçisi (Wave 0 / R8).
 *
 * `POST /api/imports/v2/async` ile kuyruğa alınmış `excel_import` işlerini alır, her biri için
 * önizlemeyi (dry-run) koşturur ve raporu iş satırına yazar. HİÇBİR finansal kaydı yazmaz: onay,
 * dosyanın yeniden yüklendiği ve önizleme SHA'sının eşleşmek zorunda olduğu senkron akışta kalır
 * (bkz. src/lib/importers/v2/async-runner.ts başlığı).
 *
 * İki kimlik, iki ayrı iş:
 *   · Kuyruk işlemleri (claim / complete / fail) işçinin kendisidir: runAsSystem katmanı, denetim
 *     aktörü rezerve 'system' hesabı (scripts/db/seed-system-actor.ts getSystemActorId — hesap
 *     yoksa işçi hiçbir şeye dokunmadan durur). İncelenmemiş katman burada uuid olmayan sabit
 *     bir aktör metni yazıyordu; `audit_logs.actor` bir users(id) yabancı anahtarı olduğu için
 *     ilk claim'in işlemi geri alınıyor ve hiçbir iş işlenemiyordu. Bağlamsız getPool() da
 *     katmansız (mas_radar_app) kalıyor, `background_jobs`'a hiç erişemiyordu.
 *   · Önizlemenin kendisi işi kuyruğa alan kullanıcının katmanında koşar (runAsUser; kimlik
 *     public.users'tan yeniden okunur, yükten değil).
 *
 * Bir koşu en çok MAX_JOBS_PER_RUN iş işler, sonra sahipsiz sahneleme dosyalarını süpürür.
 * Zamanlanmış bir görev bu betiği henüz çalıştırmıyor (açık iş; docs/todo.md Wave 0 / S5).
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const MAX_JOBS_PER_RUN = 25;

async function main(): Promise<void> {
  // Dinamik import: env doğrulayan modüller .env.local yüklendikten SONRA değerlendirilsin
  // (scripts/prepare-runtime.ts ile aynı gerekçe).
  const [db, { claimNextJob }, runner, { getSystemActorId }] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/jobs/queue"),
    import("../../src/lib/importers/v2/async-runner"),
    import("../db/seed-system-actor"),
  ]);

  const pool = db.getPool();
  try {
    // users tablosu katmana geçmiş bağlantıdan okunamaz (0058); oturum aramasıyla aynı yol.
    const systemActorId = await getSystemActorId(db.getRawPool());
    const deps = { pool, identityPool: db.getRawPool(), systemActorId };

    await db.runAsSystem(async () => {
      console.log("=== Standart Import V2 — asenkron önizleme işçisi ===");
      let processed = 0;
      while (processed < MAX_JOBS_PER_RUN) {
        const job = await claimNextJob(pool, [runner.ASYNC_PREVIEW_JOB_TYPE], systemActorId);
        if (!job) break;
        processed++;
        const r = await runner.processAsyncWorkbookPreviewJob(deps, job.id);
        // Yalnız sayaçlar ve durum yazılır; tutar, karşı taraf ya da dosya içeriği konsola düşmez.
        if (r.outcome === "succeeded" && r.counters) {
          const c = r.counters;
          console.log(
            `ÖNİZLENDİ  ${job.id}  yaratılacak=${c.create} güncellenecek=${c.update} ` +
              `inceleme=${c.review} red=${c.reject} belirlenemedi=${c.undetermined}`,
          );
        } else {
          console.log(`${r.outcome.toUpperCase()}  ${job.id}  ${r.error ?? ""}`);
        }
      }
      if (processed === 0) console.log("Kuyrukta bekleyen önizleme işi yok.");
      if (processed === MAX_JOBS_PER_RUN) console.log(`Koşu sınırı (${MAX_JOBS_PER_RUN}) doldu; kalanlar sonraki koşuda.`);

      const swept = await runner.sweepStaleStagedFiles(pool);
      console.log(`Sahneleme süpürmesi: ${swept.removed} sahipsiz dosya silindi, ${swept.kept} dosya korundu.`);
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Önizleme işçisi hatası:", err instanceof Error ? err.message : err);
  process.exit(1);
});
