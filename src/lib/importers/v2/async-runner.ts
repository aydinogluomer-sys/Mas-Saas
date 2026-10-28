// Standart Import V2 — asenkron ÖNİZLEME kuyruğu (Wave 0 / R8).
//
// NE YAPAR. Büyük bir .xlsx'in önizlemesi (şema tespiti + parse + dry-run sayımı) bir HTTP
// isteğinin süresini aşabilir. Bu modül dosyayı sahneleme klasörüne yazar, işi
// `background_jobs` kuyruğuna `excel_import` türünde alır; bir işçi süreci
// (scripts/ops/process-import-jobs.ts) önizlemeyi koşturur ve RAPORUNU iş satırına yazar.
// Kullanıcı raporu `GET /api/imports/v2/async?jobId=…` ile okur.
//
// NE YAPMAZ — VE NEDEN. İncelenmemiş katman (46541d8) burada service.ts'in onaylı içe aktarma
// fonksiyonunu çağırıyordu: önizleme yok, kullanıcı onayı yok; finansal kayıtlar işçinin KENDİ
// hesapladığı SHA ile yazılıyordu (service.ts'teki SHA kapısı bu yüzden anlamsızdı) ve yeniden
// deneme zaten yazılmış bir import'u ikinci kez yazabilirdi. Bu, ürün akışının tek sözleşmesini —
// önizle → AÇIK onay → tek transaction (plan §30, service.ts başlığı) — atlıyordu. Kimliği de iş
// yükünden (operatör katmanının güncelleyebildiği bir jsonb) okuyordu: rol yoksa 'admin', aktör
// yoksa sıfır UUID; dosya yolunu da yükten alıp okuyor ve siliyordu. Şimdi:
//
//   · İş YALNIZ önizler. Bu modülden eşleyicinin yazan yoluna (dryRun: false) giden bir yol
//     yoktur; yazma, mevcut senkron onay akışında kalır (data/imports/v2/actions.ts →
//     confirmV2Action): dosya yeniden yüklenir ve önizlemede gösterilen SHA ile eşleşmek
//     zorundadır.
//   · Kimlik yükten değil, işi kuyruğa alan oturumdan gelir (`background_jobs.created_by`, enqueue
//     anında oturumun kullanıcısı) ve işlenirken public.users'tan YENİDEN doğrulanır: aktif mi,
//     zorunlu parola değişikliği bekliyor mu, rolü beş katmandan biri mi, içe aktarma yetkisi var
//     mı. Biri tutmazsa iş KALICI olarak başarısız olur — varsayılan rol ya da uydurma aktör yok.
//   · Önizleme o kullanıcının veritabanı katmanında koşar (runAsUser): işçi, kullanıcının
//     okuyamayacağı bir şeyi onun adına okuyamaz. Kuyruk işlemleri (claim/complete/fail) işçinin
//     kendi kimliğiyle — rezerve 'system' hesabı, runAsSystem — denetim kaydına yazılır.
//   · Dosya yolu yükten okunmaz. Yük yalnız rastgele bir sahneleme belirteci (uuid) taşır; yol
//     sahneleme klasörünün İÇİNDE yeniden kurulur ve içeriğin SHA'sı yükteki SHA ile eşleşmek
//     zorundadır.
//   · Sahnelenmiş dosya gerçek finansal veri taşır: her TERMİNAL sonuçta (başarı, ölü mektup)
//     silinir, geçici hatada yeniden deneme için kalır; sahipsiz kalanları 24 saat sonra
//     `sweepStaleStagedFiles` temizler.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import { APP_ROLES, ROLE_LABEL, canPerform, type AppRole } from "@/lib/authz/matrix";
import { runAsUser } from "@/lib/db";
import { completeJob, enqueueJob, failJob, reportProgress } from "@/lib/jobs/queue";
import { progressPercent } from "@/lib/jobs/rules";
import {
  UPLOAD_LIMITS, previewImport, sha256Hex, validateUploadMeta,
  type PreviewCounters, type PreviewReport, type Rejection,
} from "./service";

/** Bu kuyruğun iş türü — `background_jobs.job_type` CHECK'indeki (0081) mevcut değer. */
export const ASYNC_PREVIEW_JOB_TYPE = "excel_import" as const;

/** Sahneleme klasörü. `.gitignore`'da (data/); testler kendi geçici klasörünü verir. */
export const DEFAULT_STAGING_DIR = path.resolve(process.cwd(), "data", "uploads", "staging");

/**
 * Saklanan rapordaki her sorun listesinin üst sınırı. Önizleme ekranı da ilk 50 satırı gösterir
 * (v2-import-flow.tsx IssueList); her listenin GERÇEK uzunluğu `listTotals`'ta durur. Ayrıntının
 * tamamı onay için yapılan senkron önizlemede zaten yeniden hesaplanır.
 */
export const STORED_LIST_LIMIT = 50;

/** Sahnelenmiş dosya bu kadar eskiyse ve canlı bir iş ona bağlı değilse süpürülür. */
export const STAGED_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Yeniden deneme hakkı. Önizlemenin yan etkisi yoktur — yeniden denemek hiçbir kaydı ikinci kez
 * yazamaz; dosyanın kendisinden kaynaklanan hatalar zaten kalıcı sayılır ve deneme harcamaz.
 */
const PREVIEW_MAX_ATTEMPTS = 3;

const STAGED_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** İncelenmemiş katmanın adlandırması (`<sha256>.xlsx`). Yeni kod bu adı hiç üretmez. */
const LEGACY_STAGED_NAME = /^[0-9a-f]{64}\.xlsx$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * İş yükü — sınırda Zod ile doğrulanır. Yük `background_jobs.payload`'dır ve operatör katmanı o
 * satırı güncelleyebilir (0081 `background_jobs_update_enter`); bu yüzden içindeki hiçbir şey
 * kimlik ya da yol olarak kullanılmaz. Rol ve aktör anahtarları BİLEREK yok; katmanın eski
 * biçimli işleri (`filePath`, `role`, `actorId`) burada reddedilir.
 */
const payloadSchema = z.object({
  filename: z.string().trim().min(1).max(UPLOAD_LIMITS.maxFilenameLength),
  fileSha256: z.string().regex(SHA256_HEX),
  stagedFile: z.string().regex(STAGED_TOKEN),
});

/** Sahneleme klasörü içindeki tek dosya yolu; belirteç doğrulanmadan yol kurulmaz. */
function stagedPath(stagingDir: string, token: string): string {
  if (!STAGED_TOKEN.test(token)) throw new Error("Geçersiz sahneleme belirteci");
  const dir = path.resolve(stagingDir);
  const p = path.resolve(dir, `${token}.xlsx`);
  // Belirteç yalnız [0-9a-f-] taşıdığı için klasör dışına çıkamaz; yine de iddia edilir.
  if (path.dirname(p) !== dir) throw new Error("Sahneleme yolu klasörün dışına çıkıyor");
  return p;
}

async function removeStaged(p: string | null): Promise<void> {
  if (!p) return;
  // Silinemeyen (kilitli) dosyayı süpürme sonra temizler; sonucu iş durumunu değiştirmez.
  await unlink(p).catch(() => undefined);
}

/* ── Kuyruğa alma ─────────────────────────────────────────────────────────────────────── */

export interface EnqueueAsyncPreviewResult {
  jobId: string;
  status: string;
  sha256: string;
  filename: string;
  /** false: bu kullanıcının aynı dosya için canlı bir önizleme işi zaten vardı; o döndü. */
  created: boolean;
}

export async function enqueueAsyncWorkbookPreview(
  pool: Pool,
  buf: Buffer,
  filename: string,
  actorId: string,
  opts: { stagingDir?: string } = {},
): Promise<{ ok: true; result: EnqueueAsyncPreviewResult } | { ok: false; rejection: Rejection }> {
  const name = filename.trim();
  const meta = validateUploadMeta({ name, size: buf.length });
  if (meta) return { ok: false, rejection: meta };
  // service.ts openWorkbook'un ilk denetimi, bayt diske yazılmadan önce: ZIP olmayan bir şey
  // .xlsx değildir ve sahneleme klasörüne hiç girmez.
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    return { ok: false, rejection: {
      code: "CORRUPT_XLSX",
      message: "Dosya geçerli bir .xlsx değil (ZIP imzası yok). Excel'den 'Farklı Kaydet → .xlsx' ile kaydedin.",
      detail: `ilk baytlar: ${buf.subarray(0, 4).toString("hex")}`,
    } };
  }

  const sha256 = sha256Hex(buf);
  const stagingDir = opts.stagingDir ?? DEFAULT_STAGING_DIR;
  await mkdir(stagingDir, { recursive: true });
  const stagedFile = randomUUID();
  const filePath = stagedPath(stagingDir, stagedFile);
  // Dosya İŞTEN ÖNCE ve kendine ait adla yazılır: iş satırı görünür olduğunda dosya tamdır, ve
  // iki iş asla aynı dosyayı paylaşmaz (birinin silmesi diğerini kırmaz). `wx`: üzerine yazmaz.
  await writeFile(filePath, buf, { flag: "wx" });

  let enq: Awaited<ReturnType<typeof enqueueJob>>;
  try {
    enq = await enqueueJob(pool, {
      jobType: ASYNC_PREVIEW_JOB_TYPE,
      payload: { filename: name, fileSha256: sha256, stagedFile },
      priority: 50,
      // Kullanıcı başına: aynı dosyayı iki kişi yüklerse ikisinin de kendi işi ve raporu olur
      // (rapor yalnız sahibine gösterilir; başkasının işini döndürmek onu okunamaz kılardı).
      dedupeKey: `v2_preview_${actorId}_${sha256}`,
      maxAttempts: PREVIEW_MAX_ATTEMPTS,
    }, actorId);
  } catch (e) {
    await removeStaged(filePath);
    throw e;
  }
  // Canlı bir iş zaten var: o iş kendi dosyasını taşıyor, bu kopya kimseye ait değil.
  if (!enq.created) await removeStaged(filePath);

  return {
    ok: true,
    result: { jobId: enq.job.id, status: enq.job.status, sha256, filename: name, created: enq.created },
  };
}

/* ── İşleme (işçi) ────────────────────────────────────────────────────────────────────── */

/** Saklanan rapor: önizleme raporu, listeleri STORED_LIST_LIMIT ile kesilmiş ve gerçek uzunluklarıyla. */
export type StoredPreviewReport = PreviewReport & {
  listTotals: { [K in keyof PreviewReport["lists"]]: number };
};

export function compactPreviewReport(report: PreviewReport, limit = STORED_LIST_LIMIT): StoredPreviewReport {
  const l = report.lists;
  const cap = <T>(xs: readonly T[]): T[] => xs.slice(0, limit);
  return {
    ...report,
    lists: {
      unsupportedFields: cap(l.unsupportedFields),
      unknownSheets: cap(l.unknownSheets),
      nonTryFinance: cap(l.nonTryFinance),
      duplicateSuspects: cap(l.duplicateSuspects),
      missingRequired: cap(l.missingRequired),
      formulaErrors: cap(l.formulaErrors),
      mergedCells: cap(l.mergedCells),
      // En çok veri sayfası kadar (16); onay kararı için tamamı gerekir, kesilmez.
      forbiddenSheets: [...l.forbiddenSheets],
    },
    listTotals: {
      unsupportedFields: l.unsupportedFields.length,
      unknownSheets: l.unknownSheets.length,
      nonTryFinance: l.nonTryFinance.length,
      duplicateSuspects: l.duplicateSuspects.length,
      missingRequired: l.missingRequired.length,
      formulaErrors: l.formulaErrors.length,
      mergedCells: l.mergedCells.length,
      forbiddenSheets: l.forbiddenSheets.length,
    },
  };
}

export interface AsyncPreviewWorkerDeps {
  /** Rol kapsamlı havuz (getPool()). Kuyruk işlemleri çağıranın runAsSystem bağlamında koşar. */
  pool: Pool;
  /**
   * Katmansız havuz (getRawPool()) — yalnız kimlik okuması için. public.users bir katmana
   * geçmiş bağlantıdan yalnız KENDİ satırını gösterir (0058 users_self_read); işçi henüz
   * kimin adına çalışacağını bilmediği için bu okuma, oturum aramasıyla aynı yoldan yapılır.
   */
  identityPool: Pick<Pool, "query">;
  /** İşçinin denetim kimliği: rezerve 'system' hesabı (scripts/db/seed-system-actor.ts). */
  systemActorId: string;
  stagingDir?: string;
}

export interface AsyncPreviewOutcome {
  jobId: string;
  /**
   * succeeded   → rapor iş satırına yazıldı
   * failed      → geçici hata; deneme hakkı varsa yeniden kuyruğa döner
   * dead_letter → kalıcı hata (dosya, kimlik ya da yük); sebebi iş satırında
   * skipped     → iş bu türde değil ya da 'running' değil; DOKUNULMADI
   */
  outcome: "succeeded" | "failed" | "dead_letter" | "skipped";
  error?: string;
  counters?: PreviewCounters;
}

type Enqueuer = { ok: true; user: { id: string; role: AppRole } } | { ok: false; reason: string };

const isAppRole = (v: string): v is AppRole => (APP_ROLES as readonly string[]).includes(v);

/** İşi kuyruğa alan kişi, BUGÜNKÜ haliyle. Her olumsuz cevap işi kalıcı olarak düşürür. */
async function resolveEnqueuer(identityPool: Pick<Pool, "query">, createdBy: string | null): Promise<Enqueuer> {
  if (!createdBy) {
    return { ok: false, reason: "İşi kuyruğa alan kullanıcı kaydı yok (created_by boş); önizleme kimsenin adına koşturulmaz." };
  }
  const r = await identityPool.query<{ id: string; role: string; is_active: boolean; must_change_password: boolean }>(
    `select id, role, is_active, must_change_password from public.users where id = $1`, [createdBy]);
  if (r.rowCount !== 1) return { ok: false, reason: "İşi kuyruğa alan kullanıcı bulunamadı." };
  const u = r.rows[0];
  if (!u.is_active) return { ok: false, reason: "İşi kuyruğa alan kullanıcı pasif; önizleme onun adına koşturulmadı." };
  if (u.must_change_password) {
    return { ok: false, reason: "İşi kuyruğa alan kullanıcı zorunlu parola değişikliği bekliyor; önizleme koşturulmadı." };
  }
  if (!isAppRole(u.role)) return { ok: false, reason: `İşi kuyruğa alan kullanıcının rolü tanınmıyor ('${u.role}').` };
  if (!canPerform(u.role, "import_workbook_v2")) {
    return { ok: false, reason: `İşi kuyruğa alan kullanıcının katmanı (${ROLE_LABEL[u.role]}) içe aktarma yapamaz.` };
  }
  return { ok: true, user: { id: u.id, role: u.role } };
}

/**
 * Kuyruktan alınmış ('running') TEK bir önizleme işini işler.
 *
 * Fırlatmaz — yalnız kuyruğun kendisi (failJob) başarısız olursa hata yukarı çıkar; o durumda
 * iş 'running' kalır ve bayat işleri toplayan süpürme (reapStuckJobs) onu kuyruğa döndürür.
 */
export async function processAsyncWorkbookPreviewJob(
  deps: AsyncPreviewWorkerDeps,
  jobId: string,
): Promise<AsyncPreviewOutcome> {
  const { pool, systemActorId } = deps;
  const stagingDir = deps.stagingDir ?? DEFAULT_STAGING_DIR;

  // Bu işçiye ait olmayan bir iş (başka tür, ya da henüz/artık 'running' değil) İŞLENMEZ ve
  // durumu DEĞİŞTİRİLMEZ: completeJob/failJob yalnız 'running' işe dokunur, 'queued' bir işi
  // işlemek onu iki kez çalıştırmak olurdu.
  const jobRes = await pool.query<{ id: string; created_by: string | null; payload: unknown }>(
    `select id, created_by, payload from public.background_jobs
      where id = $1 and job_type = $2 and status = 'running'`,
    [jobId, ASYNC_PREVIEW_JOB_TYPE]);
  if (jobRes.rowCount !== 1) {
    return { jobId, outcome: "skipped", error: "İş bulunamadı, türü farklı ya da 'running' değil — dokunulmadı." };
  }
  const job = jobRes.rows[0];

  let stagedFilePath: string | null = null;
  const fail = async (message: string, permanent: boolean): Promise<AsyncPreviewOutcome> => {
    const decision = await failJob(pool, jobId, message, systemActorId, permanent);
    // Terminal sonuçta dosya silinir; yeniden denenecekse kalır.
    if (decision?.status === "dead_letter") await removeStaged(stagedFilePath);
    return { jobId, outcome: decision?.status ?? "skipped", error: message };
  };

  const payload = payloadSchema.safeParse(job.payload);
  if (!payload.success) {
    // Yol kurulamaz → silinecek dosya da yok; varsa sahipsizdir ve süpürülür.
    return fail(
      "İş yükü geçersiz (eski biçimli ya da düzenlenmiş bir iş: dosya adı, SHA ve sahneleme belirteci " +
        "zorunlu). Dosyayı yeniden yükleyin.",
      true,
    );
  }
  const p = payload.data;
  stagedFilePath = stagedPath(stagingDir, p.stagedFile);

  try {
    const who = await resolveEnqueuer(deps.identityPool, job.created_by);
    if (!who.ok) return await fail(who.reason, true);

    let buf: Buffer;
    try {
      buf = await readFile(stagedFilePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        stagedFilePath = null;
        return await fail("Sahnelenen dosya bulunamadı (silinmiş ya da hiç yazılmamış). Dosyayı yeniden yükleyin.", true);
      }
      throw e;
    }
    // İş satırı ile dosya ayrı yerlerde duruyor; ikisinin AYNI baytları söylediği kanıtlanmadan
    // önizlenmez.
    if (sha256Hex(buf) !== p.fileSha256) {
      return await fail("Sahnelenen dosyanın SHA256 özeti iş kaydındakiyle uyuşmuyor; önizlenmedi.", true);
    }
    await reportProgress(pool, jobId, 1, 3);

    // Kullanıcının katmanında, salt-okunur: previewImport yalnız import_external_keys OKUR.
    const preview = await runAsUser(who.user, async () => {
      const client = await pool.connect();
      try {
        return await previewImport(client, buf, p.filename, who.user.id, { role: who.user.role });
      } finally {
        client.release();
      }
    });
    if (!preview.ok) {
      // Dosyanın kendisinden kaynaklanan red (V2 değil, bozuk, satır sınırı…): 30 saniye sonra da
      // aynı olur. Kalıcı — rules.ts nextAfterFailure'ın tam olarak bu durum için yazılmış dalı.
      const r = preview.rejection;
      return await fail(`${r.code}: ${r.message}${r.detail ? ` (${r.detail})` : ""}`, true);
    }
    await reportProgress(pool, jobId, 2, 3);

    // Rapor, işi 'succeeded' yapan AYNI güncellemede yazılır (queue.ts JOB_RESULT_KEY).
    await completeJob(pool, jobId, systemActorId, compactPreviewReport(preview.report));
    await removeStaged(stagedFilePath);
    return { jobId, outcome: "succeeded", counters: preview.report.counters };
  } catch (e) {
    // Beklenmeyen hata (veritabanı, disk): geçici sayılır. Yeniden denemek güvenli — önizleme
    // hiçbir şey yazmaz; ikinci deneme yalnız aynı raporu yeniden hesaplar.
    return fail(e instanceof Error ? e.message : String(e), false);
  }
}

/* ── Sahneleme süpürmesi ──────────────────────────────────────────────────────────────── */

/**
 * Sahipsiz sahneleme dosyalarını siler: `maxAgeMs`'den eski ve CANLI (queued/running/failed)
 * bir önizleme işine bağlı olmayan her dosya. Katmanın `<sha256>.xlsx` adlı dosyaları yeni kodda
 * hiçbir işe bağlanamaz (yeni yük yalnız uuid belirteç taşır), yaşları dolunca onlar da silinir.
 * Tanınmayan adlara dokunulmaz.
 */
export async function sweepStaleStagedFiles(
  pool: Pool,
  opts: { stagingDir?: string; now?: Date; maxAgeMs?: number } = {},
): Promise<{ removed: number; kept: number }> {
  const stagingDir = opts.stagingDir ?? DEFAULT_STAGING_DIR;
  const now = (opts.now ?? new Date()).getTime();
  const maxAgeMs = opts.maxAgeMs ?? STAGED_FILE_MAX_AGE_MS;

  let names: string[];
  try {
    names = await readdir(stagingDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0, kept: 0 };
    throw e;
  }

  const live = await pool.query<{ token: string | null }>(
    `select payload->>'stagedFile' as token from public.background_jobs
      where job_type = $1 and status in ('queued','running','failed')`,
    [ASYNC_PREVIEW_JOB_TYPE]);
  const liveTokens = new Set(live.rows.map((r) => r.token).filter((t): t is string => typeof t === "string"));

  let removed = 0;
  let kept = 0;
  for (const name of names) {
    const token = name.endsWith(".xlsx") ? name.slice(0, -".xlsx".length) : null;
    const ours = token !== null && STAGED_TOKEN.test(token);
    if (!ours && !LEGACY_STAGED_NAME.test(name)) continue;
    if (ours && liveTokens.has(token)) { kept++; continue; }
    const full = path.join(path.resolve(stagingDir), name);
    const age = now - (await stat(full)).mtimeMs;
    if (age < maxAgeMs) { kept++; continue; }
    await unlink(full);
    removed++;
  }
  return { removed, kept };
}

/* ── Durum ve rapor (GET) ─────────────────────────────────────────────────────────────── */

export interface AsyncPreviewJobStatus {
  id: string;
  jobType: string;
  status: string;
  progressDone: number;
  /** Adım sayısı; bilinmiyorsa null (0 değil). */
  progressTotal: number | null;
  progressPercent: number | null;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Yalnız iş 'succeeded' iken dolu. */
  previewReport: StoredPreviewReport | null;
}

/**
 * Bir önizleme işinin durumu ve raporu — yalnız işin SAHİBİNE ya da `seeAll` verilen katmana.
 *
 * Başka birinin işi ile var olmayan iş aynı cevabı (null → 404) verir: kimlik numarası ile başka
 * kullanıcıların içe aktarma geçmişi yoklanamasın. Yalnız `excel_import` türü okunur.
 */
export async function getAsyncPreviewJobStatus(
  pool: Pool,
  jobId: string,
  viewer: { id: string; seeAll: boolean },
): Promise<AsyncPreviewJobStatus | null> {
  const res = await pool.query<{
    id: string; job_type: string; status: string; progress_done: number | string;
    progress_total: number | string | null; last_error: string | null;
    created_at: string; finished_at: string | null; result: StoredPreviewReport | null;
  }>(
    `select id, job_type, status, progress_done, progress_total, last_error,
            to_char(created_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI:SS') as created_at,
            to_char(finished_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI:SS') as finished_at,
            payload -> 'result' as result
       from public.background_jobs
      where id = $1 and job_type = $2 and ($4::boolean or created_by = $3::uuid)`,
    [jobId, ASYNC_PREVIEW_JOB_TYPE, viewer.id, viewer.seeAll],
  );
  if (res.rowCount !== 1) return null;
  const row = res.rows[0];

  const done = Number(row.progress_done);
  const total = row.progress_total == null ? null : Number(row.progress_total);
  return {
    id: row.id,
    jobType: row.job_type,
    status: row.status,
    progressDone: done,
    progressTotal: total,
    progressPercent: progressPercent(done, total),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? null,
    previewReport: row.status === "succeeded" ? (row.result ?? null) : null,
  };
}
