// AŞAMA 07 — yedek yaşam döngüsünün ortak kütüphanesi.
//
// NE İŞE YARAR. `scripts/db/backup-adapter.ts` bir dump'ı DAYANIKLI biçimde üretir (fsync → temp
// doğrulama → atomik rename → final dosyada yeniden doğrulama; native PostgreSQL 16 ya da CI'da
// docker) ve `scripts/db/backup-receipt.ts` onun yanına git/cluster kimliği taşıyan bir makbuz
// yazar. İkisi de şunu yanıtlamaz:
//
//   1. Bu dump'ın kopyası BAŞKA bir depolama hedefine gerçekten ULAŞTI mı ve orada
//      byte-byte aynı mı? ("copy komutu 0 döndü" bunun kanıtı değildir.)
//   2. `backups/` sonsuza kadar büyür mü? (Ölçüldü: 857 dump / 973 MB, hiçbir kod
//      budamıyordu.) Budama yaparken hangi dosyaya ASLA dokunulmaz?
//
// Bu dosya o iki soruyu tek yerde, saf ve test edilebilir fonksiyonlarla yanıtlar; CLI'lar
// (offdevice-copy.ts, backup-prune.ts, backup-daily.ts) yalnız ince kabuklardır.
//
// DÜRÜSTLÜK KURALI (rehber §30.5). Aynı makinedeki ikinci bir klasör "off-device" DEĞİLDİR.
// classifyOffDeviceTarget() bunu tahmin etmez; Windows'ta ÖLÇER ve sabit-diskteki bir klasörü
// `LOCAL_STANDIN` olarak işaretler. Politikayı belge değil, kod uygular: bir stand-in yol asla
// `offDeviceSatisfied = true` üretemez.
//
// Kural bir yönde de fazla dardı: Windows, USB ile bağlı gerçek bir harici SSD'yi
// `Win32_LogicalDisk`'te DriveType=3 (sabit disk) gösterir, çünkü DriveType=2 yalnız
// çıkarılabilir ORTAM içindir. Tipe bakan bir kapı böyle bir diski reddeder. Bu yüzden
// DriveType=3 artık son söz değil: fiziksel disk kimliği (`Get-Disk` → numara, BusType,
// IsBoot, IsSystem) ölçülür ve karar `offdevice-topology.ts`'deki saf yükleme bırakılır.
// Yön aynı: gevşetme değil, doğru soruyu sorma. Farklı sürücü harfi hâlâ hiçbir şey kanıtlamaz.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { attemptDirectoryFsync, type DurabilityMetadata } from "../db/legacy-repair-types";
import {
  decideUsbPhysicalVolume, parsePhysicalDiskJson, type PhysicalDiskIdentity,
} from "./offdevice-topology";

export type { PhysicalDiskIdentity } from "./offdevice-topology";

/* ── temel ölçümler ──────────────────────────────────────────────────────────────────────── */

/** Dosyayı diskten OKUYARAK hash'ler — bellekteki bir kopyayı değil. Kopyalama doğrulaması
 * ancak hedefteki gerçek baytlar okunursa bir şey kanıtlar. */
export function sha256OfFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Rehber §12 Bölüm A makbuzunun `pg_version` / `pg_dump_version` alanları. İkisi de yedeği
 * alan araç zincirinden ÖLÇÜLÜR, sabit yazılmaz: tek okuyucu `BackupAdapter.readToolVersions`
 * (scripts/db/backup-adapter.ts) ve katı makbuz da onu kullanıyor — iki kopya, iki cevabın
 * sessizce ayrışmasının yoludur. Native yolda okuyucu ayrıca pg_dump/pg_restore ana sürümünün
 * sunucununkiyle aynı olduğunu zorunlu kılar. */
export interface PgVersions {
  pgVersion: string;
  pgDumpVersion: string;
}

/* ── doküman kasası deterministik tar.gz + SHA-256 manifesti (Faz 43 / B3) ──────────────── */

export interface DocumentManifestEntry {
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface DocumentVaultArchiveResult {
  archivePath: string;
  archiveBytes: number;
  archiveSha256: string;
  manifestPath: string;
  manifestSha256: string;
  fileCount: number;
  totalSourceBytes: number;
  entries: DocumentManifestEntry[];
}

const DOC_COMPANION_SUFFIXES = ["-documents.tar.gz", "-documents.manifest.json"] as const;

export function documentCompanionPaths(dumpPath: string): string[] {
  const stem = dumpPath.replace(/\.dump$/i, "");
  return DOC_COMPANION_SUFFIXES.map((suffix) => `${stem}${suffix}`);
}

function collectVaultFiles(rootDir: string, currentDir: string, out: string[]): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.includes(".tmp-")) continue;
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectVaultFiles(rootDir, full, out);
    } else if (entry.isFile()) {
      const rel = path.relative(rootDir, full).split(path.sep).join("/");
      out.push(rel);
    }
  }
}

function writeOctalField(header: Buffer, offset: number, length: number, value: number): void {
  const oct = Math.max(0, Math.trunc(value)).toString(8).padStart(length - 1, "0");
  header.write(oct.slice(0, length - 1), offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function buildTarHeader(name: string, size: number, typeflag: string, prefix = ""): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(100, Buffer.byteLength(name, "utf8")), "utf8");
  writeOctalField(header, 100, 8, 0o644);
  writeOctalField(header, 108, 8, 0);
  writeOctalField(header, 116, 8, 0);
  writeOctalField(header, 124, 12, size);
  // Sabit mtime=0: aynı dosya ağacı iki ayrı okumada bit-bit aynı tar.gz SHA-256 üretir.
  writeOctalField(header, 136, 12, 0);
  header.fill(0x20, 148, 156); // chksum alanı önce boşlukla doldurulur
  header.write(typeflag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) {
    header.write(prefix, 345, Math.min(155, Buffer.byteLength(prefix, "utf8")), "utf8");
  }
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i]!;
  const chk = sum.toString(8).padStart(6, "0");
  header.write(chk, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function encodeTarEntry(posixRelPath: string, content: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const pathBytes = Buffer.from(posixRelPath, "utf8");
  let headerName = posixRelPath;
  let headerPrefix = "";

  if (pathBytes.length > 100) {
    const slashIdx = posixRelPath.lastIndexOf("/");
    const canSplitUstar =
      slashIdx > 0 &&
      Buffer.byteLength(posixRelPath.slice(0, slashIdx), "utf8") <= 155 &&
      Buffer.byteLength(posixRelPath.slice(slashIdx + 1), "utf8") <= 100;
    if (canSplitUstar) {
      headerPrefix = posixRelPath.slice(0, slashIdx);
      headerName = posixRelPath.slice(slashIdx + 1);
    } else {
      const longLinkPayload = Buffer.concat([pathBytes, Buffer.from([0])]);
      chunks.push(buildTarHeader("././@LongLink", longLinkPayload.length, "L"));
      chunks.push(longLinkPayload);
      const padLen = (512 - (longLinkPayload.length % 512)) % 512;
      if (padLen > 0) chunks.push(Buffer.alloc(padLen, 0));
      headerName = pathBytes.subarray(0, 100).toString("utf8");
    }
  }

  chunks.push(buildTarHeader(headerName, content.length, "0", headerPrefix));
  if (content.length > 0) {
    chunks.push(content);
    const padLen = (512 - (content.length % 512)) % 512;
    if (padLen > 0) chunks.push(Buffer.alloc(padLen, 0));
  }
  return chunks;
}

function writeBufferAtomic(destPath: string, data: Buffer): void {
  const dir = path.dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tempPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tempPath, "wx");
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existsSync(destPath)) unlinkSync(destPath);
  renameSync(tempPath, destPath);
  attemptDirectoryFsync(dir);
}

/**
 * Doküman kasasını (`MAS_DOCUMENT_STORAGE_DIR`) deterministik bir POSIX `.tar.gz` arşivine ve
 * dosya bazlı SHA-256 manifestine paketler. Temp + fsync + atomik rename zincirini kullanır.
 */
export function archiveDocumentVault(storageDir: string, dumpPath: string): DocumentVaultArchiveResult {
  const resolvedStorage = path.resolve(storageDir);
  if (!existsSync(resolvedStorage)) {
    throw new Error(`Doküman kasası dizini bulunamadı: ${resolvedStorage}`);
  }
  const [archivePath, manifestPath] = documentCompanionPaths(dumpPath);
  const relFiles: string[] = [];
  collectVaultFiles(resolvedStorage, resolvedStorage, relFiles);
  relFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const tarChunks: Buffer[] = [];
  const entries: DocumentManifestEntry[] = [];
  let totalSourceBytes = 0;

  for (const rel of relFiles) {
    const abs = path.join(resolvedStorage, ...rel.split("/"));
    const content = readFileSync(abs);
    const sha256 = createHash("sha256").update(content).digest("hex");
    entries.push({ relativePath: rel, bytes: content.length, sha256 });
    totalSourceBytes += content.length;
    tarChunks.push(...encodeTarEntry(rel, content));
  }
  tarChunks.push(Buffer.alloc(1024, 0)); // iki adet 512 bayt sıfır sonlandırma bloğu

  const gz = Buffer.from(gzipSync(Buffer.concat(tarChunks), { level: 6 }));
  if (gz.length >= 10) {
    // Gzip başlığındaki OS baytını (offset 9) platformdan bağımsız (0xff = unknown) sabitle.
    gz[9] = 0xff;
  }
  writeBufferAtomic(archivePath, gz);

  const archiveBytes = statSync(archivePath).size;
  const archiveSha256 = sha256OfFile(archivePath);

  const manifestPayload = {
    manifestKind: "mas-document-vault-manifest-v1",
    archiveFile: path.basename(archivePath),
    archiveBytes,
    archiveSha256,
    fileCount: entries.length,
    totalSourceBytes,
    files: entries,
  };
  writeBufferAtomic(manifestPath, Buffer.from(`${JSON.stringify(manifestPayload, null, 2)}\n`, "utf8"));
  const manifestSha256 = sha256OfFile(manifestPath);

  return {
    archivePath: path.resolve(archivePath),
    archiveBytes,
    archiveSha256,
    manifestPath: path.resolve(manifestPath),
    manifestSha256,
    fileCount: entries.length,
    totalSourceBytes,
    entries,
  };
}

/* ── off-device hedef sınıflandırması ────────────────────────────────────────────────────── */

export type OffDeviceTargetKind =
  | "UNC_NETWORK_SHARE"
  | "REMOVABLE_VOLUME"
  | "NETWORK_DRIVE"
  /** DriveType=3 görünen ama fiziksel disk kimliğiyle USB olduğu KANITLANAN ayrı aygıt. */
  | "USB_PHYSICAL_VOLUME"
  | "FIXED_SEPARATE_VOLUME"
  | "LOCAL_STANDIN"
  | "OPERATOR_ATTESTED"
  | "UNKNOWN";

export interface OffDeviceClassification {
  targetDir: string;
  kind: OffDeviceTargetKind;
  /** YALNIZ fiziksel olarak ayrı bir hedef kanıtlanabildiğinde true. */
  offDeviceSatisfied: boolean;
  /** Kanıt zinciri: kararın hangi ölçüme dayandığı. */
  evidence: string;
  /** Aynı volume üzerinde mi (kaynak `backups/` ile). */
  sameVolumeAsSource: boolean;
  driveType: number | null;
  /** Ölçülen fiziksel disk kimlikleri — ölçülemediyse null (bu bir RED sebebidir). */
  targetDisk: PhysicalDiskIdentity | null;
  sourceDisk: PhysicalDiskIdentity | null;
  /** İkisi de ölçülebildiyse karşılaştırma; aksi hâlde null (bilinmiyor ≠ güvenli). */
  samePhysicalDisk: boolean | null;
  declaredKind: string | null;
  operatorAttestation: string | null;
}

/** Windows sürücü tipi: 2 = çıkarılabilir, 3 = sabit disk, 4 = ağ sürücüsü, 5 = CD-ROM. */
function windowsDriveType(root: string): number | null {
  const letter = /^([A-Za-z]):/.exec(root)?.[1];
  if (!letter) return null;
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter.toUpperCase()}:'").DriveType`,
      ],
      { encoding: "utf8", timeout: 20000 },
    ).trim();
    const n = Number(out);
    return Number.isFinite(n) && out !== "" ? n : null;
  } catch {
    return null;
  }
}

/**
 * Bir sürücü harfinin ARDINDAKİ FİZİKSEL DİSKİ ölçer.
 *
 * `Win32_LogicalDisk.DriveType` mantıksal bir etikettir ve USB ile bağlı bir SSD'yi
 * DriveType=3 (sabit disk) gösterir. Fiziksel ayrılığı yalnız bu ölçüm yanıtlar: disk
 * numarası, veri yolu (BusType) ve diskin boot/system diski olup olmadığı.
 *
 * Harf, çağrılmadan önce tek karakterlik `[A-Za-z]` deseniyle sınırlanır; komuta başka
 * hiçbir kullanıcı verisi girmez. Ölçülemeyen her durum `null` döner — RED demektir.
 */
function windowsPhysicalDisk(root: string): PhysicalDiskIdentity | null {
  const letter = /^([A-Za-z]):/.exec(root)?.[1];
  if (!letter) return null;
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; try { Get-Partition -DriveLetter ${letter.toUpperCase()} | ` +
          "Get-Disk | Select-Object Number,BusType,IsBoot,IsSystem,OperationalStatus,FriendlyName | " +
          "ConvertTo-Json -Compress -Depth 3 } catch { '' }",
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    return parsePhysicalDiskJson(out);
  } catch {
    return null;
  }
}

/**
 * Hedefin gerçekten AYRI bir depolama aygıtı olup olmadığını ÖLÇER.
 *
 * Kararı belgeye değil koda bağlamanın nedeni şu: bir operatör `MAS_OFFDEVICE_BACKUP_DIR`'i
 * aceleyle `C:\yedek2` yapıp "off-device tamam" diye işaretleyebilir. Diski, makineyi ya da
 * fidye yazılımını kaybeden senaryo o iki klasörü birlikte kaybeder. Bu yüzden sabit diskteki
 * bir klasör burada `LOCAL_STANDIN` olarak döner ve `offDeviceSatisfied` HİÇBİR koşulda
 * true olmaz — kanıt üretemeyen bir yol, kanıt üretmiş gibi raporlanamaz.
 *
 * Operatör beyanı (`MAS_OFFDEVICE_DECLARED_KIND` + `MAS_OFFDEVICE_OPERATOR_ATTESTATION`)
 * yalnız otomatik tespitin ULAŞAMADIĞI hedefler için vardır (ör. şifreli nesne depolamanın
 * yerel eşitleme klasörü). O durumda sınıf `OPERATOR_ATTESTED` olur: kabul edilir ama
 * otomatik tespitten AYRI etiketlenir, çünkü kanıtın kaynağı ölçüm değil beyandır.
 */
export type BackupPathOverlapKind = "identical" | "target_inside_source" | "source_inside_target";

export interface NormalizedBackupPath {
  /** Karşılaştırma için normalize edilmiş yol (`/` ayraçlı, sondaki `/` kırpılmış, Windows/UNC'de küçük harf). */
  canonical: string;
  /** Kök volume veya UNC paylaşım anahtarı (`"c:\\"`, `"//sunucu/paylasim"`, `"/"`). */
  rootKey: string;
  /** Kullanıcıya ve makbuza yazılacak normalize gösterim yolu. */
  displayPath: string;
  isUnc: boolean;
  isWindowsDrive: boolean;
}

/**
 * Windows sürücü harflerini (`C:\...`, `c:/...`), UNC ağ paylaşımlarını (`\\nas\pay\...`, `//NAS/pay/...`)
 * ve POSIX yollarını platformdan bağımsız biçimde normalize eder.
 */
export function normalizeBackupPath(rawPath: string): NormalizedBackupPath {
  const trimmed = rawPath.trim();
  const isUnc = /^(\\\\|\/\/)/.test(trimmed);
  const isWindowsDrive = !isUnc && /^[A-Za-z]:([\\/]|$)/.test(trimmed);

  if (isUnc) {
    const stripped = trimmed.replace(/^[\\/]+/, "").replace(/\//g, "\\");
    const winNorm = path.win32.normalize(`\\\\${stripped}`);
    const displayPath = winNorm.length > 2 ? winNorm.replace(/\\+$/, "") : winNorm;
    const posixLike = `//${displayPath.replace(/^\\+/, "").replace(/\\/g, "/")}`;
    const canonical = posixLike.toLowerCase();
    const parsedRoot = path.win32.parse(winNorm).root;
    const rootKey = parsedRoot
      ? `//${parsedRoot.replace(/^\\+/, "").replace(/\\+$/, "").replace(/\\/g, "/")}`.toLowerCase()
      : canonical;
    return { canonical, rootKey, displayPath, isUnc: true, isWindowsDrive: false };
  }

  if (isWindowsDrive) {
    const withSlash = /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed.replace(/\//g, "\\");
    const winNorm = path.win32.normalize(withSlash);
    const parsed = path.win32.parse(winNorm);
    const drivePrefix = parsed.root.replace(/\\+$/, "").toLowerCase(); // ör. "c:"
    const rootKey = `${drivePrefix}\\`; // ör. "c:\"
    const isRootOnly = winNorm.replace(/\\+$/, "").toLowerCase() === drivePrefix;
    const displayPath = isRootOnly ? `${parsed.root.slice(0, 2)}\\` : winNorm.replace(/\\+$/, "");
    const canonical = winNorm.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return { canonical, rootKey, displayPath, isUnc: false, isWindowsDrive: true };
  }

  const resolved = path.resolve(trimmed);
  if (process.platform === "win32") {
    return normalizeBackupPath(resolved);
  }
  const parsed = path.posix.parse(resolved);
  const canonical = resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
  return {
    canonical,
    rootKey: parsed.root || "/",
    displayPath: canonical,
    isUnc: false,
    isWindowsDrive: false,
  };
}

/**
 * Kaynak ve hedef yedek dizinlerinin aynı dizin olup olmadığını veya birinin diğerinin alt klasörü
 * olup olmadığını platformdan bağımsız olarak saptar (`null` = çakışma yok).
 */
export function detectBackupPathOverlap(
  targetDir: string,
  sourceDir: string | null | undefined,
): BackupPathOverlapKind | null {
  if (!sourceDir || sourceDir.trim() === "") return null;
  if (!targetDir || targetDir.trim() === "") return null;
  const t = normalizeBackupPath(targetDir);
  const s = normalizeBackupPath(sourceDir);
  const caseInsensitive = t.isUnc || t.isWindowsDrive || s.isUnc || s.isWindowsDrive;
  const tc = caseInsensitive ? t.canonical.toLowerCase() : t.canonical;
  const sc = caseInsensitive ? s.canonical.toLowerCase() : s.canonical;

  if (tc === sc) return "identical";
  const sPrefix = sc === "/" ? "/" : `${sc}/`;
  const tPrefix = tc === "/" ? "/" : `${tc}/`;
  if (tc.startsWith(sPrefix)) return "target_inside_source";
  if (sc.startsWith(tPrefix)) return "source_inside_target";
  return null;
}

export function classifyOffDeviceTarget(targetDir: string, sourceDir: string): OffDeviceClassification {
  const normTarget = normalizeBackupPath(targetDir);
  const hasSource = typeof sourceDir === "string" && sourceDir.trim() !== "";
  const normSource = hasSource ? normalizeBackupPath(sourceDir) : null;
  const declaredKind = process.env.MAS_OFFDEVICE_DECLARED_KIND ?? null;
  const operatorAttestation = process.env.MAS_OFFDEVICE_OPERATOR_ATTESTATION ?? null;
  const targetRoot = normTarget.rootKey;
  const sourceRoot = normSource ? normSource.rootKey : "";
  const overlap = detectBackupPathOverlap(targetDir, sourceDir);
  const sameVolumeAsSource = overlap !== null || (normSource !== null && targetRoot === sourceRoot);

  const base = {
    targetDir: normTarget.displayPath,
    sameVolumeAsSource,
    declaredKind,
    operatorAttestation,
    // DriveType 2/4 ve UNC kendi başlarına ayrılığı kanıtlar; topoloji ölçümü (iki PowerShell
    // çağrısı) yalnız DriveType=3 belirsizliğini çözmek için yapılır.
    targetDisk: null as PhysicalDiskIdentity | null,
    sourceDisk: null as PhysicalDiskIdentity | null,
    samePhysicalDisk: null as boolean | null,
  };

  if (overlap !== null) {
    const overlapDetail =
      overlap === "identical"
        ? `Hedef dizin kaynak dizinle AYNI (${normTarget.displayPath} === ${normSource?.displayPath ?? sourceDir}) — source === target`
        : overlap === "target_inside_source"
          ? `Hedef dizin kaynak dizinin ALT KLASÖRÜ (${normTarget.displayPath} ⊂ ${normSource?.displayPath ?? sourceDir})`
          : `Kaynak dizin hedef dizinin ALT KLASÖRÜ (${normSource?.displayPath ?? sourceDir} ⊂ ${normTarget.displayPath})`;
    return {
      ...base,
      sameVolumeAsSource: true,
      kind: "LOCAL_STANDIN",
      offDeviceSatisfied: false,
      driveType: null,
      evidence: `${overlapDetail}; kaynak ve hedef çakışıyor, off-device kopya olamaz (rehber §30.5).`,
    };
  }

  if (normTarget.isUnc) {
    if (sameVolumeAsSource) {
      return {
        ...base,
        kind: "LOCAL_STANDIN",
        offDeviceSatisfied: false,
        driveType: null,
        evidence:
          `UNC yolu kaynakla aynı ağ paylaşımında (${targetRoot}) — ` +
          "aynı paylaşımdaki ikinci klasör bağımsız off-device kopya sayılmaz.",
      };
    }
    return {
      ...base, kind: "UNC_NETWORK_SHARE", offDeviceSatisfied: true, driveType: null,
      evidence: "UNC yolu — hedef bu makinenin yerel diski değil ve kaynaktan bağımsız ağ paylaşımı.",
    };
  }

  const driveType = process.platform === "win32" ? windowsDriveType(targetRoot) : null;
  if (driveType === 2) {
    if (sameVolumeAsSource) {
      return {
        ...base,
        kind: "LOCAL_STANDIN",
        offDeviceSatisfied: false,
        driveType,
        evidence: `Hedef kaynakla aynı çıkarılabilir volume üzerinde (kök ${targetRoot}) — ayrı aygıt değil.`,
      };
    }
    return {
      ...base, kind: "REMOVABLE_VOLUME", offDeviceSatisfied: true, driveType,
      evidence: `Win32_LogicalDisk DriveType=2 (çıkarılabilir) — kök ${targetRoot}`,
    };
  }
  if (driveType === 4) {
    if (sameVolumeAsSource) {
      return {
        ...base,
        kind: "LOCAL_STANDIN",
        offDeviceSatisfied: false,
        driveType,
        evidence: `Hedef kaynakla aynı ağ sürücüsü üzerinde (kök ${targetRoot}) — ayrı aygıt değil.`,
      };
    }
    return {
      ...base, kind: "NETWORK_DRIVE", offDeviceSatisfied: true, driveType,
      evidence: `Win32_LogicalDisk DriveType=4 (ağ sürücüsü) — kök ${targetRoot}`,
    };
  }

  // DriveType=3: mantıksal etiket burada karar veremez. USB ile bağlı gerçek bir harici disk
  // de, makinenin kendi NVMe'sindeki ikinci bölüm de aynı 3'ü döndürür. Fiziksel kimlik ölçülür.
  if (driveType === 3) {
    const targetDisk = windowsPhysicalDisk(targetRoot);
    const sourceDisk = windowsPhysicalDisk(sourceRoot);
    const samePhysicalDisk =
      targetDisk !== null && sourceDisk !== null ? targetDisk.diskNumber === sourceDisk.diskNumber : null;
    const measured = { ...base, driveType, targetDisk, sourceDisk, samePhysicalDisk };
    const decision = decideUsbPhysicalVolume({
      driveType, targetRoot, sourceRoot, sameVolumeAsSource, targetDisk, sourceDisk,
    });
    if (decision.cleanupGrade) {
      return {
        ...measured, kind: "USB_PHYSICAL_VOLUME", offDeviceSatisfied: true,
        evidence: `USB ile bağlı ayrı fiziksel disk ÖLÇÜLDÜ — ${decision.evidence}`,
      };
    }
    // Beyan, ölçümün YERİNE geçmez ama ölçümün ULAŞAMADIĞI hedefler için hâlâ vardır.
    // Ölçüm başarılı olup REDDETTİYSE beyan onu geçersiz kılamaz.
    if (declaredKind && operatorAttestation) {
      return {
        ...measured, kind: "OPERATOR_ATTESTED", offDeviceSatisfied: true,
        evidence:
          `Otomatik tespit ayrı aygıt kanıtlayamadı (${decision.blockers.join("; ")}); ` +
          `operatör beyanı kabul edildi: kind='${declaredKind}'. Beyan ÖLÇÜM DEĞİLDİR.`,
      };
    }
    if (!sameVolumeAsSource) {
      return {
        ...measured, kind: "FIXED_SEPARATE_VOLUME", offDeviceSatisfied: false,
        evidence:
          `Win32_LogicalDisk DriveType=3, kaynaktan farklı volume (${targetRoot} ≠ ${sourceRoot}), ` +
          `ama ayrı USB aygıtı KANITLANAMADI: ${decision.blockers.join("; ")}. ` +
          "Ayrı bölüm ayrı AYGIT demek değildir.",
      };
    }
    return {
      ...measured, kind: "LOCAL_STANDIN", offDeviceSatisfied: false,
      evidence:
        `Hedef kaynakla aynı volume üzerinde (kök ${targetRoot}); ${decision.blockers.join("; ")}. ` +
        "Aynı makinedeki ikinci klasör off-device kopya SAYILMAZ (rehber §30.5).",
    };
  }

  if (declaredKind && operatorAttestation) {
    return {
      ...base, kind: "OPERATOR_ATTESTED", offDeviceSatisfied: true, driveType,
      evidence:
        `Otomatik tespit ayrı aygıt kanıtlayamadı (DriveType=${driveType ?? "bilinmiyor"}); ` +
        `operatör beyanı kabul edildi: kind='${declaredKind}'. Beyan ÖLÇÜM DEĞİLDİR.`,
    };
  }
  return {
    ...base,
    kind: driveType === null ? "LOCAL_STANDIN" : "UNKNOWN",
    offDeviceSatisfied: false,
    driveType,
    evidence:
      `Hedef bu makinenin yerel sabit diskinde (DriveType=${driveType ?? "ölçülemedi"}, kök ${targetRoot}). ` +
      "Aynı makinedeki ikinci klasör off-device kopya SAYILMAZ (rehber §30.5).",
  };
}

/* ── kopyala + hedefte yeniden doğrula ───────────────────────────────────────────────────── */

export interface CopyVerifyResult {
  sourcePath: string;
  sourceBytes: number;
  sourceSha256: string;
  destPath: string;
  destBytes: number;
  destSha256: string;
  sha256Match: boolean;
  bytesMatch: boolean;
  /** Hedefteki KOPYA pg_restore --list ile ayrıştırılabildi mi (enjekte edilen doğrulayıcıyla,
   * hedef dosyanın kendisi okunarak). */
  destRestoreListable: boolean;
  destTocEntryCount: number | null;
  sidecarsCopied: string[];
  durability: DurabilityMetadata;
  classification: OffDeviceClassification;
  copiedAt: string;
}

/** `<dump>.offdevice.json` kaydının şema etiketi. */
export const OFFDEVICE_RECORD_KIND = "mas-offdevice-copy-record-v1";

/**
 * Off-device kopya kaydının TEK tanımı.
 *
 * NEDEN BURADA. Bu tip önce `offdevice-copy.ts` içinde satır içi bir nesne literaliydi ve
 * `fixture-cleanup.ts` onu KENDİ tahmin ettiği alan adlarıyla (`targetSha256Verified`)
 * okuyordu. İkisi hiç karşılaşmadığı için hata sessiz kaldı: cleanup kapısı makbuzu
 * göremediği için zaten reddediyordu, yani yanlış alan adı ancak harici disk takıldığı gün
 * — yani en kötü anda — ortaya çıkacaktı. Alan adları artık tek yerde yaşıyor.
 */
export interface OffDeviceCopyRecord {
  receiptKind: typeof OFFDEVICE_RECORD_KIND;
  copiedAt: string;
  sourcePath: string;
  sourceSha256: string;
  sourceBytes: number;
  destPath: string;
  destSha256: string;
  destBytes: number;
  sha256VerifiedAtDestination: boolean;
  bytesVerifiedAtDestination: boolean;
  destRestoreListable: boolean;
  destTocEntryCount: number | null;
  sidecarsCopied: string[];
  targetKind: OffDeviceTargetKind;
  offDeviceSatisfied: boolean;
  targetEvidence: string;
  durability: DurabilityMetadata;
}

/**
 * Gerçek DB'de yıkıcı bir işlemi (fixture temizliği) açmaya YETEN hedef sınıfları.
 *
 * `OPERATOR_ATTESTED` BİLEREK DIŞARIDA. O sınıf iki ortam değişkeniyle
 * (`MAS_OFFDEVICE_DECLARED_KIND` + `MAS_OFFDEVICE_OPERATOR_ATTESTATION`) tetiklenir ve
 * `offDeviceSatisfied: true` üretir — yani hiçbir fiziksel doğrulama olmadan, yalnız BEYANLA.
 * Bir yedeğin var olduğuna dair beyan, gerçek satırları silmeye yetmez.
 *
 * `UNC_NETWORK_SHARE` içeride: `\\sunucu\pay` ile eşlenmiş bir ağ sürücüsü aynı NAS'ın iki
 * yazılış biçimidir; fiziksel ayrılık aynıdır. `FIXED_SEPARATE_VOLUME` ve `LOCAL_STANDIN`
 * zaten `offDeviceSatisfied: false` üretir.
 *
 * `USB_PHYSICAL_VOLUME` içeride ÇÜNKÜ ölçümle üretilir, tipe bakarak değil: hedefin fiziksel
 * disk numarası, BusType=USB, IsBoot=false, IsSystem=false ve kaynak diskten FARKLI olduğu
 * `Get-Disk` ile ölçülür (bkz. `offdevice-topology.ts`). Bu, DriveType=2'nin sağladığı
 * güvenceyle aynı türdendir — Windows'un USB bir SSD'yi DriveType=3 göstermesi bir
 * ETİKETLEME ayrıntısıdır, fiziksel ayrılığın yokluğu değil.
 *
 * `FIXED_SEPARATE_VOLUME` GEVŞETİLMEDİ: farklı sürücü harfi hâlâ hiçbir şey kanıtlamaz.
 */
export const CLEANUP_GRADE_TARGET_KINDS: ReadonlySet<OffDeviceTargetKind> = new Set([
  "REMOVABLE_VOLUME", "NETWORK_DRIVE", "UNC_NETWORK_SHARE", "USB_PHYSICAL_VOLUME",
]);

/**
 * Bir off-device kaydının, gerçek DB'de yıkıcı işlem açmaya yetip yetmediğini söyler.
 * Boş dizi dönerse yeter; aksi hâlde her madde bir engel sebebidir.
 */
export function offDeviceCleanupBlockers(raw: unknown): string[] {
  const out: string[] = [];
  if (raw === null || typeof raw !== "object") return ["makbuz bir JSON nesnesi değil"];
  const r = raw as Partial<OffDeviceCopyRecord>;
  if (r.receiptKind !== OFFDEVICE_RECORD_KIND) {
    out.push(`receiptKind '${OFFDEVICE_RECORD_KIND}' olmalı, '${String(r.receiptKind)}' geldi`);
  }
  const flags: Array<[keyof OffDeviceCopyRecord, string]> = [
    ["offDeviceSatisfied", "hedef ayrı bir aygıt olarak kanıtlanmadı"],
    ["sha256VerifiedAtDestination", "HEDEFTEKİ dosyanın sha256'sı doğrulanmadı"],
    ["bytesVerifiedAtDestination", "HEDEFTEKİ dosyanın bayt sayısı doğrulanmadı"],
    ["destRestoreListable", "hedefteki kopya pg_restore --list ile okunamadı"],
  ];
  for (const [key, why] of flags) {
    if (r[key] !== true) out.push(`${String(key)} != true — ${why}`);
  }
  const kind = r.targetKind;
  if (kind === undefined) out.push("targetKind yok");
  else if (!CLEANUP_GRADE_TARGET_KINDS.has(kind)) {
    out.push(
      `targetKind '${kind}' yıkıcı işlem için yetmez — izinli: ${[...CLEANUP_GRADE_TARGET_KINDS].join(", ")}` +
        (kind === "OPERATOR_ATTESTED" ? " (OPERATOR_ATTESTED yalnız beyandır, fiziksel kanıt değildir)" : ""),
    );
  }
  return out;
}

function copyOneVerified(
  sourcePath: string,
  destDir: string,
  copyFileImpl: (src: string, dest: string) => void = copyFileSync,
): {
  destPath: string;
  destBytes: number;
  destSha256: string;
  sourceSha256: string;
  sourceBytes: number;
  durability: DurabilityMetadata;
} {
  const sourceBytes = statSync(sourcePath).size;
  const sourceSha256 = sha256OfFile(sourcePath);
  if (process.platform !== "win32" && /^[A-Za-z]:([\\/]|$)/.test(destDir.trim())) {
    throw Object.assign(
      new Error(`ENOENT: no such file or directory, mkdir '${destDir}'`),
      { code: "ENOENT", syscall: "mkdir", path: destDir },
    );
  }
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, path.basename(sourcePath));
  if (normalizeBackupPath(destPath).canonical === normalizeBackupPath(sourcePath).canonical) {
    throw new Error(
      `GÜVENLİK DURDURMASI: Hedef dosya yolu kaynak dump ile aynı (${destPath} === ${sourcePath}).`,
    );
  }
  const tempPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  // Temp + fsync + atomik rename: yarım kopyalanmış bir dosya asla nihai adıyla görünmez.
  // Kopyalama sırasında hata olursa `*.tmp-*` artığı da temizlenir.
  try {
    copyFileImpl(sourcePath, tempPath);
    const fd = openSync(tempPath, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (existsSync(destPath)) unlinkSync(destPath);
    renameSync(tempPath, destPath);
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      /* geçici dosya zaten yok */
    }
    throw err;
  }
  const durability = attemptDirectoryFsync(destDir);

  const destBytes = statSync(destPath).size;
  const destSha256 = sha256OfFile(destPath);
  return { destPath, destBytes, destSha256, sourceSha256, sourceBytes, durability };
}

/**
 * Dump'ı hedefe kopyalar ve HEDEFTEKİ dosyayı yeniden okuyarak sha256 + boyut doğrular.
 *
 * "copy komutu başarılı döndü" ile "kopya bit-bit aynı" arasındaki fark, sessiz bozulmanın
 * yaşadığı yerdir: ağ paylaşımı yarım yazar, USB kablosu takılır, hedef disk dolar. Hash
 * hedeften OKUNARAK yeniden hesaplanır; eşleşmezse kopya SİLİNİR ve hata yükseltilir —
 * bozuk bir dosya "yedek" adıyla ortalıkta bırakılmaz.
 *
 * `verifyListable` verilirse HEDEFTEKİ dosya ayrıca `pg_restore --list` ile ayrıştırılır:
 * kopyanın yalnız aynı baytları değil, hâlâ GEÇERLİ BİR ARŞİV olduğunu da gösterir. Doğrulayıcı
 * enjekte edilir (scripts/db/backup-adapter.ts → createListVerifier): bu kütüphane hiçbir araç
 * zincirini kendisi seçmez, hiçbir veritabanına bağlanmaz. Doğrulayıcının fırlattığı hata
 * YUTULMAZ — okunamayan bir kopya "kopyalandı ama doğrulanamadı" diye sessizce geçmez.
 *
 * `classify` ve `copyFileImpl` yalnız test seam'leridir: gerçek sınıflandırma Windows'ta PowerShell
 * ile disk topolojisi ölçer ve birim testte kopya/bozulma/doğrulama zinciri izole sınanır.
 */
export function copyToTargetVerified(
  sourcePath: string,
  destDir: string,
  opts: {
    verifyListable?: (destPath: string) => { tocEntryCount: number };
    sourceDir?: string;
    classify?: (targetDir: string, sourceDir: string) => OffDeviceClassification;
    copyFileImpl?: (src: string, dest: string) => void;
  } = {},
): CopyVerifyResult {
  if (!existsSync(sourcePath)) throw new Error(`Kaynak dump yok: ${sourcePath}`);
  const effectiveSourceDir = opts.sourceDir ?? path.dirname(sourcePath);
  if (
    detectBackupPathOverlap(destDir, effectiveSourceDir) === "identical" ||
    detectBackupPathOverlap(destDir, path.dirname(sourcePath)) === "identical"
  ) {
    throw new Error(
      `GÜVENLİK DURDURMASI: Hedef dizin kaynak dizinle aynı olamaz (${destDir} === ${effectiveSourceDir}).`,
    );
  }
  const classification = (opts.classify ?? classifyOffDeviceTarget)(destDir, effectiveSourceDir);

  const main = copyOneVerified(sourcePath, destDir, opts.copyFileImpl);
  const sha256Match = main.destSha256 === main.sourceSha256;
  const bytesMatch = main.destBytes === main.sourceBytes;
  if (!sha256Match || !bytesMatch) {
    try { unlinkSync(main.destPath); } catch { /* zaten yok */ }
    throw new Error(
      `Hedefteki kopya kaynakla eşleşmedi (kopya silindi): ` +
        `bayt ${main.sourceBytes} → ${main.destBytes}, sha256 ${main.sourceSha256.slice(0, 12)}… → ${main.destSha256.slice(0, 12)}…`,
    );
  }

  // Makbuz, yan dosyalar, şifreli kopya (.enc), .sha256 özeti ve doküman kasası arşiv çifti
  // (-documents.tar.gz / -documents.manifest.json) birlikte kopyalanır ve hedefte SHA-256 doğrulamasından geçer.
  const sidecarsCopied: string[] = [];
  const candidateCompanions = [
    `${sourcePath}.receipt.json`,
    `${sourcePath}.stage07.json`,
    `${sourcePath}.sha256`,
    `${sourcePath}.enc`,
    ...documentCompanionPaths(sourcePath),
  ];
  for (const sidecar of candidateCompanions) {
    if (!existsSync(sidecar)) continue;
    const copied = copyOneVerified(sidecar, destDir, opts.copyFileImpl);
    if (copied.destSha256 !== copied.sourceSha256 || copied.destBytes !== copied.sourceBytes) {
      try { unlinkSync(copied.destPath); } catch { /* zaten yok */ }
      try { unlinkSync(main.destPath); } catch { /* zaten yok */ }
      for (const prev of sidecarsCopied) {
        try { unlinkSync(path.join(destDir, prev)); } catch { /* zaten yok */ }
      }
      throw new Error(`Yan dosya / doküman arşivi kopyası eşleşmedi (silindi): ${sidecar}`);
    }
    sidecarsCopied.push(path.basename(copied.destPath));
  }

  let destRestoreListable = false;
  let destTocEntryCount: number | null = null;
  if (opts.verifyListable) {
    // Sayı arşivin kendi `TOC Entries:` başlığından gelir (eskiden yorum olmayan satır sayısıydı);
    // ikisi de > 0 olmak zorunda, anlamı aynı: hedefteki dosya ayrıştırılabilir bir arşiv.
    destTocEntryCount = opts.verifyListable(main.destPath).tocEntryCount;
    destRestoreListable = destTocEntryCount > 0;
  }

  return {
    sourcePath: path.resolve(sourcePath),
    sourceBytes: main.sourceBytes,
    sourceSha256: main.sourceSha256,
    destPath: main.destPath,
    destBytes: main.destBytes,
    destSha256: main.destSha256,
    sha256Match,
    bytesMatch,
    destRestoreListable,
    destTocEntryCount,
    sidecarsCopied,
    durability: main.durability,
    classification,
    copiedAt: new Date().toISOString(),
  };
}

/* ── retention / budama ──────────────────────────────────────────────────────────────────── */

export type RetentionClass = "immutable" | "rolling";

export interface DumpEntry {
  name: string;
  fullPath: string;
  bytes: number;
  /** Dosya adındaki damgadan; okunamazsa dosya mtime'ından. */
  timestamp: Date;
  timestampSource: "filename" | "mtime";
  label: string;
  retentionClass: RetentionClass;
  immutableReason: string | null;
  sidecars: string[];
}

/**
 * Bu kalıplardan biri dosya adında geçiyorsa dump ASLA budanmaz.
 *
 * `mas_radar_dev` kalıbı kuru koşunun bir bulgusudur, süsleme değil: ilk çalıştırmada
 * `mas_radar_dev-20260706-181434.dump` — gerçek üretim veritabanının bir yedeği —
 * "hiçbir retention kovasına girmiyor" diye budanacaklar listesine düşmüştü. KORUNAN
 * veritabanının yedeği rolling çöp değildir; adı onu söylüyorsa dokunulmaz. Günlük rolling
 * yedekler `daily-…` etiketiyle üretilir, bu yüzden bu kural onları kapsamaz.
 */
export const IMMUTABLE_NAME_PATTERNS: readonly RegExp[] = Object.freeze([
  /^cutover_/i,
  /pre[-_]?cutover/i,
  /post[-_]?cutover/i,
  /^stage\d+_real/i,
  /immutable/i,
  /^release[-_]/i,
  /mas_radar_dev/i,
]);

export const SIDECAR_SUFFIXES = [
  ".receipt.json",
  ".stage07.json",
  ".offdevice.json",
  ".immutable",
  ".enc",
  ".sha256",
] as const;

/** `<dump>.sha256` yan dosyasını atomik (temp + fsync + rename) olarak yazar ve geri doğrular. */
export function writeSha256Sidecar(
  targetFilePath: string,
  precomputedSha256?: string,
): { sidecarPath: string; sha256: string } {
  const sha = precomputedSha256 ?? sha256OfFile(targetFilePath);
  const sidecarPath = `${targetFilePath}.sha256`;
  const content = `${sha}  ${path.basename(targetFilePath)}\n`;
  writeBufferAtomic(sidecarPath, Buffer.from(content, "utf8"));
  return { sidecarPath: path.resolve(sidecarPath), sha256: sha };
}

function extraProtectedPatterns(): RegExp[] {
  const raw = process.env.MAS_BACKUP_PROTECTED_PATTERNS;
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => new RegExp(s, "i"));
}

/** `label-2026-08-25T13-47-36-546Z.dump` biçimini ayrıştırır; eski adlandırmalar mtime'a düşer. */
export function parseDumpName(name: string): { label: string; timestamp: Date | null } {
  const m = /^(.*)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.dump$/.exec(name);
  if (!m) return { label: name.replace(/\.dump$/, ""), timestamp: null };
  const iso = `${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`;
  const d = new Date(iso);
  return { label: m[1], timestamp: Number.isNaN(d.getTime()) ? null : d };
}

export function classifyRetention(name: string): { retentionClass: RetentionClass; reason: string | null } {
  const patterns = [...IMMUTABLE_NAME_PATTERNS, ...extraProtectedPatterns()];
  for (const p of patterns) {
    if (p.test(name)) return { retentionClass: "immutable", reason: `ad kalıbı ${p}` };
  }
  return { retentionClass: "rolling", reason: null };
}

export function listDumps(dir: string): DumpEntry[] {
  if (!existsSync(dir)) throw new Error(`Yedek dizini yok: ${dir}`);
  const names = readdirSync(dir).filter((n) => n.endsWith(".dump"));
  return names.map((name) => {
    const fullPath = path.join(dir, name);
    const st = statSync(fullPath);
    const parsed = parseDumpName(name);
    const markerPath = `${fullPath}.immutable`;
    const byName = classifyRetention(name);
    const hasMarker = existsSync(markerPath);
    const sidecars = [
      ...SIDECAR_SUFFIXES.map((s) => `${fullPath}${s}`),
      ...documentCompanionPaths(fullPath),
    ].filter((p) => existsSync(p));
    return {
      name,
      fullPath,
      bytes: st.size,
      timestamp: parsed.timestamp ?? st.mtime,
      timestampSource: parsed.timestamp ? "filename" : "mtime",
      label: parsed.label,
      retentionClass: hasMarker || byName.retentionClass === "immutable" ? "immutable" : "rolling",
      immutableReason: hasMarker ? `${path.basename(markerPath)} işaret dosyası` : byName.reason,
      sidecars,
    };
  });
}

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
  /** Bu yaştan genç hiçbir dosya budanmaz (kaza kalkanı). */
  minAgeHours: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = Object.freeze({
  daily: 7, weekly: 4, monthly: 3, minAgeHours: 24,
});

function dayKey(d: Date): string { return d.toISOString().slice(0, 10); }
function monthKey(d: Date): string { return d.toISOString().slice(0, 7); }
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface PruneDecision {
  entry: DumpEntry;
  keep: boolean;
  reason: string;
}

export interface PrunePlan {
  policy: RetentionPolicy;
  decisions: PruneDecision[];
  keptCount: number;
  prunedCount: number;
  immutableCount: number;
  bytesToFree: number;
}

/**
 * Grandfather-father-son seçimi: son N GÜNÜN, son N HAFTANIN ve son N AYIN en yeni dump'ı
 * tutulur; kalan rolling dosyalar budanır.
 *
 * Neden "en yeni 7 dosya" değil de "en yeni 7 GÜN": bu depoda `db:migrate` her koşuda yedek
 * alıyor — bir günde 20 dump oluşabiliyor. Dosya sayısına bakan bir kural o günün 20 kopyasını
 * tutup önceki 6 günü siler; yani en çok ihtiyaç duyulan şeyi (zamanda geriye gidebilmeyi)
 * yok eder. Gün/hafta/ay kovaları buna izin vermez.
 *
 * `immutable` sınıfı hiçbir koşulda budanmaz — pre/post-cutover yedekleri geri dönülecek tek
 * noktadır ve "yer açmak için" silinmeleri geri alınamaz tek hatadır (politika §2).
 */
export const VERIFIED_SIDECAR_SUFFIXES = [
  ".receipt.json",
  ".stage07.json",
  ".offdevice.json",
  ".sha256",
] as const;

/**
 * Bir dump girdisinin doğrulanmış bir makbuz veya SHA-256 yan dosyasına sahip olup olmadığını döner.
 */
export function isVerifiedDumpEntry(entry: Pick<DumpEntry, "sidecars">): boolean {
  return entry.sidecars.some((s) => {
    const lower = s.toLowerCase();
    return VERIFIED_SIDECAR_SUFFIXES.some((suffix) => lower.endsWith(suffix));
  });
}

export function planPrune(entries: DumpEntry[], policy: RetentionPolicy = DEFAULT_RETENTION, now: Date = new Date()): PrunePlan {
  const sorted = [...entries].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const rolling = sorted.filter((e) => e.retentionClass === "rolling");

  const pickNewestPerBucket = (keyOf: (d: Date) => string, limit: number): Set<string> => {
    const seen = new Map<string, DumpEntry>();
    for (const e of rolling) {
      const k = keyOf(e.timestamp);
      if (!seen.has(k)) seen.set(k, e);
    }
    return new Set([...seen.entries()].slice(0, limit).map(([, e]) => e.fullPath));
  };

  const keepDaily = pickNewestPerBucket(dayKey, policy.daily);
  const keepWeekly = pickNewestPerBucket(isoWeekKey, policy.weekly);
  const keepMonthly = pickNewestPerBucket(monthKey, policy.monthly);
  const newestRolling = rolling[0]?.fullPath;

  const decisions: PruneDecision[] = sorted.map((entry) => {
    if (entry.retentionClass === "immutable") {
      return { entry, keep: true, reason: `IMMUTABLE — ${entry.immutableReason ?? "korumalı sınıf"}` };
    }
    const ageHours = (now.getTime() - entry.timestamp.getTime()) / 3_600_000;
    if (ageHours < policy.minAgeHours) {
      return { entry, keep: true, reason: `çok yeni (${ageHours.toFixed(1)} saat < ${policy.minAgeHours})` };
    }
    if (entry.fullPath === newestRolling && policy.daily > 0) return { entry, keep: true, reason: "en yeni rolling yedek" };
    if (keepDaily.has(entry.fullPath)) return { entry, keep: true, reason: `günlük kova (son ${policy.daily} gün)` };
    if (keepWeekly.has(entry.fullPath)) return { entry, keep: true, reason: `haftalık kova (son ${policy.weekly} hafta)` };
    if (keepMonthly.has(entry.fullPath)) return { entry, keep: true, reason: `aylık kova (son ${policy.monthly} ay)` };
    return { entry, keep: false, reason: "hiçbir retention kovasına girmiyor" };
  });

  // ASLA son doğrulanmış yedeği silme: girdilerde en az bir doğrulanmış dump varsa ve standart
  // retention yuvalarında (ör. yalnız daha yeni doğrulanmamış bir dump günlük kovayı doldurduğu için
  // ya da tüm doğrulanmış yedekler yaş eşiğini aştığı için) HİÇBİR doğrulanmış yedek korunmadıysa,
  // en yeni doğrulanmış yedeği zorunlu olarak koru.
  const verifiedDecisions = decisions.filter((d) => isVerifiedDumpEntry(d.entry));
  if (verifiedDecisions.length > 0 && !verifiedDecisions.some((d) => d.keep)) {
    verifiedDecisions[0]!.keep = true;
    verifiedDecisions[0]!.reason = "sole_verified_backup_protected";
  }

  const pruned = decisions.filter((d) => !d.keep);
  return {
    policy,
    decisions,
    keptCount: decisions.length - pruned.length,
    prunedCount: pruned.length,
    immutableCount: decisions.filter((d) => d.entry.retentionClass === "immutable").length,
    bytesToFree: pruned.reduce((sum, d) => sum + d.entry.bytes, 0),
  };
}

export interface PruneExecution {
  deletedDumps: string[];
  deletedSidecars: string[];
  bytesFreed: number;
  failures: { path: string; error: string }[];
}

/**
 * Planı UYGULAR. Yalnız `keep === false` kararlarına dokunur ve her dosyayı silmeden önce
 * sınıfını YENİDEN kontrol eder: plan ile uygulama arasında bir dosya immutable işaretlenmiş
 * olabilir. Savunma bir kez değil iki kez yapılır, çünkü bu fonksiyonun hatası geri alınamaz.
 */
export function executePrune(plan: PrunePlan): PruneExecution {
  const result: PruneExecution = { deletedDumps: [], deletedSidecars: [], bytesFreed: 0, failures: [] };
  for (const d of plan.decisions) {
    if (d.keep) continue;
    const recheck = classifyRetention(d.entry.name);
    if (recheck.retentionClass === "immutable" || existsSync(`${d.entry.fullPath}.immutable`)) {
      result.failures.push({ path: d.entry.fullPath, error: "silme anında IMMUTABLE bulundu — atlandı" });
      continue;
    }
    try {
      for (const sidecar of d.entry.sidecars) {
        const sidecarBytes = existsSync(sidecar) ? statSync(sidecar).size : 0;
        unlinkSync(sidecar);
        result.deletedSidecars.push(sidecar);
        result.bytesFreed += sidecarBytes;
      }
      unlinkSync(d.entry.fullPath);
      result.deletedDumps.push(d.entry.fullPath);
      result.bytesFreed += d.entry.bytes;
    } catch (err) {
      result.failures.push({ path: d.entry.fullPath, error: (err as Error).message });
    }
  }
  return result;
}

/**
 * `*.dump.unverified` karantina artıklarını minimum yaş sınırından (`minAgeHours`) sonra temizler.
 * IMMUTABLE ad kalıbı taşıyan dosyalara hiçbir koşulda dokunmaz (`ENOSPC` önlemi).
 */
export function pruneUnverifiedQuarantinedDumps(
  dir: string,
  minAgeHours = DEFAULT_RETENTION.minAgeHours,
  now: Date = new Date(),
): { deleted: string[]; bytesFreed: number } {
  if (!existsSync(dir)) return { deleted: [], bytesFreed: 0 };
  const deleted: string[] = [];
  let bytesFreed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".dump.unverified")) continue;
    const baseDumpName = name.replace(/\.unverified$/, "");
    if (classifyRetention(baseDumpName).retentionClass === "immutable") continue;
    const fullPath = path.join(dir, name);
    try {
      const st = statSync(fullPath);
      const ageHours = (now.getTime() - st.mtime.getTime()) / 3_600_000;
      if (ageHours < minAgeHours) continue;
      unlinkSync(fullPath);
      deleted.push(fullPath);
      bytesFreed += st.size;
    } catch {
      /* geçici erişim hatası koşuyu düşürmez */
    }
  }
  return { deleted, bytesFreed };
}

/* ── AŞAMA 07 makbuzu (rehber §12 Bölüm A'nın dokuz alanı) ───────────────────────────────── */

export interface Stage07Receipt {
  receiptKind: "mas-stage07-backup-receipt-v1";
  timestamp: string;
  source_db: string;
  system_identifier: string;
  git_sha: string;
  schema_ledger: string;
  file_size: number;
  sha256: string;
  pg_version: string;
  pg_dump_version: string;
  /** Ek bağlam — dokuz zorunlu alanın dışında, ama makbuzu okuyanın işine yarayanlar. */
  git_branch: string;
  git_tree_clean: boolean;
  dump_path: string;
  strict_receipt_path: string | null;
  strict_receipt_sha256: string | null;
  data_class: "REAL_READ_ONLY";
  /**
   * Dump'ı üreten araç zinciri ve kaynağı: `native:127.0.0.1:5432` ya da (CI) konteyner adı.
   * Dokuz zorunlu alanın dışında; kurtarma anında "bu arşivi hangi pg_dump, nereden aldı"
   * sorusunu makbuzun kendisinden cevaplatır. Bağlantı dizesi ya da kullanıcı adı ASLA.
   */
  backup_source?: string;
  /** Doküman kasası eşlikçi arşivi ve dosya bazlı SHA-256 manifesti (Faz 43 / B3). */
  documents_archive_path?: string | null;
  documents_archive_sha256?: string | null;
  documents_manifest_path?: string | null;
  documents_file_count?: number | null;
  /**
   * Makbuzu YAZAN koşunun commit'i — `git_sha` ile karıştırılmamalı.
   *
   * `git_sha` rehber §12'nin alanıdır ve DUMP alındığında hangi kod sürümünün çalıştığını
   * söyler. Bir makbuz dump'tan sonra (ör. aylık kapı koşusunda) yeniden üretilirse ikisi
   * ayrışır. İlk sürüm ikisini tek alana yazıyordu ve sonuç yanlıştı: dump 5ea4945'te
   * alınmışken makbuz 1623b3f diyordu. Aynı alana iki farklı olayı yazmak, makbuzu
   * okunamaz değil, YANILTICI yapar.
   */
  receipt_written_by_git_sha?: string;
  receipt_written_at?: string;
}

export const STAGE07_RECEIPT_FIELDS: readonly (keyof Stage07Receipt)[] = Object.freeze([
  "timestamp", "source_db", "system_identifier", "git_sha", "schema_ledger",
  "file_size", "sha256", "pg_version", "pg_dump_version",
]);

/** Makbuzu atomik yazar (temp + fsync + rename) ve geri okuyup doğrular. */
export function writeStage07Receipt(receiptPath: string, receipt: Stage07Receipt): string {
  const text = JSON.stringify(receipt, null, 2);
  const tempPath = `${receiptPath}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tempPath, "wx");
  try {
    const buf = Buffer.from(text, "utf8");
    let written = 0;
    while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existsSync(receiptPath)) unlinkSync(receiptPath);
  renameSync(tempPath, receiptPath);
  attemptDirectoryFsync(path.dirname(receiptPath));
  const reread = JSON.parse(readFileSync(receiptPath, "utf8")) as Stage07Receipt;
  for (const field of STAGE07_RECEIPT_FIELDS) {
    if (reread[field] === undefined || reread[field] === null || reread[field] === "") {
      throw new Error(`Stage07 makbuzunda zorunlu alan boş: ${field}`);
    }
  }
  return sha256OfFile(receiptPath);
}

/** Dizindeki en yeni, verilen etiketle başlayan dump. */
export function newestDump(dir: string, labelPrefix: string): DumpEntry | null {
  const all = listDumps(dir).filter((e) => e.name.startsWith(labelPrefix));
  if (all.length === 0) return null;
  return all.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
