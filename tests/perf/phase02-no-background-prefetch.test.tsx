// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import ts from "typescript";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

const capturedPrefetches: Array<{ href: unknown; prefetch: unknown }> = [];

vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch,
    children,
    ...rest
  }: {
    href: string;
    prefetch?: boolean | null;
    children?: React.ReactNode;
  }) => {
    capturedPrefetches.push({ href, prefetch });
    return React.createElement("a", { href: String(href), ...rest }, children);
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/finance",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import Link from "@/components/ui/app-link";
import { ModuleFrame } from "@/components/ui/module-tabs";
import { AppSidebar } from "@/components/ui/nav";
import { NavigationFeedbackProvider } from "@/components/ui/navigation-feedback";

const ROOT = path.resolve(__dirname, "../..");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(rel));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

beforeEach(() => {
  capturedPrefetches.length = 0;
});

describe("Faz 2 — Otomatik arka plan ön-yüklemesi kapalı (sadece tıklanan istek yüklenir)", () => {
  it(
    "src/ altında app-link.tsx dışında hiçbir dosya doğrudan next/link import etmez ve router.prefetch çağırmaz",
    () => {
      const directNextLinkImports: string[] = [];
      const routerPrefetchCalls: string[] = [];

      for (const rel of walkTsFiles("src")) {
        const text = readFileSync(path.join(ROOT, rel), "utf8");
        const sf = ts.createSourceFile(
          rel,
          text,
          ts.ScriptTarget.Latest,
          true,
          rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );

        const visit = (node: ts.Node) => {
          if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            if (node.moduleSpecifier.text === "next/link" && rel !== "src/components/ui/app-link.tsx") {
              directNextLinkImports.push(rel);
            }
          }
          if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "prefetch"
          ) {
            routerPrefetchCalls.push(rel);
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }

      expect(directNextLinkImports).toEqual([]);
      expect(routerPrefetchCalls).toEqual([]);
    },
    SOURCE_SCAN_TEST_TIMEOUT_MS,
  );

  it("AppLink varsayılan olarak NextLink'e prefetch={false} geçirir", () => {
    render(<Link href="/finance/invoices">Faturalar</Link>);
    expect(capturedPrefetches).toEqual([{ href: "/finance/invoices", prefetch: false }]);
  });

  it("AppSidebar ve 17 sekmeli ModuleFrame render edildiğinde tüm linkler prefetch={false} ile kurulur", () => {
    const tabs = [
      { href: "/finance", label: "Özet" },
      { href: "/finance/checks", label: "Çekler" },
      { href: "/finance/loans", label: "Krediler" },
      { href: "/finance/invoices", label: "Faturalar" },
      { href: "/finance/bank", label: "Banka" },
    ];
    const navItems = [
      { href: "/overview", label: "Genel Bakış", icon: "overview" as const },
      { href: "/finance", label: "Finansman", icon: "finance" as const },
    ];

    render(
      <NavigationFeedbackProvider>
        <AppSidebar items={navItems} gate={false} logoutAction={async () => {}} />
        <ModuleFrame title="Finansman" description="Test" tabs={tabs}>
          <div>İçerik</div>
        </ModuleFrame>
      </NavigationFeedbackProvider>,
    );

    expect(capturedPrefetches.length).toBe(navItems.length + tabs.length);
    expect(capturedPrefetches.every((item) => item.prefetch === false)).toBe(true);
  });
});
