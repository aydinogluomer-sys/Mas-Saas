import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cache } from "@/lib/cache/engine";
import {
  getMiniAppSnapshot,
  executeMiniAppAction,
  type MiniAppSnapshot,
} from "@/lib/telegram/miniapp";

describe("PWA Assets & Configuration", () => {
  it("has a valid public/manifest.json conforming to PWA spec", () => {
    const manifestPath = path.join(process.cwd(), "public", "manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifestContent = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifestContent.name).toBe("MAS Nakit Radar");
    expect(manifestContent.short_name).toBe("MAS Radar");
    expect(manifestContent.display).toBe("standalone");
    expect(manifestContent.start_url).toBe("/");
    expect(manifestContent.theme_color).toBe("#0284c7");
    expect(Array.isArray(manifestContent.icons)).toBe(true);
    expect(manifestContent.icons.length).toBeGreaterThan(0);
    expect(manifestContent.icons[0].src).toBe("/icon.svg");
  });

  it("has a functioning public/sw.js service worker with cache & push handlers", () => {
    const swPath = path.join(process.cwd(), "public", "sw.js");
    expect(fs.existsSync(swPath)).toBe(true);

    const swContent = fs.readFileSync(swPath, "utf-8");
    expect(swContent).toContain("addEventListener(\"install\"");
    expect(swContent).toContain("addEventListener(\"activate\"");
    expect(swContent).toContain("addEventListener(\"fetch\"");
    expect(swContent).toContain("addEventListener(\"push\"");
  });

  it("has a high-resolution icon.svg asset in public directory", () => {
    const iconPath = path.join(process.cwd(), "public", "icon.svg");
    expect(fs.existsSync(iconPath)).toBe(true);
    const iconContent = fs.readFileSync(iconPath, "utf-8");
    expect(iconContent).toContain("<svg");
  });
});

describe("Telegram Mini App (TMA) Engine & Snapshot", () => {
  beforeEach(async () => {
    await cache.clear();
  });

  it("loads and structures a complete mobile snapshot", async () => {
    // Create a mock pool
    const mockPool: any = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("bank_reconciliation_summary")) {
          return Promise.resolve({
            rows: [
              {
                bank_account_id: "ba-1",
                account_name: "Garanti Ticari",
                iban_normalized: "TR12000620000001",
                available_balance: "500000.00",
                first_txn_date: "2026-01-01",
                last_txn_date: "2026-10-18",
                last_statement_date: "2026-10-18",
              },
              {
                bank_account_id: "ba-2",
                account_name: "İş Bankası TL",
                iban_normalized: "TR34000640000002",
                available_balance: "250000.00",
                first_txn_date: "2026-01-01",
                last_txn_date: "2026-10-18",
                last_statement_date: "2026-10-18",
              },
            ],
          });
        }
        if (sql.includes("payment_instances")) {
          return Promise.resolve({
            rows: [
              {
                id: "pi-1",
                payment_id: "p-1",
                name: "Hammadde Alımı",
                due_date: "2026-10-20",
                amount: "45000.00",
                amount_status: "known",
                status: "unpaid",
                paid_amount: null,
                risk_level: "low",
                risk_reasons: [],
                note: null,
                currency: "TRY",
                direction: "outflow",
                priority: "critical",
              },
            ],
          });
        }
        if (sql.includes("cashflow_months")) {
          return Promise.resolve({
            rows: [
              {
                id: "cm-1",
                month_start: "2026-10-01",
                opening: "700000.00",
                income: "300000.00",
                expense: "250000.00",
                closing: "750000.00",
                status: "reconciled",
              },
            ],
          });
        }
        if (sql.includes("checks")) {
          return Promise.resolve({
            rows: [
              {
                id: "chk-1",
                due: "2026-10-25",
                amount: "120000.00",
                direction: "outflow",
                label: "Tedarikçi Çeki",
              },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
    };

    const snapshot = await getMiniAppSnapshot(mockPool, "2026-10-18");

    expect(snapshot).toBeDefined();
    expect(snapshot.todayISO).toBe("2026-10-18");
    expect(snapshot.netKasa).toBe(750000); // sum of 500k + 250k
    expect(snapshot.bankAccounts.length).toBe(2);
    expect(snapshot.bankAccounts[0].name).toBe("Garanti Ticari");
    expect(snapshot.runway).toBeDefined();
    expect(Array.isArray(snapshot.cfoHighlights)).toBe(true);
  });

  it("handles empty database state gracefully with fallback numbers", async () => {
    const emptyPool: any = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
    };

    const snapshot = await getMiniAppSnapshot(emptyPool, "2026-10-18");
    expect(snapshot.netKasa).toBe(0);
    expect(snapshot.bankAccounts).toEqual([]);
    expect(snapshot.urgentPayments).toEqual([]);
    expect(snapshot.urgentMaturities).toEqual([]);
    expect(snapshot.cfoHighlights.length).toBeGreaterThan(0);
  });

  it("executes mark_paid and clear_check actions correctly", async () => {
    const mockClient = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("select id, status, amount, paid_amount, paid_at from public.payment_instances")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ id: "pi-123", status: "unpaid", amount: "5000.00", paid_amount: null }],
          });
        }
        if (sql.includes("select id, status from public.checks")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ id: "c-123", status: "planned" }],
          });
        }
        return Promise.resolve({ rowCount: 1, rows: [{ id: "audit-1" }] });
      }),
      release: vi.fn(),
    };

    const mockPool: any = {
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
    };

    // 1. Mark payment instance paid
    const res1 = await executeMiniAppAction(mockPool, "mark_paid", "pi-123", "test_user", 5000);
    expect(res1.success).toBe(true);
    expect(res1.targetId).toBe("pi-123");

    // 2. Mark check cleared using 'chk:uuid' format
    const res2 = await executeMiniAppAction(mockPool, "mark_paid", "chk:c-123", "test_user");
    expect(res2.success).toBe(true);
    expect(res2.message).toContain("Çek");

    // 3. Rejects empty targetId
    await expect(
      executeMiniAppAction(mockPool, "mark_paid", "", "test_user")
    ).rejects.toThrow("Hedef ID zorunludur.");
  });
});
