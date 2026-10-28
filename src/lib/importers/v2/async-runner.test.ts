// Standart Import V2 — asenkron ÖNİZLEME kuyruğu (Wave 0 / R8). Veritabanı YOK: kuyruk motoru,
// önizleme ve katman geçişi mock'lanır; sahneleme dosyaları işletim sisteminin geçici
// klasöründe, test başına ayrı bir dizinde yazılır (gerçek data/uploads/staging'e hiç dokunulmaz).
//
// İncelenmemiş katmanın (46541d8) koşucusu bu testlerin her birinde kırmızıdır: iş confirmImport
// ile finansal kayıt yazıyordu, rolü yükten okuyup yoksa 'admin' sayıyordu, aktör yoksa sıfır
// UUID uyduruyordu, dosya yolunu yükten alıp okuyor/siliyordu ve işin türüne/durumuna bakmıyordu.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewReport } from "./service";

const mocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  reportProgress: vi.fn(),
  previewImport: vi.fn(),
  confirmImport: vi.fn(),
  runAsUser: vi.fn(),
}));

vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: mocks.enqueueJob,
  completeJob: mocks.completeJob,
  failJob: mocks.failJob,
  reportProgress: mocks.reportProgress,
  claimNextJob: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ runAsUser: mocks.runAsUser }));

vi.mock("./service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service")>()),
  previewImport: mocks.previewImport,
  // Koşucu bunu hiç çağırmamalı; çağırırsa testler yakalasın diye izlenir.
  confirmImport: mocks.confirmImport,
}));

import {
  ASYNC_PREVIEW_JOB_TYPE, STORED_LIST_LIMIT, compactPreviewReport, enqueueAsyncWorkbookPreview,
  getAsyncPreviewJobStatus, processAsyncWorkbookPreviewJob, sweepStaleStagedFiles,
} from "./async-runner";

const USER = "11111111-1111-4111-8111-111111111111";
const SYSTEM = "99999999-9999-4999-8999-999999999999";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

/** ZIP imzalı (PK\x03\x04) ama içeriği önemsiz baytlar — önizleme mock'lu. */
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("sahte xlsx gövdesi")]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let dir: string;

beforeEach(async () => {
  // reset, not clear: a test that makes completeJob/previewImport reject must not leak that
  // behaviour into the next one.
  vi.resetAllMocks();
  dir = await mkdtemp(path.join(os.tmpdir(), "mas-v2-staging-"));
  mocks.runAsUser.mockImplementation((_u: unknown, fn: () => Promise<unknown>) => fn());
  mocks.failJob.mockResolvedValue({ status: "dead_letter", retryInSeconds: null });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pool = { query: vi.fn(), connect: vi.fn() } as never;

describe("kuyruğa alma — dosya güvenliği, sahneleme, yük", () => {
  it("geçersiz uzantıyı, boş dosyayı ve ZIP olmayan baytları diske yazmadan ve kuyruğa almadan reddeder", async () => {
    const cases: Array<[Buffer, string, string]> = [
      [ZIP, "test.pdf", "BAD_EXTENSION"],
      [Buffer.alloc(0), "test.xlsx", "EMPTY_FILE"],
      [Buffer.from("PK sahte ama ZIP değil"), "test.xlsx", "CORRUPT_XLSX"],
      [ZIP, "../kacak.xlsx", "UNSAFE_FILENAME"],
    ];
    for (const [buf, name, code] of cases) {
      const res = await enqueueAsyncWorkbookPreview(pool, buf, name, USER, { stagingDir: dir });
      expect(res.ok, name).toBe(false);
      if (!res.ok) expect(res.rejection.code, name).toBe(code);
    }
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("geçerli dosyayı kendi uuid adıyla sahneler; yük yalnız ad + SHA + belirteç taşır (rol/aktör/yol YOK)", async () => {
    mocks.enqueueJob.mockResolvedValue({ job: { id: JOB, status: "queued" }, created: true });

    const res = await enqueueAsyncWorkbookPreview(pool, ZIP, " satislar.xlsx ", USER, { stagingDir: dir });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result).toMatchObject({ jobId: JOB, status: "queued", sha256: sha(ZIP), filename: "satislar.xlsx", created: true });

    const [, input, actor] = mocks.enqueueJob.mock.calls[0];
    expect(actor).toBe(USER);
    expect(input.jobType).toBe(ASYNC_PREVIEW_JOB_TYPE);
    expect(Object.keys(input.payload).sort()).toEqual(["fileSha256", "filename", "stagedFile"]);
    expect(input.payload.fileSha256).toBe(sha(ZIP));
    expect(input.payload.stagedFile).toMatch(/^[0-9a-f-]{36}$/);
    // Tekilleştirme kullanıcı başına: aynı dosyayı iki kişi yüklerse ikisinin de kendi işi olur.
    expect(input.dedupeKey).toBe(`v2_preview_${USER}_${sha(ZIP)}`);
    expect(input.maxAttempts).toBe(3);

    expect(await readdir(dir)).toEqual([`${input.payload.stagedFile}.xlsx`]);
  });

  it("kuyruğa alma başarısız olursa sahnelenen dosya silinir ve hata yukarı çıkar", async () => {
    mocks.enqueueJob.mockRejectedValue(new Error("veritabanı yok"));
    await expect(enqueueAsyncWorkbookPreview(pool, ZIP, "a.xlsx", USER, { stagingDir: dir })).rejects.toThrow("veritabanı yok");
    expect(await readdir(dir)).toEqual([]);
  });

  it("aynı kullanıcının aynı dosyası için canlı iş varsa o döner ve yeni kopya silinir", async () => {
    mocks.enqueueJob.mockResolvedValue({ job: { id: JOB, status: "running" }, created: false });
    const res = await enqueueAsyncWorkbookPreview(pool, ZIP, "a.xlsx", USER, { stagingDir: dir });
    expect(res.ok && res.result.created).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });
});

/* ── işleme ────────────────────────────────────────────────────────────────────────────── */

interface Scenario {
  job?: { created_by: string | null; payload: unknown } | null;
  user?: { id: string; role: string; is_active: boolean; must_change_password: boolean } | null;
  file?: Buffer | null;
}

const VALID_USER = { id: USER, role: "finance_operator", is_active: true, must_change_password: false };

type Query = (sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>;

function fakeReport(formulaErrors = 0): PreviewReport {
  return {
    filename: "a.xlsx", bytes: ZIP.length, sha256: sha(ZIP),
    schema: { name: "MAS_NAKIT_RADAR_STANDARD_IMPORT", version: 2, template: "2.0.0" },
    counters: { create: 3, update: 1, review: 0, reject: formulaErrors, blockedByParent: 0, undetermined: 0, stagedOnly: 0, reviewsToOpen: formulaErrors },
    lists: {
      unsupportedFields: [], unknownSheets: [], nonTryFinance: [], duplicateSuspects: [], missingRequired: [],
      formulaErrors: Array.from({ length: formulaErrors }, (_, i) => ({ sheet: "01_ODEMELER", row: i + 2, column: "Tutar", message: `#REF! ${i}` })),
      mergedCells: [], forbiddenSheets: [],
    },
    sheets: [], stagedOnlyFamilies: [], perTable: {},
  };
}

async function setup(s: Scenario) {
  const job = s.job === undefined
    ? { created_by: USER, payload: { filename: "a.xlsx", fileSha256: sha(ZIP), stagedFile: TOKEN } }
    : s.job;
  const jobQuery = vi.fn<Query>(async () =>
    (job ? { rowCount: 1, rows: [{ id: JOB, ...job }] } : { rowCount: 0, rows: [] }));
  const client = { query: vi.fn(), release: vi.fn() };
  const p = { query: jobQuery, connect: vi.fn(async () => client) };
  const user = s.user === undefined ? VALID_USER : s.user;
  const identityPool = {
    query: vi.fn<Query>(async () => (user ? { rowCount: 1, rows: [user] } : { rowCount: 0, rows: [] })),
  };
  const staged = path.join(dir, `${TOKEN}.xlsx`);
  const file = s.file === undefined ? ZIP : s.file;
  if (file) await writeFile(staged, file);
  const deps = { pool: p as never, identityPool: identityPool as never, systemActorId: SYSTEM, stagingDir: dir };
  return { deps, staged, jobQuery, identityPool, client };
}

describe("işleme — YALNIZ önizleme, kimlik işi kuyruğa alandan", () => {
  it("mutlu yol: kullanıcının katmanında önizler, raporu işi tamamlarken yazar, dosyayı siler; HİÇBİR şey içe aktarılmaz", async () => {
    mocks.previewImport.mockResolvedValue({ ok: true, report: fakeReport(STORED_LIST_LIMIT + 10) });
    const { deps, staged, jobQuery, client } = await setup({});

    const r = await processAsyncWorkbookPreviewJob(deps, JOB);

    expect(r.outcome).toBe("succeeded");
    expect(r.counters?.create).toBe(3);
    // İş seçimi tür + durum ile kısıtlı.
    expect(jobQuery.mock.calls[0][0]).toMatch(/job_type = \$2 and status = 'running'/);
    expect(jobQuery.mock.calls[0][1]).toEqual([JOB, ASYNC_PREVIEW_JOB_TYPE]);
    // Katman: yükten değil, users satırından.
    expect(mocks.runAsUser).toHaveBeenCalledWith({ id: USER, role: "finance_operator" }, expect.any(Function));
    const [cl, , filename, actor, opts] = mocks.previewImport.mock.calls[0];
    expect(cl).toBe(client);
    expect(filename).toBe("a.xlsx");
    expect(actor).toBe(USER);
    expect(opts).toEqual({ role: "finance_operator" });
    expect(client.release).toHaveBeenCalledOnce();
    // Rapor completeJob'a, işçinin (system) aktörüyle; liste kesilmiş, gerçek uzunluk korunmuş.
    const [, jobId, sysActor, stored] = mocks.completeJob.mock.calls[0];
    expect(jobId).toBe(JOB);
    expect(sysActor).toBe(SYSTEM);
    expect(stored.lists.formulaErrors).toHaveLength(STORED_LIST_LIMIT);
    expect(stored.listTotals.formulaErrors).toBe(STORED_LIST_LIMIT + 10);
    expect(mocks.failJob).not.toHaveBeenCalled();
    expect(mocks.confirmImport).not.toHaveBeenCalled();
    expect(existsSync(staged)).toBe(false);
  });

  it("iş bulunamazsa / türü ya da durumu farklıysa dokunulmaz: ne önizleme, ne complete, ne fail", async () => {
    const { deps, staged } = await setup({ job: null });
    const r = await processAsyncWorkbookPreviewJob(deps, JOB);
    expect(r.outcome).toBe("skipped");
    expect(mocks.previewImport).not.toHaveBeenCalled();
    expect(mocks.completeJob).not.toHaveBeenCalled();
    expect(mocks.failJob).not.toHaveBeenCalled();
    expect(existsSync(staged)).toBe(true);
  });

  it("katmanın eski yükü (filePath/role/actorId) reddedilir; yükteki yola DOKUNULMAZ", async () => {
    const outside = path.join(dir, "..", `mas-dokunulmaz-${Date.now()}.xlsx`);
    await writeFile(outside, ZIP);
    try {
      const { deps } = await setup({
        job: { created_by: USER, payload: { filename: "a.xlsx", fileSha256: sha(ZIP), filePath: outside, role: "admin", actorId: USER } },
      });
      const r = await processAsyncWorkbookPreviewJob(deps, JOB);
      expect(r.outcome).toBe("dead_letter");
      expect(mocks.failJob).toHaveBeenCalledWith(expect.anything(), JOB, expect.stringContaining("yükü geçersiz"), SYSTEM, true);
      expect(mocks.previewImport).not.toHaveBeenCalled();
      expect(existsSync(outside)).toBe(true);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("sahneleme belirteci yol kaçırma denemesiyse reddedilir", async () => {
    const { deps } = await setup({
      job: { created_by: USER, payload: { filename: "a.xlsx", fileSha256: sha(ZIP), stagedFile: "../../etc/passwd" } },
    });
    const r = await processAsyncWorkbookPreviewJob(deps, JOB);
    expect(r.outcome).toBe("dead_letter");
    expect(mocks.previewImport).not.toHaveBeenCalled();
  });

  const refusals: Array<[string, Scenario, string]> = [
    ["created_by boş (varsayılan aktör uydurulmaz)", { job: { created_by: null, payload: { filename: "a.xlsx", fileSha256: sha(ZIP), stagedFile: TOKEN } } }, "created_by"],
    ["kullanıcı bulunamadı", { user: null }, "bulunamadı"],
    ["kullanıcı pasif", { user: { ...VALID_USER, is_active: false } }, "pasif"],
    ["zorunlu parola değişikliği bekliyor", { user: { ...VALID_USER, must_change_password: true } }, "parola"],
    ["izleyici katmanı içe aktaramaz", { user: { ...VALID_USER, role: "viewer" } }, "içe aktarma yapamaz"],
    ["tanınmayan rol 'admin'e düşmez", { user: { ...VALID_USER, role: "superuser" } }, "tanınmıyor"],
  ];
  it.each(refusals)("kimlik reddi — %s → kalıcı hata, önizleme yok, dosya silinir", async (_n, scenario, needle) => {
    const { deps, staged } = await setup(scenario);
    const r = await processAsyncWorkbookPreviewJob(deps, JOB);
    expect(r.outcome).toBe("dead_letter");
    expect(r.error).toContain(needle);
    expect(mocks.failJob).toHaveBeenCalledWith(expect.anything(), JOB, expect.any(String), SYSTEM, true);
    expect(mocks.runAsUser).not.toHaveBeenCalled();
    expect(mocks.previewImport).not.toHaveBeenCalled();
    expect(existsSync(staged)).toBe(false);
  });

  it("dosyanın SHA'sı iş kaydıyla uyuşmazsa önizlenmez", async () => {
    const { deps } = await setup({ file: Buffer.concat([ZIP, Buffer.from("değişmiş")]) });
    const r = await processAsyncWorkbookPreviewJob(deps, JOB);
    expect(r.outcome).toBe("dead_letter");
    expect(r.error).toContain("SHA256");
    expect(mocks.previewImport).not.toHaveBeenCalled();
  });

  it("sahnelenen dosya yoksa kalıcı hata", async () => {
    const { deps } = await setup({ file: null });
    const r = await processAsyncWorkbookPreviewJob(deps, JOB);
    expect(r.outcome).toBe("dead_letter");
    expect(r.error).toContain("bulunamadı");
    expect(mocks.previewImport).not.toHaveBeenCalled();
  });

  it("dosya reddi (V2 değil) kalıcı hatadır: kod mesajda, dosya silinir", async () => {
    mocks.previewImport.mockResolvedValue({ ok: false, rejection: { code: "NOT_V2_SCHEMA", message: "V2 değil", detail: "META yok" } });
    const { deps, staged } = await setup({});
    const r = await processAsyncWorkbookPreviewJob(deps, JOB);
    expect(r.outcome).toBe("dead_letter");
    expect(mocks.failJob).toHaveBeenCalledWith(expect.anything(), JOB, "NOT_V2_SCHEMA: V2 değil (META yok)", SYSTEM, true);
    expect(mocks.completeJob).not.toHaveBeenCalled();
    expect(existsSync(staged)).toBe(false);
  });

  it("beklenmeyen hata geçicidir: yeniden denenir ve dosya yeniden deneme için KALIR", async () => {
    mocks.previewImport.mockRejectedValue(new Error("bağlantı koptu"));
    mocks.failJob.mockResolvedValue({ status: "failed", retryInSeconds: 30 });
    const { deps, staged } = await setup({});
    const r = await processAsyncWorkbookPreviewJob(deps, JOB);
    expect(r.outcome).toBe("failed");
    expect(mocks.failJob).toHaveBeenCalledWith(expect.anything(), JOB, "bağlantı koptu", SYSTEM, false);
    expect(existsSync(staged)).toBe(true);
  });

  it("rapor yazılırken (completeJob) düşerse de geçici hata — önizleme yan etkisiz, yeniden deneme bir şey yazmaz", async () => {
    mocks.previewImport.mockResolvedValue({ ok: true, report: fakeReport() });
    mocks.completeJob.mockRejectedValue(new Error("commit başarısız"));
    mocks.failJob.mockResolvedValue({ status: "failed", retryInSeconds: 30 });
    const { deps, staged } = await setup({});
    const r = await processAsyncWorkbookPreviewJob(deps, JOB);
    expect(r.outcome).toBe("failed");
    expect(mocks.failJob).toHaveBeenCalledWith(expect.anything(), JOB, "commit başarısız", SYSTEM, false);
    expect(mocks.confirmImport).not.toHaveBeenCalled();
    expect(existsSync(staged)).toBe(true);
  });
});

describe("yapısal: koşucu içe aktarma yoluna BAĞLANAMAZ", () => {
  it("async-runner.ts confirmImport / mapWorkbook adlarına hiç başvurmaz; varsayılan rol ve sıfır UUID yok", () => {
    const file = path.join(process.cwd(), "src/lib/importers/v2/async-runner.ts");
    const src = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const ids = new Set<string>();
    const strings: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) ids.add(n.text);
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) strings.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(ids.has("confirmImport")).toBe(false);
    expect(ids.has("mapWorkbook")).toBe(false);
    expect(strings).not.toContain("admin");
    expect(strings.some((s) => s.includes("00000000-0000-0000-0000-000000000000"))).toBe(false);
  });
});

describe("sahneleme süpürmesi", () => {
  const OLD = new Date("2026-10-01T00:00:00Z");
  const NOW = new Date("2026-10-28T12:00:00Z");
  const LIVE = "44444444-4444-4444-8444-444444444444";
  const ORPHAN = "55555555-5555-4555-8555-555555555555";
  const YOUNG = "66666666-6666-4666-8666-666666666666";

  it("eski ve sahipsiz dosyaları siler; canlı işe bağlı, genç ve tanınmayan dosyalara dokunmaz", async () => {
    const files: Array<[string, Date]> = [
      [`${LIVE}.xlsx`, OLD], [`${ORPHAN}.xlsx`, OLD], [`${YOUNG}.xlsx`, NOW],
      [`${"a".repeat(64)}.xlsx`, OLD],   // katmanın <sha256>.xlsx adı: yeni kodda hiçbir işe bağlanamaz
      ["notlar.txt", OLD],               // tanınmayan ad: dokunulmaz
    ];
    for (const [name, mtime] of files) {
      await writeFile(path.join(dir, name), "x");
      await utimes(path.join(dir, name), mtime, mtime);
    }
    const p = { query: vi.fn(async () => ({ rows: [{ token: LIVE }], rowCount: 1 })) } as never;

    const r = await sweepStaleStagedFiles(p, { stagingDir: dir, now: NOW });

    expect(r).toEqual({ removed: 2, kept: 2 });
    expect((await readdir(dir)).sort()).toEqual([`${LIVE}.xlsx`, `${YOUNG}.xlsx`, "notlar.txt"].sort());
  });

  it("klasör yoksa hata değil", async () => {
    const p = { query: vi.fn() } as never;
    expect(await sweepStaleStagedFiles(p, { stagingDir: path.join(dir, "yok") })).toEqual({ removed: 0, kept: 0 });
  });
});

describe("durum ve rapor", () => {
  const row = (status: string) => ({
    id: JOB, job_type: "excel_import", status, progress_done: 2, progress_total: 3, last_error: null,
    created_at: "2026-10-28 10:00:00", finished_at: null, result: { counters: { create: 1 } },
  });

  it("yalnız excel_import ve yalnız sahibine (seeAll değilse) sorulur", async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [row("running")] }));
    await getAsyncPreviewJobStatus({ query } as never, JOB, { id: USER, seeAll: false });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/job_type = \$2/);
    expect(sql).toMatch(/\$4::boolean or created_by = \$3::uuid/);
    expect(params).toEqual([JOB, "excel_import", USER, false]);
  });

  it("rapor yalnız 'succeeded' iken döner; ilerleme bilinmiyorsa null", async () => {
    const running = await getAsyncPreviewJobStatus({ query: vi.fn(async () => ({ rowCount: 1, rows: [row("running")] })) } as never, JOB, { id: USER, seeAll: false });
    expect(running?.previewReport).toBeNull();
    expect(running?.progressPercent).toBe(66.7);

    const done = await getAsyncPreviewJobStatus({ query: vi.fn(async () => ({ rowCount: 1, rows: [row("succeeded")] })) } as never, JOB, { id: USER, seeAll: false });
    expect(done?.previewReport).toEqual({ counters: { create: 1 } });

    const unknownTotal = await getAsyncPreviewJobStatus(
      { query: vi.fn(async () => ({ rowCount: 1, rows: [{ ...row("queued"), progress_done: 0, progress_total: null }] })) } as never,
      JOB, { id: USER, seeAll: false });
    expect(unknownTotal?.progressPercent).toBeNull();
  });

  it("satır yoksa (başkasının işi ya da yok) null", async () => {
    expect(await getAsyncPreviewJobStatus({ query: vi.fn(async () => ({ rowCount: 0, rows: [] })) } as never, JOB, { id: USER, seeAll: false })).toBeNull();
  });

  it("compactPreviewReport sayaçları ve sayfaları olduğu gibi tutar, yalnız listeleri keser", () => {
    const rep = fakeReport(3);
    const c = compactPreviewReport(rep, 2);
    expect(c.counters).toEqual(rep.counters);
    expect(c.lists.formulaErrors).toHaveLength(2);
    expect(c.listTotals.formulaErrors).toBe(3);
    expect(c.listTotals.mergedCells).toBe(0);
  });
});
