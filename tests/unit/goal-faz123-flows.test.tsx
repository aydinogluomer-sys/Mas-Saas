// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const {
  upsertOpeningMock,
  auditMock,
  revalidatePathMock,
  revalidateFinancialViewsMock,
} = vi.hoisted(() => ({
  upsertOpeningMock: vi.fn(),
  auditMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  revalidateFinancialViewsMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(async () => ({
    id: "00000000-0000-4000-8000-000000000001",
    role: "admin",
  })),
  requireActionPermission: vi.fn(async () => ({
    id: "00000000-0000-4000-8000-000000000001",
    role: "admin",
  })),
}));

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(() => ({ query: vi.fn() })),
}));

vi.mock("@/lib/audit", () => ({
  audit: auditMock,
}));

vi.mock("@/lib/revalidate-financial-views", () => ({
  revalidateFinancialViews: revalidateFinancialViewsMock,
}));

vi.mock("@/lib/treasury/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/treasury/engine")>();
  return {
    ...actual,
    upsertCashOrBankAccountWithOpeningBalance: upsertOpeningMock,
  };
});

import nextConfig from "../../next.config";
import { batchSaveOpeningBalancesAction } from "@/app/(dashboard)/fin03-quick-actions";
import { ViewComfortBar } from "@/components/ui/view-comfort-bar";
import { PaymentInspectorDrawer } from "@/components/payments/payment-inspector-drawer";

const ROOT = process.cwd();

const memoryStorage = new Map<string, string>();
const mockLocalStorage: Storage = {
  get length() {
    return memoryStorage.size;
  },
  clear() {
    memoryStorage.clear();
  },
  getItem(key: string) {
    return memoryStorage.get(key) ?? null;
  },
  key(index: number) {
    return Array.from(memoryStorage.keys())[index] ?? null;
  },
  removeItem(key: string) {
    memoryStorage.delete(key);
  },
  setItem(key: string, value: string) {
    memoryStorage.set(key, String(value));
  },
};

describe("Faz 1, Faz 2 & Faz 3 Eye-Comfort & User-Flow Guarantees", () => {
  beforeEach(() => {
    upsertOpeningMock.mockReset();
    auditMock.mockReset();
    revalidatePathMock.mockReset();
    revalidateFinancialViewsMock.mockReset();
    memoryStorage.clear();
    Object.defineProperty(window, "localStorage", {
      value: mockLocalStorage,
      configurable: true,
      writable: true,
    });
    document.documentElement.dataset.theme = "washi";
    document.documentElement.dataset.density = "analyst";
  });

  afterEach(() => {
    cleanup();
  });

  it("Faz 1A: enforces dual Washi (#1) & E-Ink (#2) CSS tokens, removes 28px ruling stripes & corner cages, and ships <= 15 KB seamless WebP textures", () => {
    const css = fs.readFileSync(path.join(ROOT, "src", "app", "globals.css"), "utf8");

    expect(css).toContain('html[data-theme="washi"]');
    expect(css).toContain('html[data-theme="eink"]');
    expect(css).toContain("--bg: #F4F1EA");
    expect(css).toContain("--surface-1: #FDFBF8");
    expect(css).toContain("--bg: #EFF0EB");
    expect(css).toContain("--surface-1: #F9FAF7");
    expect(css).toContain("/textures/candidates/candidate-a-washi.webp");
    expect(css).toContain("/textures/candidates/candidate-c-sage-eink.webp");
    expect(css).toContain('html[data-density="executive"] [data-analyst-only="true"]');

    // Wilkins 3 cpd horizontal stripes must not exist on body / folio-ruled-canvas
    expect(css).not.toMatch(/repeating-linear-gradient\([^)]*27px[^)]*28px/);
    expect(css).toMatch(/\.folio-corner-mark::before\s*\{\s*display:\s*none;/);

    const washiStat = fs.statSync(
      path.join(ROOT, "public", "textures", "candidates", "candidate-a-washi.webp"),
    );
    const einkStat = fs.statSync(
      path.join(ROOT, "public", "textures", "candidates", "candidate-c-sage-eink.webp"),
    );
    expect(washiStat.size).toBeGreaterThan(1000);
    expect(washiStat.size).toBeLessThanOrEqual(15 * 1024);
    expect(einkStat.size).toBeGreaterThan(1000);
    expect(einkStat.size).toBeLessThanOrEqual(15 * 1024);
  });

  it("Akış 4: ViewComfortBar toggles Washi ↔ E-Ink and Özet ↔ Analist synchronously with localStorage persistence", () => {
    render(<ViewComfortBar />);

    fireEvent.click(screen.getByTestId("theme-btn-eink"));
    expect(document.documentElement.dataset.theme).toBe("eink");
    expect(window.localStorage.getItem("mas_theme")).toBe("eink");

    fireEvent.click(screen.getByTestId("density-btn-executive"));
    expect(document.documentElement.dataset.density).toBe("executive");
    expect(window.localStorage.getItem("mas_density")).toBe("executive");

    fireEvent.click(screen.getByTestId("theme-btn-washi"));
    fireEvent.click(screen.getByTestId("density-btn-analyst"));
    expect(document.documentElement.dataset.theme).toBe("washi");
    expect(document.documentElement.dataset.density).toBe("analyst");
  });

  it("Faz 1B: configures permanent 308 redirects for /system/approvals, /approvals, and /bank and eliminates broken deep-links", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    const map = new Map(redirects.map((r) => [r.source, r]));

    expect(map.get("/system/approvals")?.destination).toBe("/data/approvals");
    expect(map.get("/system/approvals")?.permanent).toBe(true);
    expect(map.get("/approvals")?.destination).toBe("/data/approvals");
    expect(map.get("/bank")?.destination).toBe("/finance/bank");

    const overviewSrc = fs.readFileSync(
      path.join(ROOT, "src", "app", "(dashboard)", "page.tsx"),
      "utf8",
    );
    const paymentsSrc = fs.readFileSync(
      path.join(ROOT, "src", "app", "(dashboard)", "payments", "page.tsx"),
      "utf8",
    );
    expect(overviewSrc).not.toContain('"/system/approvals"');
    expect(paymentsSrc).not.toContain('href="/bank"');
    expect(paymentsSrc).not.toContain('href="/approvals"');
  });

  it("Faz 2A (FIN-03): preserves R10 BLANK != ZERO and parses Turkish formatted opening balances accurately", async () => {
    const acc1 = "11111111-1111-4111-8111-111111111111";
    const acc2 = "22222222-2222-4222-8222-222222222222";
    const acc3 = "33333333-3333-4333-8333-333333333333";

    // All-blank submission must NOT coerce to 0 or touch PostgreSQL
    const emptyRes = await batchSaveOpeningBalancesAction([
      { cashAccountId: acc1, openingBalance: "   ", openingBalanceDate: "2026-01-01" },
    ]);
    expect(emptyRes.ok).toBe(false);
    expect(upsertOpeningMock).not.toHaveBeenCalled();

    // Mixed blank + Turkish formatted + explicit zero: skips blank, saves filled rows
    upsertOpeningMock.mockImplementation(async (_pool, input) => ({
      cashAccountId: input.cashAccountId,
      currency: "TRY",
      openingBalance: input.openingBalance,
      openingBalanceDate: input.openingBalanceDate,
      openingJournalEntryId:
        input.openingBalance === 0 ? null : "99999999-9999-4999-8999-999999999999",
    }));

    const res = await batchSaveOpeningBalancesAction([
      { cashAccountId: acc1, openingBalance: "125.000,50", openingBalanceDate: "2026-01-01" },
      { cashAccountId: acc2, openingBalance: "", openingBalanceDate: "2026-01-01" },
      { cashAccountId: acc3, openingBalance: "0,00", openingBalanceDate: "2026-01-01" },
    ]);

    expect(res).toEqual({ ok: true, savedCount: 2 });
    expect(upsertOpeningMock).toHaveBeenCalledTimes(2);
    expect(upsertOpeningMock.mock.calls[0]?.[1]).toEqual({
      cashAccountId: acc1,
      openingBalance: 125000.5,
      openingBalanceDate: "2026-01-01",
    });
    expect(upsertOpeningMock.mock.calls[1]?.[1]).toEqual({
      cashAccountId: acc3,
      openingBalance: 0,
      openingBalanceDate: "2026-01-01",
    });
  });

  it("Faz 2B & Akış 5: eliminates banned violet badge tone and enforces R10 missing-amount honesty in PaymentInspectorDrawer", () => {
    const instanceRowSrc = fs.readFileSync(
      path.join(ROOT, "src", "components", "radar", "instance-row.tsx"),
      "utf8",
    );
    expect(instanceRowSrc).not.toContain('"violet"');

    render(
      <PaymentInspectorDrawer
        open={true}
        onOpenChange={() => {}}
        activeId="inst-missing-1"
        onSelectId={() => {}}
        canMutate={true}
        canCreateRun={true}
        items={[
          {
            kind: "instance",
            id: "inst-missing-1",
            paymentId: null,
            name: "Tedarikçi Hammadde Ödemesi",
            dueDate: "2026-11-20",
            amount: null,
            remaining: null,
            paidAmount: null,
            currency: "TRY",
            status: "unpaid",
            daysOverdue: 3,
            riskLevel: "high",
            flexibilityClass: "critical",
            category: "Hammadde",
            provider: "Anadolu Metal A.Ş.",
            owner: "Finans",
            costCenter: "Üretim",
            fromSource: true,
          },
        ]}
      />,
    );

    expect(screen.getAllByText(/TUTAR EKSİK/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^0,00\s*₺$/)).toBeNull();
  });
});
