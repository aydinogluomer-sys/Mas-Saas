// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidenceDrawer } from "@/components/facts/evidence-drawer";
import { CommandPaletteTrigger } from "@/components/search/command-palette-trigger";
import { decodeCell, decodeRange, encodeCol } from "@/lib/importers/row-utils";
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

function collectRuntimeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRuntimeFiles(full, acc);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx") &&
      entry.name !== "fixture.ts"
    ) {
      acc.push(full);
    }
  }
  return acc;
}

describe("Faz 7 — Ağır istemci bileşenleri ve Excel paketlerinde lazy loading", () => {
  it(
    "src/ altındaki hiçbir çalışma zamanı dosyasında üst seviye statik exceljs veya eski SheetJS değer import'u yoktur",
    () => {
      const root = process.cwd();
      const files = collectRuntimeFiles(join(root, "src"));
      const offenders: string[] = [];

      // Üst seviye statik değer import'larını yakalar; yalnız `import type ...` bildirimlerine izin verir.
      const eagerExcelImport = /^\s*import\s+(?!type\b)[^;\n]*\bfrom\s+["'](exceljs|xlsx)["']/m;

      for (const file of files) {
        const content = readFileSync(file, "utf8");
        if (eagerExcelImport.test(content)) {
          offenders.push(relative(root, file).replace(/\\/g, "/"));
        }
      }

      expect(offenders).toEqual([]);
    },
    SOURCE_SCAN_TEST_TIMEOUT_MS,
  );

  it("saf A1 hücre yardımcıları (encodeCol, decodeCell, decodeRange) standart Excel koordinatlarıyla birebir örtüşür", () => {
    const expectedCols: Array<[number, string]> = [
      [0, "A"],
      [1, "B"],
      [25, "Z"],
      [26, "AA"],
      [27, "AB"],
      [31, "AF"],
      [51, "AZ"],
      [52, "BA"],
      [701, "ZZ"],
      [702, "AAA"],
    ];
    for (const [col, expected] of expectedCols) {
      const encoded = encodeCol(col);
      expect(encoded).toBe(expected);
      expect(decodeCell(`${encoded}42`)).toEqual({ r: 41, c: col });
    }
    expect(decodeRange("A1:AG45")).toEqual({
      s: { r: 0, c: 0 },
      e: { r: 44, c: 32 },
    });
    expect(decodeRange("$B$3:$D$10")).toEqual({
      s: { r: 2, c: 1 },
      e: { r: 9, c: 3 },
    });
    expect(decodeRange("C7")).toEqual({
      s: { r: 6, c: 2 },
      e: { r: 6, c: 2 },
    });
  });

  it(
    "CommandPaletteTrigger kapalıyken yalnız 'ara ⌘K' düğmesini çizer, tıklanınca arama diyaloğunu tembel yükler",
    async () => {
      render(<CommandPaletteTrigger />);

      const trigger = screen.getByRole("button", { name: /Ara \(Ctrl\+K\)/i });
      expect(trigger.textContent).toContain("⌘K");
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(trigger);

      const dialog = await screen.findByRole(
        "dialog",
        { name: "Evrensel arama" },
        { timeout: 15_000 },
      );
      expect(dialog).toBeTruthy();
    },
    20_000,
  );

  it(
    "EvidenceDrawer kapalıyken yalnız 'Bu sonuç neden çıktı?' düğmesini çizer, tıklanınca Radix çekmecesini tembel yükler",
    async () => {
      render(
        <EvidenceDrawer
          items={[
            {
              key: "overdue_payment_load",
              title: "Geciken ödeme",
              value: "3",
              confidence: "source",
              freshness: "2026-11-01",
              explanation: "Açık/gecikmiş ödeme aksiyonu gerekiyor.",
              sourceHref: "/radar",
            },
          ]}
        />,
      );

      const trigger = screen.getByRole("button", { name: /^Bu sonuç neden çıktı\?$/ });
      expect(trigger).toBeTruthy();
      expect(screen.queryByText("Geciken ödeme")).toBeNull();

      fireEvent.click(trigger);

      expect(await screen.findByText("Geciken ödeme", {}, { timeout: 15_000 })).toBeTruthy();
      expect(
        await screen.findByText("Açık/gecikmiş ödeme aksiyonu gerekiyor.", {}, { timeout: 15_000 }),
      ).toBeTruthy();
    },
    20_000,
  );
});
