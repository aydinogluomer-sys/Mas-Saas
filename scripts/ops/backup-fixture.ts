// PHASE 7.3 — doğrulama kapıları için GERÇEK bir yedek fixture'ı.
//
// Eski kapılar tazelik sinyalini `writeFileSync("recent.dump", "taze mtime — gerçek dump değil")`
// ile besliyordu. Tazelik sözleşmesi artık dump + makbuz + sha256 + PGDMP başlığı + pg_restore
// --list istediği için o dosya BİLEREK reddedilir. Bu yardımcı, HARCANABİLİR hedef veritabanından
// gerçek bir `pg_dump -Fc --schema-only` alır (küçük, saniyeler), yanına gerçek sha256/boyutla bir
// stage07 makbuzu yazar ve istenirse dosya+makbuz zamanını geçmişe çeker (bayat fixture).
//
// GERÇEK yedeklere DOKUNMAZ: hedef dizin çağıranın verdiği geçici dizindir; `backups/` altındaki
// hiçbir dosyanın zamanı/içeriği değiştirilmez.
//
// pg_dump, sırayla: MAS_PG_DUMP_BIN (yerel ikili) → `docker exec <container> pg_dump` (CI ve
// üretim makinesi). İkisi de yoksa fixture ÜRETİLEMEZ ve çağıran bunu SKIP/FAIL olarak raporlar —
// sahte bir dosyaya geri düşülmez.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKUP_RECEIPT_KIND } from "@/lib/ops/backup-freshness";
import { sha256OfFile } from "./backup-lib";

export interface FixtureBackupOptions {
  dir: string;
  ownerUrl: string;
  name?: string;
  /** Dosya ve makbuz zamanı şimdi − ageHours (bayat fixture için). */
  ageHours?: number;
  container?: string;
  pgDumpBin?: string;
}

export interface FixtureBackup {
  dumpPath: string;
  receiptPath: string;
  sha256: string;
  bytes: number;
  timestamp: string;
  producedBy: "local_pg_dump" | "docker_pg_dump";
}

function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

/** pg_dump aracı var mı — çağıran SKIP kararını buna göre verir. */
export function fixtureDumpToolAvailable(opts: { container?: string; pgDumpBin?: string } = {}): "local_pg_dump" | "docker_pg_dump" | null {
  const bin = opts.pgDumpBin ?? process.env.MAS_PG_DUMP_BIN;
  if (bin && existsSync(bin)) return "local_pg_dump";
  const container = opts.container ?? process.env.MAS_PG_CONTAINER ?? "mas-radar-pg";
  try {
    execFileSync("docker", ["exec", container, "pg_dump", "--version"], { stdio: "ignore", timeout: 10_000 });
    return "docker_pg_dump";
  } catch {
    return null;
  }
}

export function writeFixtureVerifiedBackup(opts: FixtureBackupOptions): FixtureBackup {
  mkdirSync(opts.dir, { recursive: true });
  const ageMs = (opts.ageHours ?? 0) * 3_600_000;
  const when = new Date(Date.now() - ageMs);
  const name = opts.name ?? `fixture-${when.toISOString().replace(/[:.]/g, "-")}.dump`;
  const dumpPath = path.join(opts.dir, name);
  const dbName = dbNameOf(opts.ownerUrl);

  const tool = fixtureDumpToolAvailable(opts);
  if (tool === null) throw new Error("fixture için pg_dump yok: MAS_PG_DUMP_BIN tanımlayın ya da Docker container'ı başlatın");
  if (tool === "local_pg_dump") {
    execFileSync(opts.pgDumpBin ?? process.env.MAS_PG_DUMP_BIN!, ["-Fc", "--schema-only", "-d", opts.ownerUrl, "-f", dumpPath], {
      stdio: ["ignore", "ignore", "pipe"], timeout: 120_000,
    });
  } else {
    const container = opts.container ?? process.env.MAS_PG_CONTAINER ?? "mas-radar-pg";
    const bytes = execFileSync("docker", ["exec", container, "pg_dump", "-Fc", "--schema-only", "-U", "postgres", "-d", dbName], {
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: 120_000,
    });
    writeFileSync(dumpPath, bytes);
  }

  const st = statSync(dumpPath);
  const sha256 = sha256OfFile(dumpPath);
  const receipt = {
    receiptKind: BACKUP_RECEIPT_KIND,
    timestamp: when.toISOString(),
    source_db: dbName,
    system_identifier: "fixture",
    git_sha: "fixture",
    schema_ledger: "fixture",
    file_size: st.size,
    sha256,
    pg_version: "fixture",
    pg_dump_version: tool,
    git_branch: "fixture",
    git_tree_clean: false,
    dump_path: dumpPath,
    strict_receipt_path: null,
    strict_receipt_sha256: null,
    data_class: "DISPOSABLE_FIXTURE",
  };
  const receiptPath = `${dumpPath}.stage07.json`;
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), "utf8");
  if (ageMs > 0) {
    utimesSync(dumpPath, when, when);
    utimesSync(receiptPath, when, when);
  }
  return { dumpPath, receiptPath, sha256, bytes: st.size, timestamp: receipt.timestamp, producedBy: tool };
}

/** Negatif kontrol: makbuz aynı kalır, dump'ın sonuna bir bayt eklenir → sha256 makbuzla uyuşmaz. */
export function tamperFixtureDump(dumpPath: string): void {
  const before = statSync(dumpPath);
  writeFileSync(dumpPath, Buffer.concat([readFileSync(dumpPath), Buffer.from([0x00])]));
  utimesSync(dumpPath, before.atime, before.mtime);
}

/** Bu makinede TAKILI OLMAYAN bir sürücü kökü (DRIVE_ABSENT negatif kontrolü). Yoksa null. */
export function absentDriveRoot(): string | null {
  if (process.platform !== "win32") return null;
  for (const letter of ["Z", "Y", "X", "W", "V", "U", "T", "S", "R", "Q"]) {
    if (!existsSync(`${letter}:\\`)) return `${letter}:\\`;
  }
  return null;
}
