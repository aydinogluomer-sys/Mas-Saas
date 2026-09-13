// PHASE 7.3 — tazelik sözleşmesinin DOSYA SİSTEMİ tarafı: `src/lib/ops/backup-freshness.ts`
// saf kuralı taşır, burası ona gerçek dosyaları, makbuzları ve pg_restore kanıtını verir.
//
// pg_restore --list KANITI, sırayla:
//   1. MAS_PG_RESTORE_BIN  → yerel pg_restore ŞİMDİ koşar (Docker olmayan makine / CI dışı doğrulama).
//   2. Docker container    → `docker cp` + `docker exec pg_restore --list` (üretim makinesinin yolu;
//                            `verifyRestoreListable` ile AYNI çağrı). Docker cevap vermiyorsa denenmez.
//   3. sha256-bağlı kayıt  → backups/daily-runs.jsonl satırı (toc_entry_count, aynı sha256) ya da
//                            `<dump>.offdevice.json` (destTocEntryCount, destSha256). Bayt aynıysa
//                            yedek anındaki listeleme sonucu hâlâ geçerlidir.
//   4. hiçbiri             → null → aday REDDEDİLİR (fail-closed).
//
// Docker'ın "ayakta mı" kontrolü koşu başına BİR kez yapılır ve 5 saniyeyle sınırlıdır: Docker
// Desktop kapalıyken `docker` CLI'ın dakikalarca askıda kalması, saatlik telemetriyi sessiz bir
// arızaya çevirirdi.

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, statfsSync } from "node:fs";
import path from "node:path";
import {
  evaluateBackupFreshness,
  type DumpCandidate,
  type FreshnessEvaluation,
  type FreshnessOptions,
  type FreshnessProbe,
  type ReceiptFields,
  type TocEvidence,
} from "@/lib/ops/backup-freshness";
import { sha256OfFile } from "./backup-lib";

export interface ProbeOptions {
  /** `docker exec` için container adı; boş/undefined → Docker yolu denenmez. */
  container?: string;
  /** Yerel pg_restore ikilisi; verilirse önce o denenir. */
  pgRestoreBin?: string;
  /** Koşu kaydı (varsayılan `<dir>/daily-runs.jsonl`). */
  runLogPath?: string;
}

let dockerReachable: boolean | null = null;
function dockerUp(): boolean {
  if (dockerReachable !== null) return dockerReachable;
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    });
    dockerReachable = true;
  } catch {
    dockerReachable = false;
  }
  return dockerReachable;
}

function parseTocCount(listing: string): number | null {
  const m = listing.match(/TOC Entries:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function tocViaLocalBinary(bin: string, dumpPath: string): number | null {
  try {
    const out = execFileSync(bin, ["--list", dumpPath], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    return parseTocCount(out);
  } catch {
    return null;
  }
}

function tocViaDocker(container: string, dumpPath: string): number | null {
  if (!dockerUp()) return null;
  const inContainer = `/tmp/mas-freshness-${process.pid}-${Date.now()}.dump`;
  try {
    execFileSync("docker", ["cp", dumpPath, `${container}:${inContainer}`], { stdio: "ignore", timeout: 60_000 });
    const out = execFileSync("docker", ["exec", container, "pg_restore", "--list", inContainer], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    });
    return parseTocCount(out);
  } catch {
    return null;
  } finally {
    try { execFileSync("docker", ["exec", container, "rm", "-f", inContainer], { stdio: "ignore", timeout: 15_000 }); } catch { /* temizlik */ }
  }
}

/** daily-runs.jsonl: aynı sha256'lı satırın `toc_entry_count`'u (PHASE 7'den önceki satırlarda alan yok → null). */
function tocViaRunLog(runLogPath: string, sha256: string): number | null {
  if (!existsSync(runLogPath)) return null;
  let best: number | null = null;
  for (const line of readFileSync(runLogPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { sha256?: unknown; toc_entry_count?: unknown };
      if (row.sha256 === sha256 && typeof row.toc_entry_count === "number" && row.toc_entry_count > 0) best = row.toc_entry_count;
    } catch { /* bozuk satır: kanıt değil */ }
  }
  return best;
}

/** `<dump>.offdevice.json`: hedefte ölçülmüş TOC, destSha256 ile bağlı. */
function tocViaOffDeviceRecord(dumpPath: string, sha256: string): number | null {
  const recordPath = `${dumpPath}.offdevice.json`;
  if (!existsSync(recordPath)) return null;
  try {
    const r = JSON.parse(readFileSync(recordPath, "utf8")) as { destSha256?: unknown; destRestoreListable?: unknown; destTocEntryCount?: unknown };
    if (r.destSha256 === sha256 && r.destRestoreListable === true && typeof r.destTocEntryCount === "number" && r.destTocEntryCount > 0) return r.destTocEntryCount;
  } catch { /* kanıt değil */ }
  return null;
}

export function fsFreshnessProbe(dir: string, opts: ProbeOptions = {}): FreshnessProbe {
  const runLog = opts.runLogPath ?? path.join(dir, "daily-runs.jsonl");
  return {
    listDumps(): DumpCandidate[] {
      let names: string[];
      try { names = readdirSync(dir); } catch { return []; }
      const out: DumpCandidate[] = [];
      for (const name of names) {
        if (!name.endsWith(".dump")) continue;
        const p = path.join(dir, name);
        try {
          const st = statSync(p);
          if (st.isFile()) out.push({ name, path: p, bytes: st.size, mtimeMs: st.mtimeMs });
        } catch { /* yarışta silinen dosya */ }
      }
      return out;
    },
    readReceipt(dumpPath: string): ReceiptFields | null {
      const p = `${dumpPath}.stage07.json`;
      if (!existsSync(p)) return null;
      try {
        const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
        return parsed !== null && typeof parsed === "object" ? (parsed as ReceiptFields) : null;
      } catch {
        return null;
      }
    },
    readHeader(dumpPath: string, bytes: number): string {
      const fd = openSync(dumpPath, "r");
      try {
        const buf = Buffer.alloc(bytes);
        const n = readSync(fd, buf, 0, bytes, 0);
        return buf.subarray(0, n).toString("latin1");
      } finally {
        closeSync(fd);
      }
    },
    sha256: (dumpPath: string) => sha256OfFile(dumpPath),
    tocEvidence(dumpPath: string, sha256: string): TocEvidence | null {
      if (opts.pgRestoreBin) {
        const n = tocViaLocalBinary(opts.pgRestoreBin, dumpPath);
        if (n !== null) return { entries: n, source: "pg_restore_now" };
      }
      if (opts.container) {
        const n = tocViaDocker(opts.container, dumpPath);
        if (n !== null) return { entries: n, source: "pg_restore_now" };
      }
      const fromLog = tocViaRunLog(runLog, sha256);
      if (fromLog !== null) return { entries: fromLog, source: "run_log_sha_bound" };
      const fromRecord = tocViaOffDeviceRecord(dumpPath, sha256);
      if (fromRecord !== null) return { entries: fromRecord, source: "offdevice_record_sha_bound" };
      return null;
    },
  };
}

/** Tek çağrı: dizin + seçenekler → değerlendirme. */
export function evaluateBackupDir(dir: string, probeOpts: ProbeOptions = {}, evalOpts: FreshnessOptions = {}): FreshnessEvaluation {
  return evaluateBackupFreshness(fsFreshnessProbe(dir, probeOpts), evalOpts);
}

/* ── disk boş alanı ──────────────────────────────────────────────────────────────────────── */

/** Verilen yolun bulunduğu birimde boş alan (GB). Yol yoksa en yakın var olan üst dizin; hiçbiri yoksa null. */
export function freeGbOf(anyPath: string): { freeGb: number; measuredAt: string } | null {
  let p = path.resolve(anyPath);
  for (let i = 0; i < 64; i++) {
    if (existsSync(p)) {
      try {
        const s = statfsSync(p);
        return { freeGb: Number((Number(s.bavail) * Number(s.bsize) / 1024 ** 3).toFixed(2)), measuredAt: p };
      } catch {
        return null;
      }
    }
    const parent = path.dirname(p);
    if (parent === p) return null;
    p = parent;
  }
  return null;
}

/** Bir sürücü/kök var mı (D: takılı mı) — `MAS_OFFDEVICE_BACKUP_DIR` için. */
export function volumeRootPresent(anyPath: string): { root: string; present: boolean } {
  const root = path.parse(path.resolve(anyPath)).root;
  return { root, present: root.length > 0 && existsSync(root) };
}
