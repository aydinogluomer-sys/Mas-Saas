// Faz 40 (A2) — Static & behavioral server-action role gates + assistant role-scoping (B2-07).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/domain-error";
import type { SessionUser } from "@/lib/auth";
import type { DecisionFact } from "@/lib/facts/engine";

const mockGetRequestUser = vi.fn<() => Promise<SessionUser | null>>();
const mockPoolQuery = vi.fn();
const mockPoolConnect = vi.fn();

vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgresql://unit_test_no_connect:x@127.0.0.1:5432/mas_radar_unit_dummy";
});

vi.mock("@/lib/db", () => ({
  getPool: () => ({
    query: mockPoolQuery,
    connect: mockPoolConnect,
  }),
  getRawPool: () => ({
    query: mockPoolQuery,
    connect: mockPoolConnect,
  }),
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  const { can, canSeeRoute } = await vi.importActual<typeof import("@/lib/authz/matrix")>("@/lib/authz/matrix");
  const requireSession: typeof actual.requireSession = async (options) => {
    const user = await mockGetRequestUser();
    if (!user) throw new DomainError("UNAUTHORIZED", "Oturum gerekli.");
    const allowPending = Boolean(options?.allowMustChangePassword || options?.allowPasswordChangePending);
    if (user.mustChangePassword && !allowPending) {
      throw new DomainError("PASSWORD_CHANGE_REQUIRED", "Parola değişimi zorunlu.");
    }
    if (options?.routePrefix && !canSeeRoute(user.role, options.routePrefix)) {
      throw new DomainError("FORBIDDEN", "Bu işlem için yetkiniz yok.");
    }
    if (options?.requiredPermission && !can(user.role, options.requiredPermission.table, options.requiredPermission.op)) {
      throw new DomainError("FORBIDDEN", "Bu işlem için yetkiniz yok.");
    }
    return user;
  };
  const requireActionPermission: typeof actual.requireActionPermission = async (table, op, routePrefix) =>
    requireSession({ requiredPermission: { table, op }, routePrefix });

  return {
    ...actual,
    getRequestUser: mockGetRequestUser,
    requireSession,
    requireActionPermission,
  };
});

const mockLoadDecisionFacts = vi.fn<(...args: unknown[]) => Promise<DecisionFact[]>>();
vi.mock("@/lib/facts/engine", async () => {
  const actual = await vi.importActual<typeof import("@/lib/facts/engine")>("@/lib/facts/engine");
  return {
    ...actual,
    loadDecisionFacts: (...args: Parameters<typeof actual.loadDecisionFacts>) =>
      mockLoadDecisionFacts(...args),
  };
});

const ROOT = process.cwd();

function walkActions(relDir: string): string[] {
  const abs = path.join(ROOT, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const childRel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) return walkActions(childRel);
    return entry.name === "actions.ts" ? [childRel] : [];
  });
}

describe("Faz 40 — tüm dashboard actions.ts dosyalarında rol/izin kapısı (statik AST)", () => {
  const dashboardActions = walkActions("src/app/(dashboard)");

  it("en az 25 dashboard actions.ts dosyası tarandı", () => {
    expect(dashboardActions.length).toBeGreaterThanOrEqual(25);
  });

  it("dashboard altındaki hiçbir actions.ts çıplak requireSession() ile yetinmez; tam rol/tablo kapısı kullanır", () => {
    const ROLE_GATES = new Set([
      "requireActionPermission",
      "requireAdmin",
      "canPerform",
      "canSeeRoute",
    ]);
    const unguarded: string[] = [];

    for (const rel of dashboardActions) {
      const content = readFileSync(path.join(ROOT, rel), "utf8");
      const sf = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let hasRoleGate = false;
      const visit = (n: ts.Node) => {
        if (hasRoleGate) return;
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ROLE_GATES.has(n.expression.text)) {
          hasRoleGate = true;
          return;
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (!hasRoleGate) unguarded.push(rel);
    }

    expect(unguarded).toEqual([]);
  });
});

describe("Faz 40 — viewer ve finance_operator negatif mutasyon kapıları (0 DB sorgusu)", () => {
  beforeEach(() => {
    mockGetRequestUser.mockReset();
    mockPoolQuery.mockReset();
    mockPoolConnect.mockReset();
  });

  for (const role of ["viewer", "finance_operator"] as const) {
    it(`${role} oturumu system/controls/actions.ts çağrılarında FORBIDDEN alır ve 0 DB mutasyonu yapar`, async () => {
      mockGetRequestUser.mockResolvedValue({
        id: "00000000-0000-0000-0000-000000000010",
        username: role,
        displayName: role,
        role,
      });

      const controls = await import("@/app/(dashboard)/system/controls/actions");
      const fd = new FormData();
      fd.set("alertId", "00000000-0000-0000-0000-000000000099");
      fd.set("status", "acknowledged");

      await expect(controls.setAlertStatusAction(fd)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(controls.raiseActionItemAction(fd)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(mockPoolConnect).not.toHaveBeenCalled();
    });

    it(`${role} oturumu system/jobs/actions.ts çağrılarında FORBIDDEN alır ve 0 DB mutasyonu yapar`, async () => {
      mockGetRequestUser.mockResolvedValue({
        id: "00000000-0000-0000-0000-000000000011",
        username: role,
        displayName: role,
        role,
      });

      const jobs = await import("@/app/(dashboard)/system/jobs/actions");
      const fd = new FormData();
      fd.set("jobId", "00000000-0000-0000-0000-000000000088");

      await expect(jobs.replayJobAction(fd)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(jobs.sweepQueueAction()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(mockPoolConnect).not.toHaveBeenCalled();
    });

    it(`${role} oturumu system/archive/actions.ts çağrılarında FORBIDDEN alır ve 0 DB mutasyonu yapar`, async () => {
      mockGetRequestUser.mockResolvedValue({
        id: "00000000-0000-0000-0000-000000000012",
        username: role,
        displayName: role,
        role,
      });

      const archive = await import("@/app/(dashboard)/system/archive/actions");
      const fd = new FormData();
      fd.set("entity", "payments");
      fd.set("id", "00000000-0000-0000-0000-000000000077");
      fd.set("reason", "test");
      fd.set("backTo", "https://evil.com");

      await expect(archive.archiveRecordAction(fd)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(archive.restoreRecordAction(fd)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(mockPoolConnect).not.toHaveBeenCalled();
    });
  }
});

describe("Faz 40 — B2-07 rol-farkında AI & asistan olgu izolasyonu", () => {
  beforeEach(() => {
    mockLoadDecisionFacts.mockReset();
  });

  it("viewer rolüyle sorulan soruda /system ve /data/approvals olguları answerMd'ye sızmaz", async () => {
    mockLoadDecisionFacts.mockResolvedValue([
      {
        key: "cash_position_try",
        title: "Kullanılabilir Nakit",
        value: "250.000,00 TL",
        severity: "low",
        explanation: "Banka ve kasa toplamı",
        confidence: "source",
        freshness: "2026-11-01",
        sourceHref: "/overview",
      },
      {
        key: "system_admin_secret_metric",
        title: "Sistem Yönetici Özel Kontrol Bulgusu",
        value: "9.999.999,00 TL",
        severity: "critical",
        explanation: "GIZLI_YONETICI_METRIGI_SIZMAMALI",
        confidence: "source",
        freshness: "2026-11-01",
        sourceHref: "/system/security",
      },
      {
        key: "pending_executive_approvals",
        title: "Onay Kuyruğu Özel Tutar",
        value: "7.777.777,00 TL",
        severity: "critical",
        explanation: "GIZLI_ONAY_KUYRUGU_SIZMAMALI",
        confidence: "source",
        freshness: "2026-11-01",
        sourceHref: "/data/approvals",
      },
    ]);

    const fakeClient = {
      query: vi.fn(async (sql: string) => {
        if (/insert into public\.ai_response_snapshots/i.test(sql)) {
          return { rows: [{ id: "00000000-0000-0000-0000-000000000101" }], rowCount: 1 };
        }
        if (/insert into public\.assistant_conversations/i.test(sql)) {
          return { rows: [{ id: "00000000-0000-0000-0000-000000000202" }], rowCount: 1 };
        }
        return { rows: [{ id: "00000000-0000-0000-0000-000000000999" }], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const fakePool = {
      query: fakeClient.query,
      connect: vi.fn(async () => fakeClient),
    };

    const { ask } = await import("@/lib/assistant/engine");
    const answer = await ask(
      fakePool as unknown as import("pg").Pool,
      { question: "Sistem yönetici kontrol bulgusu ve onay kuyruğu özel tutar nedir?", conversationId: null },
      "00000000-0000-0000-0000-000000000001",
      "viewer",
      "2026-11-01",
    );

    expect(answer.trace.withheldCount).toBe(2);
    expect(answer.trace.factKeys).not.toContain("system_admin_secret_metric");
    expect(answer.trace.factKeys).not.toContain("pending_executive_approvals");
    expect(answer.answerMd).not.toContain("9.999.999");
    expect(answer.answerMd).not.toContain("7.777.777");
    expect(answer.answerMd).not.toContain("GIZLI_YONETICI_METRIGI_SIZMAMALI");
    expect(answer.answerMd).not.toContain("GIZLI_ONAY_KUYRUGU_SIZMAMALI");
  });
});
