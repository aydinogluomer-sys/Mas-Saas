import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiSession: vi.fn(),
  enqueueAsyncWorkbookPreview: vi.fn(),
  getAsyncPreviewJobStatus: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireApiSession: mocks.requireApiSession,
}));

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(() => ({})),
}));

vi.mock("@/lib/importers/v2/async-runner", () => ({
  enqueueAsyncWorkbookPreview: mocks.enqueueAsyncWorkbookPreview,
  getAsyncPreviewJobStatus: mocks.getAsyncPreviewJobStatus,
}));

import { GET, POST } from "./route";

const URL_BASE = "http://localhost:3000/api/imports/v2/async";
/** What a same-origin browser form post carries. checkOrigin compares Origin's host with Host. */
const SAME_ORIGIN = { origin: "http://localhost:3000", host: "localhost:3000" };
const JOB_ID = "33333333-3333-4333-8333-333333333333";

function uploadRequest(name: string, bytes = Buffer.from("PK test")): Request {
  const formData = new FormData();
  formData.append("file", new File([bytes], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }));
  return new Request(URL_BASE, { method: "POST", headers: SAME_ORIGIN, body: formData });
}

describe("POST & GET /api/imports/v2/async", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiSession.mockResolvedValue({
      id: "admin-1",
      username: "admin",
      displayName: "Admin",
      role: "admin",
    });
  });

  it("oturumu olmayan (ya da zorunlu parola değişikliği bekleyen) isteği 401 ile reddeder", async () => {
    // requireApiSession returns null for both cases; the route cannot tell them apart and must not.
    mocks.requireApiSession.mockResolvedValue(null);

    const req = new Request(URL_BASE, { method: "POST", headers: SAME_ORIGIN });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("yetkisiz rolü (viewer) 403 ile reddeder", async () => {
    mocks.requireApiSession.mockResolvedValue({
      id: "user-viewer",
      role: "viewer",
    });

    const req = new Request(URL_BASE, { method: "POST", headers: SAME_ORIGIN });

    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("başka bir kaynaktan (cross-site) gelen yüklemeyi oturuma bakmadan 403 ile reddeder", async () => {
    const req = new Request(URL_BASE, {
      method: "POST",
      headers: { origin: "https://saldirgan.example", host: "localhost:3000" },
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("csrf");
    expect(mocks.requireApiSession).not.toHaveBeenCalled();
    expect(mocks.enqueueAsyncWorkbookPreview).not.toHaveBeenCalled();
  });

  it("Origin başlığı olmayan mutasyonu güvenilmez sayar ve 403 ile reddeder", async () => {
    const req = new Request(URL_BASE, { method: "POST", headers: { host: "localhost:3000" } });

    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mocks.enqueueAsyncWorkbookPreview).not.toHaveBeenCalled();
  });

  it("oturum kontrolündeki altyapı hatasını 401'e çevirmez (500 döner)", async () => {
    mocks.requireApiSession.mockRejectedValue(new Error("connect ECONNREFUSED"));
    // withApiHandler logs the unexpected error to stderr by design; keep the suite output quiet.
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const req = new Request(URL_BASE, { method: "POST", headers: SAME_ORIGIN });

    try {
      const res = await POST(req);
      expect(res.status).toBe(500);
    } finally {
      stderr.mockRestore();
    }
  });

  it("ad/uzantı kapısı baytlar okunmadan çalışır: .xlsx olmayan dosya kuyruğa hiç gitmez", async () => {
    const res = await POST(uploadRequest("rapor.pdf"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_EXTENSION");
    expect(mocks.enqueueAsyncWorkbookPreview).not.toHaveBeenCalled();
  });

  it("geçerli yüklemeyi 202 ile ÖNİZLEME kuyruğuna alır; kimlik oturumdan, rol iletilmez", async () => {
    mocks.enqueueAsyncWorkbookPreview.mockResolvedValue({
      ok: true,
      result: {
        jobId: JOB_ID,
        status: "queued",
        sha256: "a".repeat(64),
        filename: "test.xlsx",
        created: true,
      },
    });

    const res = await POST(uploadRequest("test.xlsx"));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.job.jobId).toBe(JOB_ID);
    expect(body.message).toContain("hiçbir kayıt yazmaz");

    const args = mocks.enqueueAsyncWorkbookPreview.mock.calls[0];
    expect(args).toHaveLength(4);
    expect(args[2]).toBe("test.xlsx");
    expect(args[3]).toBe("admin-1");
  });

  it("GET oturumsuz isteği 401 ile reddeder", async () => {
    mocks.requireApiSession.mockResolvedValue(null);

    const res = await GET(new Request(`${URL_BASE}?jobId=${JOB_ID}`, { method: "GET" }));
    expect(res.status).toBe(401);
    expect(mocks.getAsyncPreviewJobStatus).not.toHaveBeenCalled();
  });

  it("GET içe aktaramayan katmanı (viewer) 403 ile reddeder", async () => {
    mocks.requireApiSession.mockResolvedValue({ id: "user-viewer", role: "viewer" });

    const res = await GET(new Request(`${URL_BASE}?jobId=${JOB_ID}`, { method: "GET" }));
    expect(res.status).toBe(403);
    expect(mocks.getAsyncPreviewJobStatus).not.toHaveBeenCalled();
  });

  it("GET uuid olmayan jobId'yi veritabanına göndermeden 400 ile reddeder", async () => {
    for (const bad of ["abc", "", "job-999", `${JOB_ID}' or '1'='1`]) {
      const res = await GET(new Request(`${URL_BASE}?jobId=${encodeURIComponent(bad)}`, { method: "GET" }));
      expect(res.status, bad).toBe(400);
    }
    expect(mocks.getAsyncPreviewJobStatus).not.toHaveBeenCalled();
  });

  it("GET operatör yalnız KENDİ işini görür; finans yöneticisi ve yönetici hepsini", async () => {
    mocks.getAsyncPreviewJobStatus.mockResolvedValue(null);
    for (const [role, seeAll] of [["finance_operator", false], ["finance_manager", true], ["admin", true]] as const) {
      mocks.requireApiSession.mockResolvedValue({ id: `u-${role}`, role });
      await GET(new Request(`${URL_BASE}?jobId=${JOB_ID}`, { method: "GET" }));
      expect(mocks.getAsyncPreviewJobStatus).toHaveBeenLastCalledWith(expect.anything(), JOB_ID, { id: `u-${role}`, seeAll });
    }
  });

  it("GET var olmayan ya da başkasına ait iş için 404 döner (ayırt edilmez)", async () => {
    mocks.getAsyncPreviewJobStatus.mockResolvedValue(null);

    const res = await GET(new Request(`${URL_BASE}?jobId=${JOB_ID}`, { method: "GET" }));
    expect(res.status).toBe(404);
  });

  it("GET iş durumunu ve saklanan önizleme raporunu döner", async () => {
    mocks.getAsyncPreviewJobStatus.mockResolvedValue({
      id: JOB_ID,
      jobType: "excel_import",
      status: "succeeded",
      progressPercent: 100,
      previewReport: { counters: { create: 2, reject: 1 } },
    });

    const res = await GET(new Request(`${URL_BASE}?jobId=${JOB_ID}`, { method: "GET" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.job.id).toBe(JOB_ID);
    expect(body.job.previewReport.counters).toEqual({ create: 2, reject: 1 });
  });
});
