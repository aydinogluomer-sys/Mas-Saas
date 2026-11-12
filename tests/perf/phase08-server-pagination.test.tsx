// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    databaseUrl: "postgres://sahte@127.0.0.1:5432/sahte",
    databasePoolMax: 2,
    databaseStatementTimeoutMs: 5_000,
  },
}));

import { PaginationBar, buildPageHref, parsePageParam } from "@/components/ui/pagination-bar";
import { loadUnmatchedQueue } from "@/lib/bank/engine";
import { listInvoices } from "@/lib/invoices/engine";
import { paymentHistoryCounts, paymentHistoryEvents } from "@/lib/radar/queries";

describe("Faz 8 — Tablolarda zorunlu sunucu sayfalaması (LIMIT 50) ve SQL GROUP BY sayımı", () => {
  it("parsePageParam geçersiz/negatif sayfa değerlerini güvenli biçimde sayfa 1 ve LIMIT 50'ye sabitler", () => {
    expect(parsePageParam(undefined)).toEqual({ page: 1, limit: 50, offset: 0 });
    expect(parsePageParam("-4")).toEqual({ page: 1, limit: 50, offset: 0 });
    expect(parsePageParam("abc")).toEqual({ page: 1, limit: 50, offset: 0 });
    expect(parsePageParam("3")).toEqual({ page: 3, limit: 50, offset: 100 });
    expect(buildPageHref("/payments/history", 2, { status: "paid", q: "kira" })).toBe(
      "/payments/history?status=paid&q=kira&page=2",
    );
    expect(buildPageHref("/payments/history", 1, { status: "paid" })).toBe(
      "/payments/history?status=paid",
    );
  });

  it("PaginationBar etkileşim sözleşmesindeki (manifest.ts) '← Önceki' ve 'Sonraki →' etiketlerini ve prefetch=false Link bileşenini kullanır", () => {
    render(
      <PaginationBar
        basePath="/system/audit"
        page={2}
        pageSize={50}
        totalCount={135}
      />,
    );

    const prev = screen.getByRole("link", { name: /^← Önceki$/ });
    const next = screen.getByRole("link", { name: /^Sonraki →$/ });
    expect(prev.getAttribute("href")).toBe("/system/audit");
    expect(next.getAttribute("href")).toBe("/system/audit?page=3");
    expect(screen.getByText(/51–100 \/ 135 kayıt · Sayfa 2\/3/)).toBeTruthy();
  });

  it("paymentHistoryEvents, listInvoices ve loadUnmatchedQueue varsayılan olarak LIMIT 50 ve OFFSET parametresi ile çalışır", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const fakeDb = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };

    await paymentHistoryEvents(fakeDb as never, { status: "paid", offset: 50 });
    expect(calls[0]?.sql).toMatch(/limit \$5 offset \$6/i);
    expect(calls[0]?.params).toEqual(["paid", "", "", "", 50, 50]);

    await listInvoices(fakeDb as never, { offset: 100 });
    expect(calls[1]?.sql).toMatch(/limit \$3 offset \$4/i);
    expect(calls[1]?.params).toEqual(["", "", 50, 100]);

    await loadUnmatchedQueue(fakeDb as never, 50, 50);
    expect(calls[2]?.sql).toMatch(/limit \$1 offset \$2/i);
    expect(calls[2]?.params).toEqual([50, 50]);
  });

  it("paymentHistoryCounts 1000 satır çekmek yerine SQL GROUP BY event_type ile özet sayıları döndürür", async () => {
    let executedSql = "";
    const fakeDb = {
      async query(sql: string) {
        executedSql = sql;
        return {
          rows: [
            { event_type: "paid", n: 42 },
            { event_type: "partial", n: 5 },
            { event_type: "reopened", n: 2 },
          ],
          rowCount: 3,
        };
      },
    };

    const counts = await paymentHistoryCounts(fakeDb as never);
    expect(executedSql).toMatch(/group by event_type/i);
    expect(counts).toEqual({
      total: 49,
      paid: 42,
      partial: 5,
      reopened: 2,
      cancelled: 0,
    });
  });

  it("dört hedef tablo ekranı da PaginationBar kullanır ve eski limit 200 / limit 1000 sorgularını barındırmaz", () => {
    const auditSrc = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/system/audit/page.tsx"),
      "utf8",
    );
    const historySrc = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/payments/history/page.tsx"),
      "utf8",
    );
    const invoicesSrc = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/finance/invoices/page.tsx"),
      "utf8",
    );
    const bankSrc = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/finance/bank/page.tsx"),
      "utf8",
    );

    expect(auditSrc).toContain("PaginationBar");
    expect(auditSrc).not.toMatch(/limit\s+200/i);

    expect(historySrc).toContain("PaginationBar");
    expect(historySrc).toContain("paymentHistoryCounts");
    expect(historySrc).not.toMatch(/limit:\s*1000/);

    expect(invoicesSrc).toContain("PaginationBar");
    expect(invoicesSrc).not.toMatch(/limit:\s*60/);

    expect(bankSrc).toContain("PaginationBar");
    expect(bankSrc).not.toMatch(/loadUnmatchedQueue\(db,\s*60\)/);
  });
});

