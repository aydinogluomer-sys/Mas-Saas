import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiSession: vi.fn(),
  enqueueAsyncWorkbookImport: vi.fn(),
  getAsyncImportJobStatus: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireApiSession: mocks.requireApiSession,
}));

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(() => ({})),
}));

vi.mock("@/lib/importers/v2/async-runner", () => ({
  enqueueAsyncWorkbookImport: mocks.enqueueAsyncWorkbookImport,
  getAsyncImportJobStatus: mocks.getAsyncImportJobStatus,
}));

import { GET, POST } from "./route";

const URL_BASE = "http://localhost:3000/api/imports/v2/async";
/** What a same-origin browser form post carries. checkOrigin compares Origin's host with Host. */
const SAME_ORIGIN = { origin: "http://localhost:3000", host: "localhost:3000" };

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
    expect(mocks.enqueueAsyncWorkbookImport).not.toHaveBeenCalled();
  });

  it("Origin başlığı olmayan mutasyonu güvenilmez sayar ve 403 ile reddeder", async () => {
    const req = new Request(URL_BASE, { method: "POST", headers: { host: "localhost:3000" } });

    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mocks.enqueueAsyncWorkbookImport).not.toHaveBeenCalled();
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

  it("geçerli yüklemeyi 202 Accepted ile kuyruğa alır", async () => {
    mocks.enqueueAsyncWorkbookImport.mockResolvedValue({
      ok: true,
      result: {
        jobId: "job-999",
        status: "queued",
        sha256: "a".repeat(64),
        filename: "test.xlsx",
        created: true,
      },
    });

    const formData = new FormData();
    const fakeFile = new File([Buffer.from("PK test")], "test.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    formData.append("file", fakeFile);

    const req = new Request(URL_BASE, {
      method: "POST",
      headers: SAME_ORIGIN,
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.job.jobId).toBe("job-999");
  });

  it("GET oturumsuz isteği 401 ile reddeder", async () => {
    mocks.requireApiSession.mockResolvedValue(null);

    const res = await GET(new Request(`${URL_BASE}?jobId=job-999`, { method: "GET" }));
    expect(res.status).toBe(401);
    expect(mocks.getAsyncImportJobStatus).not.toHaveBeenCalled();
  });

  it("GET sorgusunda var olmayan iş için 404 döner", async () => {
    mocks.getAsyncImportJobStatus.mockResolvedValue(null);

    const req = new Request(`${URL_BASE}?jobId=unknown-job`, {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it("GET sorgusunda mevcut iş durumunu döner", async () => {
    mocks.getAsyncImportJobStatus.mockResolvedValue({
      id: "job-999",
      jobType: "excel_import",
      status: "running",
      progressPercent: 50,
    });

    const req = new Request(`${URL_BASE}?jobId=job-999`, {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.job.id).toBe("job-999");
    expect(body.job.progressPercent).toBe(50);
  });
});
