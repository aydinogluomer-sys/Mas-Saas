// AŞAMA 07 — yedek yaşam döngüsünün ortak kütüphanesi.
//
// NE İŞE YARAR. `scripts/db/backup-docker-postgres.ts` bir dump'ı DAYANIKLI biçimde üretir
// (fsync → temp doğrulama → atomik rename → final dosyada yeniden doğrulama) ve
// `scripts/db/backup-receipt.ts` onun yanına git/cluster kimliği taşıyan bir makbuz yazar.
// İkisi de şunu yanıtlamaz:
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
// classifyOffDeviceTarget() bunu tahmin etmez; Windows'ta sürücü tipini gerçekten ölçer ve
// sabit-diskteki bir klasörü `LOCAL_STANDIN` olarak işaretler. Politikayı belge değil, kod
// uygular: bir stand-in yol asla `offDeviceSatisfied = true` üretemez.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import path from "node:path";
import { readPgToolVersions } from "../db/backup-docker-postgres";
import { attemptDirectoryFsync, type DurabilityMetadata } from "../db/legacy-repair-types";

/* ── temel ölçümler ──────────────────────────────────────────────────────────────────────── */

/** Dosyayı diskten OKUYARAK hash'ler — bellekteki bir kopyayı değil. Kopyalama doğrulaması
 * ancak hedefteki gerçek baytlar okunursa bir şey kanıtlar. */
export function sha256OfFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export interface PgVersions {
  pgVersion: string;
  pgDumpVersion: string;
}

/** Rehber §12 Bölüm A makbuzunun `pg_version` / `pg_dump_version` alanları. İkisi de
 * container'dan ÖLÇÜLÜR; sabit yazılmaz. Tek bir tanım var (scripts/db/backup-docker-postgres.ts)
 * ve katı makbuz da onu kullanıyor — iki kopya, iki cevabın sessizce ayrışmasının yoludur. */
export function readPgVersions(container: string, dbName: string): PgVersions {
  return readPgToolVersions(container, dbName);
}

/* ── off-device hedef sınıflandırması ────────────────────────────────────────────────────── */

export type OffDeviceTargetKind =
  | "UNC_NETWORK_SHARE"
  | "REMOVABLE_VOLUME"
  | "NETWORK_DRIVE"
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
export function classifyOffDeviceTarget(targetDir: string, sourceDir: string): OffDeviceClassification {
  const resolved = path.resolve(targetDir);
  const declaredKind = process.env.MAS_OFFDEVICE_DECLARED_KIND ?? null;
  const operatorAttestation = process.env.MAS_OFFDEVICE_OPERATOR_ATTESTATION ?? null;
  const sourceRoot = path.parse(path.resolve(sourceDir)).root.toLowerCase();
  const targetRoot = path.parse(resolved).root.toLowerCase();
  const sameVolumeAsSource = sourceRoot === targetRoot;

  const base = {
    targetDir: resolved,
    sameVolumeAsSource,
    declaredKind,
    operatorAttestation,
  };

  if (resolved.startsWith("\\\\") || resolved.startsWith("//")) {
    return {
      ...base, kind: "UNC_NETWORK_SHARE", offDeviceSatisfied: true, driveType: null,
      evidence: "UNC yolu — hedef bu makinenin yerel diski değil.",
    };
  }

  const driveType = process.platform === "win32" ? windowsDriveType(targetRoot) : null;
  if (driveType === 2) {
    return {
      ...base, kind: "REMOVABLE_VOLUME", offDeviceSatisfied: true, driveType,
      evidence: `Win32_LogicalDisk DriveType=2 (çıkarılabilir) — kök ${targetRoot}`,
    };
  }
  if (driveType === 4) {
    return {
      ...base, kind: "NETWORK_DRIVE", offDeviceSatisfied: true, driveType,
      evidence: `Win32_LogicalDisk DriveType=4 (ağ sürücüsü) — kök ${targetRoot}`,
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
  if (driveType === 3 && !sameVolumeAsSource) {
    return {
      ...base, kind: "FIXED_SEPARATE_VOLUME", offDeviceSatisfied: false, driveType,
      evidence:
        `Win32_LogicalDisk DriveType=3 (sabit disk), kaynaktan farklı volume (${targetRoot} ≠ ${sourceRoot}). ` +
        "Ayrı bölüm ayrı AYGIT demek değildir — aynı fiziksel diskin ikinci bölümü olabilir.",
    };
  }
  return {
    ...base,
    kind: driveType === 3 || driveType === null ? "LOCAL_STANDIN" : "UNKNOWN",
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
  /** Hedefteki KOPYA pg_restore --list ile ayrıştırılabildi mi (container'a geri okutularak). */
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
 */
export const CLEANUP_GRADE_TARGET_KINDS: ReadonlySet<OffDeviceTargetKind> = new Set([
  "REMOVABLE_VOLUME", "NETWORK_DRIVE", "UNC_NETWORK_SHARE",
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

function copyOneVerified(sourcePath: string, destDir: string): { destPath: string; destBytes: number; destSha256: string; sourceSha256: string; sourceBytes: number; durability: DurabilityMetadata } {
  const sourceBytes = statSync(sourcePath).size;
  const sourceSha256 = sha256OfFile(sourcePath);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, path.basename(sourcePath));
  const tempPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  // Temp + fsync + atomik rename: yarım kopyalanmış bir dosya asla nihai adıyla görünmez.
  // Kopyalama sırasında elektrik kesilirse geriye `*.tmp-*` kalır, "yedek" adında bir çöp değil.
  copyFileSync(sourcePath, tempPath);
  {
    const fd = openSync(tempPath, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  if (existsSync(destPath)) unlinkSync(destPath);
  renameSync(tempPath, destPath);
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
 * `container` verilirse kopya ayrıca container'a geri okutulup `pg_restore --list` ile
 * ayrıştırılır: hedefteki dosyanın yalnız aynı baytları değil, hâlâ GEÇERLİ BİR ARŞİV
 * olduğunu da gösterir.
 */
export function copyToTargetVerified(
  sourcePath: string,
  destDir: string,
  opts: { container?: string; sourceDir?: string } = {},
): CopyVerifyResult {
  if (!existsSync(sourcePath)) throw new Error(`Kaynak dump yok: ${sourcePath}`);
  const classification = classifyOffDeviceTarget(destDir, opts.sourceDir ?? path.dirname(sourcePath));

  const main = copyOneVerified(sourcePath, destDir);
  const sha256Match = main.destSha256 === main.sourceSha256;
  const bytesMatch = main.destBytes === main.sourceBytes;
  if (!sha256Match || !bytesMatch) {
    try { unlinkSync(main.destPath); } catch { /* zaten yok */ }
    throw new Error(
      `Hedefteki kopya kaynakla eşleşmedi (kopya silindi): ` +
        `bayt ${main.sourceBytes} → ${main.destBytes}, sha256 ${main.sourceSha256.slice(0, 12)}… → ${main.destSha256.slice(0, 12)}…`,
    );
  }

  // Makbuz ve yan dosyalar da gitmeli: hash'i olan ama makbuzu olmayan bir kopya, hangi
  // kümeden/hangi commit'ten geldiğini söyleyemez.
  const sidecarsCopied: string[] = [];
  for (const suffix of [".receipt.json", ".stage07.json"]) {
    const sidecar = `${sourcePath}${suffix}`;
    if (!existsSync(sidecar)) continue;
    const copied = copyOneVerified(sidecar, destDir);
    if (copied.destSha256 !== copied.sourceSha256) {
      try { unlinkSync(copied.destPath); } catch { /* zaten yok */ }
      throw new Error(`Yan dosya kopyası eşleşmedi (silindi): ${sidecar}`);
    }
    sidecarsCopied.push(path.basename(copied.destPath));
  }

  let destRestoreListable = false;
  let destTocEntryCount: number | null = null;
  if (opts.container) {
    const inContainer = `/tmp/mas-offdevice-verify-${process.pid}-${Date.now()}.dump`;
    try {
      execFileSync("docker", ["cp", main.destPath, `${opts.container}:${inContainer}`]);
      const listing = execFileSync("docker", ["exec", opts.container, "pg_restore", "--list", inContainer], {
        encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      });
      destTocEntryCount = listing.split(/\r?\n/).filter((l) => l && !l.startsWith(";")).length;
      destRestoreListable = destTocEntryCount > 0;
    } finally {
      try { execFileSync("docker", ["exec", opts.container, "rm", "-f", inContainer]); } catch { /* temizlik */ }
    }
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

const SIDECAR_SUFFIXES = [".receipt.json", ".stage07.json", ".offdevice.json", ".immutable"] as const;

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
    const sidecars = SIDECAR_SUFFIXES
      .map((s) => `${fullPath}${s}`)
      .filter((p) => existsSync(p));
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
    if (entry.fullPath === newestRolling) return { entry, keep: true, reason: "en yeni rolling yedek" };
    if (keepDaily.has(entry.fullPath)) return { entry, keep: true, reason: `günlük kova (son ${policy.daily} gün)` };
    if (keepWeekly.has(entry.fullPath)) return { entry, keep: true, reason: `haftalık kova (son ${policy.weekly} hafta)` };
    if (keepMonthly.has(entry.fullPath)) return { entry, keep: true, reason: `aylık kova (son ${policy.monthly} ay)` };
    return { entry, keep: false, reason: "hiçbir retention kovasına girmiyor" };
  });

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
        unlinkSync(sidecar);
        result.deletedSidecars.push(sidecar);
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
