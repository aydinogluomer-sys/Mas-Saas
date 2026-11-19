import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

interface BackupFileRow {
  name: string;
  sizeBytes: number;
  mtime: Date;
  mtimeMs: number;
  hasReceipt: boolean;
  hasSha256Sidecar: boolean;
  hasEncryptedCopy: boolean;
  schemaLedger: string | null;
  sha256Prefix: string | null;
}

interface DailyRunSummary {
  finishedAt: string | null;
  ok: boolean;
  exitCode: number | null;
  offDeviceOk: boolean;
  offDeviceNote: string | null;
}

interface RestoreDrillReceiptSummary {
  verifiedAt: string;
  schemaLedger: string;
  tablesVerified: number;
  rlsTablesVerified?: number;
  countsMatched?: boolean;
  aggregatesMatched: boolean;
  runtimeRoleParityVerified?: boolean;
  isolatedDb?: string;
  isolatedDbDropped?: boolean;
  dumpFile?: string;
  dumpSha256?: string;
  durationMs?: number;
  passed: boolean;
}

async function loadBackups(): Promise<BackupFileRow[]> {
  try {
    const dir = path.join(process.cwd(), "backups");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const dumps = entries.filter((e) => e.isFile() && e.name.endsWith(".dump"));

    const rows = await Promise.all(
      dumps.map(async (d) => {
        const stat = await fs.stat(path.join(dir, d.name));
        const receiptName = `${d.name}.stage07.json`;
        const shaSidecarName = `${d.name}.sha256`;
        const encName = `${d.name}.enc`;
        let schemaLedger: string | null = null;
        let sha256Prefix: string | null = null;
        if (names.has(receiptName)) {
          try {
            const raw = JSON.parse(await fs.readFile(path.join(dir, receiptName), "utf8")) as {
              schema_ledger?: string;
              sha256?: string;
            };
            schemaLedger = raw.schema_ledger ?? null;
            sha256Prefix = raw.sha256 ? raw.sha256.slice(0, 16) : null;
          } catch {
            // ignore malformed receipt
          }
        }
        return {
          name: d.name,
          sizeBytes: stat.size,
          mtime: stat.mtime,
          mtimeMs: stat.mtimeMs,
          hasReceipt: names.has(receiptName),
          hasSha256Sidecar: names.has(shaSidecarName),
          hasEncryptedCopy: names.has(encName),
          schemaLedger,
          sha256Prefix,
        };
      }),
    );
    return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

async function loadLatestDailyRun(): Promise<DailyRunSummary | null> {
  try {
    const runLogPath = path.join(process.cwd(), "backups", "daily-runs.jsonl");
    const raw = await fs.readFile(runLogPath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    const parsed = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    return {
      finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : null,
      ok: parsed.ok === true,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
      offDeviceOk: parsed.offDeviceOk === true,
      offDeviceNote: typeof parsed.offDeviceNote === "string" ? parsed.offDeviceNote : null,
    };
  } catch {
    return null;
  }
}

async function loadLatestRestoreDrill(): Promise<RestoreDrillReceiptSummary | null> {
  try {
    const receiptPath = path.join(process.cwd(), "backups", "latest-restore-drill.json");
    const raw = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Partial<RestoreDrillReceiptSummary>;
    if (
      typeof raw.verifiedAt !== "string" ||
      typeof raw.schemaLedger !== "string" ||
      typeof raw.tablesVerified !== "number" ||
      typeof raw.aggregatesMatched !== "boolean" ||
      typeof raw.passed !== "boolean"
    ) {
      return null;
    }
    return {
      verifiedAt: raw.verifiedAt,
      schemaLedger: raw.schemaLedger,
      tablesVerified: raw.tablesVerified,
      rlsTablesVerified: typeof raw.rlsTablesVerified === "number" ? raw.rlsTablesVerified : undefined,
      countsMatched: typeof raw.countsMatched === "boolean" ? raw.countsMatched : undefined,
      aggregatesMatched: raw.aggregatesMatched,
      runtimeRoleParityVerified:
        typeof raw.runtimeRoleParityVerified === "boolean" ? raw.runtimeRoleParityVerified : undefined,
      isolatedDb: typeof raw.isolatedDb === "string" ? raw.isolatedDb : undefined,
      isolatedDbDropped: typeof raw.isolatedDbDropped === "boolean" ? raw.isolatedDbDropped : undefined,
      dumpFile: typeof raw.dumpFile === "string" ? raw.dumpFile : undefined,
      dumpSha256: typeof raw.dumpSha256 === "string" ? raw.dumpSha256 : undefined,
      durationMs: typeof raw.durationMs === "number" ? raw.durationMs : undefined,
      passed: raw.passed,
    };
  } catch {
    return null;
  }
}

export default async function BackupPage() {
  const denied = await requireRouteAccess("/system/backup");
  if (denied) return denied;

  const [rows, latestRun, latestDrill] = await Promise.all([
    loadBackups(),
    loadLatestDailyRun(),
    loadLatestRestoreDrill(),
  ]);

  const encryptionConfigured = Boolean(
    process.env.BACKUP_ENCRYPTION_KEY && process.env.BACKUP_ENCRYPTION_KEY.trim().length >= 16,
  );
  const offDeviceDir = process.env.MAS_OFFDEVICE_BACKUP_DIR?.trim() ?? "";
  const offDeviceConfigured = offDeviceDir.length > 0;
  const offDeviceDirExists = offDeviceConfigured ? existsSync(offDeviceDir) : false;
  const offDeviceLatestFailed = latestRun !== null && latestRun.offDeviceOk === false;
  const offDeviceUnreachable = offDeviceConfigured && (!offDeviceDirExists || offDeviceLatestFailed);
  const offDeviceHealthy = offDeviceConfigured && offDeviceDirExists && !offDeviceLatestFailed;

  const verifiedCount = rows.filter((r) => r.hasReceipt).length;
  const encryptedCount = rows.filter((r) => r.hasEncryptedCopy).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Yedekleme & Felaket Kurtarma (DR) Kasası"
        subtitle="Stage-07 SHA-256 makbuzlu tam veritabanı yedekleri, AES-256-GCM şifreli arşiv kopyaları ve izole geri yükleme doğrulaması"
        meta={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={rows.length > 0 ? "green" : "amber"} dot>
              {rows.length} yedek · {verifiedCount} Stage-07 makbuzlu
            </Badge>
            {offDeviceUnreachable ? (
              <Badge tone="red" dot>
                Hedef Sürücü Erişilemiyor
              </Badge>
            ) : null}
            {latestDrill ? (
              <Badge tone={latestDrill.passed ? "green" : "red"} dot>
                DR Tatbikatı: {latestDrill.passed ? "DOĞRULANDI" : "BAŞARISIZ"}
              </Badge>
            ) : null}
          </div>
        }
      />

      {offDeviceUnreachable ? (
        <div
          role="alert"
          className="rounded border border-neg/50 bg-neg/10 px-3 py-2 text-xs text-neg"
        >
          <span className="font-semibold">Hedef Sürücü Erişilemiyor:</span>{" "}
          <span>
            `MAS_OFFDEVICE_BACKUP_DIR` tanımlı ancak hedef dizin erişilebilir değil veya son günlük
            yedek koşusunda harici kopya başarısız oldu
            {latestRun?.offDeviceNote ? ` (${latestRun.offDeviceNote})` : ""}. Harici diski / NAS
            paylaşımını bağlayıp `pnpm ops:backup:daily` çalıştırın.
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat
          label="Toplam Yedek (.dump)"
          value={rows.length}
          tone={rows.length > 0 ? "pos" : "warn"}
          sub={rows[0] ? `Son: ${rows[0].mtime.toLocaleDateString("tr-TR")}` : "Henüz yok"}
        />
        <KeyStat
          label="Stage-07 Doğrulanmış"
          value={verifiedCount}
          tone={verifiedCount > 0 ? "info" : "neutral"}
          sub="pg_restore TOC + SHA-256"
        />
        <KeyStat
          label="AES-256-GCM Şifreleme"
          value={encryptionConfigured ? "Aktif" : `${encryptedCount} kopya`}
          tone={encryptionConfigured || encryptedCount > 0 ? "pos" : "neutral"}
          sub={encryptionConfigured ? "BACKUP_ENCRYPTION_KEY tanımlı" : "Opsiyonel anahtar"}
        />
        <KeyStat
          label="Off-Device Hedef"
          value={
            offDeviceHealthy
              ? "Tanımlı"
              : offDeviceUnreachable
                ? "Hedef Sürücü Erişilemiyor"
                : "Yerel"
          }
          tone={offDeviceHealthy ? "pos" : offDeviceUnreachable ? "neg" : "warn"}
          sub={
            offDeviceHealthy
              ? "Harici sürücü / NAS doğrulandı"
              : offDeviceUnreachable
                ? !offDeviceDirExists
                  ? "Dizin bulunamadı (sürücü takılı değil)"
                  : "Son koşuda harici kopya hatası"
                : "MAS_OFFDEVICE_BACKUP_DIR tanımsız"
          }
        />
      </div>

      {latestDrill ? (
        <Panel
          title="SON İZOLE GERİ YÜKLEME TATBİKATI (DR DOĞRULAMA MAKBUZU)"
          subtitle="backups/latest-restore-drill.json — geçici harcanabilir veritabanına gerçek pg_restore ve finansal toplam mutabakatı"
        >
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div className="rounded border border-line-faint p-2">
              <div className="font-mono text-[10px] uppercase text-tone-3">Sonuç</div>
              <div className="mt-1">
                <Badge tone={latestDrill.passed ? "green" : "red"}>
                  {latestDrill.passed ? "BAŞARILI (PASSED)" : "BAŞARISIZ"}
                </Badge>
              </div>
            </div>
            <div className="rounded border border-line-faint p-2">
              <div className="font-mono text-[10px] uppercase text-tone-3">Şema Defteri</div>
              <div className="mt-1 font-mono text-sm font-semibold">{latestDrill.schemaLedger}</div>
            </div>
            <div className="rounded border border-line-faint p-2">
              <div className="font-mono text-[10px] uppercase text-tone-3">Tablo & RLS Doğrulaması</div>
              <div className="mt-1 font-mono text-sm font-semibold">
                {latestDrill.tablesVerified} tablo
                {latestDrill.rlsTablesVerified !== undefined
                  ? ` · ${latestDrill.rlsTablesVerified} RLS`
                  : ""}
              </div>
            </div>
            <div className="rounded border border-line-faint p-2">
              <div className="font-mono text-[10px] uppercase text-tone-3">Parasal Toplamlar</div>
              <div className="mt-1 font-mono text-sm font-semibold">
                {latestDrill.aggregatesMatched ? "Birebir Eşleşti" : "UYUMSUZ"}
              </div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-tone-3">
            <span>Tarih: {new Date(latestDrill.verifiedAt).toLocaleString("tr-TR")}</span>
            {latestDrill.dumpFile ? <span>Yedek: {latestDrill.dumpFile}</span> : null}
            {latestDrill.dumpSha256 ? (
              <span>SHA-256: {latestDrill.dumpSha256.slice(0, 16)}…</span>
            ) : null}
            {latestDrill.isolatedDb ? (
              <span>
                İzole DB: {latestDrill.isolatedDb}
                {latestDrill.isolatedDbDropped ? " (temizlendi)" : ""}
              </span>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <Panel
        title="YEDEK DOSYALARI VE DOĞRULAMA MAKBUZLARI"
        subtitle="Her yedek küme kimliği (system_identifier), şema defteri (schema_migrations) ve SHA-256 sağlamasıyla mühürlenir."
      >
        {rows.length > 0 ? (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1.5 pr-2">Yedek Dosyası</th>
                  <th className="py-1.5 pr-2">Tarih / Saat</th>
                  <th className="py-1.5 pr-2 text-right">Boyut</th>
                  <th className="py-1.5 pr-2">Şema Defteri</th>
                  <th className="py-1.5 pr-2">SHA-256</th>
                  <th className="py-1.5">Güvence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name} className="border-t border-line-faint">
                    <td className="py-1.5 pr-2 font-mono font-semibold text-[var(--text-1)]">
                      {r.name}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-tone-2">
                      {r.mtime.toLocaleString("tr-TR")}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                      {(r.sizeBytes / 1024).toFixed(1)} KB
                    </td>
                    <td className="py-1.5 pr-2 font-mono">{r.schemaLedger ?? "—"}</td>
                    <td className="py-1.5 pr-2 font-mono text-[11px] text-tone-3">
                      {r.sha256Prefix ? `${r.sha256Prefix}…` : "—"}
                    </td>
                    <td className="py-1.5">
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={r.hasReceipt ? "green" : "amber"}>
                          {r.hasReceipt ? "Stage-07 Makbuzlu" : "Makbuzsuz"}
                        </Badge>
                        {r.hasSha256Sidecar ? <Badge tone="neutral">.sha256</Badge> : null}
                        {r.hasEncryptedCopy ? (
                          <Badge tone="blue">AES-256-GCM (.enc)</Badge>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : (
          <EmptyState>Henüz `backups/` dizininde doğrulanmış `.dump` yedeği bulunamadı.</EmptyState>
        )}
      </Panel>

      <Panel title="GÜVENLİ GERİ YÜKLEME (DR TATBİKATI) VE ŞİFRE ÇÖZME YÖNERGESİ">
        <div className="space-y-1.5 text-xs text-tone-2">
          <p>
            1. Canlı veritabanına doğrudan geri yükleme yapmadan önce mevcut durumun kesim yedeğini{" "}
            <code className="font-mono text-[var(--text-1)]">pnpm ops:backup:daily</code> ile alın.
          </p>
          <p>
            2. Şifreli <code className="font-mono text-[var(--text-1)]">.dump.enc</code> arşivleri{" "}
            <code className="font-mono text-[var(--text-1)]">BACKUP_ENCRYPTION_KEY</code> ile
            AES-256-GCM kimlik doğrulaması kontrol edilerek çözülür; değiştirilmiş tek bir bit dahi
            deşifre adımında reddedilir.
          </p>
          <p>
            3. Geri yükleme sonrası{" "}
            <code className="font-mono text-[var(--text-1)]">pnpm release:restore-drill</code> (veya
            hızlı izole doğrulama için{" "}
            <code className="font-mono text-[var(--text-1)]">
              node --env-file=.env.local --import tsx scripts/ops/verify-restore-drill-fast.ts
            </code>
            ) ve <code className="font-mono text-[var(--text-1)]">/system/diagnostics</code>{" "}
            ekranlarıyla şema, RLS ve finansal toplam bütünlüğünü doğrulayın.
          </p>
        </div>
      </Panel>
    </div>
  );
}
