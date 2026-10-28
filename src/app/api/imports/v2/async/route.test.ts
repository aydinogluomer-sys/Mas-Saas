import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  enqueueAsyncWorkbookImport: vi.fn(),
  getAsyncImportJobStatus: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireSession: mocks.requireSession,
}));

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(() => ({})),
}));

vi.mock("@/lib/importers/v2/async-runner", () => ({
  enqueueAsyncWorkbookImport: mocks.enqueueAsyncWorkbookImport,
  getAsyncImportJobStatus: mocks.getAsyncImportJobStatus,
}));

import { GET, POST } from "./route";

describe("POST & GET /api/imports/v2/async", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({
      id: "admin-1",
      username: "admin",
      displayName: "Admin",
      role: "admin",
    });
  });

  it("oturumu olmayan isteği 401 ile reddeder", async () => {
    mocks.requireSession.mockRejectedValue(new Error("No session"));

    const req = new Request("http://localhost:3000/api/imports/v2/async", {
      method: "POST",
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("yetkisiz rolü (viewer) 403 ile reddeder", async () => {
    mocks.requireSession.mockResolvedValue({
      id: "user-viewer",
      role: "viewer",
    });

    const req = new Request("http://localhost:3000/api/imports/v2/async", {
      method: "POST",
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
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

    const req = new Request("http://localhost:3000/api/imports/v2/async", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.job.jobId).toBe("job-999");
  });

  it("GET sorgusunda var olmayan iş için 404 döner", async () => {
    mocks.getAsyncImportJobStatus.mockResolvedValue(null);

    const req = new Request("http://localhost:3000/api/imports/v2/async?jobId=unknown-job", {
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

    const req = new Request("http://localhost:3000/api/imports/v2/async?jobId=job-999", {
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
