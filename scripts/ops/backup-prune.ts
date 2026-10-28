// AŞAMA 07 Bölüm D — retention budaması. Politikanın KODU.
//
// NEDEN VAR. `docs/backup-restore-policy.md` üç saklama sınıfı tanımlıyordu; hiçbir kod onu
// uygulamıyordu. Ölçüm: `backups/` içinde 857 dump, 973 MB — hepsi elle silinene kadar duruyor.
// Yazılı bir retention politikası, onu uygulayan bir şey yoksa yalnız bir niyettir.
//
// VARSAYILAN KURU KOŞUDUR. Silme geri alınamaz; bu yüzden `--apply` verilmedikçe hiçbir dosya
// silinmez. `--apply` bile IMMUTABLE sınıfına dokunamaz (pre/post-cutover yedekleri, stage
// kanıt yedekleri, `<dump>.immutable` işaret dosyası taşıyanlar) — o kontrol hem planda hem
// silme anında ikinci kez yapılır.
//
// Kullanım:
//   pnpm exec tsx scripts/ops/backup-prune.ts                 # kuru koşu (varsayılan)
//   pnpm exec tsx scripts/ops/backup-prune.ts --apply         # gerçekten sil
//   pnpm exec tsx scripts/ops/backup-prune.ts --dir E:\yedek --daily 7 --weekly 4 --monthly 3
//   pnpm exec tsx scripts/ops/backup-prune.ts --verbose       # her dosyanın kararını yaz
import { pathToFileURL } from "node:url";
import {
  DEFAULT_RETENTION, executePrune, formatBytes, listDumps, planPrune, type RetentionPolicy,
} from "./backup-lib";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function num(flag: string, fallback: number): number {
  const v = arg(flag);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} geçersiz: ${v}`);
  return n;
}

export function main(): void {
  const dir = arg("--dir") ?? process.env.MAS_BACKUP_DIR ?? "backups";
  const apply = process.argv.includes("--apply");
  const verbose = process.argv.includes("--verbose");
  const policy: RetentionPolicy = {
    daily: num("--daily", DEFAULT_RETENTION.daily),
    weekly: num("--weekly", DEFAULT_RETENTION.weekly),
    monthly: num("--monthly", DEFAULT_RETENTION.monthly),
    minAgeHours: num("--min-age-hours", DEFAULT_RETENTION.minAgeHours),
  };

  const entries = listDumps(dir);
  const plan = planPrune(entries, policy);
  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);

  console.log(`Dizin              : ${dir}`);
  console.log(`Politika           : daily ${policy.daily} · weekly ${policy.weekly} · monthly ${policy.monthly} · min yaş ${policy.minAgeHours} saat`);
  console.log(`Dump sayısı        : ${entries.length} (${formatBytes(totalBytes)})`);
  console.log(`IMMUTABLE (dokunulmaz): ${plan.immutableCount}`);
  console.log(`Tutulacak          : ${plan.keptCount}`);
  console.log(`Budanacak          : ${plan.prunedCount} (${formatBytes(plan.bytesToFree)})`);

  if (verbose) {
    console.log("\n--- kararlar ---");
    for (const d of plan.decisions) {
      console.log(`${d.keep ? "KEEP " : "PRUNE"}  ${d.entry.name}  [${d.entry.retentionClass}]  ${d.reason}`);
    }
  } else {
    const sample = plan.decisions.filter((d) => !d.keep).slice(0, 5);
    if (sample.length > 0) {
      console.log("\nBudanacaklardan örnek:");
      for (const d of sample) console.log(`  PRUNE  ${d.entry.name} — ${d.reason}`);
      if (plan.prunedCount > sample.length) console.log(`  … ve ${plan.prunedCount - sample.length} dosya daha`);
    }
    const immutables = plan.decisions.filter((d) => d.entry.retentionClass === "immutable").slice(0, 5);
    if (immutables.length > 0) {
      console.log("\nIMMUTABLE (asla silinmez):");
      for (const d of immutables) console.log(`  KEEP   ${d.entry.name} — ${d.reason}`);
    }
  }

  if (!apply) {
    console.log("\nKURU KOŞU — hiçbir dosya silinmedi. Gerçekten budamak için: --apply");
    return;
  }

  const exec = executePrune(plan);
  console.log(`\nSilinen dump       : ${exec.deletedDumps.length}`);
  console.log(`Silinen yan dosya  : ${exec.deletedSidecars.length}`);
  console.log(`Boşalan alan       : ${formatBytes(exec.bytesFreed)}`);
  if (exec.failures.length > 0) {
    console.log(`Atlanan/başarısız  : ${exec.failures.length}`);
    for (const f of exec.failures.slice(0, 10)) console.log(`  ${f.path} — ${f.error}`);
  }
  const after = listDumps(dir);
  console.log(`Kalan dump         : ${after.length} (${formatBytes(after.reduce((s, e) => s + e.bytes, 0))})`);
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] ?? "").href; } catch { return false; }
})();

if (isDirectRun) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
