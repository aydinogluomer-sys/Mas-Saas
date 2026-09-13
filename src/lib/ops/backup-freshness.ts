// PHASE 7.3 — yedek tazelik SÖZLEŞMESİ (saf karar mantığı; dosya sistemi/pg_restore erişimi
// bir "probe" olarak dışarıdan verilir, böylece kural birim testiyle sabitlenir).
//
// NEDEN "en yeni .dump'ın mtime'ı" YETMEZ. Önceki sürüm backups/ dizinindeki en yeni .dump
// dosyasının mtime'ına bakıyordu. Bu üç şeyi görmez: (1) yarım kalmış/bozuk bir dump da yeni
// bir mtime taşır; (2) makbuzu olmayan bir dosya hangi kümeden/hangi şemadan geldiğini
// söyleyemez; (3) sha256 eşleşmeyen bir dosya makbuzun anlattığı yedek DEĞİLDİR. Tazelik alarmı
// "36 saat içinde bir dosya oluşmuş" değil, "36 saat içinde GERİ YÜKLENEBİLİR bir yedek var"
// demeli. Bu yüzden bir adayın "doğrulanmış yedek" sayılması için beşi birden gerekir:
//
//   dump (>0 bayt, PGDMP başlığı) + makbuz (stage07 v1) + sha256 (ŞİMDİ yeniden hesaplanır ve
//   makbuzla eşleşir) + boyut eşleşmesi + pg_restore --list kanıtı (TOC girdisi > 0).
//
// TOC kanıtı iki yoldan gelebilir ve ikisi de adıyla raporlanır: `pg_restore --list` ŞİMDİ
// koşuldu; ya da yedek anında koşulmuş ve sonucu sha256 ile bu dosyaya BAĞLI bir kayıt var
// (koşu kaydı / off-device kaydı). Bağ sha256 üzerinden: bayt aynıysa listeleme sonucu da aynıdır.
// İkisi de yoksa aday REDDEDİLİR — "muhtemelen iyidir" bu dosyada yoktur (fail-closed).
//
// YAŞ, iki zamanın YAŞLI olanıdır: makbuzun `timestamp`'i ve dosyanın mtime'ı. Kopyalanan bir
// dosya taze bir mtime alabilir; makbuz zamanı ise elle değiştirilebilir. İkisinin daha kötüsü
// alınır ki hiçbir tek alan yedeği olduğundan taze gösteremesin.

export const BACKUP_RECEIPT_KIND = "mas-stage07-backup-receipt-v1";
/** pg_dump -Fc (custom) arşivinin ilk beş baytı. */
export const PG_CUSTOM_DUMP_MAGIC = "PGDMP";
/** Doğrulanmış yedeğin kabul edilebilir azami yaşı: günlük yedek + kaçırılan bir gün payı. */
export const BACKUP_MAX_AGE_HOURS = 36;

export interface DumpCandidate {
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

/** Makbuzdan okunan, tip güvenliği olmayan ham alanlar (JSON dosyası her şey olabilir). */
export interface ReceiptFields {
  receiptKind?: unknown;
  timestamp?: unknown;
  sha256?: unknown;
  file_size?: unknown;
  source_db?: unknown;
  schema_ledger?: unknown;
}

export type TocEvidenceSource = "pg_restore_now" | "run_log_sha_bound" | "offdevice_record_sha_bound";
export interface TocEvidence {
  entries: number;
  source: TocEvidenceSource;
}

export interface FreshnessProbe {
  /** Dizin yoksa boş dizi (istisna değil): "dizin yok" = "doğrulanmış yedek yok". */
  listDumps(): DumpCandidate[];
  /** `<dump>.stage07.json`; yoksa ya da JSON değilse null. */
  readReceipt(dumpPath: string): ReceiptFields | null;
  /** Dosyanın ilk `bytes` baytı (latin1 metin). */
  readHeader(dumpPath: string, bytes: number): string;
  sha256(dumpPath: string): string;
  /** null = TOC kanıtı YOK (ne şimdi koşulabildi ne sha-bağlı kayıt var). */
  tocEvidence(dumpPath: string, sha256: string): TocEvidence | null;
}

export interface VerifiedBackup {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  receiptTimestamp: string;
  ageHours: number;
  toc: TocEvidence;
  sourceDb: string | null;
  schemaLedger: string | null;
}

export interface RejectedCandidate {
  name: string;
  reason: string;
}

export interface FreshnessEvaluation {
  /** İlk (en yeni) doğrulanmış yedek; yoksa null. */
  verified: VerifiedBackup | null;
  /** verified yoksa +Infinity — mevcut `backupAgeAlert` bunu "alarm" okur. */
  ageHours: number;
  scanned: number;
  rejected: RejectedCandidate[];
}

export interface FreshnessOptions {
  now?: number;
  /** En yeni kaç aday incelenir (sha256 hesaplamak maliyetli; 800+ dosyalı dizinde hepsini okumayız). */
  maxCandidates?: number;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Tek adayı sözleşmeye vurur; geçerse VerifiedBackup, geçmezse ret sebebi. */
function inspect(
  c: DumpCandidate,
  probe: FreshnessProbe,
  now: number,
): { ok: true; backup: VerifiedBackup } | { ok: false; reason: string } {
  if (!(c.bytes > 0)) return { ok: false, reason: "0 bayt" };

  const header = probe.readHeader(c.path, PG_CUSTOM_DUMP_MAGIC.length);
  if (header !== PG_CUSTOM_DUMP_MAGIC) return { ok: false, reason: "PGDMP başlığı yok (pg_dump -Fc arşivi değil)" };

  const receipt = probe.readReceipt(c.path);
  if (receipt === null) return { ok: false, reason: "stage07 makbuzu yok/okunamıyor" };
  if (receipt.receiptKind !== BACKUP_RECEIPT_KIND) return { ok: false, reason: `makbuz türü '${String(receipt.receiptKind)}' ≠ ${BACKUP_RECEIPT_KIND}` };

  const receiptSha = asString(receipt.sha256);
  if (receiptSha === null) return { ok: false, reason: "makbuzda sha256 yok" };
  const actualSha = probe.sha256(c.path);
  if (actualSha !== receiptSha) return { ok: false, reason: `sha256 makbuzla EŞLEŞMİYOR (${actualSha.slice(0, 12)}… ≠ ${receiptSha.slice(0, 12)}…)` };

  if (typeof receipt.file_size !== "number" || receipt.file_size !== c.bytes) {
    return { ok: false, reason: `boyut makbuzla eşleşmiyor (${c.bytes} ≠ ${String(receipt.file_size)})` };
  }

  const ts = asString(receipt.timestamp);
  const receiptMs = ts === null ? Number.NaN : Date.parse(ts);
  if (!Number.isFinite(receiptMs)) return { ok: false, reason: "makbuz zamanı okunamıyor" };

  const toc = probe.tocEvidence(c.path, actualSha);
  if (toc === null) return { ok: false, reason: "pg_restore --list kanıtı yok (ne şimdi koşulabildi ne sha-bağlı kayıt var)" };
  if (!(toc.entries > 0)) return { ok: false, reason: `TOC girdisi ${toc.entries} (boş arşiv)` };

  const ageHours = Math.max(now - receiptMs, now - c.mtimeMs) / 3_600_000;
  return {
    ok: true,
    backup: {
      name: c.name,
      path: c.path,
      bytes: c.bytes,
      sha256: actualSha,
      receiptTimestamp: ts as string,
      ageHours,
      toc,
      sourceDb: asString(receipt.source_db),
      schemaLedger: asString(receipt.schema_ledger),
    },
  };
}

/**
 * En yeni adaydan başlayarak ilk DOĞRULANMIŞ yedeği bulur. Adaylar mtime'a göre yeniden-eskiye
 * gezilir; ilk geçen durur (daha eski bir yedeğin de geçmesi tazeliği değiştirmez).
 */
export function evaluateBackupFreshness(probe: FreshnessProbe, opts: FreshnessOptions = {}): FreshnessEvaluation {
  const now = opts.now ?? Date.now();
  const max = opts.maxCandidates ?? 5;
  const candidates = [...probe.listDumps()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max);
  const rejected: RejectedCandidate[] = [];
  for (const c of candidates) {
    const r = inspect(c, probe, now);
    if (r.ok) return { verified: r.backup, ageHours: r.backup.ageHours, scanned: rejected.length + 1, rejected };
    rejected.push({ name: c.name, reason: r.reason });
  }
  return { verified: null, ageHours: Number.POSITIVE_INFINITY, scanned: candidates.length, rejected };
}

/** İnsan okunur tek satır — telemetri notu ve makbuz için. */
export function describeFreshness(e: FreshnessEvaluation, thresholdHours: number): string {
  if (e.verified === null) {
    const why = e.rejected.slice(0, 2).map((r) => `${r.name}: ${r.reason}`).join(" · ");
    return `eşik ${thresholdHours}s · DOĞRULANMIŞ YEDEK YOK (${e.scanned} aday incelendi${why ? ` — ${why}` : ""})`;
  }
  const v = e.verified;
  const tocLabel = v.toc.source === "pg_restore_now" ? "pg_restore --list şimdi"
    : v.toc.source === "run_log_sha_bound" ? "yedek anında ölçüldü, sha256 ile bağlı"
    : "hedef kaydında ölçüldü, sha256 ile bağlı";
  return `eşik ${thresholdHours}s · en yeni doğrulanmış: ${v.name} · sha256 ✓ · TOC ${v.toc.entries} (${tocLabel})` +
    (v.schemaLedger ? ` · ledger ${v.schemaLedger}` : "");
}

/* ── disk baskısı ────────────────────────────────────────────────────────────────────────── */

export const DISK_WARN_GB = 10;
export const DISK_CRIT_GB = 5;
export type DiskPressureLevel = "ok" | "warning" | "critical" | "unknown";

/**
 * Yedek dizininin bulunduğu birimde boş alan. YALNIZ uyarır — bu modül hiçbir şey silmez ve
 * silmeyi öneren bir "otomatik temizlik" de yoktur: bir yedek dizininde ne silineceğine
 * ancak insan karar verir (PHASE 7 kuralı: "alert only, never auto-delete").
 * `null` = ölçülemedi → "unknown" ve bu da ALARM'dır (fail-closed).
 */
export function diskPressureLevel(freeGb: number | null, warnGb = DISK_WARN_GB, critGb = DISK_CRIT_GB): DiskPressureLevel {
  if (freeGb === null || !Number.isFinite(freeGb)) return "unknown";
  if (freeGb < critGb) return "critical";
  if (freeGb < warnGb) return "warning";
  return "ok";
}
